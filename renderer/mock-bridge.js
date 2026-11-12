'use strict';
/* mock-bridge.js — 浏览器 Demo 模式：无 Electron 环境时模拟 hermesAPI，
 * 回放一段脚本化 stream-json 事件，用于 UI 预览与演示。 */
(function () {
  if (typeof window.hermesAPI !== 'undefined') return; // Electron 真机环境，不注入
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const DEMO_SESSIONS = [
    { id: '20261104_121117_0c63b7', title: '体检 hermes 环境', model: 'deepseek-v4.1-flash', message_count: 2, input_tokens: 24341, output_tokens: 130, started_at: Math.floor(Date.now() / 1000) - 600 },
    { id: '20261104_105611_ac8c50', title: '重构 sheet 解析模块', model: 'claude-sonnet-4', message_count: 59, input_tokens: 180220, output_tokens: 9800, started_at: Math.floor(Date.now() / 1000) - 7200 },
    { id: '20261104_100439_4de2ce', title: '排查 gateway 启动失败', model: 'deepseek-v4.1-flash', message_count: 226, input_tokens: 890100, output_tokens: 45000, started_at: Math.floor(Date.now() / 1000) - 14400 },
    { id: '20261103_231714_595bc4', title: '写 cron 报表任务', message_count: 118, started_at: Math.floor(Date.now() / 1000) - 86400 },
    // 更早的会话：用来验证「其他会话」分组与折叠（项目分组会认领前两条演示会话）
    { id: '20261031_090000_pin001', title: '整理 skills 目录约定', message_count: 12, pinned: 1, started_at: Math.floor(Date.now() / 1000) - 3 * 86400 },
    { id: '20260920_140000_old002', title: '早期 CLI 参数调研', message_count: 44, started_at: Math.floor(Date.now() / 1000) - 40 * 86400 },
  ];
  const DEMO_HISTORY = {
    '20261104_121117_0c63b7': [
      { role: 'user', content: '运行 hermes doctor 体检并总结结果' },
      { role: 'assistant', content: '体检完成，摘要如下：\n\n- **Provider**：OpenCode Zen（deepseek-v4.1-flash）✓\n- **Gateway**：已停止（空闲自动退出，属正常行为）\n- **Skills**：37 个已启用\n- **Memory**：memory_store.db 正常\n\n结论：配置健康，无需处理。' },
    ],
  };

  const listener = { event: null, close: null };

  window.__mockAPI = {
    async env() {
      return { hermesBin: '/demo/hermes', hermesFound: false, version: 'demo', dbOk: true, dbPath: '~/.hermes/state.db', pty: false, config: { model: '', reasoning: 'default', yolo: false } };
    },
    async listSessions({ limit = 50 } = {}) { return DEMO_SESSIONS.slice(0, limit); },
    async loadHistory({ sessionId }) { return DEMO_HISTORY[sessionId] || []; },
    async sessionStats() { return { input_tokens: 24341, output_tokens: 130, message_count: 2, last_ts: Math.floor(Date.now() / 1000) }; },
    async gwStatus() { return { ok: false, output: 'stopped' }; },
    async setConfig(patch) { return patch; },
    async getPath(name) { return name === 'home' ? '/Users/demo' : '/'; },
    async tabState() { return null; },
    async enterOrb() { return { ok: false, error: 'Demo 模式没有小球窗口' }; },
    // Demo 模式没有迷你聊天窗：上下文照收不误（不存在的桥不接事件即可）
    orbContext() {},
    onOrbUserMessage() { return () => {}; },
    onOrbApprovalResolved() { return () => {}; },
    async abort() {},
    async termCreate() { return { ok: true, pty: false }; },
    async termWrite() {}, async termResize() {}, async termKill() {},
    onEvent(fn) { listener.event = fn; return () => {}; },
    onError(fn) { listener.close = fn; return () => {}; },
    onClose(fn) { listener.close = fn; return () => {}; },
    onTermData() { return () => {}; }, onTermExit() { return () => {}; },

    /** Demo 发送：回放脚本化事件流 */
    async __sendDemo(payload, onEvent, onClose) {
      const turnId = 'turn_demo_' + Math.random().toString(36).slice(2, 6);
      const sessionId = '20261104_demo_' + Math.random().toString(36).slice(2, 6);
      const emit = (evt, delay) => sleep(delay).then(() => onEvent({ ...evt, turnId }));
      await emit({ type: 'system', subtype: 'init', model: 'deepseek-v4.1-flash', session_id: sessionId }, 300);
      await emit({ type: 'text', text: '好的，我来查一下。' }, 350);
      await emit({ type: 'tool_use', name: 'bash', tool_call_id: 't1', input: { command: 'hermes status --full' } }, 400);
      await emit({ type: 'tool_result', name: 'bash', tool_call_id: 't1', output: 'Model: deepseek-v4.1-flash\nProvider: OpenCode Zen\nGateway: stopped\nJobs: 0', duration_ms: 1240, is_error: false }, 1500);
      await emit({ type: 'text', text: '\n\n**当前状态**：\n\n- 模型：`deepseek-v4.1-flash`（OpenCode Zen）\n- Gateway：已停止（空闲自动退出）\n- 定时任务：0 个\n\n一切正常 ✅' }, 500);
      await emit({ type: 'result', session_id: sessionId, exit_code: 0, text: '好的，我来查一下。\n\n**当前状态**：\n\n- 模型：`deepseek-v4.1-flash`（OpenCode Zen）\n- Gateway：已停止（空闲自动退出）\n- 定时任务：0 个\n\n一切正常 ✅', tokens: { input: 24341, output: 96, total: 24437, cache_read: 18220, cache_write: 512 }, duration_ms: 4900 }, 400);
      onClose && onClose({ tabId: payload.tabId, sessionId, model: 'deepseek-v4.1-flash', exitCode: 0, aborted: false, stderr: '' });
    },

    /* ══════════ Kanban 看板 Demo（内存态，刷新即重置） ══════════
       字段形状与 main/services/hermes-kanban.js 的投影保持一致。 */
    async kanbanOverview() {
      return {
        ok: true, generation: 1, partial: false,
        boards: [
          { slug: 'main', name: '主看板', total: KB_TASKS.length },
          { slug: 'ops-2026', name: '运维 2026', total: 0 },
        ],
        currentBoard: 'main',
        assignees: ['default', 'writer', 'ops'],
        profiles: ['default', 'writer'],
        projects: [
          { id: 'pj_demo1', slug: 'hermes-agent', name: 'Hermes Agent', primaryPath: '/tmp/demo-repo', icon: '', color: '' },
        ],
        stats: { by_status: {}, by_assignee: {}, oldest_ready_age: null },
        config: null, diagnostics: [],
      };
    },
    async kanbanBoard(opts = {}) {
      const all = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'];
      const cols = opts.includeArchived ? all.concat('archived') : all;
      return {
        ok: true, generation: 1,
        columns: cols.map((name) => ({ name, tasks: KB_TASKS.filter((t) => t.status === name) })),
        tenants: ['web', 'cli'],
        assignees: ['default', 'writer', 'ops'],
        latestEventId: KB_EVT, now: Math.floor(Date.now() / 1000),
      };
    },
    async kanbanTask(taskId) {
      const t = KB_TASKS.find((x) => x.id === taskId);
      if (!t) return { ok: false, error: '任务不存在（Demo）' };
      return {
        ok: true,
        task: { ...t, body: t.body || '' },
        comments: KB_COMMENTS.filter((c) => c.task_id === taskId),
        events: KB_EVENTS.filter((e) => e.task_id === taskId),
        attachments: [], links: { parents: [], children: [] },
        runs: t.status === 'running' ? [{ id: 1, status: 'running', outcome: '', error: '', started_at: t.started_at }] : [],
      };
    },
    async kanbanCreateTask(input = {}) {
      const title = String(input.title || '').trim();
      if (!title) return { ok: false, error: '请填写任务标题' };
      const t = {
        id: 't_demo' + String(++KB_SEQ).padStart(2, '0'),
        title, body: String(input.body || ''), status: input.status === 'ready' ? 'ready' : 'triage',
        priority: Number(input.priority) || 0, assignee: String(input.assignee || ''),
        tenant: String(input.tenant || ''), created_at: Math.floor(Date.now() / 1000),
        started_at: 0, completed_at: 0, latest_summary: '', result: '',
        comment_count: 0, progress: null, warnings: { count: 0 }, session_id: '',
      };
      KB_TASKS.push(t); KB_EVT += 1;
      return { ok: true, generation: 1, task: t, warning: '' };
    },
    async kanbanCreateBoard(input = {}) {
      const slug = String(input.slug || '').trim();
      if (!slug) return { ok: false, error: '请填写看板标识' };
      return { ok: true, generation: 1, slug, warning: '' };
    },
    async kanbanBindBoard(input = {}) {
      return { ok: true, generation: 1, board: { slug: String(input.slug || ''), project_id: String(input.projectId || '') }, current: '' };
    },
    async kanbanCreateProject(input = {}) {
      const name = String((input && input.name) || '').trim();
      if (!name) return { ok: false, error: '请填写项目名称' };
      return { ok: true, text: `[mock] created project ${name}`, ideaWarning: '' };
    },
    // Demo 没有原生目录选择器：给一条示例绝对路径，保证弹窗流程可完整走通
    async pickProjectFolders(input = {}) {
      return { ok: true, folders: [String(input.multiple === false ? '/Users/you/Work/demo' : '/Users/you/Work/demo')] };
    },
    // Demo 里也在内存建目录（真机上由主进程非递归 mkdir），只在校验通过时返回拼接路径
    async projectMkdir(input = {}) {
      const parent = String(input.parent || '').replace(/\/+$/, '');
      const name = String(input.name || '').trim();
      if (!parent.startsWith('/')) return { ok: false, error: '父目录需为绝对路径' };
      if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) return { ok: false, error: '名称无效' };
      DEMO_MKDIR.add(parent + '/' + name);
      return { ok: true, path: parent + '/' + name };
    },
    async projectAction(input = {}) {
      return { ok: true, text: `[mock] project ${String(input.op || '')}` };
    },
    // 设置弹窗：返回与 projects.get 同形状的项目（含描述与全部文件夹）
    async projectGet(id) {
      const pid = String(id || '');
      if (!pid || DELETED_PROJECTS.has(pid)) return { ok: false, error: '项目不存在（Demo）' };
      return { ok: true, project: demoProject(pid) };
    },
    async projectUpdate(input = {}) {
      const pid = String(input.id || '');
      if (!pid) return { ok: false, error: '项目标识无效' };
      const p = demoProject(pid);
      if (typeof input.name === 'string' && input.name.trim()) p.name = input.name.trim();
      if (typeof input.description === 'string') p.description = input.description;
      DEMO_PROJECT_OVERRIDE.set(pid, p);
      return { ok: true, project: p };
    },
    async projectFolder(input = {}) {
      const pid = String(input.id || '');
      const path0 = String(input.path || '');
      if (!pid || !path0.startsWith('/')) return { ok: false, error: '参数无效' };
      const p = demoProject(pid);
      if (input.op === 'add' && !p.folders.some((f) => f.path === path0)) {
        p.folders.push({ path: path0, label: '', isPrimary: false });
      } else if (input.op === 'remove') {
        p.folders = p.folders.filter((f) => f.path !== path0);
      } else if (input.op === 'primary') {
        p.folders = p.folders.map((f) => ({ ...f, isPrimary: f.path === path0 }));
        p.primaryPath = path0;
      }
      DEMO_PROJECT_OVERRIDE.set(pid, p);
      return { ok: true, project: p };
    },
    // Demo 里真的把项目从内存树里摘掉，方便验证「删完侧栏即时消失」
    async deleteProject(input) {
      const o = typeof input === 'string' ? { id: input } : (input || {});
      const pid = String(o.id || '');
      if (!pid) return { ok: false, error: '项目标识无效' };
      if (o.trash === true && !Array.isArray(o.folders)) return { ok: false, error: '缺少文件夹列表' };
      DELETED_PROJECTS.add(pid);
      return { ok: true, activeId: '', trashed: o.trash === true ? (o.folders || []) : [] };
    },
    // Demo：移到内存覆盖表，projectsTree 随后按它重算 sessionIds（等价于后端换 cwd 后的树）
    async moveSession(sessionId, cwd) {
      const sid = String(sessionId || '');
      const dir = String(cwd || '');
      if (!sid) return { ok: false, error: '会话 ID 不合法' };
      const hit = [...DEMO_PROJECTS.entries()].find(([, m]) => m.path === dir);
      if (!hit) return { ok: false, error: '目标文件夹不存在（可能已被移动或删除）' };
      DEMO_MOVED_SESSIONS.set(sid, hit[0]);
      return { ok: true, cwd: dir, branch: '', gitRepoRoot: '' };
    },
    // Demo：连接状态恒为「已连接」；其它状态用 renderConnStatus 直接驱动即可验证样式
    async backendStatus() { return { state: 'ready', port: 0, epoch: 1, connected: true }; },
    async reconnectBackend() { return { ok: true }; },
    onBackendStatus() { return () => {}; },
    async copyText() { return true; },
    async kanbanDeleteTask(taskId) {
      const i = KB_TASKS.findIndex((x) => x.id === taskId);
      if (i >= 0) KB_TASKS.splice(i, 1);
      KB_EVT += 1;
      return { ok: true, generation: 1 };
    },
    async kanbanSubmitTask(taskId) {
      const t = KB_TASKS.find((x) => x.id === taskId);
      if (!t) return { ok: false, error: '任务不存在（Demo）' };
      t.status = 'ready'; KB_EVT += 1;
      return { ok: true, generation: 1, task: t };
    },
    async kanbanReassign(taskId, opts = {}) {
      const t = KB_TASKS.find((x) => x.id === taskId);
      if (!t) return { ok: false, error: '任务不存在（Demo）' };
      t.assignee = String(opts.assignee || '');
      if (opts.status === 'ready' && !['running', 'done', 'archived'].includes(t.status)) t.status = 'ready';
      KB_EVT += 1;
      return { ok: true, generation: 1, assignee: t.assignee, task: t };
    },
    async kanbanDispatch(opts = {}) {
      const dry = opts.dryRun !== false;
      const ready = KB_TASKS.filter((t) => t.status === 'ready' && t.assignee);
      const spawned = dry ? [] : ready.slice(0, Math.max(1, Number(opts.max) || 1))
        .map((t) => ({ taskId: t.id, assignee: t.assignee }));
      if (!dry) spawned.forEach((s) => { const t = KB_TASKS.find((x) => x.id === s.taskId); if (t) { t.status = 'running'; t.started_at = Math.floor(Date.now() / 1000); } });
      KB_EVT += 1;
      return {
        ok: true, dryRun: dry, spawned,
        lists: { skipped_unassigned: KB_TASKS.filter((t) => t.status === 'ready' && !t.assignee).map((t) => t.id) },
        counts: {}, skippedPerProfile: [], respawnGuarded: [],
      };
    },
    async kanbanDispatchTask(taskId) {
      const t = KB_TASKS.find((x) => x.id === taskId);
      if (!t || !t.assignee) return { ok: false, error: '任务未指派受让人' };
      t.status = 'running'; t.started_at = Math.floor(Date.now() / 1000); KB_EVT += 1;
      return { ok: true, dispatched: true, reason: '' };
    },
    async kanbanActiveWorkers() {
      const ws = KB_TASKS.filter((t) => t.status === 'running').map((t, i) => ({
        run_id: i + 1, task_id: t.id, task_title: t.title, task_status: 'running',
        task_assignee: t.assignee, profile: t.assignee, started_at: t.started_at,
      }));
      return { ok: true, workers: ws, count: ws.length, checkedAt: Math.floor(Date.now() / 1000) };
    },
    /* 侧栏项目树 Demo：一个显式项目 + 未归类桶，形状对齐 hermes-kanban.js 的投影 */
    async projectsTree() {
      const now = Math.floor(Date.now() / 1000);
      const ids = ['s_demo_0', 's_demo_1', 's_demo_2', 's_demo_3'];
      // 归属：移动过的以覆盖表为准，否则用默认分配（模拟后端按 cwd 推导的树）
      const ownerOf = (sid) => DEMO_MOVED_SESSIONS.get(sid) || (sid === 's_demo_2' ? HOME_PROJECT_ID
        : (sid === 's_demo_3' ? 'pj_demo2' : 'pj_demo1'));
      // 演示会话用 KB_TASKS 编标题；真实会话（移动过来或被认领的）按本地列表还原
      const mkRow = (sid, i) => {
        const real = DEMO_SESSIONS.find((x) => x.id === sid);
        return real
          ? { id: real.id, title: real.title, preview: '', started_at: real.started_at, last_active: real.started_at }
          : { id: sid, title: KB_TASKS[i % KB_TASKS.length].title, preview: '演示会话 ' + i,
            started_at: now - i * 3600, last_active: now - i * 3600 };
      };
      const rowsFor = (pid) => {
        const base = ids.map((sid, i) => ({ sid, i })).filter((x) => ownerOf(x.sid) === pid);
        const seen = new Set(base.map((x) => x.sid));
        // 移动表里指向本项目的真实会话也要出现在 sessionIds 里，侧栏才看得见归属变化
        const moved = [...DEMO_MOVED_SESSIONS.entries()].filter(([, to]) => to === pid)
          .map(([sid], k) => ({ sid, i: k })).filter((x) => !seen.has(x.sid));
        return [...base, ...moved];
      };
      const nodeOf = (meta) => {
        const rows = rowsFor(meta.id);
        // 设置弹窗改过的名字要立刻反映到侧栏树
        const ov = DEMO_PROJECT_OVERRIDE.get(meta.id);
        return { ...meta, label: (ov && ov.name) || meta.label,
          sessionCount: rows.length, sessionIds: rows.map((x) => x.sid),
          previewSessions: rows.slice(0, 3).map((x) => mkRow(x.sid, x.i)) };
      };
      const tree = [
        nodeOf({ id: 'pj_demo1', label: 'Hermes Agent', path: '/tmp/demo-repo', color: '#c2703f', icon: '',
          isAuto: false, isNoProject: false, lastActive: now }),
        nodeOf({ id: 'pj_demo2', label: 'WorkBuddy 桌面端', path: '/tmp/demo-repo-2', color: '#4a7ebb', icon: '',
          isAuto: false, isNoProject: false, lastActive: now - 1800 }),
        nodeOf({ id: HOME_PROJECT_ID, label: '未归类', path: null, color: '', icon: '',
          isAuto: true, isNoProject: true, lastActive: now - 7200 }),
      ];
      return { ok: true, generation: 1,
        projects: tree.filter((p) => !DELETED_PROJECTS.has(p.id)), errors: [] };
    },
    // 编排模式：Demo 里只是内存态，语义与真实一致（三档是两个布尔的派生值）
    async kanbanOrchestration() {
      return { ok: true, ...KB_MODE_STATE, modes: KB_MODE_LIST, degraded: false, warn: '' };
    },
    async kanbanSetMode(mode) {
      const m = KB_MODE_LIST.find((x) => x.id === mode);
      if (!m) return { ok: false, error: '未知的编排模式：' + String(mode) };
      const before = KB_MODE_STATE.mode;
      KB_MODE_STATE.dispatchInGateway = m.dispatch;
      KB_MODE_STATE.autoDecompose = m.decompose;
      KB_MODE_STATE.mode = m.id;
      KB_MODE_STATE.modeLabel = m.label;
      KB_MODE_STATE.decomposeStranded = !m.dispatch && m.decompose;
      return {
        ok: true, mode: m.id, modeLabel: m.label, changed: before === m.id ? [] : [m.id],
        needsRestart: !m.dispatch, steps: [],
        state: { ok: true, ...KB_MODE_STATE, modes: KB_MODE_LIST, degraded: false, warn: '' },
      };
    },
    async kanbanRun(runId) { return { ok: true, run: { id: runId, status: 'running', outcome: '', error: '' } }; },
  };

  /* ---- Kanban Demo 数据 ---- */
  const now = Math.floor(Date.now() / 1000);
  let KB_SEQ = 6, KB_EVT = 42;
  // 编排模式：三档是两个布尔的派生值，Demo 与真实语义一致（不单独存「模式」）
  const KB_MODE_LIST = [
    { id: 'auto', label: '全自动', dispatch: true, decompose: true, needsRestart: false,
      summary: '收集箱的卡会自动拆分并派发执行', detail: '演示数据：新卡会被自动拆解并推进执行。' },
    { id: 'semi', label: '半自动', dispatch: true, decompose: false, needsRestart: false,
      summary: '收集箱停住，其余照常自动执行', detail: '演示数据：只有 triage 不动，别的照旧。' },
    { id: 'manual', label: '全手动', dispatch: false, decompose: false, needsRestart: true,
      summary: '派发器整体停止，只有手动派发才会执行', detail: '演示数据：改这一档需要重启 gateway。' },
  ];
  // Demo 内删除过的项目 id：projectsTree 过滤掉，模拟真实后端删库后的树
  const DELETED_PROJECTS = new Set();
  // Demo 内新建过的目录 / 设置弹窗改过的项目（projects.get·update 的返回源）
  const DEMO_MKDIR = new Set();
  const DEMO_PROJECT_OVERRIDE = new Map();
  // Demo 的显式项目：path 是项目根，「移到项目」按 path 反查目标项目
  const DEMO_PROJECTS = new Map([
    ['pj_demo1', { label: 'Hermes Agent', path: '/tmp/demo-repo' }],
    ['pj_demo2', { label: 'WorkBuddy 桌面端', path: '/tmp/demo-repo-2' }],
  ]);
  const HOME_PROJECT_ID = '__no_project__';
  // 会话 → 目标项目 id：模拟 session.workspace.move 之后后端树的归属变化
  const DEMO_MOVED_SESSIONS = new Map();
  function demoProject(id) {
    const pid = String(id || '');
    const saved = DEMO_PROJECT_OVERRIDE.get(pid);
    if (saved) return { ...saved, folders: saved.folders.map((f) => ({ ...f })) };
    const meta = DEMO_PROJECTS.get(pid) || { label: pid, path: '/tmp/demo-repo' };
    return {
      id: pid, name: meta.label, description: '',
      primaryPath: meta.path,
      folders: [{ path: meta.path, label: '', isPrimary: true }],
    };
  }
  const KB_MODE_STATE = {
    mode: 'auto', modeLabel: '全自动',
    dispatchInGateway: true, autoDecompose: true, autoPromoteChildren: true,
    orchestratorProfile: '', defaultAssignee: '', resolvedOrchestrator: 'default',
    resolvedAssignee: 'default', activeProfile: 'default', decomposeStranded: false,
  };
  const KB_TASKS = [
    {
      id: 't_demo01', title: '收集粉丝反馈并归类成需求清单', body: '把最近两周的社群反馈按「体验 / 功能 / 性能」三类归档，输出一份带频次的清单。',
      status: 'triage', priority: 2, assignee: '', tenant: 'web', created_at: now - 86400,
      started_at: 0, completed_at: 0, latest_summary: '', result: '', comment_count: 2,
      progress: null, warnings: { count: 0 }, session_id: '', workspace_kind: 'worktree',
    },
    {
      id: 't_demo02', title: '为插件市场补充安装来源标注', body: '每张市场卡片注明来源 registry，方便审查第三方代码风险。',
      status: 'todo', priority: 0, assignee: '', tenant: '', created_at: now - 172800,
      started_at: 0, completed_at: 0, latest_summary: '', result: '', comment_count: 0,
      progress: null, warnings: { count: 0 }, session_id: '', workspace_kind: '',
    },
    {
      id: 't_demo03', title: '修复侧栏搜索在中文输入法下的抖动', body: '拼音组合输入期间 input 事件触发两次搜索 IPC，列表闪回。',
      status: 'ready', priority: 3, assignee: 'default', tenant: '', created_at: now - 259200,
      started_at: 0, completed_at: 0, latest_summary: '已定位 debounce 缺失，准备动手', result: '',
      comment_count: 1, progress: null, warnings: { count: 0 }, session_id: '', workspace_kind: 'worktree',
    },
    {
      id: 't_demo04', title: '重写轨道栏图标的命中区域', body: '图标栏按钮 36px，但视觉 16px，边缘点击丢失。扩大 padding 并保留视觉尺寸。',
      status: 'running', priority: 1, assignee: 'writer', tenant: 'cli', created_at: now - 3600,
      started_at: now - 600, completed_at: 0, latest_summary: '正在调整 rail 按钮的热区', result: '',
      comment_count: 0, progress: { done: 1, total: 3 }, warnings: { count: 0 }, session_id: '', workspace_kind: 'worktree',
    },
    {
      id: 't_demo05', title: '打包 dmg 后启动白屏', body: 'dist:mac 产物首次启动白屏 3 秒，疑似预热时序问题，需要人工复现确认。',
      status: 'blocked', priority: 4, assignee: 'default', tenant: '', created_at: now - 432000,
      started_at: 0, completed_at: 0, latest_summary: '', result: '',
      comment_count: 3, progress: null, warnings: { count: 1 }, session_id: '', workspace_kind: '',
    },
    {
      id: 't_demo06', title: '输出暖纸色主题对比度自查报告', body: '全部文本色在三种底色上的 WCAG 对比度复核。',
      status: 'done', priority: 0, assignee: 'writer', tenant: '', created_at: now - 600000,
      started_at: now - 590000, completed_at: now - 570000,
      latest_summary: '报告已写入 docs/contrast.md', result: '全部文本色 ≥ 4.5:1，装饰色 ≥ 3:1，达标。',
      comment_count: 0, progress: null, warnings: { count: 0 }, session_id: '', workspace_kind: '',
    },
  ];
  const KB_COMMENTS = [
    { id: 1, task_id: 't_demo01', author: 'user', body: '优先处理关于导出的反馈。', created_at: now - 80000 },
    { id: 2, task_id: 't_demo01', author: 'agent', body: '已收到，共 17 条反馈待归类。', created_at: now - 79000 },
    { id: 3, task_id: 't_demo03', author: 'agent', body: '根因：input 与 compositionupdate 双触发。', created_at: now - 3600 },
    { id: 4, task_id: 't_demo05', author: 'user', body: '重装后仍复现，附截图在附件里。', created_at: now - 7200 },
  ];
  const KB_EVENTS = [
    { id: 1, task_id: 't_demo03', run_id: 0, kind: 'assigned', payload: 'default', created_at: now - 3600 },
    { id: 2, task_id: 't_demo03', run_id: 0, kind: 'status', payload: 'todo → ready', created_at: now - 3500 },
    { id: 3, task_id: 't_demo04', run_id: 9, kind: 'run_started', payload: 'worker=writer', created_at: now - 600 },
    { id: 4, task_id: 't_demo05', run_id: 0, kind: 'blocked', payload: '需要人工复现打包产物', created_at: now - 8600 },
    { id: 5, task_id: 't_demo06', run_id: 3, kind: 'completed', payload: 'exit 0', created_at: now - 570000 },
  ];
})();
