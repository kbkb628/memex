#!/usr/bin/env node
/**
 * 线上档的唯一验收：从公网打那个已经部署的实例。
 *
 * 为什么这个脚本不在本地跑：这台机器到 Cloudflare 边缘是整体不通的
 * （本地 DNS 把 *.workers.dev 污染到 108.160.165.212，绕过 DNS 直接打真实 IP
 * 173.255.209.47 也 15 秒超时，另外试了五个边缘 IP 全部 000）。
 * 所以「部署后的真实请求」这一档只能从别的机器发起 —— 这里是 GitHub 的 runner。
 *
 * 它和 `receipt.mjs` 的区别：那个自己拉起 wrangler dev、自己杀进程，验的是
 * 「代码在 workerd 上能不能活」；这个只发 HTTP，验的是「部署出去的那一份
 * 在公网上真的能应答、真的能跑完一个任务」。两件事都成立才算完整。
 *
 *   BASE=https://xxx.workers.dev MEMEX_TOKEN=... node scripts/live-check.mjs
 *
 * 环境变量：
 *   BASE         线上地址，不带 token
 *   MEMEX_TOKEN  访问 token
 *   OUT          产物路径，默认 receipts/live.json
 *   SKIP_GOAL=1  跳过目标那一节（省钱，或者线上还是旧版本时）
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = (process.env.BASE || "").replace(/\/$/, "");
const TOKEN = process.env.MEMEX_TOKEN || "";
const OUT = process.env.OUT || "receipts/live.json";
const SKIP_GOAL = process.env.SKIP_GOAL === "1";

if (!BASE) throw new Error("BASE 没设：给一个线上地址，比如 https://xxx.workers.dev");
if (!TOKEN) throw new Error("MEMEX_TOKEN 没设：线上配了 ACCESS_TOKENS 之后，所有数据接口都要带它");

const checks = [];
const steps = [];
const began = Date.now();

function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return pass;
}

function step(name, info) {
  const at = Date.now() - began;
  steps.push({ at, name, info });
  console.log(`· [${String(at).padStart(6)}ms] ${name}${info === undefined ? "" : ` — ${typeof info === "string" ? info : JSON.stringify(info)}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 所有请求都关掉重试：这一档要的正是「第一次就通」。 */
