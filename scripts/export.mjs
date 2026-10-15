#!/usr/bin/env node
// CLI for a round.
//
//   node scripts/export.mjs examples/sample-spec.json
//       run the spec through the real engine and write
//       examples/sample-round.jsonl + examples/sample-verdicts.json
//
//   node scripts/export.mjs <round-record.json> [--out a.jsonl] [--verdicts b.json]
//       convert a round record (the object table.exportRound() returns)
//
//   node scripts/export.mjs --replay examples/sample-round.jsonl
//       read the JSONL back and print the whole conversation, round by round
//
//   node scripts/export.mjs --verify examples/sample-round.jsonl \
//       --verdicts examples/sample-verdicts.json
//       cross-check the transcript against the verdict record
//
// Nothing here talks to a model: a spec is answered by the offline narrator, so
// a round exported from a spec is reproducible byte for byte.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseJsonl, parseVerdicts, replay, serializeVerdicts, toJsonl, verifyRound } from '../src/export.js'
import { runSpec } from '../src/table.js'

export const USAGE = [
  '用法：',
  '  node scripts/export.mjs <spec.json|round.json> [--out <round.jsonl>] [--verdicts <verdicts.json>] [--dir <目录>]',
  '  node scripts/export.mjs --replay <round.jsonl>',
  '  node scripts/export.mjs --verify <round.jsonl> --verdicts <verdicts.json>',
  '',
  '输入可以是：对局脚本（含 script 字段，会被真实跑一遍）或对局记录（含 events/verdicts 字段）。',
].join('\n')

const FLAGS_WITH_VALUE = ['--out', '--verdicts', '--dir', '--replay', '--verify']

export function parseArgs(argv) {
  const args = { input: null, out: null, verdicts: null, dir: null, replay: null, verify: null, quiet: false, help: false }
  const list = Array.isArray(argv) ? argv.slice() : []
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    if (item === '--help' || item === '-h') { args.help = true; continue }
    if (item === '--quiet') { args.quiet = true; continue }
    if (FLAGS_WITH_VALUE.includes(item)) {
      const value = list[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('参数 ' + item + ' 需要跟一个值')
      args[item.slice(2)] = value
      i += 1
      continue
    }
    if (item.startsWith('--')) throw new Error('不认识的参数：' + item)
    if (args.input !== null) throw new Error('只接受一个输入文件，多的读不懂：' + item)
    args.input = item
  }
  return args
}

function readText(file) {
  return readFileSync(file, 'utf8')
}

function sourceLabel(file) {
  return basename(file)
}

function replayCommand(args, io) {
  const lines = parseJsonl(readText(args.replay))
  const built = replay(lines)
  io.log('对局文件：' + sourceLabel(args.replay))
  io.log('牌桌：seed=' + String(built.table.seed) + '，座位 ' + built.table.seatCount
    + '（人类 ' + built.table.humanSeats + '，AI ' + built.table.aiSeats + '）')
  io.log('消息 ' + built.messageCount + ' 条，其中回答 ' + built.answerCount + ' 条，共 ' + built.rounds.length + ' 轮')
  for (const round of built.rounds) {
    io.log('')
    io.log('第 ' + round.round + ' 轮｜' + round.question.seatLabel + '（' + round.question.id + '）：' + round.question.text)
    for (const answer of round.answers) {
      const model = answer.modelConfig ? answer.modelConfig.id + '/' + String(answer.modelConfig.model) : '人类输入'
      io.log('  ' + answer.id + ' ' + answer.seatLabel + ' [' + answer.role + '｜' + answer.seatKind + '｜' + model
        + (answer.pressure ? '｜被追问:' + answer.pressure : '') + '] ' + answer.text)
    }
  }
  io.log('')
  io.log('身份真值：' + built.seats.map(function (seat) {
    return seat.label + '=' + String(seat.seatKind)
  }).join('，'))
  return { exitCode: 0, ok: true, replay: built }
}

