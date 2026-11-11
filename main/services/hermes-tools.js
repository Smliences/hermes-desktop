'use strict';
/**
 * hermes-tools.js — 工具集开关（CLI 是唯一真源）
 *
 * 设计边界：
 *   - 桌面端只操作 **cli 平台**：`hermes tools list` 会按平台分段（cli / telegram /
 *     discord …），其余分段原样保留但不展示、不可点，避免误改别的接入方式。
 *   - 名称走白名单正则：它是拼进 argv 的值，虽经 execFile 无 shell，仍拒绝空格、
 *     引号、换行与 `server:tool` 之外的奇怪字符。
 *   - 每次开/关后 **回读列表**，以 CLI 的真实状态返回给渲染层；CLI 幂等或静默
 *     失败时不会假装成功。
 *   - 串行队列 + SIGKILL 兜底：连点不会并发改写同一 profile 的配置。
 *
 * 缓存策略：`hermes tools list` 实测 6.5–7.5s（Python 冷启 + 平台探测），因此列表
 * 与插件 / 技能页同款「userData 磁盘缓存 + stale-while-revalidate」——缓存命中毫秒
 * 返回，过期先给旧数据再后台重拉；**开关后的回读永不读缓存**，保证状态是真的。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const profile = require('./hermes-profile');
const { resolveHermesBin } = require('./hermes-bin');
const yamlCfg = require('./hermes-config-yaml');
const log = require('./logger');

const HERMES_BIN = process.env.HERMES_BIN || resolveHermesBin();
const TIMEOUT_MS = 20000;
const MAX_OUTPUT = 64000;
const TTL = 30 * 60 * 1000;
const HARD_TTL = 30 * 24 * 60 * 60 * 1000;
const CACHE_FILE = 'catalog-tools.json';

/** 允许的工具名：内置 toolset（web / code_execution）、MCP 的 server:tool。 */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

let queue = Promise.resolve();
let _cache = null;      // { sections, otherPlatforms, at }
let _inflight = null;
let _emitter = null;
let _diskTried = false;
let _diskTimer = null;

function setEmitter(fn) { _emitter = typeof fn === 'function' ? fn : null; }
function emit() {
  if (!_emitter || !_cache) return;
  try { _emitter({ kind: 'tools', at: _cache.at, count: _cache.sections.reduce((n, s) => n + s.items.length, 0) }); } catch {}
}

function cachePath() {
  const dir = profile.dataDir();
  return dir ? path.join(dir, CACHE_FILE) : '';
}
function readDisk() {
  if (_cache) return _cache;
  if (_diskTried) return null;
  _diskTried = true;
  const file = cachePath();
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || raw.profile !== profile.current()) return null;
    if (!Array.isArray(raw.sections) || !raw.sections.length) return null;
    const at = Number(raw.at) || 0;
    if (!at || Date.now() - at > HARD_TTL) return null;
    _cache = { sections: raw.sections, otherPlatforms: Array.isArray(raw.otherPlatforms) ? raw.otherPlatforms : [], at };
    return _cache;
  } catch { return null; }
}
function writeDisk() {
  if (_diskTimer) return;
  _diskTimer = setTimeout(() => {
    _diskTimer = null;
    const file = cachePath();
    if (!file || !_cache) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        profile: profile.current(), at: _cache.at,
        sections: _cache.sections, otherPlatforms: _cache.otherPlatforms,
      }));
      fs.renameSync(tmp, file);
    } catch {}
  }, 1500);
  if (_diskTimer.unref) _diskTimer.unref();
}

function exec(argv) {
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(killer); resolve(v); } };
    const killer = setTimeout(() => {
      if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, error: '工具命令超时', text: '' });
    }, TIMEOUT_MS + 3000);
    try {
      child = execFile(HERMES_BIN, profile.cliArgs(argv), {
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: profile.env({ NO_COLOR: '1' }),
      }, (err, stdout, stderr) => {
        const text = String(stdout || '').slice(0, MAX_OUTPUT);
        if (err) {
          const lines = String(stderr || '').split('\n').map((x) => x.trim()).filter(Boolean);
          return finish({ ok: false, text, error: lines.length ? lines[lines.length - 1] : String(err.message).split('\n')[0] });
        }
        finish({ ok: true, text });
      });
      child.on('error', (err) => finish({ ok: false, text: '', error: String(err) }));
    } catch (err) {
      finish({ ok: false, text: '', error: String(err) });
    }
  });
}

const SECTION_RE = /^(.*?)\s*\(([A-Za-z_-]+)\)\s*:?\s*$/;
/** `  ✓ enabled  web  🔍 Web Search & Scraping` / `  ✗ disabled  video  🎬 Video Analysis` */
const ITEM_RE = /^\s*([✓✔✗✘])\s+(enabled|disabled)\s+(\S+)(?:\s+(.*))?$/;

/**
 * 解析 `hermes tools list` 的人类可读输出。
 * 只返回 cli 分段；其他平台分段标记为 hidden，既不改也不展示。
 */
