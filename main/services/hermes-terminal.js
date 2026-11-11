'use strict';
/**
 * hermes-terminal.js — 终端 rail
 *
 * node-pty 为 optionalDependency：编译失败时优雅降级为普通 shell 管道
 * （交互式 TUI 不可用，但命令执行仍可）。也可直接在终端面板里跑
 * `hermes chat`（交互 TUI）——这是官方推荐的交互体验。
 */
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const os = require('os'); // 修复：此前引用 os.homedir() 却从未 require，终端一创建即 ReferenceError
const log = require('./logger');

let pty = null;
try { pty = require('node-pty'); } catch { /* 降级 */ }

/** 跨平台默认 shell：macOS 的 zsh 不是 Linux 上的必需品。 */
function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  if (process.env.SHELL && require('fs').existsSync(process.env.SHELL)) return process.env.SHELL;
  return '/bin/sh';
}

class TerminalSession {
  constructor(id, { cwd, shell, cols = 100, rows = 30, ondata, onexit }) {
    this.id = id;
    this.ptyMode = !!pty;
    const workDir = cwd || os.homedir();
    const bin = shell || defaultShell();
    const onData = typeof ondata === 'function' ? ondata : () => {};
    const onExit = typeof onexit === 'function' ? onexit : () => {};
    // 一个汉字可能跨越两次 data 事件；逐片 toString() 会得到 U+FFFD。
    // StringDecoder 会把不完整的尾字节留到下一片；node-pty 已经解码过的
    // 字符串也走同一条路（Buffer 往返无损），两种模式行为一致。
    const decoder = new StringDecoder('utf8');
    const emit = (d) => onData(decoder.write(Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8')));
    try {
      if (pty) {
        this.proc = pty.spawn(bin, [], {
          name: 'xterm-256color', cols, rows, cwd: workDir, env: process.env,
        });
        this.proc.onData(emit);
        this.proc.onExit(({ exitCode }) => onExit(exitCode));
      } else {
        // 降级：无 PTY 的管道 shell（一次一行）
        this.proc = spawn(bin, ['-i'], { cwd: workDir, env: process.env });
        this.proc.stdout.on('data', emit); this.proc.stderr.on('data', emit);
        this.proc.on('error', (e) => onData(`\r\n[终端启动失败] ${e.message}\r\n`));
        this.proc.on('close', (code) => onExit(code));
      }
    } catch (err) {
      log.error('terminal', `spawn failed: ${err.message}`);
      this.proc = { kill() {}, write() {}, resize() {} };
      onData(`\r\n[终端启动失败] ${err.message}\r\n`);
      onExit(1);
    }
  }
  write(data) {
    if (this.ptyMode) this.proc.write(data);
    else this.proc.stdin.write(data.endsWith('\n') ? data : data + '\n');
  }
  resize(cols, rows) { if (this.ptyMode) { try { this.proc.resize(cols, rows); } catch {} } }
  kill() { try { this.proc.kill(); } catch {} }
}

module.exports = { TerminalSession, ptyAvailable: () => !!pty };
