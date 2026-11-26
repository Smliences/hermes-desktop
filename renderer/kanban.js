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
  view: 'cols', status: '', modal: '', modalKey: '', modalBusy: false,
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
    if (o && o.ok) KB.overview = o;
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

/* ---- 「⋯」菜单：新建看板 / 手动派发 / 切换视图 / 显示已归档 ----
   这几个都是低频入口，放常驻按钮会把首屏挤掉；菜单只是一个 absolute 面板，
   不新增通道、不改任何写路径。 */
function kbMoreToggle(open) {
  const btn = $('#kb-more'), menu = $('#kb-more-menu');
  const on = !!open;
  if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  if (menu) menu.hidden = !on;
  if (on) kbMoreSync();
}
/** 视图项文字跟着当前视图走（菜单里只有一项，不另做两态按钮）。 */
function kbMoreSync() {
  const item = document.querySelector('#kb-more-menu [data-kb-more="view"]');
  if (item) item.textContent = KB.view === 'grid' ? '切换到列视图' : '切换到网格视图';
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
  if (!assignees.length && KB.filters.assignee) KB.filters.assignee = '';
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
function renderKanbanDock() {
  const host = $('#kb-dock-workers');
  if (!host) return;
  if (KbDrag.on) return; // 拖动中不重建，否则正在悬停的投放目标会被换掉
  const scrollLeft = host.scrollLeft;   // 重建会把滚动位置打回 0，chip 会莫名「漂」一下
  const { verified, list } = kbWorkerList();
  const focused = document.activeElement && document.activeElement.getAttribute
    ? document.activeElement.getAttribute('data-kb-worker') : null;
  if (!list.length) {
    host.innerHTML = '<span class="kb-dock-empty">未发现可派发的 profile —— 受让人必须与磁盘上的 Hermes profile 同名，派发器才能用 <code>hermes -p &lt;受让人&gt;</code> 启动 worker。</span>';
    return;
  }
  host.innerHTML = list.map((w) => {
    const tip = `${w.name} · ${w.running ? w.running + ' 个 worker 在跑' : '空闲'}`
      + (verified ? '' : '（profile 清单未读到，名字按看板受让人推断）')
      + ' · 把卡片拖到这里可指派';
    return `<button class="kb-worker${w.running ? ' busy' : ''}" type="button"
      data-kb-worker="${esc(w.name)}" title="${esc(tip)}"
      aria-label="${esc(w.name)}${w.running ? `，${w.running} 个 worker 在跑` : ''}，可投放卡片">${esc(w.name)}${w.running ? `<span class="kb-worker-n">${w.running} 在跑</span>` : ''}</button>`;
  }).join('');
  host.scrollLeft = scrollLeft;
  if (focused) {
    const back = host.querySelector(`[data-kb-worker="${focused}"]`);
    if (back) { try { back.focus({ preventScroll: true }); } catch {} }
  }
}
function kbDockHint(text) {
  const el = $('#kb-dock-hint');
  if (el && el.textContent !== text) el.textContent = text;
}
/** 投放区状态文字：成功提示 8s 自动退场，错误留 12s 够看清；关页时一并清掉。
 *  dock 现在是浮层，这一条也跟着浮动 —— 由 #kb-dock-status 的 .on 控制显隐，
 *  不能靠「有没有文字」：空 span 也会占位，浮层会在底部留一条空白。 */
let kbDockMsgTimer = null;
function kbDockMsg(text, cls) {
  const el = $('#kb-dock-msg'), box = $('#kb-dock-status');
  if (!el) return;
  if (kbDockMsgTimer) { clearTimeout(kbDockMsgTimer); kbDockMsgTimer = null; }
  el.textContent = text || '';
  el.className = 'kb-dock-msg' + (cls ? ' ' + cls : '');
  if (box) box.classList.toggle('on', !!text);
  if (text) {
    kbDockMsgTimer = setTimeout(() => {
      kbDockMsgTimer = null;
      el.textContent = '';
      el.className = 'kb-dock-msg';
      if (box) box.classList.remove('on');
    }, cls === 'err' ? 12000 : 8000);
  }
}

/* ---- 指针拖拽（不用 HTML5 DnD：可控、能吞掉误触 click、能量到投放目标） ----
   两条铁律，改之前先看：
   ① 投放区几何在拖动期间必须恒定。label 是定宽槽位、状态文字挪到 dock 外独立一行，
      否则提示文案一变，chip 就在指针底下漂移，根本对不准（原来就是这么坏的）。
   ② 幽灵卡浮在指针上方而不是贴着抓取点盖住指针 —— 否则它正好挡住要投放的那个 chip。 */
const KB_DOCK_IDLE = '拖到这里派发';
const KB_DOCK_SNAP = 26;   // 落在 chip 缝隙里也能吸附到最近的一个
function kbReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch { return false; }
}
function kbDragBegin() {
  if (KbDrag.on || !KbDrag.id) return;
  KbDrag.on = true;
  document.body.classList.add('kb-dragging');
  const dock = $('#kb-dock');
  if (dock) dock.classList.add('is-drag');
  // 按下后到越过阈值之间可能正好赶上轮询重渲染，原卡片节点会脱离文档：
  // 按 id 重新取当前节点，否则「变暗」的视觉反馈会丢失。
  if (!KbDrag.card || !KbDrag.card.isConnected) {
    KbDrag.card = document.querySelector(`.kb-card[data-kb-task="${KbDrag.id}"]`);
  }
  const src = KbDrag.card;
  if (src) src.classList.add('is-dragging');
  const r = src ? src.getBoundingClientRect() : { width: 240, height: 64 };
  const g = document.createElement('div');
  g.className = 'kb-drag-ghost';
  g.setAttribute('aria-hidden', 'true');
  if (src) {
    // 幽灵是整张卡的克隆：一眼看出在搬哪一张，比只有标题的小方块直观
    const clone = src.cloneNode(true);
    // 但只能做视觉：抹掉所有会和真实卡片抢命中 / 抢键盘的标识
    clone.removeAttribute('data-kb-task');
    clone.removeAttribute('data-kb-drag');
    clone.removeAttribute('title');
    clone.classList.remove('is-dragging', 'sel');
    clone.classList.add('kb-ghost-card');
    clone.setAttribute('tabindex', '-1');
    clone.setAttribute('aria-hidden', 'true');
    g.appendChild(clone);
  }
  const tip = document.createElement('small');
  tip.className = 'kb-ghost-tip';
  tip.textContent = (KbDrag.status ? KbDrag.status + ' · ' : '') + '松手到列里改状态，或落到 profile 上改派';
  g.appendChild(tip);
  g.style.width = Math.round(Math.min(r.width || 240, 300)) + 'px';
  document.body.appendChild(g);
  KbDrag.ghost = g;
  KbDrag.gh = g.getBoundingClientRect().height || 0;
  g.classList.add('on');
  // 槽位里显示正在搬的卡片标题（槽宽固定，超出省略，绝不挤动右侧 chip）
  kbDockHint(KbDrag.title ? '⠿ ' + KbDrag.title : '⠿ 正在拖动');
  kbDragScrollLoop();
}
/** 幽灵卡落点：水平居中于指针、垂直浮在指针上方 18px，再夹进视口。
 *  纯函数，契约会直接跑数值断言 —— 幽灵的底边必须始终在指针上方，
 *  否则它正好盖住要投放的那个 chip。 */
