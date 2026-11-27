# Hermes Desktop Client UI 与功能优化方案

- **文档日期**：2026-11-27
- **基线提交**：`1365fd5`（`main`）
- **覆盖范围**：渲染层（`renderer/`）、主进程（`main/`）、预加载桥（`preload/`）、服务层（`main/services/`）、构建与契约测试（`scripts/`、`electron-builder.yml`）
- **设计基线**：延续暖纸色系双主题视觉规范（Anthropic 暖中性 + 陶土橘强调、发丝描边）、Electron `sandbox: true` + `contextIsolation: true` 安全边界、桌面端不擅写 `~/.hermes` 约定。

---

## 文档元信息与总体评估

### 1. 现状定位与已知边界

当前仓库已具备较完整的桌面端骨架：常驻 `hermes serve --isolated` + WebSocket JSON-RPC 流式对话、SQLite 只读历史与 FTS5 搜索、多 Profile 隔离切换、插件/技能缓存与市场搜索、右侧「预览 / 看板」可调宽双页签、看板 1~3 期交互升级，以及桌面小球 + 迷你聊天窗双窗协同。

在规划优化时需尊重以下既有边界：

1. **安全与权限隔离**：渲染层无 Node 权限，Token / CLI 路径 / 本地文件系统写操作收口在 `main/` 与 `main/services/`；`preload/preload.js`、`preload/orb-preload.js`、`preload/orb-chat-preload.js` 严格按最小暴露面设计。
2. **配置所有权**：Profile 选择与桌面端模型覆盖保存在 Electron `userData`，不擅改 `~/.hermes/active_profile` 或 CLI 默认配置；写 CLI `config.yaml` / 触发辅助模型计费的操作（如看板拆解、补规格、估算、Cron/MCP/工具开关）必须保留显式用户确认闸门。
3. **消息平台线冻结声明**：`main/main.js:807` 与 `README.md:337` 已明确「消息平台接入页（Gateway）」当前阶段保持只读冻结；相关改良项在本文档中单列为「解冻后候选」，不与现行 P0/P1 冲突。
4. **契约约束**：`scripts/test-contracts.js` 当前大量使用静态正则/子串断言校验 `renderer/app.js`、`renderer/styles.css`、`renderer/index.html`、`preload/preload.js` 与服务端实现；任何重构与拆分都必须同步维护或升级对应契约。

### 2. 优先级定义

- **P0（缺陷止血）**：真实影响日常使用的交互破损、状态错乱、事件丢失、静默失败或深浅主题不可读问题。优先落地、风险可控、投入产出比最高。
- **P1（核心高频体验与三端联动）**：补齐桌面原生能力（通知/菜单/几何记忆）、统一跨页视觉与设置心智、打通「对话 ↔ 看板 ↔ 预览」闭环、消除明显的性能卡顿。
- **P2（能力深化与工程架构清债）**：富文本与视图增强、小窗能力对齐、逐步拆解巨石文件与样式冗余、清理废弃原生依赖与低分资源、补齐集成测试盲区。

### 3. 各模块痛点分布总览

| 模块 | P0 项数 | P1 项数 | P2 项数 | 核心矛盾 |
|---|---|---|---|---|
| 对话流、Markdown、工具卡与轨迹视图 | 2 | 4 | 2 | 抢滚动与流式重复节点、命令全文不可见、轨迹视图上下文残缺 |
| Composer、状态条与侧栏导航 | 2 | 5 | 1 | `↑/↓` 坏掉、后台多页签隐形与串台、侧栏入口冗余 |
| 双主题、样式系统与跨页一致性 | 5 | 5 | 3 | 深色模式多处破损、`Esc` 链缺 `return`、4227 行 CSS 覆盖膨胀 |
| 右侧栏（预览与紧凑看板） | 1 | 4 | 1 | 拖放冒泡误附加、状态圆点失色、历史入口被锁死在空态 |
| 设置、插件/技能与市场页 | 6 | 6 | 2 | 市场索引串卡与重建卡顿、设置底部栏语义割裂、`approvalMode` 死设置 |
| 小球模式与迷你聊天窗 | 2 | 3 | 3 | 未开窗时审批卡丢失、工具行样式失效、错误静默吞掉 |
| 看板联动、后端协议、桌面基建与架构 | 6 | 9 | 7 | `updated_at` 漏投影、轮询冲毁抽屉、`tool.complete` 硬编码成功、无原生通知 |

---

## 一、UI 与交互体验优化方案

### 1.1 对话流、Markdown、工具卡与轨迹视图

1. **【P0】修复流式输出强制抢滚动，补充「回到底部」悬浮按钮**
   - **源码定位**：`renderer/app.js:1896-1900`（`scrollBottom`）、`renderer/index.html:142-149`
   - **现状与根因**：`scrollBottom()` 检查 `if (!force && sc._userScrolledAway) return;`，但全仓从未给 `#chat-scroll` 绑定 `scroll` 事件写入 `_userScrolledAway`。流式输出每收到一个 `text` delta 或工具事件都会强行拉回底部，用户无法上滚回顾上下文。
   - **优化方案**：
     - 给 `#chat-scroll` 绑定 `scroll` 监听，计算 `sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 48` 动态更新 `sc._userScrolledAway`。
     - 仅在用户主动发送新消息（`scrollBottom(true)`）或点击底部按钮时复位贴底状态。
     - 在 `#chat-scroll` 底部 / `#composer-wrap` 上方增加 `position: absolute` 悬浮胶囊按钮「↓ 回到底部」（在 `_userScrolledAway === true` 时显示；若当前页签 `running === true` 附带脉冲圆点提示有新内容到达）。
   - **验收标准**：流式输出期间向上滚动页面不再被强制拉回；点「↓ 回到底部」立即滚底并恢复自动跟随。

2. **【P0】修复流式期间 `flushTurnFoot()` 触发的重复助手气泡问题**
   - **源码定位**：`renderer/app.js:1592-1606, 1994-1996`
   - **现状与根因**：`renderChat()` 中的 `flushTurnFoot()` 未判断当前 `assistant` 项是否已完成（`done`）。若流式输出途中触发整页重绘（如延迟到达的 `thinking` 块或切回页签），`#chat.lastElementChild` 会变成 `.msg-foot-row` 而非 `.msg-assistant`，下一个 `text` delta 走 `else chat.appendChild(node)` 会额外追加重复正文节点。
   - **优化方案**：
     - `flushTurnFoot()` 仅对本轮已结束或非流式在途态的回合挂载 `.msg-foot-row`（在 `tab.running` 且位于最后一轮末尾时延后至 `handleClose` 再挂）。
     - 流式 `text` delta 更新改用弱引用或为流式消息节点绑定唯一 ID / `item` 匹配查找目标 DOM，不再假设其恒为 `#chat.lastElementChild`。
   - **验收标准**：流式途中触发 `thinking` 插入、展开工具或切换页签再切回，不会出现双份助手消息气泡。

3. **【P1】补齐工具调用卡片完整命令展示、展开态保持与 Diff 准确性**
   - **源码定位**：`renderer/app.js:224-236, 288-316, 1813, 1840-1845, 4566-4572`、`renderer/styles.css:602-614, 771-782`
   - **现状与根因**：
     - `toolObject()` 将命令行压成首行并截断到 60 字符，`toolDetailHTML()` 对命令类直接返回 `toolStdoutHTML()` 且刻意省略命令行，`.tool-row` 的 `title` 只填工具名，导致多行或超 60 字的 `terminal`/`bash` 命令在 UI 任何地方都看不到全文；
     - `applyAutoCollapse()` 在回合结束时无条件置 `i.open = false`，覆盖了 `item.open` 的手动选择；
     - `toolExtra()` 仅计算 `newLines - oldLines` 净差值，原地改写 5 行显示 `+0 −0`；
     - 顶层 `.tool-item` 展开前后 padding/margin 变化（`2px 6px / -6px` → `5px 8px 8px / -8px`）引起点击轻微跳位；Diff `.dv-g` 仅靠背景色区分增删。
   - **优化方案**：
     - 命令类工具详情头部增加可复制的完整命令行区块（默认最多展示 6 行可滚动/展开）。
     - 引入 `item.userToggled` 标记，用户点击过某工具行后 `applyAutoCollapse()` 不再覆盖其展开状态。
     - `toolExtra()` 改由 `lineDiff()` 统计实际新增/删除行数；Diff 行首增加 `+` / `−` 前缀字符；固定 `.tool-stream > .tool-item` 的水平 padding/margin 消除跳位。
     - 文件类工具（`read_file`/`write_file`/`patch`）在详情头或 `.tobj` 旁提供「在右侧预览 / 访达中显示」快捷按钮；为 `mcp_*` 等工具提供专属插头图标区分于未知工具。
   - **验收标准**：长命令在工具详情区完整可见且可一键复制；手动展开的工具行在回合结束后保持展开；等行替换正确显示 `+N −N`。

