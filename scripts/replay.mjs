#!/usr/bin/env node
/**
 * 回放台：拿**真实条目**，用两版口径各判一次，把差异摆出来。
 *
 * 为什么要有它：改 `want` 是这套系统里最贵的一次改动 —— 改完要等好几天
 * 才攒够新判定，而那时你已经忘了当初为什么改。中间这段时间里，
 * 「改得对不对」只能靠感觉。回放把这个循环压到一分钟。
 *
 * 它不判断对错，只摆事实：同一条内容，旧口径说什么、新口径说什么。
 * 哪一版对是人的判断，尤其是「模型能力分水岭」这类 —— 机器没有立场。
 *
 * 三件必须知道的事：
 *
 *   1. **只喂摘要，没有正文。** 线上那条路模型可以 fetch_url 去读原文，
 *      这里不读（省时间也省钱）。所以回放的结论是「口径对摘要的影响」，
 *      不是线上判定的复现。差异出现在长文上时，要记得这一点。
 *   2. **结论随模型版本变。** 和 inject-probe 一样，它不进 CI、不做断言。
 *      唯一的用途是「改口径之前跑一遍」。
 *   3. **要花钱。** 一次回放 = 条数 × 2 次调用。默认 5 条，跑之前会先报数。
 *
 *   node scripts/replay.mjs --feed "llm agent" --limit 5 --refresh --save
 *   node scripts/replay.mjs --feed "llm agent" --limit 5
 *   node scripts/replay.mjs --feed "llm agent" --briefs scripts/briefs.json --dry
 *
 * **样本默认是固定的。** 第一次用 `--refresh --save` 抓一批存下来，之后每次
 * 都跑同一批 —— 否则 HN 每隔几小时换一批帖子，你比较的其实是两组不同的题。
 * 这个坑是实测踩到的：连跑三次，同一版口径的「留下」条数是 3 / 2 / 0，
 * 看起来像口径不稳，实际是样本在变。想换样本就再 `--refresh --save` 一次。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_FEEDS, fetchFeed, promptFor, readWant } from "../src/feeds.ts";
import { parseVerdict } from "../src/verdict.ts";
import { buildModels } from "../src/models.ts";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const wanted = arg("feed", "llm agent");
const limit = Number(arg("limit", "5"));
const briefsPath = arg("briefs", "scripts/briefs.json");
const dry = argv.includes("--dry");

const feed = DEFAULT_FEEDS.find((f) => f.label.includes(wanted)) ?? DEFAULT_FEEDS.find((f) => f.url.includes(wanted));
if (!feed) {
  console.error(`没有匹配 "${wanted}" 的源。可选：\n  ${DEFAULT_FEEDS.map((f) => f.label).join("\n  ")}`);
  process.exit(2);
}

if (!existsSync(briefsPath)) {
  console.error(`没有 ${briefsPath}。它要长这样：\n\n{\n  "${feed.label}": { "about": "…", "avoid": "…" }\n}\n`);
  process.exit(2);
}
const briefs = JSON.parse(readFileSync(briefsPath, "utf8"));
const next = briefs[feed.label];
if (!next) {
  console.error(`${briefsPath} 里没有 "${feed.label}" 这一项。`);
  process.exit(2);
}

const old = readWant(feed.want);
console.log(`\n=== 回放 · ${feed.label} ===`);
console.log(`  旧口径：${old.about}${old.avoid ? `\n          不要：${old.avoid}` : ""}`);
console.log(`  新口径：${next.about}${next.avoid ? `\n          不要：${next.avoid}` : ""}`);

const slug = feed.label.replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
const samplePath = `scripts/samples/${slug}.json`;
const refresh = argv.includes("--refresh");
const save = argv.includes("--save");

let items;
if (!refresh && existsSync(samplePath)) {
  items = JSON.parse(readFileSync(samplePath, "utf8")).slice(0, limit);
  console.log(`\n  样本来自 ${samplePath}（${items.length} 条，固定）`);
} else {
  const probe = await fetchFeed(feed.url);
  if (!probe.ok) {
    console.error(`\n抓不到这个源：${probe.error}`);
    process.exit(2);
  }
  items = probe.items.slice(0, limit);
  if (save) {
    mkdirSync("scripts/samples", { recursive: true });
    writeFileSync(samplePath, JSON.stringify(items, null, 2) + "\n");
    console.log(`\n  样本已存到 ${samplePath}（${items.length} 条）`);
  } else {
    console.log(`\n  这一轮现抓的（没存，下次可能换一批）—— 加 --save 固定下来`);
  }
}

console.log(`  ${items.length} 条，${items.length * 2} 次模型调用${dry ? "（--dry，不真跑）" : ""}`);
if (dry) process.exit(0);

const env = Object.fromEntries(
  readFileSync(".dev.vars", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const setup = buildModels({ DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY, AGENT_MODEL: env.AGENT_MODEL });

async function ask(brief, item) {
  const msg = await setup.models.completeSimple(setup.model, {
    messages: [{ role: "user", content: promptFor({ ...feed, want: brief }, item) }],
  });
  const text = (msg.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return parseVerdict(text, brief, item.summary.length);
}

const rows = [];
let spent = 0;
for (const item of items) {
  const a = await ask(old, item);
  const b = await ask(next, item);
  spent += 2;
  rows.push({ item, a, b, changed: a.keep !== b.keep });
  const mark = a.keep !== b.keep ? "变" : "  ";
  const tag = (v) => (v.keep ? "留下" : `跳过${v.cited ? `（提到 ${v.cited.join(" / ")}）` : ""}`);
  console.log(`\n${mark} ${item.title.slice(0, 64)}`);
  console.log(`   旧 ${tag(a)}`);
  console.log(`   新 ${tag(b)}`);
  console.log(`   新理由：${(b.why || "（空）").replace(/\n/g, " ").slice(0, 110)}`);
}

const kept = (r, k) => r.filter((x) => x[k].keep).length;
const flipped = rows.filter((r) => r.changed);
console.log(`\n--- ${rows.length} 条 · ${spent} 次调用 ---`);
console.log(`留下：旧 ${kept(rows, "a")} / 新 ${kept(rows, "b")}`);
console.log(`判定翻转 ${flipped.length} 条${flipped.length ? `：\n${flipped.map((r) => "  - " + r.item.title.slice(0, 60)).join("\n")}` : ""}`);

// 跳过里有多少条根本没提「我不要的」—— 这个数比「准不准」更能说明问题：
// 如果全是材料不足，那说明瓶颈在摘要质量，不在口径。
const bare = rows.flatMap((r) => [r.a, r.b]).filter((v) => !v.keep && !v.cited);
console.log(`\n跳过里没有提到「我不要的」的：${bare.length}/${rows.flatMap((r) => [r.a, r.b]).filter((v) => !v.keep).length}`);
if (bare.length) console.log(`  这些大概是「材料不够」或「就是不对题」，不是踩了 avoid。`);

console.log(`\n注意：这里只喂了摘要（${items[0]?.summary.length ?? 0} 字量级），没有读正文。`);
console.log(`线上那条路模型可以 fetch_url 读原文，所以这不是线上判定的复现。\n`);
