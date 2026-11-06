/**
 * 输入源：RSS / Atom。
 *
 * 这个文件只做四件不花钱的事：拉一个源、解析出条目、算条目的稳定 id、
 * 把一条条目组装成一次任务。它不调模型，也不知道模型存在。
 *
 * 为什么是 RSS 而不是邮件：邮件要 IMAP 凭据，fork 的人要先去邮箱开应用专用密码，
 * 一半人到这里就放弃了。RSS 只是一行 URL。**门槛决定了别人会不会真的用起来**，
 * 而不只是决定他能不能用。
 */

/** 一个源。`want` 是这个源专属的关注点，一句话。 */
export type Feed = {
  id: string;
  url: string;
  label: string;
  /** 我要什么。它决定了这条内容值不值得进收件箱。 */
  want: string;
  /**
   * 抓取层的粗筛：标题或摘要里至少要命中一个词，否则连模型都不喂。
   *
   * 它和 `want` 是两层，不能合并：`want` 是给模型的一句话判断标准，
   * 粗筛是「这种标题根本不用问」。空或省略 = 不筛，全部交给模型。
   *
   * 为什么不筛更省事：泛技术源（比如 HN 首页）一天几十条，命中率不到三成，
   * 而每天能调模型的次数是固定的。筛掉噪音等于把额度还给了真正的内容。
   */
  prefilter?: string[];
  addedAt: number;
};

/** 一条被解析出来的条目。id 必须是稳定的，否则每天都会重复推送同一篇。 */
export type FeedItem = {
  id: string;
  title: string;
  link: string;
  /** 源自带的摘要或正文，可能为空，也可能是一大段 HTML。 */
  summary: string;
  publishedAt?: number;
};

export type FetchResult =
  | { ok: true; title: string; items: FeedItem[] }
  | { ok: false; error: string };

/**
 * 判断一条内容值不值得花一次模型调用，在调用之前先问一遍。
 *
 * 挑选标准是「这个词出现，说明这条**可能**有关」，不是「必须出现」。
 * 故意选得偏宽，因为两边代价不对称：放进来一条无关的，多花一次调用；
 * 挡掉一条有关的，这条内容从此消失，而且用户不知道自己错过了什么。
 *
 * 实测背景：HN 首页一天十几条，命中率不到三成，而每天的调用次数是固定的一笔。
 * 筛掉噪音不是省钱，是把额度还给真正的内容 —— 额度用完之后它就不干活了。
 */
export const PREFILTER_AGENT: string[] = [
  // agent 运行时与持久执行
  "agent", "agents", "agentic", "llm", "llms", "harness", "orchestration",
  "durable", "workflow", "idempotent", "retry", "checkpoint",
  // 模型与推理
  "ai", "gpt", "claude", "gemini", "llama", "deepseek", "mistral", "openai",
  "anthropic", "model", "models", "inference", "embedding", "rag", "prompt",
  "token", "context window", "mcp",
  // 运行时、存储、消息
  "worker", "workers", "cloudflare", "serverless", "container", "sqlite",
  "postgres", "database", "storage", "queue", "kafka", "redis", "crdt",
  // 可观测与工程
  "observability", "tracing", "telemetry", "benchmark", "eval",
  "compiler", "debugger", "profiler", "lsp",
  // 中文
  "智能体", "大模型", "模型", "上下文", "持久", "数据库", "队列", "重试", "幂等", "可观测",
];

/**
 * 跑一次粗筛，返回命中的那些词。空数组 = 一个都没命中 = 该挡。
 *
 * ASCII 词按整词边界匹配，不用 `includes` —— 两字母的词（`ai`、`db`）用子串
 * 会命中 `said`、`main`、`explain`，筛子立刻变成摆设。中文没有空格，
 * 只能按子串，这也是它放在词表后半段的原因：中文源本来就不多。
 */
