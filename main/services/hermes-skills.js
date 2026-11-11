'use strict';
/**
 * hermes-skills.js — 真实 hermes CLI 技能管理通道
 *
 * 列表：官方 `_list_all_skills()` 要起捆绑 Python 并遍历全部技能目录（实测
 *       5.9–7.1s：Python 冷启 ~2.5s + 枚举 3.4s），绝不能挡在用户点开页面的
 *       路径上。与插件页同款策略：内存缓存 → userData 磁盘缓存（上次运行的
 *       结果，毫秒级）→ 后台 stale-while-revalidate，刷完通知渲染层重绘；
 *       只有「从未成功拉取过」才阻塞等 Python。
 * 开关：skills.disabled 是 config.yaml 里的扁平列表，直接做行级编辑即可，
 *       零子进程、毫秒级；失败时回退到官方 Python 写入路径。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yamlCfg = require('./hermes-config-yaml');
const profile = require('./hermes-profile');
const { resolveHermesBin, safeArg } = require('./hermes-bin');

const HERMES_BIN = process.env.HERMES_BIN || resolveHermesBin();
// 与 agent/skill_utils.ESSENTIAL_SKILLS 对齐：核心技能不允许停用
const ESSENTIAL_SKILLS = new Set(['hermes-agent']);
const TTL = 30 * 60 * 1000;
const HARD_TTL = 30 * 24 * 60 * 60 * 1000;
const CACHE_FILE = 'catalog-skills.json';

let _runtime = null;
let _cache = null;      // { skills:[...], disabled:[...], at:number }
let _inflight = null;
let _emitter = null;
let _diskTried = false;
let _diskTimer = null;

/** 主进程注入：刷新完成后通知渲染层。 */
function setEmitter(fn) { _emitter = typeof fn === 'function' ? fn : null; }
function emit() {
  if (!_emitter || !_cache) return;
  try { _emitter({ kind: 'skills', at: _cache.at, count: _cache.skills.length }); } catch {}
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
    if (!Array.isArray(raw.skills) || !raw.skills.length) return null;
    const at = Number(raw.at) || 0;
    if (!at || Date.now() - at > HARD_TTL) return null;
    _cache = { skills: raw.skills, disabled: Array.isArray(raw.disabled) ? raw.disabled : [], at };
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
        skills: _cache.skills, disabled: _cache.disabled,
      }));
      fs.renameSync(tmp, file);
    } catch {}
  }, 1500);
  if (_diskTimer.unref) _diskTimer.unref();
}

