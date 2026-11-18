/**
 * 浏览器半侧 · 官方菜单贡献接口测试（0.1.8 / dsh 0.2.2-rc.2+）。
 *
 * 与 client-semantics.test.mjs 的「读源码断言」不同，这里真的把 client bundle
 * 加载起来：伪造 window.__ModuleLoader__ 拿到 factory，再用假 ctx 跑 apply，
 * 断言注册到 ctx.contextMenus 的菜单项形状与 resolve 行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'


const SRC = new URL('../client/client.js', import.meta.url)

/** 加载 bundle，返回其 module.exports（{ apply, inject, name }）。 */
async function loadBundle() {
  let factory = null
  const memory = new Map()
  globalThis.window = {
    __ModuleLoader__: { load: (input) => { factory = input.factory } },
    localStorage: {
      getItem: (k) => (memory.has(k) ? memory.get(k) : null),
      setItem: (k, v) => { memory.set(k, String(v)) },
      removeItem: (k) => { memory.delete(k) },
    },
  }
  await import(SRC.href + '?v=' + Date.now())
  assert.equal(typeof factory, 'function', 'bundle 必须调用 window.__ModuleLoader__.load')
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
  return factory((id) => {
    if (id === 'react') return react
    throw new Error('unexpected require: ' + id)
  })
}

/** 只实现客户端用到的服务；contextMenus 的记录表由测试自己持有。 */
function makeCtx() {
  const registrations = []
  const notifies = []
  const menus = {
    register: (input) => { registrations.push(input); return () => {} },
    notify: (text, ok) => { notifies.push({ text, ok }) },
  }
  const workspaces = {
    list: {
      getSnapshot: () => ({ items: [], archivedSessionIds: [] }),
      subscribe: () => () => {},
    },
  }
  const sessions = { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } }
  const uiWorkspace = {
    archiveSession: async () => {},
    unarchiveSession: async () => {},
  }
  const locale = {
    register: () => () => {},
    bind: () => (key) => key,
    getLocale: () => ({ id: 'zh' }),
  }
  const ctx = {
    contextMenus: menus,
    locale,
    workspaces,
    sessions,
    uiWorkspace,
    effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {} },
    inject(_deps, callback) { callback(ctx) },
    get(name) {
      if (name === 'contextMenus') return menus
      if (name === 'workspaces') return workspaces
      if (name === 'sessions') return sessions
      if (name === 'uiWorkspace') return uiWorkspace
      if (name === 'locale') return locale
      if (name === 'slots') return { inject: () => () => {}, register: () => () => {} }
      return null
    },
  }
  return { ctx, registrations, notifies }
}

test('11a 菜单注册：target=workspace、稳定 id、提供 observe 与 resolve', async () => {
  const bundle = await loadBundle()
  const { ctx, registrations } = makeCtx()
  bundle.apply(ctx)
  assert.equal(registrations.length, 1, '只注册一条菜单贡献')
  const reg = registrations[0]
  assert.equal(reg.target, 'workspace')
  assert.equal(reg.id, bundle.name + '.workspace')
  assert.equal(typeof reg.resolve, 'function')
  assert.equal(typeof reg.observe, 'function')
  assert.equal(typeof reg.order, 'number')
})

test('11b observe 返回可订阅源，快照带 items/busy', async () => {
  const bundle = await loadBundle()
  const { ctx, registrations } = makeCtx()
  bundle.apply(ctx)
  const sources = registrations[0].observe({ workspaceId: 'w1' })
  assert.equal(Array.isArray(sources), true)
  const source = sources[0]
  const snap = source.getSnapshot()
  assert.equal(Array.isArray(snap.items), true)
  assert.equal(Array.isArray(snap.busy), true)
  assert.equal(typeof source.subscribe(() => {}), 'function')
})

test('11c resolve：未归档工作区给一条「归档工作区」，取不到 id 时为空', async () => {
  const bundle = await loadBundle()
  const { ctx, registrations } = makeCtx()
  bundle.apply(ctx)
  const resolve = registrations[0].resolve
  assert.deepEqual(resolve({}), [])
  assert.deepEqual(resolve(undefined), [])
  const actions = resolve({ workspaceId: 'w1', path: '/tmp/w1', displayTitle: 'w1' })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].id, 'archive')
  assert.equal(actions[0].label, '归档工作区')
  assert.equal(actions[0].disabled, false)
  assert.deepEqual(actions[0].icon, { key: 'workspace.archive' }, '菜单项带官方归档图标')
  assert.equal(typeof actions[0].failureLabel, 'string')
  assert.equal(typeof actions[0].run, 'function')
})

test('11d run：归档失败用官方 toast 报告，不抛错', async () => {
  const bundle = await loadBundle()
  const { ctx, registrations, notifies } = makeCtx()
  bundle.apply(ctx)
  const action = registrations[0].resolve({ workspaceId: 'missing' })[0]
  await action.run()
  assert.equal(notifies.length, 1)
  assert.equal(notifies[0].ok, false)
  assert.equal(notifies[0].text, '归档失败，请重试')
})

test('11e 旧版 dsh（无 contextMenus）不注册菜单、不抛错', async () => {
  const bundle = await loadBundle()
  const { ctx, registrations } = makeCtx()
  delete ctx.contextMenus
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'contextMenus' ? null : originalGet(name))
  assert.doesNotThrow(() => bundle.apply(ctx))
  assert.equal(registrations.length, 0)
})
