'use strict';
/* ---------- 时间分桶：置顶 / 今天 / 昨天 / 其他会话 ----------
   官方 calendarBucket 的收敛版：只保留三档（用户侧只需要「今天 / 昨天 / 其余」），
   时间取 last_active || started_at —— 与行上显示的日期同源，否则「昨天活跃、上月开始」
   的会话会被分到「其他会话」却显示昨天的日期。
   凌晨 0–4 点算前一天（官方 DAY_ROLLOVER_HOUR=4）：熬夜连着聊的会话不该被切开。 */
const DAY_ROLLOVER_HOUR = 4;
function nominalDayStart(ms) {
  const d = new Date(ms - DAY_ROLLOVER_HOUR * 3600000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function sessionBucket(s) {
  const o = s || {};
  if (Number(o.pinned) > 0 || o.pinned === true) return 'pinned';
  const t = Number(o.last_active || o.started_at) || 0;
  if (!t) return 'older';
  const diff = Math.round((nominalDayStart(Date.now()) - nominalDayStart(t * 1000)) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return 'older';
}
/** 分桶标题与默认强弱：越近的分组字重/对比越强，一眼能看出时间层次。 */
const DATE_BUCKETS = {
  pinned: { label: '置顶', rank: 0 },
  today: { label: '今天', rank: 1 },
  yesterday: { label: '昨天', rank: 2 },
  older: { label: '其他会话', rank: 3 },
};
/** 日期分组的折叠状态（官方 $sidebarWorkspaceNodeOpen 的 list-group 前缀等价）：
 *  存解析后的布尔，默认展开；用户显式折叠后重绘不会自己弹开。 */
const SB_DATE_OPEN_KEY = 'sb-date-open';
function sbDateOpenMap() {
  try {
    const o = JSON.parse(safeGet(SB_DATE_OPEN_KEY) || '{}');
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }
}
function dateGroupOpen(key) {
  const v = sbDateOpenMap()[String(key || '')];
  return typeof v === 'boolean' ? v : true;
}
function setDateGroupOpen(key, open) {
  const k = String(key || '');
  if (!k) return;
  const m = sbDateOpenMap();
  if (m[k] === open) return;
  m[k] = open;
  safeSet(SB_DATE_OPEN_KEY, JSON.stringify(m));
}
/** 折叠/展开后把焦点还给同一个分组标题（键盘操作不至于跳回页首）。 */
function focusDateToggle(key) {
  const btn = [...document.querySelectorAll('#session-list .s-div')]
    .find((x) => x.dataset.bucket === key);
  const el = btn && btn.querySelector('.s-dtoggle');
  if (el) { try { el.focus({ preventScroll: true }); } catch {} }
}
/** 分组分隔条：小号大写感标题 + 细横线，与项目行（带底色、字更大）在视觉上分成两类。 */
function dateDividerEl(bucket, open, count) {
  const meta = DATE_BUCKETS[bucket] || DATE_BUCKETS.older;
  const li = document.createElement('li');
  li.className = 's-div';
  li.dataset.bucket = bucket;
  li.dataset.rank = String(meta.rank);
  li.setAttribute('role', 'presentation');
  const btn = document.createElement('button');
  btn.className = 's-dtoggle';
  btn.type = 'button';
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.setAttribute('aria-label', `${open ? '收起' : '展开'}${meta.label}的会话`);
  btn.innerHTML = `<span class="s-dlabel">${esc(meta.label)}</span>` +
    '<span class="s-dcaret" aria-hidden="true"></span><span class="s-drule" aria-hidden="true"></span>' +
    (count ? `<span class="s-dcount">${count}</span>` : '');
  btn.onclick = () => {
    // 搜索态分组恒展开（命中不能被折叠藏起来），此时点标题不改状态，免得「点了没反应」
    if (currentSearch()) return;
    setDateGroupOpen(bucket, !open);
    renderSessions(currentSearch());
    focusDateToggle(bucket);
  };
  li.appendChild(btn);
  return li;
}
/** 侧栏单个会话行（项目预览与时间分组共用）：返回 li，由调用方挂事件 */
/** 会话显示名（官方 sessionTitle：title → preview → 'Untitled session'）。
 *  CLI 的标题是异步生成的，新建会话在生成前 title 为空；服务层还会退化成会话 id，
 *  那串 `local-<64 hex>` 不能当标题显示，所以与 id 相同的 title 视作「没有标题」。 */
function sessionLabel(s) {
  const o = s || {};
  const id = String(o.id || '');
  const raw = String(o.title || '').trim();
  const title = raw && raw !== id ? raw : '';
  const preview = String(o.preview || '').trim();
  return title || preview || '未命名会话';
}

function sessionItemEl(s, { query = '', snippet = '' } = {}) {
  const tab = activeTab();
  const li = document.createElement('li');
  if (tab && s.id === tab.sessionId) li.classList.add('active');
  const openTab = state.tabs.find((t) => t.sessionId === s.id);
  let dotHtml = '';
  if (openTab) {
    const hasAp = openTab.items.some((i) => i.kind === 'approval' && !i.choice);
    if (hasAp) dotHtml = '<span class="s-dot approval" title="等待确认危险操作">!</span>';
    else if (openTab.running) dotHtml = '<span class="s-dot running" title="后台生成中"></span>';
    else if (openTab.unread && (!tab || openTab.id !== tab.id)) dotHtml = '<span class="s-dot unread" title="后台已完成"></span>';
  }
  const rawTs = s.last_active || s.ended_at || s.started_at;
  const dt = rawTs ? new Date(rawTs * 1000) : null;
  const when = dt ? `${dt.getMonth() + 1}/${dt.getDate()}` : '';
  // 键盘可达：列表项与 ⋯ 入口原本都是纯 li/span，鼠标以外完全无法操作
  li.setAttribute('role', 'option');
  li.setAttribute('tabindex', '0');
  li.setAttribute('aria-selected', tab && s.id === tab.sessionId ? 'true' : 'false');
  li.innerHTML = `${dotHtml}<span class="s-main"><span class="s-title">${hlMark(sessionLabel(s), query)}</span>` +
    (snippet ? `<span class="s-snippet">${hlMark(snippet, query)}</span>` : '') + `</span>` +
    `<span class="s-actions" role="button" tabindex="0" aria-label="会话操作" title="会话操作">⋯</span>` +
    `<span class="s-meta">${s.pinned ? '⌁ ' : ''}${when}</span>`;
  // 从搜索结果点进来：把查询词带进会话内查找，直接落到命中位置并高亮，
  // 省掉「打开会话 → 再自己搜一次」的往返。
  li.onclick = () => {
    const carry = s.fulltext ? query : '';
    const p = openSession(s.id);
    if (carry && p && typeof p.then === 'function') {
      p.then(() => {
        const t = activeTab();
        // 过期响应 / 用户又点了别的会话时不要抢焦点
        if (t && t.sessionId === s.id && t.items.length) findOpen(carry);
      });
    }
  };
  li.onkeydown = (e) => {
    if (e.target !== li) return; // 让 ⋯ 自己处理，避免冒泡后重复触发
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSession(s.id); }
  };
  const acts = li.querySelector('.s-actions');
  acts.onclick = (e) => { e.stopPropagation(); openSessionMenu(s, acts); };
  acts.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); acts.click(); }
  };
  return li;
}