4. **【P1】修复 Markdown 行内代码污染、重复复制监听并扩充基础 GFM**
   - **源码定位**：`renderer/app.js:41-53, 82-131, 133-143, 4698-4705`
   - **现状与根因**：
     - `renderInline()` 未先提取行内 `` `code` `` 占位，直接跑 `**`、`*`、`[]()` 正则，导致 `` `a**b**` `` 内部被渲染出 `<strong>`；
     - `.md-code-copy` 同时在 `document`（`133-143`）与 `#chat`（`4698-4705`）注册了两套点击委托，点一次触发两次剪贴板写入，且 1.2s 内连点会把按钮文字永久锁死在 `已复制`；
     - 缺少 `h4–h6`、嵌套缩进列表、`~~删除线~~`、任务列表 `- [ ]`、裸 URL 自动链接及 4 反引号/`~~~` 围栏；`<details>` 体强制剥离内部标签无法渲染格式化内容。
   - **优化方案**：
     - `renderInline()` 优先抽离行内代码并替换为 `\u0000C...\u0000` 占位符，其余正则执行完毕后再回填。
     - 删除 `app.js:4698-4705` 的重复监听，仅保留统一的全局委托并防重入重置定时器。
     - 标题支持扩展至 `h1–h6`，列表支持按缩进层级嵌套渲染，补充 `~~del~~` 与任务列表复选框（只读展示）。
   - **验收标准**：行内代码包含 `*`/`_`/`[]()` 原样显示；代码块复制按钮连点多次后正常恢复为「复制」。

5. **【P1】增强「轨迹（Trace）」视图可用性与上下文完整度**
   - **源码定位**：`renderer/app.js:1466-1468, 1535, 1613-1619, 1990, 2022, 3105`
   - **现状与根因**：无工具调用的会话切到「轨迹」页呈现彻底空白（`#landing` 被隐藏）；仅保留 `tool`/`error`，丢失触发该组调用的 `user` 提问、`thinking` 推理、危险操作 `approval` 与斜杠 `command`；历史会话加载工具固定 `input: null` 且无耗时/错误态；在轨迹页发消息不切回对话视图导致页面无任何可见反馈。
   - **优化方案**：
     - 无轨迹项时展示空态引导卡片（提示当前会话暂无工具调用或斜杠记录，提供「回到对话」按钮）。
     - 轨迹视图按「用户提问轮次」组织，保留提问摘要行、推理折叠条、审批卡、命令卡及平铺工具步骤；顶部增加轻量汇总过滤条（总步数 / 失败数 / 总耗时 / 仅看失败 / 全部展开收起）。
     - 历史会话读取 `messages.tool_calls` 中已解析的参数还原 `input`，并从关联 `role === 'tool'` 内容推断失败态展示。
     - 在轨迹视图发送普通消息时自动切回 `chat` 视图（或保持工具实时追加的同时在顶部提示已开始新轮次）。
   - **验收标准**：任意会话切至「轨迹」均不出现无意义纯白屏；可一眼分辨每组工具归属哪一轮用户提问并按状态过滤。

6. **【P2】富文本渲染增强（代码高亮、长块折叠、数学/图表评估）**
   - **源码定位**：`renderer/app.js:55-63, 82-131`、`renderer/styles.css:534-560`
   - **优化方案**：
     - 引入零外网依赖、极轻量的本地语法着色器（如精简版词法高亮器）覆盖常见语言（JS/TS/Python/Bash/JSON/YAML/SQL/Go/Rust/CSS/HTML）与可选行号。
     - 超过 30 行的代码块增加顶部/底部「展开全部 N 行」软折叠，避免超长输出淹没上下文。
     - 代码块语言为 `html`/`svg`/`markdown`/`csv` 时，在 `.md-code-head` 增加「在右侧预览」按钮，点击通过临时预览视图或内存数据渲染至 `#rail`。
     - 表格支持「复制为 Markdown / CSV」快捷按钮；评估在严格 CSP 下内联打包 KaTeX 与 Mermaid（仅在检测到 `$...$` / ` ```mermaid ` 时按需渲染）。

---

### 1.2 Composer 输入区、状态条与侧栏导航

1. **【P0】修复输入框 `ArrowUp` / `ArrowDown` 历史回溯破坏多行编辑**
   - **源码定位**：`renderer/app.js:2391-2397`
   - **现状与根因**：`ArrowUp` 判定为 `&& !$('#input').value`，回填最近 1 条后输入框不再为空，导致**永远无法继续上翻第 2 条历史**；`ArrowDown` 无任何空值或光标位置判断，只要发过 1 条消息，用户在多行草稿中按 `↓` 移动光标会**直接清空整段内容**；两者均未调用 `updateCount()`。
   - **优化方案**：
     - 增加 `state.histDraft` 暂存进入历史浏览前正在编辑的文本，并维护 `state.histBrowsing` 状态（一旦用户手动输入任意字符即退出浏览态）。
     - 仅当「已在历史浏览态」或「输入框为空 / 光标位于首行首段（`selectionStart === 0`）」时响应 `ArrowUp`；仅当「已在历史浏览态且到达尾部」时由 `ArrowDown` 恢复 `histDraft`。
     - 每次赋值后统一执行 `autoGrow(); updateCount();`。
   - **验收标准**：多行输入中按 `↑`/`↓` 正常移动光标，绝不误清空；空输入框连续按 `↑` 可逐条上翻全部历史，`↓` 可退回原草稿。

2. **【P0】多页签显性化、复用已打开页签并隔离后台运行串扰**
   - **源码定位**：`renderer/app.js:468, 478-481, 1430-1435, 1999, 2048, 4709-4726`
   - **现状与根因**：
     - `openSession(sessionId)` 不检查 `state.tabs` 是否已有同一 `sessionId`，切去其他会话后再点回正在后台生成的会话会新建重复静态 tab；
     - `renderTabs()` 仅操作已删除的 `#chat-title`；`state.tabs` 数量与状态在界面完全不可见；
     - 后台 tab 的危险操作审批无提醒直接 24s 自动拒单；后台 tab 收到 delta 会直接在 `if (visible)` 外调用 `liveActivity(tab)` 覆盖当前 `#st-tps`，`tool_result` 会在 `if (visible)` 外调用 `maybeAutoPreview()` 劫持当前预览面板。
   - **优化方案**：
     - `openSession(sessionId)` 优先查找并激活 `state.tabs` 中匹配的运行中/已加载页签（必要时再补拉最新历史）。
     - 在侧栏会话行左侧/右侧增加状态微标：后台生成中显示琥珀呼吸点、等待审批显示珊瑚红徽标（`! 待确认`）、后台刚完成显示未读蓝点（切换查看后清除）；同时在 `#chat-head` 或侧栏顶部保留紧凑「活跃会话」快切胶囊（含关闭按钮触发 `closeTab()`）。
     - `onApprovalRequest()` 收到非当前激活 tab 的审批时，弹窗底部或顶栏弹出可点击「立即查看并处理」的持久 Toast（并配合主进程系统通知）。
     - 将 `liveActivity(tab)` 与 `maybeAutoPreview(evt)` 严格收进 `if (visible)` 保护块；删除当前激活会话时自动切换或重置为空白新会话。
   - **验收标准**：A 会话生成中切去 B 会话，再从侧栏点回 A 会话仍能看见实时流式输出；B 会话的预览文件不会在 A 会话视图中突然弹出覆盖。

3. **【P1】精简侧栏冗余入口，修复会话内查找与时间显示口径**
   - **源码定位**：`renderer/index.html:14, 29, 43, 46, 61, 72, 75, 98`、`renderer/app.js:832, 2424-2425, 2503-2506, 2522-2523, 4101-4133, 4201, 4631`
   - **现状与根因**：
     - 展开态侧栏同时存在 2 个「新会话」（`#sb-new` 与 `#btn-new-session`）和 **3 个「搜索会话」**（`#sb-search-btn`、`#session-search`、`#sb-quick-search`）；收起态存在 2 个「新会话」（`#btn-new-tab` 与 `#btn-new-lead`）。
     - `⌘F` 会话内查找 `findCollect()` 未排除 `.hidden`（折叠工具输出）和闭合 `<details>` 文本；按 `Esc` 关闭 `findClose()` 会强制把滚动条弹回打开查找前的 `FIND_STATE.scrollTop`；帮助页仍把 `⌘F` 错写为「聚焦会话搜索」。
     - `sessionItemEl` 行右侧日期写死用 `s.started_at`，与按 `last_active || started_at` 归桶的「今天/昨天」分组逻辑矛盾。
   - **优化方案**：
     - 收敛侧栏入口：展开态顶部 `.sb-head-actions` 仅保留「新会话（若下方无大按钮）或收起侧栏」，移除 `#sb-search-btn` 与 `#sb-quick-search`（搜索框常驻无需双放大镜）；收起态只在图标栏保留 `#btn-new-tab`（或只留 `#btn-new-lead`），避免相邻两枚同功能 `+` 号；修改 `#btn-sessions` 图标为标准放大镜。
     - `findCollect()` 的 `TreeWalker` 跳过 `.hidden`、`[hidden]` 及未展开的 `details > :not(summary)`；`findClose()` 保留当前已跳转到的滚动位置；同步修正帮助弹窗快捷键说明（区分 `⌘F` 页内查找与 `⌘⇧F` 聚焦侧栏搜索）。
     - `sessionItemEl` 日期显示改用 `s.last_active || s.ended_at || s.started_at` 与分桶口径一致。
   - **验收标准**：搜索框不再有重复放大镜入口；`⌘F` 查找到历史位置按 `Esc` 后停留在目标消息处；老会话今日续聊后右侧显示今天时间。

