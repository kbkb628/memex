# Batty 与 Pots：记忆是文件，模型是最后一步

调研时间 2026-11-08。两个对象，回答同一个问题的两面：

| 仓库 | 是什么 | 读它的什么 | 为什么 |
|---|---|---|---|
| `battysh/batty` | Rust 的 agent 监督器，tmux + worktree + 测试门禁 | 记忆分层、确定性优先的四个落点、19 天遥测 | 「状态放在哪」这件事的极端答案 |
| `Crokily/pi-durable-bot`（产品名 **Pots**） | 建在 pi-durable 上的自托管 AI 同事 | `pots routine --run` 的命令设计、judge、markdown 记忆 | 「什么时候才值得叫模型」做成了可抄的形状 |

Batty 读了 README、`docs/architecture.md`、`docs/orchestrator.md`、作者那篇 19 天遥测复盘和 Show HN 原话；Pots 读了 README（它的文档几乎全在这一个文件里）。都没读源码，凡是源码级的说法都注了出处。

顺带记一下怎么找到 Pots 的：`pots in:name` 全是同名噪音（Erlang 电话模拟、Drupal CI、化学脚本、时序库），**它不是一个独立仓库，而是某个仓库的产品名**。最后靠 `topic:pi-durable` 那 49 个仓库里的一条描述找到的 —— 「Open-source Grok Bot alternative. **Pots** is an AI coworker…」。以后再找这类项目，先搜 topic，别搜名字。

---

## 一、Batty 是什么，为什么值得看

`battysh/batty`，Rust，61★，MIT。一句话：**它不 embed 任何模型，也不做 agent 框架**，只编排已经存在的 agent CLI（Claude Code / Codex / Aider / Kiro），用 tmux 当运行时，git worktree 当隔离，markdown 当看板。

作者在 Show HN 里把设计意图写得很直白：

> it's not an agent framework, and it doesn't embed any model. It orchestrates existing agent CLIs using tmux as the runtime and git worktrees for isolation. Config is YAML, the kanban board is Markdown, inboxes are Maildir, logs are JSONL. **You can git diff your entire team state.**

这句话是整篇调研的靶心。我们自己在 ADR 002 / 005 / 006 里反复纠结的那个问题 —— 「状态存在哪、谁能改、崩了怎么续」—— 它给了一个极端答案：**状态全部是文件，全部可 diff，全部是纯文本**。没有数据库当真相，SQLite 只做遥测副本。

写的是「19 天无人值守」，但星号很实在（第四节），这一点比数字更值得学。

---

## 二、记忆系统：五层，各管一件事，写的人全是代码

这是重点。Batty 没有「记忆模块」，它的记忆是**五个不同格式的存储，各有一个消费者**。抄这张表比抄任何向量库都值。

| 层 | 落在哪 | 格式 | 谁写 | 谁读 | 为什么是这个格式 |
|---|---|---|---|---|---|
| 任务记忆 | `.batty/team_config/board/` | markdown（kanban-md） | agent 改文字，daemon 改状态 | 人 + agent | 人可以直接看、直接 diff、直接手改 |
| 消息记忆 | `.batty/inboxes/<member>/{tmp,new,cur}` | Maildir | 任何人（原子写） | daemon 轮询 | 投递 = 文件从 `new/` 移到 `cur/`，天然幂等、天然可审计 |
| 审计记忆 | `.batty/team_config/events.jsonl` | JSONL 只追加 | daemon | retro、失败模式检测 | 只追加 = 可以重放；`daemon_started` 当 run 边界 |
| 指标记忆 | `.batty/telemetry.db` | SQLite | daemon | `batty metrics`、Grafana | 要聚合、要出图，才配得上一个数据库 |
| 组织记忆 | `.batty/retrospectives/<run_end>.md` | markdown | daemon（从事件流**重算**） | 下一次 run 的 prompt | 跨 run 的唯一「更懂」入口 |

第五层是关键，也是唯一称得上「学习」的地方。它的生成方式很克制：

