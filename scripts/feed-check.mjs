#!/usr/bin/env node
/**
 * 抓取层的自检：重试与失败分类。
 *
 * 为什么要专门测这个：三个默认源现在都走 hnrss，而它偶发 502。
 * 一次抓不到就等于这个源要等下一轮巡检（三小时）才再有机会，
 * 所以加了「5xx 重试一次、4xx 不重试」。这种分支不测，写错了没人知道 ——
 * 线上表现只是「偶尔某天少一个源」，看起来像对方的问题。
 *
 * 用本地起的桩服务，不碰网络：这样可以精确地造出「第一次 502、第二次 200」，
 * 也能数清楚到底请求了几次。真打公共服务的测试只能看运气。
 *
 *   node scripts/feed-check.mjs
 *
 * 退出码：有检查没过就是 2。
 */

import { createServer } from "node:http";
import { fetchFeed } from "../src/feeds.ts";

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const RSS = (title) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>桩</title>
<item><title>${title}</title><link>https://example.com/a</link><guid>a</guid></item>
</channel></rss>`;

/** 每个路径的命中次数，用来断言「到底重试了没有」。 */
const hits = new Map();

const server = createServer((req, res) => {
  const path = req.url ?? "/";
  hits.set(path, (hits.get(path) ?? 0) + 1);
  const n = hits.get(path);

  if (path === "/flaky") {
    // 第一次 502，第二次 200 —— 真实世界里 hnrss 的样子。
    if (n === 1) {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html><body>502 Bad Gateway</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(RSS("第二次才拿到的条目"));
    return;
  }

  if (path === "/always502") {
    res.writeHead(502, { "content-type": "text/html" });
    res.end("<html><body>502 Bad Gateway</body></html>");
    return;
  }

  if (path === "/missing") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  res.writeHead(200, { "content-type": "application/rss+xml" });
  res.end(RSS("正常条目"));
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`\n=== 抓取层自检（桩在 ${base}）===\n`);

try {
  // 1. 5xx 重试一次就该成功
  const flaky = await fetchFeed(`${base}/flaky`);
  check("502 之后重试，最终拿到条目", flaky.ok === true, flaky.ok ? flaky.items[0].title : flaky.error);
  check("确实只重试了一次（共 2 次请求）", hits.get("/flaky") === 2, `${hits.get("/flaky")} 次`);

  // 2. 一直 5xx：失败信息要说清重试过，而不是让人以为是一次偶发
  const dead = await fetchFeed(`${base}/always502`);
  check("一直 502 就报失败", dead.ok === false, dead.ok ? "竟然成功了" : "");
  check(
    "失败信息里写明重试过",
    !dead.ok && dead.error.includes("重试过一次"),
    !dead.ok ? dead.error : "",
  );
  check("两次都试了（共 2 次请求）", hits.get("/always502") === 2, `${hits.get("/always502")} 次`);

  // 3. 4xx 不该重试：地址本身错了，重试只是多打扰对方一次
  const missing = await fetchFeed(`${base}/missing`);
  check("404 报失败", missing.ok === false);
  check("404 不重试（共 1 次请求）", hits.get("/missing") === 1, `${hits.get("/missing")} 次`);

  // 4. 正常路径别被重试逻辑带坏
  const fine = await fetchFeed(`${base}/ok`);
  check("正常的源一次就拿到", fine.ok === true && fine.items.length === 1, fine.ok ? fine.items[0].title : fine.error);
  check("正常路径没有多余请求", hits.get("/ok") === 1, `${hits.get("/ok")} 次`);
} finally {
  server.close();
}

const ok = checks.every((c) => c.pass);
console.log(`\n${ok ? "全部通过" : "有检查没过"}  ${checks.filter((c) => c.pass).length}/${checks.length}\n`);
process.exit(ok ? 0 : 2);
