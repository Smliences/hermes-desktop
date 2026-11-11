'use strict';
/* ═══════════ Hermes Desktop Client — renderer 主逻辑（dsh web 风格） ═══════════ */
/* global hermesAPI */

/* ---------- 工具函数 ---------- */
const $ = (sel) => document.querySelector(sel);
// 单引号一并转义：所有 innerHTML 属性插值都经过这里，避免属性上下文逃逸
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** IPC 返回值形态归一化：主进程异常时返回 {ok:false} 而非数组，旧的 .map 会白屏。 */
const arr = (v) => (Array.isArray(v) ? v : []);
/** 超长工具输出 / 代码截断，避免一次 innerHTML 卡死渲染进程。 */
const clip = (s, n = 20000) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n)}\n…（已截断，共 ${t.length} 字符）` : t;
};
const safeStringify = (v) => { try { return JSON.stringify(v, null, 2) || ''; } catch { return String(v); } };
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 0 : 1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
};
const uid = () => Math.random().toString(36).slice(2, 10);
/** 独立 live region：只播状态变化，不随聊天流全量重建而重播整段对话。 */
function a11y(msg) {
  const el = $('#a11y-status'); if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = String(msg); }, 20);
}
function toast(msg, ms = 2200) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.hidden = false;
  a11y(msg);
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, ms);
}

/* 轻量 Markdown（流式安全：先转义再渲染） */
/** 行内 Markdown：输入为纯文本，输出为安全 HTML（图片 URL 限 http/https/data:image）。 */
function renderInline(s) {
  const imgs = [];
  let t = String(s).replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/g, (_, alt, url) => {
    imgs.push(`<img class="md-img" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" />`);
    return `\u0000I${imgs.length - 1}\u0000`;
  });
  t = esc(t)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t.replace(/\u0000I(\d+)\u0000/g, (_, i) => imgs[Number(i)] || '');
}
/** 代码块：语言标签 + 行数 + 复制按钮，长行横向滚动不折行。 */
function mdCodeBlock(lang, code) {
  const body = String(code).replace(/\n$/, '');
  const n = body.split('\n').length;
  return `<div class="md-code"><div class="md-code-head">` +
    `<span class="md-code-lang">${esc(lang || 'text')}</span><span class="md-code-lines">${n} 行</span>` +
    `<span class="md-code-hint" aria-hidden="true">⇆ 可横向滚动</span>` +
    `<button class="md-code-copy" type="button" title="复制代码">复制</button></div>` +
    `<pre><code>${esc(body)}</code></pre></div>`;
}
/** GFM 表格：第二行必须是分隔行（含 - 与 |），否则原样返回。 */
function mdTable(raw) {
  const rows = String(raw).trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (rows.length < 2) return raw;
  if (!/^[\s|:-]+$/.test(rows[1]) || !rows[1].includes('-') || !rows[1].includes('|')) return raw;
  const cells = (l) => {
    let s = l.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((x) => x.trim());
  };
  const head = cells(rows[0]);
  const aligns = cells(rows[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
  const al = (i) => aligns[i] || 'left';
  const th = head.map((c, i) => `<th style="text-align:${al(i)}">${renderInline(c)}</th>`).join('');
  const tr = rows.slice(2).map((r) => `<tr>${cells(r).map((c, i) => `<td style="text-align:${al(i)}">${renderInline(c)}</td>`).join('')}</tr>`).join('');
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}
function renderMarkdown(src) {
  const blocks = [];
  const stash = (html) => { blocks.push(html); return `\u0000B${blocks.length - 1}\u0000`; };
  let text = String(src || '');
  // 围栏代码块（含未闭合的流式片段）
  text = text.replace(/^```([\w+#.-]*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm, (_, lang, code) => stash(mdCodeBlock(lang, code)));
  text = text.replace(/^```([\w+#.-]*)[ \t]*\n([\s\S]*)$/gm, (_, lang, code) => stash(mdCodeBlock(lang, code)));
  // hermes 回复尾部的 <details> 统计块 → 原生折叠组件
  text = text.replace(/<details>[\s\S]*?<\/details>/gi, (m) => {
    const sm = m.match(/<summary>([\s\S]*?)<\/summary>/i);
    const body = m.replace(/<summary>[\s\S]*?<\/summary>/i, '').replace(/<\/?details[^>]*>/gi, '');
    const sum = (sm ? sm[1] : '详情').replace(/<[^>]*>/g, '').trim();
    return stash(`<details class="md-details"><summary>${esc(sum || '详情')}</summary><div class="md-details-body">${esc(body.trim().replace(/<[^>]*>/g, ''))}</div></details>`);
  });
  // 表格块（连续以 | 开头/结尾的行）
  text = text.replace(/(?:^\|[^\n]*\|[ \t]*$\n?){2,}/gm, (m) => {
    const html = mdTable(m);
    return html === m ? m : stash(html);
  });

  const out = [];
  let para = [], quote = [], list = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(renderInline).join('<br>') + '</p>'); para = []; } };
  const flushQuote = () => { if (quote.length) { out.push('<blockquote>' + quote.map(renderInline).join('<br>') + '</blockquote>'); quote = []; } };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>` + list.items.map((x) => `<li>${renderInline(x)}</li>`).join('') + `</${list.tag}>`);
    list = null;
  };
  const flushAll = () => { flushPara(); flushQuote(); flushList(); };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const ph = line.match(/^\u0000B(\d+)\u0000$/);
    if (ph) { flushAll(); out.push(blocks[Number(ph[1])] || ''); continue; }
    if (!line.trim()) { flushAll(); continue; }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) { flushAll(); out.push(`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    const q = line.match(/^>\s?(.+)$/);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    flushQuote();
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    if (ul) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(ul[1]); continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ol) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(ol[1]); continue; }
    flushList(); para.push(line);
  }
  flushAll();
  return out.join('');
}
/** 代码块复制按钮：全局委托，renderChat 重建 DOM 后依然有效。 */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('.md-code-copy');
  if (!btn) return;
  const pre = btn.closest('.md-code') && btn.closest('.md-code').querySelector('pre');
  if (!pre) return;
  try {
    await navigator.clipboard.writeText(pre.innerText);
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = '复制'; }, 1400);
  } catch { toast('复制失败，请手动选择代码', 1800); }
});
/** 图片加载失败 → 换成轻量链接占位，避免出现整条破图灰带（error 不冒泡，需 capture）。 */
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG' || !img.classList || !img.classList.contains('md-img')) return;
  const a = document.createElement('a');
  a.className = 'md-img-fallback';
  a.href = img.src; a.target = '_blank'; a.rel = 'noopener';
  a.textContent = '▧ ' + (img.alt || '图片') + '（无法预览，点击打开）';
  if (img.parentNode) img.parentNode.replaceChild(a, img);
}, true);

function toolBrief(name, input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['command', 'path', 'file_path', 'query', 'url', 'pattern', 'skill', 'cmd'];
  for (const k of keys) if (input[k]) return String(input[k]).slice(0, 90);
  const json = safeStringify(input).replace(/\n\s*/g, ' ');
  return json.length > 90 ? json.slice(0, 90) + '…' : json;
}
/** WB 式工具行元数据：工具名 → {icon 动作图标, verb 中文动作, obj 对象名} */
function toolMeta(name, input) {
  const n = String(name || '');
  let obj = '';
  if (input && typeof input === 'object') {
    const f = input.file_path || input.path || input.filename || input.notebook_path;
    const c = input.command || input.cmd;
    const q = input.query || input.pattern || input.url || input.skill || input.topic;
    if (f) obj = String(f).split('/').filter(Boolean).pop() || String(f);
    else if (c) obj = String(c).replace(/\s+/g, ' ').trim().slice(0, 64);
    else if (q) obj = String(q).slice(0, 64);
  }
  const table = [
    [/^(write_file|patch|edit|apply_layout|annotate_preview)/, '✏', '修改'],
    [/^(terminal|read_terminal|close_terminal|execute_code|process_manage|cronjob_manage)/, '⊙', '运行'],
    [/^(search_files|web_search|x_search|session_search)/, '⌕', '搜索'],
    [/^(read_file|skill_view|skills_list|memory|drive_preview|desktop_preview)/, '◫', '查看'],
    [/^browser_/, '◫', '浏览'],
    [/^web_extract/, '↗', '抓取'],
    [/^(image_generate|video_generate|text_to_speech)/, '✦', '生成'],
    [/^(vision_analyze|video_analyze)/, '◫', '分析'],
    [/^feishu_/, '◫', '飞书'],
    [/^delegate_task/, '⇗', '分发'],
    [/^(todo_list)/, '☰', '清单'],
    [/^(skill_manage|desktop_project)/, '⚙', '管理'],
  ];
  for (const [re, icon, verb] of table) if (re.test(n)) return { icon, verb, obj };
  return { icon: '⊙', verb: n.replace(/_/g, ' '), obj };
}
/** 从错误文本里提取 mono 状态胶囊（如 MISSING_CREDENTIAL / exit=1） */
function errorCodeOf(text) {
  const m = String(text).match(/\b([A-Z][A-Z_]{4,})\b/);
  if (m) return m[1];
  const e = String(text).match(/退出码\s*(\d+)|exit(?:_code)?[=:]\s*(\d+)/i);
  if (e) return `EXIT ${e[1] || e[2]}`;
  return 'ERROR';
}

/* ---------- 失败轮次：把 CLI 的占位英文还原成可读的结构化错误 ----------
 * 后端在请求失败时会补写一条 display_kind='failed_turn' 的助手消息，正文恒为
 * "Your request was not processed…"，真实原因在 display_metadata.error_surface。
 * 旧版投影没把这两列带出来，界面只能显示「请重发」，而上游往往标记 retryable=false。 */
function parseFailure(raw, fallback) {
  let md = raw;
  if (typeof md === 'string') { try { md = md ? JSON.parse(md) : {}; } catch { md = {}; } }
  if (!md || typeof md !== 'object') md = {};
  const s = (md.error_surface && typeof md.error_surface === 'object') ? md.error_surface : {};
  const err = String(md.error || '').trim();
  const text = err || String(fallback || '').trim() || '上游未返回可用回复';
  return {
    error: text,
    http: (text.match(/HTTP\s*(\d{3})/i) || [])[1] || '',
    code: String(s.code || ''),
    layer: String(s.layer || ''),
    provider: String(s.provider || s.provider_label || ''),
    model: String(s.model || ''),
    retryable: typeof s.retryable === 'boolean' ? s.retryable : null,
    raw: [typeof raw === 'string' ? raw.trim() : JSON.stringify(md, null, 2),
      err && fallback ? `占位回复：${String(fallback).trim()}` : ''].filter(Boolean).join('\n\n') || text,
  };
}
/** 依据上游错误给出可执行的下一步，而不是笼统的「再发一次」。 */
function failureHint(f, sameModel) {
  const e = String(f.error || '').toLowerCase();
  if (/model is unavailable|model.*not found|unknown model|does not exist|no such model/.test(e))
    return sameModel
      ? '这个会话绑定的模型名已不可用，且应用当前也选中了它。请先切换模型再重试。'
      : '这个会话绑定的模型名已不可用（常见于旧会话沿用了旧模型）。请先切换模型再重试，或新建一个会话。';
  if (/api key|unauthorized|401|expired|credential|凭据/.test(e))
    return '上游凭据无效或已过期，请检查 API key 配置后再试。';
  if (/403|forbidden|permission|not allowed|仅限/.test(e))
    return '上游拒绝了本次请求（权限或客户端限制），重复发送同一条消息通常无效。';
  if (/402|quota|insufficient|额度|余额|credit|payment/.test(e))
    return '账户额度或余额不足，请先检查额度再试。';
  if (/429|rate limit|限流|too many requests/.test(e))
    return '触发限流，稍等片刻再重试。';
  if (/timed? out|timeout|connection|network|econn|unreachable/.test(e))
    return '网络或超时问题，可稍后重试。';
  if (f.retryable === false)
    return '上游判定此错误不可重试，重复发送同一条消息仍会失败；建议先调整模型或配置。';
  return '请核对上方错误与当前模型配置；需要继续时，可切换模型后重试。';
}
function failureHTML(f) {
  const meta = [
    f.model ? ['模型', f.model] : null,
    f.provider ? ['提供方', f.provider] : null,
    f.code ? ['错误码', f.code] : null,
    f.layer ? ['层级', f.layer] : null,
    f.retryable === false ? ['可重试', '否'] : (f.retryable === true ? ['可重试', '是'] : null),
  ].filter(Boolean);
  const badge = f.http ? `HTTP ${f.http}` : (f.code || 'FAILED');
  // 桌面端 config.json 会覆盖 CLI 的 config.yaml 默认模型；若两者都是失效模型，
  // 用户「新建会话再发」也一样失败，必须在卡里直接点破。
  const sameModel = !!(f.model && typeof state !== 'undefined' && state.config && f.model === state.config.model);
  return `<div class="err-card">
    <div class="err-head"><span class="e-dot"></span><b>本轮未获得模型回复</b><span class="e-badge">${esc(badge)}</span></div>
    <p class="err-msg">${esc(clip(f.error, 600))}</p>
    ${meta.length ? `<div class="err-meta">${meta.map(([k, v]) =>
      `<span class="err-chip"><span>${esc(k)}</span><code>${esc(clip(v, 80))}</code></span>`).join('')}</div>` : ''}
    <p class="err-hint">${esc(failureHint(f, sameModel))}</p>
    ${sameModel ? `<p class="err-hint err-same">当前应用选择的模型也是 <code>${esc(f.model)}</code>，新建会话同样会失败；请先切换模型。</p>` : ''}
    <div class="err-actions">
      <button type="button" class="err-btn primary" data-err-act="model">切换模型</button>
      <button type="button" class="err-btn" data-err-act="retry">用当前模型重试</button>
      <button type="button" class="err-btn ghost" data-err-act="detail">查看原始错误</button>
    </div>
    <pre class="err-raw" hidden>${esc(clip(f.raw, 4000))}</pre>
  </div>`;
}

/* ---------- 状态 ---------- */
const state = {
  tabs: [], activeTabId: null, view: 'chat',
  turnTab: new Map(),
  invalidTurns: new Set(),   // 已中止回合的 turnId：延迟到达的事件直接丢弃
  env: null, config: { model: '', reasoning: 'none', yolo: false },
  sessions: [], sendHistory: [], histIdx: -1,
  projectsTree: [],         // 侧栏项目树投影（/api/profiles/projects/tree，降级为 []）
  projectsTreeOk: false,    // 树请求是否成功；后端冷启慢于首屏时由 ensureSidebarTree 重试
  attachments: [],           // [{ path, name, kind }] 本回合待附加的本地文件
};
const hasNative = typeof hermesAPI !== 'undefined';
const api = hasNative ? hermesAPI : window.__mockAPI;

function newTab(sessionId = null, title = '新会话', silent = false) {
  const tab = { id: 'tab_' + uid(), sessionId, title, model: '', running: false, items: [], startedAt: 0, lastResult: null, deltas: 0 };
  state.tabs.push(tab);
  setActiveTab(tab.id, silent);
  return tab;
}
function activeTab() { return state.tabs.find((t) => t.id === state.activeTabId); }
function setActiveTab(id, silent) {
  const prev = activeTab();
  // 400ms 草稿防抖定时器在切页签后 firing 会用「新页签」的 key 保存输入框内容；
  // 这里先取消，再由下面针对旧页签的显式 saveDraftFor(prev) 落地正确归属。
  const inp = $('#input');
  if (inp && inp._draftTimer) { clearTimeout(inp._draftTimer); inp._draftTimer = null; }
  if (prev && prev.id !== id && typeof saveDraftFor === 'function') saveDraftFor(prev);
  state.activeTabId = id; state.view = 'chat';
  closeSubpages();
  document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
  renderTabs(); renderChat(); renderSessions(); updateStatus();
  if (typeof restoreDraftFor === 'function') restoreDraftFor(state.tabs.find((x) => x.id === id));
  if (!silent && hasNative) api.tabState(id).then((st) => {
    // 必须按发起请求的 tabId 落地：A→B 快速切换时，A 的响应不能写进 B
    const t = state.tabs.find((x) => x.id === id);
    if (t && st && st.sessionId && !t.sessionId) {
      t.sessionId = st.sessionId;
      if (t.id === state.activeTabId) updateStatus();
    }
  }).catch(() => {});
}
function closeTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  const tab = state.tabs[i];
  if (tab?.running && hasNative) api.abort(id);
  state.tabs.splice(i, 1);
  if (!state.tabs.length) newTab();
  else if (state.activeTabId === id) setActiveTab(state.tabs[Math.max(0, i - 1)].id);
}

/* ---------- 渲染：标题 / 会话列表 ---------- */
function renderTabs() {
  const tab = activeTab();
  const tEl = $('#chat-title'); if (tEl) tEl.textContent = tab ? (tab.running ? '◷ ' : '') + tab.title : '';
}

/** 搜索词高亮（只标第一处，输出安全 HTML） */
function hlMark(text, q) {
  const t = String(text || '');
  if (!q) return esc(t);
  const i = t.toLowerCase().indexOf(String(q).toLowerCase());
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
}
/** 侧栏搜索框当前词：会话菜单、看板写后刷新、项目树启动自愈共用（全局，勿塞进某个函数作用域） */
function currentSearch() { const el = $('#session-search'); return el ? el.value.trim() : ''; }
/** 侧栏只认用户显式创建的项目。auto 项目是 CLI 按历史会话 cwd/git 根动态推导的
 *  （.hermes / bin / memories / .pi 这类），Home 桶也不渲染。
 *  过滤必须发生在树落地时：认领会话排除集合与项目分组共用同一份数据，
 *  否则被 auto 项目认领的会话既不在分组里、也不会回到时间分组。 */
function sidebarProjectNodes(projects) {
  return (Array.isArray(projects) ? projects : [])
    .filter((p) => p && p.id && !p.isNoProject && !p.isAuto);
}
/** 会话列表：标题 + 消息全文命中合并（FTS5 由主进程提供，几十毫秒） */
let sessionsSeq = 0;
async function refreshSessions(search = '') {
  const seq = ++sessionsSeq;
  const q = String(search || '').trim();
  // 项目树与列表并行：项目归组失败不拖累会话列表本身（只降级成纯时间分组）
  const treeP = (hasNative && typeof api.projectsTree === 'function')
    ? Promise.resolve(api.projectsTree({ previewLimit: 3 })).catch(() => null)
    : Promise.resolve(null);
  try {
    const [allR, treeR] = await Promise.all([api.listSessions({ limit: 200, search: '' }), treeP]);
    const all = arr(allR);
    let hits = [];
    if (q && typeof api.searchMessages === 'function') {
      try { hits = arr(await api.searchMessages(q)); } catch (e) { console.warn('fts', e); }
    }
    // 搜索是高频输入：只接受最新一次请求的结果，避免后发先至把列表刷回旧结果
    if (seq !== sessionsSeq) return;
    const hitMap = new Map(hits.filter((h) => h && h.id).map((h) => [h.id, h]));
    const ql = q.toLowerCase();
    state.sessions = all
      .map((s) => ({ ...s, snippet: (hitMap.get(s.id) || {}).snippet || '', fulltext: hitMap.has(s.id) }))
      .filter((s) => !q || String(s.title || '').toLowerCase().includes(ql) || String(s.id).toLowerCase().includes(ql) || s.fulltext)
      .slice(0, 80);
    // 后端冷启（CLI 常要 5~12s）会晚于首屏：树请求失败时保留上一次的分组，不把侧栏刷空，
    // 并用 projectsTreeOk 标记给启动自愈判断是否还要重试。成功才覆盖树。
    if (treeR && treeR.ok) {
      state.projectsTree = sidebarProjectNodes(treeR.projects);
      state.projectsTreeOk = true;
    } else {
      state.projectsTreeOk = false;
    }
    renderSessions(q);
  } catch (e) { state.projectsTreeOk = false; console.warn('sessions', e); }
}
/** 后端冷启（gateway 常需 5~12s）会晚于首屏：树接口失败时按退避重试，直到项目分组落地。
 *  独立拉树、成功即落地并重绘侧栏，不与会话列表的并发代次（sessionsSeq）互相拖累。 */