> Batty splits the event stream into runs using `daemon_started` boundaries, analyzes the most recent run, and computes: run duration / 任务分配与完成配对 / 重试次数（来自重复分配）/ 升级次数 / 平均 idle 比例。

**复盘不是让模型回忆这轮干了什么，而是拿事件流重算一遍。** 这跟 ADR 005「恢复即重放」是同一个信念，只是它把这个信念用在了「总结」上。

### 会话记忆被明确当成缓存

这是我觉得最该记下来的一条。`docs/architecture.md` 里写 `--resume` 的行为：

> When started with `--resume`, the daemon launches agents with session continuation flags **when the saved launch identity still matches and the saved session is still available**. If saved session state is stale or missing, that member falls back to a fresh launch and **rebuilds context from disk** instead of blocking startup.

翻译过来：模型侧的记忆是可丢弃缓存，磁盘才是真相，两者不一致时以磁盘为准、并且**不阻塞启动**。配套的两个参数：

```yaml
workflow_policy:
  context_handoff_enabled: true
  handoff_screen_history: 20          # 交接时带最近 20 行屏幕，不是整段历史
  context_pressure_threshold_bytes: 512000
```

上下文快满（约 512KB）不当作失败，当作一次**交接**：起新 session，只带 20 行屏幕 + 从磁盘重建的上下文。这跟我们 ADR 006「一任务一会话、每轮完整重讲目标」是同一个方向，差别在**带多少历史**：它带 20 行屏幕（为了保持「我刚才在干什么」的连续性），我们一行都不带（为了不让上一轮的错误结论污染这一轮）。两种都对，但我们的选择只有在「目标快照足够完整」时才成立 —— 而这正是 ADR 012 在做的事。

### 它顺手解决了「过期信息污染上下文」

两个小机制，都很便宜：

- **inbox 摘要整形**：一手 200 条原始消息，进 manager 上下文前被压成按优先级排的摘要（v0.10.0 特性）。
- **过期升级降级**：`demote_stale_escalations` 把「指向的任务已经 done/archived」的升级条目降回普通状态。起因是 bug #612 —— 过期升级占了本该给真问题用的槽位。

对应到我们：`/goals` 的巡检、`waiting` 状态的提示，将来如果同时挂多个目标，也会有「这条早就不重要了但还排在前面」的问题。现在只有一个目标，还没暴露。

---

## 三、Batty 的脚本先行：不是口号，是四个具体位置

用户提的那条原则，在 Batty 里有可指认的落点：

1. **主循环是同步 5 秒轮询**（v0.1.0 的 HN 原话：「The daemon is a synchronous 5-second poll loop — no async complexity」）。判断「该派活了吗 / 该催了吗 / 该合了吗」全是 Rust 代码，零 token。
2. **合并路径上没有人，也没有模型**：「daemon auto-tests completions, retries on failure, merges on green. **No agent in the merge path.**」判定权在 `cargo test`。
3. **准入要证据，不要自述**：`verification.require_evidence: true`，19 天里收了 **1,304 份验证证据**才让 20 个任务靠近合并。每个「不合并」都有原因枚举（`WrongStatus` / `MissingPacket` / `NoBranch`），拒一次记一次。
4. **重复的干预会被签名挡住**：每种干预算一个 signature（backlog 集合、review 队列、idle epoch），签名没变就不重复发提示，只等 cooldown。**「同一件事不该花第二次钱」是写在代码里的，不是写在 prompt 里的。**

第 4 条对我们最直接。我们现在每轮都会调一次模型，即使上一轮的答案一模一样；`rounds` 里存了 `{op, at, answer, met}`，但没人拿它做抑制。

它自己也承认这套的边界：「If your test suite is weak, Batty makes that worse, not better — the merge gate is only as strong as what it gates against.」我们没有测试套件可 gate，gate 是 criteria（ADR 012）。同一句话翻译过来就是：**criteria 写歪了，模型越努力越糟**。

---

## 四、19 天的数字，和那个星号