function kbGhostPos(x, y, w, h, vw, vh) {
  const left = Math.max(8, Math.min(x - w / 2, Math.max(8, vw - w - 8)));
  const top = Math.max(8, Math.min(y - h - 18, Math.max(8, vh - h - 8)));
  return { left: Math.round(left), top: Math.round(top) };
}
function kbDragFollow(x, y) {
  const g = KbDrag.ghost;
  if (!g) return;
  const w = g.offsetWidth || 240;
  const h = KbDrag.gh || g.offsetHeight || 0;
  const p = kbGhostPos(x, y, w, h, window.innerWidth || 0, window.innerHeight || 0);
  g.style.transform = `translate3d(${p.left}px, ${p.top}px, 0)`;
}
function kbChipAt(x, y) {
  const dock = $('#kb-dock');
  if (!dock) return null;
  try {
    const el = document.elementFromPoint(x, y);
    const hit = el && el.closest ? el.closest('.kb-worker') : null;
    if (hit && dock.contains(hit)) return hit;
  } catch { /* elementFromPoint 在极端坐标下会抛 */ }
  // 落在 chip 之间或 dock 的空白里：吸附到最近的一个，别让「差几像素」白拖
  const d = dock.getBoundingClientRect();
  if (y < d.top - 8 || y > d.bottom + 8) return null;
  const row = $('#kb-dock-workers');
  const rr = row ? row.getBoundingClientRect() : null;
  let best = null, bestD = KB_DOCK_SNAP;
  dock.querySelectorAll('.kb-worker').forEach((c) => {
    const b = c.getBoundingClientRect();
    if (rr && (b.right < rr.left + 2 || b.left > rr.right - 2)) return; // 被横向滚动裁掉的
    const dx = x < b.left ? b.left - x : (x > b.right ? x - b.right : 0);
    const dy = y < b.top ? b.top - y : (y > b.bottom ? y - b.bottom : 0);
    const dist = Math.hypot(dx, dy);
    if (dist < bestD) { bestD = dist; best = c; }
  });
  return best;
}
function kbSetDropTarget(chip) {
  if (KbDrag.target === chip) return;
  const prev = KbDrag.target;
  if (prev && prev.classList) prev.classList.remove('over');
  KbDrag.target = chip || null;
  if (chip && chip.classList) chip.classList.add('over');
  if (KbDrag.ghost) KbDrag.ghost.classList.toggle('ok', !!chip);
  const name = chip ? String(chip.getAttribute('data-kb-worker') || '') : '';
  kbDockHint(name ? '松手 → ' + name : (KbDrag.title ? '⠿ ' + KbDrag.title : '⠿ 正在拖动'));
}
function kbDragHover(x, y) {
  const chip = kbChipAt(x, y);
  kbSetDropTarget(chip);
  // profile chip 优先：落在 chip 上就只算改派，不再高亮列，避免一次拖拽两个投放目标
  kbSetColTarget(chip ? null : kbColAt(x, y));
  kbDragAutoScroll(x, y);
}
/** 指针下面是不是某一列（列头与列体都算）。返回 {el, status}；「已归档」列返回 null。 */
function kbColAt(x, y) {
  try {
    const el = document.elementFromPoint(x, y);
    const hit = el && el.closest ? el.closest('.kb-col[data-group]') : null;
    if (!hit) return null;
    const status = KB_GROUP_STATUS[String(hit.getAttribute('data-group') || '')] || '';
    return status ? { el: hit, status } : null;
  } catch { return null; }
}
function kbSetColTarget(next) {
  const cur = KbDrag.col;
  if ((cur && next && cur.el === next.el) || (!cur && !next)) return;
  if (cur && cur.el) cur.el.classList.remove('over');
  KbDrag.col = next || null;
  if (next && next.el) next.el.classList.add('over');
  if (KbDrag.ghost) KbDrag.ghost.classList.toggle('ok', !!next || !!KbDrag.target);
  if (next) kbDockHint(`松手 → ${KB_STATUS_ACTION[next.status] || next.status}`);
  else if (!KbDrag.target) kbDockHint(KbDrag.title ? '⠿ ' + KbDrag.title : '⠿ 正在拖动');
}
/** 指针靠近 chip 行的左右边缘就自动横向滚动，否则窄窗口里根本够不到后面的 profile */
function kbDragAutoScroll(x, y) {
  const row = $('#kb-dock-workers'), dock = $('#kb-dock');
  if (!row || !dock) { KbDrag.vel = 0; return; }
  const d = dock.getBoundingClientRect();
  if (y < d.top - 48 || y > d.bottom + 48) { KbDrag.vel = 0; return; }
  const r = row.getBoundingClientRect();
  if (r.scrollWidth <= r.width + 1) { KbDrag.vel = 0; return; }
  KbDrag.vel = Math.round(kbScrollVel(x, r, 44, 12) * 10) / 10;
}
/** 边缘自动滚动的速度（px/帧）：离边缘越近越快，中间与区外都是 0。纯函数，便于数值断言。 */
function kbScrollVel(x, r, edge, max) {
  if (x >= r.left - edge && x < r.left + edge) return -max * Math.min(1, (r.left + edge - x) / (edge * 2));
  if (x <= r.right + edge && x > r.right - edge) return max * Math.min(1, (x - (r.right - edge)) / (edge * 2));
  return 0;
}
/** 自动滚动只占一个 rAF 循环，拖动结束立刻停；不用 setInterval 是为了绝不叠定时器 */
function kbDragScrollLoop() {
  if (KbDrag.raf) return;
  const step = () => {
    KbDrag.raf = 0;
    if (!KbDrag.on) return;
    const row = $('#kb-dock-workers');
    if (row && KbDrag.vel) row.scrollLeft += KbDrag.vel;
    KbDrag.raf = requestAnimationFrame(step);
  };
  KbDrag.raf = requestAnimationFrame(step);
}
function kbDragReset(instant) {
  const wasOn = KbDrag.on;
  if (KbDrag.raf) { cancelAnimationFrame(KbDrag.raf); KbDrag.raf = 0; }
  if (KbDrag.target && KbDrag.target.classList) KbDrag.target.classList.remove('over');
  if (KbDrag.col && KbDrag.col.el) KbDrag.col.el.classList.remove('over');
  if (KbDrag.card && KbDrag.card.classList) KbDrag.card.classList.remove('is-dragging');
  const g = KbDrag.ghost;
  if (g) {
    g.classList.remove('on');
    g.classList.add('out');
    if (instant || kbReducedMotion()) { try { g.remove(); } catch { /* 已被移除 */ } }
    else setTimeout(() => { try { g.remove(); } catch { /* 已被移除 */ } }, 140);
  }
  document.body.classList.remove('kb-dragging');
  const dock = $('#kb-dock');
  if (dock) dock.classList.remove('is-drag');
  KbDrag.armed = false; KbDrag.on = false; KbDrag.id = ''; KbDrag.title = '';
  KbDrag.status = ''; KbDrag.card = null; KbDrag.ghost = null; KbDrag.target = null;
  KbDrag.col = null; KbDrag.vel = 0; KbDrag.gh = 0;
  kbDockHint(KB_DOCK_IDLE);
  return wasOn;
}
function kbDragDown(e) {
  if (!e || e.button !== 0 || e.pointerType === 'touch') return; // 触摸留给滚动，避免和滚动手势打架
  const card = e.target && e.target.closest ? e.target.closest('.kb-card') : null;
  if (!card || card.getAttribute('data-kb-drag') !== '1') return;
  const id = String(card.getAttribute('data-kb-task') || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  KbDrag.armed = true;
  KbDrag.id = id;
  KbDrag.card = card;
  KbDrag.x0 = e.clientX;
  KbDrag.y0 = e.clientY;
  const t = kbFindTask(id);
  KbDrag.status = String((t && t.status) || '');
  const titleEl = card.querySelector('.kb-card-title');
  KbDrag.title = (titleEl && titleEl.textContent ? titleEl.textContent : '').trim();
}
function kbDragMove(e) {
  if (!KbDrag.armed && !KbDrag.on) return;
  if (!KbDrag.on) {
    if (Math.abs(e.clientX - KbDrag.x0) < 5 && Math.abs(e.clientY - KbDrag.y0) < 5) return;
    kbDragBegin();
    if (!KbDrag.on) return;
  }
  if (e.cancelable) e.preventDefault();
  kbDragFollow(e.clientX, e.clientY);
  kbDragHover(e.clientX, e.clientY);
}
function kbDragUp() {
  if (!KbDrag.armed && !KbDrag.on) return;
  const dropped = KbDrag.target ? KbDrag.target.getAttribute('data-kb-worker') : '';
  const col = KbDrag.col ? KbDrag.col.status : '';
  const id = KbDrag.id;
  const from = KbDrag.status;
  const moved = kbDragReset();
  if (moved) {
    // 拖动结束后浏览器会补一个 click；先吞掉，再在下一个任务里复位标志
    KbDrag.suppressClick = true;
    setTimeout(() => { KbDrag.suppressClick = false; }, 0);
  }
  if (!moved) return;
  if (dropped && KB_ASSIGNEE_RE.test(dropped)) { kbDropToWorker(id, dropped); return; }
  if (col) kbDropToStatus(id, col, from);
}

/**
 * 落地：把卡片拖进另一列 = 让 CLI 走一次状态动词（PATCH /tasks/{id} {status}）。
 * 状态机规则全在 CLI（父任务没做完会 409 并点名），桌面端只负责确认与文案：
 *   - running → done/review 是「人类强制覆盖在跑 worker 的认领」，先过确认卡；
 *   - 其余迁移没有副作用，直接写。
 */
async function kbDropToStatus(taskId, status, srcStatus) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(taskId || ''))) return;
  const target = String(status || '');
  if (!KB_STATUS_SETTABLE.includes(target)) return;
  const a = kbApi();
  if (!a || !a.kanbanSetStatus) { kbDockMsg('此页需要 Hermes 桌面端才能改状态', 'err'); return; }
  const task = kbFindTask(taskId);
  if (!task) { kbDockMsg('找不到这张卡片，先刷新看板', 'err'); return; }
  const from = String(task.status || srcStatus || '');
  const label = KB_STATUS_LABEL[target] || target;
  // 同列内拖（例如 scheduled 拖到「待办」）：目标状态已经成立，别白写一条事件
  if (from === target) { kbDockMsg(`这张卡已经是「${label}」`, ''); return; }
  const go = async () => {
    kbDockMsg(`正在把 ${taskId} 改成「${label}」…`, '');
    try {
      const r = await a.kanbanSetStatus(taskId, { status: target, board: KB.filters.board || '' });
      if (!r || !r.ok) { kbDockMsg('改状态失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
      await kanbanLoad(true); // 写后回读：列归组、计数、chip 都跟着变
      if (KB.detailId === taskId) openKanbanTask(taskId, true);
      kbDockMsg(`已改成「${label}」`, 'on');
    } catch (e) {
      kbDockMsg('改状态失败：' + ((e && e.message) || '未知错误'), 'err');
    }
  };
  // 从「运行中」拖出 = 覆盖在跑的 worker 的认领（CLI 侧是 force），先问一句
  if (from === 'running') {
    const host = $('#kb-dock-confirm');
    if (host) {
      opConfirm(host, {
        title: `这张卡还在跑：${String(task.title || taskId).slice(0, 32)}`,
        cmd: `PATCH /api/plugins/kanban/tasks/${taskId}   {"status":"${target}"}`,
        note: `worker 可能还在执行。CLI 把人工动作当作强制覆盖：这一轮的结果会被丢弃，任务直接记成「${label}」。确定现在改吗？`,
        confirmLabel: target === 'done' ? '强制标为完成' : `强制改为${label}`,
        onGo: go,
      });
      return;
    }
  }
  await go();
}

/** 落地第一步：改派受让人（顺带推进到 ready）。不启动任何进程。 */
async function kbDropToWorker(taskId, profile) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(taskId || ''))) return;
  if (!KB_ASSIGNEE_RE.test(String(profile || ''))) return;
  const a = kbApi();
  if (!a || !a.kanbanReassign) { kbDockMsg('此页需要 Hermes 桌面端才能改派', 'err'); return; }
  const task = kbFindTask(taskId);
  if (!task) { kbDockMsg('找不到这张卡片，先刷新看板', 'err'); return; }
  const st = String(task.status || '');
  if (!KB_DRAGGABLE.includes(st)) {
    kbDockMsg(st === 'running'
      ? '运行中的卡片不能改派：先在 CLI 里 reclaim 掉它的认领，再拖一次。'
      : `「${st || '该'}」状态的卡片不会再派发，改派没有意义。`, 'err');
    return;
  }
  // 已经是指定 profile 且已在 ready：省掉一次 PATCH，少写一条 assigned 事件
  if (String(task.assignee || '') === profile && st === 'ready') {
    kbDockMsg(`已指派给 ${profile}`, 'on');
    kbAskDispatch(taskId, profile, task.title || '');
    return;
  }
  kbDockMsg(`正在把 ${taskId} 指派给 ${profile}…`, '');
  try {
    const r = await a.kanbanReassign(taskId, {
      assignee: profile, status: 'ready', board: KB.filters.board || '',
    });
    if (!r || !r.ok) { kbDockMsg('改派失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
    await kanbanLoad(true); // 写后回读：卡片落到 ready、受让人 chip 跟着变
    kbDockMsg(`已指派给 ${profile}`, 'on');
    kbAskDispatch(taskId, profile, task.title || '');
  } catch (e) {
    kbDockMsg('改派失败：' + ((e && e.message) || '未知错误'), 'err');
  }
}
/** 落地第二步：真派发必须过二次确认卡（会 spawn 进程、花额度）。 */
function kbAskDispatch(taskId, profile, title) {
  const host = $('#kb-dock-confirm');
  if (!host) return;
  opConfirm(host, {
    title: `现在启动 worker：${String(title || taskId).slice(0, 36)}`,
    cmd: `POST /api/plugins/kanban/dispatch?dry_run=false&max=1   ←   hermes -p ${profile}`,
    note: `卡片已在 ready 队列并指派给 ${profile}。点「立即启动」才真派发：调度器会用 hermes -p ${profile} 拉起一个 worker 执行它，消耗模型额度。点「取消」就只保持指派，等调度器 60 秒内的自动 tick 或手动派发。派发前会先做一次 dry-run，确认队首就是这张卡片，不会顺带唤醒别的任务。`,
    confirmLabel: '立即启动 worker',
    onGo: () => kbDispatchTaskNow(taskId, profile),
  });
}
async function kbDispatchTaskNow(taskId, profile) {
  const a = kbApi();
  if (!a || !a.kanbanDispatchTask) { kbDockMsg('此页需要 Hermes 桌面端才能派发', 'err'); return; }
  kbDockMsg('正在派发…', '');
  try {
    const r = await a.kanbanDispatchTask(taskId, { board: KB.filters.board || '' });
    if (!r || !r.ok) { kbDockMsg('派发失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
    // 只在投放区状态条上说，不再叠一条 toast：两者都是底部居中，会互相压住
    if (r.dispatched) kbDockMsg(`worker 已启动：${taskId} → ${profile}`, 'on');
    else kbDockMsg(r.reason || '调度器本次没有启动 worker', 'err');
    await kanbanLoad(true); // 写后回读：running 卡片与活跃 worker 都会变
    if (KB.dispatch.open) kbDispatchLoadWorkers();
  } catch (e) {
    kbDockMsg('派发失败：' + ((e && e.message) || '未知错误'), 'err');
  }
}

function kbMatch(t) {
  const f = KB.filters;
  if (f.assignee && String(t.assignee || '') !== f.assignee) return false;
  if (!f.q) return true;
  const q = f.q.toLowerCase();
  return [t.id, t.title, t.body, t.latest_summary, t.result, t.assignee, t.tenant]
    .some((v) => String(v || '').toLowerCase().includes(q));
}
/** 统一 P 级映射：后端 priority 数值越大越先派发（10/3/2/1/0），前端按工程习惯展示 P0 最紧急 → P4 普通。
 *  视觉梯度：P0/P1 红 → P2 陶土橙 → P3 赭黄，P4 在卡面不渲染以减少噪点。 */
function kbPriMeta(raw) {
  const n = Number(raw) || 0;
  if (n >= 10) return { tag: 'P0', cls: 'p0', rcls: 'p3', title: `优先级 P0 · 最紧急（后端权重 ${n}，优先派发）` };
  if (n >= 3) return { tag: 'P1', cls: 'hi', rcls: 'p3', title: `优先级 P1 · 高（后端权重 ${n}）` };
  if (n === 2) return { tag: 'P2', cls: 'mid', rcls: 'p2', title: '优先级 P2 · 中（后端权重 2）' };
  if (n === 1) return { tag: 'P3', cls: 'lo', rcls: 'p1', title: '优先级 P3 · 低（后端权重 1）' };
  return { tag: 'P4', cls: 'n0', rcls: '', title: '优先级 P4 · 普通（默认权重 0）' };
}
const KB_PRI_OPTIONS = [
  ['0', 'P4 · 普通（默认）'],
  ['1', 'P3 · 低优先级'],
  ['2', 'P2 · 中优先级'],
  ['3', 'P1 · 高优先级'],
  ['10', 'P0 · 最紧急'],
];

function kbCardHtml(t, colName, opts) {
  const o = opts || {};
  const st = String(colName || t.status || '');
  const draggable = KB_DRAG_SOURCE.includes(st) ? '1' : '0';
  const pri = Number(t.priority) || 0;
  const pm = kbPriMeta(pri);
  const priHtml = pri > 0 ? `<span class="kb-pri ${pm.cls}" title="${esc(pm.title)}">${pm.tag}</span>` : '';
  const ago = kbAgo(t.created_at);
  const whenHtml = ago ? `<span class="kb-card-when" title="创建于 ${esc(kbFullTime(t.created_at))}">${esc(ago)}</span>` : '';
  // 来源行：细粒度状态 chip 只有跨组展示（网格 / 搜索结果）才需要；
  // 受让人与弱指标收进发丝脚行（ID 只留在抽屉里）。
  const chips = [];
  if (o.showStatus && st) chips.push(`<span class="kb-chip st" title="CLI 状态：${esc(st)}">${esc(KB_STATUS_LABEL[st] || st)}</span>`);
  if (t.tenant) chips.push(`<span class="kb-chip" title="租户">${esc(t.tenant)}</span>`);
  const wn = t.warnings && Number(t.warnings.count);
  if (wn) chips.push(`<span class="kb-chip warn" title="有诊断告警">${wn} 项告警</span>`);

  // 脚行：受让人徽标 · 评论图标计数 · 子任务迷你进度 + 右侧弱化时间。
  const foot = [];
  const asg = kbAssigneeFoot(t.assignee);
  if (asg) foot.push(asg);
  const cc = Number(t.comment_count) || 0;
  if (cc) {
    foot.push(`<span class="kb-foot-stat" title="${cc} 条评论"><svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H6.5l-3 2.5V11H4A1.5 1.5 0 0 1 2.5 9.5V4z"/></svg>${cc}</span>`);
  }
  const pg = t.progress;
  if (pg && Number(pg.total)) {
    const done = Number(pg.done) || 0, tot = Number(pg.total);
    const pct = Math.min(100, Math.max(0, Math.round((done / tot) * 100)));
    foot.push(`<span class="kb-foot-stat" title="子任务进度 ${done}/${tot}"><span class="kb-sub-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>${done}/${tot}</span>`);
  }

  // 卡面描述：优先最新执行回报（latest_summary = task_runs.summary），
  // 没跑过 worker 的任务回退到建任务时写的描述 body —— 否则新卡永远是光杆标题。
  const sum = String(t.latest_summary || t.body || '').trim();
  // 运行中的卡：顶部 2px 绿条 + 秒表，不用点开就知道进度；
  const runHtml = st === 'running' ? kbRunStrip(t) : '';
  const dragHint = draggable === '1'
    ? '拖动：落到别的列改状态，落到上方 profile 上改派'
    : `${st || '该状态'} 不支持拖拽（已归档的卡片不参与拖动）`;
  return `<button class="kb-card${KB.detailId === t.id ? ' sel' : ''}" data-kb-task="${esc(t.id)}" data-kb-drag="${draggable}" type="button" title="${esc(t.title || '')}　·　${esc(dragHint)}">
    ${priHtml}
    <div class="kb-card-title">${esc(t.title || '(无标题)')}</div>
    ${sum ? `<div class="kb-card-sum">${esc(clip(sum, 200))}</div>` : ''}
    ${chips.length ? `<div class="kb-card-meta">${chips.join('')}</div>` : ''}
    ${runHtml}
    <div class="kb-card-foot">${foot.join('')}${whenHtml}</div>
  </button>`;
}

/** 按归组摊平当前看板：每组带原始条数 all 与过滤后条数 tasks。
 *  计数（chip 上的数字）恒用 all，不随搜索 / 受让人筛选变化 —— 否则筛完就失去全局感。 */
function kbGroups() {
  const by = new Map();
  const cols = (KB.board && Array.isArray(KB.board.columns)) ? KB.board.columns : [];
  for (const c of cols) {
    const name = String((c && c.name) || '');
    if (!name) continue;
    const list = Array.isArray(c.tasks) ? c.tasks : [];
    by.set(name, list.map((t) => (t && typeof t === 'object' && !t.status ? { ...t, status: name } : t)));
  }
  const defs = KB.filters.archived ? [...KB_GROUPS, KB_GROUP_ARCHIVED] : [...KB_GROUPS];
  return defs.map((g) => {
    const all = g.statuses.reduce((acc, s) => acc.concat(by.get(s) || []), []);
    return { key: g.key, label: g.label, hint: g.hint, dot: g.dot, all, tasks: all.filter(kbMatch) };
  });
}
/** 页头只写两样：当前看板名 + 一行概览。原来那排统计卡会把首屏挤掉，
 *  各组条数已经在筛选 chip 上各出现一次，这里只留「总量 + 进行中」。 */
/**
 * 页头那枚编排模式标记：只读 + 点击去设置，绝不在这里改任何东西。
 * 三档模式由主进程从 config.yaml 的两个开关推导，渲染层只管显示 ——
 * 否则 UI 会多出一份可以和 gateway 实际状态不一致的「模式」。
 */
const KB_MODE_TIP = Object.freeze({
  auto: '收集箱的卡会自动拆解并派发执行。点击到设置里更改。',
  semi: '收集箱停住，其余仍自动执行。点击到设置里更改。',
  manual: '派发器已停，只有手动派发才会执行。点击到设置里更改。',
});
function kbModeChip(state) {
  const el = $('#kb-head-mode');
  if (!el) return;
  if (!state || !state.ok) { el.hidden = true; return; }
  KB.mode = state;
  el.hidden = false;
  el.dataset.mode = state.mode;
  el.textContent = '自动编排·' + (state.modeLabel || state.mode);
  el.title = KB_MODE_TIP[state.mode] || '看板编排模式（只读）';
  el.classList.toggle('is-manual', state.mode === 'manual');
}
async function kbLoadMode() {
  const el = $('#kb-head-mode');
  if (!el) return;
  if (!kbApi() || !isNativeCLI()) { el.hidden = true; return; }
  let r = null;
  try { r = await api.kanbanOrchestration(); } catch { r = null; }
  kbModeChip(r);
}

function renderKanbanHead() {
  const nameEl = $('#kb-board-name'), statEl = $('#kb-head-stat'), sep = $('.kb-meta-sep');
  const o = KB.overview || {};
  // 筛到别的看板时页头要跟着显示被筛的看板，而不是 gateway 的当前看板
  const name = String(KB.filters.board || o.currentBoard || '当前看板');
  const boards = Array.isArray(o.boards) ? o.boards : [];
  if (nameEl) {
    nameEl.textContent = name;
    // 多看板时页头直接由 #kb-board 下拉显示并切换，避免同名写两遍
    nameEl.hidden = boards.length > 1;
  }
  if (!statEl) return;
  let text = '';
  if (!KB.board) text = KB.busy ? '读取中…' : '';
  else {
    const groups = kbGroups();
    const total = groups.reduce((n, g) => n + g.all.length, 0);
    const running = (groups.find((g) => g.key === 'running') || { all: [] }).all.length;
    text = total ? (running ? `${total} 张任务 · ${running} 张进行中` : `${total} 张任务`) : '暂无任务';
    // 看板绑定了项目时把项目名亮在概览行：项目决定该板任务的默认工作区
    const bm = (Array.isArray(o.boards) ? o.boards : [])
      .find((x) => String((x && x.slug) || '') === name);
    if (bm && bm.project_name) text += ` · 项目 ${bm.project_name}`;
  }
  statEl.textContent = text;
  // 统计为空时连分隔符一起收起，否则页头会挂一个孤零零的「·」
  if (sep) sep.hidden = !text;
}

/** 秒数 → 人话时长（「最早就绪已等 12 分钟」用）。 */
function kbAge(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时';
  return Math.floor(s / 86400) + ' 天';
}

/** 分组 chip：点一次只看该组，再点回全部。数字恒为该组的全局条数（不随筛选变），
 *  这样筛完还能看见「别处还有多少」，不会失去全局感。重建后把焦点还给同一个 chip。 */
function renderKanbanStatusbar() {
  const host = $('#kb-statusbar');
  if (!host) return;
  const focused = document.activeElement && document.activeElement.getAttribute
    ? document.activeElement.getAttribute('data-kb-status') : null;
  const groups = kbGroups();
  const all = groups.reduce((n, g) => n + g.all.length, 0);
  let html = `<button class="kb-status-chip${KB.status ? '' : ' on'}" type="button" data-kb-status="" aria-pressed="${KB.status ? 'false' : 'true'}">全部 <span class="kb-sc-num">${all}</span></button>`;
  html += groups.map((g) => `<button class="kb-status-chip${KB.status === g.key ? ' on' : ''}" type="button"
      data-kb-status="${esc(g.key)}" data-group="${esc(g.key)}" data-dot="${esc(g.dot)}"
      aria-pressed="${KB.status === g.key ? 'true' : 'false'}" title="${esc(g.hint)}">
      <span class="kb-sc-dot"></span>${esc(g.label)} <span class="kb-sc-num">${g.all.length}</span></button>`).join('');
  host.innerHTML = html;
  if (focused !== null) {
    const back = host.querySelector(`[data-kb-status="${focused}"]`);
    if (back) { try { back.focus({ preventScroll: true }); } catch {} }
  }
}

/** 主体渲染。默认列视图：固定 5 组，组内纵向滚动；网格视图只画有卡片的分组。
 *  列尾的「＋ 添加任务」只给待办 / 就绪 —— 后端 CREATE_STATUSES 只认 triage 与 ready，
 *  在其余列放这个按钮只会建出一张落在收集箱的卡，文案会骗人。 */
function renderKanbanBody() {
  const groupsHost = $('#kb-groups'), colsHost = $('#kb-columns');
  const groups = kbGroups();
  const wanted = KB.status ? groups.filter((g) => g.key === KB.status) : groups;
  let shown = 0, total = 0;
  groups.forEach((g) => { total += g.all.length; });
  wanted.forEach((g) => { shown += g.tasks.length; });

  const isGrid = KB.view === 'grid';
  // 「显示已归档」＝在五列右侧追加一列。类挂在容器上而不是列上有两个原因：
  //  ① 容器不随 innerHTML 重建，class 不会被冲掉；
  //  ② 宽度策略由 CSS 一处决定，列自己不必知道自己是第几列。
  // 按分组筛选时只剩一列，那一列应该独占宽度，所以此时不加这个类。
  if (colsHost) colsHost.classList.toggle('has-archived', !!KB.filters.archived && !KB.status);
  if (groupsHost) groupsHost.hidden = !isGrid;
  if (colsHost) colsHost.hidden = isGrid;

  if (isGrid) {
    const visible = wanted.filter((g) => g.tasks.length > 0 || KB.status);
    const body = visible.map((g) => `<section class="kb-group" data-group="${esc(g.key)}" data-dot="${esc(g.dot)}">
      <div class="kb-group-head" title="${esc(g.hint)}"><span class="kb-group-dot"></span><span class="kb-group-name">${esc(g.label)}</span>
        <span class="kb-group-num">${g.tasks.length}${g.tasks.length !== g.all.length ? ' / ' + g.all.length : ''} 张</span>
        <span class="kb-group-rule"></span></div>
      <div class="kb-group-cards">${g.tasks.length ? g.tasks.map((t) => kbCardHtml(t, t.status || g.statuses[0], { showStatus: true })).join('')
        : `<div class="kb-col-empty">${KB.filters.q || KB.filters.assignee ? '没有匹配的任务' : '暂无任务'}</div>`}</div>
    </section>`).join('');
    const empty = !total
      ? `<div class="kb-empty-state"><h2>这个看板还没有任务</h2>
           <p>任务由 CLI 的 hermes kanban create、agent 的 kanban_* 工具或这里的新建按钮创建；数据落在同一份 kanban.db，终端与 Dashboard 立即可见。</p>
           <button class="kb-btn primary" type="button" data-kb-new="task">＋ 新建第一个任务</button></div>`
      : shown === 0
        ? `<div class="kb-empty-state"><h2>没有匹配的任务</h2><p>试试清空搜索、切换分组或放宽受让人筛选。</p><button class="kb-btn" type="button" data-kb-clear-filters="1">清空筛选条件</button></div>`
        : '';
    const addCard = (!KB.status && !empty)
      ? `<div class="kb-add-row"><button class="kb-add-card" type="button" data-kb-new="task">＋ 新建任务<span>默认落在收集箱 triage · 等自动分解</span></button></div>`
      : '';
    if (groupsHost) groupsHost.innerHTML = body + addCard + empty;
    if (colsHost) colsHost.innerHTML = '';
  } else {
    const empty = !total
      ? `<div class="kb-empty-state"><h2>这个看板还没有任务</h2>
           <p>任务由 CLI 的 hermes kanban create、agent 的 kanban_* 工具或这里的新建按钮创建；数据落在同一份 kanban.db，终端与 Dashboard 立即可见。</p>
           <button class="kb-btn primary" type="button" data-kb-new="task">＋ 新建第一个任务</button></div>`
      : '';
    const body = wanted.map((g) => {
      const collapsed = g.tasks.length === 0 ? ' is-empty' : '';
      const canAdd = g.key === 'todo' || g.key === 'ready';
      const addStatus = g.key === 'ready' ? 'ready' : 'triage';
      const add = canAdd
        ? `<button class="kb-add-col" type="button" data-kb-new="task" data-kb-new-status="${addStatus}"
             title="${g.key === 'ready' ? '新建并直接进入就绪：可能被调度器立即派发' : '新建到收集箱：派发器不会直接拉起，等自动分解补全后才会被派发'}">＋ 添加任务</button>`
        : '';
      return `<div class="kb-col${collapsed}" data-group="${esc(g.key)}" data-dot="${esc(g.dot)}" title="${esc(g.hint)}">
        <div class="kb-col-head"><span class="kb-col-dot" aria-hidden="true"></span><span class="kb-col-name">${esc(g.label)}</span>
          <span class="kb-col-num">${g.tasks.length}${g.tasks.length !== g.all.length ? '/' + g.all.length : ''}</span></div>
        <div class="kb-col-body">${g.tasks.length
          ? g.tasks.map((t) => kbCardHtml(t, t.status || g.statuses[0])).join('')
          : `<div class="kb-col-empty"><b>${g.all.length ? '无匹配' : '暂无任务'}</b><span class="kb-hint-long">${esc(g.hint)}</span></div>`}${add}</div>
      </div>`;
    }).join('');
    if (colsHost) colsHost.innerHTML = body + empty;
    if (groupsHost) groupsHost.innerHTML = '';
  }
  // 只有筛选生效时才出数字：平时任务数只在分组 chip 上出现一次
  const count = $('#kb-count');
  if (count) count.textContent = (shown !== total && total) ? `筛选出 ${shown} / ${total} 张` : '';
  const clearBtn = $('#kb-clear-filters');
  if (clearBtn) clearBtn.hidden = !kbHasActiveFilters();
  return { shown, total };
}

function kbHasActiveFilters() {
  return !!(KB.status || KB.filters.q || KB.filters.assignee || KB.filters.tenant);
}
function kbResetFilters() {
  const hadTenant = !!KB.filters.tenant;
  KB.status = '';
  KB.filters.q = '';
  KB.filters.assignee = '';
  KB.filters.tenant = '';
  const q = $('#kb-search'), qc = $('#kb-search-clear');
  if (q) q.value = '';
  if (qc) qc.hidden = true;
  if ($('#kb-assignee')) $('#kb-assignee').value = '';
  if ($('#kb-tenant')) $('#kb-tenant').value = '';
  if (hadTenant) kanbanLoad(false);
  else renderKanban();
}

/** 打开「显示已归档」后把第 6 列带进视野：用户刚点开归档却什么都没变（那列在右侧
 *  视口外），等于按钮失灵。只在切开关这一次滚，日常渲染绝不抢滚动位置。
 *  关掉时回到最左：第六列没了，留在右端的空白位置看起来像五列丢了内容。 */
function kbScrollToArchived(on) {
  const sc = $('#kb-scroll') || document.querySelector('.kb-scroll');
  if (!sc) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const go = (left) => {
    try { sc.scrollTo({ left, behavior: reduce ? 'auto' : 'smooth' }); }
    catch { sc.scrollLeft = left; }
  };
  if (!on) { if (sc.scrollLeft > 0) go(0); return; }
  if (sc.scrollWidth <= sc.clientWidth + 1) return;
  go(sc.scrollWidth);
}

function renderKanban() {
  kbSyncSelects();
  renderKanbanHead();
  renderKanbanStatusbar();
  renderKanbanDock();
  renderKanbanBody();
  // 只保留错误条：「没有进行中的任务」这类提示交给列本身表达，
  // 再挂一条横幅等于把首屏又挤掉一行（五列的计数已经说得很清楚）。
  const msg = $('#kb-message');
  if (msg) { msg.hidden = !KB.error; if (KB.error) msg.textContent = KB.error; }
  renderRailKanban(); // 同一份数据，整页刷新时顺带把 rail 速览带新
}

/* ---- 右侧 rail 紧凑看板 -------------------------------------------------
   与整页共用 KB.board / kbGroups()，不另开 REST、不另起轮询。400px 放不下
   五列等分，所以排成「看板切换 + 状态筛选 + 方块卡片网格」：
     · 栏头是看板下拉，换板 = 改 KB.filters.board（走同一条 kanbanLoad）；
     · 状态 chip 只在本地过滤，点一下只看这一组、再点回到全部，不发请求；
     · 正文是按紧迫度分组的两列方块卡（宽度自适应 2–4 列），标题 4 行截断；
     · 折叠状态存 DOM，轮询重渲染不重置；每组最多 RKB_MAX_CARDS 张。
   写操作一律回完整看板页（详情抽屉挂在整页里），这里只留「新建任务 / 新建看板」
   两个全局弹窗入口，避免两处状态机各写一份。 */
/** 一屏两列 × 4 行：再多的卡就在详情抽屉里看，速览不负责穷举。 */
const RKB_MAX_CARDS = 8;
/** rail 的分组顺序：先看「在跑 / 卡住」的，再看排队与历史。
 *  整页五列仍用 KB_GROUPS 原序（那里是流程顺序，看得见全貌）；
 *  这里是速览，顺序应该按「我现在要关心什么」排。 */
const RKB_ORDER = Object.freeze(['running', 'blocked', 'ready', 'todo', 'done']);
function rkbOrdered(groups) {
  const idx = (k) => { const i = RKB_ORDER.indexOf(k); return i < 0 ? RKB_ORDER.length : i; };
  return groups.slice().sort((a, b) => idx(a.key) - idx(b.key));
}
/** '' = 全部；其余是 KB_GROUPS 的 key。纯渲染层状态，不进 KB.filters（别影响整页）。 */
let rkbFilter = '';
/** 看板下拉的候选指纹：只有候选 / 当前看板变了才重建选项，免得每 5 秒把展开的面板顶掉。 */
let rkbBoardSig = '';
/** 细粒度状态 → 行首色条：跟随所在分组的语义色，与整页 chip 永远一致。 */
function rkbDotFor(status) {
  const g = KB_GROUPS.find((x) => x.statuses.indexOf(status) >= 0);
  return g ? g.dot : 'muted';
}
/** 值得在行里单独标出来的细状态。组名已经说明的（待办 / 进行中）再标一遍是噪音，
 *  但「收集箱 / 已排期 / 待验收」跟组名不是一回事，漏掉就分不出卡处在哪一步。 */
const RKB_SUB_STATUS = Object.freeze(['triage', 'scheduled', 'review']);
/** 栏头的看板切换器。当前看板本身用「占位项」表示（选中它 = 不筛），所以要从候选里
 *  剔除，否则同一个看板会出现两行；候选末尾挂一个动作行，顺手给了新建看板的入口。 */
function rkbSyncBoardSwitch() {
  const el = $('#rkb-board');
  if (!el || typeof el.setOptions !== 'function') return;
  const o = KB.overview || {};
  const boards = (Array.isArray(o.boards) ? o.boards : []).map((x) => ({
    value: String((x && (x.slug || x.name)) || ''),
    label: String((x && (x.name || x.slug)) || '')
      + (Number(x && x.total) ? ` (${Number(x && x.total)})` : ''),
  })).filter((x) => x.value);
  const cur = String(KB.filters.board || o.currentBoard || '');
  const sig = JSON.stringify([boards, cur]);
  if (sig === rkbBoardSig) return;
  rkbBoardSig = sig;
  el.setOptions(
    boards.filter((x) => x.value !== cur)
      .concat([{ value: '__new-board', label: '＋ 新建看板…', action: true }]),
    // 占位项显示的就是看板名本身：多一个「看板 · 」前缀只是把这一行最要紧的字推远
    cur || '当前看板');
}
/** 一张方块卡（网格单元）：顶行 [状态点] [优先级] [细状态] …… [时效]，
 *  中间标题最多 3 行 + 摘要最多 3 行，底行受让人；运行中的卡在底边压一条
 *  2px 进度条（宽度走内联 --rkb-p）。
 *  方形卡如果只放标题和一行名字，中间会空出一大片——所以把整页卡片用的
 *  latest_summary / body 摘要也搬过来：有摘要时刚好填满，没摘要时留白当呼吸。 */
function rkbCardHtml(t) {
  const st = String((t && t.status) || '');
  const asg = String((t && t.assignee) || '').trim();
  const ago = kbAgo(t && t.created_at);
  const title = String((t && t.title) || '未命名任务');
  const stLabel = KB_STATUS_LABEL[st] || st;
  // 组名已经说明了状态（待办 / 进行中），只有更细的（收集箱 / 已排期 / 待验收）才标
  const sub = RKB_SUB_STATUS.indexOf(st) >= 0 ? stLabel : '';
  const pri = Number((t && t.priority) || 0);
  const pm = kbPriMeta(pri);
  const runStart = st === 'running' ? kbRunStart(t) : 0;
  const limit = runStart ? kbRunLimit(t) : 0;
  const sum = String((t && (t.latest_summary || t.body)) || '').trim();
  const time = runStart
    ? `<span class="rkb-run" data-kb-run="${runStart}" data-kb-run-max="${limit}"><span class="kb-run-txt">${esc(kbRunClockText(kbRunElapsed(runStart), limit))}</span></span>`
    : (ago ? `<span class="rkb-age">${esc(ago)}</span>` : '');
  const dot = rkbDotFor(st);
  const pct = runStart && limit ? Math.round(kbRunPct(kbRunElapsed(runStart), limit)) : 0;
  const tip = [title, stLabel || '未知状态', asg, ago].filter(Boolean).join(' · ');
  return `<button class="rkb-card${runStart ? ' is-running' : ''}" type="button"`
    + ` data-rkb-task="${esc((t && t.id) || '')}" data-dot="${esc(dot)}" title="${esc(tip)}"`
    + (pct ? ` style="--rkb-p:${pct}%"` : '') + '>'
    + '<span class="rkb-card-top">'
    + `<span class="rkb-dot" data-dot="${esc(dot)}"></span>`
    // 默认权重(0)不占位；其余用统一 P 级（P0 最紧急）
    + (pri > 0 ? `<span class="rkb-pri ${pm.rcls}" title="${esc(pm.title)}">${pm.tag}</span>` : '')
    + (sub ? `<span class="rkb-st">${esc(sub)}</span>` : '')
    + time
    + '</span>'
    + `<span class="rkb-title">${esc(title)}</span>`
    + (sum ? `<span class="rkb-sum">${esc(clip(sum, 160))}</span>` : '')
    + `<span class="rkb-card-bot">${asg ? `<span class="rkb-asg">${esc(asg)}</span>` : ''}</span>`
    + '</button>';
}
/** 组头右侧的折叠箭头：三个按钮已经是矢量图标了，箭头再用字符会跟字体基线打架。 */
const RKB_CARET = '<svg class="rkb-caret" viewBox="0 0 12 12" width="10" height="10" fill="none"'
  + ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true"><path d="M4.6 2.6 8 6l-3.4 3.4" /></svg>';
function rkbGroupHtml(g, state) {
  const tasks = g.all.slice(0, RKB_MAX_CARDS);
  const cards = tasks.map((t) => rkbCardHtml(t)).join('');
  const more = g.all.length > tasks.length
    ? `<button class="rkb-more" type="button" data-rkb-more="${esc(g.key)}">还有 ${g.all.length - tasks.length} 张 →</button>`
    : '';
  const body = cards ? `<div class="rkb-cards">${cards}</div>` : '<div class="rkb-none">这一组是空的</div>';
  // 进行中永远是这一屏的主角：组名给正文色 + 加粗，眼睛第一眼就落在上面
  const cls = `rkb-group-head${g.key === 'running' ? ' is-hot' : ''}`;
  const head = `<span class="rkb-dot" data-dot="${esc(g.dot)}"></span>`
    + `<span class="rkb-group-name">${esc(g.label)}</span>`
    + `<span class="rkb-group-num">${g.all.length}</span>`;
  // 按筛选只剩一组时不做折叠：点 chip 就是为了看卡片，再收起来没有意义
  if (state.flat) {
    return `<div class="rkb-group is-flat"><div class="${cls} is-static" title="${esc(g.hint)}">${head}</div>`
      + `${body}${more}</div>`;
  }
  // 首次渲染只展开「不是已完成」的组：已完成常常几十张，一进来就淹没在历史里
  const open = state.first ? (g.key !== 'done') : !!state.opened[g.key];
  return `<details class="rkb-group" data-rkb-group="${esc(g.key)}"${open ? ' open' : ''}>`
    + `<summary class="${cls}" title="${esc(g.hint)}">${head}${RKB_CARET}</summary>`
    + `${body}${more}</details>`;
}
function renderRailKanban() {
  const host = $('#rkb-groups');
  if (!host) return;
  const groups = rkbOrdered(kbGroups());
  const total = groups.reduce((n, g) => n + g.all.length, 0);
  const running = (groups.find((g) => g.key === 'running') || { all: [] }).all.length;
  rkbSyncBoardSwitch();
  // 比例条：一眼看出这个板是「一堆排队」还是「大半跑完」。
  // 只在有任务时画；空组不占灰段，否则零任务的看板会挂一条纯灰线。
  const meter = $('#rkb-meter');
  if (meter) {
    meter.innerHTML = total
      ? groups.filter((g) => g.all.length > 0).map((g) =>
        `<span class="rkb-seg" data-dot="${esc(g.dot)}" style="flex-grow:${g.all.length}"`
        + ` title="${esc(g.label)} ${g.all.length} 张"></span>`).join('')
      : '';
  }
  // 统计与筛选合一：点一下只看这一组，再点一次回到全部（本地过滤，不打 REST）
  const sum = $('#rkb-summary');
  if (sum) {
    const chip = (key, label, dot, n, tip) =>
      `<button class="rkb-stat${rkbFilter === key ? ' is-on' : ''}" type="button" data-rkb-group="${esc(key)}"`
      + (dot ? ` data-dot="${esc(dot)}"` : '')
      + ` aria-pressed="${rkbFilter === key ? 'true' : 'false'}" title="${esc(tip)}">`
      + (dot ? '<span class="rkb-dot"></span>' : '')
      + `${esc(label)}<b>${Number(n) || 0}</b></button>`;
    sum.innerHTML = chip('', '全部', '', total, '显示全部任务')
      + groups.map((g) => chip(g.key, g.label, g.dot, g.all.length, `${g.hint} · 点一下只看这一组`)).join('');
  }
  if (KB.error) {
    host.innerHTML = `<div class="rkb-empty"><div class="rkb-empty-main">${esc(KB.error)}</div></div>`;
  } else if (!KB.board) {
    host.innerHTML = '<div class="rkb-empty"><div class="rkb-empty-main">正在读取看板…</div></div>';
  } else {
    // 折叠状态存在 DOM 里：重渲染前读一次，避免每 5 秒同步把用户收起的组又打开。
    // 「首次」按有没有分组节点判断，不能按 host 是否为空 —— 加载态 / 空态占位会让
    // 数据回来时误判成非首次，五个组全被折叠。
    const opened = {};
    const existing = host.querySelectorAll('details.rkb-group');
    const first = existing.length === 0;
    existing.forEach((d) => { opened[d.dataset.rkbGroup] = d.open; });
    // 速览用 g.all：整页的搜索 / 受让人筛选不该悄悄改变这边的全局感。
    // 不筛选时把 0 张的组整个藏掉 —— 一排「暂无任务」在速览里只是占地方，
    // 想知道哪组是空的看上面的 chip 计数就够了；筛选时反而要留着（空态也是信息）。
    const shown = rkbFilter
      ? groups.filter((g) => g.key === rkbFilter)
      : groups.filter((g) => g.all.length > 0);
    host.innerHTML = shown.length
      ? shown.map((g) => rkbGroupHtml(g, { first, opened, flat: !!rkbFilter })).join('')
      : `<div class="rkb-empty">
          <div class="rkb-empty-ico">◫</div>
          <div class="rkb-empty-main">这个看板还没有任务</div>
          <div class="rkb-empty-hint">点栏头的 ＋ 新建一个，或打开完整看板批量拆分</div>
        </div>`;
  }
  const foot = $('#rkb-foot-text');
  if (foot) {
    // 筛选时脚注要说明「看到的是子集」：光看一组卡片会忘了全板还有多少
    const picked = groups.find((g) => g.key === rkbFilter);
    foot.textContent = KB.error || (!KB.board ? '等待数据'
      : picked ? `${picked.label} ${picked.all.length} 张 / 共 ${total} 张`
        // 「每 5 秒同步」在页签栏已经写着「实时同步」，脚注不再重复一遍
        : `${total} 张${running ? ` · 进行中 ${running}` : ''}`);
  }
  kbRunWatch(); // 运行中的卡在缩略视图里也要走表；没有可见节点会自停
}

/* ---- 任务详情抽屉 ---- */
function kbdMoreToggle(open) {
  const btn = $('#kbd-more'), menu = $('#kbd-menu');
  const on = !!open;
  if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  if (menu) menu.hidden = !on;
}
function closeKanbanDrawer() {
  const d = $('#kb-drawer'), m = $('#kb-drawer-mask'), mw = $('#kbd-more-wrap');
  kbdMoreToggle(false);
  if (mw) mw.hidden = true;
  if (d) d.hidden = true;
  if (m) m.hidden = true;
  KB.detailEpoch += 1;
  KB.detailId = '';
  KB.detail = null;
  document.querySelectorAll('.kb-card.sel').forEach((el) => el.classList.remove('sel'));
}
async function openKanbanTask(id, silent) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return;
  if (KB.dispatch.open) kbDispatchToggle(false);
  kbdMoreToggle(false);
  const a = kbApi();
  const my = ++KB.detailEpoch;
  KB.detailId = id;
  const d = $('#kb-drawer'), m = $('#kb-drawer-mask'), body = $('#kb-drawer-body');
  if (!d || !m || !body) return;
  d.hidden = false; m.hidden = false;
  document.querySelectorAll('.kb-card.sel').forEach((el) => el.classList.remove('sel'));
  const card = document.querySelector(`.kb-card[data-kb-task="${id}"]`);
  if (card) card.classList.add('sel');
  if (!silent) {
    const mw = $('#kbd-more-wrap');
    if (mw) mw.hidden = true;
    body.scrollTop = 0;
    body.innerHTML = '<div class="kbd-loading">读取任务详情…</div>';
  }
  if (!a || !a.kanbanTask) { body.innerHTML = '<div class="kbd-empty">需要 Hermes 桌面端才能读取任务详情</div>'; return; }
  try {
    const r = await a.kanbanTask(id, kbParams());
    if (my !== KB.detailEpoch || d.hidden) return;
    if (!r || !r.ok) { body.innerHTML = `<div class="kb-message">${esc((r && r.error) || '读取失败')}</div>`; return; }
    KB.detail = r;
    renderKanbanDetail(r);
  } catch (e) {
    if (my === KB.detailEpoch) body.innerHTML = `<div class="kb-message">${esc((e && e.message) || '读取失败')}</div>`;
  }
}
function kbdRow(label, value, time) {
  if (!value) return '';
  // 事件 payload 是对象：直接 String() 会拍成 "[object Object]"，日志就没意义了
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `<li class="kbd-row">${time ? `<time>${esc(time)}</time>` : ''}<b>${esc(label)}</b> ${esc(clip(text, 800))}</li>`;
}
/**
 * 运行中的卡片：点开抽屉最上方那块「profile 工作进度」。
 * 只读 task / runs / events 里已有的字段，不打额外接口 —— 卡片点开就能看到
 * 谁在跑（profile）、跑了多久、预算还剩多少、最近一步做了什么、这个 profile
 * 名下还有哪些卡在跑。秒表由 kbRunWatch 每秒推进，事件驱动的轮询再补文字。
 */
function kbRunPanel(t, d) {
  if (String((t && t.status) || '') !== 'running') return '';
  const start = kbRunStart(t);
  if (!start) return '';
  const limit = kbRunLimit(t);
  const elapsed = kbRunElapsed(start);
  const pct = kbRunPct(elapsed, limit).toFixed(1);
  const runs = Array.isArray(d && d.runs) ? d.runs : [];
  // 当前这次运行 = 状态还是 running 的最后一条；CLI 没给就退到最近一条
  const cur = runs.filter((r) => String((r && r.status) || '') === 'running').pop()
    || runs[runs.length - 1] || {};
  // profile 以 run.profile 为准（真正被拉起的 worker），没跑过 worker 时退回受让人
  const profile = String(cur.profile || t.assignee || '').trim();
  const facts = [];
  if (limit) facts.push(`上限 ${kbDur(limit)}`);
  const pg = t.progress;
  if (pg && Number(pg.total)) facts.push(`子任务 ${Number(pg.done) || 0}/${Number(pg.total)}`);
  const fails = Number(t.consecutive_failures) || 0;
  if (fails > 0) facts.push(`连续失败 ${fails} 次`);
  if (t.workspace_kind) facts.push(`工作区 ${String(t.workspace_kind)}`);
  const ev = (Array.isArray(d && d.events) && d.events.length) ? d.events[d.events.length - 1] : null;
  const evText = ev
    ? [
      String(ev.kind || 'event'),
      ev.payload ? clip(typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload), 160) : '',
      ev.created_at ? kbAgo(ev.created_at) : '',
    ].filter(Boolean).map((x) => esc(x)).join(' · ')
    : '';
  const summary = String(t.latest_summary || '').trim();
  const sibs = kbRunSiblings(t);
  const hot = limit && elapsed / limit >= 0.85;
  return `<div class="kbd-prog${hot ? ' is-hot' : ''}" data-kb-run="${start}" data-kb-run-max="${limit}">
    <div class="kbd-prog-head">
      <span class="kbd-prog-pulse" aria-hidden="true"></span>
      <span class="kbd-prog-who">${profile ? `<b>${esc(profile)}</b> 的工作进度` : '正在执行'}</span>
      ${cur.id ? `<span class="kbd-prog-run">运行 #${esc(String(cur.id))}</span>` : ''}
      <span class="kbd-prog-clock kb-run-txt">${esc(kbRunClockText(elapsed, limit))}</span>
    </div>
    ${limit ? `<div class="kbd-prog-bar kb-run-bar"><i style="width:${pct}%"></i></div>` : ''}
    ${facts.length ? `<div class="kbd-prog-facts">${facts.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
    ${evText ? `<div class="kbd-prog-now"><b>最近活动</b>${evText}</div>` : ''}
    ${summary ? `<div class="kbd-prog-now"><b>最新回报</b>${esc(clip(summary, 300))}</div>` : ''}
    ${sibs.length ? `<div class="kbd-prog-sibs">同 profile 还在跑 ${sibs.length} 张：
      ${sibs.map((x) => `<button class="kbd-link" type="button" data-kb-task="${esc(x.id)}">${esc(clip(String(x.title || x.id), 26))}</button>`).join('')}
    </div>` : ''}
  </div>`;
}
const kbDrafts = {};
function renderKanbanDetail(d) {
  const body = $('#kb-drawer-body');
  if (!body) return;
  const t = d.task || {};
  // 抽屉会随看板事件整体重渲染：先把手打了一半的评论存下来，渲染后填回，
  // 否则盯着运行进度时输入框会被一次同步清空。
  const draftEl = $('#kbd-comment-input');
  if (draftEl && t.id) kbDrafts[String(t.id)] = draftEl.value;
  const meta = [];
  // 与卡片一致：显示归组后的中文状态，CLI 原值留在 title 里，免得同一个 triage
  // 在卡片上叫「收集箱」、在抽屉里叫「triage」
  if (t.status) meta.push(`<span class="kb-chip st" title="CLI 状态：${esc(t.status)}">${esc(KB_STATUS_LABEL[t.status] || t.status)}</span>`);
  if (Number(t.priority)) { const pm = kbPriMeta(t.priority); meta.push(`<span class="kb-chip pri ${pm.cls}" title="${esc(pm.title)}">${pm.tag}</span>`); }
  if (t.assignee) meta.push(kbAssigneeChip(t.assignee));
  if (t.tenant) meta.push(`<span class="kb-chip">${esc(t.tenant)}</span>`);
  if (t.created_at) meta.push(`<span class="kb-chip">创建 ${esc(kbTime(t.created_at))}</span>`);
  if (t.completed_at) meta.push(`<span class="kb-chip">完成 ${esc(kbTime(t.completed_at))}</span>`);

  const jump = /^[A-Za-z0-9_-]{1,80}$/.test(String(t.session_id || ''))
    ? `<div class="kbd-section"><button class="kbd-link" type="button" data-kb-session="${esc(t.session_id)}">↗ 跳转到关联会话 ${esc(String(t.session_id).slice(0, 12))}…</button></div>` : '';
  // 工作区：worker 实际在哪干活。scratch/dir/worktree 三种；合进一张紧凑键值表
  const WS_KIND_LABEL = {
    scratch: '临时沙箱（scratch）',
    dir: '指定目录（dir）',
    worktree: 'git worktree（隔离副本）',
  };
  const projMap = {};
  for (const p of ((KB.overview && Array.isArray(KB.overview.projects)) ? KB.overview.projects : [])) {
    projMap[String(p.id || '')] = String(p.name || p.slug || '');
    projMap[String(p.slug || '')] = String(p.name || p.slug || '');
  }
  const wsRows = [
    ['类型', WS_KIND_LABEL[String(t.workspace_kind || 'scratch')] || String(t.workspace_kind || '')],
    ['路径', t.workspace_path ? String(t.workspace_path) : ''],
    ['分支', t.branch_name ? String(t.branch_name) : ''],
    ['项目', t.project_id ? (projMap[String(t.project_id)] || String(t.project_id)) : '（未绑定）'],
  ].filter((r) => r[1]);
  const wsHtml = `<div class="kbd-section"><h3>工作区</h3><dl class="kbd-kv">${
    wsRows.map((r) => `<div class="kbd-kv-row"><dt>${esc(r[0])}</dt><dd class="kbd-val">${esc(r[1])}</dd></div>`).join('')
  }</dl></div>`;
  const links = d.links || {};
  const linkRows = [
    ...(links.parents || []).map((x) => `<li class="kbd-row">父任务 <button class="kbd-link" type="button" data-kb-task="${esc(x)}">${esc(x)}</button></li>`),
    ...(links.children || []).map((x) => `<li class="kbd-row">子任务 <button class="kbd-link" type="button" data-kb-task="${esc(x)}">${esc(x)}</button></li>`),
  ].join('');
  const comments = (d.comments || []).slice().reverse().map((c) =>
    kbdRow(String(c.author || 'agent') + '：', c.body, kbTime(c.created_at))).join('');
  const events = (d.events || []).slice().reverse().slice(0, 20).map((e) =>
    kbdRow(String(e.kind || 'event'), e.payload, kbTime(e.created_at))).join('');
  const runs = (d.runs || []).slice().reverse().map((r) =>
    kbdRow(`#${r.id} ${r.status || ''}`, [r.outcome, r.error].filter(Boolean).join(' · '), kbTime(r.started_at))).join('');
  const atts = (d.attachments || []).map((x) =>
    kbdRow('附件', `${x.filename} (${Number(x.size) || 0} B)`)).join('');
  const canDelete = /^t_[A-Za-z0-9_-]{1,64}$/.test(String(t.id || ''));
  const mw = $('#kbd-more-wrap');
  if (mw) mw.hidden = !canDelete;
  const canSubmit = canDelete && KB_DP_SUBMITTABLE.includes(String(t.status || ''));
  const dispatchAct = canSubmit
    ? `<div class="kbd-actions" id="kbd-actions"><button class="kb-btn kb-btn-accent" type="button" data-kb-submit="${esc(t.id)}" title="推进到 ready，等待调度器认领">⚡ 提交派发</button></div>` : '';
  const curSt = String(t.status || '');
  const isTriage = curSt === 'triage';
  const curGroup = KB_GROUPS.find((g) => g.statuses.includes(curSt));
  const moveRow = canDelete && curGroup
    ? `<div class="kbd-actions" id="kbd-actions-move"><span>移到</span>${
        KB_GROUPS.filter((g) => g.key !== curGroup.key).map((g) => {
          const verb = KB_GROUP_STATUS[g.key] || '';
          return `<button class="kb-btn" type="button" data-kb-move="${esc(verb)}" title="${esc(KB_STATUS_ACTION[verb] || g.label)}">${esc(g.label)}</button>`;
        }).join('')
      }</div>`
    : '';
  const specifyAct = canDelete && isTriage
    ? `<div class="kbd-actions" id="kbd-actions-specify">
        <button class="kb-btn" type="button" data-kb-specify="${esc(t.id)}"${KB.specifyBusy ? ' disabled' : ''} title="让辅助模型把这句随手记补成 Goal / Approach / 验收标准，并推进到待办（会产生费用）">✎ 补规格</button>
        <span class="kbd-act-note">${KB.specifyBusy ? '补规格中…最长 2 分钟' : ''}</span>
      </div>` : '';
  const estView = KB.estimate[String(t.id || '')];
  const estimateAct = canDelete
    ? `<div class="kbd-actions" id="kbd-actions-estimate">
        <button class="kb-btn" type="button" data-kb-estimate="${esc(t.id)}"${KB.estimateBusy ? ' disabled' : ''} title="按「读文件 + 工具调用 + 改代码 + 重试」估一次 token 量级（约几百 token 开销，不改任务）">⌛ 估算</button>
        <span class="kbd-act-note" id="kbd-estimate-note">${estView ? esc(kbEstimateLine(estView)) : (KB.estimateBusy ? '估算中…' : '')}</span>
      </div>` : '';
  const decomposeAct = canDelete && isTriage
    ? `<div class="kbd-actions" id="kbd-actions-decompose">
        <button class="kb-btn" type="button" data-kb-decompose="${esc(t.id)}"${KB.decomposeBusy ? ' disabled' : ''} title="${KB.mode && KB.mode.mode === 'auto'
          ? '让辅助模型把这张卡拆成子任务图并按 profile 分派（会产生费用；自动编排本来也会拆）'
          : '让辅助模型把这张卡拆成子任务图并按 profile 分派（会产生费用）'}">⚗ 拆解</button>
        <span class="kbd-act-note">${KB.decomposeBusy ? '拆解中…最长 3 分钟' : ''}</span>
      </div>` : '';
  const actBar = [estimateAct, specifyAct, decomposeAct, dispatchAct].filter(Boolean).join('');
  // 改派：拖拽的等价入口（拖拽仍在，但抽屉里要有不靠鼠标的路径）。
  // done / archived 再改派没有意义，直接不显示。
  const canReassign = canDelete && !['done', 'archived'].includes(String(t.status || ''));
  const reassignAct = canReassign
    ? `<div class="kbd-section" id="kbd-reassign"><h3>改派受让人</h3>
        <div class="kbd-reassign">
          <hm-select id="kbd-assignee" class="ui-select" aria-label="改派受让人"></hm-select>
          <button class="kb-btn" type="button" data-kb-reassign="${esc(t.id)}">保存改派</button>
        </div>
        <div class="kbd-reassign-note" id="kbd-reassign-note">受让人 = profile 名（<code>hermes -p &lt;名字&gt;</code>），留空取消指派。</div>
      </div>` : '';
  // 评论输入：追加文本、不计费、不改状态；发布仍过一次确认（与全部写操作一致）。
  const commentBox = canDelete
    ? `<div class="kbd-comment-box" id="kbd-comment-box">
        <textarea id="kbd-comment-input" rows="3" maxlength="4000"
          placeholder="给这张卡写条评论（worker 与看板都会看到）…"></textarea>
        <div class="kbd-comment-foot">
          <span class="kbd-hint">追加一条文本 · 不计费 · 不改状态</span>
          <button class="kb-btn" type="button" data-kb-comment="${esc(t.id)}">发布评论</button>
        </div>
      </div>` : '';

  body.innerHTML = `
    <div class="kbd-eyebrow"><span class="kbd-id">${esc(t.id || '')}</span><div class="kbd-meta">${meta.join('')}</div></div>
    <div class="kbd-title-row">
      <h2 class="kbd-title">${esc(t.title || '(无标题)')}</h2>
      ${canDelete ? `<button class="kb-btn kbd-edit-btn" type="button" data-kb-edit="${esc(t.id)}">✎ 编辑</button>` : ''}
    </div>
    ${canDelete ? `<div class="kbd-edit-form" id="kbd-edit-form" hidden>
      <label class="kb-frow"><span>标题</span><input id="kbd-edit-title" type="text" maxlength="200" value="${esc(t.title || '')}" /></label>
      <label class="kb-frow"><span>优先级</span><hm-select id="kbd-edit-priority" class="ui-select"><option value="0">P4 · 普通（默认）</option><option value="1">P3 · 低优先级</option><option value="2">P2 · 中优先级</option><option value="3">P1 · 高优先级</option><option value="10">P0 · 最紧急</option></hm-select></label>
      <label class="kb-frow"><span>描述</span><textarea id="kbd-edit-body" rows="4" maxlength="4000">${esc(t.body || '')}</textarea></label>
      <div class="kbd-actions">
        <button class="kb-btn primary" type="button" data-kb-edit-save="${esc(t.id)}">保存修改</button>
        <button class="kb-btn" type="button" data-kb-edit-cancel="1">取消</button>
      </div>
    </div>` : ''}
    ${kbRunPanel(t, d)}
    ${actBar ? `<div class="kbd-act-bar">${actBar}</div>` : ''}
    ${canDelete ? '<div class="kbd-danger" id="kbd-danger"></div>' : ''}
    ${moveRow}
    ${reassignAct}
    ${wsHtml}
    ${jump}
    ${t.body ? `<div class="kbd-section"><h3>描述</h3><pre class="kbd-text">${esc(clip(t.body, 12000))}</pre></div>` : ''}
    ${t.result || t.latest_summary ? `<div class="kbd-section"><h3>结果 / 交接</h3><pre class="kbd-text">${esc(clip(t.result || t.latest_summary, 12000))}</pre></div>` : ''}
    <div class="kbd-section"><h3>依赖 (${(links.parents || []).length + (links.children || []).length})</h3>
      ${linkRows ? `<ul class="kbd-list">${linkRows}</ul>` : '<div class="kbd-empty">无父子依赖</div>'}</div>
    <div class="kbd-section"><h3>评论 (${(d.comments || []).length})</h3>
      ${comments ? `<ul class="kbd-list">${comments}</ul>` : '<div class="kbd-empty">暂无评论</div>'}
      ${commentBox}</div>
    <div class="kbd-section"><h3>运行记录 (${(d.runs || []).length})</h3>
      ${runs ? `<ul class="kbd-list">${runs}</ul>` : '<div class="kbd-empty">尚无运行记录</div>'}</div>
    <div class="kbd-section">
      <div class="kbd-log-head"><h3>执行日志</h3><button class="kb-btn kbd-log-btn" type="button" data-kb-log="${esc(t.id)}">查看日志</button></div>
      <div class="kbd-empty" id="kbd-log-meta">按需读取 worker stdout/stderr 尾部输出</div>
      <pre class="kbd-log" id="kbd-log-body" hidden></pre>
    </div>
    ${atts ? `<div class="kbd-section"><h3>附件</h3><ul class="kbd-list">${atts}</ul></div>` : ''}
    <div class="kbd-section"><h3>最近事件</h3>
      ${events ? `<ul class="kbd-list">${events}</ul>` : '<div class="kbd-empty">暂无事件</div>'}</div>`;

  // 改派下拉的候选：磁盘上真实存在的 profile 优先；当前受让人即使不在清单里也要能显示出来
  const editPri = $('#kbd-edit-priority');
  if (editPri && canDelete) {
    const curPri = String(Number(t.priority) || 0);
    const items = KB_PRI_OPTIONS.map(([v, l]) => ({ value: v, label: l }));
    if (!KB_PRI_OPTIONS.some(([v]) => v === curPri)) items.push({ value: curPri, label: `${kbPriMeta(curPri).tag}（权重 ${curPri}）` });
    if (editPri.setOptions) editPri.setOptions(items);
    editPri.value = curPri;
  }
  const sel = $('#kbd-assignee');
  if (sel && canReassign) {
    const cur = String(t.assignee || '');
    const names = [...new Set([...(cur ? [cur] : []), ...[...kbProfileSet()].sort()])];
    const items = names.map((n) => ({
      value: n,
      label: kbProfileSet().has(n) || !kbProfileSet().size ? n : `${n}（非 profile）`,
    }));
    if (sel.setOptions) sel.setOptions(items, cur ? '取消指派（留空）' : '未指派 · 选择 profile');
    if (cur) sel.value = cur;
  }
  // 草稿填回（只在重渲染之间保命，发送成功后由提交处清掉）
  const draftBox = $('#kbd-comment-input');
  const draft = kbDrafts[String(t.id || '')];
  if (draftBox && draft) draftBox.value = draft;
  // running 才需要秒表；渲染完立刻推一次，避免首帧停在模板里的 0:00
  if (String(t.status || '') === 'running') kbRunWatch();
}
/**
 * 拆解此任务（抽屉里的 ⚗ 按钮）。
 *
 * 这条链路是桌面端唯一会花 LLM 钱的写操作，所以三道闸：
 *   ① 只在收集箱（triage）任务上出现 —— 后端对其余状态直接 ok:false；
 *   ② 点击先出确认卡，写清「调辅助模型 / 会计费 / 最长 3 分钟」；
 *   ③ 服务层再独立校验 confirm === true，任何顺手调用都发不出请求。
 * 在途期间按钮禁用 + 全局 KB.decomposeBusy，避免连点拆两次、计两份费。
 */
async function kbSaveTaskEdit(taskId) {
  const id = String(taskId || '');
  const a = kbApi();
  if (!a || !a.kanbanUpdateTask) { toast('此页需要 Hermes 桌面端才能编辑任务', 1800); return; }
  const titleEl = $('#kbd-edit-title'), priEl = $('#kbd-edit-priority'), bodyEl = $('#kbd-edit-body');
  const title = titleEl ? titleEl.value.trim() : '';
  if (!title) { toast('任务标题不能为空', 2000); if (titleEl) titleEl.focus(); return; }
  const priRaw = priEl ? Number(priEl.value) : 0;
  const priority = Number.isFinite(priRaw) ? Math.max(0, Math.min(100, Math.round(priRaw))) : 0;
  const body = bodyEl ? bodyEl.value : '';
  const saveBtn = document.querySelector('[data-kb-edit-save]');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const r = await a.kanbanUpdateTask(id, { board: KB.filters.board || '', title, priority, body });
    if (!r || !r.ok) {
      toast('保存失败：' + ((r && r.error) || '未知错误'), 2800);
      if (saveBtn && saveBtn.isConnected) saveBtn.disabled = false;
      return;
    }
    toast('任务已更新', 1600);
    await kanbanLoad(true);
    await openKanbanTask(id, true);
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || '未知错误'), 2800);
    if (saveBtn && saveBtn.isConnected) saveBtn.disabled = false;
  }
}

