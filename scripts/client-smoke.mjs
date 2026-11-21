/**
 * Client-half smoke test: load client.js the way the Web page does, render the
 * settings page with stubbed React/fetch, and drive it through empty → loaded →
 * add-form → submit states. Catches the failure that matters most for a slot
 * entry — a component that throws on render blanks the whole section.
 *
 *   node scripts/client-smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/* ------------------------------- React shim ------------------------------- */

const hookQueues = new Map()
let renderKey = ''
let hookIndex = 0
const pendingEffects = []

function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
  return { type, props: { ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat } }
}

function useState(initial) {
  const key = `${renderKey}#${hookIndex++}`
  if (hookQueues.has(key) === false) hookQueues.set(key, typeof initial === 'function' ? initial() : initial)
  const value = hookQueues.get(key)
  const setValue = (next) => {
    hookQueues.set(key, typeof next === 'function' ? next(hookQueues.get(key)) : next)
  }
  return [value, setValue]
}

function useEffect(effect) {
  hookIndex += 1
  pendingEffects.push(effect)
}

const React = {
  createElement,
  useState,
  useEffect,
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useRef: value => ({ current: value }),
}

/* ------------------------------ loader shim ------------------------------- */

let plugin
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      const requireShim = name => {
        if (name === 'react') return React
        throw new Error(`unexpected module: ${name}`)
      }
      plugin = { id, ...factory(requireShim) }
    },
  },
}
// The bundle registers itself on assignment to globalThis.window.
await import(`file://${join(here, '..', 'client.js')}?smoke=${Date.now()}`)

/* ------------------------------ render helper ----------------------------- */

/** Render a component tree, calling function components and collecting handlers. */
function render(element, key = 'root') {
  renderKey = key
  hookIndex = 0
  return walk(element, key)
}

function walk(element, key) {
  if (element === null || element === undefined || typeof element === 'boolean') return element
  if (typeof element === 'string' || typeof element === 'number') return element
  if (Array.isArray(element)) return element.map((child, index) => walk(child, `${key}.${index}`))
  if (typeof element.type === 'function') {
    const props = { ...element.props }
    if (props.children === undefined) delete props.children
    return walk(element.type(props), `${key}<${element.type.name || 'anonymous'}>`)
  }
  const props = { ...element.props }
  if (props.children !== undefined) props.children = walk(props.children, `${key}.children`)
  return { type: element.type, props }
}

/** Depth-first find of every element (including strings) matching a predicate. */
function findAll(element, predicate, out = []) {
  if (element === null || element === undefined || element === false) return out
  if (Array.isArray(element)) {
    for (const child of element) findAll(child, predicate, out)
    return out
  }
  if (typeof element !== 'object') {
    if (predicate(element)) out.push(element)
    return out
  }
  if (predicate(element)) out.push(element)
  findAll(element.props?.children, predicate, out)
  return out
}

/** Let pending promises and macrotasks settle (the page's effects are async). */
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

/** Run queued effects, then let their async bodies finish and re-settle. */
async function flushEffects() {
  for (let round = 0; round < 4; round += 1) {
    const batch = pendingEffects.splice(0)
    if (batch.length === 0) break
    for (const effect of batch) await effect()
    await settle()
  }
  await settle()
}

const textOf = element => findAll(element, node => typeof node === 'string').join(' ')

/** Render, let effects settle, and re-render until the state stops changing. */
async function mount(component, props) {
  let tree = render(component(props))
  for (let round = 0; round < 3; round += 1) {
    await flushEffects()
    tree = render(component(props))
  }
  return tree
}

/* -------------------------------- fixtures -------------------------------- */

const PROVIDERS = [
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    domains: ['gmail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    auth: 'app-password',
    hint: { en: 'app password needed', zh: '需要应用专用密码' },
  },
  {
    id: 'custom',
    label: '自定义',
    domains: [],
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    auth: 'password',
    hint: { en: 'custom server', zh: '自建服务器' },
  },
]

const ACCOUNT = {
  id: 'acc-1a2b3c4d',
  provider: 'custom',
  providerLabel: '自定义',
  email: 'kali@example.com',
  label: 'Mock',
  imap: { host: '127.0.0.1', port: 41153, secure: false },
  smtp: { host: '127.0.0.1', port: 36151, secure: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  lastTest: { at: '2026-01-01T00:00:00.000Z', ok: true },
  default: true,
  hasPassword: true,
}

const calls = []
let listCalls = 0
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  calls.push({ url, body })
  const reply = (() => {
    if (body.op === 'catalog') return { ok: true, providers: PROVIDERS }
    if (body.op === 'list') return { ok: true, accounts: listCalls++ === 0 ? [] : [ACCOUNT] }
    if (body.op === 'add') {
      return {
        ok: true,
        account: ACCOUNT,
        accounts: [ACCOUNT],
        report: { imap: { ok: true, ms: 5, mailboxes: 3 }, smtp: { ok: true, ms: 4 } },
        warnings: [],
      }
    }
    return { ok: true }
  })()
  return { ok: true, json: async () => reply }
}
globalThis.location = { origin: 'http://127.0.0.1:3080' }