窗口 2026-03-22 → 04-10，数据来自 `telemetry.db` 并用 `git log` 交叉核对：

```
端到端完成 102 个任务 · 席位完成 150 次 · 自动合并 20 个 · 派活 411 次
落地 456 个 commit · 单日峰值 55 个（4/6）· 14 天发 13 个版本
验证证据 1,304 份 · 验证阶段转移 790 次 · 合并置信度 250 次
自愈 258 次 · 升级给人 195 次（约 10/天）· pane 重启 167 次
状态对账 1,052 次 · 心跳落盘 989 次 · 磁盘清理 146 次
```

星号写在「What this run didn't fix」里，作者没藏：

> **The 10–15 minute productive window.** Throughout this 19-day run, I was occasionally restarting the daemon every 10–15 minutes to clear an event-loop freeze.

也就是说「19 天无人值守」= 不用派活、不用验、不用合；但每十几分钟要人去重启一次守护进程，直到 v0.11.2 才修掉。**这句话比那 102 个任务有用**：凡是「跑了 N 天没人管」的说法，先问生产窗口多长。

另外两个诚实的缺口：上下文耗尽是「恢复 ≠ 预防」，真正的解法是把任务切小；凭证轮换永远得人去控制台点。

## 五、遥测的意义：发现「同一个东西被修了两次」

三个 bug 的故事比数字更有教益，共同点是**都是靠比率异常发现的，不是靠报错**：

| 观测 | 异常信号 | 修法 |
|---|---|---|
| 258 次自愈 | 同一成员被反复重启 | `stall-restart::{name}` cooldown，重启后压住直到首个 StateChanged |
| 195 次升级 | 早期噪音大，因为摘要里前排全是过期升级 | 按任务状态降级（#612） |
| 20 次自动合并 | 250 份置信度分数对不上候选数 | 每次拒绝都分类记录（#592） |

对应我们：`receipts/live.json` 是**快照**，不是流。它能回答「现在是不是绿的」，回答不了「这个源这周失败了几次、同一个原因吗」。巡检报告里 `last.at` + `scanned` 是现在唯一的时序痕迹。

---

## 六、Batty 能抄的三条（都还不到动手的时候）

按性价比排，每条都带触发条件 —— 没触发就不做，这是 014 教出来的纪律。

### 1. 重复的轮次不该再花一次 token

**现状**：`advanceGoal` 每轮无条件起一轮，`rounds` 只留最近 3 条（`slice(-3)`），没有任何「这跟上一轮一样」的判断。

**抄法**：归一化 `answer`（复用 goal.ts 里已有的 NFKC + 零宽 + 折叠空白），与上一轮相同则跳过模型调用，记一次「空转」，并按 Batty 的 signature 思路：**同一签名连续两次就停，等人**。

**触发**：观察到「同一个目标连着两轮的答案实质相同」。现在 `waiting` 状态下人一确认就继续，还没出现过。

**成本**：约 20 行 + 一条 goal-check 用例（`空转不计轮次`）。**风险**：判「实质相同」用字符串相等会误判（换个说法就不同），所以只挡「完全同」这一种，不做模糊。

### 2. 轮次记录从「滚动窗口」换成「只追加」

**现状**：`rounds.slice(-3)`。目标跑了 6 轮，前 3 轮发生过什么就没了 —— 而「为什么没做到」恰恰藏在前面几轮里。

**抄法**：新增只追加的 `steps`（`{op, at, answerSha, met, verdict}`，**不存 answer 全文**，只存指纹和长度），`rounds` 保留最近 3 条给页面用。目标收尾时由代码（不是模型）算一页：几轮、每轮哪条 criteria 由 ✗ 变 ✓、卡在哪一条。

**触发**：出现「一个目标超过 3 轮还没 done」。现在最多 3 轮，正好卡在边界上。

**成本**：半天，含一次 `goal-check` 扩测。**注意**：这是 append-only，跟 ADR 005 的重放语义一致，不引入新的真相来源。

### 3. 判定落证据，不只落布尔