/** 项目行「＋」：在项目根目录新建会话 —— CLI 按 cwd 的 git 仓库根自动归属项目 */
function newTabInProject(projectPath) {
  const p = String(projectPath || '');
  // 官方 prepareWorkspaceTarget：先展开目标分组，否则新会话会落进一个收起的项目里
  const root = p.replace(/\/+$/, '');
  const proj = (Array.isArray(state.projectsTree) ? state.projectsTree : [])
    .find((x) => x && String(x.path || '').replace(/\/+$/, '') === root);
  if (proj) setProjectOpen(proj.id, true);
  const t = newTab();
  if (p.startsWith('/')) t.cwd = p;
  syncComposerProject();
  $('#input').focus();
}
/** composer 项目下拉：候选 = 侧栏项目树里的显式项目，value 用项目根绝对路径。 */
function composerProjectOptions() {
  return (Array.isArray(state.projectsTree) ? state.projectsTree : [])
    .map((p) => ({ value: String((p && p.path) || ''), label: String((p && (p.label || p.id)) || '') }))
    .filter((x) => x.value.startsWith('/') && x.label);
}
/** 下拉末尾的动作行（不取值，选中即打开新建项目弹窗）。 */
const COMPOSER_NEW_PROJECT = '__new_project__';
/** 当前页签归属的显式项目（只读）。树的 sessionIds 是权威来源；
 *  还没发首条消息、CLI 尚未认领的会话用 tab.cwd 命中项目根兜底
 *  （从项目行「＋」新建的会话就是这种）。命中即视为「在项目下创建的会话」。 */
function activeTabProject() {
  const tab = activeTab();
  if (!tab) return null;
  const projects = Array.isArray(state.projectsTree) ? state.projectsTree : [];
  const pid = sessionProjectId(tab.sessionId);
  if (pid) return projects.find((p) => String(p.id || '') === pid) || null;
  const cwd = String(tab.cwd || '').replace(/\/+$/, '');
  if (!cwd.startsWith('/')) return null;
  return projects.filter((p) => {
    const root = String(p.path || '').replace(/\/+$/, '');
    return root && (cwd === root || cwd.startsWith(root + '/'));
  }).sort((a, b) => String(b.path || '').length - String(a.path || '').length)[0] || null;
}
/** 下拉显示跟随当前页签：tab.cwd 精确命中项目根，或落在项目子目录时取最长前缀命中。
 *  归属已定的会话不再显示选择器 —— CLI 没有改既有会话归属的写接口，
 *  留着下拉只会让人误以为能切换（实际点了是另开一个项目会话）。 */
function syncComposerProject() {
  const el = $('#chip-project');
  if (!el || typeof el.setOptions !== 'function') return;
  const items = composerProjectOptions();
  // 「＋ 新建项目…」挂在候选末尾：一个项目都没有时，这个下拉里除了占位项就只剩它，
  // 不至于点开一片空白、还得回头去找侧栏的入口。它 action:true，选中不改变 value。
  items.push({ value: COMPOSER_NEW_PROJECT, label: '＋ 新建项目…', action: true });
  el.setOptions(items, '选择项目');
  const cwd = String((activeTab() && activeTab().cwd) || '');
  const exact = items.find((i) => i.value === cwd);
  const nested = items.filter((i) => !i.action && cwd.startsWith(i.value.replace(/\/+$/, '') + '/'))
    .sort((a, b) => b.value.length - a.value.length)[0];
  el.value = (exact || nested || {}).value || '';
  const fixed = !!activeTabProject();
  // 自绘下拉的面板挂在 document.body 上，隐藏宿主不会带走它，必须先显式收起
  if (fixed && typeof el.close === 'function') el.close();
  el.hidden = fixed;
}
/** 选中动作行：建项目（官方 project-dialog），建完由创建流程自己进项目根开新会话。 */
function onComposerNewProject() {
  if (typeof kbProjectDialog !== 'function') { toast('当前环境不支持创建项目', 2200); return; }
  kbProjectDialog('create');
}
/** 选中项目 = 设定本会话工作目录（首轮 session.create 的 cwd）。
 *  CLI 没有改既有会话归属的写接口，已开始的会话只能在该项目另开一个页签。 */
