'use strict';
/**
 * hermes-mcp.js — MCP 服务器管理（CLI 是唯一真源）
 *
 * 设计边界（生产级）：
 *   - 全部经 `hermes -p <profile> mcp …` 子进程，白名单子命令，execFile 无 shell，
 *     串行队列 + 超时 SIGKILL；渲染层拿不到任意 argv。
 *   - `mcp add` 是 CLI 的 discovery-first 交互流程：非 TTY 下 `input()` 读到 EOF
 *     会走「Cancelled」不保存。这里显式喂一个换行，等同用户在终端按回车接受
 *     「Enable all tools」默认值；连接失败时 CLI 的「Save config anyway?」默认否，
 *     因此不会把连不上的服务器写进配置。
 *   - 只支持 --url 添加：--args 是 argparse 的 REMAINDER 且必须是最后一个选项，
 *     stdio 命令的 `-y` 之类参数会被当成新选项，桌面端无法可靠表达，故留给终端。
 *   - URL 只允许 https 或本机 http（127.0.0.1 / localhost / [::1]），拒绝其它 scheme
 *     与任意内网地址，避免渲染层借桌面端发起越界连接。
 *   - 写操作后回读列表确认；回读失败不谎称写失败，返回 warning 让 UI 提示刷新。
 *
 * 缓存策略：`hermes mcp list` 实测约 2.5s（要起 Python 读配置），因此列表走
 * 「userData 磁盘缓存 + stale-while-revalidate」，与插件 / 技能 / 工具集一致；
 * 但 **添加 / 移除后的回读永不读缓存**，`test` 每次都真连。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const profile = require('./hermes-profile');
const { resolveHermesBin } = require('./hermes-bin');
const yamlCfg = require('./hermes-config-yaml');
const log = require('./logger');

const HERMES_BIN = process.env.HERMES_BIN || resolveHermesBin();
const TIMEOUT_MS = 25000;
const SLOW_TIMEOUT_MS = 60000;   // test / add 会真实连接远端
const MAX_OUTPUT = 64000;
const TTL = 30 * 60 * 1000;
const HARD_TTL = 30 * 24 * 60 * 60 * 1000;
const CACHE_FILE = 'catalog-mcp.json';

/** 服务器名是 config.yaml 的 key，也是 argv 的一部分。 */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const HTTPS_RE = /^https:\/\/[^\s\x00-\x1f]{1,300}$/i;
const LOCAL_HTTP_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/[^\s\x00-\x1f]*)?$/i;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

let queue = Promise.resolve();
let _cache = null;      // { servers, raw, at }
let _inflight = null;
let _emitter = null;
let _diskTried = false;
let _diskTimer = null;

function setEmitter(fn) { _emitter = typeof fn === 'function' ? fn : null; }
function emit() {
  if (!_emitter || !_cache) return;
  try { _emitter({ kind: 'mcp', at: _cache.at, count: _cache.servers.length }); } catch {}
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
    if (!Array.isArray(raw.servers)) return null;   // 空配置是合法状态，允许缓存空数组
    const at = Number(raw.at) || 0;
    if (!at || Date.now() - at > HARD_TTL) return null;
    _cache = { servers: raw.servers, raw: String(raw.raw || ''), at };
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
        servers: _cache.servers, raw: _cache.raw,
      }));
      fs.renameSync(tmp, file);
    } catch {}
  }, 1500);
  if (_diskTimer.unref) _diskTimer.unref();
}
/** 作废内存 + 磁盘缓存（切换 profile 后必须走这里）。 */
function invalidate() {
  _cache = null;
  _diskTried = false;
  const file = cachePath();
  if (file) { try { fs.unlinkSync(file); } catch {} }
}
function commit(servers, raw) {
  _cache = { servers, raw: String(raw || ''), at: Date.now() };
  writeDisk();
  emit();
  return _cache;
}
// 外部改 config.yaml 的 mcp_servers（终端 hermes mcp add/remove、手改文件）后把
// 缓存标记为过期：下次读取先给旧值，同时后台重拉，不会长时间显示过期列表。
yamlCfg.watch(() => { if (_cache) _cache.at = Math.min(_cache.at, Date.now() - TTL - 1); });
function enqueue(job) {
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}
function strip(s) { return String(s || '').replace(ANSI_RE, ''); }