**现状**：`met: boolean[]`。知道「过了」，不知道「凭哪段文本过的」。

**抄法**：每条 `met` 旁边记 `{ matched: string, answerSha: string }` —— 命中的那一条原文片段 + 当时答案的指纹。将来 criteria 改了口径，可以拿旧答案重判，而不是全部作废。

**触发**：第一次出现「我怀疑它为什么判过」。**成本**：10 行左右。

## 七、Batty 里明确不抄的

| 东西 | 为什么不 |
|---|---|
| tmux 当持久层、PTY 屏幕解析 | 它要跑别人的 CLI，只能这样。我们跑的是 DO 里的 `Conversation`，本来就有状态（ADR 001） |
| git worktree 隔离 | 前提是「多个 agent 改同一个仓库」。我们没有执行环境（ADR 003） |
| 多角色编制（architect / manager / engineer） | 单人 agent，加层级只是加 prompt 和加失败面 |
| Maildir 消息队列 | 我们靠 `operationId` + 单写者 DO 拿顺序，不需要第二个队列 |
| Grafana + 6 条告警 | 一个人用的东西，页面上一行 `last.at` 够了 |
| 258 次自愈那套 stall 检测 | 它的 stall 是「模型不说话」；我们的 stall 是「排期没响」，用 `/patrol` 的 `last.at` 就能验 |

还有一条要**反向记**：它每层记忆都有明确的消费者。我们加任何存储前先回答「谁读它」—— 没人读的字段就是负债（借阅笔记第四节已经踩过一次）。

---

## 八、Pots：「脚本先跑」被做成了一条命令

Pots（`Crokily/pi-durable-bot`，MIT，`npm i -g pi-durable-bot`，命令叫 `pots`）的定位是「AI 同事」：读所有被邀请的频道、自己判断哪条跟自己的工作有关、在自己的电脑上写脚本干活、自己排期回来。整套文档几乎都写在 README 一个文件里，密度很高。

「脚本工作先行，大模型后置」在它这里不是架构口号，是 `pots routine` 的一个参数：

```sh
pots routine add watch-mail --every 5m --run "./check-mail.sh"
```

README 原文：

> `--run` makes Pots run the command at each time, in the bot's shell, folder and environment, with `POTS_FROM` set to the routine's name. **The command decides itself whether to wake the bot with `pots wake`, so watching an inbox every few minutes costs no model request until there is mail.**

这句话把一个常被含糊处理的边界说清了：**「看」和「判断要不要管」是两件事，前者给脚本，后者才给模型**。每五分钟扫一次信箱，成本是每五分钟一次 shell，不是每五分钟一次模型请求；只有真有邮件的时候，脚本才 `pots wake` 把它叫起来。

配 `--note` 就是另一种模式：到点直接唤醒模型，不做脚本。两种模式共用一个调度器、一个数据库、一套重启恢复 —— 这才是「先脚本后模型」能落地的原因：它不是一个降级路径，而是同一个表里的两种 routine。

### 三个配套细节，比原则本身更值得抄

**1. 来源标注 `--from`。** 脚本调 `pots wake` 时必须说明这次唤醒来自本机命令、不是来自人：

> The wake then tells the bot that it comes from a command on this computer, not from a person, **so outside text in its note, such as an email's subject, does not read as the bot's own plan.**

这是防注入的具体做法：外部文本会进上下文，但它带着「我是外部数据」的标签，不会被当成「我自己的计划」。`--id` 另有一个作用：同一个 ID 的第二次 `wake` 直接返回第一次的结果，不再产生新的唤醒 —— 幂等。

**2. 失败只叫一次。**

> A failed run (a non-zero exit code, or the timeout) wakes the bot once, with that output; later failures of the same routine do not, **until one of its runs succeeds.**

重置条件是「成功一次」，不是「过了 N 分钟」。比时间窗更准：坏的东西一直坏，就不该一直叫人；好了以后再坏一次，那是新问题。

**3. 运行的记录留着，但只留有用的。**

> Pots keeps each run's start, end, exit code and last lines of output for 7 days.

