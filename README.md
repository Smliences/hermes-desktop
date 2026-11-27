# Hermes Desktop Client

连接本机 **hermes CLI**（Nous Research Hermes Agent）的 Electron 桌面客户端。  
采用**暖纸色系 + 极简墨黑 / 石墨灰**双主题设计，提供常驻后端流式对话、工具调用可视化、会话与项目管理、多 Profile 切换、插件/技能市场、右侧「预览 / 看板」双页签，以及桌面悬浮球与迷你聊天小窗。

---

## 快速开始

```sh
npm install
npm start              # 启动桌面端（加载即预热 hermes serve 后端）
npm test               # 运行服务层单测 + 契约检查 + 打包自检
npm run test:ui        # 无头 Chrome UI 交互冒烟测试
npm run pack:check     # 静态打包检查
npm run dist:mac       # 打包 macOS dmg（另有 dist:win / dist:linux）
```

> **前置依赖**：本机需已安装 `hermes` CLI（按 `~/.local/bin/hermes` → `/usr/local/bin` → `/opt/homebrew/bin` → `~/bin` → `PATH` 探测，安装包不捆绑 CLI）。若未检测到 CLI，会自动进入 `mock-bridge.js` Demo 模式用于 UI 预览。

---

## 总体架构

```
Renderer (renderer/, vanilla JS)     ── 聊天流 / 侧栏 / 预览与看板 / 市场 / 设置 / 迷你小窗
        ▲
        │ contextBridge 白名单 (preload/preload.js · orb-preload.js · orb-chat-preload.js)
        ▼
Main (main/main.js + main/services/) ── 纯 Node 服务层（不依赖 electron，可独立单测）
        ▲
        ├── WS /api/ws       ──▶ hermes -p <profile> serve --isolated（主通道，JSON-RPC）
        ├── SQLite (只读/受控) ──▶ ~/.hermes[/profiles/<name>]/state.db
        └── CLI 子进程 / REST  ──▶ 插件 · 技能 · 市场 · MCP · 定时任务 · 看板
```

---

## 核心功能

### 1. 对话、模型与运行时健壮性
- **常驻后端主通道**：通过 `hermes serve --isolated` 启动专属后端并经 WebSocket JSON-RPC 通信，支持流式输出、真推理块（`reasoning.delta`）、工具调用分组、图片/PDF/文件附件、危险操作审批卡、会话内查找（`⌘F`）与导出（Markdown / HTML / JSONL）。
- **运行时健壮性**：后端换代（`generation`）或断线时自动关闭旧 WS 连接、作废旧 `liveId` 并保留 `storedId` 供下轮 `session.resume` 续接；支持**渲染层跨页签隔离**、停止生成 10s 宽限期收尾、以及 `failed_turn` 结构化错误卡片。
- **模型与思考程度**：读取当前 profile 的 `config.yaml` 与 `models.json`（CLI 默认模型置顶去重），支持模型漂移非阻断提示；思考程度（`none`…`ultra`）收进模型选择器二级菜单，仅写入桌面端 `userData/config.json`，不修改 CLI 配置。

### 2. 会话、项目与多 Profile
- **会话与项目**：基于 `state.db` 与 `FTS5` 提供全文搜索、置顶、重命名、删除及空间统计；支持项目弹窗（新建 / 重命名 / 文件夹管理 / 删除）与侧栏折叠分组，未绑定项目会话按时间归档。
- **多 Profile 隔离**：`hermes-profile.js` 作为路径唯一真源，切换仅写入 `userData/active-profile.json`（不改写 `~/.hermes`），切换时自动重启后端、刷新列表并清理缓存。

### 3. 右侧「预览 / 看板」双页签
- **预览页签**：按文件类型自动分流 Markdown、网页、PDF、图片、表格五种视图，支持源码切换与本地文件热监听（`fs.watch`）；写作类工具产出文件时自动跟随预览。
- **看板页签**：右侧为复用 `KB.board` 的紧凑速览，点击卡片可进入完整看板整页（分组网格 / 经典列视图、拖拽改状态与指派 worker、详情抽屉、派发控制台与 AI 拆解/补规格/估算）。
- **宽度可调**：通过 `renderer/rail-resize.js` 拖拽左缘手柄或键盘微调（范围 `280–760px`，默认 `400px`，并保证主区至少留白 `420px`），写入 CSS 变量 `--rail-w`。

### 4. 桌面悬浮球与迷你聊天窗
- **悬浮球（`main/orb.js`）**：`84×84` 透明无边框窗口（`roundedCorners: false`，四周留 `16px` 缓冲防止投影与呼吸光晕被裁切），单视觉信号表达状态（就绪绿色呼吸环 / 忙碌旋转弧 / 待审批徽标 / 离线红点）；拖动采用基于屏幕坐标的**增量式**计算并即时落盘。
- **迷你聊天窗（`main/orb-chat.js`）**：点球或按全局快捷键 `⌥⇧H`（`Alt+Shift+H`）唤起，与主窗口共用同一个会话 tab。采用豆包风格极简顶栏与悬浮圆角输入卡：顶部居中胶囊支持按项目折叠切换历史会话、「+ 新建」原地开新会话及切换 Profile；底部支持直接切换模型；内置最近会话与 Profile 下拉入口。
- **两种模式**：可在球右键菜单切换「常驻小圆球」或「仅快捷键唤起」，偏好保存在 `userData/orb-prefs.json`。

### 5. 插件、技能、市场与诊断
- **秒开缓存**：插件、技能、工具集、MCP 列表采用按 profile 隔离的「磁盘缓存 + 后台同步（stale-while-revalidate）」策略，避免每次页面切换等待 Python 冷启。
- **安全安装与只读诊断**：插件/技能市场默认 `--no-enable --no-deps`，安装前展示权限声明与预览；设置页提供只读记忆诊断、健康检查（`status` / `config check` / `doctor` 等）、自定义快捷键与 MCP / 定时任务管理。

---

## 设计与安全边界

- **视觉规范**：全应用统一自绘下拉组件（`hm-select`）与双主题 CSS token；主区 `≤ 600px` 自动进入 `.compact` 降级布局；模态框打开时背景整块 `inert` 隔离。
- **沙箱隔离**：所有窗口均启用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 与严格 CSP；悬浮球与迷你小窗使用独立封闭 `preload`（`orb:` / `orbchat:`），不暴露 CLI、看板或文件系统权限；日志自动脱敏落盘至 `userData/logs/app.log`。

---

## 测试与打包

| 命令 | 说明 |
|---|---|
| `npm run test:services` | 纯 Node 服务层回归测试（SQLite fixture、假网关、看板 REST、CLI 解析与白名单） |
| `npm run test:contracts` | IPC / DOM / CSS / 安全边界 / 状态机静态契约检查 |
| `npm run test:ui` | 无头 Chrome CDP 交互冒烟测试（命中 `mock-bridge.js`，无 Chrome 时自动跳过） |
| `npm run pack:check` | 打包静态自检（图标、入口、依赖、`asar` 配置与资源引用） |
| `npm run dist:mac` | 通过 `scripts/dist.js` 清理环境变量并校验架构后构建 dmg（`npmRebuild: false`） |