let sidebarTreeRetry = 0;
function ensureSidebarTree() {
  if (!hasNative || typeof api.projectsTree !== 'function') return;
  if (state.projectsTreeOk) { sidebarTreeRetry = 0; return; }
  if (sidebarTreeRetry >= 10) return;
  const n = ++sidebarTreeRetry;
  setTimeout(async () => {
    if (state.projectsTreeOk) { sidebarTreeRetry = 0; return; }
    let r = null;
    try { r = await api.projectsTree({ previewLimit: 3 }); } catch {}
    if (r && r.ok) {
      state.projectsTree = sidebarProjectNodes(r.projects);
      state.projectsTreeOk = true;
      sidebarTreeRetry = 0;
      try { renderSessions(currentSearch()); } catch {}
      return;
    }
    ensureSidebarTree();
  }, Math.min(1000 + n * 800, 3500));
}
/** Claude 式时间分组：置顶 / 今天 / 昨天 / 最近 7 天 / 更早 */
function sessionGroup(s) {
  if (Number(s.pinned) > 0 || s.pinned === true) return '置顶';
  const t = Number(s.started_at) || 0;
  if (!t) return '更早';
  const d = new Date(t * 1000), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff <= 7) return '最近 7 天';
  return '更早';
}
/** 侧栏单个会话行（项目预览与时间分组共用）：返回 li，由调用方挂事件 */
function sessionItemEl(s, { query = '', snippet = '' } = {}) {
  const tab = activeTab();
  const li = document.createElement('li');
  if (tab && s.id === tab.sessionId) li.classList.add('active');
  const dt = s.started_at ? new Date(s.started_at * 1000) : null;
  const when = dt ? `${dt.getMonth() + 1}/${dt.getDate()}` : '';
  // 键盘可达：列表项与 ⋯ 入口原本都是纯 li/span，鼠标以外完全无法操作
  li.setAttribute('role', 'option');
  li.setAttribute('tabindex', '0');
  li.setAttribute('aria-selected', tab && s.id === tab.sessionId ? 'true' : 'false');
  li.innerHTML = `<span class="s-main"><span class="s-title">${hlMark(s.title, query)}</span>` +
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
  const t = newTab();
  if (p.startsWith('/')) t.cwd = p;
  $('#input').focus();
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
  // 项目分组：sidebarProjectNodes 已滤掉 auto 项目与 Home 桶，只留显式项目（含 0 会话）；
  // 服务端已按 lastActive 排序。被这些项目认领的会话才从下方时间分组排除。
  let shownProject = false;
  for (const p of projects) {
    shownProject = true;
    const gl = document.createElement('li');
    gl.className = 's-group s-proj';
    gl.setAttribute('role', 'presentation');
    const safePath = esc(p.path || '');
    gl.innerHTML = `<span class="s-pname">${esc(p.label || p.id)}<span class="s-pcount">${p.sessionCount || 0}</span></span>` +
      (p.path ? `<button class="s-pnew" data-cwd="${safePath}" title="在 ${safePath} 新建会话（会话将归属该项目）" aria-label="在此项目新建会话">+</button>` : '');
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
    more.title = `项目操作：${p.label || p.id}`;
    more.setAttribute('aria-label', '项目操作');
    more.onclick = (e) => { e.stopPropagation(); openProjectMenu(p, more); };
    more.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); more.click(); }
    };
    gl.appendChild(more);
    gl.oncontextmenu = (e) => { e.preventDefault(); openProjectMenu(p, gl); };
    ul.appendChild(gl);
    for (const ps of (p.previewSessions || []).slice(0, 3)) {
      const li = sessionItemEl(ps, { query });
      ul.appendChild(li);
    }
    if ((p.sessionCount || 0) > 3) {
      const more = document.createElement('li');
      more.className = 's-more';
      more.setAttribute('role', 'presentation');
      more.textContent = `… 该项目还有 ${p.sessionCount - 3} 条会话`;
      ul.appendChild(more);
    }
  }
  if (shownProject) {
    const rest = document.createElement('li');
    rest.className = 's-group';
    rest.setAttribute('role', 'presentation');
    rest.textContent = '其他会话';
    ul.appendChild(rest);
  }
  let lastGroup = null;
  for (const s of state.sessions) {
    if (!searching && claimedNoPin(s.id)) continue; // 已在项目分组里，不重复出现
    const group = sessionGroup(s);
    if (group !== lastGroup) {
      const gl = document.createElement('li');
      gl.className = 's-group';
      gl.setAttribute('role', 'presentation');
      gl.textContent = group;
      ul.appendChild(gl);
      lastGroup = group;
    }
    ul.appendChild(sessionItemEl(s, { query, snippet: s.snippet }));
  }
  // 时间分组一条没出（全被项目认领）时撤掉「其他会话」标题；项目行以 DOM 顺序判断
  if (shownProject) {
    const kids = [...ul.children];
    const restIdx = kids.findIndex((x) => x.textContent === '其他会话');
    if (restIdx >= 0 && restIdx === kids.length - 1) kids[restIdx].remove();
  }
  if (!ul.children.length) {
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
/** 官方 project-menu.tsx：项目行 ⋯ / 右键共用的操作菜单。
 *  显式项目才有重命名 / 加文件夹 / 设为活动；另外两项是本机路径动作，不写 CLI。 */
function openProjectMenu(p, anchor) {
  const m = $('#session-menu'); if (!m) return;
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.right - 156, window.innerWidth - 180)) + 'px';
  m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 300)) + 'px';
  m.innerHTML = `<button data-pact="rename">✎ 重命名项目…</button>
    <button data-pact="add-folder">⊕ 添加文件夹…</button>
    <button data-pact="use">◎ 设为活动项目</button>
    <div class="sess-menu-sep"></div>
    <button data-pact="reveal">⌸ 在访达中显示</button>
    <button data-pact="copy">⧉ 复制路径</button>`;
  m.hidden = false;
  m.onclick = async (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (!b || !b.dataset.pact) return;
    const act = b.dataset.pact;
    closeSessionMenu();
    try {
      if (act === 'rename' || act === 'add-folder') { kbProjectDialog(act, p); return; }
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
function openSessionMenu(s, anchor) {
  const m = $('#session-menu'); if (!m) return;
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.right - 156, window.innerWidth - 180)) + 'px';
  m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 300)) + 'px';
  m.innerHTML = `<button data-act="rename">✎ 重命名</button>
    <button data-act="pin">${s.pinned ? '⤓ 取消置顶' : '⤒ 置顶会话'}</button>
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
  const cur = activeTab();
  // loading 标记阻止连点两次复用同一个空 tab，导致两份历史互相覆盖
  const tab = (cur && !cur.running && !cur.loading && cur.items.length === 0)
    ? cur : newTab(null, sessionId, true);
  const gen = (tab.loadGen = (tab.loadGen || 0) + 1);
  tab.loading = true;
  tab.sessionId = sessionId; state.view = 'chat';
  document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
  try {
    const hist = arr(await api.loadHistory({ sessionId, limit: 200 }));
    // 异步回来时用户可能已切到别的会话 / 又点了另一条，过期响应必须丢弃
    if (gen !== tab.loadGen || !state.tabs.includes(tab)) return;
    tab.items = [];
    // 历史消息没有 turnMs（CLI 只存消息时间），用「本条助手消息 - 上一条用户消息」的时间差还原，
    // 这样 dsh 那句「已完成，用时 N 秒」在历史会话里也能显示，而不是只剩一个「已完成」。
    let lastUserTs = 0;
    for (const m of hist) {
      // messages.timestamp 是 REAL 秒（如 1794146522.21），Date.parse 对它返回 NaN
      const tv = Number(m.timestamp);
      const ts = Number.isFinite(tv) && tv > 0 ? (tv > 1e12 ? tv : tv * 1000) : (Date.parse(m.timestamp) || 0);
      if (m.role === 'user') { lastUserTs = ts; tab.items.push({ kind: 'user', text: m.content, ts }); }
      else if (m.displayKind === 'failed_turn') {
        const f = parseFailure(m.displayMetadata, m.content);
        tab.items.push({ kind: 'error', text: f.error, failure: f, ts });
      }
      else if (m.role === 'assistant' && m.content) {
        // 只接受 0.5s ~ 1h 的差值，防止跨会话 / 跨天的时间戳算出荒谬耗时
        const d = ts - lastUserTs;
        const turnMs = (lastUserTs > 0 && d >= 500 && d < 3600000) ? d : 0;
        tab.items.push({ kind: 'assistant', text: m.content, done: true, ts, tokens: Number(m.tokens) || 0, turnMs });
      }
      else if (m.role === 'tool' && m.toolName) {
        tab.items.push({ kind: 'tool', name: m.toolName, input: null, output: m.content, state: 'ok', done: true, ts });
      }
    }
    tab.title = tab.items.find((i) => i.kind === 'user')?.text.slice(0, 24) || sessionId;
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
}

/* ---------- 渲染：聊天流 / 轨迹 ---------- */
function renderChat() {
  const tab = activeTab(); const chat = $('#chat');
  if (!tab) { chat.innerHTML = ''; return; }
  const items = state.view === 'trace' ? tab.items.filter((i) => i.kind === 'tool' || i.kind === 'error') : tab.items;
  const showHeads = state.view !== 'trace';
  chat.innerHTML = '';
  // WB 式结构：每轮响应块（紧随用户消息）仅首个元素带「头像+名字」头，其余流式内容顶格
  const turnHeadEl = () => {
    const d = document.createElement('div');
    d.className = 'turn-head';
    d.innerHTML = `<img class="turn-avatar" src="assets/hermes-logo.png" alt="" /><span class="turn-name">Hermes</span>`;
    return d;
  };
  let prevKind = null;
  for (let i = 0; i < items.length; ) {
    const it = items[i];
    if (it.kind === 'tool') {
      const wrap = document.createElement('div');
      wrap.className = 'tool-stream';
      if (showHeads && prevKind === 'user') wrap.appendChild(turnHeadEl());
      while (i < items.length && items[i].kind === 'tool') { wrap.appendChild(renderItem(items[i])); i++; }
      chat.appendChild(wrap);
      prevKind = 'tool';
    } else {
      const head = showHeads && it.kind === 'assistant' && prevKind === 'user';
      chat.appendChild(renderItem(it, head));
      prevKind = it.kind; i++;
    }
  }
  if (tab.running && tab.showTyping) {
    chat.appendChild(typingIndicator(tab, showHeads && prevKind === 'user'));
  }
  const hasContent = tab.items.some((i) => i.kind !== 'landing');
  // 用 hidden 属性而非 style.display：全局 [hidden]{display:none!important} 会让
  // style.display='' 永远无法让 landing 显示出来。
  $('#landing').hidden = hasContent || state.view === 'trace';
  // 空会话：输入框垂直居中（#main.empty 布局）
  $('#main').classList.toggle('empty', !hasContent && state.view !== 'trace');
  // 查找入口只在有内容时出现（轨迹/空态没有可查找文本）
  const findBtn = $('#btn-find');
  if (findBtn) findBtn.hidden = !hasContent || state.view === 'trace';
  syncComposerState();
  syncCodeScrollHints();
  scrollBottom();
  publishOrbContext();
}

/* ---------- 迷你聊天窗的上下文同步 ----------
   小窗读不到主窗口的 DOM，但它必须绑定「同一个会话」：这里按 300ms 节流把
   tabId / 标题 / 模型 / 主题 / 最近十几条纯文本推给主进程缓存。
   只走内存，不落盘、不进日志（消息正文不该留在日志里）。 */
let orbCtxTimer = null;
function publishOrbContext() {
  if (!hasNative || typeof api.orbContext !== 'function') return;
  if (orbCtxTimer) return;
  orbCtxTimer = setTimeout(() => {
    orbCtxTimer = null;
    const tab = activeTab();
    if (!tab) return;
    const messages = tab.items
      .filter((i) => (i.kind === 'user' || i.kind === 'assistant') && i.text)
      .slice(-14)
      .map((i) => ({
        role: i.kind === 'user' ? 'user' : 'assistant',
        text: String(i.text).slice(0, 4000),
        done: i.done !== false,
      }));
    try {
      api.orbContext({
        tabId: tab.id,
        sessionId: tab.sessionId || null,
        title: tab.title || '新会话',
        model: tab.model || (state.config && state.config.model) || '',
        theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
        messages,
      });
    } catch { /* 退出中：主进程已不可达 */ }
  }, 300);
}
/** macOS 隐藏式滚动条会让长代码行看起来像被截断；仅在实际超宽时给头部一个明确提示。 */
function syncCodeScrollHints() {
  for (const box of document.querySelectorAll('.md-code')) {
    const pre = box.querySelector('pre');
    if (pre) box.classList.toggle('scroll-x', pre.scrollWidth > pre.clientWidth + 4);
  }
}
/** 每条消息 hover 出现的操作条：复制 / 重试 / 本回合用量 / 绝对时间。
    dsh 用图标而非文字按钮（点赞/倒赞按用户 2026-11-11 要求不做）。 */
const MSG_ICO_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor"></rect><path d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z" fill="currentColor" stroke="none"></path></svg>';
const MSG_ICO_RETRY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><path d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1" stroke="currentColor"></path><path d="M14.4999 1.5V5.1H10.8999" stroke="currentColor"></path></svg>';
/* 用量图标：dsh 用的是「三层数据库圆柱」——顶椭圆 + 两条等距分隔弧 + 圆弧底，
   宽高比 12:14（dsh 实测 13.3×15 css，≈0.89）。早先是两层 + 更瘦的 rx，视觉上明显不像。 */
/* 用量图标：dsh 的 database-outline 原样（顶椭圆 + 左右直边 + 两条等距弧），
   之前是自己凑的三层圆柱，弧长和椭圆曲率都对不上。 */
const MSG_ICO_DB = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><path d="M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z" stroke="currentColor"></path><path d="M2 3.80371V11.7848" stroke="currentColor"></path><path d="M14 3.80371V11.7848" stroke="currentColor"></path><path d="M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396" stroke="currentColor"></path><path d="M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847" stroke="currentColor"></path></svg>';
/** 状态条（底部用量带）的格子：图标也用 dsh 原版字形，不再用 ▤ / ↻ 字符。
    字符在不同系统字体里宽高不一致，会和右侧数字基线错位；SVG 定 13px 才稳。
    空内容必须清成空串，否则 `.st-metrics > :empty{display:none}` 失效会留白。 */
function setStCell(sel, svg, text) {
  const el = $(sel); if (!el) return;
  el.innerHTML = text ? `<span class="st-ico" aria-hidden="true">${svg}</span><span class="st-txt"></span>` : '';
  if (text) el.lastElementChild.textContent = text;
}
/** 耗时文案：dsh 是「用时 33 秒」整秒口径，短回合才给一位小数「8.8 秒」 */
function fmtDur(ms) {
  const s = ms / 1000;
  return s >= 10 ? String(Math.round(s)) : s.toFixed(1);
}
/** 这条消息的 token 数：优先真实值（实时回合由会话累计差算出）；
    历史消息 CLI 不写 messages.token_count（实测整列为 NULL），只能按字符估算并标 ≈。 */
function msgTokens(item) {
  if (item.tokens > 0) return { n: item.tokens, est: false };
  const txt = item.text || item.output || '';
  if (!txt) return null;
  // 中英分开算：汉字约 1.3 字 / token，其余约 3.8 字符 / token
  const cjk = (txt.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = txt.length - cjk;
  return { n: Math.max(1, Math.round(cjk / 1.3 + rest / 3.8)), est: true };
}
/** 消息底部信息行（dsh 版式）：`[图标组] ▤ N tok  HH:MM`，整行常显。
    dsh 实测（2x 截图逐列量）：图标在最左、glyph 左缘与正文左缘对齐，
    用量居中、绝对时间压最右；用户消息整行改用 row-reverse 靠右
    （dsh 的用户脚注是 `12:33 [复制]`，图标贴气泡右缘）。
    **用户自己说的话不显示 token 用量**（2026-11-11 要求），只有助手回合才有。 */
function msgActionBar(item, canRetry) {
  const t = item.kind === 'user' ? null : msgTokens(item);
  const usage = t
    ? `<span class="msg-usage" title="${t.est ? '按字符估算（CLI 未记录本条 token）' : '本回合真实用量'} · ${fmtTokens(t.n)} token">` +
      `<span class="mu-ico" aria-hidden="true">${MSG_ICO_DB}</span>${fmtTokens(t.n)} tok</span>`
    : '';
  return `<div class="msg-foot-row">
    <span class="msg-actions" role="group" aria-label="消息操作">
      <button type="button" class="msg-act" data-msg-act="copy" title="复制这条消息" aria-label="复制">${MSG_ICO_COPY}</button>
      ${canRetry ? `<button type="button" class="msg-act" data-msg-act="retry" title="用这条提问重新发起一轮" aria-label="重试">${MSG_ICO_RETRY}</button>` : ''}
    </span>
    ${usage}
    ${item.ts ? `<time class="msg-ts" title="发送于 ${esc(fmtTime(item.ts))}">${esc(fmtTime(item.ts).slice(0, 5))}</time>` : ''}
  </div>`;
}
function renderItem(item, header = false) {
  const el = document.createElement('div');
  if (item.kind === 'user') {
    el.className = 'msg msg-user';
    const files = Array.isArray(item.files) && item.files.length
      ? `<div class="bubble-files">${item.files.map((f) => `<span class="bf-item">${esc(f)}</span>`).join('')}</div>`
      : '';
    el.innerHTML = `<div class="bubble">${esc(item.text)}${files}</div><div class="avatar">你</div>${msgActionBar(item, true)}`;
  } else if (item.kind === 'assistant') {
    el.className = 'msg msg-assistant';
    const cursor = item.done ? '' : '<span class="cursor"></span>';
    // 助手消息不带头像/名字头，正文顶格；「已完成，用时 N 秒 · ⌁ x tok/s」压在正文上方，
    // 下面跟一条整列发丝横线（用户 2026-11-11 先要求挪到底部、随即改回上方，以此为准）。
    const meta = item.done
      ? `<div class="turn-meta">已完成${item.turnMs >= 500 ? `，用时 ${fmtDur(item.turnMs)} 秒` : ''}${item.tps ? ` · ⌁ ${item.tps.toFixed(1)} tok/s` : ''}</div>`
      : '';
    el.innerHTML = `${meta}<div class="content md">${renderMarkdown(item.text)}${cursor}</div>${msgActionBar(item, false)}`;
  } else if (item.kind === 'tool') {
    // WB 式工具行：动作图标 + 中文动作 + 对象名（状态由图标颜色/动画表达），点击展开灰底等宽详情
    el.className = 'tool-item' + (item.open ? ' open' : '');
    const stateCls = item.state === 'running' ? 'running' : item.isError ? 'err' : 'ok';
    const meta = toolMeta(item.name, item.input);
    const dur = item.durationMs ? `<span class="tdur">${(item.durationMs / 1000).toFixed(1)}s</span>` : '';
    el.innerHTML = `<div class="tool-row ${stateCls}">
        <span class="ticon">${meta.icon}</span>
        <span class="tverb">${esc(meta.verb)}</span>
        ${meta.obj ? `<span class="tobject">${esc(meta.obj)}</span>` : ''}
        ${dur}
        <span class="tchev">›</span></div>
      <div class="tool-detail">
        ${item.input ? `<div class="sec-label">INPUT</div><pre>${esc(clip(safeStringify(item.input), 12000))}</pre>` : ''}
        ${item.output != null ? `<div class="sec-label">OUTPUT</div><pre class="${item.isError ? 'err-text' : ''}">${esc(clip(item.output, 20000))}</pre>` : ''}
      </div>`;
    el.querySelector('.tool-row').onclick = () => { item.open = !item.open; renderChat(); };
  } else if (item.kind === 'error') {
    el.className = 'msg msg-error';
    el.innerHTML = item.failure
      ? failureHTML(item.failure) + msgActionBar(item, false)
      : `<div class="error-card"><span class="e-dot"></span>
      <div class="e-body"><div class="e-title">本轮运行失败</div>
      <div class="e-desc">${esc(clip(item.text, 4000))}</div></div>
      <span class="e-badge">${esc(item.code || errorCodeOf(item.text))}</span></div>${msgActionBar(item, false)}`;
  } else if (item.kind === 'thinking') {
    // Claude 式思考轨道：默认折叠，点击展开；不与正文混排
    el.className = 'msg msg-thinking';
    el.innerHTML = `<details class="think-box"${item.open ? ' open' : ''}>
      <summary>⌁ 思考过程 <span class="think-len">${(item.text || '').length} 字</span></summary>
      <div class="think-body">${esc(clip(item.text, 12000))}</div></details>`;
    const d = el.querySelector('details');
    if (d) d.addEventListener('toggle', () => { item.open = d.open; });
  } else if (item.kind === 'approval') {
    el.className = 'msg msg-approval';
    const actions = item.choice
      ? `<span class="ap-done ${item.choice === 'deny' ? 'no' : 'yes'}">${item.choice === 'deny' ? '已拒绝' : '已允许'}</span>`
      : `<button type="button" class="ap-btn ap-allow" data-ap="approve">允许</button>
         <button type="button" class="ap-btn ap-always" data-ap="always">始终允许</button>
         <button type="button" class="ap-btn ap-deny" data-ap="deny">拒绝</button>`;
    el.innerHTML = `<div class="approval-card">
      <div class="ap-head"><span class="ap-dot"></span><b>需要确认危险操作</b></div>
      <div class="ap-tool">${esc(item.tool || '工具调用')}${item.risk ? ` · ${esc(item.risk)}` : ''}</div>
      ${item.command ? `<pre class="ap-cmd">${esc(clip(item.command, 2000))}</pre>` : ''}
      <div class="ap-actions">${actions}</div></div>`;
  }
  el._item = item; // 事件委托据此取回数据，避免用易失效的数组下标
  return el;
}
/** 只在用户本来就贴着底部时自动跟随；查看历史时保留当前锚点。 */
function scrollBottom(force = false) {
  const sc = $('#chat-scroll');
  if (!force && sc._userScrolledAway) return;
  sc.scrollTop = sc.scrollHeight;
}
/** 「响应中」指示器：WB 式纯状态行（本轮首个块带轮次头） */
function typingIndicator(tab, header = false) {
  const el = document.createElement('div');
  el.className = 'msg typing-msg';
  const head = header ? `<div class="turn-head"><img class="turn-avatar" src="assets/hermes-logo.png" alt="" /><span class="turn-name">Hermes</span></div>` : '';
  el.innerHTML = `${head}<div class="status-line"><span class="spin">◠</span>
    <span class="t-status">${esc(tab.activity || '思考中…')}</span><span class="t-elapsed"></span></div>`;
  return el;
}
/** 底部活动条显示/隐藏 */
function syncActivityBar() {
  const tab = activeTab();
  const el = $('#activity');
  if (el) el.hidden = !(tab && tab.running);
}
// 指示器计时（响应已用时）
setInterval(() => {
  const tab = activeTab();
  if (!tab || !tab.running || !tab.startedAt) return;
  const el = document.querySelector('.typing-msg .t-elapsed');
  if (el) el.textContent = Math.round((Date.now() - tab.startedAt) / 1000) + 's';
}, 500);

/* ---------- 思考轨（reasoning）辅助 ---------- */
/** 设置页「流式思考」是唯一开关：关掉就不再画推理块（上游可能照样在下发）。 */
function streamThinkOn() {
  try { return SettingsStore.get('streamThink', true) !== false; } catch { return true; }
}
/** 本回合的推理块：跨过本轮的 user 消息就新建，别把上一轮的思考接着往下写。 */
function reasoningItemOf(tab) {
  for (let i = tab.items.length - 1; i >= 0; i--) {
    const it = tab.items[i];
    if (it.kind === 'thinking') return it;
    if (it.kind === 'user') return null;
  }
  return null;
}
/** 推理块插在本轮 user 之后、工具与正文之前：后端可能先发正文，再补完整推理快照。 */
function turnInsertIndex(tab) {
  for (let i = tab.items.length - 1; i >= 0; i--) if (tab.items[i].kind === 'user') return i + 1;
  return tab.items.length;
}
/** 按数据项找 DOM 节点（renderItem 给每个节点挂了 _item），比按 className 猜更可靠。 */
function reasoningNode(item) {
  const chat = $('#chat');
  if (!chat) return null;
  for (const n of chat.children) if (n._item === item) return n;
  return null;
}
/**
 * 只把「说明过的 provider 等待」当状态文案（与官方桌面版 store/provider-wait.ts 同款白名单）：
 * `⏳ loading … / ⚙ processing prompt / ⚠ rate limited …`。颜文字 spinner 一律丢弃，
 * 它们只是活动指示，不是能被展示的思考内容。
 */
const RE_PROVIDER_WAIT = /^(?:⏳|⚠|↻|⚙)\s*(?:(?:still\s+)?waiting on|loading|processing prompt|no (?:output|response)|model returned|rate limited|provider (?:overloaded|temporarily unavailable))/i;
function providerWaitText(text) {
  const v = String(text == null ? '' : text).trim();
  return RE_PROVIDER_WAIT.test(v) ? v : '';
}

/* ---------- 事件处理（stream-json 协议） ---------- */
function routeEvent(evt, explicitTabId) {
  if (!evt) return;
  // 已停止的回合：延迟到达的事件一律丢弃，不再冒出内容
  if (evt.turnId && state.invalidTurns.has(evt.turnId)) return;
  // 主进程已经在 hermes:event 里带了 tabId，优先用它；turnTab 只作 demo 通道兜底。
  // 绝不回落到 activeTabId —— 那会把后台页签的流式内容串到当前页签。
  const tabId = explicitTabId || (evt.turnId ? state.turnTab.get(evt.turnId) : null);
  const tab = state.tabs.find((t) => t.id === tabId); if (!tab) return;
  // 数据模型始终更新；但只有当前可见页签能改 DOM / 全局状态条。
  // 否则后台页签的流式内容会替换掉用户正在看的那条消息，或把状态条误置为「空闲」。
  const visible = tab.id === state.activeTabId;
  if (evt.type === 'notice') {
    // 附件附加失败等非致命提示：只提示，不打断回合、不生成错误卡
    if (visible) { toast(evt.text || '提示', 3600); a11y(evt.text || '提示'); }
    return;
  }
  if (evt.type === 'system' && evt.subtype === 'init') {
    if (evt.session_id && !tab.sessionId) { tab.sessionId = evt.session_id; refreshSessions($('#session-search').value.trim()); }
    if (evt.model) { tab.model = evt.model; updateStatus(); }
  } else if (evt.type === 'text') {
    let last = tab.items[tab.items.length - 1];
    if (!last || last.kind !== 'assistant' || last.done) {
      last = { kind: 'assistant', text: '', done: false, ts: Date.now() };
      tab.items.push(last);
    }
    last.text += evt.text;
    tab.deltas += 1;
    tab.showTyping = false; tab.activity = '生成中…';
    if (visible && state.view === 'chat') {
      const chat = $('#chat');
      chat.querySelector('.typing-msg')?.remove();
      const node = renderItem(last);
      const existing = chat.lastElementChild;
      if (existing && existing.className === 'msg msg-assistant') chat.replaceChild(node, existing);
      else chat.appendChild(node);
      scrollBottom();
    }
    liveActivity(tab);
  } else if (evt.type === 'thinking_wait') {
    // v0.23.0 的 thinking.delta 是「等待提示」（颜文字 spinner / provider 等待），不是推理。
    // 它只喂底部状态行；颜文字那类连状态行都不进，避免把占位文案伪装成思考内容。
    const wait = providerWaitText(evt.text);
    if (wait) {
      tab.activity = wait;
      if (visible && state.view === 'chat') {
        setActivity(wait);
        const el = document.querySelector('#chat .typing-msg .t-status');
        if (el) el.textContent = wait;
      }
    }
  } else if (evt.type === 'thinking') {
    // 只认真·推理（reasoning.delta / reasoning.available / message.complete.reasoning）。
    // 设置里关掉「流式思考」就整块不显示，不做「半截空壳」。
    if (!streamThinkOn()) return;
    let item = reasoningItemOf(tab);
    if (!item) {
      item = { kind: 'thinking', text: '', open: false, ts: Date.now() };
      tab.items.splice(turnInsertIndex(tab), 0, item);   // 后端可能先发正文再补快照，插在本轮开头
    }
    if (evt.final) item.text = evt.text; else item.text += evt.text;
    if (visible && state.view === 'chat') {
      const node = reasoningNode(item);
      const body = node && node.querySelector('.think-body');
      const len = node && node.querySelector('.think-len');
      if (body && len) { body.textContent = clip(item.text, 12000); len.textContent = item.text.length + ' 字'; }
      else renderChat();
    }
  } else if (evt.type === 'tool_use') {
    const last = tab.items[tab.items.length - 1];
    if (last && last.kind === 'assistant') last.done = true;
    tab.items.push({ kind: 'tool', name: evt.name, input: evt.input || null, brief: toolBrief(evt.name, evt.input), state: 'running', open: false, ts: Date.now() });
    tab.showTyping = true; tab.activity = `执行 ${evt.name}…`;
    if (visible) { renderChat(); setActivity(`执行 ${evt.name}…`); syncActivityBar(); }
    maybeAutoPreview(evt).catch(() => {});
  } else if (evt.type === 'tool_result') {
    const item = [...tab.items].reverse().find((i) => i.kind === 'tool' && i.name === evt.name && i.state === 'running');
    if (item) {
      item.output = evt.output ?? ''; item.isError = !!evt.is_error;
      item.durationMs = evt.duration_ms || 0; item.state = 'done'; item.done = true;
      tab.showTyping = true; tab.activity = '生成中…';
      if (visible) renderChat();
      maybeAutoPreview({ input: item.input, output: evt.output, preview: evt.preview }).catch(() => {});
    }
  } else if (evt.type === 'usage') {
    // 后端 session.usage（回合中按间隔推送 / resume 初值）：token、tps、上下文占用
    tab.usage = evt.usage || null;
    updateStatus();
  } else if (evt.type === 'result') {
    tab.lastResult = evt;
    if (evt.tokens) tab.usage = evt.tokens;
    const last = tab.items[tab.items.length - 1];
    if (last && last.kind === 'assistant') {
      last.done = true;
      last.turnMs = Date.now() - (tab.startedAt || Date.now());
      last.tps = (tab.usage && tab.usage.tps) || 0;
      // 会话累计值的差 = 本回合消耗（后端只给累计口径，没有单回合字段）
      const base = tab.usageBase || 0;
      const nowTotal = (tab.usage && tab.usage.total) || 0;
      last.tokens = nowTotal > base ? nowTotal - base : 0;
      // gateway 的 result 不带 duration_ms，用本回合实测耗时补上（状态条/脚注共用）
      if (!evt.duration_ms) evt.duration_ms = last.turnMs;
      // result.text 是全量回复：仅当本轮没有任何 text delta 时才用它兜底，避免与已渲染的流式文本重复
      if (tab.deltas === 0) last.text = evt.text || last.text;
    } else if (evt.text && tab.deltas === 0) tab.items.push({ kind: 'assistant', text: evt.text, done: true });
    for (const i of tab.items) if (i.kind === 'tool' && i.state === 'running') { i.state = 'done'; i.isError = true; i.output = i.output || '（回合结束，无结果回传）'; }
    tab.running = false; tab.showTyping = false;
    applyAutoCollapse(tab);
    if (evt.exit_code !== 0 && evt.error) {
      const f = parseFailure('', String(evt.error));
      tab.items.push({ kind: 'error', text: f.error, failure: f });
    }
    renderTabs(); // 页签上的 running 指示对后台页签也要刷新
    if (visible) { renderChat(); updateStatus(); setActivity('空闲'); syncActivityBar(); }
    if (evt.turnId) state.turnTab.delete(evt.turnId);
  }
}
function liveActivity(tab) {
  const running = tab.items.filter((i) => i.kind === 'assistant' && !i.done);
  if (running.length) {
    const chars = running.reduce((n, i) => n + i.text.length, 0);
    const secs = Math.max(0.5, (Date.now() - tab.startedAt) / 1000);
    $('#st-tps').textContent = `· ${(chars / 4 / secs).toFixed(1)} tok/s`;
  }
}

/* ---------- 附件（图片 / PDF / 任意文件） ---------- */
const ATTACH_MAX = 8;
const RE_ATTACH_IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;
const RE_ATTACH_PDF = /\.pdf$/i;
function attachKindOf(p) {
  if (RE_ATTACH_IMAGE.test(p)) return 'image';
  if (RE_ATTACH_PDF.test(p)) return 'pdf';
  return 'file';
}
// 单色线性图标，与侧栏 / 工具栏的 SVG 语言一致（emoji 会在深色主题里显彩、基线也不稳）
const ATTACH_ICON = {
  image: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.8"/><circle cx="6" cy="6.4" r="1.1"/><path d="M3.2 11.4l3.1-3 2.4 2.3 2-1.8 2.1 2"/></svg>',
  pdf: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.6h5l3 3v7.8H4z"/><path d="M9 2.6v3h3"/><path d="M6 8.6h4M6 10.8h4"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.6h5l3 3v7.8H4z"/><path d="M9 2.6v3h3"/></svg>',
};
/** 取真实绝对路径：Electron 32+ 没有 File.path，必须经 preload 的 webUtils */
function pathOfFile(file) {
  if (!file) return '';
  try {
    if (api && typeof api.pathForFile === 'function') {
      const p = api.pathForFile(file);
      if (p) return p;
    }
  } catch {}
  return file.path || '';
}
function addAttachments(paths) {
  let added = 0, skipped = 0;
  for (const raw of paths) {
    const p = String(raw || '').trim();
    if (!p) continue;
    if (state.attachments.length >= ATTACH_MAX) { skipped += 1; continue; }
    if (state.attachments.some((a) => a.path === p)) { skipped += 1; continue; }
    state.attachments.push({
      path: p, name: p.split('/').pop() || p, kind: attachKindOf(p),
    });
    added += 1;
  }
  renderAttach();
  if (skipped && !added) toast(`最多附加 ${ATTACH_MAX} 个文件，或文件已在列表中`, 2200);
  else if (skipped) toast(`已附加 ${added} 个，${skipped} 个超出上限或重复`, 2200);
  else if (added) toast(`已附加 ${added} 个文件（下一回合生效）`, 1800);
}
function removeAttachment(p) {
  state.attachments = state.attachments.filter((a) => a.path !== p);
  renderAttach();
}

/* ---------- 发送 ---------- */
async function send(text) {
  const tab = activeTab();
  if (!tab || tab.running) return;
  text = text.trim(); if (!text) return;
  state.sendHistory.push(text); state.histIdx = state.sendHistory.length;
  tab.items.push({ kind: 'user', text, ts: Date.now(), files: state.attachments.map((a) => a.name) });
  // 取消在途草稿定时器：否则发送后它仍会以「清空后的输入框」再写一次草稿归属
  if ($('#input')._draftTimer) { clearTimeout($('#input')._draftTimer); $('#input')._draftTimer = null; }
  // 立即清空输入框（乐观发送）；放在 await 之后会吞掉用户在这段时间里新敲的内容
  $('#input').value = ''; autoGrow(); updateCount();
  if (typeof clearDraftFor === 'function') clearDraftFor(tab);
  if (tab.title === '新会话') tab.title = text.slice(0, 24);
  tab.running = true; tab.startedAt = Date.now(); tab.deltas = 0;
  // 回合开始时的累计用量：结算时用它做差，得到「本条消息自己的 token」
  tab.usageBase = (tab.usage && tab.usage.total) || 0;
  tab.showTyping = true; tab.activity = '思考中…';
  closeSubpages();
  renderTabs(); renderChat(); scrollBottom(true); setActivity('思考中…'); syncActivityBar();
  const payload = {
    tabId: tab.id, query: text, sessionId: tab.sessionId || undefined,
    model: state.config.model || undefined, reasoning: state.config.reasoning,
    yolo: state.config.yolo || undefined,
    // 项目内新建的页签带着项目根：首轮 session.create 以此为 cwd，CLI 按
    // git 仓库根把会话归属到项目（每轮都传无害，resume 不再使用它）
    cwd: tab.cwd || undefined,
    attachments: state.attachments.length ? state.attachments.map((a) => a.path) : undefined,
  };
  state.attachments = []; renderAttach();
  if (hasNative) {
    try {
      const st = await api.send(payload);
      if (st && st.sessionId && !tab.sessionId) tab.sessionId = st.sessionId;
    } catch (e) {
      tab.items.push({ kind: 'error', text: (e && e.message) || String(e) });
      tab.running = false; tab.showTyping = false;
      renderChat(); syncActivityBar(); syncComposerState(); setActivity('空闲');
    }
  } else {
    window.__mockAPI.__sendDemo(payload, (evt) => {
      state.turnTab.set(evt.turnId, tab.id); routeEvent(evt);
    }, (summary) => handleClose({ tabId: tab.id, summary }));
  }
  updateStatus();
}
function handleClose({ tabId, summary }) {
  const tab = state.tabs.find((t) => t.id === tabId); if (!tab) return;
  const s = summary || {};
  // 后台页签收尾不能重置当前页签的状态条 / 重绘聊天流 / 抢占读屏播报
  const visible = tab.id === state.activeTabId;
  tab.running = false; tab.showTyping = false;
  if (s.turnId) state.turnTab.delete(s.turnId);
  applyAutoCollapse(tab);
  if (s.sessionId) tab.sessionId = s.sessionId;
  if (s.model) tab.model = s.model;
  if (s.aborted) {
    if (!tab.stoppedByUser) tab.items.push({ kind: 'error', text: '已手动停止本回合' });
  } else if (s.exitCode !== 0 && !tab.items.some((i) => i.kind === 'error')) {
    const tail = (s.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ');
    const text = tail || `hermes 进程退出码 ${s.exitCode}`;
    tab.items.push({ kind: 'error', text, failure: parseFailure('', text) });
  }
  tab.stoppedByUser = false;
  renderTabs();
  if (visible) {
    renderChat(); updateStatus(); setActivity('空闲');
    syncActivityBar(); syncComposerState();
    a11y(s.aborted ? '本轮已停止' : '本轮回复已完成');
  }
  // 窗口在后台时给一条系统通知（Electron renderer 原生支持，权限未授予则静默跳过）
  if (document.hidden && !s.aborted && typeof Notification !== 'undefined') {
    try { if (Notification.permission === 'granted') new Notification('Hermes', { body: '本轮回复已完成' }); } catch {}
  }
  refreshSessions($('#session-search').value.trim());
  if (tab.sessionId && hasNative) api.sessionStats(tab.sessionId).then(() => updateStatus()).catch(() => {});
}

/* ---------- 状态条 ---------- */
/* 底部状态栏显示文字；聊天流里的 .typing-msg 显示转动图标 + 计时。
   输入框上方的旧 #activity 条已移除，避免同一状态出现两次。 */
function setActivity(text) {
  $('#st-activity').textContent = text;
  const a = $('#activity-text'); if (a) a.textContent = text;
}
/** 切换 / 新建会话时必须复位用量 UI，否则会残留上一个会话的 token 与上下文占用 */
/* 上下文圆环周长：r=8（viewBox 20×20），2π×8 ≈ 50.27。
   JS 写 dashoffset 必须和 CSS 的 dasharray 同值，否则环会在 0 处露一道缝。 */
const CTX_RING_C = 50.27;
function resetUsageUI() {
  setStCell('#st-tokens', MSG_ICO_DB, '0 tok');
  $('#st-tps').textContent = '';
  $('#st-duration').textContent = '';
  setStCell('#st-rounds', MSG_ICO_RETRY, '');
  // 上下文圆环：无用量时整组连环一起收起（留个空环会像装饰噪点）
  const ctxEl = $('#st-ctx');
  if (ctxEl) {
    ctxEl.hidden = true;
    ctxEl.classList.remove('hot');
    ctxEl.title = '暂无用量数据';
    const pctEl = $('#st-ctx-pct'); if (pctEl) pctEl.textContent = '';
    const arcEl = $('#ctx-ring-arc'); if (arcEl) arcEl.style.strokeDashoffset = String(CTX_RING_C);
  }
}
function updateStatus() {
  const tab = activeTab();
  $('#st-model').textContent = '⬢ ' + ((tab && tab.model) || state.config.model || '未选择');
  // 会话 id 是 48 位哈希：状态条只留前 8 位，完整值放 title（否则会挤掉中间的用量组）
  const sid = (tab && tab.sessionId) || '';
  const sessEl = $('#st-session');
  sessEl.textContent = sid ? sid.slice(0, 8) : '—';
  sessEl.title = sid || '尚未建立会话';
  // 用量优先取后端 session.usage（真实口径），退回 result.tokens
  const r = tab && tab.lastResult;
  const u = tab && (tab.usage || (r && r.tokens) || null);
  // 状态条第一组：轮次 / 步数（本会话已发生的助手回合与工具调用）
  const rounds = tab ? tab.items.filter((i) => i.kind === 'assistant' && i.done).length : 0;
  const steps = tab ? tab.items.filter((i) => i.kind === 'tool').length : 0;
  const roundsEl = $('#st-rounds');
  if (roundsEl) setStCell('#st-rounds', MSG_ICO_RETRY, rounds ? `${rounds} 轮${steps ? ' ' + steps + ' 步' : ''}` : '');
  if (u) {
    const inTok = u.input || 0, outTok = u.output || 0;
    const total = u.total || (inTok + outTok);
    // dsh 用量带口径：总量 + 缓存命中率，输入/输出拆分放进 title 供细看
    let tokTxt = `${fmtTokens(total)} tok`;
    if (u.cacheHitPct) tokTxt += ` · 缓存命中 ${u.cacheHitPct}%`;
    else if (u.cacheRead) tokTxt += ` · 缓存 ${fmtTokens(u.cacheRead)}`;
    if (u.cost > 0) tokTxt += ` · $${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(2)}`;
    setStCell('#st-tokens', MSG_ICO_DB, tokTxt);
    $('#st-tokens').title = `输入 ${fmtTokens(inTok)} · 输出 ${fmtTokens(outTok)}${u.cacheRead ? ' · 缓存读 ' + fmtTokens(u.cacheRead) : ''}`;
    // 速率：输出太少时 tok/s 没有参考意义（2 tok / 5s = 0.4），改显 API 延迟
    const tps = u.tps || (r && r.duration_ms && outTok ? outTok / (r.duration_ms / 1000) : 0);
    // 组内用「·」分隔（dsh 口径：`↻ 4 轮 44 步 · 172 tok/s`），没有轮次时不留孤零零的点
    const tpsTxt = (outTok >= 20 && tps)
      ? `${tps.toFixed(1)} tok/s`
      : (u.latencyS ? `${u.latencyS.toFixed(1)}s/次调用` : '');
    $('#st-tps').textContent = tpsTxt ? (rounds ? '· ' + tpsTxt : tpsTxt) : '';
    $('#st-duration').textContent = r && r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '';
    // 上下文占用：有真实口径就用，否则按本轮 tokens 估算并标注
    let pct, label;
    if (u.contextMax) {
      pct = u.contextPercent != null ? u.contextPercent : Math.round((u.contextUsed / u.contextMax) * 100);
      label = `上下文 ${fmtTokens(u.contextUsed)}/${fmtTokens(u.contextMax)} · ${pct}%` + (u.contextEstimated ? '（估算）' : '');
    } else {
      const used = inTok + outTok;
      pct = Math.min(100, Math.round((used / 128000) * 100));
      label = `上下文估算 ${pct}%（${fmtTokens(used)}/128k）`;
    }
    pct = Math.max(0, Math.min(100, pct));
    const ctxEl = $('#st-ctx');
    if (ctxEl) {
      ctxEl.hidden = false;
      const pctEl = $('#st-ctx-pct');
      if (pctEl) pctEl.textContent = pct + '%';
      // 环从 12 点起顺时针填：dashoffset = 周长 ×（1 − 占比）
      const arcEl = $('#ctx-ring-arc');
      if (arcEl) arcEl.style.strokeDashoffset = (CTX_RING_C * (1 - pct / 100)).toFixed(2);
      ctxEl.classList.toggle('hot', pct > 80);
      ctxEl.title = label;
    }
  } else {
    resetUsageUI();
  }
  const yoloBtn = $('#chip-yolo');
  yoloBtn.classList.toggle('on', state.config.yolo);
  yoloBtn.setAttribute('aria-pressed', String(!!state.config.yolo));
  // 文案对齐 dsh 的权限胶囊：完全权限 / 审批模式（这是开关不是菜单，所以不加下拉箭头）
  yoloBtn.textContent = state.config.yolo ? '⊙ 完全权限' : '⊙ 审批模式';
  // 思考程度并进了模型菜单：只在非默认值时才在 chip 上带一句，避免常态噪音
  const eff = state.config.reasoning && state.config.reasoning !== 'none' ? ' · ' + state.config.reasoning : '';
  $('#chip-model').textContent = (state.config.model || '请选择模型') + eff + ' ⌄';
}
/** 附件条：空列表整体隐藏，不占用输入框布局高度 */
function renderAttach() {
  const box = $('#attach-list');
  if (!box) return;
  box.textContent = '';
  if (!state.attachments.length) { box.hidden = true; return; }
  box.hidden = false;
  for (const a of state.attachments) {
    const item = document.createElement('span');
    item.className = 'attach-item';
    item.setAttribute('role', 'listitem');
    const ico = document.createElement('span');
    ico.className = 'ai-ico';
    ico.innerHTML = ATTACH_ICON[a.kind] || ATTACH_ICON.file;
    ico.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'ai-name'; name.textContent = a.name;
    name.title = a.path;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'ai-x'; x.textContent = '×';
    x.setAttribute('aria-label', `移除附件 ${a.name}`);
    x.onclick = () => removeAttachment(a.path);
    item.append(ico, name, x);
    box.appendChild(item);
  }
}

/* ---------- Composer ---------- */
/** 发送键两态：空输入时是淡底软键，有内容才落成实心强调色（dsh 的亲和提示） */
function syncSendState() {
  const b = $('#btn-send'); if (!b) return;
  const inp = $('#input');
  b.classList.toggle('ready', !!(inp && inp.value.trim()));
}
function autoGrow() {
  const inp = $('#input'); inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 200) + 'px';
  syncSendState();
}
$('#input').addEventListener('input', () => {
  autoGrow(); updateCount();
  clearTimeout($('#input')._draftTimer);
  $('#input')._draftTimer = setTimeout(() => { if (typeof saveDraftFor === 'function') saveDraftFor(activeTab()); }, 400);
});
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#input').value); }
  else if (e.key === 'ArrowUp' && !$('#input').value && state.sendHistory.length) {
    e.preventDefault(); state.histIdx = Math.max(0, state.histIdx - 1);
    $('#input').value = state.sendHistory[state.histIdx] || ''; autoGrow();
  } else if (e.key === 'ArrowDown' && state.sendHistory.length) {
    e.preventDefault(); state.histIdx = Math.min(state.sendHistory.length, state.histIdx + 1);
    $('#input').value = state.sendHistory[state.histIdx] || ''; autoGrow();
  }
});
$('#btn-send').onclick = () => send($('#input').value);
$('#btn-stop').onclick = () => {
  const t = activeTab(); if (!t || !t.running) return;
  // 本地立即复位：不能依赖主进程 close 事件，漏发会永久卡在「正在停止」并挡住后续发送
  t.running = false; t.showTyping = false; t.stoppedByUser = true;
  invalidateTurn(t);
  if (hasNative && api.abort) Promise.resolve(api.abort(t.id)).catch(() => {});
  renderTabs(); renderChat(); updateStatus(); syncActivityBar(); syncComposerState();
  setActivity('已停止'); a11y('本轮已停止'); toast('已停止本回合', 1400);
};
const newSessionAction = () => {
  const t = activeTab();
  if (t && !t.items.length && !t.running) {
    // 即使当前已是空会话，也必须关闭插件/技能/设置等子页面并回到聊天视图
    closeSubpages();
    state.view = 'chat';
    document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
    renderChat(); renderSessions(); updateStatus();
    $('#input').focus();
    toast('当前已是新会话，直接输入即可', 1600);
  } else {
    newTab();
    $('#input').focus();
  }
};
$('#btn-new-tab').onclick = newSessionAction;
$('#btn-new-session').onclick = () => { newSessionAction(); if (window.innerWidth < 1000) setSidebar(false, { persist: false }); };
const togglePage = (page) => toggleSubpage(page, page.hidden);
// 注意：只绑实际存在的元素；$() 命中 null 会在赋值 .onclick 时抛 TypeError，中断后续所有绑定
$('#btn-plugins2').onclick = () => { setSidebar(true); togglePage($('#plugins-page')); };
$('#btn-skills2').onclick = () => { setSidebar(true); togglePage($('#skills-page')); };
$('#btn-kanban').onclick = () => { setSidebar(true); showKanban(); };
// 侧栏「新建项目」入口：弹窗 DOM 在看板页内，先开页再弹，保持既有 Esc/惰性化处理链
$('#sb-new-project').onclick = () => { setSidebar(true); showKanban(true); kbModalOpen('project'); };
// 官方「打开文件夹为项目」：选一个目录即建/进工作空间，不必先填表
$('#sb-open-folder').onclick = () => openFolderAsProject();
$('#btn-kanban-ir').onclick = () => showKanban();
$('#btn-settings').onclick = () => toggleSettings(true);
$('#btn-gw').onclick = showGateway;
$('#btn-gw-ir').onclick = showGateway;
$('#btn-plugins-ir').onclick = () => togglePage($('#plugins-page'));
$('#btn-skills-ir').onclick = () => togglePage($('#skills-page'));
$('#btn-settings-ir').onclick = () => toggleSettings(true);
$('#chip-model').onclick = () => openModelPicker();
// 去抖 180ms：每敲一个字都发两次 IPC（列表 + FTS）会造成输入卡顿与结果闪回
let searchDebounce = null;
$('#session-search').addEventListener('input', (e) => {
  $('#search-clear').hidden = !e.target.value;
  const v = e.target.value.trim();
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => refreshSessions(v), 180);
});
$('#search-clear').onclick = () => {
  clearTimeout(searchDebounce);
  $('#session-search').value = ''; $('#search-clear').hidden = true; refreshSessions('');
};
document.querySelectorAll('.quick-actions button').forEach((b) => { b.onclick = () => send(b.dataset.q); });

/* 侧栏显隐（复刻参考页 rail 交互）：
   展开侧栏 / 收起图标栏是两套 DOM，但只由下面这一个状态驱动：
   偏好记忆 + ⌘B 切换 + 点品牌 logo 展开 + 隐藏的一栏不参与键盘焦点。
   宽度交给 CSS 变量 --sb-w，避免内联 width 覆盖 .collapsed 的 width:0。 */
const SB_STATE_KEY = 'hermes.sidebar';
function sidebarOpen() { return !$('#sidebar').classList.contains('collapsed'); }
function syncSidebar() {
  const open = sidebarOpen();
  const sb = $('#sidebar'), ir = $('#iconrail');
  $('#frame').classList.toggle('sb-open', open);
  // 侧栏收起时：左上角（红绿灯右侧）出现「展开侧栏 + 新会话」
  $('#btn-expand').hidden = open;
  $('#btn-new-lead').hidden = open;
  $('#btn-expand').setAttribute('aria-expanded', String(open));
  // 透明/零宽的一栏仍会被 Tab 聚焦，用 inert + aria-hidden 彻底移出交互树
  sb.inert = !open; ir.inert = open;
  sb.setAttribute('aria-hidden', String(!open));
  ir.setAttribute('aria-hidden', String(open));
  // 所有页面级引导按钮（整页浮层 + 设置弹层）与侧栏状态保持一致
  const label = open ? '收起侧栏 ⌘B' : '展开侧栏 ⌘B';
  document.querySelectorAll('[data-lead="sidebar"]').forEach((b) => {
    b.title = label;
    b.setAttribute('aria-label', label.replace(' ⌘B', ''));
    b.setAttribute('aria-expanded', String(open));
  });
}
function setSidebar(open, opts = {}) {
  const next = !!open;
  const sb = $('#sidebar'), frame = $('#frame');
  // 隐藏窗口里 CSS 过渡时间线不推进（document.timeline 停在 0），
  // 切换会卡在动画起点；此时直接落到终态，回到前台即为正确布局。
  const skipAnim = document.hidden || frame.classList.contains('sb-init');
  if (skipAnim) frame.classList.add('sb-noanim');
  sb.classList.toggle('collapsed', !next);
  syncSidebar();
  if (skipAnim) {
    void document.body.offsetWidth; // 强制同步布局到终态
    frame.classList.remove('sb-noanim');
  }
  if (opts.persist !== false) {
    try { localStorage.setItem(SB_STATE_KEY, next ? 'open' : 'closed'); } catch {}
  }
}
function toggleSidebar() { setSidebar(!sidebarOpen()); }
$('#btn-sidebar-collapse').onclick = () => setSidebar(false);
$('#btn-expand').onclick = () => setSidebar(true);
$('#btn-new-lead').onclick = newSessionAction;
$('#sb-new').onclick = newSessionAction;
$('#sb-search-btn').onclick = () => { $('#session-search').focus(); };
$('#btn-sessions').onclick = () => { setSidebar(true); $('#session-search').focus(); };
// 收起态点击图标栏品牌 logo 展开侧栏（参考页 brand 行为），键盘同样可达
{
  const irLogo = $('.ir-logo');
  if (irLogo) {
    irLogo.onclick = () => setSidebar(true);
    irLogo.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSidebar(true); }
    };
  }
}
{
  const sbStorage = $('#sb-storage-btn');
  if (sbStorage) sbStorage.onclick = (e) => { e.stopPropagation(); toggleStoragePop(); };
  // 分组标题里的两个入口：原先是 12px 的 unicode 符号（⌕ / ⛁），几乎看不清，
  // 已换成内联 SVG + 20×20 点击区。<button> 原生可聚焦，不再补 role/tabindex。
  const sbSearch = $('#sb-quick-search');
  if (sbSearch) sbSearch.onclick = () => { setSidebar(true); $('#session-search').focus(); };
}
// 点击空白处收起会话菜单 / 空间浮层
document.addEventListener('click', (e) => {
  const m = $('#session-menu');
  if (m && !m.hidden && !m.contains(e.target) && !(e.target.closest && e.target.closest('.s-actions'))) closeSessionMenu();
  const p = $('#storage-pop');
  if (p && !p.hidden && !p.contains(e.target) && !(e.target.closest && e.target.closest('#sb-storage-btn'))) p.hidden = true;
});
// 启动按偏好恢复：HTML 默认展开，首帧 sb-init 禁用过渡，避免闪一次宽度动画。
// 用 setTimeout 而非 rAF —— 后台窗口的 rAF 会被节流，导致 sb-init 永远留着。
(function restoreSidebar() {
  let saved = null;
  try { saved = localStorage.getItem(SB_STATE_KEY); } catch {}
  setSidebar(saved !== 'closed', { persist: false });
  setTimeout(() => $('#frame').classList.remove('sb-init'), 60);
})();

/* 页面级引导按钮：整页（插件/技能/消息平台/市场）会盖住 #chat-head，
   此时由 #page-lead 接管「侧栏切换 / 新建会话」；设置弹层内用同一组件契约。
   只监听 hidden 属性变化，不需要改 5 处页面开关函数。 */
let lastModalOpen = false;
let modalOpener = null;
function syncPageLead() {
  const lead = $('#page-lead'), head = $('#chat-head');
  if (!lead || !head) return;
  const pageOpen = [...document.querySelectorAll('.subpage')].some((p) => !p.hidden);
  const modals = [$('#settings-page'), $('#palette'), $('#help-modal')];
  const modalOpen = modals.some((m) => m && !m.hidden);
  lead.hidden = !pageOpen;
  // 被整页/模态遮罩盖住的元素不参与 Tab 焦点，读屏也不会读到一层看不见的按钮
  head.inert = pageOpen || modalOpen;
  lead.inert = modalOpen;
  // 模态打开时整块背景 inert：否则 Tab 会跳到遮罩下的侧栏/输入区按钮（WCAG 2.4.3）。
  // 三个 .palette 浮层都在 #frame 之外，不受影响；整页 .subpage 在 frame 内，故仅模态时隔离。
  const frame = $('#frame');
  if (frame) frame.inert = modalOpen;
  // 关闭模态后把焦点还给触发者（Escape / 关闭按钮 / 点遮罩都经 hidden 变更，统一在此收口）。
  const active = document.activeElement;
  if (modalOpen && !lastModalOpen) {
    const inModal = modals.some((m) => m && m.contains(active));
    modalOpener = active && active !== document.body && !inModal ? active : null;
  } else if (!modalOpen && lastModalOpen) {
    const stuck = !active || active === document.body ||
      modals.some((m) => m && m.contains(active));
    if (stuck) {
      // 触发者不可用时（帮助层会把焦点直接放进模态内），回落到输入框。
      // 必须等上面的 frame.inert 解除后再 focus，否则 inert 内元素会静默拒绝聚焦。
      const fallback = $('#input');
      const target = (modalOpener && document.contains(modalOpener) && !modalOpener.closest('[inert]'))
        ? modalOpener
        : (fallback && !fallback.closest('[inert]') ? fallback : null);
      if (target) { try { target.focus({ preventScroll: true }); } catch { /* 已卸载 */ } }
    }
    modalOpener = null;
  }
  lastModalOpen = modalOpen;
}
(function watchPageLead() {
  const obs = new MutationObserver(syncPageLead);
  document.querySelectorAll('.subpage, #settings-page, #palette, #help-modal')
    .forEach((p) => obs.observe(p, { attributes: true, attributeFilter: ['hidden'] }));
  syncPageLead();
})();

/* 窄主区降级：窗口最小 940px、侧栏又能拖到 520px，叠加后主区仅约 370px，
   输入行（尤其发送按钮）与插件/技能工具栏会被挤出可视区。
   只依据 #main 的实际宽度切 class，主区 >600px 时不改变任何定版几何。 */
const COMPACT_MAX = 600;
function syncCompactLayout() {
  const main = $('#main');
  if (!main) return;
  const w = main.clientWidth;
  if (w > 0) document.documentElement.classList.toggle('compact', w <= COMPACT_MAX);
}
(function initCompactLayout() {
  const main = $('#main'), sidebar = $('#sidebar');
  if (!main) return;
  syncCompactLayout();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncCompactLayout).observe(main);
  window.addEventListener('resize', syncCompactLayout);
  // 侧栏宽度由 JS 写 --sb-w。窗口隐藏 / 最小化时 ResizeObserver 可能不派发，
  // 因此额外监听 style 变化，保证拖拽与恢复偏好后都能立刻同步（微任务内合并，无循环）。
  if (sidebar && typeof MutationObserver !== 'undefined') {
    new MutationObserver(syncCompactLayout).observe(sidebar, { attributes: true, attributeFilter: ['style'] });
  }
})();
/* 视口漂移上报：macOS 唤醒 / 退出全屏后，窗口 frame 变了但内容区可能没跟上，
   表现为窗口右侧一整块未绘制的白区。这里只上报真实 innerWidth/innerHeight，
   由主进程与窗口 bounds 比对，确有漂移才重新校准（平时不做任何动作）。 */
(function initViewportWatch() {
  if (!api || typeof api.reportViewport !== 'function') return;
  let t = null;
  const report = () => {
    try { api.reportViewport({ width: innerWidth, height: innerHeight }); } catch {}
  };
  const later = () => { if (t) clearTimeout(t); t = setTimeout(report, 400); };
  window.addEventListener('resize', later);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) later(); });
  window.addEventListener('focus', later);
  later();
})();
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-lead]');
  if (!btn) return;
  if (btn.dataset.lead === 'sidebar') {
    // 设置是模态遮罩，先退出再切换，否则用户看不到侧栏变化
    if (!$('#settings-page').hidden) toggleSettings(false);
    toggleSidebar();
  } else if (btn.dataset.lead === 'new') {
    document.querySelectorAll('.subpage').forEach((pg) => { pg.hidden = true; });
    if (!$('#settings-page').hidden) toggleSettings(false);
    newSessionAction();
  }
});

// 侧栏右缘横向拖拽调宽（zoom 1.1：屏幕位移 ÷1.1 = 布局 px；宽度记忆到 localStorage）
(function () {
  const handle = $('#sb-resize'), sidebar = $('#sidebar');
  const MIN = 240, MAX = 520;
  // 只写 --sb-w，不再写 inline width（否则会盖掉 .collapsed 的 width:0）
  const setW = (w) => sidebar.style.setProperty('--sb-w', w + 'px');
  const getW = () => parseFloat(sidebar.style.getPropertyValue('--sb-w')) || 288;
  try {
    const saved = parseFloat(localStorage.getItem('sb-width'));
    if (saved >= MIN && saved <= MAX) setW(saved);
  } catch {}
  let startX = 0, startW = 0;
  handle.addEventListener('mousedown', (e) => {
    if (sidebar.classList.contains('collapsed')) return;
    startX = e.clientX;
    startW = getW();
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!document.body.classList.contains('resizing')) return;
    setW(Math.min(MAX, Math.max(MIN, startW + (e.clientX - startX) / 1.1)));
  });
  window.addEventListener('mouseup', () => {
    if (!document.body.classList.contains('resizing')) return;
    document.body.classList.remove('resizing');
    try { localStorage.setItem('sb-width', String(Math.round(getW()))); } catch {}
  });
})();

// 附件（文件选择 + 拖放）：图片走多模态、PDF 走解析、其余按文件引用，统一交主进程附加
$('#btn-attach').onclick = () => $('#file-input').click();
$('#file-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  const paths = files.map(pathOfFile).filter(Boolean);
  if (paths.length) addAttachments(paths);
  else if (files.length) toast('未能读取文件路径，请改用拖拽或检查系统权限', 2600);
  e.target.value = '';
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    document.body.classList.add('dropping');
  }
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dropping');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  const paths = files.map(pathOfFile).filter(Boolean);
  if (paths.length) addAttachments(paths);
  else toast('未能读取文件路径，请改用「⊕ 附件」选择文件', 2600);
});

// 审批模式
$('#chip-yolo').onclick = () => {
  state.config.yolo = !state.config.yolo; updateStatus();
  toast(state.config.yolo ? '已开启：本会话跳过危险命令审批' : '已恢复审批模式', 1600);
  if (hasNative) api.setConfig({ yolo: state.config.yolo });
};

/* ---------- 对话/轨迹 视图切换 ---------- */
document.querySelectorAll('.vt').forEach((b) => {
  b.onclick = () => {
    state.view = b.dataset.view;
    document.querySelectorAll('.vt').forEach((x) => x.classList.toggle('active', x === b));
    renderChat();
  };
});

/* ---------- 命令面板 ---------- */
const COMMANDS = [
  { cmd: '/new', desc: '新建会话', run: () => newTab() },
  { cmd: '/model', desc: '切换模型', run: () => openModelPicker() },
  { cmd: '/effort', desc: '推理力度 (none…ultra)', run: () => openEffortPicker() },
  { cmd: '/yolo', desc: '切换审批模式', run: () => $('#chip-yolo').click() },
  { cmd: '/terminal', desc: '开关终端 rail', run: () => toggleTerminal() },
  { cmd: '/sessions', desc: '搜索会话', run: () => { setSidebar(true); $('#session-search').focus(); } },
  { cmd: '/export', desc: '导出会话记录为 Markdown 文件', run: exportTranscript },
  { cmd: '/copy', desc: '复制会话记录到剪贴板', run: () => copyTranscript() },
  { cmd: '/help', desc: '快捷键与操作帮助', run: () => toggleHelp(true) },
  { cmd: '/gateway', desc: '查看 hermes serve 状态', run: showGateway },
  { cmd: '/kanban', desc: '打开 CLI 原生任务看板（新建 / 提交派发 / 手动 tick）', run: () => showKanban(true) },
  { cmd: '/orb', desc: '收成桌面小圆球（点球弹出迷你聊天窗）', run: () => api.enterOrb && api.enterOrb() },
];
let paletteSel = 0, paletteItems = COMMANDS;
function togglePalette(show) {
  $('#palette').hidden = !show;
  if (show) {
    $('#palette-input').value = ''; $('#palette-input').placeholder = '输入命令…';
    paletteFilter(''); setTimeout(() => $('#palette-input').focus(), 30);
  }
}
function paletteFilter(q) {
  paletteItems = COMMANDS.filter((c) => !q || c.cmd.includes(q) || c.desc.includes(q));
  paletteSel = 0; renderPalette();
}
function renderPalette() {
  const ul = $('#palette-list'); ul.innerHTML = '';
  paletteItems.forEach((c, i) => {
    const li = document.createElement('li'); if (i === paletteSel) li.classList.add('sel');
    li.innerHTML = `<span class="p-cmd">${esc(c.cmd)}</span><span class="p-desc">${esc(c.desc)}</span>`;
    li.onclick = () => { togglePalette(false); c.run(); };
    ul.appendChild(li);
  });
}
$('#palette-input').addEventListener('input', (e) => paletteFilter(e.target.value.trim()));
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { paletteSel = Math.min(paletteItems.length - 1, paletteSel + 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { paletteSel = Math.max(0, paletteSel - 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'Enter') { const c = paletteItems[paletteSel]; togglePalette(false); c && c.run(); }
  else if (e.key === 'Escape') togglePalette(false);
});
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') togglePalette(false); });

const MODELS = ['deepseek-v4.1-flash', 'claude-sonnet-4', 'claude-opus-4', 'gpt-5.2', 'kimi-k2.5'];

/** WB 式 chip 下拉菜单：锚定 anchor 向上弹出，rows=[{key,name,tag}], 选中项打 ✓ */
let chipMenuCleanup = null;
/** 二级菜单挂在 body 上、用 fixed 定位：`#chip-menu` 是 overflow:hidden，
 *  子菜单嵌进去会被裁掉一条。全局同时只存在一个，关闭时清空内容。 */
