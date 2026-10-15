// Host half: the route, the per-seat model routing, degradation, and unload.

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseJsonl, parseVerdicts, verifyRound } from '../src/export.js'
import { apply, freshSeed, safeFileName } from '../src/host.js'

const MODELS = [
  { id: 'h-a', provider: 'pa', model: 'ma', temperature: 0.1, disguise: { level: 'low' } },
  { id: 'h-b', provider: 'pb', model: 'mb', temperature: 0.2, disguise: { level: 'high', pressure: 'hold' } },
  { id: 'h-c', provider: 'pc', model: 'mc', temperature: 0.3, disguise: { level: 'medium', pressure: 'deflect' } },
]

function stubLlm(reply) {
  const calls = []
  return {
    calls: calls,
    async *stream(options) {
      calls.push(options)
      if (typeof reply === 'function') {
        for (const chunk of reply(options)) yield chunk
        return
      }
      yield { type: 'text-delta', text: reply }
    },
  }
}

function setup(options) {
  const settings = options || {}
  const routes = []
  const disposers = []
  const webServer = {
    register(route) {
      if (settings.registerThrows === true) throw new Error('webServer.register is unavailable')
      routes.push(route)
      return function () {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const services = { agentDefaultModel: { currentSelection: () => ({ provider: 'session', model: 'session-model' }) } }
  if (settings.llm !== undefined) services.llm = settings.llm

  const ctx = {
    webServer: webServer,
    get(name) { return services[name] },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : function () {}
      disposers.push(wrapped)
      return wrapped
    },
  }

  const dir = settings.exportDir || mkdtempSync(join(tmpdir(), 'turing-host-'))
  const plugin = apply(ctx, Object.assign({
    exportDir: dir,
    seed: 'host-seed',
    seatCount: 4,
    humanSeats: 1,
    models: MODELS,
  }, settings.config || {}))

  async function call(method, body) {
    const route = routes[0]
    assert.ok(route, 'a route was registered')
    const payload = JSON.stringify(body === undefined ? {} : body)
    const req = {
      method: method === 'state' ? 'GET' : 'POST',
      url: '/dsh-turing-table/' + method,
      on(event, handler) {
        if (event === 'data') handler(payload)
        else if (event === 'end') handler()
      },
    }
    let out = null
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) { out = { status: res.statusCode, body: JSON.parse(text) } },
    }
    await route.handler(req, res)
    return out
  }

  return {
    plugin: plugin,
    routes: routes,
    dir: dir,
    call: call,
    aiSeats: function () { return plugin.table().seats.filter(function (seat) { return seat.kind === 'ai' }) },
    dispose() {
      const pending = disposers.splice(0)
      for (const dispose of pending) dispose()
    },
  }
}

test('applying registers one prefix route and hands back the table', () => {
  const h = setup({ llm: stubLlm('我带了伞。') })
  assert.equal(h.routes.length, 1)
  assert.equal(h.routes[0].kind, 'prefix')
  assert.equal(h.routes[0].path, '/dsh-turing-table')
  assert.equal(typeof h.routes[0].handler, 'function')
  assert.equal(h.plugin.table().seed, 'host-seed')
  assert.equal(h.plugin.table().config.aiSeats, 3)
})

test('state is the public view: no identity for an unjudged seat', async () => {
  const h = setup({ llm: stubLlm('我带了伞。') })
  const out = await h.call('state')
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(out.body.view.seatCount, 4)
  const others = out.body.view.seats.filter(function (seat) { return !seat.player })
  assert.equal(others.every(function (seat) { return seat.kind === null && seat.modelConfig === null }), true)
  const text = JSON.stringify(out.body)
  for (const model of MODELS) assert.ok(!text.includes(model.id), 'the state payload does not name ' + model.id)
  assert.equal(out.body.table.models.length, 3, 'the pool itself is public, the dealing is not')
})

test('ask drives every AI seat through that seat own model config', async () => {
  const llm = stubLlm('我带了伞。')
  const h = setup({ llm: llm })
  const out = await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  assert.equal(out.status, 200)
  assert.equal(out.body.view.round, 1)
  assert.deepEqual(out.body.view.pending, [])
  assert.equal(out.body.stats.messages, 4)
  assert.equal(out.body.stats.llmCalls, 3)
  assert.equal(llm.calls.length, 3)

  const routes = llm.calls.map(function (call) { return call.provider + '/' + call.model })
  const configured = h.aiSeats().map(function (seat) { return seat.modelConfig.provider + '/' + seat.modelConfig.model })
  assert.deepEqual(routes.slice().sort(), configured.slice().sort(), 'each seat spoke through its own route')
  assert.equal(new Set(routes).size, 3, 'no two seats shared a route')
  assert.match(llm.calls[0].system, /让提问者相信你是人类/)
  assert.match(llm.calls[0].messages[0].content[0].text, /你昨天带伞了吗/)
  assert.ok([0.1, 0.2, 0.3].includes(llm.calls[0].temperature), 'the seat temperature is used: ' + llm.calls[0].temperature)
  assert.ok(h.aiSeats().every(function (seat) { return seat.answerCount === 1 }))
})

