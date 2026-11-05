/**
 * 宿主半侧 · 存储层测试（原子写 / 跨进程锁 / 账本容错 / id 校验）。
 *
 * 零第三方依赖：只用 node: 内置模块。临时文件一律落在 os.tmpdir() 下的 mkdtemp 目录，
 * 测完不删除（交给系统 tmpfs 回收），所以本文件里没有 rm / rmSync / rmdir。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { __test } = await import('../lib/index.js')
const {
  writeAtomic, withLock, createStore, readState,
  assertWorkspaceId, assertSessionIds, isId,
  statePath, MAX_STATE_FILE_BYTES, LOCK_STALE_MS,
  MAX_SESSION_IDS_PER_RECORD, MAX_ID_LENGTH,
  normalizePrefs, BADGE_MODES,
} = __test

const TMP_ROOT = await mkdtemp(join(tmpdir(), 'dsh-wsa-test-'))
let seq = 0
/** 每个用例一个独立子目录，互不干扰（不删除，交给 tmpfs）。 */
async function freshDir(label) {
  const dir = join(TMP_ROOT, String(++seq).padStart(2, '0') + '-' + label)
  await mkdir(dir, { recursive: true })
  return dir
}
async function exists(p) {
  try { await lstat(p); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e }
}

/* ========================= ① 原子写 ========================= */
test('1a 原子写：同目录临时文件 + rename 落盘，目录里只留正式文件', async () => {
  const dir = await freshDir('atomic-ok')
  const target = join(dir, 'state.json')
  await writeAtomic(target, '{"version":1,"archives":{}}' + '\n')
  assert.equal(await readFile(target, 'utf8'), '{"version":1,"archives":{}}' + '\n')
  // rename 把临时文件搬走，目录里只剩正式文件
  assert.deepEqual(await readdir(dir), ['state.json'])
  // 权限：状态文件 0600（源码 open(temp, 'wx', 0o600)）
  assert.equal((await lstat(target)).mode & 0o777, 0o600)
})

test('1b 原子写：临时文件建在目标同目录（用失败报错路径证明）', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('以 root 运行时无法用目录权限制造 EACCES')
    return
  }
  const dir = await freshDir('atomic-eacces')
  const target = join(dir, 'state.json')
  await chmod(dir, 0o500) // 去掉写位 → open(temp, 'wx') 必须失败
  const error = await writeAtomic(target, '{}').then(() => null, (e) => e)
  assert.ok(error, '应当写入失败')
  assert.equal(error.code, 'EACCES')
  const tempPath = String(error.path || '')
  assert.ok(tempPath.startsWith(dir + '/'), '临时文件应在目标同目录，实际：' + tempPath)
  assert.match(tempPath, /\/\.dsh-workspace-archive\.\d+\.[0-9a-f]+\.tmp$/)
  assert.equal(await exists(target), false, '失败时目标文件不应被创建')
})

test('1c 原子写：中途失败不留半个文件（状态文件本身绝无半截）', async () => {
  const dir = await freshDir('atomic-fail')
  const target = join(dir, 'state.json')
  // 让 rename 必失败：目标路径是一个非空目录（EEXIST / ENOTEMPTY）
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'old-content', 'utf8')
  await assert.rejects(() => writeAtomic(target, '{"half":true}'), 'rename 失败必须抛出，不能静默当成功')

  // 目标仍是原来的目录、内容未动 → 正式状态文件绝不可能出现"半个"
  assert.equal((await lstat(target)).isDirectory(), true)
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'old-content')

  // 写入确实发生了，但只落在同目录的 .tmp 里（源码 finally 只 close、不 unlink 临时文件），
  // 所以残留物一定带 .tmp 后缀，永远不会污染正式文件名。
  const entries = await readdir(dir)
  assert.ok(entries.indexOf('state.json') > -1)
  for (const name of entries) {
    if (name === 'state.json') continue
    assert.match(name, /^\.dsh-workspace-archive\.\d+\.[0-9a-f]+\.tmp$/, '残留物只能是 .tmp：' + name)
    assert.equal(await readFile(join(dir, name), 'utf8'), '{"half":true}', '半截内容只存在于 .tmp')
  }
})

test('1d 原子写：超过 MAX_STATE_FILE_BYTES 直接拒绝，不创建任何文件', async () => {
  const dir = await freshDir('atomic-large')
  const target = join(dir, 'state.json')
  const error = await writeAtomic(target, 'x'.repeat(MAX_STATE_FILE_BYTES + 1)).then(() => null, (e) => e)
  assert.equal(error && error.code, 'state-too-large')
  assert.equal(await exists(target), false)
  assert.deepEqual(await readdir(dir), [])
})

