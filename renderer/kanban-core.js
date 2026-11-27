'use strict';
/* ═══════════ Hermes Desktop Client — Kanban 看板 / 项目弹窗 ═══════════ */
/* global $, esc, arr, clip, safeStringify, safeGet, safeSet, fmtTokens, uid, a11y, state, api, hasNative, toast, showConfirm, closeSubpages, syncInert, pushFocus, popFocus, openSession, refreshSessions, renderTabs, newTab, renderChat, applySettings, syncModelDrift, refreshProfileChip, doSwitchProfile */

/* ══════════════════ Kanban 看板（CLI 原生任务队列） ══════════════════
   读走主进程转发的 /api/plugins/kanban/* REST，渲染层拿不到端口与 token。
   写只有八条白名单：新建任务 / 新建看板 / 删除任务 / 提交派发(→ready) /
   改派 / 派发一次(dispatch tick) / 编排开关(PUT) / 看板绑项目，都带严格
   参数校验与写后回读。派发是唯一会唤醒 agent 的路径：主进程默认 dry-run、
   单次上限 4、串行执行；渲染层必须先过二次确认卡。
   decompose / specify / estimate / bulk 等会花钱的操作不做。
   默认「分组网格」视图，空状态不占列；可切经典列视图。
   所有异步响应都带代次戳（KB.epoch / KB.detailEpoch / KB.dispatch.epoch），
   切页或后端换代后的旧响应一律丢弃，不写 DOM。 */
/* ---- 状态归组：9 个 CLI 状态 → 5 个中文列 ----
   归组只影响「看」的粒度，不改任何状态：卡片上的细 chip 仍是 CLI 原值。
   ① scheduled 归「待办」而不是「受阻」：受阻是等人（需要人动手），scheduled 是
     等时间（不需要人动手），塞进同一列会把「受阻」计数顶高，把人叫去处理本来
     不该碰的任务。
   ② archived 不进 5 列：它由「显示已归档」开关单独控制，打开时追加为最后一列，
     否则「已完成」的计数会跟着归档一起虚高，两套开关还会互相打架。 */
const KB_GROUPS = Object.freeze([
  { key: 'todo', label: '待办', statuses: ['triage', 'todo', 'scheduled'], dot: 'yellow',
    hint: '还没开始跑：收集箱、等依赖，或已排期在等时间' },
  { key: 'ready', label: '就绪', statuses: ['ready'], dot: 'accent',
    hint: '依赖满足且已指派，调度器随时可能认领派发' },
  { key: 'running', label: '进行中', statuses: ['running', 'review'], dot: 'green',
    hint: 'worker 正在执行，或已跑完待验收' },
  { key: 'blocked', label: '受阻', statuses: ['blocked'], dot: 'red',
    hint: '需要人工介入：等人确认或等外部事件' },
  { key: 'done', label: '已完成', statuses: ['done'], dot: 'muted',
    hint: '已完成，不再参与派发' },
]);
const KB_GROUP_ARCHIVED = Object.freeze({
  key: 'archived', label: '已归档', statuses: ['archived'], dot: 'muted',
  hint: '已归档，只在开启「显示已归档」时出现',
});
/** 细粒度状态的中文短名：卡片 chip 用它，title 里保留 CLI 原值。 */
const KB_STATUS_LABEL = Object.freeze({
  triage: '收集箱', todo: '待办', scheduled: '已排期', ready: '就绪',
  running: '运行中', blocked: '受阻', review: '待验收', done: '已完成', archived: '已归档',
});
/** 允许拖拽改派的状态。running 要先 reclaim 才能换人，done / archived 再派发没有意义。 */
const KB_DRAGGABLE = Object.freeze(['triage', 'todo', 'scheduled', 'ready', 'blocked', 'review']);
/** 拖拽源比改派宽两档：running 要能拖出去（卡在运行中的任务很常见，得能强制收尾），
 *  done 要能拖回去重开（reopen）；archived 不给拖 —— CLI 侧归档单向，误拖没有回退口。
 *  注意 running 只在**拖列**里放行：拖到 profile chip 上仍按改派处理并被拒。 */
const KB_DRAG_SOURCE = Object.freeze([...KB_DRAGGABLE, 'running', 'done']);
/** 列 → 落地状态。这 5 个都是 CLI 认的状态动词（PATCH /tasks/{id} 的 status）：
 *  「进行中」列落 review —— 人不能把任务直接设成 running（只能调度器认领），
 *  能做的只有「提交待验收」，语义上也正好落在这一列。 */
