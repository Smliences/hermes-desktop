'use strict';
/**
 * hermes-kanban.js — CLI 原生 Kanban 看板客户端（读 + 受控写 + 派发）
 *
 * 数据源是常驻 `hermes serve` 已经挂载的 dashboard 插件路由
 * `/api/plugins/kanban/*`（与 CLI 自带桌面端 apps/desktop 复用同一个门面）。
 * 不直读 kanban.db、不新起进程、不复制任何领域逻辑。
 *
 * 安全边界（生产级，契约测试锁死）：
 *   - 会话 token 只存在于本模块与 master 进程，绝不进入返回值 / 渲染层；
 *     每个请求由主进程自己加 `X-Hermes-Session-Token`。
 *   - 读端点只允许 GET；写端点固定白名单（新建任务/看板、删除任务、提交派发、
 *     改派受让人、拖列改状态、派发 tick、拆解、补规格、估算、评论、项目绑定、
 *     编排开关），路径由本模块构造，渲染层无法拼任意路径或任意 body 字段。
 *   - 任务 id / board slug / run id 全部过严格正则，query 走 URLSearchParams
 *     编码；固定 loopback 127.0.0.1 + 端口数字校验 + 不跟随重定向 + 超时 + 体积上限。
 *   - CLI 返回的 task 行含 workspace_path / claim_lock / worker_pid 等本机敏感
 *     字段，统一按白名单投影后才交给渲染层；正文与诊断做长度 / 条数封顶。
 *   - 派发是唯一会唤醒 agent worker 的路径，三重兜底：dry_run 默认 true
 *     （只有显式 false 才真派发）、并发上限与 CLI 默认对齐（max=8，本看板
 *     running + 本次）、同一客户端串行（并发请求直接拒绝）。派发结果里的
 *     workspace 路径与 worker PID 一律不透出。
 *     「派发这一张」（dispatchTask）额外先在 dry_run 里确认它是队首，
 *     否则真派发会先唤醒更早的卡片 —— 那种情况一律不写库。
 *   - 明确不放行：bulk、reclaim、terminate、把任务设成 running、
 *     归档、裸 /estimate（无任务的文本级估算）、orchestration 配置写入
 *     （只读推导在 hermes-kanban-mode.js）、看板切换（switch 恒为 false）。
 *     人工状态推进只走 SET_STATUSES 那 7 个动词。
 *   - 会花 LLM 钱的写路径只有三条：拆解（/decompose，180s）、补规格（/specify，120s）、
 *     估算（/estimate，60s）。三者都单独给超长预算（不能套用 6s 的常规超时），并且
 *     **必须显式 confirm === true** 才发请求 —— 渲染层要过一次二次确认卡，
 *     任何顺手调用都写不进来。估算不改任何数据，但也计费，同样要确认。
 */
const http = require('http');
const log = require('./logger');

const PLUGIN_BASE = '/api/plugins/kanban';
/** 侧栏项目树来自 profiles 路由（与看板同一个 serve、同一个 token，不同前缀）。 */
const PROFILE_BASE = '/api/profiles';
/** 请求前缀白名单：requestJSON 只接受这两个值，渲染层无法指定任意路径前缀。 */
const BASES = Object.freeze([PLUGIN_BASE, PROFILE_BASE]);
const TIMEOUT_MS = 6000;
/**
 * 调辅助模型的三条路径都要独立预算：常规 6s 会把模型调用半路掐断。
 * 数值 = CLI 侧上限 + 余量（拆解 180s / 补规格 120s / 估算 60s）。
 */
const DECOMPOSE_TIMEOUT_MS = 200000;
const SPECIFY_TIMEOUT_MS = 150000;
const ESTIMATE_TIMEOUT_MS = 90000;
/** 超长预算只认这三个模块常量：渲染层传任何其它值都退回 6s。 */
const SLOW_BUDGETS = Object.freeze([DECOMPOSE_TIMEOUT_MS, SPECIFY_TIMEOUT_MS, ESTIMATE_TIMEOUT_MS]);
const MAX_BODY = 2 * 1024 * 1024;
const MAX_WRITE_BODY = 32 * 1024;
const MAX_TEXT = 20000;
const MAX_ITEMS = 300;
const TASK_ID_RE = /^t_[A-Za-z0-9_-]{1,64}$/;
const BOARD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const RUN_ID_RE = /^\d{1,12}$/;
/** 创建时可选的起始状态。ready 可能被调度器立即派发，UI 必须显式警示。 */
const CREATE_STATUSES = Object.freeze(['triage', 'ready']);
/** 改派允许顺带推进到的状态。只有 ready —— 其它状态推进不在本桌面端白名单里。 */
const REASSIGN_STATUSES = Object.freeze(['ready']);
/** 人工拖列改状态允许的目标。CLI 的 PATCH /tasks/{id} 认这 7 个动词：
 *  triage/todo/ready 走 `_drag_to`（blocked、scheduled → ready 会先 unblock），
 *  review 走 request_review(force)、done 走 complete_task(force)、blocked/scheduled 各带原因。
 *  **running 明确不在表里**：CLI 会回 “Cannot set status to 'running' directly”，
 *  它只能由调度器 claim；archived 也不放行 —— 归档在 CLI 侧是单向的，误拖没有回退口。 */
const SET_STATUSES = Object.freeze(['triage', 'todo', 'ready', 'review', 'blocked', 'scheduled', 'done']);
/** 受让人 = Hermes profile 名：字母或数字开头，可含 . _ -；空串表示取消指派。 */
const ASSIGNEE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** 项目标识（id 或 slug）：字母或数字开头，可含 _ -。CLI 接受 id / slug 两种形态。 */
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
/** 手动派发的并发上限钳制：与 CLI 的 POST /dispatch 默认 max=8 对齐。
 *  CLI 的 max_spawn 是「本看板并发上限（running + 本次）」，不是每次批量 ——
 *  用户选 8 最多也就把并发提到 8 个 worker，再高需要改 CLI 配置而不是这里。 */
const DISPATCH_MAX_SPAWN = 8;
/** 提交派发后任务进入的状态。服务层写死，渲染层只传 taskId。 */
const SUBMIT_STATUS = 'ready';

/** 看板列顺序与 CLI 的 BOARD_COLUMNS 对齐；archived 由开关追加为第 9 列。 */
const COLUMNS = Object.freeze([
  'triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done',
]);
const ALL_COLUMNS = Object.freeze([...COLUMNS, 'archived']);

/** 卡片 / 详情允许透出的字段。未列出的字段（含工作区路径、认领锁、PID）一律丢弃。 */
const TASK_FIELDS = Object.freeze([
  'id', 'title', 'body', 'status', 'priority', 'assignee', 'tenant', 'created_by',
  'created_at', 'started_at', 'completed_at', 'workspace_kind', 'project_id',
  'session_id', 'result', 'latest_summary', 'comment_count', 'link_counts',
  'progress', 'current_run_started_at', 'max_runtime_seconds', 'model_override',
  'goal_mode', 'block_kind', 'consecutive_failures', 'warnings', 'diagnostics',
]);
const RUN_FIELDS = Object.freeze([
  'id', 'task_id', 'profile', 'step_key', 'status', 'outcome', 'started_at',
  'ended_at', 'summary', 'error', 'max_runtime_seconds',
]);
const EVENT_FIELDS = Object.freeze(['id', 'task_id', 'run_id', 'kind', 'payload', 'created_at']);
const COMMENT_FIELDS = Object.freeze(['id', 'task_id', 'author', 'body', 'created_at']);
const ATTACHMENT_FIELDS = Object.freeze(['id', 'task_id', 'filename', 'content_type', 'size', 'created_at']);

function str(v, max = 400) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}
function text(v) { return str(v, MAX_TEXT); }
function num(v) { return Number.isFinite(v) ? v : (typeof v === 'number' ? v : null); }
function bool(v) { return v === true || v === 1; }