/** 解析 hermes 启动器，得到 { python, root }。失败返回 null（调用方走演示数据）。 */
function resolveRuntime() {
  if (_runtime !== null) return _runtime;
  try {
    const shim = HERMES_BIN;
    let text = fs.readFileSync(shim, 'utf8');
    const fwd = text.match(/exec\s+(\S+?\/\.hermes\/bin\/hermes)\b/);
    if (fwd) text = fs.readFileSync(fwd[1], 'utf8');
    const py = text.match(/exec\s+(\S*bin\/python3?)/);
    const ins = text.match(/sys\.path\.insert\(0,\s*([^)]+)\)/);
    const rootPath = ins ? ins[1].replace(/['"]/g, '').trim() : '';
    if (py && rootPath && fs.existsSync(py[1])) _runtime = { python: py[1], root: rootPath };
    else _runtime = undefined;
  } catch { _runtime = undefined; }
  return _runtime;
}

function runPython(script, argv = [], { timeout = 30000 } = {}) {
  const rt = resolveRuntime();
  if (!rt) return Promise.resolve({ code: -1, stdout: '', stderr: 'hermes 运行时未找到' });
  return new Promise((resolve) => {
    try {
      const p = spawn(rt.python, ['-I', '-c', script, ...argv], { cwd: rt.root, timeout, env: profile.env() });
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

const BOOT = `
import sys, json
sys.path.insert(0, '<ROOT>')
import hermes_bootstrap
from hermes_cli.skills_config import _list_all_skills, get_disabled_skills, save_disabled_skills
from hermes_cli.config import load_config
`;

/** 外部改动 config.yaml 时，只同步 disabled 集合（不重新枚举技能目录）。 */
yamlCfg.watch(() => {
  if (!_cache) return;
  try {
    _cache.disabled = yamlCfg.readLists()['skills.disabled'] || [];
    _cache.at = Date.now();
    writeDisk();
  } catch {}
});

/** 作废内存 + 磁盘缓存（切换 profile 后必须走这里，别让旧 profile 的
 *  磁盘列表在下一次读取时被当成缓存再拿出来）。 */
function invalidate() {
  _cache = null;
  _diskTried = false;
  const file = cachePath();
  if (file) { try { fs.unlinkSync(file); } catch {} }
}

/** 真正跑一次枚举（Python）；并发调用共享同一个 in-flight。 */
function refresh() {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const rt = resolveRuntime();
    if (!rt) return { ok: false, error: 'hermes 运行时未找到', skills: [], disabled: [] };
    const script = BOOT.replace('<ROOT>', rt.root) + `
cfg = load_config()
skills = _list_all_skills()
disabled = sorted(get_disabled_skills(cfg))
print(json.dumps({'skills': skills, 'disabled': disabled}, ensure_ascii=False))
`;
    const r = await runPython(script);
    if (r.code !== 0) {
      return { ok: false, error: r.stderr.trim().split('\n').pop() || `exit ${r.code}`, skills: [], disabled: [] };
    }
    try {
      const data = JSON.parse(r.stdout.trim().split('\n').pop());
      _cache = { skills: data.skills || [], disabled: data.disabled || [], at: Date.now() };
      writeDisk();
      emit();
      return { ok: true, skills: _cache.skills, disabled: _cache.disabled };
    } catch (err) {
      return { ok: false, error: `JSON 解析失败：${err.message}`, skills: [], disabled: [] };
    }
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/**
 * 已装技能列表 + 当前禁用集合。缓存命中毫秒返回；force=true 才阻塞等 Python。
 * revalidate=true 表示「先给缓存、同时一定重拉一次」。
 * stale=true 表示返回的是旧数据、后台正在刷新。
 */
async function listSkills({ force = false, revalidate = false } = {}) {
  if (!force) {
    const mem = _cache || readDisk();
    if (mem) {
      const age = Date.now() - mem.at;
      const stale = age >= TTL;
      if (stale || revalidate) refresh().catch(() => {});
      return { ok: true, skills: mem.skills, disabled: mem.disabled, cached: true, stale, ageMs: age };
    }
  }
  const r = await refresh();
  if (r.ok) return { ok: true, skills: r.skills, disabled: r.disabled, cached: false, stale: false, ageMs: 0 };
  if (_cache) return { ok: true, skills: _cache.skills, disabled: _cache.disabled, cached: true, stale: true, warning: r.error };
  return { ok: false, error: r.error, skills: [], disabled: [] };
}

/** 启用/停用技能：直接行级编辑 config.yaml，零子进程。失败回退官方 Python 路径。 */
async function setSkillEnabled(name, enabled) {
  // 同时保护 YAML 行编辑与 Python 回退路径：禁止换行 / 前导 - / 注入字符
  if (!safeArg(name, 200)) return { ok: false, error: '技能名不合法' };
  if (!enabled && ESSENTIAL_SKILLS.has(name)) return { ok: false, error: '核心技能不可停用' };
  const r = await yamlCfg.mutate('skills', 'disabled', enabled ? { remove: [name] } : { add: [name] });
  if (r.ok) {
    const disabled = r.lists['skills.disabled'] || [];
    if (_cache) { _cache.disabled = disabled; _cache.at = Date.now(); writeDisk(); }
    return { ok: true, disabled, instant: true };
  }
  // 回退：官方 Python 写入路径（保留 ESSENTIAL_SKILLS 保护）
  const rt = resolveRuntime();
  if (!rt) return { ok: false, error: r.error || 'hermes 运行时未找到' };
  const script = BOOT.replace('<ROOT>', rt.root) + `
payload = json.loads(sys.argv[1])
cfg = load_config()
dis = get_disabled_skills(cfg)
if payload['enabled']: dis.discard(payload['name'])
else: dis.add(payload['name'])
save_disabled_skills(cfg, dis)
print(json.dumps({'ok': True, 'disabled': sorted(get_disabled_skills(load_config()))}, ensure_ascii=False))
`;
  const p = await runPython(script, [JSON.stringify({ name, enabled: !!enabled })], { timeout: 60000 });
  if (p.code !== 0) return { ok: false, error: p.stderr.trim().split('\n').pop() || `exit ${p.code}` };
  try {
    const data = JSON.parse(p.stdout.trim().split('\n').pop());
    if (_cache) _cache.disabled = data.disabled || [];
    return data;
  } catch (err) { return { ok: false, error: `JSON 解析失败：${err.message}` }; }
}

/** 启动后台预热：把首次枚举提前到应用启动阶段，页面打开零等待。 */
function warm() { return listSkills().catch(() => {}); }

module.exports = { listSkills, setSkillEnabled, resolveRuntime, invalidate, warm, setEmitter };
