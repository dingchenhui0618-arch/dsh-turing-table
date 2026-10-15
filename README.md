# dsh-turing-table（图灵圆桌）

给 DeepSeek Harness 的**社交推理游戏**：一张桌上有 N 个座位，其中若干座位由**不同模型配置**的 agent 扮演，你要靠**提问**和**交叉印证**（同一个事实换着问、比较各座位的说法矛盾）找出哪些座位是 AI。每局导出**逐席位对话 JSONL**与**判定记录**，同一 seed + 同一份操作脚本可以复现出逐字节相同的对局。

## 为什么要有它

判断一个模型“像不像人”很难，但判断“两个座位里哪个在撒谎”是可玩的。这个插件把 DSH 里的一件事变得可测：**把不同 provider / model / system prompt / 说话风格的 agent 放进同一张桌子，让人在信息不对称下把它们分辨出来**，然后把整个过程落成可复查、可复现、可对比的文件。

这不是评测工具，是游戏。它的产品价值在于**对局记录**：换模型、换提示词、换伪装强度，同一批 seed 跑出来的 JSONL 可以直接 diff。

## 一局怎么玩

**座位与身份（seed 决定）**

- 座位数 `seatCount`（默认 6），其中 `humanSeats`（默认 1）个是人类座位，其余为 AI 座位。
- 座位身份在开局时由 seed 随机分配；人类座位里有一个是**你**（提问者，`player`），你不能判定自己坐的那个座位。
- **座位身份在判定前不会告诉客户端**：host 的 `/state` 里未判定座位的 `kind` 与 `modelConfig` 都是 `null`，判定之后才揭晓——揭晓时能看到该座位实际用的模型配置和伪装参数。

**每个 AI 座位绑定自己的模型配置**

配置来自插件配置项（不是写死的），每项是一个 `{ id, provider, model, temperature, system, style, voice, disguise }`：

- `provider` / `model` 为 `null` 时表示“跟随当前会话的模型”；填上就是真正不同的模型路由（host 会用**该座位自己的路由**发起这次调用，`test/host.test.mjs` 钉住了这一点）。
- 模型池会被 seed 洗牌后依次发给 AI 座位；池子不小于 AI 座位数时，每个座位拿到不同配置。
- 内置 6 个人格作为兜底（`archivist` / `barfly` / `hedger` / `mimic` / `contrarian` / `quiet`），`provider`/`model` 为 `null`。

**伪装强度（disguise）**

三档预设 `low` / `medium` / `high`，也可以逐项覆盖：

| 旋钮 | 作用 | low | medium | high |
| --- | --- | --- | --- | --- |
| `verbosity` | 回答长度预算（`terse`/`normal`/`chatty`，按句截断） | terse | normal | chatty |
| `colloquial` | 口语化：加语气词与软化尾 | 关 | 开（50%） | 开（70%） |
| `proactive` | 是否主动反问别的座位 | 关 | 关 | 开（45%） |
| `pressure` | **被追问时的策略** | concede | hold/concede | hold/deflect/escalate |

`pressure` 的四种策略在“同一事实第二次问同一个座位”时生效，这是本作的核心机制：

- `hold`：坚持原说法（`我再确认一下，…`）
- `deflect`：换一套说法并转移话题 → **会自相矛盾**，这是可以抓到的破绽
- `concede`：承认可能记错（`我可能记错了，…`）
- `escalate`：反问提问者或其他座位（`你怎么老问我这个？…`）

`high` 档会在候选池里按座位自己的随机流挑 `pressure`，所以两个“高伪装”座位不会表现成同一个人。

**一轮流程**

1. 你提问（`to: 'table'` 全桌依次回答，或点名某个座位）；
2. 座位按座位号依次回答，AI 座位的回答经过该座位的伪装策略整形（记录里同时保留 `raw` 原文与 `text` 整形后的话）；
3. 上一轮没答完时不能开新一轮（`unanswered`）；
4. **随时**可以对某个座位下判定（`这是 AI` / `这是人`），判定记录会记住它发生在第几轮——开局盲猜记为第 0 轮，收局之后也允许补判；
5. 全部可判定座位判完（`all-judged`）、你主动收局（`player-closed`）或达到 `maxRounds`（`max-rounds`）时结束。

## 安装

```sh
dsh plugin --profile <你的 profile> add github:dingchenhui0618-arch/dsh-turing-table
```

装好后重启 DSH，对话视图里会出现「圆桌」Tab。（`lib/` 是入库的预构建产物，安装时不需要跑构建脚本，也没有任何依赖——`dependencies` 与 `devDependencies` 都是空的。）

## 配置

