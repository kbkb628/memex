import { Type } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

export type Layer = "stable" | "active" | "archive";
export type Kind = "background" | "focus" | "decision" | "open_question" | "note";
export type Status = "confirmed" | "discussing" | "rejected";
/** 谁做的最终裁决。model = 模型声称有原话，user = 本人点过确认或否决。 */
export type DecidedBy = "model" | "user";

export type MemoryRow = {
  id: string;
  layer: Layer;
  kind: Kind;
  status: Status;
  text: string;
  source: string;
  quote: string | null;
  created_at: number;
  decided_by: DecidedBy | null;
  decided_at: number | null;
};

const LAYERS: Layer[] = ["stable", "active", "archive"];
const KINDS: Kind[] = ["background", "focus", "decision", "open_question", "note"];

/**
 * 记忆分层 + 确认状态。
 *
 * 这个类存在的唯一理由，是那条最容易出事、也最难靠 prompt 守住的规则：
 * 「还在讨论的推断，不能因为被写进记忆，就变成已确认的结论。」
 *
 * 做法是不给模型「声明」的权力：只有带原话引用（quote）的写入才能升级为
 * confirmed，没有 quote 的一律落 discussing。模型可以撒谎说自己转述了用户，
 * 但它得编一句原话出来——而原话会被存下来，随时可核。
 */
export class MemoryStore {
  constructor(private readonly sql: SqlStorage) {
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mem (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      quote TEXT,
      created_at INTEGER NOT NULL,
      decided_by TEXT,
      decided_at INTEGER
    )`);
    // 老库补列：开源之后别人的库里已经有数据，不能假设是全新的表。
    const cols = this.sql.exec(`PRAGMA table_info(mem)`).toArray() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === "decided_by")) {
      this.sql.exec(`ALTER TABLE mem ADD COLUMN decided_by TEXT`);
    }
    if (!cols.some((c) => c.name === "decided_at")) {
      this.sql.exec(`ALTER TABLE mem ADD COLUMN decided_at INTEGER`);
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS mem_layer ON mem(layer, status)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS live (
      session_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  remember(input: {
    layer: Layer;
    kind: Kind;
    text: string;
    source: string;
    quote?: string;
  }): MemoryRow {
    const quote = input.quote?.trim() ? input.quote.trim() : null;
    // 有原话 → 模型声称已确认；没原话 → 讨论中。
    // 两者都不是最终裁决：decided_by 记的是「谁说的」，不是「谁核过」。
    const row: MemoryRow = {
      id: crypto.randomUUID(),
      layer: input.layer,
      kind: input.kind,
      status: quote ? "confirmed" : "discussing",
      text: input.text.trim(),
      source: input.source.trim(),
      quote,
      created_at: Date.now(),
      decided_by: quote ? "model" : null,
      decided_at: quote ? Date.now() : null,
    };
    this.sql.exec(
      `INSERT INTO mem (id, layer, kind, status, text, source, quote, created_at, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.layer, row.kind, row.status, row.text, row.source,
      row.quote, row.created_at, row.decided_by, row.decided_at,
    );
    return row;
  }

  get(id: string): MemoryRow | null {
    const row = this.sql.exec(`SELECT * FROM mem WHERE id = ?`, id).toArray()[0];
    return (row as unknown as MemoryRow) ?? null;
  }

  /**
   * 本人确认。唯一能把「模型声称」升级为「我核过」的入口。
   * 这是整个设计的支点：裁决权在人的手上，不在模型手上。
   */
  confirm(id: string): MemoryRow | null {
    this.sql.exec(
      `UPDATE mem SET status = 'confirmed', decided_by = 'user', decided_at = ? WHERE id = ?`,
      Date.now(), id,
    );
    return this.get(id);
  }

  /** 本人否决。否决不是删除：留着才知道这条推断错过，也才看得见错在哪。 */
  reject(id: string, note?: string): MemoryRow | null {
    const reason = note?.trim();
    if (reason) {
      this.sql.exec(`UPDATE mem SET source = source || ' · 否决理由：' || ? WHERE id = ?`, reason, id);
    }
    this.sql.exec(
      `UPDATE mem SET status = 'rejected', decided_by = 'user', decided_at = ? WHERE id = ?`,
      Date.now(), id,
    );
    return this.get(id);
  }

