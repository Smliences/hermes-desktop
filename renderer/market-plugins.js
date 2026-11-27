'use strict';
/* ═══════════ Hermes Desktop Client — 插件 / 技能 / 市场 ═══════════ */
/* global $, esc, arr, clip, safeStringify, safeGet, safeSet, fmtTokens, uid, a11y, state, api, hasNative, toast, showConfirm, closeSubpages, syncInert, pushFocus, popFocus, openSession, refreshSessions, renderTabs, newTab, renderChat, applySettings, syncModelDrift, refreshProfileChip, doSwitchProfile */

/* ---------- 插件/技能页（dsh 式整页：列表 + 详情，通用组件） ---------- */
// kind: builtin = 内置配置（点行进详情表单）；experimental = 开关行
const PLUGIN_DEFS = [
  {
    id: 'subagents', kind: 'builtin', name: '子智能体', ico: '❖', color: 'linear-gradient(135deg,#7ab6f9,#4b89f8)',
    desc: '设置子智能体的递归层级、数量和模型。',
    fields: [
      { group: '运行限制', items: [
        { key: 'maxDepth', label: '最大递归深度', hint: 'ⓘ', value: '1' },
        { key: 'maxParallel', label: '子智能体并行数量上限', hint: 'ⓘ', value: '8' },
      ]},
    ],
    toggles: [
      { key: 'allowModelPick', name: '允许 Agent 为子智能体选择模型', value: false,
        hint: '关闭后，子智能体使用配置的默认模型或父 Agent 的模型；已选模型会保留。' },
    ],
  },
  {
    id: 'web-search', kind: 'builtin', name: '网页搜索', ico: '⌕', color: 'linear-gradient(135deg,#5fd0a5,#2fa57c)',
    desc: '设置 hermes 的搜索提供方。',
    fields: [
      { group: '搜索提供方', items: [
        { key: 'provider', label: '提供方', hint: '', value: 'duckduckgo' },
        { key: 'maxResults', label: '单次结果数量上限', hint: 'ⓘ', value: '8' },
      ]},
    ],
    toggles: [],
  },
  {
    id: 'agent-loop', kind: 'builtin', name: 'Agent 循环', ico: '↻', color: 'linear-gradient(135deg,#a78bfa,#7c5cf0)',
    desc: '控制 Agent 派发工具调用的方式。',
    fields: [
      { group: '派发策略', items: [
        { key: 'dispatch', label: '派发方式', hint: '', value: 'parallel' },
        { key: 'maxSteps', label: '单回合最大步数', hint: 'ⓘ', value: '32' },
      ]},
    ],
    toggles: [],
  },
  {
    id: 'terminal', kind: 'builtin', name: '终端', ico: '▸', color: 'linear-gradient(135deg,#4b5563,#1f2937)',
    desc: '限制多条命令最多跑多久、最多输出多少内容。',
    fields: [
      { group: '执行限制', items: [
        { key: 'timeout', label: '单条命令超时（秒）', hint: 'ⓘ', value: '120' },
        { key: 'maxOutput', label: '最大输出字符数', hint: 'ⓘ', value: '20000' },
      ]},
    ],
    toggles: [],
  },
  { id: 'agent-team', kind: 'experimental', name: '智能体团队', ico: '✚', color: 'linear-gradient(135deg,#f6a85c,#ef7f2e)', tag: '实验性', desc: '启用团队协作、团队工具、成员列表和共享任务看板。' },
  { id: 'voice-input', kind: 'experimental', name: '语音输入', ico: '≈', color: 'linear-gradient(135deg,#64a8f7,#3b74e0)', tag: '实验性', desc: '在本地转写录音，首次使用需安装依赖。' },
  { id: 'auto-auth', kind: 'experimental', name: '自动授权审查', ico: '✓', color: 'linear-gradient(135deg,#5fd0a5,#2fa57c)', tag: '实验性', desc: '自动审查工具调用授权请求，降低打断频率。' },
  { id: 'devtools', kind: 'experimental', name: '开发者工具', ico: '⛭', color: 'linear-gradient(135deg,#9aa5b1,#5c6670)', tag: '实验性', desc: '查看 fiber 状态、事件流与调试信息。' },
];

const SKILL_DEFS = [
  {
    id: 'code-exec', kind: 'builtin', name: '代码执行器', ico: '▸', color: 'linear-gradient(135deg,#4b5563,#1f2937)',
    desc: '沙箱参数：运行代码片段的超时、输出与网络策略。',
    fields: [
      { group: '执行限制', items: [
        { key: 'timeout', label: '单次运行超时（秒）', hint: 'ⓘ', value: '60' },
        { key: 'maxOutput', label: '最大输出字符数', hint: 'ⓘ', value: '20000' },
      ]},
    ],
    toggles: [
      { key: 'allowNet', name: '允许代码访问网络', value: false,
        hint: '关闭后，运行中的代码无法发起外部请求。' },
    ],
  },
  {
    id: 'pdf-tools', kind: 'builtin', name: 'PDF 处理', ico: '▦', color: 'linear-gradient(135deg,#f0868c,#e05259)',
    desc: '解析、拆分与合并 PDF，支持 OCR 识别。',
    fields: [
      { group: '解析限制', items: [
        { key: 'maxPages', label: '单次最大页数', hint: 'ⓘ', value: '200' },
        { key: 'ocrLang', label: 'OCR 语言', hint: '', value: 'zh+en' },
      ]},
    ],
    toggles: [],
  },
  {
    id: 'data-viz', kind: 'builtin', name: '数据可视化', ico: '◫', color: 'linear-gradient(135deg,#5fd0a5,#2fa57c)',
    desc: '图表渲染风格与数据分析报告的输出方式。',
    fields: [
      { group: '输出偏好', items: [
        { key: 'style', label: '默认图表风格', hint: '', value: 'light' },
        { key: 'maxRows', label: '表格预览行数上限', hint: 'ⓘ', value: '500' },
      ]},
    ],
    toggles: [],
  },
  {
    id: 'writing', kind: 'builtin', name: '写作助手', ico: '✎', color: 'linear-gradient(135deg,#7ab6f9,#4b89f8)',
    desc: '长文写作的语气、篇幅与引用格式偏好。',
    fields: [
      { group: '写作偏好', items: [
        { key: 'tone', label: '默认语气', hint: '', value: '专业' },
        { key: 'length', label: '默认篇幅', hint: '', value: '中等' },
      ]},
    ],
    toggles: [],
  },
  { id: 'deep-research', kind: 'experimental', name: '深度研究', ico: '✧', color: 'linear-gradient(135deg,#a78bfa,#7c5cf0)', tag: '实验性', desc: '多轮检索、交叉验证并生成带引用的研究报告。' },
  { id: 'self-heal', kind: 'experimental', name: '自愈修复', ico: '⚒', color: 'linear-gradient(135deg,#f6a85c,#ef7f2e)', tag: '实验性', desc: '任务失败后自动诊断原因并尝试恢复执行。' },
  { id: 'proactive', kind: 'experimental', name: '主动建议', ico: '☀', color: 'linear-gradient(135deg,#ffd166,#e8a616)', tag: '实验性', desc: '根据上下文主动推荐下一步可执行的操作。' },
  { id: 'voice-out', kind: 'experimental', name: '语音播报', ico: '♪', color: 'linear-gradient(135deg,#64a8f7,#3b74e0)', tag: '实验性', desc: '将助手回复用语音朗读，支持自动分句。' },
];

