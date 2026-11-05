/**
 * dsh-plugin-workspace-archive — 宿主半侧（Node / Cordis）。
 *
 * 职责（只做两件半）：
 *   1. 持久化「已归档工作区」名单：workspaceId -> { archivedAt, sessionIds }。
 *      状态文件放在 $DSH_HOME/storages/dsh-workspace-archive.json，
 *      原子写（临时文件 + rename）+ 进程内串行队列，避免多窗口/热重载互相踩。
 *   2. 注册 /dsh-workspace-archive/* 三个 HTTP 端点给浏览器半侧：
 *        GET  /state             -> { ok, archives }
 *        POST /archive           -> { ok, record }   记录一次归档
 *        POST /unarchive         -> { ok }           清除一次归档
 *   3. 注册 /ping 供隔离实例自检。
 *
 * 刻意不做的事：
 *   - 不直接改 DSH 官方 workspace registry / 会话归档集合。会话归档由浏览器半侧
 *     调用官方 ctx.uiWorkspace.archiveSession 完成，这里只记一份「谁被本插件归档过、
 *     归档时顺带归档了哪些会话」的账，供恢复时使用。
 *   - 不读写任何凭据、不监听 0.0.0.0、不暴露任意路径。
 *
 * 依据：本机 @deepseek-ai/dsh 0.2.1-rc.2，ctx.webServer.register({kind:'prefix',...})
 * 返回 disposer，用 ctx.effect 包住即可在卸载/热重挂时自动摘除。
 */

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'

export const name = 'dsh-plugin-workspace-archive'

/** webServer 是唯一硬依赖；缺了本插件就不激活，而不是抛错。 */
export const inject = ['webServer']

const PREFIX = '/dsh-workspace-archive'
const STATE_VERSION = 1
const BADGE_MODES = new Set(['always', 'new', 'never'])
const MAX_BODY_BYTES = 64 * 1024
const MAX_RECORDS = 2000
const MAX_SESSION_IDS_PER_RECORD = 5000
const MAX_ID_LENGTH = 512
const MAX_STATE_FILE_BYTES = 1024 * 1024
/** 跨进程写锁：dsh web 与 Desktop 可能共享同一个 $DSH_HOME。 */
const LOCK_WAIT_MS = 3000
const LOCK_STALE_MS = 10000
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function emptyArchives() {
  return Object.create(null)
}

/** 稳定 id 校验：非空、限长、无 NUL/路径穿越、无原型链危险键、无控制字符。 */
function isId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && !value.includes('\0')
    && !value.includes('..')
    && !FORBIDDEN_KEYS.has(value)
    && !/[\x00-\x1f\x7f]/.test(value)
}

function assertWorkspaceId(value) {
  if (!isId(value)) throw Object.assign(new Error('无效的工作区标识'), { code: 'invalid-workspace-id' })
}

function assertSessionIds(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_SESSION_IDS_PER_RECORD) {
    throw Object.assign(new Error('sessionIds 必须是数组且长度受限'), { code: 'invalid-session-ids' })
  }
  const out = []
  for (const id of value) {
    if (!isId(id)) throw Object.assign(new Error('无效的会话标识'), { code: 'invalid-session-id' })
    out.push(String(id))
  }
  return [...new Set(out)]
}

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function statePath() {
  return join(resolveDshHome(), 'storages', 'dsh-workspace-archive.json')
}

/**
 * 原子写：同目录临时文件 + rename。
 * 用 lstat（不跟随符号链接）确认目录与状态文件都是普通文件，杜绝写到链接之外。
 * 写前校验序列化体积，避免超过读侧上限后把状态文件自己锁成 corrupt。
 */
