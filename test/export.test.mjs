// Export and verification: JSONL that can be read back, and a verdict record
// that adds up.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  ExportError,
  MESSAGE_FIELDS,
  parseJsonl,
  parseVerdicts,
  replay,
  serializeVerdicts,
  toJsonl,
  verifyRound,
} from '../src/export.js'
import { offlineResponder } from '../src/speaker.js'
import { createTable, runRound } from '../src/table.js'

const MODELS = [
  { id: 'e-a', provider: 'p', model: 'a', disguise: { level: 'low' } },
  { id: 'e-b', provider: 'p', model: 'b', disguise: { level: 'high', pressure: 'hold' } },
  { id: 'e-c', provider: 'p', model: 'c', disguise: { level: 'medium', pressure: 'deflect' } },
]

async function played() {
  const t = createTable({
    seed: 'export-seed',
    seatCount: 4,
    humanSeats: 1,
    models: MODELS,
    startedAt: '2020-01-01T00:00:00.000Z',
  })
  const ai = t.seats.filter(function (seat) { return seat.kind === 'ai' })
  t.ask({ text: '你昨天带伞了吗？' })
  await runRound(t, offlineResponder)
  t.ask({ text: '我再确认一遍，你昨天到底带伞了吗？', to: ai[0].id })
  await runRound(t, offlineResponder)
  t.judge(ai[0].id, 'ai', { note: '改了说法' })
  t.judge(ai[1].id, 'human')
  t.close()
  return t
}

function expectCode(fn, code) {
  assert.throws(fn, function (error) {
    assert.ok(error instanceof ExportError, 'expected ExportError, got ' + String(error))
    assert.equal(error.code, code, 'expected ' + code + ', got ' + error.code + ': ' + error.message)
    return true
  })
}

test('toJsonl writes one LF-terminated line per message, with no BOM and no CR', async () => {
  const t = await played()
  const text = toJsonl(t.messages())
  assert.ok(text.endsWith('\n'))
  assert.equal(text.includes('\r'), false, 'no CR anywhere')
  assert.equal(text.charCodeAt(0) === 0xfeff, false, 'no BOM')
  assert.equal(text.split('\n').length, t.messages().length + 1, 'one line each, plus the trailing newline')
  assert.deepEqual(toJsonl([]), '')
})

test('every exported line is self-contained', async () => {
  const t = await played()
  const lines = parseJsonl(toJsonl(t.messages()))
  assert.equal(lines.length, t.messages().length)
  for (const line of lines) {
    for (const field of MESSAGE_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(line, field), line.id + ' is missing ' + field)
      assert.notEqual(line[field], undefined, line.id + '.' + field + ' is undefined')
    }
    assert.equal(line.v, 1)
    assert.deepEqual(line.table, { seed: 'export-seed', seatCount: 4, humanSeats: 1, aiSeats: 3 })
    assert.ok(typeof line.ts === 'string' && line.ts.includes('T'), 'a timestamp travels with the line')
    if (line.role === 'answer') {
      assert.ok(line.replyTo, 'an answer names the question it replies to')
      assert.ok(line.seatKind === 'ai' || line.seatKind === 'human')
    }
  }
})

test('toJsonl refuses a message that is not fit to export', () => {
  expectCode(function () { toJsonl([{ role: 'question', text: 'hi' }]) }, 'missing-field')
  expectCode(function () { toJsonl([null]) }, 'bad-message')
  const complete = parseJsonl(toJsonl([Object.assign({}, require1())]))
  assert.equal(complete.length, 1)
  const bad = require1()
  bad.role = 'gossip'
  expectCode(function () { toJsonl([bad]) }, 'bad-role')
})

function require1() {
  return {
    v: 1, seq: 1, id: 'm0001', round: 1, ts: '2020-01-01T00:00:00.000Z', seat: 0, seatLabel: '座位 1',
    seatKind: 'human', role: 'question', to: 'table', replyTo: null, topic: 'umbrella', modelConfig: null,
    disguise: null, pressure: null, shaped: false, degraded: false, applied: [], raw: null, text: '你昨天带伞了吗？',
    table: { seed: 'x', seatCount: 4, humanSeats: 1, aiSeats: 3 },
  }
}

test('parseJsonl reports the offending line number instead of throwing raw', () => {
  assert.deepEqual(parseJsonl(''), [])
  assert.deepEqual(parseJsonl('\n  \n'), [])
  const text = '{}\n{"a":1}\nnot json\n'
  assert.throws(function () { parseJsonl(text) }, function (error) {
    assert.equal(error.code, 'bad-json')
    assert.match(error.message, /第 3 行/)
    return true
  })
  assert.throws(function () { parseJsonl('[1,2]') }, function (error) {
    assert.equal(error.code, 'bad-line')
    return true
  })
  assert.throws(function () { parseJsonl(null) }, function (error) {
    assert.equal(error.code, 'bad-input')
    return true
  })
})

test('replay rebuilds the whole conversation from the JSONL alone', async () => {
  const t = await played()
  const messages = t.messages()
  const built = replay(parseJsonl(toJsonl(messages)))
  assert.deepEqual(built.transcript, messages, 'the rebuilt transcript equals the original messages')
  assert.equal(built.messageCount, messages.length)
  assert.equal(built.answerCount, messages.filter(function (m) { return m.role === 'answer' }).length)
  assert.deepEqual(built.table, { seed: 'export-seed', seatCount: 4, humanSeats: 1, aiSeats: 3 })
  assert.equal(built.rounds.length, 2)
  assert.match(built.rounds[0].question.text, /你昨天带伞了吗/)
  assert.equal(built.rounds[0].answers.length, 3)
  assert.equal(built.rounds[1].answers.length, 1)
  assert.equal(built.rounds[1].answers[0].pressure, 'hold')
  assert.ok(built.seats.length >= 4)
  const aiSeat = built.seats.find(function (seat) { return seat.seatKind === 'ai' })
  assert.ok(aiSeat.answers > 0)
})

