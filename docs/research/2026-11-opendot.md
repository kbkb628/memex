# OpenDot 对照：一个 43 万行的同栈实现，能抄什么、不能抄什么

**日期**：2026-11-06
**对象**：`helsome/OpenDot`（本地包 `OpenDot-main-0689098.zip` + 一份 30 章的项目解析）
**结论先放**：它和我们同栈、同形态、同一批依赖，但体量是我们的两百倍。**能抄的只有三处，而且都很小；不能抄的是它整套存在理由。**

## 一、它是什么

自托管的个人 AI 助手 + 团队。Dot 是用户可命名的助手，Workspace 是文件与执行边界，Goal 是「交给 Scheduler 的持久任务书」，渠道接飞书/Telegram/QQ/钉钉/微信/Discord/WhatsApp，前端 Web + PWA + Electron，执行有 Host 和 Docker 两种，云端执行落在 Cloudflare Worker 上。

| 维度 | OpenDot | memex |
|---|---|---|
| `src` | 343 文件 / 185,854 行 | 9 文件 / ~2,200 行 |
| `web` | 354 文件 / 90,619 行 | 1 个 HTML 文件 |
| `apps/cloud-agent` | 35 文件 / 12,568 行 | 同位置是我们的全部实现 |
| 测试 | 563 文件 / 140,489 行 | 1 个凭证脚本，3 个场景 |
| 文档 | 29 篇 + `docs/personal-agent/` 24 篇 | 10 篇 ADR + 2 篇调研 |
| 运行环境 | Node + SQLite + Docker + Electron + Worker | 一个 Worker |

**依赖版本**：它 `agents 0.28.1` / `pi-durable 1.3.0`；我们 `0.32.0` / `1.4.0`。它的 cloud-agent 比我们落后两个小版本 —— 这不重要，但说明「用了 Pi」这件事本身早就不是差异点了。

## 二、最该看的地方：`apps/cloud-agent`

这是全项目唯一和我们正面重叠的部分，也是我们一直想说清的那件事的完整答案。它比我们多做的是**授权**：

- `execution-grants.ts` / `authority.ts`：一次云端执行带签名 grant，里面冻结了工具白名单、模型步数上限（`max_model_steps`）、截止时间（`deadline_at`）、配置指纹（`config_fingerprint`）。
- `execution-recovery.ts`：可恢复的「执行主体」有三类（grant / handoff / member），每类都能在崩溃后重新认领，判断依据是持久化的 subject 而不是内存。
- `execution-ownership.ts`：Node 侧用 `<db>.owner.sqlite` 上一个**未提交的写者事务**当锁 —— 进程活着就持有，被 OS 杀掉就自动释放。不用 TTL，不猜 PID，不删陈旧文件。
- 每个工具执行前都要 `await authorize(context.abortSignal)`，重新校验授权并带上中止信号。

对照我们：我们只有 `operationId` 幂等 + `patrol` 重排 + `pending()` 查询。**没有「谁允许它继续跑、还能跑多久、花多少」这一层**，因为我们是单用户、单 key、无副作用工具，这一层暂时不成立。它不是我们缺的功能，是我们主动砍掉的维度。

## 三、照抄的三处（都已落地）

### 1. 内容摘要交叉校验 —— 这是我们的 bug，不是优化

它的规则：同一个 `requestId` + 同一个 `payloadDigest` 重复提交，返回相同结果；**摘要不同就报冲突**；`deny` 不能覆盖已经 `approve` 的键。

我们的原实现：`submitText()` 见到已有 `op:` 记录，就把**新文字**塞进**旧会话**重投一次。pi 看到重复的 `operationId` 返回 `accepted: false`，于是新文字被静默丢弃，调用方只拿到一句「没被受理」—— 两段话用了同一个 id，其中一段就这么消失了，没有任何地方能查出来。

改法：`Note` 加 `digest`（sha256 前 8 字节），不同就返回 409 `operation_id_reused`。用 sha256 而不是 `feeds.ts` 里那个 32 位 FNV —— 那个撞了只是少看一篇文章，这个撞了会让一段真话被当成重复丢掉，代价不对称。

实测：

```
① 首次提交 "只回答一个字：一"   → 200 accepted:true  session 870
② 同 id 换 "只回答一个字：二"   → 409 operation_id_reused，session 870，什么都没提交
③ 同 id 同内容再发一次          → 200 accepted:false，回到 session 870
④ /op 查到最终答案 "一"         → 会话数 56→57，②③ 没有多建
```

第 ④ 条是关键：答案仍然是「一」。这说明被拦下的那段话确实没进执行路径，而不是「先跑再报错」。

### 2. 成本是估算，不是账单