function applyComposerProject(value) {
  const tab = activeTab();
  if (!tab) return;
  const path = String(value || '');
  if (path && !composerProjectOptions().some((i) => i.value === path)) return;
  if (!tab.sessionId) {
    if (path) tab.cwd = path; else delete tab.cwd;
    toast(path ? '已选择项目，本会话将在项目目录启动' : '已恢复默认工作目录', 1800);
  } else if (path) {
    newTabInProject(path);
    toast('已在所选项目新建会话', 1800);
  } else {
    newTab();
    toast('已新建默认目录会话', 1800);
  }
  syncComposerProject();
}
/** 项目分组的分页尺寸（官方 model.ts：首屏 SIDEBAR_GROUP_PAGE=5，「再显示」每次 PROJECT_SESSION_PAGE=50）。 */
const SB_PROJECT_PAGE = 5;
const SB_PROJECT_STEP = 50;
/** 每个项目已展开的行数（只在内存里，重绘不丢；切项目筛选不影响）。 */
const sbProjectShown = new Map();

/** 项目折叠状态（官方 $sidebarWorkspaceNodeOpen）：存「解析后的布尔」而不是与默认值异或，
 *  这样有会话的项目默认展开、空项目默认收起，用户显式折叠/展开后不再被默认值翻转。
 *  localStorage 只在渲染层用，不进 CLI 配置。 */
const SB_PROJECT_OPEN_KEY = 'sb-project-open';
function sbProjectOpenMap() {
  try {
    const o = JSON.parse(safeGet(SB_PROJECT_OPEN_KEY) || '{}');
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }
}
function projectOpen(id, fallback) {
  const v = sbProjectOpenMap()[String(id || '')];
  return typeof v === 'boolean' ? v : !!fallback;
}
function setProjectOpen(id, open) {
  const key = String(id || '');
  if (!key) return;
  const m = sbProjectOpenMap();
  if (m[key] === open) return;
  m[key] = open;
  safeSet(SB_PROJECT_OPEN_KEY, JSON.stringify(m));
}

/** 项目分组的会话行：树里的 preview（最近几条）+ 本地列表按 sessionIds 补齐。
 *  本地列表的标题带「首条用户消息」回退，覆盖到 preview 行上（官方 live overlay 同义），
 *  否则新会话标题还没生成时，项目分组里就是一片空白。 */
function projectSessionRows(p, byId, liveIds) {
  const seen = new Set();
  const out = [];
  const push = (row) => {
    const id = String((row && row.id) || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    const live = byId.get(id);
    out.push(live ? { ...row, ...live } : row);
  };
  for (const s of (p.previewSessions || [])) push(s);
  for (const id of (p.sessionIds || [])) {
    if (!liveIds.has(id)) continue; // 超出本地列表窗口的会话没有数据可渲染，不伪造空行
    push(byId.get(id) || { id });
  }
  return out;
}

/** 项目色点：只接受 #rgb / #rrggbb，其它值一律不渲染（项目色来自用户数据，不进 CSS 拼接）。 */
function projectDotHtml(color) {
  const c = String(color || '').trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) return '';
  return `<span class="s-pdot" style="background:${c}" aria-hidden="true"></span>`;
}

/** 折叠/展开会重建 DOM，把焦点还给同一个项目的开关（键盘操作不至于跳回页首）。 */
function focusProjectToggle(pid) {
  const gl = [...document.querySelectorAll('#session-list .s-proj')].find((x) => x.dataset.pid === pid);
  const btn = gl && gl.querySelector('.s-ptoggle');
  if (btn) { try { btn.focus({ preventScroll: true }); } catch {} }
}

