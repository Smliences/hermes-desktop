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

/* ══════════ 工具行 ══════════
   直接照搬运 WorkBuddy 的 single-line-tool-header：一行五段
     [图标 14px] [状态词] [对象] [次要信息] [箭头 16px]
   拦包看过它的实现（renderer/assets/src-*.css + i18n 的 tool.* 表），要点：
   · 状态词不是一个泛泛的「完成」，每类工具各有一套三态词（读取 / 已读取 / 读取失败）；
   · 运行中的状态词走渐变扫光（background-clip:text + 2.2s 线性往复），不是转圈图标；
   · 箭头默认朝右（rotate(-90deg)），展开转正朝下；WorkBuddy 里 hover 才显，这里改成常显；
   · 折叠只切 card-content 的 hidden，行本身不做动画。
   图标按工具类型分（读/写/命令/搜索/列表/网页/生成/派发/清单/记忆），lucide 线性字形。 */
const TOOL_ICONS = {
  read: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"></circle><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"></circle></svg>',
  write: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.1 2.4a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5 2.4 13.4l.9-3.2Z"></path><path d="M9.9 3.6a1.6 1.6 0 0 1 2.3 2.3"></path></svg>',
  create: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.4 2.1H4.6c-.8 0-1.5.7-1.5 1.5v8.8c0 .8.7 1.5 1.5 1.5h6.8c.8 0 1.5-.7 1.5-1.5V5.6Z"></path><path d="M9.3 2.2v3.5h3.6"></path><path d="M8 8.1v3.4M6.3 9.8h3.4"></path></svg>',
  cmd: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.7" width="12.4" height="10.6" rx="2.1"></rect><path d="M4.9 6.4 6.5 8 4.9 9.6"></path><path d="M8.4 9.9h2.4"></path></svg>',
  list: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.4 4.2h8.2M5.4 8h8.2M5.4 11.8h8.2"></path><path d="M2.4 4.2h.6M2.4 8h.6M2.4 11.8h.6"></path></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.2" cy="7.2" r="4.9"></circle><path d="m10.9 10.9 2.6 2.6"></path></svg>',
  web: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"></circle><path d="M1.9 8h12.2"></path><path d="M8 1.8c1.7 1.9 2.6 4 2.6 6.2S9.7 12.3 8 14.2C6.3 12.3 5.4 10.2 5.4 8S6.3 3.7 8 1.8Z"></path></svg>',
  gen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 1.9 1.5 4 4 1.5-4 1.5L8 12.9l-1.5-4-4-1.5 4-1.5Z"></path><path d="M12.6 11.4l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7Z"></path></svg>',
  dispatch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.2 1.8 7 9M14.2 1.8 9.6 14.2l-2.6-5.2L1.8 6.4Z"></path></svg>',
  todo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 4.1h7.2M6.6 8h7.2M6.6 11.9h7.2"></path><path d="m2.1 4 1.1 1.1 1.9-2M2.1 8l1.1 1.1L5.1 7"></path></svg>',
  memory: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="8" cy="4" rx="5.6" ry="2.2"></ellipse><path d="M2.4 4v8c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2V4"></path><path d="M2.4 8c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2"></path></svg>',
  ask: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.8 7.3c0 3-2.6 5.4-5.8 5.4-.8 0-1.6-.1-2.3-.4L2.2 13.4l1.2-3a5 5 0 0 1-1-3.1C2.4 4.3 5 1.9 8.2 1.9s5.6 2.4 5.6 5.4Z"></path><path d="M6.3 6.6a1.8 1.8 0 1 1 2.4 1.7c-.4.2-.6.5-.6.9M8 11h.01"></path></svg>',
  unknown: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"></circle><path d="M8 11.2h.01M6.5 6.2a1.6 1.6 0 1 1 2.2 1.5c-.3.1-.5.5-.5.8"></path></svg>',
};
/* 每类工具的三态词，照 WorkBuddy i18n 的 tool.* 表逐条对：它是
   「动作 / 已动作 / 失败了」三种说法，而不是一个笼统的完成态。 */
const TOOL_SPECS = [
  { re: /^(read_file|view_file|cat|skill_view|skills_list|drive_preview|desktop_preview|session_search)/,
    kind: 'read', running: '读取', done: '已读取', error: '读取失败' },
  { re: /^(write_file|apply_layout|annotate_preview)/,
    kind: 'create', running: '生成中', done: '创建', error: '生成失败' },
  { re: /^(patch|edit_file|multi_edit)/,
    kind: 'write', running: '编辑中', done: '编辑', error: '修改失败' },
  { re: /^(terminal|bash|shell|exec_command|run_command|execute_code|process_manage|cronjob_manage)/,
    kind: 'cmd', running: '执行中…', done: '运行成功', error: '执行失败' },
  { re: /^(glob|find_files)/,
    kind: 'search', running: '搜索中', done: '搜索文件', error: '搜索失败' },
  { re: /^(grep|search_files|rg)/,
    kind: 'search', running: '搜索中', done: '搜索文件内容', error: '搜索失败' },
  { re: /^(list_files|ls|tree)/,
    kind: 'list', running: '列出中', done: '已列出', error: '读取失败' },
  { re: /^(web_search|x_search|search_web)/,
    kind: 'web', running: '搜索网页中…', done: '搜索网页', error: '搜索失败' },
  { re: /^(web_fetch|web_extract|http_request|fetch_url)/,
    kind: 'web', running: '读取中', done: '读取网页内容', error: '读取失败' },
  { re: /^browser_/,
    kind: 'web', running: '操作浏览器中', done: '已操作浏览器', error: '浏览器操作失败' },
  { re: /^(image_generate|video_generate|text_to_speech)/,
    kind: 'gen', running: '生成中', done: '已生成', error: '生成失败' },
  { re: /^(vision_analyze|video_analyze)/,
    kind: 'read', running: '分析中', done: '已分析', error: '分析失败' },
  { re: /^(delegate_task|subagent)/,
    kind: 'dispatch', running: '派发中', done: '已派发', error: '派发失败' },
  { re: /^(todo_list|todo_write|update_plan)/,
    kind: 'todo', running: '更新计划中', done: '已更新计划', error: '计划处理失败' },
  { re: /^(memory|memory_store)/,
    kind: 'memory', running: '写入记忆中', done: '已更新记忆', error: '记忆操作失败' },
  { re: /_(ask|question|confirm)$|^ask/,
    kind: 'ask', running: '等待你的回答…', done: '已回答', error: '提问失败' },
];
const TOOL_SPEC_FALLBACK = { kind: 'unknown', running: '执行中', done: '已完成', error: '执行失败' };
/** 对象：这次调用最该被看见的那个参数（文件名取末段、命令取首行、搜索取关键词） */
function toolObject(input) {
  if (!input || typeof input !== 'object') return '';
  const f = input.file_path || input.path || input.filename || input.notebook_path;
  const c = input.command || input.cmd || input.script;
  const q = input.query || input.pattern || input.url || input.skill || input.topic || input.action;
  let obj = '';
  if (f) obj = String(f).split('/').filter(Boolean).pop() || String(f);
  else if (c) obj = String(c).split('\n')[0].replace(/\s+/g, ' ').trim();
  else if (q) obj = String(q).replace(/\s+/g, ' ').trim();
  return obj.length > 60 ? obj.slice(0, 60) + '…' : obj;
}
/** 次要信息：编辑类的增删行数（WorkBuddy 的 +7 −0 就是这一格），其余留空 */
function toolExtra(name, input) {
  if (!input || typeof input !== 'object') return null;
  if (Array.isArray(input.edits) && input.edits.length) return { text: `${input.edits.length} 处修改` };
  const o = input.old_string, n = input.new_string;
  if (typeof o === 'string' && typeof n === 'string') {
    const b = o ? o.split('\n').length : 0;
    const a = n ? n.split('\n').length : 0;
    return { add: Math.max(0, a - b), del: Math.max(0, b - a) };
  }
  return null;
}
/** state: 'running' | 'done' | 'error' —— 三种状态换的是词，不是图标颜色 */
function toolMeta(name, input, state) {
  const n = String(name || '');
  const spec = TOOL_SPECS.find((s) => s.re.test(n)) || TOOL_SPEC_FALLBACK;
  const label = state === 'running' ? spec.running : state === 'error' ? spec.error : spec.done;
  return { icon: TOOL_ICONS[spec.kind] || TOOL_ICONS.unknown, label, obj: toolObject(input), extra: toolExtra(n, input), kind: spec.kind };
}
/** 行级 diff（LCS 回溯）：patch 的 old/new 通常十几行，O(n·m) 足够；
    超过 400×400 就退化成「整段删 + 整段增」，不为超大文件构造表格。 */