/* ========================= ② 跨进程锁 ========================= */
test('2a 跨进程锁：wx 抢锁成功，临界区内锁存在，结束后 unlink', async () => {
  const dir = await freshDir('lock-basic')
  const target = join(dir, 'state.json')
  const lockPath = target + '.lock'
  let seenLock = false
  const value = await withLock(target, async () => {
    assert.equal(await exists(lockPath), true, '临界区内锁文件应存在')
    seenLock = true
    assert.match(await readFile(lockPath, 'utf8'), /^\d+$/, '锁文件内容是时间戳')
    return 'done'
  })
  assert.equal(seenLock, true)
  assert.equal(value, 'done')
  assert.equal(await exists(lockPath), false, '释放后锁文件应被 unlink')
})

test('2b 跨进程锁：新锁不会被抢，等满 LOCK_WAIT_MS 后抛 state-busy 且别人的锁仍在', async () => {
  const dir = await freshDir('lock-fresh')
  const target = join(dir, 'state.json')
  const lockPath = target + '.lock'
  await writeFile(lockPath, String(Date.now()), 'utf8') // 模拟另一个进程正持锁
  const startedAt = Date.now()
  const error = await withLock(target, async () => 'never').then(() => null, (e) => e)
  const waited = Date.now() - startedAt
  assert.equal(error && error.code, 'state-busy')
  assert.ok(waited >= 2000, '应等待接近 LOCK_WAIT_MS 才放弃，实际 ' + waited + 'ms')
  assert.equal(await exists(lockPath), true, '别人的有效锁不应被删掉')
})

test('2c 跨进程锁：只有 mtime 超过 LOCK_STALE_MS 才被接管，接管后照常释放', async () => {
  const dir = await freshDir('lock-stale')
  const target = join(dir, 'state.json')
  const lockPath = target + '.lock'
  await writeFile(lockPath, 'stale-owner', 'utf8')
  const ancient = new Date(Date.now() - LOCK_STALE_MS - 5000)
  await utimes(lockPath, ancient, ancient)
  let entered = false
  const value = await withLock(target, async () => { entered = true; return 42 })
  assert.equal(value, 42)
  assert.equal(entered, true, '过期锁应被接管并进入临界区')
  assert.equal(await exists(lockPath), false, '接管后结束仍要 unlink')
})

test('2d 跨进程锁：临界区抛错也要释放锁，错误原样抛出', async () => {
  const dir = await freshDir('lock-throw')
  const target = join(dir, 'state.json')
  const lockPath = target + '.lock'
  const error = await withLock(target, async () => { throw new Error('boom') }).then(() => null, (e) => e)
  assert.equal(error && error.message, 'boom')
  assert.equal(await exists(lockPath), false, '异常路径也必须 unlink')
})

test('2e 两个 store 并发写同一文件不互相覆盖（丢失更新检测）', async () => {
  const dir = await freshDir('lock-two-stores')
  const target = join(dir, 'state.json')
  const a = createStore(target)
  const b = createStore(target)
  const N = 15
  const jobs = []
  for (let i = 0; i < N; i += 1) {
    jobs.push(a.archive('ws-a-' + i, ['s-a-' + i]))
    jobs.push(b.archive('ws-b-' + i, ['s-b-' + i]))
  }
  const records = await Promise.all(jobs)
  assert.equal(records.length, N * 2)
  const state = await readState(target)
  const ids = Object.keys(state.archives).sort()
  assert.equal(ids.length, N * 2, '两个 store 的写入都必须留下，不能互相覆盖')
  for (let i = 0; i < N; i += 1) {
    assert.ok(ids.indexOf('ws-a-' + i) > -1, '缺 ws-a-' + i)
    assert.ok(ids.indexOf('ws-b-' + i) > -1, '缺 ws-b-' + i)
    assert.deepEqual(state.archives['ws-a-' + i].sessionIds, ['s-a-' + i])
    assert.deepEqual(state.archives['ws-b-' + i].sessionIds, ['s-b-' + i])
  }
})

test('2f store：同工作区重复归档合并 sessionIds（去重），list 返回副本', async () => {
  const dir = await freshDir('store-merge')
  const target = join(dir, 'state.json')
  const store = createStore(target)
  await store.archive('ws-1', ['s1', 's2'])
  const second = await store.archive('ws-1', ['s2', 's3'])
  assert.deepEqual(second.sessionIds, ['s1', 's2', 's3'])
  const listed = await store.list()
  assert.deepEqual(listed['ws-1'].sessionIds, ['s1', 's2', 's3'])
  listed['ws-1'].sessionIds.push('oops') // 改返回值不应影响磁盘
  const again = await store.list()
  assert.deepEqual(again['ws-1'].sessionIds, ['s1', 's2', 's3'])
})

