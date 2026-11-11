'use strict';
/**
 * hermes-plugins.js — 真实 hermes CLI 插件管理通道
 *
 * 列表：`hermes plugins list --json` 是整页加载里最贵的一步（实测 6.5–7.2s：
 *       Python 冷启 + 插件管理器加载 + 1050 条目录扫描），因此绝不把它放在
 *       用户点开页面的路径上。策略是「磁盘缓存 + stale-while-revalidate」：
 *
 *         1. 内存命中 → 毫秒返回（新鲜期 TTL 内不做任何刷新）
 *         2. 内存未命中 → 读 userData/catalog-plugins.json（上次运行的结果），
 *            仍然毫秒返回；同时后台异步刷新，刷新完通过 emitter 通知渲染层重绘
 *         3. 只有「从未成功拉取过」才阻塞等 CLI —— 一次性代价，之后永久秒开
 *
 *       缓存按 profile 名隔离（不同 profile 的插件集合不同），文件放 Electron
 *       自己的 userData，不写 ~/.hermes。
 * 开关：仍走官方 CLI。插件激活涉及 canonical key 解析、别名清理、capability
 *       consent 与 PM 的 selection 事务，直接改 YAML 会绕过这些校验。为避免
 *       连点导致并发 CLI 互相覆盖，写操作经串行队列，并由渲染层做乐观更新。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yamlCfg = require('./hermes-config-yaml');
const { resolveRuntime } = require('./hermes-skills');
const profile = require('./hermes-profile');
const { resolveHermesBin, safeArg } = require('./hermes-bin');

const HERMES_BIN = process.env.HERMES_BIN || resolveHermesBin();
// 新鲜期：这段时间内连后台刷新都不触发（避免每次开页面都白烧一遍 CLI）
const TTL = 30 * 60 * 1000;
// 磁盘缓存最长期限：超过认为不可用（可能换过 CLI 版本），回到冷路径
const HARD_TTL = 30 * 24 * 60 * 60 * 1000;
const CACHE_FILE = 'catalog-plugins.json';

let _cache = null;   // { plugins:[...], at:number }
let _inflight = null;
let _writeQueue = Promise.resolve();
let _emitter = null;
let _diskTried = false;
let _diskTimer = null;

/** 主进程注入：刷新完成后通知渲染层（由 main.js 接到 webContents.send）。 */
function setEmitter(fn) { _emitter = typeof fn === 'function' ? fn : null; }
function emit() {
  if (!_emitter || !_cache) return;
  try { _emitter({ kind: 'plugins', at: _cache.at, count: _cache.plugins.length }); } catch {}
}

function cachePath() {
  const dir = profile.dataDir();
  return dir ? path.join(dir, CACHE_FILE) : '';
}

/** 读上次运行落盘的列表；只读一次，profile 不匹配或过期则视为没有。 */
function readDisk() {
  if (_cache) return _cache;
  if (_diskTried) return null;
  _diskTried = true;
  const file = cachePath();
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || raw.profile !== profile.current()) return null;
    if (!Array.isArray(raw.plugins) || !raw.plugins.length) return null;
    const at = Number(raw.at) || 0;
    if (!at || Date.now() - at > HARD_TTL) return null;
    _cache = { plugins: raw.plugins, at };
    return _cache;
  } catch { return null; }
}

/** 落盘（合并 1.5s 内的多次调用，避免 config 监听抖动时反复写）。 */
function writeDisk() {
  if (_diskTimer) return;
  _diskTimer = setTimeout(() => {
    _diskTimer = null;
    const file = cachePath();
    if (!file || !_cache) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ profile: profile.current(), at: _cache.at, plugins: _cache.plugins }));
      fs.renameSync(tmp, file);
    } catch {}
  }, 1500);
  if (_diskTimer.unref) _diskTimer.unref();
}

function run(args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    try {
      const p = spawn(HERMES_BIN, profile.cliArgs(args), { timeout, env: profile.env({ NO_COLOR: '1' }) });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ code, stdout, stderr }));
      p.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
    }
  });
}

/** 把 CLI 的 manifest name 映射到 config.yaml 里登记的 canonical key。 */
function canonicalKey(name, cfgKeys) {
  const norm = (s) => String(s).toLowerCase().replace(/[\\/_]/g, '-');
  for (const k of cfgKeys) {
    if (k === name || k.split('/').pop() === name || norm(k) === norm(name)) return k;
  }
  return name;
}

