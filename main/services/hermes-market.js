'use strict';
/**
 * hermes-market.js — 插件 / 技能市场（封装 hermes CLI 原生 registries）
 *
 * 数据源：
 *   plugins → curated catalog（本地 JSON，秒级）   `hermes plugins search --json`
 *   skills  → skills.sh / ClawHub / GitHub / well-known 聚合（需网络）
 *             `hermes skills search <q> --json --limit N [--source X]`
 *
 * 所有调用走串行队列：CLI 冷启 1–8s、安装可能 git clone，避免并发互相覆盖
 * 用户配置。写操作只对白名单 op 开放，identifier 经字符校验且用 spawn 数组
 * 传参（不经 shell），不会变成额外 CLI 选项或命令注入。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hermesPlugins = require('./hermes-plugins');
const hermesSkills = require('./hermes-skills');
const profile = require('./hermes-profile');
const { resolveHermesBin, safeArg } = require('./hermes-bin');
const log = require('./logger');

const HERMES_BIN = process.env.HERMES_BIN || resolveHermesBin();
const SOURCES = new Set(['all', 'official', 'skills-sh', 'well-known', 'github', 'clawhub',
  'lobehub', 'browse-sh', 'nvidia', 'openai', 'anthropic', 'huggingface', 'voltagent', 'gstack', 'minimax']);
const OPS = new Set(['install', 'uninstall', 'update', 'inspect']);
const WRITE_OPS = new Set(['install', 'uninstall', 'update']);
const REF_RE = /^[0-9a-f]{40}$/i;
const PLUGIN_TTL = 30 * 60 * 1000;
const PLUGIN_HARD_TTL = 30 * 24 * 60 * 60 * 1000;
const PLUGIN_CACHE_FILE = 'market-plugins-catalog.json';
const SKILL_TTL = 5 * 60 * 1000;
const SKILL_CACHE_MAX = 30;

let _queue = Promise.resolve();
let _emit = null;
let _pluginCatalog = null;      // { profile, items, at }
let _pluginInflight = null;     // { profile, promise }
let _diskTriedProfile = null;
const _skillCache = new Map();  // key -> { items, at }
const setEmitter = (fn) => { _emit = typeof fn === 'function' ? fn : null; };
const progress = (phase, text) => { if (_emit) { try { _emit({ phase, text }); } catch {} } };

function run(args, timeout) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false, hb = null, killTimer = null, hardTimer = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (hb) clearInterval(hb);
      clearTimeout(killTimer); clearTimeout(hardTimer);
      resolve(r);
    };
    let p;
    try {
      p = spawn(HERMES_BIN, profile.cliArgs(args), { timeout, env: profile.env({ NO_COLOR: '1', TERM: 'dumb' }) });
    } catch (e) {
      return done({ code: -1, stdout: '', stderr: String(e), timedOut: false });
    }
    // spawn 的 timeout 只发 SIGTERM；git clone / 网络挂起的子进程可能忽略它，
    // 导致 close 永不触发、串行队列被永久堵死。这里补 SIGKILL 与硬超时兜底。
    if (timeout) {
      killTimer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeout + 2000);
      hardTimer = setTimeout(() => {
        log.warn('market', `hard timeout: ${args.slice(0, 3).join(' ')}`);
        done({ code: -1, stdout: out, stderr: err + '\n执行超时（已强制结束）', timedOut: true });
      }, timeout + 5000);
    }
    let elapsed = 0;
    hb = setInterval(() => {
      elapsed += 8;
      progress('busy', `仍在执行 hermes ${args.slice(0, 2).join(' ')}… ${elapsed}s`);
    }, 8000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => done({ code, stdout: out, stderr: err, timedOut: code === null }));
    p.on('error', (e) => done({ code: -1, stdout: out, stderr: err + '\n' + String(e), timedOut: false }));
  });
}

/** 串行排队：同一时间只跑一条 CLI 命令，避免并发写坏 config.yaml。 */
function enqueue(label, job, { quiet = false } = {}) {
  const runJob = _queue.then(async () => {
    if (!quiet) progress('start', label);
    try { return await job(); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    finally { if (!quiet) progress('done', label); }
  });
  _queue = runJob.then(() => {}, () => {});
  return runJob;
}

function pluginCachePath() {
  const dir = profile.dataDir();
  return dir ? path.join(dir, PLUGIN_CACHE_FILE) : '';
}

function readPluginDisk(prof) {
  if (_pluginCatalog && _pluginCatalog.profile === prof) return _pluginCatalog;
  if (_diskTriedProfile === prof) return null;
  _diskTriedProfile = prof;
  const file = pluginCachePath();
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || raw.profile !== prof) return null;
    if (!Array.isArray(raw.items) || !raw.items.length) return null;
    const at = Number(raw.at) || 0;
    if (!at || Date.now() - at > PLUGIN_HARD_TTL) return null;
    _pluginCatalog = { profile: prof, items: raw.items, at };
    return _pluginCatalog;
  } catch { return null; }
}