export function prefilterHits(words: string[], item: FeedItem): string[] {
  // 三段一起看，因为不同源给的信号在不同位置：
  //   - 博客类源的 summary 是正文摘要，信息最多；
  //   - HN 这类源的 summary 只有「Article URL / Points」这种元数据，一个字正文都没有，
  //     真正的线索在标题和链接里。
  //
  // 摘要只取开头一段：RSS 常把整篇正文塞进来，全部扫一遍没意义。
  const text = `${item.title}\n${item.link}\n${item.summary.slice(0, 400)}`.toLowerCase();
  const hits: string[] = [];
  for (const raw of words) {
    const word = raw.trim().toLowerCase();
    if (!word) continue;
    if (/^[\x20-\x7e]+$/.test(word)) {
      // 词边界匹配，不是 `includes`：`ai` 用子串会命中 `said`、`main`、`explain`，
      // 一个两字母的词能把筛子变成摆设。带上边界之后，`-ai-`、`.ai/` 这类
      // 链接里的写法照样认得出来，而字母黏着的情况一个都不会误撞。
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text)) hits.push(raw);
    } else if (text.includes(word)) {
      // 中文没有空格，只能按子串。
      hits.push(raw);
    }
  }
  return hits;
}

/** 单次拉取上限：一个源一次最多读 1MB。 */
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 12_000;
/** 一个源最多看最近多少条。源里塞几百条历史的情况很常见。 */
const MAX_ITEMS = 30;
/** 喂给模型的摘要上限。整篇正文没有必要，重点是判断「值不值得我读」。 */
const SUMMARY_CHARS = 1200;

export async function fetchFeed(url: string): Promise<FetchResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, error: `不是合法的网址：${url}` };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, error: `只支持 http/https，收到的是 ${target.protocol}` };
  }

  let response: Response;
  try {
    response = await fetch(target.toString(), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; memex/0.1; +https://github.com/kbkb628/memex) feed",
        accept: "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const err = error as { name?: string; message?: string };
    const timedOut = err?.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? `拉取超时（${TIMEOUT_MS / 1000} 秒）。这个源可能很慢，或者在当前网络下不可达。`
        : `拿不到响应（${[err?.name, err?.message].filter(Boolean).join(": ")}）。`,
    };
  }

  if (!response.ok) {
    return { ok: false, error: `对方返回 ${response.status} ${response.statusText}。` };
  }

  const bytes = await readCapped(response);
  if (!bytes.length) return { ok: false, error: "响应体是空的。" };

  const xml = decodeFeed(bytes, response.headers.get("content-type") ?? "");
  const items = parseFeed(xml, target);
  if (!items.length) {
    // 这是最需要说清楚的一种失败：拿到了 200，但里面没有条目。
    // 可能是因为它是一张网页而不是订阅源，也可能是它今天确实没更新。
    return {
      ok: false,
      error: `拿到了 ${bytes.length} 字节，但里面解析不出任何条目。可能这个地址返回的是网页而不是 RSS/Atom。`,
    };
  }

  return { ok: true, title: channelTitle(xml) ?? target.hostname, items };
}

/**
 * 解析 RSS 2.0 与 Atom。
 *
 * 不引 XML 解析器：DO 的内存和 CPU 有限，而这个解析只需要拿到「块」和「块里的几个字段」。
 * 代价是它不认识任意合法的 XML，只认识真实的订阅源长什么样——这在取舍上是划算的，
 * 因为真实订阅源的形态极其收敛。
 */
export function parseFeed(xml: string, base: URL): FeedItem[] {
  const blocks = matchBlocks(xml);
  const items: FeedItem[] = [];

  for (const block of blocks) {
    const title = textOf(block, "title");
    // RSS: <link>https://…</link>；Atom: <link href="https://…"/>
    const link = textOf(block, "link") ?? attrOf(block, "link", "href") ?? "";
    const guid = textOf(block, "guid") ?? textOf(block, "id") ?? "";
    const summary = textOf(block, "description") ?? textOf(block, "summary") ?? textOf(block, "content") ?? "";
    const published = textOf(block, "pubDate") ?? textOf(block, "published") ?? textOf(block, "updated");

    if (!title && !link) continue;

    const absolute = absolutize(link, base);
    // 稳定 id 的优先级：guid → 链接 → 标题+时间。
    // guid 偶尔是随机串但跨请求稳定，仍然比链接好；标题+时间是最后的兜底。
    const key = guid || absolute || `${title}|${published ?? ""}`;

    items.push({
      id: hash(key),
      title: clean(title ?? "(无标题)"),
      link: absolute,
      summary: clean(summary).slice(0, SUMMARY_CHARS),
      ...(published ? { publishedAt: Date.parse(published) || undefined } : {}),
    });
  }

  // 新→旧。源自己的顺序不可靠，有 pubDate 就按它排，没有就保持原序。
  if (items.some((i) => i.publishedAt)) {
    items.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  }
  return items.slice(0, MAX_ITEMS);
}

