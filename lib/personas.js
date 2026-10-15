// Seat personas: model configs and the disguise knobs that make an AI seat
// try to pass as a person.
//
// Nothing here is hard-coded into the game engine — the table takes a list of
// model configs from plugin config (or the CLI spec) and binds one to each AI
// seat. DEFAULT_MODELS is only the fallback when a caller supplies none.

/** The three named disguise presets, low being the easiest to spot. */
export const DISGUISE_PRESETS = {
  low: {
    level: 'low',
    verbosity: 'terse',
    colloquial: false,
    proactive: false,
    colloquialRate: 0,
    proactiveRate: 0,
    pressurePool: ['concede'],
  },
  medium: {
    level: 'medium',
    verbosity: 'normal',
    colloquial: true,
    proactive: false,
    colloquialRate: 0.5,
    proactiveRate: 0,
    pressurePool: ['hold', 'concede'],
  },
  high: {
    level: 'high',
    verbosity: 'chatty',
    colloquial: true,
    proactive: true,
    colloquialRate: 0.7,
    proactiveRate: 0.45,
    pressurePool: ['hold', 'deflect', 'escalate'],
  },
}

export const DISGUISE_LEVELS = ['low', 'medium', 'high']

/** How the answer is trimmed after the seat answers. */
export const VERBOSITY_LIMITS = {
  terse: { sentences: 1, maxChars: 40, padBelow: 24 },
  normal: { sentences: 2, maxChars: 120, padBelow: 40 },
  chatty: { sentences: 4, maxChars: 260, padBelow: 64 },
}

/** What a seat does when the same fact is put to it a second time. */
export const PRESSURE_STRATEGIES = ['hold', 'deflect', 'concede', 'escalate']

export const DEFAULT_DISGUISE_LEVEL = 'medium'

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** A preset by name; unknown names fall back to the default level. */
export function presetDisguise(level) {
  const key = DISGUISE_LEVELS.includes(level) ? level : DEFAULT_DISGUISE_LEVEL
  return Object.assign({}, DISGUISE_PRESETS[key])
}

/**
 * Resolve one seat's disguise: preset first, explicit fields second, and any
 * still-missing pressure strategy picked from the preset's pool with the
 * seat's own rng (so two "high" seats do not behave identically).
 */
export function resolveDisguise(input, rng) {
  const source = typeof input === 'string' ? { level: input } : (input && typeof input === 'object' ? input : {})
  const preset = presetDisguise(source.level)
  const pool = Array.isArray(source.pressurePool) && source.pressurePool.length > 0
    ? source.pressurePool.filter((item) => PRESSURE_STRATEGIES.includes(item))
    : preset.pressurePool
  const usablePool = pool.length > 0 ? pool : ['hold']
  const pressure = PRESSURE_STRATEGIES.includes(source.pressure) ? source.pressure : undefined

  return {
    level: DISGUISE_LEVELS.includes(source.level) ? source.level : preset.level,
    verbosity: Object.prototype.hasOwnProperty.call(VERBOSITY_LIMITS, source.verbosity) ? source.verbosity : preset.verbosity,
    colloquial: typeof source.colloquial === 'boolean' ? source.colloquial : preset.colloquial,
    proactive: typeof source.proactive === 'boolean' ? source.proactive : preset.proactive,
    colloquialRate: typeof source.colloquialRate === 'number' ? source.colloquialRate : preset.colloquialRate,
    proactiveRate: typeof source.proactiveRate === 'number' ? source.proactiveRate : preset.proactiveRate,
    pressure: pressure || (rng && typeof rng.pick === 'function' ? rng.pick(usablePool) : usablePool[0]),
  }
}

/** One entry of the seat model pool, normalised. */
export function normalizeModelConfig(input, index) {
  const source = input && typeof input === 'object' ? input : {}
  const at = Number.isFinite(Number(index)) ? Number(index) : 0
  const provider = typeof source.provider === 'string' && source.provider.length > 0 ? source.provider : null
  const model = typeof source.model === 'string' && source.model.length > 0 ? source.model : null
  const temperature = Number.isFinite(Number(source.temperature)) ? Number(source.temperature) : 0.7
  return {
    id: typeof source.id === 'string' && source.id.length > 0 ? source.id : 'model-' + (at + 1),
    provider: provider,
    model: model,
    temperature: temperature,
    maxTokens: Number.isFinite(Number(source.maxTokens)) ? Math.floor(Number(source.maxTokens)) : 400,
    style: typeof source.style === 'string' ? source.style : '自然、简短',
    voice: ['dry', 'warm', 'blunt'].includes(source.voice) ? source.voice : 'plain',
    system: typeof source.system === 'string' ? source.system : '',
    // null rather than undefined, so a spec round-trips through JSON unchanged.
    disguise: source.disguise === undefined ? null : source.disguise,
  }
}

/**
 * Six ready-made personas. `provider`/`model` are deliberately null: a null
 * route means "use the session's current model", so the plugin works before
 * anyone configures per-seat routing, and configuring it is what makes the
 * seats genuinely different models.
 */
export const DEFAULT_MODELS = [
  {
    id: 'archivist',
    provider: null,
    model: null,
    temperature: 0.3,
    voice: 'dry',
    style: '书面、克制，先给结论再补一句',
    system: '你做事有条理，回答问题前习惯先想清楚。',
    disguise: { level: 'low' },
  },
  {
    id: 'barfly',
    provider: null,
    model: null,
    temperature: 0.9,
    voice: 'warm',
    style: '话多、爱打岔、口语化',
    system: '你性格外向，爱跟人闲聊，常常顺口提一句自己的事。',
    disguise: { level: 'high' },
  },
  {
    id: 'hedger',
    provider: null,
    model: null,
    temperature: 0.7,
    voice: 'plain',
    style: '含糊，喜欢把话说圆',
    system: '你不喜欢把话说死，被逼问时会绕开。',
    disguise: { level: 'medium', pressure: 'deflect' },
  },
  {
    id: 'mimic',
    provider: null,
    model: null,
    temperature: 0.6,
    voice: 'plain',
    style: '普通、稳定，尽量像随口回答',
    system: '你模仿普通人的说话方式，前后说法保持一致。',
    disguise: { level: 'high', pressure: 'hold' },
  },
  {
    id: 'contrarian',
    provider: null,
    model: null,
    temperature: 0.8,
    voice: 'blunt',
    style: '直接，偶尔反问',
    system: '你说话直，被反复追问时会反过来说对方。',
    disguise: { level: 'medium', pressure: 'escalate' },
  },
  {
    id: 'quiet',
    provider: null,
    model: null,
    temperature: 0.5,
    voice: 'dry',
    style: '短句',
    system: '你不太爱说话，别人问什么就答什么。',
    disguise: { level: 'low', pressure: 'concede' },
  },
]

/**
 * Deal the pool onto the AI seats. The pool is shuffled once, then dealt in
 * order and cycled if there are more seats than configs, so a pool at least as
 * large as the AI seat count gives every seat a different configuration.
 */
export function assignModelConfigs(models, seatIds, rng) {
  const pool = Array.isArray(models) ? Array.from(models) : []
  if (pool.length === 0) throw new RangeError('assignModelConfigs needs at least one model config')
  const seats = Array.isArray(seatIds) ? Array.from(seatIds) : []
  const shuffled = rng.shuffle(pool)
  const out = {}
  seats.forEach(function (seatId, index) {
    out[seatId] = shuffled[index % shuffled.length]
  })
  return out
}