function pluginStateOf(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}

/* ---------- 真实 hermes CLI 数据层（Electron 环境自动启用；浏览器 Demo 走演示数据） ---------- */
const isNativeCLI = () => typeof window.hermesAPI !== 'undefined' && typeof window.hermesAPI.pluginsList === 'function';
const liveData = { plugins: null, skills: null };
// 每类列表的元信息：stale=先展示了上次运行的结果、主进程正在后台重拉
const liveMeta = { plugins: null, skills: null };
// 设置页每个面板只保留一个 catalog:updated 订阅，重绘前先退订上一个，避免泄漏
let offCatalog = null;
function subscribeCatalog(fn) {
  if (offCatalog) { try { offCatalog(); } catch {} offCatalog = null; }
  if (!hasNative || !api.onCatalogUpdated) return;
  offCatalog = api.onCatalogUpdated(fn);
}
// Claude / Anthropic 大地色系：低饱和暖调，替换原先高饱和的蓝紫糖果色，
// 保证白色图标可读，同时在暖纸底上不跳。纯视觉常量，与数据源无关。
// 大地色板：每个色对白色图标字形均 ≥ 5:1（WCAG AA），色相保持 Claude 暖调
const LIVE_COLORS = ['#b4522e', '#64754e', '#5d708a', '#936537', '#a75759', '#7a6c5f', '#58746a', '#826685'];
// 稳定取色：同一条目每次渲染颜色一致，不会因排序/过滤换位而跳色
function colorFor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LIVE_COLORS[h % LIVE_COLORS.length];
}
// 每个页面独立的搜索 / 过滤状态
const catalogUI = {
  'plugins-page': { search: '', filter: 'all' },
  'skills-page': { search: '', filter: 'all' },
};
// 后台刷新完成后的原地重绘不该把用户滚回顶部：先记下滚动位置，重绘后还原。
function withScrollKept(page, fn) {
  const els = [page.querySelector('.pp-groups'), page.querySelector('.pp-listview'), page]
    .filter((el) => el && el.scrollHeight > el.clientHeight);
  const tops = els.map((el) => el.scrollTop);
  fn();
  els.forEach((el, i) => { if (el.scrollTop !== tops[i]) el.scrollTop = tops[i]; });
}
async function loadLive(kind, page, { force = false, revalidate = false, quiet = false } = {}) {
  const api = window.hermesAPI;
  const r = kind === 'plugins' ? await api.pluginsList({ force, revalidate })
                              : await api.skillsList({ force, revalidate });
  if (!r || !r.ok) {
    if (!quiet) toast(`${kind === 'plugins' ? '插件' : '技能'}读取失败：${(r && r.error) || '未知错误'}`, 2800);
    return false;
  }
  liveMeta[kind] = { stale: !!r.stale, ageMs: r.ageMs || 0, warning: r.warning || '' };
  if (r.warning && !quiet) toast(`${kind === 'plugins' ? '插件' : '技能'}列表刷新失败，显示上次结果：${r.warning}`, 3200);
  if (kind === 'plugins') {
    liveData.plugins = r.plugins.map((p) => ({
      id: p.name, name: p.name, configKey: p.configKey || p.name,
      desc: p.desc, ico: '⧉', color: colorFor(p.name), enabled: !!p.enabled,
      source: p.source || '', version: p.version || '',
      meta: [p.source, p.version].filter(Boolean).join(' · '),
      group: p.source === 'bundled' ? '内置插件' : (p.source ? String(p.source) : '其他'),
    }));
  } else {
    const disabled = new Set(r.disabled || []);
    liveData.skills = r.skills.map((s) => ({
      id: s.name, name: s.name, configKey: s.name,
      desc: s.description || '', ico: '✦', color: colorFor(s.name),
      enabled: !disabled.has(s.name),
      source: s.source || '', category: s.category || '',
      meta: [s.category, s.source].filter(Boolean).join(' · '),
      group: s.category || '未分类',
    }));
  }
  if (page && !page.hidden) withScrollKept(page, () => renderSubpageRows(page));
  return true;
}
function subpageDefs(page) {
  const isSkills = page.id === 'skills-page';
  const kind = isSkills ? 'skills' : 'plugins';
  if (isNativeCLI()) {
    // 原生环境：数据来自真实 hermes CLI；未加载完成时渲染空列表（加载中）
    const live = liveData[kind];
    return {
      defs: live || [], storageKey: null, native: true, loading: !live,
      label: isSkills ? '技能' : '插件',
      cmd: isSkills ? 'hermes skills install' : 'hermes plugins install',
    };
  }
  return isSkills
    ? { defs: SKILL_DEFS, storageKey: 'hermes.skills', label: '技能', cmd: 'hermes skill add' }
    : { defs: PLUGIN_DEFS, storageKey: 'hermes.plugins', label: '插件', cmd: 'hermes plugin add' };
}
function toggleSubpage(page, show) {
  if (page.id === 'gateway-page') return; // 消息平台页有自己的开关与数据加载
  if (page.id === 'kanban-page') return;  // 看板有自己的开关、轮询与代次守卫
  page.hidden = !show;
  if (show) {
    // 插件 / 技能 / 消息平台三个整页互斥（position:absolute 会互相叠加）
    document.querySelectorAll('.subpage').forEach((pg) => { if (pg !== page) pg.hidden = true; });
    showSubpageList(page);
    const kind = page.id === 'skills-page' ? 'skills' : 'plugins';
    // 打开即取：主进程命中缓存是毫秒级，命中过期缓存会顺带在后台重拉一次。
    // 已有数据时静默刷新，不要每次开页面都弹提示。
    if (isNativeCLI()) loadLive(kind, page, { quiet: !!liveData[kind] });
  }
}
function showSubpageList(page) {
  page.querySelector('.pp-detailview').hidden = true;
  page.querySelector('.pp-listview').hidden = false;
  page.querySelector('.pp-menu').hidden = true;
  page.querySelector('.pp-head').style.display = '';
  renderSubpageRows(page);
}
function catPrefix(page) { return page.id === 'skills-page' ? 'sk' : 'plg'; }
function updateCatalogStats(page) {
  const { defs, loading, native } = subpageDefs(page);
  const pfx = catPrefix(page);
  const on = defs.filter((d) => d.enabled).length;
  const set = (suffix, v) => { const el = $('#' + pfx + '-stat-' + suffix); if (el) el.textContent = v; };
  set('total', loading ? '…' : defs.length);
  set('on', loading ? '…' : on);
  set('off', loading ? '…' : defs.length - on);
  // 数据源一栏兼任刷新指示：先展示上次结果时标「刷新中」，刷新完自然回到「hermes CLI」
  const meta = liveMeta[page.id === 'skills-page' ? 'skills' : 'plugins'];
  const src = !native ? '演示' : (meta && meta.stale ? 'hermes CLI · 刷新中' : 'hermes CLI');
  set('source', loading ? '…' : src);
}
function cardHTML(p, idx, native, demoOn) {
  const on = native ? !!p.enabled : !!demoOn;
  const name = esc(p.name);
  const locked = native && (p.id === 'hermes-agent' || p.name === 'hermes-agent');
  return `<article class="cat-card ${on ? 'on' : 'off'}" data-idx="${idx}">
    <div class="cat-top">
      <span class="cat-ico" style="background:${p.color}">${p.ico}</span>
      <div class="cat-title">
        <div class="cat-name"><span>${name}</span><span class="cat-badge ${on ? 'ok' : 'off'}">${on ? '已启用' : '已停用'}</span>${locked ? '<span class="cat-tag">核心必需</span>' : (p.tag ? `<span class="cat-tag">${esc(p.tag)}</span>` : '')}</div>
        <div class="cat-key">${esc(p.meta || p.id)}</div>
      </div>
      <button class="plg-switch ${on ? 'on' : ''} ${p.pending ? 'pending' : ''}"${locked ? ' disabled title="核心必需技能，不可停用"' : ` title="${on ? '停用' : '启用'}"`} role="switch" aria-label="${on ? '停用' : '启用'} ${name}"></button>
    </div>
    <p class="cat-desc">${esc(p.desc || '暂无描述')}</p>
    <div class="cat-foot"><code>${esc(p.configKey || p.id)}</code><span>${native ? '点击展开描述' : '查看详情 ›'}</span></div>
  </article>`;
}
function renderSubpageRows(page) {
  const { defs, storageKey, native, loading } = subpageDefs(page);
  const pfx = catPrefix(page);
  const ui = catalogUI[page.id];
  const groups = page.querySelector('.pp-groups');
  if (!groups) return;
  updateCatalogStats(page);
  const clear = page.querySelector('.pp-search-wrap button');
  if (clear) clear.hidden = !ui.search;
  page.querySelectorAll('.pp-filters button').forEach((b) => b.classList.toggle('on', b.dataset.filter === ui.filter));
  const cnt = $('#' + pfx + '-count');
  if (loading) {
    groups.innerHTML = '<div class="cat-grid">' +
      Array.from({ length: 8 }, () => '<div class="cat-card cat-skel"><span class="skel-line w60"></span><span class="skel-line w90"></span></div>').join('') +
      '</div><div class="cat-loading">首次读取 hermes CLI 数据，需要几秒；之后走本地缓存秒开…</div>';
    if (cnt) cnt.textContent = '读取中…';
    return;
  }
  const demoState = storageKey ? pluginStateOf(storageKey) : {};
  const q = ui.search.trim().toLowerCase();
  const isOn = (d) => native ? !!d.enabled : !!demoState[d.id];
  const filtered = defs.filter((d) => {
    if (ui.filter === 'on' && !isOn(d)) return false;
    if (ui.filter === 'off' && isOn(d)) return false;
    if (!q) return true;
    return [d.name, d.id, d.desc, d.meta, d.group].some((v) => String(v || '').toLowerCase().includes(q));
  });
  if (cnt) cnt.textContent = `${filtered.length} / ${defs.length}`;
  if (!filtered.length) {
    groups.innerHTML = `<div class="cat-empty">${q || ui.filter !== 'all' ? '没有匹配的条目' : 'hermes CLI 未返回任何条目'}</div>`;
    return;
  }
  const buckets = new Map();
  filtered.forEach((d) => {
    const g = native ? (d.group || '其他') : (d.kind === 'builtin' ? '内置配置' : '实验性');
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g).push(d);
  });
  const names = [...buckets.keys()].sort((a, b) => {
    const pri = (s) => (s === '内置插件' || s === '内置配置') ? 0 : (s === '未分类' || s === '其他') ? 2 : 1;
    return pri(a) - pri(b) || a.localeCompare(b);
  });
  const idxMap = new Map(defs.map((d, i) => [d, i]));
  groups.innerHTML = names.map((g) => {
    const items = buckets.get(g).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return `<section class="cat-group"><div class="cat-group-label">${esc(g)} <span>${items.length}</span></div>` +
      `<div class="cat-grid">${items.map((d) => cardHTML(d, idxMap.get(d), native, demoState[d.id])).join('')}</div></section>`;
  }).join('');
}
/** 只重绘单个卡片 + 统计条：开关点击后不整页重排，避免闪烁与丢失焦点。 */
function paintCard(page, p) {
  const { defs, native, storageKey } = subpageDefs(page);
  const idx = defs.indexOf(p);
  const card = page.querySelector(`.cat-card[data-idx="${idx}"]`);
  if (!card) return;
  const on = native ? !!p.enabled : !!pluginStateOf(storageKey)[p.id];
  card.classList.toggle('on', on);
  card.classList.toggle('off', !on);
  const badge = card.querySelector('.cat-badge');
  if (badge) { badge.className = 'cat-badge ' + (on ? 'ok' : 'off'); badge.textContent = on ? '已启用' : '已停用'; }
  const sw = card.querySelector('.plg-switch');
  if (sw) { sw.classList.toggle('on', on); sw.classList.toggle('pending', !!p.pending); sw.title = on ? '停用' : '启用'; }
  updateCatalogStats(page);
}
/** 乐观开关：点击立即翻转，后台落盘；失败自动回滚。 */
async function toggleCatalogItem(page, idx) {
  const { defs, native, storageKey } = subpageDefs(page);
  const p = defs[idx];
  if (!p || p.pending) return;
  if (!native) {
    const st = pluginStateOf(storageKey); st[p.id] = !st[p.id];
    localStorage.setItem(storageKey, JSON.stringify(st));
    paintCard(page, p);
    toast(`${st[p.id] ? '已启用' : '已停用'} ${p.name}`, 1400);
    return;
  }
  const isSkills = page.id === 'skills-page';
  const next = !p.enabled;
  p.enabled = next; p.pending = true;
  paintCard(page, p);
  // 插件开关走 hermes CLI（冷启约 8–10s），明确告知后台仍在处理，避免误以为卡死
  if (!isSkills) toast(`正在后台应用 ${p.name}…可继续操作其他条目`, 2200);
  const api = window.hermesAPI;
  let r;
  try {
    r = isSkills ? await api.skillsSetEnabled(p.configKey || p.id, next)
                 : await api.pluginsSetEnabled(p.configKey || p.id, next);
  } catch (err) { r = { ok: false, error: String(err && err.message || err) }; }
  p.pending = false;
  if (r && r.ok) {
    paintCard(page, p);
    toast(`${next ? '已启用' : '已停用'} ${p.name}${isSkills ? '（即时保存）' : '（下次会话生效）'}`, 1600);
  } else {
    p.enabled = !next;
    paintCard(page, p);
    toast(`操作失败：${(r && r.error) || '未知错误'}`, 2800);
  }
}
function showSubpageDetail(page, p) {
  const { storageKey } = subpageDefs(page);
  page.querySelector('.pp-head').style.display = 'none';
  page.querySelector('.pp-listview').hidden = true;
  const det = page.querySelector('.pp-detailview'); det.hidden = false;
  const icon = page.querySelector('.pp-detail-icon');
  icon.textContent = p.ico;
  icon.style.background = p.color;
  icon.style.color = '#fff';
  page.querySelector('.pp-detail-title').textContent = p.name;
  page.querySelector('.pp-detail-desc').textContent = p.desc;
  const form = page.querySelector('.ppd-form'); form.innerHTML = '';
  const enabled = pluginStateOf(storageKey);
  const draft = { ...((enabled['__cfg__' + p.id]) || {}) };
  (p.fields || []).forEach((g) => {
    const gl = document.createElement('div'); gl.className = 'pp-group-label'; gl.textContent = g.group;
    form.appendChild(gl);
    const wrap = document.createElement('div'); wrap.className = 'pp-fields';
    g.items.forEach((f) => {
      const val = draft[f.key] !== undefined ? draft[f.key] : f.value;
      const field = document.createElement('div'); field.className = 'pp-field';
      field.innerHTML = `<div class="pp-field-label">${f.label}<span class="hint">${f.hint || ''}</span></div>`;
      const input = document.createElement('input');
      input.className = 'pp-input'; input.value = val; input.spellcheck = false;
      input.addEventListener('input', () => { draft[f.key] = input.value; save.classList.add('dirty'); });
      field.appendChild(input); wrap.appendChild(field);
    });
    form.appendChild(wrap);
  });
  (p.toggles || []).forEach((t) => {
    const val = draft[t.key] !== undefined ? draft[t.key] : t.value;
    const gl = document.createElement('div'); gl.className = 'pp-group-label';
    gl.textContent = t.key === 'allowModelPick' ? '模型选择' : t.key === 'allowNet' ? '网络' : '选项';
    form.appendChild(gl);
    const row = document.createElement('div'); row.className = 'pp-toggle-row';
    row.innerHTML = `
      <div class="pp-toggle-main">
        <div class="pp-toggle-name">${t.name}</div>
        <div class="pp-toggle-hint">${t.hint || ''}</div>
      </div>`;
    const sw = document.createElement('button');
    sw.className = 'plg-switch ' + (val ? 'on' : ''); sw.setAttribute('role', 'switch');
    sw.onclick = () => { sw.classList.toggle('on'); draft[t.key] = sw.classList.contains('on'); save.classList.add('dirty'); };
    row.appendChild(sw); form.appendChild(row);
  });
  const save = page.querySelector('.pp-save');
  save.classList.remove('dirty');
  save.onclick = () => {
    enabled['__cfg__' + p.id] = draft;
    localStorage.setItem(storageKey, JSON.stringify(enabled));
    save.classList.remove('dirty');
    toast(`已保存 ${p.name} 配置`, 1400);
  };
}
function setupSubpage(page) {
  const { label, cmd } = subpageDefs(page);
  const kind = page.id === 'skills-page' ? 'skills' : 'plugins';
  const ui = catalogUI[page.id];
  const back = page.querySelector('.pp-back'); if (back) back.onclick = () => showSubpageList(page);
  const close = page.querySelector('.pp-close'); if (close) close.onclick = () => toggleSubpage(page, false);
  const refresh = page.querySelector('.pp-refresh');
  if (refresh) refresh.onclick = async () => {
    const sp = refresh.querySelector('.spin'), g = refresh.querySelector('.pp-refresh-glyph');
    if (sp) sp.hidden = false; if (g) g.hidden = true;
    // 强制重读要真跑一次 CLI/Python（6–8s），先把预期说清楚，别让人以为点空了
    if (isNativeCLI()) toast(`正在重新读取${label}，约需 6–8 秒…`, 2200);
    let ok = true;
    if (isNativeCLI()) ok = await loadLive(kind, page, { force: true });
    else showSubpageList(page);
    if (sp) sp.hidden = true; if (g) g.hidden = false;
    if (ok !== false) toast(`${label}列表已刷新`, 1200);
  };
  const toggleMenu = () => { const m = page.querySelector('.pp-menu'); if (m) m.hidden = !m.hidden; };
  const addMain = page.querySelector('.pp-add-main'), addCaret = page.querySelector('.pp-add-caret');
  if (addMain) addMain.onclick = toggleMenu;
  if (addCaret) addCaret.onclick = toggleMenu;
  page.querySelectorAll('.pp-menu button').forEach((b) => {
    b.onclick = () => {
      page.querySelector('.pp-menu').hidden = true;
      const act = b.dataset.act;
      if (act === 'cmd') {
        const full = `${cmd} <path>`;
        if (typeof gwCopy === 'function') gwCopy(full);
        toast(`已复制安装命令：${full}`, 2400);
      } else if (act === 'local') toast(`请将本地${label}目录放入 ~/.hermes/${kind === 'plugins' ? 'plugins' : 'skills'} 后点击右上角刷新`, 2600);
      else openMarket(kind, page.id);
    };
  });
  // 搜索 / 过滤：只重绘卡片区，输入焦点不丢失
  const inp = page.querySelector('.pp-search-wrap input');
  const clear = page.querySelector('.pp-search-wrap button');
  if (inp) {
    let _deb = 0;
    inp.addEventListener('input', () => {
      ui.search = inp.value;
      clearTimeout(_deb);
      _deb = setTimeout(() => renderSubpageRows(page), 150);
    });
  }
  if (clear) clear.onclick = () => { if (inp) { inp.value = ''; inp.focus(); } ui.search = ''; renderSubpageRows(page); };
  page.querySelectorAll('.pp-filters button').forEach((b) => {
    b.onclick = () => { ui.filter = b.dataset.filter; renderSubpageRows(page); };
  });
  // 卡片事件委托：开关 / 展开描述 / 演示模式详情
  const groups = page.querySelector('.pp-groups');
  if (groups) groups.addEventListener('click', (e) => {
    const card = e.target.closest('.cat-card');
    if (!card || card.classList.contains('cat-skel')) return;
    const idx = +card.dataset.idx;
    if (e.target.closest('.plg-switch')) { toggleCatalogItem(page, idx); return; }
    const { defs, native } = subpageDefs(page);
    const p = defs[idx];
    if (!p) return;
    if (native) card.classList.toggle('expanded');
    else if (p.kind === 'builtin') showSubpageDetail(page, p);
    else toggleCatalogItem(page, idx);
  });
}
setupSubpage($('#plugins-page'));
setupSubpage($('#skills-page'));
document.addEventListener('click', (e) => {
  document.querySelectorAll('.subpage .pp-add-wrap').forEach((w) => {
    if (!w.contains(e.target)) w.querySelector('.pp-menu').hidden = true;
  });
});