/** 按白名单挑字段；未知字段永不透传。 */
function project(src, fields, overrides = {}) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const v = src[key];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') out[key] = (key === 'body' || key === 'result' || key === 'summary' || key === 'error')
      ? text(v) : str(v, 2000);
    else if (typeof v === 'number') out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
    else if (Array.isArray(v)) out[key] = v.slice(0, MAX_ITEMS).map((x) =>
      (x && typeof x === 'object') ? safeObject(x) : (typeof x === 'string' ? str(x, 2000) : x));
    else if (typeof v === 'object') out[key] = safeObject(v);
  }
  return { ...out, ...overrides };
}
function safeObject(v) {
  const out = {};
  for (const [k, val] of Object.entries(v || {}).slice(0, 24)) {
    if (typeof val === 'string') out[k] = str(val, 2000);
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val;
    else if (val === null) out[k] = null;
  }
  return out;
}

function projectTask(t, { full = false } = {}) {
  const p = project(t, TASK_FIELDS);
  p.body = full ? text(t && t.body) : str(t && t.body, 400);
  p.priority = num(p.priority) || 0;
  p.goal_mode = bool(p.goal_mode);
  if (!full) delete p.diagnostics;
  return p;
}
function projectList(v, fields) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_ITEMS).map((x) => project(x, fields));
}

/** 后端信息校验：端口必须是数字，token 必须存在且无控制字符。 */
function validInfo(info) {
  if (!info || typeof info !== 'object') return false;
  // 严格 number：字符串端口经 IPC / JSON 边界悄悄混进来时宁可拒绝，
  // 也不要把 Number() 的隐式转换变成可绕过的校验。
  const port = info.port;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
    && typeof info.token === 'string' && info.token.length >= 8
    && !/[\s\x00-\x1f]/.test(info.token);
}

/**
 * 构造只读请求路径。op 白名单之外一律返回 null（渲染层无法拼任意路径）。
 * 返回相对 PLUGIN_BASE 的 path+query，供 GET 使用。
 */
function buildPath(op, params = {}) {
  const p = params && typeof params === 'object' ? params : {};
  const q = new URLSearchParams();
  if (typeof p.board === 'string' && p.board) {
    // 显式拼字符串：undefined/null 经 IPC 结构化克隆后可能变成 'null'，
    // 而 'null' 本身是合法 slug，会把请求指向一个不存在的看板。
    if (!BOARD_RE.test(p.board)) return null;
    q.set('board', p.board);
  }
  if (typeof p.tenant === 'string' && p.tenant) q.set('tenant', p.tenant.slice(0, 120));
  if (p.includeArchived) q.set('include_archived', 'true');
  const suffix = q.toString() ? '?' + q.toString() : '';
  switch (op) {
    case 'board': return '/board' + suffix;
    case 'task':
      if (!TASK_ID_RE.test(String(p.taskId || ''))) return null;
      return '/tasks/' + encodeURIComponent(String(p.taskId)) + suffix;
    case 'run':
      if (!RUN_ID_RE.test(String(p.runId || ''))) return null;
      return '/runs/' + encodeURIComponent(String(p.runId)) + suffix;
    case 'stats': return '/stats' + suffix;
    case 'assignees': return '/assignees' + suffix;
    case 'boards': return '/boards' + suffix;
    case 'projects': return '/projects' + suffix;
    case 'config': return '/config' + suffix;
    case 'orchestration': return '/orchestration';
    case 'diagnostics': return '/diagnostics' + suffix;
    case 'workers': return '/workers/active' + suffix;
    // 侧栏项目树（GET /api/profiles/projects/tree）：服务端按 project → repo → lane
    // 把会话分好组，previewSessions 是每项目最近几条、sessionIds 是全量认领 id。
    case 'projectsTree': {
      const preview = Number.isInteger(p.previewLimit) ? Math.max(1, Math.min(5, p.previewLimit)) : 3;
      return `/projects/tree?preview_limit=${preview}&session_limit=2000`;
    }
    default: return null;
  }
}

/** 手动派发的并发上限。非整数一律落到 1，绝不把 NaN/字符串放大成批量派发。 */
function clampMaxSpawn(v) {
  return Number.isInteger(v) ? Math.max(1, Math.min(DISPATCH_MAX_SPAWN, v)) : 1;
}

/** 写操作路径白名单。渲染层传不进任何自定义路径。 */
function buildWritePath(op, params = {}) {
  const p = params && typeof params === 'object' ? params : {};
  const q = new URLSearchParams();
  if (typeof p.board === 'string' && p.board) {
    if (!BOARD_RE.test(p.board)) return null;
    q.set('board', p.board);
  }
  const suffix = q.toString() ? '?' + q.toString() : '';
  switch (op) {
    case 'createTask': return '/tasks' + suffix;
    case 'createBoard': return '/boards';
    case 'deleteTask':
      if (!TASK_ID_RE.test(String(p.taskId || ''))) return null;
      return '/tasks/' + encodeURIComponent(String(p.taskId)) + suffix;
    case 'submitTask':
      if (!TASK_ID_RE.test(String(p.taskId || ''))) return null;
      return '/tasks/' + encodeURIComponent(String(p.taskId)) + suffix;
    case 'reassign':
      if (!TASK_ID_RE.test(String(p.taskId || ''))) return null;
      return '/tasks/' + encodeURIComponent(String(p.taskId)) + suffix;
    // 人工拖列改状态：与 HTTP 方法无关地复用同一端点，body 只放 status（+ 可选原因/摘要）
    case 'setStatus':
      if (!TASK_ID_RE.test(String(p.taskId || ''))) return null;
      return '/tasks/' + encodeURIComponent(String(p.taskId)) + suffix;
    case 'dispatch':
      // dry_run 默认 true：只有渲染层显式传 dryRun === false 才真正唤醒 worker。
      q.set('dry_run', p.dryRun === false ? 'false' : 'true');
      q.set('max', String(clampMaxSpawn(p.max)));
      return '/dispatch?' + q.toString();
    // 给看板绑 / 解绑项目：CLI 是 PATCH /boards/{slug}（slug 在路径里，不走 ?board=）。
    // 绑定后项目 primary repo 自动成为看板 default_workdir，任务获得确定性 worktree。
    case 'bindBoard':
      if (!BOARD_RE.test(String(p.slug || ''))) return null;
      return '/boards/' + encodeURIComponent(String(p.slug)) + suffix;
    // 编排开关（config.yaml 的 kanban 段）：CLI 侧是 PUT，不是 POST。
    case 'orchestration': return '/orchestration';
    // 拆解：CLI 侧 POST /tasks/{id}/decompose（body 只有可选 author，这里恒发 {}）。
    case 'decompose':
      if (!TASK_ID_RE.test(String(p.taskId || ''))) return null;
      return '/tasks/' + encodeURIComponent(String(p.taskId)) + '/decompose' + suffix;
    // 补规格：POST /tasks/{id}/specify，把 triage 的一句话扩成 Goal/Approach/验收标准。
    case 'specify':
      if (!TASK_ID_RE.test(String(p.taskId || ''))) return null;
      return '/tasks/' + encodeURIComponent(String(p.taskId)) + '/specify' + suffix;
    // 估算：POST /tasks/{id}/estimate，只读模型估算（不改库）。裸 /estimate（无任务的
    // 文本级端点）不开放：它接受任意 title/body 并直接计费，桌面端没有对应入口。
    case 'estimate':
      if (!TASK_ID_RE.test(String(p.taskId || ''))) return null;
      return '/tasks/' + encodeURIComponent(String(p.taskId)) + '/estimate' + suffix;
    // 评论：CLI 的 POST /tasks/{id}/comments（body 只有 body + 可选 author，均不过模型）。
    case 'comment':
      if (!TASK_ID_RE.test(String(p.taskId || ''))) return null;
      return '/tasks/' + encodeURIComponent(String(p.taskId)) + '/comments' + suffix;
    default: return null;
  }
}

/** 去掉控制字符 / 首尾空白，并限长。渲染层输入一律视为不可信。 */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);
}
/**
 * 受让人校验：返回合法 profile 名、'' (取消指派) 或 null (非法)。
 * 拖拽派发只认 profile 名，避免把控制面 lane 或空字符串误当受让人写进 kanban.db。
 */
