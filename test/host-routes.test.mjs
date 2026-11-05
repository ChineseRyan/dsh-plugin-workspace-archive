/**
 * 宿主半侧 · 路由形状测试。
 *
 * 用假的 ctx + 自写的 req/res stub 驱动 apply(ctx)，不起 HTTP 服务、不占端口。
 * res 至少实现 writeHead / end，并按源码的调用方式记录状态码、响应头与响应体。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, name } = await import('../lib/index.js')

const TMP_ROOT = await mkdtemp(join(tmpdir(), 'dsh-wsa-route-'))
const PREFIX = '/dsh-workspace-archive'
let seq = 0

/** 让 apply 用一份全新的 $DSH_HOME（apply 里才解析 statePath）。 */
async function useFreshHome(label) {
  const home = join(TMP_ROOT, String(++seq).padStart(2, '0') + '-' + label)
  await mkdir(home, { recursive: true })
  process.env.DSH_HOME = home
  return home
}

/* ---------------- 假 ctx ---------------- */
function makeCtx() {
  const meta = { registrations: [], effectLabels: [], disposers: [], effects: [] }
  const ctx = {
    effect(fn, label) {
      meta.effectLabels.push(label)
      const dispose = fn()
      const off = () => { if (typeof dispose === 'function') { meta.disposers.push(label); dispose() } }
      meta.effects.push(off)
      return off
    },
    webServer: {
      register(options) {
        meta.registrations.push(options)
        assert.equal(options.kind, 'prefix', '必须以 prefix 路由注册')
        return () => { meta.registrations = meta.registrations.filter((o) => o !== options) }
      },
    },
  }
  return { ctx, meta }
}

/* ---------------- req / res stub ---------------- */
function makeReq(method, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroyed = false
  req.destroy = () => { req.destroyed = true }
  return req
}

function makeRes() {
  const res = new EventEmitter()
  res.statusCode = 0
  res.headers = null
  res.bodyText = ''
  res.writableEnded = false
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers || {}; return res }
  res.ended = new Promise((resolve) => { res._resolveEnd = resolve })
  res.end = (chunk) => {
    if (chunk !== undefined) res.bodyText += String(chunk)
    res.writableEnded = true
    res._resolveEnd()
    return res
  }
  res.json = () => JSON.parse(res.bodyText)
  return res
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

async function call(meta, method, path, body) {
  const routes = meta.registrations.slice()
  assert.equal(routes.length, 1, '应当恰有一个 prefix 路由')
  const handler = routes[0].handler
  assert.equal(typeof handler, 'function')
  const req = makeReq(method, PREFIX + path)
  const res = makeRes()
  // 源码里的 handler 是 fire-and-forget（内部 Promise.resolve(handle(req,res)).catch(...)），
  // 不返回 Promise，所以这里等 res.end 而不是等返回值。
  handler(req, res)
  if (body !== undefined) {
    await flush()
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    req.emit('data', Buffer.from(text, 'utf8'))
    req.emit('end')
  }
  await withTimeout(res.ended, 5000, 'res.end 超时未调用：' + method + ' ' + path)
  await flush()
  assert.equal(res.writableEnded, true, 'res.end 必须被调用')
  let json = null
  try { json = res.json() } catch (_) { json = null }
  return { status: res.statusCode, headers: res.headers, json, raw: res.bodyText, req, res }
}

/* ========================= ⑤ 路由形状 ========================= */
test('5a 路由：apply 以 prefix 注册 /dsh-workspace-archive，卸载时可摘除', async () => {
  await useFreshHome('route-register')
  const { ctx, meta } = makeCtx()
  apply(ctx)
  assert.equal(meta.registrations.length, 1)
  const route = meta.registrations[0]
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, PREFIX)
  assert.equal(typeof route.handler, 'function')
  assert.ok(meta.effectLabels.indexOf('workspace-archive: route') > -1, '路由必须挂在 ctx.effect 上')
  // 卸载：路由 effect 的 disposer 必须把注册摘掉（register 返回的 disposer 被调用）
  assert.equal(meta.effects.length, 1, '宿主侧只应有一个 effect（路由）')
  meta.effects[0]()
  assert.equal(meta.registrations.length, 0, '卸载后路由必须被摘除')
})

test('5b GET /state：返回 {ok:true, archives, prefs}，JSON 头齐全', async () => {
  const home = await useFreshHome('route-state')
  const { ctx, meta } = makeCtx()
  apply(ctx)
  const r = await call(meta, 'GET', '/state')
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(r.headers['content-length'], Buffer.byteLength(r.raw))
  assert.deepEqual(r.json, { ok: true, archives: {}, prefs: { badgeMode: 'always', acked: true } })
})

