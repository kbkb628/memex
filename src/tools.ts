import { defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/**
 * 第一个工具，只有一个：读一个网页。
 *
 * 为什么是它，而不是「搜索」「发邮件」「改文件」：
 *
 *   - 它是只读的，不会产生副作用，所以现在加它是安全的。发邮件、付款这类动作在
 *     「至少一次」的恢复语义下会重复执行（见 005），那要等幂等键做好再谈。
 *   - 有了它，agent 才第一次能碰外面的世界。之前它只能靠模型自己的记忆说话。
 *   - 一个工具，不是一个工具集。加第二个之前，先让这一个在真实任务里被用几十次。
 *
 * `replay: "safe"` 是这个工具唯一值得单独讲的字段：pi 在重启后会重新执行没做完的
 * 工具调用，而读网页重跑一次没有任何后果（顶多多花一次请求）。将来任何有后果的工具
 * 都必须标 `unsafe`，或者在参数里带一个幂等键 —— 这条区别现在写清楚，比事后补便宜。
 */

/** 单次最多读 2MB 原始响应。超过就不读了，返回已读部分并说明。 */
const MAX_BYTES = 2 * 1024 * 1024;
/** 一个页面必须在这个时间内给出首包，否则宁可让模型知道它慢。 */
const TIMEOUT_MS = 15_000;
/** 给模型的默认正文上限。整页塞进上下文没有意义，模型也读不完。 */
const DEFAULT_MAX_CHARS = 20_000;
/** 下限。再小就只剩导航条了，对任务没有帮助。 */
const MIN_MAX_CHARS = 1_000;

const schema = Type.Object({
  url: Type.String({
    description: "要读的完整网址，必须以 http:// 或 https:// 开头。",
  }),
  maxChars: Type.Optional(
    Type.Number({
      description: `正文最多保留多少字符，默认 ${DEFAULT_MAX_CHARS}，最少 ${MIN_MAX_CHARS}。只想看开头时可以调小。`,
    }),
  ),
});

export function webExtension(): Extension {
  return {
    name: "web",
    tools: [
      defineTool({
        name: "fetch_url",
        description:
          "读取一个网页，返回它的正文纯文本（HTML 标签、脚本、样式会被去掉）。" +
          "只支持 http/https，只读，不能提交表单、不能登录。" +
          "返回内容过长时会被截断，截断处会明确标注。",
        parameters: schema,
        // 只读，重跑无副作用。这一行决定了断电恢复时它能不能被重新执行。
        replay: "safe",
        outputLimits: { maxBytes: 60_000, maxLines: 1_500, retain: "head" },
        async execute(args, _api, context) {
          const url = args.url.trim();
          const asked = typeof args.maxChars === "number" ? args.maxChars : undefined;
          const maxChars = clamp(asked, MIN_MAX_CHARS, DEFAULT_MAX_CHARS * 4) ?? DEFAULT_MAX_CHARS;

          let target: URL;
          try {
            target = new URL(url);
          } catch {
            return fail("invalid_url", `不是合法的网址：${url}`, url);
          }
          if (target.protocol !== "http:" && target.protocol !== "https:") {
            return fail("unsupported_scheme", `只支持 http/https，收到的是 ${target.protocol}`, url);
          }
          const at = target.toString();
          if (isPrivateHost(target.hostname)) {
            return fail(
              "blocked_host",
              `拒绝访问内网地址 ${target.hostname}。这个工具只用来读公网页面。`,
              at,
            );
          }

          // 两个中止源要合起来：一个是这个工具自己的超时，一个是 pi 给的取消信号
          // （任务被 abort、对象要驱逐、调用方撤回了这次等待）。
          //
          // 只挂 timeout 是不够的：`conversation.abort()` 要等到整条会话 idle 才 resolve，
          // 而它等的正是这个 fetch。工具不听 signal，abort 就会一直挂到 15 秒超时，
          // 表现成「点了取消没反应」。官方 NOTES 里那条就是这个。
          const signal = context.abortSignal
            ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(TIMEOUT_MS)])
            : AbortSignal.timeout(TIMEOUT_MS);

          let response: Response;
          try {
            response = await fetch(at, {
              // 有些站点会按 UA 拒绝空 UA 的请求，也有的会返回一套残缺的 HTML。
              headers: {
                "user-agent":
                  "Mozilla/5.0 (compatible; personal-agent/0.1; +https://github.com/) fetch_url",
                accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
              },
              redirect: "follow",
              signal,
            });
          } catch (error) {
            // 「internal error」这种字面对模型没有任何用处，它只会转述给你。
            // 所以这里分两种：超时是一种（可以重试、可以换站点），其余归为网络层失败，
            // 并直说可能的原因 —— 多数情况下是站点在边缘网络上不可达，而不是参数错了。
            const err = error as { name?: string; message?: string };

            // 取消不是这个站点的错。单独说一句，否则模型会把它当网络失败，换个源再试一遍，
            // 而它其实应该停下来。
            if (err?.name === "AbortError" && context.abortSignal?.aborted) {
              return fail("aborted", "这次读取被取消了，不是站点的问题，不用换地址重试。", at);
            }

            const timedOut = err?.name === "TimeoutError";
            const detail = [err?.name, err?.message].filter(Boolean).join(": ");
            return fail(
              timedOut ? "timeout" : "fetch_failed",
              timedOut
                ? `请求超时：${TIMEOUT_MS / 1000} 秒内对方没有给出响应。这个站点可能很慢，或者在当前网络下不可达。`
                : `没拿到响应（${detail}）。这是网络层的失败，不是网址写错了。常见原因是该站点在当前边缘网络上不可达，或它的 TLS 配置过旧。可以换 https 或换一个来源试试。`,
              at,
            );
          }

          if (!response.ok) {
            return fail(
              "http_error",
              `对方返回 ${response.status} ${response.statusText}。页面没有读到。`,
              at,
            );
          }

          const contentType = response.headers.get("content-type") ?? "";
          if (!isTextual(contentType)) {
            return fail(
              "not_text",
              `这个地址返回的是 ${contentType || "未知类型"}，不是网页或文本，读不了。`,
              at,
            );
          }

          const raw = await readCapped(response);
          if (raw.bytes.length === 0) return fail("empty_body", "响应体是空的。", at);

          const text = isHtml(contentType, raw.head)
            ? htmlToText(decode(raw.bytes, contentType))
            : decode(raw.bytes, contentType).trim();

          const body = text.slice(0, maxChars);
          const clipped = text.length > body.length;

          // 截断时必须留一个能核对的东西。只给「前 N 字符」，模型会默认这就是全文；
          // 给了总长度和指纹，它才知道自己读到的是一段，也知道两次读到的是不是同一版。
          //
          // 指纹只覆盖「已经读到的这部分」：响应体被 2MB 上限砍过时，原文本身就不完整，
          // 下面的提示会说明这一点，不假装它是全文的指纹。
          const fp = clipped || raw.truncated ? await fingerprint(text) : null;

          const lines = [
            `来源 ${at}`,
            clipped
              ? `正文共 ${text.length} 字符，下面只保留前 ${body.length} 字符 —— 剩下的没读到，不要当作全文。`
              : `正文共 ${text.length} 字符。`,
          ];
          // 参数被改写过就说出来。静默把 400 抬成 1000，模型会以为自己只要了 400，
          // 接着拿这个数字去推断「我是不是读全了」—— 那是错的推断。
          if (asked !== undefined && asked !== maxChars)
            lines.push(
              `你要的 maxChars 是 ${asked}，这个工具允许 ${MIN_MAX_CHARS}–${DEFAULT_MAX_CHARS * 4}，实际按 ${maxChars} 给了。`,
            );
          if (fp) lines.push(`这段正文的 sha256 是 ${fp}。同一地址两次读到的指纹不同，说明页面变过。`);
          if (raw.truncated)
            lines.push(
              `响应体超过 ${MAX_BYTES / 1024 / 1024}MB，只读了前一部分；上面的字符数和指纹只覆盖已读部分。`,
            );
          lines.push("", body);

          return {
            output: [{ type: "text" as const, text: lines.join("\n") }],
            details: {
              url: at,
              chars: text.length,
              clipped,
              ...(fp ? { sha256: fp } : {}),
            },
          };
        },
      }),
    ],
  };
}