```jsonc
{
  "seed": "my-round-0001",      // 不给则用时间戳生成，并显示在面板上（对局仍会被完整记录）
  "seatCount": 6,
  "humanSeats": 1,              // 至少 1，且至少留一个 AI 座位
  "maxRounds": 8,
  "exportDir": "<默认 $DSH_HOME/turing-table>",
  "models": [
    { "id": "a", "provider": "deepseek", "model": "<model-id>", "temperature": 0.3,
      "system": "你话少、只说结论。", "style": "书面", "voice": "dry",
      "disguise": { "level": "low" } },
    { "id": "b", "provider": "deepseek", "model": "<another-model-id>", "temperature": 0.9,
      "system": "你爱闲聊。", "style": "口语化、话多", "voice": "warm",
      "disguise": { "level": "high", "pressure": "hold" } }
  ]
}
```

`models` 是**座位模型池**，不是座位表；谁拿到哪个由 seed 决定。

**单人默认配置的坦白话**：`humanSeats: 1` 时，除你之外所有座位都是 AI，于是“谁是 AI”在已知信息下等于全选。要让这一局真的有猜的成分，需要 ≥2 个人类座位——多人同桌（同一张桌上几个人各自输入），或者由外部驱动人类座位（host 的 `POST /say`，或脚本里的 `say` 步骤）。`examples/sample-spec.json` 就是一个 6 座 2 人的样例：4 个 AI、1 个人类座位（脚本喂台词）、外加你自己。

## 可复现性

座位分配、模型分配、伪装参数、离线回答、整形与时间戳**全部**来自 `src/rng.js` 的种子化随机与一个逻辑时钟：引擎里没有 `Math.random()`，也没有读真实时间。

- `createTable(spec)` 用同一份 spec 重建出完全相同的牌桌（`table.spec()` 就是那份 spec）；
- `runSpec(spec)` 用同一份 seed + 同一份操作脚本跑出**逐字节相同**的 JSONL 与判定记录（`test/cli.test.mjs` 直接拿它和入库的样例文件比字节）；
- 座位分配、模型分配、每个座位的伪装、每条消息的整形各自用**独立的随机子流**（`rng.fork()`），所以往一轮里多加一个问题是安全的：它不会把人重新洗一遍。

**什么是可复现的，什么不是**：牌桌、座位、顺序、prompt、整形、时间戳都可复现；**真实模型吐出的文本不可复现**——同一个 prompt 两次调用本来就不一样。用离线叙述者（`offlineResponder`）或罐头回答时，整局逐字节可复现。记录里 `raw` 与 `text` 并存，就是为了让“模型说了什么”和“伪装做了什么”分得开。

## 导出格式

一局导出两个文件（`examples/` 下的样例由 `node scripts/make-sample.mjs` 真实生成，不是手写）：

**1. 逐席位对话 JSONL**（`sample-round.jsonl`，每行一条自包含消息，LF 结尾、无 BOM）

```json
{"v":1,"seq":2,"id":"m0002","round":1,"ts":"2020-01-01T00:00:01.000Z","seat":1,"seatLabel":"座位 2","seatKind":"ai","role":"answer","to":0,"replyTo":"m0001","topic":"umbrella","modelConfig":{"id":"demo-blunt","provider":"demo-provider","model":"demo-model-d","temperature":0.8,"style":"直接，偶尔反问","voice":"blunt"},"disguise":{"level":"medium","verbosity":"normal","colloquial":true,"proactive":false,"colloquialRate":0.5,"proactiveRate":0,"pressure":"escalate"},"pressure":null,"shaped":true,"degraded":false,"applied":["colloquial:softener"],"raw":"这有啥好问的，应该是我带了伞。","text":"这有啥好问的，应该是我带了伞哈哈。","table":{"seed":"turing-sample-0001","seatCount":6,"humanSeats":2,"aiSeats":4}}
```

| 字段 | 含义 |
| --- | --- |
| `v` / `seq` / `id` | 记录版本、行序号、消息 id（`m0001`…） |
| `round` / `ts` | 第几轮、逻辑时间戳（`startedAt + seq × stepMs`） |
| `seat` / `seatLabel` / `seatKind` | 座位号、显示名、`ai` 或 `human`（真值，供事后分析；客户端在判定前看不到） |
| `role` | `question`（提问者）或 `answer`（座位） |
| `to` / `replyTo` | 这条回答回应哪条消息、提问指向谁（`"table"` 或座位号） |
| `topic` | 事实话题键（内置词表命中，或 `q-<hash>`） |
| `modelConfig` | 该座位这次发言用的模型配置摘要（人类座位为 `null`） |
| `disguise` | 该座位当轮的伪装参数（人类座位为 `null`） |
| `pressure` | 这次回答触发哪种被追问策略（没触发为 `null`） |
| `shaped` / `applied` | 是否经过整形、整形动作清单 |
| `degraded` | 模型失败/缺路由时降级为离线回答的标记 |
| `raw` / `text` | 模型（或人）原始输出 / 整形后真正说出口的话 |
| `table` | 牌桌身份（seed、座位数、人类数），使每一行单看也成立 |

