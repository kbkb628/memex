#!/usr/bin/env node
/**
 * 目标判定的自检。纯逻辑，不起服务、不调模型。
 *
 * 为什么这个要单独测：完成判定是整套东西里唯一「判错了永远暴露不出来」的部分。
 * 把没做完判成做完，用户看到的是一条「已完成」，不会去翻；反过来把做完判成没做完，
 * 只是多跑一轮，代价可见。所以这里的每条断言都在守着那头不可见的方向。
 *
 *   node scripts/goal-check.mjs
 */

import {
  decide,
  goalDigest,
  judge,
  mechanicalDone,
  normalizeForMatch,
  parseCriteria,
  parseCriterion,
  promptForGoal,
  satisfied,
} from "../src/goal.ts";

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- 解析：只有带前缀的才是机械条件
{
  const c = parseCriterion("answer_contains:三件事");
  check("带前缀的解析成机械条件", c.kind === "answer_contains" && c.text === "三件事", c.kind);

  const full = parseCriterion("answer_contains：三件事");
  check("全角冒号也认", full.kind === "answer_contains" && full.text === "三件事", full.kind);

  const loose = parseCriterion("回答里要提到三件事");
  check("自然语言一律归人工", loose.kind === "human", loose.kind);

  const tricky = parseCriterion("answer contains 三件事");
  check("少个下划线不猜它", tricky.kind === "human", tricky.kind);

  const empty = parseCriteria(["", "  ", "answer_contains:x"]);
  check("空行被丢掉，不会变成一条永远满足的条件", empty.length === 1, `${empty.length} 条`);
}

// ---- 机械判定：human 永远是 false，因为机器不知道
{
  const list = parseCriteria(["answer_contains:三件事", "结论能直接给人看"]);
  const met = judge(list, "这里说了三件事，还有别的");
  check("包含就满足", met[0] === true, String(met[0]));
  check("人工条件机器不给通过", met[1] === false, String(met[1]));

  const miss = judge(list, "什么都没提");
  check("不包含就不满足", miss[0] === false, String(miss[0]));
}

// ---- 三个判定层各自管什么
{
  const list = parseCriteria(["answer_contains:A", "人看一下"]);
  check("机械条件全中 → mechanicalDone", mechanicalDone(list, [true, false]) === true);
  check("机械条件缺一个 → 不是 mechanicalDone", mechanicalDone(list, [false, false]) === false);

  check("人工没确认 → 整体没满足", satisfied(list, [true, false], []).every((x) => !x) === false);
  check(
    "人工确认后才算整体满足",
    satisfied(list, [true, false], [1]).every(Boolean) === true,
  );
  check(
    "确认了但机械条件没中，仍然不算",
    satisfied(list, [false, false], [1])[0] === false,
  );
}

// ---- 归一化：全角和看不见的字符不该造成误判
{
  const list = parseCriteria(["answer_contains:单写者"]);
  check("全角字符照样命中", judge(list, "这里说的是单写者模型")[0] === true);
  check(
    "回答里夹零宽空格也命中",
    judge(list, "这里说的是单\u200b写者模型")[0] === true,
  );
  check(
    "条件里夹零宽空格也命中",
    judge(parseCriteria(["answer_contains:单\u200b写者"]), "单写者模型")[0] === true,
  );
  check("换行和多余空白不影响", judge(list, "单\n写   者")[0] === false, "换行确实拆开了词，不该命中");
  check("大小写不动", normalizeForMatch("HTTP") === "HTTP", normalizeForMatch("HTTP"));
}

// ---- 四个出口：这部分单独测，因为判成 done 就是交付，错了没人会去翻
{
  const mech = parseCriteria(["answer_contains:X"]);
  const mixed = parseCriteria(["answer_contains:X", "人看一下"]);

  const again = decide(mech, [false], [], 1, 6);
  check("机械条件没中、还有轮次 → 再来一轮", again.status === "running" && again.nextRound === true, again.why);

  const dead = decide(mech, [false], [], 6, 6);
  check("机械条件没中、轮次用尽 → 失败", dead.status === "failed" && !dead.nextRound, dead.why);

  const hold = decide(mixed, [true], [], 1, 6);
  check("机械过了、人工没确认 → 等人", hold.status === "waiting" && !hold.nextRound, hold.why);

  const holdLate = decide(mixed, [true], [], 6, 6);
  check("轮次用尽但只差人确认 → 仍然等人，不判死", holdLate.status === "waiting", holdLate.why);

  const fin = decide(mixed, [true], [1], 1, 6);
  check("全部满足 → 完成", fin.status === "done" && !fin.nextRound, fin.why);

  // 这条是这套东西里最容易写错的一处：有人工条件就先去 waiting，会让一个
  // 答得不全的目标永远停在「等人看」，而人看不到任何需要看的东西。
  const wrongWay = decide(mixed, [false], [], 1, 6);
  check("机械没中时不能跳到「等人」", wrongWay.status === "running" && wrongWay.nextRound, wrongWay.status);
}

// ---- 指纹：轮次之间目标被动过，就必须停下
{
  const a = await goalDigest("目标", ["answer_contains:X"]);
  const b = await goalDigest("目标", ["answer_contains:X"]);
  const c = await goalDigest("目标", ["answer_contains:Y"]);
  const d = await goalDigest("另一个目标", ["answer_contains:X"]);
  check("同内容同指纹", a === b, a);
  check("条件改一个字指纹就变", a !== c, `${a} vs ${c}`);
  check("目标改一个字指纹就变", a !== d, `${a} vs ${d}`);
  check("指纹是 16 个十六进制字符", /^[0-9a-f]{16}$/.test(a), a);

  // 这是「不偏移」唯一真正起作用的一条：每轮开跑前拿落盘的 digest 和重算的比。
  // 比的是字节，不是语义 —— 差一个就停下，不猜、不修、不继续跑。
  const intact = async (g) => (await goalDigest(g.objective, g.criteria)) === g.digest;
  check("没动过 → 放行", (await intact({ objective: "目标", criteria: ["answer_contains:X"], digest: a })) === true);
  check(
    "目标被改过 → 拦住",
    (await intact({ objective: "目标改了", criteria: ["answer_contains:X"], digest: a })) === false,
  );
  check(
    "条件被改过 → 也拦住",
    (await intact({ objective: "目标", criteria: ["answer_contains:Y"], digest: a })) === false,
  );
}

// ---- 每轮喂进去的话
{
  const criteria = parseCriteria(["answer_contains:三件事", "结论能直接给人看"]);
  const text = promptForGoal(
    {
      id: "g1",
      objective: "读三页文档，说出三件 DO 能做而 Worker 不能做的事",
      criteria: ["answer_contains:三件事", "结论能直接给人看"],
      digest: "x",
      status: "running",
      runs: 1,
      maxRuns: 6,
      createdAt: 0,
      rounds: [{ op: "o1", at: 0, answer: "上一轮的答案" }],
    },
    criteria,
  );
  check("每轮都重新给完整目标", text.includes("读三页文档"), "");
  check("带上第几轮", text.includes("第 2 轮"), "");
  check("说明机械条件会被逐字检查", text.includes("逐字检查"), "");
  check("说明人工条件模型说了没用", text.includes("由人判断"), "");
  check("带上一轮的答案", text.includes("上一轮的答案"), "");
  check("明说自述不算", text.includes("自述不计入"), "");
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过\n`);
if (failed.length) {
  console.log("有断言没过。完成判定的错误是安静的 —— 别绕过它。\n");
  process.exit(2);
}
