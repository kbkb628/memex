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
 *   BASE=... node scripts/sources.mjs --sync-want          # 只列差异
 *   BASE=... node scripts/sources.mjs --sync-want --apply  # 真改
 *
 * 默认只做「加」，删除必须显式给 URL —— 这个脚本不该有能力悄悄删掉一个源，
 * 因为删源会连带删掉那个源在收件箱里的条目（009）。
 */

import { DEFAULT_FEEDS, readWant } from "../src/feeds.ts";

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

// 把代码里的 `want` 推到线上已有的源。改口径时用它。
//
// 为什么不是 --add-defaults 的一部分：那个只补缺的源，不碰已有的；
// 而改口径恰恰只碰已有的。两件事混在一起，就会出现「我只是想补一个源，
// 结果五个源的 want 都被覆盖了」。
// 默认只列差异。`want` 是唯一一处「人可能手写过」的配置 ——
// 一个运维脚本不该在没打招呼的情况下把它覆盖掉，
// 所以真改要显式 --apply。
if (args.includes("--sync-want")) {
  const apply = args.includes("--apply");
  const current = await list();
  const byUrl = new Map(current.map((f) => [f.url, f]));
  for (const f of DEFAULT_FEEDS) {
    const live = byUrl.get(f.url);
    if (!live) {
      console.log(`  线上没有，跳过：${f.label}`);
      continue;
    }
    const a = readWant(live.want);
    const b = readWant(f.want);
    if (a.about === b.about && (a.avoid ?? "") === (b.avoid ?? "")) {
      console.log(`  没变：${f.label}`);
      continue;
    }
    if (!apply) {
      console.log(`  有差异：${f.label}\n    线上：${a.about}\n    代码：${b.about}`);
      continue;
    }
    const res = await call("/feeds/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: live.id, want: b.about, avoid: b.avoid ?? "" }),
    });
    if (res.status !== 200) {
      console.log(`  改不上 ${f.label}：${res.body.error ?? res.status}`);
      continue;
    }
    console.log(`  已更新 ${f.label}`);
  }
  if (!apply) console.log("\n以上只是列出差异，没有改。加 --apply 才写入。");
}

if (args.includes("--add-defaults")) {
  const current = await list();
  const have = new Set(current.map((f) => f.url));
  const missing = DEFAULT_FEEDS.filter((f) => !have.has(f.url));
  if (!missing.length) console.log("默认源都在了，没有要加的。");
  for (const f of missing) {
    // `want` 现在是两栏对象，而 `/feeds` 收的是两个平铺字段。
    // 直接把它塞回去会变成 "[object Object]" —— 一个不会报错、只会静默丢内容的坑。
    const brief = readWant(f.want);
    const res = await call("/feeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: f.url,
        label: f.label,
        want: brief.about,
        avoid: brief.avoid,
        prefilter: f.prefilter,
      }),
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
