/**
 * 浏览器半侧 · 语义测试（角标三档 / 归档回滚 / 恢复语义 / 运行中拒绝）。
 *
 * client/client.js 整个包在 IIFE 里、函数闭在 makeFactory() 里，为测试改结构不划算。
 * 这里沿用 .test/wsa-empty-ws-regression.mjs 的做法：读源码文本 + 结构化断言，
 * 再用与源码逐字一致的判定式复算语义。所有断言都锚定真实行号与真实表达式。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC_URL = new URL('../client/client.js', import.meta.url)
const src = readFileSync(SRC_URL, 'utf8')
const lines = src.split('\n')

/** 1-based 行号取源码行。 */
function line(n) {
  const text = lines[n - 1]
  assert.equal(typeof text, 'string', '第 ' + n + ' 行不存在')
  return text
}
function countOf(needle) {
  let n = 0
  let at = src.indexOf(needle)
  while (at !== -1) { n += 1; at = src.indexOf(needle, at + needle.length) }
  return n
}

/* ======================= 与源码逐字一致的两段判定式 ======================= */
/** client.js:404 —— 运行中判定（/running|active|busy/i 命中异常消息 → reason:'running'）。 */
function archiveFailureReason(message) {
  const msg = message === undefined || message === null ? '' : String(message)
  return /running|active|busy/i.test(msg) ? 'running' : 'failed'
}
/** client.js:580 —— 失败时菜单标签文案。 */
function menuLabelOnFailure(result) {
  return result.reason === 'running' ? 'menu.running' : 'menu.archiveFailed'
}
/** client.js:203-208 —— 角标三档。 */
function badgeView(state) {
  const count = state.items.length
  if (state.badgeMode === 'never' || count === 0) return null
  if (state.badgeMode === 'always') return { count, isNew: false }
  return state.acked ? null : { count, isNew: true }
}

/* ========================= ⑥ 角标三档 ========================= */
test('6a 角标：三档 always / new / never 常量，默认 always', () => {
  assert.match(line(173), /const BADGE_MODES = \['always', 'new', 'never'\]/)
  assert.match(line(174), /let badgeMode = 'always'/, '默认档位必须是 always')
  assert.match(line(179), /let acked = true/, '新归档的确认标记默认已确认')
  // 源码里的 badgeView 与本文件复算的判定式必须逐字一致
  const body = lines.slice(202, 208).join('\n')
  assert.ok(body.indexOf("if (state.badgeMode === 'never' || count === 0) return null") > -1)
  assert.ok(body.indexOf("if (state.badgeMode === 'always') return { count, isNew: false }") > -1)
  assert.ok(body.indexOf('return state.acked ? null : { count, isNew: true }') > -1)
})

test('6b 角标 always：显示数量，永远不带 new 气泡', () => {
  const two = [{ workspaceId: 'a' }, { workspaceId: 'b' }]
  for (const acked of [true, false]) {
    assert.deepEqual(badgeView({ badgeMode: 'always', acked, items: two }), { count: 2, isNew: false })
  }
  assert.deepEqual(badgeView({ badgeMode: 'always', acked: true, items: [1, 2, 3] }), { count: 3, isNew: false })
})

test('6c 角标 new：只有出现新归档且未确认时才显气泡；未确认前数量实时跟随', () => {
  const one = [{ workspaceId: 'a' }]
  const three = [{ workspaceId: 'a' }, { workspaceId: 'b' }, { workspaceId: 'c' }]
  // 未确认 → 气泡（isNew:true）
  assert.deepEqual(badgeView({ badgeMode: 'new', acked: false, items: one }), { count: 1, isNew: true })
  // 已确认 → 隐藏，哪怕有条目
  assert.equal(badgeView({ badgeMode: 'new', acked: true, items: one }), null)
  // 恢复一个又归档一个、数量不变，靠布尔而不是计数，仍要冒泡
  assert.deepEqual(badgeView({ badgeMode: 'new', acked: false, items: [{ workspaceId: 'z' }] }),
    badgeView({ badgeMode: 'new', acked: false, items: one }), '数量相同也必须判定一致')
  // 未确认期间数量变化 → 气泡数字跟着变
  assert.equal(badgeView({ badgeMode: 'new', acked: false, items: three }).count, 3)
})

