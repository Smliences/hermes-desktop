# Hermes Desktop Client 优化提交代码审核报告（`1365fd5..8042cdc`）

- **审核日期**：2026-11-27
- **审核范围**：`1365fd5..8042cdc`（共 6 次提交，43 个文件，`+6867 / -5154` 行）
- **对照基线**：`docs/2026-11-27-ui-feature-optimization.md`
- **自动化验证实跑**：
  - `npm run test:contracts`：`308 通过 / 0 失败`（但存在局部切片失真导致的断言弱化，见第三节）
  - `npm run pack:check`：`10 通过 / 0 失败`
  - `npm run test:ui`：`107 通过 / 0 失败`
  - `scripts/test-services.js`：本轮 **0 行新增单测**

---

## 总体结论：**不建议直接按「全部完成」收尾**

### 已扎实落地的亮点
- 20 个拆分后的前端脚本全部通过语法检查，不存在顶层 `const`/`let`/`function` 重复声明或同步加载时序崩溃；
- 深色模式 `.pp-add:hover`（对比度 11.63:1）、滚动条、`--meta-fg`（5.07:1，达 WCAG AA）与 `prefers-color-scheme` 动态监听已生效；
- `renderer/assets/hermes-logo.png` 已升级至 `256 × 256` px；
- `.md-code-copy` 重复监听去重、`hermes-tools.js` `setTool()` 串行队列、`.rkb-dot` 状态圆点、`rail-resize.js` 偏好宽恢复、`ui-select.js` 视口测量与 `aria-activedescendant`、侧栏冗余入口精简、工具历史参数还原均已验证落地。

### 核心风险
- 存在 **10 个 Blocker 级缺陷**（含必抛 `ReferenceError`、未定义 CSS 变量导致新 UI 隐身、属性碰撞打断看板跳转、上游协议不匹配致修复失效、5 处 100% 死代码、`npm ci` 破坏）；
- 存在一批高优先级状态竞态、交互回退与样式层叠反转问题；
- `docs/2026-11-27-ui-feature-optimization.md` 中 **14 / 31** 项已勾选 `[x]` 的条目存在未实现、仅做一半或严重 Bug。

---

## 一、Blocker 级问题（必须优先修复）

### B1. `send()` 异常分支必抛 `ReferenceError: visible is not defined`
- **位置**：`renderer/input/composer.js:132-137`
- **现象与根因**：`catch (e)` 内第 135 行写 `if (!visible) tab.unread = true;`，但 `send()` 作用域内从未声明 `visible`。
- **后果**：`api.send(payload)` 一旦 reject，第 135 行立即抛 `ReferenceError`，跳过后续 `renderChat()` / `syncActivityBar()` / `syncComposerState()` / `setActivity('空闲')`，界面永久卡死在「思考中 / 停止按钮」。
- **修复建议**：改为 `if (tab.id !== state.activeTabId) tab.unread = true;`（并同步调用 `renderSessions()`）。

### B2. 新增 CSS 引用 4 个不存在的变量，导致「回到底部」重影透明、侧栏后台状态点隐身
- **位置**：`renderer/styles.css:3334-3367`
- **现象与根因**：使用了全仓未定义的 `--card`、`--shadow`、`--warn`、`--danger`（真实 token 为 `--canvas`、`--elev`、`--yellow`、`--red`）：
  - `.scroll-bottom-pill` 的 `background: var(--card); box-shadow: var(--shadow);` 失效，无背景直接叠在聊天文字上重影；
  - `.s-dot.running { background: var(--warn); }` 透明不可见；
  - `.s-dot.approval { background: var(--danger); color: var(--canvas); }` 背景透明且前景色与侧栏底色接近，后台待审批 `!` 徽标隐身。
- **修复建议**：替换为 `--canvas`、`--elev`、`--yellow`、`--red`。