// CLI 的 `plugins list --json` 不含 canonical key，且存在重名 manifest
//（如 image_gen/deepinfra 与 video_gen/deepinfra 都叫 deepinfra）。
// 扫描本地 plugin.yaml 建立 name / description → 目录相对路径的索引，
// 让开关与卡片显示都用真实 key，避免歧义。纯文件读取，毫秒级。
let _manifestIndex = null;
function cleanDesc(v) {
  return String(v || '').replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function descToken(name, desc) { return String(name) + '|' + cleanDesc(desc).slice(0, 40); }
function buildManifestIndex() {
  if (_manifestIndex) return _manifestIndex;
  const byDesc = new Map(), byName = new Map();
  const roots = [];
  const rt = resolveRuntime();
  if (rt && rt.root) roots.push(path.join(rt.root, 'plugins'));
  roots.push(profile.pluginsDir());
  const add = (file, key) => {
    try {
      const t = fs.readFileSync(file, 'utf8');
      const nm = (t.match(/^name:\s*(.+)$/m) || [])[1];
      const ds = (t.match(/^description:\s*(.+)$/m) || [])[1];
      if (!nm) return;
      const name = String(nm).replace(/^["']|["']$/g, '').trim();
      byDesc.set(descToken(name, ds), key);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(key);
    } catch {}
  };
  for (const base of roots) {
    let top = [];
    try { top = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const d1 of top) {
      if (!d1.isDirectory() || d1.name.startsWith('__') || d1.name.startsWith('.')) continue;
      const p1 = path.join(base, d1.name);
      add(path.join(p1, 'plugin.yaml'), d1.name);              // 用户插件：目录名即 key
      let sub = [];
      try { sub = fs.readdirSync(p1, { withFileTypes: true }); } catch { continue; }
      for (const d2 of sub) {
        if (!d2.isDirectory() || d2.name.startsWith('__') || d2.name.startsWith('.')) continue;
        add(path.join(p1, d2.name, 'plugin.yaml'), d1.name + '/' + d2.name); // bundled：分类/名称
      }
    }
  }
  _manifestIndex = { byDesc, byName };
  return _manifestIndex;
}
function resolveConfigKey(p, cfgKeys) {
  const idx = buildManifestIndex();
  const hit = idx.byDesc.get(descToken(p.name, p.description));
  if (hit) return hit;
  const fromCfg = canonicalKey(p.name, cfgKeys);
  if (fromCfg !== p.name) return fromCfg;
  const names = idx.byName.get(p.name) || [];
  return names.length === 1 ? names[0] : p.name;
}

function syncStates() {
  if (!_cache) return;
  try {
    const lists = yamlCfg.readLists();
    const on = new Set(lists['plugins.enabled'] || []);
    const off = new Set(lists['plugins.disabled'] || []);
    for (const p of _cache.plugins) {
      if (off.has(p.configKey) || off.has(p.name)) p.enabled = false;
      else if (on.has(p.configKey) || on.has(p.name)) p.enabled = true;
    }
    _cache.at = Date.now();
    writeDisk();
  } catch {}
}

yamlCfg.watch(syncStates);
/** 作废内存 + 磁盘缓存。装/卸插件、切换 profile 后必须走这里，
 *  否则下一次读会把磁盘里那份「装之前」的旧列表当缓存再拿出来。 */
function invalidate() {
  _cache = null;
  _manifestIndex = null;
  _diskTried = false;
  const file = cachePath();
  if (file) { try { fs.unlinkSync(file); } catch {} }
}

/** 真正跑 CLI 拉一次列表；并发调用共享同一个 in-flight，免得叠起多个 7s 子进程。 */
function refresh() {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const r = await run(['plugins', 'list', '--json']);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `exit ${r.code}`, plugins: [] };
    try {
      const raw = JSON.parse(r.stdout);
      let cfgKeys = [];
      try {
        const lists = yamlCfg.readLists();
        cfgKeys = [...(lists['plugins.enabled'] || []), ...(lists['plugins.disabled'] || [])];
      } catch {}
      const plugins = raw.map((p) => {
        const name = p.name;
        return {
          id: name, name, desc: p.description || '',
          version: p.version || '', source: p.source || '',
          enabled: String(p.status || '').trim() === 'enabled',
          configKey: resolveConfigKey(p, cfgKeys),
        };
      });
      _cache = { plugins, at: Date.now() };
      writeDisk();
      emit();
      return { ok: true, plugins };
    } catch (err) {
      return { ok: false, error: `JSON 解析失败：${err.message}`, plugins: [] };
    }
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * 已装插件列表。缓存命中毫秒返回；force=true 才阻塞等 CLI（刷新按钮用）。
 * revalidate=true 表示「先给缓存、同时一定重拉一次」（装/卸插件之后用）。
 * 返回里的 stale 表示「这是旧数据，后台正在刷新」，渲染层据此给轻提示。
 */
async function listPlugins({ force = false, revalidate = false } = {}) {
  if (!force) {
    const mem = _cache || readDisk();
    if (mem) {
      const age = Date.now() - mem.at;
      const stale = age >= TTL;
      if (stale || revalidate) refresh().catch(() => {});   // 后台刷新，不等
      return { ok: true, plugins: mem.plugins, cached: true, stale, ageMs: age };
    }
  }
  const r = await refresh();
  if (r.ok) return { ok: true, plugins: r.plugins, cached: false, stale: false, ageMs: 0 };
  // CLI 失败但有旧缓存：宁可显示旧列表 + 警告，也不要空页面
  if (_cache) return { ok: true, plugins: _cache.plugins, cached: true, stale: true, warning: r.error };
  return { ok: false, error: r.error, plugins: [] };
}

/** 启用/停用插件（串行 CLI；完成后同步内存状态）。 */
function setPluginEnabled(name, enabled) {
  // name 会作为 CLI 位置参数；拒绝前导 - 与控制/注入字符，避免变成额外选项
  if (!safeArg(name, 200)) return Promise.resolve({ ok: false, error: '插件名不合法' });
  const job = _writeQueue.then(async () => {
    // canonical key 优先，保证写入的键与 PM 加载时一致
    let key = name;
    if (_cache) {
      const hit = _cache.plugins.find((p) => p.name === name || p.configKey === name);
      if (hit && hit.configKey) key = hit.configKey;
    }
    if (!safeArg(key, 200)) return { ok: false, error: '插件键不合法' };
    const r = await run(['plugins', enabled ? 'enable' : 'disable', key], { timeout: 25000 });
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || `exit ${r.code}` };
    if (_cache) {
      const hit = _cache.plugins.find((p) => p.name === name || p.configKey === name);
      if (hit) hit.enabled = !!enabled;
      _cache.at = Date.now();
      writeDisk();
    }
    return { ok: true, enabled: !!enabled };
  }).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
  _writeQueue = job.then(() => {}, () => {});
  return job;
}

/** 单个插件详情（hermes plugins show <name>）。
 *  v0.23.0 起 `show` 不再接受 `--json`（argparse 直接报 usage），所以先试 JSON，
 *  被拒则退回纯文本——CLI 排版会变，文本只原样透出，不做结构化猜测。 */
async function showPlugin(name) {
  if (!name || typeof name !== 'string') return { ok: false, error: 'invalid plugin name' };
  const r = await run(['plugins', 'show', '--json', name]);
  if (r.code === 0 && r.stdout.trim().startsWith('{')) {
    try { return { ok: true, plugin: JSON.parse(r.stdout) }; } catch {}
  }
  const text = await run(['plugins', 'show', name]);
  if (text.code !== 0) return { ok: false, error: (text.stderr || text.stdout).trim() || `exit ${text.code}` };
  return { ok: true, plugin: null, text: text.stdout.trim() };
}

/** 插件目录（hermes plugins browse）原始输出 */
async function browseCatalog() {
  const r = await run(['plugins', 'browse']);
  return { ok: r.code === 0, text: r.stdout, error: r.code === 0 ? '' : r.stderr.trim() };
}

/** 启动后台预热 */
function warm() { return listPlugins().catch(() => {}); }

module.exports = { listPlugins, setPluginEnabled, showPlugin, browseCatalog, invalidate, warm, setEmitter };
