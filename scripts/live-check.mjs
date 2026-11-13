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
 *   RUN_INGEST=1 现在就让线上跑一轮抓取（换过源之后用它证明「打得到」，而不是等下一次定时）
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = (process.env.BASE || "").replace(/\/$/, "");
const TOKEN = process.env.MEMEX_TOKEN || "";
const OUT = process.env.OUT || "receipts/live.json";
const SKIP_GOAL = process.env.SKIP_GOAL === "1";
const RUN_INGEST = process.env.RUN_INGEST === "1";

/**
 * 摄取周期。这个数只活在 worker 里（`INGEST_EVERY_MS`），脚本里复制一份是
 * 有意的：如果哪天 worker 改了间隔而这个断言没跟着改，它要么误报要么失效，
 * 两种都会被人看见 —— 比偷偷跟着变好。
 */
const INGEST_EVERY_MS = 3 * 60 * 60 * 1000;

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
  // 比对前统一折成 LF。
  //
  // 这台机器 `core.autocrlf=true`，工作区是 CRLF；而检出仓库文件时是什么换行，
  // 取决于检出环境（Windows 上 CRLF，Linux runner 上 LF）。不归一化的话，
  // 同一个文件会算出两个哈希 —— 断言红了，内容和部署版本却毫无问题。
  // 今天就是在这个坑上撞了一下：用 GitHub API 推上去的 blob 带着 CRLF，
  // 本地 git 对象里是 LF，两边树哈希对不上，而 `git diff` 又说没差异。
  //
  // 折成 LF 之后比的仍然是内容，只是不再把「换行风格」算进差异里。
  // 少盯一类差异不值得心疼 —— 它要抓的是「部署的不是这一版」，
  // 不是「这一版被谁重排了换行」。
  const asText = (buf) => Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  const pageRes = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(20_000) });
  const pageBytes = Buffer.from(await pageRes.arrayBuffer());
  const liveHash = createHash("sha256").update(asText(pageBytes)).digest("hex");
  const localBytes = await readFile(path.resolve("public/index.html"));
  const localHash = createHash("sha256").update(asText(localBytes)).digest("hex");
  check("公网能拿到页面", pageRes.status === 200 && pageBytes.length > 1000, `${pageRes.status}, ${pageBytes.length} 字节`);
  check(
    "线上那一页和仓库里这一页是同一份内容",
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

  // 上一次抓取到底抓到了什么。
  //
  // 这一段以前没验：`/routines` 只验了「节奏在」，于是「定时器在转」和
  // 「源真的抓得到」在线上长得一模一样。而今天本机打 hnrss 三个订阅全是
  // 502，从上午 11:24 到 18:04 一直没好 —— 偏偏那三个源承载了全部 HN 内容。
  // 没有这一条，线上到底抓没抓到，只能靠猜。
  const ingestLast = rIngest?.last;
  step(
    "上一次抓取",
    ingestLast
      ? {
          at: new Date(ingestLast.at).toISOString(),
          feeds: ingestLast.feeds,
          fresh: ingestLast.fresh,
          submitted: ingestLast.submitted,
          skipped: ingestLast.skipped,
        }
      : "还没跑过",
  );
  check("上一次抓取留下了记录", !!ingestLast && typeof ingestLast.at === "number");

  const down = ingestLast?.failed ?? [];
  const total = ingestLast?.feeds ?? 0;
  if (down.length) {
    step("抓不到的源", down.map((f) => `${f.feed} → ${f.error}`).join(" ｜ "));
  }
  // 「有源坏」是外部事实，不该红；「全坏」才是它其实什么都没看。这两件事分开。
  check("抓取不是全军覆没", total > 0 && down.length < total, `${total - down.length}/${total} 通`);

  // 换过源之后，只读「上一轮的结果」是不够的 —— 上一轮可能是旧源跑的。
  // 这一段让线上当场跑一轮，验的是「worker 从这个网络里打得到这几个新地址」。
  // 今天整件事的教训就在这儿：定时器在转、`ingest.last` 有记录，都不等于抓到了东西。
  if (RUN_INGEST) {
    // 结算的账要能对上：这一轮说收了几条，待判就该少几条。
    // 不看这个数，「settled: 1」和「状态里还是 pending」可以同时成立 ——
    // 那正是今天那条卡了 9 小时的记录的处境。
    const pre = await http("/status");
    const pendingBefore = pre.body?.inbox?.pending;

    const ran = await http("/ingest/run", { method: "POST" }, 120_000);
    const r = ran.body ?? {};
    const post = await http("/status");
    const pendingAfter = post.body?.inbox?.pending;
    step("刚跑的一轮抓取", {
      at: r.at ? new Date(r.at).toISOString() : null,
      feeds: r.feeds,
      failed: (r.failed ?? []).length,
      fresh: r.fresh,
      submitted: r.submitted,
      settled: r.settled,
      skipped: r.skipped,
      pending: `${pendingBefore} → ${pendingAfter}`,
      baselined: r.baselined ?? 0,
    });
    if ((r.failed ?? []).length) {
      step("这一轮坏掉的源", r.failed.map((f) => `${f.feed} → ${f.error}`).join(" ｜ "));
    }
    check("当场跑一轮也拿到了结果", ran.status === 200 && typeof r.at === "number", `${ran.status}`);
    check("当场这一轮没有源报错", r.feeds > 0 && (r.failed ?? []).length === 0, `${(r.feeds ?? 0) - (r.failed ?? []).length}/${r.feeds ?? 0} 通`);
    if (r.baselined) step("这一轮只是基线", `${r.baselined} 个源第一次接上，一条都不提交`);

    // 新提交的条目必须带着「哪份材料、哪个模型」。
    //
    // 只在真的提交了东西时才验：`submitted` 为 0 时收件箱里全是旧记录，
    // 而旧记录本来就没有这两个字段 —— 拿它们去断言，红的是历史，不是代码。
    if (r.submitted > 0) {
      const box = await http("/inbox?all=1");
      const items = box.body.items ?? [];
      const fresh = items.slice(0, r.submitted);
      const withFp = fresh.filter((i) => typeof i.fp === "string" && i.fp.length > 0);
      check("新提交的条目带材料指纹", withFp.length === fresh.length, `${withFp.length}/${fresh.length}`);
      const withModel = fresh.filter((i) => typeof i.model === "string" && i.model.length > 0);
      check("新提交的条目记了判定模型", withModel.length === fresh.length, `${withModel.length}/${fresh.length}`);
      step("指纹样本", fresh.map((i) => `${i.fp} @ ${i.model}`).join(" ｜ ").slice(0, 200));
    }
  }

  // 待判不能无限期地待着。
  //
  // 一条提交出去的任务，正常情况下最晚在下一次摄取（3 小时一次）就被结算掉 ——
  // settle() 每轮都会把「pi 已经不在跑」的全搬走。所以熬过一个完整周期再加
  // 巡检的 30 分钟容差还挂着的，只有两种可能：结算坏了，或者 pi 把它弄丢了。
  // 两种都不该靠人去翻收件箱才发现。
  {
    const box = await http("/inbox?all=1");
    const items = box.body.items ?? [];
    const stale = items.filter((i) => i.state === "pending" && Date.now() - i.at > INGEST_EVERY_MS + 30 * 60_000);
    const worst = items.filter((i) => i.state === "pending").sort((a, b) => a.at - b.at)[0];
    step(
      "最老的一条待判",
      worst ? `${worst.id} 已挂 ${Math.round((Date.now() - worst.at) / 60_000)} 分钟` : "没有待判的",
    );
    check(
      "没有熬过一个摄取周期的待判",
      stale.length === 0,
      stale.length ? stale.map((i) => `${i.id} ${Math.round((Date.now() - i.at) / 60_000)} 分钟`).join(" ｜ ") : "",
    );

    // 理由和证据要对得上。
    //
    // 跳过理由里最常见的一句是「正文只有 3395 字符」—— 它说读了三千多字。
    // 在那之前，没有任何地方存着那 3395 字是从哪来的：`given` 只有 63。
    // 现在 reads 记了。所以这条断言问的是：**你既然说读了，记录里就得有那次读**。
    // 只在 `reads` 存在（新代码结算的）并且理由里报了数字时才问 —— 旧记录没有
    // 这个字段，拿它去断言，红的是历史不是代码。
    const claim = /(\d{3,})\s*字符/;
    const claims = items.filter((i) => i.reads !== undefined && claim.test(i.verdict?.why ?? ""));
    const missing = claims.filter((i) => !(i.reads ?? []).some((r) => typeof r.chars === "number"));
    step("理由报了字数且带 reads 的条目", `${claims.length} 条`);
    check(
      "理由说读到了字数，记录里就有那次读取",
      missing.length === 0,
      missing.length ? missing.map((i) => i.id).join(" ｜ ") : "",
    );
  }

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


  // ── 6. 它看什么：口径
  //
  // 为什么这条必须在线上验：`want` 存在 Durable Object 里，改代码不会动它
  // （ADR 010）。所以「仓库里的口径改了」和「线上在按新口径判」是两件事，
  // 而这条断言是它们之间唯一可验证的连接 —— 少了它，一次 `--sync-want`
  // 静默失败可以连着几个星期没人发现，表现只是「判定好像不太对」。
  //
  // 它验「读得出来」，不验「写得对」：后者要等真的有判定发生，
  // 而那要看 /inbox 里的 verdict。
  const feeds = await http("/feeds");
  const list = feeds.body.feeds ?? [];
  step("它现在看几个源", { feeds: list.length });
  const shaped = list.filter((f) => f.brief && typeof f.brief.about === "string" && f.brief.about.trim());
  check("每个源都读得出「我要什么」", list.length > 0 && shaped.length === list.length, `${shaped.length}/${list.length}`);
  const avoided = list.filter((f) => typeof f.brief?.avoid === "string" && f.brief.avoid.trim());
  check("至少一个源写了「我不要的」", avoided.length > 0, `${avoided.length}/${list.length}`);

  // ── 7. 真跑一个任务：提交、拿回执、等它自己跑完
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

  // ── 8. 目标：线上这一层也能推一轮
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