### B3. 预览区与看板抽屉内长代码块死锁在 260px，表格复制按钮完全失效
- **位置**：`renderer/preview/preview.js:150-158, 235`、`renderer/kanban-drawer.js:314-315`、`renderer/chat/markdown.js:61-65`、`renderer/app.js:1010-1060`
- **现象与根因**：`mdCodeBlock()` 对 `>30` 行代码默认加 `.collapsed`（`max-height: 260px`），但 `.md-code-fold` 与 `.md-table-copy` 点击委托仅挂在 `$('#chat')`（未挂到 `document`）。
- **后果**：右侧预览栏打开任意超过 30 行的源码文件时，点击「展开全部 (N 行)」完全无响应；预览与看板抽屉内的表格复制按钮同样失效。
- **修复建议**：将 `.md-code-fold` 与 `.md-table-copy` 的事件委托提升至 `document`（与 `markdown.js:148` 的 `.md-code-copy` 保持一致）。

### B4. 看板 `data-kb-run` 属性名碰撞，打断兄弟任务跳转并导致 1s 秒表永不停止
- **位置**：`renderer/kanban-drawer.js:147, 159, 230`、`renderer/kanban.js:329-346`、`renderer/kanban-core.js:291`
- **现象与根因**：运行进度卡 `<div class="kbd-prog" data-kb-run="${start}">` 用 `data-kb-run` 驱动 1s 秒表，新加的运行记录按钮也用了 `data-kb-run="${esc(r.id)}"`。
- **后果**：
  1. `kanban.js:329` 在 `[data-kb-task]` 之前拦截 `[data-kb-run]` 并无条件 `return`，导致 `.kbd-prog-sibs` 内同 profile 兄弟任务链接点击彻底失效；
  2. `kbRunTick()` 查询 `[data-kb-run]`，打开任何带运行记录的已完成抽屉后秒表 `setInterval` 永不自停；
  3. 另：`kanban.js:338` 缺少 `KB.detailEpoch` 守卫，无 `kanbanRun` 时永远停在「读取运行详情…」。
- **修复建议**：运行记录按钮改用 `data-kb-run-id`，并限定事件委托仅匹配 `button[data-kb-run-id]`，补 `KB.detailEpoch` 守卫与 `.kbd-run-detail` 样式。

### B5. 小窗跨页签审批「UI 假通过、后端静默拒收」+ 审批计数永久泄漏
- **位置**：`main/main.js:457, 1077-1094`、`main/services/hermes-chat.js:558-566, 769-779`
- **现象与根因**：
  1. `main.js:1090` 推送实时审批给小窗时未按 `tabId` 过滤；后台页签 B 触发审批推入小窗后，用户点「允许」触发 `respondApproval(requestId, choice, orbCtx && orbCtx.tabId)` 传入的是页签 A 的 `tabId`，`hermes-chat.js:772` 校验不匹配直接 `return false` 不发 RPC，但 `main.js` 未检查返回值照样广播「已允许」；
  2. 同一 `requestId` 被重复提交时不校验 `activeApprovals.delete(requestId)`，会多扣 `pendingApprovals` 把其他待决审批红标清零；
  3. 后端重启/切 Profile 时 `_denyAllApprovals()` 不通知 `main.js`，导致 `activeApprovals`、`pendingApprovals` 与 Dock 红标永久残留。
- **修复建议**：实时推小窗按 `tabId` 过滤（或审批卡自带 `req.tabId` 回传）；检查 `chat.respondApproval()` 返回值并用 `activeApprovals.size` 作为单一真源；`_denyAllApprovals()` 回调清理 `main.js` 挂起审批并同步小窗/球态。

### B6. 心跳发阻塞的 `ping` 而非 `gateway.ping`，慢 RPC 下误杀健康连接 + 断线无收敛
- **位置**：`main/services/gateway-client.js:7, 95-110`、`main/services/hermes-chat.js:621-624`
- **现象与根因**：对照上游 `tui_gateway/ws.py`，只有 `gateway.ping` 在 WS 读循环免排队直接回包；发 `ping` 会进串行 `_dispatch_loop`，一旦同连接存在耗时 `>25s` 的 RPC（冷启 `session.create` / `slash.exec`），两次 10s 超时即 `ws.terminate()` 误杀健康连接；`.catch()` 还缺少 `this.ws === sock` 守卫；WS 断开后 `hermes-chat.js` 也未收敛 `activeTurns` 或作废失效 `tab.liveId`。
- **修复建议**：心跳改发 `'gateway.ping'` 并按 `const sock = this.ws` 守卫；`hermes-chat.js` 在 WS 断线超过宽限期时收敛在途回合与失效 `liveId`。

