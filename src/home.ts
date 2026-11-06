import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { buildModels } from "./models";
import { systemExtension } from "./prompts";
import { webExtension } from "./tools";
import {
  DEFAULT_FEEDS,
  fetchFeed,
  hash as hashId,
  INBOX_LIMIT,
  isSkip,
  localDay,
  prefilterHits,
  promptFor,
  SEEN_LIMIT,
  type Feed,
  type FeedItem,
} from "./feeds";

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
type Note = {
  id: string;
  text: string;
  /** 受理时间：拿到回执的那一刻，模型还没开始跑。 */
  at: number;
  session: string;
  /**
   * 第一次看到它结算的时间。
   *
   * 有一点必须说清：它是「我们第一次发现它跑完了」，不是「它跑完的瞬间」。
   * 两者的差是轮询间隔 —— 页面轮询最多差一秒，输入源那边的任务可能差三小时。
   * 所以对外只说 `elapsedMs`（受理到发现），不说「耗时」。**宁可说得保守，
   * 也不要让一个看着像精确值的数字撒谎。**
   */
  endedAt?: number;
  /**
   * 提交内容的摘要（sha256 前 8 字节）。
   *
   * 用来回答一个 `operationId` 回答不了的问题：**同一个 id，两次带来的文字一样吗？**
   * 不存它的话，重投一个 id 换一段新文字，新文字会被 pi 当成重复提交拒掉
   * （`accepted: false`），而调用方只看到「没被受理」，不知道自己的话被丢了。
   * 旧回执没有这个字段，读到就当作「一样」并顺手补上。
   */
  digest?: string;
};

/**
 * 输入源：每 3 小时醒一次，看订阅源有没有新的。
 *
 * 这一步醒来的时间绝大部分花在网络上（拉源），而不是模型上 —— 这是刻意的。
 * 一次醒来只做四件事，全部便宜：
 *
 *   1. 结算上一批：查它们跑完没有，跑完的进收件箱（不调模型）
 *   2. 拉每个源、解析出条目
 *   3. 和「已经处理过的 id」比对，找出真正新的（纯字符串比较，零 token）
 *   4. 只把预算内的那些提交成任务，然后立刻结束
 *
 * 第 4 步提交的是 pi 的普通任务，所以「读文章、判断值不值得看」走的是既有执行路径：
 * 崩溃能续跑、按任务分会话、回执可查。**输入源没有引入任何新的执行机制**，
 * 它只是一个把外部事件翻译成任务的适配器。
 */
const INGEST = "ingest";
const INGEST_EVERY_MS = 3 * 60 * 60 * 1000;
const FIRST_INGEST_MS = 90 * 1000;

/**
 * 预算闸门。
 *
 * 这两个数字是整个功能的产品定义，不是省钱手段：它逼着这个东西承认
 * 「我一天只打算跟你说几件事」，于是它就必须挑，而不能搬运。
 * 一个不设上限的订阅 agent 三天就会变成你最不想打开的那个 App。
 */
const DAILY_CALLS = 20;
const MAX_PER_RUN = 5;

/**
 * 一天能问模型几次。默认 20，部署时用 `DAILY_CALLS` 变量可以改。
 *
 * 不是为了让人把它调到无限 —— 上限本身是这个东西的产品定义。开放它是因为
 * 「一天几件」因人而异：有人想一天只看五条，有人想三十条。写死等于替所有人
 * 做了这个决定，而代价只是在确认一个数的时候多读一处配置。
 */
