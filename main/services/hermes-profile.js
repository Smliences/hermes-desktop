'use strict';
/**
 * hermes-profile.js — 桌面端 profile 的唯一真源（single source of truth）
 *
 * 设计原则（重要）：
 *   1. 桌面端切换 profile **不写 ~/.hermes 下任何文件**，也不改 hermes CLI 安装目录。
 *      当前选择只存在 Electron 自己的 userData/active-profile.json 里。
 *   2. 所有 hermes CLI 子进程都显式带 `-p <name>`（CLI 在 import 前 pre-parse，
 *      优先级高于 ~/.hermes/active_profile 这个 sticky 默认），因此终端里
 *      `hermes profile use xxx` 不会影响桌面端，桌面端切换也不会影响终端。
 *   3. 桌面端自己读 config.yaml / state.db / skills 等一律走 home()/xxxPath()，
 *      禁止再硬编码 ~/.hermes；直接跑 Python 的子进程用 env() 注入 HERMES_HOME。
 *
 * 目录约定（对齐 hermes_cli/profiles.py）：
 *   root                 = ~/.hermes（或启动时 HERMES_HOME 指向的根）
 *   default profile home = root
 *   named profile home   = root/profiles/<name>
 *   sticky（只读，不写）  = root/active_profile
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const listeners = new Set();

let ROOT = '';
let storePath = '';
let currentName = 'default';

/** 从启动环境推导 hermes 根（不是某个 profile 的 home）。 */
function detectRoot() {
  const envHome = (process.env.HERMES_HOME || '').trim();
  if (envHome) {
    const p = path.resolve(envHome);
    return path.basename(path.dirname(p)) === 'profiles' ? path.dirname(path.dirname(p)) : p;
  }
  return path.join(os.homedir(), '.hermes');
}

/** 应用启动时调用一次；userData 是 Electron 自己的目录，与 ~/.hermes 无关。 */
function init(userDataDir) {
  ROOT = detectRoot();
  storePath = path.join(userDataDir, 'active-profile.json');
  try {
    const saved = JSON.parse(fs.readFileSync(storePath, 'utf8')).name;
    if (typeof saved === 'string' && exists(saved)) currentName = saved;
  } catch {}
  if (!exists(currentName)) currentName = 'default';
  return currentName;
}

function root() { return ROOT || (ROOT = detectRoot()); }
/** Electron 自己的 userData（不是 ~/.hermes）；缓存类落地文件都放这里。 */
function dataDir() { return storePath ? path.dirname(storePath) : ''; }
function profilesDir() { return path.join(root(), 'profiles'); }
function validName(name) { return typeof name === 'string' && (name === 'default' || NAME_RE.test(name)); }

/** profile 的 hermes home。不传名字 = 当前桌面端选中的 profile。 */
function home(name) {
  const n = name || currentName;
  if (n === 'default') return root();
  if (!validName(n)) return root();
  return path.join(profilesDir(), n);
}

function exists(name) {
  if (name === 'default') return true;
  if (!validName(name)) return false;
  try { return fs.statSync(path.join(profilesDir(), name)).isDirectory(); }
  catch { return false; }
}

/** 全部可选 profile（default 恒在第一位），只读目录。 */
function names() {
  const out = ['default'];
  try {
    for (const e of fs.readdirSync(profilesDir(), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && validName(e.name) && !out.includes(e.name)) out.push(e.name);
    }
  } catch {}
  return out;
}

function configPath(name) { return process.env.HERMES_CONFIG || path.join(home(name), 'config.yaml'); }
function dbPath(name) { return process.env.HERMES_DB || path.join(home(name), 'state.db'); }
function envFilePath(name) { return path.join(home(name), '.env'); }
function skillsDir(name) { return path.join(home(name), 'skills'); }
function pluginsDir(name) { return path.join(home(name), 'plugins'); }

/** 终端 CLI 的 sticky 默认（只读，仅用于设置页提示差异）。 */
function cliActive() {
  try {
    const n = fs.readFileSync(path.join(root(), 'active_profile'), 'utf8-sig').trim();
    return n || 'default';
  } catch { return 'default'; }
}

/** 子进程环境：带正确的 HERMES_HOME；不修改全局 process.env。 */
function env(extra = {}) {
  return { ...process.env, HERMES_HOME: home(), ...extra };
}

/** 所有 hermes CLI 调用统一加 `-p`，显式压过 sticky active_profile。 */
function cliArgs(args = []) {
  return ['-p', currentName, ...args];
}

/** 单个 profile 的只读摘要（毫秒级，无子进程）。 */
function info(name) {
  const h = home(name);
  const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  let model = '';
  try {
    const yaml = fs.readFileSync(path.join(h, 'config.yaml'), 'utf8');
    const m = yaml.match(/^\s*model:\s*\n(?:\s+.*\n)*?\s+default:\s*['"]?([^\s'"#]+)/m);
    model = m ? m[1] : '';
  } catch {}
  let skills = 0;
  try {
    for (const e of fs.readdirSync(path.join(h, 'skills'), { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) skills++;
    }
  } catch {}
  return {
    name,
    current: name === currentName,
    cliActive: cliActive() === name,
    model: model || '（未设置）',
    skills,
    dbBytes: size(path.join(h, 'state.db')),
    home: h.replace(os.homedir(), '~'),
    exists: exists(name),
  };
}

function snapshot() {
  return {
    current: currentName,
    cliActive: cliActive(),
    root: root().replace(os.homedir(), '~'),
    home: home().replace(os.homedir(), '~'),
    store: storePath,
    writesHermesFiles: false,
    profiles: names().map(info),
  };
}

function current() { return currentName; }
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** 切换当前 profile。只写 Electron userData，不碰 ~/.hermes。 */
function setCurrent(name) {
  if (!validName(name)) return { ok: false, error: 'profile 名称无效' };
  if (!exists(name)) return { ok: false, error: `profile 不存在：${name}` };
  if (name === currentName) return { ok: true, changed: false, snapshot: snapshot() };
  currentName = name;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = storePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ name }, null, 2));
    fs.renameSync(tmp, storePath);
  } catch (err) {
    return { ok: false, error: `保存选择失败：${err.message}` };
  }
  const snap = snapshot();
  for (const fn of listeners) { try { fn(name, snap); } catch {} }
  return { ok: true, changed: true, snapshot: snap };
}

module.exports = {
  init, root, home, names, exists, current, setCurrent, onChange, snapshot, info,
  configPath, dbPath, envFilePath, skillsDir, pluginsDir, dataDir,
  cliActive, env, cliArgs, validName,
};
