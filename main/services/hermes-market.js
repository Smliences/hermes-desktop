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

let _queue = Promise.resolve();
let _emit = null;
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
function enqueue(label, job) {
  const runJob = _queue.then(async () => {
    progress('start', label);
    try { return await job(); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    finally { progress('done', label); }
  });
  _queue = runJob.then(() => {}, () => {});
  return runJob;
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

/** 搜索 / 浏览市场；query 为空时插件返回完整目录、技能返回官方精选。 */
async function search(kind, query, opts = {}) {
  if (kind !== 'plugins' && kind !== 'skills') return { ok: false, error: '未知市场类型' };
  const q = String(query == null ? '' : query).trim().slice(0, 120);
  // query 原样作为 CLI 位置参数；防止以 '-' 开头被解析成额外选项
  if (q && (q.startsWith('-') || /[\x00-\x1f;`|&$<>]/.test(q))) {
    return { ok: false, error: '搜索词包含非法字符' };
  }
  const t0 = Date.now();
  const args = kind === 'plugins'
    ? ['plugins', 'search', ...(q ? [q] : []), '--json']
    : ['skills', 'search', q, '--json', '--limit', String(Math.min(Math.max(+opts.limit || 30, 1), 100)),
       ...(SOURCES.has(opts.source) && opts.source !== 'all' ? ['--source', opts.source] : [])];
  return enqueue(kind === 'plugins' ? '正在读取插件目录…' : `正在搜索「${q || '全部技能'}」…`, async () => {
    const [r, installed] = await Promise.all([run(args, kind === 'plugins' ? 60000 : 90000), installedNames(kind)]);
    if (r.timedOut) return { ok: false, error: '命令超时，网络可能不可达；可复制命令到终端重试', args };
    if (r.code !== 0) return { ok: false, error: digest(r, 400) || `hermes 退出码 ${r.code}`, args };
    let items;
    try {
      const j = JSON.parse(r.stdout);
      items = kind === 'plugins' ? normalizePlugins(j) : normalizeSkills(j);
    } catch (e) {
      return { ok: false, error: 'CLI 输出不是合法 JSON：' + digest(r, 240), args };
    }
    items.forEach((it) => {
      const short = it.id.split('/').pop();
      it.installed = installed.has(it.id) || installed.has(it.name) || installed.has(short);
    });
    return { ok: true, kind, query: q, items, ms: Date.now() - t0, args };
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
