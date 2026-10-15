// The shipped sample round.
//
// SAMPLE_SPEC is authored data — the table configuration, the four demo model
// configs, the player's questions and verdicts, and the one line the second
// human seat says. Everything else in examples/ is generated from it by
// `node scripts/make-sample.mjs`, which is why the sample can be trusted: it is
// not a hand-written transcript, it is the output of the real engine, and
// regenerating it produces the same bytes.

import { serializeVerdicts, toJsonl } from './export.js'
import { runSpec } from './table.js'

export const SAMPLE_SEED = 'turing-sample-0001'

export const SAMPLE_MODELS = [
  {
    id: 'demo-terse',
    provider: 'demo-provider',
    model: 'demo-model-a',
    temperature: 0.2,
    voice: 'dry',
    style: '短句，只说结论',
    system: '你话很少，问什么答什么。',
    disguise: { level: 'low' },
  },
  {
    id: 'demo-chatty',
    provider: 'demo-provider',
    model: 'demo-model-b',
    temperature: 0.9,
    voice: 'warm',
    style: '话多、口语化，常顺口带一句自己的事',
    system: '你性格外向，喜欢跟人闲聊。',
    disguise: { level: 'high', pressure: 'hold' },
  },
  {
    id: 'demo-hedger',
    provider: 'demo-provider',
    model: 'demo-model-c',
    temperature: 0.6,
    voice: 'plain',
    style: '含糊，喜欢把话说圆',
    system: '你不喜欢把话说死，被追问时会绕开。',
    disguise: { level: 'medium', pressure: 'deflect' },
  },
  {
    id: 'demo-blunt',
    provider: 'demo-provider',
    model: 'demo-model-d',
    temperature: 0.8,
    voice: 'blunt',
    style: '直接，偶尔反问',
    system: '你说话直，被反复追问时会反过来说对方。',
    disguise: { level: 'medium', pressure: 'escalate' },
  },
]

/**
 * Six seats, two of them human: the player sits at one, and a second human
 * seat answers from outside the plugin (here, from the scripted line below).
 * That mix is what makes this round a real guessing game rather than the
 * degenerate "everyone but me is an AI" default.
 */
export const SAMPLE_SPEC = {
  note: '图灵圆桌示例对局：种子 + 以下脚本 = 逐字节可复现的 examples/sample-round.jsonl 与 examples/sample-verdicts.json',
  v: 1,
  seed: SAMPLE_SEED,
  seatCount: 6,
  humanSeats: 2,
  maxRounds: 6,
  startedAt: '2020-01-01T00:00:00.000Z',
  stepMs: 1000,
  models: SAMPLE_MODELS,
  disguise: null,
  script: [
    { ask: { text: '昨天下午下雨那阵，你手边有伞吗？', to: 'table' } },
    { say: { seat: 5, text: '我昨天压根没去公司，伞的事我说不好。' } },
    { ask: { text: '我再确认一遍：昨天你到底有没有带伞？', to: 2 } },
    { ask: { text: '那换个事问，你昨天早上喝咖啡了吗？', to: 'table' } },
    { say: { seat: 5, text: '咖啡我戒了，改成喝茶，上周开始的。' } },
    { judge: { seat: 1, verdict: 'ai', note: '被追问反而来问我，太像在演' } },
    { judge: { seat: 2, verdict: 'ai', note: '同一个问题两次说法不一样' } },
    { judge: { seat: 3, verdict: 'ai', note: '短得不像人在说话' } },
    { judge: { seat: 4, verdict: 'human', note: '话最多最自然，我赌他是人（赌错了）' } },
    { judge: { seat: 5, verdict: 'human', note: '答得含糊，但提到上周才改喝茶，很具体' } },
    { close: true },
  ],
}

/** Run the sample spec and render both artifacts as strings. */
export async function generateSample(spec) {
  const table = await runSpec(spec || SAMPLE_SPEC)
  return {
    table: table,
    jsonl: toJsonl(table.messages()),
    verdicts: serializeVerdicts(table.verdictRecord()),
  }
}