### B7. `tool.complete` 的 `is_error` 与上游真实协议不匹配（实际恒为 `false`）
- **位置**：`main/services/hermes-chat.js:312-319`
- **现象与根因**：仅检查顶层 `p.is_error || p.error || p.status === 'error'`，但上游 `ToolCompletePayload` 顶层没有这三个字段，失败信息在 `p.result` 内部（`terminal` 看 `result.exit_code !== 0`；通用工具看 `result.success === false`、`result.error`）。
- **修复建议**：补充解析 `p.result` 内部错误字段（同时兼容顶层 `is_error`/`error`），并新增对应服务层单测。

### B8. `Escape` 栈存在冒泡穿透：关 `#chip-menu` / `#palette` 会穿透关子页或中止回合
- **位置**：`renderer/chat/slash.js:234, 335-341`、`renderer/shortcuts/shortcuts.js:321-361`
- **现象与根因**：`#chip-menu` 捕获阶段监听与 `#palette-input` 的 `keydown` 处理 `Escape` 后均未调 `e.stopPropagation()`，自身隐藏后事件继续冒泡到 `window` 的 `shortcuts.js`，导致同一次 Esc 连同底层 `.subpage` 一起关闭或触发 `$('#btn-stop').click()`。
- **修复建议**：两处 `Escape` 命中后立即 `e.preventDefault(); e.stopPropagation();`；`closeAllOverlays()` 关闭 `#chip-menu` 时同步调用 `chipMenuCleanup()` 清理监听。

### B9. 五处「100% 死代码 / 静默失效」的新增特性
1. **看板拖拽边缘自动滚动**（`renderer/kanban-board.js:195-224`、`renderer/styles/kanban.css:287, 443`）：`const board = $('#kb-columns') || $('#kb-scroll')` 恒选中无滚动条的 `#kb-columns`（`overflow: visible`），而非真正滚动容器 `#kb-scroll`（`overflow: auto`）；纵向 `.kb-col-body` 滚动未实现。
2. **看板终态桌面通知 & 点击跳转**（`main/main.js:737-749`、`renderer/app.js:1226`）：`main.js` 读不存在的 `r.board.columns` 并按 `Array.isArray` 过滤对象数组导致永不触发；点击通知后 `app.js:1226` 调不存在的 `openKanbanPage()`（应为 `showKanban(true)`）。
3. **市场 `known_issues` 原文**（`main/services/hermes-market.js:208`、`renderer/market-plugins.js:529-538`）：后端未修改，仍只返回整数长度 `issues`，前端读取 `known_issues`/`knownIssues` 恒为空。
4. **设置页模型提供商「只读 · 打开配置」**（`renderer/settings.js:386`、`main/services/hermes-config.js:104`）：前端传参 `'providers.json'`，后端白名单键名为 `'providersJson'`，IPC 返回 resolved `{ ok: false }` 不进 `.catch()`，点击完全无响应。
5. **小窗字号同步三连断**（`renderer/chat/stream.js:187`、`main/main.js:433-442, 1135-1147`、`renderer/orb-chat.css:266`）：`stream.js` 读不存在的 `state.config.fontSize`（实际在 `SettingsStore`）→ `main.js` 丢弃 `fontSize` 未转发 → `orb-chat.css` `.oc-body` 写死 `font-size: 13px`。

### B10. `package-lock.json` 未同步移除 `node-pty`，破坏 `npm ci`
- **位置**：`package.json:25-30` vs `package-lock.json:18-20, 3372-3385`
- **现象与根因**：`package.json` 已删除 `optionalDependencies.node-pty` 和 `postinstall`，但 `package-lock.json` 未同步更新，干净环境执行 `npm ci` 会直接报错失败。

---

## 二、高优先级 Bug（状态竞态、交互回退与样式回归）