const KB_GROUP_STATUS = Object.freeze({
  todo: 'todo', ready: 'ready', running: 'review', blocked: 'blocked', done: 'done',
});
/** 松手提示与 toast 共用的动作文案。 */
const KB_STATUS_ACTION = Object.freeze({
  todo: '放回待办', ready: '提到就绪', review: '提交待验收', blocked: '标记受阻', done: '标记完成',
});
/** 渲染层能请求的落地状态集合（= 上表的取值），拖拽入口据此做最后一道校验。 */
const KB_STATUS_SETTABLE = Object.freeze(Object.values(KB_GROUP_STATUS));
/** 卡住提示阈值（秒）：就绪 > 30m、受阻 > 1d、待验收 > 1d 在卡面时间旁标「已等 X」。 */
const KB_STUCK_THRESHOLDS = Object.freeze({
  ready: 30 * 60,
  blocked: 86400,
  review: 86400,
});
const KB_SORT_MODES = Object.freeze(['default', 'priority', 'updated', 'created']);
const KB_PREFS_KEY = 'kb-prefs';
/** 指针拖拽的共享状态（一次只有一个拖动中的卡片）。 */
const KbDrag = {
  armed: false, on: false, id: '', title: '', status: '',
  x0: 0, y0: 0, card: null, ghost: null, target: null, col: null, suppressClick: false,
  gh: 0, vel: 0, raf: 0,
};
const KB = {
  epoch: 0, detailEpoch: 0, timer: null, busy: false,
  board: null, overview: null, detail: null, detailId: '',
  lastEventId: 0, error: '',
  // 默认列视图：5 组固定成列，一屏看清全貌；网格视图留给窄主区（⋯ 菜单里切）
  view: 'cols', sort: 'default', status: '', collapsed: new Set(), focusId: '', _prefsScope: '',
  modal: '', modalKey: '', modalBusy: false,
  dispatch: { open: false, busy: false, epoch: 0 },
  // 拆解会调用辅助模型（计费、最长 3 分钟）：全局只允许一次在途，防重复计费
  decomposeBusy: false,
  // 补规格同样是计费 + 改数据（会把卡推出收集箱），一次只跑一个
  specifyBusy: false,
  // 估算只读、最便宜，但也要防连点；结果按 taskId 缓存，重开抽屉不用再算一遍
  estimateBusy: false, estimate: {},
  filters: { q: '', assignee: '', tenant: '', archived: false, board: '' },
  // 页头那枚只读模式标记的数据（null = 还没读到 / 读不到，此时不显示）
  mode: null,
  // 官方 project-dialog 的本地等价状态：一次选择可以带回多个文件夹，第一个为主；
  // projectDialog 记录 create / rename / add-folder 三种模式共用的目标项目。
  projFolders: [], projectDialog: null, delProject: null,
};
let kbSelectSig = '';

