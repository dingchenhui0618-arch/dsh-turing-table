// Client half: loaded the way the web GUI loads it — through
// window.__ModuleLoader__ with a harness-provided require() — and rendered
// against a fake React, because the real GUI is not available here.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, 'lib', 'client.js')

/** A React stub with just the hooks the view uses, plus a render counter. */
function createFakeReact() {
  const hooks = []
  let index = 0
  return {
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return { type: type, props: props || {}, children: children.length === 1 ? children[0] : children }
    },
    useState(initial) {
      const slot = index
      index += 1
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial
      return [hooks[slot], function (value) {
        hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value
      }]
    },
    useEffect(fn) {
      const slot = 'e' + index
      index += 1
      if (!(slot in hooks)) hooks[slot] = fn()
    },
    __begin() { index = 0 },
    __reset() { hooks.length = 0; index = 0 },
  }
}

function loadClient(options) {
  const settings = options || {}
  const react = createFakeReact()
  const calls = []
  const clearIntervalCalls = []
  const timers = []
  const loaded = { id: null, factory: null }

  const fetchStub = function (url, init) {
    calls.push({ url: url, init: init, body: init && init.body ? JSON.parse(init.body) : null })
    if (settings.fetchFails === true) return Promise.reject(new Error('host unreachable'))
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve(settings.state || sampleState()) },
    })
  }

  const document = {
    createElement(tag) {
      return { tag: tag, dataset: {}, textContent: '', remove() { this.removed = true } }
    },
    head: {
      appended: [],
      appendChild(node) { this.appended.push(node) },
    },
  }

  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { loaded.id = spec.id; loaded.factory = spec.factory } } },
    document: document,
    fetch: fetchStub,
    console: console,
    setInterval(fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length },
    clearInterval(id) { clearIntervalCalls.push(id) },
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(bundlePath, 'utf8'), sandbox)

  const exportsObject = loaded.factory(function requireStub(name) {
    if (name === 'react') return react
    throw new Error('the client bundle must not require anything else, asked for ' + name)
  })

  return {
    exports: exportsObject,
    id: loaded.id,
    react: react,
    calls: calls,
    timers: timers,
    cleared: clearIntervalCalls,
    document: document,
  }
}

function sampleState(overrides) {
  const view = {
    v: 1,
    seed: 'client-seed',
    seatCount: 3,
    humanSeats: 1,
    aiSeats: 2,
    playerSeat: 0,
    round: 1,
    maxRounds: 8,
    status: 'awaiting-question',
    over: false,
    endReason: null,
    pending: [],
    remaining: [1, 2],
    seats: [
      { id: 0, label: '座位 1', player: true, pending: false, answers: 0, lastText: null, judged: false, verdict: null, correct: null, judgedRound: null, kind: 'human', modelConfig: null, disguise: null },
      { id: 1, label: '座位 2', player: false, pending: false, answers: 1, lastText: '我带了伞。', judged: false, verdict: null, correct: null, judgedRound: null, kind: null, modelConfig: null, disguise: null },
      { id: 2, label: '座位 3', player: false, pending: false, answers: 1, lastText: '我没带伞。', judged: false, verdict: null, correct: null, judgedRound: null, kind: null, modelConfig: null, disguise: null },
    ],
    transcript: [
      { id: 'm0001', round: 1, ts: '2020-01-01T00:00:00.000Z', seat: 0, seatLabel: '座位 1', role: 'question', to: 'table', replyTo: null, text: '你昨天带伞了吗？' },
      { id: 'm0002', round: 1, ts: '2020-01-01T00:00:01.000Z', seat: 1, seatLabel: '座位 2', role: 'answer', to: 0, replyTo: 'm0001', text: '我带了伞。' },
    ],
    verdicts: [],
    score: { total: 2, judged: 0, correct: 0, wrong: 0, accuracy: 0, coverage: 0, unjudged: [1, 2] },
  }
  return Object.assign({
    ok: true,
    view: view,
    stats: { rounds: 1, messages: 2, answers: 2, llmCalls: 2, degraded: 0, verdicts: 0, exports: 0, requests: 1 },
    table: { seed: 'client-seed', seatCount: 3, humanSeats: 1, aiSeats: 2, maxRounds: 8, models: [] },
    export: { dir: 'C:/tmp', last: null },
    errors: { config: null, route: null, last: null },
  }, overrides || {})
}

function makeCtx() {
  const registered = []
  const disposers = []
  const injected = []
  const ctx = {
    slots: {
      inject(name, fn) { injected.push(name); disposers.push(fn()) },
      register(meta, component) {
        registered.push({ meta: meta, component: component })
        return function () {
          const index = registered.findIndex(function (item) { return item.meta === meta })
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : function () {}
      disposers.push(wrapped)
      return wrapped
    },
  }
  return {
    ctx: ctx,
    injected: injected,
    registered: registered,
    dispose() {
      const pending = disposers.splice(0)
      for (const dispose of pending) dispose()
    },
  }
}

/** Resolve function components so the tree can be inspected as plain elements. */
function resolveElements(node, out) {
  const found = out || []
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) resolveElements(child, found)
    return found
  }
  if (typeof node.type === 'function') {
    resolveElements(node.type(node.props), found)
    return found
  }
  found.push(node)
  resolveElements(node.children, found)
  return found
}

function textOf(node) {
  const parts = []
  const walk = function (value) {
    if (value === null || value === undefined || typeof value === 'boolean') return
    if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return }
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (typeof value === 'object') {
      walk(value.props && value.props.children)
      walk(value.children)
    }
  }
  walk(node)
  return parts.join(' ')
}

function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, 0) })
}

