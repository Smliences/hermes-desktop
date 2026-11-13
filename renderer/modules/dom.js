/**
 * renderer/modules/dom.js —— DOM 小工具与 Markdown 渲染
 *
 * 这里只做「纯 DOM → HTML 字符串 / 小提示」的事：不读 IPC、不碰业务状态，
 * 因此任何域模块都可以安全 import（chat、catalog、settings 都用得上）。
 * 顶层副作用只有两个 document 级事件委托（代码复制、图片破图兜底），
 * 它们靠事件委托工作，不依赖任何调用方。
 */
import { $, esc, safeStringify, a11y } from './utils.js';

/** 底部轻提示。文案同时播报给读屏（a11y）—— 只显示不播报等于对辅助技术隐身。 */
export function toast(msg, ms = 2200) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.hidden = false;
  a11y(msg);
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, ms);
}

/* 轻量 Markdown（流式安全：先转义再渲染） */
/** 行内 Markdown：输入为纯文本，输出为安全 HTML（图片 URL 限 http/https/data:image）。 */
export function renderInline(s) {
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
export function mdCodeBlock(lang, code) {
  const body = String(code).replace(/\n$/, '');
  const n = body.split('\n').length;
  return `<div class="md-code"><div class="md-code-head">` +
    `<span class="md-code-lang">${esc(lang || 'text')}</span><span class="md-code-lines">${n} 行</span>` +
    `<span class="md-code-hint" aria-hidden="true">⇆ 可横向滚动</span>` +
    `<button class="md-code-copy" type="button" title="复制代码">复制</button></div>` +
    `<pre><code>${esc(body)}</code></pre></div>`;
}
/** GFM 表格：第二行必须是分隔行（含 - 与 |），否则原样返回。 */
export function mdTable(raw) {
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
export function renderMarkdown(src) {
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

export function toolBrief(name, input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['command', 'path', 'file_path', 'query', 'url', 'pattern', 'skill', 'cmd'];
  for (const k of keys) if (input[k]) return String(input[k]).slice(0, 90);
  const json = safeStringify(input).replace(/\n\s*/g, ' ');
  return json.length > 90 ? json.slice(0, 90) + '…' : json;
}
/** WB 式工具行元数据：工具名 → {icon 动作图标, verb 中文动作, obj 对象名} */
export function toolMeta(name, input) {
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
    [/^(terminal|read_terminal|close_terminal|execute_code|process_manage|cronjob_manage|bash|shell|exec_command|run_command)/, '⊙', '运行'],
    [/^(search_files|web_search|x_search|session_search|grep|glob|find_files|list_files)/, '⌕', '搜索'],
    [/^(read_file|skill_view|skills_list|memory|drive_preview|desktop_preview|cat)/, '◫', '查看'],
    [/^browser_/, '◫', '浏览'],
    [/^(web_extract|web_fetch|http_request|fetch_url)/, '↗', '抓取'],
    [/^(image_generate|video_generate|text_to_speech)/, '✦', '生成'],
    [/^(vision_analyze|video_analyze)/, '◫', '分析'],
    [/^feishu_/, '◫', '飞书'],
    [/^(delegate_task|task)/, '⇗', '分发'],
    [/^(todo_list|todo_write|update_plan)/, '☰', '清单'],
    [/^(skill_manage|desktop_project)/, '⚙', '管理'],
  ];
  for (const [re, icon, verb] of table) if (re.test(n)) return { icon, verb, obj };
  // 动作列是固定 44px：未知名的长英文名不能整段塞进去，否则会截成 "web ..."。
  // 收敛成短动作词，原始工具名由行 title 与详情头完整保留。
  return { icon: '⊙', verb: n.length <= 4 && !n.includes(' ') ? n : '调用', obj };
}
/** 从错误文本里提取 mono 状态胶囊（如 MISSING_CREDENTIAL / exit=1） */
export function errorCodeOf(text) {
  const m = String(text).match(/\b([A-Z][A-Z_]{4,})\b/);
  if (m) return m[1];
  const e = String(text).match(/退出码\s*(\d+)|exit(?:_code)?[=:]\s*(\d+)/i);
  if (e) return `EXIT ${e[1] || e[2]}`;
  return 'ERROR';
}