async function kbLoadTaskLog(taskId) {
  const id = String(taskId || '');
  const a = kbApi();
  const meta = $('#kbd-log-meta'), pre = $('#kbd-log-body'), btn = document.querySelector('[data-kb-log]');
  if (!a || !a.kanbanTaskLog) { toast('此页需要 Hermes 桌面端才能读取日志', 1800); return; }
  if (btn) btn.disabled = true;
  if (meta) meta.textContent = '读取日志中…';
  try {
    const r = await a.kanbanTaskLog(id, { board: KB.filters.board || '', tail: 32768 });
    if (!r || !r.ok) {
      if (meta) meta.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      return;
    }
    if (!r.exists || !r.content) {
      if (meta) meta.textContent = '暂无执行日志（任务可能尚未启动过 worker）';
      if (pre) { pre.hidden = true; pre.textContent = ''; }
    } else {
      if (meta) meta.textContent = `日志大小 ${r.sizeBytes} B${r.truncated ? '（已截取末尾 32 KB）' : ''}`;
      if (pre) { pre.hidden = false; pre.textContent = r.content; }
    }
    if (btn && btn.isConnected) btn.textContent = '刷新日志';
  } catch (e) {
    if (meta) meta.textContent = '读取失败：' + ((e && e.message) || '未知错误');
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

function kbDecomposeTask(taskId, host) {
  const id = String(taskId || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  if (KB.decomposeBusy) { toast('已经有一次拆解在进行中', 1600); return; }
  const a = kbApi();
  if (!host || !a || !a.kanbanDecompose) { toast('此页需要 Hermes 桌面端才能拆解任务', 1800); return; }
  opConfirm(host, {
    title: '拆解这张任务？',
    cmd: `POST /api/plugins/kanban/tasks/${id}/decompose`,
    note: '会调用 CLI 的辅助模型（auxiliary.kanban_decomposer）把这张卡拆成一棵子任务图，'
      + '按各 profile 的描述分派。这一步会消耗 token 并计费，最长可能跑 3 分钟。'
      + '拆完根任务会离开收集箱，子任务出现在各列；如果模型判断它本来就是单一任务，'
      + '就只改写标题与规格、留在原地。',
    confirmLabel: '开始拆解',
    onGo: async () => {
      const act = $('#kbd-actions-decompose');
      const note = act && act.querySelector('.kbd-act-note');
      const btn = act && act.querySelector('[data-kb-decompose]');
      const say = (text, bad) => {
        if (!note) return;
        note.textContent = text;
        note.classList.toggle('warn', !!bad);
      };
      KB.decomposeBusy = true;
      if (btn) btn.disabled = true;
      say('拆解中…最长 3 分钟，可以先去别的列看看', false);
      try {
        const r = await a.kanbanDecompose(id, { board: KB.filters.board || '', confirm: true });
        if (!r || !r.ok) {
          const why = (r && (r.reason || r.error)) || '未知原因';
          say('拆解未完成：' + why, true);
          toast('拆解未完成：' + why, 3200);
          return;
        }
        if (r.fanout && r.childIds && r.childIds.length) {
          toast(`已拆成 ${r.childIds.length} 个子任务：${r.childIds.join('、')}`, 3600);
        } else if (r.single) {
          toast(r.newTitle ? `模型判断这已是单一任务，标题改为「${r.newTitle}」` : '模型判断这已是单一任务，已改写规格', 3600);
        } else {
          toast('拆解完成，但模型没有给出子任务', 3000);
        }
        await kanbanLoad(true);       // 写后回读：根任务换列 + 子任务出现在各列
        await openKanbanTask(id, true); // 抽屉保持打开，依赖区能看到新建的子任务
      } catch (e) {
        const why = (e && e.message) || '未知错误';
        say('拆解失败：' + why, true);
        toast('拆解失败：' + why, 3000);
      } finally {
        KB.decomposeBusy = false;
        // 抽屉可能已被重绘（按钮是新的），禁用态由渲染时读 KB.decomposeBusy 决定，
        // 这里只兜底恢复仍挂在 DOM 上的那个旧节点
        if (btn && btn.isConnected) btn.disabled = false;
      }
    },
  });
}

/**
 * 估算结果的一行文案：`复杂度 M · 约 4.2 万 tokens · 要改两三处并补测试`。
 * 空字段一律跳过 —— CLI 的 complexity / rationale 都可能是 null。
 */
function kbKilo(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 10000) return String(Math.round(v / 1000) / 10) + ' 万';
  if (v >= 1000) return String(Math.round(v / 100) / 10) + 'k';
  return String(v);
}
function kbEstimateLine(e) {
  const o = e && typeof e === 'object' ? e : {};
  const parts = [];
  if (o.complexity) parts.push(`复杂度 ${o.complexity}`);
  if (Number(o.estTokens) > 0) parts.push(`约 ${kbKilo(o.estTokens)} tokens`);
  const head = parts.join(' · ') || '估算完成';
  return o.rationale ? `${head} · ${o.rationale}` : head;
}

/**
 * 补规格（抽屉里的 ✎ 按钮）：把收集箱里的一句话扩成可执行的 spec，
 * **CLI 会顺手把任务推进到待办**（triage → todo），所以它是「写数据 + 计费」双属性。
 * 与拆解同样的三道闸：只认 triage、点击先过确认卡、服务层再校验 confirm === true。
 */
function kbSpecifyTask(taskId, host) {
  const id = String(taskId || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  if (KB.specifyBusy) { toast('已经有一次补规格在进行中', 1600); return; }
  const a = kbApi();
  if (!host || !a || !a.kanbanSpecify) { toast('此页需要 Hermes 桌面端才能补规格', 1800); return; }
  opConfirm(host, {
    title: '让模型补全这张卡的规格？',
    cmd: `POST /api/plugins/kanban/tasks/${id}/specify`,
    note: '会调用 CLI 的辅助模型（auxiliary.triage_specifier）把标题收紧、正文补成 '
      + 'Goal / Approach / 验收标准 / 不做的事 四段，然后把任务从收集箱推进到待办。'
      + '这一步会消耗 token 并计费，最长约 2 分钟。模型只补全、不改需求；'
      + '原文已经写得够细时只重排格式。',
    confirmLabel: '开始补规格',
    onGo: async () => {
      const act = $('#kbd-actions-specify');
      const note = act && act.querySelector('.kbd-act-note');
      const btn = act && act.querySelector('[data-kb-specify]');
      const say = (text, bad) => {
        if (!note) return;
        note.textContent = text;
        note.classList.toggle('warn', !!bad);
      };
      KB.specifyBusy = true;
      if (btn) btn.disabled = true;
      say('补规格中…最长 2 分钟', false);
      try {
        const r = await a.kanbanSpecify(id, { board: KB.filters.board || '', confirm: true });
        if (!r || !r.ok) {
          const why = (r && (r.reason || r.error)) || '未知原因';
          say('补规格未完成：' + why, true);
          toast('补规格未完成：' + why, 3200);
          return;
        }
        toast(r.newTitle
          ? `已补规格并推进到待办，标题改为「${r.newTitle}」`
          : '已补规格并推进到待办', 3600);
        await kanbanLoad(true);        // 状态变了：收集箱少一张、待办多一张
        await openKanbanTask(id, true); // 抽屉保持打开，能看到新正文
      } catch (e) {
        const why = (e && e.message) || '未知错误';
        say('补规格失败：' + why, true);
        toast('补规格失败：' + why, 3000);
      } finally {
        KB.specifyBusy = false;
        if (btn && btn.isConnected) btn.disabled = false;
      }
    },
  });
}

/**
 * 估算工作量（抽屉里的 ⌛ 按钮）：只读一次辅助模型，返回 token 量级 + S/M/L。
 * 不改任何字段，所以不需要回读看板，只把结果就地写进说明行并缓存。
 */
function kbEstimateTask(taskId, host) {
  const id = String(taskId || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  if (KB.estimateBusy) { toast('已经有一次估算在进行中', 1600); return; }
  const a = kbApi();
  if (!host || !a || !a.kanbanEstimate) { toast('此页需要 Hermes 桌面端才能估算', 1800); return; }
  opConfirm(host, {
    title: '估一下这张卡有多大？',
    cmd: `POST /api/plugins/kanban/tasks/${id}/estimate`,
    note: '会调用一次辅助模型（kanban_estimator）估出整轮 agent run 的 token 量级与 S/M/L 复杂度。'
      + '只花几百 token，是三条计费路径里最便宜的，并且不会修改任何字段 —— 这张卡还是原样。',
    confirmLabel: '开始估算',
    onGo: async () => {
      const act = $('#kbd-actions-estimate');
      const note = act && (act.querySelector('#kbd-estimate-note') || act.querySelector('.kbd-act-note'));
      const btn = act && act.querySelector('[data-kb-estimate]');
      const say = (text, bad) => {
        if (!note) return;
        note.textContent = text;
        note.classList.toggle('warn', !!bad);
      };
      KB.estimateBusy = true;
      if (btn) btn.disabled = true;
      say('估算中…最长 1 分钟', false);
      try {
        const r = await a.kanbanEstimate(id, { board: KB.filters.board || '', confirm: true });
        if (!r || !r.ok) {
          const why = (r && (r.reason || r.error)) || '未知原因';
          say('估算没成功：' + why, true);
          toast('估算没成功：' + why, 3000);
          return;
        }
        const view = {
          estTokens: Math.max(0, Math.round(Number(r.estTokens || r.est_tokens) || 0)),
          complexity: String(r.complexity || ''),
          rationale: String(r.rationale || ''),
          model: String(r.model || ''),
        };
        KB.estimate[id] = view; // 同一张卡重开抽屉不必再花一次钱
        say(kbEstimateLine(view), false);
        toast('估算完成：' + kbEstimateLine(view), 3000);
      } catch (e) {
        const why = (e && e.message) || '未知错误';
        say('估算失败：' + why, true);
        toast('估算失败：' + why, 3000);
      } finally {
        KB.estimateBusy = false;
        if (btn && btn.isConnected) btn.disabled = false;
      }
    },
  });
}

/**
 * 发布评论（抽屉评论区）：追加文本，不计费、不改状态、永不覆盖已有内容。
 * 与其余写操作一致，发布前过一次确认卡（写清「作者记为 dashboard」）；
 * 成功后重读任务详情，评论列表就地刷新。
 */
function kbAddComment(taskId) {
  const id = String(taskId || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  const input = $('#kbd-comment-input');
  const box = $('#kbd-comment-box');
  const text = input ? String(input.value || '').trim() : '';
  if (!text) { toast('先写点什么再发布', 1600); if (input) input.focus(); return; }
  const a = kbApi();
  // 确认卡挂在评论框内：抽屉很长，挂 body 末尾会掉到可视区外
  const host = box || $('#kb-drawer-body');
  if (!host || !a || !a.kanbanAddComment) { toast('此页需要 Hermes 桌面端才能发评论', 1800); return; }
  const clip = text.length > 60 ? text.slice(0, 60) + '…' : text;
  opConfirm(host, {
    title: '发布这条评论？',
    cmd: `POST /api/plugins/kanban/tasks/${id}/comments`,
    note: `追加一条评论（作者记为 dashboard）：「${clip}」。不计费、不改状态，发布后不能撤回。`,
    confirmLabel: '发布评论',
    onGo: async () => {
      const btn = box && box.querySelector('[data-kb-comment]');
      if (btn) btn.disabled = true;
      try {
        const r = await a.kanbanAddComment(id, { board: KB.filters.board || '', body: text });
        if (!r || !r.ok) {
          toast('评论没发出去：' + ((r && r.error) || '未知错误'), 3000);
          if (btn && btn.isConnected) btn.disabled = false;
          return;
        }
        toast('评论已发布', 1600);
        // 先清空输入框再重读：否则 renderKanbanDetail 会把刚发出去的内容又当草稿存回来
        const sent = $('#kbd-comment-input');
        if (sent) sent.value = '';
        delete kbDrafts[String(id)]; // 发出去了就不再当草稿保留
        await openKanbanTask(id, true); // 重读详情，评论列表就地刷新
      } catch (e) {
        toast('评论失败：' + ((e && e.message) || '未知错误'), 3000);
        if (btn && btn.isConnected) btn.disabled = false;
      }
    },
  });
}

/** 抽屉里的「保存改派」：只写 assignee，不推进状态（推进 ready 走「提交派发」）。 */
async function kbReassignTask(taskId, host) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(taskId || ''))) return;
  const sel = $('#kbd-assignee'), note = $('#kbd-reassign-note');
  const name = sel ? String(sel.value || '').trim() : '';
  const say = (text, bad) => {
    if (!note) return;
    note.textContent = text;
    note.classList.toggle('warn', !!bad);
  };
  if (name && !KB_ASSIGNEE_RE.test(name)) {
    say('受让人必须是合法的 profile 名（字母或数字开头，可含 . _ -）', true);
    return;
  }
  const a = kbApi();
  if (!a || !a.kanbanReassign) { say('此页需要桌面端才能改派', true); return; }
  const btn = host && host.querySelector('[data-kb-reassign]');
  if (btn) btn.disabled = true;
  try {
    const r = await a.kanbanReassign(taskId, { assignee: name, board: KB.filters.board || '' });
    if (!r || !r.ok) { say('改派失败：' + ((r && r.error) || '未知错误'), true); return; }
    say(name ? `已改派给 ${name}` : '已取消指派', false);
    await kanbanLoad(true);          // 写后回读：卡片受让人 chip 跟着变
    await openKanbanTask(taskId, true); // 抽屉保持打开，内容刷新
  } catch (e) {
    say('改派失败：' + ((e && e.message) || '未知错误'), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
function kbJumpToSession(sid) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(sid || ''))) return;
  closeKanbanPage();
  try { openSession(String(sid)); toast('已跳转到关联会话', 1400); }
  catch (e) { toast('跳转失败：' + (e.message || ''), 1800); }
}

/* ---- 删除任务（二次确认卡） ---- */
function kbDeleteTask(id, host) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return;
  const a = kbApi();
  if (!host || !a || !a.kanbanDeleteTask) { toast('此页需要 Hermes 桌面端才能删除任务', 1800); return; }
  opConfirm(host, {
    title: '删除这个任务？',
    cmd: `DELETE /api/plugins/kanban/tasks/${id}`,
    note: '任务、评论、事件与依赖关系会从 CLI 的 kanban.db 一起移除，不可撤销。不会改动 CLI 配置，也不会停止任何正在运行的 worker。',
    confirmLabel: '确认删除',
    onGo: async () => {
      const r = await a.kanbanDeleteTask(id, kbParams());
      if (!r || !r.ok) { toast('删除失败：' + ((r && r.error) || '未知错误'), 2600); return; }
      closeKanbanDrawer();
      toast('任务已删除', 1600);
      await kanbanLoad(true); // 写后回读
    },
  });
}

/* ---- 派发控制台：试运行 → 二次确认 → 真派发 → 写后回读 ---- */
const KB_DP_SUBMITTABLE = ['triage', 'todo', 'scheduled', 'blocked', 'review'];
function kbDpState(text, cls) {
  const el = $('#kb-dp-state');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'kb-dp-state' + (cls ? ' ' + cls : '');
}
function kbDpClearConfirm() {
  const host = $('#kb-dp-confirm');
  if (host) host.querySelectorAll('.op-confirm').forEach((n) => n.remove());
}
/**
 * 派发容量：CLI 的 max_spawn 是「本看板并发上限（running + 本次）」，不是本次批量。
 * 所以先按本地上限减去已在跑的 worker，算出本次真正能新增几个。
 */
function kbDispatchCapacity() {
  // 上限语义与 CLI dispatch_once 对齐：max_spawn 是「本看板并发上限（running + 本次）」，
  // CLI 的 POST /dispatch 默认 max=8，这里不再人为砍到 4；本地上限只截到 8。
  const max = Math.max(1, Math.min(8, Number($('#kb-dp-max') && $('#kb-dp-max').value) || 1));
  const tasks = KB.board ? (KB.board.columns || []).flatMap((c) => c.tasks || []) : [];
  const running = tasks.filter((t) => String(t.status || '') === 'running').length;
  const ready = tasks.filter((t) => {
    const s = String(t.status || '');
    return (s === 'ready' || s === 'review') && !!t.assignee;
  });
  const candidates = [...new Set(ready.map((t) => String(t.assignee)))];
  const nonProfiles = candidates.filter((a) => !kbIsProfile(a));
  return { max, running, room: Math.max(0, max - running), ready: ready.length, candidates, nonProfiles };
}
function kbRenderCapacity() {
  const host = $('#kb-dp-cap');
  const run = $('#kb-dp-run');
  if (!host) return;
  const c = kbDispatchCapacity();
  const bits = [
    `并发上限 ${c.max}`,
    `当前在跑 ${c.running}`,
    c.room ? `本次最多新增 ${c.room}` : '并发已满，本次不会启动新 worker',
  ];
  if (c.ready) bits.push(`ready/待复审 ${c.ready} 张（受让人 ${c.candidates.join(' / ')}）`);
  if (c.nonProfiles.length) bits.push(`其中 ${c.nonProfiles.join(' / ')} 不是 profile，会被跳过`);
  host.textContent = bits.join(' · ');
  host.classList.toggle('warn', !c.room || c.nonProfiles.length > 0);
  if (run) {
    const blocked = !c.room;
    run.disabled = blocked;
    run.title = blocked
      ? `本看板已有 ${c.running} 个 worker 在跑，达到并发上限 ${c.max}；调高上限或等它们结束后再派发`
      : '';
  }
}
function kbDispatchToggle(show) {
  const panel = $('#kb-dispatch-panel'), mask = $('#kb-dp-mask');
  const on = !!show;
  if (on) closeKanbanDrawer();
  KB.dispatch.open = on;
  KB.dispatch.epoch += 1; // 收起时作废所有在途响应
  kbDpClearConfirm();
  if (panel) panel.hidden = !on;
  if (mask) mask.hidden = !on;
  // 菜单项是唯一的入口（页头按钮已收进「⋯」），它的文字跟着开合状态走
  const item = document.querySelector('#kb-more-menu [data-kb-more="dispatch"]');
  if (item) {
    item.setAttribute('aria-expanded', on ? 'true' : 'false');
    item.textContent = on ? '收起派发控制台' : '手动派发控制台';
  }
  if (on) { kbDpState('控制台已就绪', ''); kbDispatchLoadWorkers(); kbRenderCapacity(); }
  else { kbDpState('', ''); KB.dispatch.busy = false; }
}
async function kbDispatchLoadWorkers() {
  const host = $('#kb-dp-workers');
  if (!host || !KB.dispatch.open) return;
  const a = kbApi(), my = KB.dispatch.epoch;
  if (!a || !a.kanbanActiveWorkers) {
    host.innerHTML = '<div class="kb-dp-empty">需要 Hermes 桌面端才能读取活跃 worker。</div>';
    return;
  }
  try {
    const r = await a.kanbanActiveWorkers({ board: KB.filters.board || undefined });
    if (my !== KB.dispatch.epoch || !KB.dispatch.open) return;
    renderDispatchWorkers(r);
  } catch (e) {
    if (my === KB.dispatch.epoch) host.innerHTML = `<div class="kb-dp-empty">${esc((e && e.message) || '读取失败')}</div>`;
  }
}
function renderDispatchWorkers(r) {
  const host = $('#kb-dp-workers');
  if (!host) return;
  if (!r || !r.ok) {
    host.innerHTML = `<div class="kb-dp-empty">${esc((r && r.error) || '读取活跃 worker 失败')}</div>`;
    return;
  }
  const ws = Array.isArray(r.workers) ? r.workers : [];
  if (!ws.length) {
    host.innerHTML = '<div class="kb-dp-empty">当前没有运行中的 worker。派发成功后这里会列出新启动的执行记录。</div>';
    return;
  }
  host.innerHTML = ws.map((w) => `<div class="kb-dp-worker"><b>${esc(String(w.task_title || w.task_id || 'worker'))}</b>
    <span>${esc(String(w.profile || w.task_assignee || ''))} · ${esc(kbAgo(w.started_at) || '运行中')}</span></div>`).join('');
}
function kbDpList(label, arr, fmt) {
  const list = Array.isArray(arr) ? arr : [];
  if (!list.length) return '';
  const items = list.slice(0, 12).map(fmt || ((x) => `<li><code>${esc(String(x))}</code></li>`)).join('');
  const more = list.length > 12 ? `<li class="kb-dp-num">还有 ${list.length - 12} 项未列出</li>` : '';
  return `<div class="kb-dp-lead">${esc(label)} · ${list.length}</div><ul class="kb-dp-list">${items}${more}</ul>`;
}
function renderDispatchResult(r, errText) {
  const host = $('#kb-dp-result'), tag = $('#kb-dp-result-tag');
  if (!host) return;
  if (!r || !r.ok) {
    if (tag) { tag.textContent = ''; tag.className = 'kb-dp-tag'; }
    host.innerHTML = `<div class="kb-dp-empty">${esc(errText || '派发请求失败')}</div>`;
    return;
  }
  const dry = r.dryRun !== false;
  const spawned = Array.isArray(r.spawned) ? r.spawned : [];
  if (tag) {
    tag.textContent = dry ? '试运行 · 未启动 agent' : `已派发 · ${spawned.length} 个 worker`;
    tag.className = 'kb-dp-tag' + (dry ? '' : ' real');
  }
  const lists = r.lists || {}, counts = r.counts || {};
  let html = `<div class="kb-dp-lead">${dry ? '本次将启动' : '本次已启动'} <b>${spawned.length}</b> 个 worker${spawned.length ? '' : '（没有 ready 且已分配受让人的任务）'}</div>`;
  html += kbDpList(dry ? '预览：将被派发' : '已启动', spawned,
    (x) => `<li><code>${esc(x.taskId)}</code> <span class="kb-dp-num">→ ${esc(x.assignee || 'default')}</span></li>`);
  const countBits = [];
  if (Number(counts.reclaimed)) countBits.push(`回收认领 ${Number(counts.reclaimed)}`);
  if (Number(counts.promoted)) countBits.push(`依赖解锁 ${Number(counts.promoted)}`);
  if (counts.skipped_locked) countBits.push('另一派发器正持锁，本次跳过');
  if (counts.rate_limited) countBits.push('触发速率限制');
  if (counts.memory_pressure) countBits.push('内存压力，已限流');
  if (countBits.length) html += `<div class="kb-dp-lead">调度器动作：${esc(countBits.join(' · '))}</div>`;
  const groups = [
    ['未分配受让人（不会被派发）', lists.skipped_unassigned],
    ['受让人不是 Hermes profile', lists.skipped_nonspawnable],
    ['已自动套用默认受让人', lists.auto_assigned_default],
    ['该 profile 并发已满', lists.skipped_per_profile_capped],
    ['重生保护（冷却中）', lists.respawn_guarded],
    ['崩溃回收', lists.crashed], ['超时回收', lists.timed_out], ['心跳过期', lists.stale],
    ['连续失败自动阻塞', lists.auto_blocked], ['孤儿 running 重新入队', lists.reconciled_orphans],
    ['回收终态残留 worker', lists.reaped_terminal_workers],
  ];
  for (const [label, arr] of groups) {
    if (label === '该 profile 并发已满') {
      html += kbDpList(label, r.skippedPerProfile,
        (x) => `<li><code>${esc(x.taskId)}</code> <span class="kb-dp-num">→ ${esc(x.assignee)} · 在跑 ${Number(x.current) || 0}</span></li>`);
    } else if (label === '重生保护（冷却中）') {
      html += kbDpList(label, r.respawnGuarded,
        (x) => `<li><code>${esc(x.taskId)}</code> <span class="kb-dp-num">${esc(x.reason)}</span></li>`);
    } else html += kbDpList(label, arr);
  }
  if (!spawned.length && !countBits.length && !html.includes('kb-dp-list')) {
    html += '<div class="kb-dp-empty">当前没有可派发的任务。把卡片推进到 ready 并分配受让人后再试；收集箱 triage 与 todo 不会被派发。</div>';
  }
  host.innerHTML = html;
}
async function kbDispatchRun(dryRun) {
  if (KB.dispatch.busy || !KB.dispatch.open) return;
  const a = kbApi();
  if (!a || !a.kanbanDispatch) { kbDpState('此页需要 Hermes 桌面端才能派发', 'err'); return; }
  const my = KB.dispatch.epoch;
  const preview = $('#kb-dp-preview'), run = $('#kb-dp-run');
  KB.dispatch.busy = true;
  if (preview) preview.disabled = true;
  if (run) run.disabled = true;
  kbDpState(dryRun ? '正在试运行…' : '正在派发…', '');
  const max = Math.max(1, Math.min(8, Number($('#kb-dp-max') && $('#kb-dp-max').value) || 1));
  try {
    const r = await a.kanbanDispatch({ board: KB.filters.board || '', dryRun: !!dryRun, max });
    if (my !== KB.dispatch.epoch || !KB.dispatch.open) return;
    renderDispatchResult(r, r && r.error);
    if (!r || !r.ok) { kbDpState('派发失败', 'err'); return; }
    kbDpState(dryRun ? '预览完成，未启动任何 agent' : `已派发 ${(r.spawned || []).length} 个 worker`, 'on');
    if (!dryRun) {
      toast(`派发完成：启动 ${(r.spawned || []).length} 个 worker`, 2000);
      await kanbanLoad(true); // 写后回读 CLI 列表
    }
    kbDispatchLoadWorkers();
  } catch (e) {
    if (my === KB.dispatch.epoch) {
      renderDispatchResult(null, (e && e.message) || '派发请求失败');
      kbDpState('派发失败', 'err');
    }
  } finally {
    KB.dispatch.busy = false;
    if (preview) preview.disabled = false;
    kbRenderCapacity(); // 含「并发已满则禁用真派发」，不能无条件放开按钮
  }
}
function kbDispatchConfirm() {
  const host = $('#kb-dp-confirm');
  const a = kbApi();
  if (!host || !a || !a.kanbanDispatch) { toast('此页需要 Hermes 桌面端才能派发', 1800); return; }
  const cap = kbDispatchCapacity();
  if (!cap.room) {
    kbDpState(`并发已满（在跑 ${cap.running} / 上限 ${cap.max}）`, 'err');
    toast('本看板已触达并发上限，本次不会启动新 worker', 2200);
    return;
  }
  const max = cap.max;
  const board = String(KB.filters.board || 'current').replace(/[^a-z0-9_-]/g, '');
  opConfirm(host, {
    title: '立即派发一次？',
    cmd: `POST /api/plugins/kanban/dispatch?dry_run=false&max=${max}&board=${board}`,
    note: `本看板并发上限 ${max}，当前在跑 ${cap.running} 个 worker，本次最多新增 ${cap.room} 个：它们会以各自的受让人 profile（hermes -p <受让人>）启动，可能消耗模型额度；调度器还会顺带回收超时 / 崩溃的 worker。这是真实写入，不是预览。`,
    confirmLabel: '确认派发',
    onGo: () => kbDispatchRun(false),
  });
}
/** 抽屉里的「提交派发」：把 triage / todo / blocked 等推进到 ready。 */
function kbSubmitTask(id, host) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return;
  const a = kbApi();
  if (!host || !a || !a.kanbanSubmitTask) { toast('此页需要 Hermes 桌面端才能提交派发', 1800); return; }
  opConfirm(host, {
    title: '把这个任务提交派发？',
    cmd: `PATCH /api/plugins/kanban/tasks/${id}  { status: "ready" }`,
    note: '状态推进到 ready 后，运行中的调度器（默认每 60 秒一次）可能立即认领它并启动 agent worker，产生模型调用。若不想被自动派发，请让任务留在 triage / todo。',
    confirmLabel: '提交派发',
    onGo: async () => {
      const r = await a.kanbanSubmitTask(id, kbParams());
      if (!r || !r.ok) { toast('提交失败：' + ((r && r.error) || '未知错误'), 2600); return; }
      toast('任务已进入 ready 队列', 1800);
      await kanbanLoad(true); // 写后回读
      if (KB.dispatch.open) kbDispatchLoadWorkers();
    },
  });
}