function lineDiff(oldText, newText) {
  const A = String(oldText == null ? '' : oldText).split('\n');
  const B = String(newText == null ? '' : newText).split('\n');
  const n = A.length, m = B.length;
  if (n * m > 160000) {
    return [...A.map((s) => ({ t: '-', s })), ...B.map((s) => ({ t: '+', s }))];
  }
  // 从右下角倒推公共子序列长度；Uint16 足够（单文件不会超过 65535 行）
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: A[i] }); i++; }
    else { out.push({ t: '+', s: B[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out;
}
/** WB 的 diff-viewer：一行一条，左侧 16px 竖条（增绿减红），行号条不画，
    行高 18px 与它的 12px×1.5 一致。超过 400 行截断并提示，不塞满 DOM。 */
function toolDiffHTML(oldText, newText) {
  const rows = lineDiff(oldText, newText);
  const CAP = 400;
  const shown = rows.length > CAP ? rows.slice(0, CAP) : rows;
  const body = shown.map((r) => {
    const cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'same';
    return `<div class="dv-row ${cls}"><span class="dv-g"></span><span class="dv-t">${esc(r.s) || '&nbsp;'}</span></div>`;
  }).join('');
  const more = rows.length > CAP
    ? `<div class="dv-more">还有 ${rows.length - CAP} 行未显示</div>` : '';
  return `<div class="dv">${body}${more}</div>`;
}
/** 命令类：WB 的 .execute-command .stdout-content —— 详情里只有输出本身，
    不在详情里重复一遍命令行（命令已经在上面那行里了），无底色无描边。 */
function toolStdoutHTML(item) {
  const out = item.output == null ? '' : String(item.output);
  const fail = !!item.isError;
  // 跑着的命令会自动展开（要让人看到这一步在干什么），但此刻还没有任何输出：
  // 不能写成「运行成功」，也不摆一个只有「执行中…」的空盒子 —— 行上和详情头
  // 已经各说过一次状态了。详情里就只留那一行头。
  if (!out.trim()) {
    if (item.state === 'running') return '';
    return `<div class="stdout-content"><span class="exec-status-text${fail ? ' err' : ''}">${fail ? '执行失败' : '运行成功'}</span></div>`;
  }
  return `<div class="stdout-content"><pre class="content${fail ? ' err-text' : ''}">${esc(clip(out, 20000))}</pre></div>`;
}
/** 详情内容：照 WB 的三个渲染器分流，而不是一套 JSON 走天下 ——
    · 编辑类（patch/写文件）→ diff（WB 的 diff-viewer，绿增红删 + 竖条）
    · 命令类（terminal/bash）→ 整块 stdout（WB 的 ExecuteCommandRenderer）
    · 其余 → Arguments / Result 两段格式化 JSON（WB 的 DefaultToolRenderer）
    段结构沿用 WB：.detail-section > .detail-label + .detail-content（pre）。 */
function toolDetailHTML(item) {
  const name = String(item.name || '');
  const input = item.input;
  const isEdit = /^(patch|edit_file|multi_edit|apply_layout|annotate_preview)/.test(name);
  const isWrite = /^write_file/.test(name);
  const isCmd = /^(terminal|bash|shell|exec_command|run_command|execute_code|process_manage|cronjob_manage)/.test(name);
  const sec = (label, body) =>
    `<div class="detail-section"><div class="detail-label">${esc(label)}</div>${body}</div>`;

  if (isCmd) return toolStdoutHTML(item);

  let html = '';
  if (isEdit && input && typeof input === 'object') {
    if (Array.isArray(input.edits) && input.edits.length) {
      html += input.edits.map((e, i) => sec(`修改 ${i + 1}/${input.edits.length}`,
        toolDiffHTML(e && e.old_string, e && e.new_string))).join('');
    } else if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      html += sec('改动', toolDiffHTML(input.old_string, input.new_string));
    }
  } else if (isWrite && input && typeof input.content === 'string') {
    html += sec('新内容', toolDiffHTML('', input.content));
  }
  // 参数：没走 diff 的工具才铺参数，且用格式化 JSON（WB 的 DefaultToolRenderer 就是
  // JSON.stringify(args, null, 2)）—— 上一版的两列键值虽然好读，但不是 WB 的形态。
  if (!html && input != null && input !== '') {
    html += sec('参数', `<pre class="detail-content">${esc(clip(safeStringify(input), 12000))}</pre>`);
  }
  if (item.output != null) {
    const out = String(item.output);
    if (out.trim()) {
      html += sec('输出', `<pre class="detail-content${item.isError ? ' err-text' : ''}">${esc(clip(out, 20000))}</pre>`);
    }
  }
  return html;
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
  booted: false,            // 会话列表是否已成功落地过一次（false = 首屏骨架 + 后端启动提示）
  bootError: '',            // 首屏拉取失败的原因（骨架里显示，便于区分「慢」和「挂了」）
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
  syncComposerProject(); // 项目下拉按当前页签的 cwd 回填
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
  // 只看通道是否存在：浏览器 Demo 桥也实现了 projectsTree，别用 hasNative 把它挡在门外
  const treeP = (typeof api.projectsTree === 'function')
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
      .filter((s) => !q || sessionLabel(s).toLowerCase().includes(ql) || String(s.id).toLowerCase().includes(ql) || s.fulltext)
      .slice(0, 80);
    // 后端冷启（CLI 常要 5~12s）会晚于首屏：树请求失败时保留上一次的分组，不把侧栏刷空，
    // 并用 projectsTreeOk 标记给启动自愈判断是否还要重试。成功才覆盖树。
    if (treeR && treeR.ok) {
      state.projectsTree = sidebarProjectNodes(treeR.projects);
      state.projectsTreeOk = true;
    } else {
      state.projectsTreeOk = false;
    }
    syncComposerProject(); // 树刷新后同步候选（冷启自愈落地时也走这里）
    // 有数据 = 后端确实答了话，首屏可以收骨架；空列表则等连接状态或下一次重试来确认。
    // 这里不调 bootSettled()：它会再补拉一次列表，而本次结果就是最新的。
    if (state.sessions.length && !state.booted) {
      state.booted = true;
      bootRetry = 0;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    }
    state.bootError = '';
    renderSessions(q);
    if (!state.booted) ensureSidebarBoot();
  } catch (e) {
    state.projectsTreeOk = false;
    state.bootError = (e && e.message) || '会话列表读取失败';
    console.warn('sessions', e);
    if (!state.booted) { renderSessions(currentSearch()); ensureSidebarBoot(); }
  }
}
/** 后端冷启（gateway 常需 5~12s）会晚于首屏：树接口失败时按退避重试，直到项目分组落地。
 *  独立拉树、成功即落地并重绘侧栏，不与会话列表的并发代次（sessionsSeq）互相拖累。 */
let sidebarTreeRetry = 0;
function ensureSidebarTree() {
  if (typeof api.projectsTree !== 'function') return;
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
      try { renderSessions(currentSearch()); syncComposerProject(); } catch {}
      return;
    }
    ensureSidebarTree();
  }, Math.min(1000 + n * 800, 3500));
}
/* ---------- 窗口重新获得焦点：补齐「后端侧发生的变化」 ----------
   项目树与会话列表只在启动和本地操作后刷新，终端里 `hermes project create`、
   或别的窗口新建的会话，切回来是看不到的。聚焦补一次，但要防抖（避免切来切去
   反复重建列表）并保住滚动位置。 */
const FOCUS_REFRESH_MS = 6000;
// 启动时的首屏刷新算作一次，别让紧接着的 focus 立刻再拉一遍
let lastFocusRefresh = Date.now();
let focusRefreshBusy = false;
function refreshOnFocus() {
  if (document.hidden) return;
  const now = Date.now();
  if (focusRefreshBusy || (lastFocusRefresh && now - lastFocusRefresh < FOCUS_REFRESH_MS)) return;
  lastFocusRefresh = now;
  focusRefreshBusy = true;
  const ul = $('#session-list');
  const top = ul ? ul.scrollTop : 0;
  Promise.resolve(refreshSessions(currentSearch()))
    .catch(() => {})
    .then(() => {
      // renderSessions 重建了整个列表，滚动位置要还回去（越界时浏览器会自己夹住）
      if (ul) ul.scrollTop = top;
      focusRefreshBusy = false;
      ensureSidebarTree();
    });
}
/* ---------- 首屏启动骨架 ----------
   CLI 冷启要 5~7.5s、gateway 10~15s，而首屏一开始就 await 会话列表：这段时间侧栏
   是一片空白，看起来像「没有历史会话」而不是「还在启动」。这里在列表区先铺骨架 + 一句
   状态说明，等后端真的可用（或列表已带回数据）再收掉；期间按退避重试拉列表，
   因为「后端还没起来」和「真的一条会话都没有」在界面上必须是两种东西。 */
