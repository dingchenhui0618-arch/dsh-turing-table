# 变更记录

## [Unreleased]

### 文档与工程

- 新增 `SECURITY.md`：写清提问与座位对话会被发到配置的模型 provider、`export` 可写任意
  目录并覆盖同名文件、`/dsh-turing-table` 路由没有鉴权与速率限制。
- 确认 CI 已覆盖单测（`.github/workflows/test.yml`：`node --test`，本次未改动）。
- README 顶部补 CI 与 license badge、star 引导一句。

## 0.1.0

首个版本：一张桌、N 个座位、seed 决定谁是 AI。

- **牌桌引擎**（`src/table.js`）：座位与身份由 seed 分配，`humanSeats` 至少 1；提问 → 座位依次回答 → 随时判定 → 收局；全部错误都以错误码返回（`bad-config` / `unanswered` / `self-verdict` / `already-judged` / `undriven-human` 等 18 个），不吞异常。
- **每座位模型配置**（`src/personas.js` + host）：`provider` / `model` / `system` / `style` / `voice` / `temperature` 由配置项给出，按 seed 洗牌发给 AI 座位；`null` 表示跟随会话默认模型。每个座位用**自己的路由**发言。
- **伪装策略**（`src/speaker.js`）：长度、口语化、主动提问、被追问时的四种策略（`hold` / `deflect` / `concede` / `escalate`），整形只改 `text`、保留 `raw`，并记下 `applied`。
- **交叉印证**（`src/facts.js`）：内置话题词表让同一个事实可被换着问；重复提问触发座位自己的 `pressure` 策略，`deflect` 会暴露矛盾。
- **可复现**（`src/rng.js`）：FNV-1a + mulberry32，`rng.fork(tag)` 给座位 / 模型 / 伪装 / 每轮整形各自独立子流；逻辑时钟让时间戳与调用时刻无关。同一 seed + 同一脚本 → 逐字节相同的导出。
- **导出与校验**（`src/export.js`）：逐席位对话 JSONL（21 个字段、每行自包含）与判定记录（`truth` / `seats[]` / `verdicts[]` / `score` / `endReason`）；`replay()` 能从 JSONL 单独复原整场对话，`verifyRound()` 在写入前交叉检查真值与分数。
- **CLI**（`scripts/export.mjs`）：`<spec>` 导出、`--replay` 复原、`--verify` 校验；`--help`。
- **host 半区**（`src/host.js`）：一条 `/dsh-turing-table` 前缀路由（`state` / `ask` / `say` / `verdict` / `close` / `reveal` / `new` / `export` / `transcript`）；未判定座位不泄露身份；模型失败、空输出、错误分片、无 llm 四种情况都降级为离线叙述者并标 `degraded: true`；路由注册失败不影响牌桌本身。
- **client 半区**（`src/client.cjs`）：对话视图里的「圆桌」Tab，可以提问 / 点名 / 判定 / 收局 / 新一局 / 导出，只显示 host 允许它知道的信息。
- **样例**（`examples/`）：6 座 2 人、3 轮、14 条消息的真实对局（seed `turing-sample-0001`），由 `node scripts/make-sample.mjs` 生成，逐字节可复现。
- **测试**：`node --test`，98 个用例，零运行时依赖、零开发依赖。