/* ---- 新建弹窗 ---- */
function kbSetBackgroundInert(_on) {
  // 弹窗已移到 #frame 之外：背景隔离统一交给 syncPageLead 按 modalOpen 计算 frame.inert，
  // 与设置 / 命令面板 / 帮助层共用一套状态，避免互相覆盖；遮罩与弹窗本身不被锁住。
  syncPageLead();
}
function kbModalErr(text) {
  const e = $('#kb-modal-err');
  if (!e) return;
  e.textContent = text || '';
  e.hidden = !text;
}
/** 起始状态对应的底注：ready 会被调度器认领，必须给出警示色。
 *  收集箱也不能写「不会派发」—— gateway 每个 tick 会把 triage 卡交给自动分解器
 *  （kanban.auto_decompose，默认开），补全 spec、填受让人、推到 todo→ready 后照样拉起
 *  worker。只有把 auto_decompose 关掉，收集箱才真的停住。 */
function kbSyncStatusNote() {
  const sel = $('#kb-f-status'), note = $('#kb-f-note');
  if (!sel || !note) return;
  const ready = sel.value === 'ready';
  note.classList.toggle('warn', ready);
  note.textContent = ready
    ? '就绪状态可能被调度器立即认领并启动 worker 执行，请确认后再创建。'
    : '收集箱默认等 gateway 自动分解（kanban.auto_decompose）补全并推进，不会立刻拉起。';
}
/* 官方 project-dialog.tsx 的本地等价：一个弹窗四种模式
   （create / rename / add-folder / settings）+ 一个删除确认弹窗。
   文件夹由主进程原生目录选择器给出，第一个为主；选完自动以 basename 命名项目。 */
