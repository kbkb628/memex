import { DurableObject } from "cloudflare:workers";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness, type PiSession } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { MemoryStore, memoryExtension, type Kind, type Layer, type Status } from "./memory";
import { buildModels } from "./models";
import { PromptBook, promptExtension } from "./prompts";

/**
 * 一个用户 = 一个 Durable Object = 一个脑子。
 *
 * 文章 48 用 Router + Worker 两层解决「全局连续 vs 高并发」，文章 50 又反过来
 * 说「先有一个能持续参与真实工作的分身就够」。在单用户场景下这两件事是一回事：
 *
 *   - root 会话（id "1"）承担 Router 的角色：全部入口的消息都先进这里
 *   - 真正要动手的活，fork 出一个会话去干，root 不被阻塞
 *
 * Durable Object 单线程 + 单写者，顺手把文章 50 里最折磨人的那类问题
 * （两台设备写不同目录、同步了文件但记录没更新、两个分身各读各的会话）
 * 从架构上消掉了。代价是：这里没有本地文件系统，环境能力要靠沙箱或本地 daemon 补。
 */
const ROOT = "1";

export class Home extends DurableObject<Env> {
  private readonly setup = buildModels(this.env);
  private readonly registry = createRegistry();
  private readonly memory = new MemoryStore(this.ctx.storage.sql);
  private readonly prompts = new PromptBook(this.ctx.storage.sql);
  private current: string = ROOT;
  private installed = false;