function cleanAssignee(v) {
  const s = cleanText(v, 80);
  if (!s) return '';
  return ASSIGNEE_RE.test(s) ? s : null;
}
/** 新建任务：只允许 CLI CreateTaskBody 中桌面端明确支持的字段。 */
function cleanTaskInput(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const title = cleanText(o.title, 200);
  if (!title) return null;
  const body = cleanText(o.body, MAX_TEXT);
  const assignee = cleanText(o.assignee, 80);
  const tenant = cleanText(o.tenant, 80);
  const key = typeof o.idempotencyKey === 'string' ? o.idempotencyKey : '';
  if (!IDEMPOTENCY_RE.test(key)) return null;
  const priority = Number.isInteger(o.priority) ? Math.max(0, Math.min(100, o.priority)) : 0;
  const status = CREATE_STATUSES.includes(o.status) ? o.status : 'triage';
  const out = { title, priority, triage: status !== 'ready', idempotency_key: key };
  if (body) out.body = body;
  if (assignee) out.assignee = assignee;
  if (tenant) out.tenant = tenant;
  // 建卡选项目：空/缺省 = 继承看板绑定的项目（CLI 语义），传了则锁定该项目。
  const projectId = cleanText(o.projectId, 80);
  if (projectId) {
    if (!PROJECT_RE.test(projectId)) return null;
    out.project_id = projectId;
  }
  return out;
}
/** 评论：body 必填（CLI 对空白串回 400 "body is required"），author 可选（缺省 CLI 落 'dashboard'）。 */
function cleanCommentInput(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const body = cleanText(o.body, 4000);
  if (!body) return null;
  const out = { body };
  const author = cleanText(o.author, 80);
  if (author) out.author = author;
  return out;
}

/** 新建看板：不传 switch，绝不改 CLI 的 current_board 指针。 */
function cleanBoardInput(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const slug = cleanText(o.slug, 64);
  if (!BOARD_RE.test(slug)) return null;
  const out = { slug };
  const name = cleanText(o.name, 80);
  const description = cleanText(o.description, 400);
  if (name) out.name = name;
  if (description) out.description = description;
  return out;
}

/** 给看板绑 / 解绑项目：project_id 空串 = 解绑；非空必须过项目标识正则。 */
function cleanBoardBind(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const projectId = typeof o.projectId === 'string' ? o.projectId.trim().slice(0, 80) : '';
  if (!projectId) return { project_id: '' };  // CLI 的 write_board_metadata 把 falsy 当「清除」
  if (!PROJECT_RE.test(projectId)) return null;
  return { project_id: projectId };
}

/**
 * 编排开关的写投影：只认 CLI `PUT /orchestration` 白名单里的 4 个键，类型逐个收敛。
 * 布尔以外的形态一律整体拒绝（不做「猜一个」的隐式转换，写 CLI 配置不接受歧义）。
 */
const ORCHESTRATION_KEYS = Object.freeze([
  'auto_decompose', 'auto_promote_children', 'orchestrator_profile', 'default_assignee',
]);
function cleanOrchestration(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of ORCHESTRATION_KEYS) {
    if (o[k] === undefined || o[k] === null) continue;
    if (k === 'auto_decompose' || k === 'auto_promote_children') {
      if (typeof o[k] !== 'boolean') return null;
      out[k] = o[k];
    } else {
      if (typeof o[k] !== 'string') return null;
      const v = cleanText(o[k], 80);
      if (v && !ASSIGNEE_RE.test(v)) return null;   // profile 名；空串表示清除覆盖
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** 把 CLI /orchestration 的响应投影成 UI 用的驼峰形态。 */
function projectOrchestration(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    autoDecompose: d.auto_decompose !== false,
    autoPromoteChildren: d.auto_promote_children !== false,
    orchestratorProfile: str(d.orchestrator_profile, 80),
    defaultAssignee: str(d.default_assignee, 80),
    resolvedOrchestrator: str(d.resolved_orchestrator_profile, 80),
    resolvedAssignee: str(d.resolved_default_assignee, 80),
    activeProfile: str(d.active_profile, 80),
  };
}

/** 单次 loopback 请求（GET 读 / POST·PATCH·PUT·DELETE 白名单写）。永不 throw。
 *  timeoutMs 只允许放大到本模块给出的常量，渲染层无法传任意超时。 */
function requestJSON(info, method, pathWithQuery, body, base, timeoutMs) {
  // 前缀只允许两个白名单值；undefined 兼容旧调用 = 看板插件路由。
  const prefix = BASES.includes(base) ? base : PLUGIN_BASE;
  const budget = SLOW_BUDGETS.includes(timeoutMs) ? timeoutMs : TIMEOUT_MS;
  return new Promise((resolve) => {
    if (!validInfo(info) || typeof pathWithQuery !== 'string' || !pathWithQuery.startsWith('/')
        || (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'PUT' && method !== 'DELETE')) {
      resolve({ ok: false, error: '看板请求参数非法' });
      return;
    }
    let payload = null;
    if (body !== null && body !== undefined) {
      if (method === 'GET' || !body || typeof body !== 'object' || Array.isArray(body)) {
        resolve({ ok: false, error: '非法的写请求体' }); return;
      }
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      if (payload.length > MAX_WRITE_BODY) { resolve({ ok: false, error: '请求内容过大' }); return; }
    }
    const path = prefix + pathWithQuery;
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(hardTimer); resolve(v); } };
    let req;
    const hardTimer = setTimeout(() => {
      try { req && req.destroy(); } catch {}
      finish({ ok: false, error: '看板请求超时' });
    }, budget + 1500);
    try {
      req = http.request({
        host: '127.0.0.1',
        port: Number(info.port),
        method,
        path,
        agent: false,
        headers: {
          'X-Hermes-Session-Token': info.token,
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }
            : (method === 'GET' ? {} : { 'Content-Length': '0' })),
        },
      }, (res) => {
        const status = Number(res.statusCode) || 0;
        // 不跟随重定向：避免被诱导到非 loopback 地址
        if (status >= 300 && status < 400) {
          res.resume();
          return finish({ ok: false, status, error: '看板接口返回重定向，已拒绝' });
        }
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            try { req.destroy(); } catch {}
            return finish({ ok: false, status, error: '看板响应过大' });
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (status === 401 || status === 403) {
            return finish({ ok: false, status, error: '看板鉴权失败，请重启桌面端后重试' });
          }
          if (status < 200 || status >= 300) {
            // FastAPI 的 {"detail": "..."} 直接透出，让创建失败可诊断；仍做长度封顶。
            let detail = '';
            try { const j = JSON.parse(raw); detail = str(typeof j?.detail === 'string' ? j.detail : '', 240); } catch {}
            return finish({ ok: false, status, error: detail || `看板接口返回 ${status}` });
          }
          try { finish({ ok: true, status, data: raw ? JSON.parse(raw) : null }); }
          catch { finish({ ok: false, status, error: '看板返回的不是有效 JSON' }); }
        });
      });
      req.setTimeout(budget, () => {
        try { req.destroy(); } catch {}
        finish({ ok: false, error: '看板请求超时' });
      });
      req.on('error', (err) => finish({
        ok: false,
        error: '无法连接看板服务：' + str((err && err.message) || '连接失败', 120),
      }));
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      finish({ ok: false, error: '看板请求失败：' + str((err && err.message) || '', 120) });
    }
  });
}

/** 读端点固定 GET；写端点由 createKanbanClient 的方法显式指定。 */
function getJSON(info, pathWithQuery, base) {
  return requestJSON(info, 'GET', pathWithQuery, null, base);
}
function postJSON(info, pathWithQuery, body, timeoutMs) {
  return requestJSON(info, 'POST', pathWithQuery, body, undefined, timeoutMs);
}
function patchJSON(info, pathWithQuery, body) {
  return requestJSON(info, 'PATCH', pathWithQuery, body);
}
function putJSON(info, pathWithQuery, body) {
  return requestJSON(info, 'PUT', pathWithQuery, body);
}
function deleteJSON(info, pathWithQuery) {
  return requestJSON(info, 'DELETE', pathWithQuery, null);
}

