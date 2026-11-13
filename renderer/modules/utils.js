/**
 * renderer/modules/utils.js —— 无副作用的纯工具函数
 *
 * 只放「输入什么就返回什么」的小函数：不进 DOM、不读 IPC、不碰 localStorage。
 * 这样任何模块都能安全 import，不会因为引入工具反而拖进一整片业务。
 */

/** 单点查询 DOM。 */
export const $ = (sel) => document.querySelector(sel);

// 单引号一并转义：所有 innerHTML 属性插值都经过这里，避免属性上下文逃逸
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** IPC 返回值形态归一化：主进程异常时返回 {ok:false} 而非数组，旧的 .map 会白屏。 */
export const arr = (v) => (Array.isArray(v) ? v : []);

/** 超长工具输出 / 代码截断，避免一次 innerHTML 卡死渲染进程。 */
export const clip = (s, n = 20000) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n)}\n…（已截断，共 ${t.length} 字符）` : t;
};

export const safeStringify = (v) => { try { return JSON.stringify(v, null, 2) || ''; } catch { return String(v); } };
export const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
export const safeSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };

export const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 0 : 1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
};

export const uid = () => Math.random().toString(36).slice(2, 10);

/** 独立 live region：只播状态变化，不随聊天流全量重建而重播整段对话。 */
export function a11y(msg) {
  const el = $('#a11y-status'); if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = String(msg); }, 20);
}

/** 搜索词高亮（只标第一处，输出安全 HTML） */
export function hlMark(text, q) {
  const t = String(text || '');
  if (!q) return esc(t);
  const i = t.toLowerCase().indexOf(String(q).toLowerCase());
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
}