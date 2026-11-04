/**
 * dsh-plugin-workspace-archive — 浏览器半侧。
 *
 * 加载方式：模块系统把本文件作为 client bundle 提供给前端，文件本身必须调用
 * window.__ModuleLoader__.load({ id, factory }) 注册自己；id 必须与 package.json
 * 的 name 一致。
 *
 * 实现要点（全部有本机 0.2.1-rc.2 源码 / 实测依据）：
 *
 *  1. 工作区行的「…」菜单是官方硬编码的两项（rename / delete），没有可注入槽位
 *     （@deepseek-ai/dsh-client-ui-workspace lib/client.js 的 ProjectRowItem）。
 *     因此用「点击捕获臂 + MutationObserver」在菜单 portal 出现后追加一项，
 *     克隆官方菜单项的 class，视觉与交互一致。
 *     行选择器只用 [data-row-key^="workspace:"] —— 会话行是 session:<id>，
 *     永不命中，所以绝不会给会话行的「…」菜单加东西。
 *
 *  2. 归档动作调用官方 ctx.uiWorkspace.archiveSession（真归档，不是视图层隐藏）：
 *     逐个归档该工作区下所有会话，任一条失败就把已成功的全部 unarchive 回滚。
 *     成功后把「工作区 -> 被归档会话」记到宿主状态文件（POST /archive）。
 *
 *  3. 「隐藏」由官方归档本身完成：官方侧边栏在「工作区」分组模式下，只有存在
 *     *可见* 会话的工作区才渲染整行（@deepseek-ai/dsh-client-ui-workspace
 *     deriveGroups → groupByWorkspace：默认过滤器会剔除已归档会话，成员清零即
 *     不出行）。因此这里 **不再** 从 ctx.workspaces.list 的快照里删除工作区条目，
 *     也不再把会话并入 archivedSessionIds —— 两者叠加会让唯一可见项被隐藏后整棵
 *     列表塌成空状态，连其它工作区一起消失（0.1.0 的恶性 bug）。
 *     会话真归档状态由官方注册表管理，本插件只维护自己的账本。
 *
 *  4. 恢复入口：sidebar.footer.action 一个带计数的按钮 + shell.overlay 面板，
 *     列出已归档工作区，逐个工作区 unarchiveSession 后清掉宿主记录。
 *
 *  5. 只使用主题令牌 --dsw-alias-*，中英双语走 ctx.locale，不 import 任何
 *     Harness Client 包，所有注册都挂在 ctx.effect 上可完整卸载。
 */

