'use strict';
/**
 * gateway-client.js — `hermes serve` JSON-RPC/WebSocket 客户端（对齐官方桌面版）
 *
 * 协议（tui_gateway/ws.py）：WS /api/ws?token=... 上 newline-delimited JSON-RPC，
 * accept 后服务端先发 `gateway.ready` 事件通知；事件以 {"method":"event","params":
 * {type,payload,session_id,seq}} 推送；客户端需每 15s 发 gateway.ping 保活（服务端
 * 心跳宽限 45s）。服务端也可能发请求（approval.received 等），需回包。
 */
const WebSocket = require('ws');
const { execFile } = require('child_process');
const profile = require('./hermes-profile');
// CLI 路径统一走 hermes-bin（含 Homebrew/PATH 回退），此处曾硬编码三处候选，
// 导致与非默认安装路径的其它服务行为不一致。
const { resolveHermesBin } = require('./hermes-bin');

/** `hermes serve --status`（设置页显示用） */
function serveStatus() {
  return new Promise((resolve) => {
    execFile(resolveHermesBin(), profile.cliArgs(['serve', '--status']), { timeout: 8000, env: profile.env() }, (err, stdout) => {
      resolve({ ok: !err, output: (stdout || err?.message || '').toString() });
    });
  });
}

const HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_RPC_TIMEOUT_MS = 60000;

class GatewayConnection {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} opts.port
   * @param {string} opts.token
   * @param {(status: {connected:boolean, error?:string}) => void} [opts.onStatus]
   */
  constructor(opts) {
    this.url = `ws://${opts.host || '127.0.0.1'}:${opts.port}/api/ws?token=${encodeURIComponent(opts.token)}`;
    this.onStatus = opts.onStatus || (() => {});
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.eventListeners = new Set(); // fn({type, payload, session_id, seq})
    this.requestHandler = null; // fn({method, params}) => result
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.backoffMs = 1000;
    this.closed = false;
    this.connected = false;
  }

  connect() {
    if (this.closed) return;
    // 重连定时器与手工 connect 可能撞车；已有 socket 正在连接/已连接时不要再造一个
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 10000 });
    } catch (err) {
      this._scheduleReconnect(err.message);
      return;
    }
    this.ws = ws;
    // 旧 socket 的迟到回调（close 后仍可能触发）不能覆盖新 socket 的状态
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.backoffMs = 1000;
      this.onStatus({ connected: true });
      this._startHeartbeat();
    });
    ws.on('message', (data) => { if (this.ws === ws) this._onFrame(String(data)); });
    ws.on('error', () => { /* close 会跟随 */ });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.connected;
      this.connected = false;
      this._stopHeartbeat();
      this._rejectAll(new Error('gateway 连接已断开'));
      if (was) this.onStatus({ connected: false });
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect(reason) {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(15000, this.backoffMs * 2);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.rpc('ping', {}, 10000).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    if (this.heartbeat.unref) this.heartbeat.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
  }

  _onFrame(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // 服务端 → 客户端请求（如 approval.received）
    if (msg.method && msg.id != null) {
      let result = {};
      try {
        result = this.requestHandler
          ? (this.requestHandler({ method: msg.method, params: msg.params || {} }) || {})
          : {};
      } catch { result = {}; }
      this._sendRaw({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    // 事件通知
    if (msg.method === 'event' && msg.params) {
      for (const fn of this.eventListeners) {
        try { fn(msg.params); } catch { /* 单个监听器异常不中断分发 */ }
      }
      return;
    }
    // RPC 响应
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  _sendRaw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj) + '\n');
      return true;
    }
    return false;
  }

  /** JSON-RPC 请求。注意：服务端按行分帧，逐行发送。 */
  rpc(method, params = {}, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('gateway 未连接'));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway rpc 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // socket 在检查与发送之间关闭时，不能把请求挂到超时（prompt.submit 是 10 分钟）
      if (!this._sendRaw({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('gateway 未连接'));
      }
    });
  }

  onEvent(fn) { this.eventListeners.add(fn); return () => this.eventListeners.delete(fn); }
  onRequest(fn) { this.requestHandler = fn; }

  _rejectAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._stopHeartbeat();
    this._rejectAll(new Error('gateway closed'));
    // 先解绑再 close：旧 socket 的 close 回调会检查 this.ws !== ws 而直接返回，
    // 不会在应用退出/切换 profile 后继续排重连定时器。
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) { try { ws.close(); } catch {} }
  }
}

module.exports = { GatewayConnection, serveStatus };