/* ---------- 插件 / 技能市场（CLI 原生 registries） ----------
 * 数据完全来自 hermes CLI：plugins 走本地 curated catalog，skills 走在线聚合源。
 * 安装是写操作，需二次确认 + 明确来源；失败给出可复制的原命令便于终端重试。 */
const mk = {
  kind: 'plugins', query: '', source: 'all', items: [], busy: false, skeleton: false,
  error: '', ms: 0, limit: 48, expanded: new Set(), confirm: null, armed: new Set(),
  inspect: new Map(), updates: new Set(), checking: false, returnTo: 'plugins-page',
};
const mkCache = new Map();
const MK_CHIPS = {
  plugins: ['browser', 'memory', 'search', 'automation', 'mcp', 'image', 'terminal', 'data'],
  skills: ['writing', 'python', 'data', 'web', 'productivity', 'agent', 'research', 'design'],
};
const mkApi = () => window.hermesAPI;
function mkStatus(text, cls) {
  const el = $('#mk-status');
  el.textContent = text;
  el.className = 'mk-status' + (cls ? ' ' + cls : '');
}
function mkKey(q) { return `${mk.kind}|${q}|${mk.kind === 'skills' ? mk.source : 'all'}`; }
function mkRenderChips() {
  $('#mk-chips').innerHTML = (MK_CHIPS[mk.kind] || []).map((c) =>
    `<button class="mk-chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('');
}
function mkCapList(caps, key) {
  const v = (caps && caps[key]) || [];
  return Array.isArray(v) ? v.filter(Boolean).map(String) : [];
}
/** 目录声明的能力。没有声明时明确说「不知道」，不把空白误读成安全。 */
function mkCapHTML(caps, compact, emptyText) {
  const rows = [
    ['需要环境变量', mkCapList(caps, 'requires_env'), 'warn'],
    ['提供工具', mkCapList(caps, 'provides_tools'), ''],
    ['提供 hooks', mkCapList(caps, 'provides_hooks'), ''],
    ['中间件', mkCapList(caps, 'provides_middleware'), ''],
  ].filter(([, v]) => v.length);
  if (!rows.length) {
    return `<div class="mk-cap-none">${esc(emptyText || '目录未声明能力信息，无法据此判断运行时权限')}</div>`;
  }
  return `<div class="mk-cap${compact ? ' compact' : ''}">` + rows.map(([k, v, cls]) =>
    `<div class="mk-cap-row ${cls}"><span class="mk-cap-k">${esc(k)}</span>` +
    `<span class="mk-cap-v">${esc(v.join('、'))}</span></div>`).join('') + `</div>`;
}
function mkItemKey(it) { return String((it && (it.id || it.name)) || ''); }
function mkDetailHTML(it, idx) {
  const key = mkItemKey(it);
  const bits = [
    ['标识', it.id], ['来源', it.source], ['维护者', it.maintainer], ['分类', it.category],
    ['版本', it.version], ['Hermes 要求', it.requiresHermes],
  ].filter(([, v]) => v);
  const insp = mk.inspect.get(key);
  const issuesList = Array.isArray(it.known_issues) ? it.known_issues
    : (Array.isArray(it.knownIssues) ? it.knownIssues : []);
  const cmd = mk.kind === 'plugins'
    ? `hermes plugins install ${it.id} --no-enable --no-deps`
    : `hermes skills install ${it.id} --yes`;
  return `<div class="mk-detail">` +
    bits.map(([k, v]) => `<div><b>${esc(k)}：</b>${esc(v)}</div>`).join('') +
    (issuesList.length
      ? `<div class="mk-sec-label">已知问题</div><ul class="mk-issues">${issuesList.map((x) => `<li>${esc(typeof x === 'string' ? x : (x.message || x.title || JSON.stringify(x)))}</li>`).join('')}</ul>`
      : '') +
    `<div class="mk-sec-label">目录声明的能力</div>` +
    mkCapHTML(it.capabilities, false, mk.kind === 'skills' ? '技能搜索结果不含权限声明，请点「安装前预览」查看 SKILL.md' : '') +
    `<div style="margin-top:8px"><code>${esc(cmd)}</code> <button class="mk-btn" data-act="copy" data-cmd="${esc(cmd)}">复制</button></div>` +
    (insp ? `<div class="mk-review"><div class="mk-review-head"><b>安装前内容预览 · 只读</b>` +
      `<span>${esc(mk.kind === 'plugins' ? 'hermes plugins show' : 'hermes skills inspect')}</span></div>` +
      `<pre>${esc(insp)}</pre></div>` : '') +
    `</div>`;
}
function mkCardHTML(it, idx) {
  const key = mkItemKey(it);
  const installed = !!it.installed;
  const isPlugin = mk.kind === 'plugins';
  const trustCls = ['trusted', 'builtin', 'official', 'verified'].includes(it.trust) ? 'safe' : '';
  const meta = [it.source, it.category, it.maintainer, it.version].filter(Boolean).map(esc).join(' · ');
  const detail = mk.expanded.has(key) ? mkDetailHTML(it, idx) : '';
  // 技能安装没有 --no-enable / --no-deps 这类开关（CLI 只接受 --yes），
  // 且装完默认启用。确认卡必须按类别展示真实命令，不能沿用插件的权限文案。
  const confirmNote = isPlugin
    ? '第三方插件代码将在本机运行。请核对下列声明；默认保持停用、不下载依赖。'
    : '技能内容会写入本机技能目录并默认启用；技能安装没有停用 / 依赖开关。建议先看「安装前预览」，装完可在技能页停用。';
  const permLine = isPlugin
    ? '<div class="mk-perm"><span>默认最小权限</span><code>--no-enable --no-deps</code></div>'
    : `<div class="mk-perm"><span>实际执行命令</span><code>hermes skills install ${esc(it.id)} --yes</code></div>`;
  const confirm = mk.confirm === idx
    ? `<div class="mk-confirm">
        <div class="mk-confirm-head"><b>安装前请确认</b><span class="mk-confirm-src">来自 ${esc(it.source || '第三方来源')}</span></div>
        <p class="mk-confirm-note">${confirmNote}</p>
        ${permLine}
        ${mkCapHTML(it.capabilities, true, isPlugin ? '目录未声明能力信息，无法据此判断运行时权限' : '技能目录不含权限声明，建议先点「安装前预览」')}
        ${isPlugin
          ? `<label class="mk-opt"><input type="checkbox" class="mk-deps" /> 允许下载 Python 依赖（--yes-deps）</label>
             <details class="mk-adv"><summary>高级：锁定到指定提交</summary>
               <label class="mk-adv-row">40 位 commit SHA <input class="mk-ref" type="text" spellcheck="false" maxlength="40" placeholder="留空则跟随目录版本" /></label>
               <div class="mk-adv-hint">仅本次安装生效；格式不合法会被拒绝。</div>
             </details>`
          : ''}
        <div class="mk-confirm-btns">` +
      (isPlugin
        ? `<button class="mk-btn primary" data-act="do-install" data-enable="0">安装（保持停用）</button>` +
          `<button class="mk-btn" data-act="do-install" data-enable="1" title="会启用插件并运行其代码">安装并启用</button>`
        : `<button class="mk-btn primary" data-act="do-install" data-enable="0">确认安装</button>`) +
      `<button class="mk-btn" data-act="cancel">取消</button></div></div>`
    : '';
  const armed = mk.armed.has(key);
  return `<article class="mk-card ${mk.expanded.has(key) ? 'expanded' : ''}" data-idx="${idx}">
    <div class="mk-card-top">
      <span class="mk-ico">${mk.kind === 'plugins' ? '⧉' : '✦'}</span>
      <div class="mk-card-title">
        <div class="mk-name"><span>${esc(it.name || it.id)}</span><span class="mk-trust ${trustCls}">${esc(it.trustLabel || '社区')}</span>${installed ? '<span class="mk-installed">已安装</span>' : ''}${mk.updates.has(it.name || it.id) ? '<span class="mk-upd">有更新</span>' : ''}</div>
        <div class="mk-id">${esc(it.id)}</div>
        ${(it.needsNewer || it.issues) ? `<div class="mk-flags">${it.needsNewer ? `<span class="mk-warn" title="该条目要求更新的 Hermes：${esc(it.needsNewer)}">需先升级 CLI</span>` : ''}${it.issues ? `<span class="mk-warn" title="目录标注了 ${it.issues} 条已知问题，安装前请点「安装前预览」查看">已知问题 ${it.issues}</span>` : ''}</div>` : ''}
      </div>
      ${installed ? (mk.justInstalled === key && isPlugin
        ? '<button class="mk-btn primary" data-act="enable-installed">立即启用</button>'
        : '<button class="mk-btn" disabled>已安装</button>') : '<button class="mk-btn primary" data-act="install">安装</button>'}
    </div>
    <p class="mk-desc">${esc(it.description || '暂无描述')}</p>
    ${meta ? `<div class="mk-meta">${meta}</div>` : ''}
    <div class="mk-actions">
      <button class="mk-btn" data-act="detail">${mk.expanded.has(key) ? '收起详情' : '详情'}</button>
      <button class="mk-btn" data-act="inspect">安装前预览</button>
      ${it.repo || it.docsUrl ? `<button class="mk-btn" data-act="repo">查看源码 ↗</button>` : ''}
      ${installed ? `<button class="mk-btn" data-act="update">更新</button>` +
        `<button class="mk-btn danger" data-act="uninstall">${armed ? '确认卸载' : '卸载'}</button>` : ''}
    </div>
    ${detail}${confirm}
  </article>`;
}
function renderMarket() {
  const box = $('#mk-results'); if (!box) return;
  const go = $('#mk-go'); if (go) go.disabled = mk.busy;
  $('#mk-clear').hidden = !$('#mk-query').value;
  if (mk.skeleton) {
    box.innerHTML = Array.from({ length: 6 }, () =>
      '<div class="mk-skel"><span style="width:55%"></span><span style="width:88%"></span><span style="width:72%"></span></div>').join('');
    $('#mk-foot').textContent = '';
    return;
  }
  if (mk.error) {
    const q = mk.query ? ` ${esc(mk.query)}` : '';
    const cmd = mk.kind === 'plugins' ? `hermes plugins search${q} --json` : `hermes skills search${q ? ' "' + mk.query + '"' : ' ""'} --json --limit 30`;
    box.innerHTML = `<div class="mk-error">${esc(mk.error)}<code>${esc(cmd)}</code>` +
      `<div style="margin-top:10px;display:flex;gap:6px"><button class="mk-btn" data-act="copy" data-cmd="${esc(cmd)}">复制命令</button>` +
      `<button class="mk-btn" data-act="retry">重试</button></div></div>`;
    $('#mk-foot').textContent = '在线技能源需要网络；若 CLI 在终端能跑通，请检查网络代理后重试。可复制上方命令到终端验证。';
    return;
  }
  let list = mk.items.slice();
  const flt = ($('#mk-filter') && $('#mk-filter').value) || 'all';
  if (flt === 'installed') list = list.filter((it) => !!it.installed);
  else if (flt === 'uninstalled') list = list.filter((it) => !it.installed);
  else if (flt === 'updates') list = list.filter((it) => mk.updates.has(it.name || it.id));
  const srt = ($('#mk-sort') && $('#mk-sort').value) || 'default';
  if (srt === 'name') list.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  else if (srt === 'installed') list.sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
  if (!list.length) {
    box.innerHTML = '<div class="mk-empty">没有匹配的条目。换个关键词，或切换筛选/来源试试。</div>';
    $('#mk-foot').textContent = '';
    return;
  }
  const shown = list.slice(0, mk.limit);
  box.innerHTML = shown.map((it) => mkCardHTML(it, mk.items.indexOf(it))).join('') +
    (list.length > mk.limit
      ? `<button class="mk-chip" data-act="more" style="grid-column:1/-1;height:32px">显示更多（还有 ${list.length - mk.limit} 条）</button>` : '');
  $('#mk-foot').textContent = `共 ${list.length} 条 · 显示 ${shown.length} 条 · ${mk.ms}ms · 安装/卸载会调用 hermes CLI，完成后自动刷新本机列表`;
}
async function mkSearch(q, { force = false } = {}) {
  if (mk.busy) return;
  const fEl = $('#mk-filter'), sEl = $('#mk-sort');
  if (fEl && !fEl._bound) { fEl._bound = true; fEl.onchange = () => renderMarket(); }
  if (sEl && !sEl._bound) { sEl._bound = true; sEl.onchange = () => renderMarket(); }
  q = String(q == null ? '' : q).trim();
  mk.query = q; mk.error = ''; mk.limit = 48; mk.confirm = null; mk.armed.clear();
  mk.expanded.clear(); mk.inspect.clear();
  const key = mkKey(q);
  if (!force && mkCache.has(key)) {
    const c = mkCache.get(key);
    mk.items = c.items; mk.ms = c.ms;
    mkStatus(`${mk.items.length} 条结果 · 缓存`, '');
    mk.skeleton = false; renderMarket(); return;
  }
  if (!isNativeCLI() || typeof mkApi().marketSearch !== 'function') {
    mk.error = '市场需要 Hermes 桌面端与 hermes CLI（演示模式不可用）';
    mkStatus('不可用', 'err'); mk.skeleton = false; renderMarket(); return;
  }
  mk.busy = true; mk.skeleton = true;
  mkStatus(mk.kind === 'skills' ? '正在搜索在线技能源…（首次可能 10–30 秒）' : '正在读取插件目录…', 'busy');
  renderMarket();
  let r;
  try { r = await mkApi().marketSearch(mk.kind, q, { limit: 60, source: mk.source, force: !!force }); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  mk.busy = false; mk.skeleton = false;
  if (!r || !r.ok) {
    mk.error = (r && r.error) || '搜索失败'; mk.items = [];
    mkStatus('搜索失败', 'err');
  } else {
    mk.items = r.items || []; mk.ms = r.ms || 0;
    mkCache.set(key, { items: mk.items, ms: mk.ms });
    const cacheTag = r.cached ? (r.stale ? ' · 缓存（后台同步中）' : ' · 缓存') : '';
    mkStatus(`${mk.items.length} 条结果${cacheTag} · ${mk.ms}ms`, '');
  }
  renderMarket();
}
/** 只读更新检查：插件走 check-updates --json，可精确标出「有更新」的卡片。 */
async function mkCheckUpdates() {
  if (mk.busy || mk.checking) return;
  if (!isNativeCLI() || typeof mkApi().marketCheckUpdates !== 'function') {
    toast('需要 hermes CLI 才能检查更新', 2000); return;
  }
  mk.checking = true;
  const btn = $('#mk-check-updates');
  if (btn) btn.disabled = true;
  mkStatus('正在检查已安装插件的更新…（只读）', 'busy');
  let r;
  try { r = await mkApi().marketCheckUpdates('plugins'); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  mk.checking = false;
  if (btn) btn.disabled = false;
  if (!r || !r.ok) { mkStatus(`更新检查失败：${(r && r.error) || '未知错误'}`, 'err'); return; }
  mk.updates = new Set(r.names || []);
  mkStatus(mk.updates.size ? `${mk.updates.size} 个插件有新版本，已在卡片上标记` : '已检查，暂无可用更新', '');
  renderMarket();
}
function mkSwitchKind(kind) {
  if (kind !== 'skills' && kind !== 'plugins') return;
  if (mk.busy) { toast('还有命令在执行，请稍候', 1800); return; }
  mk.kind = kind; mk.confirm = null; mk.armed.clear(); mk.expanded.clear(); mk.inspect.clear();
  mk.updates.clear();
  document.querySelectorAll('.mk-tab').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  $('#mk-source').hidden = kind !== 'skills';
  $('#mk-check-updates').hidden = kind !== 'plugins';
  $('#mk-source-note').textContent = kind === 'plugins'
    ? 'Hermes 精选目录 · 本地 catalog' : 'skills.sh / ClawHub / GitHub 等聚合 · 需要网络';
  $('#mk-query').placeholder = kind === 'plugins'
    ? '搜索插件名称、描述或工具…（留空列出全部）' : '搜索技能关键词…（留空列出官方精选）';
  mkRenderChips();
  const cacheKey = `${kind}||${kind === 'skills' ? mk.source : 'all'}`;
  if (mkCache.has(cacheKey)) {
    const c = mkCache.get(cacheKey);
    mk.items = c.items; mk.ms = c.ms; mk.query = ''; mk.error = '';
    $('#mk-query').value = '';
    mkStatus(`${mk.items.length} 条结果 · 缓存`, '');
    mk.skeleton = false; renderMarket();
  } else mkSearch('');
}
function openMarket(kind, from) {
  mk.returnTo = from || (kind === 'skills' ? 'skills-page' : 'plugins-page');
  document.querySelectorAll('.subpage').forEach((pg) => { pg.hidden = true; });
  $('#market-page').hidden = false;
  mkSwitchKind(kind || (mk.returnTo === 'skills-page' ? 'skills' : 'plugins'));
}
function closeMarket() {
  $('#market-page').hidden = true;
  const p = $('#' + mk.returnTo); if (p) p.hidden = false;
}
async function mkAction(op, idx, opts = {}) {
  if (mk.busy) { toast('还有命令在执行，请稍候', 1800); return; }
  const it = mk.items[idx]; if (!it) return;
  const label = ({ install: '安装', uninstall: '卸载', update: '更新', inspect: '读取预览' })[op] || '操作';
  const ident = op === 'install' || op === 'inspect' ? it.id : (it.name || it.id);
  const key = mkItemKey(it);
  mk.busy = true; mk.confirm = null; mk.armed.delete(key);
  mkStatus(`正在${label} ${it.name}…（CLI 冷启或下载可能需要十几秒）`, 'busy');
  renderMarket();
  let r;
  try { r = await mkApi().marketAction(mk.kind, op, ident, opts); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  mk.busy = false;
  if (!r || !r.ok) {
    mkStatus(`${label}失败：${(r && r.error) || '未知错误'}`, 'err');
    toast(`${label}失败，详见状态行`, 2600);
  } else if (op === 'inspect') {
    mk.inspect.set(key, r.text || '（无输出）'); mk.expanded.add(key);
    mkStatus(`${label}完成`, '');
  } else {
    if (op === 'install') {
      it.installed = true;
      mk.updates.delete(it.name || it.id);
      mk.justInstalled = (mk.kind === 'plugins' && !(opts && opts.enable)) ? key : '';
    }
    if (op === 'uninstall') { it.installed = false; if (mk.justInstalled === key) mk.justInstalled = ''; }
    mkCache.clear();
    mkStatus(`${label}完成：${it.name}` + (mk.justInstalled === key ? '（已安装但默认停用，可点击「立即启用」）' : ''), '');
    toast(`${label}完成：${it.name}`, 2000);
    // 同步刷新本机「插件 / 技能」页列表：先给缓存（毫秒），后台重拉后由
    // catalog:updated 事件回来重绘——不再为了一次安装阻塞 6–8s 冷启 CLI。
    const page = $('#' + (mk.kind === 'plugins' ? 'plugins-page' : 'skills-page'));
    if (page && isNativeCLI()) loadLive(mk.kind, page, { revalidate: true, quiet: true });
  }
  renderMarket();
}
$('#mk-results').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'copy') { toast(gwCopy(btn.dataset.cmd) ? '已复制命令' : '复制失败，请手动复制', 1800); return; }
  if (act === 'retry') { mkCache.delete(mkKey(mk.query)); mkSearch(mk.query, { force: true }); return; }
  if (act === 'more') { mk.limit += 48; renderMarket(); return; }
  const card = btn.closest('.mk-card'); if (!card) return;
  const idx = +card.dataset.idx; const it = mk.items[idx]; if (!it) return;
  const key = mkItemKey(it);
  // 详情与确认卡互斥：同时展开会把确认按钮推到 900px 以下，增加操作成本。
  if (act === 'install') {
    mk.expanded.delete(key);
    mk.confirm = mk.confirm === idx ? null : idx;
    renderMarket(); return;
  }
  if (act === 'enable-installed') {
    if (mk.busy || !isNativeCLI() || !mkApi().pluginsSetEnabled) return;
    mk.busy = true;
    mkStatus(`正在启用 ${it.name}…`, 'busy');
    renderMarket();
    mkApi().pluginsSetEnabled(it.name || it.id, true).then((r) => {
      mk.busy = false;
      if (r && r.ok) {
        mk.justInstalled = '';
        mkStatus(`已启用：${it.name}`, '');
        toast(`已启用：${it.name}`, 1800);
        const page = $('#plugins-page');
        if (page) loadLive('plugins', page, { revalidate: true, quiet: true });
      } else {
        mkStatus(`启用失败：${(r && r.error) || '未知错误'}`, 'err');
      }
      renderMarket();
    }).catch((err) => {
      mk.busy = false;
      mkStatus(`启用失败：${(err && err.message) || err}`, 'err');
      renderMarket();
    });
    return;
  }
  if (act === 'cancel') { mk.confirm = null; renderMarket(); return; }
  if (act === 'do-install') {
    const deps = card.querySelector('.mk-deps');
    const refEl = card.querySelector('.mk-ref');
    mkAction('install', idx, {
      enable: btn.dataset.enable === '1',
      deps: !!(deps && deps.checked),
      ref: refEl ? refEl.value.trim() : '',
    });
    return;
  }
  if (act === 'detail') {
    mk.confirm = null;
    if (mk.expanded.has(key)) mk.expanded.delete(key); else mk.expanded.add(key);
    renderMarket(); return;
  }
  if (act === 'repo') {
    const url = it.docsUrl || it.repo;
    if (url && mkApi().openExternal) mkApi().openExternal(url);
    return;
  }
  if (act === 'inspect') { mkAction('inspect', idx); return; }
  if (act === 'update') { mkAction('update', idx); return; }
  if (act === 'uninstall') {
    if (!mk.armed.has(key)) { mk.armed.add(key); renderMarket(); return; }
    mkAction('uninstall', idx);
  }
});
document.querySelectorAll('.mk-tab').forEach((b) => { b.onclick = () => mkSwitchKind(b.dataset.kind); });
$('#mk-go').onclick = () => mkSearch($('#mk-query').value);
$('#mk-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') mkSearch(e.target.value); });
$('#mk-clear').onclick = () => { $('#mk-query').value = ''; mkSearch(''); };
$('#mk-source').onchange = (e) => { mk.source = e.target.value; mkSearch(mk.query, { force: true }); };
$('#mk-refresh').onclick = () => { mkCache.clear(); mkSearch(mk.query, { force: true }); };
$('#mk-check-updates').onclick = mkCheckUpdates;
$('#mk-close').onclick = closeMarket;
$('#mk-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-chip]'); if (!b) return;
  $('#mk-query').value = b.dataset.chip;
  mkSearch(b.dataset.chip);
});
if (hasNative && api.onMarketProgress) {
  api.onMarketProgress(({ phase, text }) => {
    if ($('#market-page').hidden) return;
    if (phase === 'start' || phase === 'busy') mkStatus(text, 'busy');
    if (phase === 'catalog-updated' && mk.kind === 'plugins' && !mk.busy) {
      for (const k of [...mkCache.keys()]) { if (k.startsWith('plugins|')) mkCache.delete(k); }
      mkSearch(mk.query);
    }
  });
}
// 插件 / 技能列表的后台刷新完成：重取一次（主进程内存已是最新，毫秒返回），
// 页面可见就原地重绘并保持滚动位置；不可见只更新数据，等下次打开直接渲新值。
if (hasNative && api.onCatalogUpdated) {
  api.onCatalogUpdated((p) => {
    if (!p || (p.kind !== 'plugins' && p.kind !== 'skills')) return;
    const kind = p.kind;
    const page = $(kind === 'skills' ? '#skills-page' : '#plugins-page');
    loadLive(kind, page, { quiet: true });
  });
}