4. **【P1】Composer 状态可见性、上下文操作与附件页签隔离**
   - **源码定位**：`renderer/app.js:434, 920-923, 1434-1441, 2276, 2308-2367`、`renderer/index.html:166-217`
   - **现状与根因**：
     - `state.attachments` 全局共享，切换页签附件会串过去；图片附件仅显示文件名无缩略图；
     - 会话归属项目后隐藏 `#chip-project`，顶栏与状态条都不显示当前工作区项目名；
     - `#st-model` 与上方 `#chip-model` 重复且在历史会话中可能各自显示不同模型；`#st-ctx` 在 `>80%` 变黄后不可点击；`#st-session` 不可点击复制完整 ID；
     - 从已输入草稿的空新会话点历史会话时，`openSession()` 复用 tab 但漏掉 `saveDraftFor`/`restoreDraftFor`。
   - **优化方案**：
     - 将 `attachments` 归属到 `tab.attachments`，并在 `.attach-item` 为图片类型展示 `24×24` 缩略图。
     - 在 `#chip-project` 隐藏态（项目会话）改为在 `#chat-head` 或 `#composer-row` 显示只读项目徽标（含文件夹名、hover 展示完整路径、点击可在访达打开）。
     - `#st-ctx` 占比 `>= 80%` 时变为可点击交互态（提示「上下文偏高，点击执行 /compress 压缩」）；`#st-session` 支持点击复制完整 session ID；统一 `#chip-model` 与 `#st-model` 语义（历史会话只读或提示下次发送所用模型）。
     - `openSession()` 复用空白 tab 前先调用 `saveDraftFor(curTab)`，打开目标会话后恢复其对应草稿并弹出轻量「已恢复草稿」提示。
   - **验收标准**：不同页签附件互不干扰；上下文超 80% 可点击一键压缩；切换会话不丢失新会话中已敲的草稿。

5. **【P1】侧栏项目树交互补全**
   - **源码定位**：`renderer/app.js:1017, 1183, 1204, 1264`
   - **优化方案**：
     - 在当前活动项目头右侧补充轻徽标（`当前`），让「设为活动项目」有明确视觉回显；
     - `openMoveToProjectMenu()` 增加「移出项目（归入默认列表）」选项；
     - 搜索态支持保留结果项所属项目的轻量标签，便于在同名多项目中区分会话归属。

---

### 1.3 双主题、样式系统与跨页视觉一致性

1. **【P0】修复深色主题（`[data-theme="dark"]`）破损与硬编码颜色**
   - **源码定位**：`renderer/styles.css:8-17, 923, 933, 949, 1162-1163, 1349, 1528, 1850, 1876, 2054-2055, 2100-2104, 2198, 2202-2203, 2235, 2274, 2417, 3959`、`main/main.js:120`、`renderer/app.js:4741-4744`
   - **现状与根因**：
     - `.pp-add:hover` 写死 `#2e2d29` 背景，而深色态 `.pp-add` 文字色 `var(--canvas)` 为 `#1a1a18`，对比度暴跌至 **1.26:1**（不可读）；
     - `::-webkit-scrollbar-thumb` 在 `2054-2055` 写死 `#14141326`/`#14141345`，在深色背景 `#1a1a18` 上完全隐身；
     - 12+ 处悬停边框与圆点引用静态 `--n-300`/`--n-400`，深色态悬停弹出刺眼浅米白边框；
     - `.pv-stage, #pv-frame` 硬编码 `#fff`，深色态切换预览闪白；
     - `main/main.js:120` 窗口创建写死 `backgroundColor: '#f2f4f3'`，深色主题启动瞬间闪白；
     - `app.js:4742` 的 `theme: 'system'` 仅启动/保存时读取一次 `matchMedia`，运行中切换系统外观不会自动跟随。
   - **优化方案**：
     - 为 `.pp-add:hover` 增加 `[data-theme="dark"]` 规则或改用 `color-mix(in srgb, var(--text) 85%, var(--canvas))`；
     - 滚动条改用语义色 `color-mix(in srgb, var(--text) 16%, transparent)` / `28%`；
     - 将所有静态 `--n-300`/`--n-400` 描边替换为 `var(--line-2)` 或语义混色，`.ap-dot` 与 `.cat-ico` 改用 `color-mix`；
     - `.pv-stage` 使用 `var(--canvas)`（仅本地网页无显式背景时再提供浅底兼容或主题切换开关）；
     - 注册 `window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ...)` 在 `theme === 'system'` 时实时调用 `applySettings()` 并同步小窗；主进程启动读取主题偏好设对应深浅 `backgroundColor`。
   - **验收标准**：深色模式下全页面无刺眼浅边框、无隐身滚动条、无低对比按钮；macOS 切换深浅外观时主窗与小窗同步切换。

2. **【P1】统一顶栏高度、主按钮体系、弹窗圆角与 WCAG AA 对比度**
   - **源码定位**：`renderer/styles.css:56, 127, 384, 1118, 1136, 1511, 1515, 1908, 2122, 3024, 3783`、`renderer/index.html:327, 579, 788, 809`
   - **现状与根因**：`.rail-head` 因关闭按钮复用 `36×36` 的 `.ir-btn` 被撑高到 54px，与 `#chat-head`（40px）顶线错位；主 CTA 按钮在黑底 `.pp-add` 与陶土色 `var(--blue)` 间分裂（同为「打开配置文件」按钮在消息平台页为黑底实心、设置页为透明线框）；子页内边距与弹窗圆角（`10px` vs `12px`）未统一；浅色态 `--meta-fg: #82858c` 在 `--canvas` 上对比度仅 **3.51:1**（低于 AA 4.5:1）。
   - **优化方案**：
     - 右栏关闭按钮 `#btn-rail-close` 与帮助关闭 `#help-close` 改用 `28×28` 的 `.main-ibtn` 规格，使 `.rail-head` 严格对齐 40px 高度。
     - 确立按钮分级规范：主要强调动作统一用陶土色实心，次要功能入口（如「打开配置文件」）统一用线框描边；统一子页 `.subpage` 顶/侧边距及弹窗 `--r-lg` token。
     - 将浅色态 `--meta-fg` 调深至满足 `≥4.5:1`（如 `#6b6e75` 左右并实测对比度）。
   - **验收标准**：打开右侧栏时顶部分隔线与 `#chat-head` 对齐；浅色态消息脚注达到 WCAG AA 4.5:1。

3. **【P1】修复全局 `Escape` 栈穿透、原生 `confirm()` 割裂与 Popover 视口溢出**
   - **源码定位**：`renderer/app.js:1177-1179, 1303-1305, 4407-4431`、`renderer/settings.js:1405, 1424-1426`、`renderer/ui-select.js:44-80`、`renderer/app.js:3483`
   - **现状与根因**：
     - 全局 `Escape` 处理在关闭 `#settings-page` / `#palette` / `#help-modal` / `#find-bar` 后缺少 `return`，紧接着继续遍历 `.subpage`，导致在看板页上打开设置/帮助后按一次 `Esc` **连同底层看板一起关掉**；`#chip-submenu` 也漏在 `closeAllOverlays()` 外；按 `Esc` 关 `#market-page` 未走 `closeMarket()` 破坏返回来源页逻辑；
     - Profile 切换（`settings.js:1405`）和 Gateway 启停（`app.js:3483`）仍用阻塞式 `window.confirm()`；
     - 会话/项目/Profile 浮层纵坐标用写死阈值防溢出，`ui-select.js` 未按真实菜单宽度与祖先滚动位置做收敛。
   - **优化方案**：
     - 重写 `Escape` 为严格的单层命中即 `return` 栈（拖拽态 → 菜单/二级菜单 → 弹窗 → 查找条 → 模态页 → 抽屉/子页 → 中断生成），并在关闭市场页时调用 `closeMarket()`。
     - 统一替换两处 `window.confirm()` 为应用内非阻塞确认卡 / 轻量确认弹窗。
     - 浮层定位统一先插入测量 `offsetWidth`/`offsetHeight` 再 clamp 到视口边距 8px 内；`ui-select.js` 在祖先或窗口滚动时自动重定位或收起并补充 `aria-activedescendant`。
   - **验收标准**：多层浮层叠开时每次 `Esc` 只关闭最顶层一个；所有弹窗/下拉均不溢出窗口可视边界。

