#!/usr/bin/env node
/**
 * HN 改道的自检：认得准、摊得开、剪得对。
 *
 * 为什么单独一个脚本：这段代码做的事是「把模型要的地址换成另一个地址」。
 * 换错了它不会报错 —— 它会去读一个 404，然后模型说「材料不足」，
 * 和改动之前一模一样失败，只是理由变了。所以三个边界必须钉死：
 *
 *   1. 只认 `/item?id=N`。认宽了（比如 `/user?id=`）会拿一个不存在的
 *      条目去请求接口，得到 404，比原来的 419 更没话说。
 *   2. 剪枝要报数。133 条的帖子只展开 60 条，剩下的 73 条必须写出来 ——
 *      不写，模型会以为这个讨论一共就 60 条。
 *   3. 单条截断也要报原长。同一条评论被截成 1200 字而不说，模型会拿
 *      「话说了一半」当成「话说完了」。
 *
 *   node scripts/hn-check.mjs
 *
 * 退出码：有检查没过就是 2。
 */

import { flattenThread, hnApiUrl, hnItemId } from "../src/hn.ts";

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const id = (href) => hnItemId(new URL(href));

// 1. 认得出
check("认出讨论页", id("https://news.ycombinator.com/item?id=50484737") === 50484737);
check("认出带 # 锚点的链接", id("https://news.ycombinator.com/item?id=1#c2") === 1);
check("认出 hn. 前缀", id("https://hn.ycombinator.com/item?id=42") === 42);
check("http 也认", id("http://news.ycombinator.com/item?id=7") === 7);

// 2. 认不出的一律不认 —— 这是「换错地址」唯一的防线
check("不认用户页", id("https://news.ycombinator.com/user?id=pg") === undefined);
check("不认站点过滤页", id("https://news.ycombinator.com/from?site=cloudflare.com") === undefined);
check("不认首页", id("https://news.ycombinator.com/") === undefined);
check("不认非数字 id", id("https://news.ycombinator.com/item?id=abc") === undefined);
check("不认空 id", id("https://news.ycombinator.com/item?id=") === undefined);
check("不认 0", id("https://news.ycombinator.com/item?id=0") === undefined);
check("不认长得像的域名", id("https://news.ycombinator.com.evil.test/item?id=1") === undefined);
check("不认子域伪装", id("https://x.news.ycombinator.com/item?id=1") === undefined);
check("不认别的站的 /item", id("https://example.com/item?id=1") === undefined);
check("不认深层路径", id("https://news.ycombinator.com/item/1") === undefined);

// 3. 接口地址拼法钉死：拼法一改，所有请求会打到一个 404 上，而且不报错
check("接口地址", hnApiUrl(50484737) === "https://hn.algolia.com/api/v1/items/50484737", hnApiUrl(50484737));

// 4. 摊平：标题块
const story = {
  id: 1,
  author: "kentonv",
  created_at: "2025-03-04T18:00:00.000Z",
  points: 96,
  title: "Workerd: Open-source Cloudflare workers runtime",
  url: "https://blog.cloudflare.com/workerd/",
  text: null,
  children: [
    {
      author: "alice",
      created_at: "2025-03-04T19:00:00.000Z",
      text: "<p>Is this just to cover their tracks so startups don&#x27;t get locked in?</p>",
      children: [
        {
          author: "bob",
          created_at: "2025-03-04T20:00:00.000Z",
          text: "<p>Partly. But also <i>real</i> portability &amp; docs.</p>",
          children: [],
        },
      ],
    },
    { author: "carol", created_at: "2025-03-04T21:00:00.000Z", text: "Plain text, no tags.", children: [] },
  ],
};