let bootRetry = 0;
let bootTimer = null;
function bootSettled() {
  if (state.booted) return;
  state.booted = true;
  state.bootError = '';
  bootRetry = 0;
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  try { renderSessions(currentSearch()); } catch {}
  // 骨架收起后补拉一次：后端刚 ready 的那一刻，列表可能还是上一次的失败结果
  try { refreshSessions(currentSearch()).catch(() => {}); } catch {}
}
function ensureSidebarBoot() {
  if (state.booted || currentSearch()) return;
  if (bootRetry >= 12) {
    // 约 30s 还没答案就停下：一直转下去比承认「慢」更像卡死
    if (!state.bootError) {
      state.bootError = '后端启动超时';
      try { renderSessions(currentSearch()); } catch {}
    }
    return;
  }
  const n = ++bootRetry;
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = setTimeout(async () => {
    bootTimer = null;
    if (state.booted) return;
    try { await refreshSessions(currentSearch()); } catch {}
  }, Math.min(1200 + n * 500, 3000));
}
/** 骨架里的两行文案：慢、断开、超时是三种情况，不能都写成「正在启动」。 */
function bootCopy() {
  if (!state.bootError) return ['正在启动本地后端…', '首次启动要拉起 hermes serve，通常 5–15 秒'];
  if (state.bootError === '后端启动超时') return ['后端启动较慢', '仍在等待；可点左下角状态点重连，或稍后再试'];
  return ['后端未连接', '桌面端会自动重试，也可以点左下角状态点手动重连'];
}
function renderSidebarSkeleton(ul) {
  const [title, sub] = bootCopy();
  const head = document.createElement('li');
  head.className = 's-boot';
  head.setAttribute('role', 'presentation');
  const t = document.createElement('span');
  t.className = 's-boot-title';
  t.textContent = title;
  const s = document.createElement('span');
  s.className = 's-boot-sub';
  s.textContent = sub;
  head.append(t, s);
  ul.appendChild(head);
  for (let i = 0; i < 4; i++) {
    const li = document.createElement('li');
    li.className = 's-skel';
    li.setAttribute('role', 'presentation');
    li.setAttribute('aria-hidden', 'true');
    // 逐条错相，四条骨架不会像一块整体在闪
    li.style.setProperty('--i', String(i));
    const dot = document.createElement('span'); dot.className = 's-skel-dot';
    const bar = document.createElement('span'); bar.className = 's-skel-bar';
    li.append(dot, bar);
    ul.appendChild(li);
  }
}

/* ---------- 后端连接状态 ----------
   gateway 掉线过去只在「下一次操作失败」时以 toast 出现，用户看到的是一堆「连接已重置」，
   却不知道原因。这里把主进程推来的状态落成侧栏底部一个点：绿=可用、蓝=正在连、
   红=断开（点击重连）。状态只反映事实，不主动探测端口。 */
const CONN_TEXT = { ready: '已连接', connecting: '连接中', offline: '已断开' };
function renderConnStatus(st) {
  const btn = $('#btn-conn');
  if (!btn) return;
  const s = st || {};
  // 局部量别叫 state：外层还有一个全局 state（会话/页签模型），重名会把 booted 写丢
  let mode = 'connecting';
  if (s.connected) mode = 'ready';
  else if (s.state === 'error' || s.state === 'idle' || s.state === 'stopped') mode = 'offline';
  // serve 已就绪、但 WS 还没建立过（空闲启动后一条 RPC 都没发）＝ 正常待用，不是故障：
  // 会话列表读 SQLite、项目树走短连 HTTP，首轮对话才会建 WS。这里若报「连接中」，
  // 用户会在完全健康的空闲态看到一个永远转不完的蓝点。
  else if (s.state === 'ready' && !s.linked) mode = 'ready';
  btn.dataset.state = mode;
  // 后端刚可用 = 首屏骨架该收起了：即使一条会话都没有，也已经是确定答案
  // （首次装机的空列表和「还没拉回来」在界面上必须是两种东西）
  if (mode === 'ready' && !state.booted) bootSettled();
  else if (mode === 'offline' && !state.booted) { state.bootError = '后端未连接'; renderSessions(currentSearch()); }
  // 已经建立过长连接再补拉：此时取目录零成本；空闲启动不为它去唤醒 serve
  if (mode === 'ready' && s.linked && !cliCatalog.ok && typeof loadCliCatalog === 'function') loadCliCatalog();
  const label = CONN_TEXT[mode] || '未知';
  const txt = btn.querySelector('.sb-conn-text');
  if (txt) txt.textContent = label;
  const portTxt = s.port ? `（端口 ${s.port}）` : '';
  btn.title = mode === 'ready'
    ? (s.connected ? `后端已连接${portTxt}` : `后端已就绪${portTxt || '，'}，对话时按需建立长连接`)
    : (mode === 'offline' ? '后端未连接，点击重连' : '正在连接后端…');
  btn.setAttribute('aria-label', '后端' + label);
}
function initConnStatus() {
  const btn = $('#btn-conn');
  if (!btn) return;
  if (typeof api.onBackendStatus === 'function') {
    try { api.onBackendStatus(renderConnStatus); } catch { /* 订阅失败不影响主流程 */ }
  }
  const pull = () => {
    if (typeof api.backendStatus !== 'function') return;
    Promise.resolve(api.backendStatus()).then(renderConnStatus).catch(() => {});
  };
  pull();
  let busy = false;
  btn.onclick = async () => {
    if (busy) return;
    // 已连接时点一下只是复查，不做破坏性动作（用户可能是想确认状态）
    if (btn.dataset.state === 'ready') { pull(); toast('后端连接正常', 1400); return; }
    busy = true;
    btn.dataset.state = 'connecting';
    const txt = btn.querySelector('.sb-conn-text');
    if (txt) txt.textContent = '重连中';
    let r = null;
    try { r = await api.reconnectBackend(); }
    catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    busy = false;
    if (r && r.ok) toast('后端已重新连接', 1800);
    else toast('重连失败：' + ((r && r.error) || '未知错误'), 3200);
    pull();
  };
}
function initFocusRefresh() {
  window.addEventListener('focus', refreshOnFocus);
  // 切标签页回来时 focus 不一定会触发，可见性变化要单独接一次
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshOnFocus(); });
}
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
  const dt = s.started_at ? new Date(s.started_at * 1000) : null;
  const when = dt ? `${dt.getMonth() + 1}/${dt.getDate()}` : '';
  // 键盘可达：列表项与 ⋯ 入口原本都是纯 li/span，鼠标以外完全无法操作
  li.setAttribute('role', 'option');
  li.setAttribute('tabindex', '0');
  li.setAttribute('aria-selected', tab && s.id === tab.sessionId ? 'true' : 'false');
  li.innerHTML = `<span class="s-main"><span class="s-title">${hlMark(sessionLabel(s), query)}</span>` +
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
    gl.className = 's-group s-proj';
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
  const rows = targets.length
    ? targets.map((p, i) => `<button data-move="${i}" title="${esc(p.path || '')}">📁 ${esc(p.label || p.id)}</button>`).join('')
    : '<button disabled>没有其他可移入的项目</button>';
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
}

/* ---------- 渲染：聊天流 / 轨迹 ---------- */
/* ---------- 新会话落地页：时段问候 + 快捷开始 ----------
   四个 chip 全部是已接线的真实入口；「看看指令」把输入框填成 / 直接拉起
   内联指令菜单，与 placeholder 的承诺一一对应。事件走 #landing 委托。 */
