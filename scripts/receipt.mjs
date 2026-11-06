#!/usr/bin/env node
/**
 * 跑一次真实场景，把过程存成 receipts/<name>.json。
 *
 * 为什么要有这个脚本：
 * README 里那些「验过」如果只是文字，读者没法分辨哪些是真跑过的、哪些是写完就
 * 以为跑过的。凭据的作用不是好看，是让「断了一次还能接着跑」这句话有个可以被
 * 打开、被 diff、被复现的东西。
 *
 * 它自己拉起 wrangler dev，所以能自己把 workerd 杀掉再拉起来 —— 这是关键。
 * 外部杀进程做不到「杀完自动重启并等到健康」，那样每次都要人手盯着。
 *
 * 用法：
 *   node scripts/receipt.mjs break-resume
 *   node scripts/receipt.mjs idempotent
 *   node scripts/receipt.mjs reuse
 *   node scripts/receipt.mjs spend
 *
 * 环境变量：
 *   PORT=8787            本地端口
 *   KILL_AFTER_MS=3000   看到 running 之后再等多久才杀（留时间让工具真的开始跑）
 *   TASK_TIMEOUT_MS=300000  从提交到 done 的上限
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const NAME = process.argv[2] ?? "break-resume";
const PORT = Number(process.env.PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const KILL_AFTER_MS = Number(process.env.KILL_AFTER_MS ?? 3000);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS ?? 300_000);
const BOOT_TIMEOUT_MS = 180_000;

const PROMPT =
  "读 https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/ " +
  "然后用中文列出三件它明确说 Durable Object 能做到、而普通 Worker 做不到的事。" +
  "每条一句话，并说明你是从正文哪一段看到的。如果正文没读到，直接说没读到，不要猜。";

const startedAt = Date.now();
const steps = [];
const checks = [];
const notes = [];

let dev = null;
/** 启动日志留一段，起不来的时候能说清为什么，而不是只说「重启失败」。 */
let devLog = [];

function step(name, detail = {}) {
  const at = new Date().toISOString();
  const ms = Date.now() - startedAt;
  steps.push({ step: name, at, ms, ...detail });
  console.log(`  [${String(ms).padStart(6)}ms] ${name}${detail.note ? ` — ${detail.note}` : ""}`);
}

function check(name, pass, detail) {
  checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(everyMs);
  }
  return false;
}

function startDev() {
  devLog = [];
  dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT)], {
    cwd: process.cwd(),
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const keep = (buf) => {
    devLog.push(buf.toString());
    if (devLog.length > 80) devLog.shift();
  };
  dev.stdout.on("data", keep);
  dev.stderr.on("data", keep);
}

function lastDevLog() {
  const text = devLog.join("").trim();
  return text ? `\n--- wrangler dev 最后输出 ---\n${text.slice(-1500)}` : "";
}

function stopDev() {
  if (!dev || dev.killed) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(dev.pid)], { stdio: "ignore" });
    } else {
      process.kill(dev.pid, "SIGKILL");
    }
  } catch {
    // 已经死了就算了。
  }
  dev = null;
}

/**
 * 杀 workerd，不是杀 node。
 *
 * 这一步踩过坑：只杀父进程 `node`，`workerd.exe` 会变成孤儿继续服务，
 * 于是「杀掉后还能跑完」看起来成立，实际上进程根本没死。所以杀完要确认端口真的断了。
 */
function killWorkerd() {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/F", "/IM", "workerd.exe"], { stdio: "ignore" });
  } else {
    execFileSync("pkill", ["-f", "workerd"], { stdio: "ignore" });
  }
}

async function status() {
  const res = await fetch(`${BASE}/status`);
  return res.json();
}

async function getOp(id) {
  const res = await fetch(`${BASE}/op?id=${encodeURIComponent(id)}`);
  if (!res.ok) return { httpStatus: res.status, body: await res.json().catch(() => null) };
  return { httpStatus: res.status, body: await res.json() };
}

