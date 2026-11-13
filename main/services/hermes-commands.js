'use strict';
/**
 * hermes-commands.js — CLI 斜杠命令：目录 + 执行（CLI 是唯一真源）
 *
 * 为什么要有这一层：桌面端原来只有一张 12 条的本地命令表（/new /model /effort …），
 * 而 CLI 的 `COMMAND_REGISTRY` 有 100+ 条。用户在输入框敲 `/status`、`/context`、
 * `/usage` 时，菜单给的是「没有匹配的指令」，Enter 被拦下 —— 命令全都用不了。
 *
 * 这些命令**不需要在桌面端重写**：serve 上已经有一套审过的执行通道
 *   - `commands.catalog` → 命令目录（分类 / 描述 / 参数模式 / 桌面处置）
 *   - `slash.exec`        → owner 替你执行（读写范围见网关的 _READ_COMMANDS 等白名单，
 *                          超出范围的会返回 unsupported_command + data.detail 告诉你该换什么）
 * 桌面端只做「取目录 / 送命令 / 显示结果」三件事，命令语义永远留在 CLI 里，
 * 不产生第二套实现，也就不会随 CLI 升级漂移。
 *
 * 三个返回类型（gateway/session_commands.py）：
 *   exec  → 直接是文本结果，桌面端作为一条系统条目插进对话流
 *   send  → 命令改写成一轮 prompt（如 /plan xxx），桌面端用自己的 input id 提交
 *   skill → 技能指令，同样由桌面端提交
 * 后两者必须回到渲染层走 prompt.submit，不能在这里替用户发回合。
 */
const profile = require('./hermes-profile');
const log = require('./logger');

const CATALOG_TIMEOUT_MS = 20000;
const EXEC_TIMEOUT_MS = 120000;
const TTL = 5 * 60 * 1000;
const MAX_COMMAND_LEN = 4000;

/**
 * 桌面端自己实现的命令。同名时**本地优先**：它们是纯 UI 动作（开面板、切视图），
 * 既不需要活会话、也不会因为 serve 没起来而失效，比 CLI 版本更贴合桌面场景。
 * 这里只用于「目录去重」，不参与执行路由。
 */
const DESKTOP_OWN = new Set([
  '/new', '/model', '/effort', '/yolo', '/rail', '/sessions',
  '/export', '/copy', '/help', '/gateway', '/kanban', '/orb',
]);

let _cache = null; // { key, at, data }
let _inflight = null;
/** stored session id → live session id。slash.exec 要的是 live id，而渲染层只有 stored id
 *  （回合结束时 liveByTab 会清空），所以这里缓存一份，失效时清空重取。 */
const _liveByStored = new Map();

function invalidate() { _cache = null; _inflight = null; _liveByStored.clear(); }

