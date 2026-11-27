'use strict';
/* ---------- 右侧面板（预览 + 自动跟随） ---------- */
const PV_AUTO_KEY = 'pv-auto';
const PV_RECENT_KEY = 'pv-recent';
let railTab = (() => {
  try { return localStorage.getItem(RAIL_TAB_KEY) === 'kanban' ? 'kanban' : 'preview'; }
  catch { return 'preview'; }
})();
const pv = {
  url: '', filePath: '', label: '', kind: '', type: '', view: '', ext: '',
  baseDir: '', text: '', textLoadedFor: '', srcdoc: '', imgActual: false,
};
// 只看通道是否存在：浏览器 Demo 桥也实现了预览，别用 hasNative 把它挡在门外
const pvAvailable = () => typeof api.previewResolve === 'function';
const PV_TYPE_LABEL = { url: '远程网页', web: '网页', pdf: 'PDF', image: '图片', doc: '文档', table: '表格' };
/** 每种类型可用的视图：render=原生渲染，source=原始文本，table=表格解析。 */
const PV_VIEWS = {
  url: [['render', '网页']],
  web: [['render', '渲染'], ['source', '源码']],
  pdf: [['render', 'PDF']],
  image: [['render', '图片']],
  doc: [['render', '渲染'], ['source', '源码']],
  table: [['table', '表格'], ['source', '源码']],
};
const pvViews = (type) => PV_VIEWS[type] || [['render', '渲染']];
const pvBaseDir = () => (activeTab() && activeTab().cwd) || pv.baseDir || undefined;