test('5c POST /archive：返回 {ok:true, record} 并真正落盘；重复归档合并会话', async () => {
  const home = await useFreshHome('route-archive')
  const { ctx, meta } = makeCtx()
  apply(ctx)

  const first = await call(meta, 'POST', '/archive', { workspaceId: 'ws-1', sessionIds: ['s1', 's2'] })
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.record.workspaceId, 'ws-1')
  assert.deepEqual(first.json.record.sessionIds, ['s1', 's2'])
  assert.equal(typeof first.json.record.archivedAt, 'number')

  const second = await call(meta, 'POST', '/archive', { workspaceId: 'ws-1', sessionIds: ['s2', 's3'] })
  assert.deepEqual(second.json.record.sessionIds, ['s1', 's2', 's3'], '同工作区归档应合并去重')

  const state = JSON.parse(await readFile(join(home, 'storages', 'dsh-workspace-archive.json'), 'utf8'))
  assert.equal(state.version, 1)
  assert.deepEqual(state.archives['ws-1'].sessionIds, ['s1', 's2', 's3'])

  const listed = await call(meta, 'GET', '/state')
  assert.deepEqual(listed.json.archives['ws-1'].sessionIds, ['s1', 's2', 's3'])
})

test('5d POST /unarchive：返回 {ok:true}，未知 id 同样 200', async () => {
  const home = await useFreshHome('route-unarchive')
  const { ctx, meta } = makeCtx()
  apply(ctx)
  await call(meta, 'POST', '/archive', { workspaceId: 'ws-1', sessionIds: ['s1'] })

  const removed = await call(meta, 'POST', '/unarchive', { workspaceId: 'ws-1' })
  assert.equal(removed.status, 200)
  assert.deepEqual(removed.json, { ok: true })

  const state = JSON.parse(await readFile(join(home, 'storages', 'dsh-workspace-archive.json'), 'utf8'))
  assert.deepEqual(Object.keys(state.archives), [])

  const again = await call(meta, 'POST', '/unarchive', { workspaceId: 'ws-1' })
  assert.equal(again.status, 200)
  assert.deepEqual(again.json, { ok: true })
})

test('5e 未知路径：404 且响应体带 prefix', async () => {
  await useFreshHome('route-404')
  const { ctx, meta } = makeCtx()
  apply(ctx)
  for (const path of ['/nope', '/state/extra', '/']) {
    const r = await call(meta, 'GET', path)
    assert.equal(r.status, 404, path)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.error, 'not found')
    assert.equal(r.json.prefix, PREFIX, '404 必须带 prefix：' + path)
  }
  // 方法不匹配也走 404（GET /archive、POST /state）
  assert.equal((await call(meta, 'GET', '/archive')).status, 404)
  assert.equal((await call(meta, 'POST', '/state', { workspaceId: 'w' })).status, 404)
})

test('5f GET /ping：返回 {ok:true, plugin, pong:true}（隔离实例自检用）', async () => {
  await useFreshHome('route-ping')
  const { ctx, meta } = makeCtx()
  apply(ctx)
  const r = await call(meta, 'GET', '/ping')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, plugin: name, pong: true })
})

test('5g 入参校验：非法 workspaceId 400 / 非法 sessionIds 500 / 非对象、非 JSON、超大体积 400', async () => {
  await useFreshHome('route-bad-input')
  const { ctx, meta } = makeCtx()
  apply(ctx)

  const badIds = ['../evil', '', 'constructor', 'x'.repeat(513)]
  for (const workspaceId of badIds) {
    const r = await call(meta, 'POST', '/archive', { workspaceId, sessionIds: [] })
    assert.equal(r.status, 400, '非法 workspaceId：' + workspaceId)
    assert.equal(r.json.ok, false)
    assert.equal(r.json.error, '无效的工作区标识')
  }

  // 注意：源码里 assertWorkspaceId 在 try 之外（→400），assertSessionIds 在 try 之内（→500）。
  // 这里按源码实际行为断言，不按"理想设计"断言。
  const badSessions = [['s1', 2], 'not-an-array', ['']]
  for (const sessionIds of badSessions) {
    const r = await call(meta, 'POST', '/archive', { workspaceId: 'ws-ok', sessionIds })
    assert.equal(r.status, 500, '非法 sessionIds 走内层 catch：' + JSON.stringify(sessionIds))
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /会话标识|sessionIds/, '错误信息要说清是会话 id 的问题')
  }
  // unarchive 只校验 workspaceId
  const unarchiveBad = await call(meta, 'POST', '/unarchive', { workspaceId: '../evil' })
  assert.equal(unarchiveBad.status, 400)
  assert.equal(unarchiveBad.json.ok, false)

  const notObject = await call(meta, 'POST', '/archive', '[1,2,3]')
  assert.equal(notObject.status, 400)
  assert.equal(notObject.json.error, '请求体必须是对象')

  const badJson = await call(meta, 'POST', '/archive', '{oops')
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json.ok, false)

  // 请求体超过 MAX_BODY_BYTES(64KiB) 被拒，且请求被 destroy
  const huge = JSON.stringify({ workspaceId: 'ws', pad: 'x'.repeat(70 * 1024) })
  const tooBig = await call(meta, 'POST', '/archive', huge)
  assert.equal(tooBig.status, 400)
  assert.equal(tooBig.json.error, '请求体过大')
  assert.equal(tooBig.req.destroyed, true, '超限时必须 req.destroy()')
})

