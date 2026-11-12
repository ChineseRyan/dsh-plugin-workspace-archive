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

const { apply, name, __test } = await import('../lib/index.js')
const { CLEANUP_PROBE_TIMEOUT_MS } = __test

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
  // 0.1.7 起宿主侧还有两处只读 effect（worktree/cleanup 订阅与缓存清理），
  // 所以这里按 label 定位路由 effect，不再假设它恰好是第 0 个。
  const routeIndex = meta.effectLabels.indexOf('workspace-archive: route')
  assert.equal(meta.effects.length, meta.effectLabels.length, '每个 effect 都要有对应 disposer')
  // 卸载：路由 effect 的 disposer 必须把注册摘掉（register 返回的 disposer 被调用）
  meta.effects[routeIndex]()
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

/* ================= ⑤' 工作树清理结果只读查询（0.2.2-rc.2 适配） ================= */

/** 带 on/get 的最小 ctx：用于驱动 worktree/cleanup 订阅与 cleanupOf 查询。 */
function makeCleanupCtx(options = {}) {
  const { ctx, meta } = makeCtx()
  const listeners = new Map()
  const services = new Map(Object.entries(options.services || {}))
  ctx.on = (event, listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(listener)
    return () => { listeners.get(event)?.delete(listener) }
  }
  ctx.get = (serviceName) => services.get(serviceName)
  const emit = (event, payload) => { for (const fn of [...(listeners.get(event) || [])]) fn(payload) }
  const setService = (serviceName, value) => services.set(serviceName, value)
  return { ctx, meta, emit, setService }
}

test('5h GET /cleanup：无 worktree 服务时 supported=false，且不报错', async () => {
  await useFreshHome('cleanup-unsupported')
  const { ctx, meta } = makeCleanupCtx()
  apply(ctx)
  const r = await call(meta, 'GET', '/cleanup?sessionIds=s1,s2')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.cleanup.supported, false, '本机未挂 worktree 服务时应如实降级')
  assert.deepEqual(r.json.cleanup.sessions, [])
  assert.equal(r.json.cleanup.removed, 0)
})

test('5i GET /cleanup：worktree/cleanup 事件按会话聚合，scheduled→removed 覆盖同一 revision', async () => {
  await useFreshHome('cleanup-events')
  const { ctx, meta, emit } = makeCleanupCtx()
  apply(ctx)

  emit('worktree/cleanup', { sessionId: 's1', path: '/secret/path', cleanup: { revision: 7, status: 'scheduled' } })
  emit('worktree/cleanup', { sessionId: 's1', path: '/secret/path', cleanup: { revision: 7, status: 'removed' } })
  emit('worktree/cleanup', { sessionId: 's2', path: '/other', cleanup: { revision: 8, status: 'retained' } })
  // 乱序到达的旧 revision 必须被丢弃
  emit('worktree/cleanup', { sessionId: 's2', path: '/other', cleanup: { revision: 3, status: 'removed' } })
  // 形状异常的事件必须被忽略而不是炸掉
  emit('worktree/cleanup', { sessionId: 's3', cleanup: { revision: 9, status: 'bogus' } })
  emit('worktree/cleanup', { sessionId: '../evil', cleanup: { revision: 1, status: 'removed' } })
  emit('worktree/cleanup', null)

  const r = await call(meta, 'GET', '/cleanup?sessionIds=s1,s2,s3')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.cleanup.sessions, [
    { sessionId: 's1', revision: 7, status: 'removed' },
    { sessionId: 's2', revision: 8, status: 'retained' },
  ], '同一会话保留最新 revision；非法 status / 非法 id / null 全部丢弃')
  assert.equal(r.json.cleanup.removed, 1)
  assert.equal(r.json.cleanup.retained, 1)
  assert.equal(r.json.cleanup.supported, false, '本用例没挂服务，仍应报 supported=false')
  assert.ok(!r.raw.includes('/secret/path'), '/cleanup 绝不能回显任何文件系统路径')
})

test('5j GET /cleanup：有 worktree 服务时用 cleanupOf 补实时状态，服务抛错则回落事件缓存', async () => {
  await useFreshHome('cleanup-live')
  const { ctx, meta, emit, setService } = makeCleanupCtx()
  const calls = []
  setService('worktrees', {
    async cleanupOf(session, revision) {
      calls.push({ id: session?.id, revision })
      if (session?.id === 'boom') throw new Error('service exploded')
      if (session?.id === 's-live') return { revision: 2, status: 'removed' }
      return null
    },
  })
  setService('sessions', { get: (id) => (id === 's-live' ? { id, kind: 'live-session' } : undefined) })
  apply(ctx)

  emit('worktree/cleanup', { sessionId: 'boom', cleanup: { revision: 5, status: 'retained' } })

  const r = await call(meta, 'GET', '/cleanup?sessionIds=s-live,boom,s-none')
  assert.equal(r.status, 200)
  assert.equal(r.json.cleanup.supported, true)
  assert.deepEqual(r.json.cleanup.sessions, [
    { sessionId: 's-live', revision: 2, status: 'removed' },
    { sessionId: 'boom', revision: 5, status: 'retained' },
  ])
  // 活会话传对象本身，冷会话至少要能拿到 id
  assert.deepEqual(calls.map((c) => c.id).sort(), ['boom', 's-live', 's-none'])
  assert.deepEqual(calls.map((c) => c.revision), [null, null, null], '只读探测必须用 revision=null，绝不触发清理')
})

