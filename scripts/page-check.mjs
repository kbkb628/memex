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

const bad = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
if (bad.length) {
  console.log("没过：");
  for (const b of bad) console.log(`  - ${b.name}${b.detail ? ` (${b.detail})` : ""}`);
  process.exit(2);
}
