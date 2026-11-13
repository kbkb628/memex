#!/usr/bin/env node
/**
 * 看一眼收件箱里现在有什么 —— 判定的分布，和每条的依据。
 *
 * 为什么单独做一个脚本：验证窗到点要回答「口径对不对」，而答案就在 `/inbox` 的
 * 原始 JSON 里。但那个 JSON 没有可读的形状 —— 一条条读二十条是没人会做的事，
 * 没人看的数据等于没存。
 *
 *   BASE=https://xxx.workers.dev MEMEX_TOKEN=xxx node scripts/peek.mjs
 *   ... --why        每条多打一截理由
 *   ... --days 3     只看最近 N 天（默认全部）
 *
 * 只读，不改任何东西。
 */

import { describeReads } from "../src/reads.ts";

const BASE = (process.env.BASE || "").replace(/\/$/, "");
const TOKEN = process.env.MEMEX_TOKEN || "";
const SHOW_WHY = process.argv.includes("--why");
const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 0;

if (!BASE) throw new Error("BASE 没设：给一个线上地址");
if (!TOKEN) throw new Error("MEMEX_TOKEN 没设");

const res = await fetch(`${BASE}/inbox?all=1`, {
  headers: { authorization: `Bearer ${TOKEN}` },
  signal: AbortSignal.timeout(30_000),
});
if (res.status === 401) throw new Error("token 不对（401）");
if (!res.ok) throw new Error(`/inbox 返回 ${res.status}`);

const body = await res.json();
const all = body.items ?? [];
const cutoff = DAYS ? Date.now() - DAYS * 86_400_000 : 0;
const items = all.filter((i) => i.at >= cutoff).sort((a, b) => a.at - b.at);

const pad = (s, n) => String(s).padEnd(n);
const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));
const when = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 跳过的理由分类。这三类对应三个不同的毛病，混在一起就没法定位。 */
function reasonKind(item) {
  const why = item.verdict?.why ?? item.note ?? "";
  if (/材料不足|只有标题|读不到正文/.test(why)) return "材料不足";
  if (item.verdict?.cited?.length) return "踩到「我不要的」";
  if (!why) return "没留理由";
  return "其他";
}

const count = (pred) => items.filter(pred).length;
const ready = count((i) => i.state === "ready");
const skipped = count((i) => i.state === "skipped");
const failed = count((i) => i.state === "failed");
const pending = count((i) => i.state === "pending");
const unread = count((i) => i.state === "ready" && !i.read);

console.log(`收件箱 ${items.length} 条${DAYS ? `（近 ${DAYS} 天）` : ""}：进 ${ready} / 跳 ${skipped} / 失败 ${failed} / 待判 ${pending}，其中未读 ${unread}`);
if (items.length) {
  console.log(`时间跨度 ${when(items[0].at)} → ${when(items.at(-1).at)}`);
}

const withFp = count((i) => typeof i.fp === "string" && i.fp);
const withModel = count((i) => typeof i.model === "string" && i.model);
console.log(`带指纹 ${withFp}/${items.length}，带模型 ${withModel}/${items.length}`);
if (withModel) {
  const models = new Map();
  for (const i of items) if (i.model) models.set(i.model, (models.get(i.model) ?? 0) + 1);
  console.log(`模型分布：${[...models].map(([m, n]) => `${m}×${n}`).join("  ")}`);
}

if (!items.length) process.exit(0);

console.log("");
console.log(`${pad("时间", 12)}${pad("源", 14)}${pad("状态", 6)}${pad("材料", 6)}${pad("fp", 9)}${pad("提到", 12)}标题`);
for (const i of items) {
  const cited = i.verdict?.cited?.length ? i.verdict.cited.join("、") : "";
  console.log(
    pad(when(i.at), 12) +
      pad(clip(i.feed, 12), 14) +
      pad(i.state === "ready" ? "进" : i.state === "skipped" ? "跳" : i.state === "failed" ? "失败" : "待判", 6) +
      pad(i.given == null ? "—" : i.given, 6) +
      pad(i.fp ?? "—", 9) +
      pad(clip(cited, 10), 12) +
      clip(i.title, 46),
  );
  if (SHOW_WHY && i.state !== "ready") {
    console.log(`  └ ${clip(i.verdict?.why ?? i.note ?? "", 120)}`);
  }
  // 它自己读了什么。表格里那一列「材料」只是我们喂了多少，
  // 而这条判定到底看没看正文，只有这行说得清。
  const read = describeReads(i.reads);
  if (read) console.log(`  └ ${read}：${i.reads.map((r) => r.url).slice(0, 3).join(" ｜ ")}`);
}

// 待判的每一条都问一次 /op：这条究竟是「pi 还在跑」还是「pi 早结算了、
// 只是没人来搬」。这两件事外观完全一样 —— 都是 pending —— 但一个该等、
// 一个该跑一轮 ingest。不分开，就只剩瞎猜。
const waiting = items.filter((i) => i.state === "pending");
if (waiting.length) {
  console.log("");
  console.log("待判的还卡在哪");
  for (const i of waiting) {
    const age = Math.round((Date.now() - i.at) / 60_000);
    // id 本身以数字结尾（feed-xxxx-yyyyy），和「多少分钟」挨着就会被读成同一个词。
    // 加个分隔符，别让读的人去猜哪个数字是 id 的一部分。
    let line = `  ${i.id}  已挂 ${age >= 90 ? `${Math.round(age / 60)} 小时` : `${age} 分钟`}  →  `;
    try {
      const r = await fetch(`${BASE}/op?id=${encodeURIComponent(i.id)}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      });
      const b = await r.json();
      // 回答是多行的，直接拼会把整张表打散。压成一行再截。
      const out = String(b.text ?? b.error ?? "无输出").replace(/\s+/g, " ");
      line += b.live ? `pi 仍持有 · ${b.status}` : `pi 已结算 · ${clip(out, 40)}`;
    } catch (error) {
      line += `问不到：${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(line);
  }
}

console.log("");
const kinds = new Map();
for (const i of items.filter((x) => x.state === "skipped" || x.state === "failed")) {
  const k = i.state === "failed" ? "没跑通" : reasonKind(i);
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
}
if (kinds.size) {
  console.log("跳过的原因分布");
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 16)}${n}`);
  console.log("");
  console.log(
    `读法：材料不足多 → 是源给的东西太薄（M2）；踩到「我不要的」多 → 是 want 写窄了（M3）；` +
      `没跑通多 → 是链路坏了，不是判断坏了。`,
  );
}