4. **【P2】逐步去除侧栏 `zoom: 1.1`、补齐侧栏调宽手势并合并冗余 CSS**
   - **源码定位**：`renderer/styles.css:115, 149, 2027-2299`、`renderer/app.js:2641-2669`、`renderer/rail-resize.js`
   - **现状与根因**：`#iconrail` 和 `#sidebar` 使用 `zoom: 1.1`，导致 `#storage-pop`（侧栏内）与 `#session-menu`（body 下）比例割裂、大量小数魔术像素、焦点环被裁切、侧栏调宽需除以 `1.1` 且鼠标拖过右侧 `#pv-frame` 会丢事件卡死。此外 `styles.css` 在 `2027-2299` 追加覆盖层引入 240 个重复顶层选择器，并残留 `.sb-foot`、`.badge-blue`、`.msg-foot` 等死样式。
   - **优化方案**：
     - 去掉 `zoom: 1.1`，将侧栏宽度、字体与图标尺寸显式标定到设计目标值（视觉 317px），使全界面像素与焦点环统一。
     - 参照 `renderer/rail-resize.js` 升级 `#sb-resize`：加上 `setPointerCapture`、拖拽时对 `iframe` 置 `pointer-events: none`、`role="separator"` 键盘微调与双击复位。
     - 将 `styles.css` 重复覆盖块合并进原选择器并清理死样式。

---

### 1.4 右侧栏（预览与紧凑看板）

1. **【P0】修复预览区拖放文件冒泡误附加到聊天输入框**
   - **源码定位**：`renderer/app.js:3985-3995`（vs `2689`）
   - **现状与根因**：`#preview-pane` 的 `drop` 监听未调用 `e.stopPropagation()`，事件冒泡至 `window` 的全局文件拖放监听器，导致拖文件到右侧栏预览的同时，该文件也被偷偷加入底部聊天附件栏。
   - **优化方案**：在 `#preview-pane` 的 `dragenter`/`dragover`/`dragleave`/`drop` 处理末尾显式拦截 `e.stopPropagation()`。
   - **验收标准**：拖拽文件进 `#preview-pane` 只触发预览加载，不影响 `#attach-list`。

2. **【P1】修复紧凑看板状态圆点失色，增强卡片操作与 `rail-resize` 恢复**
   - **源码定位**：`renderer/kanban-board.js:862-865`、`renderer/styles.css:1349-1353`、`renderer/rail-resize.js:101-105`
   - **现状与根因**：`kanban-board.js` 将 `data-dot` 写在外层 `<button class="rkb-stat">` 上，内部 `<span class="rkb-dot">` 没有该属性，而 CSS 匹配 `.rkb-dot[data-dot="..."]`，导致所有筛选圆点均退化为灰色 `var(--n-400)`；另外 `rail-resize.js` 在窄窗口被夹窄后，窗口拉宽时 `readW()` 读到被夹窄的 `--rail-w` 而非 `localStorage` 原偏好，无法回弹。
   - **优化方案**：
     - 将 `data-dot="${dot}"` 同步放到 `.rkb-dot` 上（或改写 CSS 为 `.rkb-stat[data-dot="..."] .rkb-dot`）。
     - `rail-resize.js` 的 `revalidate()` 始终以 `localStorage` 存的用户偏好宽为基准按当前最大可用空间计算 clamp，拉宽窗口自动恢复偏好宽。
     - 评估在紧凑看板卡片上增加 hover 快速推进/复制 ID 按钮，避免每次只查看或小改都要关掉右栏跳整页。
   - **验收标准**：右栏紧凑看板 5 个状态筛选圆点按状态着色；窗口缩小再拉宽后右侧栏恢复原定宽。

3. **【P1】解放预览历史列表，补齐预览交互与语言映射**
   - **源码定位**：`renderer/index.html:609-614`、`renderer/app.js:3652, 3669-3672, 3916`
   - **现状与根因**：`#pv-recent` 嵌在 `#pv-empty` 内，打开文件后历史列表即不可见且没有清空/关闭当前预览回到空态的入口；没有后退/前进导航栈；`pvDocHtml` 漏映射 `.c/.h/.cpp/.toml`；Markdown 内锚点 `#anchor` 跳转被直接忽略；远程 URL 被 `X-Frame-Options`/CSP 拦截时仅白屏无引导提示。
   - **优化方案**：
     - 在 `.pv-bar` 增加「后退 / 前进 / 最近历史下拉 / 清空预览」微控件；
     - 补齐 `pvDocHtml` 缺失扩展名映射；Markdown 渲染为标题生成 `id` 并支持点击 `#anchor` 页内滚动；
     - 代码与文本渲染视图增加「自动换行开关」及去重多余的复制按钮；远程 iframe 检测加载受阻或超时时展示「站点禁止内嵌，点击在浏览器打开」提示条。

---

### 1.5 设置弹窗、插件/技能页与市场页 UI

1. **【P0】修复插件市场 4 处高频交互 Bug 与事件串刷**
   - **源码定位**：`renderer/market-plugins.js:416-419, 470-471, 484, 513, 532, 596-598, 617, 667, 717-726, 788-802`
   - **现状与根因**：
     1. `mkSearch()` 未清空 `mk.expanded` 和 `mk.inspect`（以数组下标为键），搜索新关键词后第 0 张卡会自动展开并错显上次插件的预览文本；
     2. `catalog-updated` 事件失效过滤写 `k.startsWith('plugins||')`，带关键词浏览时缓存不刷新；
     3. 错误重试卡片重复拼接 `hermes ` 前缀生成 `hermes hermes ...`；
     4. `mkSwitchKind` 未拦截 `mk.busy`，插件安装中切去「技能市场」会导致回调结束刷错本地列表；
     5. `onCatalogUpdated`（`796-802`）把主进程下发的 `tools`/`mcp` 刷新也当成 `plugins` 重拉；`416-419` 刷新失败时仍弹「列表已刷新」。
   - **优化方案**：
     - `mk.expanded` / `mk.inspect` 改用条目唯一标识 `it.id`（或 `identifier`）作键并在 `mkSearch()` 时清理瞬态；
     - 缓存前缀判断改为 `k.startsWith(kind + '|')`；去掉错误卡片多余的 `hermes ` 前缀；`mk.busy` 期间禁用切换 Tab 或按任务记录真实 `kind`；
     - `onCatalogUpdated` 严格过滤 `p.kind === 'plugins' || p.kind === 'skills'`；`loadLive()` 返回 `false` 时跳过成功 toast。
   - **验收标准**：搜索翻页/换词不再串卡；工具/MCP 刷新不触发插件列表重拉；安装中切页不会串数据。

2. **【P1】消除设置弹窗「保存/取消」心智割裂，处置 `approvalMode` 死设置**
   - **源码定位**：`renderer/settings.js:14, 73, 78, 223-225, 448, 602, 889-891, 1346-1358, 1446`
   - **现状与根因**：
     - 10 个分类里仅 `general` 走底部 `#set-save`，但除 `kanban` 隐藏了它之外，其余 8 个即时生效/只读分类都保留「保存」「取消」和「更改需保存后生效」提示；切去 `kanban` 再切回 `general` 还会残留看板提示文案；
     - `general` 第 1 项「新会话权限模式 `approvalMode`」全仓没有任何读取处（`app.js`/`main.js` 只读 `state.config.yolo`），用户改动无效；
     - `renderMemoryPanel`、`renderProfilePanel` 与 `renderToolsPanel` 首次异步请求缺少 `settingsPanelEpoch` 守卫。
   - **优化方案**：
     - 统一底部栏交互：要么把 `general` 的主题/字号/步骤详略改为即时应用、底部统一为「关闭」；要么仅在 `general` 显示「保存/取消」与未保存离开拦截，其余 9 个分类隐藏保存键、仅显示「关闭」并强制重置 `#set-hint`。
     - 将 `approvalMode` 真正映射并接入新建会话时的默认审批策略（或若暂不支持三档则精简为与 Composer 同步的默认值开关）。
     - 为所有异步设置面板补齐 `epoch === settingsPanelEpoch` 检查后再操作 DOM。
   - **验收标准**：设置页任意分类切换后提示文案准确、无虚假「保存」按钮；修改权限默认值对新会话生效。

