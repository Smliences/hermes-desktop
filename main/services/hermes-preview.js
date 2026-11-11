'use strict';
/**
 * hermes-preview.js — 右侧栏 HTML 预览的本地文件通道
 *
 * 设计边界（用户已确认「放宽」）：
 *   - 允许打开本机任意目录下的 .html/.htm/.xhtml/.svg，不限工作区
 *   - 也允许手工输入 http(s) URL（含 localhost 开发服务器）
 *   - 主进程只做路径解析与存在性校验，不回写、不执行任何文件
 *   - 渲染层用 sandbox iframe 加载，脚本可运行但没有同源 / Node / 父窗口权限
 *   - fs.watch 监听目标文件所在目录，写入保存后自动通知渲染层刷新
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');

const EXTS = new Set(['.html', '.htm', '.xhtml', '.svg']);
let watcher = null;
let watchedFile = '';
let watchedDir = '';
let notify = null;
let debounce = null;

/** 把用户输入（绝对路径 / ~/ 相对 / file:// / 引号包裹）解析成本机绝对路径 */
function resolveLocal(input, baseDir) {
  let raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: '路径为空' };
  // 先剥尾部标点，再剥引号，再剥一次：tool 输出常见 `"/path/a.html",`
  // 这类「引号外还有逗号」的包裹，只做一遍会留下引号导致 statSync 失败。
  raw = raw.replace(/[),;]+$/, '').trim();
  raw = raw.replace(/^["'`]+|["'`]+$/g, '').trim();
  raw = raw.replace(/[),;]+$/, '').trim();
  if (/^https?:\/\//i.test(raw)) return { ok: true, url: raw, kind: 'url', label: raw };
  if (raw.startsWith('file://')) {
    try { raw = fileURLToPath(raw.split('#')[0]); }
    catch { return { ok: false, error: 'file:// 地址无法解析' }; }
  }
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(1).replace(/^[/\\]/, ''));
  }
  const abs = path.resolve(baseDir || os.homedir(), raw);
  let st;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, error: '文件不存在：' + abs }; }
  if (!st.isFile()) return { ok: false, error: '不是文件：' + abs };
  if (!EXTS.has(path.extname(abs).toLowerCase())) {
    return { ok: false, error: '仅支持 .html / .htm / .xhtml / .svg：' + path.basename(abs) };
  }
  return {
    ok: true, kind: 'file', filePath: abs, baseDir: path.dirname(abs),
    url: pathToFileURL(abs).href, label: path.basename(abs), size: st.size,
  };
}

/** 监听文件所在目录；写入保存（含编辑器原子替换）后去抖通知渲染层 */
function watch(filePath, cb) {
  unwatch();
  if (!filePath || typeof cb !== 'function') return { ok: false, error: '参数无效' };
  let st;
  try { st = fs.statSync(filePath); } catch { return { ok: false, error: '文件不存在' }; }
  if (!st.isFile()) return { ok: false, error: '不是文件' };
  watchedFile = filePath;
  watchedDir = path.dirname(filePath);
  notify = cb;
  try {
    watcher = fs.watch(watchedDir, { persistent: false }, (_event, filename) => {
      const name = filename ? String(filename) : path.basename(watchedFile);
      if (path.join(watchedDir, name) !== watchedFile) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        // 原子写（tmp + rename）后目标文件可能短暂消失，存在才通知
        if (fs.existsSync(watchedFile) && notify) notify(watchedFile);
      }, 180);
    });
    watcher.on('error', () => {});
    return { ok: true, watching: true, dir: watchedDir };
  } catch (err) {
    watcher = null;
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function unwatch() {
  clearTimeout(debounce);
  debounce = null;
  if (watcher) { try { watcher.close(); } catch {} }
  watcher = null; watchedFile = ''; watchedDir = ''; notify = null;
  return { ok: true };
}

module.exports = { resolveLocal, watch, unwatch, EXTS };