test('a seat without a route of its own falls back to the session model', async () => {
  const llm = stubLlm('我带了伞。')
  const h = setup({
    llm: llm,
    config: { models: [{ id: 'inherit', provider: null, model: null, disguise: { level: 'medium' } }] },
  })
  const out = await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  assert.equal(out.status, 200)
  assert.equal(llm.calls.length, 3)
  assert.ok(llm.calls.every(function (call) { return call.provider === 'session' && call.model === 'session-model' }))
})

test('a failing model degrades to the offline narrator and the record says so', async () => {
  const llm = {
    calls: [],
    async *stream() { throw new Error('upstream 500') },
  }
  const h = setup({ llm: llm })
  const out = await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  assert.equal(out.status, 200)
  assert.equal(out.body.stats.degraded, 3)
  assert.equal(out.body.errors.last, 'upstream 500')
  const answers = h.plugin.table().messages().filter(function (message) { return message.role === 'answer' })
  assert.equal(answers.length, 3)
  assert.ok(answers.every(function (message) { return message.degraded === true }), 'a fallback line is labelled')
  assert.ok(answers.every(function (message) { return message.text.length > 0 }), 'and the round still finished')
})

test('a model-side error chunk degrades instead of ending the round', async () => {
  const llm = stubLlm(function () {
    return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }]
  })
  const h = setup({ llm: llm })
  const out = await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  assert.equal(out.status, 200)
  assert.equal(out.body.view.round, 1)
  assert.equal(out.body.stats.degraded, 3)
  assert.equal(out.body.errors.last, 'rate limited')
})

test('a model that returns nothing is treated as a failure, not as an empty line', async () => {
  const llm = stubLlm('   ')
  const h = setup({ llm: llm })
  const out = await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  assert.equal(out.status, 200)
  assert.equal(out.body.stats.degraded, 3)
  assert.equal(out.body.errors.last, 'empty-output')
  const answers = h.plugin.table().messages().filter(function (message) { return message.role === 'answer' })
  assert.ok(answers.every(function (message) { return message.text.trim().length > 0 }))
})

test('without an llm service the table still plays, offline and labelled', async () => {
  const h = setup({})
  const out = await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  assert.equal(out.status, 200)
  assert.equal(out.body.stats.llmCalls, 0)
  assert.equal(out.body.stats.degraded, 3)
  assert.equal(out.body.errors.last, 'no-llm')
  assert.equal(out.body.view.pending.length, 0)
})

test('a human seat waits for a human and then joins the transcript', async () => {
  const llm = stubLlm('我带了伞。')
  const h = setup({ llm: llm, config: { humanSeats: 2 } })
  const humanSeat = h.plugin.table().seats.find(function (seat) { return seat.kind === 'human' && !seat.player })
  const asked = await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  assert.deepEqual(asked.body.view.pending, [humanSeat.id], 'only the human seat is still due')
  assert.equal(llm.calls.length, 2, 'the AI seats already spoke')

  const said = await h.call('say', { seat: humanSeat.id, text: '我昨天没去公司，这事我说不好。' })
  assert.equal(said.status, 200)
  assert.deepEqual(said.body.view.pending, [])
  const line = h.plugin.table().messages().find(function (message) { return message.seatKind === 'human' && message.role === 'answer' })
  assert.equal(line.text, '我昨天没去公司，这事我说不好。')
  assert.equal(line.shaped, false)

  const rejected = await h.call('say', { seat: humanSeat.id, text: '再说一句' })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.code, 'not-pending')
})

