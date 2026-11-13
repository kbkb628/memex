/**
 * 从会话记录里翻出「这条判定到底读了什么」。
 *
 * 为什么要翻记录而不是让工具自己记账：
 *
 *   - 工具跑在模型那一侧，它不知道自己在为哪一条判定干活。要让它知道，
 *     就得从提交那一刻把一个 id 传下去，穿过整个运行 —— 而 pi 的会话记录
 *     本来就把「谁在第几条提问之后调了哪个工具、结果是什么」按顺序存着。
 *     再记一份，等于把同一件事存两遍，然后等着两份对不上。
 *   - 记录里那一份是模型真正看到的。自己记的那份只是我以为它看到的。
 *
 * 为什么这不只是「多存个字段」：`given` 记的是提交时喂进去的摘要字数，
 * 而模型可以自己 fetch_url 去读原文。于是「只看了 63 字的标题就判」和
 * 「读了 3395 字的正文才判」在记录上长得一模一样 —— 都是 63。可信度差着
 * 一个数量级，而事后没有任何办法分开。这才是要补的洞。
 */

/** 一次读取。成功记字数，失败记原因 —— 两类都要，「读不到」本身就是判定的一部分。 */
export type Read = {
  url: string;
  /** 读到的正文字符数。失败时没有。 */
  chars?: number;
  /** 是否被 maxChars 截断。 */
  clipped?: boolean;
  /** 失败时的原因代号，比如 http_error、timeout。 */
  error?: string;
};

/** 只取这个函数用得到的字段，好让断言能拿普通对象喂进来，不用造整条 EntryRecord。 */
export type Message = {
  role?: string;
  toolName?: string;
  content?: unknown;
  details?: unknown;
};

/** 最多记这么多次读取。真到上限说明这一轮跑飞了，记前 12 个足够复盘。 */
const MAX_READS = 12;

/**
 * 取出 `marker` 这一次提问之后、下一次提问之前的全部网页读取。
 *
 * 从后往前找 `marker`：同一条材料可能被提交过两次（改过 want 文案之后
 * operationId 会变），要的是最近那次的结果，不是上一次的。
 *
 * 找到起点后往后扫，遇到下一条 user 提问就停 —— 那是下一轮的工作，
 * 把它读的页面算到这一条身上，就成了两条判定共用一份证据。
 */
export function readsFor(messages: readonly Message[], marker: string): Read[] {
  if (!marker) return [];

  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (!textOf(message).includes(marker)) continue;
    start = i;
    break;
  }
  if (start < 0) return [];

  const reads: Read[] = [];
  for (let i = start + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "user") break;
    if (message.role !== "toolResult" || message.toolName !== "fetch_url") continue;

    const read = asRead(message.details);
    if (!read) continue;
    reads.push(read);
    if (reads.length >= MAX_READS) break;
  }
  return reads;
}

/**
 * 一条判定用的那次提问的标记。
 *
 * 用链接优先于标题：标题可能两条材料一样（同一个 HN 讨论被转两次），
 * 链接是源给的，重复得少。没有链接的源（少数 RSS）才退回标题。
 */
export function markerFor(item: { link?: string; title?: string }): string {
  return item.link ? `链接：${item.link}` : item.title ? `标题：${item.title}` : "";
}

/** `details` 是工具自己写的，形状不受我们控制，所以逐字段验，不硬转。 */
function asRead(details: unknown): Read | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  if (typeof d.url !== "string" || !d.url) return undefined;

  const read: Read = { url: d.url };
  if (typeof d.chars === "number" && Number.isFinite(d.chars)) read.chars = Math.max(0, Math.trunc(d.chars));
  if (d.clipped === true) read.clipped = true;
  if (typeof d.error === "string" && d.error) read.error = d.error;
  return read;
}

function textOf(message: Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      text += (part as { text: string }).text;
    }
  }
  return text;
}

/** 给页面和断言共用的一句话摘要。不参与判定，只负责别让人去数数组。 */
export function describeReads(reads: Read[] | undefined): string {
  if (!reads || !reads.length) return "";
  const ok = reads.filter((r) => typeof r.chars === "number");
  const chars = ok.reduce((sum, r) => sum + (r.chars ?? 0), 0);
  const parts: string[] = [];
  if (ok.length) parts.push(`读了 ${ok.length} 页（${chars} 字）`);
  const failed = reads.length - ok.length;
  if (failed) parts.push(`${failed} 页没读到`);
  return parts.join("，");
}
