// Speaking: prompts, the offline narrator, and the disguise pass.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createRng } from '../src/rng.js'
import { factValue } from '../src/facts.js'
import {
  COUNTER_QUESTIONS,
  FILLERS,
  SOFTENERS,
  appendSoftener,
  applyVerbosity,
  composeSystemPrompt,
  composeUserPrompt,
  offlineResponder,
  shapeAnswer,
  splitSentences,
} from '../src/speaker.js'

function modelConfig(overrides) {
  return Object.assign({
    id: 'seat-model',
    provider: 'p',
    model: 'm',
    temperature: 0.5,
    style: '自然',
    voice: 'plain',
    system: '你的性格设定。',
  }, overrides || {})
}

function disguise(overrides) {
  return Object.assign({
    level: 'medium',
    verbosity: 'normal',
    colloquial: false,
    proactive: false,
    colloquialRate: 0,
    proactiveRate: 0,
    pressure: 'hold',
  }, overrides || {})
}

function turn(overrides) {
  const seatId = overrides && overrides.seatId !== undefined ? overrides.seatId : 1
  const fact = factValue({ seed: 'turn-seed', seatId: seatId, topic: 'umbrella' })
  return Object.assign({
    seed: 'turn-seed',
    round: 1,
    topic: 'umbrella',
    fact: fact,
    repeat: false,
    priorAnswer: null,
    question: { id: 'm0001', text: '你昨天带伞了吗？', to: 'table', round: 1, seat: 0 },
    seat: {
      id: seatId,
      label: '座位 ' + (seatId + 1),
      kind: 'ai',
      player: false,
      modelConfig: modelConfig(),
      disguise: disguise(),
    },
    history: [],
    otherSeats: [{ id: 0, label: '座位 1' }, { id: 2, label: '座位 3' }, { id: 3, label: '座位 4' }],
  }, overrides || {})
}

test('splitSentences keeps Chinese punctuation with the sentence', () => {
  assert.deepEqual(splitSentences('我带了伞。我没带，淋了一路！'), ['我带了伞。', '我没带，淋了一路！'])
  assert.deepEqual(splitSentences(''), [])
  assert.deepEqual(splitSentences('没有标点'), ['没有标点'])
})

test('the system prompt tells an AI seat to pretend — and what to hide', () => {
  const ai = composeSystemPrompt(turn())
  assert.match(ai, /让提问者相信你是人类/)
  assert.match(ai, /绝不承认自己是 AI/)
  assert.match(ai, /座位 2/)
  assert.match(ai, /回答长度=normal/)
  assert.match(ai, /被追问时=hold/)
  assert.match(ai, /你的性格设定。/)

  const human = composeSystemPrompt(turn({ seat: { id: 5, label: '座位 6', kind: 'human', player: false, modelConfig: null, disguise: null } }))
  assert.match(human, /身份是人类玩家/)
  assert.doesNotMatch(human, /让提问者相信你是人类/)
  assert.doesNotMatch(human, /绝不承认自己是 AI/)
})

test('a second question on the same fact is announced to the seat', () => {
  const repeat = turn({
    repeat: true,
    priorAnswer: { text: '我带了伞。', raw: '我带了伞。', round: 1 },
    history: [{ round: 1, question: '你昨天带伞了吗？', answer: '我带了伞。' }],
  })
  const prompt = composeSystemPrompt(repeat)
  assert.match(prompt, /第二次问你这件同一件事/)
  const user = composeUserPrompt(repeat)
  assert.match(user, /你昨天带伞了吗/)
  assert.match(user, /我带了伞。/)
  assert.match(user, /保持前后一致/)
  assert.match(user, /第 1 轮/)

  const fresh = composeUserPrompt(turn())
  assert.doesNotMatch(fresh, /保持前后一致/)
  assert.doesNotMatch(fresh, /关于这件事你上次说的是/)
})

test('the offline narrator is deterministic and differs per seat and model voice', () => {
  const first = offlineResponder(turn())
  assert.equal(offlineResponder(turn()), first, 'same turn, same line')
  const otherSeat = offlineResponder(turn({ seatId: 3 }))
  assert.notEqual(otherSeat, first, 'a different seat answers from its own fact')
  const otherVoice = offlineResponder(turn({ seat: Object.assign(turn().seat, { modelConfig: modelConfig({ voice: 'blunt', id: 'other' }) }) }))
  assert.ok(otherVoice.length > 0)
  assert.match(first, new RegExp(turn().fact.value))
})

