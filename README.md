# Hermes Desktop Client

连接本机 **hermes CLI**（Nous Research Hermes Agent）的 Electron 桌面客户端。

视觉语言为 Claude Code 风格的暖纸色系（Anthropic 暖中性 + 陶土橘强调、发丝描边、衬线标题）；功能对齐 hermes 官方桌面版核心场景：常驻后端流式对话、工具调用可视化、会话管理、多 profile、插件/技能与市场、右侧 HTML 预览。

## 快速开始

```sh
npm install
npm start              # 启动（进程加载即预热 serve 后端，对话零冷启动）
npm test               # 服务层 + 契约回归：纯 Node、只读、秒级、不启动 CLI
npm run dist:mac       # 打包 dmg（另有 dist:win / dist:linux）
```

前置依赖是本机已安装的 `hermes` CLI；探测顺序为 `~/.local/bin/hermes` → `/usr/local/bin` → `/opt/homebrew/bin` → `~/bin` → PATH，统一由 `main/services/hermes-bin.js` 解析，**安装包不捆绑 CLI**。

无原生 API 时（例如直接在浏览器打开 `renderer/index.html`），`renderer/mock-bridge.js` 提供 Demo 数据用于纯 UI 预览。

---

## 一、总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer（renderer/，vanilla JS，无框架）                     │
│ 侧栏/多页签 · 流式消息与工具卡 · Composer · 状态条            │
│ 插件/技能/市场/设置整页 · 右侧「预览 | 终端」双页签           │
└────────────────────▲─────────────────────────────────────────┘
                     │ contextBridge 白名单（preload/preload.js）
┌────────────────────┴─────────────────────────────────────────┐
│ Main（main/main.js）                                         │
│  单实例锁 · 统一 IPC handle（异常兜底）· safeSend · 退出清理  │
│  ├─ hermes-chat.js      ChatChannel / GatewayTurn 回合编排    │
│  ├─ hermes-backend.js   常驻 `hermes serve` 托管与自动重启    │
│  ├─ gateway-client.js   WS JSON-RPC 客户端（心跳/重连/审批）  │
│  ├─ hermes-sessions.js  state.db 读写（FTS5/搜索/删除/置顶）  │
│  ├─ hermes-profile.js   profile 唯一真源                     │
│  ├─ plugins/skills/market/config-yaml/gateway/preview ...    │
│  └─ hermes-bin.js / logger.js   CLI 路径 / 脱敏日志           │
└──────────▲──────────────────────────┬───────────────────────┘
           │ WS /api/ws?token=         │ 子进程 / 文件
   ┌───────┴────────┐        ┌────────┴────────────────────────┐
   │ hermes serve   │        │ ~/.hermes[/profiles/<name>]      │
   │ (127.0.0.1:0)  │        │  state.db · config.yaml · .env   │
   └────────────────┘        └──────────────────────────────────┘
```

分层原则：**`main/services/` 全部是纯 Node 模块，不 require `electron`**，可脱离 Electron 直接 `require` 并单测。renderer 无 Node 权限（`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`），只经 preload 白名单通信。

## 二、五条数据通道

### 1. 主通道：`hermes serve` + WebSocket JSON-RPC

进程一加载就预热常驻后端，不再为每轮对话 spawn 一次性 CLI：

```
hermes -p <profile> serve --isolated --host 127.0.0.1 --port 0 --skip-build
```

- **`--isolated` 不是可选项**（hermes CLI v0.23.0 起）：CLI 改成「一台机器一个 machine-level gateway」，`hermes -p X serve` 默认会**附着到已存在的机器级服务并立刻退出**，只打印 `Hermes backend already running on this host: PID …, port 9119` —— 既不打 `READY` 哨兵、也不监听 `--port 0` 分配的端口，桌面端会判成启动失败并按 15s 退避无限重试。附着还意味着我们注入的 `HERMES_DASHBOARD_SESSION_TOKEN` 对那个服务无效（token 逐进程），REST/WS 一律 401。`--isolated` 让本 profile 拿到专属后端进程 + 专属 token，端口与代次仍由主进程掌握。

- 启动时生成 24 字节随机 token，经 `HERMES_DESKTOP=1` + `HERMES_DASHBOARD_SESSION_TOKEN` 注入子进程（loopback 鉴权豁免条件）；从 stdout/stderr 解析 `HERMES_BACKEND_READY port=<N>` 拿到随机端口。
- `GatewayConnection` 连 `ws://127.0.0.1:<port>/api/ws?token=…`，协议为 newline-delimited JSON-RPC：`gateway.ready` 握手、`session.create` / `session.resume` / `prompt.submit`、`session.usage` 快照、15s `gateway.ping` 保活、指数退避重连。
- `ChatChannel` 按 `tabId` 维护活跃回合与 generation；流式事件带 `tabId` 路由，已停止回合的迟到 delta 直接丢弃，避免串会话。
- 后端意外退出自动重启（退避上限 15s，稳定运行 >60s 重置计数）；exit 事件带 generation 校验，防止切换 profile 时旧进程退出误杀新后端。
- **运行时健壮性（后端换代 / 断线收敛）**：`_setStatus` 把 `generation`（第几代 serve）推给 `ChatChannel`；状态一变即 `_invalidateBackend()`——关掉指向旧端口 / 旧 token 的 WS、清空 `liveByTab` / `activeTurns`、把 `tab.liveId` 作废而**保留 `storedId`**（下一轮走 `session.resume` 续接历史）、默认拒绝挂起审批、给在途与排队回合各补一条明确错误 + `close`。这样 serve 崩溃重启或切 profile 后，原有页签不会拿着失效的 live session id 一直报错，也不会有旧连接在后台无限重连。
- `HermesBackend._restartPending` 让退避窗口内的 `start()` 只等待、不再 spawn 第二个 serve；`error` / `exit` 双事件经 `_scheduleRestart()` 去重（ENOENT 只发 `error` 也能重新拉起）。
- `GatewayConnection` 给每个 socket 加 `this.ws !== ws` 代次守卫，`close()` 先解绑再置 `connected=false`，`connect()` 在 CONNECTING / OPEN 时直接返回，`rpc()` 发送失败立即 reject 而不是挂到 `prompt.submit` 的 10 分钟超时；`ChatChannel._ensureGateway()` 连接超时会 `close()` 掉孤儿连接，并用 `_epochStamp` 丢弃等待期间已过期的连接。
- 停止语义：会话建立前按停止也会打上 `aborted`，`prompt.submit` 前检查，不会把消息发出去；后端不回 `message.complete` 时 10s 宽限期强制收尾，避免 `tab.current` 永久占用队列导致「停止后再发」被卡住。队列满 / 缺 tabId 的快失败路径同样补发 `close`，渲染层不会停在 `running=true`。
- **渲染层跨页签隔离**：`routeEvent()` 的数据模型对所有页签都更新，但只有 `visible = tab.id === state.activeTabId` 的页签能改 `#chat` DOM、状态条与读屏播报。此前后台页签的 `text` delta 会对当前可见页签执行 `replaceChild`，把用户正在看的那条消息替换掉；后台回合的 `tool_use` / `result` 也会整页重绘、把状态条误置「空闲」。流式文本仍走单节点 `replaceChild` 增量更新（不按 delta 整页重建），DOM 节点数由消息条数而非 delta 数决定。草稿的 400ms 防抖定时器在切页签与发送时显式取消，避免用新页签的 key 保存旧页签的输入。
- **整页路由只有一条出口**：插件 / 技能 / 市场 / 消息平台 / 看板五个 `.subpage` 与设置模态，统一由 `closeSubpages()` 收起；`新建会话`（顶栏、侧栏、引导按钮、命令面板）、切页签、打开历史会话都会走它，所以**在任何页面上点新建会话都会回到聊天视图**，不会停在旧页面。市场页记着「从哪个页来的」并在关闭时把来源页重新显示出来，因此它必须排在插件 / 技能页之前收起，顺序反了等于没关（契约按 `index.html` 里实际的 `.subpage` 清单逐个核对，新增整页忘了登记就会红）。
- `approval.received` 请求由主进程转发渲染层审批卡，**25s 无响应默认拒绝**，yolo 模式自动放行。
- **思考轨的事件语义（2026-11-10 修正）**：`thinking.delta` 在 v0.23.0 里是**等待提示**（颜文字 spinner、`⏳ waiting on …`），`agent_callbacks._agent_thinking_update` 注释明确写它不是推理块；真推理只在 `reasoning.delta` 上，并且被 `display.show_reasoning` 短路。旧实现把 `thinking.delta` 当思考内容、把 `reasoning.available` 当正文追加，于是折叠条里只有 `(｡•́︿•̀｡) brainstorming...` 这种占位、而真正的推理被灌进回答里。现在：`reasoning.delta` 增量进推理块、`reasoning.available` 以 replace 语义覆盖整块、`message.complete.reasoning` 兜底（必须在 `_finish` 之前发）、`thinking.delta` 只经白名单（`⏳⚠↻⚙` + waiting/loading/…）喂底部状态行。推理块按回合隔离（跨过本轮 user 消息就新建），插入位置在本轮 user 之后，`final` 快照到达时不会被排到回答后面。