test('verdicts go through the route, and a second verdict for a seat is refused', async () => {
  const h = setup({ llm: stubLlm('我带了伞。') })
  await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  const target = h.aiSeats()[0]
  const out = await h.call('verdict', { seat: target.id, verdict: 'ai', note: '两次说法对上了' })
  assert.equal(out.status, 200)
  assert.equal(out.body.verdict.correct, true)
  assert.equal(out.body.verdict.round, 1)
  assert.equal(out.body.stats.verdicts, 1)
  const row = out.body.view.seats.find(function (seat) { return seat.id === target.id })
  assert.equal(row.kind, 'ai')
  assert.ok(row.modelConfig.id.length > 0)

  const again = await h.call('verdict', { seat: target.id, verdict: 'human' })
  assert.equal(again.status, 400)
  assert.equal(again.body.code, 'already-judged')

  const bad = await h.call('verdict', { seat: target.id + 100, verdict: 'ai' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'unknown-seat')
})

test('reveal refuses before the round ends and returns the truth after', async () => {
  const h = setup({ llm: stubLlm('我带了伞。') })
  await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  const early = await h.call('reveal')
  assert.equal(early.status, 403)
  assert.equal(early.body.code, 'not-over')

  await h.call('close')
  const late = await h.call('reveal')
  assert.equal(late.status, 200)
  assert.equal(late.body.revealed.over, true)
  assert.equal(late.body.revealed.seats.every(function (seat) { return seat.kind !== null }), true)
  assert.ok(JSON.stringify(late.body).includes('h-a') || JSON.stringify(late.body).includes('h-b'))
})

test('export writes both files into the export directory and verifies them', async () => {
  const h = setup({ llm: stubLlm('我带了伞。') })
  await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  await h.call('verdict', { seat: h.aiSeats()[0].id, verdict: 'ai' })
  await h.call('close')

  const out = await h.call('export')
  assert.equal(out.status, 200)
  const exported = out.body.exported
  assert.ok(existsSync(exported.jsonl), 'the transcript was written')
  assert.ok(existsSync(exported.verdicts), 'the verdict record was written')
  assert.equal(exported.verified, true, JSON.stringify(exported.problems))
  assert.equal(resolve(exported.jsonl).startsWith(resolve(h.dir)), true, 'it stays inside the export dir by default')
  assert.ok(exported.jsonl.endsWith('.jsonl'))
  assert.ok(exported.verdicts.endsWith('.verdicts.json'))

  const lines = parseJsonl(readFileSync(exported.jsonl, 'utf8'))
  assert.equal(lines.length, h.plugin.table().messages().length)
  const record = parseVerdicts(readFileSync(exported.verdicts, 'utf8'))
  assert.equal(record.seed, 'host-seed')
  assert.equal(verifyRound(readFileSync(exported.jsonl, 'utf8'), record).ok, true)
  assert.equal(readdirSync(h.dir).length, 2)
})

test('a new round switches seed and clears the record', async () => {
  const h = setup({ llm: stubLlm('我带了伞。') })
  await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  const out = await h.call('new', { seed: 'second-round' })
  assert.equal(out.status, 200)
  assert.equal(h.plugin.table().seed, 'second-round')
  assert.equal(h.plugin.table().messages().length, 0)
  assert.equal(out.body.stats.messages, 0)
  assert.equal(out.body.view.round, 0)
  assert.ok(freshSeed('x').startsWith('x-'))
})

test('an export seed that tries to climb out of the directory is defanged', async () => {
  const h = setup({ llm: stubLlm('我带了伞。') })
  await h.call('new', { seed: '../../evil dir/round' })
  await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  const out = await h.call('export')
  const exported = out.body.exported
  assert.equal(resolve(exported.jsonl).startsWith(resolve(h.dir)), true, exported.jsonl)
  assert.equal(safeFileName('../../evil dir/round').includes('/'), false)
  assert.equal(readdirSync(h.dir).length, 2, 'exactly two files, no directories created')
})

test('a broken plugin config falls back to a default table and reports itself', async () => {
  const h = setup({ llm: stubLlm('我带了伞。'), config: { seatCount: 1, humanSeats: 9 } })
  const out = await h.call('state')
  assert.equal(out.status, 200)
  assert.equal(out.body.errors.config.startsWith('bad-config'), true, out.body.errors.config)
  assert.equal(out.body.view.seatCount, 6, 'the default table is still playable')
  const asked = await h.call('ask', { text: '你昨天带伞了吗？', to: 'table' })
  assert.equal(asked.status, 200)
  assert.equal(asked.body.view.round, 1)
})

test('unloading removes the route, and a refused registration does not take the table down', async () => {
  const h = setup({ llm: stubLlm('我带了伞。') })
  assert.equal(h.routes.length, 1)
  h.dispose()
  assert.equal(h.routes.length, 0, 'the route is gone after unload')

  const refused = setup({ llm: stubLlm('我带了伞。'), registerThrows: true })
  assert.equal(refused.routes.length, 0)
  assert.equal(refused.plugin.snapshot().errors.route, 'webServer.register is unavailable')
  await refused.plugin.ask('你昨天带伞了吗？', 'table')
  assert.equal(refused.plugin.table().roundNumber(), 1, 'the table still runs without a route')
  await refused.plugin.judge(refused.aiSeats()[0].id, 'ai')
  assert.equal(refused.plugin.table().score().judged, 1)
})
