'use strict';
/**
 * hermes-project-cli.js — 项目（命名工作空间）的 CLI 写通道
 *
 * 看板插件 REST 对项目只有读（GET /projects）和看板绑定（PATCH /boards/{slug}），
 * 建/改项目没有任何 HTTP 端点——唯一官方入口是 `hermes project` 子命令。这里照
 * hermes-config.setKanbanSwitch 的模式用 execFile 代跑：参数全部走 argv 不走 shell，
 * CLI 冷启动 5–7 秒、40 秒超时。这是**写 CLI 数据**（projects.db）：只能由用户
 * 点击触发，渲染层不得自动调用。
 *
 * 新建/重命名/加文件夹/设为活动这几种操作对齐官方桌面版 project-dialog.tsx：
 * - 文件夹由主进程原生目录选择器给出（多选、去重、第一个为主），不再是手输路径；
 * - create 带 --use（官方 createProject({ use: true })），建完即成活动项目；
 * - 想法文本按官方 writeProjectIdea 落到主文件夹 IDEA.md（wx 不覆盖既有文件）。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const profile = require('./hermes-profile');
const { resolveHermesBin } = require('./hermes-bin');

/** 项目 slug 与看板 slug 同一字符集（CLI 侧生成时也是这个约定）。 */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_FOLDERS = 8;
const MAX_IDEA = 4000;
/** 树投影里的项目 id（slug / p_xxx / 绝对路径）只允许这些字符，且不许 .. 跳出。 */
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const ACTION_CLI = {
  rename: 'rename',
  addFolder: 'add-folder',
  removeFolder: 'remove-folder',
  use: 'use',
  setPrimary: 'set-primary',
};

function validDir(raw) {
  const d = String(raw || '').trim();
  if (!d) return { error: '文件夹路径为空' };
  if (d.length > 512) return { error: '文件夹路径过长（≤512 字符）' };
  if (!/^[~\/]/.test(d)) return { error: `文件夹路径需为绝对路径（以 / 开头）：${d}` };
  return { dir: d };
}

/**
 * 纯函数：把「新建项目」入参编成 `hermes project create` 的 argv。
 * 独立导出供单元测试（不真跑 CLI）。
 */