function renderSessions(q = '') {
  const ul = $('#session-list'); ul.innerHTML = '';
  const query = q || (($('#session-search') && $('#session-search').value.trim()) || '');
  const searching = !!query;
  const projects = (!searching && Array.isArray(state.projectsTree)) ? state.projectsTree : [];
  // 已被项目认领的会话从时间分组排除（preview 行 + 全量 sessionIds；pinned 保留在置顶组）
  const claimed = new Set();
  for (const p of projects) for (const id of (p.sessionIds || [])) claimed.add(id);
  const claimedNoPin = (id) => {
    const s = state.sessions.find((x) => x.id === id);
    return claimed.has(id) && !(s && (Number(s.pinned) > 0 || s.pinned === true));
  };
  // 项目分组（官方 SidebarWorkspaceGroup）：头部是折叠开关 + 名称 + 计数 + 新建/操作，
  // 展开后按页显示（首屏 5 条，「再显示」每次 +50）；空项目展开显示「暂无会话」。
  const byId = new Map(state.sessions.map((s) => [s.id, s]));
  const liveIds = new Set(byId.keys());
  const activeTabObj = activeTab();
  const activePid = (activeTabObj && activeTabObj.sessionId && sessionProjectId(activeTabObj.sessionId)) || '';
  let shownProject = false;
  for (const p of projects) {
    shownProject = true;
    const pid = String(p.id || '');
    const label = String(p.label || p.id || '');
    const rowsAll = projectSessionRows(p, byId, liveIds);
    const open = projectOpen(pid, (p.sessionCount || 0) > 0);
    const shown = Math.max(SB_PROJECT_PAGE, sbProjectShown.get(pid) || SB_PROJECT_PAGE);
    const rows = rowsAll.slice(0, shown);
    const rest = Math.max(0, rowsAll.length - rows.length);
    const gl = document.createElement('li');
    gl.className = 's-group s-proj' + (activePid && pid === activePid ? ' active' : '');
    gl.dataset.pid = pid;
    gl.setAttribute('role', 'presentation');
    const safePath = esc(p.path || '');
    const name = esc(label);
    // 折叠按钮铺满左侧，点名字即收/开（官方 WorkspaceHeader 的 disclosure 语义）
    gl.innerHTML = `<button class="s-ptoggle" type="button" aria-expanded="${open ? 'true' : 'false'}" ` +
        `aria-label="${open ? '收起' : '展开'}${name}的会话" title="${name}">` +
        `<span class="s-pcaret" aria-hidden="true"></span>` +
        projectDotHtml(p.color) +
        `<span class="s-pname">${name}<span class="s-pcount">${p.sessionCount || 0}</span></span></button>` +
      (p.path ? `<button class="s-pnew" data-cwd="${safePath}" title="在 ${safePath} 新建会话（会话将归属该项目）" aria-label="在此项目新建会话">+</button>` : '');
    const toggle = gl.querySelector('.s-ptoggle');
    toggle.onclick = (e) => {
      e.stopPropagation();
      setProjectOpen(pid, !open);
      renderSessions(currentSearch());
      focusProjectToggle(pid);
    };
    const plus = gl.querySelector('.s-pnew');
    if (plus) {
      plus.onclick = (e) => { e.stopPropagation(); newTabInProject(p.path); };
      plus.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); plus.click(); }
      };
    }
    // 官方 project-menu：项目行 hover 出 ⋯，右键同菜单；复用会话菜单浮层
    const more = document.createElement('button');
    more.className = 's-pmore';
    more.textContent = '⋯';
    more.title = `项目操作：${label}`;
    more.setAttribute('aria-label', '项目操作');
    more.onclick = (e) => { e.stopPropagation(); openProjectMenu(p, more); };
    more.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); more.click(); }
    };
    gl.appendChild(more);
    gl.oncontextmenu = (e) => { e.preventDefault(); openProjectMenu(p, gl); };
    ul.appendChild(gl);
    if (!open) continue;
    if (!rowsAll.length) {
      const empty = document.createElement('li');
      empty.className = 's-pempty';
      empty.setAttribute('role', 'presentation');
      empty.textContent = '暂无会话';
      ul.appendChild(empty);
      continue;
    }
    for (const ps of rows) {
      const li = sessionItemEl(ps, { query });
      li.classList.add('s-psess'); // 项目下的会话缩进到项目名所在列（官方 tree 层级）
      ul.appendChild(li);
    }
    if (rest > 0) {
      const page = Math.min(SB_PROJECT_STEP, rest);
      const moreRow = document.createElement('li');
      moreRow.className = 's-pshow';
      moreRow.setAttribute('role', 'presentation');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 's-pshow-btn';
      btn.textContent = `… 在 ${label} 中再显示 ${page} 个`;
      btn.onclick = (e) => {
        e.stopPropagation();
        sbProjectShown.set(pid, shown + SB_PROJECT_STEP);
        renderSessions(currentSearch());
        focusProjectToggle(pid);
      };
      moreRow.appendChild(btn);
      ul.appendChild(moreRow);
    }
  }
  // 项目之外剩下的会话按「今天 / 昨天 / 其他会话」分桶。分桶排序保证同名分隔条只出现一次
  // （V8 的排序稳定，桶内保留原有时序），项目分组在上、时间分组在下，两类标题样式不同。
  const restRows = state.sessions.filter((s) => searching || !claimedNoPin(s.id));
  restRows.sort((a, b) => DATE_BUCKETS[sessionBucket(a)].rank - DATE_BUCKETS[sessionBucket(b)].rank);
  const counts = new Map();
  for (const s of restRows) {
    const b = sessionBucket(s);
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  let lastBucket = null;
  for (const s of restRows) {
    const bucket = sessionBucket(s);
    if (bucket !== lastBucket) {
      const open = searching ? true : dateGroupOpen(bucket); // 搜索时全部展开，命中不藏在折叠里
      ul.appendChild(dateDividerEl(bucket, open, counts.get(bucket) || 0));
      lastBucket = bucket;
    }
    // 折叠的分组只留标题：会话行不渲染，计数徽标说明里面还有几条
    if (!searching && !dateGroupOpen(bucket)) continue;
    ul.appendChild(sessionItemEl(s, { query, snippet: s.snippet }));
  }
  if (!ul.children.length) {
    // 首屏还没拿到第一个确定答案：铺骨架 + 状态说明，而不是直接说「暂无会话」
    if (!query && !state.booted) { renderSidebarSkeleton(ul); return; }
    const li = document.createElement('li');
    li.innerHTML = `<span class="s-title" style="color:var(--text-3)">${query ? '没有匹配的会话' : '暂无会话'}</span>`;
    ul.appendChild(li);
  }
}
/* ---------- 会话操作菜单 / 空间管理 ---------- */
function closeSessionMenu() {
  const m = $('#session-menu');
  if (m) { m.hidden = true; m.innerHTML = ''; }
}
/** 官方 deleteProject：删除项目记录（`projects.delete` RPC）。默认**不动磁盘上的文件 / 仓库 /
 *  工作树**；弹窗里勾选「移到废纸篓」时由主进程按项目自己的文件夹逐个 trashItem（可恢复）。
 *  删完刷新侧栏树；当前页签的 cwd 若正落在被删项目里，回落到默认工作目录。 */