### 2. 会话库：`state.db`

会话与消息历史存于当前 profile 的 `state.db`。用系统自带 `sqlite3` CLI（`-readonly -json`）读取，规避原生模块跨 Electron ABI 问题；写操作严格受限：

- 只读：列表、历史回放、token 统计、FTS5 全文搜索（含高亮片段）、空间占用。
- 受控写：重命名（`title` + `title_source='user'`）、置顶（递归 CTE 压缩谱系）、删除走 CLI 后回查。**不要在会话库上跑任意 SQL**；标识符经过白名单与转义。

> 字段坑：标题列是 `title`，不是 `display_name`（后者全库为空）；`messages.timestamp` 是 REAL **秒**（如 `1794146522.21`），不能用 `Date.parse()`。

**失败轮次诊断**：模型调用失败时，后端会补写一条 `display_kind='failed_turn'` 的助手消息，正文恒为 `Your request was not processed…`，真实原因在 `display_metadata.error_surface`（`error` / `code` / `provider` / `model` / `retryable`）。`loadHistory()` 先探测 `messages` 表列再动态投影（旧库缺列时降级为 NULL，SQL 不会报错），渲染层把这类消息还原成中文结构化错误卡：真实错误、模型/provider/错误码、是否可重试、以及「切换模型 / 用当前模型重试 / 查看原始错误」。上游 `retryable=false` 时不再建议盲目重发；实时 `result.error` 与 WS 错误也走同一张卡。

> 配置优先级坑：桌面端 `userData/config.json` 的 `model` 会覆盖 CLI `config.yaml` 的 `model.default`。若这里存了已下线的旧模型名，新建会话同样会失败；错误卡会直接提示这一情况。
>
> **思考程度并进模型菜单**：桌面上只留一个「模型」chip，点开是模型列表，最后一行「思考程度」带当前档位与 `›`，悬停 / 点击 / `→` 展开二级菜单（none…ultra，当前项打勾），`←` 或 Esc 先收二级再收一级；右侧放不下时二级菜单整体翻到左边。二级菜单宿主声明在 `index.html`，但由 `openChipMenu` 单独定位 —— 塞进 `#chip-menu` 会被它的 `overflow:hidden` 裁掉一条。选档只写桌面端 `userData/config.json` 的 `reasoning`（`setEffort`），不动 CLI 的 `agent.reasoning_effort`；chip 上只在非默认档位时追加 `· high`，常态不占视觉噪音。命令面板的 `/effort` 仍可用，直接打开同一个菜单并落到二级。

> **模型漂移闭环**：`hermes-config.js` 行级只读解析当前 profile 的 `config.yaml`（限定 `model:` 块，不误读 `providers:` 等段），由 `hermes-config:model-state` 返回 `defaultModel` / `models.json` 列表 / 是否已登记。模型选择器把 **CLI 默认模型列为首项并去重**（旧实现只列 `models.json`，而 CLI 默认常常不在其中，用户即使知道正确值也选不到）；启动时若桌面端已保存的模型与 CLI 默认不一致，composer 上方浮出非阻断提示（absolute，零布局占用），提示条上的「跟随 CLI 默认」必须用户主动点击，另有「忽略」仅在本次会话生效。设置页「模型」分类顶部另有常驻的**默认模型**区块：并列展示桌面端当前默认与 CLI 默认、是否一致，提供模型下拉与「设为默认模型」按钮（以及「跟随 CLI 默认」快捷入口）。两处写入口都只改 `userData/config.json`，都不碰 CLI 的 `config.yaml`；下拉与模型 chip 共用 `modelRows()` 候选规则，CLI 默认置顶去重，配置里存着清单外的失效模型名时也会列出「当前配置」以便改掉。切 profile 会 reload 重新核对。全程不改 CLI、不写 `~/.hermes`。

### 3. CLI 子进程：`hermes -p <profile> <cmd>`

插件、技能、市场、配置、消息平台状态等仍走 CLI 命令。所有调用统一：

- `resolveHermesBin()` 拿绝对路径，`safeArg()` 拒绝选项注入 / shell 元字符 / 控制字符 / 超长参数；
- `profile.cliArgs()` 恒定前置 `-p <name>`（CLI 的 pre-parse 优先级高于 `~/.hermes/active_profile` sticky 默认）；
- 市场类操作串行队列 + 心跳 + 超时 + identifier 白名单；技能开关直写 `config.yaml`（约 80ms），插件开关保留 CLI 的 PM 准入事务。

**列表类读取一律不挡在页面路径上**。`hermes plugins list --json` 实测 6.5–7.5s、
技能枚举 5.9–7.1s、`hermes tools list` 6.5–7.5s、`hermes mcp list` 约 2.5s（均为
Python 冷启 + 目录/配置扫描），因此插件页、技能页、工具集、MCP 四处走同一套
「磁盘缓存 + stale-while-revalidate」：

| 情形 | 行为 | 耗时 |
| --- | --- | --- |
| 内存命中（30 分钟内） | 直接返回，不触发任何子进程 | ~2ms |
| 缓存过期 | 先返回旧列表，后台异步重拉，完成后经 `catalog:updated` 原地重绘（保持滚动位置） | 2–60ms |
| 应用重启后首次打开 | 读 `userData/catalog-{plugins,skills,tools,mcp}.json`（上次运行结果） | 15–180ms |
| 从未成功拉取过 | 只能等一次 CLI/Python | 2.5–8s |

缓存按 profile 名隔离，落 Electron `userData`，不写 `~/.hermes`；装/卸插件、切换
profile 会连磁盘缓存一起删除，避免读到操作前的旧列表。**写路径永不读缓存**：
插件开关、技能开关（直改 YAML）、工具集开关、MCP 增删之后的回读都是真跑 CLI，
`mcp test` 也每次都真连，缓存只服务「首次渲染」。显式「刷新」按钮仍走
`force: true` 真拉一次，MCP 会先提示约 2–3 秒。

打开设置页会顺手预取工具集与 MCP 两份列表（缓存命中时是毫秒级的空调用，不会起
子进程），所以点进这两个分类通常是即时出结果。

### 4. 终端与 HTML 预览（右侧 rail）

- 终端：`node-pty` 为 optionalDependency，编译失败时降级为管道 shell 并明确提示。
- 预览：允许本机任意目录的 `.html/.htm/.xhtml/.svg` 或手工输入 http(s) URL；主进程只做路径解析与 `fs.watch`（去抖 180ms）通知刷新；渲染层用 **sandbox iframe**（无 `allow-same-origin`）加载。
- 工具输出里出现 html 路径时自动跟随；双页签默认「预览」，终端按需创建。
- **终端不再有乱码**：pty / 管道输出先经 `StringDecoder('utf8')` 分块解码（避免一个汉字跨两次 data 事件被切成 U+FFFD），再由 `renderer/term-screen.js` 的字符屏幕解释 SGR 颜色、清行、光标移动、OSC 标题、`\r` 重绘与退格，只把可打印字符写进 `<pre>`；转义序列可能跨 IPC 分片，未收齐的尾部留到下一片。颜色不做渲染（避免 `innerHTML` 与 CSP 风险），字体链补了中文 / emoji / 框线回退，长行改用 `overflow-wrap: anywhere`。
- **宽度可调**：左缘 8px 手柄拖拽（向左变宽、向右变窄，范围 280–760px，**默认仍是定版 400px**），也支持键盘 `←/→`（Shift 加速到 48px）、`Home/End` 到边界、`Enter` 或双击复位；宽度记在 `localStorage('rail-width')`。上限按「主区至少留 420px」实时收紧，窗口变窄时自动回收但不覆盖用户偏好，再窄就交给既有 `.compact` 降级。手柄是 `role="separator"` + `aria-valuenow`，读屏可播报；拖拽期间禁用 iframe 命中，否则跨文档 iframe 会吞掉 `pointermove`。逻辑在独立零依赖的 `renderer/rail-resize.js`，只写 CSS 变量 `--rail-w`，不动主区几何与双主题 token。

