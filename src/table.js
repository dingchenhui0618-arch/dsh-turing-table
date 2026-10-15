// The table: seats, rounds, answers, verdicts, and the record of all of it.
//
// Design rules that the tests pin down:
//   * nothing here reads the clock or Math.random() — the same seed plus the
//     same player actions replay to the same bytes;
//   * a seat only answers when it is due, and a round cannot be opened while
//     the previous one is unfinished;
//   * the public view never leaks which seats are AI — that is the whole game;
//   * every recorded message is self-contained, so a JSONL line stands alone.

import { createRng } from './rng.js'
import { DEFAULT_MODELS, assignModelConfigs, normalizeModelConfig, resolveDisguise } from './personas.js'
import { factValue, topicOf } from './facts.js'
import { offlineResponder, shapeAnswer } from './speaker.js'

export const ROUND_VERSION = 1
export const DEFAULT_SEAT_COUNT = 6
export const DEFAULT_HUMAN_SEATS = 1
export const DEFAULT_MAX_ROUNDS = 8
export const DEFAULT_STARTED_AT = Date.parse('2020-01-01T00:00:00.000Z')
export const DEFAULT_STEP_MS = 1000

export class TableError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TableError'
    this.code = code
  }
}

function fail(code, message) {
  throw new TableError(code, message)
}

function isoAt(ms) {
  return new Date(ms).toISOString()
}

/**
 * Normalise table options. Everything the engine needs to replay a table lives
 * in here, and nothing else does — that is what `spec()` hands out.
 */
export function normalizeTableConfig(input) {
  const source = input && typeof input === 'object' ? input : {}
  const seatCount = Number.isFinite(Number(source.seatCount)) ? Math.floor(Number(source.seatCount)) : DEFAULT_SEAT_COUNT
  if (seatCount < 2 || seatCount > 16) fail('bad-config', 'seatCount 必须在 2 到 16 之间，收到 ' + String(source.seatCount))
  const humanSeats = Number.isFinite(Number(source.humanSeats)) ? Math.floor(Number(source.humanSeats)) : DEFAULT_HUMAN_SEATS
  if (humanSeats < 1 || humanSeats > seatCount - 1) {
    fail('bad-config', 'humanSeats 必须在 1 到 seatCount-1（至少留一个 AI 座位）之间，收到 ' + String(source.humanSeats))
  }
  const maxRounds = Number.isFinite(Number(source.maxRounds)) ? Math.floor(Number(source.maxRounds)) : DEFAULT_MAX_ROUNDS
  if (maxRounds < 1) fail('bad-config', 'maxRounds 必须 >= 1')
  const models = (Array.isArray(source.models) && source.models.length > 0 ? source.models : DEFAULT_MODELS)
    .map(function (model, index) { return normalizeModelConfig(model, index) })

  let startedAt = DEFAULT_STARTED_AT
  if (Number.isFinite(Number(source.startedAt))) startedAt = Number(source.startedAt)
  else if (typeof source.startedAt === 'string') {
    const parsed = Date.parse(source.startedAt)
    if (Number.isFinite(parsed)) startedAt = parsed
  }

  const stepMs = Number.isFinite(Number(source.stepMs)) ? Math.max(1, Math.floor(Number(source.stepMs))) : DEFAULT_STEP_MS
  const labels = Array.isArray(source.seatLabels) ? source.seatLabels : null

  return {
    seed: source.seed === undefined || source.seed === null ? 'turing-table' : String(source.seed),
    seatCount: seatCount,
    humanSeats: humanSeats,
    aiSeats: seatCount - humanSeats,
    maxRounds: maxRounds,
    models: models,
    disguise: source.disguise === undefined ? null : source.disguise,
    seatLabels: labels,
    startedAt: startedAt,
    stepMs: stepMs,
  }
}