test('2g store：unarchive 删除并返回旧记录，不存在的 id 返回 null', async () => {
  const dir = await freshDir('store-unarchive')
  const store = createStore(join(dir, 'state.json'))
  await store.archive('ws-1', ['s1'])
  const prev = await store.unarchive('ws-1')
  assert.deepEqual(prev.sessionIds, ['s1'])
  assert.equal(await store.unarchive('ws-1'), null)
  assert.deepEqual(Object.keys(await store.list()), [])
})

/* ========================= ③ 账本容错 ========================= */
test('3a 账本：文件不存在 → 回落空账本（源码唯一的回落路径）', async () => {
  const dir = await freshDir('state-missing')
  const state = await readState(join(dir, 'not-there.json'))
  assert.equal(state.version, 1)
  assert.deepEqual(Object.keys(state.archives), [])
  assert.equal(Object.getPrototypeOf(state.archives), null, '空账本是 null 原型，防原型链污染')
})

test('3b 账本：版本不符 / 结构损坏 / 非 JSON → 抛 state-corrupt（不是回落空账本）', async () => {
  const cases = {
    'version:2': JSON.stringify({ version: 2, archives: {} }),
    'archives 是数组': JSON.stringify({ version: 1, archives: [] }),
    'archives 为 null': JSON.stringify({ version: 1, archives: null }),
    '缺 archives': JSON.stringify({ version: 1 }),
    '顶层是数组': JSON.stringify([]),
    '顶层是 null': 'null',
    '不是 JSON': 'not-json-at-all',
    '空文件': '',
    '记录里 sessionIds 含非字符串': JSON.stringify({ version: 1, archives: { ws1: { sessionIds: [1] } } }),
  }
  for (const label of Object.keys(cases)) {
    const dir = await freshDir('state-corrupt')
    const target = join(dir, 'state.json')
    await writeFile(target, cases[label], 'utf8')
    const error = await readState(target).then(() => null, (e) => e)
    assert.ok(error, label + '：应当抛错')
    assert.equal(error.code, 'state-corrupt', label + '：错误码')
  }
})

test('3c 账本：非法 key / 非对象记录被静默跳过，好记录照常读出', async () => {
  const dir = await freshDir('state-skip')
  const target = join(dir, 'state.json')
  await writeFile(target, JSON.stringify({
    version: 1,
    archives: {
      'ws-good': { archivedAt: 111, sessionIds: ['s1', 's1', 's2'] },
      '../evil': { archivedAt: 222, sessionIds: [] },
      'constructor': { archivedAt: 333, sessionIds: [] },
      'ws-null': null,
      'ws-string': 'nope',
      'ws-defaults': { sessionIds: [] },
    },
  }), 'utf8')
  const state = await readState(target)
  assert.deepEqual(Object.keys(state.archives).sort(), ['ws-defaults', 'ws-good'])
  assert.deepEqual(state.archives['ws-good'].sessionIds, ['s1', 's2'], '账本读取也要去重')
  assert.equal(typeof state.archives['ws-defaults'].archivedAt, 'number', 'archivedAt 缺失时补当前时间')
})

test('3d 账本：超过字节上限 / 不是普通文件 → state-corrupt', async () => {
  const dir = await freshDir('state-badfile')
  const big = join(dir, 'big.json')
  await writeFile(big, 'x'.repeat(MAX_STATE_FILE_BYTES + 10), 'utf8')
  const tooBig = await readState(big).then(() => null, (e) => e)
  assert.equal(tooBig && tooBig.code, 'state-corrupt')

  const asDir = join(dir, 'dir-as-state.json')
  await mkdir(asDir)
  const error = await readState(asDir).then(() => null, (e) => e)
  assert.equal(error && error.code, 'state-corrupt')
})

/* ========================= ④ id 校验 ========================= */
test('4a isId：合法 id 通过，非法形态全部拒绝', () => {
  assert.equal(isId('ws-1'), true)
  assert.equal(isId('a'), true)
  assert.equal(isId('x'.repeat(MAX_ID_LENGTH)), true)
  assert.equal(isId('session:abc-123'), true)

  assert.equal(isId(''), false, '空串')
  assert.equal(isId(123), false, '非字符串')
  assert.equal(isId(null), false, 'null')
  assert.equal(isId(undefined), false, 'undefined')
  assert.equal(isId('..'), false, '路径穿越')
  assert.equal(isId('../evil'), false, '路径穿越')
  assert.equal(isId('a\u0000b'), false, 'NUL')
  assert.equal(isId('a\nb'), false, '控制字符换行')
  assert.equal(isId('a\u007fb'), false, '控制字符 DEL')
  assert.equal(isId('__proto__'), false, '原型链危险键')
  assert.equal(isId('prototype'), false, '原型链危险键')
  assert.equal(isId('constructor'), false, '原型链危险键')
  assert.equal(isId('x'.repeat(MAX_ID_LENGTH + 1)), false, '超长')
})