**2. 判定记录**（`sample-verdicts.json`）

`truth`（座位→真值）、`seats[]`（含是否被判定、判定值、对错、判定发生在第几轮、该座位用的模型配置与伪装参数）、`verdicts[]`（判定流水，含时间戳）、`score`（`total` / `judged` / `correct` / `wrong` / `accuracy` = 判对 ÷ 已判 / `coverage` = 已判 ÷ 总数 / `unjudged`）、`endReason`（`all-judged` / `player-closed` / `max-rounds`）。

## 命令

```sh
node scripts/make-sample.mjs                       # 重新生成 examples/（逐字节稳定）
node scripts/export.mjs examples/sample-spec.json  # 跑一遍 spec，导出 JSONL + 判定记录
node scripts/export.mjs --replay examples/sample-round.jsonl
node scripts/export.mjs --verify examples/sample-round.jsonl --verdicts examples/sample-verdicts.json
```

`export.mjs` 也接受 `table.exportRound()` 产出的对局记录（`{kind:'turing-table-round', spec, events, verdicts}`）。**导出前会先自检**（JSONL 可解析、字段齐全、真值与判定一致、分数能对上），自检不过就一个字节都不写。

## 开发

```sh
node scripts/build.mjs   # 零依赖构建：src/ -> lib/
node --test              # 98 个用例
```

`src/` 是手写源码，`lib/` 与 `examples/` 是产物，两者都入库；改 `src/` 后必须重新 `build`（`test/build.test.mjs` 会逐字节比对 `lib/` 与 `src/`，忘记构建会直接红）。

测试覆盖：种子化随机（同种子同序列、子流互不干扰）、伪装预设与逐座位解析、模型池分发、事实记忆与交叉印证、每个 `pressure` 策略的可观测差别、牌桌流程与全部错误码、判定与计分、JSONL 自包含与不可复原记录的拒绝、host 路由与**逐座位模型路由**、四种降级路径、卸载拆除路由、client 半区在 `__ModuleLoader__` 下的加载/渲染/提交/轮询清理、样例逐字节复现、CLI 的正常与错误路径。

## 参考了什么，以及不同在哪

- **骨架**照抄自本机另一个 DSH 插件项目 `dsh-warden` 的结构：`src/` 手写 + `scripts/build.mjs` 零依赖构建到 `lib/`、host 半区 ESM（`lib/index.js` 导出 `name` / `inject` / `apply`）、client 半区 CJS 由 `window.__ModuleLoader__.load()` 包裹、`cordis.patch.yml` 的 `insert` 行、`package.json` 里的 `dsh.bundle.patch` 与 `dsh.client`、README 的章节顺序、以及“路由注册失败也要保住核心功能”的失败策略。只借了**骨架与模式**，没有搬运它的代码，方向也完全不同（那是危险工具调用的审查门，这里是社交推理游戏）。
- 按 Lead 转述，开源世界里存在邻近方向的公开项目（例如线索 `9931666/dsh-plugin-roundtable`）。**我没有核实过它的实现细节，也没有使用它的代码**，它只作为“这条方向有人在做”的旁证。
- 与 warden 的具体不同：多了 `src/table.js`（游戏引擎）、`src/rng.js`（种子化随机）、`src/facts.js`（共享事实）、`src/speaker.js`（prompt + 离线叙述者 + 伪装整形）、`src/export.js`（JSONL / 判定记录的读写与校验）、`scripts/export.mjs`（CLI）、`examples/`（真实生成的对局样例）；没有 `devDependencies`（warden 里那份 esbuild 依赖这里不需要）。

## 它不做什么 / 未验证的部分

- **没在真实 DSH 运行时里跑过**：host 半区的路由、llm 调用与卸载路径都是对着 stub 验证的，`ctx.get('llm')` 的流式分片形状按 warden 的用法推断；client 半区在 `node:vm` + 假 React 下加载渲染，**没有在真实 Web GUI 里加载过**。
- **不接真实模型也能玩**：没有 `llm` 服务或缺路由时自动降级到离线叙述者，并在消息上标 `degraded: true`——离线叙述者只会照内置话题词表（伞/值班/咖啡/钥匙/午饭/通勤/电梯/宠物）记忆事实，**自由措辞的问题在离线模式下不能交叉印证**，那种场景要靠真实模型。
- **不是评测基准**：`score` 只反映这一局玩家的判断，样本量是一局，别拿它当模型能力的证据。
- **不碰你的本机配置**：默认导出目录是 `$DSH_HOME/turing-table/`，只在点击「导出这一局」时写入；测试一律用临时目录。

## License

MIT