### 5. Kanban 看板：复用 serve 的插件 REST（读 + 受控写 + 派发）

`hermes serve` 与 `hermes dashboard` 共用同一个 FastAPI app，启动时已把内置看板插件挂到 `/api/plugins/kanban/`。桌面端**不再直读 `~/.hermes/kanban.db`，也不新起进程**——这与 CLI 自带桌面端 `apps/desktop` 的做法一致（其注释即 "No new backend"）。

- `ChatChannel.backendInfo()` 提供 `{ port, token, generation, state }` 只读快照；`hermes-kanban.js` 每次请求现取，后端换代自动改用新端口/token。
- 请求固定 `127.0.0.1` + `X-Hermes-Session-Token`；**token 只在主进程**，渲染层只传筛选条件 / 表单字段，拿不到端口、token 或任意 URL。
- 读端点固定 `GET`，只开放 9 个：`/board`、`/tasks/:id`、`/runs/:id`、`/stats`、`/assignees`、`/boards`、`/config`、`/diagnostics`、`/workers/active`。写端点只有六条固定白名单：`POST /tasks`（新建任务）、`POST /boards`（新建看板）、`DELETE /tasks/:id`（删除任务）、`PATCH /tasks/:id`（提交派发，body 恒 `{status:"ready"}`）、`PATCH /tasks/:id`（拖拽改派，body 只有 `{assignee}` 或 `{assignee, status:"ready"}`）、`POST /dispatch`（一次 dispatcher tick）。任务 id / board slug / run id / 受让人一律过严格正则，query 走 `URLSearchParams`，写 body 按字段白名单清洗并限长；拒绝重定向、6s 超时、2MB 响应上限。
- 新建任务默认落在 `triage` 收集箱、**不会触发调度器派发**；选 `ready` 时界面显式警示可能被 worker 立即认领。表单带幂等键、提交期间禁用按钮，写后立即回读 `/board` 与辅助数据。新建看板不传 `switch`，**绝不改 CLI 的 `current` 指针**；删除任务必须过二次确认卡。
- **派发控制台**是唯一会唤醒 agent 的路径，三重兜底：`dry_run` 缺省 `true`（只有显式 `false` 才真派发）、单次最多启动 4 个 worker、同一客户端串行执行（并发直接拒绝）。试运行只预览「哪些 ready 任务会被派发 / 为什么跳过」，不启动任何进程；真派发必须过二次确认卡，明确告知会启动 agent、消耗模型额度并可能回收超时 worker。`PATCH /tasks/:id` 只把 `triage / todo / scheduled / blocked / review` 推进到 `ready`，同样要二次确认。派发结果按白名单投影，`spawned` 只留任务 id 与受让人，工作区绝对路径 / worker PID / claim 锁一律不透出；`/workers/active` 同理。写后回读 `/board` 并刷新活跃 worker 列表。
- CLI 返回的 task 行含 `workspace_path` / `claim_lock` / `worker_pid` 等本机敏感字段，服务层按白名单投影后才交给渲染层，正文与列表长度封顶。
- **项目（命名工作空间）没有 REST 写端点**：建/改一律走 CLI `hermes project`（`main/services/hermes-project-cli.js`），渲染层只传结构化字段，argv 由主进程白名单拼装、40s 超时。`project:pick-folders` 是原生目录选择器（可多选，只回绝对且真实存在的目录，上限 8）；`project:action` 只放行 rename / add-folder / remove-folder / use / set-primary；`app:copy` 只经主进程剪贴板。侧栏项目树仍只读 `GET /api/profiles/projects/tree`。所有写操作都由用户点击触发，渲染层不得自动调用。
- 渲染层用 `/board` 的 `latest_event_id`（`task_events` 单调递增游标）每 5s 比对一次，变化才重绘；页面隐藏即停轮询，首屏与抽屉各有独立代次戳，切页后的旧响应不写 DOM。
- 多 board 用 `?board=<slug>` 逐请求限定，**不改 CLI 的 `current` 指针**。`ready` 之外的任意状态推进、`/tasks/bulk`、`/decompose`、`/specify`、`/estimate`、`/links`、`/reclaim`、`/runs/:id/terminate`、`/orchestration` 配置写入仍然一律不接，避免误触发 LLM 计费或改动 CLI 编排配置。
- 页面默认是「统计条 + 状态 chip 筛选 + 分组卡片网格」（空状态不占列、不再有竖排 rail），可一键切换经典列视图；抽屉里可看依赖 / 评论 / 运行记录 / 事件，并按 `session_id` 跳回会话。
- **新建任务的受让人是自绘下拉**：候选只来自磁盘上真实存在的 Hermes profile（原来的 `input + datalist` 手打已移除），「留空则不指派」是占位项；避免打错名字导致派发器用 `hermes -p <名字>` 拉不起 worker。
- **拖拽派发给指定 worker**：工具栏下方常驻一条 worker 投放区，列出 `/assignees` 里 `on_disk` 的 Hermes profile（附各自在跑的 worker 数）。**投放区几何在拖动期间恒定**：左侧提示是 148px 定宽槽（拖动中显示被搬的卡片标题，超出省略），投放结果另起一行独立状态栏——原先提示文案一变，整排 chip 就在指针底下漂移，根本对不准。拖动中所有可投 chip 亮虚线环，悬停的那个转实线并浮起；指针落在 chip 缝隙里按 26px 半径就近吸附；贴近 chip 行左右边缘时按距离自动横向滚动（单 rAF 循环，不用定时器）。幽灵是整张卡的克隆（抹掉 `data-kb-task` 与 tabindex，`pointer-events:none`），水平居中于指针、垂直浮在指针**上方** 18px —— 向下跟随会正好盖住要投放的那个 chip。Esc 取消时幽灵淡出并复位，`prefers-reduced-motion` 下直接移除。把卡片拖到某个 profile 上，落地只做两件 CLI 原生支持的事——`PATCH {assignee, status:"ready"}` 改派并推进到 ready，然后弹出确认卡问「是否立即启动 worker」；取消即只保持指派，等调度器 60s 内的自动 tick。真派发走 `dispatch_task`：先 `dry_run` 预演确认这张卡就是本次 tick 的 ready 队首，**是**才真派发 `max=1`（只买一个名额，不顺带唤醒别人的卡片），**不是**则不写库并说明被谁挡在前面。拖拽用指针事件实现，越过 5px 阈值才算拖动并吞掉收尾 click；`running`（需先 reclaim）与 `done / archived` 的卡片不可拖；卡片按状态输出 `data-kb-drag`，拖动中暂停轮询与投放区重建，避免投放目标被换掉。

## 三、Profile 模型

桌面端切换 profile **完全不写 `~/.hermes`**，也不改 CLI 安装目录：

| 项 | 位置 |
|---|---|
| 当前选择 | Electron `userData/active-profile.json`（唯一写入点） |
| default home | `~/.hermes` |
| named home | `~/.hermes/profiles/<name>` |
| CLI sticky | `~/.hermes/active_profile`（**只读**，仅用于设置页提示差异） |

`hermes-profile.js` 是所有路径的唯一真源：`home()` / `dbPath()` / `configPath()` / `env()` / `cliArgs()`。切换会重启后端、重载界面、失效缓存并重新预热插件/技能列表；入口有品牌行右侧下拉与设置页 Profile 分区两处。

## 四、功能现状