/**
 * 找出所有 `<item>` 或 `<entry>` 块。
 *
 * 取更长的那个：有些源同时给 `<item>` 和 `<entry>`，长度差别很大；用长度判断
 * 哪一种才是主结构，比按 tag 名硬选可靠。
 */
function matchBlocks(xml: string): string[] {
  const pick = (tag: string) => {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
    const out: string[] = [];
    for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
    return out;
  };
  const rss = pick("item");
  const atom = pick("entry");
  return atom.join("").length > rss.join("").length ? atom : rss;
}

function channelTitle(xml: string): string | undefined {
  // 只看第一个 <channel> 里的 <title>，避免抓到某条 item 的标题。
  const channel = xml.match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i)?.[1] ?? xml;
  return textOf(channel, "title") ?? undefined;
}

/** 取一个标签的文本内容，剥掉 CDATA 与嵌套标签。 */
function textOf(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const raw = xml.match(re)?.[1];
  if (raw === undefined) return undefined;
  const text = raw
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/g, "$1")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return text.trim() || undefined;
}

function attrOf(xml: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["']`, "i");
  return xml.match(re)?.[1];
}

/** 去掉标签、解实体、压空白。RSS 的 description 常常是一整段 HTML。 */
function clean(input: string): string {
  return input
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, decodeEntity)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

function decodeEntity(_m: string, entity: string): string {
  if (entity[0] === "#") {
    const code =
      entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return " ";
      }
    }
    return " ";
  }
  return NAMED[entity.toLowerCase()] ?? " ";
}

function absolutize(link: string, base: URL): string {
  if (!link) return "";
  try {
    return new URL(link, base).toString();
  } catch {
    return link;
  }
}

/**
 * 稳定 id。
 *
 * FNV-1a 转 36 进制，12 位。碰撞概率对「同一个源里几千条以内」可以忽略，
 * 而它的价值是：同一个 guid 无论拉多少次都得到同一个字符串，所以
 * 「这条我已经处理过」这件事可以只靠比较字符串判定，不用调模型。
 */