function mountAndRender(harness, state) {
  const ctx = makeCtx()
  harness.exports.apply(ctx.ctx)
  const component = ctx.registered[0].component
  const render = function () {
    harness.react.__begin()
    return component({})
  }
  return { ctx: ctx, component: component, render: render, tree: render() }
}

test('the built client bundle loads through __ModuleLoader__ and exports the plugin', () => {
  const harness = loadClient({})
  assert.equal(harness.id, 'dsh-turing-table')
  assert.equal(harness.exports.name, 'dsh-turing-table')
  assert.deepEqual(Array.from(harness.exports.inject), ['slots'])
  assert.equal(typeof harness.exports.apply, 'function')
})

test('apply registers the 圆桌 view and injects its stylesheet', () => {
  const harness = loadClient({})
  const ctx = makeCtx()
  harness.exports.apply(ctx.ctx)
  assert.deepEqual(ctx.injected, ['conversation.view'])
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].meta.name, 'conversation.view')
  assert.equal(ctx.registered[0].meta.label, '圆桌')
  assert.equal(typeof ctx.registered[0].component, 'function')
  assert.equal(harness.document.head.appended.length, 1)
  assert.ok(harness.document.head.appended[0].textContent.includes('.tt-root'))
  assert.equal(harness.document.head.appended[0].dataset.plugin, 'dsh-turing-table')
})

test('the view renders one card per seat and shows no identity it was not given', async () => {
  const harness = loadClient({})
  const mounted = mountAndRender(harness)
  await tick()
  const tree = mounted.render()
  const elements = resolveElements(tree)
  const cards = elements.filter(function (element) { return element.props['data-seat'] !== undefined })
  assert.equal(cards.length, 3, 'three seats, three cards')

  const text = textOf(resolveElements(tree))
  assert.match(text, /图灵圆桌/)
  assert.match(text, /seed client-seed/)
  assert.match(text, /你昨天带伞了吗/)
  assert.match(text, /我带了伞。/)
  assert.match(text, /你/, 'the player seat is marked')
  const badges = elements.filter(function (element) {
    return typeof element.props.className === 'string' && element.props.className.includes('tt-badge')
  })
  assert.ok(badges.length > 0, 'the player seat carries a badge')
  const badgeText = badges.map(textOf).join('｜')
  assert.doesNotMatch(badgeText, /判对|判错/, 'no verdict badge before a verdict: ' + badgeText)
  assert.doesNotMatch(badgeText, /人类/, 'no truth badge before a verdict: ' + badgeText)
  assert.doesNotMatch(text, /h-a|client-model/)
  const verdictButtons = elements.filter(function (element) {
    return element.type === 'button' && textOf(element).includes('这是 AI')
  })
  assert.equal(verdictButtons.length, 2, 'one verdict pair per unjudged seat, and none for the player')
})

test('a verdict button posts the seat and the call to the host', async () => {
  const harness = loadClient({})
  const mounted = mountAndRender(harness)
  await tick()
  const elements = resolveElements(mounted.render())
  const button = elements.find(function (element) {
    return element.type === 'button' && textOf(element).trim() === '这是 AI'
  })
  assert.ok(button, 'the AI button is there')
  button.props.onClick()
  await tick()
  const posts = harness.calls.filter(function (call) { return call.url === '/dsh-turing-table/verdict' })
  assert.equal(posts.length, 1)
  assert.equal(posts[0].init.method, 'POST')
  assert.deepEqual(posts[0].body, { seat: 1, verdict: 'ai' })
})

test('the ask box posts the drafted question to the chosen seat', async () => {
  const harness = loadClient({})
  const mounted = mountAndRender(harness)
  await tick()
  let elements = resolveElements(mounted.render())
  const input = elements.find(function (element) { return element.type === 'input' })
  assert.ok(input, 'there is a question input')
  input.props.onChange({ target: { value: '   ' } })

  elements = resolveElements(mounted.render())
  const askButton = elements.find(function (element) {
    return element.type === 'button' && textOf(element).trim() === '提问'
  })
  assert.equal(askButton.props.disabled, true, 'whitespace alone is not a question')

  input.props.onChange({ target: { value: '你昨天带伞了吗？' } })
  elements = resolveElements(mounted.render())
  const ready = elements.find(function (element) {
    return element.type === 'button' && textOf(element).trim() === '提问'
  })
  assert.equal(ready.props.disabled, false, 'a real question enables the button')

  const select = elements.find(function (element) { return element.type === 'select' })
  assert.ok(select, 'the target seat can be chosen')
  select.props.onChange({ target: { value: '2' } })
  elements = resolveElements(mounted.render())
  const targeted = elements.find(function (element) {
    return element.type === 'button' && textOf(element).trim() === '提问'
  })
  targeted.props.onClick()
  await tick()
  const posts = harness.calls.filter(function (call) { return call.url === '/dsh-turing-table/ask' })
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { text: '你昨天带伞了吗？', to: 2 })
})

test('mounting starts the shared poll and unloading stops it', async () => {
  const harness = loadClient({})
  const mounted = mountAndRender(harness)
  await tick()
  assert.equal(harness.timers.length, 1, 'one shared poller, not one per mount')
  assert.equal(harness.calls.filter(function (call) { return call.url === '/dsh-turing-table/state' }).length, 1)
  assert.equal(harness.timers[0].ms, 1500)

  mounted.ctx.dispose()
  assert.deepEqual(harness.cleared, [1], 'the interval is cleared on unload')
  assert.equal(harness.document.head.appended[0].removed, true, 'and the stylesheet is removed')
})

test('an unreachable host shows an error banner instead of an empty table', async () => {
  const harness = loadClient({ fetchFails: true })
  const mounted = mountAndRender(harness)
  await tick()
  const text = textOf(mounted.render())
  assert.match(text, /与 host 通信失败/)
  assert.match(text, /host unreachable/)
})