;(() => {
  const ID = 'dsh-plugin-workspace-archive'
  const NS = ID
  const API = '/dsh-workspace-archive'

  const zh = {
    'menu.archive': '归档工作区',
    'menu.archiving': '正在归档…',
    'menu.archiveDone': '已归档',
    'menu.archiveFailed': '归档失败，请重试',
    'menu.running': '有会话正在运行，请先停止',
    'footer.open': '已归档工作区',
    'footer.aria': '已归档工作区 ({n})',
    'footer.ariaNew': '有新的归档工作区 ({n})',
    'panel.title': '已归档工作区',
    'panel.empty': '还没有归档任何工作区。',
    'panel.restore': '恢复',
    'panel.restoring': '恢复中…',
    'panel.restoreFailed': '恢复失败',
    'panel.sessionCount': '{n} 个会话',
    'panel.close': '关闭',
    'panel.badgeLabel': '角标',
    'panel.badgeAlways': '常驻显示',
    'panel.badgeNew': '首次显示',
    'panel.badgeNever': '永不显示',
    'common.untitled': '未命名工作区',
  }
  const en = {
    'menu.archive': 'Archive workspace',
    'menu.archiving': 'Archiving…',
    'menu.archiveDone': 'Archived',
    'menu.archiveFailed': 'Archive failed, retry',
    'menu.running': 'A session is running — stop it first',
    'footer.open': 'Archived workspaces',
    'footer.aria': 'Archived workspaces ({n})',
    'footer.ariaNew': 'New archived workspaces ({n})',
    'panel.title': 'Archived workspaces',
    'panel.empty': 'No archived workspaces yet.',
    'panel.restore': 'Restore',
    'panel.restoring': 'Restoring…',
    'panel.restoreFailed': 'Restore failed',
    'panel.sessionCount': '{n} sessions',
    'panel.close': 'Close',
    'panel.badgeLabel': 'Badge',
    'panel.badgeAlways': 'Always',
    'panel.badgeNew': 'On new',
    'panel.badgeNever': 'Never',
    'common.untitled': 'Untitled workspace',
  }

  const STYLE_ID = ID + '/style'
  const MENU_FLAG = 'data-dsh-wsa-item'
  const WORKSPACE_ROW_SELECTOR = '[data-row-key^="workspace:"]'
  const MENU_SELECTOR = '[role="menu"]'
  const MENU_ITEM_SELECTOR = '[role="menuitem"]'
  const MENU_VIEWPORT_SELECTOR = '[class*="viewport"]'
  const ARM_TTL_MS = 2500
  const ARCHIVE_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.2"><rect x="2.2" y="3.2" width="11.6" height="2.6" rx=".7"/><path d="M3.4 6.4h9.2v6.2a1.2 1.2 0 0 1-1.2 1.2H4.6a1.2 1.2 0 0 1-1.2-1.2V6.4Z"/><path d="M6.4 9.2h3.2" stroke-linecap="round"/></svg>'

  // 角标三态图标：实心（常驻）/ 点阵气泡（仅新）/ 空心（永不）
  const BADGE_ICONS = {
    always: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><rect x="2" y="4" width="9.5" height="8.5" rx="2" stroke="currentColor" stroke-width="1.3"/><circle cx="12.2" cy="3.8" r="2.4" fill="currentColor"/></svg>',
    new: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><rect x="2" y="4" width="9.5" height="8.5" rx="2" stroke="currentColor" stroke-width="1.3"/><circle cx="12.2" cy="3.8" r="2.4" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    never: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><rect x="2" y="4" width="9.5" height="8.5" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M10.4 2.2 14 5.8M14 2.2l-3.6 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  }

  /**
   * 所有颜色/圆角/边框一律走 --dsw-alias-* 主题令牌；唯一的字面量是
   * 几何数值（px）与布局用 z-index，不含任何颜色值。
   * 令牌名取自本机 0.2.1-rc.2 的 121 个 --dsw-alias-* 定义。
   */
  const CSS = `
[data-dsh-wsa-hidden]{display:none!important}
.${NS}-menu-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:0 0 16px}
.${NS}-menu-label{flex:1 1 auto;min-width:0}
.${NS}-footer{position:relative;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:28px;height:28px;min-width:28px;padding:0;margin:0;align-self:center;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.${NS}-footer:hover{background:var(--dsw-alias-interactive-bg-hover);color:inherit}
.${NS}-footer[aria-pressed="true"]{color:var(--dsw-alias-state-business-primary)}
.${NS}-badge{position:absolute;top:-1px;right:-3px;min-width:13px;height:13px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-inverted);font-size:9px;line-height:13px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none}
.${NS}-badge-new{animation:${NS}-pulse 1.6s ease-out infinite}
@keyframes ${NS}-pulse{0%{box-shadow:0 0 0 0 var(--dsw-alias-state-business-primary)}70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}
.${NS}-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:2px;flex:0 0 auto}
.${NS}-segbtn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.${NS}-segbtn svg{display:block}
.${NS}-segbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:inherit}
.${NS}-segbtn[aria-pressed="true"]{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.${NS}-tip{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);padding:3px 7px;border-radius:4px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.4;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .12s ease}
.${NS}-segbtn:hover .${NS}-tip,.${NS}-segbtn:focus-visible .${NS}-tip{opacity:1}
.${NS}-segbtn:focus-visible{outline:none}
.${NS}-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-overlay)}
.${NS}-dialog{width:480px;max-width:100%;max-height:calc(100vh - 96px);display:flex;flex-direction:column;box-sizing:border-box;padding:20px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px var(--dsw-alias-bg-mask-2);font-size:13px;line-height:1.6}
.${NS}-head{display:flex;align-items:center;justify-content:space-between;gap:12px;height:28px;margin-bottom:12px}
.${NS}-title{flex:1 1 auto;min-width:0;font-size:15px;font-weight:600;line-height:28px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${NS}-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0 0 14px}
.${NS}-list{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0}
.${NS}-row{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.${NS}-rowmain{flex:1 1 auto;min-width:0}
.${NS}-rowname{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${NS}-meta{color:var(--dsw-alias-label-secondary);font-size:12px}
.${NS}-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.${NS}-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.${NS}-btn:disabled{opacity:.45;cursor:default}
.${NS}-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.${NS}-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.${NS}-foot{display:flex;align-items:center;justify-content:flex-end;padding-top:12px;margin-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
`

  function makeT(dict) {
    return function (key, vars) {
      let text = (dict && dict[key]) || key
      if (vars && typeof vars === 'object') {
        for (const k of Object.keys(vars)) text = text.split('{' + k + '}').join(String(vars[k]))
      }
      return text
    }
  }

  function makeFactory() {
    return (require) => {
      const module = { exports: {} }
      const React = require('react')
      const h = React.createElement
      const { useEffect, useState } = React

      const name = ID
      // 对齐官方增强插件的做法：把会直接访问的服务声明为硬依赖，
      // 避免 Cordis 代理在未 inject 的属性上抛错导致整块 UI 空白。
      const inject = ['locale', 'slots', 'workspaces', 'uiWorkspace', 'sessions']

      /* ---------------- 共享状态 ---------------- */
      // archives: Map<workspaceId, {workspaceId, archivedAt, sessionIds}>
      const archives = new Map()
      const busy = new Set()
      const listeners = new Set()
      let version = 0
      let panelOpen = false
      // 角标模式：'always' 常驻显示数量 | 'new' 只在新归档出现时显示气泡 | 'never' 不显示
      const BADGE_MODES = ['always', 'new', 'never']
      let badgeMode = 'always'
      // 工作区 id -> 本次归档写入的会话 id 集合；用于判断某工作区的成员是否全部处于归档态。
      const archivedSessions = new Map()
      // 'new' 模式下次新气泡的判定依据：false = 有未确认的新归档。
      // 用布尔而不是计数，避免「恢复一个又归档一个」时数量不变而漏报。
      let acked = true

      function notify() {
        version += 1
        for (const fn of [...listeners]) { try { fn() } catch (_) {} }
      }
      function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
      function getVersion() { return version }
      function snapshot() {
        return {
          version,
          panelOpen,
          badgeMode,
          acked,
          busy: [...busy],
          items: [...archives.values()].map((r) => ({ ...r })),
        }
      }
      function useShared() {
        const [state, setState] = useState(snapshot)
        useEffect(() => subscribe(() => setState(snapshot())), [])
        return state
      }
      /** 角标是否该显示、显示什么：null 表示不显示。 */
      function badgeView(state) {
        const count = state.items.length
        if (state.badgeMode === 'never' || count === 0) return null
        if (state.badgeMode === 'always') return { count, isNew: false }
        return state.acked ? null : { count, isNew: true }
      }
      function setPanelOpen(v) {
        panelOpen = v
        // 用户看到了「已归档工作区」列表，就算确认过当前这批归档。
        if (v && badgeMode === 'new' && !acked) {
          acked = true
          persistPrefs()
        }
        notify()
      }
      function setBadgeMode(mode) {
        if (BADGE_MODES.indexOf(mode) === -1) return
        badgeMode = mode
        // 切到「首次显示」时视作已确认当前这批，避免刚切换就冒出气泡。
        if (mode === 'new') acked = true
        persistPrefs()
        notify()
      }
      function rawSnapshot() {
        if (model && typeof model.getSnapshot === 'function') {
          try { return model.getSnapshot() } catch (_) { /* 模型暂不可用 */ }
        }
        return { items: [], archivedSessionIds: [] }
      }
      function workspaceMeta(workspaceId) {
        const raw = rawSnapshot()
        const items = Array.isArray(raw?.items) ? raw.items : []
        const item = items.find((w) => w && w.workspaceId === workspaceId)
        return {
          title: (item && item.title) || '',
          path: (item && item.path) || '',
        }
      }

      /* ---------------- 宿主状态同步 ---------------- */
      function fetchJson(path, options) {
        const f = typeof fetch === 'function' ? fetch : null
        if (!f) return Promise.reject(new Error('fetch unavailable'))
        return f(API + path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}))
          .then((r) => r.json().then((j) => ({ ok: r.ok, body: j }), () => ({ ok: false, body: {} })))
      }
      /* ---------------- 角标偏好（仅本机浏览器 localStorage） ---------------- */
      const PREFS_KEY = ID + '.prefs.v1'
      function prefsStorage() {
        try {
          return win && win.localStorage ? win.localStorage : null
        } catch (_) { return null }
      }
      function loadPrefs() {
        const s = prefsStorage()
        if (!s) return
        try {
          const raw = s.getItem(PREFS_KEY)
          if (!raw) return
          const parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== 'object') return
          if (BADGE_MODES.indexOf(parsed.badgeMode) !== -1) badgeMode = parsed.badgeMode
          if (typeof parsed.acked === 'boolean') acked = parsed.acked
        } catch (_) { /* 存储不可用或被禁用时用默认值 */ }
      }
      function persistPrefs() {
        const s = prefsStorage()
        if (!s) return
        try { s.setItem(PREFS_KEY, JSON.stringify({ badgeMode, acked })) } catch (_) {}
      }

      function loadFromHost() {
        return fetchJson('/state').then(({ ok, body }) => {
          if (!ok || !body || body.ok !== true || !body.archives || typeof body.archives !== 'object') return
          let changed = false
          for (const [id, rec] of Object.entries(body.archives)) {
            if (typeof id !== 'string' || !id || !rec || typeof rec !== 'object') continue
            const next = {
              workspaceId: id,
              archivedAt: typeof rec.archivedAt === 'number' ? rec.archivedAt : Date.now(),
              sessionIds: Array.isArray(rec.sessionIds) ? rec.sessionIds.filter((s) => typeof s === 'string') : [],
            }
            archivedSessions.set(id, new Set(next.sessionIds))
            const prev = archives.get(id)
            if (!prev || prev.sessionIds.join('\0') !== next.sessionIds.join('\0')) {
              archives.set(id, next)
              changed = true
            }
          }
          if (changed) notify()
        }).catch(() => { /* 宿主未就绪时保持空名单，不阻塞 UI */ })
      }
      /** 写账本必须确认成功：宿主 500 / 状态损坏时绝不能当成已落盘。 */
      function persistArchive(workspaceId, record) {
        return fetchJson('/archive', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, sessionIds: record.sessionIds }),
        }).then((r) => {
          if (!r.ok || !r.body || r.body.ok !== true) throw new Error('archive state write failed')
          return r.body
        })
      }
      function persistUnarchive(workspaceId) {
        return fetchJson('/unarchive', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        }).then((r) => {
          if (!r.ok || !r.body || r.body.ok !== true) throw new Error('unarchive state write failed')
          return r.body
        })
      }

      /* ---------------- 官方命令封装 ---------------- */
      let activeCtx = null
      function safeGet(serviceName) {
        if (!activeCtx) return null
        try {
          if (typeof activeCtx.get === 'function') return activeCtx.get(serviceName) || null
        } catch (_) { /* 服务不存在时 Cordis 可能抛错 */ }
        try { return activeCtx[serviceName] || null } catch (_) { return null }
      }
      function archiveCommand(action) {
        const ui = safeGet('uiWorkspace')
        const ws = safeGet('workspaces')
        const fnName = action === 'archive' ? 'archiveSession' : 'unarchiveSession'
        if (ui && typeof ui[fnName] === 'function') return (sid, opts) => ui[fnName](sid, opts)
        if (ws && typeof ws[fnName] === 'function') return (sid, opts) => ws[fnName](sid, opts)
        return null
      }

      /**
       * 当前在主视图里打开的会话 id（官方每次 new MainReference 都会递增
       * retainedBy.mainView，卸载后归零）。取不到就返回 undefined。
       */
      function currentSessionId() {
        try {
          const sessions = safeGet('sessions')
          const list = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
            ? sessions.list.getSnapshot() : null
          const ids = Array.isArray(list?.ids) ? list.ids : []
          for (const id of ids) {
            const s = list.byId && list.byId[id]
            if (s && typeof s === 'object' && (s.retainedBy?.mainView ?? 0) > 0) return id
          }
        } catch (_) {}
        return undefined
      }

      /**
       * 归档一个工作区：真归档该工作区下的会话（保留当前正在查看的那条）。
       *
       * 「工作区从侧边栏消失」由官方归档本身实现：官方在工作区分组模式下只渲染
       * 至少还有一条可见会话的工作区。这里绝不再插手 workspaces.list 快照——
       * 0.1.0 的恶性 bug 正是因为快照投影把唯一可见的工作区也删掉，整棵列表塌成
       * 空状态，其它工作区一并消失。
       *
       * 当前正在查看的会话故意保留：官方的 watchNavigation 会清掉已归档的当前会话，
       * 用户眼前的内容不该因为归档工作区而突然消失。该会话仍记在账本里，恢复时
       * 会连同其余会话一起回到工作区。
       */
      async function executeArchive(workspaceId) {
        const raw = rawSnapshot()
        const items = Array.isArray(raw?.items) ? raw.items : []
        const item = items.find((w) => w && w.workspaceId === workspaceId)
        if (!item) return { ok: false, reason: 'workspace-not-found' }
        const baseArchived = new Set(Array.isArray(raw?.archivedSessionIds) ? raw.archivedSessionIds : [])
        const doArchive = archiveCommand('archive')
        const doUnarchive = archiveCommand('unarchive')
        if (!doArchive || !doUnarchive) return { ok: false, reason: 'no-command' }

        const keep = currentSessionId()
        busy.add(workspaceId); notify()
        const done = []
        const rollback = async () => {
          for (const prev of done) { try { await doUnarchive(prev) } catch (_) {} }
        }
        try {
          // 归档开始时的成员快照，逐个真归档。
          for (const sid of (Array.isArray(item.sessionIds) ? item.sessionIds : [])) {
            if (typeof sid !== 'string' || baseArchived.has(sid) || done.includes(sid)) continue
            if (sid === keep) continue
            try {
              // 绝不替用户停掉正在跑的会话：官方命令会因 workspace/session-active 拒绝。
              await doArchive(sid, { stopActivity: false })
              done.push(sid)
            } catch (error) {
              await rollback()
              const msg = (error && error.message) || String(error)
              return { ok: false, reason: /running|active|busy/i.test(msg) ? 'running' : 'failed' }
            }
          }
          // 归档期间可能新增会话：重取一次快照，把新出现的也归档并记入账本，
          // 避免「被视图层隐藏但不在恢复名单里」造成永久丢失。
          const after = rawSnapshot()
          const afterItem = (Array.isArray(after?.items) ? after.items : []).find((w) => w && w.workspaceId === workspaceId)
          if (afterItem && Array.isArray(afterItem.sessionIds)) {
            for (const sid of afterItem.sessionIds) {
              if (typeof sid !== 'string' || done.includes(sid)) continue
              if (sid === keep) continue
              try {
                await doArchive(sid, { stopActivity: false })
                done.push(sid)
              } catch (_) {
                await rollback()
                return { ok: false, reason: 'failed' }
              }
            }
          }
          const prev = archives.get(workspaceId)
          const record = {
            workspaceId,
            archivedAt: Date.now(),
            sessionIds: [...new Set([...(prev ? prev.sessionIds : []), ...done])],
          }
          // 先落账本，成功才改内存视图：账本写失败时会话能整体回滚。
          try {
            await persistArchive(workspaceId, record)
          } catch (_) {
            await rollback()
            return { ok: false, reason: 'persist-failed' }
          }
          archives.set(workspaceId, record)
          archivedSessions.set(workspaceId, new Set(record.sessionIds))
          // 出现新归档 → 'new' 模式下冒出新气泡，直到用户打开面板看到它。
          acked = false
          persistPrefs()
          notify()
          return { ok: true }
        } finally {
          busy.delete(workspaceId); notify()
        }
      }

      /** 恢复一个工作区：按账本全量 unarchive，全成功才清记录，失败整组回滚。 */
      async function executeUnarchive(workspaceId) {
        const record = archives.get(workspaceId)
        const doUnarchive = archiveCommand('unarchive')
        const doArchive = archiveCommand('archive')
        if (!record || !doUnarchive || !doArchive) return { ok: false }
        busy.add(workspaceId); notify()
        const restored = []
        try {
          for (const sid of record.sessionIds) {
            if (typeof sid !== 'string' || restored.includes(sid)) continue
            try {
              await doUnarchive(sid)
              restored.push(sid)
            } catch (_) {
              for (const prev of restored) { try { await doArchive(prev, { stopActivity: false }) } catch (_) {} }
              return { ok: false }
            }
          }
          try {
            await persistUnarchive(workspaceId)
          } catch (_) {
            for (const prev of restored) { try { await doArchive(prev, { stopActivity: false }) } catch (_) {} }
            return { ok: false }
          }
          archives.delete(workspaceId)
          archivedSessions.delete(workspaceId)
          // 恢复的是最后一条记录时，面板已没有可看的内容，直接收起。
          if (archives.size === 0) panelOpen = false
          notify()
          return { ok: true }
        } finally {
          busy.delete(workspaceId); notify()
        }
      }

      /* ---------------- workspaces.list 只读快照（不做投影） ---------------- */
      // 只保留一个对 model 的引用用于取原始快照；绝不改写 getSnapshot/subscribe。
      let model = null
      function installProjection(ctx) {
        let service = null
        try { service = typeof ctx.get === 'function' ? ctx.get('workspaces') : null } catch (_) { service = null }
        if (!service) { try { service = ctx.workspaces || null } catch (_) { service = null } }
        model = service && service.list
        if (!model || typeof model.getSnapshot !== 'function') model = null
        return () => { model = null }
      }

      /* ---------------- ⋯ 菜单注入（DOM 桥） ---------------- */
      function installStyles(doc) {
        if (!doc || typeof doc.getElementById !== 'function') return () => {}
        const existing = doc.getElementById(STYLE_ID)
        if (existing) return () => { if (existing.remove) existing.remove() }
        const style = doc.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        ;(doc.head || doc.documentElement).appendChild(style)
        return () => { const el = doc.getElementById(STYLE_ID); if (el && el.remove) el.remove() }
      }

      function closeShippedMenu(doc, win) {
        try {
          const target = doc.activeElement || doc.body || doc.documentElement
          if (!target || typeof target.dispatchEvent !== 'function') return
          const Ctor = (win && typeof win.KeyboardEvent === 'function') ? win.KeyboardEvent
            : (typeof KeyboardEvent === 'function' ? KeyboardEvent : null)
          if (!Ctor) return
          target.dispatchEvent(new Ctor('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
        } catch (_) {}
      }

      /** 克隆官方菜单项的 wrapper + button class，保证外观一致。 */
      function createMenuItem(doc, menu, workspaceId, t) {
        const sample = menu.querySelector(MENU_ITEM_SELECTOR)
        const sampleWrap = sample && sample.parentElement ? sample.parentElement : null
        const wrap = doc.createElement('div')
        if (sampleWrap && typeof sampleWrap.className === 'string' && sampleWrap.className) wrap.className = sampleWrap.className
        const button = doc.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        button.className = (sample && typeof sample.className === 'string' && sample.className) ? sample.className : ''
        const icon = doc.createElement('span')
        icon.className = NS + '-menu-icon'
        const label = doc.createElement('span')
        label.className = NS + '-menu-label'
        if (sample) {
          const si = sample.querySelector('span')
          if (si && typeof si.className === 'string' && si.className) icon.className = si.className
          const sl = sample.querySelector('span:last-child')
          if (sl && typeof sl.className === 'string' && sl.className) label.className = sl.className
        }
        button.appendChild(icon)
        button.appendChild(label)
        wrap.appendChild(button)
        wrap.setAttribute(MENU_FLAG, '')
        wrap.setAttribute('data-dsh-wsa-workspace', workspaceId)
        if (typeof icon.innerHTML === 'string') icon.innerHTML = ARCHIVE_SVG
        label.textContent = t('menu.archive')

        const parts = { wrap, button, label, resetTimer: null, reset: null }
        parts.reset = () => { if (parts.label) parts.label.textContent = t('menu.archive') }
        button.addEventListener('click', (event) => {
          if (event && event.preventDefault) event.preventDefault()
          if (event && event.stopPropagation) event.stopPropagation()
          if (busy.has(workspaceId)) return
          label.textContent = t('menu.archiving')
          executeArchive(workspaceId).then((result) => {
            if (result.ok) {
              label.textContent = t('menu.archiveDone')
              closeShippedMenu(doc, win)
            } else {
              label.textContent = result.reason === 'running' ? t('menu.running') : t('menu.archiveFailed')
              if (parts.resetTimer) clearTimeout(parts.resetTimer)
              parts.resetTimer = setTimeout(parts.reset, 2600)
              if (typeof timerSink === 'function') timerSink(parts.resetTimer)
            }
          })
        })
        return parts
      }

      let win = typeof window === 'undefined' ? null : window
      /** 由 installDomBridge 安装：DOM 桥内创建的延时器统一登记，卸载时清理。 */
      let timerSink = null
      function installDomBridge(doc, t) {
        if (!doc || typeof doc.addEventListener !== 'function' || !doc.body) return () => {}
        let armed = null
        let disposed = false
        let scheduled = false
        const disposers = []
        const timers = new Set()
        timerSink = (tm) => timers.add(tm)

        function arm(target) {
          if (!target || typeof target.closest !== 'function') return
          const row = target.closest(WORKSPACE_ROW_SELECTOR)
          if (!row || typeof row.getAttribute !== 'function') return
          const key = row.getAttribute('data-row-key')
          if (typeof key !== 'string' || !key.startsWith('workspace:')) return
          // 点击必须落在工作区行内的按钮上才武装（该行只有 ⋯ 与「新建会话」，
          // 后者不打开菜单，无害）；任何其它点击都清掉 armed，
          // 避免上一次残留串到随后打开的会话/视图选项菜单。
          // 完全不依赖 aria-label 文案，因此任意 locale 都成立。
          const trigger = target.closest('button')
          if (trigger && row.contains(trigger)) {
            armed = { workspaceId: key.slice('workspace:'.length), rowKey: key, until: Date.now() + ARM_TTL_MS }
          } else {
            armed = null
          }
        }
        function onCapture(event) {
          if (disposed) return
          arm(event && event.target)
          // 点击本身就是「即将开菜单」的明确信号；主动排一次扫描，
          // 不单纯依赖 MutationObserver（菜单若复用同一 portal 节点则无 DOM 变更）。
          schedule()
        }
        function onKeyCapture(event) {
          if (disposed || !event) return
          // Esc 关闭已归档面板。捕获阶段处理并阻止继续冒泡，
          // 避免同一次 Esc 又被上层对话框/菜单消费掉。
          if (event.key === 'Escape' && panelOpen) {
            event.preventDefault()
            event.stopPropagation()
            setPanelOpen(false)
            return
          }
          if (event.key === 'Enter' || event.key === ' ') { arm(event.target); schedule() }
        }
        function schedule() {
          if (disposed || scheduled) return
          scheduled = true
          const run = () => { scheduled = false; if (!disposed) scan() }
          if (typeof setTimeout === 'function') setTimeout(run, 0)
          else run()
        }
        function isWorkspaceMenu(menu) {
          // 主判定：官方工作区菜单恰好 2 个 menuitem（rename / delete）。
          // 会话菜单由槽位扩展，项数 > 2；视图选项菜单项数也不为 2。
          const items = typeof menu.querySelectorAll === 'function'
            ? menu.querySelectorAll(MENU_ITEM_SELECTOR) : []
          const count = items.length || (Array.isArray(items) ? items.length : 0)
          if (count !== 2) return false
          return true
        }
        /**
         * 方案 A：让工作区行的可见性与「它下面的会话都归档了」保持一致。
         *
         * 官方 groupByWorkspace 在默认筛选下对空成员组仍然出组（只有 archivedFilter
         * === 'only' 才跳过），所以会话全归档后工作区行会留下来、里面空空如也。
         * 这里只在 DOM 上把这种行隐藏，不触碰任何官方数据：
         *   - 只读 ctx.workspaces / ctx.sessions 的快照做判断；
         *   - 判定条件极保守，任一环节取不到数据就当作「不隐藏」；
         *   - 已经隐藏的行，只要重新看到任意一条未归档会话就立刻还原；
         *   - 用 data 属性标记而非改 style，卸载/热重挂时可直接摘除。
         */
        const HIDE_ATTR = 'data-dsh-wsa-hidden'
        function syncRowVisibility() {
          if (disposed) return
          try {
            const wsSnapshot = model && typeof model.getSnapshot === 'function' ? model.getSnapshot() : null
            if (!wsSnapshot || !Array.isArray(wsSnapshot.items)) return
            const archivedNow = new Set(Array.isArray(wsSnapshot.archivedSessionIds) ? wsSnapshot.archivedSessionIds : [])
            const sessionsService = safeGet('sessions')
            const sessionList = sessionsService && sessionsService.list && typeof sessionsService.list.getSnapshot === 'function'
              ? sessionsService.list.getSnapshot() : null
            const current = currentSessionId()
            const rows = doc.querySelectorAll(WORKSPACE_ROW_SELECTOR)
            for (let i = 0; i < rows.length; i += 1) {
              const row = rows[i]
              const rowKey = row.getAttribute('data-row-key') || ''
              const workspaceId = rowKey.slice('workspace:'.length)
              const workspace = wsSnapshot.items.find((w) => w && w.workspaceId === workspaceId)
              let hide = false
              if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.length > 0) {
                // 本插件归档过的会话 + 官方当前归档集合，二者任一命中即算已归档。
                const mine = archivedSessions.get(workspaceId) || null
                const isArchived = (sid) => archivedNow.has(sid) || (mine !== null && mine.has(sid))
                // 官方视为「本来就不渲染」的成员（子代理、非当前空白会话）不参与判定：
                // 它们永远不进 members，拿它们要求“已归档”会让行永远隐藏不掉。
                const visibleMembers = []
                for (const sid of workspace.sessionIds) {
                  if (typeof sid !== 'string' || !sid) continue
                  const summary = sessionList && sessionList.byId ? sessionList.byId[sid] : null
                  if (summary) {
                    if (summary.origin === 'subagent') continue
                    if (summary.blank === true && sid !== current) continue
                  }
                  visibleMembers.push(sid)
                }
                hide = visibleMembers.length > 0 && visibleMembers.every((sid) => sid !== current && isArchived(sid))
              }
              if (hide) { if (!row.hasAttribute(HIDE_ATTR)) row.setAttribute(HIDE_ATTR, '') }
              else if (row.hasAttribute(HIDE_ATTR)) row.removeAttribute(HIDE_ATTR)
            }
          } catch (_) { /* 结构变化时宁可不动 UI */ }
        }

        function scan() {
          if (armed && Date.now() > armed.until) armed = null
          syncRowVisibility()
          const menus = Array.from(doc.querySelectorAll(MENU_SELECTOR))
          for (const menu of menus) {
            if (menu.querySelector('[' + MENU_FLAG + ']') !== null) continue
            if (!armed || !isWorkspaceMenu(menu)) continue
            // 来源行必须仍在 DOM 里，且 id 与 armed 一致，杜绝「点 B 归档 A」。
            const row = doc.querySelector('[data-row-key="' + armed.rowKey + '"]')
            if (!row) { armed = null; continue }
            const workspaceId = armed.workspaceId
            armed = null
            const viewport = menu.querySelector(MENU_VIEWPORT_SELECTOR) || menu
            const parts = createMenuItem(doc, menu, workspaceId, t)
            viewport.appendChild(parts.wrap)
          }
        }
        doc.addEventListener('pointerdown', onCapture, true)
        doc.addEventListener('click', onCapture, true)
        doc.addEventListener('keydown', onKeyCapture, true)
        disposers.push(() => {
          doc.removeEventListener('pointerdown', onCapture, true)
          doc.removeEventListener('click', onCapture, true)
          doc.removeEventListener('keydown', onKeyCapture, true)
        })
        const Ctor = (win && typeof win.MutationObserver === 'function') ? win.MutationObserver
          : (typeof MutationObserver === 'function' ? MutationObserver : null)
        if (Ctor) {
          const observer = new Ctor(schedule)
          try { observer.observe(doc.body, { childList: true, subtree: true }) } catch (_) {}
          disposers.push(() => { try { observer.disconnect() } catch (_) {} })
        }
        disposers.push(subscribe(schedule))
        schedule()
        return function dispose() {
          disposed = true
          timerSink = null
          for (const tm of timers) if (tm) clearTimeout(tm)
          for (const fn of disposers) { try { fn() } catch (_) {} }
          // 关键：移除本插件注入的菜单项。否则热重挂后旧节点仍带 MENU_FLAG，
          // scan 会跳过注入，而旧节点的闭包已失效 → 菜单项永久失灵。
          try {
            const nodes = doc.querySelectorAll('[' + MENU_FLAG + ']')
            for (const node of nodes) { if (node && typeof node.remove === 'function') node.remove() }
          } catch (_) {}
          // 隐藏标记必须一起摘掉，否则插件卸载/热重挂后行会永久隐身。
          try {
            const hidden = doc.querySelectorAll('[' + HIDE_ATTR + ']')
            for (const node of hidden) { if (node && typeof node.removeAttribute === 'function') node.removeAttribute(HIDE_ATTR) }
          } catch (_) {}
        }
      }

      /* ---------------- 槽位 UI ---------------- */
      function FooterButton(props) {
        const state = useShared()
        const t = props.t
        const count = state.items.length
        const badge = badgeView(state)
        return h('button', {
          type: 'button',
          className: NS + '-footer',
          title: t('footer.open'),
          'aria-label': badge ? t('footer.ariaNew', { n: count }) : t('footer.aria', { n: count }),
          'aria-pressed': state.panelOpen ? 'true' : 'false',
          onClick: () => setPanelOpen(!state.panelOpen),
        },
        h('span', { 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: ARCHIVE_SVG } }),
        badge
          ? h('span', {
            className: NS + '-badge' + (badge.isNew ? ' ' + NS + '-badge-new' : ''),
            'data-new': badge.isNew ? 'true' : undefined,
          }, String(badge.count))
          : null)
      }

      function ArchivedRow(props) {
        const rec = props.rec
        const t = props.t
        const shared = props.shared
        const meta = workspaceMeta(rec.workspaceId)
        const isBusy = shared.busy.indexOf(rec.workspaceId) !== -1
        return h('div', { className: NS + '-row' },
          h('div', { className: NS + '-rowmain' },
            h('div', { className: NS + '-rowname' }, meta.title || t('common.untitled')),
            h('div', { className: NS + '-meta' },
              t('panel.sessionCount', { n: rec.sessionIds.length }),
              meta.path ? ' · ' + meta.path : '')),
          h('button', {
            type: 'button',
            className: NS + '-btn ' + NS + '-btn-primary',
            disabled: isBusy,
            onClick: () => { executeUnarchive(rec.workspaceId) },
          }, isBusy ? t('panel.restoring') : t('panel.restore')))
      }

      function ArchivedOverlay(props) {
        const state = useShared()
        const t = props.t
        if (!state.panelOpen) return null
        return h('div', {
          className: NS + '-overlay',
          onClick: (e) => { if (e.target === e.currentTarget) setPanelOpen(false) },
        },
        h('div', { className: NS + '-dialog', role: 'dialog', 'aria-modal': 'true' },
          // 标题与三枚角标图标同一行、垂直居中；面板用下方「关闭」与 Esc 关闭。
          h('div', { className: NS + '-head' },
            h('div', { className: NS + '-title' }, t('panel.title')),
            h('div', { className: NS + '-toolbar', role: 'group', 'aria-label': t('panel.badgeLabel') },
            [['always', 'panel.badgeAlways'], ['new', 'panel.badgeNew'], ['never', 'panel.badgeNever']]
              .map(([mode, key]) => h('button', {
                key: mode,
                type: 'button',
                className: NS + '-segbtn',
                title: t(key),
                'aria-label': t(key),
                'aria-pressed': state.badgeMode === mode ? 'true' : 'false',
                onClick: () => setBadgeMode(mode),
              },
              h('span', { className: NS + '-tip', 'aria-hidden': 'true' }, t(key)),
              h('span', { 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: BADGE_ICONS[mode] } }))))),
          h('div', { className: NS + '-list' },
            state.items.length === 0
              ? h('div', { className: NS + '-empty' }, t('panel.empty'))
              : state.items.map((rec) => h(ArchivedRow, { key: rec.workspaceId, rec, t, shared: state }))),
          h('div', { className: NS + '-foot' },
            h('button', { type: 'button', className: NS + '-btn', onClick: () => setPanelOpen(false) }, t('panel.close')))))
      }

      /* ---------------- apply ---------------- */
      function apply(ctx) {
        activeCtx = ctx
        const doc = typeof document === 'undefined' ? null : document
        win = typeof window === 'undefined' ? null : window
        let dict = zh
        let t = makeT(dict)
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), ID + ': dictionaries')
          const bound = ctx.locale.bind(NS)
          t = (key, vars) => {
            try {
              const value = bound(key, vars)
              if (typeof value === 'string' && value !== key) return value
            } catch (_) {}
            return makeT(dict)(key, vars)
          }
          try {
            const loc = ctx.locale.getLocale && ctx.locale.getLocale()
            dict = loc && String(loc.id || loc.locale || '').startsWith('en') ? en : zh
          } catch (_) {}
        } catch (_) { /* locale 缺失时退回内置字典 */ }

        loadPrefs()
        ctx.effect(() => installStyles(doc), ID + ': styles')
        ctx.effect(() => installProjection(ctx), ID + ': projection')
        ctx.effect(() => installDomBridge(doc, t), ID + ': menus')
        ctx.effect(() => { loadFromHost(); return () => {} }, ID + ': bootstrap')

        // slots.inject 的返回是 disposer：用 ctx.effect 包住，卸载/热重挂时
        // 两块槽位注册会被完整摘掉，不会残留重复条目。
        ctx.effect(() => {
          const offs = []
          try {
            offs.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
              name: 'sidebar.footer.action', id: ID + '-footer', order: 60,
              label: () => t('footer.open'),
            }, () => h(FooterButton, { t }))))
            offs.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
              name: 'shell.overlay', id: ID + '-panel', order: 70,
              label: () => ID,
            }, () => h(ArchivedOverlay, { t }))))
          } catch (_) { /* 无 slots 时 DOM 桥与状态仍可用 */ }
          return () => { for (const off of offs) { try { if (typeof off === 'function') off() } catch (_) {} } }
        }, ID + ': slots')

        ctx.effect(() => () => {
          archives.clear()
          busy.clear()
          listeners.clear()
          activeCtx = null
        })
      }

      module.exports = { apply, inject, name }
      return module.exports
    }
  }

  try {
    window.__ModuleLoader__.load({ id: ID, factory: makeFactory() })
  } catch (error) {
    const message = String((error && error.message) || error)
    if (!/duplicate factory registration/i.test(message)) throw error
  }
})()