/** 侧栏项目树里单个会话预览行允许透出的字段（CLI _project_tree_row 行的白名单子集）。 */
const TREE_SESSION_FIELDS = Object.freeze(['id', 'title', 'preview', 'started_at', 'last_active']);
/** 项目认领的全量会话 id 封顶：侧栏只用来做「哪些会话已归组」的排除集合。 */
const TREE_IDS_MAX = 600;

/** 会话预览行投影：只留列表渲染需要的字段，cwd/成本/血缘等一律不透出。 */
function projectTreeRow(s) {
  const o = s && typeof s === 'object' ? s : {};
  const out = {};
  for (const k of TREE_SESSION_FIELDS) {
    if (o[k] === undefined || o[k] === null) continue;
    if (typeof o[k] === 'string') out[k] = k === 'preview' ? str(o[k], 400) : str(o[k], 200);
    else if (typeof o[k] === 'number') out[k] = o[k];
  }
  return out.id ? out : null;
}

/**
 * 把 CLI /projects/tree 的响应投影成侧栏用的形态。
 * 只透出项目标识/计数/预览/认领 id；repos 与 lane（worktree 泳道）细节不上渲染层。
 * 归属规则的权威在 CLI（git_repo_root || cwd），桌面端只是树投影。
 */
function projectTree(data) {
  const d = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(d.projects) ? d.projects : [];
  const projects = list.slice(0, 100).map((p) => {
    const o = p && typeof p === 'object' ? p : {};
    const previews = (Array.isArray(o.previewSessions) ? o.previewSessions : [])
      .slice(0, 10).map(projectTreeRow).filter(Boolean);
    const ids = (Array.isArray(o.sessionIds) ? o.sessionIds : [])
      .filter((x) => typeof x === 'string' && x).slice(0, TREE_IDS_MAX);
    const lastActive = Number(o.last_active) || 0;
    const fallbackLabel = o.isNoProject ? '未归类' : (o.isAuto ? baseName(o.path) : '');
    return {
      id: str(o.id, 80), label: str(o.label, 120) || fallbackLabel,
      path: str(o.path, 300), color: str(o.color, 16), icon: str(o.icon, 8),
      isAuto: o.isAuto === true, isNoProject: o.isNoProject === true,
      sessionCount: Number.isInteger(o.sessionCount) ? Math.max(0, Math.min(99999, o.sessionCount)) : 0,
      lastActive: Number.isFinite(lastActive) ? lastActive : 0,
      previewSessions: previews, sessionIds: ids,
    };
  }).filter((x) => x.id && (x.label || x.path));
  return { projects, errors: Array.isArray(d.errors) ? d.errors.slice(0, 5).map((x) => safeObject(x)) : [] };
}
/** 从路径取末段作 auto 项目的展示名（CLI build_tree 的 auto 桶同语义）。 */
function baseName(p) {
  const s = String(p || '').replace(/\/+$/, '');
  return s ? (s.split('/').pop() || '').slice(0, 120) : '';
}

/** 把 /board 的原始响应投影成 UI 需要的形态，补齐 8/9 列。 */
function projectBoard(data, includeArchived) {
  const raw = data && typeof data === 'object' ? data : {};
  const wanted = includeArchived ? ALL_COLUMNS : COLUMNS;
  const byName = new Map();
  for (const c of (Array.isArray(raw.columns) ? raw.columns : [])) {
    if (!c || typeof c.name !== 'string') continue;
    byName.set(c.name, Array.isArray(c.tasks) ? c.tasks : []);
  }
  const columns = wanted.map((name) => ({
    name,
    tasks: (byName.get(name) || []).slice(0, MAX_ITEMS).map((t) => projectTask(t)),
  }));
  return {
    columns,
    tenants: (Array.isArray(raw.tenants) ? raw.tenants : []).slice(0, 100).map((x) => str(x, 80)),
    assignees: (Array.isArray(raw.assignees) ? raw.assignees : []).slice(0, 100)
      .map((x) => (typeof x === 'string' ? str(x, 80) : str(x && x.name, 80))).filter(Boolean),
    latestEventId: Number(raw.latest_event_id) || 0,
    now: Number(raw.now) || 0,
  };
}

/** 把 /tasks/:id 的原始详情投影成 UI 需要的形态。 */
function projectDetail(data) {
  const raw = data && typeof data === 'object' ? data : {};
  return {
    task: projectTask(raw.task, { full: true }),
    comments: projectList(raw.comments, COMMENT_FIELDS),
    events: projectList(raw.events, EVENT_FIELDS).slice(-60),
    attachments: projectList(raw.attachments, ATTACHMENT_FIELDS),
    links: {
      parents: Array.isArray(raw.links?.parents) ? raw.links.parents.slice(0, 50).map((x) => str(x, 80)) : [],
      children: Array.isArray(raw.links?.children) ? raw.links.children.slice(0, 50).map((x) => str(x, 80)) : [],
    },
    linkTasks: projectList(raw.link_tasks, ['id', 'title', 'status']),
    childResults: projectList(raw.child_results, ['id', 'title', 'status', 'latest_summary', 'result']),
    runs: projectList(raw.runs, RUN_FIELDS).slice(-40),
  };
}

/** 派发结果允许透出的字段。spawned 的第三项是本机 workspace 绝对路径，必须丢掉。 */
const DISPATCH_LISTS = Object.freeze([
  'crashed', 'timed_out', 'stale', 'auto_blocked', 'reaped_terminal_workers',
  'reconciled_orphans', 'skipped_unassigned', 'skipped_nonspawnable', 'auto_assigned_default',
]);
const DISPATCH_COUNTS = Object.freeze([
  'reclaimed', 'promoted', 'rate_limited', 'skipped_locked', 'memory_pressure',
]);
const WORKER_FIELDS = Object.freeze([
  'run_id', 'task_id', 'task_title', 'task_status', 'task_assignee', 'profile',
  'started_at', 'max_runtime_seconds',
]);

function strList(v, cap = 60) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, cap).map((x) => (typeof x === 'string' ? str(x, 200) : str(x && x.task_id, 80))).filter(Boolean);
}
/** 把 DispatchResult 投影成 UI 安全形态，任何路径 / PID / claim 锁都不透出。 */
function projectDispatch(data) {
  const raw = data && typeof data === 'object' ? data : {};
  const src = raw.result && typeof raw.result === 'object' ? raw.result : raw;
  const out = { spawned: [], skippedPerProfile: [], respawnGuarded: [], lists: {}, counts: {} };
  // spawned: [task_id, assignee, 工作区绝对路径] 或 {task_id, assignee, ...}
  const spawned = Array.isArray(src.spawned) ? src.spawned : [];
  out.spawned = spawned.slice(0, 60).map((x) => {
    if (Array.isArray(x)) return { taskId: str(x[0], 80), assignee: str(x[1], 80) };
    const o = x && typeof x === 'object' ? x : {};
    return { taskId: str(o.task_id || o.taskId, 80), assignee: str(o.assignee, 80) };
  }).filter((x) => x.taskId);
  for (const k of DISPATCH_LISTS) out.lists[k] = strList(src[k]);
  for (const k of DISPATCH_COUNTS) {
    const v = src[k];
    out.counts[k] = typeof v === 'boolean' ? v : (Number.isFinite(v) ? v : 0);
  }
  const capped = Array.isArray(src.skipped_per_profile_capped) ? src.skipped_per_profile_capped : [];
  out.skippedPerProfile = capped.slice(0, 60).map((x) => {
    const o = Array.isArray(x) ? { task_id: x[0], assignee: x[1], current: x[2] } : (x || {});
    return { taskId: str(o.task_id, 80), assignee: str(o.assignee, 80), current: Number(o.current) || 0 };
  }).filter((x) => x.taskId);
  const guarded = Array.isArray(src.respawn_guarded) ? src.respawn_guarded : [];
  out.respawnGuarded = guarded.slice(0, 60).map((x) => {
    const o = Array.isArray(x) ? { task_id: x[0], reason: x[1] } : (x || {});
    return { taskId: str(o.task_id, 80), reason: str(o.reason, 200) };
  }).filter((x) => x.taskId);
  return out;
}
/**
 * 拆解结果的英文 reason → 中文。CLI 的「预期失败」走 HTTP 200 + ok:false，
 * 原样把 `task is not in triage (status='ready')` 拍到界面上等于没解释。
 * 未命中映射的一律保留原文（诊断信息不能被吞掉）。
 */