const LANDING_ACTIONS = {
  slash: () => {
    const inp = $('#input');
    inp.value = '/'; autoGrow(); updateCount();
    inp.focus();
    slashSync();
  },
  kanban: () => showKanban(true),
  model: () => openModelPicker(),
  project: () => kbProjectDialog('create'),
};
function landingGreet() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了，想做点什么？';
  if (h < 12) return '早上好，今天想做点什么？';
  if (h < 14) return '中午好，想做点什么？';
  if (h < 18) return '下午好，想做点什么？';
  return '晚上好，想做点什么？';
}
function renderLanding() {
  $('#landing').innerHTML = `
    <div class="landing-inner">
      <div class="landing-greet">${esc(landingGreet())}</div>
      <div class="landing-chips" role="toolbar" aria-label="快捷开始">
        <button class="landing-chip" data-landing="slash">/ 看看指令</button>
        <button class="landing-chip" data-landing="kanban">打开看板</button>
        <button class="landing-chip" data-landing="model">切换模型</button>
        <button class="landing-chip" data-landing="project">新建项目会话</button>
      </div>
    </div>`;
}
$('#landing').addEventListener('click', (e) => {
  const chip = e.target.closest && e.target.closest('[data-landing]');
  if (!chip) return;
  const fn = LANDING_ACTIONS[chip.dataset.landing];
  if (fn) fn();
});

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
  // 每条 assistant 的脚注先攒着，等这一轮（下一条 user 消息之前）结束再统一挂一次：
  // 位置代表「这一整轮回复」，所以文本和 token 都按整轮累加，复制拿到的也是完整回复。
  let tail = null;      // 本轮最后追加的节点，脚注挂在它后面
  let acc = null;       // { text: [], tokens, ts, turnMs, tps }
  const flushTurnFoot = () => {
    if (acc) {
      const merged = {
        kind: 'assistant',
        text: acc.text.join('\n\n'),
        tokens: acc.real ? acc.tokens : 0,
        ts: acc.ts,
        turnMs: acc.turnMs,
        tps: acc.tps,
      };
      const tpl = document.createElement('div');
      tpl.innerHTML = msgActionBar(merged, false);
      const foot = tpl.firstElementChild;
      if (foot) {
        foot._item = merged;
        if (tail && tail.parentNode) tail.after(foot);
        else chat.appendChild(foot);
      }
    }
    acc = null;
    tail = null;
  };
  for (let i = 0; i < items.length; ) {
    const it = items[i];
    if (it.kind === 'tool') {
      const wrap = document.createElement('div');
      wrap.className = 'tool-stream';
      if (showHeads && prevKind === 'user') wrap.appendChild(turnHeadEl());
      // 连续 ≥2 次调用才收成「执行 N 步」的父行（单次不加一层壳）；
      // 轨迹视图是逐条排查用的，保持平铺，不做折叠。
      const run = [];
      while (i < items.length && items[i].kind === 'tool') { run.push(items[i]); i++; }
      if (run.length > 1 && state.view !== 'trace') wrap.appendChild(stepGroupEl(run));
      else for (const t of run) wrap.appendChild(renderItem(t));
      chat.appendChild(wrap);
      tail = wrap;
      prevKind = 'tool';
    } else {
      if (it.kind === 'user') flushTurnFoot();
      const head = showHeads && it.kind === 'assistant' && prevKind === 'user';
      const el = renderItem(it, head);
      chat.appendChild(el);
      if (it.kind === 'assistant') {
        acc = acc || { text: [], tokens: 0, real: true, ts: 0, turnMs: 0, tps: 0 };
        if (it.text) acc.text.push(it.text);
        // 整轮 token 只在每条都是真实值时才相加；有一条是估算就整轮交给 msgTokens 估，
        // 免得把「估的数」显示成「真实用量」。
        if (it.tokens > 0) acc.tokens += it.tokens; else acc.real = false;
        if (it.ts) acc.ts = it.ts;
        if (it.turnMs) acc.turnMs = it.turnMs;
        if (it.tps) acc.tps = it.tps;
      }
      tail = el;
      prevKind = it.kind; i++;
    }
  }
  flushTurnFoot();
  if (tab.running && tab.showTyping) {
    chat.appendChild(typingIndicator(tab, showHeads && prevKind === 'user'));
  }
  const hasContent = tab.items.some((i) => i.kind !== 'landing');
  // 用 hidden 属性而非 style.display：全局 [hidden]{display:none!important} 会让
  // style.display='' 永远无法让 landing 显示出来。
  $('#landing').hidden = hasContent || state.view === 'trace';
  if (!$('#landing').hidden) renderLanding();
  // 空会话：问候 + 输入框作为一组垂直居中（#main.empty 布局）
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
/** 连续调用的父行：WB 的 task-compact 树形头部 —— 一行说清「跑了几步、都是些什么」，
    点开才铺开缩进的子项，子项自己仍能展开看详情（那就是第三层）。
    WB 的多级本来就来自 Task 子代理（父 = 子代理、子 = 它内部调用的工具），
    但 CLI 的 tool.start / tool.complete 是扁平事件、没有 parent 字段，
    所以层级建在「一轮里的连续调用」上，视觉与交互沿用它的那一套。
    默认展开条件：跑着或有失败（否则看不到进度），全部成功就收成一行。 */
