/* dsh-turing-table client bundle — generated from src/client.cjs */
window.__ModuleLoader__.load({
  id: "dsh-turing-table",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
// Client half of dsh-turing-table: the 圆桌 Tab in the conversation view.
//
// Must stay CommonJS — the build wraps this in window.__ModuleLoader__.load()
// and React is supplied by the harness.
//
// The host half owns the game; this side renders what /dsh-turing-table/state
// says and posts player actions back. It renders the *public* view only: the
// host never sends the identity of an unjudged seat, so this file could not
// leak the answer even if it tried.

const React = require('react')
const h = React.createElement
const CSS = ".tt-root{display:flex;flex-direction:column;gap:14px;padding:16px;height:100%;overflow:auto;color:inherit;font-size:13px;line-height:1.5}.tt-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.tt-title{font-size:15px;font-weight:600}.tt-sub{opacity:.6;font-size:12px}.tt-spacer{flex:1}.tt-btn{border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer}.tt-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.tt-btn:disabled{opacity:.45;cursor:default}.tt-seats{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.tt-seat{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:9px 11px;display:flex;flex-direction:column;gap:6px}.tt-seat.tt-player{border-color:color-mix(in srgb,currentColor 34%,transparent)}.tt-seat.tt-pending{border-style:dashed}.tt-seat.tt-ai{border-color:color-mix(in srgb,#dc2626 45%,transparent)}.tt-seat.tt-human{border-color:color-mix(in srgb,#16a34a 45%,transparent)}.tt-seat-head{display:flex;align-items:center;gap:8px}.tt-label{font-weight:600}.tt-meta{opacity:.6;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}.tt-last{opacity:.85;font-size:12px}.tt-actions{display:flex;gap:6px;flex-wrap:wrap}.tt-badge{font-size:11px;padding:1px 8px;border-radius:999px;white-space:nowrap;border:1px solid transparent;background:color-mix(in srgb,currentColor 8%,transparent)}.tt-badge.tt-ai{background:color-mix(in srgb,#dc2626 18%,transparent);color:color-mix(in srgb,#dc2626 78%,currentColor);border-color:color-mix(in srgb,#dc2626 35%,transparent)}.tt-badge.tt-human{background:color-mix(in srgb,#16a34a 18%,transparent);color:color-mix(in srgb,#16a34a 78%,currentColor);border-color:color-mix(in srgb,#16a34a 35%,transparent)}.tt-badge.tt-bad{background:color-mix(in srgb,#dc2626 14%,transparent);color:color-mix(in srgb,#dc2626 78%,currentColor)}.tt-ask{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.tt-input{flex:1;min-width:220px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:13px;padding:5px 9px;border-radius:6px}.tt-select{border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 6px;border-radius:6px}.tt-score{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:8px}.tt-stat{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:7px 10px}.tt-stat b{display:block;font-size:17px;font-variant-numeric:tabular-nums;line-height:1.2}.tt-stat span{opacity:.6;font-size:11px}.tt-transcript{display:flex;flex-direction:column;gap:6px}.tt-msg{border-left:2px solid color-mix(in srgb,currentColor 20%,transparent);padding:3px 0 3px 10px}.tt-msg.tt-question{border-left-color:color-mix(in srgb,#2563eb 55%,transparent)}.tt-msg-head{font-size:11px;opacity:.6}.tt-round{opacity:.75;font-size:12px;font-weight:600;margin-top:6px}.tt-err{border:1px solid color-mix(in srgb,#dc2626 50%,transparent);background:color-mix(in srgb,#dc2626 8%,transparent);border-radius:8px;padding:8px 10px;font-size:12px}.tt-empty{opacity:.55;font-size:12px;padding:8px 0}"

const API = '/dsh-turing-table'
const POLL_MS = 1500
const LAST_TEXT_CHARS = 120

// One module-level poller shared by every mounted view.
let snap = { data: null, error: '', actionError: '', at: 0 }
const listeners = new Set()
let timer = null

function emit() {
  Array.from(listeners).forEach(function (fn) {
    try {
      fn(snap)
    } catch (error) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-turing-table] listener failed', error)
    }
  })
}

function load() {
  fetch(API + '/state', { headers: { accept: 'application/json' } })
    .then(function (res) { return res.json() })
    .then(function (data) {
      snap = { data: data, error: '', actionError: snap.actionError, at: Date.now() }
      emit()
    })
    .catch(function (error) {
      snap = { data: snap.data, error: String((error && error.message) || error), actionError: '', at: Date.now() }
      emit()
    })
}

