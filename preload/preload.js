'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hermesAPI', {
  env: () => ipcRenderer.invoke('hermes:env'),
  // Electron 32+ 已移除 File.path，拖拽 / 文件选择只能走 webUtils 取真实绝对路径
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  send: (payload) => ipcRenderer.invoke('hermes:send', payload),
  abort: (tabId) => ipcRenderer.invoke('hermes:abort', tabId),
  tabState: (tabId) => ipcRenderer.invoke('hermes:tabState', tabId),

  listSessions: (args) => ipcRenderer.invoke('sessions:list', args),
  loadHistory: (args) => ipcRenderer.invoke('sessions:history', args),
  sessionStats: (sessionId) => ipcRenderer.invoke('sessions:stats', sessionId),
  searchMessages: (q) => ipcRenderer.invoke('sessions:search', q),
  storageStats: () => ipcRenderer.invoke('sessions:storage'),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
  pinSession: (id, pinned) => ipcRenderer.invoke('sessions:pin', id, pinned),
  sessionUsage: (id) => ipcRenderer.invoke('sessions:usage', id),
  exportSession: (args) => ipcRenderer.invoke('sessions:export', args),
  revealPath: (p) => ipcRenderer.invoke('app:reveal', p),

  termCreate: (args) => ipcRenderer.invoke('term:create', args),
  termWrite: (args) => ipcRenderer.invoke('term:write', args),
  termResize: (args) => ipcRenderer.invoke('term:resize', args),
  termKill: (args) => ipcRenderer.invoke('term:kill', args),

  gwStatus: () => ipcRenderer.invoke('gw:status'),
  gwOverview: () => ipcRenderer.invoke('gw:overview'),
  gwAction: (op) => ipcRenderer.invoke('gw:action', op),
  gwCliStatus: () => ipcRenderer.invoke('gw:cli-status'),
  gwOpenFile: (kind) => ipcRenderer.invoke('gw:open-file', kind),
  setConfig: (patch) => ipcRenderer.invoke('cfg:set', patch),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getPath: (name) => ipcRenderer.invoke('app:path', name),
  // 视口与窗口 frame 漂移检测：唤醒后内容区可能停在旧尺寸（右侧白块）
  reportViewport: (size) => ipcRenderer.send('window:viewport', size),

  // 插件 / 技能 / 配置（真实 hermes CLI 集成）
  pluginsList: (opts) => ipcRenderer.invoke('plugins:list', opts || {}),
  pluginsSetEnabled: (name, enabled) => ipcRenderer.invoke('plugins:set-enabled', name, enabled),
  skillsList: (opts) => ipcRenderer.invoke('skills:list', opts || {}),
  skillsSetEnabled: (name, enabled) => ipcRenderer.invoke('skills:set-enabled', name, enabled),
  configProviders: () => ipcRenderer.invoke('hermes-config:providers'),
  configModels: () => ipcRenderer.invoke('hermes-config:models'),
  configModelState: () => ipcRenderer.invoke('hermes-config:model-state'),
  diagnosticsRun: (key) => ipcRenderer.invoke('diagnostics:run', key),
  toolsList: (opts) => ipcRenderer.invoke('tools:list', opts || {}),
  toolsToggle: (name, enabled) => ipcRenderer.invoke('tools:toggle', name, enabled),
  // MCP 服务器与定时任务：渲染层只传结构化字段，argv 由主进程服务层拼装
  mcpList: (opts) => ipcRenderer.invoke('mcp:list', opts || {}),
  mcpTest: (name) => ipcRenderer.invoke('mcp:test', name),
  mcpAdd: (args) => ipcRenderer.invoke('mcp:add', args || {}),
  mcpRemove: (name) => ipcRenderer.invoke('mcp:remove', name),
  cronOverview: () => ipcRenderer.invoke('cron:overview'),
  cronRuns: (jobId, limit) => ipcRenderer.invoke('cron:runs', jobId, limit),
  cronAction: (op, jobId) => ipcRenderer.invoke('cron:action', op, jobId),
  cronCreate: (args) => ipcRenderer.invoke('cron:create', args || {}),
  // Kanban 看板：token / 端口全在主进程，渲染层只传筛选条件与任务 id
  kanbanBoard: (opts) => ipcRenderer.invoke('kanban:board', opts || {}),
  kanbanTask: (taskId, opts) => ipcRenderer.invoke('kanban:task', taskId, opts || {}),
  kanbanOverview: (opts) => ipcRenderer.invoke('kanban:overview', opts || {}),
  kanbanRun: (runId, opts) => ipcRenderer.invoke('kanban:run', runId, opts || {}),
  kanbanCreateTask: (input) => ipcRenderer.invoke('kanban:create-task', input || {}),
  kanbanCreateBoard: (input) => ipcRenderer.invoke('kanban:create-board', input || {}),
  // 项目：列表随 kanbanOverview 下发；绑定 / 解绑走 PATCH /boards/{slug}（body 只放行 project_id）
  kanbanBindBoard: (input) => ipcRenderer.invoke('kanban:bind-board', input || {}),
  // 建项目走 CLI 子命令（无 REST 端点），用户点击触发
  kanbanCreateProject: (input) => ipcRenderer.invoke('kanban:create-project', input || {}),
  kanbanDeleteTask: (taskId, opts) => ipcRenderer.invoke('kanban:delete-task', taskId, opts || {}),
  kanbanSubmitTask: (taskId, opts) => ipcRenderer.invoke('kanban:submit-task', taskId, opts || {}),
  kanbanReassign: (taskId, opts) => ipcRenderer.invoke('kanban:reassign', taskId, opts || {}),
  kanbanDispatchTask: (taskId, opts) => ipcRenderer.invoke('kanban:dispatch-task', taskId, opts || {}),
  kanbanDispatch: (opts) => ipcRenderer.invoke('kanban:dispatch', opts || {}),
  kanbanActiveWorkers: (opts) => ipcRenderer.invoke('kanban:workers', opts || {}),
  // 侧栏项目树：会话按项目归组（同一 serve 的 /api/profiles/projects/tree，只读投影）
  projectsTree: (opts) => ipcRenderer.invoke('projects:tree', opts || {}),
  // 官方新建项目 / 打开文件夹为项目：原生目录选择器 + 既有项目维护（主进程拼 argv）
  pickProjectFolders: (opts) => ipcRenderer.invoke('project:pick-folders', opts || {}),
  projectAction: (input) => ipcRenderer.invoke('project:action', input || {}),
  // 删除项目：官方 projects.delete RPC（只删项目记录，不动磁盘文件），必须二次确认
  deleteProject: (id) => ipcRenderer.invoke('project:delete', String(id || '')),
  copyText: (text) => ipcRenderer.invoke('app:copy', String(text || '')),
  // 编排模式：读回生效值；set 改 CLI config.yaml 的 kanban 段（UI 必须二次确认）
  kanbanOrchestration: () => ipcRenderer.invoke('kanban:orchestration'),
  kanbanSetMode: (mode) => ipcRenderer.invoke('kanban:set-mode', String(mode || '')),
  diagnosticsMemoryFiles: () => ipcRenderer.invoke('diagnostics:memory-files'),
  configOpenFile: (key) => ipcRenderer.invoke('hermes-config:open-file', key),
  reasoningDisplay: () => ipcRenderer.invoke('hermes-config:reasoning-display'),
  setReasoningDisplay: (on) => ipcRenderer.invoke('hermes-config:set-reasoning-display', on === true),

  // 右侧栏 HTML 预览
  previewResolve: (input, baseDir) => ipcRenderer.invoke('preview:resolve', input, baseDir),
  previewPick: () => ipcRenderer.invoke('preview:pick'),
  previewWatch: (filePath) => ipcRenderer.invoke('preview:watch', filePath),
  previewUnwatch: () => ipcRenderer.invoke('preview:unwatch'),
  previewOpenExternal: (target) => ipcRenderer.invoke('preview:open-external', target),

  // Profile（桌面端内切换，不写 ~/.hermes）
  profileList: () => ipcRenderer.invoke('profile:list'),
  profileSwitch: (name) => ipcRenderer.invoke('profile:switch', name),

  // 插件 / 技能市场（CLI 原生 registries）
  marketSearch: (kind, query, opts) => ipcRenderer.invoke('market:search', kind, query, opts || {}),
  marketAction: (kind, op, identifier, opts) => ipcRenderer.invoke('market:action', kind, op, identifier, opts || {}),
  marketCheckUpdates: (kind) => ipcRenderer.invoke('market:check-updates', kind),

  // 危险操作审批：主进程把后端请求转给渲染层，用户确认后回传
  approvalRespond: (payload) => ipcRenderer.invoke('hermes:approval-respond', payload),
  onApproval: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('hermes:approval', h); return () => ipcRenderer.removeListener('hermes:approval', h); },

  // 小球模式：把窗口收成桌面上的小圆球（主窗口只 hide，不改几何）
  enterOrb: () => ipcRenderer.invoke('orb:enter'),
  // 迷你聊天窗要跟着「当前会话」走：渲染层把 tabId / 标题 / 最近消息 / 主题推给主进程，
  // 主进程只缓存不解析（不落盘、不进日志）。
  orbContext: (ctx) => ipcRenderer.send('orb:context', ctx),
  onOrbUserMessage: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('orb:user-message', h); return () => ipcRenderer.removeListener('orb:user-message', h); },
  // 球的 Profile / 最近会话下拉：主进程只发结构化意图，不传路径 / token
  onOrbOpenSession: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('orb:open-session', h); return () => ipcRenderer.removeListener('orb:open-session', h); },
  onOrbApprovalResolved: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('orb:approval-resolved', h); return () => ipcRenderer.removeListener('orb:approval-resolved', h); },

  onEvent: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('hermes:event', h); return () => ipcRenderer.removeListener('hermes:event', h); },
  onError: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('hermes:error', h); return () => ipcRenderer.removeListener('hermes:error', h); },
  onClose: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('hermes:close', h); return () => ipcRenderer.removeListener('hermes:close', h); },
  onTermData: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('term:data', h); return () => ipcRenderer.removeListener('term:data', h); },
  onTermExit: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('term:exit', h); return () => ipcRenderer.removeListener('term:exit', h); },
  onPreviewChanged: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('preview:changed', h); return () => ipcRenderer.removeListener('preview:changed', h); },
  onMarketProgress: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('market:progress', h); return () => ipcRenderer.removeListener('market:progress', h); },
  // 插件/技能列表后台刷新完成（p = { kind:'plugins'|'skills', at, count }）
  onCatalogUpdated: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('catalog:updated', h); return () => ipcRenderer.removeListener('catalog:updated', h); },
});