test('6d 角标 never：任何情况都隐藏', () => {
  assert.equal(badgeView({ badgeMode: 'never', acked: false, items: [{ workspaceId: 'a' }, { workspaceId: 'b' }] }), null)
  assert.equal(badgeView({ badgeMode: 'never', acked: true, items: [{ workspaceId: 'a' }] }), null)
})

test('6e 角标：没有归档记录时三档都不显示', () => {
  for (const badgeMode of ['always', 'new', 'never']) {
    assert.equal(badgeView({ badgeMode, acked: false, items: [] }), null, badgeMode)
  }
})

test('6f 角标：新归档置 acked=false 并持久化；打开面板或切到 new 置 acked=true', () => {
  // 归档成功后：acked = false + persistPrefs()
  assert.match(line(463), /acked = false/)
  assert.match(line(464), /persistPrefs\(\)/)
  // 打开面板即确认当前这批（client.js:212-215）
  const panelBlock = lines.slice(208, 217).join('\n')
  assert.ok(panelBlock.indexOf('if (v && badgeMode === ') > -1, '开口面板的分支')
  assert.ok(panelBlock.indexOf('acked = true') > -1, '打开面板应确认')
  // 切到 new 档时视作已确认，避免刚切换就冒泡（client.js:218-225）
  assert.match(line(222), /if \(mode === 'new'\) acked = true/)
  // 偏好落 localStorage，键名固定
  assert.match(line(250), /const PREFS_KEY = ID \+ '\.prefs\.v1'/)
})

test('6g 角标 DOM：气泡带 data-new 标记，new 档额外挂脉冲 class', () => {
  const dom = lines.slice(784, 791).join('\n')
  assert.ok(src.indexOf("className: NS + '-badge' + (badge.isNew ? ' ' + NS + '-badge-new' : '')") > -1, '气泡类名')
  assert.ok(src.indexOf("'data-new': badge.isNew ? 'true' : undefined") > -1, 'data-new 标记')
  assert.ok(src.indexOf('footer.ariaNew') > -1, '有新归档时 aria-label 走 ariaNew')
  assert.ok(dom.length > 0)
})

/* ========================= ⑦ 归档回滚 ========================= */
test("7a 归档回滚：任一条失败 → 已成功的全部 unarchive 回滚（源码结构）", () => {
  // 回滚函数只对 done 里的每一条调用 unarchive，且吞掉单条失败
  const rollbackBlock = lines.slice(411, 414).join('\n')
  assert.ok(rollbackBlock.indexOf('const rollback = async () => {') > -1, '有 rollback 闭包')
  assert.ok(rollbackBlock.indexOf('for (const prev of done) { try { await doUnarchive(prev) } catch (_) {} }') > -1,
    '回滚 = 对 done 逐个 unarchive')
  // 失败分支先 rollback 再返回
  const catchBlock = lines.slice(423, 428).join('\n')
  assert.ok(catchBlock.indexOf('await rollback()') > -1, '单条归档失败必须先回滚')
  assert.ok(catchBlock.indexOf("reason: /running|active|busy/i.test(msg) ? 'running' : 'failed'") > -1)
  // 归档期间新增会话那一轮失败也要回滚
  const afterBlock = lines.slice(438, 445).join('\n')
  assert.ok(afterBlock.indexOf('await rollback()') > -1, '补归档失败同样回滚')
  // 落账本失败也要回滚（账本写失败时会话能整体回滚）
  const persistBlock = lines.slice(453, 459).join('\n')
  assert.ok(persistBlock.indexOf('await rollback()') > -1, '账本写失败必须回滚')
  assert.ok(persistBlock.indexOf("return { ok: false, reason: 'persist-failed' }") > -1)
  // 整个归档流程必须恰有 4 处 rollback 调用（3 个失败分支 + 定义）
  assert.equal(countOf('await rollback()'), 3, 'rollback 调用点数量')
})

