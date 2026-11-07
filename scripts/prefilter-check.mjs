#!/usr/bin/env node
/**
 * 用收件箱里已有的**真实判断结果**，反过来检验粗筛词表。
 *
 * 为什么要这个脚本：
 * 粗筛是一种「不花钱的代替判断」，它的错误和模型判断的错误性质不一样 ——
 * 模型判错了，理由写在收件箱里，人一眼能看见；粗筛挡错了，那条内容根本不出现，
 * 没有人会发现自己错过了什么。**误杀是不可见的，所以必须专门去查。**
 *
 * 做法很直接：把已经判过的条目拿回来，只用标题和链接跑一遍粗筛，
 * 看它会不会把「模型认为有关」的挡掉。模型不是标准答案，但它是目前唯一
 * 存在过的第二意见，比凭感觉调词表强。
 *
 * 用法：
 *   node scripts/prefilter-check.mjs          # 需要本地服务在跑
 *   PORT=8787 node scripts/prefilter-check.mjs
 *
 * 退出码：有误杀就是 2 —— 它该拦住一次词表改动，而不是给个提示就过。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prefilterHits } from "../src/feeds.ts";

const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;

let feeds;
let inbox;
try {
  feeds = (await (await fetch(`${BASE}/feeds`)).json()).feeds;
  inbox = await (await fetch(`${BASE}/inbox?all=1`)).json();
} catch (error) {
  console.error(`连不上 ${BASE}，先把服务起起来（npm run dev）。`);
  process.exit(1);
}

if (!inbox.items?.length) {
  console.error("收件箱是空的。这个检查要靠已有的判断结果当参照，先去跑几轮 ingest。");
  process.exit(1);
}

const byId = new Map(feeds.map((f) => [f.id, f]));
const groups = { kill: [], keep: [], waste: [], good: [], skippedFeed: [] };

for (const item of inbox.items) {
  const feed = byId.get(item.feedId);
  const words = feed?.prefilter ?? [];
  if (!words.length) {
    groups.skippedFeed.push(item);
    continue;
  }
  const hits = prefilterHits(words, { title: item.title, link: item.link, summary: "" });
  const passes = hits.length > 0;
  // 模型判成 skipped 的条目不进收件箱正文，但 ?all=1 里在。用它当「无关」的参照。
  const related = item.state !== "skipped";

  if (related && !passes) groups.kill.push(item);
  else if (related && passes) groups.keep.push({ item, hits });
  else if (!related && passes) groups.waste.push({ item, hits });
  else groups.good.push(item);
}

const line = (label, item, extra = "") =>
  console.log(`  ${label}  ${item.title.slice(0, 58)}${extra}`);

console.log(`\n=== 粗筛回放（${inbox.items.length} 条已判过的内容）===\n`);

for (const item of groups.kill) line("误杀 ", item, `\n         ${item.link}`);
for (const { item, hits } of groups.keep) line("放行✓", item, `  ← ${hits.slice(0, 3).join(",")}`);
for (const { item, hits } of groups.waste) line("白放 ", item, `  ← ${hits.slice(0, 3).join(",")}`);
for (const item of groups.good) line("挡掉✓", item);
for (const item of groups.skippedFeed) line("不筛 ", item, `（${item.feed} 没配词表）`);

const total = groups.kill.length + groups.keep.length + groups.waste.length + groups.good.length;

// 默认源换掉之后，一个泛话题源都没有了，也就没有任何源配粗筛。
// 这时候不该打印「误杀 0、通过」——那是把「没检查」说成「检查没问题」，
// 而且会用一份全零的凭证盖掉上一次真实的回放结果。
if (!total) {
  console.log(`
  现在没有任何源配了粗筛，没什么可回放的。
  这不是通过，是没检查：默认源已经换成关键词订阅，筛的动作挪到了抓取之前，
  见 docs/decisions/014-oriented-sources.md。
  如果你自己加了泛话题源并配了 prefilter，这里会重新有东西可查。
`);
  process.exit(0);
}

const judged = groups.keep.length + groups.waste.length;
const saved = Math.round(((total - judged) / total) * 100);

console.log(`
  误杀         ${groups.kill.length}    ← 这三个数里只有它必须为 0
  放行且有关   ${groups.keep.length}
  白放         ${groups.waste.length}    （多花一次调用，代价固定且可见）
  正确挡掉     ${groups.good.length}
  不筛的源     ${groups.skippedFeed.length}

  配了词表的 ${total} 条里，只需要喂 ${judged} 条给模型，省掉 ${saved}%。
`);

if (groups.kill.length) {
  console.log("有误杀。要么把词表补上，要么把这个源的 prefilter 去掉 —— 别让它继续挡。\n");
  await save({ passed: false });
  process.exit(2);
}

await save({ passed: true });
console.log("没有误杀。\n");

/** 存一份凭证，和其他场景的产物放在一起，能被打开、被 diff。 */
async function save({ passed }) {
  const pick = (rows) =>
    rows.map((row) => {
      const item = row.item ?? row;
      return { title: item.title, link: item.link, feed: item.feed, hits: row.hits };
    });
  const receipt = {
    kind: "memex.prefilter",
    when: new Date().toISOString(),
    passed,
    replayed: inbox.items.length,
    counted: { kill: groups.kill.length, keep: groups.keep.length, waste: groups.waste.length, good: groups.good.length },
    savedPercent: saved,
    feeds: feeds.map((f) => ({ label: f.label, prefilterCount: f.prefilter?.length ?? 0 })),
    kill: pick(groups.kill),
    keep: pick(groups.keep),
    waste: pick(groups.waste),
  };
  const dir = path.join(process.cwd(), "receipts");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "prefilter.json");
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`→ ${path.relative(process.cwd(), file)}\n`);
}