function dailyCalls(env: Env): number {
  const raw = Number((env as unknown as Record<string, unknown>).DAILY_CALLS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DAILY_CALLS;
}

/**
 * 用量缓存多久。
 *
 * `usage()` 是 pi 的账本，它要把每条会话的用量文档各读一遍才算得出来。
 * 页面每分钟轮询一次 `/status`，不缓存的话，一次刷新就是几百次存储读，
 * 而且这个数会随会话数一起涨。缓存六十秒，刷新就等于免费。
 */
const SPEND_CACHE_MS = 60_000;

/** 一个桶的用量（某个模型，或被工具花掉的）。 */
type SpendBucket = { name: string; tokens: number; cost: number };

/**
 * 用量总账。
 *
 * 口径是「从第一条会话到现在」，**不是今天**。预算那个数才是按天的，
 * 两个数并排放时必须各自标清楚，否则读的人会以为是同一天的账。
 */
type Spend = {
  at: number;
  tokens: number;
  /** provider 报价算出来的钱，单位美元。没有报价的 provider 报 0，不是「免费」。 */
  cost: number;
  /**
   * 这个金额是怎么来的。
   *
   * 它是 SDK 按 provider 报价表算的估算值，**不是账单**：没有真实扣费凭据，
   * 也没有核过汇率和阶梯价。所以接口里明说，页面上写「估算」。
   * 一个看着像精确值的数字最容易撒谎 —— 宁可它丑一点。
   */
  costKind: "estimate";
  models: SpendBucket[];
  tools: SpendBucket[];
  /** 算不出来时的原因。有它就说明下面那几个数不作数，而不是「花了 0」。 */
  error?: string;
};

type InboxItem = {
  /** 提交时用的 operationId，也是这张收件条目的 id。 */
  id: string;
  feedId: string;
  feed: string;
  title: string;
  link: string;
  at: number;
  session: string;
  state: "pending" | "ready" | "skipped" | "failed";
  /** 模型写的那两三句话；跳过或失败时是原因。 */
  note?: string;
  read?: boolean;
};

type IngestReport = {
  at: number;
  feeds: number;
  /** 拉取失败的源，逐条带原因 —— 静默失败比失败更糟。 */
  failed: { feed: string; error: string }[];
  /** 比对出来、确实没见过的新条目数。 */
  fresh: number;
  /** 实际提交成任务的条数（受预算与前几次结算影响）。 */
  submitted: number;
  /** 这次结算出结果的条数。 */
  settled: number;
  /** 其中模型判定跳过、因而没进收件箱的条数。 */
  skipped: number;
  budget: { day: string; used: number; limit: number };
  /** 这一轮有几个源是第一次接上、只记基线不提交的。 */
  baselined?: number;
  /** 这一轮清掉了几条「源已经不在了」的收件箱条目。 */
  pruned?: number;
  /**
   * 这一轮有几条被粗筛挡在模型外面（一个关注词都没命中）。
   *
   * 它们不占预算、不建任务、也不进收件箱 —— 但必须报出来。否则用户看到
   * 「今天一条新的都没有」，会以为源坏了，实际是规则挡掉了。
   */
  prefiltered?: number;
  /** 挡掉的里面挑几条给出来，让规则是否过窄能被人当场看到。 */
  prefilteredSample?: { feed: string; title: string }[];
  note?: string;
};

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

/**
 * 把一个 Usage 折算成两个数：token 和钱。
 *
 * 不用 `usage.totalTokens` 直接当准 —— 有些 provider 只报 input/output，
 * 那个字段是 0。所以优先用它，没有就自己加。
 * `cost` 同理：没有报价时它是 0，这在下面要和「真的免费」区分开。
 */
function tally(usage: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } | undefined) {
  if (!usage) return { tokens: 0, cost: 0 };
  const sum = (usage.input ?? 0) + (usage.output ?? 0);
  return { tokens: usage.totalTokens || sum, cost: usage.cost?.total ?? 0 };
}

/**
 * 一段文字的指纹，用来判断「同一个 operationId 两次带来的东西是不是同一份」。
 *
 * 用 sha256 而不是 `feeds.ts` 里那个 32 位 FNV：那个是给条目 id 用的，
 * 撞了只是少看一篇文章；这个撞了会让一段真话被当成重复丢掉，代价不对称。
 */
