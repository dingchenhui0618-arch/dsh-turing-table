// Export and verification: a round becomes a JSONL transcript (one
// self-contained message per line) plus a verdict record, and either can be
// read back and checked.
//
// The two invariants worth stating plainly, because the tests hold them:
//   1. a line is self-contained — reader, seat, round, timestamp, model config
//      and table identity all travel with the text, so a single line still
//      means something on its own;
//   2. replaying the JSONL rebuilds the whole conversation, so the export is
//      not a screenshot of the game, it is the game.

export const MESSAGE_FIELDS = [
  'v',
  'seq',
  'id',
  'round',
  'ts',
  'seat',
  'seatLabel',
  'seatKind',
  'role',
  'to',
  'replyTo',
  'topic',
  'modelConfig',
  'disguise',
  'pressure',
  'shaped',
  'degraded',
  'applied',
  'raw',
  'text',
  'table',
]

export const VERDICT_KIND = 'turing-table-verdicts'

function missingFields(message) {
  return MESSAGE_FIELDS.filter(function (field) {
    return !Object.prototype.hasOwnProperty.call(message, field)
  })
}

export class ExportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ExportError'
    this.code = code
  }
}

function fail(code, message) {
  throw new ExportError(code, message)
}

/** One JSON object per line, LF terminated, no BOM, no pretty printing. */
export function toJsonl(messages) {
  const list = Array.isArray(messages) ? messages : []
  const lines = list.map(function (message, index) {
    if (!message || typeof message !== 'object') fail('bad-message', '第 ' + (index + 1) + ' 条不是对象')
    const missing = missingFields(message)
    if (missing.length > 0) {
      fail('missing-field', '第 ' + (index + 1) + ' 条缺少字段：' + missing.join('、'))
    }
    if (message.role !== 'question' && message.role !== 'answer') {
      fail('bad-role', '第 ' + (index + 1) + ' 条的 role 只能是 question 或 answer，收到 ' + String(message.role))
    }
    return JSON.stringify(message)
  })
  return lines.length === 0 ? '' : lines.join('\n') + '\n'
}

/** Parse JSONL, reporting the offending line number instead of throwing raw. */
export function parseJsonl(text) {
  if (typeof text !== 'string') fail('bad-input', 'parseJsonl 需要字符串')
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const out = []
  const rows = body.split(/\r?\n/)
  rows.forEach(function (row, index) {
    if (row.trim().length === 0) return
    try {
      const parsed = JSON.parse(row)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('bad-line', '第 ' + (index + 1) + ' 行不是 JSON 对象')
      }
      out.push(parsed)
    } catch (error) {
      if (error instanceof ExportError) throw error
      fail('bad-json', '第 ' + (index + 1) + ' 行不是合法 JSON：' + String((error && error.message) || error))
    }
  })
  return out
}

/**
 * Rebuild the conversation from parsed lines: which question opened each round,
 * who answered it, in what order, and with which model config. Throws when the
 * record is internally inconsistent instead of quietly producing a short game.
 */
export function replay(messages) {
  const lines = Array.isArray(messages) ? messages : []
  if (lines.length === 0) fail('empty-round', '这份对局记录是空的')
  const rounds = []
  const seats = new Map()
  const questions = new Map()
  let identity = null
  let lastRound = 0

  lines.forEach(function (message, index) {
    const missing = missingFields(message)
    if (missing.length > 0) fail('missing-field', '第 ' + (index + 1) + ' 条缺少字段：' + missing.join('、'))
    if (message.seq !== index + 1) {
      fail('bad-seq', '第 ' + (index + 1) + ' 条的 seq 是 ' + String(message.seq) + '，应为 ' + (index + 1))
    }
    const stamp = {
      seed: message.table && message.table.seed,
      seatCount: message.table && message.table.seatCount,
      humanSeats: message.table && message.table.humanSeats,
      aiSeats: message.table && message.table.aiSeats,
    }
    if (identity === null) identity = stamp
    else if (identity.seed !== stamp.seed || identity.seatCount !== stamp.seatCount) {
      fail('mixed-table', '第 ' + (index + 1) + ' 条来自另一张桌（seed/seatCount 不一致）')
    }
    if (message.round < lastRound) {
      fail('bad-round', '第 ' + (index + 1) + ' 条的轮次倒退：' + message.round + ' < ' + lastRound)
    }
    lastRound = message.round
    if (seats.has(message.seat)) {
      const known = seats.get(message.seat)
      if (known.seatKind !== message.seatKind && known.seatKind !== null && message.seatKind !== null) {
        fail('seat-kind-conflict', '座位 ' + message.seat + ' 的身份在记录里前后不一致')
      }
    } else {
      seats.set(message.seat, { id: message.seat, seatKind: message.seatKind, label: message.seatLabel, answers: 0 })
    }
    if (message.seatKind === 'ai' && message.role === 'answer') seats.get(message.seat).answers += 1

    if (message.role === 'question') {
      questions.set(message.id, message)
      rounds.push({ round: message.round, question: message, answers: [] })
      return
    }
    const asked = questions.get(message.replyTo)
    if (!asked) fail('dangling-reply', '第 ' + (index + 1) + ' 条回答找不到对应的问题：' + String(message.replyTo))
    const bucket = rounds.find(function (item) { return item.question.id === asked.id })
    if (bucket.answers.some(function (item) { return item.seat === message.seat })) {
      fail('duplicate-answer', '座位 ' + message.seat + ' 对同一问题回答了两次')
    }
    bucket.answers.push(message)
  })

  return {
    table: identity,
    rounds: rounds,
    seats: Array.from(seats.values()).sort(function (a, b) { return a.id - b.id }),
    transcript: lines.slice(),
    messageCount: lines.length,
    answerCount: lines.filter(function (message) { return message.role === 'answer' }).length,
  }
}