### 2.1 对话流、输入区与侧栏
1. **流式 `rAF` 节流竞态与停止后光标常驻**（`renderer/chat/stream.js:558-572`、`renderer/input/composer.js:150, 357-365`）：`renderChat` / `tool_use` / `result` / `#btn-stop` 均未 `cancelAnimationFrame(tab._rafText)`，16ms 内到达 `tool_use` 会误删工具 `.typing-msg`；停止后未把末条 `assistant` 置 `done = true`，闪烁光标常驻。
2. **`_userScrolledAway` 跨页签未清零 & 悬浮遮挡**（`renderer/chat/stream.js:447-467`、`renderer/styles.css:3335`）：挂在共享 DOM `#chat-scroll` 上但切换会话不重置；`#scroll-bottom-btn` 与 `#model-drift` 定位重叠。
3. **消息排队（`tab.queued`）后台丢队、60ms 切页签串台与停止残留**（`renderer/input/composer.js:65-73, 175-178, 357-365`）：`handleClose` 仅在 `visible` 时出队且 `setTimeout(() => send(next.text), 60)` 读取全局 `activeTab()`，切页签会把 A 会话排队消息发进 B 会话；点停止未清空 `tab.queued`，且无队列展示/取消 UI。
4. **`openSession()` 传参错位导致历史会话草稿无法恢复**（`renderer/sidebar/sessions.js:725-734` vs `renderer/app.js:295`）：调用 `newTab(null, sessionId, true)` 把 `sessionId` 传给了 `title`，导致 `restoreDraftFor` 读不到历史草稿；复用空 tab 时也未先保存原草稿与取消 `_draftTimer`。
5. **侧栏后台状态点不会实时刷新**（`renderer/app.js:337-340, 1110-1130`、`renderer/chat/stream.js:660`、`renderer/input/composer.js:117, 363`）：状态切换处仍只调用死桩 `renderTabs()` 而非 `renderSessions()`。
6. **侧栏搜索与日期口径仍未修完**（`renderer/app.js:371`、`main/services/hermes-sessions.js:57-66, 159`、`renderer/sidebar/sessions.js:15, 108`）：`app.js:371` 仍写死 `listSessions({ limit: 200, search: '' })`，超过 200 条的老会话按标题/ID 搜索仍漏召回；`listSessions` 未选 `last_activity_at`，分桶（不含 `ended_at`）与右侧日期（含 `ended_at`）仍错位。
7. **Markdown 渲染与代码高亮瑕疵**（`renderer/chat/markdown.js:7-14, 34-41`、`renderer/chat/stream.js:359`）：`renderInline` 图片正则早于行内代码提取，破坏反引号内的 `![alt](url)`；`highlightCode` 不分语言把 CSS `#faf9f5`/`#chat`、C `#include`、JS `this.#x`、Python `//` 染成注释；工具卡预览按钮用 `JSON.stringify(item.input)` 的 `.pop()` 可能误取文件内容里的路径而非 `file_path`。
8. **预览区 `drop` 导致 `body.dropping` 橙框永久粘滞**（`renderer/preview/preview.js:493-523`）：阻断冒泡后未执行 `document.body.classList.remove('dropping')`。

### 2.2 主进程与服务层
9. **菜单 `{ role: 'close' }`（`⌘W`）破坏小球闭环与 macOS Dock 恢复**（`main/main.js:1175-1179, 1211, 1223, 1229`）：在 `orbChat`/`orb` 聚焦按 `⌘W` 直接销毁窗口绕过收起回调；关掉主窗后若隐藏球窗尚存，`BrowserWindow.getAllWindows().length > 0` 导致点 Dock 图标再也打不开主窗。
10. **后台报错发双重矛盾通知 & 小窗聊天时狂弹通知**（`main/main.js:596-621, 1095`）：`onClose` 未判断 `summary.error` / `exitCode !== 0`，报错后紧接着弹「回复已完成」；后台判定未排除 `orbChat` 正打开/聚焦；`new Notification` 未持有引用防 GC。
11. **`render-process-gone` 未过滤正常退出且「关闭」按钮无效**（`main/main.js:187-198`）：未忽略 `clean-exit`，点击 `response === 1`（「关闭」）无任何动作。
12. **`hermes-chat.js` 推理切换与事件驱动连接竞态**（`main/services/hermes-chat.js:159-221, 687`）：`session.resume` 使用默认模型时改 `reasoning` 失效、`slash.exec` 失败仍写入 `tab.reasoning` 致永不重试、清空 `reasoning` 被短路；单一字段 `this._onGwConnect` 在并发 `_ensureGateway()` 时互相覆盖。
13. **`hermes-sessions.js` 合并 SQL 失去单点降级 & 缓存竞态**（`main/services/hermes-sessions.js:78-84, 190-202`）：`storageStats()` 9 个子查询合进一条 SQL 加空 `catch`，旧库缺 `archived/hidden/pinned` 任一列即全量归零；`messageColumns()` `sqliteExec` 未传局部 `db` 参数。
14. **上游 Kanban Schema 差异与长度截断**（`main/services/hermes-kanban.js:92, 351-352`）：上游当前 `CreateTaskBody` 不接收 `session_id`、`Task` 表无 `updated_at`（建议标注上游限制）；`cleanText(..., 80)` 截断与全仓 128 位 `SESSION_ID_RE` 不一致。

