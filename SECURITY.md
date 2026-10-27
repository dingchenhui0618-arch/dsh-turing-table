# 安全模型 / Security model

这份文档说明 **dsh-turing-table（图灵圆桌）** 信任什么、把什么内容发给模型、把对局写到哪里。
内容从实现（`src/host.js`、`src/table.js`、`src/speaker.js`、`src/export.js`）读出来；
**文档与代码不一致时以代码为准。**

> 一句话：这是一个**把用户提问发给多个模型配置、再把回答写成 JSONL** 的游戏。
> 它不读你的文件（除了回读自己刚写的导出），但它**会花你的模型额度**，
> 并且**能往任意可写目录写两个固定前缀的文件**——这两件事的入口都没有鉴权。

## 信任边界

插件跑在 DSH 宿主进程里（`src/host.js` 硬 `inject: ['webServer']`）。对外表面只有一块：

| 表面 | 谁连进来 | 鉴权 |
| --- | --- | --- |
| `/dsh-turing-table` 前缀路由（`state` / `ask` / `say` / `verdict` / `close` / `reveal` / `new` / `export` / `transcript`） | 本机 DSH Web GUI；任何能访问该 web server 的人 | **无**。没有 token、没有 CSRF 校验 |

**视为不可信输入**：

- 所有 `POST` 请求体：`text`、`to`、`seat`、`verdict`、`note`、`seed`、`seatCount`、
  `humanSeats`、`maxRounds`、`models`、`dir`；
- **模型返回的文本**：可能为空、可能报错、可能包含任意内容；它被当成游戏发言处理，
  不当作指令执行；
- 插件配置里的 `models` / `disguise` / `seatLabels`（由部署者提供，但仍会进 prompt）。

## 模型调用（唯一的网络出口）

`src/host.js` 的 `speak()` 通过 DSH 的 `llm` 服务为**每个 AI 座位**发起一次流式调用：

- 路由：座位自己的 `{provider, model}`；为空时回退到 `agentDefaultModel.currentSelection()`；
  两者都没有就降级为离线叙述者；
- 发送内容：`composeSystemPrompt(turn)`（座位人格、伪装参数、桌面上下文）+
  `composeUserPrompt(turn)`（**用户输入的问题 / 你认为的事实 / 其他座位已有的发言**）；
- 参数：`temperature`（座位配置，默认 0.8）、`maxTokens`（默认 200）、可选 `reasoningEffort`；
- 失败（报错、abort、空输出、无 llm、无路由）一律降级为离线叙述者，并在消息上标
  `degraded: true`，导出里不会把降级文案冒充成模型原话。

也就是说：**你问的问题和座位之间的对话会发给你配置的模型 provider**。这里没有脱敏层，
不要把凭据、客户数据粘进提问框。

## 读什么

- 运行期**不读任何用户文件**；
- `writeExport()` 写完 JSONL 与判定记录后，会立刻 `readFileSync` 回读这两个文件做校验
  （`verifyRound`），失败记为 `readback-failed` 而不是当作成功；
- 不读环境变量里的凭据，不读 `~/.dsh` 下的其他内容（只把 `DSH_HOME` 当作默认导出目录的父目录）。

## 写什么、覆盖什么

- 默认导出目录：`$DSH_HOME/turing-table`；`POST /export` 的 `dir` 可以指定**任意路径**
  （`mkdirSync(dir, { recursive: true })`，不存在就创建）；
- 文件名：`round-<safeFileName(seed)>.jsonl` 与 `round-<safeFileName(seed)>.verdicts.json`；
  `safeFileName()` 把 `[^A-Za-z0-9._-]` 全部替换成 `_` 并截断到 60 字符，因此不能借 seed
  做目录穿越；
- **同名文件直接覆盖**，不备份、不询问；不删除目录里的其他文件。

## 鉴权与信息可见性

- 路由本身**没有鉴权**，任何人能访问 DSH 端口就能提问、判定、导出；
- 座位身份（是人还是 AI、用了哪个模型配置）在**判定或收局之前不进 `/state`**：
  `publicView()` 对未判定座位的 `kind` / `modelConfig` 返回 `null`；
- `reveal` 在牌局未结束时返回 403 `not-over`，不能提前揭晓；
- `GET` / `HEAD` / `state` 都返回同一份快照（这是为了方便，不是额外权限）。

## 已知限制

1. **无鉴权、无 CSRF、无速率限制**：一次 `ask` 可能触发 N 个 AI 座位的模型调用。
   能访问端口的人可以反复触发，花掉你的额度。
2. **`export` 可写任意目录**：请求体的 `dir` 不做白名单，能在进程有权限的任何位置
   创建目录并覆盖同名 `round-*.jsonl` / `round-*.verdicts.json`。
3. **对局只在内存**：host 重启即丢，没有断点恢复；这是设计。
4. **模型输出是自由文本**：客户端用 `React.createElement` 建节点（`src/client.cjs`），
   没有 `innerHTML`，所以不构成 XSS；但文案本身可能包含不雅内容或诱导性内容。
5. **prompt 里包含用户输入**：如果用户把「忽略上面的规则」之类的话发给座位，
   模型可能照做——这是所有 LLM 应用的共同限制，不是本插件的越权。
6. **导出可复现只针对同一 seed + 同一操作脚本**；模型真实回答每次都不同，
   `degraded` 与 `raw` 分开记录，不会把降级文案混成模型输出。
7. **硬依赖 `webServer`**：没有 web server 的宿主上路由不注册，但牌桌对象仍可被程序调用。

## 明确不算漏洞

- 你问什么，模型就看到什么（这是游戏的核心）；
- 模型调用消耗你的额度（配置了模型就预期会调用）；
- 导出写到你在请求里指定的目录（这是导出功能）；同名文件被覆盖（这是设计）；
- 未判定座位在 `/state` 里看不到身份，而判定后能看到（这是游戏规则）；
- 用 devtools 直接调 `/export` 或 `/new`（本机工具，没有额外门禁）。

## 报告漏洞

用 GitHub 的私密渠道：<https://github.com/dingchenhui0618-arch/dsh-turing-table/security/advisories/new>

个人项目，**不承诺响应时限**；修完会写进 `CHANGELOG.md`。请不要把仍在生效的问题先发到公开 issue。

## 支持范围

只维护最新版（当前 `0.1.0`，见 `package.json`）。旧版本不回补。