3. **【P1】清理插件/技能页死入口、过时文案与核心技能视觉提示**
   - **源码定位**：`renderer/index.html:227-235, 259-266, 277-285, 309-316`、`renderer/market-plugins.js:186-201, 227, 250, 330-348, 421-455`、`main/services/hermes-skills.js:22, 195`
   - **现状与根因**：`.pp-detailview` / `.pp-save` 仅在浏览器 Demo 模式生效，原生模式卡片点击只展开 2 行截断文本且页脚固定显示「点击展开描述」不随展开切换；「添加插件/技能」的命令安装分支提示已下线的「终端 rail」且未做一键复制；核心技能 `hermes-agent` 后端禁止停用但前端仍渲染可点击开关。
   - **优化方案**：
     - 卡片页脚根据展开态动态切换「点击展开 / 收起」；
     - 删改「终端 rail」过时文案，命令安装改为复制安装命令到剪贴板并弹提示，本地目录安装改为直接调用系统打开本地插件/技能目录（或目录选择）；
     - 识别受保护的核心技能（如 `hermes-agent`），禁用开关并标示「核心必需」。

---

### 1.6 小球模式与迷你聊天窗 UI

1. **【P0】修复小窗工具状态行样式失效与停止/Esc 文案冲突**
   - **源码定位**：`renderer/orb-chat.js:138-147, 379-394`、`renderer/orb-chat.css:279-286`、`renderer/orb-chat.html:53`
   - **现状与根因**：JS 渲染工具行直接将 `.oc-tool-dot` 与文本放入 `.oc-msg.is-tool`，未包裹 `.oc-body`，导致 CSS 选择器 `.oc-msg.is-tool .oc-body` 永不命中；停止按钮 tooltip 写着「Esc 两次或点此」，但代码监听到单次 `Escape` 就直接关闭小窗。
   - **优化方案**：
     - 为 `.oc-msg.is-tool` 内部补齐 `<div class="oc-body">` 包装层，恢复小字号、等宽与间距样式。
     - 实现并统一交互：「生成中首次按 `Esc` 停止本回合、空闲态或再次按 `Esc` 收起小窗」，同步更新按钮 `title` 与无障碍提示。
   - **验收标准**：小窗工具调用行呈现紧凑等宽胶囊；运行中按一次 Esc 停止生成而不误关窗口。

2. **【P1/P2】补齐小窗连接轨实时翻转、拔屏坐标收敛与基础阅读体验**
   - **源码定位**：`main/orb-chat.js:59, 87-102, 119-122, 197`、`main/main.js:1038-1039`、`renderer/orb-chat.js:62-84`
   - **优化方案**：
     - 监听 `orbChat` 窗口的 `moved` 与 `resized` 事件，拖动越过球另一侧时实时更新 `.oc-rail` 朝向，并持久化用户拖拽后的小窗尺寸。
     - `main.js` 监听 `display-metrics-changed` / `display-removed` 时同步重新夹紧（clamp）可见的 `orb` 与 `orbChat` 窗口坐标，防止拔掉副屏后丢失在屏外。
     - 小窗支持基础 Markdown（粗体、列表、安全链接）、消息/代码块复制按钮、后端离线横幅以及主窗 `fontSize` 字号同步。

---

## 二、核心功能与系统能力优化方案

### 2.1 后端协议、运行态与小球状态闭环

1. **【P0】透传工具失败态与 `tool_call_id` 精确匹配**
   - **源码定位**：`main/services/hermes-chat.js:290-295`、`renderer/app.js:2042`
   - **现状与根因**：`hermes-chat.js` 在翻译 `tool.complete` 时写死 `is_error: false`，导致工具失败时 UI 仍显示完成绿态并自动折叠；前端在 `tool_result` 中仅按工具名倒序查找最后一个 `running` 项，同一轮并发执行多个同名工具（如并行 `read_file`）时会错绑结果。
   - **优化方案**：`hermes-chat.js` 读取 `p.is_error || p.error || p.status === 'error'`（或兼容字段）透传真实失败标记；前端优先按 `evt.tool_call_id` 匹配工具卡，缺省再回退按名称匹配。

2. **【P0】修复仅切换思考力度不生效与小窗首轮发送丢失配置**
   - **源码定位**：`main/services/hermes-chat.js:194-198`、`main/main.js:371`、`renderer/app.js:4778-4785`
   - **现状与根因**：`GatewayTurn` 仅在 `this.opts.model !== this.model` 时才下发 `/model ... --reasoning ...`，只改思考力度不换模型时被跳过；`orbChat.onSubmit` 调 `submitTurn` 只传 `query` 与 `sessionId`，丢弃了桌面端已选的模型、推理档位、`yolo` 权限和项目 `cwd`；主窗 `onOrbUserMessage` 只 push 气泡未置 `tab.running = true`。
   - **优化方案**：
     - 改为对比 `model` 或 `reasoning` 任一发生变化即执行模型/推理同步；
     - `orbChat.onSubmit` 读取主进程 `loadConfig()` 与 `orbCtx.cwd` 补全 `model`/`reasoning`/`yolo`/`cwd`；`orb:context` 上报增加当前页签 `cwd`；`onOrbUserMessage` 同步推进 `tab.running`、`tab.showTyping` 与占位标题。

3. **【P0】打通小球关闭态审批队列同步、审批超时回收与小窗错误展示**
   - **源码定位**：`main/main.js:520-523, 970-980`、`main/services/hermes-chat.js:727-731`、`renderer/orb-chat.js:239-303`、`renderer/app.js:1638-1645`
   - **现状与根因**：
     - 迷你聊天窗关闭时收到危险操作审批，`main.js:975` 因 `!orbChat.isOpen()` 不推送给小窗，用户点亮着红标的球打开小窗后 `orbCtx.messages` 里完全没有待审批卡片，24 秒后被静默拒绝；
     - 主进程 25s 超时定时器触发 deny 时未回调减扣 `main.js` 的 `pendingApprovals` 计数；
     - `main.js:522` 发送 `{ type: 'error', text }` 给小窗，但 `orb-chat.js` 的 `switch` 缺少 `case 'error'` 分支直接丢弃，且 `522` 未按 `tabId` 过滤。
   - **优化方案**：
     - 主进程维护当前挂起的未决审批列表 `activeApprovals`（按 `tabId` 归集），小窗 `bootstrap` 与打开同步时下发挂起审批项立即渲染；
     - 为 `hermes-chat.js` 的 25s 超时收尾补 `onApprovalTimeout` 回调，触发 `main.js` 扣减 `pendingApprovals` 并广播 `orb:approval-resolved`；
     - `orb-chat.js` 补充 `case 'error'` 渲染红色错误提示，`main.js:522` 加上 `tabId` 匹配与 `isOpen()` 检查；同时在小窗内支持新建会话与斜杠命令提示/透传。

4. **【P1】WS 心跳僵死主动断开重连、修正重试与历史推理透出**
   - **源码定位**：`main/services/gateway-client.js:97-99`、`main/services/hermes-chat.js:597-599`、`renderer/app.js:4580-4596`、`main/services/hermes-sessions.js:86, 95-106`
   - **优化方案**：
     - `gateway-client.js` 心跳超时或连续失败 2 次时主动关闭僵死 socket 触发重连；WS 断连后若超过宽限期未恢复，在 `hermes-chat.js` 收敛挂起的 `activeTurns` 并通知界面。
     - `retryFrom()` 明确语义：截断前先提示或另开分支会话（避免前端截断了展示但后端同一 `sessionId` 上下文仍包含旧对话）；`copyLastReply()` 改为按整轮合并文本与脚注保持一致。
     - `hermes-sessions.js` 的 `loadHistory()` 返回对象补上已查出的 `reasoning_content`，支持新库历史会话回放思考过程。

---

### 2.2 对话 ↔ 看板 ↔ 预览 三端联动与看板深化