const STEP_ICO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.4 4.2h3.2M2.4 8h3.2M2.4 11.8h3.2"></path><path d="M8.6 4.2h5M8.6 8h5M8.6 11.8h5"></path></svg>';
/** 父行摘要用的短类型词（两个汉字），跟行上的三态词是两套：后者带时态不能拼句 */
const STEP_BRIEF = {
  read: '读取', write: '编辑', create: '写入', cmd: '运行', search: '搜索',
  list: '列举', web: '网页', gen: '生成', dispatch: '派发', todo: '计划',
  memory: '记忆', ask: '提问', unknown: '调用',
};
function stepGroupEl(list) {
  const wrap = document.createElement('div');
  const running = list.some((t) => t.state === 'running');
  const failed = list.some((t) => t.isError);
  const state = running ? 'running' : failed ? 'error' : 'done';
  wrap.className = `step-group ${state}`;
  let open = list[0].groupOpen;
  if (typeof open !== 'boolean') open = running || failed;

  // 摘要 = 各步动作去重（读取、编辑、运行），最多三个。
  // 用类型词而不是三态词：「已读取」这类带时态的词拼成一句话读不通，也太长。
  const verbs = [];
  let errCount = 0;
  let totalMs = 0;
  for (const t of list) {
    const v = STEP_BRIEF[toolMeta(t.name, t.input, 'done').kind] || '调用';
    if (!verbs.includes(v)) verbs.push(v);
    if (t.isError) errCount++;
    if (t.durationMs > 0) totalMs += t.durationMs;
  }
  const brief = verbs.slice(0, 3).join('、') + (verbs.length > 3 ? '等' : '');
  const headText = `${running ? '正在执行' : '执行了'} ${list.length} 步`;
  const groupMeta = errCount > 0
    ? `<span class="tmeta"><i class="td">${errCount} 失败</i></span>`
    : (!running && totalMs >= 100 ? `<span class="tmeta">${(totalMs / 1000).toFixed(1)}s</span>` : '');

  wrap.innerHTML = `<div class="step-head ${state}" role="button" tabindex="0" aria-expanded="${open}" title="${esc(list.map((t) => t.name).join(' · '))}">
      <span class="ticon" aria-hidden="true">${STEP_ICO}</span>
      <span class="tstate${running ? ' loading-text' : ''}">${headText}</span>
      <span class="tobj">${esc(brief)}</span>
      ${groupMeta}
      <span class="tchev" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6.5 4 4 4-4"></path></svg></span>
    </div>`;
  const body = document.createElement('div');
  body.className = 'step-body' + (open ? '' : ' hidden');
  for (const t of list) body.appendChild(renderItem(t, false, true));
  wrap.appendChild(body);
  wrap.classList.toggle('open', open);

  const head = wrap.querySelector('.step-head');
  const toggle = () => {
    open = !open;
    list[0].groupOpen = open; // 记住用户的选择，重绘不丢
    wrap.classList.toggle('open', open);
    body.classList.toggle('hidden', !open);
    head.setAttribute('aria-expanded', String(open));
  };
  head.onclick = toggle;
  head.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  };
  return wrap;
}
function renderItem(item, header = false, sub = false) {
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
    el.innerHTML = `${meta}<div class="content md">${renderMarkdown(item.text)}${cursor}</div>`;
    // 脚注（N tok / 时间 / 复制）不挂在正文下面：一轮里正文之后还跟着工具调用，
    // 挂在中间正好把「正文 → 步骤」切开（用户 2026-11-14 要求挪到结束）。
    // 交给 renderChat 收到整轮末尾再挂，并按整轮合并文本与用量。
    el._footHTML = msgActionBar(item, false);
  } else if (item.kind === 'tool') {
    /* WorkBuddy 的 single-line-tool-header：图标 · 状态词 · 对象 · 次要信息 · 箭头。
       状态词随三态换（读取 / 已读取 / 读取失败），运行中走渐变扫光而不是转圈；
       折叠只切 .card-content 的 hidden，行本身不动画。 */
    const running = item.state === 'running';
    const state = running ? 'running' : item.isError ? 'error' : 'done';
    /* 自动展开只给「跑着的或失败的」：跑着要能看到在干什么，失败要能直接读到错因；
       成功的立刻收成一行，不占版面。item.open 只在用户点过之后才有值，那之后就听用户的。 */
    let open = typeof item.open === 'boolean' ? item.open : (running || !!item.isError);
    el.className = 'tool-item' + (sub ? ' sub' : '') + (open ? ' open' : '');
    const meta = toolMeta(item.name, item.input, state);
    const dur = item.durationMs ? (item.durationMs / 1000).toFixed(1) + 's' : '';
    const extra = meta.extra
      ? `<span class="tmeta">${meta.extra.text ? esc(meta.extra.text)
        : `<i class="ta">+${meta.extra.add}</i><i class="td">−${meta.extra.del}</i>`}</span>`
      : (!running && dur ? `<span class="tmeta tmeta-dur">${esc(dur)}</span>` : '');
    // 详情可能是空串（跑着的命令还没有输出）：那时只留详情头，不塞「暂无」占位
    const detailHTML = toolDetailHTML(item);
    el.innerHTML = `<div class="tool-row collapsible ${state}" role="button" tabindex="0" aria-expanded="${open}" title="${esc(item.name || '')}">
        <span class="ticon" aria-hidden="true">${meta.icon}</span>
        <span class="tstate${running ? ' loading-text' : ''}">${esc(meta.label)}</span>
        ${meta.obj ? `<span class="tobj">${esc(meta.obj)}</span>` : ''}
        ${extra}
        <span class="tchev" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6.5 4 4 4-4"></path></svg></span></div>
      <div class="tool-detail card-content${open ? '' : ' hidden'}">
        <div class="tool-detail-head">
          <span class="tdh-name">${esc(item.name || '工具')}</span>
          <span class="tdh-state ${state}">${running ? '执行中' : item.isError ? '失败' : '完成'}${dur ? ' · ' + dur : ''}</span>
        </div>
        ${detailHTML || (running ? '' : '<div class="detail-section"><div class="detail-label">详情</div><pre class="detail-content">暂无</pre></div>')}
      </div>`;
    // 局部切 class 而不是整页 renderChat：详情是静态 HTML，不需要重绘；
    // 更重要的是键盘展开时焦点能留在这条工具行上。
    const row = el.querySelector('.tool-row');
    const body = el.querySelector('.card-content');
    const toggle = () => {
      open = !open;
      item.open = open;       // 点过就固化成用户的选择，之后不再被状态派生改写
      el.classList.toggle('open', open);
      body.classList.toggle('hidden', !open);
      row.setAttribute('aria-expanded', String(open));
    };
    row.onclick = toggle;
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    };
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
  } else if (item.kind === 'command') {
    // 命令卡片：CLI 斜杠命令的结果。等宽输出 + 顶部命令行，和 agent 正文分开，
    // 一眼能看出「这是我敲的命令，不是模型说的话」。
    el.className = 'msg msg-command';
    const running = item.state === 'running';
    const cls = running ? 'is-running' : item.state === 'error' ? 'is-error' : 'is-done';
    const stateText = running ? '执行中…' : item.state === 'error' ? '不可用' : '完成';
    el.innerHTML = `<div class="cmd-card ${cls}">
      <div class="cmd-head"><span class="cmd-line">${esc(item.cmd)}</span>
        <span class="cmd-state">${stateText}</span></div>
      ${item.text ? `<pre class="cmd-out">${esc(clip(item.text, 20000))}</pre>` : ''}
    </div>${item.text ? msgActionBar(item, false) : ''}`;
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
    // 状态行也用人话（「读取 app.js」「执行中… npm test」），比「执行 bash…」好认
    const tm = toolMeta(evt.name, evt.input, 'running');
    const label = tm.obj ? `${tm.label} ${tm.obj}` : tm.label;
    // 不给 open：展开与否交给渲染层按状态派生（跑着 / 失败才自动展开，成功收起），
    // 用户点过之后 item.open 才写成布尔值，此后以用户的选择为准。
    tab.items.push({ kind: 'tool', name: evt.name, input: evt.input || null, state: 'running', ts: Date.now() });
    tab.showTyping = true; tab.activity = label;
    if (visible) { renderChat(); setActivity(label); syncActivityBar(); }
    // 自动跟随只在工具跑完之后做：此刻文件还没写出来，先 resolve 只会拿到旧内容或失败。
  } else if (evt.type === 'tool_result') {
    const item = [...tab.items].reverse().find((i) => i.kind === 'tool' && i.name === evt.name && i.state === 'running');
    if (item) {
      item.output = evt.output ?? ''; item.isError = !!evt.is_error;
      item.durationMs = evt.duration_ms || 0; item.state = 'done'; item.done = true;
      tab.showTyping = true; tab.activity = '生成中…';
      if (visible) renderChat();
      maybeAutoPreview({
        name: item.name, input: item.input, output: evt.output,
        preview: evt.preview, isError: !!evt.is_error,
      }).catch(() => {});
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
/** displayText：命令改写出来的回合要在气泡里显示命令原文（如 `/plan …`），
 *  而真正提交给 agent 的是改写后的 prompt。两者不同就分开传。 */
async function send(text, displayText) {
  const tab = activeTab();
  if (!tab || tab.running) return;
  text = text.trim(); if (!text) return;
  /* 斜杠命令兜底：菜单被 Esc 关掉、或敲的是别名时，Enter 绝不能把 `/compact` 当正文
     发给模型 —— 那正是「命令不能用」的样子。精确匹配（含别名）就跑命令；目录已就绪
     但确实没这条，也交给 CLI 回答（它会回「Unknown command /x — nothing was sent.」）。
     只有用户自己发起的那次发送（displayText 为空）才走这条，命令改写的 prompt 不受影响。 */
  if (!displayText) {
    const hit = resolveSlashCommand(text);
    if (hit) {
      $('#input').value = ''; autoGrow(); updateCount(); slashClose();
      return runSlashCommand(hit.row, hit.arg, hit.row.aliasHit || hit.row.cmd);
    }
    const m = text.match(/^(\/[A-Za-z0-9][A-Za-z0-9_.:-]*)(\s+[\s\S]*)?$/);
    if (m && !cliCatalog.ok) {
      // 目录还在路上：别把 /compact 当正文发出去，也别默默吞掉 —— 说清楚在等什么
      loadCliCatalog();
      toast('命令目录还在加载，稍等一下再按 Enter', 2400);
      return;
    }
    if (cliCatalog.ok && m) {
      $('#input').value = ''; autoGrow(); updateCount(); slashClose();
      return runSlashCommand({ cmd: m[1], desc: '', source: 'cli', argMode: null, sub: [], scope: '' },
        (m[2] || '').trim(), m[1]);
    }
  }
  const shown = String(displayText || text).trim() || text;
  slashClose(); // 乐观清空不走 input 事件，指令菜单必须在这里显式收起
  state.sendHistory.push(shown); state.histIdx = state.sendHistory.length;
  tab.items.push({ kind: 'user', text: shown, ts: Date.now(), files: state.attachments.map((a) => a.name) });
  // 取消在途草稿定时器：否则发送后它仍会以「清空后的输入框」再写一次草稿归属
  if ($('#input')._draftTimer) { clearTimeout($('#input')._draftTimer); $('#input')._draftTimer = null; }
  // 立即清空输入框（乐观发送）；放在 await 之后会吞掉用户在这段时间里新敲的内容
  $('#input').value = ''; autoGrow(); updateCount();
  if (typeof clearDraftFor === 'function') clearDraftFor(tab);
  if (tab.title === '新会话') tab.title = shown.slice(0, 24);
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
  // 未显式选模型时发送走 CLI 默认：状态条如实说「跟随 CLI 默认」，不说误导性的「未选择」
  $('#st-model').textContent = '⬢ ' + ((tab && tab.model) || state.config.model || '跟随 CLI 默认');
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
  slashSync(); // / 起手弹内联指令菜单；非 / 起手自动收起
  clearTimeout($('#input')._draftTimer);
  $('#input')._draftTimer = setTimeout(() => { if (typeof saveDraftFor === 'function') saveDraftFor(activeTab()); }, 400);
});
$('#input').addEventListener('keydown', (e) => {
  // 指令菜单开着时：↑↓/Home/End 移行、Enter 执行高亮行（拦在发送之前）
  if (slashNav(e)) return;
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
// 侧栏「新建项目」入口：弹窗在 #frame 外，直接在当前页面弹出，不跳看板页
$('#sb-new-project').onclick = () => kbProjectDialog('create');
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
  // 新建弹窗（含项目 / 工作空间）也是 #frame 之外的全局浮层：从聊天页直接打开时，
  // 同样要把 frame 锁进 inert，并纳入下面的焦点归还链。
  const modals = [$('#settings-page'), $('#palette'), $('#help-modal'), $('#kb-modal')];
  const modalOpen = modals.some((m) => m && !m.hidden);
  lead.hidden = !pageOpen;
  // 被整页/模态遮罩盖住的元素不参与 Tab 焦点，读屏也不会读到一层看不见的按钮
  head.inert = pageOpen || modalOpen;
  lead.inert = modalOpen;
  // 模态打开时整块背景 inert：否则 Tab 会跳到遮罩下的侧栏/输入区按钮（WCAG 2.4.3）。
  // 三个 .palette 浮层与新建弹窗都在 #frame 之外，不受影响；整页 .subpage 在 frame 内，故仅模态时隔离。
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
  document.querySelectorAll('.subpage, #settings-page, #palette, #help-modal, #kb-modal')
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
// 项目选择：与审批模式同组；change 由自绘下拉派发（ui-select.js 的 _pick）
$('#chip-project').addEventListener('change', (e) => applyComposerProject(e.target.value));
// 下拉末尾的「＋ 新建项目…」是动作行，不改 value，只派发 select-action
$('#chip-project').addEventListener('select-action', () => onComposerNewProject());

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
  { cmd: '/rail', desc: '开关右侧预览 / 看板面板', run: () => toggleRail() },
  { cmd: '/sessions', desc: '搜索会话', run: () => { setSidebar(true); $('#session-search').focus(); } },
  { cmd: '/export', desc: '导出会话记录为 Markdown 文件', run: exportTranscript },
  { cmd: '/copy', desc: '复制会话记录到剪贴板', run: () => copyTranscript() },
  { cmd: '/help', desc: '快捷键与操作帮助', run: () => toggleHelp(true) },
  { cmd: '/gateway', desc: '查看 hermes serve 状态', run: showGateway },
  { cmd: '/kanban', desc: '打开 CLI 原生任务看板（新建 / 提交派发 / 手动 tick）', run: () => showKanban(true) },
  { cmd: '/orb', desc: '收成桌面小圆球（点球弹出迷你聊天窗）', run: () => api.enterOrb && api.enterOrb() },
];
let paletteSel = 0, paletteItems = COMMANDS;

/* ---------- CLI 命令目录（serve 的 commands.catalog） ----------
   桌面端原来只有上面这 12 条本地命令，CLI 的 COMMAND_REGISTRY 有 100+ 条，
   在输入框里敲 /status、/context、/usage、/insights 全都匹配不到，Enter 被拦下 ——
   命令一条都用不了。
   这些命令不需要在这里重写：serve 有审过的执行通道（slash.exec），桌面端只做
   「取目录 / 送命令 / 显示结果」。目录拿不到（serve 没起、权限不足）就静默退回本地表，
   输入体验不受影响。 */
const cliCatalog = { ok: false, at: 0, commands: [], categories: [], alias: {}, error: '' };
let cliCatalogInflight = null;
const CLIENT_CATALOG_TTL = 5 * 60 * 1000;

function loadCliCatalog(force = false) {
  // 只看桥有没有这个方法：Demo 桥也提供目录，浏览器里能演示合并后的菜单
  if (typeof api.cliCommandsCatalog !== 'function') return Promise.resolve(cliCatalog);
  if (cliCatalogInflight) return cliCatalogInflight;
  if (!force && cliCatalog.ok && Date.now() - cliCatalog.at < CLIENT_CATALOG_TTL) return Promise.resolve(cliCatalog);
  cliCatalogInflight = api.cliCommandsCatalog()
    .then((res) => {
      if (res && res.ok) {
        Object.assign(cliCatalog, {
          ok: true, at: res.at || Date.now(),
          commands: Array.isArray(res.commands) ? res.commands : [],
          categories: Array.isArray(res.categories) ? res.categories : [],
          alias: res.alias || {}, error: '',
        });
        // 目录回来时菜单若正开着（用户敲得太快，先看到的是「加载中」占位），就地重画一次，
        // 否则那一屏占位会一直挂着，直到用户再敲一个字符。
        if (typeof slashMenuOpen === 'function' && slashMenuOpen()) slashSync();
      } else {
        cliCatalog.error = (res && res.error) || '命令目录不可用';
      }
      return cliCatalog;
    })
    .catch((e) => { cliCatalog.error = String((e && e.message) || e); return cliCatalog; })
    .finally(() => { cliCatalogInflight = null; });
  return cliCatalogInflight;
}

/** 命令匹配打分：名字精确 > 名字前缀 > 名字包含 > 描述包含；-1 表示不匹配。 */
function commandScore(row, q) {
  if (!q) return 2;
  const name = row.cmd.slice(1).toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  return row.desc && row.desc.toLowerCase().includes(q) ? 3 : -1;
}

/**
 * 斜杠菜单的所有候选：本地动作在前，CLI 命令在后。
 * 同名已被主进程的 DESKTOP_OWN 过滤掉，这里不重复去重。
 */
const CMD_MENU_MAX = 40;
/** 别名表（`canon`）的用法：CLI 的目录**只列规范名**，别名只出现在 `canon` 里
    （`command_discovery._catalog_registry` 只 add `/{cmd.name}`）。
    所以 /compact 这种别名在菜单里永远匹配不到 —— 敲它只会看到「没有匹配的指令」，
    Enter 再把 /compact 当正文发给模型，看起来就是「命令不能用」。 */
function cliAliasIndex() {
  const out = new Map(); // 规范名（小写，带 /）→ [别名…]
  const map = (cliCatalog && cliCatalog.alias) || {};
  for (const [from, to] of Object.entries(map)) {
    if (typeof to !== 'string' || !to.startsWith('/')) continue;
    const key = to.toLowerCase();
    const list = out.get(key) || [];
    list.push(String(from).toLowerCase());
    out.set(key, list);
  }
  return out;
}
function commandRows(q) {
  const s = (q || '').trim().toLowerCase();
  const local = COMMANDS.map((c) => ({ cmd: c.cmd, desc: c.desc, source: 'local', argMode: null, sub: [], run: c.run }));
  const scored = [];
  for (const row of local) {
    const sc = commandScore(row, s);
    if (sc >= 0) scored.push({ row, sc, local: true });
  }
  const aliases = cliAliasIndex();
  for (const c of cliCatalog.commands) {
    const row = { cmd: c.cmd, desc: c.desc || '', source: 'cli', argMode: c.argMode || null, sub: c.sub || [], scope: c.scope || '' };
    let sc = commandScore(row, s);
    let aliasHit = '';
    // 别名也参与匹配：敲 /compact 要能出 /compress 这一行（排在同名规范名之后，别抢排序）
    for (const al of (aliases.get(String(c.cmd || '').toLowerCase()) || [])) {
      const as = commandScore({ cmd: al, desc: '' }, s);
      if (as >= 0 && (sc < 0 || as + 0.5 < sc)) { sc = as + 0.5; aliasHit = al; }
    }
    if (sc >= 0) scored.push({ row: aliasHit ? { ...row, aliasHit } : row, sc, local: false });
  }
  // 同分时本地优先；同组内保持目录原有顺序（sort 稳定）
  scored.sort((a, b) => a.sc - b.sc || (a.local === b.local ? 0 : a.local ? -1 : 1));
  // 描述匹配（3 分）只是兜底：只要有任何名字层面的命中（精确/前缀/包含/别名），
  // 描述里恰好撞词的命令就不该混进来 —— 否则敲 /compac 会把 desc 是
  // 「Toggle compact display mode」的 /density 也带出来，看起来像匹配错了对象。
  const best = scored.length ? Math.min(...scored.map((x) => x.sc)) : -1;
  const picked = scored.filter((x) => x.sc < 3 || best >= 3).map((x) => x.row);
  if (picked.length <= CMD_MENU_MAX) return picked;
  // 太多时不要砍掉本地动作：本地全留，剩下的名额给 CLI
  const locals = picked.filter((r) => r.source === 'local');
  const rest = picked.filter((r) => r.source !== 'local');
  return locals.concat(rest.slice(0, Math.max(0, CMD_MENU_MAX - locals.length)));
}

/** 一条完整的斜杠命令（可带参数）→ 目录行；只认**精确**名字，不做模糊匹配。
    顺序：本地动作 → CLI 规范名 → CLI 别名（/compact → /compress）。
    找不到返回 null（自由文本，按普通消息发）。 */
function resolveSlashCommand(text) {
  const s = String(text || '').trim();
  if (!/^\/[A-Za-z0-9]/.test(s)) return null;
  const at = s.search(/\s/);
  const name = (at < 0 ? s : s.slice(0, at)).toLowerCase();
  if (!/^\/[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name)) return null;
  const arg = at < 0 ? '' : s.slice(at + 1).trim();
  const local = COMMANDS.find((c) => c.cmd.toLowerCase() === name);
  if (local) return { row: { cmd: local.cmd, desc: local.desc, source: 'local', argMode: null, sub: [], run: local.run }, arg };
  const cli = cliCatalog.commands.find((c) => String(c.cmd || '').toLowerCase() === name);
  if (cli) {
    return { row: { cmd: cli.cmd, desc: cli.desc || '', source: 'cli', argMode: cli.argMode || null, sub: cli.sub || [], scope: cli.scope || '' }, arg };
  }
  const canon = ((cliCatalog.alias || {})[name] || '').toLowerCase();
  const viaAlias = canon && cliCatalog.commands.find((c) => String(c.cmd || '').toLowerCase() === canon);
  if (viaAlias) {
    return {
      row: { cmd: viaAlias.cmd, desc: viaAlias.desc || '', source: 'cli', argMode: viaAlias.argMode || null,
        sub: viaAlias.sub || [], scope: viaAlias.scope || '', aliasHit: name },
      arg,
    };
  }
  return null;
}

/**
 * 执行一条斜杠命令。
 * CLI 命令的三种返回（gateway/session_commands.py）：
 *   exec  → 文本结果，作为一条命令卡片留在对话里
 *   send / skill → 命令改写成一轮 prompt，回到正常提交流程
 * 失败也给出卡片：网关只放行审过的命令，被拒时它会给「改用哪条命令」的提示。
 */
async function runSlashCommand(row, argText, typedName) {
  const tab = activeTab();
  if (!tab) return;
  if (row.source === 'local') {
    const fn = typeof row.run === 'function' ? row.run : (COMMANDS.find((c) => c.cmd === row.cmd) || {}).run;
    if (typeof fn === 'function') fn();
    return;
  }
  if (tab.running) { toast('本回合还在进行，命令要等它结束', 2200); return; }
  if (!tab.sessionId) { toast('这个会话还没有建立：先发一条消息，再用命令', 2600); return; }

  const arg = String(argText || '').trim();
  const full = arg ? `${row.cmd} ${arg}` : row.cmd;
  // 卡片上写用户真正敲的名字（/compact），送进 CLI 的仍是规范名（/compress）
  const shown = arg ? `${typedName || row.cmd} ${arg}` : (typedName || row.cmd);
  const isCompress = /^\/(compress|compact)$/i.test(row.cmd);
  const item = { kind: 'command', cmd: shown, state: 'running', text: '', ts: Date.now() };
  tab.items.push(item);
  renderChat(); scrollBottom(true);

  let res = null;
  try { res = await api.cliCommandExec({ sessionId: tab.sessionId, command: full }); }
  catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  /* /compress 要的是「这个会话的活 agent」。刚打开的历史会话里 agent 是**异步**建起来的
     （session.resume → _schedule_agent_build），此刻命令会返回空输出 —— 看起来就是点了没反应。
     稍等一次再试，仍为空就给一句能照做的提示，而不是「（该命令没有输出）」。 */
  if (isCompress && res && res.ok && !res.type && !String(res.text || '').trim()) {
    await new Promise((r) => setTimeout(r, 900));
    try {
      const again = await api.cliCommandExec({ sessionId: tab.sessionId, command: full });
      if (again && again.ok && String(again.text || '').trim()) res = again;
    } catch { /* 保留第一次的空结果，下面给提示 */ }
  }

  // 命令被改写成一轮 prompt：撤掉占位卡，走正常提交（显示命令原文，提交改写后的内容）
  if (res && res.ok && (res.type === 'send' || res.type === 'skill') && res.text) {
    const idx = tab.items.indexOf(item);
    if (idx >= 0) tab.items.splice(idx, 1);
    renderChat();
    if (!tab.running) send(res.text, res.display || full);
    return;
  }

  const emptyText = isCompress
    ? 'CLI 还没把这个会话的 agent 建起来（刚打开的历史会话常见）。先发一条消息，或稍等几秒再敲一次。'
    : '（该命令没有输出）';
  item.state = res && res.ok ? 'done' : 'error';
  item.text = res && res.ok ? (res.text || emptyText) : (res && res.error) || '命令执行失败';
  if (tab.id === state.activeTabId) { renderChat(); scrollBottom(true); }
  else { renderTabs(); }
}

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
  menu.dataset.slash = ''; // 清掉上一轮内联指令菜单的标记（slashSync 打开时会重新打上）
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
      ${r.badge ? `<span class="wb-menu-badge">${esc(r.badge)}</span>` : ''}
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
    // role=menuitem 的键盘可达性：Enter / Space 触发（与 has-sub 行的 Enter 同语义）
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    };
  });

  return {
    close,
    openSub: (key) => {
      const row = menu.querySelector(`.wb-menu-row[data-key="${key}"]`);
      if (row) subOpen(row);
    },
  };
}