function writePluginDisk(prof, items, at) {
  const file = pluginCachePath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ profile: prof, at, items }));
    fs.renameSync(tmp, file);
  } catch {}
}

function filterPluginItems(items, q) {
  if (!q) return items.map((it) => ({ ...it }));
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => {
    const hay = `${it.id} ${it.name} ${it.description} ${it.category} ${it.maintainer} ${it.source}`.toLowerCase();
    return tokens.every((tk) => hay.includes(tk));
  }).map((it) => ({ ...it }));
}

function attachInstalled(items, installed) {
  return items.map((it) => {
    const short = it.id.split('/').pop();
    return { ...it, installed: installed.has(it.id) || installed.has(it.name) || installed.has(short) };
  });
}

function refreshPluginCatalog(prof, { background = false } = {}) {
  if (_pluginInflight && _pluginInflight.profile === prof) return _pluginInflight.promise;
  const args = ['plugins', 'search', '--json'];
  const promise = enqueue('正在读取插件目录…', async () => {
    const r = await run(args, 60000);
    if (r.timedOut) return { ok: false, error: '命令超时，网络可能不可达；可复制命令到终端重试', args };
    if (r.code !== 0) return { ok: false, error: digest(r, 400) || `hermes 退出码 ${r.code}`, args };
    let items;
    try {
      items = normalizePlugins(JSON.parse(r.stdout));
    } catch {
      return { ok: false, error: 'CLI 输出不是合法 JSON：' + digest(r, 240), args };
    }
    const at = Date.now();
    _pluginCatalog = { profile: prof, items, at };
    writePluginDisk(prof, items, at);
    if (background) progress('catalog-updated', '插件目录已后台更新');
    return { ok: true, items, at, args };
  }, { quiet: background }).finally(() => {
    if (_pluginInflight && _pluginInflight.promise === promise) _pluginInflight = null;
  });
  _pluginInflight = { profile: prof, promise };
  return promise;
}