function ensureChipSubmenu() { return $('#chip-submenu'); }
function chipSubClose() {
  const sub = $('#chip-submenu');
  if (sub) { sub.hidden = true; sub.innerHTML = ''; }
  document.querySelectorAll('#chip-menu .wb-menu-row[aria-expanded="true"]')
    .forEach((r) => r.setAttribute('aria-expanded', 'false'));
}
/**
 * chip 下拉菜单。rows 里带 sub 数组的行是「有二级」的入口（例如模型 → 思考程度）：
 * 悬停 / 点击 / → 展开，← 或 Esc 收起；选中二级项时 onPick(child, parentRow)。
 * 返回 { close, openSub }，调用方可以让某个二级菜单默认展开（/effort 直接落到力度上）。
 */
function openChipMenu(anchor, rows, selectedKey, onPick) {
  // 清理上一次未释放的监听（防残留 onDoc 吞点击）
  if (chipMenuCleanup) chipMenuCleanup();
  const menu = $('#chip-menu');
  chipSubClose();
  const rowHtml = (r) => {
    if (Array.isArray(r.sub)) {
      return `<div class="wb-menu-row has-sub" data-key="${esc(r.key)}" tabindex="0" role="menuitem"
        aria-haspopup="menu" aria-expanded="false">
        <span class="wb-menu-name">${esc(r.name)}</span>
        ${r.subValue ? `<span class="wb-menu-tag">${esc(r.subValue)}</span>` : ''}
        <span class="wb-menu-caret" aria-hidden="true">›</span>
      </div>`;
    }
    const sel = String(r.key) === String(selectedKey);
    return `<div class="wb-menu-row${sel ? ' selected' : ''}" data-key="${esc(r.key)}" tabindex="0" role="menuitem">
      <span class="wb-menu-name">${esc(r.name)}</span>
      ${r.tag ? `<span class="wb-menu-tag">${esc(r.tag)}</span>` : ''}
      <span class="wb-menu-check">${sel ? '✓' : ''}</span>
    </div>`;
  };
  menu.innerHTML = `<div class="wb-menu-list">${rows.map(rowHtml).join('')}</div>`;
  menu.hidden = false;
  // 定位：chip 上方弹出，左右不超出视口
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = Math.min(Math.max(8, rect.left), vw - mw - 8);
  let top = rect.top - mh - 8;
  if (top < 8) top = Math.min(rect.bottom + 8, vh - mh - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  const subOpen = (rowEl) => {
    const src = rows.find((x) => String(x.key) === String(rowEl.dataset.key));
    if (!src || !Array.isArray(src.sub)) return;
    const sub = ensureChipSubmenu();
    sub.innerHTML = `<div class="wb-menu-list">${src.sub.map((c) => `
      <div class="wb-menu-row${String(c.key) === String(src.subValue) ? ' selected' : ''}"
        data-key="${esc(c.key)}" tabindex="0" role="menuitem">
        <span class="wb-menu-name">${esc(c.name)}</span>
        ${c.tag ? `<span class="wb-menu-tag">${esc(c.tag)}</span>` : ''}
        <span class="wb-menu-check">${String(c.key) === String(src.subValue) ? '✓' : ''}</span>
      </div>`).join('')}</div>`;
    sub.hidden = false;
    // 默认贴右；右侧放不下就翻到左侧，再夹进视口
    const r = rowEl.getBoundingClientRect();
    const sw = sub.offsetWidth, sh = sub.offsetHeight;
    let sl = r.right + 4;
    if (sl + sw > vw - 8) sl = Math.max(8, r.left - sw - 4);
    const st = Math.min(Math.max(8, r.top - 5), Math.max(8, vh - sh - 8));
    sub.style.left = sl + 'px';
    sub.style.top = st + 'px';
    rowEl.setAttribute('aria-expanded', 'true');
    sub.querySelectorAll('.wb-menu-row').forEach((el) => {
      el.onclick = () => {
        const picked = src.sub.find((x) => String(x.key) === String(el.dataset.key));
        close();
        if (picked) onPick(picked, src);
      };
    });
  };

  const close = () => {
    chipSubClose();
    menu.hidden = true;
    chipMenuCleanup = null;
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  chipMenuCleanup = close;
  const onDoc = (e) => {
    const sub = $('#chip-submenu');
    if (menu.contains(e.target) || (sub && sub.contains(e.target))) return;
    if (e.target === anchor || anchor.contains(e.target)) return;
    close();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    // Esc 先收二级，再收一级：跟目录树的习惯一致
    const sub = $('#chip-submenu');
    if (sub && !sub.hidden) { e.stopPropagation(); chipSubClose(); return; }
    close();
  };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);

  menu.querySelectorAll('.wb-menu-row').forEach((row) => {
    const src = rows.find((x) => String(x.key) === String(row.dataset.key));
    if (src && Array.isArray(src.sub)) {
      row.onmouseenter = () => subOpen(row);
      row.onclick = () => { if (row.getAttribute('aria-expanded') === 'true') chipSubClose(); else subOpen(row); };
      row.onkeydown = (e) => {
        if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); subOpen(row); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); chipSubClose(); }
      };
      return;
    }
    // 移回普通行就收起二级，避免「菜单还停在别的行上」
    row.onmouseenter = chipSubClose;
    row.onclick = () => { close(); if (src) onPick(src); };
  });

  return {
    close,
    openSub: (key) => {
      const row = menu.querySelector(`.wb-menu-row[data-key="${key}"]`);
      if (row) subOpen(row);
    },
  };
}

/* ---------- 模型配置漂移 ----------
   桌面端 userData/config.json 的 model 会覆盖 CLI config.yaml 的 model.default。
   旧实现只列 models.json，而 CLI 默认模型常常不在那个列表里 —— 用户即使知道
   默认值也选不到，失败后只能看到错误卡。这里把 CLI 默认作为选择器首项，
   并在启动时对「已保存的模型 ≠ CLI 默认」给出非阻断提示。
   提示只是信息，唯一会写配置的入口是用户点「跟随 CLI 默认」。 */
let cliModelState = null;
let driftDismissed = false;

async function readCliModelState(force) {
  if (!force && cliModelState) return cliModelState;
  if (typeof api.configModelState !== 'function') return cliModelState;
  try {
    const r = await api.configModelState();
    if (r && r.ok) { cliModelState = r; return r; }
  } catch {}
  return cliModelState; // 读失败沿用上次快照，绝不阻断界面
}

async function syncModelDrift(force) {
  const box = $('#model-drift');
  if (!box) return;
  if (driftDismissed) { box.hidden = true; return; }
  const ms = await readCliModelState(force);
  const cliDefault = ms && ms.defaultModel;
  const current = state.config.model || '';
  if (!cliDefault || !current || current === cliDefault) { box.hidden = true; return; }
  const tip = ms.inModelsList
    ? '。'
    : '；该默认模型未列入 models.json，现已加入模型选择器。';
  $('#model-drift-text').innerHTML =
    `桌面端配置使用 <code>${esc(current)}</code>，会覆盖 CLI 默认 <code>${esc(cliDefault)}</code>${tip}` +
    ' 若调用失败，可一键跟随（只改桌面端配置，不动 CLI）。';
  box.dataset.cliDefault = cliDefault;
  box.hidden = false;
}

$('#btn-md-follow').onclick = () => {
  const box = $('#model-drift');
  const v = box && box.dataset.cliDefault;
  if (!v) return;
  setModel(v); // 用户主动点击才写 userData/config.json
  box.hidden = true;
  toast('已跟随 CLI 默认模型：' + v);
};
$('#btn-md-later').onclick = () => { driftDismissed = true; $('#model-drift').hidden = true; };
$('#btn-md-close').onclick = () => { driftDismissed = true; $('#model-drift').hidden = true; };

