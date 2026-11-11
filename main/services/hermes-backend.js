'use strict';
/**
 * hermes-backend.js — `hermes serve` 常驻后端托管
 *
 * 对齐官方桌面版（apps/desktop/electron/backend-command.ts / backend-ready.ts）：
 *   - 启动 `hermes serve --isolated --host 127.0.0.1 --port 0 --skip-build`
 *   - env 需带 HERMES_DESKTOP=1 + HERMES_DASHBOARD_SESSION_TOKEN
 *     （loopback 鉴权豁免的硬性条件，见 hermes_cli/web_server.py）
 *   - 从 stdout 解析 `HERMES_BACKEND_READY port=<N>` 哨兵获取端口
 *   - 进程意外退出时自动重启（指数退避，长时间稳定运行后重置计数）
 *
 * 为什么必须带 --isolated（v0.23.0 起）：
 *   CLI 改成「一台机器一个 machine-level gateway」，`hermes -p X serve` 默认会
 *   **附着到已存在的机器级服务并立刻退出**，只打印
 *   `Hermes backend already running on this host: PID …, port 9119`，
 *   既不打 READY 哨兵也不监听我们的端口 → 桌面端会误判启动失败并无限重试。
 *   而且附着时我们注入的 HERMES_DASHBOARD_SESSION_TOKEN 对那个服务无效（token 是
 *   逐进程的），REST/WS 会 401。--isolated 让本 profile 拿到自己的专用服务 +
 *   自己的 token，端口与代次仍归主进程管。
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const profile = require('./hermes-profile');
const { DEFAULT_HERMES, resolveHermesBin } = require('./hermes-bin');
const log = require('./logger');

const READY_RE = /HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/;

class HermesBackend {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.hermesBin]
   * @param {(status: object) => void} [opts.onStatus] 状态回调 {state, port, error}
   */
  constructor(opts = {}) {
    this.hermesBin = opts.hermesBin || '';
    this.onStatus = opts.onStatus || (() => {});
    this.child = null;
    this.port = 0;
    this.token = '';
    this.state = 'idle'; // idle | starting | ready | stopped
    this.buffer = '';      // stdout（READY 哨兵）
    this.errBuffer = '';   // stderr（诊断用，独立缓冲避免互相污染）
    this.restarts = 0;
    this.startedAt = 0;
    this.stopped = false;
    this.generation = 0;   // 每次 _spawn 递增；异步 exit 用它识别「这是不是当前进程」
    this._waiters = [];
    this._restartTimer = null;
    this._killTimer = null;
    this._restartPending = false; // 已排定自动重启：start() 必须等待，不能再 spawn 一个
  }

  _setStatus(state, extra = {}) {
    this.state = state;
    // generation 是「第几代后端」的权威标识，ChatChannel 靠它判断旧连接 / 旧会话是否失效
    this.onStatus({ state, port: this.port, generation: this.generation, ...extra });
  }

  /** 启动（幂等）。返回在 ready 时 resolve 的 promise。 */
  start() {
    if (this.state === 'ready') return Promise.resolve(this.port);
    // 正在启动，或已排定退避重启：都只等待现有进程，绝不叠加第二个 serve
    if (this.state === 'starting' || this._restartPending) return this.whenReady();
    return this._spawn();
  }

  _spawn() {
    this.stopped = false;
    this._restartPending = false;
    this._setStatus('starting');
    this.token = crypto.randomBytes(24).toString('base64url');
    const bin = resolveHermesBin(this.hermesBin);
    const args = profile.cliArgs(['serve', '--isolated', '--host', '127.0.0.1', '--port', '0', '--skip-build']);
    let child;
    try {
      child = spawn(bin, args, {
        env: profile.env({
          HERMES_DESKTOP: '1',
          HERMES_DASHBOARD_SESSION_TOKEN: this.token,
          NO_COLOR: '1',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._setStatus('error', { error: `无法启动 hermes serve: ${err.message}` });
      return Promise.reject(err);
    }
    const gen = ++this.generation;
    this.child = child;
    this.buffer = '';
    this.errBuffer = '';
    this.startedAt = Date.now();

    // 哨兵可能打在 stdout 或 stderr，两条流各自缓冲、都做 READY 解析
    const onChunk = (chunk, isErr) => {
      if (isErr) {
        this.errBuffer += chunk;
        if (this.errBuffer.length > 20000) this.errBuffer = this.errBuffer.slice(-10000);
      } else {
        this.buffer += chunk;
        if (this.buffer.length > 20000) this.buffer = this.buffer.slice(-10000);
      }
      this._checkReady(gen);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => onChunk(c, false));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => onChunk(c, true));

    child.on('error', (err) => {
      if (gen !== this.generation) return;
      log.error('backend', `spawn error: ${err.message}`);
      // ENOENT 之类的启动失败只发 error + close，不一定发 exit；
      // 不补一次排程就会永远停在 error 状态，直到用户再发一条消息才重试。
      if (this.state !== 'ready') this._scheduleRestart(gen, `进程错误(${err.message})`, err.message);
    });

    child.on('exit', (code, signal) => {
      // 关键：切换 profile 时 stop() 会先发 SIGTERM 再立刻 _spawn 新进程；
      // 旧进程的 exit 是异步到达的，若不加身份校验会把新 child 句柄清空、
      // 误判为「意外退出」并触发退避重启，最终拉起多个 serve。
      if (gen !== this.generation) return;
      if (this.child === child) this.child = null;
      if (this.stopped) { this._setStatus('idle'); return; }
      const tail = (this.errBuffer || this.buffer).split('\n').filter(Boolean).slice(-3).join(' ');
      this._scheduleRestart(gen, `退出(${signal || code})`, tail);
    });

    return this.whenReady();
  }

  /** 异常退出 / 启动失败后排定唯一一次退避重启。
   *  error 与 exit 可能同时到达，_restartPending 去重保证同一代只拉起一个 serve。 */
  _scheduleRestart(gen, how, tail) {
    if (this.stopped || this._restartPending || gen !== this.generation) return;
    // 先置位：_setStatus 会通知 ChatChannel 清理回合，清理过程中若有人重新 submit，
    // start() 必须等待这次排程，不能绕过退避直接 spawn 出第二个 serve。
    this._restartPending = true;
    // 运行 >60s 后重置重启计数，否则指数退避（上限 15s）
    if (Date.now() - this.startedAt > 60000) this.restarts = 0;
    const delay = Math.min(15000, 1000 * 2 ** this.restarts);
    this.restarts += 1;
    const safeTail = log.redact(String(tail || '')).slice(0, 300);
    log.warn('backend', `serve ${how}, restart in ${delay / 1000}s`, { tail: safeTail });
    this._setStatus('error', { error: `hermes serve ${how}，${delay / 1000}s 后重启 ${safeTail}` });
    this._rejectWaiters(new Error(`hermes serve ${how}`));
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      this._restartPending = false;
      if (!this.stopped && gen === this.generation) this._spawn();
    }, delay);
  }

  _rejectWaiters(err) {
    for (const w of this._waiters.splice(0)) w.reject(err);
  }

  _checkReady(gen) {
    if (gen !== this.generation || this.state === 'ready') return;
    const m = (this.buffer + '\n' + this.errBuffer).match(READY_RE);
    if (!m) return;
    this.port = parseInt(m[1], 10);
    this.restarts = 0;
    this._setStatus('ready');
    log.info('backend', `ready on port ${this.port}`);
    for (const w of this._waiters.splice(0)) w.resolve(this.port);
  }

  whenReady(timeoutMs = 120000) {
    if (this.state === 'ready') return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) this._waiters.splice(i, 1);
        reject(new Error('hermes serve 启动超时'));
      }, timeoutMs);
      const w = {
        resolve: (port) => { clearTimeout(timer); resolve(port); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      this._waiters.push(w);
    });
  }

  stop() {
    this.stopped = true;
    // 让旧进程的所有异步回调（exit/error/close）失效：切 profile 时新进程
    // 会立刻 _spawn，旧 exit 晚到也不能改动新 child 的状态。
    this.generation += 1;
    this._restartPending = false;
    clearTimeout(this._restartTimer);
    clearTimeout(this._killTimer);
    this._restartTimer = null;
    this._rejectWaiters(new Error('backend stopped'));
    if (this.child) {
      // 必须捕获旧进程：3s 后的 SIGKILL 只能打在它身上，不能误杀新后端。
      const old = this.child;
      try { old.kill('SIGTERM'); } catch {}
      this._killTimer = setTimeout(() => {
        // killed 只表示「发过信号」，不能判断进程是否真的退出；用 exitCode 判定
        try { if (old.exitCode === null && old.signalCode === null) old.kill('SIGKILL'); } catch {}
      }, 3000);
    }
    this.child = null;
    this.port = 0;
    this._setStatus('idle');
  }
}

module.exports = { HermesBackend, resolveHermesBin, DEFAULT_HERMES, READY_RE };
