// Seat personas: disguise presets, per-seat resolution, and dealing the model
// pool onto the AI seats.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  DEFAULT_MODELS,
  DISGUISE_PRESETS,
  PRESSURE_STRATEGIES,
  VERBOSITY_LIMITS,
  assignModelConfigs,
  normalizeModelConfig,
  presetDisguise,
  resolveDisguise,
} from '../src/personas.js'
import { createRng } from '../src/rng.js'

test('the three disguise presets get progressively harder to spot', () => {
  const low = presetDisguise('low')
  const medium = presetDisguise('medium')
  const high = presetDisguise('high')
  assert.equal(low.verbosity, 'terse')
  assert.equal(medium.verbosity, 'normal')
  assert.equal(high.verbosity, 'chatty')
  assert.equal(low.colloquial, false)
  assert.equal(high.colloquial, true)
  assert.equal(low.proactive, false)
  assert.equal(high.proactive, true)
  assert.ok(high.proactiveRate > medium.proactiveRate)
  assert.ok(VERBOSITY_LIMITS.terse.maxChars < VERBOSITY_LIMITS.normal.maxChars)
  assert.ok(VERBOSITY_LIMITS.normal.maxChars < VERBOSITY_LIMITS.chatty.maxChars)
  assert.equal(presetDisguise('nonsense').level, 'medium', 'unknown level falls back to the default')
  assert.notEqual(DISGUISE_PRESETS.high, undefined)
})

test('resolveDisguise lets explicit fields win and picks a pressure strategy per seat', () => {
  const explicit = resolveDisguise({ level: 'high', verbosity: 'terse', colloquial: false, pressure: 'concede' }, createRng('x'))
  assert.equal(explicit.level, 'high')
  assert.equal(explicit.verbosity, 'terse')
  assert.equal(explicit.colloquial, false)
  assert.equal(explicit.pressure, 'concede')

  const a = resolveDisguise('high', createRng('seat-1'))
  const b = resolveDisguise('high', createRng('seat-1'))
  assert.deepEqual(a, b, 'same seat stream, same resolution')

  const picks = new Set()
  for (let i = 0; i < 24; i += 1) picks.add(resolveDisguise('high', createRng('seat-' + i)).pressure)
  assert.ok(picks.size >= 2, 'high seats do not all share one pressure strategy: ' + Array.from(picks).join(','))
  for (const value of picks) assert.ok(PRESSURE_STRATEGIES.includes(value), 'unknown strategy ' + value)

  const fallback = resolveDisguise(undefined, createRng('none'))
  assert.equal(fallback.level, 'medium')
  assert.ok(PRESSURE_STRATEGIES.includes(fallback.pressure))
})

test('normalizeModelConfig fills defaults without inventing a route', () => {
  const bare = normalizeModelConfig({}, 0)
  assert.equal(bare.id, 'model-1')
  assert.equal(bare.provider, null, 'a null route means "use the session model"')
  assert.equal(bare.model, null)
  assert.equal(bare.temperature, 0.7)
  assert.equal(bare.voice, 'plain')
  assert.equal(bare.disguise, null)

  const given = normalizeModelConfig({ id: 'x', provider: 'p', model: 'm', temperature: 0, voice: 'warm', system: 'hi' }, 3)
  assert.equal(given.id, 'x')
  assert.equal(given.provider, 'p')
  assert.equal(given.model, 'm')
  assert.equal(given.temperature, 0, 'temperature 0 is kept, not treated as missing')
  assert.equal(given.voice, 'warm')
  assert.equal(given.system, 'hi')
  assert.equal(normalizeModelConfig({ voice: 'shouty' }, 0).voice, 'plain')
})

test('the built-in persona pool is usable as shipped', () => {
  assert.ok(DEFAULT_MODELS.length >= 5, 'used to fill a default six-seat table')
  const ids = DEFAULT_MODELS.map(function (model) { return model.id })
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  for (const model of DEFAULT_MODELS) {
    assert.ok(model.system.length > 0, model.id + ' carries a personality')
    assert.ok(model.disguise !== undefined, model.id + ' carries a disguise')
  }
})

test('assignModelConfigs deals distinct configs when the pool is big enough', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f'].map(function (id) { return { id: id } })
  const seats = [1, 2, 3, 4, 5]
  const dealt = assignModelConfigs(pool, seats, createRng('deal'))
  assert.deepEqual(Object.keys(dealt).sort(), seats.map(String).sort(), 'every AI seat got a config')
  const used = seats.map(function (id) { return dealt[id].id })
  assert.equal(new Set(used).size, seats.length, 'no two AI seats share a configuration: ' + used.join(','))

  const again = assignModelConfigs(pool, seats, createRng('deal'))
  assert.deepEqual(again, dealt, 'deterministic for a seed')

  const other = assignModelConfigs(pool, seats, createRng('deal-2'))
  assert.notDeepEqual(seats.map(function (id) { return other[id].id }), used, 'a different seed deals differently')
})

test('assignModelConfigs cycles a short pool instead of dropping seats', () => {
  const pool = [{ id: 'only-a' }, { id: 'only-b' }]
  const seats = [0, 1, 2, 3, 4]
  const dealt = assignModelConfigs(pool, seats, createRng('cycle'))
  for (const id of seats) assert.ok(dealt[id], 'seat ' + id + ' has a config')
  const used = new Set(seats.map(function (seatId) { return dealt[seatId].id }))
  assert.equal(used.size, 2, 'both pool entries are used')
  assert.throws(function () { assignModelConfigs([], seats, createRng('x')) }, RangeError)
})