| 能力 | 状态 |
|---|---|
| 多页签会话、流式响应、工具卡、停止生成、消息复制/重试 | ✅ |
| 会话列表 / 历史 / FTS5 搜索 / 重命名 / 置顶 / 删除 / 空间管理 | ✅ |
| token 速率与消耗、上下文占比、成本、tps/延迟、消息脚注（**用户消息同样显示 token**，整行常显、不依赖悬停） | ✅ |
| 消息排版逐项对齐 dsh（2x 截图逐像素实测）：用户气泡 `#eef3fd` + 16px 圆角 + `padding 10/16`、正文与气泡同字号 16px/26px、助手消息无头像+名字头、正文上方是「已完成，用时 N 秒」摘要行 + 整列发丝横线、底部信息行（图标 → 用量 → 时间）在文档流内紧随消息，token 图标是 dsh 同款三层数据库圆柱（16px） | ✅ |
| 状态条三段式：模型 / 轮次·tokens·缓存·上下文圆环 / 空闲与会话；无用量时圆环整组收起，切换会话自动复位 | ✅ |
| 消息卡片：GFM 表格、代码块语言/行数/复制、超宽横滚提示、图片失败回退、错误卡、工具行 | ✅ |
| 失败轮次：还原 `display_metadata` 真实错误（含模型/提供方/错误码/可重试）与切换模型、重试入口 | ✅ |
| 模型漂移：CLI 默认模型可选、启动比对、非阻断提示 + 一键跟随（用户点击才写配置） | ✅ |
| 设置页「模型」默认模型：当前值 / CLI 默认对照、模型下拉、一键「设为默认模型」与「跟随 CLI 默认」（只写桌面端配置，不动 CLI） | ✅ |
| 多 profile 切换（两处入口） | ✅ |
| 插件 / 技能：搜索、过滤、分组、卡片、启停、列表缓存预热 | ✅ |
| 插件 / 技能市场：15 个来源、安装前能力声明与只读预览、默认最小权限确认、只读更新检查、进度 | ✅（2026-11-08 已实跑官方条目装后即卸，验证 UI→IPC→CLI 全链路） |
| 右侧 HTML 预览 + 终端双页签 | ✅（左缘手柄可拖拽 / 键盘微调宽度，默认 400px 不变；ANSI 字符屏幕 + UTF-8 分块解码，终端不再出现控制符乱码） |
| 思考程度收进模型菜单二级（`模型 ▾ → 思考程度 → none…ultra`），不再占一行独立 chip | ✅（二级菜单左右翻边、键盘可达、只写桌面端 `reasoning`） |
| 全应用**自绘下拉框**（`hm-select`）：市场来源、看板筛选 / 新建表单、派发并发、设置页默认模型、看板受让人 | ✅（不再使用 macOS 原生 `<select>` / `<datalist>` 弹层；键盘可达、分组标题、双主题） |
| 消息平台接入页（只读状态视图） | ✅（该线已冻结，不再扩展） |
| 危险操作审批卡、思考折叠、命令面板 ⌘K、快捷键帮助、草稿 | ✅ |
| 思考轨（2026-11-10 重做语义）：只渲染真推理（`reasoning.delta` / `reasoning.available` / `message.complete.reasoning`），折叠条显示字数与首段；等待提示（`thinking.delta` 颜文字 spinner）只喂状态行，不再伪装成思考内容 | ✅ |
| 设置页「上游思考输出」：只读 `display.show_reasoning`，关闭时给出二次确认卡写回 `hermes config set display.show_reasoning true`（写 CLI 配置，影响命令行，需用户点击） | ✅ |
| 窄主区降级：主区 ≤600px 时输入行换行、工具栏分行、卡片退单列，发送按钮始终可见 | ✅ |
| 模态可访问性：`role="dialog"` + `aria-modal`、背景整块 inert、关闭后焦点归还 | ✅ |
| 设置页：主题/字号/步骤详略即时生效 | ✅ |
| 设置页：快捷键自定义（录制 / 冲突检测 / 保留键 / 恢复默认 / 帮助页同步） | ✅ |
| 设置页：记忆（只读 `memory status` + 内置记忆文件元信息，不做启停 / 重置） | ✅ |
| 设置页：健康检查（`status` / `config check` / `fallback list` / `memory status` / `doctor`，只读原样输出） | ✅ |
| 运行时健壮性：后端换代作废旧会话、WS 代次守卫、在途/排队回合收敛、停止宽限期强制收尾 | ✅ |
| 附件：图片 / PDF / 任意文件多选与拖拽，走 `image.attach` / `pdf.attach` / `file.attach`，失败降级为提示 | ✅ |
| 会话导出：Markdown / HTML / JSONL，格式白名单 + 系统保存对话框定路径 | ✅ |
| 设置页：工具集开关（只作用于 CLI 平台，操作后回读 CLI 真实状态） | ✅ |
| 会话内查找 ⌘F：计数 n/m、上下跳转、Custom Highlight 高亮（不改 DOM，流式输出不打断） | ✅ |
| 设置页：MCP 服务器（列表 / 连接测试 / URL 添加 / 移除，仅 https 与本机 http，写后回读 CLI 确认） | ✅ |
| 设置页：定时任务（任务列表 / 调度器状态 / 运行历史 / 暂停·恢复·立即运行·移除 / 新建恒为暂停） | ✅ |
| 看板：CLI 原生任务队列（统计条 + 9 状态筛选 + 分组卡片网格 / 经典列视图双布局、卡片详情抽屉、看板/受让人/租户/搜索筛选、`session_id` 跳会话、`latest_event_id` 轮询、空状态引导） | ✅（另支持**新建任务 / 新建看板 / 删除任务 / 提交派发 / 拖拽卡片指派给指定 worker 并可选立即启动 / 试运行预览 / 手动派发一次 / 活跃 worker**；拖列改状态、decompose、批量操作仍留给 CLI / Dashboard） |
| 项目 / 工作空间（对齐官方 `project-dialog`）：侧栏「新建项目」「打开文件夹为项目」、项目行 ⋯ 菜单（重命名 / 添加文件夹 / 设为活动 / 在访达中显示 / 复制路径 / **删除项目**） | ✅（**删除项目走官方 `projects.delete` RPC，两次点击确认，只移除项目记录、不动磁盘文件 / git 仓库 / 工作树；删完刷新侧栏树，落在该项目里的 `tab.cwd` 自动回落默认目录**；一个弹窗三模式 create / rename / add-folder；弹窗在 `#frame` 外的全局浮层，从聊天 / 设置页直接打开**不跳看板页**，与命令面板共用 `frame.inert` 背景隔离；输入区「权限」胶囊右侧有项目下拉（自绘 `hm-select`，候选 = 侧栏显式项目，选中即把项目根写进 `tab.cwd`，已开始的会话另开项目页签）；侧栏项目分组可折叠（点项目名收/开，状态记在 localStorage；展开后首屏 5 条、「再显示」每次 +50，空项目显示「暂无会话」，「＋」会先展开目标分组）；会话标题按官方 `sessionTitle` 兜底（标题 → 首条消息预览 → 未命名会话，退化成会话 id 的标题不当标题用）；原生目录选择可多选、首条标「主」、选完按目录名自动命名；名称 + ≥1 文件夹才可提交；创建带 `--use` 设为活动、想法写 `IDEA.md` 且不覆盖、建完回到项目根开新会话；写操作全部经 argv 白名单，失败保留表单可重试） |
| 小球模式：黄灯 / ⌘M / ⌘⇧M / 命令面板 `/orb` 把窗口收成桌面一颗可拖动的球，**点球弹出迷你聊天窗**（380×520），在球旁边就能接着聊 | ✅（`main/orb.js` 球 + `main/orb-chat.js` 迷你窗，主窗口只 `hide()` 不改几何；小窗与主窗口共用同一个 chat tab；球面体积感 / 单信号状态系统 / 球窗连接闭环 / 无障碍播报；`main/orb-access.js` 全局快捷键 + 球右键菜单里的双模式开关（菜单栏托盘已移除）、连接轨按回合呼吸、开窗即聚焦输入框） |

### 小球模式（收起成桌面小圆球）＋ 迷你聊天窗