/** 最近预览记录：最多保留 8 条，在空态下提供一键回切。 */
function loadPvRecent() {
  try {
    const arr = JSON.parse(localStorage.getItem(PV_RECENT_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((x) => x && x.target).slice(0, 8) : [];
  } catch { return []; }
}
function pushPvRecent(item) {
  if (!item || !item.target) return;
  const list = loadPvRecent().filter((x) => x.target !== item.target);
  list.unshift({ target: item.target, label: item.label || item.target, type: item.type || '' });
  try { localStorage.setItem(PV_RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch {}
  renderPvRecent();
}
function renderPvRecent() {
  const box = $('#pv-recent');
  if (!box) return;
  const list = loadPvRecent();
  if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<div class="pv-recent-head">最近预览</div>' + list.map((x) =>
    `<button class="pv-recent-item" type="button" data-pv-recent="${esc(x.target)}" title="${esc(x.target)}">` +
    `<span class="pv-recent-name">${esc(x.label)}</span>` +
    `<span class="pv-recent-type">${esc(PV_TYPE_LABEL[x.type] || x.type || '')}</span>` +
    `</button>`).join('');
}

/** 看板页签是否被看见。整页看板与 rail 看板共用一份 KB.board、一个轮询，
 *  谁可见谁就驱动刷新；两个都不可见时轮询彻底停掉，不空转打 REST。 */
function railKanbanVisible() {
  const rail = $('#rail');
  return !!rail && !rail.hidden && railTab === 'kanban';
}
function kanbanAnyVisible() {
  const page = $('#kanban-page');
  return (!!page && !page.hidden) || railKanbanVisible();
}
function setRailTab(tab) {
  railTab = tab === 'kanban' ? 'kanban' : 'preview';
  try { localStorage.setItem(RAIL_TAB_KEY, railTab); } catch {}
  document.querySelectorAll('#rail-tabs .rt').forEach((b) => {
    const on = b.dataset.rail === railTab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  if (railTab === 'preview') {
    const dot = $('#rt-pv-dot');
    if (dot) dot.hidden = true;
  }
  $('#preview-pane').hidden = railTab !== 'preview';
  $('#kanban-pane').hidden = railTab !== 'kanban';
  $('#rail-hint').textContent = railTab === 'kanban'
    ? (KB.error ? '同步失败' : '实时同步')
    : (pv.kind === 'url' ? '远程网页' : (PV_TYPE_LABEL[pv.type] || '本地文件'));
  if (railTab === 'kanban') {
    renderRailKanban();
    kanbanLoad(true);
    kanbanStartPolling();
  } else if (!kanbanAnyVisible()) {
    kanbanStopPolling();
  }
}

function toggleRail(force) {
  const rail = $('#rail');
  const show = force !== undefined ? force : rail.hidden;
  const toggleBtn = $('#btn-rail-toggle');
  if (toggleBtn) {
    toggleBtn.classList.toggle('on', show);
    toggleBtn.setAttribute('aria-expanded', String(show));
  }
  if (!show) {
    rail.hidden = true;
    if (!kanbanAnyVisible()) kanbanStopPolling();
    if (pvAvailable()) api.previewUnwatch();
    return;
  }
  rail.hidden = false;
  setRailTab(railTab);
  if (pvAvailable() && pv.kind === 'file' && pv.filePath) {
    api.previewWatch(pv.filePath);
  }
}

function pvState(msg, isErr) {
  const el = $('#pv-state');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}
function loadFrame(url, srcdoc) {
  const f = $('#pv-frame');
  // 本地文件保留完整能力（用户拍板的「任意本地 html 预览」）；
  // 远程页面收紧：不允许弹窗 / 表单提交 / 模态 / 下载，避免钓鱼式 iframe。
  const remote = /^https?:\/\//i.test(String(url));
  f.setAttribute('sandbox', remote
    ? 'allow-scripts'
    : 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
  // Demo 桥没有磁盘文件，用 srcdoc 喂一段内存 HTML；真机一律走 file:// / http(s)
  if (srcdoc) f.setAttribute('srcdoc', srcdoc); else f.removeAttribute('srcdoc');
  // 后台窗口 rAF 会被节流，用定时器保证 file:// 变更一定触发重新导航
  f.src = 'about:blank';
  setTimeout(() => { f.src = url; }, 24);
}
/** 五个渲染面互斥：只显示当前视图，其余 hidden，避免 iframe 在背后继续跑脚本。 */
function pvShow(sel) {
  for (const s of ['#pv-frame', '#pv-image', '#pv-doc', '#pv-table', '#pv-raw']) {
    const el = $(s); if (el) el.hidden = s !== sel;
  }
  $('#pv-empty').hidden = true;
}
/** 文本类才走 IPC 读原文；同一文件缓存，文件变更时由 reloadPreview 清掉。 */
async function pvReadText() {
  if (!pv.filePath || typeof api.previewRead !== 'function') return '';
  if (pv.textLoadedFor === pv.filePath) return pv.text;
  let r;
  try { r = await api.previewRead(pv.filePath, pv.baseDir || undefined); }
  catch (err) { pvState('读取失败：' + String((err && err.message) || err), true); return ''; }
  if (!r || !r.ok) { pvState((r && r.error) || '读取失败', true); return ''; }
  pv.text = String(r.text || ''); pv.textLoadedFor = pv.filePath;
  return pv.text;
}
/** Markdown 复用聊天流的转义渲染器；其它文本套代码块，带语言标签与复制按钮。 */
function pvDocHtml(text) {
  const ext = String(pv.ext || '').toLowerCase();
  if (ext === '.md' || ext === '.markdown') return renderMarkdown(text);
  const lang = { '.json': 'json', '.jsonl': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml',
    '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx',
    '.py': 'python', '.css': 'css', '.scss': 'scss', '.sh': 'bash', '.rb': 'ruby',
    '.go': 'go', '.rs': 'rust', '.java': 'java', '.sql': 'sql', '.svg': 'xml', '.html': 'html' }[ext] || 'text';
  return mdCodeBlock(lang, text);
}
/** CSV / TSV → 表格。支持引号内分隔符、转义双引号与引号内换行（RFC 4180）。 */
function pvTableHtml(text) {
  const delim = String(pv.ext || '').toLowerCase() === '.tsv' ? '\t' : ',';
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const all = [];
  let row = [], cur = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === delim) {
      row.push(cur); cur = '';
    } else if (c === '\n') {
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') all.push(row);
      row = [];
    } else {
      cur += c;
    }
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    if (row.length > 1 || row[0] !== '') all.push(row);
  }
  if (!all.length) return '<div class="pv-table-note">表格为空</div>';
  const MAX = 300;
  const head = all[0] || [];
  const body = all.slice(1, MAX + 1);
  const note = `<div class="pv-table-note">${esc(pv.label || '表格')} · ${Math.max(0, all.length - 1)} 行 × ${head.length} 列` +
    (all.length > MAX + 1 ? ` · 仅显示前 ${MAX} 行` : '') + ' · 点击单元格可复制</div>';
  const th = head.map((c) => `<th>${esc(c)}</th>`).join('');
  const tr = body.map((r) => `<tr>${head.map((_, i) => {
    const c = String(r[i] == null ? '' : r[i]);
    return `<td title="${esc(c)}">${esc(c)}</td>`;
  }).join('')}</tr>`).join('');
  return note + `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}
function updatePvTools() {
  const copyBtn = $('#pv-copy');
  const zoomBtn = $('#pv-img-zoom');
  const isTextView = pv.view === 'source' || pv.view === 'table' || pv.type === 'doc';
  if (copyBtn) copyBtn.hidden = !isTextView || !pv.filePath;
  if (zoomBtn) {
    zoomBtn.hidden = pv.type !== 'image' || !pv.url;
    zoomBtn.classList.toggle('active', !!pv.imgActual);
    zoomBtn.textContent = pv.imgActual ? '适应' : '1:1';
  }
}
function renderPreviewViews() {
  const views = pvViews(pv.type);
  if (!views.some(([v]) => v === pv.view)) pv.view = views[0][0];
  $('#pv-view-btns').innerHTML = views.map(([v, label]) =>
    `<button class="pv-vbtn${v === pv.view ? ' active' : ''}" type="button" role="tab" ` +
    `aria-selected="${v === pv.view}" data-pv-view="${v}">${esc(label)}</button>`).join('');
  $('#pv-kind').textContent = PV_TYPE_LABEL[pv.type] || '预览';
  $('#pv-views').hidden = false;
  updatePvTools();
}
function setPvView(view) {
  if (!pvViews(pv.type).some(([v]) => v === view)) return;
  pv.view = view;
  renderPreviewViews();
  renderPreviewContent();
}
async function renderPreviewContent() {
  updatePvTools();
  // 文本视图要读原文；iframe / img 类型完全不碰内容，只给 URL
  if (pv.view === 'source' || pv.view === 'table' || pv.type === 'doc') {
    const text = await pvReadText();
    if (pv.view === 'source') { pvShow('#pv-raw'); $('#pv-raw').textContent = text || '（无可显示的文本）'; }
    else if (pv.view === 'table') { pvShow('#pv-table'); $('#pv-table').innerHTML = pvTableHtml(text); }
    else { pvShow('#pv-doc'); $('#pv-doc').innerHTML = pvDocHtml(text); }
    return;
  }
  if (pv.type === 'image') {
    pvShow('#pv-image');
    const box = $('#pv-image');
    if (box) box.classList.toggle('is-actual', !!pv.imgActual);
    const img = $('#pv-img');
    img.alt = pv.label || '预览图片';
    img.src = pv.url;
    return;
  }
  pvShow('#pv-frame');
  loadFrame(pv.url, pv.srcdoc);
}
async function setPreview(res) {
  if (!res || !res.ok) { pvState((res && res.error) || '加载失败', true); return false; }
  const isFile = res.kind === 'file';
  const target = isFile ? res.filePath : res.url;
  if (!pvHistory.navigating && target && pvHistory.stack[pvHistory.idx] !== target) {
    pvHistory.stack = pvHistory.stack.slice(0, pvHistory.idx + 1);
    pvHistory.stack.push(target);
    if (pvHistory.stack.length > 30) pvHistory.stack.shift();
    pvHistory.idx = pvHistory.stack.length - 1;
  }
  pv.url = res.url; pv.filePath = res.filePath || ''; pv.label = res.label || '';
  pv.kind = res.kind; pv.type = res.type || (isFile ? 'web' : 'url');
  pv.ext = res.ext || ''; pv.baseDir = res.baseDir || pv.baseDir;
  pv.srcdoc = res.srcdoc || '';
  pv.text = ''; pv.textLoadedFor = ''; pv.view = ''; pv.imgActual = false;
  $('#pv-path').value = target;
  pvState(isFile ? (pv.type === 'web' ? '已加载（沙箱模式）' : '已加载') : '网页预览');
  updatePvNavBtns();
  pushPvRecent({ target, label: res.label, type: pv.type });
  // 用户正在 rail 里看看板时，别把页签抢回预览：内容照常备好，切回来就是最新的
  if (!railKanbanVisible()) setRailTab('preview');
  else {
    $('#rail-hint').textContent = '预览已更新 · 看板';
    const dot = $('#rt-pv-dot');
    if (dot) dot.hidden = false;
  }
  renderPreviewViews();
  await renderPreviewContent();
  if (!pvAvailable()) return true;
  if (isFile) await api.previewWatch(res.filePath);
  else await api.previewUnwatch();
  return true;
}
async function loadPreviewInput(raw, baseDirOverride) {
  const v = String(raw || '').trim();
  if (!v) return;
  if (/^https?:\/\//i.test(v)) {
    let host = v;
    try { host = new URL(v).host; } catch {}
    await setPreview({ ok: true, kind: 'url', type: 'url', url: v, label: host });
    return;
  }
  if (!pvAvailable()) { pvState('此环境无本地预览', true); return; }
  pvState('正在打开…');
  try {
    const res = await api.previewResolve(v, baseDirOverride || pvBaseDir());
    await setPreview(res);
  } catch (err) { pvState('打开失败：' + String((err && err.message) || err), true); }
}
async function reloadPreview() {
  if (!pv.url) { pvState('请先打开一个文件', true); return; }
  if (/^https?:\/\//i.test(pv.url)) {
    loadFrame(pv.url + (pv.url.includes('?') ? '&' : '?') + '_hermes=' + Date.now(), pv.srcdoc);
  } else {
    pv.textLoadedFor = ''; // 文件可能被改写，文本视图必须重读
    if (pv.type === 'image') {
      const img = $('#pv-img');
      const sep = pv.url.includes('?') ? '&' : '?';
      img.src = pv.url + sep + 't=' + Date.now();
    } else await renderPreviewContent();
  }
  pvState('已刷新');
}
$('#btn-rail-toggle').onclick = () => toggleRail();
$('#btn-rail-close').onclick = () => toggleRail(false);
document.querySelectorAll('#rail-tabs .rt').forEach((b) => { b.onclick = () => setRailTab(b.dataset.rail); });
$('#rail-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tabs = Array.from(document.querySelectorAll('#rail-tabs .rt'));
  const idx = tabs.indexOf(document.activeElement);
  if (idx < 0) return;
  e.preventDefault();
  const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  setRailTab(next.dataset.rail);
});
// rail 看板：写操作一律回完整看板页（任务详情抽屉挂在整页里），这里只留新建弹窗这个全局入口
/** 进完整看板前收起 rail：同一份 KB.board 不该并排显示两份，也把 400px 还给 5 列。 */
function openFullKanban(status) {
  toggleRail(false);
  if (status !== undefined) KB.status = status;
  showKanban(true);
}
// 刷新按钮：转起来说明「确实在请求」，否则点了没反馈会让人连点三下
$('#rkb-refresh').onclick = async () => {
  const b = $('#rkb-refresh');
  if (b && b.classList.contains('is-busy')) return; // 已在拉，别叠请求
  if (b) b.classList.add('is-busy');
  try { await kanbanLoad(false); } finally { if (b) b.classList.remove('is-busy'); }
};
$('#rkb-new').onclick = () => kbModalOpen('task');
$('#rkb-expand').onclick = () => openFullKanban();
// 看板切换：占位项（空值）代表「当前看板」，选中别的 = 改筛选，走同一条 kanbanLoad；
// 末尾「＋ 新建看板…」是动作行，只开弹窗、不改 value
const rkbBoardSel = $('#rkb-board');
if (rkbBoardSel) {
  rkbBoardSel.addEventListener('change', () => {
    const next = String(rkbBoardSel.value || '');
    if (next === String(KB.filters.board || '')) return;
    KB.filters.board = next;
    KB.overview = null;
    kbSelectSig = '';   // 整页那个看板下拉的选项缓存要一起作废
    rkbBoardSig = '';
    rkbFilter = '';     // 换了看板，上一块的状态筛选没有意义
    kanbanLoad(true);
  });
  rkbBoardSel.addEventListener('select-action', (e) => {
    if (String((e.detail && e.detail.value) || '') !== '__new-board') return;
    kbModalOpen('board');
  });
}
$('#rkb-summary').addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-rkb-group]');
  if (!b) return;
  const key = String(b.dataset.rkbGroup || '');
  // 再点一次同一组 = 回到全部；筛出 0 张也照样切过去（「这一组是空的」也是信息）
  rkbFilter = rkbFilter === key ? '' : key;
  renderRailKanban();
  const sc = $('#rkb-scroll');
  if (sc) sc.scrollTop = 0;
});
$('#rkb-groups').addEventListener('click', (e) => {
  const more = e.target.closest && e.target.closest('[data-rkb-more]');
  if (more) { openFullKanban(more.dataset.rkbMore); return; }
  const card = e.target.closest && e.target.closest('[data-rkb-task]');
  if (!card || !card.dataset.rkbTask) return;
  // 带着 rail 当前的状态筛选进整页：在「受阻」里点开一张，整页也停在受阻
  openFullKanban(rkbFilter || '');
  openKanbanTask(card.dataset.rkbTask);
});
// 视图切换条是动态生成的，用委托；按钮带 role=tab 与 aria-selected 供读屏识别
$('#pv-view-btns').addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-pv-view]');
  if (b) setPvView(b.dataset.pvView);
});
$('#pv-copy').onclick = () => {
  if (!pv.text) { toast('当前没有可复制的文本', 1600); return; }
  copyText(pv.text).then(() => toast('已复制预览内容', 1400)).catch(() => toast('复制失败', 1600));
};
const togglePvImgZoom = () => {
  if (pv.type !== 'image') return;
  pv.imgActual = !pv.imgActual;
  const box = $('#pv-image');
  if (box) box.classList.toggle('is-actual', pv.imgActual);
  updatePvTools();
};
$('#pv-img-zoom').onclick = togglePvImgZoom;
$('#pv-img').onclick = togglePvImgZoom;
$('#pv-img').addEventListener('load', () => {
  const img = $('#pv-img');
  if (pv.type === 'image' && img.naturalWidth && img.naturalHeight) {
    pvState(`${img.naturalWidth}×${img.naturalHeight}`);
  }
});
$('#pv-doc').addEventListener('click', async (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a) return;
  const href = String(a.getAttribute('href') || '').trim();
  if (!href || href.startsWith('#')) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(href)) {
    if (pvAvailable() && typeof api.previewOpenExternal === 'function') {
      const r = await api.previewOpenExternal(href);
      if (r && !r.ok) toast(r.error || '打开失败', 2200);
    }
    return;
  }
  loadPreviewInput(href, pv.baseDir || pvBaseDir());
});
$('#pv-table').addEventListener('click', (e) => {
  const td = e.target.closest && e.target.closest('tbody td');
  if (!td) return;
  const val = td.textContent || '';
  copyText(val).then(() => toast('已复制单元格内容', 1200)).catch(() => toast('复制失败', 1400));
});
$('#pv-recent').addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-pv-recent]');
  if (btn) loadPreviewInput(btn.dataset.pvRecent);
});
(() => {
  try {
    const savedAuto = localStorage.getItem(PV_AUTO_KEY);
    if (savedAuto === '0' || savedAuto === 'false') $('#pv-auto').checked = false;
  } catch {}
  $('#pv-auto').addEventListener('change', () => {
    try { localStorage.setItem(PV_AUTO_KEY, $('#pv-auto').checked ? '1' : '0'); } catch {}
  });
  renderPvRecent();
})();
$('#pv-open').onclick = async () => {
  if (!pvAvailable()) { toast('此环境无法读取本地文件', 2000); return; }
  const r = await api.previewPick();
  if (r && r.ok) await setPreview(r);
  else if (r && !r.canceled) pvState(r.error || '选择失败', true);
};
$('#pv-path').addEventListener('focus', (e) => { e.target.select(); });
$('#pv-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadPreviewInput(e.target.value); } });
const pvHistory = { stack: [], idx: -1, navigating: false };
function updatePvNavBtns() {
  const b = $('#pv-back'), f = $('#pv-fwd'), c = $('#pv-clear');
  if (b) b.disabled = pvHistory.idx <= 0;
  if (f) f.disabled = pvHistory.idx < 0 || pvHistory.idx >= pvHistory.stack.length - 1;
  if (c) c.disabled = !pv.url && !pv.filePath;
}
async function goPvHistory(delta) {
  const nextIdx = pvHistory.idx + delta;
  if (nextIdx < 0 || nextIdx >= pvHistory.stack.length) return;
  pvHistory.idx = nextIdx;
  pvHistory.navigating = true;
  try { await loadPreviewInput(pvHistory.stack[nextIdx]); }
  finally { pvHistory.navigating = false; updatePvNavBtns(); }
}
async function clearPreview() {
  pv.url = ''; pv.filePath = ''; pv.label = ''; pv.kind = ''; pv.type = '';
  pv.ext = ''; pv.srcdoc = ''; pv.text = ''; pv.textLoadedFor = ''; pv.view = ''; pv.imgActual = false;
  $('#pv-path').value = '';
  const f = $('#pv-frame'); if (f) { f.removeAttribute('srcdoc'); f.src = 'about:blank'; }
  for (const s of ['#pv-frame', '#pv-image', '#pv-doc', '#pv-table', '#pv-raw']) {
    const el = $(s); if (el) el.hidden = true;
  }
  $('#pv-views').hidden = true;
  $('#pv-empty').hidden = false;
  pvState('尚未加载');
  updatePvNavBtns();
  if (pvAvailable()) await api.previewUnwatch();
}
$('#pv-back').onclick = () => goPvHistory(-1);
$('#pv-fwd').onclick = () => goPvHistory(1);
$('#pv-clear').onclick = clearPreview;
$('#pv-reload').onclick = reloadPreview;
$('#pv-external').onclick = async () => {
  const target = pv.filePath || pv.url || $('#pv-path').value.trim();
  if (!target) { toast('请先打开一个文件', 1800); return; }
  if (!pvAvailable()) return;
  const r = await api.previewOpenExternal(target);
  if (r && !r.ok) toast(r.error || '打开失败', 2400);
};
(() => {
  const pane = $('#preview-pane');
  const drop = $('#pv-drop');
  if (!pane || !drop) return;
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  pane.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth += 1;
    drop.hidden = false;
  });
  pane.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });
  pane.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    e.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.hidden = true;
  });
  pane.addEventListener('drop', (e) => {
    dragDepth = 0;
    drop.hidden = true;
    document.body.classList.remove('dropping');
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const filePath = typeof api.pathForFile === 'function' ? api.pathForFile(file) : (file.path || '');
    if (!filePath) { pvState('此环境无法读取拖入的本地路径', true); return; }
    loadPreviewInput(filePath);
  });
})();
let pvReloadTimer = null;
if (hasNative && api.onPreviewChanged) {
  api.onPreviewChanged(({ filePath }) => {
    if (!pv.filePath || filePath !== pv.filePath || $('#rail').hidden) return;
    if (!$('#pv-auto').checked) { pvState('文件已变更 · 自动跟随已关闭'); return; }
    // 一次保存常触发多条 watch 事件，去抖合并，避免 iframe 反复重建闪烁
    clearTimeout(pvReloadTimer);
    pvReloadTimer = setTimeout(() => { reloadPreview(); pvState('已自动刷新'); }, 160);
  });
}

/** 从工具参数 / 结果里找可预览文件路径，自动跟随 Agent 写出的产物。
 *  扩展名与 main/services/hermes-preview.js 的 TYPE_BY_EXT 保持一致。 */
function collectStrings(v, out, depth) {
  if (depth > 3 || out.length > 40) return;
  if (typeof v === 'string') { out.push(v); return; }
  if (Array.isArray(v)) { v.forEach((x) => collectStrings(x, out, depth + 1)); return; }
  if (v && typeof v === 'object') { Object.values(v).forEach((x) => collectStrings(x, out, depth + 1)); }
}
function extractPreviewPaths(text) {
  const found = [];
  const re1 = /["'`](~?\/[^"'`\n]*?\.(?:html?|xhtml|svg|pdf|png|jpe?g|gif|webp|bmp|avif|ico|md|markdown|txt|log|jsonl?|ya?ml|xml|csv|tsv|js|mjs|cjs|tsx?|jsx|py|css|scss|sh|rb|go|rs|java|c|h|cpp|sql|toml))["'`]/gi;
  const re2 = /(?:^|[\s(\[])(~?\/[^\s"'<>\])},;]*\.(?:html?|xhtml|svg|pdf|png|jpe?g|gif|webp|bmp|avif|ico|md|markdown|txt|log|jsonl?|ya?ml|xml|csv|tsv|js|mjs|cjs|tsx?|jsx|py|css|scss|sh|rb|go|rs|java|c|h|cpp|sql|toml))(?=$|[\s"'<>\])},;])/gi;
  for (const re of [re1, re2]) {
    let m; while ((m = re.exec(text)) !== null) { if (!found.includes(m[1])) found.push(m[1]); }
  }
  return found;
}
/** 自动跟随只认「确实会产出/改写文件」的工具，且只在工具跑完之后。
 *  开关写的是「跟随 Agent 生成的文件」，但只读类（read_file / cat / grep /
 *  glob / list_files / web_fetch…）的参数与输出里同样满是已存在的路径，
 *  不拦住的话 Agent 只是读一个 .md 也会把 rail 页签抢到预览上。 */
const PV_WRITE_TOOLS = /^(write_file|save_file|create_file|patch|edit_file|multi_edit|image_generate|video_generate|text_to_speech)/i;
const PV_CMD_TOOLS = /^(terminal|bash|shell|exec_command|run_command|execute_code|process_manage|cronjob_manage)/i;
// 命令类没有 file_path 参数：要么命令里带明确的重定向目标，要么结果里有写入信号，
// 否则 `ls` / `git status` / `cat` 输出里的一串路径都会误触发。
const PV_WRITE_SIGNAL = /\b(?:wrote|written|created|generated|saved|exported|updated)\b|已(?:生成|写入|保存|创建|导出)/i;
const PV_REDIRECT = />{1,2}\s*["']?(~?\/[^\s"'>;|]+\.[a-z0-9]+)/i;
const PV_PATH_KEYS = ['file_path', 'filePath', 'path', 'filename', 'output_path', 'out_path', 'target'];
let pvAutoAt = 0;
async function maybeAutoPreview(evt) {
  if (!pvAvailable() || !$('#pv-auto').checked || evt.isError) return;
  const name = String(evt.name || '');
  const isWrite = PV_WRITE_TOOLS.test(name);
  const isCmd = PV_CMD_TOOLS.test(name);
  if (!isWrite && !isCmd) return;   // 新工具默认不打扰，想跟随就加进白名单
  const parts = [];
  const inp = evt.input;
  if (isWrite) {
    if (inp && typeof inp === 'object' && !Array.isArray(inp)) {
      // 只取路径类字段：write_file 的 content 是整篇文件内容，整段丢进正则
      // 会把文档里提到的其它路径也当成产物。
      for (const k of PV_PATH_KEYS) if (typeof inp[k] === 'string') parts.push(inp[k]);
    }
    if (!parts.length) collectStrings(inp, parts, 0);
  }
  const out = [
    typeof evt.output === 'string' ? evt.output : '',
    typeof evt.preview === 'string' ? evt.preview : '',
  ].join('\n');
  const cmd = isCmd && inp && typeof inp === 'object'
    ? String(inp.command || inp.cmd || inp.script || '') : '';
  const redirected = isCmd ? cmd.match(PV_REDIRECT) : null;
  if (isCmd && !redirected && !PV_WRITE_SIGNAL.test(out)) return;
  if (redirected) parts.unshift(redirected[1]);
  if (out.trim()) parts.push(out);
  const paths = extractPreviewPaths(parts.join('\n'));
  if (!paths.length) return;
  for (const p of paths.slice(0, 3)) {
    let res;
    try { res = await api.previewResolve(p, pvBaseDir()); } catch { continue; }
    if (!res.ok) continue;
    if (res.filePath === pv.filePath && Date.now() - pvAutoAt < 1200) continue;
    pvAutoAt = Date.now();
    if ($('#rail').hidden) toggleRail(true);
    await setPreview(res);
    pvState('已跟随 Agent 写入');
    break;
  }
}