export function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 订阅源给的编码不一定是 utf-8，虽然绝大多数是。 */
function decodeFeed(bytes: Uint8Array, contentType: string): string {
  const declared = contentType.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1];
  if (declared) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // 认不出来的编码交给下一档。
    }
  }
  const head = new TextDecoder("iso-8859-1").decode(bytes.slice(0, 200));
  const fromDecl = head.match(/encoding\s*=\s*["']([\w-]+)["']/i)?.[1];
  if (fromDecl) {
    try {
      return new TextDecoder(fromDecl).decode(bytes);
    } catch {
      // 同上。
    }
  }
  return new TextDecoder().decode(bytes);
}

async function readCapped(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.length > MAX_BYTES) {
        chunks.push(value.slice(0, MAX_BYTES - total));
        total = MAX_BYTES;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 把一条条目组装成一次任务。
 *
 * 这里是整个输入源功能的产品定义所在。它不问「这篇讲了什么」（那是 RSS 阅读器），
 * 它问的是「这条值不值得进我的收件箱」。
 *
 * 措辞踩过一次坑，值得留在代码里：第一版写的是「判断这条内容是否命中关注点」，
 * 而用户的关注点写起来天然像一串名词（"持久执行、Durable Objects、数据库一致性"）。
 * 结果模型严格按名词匹配，把「为什么你的定时任务会悄悄死掉」判成 SKIP ——
 * 理由是「摘要里没有出现持久执行/事务性/一致性模型」。字面上它没错，但我确实想知道那篇文章。
 *
 * 所以判断标准要写成「内容实质」而不是「有没有出现我提到的词」，兜底方向也要反过来：
 * **拿不准就报**。多一条只是多扫一眼，漏掉的那条永远不会浮出来。
 */
export function promptFor(feed: Feed, item: FeedItem): string {
  const lines = [
    "【自动巡检 · 不需要回复我的提问，直接按要求输出】",
    "",
    `来源：${feed.label}`,
    `标题：${item.title}`,
    item.link ? `链接：${item.link}` : "",
    item.summary ? `摘要：${item.summary}` : "摘要：（这个源没给摘要，只能看标题和链接）",
    "",
    `我想知道的是：${feed.want}`,
    "",
    "判断这条值不值得进我的收件箱。标准是内容实质，不是有没有出现我提到的词：",
    "- 有关：用两三句话说清楚它讲了什么、为什么值得我看。不要客套，不要复述标题。",
    "- 无关，或者读不到正文且摘要不足以判断：第一行只写 SKIP，第二行附一句原因。",
    "拿不准就报。我宁可多扫一条，也不想错过那条真正有用的。",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/** 模型说跳过。只认第一行，容忍前后空格 —— 附带的解释不影响判定。 */
export function isSkip(text: string): boolean {
  const first = text.trim().split("\n")[0] ?? "";
  return /^skip\b/i.test(first.trim());
}

/** 每个源记住最近多少条已处理的条目。 */
export const SEEN_LIMIT = 300;

/**
 * 新实例默认带的三个源。
 *
 * 为什么要有默认值：空收件箱说明不了任何事。第一次打开看到「还没有配任何源」的人，
 * 不会去读 README 再回来填三个地址 —— 他直接关了。默认值不是替他做决定，
 * 是让他第一眼就能看到「它自己醒来判断过」这件事真的发生了。
 *
 * `want` 写的是「什么算值得看」，不是关键词。关键词会让模型按字面匹配，
 * 而好内容往往不用那个词（见 docs/decisions/008）。
 *
 * 想换成自己的：删掉它们再加。`cfg:feeds` 一旦存在（哪怕是空数组）就不会再补。
 */
export const DEFAULT_FEEDS: { url: string; label: string; want: string; prefilter?: string[] }[] = [
  {
    url: "https://blog.cloudflare.com/rss/",
    label: "Cloudflare 博客",
    want: "Cloudflare 自己的工程实践：新的运行时能力、Durable Objects / Workers 的真实限制和坑、他们踩过的架构问题。不要产品发布、市场活动、客户案例宣传。",
  },
  {
    url: "https://hnrss.org/frontpage",
    label: "HN 首页",
    // 这个源必须配粗筛：它是「所有技术话题」的首页，不是「agent 话题」的首页。
    // 不筛的话，一天二十几条里大半是内核补丁、复古硬件、公司新闻，
    // 全都要花一次调用才能判掉，额度在下午就用完了。
    prefilter: PREFILTER_AGENT,
    want: "有人真的做出东西、并且讨论得很具体的条目：新的开源项目、工程踩坑记录、架构复盘。不要融资新闻，不要政治和社会话题，不要「XX 要死了」式的感慨。",
  },
  {
    url: "https://www.ruanyifeng.com/blog/atom.xml",
    label: "阮一峰的网络日志",
    want: "周刊里提到的具体工具和文章，以及作者对技术趋势的判断。不要纯链接合集，不要工具清单式的罗列。",
  },
];

/** 收件箱里最多留多少条，超了删最旧的。 */
export const INBOX_LIMIT = 200;

/**
 * 「今天」是哪一天。
 *
 * 预算按天封顶，而「一天」对用户是本地概念。Workers 的时钟是 UTC，
 * 所以这里显式加一个偏移。它是个常量而不是配置项：一个人用的东西，
 * 改一行比加一个设置页便宜。
 */
const TZ_OFFSET_HOURS = 8;

export function localDay(now = Date.now()): string {
  const shifted = new Date(now + TZ_OFFSET_HOURS * 3600_000);
  return shifted.toISOString().slice(0, 10);
}