/** 所有 CLI 调用统一 execFile + 串行队列；input 用于喂交互式默认值。 */
function exec(argv, { timeout = TIMEOUT_MS, input = '' } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(killer); resolve(v); } };
    const killer = setTimeout(() => {
      if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, error: '命令超时', text: '' });
    }, timeout + 3000);
    try {
      child = execFile(HERMES_BIN, profile.cliArgs(argv), {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: profile.env({ NO_COLOR: '1' }),
      }, (err, stdout, stderr) => {
        const text = strip(stdout).slice(0, MAX_OUTPUT);
        if (err) {
          const lines = strip(stderr).split('\n').map((x) => x.trim()).filter(Boolean);
          return finish({ ok: false, text, error: lines.length ? lines[lines.length - 1] : String(err.message).split('\n')[0] });
        }
        finish({ ok: true, text });
      });
      child.on('error', (e) => finish({ ok: false, text: '', error: String(e) }));
      // 显式关闭 stdin：非 TTY 下让 input() 立即读到 EOF，不依赖默认管道行为
      if (child.stdin) {
        if (input) child.stdin.write(input);
        child.stdin.end();
      }
    } catch (e) {
      finish({ ok: false, text: '', error: String(e) });
    }
  });
}

/** `  intellij-idea    http://127.0.0.1:64342/sse     all    ✓ enabled` */
function parseMcpList(text) {
  const servers = [];
  const rowRe = /^\s{2}(\S+)\s{2,}(\S.*?)\s{2,}(\S.*?)\s{2,}([✓✗])\s+(enabled|disabled)\s*$/;
  for (const raw of strip(text).split('\n')) {
    const line = raw.replace(/\r/g, '');
    if (/^\s*Name\s+Transport/.test(line) || line.includes('───') || /MCP Servers:/.test(line)) continue;
    const m = line.match(rowRe);
    if (!m) continue;
    servers.push({
      name: m[1],
      transport: m[2].trim(),
      tools: m[3].trim(),
      enabled: m[5] === 'enabled',
    });
  }
  return servers;
}

/** `✓ Connected (5970ms)` / `✓ Tools discovered: 56` + 缩进工具名列表 */
function parseMcpTest(text) {
  const t = strip(text);
  const connected = /✓\s*Connected/i.test(t);
  const count = t.match(/Tools discovered:\s*(\d+)/i);
  const latency = t.match(/Connected\s*\((\d+)\s*ms\)/i);
  const transport = t.match(/^\s*Transport:\s*(.+)$/m);
  const tools = [];
  for (const line of t.split('\n')) {
    const m = line.match(/^\s{4}([A-Za-z0-9_][\w.:-]*)\s{2,}\S/);
    if (m && !tools.includes(m[1])) tools.push(m[1]);
  }
  return {
    ok: connected,
    connected,
    latencyMs: latency ? Number(latency[1]) : null,
    toolCount: count ? Number(count[1]) : tools.length,
    tools,
    transport: transport ? transport[1].trim() : '',
    raw: t.slice(0, MAX_OUTPUT),
  };
}

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}
function validUrl(url) {
  return typeof url === 'string' && (HTTPS_RE.test(url) || LOCAL_HTTP_RE.test(url));
}

/** 真跑一次 CLI（不走缓存）；写操作后的回读用它。 */
function readServersRaw() {
  return enqueue(async () => {
    const r = await exec(['mcp', 'list']);
    if (!r.ok) return { ok: false, error: r.error || '读取 MCP 列表失败' };
    return { ok: true, servers: parseMcpList(r.text), raw: r.text.slice(0, 4000) };
  });
}