async function deleteProjectFromSidebar(p, opts) {
  const o = opts || {};
  const label = String(p.label || p.id || '');
  if (typeof api.deleteProject !== 'function') { toast('当前环境不支持删除项目', 2600); return { ok: false, error: 'unsupported' }; }
  toast(o.trash ? '正在移入废纸篓并删除项目…' : '正在删除项目…', 1800);
  let r = null;
  try { r = await api.deleteProject({ id: p.id, trash: o.trash === true, folders: o.folders || [] }); }
  catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  if (!r || !r.ok) {
    toast('删除失败：' + ((r && r.error) || '未知错误'), 4200);
    return r || { ok: false, error: 'unknown' };
  }
  const tab = activeTab();
  const root = String(p.path || '').replace(/\/+$/, '');
  if (tab && tab.cwd && root && (String(tab.cwd) === root || String(tab.cwd).startsWith(root + '/'))) {
    delete tab.cwd;
  }
  await refreshSessions(currentSearch());
  syncComposerProject();
  const moved = Array.isArray(r.trashed) ? r.trashed.length : 0;
  toast(moved ? `已删除项目「${label}」，${moved} 个文件夹已移到废纸篓` : `已删除项目「${label}」`, 2600);
  return r;
}

/** 官方 project-menu.tsx：项目行 ⋯ / 右键共用的操作菜单。
 *  显式项目有重命名 / 设置 / 加文件夹 / 设为活动 / 删除；后两项是本机路径动作，不写 CLI。 */
function openProjectMenu(p, anchor) {
  const m = $('#session-menu'); if (!m) return;
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.right - 156, window.innerWidth - 180)) + 'px';
  m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 320)) + 'px';
  m.innerHTML = `<button data-pact="rename">✎ 重命名项目…</button>
    <button data-pact="settings">⚙ 项目设置…</button>
    <button data-pact="add-folder">⊕ 添加文件夹…</button>
    <button data-pact="use">◎ 设为活动项目</button>
    <div class="sess-menu-sep"></div>
    <button data-pact="reveal">⌸ 在访达中显示</button>
    <button data-pact="copy">⧉ 复制路径</button>
    <div class="sess-menu-sep"></div>
    <button data-pact="delete" class="danger">✕ 删除项目…</button>`;
  m.hidden = false;
  m.onclick = async (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (!b || !b.dataset.pact) return;
    const act = b.dataset.pact;
    // 删除是破坏性动作：走确认弹窗（可勾选是否连磁盘文件一起移到废纸篓），不再就地两次点击
    if (act === 'delete') {
      closeSessionMenu();
      kbProjectDeleteDialog(p);
      return;
    }
    closeSessionMenu();
    try {
      if (act === 'rename' || act === 'add-folder') { kbProjectDialog(act, p); return; }
      if (act === 'settings') { kbProjectDialog('settings', p); return; }
      if (act === 'use') {
        const res = await api.projectAction({ op: 'use', id: p.id });
        if (!res || !res.ok) { toast('操作失败：' + ((res && res.error) || '未知错误'), 3000); return; }
        toast('已设为活动项目', 1600);
        await kbApplyProjectWrite();
        return;
      }
      if (act === 'reveal') {
        if (!p.path) { toast('该项目没有主文件夹', 2200); return; }
        await api.revealPath(p.path);
        return;
      }
      if (act === 'copy') {
        if (!p.path) { toast('该项目没有主文件夹', 2200); return; }
        const ok = await api.copyText(p.path);
        toast(ok ? '已复制项目路径' : '复制失败', 1600);
      }
    } catch (err) {
      toast('操作失败：' + ((err && err.message) || '未知错误'), 2800);
    }
  };
}
/** 官方 ⌘O / "Open folder…"：一个目录就是一个工作空间。
 *  目录已被某项目覆盖 → 直接进入；否则以目录名建项目（use:true）再进入。
 *  两条路径都在该目录开新会话，等价于 enterProject + startWorkSession。 */
async function openFolderAsProject() {
  if (typeof api.pickProjectFolders !== 'function' || typeof api.kanbanCreateProject !== 'function') {
    toast('当前环境不支持选择本机文件夹', 2600); return;
  }
  let r = null;
  try { r = await api.pickProjectFolders({ multiple: false }); } catch { r = null; }
  if (!r || !r.ok || !Array.isArray(r.folders) || !r.folders.length) return;
  const dir = r.folders[0];
  if (typeof dir !== 'string' || !dir.startsWith('/')) return;
  const existing = (state.projectsTree || []).find((p) => p.path &&
    (dir === p.path || dir.startsWith(p.path.replace(/\/+$/, '') + '/')));
  const enter = () => { closeKanbanPage(); newTabInProject(dir); };
  if (existing) { toast(`已进入项目「${existing.label || existing.id}」`, 1800); enter(); return; }
  const name = kbProjectFolderBasename(dir) || dir;
  toast(`正在为「${name}」创建项目…`, 1800);
  const res = await api.kanbanCreateProject({ name, folders: [dir], use: true });
  if (!res || !res.ok) { toast('创建失败：' + ((res && res.error) || '未知错误'), 3600); return; }
  await kbApplyProjectWrite();
  toast(`项目「${name}」已创建并设为活动`, 1800);
  enter();
}
/** 会话当前归属的项目 id：树的 sessionIds 是权威来源（Home 桶 / 未被认领返回空）。 */
function sessionProjectId(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return '';
  const hit = (state.projectsTree || []).find((p) => !p.isNoProject &&
    Array.isArray(p.sessionIds) && p.sessionIds.includes(sid));
  return hit ? String(hit.id || '') : '';
}
/** 会话菜单的二级页：可移入的显式项目（官方 MoveToProjectItems 的等价）。
 *  候选剔除当前所属项目、Home 桶与没有根目录的项目（没有 cwd 就无从移入）；
 *  项目对象只经索引回查，路径不进 DOM 属性。 */