test('7b 归档回滚：复算「3 条成功、第 4 条失败」→ unarchive 恰好回滚前 3 条', async () => {
  const members = ['s1', 's2', 's3', 's4', 's5']
  const baseArchived = new Set(['s1']) // 归档前就已归档的成员不参与
  const keep = 's5'                    // 当前正在查看的会话保留
  const calls = { archive: [], unarchive: [] }
  const doArchive = async (sid, opts) => {
    calls.archive.push({ sid, opts })
    if (sid === 's4') throw new Error('session-active: workspace busy')
  }
  const doUnarchive = async (sid) => { calls.unarchive.push(sid) }

  // ↓↓↓ 与 client.js:377-395 同构
  const done = []
  const rollback = async () => {
    for (const prev of done) { try { await doUnarchive(prev) } catch (_) {} }
  }
  let outcome = null
  for (const sid of members) {
    if (baseArchived.has(sid) || done.indexOf(sid) > -1) continue
    if (sid === keep) continue
    try {
      await doArchive(sid, { stopActivity: false })
      done.push(sid)
    } catch (error) {
      await rollback()
      outcome = { ok: false, reason: archiveFailureReason(error && error.message) }
      break
    }
  }
  if (!outcome) outcome = { ok: true }

  assert.deepEqual(calls.archive.map((c) => c.sid), ['s2', 's3', 's4'], '只尝试未归档且非当前的成员')
  assert.deepEqual(calls.unarchive, ['s2', 's3'], '已成功的全部回滚，失败那条不重复回滚')
  assert.deepEqual(outcome, { ok: false, reason: 'running' })
})

test('7c 归档回滚：复算「账本写失败」→ 所有已归档成员全部回滚', async () => {
  const members = ['a1', 'a2', 'a3']
  const archivedNow = []
  const doArchive = async (sid) => { archivedNow.push(sid) }
  const doUnarchive = async (sid) => { archivedNow.splice(archivedNow.indexOf(sid), 1) }
  const persistArchive = async () => { throw new Error('state write failed') }

  // ↓↓↓ 与 client.js:377-425 同构
  const done = []
  const rollback = async () => { for (const prev of done) { try { await doUnarchive(prev) } catch (_) {} } }
  let outcome = null
  try {
    for (const sid of members) {
      await doArchive(sid, { stopActivity: false })
      done.push(sid)
    }
    try { await persistArchive() } catch (_) { await rollback(); outcome = { ok: false, reason: 'persist-failed' } }
  } finally { /* busy 清理，与 finally 同构 */ }
  assert.deepEqual(archivedNow, [], '账本失败后不应有任何会话留在归档态')
  assert.deepEqual(outcome, { ok: false, reason: 'persist-failed' })
})

/* ========================= ⑧ 恢复语义 ========================= */
test('8a 恢复语义：全部成功才删记录，否则整组回滚并保留（源码结构）', () => {
  const block = lines.slice(472, 506)
  const text = block.join('\n')
  assert.ok(text.indexOf('const restored = []') > -1, '维护已恢复列表')
  // 成功路径：先落账本，再删内存记录
  const okPath = text.indexOf('await persistUnarchive(workspaceId)')
  const delPath = text.indexOf('archives.delete(workspaceId)')
  assert.ok(okPath > -1 && delPath > -1 && okPath < delPath, '必须先确认宿主删账本成功，再删本地记录')
  // 失败路径：单条 unarchive 失败 → 把已恢复的重新 archive 回去
  assert.ok(text.indexOf('for (const prev of restored) { try { await doArchive(prev, { stopActivity: false }) } catch (_) {} }') > -1,
    '失败必须整组回滚')
  assert.equal(countOf('for (const prev of restored) { try { await doArchive(prev, { stopActivity: false }) } catch (_) {} }'), 2,
    '两个失败分支各回滚一次')
  assert.equal(countOf('archives.delete(workspaceId)'), 1, '只有全部成功才删记录')
  assert.equal(countOf('archivedSessions.delete(workspaceId)'), 1)
})

test('8b 恢复语义：复算「第 2 条恢复失败」→ 已恢复的重新归档，账本记录不动', async () => {
  const record = { workspaceId: 'w', sessionIds: ['s1', 's2', 's3'] }
  const archivedNow = new Set(['s1', 's2', 's3'])
  const ledgerCleared = []
  const doUnarchive = async (sid) => {
    if (sid === 's2') throw new Error('unarchive failed')
    archivedNow.delete(sid)
  }
  const doArchive = async (sid) => { archivedNow.add(sid) }
  const persistUnarchive = async () => { ledgerCleared.push('host') }

  // ↓↓↓ 与 client.js:445-462 同构
  const restored = []
  let outcome = { ok: true }
  for (const sid of record.sessionIds) {
    if (restored.indexOf(sid) > -1) continue
    try {
      await doUnarchive(sid)
      restored.push(sid)
    } catch (_) {
      for (const prev of restored) { try { await doArchive(prev, { stopActivity: false }) } catch (_) {} }
      outcome = { ok: false }
      break
    }
  }
  if (outcome.ok) {
    try { await persistUnarchive(record.workspaceId) } catch (_) {
      for (const prev of restored) { try { await doArchive(prev, { stopActivity: false }) } catch (_) {} }
      outcome = { ok: false }
    }
    if (outcome.ok) ledgerCleared.push('local')
  }

  assert.deepEqual(outcome, { ok: false })
  assert.deepEqual([...archivedNow].sort(), ['s1', 's2', 's3'], 's1 已恢复，失败后必须被重新归档回去')
  assert.deepEqual(ledgerCleared, [], '整组没全成功，宿主账本不能被删')
})