### 2.3 看板、设置、市场、Gateway 与小窗
15. **看板抽屉轮询保护漏洞 & Markdown 样式破坏**（`renderer/kanban-drawer.js:83-102`、`renderer/styles/kanban.css:644`、`renderer/kanban-board.js:470`）：报错路径仍覆盖未保存编辑；展开日志后执行写操作被 `busyView` 拦下不刷新；`.kbd-text` 保留 `white-space: pre-wrap` 放大块间空行；网格视图非归档卡片 tooltip 错报「已归档」。
16. **Gateway 启停无防重入锁 + `.env` 边界错误**（`renderer/app.js:793, 944-981`、`main/services/hermes-gateway.js:59-64, 135-137, 197-200`、`renderer/shortcuts/shortcuts.js:339`）：`gwRunAction()` 60s 期间未禁用按钮也无 busy 锁；`cliStatus()` 丢弃 `r.error`；`TOKEN="" # comment` 误判非空；`hasCredentials`/`configured`/`enabled` 仍用 `some()`；关页不清理确认卡与输出框，按 Esc 跳过 `#gw-confirm` 直接关整页。
17. **设置页 `approvalMode` / 确认弹窗 / `#set-hint` 残留**（`renderer/settings.js:229, 1374, 1402, 1474`）：保存 `approvalMode` 调错 `syncComposerState()` 未刷 `#chip-yolo`、`newTab()` 未读；`.pf-switch-confirm` 无法 `Esc` 关闭且按钮用不存在的 `.btn` 类；`general` dirty 态切 `kanban` 再切回仍残留看板提示文案；`renderHealthPanel` 缺 `epoch` 守卫。
18. **小窗 `case 'error'`、Esc 竞态与拖拽清状态**（`renderer/orb-chat.js:305-310, 396-403, 451-462`）：`case 'error'` 漏 `applyTurnState(false)` 与结束跳动占位气泡；`stop()` 未置 `S.running = false` 致连按两次 Esc 关不掉窗；`moved` 推 `side` 触发 `if (S.running) setStatus('')` 抹掉运行状态文案。

### 2.4 样式系统回归
19. **去 `zoom: 1.1` 后侧栏与红绿灯/图标栏纵向错位 ~5px**（`renderer/styles.css:114-184`）：`#iconrail` 按 1.1 标定到 `y=65px`，而 `#sidebar` 内的 `.sb-head` 仍为 `36.4px`，与红绿灯及 40px `#chat-head` 错位 3.6px，收起/展开侧栏发生明显跳动。
20. **`kanban.css` 加载在 `styles.css` 之后导致层叠优先级反转**（`renderer/index.html:7-8`、`renderer/styles.css:3103-3247`、`renderer/styles/kanban.css:70-80`）：原 `styles.css` 尾部残留的 `.kb-p-add`、`.kb-btn.danger`、`.kb-pmkdir input` 等 10 个类的覆写规则现在被 `kanban.css` 反向覆盖。
21. **轨迹空态无样式**（`renderer/chat/stream.js:55-56`）：`.trace-empty` / `.te-title` / `.te-sub` / `.btn` 无任何 CSS 定义，按钮退化成纯文字；且 `thinking` 被 `hasTraceSteps` 排除。

---

## 三、Checklist `[x]` 真实性与测试/卫生核查