- 触发：黄灯最小化 / `⌘M` / `⌘⇧M` / 命令面板 `/orb`。
- **点球 → 弹出迷你聊天窗**（380×520，贴着球摆：球在右半屏就开在左侧）；再点球 / Esc / ⌘W / 右上角 × 收起。**不恢复主窗口**。
- 小窗里发消息、看流式回复、停止回合、当场批准危险操作，都和主窗口**同一个会话**：主窗口只是 `hide()`，渲染层与 `tab.items` 还活着；小窗发出的用户消息会回灌给主窗口（`orb:user-message`），所以回主窗看到的是完整对话，不会「只有回答、没有提问」。
- 小窗右上角 ⤢ = 在 Hermes 主窗口中打开（`restore()→show()`，尺寸/位置/滚动位置原样不动）；球右键「打开 Hermes 窗口」同效。
- 球是**独立 BrowserWindow**（68×68，透明、无边框、`skipTaskbar`、`pop-up-menu` 层级 + 跨空间可见），小窗同样是独立透明窗口（可拖拽改尺寸 320–560 × 400–780）。
- **球面与状态系统**：球体用两层径向渐变 + 顶部镜面高光 + 底部环境反光做出体积感（不是纯色圆盘）。每个状态**只有一个主视觉信号**，避免 52px 里堆噪点：idle 静息、busy 一圈琥珀旋转弧（不叠状态点）、approval 右上角珊瑚数字徽标（不叠状态点）、offline 右下角暗红点。状态由主进程按「在途回合数 / 待审批数 / `backendInfo().state`」推导，5s 低频对齐一次；`starting/idle` 不报红。
- **球 ↔ 小窗的连接闭环**：小窗展开时球亮一圈细琥珀内环、H 字标提亮，`aria-pressed` 与状态播报同步更新；小窗按实时方位在朝球那一侧显示一条短连接轨，球拖到另一侧时自动换边。不论从点球、Esc、×、拖球还是 ⤢ 收起，主进程都会回推球态，内环不会残留。**回合进行中连接轨会呼吸**（透明度 + 纵向伸缩 1.9s），状态只认主进程下发的 `running`（`orbchat:state` / `bootstrap` / `sync`），渲染层不根据本地事件自造状态机；`prefers-reduced-motion` 下停转但保留一条完整可读的静态轨。
- **球的 Profile 下拉**：球底部 hover 时浮出一枚细箭头（也可右键或键盘 `↓`），弹出「切换 Profile」与「最近会话」两组。每个 profile 都有二级菜单列出最近 5 个会话，第 6 个起收进「更多会话」；菜单数据由主进程只读各 profile 的 `state.db` 拼装（路径经 `validName` / `exists` 白名单化），球窗口的 preload 一行未动，拿不到任何绝对路径或 token。点会话会展开主窗口；若会话属于别的 profile，复用渲染层既有 `doSwitchProfile()` 链路（重启后端 + reload），重载后由一次性 `sessionStorage` 意图补上打开动作，不在球里另造状态机。
- **全局快捷键**：`Alt+Shift+H`（mac 显示 `⌥⇧H`）随时开关迷你聊天窗，由 `globalShortcut` **只注册一条**，停用或 `will-quit` 时成对注销；被其他程序占用时只记日志并置灰球菜单里的开关，不抛错。
- **菜单栏托盘已移除**（2026-11-11 用户要求）：不再创建 `Tray`、没有托盘菜单与 tooltip，`renderer/orb-tray*.png` 一并删除。托盘原先承担的「切模式 / 停快捷键 / 打开主窗口 / 退出」全部收进**球右键菜单**与主窗口应用菜单（`⌥⇧H` 仍是主窗口收起后的兜底入口）。
- **两种模式**（球右键菜单切换，存 `userData/orb-prefs.json`，绝不写 `~/.hermes` 或 CLI `config.yaml`）：`always` 是默认的常驻小圆球（原有行为）；`hotkey` 是「仅快捷键唤起」——主窗口收起后桌面不常驻球，球只在迷你聊天窗打开期间出现，收起即隐去，只能靠 `⌥⇧H` 叫回来。点 Dock / 再次双击 app 在任何模式下都能恢复主窗口。偏好文件损坏或混入非法字段一律回 `always + 快捷键开启`，不会把入口弄丢。
- **球态低频对齐**判据是「主窗口已收起」而不是「球可见」：`hotkey` 模式球隐着，回合态照样每 5s 校准一次（仍是递归 `setTimeout`，不用 `setInterval`）。
- 无障碍：球是 `role="button"`，带动态 `aria-label` / `aria-pressed` 与 `aria-live` 状态播报（「正在回复」「有危险操作待审批，3 条」「后端已断开」「迷你聊天窗已展开」）；小窗输入框聚焦只给 2px 品牌色柔光、边框保持中性，不再被误读成校验错误；`prefers-reduced-motion` 下弧停转但保留静态可读信号。
- 拖动用 Pointer Events 自己算屏幕坐标（透明窗口上 `-webkit-app-region: drag` 会吞掉 click），位移 <4px 且 <350ms 判为点击；拖动球会先收起小窗（一次拖动只收一次）。**拖动坐标是增量式**：`screenX - clientX` 得到的是**窗口原点**而非「指针在窗口内的抓取偏移」，目标位置必须是「按下时的窗口原点 + 指针屏幕位移」；早期版本拿窗口原点去减 `screenX`，球在屏幕右侧时一拖就飞到左上角（实机探针 `1588,651` → `126,26`）。按帧节流发 IPC；跨屏按球心选屏，整颗球完整落在某块 `workArea` 内就放行，拖到副屏不会卡在边缘。位置存 `userData/orb.json`，`dragend` 立即落盘（不再等 400ms 节流定时器，拖完立刻退出也不会丢位置），读回时始终收进可见区。
- 小窗草稿只留在主进程内存里：收起再点开不会把人写了一半的话弄丢，也不落盘、不进日志。
- 右键菜单：打开聊天 / 打开 Hermes 窗口 / 常驻小圆球 / 仅快捷键唤起 / 全局快捷键开关 `⌥⇧H` / 隐藏小圆球 / 最小化到程序坞（原生最小化逃生口）/ 退出 Hermes。
- **开窗即聚焦输入框**：点球 / 按 `⌥⇧H` 把面板亮出来后，光标直接落在输入框末尾（`orbchat:focus` 通道，渲染层 `input.focus()` + 插入点落在草稿末尾），不用再点一下鼠标才能打字；草稿保留，插入点不会全选覆盖。
- 已知取舍：两个窗口的安全面与主窗口同等级（`sandbox` + `contextIsolation`，各自独立 preload）。球只暴露 `drag/dragEnd/click/restore/menu/onStatus`，小窗只暴露 `bootstrap/send/abort/approve/expand/close/draft` + 七个订阅；通道分别锁在 `orb:` 与 `orbchat:` 前缀，都没有 token、CLI、看板、终端或文件接口。

## 五、设计系统

