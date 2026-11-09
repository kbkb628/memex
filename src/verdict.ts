/**
 * 判定结果：从一段自由文本，拆成能核对的部分。
 *
 * 为什么单独一个文件，而不是塞进 `feeds.ts`：那里明说了「它不调模型，也不知道
 * 模型存在」，而这一段读的正是模型的输出。语义上它属于 M3（判定），
 * 不属于 M2（摄取）。
 *
 * 为什么需要拆：`answer_contains` 那次的教训是**判定结果不能自证** ——
 * 模型可以一字不差地复述条件串。同一件事在「值不值得看」这条路上又出现了：
 * 理由里写着「因为踩了你不要的榜单」，这句话本身无法核对，模型完全可以编一条
 * 听起来合理的原因，而它其实只看了标题。
 *
 * ## 第一版做错了，这一版是改回来的
 *
 * 第一版要求模型把原因写成 `因为：<原样引出的那一条>`，服务端再核对它是否
 * 是 `avoid` 的子串。实测三轮，全部失败：
 *
 *   1. 模型把「材料不足」写进「因为」行 —— 那根本不是 `avoid` 里的东西；
 *   2. 加强措辞后，它把整句解释（连同括号注释）都塞了进去；
 *   3. 同一段提示词，旧口径那边连写三次「因为：材料不足」，核不上三处。
 *
 * 结论不是「措辞还不够狠」，是**这个设计让模型来提供可核对的东西**，
 * 而模型本来就不擅长守格式，尤其是在它认为理由显而易见的时候。
 *
 * 所以改成反过来：**不让模型标注，由服务端去它的话里找。**
 * 判 SKIP 之后，拿 `avoid` 拆出来的每一条去理由里搜，找到了就记下 ——
 * 找到的那条必然真的出现在 `avoid` 里（因为是从 `avoid` 里拿的），
 * 不存在「核对不上」。剩下唯一的问题是「它有没有具体引用」，而这正是我们要的指标。
 */
import { isSkip } from "./feeds.ts";
import { normalizeForMatch } from "./goal.ts";

export type Verdict = {
  keep: boolean;
  /** 去掉 SKIP 那一行之后的理由正文。 */
  why: string;
  /** 我们交给模型的材料字数。服务端确知，不是模型自述。 */
  givenChars: number;
  /** 理由里真的提到了 `avoid` 的哪几条。判「留下」时永远是空的。 */
  cited?: string[];
};

/**
 * 归一化，比 `answer_contains` 那套更松：连标点和空格一起删掉。
 *
 * 理由：要回答的是「这句话里有没有提到 X」，不是「是否逐字相同」。
 * 模型引用时几乎一定会重排标点（`融资、招聘` 会写成 `融资 、招聘`），
 * 逐字比会把**老实的引用**判成没提 —— 一个只误伤诚实行为的检查，
 * 比没有检查更糟。
 */
function loose(text: string): string {
  return normalizeForMatch(text).replace(/[\s、，,。；;：:·\-—]/g, "");
}

/**
 * 把 `avoid` 拆成可搜的条目。
 *
 * 真实写法里混着引号和括号注释（`「AI 要取代谁」这类议论`、
 * `发布稿（摘要短、看不到正文不算这一条）`），直接拿去搜永远搜不到。
 * 所以每条再削一次：去引号括号，砍掉「这类…」之后的尾巴。
 */
function entries(avoid: string): string[] {
  return (
    avoid
      // 先整段剥掉括号注释，再按分隔符切 —— 顺序反了会把 `发布稿（摘要短、看不到正文…）`
      // 从括号里的顿号处切开，得到两个都不是词的东西。
      .replace(/（[^）]*）/g, "")
      .replace(/\([^)]*\)/g, "")
      .split(/[、，,；;]/)
      .map((part) =>
        part
          .replace(/[「」“”"'‘’]/g, "")
          .replace(/(这类|这种|等).*$/, "")
          .trim(),
      )
      .filter((part) => loose(part).length >= 2)
  );
}

/**
 * 把模型输出读成 Verdict。纯函数，不认识模型也不认识存储。
 *
 * `cited` 只在判 SKIP 时计算：判「留下」的时候，理由本来就不该提「我不要的」，
 * 提到了反而是个信号，但那个信号现在还没有读者，先不算。
 */
export function parseVerdict(text: string, brief: { about: string; avoid?: string }, givenChars: number): Verdict {
  const lines = text
    .trim()
    .split("\n")
    .map((l) => l.trim());
  const keep = !isSkip(text);

  // 判 SKIP 时第一行只有 SKIP，理由从第二行开始；判留下时整段都是理由。
  const why = keep
    ? text.trim()
    : lines
        .slice(1)
        .filter((l) => l && !/^skip\b/i.test(l))
        .join("\n")
        .trim();

  const cited = keep || !brief.avoid ? [] : entries(brief.avoid).filter((e) => loose(why).includes(loose(e)));

  return {
    keep,
    why,
    givenChars,
    ...(cited.length ? { cited } : {}),
  };
}
