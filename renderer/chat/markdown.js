'use strict';
/* 轻量 Markdown 与代码块高亮（流式安全：先转义再渲染） */
/** 行内 Markdown：输入为纯文本，输出为安全 HTML（图片 URL 限 http/https/data:image）。 */
function renderInline(s) {
  const imgs = [];
  const codes = [];
  // 先抽行内代码，避免反引号里的 ![alt](url) 被误当成图片渲染
  let t = String(s).replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/g, (_, alt, url) => {
    imgs.push(`<img class="md-img" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" />`);
    return `\u0000I${imgs.length - 1}\u0000`;
  });
  t = esc(t)
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t
    .replace(/\u0000C(\d+)\u0000/g, (_, i) => codes[Number(i)] || '')
    .replace(/\u0000I(\d+)\u0000/g, (_, i) => imgs[Number(i)] || '');
}
const HL_KW = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'class', 'extends', 'new', 'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw',
  'def', 'elif', 'pass', 'raise', 'with', 'as', 'lambda', 'yield', 'True', 'False', 'None', 'true', 'false', 'null', 'undefined',
  'fn', 'pub', 'struct', 'enum', 'impl', 'match', 'use', 'mod', 'func', 'package', 'type', 'interface', 'defer', 'go',
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'JOIN', 'LEFT', 'ON', 'ORDER', 'BY', 'LIMIT',
]);
function highlightCode(lang, raw) {
  const l = String(lang || '').toLowerCase();
  if (!l || l === 'text' || l === 'txt' || l === 'log') return esc(raw);
  const hashCmt = /^(py|python|sh|bash|zsh|shell|yaml|yml|toml|rb|ruby|r|pl|perl|conf|ini|dockerfile|makefile)$/.test(l);
  const slashCmt = /^(js|javascript|ts|typescript|jsx|tsx|mjs|cjs|c|cpp|cc|cxx|h|hpp|java|go|rs|rust|css|scss|less|json|jsonc|swift|kt|kotlin|php)$/.test(l);
  const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\\n])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) out += esc(raw.slice(last, m.index));
    const tok = m[0];
    if ((slashCmt && (tok.startsWith('//') || tok.startsWith('/*')))
      || (hashCmt && tok.startsWith('#'))
      || (l === 'sql' && tok.startsWith('--'))) {
      out += `<span class="hl-cmt">${esc(tok)}</span>`;
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
      out += `<span class="hl-str">${esc(tok)}</span>`;
    } else if (/^\d/.test(tok)) {
      out += `<span class="hl-num">${esc(tok)}</span>`;
    } else if (HL_KW.has(tok)) {
      out += `<span class="hl-kw">${esc(tok)}</span>`;
    } else {
      out += esc(tok);
    }
    last = re.lastIndex;
  }
  if (last < raw.length) out += esc(raw.slice(last));
  return out;
}
/** 代码块：语言标签 + 行数 + 复制按钮，长行横向滚动不折行；超 30 行默认折叠。 */
function mdCodeBlock(lang, code) {
  const body = String(code).replace(/\n$/, '');
  const n = body.split('\n').length;
  const long = n > 30;
  return `<div class="md-code${long ? ' collapsed' : ''}"><div class="md-code-head">` +
    `<span class="md-code-lang">${esc(lang || 'text')}</span><span class="md-code-lines">${n} 行</span>` +
    `<span class="md-code-hint" aria-hidden="true">⇆ 可横向滚动</span>` +
    (long ? `<button class="md-code-fold" type="button">展开全部 (${n} 行)</button>` : '') +
    `<button class="md-code-copy" type="button" title="复制代码">复制</button></div>` +
    `<pre><code>${highlightCode(lang, body)}</code></pre></div>`;
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
  return `<div class="md-table-wrap"><div class="md-table-bar">` +
    `<button class="md-table-copy" data-fmt="md" type="button">复制 Markdown</button>` +
    `<button class="md-table-copy" data-fmt="csv" type="button">复制 CSV</button>` +
    `</div><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
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
    out.push(`<${list.tag}>` + list.items.map((x) => {
      const tm = x.match(/^\[([ xX])\]\s+([\s\S]*)$/);
      if (tm && list.tag === 'ul') {
        const chk = tm[1].toLowerCase() === 'x' ? ' checked' : '';
        return `<li class="md-task"><input type="checkbox" disabled${chk} /> ${renderInline(tm[2])}</li>`;
      }
      return `<li>${renderInline(x)}</li>`;
    }).join('') + `</${list.tag}>`);
    list = null;
  };
  const flushAll = () => { flushPara(); flushQuote(); flushList(); };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const ph = line.match(/^\u0000B(\d+)\u0000$/);
    if (ph) { flushAll(); out.push(blocks[Number(ph[1])] || ''); continue; }
    if (!line.trim()) { flushAll(); continue; }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
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
/** 代码块复制 / 折叠、表格复制按钮：全局委托，覆盖聊天流、预览栏与看板抽屉。 */
document.addEventListener('click', async (e) => {
  const foldBtn = e.target.closest && e.target.closest('.md-code-fold');
  if (foldBtn) {
    const box = foldBtn.closest('.md-code');
    if (box) {
      const collapsed = box.classList.toggle('collapsed');
      const lines = (box.querySelector('.md-code-lines') && box.querySelector('.md-code-lines').textContent) || '';
      foldBtn.textContent = collapsed ? `展开全部 (${lines})` : '收起代码';
    }
    return;
  }
  const tblCopy = e.target.closest && e.target.closest('.md-table-copy');
  if (tblCopy) {
    const wrap = tblCopy.closest('.md-table-wrap');
    const tbl = wrap && wrap.querySelector('table');
    if (tbl) {
      const rows = Array.from(tbl.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.children).map((c) => String(c.textContent || '').trim()));
      if (rows.length) {
        const fmt = tblCopy.dataset.fmt;
        const out = fmt === 'csv'
          ? rows.map((r) => r.map((v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')).join('\n')
          : [
              '| ' + rows[0].join(' | ') + ' |',
              '| ' + rows[0].map(() => '---').join(' | ') + ' |',
              ...rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |'),
            ].join('\n');
        try {
          await navigator.clipboard.writeText(out);
          toast(fmt === 'csv' ? '已复制 CSV' : '已复制 Markdown 表格', 1400);
        } catch { toast('复制失败', 1400); }
      }
    }
    return;
  }
  const btn = e.target.closest && e.target.closest('.md-code-copy');
  if (!btn) return;
  const pre = btn.closest('.md-code') && btn.closest('.md-code').querySelector('pre');
  if (!pre) return;
  try {
    await navigator.clipboard.writeText(pre.innerText);
    clearTimeout(btn._cpTimer);
    btn.textContent = '已复制';
    btn._cpTimer = setTimeout(() => { btn.textContent = '复制'; }, 1400);
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