function safeId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > 400) return null;
  if (s.startsWith('-') || /[\x00-\x1f;`|&$<>]/.test(s)) return null;
  return s;
}

/** 从 CLI 文本输出里挑出可读的结尾摘要（去掉 ANSI 与空行）。 */
function digest(r, limit = 900) {
  const clean = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').trim();
  const text = clean(r.stdout) || clean(r.stderr);
  return text.slice(-limit);
}

async function installedNames(kind) {
  const set = new Set();
  try {
    if (kind === 'plugins') {
      const r = await hermesPlugins.listPlugins();
      (r.plugins || []).forEach((p) => { set.add(p.name); if (p.configKey) set.add(p.configKey); });
    } else {
      const r = await hermesSkills.listSkills();
      (r.skills || []).forEach((s) => set.add(s.name));
    }
  } catch {}
  return set;
}

function normalizePlugins(j) {
  // v0.23.0 目录新增 verified 层级（厂商官方构建），不能与普通 official 混为一谈；
  // needs_newer_hermes 表示当前 CLI 版本装不了，提前透出免得装到一半才报错。
  const TIER = { community: ['community', '社区'], verified: ['verified', '已验证'], official: ['trusted', '官方'] };
  return (j.results || []).map((x) => {
    const [trust, trustLabel] = TIER[x.tier] || ['trusted', '官方'];
    return {
      id: x.name || '', name: x.name || '', description: x.description || '',
      source: 'Hermes 精选目录', trust, trustLabel,
      repo: x.repo || '', docsUrl: x.docs_url || '', version: x.version || '',
      category: x.category || '', maintainer: x.maintainer || '',
      capabilities: x.capabilities || {}, requiresHermes: x.requires_hermes || '',
      needsNewer: x.needs_newer_hermes || '', issues: Array.isArray(x.known_issues) ? x.known_issues.length : 0,
    };
  }).filter((x) => x.id);
}
function normalizeSkills(arr) {
  return (Array.isArray(arr) ? arr : []).map((x) => ({
    id: x.identifier || x.name || '', name: x.name || '', description: x.description || '',
    source: x.source || '', trust: x.trust_level || 'community',
    trustLabel: ({ builtin: '内置', trusted: '可信', official: '官方' })[x.trust_level] || '社区',
    repo: /^https?:\/\//.test(x.identifier || '') ? x.identifier : '', docsUrl: '', version: '',
    category: '', maintainer: '', capabilities: {}, requiresHermes: '',
  })).filter((x) => x.id);
}

/** 搜索 / 浏览市场；插件走内存/磁盘缓存 + 本地过滤 + 后台刷新，技能走短时内存缓存。 */
async function search(kind, query, opts = {}) {
  if (kind !== 'plugins' && kind !== 'skills') return { ok: false, error: '未知市场类型' };
  const q = String(query == null ? '' : query).trim().slice(0, 120);
  // query 原样作为 CLI 位置参数；防止以 '-' 开头被解析成额外选项
  if (q && (q.startsWith('-') || /[\x00-\x1f;`|&$<>]/.test(q))) {
    return { ok: false, error: '搜索词包含非法字符' };
  }
  const t0 = Date.now();
  const prof = profile.current();
  const force = !!opts.force;

  if (kind === 'plugins') {
    const args = ['plugins', 'search', ...(q ? [q] : []), '--json'];
    const cached = !force ? readPluginDisk(prof) : null;
    if (cached) {
      const installed = await installedNames('plugins');
      const items = attachInstalled(filterPluginItems(cached.items, q), installed);
      const stale = Date.now() - cached.at > PLUGIN_TTL;
      if (stale) refreshPluginCatalog(prof, { background: true });
      return { ok: true, kind, query: q, items, ms: Date.now() - t0, cached: true, stale, args };
    }
    const [r, installed] = await Promise.all([refreshPluginCatalog(prof, { background: false }), installedNames('plugins')]);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读取插件目录失败', args };
    const items = attachInstalled(filterPluginItems(r.items, q), installed);
    return { ok: true, kind, query: q, items, ms: Date.now() - t0, cached: false, stale: false, args };
  }

  const limit = String(Math.min(Math.max(+opts.limit || 30, 1), 100));
  const source = SOURCES.has(opts.source) && opts.source !== 'all' ? opts.source : 'all';
  const skillKey = `${prof}||${source}||${limit}||${q}`;
  if (!force && _skillCache.has(skillKey)) {
    const entry = _skillCache.get(skillKey);
    if (Date.now() - entry.at < SKILL_TTL) {
      const installed = await installedNames('skills');
      const items = attachInstalled(entry.items.map((it) => ({ ...it })), installed);
      return { ok: true, kind, query: q, items, ms: Date.now() - t0, cached: true, args: ['skills', 'search', q, '--json'] };
    }
    _skillCache.delete(skillKey);
  }
  const args = ['skills', 'search', q, '--json', '--limit', limit,
    ...(source !== 'all' ? ['--source', source] : [])];
  return enqueue(`正在搜索「${q || '全部技能'}」…`, async () => {
    const [r, installed] = await Promise.all([run(args, 90000), installedNames('skills')]);
    if (r.timedOut) return { ok: false, error: '命令超时，网络可能不可达；可复制命令到终端重试', args };
    if (r.code !== 0) return { ok: false, error: digest(r, 400) || `hermes 退出码 ${r.code}`, args };
    let rawItems;
    try {
      rawItems = normalizeSkills(JSON.parse(r.stdout));
    } catch (e) {
      return { ok: false, error: 'CLI 输出不是合法 JSON：' + digest(r, 240), args };
    }
    if (_skillCache.size >= SKILL_CACHE_MAX) {
      const firstKey = _skillCache.keys().next().value;
      if (firstKey !== undefined) _skillCache.delete(firstKey);
    }
    _skillCache.set(skillKey, { items: rawItems, at: Date.now() });
    const items = attachInstalled(rawItems, installed);
    return { ok: true, kind, query: q, items, ms: Date.now() - t0, cached: false, args };
  });
}

