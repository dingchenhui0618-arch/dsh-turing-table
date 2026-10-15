// The table engine: seat assignment, round flow, verdicts, and the promise that
// a seeded run is reproducible.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { MESSAGE_FIELDS, serializeVerdicts, toJsonl } from '../src/export.js'
import { offlineResponder } from '../src/speaker.js'
import { TableError, createTable, normalizeTableConfig, runRound, runSpec } from '../src/table.js'

const MODELS = [
  { id: 'm-a', provider: 'p', model: 'a', voice: 'dry', disguise: { level: 'low' } },
  { id: 'm-b', provider: 'p', model: 'b', voice: 'warm', disguise: { level: 'high', pressure: 'hold' } },
  { id: 'm-c', provider: 'p', model: 'c', disguise: { level: 'medium', pressure: 'deflect' } },
  { id: 'm-d', provider: 'p', model: 'd', disguise: { level: 'medium', pressure: 'escalate' } },
  { id: 'm-e', provider: 'p', model: 'e', disguise: { level: 'low', pressure: 'concede' } },
]

function table(options) {
  return createTable(Object.assign({
    seed: 'test-seed',
    seatCount: 5,
    humanSeats: 1,
    models: MODELS,
    startedAt: '2020-01-01T00:00:00.000Z',
  }, options || {}))
}

/** The nth AI seat's id — tests must never assume which chair a seat got. */
function aiSeat(t, index) {
  return t.seats.filter(function (seat) { return seat.kind === 'ai' })[index || 0].id
}

function humanSeat(t) {
  return t.seats.find(function (seat) { return seat.kind === 'human' && !seat.player }).id
}

function expectCode(fn, code) {
  assert.throws(fn, function (error) {
    assert.ok(error instanceof TableError, 'expected a TableError, got ' + String(error))
    assert.equal(error.code, code, 'expected code ' + code + ', got ' + error.code + ' (' + error.message + ')')
    return true
  })
}

test('the default table is six seats, one human and five AI', () => {
  const t = createTable({ seed: 'defaults' })
  assert.equal(t.config.seatCount, 6)
  assert.equal(t.config.humanSeats, 1)
  assert.equal(t.config.aiSeats, 5)
  assert.equal(t.seats.filter(function (seat) { return seat.player }).length, 1)
  assert.equal(t.seats.filter(function (seat) { return seat.kind === 'human' }).length, 1)
  assert.equal(t.seats[t.playerSeat].kind, 'human')
  assert.ok(normalizeTableConfig({}).models.length >= 5)
})

test('an impossible configuration is refused with a code instead of half a table', () => {
  expectCode(function () { createTable({ seatCount: 1 }) }, 'bad-config')
  expectCode(function () { createTable({ seatCount: 6, humanSeats: 6 }) }, 'bad-config')
  expectCode(function () { createTable({ seatCount: 6, humanSeats: 0 }) }, 'bad-config')
  expectCode(function () { createTable({ seatCount: 6, maxRounds: 0 }) }, 'bad-config')
  const ok = normalizeTableConfig({ seatCount: 8, humanSeats: 3 })
  assert.equal(ok.aiSeats, 5)
})

test('seat assignment is reproducible for a seed and moves when the seed moves', () => {
  const first = table({ seed: 'same' })
  const second = table({ seed: 'same' })
  assert.deepEqual(second.seats, first.seats, 'same seed, same people in the same chairs')
  assert.equal(second.playerSeat, first.playerSeat)

  const shapes = new Set()
  for (let i = 0; i < 12; i += 1) {
    const t = table({ seed: 'seed-' + i })
    shapes.add(t.seats.filter(function (seat) { return seat.kind === 'human' }).map(function (seat) { return seat.id }).join(',') + '|' + t.playerSeat)
  }
  assert.ok(shapes.size >= 2, 'the seed really decides who is who: ' + Array.from(shapes).join(' / '))

  const reloaded = createTable(first.spec())
  assert.deepEqual(reloaded.seats, first.seats, 'a spec round-trips into the same table')
})