/** 后台/阻塞刷新（单飞，避免叠起多个 CLI）。 */
function refresh() {
  if (_inflight) return _inflight;
  _inflight = readServersRaw()
    .then((r) => {
      if (!r.ok) return r;
      const c = commit(r.servers, r.raw);
      return { ok: true, servers: c.servers, raw: c.raw };
    })
    .finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * 只读列表。空配置是合法状态（servers: []），不报错。
 * 缓存命中毫秒返回；force=true 才阻塞等 CLI；revalidate 先给缓存同时重拉。
 */
async function listServers({ force = false, revalidate = false } = {}) {
  if (!force) {
    const mem = _cache || readDisk();
    if (mem) {
      const age = Date.now() - mem.at;
      const stale = age >= TTL;
      if (stale || revalidate) refresh().catch(() => {});
      return { ok: true, servers: mem.servers, raw: mem.raw, cached: true, stale, ageMs: age };
    }
  }
  const r = await refresh();
  if (r.ok) return { ok: true, servers: r.servers, raw: r.raw, cached: false, stale: false, ageMs: 0 };
  if (_cache) return { ok: true, servers: _cache.servers, raw: _cache.raw, cached: true, stale: true, warning: r.error };
  return { ok: false, error: r.error || '读取 MCP 列表失败' };
}

/** 连接测试：慢、可能失败，但失败不是异常，返回结构化结果供 UI 展示。 */
function testServer(name) {
  if (!validName(name)) return Promise.resolve({ ok: false, error: '非法服务器名' });
  return enqueue(async () => {
    const r = await exec(['mcp', 'test', name], { timeout: SLOW_TIMEOUT_MS });
    const parsed = parseMcpTest(r.text);
    return {
      ok: true,
      name,
      ...parsed,
      exitFailed: !r.ok,
      error: r.ok ? '' : (r.error || ''),
    };
  });
}

/**
 * 添加一个 URL 型 MCP 服务器。
 * 返回 { ok, servers, warning?, error? }；servers 是回读后的真实列表。
 */
function addServer({ name, url, connectTimeout = 10 } = {}) {
  if (!validName(name)) return Promise.resolve({ ok: false, error: '服务器名只允许字母、数字、_ . -' });
  if (!validUrl(url)) return Promise.resolve({ ok: false, error: '仅支持 https 或本机 http 地址' });
  const ct = Number(connectTimeout);
  const safeCt = Number.isFinite(ct) ? Math.min(60, Math.max(1, Math.floor(ct))) : 10;
  return enqueue(async () => {
    const r = await exec(
      ['mcp', 'add', name, '--url', url, '--connect-timeout', String(safeCt)],
      { timeout: SLOW_TIMEOUT_MS, input: '\n' },
    );
    // CLI 连接失败时以「Failed to connect」提示、默认不保存，但退出码可能为 0
    if (/Failed to connect|Save config anyway/i.test(r.text)) {
      return { ok: false, error: '连接失败，配置未保存', raw: r.text.slice(0, 4000) };
    }
    if (!r.ok) return { ok: false, error: r.error || '添加失败', raw: r.text.slice(0, 4000) };
    return await readBack('添加');
  });
}

/** 移除服务器。CLI 的 _confirm 在非 TTY 下 EOF 取默认 yes，stdin 显式关闭保证确定性。 */
function removeServer(name) {
  if (!validName(name)) return Promise.resolve({ ok: false, error: '非法服务器名' });
  return enqueue(async () => {
    const r = await exec(['mcp', 'remove', name]);
    if (!r.ok) return { ok: false, error: r.error || '移除失败' };
    return await readBack('移除');
  });
}

async function readBack(verb) {
  const after = await exec(['mcp', 'list']);
  if (!after.ok) {
    log.warn('mcp', 'readback failed', { verb, error: log.redact(after.error || '') });
    return { ok: true, warning: `${verb}已执行，但回读列表失败，请点刷新`, servers: null };
  }
  const servers = parseMcpList(after.text);
  commit(servers, after.text.slice(0, 4000));
  return { ok: true, servers, raw: after.text.slice(0, 4000) };
}

module.exports = {
  listServers, testServer, addServer, removeServer,
  parseMcpList, parseMcpTest, validName, validUrl,
  invalidate, setEmitter,
};