async function digestOf(text: string): Promise<string> {
  const sum = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(sum).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 词表的输入形状：数组，或者一串用逗号/顿号隔开的词。
 *
 * 允许手写 `agent, llm、sqlite`，因为人不该为了填一个词表去拼 JSON 数组。
 * 空串和空数组都返回空 —— 但调用方要区分「没传这个字段」和「传了个空的」：
 * 前者是没意见，后者是明确要关掉粗筛。
 */
function parseWords(input: string[] | string | undefined): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : input.split(/[,，、\n]+/);
  const out: string[] = [];
  for (const piece of raw) {
    const word = String(piece).trim();
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}

export class Home extends DurableObject<Env> {
  private readonly setup = buildModels(this.env);
  private readonly registry = createRegistry();
  private installed = false;
  /** 只在这一个实例的生命周期内有效；驱逐后重置，靠 job 的 get 兜底。 */
  private jobsReady = false;

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
      await this.ensureJobs();

      if (path === "/submit" && request.method === "POST") return await this.submit(request);
      if (path === "/op" && request.method === "GET") return await this.op(url.searchParams.get("id"));
      // `?spend=fresh` 绕过六十秒缓存：核对账目时不想等缓存过期。
      if (path === "/status" && request.method === "GET")
        return await this.status(url.searchParams.get("spend") === "fresh");
      if (path === "/patrol" && request.method === "GET") return await this.patrolReport();
      if (path === "/feeds" && request.method === "GET") return await this.listFeeds();
      if (path === "/feeds" && request.method === "POST") return await this.addFeed(request);
      if (path === "/feeds/update" && request.method === "POST") return await this.updateFeed(request);
      if (path === "/feeds/remove" && request.method === "POST") return await this.removeFeed(request);
      if (path === "/inbox" && request.method === "GET") return await this.listInbox(request);
      if (path === "/inbox/read" && request.method === "POST") return await this.markRead(request);
      if (path === "/ingest" && request.method === "GET") return await this.ingestReport();
      if (path === "/ingest/run" && request.method === "POST") return await this.ingestNow();
      if (path === "/" || path === "/health") return new Response("ok");
      return new Response("not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  /**
   * job 到期时 Lifecycle 调这里。
   *
   * 返回 `{ rescheduleAt }` 让它排下一次；不返回就结束（以后不再醒）。
   * 这个 dispatch 有超时预算，所以两个 job 都不等模型：
   * 巡检只读 pending，输入源只拉源 + 提交任务。
   */
  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn === PATROL) {
      const report = await this.patrol();
      await this.ctx.storage.put("patrol:last", report);
      return { rescheduleAt: Date.now() + DAY_MS };
    }

    if (context.job.fn === INGEST) {
      const report = await this.ingest();
      await this.ctx.storage.put("ingest:last", report);
      return { rescheduleAt: Date.now() + INGEST_EVERY_MS };
    }
  }

  /**
   * 排上两个周期 job。幂等：已经排过就不动。
   *
   * 不能每次请求都用同一个 id 重新 push —— 那会把到期时间一次次往后推，
   * 结果就是永远不到期。所以先 get 再决定。
   */
  private async ensureJobs(): Promise<void> {
    if (this.jobsReady) return;
    this.jobsReady = true;

    if (!this.lifecycle.jobs.get(PATROL)) {
      await this.lifecycle.jobs.push({
        id: PATROL,
        fn: PATROL,
        time: Date.now() + FIRST_PATROL_MS,
        payload: {},
      });
    }

    if (!this.lifecycle.jobs.get(INGEST)) {
      await this.lifecycle.jobs.push({
        id: INGEST,
        fn: INGEST,
        time: Date.now() + FIRST_INGEST_MS,
        payload: {},
        // 上一次还没跑完就跳过这次。拉源是网络活，串行进一次比并发跑两遍干净。
        singleflight: true,
        // 拉几个源最坏情况要几十秒；默认 30 秒会把正常的拉取判成「挂住」。
        hungTimeoutSeconds: 90,
      });
    }

    await this.ensureDefaultFeeds();
  }

  /**
   * 第一次醒来时把默认源装上。
   *
   * 只写配置，不联网 —— 这里在每条请求的必经之路上，抓三个源既慢又可能失败。
   * 基线留给 ingest 补：它发现某个源没有 `seen:` 记录，就把这一轮当成基线，
   * 全部记为已见、一条都不提交。
   *
   * 判断依据是 `cfg:feeds` 存不存在，不是长度。用户把默认源全删了会留下一个
   * 空数组，那是「我不要这些」的意思，不是「还没初始化」。
   */
  private async ensureDefaultFeeds(): Promise<void> {
    const existing = await this.ctx.storage.get<Feed[]>("cfg:feeds");
    if (existing === undefined) {
      const now = Date.now();
      const feeds: Feed[] = DEFAULT_FEEDS.map((f) => ({ ...f, id: hashId(f.url), addedAt: now }));
      await this.ctx.storage.put("cfg:feeds", feeds);
      await this.ctx.storage.put("cfg:prefilter-migrated", true);
      return;
    }

    // 一次性迁移：粗筛是后加的能力，老实例里那几个默认源的记录不会自己长出词表。
    // 只用标记锁一次 —— 用户如果之后把 prefilter 删了，那是「我不要筛」的意思，
    // 不能每次醒来又给他塞回去。
    if (await this.ctx.storage.get<boolean>("cfg:prefilter-migrated")) return;
    const defaults = new Map(
      DEFAULT_FEEDS.filter((f) => f.prefilter?.length).map((f) => [f.url, f.prefilter!]),
    );
    let changed = false;
    const patched = existing.map((feed) => {
      const words = defaults.get(feed.url);
      if (words && !feed.prefilter?.length) {
        changed = true;
        return { ...feed, prefilter: words };
      }
      return feed;
    });
    if (changed) await this.ctx.storage.put("cfg:feeds", patched);
    await this.ctx.storage.put("cfg:prefilter-migrated", true);
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

  // ───────────────────────────── 输入源 ─────────────────────────────

  /**
   * 一次「醒来」的全部动作。
   *
   * 顺序不能换，而且每一步各自有理由：
   *
   *   结算在前 —— 上一批可能已经跑完了，先把它们的结果搬进收件箱，
   *              否则收件箱会永远空着（因为提交之后没有任何人去收结果）。
   *   预算在中 —— 先知道今天还剩几次，才知道这一轮该挑几条。
   *   拉源在后 —— 网络是最贵的一步，放在最后，前面的判断都能提前退出。
   *
   * 全程只有第 4 步的 `submit` 会间接引发模型调用，而 submit 本身不等模型：
   * 它只是落盘 + 触发一次 wake，真正的生成在事件循环之外继续跑。
   */
  private async ingest(): Promise<IngestReport> {
    const now = Date.now();
    await this.ensureDefaultFeeds();
    const feeds = await this.readFeeds();
    const report: IngestReport = {
      at: now,
      feeds: feeds.length,
      failed: [],
      fresh: 0,
      submitted: 0,
      settled: 0,
      skipped: 0,
      budget: { day: localDay(now), used: 0, limit: dailyCalls(this.env) },
    };

    // 清掉无主的收件箱条目：源已经不在了，它当初的判断结果留在这里只会让人困惑。
    // removeFeed 自己就会连带删，这里兜的是那条规则生效之前留下的幽灵，
    // 以及任何其它让 feedId 对不上的情况（比如手工改库）。
    const live = new Set(feeds.map((f) => f.id));
    const inbox = await this.ctx.storage.list<InboxItem>({ prefix: "inbox:" });
    const ghosts = [...inbox.entries()]
      .filter(([, item]) => !live.has(item.feedId))
      .map(([key]) => key);
    if (ghosts.length) {
      await this.ctx.storage.delete(ghosts);
      report.pruned = ghosts.length;
    }

    // 1. 结算上一批
    const settled = await this.settle();
    report.settled = settled.settled;
    report.skipped = settled.skipped;

    // 2. 今日预算
    const day = localDay(now);
    const used = (await this.ctx.storage.get<number>(`budget:${day}`)) ?? 0;
    report.budget.used = used;

    if (!feeds.length) {
      report.note = "还没有配任何源。POST /feeds 加一个。";
      return report;
    }
    if (!this.setup.ready) {
      report.note = "模型没配好，这一轮只拉源不提交，免得白排队。";
      return report;
    }

    const limit = dailyCalls(this.env);
    let quota = Math.min(Math.max(limit - used, 0), MAX_PER_RUN);
    if (quota === 0) {
      report.note =
        used >= limit
          ? `今天的 ${limit} 次已经用完，剩下的等明天。`
          : `这一轮的上限 ${MAX_PER_RUN} 次在别处用完了。`;
      return report;
    }

    // 3. 拉源。分小批并行：Workers 单次唤醒最多 6 个出站连接，留两个余量。
    const results: { feed: Feed; items: FeedItem[] }[] = [];
    for (let i = 0; i < feeds.length; i += 4) {
      const batch = feeds.slice(i, i + 4);
      const done = await Promise.all(
        batch.map(async (feed) => ({ feed, result: await fetchFeed(feed.url) })),
      );
      for (const { feed, result } of done) {
        if (result.ok) results.push({ feed, items: result.items });
        else report.failed.push({ feed: feed.label, error: result.error });
      }
    }

    // 4. 只提交真正新的，且只提交预算内的
    for (const { feed, items } of results) {
      const seenRaw = await this.ctx.storage.get<string[]>(`seen:${feed.id}`);
      // 没有 seen 记录 = 这个源从没接过基线。这一轮只记不发。
      //
      // 不这么做的话，一个每天更新 20 条的源在第一次 ingest 时会被当成
      // 「全是新的」—— 收件箱瞬间被历史条目淹没，当天预算一把烧完，
      // 而用户还没看到任何一条有用的。addFeed 里有同样的处理，区别只在于
      // 那边是用户亲手加的、可以立刻联网抓一次；这边是默认源，只能等这一轮。
      if (seenRaw === undefined) {
        await this.ctx.storage.put(
          `seen:${feed.id}`,
          items.map((i) => i.id).slice(0, SEEN_LIMIT),
        );
        report.baselined = (report.baselined ?? 0) + 1;
        continue;
      }

      const seen = new Set(seenRaw);
      const fresh = items.filter((item) => !seen.has(item.id));
      report.fresh += fresh.length;
      if (!fresh.length) continue;

      // 粗筛：一个关注词都没命中的，连模型都不喂。
      //
      // 挡掉的条目记进 seen —— 标题不会变，下一轮重新筛一遍纯属浪费。
      // 但**不写收件箱**：那不是判断结论，是规则结论，而规则是可复算的
      // （同样的标题 + 同样的词表，谁跑都是同一个结果）。给个计数加样本
      // 就够核对筛得对不对；逐条留痕反而会把真正需要人看一眼的模型判断
      // 挤出 INBOX_LIMIT。
      const words = feed.prefilter ?? [];
      let passing = fresh;
      if (words.length) {
        passing = [];
        for (const item of fresh) {
          if (prefilterHits(words, item).length) {
            passing.push(item);
            continue;
          }
          report.prefiltered = (report.prefiltered ?? 0) + 1;
          report.prefilteredSample = [
            ...(report.prefilteredSample ?? []),
            { feed: feed.label, title: item.title },
          ].slice(-5);
          await this.recordSubmit(feed, item);
        }
        if (!passing.length) continue;
      }

      // 从旧到新提交，这样收件箱里的顺序和真实时间一致。
      for (const item of passing.reverse()) {
        if (quota <= 0) break;

        const taskId = this.taskIdOf(feed, item);
        const receipt = await this.submitText(promptFor(feed, item), taskId);
        // 提交失败（模型没配好）时不要把 id 记进 seen：留着它，下一轮还有机会。
        if (!receipt) continue;

        // 冲突 = 这个 taskId 之前用另一段 prompt 提交过（改过 want 文案就会这样）。
        // 这不是错误，是「已经做过」：记进 seen 让下一轮别再试，但不动收件箱里的那条，
        // 也不扣预算 —— 这次一次模型都没调。
        if (receipt.conflict) {
          await this.recordSubmit(feed, item);
          continue;
        }

        quota--;
        report.submitted++;
        await this.recordSubmit(feed, item);
        await this.ctx.storage.put<InboxItem>(`inbox:${taskId}`, {
          id: taskId,
          feedId: feed.id,
          feed: feed.label,
          title: item.title,
          link: item.link,
          at: Date.now(),
          session: receipt.session,
          state: "pending",
        });
      }
    }

    if (report.baselined) {
      report.note = `${report.baselined} 个源是第一次接上，这一轮只记基线、一条都不提交。从下一轮起，新出现的才会进收件箱。`;
    } else if (report.fresh > report.submitted) {
      report.note = `发现 ${report.fresh} 条新的，这一轮只处理了 ${report.submitted} 条，剩下的下一轮继续。`;
    }

    report.budget.used = used + report.submitted;
    if (report.submitted) {
      await this.ctx.storage.put(`budget:${day}`, report.budget.used);
      await this.pruneBudgets(day);
    }

    return report;
  }

  /**
   * 把已经跑完的任务搬进收件箱。
   *
   * 判据和 `op()` 一样：先问 pending，不在 pending 里就说明 pi 结算过了，
   * 这时 wait 立刻返回。**先 pending 再 wait** 是硬要求 —— 反过来会把这次 ingest
   * 挂在一个没跑完的任务上，而 onJob 有 90 秒的预算。
   */
  private async settle(): Promise<{ settled: number; skipped: number }> {
    const entries = await this.ctx.storage.list<InboxItem>({ prefix: "inbox:" });
    const open = [...entries.entries()].filter(([, item]) => item.state === "pending");
    if (!open.length) return { settled: 0, skipped: 0 };

    const bySession = new Map<string, [string, InboxItem][]>();
    for (const [key, item] of open) {
      const batch = bySession.get(item.session) ?? [];
      batch.push([key, item]);
      bySession.set(item.session, batch);
    }

    let settled = 0;
    let skipped = 0;

    for (const [session, batch] of bySession) {
      const pendingIds = new Set((await this.harness.pending({ session })).map((p) => p.operationId));

      for (const [key, item] of batch) {
        if (pendingIds.has(item.id)) continue;

        let note = "";
        try {
          const result = await this.harness.wait(item.id, { session });
          note = result.text?.trim() ?? "";
        } catch (error) {
          note = error instanceof Error ? error.message : String(error);
        }

        settled++;
        // 和 /op 共用同一个时间戳：谁先看到结算谁盖，后看到的沿用。
        const opNote = await this.ctx.storage.get<Note>(`op:${item.id}`);
        if (opNote && !opNote.endedAt) {
          await this.ctx.storage.put<Note>(`op:${item.id}`, { ...opNote, endedAt: Date.now() });
        }
        if (!note) {
          await this.ctx.storage.put<InboxItem>(key, { ...item, state: "failed", note: "任务没留下任何输出。" });
          continue;
        }
        if (isSkip(note)) {
          // 跳过要留痕，不能删。
          //
          // 第一版是直接删掉的，结果出过一次事：模型把一条明明相关的内容判成 SKIP，
          // 而因为记录被删了，我看到的只是「收件箱是空的」，完全无法分辨
          // 它是「今天真的没新东西」还是「它判断错了」。**看不见的跳过等于没有发生过**，
          // 用户也就永远没机会把 `want` 调对。
          await this.ctx.storage.put<InboxItem>(key, { ...item, state: "skipped", note });
          skipped++;
          continue;
        }
        await this.ctx.storage.put<InboxItem>(key, { ...item, state: "ready", note });
      }
    }

    await this.pruneInbox();
    return { settled, skipped };
  }

  /**
   * 收件箱有上限。
   *
   * 跳过的记录比命中的多得多，不清理的话它会成为增长最快的那一部分存储。
   * 先删「已跳过的旧记录」，再删「已读的旧记录」，最后才动没读的。
   */
  private async pruneInbox(): Promise<void> {
    const entries = await this.ctx.storage.list<InboxItem>({ prefix: "inbox:" });
    if (entries.size <= INBOX_LIMIT) return;

    const order: Record<InboxItem["state"], number> = { skipped: 0, failed: 1, ready: 2, pending: 3 };
    const sorted = [...entries.entries()].sort(([, a], [, b]) => {
      const byState = order[a.state] - order[b.state];
      return byState !== 0 ? byState : a.at - b.at;
    });

    let excess = entries.size - INBOX_LIMIT;
    for (const [key] of sorted) {
      if (excess <= 0) break;
      await this.ctx.storage.delete(key);
      excess--;
    }
  }

  /** 任务 id。同一个源的同一条内容，无论拉几次都是同一个 id。 */
  private taskIdOf(feed: Feed, item: FeedItem): string {
    return `feed-${feed.id}-${item.id}`;
  }

  /**
   * 提交一条预置任务，并把它的 id 记进 seen。
   *
   * 记 seen 的时机很重要：**提交成功才记**。提前记的话，一次提交失败就等于那条内容
   * 永远丢了；而晚记（等结算完再记）会让下一轮把同一条再提交一次。
   */
  private async recordSubmit(feed: Feed, item: FeedItem): Promise<void> {
    const seen = (await this.ctx.storage.get<string[]>(`seen:${feed.id}`)) ?? [];
    const next = [...seen, item.id].slice(-SEEN_LIMIT);
    await this.ctx.storage.put(`seen:${feed.id}`, next);
  }

  /** 预算键按天存，只留今天和昨天，别让它无限长。 */
  private async pruneBudgets(keep: string): Promise<void> {
    const all = await this.ctx.storage.list<number>({ prefix: "budget:" });
    for (const key of all.keys()) {
      if (key !== `budget:${keep}`) await this.ctx.storage.delete(key);
    }
  }

  private async readFeeds(): Promise<Feed[]> {
    return (await this.ctx.storage.get<Feed[]>("cfg:feeds")) ?? [];
  }

  private async listFeeds(): Promise<Response> {
    const feeds = await this.readFeeds();
    const report = await this.ctx.storage.get<IngestReport>("ingest:last");
    return Response.json({
      feeds,
      next: this.lifecycle.jobs.get(INGEST)?.time ?? null,
      last: report ?? null,
    });
  }

  /**
   * 加一个源。
   *
   * **接入的那一刻不做任何判断，只把现有条目全部记为「已见过」。**
   * 这一条是整个功能里最容易被忽略、但最影响体验的：一个每天更新 20 条的源，
   * 如果按「全是新的」处理，用户刚填完 URL 就会被 20 篇文章淹没，当天的预算
   * 一次烧完，而他还没看到任何一条有用的。
   *
   * 基线之后才开始工作，它第一次开口就是真的新东西。
   */
  private async addFeed(request: Request): Promise<Response> {
    const body = await request.json<{
      url?: string;
      label?: string;
      want?: string;
      prefilter?: string[] | string;
    }>();
    const url = body.url?.trim();
    if (!url) return Response.json({ error: "url is required" }, { status: 400 });

    const want = body.want?.trim() || "任何值得我知道的新内容";
    const prefilter = parseWords(body.prefilter);
    const feeds = await this.readFeeds();
    if (feeds.some((f) => f.url === url)) {
      return Response.json({ error: "这个地址已经加过了" }, { status: 409 });
    }
    if (feeds.length >= 12) {
      return Response.json({ error: "最多 12 个源。多到这个数已经不是「挑」了。" }, { status: 400 });
    }

    const probe = await fetchFeed(url);
    if (!probe.ok) return Response.json({ error: probe.error }, { status: 400 });

    const feed: Feed = {
      id: hashId(url),
      url,
      label: body.label?.trim() || probe.title,
      want,
      ...(prefilter.length ? { prefilter } : {}),
      addedAt: Date.now(),
    };

    await this.ctx.storage.put("cfg:feeds", [...feeds, feed]);
    // 基线：现有条目全部记为见过，一条都不提交。
    const baseline = probe.items.map((i) => i.id).slice(0, SEEN_LIMIT);
    await this.ctx.storage.put(`seen:${feed.id}`, baseline);

    return Response.json({
      feed,
      baseline: baseline.length,
      note: `已接入。现有 ${baseline.length} 条记为基线，之后有新的才会通知你。`,
    });
  }

  /**
   * 调一个源。`want` 和 `prefilter` 都允许改，因为这两个都是要试错的东西：
   * 判得太宽还是太窄，只能靠看一段时间的跳过理由才知道，而那时源早就加完了。
   *
   * 改 `want` 不动已经判过的条目 —— 它们在 `seen:` 里，不会重判。
   * 这是有意的：想重判就把源删了重加，那会重接基线，代价可见。
   */
  private async updateFeed(request: Request): Promise<Response> {
    const body = await request.json<{
      id?: string;
      want?: string;
      prefilter?: string[] | string;
    }>();
    const id = body.id?.trim();
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });

    const feeds = await this.readFeeds();
    const index = feeds.findIndex((f) => f.id === id);
    if (index < 0) return Response.json({ error: "没有这个源" }, { status: 404 });

    const next: Feed = { ...feeds[index] };
    if (body.want !== undefined) next.want = body.want.trim() || next.want;
    if (body.prefilter !== undefined) {
      const words = parseWords(body.prefilter);
      // 传了空 = 明确关掉粗筛。不能当成「没填」而保留旧的，
      // 否则用户永远没法把筛子摘掉。
      if (words.length) next.prefilter = words;
      else delete next.prefilter;
    }

    feeds[index] = next;
    await this.ctx.storage.put("cfg:feeds", feeds);
    return Response.json({
      feed: next,
      note: next.prefilter?.length
        ? `粗筛 ${next.prefilter.length} 个词。下一轮起生效，已经见过的条目不会重判。`
        : "这个源没有粗筛，每条新内容都会问一次模型。",
    });
  }

  private async removeFeed(request: Request): Promise<Response> {
    const body = await request.json<{ id?: string }>();
    const id = body.id?.trim();
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });

    const feeds = await this.readFeeds();
    const next = feeds.filter((f) => f.id !== id);
    if (next.length === feeds.length) return Response.json({ error: "没有这个源" }, { status: 404 });

    await this.ctx.storage.put("cfg:feeds", next);
    await this.ctx.storage.delete(`seen:${id}`);

    // 连带清掉它产出的条目。
    //
    // 不清的话页面上会留下一行「源名」，点进去是它当时判断过的东西，而这个源
    // 已经不在列表里 —— 你没法从界面判断它是哪来的，也没法把它加回来对账。
    // 「删掉一个源」在用户心里是「这块我不要了」，不是「先藏起来」。
    //
    // 代价：连它产出的、你已经标为读过的条目一起没了。接受 —— 源都没了，
    // 留着那条历史也不能再长出新的来。
    const inbox = await this.ctx.storage.list<InboxItem>({ prefix: "inbox:" });
    const doomed = [...inbox.entries()]
      .filter(([, item]) => item.feedId === id)
      .map(([key]) => key);
    if (doomed.length) await this.ctx.storage.delete(doomed);

    return Response.json({ ok: true, feeds: next.length, removedItems: doomed.length });
  }

  /**
   * 收件箱。默认只给「真的值得看」且没读过的。
   *
   * `?all=1` 会把跳过的、失败的、已读的全列出来 —— 这个视图不是给日常用的，
   * 是给人「核对它判断得对不对」用的。没有这个视图，`want` 就没法调。
   */
  private async listInbox(request: Request): Promise<Response> {
    const all = new URL(request.url).searchParams.get("all") === "1";
    const entries = await this.ctx.storage.list<InboxItem>({ prefix: "inbox:" });
    const everything = [...entries.values()];
    const items = everything
      .filter((i) => (all ? true : i.state === "ready" && !i.read))
      .sort((a, b) => b.at - a.at);

    return Response.json({
      unread: everything.filter((i) => i.state === "ready" && !i.read).length,
      skipped: everything.filter((i) => i.state === "skipped").length,
      items,
    });
  }

  private async markRead(request: Request): Promise<Response> {
    const body = await request.json<{ id?: string; all?: boolean }>();
    const entries = await this.ctx.storage.list<InboxItem>({ prefix: "inbox:" });

    if (body.all) {
      let n = 0;
      for (const [key, item] of entries) {
        if (item.read) continue;
        await this.ctx.storage.put<InboxItem>(key, { ...item, read: true });
        n++;
      }
      return Response.json({ marked: n });
    }

    const id = body.id?.trim();
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    for (const [key, item] of entries) {
      if (item.id !== id) continue;
      await this.ctx.storage.put<InboxItem>(key, { ...item, read: true });
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private async ingestReport(): Promise<Response> {
    const last = await this.ctx.storage.get<IngestReport>("ingest:last");
    const job = this.lifecycle.jobs.get(INGEST);
    const day = localDay();
    return Response.json({
      last: last ?? null,
      next: job ? job.time : null,
      budget: {
        day,
        used: (await this.ctx.storage.get<number>(`budget:${day}`)) ?? 0,
        limit: dailyCalls(this.env),
      },
    });
  }

  /** 手动触发一次，不必等 3 小时。它和 job 走的是同一个函数，不是另一条路径。 */
  private async ingestNow(): Promise<Response> {
    const report = await this.ingest();
    await this.ctx.storage.put("ingest:last", report);
    return Response.json(report);
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
    const receipt = await this.submitText(text, operationId);
    if (!receipt) {
      return Response.json({ error: "model_not_configured", hint: this.setup.hint }, { status: 503 });
    }
    if (receipt.conflict) {
      return Response.json(
        { error: "operation_id_reused", hint: receipt.conflict, session: receipt.session },
        { status: 409 },
      );
    }
    return Response.json({ ...receipt, at: Date.now() });
  }

  /**
   * 真正的提交。HTTP 的 `/submit` 和自动巡检的输入源都走这里 ——
   * 两条入口一条路径，否则「手动发的」和「它自己发现的」迟早会长出两套语义。
   *
   * 重投同一个 operationId 时不新建会话，回到原来那条时间线上。
   * DO 单线程，所以「查了没有 → 新建」之间不会插进另一个请求。
   */
  private async submitText(
    text: string,
    operationId: string,
  ): Promise<{
    operationId: string;
    session: string;
    accepted: boolean;
    /** 非空表示这个 id 之前配的是另一段文字，这次什么都没提交。 */
    conflict?: string;
  } | null> {
    if (!this.setup.ready) return null;

    const digest = await digestOf(text);
    const existing = await this.ctx.storage.get<Note>(`op:${operationId}`);
    if (existing) {
      // 同一个 id 必须对应同一段文字。
      //
      // 以前这里是直接把新文字塞进旧会话重投一次 —— pi 看到重复的 operationId
      // 会返回 accepted: false，于是**新文字被静默丢掉**，调用方只拿到一句
      // 「没被受理」。两个人（或一个页面手抖两次）用同一个 id 发不同的内容，
      // 其中一段话就这么消失了，而且没有任何地方能查出来。
      //
      // 现在摘要不同就报冲突，让调用方自己决定：换个 id 重发，还是去查原来那张。
      if (existing.digest && existing.digest !== digest) {
        return {
          operationId,
          session: existing.session,
          accepted: false,
          conflict:
            "这个 operationId 之前提交过另一段内容。新内容没有被提交（避免两段话混进同一条回执）。换个 id 重发，或用 /op 查原来那张回执。",
        };
      }
      if (!existing.digest) {
        // 旧回执没有摘要，无从比较，按「一样」处理并补上，下次就能比了。
        await this.ctx.storage.put<Note>(`op:${operationId}`, { ...existing, digest });
      }
      const receipt = await this.harness.submit(text, { operationId, session: existing.session });
      return { operationId, session: existing.session, accepted: receipt.accepted };
    }

    const session = await this.harness.sessions.create();
    const receipt = await this.harness.submit(text, { operationId, session: session.id });
    await this.ctx.storage.put<Note>(`op:${operationId}`, {
      id: operationId,
      text,
      at: Date.now(),
      session: session.id,
      digest,
    });

    return { operationId, session: session.id, accepted: receipt.accepted };
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
    // 两个分支必须给同样的字段。少了 session，调用方在任务跑着的时候拿不到
    // 「它落在哪条时间线上」，而这个信息在提交的回执里本来就有。
    if (live) return Response.json({ operationId: id, session, status: live.status, live: true });

    const result = await this.harness.wait(id, { session });
    // 结算时间只盖一次。这条路径和 settle() 都会走到，谁先看到谁盖。
    const endedAt = note.endedAt ?? Date.now();
    if (!note.endedAt) await this.ctx.storage.put<Note>(`op:${id}`, { ...note, endedAt });
    return Response.json({ ...result, at: note.at, endedAt, elapsedMs: endedAt - note.at });
  }

  /**
   * 算一次用量。默认读缓存，`fresh` 强制重算。
   *
   * pi 的 `usage()` 把每条会话里各模型的用量加起来，只增不减，所以它答的是
   * 「一共花了多少」，答不了「今天花了多少」—— 按天拆分需要每天存一份快照做差，
   * 那件事等真有账单上的需要再说，现在宁可少说，也不编一个「今日 token」。
   */
  private async spend(fresh = false): Promise<Spend> {
    const cached = await this.ctx.storage.get<Spend>("spend:cache");
    // 老缓存没有 costKind，当成失效 —— 它来自加这个字段之前的那一版。
    if (!fresh && cached?.costKind && Date.now() - cached.at < SPEND_CACHE_MS) return cached;

    const empty: Spend = {
      at: Date.now(),
      tokens: 0,
      cost: 0,
      costKind: "estimate",
      models: [],
      tools: [],
    };
    let state;
    try {
      state = await (await this.harness.pi()).usage(BACKGROUND_CONTEXT);
    } catch (error) {
      // 算不出来就说算不出来。返回 0 会被读成「没花过钱」，那是假话。
      const why = error instanceof Error ? error.message : String(error);
      const failed: Spend = { ...empty, error: why };
      await this.ctx.storage.put("spend:cache", failed);
      return failed;
    }

    const total = { tokens: 0, cost: 0 };
    const models: SpendBucket[] = [];
    for (const [name, usage] of Object.entries(state.models ?? {})) {
      const t = tally(usage);
      total.tokens += t.tokens;
      total.cost += t.cost;
      models.push({ name, ...t });
    }
    const tools: SpendBucket[] = [];
    for (const [name, usage] of Object.entries(state.tools ?? {})) {
      const t = tally(usage);
      total.tokens += t.tokens;
      total.cost += t.cost;
      tools.push({ name, ...t });
    }

    const spend: Spend = {
      at: empty.at,
      tokens: total.tokens,
      cost: total.cost,
      costKind: "estimate",
      // 大的排前面：一眼看到的是花得最多的那个模型，而不是字母序第一个。
      models: models.sort((a, b) => b.tokens - a.tokens),
      tools: tools.sort((a, b) => b.tokens - a.tokens),
    };
    await this.ctx.storage.put("spend:cache", spend);
    return spend;
  }

  private async status(fresh = false): Promise<Response> {
    const sessions = await this.harness.sessions.list();
    const feeds = await this.readFeeds();
    const inbox = await this.ctx.storage.list<InboxItem>({ prefix: "inbox:" });
    const day = localDay();
    const spend = await this.spend(fresh);

    // 今天一共提交了几条。`budget:${day}` 只数自动提交（输入源），
    // 而页面上那个输入框发的消息从不进这个数 —— 于是「今天用了 3/20 次」
    // 会漏掉你自己发的那些，读起来像在说总账。这里把两者分开，
    // 总数从回执记录数出来，自动数从预算记录取，差就是手动。
    const notes = await this.ctx.storage.list<Note>({ prefix: "op:" });
    const today = [...notes.values()].filter((n) => localDay(n.at) === day).length;
    const auto = (await this.ctx.storage.get<number>(`budget:${day}`)) ?? 0;

    return Response.json({
      model: this.setup.label,
      ready: this.setup.ready,
      sessions: sessions.length,
      feeds: feeds.length,
      inbox: {
        unread: [...inbox.values()].filter((i) => !i.read && i.state === "ready").length,
        pending: [...inbox.values()].filter((i) => i.state === "pending").length,
      },
      budget: {
        day,
        /** 自动提交（输入源）用掉的，这个数才有上限。 */
        used: auto,
        limit: dailyCalls(this.env),
        /** 你今天自己发的。不受上限拦，但也别假装它不存在。 */
        manual: Math.max(today - auto, 0),
        total: today,
      },
      spend: {
        /** 说明口径：这是累计，不是今天。字段名写在这里，是为了让调用方不用猜。 */
        scope: "lifetime" as const,
        at: spend.at,
        tokens: spend.tokens,
        cost: spend.cost,
        costKind: spend.costKind,
        models: spend.models,
        tools: spend.tools,
        ...(spend.error ? { error: spend.error } : {}),
      },
      ...(this.setup.hint ? { hint: this.setup.hint } : {}),
    });
  }
}