/**
 * 模型候选行：CLI 默认置顶 → models.json → 内置兜底，按 key 去重。
 * chip 菜单与设置页「默认模型」下拉共用同一份规则，避免两处列表漂移。
 * current 单独兜底：配置里存着不在任何清单中的模型（例如失效名）时仍可见、可改。
 */
function modelRows(ms, fallback, current) {
  const rows = [];
  const seen = new Set();
  const cliDefault = ms && ms.defaultModel;
  if (cliDefault) {
    rows.push({ key: cliDefault, name: cliDefault, tag: 'CLI 默认' });
    seen.add(cliDefault);
  }
  const fromState = arr(ms && ms.models);
  const real = fromState.length ? fromState : arr(fallback);
  if (real.length) {
    for (const m of real) {
      if (!m || !m.model || seen.has(m.model)) continue;
      seen.add(m.model);
      rows.push({ key: m.model, name: m.name || m.model, tag: m.provider || '' });
    }
  } else {
    for (const m of MODELS) {
      if (seen.has(m)) continue;
      seen.add(m);
      rows.push({ key: m, name: m, tag: '内置' });
    }
  }
  const cur = String(current || '');
  if (cur && !seen.has(cur)) rows.push({ key: cur, name: cur, tag: '当前配置' });
  return rows;
}

const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
async function openModelPicker(opts) {
  // 每次打开都重读一次：CLI 侧 config.yaml 可能被手工改过，缓存会掩盖新默认值
  const ms = await readCliModelState(true);
  let fallback = [];
  if (!arr(ms && ms.models).length) {
    try { if (hasNative) { const r = await api.configModels(); if (r && r.ok) fallback = arr(r.models); } } catch {}
  }
  const rows = modelRows(ms, fallback, state.config.model);
  // 思考程度是「跟模型一起决定输出形态」的二级参数，收进模型菜单的最后一项
  rows.push({
    key: '::effort', name: '思考程度',
    subValue: state.config.reasoning || 'none',
    sub: EFFORT_LEVELS.map((l) => ({ key: l, name: l, tag: l === 'none' ? '不思考' : '' })),
  });
  const h = openChipMenu($('#chip-model'), rows, state.config.model, (r, parent) => {
    if (parent && parent.key === '::effort') setEffort(r.key);
    else setModel(r.key);
  });
  if (opts && opts.effort && h) h.openSub('::effort');
}

/** 思考程度只写桌面端 config.json 的 reasoning，不碰 CLI 的 agent.reasoning_effort */
function setEffort(level) {
  state.config.reasoning = level;
  if (hasNative) api.setConfig({ reasoning: level });
  updateStatus();
  toast('思考程度 → ' + level);
}

function setModel(m) {
  state.config.model = m;
  if (hasNative) api.setConfig({ model: state.config.model });
  // 用户已主动做出选择，本次会话不再反复提示漂移
  driftDismissed = true;
  const box = $('#model-drift'); if (box) box.hidden = true;
  updateStatus(); toast('模型 → ' + state.config.model);
}