- 亮色 `--canvas #FAF9F5` / `--sidebar-fill #F5F4EE` / `--text #141413`；深色暖炭 `#1A1A18`。强调色陶土系，实心按钮前景用 `--on-blue`（亮色白字、深色深字）。
- **所有文本色在 canvas / sidebar / fill-2 上均 ≥ 4.5:1（WCAG AA）**，装饰色 ≥ 3:1；四级文字色阶 `--text` / `--text-2` / `--text-3` / `--caption` 在两主题都拉开层级。全局 `:focus-visible` 焦点环、`prefers-reduced-motion` 支持。
- 圆角 3/6/8/10/12，靠 1px 发丝描边分层，极轻阴影；大标题与字标用衬线，正文系统 sans，代码等宽。**唯一例外是输入卡**：`--r-2xl: 20px` + 两层柔影（1px 贴地 + 26px 大范围极淡），只给 `#composer` 用。
- **输入区按 dsh 桌面版改版（2026-11-11）**：左侧圆形 `+` 附件键（纯图标，必带 `aria-label`）＋「完全权限 / 审批模式」胶囊（`aria-pressed`，开关不是菜单，所以不加下拉箭头）；右侧模型 chip 用 `⌄`；发送键两态 —— 空输入是 `--blue-soft` 淡底 + 强调色箭头，敲了字才落成实心 `#ad4c2a` + 白箭头（`syncSendState()` 挂在 `autoGrow()` 上，草稿恢复 / 回车历史 / 发送清空都会跟着更新）。占位文案「发消息或创建任务，/ 调用指令，@ 文件或对话」有两处（HTML 初值 + `syncComposerState` 的运行态分支），改一处不算改完。
- **底部用量带**：`↻ N 轮 M 步`（助手回合数 / 工具调用数，实时算）· `▤ 总量 tok · 缓存命中 x%`（输入输出拆分进 title）· **上下文圆环 + 百分比**。圆环是 16px 的 SVG（r=8、`stroke-dasharray:50.27` 与 JS 的 `CTX_RING_C` 同值、`rotate(-90deg)` 从 12 点起顺时针、端点圆角），底环用 `color-mix(--text-3 22%)` 而不是固定浅色，深色主题下自动变亮；>80% 转成告警色。**没有横向进度条**——它和文字并排像一根多余的分隔线。`#st-ctx` 的 title 保留 `已用/上限` 明细，无用量时整组 `hidden`（`display:inline-flex` 会盖掉 `[hidden]`，所以有一条显式 `display:none`）。会话 id 只显示前 8 位。
- **消息底部信息行**：与 dsh 一致**整行常显**（不依赖悬停）—— 16px 描边图标（复制 / 用户消息的重试）+ 「圆柱图标 + 用量 N tok」（**不套胶囊描边**）+ `HH:MM` 时间（完整到秒在 title 里），整个 `.msg-foot-row` 用 `absolute` 贴在本条消息底边下方 6px、零布局影响，消息自己的 `margin-bottom: 34px` 让出通道。悬停只把图标提亮到 `--text-2`，位置与宽度不变（否则数字会左右跳）；**不做点赞 / 倒赞**（用户 2026-11-11 明确不要）。单条用量：实时回合取「会话累计值的差」（`tab.usageBase`）；**CLI 的 `messages.token_count` 实测整列为 NULL**，历史消息退回按字符估算（汉字 1.3 字/token、其余 3.8 字符/token）并标 `≈`，title 注明估算口径。
- **几何度量是用户多轮定稿的**（侧栏缩放与拖拽宽度、图标对齐、页面引导按钮坐标），改视觉只碰颜色 / 圆角 / 描边 / 阴影 / 字体 / 状态反馈，不要改布局尺寸。**品牌行 logo 是例外**：2026-11-11 按反馈左移到与下方菜单图标左沿持平（`.sb-menu` 10px + `.sb-item` 10px = 20px），切换 Profile 的胶囊从 `position:absolute; right:-14px` 改成 `margin-left:auto` 的常规 flex 项并放宽名字限宽；侧栏收窄时优先压缩字标，胶囊永远完整可见、不再被 `overflow:hidden` 裁成 `defa…`。
- **下拉框一律自绘**：`renderer/ui-select.js` 提供 `<hm-select>`，保留 `.value` / `change` / `focus()` / `reset()` 语义，候选文本走 `textContent`；面板挂在 `document.body` 用 fixed 定位，避免被侧栏或弹窗的 `overflow:hidden` 裁掉，全局同时只开一个。支持 `<optgroup>` 分组标题、`↑↓ / Enter / Esc / Home / End` 与首字母跳转、`role="combobox" / "listbox"`、点击外部关闭和 `prefers-reduced-motion` 降级。
- 窗口最小 940px、侧栏可拖到 520px，叠加后主区仅约 370px。`app.js` 依据 `#main` 实际宽度切 `.compact`（ResizeObserver + 窗口 resize + 侧栏 style 变化三重兜底，隐藏窗口下也能同步），`styles.css` 末尾「窄主区降级层」只在该 class 下生效，主区 >600px 时零影响。卡片网格统一用 `minmax(min(Npx, 100%), 1fr)`，容器窄于最小列宽时自动退单列，不撑破页面。
- 三个 `.palette` 浮层都在 `#frame` 之外：模态打开时整块背景 `inert`，Tab 不会跑到遮罩下的侧栏/输入区；关闭时先解除 inert 再归还焦点，否则 inert 内元素会静默拒绝 `focus()`。
- `renderer/styles.css` 末尾有「Claude Code 组件细化层」覆盖块；`:root` 保留旧 alias 变量名，规则层无需迁移。

## 六、安全设计

- renderer 无 Node 权限；CSP 以 `default-src 'self'` 收敛脚本，`base-uri / form-action / object-src 'none'`，`frame-src` 仅 `self file: http: https:`，禁止 `unsafe-eval`。
- 统一 `handle()` 包装所有 IPC：异常脱敏后落日志并返回稳定形态，不外泄堆栈；`safeSend()` 检查 `webContents.isDestroyed()`。
- `openExternal` 仅允许 https 与本机 loopback http；预览路径与 CLI 参数均白名单化；`cleanSettings()` 收敛 localStorage 设置的类型/枚举/范围。
- MCP 添加只放行 https 与本机 http，`stdio --args` 等交互式流程不开放；定时任务新建恒带 `--paused`，暂停/恢复/立即运行/移除均需二次确认卡；两者写操作后回读 CLI 列表确认终态，回读失败只给 warning 不谎称失败。
- 看板 REST 客户端读固定 GET、写只有六条路径白名单（body 逐字段清洗、幂等键、默认 triage、绝不动 current 指针），严格 id 与受让人正则 + loopback 端口校验；会话 token 不进 preload / renderer / DOM，任务行与派发结果按字段白名单投影，工作区绝对路径、认领锁、worker PID 一律不透出。删除任务、提交派发、拖拽确认、真派发都需二次确认；新建弹窗打开时看板主体（含投放区）被局部 `inert` 隔离。派发 `dry_run` 缺省 true、单次上限 4、串行锁；拖拽派发额外先预演确认队首，不匹配时零写入；会改 CLI 编排配置或触发 LLM 计费的端点一个都不接。
- 日志落 `userData/logs/app.log`，单行 JSON、2MB 轮转，写入前对 token / api_key / password / Bearer / WS URL 脱敏。
- **小球与迷你聊天窗与主窗口同等级沙箱**：各自独立 preload —— `preload/orb-preload.js` 只暴露 `drag / dragEnd / click / restore / menu / onStatus`，`preload/orb-chat-preload.js` 只暴露 `bootstrap / send / abort / approve / expand / close / draft` 与六个订阅；通道分别限定 `orb:` / `orbchat:` 前缀。`transparent + alwaysOnTop` 不影响 `sandbox: true` 与 `contextIsolation: true`，两个窗口都拿不到 token、CLI、看板、终端、文件接口。IPC 只接受本窗口 `webContents` 的 sender，球的位置写入前收进 `workArea`；小窗只推五条固定事件（`PUSHABLE` 白名单），草稿与会话上下文都只存主进程内存、不落盘。
- **全局快捷键只在主进程**：`main/orb-access.js` 不注册任何 IPC、不暴露 `contextBridge`，两个小窗的 preload 暴露面一行未动；`main/orb-prefs.js` 是纯 fs 模块（可在零依赖单测里跑），只写 `userData/orb-prefs.json`。模式与快捷键开关都走主进程的菜单回调，renderer 拿不到 `globalShortcut` 能力；菜单栏 `Tray` 自 2026-11-11 起整体移除，`main.js` 里也查不到 `new Tray` / `setContextMenu`。
- **CDP 调试口不再是后门**：仅 `HERMES_CDP_PORT` 显式环境变量开启，打包版还需 `HERMES_ALLOW_CDP=1` 或 `--dev`；旧实现只要 `/tmp/hermes_cdp_port` 存在即开放（`/tmp` 全局可写）。
- 单实例锁避免多开拉起多个 serve 后端 / 并发写坏 config.yaml；`will-quit` 统一 dispose watcher / 终端 / 后端 / 预览。

## 七、测试

```sh
npm test                  # = test:services + test:contracts
npm run test:services     # 服务层回归
npm run test:contracts    # 契约与静态检查
```