const thread = flattenThread(story);
check("标题进正文", thread.text.includes("标题：Workerd"), thread.text.split("\n")[0]);
check("作者与分数进正文", thread.text.includes("kentonv") && thread.text.includes("96 分"));
check("外部链接进正文", thread.text.includes("https://blog.cloudflare.com/workerd/"));
check("数对了评论条数", thread.total === 3, `total=${thread.total}`);
check("全展开时不剪枝", thread.shown === 3, `shown=${thread.shown}`);
check("实体解码 &#x27;", thread.text.includes("don't get locked in"));
check("命名实体解码 &amp;", thread.text.includes("real portability & docs"));
check("去掉行内标签", !thread.text.includes("<i>"));

// 5. 缩进就是层级 —— 回复必须紧跟在父评论下面，且比它深一层
const lineOf = (needle) => thread.text.split("\n").find((line) => line.includes(needle)) ?? "";
check("父评论顶格", /^\[1\] alice/.test(lineOf("alice")), JSON.stringify(lineOf("alice")));
check("回复缩进一层", lineOf("bob").startsWith("  [2] "), JSON.stringify(lineOf("bob")));
check("回复的正文也缩进", lineOf("Partly").startsWith("    "), JSON.stringify(lineOf("Partly")));
check("第二条父评论不缩进", /^\[3\] carol/.test(lineOf("carol")));
check("编号按阅读顺序", thread.text.indexOf("[1]") < thread.text.indexOf("[2]") && thread.text.indexOf("[2]") < thread.text.indexOf("[3]"));

// 6. 空讨论：不能只说「共 0 条」就完事，得说清是「真没有」而不是「没读到」
const empty = flattenThread({ title: "Show HN: nothing", author: "x", created_at: "2026-11-13T00:00:00.000Z", children: [] });
check("零评论明说一条都没有", empty.text.includes("一条评论都没有"), empty.text.split("\n").slice(-1)[0]);
check("零评论不伪装成材料不足", !/读不到|失败|错误/.test(empty.text));

// 7. 剪枝：超过上限要停下来，并报出丢了多少
const wide = {
  title: "big thread",
  author: "x",
  created_at: "2026-11-13T00:00:00.000Z",
  children: Array.from({ length: 10 }, (_, i) => ({
    author: `u${i}`,
    created_at: "2026-11-13T00:00:00.000Z",
    text: `comment ${i}`,
    children: Array.from({ length: 2 }, (_, j) => ({
      author: `r${i}${j}`,
      created_at: "2026-11-13T00:00:00.000Z",
      text: `reply ${i}-${j}`,
      children: [],
    })),
  })),
};
const cut = flattenThread(wide, 5);
check("按上限停下", cut.shown === 5, `shown=${cut.shown}`);
check("丢掉的条数报出来了", cut.text.includes("还有 25 条没展开"), cut.text.split("\n").slice(-1)[0]);
check("总数仍是 30", cut.total === 30, `total=${cut.total}`);

// 8. 单条超长：截断必须报原长
const long = flattenThread({
  title: "t",
  children: [{ author: "a", created_at: "2026-11-13T00:00:00.000Z", text: "x".repeat(3000), children: [] }],
});
check("超长评论被截", !long.text.includes("x".repeat(1300)));
check("截断处写了原长", long.text.includes("这条原长 3000 字符"), "不然模型以为话说完了");

// 9. 已删除的评论：不该占正文，但也不该让编号错乱
const gone = flattenThread({
  title: "t",
  children: [
    { author: null, created_at: "2026-11-13T00:00:00.000Z", text: null, children: [] },
    { author: "live", created_at: "2026-11-13T00:00:00.000Z", text: "still here", children: [] },
  ],
});
check("删掉的评论不进正文", !gone.text.includes("被删了") || gone.shown === 1, `shown=${gone.shown}`);
check("活着的评论编号从 1 开始", gone.text.includes("[1] live"));

// 10. 缺字段不抛 —— 接口返回的形状不受我们控制
const bare = flattenThread({});
check("空对象也能摊", typeof bare.text === "string" && bare.text.includes("（无标题）"));

const failed = checks.filter((c) => !c.pass);
console.log();
console.log(`${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) {
  console.log("\n没过的：");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(2);
}