  list(opts: { status?: Status; layer?: Layer; limit?: number } = {}): MemoryRow[] {
    const limit = Math.min(opts.limit ?? 100, 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.layer) {
      where.push("layer = ?");
      params.push(opts.layer);
    }
    return this.sql.exec(
      `SELECT * FROM mem ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT ?`,
      ...params, limit,
    ).toArray() as unknown as MemoryRow[];
  }

  /** 需要人看一眼的：还没定论的，以及模型自称确认但本人没核过的。 */
  needsReview(limit = 50): MemoryRow[] {
    return this.sql.exec(
      `SELECT * FROM mem
       WHERE status = 'discussing' OR (status = 'confirmed' AND decided_by = 'model')
       ORDER BY created_at DESC LIMIT ?`,
      Math.min(limit, 200),
    ).toArray() as unknown as MemoryRow[];
  }

  recall(query: string, opts: { layer?: Layer; limit?: number } = {}): MemoryRow[] {
    const limit = Math.min(opts.limit ?? 20, 100);
    const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = opts.layer
      ? this.sql.exec(
          `SELECT * FROM mem WHERE layer = ? AND (text LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')
           ORDER BY created_at DESC LIMIT ?`,
          opts.layer, like, like, limit,
        )
      : this.sql.exec(
          `SELECT * FROM mem WHERE text LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'
           ORDER BY created_at DESC LIMIT ?`,
          like, like, limit,
        );
    return rows.toArray() as unknown as MemoryRow[];
  }