test('every AI seat is bound to its own model config and humans carry none', () => {
  const t = table({ seed: 'bind' })
  const ai = t.seats.filter(function (seat) { return seat.kind === 'ai' })
  const human = t.seats.filter(function (seat) { return seat.kind === 'human' })
  assert.equal(ai.length, t.config.aiSeats)
  for (const seat of ai) {
    assert.ok(seat.modelConfig, seat.label + ' has a model config')
    assert.ok(seat.disguise, seat.label + ' has a disguise')
    assert.ok(MODELS.some(function (model) { return model.id === seat.modelConfig.id }), 'config comes from the pool')
  }
  assert.equal(new Set(ai.map(function (seat) { return seat.modelConfig.id })).size, ai.length, 'distinct configs')
  for (const seat of human) {
    assert.equal(seat.modelConfig, null)
    assert.equal(seat.disguise, null)
  }
})

test('a round cannot be opened while seats are still due', () => {
  const t = table()
  const question = t.ask({ text: '你昨天带伞了吗？' })
  assert.equal(question.role, 'question')
  assert.equal(question.round, 1)
  assert.equal(question.seat, t.playerSeat)
  assert.equal(t.pendingSeats().length, 4)
  assert.equal(t.status(), 'awaiting-answers')
  expectCode(function () { t.ask({ text: '换个问题' }) }, 'unanswered')
})

test('questions are validated: no empty questions, no self-questions, no ghosts', () => {
  const t = table()
  expectCode(function () { t.ask({ text: '   ' }) }, 'empty-question')
  expectCode(function () { t.ask({ text: '你好', to: t.playerSeat }) }, 'self-question')
  expectCode(function () { t.ask({ text: '你好', to: 99 }) }, 'unknown-seat')
})

test('answering settles the round and records who replied to what', async () => {
  const t = table({ seed: 'flow' })
  const question = t.ask({ text: '你昨天带伞了吗？' })
  const produced = await runRound(t, offlineResponder)
  assert.equal(produced.length, 4, 'every AI seat that was due spoke')
  assert.deepEqual(t.pendingSeats(), [])
  assert.equal(t.status(), 'awaiting-question')
  const messages = t.messages()
  assert.equal(messages.length, 5, 'one question plus four answers')
  assert.equal(messages[0].id, question.id)
  for (const message of messages.slice(1)) {
    assert.equal(message.role, 'answer')
    assert.equal(message.replyTo, question.id)
    assert.equal(message.to, t.playerSeat)
    assert.equal(message.round, 1)
    assert.equal(message.topic, 'umbrella')
    assert.ok(message.text.length > 0)
  }
  const seats = messages.slice(1).map(function (message) { return message.seat })
  assert.deepEqual(seats, seats.slice().sort(function (a, b) { return a - b }), 'answers come in seat order')
  assert.ok(messages.slice(1).every(function (message) { return message.seatKind === 'ai' }))
})

test('a seat cannot answer out of turn, and an AI seat is not a human driver', () => {
  const t = table({ seed: 'out-of-turn' })
  const first = aiSeat(t, 0)
  const second = aiSeat(t, 1)
  t.ask({ text: '你昨天带伞了吗？', to: first })
  expectCode(function () { t.answer(second, '我也说两句') }, 'not-pending')
  expectCode(function () { t.answer(first, '') }, 'empty-answer')

  const fresh = table({ seed: 'before-question' })
  expectCode(function () { fresh.answer(aiSeat(fresh, 0), '抢答') }, 'not-pending')

  const withHuman = table({ seed: 'humans', humanSeats: 2 })
  withHuman.ask({ text: '你昨天带伞了吗？' })
  expectCode(function () { withHuman.answer(humanSeat(withHuman), '我是人') }, 'not-ai')
  expectCode(function () { withHuman.say(aiSeat(withHuman, 0), '我是 AI') }, 'not-human')
})