1. **【P0】修复看板 `updated_at` 漏投影、轮询冲毁抽屉与死数据通道**
   - **源码定位**：`main/services/hermes-kanban.js:90-96, 640-641, 894`、`renderer/kanban-core.js:103-112, 158, 367-371`、`renderer/kanban-drawer.js:150-265`、`renderer/kanban.js:310-324`、`renderer/kanban-board.js:165-173`
   - **现状与根因**：
     - `TASK_FIELDS` 白名单遗漏 `updated_at`，导致「按最近更新排序」失效，且刚从待办移入 `ready` 的老任务立刻被 `kbStuckInfo()` 误报卡住几天；
     - `TASK_FIELDS` 剥离了 `workspace_path`/`branch_name`，抽屉工作区行永远为空（建议保留安全的相对 `branch_name`）；
     - 5s 轮询全量重写 `#kb-drawer-body.innerHTML`，会直接销毁未保存的 `#kbd-edit-form`、已拉取的 `#kbd-log-body` 与已弹出的 `.op-confirm` 确认卡；
     - 服务端已下发 `linkTasks`（含标题/状态）和 `childResults`，`kanban:run` 通道已打通，但抽屉全部丢弃只渲染裸 ID；
     - `#kb-dock` 点击筛选绑定在 `pointer-events: none` 的隐藏元素上；网格视图无 `.kb-col` 却仍标 `data-kb-drag="1"`。
   - **优化方案**：
     - `TASK_FIELDS` 补入 `updated_at` 与 `branch_name`（仅相对分支名，不含磁盘绝对路径）；
     - 抽屉正在编辑、展开日志或打开确认卡时，轮询只做顶部状态/进度条局部增量更新或提示「有新动态，点此刷新」，不重写整块 `innerHTML`；
     - 抽屉依赖列表优先渲染 `linkTasks` 的标题与状态标签，子任务汇总展示 `childResults`，运行记录行绑定点击调用 `kanban:run` 查看运行详情；
     - 清理网格视图误导拖拽标记与 `#kb-dock` 无效点击绑定。
   - **验收标准**：抽屉内编辑正文或查看日志超过 5 秒不会被刷新清空；依赖项显示任务名称与状态；「按最近更新」排序准确。

2. **【P1】打通「对话 → 看板」与「对话 → 预览」工作流**
   - **源码定位**：`renderer/app.js:1306-1314, 1703-1716, 2731`、`renderer/kanban-modal.js:349-369`、`main/services/hermes-kanban.js:302-352`
   - **优化方案**：
     - `kbModalOpen('task', prefill)` 支持传入预填对象（标题、描述、项目 ID、关联 `session_id`），`cleanTaskInput` 按正则白名单放行 `session_id`。
     - 在消息操作条（`msgActionBar`）及侧栏会话菜单（`openSessionMenu`）增加「转为看板任务」按钮；支持 `/kanban new <标题>` 快速唤起预填弹窗。
     - 对话中文件工具行路径与可预览代码块增加一键「在右侧预览」直达动作。

3. **【P1/P2】补齐看板高频编辑、实时日志、拖拽自动滚动与窄屏适配**
   - **源码定位**：`renderer/kanban-drawer.js:267-295, 365-391`、`renderer/kanban-modal.js:491-492`、`renderer/kanban-board.js:185-211`、`renderer/styles.css:3469, 3491-3494, 3855-3865`
   - **优化方案**：
     - 抽屉正文/交接结论改用 `renderMarkdown` 渲染；编辑区 `body` 字数上限从 `4000` 对齐创建弹窗的 `20000`；补齐编辑依赖、模型覆盖、超时、目标模式字段（创建弹窗的前置任务与限定技能升级为多选）。
     - 运行中任务日志支持「自动跟随刷新（tail 轮询）+ 自动滚底 + 一键复制」。
     - 拖拽卡片靠近 `#kb-scroll` 左右边或 `.kb-col-body` 上下边缘时同步自动滚动；`.compact`（≤600px）自动切换为分组网格视图避免 5 列横滚挤压。

---

### 2.3 插件 / 技能 / 市场 / 设置 / Gateway 管理闭环

1. **【P0/P1】插件与技能管理闭环**
   - **源码定位**：`main/services/hermes-plugins.js:279-294`、`renderer/market-plugins.js:237-252, 295-299, 437`
   - **优化方案**：
     - 暴露并接入 `hermes-plugins.js` 中已实现的 `showPlugin(name)`，并增补只读读取技能 `SKILL.md` / 插件说明的详情抽屉，取代不可达的 `.pp-detailview`；
     - 已安装插件/技能卡片增加「卸载」（二次确认）与「检查/更新」入口，使本地安装条目无需再去市场搜索也能维护；
     - 修复列表渲染循环内 `defs.indexOf(d)` 导致的 $O(N^2)$ 卡顿（改用 `forEach((d, idx) => ...)`），补齐搜索 150ms 防抖与首屏分批渲染（如首批 60 条 + 加载更多）。

2. **【P1】市场筛选排序、局部更新与装后引导**
   - **源码定位**：`renderer/market-plugins.js:556-770`、`main/services/hermes-market.js:199-250, 336-355`、`renderer/index.html:385-408`
   - **优化方案**：
     - 新增快捷筛选芯片组：信任等级（`官方 / 已验证 / 社区`）、状态（`未安装 / 已安装 / 有更新`），并在技能页放开后端已实现的「检查更新」；
     - 点击「详情 / 安装 / 卸载 / 取消」改为仅局部替换对应 `.mk-card` DOM 节点，保留滚屏位置、高级选项展开态与已输入的 commit SHA；
     - 正在安装的条目在卡片自身显示加载状态与取消防重；插件装完（默认 `--no-enable`）在卡片立即浮出「启用并生效 / 去插件页」动作；
     - 后端透出 `known_issues` 原文，确认卡对 `needsNewer` 展示显式版本警示；卡片保留源码仓库链接按钮并附完整 URL tooltip。

3. **【P1/P2】设置页 Cron / 模型 / MCP / Profile 实效化**
   - **源码定位**：`renderer/settings.js:359-386, 708-869, 1078-1257, 1446-1486`、`main/services/hermes-cron.js:150-160`
   - **优化方案**：
     - **Cron**：移除 `cronOverview` 中未使用的额外 `hermes cron doctor` 子进程（或在状态区展示其诊断结论）；卡片补全 `workdir`、`skills`、`prompt` 预览；新建区增加常用调度预设芯片（`每 30 分钟`、`每 2 小时`、`每天 09:00`）与非空前置校验；运行历史支持查看完整输出/错误日志并滚动到位。
     - **模型提供商**：将只读提供商卡片上的假「编辑」「＋ 添加模型提供商」按钮改为明示只读并支持「打开 `providers.json` / 复制 CLI 配置命令」，避免误导用户点击后只能看 2 秒 toast。
     - **MCP**：添加表单确认前先校验名称与合法 URL 格式，确认卡展示真实当前 `profile` 名；后续评估接入 `stdio` 型服务器配置。
     - **Profile**：保留「不擅写 `~/.hermes`」边界下，允许在设置页通过标准确认弹窗而非 `window.confirm` 完成切换，并提示 CLI 与桌面端差异来源。

4. **【解冻后候选】Gateway（消息平台接入页）改进储备**
   - **源码定位**：`renderer/app.js:3350-3515`、`main/services/hermes-gateway.js:19, 54, 126, 142, 184-187`
   - **储备清单（待用户允许解冻该线后执行）**：① 将硬编码 `~/.hermes/.env` 文案改为当前 Profile 真实目录；② 修正 `.env` 空值占位（`KEY=`）误判及 `some()` 把「缺项半成品」计入「已配置」的统计错误；③ 接入已实现却未使用的 `gwCliStatus()` 与内联错误输出面板；④ 启停过程禁用操作按钮防重入，并改用非阻塞确认卡；⑤ `hermes-gateway.js` 改用 `resolveHermesBin()`；⑥ 补充各 Profile 真实 Gateway 进程状态对照。

---

### 2.4 桌面端原生体验与高频工作流

1. **【P1】接入主进程原生桌面通知（`Notification`）与 Dock 提醒**
   - **源码定位**：`main/main.js:520-530, 970-980`、`renderer/app.js:2240-2241`
   - **现状与根因**：当前仅渲染层调用未申请权限的 Web `Notification`，且仅覆盖对话结束、无点击跳转；**危险操作审批**（25s 后自动拒绝）在窗口收起或 `hotkey` 模式下零系统提示，用户极易错过并导致任务失败；看板后台 worker 完成或阻塞也无提醒。
   - **优化方案**：
     - 在主进程引入 Electron `Notification` 与 `app.dock.bounce('informational')` / badge 计数；
     - 覆盖三大场景：**① 危险审批待确认（高优先级，点击直接唤起主窗或小窗并定位）；② 窗口在后台时当前回合完成/报错；③ 看板后台任务转为 `done` / `blocked` / 失败**（可在设置页增加通知开关）。