function modelConfigRef(model) {
  if (!model) return null
  return {
    id: model.id,
    provider: model.provider,
    model: model.model,
    temperature: model.temperature,
    style: model.style,
    voice: model.voice,
  }
}

function messageTemplate(seed, seatCount, humanSeats) {
  return {
    v: ROUND_VERSION,
    seq: 0,
    id: '',
    round: 0,
    ts: '',
    seat: null,
    seatLabel: null,
    seatKind: null,
    role: 'answer',
    to: null,
    replyTo: null,
    topic: null,
    modelConfig: null,
    disguise: null,
    pressure: null,
    shaped: false,
    degraded: false,
    applied: [],
    raw: null,
    text: '',
    table: { seed: seed, seatCount: seatCount, humanSeats: humanSeats, aiSeats: seatCount - humanSeats },
  }
}

export function createTable(options) {
  const config = normalizeTableConfig(options)
  const seed = config.seed
  const ids = []
  for (let i = 0; i < config.seatCount; i += 1) ids.push(i)

  // Seat assignment, player choice and model dealing each draw from their own
  // substream, so nothing that happens later can move who is who.
  const deal = createRng(seed + '/seats').shuffle(ids)
  const humanIds = deal.slice(0, config.humanSeats).sort(function (a, b) { return a - b })
  const aiIds = deal.slice(config.humanSeats).sort(function (a, b) { return a - b })
  const playerSeat = createRng(seed + '/player').pick(humanIds)
  const assignment = assignModelConfigs(config.models, aiIds, createRng(seed + '/models'))

  const seats = ids.map(function (id) {
    const isAi = aiIds.includes(id)
    const modelConfig = isAi ? assignment[id] : null
    const disguiseSource = isAi
      ? (modelConfig.disguise === null || modelConfig.disguise === undefined ? config.disguise : modelConfig.disguise)
      : null
    const label = config.seatLabels && typeof config.seatLabels[id] === 'string'
      ? config.seatLabels[id]
      : '座位 ' + (id + 1)
    return {
      id: id,
      label: label,
      kind: isAi ? 'ai' : 'human',
      player: id === playerSeat,
      modelConfig: modelConfig,
      disguise: isAi ? resolveDisguise(disguiseSource, createRng(seed + '/disguise/' + id)) : null,
      answerCount: 0,
    }
  })

  const events = []
  const verdicts = []
  let round = 0
  let question = null
  let pending = []
  let status = 'awaiting-question'
  let over = false
  let endReason = null
  let endedAt = null
  let messageTicks = 0
  let verdictTicks = 0

  function nextMessageTs() {
    const ms = config.startedAt + messageTicks * config.stepMs
    messageTicks += 1
    return isoAt(ms)
  }

  /**
   * Verdicts run on their own clock, offset past the messages that already
   * happened — so the two timelines read coherently without a verdict ever
   * shifting a single JSONL timestamp.
   */
  function nextVerdictTs() {
    const ms = config.startedAt + (events.length + verdictTicks) * config.stepMs
    verdictTicks += 1
    return isoAt(ms)
  }

  function seatOf(seatId) {
    const id = Number(seatId)
    if (!Number.isInteger(id) || id < 0 || id >= config.seatCount) {
      fail('unknown-seat', '没有这个座位：' + String(seatId))
    }
    return seats[id]
  }

  function record(fields) {
    const seq = events.length + 1
    const message = Object.assign(messageTemplate(seed, config.seatCount, config.humanSeats), fields, {
      seq: seq,
      id: 'm' + String(seq).padStart(4, '0'),
      round: fields && Number.isFinite(fields.round) ? fields.round : round,
      ts: fields && typeof fields.ts === 'string' ? fields.ts : nextMessageTs(),
    })
    events.push(message)
    return message
  }

  function judgeableSeats() {
    return seats.filter(function (seat) { return !seat.player }).map(function (seat) { return seat.id })
  }

  function finish(reason) {
    if (over) return
    over = true
    endReason = reason
    endedAt = nextVerdictTs()
    status = 'over'
  }

  function settle() {
    if (over) return
    if (verdicts.length >= judgeableSeats().length) return finish('all-judged')
    if (round >= config.maxRounds) return finish('max-rounds')
    status = 'awaiting-question'
  }

  function ask(input) {
    const source = input && typeof input === 'object' ? input : {}
    if (over) fail('game-over', '本局已结束（' + String(endReason) + '），要再来一局请先开新局')
    if (pending.length > 0) fail('unanswered', '还有座位没回答：' + pending.join('、'))
    const text = typeof source.text === 'string' ? source.text.trim() : ''
    if (text.length === 0) fail('empty-question', '提问不能是空的')
    let to = source.to
    if (to === undefined || to === null || to === 'table' || to === 'all') to = 'table'
    else {
      const target = seatOf(to)
      if (target.player) fail('self-question', '不能向自己坐的座位提问')
      to = target.id
    }
    round += 1
    question = record({
      seat: playerSeat,
      seatLabel: seats[playerSeat].label,
      seatKind: seats[playerSeat].kind,
      role: 'question',
      to: to,
      topic: topicOf(text),
      text: text,
    })
    pending = (to === 'table' ? judgeableSeats() : [to])
    status = 'awaiting-answers'
    return question
  }

  function answer(seatId, rawText, options) {
    if (over) fail('game-over', '本局已结束，不能再回答')
    const seat = seatOf(seatId)
    if (seat.kind !== 'ai') fail('not-ai', seat.label + ' 是人类座位，请用 say() 由真人输入')
    if (seat.player) fail('self-answer', '提问者不用回答自己的问题')
    if (!pending.includes(seat.id)) fail('not-pending', seat.label + ' 现在不需要回答')
    if (typeof rawText !== 'string' || rawText.trim().length === 0) fail('empty-answer', '回答不能是空的')
    const turn = turnContext(seat.id)
    const shaped = shapeAnswer({ text: rawText, turn: turn, rng: createRng(seed + '/shape/' + seat.id + '/' + round) })
    const message = record({
      seat: seat.id,
      seatLabel: seat.label,
      seatKind: seat.kind,
      role: 'answer',
      to: question ? question.seat : null,
      replyTo: question ? question.id : null,
      topic: turn.topic,
      modelConfig: modelConfigRef(seat.modelConfig),
      disguise: seat.disguise ? Object.assign({}, seat.disguise) : null,
      pressure: shaped.pressure,
      shaped: true,
      degraded: Boolean(options && options.degraded),
      applied: shaped.applied,
      raw: rawText.trim(),
      text: shaped.text,
    })
    seat.answerCount += 1
    pending = pending.filter(function (id) { return id !== seat.id })
    if (pending.length === 0) settle()
    return message
  }

  /** A human-driven seat's line, typed by a person (host API / scripted spec). */
  function say(seatId, text) {
    if (over) fail('game-over', '本局已结束，不能再说话')
    const seat = seatOf(seatId)
    if (seat.kind !== 'human') fail('not-human', seat.label + ' 是 AI 座位，请用 answer()')
    if (seat.player) fail('self-answer', '提问者不用回答自己的问题')
    if (!pending.includes(seat.id)) fail('not-pending', seat.label + ' 现在不需要回答')
    const value = typeof text === 'string' ? text.trim() : ''
    if (value.length === 0) fail('empty-answer', '回答不能是空的')
    const message = record({
      seat: seat.id,
      seatLabel: seat.label,
      seatKind: seat.kind,
      role: 'answer',
      to: question ? question.seat : null,
      replyTo: question ? question.id : null,
      topic: topicOf(question ? question.text : ''),
      shaped: false,
      raw: value,
      text: value,
    })
    seat.answerCount += 1
    pending = pending.filter(function (id) { return id !== seat.id })
    if (pending.length === 0) settle()
    return message
  }

  /**
   * A verdict may be cast at any time — before the first question, between
   * rounds, or after the table closed; closing only shuts the questions down.
   */
  function judge(seatId, verdict, options) {
    const seat = seatOf(seatId)
    if (seat.player) fail('self-verdict', '不能判定自己坐的那个座位')
    if (verdict !== 'ai' && verdict !== 'human') fail('bad-verdict', '判定只能是 "ai" 或 "human"')
    if (verdicts.some(function (entry) { return entry.seat === seat.id })) {
      fail('already-judged', seat.label + ' 已经判定过了')
    }
    const entry = {
      seat: seat.id,
      seatLabel: seat.label,
      verdict: verdict,
      truth: seat.kind,
      correct: verdict === seat.kind,
      round: round,
      ts: nextVerdictTs(),
      note: options && typeof options.note === 'string' ? options.note : null,
    }
    verdicts.push(entry)
    settle()
    return entry
  }

  function close() {
    if (over) return { over: true, endReason: endReason, endedAt: endedAt }
    finish('player-closed')
    return { over: true, endReason: endReason, endedAt: endedAt }
  }

  function historyOf(seatId) {
    return events
      .filter(function (event) { return event.role === 'answer' && event.seat === seatId })
      .map(function (event) {
        const asked = events.find(function (item) { return item.id === event.replyTo })
        return { round: event.round, question: asked ? asked.text : '', answer: event.text }
      })
  }

  /**
   * Everything one seat needs for its next turn. It deliberately carries only
   * labels for the other seats — never their kind — so no prompt or offline
   * narrator can leak the answer through a system message.
   */
  function turnContext(seatId) {
    const seat = seatOf(seatId)
    if (!question) fail('no-question', '还没有提问，座位没有可回答的问题')
    const text = question.text
    const topic = topicOf(text)
    const prior = events.filter(function (event) {
      return event.role === 'answer' && event.seat === seat.id && event.topic === topic
    })
    const fact = factValue({ seed: seed, seatId: seat.id, topic: topic })
    const last = prior.length > 0 ? prior[prior.length - 1] : null
    return {
      seed: seed,
      round: round,
      topic: topic,
      fact: fact,
      repeat: prior.length > 0,
      priorAnswer: last ? { text: last.text, raw: last.raw, round: last.round } : null,
      question: { id: question.id, text: text, to: question.to, round: question.round, seat: question.seat },
      seat: {
        id: seat.id,
        label: seat.label,
        kind: seat.kind,
        player: seat.player,
        modelConfig: seat.modelConfig,
        disguise: seat.disguise ? Object.assign({}, seat.disguise) : null,
      },
      history: historyOf(seat.id),
      otherSeats: seats.map(function (item) { return { id: item.id, label: item.label } }),
    }
  }

  function score() {
    const correct = verdicts.filter(function (entry) { return entry.correct }).length
    const judged = verdicts.length
    const total = judgeableSeats().length
    return {
      total: total,
      judged: judged,
      correct: correct,
      wrong: judged - correct,
      accuracy: judged === 0 ? 0 : correct / judged,
      coverage: total === 0 ? 0 : judged / total,
      unjudged: judgeableSeats().filter(function (id) {
        return !verdicts.some(function (entry) { return entry.seat === id })
      }),
    }
  }

  function spec() {
    return {
      v: ROUND_VERSION,
      seed: seed,
      seatCount: config.seatCount,
      humanSeats: config.humanSeats,
      aiSeats: config.aiSeats,
      maxRounds: config.maxRounds,
      startedAt: isoAt(config.startedAt),
      stepMs: config.stepMs,
      models: config.models.map(function (model) { return Object.assign({}, model) }),
      disguise: config.disguise,
    }
  }

  function verdictRecord() {
    return {
      v: ROUND_VERSION,
      kind: 'turing-table-verdicts',
      seed: seed,
      seatCount: config.seatCount,
      humanSeats: config.humanSeats,
      aiSeats: config.aiSeats,
      playerSeat: playerSeat,
      startedAt: isoAt(config.startedAt),
      endedAt: endedAt,
      endReason: endReason,
      status: status,
      rounds: round,
      truth: seats.reduce(function (acc, seat) { acc[String(seat.id)] = seat.kind; return acc }, {}),
      seats: seats.map(function (seat) {
        const entry = verdicts.find(function (item) { return item.seat === seat.id })
        return {
          seat: seat.id,
          label: seat.label,
          kind: seat.kind,
          player: seat.player,
          answers: seat.answerCount,
          modelConfig: modelConfigRef(seat.modelConfig),
          disguise: seat.disguise ? Object.assign({}, seat.disguise) : null,
          judged: Boolean(entry),
          verdict: entry ? entry.verdict : null,
          correct: entry ? entry.correct : null,
          judgedRound: entry ? entry.round : null,
          note: entry ? entry.note : null,
        }
      }),
      verdicts: verdicts.map(function (entry) { return Object.assign({}, entry) }),
      score: score(),
    }
  }

  function publicView() {
    return {
      v: ROUND_VERSION,
      seed: seed,
      seatCount: config.seatCount,
      humanSeats: config.humanSeats,
      aiSeats: config.aiSeats,
      playerSeat: playerSeat,
      round: round,
      maxRounds: config.maxRounds,
      status: status,
      over: over,
      endReason: endReason,
      pending: pending.slice(),
      remaining: score().unjudged,
      seats: seats.map(function (seat) {
        const entry = verdicts.find(function (item) { return item.seat === seat.id })
        const lastAnswer = events.filter(function (event) {
          return event.role === 'answer' && event.seat === seat.id
        })
        const revealed = Boolean(entry) || seat.player || over
        return {
          id: seat.id,
          label: seat.label,
          player: seat.player,
          pending: pending.includes(seat.id),
          answers: seat.answerCount,
          lastText: lastAnswer.length > 0 ? lastAnswer[lastAnswer.length - 1].text : null,
          judged: Boolean(entry),
          verdict: entry ? entry.verdict : null,
          correct: entry ? entry.correct : null,
          judgedRound: entry ? entry.round : null,
          // Truth stays hidden until the seat is judged — that is the game.
          kind: revealed ? seat.kind : null,
          modelConfig: revealed ? modelConfigRef(seat.modelConfig) : null,
          disguise: revealed && seat.disguise ? Object.assign({}, seat.disguise) : null,
        }
      }),
      transcript: events.map(function (event) {
        return {
          id: event.id,
          round: event.round,
          ts: event.ts,
          seat: event.seat,
          seatLabel: event.seatLabel,
          role: event.role,
          to: event.to,
          replyTo: event.replyTo,
          text: event.text,
        }
      }),
      verdicts: verdicts.map(function (entry) { return Object.assign({}, entry) }),
      score: score(),
    }
  }

  return {
    config: config,
    seed: seed,
    seats: seats,
    playerSeat: playerSeat,
    humanSeats: humanIds.slice(),
    aiSeats: aiIds.slice(),

    seat: seatOf,
    judgeableSeats: judgeableSeats,
    pendingSeats: function () { return pending.slice() },
    roundNumber: function () { return round },
    status: function () { return status },
    isOver: function () { return over },
    endReason: function () { return endReason },
    currentQuestion: function () { return question ? Object.assign({}, question) : null },
    messages: function () { return events.slice() },
    verdictList: function () { return verdicts.map(function (entry) { return Object.assign({}, entry) }) },

    ask: ask,
    answer: answer,
    say: say,
    judge: judge,
    close: close,

    turnContext: turnContext,
    score: score,
    spec: spec,
    publicView: publicView,
    verdictRecord: verdictRecord,
    exportRound: function () {
      return {
        v: ROUND_VERSION,
        kind: 'turing-table-round',
        spec: spec(),
        events: events.map(function (event) { return Object.assign({}, event) }),
        verdicts: verdictRecord(),
      }
    },
    state: function () {
      return {
        spec: spec(),
        seats: seats.map(function (seat) {
          return {
            id: seat.id,
            label: seat.label,
            kind: seat.kind,
            player: seat.player,
            answers: seat.answerCount,
            modelConfig: modelConfigRef(seat.modelConfig),
            disguise: seat.disguise ? Object.assign({}, seat.disguise) : null,
          }
        }),
        round: round,
        status: status,
        over: over,
        endReason: endReason,
        pending: pending.slice(),
        events: events.slice(),
        verdicts: verdicts.map(function (entry) { return Object.assign({}, entry) }),
        score: score(),
      }
    },
  }
}