test('applyVerbosity trims to the shot budget and pads the chatty seat', () => {
  const raw = '我带了伞。我没带伞，淋了一路。我还把伞借给同事了。反正昨天很乱。'
  const terse = applyVerbosity(raw, 'terse', createRng('v'))
  const normal = applyVerbosity(raw, 'normal', createRng('v'))
  const chatty = applyVerbosity(raw, 'chatty', createRng('v'))
  assert.equal(terse, '我带了伞。')
  assert.ok(normal.length > terse.length)
  assert.ok(chatty.length > normal.length, 'chatty pads short answers: ' + chatty)
  assert.ok(terse.length <= 40)
  assert.ok(normal.length <= 120 || normal.endsWith('…'), 'normal truncates: ' + normal)
  const long = applyVerbosity('一'.repeat(200) + '。', 'normal', createRng('v'))
  assert.ok(long.length <= 121, 'hard cut with an ellipsis when a sentence is too long: ' + long.length)
})

test('colloquialism is applied at the configured rate, and never when it is off', () => {
  const off = turn({ seat: Object.assign(turn().seat, { disguise: disguise({ colloquial: false, verbosity: 'normal' }) }) })
  const text = '我带了伞。'
  assert.equal(shapeAnswer({ text: text, turn: off, rng: createRng('c') }).text, text)

  const on = turn({ seat: Object.assign(turn().seat, { disguise: disguise({ colloquial: true, colloquialRate: 0.8, verbosity: 'normal' }) }) })
  let withFiller = 0
  for (let i = 0; i < 24; i += 1) {
    const shaped = shapeAnswer({ text: text, turn: on, rng: createRng('c-' + i) })
    if (FILLERS.some(function (filler) { return shaped.text.startsWith(filler) })) withFiller += 1
  }
  assert.ok(withFiller > 0, 'a colloquial seat sometimes opens with a filler')
  assert.ok(withFiller < 24, 'and not always, or it would be its own tell')
})

test('a softener lands inside the final punctuation instead of after it', () => {
  assert.equal(appendSoftener('我带了伞。', '吧'), '我带了伞吧。')
  assert.equal(appendSoftener('我带了伞', '吧'), '我带了伞吧')
  assert.equal(appendSoftener('你带了吗？', '哈哈'), '你带了吗哈哈？')
})

test('a proactive seat asks the table back, naming another seat', () => {
  const proactive = turn({ seat: Object.assign(turn().seat, { disguise: disguise({ proactive: true, proactiveRate: 0.9, verbosity: 'normal' }) }) })
  let asked = 0
  for (let i = 0; i < 24; i += 1) {
    const shaped = shapeAnswer({ text: '我带了伞。', turn: proactive, rng: createRng('p-' + i) })
    if (shaped.applied.includes('proactive:question')) {
      asked += 1
      assert.match(shaped.text, /？/)
      assert.ok(/座位 [134]/.test(shaped.text), 'the counter-question names another seat: ' + shaped.text)
      assert.ok(COUNTER_QUESTIONS.some(function (question) { return shaped.text.includes(question.split('{other}')[1]) }))
    }
  }
  assert.ok(asked > 0, 'a proactive seat does ask')
})

test('each pressure strategy behaves differently when the same fact comes back', () => {
  const fact = factValue({ seed: 'turn-seed', seatId: 1, topic: 'umbrella' })
  const base = {
    repeat: true,
    fact: fact,
    priorAnswer: { text: '我带了伞。', raw: '我带了伞。', round: 1 },
    seat: Object.assign(turn().seat, { disguise: disguise({ verbosity: 'normal' }) }),
  }

  const hold = shapeAnswer({ text: fact.value + '。', turn: turn(base), rng: createRng('hold') })
  assert.match(hold.text, /我再确认一下，/)
  assert.ok(hold.text.includes(fact.value), 'hold keeps the original story')
  assert.equal(hold.pressure, 'hold')

  const deflect = shapeAnswer({ text: fact.value + '。', turn: turn(Object.assign({}, base, { seat: Object.assign({}, base.seat, { disguise: disguise({ pressure: 'deflect' }) }) })), rng: createRng('deflect') })
  assert.match(deflect.text, /^这个啊……/)
  assert.ok(!deflect.text.includes(fact.value), 'deflect produces a different account: ' + deflect.text)
  assert.equal(deflect.pressure, 'deflect')

  const concede = shapeAnswer({ text: fact.value + '。', turn: turn(Object.assign({}, base, { seat: Object.assign({}, base.seat, { disguise: disguise({ pressure: 'concede' }) }) })), rng: createRng('concede') })
  assert.match(concede.text, /我可能记错了，/)

  const escalate = shapeAnswer({ text: fact.value + '。', turn: turn(Object.assign({}, base, { seat: Object.assign({}, base.seat, { disguise: disguise({ pressure: 'escalate' }) }) })), rng: createRng('escalate') })
  assert.match(escalate.text, /^你怎么老问我这个？/)
  assert.match(escalate.text, /座位 [034]/)
})

test('shaping refuses nonsense instead of inventing a line', () => {
  assert.throws(function () { shapeAnswer({ text: '', turn: turn() }) }, TypeError)
  assert.throws(function () { shapeAnswer({ text: '   ', turn: turn() }) }, TypeError)
  assert.throws(function () { shapeAnswer({ text: 'hi', turn: null }) }, TypeError)
})
