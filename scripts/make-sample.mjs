#!/usr/bin/env node
// Regenerate the shipped sample from src/sample.js.
//
// The spec file is written from the same in-code constant the generator uses,
// so examples/ can never drift from the code that produced it. Running this
// twice in a row produces identical bytes.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAMPLE_SPEC, generateSample } from '../src/sample.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'examples')
mkdirSync(outDir, { recursive: true })

const { jsonl, verdicts, table } = await generateSample()

writeFileSync(join(outDir, 'sample-spec.json'), JSON.stringify(SAMPLE_SPEC, null, 2) + '\n', 'utf8')
writeFileSync(join(outDir, 'sample-round.jsonl'), jsonl, 'utf8')
writeFileSync(join(outDir, 'sample-verdicts.json'), verdicts, 'utf8')

const score = table.score()
console.log('已生成 examples/sample-spec.json、examples/sample-round.jsonl、examples/sample-verdicts.json')
console.log('牌桌 seed=' + table.seed + '，' + table.config.seatCount + ' 个座位（人类 ' + table.config.humanSeats
  + '，AI ' + table.config.aiSeats + '），' + table.roundNumber() + ' 轮，' + table.messages().length + ' 条消息')
console.log('判定 ' + score.judged + '/' + score.total + '，正确 ' + score.correct + '，准确率 '
  + Math.round(score.accuracy * 100) + '%')
