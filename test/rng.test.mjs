// The seeded RNG is the foundation of every reproducibility claim in this
// plugin, so it gets pinned first: same seed -> same stream, different seeds ->
// different streams, and named substreams that do not interfere.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createRng, hashSeed } from '../src/rng.js'

function draw(rng, count) {
  const out = []
  for (let i = 0; i < count; i += 1) out.push(rng.next())
  return out
}

test('the same seed always produces the same sequence', () => {
  const left = draw(createRng('seed-a'), 64)
  const right = draw(createRng('seed-a'), 64)
  assert.deepEqual(left, right)
  assert.ok(left.every(function (value) { return value >= 0 && value < 1 }), 'stream stays in [0,1)')
})

test('different seeds produce different sequences', () => {
  const left = draw(createRng('seed-a'), 32)
  const right = draw(createRng('seed-b'), 32)
  assert.notDeepEqual(left, right)
})

test('hashSeed is deterministic and stays inside uint32', () => {
  const value = hashSeed('turing-sample-0001')
  assert.equal(value, hashSeed('turing-sample-0001'))
  assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, 'uint32: ' + value)
  assert.notEqual(hashSeed('abc'), hashSeed('abd'), 'nearby strings do not collide here')
  assert.notEqual(hashSeed(''), hashSeed('a'))
})

test('int() and range() respect their bounds', () => {
  const rng = createRng('bounds')
  const seen = new Set()
  for (let i = 0; i < 2000; i += 1) {
    const value = rng.int(6)
    assert.ok(value >= 0 && value < 6, 'int(6) gave ' + value)
    seen.add(value)
  }
  assert.equal(seen.size, 6, 'every value in [0,6) shows up')
  for (let i = 0; i < 200; i += 1) {
    const value = rng.range(3, 5)
    assert.ok(value >= 3 && value <= 5, 'range(3,5) gave ' + value)
  }
  assert.throws(function () { rng.int(0) }, RangeError)
  assert.throws(function () { rng.range(5, 3) }, RangeError)
})

test('bool() honours its probability instead of drifting', () => {
  const rng = createRng('bool')
  assert.equal(rng.bool(0), false)
  assert.equal(rng.bool(1), true)
  let hits = 0
  const rounds = 4000
  for (let i = 0; i < rounds; i += 1) if (rng.bool(0.3)) hits += 1
  const rate = hits / rounds
  assert.ok(rate > 0.25 && rate < 0.35, 'p=0.3 landed at ' + rate)
})

test('shuffle is a deterministic permutation that differs across seeds', () => {
  const input = [0, 1, 2, 3, 4, 5, 6, 7]
  const first = createRng('shuffle-a').shuffle(input)
  const again = createRng('shuffle-a').shuffle(input)
  assert.deepEqual(first, again, 'same seed, same permutation')
  assert.deepEqual(first.slice().sort(function (a, b) { return a - b }), input, 'still a permutation')
  assert.deepEqual(input, [0, 1, 2, 3, 4, 5, 6, 7], 'the input array is not mutated')

  const others = ['shuffle-b', 'shuffle-c', 'shuffle-d', 'shuffle-e'].map(function (seed) {
    return createRng(seed).shuffle(input).join('')
  })
  assert.ok(others.some(function (order) { return order !== first.join('') }), 'at least one seed shuffles differently')
})

test('fork() gives a stable substream that the parent stream cannot disturb', () => {
  const early = createRng('parent').fork('seats')
  const late = createRng('parent')
  draw(late, 100)
  const later = late.fork('seats')
  assert.deepEqual(draw(early, 32), draw(later, 32))

  const parent = createRng('parent')
  assert.notDeepEqual(draw(parent.fork('a'), 16), draw(parent.fork('b'), 16))
})

test('pick() refuses an empty list instead of returning undefined', () => {
  const rng = createRng('pick')
  assert.throws(function () { rng.pick([]) }, RangeError)
  assert.equal(rng.pick(['only']), 'only')
  assert.ok(['a', 'b', 'c'].includes(rng.pick(['a', 'b', 'c'])))
})