### 3.1 `docs/2026-11-27-ui-feature-optimization.md` 名实不符项（14 / 31）

| Checklist 行号 | 宣称已完成的 `[x]` 内容 | 实际代码现状 |
|---|---|---|
| L503 (P0) | 小窗核心修复 | `case 'error'` 残留占位气泡、Esc 连按竞态、跨页签审批假通过 |
| L506 (P0) | 看板数据与轮询修复 | `data-kb-run` 碰撞打断兄弟任务跳转并致秒表永停；轮询报错覆盖编辑态；网格 tooltip 错报已归档 |
| L510 (P1) | 主进程原生通知与菜单（含看板终态通知） | 看板终态通知 100% 死代码（`r.board.columns` + `openKanbanPage`）；报错双通知；`⌘W` 破坏球态与 Dock 恢复 |
| L511 (P1) | 侧栏活动项目高亮与移出项目选项 | **未实现**：无活动项目高亮，`openMoveToProjectMenu` 仍排除无项目选项 |
| L512 (P1) | Esc 单层返回与替换 `window.confirm()` | `#chip-menu`/`#palette` Esc 穿透；`.pf-switch-confirm` 逃逸 Esc 且缺 `.btn` 样式；`#gw-confirm` 逃逸 Esc |
| L513 (P1) | 设置页 `#set-hint`、`approvalMode`、`epoch` 守卫 | dirty 态切 `kanban` 仍残留提示；`approvalMode` 未刷 `#chip-yolo` 且 `newTab()` 未读；健康检查缺 `epoch` 守卫 |
| L516 (P1) | 轨迹视图升级（含筛选汇总条） | **缺筛选汇总条**，空态无 CSS 样式，纯思考会话被误判空态 |
| L517 (P1) | 对话↔看板联动 & **运行日志自动 tail** | **无自动 tail 轮询**（仅手动刷新滚底）；`.kbd-text` `pre-wrap` 破坏排版；抽屉表格复制/代码折叠失效 |
| L518 (P1) | 粘贴图片、图片缩略图、队列、复制 ID | 不支持截图粘贴、无图片缩略图、队列无 UI 且后台丢队/切页签串台、`#st-session` 无点击复制 |
| L519 (P1) | 市场详情透出 `known_issues` 原文等 | `hermes-market.js` 未改，**`known_issues` 100% 死代码**；筛选排序/局部更新/`showPlugin`/已安装卸载均未做 |
| L524 (P2) | 小窗尺寸持久化、拔屏收敛、基础 Markdown | `savedSize` 仅内存变量重启即丢；小球未听拔屏；无粗体/列表/链接；字号同步三连死代码 |
| L525 (P2) | 模型提供商快捷打开配置、看板拖拽边缘滚动 | **两项 100% 死代码**：`providers.json` 键名错、`#kb-columns` 无滚动条 |
| L527 (P2) | 清理 `node-pty` / 补齐 `mock-bridge.js` | `package-lock.json` 未清 `node-pty`；`mock-bridge.js` 仅补 3 行（含不存在的 `notifyDesktop`），仍缺 **48/111** 方法 |
| L528 (储备) | Gateway 页改良 | 缺启停防重入锁、`cliStatus` 丢 `r.error`、`.env` 注释空值误判、关页不清确认卡/输出框 |

### 3.2 测试与仓库卫生问题
1. **`scripts/test-contracts.js` 局部切片失真**：`shortcuts.js` 排在 `app.js` 之前导致 `pvApp`/`railApp`（L3818-3820）切片终点为 `-1`，退化为匹配 295 KB 几乎全仓代码；`openSession` 切片（L272-274, L3803-3805）跨文件吞入 `markdown.js` + `slash.js`；L1388 放宽 `kbCss → cssSrc` 掩盖了 10 个 `.kb-*` 类未迁入 `kanban.css` 的事实。
2. **零新增服务单测**：`scripts/test-services.js` 未随本轮大量主进程/服务层改动补充行为单测，致使协议与并发问题全部漏过 CI。
3. **误提交草稿文件**：`docs/kanban_plan.md` 是拆分前的过时内部讨论稿（引用本机 `/tmp/kb-shots` 与「四、需要你拍板的点」），随 `bfe65a7` 意外入库，建议删除。