function actionArgs(kind, op, id, opts) {
  if (kind === 'plugins') {
    // 安全默认：不自动启用、不自动下载 Python 依赖。两者都需用户显式放行。
    if (op === 'install') {
      const args = ['plugins', 'install', id,
        opts.enable ? '--enable' : '--no-enable',
        opts.deps === true ? '--yes-deps' : '--no-deps'];
      if (opts.ref && REF_RE.test(opts.ref)) args.push('--ref', opts.ref);
      return args;
    }
    if (op === 'uninstall') return ['plugins', 'remove', id];
    if (op === 'update') return ['plugins', 'update', id];
    if (op === 'inspect') return ['plugins', 'show', id];
  } else {
    if (op === 'install') return ['skills', 'install', id, '--yes'];
    if (op === 'uninstall') return ['skills', 'uninstall', id, '--yes'];
    if (op === 'update') return ['skills', 'update', id];
    if (op === 'inspect') return ['skills', 'inspect', id];
  }
  return null;
}

/** 安装 / 卸载 / 更新 / 查看详情；成功后让本地列表缓存失效。 */
async function action(kind, op, identifier, opts = {}) {
  if (kind !== 'plugins' && kind !== 'skills') return { ok: false, error: '未知市场类型' };
  if (!OPS.has(op)) return { ok: false, error: '不支持的操作' };
  const id = safeId(identifier);
  if (!id) return { ok: false, error: '条目标识不合法' };
  const args = actionArgs(kind, op, id, opts);
  if (!args) return { ok: false, error: '无法构造命令' };
  if (opts.ref != null && opts.ref !== '' && !REF_RE.test(String(opts.ref))) {
    return { ok: false, error: '提交 SHA 必须是 40 位十六进制字符' };
  }
  const label = ({ install: '安装', uninstall: '卸载', update: '更新', inspect: '读取详情' })[op];
  const timeout = op === 'install' ? 300000 : op === 'update' ? 240000 : op === 'inspect' ? 120000 : 90000;
  return enqueue(`${label} ${id.split('/').pop()}…`, async () => {
    const r = await run(args, timeout);
    if (r.timedOut) return { ok: false, error: `${label}超时，请检查网络后重试`, args };
    const result = { ok: r.code === 0, code: r.code, text: digest(r), args, op };
    if (!result.ok) result.error = digest(r, 500) || `hermes 退出码 ${r.code}`;
    if (result.ok && WRITE_OPS.has(op)) {
      if (kind === 'plugins') hermesPlugins.invalidate();
      else hermesSkills.invalidate();
    }
    return result;
  });
}

/**
 * 只读更新检查。插件目录有结构化 JSON，可精确给出「有更新」名单；
 * skills check 只有文本输出，原样回传供界面展示，不做脆弱解析。
 */
async function checkUpdates(kind) {
  if (kind !== 'plugins' && kind !== 'skills') return { ok: false, error: '未知市场类型' };
  const args = kind === 'plugins' ? ['plugins', 'check-updates', '--json'] : ['skills', 'check'];
  return enqueue(kind === 'plugins' ? '正在检查插件更新…' : '正在检查技能更新…', async () => {
    const r = await run(args, 90000);
    if (r.timedOut) return { ok: false, error: '更新检查超时，请稍后重试', args };
    if (r.code !== 0) return { ok: false, error: digest(r, 400) || `hermes 退出码 ${r.code}`, args };
    const text = digest(r, 2000);
    let names = [];
    if (kind === 'plugins') {
      try {
        const j = JSON.parse(r.stdout);
        names = (Array.isArray(j) ? j : (j.results || []))
          .filter((x) => x && x.update_available === true && x.name)
          .map((x) => String(x.name));
      } catch { return { ok: false, error: 'CLI 输出不是合法 JSON', args, text }; }
    }
    return { ok: true, kind, names, text, args };
  });
}

module.exports = { search, action, actionArgs, checkUpdates, setEmitter, SOURCES: [...SOURCES] };
