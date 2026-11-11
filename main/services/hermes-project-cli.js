'use strict';
/**
 * hermes-project-cli.js — 项目（命名工作空间）的 CLI 写通道
 *
 * 看板插件 REST 对项目只有读（GET /projects）和看板绑定（PATCH /boards/{slug}），
 * 建/改项目没有任何 HTTP 端点——唯一官方入口是 `hermes project` 子命令。这里照
 * hermes-config.setKanbanSwitch 的模式用 execFile 代跑：参数全部走 argv 不走 shell，
 * CLI 冷启动 5–7 秒、40 秒超时。这是**写 CLI 数据**（projects.db）：只能由用户
 * 点击触发，渲染层不得自动调用。
 */
const { execFile } = require('child_process');
const profile = require('./hermes-profile');
const { resolveHermesBin } = require('./hermes-bin');

/** 项目 slug 与看板 slug 同一字符集（CLI 侧生成时也是这个约定）。 */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_FOLDERS = 8;

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
    if (d.length > 512) return { error: '文件夹路径过长（≤512 字符）' };
    if (!/^[~\/]/.test(d)) return { error: `文件夹路径需为绝对路径（以 / 开头）：${d}` };
  }
  argv.push(...dirs);
  const slug = String(o.slug || '').trim();
  if (slug) {
    if (!SLUG_RE.test(slug)) return { error: 'slug 需为小写字母/数字开头，可含 - _（≤64 字符）' };
    argv.push('--slug', slug);
  }
  const desc = String(o.description || '').trim();
  if (desc) argv.push('--description', desc.slice(0, 400));
  return { argv };
}

/** 代跑 `hermes project create …`。成功与否都以 CLI 的 stdout/stderr 为准。 */
function createProject(input) {
  const o = input || {};
  const built = createProjectArgv(o.name, o.folders, o);
  if (built.error) return Promise.resolve({ ok: false, error: built.error });
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(killer); resolve(v); } };
    const killer = setTimeout(() => {
      if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, error: '创建超时（hermes project create 未在 40s 内返回）' });
    }, 40000);
    try {
      child = execFile(resolveHermesBin(), built.argv, {
        timeout: 40000, maxBuffer: 1024 * 1024, env: profile.env({ NO_COLOR: '1' }),
      }, (err, stdout, stderr) => {
        const text = String(stdout || '').trim().slice(0, 2000);
        if (err) {
          const msg = String((stderr || '').trim() || (err && err.message) || err).split('\n')[0];
          return finish({ ok: false, error: msg || '创建失败', text });
        }
        finish({ ok: true, text });
      });
      child.on('error', (e) => finish({ ok: false, error: String(e) }));
    } catch (e) { finish({ ok: false, error: String(e) }); }
  });
}

module.exports = { createProject, createProjectArgv, SLUG_RE, MAX_FOLDERS };
