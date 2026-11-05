# _shelved —— 归档的旧实现

这里放的是 2026-11-03 那一版。不在编译路径里（`tsconfig.json` 只 include `src/**`），
也不在静态资源目录里，所以既不参与构建也不对外可见。

归档的原因不是它错了，是它比当前需要的大太多：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `src/memory.ts` | 331 | 三层（stable / active / archive）× 四态（discussing / confirmed / rejected），带引用与裁决理由 |
| `src/prompts.ts` | 141 | 五层提示词，各自版本化、留历史表 |
| `src/home.ts` | 228 | 上面两套东西的路由，外加 fork 任务 |
| `public/index.html` | 1044 | memex 界面：记忆档案栏、四态线型、SVG 印章、起步三槽 |

当前版本只保留一句话：**发一条消息，页面可以关掉，它做完了答案还在等你。**

## 想装回某一层时

一次只装一层，装的时候问一句「这一层现在解决了什么真实的问题」。

- **提示词分层**（`src/prompts.ts`）：把 `PromptBook` + `promptExtension` 拿回来，
  路由相应加 `GET/PUT /prompt`。判断依据是同一句话在不同场合确实该有不同说法。
- **记忆**（`src/memory.ts`）：跟 `prompts.ts` 的 `Extension` 一起装，它依赖那一层的
  `sections` 机制。先想清楚写入规则，再谈四态。
- **界面**（`public/_shelved` 那份）：里面直接调了 `/memory`、`/live`、`/prompt`，
  所以必须先装回上面两层，否则整页报错。

`git` 历史里也在，`_shelved` 只是让它显眼一点：删掉东西要看得见。