const KB_PROJECT_KINDS = ['project', 'project-rename', 'project-add-folder', 'project-settings', 'project-delete'];
function kbProjectFolderBasename(dir) {
  return String(dir || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
}
/** 重绘文件夹列表：首条标「主」，逐条可移除；设置模式还能「设为主」。
 *  路径只走 textContent 落地，绝不拼进 HTML。 */
function kbRenderProjectFolders() {
  const host = $('#kb-p-folders');
  if (!host) return;
  const settings = !!KB.projectDialog && KB.projectDialog.mode === 'settings';
  host.innerHTML = '';
  if (!KB.projFolders.length) {
    const empty = document.createElement('div');
    empty.className = 'kb-pfold-empty';
    empty.textContent = '尚未添加文件夹。';
    host.appendChild(empty);
    return;
  }
  KB.projFolders.forEach((dir, i) => {
    const row = document.createElement('div');
    row.className = 'kb-pfold';
    row.setAttribute('role', 'listitem');
    row.innerHTML = '<span class="kb-pfold-ico">📁</span><span class="kb-pfold-path"></span>' +
      (i === 0 ? '<span class="kb-pfold-primary">主</span>' : '') +
      (settings && i > 0 ? '<button class="kb-pfold-pri" type="button" title="设为主文件夹">设为主</button>' : '') +
      '<button class="kb-pfold-rm" type="button" title="移除" aria-label="移除">×</button>';
    const label = row.querySelector('.kb-pfold-path');
    label.textContent = dir;
    label.title = dir;
    const pri = row.querySelector('.kb-pfold-pri');
    if (pri) {
      pri.onclick = () => {
        KB.projFolders = [dir, ...KB.projFolders.filter((x) => x !== dir)];
        kbRenderProjectFolders();
      };
    }
    row.querySelector('.kb-pfold-rm').onclick = () => {
      KB.projFolders = KB.projFolders.filter((x) => x !== dir);
      kbRenderProjectFolders();
      kbSyncProjectSubmit();
    };
    host.appendChild(row);
  });
}
/** 提交按钮条件：名称非空 + 至少一个文件夹（没有文件夹的项目无法认领会话）。
 *  设置模式下文件夹也不能被删空，否则项目会变成谁也进不去的空壳。 */
function kbSyncProjectSubmit() {
  if ((KB.modal !== 'project' && KB.modal !== 'project-settings') || KB.modalBusy) return;
  const submit = $('#kb-modal-submit');
  if (!submit) return;
  submit.disabled = !((($('#kb-p-name')?.value || '').trim()) && KB.projFolders.length > 0);
}
/** 项目写操作后：侧栏树即时收录，看板项目候选下次进页重读。 */
async function kbApplyProjectWrite() {
  KB.overview = null; kbSelectSig = '';
  try { await refreshSessions(currentSearch()); } catch {}
}
/** 弹窗里点「添加文件夹…」：create 模式累加去重；add-folder 模式选完即写入。 */
async function kbPickProjectFolders() {
  const a = kbApi();
  if (!a || typeof a.pickProjectFolders !== 'function' || typeof a.projectAction !== 'function') {
    kbModalErr('此页需要 Hermes 桌面端才能选择文件夹'); return;
  }
  const mode = (KB.projectDialog && KB.projectDialog.mode) || 'create';
  let r = null;
  try { r = await a.pickProjectFolders({ multiple: mode !== 'add-folder' }); } catch { r = null; }
  if (!r || !r.ok) { if (r && !r.canceled) kbModalErr(r.error || '选择文件夹失败'); return; }
  const picked = (Array.isArray(r.folders) ? r.folders : [])
    .filter((p) => typeof p === 'string' && p.startsWith('/')).slice(0, 8);
  if (!picked.length) return;
  if (mode === 'add-folder') { await kbSubmitAddFolders(picked); return; }
  KB.projFolders = [...new Set([...KB.projFolders, ...picked])].slice(0, 8);
  const nameEl = $('#kb-p-name');
  if (nameEl && !nameEl.value.trim()) nameEl.value = kbProjectFolderBasename(picked[0]);
  kbRenderProjectFolders();
  kbSyncProjectSubmit();
}
/** 官方 add-folder 模式：一次多选里的每个目录各写一次 CLI，失败保留弹窗可重试。 */
async function kbSubmitAddFolders(folders) {
  if (KB.modalBusy) return;
  const a = kbApi();
  const target = KB.projectDialog || {};
  if (!a || typeof a.projectAction !== 'function' || !target.projectId) {
    kbModalErr('缺少目标项目'); return;
  }
  KB.modalBusy = true;
  const submit = $('#kb-modal-submit');
  if (submit) submit.disabled = true;
  kbModalErr('');
  try {
    for (const folder of folders) {
      const r = await a.projectAction({ op: 'addFolder', id: target.projectId, folder });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '添加文件夹失败'); return; }
    }
    kbModalClose();
    toast(`已添加 ${folders.length} 个文件夹`, 1800);
    await kbApplyProjectWrite();
  } catch (e) {
    kbModalErr((e && e.message) || '操作失败');
  } finally {
    KB.modalBusy = false;
    if (submit) submit.disabled = false;
    kbSyncProjectSubmit();
  }
}
/** 设置弹窗预填：侧栏树只有名字与主路径，描述和全部文件夹要读一次 projects.get。 */
async function kbFillProjectSettings() {
  const d = KB.projectDialog || {};
  const a = kbApi();
  if (!d.projectId || !a || typeof a.projectGet !== 'function') {
    kbModalErr('此页需要 Hermes 桌面端才能编辑项目'); return;
  }
  let r = null;
  try { r = await a.projectGet(d.projectId); } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  // 期间关了弹窗或换了目标项目：旧响应不许写进新面板
  if (!KB.projectDialog || KB.projectDialog.projectId !== d.projectId || KB.modal !== 'project-settings') return;
  if (!r || !r.ok || !r.project) { kbModalErr((r && r.error) || '读取项目失败'); return; }
  const pr = r.project;
  const nameEl = $('#kb-p-name'), descEl = $('#kb-p-sdesc');
  if (nameEl) nameEl.value = pr.name || d.projectName || '';
  if (descEl) descEl.value = pr.description || '';
  KB.projFolders = (Array.isArray(pr.folders) ? pr.folders : [])
    .map((f) => String((f && f.path) || '')).filter((p) => p.startsWith('/')).slice(0, 8);
  KB.projectDialog.snapshot = {
    name: pr.name || d.projectName || '',
    description: pr.description || '',
    folders: KB.projFolders.slice(),
    primary: pr.primaryPath || KB.projFolders[0] || '',
  };
  kbRenderProjectFolders();
  kbSyncProjectSubmit();
}
/** 设置弹窗保存：按快照算差量，只写真正改过的部分（名称+描述一次 RPC，文件夹逐项增删/设主）。 */
async function kbSubmitProjectSettings() {
  const d = KB.projectDialog || {};
  const a = kbApi();
  const snap = d.snapshot || {};
  const id = d.projectId;
  if (!id) { kbModalErr('缺少目标项目'); return; }
  if (!a || typeof a.projectUpdate !== 'function' || typeof a.projectFolder !== 'function') {
    kbModalErr('此页需要 Hermes 桌面端才能保存项目设置'); return;
  }
  const name = ($('#kb-p-name')?.value || '').trim();
  const desc = ($('#kb-p-sdesc')?.value || '').trim();
  if (!name) { kbModalErr('请填写项目名称'); return; }
  if (!KB.projFolders.length) { kbModalErr('至少保留一个文件夹'); return; }
  const before = Array.isArray(snap.folders) ? snap.folders : [];
  const removed = before.filter((f) => !KB.projFolders.includes(f));
  const added = KB.projFolders.filter((f) => !before.includes(f));
  const primary = KB.projFolders[0] || '';
  const patch = {};
  if (name !== (snap.name || '')) patch.name = name;
  if (desc !== (snap.description || '')) patch.description = desc;
  const submit = $('#kb-modal-submit');
  KB.modalBusy = true;
  if (submit) submit.disabled = true;
  kbModalErr('');
  try {
    if (Object.keys(patch).length) {
      const r = await a.projectUpdate({ id, ...patch });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '保存名称/描述失败'); return; }
    }
    for (const folder of removed) {
      const r = await a.projectFolder({ op: 'remove', id, path: folder });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '移除文件夹失败'); return; }
    }
    for (const folder of added) {
      const r = await a.projectFolder({ op: 'add', id, path: folder });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '添加文件夹失败'); return; }
    }
    if (primary && (snap.primary || '') && primary !== snap.primary) {
      const r = await a.projectFolder({ op: 'primary', id, path: primary });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '设为主文件夹失败'); return; }
    }
    kbModalClose();
    toast('项目设置已保存', 1800);
    await kbApplyProjectWrite();
  } catch (e) {
    kbModalErr((e && e.message) || '保存失败');
  } finally {
    KB.modalBusy = false;
    if (submit) submit.disabled = false;
    kbSyncProjectSubmit();
  }
}
/** 「新建文件夹…」：在第一个（主）文件夹下建一层，成功后直接加入列表。
 *  原生面板也能新建（createDirectory），这里给不想翻面板的用户一条捷径。 */