test('a human seat is driven verbatim, with no disguise pass', () => {
  const t = table({ seed: 'say', humanSeats: 2 })
  const seat = humanSeat(t)
  t.ask({ text: '你昨天带伞了吗？' })
  assert.ok(t.pendingSeats().includes(seat), 'the human seat is due too')
  const message = t.say(seat, '我昨天没去公司，这事我说不好。')
  assert.equal(message.seatKind, 'human')
  assert.equal(message.shaped, false)
  assert.equal(message.text, '我昨天没去公司，这事我说不好。')
  assert.equal(message.raw, message.text)
  assert.equal(message.modelConfig, null)
  assert.equal(message.disguise, null)
  expectCode(function () { t.say(seat, '再说一句') }, 'not-pending')
})

test('every recorded message is self-contained and the clock only moves forward', async () => {
  const t = table({ seed: 'records' })
  t.ask({ text: '你昨天带伞了吗？' })
  await runRound(t, offlineResponder)
  t.ask({ text: '你昨天早上喝咖啡了吗？' })
  await runRound(t, offlineResponder)
  const messages = t.messages()
  assert.equal(messages.length, 10)
  let previous = ''
  messages.forEach(function (message, index) {
    for (const field of MESSAGE_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(message, field), 'message ' + message.id + ' is missing ' + field)
    }
    assert.equal(message.seq, index + 1)
    assert.equal(message.id, 'm' + String(index + 1).padStart(4, '0'))
    assert.equal(message.table.seed, 'records')
    assert.equal(message.table.seatCount, 5)
    assert.ok(message.ts > previous, 'timestamps increase: ' + message.ts + ' after ' + previous)
    previous = message.ts
    if (message.seat !== null && message.role === 'answer') {
      assert.ok(message.seatLabel.length > 0, 'the label travels with the line')
    }
  })
})

test('the disguise pass trims a talkative raw answer and keeps the original', () => {
  const models = [{ id: 'terse-model', provider: 'p', model: 'x', disguise: { level: 'low' } }]
  const t = table({ seed: 'shape', models: models })
  const seat = aiSeat(t, 0)
  t.ask({ text: '你昨天带伞了吗？', to: seat })
  const raw = '我带了伞。我没带伞，淋了一路。我还把伞借给同事了。反正昨天很乱。'
  const message = t.answer(seat, raw)
  assert.equal(message.raw, raw, 'the raw text survives for analysis')
  assert.notEqual(message.text, raw)
  assert.ok(message.text.length < raw.length)
  assert.equal(message.shaped, true)
  assert.equal(message.disguise.verbosity, 'terse')
  assert.ok(Array.isArray(message.applied))
})

test('a repeated fact trips the seat pressure strategy, and a holder keeps its story', async () => {
  const holder = [{ id: 'hold-model', provider: 'p', model: 'x', disguise: { level: 'medium', pressure: 'hold' } }]
  const t = table({ seed: 'pressure', seatCount: 3, models: holder })
  const seat = aiSeat(t, 0)
  t.ask({ text: '你昨天带伞了吗？', to: seat })
  const first = t.answer(seat, '我带了伞。')
  t.ask({ text: '我再确认一下，你昨天到底带伞了吗？', to: seat })
  const second = t.answer(seat, '我带了伞。')
  assert.equal(second.topic, first.topic, 'both questions are the same fact')
  assert.equal(second.pressure, 'hold')
  assert.match(second.text, /我再确认一下，/)
  assert.ok(second.text.includes('我带了伞'), 'a holder does not change its story')

  const deflector = [{ id: 'deflect-model', provider: 'p', model: 'x', disguise: { level: 'medium', pressure: 'deflect' } }]
  const d = table({ seed: 'deflect', seatCount: 3, models: deflector })
  const dSeat = aiSeat(d, 0)
  d.ask({ text: '你昨天带伞了吗？', to: dSeat })
  d.answer(dSeat, '我带了伞。')
  d.ask({ text: '我再确认一下，你昨天到底带伞了吗？', to: dSeat })
  const slipped = d.answer(dSeat, '我带了伞。')
  assert.equal(slipped.pressure, 'deflect')
  assert.ok(!slipped.text.includes('我带了伞'), 'a deflector contradicts itself, which is the tell: ' + slipped.text)
})