const DECOMPOSE_REASON = Object.freeze([
  [/^unknown task id$/i, '任务不存在（可能已被删除）'],
  [/^task is not in triage/i, '只有收集箱里的任务能拆解；这张已经离开收集箱'],
  [/^auxiliary client unavailable$/i, '辅助模型未配置：先在 CLI 里配好 auxiliary.kanban_decomposer'],
  [/^LLM returned malformed JSON$/i, '模型返回的不是合法 JSON，可以直接重试'],
  [/^LLM error/i, '辅助模型调用失败'],
]);
function kbReason(text) {
  const s = str(text, 200);
  if (!s) return '';
  for (const [re, zh] of DECOMPOSE_REASON) if (re.test(s)) return zh;
  return s;
}
/**
 * 补规格的失败原因 → 中文。文案要能指向下一步动作：CLI 的原文
 * `task is not in triage (status='todo')` 只说「不在收集箱」，用户看不出该怎么办。
 * 成功时 CLI 回 reason='specified'，那是内部短语，界面上另有文案，这里映射成空串。
 */
const SPECIFY_REASON = Object.freeze([
  [/^specified$/i, ''],
  [/^unknown task id$/i, '任务不存在（可能已被删除）'],
  [/^task is not in triage/i, '只有收集箱里的任务能补规格；这张已经离开收集箱'],
  [/^auxiliary client unavailable$/i, '辅助模型未配置：先在 CLI 里配好 auxiliary.triage_specifier'],
  [/^LLM returned an empty response$/i, '模型没有返回内容，可以直接重试'],
  [/^LLM response missing title and body$/i, '模型返回的内容里既没有标题也没有正文，可以直接重试'],
  [/^task moved out of triage before promotion$/i, '写着写着这张卡被移出收集箱了（可能另一个窗口刚操作过），刷新后再看'],
  [/^LLM error/i, '辅助模型调用失败'],
]);
function kbSpecifyReason(text) {
  const s = str(text, 200);
  if (!s) return '';
  for (const [re, zh] of SPECIFY_REASON) if (re.test(s)) return zh;
  return s;
}
/** 估算的失败原因 → 中文。它不改库，失败几乎都是「模型/配置」问题，重试往往有效。 */
const ESTIMATE_REASON = Object.freeze([
  [/^a title is required to estimate$/i, '任务没有标题，没法估算'],
  [/^auxiliary client unavailable$/i, '辅助模型未配置：估算走 agent.auxiliary_client'],
  [/^could not parse an estimate from the model$/i, '模型返回的不是合法 JSON，可以直接重试'],
  [/^task not found$/i, '任务不存在（可能已被删除）'],
  [/^LLM error/i, '辅助模型调用失败'],
]);
function kbEstimateReason(text) {
  const s = str(text, 200);
  if (!s) return '';
  for (const [re, zh] of ESTIMATE_REASON) if (re.test(s)) return zh;
  return s;
}
/** 拆解响应投影：只透出 UI 需要的字段，child_ids 过白名单 + 条数封顶。 */
function projectDecompose(data) {
  const d = data && typeof data === 'object' ? data : {};
  const kids = Array.isArray(d.child_ids) ? d.child_ids : [];
  // fanout=false 是「模型判断这已是单一任务」的正常结局，不是失败：
  // 此时根任务被改写并留在原地，reason 是 'single task (no fanout)'。
  const fanout = !!d.fanout;
  return {
    ok: !!d.ok,
    taskId: str(d.task_id, 80),
    reason: kbReason(d.reason),
    // 单任务结局的 reason 是内部短语，界面上另有文案，这里不重复透出
    single: !!d.ok && !fanout,
    fanout,
    childIds: kids.filter((x) => TASK_ID_RE.test(String(x || ''))).slice(0, 40),
    newTitle: str(d.new_title, 300),
  };
}
/** 补规格响应投影：CLI 只回 ok / task_id / reason / new_title。 */
function projectSpecify(data) {
  const d = data && typeof data === 'object' ? data : {};
  const ok = !!d.ok;
  return {
    ok,
    taskId: str(d.task_id, 80),
    reason: ok ? '' : kbSpecifyReason(d.reason),
    newTitle: str(d.new_title, 300),
  };
}
/**
 * 估算响应投影：{ok, est_tokens, complexity: S|M|L, rationale, model}。
 * est_tokens 是「整轮 agent run 的量级」而非报价，这里只做整数化与上限收敛；
 * complexity 只认 S/M/L（CLI 已过滤一次，这里二次兜底，脏值一律空串）。
 */
function projectEstimate(data) {
  const d = data && typeof data === 'object' ? data : {};
  const n = Number(d.est_tokens);
  const c = String(d.complexity || '').trim().toUpperCase();
  return {
    ok: !!d.ok,
    reason: d.ok ? '' : kbEstimateReason(d.reason),
    estTokens: Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 100000000) : 0,
    complexity: ['S', 'M', 'L'].includes(c) ? c : '',
    rationale: str(d.rationale, 300),
    model: str(d.model, 80),
  };
}

/**
 * 状态推进的英文拒绝原因 → 中文。CLI 对非法迁移回 409，detail 里带**具体哪个父任务**
 * 没完成（`Cannot move to 'ready': blocked by parent(s) not done — 'A' (t_x, status=todo)`），
 * 原样拍到界面上用户只会看到一串英文。命中不了的保留原文，别吞诊断。
 */
const STATUS_REASON = Object.freeze([
  [/blocked by parent\(s\) not done\s*—\s*(.+)$/i, (m) => `还有没做完的父任务：${m[1]}`],
  [/unsatisfied parent dependencies:\s*([^;]+);/i, (m) => `前置任务没完成：${m[1]}，先把它们做完或归档`],
  [/Cannot set status to 'running' directly/i, '运行中不能手动设置：它只能由调度器认领'],
  [/not valid from current state/i, '当前状态不允许这样改（先刷新看板，看看这张卡的实时状态）'],
  [/unknown status:\s*(\w+)/i, (m) => `CLI 不认识状态「${m[1]}」`],
  [/title cannot be empty/i, '标题不能为空'],
]);
function kbStatusReason(text) {
  const s = str(text, 300);
  if (!s) return '';
  for (const [re, zh] of STATUS_REASON) {
    const m = s.match(re);
    if (m) return zh(m);
  }
  return s;
}

function projectWorkers(data) {
  const raw = data && typeof data === 'object' ? data : {};
  return {
    workers: projectList(raw.workers, WORKER_FIELDS).slice(0, 60),
    count: Number.isFinite(raw.count) ? raw.count : (Array.isArray(raw.workers) ? raw.workers.length : 0),
    checkedAt: Number(raw.checked_at) || 0,
  };
}

/**
 * @param {() => {port:number, token:string, generation:number}} getBackendInfo
 *   由 main.js 注入的只读快照函数；每次请求现取，后端换代后自动用新端口/token。
 */
