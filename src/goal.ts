/**
 * 目标：一件需要多轮才有结果的事，以及「它到底做完没有」的判定。
 *
 * 这个文件只做三件不花钱的事：解析完成条件、机械地验一条回答、算目标的指纹。
 * 它不调模型，不知道 session 存在，也不知道谁来推进 —— 那样才能单独测。
 *
 * 为什么需要它：
 * 没有完成条件的「目标」不是目标，是一个会一直跑到没预算的循环。而「做完了」
 * 如果由模型自己宣布，那这句话永远是免费的 —— 模型没有任何动机说没做完。
 * 所以完成必须由服务端验，而且只能验那些能机械验的东西。
 *
 * 这套设计不是原创：照 `helsome/OpenDot` 的 Goal 抄的机制，砍掉了体量。
 * 它的 `completion_criteria` 只认 `artifact_contains:` 这类可机械验证的前缀，
 * 自然语言条件一律降级为「需要人确认」；每轮开跑前拿目标快照和落盘那份做
 * 字节级比对，差一个字节就不跑。这里保留的正是这两条。
 */

/** 一条完成条件。`raw` 保留人写的那一行原文，回执里要说清验的是什么。 */
export type Criterion =
  | { kind: "answer_contains"; text: string; raw: string }
  | { kind: "human"; text: string; raw: string };

export type GoalStatus = "running" | "waiting" | "done" | "failed" | "cancelled";

/** 一轮。答案只留最近几轮，多了没有意义 —— 目标没变，内容会重复。 */
export type GoalRound = {
  op: string;
  at: number;
  answer?: string;
  /** 这一轮每条条件的判定，结算时写入。 */
  met?: boolean[];
};

export type Goal = {
  id: string;
  objective: string;
  /** 人写的原始条件行，创建后不可改。 */
  criteria: string[];
  /** 目标内容的指纹。改了 objective 或 criteria，它就变。 */
  digest: string;
  status: GoalStatus;
  runs: number;
  maxRuns: number;
  createdAt: number;
  /** 最近三轮，和 OpenDot 一样只回看三条。 */
  rounds: GoalRound[];
  /** 还没结算的那一轮。空 = 现在该起新一轮。 */
  currentOp?: string;
  /** 人工确认过的条件下标。 */
  confirmed?: number[];
  /** 为什么结束 —— 失败时这一句就是全部解释。 */
  endedWhy?: string;
};

/**
 * 上限三条。
 *
 * 这不是技术限制，是产品判断：能写清三条以上的目标，通常是三件事被写在了一起。
 * 逼着拆开比让它一次推五轮更接近「做完」。
 */
export const MAX_CRITERIA = 3;
/** 最多推几轮。跟 OpenDot 的 `max_model_steps: 12` 是同一个意思，只是我们轮次更贵。 */
export const MAX_ROUNDS = 6;

/**
 * 解析一行条件。
 *
 * 规则只有一条：**带已知前缀的才当机械条件，其余一律当人要看的**。
 * 不做任何猜测性解析 —— 「回答里要有三件事」这种话不能被自动翻译成
 * `answer_contains:三件事`，因为人写的自然语言条件往往比字面更宽，
 * 猜错了就是把「没做完」判成「做完了」，而这个错误永远暴露不出来。
 */
export function parseCriterion(raw: string): Criterion {
  const line = raw.trim();
  const contains = /^answer_contains[:：]\s*(.+)$/i.exec(line);
  if (contains) {
    return { kind: "answer_contains", text: contains[1].trim(), raw: line };
  }
  return { kind: "human", text: line, raw: line };
}

/** 解析整个条件列表，顺手去掉空行。 */
export function parseCriteria(lines: string[]): Criterion[] {
  return lines.map((l) => l.trim()).filter(Boolean).map(parseCriterion);
}

/**
 * 比对前先归一化。
 *
 * 不加这层会有真实的误判：模型写「单写者」，人写的条件里是全角「单写者」或者夹了一个
 * 零宽空格（复制粘贴常见），逐字比较就永远不命中，于是一个已经做对的目标被反复重跑，
 * 最后判失败。这类错误的方向是「多做几轮」，代价可见，但没理由付。
 *
 * NFKC 把全角／半角、罗马数字、连字这些折叠成一种形式；零宽字符直接删掉；
 * 连续空白折成一个。**大小写不动** —— 中文没有大小写，英文条件里的大小写
 * 往往是有意义的（`HTTP` 和 `http` 是两回事）。
 */
export function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * 机械判定一条回答。
 *
 * 只判机械条件；`human` 在这里永远是 false —— 不是因为没满足，是**机器不知道**。
 * 把「不知道」写成 false 而不是 true，是为了让「等人工确认」成为默认路径，
 * 而不是一个可以被跳过的例外。
 *
 * 必须说清它的能力边界：`answer_contains` 只防「模型根本没提这件事」，
 * 不防「提到了但说得不对」。而且条件原文是会写进提示词的，模型照抄那个词就能过 ——
 * 实测用一串不可能出现的字符做条件，它照样一字不差地复述出来。
 * 所以这类条件**只能当覆盖检查**，不能当「做对了」的证据。
 */