function kbMkdirToggle(show) {
  const row = $('#kb-p-mkdir'), hint = $('#kb-p-mkdir-hint'), input = $('#kb-p-mkdir-name');
  if (!row) return;
  if (!show) {
    row.hidden = true;
    if (hint) hint.hidden = true;
    if (input) input.value = '';
    return;
  }
  const parent = KB.projFolders[0] || '';
  if (!parent) { kbModalErr('请先添加一个文件夹作为父目录'); return; }
  const base = kbProjectFolderBasename(parent) || parent;
  if (input) { input.value = ''; input.placeholder = `新文件夹名称（建在 ${base}/ 下）`; }
  if (hint) { hint.hidden = false; hint.textContent = `将在 ${parent} 下新建一个空文件夹。`; }
  row.hidden = false;
  kbModalErr('');
  try { if (input) { input.focus({ preventScroll: true }); input.select(); } } catch {}
}
async function kbMkdirSubmit() {
  const a = kbApi();
  const parent = KB.projFolders[0] || '';
  const name = ($('#kb-p-mkdir-name')?.value || '').trim();
  if (!a || typeof a.projectMkdir !== 'function') { kbModalErr('此页需要 Hermes 桌面端才能新建文件夹'); return; }
  if (!parent) { kbModalErr('请先添加一个文件夹作为父目录'); return; }
  if (!name) { kbModalErr('请填写文件夹名称'); return; }
  const okBtn = $('#kb-p-mkdir-ok');
  if (okBtn) okBtn.disabled = true;
  kbModalErr('');
  try {
    const r = await a.projectMkdir({ parent, name });
    if (!r || !r.ok) { kbModalErr((r && r.error) || '新建文件夹失败'); return; }
    const dir = String(r.path || '');
    if (dir.startsWith('/') && !KB.projFolders.includes(dir)) {
      KB.projFolders = [...KB.projFolders, dir].slice(0, 8);
      const nameEl = $('#kb-p-name');
      if (nameEl && !nameEl.value.trim()) nameEl.value = kbProjectFolderBasename(dir);
      kbRenderProjectFolders();
      kbSyncProjectSubmit();
    }
    kbMkdirToggle(false);
    toast('已新建文件夹 ' + dir, 2000);
  } finally {
    if (okBtn) okBtn.disabled = false;
  }
}
/** 删除项目确认弹窗：默认只删记录；勾选「移到废纸篓」才由主进程按项目自己的文件夹清理磁盘。
 *  文件夹列表读一次 projects.get（含附属文件夹），读不到就退回侧栏树里的主路径。 */