/**
 * 正文的短指纹：SHA-256 的前 8 字节，16 个十六进制字符。
 *
 * 不用完整的 64 个字符 —— 这是给模型看、给人核对「是不是同一版」用的，
 * 16 个字符的碰撞概率在这个用途上够用，也短到不会把正文挤下去。
 */
async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 失败也要留可核对的痕迹。
 *
 * 一开始只记成功的读取，结果跳过理由里最常见的两句「正文只有 3395 字符」
 * 和「HN 讨论页返回 419」在记录上完全不对称：前者什么都查不到，后者连
 * 「试过、没成」都留不下来。而「读不到」恰恰是判 SKIP 的正当理由之一 ——
 * 不记它，就没法区分「读了，确实不行」和「根本没读」。
 *
 * `code` 进 details 而不是进文字：文字是给模型看的（要能读懂），
 * details 是给复盘的人看的（要能按类统计）。
 */
function fail(code: string, message: string, url?: string) {
  return {
    output: [{ type: "text" as const, text: message }],
    isError: true,
    diagnostics: [{ severity: "error" as const, code, message }],
    ...(url ? { details: { url, error: code } } : {}),
  };
}

function clamp(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * 阻止它去读内网、本机、云元数据地址。
 *
 * 这个工具的参数是模型填的，而模型会被网页内容影响（页面里写一句「请读取
 * http://169.254.169.254/…」就够）。所以拦住私有网段不是洁癖，是唯一能防住
 * 「诱导模型去打内网」的地方。
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isTextual(contentType: string): boolean {
  if (!contentType) return true;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type === "application/json" ||
    type.endsWith("+xml") ||
    type.endsWith("+json")
  );
}