export function serializeVerdicts(record) {
  if (!record || typeof record !== 'object') fail('bad-input', 'serializeVerdicts 需要判决记录对象')
  if (record.kind !== VERDICT_KIND) fail('not-verdicts', '这不是一份判决记录（kind=' + String(record.kind) + '）')
  return JSON.stringify(record, null, 2) + '\n'
}

export function parseVerdicts(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text))
  } catch (error) {
    fail('bad-json', '判决记录不是合法 JSON：' + String((error && error.message) || error))
  }
  if (!parsed || typeof parsed !== 'object' || parsed.kind !== VERDICT_KIND) {
    fail('not-verdicts', '这不是一份判决记录（kind=' + String(parsed && parsed.kind) + '）')
  }
  return parsed
}

/**
 * Check a JSONL transcript against its verdict record: same table, truthful
 * seat kinds, and a score that adds up. Returns problems instead of throwing,
 * so a CLI can report all of them at once.
 */
export function verifyRound(jsonlText, verdictRecord) {
  const problems = []
  const push = function (code, detail) { problems.push({ code: code, detail: detail }) }

  let lines
  try {
    lines = Array.isArray(jsonlText) ? jsonlText : parseJsonl(jsonlText)
  } catch (error) {
    return { ok: false, problems: [{ code: 'unreadable-jsonl', detail: String((error && error.message) || error) }] }
  }
  let replayed
  try {
    replayed = replay(lines)
  } catch (error) {
    return { ok: false, problems: [{ code: 'unreplayable', detail: String((error && error.message) || error) }] }
  }

  const record = verdictRecord && typeof verdictRecord === 'object' ? verdictRecord : {}
  const truth = record.truth && typeof record.truth === 'object' ? record.truth : {}

  if (replayed.table.seed !== record.seed) {
    push('seed-mismatch', 'JSONL 的 seed 是 ' + String(replayed.table.seed) + '，判决记录是 ' + String(record.seed))
  }

  for (const line of lines) {
    const expected = truth[String(line.seat)]
    if (expected === undefined) push('unknown-seat', '座位 ' + line.seat + ' 不在这份判决记录的真值表里')
    else if (line.seatKind !== null && line.seatKind !== expected) {
      push('kind-mismatch', '座位 ' + line.seat + ' 在 JSONL 里是 ' + line.seatKind + '，真值表说是 ' + expected)
    }
  }

  const verdicts = Array.isArray(record.verdicts) ? record.verdicts : []
  let correct = 0
  for (const entry of verdicts) {
    const expected = truth[String(entry.seat)]
    if (expected === undefined) {
      push('verdict-unknown-seat', '判定里的座位 ' + entry.seat + ' 不在真值表里')
      continue
    }
    if (entry.truth !== expected) push('verdict-truth-mismatch', '座位 ' + entry.seat + ' 判定记录的 truth 与真值表不符')
    const shouldBeCorrect = entry.verdict === expected
    if (entry.correct !== shouldBeCorrect) {
      push('verdict-correctness', '座位 ' + entry.seat + ' 的 correct 应为 ' + shouldBeCorrect + '，记录里是 ' + String(entry.correct))
    }
    if (shouldBeCorrect) correct += 1
  }

  const judgedSeats = new Set(verdicts.map(function (entry) { return entry.seat }))
  for (const key of Object.keys(truth)) {
    const seatId = Number(key)
    if (truth[key] === undefined) continue
    const seatRow = Array.isArray(record.seats) ? record.seats.find(function (row) { return row.seat === seatId }) : null
    if (!seatRow) {
      push('missing-seat-row', '真值表里的座位 ' + key + ' 在判决记录里没有对应的行')
      continue
    }
    if (seatRow.kind !== truth[key]) push('seat-row-truth', '座位 ' + key + ' 的行内 kind 与真值表不符')
    if (seatRow.judged !== judgedSeats.has(seatId)) push('seat-row-judged', '座位 ' + key + ' 的 judged 标记与判定列表不符')
  }

  const score = record.score && typeof record.score === 'object' ? record.score : {}
  if (Number.isFinite(Number(score.correct)) && Number(score.correct) !== correct) {
    push('score-correct', '判决记录的 correct 是 ' + score.correct + '，重算为 ' + correct)
  }
  if (Number.isFinite(Number(score.judged)) && Number(score.judged) !== verdicts.length) {
    push('score-judged', '判决记录的 judged 是 ' + score.judged + '，判定条数是 ' + verdicts.length)
  }
  if (Number.isFinite(Number(record.rounds))) {
    const maxRound = lines.reduce(function (acc, line) { return Math.max(acc, line.round) }, 0)
    if (Number(record.rounds) < maxRound) {
      push('rounds-too-small', '判决记录说只打了 ' + record.rounds + ' 轮，JSONL 里有第 ' + maxRound + ' 轮')
    }
  }

  return { ok: problems.length === 0, problems: problems, replayed: replayed }
}
