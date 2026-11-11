'use strict';
/**
 * hermes-sessions.js — 会话管理服务
 *
 * 会话元数据与消息历史存于 ~/.hermes/state.db（SQLite）。
 * 为避免原生依赖（better-sqlite3 跨 Electron ABI 问题），通过系统自带
 * sqlite3 CLI（-readonly -json）只读访问。CLI 不支持绑定参数，故采用
 * 全内联 SQL：数值经 Number 白名单化，字符串经 lit() 单引号转义防注入。
 */
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const profile = require('./hermes-profile');
const { resolveHermesBin, safeArg } = require('./hermes-bin');
const log = require('./logger');
const getDB = () => profile.dbPath();
const HERMES_BIN = process.env.HERMES_BIN || resolveHermesBin();

/** 字符串字面量转义（SQL 单引号） */
function lit(v) {
  return `'${String(v).replace(/'/g, "''").replace(/\0/g, '')}'`;
}
/** 数值白名单化 */
function num(v, def, max = 1e9) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : def;
}

function sqliteExec(sql, db) {
  // 只允许服务内部传入 profile.dbPath(name) 派生出来的路径（调用方需先校验
  // 名字合法性），外部 IPC 无法指定任意文件。
  const target = db || getDB();
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(target)) return resolve([]);
    execFile('sqlite3', ['-readonly', '-json', target, sql], { maxBuffer: 32 * 1024 * 1024, timeout: 8000 }, (err, stdout) => {
      if (err) return reject(new Error(`sqlite3 查询失败: ${String(err.message).split('\n')[0]}`));
      try { resolve(stdout.trim() ? JSON.parse(stdout) : []); }
      catch (e) { reject(new Error(`JSON 解析失败: ${e.message}`)); }
    });
  });
}

/** 列出最近会话。profileName 只接受合法且真实存在的名字，用于「球菜单」
 *  在不切换当前 profile 的前提下读其它实例的会话（纯只读、白名单路径）。 */
async function listSessions({ limit = 50, search = '', profileName = '' } = {}) {
  const db = profileName && profile.validName(profileName) && profile.exists(profileName)
    ? profile.dbPath(profileName) : getDB();
  // 只按标题/ID 过滤；正文命中走 FTS（searchMessages），避免 messages LIKE 全表扫（实测 849ms）
  const where = search
    ? `WHERE s.id LIKE ${lit('%' + search + '%')}
         OR COALESCE(s.title,'') LIKE ${lit('%' + search + '%')}
         OR COALESCE(s.display_name,'') LIKE ${lit('%' + search + '%')}`
    : '';
  const rows = await sqliteExec(
    `SELECT s.id, COALESCE(NULLIF(s.title,''), NULLIF(s.display_name,''),
              (SELECT NULLIF(substr(trim(m.content),1,28),'') FROM messages m
                WHERE m.session_id = s.id AND m.role = 'user' ORDER BY m.id LIMIT 1),
              s.id) AS title,
            COALESCE(s.title_source,'') AS title_source,
            s.model, s.message_count,
            s.input_tokens, s.output_tokens, s.started_at, s.ended_at, s.end_reason, s.source,
            COALESCE(s.pinned,0) AS pinned, COALESCE(s.archived,0) AS archived, COALESCE(s.hidden,0) AS hidden
     FROM sessions s ${where}
     ORDER BY COALESCE(s.pinned,0) DESC, s.started_at DESC LIMIT ${num(limit, 50, 200)}`,
    db
  );
  return rows.map((r) => ({ ...r, title: r.title || r.id }));
}

/** messages 表列集合：CLI 各版本会增减列，动态投影保证新旧库都能读。
 *  失败轮次（display_kind='failed_turn'）的真实错误藏在 display_metadata 里，
 *  早期投影把它丢掉了，界面只剩一句「Your request was not processed」。 */
async function messageColumns() {
  const info = await sqliteExec('PRAGMA table_info(messages)');
  return new Set(info.map((r) => r.name));
}

/** 加载某会话的消息历史（渲染用轻量投影） */
async function loadHistory(sessionId, { limit = 200 } = {}) {
  const cols = await messageColumns();
  if (!cols.has('id') || !cols.has('session_id')) return [];
  const pick = (name) => cols.has(name) ? name : `NULL AS ${name}`;
  const names = ['id', 'role', 'content', 'tool_name', 'tool_calls', 'tool_call_id',
    'timestamp', 'token_count', 'reasoning_content', 'display_kind', 'display_metadata', 'finish_reason'];
  const rows = await sqliteExec(
    `SELECT ${names.map(pick).join(', ')}
     FROM (SELECT * FROM messages WHERE session_id = ${lit(sessionId)} ORDER BY id DESC LIMIT ${num(limit, 200, 1000)}) sub
     ORDER BY id ASC`
  );
  return rows.map((r) => {
    let toolCalls;
    if (r.tool_calls) { try { toolCalls = JSON.parse(r.tool_calls); } catch { /* ignore */ } }
    return {
      id: r.id,
      role: r.role === 'tool' ? 'tool' : r.role,
      content: r.content || '',
      toolName: r.tool_name || '',
      toolCalls,
      timestamp: r.timestamp,
      tokens: r.token_count || 0,
      displayKind: r.display_kind || '',
      displayMetadata: String(r.display_metadata || '').slice(0, 4000),
      finishReason: r.finish_reason || '',
    };
  });
}