test('5n GET /cleanup：cleanupOf 返回越界状态/非法 revision 时回落事件缓存', async () => {
  await useFreshHome('cleanup-invalid-state')
  const { ctx, meta, emit, setService } = makeCleanupCtx()
  setService('worktrees', {
    async cleanupOf(session) {
      if (session?.id === 's-bad-status') return { revision: 1, status: 'CHMOD777' }
      if (session?.id === 's-bad-rev') return { revision: 1.5, status: 'removed' }
      if (session?.id === 's-neg-rev') return { revision: -2, status: 'removed' }
      return { revision: 9, status: 'retained' }
    },
  })
  apply(ctx)
  emit('worktree/cleanup', { sessionId: 's-bad-status', cleanup: { revision: 4, status: 'removed' } })

  const r = await call(meta, 'GET', '/cleanup?sessionIds=s-bad-status,s-bad-rev,s-neg-rev,s-ok')
  assert.equal(r.status, 200)
  // 越界/非法的 cleanupOf 结果必须被丢弃，绝不按脏数据写进汇总
  assert.deepEqual(r.json.cleanup.sessions, [
    { sessionId: 's-bad-status', revision: 4, status: 'removed' },
    { sessionId: 's-ok', revision: 9, status: 'retained' },
  ])
  assert.equal(r.json.cleanup.removed, 1)
  assert.equal(r.json.cleanup.retained, 1)
})

test('5o GET /cleanup：cleanupOf 迟迟不返回时超时回落缓存，且不留下悬挂定时器', async () => {
  await useFreshHome('cleanup-timeout')
  const { ctx, meta, emit, setService } = makeCleanupCtx()
  // 永不 resolve：模拟官方服务卡住（比如冷会话热起来很慢）。
  setService('worktrees', { cleanupOf: () => new Promise(() => {}) })
  apply(ctx)
  emit('worktree/cleanup', { sessionId: 's-stuck', cleanup: { revision: 3, status: 'scheduled' } })

  const started = Date.now()
  const r = await withTimeout(
    call(meta, 'GET', '/cleanup?sessionIds=s-stuck'),
    CLEANUP_PROBE_TIMEOUT_MS + 3000,
    '/cleanup 必须在探测超时后仍返回，不能把请求挂死',
  )
  const elapsed = Date.now() - started
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.cleanup.sessions, [{ sessionId: 's-stuck', revision: 3, status: 'scheduled' }],
    '超时后必须回落到事件缓存，而不是丢掉这条')
  assert.ok(elapsed < CLEANUP_PROBE_TIMEOUT_MS + 2000, '必须在探测上限附近返回，实际 ' + elapsed + 'ms')
})

test('5q GET /cleanup：cleanupOf 明确返回 null 时丢弃旧缓存，不把上一轮数字当成结论', async () => {
  await useFreshHome('cleanup-stale-cache')
  const { ctx, meta, emit, setService } = makeCleanupCtx()
  // 模拟「归档 → 取消归档」之后：官方把 attempt 删了，cleanupOf 返回 null。
  setService('worktrees', { cleanupOf: async () => null })
  apply(ctx)
  // 上一轮确实清理过 1 个，事件缓存里还留着。
  emit('worktree/cleanup', { sessionId: 's-cycle', cleanup: { revision: 5, status: 'removed' } })

  const r = await call(meta, 'GET', '/cleanup?sessionIds=s-cycle')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.cleanup.sessions, [], '官方说没有清理尝试时，缓存必须作废')
  assert.equal(r.json.cleanup.removed, 0, '绝不能让上一轮的 removed 数字漏到这一轮')
})

test('5p GET /cleanup：sessions 服务缺失时仍能按 id 探测（冷会话降级）', async () => {
  await useFreshHome('cleanup-no-sessions')
  const { ctx, meta, setService } = makeCleanupCtx()
  const seen = []
  setService('worktrees', {
    async cleanupOf(session) {
      seen.push(session?.id)
      return session?.id === 's-cold' ? { revision: 6, status: 'removed' } : null
    },
  })
  // 故意不挂 sessions 服务
  apply(ctx)
  const r = await call(meta, 'GET', '/cleanup?sessionIds=s-cold')
  assert.equal(r.status, 200)
  assert.deepEqual(seen, ['s-cold'], '拿不到活会话时必须仍以 {id} 形式探测')
  assert.deepEqual(r.json.cleanup.sessions, [{ sessionId: 's-cold', revision: 6, status: 'removed' }])
})

test('5k GET /cleanup：入参校验（数量上限 / 非法 id / 空列表）', async () => {
  await useFreshHome('cleanup-validation')
  const { ctx, meta } = makeCleanupCtx()
  apply(ctx)

  const empty = await call(meta, 'GET', '/cleanup')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.cleanup.sessions, [])

  const tooMany = await call(meta, 'GET', '/cleanup?sessionIds=' + Array.from({ length: 51 }, (_, i) => 's' + i).join(','))
  assert.equal(tooMany.status, 400, '超过上限必须拒绝，别让只读查询面变成放大器')
  assert.equal(tooMany.json.ok, false)

  const bad = await call(meta, 'GET', '/cleanup?sessionIds=../evil')
  assert.equal(bad.status, 400)
  assert.equal(bad.json.ok, false)
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

test('5l 坏 URL：直接 400，不抛到外层', async () => {
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

test('5m GET /state：状态文件损坏 → 500 {ok:false}（不吞错、不回落空账本）', async () => {
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

