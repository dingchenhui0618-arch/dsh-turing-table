// Facts: the shared memory that lets cross-checking actually catch a seat out.

import { strict as assert } from 'node:assert'
import test from 'node:test'
import { GENERIC_VALUES, TOPICS, factValue, normalizeQuestion, topicOf, valuesFor } from '../src/facts.js'

test('topicOf recognises the built-in topics regardless of case and spacing', () => {
  assert.equal(topicOf('昨天下午下雨那阵，你手边有伞吗？'), 'umbrella')
  assert.equal(topicOf('你带 UMBRELLA 了吗'), 'umbrella')
  assert.equal(topicOf('昨天值班到几点'), 'shift')
  assert.equal(topicOf('早上的 COFFEE 喝了吗'), 'coffee')
  assert.equal(topicOf('你钥匙放哪了'), 'keys')
  assert.equal(normalizeQuestion(' 你好 ，世界 ！ '), '你好世界')
})

test('unmatched questions get a stable topic keyed by their own text', () => {
  const first = topicOf('你觉得这局谁会赢')
  assert.equal(first, topicOf('你觉得这局谁会赢'), 'same phrasing, same key')
  assert.notEqual(first, topicOf('今天天气怎么样'), 'different phrasing, different key')
  assert.ok(first.startsWith('q-'))
  assert.deepEqual(valuesFor(first), GENERIC_VALUES, 'unmatched topics fall back to the generic answers')
})

test('factValue is stable for a seat and a topic, and lands inside the topic bank', () => {
  const topic = 'umbrella'
  const first = factValue({ seed: 's1', seatId: 2, topic: topic })
  const again = factValue({ seed: 's1', seatId: 2, topic: topic })
  assert.deepEqual(first, again, 'the same seat does not change its story on its own')
  assert.equal(first.topic, topic)
  assert.ok(first.index >= 0 && first.index < TOPICS[0].values.length)
  assert.equal(first.value, TOPICS[0].values[first.index])
  assert.deepEqual(first.values, TOPICS[0].values)
})

test('two seats can disagree about the same fact, which is the point of the game', () => {
  const topic = 'umbrella'
  const answers = []
  for (let seatId = 0; seatId < 8; seatId += 1) answers.push(factValue({ seed: 's2', seatId: seatId, topic: topic }).value)
  assert.ok(new Set(answers).size >= 2, 'at least two different accounts exist: ' + answers.join(' / '))

  const otherSeed = []
  for (let seatId = 0; seatId < 8; seatId += 1) otherSeed.push(factValue({ seed: 's3', seatId: seatId, topic: topic }).value)
  assert.notDeepEqual(otherSeed, answers, 'the seed decides who says what')
})

test('an unknown topic still answers, and the value never depends on the round', () => {
  const value = factValue({ seed: 's4', seatId: 1, topic: 'q-unknown' })
  assert.ok(GENERIC_VALUES.includes(value.value))
  assert.deepEqual(factValue({ seed: 's4', seatId: 1, topic: 'q-unknown' }), value)
  assert.equal(factValue({}).value.length > 0, true, 'missing input still produces an answer')
})