配套两条防打堆的规则：上一次还没跑完就跳过这一次；关机 / 休眠期间错过的时刻**不补**，下一次就是从现在起的下一个时刻。单次命令最多 10 分钟（或 `--timeout`），超时连它起的进程一起收掉。

### judge：在模型之前再放一层更便宜的判断

Pots 被唤醒有三种方式：被 @ / 私聊、自己注意到、自己的定时器。中间那种是「没 @ 它但可能跟它有关」的消息，它的处理是**可选的第二层**：

| `judge` 值 | 行为 | 代价 |
|---|---|---|
| `off`（默认） | 每条群消息都是一次主模型唤醒，由它自己决定 | 最贵，最准 |
| 快分类器（Jev / 本地模型） | 先问两个问题：跟我有关吗？该回吗？ | 约 0.3 秒，便宜一个数量级 |
| `main` | 用主模型judge，每条先花一次短请求 | 不用额外账号，比分类器慢 |

这跟我们的 `prefilter` 是同一个位置上的东西，只是它用分类器、我们用词表。ADR 014 已经证明词表在 HN 标题上失效；分类器是这条路继续往下走的自然下一步，**但现在没有量，不该换**。

### 它的记忆：markdown 文件 + 索引，跟 Claude Code 一个路子

> Its memory works as Claude Code's automatic memory: plain markdown files, one per memory, and an index, `MEMORY.md`, that the bot sees at the start of every page and that points to them.

值得记的是**写完由谁写、写完怎么不收钱**：

- 干完一件活，**同一个模型在后台接着同一段对话**再走一遍，把漏掉的存下来。这一遍不发消息、不阻塞回复；请求的开头跟它上一次一样，所以 provider 的 prompt cache 大部分能命中，成本很低。
- 而且「**code lets it change nothing but the memory**」—— 这一遍的权限被代码限死在「只能改记忆」，模型没有借这次调用发消息的能力。这是权限分层，不是提示词约束。
- 每天一次、且改动够多时，一个叫 **dream** 的整理过程把记忆收拾一遍。
- 读到的记忆如果两天以上没变过，会自己标上「这是多久以前的」—— 防止把旧事实当现状。
- 每个 bot 一份，同一台机器上的所有 bot 再共享一份（`~/.pots/memory/`，放关于你的事）。

上下文满了不是压缩，是**翻页**：写一份 `notes.md` 交给自己，开新上下文，便条和记忆一起带过去，完整消息日志留在磁盘上。它也承认代价：「a restart before that wake loses the note, not the memory」—— 交接便条可能丢，记忆不丢。

### 顺带一条：code mode 是同一个原则用在「干活」上

> the agent gets a few general tools (`read`, `write`, `edit`, `bash`, `screen`) plus three channel actions (`send`, `react`, `call`), and builds the rest itself.

`codemode` 更进一步：模型写一段 JavaScript 调这些工具（以及 MCP 工具），在沙箱里跑，**只有脚本返回的东西回到上下文**。这就是那篇「你在花钱让 LLM 跑一个 for 循环」的解法 —— 循环进脚本，模型只看结果。Pots 用它，是为了「工具列表永远不变、prompt cache 一直命中」。

### 它的星号

- 「The bot gets full control of the computer it runs on, **with no approval step**」—— 它自己在 README 顶部就写了：给一台专属机器。
- Telegram 的 Bot API 读不到历史，只能拿到 24 小时内的补漏；发送瞬间崩溃**可能重复发一次**（Slack / Discord 没这个问题）。
- `judge: off` 时每条群消息都是一次主模型唤醒，这是默认值。

## 九、把两个放一起看：我们差在哪