function kbProjectDeleteDialog(p) {
  KB.delProject = {
    id: String((p && p.id) || ''), label: String((p && (p.label || p.id)) || ''),
    folders: (p && p.path) ? [String(p.path)] : [],
  };
  kbModalOpen('project-delete');
}
async function kbFillProjectDelete() {
  const d = KB.delProject || {};
  const who = $('#kb-p-del-who'), list = $('#kb-p-del-folders'), trash = $('#kb-p-del-trash');
  if (who) who.textContent = `将删除项目「${d.label || d.id}」及其文件夹关联。`;
  if (trash) trash.checked = false;
  kbRenderDeleteFolders();
  const a = kbApi();
  if (!d.id || !a || typeof a.projectGet !== 'function') return;
  let r = null;
  try { r = await a.projectGet(d.id); } catch {}
  if (!KB.delProject || KB.delProject.id !== d.id || KB.modal !== 'project-delete') return;
  if (r && r.ok && r.project && Array.isArray(r.project.folders) && r.project.folders.length) {
    KB.delProject.folders = r.project.folders.map((f) => String((f && f.path) || '')).filter((x) => x.startsWith('/'));
    kbRenderDeleteFolders();
  }
}
function kbRenderDeleteFolders() {
  const list = $('#kb-p-del-folders');
  if (!list) return;
  list.innerHTML = '';
  const folders = (KB.delProject && KB.delProject.folders) || [];
  const trash = $('#kb-p-del-trash');
  // 没有文件夹可删时不让勾选，避免提交后才报错
  if (trash) { trash.disabled = !folders.length; if (!folders.length) trash.checked = false; }
  if (!folders.length) {
    const d = document.createElement('div');
    d.className = 'kb-pfold-empty';
    d.textContent = '该项目没有文件夹记录。';
    list.appendChild(d);
    return;
  }
  for (const f of folders) {
    const row = document.createElement('div');
    row.className = 'kb-pfold';
    row.innerHTML = '<span class="kb-pfold-ico">📁</span><span class="kb-pfold-path"></span>';
    const label = row.querySelector('.kb-pfold-path');
    label.textContent = f;
    label.title = f;
    list.appendChild(row);
  }
}
async function kbSubmitProjectDelete() {
  if (KB.modalBusy) return;
  const d = KB.delProject || {};
  const submit = $('#kb-modal-submit');
  if (!d.id) { kbModalErr('缺少目标项目'); return; }
  const trash = !!($('#kb-p-del-trash') && $('#kb-p-del-trash').checked);
  if (trash && !(d.folders || []).length) { kbModalErr('该项目没有可删除的磁盘文件夹'); return; }
  KB.modalBusy = true;
  if (submit) submit.disabled = true;
  kbModalErr('');
  try {
    const r = await deleteProjectFromSidebar(
      { id: d.id, label: d.label, path: (d.folders || [])[0] || '' },
      { trash, folders: trash ? d.folders : [] },
    );
    if (!r || !r.ok) { kbModalErr((r && r.error) || '删除失败'); return; }
    kbModalClose();
  } finally {
    KB.modalBusy = false;
    if (submit) submit.disabled = false;
  }
}
/** 项目行 ⋯ / 侧栏入口统一走这里。弹窗是全局浮层，不切看板页也能开。 */
function kbProjectDialog(mode, project) {
  setSidebar(true);
  if (mode !== 'create') {
    const p = project || {};
    KB.projectDialog = {
      mode, projectId: String(p.id || ''), projectName: String(p.label || p.id || ''),
      snapshot: null,
    };
  }
  const kind = mode === 'create' ? 'project'
    : (mode === 'rename' ? 'project-rename'
      : (mode === 'settings' ? 'project-settings' : 'project-add-folder'));
  kbModalOpen(kind);
}
function kbModalOpen(kind, presetStatus) {
  const modal = $('#kb-modal'), mask = $('#kb-modal-mask');
  if (!modal || !mask || (kind !== 'task' && kind !== 'board' && kind !== 'bind' && !KB_PROJECT_KINDS.includes(kind))) return;
  KB.modal = kind;
  KB.modalBusy = false;
  KB.modalKey = 'desktop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const taskForm = $('#kb-form-task'), boardForm = $('#kb-form-board'), bindForm = $('#kb-form-bind');
  const projForm = $('#kb-form-project'), delForm = $('#kb-form-project-del');
  // 每次打开都从空白开始：上一次取消/创建留下的标题、受让人不能带进来
  if (taskForm) {
    taskForm.reset();
    taskForm.querySelectorAll('hm-select').forEach((el) => { if (el.reset) el.reset(); });
    taskForm.hidden = kind !== 'task';
  }
  // 列尾「＋ 添加任务」带过来的起始状态。后端只认 triage / ready，其它值一律忽略，
  // 免得界面暗示「能直接建到进行中 / 受阻 / 已完成」。
  const preset = (kind === 'task' && (presetStatus === 'ready' || presetStatus === 'triage'))
    ? presetStatus : '';
  const statusSel = $('#kb-f-status');
  if (preset && statusSel) statusSel.value = preset;
  if (boardForm) { boardForm.reset(); boardForm.hidden = kind !== 'board'; }
  if (bindForm) { bindForm.reset(); bindForm.hidden = kind !== 'bind'; }
  // 官方：每次打开都从空白开始，上一次取消/创建留下的名称与文件夹不能带进来
  const isProject = KB_PROJECT_KINDS.includes(kind);
  const isDelete = kind === 'project-delete';
  const mode = kind === 'project-rename' ? 'rename'
    : (kind === 'project-add-folder' ? 'add-folder'
      : (kind === 'project-settings' ? 'settings' : (isDelete ? 'delete' : 'create')));
  if (kind === 'project') KB.projectDialog = { mode: 'create', projectId: '', projectName: '', snapshot: null };
  if (projForm) { projForm.reset(); projForm.hidden = !isProject || isDelete; }
  if (delForm) { delForm.reset(); delForm.hidden = !isDelete; }
  KB.projFolders = [];
  kbRenderProjectFolders();
  const nameRow = $('#kb-p-name-row'), foldersRow = $('#kb-p-folders-row');
  const addBtn = $('#kb-p-add'), createOnly = $('#kb-p-create-only'), addNote = $('#kb-p-addnote');
  const settingsBlock = $('#kb-p-settings');
  if (nameRow) nameRow.hidden = mode === 'add-folder' || mode === 'delete';
  if (foldersRow) foldersRow.hidden = (mode !== 'create' && mode !== 'settings');
  if (addBtn) {
    addBtn.hidden = mode === 'rename';
    addBtn.textContent = mode === 'add-folder' ? '＋ 选择文件夹…' : '＋ 添加文件夹…';
  }
  if (createOnly) createOnly.hidden = mode !== 'create';
  if (addNote) addNote.hidden = mode !== 'add-folder';
  if (settingsBlock) settingsBlock.hidden = mode !== 'settings';
  // 新建文件夹的入口只在能改文件夹列表的模式里出现（重命名 / 删除都不需要）
  const mkOpen = $('#kb-p-mkdir-open');
  if (mkOpen) mkOpen.hidden = mode === 'rename' || mode === 'add-folder' || mode === 'delete';
  kbMkdirToggle(false);
  if (mode === 'rename') {
    const nameEl = $('#kb-p-name');
    if (nameEl) nameEl.value = (KB.projectDialog && KB.projectDialog.projectName) || '';
  }
  if (isProject && !isDelete) {
    // 绑定一次的点击入口：重开弹窗时重新赋值即可，不会叠加监听
    if (mkOpen) mkOpen.onclick = () => kbMkdirToggle(true);
    const mkOk = $('#kb-p-mkdir-ok'), mkCancel = $('#kb-p-mkdir-cancel'), mkInput = $('#kb-p-mkdir-name');
    if (mkOk) mkOk.onclick = () => kbMkdirSubmit();
    if (mkCancel) mkCancel.onclick = () => kbMkdirToggle(false);
    if (mkInput) mkInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); kbMkdirSubmit(); } };
  }
  kbSyncStatusNote();
  kbSyncProjectSelects();
  if (kind === 'task') kbSyncAdvSelects();
  kbToggleAdv('f', false);
  kbToggleAdv('b', false);
  const title = $('#kb-modal-title');
  const TITLES = { task: '新建任务', bind: '绑定项目', project: '新建项目', board: '新建看板',
    'project-rename': '重命名项目', 'project-add-folder': '添加文件夹',
    'project-settings': '项目设置', 'project-delete': '删除项目' };
  if (title) title.textContent = TITLES[kind] || '新建';
  kbModalErr('');
  const submit = $('#kb-modal-submit');
  if (submit) {
    submit.disabled = false;
    submit.textContent = kind === 'task' ? '创建任务' : (kind === 'bind' ? '保存绑定' :
      (kind === 'project' ? '创建项目' : (kind === 'project-rename' ? '保存名称' :
        (kind === 'project-add-folder' ? '选择文件夹…'
          : (kind === 'project-settings' ? '保存设置'
            : (isDelete ? '删除项目' : '创建看板'))))));
    // 官方 add-folder 模式没有底部提交按钮：选完目录直接写入
    submit.hidden = kind === 'project-add-folder';
    submit.classList.toggle('danger', isDelete);
  }
  // 设置 / 删除的字段不随表单静态 HTML 带出来，打开后按项目补一次
  if (kind === 'project-settings') kbFillProjectSettings();
  if (isDelete) kbFillProjectDelete();
  kbSyncProjectSubmit();
  kbSyncSelects();
  modal.hidden = false; mask.hidden = false;
  kbSetBackgroundInert(true);
  const first = kind === 'task' ? $('#kb-f-title') : (kind === 'bind' ? $('#kb-b-project') :
    (kind === 'project-add-folder' ? $('#kb-p-add')
      : (isDelete ? $('#kb-p-del-trash') : (isProject ? $('#kb-p-name') : $('#kb-b-slug')))));
  try { if (first) { first.focus({ preventScroll: true }); if (first.select) first.select(); } } catch {}
}
function kbModalClose() {
  const modal = $('#kb-modal'), mask = $('#kb-modal-mask');
  if (modal) modal.hidden = true;
  if (mask) mask.hidden = true;
  KB.modal = '';
  KB.modalBusy = false;
  KB.projFolders = [];
  KB.projectDialog = null;
  KB.delProject = null;
  const submit = $('#kb-modal-submit');
  if (submit) { submit.hidden = false; submit.classList.remove('danger'); }
  kbSetBackgroundInert(false);
  kbModalErr('');
  // 先解 inert 再 focus（inert 内元素会静默拒绝聚焦）
  const back = $('#kb-new-task');
  try { if (back && !$('#kanban-page').hidden) back.focus({ preventScroll: true }); } catch {}
}
function kbModalSubmit() {
  if (KB.modalBusy || !KB.modal) return Promise.resolve();
  // 设置 / 删除各有自己的写路径（差量保存、可选移废纸篓），不进看板那套 payload
  if (KB.modal === 'project-settings') return kbSubmitProjectSettings();
  if (KB.modal === 'project-delete') return kbSubmitProjectDelete();
  const a = kbApi();
  if (!a || !a.kanbanCreateTask || !a.kanbanCreateBoard) { kbModalErr('此页需要 Hermes 桌面端才能写入看板'); return Promise.resolve(); }
  const kind = KB.modal, key = KB.modalKey;
  let payload;
  if (kind === 'task') {
    const title = ($('#kb-f-title')?.value || '').trim();
    if (!title) { kbModalErr('请填写任务标题'); return Promise.resolve(); }
    const maxRt = Number($('#kb-f-maxrt')?.value);
    const goalTurns = Number($('#kb-f-goal-turns')?.value);
    const parentVal = ($('#kb-f-parents')?.value || '').trim();
    const skillVal = ($('#kb-f-skills')?.value || '').trim();
    const modelVal = ($('#kb-f-model')?.value || '').trim();
    payload = {
      title,
      body: $('#kb-f-body')?.value || '',
      status: $('#kb-f-status')?.value === 'ready' ? 'ready' : 'triage',
      priority: Number($('#kb-f-priority')?.value) || 0,
      assignee: $('#kb-f-assignee')?.value || '',
      tenant: $('#kb-f-tenant')?.value || '',
      board: $('#kb-f-board')?.value || KB.filters.board || '',
      // 空值 = 继承看板绑定（服务层只在非空时透传 project_id）
      projectId: $('#kb-f-project')?.value || '',
      workspaceKind: $('#kb-f-wskind')?.value || '',
      workspacePath: ($('#kb-f-wspath')?.value || '').trim(),
      parents: parentVal ? [parentVal] : [],
      skills: skillVal ? [skillVal] : [],
      maxRuntimeSeconds: Number.isInteger(maxRt) && maxRt > 0 ? maxRt : 0,
      goalMode: !!($('#kb-f-goal') && $('#kb-f-goal').checked),
      goalMaxTurns: Number.isInteger(goalTurns) && goalTurns > 0 ? goalTurns : 0,
      modelOverride: modelVal,
      providerOverride: modelVal ? (kbModelProviders[modelVal] || '') : '',
      reasoningEffort: $('#kb-f-effort')?.value || '',
      idempotencyKey: key,
    };
  } else if (kind === 'bind') {
    const meta = kbCurrentBoardMeta();
    if (!meta.slug) { kbModalErr('当前看板未就绪，请稍后重试'); return Promise.resolve(); }
    if (!a.kanbanBindBoard) { kbModalErr('此页需要 Hermes 桌面端才能绑定项目'); return Promise.resolve(); }
    payload = { slug: meta.slug, projectId: $('#kb-b-project')?.value || '' };
  } else if (kind === 'project') {
    if (!a.kanbanCreateProject) { kbModalErr('此页需要 Hermes 桌面端才能创建项目'); return Promise.resolve(); }
    const pname = ($('#kb-p-name')?.value || '').trim();
    if (!pname) { kbModalErr('请填写项目名称'); return Promise.resolve(); }
    // 官方：项目按文件夹（cwd 前缀）认领会话，没有文件夹的项目既进不了分组也放不了会话
    if (!KB.projFolders.length) { kbModalErr('请至少添加一个文件夹'); return Promise.resolve(); }
    payload = {
      name: pname,
      folders: KB.projFolders.slice(),
      slug: ($('#kb-p-slug')?.value || '').trim(),
      description: ($('#kb-p-desc')?.value || '').trim(),
      idea: ($('#kb-p-idea')?.value || '').trim(),
      use: true, // 官方 createProject({ use: true })
    };
  } else if (kind === 'project-rename') {
    if (!a.projectAction) { kbModalErr('此页需要 Hermes 桌面端才能重命名项目'); return Promise.resolve(); }
    const pname = ($('#kb-p-name')?.value || '').trim();
    if (!pname) { kbModalErr('请填写项目名称'); return Promise.resolve(); }
    const id = (KB.projectDialog && KB.projectDialog.projectId) || '';
    if (!id) { kbModalErr('缺少目标项目'); return Promise.resolve(); }
    payload = { op: 'rename', id, name: pname };
  } else if (kind === 'project-add-folder') {
    kbModalErr('请点击「＋ 选择文件夹…」');
    return Promise.resolve();
  } else {
    payload = {
      slug: ($('#kb-b-slug')?.value || '').trim(),
      name: ($('#kb-b-name')?.value || '').trim(),
      description: ($('#kb-b-desc')?.value || '').trim(),
      icon: ($('#kb-b-icon')?.value || '').trim(),
      color: ($('#kb-b-color')?.value || '').trim(),
    };
  }
  const submit = $('#kb-modal-submit');
  KB.modalBusy = true;
  if (submit) submit.disabled = true;
  kbModalErr('');
  return (async () => {
    try {
      let r;
      if (kind === 'task') r = await a.kanbanCreateTask(payload);
      else if (kind === 'bind') r = await a.kanbanBindBoard(payload);
      else if (kind === 'project') r = await a.kanbanCreateProject(payload);
      else if (kind === 'project-rename') r = await a.projectAction(payload);
      else r = await a.kanbanCreateBoard(payload);
      if (KB.modal !== kind) return; // 期间已关弹窗，旧响应不写 DOM
      if (!r || !r.ok) { kbModalErr((r && r.error) || '操作失败'); return; }
      kbModalClose();
      toast(kind === 'bind'
        ? (payload.projectId ? '已绑定项目，生效见该板任务的默认工作区' : '已解除项目绑定')
        : (kind === 'task' ? '任务已创建' : (kind === 'project' ? '项目已创建' :
          (kind === 'project-rename' ? '项目已重命名' : '看板已创建'))), 1800);
      if (r.warning) toast('调度器提示：' + r.warning, 3600);
      if (kind !== 'task') { KB.overview = null; kbSelectSig = ''; }
      await kanbanLoad(true); // 写后回读 CLI 列表
      if (KB_PROJECT_KINDS.includes(kind)) await refreshSessions(currentSearch()); // 侧栏项目树即时收录
      if (kind === 'project') {
        if (r.ideaWarning) toast(r.ideaWarning, 3600);
        // 官方 createProject(use:true) + enterProject：建完设为活动项目，并在项目根开新会话。
        // 弹窗若是从聊天 / 设置页打开的，不要顺手关掉本来就没显示的看板页。
        const root = payload.folders[0];
        if (root) {
          if (!$('#kanban-page').hidden) closeKanbanPage();
          newTabInProject(root);
        }
      }
    } catch (e) {
      if (KB.modal === kind) kbModalErr((e && e.message) || '操作失败');
    } finally {
      KB.modalBusy = false;
      if (submit) submit.disabled = false;
      kbSyncProjectSubmit(); // 失败保留表单时按官方条件重新禁用/启用
    }
  })();
}

