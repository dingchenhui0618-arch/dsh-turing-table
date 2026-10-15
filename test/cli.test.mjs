// The CLI and the shipped sample: the sample must be real engine output that
// anyone can regenerate, and the CLI must refuse to write junk.

import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseJsonl, parseVerdicts, verifyRound } from '../src/export.js'
import { SAMPLE_SPEC, generateSample } from '../src/sample.js'
import { run } from '../scripts/export.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const examples = join(root, 'examples')
const SAMPLE_JSONL = join(examples, 'sample-round.jsonl')
const SAMPLE_VERDICTS = join(examples, 'sample-verdicts.json')
const SAMPLE_SPEC_FILE = join(examples, 'sample-spec.json')

function makeIo() {
  const out = []
  const err = []
  return {
    out: out,
    err: err,
    log(message) { out.push(String(message)) },
    error(message) { err.push(String(message)) },
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'turing-cli-'))
}

test('the shipped sample exists and verifies against its own verdict record', () => {
  for (const file of [SAMPLE_JSONL, SAMPLE_VERDICTS, SAMPLE_SPEC_FILE]) {
    assert.ok(existsSync(file), file + ' is shipped')
    assert.ok(readFileSync(file, 'utf8').length > 200, file + ' is not a stub')
  }
  const lines = parseJsonl(readFileSync(SAMPLE_JSONL, 'utf8'))
  const record = parseVerdicts(readFileSync(SAMPLE_VERDICTS, 'utf8'))
  assert.ok(lines.length >= 10, 'the sample is a real conversation: ' + lines.length + ' lines')
  const check = verifyRound(readFileSync(SAMPLE_JSONL, 'utf8'), record)
  assert.equal(check.ok, true, JSON.stringify(check.problems))
})

test('regenerating the sample reproduces the committed bytes', async () => {
  const generated = await generateSample()
  assert.equal(generated.jsonl, readFileSync(SAMPLE_JSONL, 'utf8'), 'the transcript regenerates byte for byte')
  assert.equal(generated.verdicts, readFileSync(SAMPLE_VERDICTS, 'utf8'), 'so does the verdict record')

  const again = await generateSample()
  assert.equal(again.jsonl, generated.jsonl, 'and it is stable across runs in one process')
})

test('the committed spec file is the spec the code actually runs', () => {
  const onDisk = JSON.parse(readFileSync(SAMPLE_SPEC_FILE, 'utf8'))
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(SAMPLE_SPEC)))
  assert.equal(onDisk.seed, SAMPLE_SPEC.seed)
  assert.ok(Array.isArray(onDisk.script) && onDisk.script.length >= 6)
})

test('the sample is a real guessing game, not a foregone conclusion', () => {
  const record = parseVerdicts(readFileSync(SAMPLE_VERDICTS, 'utf8'))
  const others = record.seats.filter(function (seat) { return !seat.player })
  assert.ok(others.some(function (seat) { return seat.kind === 'ai' }), 'there are AI seats to find')
  assert.ok(others.some(function (seat) { return seat.kind === 'human' }), 'and a human seat to spare')
  assert.equal(record.score.judged, record.score.total, 'every seat was judged')
  assert.ok(record.score.correct < record.score.total, 'the sample player got one wrong, as humans do')
  assert.ok(record.rounds >= 2, 'the sample plays more than one round')
  assert.equal(record.endReason, 'all-judged')

  const lines = parseJsonl(readFileSync(SAMPLE_JSONL, 'utf8'))
  assert.ok(lines.some(function (line) { return line.pressure !== null }), 'a seat was pushed and changed its story')
  assert.ok(lines.some(function (line) { return line.seatKind === 'human' && line.role === 'answer' }), 'a human line is in there')
  assert.ok(lines.some(function (line) { return line.applied.length > 0 }), 'and the disguise actually did something')
  const models = new Set(lines.filter(function (line) { return line.modelConfig }).map(function (line) { return line.modelConfig.id }))
  assert.ok(models.size >= 3, 'more than one model config spoke: ' + Array.from(models).join(','))
})