| 脚本 | 覆盖 |
|---|---|
| `scripts/test-services.js` | 16 个服务模块可脱离 Electron 加载；CLI 路径与参数白名单；日志脱敏；profile 隔离（不写 `~/.hermes`、恒带 `-p`）；预览路径解析；DB 缺失降级；**用临时 sqlite fixture 真实执行 `sessionStats` / `loadHistory` SQL**（累计 token 列来自 `sessions` 表；旧版 messages 缺列时动态投影不报错，新版能带出 `failed_turn` 的 `error_surface`）；模型状态只读解析、只读诊断白名单；**运行时健壮性用注入的假后端 / 假 WS 真跑回合编排**（退避期不重复 spawn、换代后走 `session.resume`、掉线时在途与排队回合都收尾、会话建立前停止不误发 prompt、宽限期强制收尾、WS 超时关闭孤儿连接）；**附件分流用假网关实测**（图片/PDF/文件各走对应 RPC、提交顺序、相对路径与重复/超限丢弃、单个失败不吞回合）；**导出与工具集的参数白名单**（格式/会话 id/绝对路径/工具名在 spawn 前拒绝，工具列表分段解析只认 cli）；**MCP / cron 用真实 CLI 输出夹具验证解析**（MCP 表格与连接测试、cron 分块任务/状态/运行历史）与白名单（URL scheme、名称、调度表达式、任务 id、动作固定集合，非法参数在 spawn 前拒绝）；**模型候选列表共享规则**用 `vm` 提取 renderer 的 `modelRows()` 纯函数跑夹具（CLI 默认置顶去重、fallback / 内置两级回落、清单外失效模型仍可见）。**Kanban 客户端用临时 loopback HTTP server 真跑**（读写路径白名单 / 端口与 token 校验 / 8 / 9 列投影 / 对象包装拆解 / 六个写操作的方法·路径·header·body 白名单 / 默认 triage 与幂等键 / **派发 dry_run 缺省 true、显式 false 才真跑、max 封顶 4、POST 无 body、并发串行锁、PATCH body 恒 `{status:"ready"}`、派发结果与 worker 投影剔除路径与 PID** / **拖拽改派只带 `assignee`(+`ready`)、非法 profile 名与状态推进在发请求前拒绝** / **单卡派发先预演再真派：队首匹配才发第二次请求、不匹配时零写入并点名挡路的卡片、被跳过时给出具体原因** / 非法写参数在发请求前拒绝 / 400 detail 透出 / token 注入每个请求且不出现在返回值）。所有副作用落在 `os.tmpdir()` 一次性目录并自动清理，临时 server 监听 127.0.0.1 的随机端口且用完即关。 |
| `scripts/test-contracts.js` | IPC handler ↔ preload invoke ↔ renderer 调用三方对齐（无孤儿/死通道）；HTML id ↔ `app.js` 引用无死绑定且**全文 id 唯一**；全量 `node --check`；CSS 括号；双主题 token；CSP 未被放宽；**用量 UI 必须有复位分支、输入框细条必须已删**（防跨会话串数据 / 挤压定稿几何）；市场来源下拉 ↔ 服务白名单一致、安装默认 `--no-enable --no-deps`、详情/确认卡互斥、图标底色 AA；**失败轮次链路**（动态列投影、`failed_turn` 先于普通助手消息匹配、三个动作接线、双主题 token 与长文本换行）；**窄主区与模态契约**（宽度状态机三重兜底、关键控件降级覆盖、可收缩网格、降级层不碰定版几何、三个 dialog 语义、背景 inert 与焦点归还）；**运行时健壮性静态契约**（generation 订阅、换代清理、队列先排空再收尾、孤儿连接与过期连接、socket 代次守卫、停止语义）；**导出链路**（保存对话框定路径、`execFile` 无 shell）；**工具集**（只动 cli 平台、回读校验、失败回滚开关）；**查找条**（absolute 零布局、Custom Highlight 不改 DOM、Esc 不误中断）；**MCP**（execFile 无 shell、URL/名称白名单、TTY 默认输入、写后回读）；**定时任务**（`--paused` 安全默认、动作白名单、二次确认卡、异步面板代次守卫、表单 Esc 阻断冒泡）；**默认模型区块**（共享候选列表、面板代次守卫、唯一写入口 `setModel → cfg:set` 不改 CLI、下拉 Esc 阻断、样式只用 token 且窄面板回落）；**看板**（四层接线、token 不出主进程、读固定 GET + 六条写路径白名单、危险端点反向断言、默认 triage / 幂等键 / 不切 current 指针、loopback 加固、字段投影剔除工作区路径/认领锁/PID、**派发 dry_run 缺省 true / 上限 4 / 串行锁 / PATCH body 写死 / 真派发与提交派发二次确认 / 面板代次守卫 / Esc 层级**、写后回读、分组网格与双视图样式、`[hidden]` 兜底与双主题 token、**拖拽派发**：投放区 DOM 齐备、可拖状态白名单排除 running/done/archived、不禁用 HTML5 DnD 而是指针事件 + 吞收尾 click、落地只走改派通道、真派发仍过二次确认、拖动中不重建投放区 / 不停轮询、Esc 先取消拖动再关确认卡、幽灵卡 `pointer-events:none`、**幽灵落点与边缘滚动速度用 `vm` 跑纯函数做数值断言**（底边恒在指针上方、四角夹进视口、中间与区外速度为 0）、label 定宽槽位与状态行移出 dock 防漂移；**思考程度并入模型菜单**：独立 chip 已删、二级宿主存在、`openSub` 可达、`setEffort` 只写桌面端 reasoning、二级菜单左右翻边）；**输入区 dsh 改版**（圆形附件键带 aria-label、权限胶囊 aria-pressed、发送键两态、占位文案 HTML 与运行态两处一致、用量带轮次/步数与总量口径、上下文圆环周长与 CSS dasharray 同值、`[hidden]` 显式兜底、会话 id 封顶、底部信息行整行常显·图标悬停只提亮·估算值标 ≈·明确不做点赞倒赞、单条用量的历史/实时两个来源）；打包配置静态核对。 |

两个脚本都是零依赖、秒级，不触碰真实 `~/.hermes`、不启动 CLI、不安装第三方代码、不发起真实对话，失败时退出码非 0。

### CLI 兼容性（对照 hermes CLI v0.23.0 「The Hearth Release」实测）

v0.23.0 的架构改动是「**一台机器一个 gateway 拥有所有会话**」：CLI/TUI/Desktop/编辑器/消息 bot 不再各跑一份 agent，全部作为客户端接入同一服务。这对本项目的直接影响与处置：

| 上游变化 | 影响 | 处置 |
|---|---|---|
| `hermes -p X serve` 默认**附着**机器级服务并立刻退出（`already running on this host`），不打 `READY` 哨兵 | 后端永远起不来，按 15s 退避无限重试，看板/对话全挂 | 启动参数加 **`--isolated`**，拿专属进程 + 专属 token；契约测试锁定该参数 |
| `plugins show` 不再接受 `--json`（argparse 直接 usage 报错） | 插件详情走 JSON 解析会失败 | 先试 JSON、被拒退回纯文本原样透出（该入口目前未被 UI 调用） |
| 插件目录 600 → **1050** 条，新增 `verified` 层级与 `known_issues` / `needs_newer_hermes` 字段 | 厂商官方构建被误标「官方」；版本不够的条目装到一半才报错 | 三级信任标签（社区/已验证/官方）+ 卡片新增「需先升级 CLI」「已知问题 N」红标 |
| 内置技能 58 → 44（Office 合并为 `microsoft-office`）、catalog 插件化（`mcp serve`、Singularity 等移出核心） | 无 | 本项目只列已装条目，不硬编码名字；实测 66 技能 / 67 插件正常 |
| `browser_*` 工具合并为 `browser_exec` | 工具集面板若按旧工具名过滤会空 | 面板按 CLI 现输出的 toolset 名渲染，实测 13+ 项正常 |

逐项实测通过的通道：`serve` 握手与 token 鉴权（无 token 401 / 带 token 200）、流式对话（一条消息完整往返）、会话列表与历史、会话删除、会话统计、消息搜索、profile 双向切换（各自新端口 + 独立 token）、插件/技能/工具集/MCP/定时任务面板、市场搜索（1050 条插件 + 技能）、`config:check` 诊断、`plugins check-updates`、看板读（4 卡 / 8 profile chip / 统计条）、定时任务创建（恒 `--paused`）与移除、设置页 9 个分区渲染。

## 八、打包与部署

| 平台 | 目标 | 命令 |
|---|---|---|
| macOS (arm64/x64) | dmg | `npm run dist:mac` |
| Windows | NSIS | `npm run dist:win` |
| Linux | AppImage / deb | `npm run dist:linux` |

- `asar: true`；`node-pty` 通过 `asarUnpack` + `npmRebuild` 按 Electron ABI 重编译；`files` 白名单只含 `main/ preload/ renderer/ package.json`。
- 对宿主 hermes 是**运行时探测**，不捆绑 CLI；检测不到时降级为 Demo 模式并提示。
- macOS 正式分发需 Developer ID 证书（当前 `identity: null` 适配本地开发）；Windows 建议 EV 证书减少 SmartScreen 告警。
- 部署拓扑：用户机器 = hermes CLI（前置依赖） + Hermes Desktop Client.app（本应用）；后端 `hermes serve` 由应用自行托管在 loopback 随机端口，不对外暴露。

### 构建环境要求（macOS 实测）

`npm run dist:mac` 需要重编译 `node-pty` 并获取 Electron 发行包。遇到以下报错时按表处理：