  /** 某个会话写到哪儿了。换设备/换入口时，接手的那一方先读这个。 */
  setLive(sessionId: string, text: string): void {
    this.sql.exec(
      `INSERT INTO live (session_id, text, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
      sessionId, text.trim(), Date.now(),
    );
  }

  getLive(sessionId: string): { text: string; updated_at: number } | null {
    const row = this.sql.exec(
      `SELECT text, updated_at FROM live WHERE session_id = ?`, sessionId,
    ).toArray()[0] as { text: string; updated_at: number } | undefined;
    return row ?? null;
  }

  liveAll(): { session_id: string; text: string; updated_at: number }[] {
    return this.sql.exec(
      `SELECT session_id, text, updated_at FROM live ORDER BY updated_at DESC LIMIT 50`,
    ).toArray() as unknown as { session_id: string; text: string; updated_at: number }[];
  }
}

const MEMORY_RULES = `记忆写入规则：

- 只有用户明确说过或写下过的内容，才能写进 stable 层。
- 写入时如果带 quote，必须是从用户原话里逐字复制的一段；它会被存档，用来核对。
- 带 quote 写入只等于「已记下原话，待复核」，不等于已确认。只有用户在界面上点过确认，才记为本人核过。
- 没有原话可引时，不要编。省略 quote，这条会存为「讨论中」。
- 「讨论中」的内容可以被后续推翻，不可以被当成前提继续推导。
- 检索到的「已确认·模型声称」也不能当成用户确认过的事实，只能当成待核实的线索。
- 用户改变了主意，不要覆盖旧条目，新写一条并在 source 里说明它取代了哪条。
- archive 层只在被明确要求时写入，不要主动往里面塞东西。`;

export function memoryExtension(store: MemoryStore, currentSession: () => string): Extension {
  const rememberParams = Type.Object({
    layer: Type.Union([Type.Literal("stable"), Type.Literal("active"), Type.Literal("archive")]),
    kind: Type.Union([
      Type.Literal("background"),
      Type.Literal("focus"),
      Type.Literal("decision"),
      Type.Literal("open_question"),
      Type.Literal("note"),
    ]),
    text: Type.String({ description: "要记住的内容，写成一句完整的陈述" }),
    source: Type.String({ description: "来源，例如 2026-11-03 对话 / 某次会议 / RSS 某篇" }),
    quote: Type.Optional(
      Type.String({ description: "用户原话逐字引用。省略则本条记为讨论中，不是事实。" }),
    ),
  });

  const remember: ToolRegistration<typeof rememberParams> = {
    name: "remember",
    description:
      "写入一条记忆。带 quote（用户原话）才是已确认事实；不带 quote 一律记为讨论中。",
    parameters: rememberParams,
    replay: "unsafe",
    async execute(args) {
      const row = store.remember(args);
      const label =
        row.status === "confirmed"
          ? "已记下原话，等你复核（复核前不算你确认过）"
          : "已记为讨论中（不是事实，不能被当成前提继续推导）";
      return {
        output: [{ type: "text", text: `已写入 ${row.id} · ${label} · ${row.layer}/${row.kind}` }],
      };
    },
  };

  const recallParams = Type.Object({
    query: Type.String(),
    layer: Type.Optional(
      Type.Union([Type.Literal("stable"), Type.Literal("active"), Type.Literal("archive")]),
    ),
    limit: Type.Optional(Type.Number()),
  });

  const recall: ToolRegistration<typeof recallParams> = {
    name: "recall",
    description: "按关键词检索记忆。返回结果带状态，讨论中的条目不能当成事实使用。",
    parameters: recallParams,
    replay: "safe",
    async execute(args) {
      const rows = store.recall(args.query, { layer: args.layer, limit: args.limit });
      if (rows.length === 0) {
        return { output: [{ type: "text", text: "没有找到相关记忆。" }] };
      }
      const text = rows
        .map((r) => {
          // 四态而不是三态：模型声称的「已确认」和本人核过的「已确认」必须分开，
          // 否则模型读回自己的推断时，会把它当成你亲口说过的话。
          const mark =
            r.status === "rejected"
              ? "[已否决]"
              : r.status === "discussing"
                ? "[讨论中]"
                : r.decided_by === "user"
                  ? "[已确认·本人核过]"
                  : "[已确认·模型声称]";
          const quote = r.quote ? `\n    原话：${r.quote}` : "";
          return `${mark} ${r.layer}/${r.kind} · ${r.source}\n  ${r.text}${quote}`;
        })
        .join("\n");
      return { output: [{ type: "text", text }] };
    },
  };

  const setLiveParams = Type.Object({
    text: Type.String({ description: "三五行，写清进度和未完成项，不要写结论性判断" }),
  });

  const setLive: ToolRegistration<typeof setLiveParams> = {
    name: "set_live",
    description: "写当前会话的近期状态：刚做了什么、哪里还没结束、下次从哪儿接。",
    parameters: setLiveParams,
    replay: "unsafe",
    async execute(args) {
      store.setLive(currentSession(), args.text);
      return { output: [{ type: "text", text: "live 已更新。" }] };
    },
  };

  const readLiveParams = Type.Object({
    session: Type.Optional(Type.String({ description: "省略则列出全部会话的 live" })),
  });

  const readLive: ToolRegistration<typeof readLiveParams> = {
    name: "read_live",
    description: "读取其他会话留下的近期状态，用于接手别人的进度。",
    parameters: readLiveParams,
    replay: "safe",
    async execute(args) {
      if (args.session) {
        const row = store.getLive(args.session);
        return {
          output: [{ type: "text", text: row ? row.text : `会话 ${args.session} 没有 live 记录。` }],
        };
      }
      const all = store.liveAll();
      if (all.length === 0) return { output: [{ type: "text", text: "还没有任何 live 记录。" }] };
      const text = all
        .map((r) => `session ${r.session_id} · ${new Date(r.updated_at).toISOString()}\n${r.text}`)
        .join("\n\n");
      return { output: [{ type: "text", text }] };
    },
  };

  return {
    name: "memory",
    sections: [{ key: "memory", tag: false, render: () => MEMORY_RULES }],
    tools: [remember, recall, setLive, readLive],
  };
}

export { LAYERS, KINDS };