test('the CLI turns a spec into both artifacts, byte for byte', async () => {
  const dir = tempDir()
  const io = makeIo()
  const result = await run([SAMPLE_SPEC_FILE, '--out', join(dir, 'round.jsonl'), '--verdicts', join(dir, 'round.verdicts.json')], io)
  assert.equal(result.exitCode, 0, io.err.join('\n'))
  assert.equal(result.ok, true)
  assert.equal(readFileSync(join(dir, 'round.jsonl'), 'utf8'), readFileSync(SAMPLE_JSONL, 'utf8'))
  assert.equal(readFileSync(join(dir, 'round.verdicts.json'), 'utf8'), readFileSync(SAMPLE_VERDICTS, 'utf8'))
  const report = io.out.join('\n')
  assert.match(report, /逐席位对话 JSONL/)
  assert.match(report, /判定记录/)
  assert.match(report, /准确率 80%/)
})

test('the CLI replays a transcript into the whole conversation', async () => {
  const io = makeIo()
  const result = await run(['--replay', SAMPLE_JSONL], io)
  assert.equal(result.exitCode, 0, io.err.join('\n'))
  const report = io.out.join('\n')
  assert.match(report, /seed=turing-sample-0001/)
  assert.match(report, /第 1 轮/)
  assert.match(report, /第 2 轮/)
  assert.match(report, /身份真值/)
  assert.match(report, /座位 6=human/)
  assert.equal(result.replay.rounds.length, 3)
  assert.equal(result.replay.messageCount, parseJsonl(readFileSync(SAMPLE_JSONL, 'utf8')).length)
})

test('the CLI verifies a transcript and fails loudly on a tampered record', async () => {
  const io = makeIo()
  const ok = await run(['--verify', SAMPLE_JSONL, '--verdicts', SAMPLE_VERDICTS], io)
  assert.equal(ok.exitCode, 0, io.err.join('\n'))
  assert.match(io.out.join('\n'), /校验通过/)

  const dir = tempDir()
  const record = parseVerdicts(readFileSync(SAMPLE_VERDICTS, 'utf8'))
  record.score.correct = 99
  const tampered = join(dir, 'tampered.json')
  writeFileSync(tampered, JSON.stringify(record, null, 2), 'utf8')
  const bad = makeIo()
  const failed = await run(['--verify', SAMPLE_JSONL, '--verdicts', tampered], bad)
  assert.equal(failed.exitCode, 1)
  assert.match(bad.err.join('\n'), /score-correct/)
  assert.equal(failed.ok, false)

  const missing = makeIo()
  assert.equal((await run(['--verify', SAMPLE_JSONL], missing)).exitCode, 2)
  assert.match(missing.err.join('\n'), /--verdicts/)
})

test('the CLI refuses argument mistakes and unreadable input', async () => {
  const missingInput = makeIo()
  assert.equal((await run([], missingInput)).exitCode, 2)
  assert.match(missingInput.err.join('\n'), /缺少输入文件/)

  const unknown = makeIo()
  assert.equal((await run(['--nope'], unknown)).exitCode, 2)
  assert.match(unknown.err.join('\n'), /不认识的参数/)

  const noValue = makeIo()
  assert.equal((await run(['--out'], noValue)).exitCode, 2)
  assert.match(noValue.err.join('\n'), /需要跟一个值/)

  const help = makeIo()
  assert.equal((await run(['--help'], help)).exitCode, 0)
  assert.match(help.out.join('\n'), /用法/)

  const absent = makeIo()
  assert.equal((await run([join(tempDir(), 'nope.json')], absent)).exitCode, 1)
  assert.match(absent.err.join('\n'), /出错了/)
})

test('the CLI writes nothing when its own pre-write check fails', async () => {
  const dir = tempDir()
  const input = join(dir, 'broken.json')
  const out = join(dir, 'never.jsonl')
  writeFileSync(input, JSON.stringify({
    kind: 'turing-table-round',
    spec: { seed: 'broken' },
    events: [{ role: 'question' }],
    verdicts: { kind: 'turing-table-verdicts', seed: 'broken', seats: [], verdicts: [], truth: {}, score: {} },
  }), 'utf8')
  const io = makeIo()
  const result = await run([input, '--out', out, '--verdicts', join(dir, 'never.verdicts.json')], io)
  assert.equal(result.exitCode, 1)
  assert.equal(existsSync(out), false, 'no half-written transcript is left behind')
  assert.match(io.err.join('\n'), /出错了/)
})