export function judge(criteria: Criterion[], answer: string): boolean[] {
  const text = normalizeForMatch(answer);
  return criteria.map((c) => {
    if (c.kind === "answer_contains") return text.includes(normalizeForMatch(c.text));
    return false;
  });
}

/**
 * 一轮结束之后该往哪走。四个出口，全部由这里定，`home.ts` 只负责执行。
 *
 * 抽出来是因为这是整套东西里唯一「判错了没人会发现」的决策：判成 done 就是交付，
 * 用户看到「已完成」不会去翻。放在 `home.ts` 里它只能靠人工读代码，放在这里可以被
 * `scripts/goal-check.mjs` 逐条钉住。
 *
 * 顺序不能换，每一步都在挡一种具体的事：
 *
 *   1. 机械条件有没中的 → 这一轮不算数，还有轮次就再来，没轮次就失败。
 *      注意不能因为「还有人要确认的条件」就停下来等 —— 那会让一个答得不全的目标
 *      永远停在「等人看」，而人看不到任何需要看的东西。
 *   2. 机械条件全中、人工条件有人确认过 → done。
 *   3. 机械条件全中、还有人没确认 → waiting。**这里即使轮次已经用尽也不判失败**：
 *      没人看 ≠ 没做到，人随时可以点一下，判死就再也点不回来了。
 */
export function decide(
  criteria: Criterion[],
  met: boolean[],
  confirmed: number[],
  runs: number,
  maxRuns: number,
): { status: GoalStatus; nextRound: boolean; why: string } {
  const mechanicalOk = criteria.every((c, i) => (c.kind === "answer_contains" ? met[i] === true : true));
  if (!mechanicalOk) {
    if (runs >= maxRuns) {
      return { status: "failed", nextRound: false, why: `推了 ${maxRuns} 轮，还有条件没满足。` };
    }
    return { status: "running", nextRound: true, why: "" };
  }

  const ok = satisfied(criteria, met, confirmed);
  if (ok.every(Boolean)) {
    return { status: "done", nextRound: false, why: `第 ${runs} 轮满足全部条件。` };
  }
  const left = criteria.filter((c, i) => c.kind === "human" && !ok[i]).length;
  return { status: "waiting", nextRound: false, why: `${left} 条条件在等人确认。` };
}

/** 机械条件是否全部满足。全部满足才有资格进「等人确认」。 */
export function mechanicalDone(criteria: Criterion[], met: boolean[]): boolean {
  return criteria.every((c, i) => (c.kind === "answer_contains" ? met[i] === true : true));
}

/** 一条条件本轮算不算满足：机械的看判定，人工的看有没有人确认过。 */
export function satisfied(criteria: Criterion[], met: boolean[], confirmed: number[]): boolean[] {
  return criteria.map((c, i) =>
    c.kind === "answer_contains" ? met[i] === true : confirmed.includes(i),
  );
}

/**
 * 目标的指纹：objective + criteria，sha256 前 8 字节。
 *
 * 它不防篡改（能改存储的人也能改这个），它防的是**张冠李戴** ——
 * 第 3 轮的答案被记到第 5 轮的账上、或者两轮之间目标被人改了却继续用旧回执。
 * 这两种错误在长程任务里非常容易发生，而且发生时不报错。
 */
export async function goalDigest(objective: string, criteria: string[]): Promise<string> {
  const text = JSON.stringify({ objective, criteria });
  const sum = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(sum).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 第 N 轮要喂给模型的那段话。
 *
 * 两个决定值得说：
 *
 * 1. **每轮重新给完整目标和条件，不靠对话历史。** 每轮是一个新 session，
 *    模型看不到上一轮的对话 —— 这正是「不偏移」的实现方式。靠累积的对话
 *    记目标，跑到第五轮时目标已经稀释成一堆上下文里的一句，偏移就是这样发生的。
 *
 * 2. **明确告诉它「你的自述不算」。** 不是为了让模型诚实（它是不是诚实我们管不了），
 *    是为了让它别把力气花在宣告完成上 —— 那部分由服务端验。
 */
export function promptForGoal(goal: Goal, criteria: Criterion[]): string {
  const last = goal.rounds[goal.rounds.length - 1];
  const criteriaLines = criteria
    .map((c, i) => {
      if (c.kind === "answer_contains") {
        return `${i + 1}. 回答里必须出现「${c.text}」（服务端会逐字检查）`;
      }
      return `${i + 1}. ${c.text}（这一条由人判断，你说什么都没用）`;
    })
    .join("\n");

  const history = last
    ? `\n上一轮你交的答案（供参考，可能不完整）：\n${(last.answer ?? "").slice(0, 1500)}\n`
    : "";

  return [
    `这是一个需要分几步做完的目标。现在是第 ${goal.runs + 1} 轮，最多 ${goal.maxRuns} 轮。`,
    "",
    `目标：${goal.objective}`,
    "",
    `完成条件（全部满足才算做完）：`,
    criteriaLines,
    history,
    "这一轮只做还没满足的部分。做完就直接给答案，不要复述目标，不要解释你在做什么，",
    "也不要声称「已经完成」—— 是否完成由服务端按上面的条件判定，你的自述不计入。",
  ].join("\n");
}