/* ---------------------------------- run ---------------------------------- */

let failures = 0
const check = async (name, body) => {
  try {
    await body()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message.split('\n').slice(0, 3).join(' ' ) : String(error)}`)
  }
}

const registered = []
const ctx = {
  locale: { getSnapshot: () => ({ active: 'zh' }), subscribe: () => () => {} },
  slots: {
    inject(key, callback) { registered.push(key); return callback() },
    register(options, component) { registered.push({ ...options, component }); return () => {} },
  },
  effect(fn) { return fn() },
}

console.log('dsh-email client smoke test')

await check('bundle registers a plugin with apply()', () => {
  assert.equal(plugin.id, 'dsh-email')
  assert.equal(typeof plugin.apply, 'function')
})

await check('declares every service it reads (Cordis throws on undeclared access)', () => {
  // Regression: reading ctx.locale without injecting it throws
  // 'cannot get property "locale" without inject' and blanked the page.
  assert.ok(Array.isArray(plugin.inject), 'inject must be an array')
  assert.ok(plugin.inject.includes('slots'), 'slots must be injected')
  assert.ok(plugin.inject.includes('locale'), 'locale is read by the page, so it must be injected')
})

await check('apply registers the settings.section page', () => {
  plugin.apply(ctx)
  assert.ok(registered.includes('settings.section'))
  const entry = registered.find(item => typeof item === 'object')
  assert.equal(entry.name, 'settings.section')
  assert.equal(entry.id, 'dsh-email')
  assert.equal(typeof entry.label, 'function')
  assert.equal(entry.label(), '邮件')
})

const entry = registered.find(item => typeof item === 'object')
const props = { close: () => {}, ctx }

await check('empty state renders without throwing and calls the API', async () => {
  const tree = await mount(entry.component, props)
  assert.ok(calls.some(call => call.body.op === 'catalog'))
  assert.ok(calls.some(call => call.body.op === 'list'))
  const text = textOf(tree)
  assert.match(text, /邮件账号/)
  assert.match(text, /添加邮箱账号/)
})

await check('loaded state renders the account card with endpoint details', async () => {
  const tree = await mount(entry.component, props)
  const text = textOf(tree)
  assert.match(text, /kali@example\.com/)
  assert.match(text, /IMAP 127\.0\.0\.1:41153/)
  assert.match(text, /默认/)
})

await check('add-account form opens, shows the provider hint, and submits', async () => {
  let tree = await mount(entry.component, props)
  const addButton = findAll(tree, node => node.props?.onClick !== undefined && textOf(node).includes('添加邮箱账号'))[0]
  assert.ok(addButton, 'add-account button missing')
  addButton.props.onClick()
  tree = await mount(entry.component, props)
  const text = textOf(tree)
  assert.match(text, /服务商/)
  assert.match(text, /需要应用专用密码/)
  const form = findAll(tree, node => node.type === 'form')[0]
  assert.ok(form, 'form missing')
  await form.props.onSubmit({ preventDefault() {} })
  const add = calls.find(call => call.body.op === 'add')
  assert.ok(add, 'submit did not call the add op')
  assert.equal(add.body.provider, 'gmail')
  assert.equal(add.body.imap.port, 993)
})

await check('failed login surfaces an error instead of crashing', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: false, error: 'IMAP 登录失败: Invalid credentials', code: 'IMAP_LOGIN_FAILED' }),
  })
  let tree = await mount(entry.component, props)
  const addButton = findAll(tree, node => node.props?.onClick !== undefined && textOf(node).includes('添加邮箱账号'))[0]
  addButton.props.onClick()
  tree = await mount(entry.component, props)
  const form = findAll(tree, node => node.type === 'form')[0]
  await form.props.onSubmit({ preventDefault() {} })
  tree = await mount(entry.component, props)
  const text = textOf(tree)
  assert.match(text, /登录失败/)
  assert.match(text, /Invalid credentials/)
  globalThis.fetch = original
})

await check('renders even when a service getter throws (defensive locale read)', async () => {
  const hostile = {
    slots: ctx.slots,
    effect: ctx.effect,
    // A Cordis client context throws for a service the plugin did not inject.
    get locale() { throw new Error('cannot get property "locale" without inject') },
  }
  const tree = await mount(entry.component, { close: () => {}, ctx: hostile })
  assert.match(textOf(tree), /邮件账号/)
})

console.log(failures === 0 ? '\nall client checks passed' : `\n${failures} client check(s) failed`)
if (failures > 0) process.exitCode = 1