/** 唯一入口在模型 chip 里；/effort 只是把同一个菜单打开并直接落到二级上 */
function openEffortPicker() {
  return openModelPicker({ effort: true });
}
function transcriptText() {
  const tab = activeTab(); if (!tab) return '';
  const lines = [`# ${tab.title || 'Hermes 会话'}`, `> 导出时间：${new Date().toLocaleString('zh-CN')}`];
  for (const i of tab.items) {
    if (i.kind === 'user') lines.push(`## 你\n${i.text}`);
    else if (i.kind === 'assistant') lines.push(`## Hermes\n${i.text}`);
    else if (i.kind === 'tool') lines.push(`## 工具 ${i.name} [${i.state}]\n${i.output || ''}`);
    else if (i.kind === 'thinking') lines.push(`<details><summary>思考过程</summary>\n\n${i.text}\n\n</details>`);
    else if (i.kind === 'approval') lines.push(`## 审批：${i.tool || ''}（${i.choice === 'deny' ? '已拒绝' : i.choice ? '已允许' : '待确认'}）\n${i.command || ''}`);
    else lines.push(`## 错误\n${i.text}`);
  }
  return lines.join('\n\n');
}
/** 导出为本地 .md 文件（Claude Code 的 transcript 导出习惯），并保留剪贴板副本命令。 */
function exportTranscript() {
  const tab = activeTab(); if (!tab) return;
  const text = transcriptText();
  try {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = String(tab.title || 'hermes-session').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 48);
    a.href = url; a.download = `${safe}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('会话记录已导出为 Markdown', 1800);
  } catch (e) { toast('导出失败：' + ((e && e.message) || e), 2400); }
}
function copyTranscript() {
  const text = transcriptText(); if (!text) return;
  navigator.clipboard.writeText(text)
    .then(() => toast('会话记录已复制'))
    .catch(() => toast('复制失败，请改用 /export 导出', 2200));
}
/* ---------- 消息平台接入页 ---------- */
const GW_GROUPS = [
  { key: 'common', label: '常用平台' },
  { key: 'cn', label: '国内平台' },
  { key: 'advanced', label: '其他通道' },
];
let gwData = null;

/** 菜单入口：打开/关闭「消息平台接入」整页（原为一条 toast） */
function showGateway() {
  const page = $('#gateway-page');
  if (!page) return;
  if (!page.hidden) { page.hidden = true; return; }
  ['#plugins-page', '#skills-page', '#market-page'].forEach((s) => { const p = $(s); if (p) p.hidden = true; });
  try { closeKanbanPage(); } catch {}
  page.hidden = false;
  loadGatewayOverview();
}
function closeGatewayPage() { const p = $('#gateway-page'); if (p) p.hidden = true; }

async function loadGatewayOverview() {
  const stateEl = $('#gw-service-state');
  if (stateEl) stateEl.textContent = '读取中…';
  const api = window.hermesAPI;
  if (!api || !api.gwOverview) {
    gwData = { ok: false, error: '此页需要在 Hermes 桌面端运行（Demo 模式无本地配置）', platforms: [] };
  } else {
    try { gwData = await api.gwOverview(); }
    catch (e) { gwData = { ok: false, error: e.message, platforms: [] }; }
  }
  renderGatewayPage();
}

function gwStatusOf(p) {
  if (p.declared && !p.enabled) return { cls: 'off', text: '已禁用' };
  if (!p.env.length) return { cls: '', text: '内置通道' };
  if (p.presentEnv.length === p.env.length) return { cls: 'ok', text: '已配置' };
  if (p.presentEnv.length > 0) return { cls: 'part', text: `缺 ${p.missingEnv.length} 项` };
  return { cls: '', text: '未配置' };
}

function renderGatewayPage() {
  const d = gwData || { ok: false, error: '尚未加载', platforms: [] };
  const stateEl = $('#gw-service-state'), metaEl = $('#gw-service-meta'), dot = $('#gw-live-dot');
  if (!d.ok) {
    if (stateEl) stateEl.textContent = '无法读取';
    if (metaEl) metaEl.textContent = d.error || '';
  } else {
    if (stateEl) stateEl.textContent = d.running ? '运行中' : '已停止';
    if (dot) dot.classList.toggle('on', !!d.running);
    const s = d.service || {};
    const bits = [];
    if (d.running && s.pid) bits.push(`PID ${s.pid}`);
    if (s.kind) bits.push(String(s.kind));
    if (s.startedAt) bits.push(`启动于 ${s.startedAt}`);
    if (!d.running && s.exitReason) bits.push(`上次退出：${s.exitReason}`);
    if (s.codeVersion) bits.push(String(s.codeVersion));
    if (metaEl) metaEl.textContent = bits.join(' · ') || '暂无历史状态';
    document.querySelectorAll('.gw-hero-actions .gw-btn').forEach((b) => {
      if (b.dataset.act === 'start') b.disabled = !!d.running;
      if (b.dataset.act === 'stop') b.disabled = !d.running;
    });
  }

  const stats = $('#gw-stats');
  if (stats) {
    const ps = d.platforms || [];
    const configured = ps.filter((p) => p.hasCredentials || p.declared).length;
    const cur = (d.profiles || []).find((p) => p.current);
    stats.innerHTML = [
      [`${configured} / ${ps.length}`, '已配置平台'],
      [cur ? cur.name : 'default', '当前 Profile'],
      [(d.service && d.service.sessionStore) || '—', '会话库状态'],
      ['~/.hermes', '配置目录'],
    ].map(([v, k]) => `<div class="gw-stat"><b>${esc(String(v))}</b><span>${esc(k)}</span></div>`).join('');
  }

  const q = ($('#gw-search') && $('#gw-search').value || '').trim().toLowerCase();
  const all = d.platforms || [];
  const ps = all.filter((p) => !q || (p.label + ' ' + p.key + ' ' + p.env.join(' ')).toLowerCase().indexOf(q) >= 0);
  const cnt = $('#gw-count'); if (cnt) cnt.textContent = q ? `${ps.length} / ${all.length}` : `共 ${all.length} 个`;
  const clr = $('#gw-search-clear'); if (clr) clr.hidden = !q;
  const groups = $('#gw-groups');
  if (groups) {
    groups.innerHTML = ps.length ? GW_GROUPS.map((g) => {
      const cards = ps.filter((p) => p.group === g.key);
      if (!cards.length) return '';
      return `<div class="gw-section-label">${esc(g.label)} <span style="font-weight:400;color:var(--text-3)">（${cards.length}）</span></div>
        <div class="gw-grid">${cards.map(gwCardHtml).join('')}</div>`;
    }).join('') : '<div class="gw-empty">没有匹配的平台</div>';
  }

  const profiles = $('#gw-profiles');
  if (profiles) {
    const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB');
    profiles.innerHTML = (d.profiles || []).map((p) => `
      <div class="gw-prof-card ${p.current ? 'current' : ''}">
        <div class="gw-prof-top"><b>${esc(p.name)}</b>${p.current ? '<span class="gw-prof-badge">当前</span>' : '<span class="gw-prof-badge dim">未激活</span>'}</div>
        <div class="gw-prof-meta">${esc(p.model || '未指定模型')}</div>
        <div class="gw-prof-meta dim">会话库 ${mb(p.dbBytes || 0)} · 技能 ${p.skills || 0}</div>
      </div>`).join('');
  }
}

function gwCardHtml(p) {
  const st = gwStatusOf(p);
  const envHtml = p.env.length
    ? `<div class="gw-env-label">所需凭证（写入 ~/.hermes/.env）</div><div class="gw-env-keys">${p.env.map((k) =>
        `<code class="${p.presentEnv.indexOf(k) >= 0 ? 'present' : ''}">${esc(k)}</code>`).join('')}</div>`
    : '<div class="gw-env-label">无需额外凭证，由 Gateway 内置提供</div>';
  return `<div class="gw-card" data-key="${esc(p.key)}">
    <div class="gw-card-top">
      <span class="gw-card-ico">${p.ico}</span>
      <div class="gw-card-title">
        <div class="gw-card-name">${esc(p.label)}<span class="gw-badge ${st.cls}">${st.text}</span></div>
        <div class="gw-card-key">${esc(p.key)}</div>
      </div>
    </div>
    ${envHtml}
    <div class="gw-card-actions">
      <button data-act="copy-setup" data-cmd="${esc(p.setup)}">复制配置命令</button>
      <button data-act="open-env">打开 .env</button>
    </div>
  </div>`;
}

function gwCopy(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; } } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

async function gwRunAction(op) {
  const label = { start: '启动', stop: '停止', restart: '重启' }[op];
  if (!window.confirm(`${label} Gateway 后台服务？\n\n会执行 hermes gateway ${op}，影响所有消息平台的收发。`)) return;
  const api = window.hermesAPI;
  if (!api || !api.gwAction) { toast('需要在桌面端运行', 2200); return; }
  toast(`正在${label} Gateway…`, 2000);
  try {
    const r = await api.gwAction(op);
    if (r && r.ok) { gwData = r.overview || gwData; renderGatewayPage(); toast(`Gateway 已${label}`, 2200); }
    else toast(`${label}失败：${(r && (r.error || r.output)) || '未知错误'}`, 4200);
  } catch (e) { toast(`${label}失败：${e.message}`, 3200); }
}

$('#gw-refresh').onclick = () => loadGatewayOverview();
$('#gw-close').onclick = closeGatewayPage;
$('#gw-open-config').onclick = async () => {
  const api = window.hermesAPI;
  if (api && api.gwOpenFile) { const r = await api.gwOpenFile('config'); if (!r.ok) toast(r.error, 2600); }
};
$('#gw-search').addEventListener('input', renderGatewayPage);
$('#gw-search-clear').onclick = () => { $('#gw-search').value = ''; renderGatewayPage(); $('#gw-search').focus(); };
$('#gateway-page').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'start' || act === 'stop' || act === 'restart') return gwRunAction(act);
  if (act === 'copy-setup') {
    const cmd = b.dataset.cmd || 'hermes gateway setup';
    toast(gwCopy(cmd) ? `已复制：${cmd}` : '复制失败，请手动复制', 2200);
    return;
  }
  if (act === 'open-env') {
    const api = window.hermesAPI;
    if (api && api.gwOpenFile) { const r = await api.gwOpenFile('env'); if (!r.ok) toast(r.error, 2600); }
  }
});

/* ---------- 右侧 rail：预览 | 终端 ---------- */
let termId = null;
let termMode = '';
// pty 输出是带 ANSI 控制序列的原始字节流，先过字符屏幕再进 DOM
const termScreen = new TermScreen();
let railTab = 'preview';
const pv = { url: '', filePath: '', label: '', kind: '', baseDir: '' };
const pvAvailable = () => hasNative && typeof api.previewResolve === 'function';

function setRailTab(tab) {
  railTab = tab === 'terminal' ? 'terminal' : 'preview';
  document.querySelectorAll('#rail-tabs .rt').forEach((b) => b.classList.toggle('active', b.dataset.rail === railTab));
  $('#preview-pane').hidden = railTab !== 'preview';
  $('#term-pane').hidden = railTab !== 'terminal';
  $('#term-mode').textContent = railTab === 'terminal' ? termMode : (pv.kind === 'url' ? '远程网页' : '本地文件');
  if (railTab === 'terminal') ensureTerminal();
}

/** 终端按需创建：默认打开的是预览，只有切到「终端」页签才拉起 pty。 */
async function ensureTerminal() {
  if (termId) { $('#term-in').focus(); return; }
  if (!hasNative) {
    $('#term-out').textContent = '（浏览器 Demo 模式无终端）';
    termMode = 'demo'; $('#term-mode').textContent = 'demo'; return;
  }
  termId = 'term_' + uid();
  $('#term-out').textContent = '';
  termScreen.reset();
  const home = await api.getPath('home');
  const res = await api.termCreate({ id: termId, cwd: home });
  termMode = res.pty ? 'pty' : 'pipe（node-pty 未编译）';
  $('#term-mode').textContent = termMode;
  $('#term-in').focus();
}

function toggleTerminal(force) {
  const rail = $('#rail');
  const show = force !== undefined ? force : rail.hidden;
  $('#btn-rail-toggle').classList.toggle('on', show);
  if (!show) {
    rail.hidden = true;
    if (termId && hasNative) api.termKill({ id: termId });
    termId = null;
    if (pvAvailable()) api.previewUnwatch();
    return;
  }
  rail.hidden = false;
  setRailTab(railTab);
}

function pvState(msg, isErr) {
  const el = $('#pv-state');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}
function loadFrame(url) {
  const f = $('#pv-frame');
  // 本地 HTML 保留完整能力（用户拍板的「任意本地 html 预览」）；
  // 远程页面收紧：不允许弹窗 / 表单提交 / 模态 / 下载，避免钓鱼式 iframe。
  const remote = /^https?:\/\//i.test(String(url));
  f.setAttribute('sandbox', remote
    ? 'allow-scripts'
    : 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
  // 后台窗口 rAF 会被节流，用定时器保证 file:// 变更一定触发重新导航
  f.src = 'about:blank';
  setTimeout(() => { f.src = url; }, 24);
}
async function setPreview(res) {
  if (!res || !res.ok) { pvState((res && res.error) || '加载失败', true); return false; }
  const isFile = res.kind === 'file';
  pv.url = res.url; pv.filePath = res.filePath || ''; pv.label = res.label || '';
  pv.kind = res.kind; pv.baseDir = res.baseDir || pv.baseDir;
  $('#pv-path').value = isFile ? res.filePath : res.url;
  $('#pv-empty').hidden = true;
  pvState(isFile ? '已加载' : '网页预览');
  setRailTab('preview');
  loadFrame(res.url);
  if (!pvAvailable()) return true;
  if (isFile) await api.previewWatch(res.filePath);
  else await api.previewUnwatch();
  return true;
}
async function loadPreviewInput(raw) {
  const v = String(raw || '').trim();
  if (!v) return;
  if (/^https?:\/\//i.test(v)) {
    let host = v;
    try { host = new URL(v).host; } catch {}
    await setPreview({ ok: true, kind: 'url', url: v, label: host });
    return;
  }
  if (!pvAvailable()) { pvState('演示模式无本地预览', true); return; }
  pvState('正在打开…');
  try {
    const res = await api.previewResolve(v, pv.baseDir || undefined);
    await setPreview(res);
  } catch (err) { pvState('打开失败：' + String(err && err.message || err), true); }
}
function reloadPreview() {
  if (!pv.url) { pvState('请先打开一个文件', true); return; }
  const url = /^https?:\/\//i.test(pv.url)
    ? pv.url + (pv.url.includes('?') ? '&' : '?') + '_hermes=' + Date.now() : pv.url;
  loadFrame(url);
  pvState('已刷新');
}
$('#btn-rail-toggle').onclick = () => toggleTerminal();
$('#btn-term-close').onclick = () => toggleTerminal(false);
document.querySelectorAll('#rail-tabs .rt').forEach((b) => { b.onclick = () => setRailTab(b.dataset.rail); });
$('#pv-open').onclick = async () => {
  if (!pvAvailable()) { toast('演示模式无法读取本地文件', 2000); return; }
  const r = await api.previewPick();
  if (r && r.ok) await setPreview(r);
  else if (r && !r.canceled) pvState(r.error || '选择失败', true);
};
$('#pv-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadPreviewInput(e.target.value); } });
$('#pv-reload').onclick = reloadPreview;
$('#pv-external').onclick = async () => {
  const target = pv.filePath || pv.url || $('#pv-path').value.trim();
  if (!target) { toast('请先打开一个文件', 1800); return; }
  if (!pvAvailable()) return;
  const r = await api.previewOpenExternal(target);
  if (r && !r.ok) toast(r.error || '打开失败', 2400);
};
$('#term-in').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && termId) {
    const cmd = $('#term-in').value; $('#term-in').value = '';
    if (cmd.trim() === 'exit') { toggleTerminal(false); return; }
    if (hasNative) api.termWrite({ id: termId, data: cmd + '\n' });
  }
});
let pvReloadTimer = null;
if (hasNative) {
  api.onTermData(({ id, data }) => {
    if (id !== termId) return;
    const out = $('#term-out');
    // 整屏替换而不是 += ：\r 重绘、清行、光标回退都需要改写已有行
    out.textContent = termScreen.push(data);
    out.scrollTop = out.scrollHeight;
  });
  if (api.onPreviewChanged) api.onPreviewChanged(({ filePath }) => {
    if (!pv.filePath || filePath !== pv.filePath || $('#rail').hidden) return;
    if (!$('#pv-auto').checked) { pvState('文件已变更 · 自动跟随已关闭'); return; }
    // 一次保存常触发多条 watch 事件，去抖合并，避免 iframe 反复重建闪烁
    clearTimeout(pvReloadTimer);
    pvReloadTimer = setTimeout(() => { reloadPreview(); pvState('已自动刷新'); }, 160);
  });
}

/** 从工具参数 / 结果里找 .html 路径，自动跟随 Agent 写出的网页。 */
function collectStrings(v, out, depth) {
  if (depth > 3 || out.length > 40) return;
  if (typeof v === 'string') { out.push(v); return; }
  if (Array.isArray(v)) { v.forEach((x) => collectStrings(x, out, depth + 1)); return; }
  if (v && typeof v === 'object') { Object.values(v).forEach((x) => collectStrings(x, out, depth + 1)); }
}
function extractHtmlPaths(text) {
  const found = [];
  const re1 = /["'`](~?\/[^"'`\n]*?\.(?:html?|xhtml|svg))["'`]/gi;
  const re2 = /(?:^|[\s(\[])(~?\/[^\s"'<>\])},;]*\.(?:html?|xhtml|svg))(?=$|[\s"'<>\])},;])/gi;
  for (const re of [re1, re2]) {
    let m; while ((m = re.exec(text)) !== null) { if (!found.includes(m[1])) found.push(m[1]); }
  }
  return found;
}
let pvAutoAt = 0;
async function maybeAutoPreview(evt) {
  if (!pvAvailable() || !$('#pv-auto').checked) return;
  const parts = [];
  collectStrings(evt.input, parts, 0);
  if (typeof evt.output === 'string') parts.push(evt.output);
  if (typeof evt.preview === 'string') parts.push(evt.preview);
  const paths = extractHtmlPaths(parts.join('\n'));
  if (!paths.length) return;
  for (const p of paths.slice(0, 3)) {
    let res;
    try { res = await api.previewResolve(p, pv.baseDir || undefined); } catch { continue; }
    if (!res.ok) continue;
    if (res.filePath === pv.filePath && Date.now() - pvAutoAt < 1200) continue;
    pvAutoAt = Date.now();
    if ($('#rail').hidden) toggleTerminal(true);
    await setPreview(res);
    pvState('已跟随 Agent 写入');
    break;
  }
}

/* ---------- 全局快捷键（可自定义） ----------
   组合格式固定为 mod+[alt+][shift+]key，mod 统一代表 ⌘ / Ctrl。
   约束：必须带 mod（或 '?' 这种仅在非输入态生效的固定别名），避免劫持普通打字；
   Escape 是浮层关闭 / 中断生成的系统键，不开放自定义。
   存储经 cleanShortcuts() 白名单 + 冲突去重，被篡改的 localStorage 不会注入任意动作。 */
/* ---------- 会话内查找（⌘F） ----------
   命中高亮用 CSS Custom Highlight API：只创建 Range，不插 <mark>，因此
   流式输出的增量重建、代码块横向滚动、悬停操作条都不会被打断。
   浏览器不支持时降级为「只有计数、没有高亮」，功能不消失。 */
const FIND_MAX = 800;
const FIND_STATE = { open: false, query: '', ranges: [], index: -1, scrollTop: 0 };
const FIND_HL_SUPPORTED = (() => {
  try { return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'; }
  catch { return false; }
})();
function findReset() {
  if (FIND_HL_SUPPORTED) {
    try { CSS.highlights.delete('hermes-find'); CSS.highlights.delete('hermes-find-active'); } catch {}
  }
  FIND_STATE.ranges = [];
  FIND_STATE.index = -1;
}
/** 收集 #chat 里的纯文本命中。跳过脚本、样式与读屏专用节点。 */
function findCollect(query) {
  findReset();
  const root = $('#chat');
  const needle = String(query || '').toLowerCase();
  if (!root || !needle) { findPaintCount(); return; }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const v = n.nodeValue;
      if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (p && p.closest('script, style, .sr-only')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  outer:
  while ((node = walker.nextNode())) {
    const hay = node.nodeValue.toLowerCase();
    let from = 0;
    for (;;) {
      if (FIND_STATE.ranges.length >= FIND_MAX) break outer;
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + needle.length);
      FIND_STATE.ranges.push(r);
      from = at + needle.length;
    }
  }
  if (FIND_STATE.ranges.length) FIND_STATE.index = 0;
  findPaint();
}
function findPaintCount() {
  const el = $('#find-count');
  if (!el) return;
  const n = FIND_STATE.ranges.length;
  if (!FIND_STATE.query) { el.textContent = '0/0'; el.classList.remove('empty'); return; }
  el.textContent = n ? `${FIND_STATE.index + 1}/${n}` : '0/0';
  el.classList.toggle('empty', !n);
  const prev = $('#find-prev'), next = $('#find-next');
  if (prev) prev.disabled = !n;
  if (next) next.disabled = !n;
}
function findPaint() {
  if (FIND_HL_SUPPORTED) {
    try {
      const active = FIND_STATE.index >= 0 ? FIND_STATE.ranges[FIND_STATE.index] : null;
      const rest = FIND_STATE.ranges.filter((r) => r !== active);
      if (rest.length) CSS.highlights.set('hermes-find', new Highlight(...rest));
      else CSS.highlights.delete('hermes-find');
      if (active) CSS.highlights.set('hermes-find-active', new Highlight(active));
      else CSS.highlights.delete('hermes-find-active');
    } catch {}
  }
  findPaintCount();
}
/** 把当前命中滚到可视区中部；只动 #chat-scroll 的 scrollTop，不 scrollIntoView
 *  （后者会连带滚动外层容器，把侧栏也带偏）。 */
function findReveal() {
  const r = FIND_STATE.ranges[FIND_STATE.index];
  const scroller = $('#chat-scroll');
  if (!r || !scroller) return;
  const rect = r.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const pad = 48;
  if (rect.top < box.top + pad || rect.bottom > box.bottom - pad) {
    scroller.scrollTop += rect.top - box.top - (box.height / 2);
  }
}
function findStep(dir) {
  const n = FIND_STATE.ranges.length;
  if (!n) return;
  FIND_STATE.index = (FIND_STATE.index + dir + n) % n;
  findPaint();
  findReveal();
}
function findOpen(initial) {
  const bar = $('#find-bar'), input = $('#find-input');
  if (!bar || !input) return;
  if (!FIND_STATE.open) {
    FIND_STATE.open = true;
    const sc = $('#chat-scroll');
    FIND_STATE.scrollTop = sc ? sc.scrollTop : 0;
    bar.hidden = false;
  }
  if (typeof initial === 'string' && initial) input.value = initial;
  input.focus();
  input.select();
  FIND_STATE.query = input.value.trim();
  findCollect(FIND_STATE.query);
}
function findClose() {
  const bar = $('#find-bar');
  if (!bar || !FIND_STATE.open) return;
  FIND_STATE.open = false;
  bar.hidden = true;
  findReset();
  FIND_STATE.query = '';
  const sc = $('#chat-scroll');
  if (sc) sc.scrollTop = FIND_STATE.scrollTop;  // 关闭后回到打开前的位置
  const input = $('#find-input');
  if (input) input.value = '';
  const btn = $('#btn-find');
  if (btn && document.activeElement === btn) btn.blur();
}
/** 会话已打开（有消息）时 ⌘F 走会话内查找，空态才回落到侧栏搜索。 */
function hasOpenTranscript() {
  const chat = $('#chat');
  const main = $('#main');
  return !!(chat && chat.children.length && main && !main.classList.contains('empty'));
}
(function wireFindBar() {
  const input = $('#find-input');
  if (!input) return;
  const btn = $('#btn-find');
  if (btn) btn.onclick = () => findOpen();
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      FIND_STATE.query = input.value.trim();
      findCollect(FIND_STATE.query);
      findReveal();
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      // 必须 stopPropagation：否则全局 Escape 会继续往下走，把正在生成的回合也中断掉
      e.preventDefault(); e.stopPropagation();
      findClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); findStep(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); findStep(-1);
    }
  });
  const prev = $('#find-prev'), next = $('#find-next'), close = $('#find-close');
  if (prev) prev.onclick = () => findStep(-1);
  if (next) next.onclick = () => findStep(1);
  if (close) close.onclick = () => findClose();
  // 流式输出会持续重建 #chat：防抖后重算命中，保持计数与高亮同步
  const chat = $('#chat');
  if (chat && typeof MutationObserver === 'function') {
    let mo = null;
    new MutationObserver(() => {
      if (!FIND_STATE.open || !FIND_STATE.query) return;
      if (mo) return;
      mo = setTimeout(() => {
        mo = null;
        const keep = FIND_STATE.index;
        findCollect(FIND_STATE.query);
        if (FIND_STATE.ranges.length && keep >= 0) {
          FIND_STATE.index = Math.min(keep, FIND_STATE.ranges.length - 1);
          findPaint();
        }
      }, 220);
    }).observe(chat, { childList: true, subtree: true, characterData: true });
  }
})();

const SHORTCUT_DEFS = [
  { id: 'palette', label: '命令面板', group: '会话', def: 'mod+k' },
  { id: 'sidebar', label: '显示或隐藏侧边栏', group: '会话', def: 'mod+b' },
  { id: 'newTab', label: '新建会话页签', group: '会话', def: 'mod+t' },
  { id: 'viewChat', label: '切换到「对话」视图', group: '会话', def: 'mod+1' },
  { id: 'viewTrace', label: '切换到「轨迹」视图', group: '会话', def: 'mod+2' },
  { id: 'focusSearch', label: '会话内查找 / 会话搜索', group: '会话', def: 'mod+f' },
  { id: 'send', label: '发送（任意焦点）', group: '输入', def: 'mod+enter' },
  { id: 'copyLast', label: '复制上一条回复', group: '消息', def: 'mod+shift+c' },
  { id: 'help', label: '打开快捷键帮助', group: '其他', def: 'mod+/' },
  { id: 'terminal', label: '切换右侧终端栏', group: '其他', def: 'mod+`' },
];
const SHORTCUT_STORE_KEY = 'hermes.shortcuts';
const FIXED_COMBOS = Object.freeze({ escape: 'Escape', helpAlias: '?' });
const COMBO_RE = /^(?:mod\+)(?:alt\+)?(?:shift\+)?(?:[a-z0-9`\/,.;'[\]\\=-]|enter|space)$/;
const isMac = /mac/i.test((navigator.platform || '') + (navigator.userAgent || ''));

function validCombo(v) {
  return typeof v === 'string' && (COMBO_RE.test(v) || v === '?');
}
function cleanShortcuts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const used = new Set(Object.values(FIXED_COMBOS).map((s) => s.toLowerCase()));
  for (const d of SHORTCUT_DEFS) {
    const v = raw[d.id];
    if (!validCombo(v) || used.has(v.toLowerCase())) continue; // 冲突项直接丢弃，回落到默认值
    used.add(v.toLowerCase());
    out[d.id] = v;
  }
  return out;
}
function shortcutsRead() {
  let raw = null;
  try { raw = JSON.parse(safeGet(SHORTCUT_STORE_KEY) || '{}'); } catch {}
  return cleanShortcuts(raw);
}
let _shortcutCache = null;
function shortcutMap() {
  if (!_shortcutCache) {
    const saved = shortcutsRead();
    _shortcutCache = Object.fromEntries(SHORTCUT_DEFS.map((d) => [d.id, saved[d.id] || d.def]));
  }
  return _shortcutCache;
}
function shortcutsSave(patch) {
  const next = cleanShortcuts({ ...shortcutsRead(), ...(patch || {}) });
  const ok = safeSet(SHORTCUT_STORE_KEY, JSON.stringify(next));
  _shortcutCache = null; // 失效缓存，下一次按键立即用新映射
  return ok;
}
function comboFromEvent(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = (e.key || '').toLowerCase();
  if (k === ' ') k = 'space';
  if (['control', 'meta', 'alt', 'shift', 'dead'].includes(k)) return '';
  // '?' 是 shift+/ 的产物，作为固定别名直接归一化，避免记成 shift+?
  if (k === '?') return '?';
  parts.push(k);
  return parts.join('+');
}
function comboLabel(combo) {
  return String(combo || '').split('+').map((p) => ({
    mod: isMac ? '⌘' : 'Ctrl', alt: isMac ? '⌥' : 'Alt', shift: isMac ? '⇧' : 'Shift',
    enter: 'Enter', space: 'Space',
  }[p] || (/^[a-z]$/.test(p) ? p.toUpperCase() : p))).join(isMac ? ' ' : '+');
}
const SHORTCUT_ACTIONS = {
  palette: () => togglePalette($('#palette').hidden),
  sidebar: () => toggleSidebar(),
  newTab: () => newTab(),
  viewChat: () => setView('chat'),
  viewTrace: () => setView('trace'),
  focusSearch: () => {
    if (hasOpenTranscript()) { findOpen(); return; }
    setSidebar(true);
    const el = $('#session-search');
    if (el) el.focus();
  },
  send: () => send($('#input').value),
  copyLast: () => copyLastReply(),
  help: () => toggleHelp(),
  terminal: () => toggleTerminal(),
};

/** 录制态：点击设置页某个键位按钮后，下一次按键被这里优先捕获。 */
let shortcutCapture = null; // { id, onDone }
function beginShortcutCapture(id, onDone) {
  shortcutCapture = { id, onDone };
}
function endShortcutCapture() {
  const c = shortcutCapture; shortcutCapture = null; return c;
}

window.addEventListener('keydown', (e) => {
  // 录制优先于一切动作；Escape 取消，纯修饰键忽略
  if (shortcutCapture) {
    if (e.key === 'Escape') { e.preventDefault(); const c = endShortcutCapture(); if (c) c.onDone(null, '已取消'); return; }
    const combo = comboFromEvent(e);
    if (!combo) return;
    e.preventDefault(); e.stopPropagation();
    const c = endShortcutCapture();
    if (!c) return;
    if (!validCombo(combo) || combo === 'escape') { c.onDone(null, '该按键不能作为全局快捷键'); return; }
    const map = { ...shortcutMap() };
    const clash = SHORTCUT_DEFS.find((d) => d.id !== c.id && map[d.id].toLowerCase() === combo.toLowerCase());
    if (clash) { c.onDone(null, `与「${clash.label}」冲突`); return; }
    if (Object.values(FIXED_COMBOS).some((x) => x.toLowerCase() === combo.toLowerCase())) {
      c.onDone(null, '该按键已保留给系统'); return;
    }
    c.onDone(combo, '');
    return;
  }
  const combo = comboFromEvent(e);
  if (!combo) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')
    || !!(e.target && e.target.isContentEditable);
  const map = shortcutMap();
  const hit = SHORTCUT_DEFS.find((d) => map[d.id].toLowerCase() === combo.toLowerCase());
  if (hit && SHORTCUT_ACTIONS[hit.id]) {
    // '?' 只在非输入态生效，其余都带 mod，不会劫持打字
    if (combo !== '?' || !typing) { e.preventDefault(); SHORTCUT_ACTIONS[hit.id](); }
    return;
  }
  if (combo === '?' && !typing) { e.preventDefault(); toggleHelp(true); return; }
  if (e.key === 'Escape') {
    // 最上层是拖动：先撤拖动，不顺手关整页、也不中断回合
    if (KbDrag.on || KbDrag.armed) { kbDragReset(); return; }
    // 其次是看板的「⋯」菜单：它挂在页头，层级高于弹窗，只收它自己
    const kbMoreMenu = $('#kb-more-menu');
    if (kbMoreMenu && !kbMoreMenu.hidden) { kbMoreToggle(false); return; }
    // 统一按「最上层优先」收起：全部浮层关完后，若仍在生成则中断本回合
    let handled = false;
    // 查找条在最上层：先关它，不要顺手把下面的页面一起收掉
    if (FIND_STATE.open) { findClose(); handled = true; }
    if (!$('#help-modal').hidden) { toggleHelp(false); handled = true; }
    if (!$('#palette').hidden) { togglePalette(false); handled = true; }
    if (!$('#settings-page').hidden) { toggleSettings(false); handled = true; }
    // 消息平台页有独立开关，toggleSubpage 对它直接 return —— 走专用关闭函数
    document.querySelectorAll('.subpage').forEach((pg) => {
      if (pg.hidden) return;
      handled = true;
      if (pg.id === 'gateway-page') closeGatewayPage();
      else if (pg.id === 'kanban-page') {
        // 最上层优先：新建弹窗 → 抽屉内确认卡 → 详情抽屉 → 派发确认卡 → 派发面板 → 整页
        const drawerCard = document.querySelector('#kb-drawer-body .op-confirm');
        const dpCard = document.querySelector('#kb-dp-confirm .op-confirm');
        const dockCard = document.querySelector('#kb-dock-confirm .op-confirm');
        if (!$('#kb-modal').hidden) kbModalClose();
        else if (drawerCard) drawerCard.remove();
        else if (!$('#kb-drawer').hidden) closeKanbanDrawer();
        else if (dockCard) dockCard.remove();
        else if (dpCard) dpCard.remove();
        else if (!$('#kb-dispatch-panel').hidden) kbDispatchToggle(false);
        else closeKanbanPage();
      } else toggleSubpage(pg, false);
    });
    if (closeAllOverlays()) handled = true;
    if (!handled && activeTab() && activeTab().running) {
      e.preventDefault();
      $('#btn-stop').click(); // Escape 中断生成（Claude Code 行为）
    }
  }
});

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
  return `<article class="cat-card ${on ? 'on' : 'off'}" data-idx="${idx}">
    <div class="cat-top">
      <span class="cat-ico" style="background:${p.color}">${p.ico}</span>
      <div class="cat-title">
        <div class="cat-name"><span>${name}</span><span class="cat-badge ${on ? 'ok' : 'off'}">${on ? '已启用' : '已停用'}</span>${p.tag ? `<span class="cat-tag">${esc(p.tag)}</span>` : ''}</div>
        <div class="cat-key">${esc(p.meta || p.id)}</div>
      </div>
      <button class="plg-switch ${on ? 'on' : ''} ${p.pending ? 'pending' : ''}" title="${on ? '停用' : '启用'}" role="switch" aria-label="${on ? '停用' : '启用'} ${name}"></button>
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
  groups.innerHTML = names.map((g) => {
    const items = buckets.get(g).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return `<section class="cat-group"><div class="cat-group-label">${esc(g)} <span>${items.length}</span></div>` +
      `<div class="cat-grid">${items.map((d) => cardHTML(d, defs.indexOf(d), native, demoState[d.id])).join('')}</div></section>`;
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
    if (isNativeCLI()) await loadLive(kind, page, { force: true });
    else showSubpageList(page);
    if (sp) sp.hidden = true; if (g) g.hidden = false;
    toast(`${label}列表已刷新`, 1200);
  };
  const toggleMenu = () => { const m = page.querySelector('.pp-menu'); if (m) m.hidden = !m.hidden; };
  const addMain = page.querySelector('.pp-add-main'), addCaret = page.querySelector('.pp-add-caret');
  if (addMain) addMain.onclick = toggleMenu;
  if (addCaret) addCaret.onclick = toggleMenu;
  page.querySelectorAll('.pp-menu button').forEach((b) => {
    b.onclick = () => {
      page.querySelector('.pp-menu').hidden = true;
      const act = b.dataset.act;
      if (act === 'cmd') toast(`在终端 rail 或 hermes CLI 运行：${cmd} <path>`, 2600);
      else if (act === 'local') toast(`本地安装请按 hermes CLI 指引放置目录，然后点右上角刷新`, 2400);
      else openMarket(kind, page.id);
    };
  });
  // 搜索 / 过滤：只重绘卡片区，输入焦点不丢失
  const inp = page.querySelector('.pp-search-wrap input');
  const clear = page.querySelector('.pp-search-wrap button');
  if (inp) inp.addEventListener('input', () => { ui.search = inp.value; renderSubpageRows(page); });
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
function mkDetailHTML(it, idx) {
  const bits = [
    ['标识', it.id], ['来源', it.source], ['维护者', it.maintainer], ['分类', it.category],
    ['版本', it.version], ['Hermes 要求', it.requiresHermes],
  ].filter(([, v]) => v);
  const insp = mk.inspect.get(idx);
  const cmd = mk.kind === 'plugins'
    ? `hermes plugins install ${it.id} --no-enable --no-deps`
    : `hermes skills install ${it.id} --yes`;
  return `<div class="mk-detail">` +
    bits.map(([k, v]) => `<div><b>${esc(k)}：</b>${esc(v)}</div>`).join('') +
    `<div class="mk-sec-label">目录声明的能力</div>` +
    mkCapHTML(it.capabilities, false, mk.kind === 'skills' ? '技能搜索结果不含权限声明，请点「安装前预览」查看 SKILL.md' : '') +
    `<div style="margin-top:8px"><code>${esc(cmd)}</code> <button class="mk-btn" data-act="copy" data-cmd="${esc(cmd)}">复制</button></div>` +
    (insp ? `<div class="mk-review"><div class="mk-review-head"><b>安装前内容预览 · 只读</b>` +
      `<span>${esc(mk.kind === 'plugins' ? 'hermes plugins show' : 'hermes skills inspect')}</span></div>` +
      `<pre>${esc(insp)}</pre></div>` : '') +
    `</div>`;
}
function mkCardHTML(it, idx) {
  const installed = !!it.installed;
  const isPlugin = mk.kind === 'plugins';
  const trustCls = ['trusted', 'builtin', 'official', 'verified'].includes(it.trust) ? 'safe' : '';
  const meta = [it.source, it.category, it.maintainer, it.version].filter(Boolean).map(esc).join(' · ');
  const detail = mk.expanded.has(idx) ? mkDetailHTML(it, idx) : '';
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
  const armed = mk.armed.has(idx);
  return `<article class="mk-card ${mk.expanded.has(idx) ? 'expanded' : ''}" data-idx="${idx}">
    <div class="mk-card-top">
      <span class="mk-ico">${mk.kind === 'plugins' ? '⧉' : '✦'}</span>
      <div class="mk-card-title">
        <div class="mk-name"><span>${esc(it.name || it.id)}</span><span class="mk-trust ${trustCls}">${esc(it.trustLabel || '社区')}</span>${installed ? '<span class="mk-installed">已安装</span>' : ''}${mk.updates.has(it.name || it.id) ? '<span class="mk-upd">有更新</span>' : ''}</div>
        <div class="mk-id">${esc(it.id)}</div>
        ${(it.needsNewer || it.issues) ? `<div class="mk-flags">${it.needsNewer ? `<span class="mk-warn" title="该条目要求更新的 Hermes：${esc(it.needsNewer)}">需先升级 CLI</span>` : ''}${it.issues ? `<span class="mk-warn" title="目录标注了 ${it.issues} 条已知问题，安装前请点「安装前预览」查看">已知问题 ${it.issues}</span>` : ''}</div>` : ''}
      </div>
      ${installed ? '<button class="mk-btn" disabled>已安装</button>' : '<button class="mk-btn primary" data-act="install">安装</button>'}
    </div>
    <p class="mk-desc">${esc(it.description || '暂无描述')}</p>
    ${meta ? `<div class="mk-meta">${meta}</div>` : ''}
    <div class="mk-actions">
      <button class="mk-btn" data-act="detail">${mk.expanded.has(idx) ? '收起详情' : '详情'}</button>
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
    box.innerHTML = `<div class="mk-error">${esc(mk.error)}<code>hermes ${esc(cmd)}</code>` +
      `<div style="margin-top:10px;display:flex;gap:6px"><button class="mk-btn" data-act="copy" data-cmd="hermes ${esc(cmd)}">复制命令</button>` +
      `<button class="mk-btn" data-act="retry">重试</button></div></div>`;
    $('#mk-foot').textContent = '在线技能源需要网络；若 CLI 在终端能跑通，请检查网络代理后重试。可复制上方命令到终端验证。';
    return;
  }
  if (!mk.items.length) {
    box.innerHTML = '<div class="mk-empty">没有匹配的条目。换个关键词，或切换来源试试。</div>';
    $('#mk-foot').textContent = '';
    return;
  }
  const shown = mk.items.slice(0, mk.limit);
  box.innerHTML = shown.map((it, i) => mkCardHTML(it, i)).join('') +
    (mk.items.length > mk.limit
      ? `<button class="mk-chip" data-act="more" style="grid-column:1/-1;height:32px">显示更多（还有 ${mk.items.length - mk.limit} 条）</button>` : '');
  $('#mk-foot').textContent = `共 ${mk.items.length} 条 · 显示 ${shown.length} 条 · ${mk.ms}ms · 安装/卸载会调用 hermes CLI，完成后自动刷新本机列表`;
}
async function mkSearch(q, { force = false } = {}) {
  if (mk.busy) return;
  q = String(q == null ? '' : q).trim();
  mk.query = q; mk.error = ''; mk.limit = 48; mk.confirm = null; mk.armed.clear();
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
  try { r = await mkApi().marketSearch(mk.kind, q, { limit: 60, source: mk.source }); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  mk.busy = false; mk.skeleton = false;
  if (!r || !r.ok) {
    mk.error = (r && r.error) || '搜索失败'; mk.items = [];
    mkStatus('搜索失败', 'err');
  } else {
    mk.items = r.items || []; mk.ms = r.ms || 0;
    mkCache.set(key, { items: mk.items, ms: mk.ms });
    mkStatus(`${mk.items.length} 条结果 · ${mk.ms}ms`, '');
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
  mk.busy = true; mk.confirm = null; mk.armed.delete(idx);
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
    mk.inspect.set(idx, r.text || '（无输出）'); mk.expanded.add(idx);
    mkStatus(`${label}完成`, '');
  } else {
    if (op === 'install') { it.installed = true; mk.updates.delete(it.name || it.id); }
    if (op === 'uninstall') it.installed = false;
    mkCache.clear();
    mkStatus(`${label}完成：${it.name}`, '');
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
  // 详情与确认卡互斥：同时展开会把确认按钮推到 900px 以下，增加操作成本。
  if (act === 'install') {
    mk.expanded.delete(idx);
    mk.confirm = mk.confirm === idx ? null : idx;
    renderMarket(); return;
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
    if (mk.expanded.has(idx)) mk.expanded.delete(idx); else mk.expanded.add(idx);
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
    if (!mk.armed.has(idx)) { mk.armed.add(idx); renderMarket(); return; }
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
  });
}
// 插件 / 技能列表的后台刷新完成：重取一次（主进程内存已是最新，毫秒返回），
// 页面可见就原地重绘并保持滚动位置；不可见只更新数据，等下次打开直接渲新值。
if (hasNative && api.onCatalogUpdated) {
  api.onCatalogUpdated((p) => {
    const kind = p && p.kind === 'skills' ? 'skills' : 'plugins';
    const page = $(kind === 'skills' ? '#skills-page' : '#plugins-page');
    loadLive(kind, page, { quiet: true });
  });
}

/* ---------- 设置页（dsh 式大弹层：左导航 + 右面板 + 保存/取消） ----------
 * 分类注册表驱动：新增设置分类只需向 SETTINGS_CATEGORIES 追加描述符，
 * 渲染/脏检测/保存流程全部复用。存储经 SettingsStore 抽象——当前为
 * localStorage，接 hermes config.yaml 时替换 provider 即可，UI 不变。 */
const SETTINGS_CATEGORIES = [
  {
    id: 'general', label: '通用设置', ico: '⚙',
    groups: [
      { title: '权限', items: [
        { type: 'select', key: 'approvalMode', label: '新会话权限模式', hint: '选择新会话的默认审批模式', value: '工作区内修改',
          options: ['工作区内修改', '自动批准全部', '每次询问'] },
      ]},
      { title: '外观', bare: true, items: [
        { type: 'cards', key: 'theme', value: 'light', options: [
          { v: 'light', label: '浅色', ico: '☀' }, { v: 'dark', label: '深色', ico: '☾' }, { v: 'system', label: '跟随系统', ico: '🖥' },
        ]},
      ]},
      { title: '字体', items: [
        { type: 'stepper', key: 'fontSize', label: '字号大小', hint: '正文/输入框/信息行同步缩放，默认 16', value: 16, min: 10, max: 20, unit: 'px' },
      ]},
      { title: '行为', items: [
        { type: 'select', key: 'stepDetail', label: '工作步骤展示', hint: '选择希望看到多少工具调用细节', value: '详细', options: ['详细', '简洁'] },
        { type: 'toggle', key: 'streamThink', label: '流式思考', hint: '实时显示模型的思考过程（需上游已开启思考输出）', value: true },
        { type: 'action', key: 'reasoningUpstream', label: '上游思考输出', hint: '关闭时 CLI 一句推理都不下发，「思考过程」必然是空的',
          actionLabel: '检查', run: (row) => enableUpstreamReasoning(row) },
        { type: 'toggle', key: 'autoCollapse', label: '工作步骤收起时机', hint: '回答结束后自动收起工作步骤', value: true },
      ]},
    ],
  },
  {
    id: 'model', label: '模型', ico: '▤', custom: 'model',
    desc: '模型提供商与已配置模型来自 hermes CLI（providers.json / models.json）。',
  },
  {
    id: 'profile', label: 'Profile', ico: '◈', custom: 'profile',
    desc: '每个 profile 是一整套独立实例：各自的会话库、插件、技能、模型与凭证。切换后整个应用改用另一套。',
  },
  {
    id: 'shortcuts', label: '快捷键', ico: '⌨', custom: 'shortcuts',
    desc: '点击键位后按下新组合即可录制。必须带 ⌘ / Ctrl，Escape 与 ? 为系统保留键，冲突会被拒绝。',
  },
  {
    id: 'memory', label: '记忆', ico: '◈', custom: 'memory',
    desc: '只读查看 CLI 记忆状态与内置记忆文件；启停、重置等写操作仍以 hermes CLI 为准，桌面端不代劳。',
  },
  {
    id: 'tools', label: '工具集', ico: '⛭', custom: 'tools',
    desc: '控制 agent 在 CLI 平台能用哪些能力（shell、文件、浏览器等）。开关直接写 hermes CLI 配置，每次操作后回读确认，桌面端不缓存状态。',
  },
  {
    id: 'health', label: '健康检查', ico: '✚', custom: 'health',
    desc: '只读诊断，原样展示 CLI 输出；退出码非 0 有时只是「有建议」，不等于配置损坏。深度体检约 40 秒。',
  },
  {
    id: 'mcp', label: 'MCP 服务器', ico: '◇', custom: 'mcp',
    desc: '连接测试只读取不改动；添加会写入 CLI 的 config.yaml 并真实连接远端，移除需二次确认。增删的结果以 CLI 回读为准。',
  },
  {
    id: 'cron', label: '定时任务', ico: '◷', custom: 'cron',
    desc: '新建任务一律创建为暂停，不会立刻唤醒 agent 消耗额度；恢复、立即运行、移除都要二次确认。',
  },
  {
    id: 'kanban', label: '看板编排', ico: '◱', custom: 'kanban',
    desc: '看板卡片的自动处理方式。三档模式是 config.yaml 里两个开关的派生值；桌面端不缓存，每次打开都回读。',
  },
];
const SETTINGS_STORE_KEY = 'hermes.settings';
const SETTINGS_DEFAULTS = {
  theme: 'light', fontSize: 16, approvalMode: '工作区内修改',
  stepDetail: '详细', streamThink: true, autoCollapse: true,
};
const SETTINGS_ENUMS = {
  theme: ['light', 'dark', 'system'],
  approvalMode: ['工作区内修改', '自动批准全部', '每次询问'],
  stepDetail: ['详细', '简洁'],
};
/** 设置值会被拼进 innerHTML：类型 + 枚举 + 范围全部收敛，杜绝存储型 XSS，
 *  也防止被篡改的 localStorage 把任意 HTML 带进设置页。 */
function cleanSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, def] of Object.entries(SETTINGS_DEFAULTS)) {
    const v = raw[k];
    if (v === undefined || typeof v !== typeof def) continue;
    if (SETTINGS_ENUMS[k] && !SETTINGS_ENUMS[k].includes(v)) continue;
    if (k === 'fontSize' && (!Number.isFinite(v) || v < 10 || v > 20)) continue;
    out[k] = v;
  }
  return out;
}
function settingsRead() {
  let raw = null;
  try { raw = JSON.parse(safeGet(SETTINGS_STORE_KEY) || '{}'); } catch {}
  return cleanSettings(raw);
}
const SettingsStore = {
  get(k, fallback) { const s = settingsRead(); return s[k] !== undefined ? s[k] : fallback; },
  set(patch) {
    const next = { ...settingsRead(), ...cleanSettings(patch) };
    return safeSet(SETTINGS_STORE_KEY, JSON.stringify(next));
  },
  // 预留：接入 hermes config.yaml 时在此切换为 IPC provider，渲染层无需改动
};
let settingsCat = 'general';
let settingsDraft = {};      // 当前编辑中的值（key → value）
function settingsValue(key, fallback) {
  return settingsDraft[key] !== undefined ? settingsDraft[key] : SettingsStore.get(key, fallback);
}
function markSettingsDirty() { $('#set-save').classList.add('dirty'); $('#set-hint').textContent = '有未保存的更改'; }
function toggleSettings(show) {
  $('#settings-page').hidden = !show;
  if (show) {
    settingsDraft = {};
    $('#set-save').classList.remove('dirty');
    $('#set-hint').textContent = '更改需保存后生效';
    renderSettingsNav(); renderSettingsPanel();
    $('#set-panel').scrollTop = 0;
    // 预取两份「贵列表」：工具集 6.5–7.5s、MCP 约 2.5s。缓存命中时这两个调用
    // 是毫秒级（不会起子进程），过期才在后台重拉；用户点分类时通常已经就绪。
    if (isNativeCLI()) {
      try { api.toolsList(); api.mcpList(); } catch {}
    }
  }
}
function renderSettingsNav() {
  const nav = $('#set-nav'); nav.innerHTML = '';
  SETTINGS_CATEGORIES.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'set-nav-item' + (c.id === settingsCat ? ' active' : '');
    b.innerHTML = `<span class="set-nav-ico">${esc(c.ico)}</span>${esc(c.label)}`;
    b.onclick = () => { settingsCat = c.id; renderSettingsNav(); renderSettingsPanel(); };
    nav.appendChild(b);
  });
}
function setRow(label, hint, control) {
  const row = document.createElement('div'); row.className = 'set-row';
  row.innerHTML = `<div class="set-row-main"><div class="set-row-label">${esc(label)}</div>${hint ? `<div class="set-row-hint">${esc(hint)}</div>` : ''}</div>`;
  row.appendChild(control);
  return row;
}
function buildControl(c) {
  const val = () => settingsValue(c.key, c.value);
  if (c.type === 'select') {
    const wrap = document.createElement('button'); wrap.className = 'set-select';
    const render = () => { wrap.innerHTML = `${esc(val())} <span class="set-caret">▾</span>`; };
    render();
    wrap.onclick = () => {
      const menu = document.createElement('div'); menu.className = 'set-menu';
      c.options.forEach((o) => {
        const b = document.createElement('button');
        b.textContent = o; if (o === val()) b.classList.add('active');
        b.onclick = (e) => { e.stopPropagation(); settingsDraft[c.key] = o; markSettingsDirty(); render(); menu.remove(); };
        menu.appendChild(b);
      });
      document.body.appendChild(menu);
      const r = wrap.getBoundingClientRect();
      menu.style.left = Math.min(r.left, window.innerWidth - 190) + 'px';
      menu.style.top = r.bottom + 6 + 'px';
      const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    };
    return wrap;
  }
  if (c.type === 'toggle') {
    const sw = document.createElement('button');
    sw.className = 'plg-switch' + (val() ? ' on' : ''); sw.setAttribute('role', 'switch');
    sw.onclick = () => { sw.classList.toggle('on'); settingsDraft[c.key] = sw.classList.contains('on'); markSettingsDirty(); };
    return sw;
  }
  if (c.type === 'stepper') {
    const wrap = document.createElement('div'); wrap.className = 'set-stepper';
    const num = document.createElement('span'); num.className = 'set-step-num'; num.textContent = val();
    const unit = document.createElement('span'); unit.className = 'set-step-unit'; unit.textContent = c.unit || '';
    const minus = document.createElement('button'); minus.textContent = '−'; minus.setAttribute('aria-label', '减小字号');
    const plus = document.createElement('button'); plus.textContent = '＋'; plus.setAttribute('aria-label', '增大字号');
    const clamp = (v) => Math.min(c.max, Math.max(c.min, v));
    minus.onclick = () => { settingsDraft[c.key] = clamp((+num.textContent) - 1); num.textContent = settingsDraft[c.key]; markSettingsDirty(); };
    plus.onclick = () => { settingsDraft[c.key] = clamp((+num.textContent) + 1); num.textContent = settingsDraft[c.key]; markSettingsDirty(); };
    wrap.append(minus, num, unit, plus);
    return wrap;
  }
  if (c.type === 'cards') {
    const wrap = document.createElement('div'); wrap.className = 'set-cards';
    const render = () => {
      wrap.innerHTML = '';
      c.options.forEach((o) => {
        const card = document.createElement('button');
        card.className = 'set-card' + (o.v === val() ? ' active' : '');
        card.innerHTML = `<span class="set-card-ico">${esc(o.ico)}</span>${esc(o.label)}`;
        card.onclick = () => { settingsDraft[c.key] = o.v; markSettingsDirty(); render(); };
        wrap.appendChild(card);
      });
    };
    render();
    return wrap;
  }
  if (c.type === 'action') {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'mk-btn'; btn.textContent = c.actionLabel || '执行';
    btn.onclick = () => { if (typeof c.run === 'function') c.run(btn.closest('.set-row')); };
    return btn;
  }
  if (c.type === 'text') {
    const input = document.createElement('input');
    input.className = 'set-input'; input.value = val(); input.spellcheck = false;
    input.oninput = () => { settingsDraft[c.key] = input.value; markSettingsDirty(); };
    return input;
  }
  return document.createElement('div');
}
/* 异步 custom 面板的代次戳：切分类后旧 CLI 结果不得写进新面板。 */
let settingsPanelEpoch = 0;
function renderSettingsPanel() {
  const cat = SETTINGS_CATEGORIES.find((c) => c.id === settingsCat);
  const panel = $('#set-panel'); panel.innerHTML = '';
  settingsPanelEpoch++;
  // 底部栏是「保存到本地设置」的语义；自带「应用」按钮的面板会把它收起来，
  // 切回来时必须还原，否则别的分类会失去保存入口。
  const saveBtn = $('#set-save'), hintEl = $('#set-hint');
  if (saveBtn) saveBtn.hidden = false;
  if (hintEl && !(saveBtn && saveBtn.classList.contains('dirty'))) hintEl.textContent = '更改需保存后生效';
  if (cat.custom === 'model') { renderModelPanel(panel, cat); return; }
  if (cat.custom === 'profile') { renderProfilePanel(panel, cat); return; }
  if (cat.custom === 'shortcuts') { renderShortcutPanel(panel, cat); return; }
  if (cat.custom === 'memory') { renderMemoryPanel(panel, cat); return; }
  if (cat.custom === 'tools') { renderToolsPanel(panel, cat); return; }
  if (cat.custom === 'health') { renderHealthPanel(panel, cat); return; }
  if (cat.custom === 'mcp') { renderMcpPanel(panel, cat); return; }
  if (cat.custom === 'cron') { renderCronPanel(panel, cat); return; }
  if (cat.custom === 'kanban') { renderKanbanModePanel(panel, cat); return; }
  cat.groups.forEach((g) => {
    const gt = document.createElement('div'); gt.className = 'pp-group-label'; gt.textContent = g.title;
    panel.appendChild(gt);
    g.items.forEach((c) => {
      if (g.bare) { panel.appendChild(buildControl(c)); return; }
      panel.appendChild(setRow(c.label, c.hint, buildControl(c)));
    });
  });
}
/**
 * 设置页「默认模型」区块：状态对照 + 一键写入桌面端默认模型。
 * 置于「模型提供商」之前——先确认当前生效值，再看可用来源。
 * 只经 setModel → cfg:set 写 userData/config.json，绝不写 CLI 的 config.yaml。
 */
function buildDefaultModelBlock(ms, models) {
  const cliDefault = (ms && ms.defaultModel) || '';
  const rows = modelRows(ms, models, state.config.model);
  const block = document.createElement('section');
  block.className = 'dm-block';

  const title = document.createElement('div');
  title.className = 'pp-group-label'; title.textContent = '默认模型';
  block.appendChild(title);
  const desc = document.createElement('div');
  desc.className = 'set-desc dm-desc';
  desc.textContent = '桌面端默认模型保存在本机配置，新会话自动沿用；CLI 全局默认仅作对照，不会被修改。';
  block.appendChild(desc);

  const stateCard = document.createElement('div');
  stateCard.className = 'dm-state';
  stateCard.setAttribute('aria-live', 'polite');
  const mkRow = (label) => {
    const row = document.createElement('div'); row.className = 'dm-state-row';
    const k = document.createElement('span'); k.className = 'dm-state-k'; k.textContent = label;
    const v = document.createElement('span'); v.className = 'dm-state-v';
    const tag = document.createElement('span'); tag.className = 'dm-tag';
    row.append(k, v, tag);
    stateCard.appendChild(row);
    return { v, tag };
  };
  const curRow = mkRow('当前默认');
  const cliRow = mkRow('CLI 默认');
  block.appendChild(stateCard);

  const actions = document.createElement('div');
  actions.className = 'dm-actions';
  const label = document.createElement('label');
  label.className = 'dm-select-label'; label.textContent = '选择模型';
  const select = document.createElement('hm-select');
  select.className = 'dm-select';
  select.setAttribute('aria-label', '选择要设为默认模型的模型');
  const dmOptions = () => select.setOptions(rows.map((r) => ({
    value: r.key, label: r.tag ? `${r.name} · ${r.tag}` : r.name,
  })));
  dmOptions();
  label.appendChild(select);
  const setBtn = document.createElement('button');
  setBtn.type = 'button'; setBtn.className = 'mk-btn primary dm-set';
  setBtn.textContent = '设为默认模型';
  const follow = document.createElement('button');
  follow.type = 'button'; follow.className = 'dm-link';
  follow.textContent = '跟随 CLI 默认';
  actions.append(label, setBtn, follow);
  block.appendChild(actions);

  const note = document.createElement('div');
  note.className = 'dm-note';
  note.textContent = '点击后立即写入桌面端配置并同步顶部模型选择器；不会改动 CLI 配置文件。';
  block.appendChild(note);

  function sync() {
    const cur = state.config.model || '';
    const same = !!cliDefault && cur === cliDefault;
    curRow.v.textContent = cur || '未设置';
    curRow.tag.textContent = cur ? '已生效' : '未设置';
    curRow.tag.className = 'dm-tag' + (cur ? ' on' : '');
    cliRow.v.textContent = cliDefault || '不可读取';
    cliRow.tag.textContent = cliDefault ? (same ? '一致' : '不同') : '未知';
    cliRow.tag.className = 'dm-tag' + (same ? ' on' : (cliDefault ? ' warn' : ''));
    if (cur && !rows.some((r) => r.key === cur)) {
      rows.push({ key: cur, name: cur + ' · 当前配置' });
      dmOptions();
    }
    select.value = cur || cliDefault || (rows[0] ? rows[0].key : '');
    setBtn.disabled = !select.value;
    follow.disabled = !cliDefault || same;
  }
  setBtn.onclick = () => {
    const v = select.value;
    if (!v) return;
    setModel(v);
    sync();
    a11y('默认模型已设为 ' + v);
  };
  follow.onclick = () => {
    if (!cliDefault) return;
    select.value = cliDefault;
    setModel(cliDefault);
    sync();
    a11y('已跟随 CLI 默认模型 ' + cliDefault);
  };
  // 表单内 Escape 只失焦，不冒泡到全局（否则会关掉整个设置页 / 中断生成回合）
  guardFieldKey(select, () => select.blur());
  sync();
  return block;
}

async function renderModelPanel(panel, cat) {
  // 本面板是 async：切分类后旧响应不得写进同一个 #set-panel
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  // 三路只读并行（configModelState 是纯文件读取、零子进程），任一失败降级为空列表不阻断面板
  const [ms, provRes, modelRes] = await Promise.all([
    (isNativeCLI() && typeof api.configModelState === 'function')
      ? api.configModelState().catch(() => null) : Promise.resolve(null),
    isNativeCLI() ? api.configProviders().catch(() => null) : Promise.resolve(null),
    isNativeCLI() ? api.configModels().catch(() => null) : Promise.resolve(null),
  ]);
  if (!alive()) return;
  const providers = provRes && provRes.ok ? arr(provRes.providers) : [];
  const models = modelRes && modelRes.ok ? arr(modelRes.models) : [];

  panel.appendChild(buildDefaultModelBlock(ms, models));

  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">提供商</div><div class="set-desc">${cat.desc}</div>`;
  panel.appendChild(head);
  const list = document.createElement('div'); list.className = 'set-provider-list';
  panel.appendChild(list);
  if (!providers.length) {
    const empty = document.createElement('div'); empty.className = 'set-row';
    empty.innerHTML = `<div class="set-row-main"><div class="set-row-label">${isNativeCLI() ? '未找到模型提供商' : '演示模式'}</div><div class="set-row-hint">${isNativeCLI() ? '检查 ~/.hermes/providers.json 或通过 hermes CLI 登录配置' : '真机运行时此处展示 hermes 的模型提供商'}</div></div>`;
    list.appendChild(empty);
  } else {
    providers.forEach((p) => {
      const count = models.filter((m) => m.provider === p.name).length;
      const row = document.createElement('div'); row.className = 'set-provider';
      row.innerHTML = `
        <span class="set-provider-dot"></span>
        <span class="set-provider-main">
          <span class="set-provider-name">${esc(p.name)}</span>
          <span class="set-provider-hint">${esc(p.baseUrl || '')}${count ? ` · ${count} 个模型` : ''}</span>
        </span>
        <button class="set-provider-edit">编辑</button>`;
      row.querySelector('.set-provider-edit').onclick = () => toast(`编辑提供商请运行 hermes CLI（providers 配置存储于 providers.json）`, 2400);
      list.appendChild(row);
    });
  }
  const add = document.createElement('button'); add.className = 'set-add-provider'; add.textContent = '＋ 添加模型提供商';
  add.onclick = () => toast('请通过 hermes CLI 配置提供商（hermes login / config.yaml）', 2400);
  panel.appendChild(add);
}
/* ---------- 设置页：快捷键自定义（立即生效，独立存储） ---------- */
function shortcutsReset() {
  const ok = safeSet(SHORTCUT_STORE_KEY, '{}');
  _shortcutCache = null;
  return ok;
}
function renderShortcutPanel(panel, cat) {
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">键盘快捷键</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const map = shortcutMap();
  const groups = [...new Set(SHORTCUT_DEFS.map((d) => d.group))];
  groups.forEach((g) => {
    const gt = document.createElement('div'); gt.className = 'pp-group-label'; gt.textContent = g;
    panel.appendChild(gt);
    SHORTCUT_DEFS.filter((d) => d.group === g).forEach((d) => {
      const row = document.createElement('div'); row.className = 'set-row';
      row.innerHTML = `<div class="set-row-main"><div class="set-row-label">${esc(d.label)}</div>` +
        `<div class="set-row-hint">默认 ${esc(comboLabel(d.def))}</div></div>`;
      const wrap = document.createElement('div'); wrap.className = 'sk-control';
      const btn = document.createElement('button');
      btn.className = 'sk-key'; btn.type = 'button';
      btn.textContent = comboLabel(map[d.id]);
      btn.setAttribute('aria-label', `${d.label}，当前 ${comboLabel(map[d.id])}，点击录制新快捷键`);
      btn.onclick = () => {
        if (shortcutCapture) return;
        btn.classList.add('capturing'); btn.textContent = '请按组合键…';
        beginShortcutCapture(d.id, (combo, err) => {
          if (combo) shortcutsSave({ [d.id]: combo });
          if (err) toast(err, 2400);
          else toast(`${d.label} → ${comboLabel(combo)}`, 1800);
          renderSettingsPanel(); // 重绘以反映新键位 / 取消状态
          renderHelp(true);      // 帮助页同步，不残留旧键位
        });
      };
      const reset = document.createElement('button');
      reset.className = 'sk-reset'; reset.type = 'button';
      reset.textContent = '恢复默认'; reset.title = `恢复为 ${comboLabel(d.def)}`;
      reset.disabled = map[d.id] === d.def;
      reset.onclick = () => {
        const next = { ...shortcutsRead() }; delete next[d.id];
        shortcutsSave(next);
        renderSettingsPanel(); renderHelp(true);
        toast(`${d.label} 已恢复默认`, 1600);
      };
      wrap.append(btn, reset);
      row.appendChild(wrap);
      panel.appendChild(row);
    });
  });
  const foot = document.createElement('div'); foot.className = 'sk-foot';
  const note = document.createElement('span');
  note.textContent = '修改立即生效并保存在本机；Escape 保留给浮层关闭与中断生成，? 保留给帮助。';
  const all = document.createElement('button');
  all.type = 'button'; all.className = 'sk-reset'; all.textContent = '全部恢复默认';
  all.onclick = () => { shortcutsReset(); renderSettingsPanel(); renderHelp(true); toast('快捷键已全部恢复默认', 1600); };
  foot.append(note, all);
  panel.appendChild(foot);
}

/* ---------- 设置页：记忆（只读诊断 + 文件元信息，无写操作） ---------- */
async function renderMemoryPanel(panel, cat) {
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">记忆状态</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const statusBox = document.createElement('div'); statusBox.className = 'mem-status';
  statusBox.textContent = isNativeCLI() ? '正在读取…' : '演示模式：需要桌面端原生环境读取 CLI 记忆状态。';
  panel.appendChild(statusBox);
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新 CLI 状态';
  refresh.disabled = !isNativeCLI();
  refresh.onclick = async () => {
    refresh.disabled = true; statusBox.textContent = '正在执行只读诊断（hermes memory status）…';
    try {
      const r = await api.diagnosticsRun('memory:status');
      statusBox.textContent = r && r.text ? r.text : (r && r.error) || 'CLI 未返回内容';
      statusBox.classList.toggle('is-error', !(r && r.ok));
    } catch (e) { statusBox.textContent = '读取失败：' + (e && e.message ? e.message : e); statusBox.classList.add('is-error'); }
    refresh.disabled = false;
  };
  panel.appendChild(refresh);

  const fTitle = document.createElement('div'); fTitle.className = 'pp-group-label'; fTitle.textContent = '内置记忆文件';
  panel.appendChild(fTitle);
  const list = document.createElement('div'); list.className = 'mem-files';
  list.innerHTML = '<div class="set-row-hint">正在读取…</div>';
  panel.appendChild(list);
  const note = document.createElement('div'); note.className = 'pf-note';
  note.innerHTML = `内置记忆（<code>MEMORY.md</code> / <code>USER.md</code>）由 hermes CLI 始终启用；` +
    `外部记忆 provider 的启停、配置与重置是交互式写操作，桌面端不代劳，请在终端执行 ` +
    `<code>hermes memory setup|off|reset</code>。此页只读取状态与文件元信息，不读取记忆正文、不改动任何文件。`;
  panel.appendChild(note);

  let files = [];
  if (isNativeCLI()) {
    try { const r = await api.diagnosticsMemoryFiles(); if (r && r.ok) files = arr(r.files); } catch {}
  }
  list.innerHTML = '';
  if (!files.length) {
    list.innerHTML = '<div class="set-row-hint">未读取到记忆文件信息。</div>';
  } else {
    files.forEach((f) => {
      const row = document.createElement('div'); row.className = 'set-row';
      const when = f.mtime ? new Date(f.mtime).toLocaleString('zh-CN') : '—';
      row.innerHTML = `<div class="set-row-main"><div class="set-row-label">${esc(f.name)}</div>` +
        `<div class="set-row-hint">${f.exists ? `${fmtBytes(f.bytes)} · 更新于 ${esc(when)}` : '尚未创建'}</div></div>`;
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'sk-reset'; open.textContent = '打开文件';
      open.disabled = !f.exists || !isNativeCLI();
      open.onclick = async () => {
        const key = f.name === 'MEMORY.md' ? 'memoryMd' : 'userMd';
        const r = await api.configOpenFile(key);
        if (!r || !r.ok) toast((r && r.error) || '打开失败', 2200);
      };
      row.appendChild(open);
      list.appendChild(row);
    });
  }
  // 打开设置页即拉取一次只读状态，不阻塞其它分区
  if (isNativeCLI()) refresh.click();
}

/* ---------- 设置页：工具集开关（CLI 为准，操作后回读） ----------
   只展示 / 只修改 cli 平台分段：`hermes tools list` 在接入 telegram、discord 后
   会多出同名分段，那些开关必须留给对应平台的设置，桌面端不代劳。
   开关不做「乐观更新后就不管」：失败把开关拨回去并提示；成功用 CLI 回读的
   真实状态重绘，避免界面与配置文件不一致（CLI 静默失败时最容易出现这种幻觉）。 */
function toolRow(item, onToggle) {
  const row = document.createElement('div'); row.className = 'set-row';
  const main = document.createElement('div'); main.className = 'set-row-main';
  const label = document.createElement('div'); label.className = 'set-row-label';
  // label 来自 CLI 输出（含 emoji），一律走 textContent，不进 innerHTML
  label.textContent = item.label || item.name;
  const hint = document.createElement('div'); hint.className = 'set-row-hint';
  hint.textContent = item.name;
  main.append(label, hint);
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'plg-switch' + (item.enabled ? ' on' : '');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', item.enabled ? 'true' : 'false');
  sw.setAttribute('aria-label', (item.label || item.name) + ' 开关');
  sw.onclick = () => onToggle(item, sw);
  row.append(main, sw);
  return row;
}
async function renderToolsPanel(panel, cat) {
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">工具集 · CLI 平台</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const status = document.createElement('div'); status.className = 'mem-status';
  status.textContent = isNativeCLI() ? '正在读取工具列表…' : '演示模式：需要桌面端原生环境读取 CLI 工具列表。';
  panel.appendChild(status);
  const list = document.createElement('div'); list.className = 'tool-list';
  panel.appendChild(list);
  const note = document.createElement('div'); note.className = 'pf-note';
  note.innerHTML = '开关等同 <code>hermes tools enable|disable &lt;name&gt;</code>（默认 cli 平台）。' +
    '关闭 <code>terminal</code> / <code>file</code> 后 agent 将无法执行命令或改文件，请谨慎操作。' +
    '其它平台（Telegram / Discord 等）的工具集不在此页展示。';
  panel.appendChild(note);

  let others = [];
  let staleNow = false;
  const draw = (sections) => {
    list.innerHTML = '';
    const total = (sections || []).reduce((n, s) => n + s.items.length, 0);
    const on = (sections || []).reduce((n, s) => n + s.items.filter((i) => i.enabled).length, 0);
    status.textContent = `已启用 ${on}/${total}` + (others.length
      ? `（另有 ${others.join(' / ')} 平台的工具集未在此展示）` : '') +
      (staleNow ? ' · 后台刷新中' : '');
    status.classList.remove('is-error');
    if (!sections || !sections.length) {
      list.innerHTML = '<div class="set-row-hint">未读取到工具集。</div>';
      return;
    }
    sections.forEach((sec) => {
      const gt = document.createElement('div'); gt.className = 'pp-group-label';
      gt.textContent = `${sec.title}（${sec.items.filter((i) => i.enabled).length}/${sec.items.length} 已启用）`;
      list.appendChild(gt);
      sec.items.forEach((item) => list.appendChild(toolRow(item, toggle)));
    });
  };

  let busy = false;
  async function toggle(item, sw) {
    if (busy) return;
    busy = true;
    const next = !sw.classList.contains('on');
    const prev = sw.classList.contains('on');
    // 先给即时反馈，结果回来再对齐
    sw.classList.toggle('on', next);
    sw.setAttribute('aria-checked', next ? 'true' : 'false');
    sw.disabled = true;
    try {
      const r = await api.toolsToggle(item.name, next);
      if (r && r.ok) {
        toast(`${item.label || item.name} 已${r.enabled ? '启用' : '停用'}`, 1600);
        if (r.sections) draw(r.sections);
      } else {
        sw.classList.toggle('on', prev);
        sw.setAttribute('aria-checked', prev ? 'true' : 'false');
        toast(`操作失败：${(r && r.error) || '未知错误'}`, 3200);
        if (r && r.sections) draw(r.sections);
      }
    } catch (e) {
      sw.classList.toggle('on', prev);
      toast('操作失败：' + ((e && e.message) || e), 3000);
    }
    sw.disabled = false;
    busy = false;
  }

  let r = null;
  if (isNativeCLI()) {
    status.textContent = '正在读取工具列表…';
    try { r = await api.toolsList(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  }
  if (!isNativeCLI()) { status.textContent = '演示模式：不做 CLI 调用。'; return; }
  if (!r || !r.ok) {
    status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
    status.classList.add('is-error');
    return;
  }
  others = arr(r.otherPlatforms);
  staleNow = !!r.stale;
  draw(r.sections);
  // 后台刷新完成：重取一次（主进程内存已最新，毫秒返回）并原地重绘
  subscribeCatalog((p) => {
    if (!p || p.kind !== 'tools' || !panel.isConnected) return;
    api.toolsList().then((rr) => {
      if (!rr || !rr.ok || !panel.isConnected) return;
      others = arr(rr.otherPlatforms);
      staleNow = !!rr.stale;
      draw(rr.sections);
    }).catch(() => {});
  });
}

/* ---------- 设置页：MCP 服务器 / 定时任务 ----------
   两者都完全以 hermes CLI 为真源。危险写操作统一走「内联确认卡」：
   先明示将执行的 CLI 命令与影响，二次点击才下发；所有来自 CLI 的文本
   一律走 textContent，不进 innerHTML。异步结果用 settingsPanelEpoch 作废旧响应。 */

/** 危险操作的内联确认卡。返回插入的 DOM，取消即移除，不改动任何数据。 */
function opConfirm(host, { title, cmd, note, confirmLabel = '确认执行', onGo }) {
  host.querySelectorAll('.op-confirm').forEach((n) => n.remove());
  const box = document.createElement('div');
  box.className = 'op-confirm';
  const h = document.createElement('div'); h.className = 'op-confirm-title'; h.textContent = title;
  const pre = document.createElement('code'); pre.className = 'op-confirm-cmd'; pre.textContent = cmd;
  const p = document.createElement('p'); p.className = 'op-confirm-note'; p.textContent = note;
  const btns = document.createElement('div'); btns.className = 'op-confirm-btns';
  const go = document.createElement('button');
  go.type = 'button'; go.className = 'mk-btn primary'; go.textContent = confirmLabel;
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'mk-btn'; cancel.textContent = '取消';
  cancel.onclick = () => box.remove();
  go.onclick = async () => { box.remove(); await onGo(); };
  btns.append(go, cancel);
  box.append(h, pre, p, btns);
  host.appendChild(box);
  try { go.focus({ preventScroll: true }); } catch { /* 已卸载 */ }
  return box;
}

/**
 * 「上游思考输出」：CLI 的 display.show_reasoning 为 false 时，网关一条 reasoning.delta
 * 都不会发（`agent_callbacks._emit_reasoning_delta` 直接短路），桌面端不可能凭空显示思考；
 * 之前的「思考过程」块里其实是 thinking.delta 的颜文字等待提示，所以看起来是空的。
 *
 * 这里只读状态 → 需要时出二次确认卡 → 调 `hermes config set display.show_reasoning`。
 * 写的是 CLI 配置（命令行同样受影响），因此只能由用户点卡确认，绝不自动执行。
 */
async function enableUpstreamReasoning(host) {
  if (!isNativeCLI() || typeof api.reasoningDisplay !== 'function') {
    toast('仅桌面版可读写 CLI 配置', 2400); return;
  }
  let st = null;
  try { st = await api.reasoningDisplay(); }
  catch (e) { st = { ok: false, error: String((e && e.message) || e) }; }
  if (!st || !st.ok) { toast('读取 CLI 配置失败：' + ((st && st.error) || '未知错误'), 3200); return; }
  if (st.enabled) { toast('上游已开启思考输出（display.show_reasoning: true）', 2800); return; }
  const cardHost = (host && (host.querySelector('.set-row-main') || host)) || $('#set-panel');
  opConfirm(cardHost, {
    title: '打开 CLI 的思考输出？',
    cmd: 'hermes config set display.show_reasoning true',
    note: `将写入 ${st.configPath} 的 display.show_reasoning: true。这一项同时决定命令行（hermes CLI / TUI）是否显示思考过程；`
      + '已经打开的会话仍按旧值运行，需要新开一个会话（⌘N）才会拿到思考内容。',
    confirmLabel: '写入并打开',
    onGo: async () => {
      let r = null;
      try { r = await api.setReasoningDisplay(true); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || !r.ok) { toast('写入失败：' + ((r && r.error) || '未知错误'), 3600); return; }
      toast('已打开思考输出 · 新开会话（⌘N）后即可看到', 4000);
    },
  });
}

/** 表单输入里的 Escape 只收起本表单，不冒泡到全局（否则会关掉整个设置页）。 */function guardFieldKey(el, onEscape) {
  el.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onEscape(); }
  };
}
function fieldRow(label, hint, input) {
  const wrap = document.createElement('div'); wrap.className = 'op-field';
  const lab = document.createElement('label'); lab.className = 'op-field-label'; lab.textContent = label;
  const inp = input;
  lab.appendChild(inp);
  wrap.appendChild(lab);
  if (hint) { const h = document.createElement('div'); h.className = 'op-field-hint'; h.textContent = hint; wrap.appendChild(h); }
  return wrap;
}
function textField(placeholder, maxLength) {
  const i = document.createElement('input');
  i.type = 'text'; i.className = 'set-input op-input'; i.placeholder = placeholder;
  i.spellcheck = false; i.maxLength = maxLength || 120;
  return i;
}

/* ---------------- MCP 服务器 ---------------- */
async function renderMcpPanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">MCP 服务器</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);

  const bar = document.createElement('div'); bar.className = 'op-bar';
  const status = document.createElement('div'); status.className = 'mem-status';
  status.textContent = isNativeCLI() ? '正在读取服务器列表…' : '演示模式：需要桌面端原生环境读取 MCP 配置。';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新';
  bar.append(status, refresh); panel.appendChild(bar);

  const list = document.createElement('div'); list.className = 'op-list'; panel.appendChild(list);

  const addWrap = document.createElement('div'); addWrap.className = 'op-form';
  const addTitle = document.createElement('div'); addTitle.className = 'pp-group-label'; addTitle.textContent = '添加服务器（URL）';
  addWrap.appendChild(addTitle);
  const nameIn = textField('名称，如 my-server', 64);
  const urlIn = textField('https://… 或 http://127.0.0.1:端口/…', 300);
  const timeoutIn = textField('连接超时（秒，1–60）', 3); timeoutIn.value = '10';
  const addBtns = document.createElement('div'); addBtns.className = 'op-form-btns';
  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'mk-btn primary'; addBtn.textContent = '添加';
  const addClear = document.createElement('button');
  addClear.type = 'button'; addClear.className = 'mk-btn'; addClear.textContent = '清空';
  addBtns.append(addBtn, addClear);
  addWrap.append(fieldRow('名称', '只允许字母、数字、_ . -；会作为 config.yaml 的键。', nameIn),
    fieldRow('地址', '仅 https 或本机 http。添加时会真实连接并发现工具，工具默认全部启用。', urlIn),
    fieldRow('连接超时', '', timeoutIn), addBtns);
  guardFieldKey(nameIn, () => addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(urlIn, () => addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(timeoutIn, () => addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  addClear.onclick = () => { nameIn.value = ''; urlIn.value = ''; timeoutIn.value = '10'; addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()); };
  panel.appendChild(addWrap);

  const note = document.createElement('div'); note.className = 'pf-note';
  note.textContent = '仅提供 URL 型接入。stdio 型（--command/--args）、OAuth 登录与工具筛选是 CLI 的交互式流程，请在终端用 hermes mcp add / login / configure 完成。移除会改写 CLI 的 config.yaml，其它平台不受影响。';
  panel.appendChild(note);

  let servers = [];
  let staleNow = false;
  const draw = () => {
    list.innerHTML = '';
    const on = servers.filter((s) => s.enabled).length;
    status.textContent = `已配置 ${servers.length} 个 · 启用 ${on} 个` + (staleNow ? ' · 后台刷新中' : '');
    status.classList.remove('is-error');
    if (!servers.length) {
      const empty = document.createElement('div'); empty.className = 'op-empty';
      empty.textContent = '尚未配置 MCP 服务器。'; list.appendChild(empty); return;
    }
    servers.forEach((s) => list.appendChild(mcpCard(s)));
  };

  function mcpCard(s) {
    const card = document.createElement('div'); card.className = 'op-card';
    const top = document.createElement('div'); top.className = 'op-card-top';
    const name = document.createElement('span'); name.className = 'op-name'; name.textContent = s.name;
    const badge = document.createElement('span');
    badge.className = 'op-badge' + (s.enabled ? ' on' : '');
    badge.textContent = s.enabled ? '已启用' : '已停用';
    top.append(name, badge);
    const meta = document.createElement('div'); meta.className = 'op-meta';
    const tr = document.createElement('code'); tr.className = 'op-code'; tr.textContent = s.transport;
    const tools = document.createElement('span'); tools.textContent = '工具 ' + s.tools;
    meta.append(tr, tools);
    const acts = document.createElement('div'); acts.className = 'op-acts';
    const testBtn = document.createElement('button');
    testBtn.type = 'button'; testBtn.className = 'mk-btn'; testBtn.textContent = '测试连接';
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'mk-btn danger'; delBtn.textContent = '移除';
    acts.append(testBtn, delBtn);
    const out = document.createElement('div'); out.className = 'op-out'; out.hidden = true;
    card.append(top, meta, acts, out);

    testBtn.onclick = async () => {
      if (!isNativeCLI()) { toast('演示模式不可用', 1800); return; }
      testBtn.disabled = true; testBtn.textContent = '测试中…';
      out.hidden = false; out.textContent = '正在连接并发现工具（最多 60 秒）…';
      let r;
      try { r = await api.mcpTest(s.name); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!alive()) return;
      testBtn.disabled = false; testBtn.textContent = '测试连接';
      out.textContent = '';
      if (!r || !r.ok) { out.textContent = '测试失败：' + ((r && r.error) || '未知错误'); out.classList.add('is-error'); return; }
      out.classList.remove('is-error');
      const line = document.createElement('div'); line.className = 'op-out-head';
      line.textContent = r.connected
        ? `✓ 连接成功 · ${r.latencyMs == null ? '' : r.latencyMs + 'ms · '}${r.toolCount} 个工具`
        : '✗ 未连接';
      out.appendChild(line);
      if (r.transport) { const t = document.createElement('div'); t.textContent = r.transport; out.appendChild(t); }
      if (r.tools && r.tools.length) {
        const pre = document.createElement('pre'); pre.className = 'op-pre'; pre.textContent = r.tools.join('\n');
        out.appendChild(pre);
      }
      if (r.error) { const e = document.createElement('div'); e.textContent = r.error; out.appendChild(e); }
    };
    delBtn.onclick = () => opConfirm(card, {
      title: `移除「${s.name}」？`,
      cmd: `hermes -p <current> mcp remove ${s.name}`,
      note: '会从 CLI 的 config.yaml 删除该服务器，正在使用它的会话需要重开才生效。此操作不可撤销。',
      confirmLabel: '确认移除',
      onGo: async () => { await applyWrite(() => api.mcpRemove(s.name), '已移除', '移除失败'); },
    });
    return card;
  }

  async function applyWrite(fn, okMsg, failMsg) {
    if (!isNativeCLI()) { toast('演示模式不可用', 1800); return false; }
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return false;
    if (!r || !r.ok) { toast(`${failMsg}：${(r && r.error) || '未知错误'}`, 3400); return false; }
    if (Array.isArray(r.servers)) { servers = r.servers; draw(); }
    else { await reload(); }
    toast(r.warning || okMsg, r.warning ? 3200 : 1600);
    return true;
  }

  addBtn.onclick = () => opConfirm(addWrap, {
    title: '添加一个 MCP 服务器？',
    cmd: `hermes -p <current> mcp add ${nameIn.value.trim() || '<name>'} --url ${urlIn.value.trim() || '<url>'}`,
    note: '会写入 CLI 的 config.yaml 并真实连接该地址、发现工具（默认全部启用）。连接失败时 CLI 默认不保存配置。请确认来源可信。',
    confirmLabel: '确认添加',
      onGo: () => applyWrite(() => api.mcpAdd({
        name: nameIn.value.trim(), url: urlIn.value.trim(), connectTimeout: Number(timeoutIn.value),
      }), '已添加', '添加失败').then((ok) => {
        if (ok) { nameIn.value = ''; urlIn.value = ''; timeoutIn.value = '10'; }
      }),
  });

  async function reload(opts = {}) {
    if (!isNativeCLI()) { status.textContent = '演示模式：不做 CLI 调用。'; return; }
    status.textContent = opts.force ? '正在重新读取 MCP 服务器（约 2–3 秒）…' : '正在读取 MCP 服务器…';
    let r;
    try { r = await api.mcpList(opts); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error'); return;
    }
    servers = arr(r.servers);
    staleNow = !!r.stale;
    draw();
    if (r.warning) toast(`列表刷新失败，显示上次结果：${r.warning}`, 3200);
  }
  refresh.onclick = () => reload({ force: true });
  await reload();
  // 后台刷新完成：重取缓存里的新列表并重绘（不阻塞、不闪）
  subscribeCatalog((p) => {
    if (!p || p.kind !== 'mcp' || !alive()) return;
    api.mcpList().then((rr) => {
      if (!rr || !rr.ok || !alive()) return;
      servers = arr(rr.servers);
      staleNow = !!rr.stale;
      draw();
    }).catch(() => {});
  });
}

/* ---------------- 定时任务 ---------------- */
/**
 * 设置页「看板编排」：三档模式的唯一入口。
 *
 * 这里写的是 hermes CLI 的 config.yaml（kanban 段），改的是 gateway 的自动派发 ——
 * 不只是本应用，所以每次改动都过二次确认卡，并把「要不要重启」如实写在结果里。
 * 模式本身不存储：它是 auto_decompose / dispatch_in_gateway 两个布尔的派生值。
 */
async function renderKanbanModePanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;

  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">看板编排</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);

  // 底部那个「保存」写的是本地 localStorage，对编排开关无效 —— 收起来，
  // 只留面板内的「应用」这一个写入口，两个入口会让人不知道该按哪个。
  const saveBtn = $('#set-save'), hintEl = $('#set-hint');
  if (saveBtn) saveBtn.hidden = true;
  if (hintEl) hintEl.textContent = '此页的改动点「应用」才写入 CLI 配置';

  const bar = document.createElement('div'); bar.className = 'op-bar';
  const status = document.createElement('div'); status.className = 'mem-status';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新';
  bar.append(status, refresh); panel.appendChild(bar);

  const stage = document.createElement('div'); panel.appendChild(stage);

  const note = document.createElement('div'); note.className = 'pf-note';
  note.textContent = '写的是 hermes CLI 的 config.yaml（kanban 段），影响 gateway 的自动派发，不只是这个应用。'
    + '自动分解每轮重读，下一轮 tick 就生效；派发器开关只在 gateway 启动时读一次，改完必须重启 gateway。';
  panel.appendChild(note);

  let state = null;   // 最近一次回读的生效值
  let pick = null;    // 用户选中但未应用的档位
  let busy = false;

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button'; applyBtn.className = 'mk-btn primary'; applyBtn.textContent = '应用';
  const actions = document.createElement('div'); actions.className = 'kbm-actions';
  const hint = document.createElement('div'); hint.className = 'set-row-hint';
  actions.append(applyBtn, hint);

  /** 会写进 config.yaml 的键值，逐行列出（不是假命令行，是真的键）。 */
  const planLines = (modeId) => {
    const m = state && state.modes ? state.modes.find((x) => x.id === modeId) : null;
    if (!m) return '';
    const lines = [];
    if (state.autoDecompose !== m.decompose) lines.push(`kanban.auto_decompose = ${m.decompose}`);
    if (state.dispatchInGateway !== m.dispatch) lines.push(`kanban.dispatch_in_gateway = ${m.dispatch}`);
    return lines.length ? lines.join('\n') : '（与当前一致，不会有任何写入）';
  };

  const draw = () => {
    stage.innerHTML = '';
    if (!state) { status.textContent = '当前模式读取失败'; return; }
    const sw = [];
    sw.push(`派发器${state.dispatchInGateway ? '运行中' : '已停止'}`);
    sw.push(`自动分解${state.autoDecompose ? '开' : '关'}`);
    if (state.autoPromoteChildren) sw.push('子任务自动推进开');
    status.textContent = `${state.modeLabel} · ${sw.join(' · ')}`;
    status.classList.remove('is-error');

    const group = document.createElement('div');
    group.className = 'kbm-list';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', '看板编排模式');
    (state.modes || []).forEach((m) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'kbm-card' + (m.id === pick ? ' on' : '');
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', m.id === pick ? 'true' : 'false');
      card.dataset.mode = m.id;
      // 远端 / 档位文案一律 textContent，绝不拼进 innerHTML
      const name = document.createElement('b'); name.textContent = m.label;
      const sum = document.createElement('span'); sum.textContent = m.summary;
      card.append(name, sum);
      if (m.id === pick) {
        const det = document.createElement('em'); det.textContent = m.detail;
        card.appendChild(det);
        if (m.needsRestart) {
          const warn = document.createElement('em'); warn.className = 'kbm-warn';
          warn.textContent = '这一档关掉的是 gateway 里的派发器，改完必须重启 gateway 才生效。';
          card.appendChild(warn);
        }
      }
      card.onclick = () => { if (busy) return; pick = m.id; draw(); };
      group.appendChild(card);
    });
    stage.appendChild(group);
    // 操作紧跟在卡片后面：三张卡 + 「应用」要能在首屏同时看到，
    // 生效值明细是可以滚着看的次要信息，不能把它们顶到折叠线以下。
    stage.appendChild(actions);

    // 明细是「现在生效的值」，不是「改完会变成的值」—— 不标清楚，
    // 选了全手动却看到 auto_decompose=开，会以为没生效。
    const factsLabel = document.createElement('div');
    factsLabel.className = 'set-row-hint';
    factsLabel.textContent = '当前生效值（不含尚未应用的改动）';
    stage.appendChild(factsLabel);

    const facts = document.createElement('div'); facts.className = 'kbm-facts';
    const rows = [
      ['自动分解', 'auto_decompose', state.autoDecompose ? '开' : '关', '下一轮 tick 生效'],
      ['派发器', 'dispatch_in_gateway', state.dispatchInGateway ? '开' : '关', '改动需重启 gateway'],
      ['子任务自动推进', 'auto_promote_children', state.autoPromoteChildren ? '开' : '关', ''],
      ['默认受让人', 'default_assignee', state.resolvedAssignee || state.defaultAssignee || '（跟随当前 profile）', ''],
    ];
    rows.forEach(([label, key, val, tip]) => {
      const r = document.createElement('div');
      const a = document.createElement('b'); a.textContent = label;
      const b = document.createElement('span'); b.textContent = key;
      const c = document.createElement('i'); c.textContent = val;
      r.append(a, b, c);
      if (tip) { const t = document.createElement('u'); t.textContent = tip; r.appendChild(t); }
      facts.appendChild(r);
    });
    stage.appendChild(facts);

    if (state.decomposeStranded) {
      const warn = document.createElement('div'); warn.className = 'kbm-warn';
      warn.textContent = '自动分解还开着，但派发器已停 —— 分解出来的卡只会堆在就绪队列里没人认领。';
      stage.appendChild(warn);
    }
    if (state.degraded) {
      const w = document.createElement('div'); w.className = 'kbm-warn';
      w.textContent = '看板后端暂不可用'
        + (state.restError ? `（${state.restError}）` : '')
        + '：上面是 config.yaml 里的值，可能与运行中 gateway 的实际状态不一致，此时切换也无法写入。';
      stage.appendChild(w);
    }

    applyBtn.disabled = busy || !pick || pick === state.mode;
    hint.textContent = pick && pick !== state.mode
      ? `将写入：${planLines(pick).replace(/\n/g, '；')}`
      : '当前没有待应用的改动';
  };

  const runApply = async (modeId) => {
    busy = true; applyBtn.disabled = true;
    status.classList.remove('is-error');
    status.textContent = '正在写入 CLI 配置…（派发器开关要冷启 CLI，约 5–10 秒）';
    let r = null;
    try { r = await api.kanbanSetMode(modeId); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    busy = false;
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '切换失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error');
      draw();
      return;
    }
    state = r.state || state;
    pick = state.mode;
    draw();
    if (hintEl) hintEl.textContent = r.needsRestart ? '已写入 CLI 配置 · 需重启 gateway' : '已写入 CLI 配置';
    // 看板页头那枚只读标记跟着更新：模式一变，卡会不会自己跑掉就变了
    try { kbLoadMode(); } catch {}
    if (r.needsRestart) {
      status.textContent = '已写入。需要重启 gateway 才生效：hermes gateway restart';
      toast('已保存，需重启 gateway 生效', 3200);
    } else {
      status.textContent = '已生效（下一轮 tick 生效，不用重启）';
      toast('看板编排已切换', 1800);
    }
  };

  applyBtn.onclick = () => {
    if (!state || busy || !pick || pick === state.mode) return;
    const m = (state.modes || []).find((x) => x.id === pick);
    if (!m) return;
    opConfirm(stage, {
      title: `把看板编排改成「${m.label}」？`,
      cmd: planLines(pick),
      note: m.dispatch
        ? '改的是 gateway 的自动派发行为，下一轮 tick 生效，不需要重启。'
        : '这一档会停掉 gateway 里的派发器：改完必须重启 gateway 才真正生效，且所有看板都不再自动派发。',
      confirmLabel: '确认切换',
      onGo: () => runApply(pick),
    });
  };

  const load = async () => {
    if (!isNativeCLI()) {
      status.textContent = '演示模式：需要桌面端原生环境读取编排开关。';
      return;
    }
    status.textContent = '正在读取当前模式…';
    let r = null;
    try { r = await api.kanbanOrchestration(); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error');
      return;
    }
    state = r;
    pick = r.mode;
    draw();
  };
  refresh.onclick = () => { if (!busy) load(); };
  await load();
}

async function renderCronPanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">定时任务</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);

  const bar = document.createElement('div'); bar.className = 'op-bar';
  const status = document.createElement('div'); status.className = 'mem-status';
  status.textContent = isNativeCLI() ? '正在读取调度器与任务…' : '演示模式：需要桌面端原生环境读取定时任务。';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新';
  bar.append(status, refresh); panel.appendChild(bar);

  const list = document.createElement('div'); list.className = 'op-list'; panel.appendChild(list);

  const runsWrap = document.createElement('div'); runsWrap.className = 'op-out'; runsWrap.hidden = true;
  panel.appendChild(runsWrap);

  const form = document.createElement('div'); form.className = 'op-form';
  const fTitle = document.createElement('div'); fTitle.className = 'pp-group-label'; fTitle.textContent = '新建任务';
  form.appendChild(fTitle);
  const schedIn = textField('30m / every 2h / 0 9 * * *', 64);
  const nameIn = textField('任务名称（可选）', 80);
  const promptIn = document.createElement('textarea');
  promptIn.className = 'set-input op-input op-textarea'; promptIn.placeholder = '任务内容（可选，自包含的提示词）';
  promptIn.spellcheck = false; promptIn.maxLength = 4000; promptIn.rows = 3;
  const fBtns = document.createElement('div'); fBtns.className = 'op-form-btns';
  const createBtn = document.createElement('button');
  createBtn.type = 'button'; createBtn.className = 'mk-btn primary'; createBtn.textContent = '创建（暂停）';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button'; clearBtn.className = 'mk-btn'; clearBtn.textContent = '清空';
  fBtns.append(createBtn, clearBtn);
  form.append(fieldRow('调度', '支持相对间隔、every 间隔与 5 段 cron 表达式。', schedIn),
    fieldRow('名称', '', nameIn), fieldRow('内容', '每行会原样作为 CLI 的位置参数；不要以 - 开头。', promptIn), fBtns);
  guardFieldKey(schedIn, () => form.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(nameIn, () => form.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(promptIn, () => form.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  clearBtn.onclick = () => { schedIn.value = ''; nameIn.value = ''; promptIn.value = ''; form.querySelectorAll('.op-confirm').forEach((n) => n.remove()); };
  panel.appendChild(form);

  const note = document.createElement('div'); note.className = 'pf-note';
  note.textContent = '新建任务恒为暂停（--paused），需手动「恢复」才会按计划唤醒 agent。「立即运行」会真实触发一次模型回合并消耗额度；移除不可撤销。调度器由桌面端常驻后端驱动，关闭应用后任务不会触发。';
  panel.appendChild(note);

  let jobs = [];
  const draw = () => {
    list.innerHTML = '';
    const active = jobs.filter((j) => j.state === 'active').length;
    status.textContent = `${jobs.length} 个任务 · ${active} 个活跃` +
      (scheduler && scheduler.running ? ' · 调度器运行中' : ' · 调度器未就绪');
    status.classList.remove('is-error');
    if (!jobs.length) {
      const empty = document.createElement('div'); empty.className = 'op-empty';
      empty.textContent = '暂无定时任务。'; list.appendChild(empty); return;
    }
    jobs.forEach((j) => list.appendChild(cronCard(j)));
  };
  let scheduler = null;

  function kv(label, value, code) {
    if (!value) return null;
    const row = document.createElement('div'); row.className = 'op-kv';
    const k = document.createElement('span'); k.className = 'op-kv-k'; k.textContent = label;
    const v = document.createElement('span'); v.className = code ? 'op-code' : 'op-kv-v'; v.textContent = value;
    row.append(k, v); return row;
  }

  function cronCard(j) {
    const card = document.createElement('div'); card.className = 'op-card';
    const top = document.createElement('div'); top.className = 'op-card-top';
    const name = document.createElement('span'); name.className = 'op-name'; name.textContent = j.name;
    const badge = document.createElement('span');
    const stateMap = { active: '活跃', paused: '已暂停', completed: '已完成', disabled: '已停用' };
    badge.className = 'op-badge' + (j.state === 'active' ? ' on' : '');
    badge.textContent = stateMap[j.state] || j.state;
    top.append(name, badge); card.appendChild(top);
    const grid = document.createElement('div'); grid.className = 'op-grid';
    [kv('任务 ID', j.id, true), kv('调度', j.schedule), kv('下次运行', j.nextRun),
      kv('重复', j.repeat), kv('投递', j.deliver), kv('上次运行', j.lastRun)]
      .forEach((n) => { if (n) grid.appendChild(n); });
    card.appendChild(grid);
    const acts = document.createElement('div'); acts.className = 'op-acts';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'mk-btn';
    toggleBtn.textContent = j.state === 'active' ? '暂停' : '恢复';
    const runBtn = document.createElement('button');
    runBtn.type = 'button'; runBtn.className = 'mk-btn'; runBtn.textContent = '立即运行';
    const histBtn = document.createElement('button');
    histBtn.type = 'button'; histBtn.className = 'mk-btn'; histBtn.textContent = '运行历史';
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'mk-btn danger'; delBtn.textContent = '移除';
    acts.append(toggleBtn, runBtn, histBtn, delBtn);
    card.appendChild(acts);

    toggleBtn.onclick = () => opConfirm(card, {
      title: `${j.state === 'active' ? '暂停' : '恢复'}「${j.name}」？`,
      cmd: `hermes -p <current> cron ${j.state === 'active' ? 'pause' : 'resume'} ${j.id}`,
      note: j.state === 'active' ? '暂停后不再按计划触发，任务与配置保留。' : '恢复后会重新排入下一次触发时间。',
      confirmLabel: j.state === 'active' ? '确认暂停' : '确认恢复',
      onGo: () => write(() => api.cronAction(j.state === 'active' ? 'pause' : 'resume', j.id), '已更新', '操作失败'),
    });
    runBtn.onclick = () => opConfirm(card, {
      title: `立即运行「${j.name}」？`,
      cmd: `hermes -p <current> cron run ${j.id}`,
      note: '会真实触发一次完整的 agent 回合并消耗模型额度，最长等待 60 秒。',
      confirmLabel: '确认运行',
      onGo: () => write(() => api.cronAction('run', j.id), '已触发', '触发失败'),
    });
    delBtn.onclick = () => opConfirm(card, {
      title: `移除「${j.name}」？`,
      cmd: `hermes -p <current> cron remove ${j.id}`,
      note: '任务及其调度配置会被删除，此操作不可撤销。',
      confirmLabel: '确认移除',
      onGo: () => write(() => api.cronAction('remove', j.id), '已移除', '移除失败'),
    });
    histBtn.onclick = async () => {
      if (!isNativeCLI()) { toast('演示模式不可用', 1800); return; }
      histBtn.disabled = true; histBtn.textContent = '读取中…';
      let r;
      try { r = await api.cronRuns(j.id, 20); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!alive()) return;
      histBtn.disabled = false; histBtn.textContent = '运行历史';
      runsWrap.hidden = false; runsWrap.textContent = '';
      const t = document.createElement('div'); t.className = 'op-out-head';
      t.textContent = `${j.name} · 最近运行记录`; runsWrap.appendChild(t);
      if (!r || !r.ok) { runsWrap.appendChild(document.createTextNode('读取失败：' + ((r && r.error) || '未知错误'))); return; }
      const runs = arr(r.runs);
      if (!runs.length) { runsWrap.appendChild(document.createTextNode('暂无运行记录。')); return; }
      runs.forEach((x) => {
        const line = document.createElement('div'); line.className = 'op-run';
        line.textContent = `${x.at}  ${x.status}  ·  ${x.source}${x.error ? '  ·  ' + x.error : ''}`;
        runsWrap.appendChild(line);
      });
    };
    return card;
  }

  async function write(fn, okMsg, failMsg) {
    if (!isNativeCLI()) { toast('演示模式不可用', 1800); return false; }
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return false;
    if (!r || !r.ok) { toast(`${failMsg}：${(r && r.error) || '未知错误'}`, 3400); return false; }
    if (Array.isArray(r.jobs)) { jobs = r.jobs; draw(); }
    else await reload();
    toast(r.warning || okMsg, r.warning ? 3200 : 1600);
    return true;
  }

  createBtn.onclick = () => opConfirm(form, {
    title: '创建这个定时任务？',
    cmd: `hermes -p <current> cron create ${schedIn.value.trim() || '<schedule>'} --paused`,
    note: '任务以暂停状态创建，不会立刻运行；恢复后才会按调度唤醒 agent。',
    confirmLabel: '确认创建',
    onGo: async () => {
      const ok = await write(() => api.cronCreate({
        schedule: schedIn.value.trim(), name: nameIn.value.trim(), prompt: promptIn.value.trim(),
      }), '已创建（暂停）', '创建失败');
      if (ok) { schedIn.value = ''; nameIn.value = ''; promptIn.value = ''; }
      return ok;
    },
  });

  async function reload() {
    if (!isNativeCLI()) { status.textContent = '演示模式：不做 CLI 调用。'; return; }
    status.textContent = '正在执行 hermes cron list --all / status / doctor…';
    let r;
    try { r = await api.cronOverview(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error'); return;
    }
    jobs = arr(r.jobs); scheduler = r.status || null; draw();
  }
  refresh.onclick = reload;
  await reload();
}

/* ---------- 设置页：健康检查（只读诊断，原样展示 CLI 输出） ----------
   不做结构化解析：CLI 的排版本 / 文案随版本变，把「✓」硬解析成布尔很容易误报。
   退出码非 0 也可能只是 doctor 报告了待办建议，因此状态区分：
     有输出 → 完成（附退出码）；无输出 / 超时 / error → 失败。 */
const HEALTH_CHECKS = [
  { key: 'status', label: '组件状态', cmd: 'hermes status', hint: '模型、provider、网关与任务概览', slow: false },
  { key: 'config:check', label: '配置检查', cmd: 'hermes config check', hint: '配置版本与缺失/可选环境变量', slow: false },
  { key: 'fallback:list', label: '备用模型链', cmd: 'hermes fallback list', hint: '主模型失败时按顺序尝试的 provider', slow: false },
  { key: 'memory:status', label: '记忆状态', cmd: 'hermes memory status', hint: '内置记忆与外部 provider', slow: false },
  { key: 'doctor', label: '深度体检', cmd: 'hermes doctor', hint: '枚举全部工具与环境，约 40 秒，建议单独运行', slow: true },
];
let healthRunning = false;
function healthStatusLine(r, ms) {
  const secs = (ms / 1000).toFixed(1) + 's';
  if (r && r.timedOut) return `超时（${secs}）`;
  if (r && r.hasOutput) return r.ok ? `完成 · 退出码 0 · ${secs}` : `完成 · 退出码 ${r.code}（可能含建议） · ${secs}`;
  return `未取得输出 · ${secs}`;
}
async function runHealthCard(check, card, onDone) {
  const btn = card.querySelector('.hc-run');
  const out = card.querySelector('.hc-out');
  const meta = card.querySelector('.hc-meta');
  btn.disabled = true; meta.textContent = '运行中…'; meta.classList.remove('is-error');
  const t0 = performance.now();
  let r;
  try { r = await api.diagnosticsRun(check.key); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e), text: '' }; }
  const ms = performance.now() - t0;
  out.textContent = r && r.text ? r.text : (r && r.error) || 'CLI 未返回内容';
  out.hidden = false;
  meta.textContent = healthStatusLine(r, ms);
  const failed = !!(r && !r.hasOutput);
  meta.classList.toggle('is-error', failed);
  card.classList.toggle('is-error', failed);
  btn.disabled = false;
  if (onDone) onDone();
}
function renderHealthPanel(panel, cat) {
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">只读诊断</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const actions = document.createElement('div'); actions.className = 'hc-actions';
  const runQuick = document.createElement('button');
  runQuick.type = 'button'; runQuick.className = 'hc-quick'; runQuick.textContent = '运行快速检查（4 项）';
  runQuick.disabled = !isNativeCLI() || healthRunning;
  const note = document.createElement('span'); note.className = 'hc-note';
  note.textContent = '命令由服务层白名单固定，串行执行，均不带 --fix / --live，不发真实网络探测。';
  actions.append(runQuick, note);
  panel.appendChild(actions);

  const grid = document.createElement('div'); grid.className = 'hc-grid';
  const cards = new Map();
  HEALTH_CHECKS.forEach((c) => {
    const card = document.createElement('div'); card.className = 'hc-card' + (c.slow ? ' slow' : '');
    card.innerHTML = `<div class="hc-head"><span class="hc-name">${esc(c.label)}</span>` +
      `<span class="hc-meta">未运行</span></div>` +
      `<div class="hc-cmd">${esc(c.cmd)}</div><div class="hc-hint">${esc(c.hint)}</div>`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'hc-run'; btn.textContent = c.slow ? '运行深度体检' : '运行';
    btn.disabled = !isNativeCLI();
    btn.onclick = () => { if (!healthRunning) runHealthCard(c, card); };
    const out = document.createElement('pre'); out.className = 'hc-out'; out.hidden = true;
    card.append(btn, out);
    grid.appendChild(card);
    cards.set(c.key, { check: c, card });
  });
  panel.appendChild(grid);

  const disclaimer = document.createElement('div'); disclaimer.className = 'pf-note';
  disclaimer.innerHTML = `这里只做<strong>只读</strong>诊断，不会修复、改写配置或安装依赖。` +
    `CLI 输出原样展示，<code>hermes doctor</code> 的退出码 1 通常只表示「有待处理建议」，` +
    `不能据此判定配置损坏；请以输出里的具体条目为准。修复请在终端执行对应 CLI 命令。`;
  panel.appendChild(disclaimer);

  runQuick.onclick = async () => {
    if (healthRunning) return;
    healthRunning = true; runQuick.disabled = true; runQuick.textContent = '运行中…';
    for (const c of HEALTH_CHECKS.filter((x) => !x.slow)) {
      const entry = cards.get(c.key);
      if (entry) await runHealthCard(c, entry.card);
    }
    healthRunning = false; runQuick.disabled = false; runQuick.textContent = '运行快速检查（4 项）';
    toast('快速检查完成', 1400);
  };
}

function setupSettings() {
  $('#set-close').onclick = () => toggleSettings(false);
  $('#settings-page').addEventListener('click', (e) => { if (e.target.id === 'settings-page') toggleSettings(false); });
  $('#set-cancel').onclick = () => toggleSettings(false);
  $('#set-save').onclick = () => {
    const ok = SettingsStore.set(settingsDraft);
    settingsDraft = {};
    $('#set-save').classList.remove('dirty');
    if (!ok) { $('#set-hint').textContent = '保存失败（本地存储不可用）'; toast('设置无法保存', 2400); return; }
    // 设置此前只写不读，全部是摆设；保存后立刻应用到界面
    applySettings();
    $('#set-hint').textContent = '已保存并生效';
    toast('设置已保存并生效', 1400);
  };
  $('#set-open-config').onclick = async () => {
    if (isNativeCLI()) {
      const r = await window.hermesAPI.configOpenFile('configYaml');
      if (!r.ok) toast(r.error || '打开失败', 2200);
    } else {
      toast('配置文件位于 ~/.hermes/config.yaml（真机可直接打开）', 2400);
    }
  };
}
/* ---------- Profile：品牌行下拉 + 设置页分区共用一套数据/切换 ---------- */
let pfSnapshot = null;
const pfNative = () => hasNative && typeof api.profileList === 'function';
const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
};

async function loadProfiles(force) {
  if (!pfNative()) return null;
  if (!force && pfSnapshot) return pfSnapshot;
  try { pfSnapshot = await api.profileList(); } catch { pfSnapshot = null; }
  return pfSnapshot;
}

async function refreshProfileChip() {
  const snap = await loadProfiles(true);
  if (!snap) return;
  $('#pf-name').textContent = snap.current;
  $('#pf-chip').title = `当前 Profile：${snap.current}（点击切换）`;
}

/** 真正执行切换：主进程停后端 → 换 home → 重新拉起，随后重载渲染层重建所有列表。 */
async function doSwitchProfile(name) {
  if (!pfNative()) { toast('当前环境不支持切换 Profile', 2200); return false; }
  toast(`正在切换到 ${name}…`, 2000);
  let r;
  try { r = await api.profileSwitch(name); } catch (e) { toast('切换失败：' + (e?.message || e), 3000); return false; }
  if (!r || !r.ok) { toast('切换失败：' + ((r && r.error) || '未知错误'), 3000); return false; }
  if (r.changed === false) return true;
  location.reload();
  return true;
}
function askSwitch(name) {
  if (name === pfSnapshot?.current) return;
  if (!confirm(`切换到 profile「${name}」？\n\n将重启后端并重载界面，当前进行中的对话会中断。桌面端只改自己的选择，不会写入 ~/.hermes，终端 CLI 不受影响。`)) return;
  doSwitchProfile(name);
}

function renderPfMenu() {
  const m = $('#pf-menu');
  if (!pfSnapshot) { m.innerHTML = '<div class="pf-menu-head">正在读取 profile…</div>'; return; }
  m.innerHTML = `<div class="pf-menu-head">切换 Profile · 当前 ${esc(pfSnapshot.current)}</div>` +
    pfSnapshot.profiles.map((p) =>
      `<button class="pf-menu-item" data-name="${esc(p.name)}"><span class="pf-dot"></span>` +
      `<span class="pf-mi-name">${esc(p.name)}</span>${p.current ? '<span class="pf-mi-tag">当前</span>' : ''}</button>`).join('') +
    `<div class="pf-menu-foot">切换会重启后端并重载界面。桌面端不写入 <code>~/.hermes</code>，` +
    `终端 CLI 的 <code>profile use</code> 默认互不影响。</div>`;
}
function togglePfMenu(show) {
  const m = $('#pf-menu');
  const on = show !== undefined ? show : m.hidden;
  m.hidden = !on;
  if (!on) return;
  const r = $('#pf-chip').getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 232)) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  renderPfMenu();
}
$('#pf-chip').onclick = (e) => {
  e.stopPropagation();
  togglePfMenu();
  loadProfiles(true).then(() => { if (!$('#pf-menu').hidden) renderPfMenu(); });
};
$('#pf-menu').addEventListener('click', (e) => {
  const b = e.target.closest('.pf-menu-item');
  if (!b) return;
  $('#pf-menu').hidden = true;
  askSwitch(b.dataset.name);
});
document.addEventListener('click', (e) => {
  const m = $('#pf-menu');
  if (!m.hidden && !m.contains(e.target) && !$('#pf-chip').contains(e.target)) m.hidden = true;
});

/** 设置页 → Profile 分区 */
async function renderProfilePanel(panel, cat) {
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">实例</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const grid = document.createElement('div');
  grid.className = 'pf-grid';
  grid.innerHTML = '<div class="set-row-hint">正在读取 profile…</div>';
  panel.appendChild(grid);
  const note = document.createElement('div');
  note.className = 'pf-note';
  note.innerHTML = `当前选择保存在桌面端自己的应用数据目录（Electron userData），` +
    `切换时所有 hermes CLI 子进程显式带 <code>-p &lt;名&gt;</code>。<br>` +
    `因此不会新建、修改或删除 <code>~/.hermes</code> 下的任何文件，也不会改动 hermes CLI 安装目录；` +
    `终端里执行 <code>hermes profile use &lt;名&gt;</code> 设置的 sticky 默认与桌面端互不干扰。` +
    `<br>切换会重启常驻后端并重载界面，进行中的对话会中断。`;
  panel.appendChild(note);

  const snap = await loadProfiles(true);
  if (!snap) {
    grid.innerHTML = '<div class="set-row-hint">需要桌面端原生环境才能切换 profile。</div>';
    return;
  }
  grid.innerHTML = '';
  snap.profiles.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'pf-card' + (p.current ? ' active' : '');
    card.innerHTML = `
      <div class="pf-card-top"><span class="pf-card-name">${esc(p.name)}</span>
        ${p.current ? '<span class="pf-badge">当前使用中</span>' : ''}
        ${p.cliActive && !p.current ? '<span class="pf-badge">CLI 默认</span>' : ''}</div>
      <div class="pf-card-meta">${esc(p.model)}<br>${esc(Number(p.skills) || 0)} 个技能 · 会话库 ${fmtBytes(p.dbBytes)}<br>${esc(p.home)}</div>`;
    const btn = document.createElement('button');
    btn.className = 'pf-card-btn';
    btn.textContent = p.current ? '当前使用中' : '切换到此';
    btn.disabled = !!p.current;
    btn.onclick = () => askSwitch(p.name);
    card.appendChild(btn);
    grid.appendChild(card);
  });
  refreshProfileChip();
}