async function http(pathname, init = {}, timeout = 30_000) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { ...(init.headers || {}), ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 不是 JSON 就留着原文，/health 本来就是纯文本。
  }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  console.log(`\n打的是 ${BASE}\n`);

  // ── 1. 健康检查：这一条顺带证明「公网真的能到这个实例」
  const health = await http("/health");
  check("公网能打到 /health", health.status === 200 && String(health.body).includes("ok"), `${health.status}`);

  // ── 2. 线上那一页，就是仓库里的这一页
  //
  // 这条治的是「部署是旧的」，而它恰好是别的断言全都抓不到的一种坏法：
  // `wrangler deploy` 成功只说明传上去了一个版本，不说明传的是你现在手上这份。
  // 改完页面忘了重新部署，人打开看到的还是上个月的界面，而下面每一条接口断言
  // 照样全绿 —— 因为它们根本不打页面。
  //
  // 用逐字节比对而不是「包含某个标题」：后者在改文案、改版式时永远为真，
  // 在真的部署旧版本时也可能为真（旧版本也有那个标题）。
  const pageRes = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(20_000) });
  const pageBytes = Buffer.from(await pageRes.arrayBuffer());
  const liveHash = createHash("sha256").update(pageBytes).digest("hex");
  const localBytes = await readFile(path.resolve("public/index.html"));
  const localHash = createHash("sha256").update(localBytes).digest("hex");
  check("公网能拿到页面", pageRes.status === 200 && pageBytes.length > 1000, `${pageRes.status}, ${pageBytes.length} 字节`);
  check(
    "线上那一页和仓库里这一页逐字节相同",
    liveHash === localHash,
    `${liveHash.slice(0, 12)} vs ${localHash.slice(0, 12)}`,
  );
  step("页面", { bytes: pageBytes.length, sha256: liveHash.slice(0, 16) });

  // ── 3. 鉴权在线上是真的生效的
  const anon = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(20_000) });
  check("不带 token 打 /status → 401", anon.status === 401, `${anon.status}`);

  // ── 4. 带了 token 就该给全量状态
  const status = await http("/status");
  const ok3 = check("/status 带 token → 200", status.status === 200, `${status.status}`);
  if (!ok3) throw new Error(`带 token 也进不去：${JSON.stringify(status.body).slice(0, 200)}`);
  check("返回里有模型名", typeof status.body.model === "string" && status.body.model.length > 0, status.body.model);
  check("返回里有预算", !!status.body.budget && typeof status.body.budget.limit === "number", JSON.stringify(status.body.budget));
  step("线上状态", {
    model: status.body.model,
    feeds: status.body.feeds,
    inbox: status.body.inbox,
    budget: status.body.budget,
  });

  // ── 5. 它自己会醒：这一档最该验的其实是这个
  //
  // 关键区别：「排期存在」和「到点真的醒过」是两件事。
  // 第一次跑这个脚本时实例刚部署，`last` 还是空的，只能验排期；
  // 等那一轮真的到期执行之后，`last` 就有了内容 —— 那才是醒过的证据。
  // 所以这里两条都写：有 last 就断言它，没有就看下一次够不够近、够近就等。
  const patrol = await http("/patrol");
  const next = patrol.body.next;
  check("/patrol 有下一次的时间", patrol.status === 200 && typeof next === "number", `next=${next}`);

  const last = patrol.body.last;
  if (last && typeof last.at === "number") {
    check("上一轮巡检真的执行过", last.at <= Date.now(), new Date(last.at).toISOString());
    step("上一次巡检", {
      at: new Date(last.at).toISOString(),
      scanned: last.scanned,
      retried: (last.retried ?? []).length,
      stuck: (last.stuck ?? []).length,
      goals: (last.goals ?? []).length,
    });
  } else {
    step("还没醒过", "这个实例部署后还没跑过巡检，只能验排期");
  }

  // /routines：两条定时动作，连同节奏一起给出来。
  // 重点不是「有返回」，而是**节奏由服务端给** —— 上一版页面只能把 24 小时硬编码进 HTML，
  // 改后端的那天没人会记得改页面。这条断言锁的就是这两件事不要退化。
  const routines = await http("/routines");
  const rs = routines.body.routines;
  check("/routines 返回两条定时", routines.status === 200 && Array.isArray(rs) && rs.length === 2, `${rs?.length} 条`);
  const rIngest = Array.isArray(rs) ? rs.find((r) => r.id === "ingest") : null;
  const rPatrol = Array.isArray(rs) ? rs.find((r) => r.id === "patrol") : null;
  check(
    "每条都带节奏（不是页面自己猜的）",
    typeof rIngest?.everyMs === "number" && typeof rPatrol?.everyMs === "number",
    `ingest=${rIngest?.everyMs} patrol=${rPatrol?.everyMs}`,
  );
  check("每条都带下一次时间", typeof rIngest?.next === "number" && typeof rPatrol?.next === "number");

  if (typeof next === "number") {
    const waitMs = next - Date.now();
    step("下一次巡检", waitMs > 0 ? `${Math.round(waitMs / 1000)} 秒后` : "已过期");
    check("下一次巡检排在未来", waitMs > 0, `${Math.round(waitMs / 1000)} 秒`);

    // 三分钟内到期就等 —— 这是唯一能在一个 workflow 里看到「到点真的醒」的机会。
    // 更远的不等：巡检一天一次，等不起，也不该假装验过。
    if (waitMs > 0 && waitMs < 180_000) {
      step("等它自己醒", `${Math.round(waitMs / 1000)} 秒`);
      await sleep(waitMs + 8_000);
      const after = await http("/patrol");
      const woke = after.body.last;
      check("到点真的醒过", !!woke && typeof woke.at === "number" && woke.at >= next - 3_000, woke ? new Date(woke.at).toISOString() : "last 还是空");
      check(
        "醒过之后自己排了下一轮",
        typeof after.body.next === "number" && after.body.next > Date.now() + 60_000,
        `${Math.round((after.body.next - Date.now()) / 60000)} 分钟后`,
      );
    }
  }


  // ── 6. 真跑一个任务：提交、拿回执、等它自己跑完
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const probe = `用一句话回答：${stamp} 这个时间戳的年份是多少？只回一个数字。`;
  const operationId = `live-${stamp}`;
  const submit = await http("/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: probe, operationId }),
  });
  check("提交拿到回执", submit.status === 200 && submit.body.accepted === true, JSON.stringify(submit.body).slice(0, 160));
  if (submit.status !== 200) throw new Error(`提交失败：${JSON.stringify(submit.body).slice(0, 200)}`);
  const session = String(submit.body.session);
  step("已受理", { operationId, session });

  // 同一个 id 同一段文字重发：线上这一层也得是幂等的
  const again = await http("/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: probe, operationId }),
  });
  check("同 id 同文字重发被判重复", again.body.accepted === false, `accepted=${again.body.accepted}`);
  check("重发落回同一条会话", String(again.body.session) === session, `${again.body.session}`);

  // 等它跑完，最多四分钟
  const deadline = Date.now() + 240_000;
  let final = null;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(3000);
    polls++;
    const op = await http(`/op?id=${encodeURIComponent(operationId)}`, {}, 20_000);
    if (op.body?.live) continue;
    final = op.body;
    break;
  }
  if (!final) {
    check("四分钟内跑完", false, `轮询了 ${polls} 次`);
    throw new Error("线上那一次提交在四分钟内没有结算");
  }
  const answered = typeof final.text === "string" && final.text.trim().length > 0;
  check("线上跑完了，且答案是空的以外的东西", final.status === "done" && answered, `${final.status}, ${(final.text ?? "").length} 字符`);
  check("回执答得出跑了多久", typeof final.elapsedMs === "number" && final.elapsedMs > 0, `${final.elapsedMs}ms`);
  check("答案答到了问的那件事", String(final.text ?? "").includes("2026"), (final.text ?? "").slice(0, 60));

  // ── 7. 目标：线上这一层也能推一轮
  if (SKIP_GOAL) {
    step("目标", "跳过（SKIP_GOAL=1）");
  } else {
    const goal = await http("/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: "用一句话说明 Durable Objects 为什么能保证串行写入",
        criteria: ["answer_contains:串行"],
        maxRuns: 2,
      }),
    });
    const created = goal.status === 200;
    check("线上能建目标", created, created ? goal.body.id : JSON.stringify(goal.body).slice(0, 160));
    if (created) {
      const id = goal.body.id;
      check("建完就起了第一轮", typeof goal.body.pendingOp === "string", goal.body.pendingOp);
      let g = goal.body;
      const gDeadline = Date.now() + 240_000;
      while (Date.now() < gDeadline && (g.status === "running" || g.status === "waiting")) {
        await sleep(4000);
        const adv = await http("/goals/advance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        g = adv.body;
      }
      check("线上目标有结论（done 或 failed）", g.status === "done" || g.status === "failed", `${g.status}: ${g.endedWhy}`);
      step("目标", { id, status: g.status, runs: g.runs, why: g.endedWhy });
    }
  }

  // ── 收尾
  const ok = checks.every((c) => c.pass);
  const receipt = {
    kind: "memex.live",
    scenario: "live",
    observed: true,
    passed: ok,
    when: new Date().toISOString(),
    deploy: {
      target: BASE,
      // 发起方是谁很重要：读这份凭证的人会以为是在我们自己的机器上打的。
      from: process.env.GITHUB_ACTIONS ? `github-actions (${process.env.RUNNER_NAME ?? "runner"})` : "local",
      why: "这台开发机到 Cloudflare 边缘整体不通（DNS 污染 + 直连真实 IP 超时），所以从公网 runner 发起",
      runtime: "Cloudflare Workers + Durable Object (SQLite), 线上",
    },
    driver: "node scripts/live-check.mjs",
    request: { operationId, session, probe },
    checks,
    steps,
    note: "线上实例有自己的一份 SQLite，和本地的数据不是一份；这里的会话号、收件箱都只属于线上那个对象。",
  };

  await mkdir(path.dirname(path.resolve(OUT)), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`\n${ok ? "全部通过" : "有检查没过"} → ${OUT}`);
  console.log(`${checks.filter((c) => c.pass).length}/${checks.length} checks\n`);
  return ok;
}

try {
  const ok = await main();
  process.exit(ok ? 0 : 2);
} catch (error) {
  console.error(`\n失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
