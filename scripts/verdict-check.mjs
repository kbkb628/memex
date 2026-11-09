#!/usr/bin/env node
/**
 * 判定结果的自检：拆得开、找得到、编不出来。
 *
 * 为什么单独一个脚本：这是全项目第二处「模型说的话要被服务端复核」的地方。
 * `answer_contains` 那次已经吃过一次亏 —— 模型一字不差地复述了条件串，
 * 一轮就判 done。同一种错误换个地方又出现了：判 SKIP 时的理由听起来
 * 完全合理，但它可能是编的。
 *
 * ## 这里测的是第二版
 *
 * 第一版让模型写 `因为：<原样引出的那一条>`，服务端核对子串。三轮实测全败：
 * 模型会把「材料不足」写进那一行，也会把整句解释连同括号塞进去。
 * 失败的不是措辞，是「让模型提供可核对的东西」这个思路。
 *
 * 第二版反过来：服务端拿 `avoid` 拆出的每一条去理由里搜。所以这里锁的是
 * **搜索本身**（拆得对、认得出、不误伤），而不是模型的服从性。
 *
 *   node scripts/verdict-check.mjs
 *
 * 退出码：有检查没过就是 2。
 */

import { parseVerdict } from "../src/verdict.ts";

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const brief = { about: "具体踩坑记录", avoid: "融资、招聘、榜单、纯观点" };

// 1. 值得看的那条
const keep = parseVerdict("这个项目用 Durable Objects 存账本，写到 4000 次/秒时撞上存储上限，作者给了复现步骤。", brief, 900);
check("不是 SKIP 就是 keep", keep.keep === true);
check("keep 时理由保留全文", keep.why.startsWith("这个项目用 Durable Objects"), keep.why.slice(0, 20));
check("keep 时不计算 cited", keep.cited === undefined);

// 2. 理由里确实提到了 avoid 的某一条
const cited = parseVerdict("SKIP\n这是本周 AI 项目榜单，没有可复现的东西。", brief, 620);
check("SKIP 被认出来", cited.keep === false);
check("理由提到「榜单」就被记下", JSON.stringify(cited.cited) === '["榜单"]', JSON.stringify(cited.cited));
check("SKIP 时理由不含第一行", !cited.why.startsWith("SKIP"), cited.why);

// 3. 理由是「材料不足」，不该被算成踩了 avoid
const thin = parseVerdict("SKIP\n摘要只有标题和链接，看不到正文，无法判断。", brief, 146);
check("材料不足不算引用 avoid", thin.cited === undefined, JSON.stringify(thin.cited));

// 4. 一次提到两条
const two = parseVerdict("SKIP\n这是一轮融资消息，同时也是招聘贴。", brief, 300);
check("提到两条就记两条", JSON.stringify(two.cited) === '["融资","招聘"]', JSON.stringify(two.cited));

// 5. 源没写 avoid：没有可搜的东西
const noAvoid = parseVerdict("SKIP\n因为榜单。", { about: "踩坑" }, 100);
check("源没写 avoid 时 cited 为空", noAvoid.cited === undefined);

// 6. 标点与空格：中文输入法下天天出现
const fuzzy = parseVerdict("SKIP\n属于纯 观 点，只有态度。", brief, 200);
check("空格与标点不影响命中", JSON.stringify(fuzzy.cited) === '["纯观点"]', JSON.stringify(fuzzy.cited));

// 7. 小写 skip
const lower = parseVerdict("skip\n只有态度，纯观点。", brief, 150);
check("小写 skip 也认", lower.keep === false);
check("小写的理由仍能命中", JSON.stringify(lower.cited) === '["纯观点"]');

// 8. 带引号和尾巴的条目：`「AI 要取代谁」这类议论` 要能搜到「AI 要取代谁」
const quoted = { about: "工程做法", avoid: "「AI 要取代谁」这类议论、榜单" };
const q = parseVerdict("SKIP\n通篇在讲 AI 要取代谁，没有工程细节。", quoted, 400);
check("引号与「这类…」被削掉后仍能搜到", JSON.stringify(q.cited) === '["AI 要取代谁"]', JSON.stringify(q.cited));

// 9. 括号注释不该变成搜索词
const paren = { about: "工程做法", avoid: "发布稿（摘要短、看不到正文不算这一条）" };
const p = parseVerdict("SKIP\n这是发布稿，没有细节。", paren, 400);
check("括号注释被削掉后仍能命中", JSON.stringify(p.cited) === '["发布稿"]', JSON.stringify(p.cited));

// 10. 太短的条目不当搜索词，否则「等」会命中一切
const tiny = parseVerdict("SKIP\n什么都不是。", { about: "x", avoid: "等、啊" }, 100);
check("一两个字的条目不参与搜索", tiny.cited === undefined, JSON.stringify(tiny.cited));

// 11. 材料字数原样带出
check("givenChars 原样带出", keep.givenChars === 900 && cited.givenChars === 620);

const bad = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
if (bad.length) {
  console.log("没过：");
  for (const b of bad) console.log(`  - ${b.name}${b.detail ? ` (${b.detail})` : ""}`);
  process.exit(2);
}