/* ═══════════ 生产级增强层：状态同步 / 帮助 / 草稿 / 消息操作 / 审批 ═══════════ */

/** Escape 统一收起所有轻浮层；返回是否确实关掉了东西（决定要不要中断生成）。 */
function closeAllOverlays() {
  let closed = false;
  ['#pf-menu', '#session-menu', '#storage-pop', '#chip-menu'].forEach((sel) => {
    const el = $(sel);
    if (el && !el.hidden) { el.hidden = true; closed = true; }
  });
  document.querySelectorAll('.subpage .pp-menu').forEach((m) => {
    if (!m.hidden) { m.hidden = true; closed = true; }
  });
  const menus = document.querySelectorAll('.set-menu');
  menus.forEach((m) => m.remove());
  if (menus.length) closed = true;
  return closed;
}
/** 消息操作条里的绝对时间（HH:MM:SS）。 */
function fmtTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** 输入框字符计数。 */
function updateCount() {
  const el = $('#input-count'); if (!el) return;
  const n = ($('#input').value || '').length;
  el.textContent = n ? `${n} 字符` : '';
}
/** 发送/停止按钮与输入框状态的唯一真源，避免各处手动切 hidden 打架。
 *  不改按钮几何：生成中只显示停止按钮、给发送按钮加状态类，输入框文案变为提示。 */
