# 归档工作区 · dsh-plugin-workspace-archive

**一键归档整个工作区，让侧边栏只留下你正在用的东西。**

![归档工作区](docs/banner.png)


---

## 安装

### 方式一：从 GitHub 安装

```bash
dsh plugin --profile <profile> add "git+https://github.com/<你的用户名>/dsh-plugin-workspace-archive.git"
```

### 方式二：本地开发

```bash
git clone https://github.com/<你的用户名>/dsh-plugin-workspace-archive.git
dsh plugin --profile <profile> add "link:/path/to/dsh-plugin-workspace-archive"
```

> **安装后需要重启一次 dsh 宿主。** 宿主侧的 JS 不热重载；浏览器半侧刷新页面即可。
> 如果你的 profile 由桌面应用独占管理，请在「设置 → 插件」中安装，或使用桌面版自带的 CLI。

卸载：

```bash
dsh plugin --profile <profile> remove dsh-plugin-workspace-archive
```

## 使用

| 操作 | 位置 |
| --- | --- |
| 归档工作区 | 工作区行右侧「…」→ **归档工作区** |
| 查看 / 恢复 | 侧边栏底部 **已归档工作区**（带数量角标） |
| 角标显示方式 | 面板标题右侧的三枚图标：**常驻显示** / **首次显示** / **永不显示**（悬停看名称） |

角标三档的含义：

- **常驻显示**：只要有归档记录，就一直显示当前数量。
- **首次显示**：只有出现**新的**归档时，才显示一个蓝色气泡；打开「已归档工作区」
  面板即视为已确认，气泡消失，直到你再次归档新的工作区。
- **永不显示**：角标始终隐藏，入口按钮仍在。

面板可直接按 `Esc` 或底栏「关闭」关闭。**0.1.6 起角标偏好保存在宿主状态文件**（与归档账本同一份文件），
重启 dsh 后不会回到默认的「常驻显示」；本机浏览器 `localStorage` 只作即时缓存。

**归档时发生了什么？**

1. 插件对该工作区下的全部会话逐个调用官方归档命令；
2. 全部成功后，把「工作区 → 会话 ID 名单」写入宿主状态文件；
3. 该工作区的会话全部归档后，工作区行随之从侧边栏消失——与它下面的会话
   保持一致的可见性。插件只在 DOM 上给这样的行加隐藏标记，
   **不读写、不改写**官方任何视图数据；
4. 归档完成后再向宿主问一次「这些会话的 Git 工作树被清掉没有」，
   有结果就用官方 toast 提示「已归档 · 清理了 N 个 Git 工作树」。

会话与历史记录**永远不会**被本插件删除。正在运行的会话无法归档，
菜单会提示「有会话正在运行，请先停止」。

### ⚠️ Git 工作树：dsh 0.2.2-rc.2 起的新行为

dsh **0.2.2-rc.2** 起，官方归档会话时会**默认清理**符合条件的工作树：

| 会被清理 | 会保留 |
| --- | --- |
| 是本次会话创建、且登记在 dsh 工作树池里的工作树 | 有未提交改动或未跟踪文件 |
| `git status` 干净 | 还有未归档的会话在用（含子代理祖先） |
| 分支与 `HEAD` 对得上 | 会话处于 `read-only` 沙箱档 |
| 位于配置的工作树池内、源仓库仍是该仓库顶层 | 含子模块、被 lock / prunable / detached |

**分支和提交永远保留**，被移除的只是工作目录和它的 worktree 登记。
但**恢复归档不会自动重建目录**——取消归档只还原会话与账本，
重建工作树要用 Forge 面板的「恢复工作树」，或手动 `git worktree add`。

想反过来「归档时一律保留工作树」，在 profile 的 `cordis.patch.yml` 里改官方配置：

```yaml
- id: worktree
  name: "@deepseek-ai/dsh-experimental-worktree"
  config:
    retainOnArchive: true      # 默认 false
```