test("a seat's turn context never carries another seat's identity", () => {
  const t = table({ seed: 'context' })
  const seat = aiSeat(t, 0)
  t.ask({ text: '你昨天带伞了吗？' })
  const turn = t.turnContext(seat)
  assert.deepEqual(Object.keys(turn.otherSeats[0]).sort(), ['id', 'label'])
  assert.equal(turn.question.text, '你昨天带伞了吗？')
  assert.equal(turn.seat.kind, 'ai', 'the seat knows what it is')
  assert.equal(turn.repeat, false)
  assert.equal(turn.priorAnswer, null)
  assert.equal(turn.fact.topic, 'umbrella')
  const text = JSON.stringify(turn.otherSeats)
  assert.ok(!text.includes('"kind"'), 'no kind leaks through the other-seat list: ' + text)
  expectCode(function () { t.turnContext(99) }, 'unknown-seat')
})

test('verdicts record truth, round and correctness, and refuse to be rewritten', async () => {
  const t = table({ seed: 'verdicts' })
  t.ask({ text: '你昨天带伞了吗？' })
  await runRound(t, offlineResponder)
  t.ask({ text: '你昨天早上喝咖啡了吗？' })
  await runRound(t, offlineResponder)

  const right = t.judge(aiSeat(t, 0), 'ai', { note: '两次说法对上了' })
  assert.equal(right.correct, true)
  assert.equal(right.truth, 'ai')
  assert.equal(right.round, 2, 'the verdict remembers which round it was cast in')
  const wrong = t.judge(aiSeat(t, 1), 'human')
  assert.equal(wrong.correct, false)
  assert.equal(wrong.note, null)

  expectCode(function () { t.judge(aiSeat(t, 0), 'human') }, 'already-judged')
  expectCode(function () { t.judge(t.playerSeat, 'ai') }, 'self-verdict')
  expectCode(function () { t.judge(t.score().unjudged[0], 'robot') }, 'bad-verdict')
  expectCode(function () { t.judge(99, 'ai') }, 'unknown-seat')

  const score = t.score()
  assert.equal(score.total, 4)
  assert.equal(score.judged, 2)
  assert.equal(score.correct, 1)
  assert.equal(score.accuracy, 0.5)
  assert.equal(score.coverage, 0.5)
  assert.equal(score.unjudged.length, 2)
})

test('judging every seat ends the round by itself', () => {
  const t = table({ seed: 'all-judged' })
  t.ask({ text: '你昨天带伞了吗？' })
  for (const id of t.judgeableSeats()) t.judge(id, 'ai')
  assert.equal(t.isOver(), true)
  assert.equal(t.endReason(), 'all-judged')
  assert.equal(t.score().accuracy, t.score().correct / t.score().judged)
  expectCode(function () { t.ask({ text: '还能再问吗' }) }, 'game-over')
  expectCode(function () { t.answer(aiSeat(t, 0), '还能再说吗') }, 'game-over')
})

test('a verdict may be cast after the table closes, but no new talk', () => {
  const t = table({ seed: 'closed' })
  t.ask({ text: '你昨天带伞了吗？' })
  const closed = t.close()
  assert.equal(closed.endReason, 'player-closed')
  assert.equal(t.isOver(), true)
  const entry = t.judge(aiSeat(t, 0), 'ai')
  assert.equal(entry.round, 1)
  assert.equal(t.verdictRecord().endReason, 'player-closed', 'a late verdict does not rewrite why the round ended')
  expectCode(function () { t.say(aiSeat(t, 1), '你好') }, 'game-over')
})

test('maxRounds closes the round even with seats still unjudged', async () => {
  const t = table({ seed: 'max-rounds', maxRounds: 1 })
  t.ask({ text: '你昨天带伞了吗？' })
  await runRound(t, offlineResponder)
  assert.equal(t.isOver(), true)
  assert.equal(t.endReason(), 'max-rounds')
  assert.equal(t.score().unjudged.length, 4)
  assert.equal(t.close().endReason, 'max-rounds', 'closing an already finished round is a no-op')
})