function parseToolList(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r/g, '');
    const sec = line.match(SECTION_RE);
    if (sec) {
      cur = { title: sec[1].trim(), platform: sec[2].toLowerCase(), items: [] };
      out.push(cur);
      continue;
    }
    const it = line.match(ITEM_RE);
    if (it && cur) {
      cur.items.push({
        name: it[3],
        label: (it[4] || '').trim(),
        enabled: it[2] === 'enabled',
      });
    }
  }
  return out.filter((s) => s.items.length);
}

/** 真跑一次 CLI 并解析（不走缓存；开关后的回读必须用它）。 */
async function readListRaw() {
  const r = await exec(['tools', 'list']);
  if (!r.ok) return { ok: false, error: r.error || '读取工具列表失败' };
  const sections = parseToolList(r.text);
  if (!sections.length) return { ok: false, error: '未能解析工具列表（CLI 输出格式可能已变化）' };
  const cli = sections.filter((s) => s.platform === 'cli');
  return {
    ok: true,
    sections: cli,
    otherPlatforms: sections.filter((s) => s.platform !== 'cli').map((s) => s.platform),
  };
}

function commit(sections, otherPlatforms) {
  _cache = { sections, otherPlatforms: otherPlatforms || [], at: Date.now() };
  writeDisk();
  emit();
  return _cache;
}

/** 后台/阻塞刷新：串行队列复用，避免与开关操作并发起两个 CLI。 */
function refresh() {
  if (_inflight) return _inflight;
  const job = queue.then(readListRaw, readListRaw);
  queue = job.catch(() => {});
  _inflight = job
    .then((r) => {
      if (!r.ok) return r;
      const c = commit(r.sections, r.otherPlatforms);
      return { ok: true, sections: c.sections, otherPlatforms: c.otherPlatforms };
    })
    .finally(() => { _inflight = null; });
  return _inflight;
}

/** 作废内存 + 磁盘缓存（切换 profile 后必须走这里）。 */
function invalidate() {
  _cache = null;
  _diskTried = false;
  const file = cachePath();
  if (file) { try { fs.unlinkSync(file); } catch {} }
}

// 终端里 `hermes tools enable|disable` 也会改 config.yaml：把缓存标记为过期，
// 下次读取先给旧值再后台重拉，避免最长 30 分钟显示过期状态。
yamlCfg.watch(() => { if (_cache) _cache.at = Math.min(_cache.at, Date.now() - TTL - 1); });

/**
 * 读列表。缓存命中毫秒返回；force=true 才阻塞等 CLI（显式刷新）。
 * revalidate=true 先给缓存同时一定重拉。stale=true 表示返回旧数据、后台在刷新。
 */
async function listTools({ force = false, revalidate = false } = {}) {
  if (!force) {
    const mem = _cache || readDisk();
    if (mem) {
      const age = Date.now() - mem.at;
      const stale = age >= TTL;
      if (stale || revalidate) refresh().catch(() => {});
      return { ok: true, sections: mem.sections, otherPlatforms: mem.otherPlatforms, cached: true, stale, ageMs: age };
    }
  }
  const r = await refresh();
  if (r.ok) return { ok: true, sections: r.sections, otherPlatforms: r.otherPlatforms, cached: false, stale: false, ageMs: 0 };
  if (_cache) return { ok: true, sections: _cache.sections, otherPlatforms: _cache.otherPlatforms, cached: true, stale: true, warning: r.error };
  return { ok: false, error: r.error || '读取工具列表失败' };
}

/**
 * 开启/关闭一个工具，成功后回读确认。
 * 返回 { ok, name, enabled, error?, sections? }；enabled 是 CLI 的真实终态。
 */
async function setTool(name, enabled) {
  const n = String(name || '');
  if (!NAME_RE.test(n)) return { ok: false, error: '非法工具名' };
  const argv = ['tools', enabled ? 'enable' : 'disable', n];
  const r = await exec(argv);
  if (!r.ok) {
    log.warn('tools', 'toggle failed', { name: n, enabled: !!enabled, error: log.redact(r.error || '') });
    return { ok: false, error: r.error || '操作失败' };
  }
  // 回读必须真跑 CLI：缓存里是开关之前的状态
  const after = await readListRaw();
  if (!after.ok) return { ok: false, error: after.error };
  const c = commit(after.sections, after.otherPlatforms);
  const hit = c.sections.flatMap((s) => s.items).find((i) => i.name === n);
  if (!hit) return { ok: false, error: '工具不存在：' + n, sections: c.sections };
  log.info('tools', 'toggled', { name: n, enabled: hit.enabled });
  // CLI 说成功但状态没变（例如 MCP server 未连接）时如实反馈
  if (hit.enabled !== !!enabled) {
    return { ok: false, error: 'CLI 未改变该工具状态（可能依赖未就绪）', name: n, enabled: hit.enabled, sections: c.sections };
  }
  return { ok: true, name: n, enabled: hit.enabled, sections: c.sections };
}

module.exports = {
  listTools, setTool, parseToolList, NAME_RE, HERMES_BIN,
  invalidate, setEmitter,
};
