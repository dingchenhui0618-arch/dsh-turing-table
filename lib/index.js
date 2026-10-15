// Host half of dsh-turing-table.
//
// It owns one table, drives the AI seats through the harness's llm service
// (each seat with its own model config), and exposes the game over the plugin
// HTTP route the client half renders.
//
// Failure policy, deliberately the same shape as dsh-warden's: a broken model
// route, a model that errors, a model that returns nothing — none of them may
// end the round. Each one degrades to the offline narrator and is recorded on
// the message as `degraded: true`, so the export never pretends a fallback
// line came from a model. A broken plugin config falls back to a default table
// and reports itself instead of refusing to load.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ExportError, parseVerdicts, serializeVerdicts, toJsonl, verifyRound } from './export.js'
import { composeSystemPrompt, composeUserPrompt, offlineResponder } from './speaker.js'
import { TableError, createTable, runRound } from './table.js'

export const name = 'dsh-turing-table'
export const inject = ['webServer']

const PREVIEW_CHARS = 400

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise(function (resolve) {
    let raw = ''
    req.on('data', function (chunk) {
      raw += chunk
      if (raw.length > 1048576) req.destroy()
    })
    req.on('end', function () {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : {})
      } catch (error) {
        resolve({})
      }
    })
    req.on('error', function () {
      resolve({})
    })
  })
}

function methodFromUrl(url) {
  const path = String(url || '').split('?')[0]
  const rest = path.replace(/^\/dsh-turing-table\/?/, '')
  return rest || 'state'
}

function messageOf(error) {
  return String((error && error.message) || error)
}

export function safeFileName(seed) {
  const text = String(seed === undefined || seed === null ? 'round' : seed).replace(/[^A-Za-z0-9._-]+/g, '_')
  return text.slice(0, 60) || 'round'
}

export function freshSeed(prefix) {
  const head = typeof prefix === 'string' && prefix.length > 0 ? prefix : 'turing'
  return head + '-' + Date.now().toString(36)
}

