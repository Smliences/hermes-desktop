'use strict';
/**
 * hermes-export.js — 会话导出（CLI 子进程，唯一写文件的能力）
 *
 * 设计边界：
 *   - 格式是**白名单**（md / html / jsonl），渲染层只能传键名，不能传任意 argv。
 *   - sessionId 必须过正则白名单：它是拼进 argv 的值，虽走 execFile 无 shell，
 *     仍拒绝空格 / 引号 / 换行，避免 CLI 参数被意外拆分。
 *   - CLI 的 md/qmd 只接受「目录」（每会话一个文件），html/jsonl 接受文件路径。
 *     为了统一成「用户选定的那个文件」，一律先落到临时目录，再拷到目标路径，
 *     这样不会在 ~/.hermes/session-exports 里堆垃圾。
 *   - 不传 --no-redact：默认保留 CLI 的密钥脱敏。
 *   - 单文件上限 32MB；导出超时 60s 后子进程被强杀。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const profile = require('./hermes-profile');
const { resolveHermesBin } = require('./hermes-bin');
const log = require('./logger');

const HERMES_BIN = process.env.HERMES_BIN || resolveHermesBin();

/** 格式 → 扩展名。只有登记在这里的格式可以被导出。 */
const FORMATS = Object.freeze({ md: '.md', html: '.html', jsonl: '.jsonl' });
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 60000;

/** 会话 id 形如 20261007_065911_1e1271；只放行这些字符。 */
function validSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id);
}

function runExport(argv) {
  return new Promise((resolve, reject) => {
    execFile(HERMES_BIN, profile.cliArgs(argv), {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: profile.env({ NO_COLOR: '1' }),
    }, (err, stdout, stderr) => {
      if (err) {
        // CLI 把人类可读原因写在 stderr；取最后一行非空内容作为错误信息
        const lines = String(stderr || '').split('\n').map((x) => x.trim()).filter(Boolean);
        const msg = lines.length ? lines[lines.length - 1] : String(err.message).split('\n')[0];
        return reject(new Error(msg || '导出失败'));
      }
      resolve(String(stdout || ''));
    });
  });
}

function firstWithExt(dir, ext) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const hit = names.find((n) => n.toLowerCase().endsWith(ext));
  return hit ? path.join(dir, hit) : null;
}

/**
 * 导出一个会话到 outPath（绝对路径）。
 * 返回 { ok:true, path, bytes } 或 { ok:false, error }；不抛异常，便于 IPC 直接透传。
 */
async function exportSession({ sessionId, format, outPath }) {
  if (!validSessionId(sessionId)) return { ok: false, error: '非法会话 id' };
  const ext = FORMATS[format];
  if (!ext) return { ok: false, error: '不支持的导出格式' };
  if (typeof outPath !== 'string' || !path.isAbsolute(outPath)) {
    return { ok: false, error: '导出路径必须是绝对路径' };
  }

  let tmp = '';
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-export-'));
    // md 只接受目录；html/jsonl 接受文件路径
    const target = format === 'md' ? tmp : path.join(tmp, 'session' + ext);
    await runExport([
      'sessions', 'export',
      '--format', format,
      '--session-id', sessionId,
      '--yes',
      target,
    ]);
    const produced = format === 'md' ? firstWithExt(tmp, ext) : target;
    if (!produced) return { ok: false, error: '导出未生成文件' };
    const st = fs.statSync(produced);
    if (!st.size) return { ok: false, error: '导出文件为空（会话可能没有消息）' };
    if (st.size > MAX_BYTES) return { ok: false, error: '导出文件超过 32MB' };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(produced, outPath);
    log.info('export', 'session exported', { format, bytes: st.size });
    return { ok: true, path: outPath, bytes: st.size };
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 300);
    log.warn('export', 'session export failed', { format, error: log.redact(msg) });
    return { ok: false, error: msg };
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  }
}

module.exports = { exportSession, FORMATS, validSessionId, HERMES_BIN };