async function submitTask(operationId, text = PROMPT) {
  const res = await fetch(`${BASE}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, operationId }),
  });
  return { httpStatus: res.status, body: await res.json() };
}

async function waitSettled(operationId, timeoutMs = TASK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await getOp(operationId);
    if (body?.status === "done" || body?.status === "unanswered") return body;
    await sleep(1000);
  }
  return null;
}

// ---------------------------------------------------------------- scenarios

/**
 * 断电续跑：任务跑到一半把 workerd 杀掉，再拉起来，看它是否还在同一条会话上跑完。
 */
async function scenarioBreakResume() {
  const operationId = `receipt-${Date.now().toString(36)}`;
  const submitAt = Date.now();
  const submitted = await submitTask(operationId);
  step("submit", { status: submitted.httpStatus, body: submitted.body });
  check(
    "拿到回执",
    submitted.httpStatus === 200 && submitted.body.accepted === true,
    `session ${submitted.body.session}`,
  );

  const session = String(submitted.body.session);

  // 等它真的开始跑。queued 就说明还没进模型，这时候杀没意义。
  let sawRunning = false;
  const runningDeadline = Date.now() + 60_000;
  while (Date.now() < runningDeadline) {
    const { body } = await getOp(operationId);
    if (body?.status === "running") {
      sawRunning = true;
      step("observed running", { body });
      break;
    }
    if (body?.status === "done") break;
    await sleep(400);
  }
  check("杀之前已经在跑", sawRunning);

  if (!sawRunning) {
    notes.push("提交后没看到 running 就把任务跑完了，这次没有可中断的窗口，不算断电续跑。");
  } else {
    await sleep(KILL_AFTER_MS);

    killWorkerd();
    step("killed workerd", {
      at: new Date().toISOString(),
      note: `中止时已跑 ${Date.now() - submitAt}ms`,
    });

    const portDown = await waitFor(async () => !(await alive()), 20_000, 300);
    check("进程真的死了（端口不通）", portDown);

    // 只杀 workerd 不够：wrangler 的主进程还占着端口，第二个实例就起不来。
    // 第一次跑就是卡在这里 —— 所以把主进程一起收掉，等端口真空出来再重启。
    stopDev();
    await waitFor(async () => !(await alive()), 10_000, 300);
    await sleep(500);

    step("restart dev server");
    startDev();
    const back = await waitFor(alive, BOOT_TIMEOUT_MS);
    check("重启后服务恢复", back);
    if (!back) throw new Error(`重启失败${lastDevLog()}`);

    const duringRestart = await getOp(operationId);
    step("op right after restart", { body: duringRestart.body });
    check(
      "重启后回执还在，且是同一条会话",
      duringRestart.httpStatus === 200 && String(duringRestart.body?.session) === session,
      `session ${duringRestart.body?.session}`,
    );
  }

  const final = await waitSettled(operationId);
  const totalMs = Date.now() - submitAt;
  step("settled", {
    body: final ? { status: final.status, chars: final.text?.length ?? 0 } : null,
    note: `${totalMs}ms`,
  });

  check("最终拿到 done", final?.status === "done", final?.status ?? "timeout");
  check("答案不是空的", (final?.text?.length ?? 0) > 50, `${final?.text?.length ?? 0} 字符`);

  return {
    request: { operationId, session, prompt: PROMPT },
    timing: { submitToKillMs: sawRunning ? KILL_AFTER_MS : null, submitToDoneMs: totalMs },
    transcript: final?.text ? [{ role: "assistant", text: final.text.slice(0, 4000) }] : [],
  };
}

/**
 * 幂等：同一个 operationId 重发三次（提交后立刻、跑完之后），
 * 三次都必须拿到 accepted:false 并落回原会话，且整轮只新建一条会话。
 *
 * 最后那条最关键：幂等如果只对回执成立、对时间线不成立，同一件事就会变成两条。
 */
async function scenarioIdempotent() {
  const operationId = `receipt-${Date.now().toString(36)}`;

  const first = await submitTask(operationId);
  step("submit", { status: first.httpStatus, body: first.body });
  check("第一次提交被接受", first.body.accepted === true, `session ${first.body.session}`);
  const session = String(first.body.session);

  const second = await submitTask(operationId);
  step("resubmit immediately", { status: second.httpStatus, body: second.body });
  check("立刻重发不被接受", second.body.accepted === false);
  check("立刻重发落回原会话", String(second.body.session) === session, `session ${second.body.session}`);

  const mid = await getOp(operationId);
  step("op after resubmit", { body: mid.body });
  check("重发没有制造第二条任务", mid.httpStatus === 200, `status ${mid.body?.status}`);

  const final = await waitSettled(operationId);
  step("settled", { body: final ? { status: final.status, chars: final.text?.length ?? 0 } : null });
  check("任务跑完", final?.status === "done");

  const third = await submitTask(operationId);
  step("resubmit after done", { status: third.httpStatus, body: third.body });
  check("跑完之后重发也不被接受", third.body.accepted === false);
  check("跑完之后仍落回原会话", String(third.body.session) === session, `session ${third.body.session}`);

  const again = await getOp(operationId);
  step("op after done-resubmit", { body: again.body ? { status: again.body.status, chars: again.body.text?.length ?? 0 } : null });
  check("回执没有被第二次提交改写", again.body?.status === "done");

  return {
    request: { operationId, session, prompt: PROMPT },
    attempts: [first.body, second.body, third.body],
    transcript: final?.text ? [{ role: "assistant", text: final.text.slice(0, 4000) }] : [],
  };
}

/**
 * 同一个 operationId 换一段内容：必须被拦住，不能悄悄把新话塞进旧时间线。
 *
 * 这条规则是从 helsome/OpenDot 的审批账本照抄的：同一个 requestId + 同一份摘要
 * 才返回同一个结果，摘要不同就报冲突。我们原来没有摘要，于是「同 id 换内容」
 * 会走进 pi 的重复提交分支拿到 accepted: false —— 新那段话就没了，而且没人知道。
 *
 * 光验「返回 409」不够：要验跑出来的答案确实是第一段的。否则「先跑新的再报错」
 * 也能让 409 那条通过。
 */
async function scenarioReuse() {
  const operationId = `receipt-${Date.now().toString(36)}`;
  const A = "只回答一个字：一";
  const B = "只回答一个字：二";

  const first = await submitTask(operationId, A);
  step("submit A", { status: first.httpStatus, body: first.body });
  check("第一次提交被接受", first.body.accepted === true, `session ${first.body.session}`);
  const session = String(first.body.session);

  const clash = await submitTask(operationId, B);
  step("submit B with same id", { status: clash.httpStatus, body: clash.body });
  check("换内容被拦下", clash.httpStatus === 409, `status ${clash.httpStatus}`);
  check("错误码说得清是什么问题", clash.body.error === "operation_id_reused", clash.body.error);
  check(
    "没有为它新开一条时间线",
    String(clash.body.session) === session,
    `session ${clash.body.session}`,
  );

  const final = await waitSettled(operationId);
  step("settled", { body: final ? { status: final.status, chars: final.text?.length ?? 0 } : null });
  check("任务跑完", final?.status === "done");
  // 关键的一条：答案必须是 A 的。被拦下的 B 一个字都不该出现。
  const answer = final?.text ?? "";
  check("答案是第一段内容的，不是被拦那段", answer.includes("一") && !answer.includes("二"), answer.slice(0, 20));

  const replay = await submitTask(operationId, A);
  step("replay A", { status: replay.httpStatus, body: replay.body });
  check(
    "同一段内容重发仍按幂等处理",
    replay.httpStatus === 200 && replay.body.accepted === false,
    `accepted ${replay.body.accepted}`,
  );
  check("仍落回原会话", String(replay.body.session) === session, `session ${replay.body.session}`);

  return {
    request: { operationId, session, prompt: A, conflicting: B },
    attempts: [first.body, clash.body, replay.body],
    transcript: final?.text ? [{ role: "assistant", text: final.text.slice(0, 4000) }] : [],
  };
}

/**
 * 用量：跑一个任务前后，累计 token 和钱要跟着涨，而六十秒缓存期内不许重算。
 *
 * 两条一起验，是因为它们互相牵制：只验「涨了」看不出缓存是否生效，
 * 只验「缓存命中」会把一个永远不更新的死数字也判成通过。
 */
async function scenarioSpend() {
  const operationId = `receipt-${Date.now().toString(36)}`;

  const before = await fetch(`${BASE}/status?spend=fresh`).then((r) => r.json());
  step("spend before", { body: before.spend });
  check("用量账本存在", !!before.spend, before.spend?.scope);
  check("口径写明是累计", before.spend?.scope === "lifetime", String(before.spend?.scope));
  // 上限只拦自动提交，所以 status 必须把「今天总共几条」和「其中自动几条」分开。
  // 只报一个数的话，手动发的消息就无处安放，读起来像在说总账。
  check(
    "预算分得清自动和手动",
    typeof before.budget?.total === "number" && before.budget.total >= before.budget.used,
    `今天 ${before.budget?.total} 次（自动 ${before.budget?.used}、手动 ${before.budget?.manual}，上限 ${before.budget?.limit}）`,
  );
  const totalBefore = before.budget?.total ?? 0;

  const cached = await status();
  step("status again", { body: { at: cached.spend?.at, tokens: cached.spend?.tokens } });
  check("缓存期内不重算（同一份账）", cached.spend?.at === before.spend?.at);

  const submitted = await submitTask(operationId, "用一句话回答：一年有多少个月？不要调用任何工具。");
  step("submit", { status: submitted.httpStatus, body: submitted.body });
  check("任务被接受", submitted.httpStatus === 200 && submitted.body.accepted === true);

  const final = await waitSettled(operationId);
  step("settled", { body: final ? { status: final.status, chars: final.text?.length ?? 0 } : null });
  check("任务跑完", final?.status === "done", final?.status ?? "timeout");

  // 回执要能回答「这条跑了多久」。elapsedMs 是受理到发现结算的差，
  // 不是模型耗时（发现那一刻取决于谁先来问），所以这里只验它存在且为正。
  check(
    "回执答得出跑了多久",
    typeof final?.elapsedMs === "number" && final.elapsedMs > 0,
    `${final?.elapsedMs}ms`,
  );
  const again = await getOp(operationId);
  check(
    "再问一次，结算时间不变",
    again.body?.endedAt !== undefined && again.body.endedAt === final?.endedAt,
    `${final?.endedAt}`,
  );

  // 关键一条：任务已经跑完了，但缓存没过期，所以这时候读到的必须还是旧账。
  // 如果这里就变了，说明缓存没起作用，页面每分钟轮询都在扫全表。
  const stale = await status();
  step("status after task (cached)", { body: { at: stale.spend?.at, tokens: stale.spend?.tokens } });
  check(
    "缓存期内仍是旧账（说明没有每次都重算）",
    stale.spend?.tokens === before.spend?.tokens,
    `${before.spend?.tokens} → ${stale.spend?.tokens}`,
  );

  const fresh = await fetch(`${BASE}/status?spend=fresh`).then((r) => r.json());
  step("spend fresh", { body: fresh.spend });
  check(
    "强制重算后 token 涨了",
    (fresh.spend?.tokens ?? 0) > (before.spend?.tokens ?? 0),
    `${before.spend?.tokens} → ${fresh.spend?.tokens}（+${(fresh.spend?.tokens ?? 0) - (before.spend?.tokens ?? 0)}）`,
  );
  check(
    "钱跟着 token 一起涨",
    (fresh.spend?.cost ?? 0) >= (before.spend?.cost ?? 0),
    `$${(before.spend?.cost ?? 0).toFixed(6)} → $${(fresh.spend?.cost ?? 0).toFixed(6)}`,
  );
  check(
    "账记在具体模型名下",
    Array.isArray(fresh.spend?.models) && fresh.spend.models.some((m) => m.tokens > 0),
    (fresh.spend?.models ?? []).map((m) => `${m.name}=${m.tokens}`).join(", ") || "(空)",
  );
  check("没有假字段：工具用量是空数组而不是编出来的数", Array.isArray(fresh.spend?.tools));

  // 这一次是我们手动提交的：总数该 +1，而「自动」那一栏必须原地不动 ——
  // 如果它也跟着涨，说明两个计数器其实是同一个，等于又混在一起了。
  check(
    "手动提交也计入今天",
    fresh.budget?.total === totalBefore + 1,
    `${totalBefore} → ${fresh.budget?.total}`,
  );
  check(
    "自动那一栏没被手动带偏",
    fresh.budget?.used === before.budget?.used,
    `${before.budget?.used} → ${fresh.budget?.used}`,
  );

  return {
    request: { operationId, session: String(submitted.body.session) },
    before: before.spend,
    after: fresh.spend,
    transcript: final?.text ? [{ role: "assistant", text: final.text.slice(0, 4000) }] : [],
  };
}

// ---------------------------------------------------------------- runner

async function main() {
  if (await alive()) {
    console.error(`端口 ${PORT} 上已经有服务在跑。先停掉它 —— 这个脚本要自己控制生死。`);
    process.exit(1);
  }

  console.log(`\n=== ${NAME} ===\n`);

  step("start dev server");
  startDev();
  const up = await waitFor(alive, BOOT_TIMEOUT_MS);
  check("dev server 起来了", up, up ? `${Date.now() - startedAt}ms` : `超过 ${BOOT_TIMEOUT_MS}ms`);
  if (!up) throw new Error(`dev server 没起来${lastDevLog()}`);

  const before = await status();
  step("status before", {
    body: { model: before.model, sessions: before.sessions, budget: before.budget },
  });
  check("模型已就绪", before.ready === true, before.model);

  const scenarios = {
    "break-resume": scenarioBreakResume,
    idempotent: scenarioIdempotent,
    reuse: scenarioReuse,
    spend: scenarioSpend,
  };
  const run = scenarios[NAME];
  if (!run) throw new Error(`没有这个场景：${NAME}（可选 ${Object.keys(scenarios).join(" / ")}）`);
  const scenario = await run();

  const after = await status();
  step("status after", { body: { sessions: after.sessions, budget: after.budget } });

  // 一整轮只该多出一条会话。多出两条就说明幂等只对回执成立、对时间线没成立。
  check(
    "整轮只新增一条会话",
    after.sessions === before.sessions + 1,
    `${before.sessions} → ${after.sessions}`,
  );

  const ok = checks.every((c) => c.pass);

  const receipt = {
    kind: `memex.${NAME}`,
    scenario: NAME,
    observed: true,
    passed: ok,
    when: new Date().toISOString(),
    deploy: {
      target: `wrangler dev --local :${PORT}`,
      runtime: "Cloudflare Worker + Durable Object (SQLite), Local",
      model: before.model,
      note: "本地 workerd，不是线上；DO 状态在 .wrangler/state，重启后保留",
    },
    driver: `node scripts/receipt.mjs ${NAME}`,
    ...scenario,
    checks,
    steps,
    notes,
  };

  const dir = path.join(process.cwd(), "receipts");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${NAME}.json`);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  console.log(`\n${ok ? "全部通过" : "有检查没过"} → ${path.relative(process.cwd(), file)}`);
  console.log(`${checks.filter((c) => c.pass).length}/${checks.length} checks\n`);

  return ok;
}

try {
  const ok = await main();
  stopDev();
  await waitFor(async () => !(await alive()), 15_000, 300);
  process.exit(ok ? 0 : 2);
} catch (error) {
  console.error(`\n失败：${error instanceof Error ? error.message : String(error)}`);
  stopDev();
  await sleep(1500);
  process.exit(1);
}
