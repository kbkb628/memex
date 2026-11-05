import { DurableObject } from "cloudflare:workers";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { buildModels } from "./models";
import { systemExtension } from "./prompts";
import { webExtension } from "./tools";

/**
 * 一个用户 = 一个 Durable Object = 一个脑子。
 *
 * 这一版只做一件事，但要做对：
 *
 *   发一条消息，页面可以立刻关掉，它做完了答案还在等你。
 *
 * 因此只有四个路由：
 *
 *   POST /submit   立刻拿到回执，模型还没开始跑
 *   GET  /op       问这张回执怎么样了：排队中 / 正在跑 / 做完了，附答案
 *   GET  /status   用的哪个模型、能不能用
 *   GET  /patrol   上一次巡检做了什么、下一次什么时候醒
 *
 * 加上一个工具（fetch_url，src/tools.ts）和一次每日巡检，这就是全部。
 * 没有会话列表、没有记忆、没有提示词版本、没有分叉。那些都在 _shelved/ 里躺着，
 * 等有真实需要时一件一件长回来。
 *
 * 为什么它能活过页面关闭：pi 把会话、任务、提交记录都写在这个对象自己的 SQLite 里，
 * 由 Lifecycle 的一个 job 驱动 pi.wake()。对象被驱逐时 job 仍然到期，alarm 把它拉起来，
 * pi 重新打开自己没做完的任务接着跑。页面关不关、进程死不死，跟这件事无关。
 */
/** pi 的 root 会话。只在读旧记录（没有 session 字段）时退回它。 */
const ROOT = "1";

/** 写在自己库里的一份索引：存过的 id 才认得，免得拿一个野 id 去 wait 挂在对象里。 */
type Note = { id: string; text: string; at: number; session: string };

/**
 * 巡检：每天醒一次，看有没有任务卡住了。
 *
 * 它不调模型，所以不花钱 —— 巡检的全部价值在于「发现」和「重新排队」，
 * 不在于「重做」。真正花 token 的是被救回来的那些任务，而那笔钱本来就要花。
 *
 * 不能用 `ctx.storage.setAlarm()` 自己排：一个 DO 只有一个 alarm，pi 的 Lifecycle
 * 已经占着它驱动 `wake()`。自己设会把 pi 的唤醒盖掉，表现是任务再也不恢复。
 * 正确入口是 `lifecycle.jobs.push()`，由 Lifecycle 统一算物理 alarm。
 */
const PATROL = "patrol";
const DAY_MS = 24 * 60 * 60 * 1000;
/** 上线后一分钟跑第一次，好让人当场看见它工作，之后每天一次。 */
const FIRST_PATROL_MS = 60 * 1000;
/** 一个任务挂这么久还没结果，就算可疑。pi 自己的重试比这快得多。 */
const STUCK_MS = 30 * 60 * 1000;

type PatrolReport = {
  at: number;
  scanned: number;
  /** parked 的任务，已经被重新排队。 */
  retried: string[];
  /** 还在 pending 里、但已经很久没动，只记录不动手。 */
  stuck: string[];
};

export class Home extends DurableObject<Env> {
  private readonly setup = buildModels(this.env);
  private readonly registry = createRegistry();
  private installed = false;
  /** 只在这一个实例的生命周期内有效；驱逐后重置，靠 job 的 get 兜底。 */
  private patrolReady = false;

  private readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      if (!this.installed) {
        this.registry.install(systemExtension());
        // 一个工具一个扩展。将来加第二个工具时，先想清楚它有没有副作用，
        // 再决定 `replay` 标哪个 —— 见 src/tools.ts 开头那段。
        this.registry.install(webExtension());
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
      await this.ensurePatrol();

      if (path === "/submit" && request.method === "POST") return await this.submit(request);
      if (path === "/op" && request.method === "GET") return await this.op(url.searchParams.get("id"));
      if (path === "/status" && request.method === "GET") return await this.status();
      if (path === "/patrol" && request.method === "GET") return await this.patrolReport();
      if (path === "/" || path === "/health") return new Response("ok");
      return new Response("not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  /**
   * 巡检 job 到期时 Lifecycle 调这里。
   *
   * 返回 `{ rescheduleAt }` 让它排下一次；不返回就结束（以后不再醒）。
   * 这个 dispatch 有超时预算，所以里面只做「读 + 重新排队」，不等模型。
   */
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== PATROL) return;

    const report = await this.patrol();
    await this.ctx.storage.put("patrol:last", report);

    return { rescheduleAt: Date.now() + DAY_MS };
  }

  /**
   * 排上巡检。幂等：已经排过就不动。
   *
   * 不能每次请求都用同一个 id 重新 push —— 那会把到期时间一次次往后推，
   * 结果就是永远不到期。所以先 get 再决定。
   */
  private async ensurePatrol(): Promise<void> {
    if (this.patrolReady) return;
    this.patrolReady = true;
    if (this.lifecycle.jobs.get(PATROL)) return;

    await this.lifecycle.jobs.push({
      id: PATROL,
      fn: PATROL,
      time: Date.now() + FIRST_PATROL_MS,
      payload: {},
    });
  }