test('8c 恢复语义：复算「全部成功」→ 才删宿主账本与本地记录', async () => {
  const record = { workspaceId: 'w', sessionIds: ['s1', 's2'] }
  const archivedNow = new Set(['s1', 's2'])
  const log = []
  const doUnarchive = async (sid) => { archivedNow.delete(sid); log.push('unarchive:' + sid) }
  const doArchive = async (sid) => { archivedNow.add(sid) }
  const persistUnarchive = async () => { log.push('persist:unarchive') }

  const restored = []
  for (const sid of record.sessionIds) {
    if (restored.indexOf(sid) > -1) continue
    await doUnarchive(sid)
    restored.push(sid)
  }
  await persistUnarchive(record.workspaceId)
  log.push('local:delete')

  assert.deepEqual([...archivedNow], [], '全部恢复后不应有残留归档')
  assert.deepEqual(log, ['unarchive:s1', 'unarchive:s2', 'persist:unarchive', 'local:delete'],
    '顺序必须是：逐条恢复 → 宿主删账本 → 本地删记录')
})

/* ========================= ⑨ 运行中拒绝 ========================= */
test('9a 运行中拒绝：官方命令一律传 stopActivity:false（源码里只有这一种写法）', () => {
  const stopActivityFalse = src.split("stopActivity: false").length - 1
  assert.equal(stopActivityFalse, 4, '应恰有 4 处 stopActivity: false')
  // 归档两处（首轮 + 补归档）
  assert.ok(line(422).indexOf('await doArchive(sid, { stopActivity: false })') > -1, '首轮归档')
  assert.ok(line(439).indexOf('await doArchive(sid, { stopActivity: false })') > -1, '补归档')
  // 回滚/恢复时重新归档两处
  const rejoins = lines.map((t, i) => [i + 1, t]).filter(([, t]) => t.indexOf('await doArchive(prev, { stopActivity: false })') > -1)
  assert.deepEqual(rejoins.map(([n]) => n), [487, 494], '恢复/回滚重新归档的行号')
  // 一个 stopActivity:true 都不许有
  assert.equal(countOf('stopActivity: true'), 0, '绝不能停止会话')
})

test('9b 运行中拒绝：源码里没有任何停止/中断会话的调用', () => {
  // 官方「停止会话」的入口形态：stopSession / stopActivity:true / abortController / interrupt
  const forbidden = [
    'stopSession',
    'interruptSession',
    'stopActivity: true',
    'abortController',
    '.abort(',
    'destroySession',
    'killSession',
    'cancelSession',
  ]
  for (const needle of forbidden) {
    assert.equal(countOf(needle), 0, '不应出现：' + needle)
  }
  // 只有注释里提到"停"，代码里没有
  assert.match(line(421), /绝不替用户停掉正在跑的会话/)
})

test("9c 运行中拒绝：reason:'running' 只改菜单文案 + 2.6s 自动复位，不做别的", () => {
  // executeArchive 的失败判定（client.js:393）
  assert.match(line(427), /reason: \/running\|active\|busy\/i\.test\(msg\) \? 'running' : 'failed'/)
  // 失败后只改文案并安排复位（client.js:549-552）
  assert.match(line(583), /label\.textContent = result\.reason === 'running' \? t\('menu\.running'\) : t\('menu\.archiveFailed'\)/)
  assert.match(line(585), /parts\.resetTimer = setTimeout\(parts\.reset, 2600\)/)
  // 点击处理器里，失败分支之前只有 executeArchive，没有别的会话操作
  const clickBlock = lines.slice(572, 590).join('\n')
  assert.ok(clickBlock.indexOf('executeArchive(workspaceId).then((result) => {') > -1)
  assert.equal((clickBlock.match(/stopActivity|interrupt|abort|kill/gi) || []).length, 0, '点击处理器里不得有停止调用')
  // 词条本身：用户看到的是"请先停止"，插件不代劳
  assert.match(line(46), /'menu\.running': '有会话正在运行，请先停止'/)
})