function openMoveToProjectMenu(s, onBack) {
  const m = $('#session-menu'); if (!m) return;
  const cur = sessionProjectId(s.id);
  const targets = (state.projectsTree || []).filter((p) => !p.isNoProject && !p.isAuto &&
    String(p.id || '') !== cur && String(p.path || '').startsWith('/'));
  const homeDir = (state.env && state.env.home && String(state.env.home).startsWith('/')) ? state.env.home : '';
  const leaveBtn = (cur && homeDir) ? `<button data-move-out="1" title="${esc(homeDir)}">📤 移出项目（回到默认目录）</button>` : '';
  const rows = (targets.length
    ? targets.map((p, i) => `<button data-move="${i}" title="${esc(p.path || '')}">📁 ${esc(p.label || p.id)}</button>`).join('')
    : (leaveBtn ? '' : '<button disabled>没有其他可移入的项目</button>')) + leaveBtn;
  m.innerHTML = '<button data-act="move-back">‹ 返回</button>' +
    '<div class="sess-menu-label" title="会换掉会话的工作目录，之后的消息在目标项目目录里跑">移到项目</div>' + rows;
  // 二级页比一级高：往下溢出时整体上移，避免贴着窗口底边被裁
  const h = m.offsetHeight;
  const top = parseFloat(m.style.top) || 0;
  if (top + h > window.innerHeight - 8) m.style.top = Math.max(8, window.innerHeight - 8 - h) + 'px';
  m.hidden = false;
  m.onclick = async (e) => {
    // 本页会重绘菜单内容：不拦住冒泡的话，document 的关闭监听器拿到的 e.target
    // 已经不在 #session-menu 里（旧按钮被 innerHTML 换掉），会把菜单当成「点了外面」关掉
    e.stopPropagation();
    const b = e.target.closest && e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'move-back') { onBack(); return; }
    if (b.dataset.moveOut === '1') {
      closeSessionMenu();
      toast('正在移出项目…', 1800);
      let r = null;
      try { r = await api.moveSession(s.id, homeDir); }
      catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
      if (!r || !r.ok) { toast('移出失败：' + ((r && r.error) || '未知错误'), 3600); return; }
      for (const t of (state.tabs || [])) {
        if (t.sessionId === s.id) t.cwd = r.cwd || homeDir;
      }
      await refreshSessions(currentSearch());
      syncComposerProject();
      toast('已移出项目', 2200);
      return;
    }
    if (b.dataset.move == null) return;
    const p = targets[Number(b.dataset.move)];
    if (!p) return;
    closeSessionMenu();
    toast(`正在移到「${p.label || p.id}」…`, 1800);
    let r = null;
    try { r = await api.moveSession(s.id, p.path); }
    catch (err) { r = { ok: false, error: (err && err.message) || String(err) }; }
    if (!r || !r.ok) { toast('移动失败：' + ((r && r.error) || '未知错误'), 3600); return; }
    // 会话正开在页签里：页签 cwd 一起换，否则接着发消息还会跑回旧目录
    for (const t of (state.tabs || [])) {
      if (t.sessionId === s.id) t.cwd = r.cwd || p.path;
    }
    await refreshSessions(currentSearch());
    syncComposerProject();
    toast(`已移到「${p.label || p.id}」`, 2200);
  };
}
function openSessionMenu(s, anchor) {
  const m = $('#session-menu'); if (!m) return;
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.right - 156, window.innerWidth - 180)) + 'px';
  m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 300)) + 'px';
  m.innerHTML = `<button data-act="rename">✎ 重命名</button>
    <button data-act="pin">${s.pinned ? '⤓ 取消置顶' : '⤒ 置顶会话'}</button>
    <button data-act="move">⇢ 移到项目…</button>
    <button data-act="to-task">📋 转为看板任务</button>
    <div class="sess-menu-sep"></div>
    <button data-act="export" data-fmt="md">↧ 导出 Markdown</button>
    <button data-act="export" data-fmt="html">↧ 导出 HTML</button>
    <button data-act="export" data-fmt="jsonl">↧ 导出 JSONL</button>
    <div class="sess-menu-sep"></div>
    <button data-act="delete" class="danger">✕ 删除会话</button>`;
  m.hidden = false;
  m.onclick = async (e) => {
   try {
    const b = e.target.closest('button'); if (!b || !b.dataset.act) return;
    const act = b.dataset.act;
    if (act === 'delete') {
      if (b.dataset.confirm !== '1') {
        b.dataset.confirm = '1'; b.classList.add('confirm');
        b.textContent = '⚠ 再次点击确认删除（不可恢复）';
        return;
      }
      closeSessionMenu();
      toast('正在删除会话…', 1600);
      const r2 = await api.deleteSession(s.id);
      if (r2 && r2.ok) { toast('会话已删除', 1600); await refreshSessions(currentSearch()); }
      else toast('删除失败：' + ((r2 && r2.error) || '未知错误'), 3200);
      return;
    }
    if (act === 'pin') {
      closeSessionMenu();
      const r2 = await api.pinSession(s.id, !s.pinned);
      if (r2 && r2.ok) { toast(s.pinned ? '已取消置顶' : '已置顶', 1400); await refreshSessions(currentSearch()); }
      else toast('操作失败：' + ((r2 && r2.error) || '未知错误'), 2600);
      return;
    }
    if (act === 'rename') { closeSessionMenu(); startRename(s, anchor.closest('li')); return; }
    // 二级页替换当前菜单内容，不关闭浮层；返回时按原锚点重开一级。
    // stopPropagation 必须加：重绘后 document 的关闭监听器已认不出这个按钮是菜单内的。
    if (act === 'move') { e.stopPropagation(); openMoveToProjectMenu(s, () => openSessionMenu(s, anchor)); return; }
    if (act === 'to-task') {
      closeSessionMenu();
      const title = String(s.title || s.display_name || '').trim() || `会话 ${String(s.id || '').slice(0, 8)}`;
      const body = `来源会话：${s.id}${s.model ? `\n模型：${s.model}` : ''}${s.cwd ? `\n工作目录：${s.cwd}` : ''}`;
      if (typeof kbModalOpen === 'function') {
        kbModalOpen('task', { title, body, sessionId: s.id });
      }
      return;
    }
    if (act === 'export') {
      const fmt = b.dataset.fmt;
      closeSessionMenu();
      toast('正在导出…', 1500);
      const r2 = await api.exportSession({ sessionId: s.id, format: fmt, title: s.title || s.display_name || '' });
      if (r2 && r2.ok) toast('已导出到 ' + r2.path, 3200);
      else if (r2 && r2.canceled) { /* 用户取消，不提示 */ }
      else toast('导出失败：' + ((r2 && r2.error) || '未知错误'), 3600);
      return;
    }
   } catch (err) {
     console.error('[session-menu]', err);
     closeSessionMenu();
     toast('操作失败：' + ((err && err.message) || '未知错误'), 2800);
   }
  };
}
function startRename(s, li) {
  if (!li) return;
  const titleEl = li.querySelector('.s-title'); if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 's-rename-input'; input.value = s.title || '';
  titleEl.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const val = input.value.trim();
    try {
      if (save && val && val !== s.title) {
        const r = await api.renameSession(s.id, val);
        toast((r && r.ok) ? '已重命名' : ('重命名失败：' + ((r && r.error) || '')), 1800);
      }
    } catch (err) {
      toast('重命名失败：' + ((err && err.message) || '未知错误'), 2200);
    }
    await refreshSessions($('#session-search') ? $('#session-search').value.trim() : '');
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}
async function toggleStoragePop(force) {
  const p = $('#storage-pop'); if (!p) return;
  const show = force === undefined ? p.hidden : force;
  if (!show) { p.hidden = true; return; }
  p.hidden = false;
  p.innerHTML = '<div class="storage-loading">读取会话库统计…</div>';
  try {
    const s = await api.storageStats();
    const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
    const fmt = (t) => t ? new Date(t * 1000).toLocaleDateString('zh-CN') : '—';
    p.innerHTML = `<div class="storage-head"><b>会话空间</b><button id="storage-close" title="关闭">✕</button></div>
      <div class="storage-grid">
        <div><span>数据库</span><b>${mb(s.dbBytes)}</b></div>
        <div><span>可回收</span><b>${mb(s.freeBytes)}</b></div>
        <div><span>会话</span><b>${s.sessions}</b></div>
        <div><span>消息</span><b>${s.messages}</b></div>
      </div>
      <div class="storage-lines">
        <div>归档 / 置顶 <b>${s.archived} / ${s.pinned}</b></div>
        <div>时间跨度 <b>${fmt(s.oldest)} → ${fmt(s.newest)}</b></div>
      </div>
      <div class="storage-tip">回收空间（先停 gateway）：<code>hermes sessions optimize</code>单条会话用列表右侧 ⋯ 管理。</div>
      <button id="storage-copy" class="storage-copy">复制优化命令</button>`;
    const c = p.querySelector('#storage-close'); if (c) c.onclick = () => toggleStoragePop(false);
    const cp = p.querySelector('#storage-copy');
    if (cp) cp.onclick = async () => {
      try { await navigator.clipboard.writeText('hermes sessions optimize'); toast('已复制命令', 1400); }
      catch { toast('复制失败', 1600); }
    };
  } catch (e) { p.innerHTML = '<div class="storage-loading">读取失败：' + esc(e.message) + '</div>'; }
}
/** 关闭所有覆盖主区域的子页面/弹层（路由回聊天视图时调用）
    顺序有关系：市场页自己记着「从哪个页来的」并会在关闭时把来源页重新显示出来，
    所以必须先直接收起它，再收插件 / 技能页，否则刚关掉的页又被弹回来。 */