---

## 四、建议修复 Checklist（按执行顺序）

### 第一批：Blocker 止血
- [ ] 修复 `renderer/input/composer.js:135` 未定义 `visible` 引发的 `ReferenceError`
- [ ] 修复 `renderer/styles.css:3334-3367` 4 个未定义 CSS 变量（`--card`/`--shadow`/`--warn`/`--danger` → `--canvas`/`--elev`/`--yellow`/`--red`）
- [ ] 将 `.md-code-fold` 与 `.md-table-copy` 点击委托提升至 `document`（解决预览区与看板抽屉失效）
- [ ] 看板运行记录按钮改用 `data-kb-run-id`，解除与 `[data-kb-run]` 秒表及兄弟任务跳转的冲突
- [ ] 修复小窗跨页签审批过滤、`chat.respondApproval()` 返回值校验、用 `activeApprovals.size` 替代漂移计数，并接通 `_denyAllApprovals()` 同步回调
- [ ] `gateway-client.js` 心跳改用 `'gateway.ping'` + `this.ws === sock` 守卫；`hermes-chat.js` 补 WS 断线宽限期收敛
- [ ] `hermes-chat.js` `tool.complete` 补解析 `p.result` 内部错误状态（`exit_code`/`success`/`error`）
- [ ] `renderer/chat/slash.js:234, 339` 补 `e.stopPropagation()` 消除 `Escape` 穿透
- [ ] 修复 5 处死代码：`kanban-board.js:195` 改滚 `#kb-scroll`、`main.js:737` 改遍历 `r.columns` & `app.js:1226` 改调 `showKanban(true)`、`hermes-market.js:208` 透出 `knownIssues`、`settings.js:386` 改为 `'providersJson'`、打通小窗 `fontSize` 三端链路
- [ ] 重新同步 `package-lock.json` 移除 `node-pty`，并删除误提交的 `docs/kanban_plan.md`

### 第二批：高危竞态与样式回归
- [ ] 为 `tab._rafText` 补齐 `cancelAnimationFrame`，停止时置末条 `assistant.done = true`
- [ ] 修复切页签清 `_userScrolledAway`、`openSession()` `newTab` 参数顺序与草稿保存恢复、`tab.queued` 防跨页签串台与停止清空、状态变化同步 `renderSessions()`
- [ ] 修复 `⌘W` 与球窗/主窗恢复、`onClose` 出错重复通知、小窗聚焦免打扰、`render-process-gone` 过滤 `clean-exit` 与关闭动作
- [ ] 修复 `hermes-chat.js` `_onGwConnect` 并发覆盖与 `session.resume` 推理同步边界；修复 `hermes-sessions.js` `storageStats` 单点降级与标题搜索 200 条截断
- [ ] 修复 Gateway `gwRunAction` 防重入锁、`cliStatus` 透出 `r.error`、`.env` 注释空值、关页清理与 `Esc` 优先级
- [ ] 修复设置页 `approvalMode` 调 `updateStatus()`、`.pf-switch-confirm` 改用 `mk-btn` 并入 `Esc` 栈、`#set-hint` dirty 残留；修复看板抽屉 `white-space: normal` 与轮询报错保护；修复小窗 `case 'error'` 与 `Esc` 竞态
- [ ] 校准去 `zoom` 后 `.sb-head` 40px 高度对齐，将残留 10 个 `.kb-*` 样式迁入 `kanban.css` 消除层叠反转，补 `.trace-empty` 样式并修复 `preview.js` 清 `body.dropping`

### 第三批：测试加固与 Checklist 对齐
- [ ] 修复 `scripts/test-contracts.js` 中 `pvApp`/`railApp`/`openSession` 切片失真
- [ ] 在 `scripts/test-services.js` 补齐心跳、`tool.complete` 判错、推理切换、审批超时、Gateway `.env`、Tools 队列行为单测
- [ ] 对照 `docs/2026-11-27-ui-feature-optimization.md`，将未真正落地项（运行日志自动 tail、小窗尺寸落盘、轨迹筛选汇总条、活动项目高亮/移出项目、`mock-bridge.js` 对齐等）补齐或据实回退为 `[ ]`