const kbModelProviders = {};
function kbSyncAdvSelects() {
  const cols = (KB.board && Array.isArray(KB.board.columns)) ? KB.board.columns : [];
  const tasks = cols.filter((c) => c.name !== 'archived').flatMap((c) => c.tasks || []);
  kbFillSelect('#kb-f-parents', tasks.map((t) => ({
    value: String(t.id),
    label: `${String(t.id).slice(0, 10)} · ${String(t.title || '').slice(0, 32)}`,
  })), '', '无前置任务');

  const fillSkills = (list) => {
    const skillItems = [...new Set((Array.isArray(list) ? list : [])
      .map((s) => String(s.name || s.id || '')).filter(Boolean))].sort()
      .map((n) => ({ value: n, label: n }));
    kbFillSelect('#kb-f-skills', skillItems, $('#kb-f-skills')?.value || '', '不限技能');
  };
  fillSkills(state.skills);
  if ((!Array.isArray(state.skills) || !state.skills.length) && api && api.skillsList) {
    api.skillsList().then((r) => {
      if (r && r.ok && Array.isArray(r.items)) { state.skills = r.items; fillSkills(r.items); }
    }).catch(() => {});
  }

  const rawModels = [
    ...(Array.isArray(state.modelState?.models) ? state.modelState.models : []),
    ...(Array.isArray(state.env?.models) ? state.env.models : []),
  ];
  for (const m of rawModels) {
    if (m && m.model && m.provider) kbModelProviders[String(m.model)] = String(m.provider);
  }
  const rows = typeof modelRows === 'function'
    ? modelRows(state.modelState, state.env && state.env.models, state.config && state.config.model)
    : [];
  const modelItems = rows.map((m) => {
    const key = String(m.key || '');
    const prov = kbModelProviders[key] || (m.tag && !['CLI 默认', '内置', '当前配置'].includes(m.tag) ? m.tag : '');
    if (key && prov) kbModelProviders[key] = prov;
    return {
      value: key,
      label: m.tag && m.tag !== '内置' ? `${m.name || key} (${m.tag})` : String(m.name || key),
    };
  }).filter((m) => m.value);
  kbFillSelect('#kb-f-model', modelItems, '', '跟随 profile 默认');
}

function kbToggleAdv(prefix, forceOpen) {
  const card = $(`#kb-${prefix}-adv`), btn = $(`#kb-${prefix}-adv-btn`);
  if (!card || !btn) return;
  const open = typeof forceOpen === 'boolean' ? forceOpen : card.hidden;
  card.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const label = prefix === 'f' ? '更多设置（看板 / 项目 / 租户 / 工作区 / 模型）' : '高级设置（图标 / 主题色）';
  btn.textContent = (open ? '▾ ' : '▸ ') + label;
}

function setupKanban() {
  const refresh = $('#kb-refresh');
  if (refresh) refresh.onclick = async () => {
    const sp = refresh.querySelector('.kb-spin'), g = refresh.querySelector('.kb-refresh-glyph');
    if (sp) sp.hidden = false; if (g) g.hidden = true;
    await kanbanLoad(true);
    if (sp) sp.hidden = true; if (g) g.hidden = false;
  };
  const close = $('#kb-close'); if (close) close.onclick = () => closeKanbanPage();
  // 页头模式标记：只读展示，点击跳设置（设置页是独立 palette，不关看板页）
  const modeChip = $('#kb-head-mode');
  if (modeChip) modeChip.onclick = () => { settingsCat = 'kanban'; try { toggleSettings(true); } catch {} };
  const dclose = $('#kb-drawer-close'); if (dclose) dclose.onclick = () => closeKanbanDrawer();
  const mask = $('#kb-drawer-mask'); if (mask) mask.onclick = () => closeKanbanDrawer();
  const kbdMoreBtn = $('#kbd-more'), kbdMenu = $('#kbd-menu'), kbdDel = $('#kbd-menu-delete');
  if (kbdMoreBtn) kbdMoreBtn.onclick = () => kbdMoreToggle(kbdMenu ? kbdMenu.hidden : true);
  if (kbdDel) kbdDel.onclick = () => {
    kbdMoreToggle(false);
    const bodyEl = $('#kb-drawer-body');
    const host = (bodyEl && bodyEl.querySelector('#kbd-danger')) || bodyEl;
    if (KB.detailId) kbDeleteTask(KB.detailId, host);
    if (host && host.scrollIntoView) host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  if (kbdMenu) {
    document.addEventListener('pointerdown', (e) => {
      if (!kbdMenu || kbdMenu.hidden) return;
      if (kbdMenu.contains(e.target)) return;
      if (kbdMoreBtn && kbdMoreBtn.contains(e.target)) return;
      kbdMoreToggle(false);
    }, true);
  }

  // 「⋯」菜单：新建看板 / 新建项目 / 绑定项目 / 手动派发 / 切换视图 / 显示已归档
  const moreBtn = $('#kb-more'), moreMenu = $('#kb-more-menu');
  if (moreBtn) moreBtn.onclick = () => kbMoreToggle(moreMenu ? moreMenu.hidden : true);
  if (moreMenu) {
    moreMenu.addEventListener('click', (e) => {
      const item = e.target.closest && e.target.closest('[data-kb-more]');
      if (!item) return;
      const what = item.getAttribute('data-kb-more');
      // 勾选框那一项不关菜单：用户可能想连着看两个结果
      if (what === 'board') { kbMoreToggle(false); kbModalOpen('board'); return; }
      if (what === 'project') { kbMoreToggle(false); kbModalOpen('project'); return; }
      if (what === 'bind') { kbMoreToggle(false); kbModalOpen('bind'); return; }
      if (what === 'dispatch') { kbMoreToggle(false); kbDispatchToggle(!KB.dispatch.open); return; }
      if (what === 'view') {
        KB.view = KB.view === 'grid' ? 'cols' : 'grid';
        kbMoreSync(); renderKanbanBody(); return;
      }
    });
    // 点菜单外面收起（捕获阶段：免得页面里的按钮先响应再收菜单）
    document.addEventListener('pointerdown', (e) => {
      if (!moreMenu || moreMenu.hidden) return;
      if (moreMenu.contains(e.target)) return;
      if (moreBtn && moreBtn.contains(e.target)) return;
      kbMoreToggle(false);
    }, true);
  }

  // 派发控制台：默认 dry-run；真派发走 opConfirm 二次确认。
  // 入口只有一个 —— 「⋯」菜单里的「手动派发控制台」，这里不再绑页头按钮。
  const dpMask = $('#kb-dp-mask'); if (dpMask) dpMask.onclick = () => kbDispatchToggle(false);
  const dpClose = $('#kb-dp-close'); if (dpClose) dpClose.onclick = () => kbDispatchToggle(false);
  const dpPreview = $('#kb-dp-preview'); if (dpPreview) dpPreview.onclick = () => kbDispatchRun(true);
  const dpRun = $('#kb-dp-run'); if (dpRun) dpRun.onclick = () => kbDispatchConfirm();
  const dpRefresh = $('#kb-dp-workers-refresh'); if (dpRefresh) dpRefresh.onclick = () => kbDispatchLoadWorkers();
  const dpMax = $('#kb-dp-max');
  if (dpMax) {
    dpMax.onchange = () => { kbDpClearConfirm(); kbDpState('', ''); };
    // 下拉里按 Esc 只收派发面板，不冒泡关掉整页
    guardFieldKey(dpMax, () => kbDispatchToggle(false));
  }

  const newTask = $('#kb-new-task'); if (newTask) newTask.onclick = () => kbModalOpen('task');
  const mclose = $('#kb-modal-close'); if (mclose) mclose.onclick = () => kbModalClose();
  const mcancel = $('#kb-modal-cancel'); if (mcancel) mcancel.onclick = () => kbModalClose();
  const mmask = $('#kb-modal-mask'); if (mmask) mmask.onclick = () => kbModalClose();
  const msubmit = $('#kb-modal-submit'); if (msubmit) msubmit.onclick = () => kbModalSubmit();
  // 官方 project-dialog：目录选择器、输入即时校验、想法模板 chip
  const padd = $('#kb-p-add'); if (padd) padd.onclick = () => kbPickProjectFolders();
  const pname = $('#kb-p-name'); if (pname) pname.addEventListener('input', kbSyncProjectSubmit);
  const pideas = $('#kb-p-ideas');
  if (pideas) pideas.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('.kb-pchip');
    const idea = $('#kb-p-idea');
    if (chip && idea) { idea.value = chip.getAttribute('data-idea') || ''; idea.focus(); }
  });
  // 表单里按 Esc 只收本弹窗，不冒泡关掉整页；字段用 keydown 守卫，命令面板同理。
  document.querySelectorAll('#kb-form-task input, #kb-form-task hm-select, #kb-form-task textarea, #kb-form-board input, #kb-form-board textarea, #kb-form-bind hm-select, #kb-form-project input, #kb-form-project textarea')
    .forEach((el) => {
      guardFieldKey(el, () => kbModalClose());
      // 文本字段里回车即提交；textarea 保留换行，不抢全局快捷键
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') {
          e.preventDefault(); e.stopPropagation(); kbModalSubmit();
        }
      });
    });
  const statusSel = $('#kb-f-status');
  if (statusSel) statusSel.onchange = () => kbSyncStatusNote();
  // 选了具体项目时，底注实时说明它对工作区的决定作用
  const fproj = $('#kb-f-project');
  if (fproj) fproj.addEventListener('change', () => kbSyncProjectNote());
  // 受让人手打的名字如果不是磁盘上的 profile，说明文字立刻转红字警告
  const assigneeInput = $('#kb-f-assignee');
  if (assigneeInput) assigneeInput.addEventListener('change', () => kbSyncAssigneeHint());
  // 表单里回车提交（textarea 除外），不触发全局快捷键
  ['#kb-form-task', '#kb-form-board'].forEach((s) => {
    const form = $(s);
    if (!form) return;
    form.onsubmit = (e) => { e.preventDefault(); kbModalSubmit(); };
  });

  // 视图切换与「显示已归档」都在「⋯」菜单里，页面上没有对应的常驻按钮
  const statusbar = $('#kb-statusbar');
  if (statusbar) statusbar.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('[data-kb-status]');
    if (!chip) return;
    const v = chip.getAttribute('data-kb-status') || '';
    KB.status = KB.status === v ? '' : v;
    renderKanbanStatusbar();
    renderKanbanBody();
  });

  let qTimer = null;
  const q = $('#kb-search');
  if (q) q.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      KB.filters.q = q.value.trim();
      const clear = $('#kb-search-clear');
      if (clear) clear.hidden = !KB.filters.q;
      renderKanbanStatusbar();
      renderKanbanBody();
    }, 160);
  });
  const qclear = $('#kb-search-clear');
  if (qclear) qclear.onclick = () => {
    if (q) q.value = '';
    KB.filters.q = ''; qclear.hidden = true;
    renderKanbanStatusbar();
    renderKanbanBody();
    if (q) q.focus();
  };
  if (q) q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (q.value || KB.filters.q)) {
      e.preventDefault();
      e.stopPropagation();
      q.value = '';
      KB.filters.q = '';
      if (qclear) qclear.hidden = true;
      renderKanbanStatusbar();
      renderKanbanBody();
    }
  });
  const clearFilters = $('#kb-clear-filters');
  if (clearFilters) clearFilters.onclick = kbResetFilters;
  if ($('#kb-f-adv-btn')) $('#kb-f-adv-btn').onclick = () => kbToggleAdv('f');
  if ($('#kb-b-adv-btn')) $('#kb-b-adv-btn').onclick = () => kbToggleAdv('b');
  const kbPage = $('#kanban-page');
  if (kbPage) kbPage.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-kb-clear-filters]')) kbResetFilters();
  });
  const assignee = $('#kb-assignee');
  if (assignee) assignee.onchange = () => {
    KB.filters.assignee = assignee.value;
    renderKanbanStatusbar(); renderKanbanBody();
  };
  const tenant = $('#kb-tenant');
  if (tenant) tenant.onchange = () => { KB.filters.tenant = tenant.value; kanbanLoad(false); };
  const boardSel = $('#kb-board');
  if (boardSel) boardSel.onchange = () => {
    KB.filters.board = boardSel.value;
    KB.overview = null; kbSelectSig = '';
    kanbanLoad(true);
  };
  const archived = $('#kb-archived');
  if (archived) archived.onchange = () => {
    KB.filters.archived = !!archived.checked;
    // 渲染完再滚：此时第 6 列才存在，scrollWidth 才是六列的值
    kanbanLoad(false).then(() => kbScrollToArchived(KB.filters.archived));
  };

  const scroll = $('#kb-scroll');
  if (scroll) {
    scroll.addEventListener('pointerdown', kbDragDown);
    scroll.addEventListener('click', (e) => {
      // 拖动结束后浏览器补发的 click 要吞掉，否则会顺手打开详情抽屉
      if (KbDrag.suppressClick) { KbDrag.suppressClick = false; return; }
      const n = e.target.closest && e.target.closest('[data-kb-new]');
      if (n) { kbModalOpen('task', n.getAttribute('data-kb-new-status') || ''); return; }
      const card = e.target.closest && e.target.closest('[data-kb-task]');
      if (card) openKanbanTask(card.getAttribute('data-kb-task'));
    });
  }
  // 拖拽走指针事件：document 级监听才能接住「拖出滚动区再松手」
  document.addEventListener('pointermove', kbDragMove, { passive: false });
  document.addEventListener('pointerup', kbDragUp);
  document.addEventListener('pointercancel', () => { if (KbDrag.armed || KbDrag.on) kbDragReset(); });
  window.addEventListener('blur', () => { if (KbDrag.armed || KbDrag.on) kbDragReset(); });

  // 投放区的 chip：点一下 = 按该受让人筛选（再点取消），拖动则由 pointerup 处理
  const dock = $('#kb-dock');
  if (dock) dock.addEventListener('click', (e) => {
    if (KbDrag.suppressClick) { KbDrag.suppressClick = false; return; }
    const w = e.target.closest && e.target.closest('[data-kb-worker]');
    if (!w) return;
    const name = String(w.getAttribute('data-kb-worker') || '');
    if (!name) return;
    KB.filters.assignee = KB.filters.assignee === name ? '' : name;
    const sel = $('#kb-assignee');
    if (sel) sel.value = KB.filters.assignee;
    renderKanbanStatusbar();
    renderKanbanBody();
  });
  const body = $('#kb-drawer-body');
  if (body) body.addEventListener('click', (e) => {
    const sub = e.target.closest && e.target.closest('[data-kb-submit]');
    if (sub) { kbSubmitTask(sub.getAttribute('data-kb-submit'), sub.closest('.kbd-actions') || body); return; }
    const dec = e.target.closest && e.target.closest('[data-kb-decompose]');
    if (dec) { kbDecomposeTask(dec.getAttribute('data-kb-decompose'), dec.closest('.kbd-actions') || body); return; }
    const edt = e.target.closest && e.target.closest('[data-kb-edit]');
    if (edt) {
      const form = $('#kbd-edit-form');
      if (form) { form.hidden = !form.hidden; if (!form.hidden && $('#kbd-edit-title')) $('#kbd-edit-title').focus(); }
      return;
    }
    const edtCancel = e.target.closest && e.target.closest('[data-kb-edit-cancel]');
    if (edtCancel) { const form = $('#kbd-edit-form'); if (form) form.hidden = true; return; }
    const edtSave = e.target.closest && e.target.closest('[data-kb-edit-save]');
    if (edtSave) { kbSaveTaskEdit(edtSave.getAttribute('data-kb-edit-save')); return; }
    const logBtn = e.target.closest && e.target.closest('[data-kb-log]');
    if (logBtn) { kbLoadTaskLog(logBtn.getAttribute('data-kb-log')); return; }
    const spec = e.target.closest && e.target.closest('[data-kb-specify]');
    if (spec) { kbSpecifyTask(spec.getAttribute('data-kb-specify'), spec.closest('.kbd-actions') || body); return; }
    const est = e.target.closest && e.target.closest('[data-kb-estimate]');
    if (est) { kbEstimateTask(est.getAttribute('data-kb-estimate'), est.closest('.kbd-actions') || body); return; }
    const mv = e.target.closest && e.target.closest('[data-kb-move]');
    if (mv && KB.detailId) { kbDropToStatus(KB.detailId, mv.getAttribute('data-kb-move')); return; }
    const del = e.target.closest && e.target.closest('[data-kb-delete]');
    if (del) { kbDeleteTask(del.getAttribute('data-kb-delete'), del.closest('.kbd-danger')); return; }
    const re = e.target.closest && e.target.closest('[data-kb-reassign]');
    if (re) { kbReassignTask(re.getAttribute('data-kb-reassign'), re.closest('.kbd-reassign') || body); return; }
    const cmt = e.target.closest && e.target.closest('[data-kb-comment]');
    if (cmt) { kbAddComment(cmt.getAttribute('data-kb-comment')); return; }
    const t = e.target.closest && e.target.closest('[data-kb-task]');
    if (t) { openKanbanTask(t.getAttribute('data-kb-task')); return; }
    const s = e.target.closest && e.target.closest('[data-kb-session]');
    if (s) kbJumpToSession(s.getAttribute('data-kb-session'));
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && $('#kanban-page') && !$('#kanban-page').hidden) kanbanLoad(false);
  });
}
setupKanban();
init();
