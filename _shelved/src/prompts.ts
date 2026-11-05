import type { Extension } from "@earendil-works/pi-durable";

/**
 * 提示词分层，每层独立版本化。
 *
 * 文章 50 里那段「早期不满意就加一条要求，加多了它越来越小心」的教训，
 * 本质是把长期人格和临时任务要求混在了同一层。这里按层切开：
 *
 *   identity  它是谁（极简，不该膨胀）
 *   user      关于我：稳定背景 + 当前重点
 *   soul      冲突时优先什么
 *   rules     操作规则：哪些动作必须先问
 *   rituals   可被一句话唤起的工作模式
 *   memory    记忆写入规则（由 MemoryStore 注入）
 *
 * 每次改写都留版本，因为「当场改对一句话，和下次遇到类似问题能做对，是两件事」——
 * 不留痕迹就没法回看那次改动到底有没有用。
 */

export type PromptKey = "identity" | "user" | "soul" | "rules" | "rituals";

const DEFAULTS: Record<PromptKey, string> = {
  identity: `你是我的个人分身。你为我一个人工作，不为团队。

你说话简短，先给判断，再给依据。不确定就说不确定，不要用「可能」「也许」糊过去。
你不主动表扬我，也不为了让我舒服而调整结论。`,

  user: `关于我：在这里写稳定的背景——我在做什么、长期关注什么、习惯用什么方式思考。
当前重点：写最近两三周真正在推进的事，以及为什么现在做。
这一层会被每次请求带上，所以要短。过期的重点删掉，不要堆。`,

  soul: `遇到冲突时，我优先：
- 真实判断 > 我听着舒服
- 说清楚分歧 > 快速收敛到结论
- 保留推演过程 > 只留一个稳妥的结论
- 承认不知道 > 编一个合理的东西

写东西时：观点可以保留，事实和推演要分开。不要为了严谨把没验证的推导整段删掉。`,

  rules: `操作规则：
- 改文件、发消息、对外提交之前，先说你要做什么，等我确认。
- 读操作不用问。
- 记忆写入遵守独立的记忆规则。
- 报告失败就报告失败，不要绕过限制来避免问我。
- 一次只问一个具体问题，不要塞一个问卷。`,

  rituals: `工作模式（由我一句话唤起）：

「洗澡时刻」——放下手上的任务，从最近的 live、当前重点和未完成的问题出发，
找我没注意到的联系：两件看似无关的事是不是同一个问题；我最近的决定和之前坚持的判断有没有矛盾；
新看到的材料会不会推翻某个一直没验证的前提。

先给三到五个观察，每个都讲清你为什么想到这个联系。不要硬凑。
还没想清楚的，明确标成待讨论，不要写进 stable。`,
};

export class PromptBook {
  private readonly cache = new Map<string, string>();

  constructor(private readonly sql: SqlStorage) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS prompt (
      key TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS prompt_hist (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      version INTEGER NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
    this.seed();
    this.load();
  }

  private seed(): void {
    for (const [key, text] of Object.entries(DEFAULTS)) {
      this.sql.exec(
        `INSERT OR IGNORE INTO prompt (key, text, version, updated_at) VALUES (?, ?, 1, ?)`,
        key, text, Date.now(),
      );
    }
  }

  private load(): void {
    for (const row of this.sql.exec(`SELECT key, text FROM prompt`).toArray() as unknown as {
      key: string;
      text: string;
    }[]) {
      this.cache.set(row.key, row.text);
    }
  }

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  /** 改一层，版本 +1，旧版进历史。 */
  set(key: string, text: string): number {
    const prev = this.sql.exec(`SELECT version FROM prompt WHERE key = ?`, key)
      .toArray()[0] as { version: number } | undefined;
    const version = (prev?.version ?? 0) + 1;
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO prompt (key, text, version, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET text = excluded.text, version = excluded.version, updated_at = excluded.updated_at`,
      key, text, version, now,
    );
    this.sql.exec(
      `INSERT INTO prompt_hist (id, key, version, text, at) VALUES (?, ?, ?, ?, ?)`,
      crypto.randomUUID(), key, version, text, now,
    );
    this.cache.set(key, text);
    return version;
  }

  history(key: string, limit = 10): { version: number; text: string; at: number }[] {
    return this.sql.exec(
      `SELECT version, text, at FROM prompt_hist WHERE key = ? ORDER BY version DESC LIMIT ?`,
      key, limit,
    ).toArray() as unknown as { version: number; text: string; at: number }[];
  }
}

/** 把每一层摊成独立的提示词段落，顺序即优先级。 */
export function promptExtension(book: PromptBook): Extension {
  const sections: PromptKey[] = ["identity", "user", "soul", "rules", "rituals"];
  return {
    name: "prompt-layers",
    sections: sections.map((key) => ({
      key,
      tag: true,
      render: () => book.get(key),
    })),
    tools: [],
  };
}

export { DEFAULTS as DEFAULT_PROMPTS };
