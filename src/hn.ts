/**
 * HN 讨论页从边缘读不到，但同一份内容有官方 JSON 接口。
 *
 * 为什么需要这个文件：`fetch_url` 抓 `news.ycombinator.com/item?id=…` 稳定 419。
 * 不是偶发 —— 11-13 那批 11 条跳过里，「材料不足」6 条，其中 5 条的理由里写着
 * 「HN 讨论页返回 419」。判定那边写着「读不到所以材料不足」，而读不到的原因
 * 从来不是那个页面没有内容，是这面墙。
 *
 * 而墙只在 HTML 上。Algolia 的 items 接口返回同一棵评论树，纯 JSON，我们本来
 * 就在用它的搜索接口取源，不存在新的依赖。所以这不是「加一个数据源」，
 * 是把一次注定失败的抓取换成一个已经通了十天的调用。
 *
 * 摊平而不是原样塞 JSON：一个 133 条的帖子原始 JSON 是 82KB，里面一半字节
 * 是 `created_at_i`、`parent_id`、`options` 这类模型用不上的字段。模型读得懂
 * 缩进，读不懂 `"points": 96` 夹在三个空数组之间。
 */

/** 一次最多展开多少条评论。133 条的帖子里，前 60 条足够判断「这条讨论有没有干货」。 */
const MAX_COMMENTS = 60;
/** 单条评论的字符上限。有人的回复是一整篇长文，一条就能吃掉整个上下文。 */
const PER_COMMENT = 1_200;
/** 缩进到第 10 层就停：HN 的树实测最深 8 层，再深是引用链，缩进比内容还长。 */
const MAX_DEPTH = 10;

export type HnNode = {
  id?: number;
  author?: string | null;
  created_at?: string | null;
  text?: string | null;
  title?: string | null;
  url?: string | null;
  points?: number | null;
  type?: string | null;
  children?: HnNode[];
};

export type Thread = {
  /** 摊平后的正文，含标题块。 */
  text: string;
  /** 实际展开了多少条评论。 */
  shown: number;
  /** 树里一共有多少条。 */
  total: number;
};

/**
 * 认出 HN 讨论页，取出条目 id。
 *
 * 只认 `news.ycombinator.com/item?id=N` 这一种形状。`/item?id=` 之外还有
 * `/user?id=`、`/from?site=`，它们没有评论树可读，硬改写只会得到 404 ——
 * 所以宁可只认一条，认不出来就走原来的直连（然后照常 419，照常留痕）。
 */
export function hnItemId(url: URL): number | undefined {
  const host = url.hostname.toLowerCase();
  if (host !== "news.ycombinator.com" && host !== "hn.ycombinator.com") return undefined;
  if (url.pathname !== "/item" && url.pathname !== "/item/") return undefined;

  const raw = url.searchParams.get("id") ?? "";
  if (!/^\d{1,20}$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function hnApiUrl(id: number): string {
  return `https://hn.algolia.com/api/v1/items/${id}`;
}

/**
 * 把评论树摊成缩进文本。
 *
 * 深度优先，子回复紧跟在父评论下面 —— 这就是人读 HN 的顺序。剪枝只剪
 * 「条数」和「单条长度」，不剪分支：按点赞数排序会让时间顺序消失，而
 * 「谁在反驳谁」完全依赖顺序。
 */
export function flattenThread(root: HnNode, maxComments = MAX_COMMENTS): Thread {
  const { total, present } = countComments(root);
  const lines: string[] = [];

  lines.push(`标题：${oneLine(root.title) || "（无标题）"}`);
  const head = [person(root.author), day(root.created_at)];
  if (typeof root.points === "number") head.push(`${root.points} 分`);
  head.push(`${total} 条评论`);
  lines.push(`发布：${head.filter(Boolean).join(" ｜ ")}`);
  if (root.url) lines.push(`外部链接：${oneLine(root.url)}`);

  const body = commentText(root.text);
  if (body) lines.push("", "帖文：", body);

  if (!present) {
    lines.push("", "这条下面一条评论都没有。");
    return { text: lines.join("\n"), shown: 0, total: 0 };
  }

  lines.push(
    "",
    total > maxComments
      ? `评论（展开前 ${maxComments} 条，共 ${total} 条；剩下的没读）`
      : `评论（共 ${total} 条）`,
  );

  let shown = 0;
  let dropped = 0;

  const walk = (node: HnNode, depth: number) => {
    for (const child of node.children ?? []) {
      if (shown >= maxComments) {
        dropped += 1 + countOf(child);
        continue;
      }
      // 已删除的评论 author 是 null、text 是 null。占一条编号但不占读者注意力 ——
      // 它有用：说明这里原本有人说过话，只是被删了。
      const text = commentText(child.text);
      if (!text && !child.author) {
        dropped += 1 + countOf(child);
        continue;
      }

      shown++;
      lines.push("");
      lines.push(`${pad(depth)}[${shown}] ${person(child.author)} ｜ ${day(child.created_at)}`);
      if (text) lines.push(pad(depth + 1) + indentBody(text, depth + 1, PER_COMMENT));
      else lines.push(pad(depth + 1) + "（这条被删了）");

      if (depth + 1 < MAX_DEPTH) walk(child, depth + 1);
    }
  };

  walk(root, 0);

  if (dropped > 0) {
    lines.push("", `（还有 ${dropped} 条没展开：这个工具一次只读前 ${maxComments} 条。）`);
  }

  return { text: lines.join("\n"), shown, total };
}

/** 数一下整棵树有多少条，以及有没有正文可读的。 */
function countComments(root: HnNode): { total: number; present: boolean } {
  let total = 0;
  let present = false;
  const walk = (node: HnNode) => {
    for (const child of node.children ?? []) {
      total++;
      if (child.text || child.author) present = true;
      walk(child);
    }
  };
  walk(root);
  return { total, present };
}

/** 这个节点连同它下面的回复一共多少条。用来在剪枝时说清丢了多少。 */
function countOf(node: HnNode): number {
  let n = 0;
  for (const child of node.children ?? []) n += 1 + countOf(child);
  return n;
}

/**
 * 评论正文是 HTML。
 *
 * 不复用 fetch_url 里那个 htmlToText：那边要处理 script/style/table 和编码，
 * 这边只有 `<p>` 分段加几个行内标签。为了两行正则去引一个共用模块，代价是
 * 让两条完全不同的输入走同一套猜测规则 —— 不划算。
 */
function commentText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<p\s*\/?>/gi, "\n\n")
    .replace(/<\/(p|pre|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, decodeEntity)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
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

function decodeEntity(_match: string, entity: string): string {
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

/**
 * 单条超长就截断，并在截断处写明原长 —— 不写，模型会把「前 1200 字」当成全文。
 *
 * 空行不加前缀：一条评论分两三段很常见，每段都顶着一串空格会让缩进看起来
 * 比实际深一层，而这个文本唯一的用途就是让人（和模型）一眼看出谁在回谁。
 */
function indentBody(text: string, depth: number, limit: number): string {
  const body = text.length > limit ? `${text.slice(0, limit)}…（这条原长 ${text.length} 字符，后面没读）` : text;
  const prefix = pad(depth);
  return body
    .split("\n")
    .map((line) => (line ? prefix + line : ""))
    .join("\n");
}

function pad(depth: number): string {
  return "  ".repeat(Math.min(depth, MAX_DEPTH));
}

function person(name: string | null | undefined): string {
  return name && name.trim() ? name.trim() : "（匿名）";
}

function day(at: string | null | undefined): string {
  return typeof at === "string" && at.length >= 10 ? at.slice(0, 10) : "";
}

function oneLine(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