它把账分三条互不信任的链路：观测（Langfuse，失败静默丢弃）、用量记账（`usage_events`，幂等重放）、计费（套餐/余额）。原话是「观测量不进账本，账本金额也不进观测」，并且明确把 SDK 上报的美元估算判为**不具备会计权威**，用 `cost_status: 'unpriced'` 声明而不是留空。

我们原来把一个 `$0.0427` 直接摆在页面上，来源是 pi 按 provider 报价表算的估算。现在 `Spend` 加 `costKind: "estimate"`，页面写「（估算 $0.0427）」。**没有真实扣费凭据，就不该让它看起来像账单。**

### 3. 证据分档

它的验收文档分得极细，而且反复声明边界：

> "Local workerd/Miniflare exercises actual SQLite, PiHarness, object reconstruction, Alarms, native Task checkpoints... These are local infrastructure tests, not deployed hibernation, deployment update, platform quota or billing evidence."

而且 `cloudflare-real-acceptance.md` 的状态到今天还是 **Pending** —— 健康检查 200 明确不算验收。

这条对我们最有用，因为它把我们按在地上：**我们也没有验过部署后的运行时行为**，一次都没有。我们的 README 原来把「真 key 端到端」和「断电续跑」并列，读起来像同一个层级，实际前者是本地 workerd。

现在 README 的验证表按三档写：

| 档 | 含义 | 我们到了没 |
|---|---|---|
| 本地 workerd + 真 provider | 真 key、真模型、真 SQLite，但进程在本机 | 到了（3 份凭证） |
| 已部署 | 部署成功、版本号可查 | 只到了这一层：**部署成功 ≠ 验收** |
| 部署后真实请求 | 从公网打到那个 Worker，看到它自己醒 | **没到**（`workers.dev` 在国内被 DNS 污染） |

## 四、明确不抄的

**Goal 五表 + 九态状态机。** 它是「一件事交给你，我按预算一轮轮推，直到完成条件命中」。这是最有价值的部分，也是最重的部分：五张表、九种状态、只允许 PATCH 五种、等待态必须由执行引擎从物理依据派生（一条 pending 审批、一条 queued 设备命令），明确写着「不是模型几句话就能触发的标签」。

这段设计我认同它的原则 —— **等待必须有物理依据** —— 但我们没有「多轮推进的目标」，只有「一次判断」和「一次回答」，套上去就是给一个 2000 行的东西装一台 20 万行的发动机。

**四个持久化账本（inbox / turn_runs / outbox / streaming_cards）+ lease token CAS。** 它解决的问题是「消息发出去了，ACK 丢了，到底算不算送达」。我们的出口是页面，没有投递语义，所以 `uncertain` 这个状态在我们这里没有对应物。**但这条要记着**：哪天 memex 真加了有副作用的工具（发邮件、写文件），我们立刻需要一个「做了但不知道成没成」的终态禁区，而不是现在的「失败就重试」。

**渠道、群聊、多 Bot handoff、ACL 矩阵、Electron。** 全是「团队版」的答案。README 里已经写过为什么不走这条路。

## 五、一条判断

它的存在不否定我们，但改变了我们该主张什么。

- **「Pi + Durable Objects + Cloudflare」不再是差异点。** 官方示例里有，它的 `apps/cloud-agent` 里有，而且带授权链。以后不要在这上面花论证成本，一句「官方示例 `examples/next/harnesses/pi`」足够。
- **「不丢事」也不是专利。** 它的 workerd 测试里就有 kill/resume、重复输入、原样回执。区别只是它把这条写进测试表的一行，我们把它当成唯一主张。这一点我在上一份调研里已经写过，现在有了第二个例证。
- **剩下的差异只有取舍，而且必须是可验证的取舍。** 43 万行仍然没拿到云端验收 —— 这说明「堆功能」和「证明它对」是两件独立的事，后者不会因为前者自动发生。我们能做、而它没做的那件事，恰好是**把每一条主张都压到一个能重跑的文件上**（`receipts/`），并且**承认哪一档没验过**。

那句 `cloudflare-real-acceptance.md` 的 Status: Pending，比它前面三万字的架构描述更能说明问题。

## 六、下一步（按性价比）

1. **给凭证加一条负向对照。** 它的评估记录里有个做法值得抄：把代码改坏一处（删掉一个字段），证明对应的断言**会失败**。我们的 `checks` 只证明了「通过」，没证明「坏了会红」。挑一条最关键的（断电续跑那条）试一次，成本很低。
2. **`uncertain` 的预案写进 ADR**，等第一个有副作用的工具进来时直接套，而不是那时候现想。
3. 不动 Goal。等真的出现「一件需要连续多轮推进的事」再说 —— 现在收件箱里每条都是一次判断，不是目标。