> 本插件**不干预**清理决策，只如实转述结果：官方没有按次开关，
> 插件也不会替你重建工作树。上面的开关是官方配置，属于 profile 层。

**恢复时发生了什么？** 按账本里的会话名单逐个还原，全部成功才删除记录。
恢复最后一条记录后，「已归档工作区」面板会自动关闭。

## 数据与隐私

- 插件只在本地一个位置写入数据：
  `$DSH_HOME/storages/dsh-workspace-archive.json`（归档账本 + 角标偏好）
- 写入采用「原子 rename + 跨进程文件锁」，多窗口并发不会丢失记录；
- 不联网、不上传、不收集任何信息；不读取会话内容，只记录 ID 名单。

删除该文件即等同于放弃恢复入口（已归档的会话仍在官方归档里，可从官方入口恢复）。

## 兼容性

| 项 | 要求 |
| --- | --- |
| dsh | `0.2.1-rc.2` 及以上（工作树清理提示需 `0.2.2-rc.2` 及以上） |
| 依赖 | 无运行时第三方依赖 |

`/cleanup` 查询面在没挂 `@deepseek-ai/dsh-experimental-worktree` 的 profile 上
会自动降级（`supported: false`），菜单回到普通的「已归档」，其余功能不受影响。

## 常见问题

**Q：能不能只归档部分会话？**
单条会话请用官方自带的「归档会话」；本插件处理的是整个工作区。

**Q：归档后还能搜到这些会话吗？**
它们处于官方归档状态，行为与官方「归档会话」完全一致。

**Q：归档会清掉我的 Git 工作树吗？**
看 dsh 版本和 profile 配置。0.2.2-rc.2 起官方默认清理「干净且无人引用」的工作树，
分支与提交始终保留；把 `worktree.retainOnArchive` 设为 `true` 可一律保留。
本插件只提示结果，不改变这个行为。

**Q：和别的插件冲突吗？**
本插件不包装、不改写任何官方服务，只读取工作区快照，只在工作区行上添加一个
自带清理的隐藏标记，因此与其它插件无冲突。

**Q：归档后我正在看的那个会话还会留在列表里吗？**
会。官方不会把正在查看的会话藏起来，本插件也一样；切到别的会话再切回来，
该工作区行就和其他已归档工作区一样不再显示。

**Q：本来就没有任何会话的工作区，能归档吗？**
能。0.1.5 起，空工作区归档后同样会从工作区列表里消失，只在「已归档工作区」
面板里出现；点「恢复」即可回到列表。0.1.4 及以前这类工作区会两处同时显示，
这是已修复的 bug。

## 开发

```
package.json           dsh.bundle / dsh.client / exports / locale / icon
cordis.patch.yml       bundle 层（含幂等守卫，重复挂载不会注册两次路由）
lib/index.js           宿主半侧：状态文件 + /dsh-workspace-archive/{ping,state,archive,unarchive,prefs,cleanup}
client/client.js       浏览器半侧：contextMenus 菜单项 + 已归档面板 + 工作树清理提示
locale/{zh,en}.json    插件元数据文案
icon.svg               图标
```

宿主半侧用 Cordis 服务（`inject = ['webServer']`），浏览器半侧通过 `dsh.client`
声明注入点，所有注册挂在 `ctx.effect` 上，可完整卸载。

工作区行「…」菜单项走官方贡献接口（dsh 0.2.2-rc.2+）：

```js
ctx.inject(['contextMenus'], (scope) => scope.effect(() => scope.contextMenus.register({
  id: ID + '.workspace',
  target: 'workspace',      // resolve 收到 { workspaceId, path, displayTitle }
  order: 150,
  observe: () => [store],   // 账本/忙碌状态变化后重新 resolve
  resolve: (target) => [ /* { id, label, disabled?, failureLabel?, run } */ ],
}), ID + ': workspace menu'))
```

没有 `contextMenus` 的旧 dsh 自动退回 0.1.7 的 DOM 桥（点击捕获臂 + 菜单项克隆），
两条路径互斥，不会重复注入。


## 许可

MIT