function kbSec(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n) : Math.round(n / 1000);
}
function kbTaskUpdatedAt(t) {
  if (!t || typeof t !== 'object') return 0;
  return Math.max(
    kbSec(t.updated_at),
    kbSec(t.completed_at),
    kbSec(t.current_run_started_at),
    kbSec(t.started_at),
    kbSec(t.created_at)
  );
}
function kbSortTasks(list) {
  const arrList = Array.isArray(list) ? list : [];
  if (KB.sort === 'default' || arrList.length < 2) return arrList.slice();
  return arrList.map((t, i) => ({ t, i })).sort((a, b) => {
    if (KB.sort === 'priority') {
      return (Number(b.t.priority) || 0) - (Number(a.t.priority) || 0)
        || kbSec(b.t.created_at) - kbSec(a.t.created_at)
        || a.i - b.i;
    }
    if (KB.sort === 'updated') {
      return kbTaskUpdatedAt(b.t) - kbTaskUpdatedAt(a.t)
        || (Number(b.t.priority) || 0) - (Number(a.t.priority) || 0)
        || a.i - b.i;
    }
    if (KB.sort === 'created') {
      return kbSec(b.t.created_at) - kbSec(a.t.created_at)
        || (Number(b.t.priority) || 0) - (Number(a.t.priority) || 0)
        || a.i - b.i;
    }
    return a.i - b.i;
  }).map((x) => x.t);
}
/** 先转义再包裹 <mark>，避免命中 HTML 实体或引入 XSS。 */
function kbHighlight(raw, query) {
  const text = String(raw || '');
  const q = String(query || '').trim();
  if (!q) return esc(text);
  const needle = q.toLowerCase();
  const hay = text.toLowerCase();
  let idx = hay.indexOf(needle, 0);
  if (idx < 0) return esc(text);
  let out = '';
  let pos = 0;
  while (idx >= 0) {
    if (idx > pos) out += esc(text.slice(pos, idx));
    out += '<mark class="kb-mark">' + esc(text.slice(idx, idx + needle.length)) + '</mark>';
    pos = idx + needle.length;
    idx = hay.indexOf(needle, pos);
  }
  if (pos < text.length) out += esc(text.slice(pos));
  return out;
}
function kbStuckInfo(t, st, nowSec) {
  const limit = KB_STUCK_THRESHOLDS[st];
  if (!limit || !t) return null;
  const ref = Math.max(kbSec(t.updated_at), kbSec(t.started_at), kbSec(t.created_at));
  if (!ref) return null;
  const now = nowSec || Math.floor(Date.now() / 1000);
  const wait = Math.max(0, now - ref);
  if (wait < limit) return null;
  const dur = kbAge(wait);
  return {
    wait,
    label: `已等 ${dur}`,
    title: `${KB_STATUS_LABEL[st] || st}已等待 ${dur}（超过 ${kbAge(limit)} 阈值）`,
  };
}
function kbCurrentProfile() {
  try {
    if (typeof pfSnapshot === 'object' && pfSnapshot && pfSnapshot.current) return String(pfSnapshot.current);
  } catch {}
  const el = $('#pf-name');
  return (el && el.textContent ? el.textContent.trim() : '') || 'default';
}
function kbPrefScope() {
  const prof = kbCurrentProfile();
  const board = String(KB.filters.board || (KB.overview && KB.overview.currentBoard) || 'default');
  return `${prof}::${board}`;
}
function kbReadAllPrefs() {
  try {
    const parsed = JSON.parse(safeGet(KB_PREFS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function kbValidGroupKey(k) {
  return KB_GROUPS.some((g) => g.key === k) || k === KB_GROUP_ARCHIVED.key;
}
function kbLoadPrefs(force) {
  const scope = kbPrefScope();
  if (!force && KB._prefsScope === scope) return;
  KB._prefsScope = scope;
  const all = kbReadAllPrefs();
  const p = all[scope] && typeof all[scope] === 'object' ? all[scope] : {};
  KB.view = p.view === 'grid' ? 'grid' : 'cols';
  KB.sort = KB_SORT_MODES.includes(p.sort) ? p.sort : 'default';
  KB.status = kbValidGroupKey(p.status) ? p.status : '';
  KB.filters.assignee = typeof p.assignee === 'string' && p.assignee.length <= 64 ? p.assignee : '';
  const colList = Array.isArray(p.collapsed) ? p.collapsed.filter(kbValidGroupKey) : [];
  KB.collapsed = new Set(colList);
  const asgEl = $('#kb-assignee');
  if (asgEl) asgEl.value = KB.filters.assignee;
  kbMoreSync();
}
function kbSavePrefs() {
  const scope = kbPrefScope();
  KB._prefsScope = scope;
  const all = kbReadAllPrefs();
  all[scope] = {
    view: KB.view === 'grid' ? 'grid' : 'cols',
    sort: KB_SORT_MODES.includes(KB.sort) ? KB.sort : 'default',
    status: KB.status || '',
    assignee: KB.filters.assignee || '',
    collapsed: [...KB.collapsed].filter(kbValidGroupKey),
  };
  safeSet(KB_PREFS_KEY, JSON.stringify(all));
}

/* 看板 API 的取用口。不再用 hasNative 拦：Demo 模式的 mock-bridge 已经实现了
   全部看板方法与演示数据，能不能用应该按「这个桥有没有 kanbanBoard」判断，
   否则浏览器预览一打开就是「Demo 模式没有本地看板数据」。 */
const kbApi = () => (api && typeof api.kanbanBoard === 'function' ? api : null);
function kbParams() {
  const f = KB.filters;
  const p = { includeArchived: !!f.archived };
  if (f.board) p.board = f.board;
  if (f.tenant) p.tenant = f.tenant;
  return p;
}
function kbTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n < 1e12 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function kbAgo(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - (n < 1e12 ? n : n / 1000)));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  return Math.floor(sec / 86400) + ' 天前';
}
function kbFullTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n < 1e12 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
/* ---- 运行进度：running 卡片 / 抽屉共用的同一套计时口径 ----
   CLI 的 task 行本身给了 current_run_started_at 与 max_runtime_seconds，进度不需要
   另开接口：卡片和抽屉都只读这两个字段，本地每秒推一次秒表，事件驱动的轮询再补
   文字更新（最近活动 / 最新回报 / 子任务）。时间戳兼容秒与毫秒两种量级。 */
let kbRunTimer = null;
function kbRunStart(t) {
  const n = Number(t && (t.current_run_started_at || t.started_at));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n) : Math.round(n / 1000);
}
function kbRunLimit(t) {
  const n = Number(t && t.max_runtime_seconds);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}
/** 秒 → 3:21 / 1:02:03。进度条与时钟都按这个格式，避免一处 201s、一处 3m21s。 */
function kbDur(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const p2 = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${p2(m)}:${p2(s % 60)}` : `${m}:${p2(s % 60)}`;
}
function kbRunElapsed(start, now) {
  return Math.max(0, Math.floor((Number(now) || Math.floor(Date.now() / 1000)) - start));
}
/** 预算占用百分比：给进度条用，恒落在 1.5%–100%，剩 0 秒时也不会缩成看不见。 */
function kbRunPct(elapsed, limit) {
  if (!limit) return 0;
  return Math.min(100, Math.max(1.5, (elapsed / limit) * 100));
}
function kbRunClockText(elapsed, limit) {
  return '◷ ' + kbDur(elapsed) + (limit ? ' / ' + kbDur(limit) : '');
}
/** 每秒推进所有 [data-kb-run]：卡片秒表、抽屉面板、rail chip 共用一份实现。
 *  不可见的节点（rail 收起 / 整页切走）跳过；一个可见的都没有就自停，不空转。 */
function kbRunTick() {
  const nodes = [...document.querySelectorAll('[data-kb-run]')]
    .filter((el) => el.getClientRects().length > 0);
  if (!nodes.length) {
    if (kbRunTimer) { clearInterval(kbRunTimer); kbRunTimer = null; }
    return 0;
  }
  const now = Math.floor(Date.now() / 1000);
  for (const el of nodes) {
    const start = Number(el.dataset.kbRun) || 0;
    if (!start) continue;
    const limit = Number(el.dataset.kbRunMax) || 0;
    const elapsed = kbRunElapsed(start, now);
    const txt = el.querySelector('.kb-run-txt');
    if (txt) txt.textContent = kbRunClockText(elapsed, limit);
    const bar = el.querySelector('.kb-run-bar > i');
    if (bar && limit) bar.style.width = kbRunPct(elapsed, limit).toFixed(1) + '%';
    // 用掉 85% 预算就转红：超时前给一次视觉预警，比事后看 timed_out 有用
    el.classList.toggle('is-hot', !!limit && elapsed / limit >= 0.85);
  }
  return nodes.length;
}
function kbRunWatch() {
  kbRunTick();
  if (!kbRunTimer) kbRunTimer = setInterval(kbRunTick, 1000);
}
/** 卡面上的运行条：跑了多久 / 预算用掉多少。没有预算就只显示秒表。 */
function kbRunStrip(t) {
  const start = kbRunStart(t);
  if (!start) return '';
  const limit = kbRunLimit(t);
  const elapsed = kbRunElapsed(start);
  const hot = limit && elapsed / limit >= 0.85;
  return `<div class="kb-run${hot ? ' is-hot' : ''}" data-kb-run="${start}" data-kb-run-max="${limit}">
      <span class="kb-run-txt">${esc(kbRunClockText(elapsed, limit))}</span>
      ${limit ? `<span class="kb-run-bar"><i style="width:${kbRunPct(elapsed, limit).toFixed(1)}%"></i></span>` : ''}
    </div>`;
}
/** 同一个 profile 名下还在跑的其它卡：从看板里找，不额外打接口。 */
function kbRunSiblings(t) {
  const who = String((t && t.assignee) || '').trim();
  if (!who) return [];
  const cols = (KB.board && Array.isArray(KB.board.columns)) ? KB.board.columns : [];
  const out = [];
  for (const c of cols) {
    for (const x of (Array.isArray(c && c.tasks) ? c.tasks : [])) {
      if (!x || x.id === t.id) continue;
      if (String(x.status || (c && c.name) || '') !== 'running') continue;
      if (String(x.assignee || '').trim() !== who) continue;
      out.push(x);
    }
  }
  return out.slice(0, 3);
}
function kbSetLive(text, cls) {
  const el = $('#kb-live'), t = $('#kb-live-text');
  if (!el || !t) return;
  t.textContent = text;
  el.classList.toggle('on', cls === 'on');
  el.classList.toggle('err', cls === 'err');
}
function kanbanStopPolling() { if (KB.timer) { clearInterval(KB.timer); KB.timer = null; } }
function kanbanStartPolling() {
  kanbanStopPolling();
  KB.timer = setInterval(async () => {
    // 整页或 rail 看板任一可见就继续同步；两个都收起时停表，不空转打 REST
    if (!kanbanAnyVisible()) { kanbanStopPolling(); return; }
    if (document.hidden || KB.busy || KbDrag.on) return;
    const a = kbApi();
    if (!a || !a.kanbanBoard) return;
    const my = KB.epoch;
    try {
      const r = await a.kanbanBoard(kbParams());
      if (my !== KB.epoch || !kanbanAnyVisible()) return;
      if (!r || !r.ok) { kbSetLive((r && r.error) || '同步失败', 'err'); return; }
      const ev = Number(r.latestEventId) || 0;
      const genChanged = KB.board && r.generation !== KB.board.generation;
      if (ev !== KB.lastEventId || genChanged || KB.error) {
        KB.board = r; KB.lastEventId = ev; KB.error = '';
        renderKanban();
        // 抽屉打开时顺带刷新当前任务，让评论 / 事件跟着走
        if (!$('#kb-drawer').hidden && KB.detailId) openKanbanTask(KB.detailId, true);
        // 派发控制台打开时，事件游标变化顺带同步活跃 worker
        if (KB.dispatch.open) kbDispatchLoadWorkers();
      }
      kbSetLive('实时同步', 'on');
    } catch { if (my === KB.epoch) kbSetLive('同步失败', 'err'); }
  }, 5000);
}

async function kanbanLoad(initial) {
  const a = kbApi();
  const my = ++KB.epoch;
  KB.busy = true;
  kbSetLive('读取中…', '');
  if (!a || !a.kanbanBoard || !a.kanbanOverview) {
    KB.error = '看板接口不可用：当前运行环境没有暴露 kanbanBoard（桌面端请确认后端已启动）';
    KB.busy = false;
    if (my === KB.epoch) { renderKanban(); kbSetLive('不可用', 'err'); }
    return;
  }
  try {
    const p = kbParams();
    const [b, o] = await Promise.all([
      a.kanbanBoard(p),
      initial ? a.kanbanOverview({ board: KB.filters.board || undefined }).catch(() => null) : Promise.resolve(null),
    ]);
    if (my !== KB.epoch) return;
    if (b && b.ok) {
      KB.board = b; KB.lastEventId = Number(b.latestEventId) || 0; KB.error = '';
    } else {
      KB.error = (b && b.error) || '看板读取失败';
    }
    if (o && o.ok) {
      KB.overview = o;
      if (kbPrefScope() !== KB._prefsScope) kbLoadPrefs();
    }
  } catch (e) {
    if (my === KB.epoch) KB.error = (e && e.message) || '看板读取失败';
  } finally {
    if (my === KB.epoch) {
      KB.busy = false;
      renderKanban();
      kbSetLive(KB.error ? '读取失败' : '实时同步', KB.error ? 'err' : 'on');
    }
  }
}

/* ---- 「⋯」菜单：新建看板 / 手动派发 / 切换视图 / 显示已归档 / 排序 ----
   这几个都是低频入口，放常驻按钮会把首屏挤掉；菜单只是一个 absolute 面板，
   不新增通道、不改任何写路径。 */
function kbMoreToggle(open) {
  const btn = $('#kb-more'), menu = $('#kb-more-menu');
  const on = !!open;
  if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  if (menu) menu.hidden = !on;
  if (on) kbMoreSync();
}
/** 视图项文字与排序选项状态跟着当前状态走。 */
function kbMoreSync() {
  const item = document.querySelector('#kb-more-menu [data-kb-more="view"]');
  if (item) item.textContent = KB.view === 'grid' ? '切换到列视图' : '切换到网格视图';
  document.querySelectorAll('#kb-more-menu [data-kb-sort]').forEach((el) => {
    const active = el.getAttribute('data-kb-sort') === KB.sort;
    el.classList.toggle('on', active);
    el.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}
function showKanban(force) {
  const page = $('#kanban-page');
  if (!page) return;
  if (!page.hidden && !force) { closeKanbanPage(); return; }
  // 与其它整页互斥；gateway 有专用关闭函数，其余直接 hidden（不触发各自的数据加载）
  document.querySelectorAll('.subpage').forEach((pg) => {
    if (pg === page) return;
    if (pg.id === 'gateway-page') { try { closeGatewayPage(); } catch {} }
    else pg.hidden = true;
  });
  try { toggleSettings(false); } catch {}
  try { togglePalette(false); } catch {}
  page.hidden = false;
  kbLoadPrefs();
  closeKanbanDrawer();
  kanbanLoad(true);
  kbLoadMode();
  kanbanStartPolling();
}
function closeKanbanPage() {
  const page = $('#kanban-page');
  if (!page) return;
  if (KB.modal) kbModalClose();
  kbMoreToggle(false);
  kbDispatchToggle(false);
  kbDragReset();
  kbDockMsg('', '');
  const dockCard = $('#kb-dock-confirm');
  if (dockCard) dockCard.innerHTML = '';
  page.hidden = true;
  closeKanbanDrawer();
  if (railKanbanVisible()) {
    renderRailKanban(); // rail 还在看：保留轮询，也别作废在途响应
  } else {
    kanbanStopPolling();
    KB.epoch += 1; // 作废所有在途响应
  }
  KB.detailEpoch += 1;
}

function kbFillSelect(sel, items, current, placeholder) {
  const el = $(sel);
  if (!el) return;
  // 候选文本由组件走 textContent 落地；CLI 返回值里出现标签也不会被当成 HTML
  el.setOptions(items, placeholder);
  el.value = items.some((it) => it.value === current) ? current : '';
}
function kbSyncSelects() {
  const b = KB.board, o = KB.overview || {};
  const boards = (Array.isArray(o.boards) ? o.boards : []).map((x) => ({
    value: String(x.slug || x.name || ''),
    label: String(x.name || x.slug || '') + (Number(x.total) ? ` (${Number(x.total)})` : ''),
  })).filter((x) => x.value);
  const assignees = [...new Set([...(Array.isArray(b?.assignees) ? b.assignees : []),
    ...(Array.isArray(o.assignees) ? o.assignees : [])])].map((x) => ({ value: String(x), label: String(x) }));
  const tenants = (Array.isArray(b?.tenants) ? b.tenants : []).map((x) => ({ value: String(x), label: String(x) }));
  // 可见性每次都算，不受下面的 sig 缓存影响：
  //  - 只有一个看板时「筛看板」没有意义（选它和不选一样）
  //  - 租户 / 受让人一个值都没有时，下拉里只剩占位项
  kbToggleField('#kb-board', boards.length > 1);
  kbToggleField('#kb-assignee', assignees.length > 0);
  kbToggleField('#kb-tenant', tenants.length > 0);
  // 藏起来之前先把对应的筛选清掉，否则会出现「看不见的筛选还在生效」
  if (boards.length <= 1 && KB.filters.board) KB.filters.board = '';
  if (b && !assignees.some((x) => x.value === KB.filters.assignee) && KB.filters.assignee) KB.filters.assignee = '';
  if (!tenants.length && KB.filters.tenant) KB.filters.tenant = '';
  const sig = JSON.stringify([boards, assignees, tenants]);
  const ph = o.currentBoard || '当前看板';
  if (sig !== kbSelectSig) {
    kbSelectSig = sig;
    // 占位项（空值）本身就代表当前看板，候选里必须把当前看板剔除，
    // 否则会出现「当前看板 (default)」+「default (9)」两行指向同一个看板的怪相
    const cur = String(o.currentBoard || '');
    kbFillSelect('#kb-board', cur ? boards.filter((x) => x.value !== cur) : boards, KB.filters.board, ph);
    kbFillSelect('#kb-assignee', assignees, KB.filters.assignee, '全部受让人');
    kbFillSelect('#kb-tenant', tenants, KB.filters.tenant, '全部租户');
  } else {
    const asgEl = $('#kb-assignee');
    if (asgEl && asgEl.value !== KB.filters.assignee) asgEl.value = KB.filters.assignee;
  }
  // 新建弹窗里的目标看板不随筛选联动，但列表要跟着 overview 更新
  // （当前看板用空值选项表示，别在列表里再重复一份）
  const fb = $('#kb-f-board');
  if (fb) {
    // 只有一个看板时「目标看板」没得选（选项里也刻意排除了当前看板），收起整行
    kbToggleField('#kb-f-board', boards.length > 1);
    const keep = fb.value;
    const cur = String(o.currentBoard || '');
    kbFillSelect('#kb-f-board', cur ? boards.filter((x) => x.value !== cur) : boards, keep,
      cur ? `当前看板 (${cur})` : '当前看板');
  }
  kbSyncProjectSelects();
  // 受让人 = Hermes profile 名：把磁盘上真实存在的 profile 做成候选，避免手打错名字
  // 受让人 = Hermes profile 名。改成自绘下拉，候选就是磁盘上真实存在的
  // profile；「留空则不指派」作为占位项，避免手打错名字导致派发器拉不起 worker。
  const profiles = [...kbProfileSet()].sort();
  const ap = $('#kb-f-assignee');
  if (ap) ap.setOptions(profiles.map((n) => ({ value: n, label: n })), '留空则不指派');
  kbSyncAssigneeHint();
}

/** 项目候选（命名工作空间，决定任务的执行工作区）。
 *  空值选项 = 继承看板绑定：看板绑了项目 → 任务自动获得确定性 git worktree；
 *  没绑 → worker 在一次性 scratch 沙箱里跑。 */
function kbProjectOptions() {
  const o = KB.overview || {};
  const projects = Array.isArray(o.projects) ? o.projects : [];
  return projects.map((p) => ({
    value: String((p && (p.id || p.slug)) || ''),
    label: String((p && (p.name || p.slug)) || '')
      + (p && p.slug && p.name && p.slug !== p.name ? ` (${p.slug})` : ''),
  })).filter((x) => x.value);
}
/** 当前看板的绑定信息：{slug, projectId, projectName}，读不到时全空。 */
function kbCurrentBoardMeta() {
  const o = KB.overview || {};
  const slug = String(KB.filters.board || o.currentBoard || '');
  const b = (Array.isArray(o.boards) ? o.boards : [])
    .find((x) => String((x && x.slug) || '') === slug) || null;
  return {
    slug,
    projectId: b ? String(b.project_id || '') : '',
    projectName: b ? String(b.project_name || '') : '',
  };
}
function kbSyncProjectSelects() {
  const o = KB.overview || {};
  const projects = Array.isArray(o.projects) ? o.projects : [];
  const opts = kbProjectOptions();
  const meta = kbCurrentBoardMeta();
  // 新建任务弹窗：没有任何项目且看板也没绑项目时，这个字段选什么都一样，收起整行
  const fproj = $('#kb-f-project');
  if (fproj) {
    kbToggleField('#kb-f-project-row', projects.length > 0 || !!meta.projectId);
    const keep = fproj.value;
    const ph = meta.projectName
      ? `继承看板项目（${meta.projectName}）`
      : '继承看板设置（未绑定 → scratch 沙箱）';
    kbFillSelect('#kb-f-project', opts, keep, ph);
    kbSyncProjectNote();
  }
  // 绑定弹窗：占位项「不绑定项目」= 解绑（CLI 把 falsy project_id 当清除）
  const bproj = $('#kb-b-project');
  if (bproj) kbFillSelect('#kb-b-project', opts, meta.projectId, '不绑定项目');
}
/** 新建弹窗的项目底注：只有显式选了某个项目才出声，说明它对工作区的决定作用。 */
function kbSyncProjectNote() {
  const note = $('#kb-f-project-note'), sel = $('#kb-f-project');
  if (!note || !sel) return;
  const v = String(sel.value || '');
  const p = (KB.overview && Array.isArray(KB.overview.projects) ? KB.overview.projects : [])
    .find((x) => String((x && (x.id || x.slug)) || '') === v);
  if (!v || !p) { note.hidden = true; note.textContent = ''; return; }
  note.hidden = false;
  note.textContent = `已选「${p.name || p.slug}」：worker 将在 ${p.primaryPath || '项目主仓库'} 下创建 git worktree（分支 = slug + 任务id），覆盖看板继承。`;
}
/** 受让人说明的第二行：只在填了非 profile 的名字时出声。
 *  可用清单已经在下拉里，再抄一遍 8 个名字只会把弹窗撑长、把真警告淹没。 */
function kbSyncAssigneeHint() {
  const el = $('#kb-f-assignee-profiles');
  if (!el) return;
  const profiles = [...kbProfileSet()].sort();
  const typed = ($('#kb-f-assignee')?.value || '').trim();
  if (typed && profiles.length && !profiles.includes(typed)) {
    el.hidden = false;
    el.textContent = `${typed} 不是磁盘上的 profile，任务会停在 ready 且不会被派发`;
    el.classList.add('warn');
    return;
  }
  el.classList.remove('warn');
  el.textContent = '';
  el.hidden = true;
}

/** 维度没有可选值时，把整个控件收起来。
 *  一个只剩「全部 / 当前看板」一项的下拉是死控件：点开什么都没有，
 *  看着像数据没加载出来。宁可不占工具栏那一格。 */
function kbToggleField(sel, show) {
  const el = $(sel);
  const field = el && el.closest ? el.closest('.kb-field, .kb-frow') : null;
  if (field) field.hidden = !show;
}

/** 磁盘上真实存在的 profile（来自 /assignees 的 on_disk）。空集 = 拿不到清单，不做判断。 */
function kbProfileSet() {
  const o = KB.overview || {};
  return new Set(Array.isArray(o.profiles) ? o.profiles.map(String) : []);
}
function kbIsProfile(name) {
  const set = kbProfileSet();
  if (!set.size) return true;
  return set.has(String(name || ''));
}
/** 受让人 chip：非 profile 的打警告色，点明「不会被派发」。 */
function kbAssigneeChip(name) {
  const n = String(name || '');
  if (!n) return '';
  if (kbIsProfile(n)) {
    return `<span class="kb-chip" title="受让人 = Hermes profile：派发时用 hermes -p ${esc(n)} 启动 worker">${esc(n)}</span>`;
  }
  return `<span class="kb-chip warn" title="${esc(n)} 不是磁盘上的 Hermes profile，调度器不会为它启动 worker（事件里记为 skipped_nonspawnable）">${esc(n)} · 非 profile</span>`;
}
/** 卡片脚行受让人：首字母小圆徽标 + 名字，不做重描边胶囊。 */
function kbAssigneeFoot(name) {
  const n = String(name || '');
  if (!n) return '';
  const init = n.slice(0, 1).toUpperCase();
  if (kbIsProfile(n)) {
    return `<span class="kb-asg" title="受让人 = Hermes profile：派发时用 hermes -p ${esc(n)} 启动 worker"><span class="kb-asg-av" aria-hidden="true">${esc(init)}</span>${esc(n)}</span>`;
  }
  return `<span class="kb-asg warn" title="${esc(n)} 不是磁盘上的 Hermes profile，调度器不会为它启动 worker（事件里记为 skipped_nonspawnable）"><span class="kb-asg-av" aria-hidden="true">${esc(init)}</span>${esc(n)} · 非 profile</span>`;
}

/* ---- worker 投放区：拖卡片到 profile 上 = 改派受让人，再决定要不要立刻启动 worker ----
   CLI 里「受让人」就是 profile 名：派发器用 `hermes -p <受让人>` 起进程。
   所以拖拽只做两件 CLI 原生支持的事：PATCH 改 assignee（可顺带 → ready），
   以及 POST /dispatch?max=1（且先用 dry_run 确认队首就是这张卡片）。 */
const KB_ASSIGNEE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function kbFindTask(id) {
  const cols = (KB.board && Array.isArray(KB.board.columns)) ? KB.board.columns : [];
  for (const c of cols) {
    for (const t of (c && Array.isArray(c.tasks) ? c.tasks : [])) {
      if (t && t.id === id) return t;
    }
  }
  return null;
}
/** 每个 profile 当前有多少 worker 在跑（running 列按 assignee 计数）。 */
function kbRunningByAssignee() {
  const map = new Map();
  const cols = (KB.board && Array.isArray(KB.board.columns)) ? KB.board.columns : [];
  for (const c of cols) {
    if (!c || String(c.name || '') !== 'running') continue;
    for (const t of (Array.isArray(c.tasks) ? c.tasks : [])) {
      const a = String((t && t.assignee) || '');
      if (a) map.set(a, (map.get(a) || 0) + 1);
    }
  }
  return map;
}
/**
 * 可投放的 worker 清单。优先用 /assignees 里 on_disk 的 profile（只有它们能被
 * `hermes -p` 拉起）；拿不到清单时退化为看板上出现过的受让人，并标记未校验。
 */
function kbWorkerList() {
  const o = KB.overview || {};
  const b = KB.board || {};
  const known = [...kbProfileSet()];
  const pool = known.length
    ? known
    : [...new Set((Array.isArray(b.assignees) ? b.assignees : []).map(String).filter(Boolean))];
  const running = kbRunningByAssignee();
  return {
    verified: known.length > 0,
    list: pool.filter((n) => KB_ASSIGNEE_RE.test(String(n))).sort()
      .map((n) => ({ name: String(n), running: running.get(String(n)) || 0 })),
  };
}
