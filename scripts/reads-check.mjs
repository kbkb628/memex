#!/usr/bin/env node
/**
 * 「它到底读了什么」的自检。
 *
 * 这个模块的全部难度不在取数，在**切窗口**：会话记录是一条连续的流水，
 * 里面混着好几十次提交，每次提交又可能有若干次网页读取。切错一格，
 * 就会把上一条判定读的页面算到这一条头上 —— 而那种错误在页面上看起来
 * 完全正常，只是理由和证据对不上。所以这里不测「取到没取到」，只测边界。
 *
 *   node scripts/reads-check.mjs
 *
 * 退出码：有检查没过就是 2。
 */

import { describeReads, markerFor, readsFor } from "../src/reads.ts";

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const user = (text) => ({ role: "user", content: text });
const fetchOk = (url, chars, clipped) => ({
  role: "toolResult",
  toolName: "fetch_url",
  details: { url, chars, ...(clipped ? { clipped: true } : {}) },
});
const fetchErr = (url, error) => ({ role: "toolResult", toolName: "fetch_url", details: { url, error } });
const otherTool = (name) => ({ role: "toolResult", toolName: name, details: { url: "https://x" } });
const assistant = (text) => ({ role: "assistant", content: text });

// ── 1. 基本取证 ────────────────────────────────────────────
const a = "链接：https://a.example/x";
const b = "链接：https://b.example/y";

const one = readsFor([user(a), fetchOk("https://a.example/doc", 3395), assistant("SKIP")], a);
check("读了一页就记一页", one.length === 1 && one[0].url === "https://a.example/doc");
check("字数照抄工具的 details", one[0]?.chars === 3395);

// ── 2. 边界：不能把上一条的证据算到下一条头上 ──────────────
//    这是这个模块存在的理由。切错一格，页面上看不出任何异常，
//    只有「理由说读了 3395 字」和「记录说没读」同时出现时才暴露。
const two = [
  user(a),
  fetchOk("https://a.example/doc", 3395),
  assistant("SKIP"),
  user(b),
  fetchOk("https://b.example/page", 120),
  assistant("OK"),
];
const second = readsFor(two, b);
check("第二条只拿到自己的那一页", second.length === 1 && second[0].url === "https://b.example/page");
const first = readsFor(two, a);
check("第一条也不会被后来的读取污染", first.length === 1 && first[0].url === "https://a.example/doc");

// ── 3. 同一条被提交过两次，取最近那次 ──────────────────────
//    改过 want 文案后 operationId 会变，同一条材料会被重新提交。
//    取到旧的，页面就会显示上一次读了什么 —— 而判定是这一次做的。
const twice = [
  user(a),
  fetchOk("https://a.example/old", 10),
  assistant("SKIP"),
  user(a),
  fetchOk("https://a.example/new", 999),
  assistant("OK"),
];
const latest = readsFor(twice, a);
check("重复提交取最近那次", latest.length === 1 && latest[0].url === "https://a.example/new", latest[0]?.url);

// ── 4. 失败也是证据 ────────────────────────────────────────
const failed = readsFor(
  [user(a), fetchErr("https://a.example/discuss", "http_error"), fetchOk("https://a.example/doc", 3395)],
  a,
);
check("失败的读取照样留痕", failed.length === 2);
check("失败那页带原因不带字数", failed[0]?.error === "http_error" && failed[0].chars === undefined);

// ── 5. 不相关的东西不能混进来 ──────────────────────────────
const noisy = readsFor([user(a), otherTool("fetch_rss"), assistant("ok")], a);
check("别的工具的结果不算网页读取", noisy.length === 0);
check("没读过就返回空数组，不是 undefined", Array.isArray(noisy));
check("找不到对应提问就返回空", readsFor([user(b), fetchOk("https://x", 1)], a).length === 0);
check("空标记返回空", readsFor([user(a), fetchOk("https://x", 1)], "").length === 0);

// ── 6. details 形状不可信，逐字段验 ────────────────────────
const junk = readsFor(
  [
    user(a),
    { role: "toolResult", toolName: "fetch_url", details: null },
    { role: "toolResult", toolName: "fetch_url", details: { url: "" } },
    { role: "toolResult", toolName: "fetch_url", details: { url: "https://ok", chars: -5 } },
    { role: "toolResult", toolName: "fetch_url", details: { url: "https://ok2", chars: Number.NaN } },
  ],
  a,
);
check("没有 url 的丢掉", junk.length === 2, `${junk.length}`);
check("负字数被夹到 0", junk[0]?.chars === 0);
check("NaN 不写成字数", junk[1]?.chars === undefined);

// ── 7. 标记本身 ────────────────────────────────────────────
check("有链接用链接", markerFor({ link: "https://a", title: "T" }) === "链接：https://a");
check("没链接退回标题", markerFor({ link: "", title: "T" }) === "标题：T");
check("两样都没有就是空标记", markerFor({}) === "");

// ── 8. 摘要句 ──────────────────────────────────────────────
check("有读到的页才说字数", describeReads([{ url: "u", chars: 100 }, { url: "v", chars: 20 }]) === "读了 2 页（120 字）");
check("全失败只说没读到", describeReads([{ url: "u", error: "timeout" }]) === "1 页没读到");
check("空数组不出句子", describeReads([]) === "" && describeReads(undefined) === "");

const bad = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - bad.length}/${checks.length} 通过`);
if (bad.length) {
  console.log("没过：");
  for (const x of bad) console.log(`  - ${x.name}${x.detail ? ` (${x.detail})` : ""}`);
  process.exit(2);
}