/** 单会话统计（状态栏上下文估算用）。
 *  input_tokens / output_tokens 是 sessions 表由 CLI 维护的累计列；
 *  messages 表只有 token_count。早期实现误把累计列写在 messages 上，SQL 必然报错。 */
async function sessionStats(sessionId) {
  const zero = { input_tokens: 0, output_tokens: 0, message_count: 0, last_ts: 0 };
  const id = String(sessionId || '');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return zero;
  const rows = await sqliteExec(
    `SELECT COALESCE(s.input_tokens,0) AS input_tokens,
            COALESCE(s.output_tokens,0) AS output_tokens,
            COALESCE(s.message_count,0) AS message_count,
            COALESCE(NULLIF(s.last_activity_at,0), NULLIF(s.ended_at,0), s.started_at, 0) AS last_ts
     FROM sessions s WHERE s.id = ${lit(id)} LIMIT 1`
  );
  return rows[0] || zero;
}

async function dbAvailable() { return fs.existsSync(getDB()); }

/** 可写 SQL（仅用于单表安全的 rename / pin，删除交由 CLI 保证关联表与 FTS 一致）。 */
function sqliteWrite(sql) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(getDB())) return reject(new Error('会话数据库不存在'));
    execFile('sqlite3', [getDB(), sql], { maxBuffer: 4 * 1024 * 1024, timeout: 15000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).split('\n')[0]));
      resolve(true);
    });
  });
}

