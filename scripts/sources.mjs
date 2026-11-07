#!/usr/bin/env node
/**
 * 换源用的命令行：对着一个已经跑起来的实例，看它现在有哪些源、补上默认源、删掉不要的。
 *
 * 为什么需要它：默认源只在**第一次开机**写进 `cfg:feeds`（010 的取舍：删掉的不会自动补回来）。
 * 所以改了 `DEFAULT_FEEDS` 之后，已经跑起来的实例不会跟着变 —— 本地可以手点几下，
 * 部署在公网的那个如果开发机够不到，就没有别的手段了。
 *
 *   BASE=https://xxx MEMEX_TOKEN=... node scripts/sources.mjs --list
 *   BASE=... node scripts/sources.mjs --add-defaults
 *   BASE=... node scripts/sources.mjs --drop https://hnrss.org/frontpage
 *
 * 默认只做「加」，删除必须显式给 URL —— 这个脚本不该有能力悄悄删掉一个源，
 * 因为删源会连带删掉那个源在收件箱里的条目（009）。
 */

import { DEFAULT_FEEDS } from "../src/feeds.ts";

const BASE = (process.env.BASE || "").replace(/\/$/, "");
const TOKEN = process.env.MEMEX_TOKEN || "";
if (!BASE) throw new Error("BASE 没设：给一个地址，比如 http://127.0.0.1:8787");

const args = process.argv.slice(2);

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const list = async () => (await call("/feeds")).body.feeds ?? [];

if (args.includes("--list") || args.length === 0) {
  const feeds = await list();
  console.log(`${feeds.length} 个源：`);
  for (const f of feeds) {
    console.log(`  ${f.label}`);
    console.log(`    ${f.url}${f.prefilter?.length ? `  （词表 ${f.prefilter.length} 个词）` : ""}`);
  }
  if (args.length === 0) {
    console.log("\n加 --add-defaults 补上代码里的默认源，或 --drop <url> 删一个。");
  }
  process.exit(0);
}

const dropIndex = args.indexOf("--drop");
if (dropIndex >= 0) {
  const url = args[dropIndex + 1];
  if (!url) throw new Error("--drop 后面要跟一个 URL");
  const target = (await list()).find((f) => f.url === url);
  if (!target) {
    console.log(`没有这个源，跳过：${url}`);
  } else {
    const res = await call("/feeds/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: target.id }),
    });
    if (res.status !== 200) throw new Error(`删除失败：${JSON.stringify(res.body).slice(0, 200)}`);
    console.log(`删掉 ${target.label}，连带清掉 ${res.body.removedItems ?? 0} 条收件箱条目`);
  }
}

if (args.includes("--add-defaults")) {
  const current = await list();
  const have = new Set(current.map((f) => f.url));
  const missing = DEFAULT_FEEDS.filter((f) => !have.has(f.url));
  if (!missing.length) console.log("默认源都在了，没有要加的。");
  for (const f of missing) {
    const res = await call("/feeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: f.url, label: f.label, want: f.want, prefilter: f.prefilter }),
    });
    if (res.status !== 200) {
      console.log(`  加不上 ${f.label}：${res.body.error ?? res.status}`);
      continue;
    }
    console.log(`  加上 ${f.label}（基线 ${res.body.baseline} 条，一条都不提交）`);
  }
}

console.log("\n现在：");
for (const f of await list()) console.log(`  ${f.label}`);