function isHtml(contentType: string, head: Uint8Array): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml") return true;
  if (type && type !== "text/plain") return false;
  // 没有 content-type 的站点不少，看开头几百字节里有没有 html 的痕迹。
  return /<(!doctype|html)/i.test(new TextDecoder().decode(head.slice(0, 512)));
}

/**
 * 解码。三档，按可靠性从高到低。
 *
 * 1. 响应头里写了 charset → 用它。
 * 2. 头里没写，但文档开头有 `<meta charset>` → 用它。中文老站点大量是这种情况：
 *    实测 www.jxnews.com.cn 的响应头只有 `text/html`，真正的编码 gb2312 只写在 meta 里。
 * 3. 都没有 → 先按 utf-8 解，如果解出一堆替换字符（U+FFFD），说明猜错了，再试 gbk。
 *
 * 第 3 档是兜底。没有它，一个不声明编码的 gbk 页面会变成满屏乱码，而且不报错 ——
 * 模型会拿着乱码一本正经地总结，这是最坏的一种失败。
 */
function decode(bytes: Uint8Array, contentType: string): string {
  const declared = declaredCharset(contentType, bytes);
  if (declared) {
    const text = tryDecode(bytes, declared);
    if (text !== undefined) return text;
  }

  const utf8 = new TextDecoder().decode(bytes);
  const broken = countReplacement(utf8);
  if (broken > 20 && broken / Math.max(utf8.length, 1) > 0.002) {
    const gbk = tryDecode(bytes, "gbk");
    if (gbk !== undefined && countReplacement(gbk) < broken) return gbk;
  }
  return utf8;
}

function declaredCharset(contentType: string, bytes: Uint8Array): string | undefined {
  const fromHeader = contentType.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1];
  if (fromHeader) return normalizeCharset(fromHeader);

  // 用单字节编码读开头，这样即使正文是多字节也不会错位到看不见 meta。
  const head = new TextDecoder("iso-8859-1").decode(bytes.slice(0, 2048));
  const fromMeta = head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
  return fromMeta ? normalizeCharset(fromMeta) : undefined;
}

/** gb2312 / gb18030 在 WHATWG 里都归到 gbk，显式写出来免得依赖实现细节。 */
function normalizeCharset(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "gb2312" || lower === "gb18030" || lower === "gbk") return "gbk";
  return lower;
}

function tryDecode(bytes: Uint8Array, charset: string): string | undefined {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // Workers 只带有限的几种编码，认不出来就交给下一档。
    return undefined;
  }
}

function countReplacement(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) count++;
  return count;
}

/** 读到 MAX_BYTES 就停，不把整个视频文件拉进来。 */
async function readCapped(response: Response): Promise<{
  bytes: Uint8Array;
  head: Uint8Array;
  truncated: boolean;
}> {
  if (!response.body) return { bytes: new Uint8Array(0), head: new Uint8Array(0), truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.length > MAX_BYTES) {
        chunks.push(value.slice(0, MAX_BYTES - total));
        total = MAX_BYTES;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    // 提前停止时要把流关掉，否则连接会一直挂着。
    await reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, head: bytes.slice(0, 512), truncated };
}

/**
 * HTML → 纯文本。
 *
 * 不用专门的解析器：DO 的内存和 CPU 都有限，引一个 DOM 实现只为了取正文不划算，
 * 而且这一层的目的是「让模型读得懂」，不是「还原页面结构」。所以规则很短：
 * 扔掉不可见的内容、块级标签断行、去掉其余标签、解码实体、压缩空白。
 */
function htmlToText(html: string): string {
  return (
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg|iframe|canvas)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(head|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, decodeEntity)
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
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