function syncComposerState() {
  const tab = activeTab();
  const running = !!(tab && tab.running);
  const stop = $('#btn-stop'), sendBtn = $('#btn-send'), inp = $('#input');
  if (stop) stop.hidden = !running;
  if (sendBtn) sendBtn.classList.toggle('is-busy', running);
  if (inp) {
    inp.setAttribute('aria-busy', String(running));
    inp.placeholder = running ? '正在生成…可按 Esc 或 ■ 停止' : '发消息或创建任务，/ 调用指令，@ 文件或对话';
  }
  updateCount();
}

/** 草稿：按 sessionId（无则 tabId）隔离，切页签/重启后不丢未发送的输入。 */
const DRAFT_KEY = 'hermes.drafts';
function draftMap() {
  try {
    const v = JSON.parse(safeGet(DRAFT_KEY) || '{}');
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
function draftKeyOf(tab) { return (tab && (tab.sessionId || tab.id)) || ''; }
function saveDraftFor(tab) {
  const k = draftKeyOf(tab); if (!k) return;
  const m = draftMap();
  const v = ($('#input') && $('#input').value) || '';
  if (v.trim()) m[k] = v.slice(0, 20000); else delete m[k];
  const keys = Object.keys(m); // 只留最近 40 份，避免 localStorage 无限增长
  if (keys.length > 40) for (const old of keys.slice(0, keys.length - 40)) delete m[old];
  safeSet(DRAFT_KEY, JSON.stringify(m));
}
function restoreDraftFor(tab) {
  const inp = $('#input'); if (!inp) return;
  const k = draftKeyOf(tab);
  inp.value = k ? (draftMap()[k] || '') : '';
  autoGrow(); updateCount();
}
function clearDraftFor(tab) {
  const k = draftKeyOf(tab); if (!k) return;
  const m = draftMap(); if (!(k in m)) return;
  delete m[k]; safeSet(DRAFT_KEY, JSON.stringify(m));
}

/** 标记本页签所有在途回合失效：停止后延迟到达的 delta 不再串进正文。 */
function invalidateTurn(tab) {
  if (!tab) return;
  for (const [tid, id] of state.turnTab) if (id === tab.id) state.invalidTurns.add(tid);
  if (tab.lastResult && tab.lastResult.turnId) state.invalidTurns.add(tab.lastResult.turnId);
  if (state.invalidTurns.size > 200) state.invalidTurns.clear();
}

/** 回合收尾：按设置自动折叠已完成的工具详情与长思考块。 */
function applyAutoCollapse(tab) {
  if (!tab || SettingsStore.get('autoCollapse', true) === false) return;
  for (const i of tab.items) {
    if (i.kind === 'tool' && i.state === 'done') i.open = false;
    if (i.kind === 'thinking' && (i.text || '').length > 300) i.open = false;
  }
}

function copyText(text) {
  const t = String(text || '');
  if (!t) return Promise.reject(new Error('empty'));
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
  return Promise.reject(new Error('clipboard unavailable'));
}
function copyLastReply() {
  const tab = activeTab();
  const last = tab && [...tab.items].reverse().find((i) => i.kind === 'assistant' && i.text);
  if (!last) { toast('没有可复制的回复'); return; }
  copyText(last.text).then(() => toast('已复制上一条回复', 1400)).catch(() => toast('复制失败（剪贴板不可用）'));
}
/** 从某条用户提问重试：截断该提问及其之后的所有消息，用原文重新发起一轮。 */
function retryFrom(item) {
  const tab = activeTab();
  if (!tab || tab.running) { toast('请等待当前回合结束再重试'); return; }
  const idx = tab.items.indexOf(item);
  if (idx < 0 || !item || item.kind !== 'user') return;
  tab.items = tab.items.slice(0, idx);
  tab.lastResult = null;
  send(item.text);
  a11y('已用原提问重新发起一轮');
}
/** 失败卡的「用当前模型重试」：往前找该轮失败对应的用户提问。
 *  若当前模型恰好就是上游判定不可用的那个，先打开模型选择器，避免又撞一次 400。 */
function retryFailedTurn(item) {
  const tab = activeTab();
  if (!tab || !item) return;
  const idx = tab.items.indexOf(item);
  if (idx < 0) { toast('找不到这条失败记录'); return; }
  let target = null;
  for (let i = idx - 1; i >= 0; i--) if (tab.items[i].kind === 'user') { target = tab.items[i]; break; }
  if (!target) { toast('这条失败记录前没有可重发的提问'); return; }
  const bad = item.failure && item.failure.model;
  if (bad && bad === state.config.model) {
    toast('当前模型仍是 ' + bad + '，请先切换模型', 2600);
    openModelPicker();
    return;
  }
  retryFrom(target);
  toast('已用 ' + (state.config.model || '默认模型') + ' 重新发起');
}
function setView(view) {
  const v = view === 'trace' ? 'trace' : 'chat';
  state.view = v;
  document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  renderChat();
}

/* ---------- 快捷键帮助（对标 Claude Code 的 ? / ⌘/） ---------- */
/** 可自定义项从当前映射实时取键位，固定项保留说明文案。 */
function helpGroups() {
  const m = shortcutMap();
  const k = (id) => comboLabel(m[id]);
  return [
    ['会话', [[k('newTab'), '新建页签'], [k('palette'), '命令面板'],
      [k('viewChat') + ' / ' + k('viewTrace'), '对话 / 轨迹视图'],
      [k('sidebar'), '显示或隐藏侧边栏'], [k('focusSearch'), '聚焦会话搜索'],
      ['⌘⇧M', '收成桌面小圆球（点球弹出迷你聊天窗）'],
      ['Esc', '关闭浮层；无浮层时停止本回合']]],
    ['输入', [['Enter', '发送'], ['Shift Enter', '换行'], [k('send'), '发送（任意焦点）'],
      ['↑ / ↓', '复用上一条 / 下一条提问'], ['/help', '斜杠命令列表']]],
    ['消息', [[k('copyLast'), '复制上一条回复'], ['悬停消息', '复制单条 / 重试'],
      ['代码块右上', '复制代码'], ['点击工具行', '展开输入输出详情']]],
    ['其他', [[k('help') + ' 或 ?', '打开本帮助'], [k('terminal'), '切换右侧终端栏'],
      ['点击图标栏 logo', '展开侧栏']]],
  ];
}
function renderHelp(force) {
  const body = $('#help-body'); if (!body) return;
  if (!force && body.childElementCount) return; // 自定义快捷键后传 force 强制重绘
  const footKey = $('#help-foot-palette');
  if (footKey) footKey.textContent = comboLabel(shortcutMap().palette);
  body.innerHTML = helpGroups().map(([title, rows]) =>
    `<section class="help-group"><h3>${esc(title)}</h3>${rows.map(([ky, d]) =>
      `<div class="help-row"><kbd>${esc(ky)}</kbd><span>${esc(d)}</span></div>`).join('')}</section>`).join('');
}
function toggleHelp(force) {
  const modal = $('#help-modal'); if (!modal) return;
  const show = force === undefined ? modal.hidden : !!force;
  modal.hidden = !show;
  if (show) { renderHelp(true); const c = $('#help-close'); if (c) c.focus(); }
  else { const i = $('#input'); if (i) i.focus(); }
}
if ($('#btn-help')) $('#btn-help').onclick = () => toggleHelp(true);
if ($('#help-close')) $('#help-close').onclick = () => toggleHelp(false);
if ($('#help-modal')) $('#help-modal').addEventListener('click', (e) => { if (e.target.id === 'help-modal') toggleHelp(false); });

/* ---------- 聊天区事件委托：消息操作 / 代码复制 / 审批 ---------- */
$('#chat').addEventListener('click', (e) => {
  const t = e.target;
  const ap = t.closest && t.closest('[data-ap]');
  if (ap) {
    const msg = ap.closest('.msg'); const item = msg && msg._item;
    if (item && !item.choice) resolveApproval(item, ap.dataset.ap);
    return;
  }
  const ea = t.closest && t.closest('[data-err-act]');
  if (ea) {
    const msg = ea.closest('.msg'); const item = msg && msg._item;
    const kind = ea.dataset.errAct;
    if (kind === 'model') openModelPicker();
    else if (kind === 'retry') retryFailedTurn(item);
    else if (kind === 'detail') {
      const raw = msg && msg.querySelector('.err-raw');
      if (raw) { raw.hidden = !raw.hidden; ea.textContent = raw.hidden ? '查看原始错误' : '收起原始错误'; }
    }
    return;
  }
  const act = t.closest && t.closest('[data-msg-act]');
  if (act) {
    const msg = act.closest('.msg'); const item = msg && msg._item;
    if (!item) return;
    if (act.dataset.msgAct === 'copy') {
      copyText(item.text || item.output || '').then(() => toast('已复制该消息', 1200)).catch(() => toast('复制失败'));
    } else if (act.dataset.msgAct === 'retry') retryFrom(item);
    return;
  }
  const cp = t.closest && t.closest('.md-code-copy');
  if (cp) {
    const box = cp.closest('.md-code'); const code = box && box.querySelector('pre code');
    copyText(code ? code.textContent : '').then(() => {
      const old = cp.textContent; cp.textContent = '已复制';
      setTimeout(() => { cp.textContent = old; }, 1200);
    }).catch(() => toast('复制失败'));
  }
});

/* ---------- 危险操作审批：主进程请求 → 聊天流卡片 → 用户选择回传 ---------- */
function onApprovalRequest(req) {
  const r = req || {};
  if (!r.requestId) return;
  const tab = (r.tabId && state.tabs.find((t) => t.id === r.tabId)) || activeTab();
  if (!tab) {
    if (hasNative && api.approvalRespond) Promise.resolve(api.approvalRespond({ requestId: r.requestId, choice: 'deny', tabId: r.tabId })).catch(() => {});
    return;
  }
  const item = {
    kind: 'approval', requestId: r.requestId, tabId: r.tabId || tab.id,
    tool: r.tool || '工具调用', command: r.command || '', risk: r.risk || '',
  };
  tab.items.push(item);
  renderChat(); scrollBottom(true);
  a11y('需要确认危险操作');
  // 主进程 25s 后自动拒绝，这里提前收口，避免卡片永久停在「待确认」
  setTimeout(() => { if (!item.choice) resolveApproval(item, 'deny', true); }, 24000);
}
function resolveApproval(item, choice, silent) {
  if (!item || item.choice) return;
  item.choice = choice === 'deny' ? 'deny' : 'approve';
  item.always = choice === 'always';
  if (hasNative && api.approvalRespond) {
    Promise.resolve(api.approvalRespond({ requestId: item.requestId, choice, tabId: item.tabId })).catch(() => {});
  }
  renderChat();
  if (!silent) toast(choice === 'deny' ? '已拒绝该操作' : '已允许该操作', 1500);
}

/** 设置落盘后立刻生效；字号只作用于聊天正文，不动用户定稿的几何尺寸。 */
function applySettings() {
  const s = settingsRead();
  const theme = s.theme === 'dark' ? 'dark'
    : s.theme === 'system' ? ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light')
      : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  // 字号是一个旋钮：写 --ui-fs，正文/气泡/摘要行/信息行/输入框/状态条全部按比例派生
  const fsPx = (Math.max(10, Math.min(20, Number(s.fontSize) || 16))) + 'px';
  document.documentElement.style.setProperty('--ui-fs', fsPx);
  document.documentElement.style.setProperty('--msg-font-size', fsPx);
  document.documentElement.classList.toggle('compact-steps', s.stepDetail === '简洁');
  // 主题变了迷你聊天窗也要跟着变（它自己读不到主窗口的 localStorage）
  publishOrbContext();
}

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
/** 指针拖拽的共享状态（一次只有一个拖动中的卡片）。 */
const KbDrag = {
  armed: false, on: false, id: '', title: '', status: '',
  x0: 0, y0: 0, card: null, ghost: null, target: null, suppressClick: false,
  gh: 0, vel: 0, raf: 0,
};
const KB = {
  epoch: 0, detailEpoch: 0, timer: null, busy: false,
  board: null, overview: null, detail: null, detailId: '',
  lastEventId: 0, error: '',
  // 默认列视图：5 组固定成列，一屏看清全貌；网格视图留给窄主区（⋯ 菜单里切）
  view: 'cols', status: '', modal: '', modalKey: '', modalBusy: false,
  dispatch: { open: false, busy: false, epoch: 0 },
  filters: { q: '', assignee: '', tenant: '', archived: false, board: '' },
  // 页头那枚只读模式标记的数据（null = 还没读到 / 读不到，此时不显示）
  mode: null,
  // 官方 project-dialog 的本地等价状态：一次选择可以带回多个文件夹，第一个为主；
  // projectDialog 记录 create / rename / add-folder 三种模式共用的目标项目。
  projFolders: [], projectDialog: null,
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
    const page = $('#kanban-page');
    if (!page || page.hidden) { kanbanStopPolling(); return; }
    if (document.hidden || KB.busy || KbDrag.on) return;
    const a = kbApi();
    if (!a || !a.kanbanBoard) return;
    const my = KB.epoch;
    try {
      const r = await a.kanbanBoard(kbParams());
      if (my !== KB.epoch || page.hidden) return;
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
  kanbanStopPolling();
  KB.epoch += 1; // 作废所有在途响应
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
  const ph = o.currentBoard ? `当前看板 (${o.currentBoard})` : '当前看板';
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
  tip.textContent = (KbDrag.status ? KbDrag.status + ' · ' : '') + '松手放到 profile 上';
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
  kbSetDropTarget(kbChipAt(x, y));
  kbDragAutoScroll(x, y);
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
  KbDrag.vel = 0; KbDrag.gh = 0;
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
  const id = KbDrag.id;
  const moved = kbDragReset();
  if (moved) {
    // 拖动结束后浏览器会补一个 click；先吞掉，再在下一个任务里复位标志
    KbDrag.suppressClick = true;
    setTimeout(() => { KbDrag.suppressClick = false; }, 0);
  }
  if (moved && dropped && KB_ASSIGNEE_RE.test(dropped)) kbDropToWorker(id, dropped);
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
function kbCardHtml(t, colName, opts) {
  const o = opts || {};
  const st = String(colName || t.status || '');
  const draggable = KB_DRAGGABLE.includes(st) ? '1' : '0';
  // 方案一（OnPoint 极简白卡）：无顶行，标题是第一视觉焦点。优先级用 P 编号
  // 胶囊绝对定位在右上角，恒显示（P3 红 / P2 黄 / P1 绿 / P0 未设灰）。
  // 时间做成弱胶囊收进脚行，与评论数并排，状态点收右下。
  const pri = Number(t.priority) || 0;
  const priCls = pri >= 3 ? 'hi' : (pri === 2 ? 'mid' : (pri === 1 ? 'lo' : 'n0'));
  const priHtml = `<span class="kb-pri ${priCls}" title="优先级 P${pri}（数字越大越先派发，P0 = 未设）">P${pri}</span>`;
  const ago = kbAgo(t.created_at);
  const whenHtml = ago ? `<span class="kb-card-when" title="创建于 ${esc(kbFullTime(t.created_at))}">${esc(ago)}</span>` : '';
  // 来源行：细粒度状态 chip 只有跨组展示（网格 / 搜索结果）才需要；
  // 受让人不放这里 —— 它挪到发丝脚行，占原来任务 ID 的位置（ID 只留在抽屉里）。
  const chips = [];
  if (o.showStatus && st) chips.push(`<span class="kb-chip st" title="CLI 状态：${esc(st)}">${esc(KB_STATUS_LABEL[st] || st)}</span>`);
  if (t.tenant) chips.push(`<span class="kb-chip" title="租户">${esc(t.tenant)}</span>`);
  const wn = t.warnings && Number(t.warnings.count);
  if (wn) chips.push(`<span class="kb-chip warn" title="有诊断告警">${wn} 项告警</span>`);

  // 发丝线下的弱信息行：时间胶囊 · 受让人 · 评论数 · 子任务进度 + 右端状态点。
  const foot = [];
  const asg = kbAssigneeChip(t.assignee);
  if (asg) foot.push(asg);
  const cc = Number(t.comment_count) || 0;
  if (cc) foot.push(`${cc} 评论`);
  const pg = t.progress;
  if (pg && Number(pg.total)) foot.push(`${Number(pg.done) || 0}/${Number(pg.total)} 子任务`);

  // 卡面描述：优先最新执行回报（latest_summary = task_runs.summary），
  // 没跑过 worker 的任务回退到建任务时写的描述 body —— 否则新卡永远是光杆标题。
  const sum = String(t.latest_summary || t.body || '').trim();
  const dragHint = draggable === '1' ? '拖到上方 worker 上可直接指派' : `${st || '该状态'} 不支持拖拽改派`;
  return `<button class="kb-card${KB.detailId === t.id ? ' sel' : ''}" data-kb-task="${esc(t.id)}" data-kb-drag="${draggable}" type="button" title="${esc(t.title || '')}　·　${esc(dragHint)}">
    ${priHtml}
    <div class="kb-card-title">${esc(t.title || '(无标题)')}</div>
    ${sum ? `<div class="kb-card-sum">${esc(clip(sum, 200))}</div>` : ''}
    ${chips.length ? `<div class="kb-card-meta">${chips.join('')}</div>` : ''}
    <div class="kb-card-foot">${whenHtml}${foot.length ? `${whenHtml ? '<i aria-hidden="true">·</i>' : ''}${foot.join('<i aria-hidden="true">·</i>')}` : ''}<span class="kb-card-dot" aria-hidden="true"></span></div>
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
  if (nameEl) nameEl.textContent = name;
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
        ? `<div class="kb-empty-state"><h2>没有匹配的任务</h2><p>试试清空搜索、切换分组或放宽受让人筛选。</p></div>`
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
        <div class="kb-col-head"><span class="kb-col-name">${esc(g.label)}</span>
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
  return { shown, total };
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
}

/* ---- 任务详情抽屉 ---- */
function closeKanbanDrawer() {
  const d = $('#kb-drawer'), m = $('#kb-drawer-mask');
  if (d) d.hidden = true;
  if (m) m.hidden = true;
  KB.detailEpoch += 1;
  KB.detailId = '';
  KB.detail = null;
  document.querySelectorAll('.kb-card.sel').forEach((el) => el.classList.remove('sel'));
}
async function openKanbanTask(id, silent) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return;
  const a = kbApi();
  const my = ++KB.detailEpoch;
  KB.detailId = id;
  const d = $('#kb-drawer'), m = $('#kb-drawer-mask'), body = $('#kb-drawer-body');
  if (!d || !m || !body) return;
  d.hidden = false; m.hidden = false;
  document.querySelectorAll('.kb-card.sel').forEach((el) => el.classList.remove('sel'));
  const card = document.querySelector(`.kb-card[data-kb-task="${id}"]`);
  if (card) card.classList.add('sel');
  if (!silent) body.innerHTML = '<div class="kbd-loading">读取任务详情…</div>';
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
function renderKanbanDetail(d) {
  const body = $('#kb-drawer-body');
  if (!body) return;
  const t = d.task || {};
  const meta = [];
  // 与卡片一致：显示归组后的中文状态，CLI 原值留在 title 里，免得同一个 triage
  // 在卡片上叫「收集箱」、在抽屉里叫「triage」
  if (t.status) meta.push(`<span class="kb-chip st" title="CLI 状态：${esc(t.status)}">${esc(KB_STATUS_LABEL[t.status] || t.status)}</span>`);
  if (Number(t.priority)) meta.push(`<span class="kb-chip pri">P${Number(t.priority)}</span>`);
  if (t.assignee) meta.push(kbAssigneeChip(t.assignee));
  if (t.tenant) meta.push(`<span class="kb-chip">${esc(t.tenant)}</span>`);
  if (t.created_at) meta.push(`<span class="kb-chip">创建 ${esc(kbTime(t.created_at))}</span>`);
  if (t.completed_at) meta.push(`<span class="kb-chip">完成 ${esc(kbTime(t.completed_at))}</span>`);

  const jump = /^[A-Za-z0-9_-]{1,80}$/.test(String(t.session_id || ''))
    ? `<div class="kbd-section"><button class="kbd-link" type="button" data-kb-session="${esc(t.session_id)}">↗ 跳转到关联会话 ${esc(String(t.session_id).slice(0, 12))}…</button></div>` : '';
  // 工作区：worker 实际在哪干活。scratch/dir/worktree 三种；绑了项目的任务
  // 由 CLI 自动派生 worktree（<repo>/.worktrees/<任务id>），不绑就是一次性沙箱。
  const WS_KIND_LABEL = {
    scratch: '临时沙箱（scratch，完成后自动清理）',
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
    ['工作区路径', t.workspace_path ? String(t.workspace_path) : ''],
    ['分支', t.branch_name ? String(t.branch_name) : ''],
    ['所属项目', t.project_id ? (projMap[String(t.project_id)] || String(t.project_id)) : '（未绑定）'],
  ].filter((r) => r[1]);
  const wsHtml = `<div class="kbd-section"><h3>工作区</h3><ul class="kbd-list">${
    wsRows.map((r) => `<li class="kbd-row">${esc(r[0])} <span class="kbd-val">${esc(r[1])}</span></li>`).join('')
  }</ul></div>`;
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
  const canSubmit = canDelete && KB_DP_SUBMITTABLE.includes(String(t.status || ''));
  const dispatchAct = canSubmit
    ? `<div class="kbd-actions" id="kbd-actions"><button class="kb-btn kb-btn-accent" type="button" data-kb-submit="${esc(t.id)}">⚡ 提交派发</button>
        <span>推进到 ready，等待调度器认领</span></div>` : '';
  // 改派：拖拽的等价入口（拖拽仍在，但抽屉里要有不靠鼠标的路径）。
  // done / archived 再改派没有意义，直接不显示。
  const canReassign = canDelete && !['done', 'archived'].includes(String(t.status || ''));
  const reassignAct = canReassign
    ? `<div class="kbd-section" id="kbd-reassign"><h3>改派受让人</h3>
        <div class="kbd-reassign">
          <hm-select id="kbd-assignee" class="ui-select" aria-label="改派受让人"></hm-select>
          <button class="kb-btn" type="button" data-kb-reassign="${esc(t.id)}">保存改派</button>
        </div>
        <div class="kbd-reassign-note" id="kbd-reassign-note">受让人 = Hermes profile 名，派发时用 <code>hermes -p &lt;名字&gt;</code> 启动 worker；留空表示取消指派。</div>
      </div>` : '';

  body.innerHTML = `
    <div class="kbd-id">${esc(t.id || '')}</div>
    <h2 class="kbd-title">${esc(t.title || '(无标题)')}</h2>
    <div class="kbd-meta">${meta.join('')}</div>
    ${dispatchAct}
    ${reassignAct}
    ${wsHtml}
    ${jump}
    ${t.body ? `<div class="kbd-section"><h3>描述</h3><pre class="kbd-text">${esc(clip(t.body, 12000))}</pre></div>` : ''}
    ${t.result || t.latest_summary ? `<div class="kbd-section"><h3>结果 / 交接</h3><pre class="kbd-text">${esc(clip(t.result || t.latest_summary, 12000))}</pre></div>` : ''}
    <div class="kbd-section"><h3>依赖 (${(links.parents || []).length + (links.children || []).length})</h3>
      ${linkRows ? `<ul class="kbd-list">${linkRows}</ul>` : '<div class="kbd-empty">无父子依赖</div>'}</div>
    <div class="kbd-section"><h3>评论 (${(d.comments || []).length})</h3>
      ${comments ? `<ul class="kbd-list">${comments}</ul>` : '<div class="kbd-empty">暂无评论</div>'}</div>
    <div class="kbd-section"><h3>运行记录 (${(d.runs || []).length})</h3>
      ${runs ? `<ul class="kbd-list">${runs}</ul>` : '<div class="kbd-empty">尚无运行记录</div>'}</div>
    ${atts ? `<div class="kbd-section"><h3>附件</h3><ul class="kbd-list">${atts}</ul></div>` : ''}
    <div class="kbd-section"><h3>最近事件</h3>
      ${events ? `<ul class="kbd-list">${events}</ul>` : '<div class="kbd-empty">暂无事件</div>'}</div>
    ${canDelete ? `<div class="kbd-danger" id="kbd-danger"><button class="kb-btn danger" type="button" data-kb-delete="${esc(t.id)}">删除任务</button></div>` : ''}`;

  // 改派下拉的候选：磁盘上真实存在的 profile 优先；当前受让人即使不在清单里也要能显示出来
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
  const max = Math.max(1, Math.min(4, Number($('#kb-dp-max') && $('#kb-dp-max').value) || 1));
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
  const panel = $('#kb-dispatch-panel');
  const on = !!show;
  KB.dispatch.open = on;
  KB.dispatch.epoch += 1; // 收起时作废所有在途响应
  kbDpClearConfirm();
  if (panel) panel.hidden = !on;
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
  const max = Math.max(1, Math.min(4, Number($('#kb-dp-max') && $('#kb-dp-max').value) || 1));
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
function kbSetBackgroundInert(on) {
  // 弹窗在 #frame 内，不能用 frame.inert，否则会把自己也锁住；
  // 只把看板主体移出交互树，遮罩与弹窗保持可聚焦。
  const sels = ['.kb-head', '.kb-stats', '.kb-dispatch', '.kb-statusbar', '.kb-toolbar', '.kb-dock',
    '.kb-dock-confirm', '.kb-scroll', '.kb-drawer', '.kb-drawer-mask', '.kb-message'];
  const wrap = $('#kanban-page .kb-wrap');
  if (!wrap) return;
  sels.forEach((s) => wrap.querySelectorAll(s).forEach((el) => { el.inert = on; }));
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
    ? '就绪状态可能被运行中的调度器立即认领并派发给 agent 执行，请确认后再创建。'
    : '收集箱不会被派发器直接拉起，但 gateway 的自动分解（kanban.auto_decompose，默认开启）会补全 spec、填受让人并推进到 todo→ready，随后仍会被派发。';
}
/* 官方 project-dialog.tsx 的本地等价：一个弹窗三种模式（create / rename / add-folder）。
   文件夹由主进程原生目录选择器给出，第一个为主；选完自动以 basename 命名项目。 */
const KB_PROJECT_KINDS = ['project', 'project-rename', 'project-add-folder'];
function kbProjectFolderBasename(dir) {
  return String(dir || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
}
/** 重绘文件夹列表：首条标「主」，逐条可移除；路径只走 textContent 落地。 */
function kbRenderProjectFolders() {
  const host = $('#kb-p-folders');
  if (!host) return;
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
      '<button class="kb-pfold-rm" type="button" title="移除" aria-label="移除">×</button>';
    const label = row.querySelector('.kb-pfold-path');
    label.textContent = dir;
    label.title = dir;
    row.querySelector('.kb-pfold-rm').onclick = () => {
      KB.projFolders = KB.projFolders.filter((x) => x !== dir);
      kbRenderProjectFolders();
      kbSyncProjectSubmit();
    };
    host.appendChild(row);
  });
}
/** 官方提交按钮条件：名称非空 + 至少一个文件夹（没有文件夹的项目无法认领会话）。 */
function kbSyncProjectSubmit() {
  if (KB.modal !== 'project' || KB.modalBusy) return;
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
/** 项目行 ⋯ / 侧栏入口统一走这里，避免把弹窗 DOM 搬出看板页。 */
function kbProjectDialog(mode, project) {
  if (mode === 'create') { setSidebar(true); showKanban(true); kbModalOpen('project'); return; }
  const p = project || {};
  KB.projectDialog = {
    mode, projectId: String(p.id || ''), projectName: String(p.label || p.id || ''),
  };
  setSidebar(true); showKanban(true);
  kbModalOpen(mode === 'rename' ? 'project-rename' : 'project-add-folder');
}
function kbModalOpen(kind, presetStatus) {
  const modal = $('#kb-modal'), mask = $('#kb-modal-mask');
  if (!modal || !mask || (kind !== 'task' && kind !== 'board' && kind !== 'bind' && !KB_PROJECT_KINDS.includes(kind))) return;
  KB.modal = kind;
  KB.modalBusy = false;
  KB.modalKey = 'desktop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const taskForm = $('#kb-form-task'), boardForm = $('#kb-form-board'), bindForm = $('#kb-form-bind'), projForm = $('#kb-form-project');
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
  const mode = kind === 'project-rename' ? 'rename' : (kind === 'project-add-folder' ? 'add-folder' : 'create');
  if (kind === 'project') KB.projectDialog = { mode: 'create', projectId: '', projectName: '' };
  if (projForm) { projForm.reset(); projForm.hidden = !isProject; }
  KB.projFolders = [];
  kbRenderProjectFolders();
  const nameRow = $('#kb-p-name-row'), foldersRow = $('#kb-p-folders-row');
  const addBtn = $('#kb-p-add'), createOnly = $('#kb-p-create-only'), addNote = $('#kb-p-addnote');
  if (nameRow) nameRow.hidden = mode === 'add-folder';
  if (foldersRow) foldersRow.hidden = mode !== 'create';
  if (addBtn) {
    addBtn.hidden = mode === 'rename';
    addBtn.textContent = mode === 'add-folder' ? '＋ 选择文件夹…' : '＋ 添加文件夹…';
  }
  if (createOnly) createOnly.hidden = mode !== 'create';
  if (addNote) addNote.hidden = mode !== 'add-folder';
  if (mode === 'rename') {
    const nameEl = $('#kb-p-name');
    if (nameEl) nameEl.value = (KB.projectDialog && KB.projectDialog.projectName) || '';
  }
  kbSyncStatusNote();
  kbSyncProjectSelects();
  const title = $('#kb-modal-title');
  const TITLES = { task: '新建任务', bind: '绑定项目', project: '新建项目', board: '新建看板',
    'project-rename': '重命名项目', 'project-add-folder': '添加文件夹' };
  if (title) title.textContent = TITLES[kind] || '新建';
  kbModalErr('');
  const submit = $('#kb-modal-submit');
  if (submit) {
    submit.disabled = false;
    submit.textContent = kind === 'task' ? '创建任务' : (kind === 'bind' ? '保存绑定' :
      (kind === 'project' ? '创建项目' : (kind === 'project-rename' ? '保存名称' :
        (kind === 'project-add-folder' ? '选择文件夹…' : '创建看板'))));
    // 官方 add-folder 模式没有底部提交按钮：选完目录直接写入
    submit.hidden = kind === 'project-add-folder';
  }
  kbSyncProjectSubmit();
  kbSyncSelects();
  modal.hidden = false; mask.hidden = false;
  kbSetBackgroundInert(true);
  const first = kind === 'task' ? $('#kb-f-title') : (kind === 'bind' ? $('#kb-b-project') :
    (kind === 'project-add-folder' ? $('#kb-p-add') : (isProject ? $('#kb-p-name') : $('#kb-b-slug'))));
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
  const submit = $('#kb-modal-submit');
  if (submit) submit.hidden = false;
  kbSetBackgroundInert(false);
  kbModalErr('');
  // 先解 inert 再 focus（inert 内元素会静默拒绝聚焦）
  const back = $('#kb-new-task');
  try { if (back && !$('#kanban-page').hidden) back.focus({ preventScroll: true }); } catch {}
}
function kbModalSubmit() {
  if (KB.modalBusy || !KB.modal) return Promise.resolve();
  const a = kbApi();
  if (!a || !a.kanbanCreateTask || !a.kanbanCreateBoard) { kbModalErr('此页需要 Hermes 桌面端才能写入看板'); return Promise.resolve(); }
  const kind = KB.modal, key = KB.modalKey;
  let payload;
  if (kind === 'task') {
    const title = ($('#kb-f-title')?.value || '').trim();
    if (!title) { kbModalErr('请填写任务标题'); return Promise.resolve(); }
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
        // 官方 createProject(use:true) + enterProject：建完设为活动项目，并回到项目根开新会话
        const root = payload.folders[0];
        if (root) { closeKanbanPage(); newTabInProject(root); }
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
  if (archived) archived.onchange = () => { KB.filters.archived = !!archived.checked; kanbanLoad(false); };

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
    const del = e.target.closest && e.target.closest('[data-kb-delete]');
    if (del) { kbDeleteTask(del.getAttribute('data-kb-delete'), del.closest('.kbd-danger')); return; }
    const re = e.target.closest && e.target.closest('[data-kb-reassign]');
    if (re) { kbReassignTask(re.getAttribute('data-kb-reassign'), re.closest('.kbd-reassign') || body); return; }
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

setupSettings();

/* ---------- 初始化 ---------- */
async function init() {
  refreshProfileChip(); // 尽早刷新，不受后续会话加载/后端重启阻塞
  applySettings();      // 设置此前只写不读：启动时也要恢复主题/字号/步骤详略
  try { const env = await api.env(); state.env = env; state.config = { ...state.config, ...env.config }; } catch {}
  // env-chip 已按需求移除（侧栏左下角改为齿轮按钮），仅保留 state.env 数据
  await refreshSessions();
  ensureSidebarTree(); // 首屏树若撞上后端冷启失败，后台补拉，不阻塞首屏
  newTab();
  updateStatus();
  if (hasNative) {
    api.onEvent(({ tabId, evt }) => { state.turnTab.set(evt.turnId, tabId); routeEvent(evt); });
    api.onError(({ tabId, message }) => {
      const tab = state.tabs.find((t) => t.id === tabId); if (!tab) return;
      tab.items.push({ kind: 'error', text: message, failure: parseFailure('', message) });
      if (tab.id === state.activeTabId) renderChat();
    });
    api.onClose(handleClose);
    if (api.onApproval) api.onApproval(onApprovalRequest);
    // 迷你聊天窗发出的消息：主窗口只是补数据模型（用户消息是渲染层自己 push 的，
    // 小窗那条绕过了它）。不补的话，回主窗口看到的会是「只有回答、没有提问」。
    if (api.onOrbUserMessage) api.onOrbUserMessage(({ tabId, text }) => {
      if (!tabId || !text) return;
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      tab.items.push({ kind: 'user', text: String(text), ts: Date.now(), fromOrb: true });
      if (tab.id === state.activeTabId) renderChat();
      renderTabs();
    });
    // 小窗里点了「允许 / 拒绝」：主窗口那张卡立刻收口，
    // 否则它 24s 的自动拒绝定时器还会对同一个 requestId 再表一次态。
    // 球下拉选了某个 profile 里的会话：主进程已经先展开主窗，这里只负责
    // 「切 profile（复用既有后端重启链路）」或「直接打开当前 profile 的会话」。
    if (api.onOrbOpenSession) api.onOrbOpenSession((p) => {
      if (!p || !p.profile) return;
      if (p.needsSwitch) {
        // doSwitchProfile 内部会 location.reload()；把待打开会话记到
        // sessionStorage，重载后由 init() 末尾消费（只在本窗口生命周期有效）。
        try {
          sessionStorage.setItem('orb:open-session', JSON.stringify({
            profile: p.profile, sessionId: p.sessionId || '', at: Date.now(),
          }));
        } catch {}
        doSwitchProfile(p.profile);
        return;
      }
      if (p.sessionId) openSession(p.sessionId);
    });
    if (api.onOrbApprovalResolved) api.onOrbApprovalResolved(({ requestId, choice }) => {
      if (!requestId) return;
      for (const tab of state.tabs) {
        const it = tab.items.find((i) => i.kind === 'approval' && i.requestId === requestId);
        if (it && !it.choice) {
          it.choice = choice === 'deny' ? 'deny' : 'approve';
          if (tab.id === state.activeTabId) renderChat();
        }
      }
    });
    // 菜单「消息平台」是整页入口，不再被 serve 状态文字覆盖
  }
  syncComposerState();
  // 非阻断：启动即核对桌面端模型与 CLI 默认是否漂移；切 profile 会 reload 重跑
  syncModelDrift(true);
  // 球下拉里选了别的 profile 的会话：doSwitchProfile 重载后在这里补上打开动作。
  // 带 30s 时效，避免切换失败时残留到下次启动莫名其妙打开旧会话。
  try {
    const raw = sessionStorage.getItem('orb:open-session');
    if (raw) {
      sessionStorage.removeItem('orb:open-session');
      const p = JSON.parse(raw);
      if (p && p.sessionId && Number.isFinite(p.at) && Date.now() - p.at < 30000) {
        openSession(p.sessionId);
      }
    }
  } catch {}
}
init();
