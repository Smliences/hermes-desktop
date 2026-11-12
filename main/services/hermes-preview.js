'use strict';
/**
 * hermes-preview.js — 右侧栏多类型预览的本地文件通道
 *
 * 设计边界：
 *   - 允许打开本机任意目录下白名单扩展名的文件，不限工作区；也允许 http(s) URL
 *   - 按扩展名分流到 web / pdf / image / doc / table 五种渲染器（渲染层负责）
 *   - 主进程只做路径解析与存在性校验，不回写、不执行任何文件
 *   - iframe 用 sandbox 加载，脚本可运行但没有同源 / Node / 父窗口权限；
 *     远程页面进一步收紧到 allow-scripts
 *   - readText 只对文本类（web/doc/table）开放且有 512KB 上限，
 *     二进制 / PDF / 图片 / 可执行文件一律读不到内容
 *   - fs.watch 监听目标文件所在目录，写入保存后自动通知渲染层刷新
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');

/** 扩展名 → 渲染器类型。刻意不含 .env/.ini/.conf 等可能含凭据的文件。 */
const TYPE_BY_EXT = Object.freeze({
  '.html': 'web', '.htm': 'web', '.xhtml': 'web', '.svg': 'web',
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
  '.webp': 'image', '.bmp': 'image', '.avif': 'image', '.ico': 'image',
  '.md': 'doc', '.markdown': 'doc', '.txt': 'doc', '.log': 'doc',
  '.json': 'doc', '.jsonl': 'doc', '.yaml': 'doc', '.yml': 'doc', '.xml': 'doc',
  '.js': 'doc', '.mjs': 'doc', '.cjs': 'doc', '.ts': 'doc', '.tsx': 'doc', '.jsx': 'doc',
  '.py': 'doc', '.css': 'doc', '.scss': 'doc', '.sh': 'doc', '.rb': 'doc',
  '.go': 'doc', '.rs': 'doc', '.java': 'doc', '.c': 'doc', '.h': 'doc', '.cpp': 'doc',
  '.sql': 'doc', '.toml': 'doc',
  '.csv': 'table', '.tsv': 'table',
});
const EXTS = new Set(Object.keys(TYPE_BY_EXT));
/** 只有这三类允许把内容读成文本交给渲染层；pdf / image 走 URL，不读字节。 */
const TEXT_TYPES = new Set(['web', 'doc', 'table']);
const MAX_TEXT_BYTES = 512 * 1024;
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
  if (/^https?:\/\//i.test(raw)) return { ok: true, url: raw, kind: 'url', type: 'url', label: raw };
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
  const ext = path.extname(abs).toLowerCase();
  if (!EXTS.has(ext)) {
    return { ok: false, error: '不支持预览该类型：' + path.basename(abs) };
  }
  return {
    ok: true, kind: 'file', type: TYPE_BY_EXT[ext], ext,
    filePath: abs, baseDir: path.dirname(abs),
    url: pathToFileURL(abs).href, label: path.basename(abs), size: st.size,
  };
}

/** 读文本类文件的原文交给渲染层（Markdown / CSV / 源码视图）。
 *  重新走一遍 resolveLocal 校验白名单，避免 IPC 被拿来读任意本地文件；
 *  二进制、PDF、图片、非白名单扩展名、超大文件一律拒绝。 */
function readText(input, baseDir) {
  const r = resolveLocal(input, baseDir);
  if (!r.ok) return r;
  if (r.kind !== 'file' || !TEXT_TYPES.has(r.type)) {
    return { ok: false, error: '该类型不提供文本视图：' + r.label };
  }
  let st;
  try { st = fs.statSync(r.filePath); }
  catch { return { ok: false, error: '文件不存在：' + r.filePath }; }
  if (st.size > MAX_TEXT_BYTES) {
    return { ok: false, error: '文件超过 512 KB，请用外部程序打开：' + r.label, size: st.size };
  }
  let text;
  try { text = fs.readFileSync(r.filePath, 'utf8'); }
  catch (err) { return { ok: false, error: '读取失败：' + String((err && err.message) || err) }; }
  return { ok: true, text, size: st.size, type: r.type, filePath: r.filePath, label: r.label };
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

module.exports = {
  resolveLocal, readText, watch, unwatch,
  EXTS, TYPE_BY_EXT, TEXT_TYPES, MAX_TEXT_BYTES,
};