/** 命令名白名单：它是从后端拿的字符串，进 DOM 前仍要保证形状干净。 */
const CMD_RE = /^\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function cleanDesc(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * 把 `commands.catalog` 的原始返回压成渲染层直接可用的扁平表。
 *
 * 原始结构（tui_gateway/command_discovery.py）：
 *   { categories: [{name, pairs:[[/cmd, desc], …]}],   // 顺序即分类顺序
 *     commands: {'/cmd': {argument_mode, desktop, desktop_subcommands}},  // 别名也在这
 *     sub: {name: [subcmd…]}, canon: {alias → canonical}, warning, … }
 *
 * 纯函数，导出给单测。
 */
function normalizeCatalog(raw) {
  const cats = (raw && Array.isArray(raw.categories)) ? raw.categories : [];
  const metas = (raw && raw.commands && typeof raw.commands === 'object') ? raw.commands : {};
  const subs = (raw && raw.sub && typeof raw.sub === 'object') ? raw.sub : {};
  const aliasOf = (raw && raw.canon && typeof raw.canon === 'object') ? raw.canon : {};

  const seen = new Set();
  const commands = [];
  const categories = [];

  for (const cat of cats) {
    const name = cleanDesc(cat && cat.name) || 'Commands';
    const rows = [];
    for (const pair of (Array.isArray(cat && cat.pairs) ? cat.pairs : [])) {
      const cmd = String(Array.isArray(pair) ? pair[0] : '');
      if (!CMD_RE.test(cmd)) continue;
      const key = cmd.toLowerCase();
      // 桌面端自己的同名命令优先，别在同一张菜单里出现两条 /new
      if (DESKTOP_OWN.has(key) || seen.has(key)) continue;
      const meta = metas[cmd] || metas[key] || {};
      // desktop:'hidden' 是 CLI 明确要求桌面端不展示的（内部命令）
      if (meta.desktop === 'hidden') continue;
      const bare = cmd.slice(1);
      const subList = Array.isArray(subs[bare]) ? subs[bare].map(cleanDesc).filter(Boolean).slice(0, 24) : [];
      const subListAlt = meta.desktop_subcommands && Array.isArray(meta.desktop_subcommands)
        ? meta.desktop_subcommands.map(cleanDesc).filter(Boolean) : [];
      const row = {
        cmd,
        desc: cleanDesc(Array.isArray(pair) ? pair[1] : ''),
        category: name,
        // options / text / mixed / null —— null 表示这个命令不吃参数
        argMode: meta.argument_mode || (subList.length ? 'options' : null),
        sub: subList.length ? subList : subListAlt,
        // terminal: 只能在经典终端跑；advanced/settings: 归类用
        scope: meta.desktop || '',
      };
      seen.add(key);
      rows.push(row);
      commands.push(row);
    }
    if (rows.length) categories.push({ name, commands: rows });
  }

  // 别名映射（/x → /canonical），渲染层不需要，但保留给「输入别名后仍能对上高亮」
  const alias = {};
  for (const [from, to] of Object.entries(aliasOf)) {
    const k = String(from || '').toLowerCase();
    if (!CMD_RE.test(k)) continue;
    alias[k] = String(to || '').toLowerCase();
  }

  return {
    commands,
    categories,
    alias,
    warning: cleanDesc(raw && raw.warning),
  };
}

/** 目录不可用时的空壳：结构必须完整，渲染层直接用，不必再判空。 */
function emptyCatalog(error) {
  return { ok: false, error: String(error || '命令目录不可用'), commands: [], categories: [], alias: {}, warning: '' };
}

/**
 * 拉命令目录。缓存按 profile 隔离：切 profile 后命令集（含项目级技能）会变。
 * 失败**不抛**：渲染层拿到 ok:false 就退回本地命令表，菜单照常可用。
 */
async function catalog(gw) {
  const key = profile.current() || '';
  if (_cache && _cache.key === key && Date.now() - _cache.at < TTL) return _cache.data;
  if (_inflight) return _inflight;
  if (!gw) return emptyCatalog('gateway 未连接');

  _inflight = (async () => {
    try {
      // 只读、无副作用，不需要 session_id；profile 由主进程的连接身份决定，渲染层无权指定
      const raw = await gw.rpc('commands.catalog', {}, CATALOG_TIMEOUT_MS);
      const data = { ok: true, at: Date.now(), ...normalizeCatalog(raw) };
      _cache = { key, at: Date.now(), data };
      log.info('commands', 'catalog', { count: data.commands.length, categories: data.categories.length });
      return data;
    } catch (err) {
      const msg = String((err && err.message) || err || '命令目录不可用');
      log.warn('commands', 'catalog failed', { err: msg });
      return emptyCatalog(msg);
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * stored session id → live session id。
 * 桌面端的「活会话」是按回合建立的（GatewayTurn 自己持有 liveId，渲染层只拿到 storedId），
 * 而 slash.exec 要求 live id。这里用 session.resume 取回，并缓存以便连续敲命令时少一次往返。
 */
async function resolveLive(gw, storedId) {
  const hit = _liveByStored.get(storedId);
  if (hit) return hit;
  const r = await gw.rpc('session.resume', { session_id: storedId }, 30000);
  const live = String((r && r.session_id) || '');
  if (live) _liveByStored.set(storedId, live);
  return live;
}

/**
 * 执行一条 CLI 命令。
 * 返回归一化结构，**永远 resolve**（失败也 resolve 成 ok:false），
 * 因为命令不可用是常态（网关白名单只放行审过的命令），渲染层要把它当普通结果显示。
 */
async function exec(gw, { sessionId, command } = {}) {
  const sid = String(sessionId || '');
  const cmd = String(command || '').trim();
  if (!sid) return { ok: false, error: '这个会话还没有建立：先发送一条消息，再用命令' };
  if (!cmd.startsWith('/')) return { ok: false, error: '命令必须以 / 开头' };
  if (cmd.length > MAX_COMMAND_LEN) return { ok: false, error: '命令过长' };
  if (!gw) return { ok: false, error: 'gateway 未连接' };

  const run = async (liveId) => gw.rpc('slash.exec', { session_id: liveId, command: cmd }, EXEC_TIMEOUT_MS);

  try {
    let live = '';
    try {
      live = await resolveLive(gw, sid);
    } catch (e) {
      // resume 失败通常意味着会话已经不在了 —— 直接报给用户，别退化成「命令不存在」
      const m = String((e && e.message) || e);
      if (/not found|unknown session|no such/i.test(m)) return { ok: false, error: '会话已失效，请重新打开这个会话后再试' };
      throw e;
    }
    if (!live) return { ok: false, error: '会话已失效，请重新打开这个会话后再试' };

    let res;
    try {
      res = await run(live);
    } catch (e) {
      // 缓存里的 live id 被 serve 重启作废：清掉重取一次，再放弃
      _liveByStored.delete(sid);
      const again = await resolveLive(gw, sid).catch(() => '');
      if (!again) throw e;
      res = await run(again);
    }

    const type = String((res && res.type) || 'exec');
    if (type === 'send') {
      return {
        ok: true,
        type: 'send',
        // 命令改写成的这一轮 prompt，交给渲染层用 prompt.submit 提交
        text: String(res.message || ''),
        display: String(res.display || cmd),
        notice: String(res.notice || ''),
      };
    }
    if (type === 'skill') {
      return { ok: true, type: 'skill', text: String(res.message || res.text || ''), display: cmd };
    }
    // type === 'exec'
    return { ok: true, type: 'exec', text: String((res && res.output) || '') };
  } catch (err) {
    // 网关拒绝时会带 data.detail：CLI 给的「改用哪条命令」提示，比英文原句有用得多
    const detail = err && err.data && typeof err.data === 'object' ? err.data.detail : '';
    const main = String((err && err.message) || err || '命令执行失败');
    const text = detail ? `${main}\n${detail}` : main;
    log.info('commands', 'exec rejected', { command: cmd.split(/\s+/)[0], err: main, detail: String(detail || '') });
    return { ok: false, error: text, refused: /unsupported_command|not available/i.test(`${main} ${detail}`) };
  }
}

module.exports = { catalog, exec, invalidate, normalizeCatalog, DESKTOP_OWN };