function createProjectArgv(name, folders, opts) {
  const o = opts || {};
  const n = String(name || '').trim();
  if (!n) return { error: '请填写项目名称' };
  if (n.length > 80) return { error: '项目名称过长（≤80 字）' };
  const argv = profile.cliArgs(['project', 'create', n]);
  const dirs = (Array.isArray(folders) ? folders : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (dirs.length > MAX_FOLDERS) return { error: `文件夹最多 ${MAX_FOLDERS} 个` };
  for (const d of dirs) {
    const v = validDir(d);
    if (v.error) return { error: v.error };
  }
  argv.push(...dirs);
  const slug = String(o.slug || '').trim();
  if (slug) {
    if (!SLUG_RE.test(slug)) return { error: 'slug 需为小写字母/数字开头，可含 - _（≤64 字符）' };
    argv.push('--slug', slug);
  }
  const desc = String(o.description || '').trim();
  if (desc) argv.push('--description', desc.slice(0, 400));
  // 官方 createProject 的 use:true：建完即为活动项目（CLI --use）
  if (o.use === true) argv.push('--use');
  return { argv, folders: dirs };
}

/** 纯函数：既有项目的重命名 / 文件夹维护 / 设为活动，argv 全部走白名单。 */
function projectActionArgv(op, args) {
  const a = args || {};
  const ident = String(a.id || '').trim();
  const cli = ACTION_CLI[op];
  if (!cli) return { error: '不支持的项目操作' };
  if (!IDENT_RE.test(ident) || ident.includes('..')) return { error: '项目标识无效' };
  let tail;
  if (op === 'rename') {
    const n = String(a.name || '').trim();
    if (!n) return { error: '请填写项目名称' };
    if (n.length > 80) return { error: '项目名称过长（≤80 字）' };
    tail = [ident, n];
  } else if (op === 'addFolder' || op === 'removeFolder' || op === 'setPrimary') {
    const v = validDir(a.folder);
    if (v.error) return { error: v.error };
    tail = [ident, v.dir];
  } else {
    tail = [ident];
  }
  return { argv: profile.cliArgs(['project', cli, ...tail]) };
}

/** 纯函数：新建项目文件夹的入参校验（不碰磁盘）。
 *  只建一层：父目录必须已存在，名称里不许出现分隔符，避免 '../x' 之类越界。 */
function validateNewFolder(parent, name) {
  const p = String(parent || '').trim();
  const n = String(name || '').trim();
  if (!p) return { error: '请先选择一个文件夹作为父目录' };
  if (!p.startsWith('/') || p.length > 512) return { error: '父目录需为绝对路径' };
  if (!n) return { error: '请填写文件夹名称' };
  if (n === '.' || n === '..' || /[/\\]/.test(n)) return { error: '名称不能包含斜杠，也不能是 . 或 ..' };
  if (n.length > 64) return { error: '名称过长（≤64 字符）' };
  return { parent: p.replace(/\/+$/, ''), name: n };
}

/** 在既有目录下新建一个空文件夹（原生面板之外的补充入口）。
 *  非递归 mkdir：父目录不存在直接报错，不在磁盘上乱造多级路径。 */
function createFolder(input) {
  const o = input || {};
  const v = validateNewFolder(o.parent, o.name);
  if (v.error) return { ok: false, error: v.error };
  const target = path.join(v.parent, v.name);
  try {
    if (!fs.statSync(v.parent).isDirectory()) return { ok: false, error: '父目录不是文件夹' };
  } catch { return { ok: false, error: '父目录不存在或不可读' }; }
  try {
    if (fs.existsSync(target)) return { ok: false, error: '同名文件夹已存在' };
    fs.mkdirSync(target);
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
}

/** 官方 writeProjectIdea：只在文件不存在时写，失败不影响项目本身创建成功。 */
function writeProjectIdea(dir, idea) {
  const text = String(idea || '').trim();
  if (!text) return '';
  const d = String(dir || '').trim();
  if (!d.startsWith('/') || d.length > 512 || !fs.existsSync(d)) return 'IDEA.md 未写入：主文件夹不存在';
  try {
    fs.writeFileSync(path.join(d, 'IDEA.md'), text.slice(0, MAX_IDEA) + '\n', { flag: 'wx' });
    return '';
  } catch (e) {
    if (e && e.code === 'EEXIST') return 'IDEA.md 已存在，未覆盖';
    return 'IDEA.md 写入失败：' + String((e && e.message) || e).slice(0, 120);
  }
}

/** 统一的 execFile 执行器：超时强杀、stdout/stderr 截断、错误收敛成一行。 */
function runArgv(argv, label) {
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(killer); resolve(v); } };
    const killer = setTimeout(() => {
      if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, error: `${label}超时（hermes project 未在 40s 内返回）` });
    }, 40000);
    try {
      child = execFile(resolveHermesBin(), argv, {
        timeout: 40000, maxBuffer: 1024 * 1024, env: profile.env({ NO_COLOR: '1' }),
      }, (err, stdout, stderr) => {
        const text = String(stdout || '').trim().slice(0, 2000);
        if (err) {
          const msg = String((stderr || '').trim() || (err && err.message) || err).split('\n')[0];
          return finish({ ok: false, error: msg || '操作失败', text });
        }
        finish({ ok: true, text });
      });
      child.on('error', (e) => finish({ ok: false, error: String(e) }));
    } catch (e) { finish({ ok: false, error: String(e) }); }
  });
}

/** 代跑 `hermes project create …`。成功与否都以 CLI 的 stdout/stderr 为准。 */
async function createProject(input) {
  const o = input || {};
  const built = createProjectArgv(o.name, o.folders, o);
  if (built.error) return { ok: false, error: built.error };
  const r = await runArgv(built.argv, '创建');
  if (!r.ok) return r;
  return { ok: true, text: r.text, ideaWarning: writeProjectIdea((built.folders || [])[0], o.idea) };
}

/** 既有项目操作：op 白名单外的动作在 argv 阶段就被拒，不会碰 CLI。 */
function projectAction(input) {
  const o = input || {};
  const built = projectActionArgv(o.op, o);
  if (built.error) return Promise.resolve({ ok: false, error: built.error });
  return runArgv(built.argv, '项目操作');
}

module.exports = {
  createProject, createProjectArgv, projectAction, projectActionArgv,
  createFolder, validateNewFolder,
  writeProjectIdea, SLUG_RE, MAX_FOLDERS, MAX_IDEA, IDENT_RE, ACTION_CLI,
};
