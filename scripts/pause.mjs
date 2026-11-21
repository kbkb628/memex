/**
 * 停 / 起。`node scripts/pause.mjs pause` 或 `resume`。
 *
 * 为什么要一个脚本，而不是让人自己 curl：这台开发机到 workers.dev 不通，
 * 「按一下」这件事只能借 runner 的手；而借手的东西必须是一条命令，
 * 不能是一段需要人照着抄的 curl —— 抄错的代价是调了个不存在的路径，
 * 返回 404，然后你以为停了。
 *
 * 只做两件事：发那个 POST，再把 /routines 读回来。第二件是重点 ——
 * 接口返回 200 不等于队列真的空了，得看它自己怎么说。
 */

const BASE = (process.env.BASE || "").replace(/\/$/, "");
const TOKEN = process.env.MEMEX_TOKEN || "";
const action = (process.argv[2] || "pause").trim();

if (!BASE) {
  console.error("缺 BASE");
  process.exit(2);
}
if (action !== "pause" && action !== "resume") {
  console.error(`只认 pause / resume，收到的是 ${action}`);
  process.exit(2);
}

const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

async function call(path, init) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 300);
  }
  return { status: res.status, body };
}

const done = await call(`/${action}`, { method: "POST" });
if (done.status !== 200) {
  console.error(`/${action} 返回 ${done.status}：${JSON.stringify(done.body).slice(0, 300)}`);
  process.exit(1);
}

const now = await call("/routines");
const routines = now.body?.routines ?? [];

console.log(`/${action}  ok`);
console.log(JSON.stringify(done.body, null, 2));
console.log("--- 它自己怎么说 ---");
console.log(`paused: ${now.body?.paused}`);
for (const r of routines) {
  const next = r.next ? new Date(r.next).toISOString() : null;
  // 上一次跑在什么时候也要打：暂停之后如果它变了，说明队列里还有东西在跑 ——
  // next 为空只是「没排下一次」，管不住已经到期的那一个。
  const last = r.last?.at ? new Date(r.last.at).toISOString() : null;
  console.log(`  ${r.id.padEnd(8)} every ${Math.round((r.everyMs ?? 0) / 60000)} 分钟   last: ${last}   next: ${next}`);
}

// 暂停之后「还有下一次」就是没停干净；恢复之后「没有下一次」就是没起来。
// 两种都不该靠人盯输出才发现。
const stillScheduled = routines.filter((r) => r.next).length;
const bad = action === "pause" ? stillScheduled > 0 : routines.some((r) => !r.next);
if (bad) {
  console.error(action === "pause" ? "还有定时动作排着 —— 没停干净" : "恢复后没有排上下一次 —— 没起来");
  process.exit(1);
}