/* ---------- 内联指令菜单（输入框以 / 开头时浮现） ----------
   placeholder 承诺「/ 调用指令」，但此前只有 ⌘K 面板一条路 —— 在输入框里敲
   /new 会被当字面文本发给 CLI。现在复用 #chip-menu 浮层 + COMMANDS 表：
   输入 / 起手即弹候选（按指令名/描述过滤），↑↓/Home/End 选行、Enter 执行、
   Esc 关闭；无匹配时显示占位行而不是关菜单，避免 /xyz 被误发出去。 */
function slashRows(q) { return commandRows(q); }
function slashMenuOpen() {
  const m = $('#chip-menu');
  return !m.hidden && !!chipMenuCleanup && m.dataset.slash === '1';
}
function slashSync() {
  const inp = $('#input');
  const v = inp.value || '';
  const tab = activeTab();
  if (!v.startsWith('/') || (tab && tab.running) || state.view !== 'chat') { slashClose(); return; }
  // 目录按需拉取：敲第一个 / 才建连取目录，空闲启动不为此唤醒 serve
  if (!cliCatalog.ok) loadCliCatalog();
  const q = v.slice(1);
  const rows = slashRows(q);
  const menu = $('#chip-menu');
  openChipMenu($('#composer'), rows.map((c) => ({
    // 敲的是别名时把别名标出来（/compact），让人知道这一行就是它
    key: c.cmd, name: c.cmd,
    // CLI 有些 desc 会把整段 usage 塞进括号（/compress 的有 100+ 字符），
    // 菜单里只留说明本身，超宽交给 CSS 省略号兜底
    tag: String(c.desc || '').replace(/\s*\(usage:[\s\S]*$/, ''),
    badge: c.aliasHit ? c.aliasHit : (c.source === 'cli' ? 'CLI' : ''),
  })), null, (picked) => {
    const row = rows.find((c) => c.cmd === picked.key);
    if (!row) return;
    const spaceAt = q.search(/\s/);
    // 已有参数（`/title 新名字`）或命令本身要吃参数：交回给调用方，别把整串当命令名
    const argText = spaceAt >= 0 ? q.slice(spaceAt + 1) : '';
    const typedName = '/' + (spaceAt >= 0 ? q.slice(0, spaceAt) : q).trim();
    // 命令名已经完整敲出来了（`/save` 而不是 `/sa`）＝ 用户就是要跑它：
    // 裸命令直接送给 CLI，它会回 usage；比「补个空格就没动静」清楚得多。
    // 只有还在输入命令名的中途（`/sa`）才补全并把焦点留在参数位。
    // 别名敲全（`/compact`）同样算敲全：它就是这个命令的另一个名字。
    const qn = q.trim().toLowerCase();
    const typedFull = qn === row.cmd.replace(/^\//, '').toLowerCase()
      || (!!row.aliasHit && qn === row.aliasHit.replace(/^\//, '').toLowerCase());
    const needsArg = row.source === 'cli' && row.argMode && !argText && !typedFull;
    if (needsArg) {
      // 只补全命令名，把光标留在名字后面让用户接着敲参数
      inp.value = row.cmd + ' ';
      autoGrow(); updateCount();
      inp.focus();
      try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
      slashClose();
      return;
    }
    inp.value = ''; autoGrow(); updateCount();
    // 只敲了半截就从菜单里点：卡片上写真正执行的那条命令，不是半截输入
    runSlashCommand(row, argText, typedFull ? typedName : row.cmd);
  });
  menu.dataset.slash = '1'; // 必须在 openChipMenu 之后打标记（其入口会先清空）
  if (!rows.length) {
    // 目录还没回来时别用「没有匹配」误导：CLI 那 100+ 条只是还在路上
    const msg = cliCatalog.ok ? '没有匹配的指令 · 清空后重试或按 Esc 关闭' : 'CLI 命令加载中…（本地指令可直接用）';
    menu.innerHTML = `<div class="wb-menu-list"><div class="wb-menu-row wb-menu-empty" role="status">${msg}</div></div>`;
  }
}
function slashClose() {
  const m = $('#chip-menu');
  if (m.dataset.slash === '1' && typeof chipMenuCleanup === 'function') chipMenuCleanup();
  if (m.dataset.slash === '1') { delete m.dataset.slash; m.hidden = true; }
}
/** 输入框内 ↑↓/Home/End/Enter 对指令菜单的接管：焦点没离开输入框时 Enter 执行高亮行。 */
function slashNav(e) {
  if (!slashMenuOpen()) return false;
  const rows = [...document.querySelectorAll('#chip-menu .wb-menu-row:not(.wb-menu-empty)')];
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && rows.length) {
    e.preventDefault();
    const idx = rows.indexOf(document.activeElement);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
    else next = idx < 0 ? rows.length - 1 : Math.max(0, idx - 1);
    rows[next].focus();
    return true;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    // 没有候选时别把 Enter 拦死：alias / 目录里没列的命令交给 send() 的兜底 ——
    // 它会精确解析（含别名）或让 CLI 自己回答「Unknown command」。
    // 只有目录还没回来时才拦下，避免把 /compact 当正文发出去。
    if (!rows.length && cliCatalog.ok) return false;
    e.preventDefault();
    if (rows.length) {
      const ae = document.activeElement;
      (rows.indexOf(ae) >= 0 ? ae : rows[0]).click();
    }
    return true;
  }
  return false;
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

/* ---------- 右侧 rail：预览 | 看板 ---------- */
const RAIL_TAB_KEY = 'rail-tab';
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
  pv.url = res.url; pv.filePath = res.filePath || ''; pv.label = res.label || '';
  pv.kind = res.kind; pv.type = res.type || (isFile ? 'web' : 'url');
  pv.ext = res.ext || ''; pv.baseDir = res.baseDir || pv.baseDir;
  pv.srcdoc = res.srcdoc || '';
  pv.text = ''; pv.textLoadedFor = ''; pv.view = ''; pv.imgActual = false;
  $('#pv-path').value = isFile ? res.filePath : res.url;
  pvState(isFile ? '已加载' : '网页预览');
  pushPvRecent({ target: isFile ? res.filePath : res.url, label: res.label, type: pv.type });
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
    dragDepth += 1;
    drop.hidden = false;
  });
  pane.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  pane.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.hidden = true;
  });
  pane.addEventListener('drop', (e) => {
    dragDepth = 0;
    drop.hidden = true;
    if (!hasFiles(e)) return;
    e.preventDefault();
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
  // id 沿用 terminal：用户 localStorage 里已存的 mod+` 绑定不能因为改名失效
  { id: 'terminal', label: '切换右侧面板', group: '其他', def: 'mod+`' },
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
  terminal: () => toggleRail(),
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
    // 新建弹窗在 #frame 之外，从聊天 / 设置页直接打开时也要优先收它；
    // 旧链只在 kanban-page 可见时检查弹窗，非看板页下 Esc 会漏掉。
    const kbModalEl = $('#kb-modal');
    if (kbModalEl && !kbModalEl.hidden) { kbModalClose(); return; }
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
/** 轻浮层菜单的 ↑↓/Home/End 焦点导航（Esc 关闭与 Enter 激活各处已有，这里只补移动）。
 *  覆盖所有「打开即挂 tabindex/menuitem」的浮层：chip 一二级、看板 ⋯、会话/项目 ⋯、
 *  profile、插件/技能页「＋添加」菜单。菜单没开就立刻返回，零开销。 */
const MENU_NAV_ROOTS = ['#chip-menu', '#chip-submenu', '#kb-more-menu', '#session-menu', '#pf-menu'];
function openMenuRoot() {
  // 焦点已经在哪个菜单里，就留在哪个菜单（一级/二级互不打架）；否则取第一个打开的
  const ae = document.activeElement;
  if (ae) {
    const host = MENU_NAV_ROOTS.map((s) => $(s)).find((el) => el && !el.hidden && el.contains(ae));
    if (host) return host;
  }
  const fixed = MENU_NAV_ROOTS.map((s) => $(s)).find((el) => el && !el.hidden);
  if (fixed) return fixed;
  return Array.from(document.querySelectorAll('.subpage .pp-menu')).find((m) => !m.hidden) || null;
}
function menuItems(root) {
  return Array.from(root.querySelectorAll('[role="menuitem"], button, input'))
    .filter((el) => !el.closest('[hidden]') && !el.disabled);
}
function menuArrowNav(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const root = openMenuRoot();
  if (!root) return;
  // 焦点在输入框里（菜单外的搜索框等）不抢箭头键；菜单内的 checkbox/input 不受限
  const ae = document.activeElement;
  const inRoot = ae && root.contains(ae);
  if (!inRoot && ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox') return;
  const items = menuItems(root);
  if (!items.length) return;
  const idx = inRoot ? items.indexOf(ae) : -1;
  let next;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
  else next = idx < 0 ? items.length - 1 : Math.max(0, idx - 1);
  e.preventDefault();
  e.stopPropagation();
  if (items[next] && items[next] !== ae) items[next].focus();
}
document.addEventListener('keydown', menuArrowNav, true);
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
    inp.placeholder = running ? '正在生成…可按 Esc 或 ■ 停止' : '发消息或创建任务，/ 调用指令，拖入文件可附加';
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

/** 回合收尾：按设置自动折叠已完成的工具详情与长思考块。
    失败的留着展开 —— 用户要能直接看到错因，收起来等于把报错藏了。 */
function applyAutoCollapse(tab) {
  if (!tab || SettingsStore.get('autoCollapse', true) === false) return;
  for (const i of tab.items) {
    if (i.kind === 'tool' && i.state === 'done' && !i.isError) i.open = false;
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
    ['其他', [[k('help') + ' 或 ?', '打开本帮助'], [k('terminal'), '切换右侧面板'],
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
    // 助手脚注已经不在 .msg 里了（挪到了整轮末尾），兜一层从脚注行自己取回数据
    const msg = act.closest('.msg');
    const row = act.closest('.msg-foot-row');
    const item = (msg && msg._item) || (row && row._item);
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


/* ---------- 初始化 ---------- */
async function init() {
  refreshProfileChip(); // 尽早刷新，不受后续会话加载/后端重启阻塞
  applySettings();      // 设置此前只写不读：启动时也要恢复主题/字号/步骤详略
  // 先铺骨架：下面 env / 会话列表都要等后端，空白侧栏会被误读成「没有历史会话」
  try { renderSessions(''); } catch {}
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
  syncComposerProject(); // 首屏把项目下拉的候选与当前页签状态落地
  initConnStatus();      // 后端连接状态点：先拉一次快照，之后靠主进程推送
  // CLI 命令目录不在这里预热：空闲启动会为此唤醒 serve。第一次敲 / 时才拉（slashSync）。
  initFocusRefresh();    // 切回窗口时补齐终端 / 其他窗口产生的变化
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
