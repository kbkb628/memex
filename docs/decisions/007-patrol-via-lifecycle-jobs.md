# 007 · 巡检走 Lifecycle 的 job 队列，不碰 alarm

**状态**：已实测
**日期**：2026-11-04

## 背景

第 2 步是让它自己醒。第一反应是：

```ts
await this.ctx.storage.setAlarm(Date.now() + DAY);
async alarm() { /* 巡检 */ }
```

**这么写会把 pi 的唤醒机制废掉，而且症状极具欺骗性。**

## 为什么不能碰 alarm

一个 Durable Object 只有一个 alarm。pi 的 Lifecycle 已经占着它：
对象被驱逐后，是那个 alarm 把对象拉起来，`pi.wake()` 才接着跑没做完的任务。

自己调 `setAlarm()` 会覆盖它。之后的症状是：

- 提交照常成功，回执照常在
- 重启后任务能恢复（那走的是 DO 自己的存储与 Lifecycle 的 job 队列）
- **但某一天开始，任务永远停在 `running`，谁也不知道为什么**

查起来会非常费劲，因为「alarm 被谁覆盖」这件事没有任何报错，只有行为差异。
这种 bug 不会在演示里出现，只会在别人 fork 走跑了三天之后出现。

## 决定

用 `lifecycle.jobs.push()` 排一个 job，由 Lifecycle 统一计算物理 alarm。

```ts
await this.lifecycle.jobs.push({
  id: "patrol",
  fn: "patrol",
  time: Date.now() + FIRST_PATROL_MS,
  payload: {},
});

// Lifecycle 到期后派发给 host 的 onJob
async onJob(context) {
  if (context.job.fn !== "patrol") return;
  const report = await this.patrol();
  await this.ctx.storage.put("patrol:last", report);
  return { rescheduleAt: Date.now() + DAY_MS };   // 排下一次
}
```

三条约束：

1. **不能每次请求都用同一个 id 重新 push。** push 同 id 会替换该 job，也就是说
   每来一个请求就把到期时间往后推 60 秒——请求一多，永远不到期。
   所以先 `jobs.get(id)`，有就不动。
2. **`onJob` 里不要等模型。** 它的 dispatch 有超时预算，超时会拖慢这个对象上所有
   其他 job。所以巡检只做「读 pending + 重新排队」，不为任何任务等结果。
3. **判据用 `pending()` 而不是 `wait()`。** `wait()` 会把巡检挂在一个没跑完的任务上，
   等于自己卡自己。

## 巡检做什么

| 看到什么 | 结论 | 动作 |
|---|---|---|
| 在 pending 里，状态 `parked` | pi 的崩溃循环保护把它停下了 | `retry({ session })` 重新排队 |
| 在 pending 里，提交超过 30 分钟 | 可疑 | 只记进报告，不擅自动它 |
| 不在 pending 里 | pi 已结算（done / unanswered） | 跳过 |

**不调模型，所以巡检本身不花钱。** 真正花 token 的是被救回来的那些任务，
而那笔钱本来就要花——它只是被人为的中断拖住了。

## 实测

自醒：

```
启动 → GET /status 触发排期 → next = now + 60s
不发任何请求，等 75 秒
GET /patrol → last.at 落在到期时间之后 61ms，scanned: 15
              next 推到 24 小时后
```

检测路径（临时把阈值改成 3s / 2s，用 `--persist-to` 独立数据库，不碰正式库）：

```
提交一条 800 字任务 → running
巡检在它运行中扫过 → stuck: ["stuck-001 running"]
```

## 代价

- **每天一次是不可配的**。真实需求会想要「某件事更频繁地看」，那时候要把周期
  变成每个 job 自己的字段，而不是全局常量。
- **30 分钟这个阈值是拍的。** 它依据是「pi 自己的重试比这快得多」，但没有实测过
  各种失败模式下的重试间隔。跑一个月之后应该按真实分布调，现在只是先有一个数。
- **它只照看自己。** 没有输入源，所以它看不到任何外部世界的变化。这不是主动性，
  这是自我体检。真正的主动性要等输入源和预算闸门。

## 什么情况下该推翻

如果 pi 将来提供了多 alarm 或自己的调度接口，这层包装就该去掉，直接用它的。
现在这层存在的唯一理由是「DO 只有一个 alarm，而那个已经被占了」。