test('4b assertWorkspaceId：非法 workspaceId 抛 invalid-workspace-id', () => {
  assert.doesNotThrow(() => assertWorkspaceId('ws-1'))
  const bads = ['', '..', '../x', 'constructor', 'x'.repeat(MAX_ID_LENGTH + 1), 42, undefined]
  for (const bad of bads) {
    let error = null
    try { assertWorkspaceId(bad) } catch (e) { error = e }
    assert.ok(error, '应当拒绝：' + String(bad))
    assert.equal(error.code, 'invalid-workspace-id', '错误码：' + String(bad))
  }
})

test('4c assertSessionIds：数组校验 + 元素校验 + 去重 + 长度上限', () => {
  assert.deepEqual(assertSessionIds(undefined), [], 'undefined 视为空数组')
  assert.deepEqual(assertSessionIds([]), [])
  assert.deepEqual(assertSessionIds(['a', 'b', 'a']), ['a', 'b'], '去重')

  const bads = ['nope', 42, null, { length: 0 }, ['a', 1], ['a', ''], ['../x'], ['x'.repeat(MAX_ID_LENGTH + 1)]]
  for (const bad of bads) {
    let error = null
    try { assertSessionIds(bad) } catch (e) { error = e }
    assert.ok(error, '应当拒绝：' + JSON.stringify(bad))
    assert.ok(['invalid-session-ids', 'invalid-session-id'].indexOf(error.code) > -1, '错误码：' + error.code)
  }
  const tooMany = new Array(MAX_SESSION_IDS_PER_RECORD + 1).fill(0).map((_, i) => 's' + i)
  let error = null
  try { assertSessionIds(tooMany) } catch (e) { error = e }
  assert.equal(error && error.code, 'invalid-session-ids', '超长数组被拒')
})

test('4d statePath：跟随 DSH_HOME，未设置时落在 ~/.dsh/storages', async () => {
  const home = await freshDir('dsh-home')
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = home
    assert.equal(statePath(), join(home, 'storages', 'dsh-workspace-archive.json'))
    process.env.DSH_HOME = '   '
    assert.match(statePath(), /\/\.dsh\/storages\/dsh-workspace-archive\.json$/)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})


/* ========================= ⑤ 角标偏好（0.1.6） ========================= */
test('5a normalizePrefs：白名单档位 + 布尔确认标记，其余回落默认', () => {
  assert.deepEqual(normalizePrefs(undefined), { badgeMode: 'always', acked: true })
  assert.deepEqual(normalizePrefs(null), { badgeMode: 'always', acked: true })
  assert.deepEqual(normalizePrefs([]), { badgeMode: 'always', acked: true })
  assert.deepEqual(normalizePrefs({}), { badgeMode: 'always', acked: true })
  for (const mode of BADGE_MODES) {
    assert.deepEqual(normalizePrefs({ badgeMode: mode, acked: false }), { badgeMode: mode, acked: false })
  }
  assert.deepEqual(normalizePrefs({ badgeMode: 'bogus', acked: false }), { badgeMode: 'always', acked: false })
  assert.deepEqual(normalizePrefs({ badgeMode: 'new', acked: 'yes' }), { badgeMode: 'new', acked: true })
  // 不许把原型链上的脏键带进偏好对象
  const dirty = Object.create({ badgeMode: 'never', acked: false })
  assert.deepEqual(normalizePrefs(dirty), { badgeMode: 'always', acked: true })
})

test('5b readState：旧版状态文件（无 prefs 字段）平滑升级，archives 不丢', async () => {
  const dir = await freshDir('state-no-prefs')
  const target = join(dir, 'state.json')
  await writeFile(target, JSON.stringify({ version: 1, archives: { w1: { archivedAt: 1, sessionIds: ['s1'] } } }), 'utf8')
  const state = await readState(target)
  assert.deepEqual(state.prefs, { badgeMode: 'always', acked: true }, '缺 prefs 时回落默认')
  assert.deepEqual(state.archives['w1'].sessionIds, ['s1'], '旧账本照常读出')
})

test('5c createStore：setPrefs 与 archive 共用同一状态文件、互不覆盖', async () => {
  const dir = await freshDir('store-prefs')
  const target = join(dir, 'state.json')
  const store = createStore(target)
  await store.setPrefs({ badgeMode: 'never', acked: false })
  await store.archive('ws-1', ['s1'])
  assert.deepEqual(await store.getPrefs(), { badgeMode: 'never', acked: false })
  assert.deepEqual(Object.keys(await store.list()), ['ws-1'])
  const state = await readState(target)
  assert.deepEqual(state.prefs, { badgeMode: 'never', acked: false })
  assert.deepEqual(state.archives['ws-1'].sessionIds, ['s1'])
})

