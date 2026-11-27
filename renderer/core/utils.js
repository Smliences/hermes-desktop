'use strict';
/* ---------- 公共基础工具与 Toast ---------- */
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
function toast(msg, ms = 2200, opts = null) {
  const t = $('#toast'); if (!t) return;
  t.onclick = null;
  t.classList.remove('is-action');
  if (opts && typeof opts.onClick === 'function') {
    t.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = String(msg);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-act';
    btn.textContent = opts.actionLabel || '立即查看';
    btn.onclick = (e) => { e.stopPropagation(); t.hidden = true; opts.onClick(); };
    t.append(span, btn);
    t.classList.add('is-action');
  } else {
    t.textContent = msg;
  }
  t.hidden = false;
  a11y(msg);
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, ms);
}