function post(method, body) {
  return fetch(API + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
    .then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data } })
    })
    .then(function (result) {
      snap = {
        data: result.ok && result.data && result.data.view ? result.data : snap.data,
        error: '',
        actionError: result.ok ? '' : String((result.data && result.data.error) || '请求失败'),
        at: Date.now(),
      }
      emit()
      return result
    })
    .catch(function (error) {
      snap = { data: snap.data, error: '', actionError: String((error && error.message) || error), at: Date.now() }
      emit()
      return { ok: false, data: null }
    })
}

/** Start the shared poll on the first subscriber and stop it on the last. */
function subscribe(fn) {
  listeners.add(fn)
  if (timer === null) {
    load()
    timer = setInterval(load, POLL_MS)
  }
  fn(snap)
  return function () {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function shorten(text, max) {
  const value = String(text === undefined || text === null ? '' : text)
  return value.length > max ? value.slice(0, max) + '…' : value
}

function Badge(props) {
  return h('span', { className: 'tt-badge' + (props.tone ? ' tt-' + props.tone : '') }, props.text)
}

function SeatCard(props) {
  const seat = props.seat
  const tone = seat.judged ? (seat.kind === 'ai' ? 'ai' : 'human') : ''
  const classes = ['tt-seat']
  if (seat.player) classes.push('tt-player')
  if (seat.pending) classes.push('tt-pending')
  if (seat.judged) classes.push('tt-' + tone)

  const meta = []
  if (seat.modelConfig) meta.push(seat.modelConfig.id + '｜' + String(seat.modelConfig.provider) + '/' + String(seat.modelConfig.model))
  if (seat.disguise) meta.push('伪装 ' + seat.disguise.level + '｜被追问:' + seat.disguise.pressure)
  meta.push('发言 ' + seat.answers + ' 次')

  return h('div', { className: classes.join(' '), 'data-seat': String(seat.id) },
    h('div', { className: 'tt-seat-head' },
      h('span', { className: 'tt-label' }, seat.label),
      seat.player ? h(Badge, { text: '你' }) : null,
      seat.pending ? h(Badge, { text: '待回答' }) : null,
      seat.judged ? h(Badge, { text: seat.kind === 'ai' ? 'AI' : '人类', tone: tone }) : null,
      seat.judged ? h(Badge, { text: seat.correct ? '判对' : '判错', tone: seat.correct ? '' : 'bad' }) : null,
    ),
    h('div', { className: 'tt-meta' }, meta.join('｜')),
    seat.lastText ? h('div', { className: 'tt-last' }, shorten(seat.lastText, LAST_TEXT_CHARS)) : null,
    seat.player || seat.judged
      ? null
      : h('div', { className: 'tt-actions' },
        h('button', {
          className: 'tt-btn',
          type: 'button',
          onClick: function () { post('verdict', { seat: seat.id, verdict: 'ai' }) },
        }, '这是 AI'),
        h('button', {
          className: 'tt-btn',
          type: 'button',
          onClick: function () { post('verdict', { seat: seat.id, verdict: 'human' }) },
        }, '这是人'),
      ),
  )
}

function Transcript(props) {
  const rows = props.rows || []
  if (rows.length === 0) {
    return h('div', { className: 'tt-empty' }, '还没有对话。向全桌提一个问题开始。')
  }
  return h('div', { className: 'tt-transcript' }, rows.map(function (row, index) {
    const head = '第 ' + row.round + ' 轮｜' + row.seatLabel + '（' + row.role + '）'
    return h('div', { className: 'tt-msg' + (row.role === 'question' ? ' tt-question' : ''), key: row.id || String(index) },
      h('div', { className: 'tt-msg-head' }, head),
      h('div', null, row.text),
    )
  }))
}

function TableRoundView() {
  const [state, setState] = React.useState(snap)
  const [draft, setDraft] = React.useState('')
  const [target, setTarget] = React.useState('table')
  React.useEffect(function () { return subscribe(setState) }, [])

  const payload = state.data || null
  const view = (payload && payload.view) || null
  const stats = (payload && payload.stats) || { rounds: 0, messages: 0, answers: 0, llmCalls: 0, degraded: 0, verdicts: 0 }
  const score = (view && view.score) || { total: 0, judged: 0, correct: 0, accuracy: 0, unjudged: [] }
  const seats = (view && view.seats) || []
  const transcript = (view && view.transcript) || []
  const canAsk = Boolean(view) && !view.over && view.pending.length === 0 && draft.trim().length > 0
  const targets = seats.filter(function (seat) { return !seat.player })

  const options = [h('option', { key: 'table', value: 'table' }, '全体座位')].concat(targets.map(function (seat) {
    return h('option', { key: String(seat.id), value: String(seat.id) }, seat.label)
  }))

  return h('div', { className: 'tt-root' },
    h('div', { className: 'tt-head' },
      h('div', { className: 'tt-title' }, '图灵圆桌'),
      h('div', { className: 'tt-sub' }, view
        ? '第 ' + view.round + '/' + view.maxRounds + ' 轮｜seed ' + view.seed + '｜' + (view.over ? '已结束（' + String(view.endReason) + '）' : '进行中')
        : '连接 host 中…'),
      h('div', { className: 'tt-spacer' }),
      h('button', { className: 'tt-btn', type: 'button', onClick: function () { post('close', {}) } }, '收局'),
      h('button', {
        className: 'tt-btn',
        type: 'button',
        disabled: !view || !view.over,
        onClick: function () { post('new', {}) },
      }, '新一局'),
      h('button', { className: 'tt-btn', type: 'button', onClick: function () { post('export', {}) } }, '导出这一局'),
    ),
    state.error ? h('div', { className: 'tt-err' }, '与 host 通信失败：' + state.error) : null,
    state.actionError ? h('div', { className: 'tt-err' }, state.actionError) : null,
    payload && payload.errors && (payload.errors.config || payload.errors.route || payload.errors.last)
      ? h('div', { className: 'tt-err' }, '降级记录：'
        + [payload.errors.config, payload.errors.route, payload.errors.last].filter(Boolean).join('；'))
      : null,
    h('div', { className: 'tt-ask' },
      h('input', {
        className: 'tt-input',
        value: draft,
        placeholder: '问一个问题：同一个事实可以换个问法再问一遍，比较各座位的说法',
        onChange: function (event) { setDraft(event.target.value) },
      }),
      h('select', {
        className: 'tt-select',
        value: target,
        onChange: function (event) { setTarget(event.target.value) },
      }, options),
      h('button', {
        className: 'tt-btn',
        type: 'button',
        disabled: !canAsk,
        onClick: function () {
          const to = target === 'table' ? 'table' : Number(target)
          post('ask', { text: draft, to: to }).then(function (result) {
            if (result && result.ok) setDraft('')
          })
        },
      }, '提问'),
    ),
    h('div', { className: 'tt-score' },
      h('div', { className: 'tt-stat' }, h('b', null, String(view ? view.round : 0)), h('span', null, '轮次')),
      h('div', { className: 'tt-stat' }, h('b', null, String(stats.messages)), h('span', null, '消息')),
      h('div', { className: 'tt-stat' }, h('b', null, String(score.judged) + '/' + String(score.total)), h('span', null, '已判定')),
      h('div', { className: 'tt-stat' }, h('b', null, String(score.correct)), h('span', null, '判对')),
      h('div', { className: 'tt-stat' }, h('b', null, Math.round((score.accuracy || 0) * 100) + '%'), h('span', null, '准确率')),
      h('div', { className: 'tt-stat' }, h('b', null, String(stats.degraded)), h('span', null, '降级次数')),
    ),
    h('div', null,
      h('h4', { style: { margin: '0 0 8px', fontSize: '12px', opacity: 0.75 } }, '座位（判定前 host 不会告诉你谁是 AI）'),
      seats.length === 0
        ? h('div', { className: 'tt-empty' }, '还没有牌桌。')
        : h('div', { className: 'tt-seats' }, seats.map(function (seat) {
          return h(SeatCard, { key: String(seat.id), seat: seat })
        })),
    ),
    h('div', null,
      h('h4', { style: { margin: '0 0 8px', fontSize: '12px', opacity: 0.75 } }, '对话'),
      h(Transcript, { rows: transcript }),
    ),
    payload && payload.export && payload.export.last
      ? h('div', { className: 'tt-meta' }, '上次导出：' + payload.export.last.jsonl
        + '（自检 ' + (payload.export.last.verified ? '通过' : '未通过') + '）')
      : null,
  )
}

function apply(ctx) {
  // dsh can unload a plugin at runtime, so every registration here has a
  // matching teardown — including the module-scope poller, which outlives any
  // single mount and would otherwise keep fetching after unload.
  ctx.effect(function () {
    return function () {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      listeners.clear()
      snap = { data: null, error: '', actionError: '', at: 0 }
    }
  })

  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-turing-table'
    style.textContent = CSS
    document.head.appendChild(style)
    return function () { style.remove() }
  })

  ctx.slots.inject('conversation.view', function () {
    let disposeView
    try {
      disposeView = ctx.slots.register(
        { name: 'conversation.view', id: 'turing-table', order: 40, label: '圆桌' },
        TableRoundView,
      )
    } catch (error) {
      disposeView = undefined
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[dsh-turing-table] could not register the 圆桌 view; the host half still runs the table', error)
      }
    }
    return typeof disposeView === 'function' ? disposeView : function () {}
  })
}

module.exports = {
  name: 'dsh-turing-table',
  inject: ['slots'],
  apply: apply,
}
    return module.exports;
  },
});