| 现象 | 原因 | 处理 |
|---|---|---|
| `ModuleNotFoundError: No module named 'distutils'` | 默认 `python3` ≥ 3.12 已移除 distutils，而 node-gyp 9.x 仍 import 它 | `PYTHON=/usr/bin/python3 npm_config_python=/usr/bin/python3 npm run dist:mac`（macOS 自带 3.9），或升级 node-gyp / 安装 setuptools |
| `Get https://github.com/.../electron-v33…-darwin-x64.zip: EOF` | 构建机无法访问 GitHub Releases | 预置 `~/Library/Caches/electron` 缓存，或设 `ELECTRON_MIRROR`，或临时 `--config.electronDist=node_modules/electron/dist` |
| `broker denied delete` / `Invalid package default_app.asar` | 受限沙箱拦截了 node-gyp 清理与 asar 改写 | 在普通终端（非受限环境）执行打包；本项目沙箱内只做静态核对，不产出可分发包 |
| 只想快速验证产物结构 | dmg 较慢 | `npx electron-builder --dir --mac --x64`（只产 `release/mac/*.app`） |

`npm test` 会静态核对 `electron-builder.yml`（`asar` / `npmRebuild` / `asarUnpack` / `files` 白名单）与 `package.json` 入口、依赖、README 同步性，不需要联网或原生编译。

## 九、已知边界

- 市场真实 `install` / `uninstall` 已于 2026-11-08 在 `study` profile 用官方条目实跑（装后即卸，UI→IPC→CLI 全链路验证，第三方代码零残留）；CLI 自身留下的 `.install-metadata.json` / `.lock`、空 `skills/communication/`、hub 缓存与记账文件属于 CLI 产物，未擅自删除。用户已确认**无私有源需求**，`skills tap` 管理不做；CLI 的 tap 也只接受 GitHub `owner/repo`、没有 token 参数，私有仓库认证走本机 `GITHUB_TOKEN` / `gh auth login`。安装前校验只以目录 `capabilities` 声明与 `skills inspect` 只读预览为准——`plugins validate` 需要本地目录、`skills audit` / `plugins capabilities` 只在安装后可用，都不是安装前校验。
- 设置页的记忆分区只做只读诊断（`hermes memory status` 原样展示 + `MEMORY.md` / `USER.md` 元信息）。内置记忆文件的真实位置是 `<profile home>/memories/`，不是 home 根目录。外部 provider 的 `setup` / `off` / `reset` 是交互式写操作（`reset` 会清空记忆），桌面端一律不接，请在终端执行。诊断命令由 `hermes-diagnostics.js` 的白名单常量固定，渲染层只能传 key、不能传 argv，非法 key（含 `__proto__` 等原型链键）在 spawn 前拒绝。
- 快捷键自定义存独立的 `hermes.shortcuts`，读取时按动作白名单 + 组合格式 + 冲突去重清洗。必须带 ⌘ / Ctrl，避免劫持普通打字；`Escape`（浮层关闭 / 中断生成）与 `?`（帮助）为系统保留键，不开放自定义。改键立即生效并同步重绘帮助页与页脚键位；`⌘F` 聚焦会话搜索由本轮补齐（此前帮助页有文案但无实现）。
- 健康检查分区与记忆分区共用 `hermes-diagnostics.js`：命令是服务层冻结的白名单，串行队列 + 超时 + `SIGKILL` 兜底 + 输出上限 12k，stdin 关闭，杜绝交互式命令挂住队列。输出**原样展示**不做结构化解析——CLI 排版随版本变化，硬解析「✓」容易误报。特别注意 `hermes doctor` 实测约 27–41s 且常返回退出码 1（只表示「有待办建议」，例如缺 API key），因此它不进「快速检查」、超时给 60s，状态行标注「可能含建议」而不是判为失败；只有无输出 / 超时 / spawn 失败才标红。所有命令都不带 `--fix` / `--live`，不发真实网络探测。
- 运行时健壮性的边界：后端换代后的续接依赖 CLI 的 `session.resume` 与 `storedId`；若后端连 `state.db` 都换了 profile，历史会话本来就不在该 profile 内，UI 不会跨 profile 强行恢复。`_invalidateBackend()` 会给在途 / 排队回合补发错误， interrupted 轮次不自动重发，由用户决定重试。停止后的 10s 宽限期是主进程兜底，渲染层点「停止」时已立即本地复位。
- 附件链路：Electron 32 起移除了非标准的 `File.path`，桌面端经 preload 的 `webUtils.getPathForFile()` 取真实绝对路径（此前用 `file.path` 会退化成文件名，附件实际失效）。主进程只接受绝对路径、去重、上限 8 个，按扩展名分流到网关的 `image.attach` / `pdf.attach` / `file.attach`，且必须在 `prompt.submit` **之前**附加——后端在回合开始时消费并清空 `attached_images`。单个附件失败不阻塞回合：文字照发，渲染层收到一条 `notice` 提示，不生成错误卡。附件条为空时 `hidden` 不占布局，过多时纵向滚动，不撑高输入区。
- 会话导出：格式是服务层冻结的白名单（md / html / jsonl），会话 id 过正则白名单；落盘路径由**主进程的保存对话框**决定，渲染层只能传 `{sessionId, format, title}`，拿不到任意可写路径。CLI 的 md/qmd 只接受目录，因此一律先落到临时目录再拷到用户选定文件，不在 `~/.hermes` 下堆垃圾；导出默认保留 CLI 的密钥脱敏（不传 `--no-redact`），单文件上限 32MB、超时 60s。
- 工具集开关：`hermes tools list` 的文本按分段解析，只展示并只修改 **cli 平台**；接入 telegram / discord 后新增的同名分段一律不展示、不可点。开关后回读列表，状态未变会明确报错（例如 MCP server 未连接），不假装成功。工具名过正则白名单，非法名在 spawn 前拒绝。关闭 `terminal` / `file` 会让 agent 失去执行命令与改文件的能力。
- 会话内查找 ⌘F：仅在有内容的会话内生效，空态回落为聚焦侧栏搜索。高亮用 CSS Custom Highlight API（只建 Range、不插节点），因此流式重建不会掉高亮、也不会打断代码块横滚；不支持该 API 时降级为「只有计数、没有高亮」。聊天区变化时防抖重算命中；Esc 只关查找条，不会顺带中断正在生成的回合。
- 看板开放**五个受控写操作**：新建任务（默认 triage）、新建看板（不切 current）、删除任务、提交派发（→ready）、手动派发一次（dispatch tick），其中后三者与删除都需二次确认。派发是 `hermes kanban dispatch` 等价的一次 tick，会顺带做认领回收 / 依赖解锁 / 崩溃与超时处理，**不是桌面端自己实现的调度器**；桌面端没有常驻 daemon，也不改 `kanban.dispatch_*` 配置。拖列改状态、分解 / 规格化、估算、批量操作、终止 worker 仍不做——这些会大范围改写数据或触发 LLM 计费。CLI 的 kanban 是单主机设计（`kanban.db` 为本地 SQLite，崩溃检测依赖本机 PID），不支持跨主机共享看板。
- `skins` / `hooks` 等 CLI 能力尚未接入（`tools` / `mcp` / `cron` 已接入）。
- 列表缓存覆盖插件、技能、工具集、MCP 四处；**新机器第一次打开仍需等一次冷启**（2.5–8s，之后永久秒开，重启也一样）。定时任务（`hermes cron`）与市场搜索仍每次现拉——前者带运行历史、后者是用户主动搜索，缓存反而会给出过时结果。
- 思考轨的边界：`display.show_reasoning: false` 时上游**只发等待提示、不发推理**（`reasoning.delta` 被网关短路），此时能拿到的只有 `message.complete.reasoning`（本回合最后一段推理）——够显示一条有内容的折叠块，但看不到逐 token 的推理流。要流式思考得打开该开关（设置页「上游思考输出」→ 二次确认卡写 `hermes config set display.show_reasoning true`）：它是**全局 CLI 显示设置**，命令行同样受影响，且**只对新会话生效**（`show_reasoning` 在建会话时快照进 session）。历史会话不回放思考块：CLI 落库的 `messages.reasoning_content` 实测为空（长度 0–1），没有可还原的数据。
- 消息平台线已冻结：页面保留只读状态视图，不新增凭证表单与启停实测。
- 卡片多样本（长代码块、8 列宽表格、有序列表、引用、工具行、错误卡、图片与失效图回退）已做两主题渲染与对比度实测，长代码块补了「⇆ 可横向滚动」提示；具体视觉偏好仍可按截图微调。
