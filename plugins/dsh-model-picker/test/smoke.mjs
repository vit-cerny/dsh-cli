/**
 * Smoke test for dsh-model-picker: the Host half's pure helpers and its one web
 * route, plus a syntax check of the browser half. Runs without DSH.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  normalizeKey, normalizeFavorites, readFavorites, writeFavorites, toggleFavorite, webRoutes,
} from '../lib/index.js'

function tempStatePath() {
  return join(mkdtempSync(join(tmpdir(), 'model-picker-')), 'favorites.json')
}

test('normalizeKey accepts provider/model and rejects junk', () => {
  assert.equal(normalizeKey('api7/gpt-6-sol'), 'api7/gpt-6-sol')
  assert.equal(normalizeKey('  api7/gpt-6-sol  '), 'api7/gpt-6-sol')
  assert.equal(normalizeKey('two/parts/ok'), 'two/parts/ok')
  assert.equal(normalizeKey(''), undefined)
  assert.equal(normalizeKey('no-slash'), undefined)
  assert.equal(normalizeKey('/leading'), undefined)
  assert.equal(normalizeKey('trailing/'), undefined)
  assert.equal(normalizeKey(42), undefined)
  assert.equal(normalizeKey('x'.repeat(400)), undefined)
})

test('normalizeFavorites deduplicates, orders and drops unusable entries', () => {
  assert.deepEqual(normalizeFavorites(['b/x', 'a/y', 'b/x', 'junk']), ['b/x', 'a/y'])
  assert.deepEqual(normalizeFavorites(undefined), [])
  assert.deepEqual(normalizeFavorites('nope'), [])
})

test('favourites round-trip through the state file', () => {
  const path = tempStatePath()
  assert.deepEqual(readFavorites(path), [])
  writeFavorites(['a/one', 'b/two'], path)
  assert.deepEqual(readFavorites(path), ['a/one', 'b/two'])
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).favorites, ['a/one', 'b/two'])
})

test('a corrupt state file reads as empty instead of throwing', () => {
  const path = tempStatePath()
  writeFileSync(path, '{not json')
  assert.deepEqual(readFavorites(path), [])
  writeFileSync(path, JSON.stringify({ favorites: ['a/one', 'nonsense'] }))
  assert.deepEqual(readFavorites(path), ['a/one'])
})

test('toggleFavorite adds, removes and keeps the list clean', () => {
  assert.deepEqual(toggleFavorite([], 'a/one', true), ['a/one'])
  assert.deepEqual(toggleFavorite(['a/one'], 'a/one', true), ['a/one'])
  assert.deepEqual(toggleFavorite(['a/one', 'b/two'], 'a/one', false), ['b/two'])
  assert.throws(() => toggleFavorite([], 'not-a-key', true))
})

/** Drive the route with a fake req/res pair. */
async function call(route, method, body, headers = {}) {
  const req = (async function* () {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body))
  })()
  req.method = method
  req.url = route.path
  req.headers = headers
  req.socket = { remoteAddress: headers['x-remote'] ?? '127.0.0.1' }
  let status = 0
  let payload = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (text) => { payload = text },
  }
  await route.handler(req, res)
  return { status, body: payload === '' ? undefined : JSON.parse(payload) }
}

test('the route serves, toggles and replaces the shared list', async () => {
  const path = tempStatePath()
  const [route] = webRoutes({ logger: undefined }, { stateFile: path })

  assert.deepEqual(await call(route, 'GET'), { status: 200, body: { favorites: [] } })
  assert.deepEqual(await call(route, 'POST', { key: 'api7/gpt-6-sol', favorite: true }, { 'sec-fetch-site': 'same-origin' }), {
    status: 200,
    body: { favorites: ['api7/gpt-6-sol'] },
  })
  assert.deepEqual(await call(route, 'GET'), { status: 200, body: { favorites: ['api7/gpt-6-sol'] } })
  assert.deepEqual(await call(route, 'POST', { key: 'api7/gpt-6-sol', favorite: false }, { 'sec-fetch-site': 'same-origin' }), {
    status: 200,
    body: { favorites: [] },
  })
  assert.deepEqual(await call(route, 'POST', { favorites: ['a/one', 'b/two'] }, { 'sec-fetch-site': 'same-origin' }), {
    status: 200,
    body: { favorites: ['a/one', 'b/two'] },
  })
})

test('the route refuses bad input, foreign origins and non-loopback peers', async () => {
  const [route] = webRoutes({ logger: undefined }, { stateFile: tempStatePath() })

  const sameSite = { 'sec-fetch-site': 'same-origin' }
  assert.equal((await call(route, 'POST', { key: 'not-a-key', favorite: true }, sameSite)).status, 400)
  assert.equal((await call(route, 'POST', { nothing: true }, sameSite)).status, 400)
  assert.equal((await call(route, 'DELETE', undefined, sameSite)).status, 405)
  assert.equal((await call(route, 'POST', { key: 'a/one', favorite: true }, { origin: 'https://evil.test', host: '127.0.0.1' })).status, 403)
  assert.equal((await call(route, 'POST', { key: 'a/one', favorite: true }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await call(route, 'POST', { key: 'a/one', favorite: true }, sameSite)).status, 200)
  assert.equal((await call(route, 'GET', undefined, { 'x-remote': '10.0.0.5' })).status, 403)
})

test('allowWrite: false keeps the stored list read-only', async () => {
  const path = tempStatePath()
  writeFavorites(['a/one'], path)
  const [route] = webRoutes({ logger: undefined }, { stateFile: path, allowWrite: false })
  assert.equal((await call(route, 'GET')).status, 200)
  assert.equal((await call(route, 'POST', { key: 'b/two', favorite: true }, { 'sec-fetch-site': 'same-origin' })).status, 400)
  assert.deepEqual(readFavorites(path), ['a/one'])
})

test('the browser half parses and takes over the composer model control', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // The composer's model control must BE this picker (search + favourites live
  // behind the trigger the user actually clicks), so the single slot is shadowed
  // at a lower priority.
  assert.match(source, /name: 'conversation\.input\.model'/)
  assert.match(source, /priority: -1/)
  // plugin-effort-slider hides any `[aria-haspopup="menu"]` button it finds in
  // the trailing row; this marker is what makes it leave our trigger alone.
  assert.match(source, /'data-efs-model-btn': '1'/)
  assert.match(source, /search\.placeholder/)
  assert.doesNotThrow(() => new Function(source))
})

