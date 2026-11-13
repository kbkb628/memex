#!/usr/bin/env node
/**
 * 页面的静态自检：它引用的东西，别处还认不认。
 *
 * 为什么要有这个：`public/index.html` 是一个 400 多行的单文件，改后端路由的时候
 * 没人会想起它，改页面的时候也常常改错一个 id。这两种错**都不会报错** ——
 * 页面照常打开，只是某一块永远空白，或者按钮点了没反应。这类问题只能靠人反复点，
 * 而人不会每次都点全。
 *
 * 它检查两件事，都是能静态确定的：
 *   1. 脚本里 `$("#xxx")` 引用的 id，HTML 里真的存在。
 *   2. 脚本里 `api("/xxx")` 调的接口，`src/home.ts` 里真的有这条路由。
 *
 * 它不检查渲染结果、不执行 JS、不看样式。这些要靠真浏览器，脚本代替不了。
 *
 *   node scripts/page-check.mjs
 *
 * 退出码：有检查没过就是 2。
 */

import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const src = readFileSync("src/home.ts", "utf8");

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const open = html.indexOf("<script>");
const close = html.lastIndexOf("</script>");
check("页面里有内联脚本", open >= 0 && close > open);
const script = html.slice(open, close);

// 1. 选择器 → id
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = [...new Set([...script.matchAll(/\$\("#([\w-]+)"\)/g)].map((m) => m[1]))];
check(`脚本引用了 ${used.length} 个 id`, used.length > 0);
for (const id of used) check(`#${id} 在 HTML 里存在`, ids.has(id), ids.has(id) ? "" : "页面会静默空白");

// 2. 接口 → 路由
const routes = new Set([...src.matchAll(/path === "([^"]+)"/g)].map((m) => m[1]));
// 只取引号里到问号之前的部分：`/inbox?all=1` 对应路由 `/inbox`。
const calls = [...new Set([...script.matchAll(/api\("(\/[^"?]*)/g)].map((m) => m[1]))];
check(`脚本调用了 ${calls.length} 个接口`, calls.length > 0);
for (const p of calls) check(`${p} 在 home.ts 里有路由`, routes.has(p), routes.has(p) ? "" : "会 404");

// 3. 反过来：页面自己声明要轮询的存储键，不能是空数组写死
check("回执键写的是 localStorage 而不是内存变量", /localStorage\.setItem\(STORE/.test(script));

// 4. 存下来但没人读的字段 = 白存（ADR 015）。
//    判定现在留了材料指纹和模型，页面就必须真的渲染它们 —— 否则字段只是
//    躺在 SQLite 里，而下一个复盘的人照样分不清「当时判的是不是眼前这条」。
const fpShown = /item\.fp/.test(script);
check("页面渲染了材料指纹 fp", fpShown, fpShown ? "" : "存了 fp 但没人读，等于没存");
const modelShown = /item\.model/.test(script);
check("页面渲染了判定用的模型", modelShown, modelShown ? "" : "换过模型后新旧判定分不开");

// 6. 它自己读了什么，必须在场。
//
//    这一条比上面两条更要紧：`材料 63 字` 和「它读了 3395 字正文才判」
//    在页面上长大一模一样，而两者的可信度差一个数量级。只存不显示，
//    这个字段就只是躺在 SQLite 里的一句自白。
const readsShown = /item\.reads/.test(script);
check("页面渲染了它自己读的页面", readsShown, readsShown ? "" : "存了 reads 但没人读，等于没存");
const readsMerged = /"材料 " \+ v\.givenChars \+ " 字 · " \+ read/.test(script);
check("材料字数和自读字数挨在一起", readsMerged, readsMerged ? "" : "分开显示时，会把「材料 63 字」读成「只看了 63 字」");

// 5. 同理：轮次现在全留着，但页面只铺最新一轮。没有「翻回去看」的入口，
//    留 6 轮和留 3 轮对人是同一个东西 —— 而第 1 轮恰恰最能解释「之前为什么不行」。
const roundsShown = /g\.rounds\.length > 1/.test(script) && /每一轮（/.test(script);
check("页面能翻到每一轮", roundsShown, roundsShown ? "" : "轮次留了却没地方看");

const bad = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
if (bad.length) {
  console.log("没过：");
  for (const b of bad) console.log(`  - ${b.name}${b.detail ? ` (${b.detail})` : ""}`);
  process.exit(2);
}