export function apply(ctx, config) {
  const settings = config && typeof config === 'object' ? config : {}
  const exportDir = typeof settings.exportDir === 'string' && settings.exportDir.length > 0
    ? settings.exportDir
    : join(dshHome(), 'turing-table')

  const baseSettings = {
    seed: typeof settings.seed === 'string' && settings.seed.length > 0 ? settings.seed : freshSeed(),
    seatCount: settings.seatCount,
    humanSeats: settings.humanSeats,
    maxRounds: settings.maxRounds,
    models: settings.models,
    disguise: settings.disguise,
    seatLabels: settings.seatLabels,
  }

  const stats = { rounds: 0, messages: 0, answers: 0, llmCalls: 0, degraded: 0, verdicts: 0, exports: 0, requests: 0 }
  let configError = null
  let routeError = null
  let lastError = null
  let exported = null

  function build(input) {
    try {
      const table = createTable(input)
      return table
    } catch (error) {
      configError = (error && error.code ? error.code + ': ' : '') + messageOf(error)
      return createTable({ seed: input && input.seed ? input.seed : freshSeed() })
    }
  }

  let table = build(baseSettings)

  function routeFor(seat) {
    const model = seat.modelConfig
    if (model && model.provider && model.model) return { provider: model.provider, model: model.model }
    const defaults = ctx.get('agentDefaultModel')
    if (defaults === undefined) return null
    try {
      const selection = defaults.currentSelection()
      if (selection && selection.provider && selection.model) {
        return { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
      }
    } catch (error) {
      return null
    }
    return null
  }

  async function speak(turn) {
    const llm = ctx.get('llm')
    if (llm === undefined) return { error: 'no-llm' }
    const route = routeFor(turn.seat)
    if (route === null) return { error: 'no-route' }
    const model = turn.seat.modelConfig || {}
    const options = {
      provider: route.provider,
      model: route.model,
      system: composeSystemPrompt(turn),
      messages: [{
        id: 'turing-' + turn.seat.id + '-r' + turn.round,
        role: 'user',
        content: [{ type: 'text', text: composeUserPrompt(turn) }],
        source: { kind: 'plugin', plugin: 'turing-table' },
      }],
      temperature: model.temperature === undefined ? 0.8 : model.temperature,
      maxTokens: model.maxTokens || 200,
    }
    if (route.reasoningEffort) options.reasoningEffort = route.reasoningEffort
    stats.llmCalls += 1
    let out = ''
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta' && chunk.text) out += chunk.text
      else if (chunk.type === 'finish' && chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        const failure = chunk.reason.failure && chunk.reason.failure.message
        return { error: failure || ('finish ' + chunk.reason.kind) }
      }
    }
    const text = out.trim()
    return text.length > 0 ? { text: text, error: null } : { error: 'empty-output' }
  }

  async function fillAnswers() {
    const produced = await runRound(table, async function (turn) {
      if (turn.seat.kind !== 'ai') return undefined
      try {
        const result = await speak(turn)
        if (result.error) throw new Error(result.error)
        return result.text
      } catch (error) {
        // Counted here, once per seat, whether the model erred, aborted, threw
        // or said nothing. runRound then falls back to the offline narrator and
        // marks the message degraded, so the export never passes a fallback
        // line off as a model's own words.
        stats.degraded += 1
        lastError = messageOf(error)
        throw error
      }
    })
    stats.answers += produced.length
    stats.messages = table.messages().length
    return produced
  }

  function snapshot() {
    const view = table.publicView()
    return {
      ok: true,
      view: view,
      stats: Object.assign({}, stats, { messages: table.messages().length }),
      table: {
        seed: table.seed,
        seatCount: view.seatCount,
        humanSeats: view.humanSeats,
        aiSeats: view.aiSeats,
        maxRounds: view.maxRounds,
        models: table.config.models.map(function (model) {
          // The pool is public; which seat was dealt which config is not.
          return { provider: model.provider, model: model.model, temperature: model.temperature }
        }),
      },
      export: {
        dir: exportDir,
        last: exported,
      },
      errors: { config: configError, route: routeError, last: lastError },
    }
  }

  function writeExport(target) {
    const dir = typeof target === 'string' && target.length > 0 ? target : exportDir
    mkdirSync(dir, { recursive: true })
    const base = 'round-' + safeFileName(table.seed)
    const jsonlPath = join(dir, base + '.jsonl')
    const verdictPath = join(dir, base + '.verdicts.json')
    writeFileSync(jsonlPath, toJsonl(table.messages()), 'utf8')
    writeFileSync(verdictPath, serializeVerdicts(table.verdictRecord()), 'utf8')
    stats.exports += 1
    // Read the two files back off disk and re-check them: an export that cannot
    // be verified is reported as unverified rather than assumed good.
    let check
    try {
      check = verifyRound(readFileSync(jsonlPath, 'utf8'), parseVerdicts(readFileSync(verdictPath, 'utf8')))
    } catch (error) {
      check = { ok: false, problems: [{ code: 'readback-failed', detail: messageOf(error) }] }
    }
    exported = {
      dir: dir,
      jsonl: jsonlPath,
      verdicts: verdictPath,
      messages: table.messages().length,
      verified: check.ok,
      problems: check.problems,
    }
    return exported
  }

  async function handle(req, res) {
    stats.requests += 1
    const method = methodFromUrl(req.url)
    if (req.method === 'GET' || req.method === 'HEAD' || method === 'state') {
      sendJson(res, 200, snapshot())
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const body = await readBody(req)
    try {
      if (method === 'ask') {
        table.ask({ text: body.text, to: body.to })
        await fillAnswers()
        stats.messages = table.messages().length
        stats.rounds = table.roundNumber()
        sendJson(res, 200, snapshot())
        return
      }
      if (method === 'say') {
        table.say(body.seat, body.text)
        sendJson(res, 200, snapshot())
        return
      }
      if (method === 'verdict') {
        const entry = table.judge(body.seat, body.verdict, { note: body.note })
        stats.verdicts = table.verdictList().length
        sendJson(res, 200, Object.assign(snapshot(), { verdict: entry }))
        return
      }
      if (method === 'close') {
        const closed = table.close()
        sendJson(res, 200, Object.assign(snapshot(), { closed: closed }))
        return
      }
      if (method === 'reveal') {
        if (!table.isOver()) {
          sendJson(res, 403, { ok: false, error: '本局还没结束，不能提前揭晓', code: 'not-over' })
          return
        }
        sendJson(res, 200, Object.assign(snapshot(), { revealed: table.state() }))
        return
      }
      if (method === 'new') {
        const next = Object.assign({}, baseSettings, {
          seed: typeof body.seed === 'string' && body.seed.length > 0 ? body.seed : freshSeed(),
          seatCount: body.seatCount === undefined ? baseSettings.seatCount : body.seatCount,
          humanSeats: body.humanSeats === undefined ? baseSettings.humanSeats : body.humanSeats,
          maxRounds: body.maxRounds === undefined ? baseSettings.maxRounds : body.maxRounds,
          models: Array.isArray(body.models) && body.models.length > 0 ? body.models : baseSettings.models,
        })
        table = build(next)
        exported = null
        lastError = null
        stats.rounds = 0
        stats.messages = 0
        stats.answers = 0
        stats.verdicts = 0
        sendJson(res, 200, snapshot())
        return
      }
      if (method === 'export') {
        const result = writeExport(typeof body.dir === 'string' ? body.dir : undefined)
        sendJson(res, 200, Object.assign(snapshot(), { exported: result }))
        return
      }
      if (method === 'transcript') {
        const view = table.publicView()
        sendJson(res, 200, { ok: true, transcript: view.transcript, preview: toJsonl(table.messages()).slice(0, PREVIEW_CHARS) })
        return
      }
      sendJson(res, 404, { ok: false, error: 'unknown method: ' + method })
    } catch (error) {
      const code = error && error.code ? error.code : (error instanceof TableError || error instanceof ExportError ? 'error' : 'internal')
      if (!(error instanceof TableError) && !(error instanceof ExportError)) lastError = messageOf(error)
      sendJson(res, error instanceof TableError || error instanceof ExportError ? 400 : 500, {
        ok: false,
        error: messageOf(error),
        code: code,
      })
    }
  }

  // Same containment as dsh-warden's panel: if the route cannot be registered —
  // a changed webServer contract, a host with no web server — the table still
  // exists and every method is still reachable programmatically; only the UI
  // half goes missing, and it says so instead of taking apply() down.
  ctx.effect(function () {
    let disposeRoute
    try {
      disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-turing-table',
        handler: handle,
      })
    } catch (error) {
      routeError = messageOf(error)
      disposeRoute = undefined
    }
    return function () {
      if (typeof disposeRoute === 'function') disposeRoute()
    }
  })

  return {
    table: function () { return table },
    snapshot: snapshot,
    exportRound: writeExport,
    ask: async function (text, to) { table.ask({ text: text, to: to }); return fillAnswers() },
    judge: function (seat, verdict, note) { return table.judge(seat, verdict, { note: note }) },
    close: function () { return table.close() },
  }
}