/** 全文搜索消息内容：FTS5 优先（英文/短语），中文或无结果时回退 LIKE。 */
async function searchMessages(query, { limit = 40 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const cap = num(limit, 40, 100);
  let rows = [];
  const ftsQ = '"' + q.replace(/"/g, '""') + '"';
  try {
    rows = await sqliteExec(
      `SELECT m.session_id AS id, COUNT(*) AS hits,
              snippet(messages_fts, 0, ${lit('[[')}, ${lit(']]')}, '…', 14) AS snip
       FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ${lit(ftsQ)}
       GROUP BY m.session_id ORDER BY hits DESC LIMIT ${cap}`
    );
  } catch { /* FTS 语法不兼容（中文/特殊字符）时走兜底 */ }
  if (!rows.length) {
    rows = await sqliteExec(
      `SELECT session_id AS id, 1 AS hits,
              substr(content, MAX(1, instr(content, ${lit(q)}) - 30), 110) AS snip
       FROM (SELECT session_id, content FROM messages WHERE content LIKE ${lit('%' + q + '%')} LIMIT ${cap * 8}) sub
       GROUP BY session_id LIMIT ${cap}`
    );
  }
  return rows.map((r) => ({ id: r.id, hits: Number(r.hits) || 1, snippet: String(r.snip || '').replace(/[\r\n]+/g, ' ').slice(0, 120) }));
}

/** 会话库空间统计（只读）：库大小、页数、可回收空间、会话/消息数量与时间跨度。 */
async function storageStats() {
  const dbBytes = fs.existsSync(getDB()) ? fs.statSync(getDB()).size : 0;
  const one = async (sql, key, def = 0) => {
    try { const r = await sqliteExec(sql); return Number(r[0] && r[0][key]) || def; }
    catch { return def; }
  };
  const [pageCount, pageSize, freePages] = await Promise.all([
    one('PRAGMA page_count', 'page_count'),
    one('PRAGMA page_size', 'page_size', 4096),
    one('PRAGMA freelist_count', 'freelist_count'),
  ]);
  let agg = {};
  try {
    agg = (await sqliteExec(
      `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM messages) AS messages,
              (SELECT COUNT(*) FROM sessions WHERE COALESCE(archived,0)=1 OR COALESCE(hidden,0)=1) AS archived,
              (SELECT COUNT(*) FROM sessions WHERE COALESCE(pinned,0)=1) AS pinned,
              (SELECT MIN(started_at) FROM sessions) AS oldest,
              (SELECT MAX(started_at) FROM sessions) AS newest`
    ))[0] || {};
  } catch {}
  return {
    ok: true, dbPath: getDB(), dbBytes, pageCount, pageSize,
    freeBytes: freePages * pageSize, freePages,
    sessions: Number(agg.sessions) || 0, messages: Number(agg.messages) || 0,
    archived: Number(agg.archived) || 0, pinned: Number(agg.pinned) || 0,
    oldest: Number(agg.oldest) || 0, newest: Number(agg.newest) || 0,
  };
}

/** 会话是否仍存在（删除后校验用；CLI 对不存在的 ID 也返回 exit 0） */
async function sessionExists(id) {
  try {
    const rows = await sqliteExec(`SELECT COUNT(*) AS n FROM sessions WHERE id = ${lit(id)}`);
    return Number((rows[0] || {}).n) > 0;
  } catch { return null; }
}

/**
 * 删除会话：走官方 CLI，保证关联表 / FTS 索引 / 归档状态一并处理。
 * 注意：`hermes sessions delete` 对不存在的 ID 打印 "No session" 但 **exit 0**，
 * 因此不能只看退出码，必须在删后回查数据库确认真的没了。
 */
async function deleteSession(sessionId) {
  const id = String(sessionId || '');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return { ok: false, error: '会话 ID 不合法' };
  if ((await sessionExists(id)) === false) return { ok: false, error: '会话不存在（可能已被删除）' };
  const r = await new Promise((resolve) => {
    try {
      const p = spawn(HERMES_BIN, profile.cliArgs(['sessions', 'delete', '--yes', id]), { timeout: 30000, env: profile.env({ NO_COLOR: '1' }) });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
      p.on('error', (e) => resolve({ code: -1, out: '', err: String(e.message || e) }));
    } catch (e) { resolve({ code: -1, out: '', err: String(e.message || e) }); }
  });
  const gone = (await sessionExists(id)) === false;
  if (gone) return { ok: true, output: r.out.slice(0, 200) };
  const msg = (r.err || r.out || `exit ${r.code}`).split('\n')[0];
  return { ok: false, error: msg || '删除未生效', output: r.out.slice(0, 200) };
}

async function renameSession(sessionId, title) {
  const id = String(sessionId || '');
  const t = String(title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || !t) return { ok: false, error: '参数无效' };
  try {
    // 标题写在 title + title_source（CLI 的 set_session_title 语义），display_name 是空的旧字段
    const dup = await sqliteExec(
      `SELECT id FROM sessions WHERE title = ${lit(t)} AND id <> ${lit(id)}
         AND COALESCE(hidden,0) = 0 AND COALESCE(archived,0) = 0 LIMIT 1`
    );
    if (dup.length) return { ok: false, error: '已有同名会话，请换一个标题' };
    await sqliteWrite(`UPDATE sessions SET title = ${lit(t)}, title_source = 'user' WHERE id = ${lit(id)}`);
    const chk = await sqliteExec(`SELECT title FROM sessions WHERE id = ${lit(id)}`);
    return (chk[0] && chk[0].title === t) ? { ok: true } : { ok: false, error: '重命名未生效' };
  } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * 置顶/取消置顶：同一压缩谱系（compression-ended 父链 + 续接子会话）一起改，
 * 否则刷新时谱系根部会把状态改回去。与 CLI 的 set_session_pinned 同语义。
 */
async function setPinned(sessionId, pinned) {
  const id = String(sessionId || '');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return { ok: false, error: '参数无效' };
  const v = pinned ? 1 : 0;
  try {
    await sqliteWrite(`WITH RECURSIVE
      ancestors(id) AS (
        SELECT ${lit(id)} UNION
        SELECT p.id FROM ancestors a
          JOIN sessions c ON c.id = a.id
          JOIN sessions p ON p.id = c.parent_session_id
        WHERE p.end_reason = 'compression'
      ),
      descendants(id) AS (
        SELECT ${lit(id)} UNION
        SELECT c.id FROM descendants d
          JOIN sessions p ON p.id = d.id
          JOIN sessions c ON c.parent_session_id = p.id
        WHERE p.end_reason = 'compression'
      )
      UPDATE sessions SET pinned = ${v}
      WHERE id IN (SELECT id FROM ancestors UNION SELECT id FROM descendants)`);
    const chk = await sqliteExec(`SELECT COALESCE(pinned,0) AS p FROM sessions WHERE id = ${lit(id)}`);
    return (chk[0] && Number(chk[0].p) === v) ? { ok: true } : { ok: false, error: '置顶未生效' };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 会话累计用量（打开历史会话时给状态条初值；活会话的实时值由 gateway session.usage 推送） */
async function sessionUsage(sessionId) {
  const id = String(sessionId || '');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return { ok: false, error: '参数无效' };
  try {
    const rows = await sqliteExec(
      `SELECT COALESCE(model,'') AS model, COALESCE(message_count,0) AS messages,
              COALESCE(input_tokens,0) AS input, COALESCE(output_tokens,0) AS output,
              COALESCE(cache_read_tokens,0) AS cacheRead, COALESCE(cache_write_tokens,0) AS cacheWrite,
              COALESCE(reasoning_tokens,0) AS reasoning, COALESCE(api_call_count,0) AS calls,
              COALESCE(estimated_cost_usd,0) AS cost
       FROM sessions WHERE id = ${lit(id)}`
    );
    if (!rows.length) return { ok: false, error: '会话不存在' };
    const u = rows[0];
    return { ok: true, usage: { ...u, total: Number(u.input) + Number(u.output) } };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  listSessions, loadHistory, sessionStats, dbAvailable, getDB,
  searchMessages, storageStats, deleteSession, renameSession, setPinned, sessionUsage,
};