function verifyCommand(args, io) {
  if (!args.verdicts) {
    io.error('--verify 需要同时给 --verdicts <verdicts.json>')
    return { exitCode: 2, ok: false }
  }
  const check = verifyRound(readText(args.verify), parseVerdicts(readText(args.verdicts)))
  if (check.ok) {
    io.log('校验通过：' + sourceLabel(args.verify) + ' 与 ' + sourceLabel(args.verdicts) + ' 一致')
    io.log('消息 ' + check.replayed.messageCount + ' 条，' + check.replayed.rounds.length + ' 轮，'
      + check.replayed.seats.length + ' 个座位登场')
    return { exitCode: 0, ok: true, check: check }
  }
  io.error('校验失败，' + check.problems.length + ' 个问题：')
  for (const problem of check.problems) io.error('  - [' + problem.code + '] ' + problem.detail)
  return { exitCode: 1, ok: false, check: check }
}

async function exportCommand(args, io) {
  const input = args.input
  const parsed = JSON.parse(readText(input))
  let record
  if (parsed && (parsed.kind === 'turing-table-round' || (Array.isArray(parsed.events) && parsed.verdicts))) {
    record = { events: parsed.events, verdicts: parsed.verdicts, spec: parsed.spec || null }
  } else if (parsed && Array.isArray(parsed.script)) {
    const table = await runSpec(parsed)
    record = { events: table.messages(), verdicts: table.verdictRecord(), spec: table.spec() }
  } else {
    throw new Error('输入既不是对局脚本（script 字段）也不是对局记录（events/verdicts 字段）：' + sourceLabel(input))
  }

  const jsonl = toJsonl(record.events)
  const verdictsText = serializeVerdicts(record.verdicts)
  const check = verifyRound(jsonl, record.verdicts)
  if (!check.ok) {
    io.error('导出前的自检没通过，没有写文件：')
    for (const problem of check.problems) io.error('  - [' + problem.code + '] ' + problem.detail)
    return { exitCode: 1, ok: false, check: check }
  }

  const stem = input.replace(/\.json$/i, '')
  const dir = args.dir ? resolve(args.dir) : dirname(resolve(stem))
  mkdirSync(dir, { recursive: true })
  const jsonlPath = args.out ? resolve(args.out) : join(dir, basename(stem) + '.jsonl')
  const verdictPath = args.verdicts ? resolve(args.verdicts) : join(dir, basename(stem) + '.verdicts.json')
  writeFileSync(jsonlPath, jsonl, 'utf8')
  writeFileSync(verdictPath, verdictsText, 'utf8')

  const score = record.verdicts.score || {}
  if (!args.quiet) {
    io.log('已导出：')
    io.log('  逐席位对话 JSONL：' + jsonlPath)
    io.log('  判定记录：' + verdictPath)
    io.log('  牌桌：seed=' + String(record.verdicts.seed) + '，座位 ' + record.verdicts.seatCount
      + '（人类 ' + record.verdicts.humanSeats + '，AI ' + record.verdicts.aiSeats + '），'
      + record.verdicts.rounds + ' 轮，结束原因 ' + String(record.verdicts.endReason))
    io.log('  消息 ' + record.events.length + ' 条｜判定 ' + score.judged + '/' + score.total
      + '｜正确 ' + score.correct + '｜准确率 ' + Math.round((score.accuracy || 0) * 100) + '%')
  }
  return { exitCode: 0, ok: true, jsonl: jsonlPath, verdicts: verdictPath, check: check }
}

export async function run(argv, io) {
  const out = io || { log: console.log, error: console.error }
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    out.error(String((error && error.message) || error))
    out.error(USAGE)
    return { exitCode: 2, ok: false }
  }
  if (args.help) {
    out.log(USAGE)
    return { exitCode: 0, ok: true }
  }
  try {
    if (args.replay) return replayCommand(args, out)
    if (args.verify) return verifyCommand(args, out)
    if (!args.input) {
      out.error('缺少输入文件')
      out.error(USAGE)
      return { exitCode: 2, ok: false }
    }
    return await exportCommand(args, out)
  } catch (error) {
    out.error('出错了：' + String((error && error.message) || error))
    return { exitCode: 1, ok: false, error: String((error && error.message) || error) }
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href.toLowerCase() : ''
if (invoked === import.meta.url.toLowerCase()) {
  const result = await run(process.argv.slice(2))
  process.exitCode = result.exitCode
}
