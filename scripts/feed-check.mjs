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
import { fetchFeed, hash, makeWant, parseHnSearch, readWant } from "../src/feeds.ts";

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

  if (path === "/hn") {
    // HN 搜索接口的形态：JSON、content-type 是 application/json。
    // 这里要验的是「同一个入口按 content-type 分派」，不是 DNS 或域名白名单 ——
    // 桩服务的地址是 127.0.0.1，任何按域名判断的写法都会在这里现原形。
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        hits: [
          {
            objectID: "41000001",
            title: "Why we moved off Durable Objects",
            url: "https://example.com/post",
            points: 59,
            num_comments: 13,
            created_at_i: 1794000000,
          },
          {
            objectID: "41000002",
            title: "Ask HN: how do you persist agent state?",
            url: null,
            points: 21,
            num_comments: 4,
            story_text: "我们在找一个能长期跑的做法。",
            created_at_i: 1794100000,
          },
        ],
      }),
    );
    return;
  }

  if (path === "/hn-empty") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hits: [] }));
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
  // 6. JSON 也从同一个入口进来（HN 搜索接口）
  const hn = await fetchFeed(`${base}/hn`);
  check("按 content-type 分派：JSON 也能抓", hn.ok === true, hn.ok ? `${hn.items.length} 条` : hn.error);
  if (hn.ok) {
    const first = hn.items.find((i) => i.title.startsWith("Why we moved"));
    check("标题解析出来了", !!first, first?.title);
    check("外链帖的 link 用原文地址", first?.link === "https://example.com/post", first?.link);
    check("分数和评论数进了摘要", !!first?.summary.includes("59 分") && !!first?.summary.includes("13 条评论"), first?.summary.slice(0, 40));
    check("时间解析出来了", first?.publishedAt === 1794000000 * 1000, String(first?.publishedAt));

    const ask = hn.items.find((i) => i.title.startsWith("Ask HN"));
    check("没有外链时退回讨论页", ask?.link === "https://news.ycombinator.com/item?id=41000002", ask?.link);
    check("正文进了摘要", !!ask?.summary.includes("长期跑"), ask?.summary.slice(0, 40));
  }

  const emptyHn = await fetchFeed(`${base}/hn-empty`);
  check("一条都没命中时报「关键词太窄」", emptyHn.ok === false && emptyHn.error.includes("关键词"), emptyHn.ok ? "竟然成功了" : emptyHn.error);
} finally {
  server.close();
}

// 5. 两栏的读写：老数据是字符串，新数据是对象，两种都得认。
//    这里锁的是「不迁移也能跑」——线上已经存了 5 个源，
//    如果这里只认新形状，部署那一刻它们会全部变成空 want。
const old = readWant("我要持久执行的坑");
check("老形态（字符串）读成 about 一栏", old.about === "我要持久执行的坑" && old.avoid === undefined);

const both = readWant({ about: "踩坑记录", avoid: "招聘" });
check("新形态（两栏）原样读出", both.about === "踩坑记录" && both.avoid === "招聘");

check("没填 avoid 时写回去还是一个字符串", makeWant("踩坑记录") === "踩坑记录");
check(
  "填了 avoid 才升级成对象",
  JSON.stringify(makeWant("踩坑记录", " 招聘 ")) === JSON.stringify({ about: "踩坑记录", avoid: "招聘" }),
);
check("空 avoid 等于没填", makeWant("踩坑记录", "   ") === "踩坑记录");

// 7. 纯解析：id 要稳定，垃圾输入不能抛
const raw = JSON.stringify({ hits: [{ objectID: 123, title: "同一个帖子", url: "https://a.example/x", points: 30 }] });
const once = parseHnSearch(raw);
const twice = parseHnSearch(raw);
check("同一个帖子两次解析出同一个 id", once[0]?.id === twice[0]?.id, once[0]?.id);
check("id 不含链接（换外链不该让它重新出现）", once[0]?.id !== hash("https://a.example/x"));
check("坏 JSON 不抛，返回空", parseHnSearch("{ 这不是 json").length === 0);
check("hits 不是数组也返回空", parseHnSearch(JSON.stringify({ hits: "nope" })).length === 0);
check("没有标题的条目丢掉", parseHnSearch(JSON.stringify({ hits: [{ objectID: 1, url: "https://x.example" }] })).length === 0);

const ok = checks.every((c) => c.pass);
console.log(`\n${ok ? "全部通过" : "有检查没过"}  ${checks.filter((c) => c.pass).length}/${checks.length}\n`);
process.exit(ok ? 0 : 2);
