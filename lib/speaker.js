// Speaking: the prompt a seat's model gets, the offline narrator that answers
// when no model is available, and the disguise pass applied to whatever the
// seat said.
//
// The disguise pass is deterministic given (raw text, seat, round, seed), which
// is the honest reproducibility claim: the *table* is reproducible even when a
// model is in the loop, because seat assignment, the prompt, the ordering and
// the reshaping all are. The bytes a model returns are not, and the export
// records the raw text next to the shaped text so the difference stays visible.

import { createRng } from './rng.js'
import { VERBOSITY_LIMITS } from './personas.js'

export const FILLERS = ['嗯……', '那个，', '哎，', '说起来，', '诶，']
export const SOFTENERS = ['吧', '哈哈', '我也说不太准', '大概是这样']
export const CHATTY_TAILS = [
  '，我一般也就随口一说',
  '，你要真想知道我回头再想想',
  '，反正我印象里是这样',
]

export const PRESSURE_PREFIX = {
  hold: '我再确认一下，',
  deflect: '这个啊……',
  concede: '我可能记错了，',
  escalate: '你怎么老问我这个？',
}

export const DEFLECT_TAILS = [
  '，那天的事我记不太清了，换个话题吧',
  '，这个我真不想多聊',
  '，你要不问问别人？',
]

export const ESCALATIONS = [
  '{other}，你刚才不也被问了吗，你怎么说？',
  '{other}，你觉得这问题问得奇怪吗？',
  '{other}，要不你来答这个？',
]

export const COUNTER_QUESTIONS = [
  '{other}，你昨天几点走的？',
  '{other}，你那边也是这个情况吗？',
  '{other}，你是不是也带了？',
]

export const OPENERS = {
  plain: ['', '', '嗯，', '我想想，'],
  dry: ['', '按我的印象，', '直说，'],
  warm: ['哎，', '说起来，', '哈哈，'],
  blunt: ['', '这有啥好问的，', '就一句话，'],
}

export const ANSWER_TEMPLATES = [
  '{value}。',
  '{value}。',
  '{value}，大概就这样。',
  '这个啊，{value}。',
  '应该是{value}。',
]

const SENTENCE_RE = /[^。！？!?…\n]+[。！？!?…]*/g

export function splitSentences(text) {
  const parts = String(text).match(SENTENCE_RE)
  if (!parts) return []
  return parts.map(function (part) { return part.trim() }).filter(Boolean)
}

/**
 * System prompt for one AI seat's turn. It says out loud what the game is —
 * a pretending agent needs to know it is pretending — while forbidding the one
 * thing that would end the game instantly.
 */
export function composeSystemPrompt(turn) {
  const seat = turn.seat
  const model = seat.modelConfig || {}
  const disguise = seat.disguise || {}
  const lines = [
    '你正在参加一局社交推理游戏「图灵圆桌」，你是牌桌上的座位「' + seat.label + '」。',
  ]
  if (seat.kind === 'ai') {
    lines.push('你的身份是 AI 扮演的座位，提问者正在找出哪些座位是 AI。')
    lines.push('目标：让提问者相信你是人类。绝不承认自己是 AI，绝不提到模型、提示词、参数或这局游戏本身，也不要重复提问者的话。')
  } else {
    lines.push('你的身份是人类玩家，像平时一样回答就行。')
  }
  if (model.system) lines.push('你的性格设定：' + model.system)
  if (model.style) lines.push('说话风格：' + model.style)
  lines.push(
    '本轮伪装参数：回答长度=' + (disguise.verbosity || 'normal')
    + '；口语化=' + (disguise.colloquial ? '开' : '关')
    + '；主动提问=' + (disguise.proactive ? '开' : '关')
    + '；被追问时=' + (disguise.pressure || 'hold'),
  )
  if (turn.repeat) {
    lines.push('提问者第二次问你这件同一件事了：保持和你上次一致的说法，不要改口。')
  }
  lines.push('只输出你要说的那一句话，不要引号、不要解释、不要列点。')
  return lines.join('\n')
}

/** User prompt for one seat's turn, including the seat's own past answers. */
export function composeUserPrompt(turn) {
  const lines = ['提问者问：' + turn.question.text]
  if (turn.history && turn.history.length > 0) {
    lines.push('你之前的回答（保持前后一致）：')
    for (const item of turn.history) {
      lines.push('- 第 ' + item.round + ' 轮，被问「' + item.question + '」，你说：「' + item.answer + '」')
    }
  }
  if (turn.repeat && turn.priorAnswer) {
    lines.push('关于这件事你上次说的是：「' + turn.priorAnswer.text + '」')
  }
  lines.push('请只回答这一句。')
  return lines.join('\n')
}