  /**
   * 扫一遍所有回执，看谁卡住了。
   *
   * 判据只有两条，都很便宜：
   *   - 在 pi 的 pending 里、状态是 parked  → 确定卡住，重新排队
   *   - 在 pending 里、但提交已超过 STUCK_MS → 可疑，只记进报告，不擅自动它
   *
   * 不在 pending 里就说明 pi 已经给它结算了（done 或 unanswered），跳过。
   * 用 pending 而不是 wait，是因为 wait 会把巡检挂在一个没跑完的任务上。
   */
  private async patrol(): Promise<PatrolReport> {
    const entries = await this.ctx.storage.list<Note>({ prefix: "op:" });
    const report: PatrolReport = { at: Date.now(), scanned: entries.size, retried: [], stuck: [] };

    const bySession = new Map<string, Note[]>();
    for (const note of entries.values()) {
      if (!note.session) continue;
      const batch = bySession.get(note.session) ?? [];
      batch.push(note);
      bySession.set(note.session, batch);
    }

    for (const [session, batch] of bySession) {
      const pending = await this.harness.pending({ session });
      if (!pending.length) continue;

      const known = new Map(batch.map((n) => [n.id, n]));
      for (const item of pending) {
        const note = known.get(item.operationId);
        if (!note) continue;

        if (item.status === "parked") {
          // pi 的崩溃循环保护把它停下了；重新排一次是唯一能救它的动作。
          if (await this.harness.retry({ session })) report.retried.push(item.operationId);
          continue;
        }

        if (Date.now() - note.at > STUCK_MS) {
          report.stuck.push(`${item.operationId} ${item.status}`);
        }
      }
    }

    return report;
  }

  private async patrolReport(): Promise<Response> {
    const last = await this.ctx.storage.get<PatrolReport>("patrol:last");
    const job = this.lifecycle.jobs.get(PATROL);
    return Response.json({
      last: last ?? null,
      next: job ? job.time : null,
    });
  }

  /**
   * 立刻回执，不等模型。
   *
   * 每条回执一个独立会话：所有提交都塞进 root（"1"）的话，历史只增不减，
   * 每条新消息都在为前面所有不相干的任务付 token，跑几十条就顶到上下文上限。
   *
   * 会话 id 不能自己编 —— pi 只认正整数（root 是 "1"），新会话必须由
   * `sessions.create()` 分配。所以幂等不能靠「用 operationId 派生 id」，
   * 得靠先查回执：这张回执已经存在，就回到它原来的会话里去重投，否则同一件事
   * 会变成两条时间线。
   *
   * 代价：pi 没有删除会话的接口，会话只增不减。一条任务几 KB，5GB 存储能装
   * 十万量级，一个人用够了；要做回收得自己按 `sessions.list()` 清，那是以后的事。
   */
  private async submit(request: Request): Promise<Response> {
    const body = await request.json<{ text?: string; operationId?: string }>();
    const text = body.text?.trim();
    if (!text) return Response.json({ error: "text is required" }, { status: 400 });

    if (!this.setup.ready) {
      // 没配 key 时把原因说清楚，而不是让请求跑到一半挂在 provider 里。
      return Response.json({ error: "model_not_configured", hint: this.setup.hint }, { status: 503 });
    }

    const operationId = body.operationId?.trim() || crypto.randomUUID();

    // 重投同一个 operationId：不新建会话，回到它原来那条时间线上。
    // DO 单线程，所以「查了没有 → 新建」之间不会插进另一个请求。
    const existing = await this.ctx.storage.get<Note>(`op:${operationId}`);
    if (existing) {
      const receipt = await this.harness.submit(text, {
        operationId,
        session: existing.session,
      });
      return Response.json({ ...receipt, at: Date.now() });
    }

    const session = await this.harness.sessions.create();
    const receipt = await this.harness.submit(text, { operationId, session: session.id });
    await this.ctx.storage.put<Note>(`op:${operationId}`, {
      id: operationId,
      text,
      at: Date.now(),
      session: session.id,
    });

    return Response.json({ ...receipt, at: Date.now() });
  }

  /**
   * 查回执。
   *
   * 顺序是先问 pending 再 wait，不能反过来：任务还在跑的时候去 wait，会把一个
   * HTTP 请求挂在对象里等几十分钟，白白占着它。已经落盘的结果则是一条提交读，
   * wait 立刻返回。
   *
   * pending 与 wait 都必须带上这张回执自己的会话 —— 不带参数时 pi 只查 root 会话，
   * 那会让所有非 root 的任务永远查不到状态。旧记录没有 session 字段，退回 root。
   */
  private async op(id: string | null): Promise<Response> {
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    const note = await this.ctx.storage.get<Note>(`op:${id}`);
    if (!note) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const session = note.session ?? ROOT;

    const live = (await this.harness.pending({ session })).find((p) => p.operationId === id);
    if (live) return Response.json({ operationId: id, status: live.status, live: true });

    return Response.json(await this.harness.wait(id, { session }));
  }

  private async status(): Promise<Response> {
    const sessions = await this.harness.sessions.list();
    return Response.json({
      model: this.setup.label,
      ready: this.setup.ready,
      sessions: sessions.length,
      ...(this.setup.hint ? { hint: this.setup.hint } : {}),
    });
  }
}
