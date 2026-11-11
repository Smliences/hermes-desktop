'use strict';
/**
 * logger.js — 轻量结构化日志（生产级最小实现）
 *
 * 落盘到 userData/logs/app.log，单行 JSON，按大小轮转；写入前统一脱敏，
 * 绝不把 WS token、API key、凭证或含 token 的 URL 写进磁盘。
 */
const fs = require('fs');
const path = require('path');

let dir = null;
let file = '';
const MAX_BYTES = 2 * 1024 * 1024;

function init(userData) {
  try {
    dir = path.join(userData, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'app.log');
  } catch { dir = null; }
}

function redact(value) {
  let s = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  s = String(s)
    // Bearer 必须先处理：否则 `Authorization: Bearer <jwt>` 会被通用 key=value
    // 规则只吃掉 "Bearer" 这个单词，把真正的 JWT 原样留在日志里（回归测试捕获）。
    .replace(/(Bearer\s+)([A-Za-z0-9._\-+/=]{8,})/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key|authorization|credential)[a-z_]*\s*[=:]\s*)(?!\[REDACTED\])([^\s,;"'}]{4,})/gi, '$1[REDACTED]')
    .replace(/(HERMES_DASHBOARD_SESSION_TOKEN[=:]\s*)([^\s,;"'}]+)/gi, '$1[REDACTED]')
    .replace(/([?&]token=)([^&\s"']+)/gi, '$1[REDACTED]')
    .replace(/(\/api\/ws\?token=)([^\s"']+)/gi, '$1[REDACTED]');
  return s.slice(0, 1200);
}

function write(level, scope, message, extra) {
  const rec = { t: new Date().toISOString(), level, scope, msg: redact(message) };
  if (extra !== undefined) {
    try {
      const safe = JSON.parse(JSON.stringify(extra, (k, v) => (typeof v === 'string' ? redact(v) : v)));
      rec.extra = safe;
    } catch { /* 循环引用等，忽略 extra */ }
  }
  const line = JSON.stringify(rec) + '\n';
  // 控制台保留（开发期可见），磁盘只写脱敏后的内容
  if (level === 'error') console.error('[hermes]', rec.msg);
  if (!file) return;
  try {
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch {}
    fs.appendFileSync(file, line);
  } catch {}
}

module.exports = {
  init,
  info: (scope, msg, extra) => write('info', scope, msg, extra),
  warn: (scope, msg, extra) => write('warn', scope, msg, extra),
  error: (scope, msg, extra) => write('error', scope, msg, extra),
  redact,
};