test('9d 运行中拒绝：复算异常消息 → reason 判定（只影响提示，不影响任何会话）', () => {
  assert.equal(archiveFailureReason('workspace/session-active: session is running'), 'running')
  assert.equal(archiveFailureReason('session busy'), 'running')
  assert.equal(archiveFailureReason('Workspace is ACTIVE'), 'running')
  assert.equal(archiveFailureReason('network down'), 'failed')
  assert.equal(archiveFailureReason(undefined), 'failed')
  // 两种 reason 对应两套文案，且都不会带来停止动作
  assert.equal(menuLabelOnFailure({ ok: false, reason: 'running' }), 'menu.running')
  assert.equal(menuLabelOnFailure({ ok: false, reason: 'failed' }), 'menu.archiveFailed')
  assert.equal(menuLabelOnFailure({ ok: false, reason: 'persist-failed' }), 'menu.archiveFailed')
  // 归档成功时也不停会话：4 处 doArchive 全是 stopActivity:false（见 9a）
  assert.equal(countOf('stopActivity'), 4)
})


/* ========================= ⑩ 0.1.6 两个 bug 的回归 ========================= */
test('10a 重启不丢角标：偏好写入宿主 /prefs + localStorage 双写', () => {
  // persistPrefs 必须同时写本机缓存与宿主状态文件；后者才是重启后的依据。
  assert.ok(src.indexOf("const PREFS_KEY = ID + '.prefs.v1'") > -1, 'localStorage 键名保留（即时缓存）')
  assert.ok(src.indexOf("s.setItem(PREFS_KEY, JSON.stringify(value))") > -1, '写本机缓存')
  assert.ok(src.indexOf("fetchJson('/prefs', {") > -1, '写宿主状态文件')
  assert.ok(src.indexOf("method: 'POST'") > -1, '宿主写入用 POST')
  // loadFromHost 从 /state 的 prefs 恢复，且只在本地无缓存时覆盖
  assert.ok(src.indexOf('if (!prefsHydrated && body.prefs') > -1, '从宿主恢复偏好')
  assert.ok(src.indexOf('if (!prefsCached && prefsSeq === 0)') > -1,
    '本地无缓存且本次会话未改过档位时才由宿主恢复（防 /state 慢响应覆盖刚选的值）')
  assert.match(src, /const seq = \+\+prefsSeq/, '连点三档时用递增序号防乱序覆盖')
})

test('10b 模型列表不重合：任何点击先清 armed + 收紧菜单判定', () => {
  // 旧代码在「点击不在工作区行」时直接 return，armed 残留 2.5s，
  // 随后点模型列表（恰好 2 个 menuitem 的 [role=menu]）会被误注入。
  const armStart = src.indexOf('function arm(target) {')
  const armEnd = src.indexOf('function onCapture(event) {', armStart)
  const armBody = src.slice(armStart, armEnd)
  assert.ok(armBody.indexOf('armed = null') > -1, 'arm() 开头必须无条件清 armed')
  assert.ok(armBody.indexOf('armed = null') < armBody.indexOf('if (!target'), '清 armed 必须在任何 return 之前')

  // isWorkspaceMenu 现在不只靠「恰好 2 项」：还排除模型菜单的 xxx-menu id。
  const menuStart = src.indexOf('function isWorkspaceMenu(menu) {')
  const menuEnd = src.indexOf('}', src.indexOf('return true', menuStart)) + 1
  const menuBody = src.slice(menuStart, menuEnd)
  assert.ok(menuBody.indexOf('count !== 2') > -1, '保留原有的 2 项判定')
  assert.ok(menuBody.indexOf('/-menu$/') > -1, '排除模型选择器的 xxx-menu id')
  assert.equal(menuBody.indexOf('MENU_VIEWPORT_SELECTOR'), -1,
    '不得用 viewport 容器做正向判定：官方工作区菜单未必有，会把正常注入一起挡掉')
})