2. **【P1】补齐窗口几何持久化、macOS 编辑菜单与崩溃兜底**
   - **源码定位**：`main/main.js:8, 118-127, 1055-1075`
   - **现状与根因**：主窗口每次启动固定 `1360×860`；应用「编辑」菜单缺少 `undo` / `redo` / `cut`，在 macOS 下影响输入框原生 `⌘Z` / `⇧⌘Z` / `⌘X`；全进程缺少 `uncaughtException` / `unhandledRejection` / `render-process-gone` 恢复；第 8 行无条件调用 `app.disableHardwareAcceleration()` 降低长页面滚动与动画帧率。
   - **优化方案**：
     - 将主窗口尺寸/位置/最大化状态持久化到 `userData/window-state.json`（启动时复用 `fitWindowToDisplay()` 防止跨屏溢出）；
     - 补全应用菜单：`编辑` 补 `undo / redo / cut`，`Hermes` 补 `偏好设置… (⌘,)`、`hide / hideOthers / unhide`，`窗口` 补 `关闭窗口 (⌘W)` 与 `新建会话 (⌘N/⌘T)`；
     - 监听 `render-process-gone` 提供一键重载恢复提示，注册全局未捕获异常日志兜底；将 `disableHardwareAcceleration()` 改为由环境变量开关或连续 GPU 崩溃后自动降级，正常环境启用硬件合成。

3. **【P1/P2】补齐高频对话输入工作流与全局搜索召回**
   - **源码定位**：`renderer/app.js:512-525, 2146-2148, 2689`
   - **优化方案**：
     - **剪贴板直接粘贴图片**：在 `#input` 监听 `paste`，检测 `clipboardData.items` 中的图片（截图等）经主进程写入临时缓存目录后复用现有 `image.attach` 链路。
     - **运行中消息排队（Queue）**：Agent 生成期间允许用户继续输入并按 Enter 排入本页签待发列表（输入框上方展示可取消/上移的待发条），本轮 `handleClose` 后自动按序发出（仅当未被手动停止或报错中断时）。
     - **消息编辑重发 & 引用回复**：用户消息支持「编辑后重发」（回填输入框并明确提示是否新开分支），助手消息支持「引用提问」。
     - **修复侧栏搜索截断漏召回**：`refreshSessions` 有搜索词时不再只拿前 200 条列表与 FTS5 结果求交，改为直接由 SQLite 返回匹配 FTS/标题的完整会话元数据并按匹配度合并排序。

---

### 2.5 性能与工程架构清债

1. **【P1】聊天流合帧渲染与插件页列表性能修复**
   - **源码定位**：`renderer/app.js:1532-1624, 1659-1664, 1981-1998, 2039, 2047`、`renderer/market-plugins.js:295-299, 437`
   - **现状与根因**：流式每个 `text` delta 都全量重跑正则 Markdown + `replaceChild`，无 rAF 合帧；每次 `tool_use`/`tool_result` 都调用 `chat.innerHTML = ''` 全量重建整个聊天记录并触发 `syncCodeScrollHints()` 全页强制同步重排（Layout Thrash）；插件页 1050+ 条卡片零防抖一次全量渲染且存在 $O(N^2)$ `indexOf`。
   - **优化方案**：
     - 流式文本 delta 合并到 `requestAnimationFrame`（约 60fps / 16ms 节流，或每 ~30ms 刷新一次当前消息正文容器），保护文本选区与代码块横滚位置；
     - `tool_use` / `tool_result` 改为局部创建/更新对应 `.tool-item` 或 `.step-group` 节点，仅对新插入节点局部执行代码滚动宽度检测；
     - 对超过 150 条消息的超长历史会话引入「默认加载最近 80 条 + 顶部点击加载更早消息」分页机制。

2. **【P1/P2】SQLite 访问与并发队列加固**
   - **源码定位**：`main/services/hermes-sessions.js:31-43, 75-91, 174-188, 238-245`、`main/services/hermes-tools.js:221-242`、`main/services/hermes-chat.js:674-677`、`main/main.js:915-918`
   - **优化方案**：
     - `hermes-tools.js` 的 `setTool()` 立即接入 `queue` 串行队列，防止快速连点开关同时写 CLI 配置；
     - `hermes-sessions.js` 缓存 `PRAGMA table_info(messages)`（切换 Profile 时失效），将 `storageStats()` 的 4 次独立 `sqlite3` 子进程合并为 1 条 SQL；给球菜单的 `orbMenuSections` 读库加短 TTL 内存缓存；中长期评估使用 Node 22+ 原生只读 SQLite 或轻量长驻查询通道取代高频 `execFile('sqlite3')`；
     - `hermes-chat.js:674` 改用事件监听替代 `100ms setInterval` 轮询连接状态；`main.js` 启动错峰预热一并覆盖 `tools` 与 `mcp` 缓存。

3. **【P2】零构建原生 ESM 渐进拆分与测试/资产清债**
   - **源码定位**：`renderer/app.js`（4836 行）、`renderer/styles.css`（4227 行）、`renderer/index.html:829-841`、`renderer/kanban.js:366`、`renderer/mock-bridge.js`、`scripts/test-contracts.js`（4408 行）、`package.json:13, 30`、`electron-builder.yml:28-38`、`renderer/assets/hermes-logo.png`
   - **优化方案**：
     - **渐进模块化**：不引入重型打包器，利用 Electron Chromium 原生 `<script type="module">` 逐步将 `app.js` 拆分为 `core/dom.js`、`core/state.js`、`chat/markdown.js`、`chat/tools.js`、`chat/stream.js`、`sidebar/sessions.js`、`preview/pane.js`、`input/composer.js`、`shortcuts/palette.js`，消除 `kanban.js` 末尾调 `init()` 的倒置加载链；将 `styles.css` 按域拆分为 `tokens / base / sidebar / chat / rail / kanban / settings / market`。
     - **契约与集成测试升级**：先调整 `scripts/test-contracts.js` 支持按目录聚合源码文本，再逐步将脆弱的单文件正则检查替换为主进程/WS/SQLite 真实行为单测与覆盖流式/审批/小窗的 Playwright/CDP UI 测试。
     - **清理遗留债务**：在确认不再恢复桌面端内置 PTY 终端后，移除零引用的 `node-pty`、`scripts/fix-pty-perm.js`、`asarUnpack` 与对应自检，简化跨平台打包链；从 `build/icon.icns`（1024px 高清原图）重新导出 256/512px PNG 或矢量 SVG 替换模糊的 128px `renderer/assets/hermes-logo.png`；补齐 `mock-bridge.js` 与 `preload.js` 缺失的方法桩。

---

## 三、分阶段落地路线图与验证策略

### 第一期：P0 止血修复（高 ROI、低改动风险）

- **核心目标**：解决当前“用户一用就踩”的滚动、输入历史、重复气泡、暗色不可读、小窗丢审批、市场串卡、看板漏 `updated_at` 等 15+ 个真实缺陷。
- **涉及文件**：
  - `renderer/app.js`、`renderer/styles.css`、`renderer/market-plugins.js`、`renderer/orb-chat.js`、`renderer/orb-chat.html`、`renderer/kanban-drawer.js`
  - `main/main.js`、`main/services/hermes-chat.js`、`main/services/hermes-kanban.js`、`main/services/hermes-tools.js`
- **契约与风险提示**：
  - 修改 `app.js`、`styles.css`、`hermes-kanban.js` 时需特别注意 `scripts/test-contracts.js` 对变量名、选择器与白名单字段的静态正则断言（例如 `TASK_FIELDS` 增补字段、`scrollBottom` 与 `Escape` 结构、`pp-add` 样式规则）。
- **验证方式**：每批改动后执行 `npm test`（`test:services` + `test:contracts` + `pack:check`）与 `npm run test:ui`，并真机核对深色主题、流式长回复上滚、小窗审批、市场切词搜索。

### 第二期：P1 高频工作流、跨页一致性与三端联动

- **核心目标**：补齐主进程原生通知与编辑菜单、窗口几何持久化；统一设置页底部交互、顶栏高度与按钮规范；精简侧栏冗余入口并显性化后台多页签状态；打通「对话 → 看板」「对话 → 预览」；落地聊天流 rAF 节流与市场局部刷新/筛选。
- **涉及文件**：
  - `main/main.js`、`main/services/hermes-sessions.js`、`main/services/hermes-plugins.js`、`main/services/hermes-market.js`、`preload/preload.js`
  - `renderer/index.html`、`renderer/app.js`、`renderer/styles.css`、`renderer/settings.js`、`renderer/market-plugins.js`、`renderer/kanban-board.js`、`renderer/kanban-modal.js`、`renderer/kanban-drawer.js`、`renderer/rail-resize.js`
- **契约与风险提示**：
  - 精简侧栏冗余按钮（如删除 `#sb-search-btn` 或 `#sb-quick-search`）或改造设置页底部栏时，需同步更新 `scripts/test-contracts.js` 中的 HTML ID 绑定检查与 UI 冒烟选择器；
  - 新增 `preload/preload.js` 通道必须同步在 `scripts/test-contracts.js` 验证 IPC/Preload/Renderer 三端对齐。