test('the public view hides identity until a seat is judged, then shows the evidence', () => {
  const t = table({ seed: 'public' })
  t.ask({ text: '你昨天带伞了吗？' })
  const hidden = t.publicView()
  assert.equal(hidden.round, 1)
  const others = hidden.seats.filter(function (seat) { return !seat.player })
  assert.equal(others.every(function (seat) { return seat.kind === null }), true)
  assert.equal(others.every(function (seat) { return seat.modelConfig === null }), true)
  const text = JSON.stringify(hidden)
  for (const model of MODELS) assert.ok(!text.includes(model.id), 'the public view does not name ' + model.id)

  const target = aiSeat(t, 0)
  t.judge(target, 'ai')
  const revealed = t.publicView()
  const row = revealed.seats.find(function (seat) { return seat.id === target })
  assert.equal(row.judged, true)
  assert.equal(row.kind, 'ai')
  assert.equal(row.correct, true)
  assert.ok(row.modelConfig && row.modelConfig.id.length > 0, 'the seat model config is shown after the call')
  const stillHidden = revealed.seats.filter(function (seat) { return !seat.player && !seat.judged && seat.kind !== null })
  assert.equal(stillHidden.length, 0, 'unjudged seats stay hidden')
})

test('closing the table reveals every seat, judged or not', () => {
  const t = table({ seed: 'reveal-on-close' })
  t.ask({ text: '你昨天带伞了吗？' })
  t.close()
  const view = t.publicView()
  assert.equal(view.over, true)
  assert.equal(view.seats.every(function (seat) { return seat.kind !== null }), true)
})

test('the same seed and the same script produce byte-identical exports', async () => {
  const base = {
    seed: 'replay-seed',
    seatCount: 4,
    humanSeats: 1,
    models: MODELS,
    startedAt: '2020-01-01T00:00:00.000Z',
  }
  const probe = createTable(base)
  const spec = Object.assign({}, base, {
    script: [
      { ask: { text: '你昨天带伞了吗？', to: 'table' } },
      { ask: { text: '你昨天早上喝咖啡了吗？', to: 'table' } },
      { judge: { seat: aiSeat(probe, 0), verdict: 'ai' } },
      { close: true },
    ],
  })
  const first = await runSpec(spec)
  const second = await runSpec(spec)
  assert.equal(toJsonl(second.messages()), toJsonl(first.messages()))
  assert.equal(serializeVerdicts(second.verdictRecord()), serializeVerdicts(first.verdictRecord()))
  assert.equal(first.roundNumber(), 2)
  assert.equal(first.endReason(), 'player-closed')
  assert.equal(first.messages().length, 8)

  const other = await runSpec(Object.assign({}, spec, { seed: 'replay-seed-2' }))
  assert.notEqual(toJsonl(other.messages()), toJsonl(first.messages()), 'a different seed is a different round')
})

test('runSpec drives the human seat from the script and refuses an undriven one', async () => {
  const base = { seed: 'spec-human', seatCount: 4, humanSeats: 2, models: MODELS }
  const probe = createTable(base)
  const seat = humanSeat(probe)

  const withHuman = await runSpec(Object.assign({}, base, {
    script: [
      { ask: { text: '你昨天带伞了吗？', to: 'table' } },
      { say: { seat: seat, text: '我昨天没去公司。' } },
      { close: true },
    ],
  }))
  const humanLine = withHuman.messages().find(function (message) { return message.seatKind === 'human' && message.role === 'answer' })
  assert.ok(humanLine, 'the scripted human line made it into the transcript')
  assert.equal(humanLine.seat, seat)
  assert.equal(humanLine.round, 1)

  await assert.rejects(function () {
    return runSpec(Object.assign({}, base, { script: [{ ask: { text: '你昨天带伞了吗？', to: 'table' } }] }))
  }, function (error) {
    assert.equal(error.code, 'undriven-human')
    return true
  })

  await assert.rejects(function () {
    return runSpec(Object.assign({}, base, {
      script: [
        { ask: { text: '你昨天带伞了吗？', to: aiSeat(probe, 0) } },
        { say: { seat: seat, text: '这句用不上。' } },
      ],
    }))
  }, function (error) {
    assert.equal(error.code, 'unused-human-line')
    return true
  })

  await assert.rejects(function () { return runSpec({ script: [{ dance: true }] }) }, function (error) {
    assert.equal(error.code, 'bad-step')
    return true
  })
})