  private readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      if (!this.installed) {
        this.registry.install(promptExtension(this.prompts));
        this.registry.install(memoryExtension(this.memory, () => this.current));
        this.installed = true;
      }
      return Harness.open(storage, { models: this.setup.models, registry: this.registry, onWake }, context);
    },
    defaults: { model: this.setup.model },
  });

  // 必须声明在 harness 之后：install 时它要找已初始化的 capability。
  private readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/status" && request.method === "GET") return await this.status();
      if (path === "/ask" && request.method === "POST") return (await this.guard()) ?? (await this.ask(request));
      if (path === "/submit" && request.method === "POST") return (await this.guard()) ?? (await this.submit(request));
      if (path === "/task" && request.method === "POST") return (await this.guard()) ?? (await this.task(request));
      if (path === "/sessions" && request.method === "GET") return Response.json(await this.harness.sessions.list());
      if (path === "/live" && request.method === "GET") return Response.json(this.memory.liveAll());
      if (path === "/live" && request.method === "POST") return await this.writeLive(request);
      if (path === "/prompt" && request.method === "GET") {
        const key = url.searchParams.get("key") ?? "rules";
        return Response.json({ key, current: this.prompts.get(key), history: this.prompts.history(key) });
      }
      if (path === "/prompt" && request.method === "PUT") return await this.patchPrompt(request);
      if (path === "/memory" && request.method === "GET") return this.listMemory(url);
      if (path === "/memory" && request.method === "POST") return await this.writeMemory(request);
      if (path.startsWith("/memory/") && request.method === "POST") return await this.decideMemory(path, request);
      if (path === "/" || path === "/health") return new Response("ok");
      return new Response("not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  /** 没有可用模型时先把原因说清楚，而不是让请求跑到一半挂在 provider 里。 */
  private guard(): Response | undefined {
    if (this.setup.ready) return undefined;
    return Response.json(
      { error: "model_not_configured", model: this.setup.label, hint: this.setup.hint },
      { status: 503 },
    );
  }

  /** 一条命令看清：用的哪个模型、能不能用、当前会话是谁。 */
  private async status(): Promise<Response> {
    let sessionCount: number | null = null;
    try {
      const list = await this.harness.sessions.list();
      sessionCount = Array.isArray(list) ? list.length : null;
    } catch {
      // 会话表尚未建立时不影响状态查询，其余字段仍然可信
    }
    return Response.json({
      model: this.setup.label,
      ready: this.setup.ready,
      ...(this.setup.hint ? { hint: this.setup.hint } : {}),
      current: this.current,
      sessions: sessionCount,
      pending: this.memory.needsReview().length,
    });
  }

  /** 说完就等答案。适合我人在跟前的时候。 */
  private async ask(request: Request): Promise<Response> {
    const { text, session } = await request.json<{ text: string; session?: string }>();
    if (!text?.trim()) return Response.json({ error: "text is required" }, { status: 400 });
    const target = await this.pin(session ?? ROOT);
    const result = await target.prompt(text);
    return Response.json(result);
  }

  /** 接下来就走：立刻返回凭据，模型在后台跑。适合从手机丢一句话就出门。 */
  private async submit(request: Request): Promise<Response> {
    const { text, session } = await request.json<{ text: string; session?: string }>();
    if (!text?.trim()) return Response.json({ error: "text is required" }, { status: 400 });
    const target = await this.pin(session ?? ROOT);
    const receipt = await target.submit(text);
    return Response.json(receipt);
  }

  /** 开一个新会话去干活，root 不被占用。session 内可用 read_live 接手别人的进度。 */
  private async task(request: Request): Promise<Response> {
    const { text, handoff } = await request.json<{ text: string; handoff?: string }>();
    if (!text?.trim()) return Response.json({ error: "text is required" }, { status: 400 });

    const forked = await this.harness.sessions.fork(ROOT);
    if (handoff?.trim()) await forked.reset(handoff.trim());
    await forked.setModel(this.setup.model);

    this.current = forked.id;
    const receipt = await forked.submit(text);
    return Response.json(receipt);
  }

  /**
   * 把会话钉到当前配置的模型上。
   *
   * pi 会把会话用的模型随会话一起存下来，恢复时用存下的那个，而不是 defaults。
   * 所以换过模型之后，老会话会一直指着已经不存在的模型（本地就是从 Workers AI
   * 切到 DeepSeek 时那种 `no_model`）。每次进门先校一次，比写迁移脚本可靠。
   */
  private async pin(sessionId: string): Promise<PiSession> {
    const session = this.harness.session(sessionId);
    await session.setModel(this.setup.model);
    this.current = sessionId;
    return session;
  }

  /**
   * 记忆列表。三种用法：
   *   ?q=关键词   检索
   *   ?review=1    只看需要人裁决的（讨论中 + 模型声称待复核）
   *   不带参数     按状态/层过滤的完整列表
   */
  private listMemory(url: URL): Response {
    const limit = Number(url.searchParams.get("limit") ?? 30);
    const layer = (url.searchParams.get("layer") as Layer | null) ?? undefined;

    const q = url.searchParams.get("q")?.trim();
    if (q) return Response.json(this.memory.recall(q, { layer, limit }));

    if (url.searchParams.get("review") === "1") {
      return Response.json(this.memory.needsReview(limit));
    }

    const status = (url.searchParams.get("status") as Status | null) ?? undefined;
    return Response.json(this.memory.list({ status, layer, limit }));
  }

  /** 本人亲手写一条。默认直接算核过；传 confirm=false 就先挂在讨论中，回头再定。 */
  private async writeMemory(request: Request): Promise<Response> {
    const body = await request.json<{
      text?: string;
      layer?: Layer;
      kind?: Kind;
      source?: string;
      confirm?: boolean;
    }>();
    if (!body.text?.trim()) return Response.json({ error: "text is required" }, { status: 400 });

    const row = this.memory.remember({
      layer: body.layer ?? "stable",
      kind: body.kind ?? "note",
      text: body.text,
      source: body.source?.trim() || "本人手写",
    });
    return Response.json(body.confirm === false ? row : this.memory.confirm(row.id));
  }

  /** 本人对一条记忆的裁决。界面上那两个按钮，后端只有这一个入口。 */
  private async decideMemory(path: string, request: Request): Promise<Response> {
    const [, id, action] = path.split("/").filter(Boolean);
    if (!id || (action !== "confirm" && action !== "reject")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    let note: string | undefined;
    if (action === "reject") {
      try {
        note = (await request.json<{ note?: string }>()).note;
      } catch {
        // 允许空 body：否决不强制填理由
      }
    }

    const row = action === "confirm" ? this.memory.confirm(id) : this.memory.reject(id, note);
    if (!row) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(row);
  }

  private async writeLive(request: Request): Promise<Response> {
    const { text, session } = await request.json<{ text: string; session?: string }>();
    if (!text?.trim()) return Response.json({ error: "text is required" }, { status: 400 });
    this.memory.setLive(session ?? ROOT, text);
    return Response.json({ ok: true });
  }

  /**
   * 在线改一层提示词。文章 48 的 watchdog 可以直接打这个口子，
   * 文章 50 那句「当场改对 ≠ 下次做对」则靠 prompt_hist 回看。
   */
  private async patchPrompt(request: Request): Promise<Response> {
    const { key, text } = await request.json<{ key: string; text: string }>();
    if (!key || !text?.trim()) return Response.json({ error: "key and text are required" }, { status: 400 });
    const version = this.prompts.set(key, text);
    return Response.json({ key, version });
  }
}