- **验证方式**：`npm test` + `npm run test:ui` 全绿，真机重点实测多页签并发流式、剪贴板粘贴图片、后台审批系统通知点击回焦、看板轮询并发编辑抽屉。

### 第三期：P2 能力深化与工程架构清债

- **核心目标**：完成 `app.js` 与 `styles.css` 的零构建原生 ESM/CSS 分层拆分（并移除 `zoom: 1.1`）；升级 Markdown 语法高亮、长代码折叠与轨迹视图重构；升级小窗富文本与独立操作能力；清理 `node-pty` 遗留、替换高清 Logo 与扩充集成测试。
- **涉及文件**：`renderer/` 全目录重构、`scripts/test-contracts.js`、`scripts/test-services.js`、`scripts/test-ui.js`、`package.json`、`electron-builder.yml`、`scripts/check-package.js`、`renderer/assets/`
- **契约与风险提示**：
  - 拆分 `app.js`/`styles.css` 前，必须先重构 `scripts/test-contracts.js` 读源方式（由读单文件改为聚合模块目录），否则会大面积阻断拆分。
  - 移除 `node-pty` 前需再次确认无任何分支依赖并同步更新 `package.json`、`electron-builder.yml` 与 `scripts/check-package.js`，并实际跑一次 `npm run dist:dir` 验证产物可启动。

---

## 四、可执行优化 Checklist 总表

### P0 — 立即止血修复

- [x] **对话流滚动**：`#chat-scroll` 绑定 `scroll` 维护 `_userScrolledAway`，补充「↓ 回到底部」悬浮胶囊（`renderer/app.js`）
- [x] **流式重复气泡**：`flushTurnFoot()` 跳过未完成回合，delta 节点定位不依赖 `#chat.lastElementChild`（`renderer/app.js`）
- [x] **输入框历史导航**：修复 `ArrowUp`/`ArrowDown` 多行草稿防清空与连续上翻，补充 `histDraft` 与 `updateCount()`（`renderer/app.js`）
- [x] **多页签复用与隔离**：`openSession()` 复用 `state.tabs` 已有页签；将 `liveActivity`/`maybeAutoPreview` 收进 `if (visible)`（`renderer/app.js`）
- [x] **后台审批提醒**：后台 tab 审批弹出可点击跳转 Toast，避免 24s 静默拒单（`renderer/app.js`）
- [x] **深色模式破损**：修复 `.pp-add:hover` 黑字黑底、滚动条隐身、`--n-300`/`--n-400` 边框、窗口启动白底（`renderer/styles.css`、`main/main.js`）
- [x] **系统主题动态同步**：监听 `prefers-color-scheme` `change` 事件实时刷新主窗与小窗（`renderer/app.js`）
- [x] **预览拖放防冒泡**：`#preview-pane` `drop` 事件增加 `e.stopPropagation()`（`renderer/app.js`）
- [x] **市场页 4 处 Bug**：`mk.expanded`/`mk.inspect` 改按 `it.id` 索引并在 `mkSearch()` 清理；修正 `plugins|` 缓存前缀；去除 `hermes hermes ` 双前缀；`mk.busy` 禁止切 Tab（`renderer/market-plugins.js`）
- [x] **插件目录事件串刷**：`onCatalogUpdated` 严格过滤 `plugins`/`skills`，`loadLive` 失败时不弹刷新成功（`renderer/market-plugins.js`）
- [x] **小窗核心修复**：工具行补 `.oc-body` 包装（`renderer/orb-chat.js`）；统一 Esc 行为与提示（`renderer/orb-chat.html`）；补齐打开前挂起审批同步、审批超时扣减 `pendingApprovals`、处理 `case 'error'` 及首轮透传配置（`main/main.js`、`main/services/hermes-chat.js`）
- [x] **后端协议修复**：`tool.complete` 取消 `is_error: false` 硬编码并按 `tool_call_id` 匹配；仅改 `reasoning` 也要下发同步（`main/services/hermes-chat.js`、`renderer/app.js`）
- [x] **Tools 串行队列**：`setTool()` 接入 `queue` 防止并发写 CLI 配置（`main/services/hermes-tools.js`）
- [x] **看板数据与轮询修复**：`TASK_FIELDS` 补投影 `updated_at` 与 `branch_name`（`main/services/hermes-kanban.js`）；5s 轮询不冲毁抽屉编辑态/日志/确认卡；消费 `linkTasks`/`childResults` 与 `kanban:run`（`renderer/kanban-drawer.js`）；清理 `#kb-dock` 死绑定与网格视图拖拽提示

### P1 — 核心体验、跨端联动与一致性升级

- [x] **主进程原生通知与菜单**：接入 Electron `Notification` + `app.dock.bounce()`（审批/对话/看板终态）；持久化主窗几何；补齐 macOS Edit 菜单 `undo/redo/cut` 与崩溃兜底（`main/main.js`）
- [x] **侧栏去冗余与状态可视化**：合并重复「新会话」/「搜索」入口；侧栏会话行展示运行中/待审批/未读状态；日期改用 `last_active || started_at`；活动项目高亮与移出项目选项（`renderer/index.html`、`renderer/app.js`）
- [x] **跨页一致性与 Esc 栈**：统一 `.rail-head` 高度为 40px；统一主按钮与弹窗圆角；调深 `--meta-fg` 达 AA 4.5:1；`Escape` 单层命中 `return`；替换两处 `window.confirm()`（`renderer/app.js`、`renderer/settings.js`）
- [x] **设置页心智统一**：仅在 `general` 保留保存/取消并修 `#set-hint` 残留；`approvalMode` 真正接入新会话；异步面板补 `settingsPanelEpoch` 守卫（`renderer/settings.js`）
- [x] **紧凑看板与预览增强**：修复 `.rkb-dot` 失色（`renderer/kanban-board.js`）；修复 `rail-resize.js` 缩窗后恢复偏好宽（`renderer/rail-resize.js`）；预览条新增历史导航与清空/后退前进按钮
- [x] **工具卡与 Markdown 修复**：命令细节展示完整命令行、记录 `userToggled`、修正 `toolExtra` 增删行、Diff 补 `+`/`−`；行内代码占位防正则污染、移除重复复制监听（`renderer/app.js`、`renderer/chat/markdown.js`）
- [x] **轨迹视图升级**：补空态引导、保留提问轮次/推理/审批/命令上下文、增设筛选汇总条、发消息自动切回对话（`renderer/app.js`）
- [x] **对话 ↔ 看板 ↔ 预览联动**：消息条/会话菜单「转为看板任务」（预填并传 `session_id`）；工具详情直达右侧预览；看板抽屉 Markdown 渲染、放开正文 20000 上限与运行日志自动 tail（`renderer/kanban-drawer.js`、`renderer/kanban-modal.js`）
- [x] **输入效率与附件隔离**：`attachments` 按页签隔离；剪贴板粘贴文件附件；运行中消息排队（Queue）；上下文 `>80%` 一键 `/compress`；解除侧栏搜索 200 条求交截断（`renderer/app.js`）
- [x] **插件/市场闭环**：锁定核心技能 `hermes-agent`；市场详情透出 `known_issues` 原文、装后引导「立即启用」（调用 `pluginsSetEnabled`）（`renderer/market-plugins.js`）
- [x] **性能与并发优化**：流式 `text` rAF 节流；插件页去 $O(N^2)$ + 搜索防抖；`hermes-sessions.js` 缓存表结构与合并统计 SQL；WS 心跳失败重连与 `reasoning_content` 透出

### P2 — 能力深化与工程清债

- [x] **富文本与小窗深化**：代码语法高亮、长代码块折叠、表格 Markdown/CSV 复制；小窗 `moved` 自动翻连接轨、拔屏坐标收敛、尺寸持久化、小窗复制按钮（`renderer/orb-chat.js`、`main/orb-chat.js`）
- [x] **设置页深层功能**：Cron 常用调度预设与格式校验（清理无效 `doctor` 调用）；模型提供商明示只读并支持快捷打开配置文件；看板拖拽边缘滚动（`renderer/settings.js`、`renderer/kanban-board.js`）
- [x] **架构拆分与去 `zoom`**：移除 `#sidebar`/`#iconrail` `zoom: 1.1` 并升级 `#sb-resize`；渐进拆分 `core/utils.js` 与 `chat/markdown.js`；改造 `test-contracts.js` 支持子目录聚合（完整拆分其余模块与 CSS 去重可按需继续迭代）
- [x] **遗留资产清债**：清理废弃 `node-pty` / `fix-pty-perm.js` / `asarUnpack`；补齐 `mock-bridge.js` 接口桩
- [x] **【解冻后储备】Gateway 页改良**：支持多 Profile 配置路径、修正 `.env` 空值与已配置统计、接入 `gwCliStatus()` 与内联排错输出、`resolveHermesBin()` 统一探测