function createKanbanClient(getBackendInfo) {
  const info = () => {
    try { return getBackendInfo(); } catch { return null; }
  };
  // 派发是唯一会 spawn worker 的路径：同一客户端严格串行，杜绝双击拉起两批 agent。
  let dispatchBusy = false;
  async function read(op, params) {
    const path = buildPath(op, params);
    if (!path) return { ok: false, error: '非法的看板请求' };
    const snap = info();
    if (!validInfo(snap)) return { ok: false, error: '看板服务尚未就绪（桌面端后端未启动）' };
    // projectsTree 走 profiles 路由（/api/profiles/projects/tree），其余都在插件路由下
    return getJSON(snap, path, op === 'projectsTree' ? PROFILE_BASE : undefined);
  }
  async function write(op, method, params, body, timeoutMs) {
    const path = buildWritePath(op, params);
    if (!path) return { ok: false, error: '非法的看板写请求' };
    const snap = info();
    if (!validInfo(snap)) return { ok: false, error: '看板服务尚未就绪（桌面端后端未启动）' };
    // 每个白名单方法都必须显式分发：落到 default 会被当成 DELETE 发出去
    // （编排开关 PUT /orchestration 曾因此 404，看起来就是「切换没用」）。
    if (method === 'POST') return postJSON(snap, path, body, timeoutMs);
    if (method === 'PATCH') return patchJSON(snap, path, body);
    if (method === 'PUT') return putJSON(snap, path, body);
    return deleteJSON(snap, path);
  }

  return {
    /** 完整看板；也是轮询的轻量心跳（比对 latestEventId）。 */
    async board(opts = {}) {
      const o = opts && typeof opts === 'object' ? opts : {};
      const includeArchived = !!o.includeArchived;
      const r = await read('board', { ...o, includeArchived });
      if (!r.ok) return r;
      return { ok: true, generation: info().generation || 0, ...projectBoard(r.data, includeArchived) };
    },

    /** 单任务详情（评论 / 事件 / 依赖 / 运行记录），供侧边抽屉。 */
    async task(taskId, opts = {}) {
      if (!TASK_ID_RE.test(String(taskId || ''))) return { ok: false, error: '非法的任务 id' };
      const r = await read('task', { ...(opts || {}), taskId });
      if (!r.ok) return r;
      return { ok: true, generation: info().generation || 0, ...projectDetail(r.data) };
    },

    /** 一次运行记录（抽屉里点「查看运行」时按需取）。 */
    async run(runId, opts = {}) {
      if (!RUN_ID_RE.test(String(runId || ''))) return { ok: false, error: '非法的运行 id' };
      const r = await read('run', { ...(opts || {}), runId });
      if (!r.ok) return r;
      const raw = r.data && r.data.run ? r.data.run : r.data;
      return { ok: true, generation: info().generation || 0, run: project(raw, RUN_FIELDS) };
    },

    /** 首屏辅助数据：多看板、受让人、偏好、统计、诊断。组内并行，失败互不拖累。 */
    async overview(opts = {}) {
      const o = opts && typeof opts === 'object' ? opts : {};
      const keys = ['boards', 'projects', 'stats', 'assignees', 'config', 'diagnostics'];
      const results = await Promise.all(keys.map((k) => read(k, o)));
      const out = { ok: true, generation: info().generation || 0, partial: false };
      keys.forEach((k, i) => {
        const r = results[i];
        if (!r.ok) { out.partial = true; out[k] = null; return; }
        const d = r.data;
        switch (k) {
          // CLI 这几个端点是包了一层对象，不是裸数组；两种形态都兼容
          case 'boards': {
            const list = Array.isArray(d) ? d : (Array.isArray(d && d.boards) ? d.boards : []);
            out.boards = list.slice(0, 50).map((b) => safeObject(b));
            out.currentBoard = str(d && d.current, 80);
            break;
          }
          case 'projects': {
            const list = Array.isArray(d) ? d : (Array.isArray(d && d.projects) ? d.projects : []);
            out.projects = list.slice(0, 50).map((p) => {
              const o = p && typeof p === 'object' ? p : {};
              return {
                id: str(o.id, 80), slug: str(o.slug, 80), name: str(o.name, 120),
                primaryPath: str(o.primary_path, 300), icon: str(o.icon, 8), color: str(o.color, 16),
              };
            }).filter((x) => x.id);
            break;
          }
          case 'stats': {
            const s = d && typeof d === 'object' ? d : {};
            out.stats = {
              by_status: safeObject(s.by_status),
              by_assignee: safeObject(s.by_assignee),
              oldest_ready_age: Number.isFinite(s.oldest_ready_age) ? s.oldest_ready_age : null,
            };
            break;
          }
          case 'assignees': {
            const list = Array.isArray(d) ? d : (Array.isArray(d && d.assignees) ? d.assignees : []);
            out.assignees = list.slice(0, 100)
              .map((x) => (typeof x === 'string' ? str(x, 80) : str(x && x.name, 80))).filter(Boolean);
            // 受让人 = Hermes profile 名。on_disk 标记该名字在磁盘上真的有 profile 目录；
            // 只有真实 profile 才会被派发时 `hermes -p <受让人>` 拉起 worker，
            // 其余名字（历史遗留 / 控制面 lane）会被调度器记成 skipped_nonspawnable。
            out.profiles = list.slice(0, 100)
              .filter((x) => x && typeof x === 'object' && x.on_disk === true)
              .map((x) => str(x.name, 80)).filter(Boolean);
            break;
          }
          case 'config': out.config = safeObject(d); break;
          case 'diagnostics': {
            const list = Array.isArray(d) ? d : (Array.isArray(d && d.diagnostics) ? d.diagnostics : []);
            out.diagnostics = list.slice(0, MAX_ITEMS).map((x) => safeObject(x));
            break;
          }
          default: break;
        }
      });
      // 五项全失败才判整体失败，否则 UI 可以降级展示已有部分
      if (keys.every((k) => out[k] === null || out[k] === undefined)) {
        return { ok: false, error: '看板辅助数据读取失败' };
      }
      return out;
    },

    /** 新建任务。只支持 triage（默认、不派发）与 ready（可能被调度器认领）两种起始状态。 */
    async createTask(input = {}) {
      const body = cleanTaskInput(input);
      if (!body) return { ok: false, error: '任务参数不合法（标题或幂等键缺失）' };
      const r = await write('createTask', 'POST', { board: input.board }, body);
      if (!r.ok) return r;
      const raw = r.data && r.data.task;
      return {
        ok: true, generation: info().generation || 0,
        task: raw ? projectTask(raw, { full: true }) : null,
        warning: str(r.data && r.data.warning, 240),
      };
    },

    /** 新建看板。幂等（slug 冲突返回既有看板）；switch 恒不传，绝不动 current 指针。 */
    async createBoard(input = {}) {
      const body = cleanBoardInput(input);
      if (!body) return { ok: false, error: '看板标识不合法（需小写字母/数字/连字符）' };
      const r = await write('createBoard', 'POST', {}, body);
      if (!r.ok) return r;
      const b = r.data && r.data.board;
      return {
        ok: true, generation: info().generation || 0,
        board: b ? project(b, ['slug', 'name', 'description', 'icon', 'color', 'is_current']) : null,
        current: str(r.data && r.data.current, 80),
      };
    },

    /**
     * 给看板绑定 / 解绑项目（PATCH /boards/{slug}，body 只放行 project_id 一个键）。
     * 绑定后：项目 primary repo 成为看板 default_workdir，该板上的任务默认获得
     * 确定性 worktree（<repo>/.worktrees/<任务id>，分支 = slug + 任务 id）。
     * 建项目本身没有 REST 端点，只能走 CLI `hermes project create` —— 这里只做绑定。
     */
    async bindBoard(input = {}) {
      const o = input && typeof input === 'object' ? input : {};
      const body = cleanBoardBind(o);
      if (!body) return { ok: false, error: '项目标识不合法' };
      const r = await write('bindBoard', 'PATCH', { slug: String(o.slug || '') }, body);
      if (!r.ok) return r;
      const b = r.data && r.data.board && typeof r.data.board === 'object' ? r.data.board : {};
      return {
        ok: true, generation: info().generation || 0,
        board: safeObject(b),
        current: str(r.data && r.data.current, 80),
      };
    },

    /**
     * 拆解一张收集箱里的任务（POST /tasks/{id}/decompose）。
     *
     * 这是本模块**唯一会花 LLM 钱**的写路径：它调用 CLI 的 auxiliary.kanban_decomposer，
     * 让模型把任务拆成一棵子任务图并按 profile 描述路由。因此：
     *   - 必须显式 confirm === true 才发请求（渲染层要先过二次确认卡）；
     *   - 超时单独给 200s（CLI 侧上限 180s），常规 6s 预算会把它半路掐断；
     *   - CLI 的预期失败是 200 + ok:false，这里原样透出中文 reason 交给界面解释。
     * 不做任何自动重试：失败一次可能已经计过一次费。
     */
    async decomposeTask(taskId, opts = {}) {
      const id = String(taskId || '');
      if (!TASK_ID_RE.test(id)) return { ok: false, error: '非法的任务 id' };
      const o = opts && typeof opts === 'object' ? opts : {};
      if (o.confirm !== true) {
        return { ok: false, error: '拆解会调用辅助模型并产生费用，需要先确认' };
      }
      const r = await write('decompose', 'POST', { board: o.board, taskId: id }, {}, DECOMPOSE_TIMEOUT_MS);
      if (!r.ok) return r;
      return { ok: true, generation: info().generation || 0, ...projectDecompose(r.data) };
    },

    /**
     * 补规格：把收集箱里的一句话扩成可执行的 spec，并**由 CLI 顺手推进到 todo**
     * （`POST /tasks/{id}/specify`，CLI 侧 120s）。
     *
     * 和拆解一样会调辅助模型（`auxiliary.triage_specifier`）、一样只认 triage：
     *   - 必须显式 confirm === true 才发请求（渲染层先过一次确认卡）；
     *   - 独立 150s 预算，常规 6s 必掐断；
     *   - 预期失败是 HTTP 200 + ok:false，reason 走中文映射；
     *   - 不重试：失败一次可能已经计过一次费。
     * 注意它会改数据（title/body + status），成功必须回读看板。
     */
    async specifyTask(taskId, opts = {}) {
      const id = String(taskId || '');
      if (!TASK_ID_RE.test(id)) return { ok: false, error: '非法的任务 id' };
      const o = opts && typeof opts === 'object' ? opts : {};
      if (o.confirm !== true) {
        return { ok: false, error: '补规格会调用辅助模型并产生费用，需要先确认' };
      }
      const r = await write('specify', 'POST', { board: o.board, taskId: id }, {}, SPECIFY_TIMEOUT_MS);
      if (!r.ok) return { ok: false, error: kbSpecifyReason(r.error || '补规格没成功'), status: r.status };
      return { ok: true, generation: info().generation || 0, ...projectSpecify(r.data) };
    },

    /**
     * 估算工作量：`POST /tasks/{id}/estimate`，返回 token 量级 + S/M/L 复杂度。
     *
     * **不改任何数据**，纯查询，也是最便宜的一次辅助模型调用（CLI 侧 60s，
     * 300 max_tokens）。仍然要求 confirm：它会计费，界面上要先说清楚。
     */
    async estimateTask(taskId, opts = {}) {
      const id = String(taskId || '');
      if (!TASK_ID_RE.test(id)) return { ok: false, error: '非法的任务 id' };
      const o = opts && typeof opts === 'object' ? opts : {};
      if (o.confirm !== true) {
        return { ok: false, error: '估算会调用一次辅助模型并产生少量费用，需要先确认' };
      }
      const r = await write('estimate', 'POST', { board: o.board, taskId: id }, {}, ESTIMATE_TIMEOUT_MS);
      if (!r.ok) return { ok: false, error: kbEstimateReason(r.error || '估算没成功'), status: r.status };
      return { ok: true, generation: info().generation || 0, ...projectEstimate(r.data) };
    },

    /**
     * 添加评论（POST /tasks/{id}/comments）。追加文本：不过模型、不计费、不改状态，
     * CLI 对空白 body 回 400 "body is required"，这里在本地先做同一道校验，
     * 省一次往返；body / author 都过 cleanText（控制字符剥除 + 限长）。
     */
    async addComment(taskId, opts = {}) {
      const id = String(taskId || '');
      if (!TASK_ID_RE.test(id)) return { ok: false, error: '非法的任务 id' };
      const o = opts && typeof opts === 'object' ? opts : {};
      const body = cleanCommentInput({ body: o.body, author: o.author });
      if (!body) return { ok: false, error: '评论内容不能为空' };
      const r = await write('comment', 'POST', { board: o.board, taskId: id }, body);
      if (!r.ok) return r;
      return { ok: true, generation: info().generation || 0, taskId: id };
    },

    /** 删除任务（UI 侧必须先过二次确认卡）。CLI 会在有子任务等场景自行拒绝。 */
    async deleteTask(taskId, opts = {}) {
      if (!TASK_ID_RE.test(String(taskId || ''))) return { ok: false, error: '非法的任务 id' };
      const r = await write('deleteTask', 'DELETE', { ...(opts || {}), taskId }, null);
      if (!r.ok) return r;
      return { ok: true, generation: info().generation || 0, taskId: String(taskId) };
    },

    /** 提交派发：把任务推进到 ready。body 由服务层写死，渲染层只能传 id。 */
    async submitTask(taskId, opts = {}) {
      if (!TASK_ID_RE.test(String(taskId || ''))) return { ok: false, error: '非法的任务 id' };
      const r = await write('submitTask', 'PATCH', { ...(opts || {}), taskId }, { status: SUBMIT_STATUS });
      if (!r.ok) return r;
      const raw = r.data && r.data.task;
      return { ok: true, generation: info().generation || 0, task: raw ? projectTask(raw) : null };
    },

    /**
     * 人工拖列改状态（PATCH /tasks/{id}，body 只放 status）。
     *
     * 「把卡片从这一列拖到那一列」在 CLI 里是一个带语义的状态动词，不是裸 UPDATE：
     *   - ready：父任务没做完会被 409 拒（消息里点名是哪几个）；
     *   - blocked→ready / scheduled→ready：CLI 先 unblock_task 再放开；
     *   - review：request_review(force)，会顺带清掉执行者；
     *   - done：complete_task(force)，人类动作可以覆盖正在跑的 worker 的认领；
     *   - triage/todo：直接落库。
     * 因此这里只做「参数白名单 + 中文错误」，状态机本身一律交给 CLI，桌面端不复制规则。
     */
    async setTaskStatus(taskId, opts = {}) {
      const id = String(taskId || '');
      if (!TASK_ID_RE.test(id)) return { ok: false, error: '非法的任务 id' };
      const o = opts && typeof opts === 'object' ? opts : {};
      const status = String(o.status || '');
      if (status === 'running') {
        return { ok: false, error: '运行中不能手动设置：它只能由调度器认领，或用 reclaim 结束这次运行' };
      }
      if (!SET_STATUSES.includes(status)) return { ok: false, error: `不支持把任务改成「${status || '空'}」` };
      const body = { status };
      // 原因 / 结果摘要都是可选的人话：CLI 把它们写进 task_events，抽屉里能看到
      const reason = cleanText(o.reason, 200);
      if (reason && (status === 'blocked' || status === 'scheduled')) body.block_reason = reason;
      const summary = cleanText(o.summary, 500);
      if (summary && (status === 'done' || status === 'review')) body.summary = summary;
      const r = await write('setStatus', 'PATCH', { ...o, taskId: id }, body);
      if (!r.ok) return { ok: false, error: kbStatusReason(r.error || '状态没改成'), status };
      const raw = r.data && r.data.task;
      return { ok: true, generation: info().generation || 0, status, task: raw ? projectTask(raw) : null };
    },

    /**
     * 改派受让人 —— 「把卡片拖给某个 worker」的写入口。assignee 就是 Hermes profile
     * 名，派发时调度器用 `hermes -p <assignee>` 拉起 worker。可选同时推进到 ready
     * （CLI 原生支持一次 PATCH 里改派 + 改状态，不必拆两次请求）。
     * 空串 = 取消指派；其它状态一律拒绝，状态推进仍只放行 ready。
     */
    async reassignTask(taskId, opts = {}) {
      if (!TASK_ID_RE.test(String(taskId || ''))) return { ok: false, error: '非法的任务 id' };
      const o = opts && typeof opts === 'object' ? opts : {};
      const assignee = cleanAssignee(o.assignee);
      if (assignee === null) {
        return { ok: false, error: '受让人必须是合法的 profile 名（字母或数字开头，可含 . _ -）' };
      }
      const body = { assignee };
      if (o.status !== undefined && o.status !== null && o.status !== '') {
        if (!REASSIGN_STATUSES.includes(o.status)) return { ok: false, error: '只允许把任务推进到 ready' };
        body.status = o.status;
      }
      const r = await write('reassign', 'PATCH', { ...o, taskId }, body);
      if (!r.ok) return r;
      const raw = r.data && r.data.task;
      return {
        ok: true, generation: info().generation || 0, assignee,
        task: raw ? projectTask(raw) : null,
      };
    },

    /**
     * 只派发「这一张」卡片。
     *
     * CLI 的 dispatch tick 按 (priority DESC, created_at ASC) 取 ready 队首，
     * 所以直接真派发有可能先唤醒别人的卡片。这里两步走：
     *   ① dry_run 预演（纯读），确认目标就是本次 tick 的队首；
     *   ② 是 → 真派发 1 个名额；不是 → 一律不写库，把具体原因交回渲染层。
     * 返回 { dispatched:boolean, reason:string, blockedBy?, preview }。
     */
    async dispatchTask(taskId, opts = {}) {
      const id = String(taskId || '');
      if (!TASK_ID_RE.test(id)) return { ok: false, error: '非法的任务 id' };
      if (dispatchBusy) return { ok: false, error: '已有派发在进行中，请稍候再试' };
      const o = opts && typeof opts === 'object' ? opts : {};
      dispatchBusy = true;
      try {
        const preview = await write('dispatch', 'POST', { board: o.board, dryRun: true, max: 1 }, null);
        if (!preview.ok) return preview;
        const pv = projectDispatch(preview.data);
        const head = pv.spawned[0];
        const block = (reason, extra = {}) => ({
          ok: true, generation: info().generation || 0, dispatched: false, reason, preview: pv, ...extra,
        });
        if (!head || head.taskId !== id) {
          // 逐项对照调度器给出的跳过理由，把「为什么不是它」讲清楚，不要含糊其词
          if (pv.lists.skipped_unassigned.includes(id)) {
            return block('这张卡片没有受让人，调度器不会派发它。');
          }
          if (pv.lists.skipped_nonspawnable.includes(id)) {
            return block('受让人不是磁盘上的 Hermes profile，调度器会跳过它。');
          }
          if (pv.respawnGuarded.some((x) => x.taskId === id)) {
            return block('这张卡片刚失败过，调度器还处在重生保护冷却期。');
          }
          const capped = pv.skippedPerProfile.find((x) => x.taskId === id);
          if (capped) {
            return block(`受让人 ${capped.assignee} 已达每 profile 并发上限（在跑 ${capped.current}）。`);
          }
          if (pv.counts.skipped_locked) return block('另一个派发器正持锁执行 tick，稍后重试即可。');
          if (pv.counts.memory_pressure) return block('系统内存压力偏高，调度器本次限流，没有启动 worker。');
          if (head) {
            return block(
              `调度器本次会先派发更早的 ${head.taskId}（同一队列按优先级与创建时间排队），`
              + '这张卡片要等下一次 tick 才会轮到。',
              { blockedBy: head.taskId },
            );
          }
          return block('调度器本次没有选中任何卡片：确认它在 ready、受让人是磁盘上真实存在的 profile。');
        }
        // 队首就是它 → 真派发，只买 1 个名额，避免顺带唤醒别的卡片
        const real = await write('dispatch', 'POST', { board: o.board, dryRun: false, max: 1 }, null);
        if (!real.ok) return real;
        const rr = projectDispatch(real.data);
        const hit = rr.spawned.some((x) => x.taskId === id);
        return {
          ok: true, generation: info().generation || 0, ...rr, preview: pv,
          dispatched: hit,
          reason: hit ? '' : '派发请求已下发，但调度器本次没有启动这张卡片的 worker（可能被并发或额度限制拦截）。',
        };
      } finally {
        dispatchBusy = false;
      }
    },

    /**
     * 一次 dispatcher tick。dryRun 缺省 true（纯预览，不 spawn）；只有显式 false
     * 才会真正唤醒 agent worker，UI 必须先过二次确认卡。并发请求直接拒绝。
     */
    async dispatch(opts = {}) {
      const o = opts && typeof opts === 'object' ? opts : {};
      if (dispatchBusy) return { ok: false, error: '已有派发在进行中，请稍候再试' };
      dispatchBusy = true;
      const dryRun = o.dryRun !== false;
      try {
        const r = await write('dispatch', 'POST', { board: o.board, dryRun, max: o.max }, null);
        if (!r.ok) return r;
        return { ok: true, generation: info().generation || 0, dryRun, ...projectDispatch(r.data) };
      } finally {
        dispatchBusy = false;
      }
    },

    /** 当前在跑的 worker（投影掉 PID / claim_lock / 心跳等本机内部字段）。 */
    async activeWorkers(opts = {}) {
      const r = await read('workers', opts || {});
      if (!r.ok) return r;
      return { ok: true, generation: info().generation || 0, ...projectWorkers(r.data) };
    },

    /**
     * 侧栏项目树（GET /api/profiles/projects/tree）：项目 → 泳道 → 会话。
     * previewSessions 是每项目最近几条会话（hydrate=False 时 lane 行为空），
     * sessionIds 是该项目认领的全部会话 id —— 侧栏用它把已归组会话从时间分组里排除。
     */
    async projectsTree(opts = {}) {
      const r = await read('projectsTree', { ...(opts || {}), previewLimit: opts && opts.previewLimit });
      if (!r.ok) return r;
      return { ok: true, generation: info().generation || 0, ...projectTree(r.data) };
    },

    /**
     * 编排开关（config.yaml 的 `kanban` 段）—— 设置页「看板编排」的数据源之一。
     * 只管 auto_decompose / auto_promote_children / 两个 profile；
     * `dispatch_in_gateway` 不在这个端点里，由 hermes-config 读原文补上。
     */
    async orchestration() {
      const r = await read('orchestration', {});
      if (!r.ok) return r;
      return { ok: true, generation: info().generation || 0, ...projectOrchestration(r.data) };
    },

    /** 写编排开关：只写显式传入的字段，其余不动；返回 CLI 回读后的生效值。 */
    async setOrchestration(input = {}) {
      const body = cleanOrchestration(input);
      if (!body) return { ok: false, error: '编排参数不合法（只接受布尔与已存在的 profile 名）' };
      const r = await write('orchestration', 'PUT', {}, body);
      if (!r.ok) return r;
      return { ok: true, generation: info().generation || 0, ...projectOrchestration(r.data) };
    },
  };
}

module.exports = {
  createKanbanClient, buildPath, buildWritePath, validInfo,
  cleanTaskInput, cleanBoardInput, cleanBoardBind, cleanAssignee, clampMaxSpawn, cleanOrchestration,
  projectBoard, projectDetail, projectTask, projectDispatch, projectWorkers, projectOrchestration,
  projectTree, projectTreeRow,
  COLUMNS, ALL_COLUMNS, PLUGIN_BASE, PROFILE_BASE, SUBMIT_STATUS, DISPATCH_MAX_SPAWN,
  TASK_ID_RE, BOARD_RE, RUN_ID_RE, IDEMPOTENCY_RE, ASSIGNEE_RE, PROJECT_RE,
  CREATE_STATUSES, REASSIGN_STATUSES, SET_STATUSES, ORCHESTRATION_KEYS,
  kbStatusReason, kbSpecifyReason, kbEstimateReason, SPECIFY_TIMEOUT_MS, ESTIMATE_TIMEOUT_MS,
};