/**
 * The browser half rendered under a minimal hook runtime. This is the regression
 * guard for two crashes that shipped once already: a favourites listener that
 * handed `setState` to a zero-argument notifier (state became `undefined`, then
 * `for (const key of favorites)` threw), and an inert snapshot that returned a
 * fresh object per read (an endless `useSyncExternalStore` loop).
 */
test('the picker renders, searches and survives a favourites notification', async () => {
  const vm = await import('node:vm')
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  const state = []
  let cursor = 0
  const React = {
    createElement: (tag, props, ...kids) => ({ tag, props: props ?? {}, kids: kids.flat(Infinity).filter((k) => k != null && k !== false && k !== true) }),
    Fragment: 'Fragment',
    useState(init) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof init === 'function' ? init() : init
      return [state[index], (next) => {
        const value = typeof next === 'function' ? next(state[index]) : next
        if (value !== state[index]) state[index] = value
      }]
    },
    useEffect: (fn) => { fn() },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = { current: initial ?? null }
      return state[index]
    },
    useSyncExternalStore: (subscribe, read) => read(),
  }

  const storage = new Map()
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  }
  sandbox.window = {
    localStorage: sandbox.localStorage,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: () => {},
    removeEventListener: () => {},
    __ModuleLoader__: { load: (module) => { sandbox.__module = module } },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  const client = sandbox.__module.factory((request) => {
    if (request === 'react') return React
    // The menu is portaled out of the composer card (which clips overflow), so the
    // module requires react-dom exactly like the shipped selector does.
    if (request === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`unexpected require: ${request}`)
  })

  const registrations = []
  client.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (key, fn) => fn(),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    modelDirectories: {
      directoryFor: () => ({
        store: { subscribe: () => () => {}, getSnapshot: () => ({ current: null, groups: [], status: 'ready' }) },
        load: () => {},
        select: () => Promise.resolve({ ok: true }),
      }),
    },
    sessions: { list: { getSnapshot: () => ({ current: 'session-1' }) }, subagentAddress: () => undefined },
    remote: { session: {} },
  })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'conversation.input.model')
  assert.equal(registrations[0].options.priority, -1)

  const directory = {
    subscribe: () => () => {},
    getSnapshot: () => ({
      current: { provider: 'api7', model: 'gpt-6-sol', reasoningEffort: 'high' },
      groups: [{
        id: 'api7',
        name: '7api',
        models: [
          { id: 'gpt-6-sol', name: 'GPT-6 Sol', reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
          { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
        ],
      }],
      status: 'ready',
      error: null,
    }),
  }
  const props = {
    ...registrations[0].options.inject('session-1'),
    directory,
    t: (key) => key,
  }

  const render = () => {
    cursor = 0
    return registrations[0].component(props)
  }
  const flatten = (node) => [node, ...(node.kids ?? []).flatMap(flatten)]

  const closed = flatten(render())
  assert.ok(closed.some((node) => node.props?.className === 'msp_trigger'), 'the trigger renders')
  assert.equal(closed.find((node) => node.props?.className === 'msp_label')?.kids?.[0], 'GPT-6 Sol')

  // A star change notifies subscribers with no argument; state must stay an array.
  client.favorites.toggleFavorite('api7/gpt-6-luna', true)
  const afterStar = flatten(render())
  assert.ok(afterStar.some((node) => node.props?.className === 'msp_trigger'))

  // Opening the menu renders the search field and one star per row.
  closed.find((node) => node.props?.className === 'msp_trigger').props.onClick()
  const open = flatten(render())
  assert.ok(open.some((node) => node.props?.className === 'msp_search'), 'the search field renders')
  assert.equal(open.filter((node) => node.props?.className === 'msp_row').length, 2)
  assert.equal(open.filter((node) => String(node.props?.className ?? '').startsWith('msp_star')).length, 2)
  assert.equal(
    open.filter((node) => String(node.props?.className ?? '').startsWith('msp_star') && node.props['aria-pressed'] === true).length,
    1,
    'the starred model is the only pressed star',
  )

  // The composer card clips overflow, so the menu must be portaled out of it and
  // positioned against the trigger instead of relying on absolute placement.
  const menu = open.find((node) => node.props?.className === 'msp_menu')
  assert.ok(menu, 'the menu renders')
  assert.equal(typeof menu.props.style.left, 'number')
  assert.equal(typeof menu.props.style.bottom, 'number')

  // With no session the inject face is inert and the entry renders nothing.
  cursor = 0
  assert.equal(registrations[0].component({ ...registrations[0].options.inject(''), t: (key) => key }), null)
})