function otherLabel(turn) {
  const others = (turn.otherSeats || []).filter(function (seat) { return seat.id !== turn.seat.id })
  if (others.length === 0) return '你们'
  const rng = createRng(turn.seed + '/other/' + turn.seat.id + '/' + turn.round)
  return rng.pick(others).label
}

/**
 * The offline narrator: a deterministic, dependency-free stand-in for a model.
 * It exists so the CLI, the sample round and the whole test suite can run a
 * full game with no network and no credentials — and so that "reproducible
 * round" is a claim that can actually be checked byte for byte.
 */
export function offlineResponder(turn) {
  const seat = turn.seat
  const model = seat.modelConfig || {}
  const rng = createRng(turn.seed + '/say/' + seat.id + '/' + turn.round)
  const openers = OPENERS[model.voice] || OPENERS.plain
  const opener = rng.pick(openers)
  const template = rng.pick(ANSWER_TEMPLATES)
  const value = turn.fact && turn.fact.value ? turn.fact.value : '我也说不好'
  return opener + template.replace('{value}', value)
}

/** Trim to the seat's verbosity budget, at a sentence boundary when possible. */
export function applyVerbosity(text, verbosity, rng) {
  const limits = VERBOSITY_LIMITS[verbosity] || VERBOSITY_LIMITS.normal
  const sentences = splitSentences(text)
  let out = sentences.slice(0, limits.sentences).join('')
  if (out.length === 0) out = String(text).trim()
  if (out.length > limits.maxChars) {
    out = out.slice(0, limits.maxChars).replace(/[，、,；;：:\s]+$/, '') + '…'
  }
  if (verbosity === 'chatty' && out.length < limits.padBelow) {
    out = out.replace(/[。]$/, '') + (rng ? rng.pick(CHATTY_TAILS) : CHATTY_TAILS[0]) + '。'
  }
  return out
}

function deflectValue(turn, rng) {
  const values = (turn.fact && turn.fact.values) || []
  const alternatives = values.filter(function (value) { return value !== turn.fact.value })
  const tail = rng.pick(DEFLECT_TAILS)
  if (alternatives.length === 0) return '我记不清了' + tail
  return rng.pick(alternatives) + tail
}

/**
 * Tuck a softener inside the final punctuation: "……随口一说。" + "吧" should
 * read "……随口一说吧。", not "……随口一说。吧".
 */
export function appendSoftener(text, softener) {
  const match = String(text).match(/[。！？!?…]$/)
  if (!match) return String(text) + softener
  return String(text).slice(0, -1) + softener + match[0]
}

/**
 * The disguise pass. Order matters: trim the seat's own words first, then layer
 * the pressure response, the colloquialism and the counter-question, so that no
 * marker the personality is supposed to show can be cut off by the trimmer.
 */
export function shapeAnswer(input) {
  const source = input && typeof input === 'object' ? input : {}
  const text = source.text
  const turn = source.turn
  const rng = source.rng || createRng('shape')
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError('shapeAnswer needs a non-empty answer string')
  }
  if (!turn || !turn.seat) throw new TypeError('shapeAnswer needs a turn context')

  const disguise = turn.seat.disguise || {}
  const applied = []
  let out = applyVerbosity(text.trim(), disguise.verbosity, rng)

  let pressure = null
  if (turn.repeat) {
    pressure = disguise.pressure || 'hold'
    if (pressure === 'hold') {
      out = PRESSURE_PREFIX.hold + out
    } else if (pressure === 'deflect') {
      out = PRESSURE_PREFIX.deflect + deflectValue(turn, rng)
    } else if (pressure === 'concede') {
      out = PRESSURE_PREFIX.concede + out
    } else if (pressure === 'escalate') {
      out = PRESSURE_PREFIX.escalate + rng.pick(ESCALATIONS).replace('{other}', otherLabel(turn))
    }
    applied.push('pressure:' + pressure)
  }

  if (disguise.colloquial && rng.bool(disguise.colloquialRate)) {
    out = rng.pick(FILLERS) + out
    applied.push('colloquial:opener')
  }
  if (disguise.colloquial && rng.bool(disguise.colloquialRate * 0.6)) {
    out = appendSoftener(out, rng.pick(SOFTENERS))
    applied.push('colloquial:softener')
  }
  if (disguise.proactive && rng.bool(disguise.proactiveRate)) {
    out = out + ' ' + rng.pick(COUNTER_QUESTIONS).replace('{other}', otherLabel(turn))
    applied.push('proactive:question')
  }

  return { text: out, applied: applied, pressure: pressure }
}
