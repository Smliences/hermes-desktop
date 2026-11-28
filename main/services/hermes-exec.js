'use strict';
/**
 * hermes-exec.js — CLI 子进程统一执行器（execFile / spawn）
 *
 * 解决各服务分散封装的两个长期隐患：
 *   1. `if (child && !child.killed)` 死逻辑：Node 的 execFile / spawn 超时发
 *      SIGTERM 时会把 child.killed 置为 true，导致 SIGKILL 兜底永远不触发；
 *      这里改用 `exitCode === null && signalCode === null` 判断进程是否仍存活。
 *   2. 统一关闭未使用的 stdin（`stdio: ['ignore', 'pipe', 'pipe']`），防止 Python
 *      CLI 在交互确认处无限等待 EOF，并统一在超时后按 SIGTERM → SIGKILL → 硬超时收敛。
 */
const { execFile, spawn } = require('child_process');

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => String(s || '').replace(ANSI_RE, '');

/** 仅当子进程尚未退出且未收到致命信号时发送信号，避免误伤或被 child.killed 误导。 */
function killIfAlive(child, signal = 'SIGKILL') {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
      return true;
    } catch {}
  }
  return false;
}

/**
 * 统一 `execFile` 封装（无 shell）。
 * 到点先由 execFile 发 SIGTERM，宽限 killGraceMs 后仍未退出则补 SIGKILL 并按超时收敛。
 */
function runExecFile(bin, argv, opts = {}) {
  const {
    timeout = 25000,
    killGraceMs = 3000,
    maxBuffer = 8 * 1024 * 1024,
    maxStdout = 64000,
    env,
    cwd,
    input = '',
    stripColor = false,
    timeoutError = '命令超时',
    trimStdout = false,
  } = opts;

  return new Promise((resolve) => {
    let child = null;
    let done = false;
    let killer = null;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve(res);
    };

    if (timeout > 0) {
      killer = setTimeout(() => {
        killIfAlive(child, 'SIGKILL');
        finish({ ok: false, timedOut: true, code: -1, text: '', error: timeoutError });
      }, timeout + killGraceMs);
    }

    try {
      child = execFile(bin, argv, { timeout, maxBuffer, env, cwd }, (err, stdout, stderr) => {
        const rawOut = stripColor ? stripAnsi(stdout) : String(stdout || '');
        const sliced = maxStdout > 0 ? rawOut.slice(0, maxStdout) : rawOut;
        const text = trimStdout ? sliced.trim() : sliced;
        if (err) {
          const cleanErr = stripColor ? stripAnsi(stderr) : String(stderr || '');
          const lines = cleanErr.split('\n').map((x) => x.trim()).filter(Boolean);
          const timedOut = !!(err.killed && err.signal === 'SIGTERM');
          const fallback = String(err.message || err).split('\n')[0];
          const error = timedOut
            ? timeoutError
            : (lines.length ? lines[lines.length - 1] : fallback) || '执行失败';
          return finish({
            ok: false,
            timedOut,
            code: typeof err.code === 'number' ? err.code : -1,
            text,
            error,
          });
        }
        finish({ ok: true, timedOut: false, code: 0, text });
      });
      child.on('error', (err) => finish({ ok: false, timedOut: false, code: -1, text: '', error: String(err) }));
      if (child.stdin) {
        if (input) child.stdin.write(input);
        child.stdin.end();
      }
    } catch (err) {
      finish({ ok: false, timedOut: false, code: -1, text: '', error: String(err) });
    }
  });
}

/**
 * 统一 `spawn` 封装（无 shell，默认忽略 stdin）。
 * 超时阶梯：SIGTERM (timeout) → SIGKILL (+killGraceMs) → 硬超时兜底 (+hardGraceMs)。
 */
function runSpawn(bin, argv, opts = {}) {
  const {
    timeout = 30000,
    killGraceMs = 2000,
    hardGraceMs = 5000,
    maxOutput = 0,
    env,
    cwd,
    stdio = ['ignore', 'pipe', 'pipe'],
    onHeartbeat,
    heartbeatMs = 8000,
  } = opts;

  return new Promise((resolve) => {
    let p = null;
    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;
    let hb = null;
    let termTimer = null;
    let killTimer = null;
    let hardTimer = null;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (hb) clearInterval(hb);
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      resolve(res);
    };

    try {
      p = spawn(bin, argv, { env, cwd, stdio });
    } catch (e) {
      return finish({ code: -1, stdout: '', stderr: String(e), timedOut: false });
    }

    if (timeout > 0) {
      termTimer = setTimeout(() => {
        timedOut = true;
        killIfAlive(p, 'SIGTERM');
      }, timeout);
      killTimer = setTimeout(() => {
        timedOut = true;
        killIfAlive(p, 'SIGKILL');
      }, timeout + killGraceMs);
      hardTimer = setTimeout(() => {
        timedOut = true;
        killIfAlive(p, 'SIGKILL');
        finish({
          code: -1,
          stdout: out,
          stderr: (err ? err + '\n' : '') + '执行超时（已强制结束）',
          timedOut: true,
        });
      }, timeout + hardGraceMs);
    }

    if (typeof onHeartbeat === 'function' && heartbeatMs > 0) {
      let elapsed = 0;
      hb = setInterval(() => {
        elapsed += Math.round(heartbeatMs / 1000);
        try { onHeartbeat(elapsed); } catch {}
      }, heartbeatMs);
    }

    if (p.stdout) {
      p.stdout.on('data', (d) => {
        if (!maxOutput || out.length < maxOutput) out += d;
      });
    }
    if (p.stderr) {
      p.stderr.on('data', (d) => {
        if (!maxOutput || err.length < maxOutput) err += d;
      });
    }

    p.on('close', (code) => {
      finish({ code, stdout: out, stderr: err, timedOut: timedOut || code === null });
    });
    p.on('error', (e) => {
      finish({ code: -1, stdout: out, stderr: (err ? err + '\n' : '') + String(e), timedOut });
    });
  });
}

module.exports = { killIfAlive, runExecFile, runSpawn, stripAnsi, ANSI_RE };