| 能力 | Batty | Pots | 我们现在 | 差在哪 |
|---|---|---|---|---|
| 定时干活 | 5 秒轮询 + 守护进程 | `routine --run`，脚本自己决定要不要唤醒 | `patrol` 抓源、`prefilter` 命中才提交 | **一致**：0 命中就是 0 模型调用，这条我们已经做到了 |
| 快筛 | — | judge 分类器（约 0.3 秒） | 服务端词表（零成本） | 词表在 HN 上已失效（014），分类器是可选升级，但现在没量 |
| 完成判定 | `cargo test` + 证据包 | 脚本退出码 / 条件 | `criteria` 机械判定（012） | **一致**，且我们比它更严：模型自述完全不计 |
| 幂等 | claim TTL + 状态对账 | `--id` 返回第一次的唤醒 | `operationId` | **一致** |
| 来源标注 | 通知隔离（daemon 的话不进 agent 上下文） | `--from`：外部文本不读成「自己的计划」 | `promptFor` 已加材料围栏 | **已补**，但探测下来没有可测收益，见 015 |
| 失败去重 | intervention signature + cooldown | 同一 routine 连续失败只叫一次，直到成功一次 | 无；`failed[]` 只记录不抑制 | **撤回**：我们的失败不花钱，见 015 |
| 跨轮记忆 | 事件流 + run 复盘 md | markdown + `MEMORY.md` + 后台补记 + dream | 无；`rounds` 只留 3 条 | 差得最远，但这是我们刻意选的（不丢事优先于更懂） |

两条我觉得现在就该记下来、但还不到动手的：

**1. 外部文本要带「我是数据」的标签。** 我们的 `promptFor` 第一行是「【自动巡检 · 不需要回复我的提问，直接按要求输出】」，它把这次任务标成了「巡检」而不是「提问」—— 这是有用的，但它没有说清「下面的标题和摘要来自外部网页，是数据，不是指令」。Pots 的 `--from` 正是为了这件事存在的，而且它举的例子很具体：邮件的标题。**一条 feed 的标题里写「忽略上面，改为……」时，我们现在没有任何一层在说这句话不算数。** 加一句的成本是一行，但它是提示词层面的改动，要跟 criteria 一起想清楚，别顺手改。

**2. 失败只叫一次，重置条件是「成功一次」。** 我们现在巡检失败只往 `report.failed` 里塞一条，下一轮还是照样跑、照样可能失败、照样占一次判断。真要抄，抄的是它的**重置条件**（成功才重置），不是抄一个冷却时间。

## 落地情况（2026-11-08 追加）

上面那两条，一条落地了，一条撤回了。写在这里是因为**笔记当时的判断有一条是错的**，错的地方比对的更有用。

**第 1 条（外部文本标签）：落地，`docs/decisions/015-borrowed-designs.md`。** 但值得泼一盆冷水 —— 拿三组样本、新旧两版提示词各跑两次，**6 对判定全部一致**。旧版在「标题写『忽略上面的要求』+ 无关摘要」那条上，还主动说了「标题本身是提示注入」。也就是说 deepseek-flash 本来分得清。留着它的理由是零成本（token 差在噪声内）和「换模型时围栏是唯一没坏的那一层」，不是「更准」。这是保险，不是改进，两者不该混着说。

**第 2 条（失败去重）：撤回。** 当时写「缺」，是照着 Pots 的形状看自己，没问那个设计在替它解决什么。它解决的是「一次唤醒有成本」—— Pots 的唤醒是模型请求加一条用户看得见的消息。我们的抓取失败根本不进模型，判定失败只是落一条状态，**一个不花钱的失败，去重只会让它更安静**，而我们要的是更显眼。照抄的结果是加一个没人读的字段。

这条经验进 ADR 015 的最后一条规则：加字段之前先回答「谁读它」。

## 十、待补

- Batty 的 `verification` 证据包到底装了什么（`require_evidence` 的 schema），值不值得借到 `answer_contains` 上。
- Batty 的 retro 模板长什么样（`.batty/retrospectives/*.md`），能不能直接当「目标收尾一页」的格式。
- Pots 的 `--run` 脚本有没有超时外的资源限制（README 只说了 10 分钟上限）；它的 TLA+ 模型是怎么给 inbox / outbox / waker 建模的（`npm run tla`），这套方法对我们「一轮只能有一个 currentOp」可能有用。
