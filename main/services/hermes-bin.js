'use strict';
/**
 * hermes-bin.js — CLI 可执行文件的唯一解析入口
 *
 * 历史上 5 个服务各自硬编码 ~/.local/bin/hermes，装在 /usr/local/bin 或
 * Homebrew 的设备上会静默 spawn 失败（exit -1）。这里统一探测并按优先级
 * 回退到 PATH，所有子进程一律经此处的绝对路径启动。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_HERMES = path.join(os.homedir(), '.local', 'bin', 'hermes');
const CANDIDATES = [
  DEFAULT_HERMES,
  '/usr/local/bin/hermes',
  '/opt/homebrew/bin/hermes',
  path.join(os.homedir(), 'bin', 'hermes'),
];

/** @returns {string} 绝对路径，或交给 PATH 解析的裸命令名 'hermes' */
function resolveHermesBin(explicit) {
  if (explicit && typeof explicit === 'string' && fs.existsSync(explicit)) return explicit;
  for (const c of CANDIDATES) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  // PATH 上的安装：which 一次即可，避免把裸命令名拿去 readFileSync
  if (process.platform !== 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('/usr/bin/which', ['hermes'], { encoding: 'utf8', timeout: 1500 }).trim();
      if (out) return out;
    } catch {}
  }
  return 'hermes';
}

/** CLI 参数统一走数组，禁止拼接 shell 字符串（防选项注入）。 */
function safeArg(v, max = 400) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > max) return null;
  if (s.startsWith('-') || /[\x00-\x1f;`|&$<>\\\r\n]/.test(s)) return null;
  return s;
}

module.exports = { DEFAULT_HERMES, resolveHermesBin, safeArg };