test('replay rejects a record that does not hang together', async () => {
  const t = await played()
  const lines = parseJsonl(toJsonl(t.messages()))
  const clone = function () { return lines.map(function (line) { return JSON.parse(JSON.stringify(line)) }) }

  expectCode(function () { replay([]) }, 'empty-round')

  const dangling = clone()
  dangling[1].replyTo = 'm9999'
  expectCode(function () { replay(dangling) }, 'dangling-reply')

  const badSeq = clone()
  badSeq[1].seq = 99
  expectCode(function () { replay(badSeq) }, 'bad-seq')

  const mixed = clone()
  mixed[1].table.seed = 'another-table'
  expectCode(function () { replay(mixed) }, 'mixed-table')

  const duplicate = clone()
  duplicate[2].seat = duplicate[1].seat
  expectCode(function () { replay(duplicate) }, 'duplicate-answer')

  const backInTime = clone()
  backInTime[backInTime.length - 1].round = 0
  expectCode(function () { replay(backInTime) }, 'bad-round')

  const incomplete = clone()
  delete incomplete[3].applied
  expectCode(function () { replay(incomplete) }, 'missing-field')
})

test('the verdict record round-trips through JSON and rejects impostors', async () => {
  const t = await played()
  const record = t.verdictRecord()
  const text = serializeVerdicts(record)
  assert.ok(text.endsWith('\n'))
  const parsed = parseVerdicts(text)
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(record)))
  assert.equal(parsed.score.judged, 2)
  assert.equal(parsed.score.correct, 1)
  assert.deepEqual(parsed.score.unjudged, [t.score().unjudged[0]])
  assert.equal(parsed.truth[String(t.playerSeat)], 'human')
  assert.equal(parsed.endReason, 'player-closed')
  assert.ok(parsed.endedAt, 'the closing time is recorded')

  expectCode(function () { parseVerdicts('{"kind":"something-else"}') }, 'not-verdicts')
  expectCode(function () { parseVerdicts('not json') }, 'bad-json')
  expectCode(function () { serializeVerdicts({}) }, 'not-verdicts')
  expectCode(function () { serializeVerdicts(null) }, 'bad-input')
})

test('verifyRound accepts a real export and catches a tampered one', async () => {
  const t = await played()
  const jsonl = toJsonl(t.messages())
  const record = t.verdictRecord()
  const ok = verifyRound(jsonl, record)
  assert.equal(ok.ok, true, JSON.stringify(ok.problems))
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.replayed.messageCount, t.messages().length)

  const lines = parseJsonl(jsonl)
  // Relabel one whole seat as human: the record still hangs together, so this
  // reaches the truth check instead of tripping the replay consistency check.
  const relabelledSeat = lines.find(function (line) { return line.role === 'answer' }).seat
  const flipped = lines.map(function (line) {
    const copy = Object.assign({}, line)
    if (copy.seat === relabelledSeat) copy.seatKind = 'human'
    return copy
  })
  const kindProblem = verifyRound(toJsonl(flipped), record)
  assert.equal(kindProblem.ok, false)
  assert.ok(kindProblem.problems.some(function (p) { return p.code === 'kind-mismatch' }), JSON.stringify(kindProblem.problems))

  // And a single inconsistent line is caught even earlier, by replay itself.
  const single = lines.map(function (line) { return Object.assign({}, line) })
  single[1].seatKind = 'human'
  const inconsistent = verifyRound(toJsonl(single), record)
  assert.equal(inconsistent.ok, false)
  assert.equal(inconsistent.problems[0].code, 'unreplayable')

  const wrongScore = JSON.parse(JSON.stringify(record))
  wrongScore.score.correct = 99
  const scoreProblem = verifyRound(jsonl, wrongScore)
  assert.ok(scoreProblem.problems.some(function (p) { return p.code === 'score-correct' }), JSON.stringify(scoreProblem.problems))

  const wrongTruth = JSON.parse(JSON.stringify(record))
  wrongTruth.truth[String(t.playerSeat + 1)] = 'human'
  const truthProblem = verifyRound(jsonl, wrongTruth)
  assert.equal(truthProblem.ok, false)

  const otherSeed = JSON.parse(JSON.stringify(record))
  otherSeed.seed = 'nope'
  assert.ok(verifyRound(jsonl, otherSeed).problems.some(function (p) { return p.code === 'seed-mismatch' }))

  const broken = verifyRound('{"not":"a message"}', record)
  assert.equal(broken.ok, false)
  assert.ok(['unreplayable', 'missing-field'].includes(broken.problems[0].code))
  assert.equal(verifyRound('not json at all', record).problems[0].code, 'unreadable-jsonl')
})

test('Chinese text survives the byte-level round trip', async () => {
  const t = await played()
  const text = toJsonl(t.messages())
  const buffer = Buffer.from(text, 'utf8')
  const back = buffer.toString('utf8')
  assert.equal(back, text)
  const lines = parseJsonl(back)
  assert.equal(lines[0].text, '你昨天带伞了吗？')
  assert.ok(lines.some(function (line) { return line.text.includes('伞') }))
})