async function writeAtomic(path, text) {
  if (Buffer.byteLength(text) > MAX_STATE_FILE_BYTES) {
    throw Object.assign(new Error('归档记录过多，状态文件超出上限'), { code: 'state-too-large' })
  }
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const dirInfo = await lstat(dir)
  if (!dirInfo.isDirectory()) throw new Error('状态目录不是普通目录')
  const temp = join(dir, `.dsh-workspace-archive.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, path)
}

/** 角标偏好：只接受白名单档位 + 布尔确认标记，其余一律回落默认。 */
function normalizePrefs(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  // 只认自有属性：外部 POST 的 JSON 不会带原型，但内部调用仍可能传入脏对象，
  // 用 Object.hasOwn 杜绝原型链上的 badgeMode / acked 被当成有效偏好。
  const has = (key) => Object.prototype.hasOwnProperty.call(source, key)
  return {
    badgeMode: has('badgeMode') && BADGE_MODES.has(source.badgeMode) ? source.badgeMode : 'always',
    acked: has('acked') && typeof source.acked === 'boolean' ? source.acked : true,
  }
}

async function readState(path) {
  let text
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw Object.assign(new Error('状态文件不是普通文件'), { code: 'state-corrupt' })
    if (info.size > MAX_STATE_FILE_BYTES) throw Object.assign(new Error('状态文件过大'), { code: 'state-corrupt' })
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { version: STATE_VERSION, archives: emptyArchives(), prefs: normalizePrefs(undefined) }
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    // 旧版状态文件没有 prefs 字段是允许的：下面用 normalizePrefs(undefined) 回落默认。
    if (!parsed || parsed.version !== STATE_VERSION || typeof parsed.archives !== 'object' || parsed.archives === null || Array.isArray(parsed.archives)) {
      throw new Error('schema')
    }
    const archives = emptyArchives()
    for (const [id, rec] of Object.entries(parsed.archives)) {
      if (!isId(id) || !rec || typeof rec !== 'object') continue
      archives[id] = {
        workspaceId: id,
        archivedAt: typeof rec.archivedAt === 'number' && Number.isFinite(rec.archivedAt) ? rec.archivedAt : Date.now(),
        sessionIds: assertSessionIds(Array.isArray(rec.sessionIds) ? rec.sessionIds : []),
      }
    }
    return { version: STATE_VERSION, archives, prefs: normalizePrefs(parsed.prefs) }
  } catch {
    throw Object.assign(new Error('工作区归档状态文件损坏，已停止写入'), { code: 'state-corrupt' })
  }
}

/**
 * 跨进程建议锁：同一 $DSH_HOME 下多个 Host 实例写同一文件时串行化，
 * 防止 readState -> write 之间被另一个进程覆盖（丢失更新）。
 * 锁文件带时间戳，超时视为崩溃残留并接管。
 */
async function withLock(path, operation) {
  const lockPath = path + '.lock'
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  let handle
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      try {
        const info = await lstat(lockPath)
        stale = Date.now() - info.mtimeMs > LOCK_STALE_MS
      } catch (_) { stale = true }
      if (stale) {
        try { await unlink(lockPath) } catch (_) {}
        continue
      }
      if (Date.now() >= deadline) throw Object.assign(new Error('归档状态正由其他进程写入，请稍后重试'), { code: 'state-busy' })
      await delay(25)
    }
  }
  try {
    await handle.writeFile(String(Date.now()), 'utf8')
    await handle.close()
    handle = null
    return await operation()
  } finally {
    if (handle) { try { await handle.close() } catch (_) {} }
    try { await unlink(lockPath) } catch (_) {}
  }
}

/**
 * 每份 Host 实例一份串行队列 + 跨进程文件锁。
 * 读只走队列（不取锁）；写操作在锁内只读一次状态再原子落盘，
 * 因此不会出现「两个写者各自基于旧状态覆盖对方」的丢失更新。
 */
function createStore(path) {
  let queue = Promise.resolve()
  const enqueue = (operation) => {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }
  const write = (state) => writeAtomic(path, JSON.stringify(state, null, 2) + '\n')
  const mutate = (mutator) => enqueue(() => withLock(path, async () => {
    const state = await readState(path)
    const outcome = mutator(state)
    if (outcome !== null) await write(state)
    return outcome
  }))
  return {
    list: () => enqueue(async () => {
      const state = await readState(path)
      return structuredClone(state.archives)
    }),
    getPrefs: () => enqueue(async () => {
      const state = await readState(path)
      return { ...state.prefs }
    }),
    setPrefs: (value) => mutate((state) => {
      state.prefs = normalizePrefs(value)
      return { ...state.prefs }
    }),
    archive: (workspaceId, sessionIds) => mutate((state) => {
      const prev = state.archives[workspaceId]
      if (!prev && Object.keys(state.archives).length >= MAX_RECORDS) {
        throw Object.assign(new Error('归档记录数量已达上限'), { code: 'too-many-records' })
      }
      const record = {
        workspaceId,
        archivedAt: Date.now(),
        sessionIds: prev ? [...new Set([...prev.sessionIds, ...sessionIds])] : sessionIds,
      }
      state.archives[workspaceId] = record
      return structuredClone(record)
    }),
    unarchive: (workspaceId) => mutate((state) => {
      const prev = state.archives[workspaceId] || null
      if (!prev) return null
      delete state.archives[workspaceId]
      return structuredClone(prev)
    }),
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { code: 'body-too-large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'invalid-json' }))
      }
    })
    req.on('error', reject)
  })
}

/** 热重载时旧模块实例可能仍持有同一 (kind,path) 路由；先释放它再注册。 */
const ROUTES_HOLDER = (() => {
  const key = Symbol.for('dsh-plugin-workspace-archive/route-disposers')
  if (globalThis[key] === undefined) globalThis[key] = { value: undefined }
  return globalThis[key]
})()

function disposeRoutes() {
  const dispose = ROUTES_HOLDER.value
  if (typeof dispose !== 'function') return
  ROUTES_HOLDER.value = undefined
  try { dispose() } catch { /* 旧实例已经释放 */ }
}

export function apply(ctx) {
  const store = createStore(statePath())

  async function handle(req, res) {
    let path = '/'
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      path = url.pathname.slice(PREFIX.length) || '/'
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' })
    }

    if (path === '/ping' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, plugin: name, pong: true })
    }

    if (path === '/state' && req.method === 'GET') {
      try {
        const [archives, prefs] = await Promise.all([store.list(), store.getPrefs()])
        return sendJson(res, 200, { ok: true, archives, prefs })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
      }
    }

    // 角标偏好：与 archives 同一份状态文件、同一把锁，重启宿主不丢。
    if (path === '/prefs' && req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { ok: false, error: '请求体必须是对象' })
      }
      try {
        const prefs = await store.setPrefs(body)
        return sendJson(res, 200, { ok: true, prefs })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
      }
    }

    if ((path === '/archive' || path === '/unarchive') && req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(res, 400, { ok: false, error: '请求体必须是对象' })
      }
      try {
        assertWorkspaceId(body.workspaceId)
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
      }
      try {
        if (path === '/archive') {
          const sessionIds = assertSessionIds(body.sessionIds)
          const record = await store.archive(body.workspaceId, sessionIds)
          return sendJson(res, 200, { ok: true, record })
        }
        await store.unarchive(body.workspaceId)
        return sendJson(res, 200, { ok: true })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
      }
    }

    return sendJson(res, 404, { ok: false, error: 'not found', prefix: PREFIX })
  }

  disposeRoutes()
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (req, res) => {
        Promise.resolve(handle(req, res)).catch((error) => {
          sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        })
      },
    })
    ROUTES_HOLDER.value = dispose
    return () => {
      if (ROUTES_HOLDER.value === dispose) ROUTES_HOLDER.value = undefined
      try { dispose() } catch { /* 已释放 */ }
    }
  }, 'workspace-archive: route')
}

/**
 * 仅供测试使用的内部函数/常量出口（B1 路线）。
 *
 * 只是把这些本来就在模块作用域里、行为完全不变的标识符挂到一个具名导出上，
 * 不改动任何既有导出（name / inject / apply）与任何运行时路径。
 * 外部消费者不应依赖本对象，它随时可能随内部重构调整。
 */
export const __test = {
  writeAtomic,
  withLock,
  normalizePrefs,
  createStore,
  readState,
  assertWorkspaceId,
  assertSessionIds,
  isId,
  statePath,
  MAX_STATE_FILE_BYTES,
  LOCK_STALE_MS,
  MAX_RECORDS,
  MAX_SESSION_IDS_PER_RECORD,
  MAX_ID_LENGTH,
  BADGE_MODES,
}