test('5h 坏 URL：直接 400，不抛到外层', async () => {
  await useFreshHome('route-badurl')
  const { ctx, meta } = makeCtx()
  apply(ctx)
  const handler = meta.registrations[0].handler
  const req = makeReq('GET', 'http://[::1') // new URL 会抛
  const res = makeRes()
  await handler(req, res)
  await flush()
  assert.equal(res.statusCode, 400)
  assert.deepEqual(JSON.parse(res.bodyText), { ok: false, error: 'bad url' })
})

test('5i GET /state：状态文件损坏 → 500 {ok:false}（不吞错、不回落空账本）', async () => {
  const home = await useFreshHome('route-corrupt')
  await mkdir(join(home, 'storages'), { recursive: true })
  const target = join(home, 'storages', 'dsh-workspace-archive.json')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(target, '{"version":99,"archives":{}}', 'utf8')
  assert.equal((await lstat(target)).isFile(), true)

  const { ctx, meta } = makeCtx()
  apply(ctx)
  const r = await call(meta, 'GET', '/state')
  assert.equal(r.status, 500)
  assert.equal(r.json.ok, false)
  assert.match(r.json.error, /损坏/)

  const write = await call(meta, 'POST', '/archive', { workspaceId: 'ws-1', sessionIds: [] })
  assert.equal(write.status, 500)
  assert.equal(write.json.ok, false)
})


/* ========================= ⑥ 角标偏好持久化（0.1.6） ========================= */
test('6a POST /prefs：写入宿主状态文件，GET /state 能读回（重启后可恢复）', async () => {
  const home = await useFreshHome('route-prefs')
  const { ctx, meta } = makeCtx()
  apply(ctx)

  const empty = await call(meta, 'GET', '/state')
  assert.deepEqual(empty.json.prefs, { badgeMode: 'always', acked: true }, '缺省偏好')

  const write = await call(meta, 'POST', '/prefs', { badgeMode: 'never', acked: false })
  assert.equal(write.status, 200)
  assert.deepEqual(write.json, { ok: true, prefs: { badgeMode: 'never', acked: false } })

  const state = JSON.parse(await readFile(join(home, 'storages', 'dsh-workspace-archive.json'), 'utf8'))
  assert.deepEqual(state.prefs, { badgeMode: 'never', acked: false }, '偏好必须真的落盘')

  // 模拟「重启宿主」：对同一份 $DSH_HOME 新建一个 apply，读到的偏好不丢。
  const { ctx: ctx2, meta: meta2 } = makeCtx()
  apply(ctx2)
  const after = await call(meta2, 'GET', '/state')
  assert.deepEqual(after.json.prefs, { badgeMode: 'never', acked: false }, '重启后偏好必须保留')
})

test('6b /prefs 校验：非法档位回落默认，坏 acked 回落默认，非对象 400', async () => {
  const home = await useFreshHome('route-prefs-bad')
  const { ctx, meta } = makeCtx()
  apply(ctx)

  const cases = [
    { body: { badgeMode: 'bogus', acked: true }, expect: { badgeMode: 'always', acked: true } },
    { body: { badgeMode: 'new', acked: 'yes' }, expect: { badgeMode: 'new', acked: true } },
    { body: {}, expect: { badgeMode: 'always', acked: true } },
  ]
  for (const c of cases) {
    const r = await call(meta, 'POST', '/prefs', c.body)
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.prefs, c.expect, JSON.stringify(c.body))
  }
  const notObject = await call(meta, 'POST', '/prefs', '[1,2]')
  assert.equal(notObject.status, 400)
  assert.equal(notObject.json.error, '请求体必须是对象')

  // 偏好写入不得污染归档账本
  const after = await call(meta, 'GET', '/state')
  assert.deepEqual(after.json.archives, {})
})

test('6c /prefs 与 /archive 共存：改偏好不删账本，改账本不丢偏好', async () => {
  const home = await useFreshHome('route-prefs-coexist')
  const { ctx, meta } = makeCtx()
  apply(ctx)
  await call(meta, 'POST', '/archive', { workspaceId: 'ws-1', sessionIds: ['s1'] })
  await call(meta, 'POST', '/prefs', { badgeMode: 'new', acked: false })
  const r = await call(meta, 'GET', '/state')
  assert.deepEqual(r.json.archives['ws-1'].sessionIds, ['s1'])
  assert.deepEqual(r.json.prefs, { badgeMode: 'new', acked: false })
})