/**
 * Let every AI seat that is due speak. `responder(turn, table)` may be async and
 * may return undefined for a seat it does not drive — an undriven human seat
 * simply stays pending, which is what the live host does with a human driver.
 */
export async function runRound(table, responder) {
  const produced = []
  const due = table.pendingSeats()
  for (const seatId of due) {
    const seat = table.seat(seatId)
    const turn = table.turnContext(seatId)
    let text
    let failed = null
    try {
      text = await responder(turn, table)
    } catch (error) {
      failed = String((error && error.message) || error)
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      if (seat.kind !== 'ai') continue
      text = offlineResponder(turn)
      failed = failed || 'offline-fallback'
    }
    if (seat.kind === 'ai') produced.push(table.answer(seatId, text, { degraded: failed !== null }))
    else produced.push(table.say(seatId, text))
  }
  return produced
}

/**
 * Replay a spec: table options plus a script of player actions.
 *
 * Human lines are declared with `{ say: { seat, text } }` steps and are handed
 * to the human seat when its turn comes, so the transcript keeps seat order.
 * A declared line that is never used, or a human seat left undriven, is an
 * error rather than a silently short round.
 */
export async function runSpec(spec, options) {
  const source = spec && typeof spec === 'object' ? spec : {}
  const settings = options && typeof options === 'object' ? options : {}
  const config = source.spec && typeof source.spec === 'object' ? source.spec : source
  const script = Array.isArray(source.script) ? source.script : []
  const table = createTable(config)

  const queues = new Map()
  for (const step of script) {
    if (step && step.say && typeof step.say === 'object') {
      const seatId = Number(step.say.seat)
      if (!queues.has(seatId)) queues.set(seatId, [])
      queues.get(seatId).push(String(step.say.text === undefined ? '' : step.say.text))
    }
  }

  const custom = typeof settings.responder === 'function' ? settings.responder : null
  const responder = async function (turn) {
    if (turn.seat.kind === 'human') {
      const queue = queues.get(turn.seat.id)
      if (queue && queue.length > 0) return queue.shift()
      return undefined
    }
    return custom ? custom(turn) : offlineResponder(turn)
  }

  for (const step of script) {
    if (!step || typeof step !== 'object') fail('bad-step', '脚本里出现了非对象的步骤')
    if (step.ask) {
      table.ask(step.ask)
      await runRound(table, responder)
      if (table.pendingSeats().length > 0) {
        fail('undriven-human', '第 ' + table.roundNumber() + ' 轮里人类座位 ' + table.pendingSeats().join('、') + ' 没有台词')
      }
    } else if (step.judge) {
      table.judge(step.judge.seat, step.judge.verdict, { note: step.judge.note })
    } else if (step.close) {
      table.close()
    } else if (!step.say) {
      fail('bad-step', '不认识的脚本步骤：' + Object.keys(step).join('/'))
    }
  }

  for (const entry of queues.entries()) {
    if (entry[1].length > 0) {
      fail('unused-human-line', '为座位 ' + entry[0] + ' 准备了 ' + entry[1].length + ' 句台词却没用上')
    }
  }

  return table
}