function closeSubpages() {
  const mkPage = $('#market-page'); if (mkPage) mkPage.hidden = true;
  try { toggleSubpage($('#plugins-page'), false); } catch {}
  try { toggleSubpage($('#skills-page'), false); } catch {}
  try { closeKanbanPage(); } catch {}
  // 消息平台页：toggleSubpage 对它直接 return（有自己的开关与数据加载），必须走专用关闭
  try { closeGatewayPage(); } catch {}
  try { toggleSettings(false); } catch {}
  try { togglePalette(false); } catch {}
}

async function openSession(sessionId) {
  closeSubpages();
  const existing = state.tabs.find((t) => t.sessionId === sessionId);
  if (existing) {
    state.view = 'chat';
    setActiveTab(existing.id);
    return;
  }
  const cur = activeTab();
  const reuse = cur && !cur.running && !cur.loading && cur.items.length === 0;
  if (reuse) {
    const inp = $('#input');
    if (inp && inp._draftTimer) { clearTimeout(inp._draftTimer); inp._draftTimer = null; }
    if (typeof saveDraftFor === 'function') saveDraftFor(cur);
  }
  // loading 标记阻止连点两次复用同一个空 tab，导致两份历史互相覆盖
  const tab = reuse ? cur : newTab(sessionId, '新会话', true);
  const gen = (tab.loadGen = (tab.loadGen || 0) + 1);
  tab.loading = true;
  tab.sessionId = sessionId; state.view = 'chat';
  if (reuse && typeof restoreDraftFor === 'function') restoreDraftFor(tab);
  // 从项目分组点开已有会话时会复用当前空 tab，不走 setActiveTab；归属在下一行才落地，
  // 必须在这里补一次同步，否则项目选择器会沿用上一个页签的显隐状态。
  syncComposerProject();
  document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
  try {
    const hist = arr(await api.loadHistory({ sessionId, limit: 200 }));
    // 异步回来时用户可能已切到别的会话 / 又点了另一条，过期响应必须丢弃
    if (gen !== tab.loadGen || !state.tabs.includes(tab)) return;
    tab.items = [];
    // 历史消息没有 turnMs（CLI 只存消息时间），用「本条助手消息 - 上一条用户消息」的时间差还原，
    // 这样 dsh 那句「已完成，用时 N 秒」在历史会话里也能显示，而不是只剩一个「已完成」。
    let lastUserTs = 0;
    const tcInputMap = new Map();
    for (const m of hist) {
      // messages.timestamp 是 REAL 秒（如 1794146522.21），Date.parse 对它返回 NaN
      const tv = Number(m.timestamp);
      const ts = Number.isFinite(tv) && tv > 0 ? (tv > 1e12 ? tv : tv * 1000) : (Date.parse(m.timestamp) || 0);
      if (m.role === 'user') { lastUserTs = ts; tab.items.push({ kind: 'user', text: m.content, ts }); }
      else if (m.displayKind === 'failed_turn') {
        const f = parseFailure(m.displayMetadata, m.content);
        tab.items.push({ kind: 'error', text: f.error, failure: f, ts });
      }
      else if (m.role === 'assistant') {
        if (m.reasoningContent) {
          tab.items.push({ kind: 'thinking', text: m.reasoningContent, open: false, ts });
        }
        if (Array.isArray(m.toolCalls)) {
          for (const tc of m.toolCalls) {
            if (!tc || !tc.id) continue;
            let args = tc.function && tc.function.arguments != null ? tc.function.arguments : tc.arguments;
            if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
            tcInputMap.set(String(tc.id), args || null);
          }
        }
        if (m.content) {
          // 只接受 0.5s ~ 1h 的差值，防止跨会话 / 跨天的时间戳算出荒谬耗时
          const d = ts - lastUserTs;
          const turnMs = (lastUserTs > 0 && d >= 500 && d < 3600000) ? d : 0;
          tab.items.push({ kind: 'assistant', text: m.content, done: true, ts, tokens: Number(m.tokens) || 0, turnMs });
        }
      }
      else if (m.role === 'tool' && m.toolName) {
        const parsedIn = (m.toolCallId && tcInputMap.has(String(m.toolCallId))) ? tcInputMap.get(String(m.toolCallId)) : null;
        const looksErr = /^(?:error:|traceback|failed|{"error")/i.test(String(m.content || '').trim());
        tab.items.push({ kind: 'tool', name: m.toolName, input: parsedIn, output: m.content, state: 'ok', isError: looksErr, done: true, ts });
      }
    }
    // 官方 sessionTitle 同序：首条用户消息 → 列表里的标题/预览 → 未命名会话。
    // 旧实现最后回落到 sessionId，于是空会话的页签标题变成一串 local-<hash>。
    const known = state.sessions.find((x) => x.id === sessionId);
    tab.title = tab.items.find((i) => i.kind === 'user')?.text.slice(0, 24)
      || (known ? sessionLabel(known) : '') || '未命名会话';
  } catch (e) { toast('加载历史失败: ' + ((e && e.message) || e)); }
  finally { if (gen === tab.loadGen) tab.loading = false; }
  // 状态条用量初值（库内累计值；回合进行中会被 gateway 的实时 session.usage 覆盖）
  try {
    const us = await api.sessionUsage(sessionId);
    if (us && us.ok && us.usage) {
      tab.usage = { input: Number(us.usage.input) || 0, output: Number(us.usage.output) || 0,
        cacheRead: Number(us.usage.cacheRead) || 0, total: Number(us.usage.total) || 0,
        calls: Number(us.usage.calls) || 0, cost: Number(us.usage.cost) || 0 };
      if (us.usage.model) tab.model = us.usage.model;
    }
  } catch {}
  renderTabs(); renderChat(); renderSessions(); updateStatus();
  if (typeof renderAttach === 'function') renderAttach();
}
