'use strict';
/**
 * hermes-chat.js — 与 hermes agent 的核心通信通道
 *
 * 主路径（对齐官方桌面版）：常驻 `hermes serve` 后端 + WebSocket JSON-RPC。
 *   - 应用启动即拉起 backend（main.js 调 chat.startBackend()），对话零冷启动
 *   - 每个页签一个 gateway 会话（session.create / session.resume）
 *   - prompt.submit 提交回合，事件流翻译为原 stream-json 协议类型
 *     （text / tool_use / tool_result / result），渲染层零改动
 *
 * 兼容层（stream-json 事件类型，渲染协议保持不变）：
 *   {"type":"system","subtype":"init","model":...,"session_id":...}
 *   {"type":"text","text":"<delta>"}
 *   {"type":"tool_use","name":...,"tool_call_id":...,"input":{...}}
 *   {"type":"tool_result","name":...,"output":...,"duration_ms":...,"is_error":...}
 *   {"type":"result","session_id":...,"exit_code":...,"text":...}
 */
const os = require('os');
const path = require('path');
const { HermesBackend, resolveHermesBin, DEFAULT_HERMES } = require('./hermes-backend');
const { GatewayConnection } = require('./gateway-client');
const profile = require('./hermes-profile');
const log = require('./logger');

/** 树投影里的项目 id（slug / p_xxx / 绝对路径）只允许这些字符，且不许 .. 跳出。 */
const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

/** 会话 id 与会话库同款白名单（见 hermes-sessions.js 的 delete/rename）。 */
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 项目 RPC 方法名白名单：渲染层的 op/key 只能映射到这几个常量，永远传不进任意方法名。 */
const PROJECT_RPC = Object.freeze({
  get: 'projects.get',
  update: 'projects.update',
  add: 'projects.add_folder',
  remove: 'projects.remove_folder',
  primary: 'projects.set_primary',
});

/** `projects.get/update/add_folder/…` 回传的项目对象 → 渲染层要的窄形状。
 *  只留设置弹窗用得到的字段：名称 / 描述 / 主文件夹 / 全部文件夹，别的也不许透出。 */
function projectInfo(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const folders = (Array.isArray(o.folders) ? o.folders : []).slice(0, 8).map((f) => {
    const x = f && typeof f === 'object' ? f : {};
    return { path: s(x.path, 512), label: s(x.label, 120), isPrimary: x.is_primary === true };
  }).filter((f) => f.path);
  return {
    id: s(o.id, 128), name: s(o.name, 120), description: s(o.description, 400),
    color: s(o.color, 16), primaryPath: s(o.primary_path, 512),
    folders,
  };
}

/** 附件走网关的三种 RPC：图片可多模态、PDF 解析成页、其余按文件引用。 */
const ATTACH_LIMIT = 8;
const RE_IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;
const RE_PDF = /\.pdf$/i;
function attachMethod(p) {
  if (RE_IMAGE.test(p)) return 'image.attach';
  if (RE_PDF.test(p)) return 'pdf.attach';
  return 'file.attach';
}
/** 只接受绝对路径：渲染层不可能拼出相对路径混进 CLI 的工作目录。 */
function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const p = raw.trim();
    if (!p || p.length > 4096 || /[\u0000-\u001f]/.test(p)) continue;
    if (!path.isAbsolute(p)) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= ATTACH_LIMIT) break;
  }
  return out;
}

/** gateway 事件 payload.text 可能是字符串或分段数组 */
function extractText(t) {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

/** 用量字段归一化：兼容后端 session.usage 与 message.complete.usage 两种命名 */
function normalizeUsage(u) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  const out = {
    model: u.model || '',
    input: n(u.input ?? u.input_tokens ?? u.prompt ?? u.prompt_tokens),
    output: n(u.output ?? u.output_tokens ?? u.completion ?? u.completion_tokens),
    reasoning: n(u.reasoning ?? u.reasoning_tokens),
    cacheRead: n(u.cache_read ?? u.cache_read_input_tokens),
    cacheWrite: n(u.cache_write ?? u.cache_write_input_tokens),
    total: n(u.total ?? u.total_tokens),
    calls: n(u.calls ?? u.api_calls),
  };
  if (out.total === 0) out.total = out.input + out.output;
  // 上下文占用：后端给了真实口径就用，否则不下发（渲染层标「估算」）
  if (n(u.context_max) > 0) {
    out.contextUsed = n(u.context_used);
    out.contextMax = n(u.context_max);
    out.contextPercent = n(u.context_percent);
    out.contextEstimated = !!u.context_estimated;
  }
  if (n(u.cache_hit_pct) > 0) out.cacheHitPct = n(u.cache_hit_pct);
  if (n(u.avg_tps) > 0) out.tps = n(u.avg_tps);
  if (n(u.avg_latency_s) > 0) out.latencyS = n(u.avg_latency_s);
  return out;
}

/** 工具结果可读化：网关回传原始 JSON 串时提取常用字段 */
function prettyToolOutput(out) {
  if (typeof out !== 'string') out = JSON.stringify(out);
  try {
    const j = JSON.parse(out);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const pick = j.output ?? j.summary ?? j.content ?? j.text ?? j.message;
      if (pick != null) return typeof pick === 'string' ? pick : JSON.stringify(pick, null, 2);
      if (j.status === 'success' && j.output != null) return String(j.output);
      return JSON.stringify(j, null, 2);
    }
  } catch { /* 非 JSON 原样返回 */ }
  return out;
}

class GatewayTurn {
  /**
   * @param {ChatChannel} channel
   * @param {string} tabId
   * @param {object} opts {query, sessionId, model, reasoning, yolo, cwd, ...}
   * @param {object} callbacks {onEvent, onError, onClose}
   */
  constructor(channel, tabId, opts, callbacks) {
    this.channel = channel;
    this.tabId = tabId;
    this.opts = opts;
    this.cb = callbacks;
    this.turnId = opts.turnId || `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.finished = false;
    this.aborted = false;
    this._abortTimer = null;
    this.liveId = '';
    this.storedId = opts.sessionId || '';
    this.model = opts.model || '';
    this._run();
  }

  async _run() {
    try {
      await this.channel._ensureGateway();
      const gw = this.channel.gateway;
      if (!gw) throw new Error('gateway 连接已重置，请重试');
      const tab = this.channel.tabs.get(this.tabId);
      const liveByTab = this.channel.liveByTab;

      // ---- 确保活会话 ----
      if (tab && tab.liveId) {
        this.liveId = tab.liveId;
        this.storedId = tab.storedId || this.storedId;
        // 复用活会话时必须重建事件路由索引：回合结束会清理 liveByTab，
        // 漏掉这一步会让同一个会话的第二轮收不到任何后端事件。
        liveByTab.set(this.liveId, this.tabId);
      } else if (this.storedId) {
        // 续接既有会话（serve 重启后活会话丢失，用 stored id 恢复）
        try {
          const r = await gw.rpc('session.resume', { session_id: this.storedId }, 30000);
          this.liveId = r?.session_id || '';
          if (this.liveId) liveByTab.set(this.liveId, this.tabId);
          // resume 的 info 里自带 usage 快照（模型 / token / 上下文占用），作为初值
          if (r && r.usage && typeof r.usage === 'object') {
            this._emit({ type: 'usage', usage: normalizeUsage(r.usage) });
          }
        } catch { this.liveId = ''; }
      }
      if (!this.liveId) {
        const createParams = {
          cwd: this.opts.cwd || os.homedir(),
          source: 'desktop',
        };
        if (this.opts.model) createParams.model = this.opts.model;
        if (this.opts.reasoning && this.opts.reasoning !== 'default') createParams.reasoning_effort = this.opts.reasoning;
        const r = await gw.rpc('session.create', createParams, 30000);
        this.liveId = r.session_id;
        this.storedId = r.stored_session_id || this.storedId;
        if (r.info?.model) this.model = this.model || r.info.model;
        liveByTab.set(this.liveId, this.tabId);
      }
      if (tab) { tab.liveId = this.liveId; tab.storedId = this.storedId; }

      // ---- 模型/推理力度切换（活会话内经 slash 命令生效）----
      if (this.opts.model && this.model && this.opts.model !== this.model) {
        const eff = this.opts.reasoning && this.opts.reasoning !== 'default' ? this.opts.reasoning : '';
        const cmd = `/model ${this.opts.model}${eff ? ` --reasoning ${eff}` : ''}`;
        await gw.rpc('slash.exec', { session_id: this.liveId, command: cmd }, 30000).catch(() => {});
      }

      // ---- 合成 init 事件（渲染层靠它绑定 sessionId/model）----
      this._emit({ type: 'system', subtype: 'init', session_id: this.storedId || this.liveId, model: this.opts.model || this.model });

      // 会话还在建立时用户就按了停止：不要在停止后把 prompt 发出去
      if (this.aborted) {
        this._finish({ exitCode: 130, aborted: true, sessionId: this.storedId, model: this.model });
        return;
      }

      // ---- 附件（必须在 prompt.submit 之前：后端在回合开始时消费 attached_images 并清空）----
      await this._attachFiles(gw);
      if (this.finished) return;
      if (this.aborted) {
        this._finish({ exitCode: 130, aborted: true, sessionId: this.storedId, model: this.model });
        return;
      }

      // ---- 提交回合 ----
      this.channel.activeTurns.set(this.liveId, this);
      await gw.rpc('prompt.submit', {
        session_id: this.liveId,
        text: String(this.opts.query || ''),
        surface: 'desktop',
      }, 600000);
    } catch (err) {
      if (!this.finished) {
        // 回调在 webContents 销毁等情况下可能抛；不能让它挡住回合收尾
        try { this.cb.onError && this.cb.onError(err); } catch {}
        this._finish({ exitCode: 1, error: err.message });
      }
    }
  }

  /**
   * 附加本地文件到活会话。失败不阻塞回合：文字照发，并给渲染层一条可读提示。
   * 不把异常抛给 _run 的 catch —— 附件坏了不该让整轮对话变成错误卡。
   */
  async _attachFiles(gw) {
    const paths = cleanAttachments(this.opts.attachments);
    if (!paths.length) return;
    const failed = [];
    for (const p of paths) {
      if (this.finished || this.aborted) return;
      try {
        await gw.rpc(attachMethod(p), { session_id: this.liveId, path: p }, 20000);
      } catch (err) {
        failed.push(`${path.basename(p)}：${(err && err.message) || '附加失败'}`);
      }
    }
    if (failed.length) {
      const text = `附件未能附加（${failed.join('；')}），本轮仅发送文字。`;
      log.warn('chat', log.redact(text));
      this._emit({ type: 'notice', level: 'warn', text });
    }
  }

  _emit(evt) {
    if (this.finished) return;
    try { this.cb.onEvent && this.cb.onEvent({ ...evt, turnId: this.turnId }); } catch {}
  }

  /** 处理路由到本回合的 gateway 事件（envelope: {type, payload, session_id}） */
  handleEvent(env) {
    if (this.finished) return;
    const t = env.type;
    const p = env.payload || {};
    if (t === 'message.delta' || t === 'message.interim') {
      const text = extractText(p.text ?? p);
      if (text) this._emit({ type: 'text', text });
    } else if (t === 'reasoning.delta') {
      // 真·推理流：独立事件类型，渲染层折叠展示，绝不混进正文
      const text = extractText(p.text ?? p.delta ?? p);
      if (text) this._emit({ type: 'thinking', text });
    } else if (t === 'reasoning.available') {
      // 后端在回合内给「已提取的完整推理」快照（可能比流式片段更完整/更干净）：
      // 语义是替换当前推理块，不是追加，也不是正文（官方桌面版同为 replace）。
      const text = extractText(p.text ?? p);
      if (text) this._emit({ type: 'thinking', text, final: true });
    } else if (t === 'thinking.delta') {
      // v0.23.0 起 thinking.delta 是「等待/加载提示」（颜文字 spinner、provider 等待），
      // 不是推理内容（见 tui_gateway/agent_callbacks.py:_agent_thinking_update）。它只该进
      // 底部状态行，绝不能变成一条空的「思考过程」块。
      const text = extractText(p.text ?? p.delta ?? p);
      if (text) this._emit({ type: 'thinking_wait', text });
    } else if (t === 'tool.start') {
      this._emit({
        type: 'tool_use', name: p.name || '', tool_call_id: p.tool_id || '',
        input: p.args || null, preview: p.preview || undefined,
      });
    } else if (t === 'tool.complete') {
      const raw = p.summary ?? p.result_text ?? (p.result != null ? JSON.stringify(p.result) : '');
      this._emit({
        type: 'tool_result', name: p.name || '', tool_call_id: p.tool_id || '',
        output: prettyToolOutput(raw),
        duration_ms: Math.round((p.duration_s || 0) * 1000), is_error: false,
      });
    } else if (t === 'session.usage') {
      // 后端在回合进行中按间隔推送（tui_gateway: _emit("session.usage", sid, {usage})）
      const u = p.usage || p;
      if (u && typeof u === 'object') this._emit({ type: 'usage', usage: normalizeUsage(u) });
    } else if (t === 'session.info') {
      if (p.model) { this.model = p.model; this._emit({ type: 'system', subtype: 'init', session_id: this.storedId || this.liveId, model: p.model }); }
    } else if (t === 'message.complete') {
      const text = extractText(p.text);
      const err = p.error || (p.failure_reason ? String(p.failure_reason) : '');
      // 兜底：后端把本回合最后一段推理随 complete 一起给（display.show_reasoning 关掉时
      // 通常没有流式 reasoning.delta，但 last_reasoning 仍可能在这里）。必须在 _finish 之前发，
      // 否则会被 finished 拦掉。
      const reasoning = extractText(p.reasoning);
      if (reasoning) this._emit({ type: 'thinking', text: reasoning, final: true });
      this._emit({
        type: 'result',
        session_id: this.storedId || this.liveId,
        text,
        exit_code: err ? 1 : 0,
        error: err || undefined,
        tokens: p.usage ? normalizeUsage(p.usage) : null,
        interrupted: this.aborted || !!p.partial,
      });
      this._finish({ exitCode: err ? 1 : 0, sessionId: this.storedId, model: this.model, aborted: this.aborted });
    } else if (t === 'error') {
      const msg = typeof p === 'string' ? p : (p.message || p.error || JSON.stringify(p));
      this._emit({ type: 'result', session_id: this.storedId || this.liveId, text: '', exit_code: 1, error: String(msg) });
      this._finish({ exitCode: 1, sessionId: this.storedId, model: this.model });
    }
  }

  abort() {
    if (this.finished) return;
    // 即使 liveId 还没拿到（session.create 在途），也要先打上标记
    this.aborted = true;
    if (this.liveId) {
      try {
        this.channel.gateway?.rpc('session.interrupt', { session_id: this.liveId }, 15000).catch(() => {});
      } catch { /* 连接已关闭 */ }
    }
    // 后端若没有回 message.complete（断线 / 卡住），tab.current 会一直占用队列，
    // 用户「停止后再发」的新消息会被永久排队。宽限期后强制收尾。
    if (!this._abortTimer) {
      this._abortTimer = setTimeout(() => {
        this._abortTimer = null;
        this._finish({ exitCode: 130, aborted: true, sessionId: this.storedId, model: this.model });
      }, this.channel._abortGraceMs);
      if (this._abortTimer.unref) this._abortTimer.unref();
    }
  }

  _finish(summary) {
    if (this.finished) return;
    this.finished = true;
    if (this._abortTimer) { clearTimeout(this._abortTimer); this._abortTimer = null; }
    if (this.liveId) {
      this.channel.activeTurns.delete(this.liveId);
      // 只清理属于本回合的索引；下轮 run() 会重新 set，避免无限增长的 Map
      if (this.channel.liveByTab.get(this.liveId) === this.tabId) {
        this.channel.liveByTab.delete(this.liveId);
      }
    }
    try {
      this.cb.onClose && this.cb.onClose({ turnId: this.turnId, sessionId: this.storedId || this.liveId, model: this.model, exitCode: 0, ...summary });
    } catch { /* 页面已关闭等场景 */ }
  }
}

class ChatChannel {
  /**
   * @param {string} [hermesBin]
   * @param {object} [opts] 仅用于依赖注入（回归测试），生产路径全部走默认值
   * @param {object} [opts.backend] 假后端
   * @param {function} [opts.createGateway] 假 WS 连接工厂
   * @param {number} [opts.connectTimeoutMs] 等 WS open 的时限，默认 20s
   * @param {number} [opts.abortGraceMs] 停止后强制收尾的宽限，默认 10s
   */
  constructor(hermesBin, opts = {}) {
    this.hermesBin = hermesBin || '';
    this.tabs = new Map();     // tabId -> {queue, current, sessionId(stored), liveId, storedId, model}
    this.activeTurns = new Map(); // liveId -> GatewayTurn
    this.liveByTab = new Map();   // liveId -> tabId（事件路由索引）
    this.gateway = null;
    this.gatewayReady = null;
    this._approvalHandler = null;
    this._pendingApprovals = new Map(); // requestId -> {tabId, sid, timer}
    this._backendEpoch = 0;   // 最近一次见到的 HermesBackend.generation（构造后同步）
    this._epochStamp = 0;     // 每次后端失效递增；在途连接靠它判定自己是否已过期
    this._connectTimeoutMs = Number(opts.connectTimeoutMs) > 0 ? Number(opts.connectTimeoutMs) : 20000;
    this._abortGraceMs = Number(opts.abortGraceMs) > 0 ? Number(opts.abortGraceMs) : 10000;
    /** 连接状态变化回调：{state, port, connected, epoch}。主进程负责转发给渲染层。 */
    this._onStatusCb = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
    this._gatewayFactory = typeof opts.createGateway === 'function'
      ? opts.createGateway
      : ((o) => new GatewayConnection(o));
    this.backend = opts.backend || new HermesBackend({
      hermesBin: this.hermesBin,
      onStatus: (s) => this._onBackendStatus(s),
    });
    this._backendEpoch = Number(this.backend.generation) || 0;
  }

  /**
   * 后端只读快照，供主进程内的旁路客户端（如 kanban REST）拼 loopback 请求。
   * 只返回标量与代次，不返回 child 句柄；token 永远不进渲染层。
   * state 为 ready 之外时 port 归零，避免换代期间拿到旧端口。
   */
  backendInfo() {
    const b = this.backend;
    const ready = !!b && b.state === 'ready' && Number(b.port) > 0;
    return {
      port: ready ? Number(b.port) : 0,
      token: ready ? String(b.token || '') : '',
      generation: Number(b?.generation) || 0,
      state: b ? String(b.state || 'idle') : 'idle',
    };
  }

  /**
   * 删除项目（官方 `projects.delete` JSON-RPC）：只删 projects.db 里的项目记录与文件夹关联，
   * **不删磁盘上的文件 / git 仓库 / 工作树**。走常驻 serve 的 RPC，方法名写死、id 先校验，
   * 渲染层拿不到任意 RPC 调用能力。CLI 没有 `project delete` 子命令，这是唯一官方写口。
   */
  async deleteProject(projectId) {
    const id = String(projectId || '').trim();
    if (!PROJECT_ID_RE.test(id) || id.includes('..')) return { ok: false, error: '项目标识无效' };
    try {
      await this._ensureGateway();
      const gw = this.gateway;
      if (!gw) return { ok: false, error: 'gateway 连接已重置，请重试' };
      const res = await gw.rpc('projects.delete', { id, profile: profile.current() }, 20000);
      return { ok: true, activeId: String((res && res.active_id) || '') };
    } catch (err) {
      const msg = String((err && err.message) || err || '删除失败');
      log.warn('chat', `projects.delete: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * 把已存储的会话重新挂到另一个项目的根目录（官方 `session.workspace.move`）：后端换 cwd
   * 并**替换** git 身份（留着旧 git_repo_root 会把会话锁在它已经离开的项目里），项目树的分组
   * 随之跟过来。这是「会话建错目录」唯一的补救通道。
   * 官方语义允许在 turn 运行中移动（live agent 跟着换目录），所以这里不预判 busy。
   */
  async moveSession(sessionId, cwd) {
    const id = String(sessionId || '');
    const dir = String(cwd || '').trim();
    if (!SESSION_ID_RE.test(id)) return { ok: false, error: '会话 ID 不合法' };
    if (!dir.startsWith('/') || dir.length > 512) return { ok: false, error: '目标项目缺少可用的文件夹' };
    try {
      await this._ensureGateway();
      const gw = this.gateway;
      if (!gw) return { ok: false, error: 'gateway 连接已重置，请重试' };
      const res = await gw.rpc('session.workspace.move',
        { session_key: id, cwd: dir, profile: profile.current() }, 30000);
      return {
        ok: true,
        cwd: String((res && res.cwd) || dir),
        branch: String((res && res.branch) || ''),
        gitRepoRoot: String((res && res.git_repo_root) || ''),
      };
    } catch (err) {
      const msg = String((err && err.message) || err || '移动失败');
      log.warn('chat', `session.workspace.move: ${msg}`);
      // gateway 的原始告警是英文短语，直接弹给用户看不懂
      if (/does not exist/i.test(msg)) return { ok: false, error: '目标文件夹不存在（可能已被移动或删除）' };
      if (/session not found/i.test(msg)) return { ok: false, error: '会话不存在（可能已被删除）' };
      if (/session busy/i.test(msg)) return { ok: false, error: '会话正在生成中，等这一轮结束再移动' };
      return { ok: false, error: msg };
    }
  }

  /** 读单个项目（官方 `projects.get`）：设置弹窗需要完整字段——名称 / 描述 / 主文件夹 /
   *  全部文件夹，侧栏树只投影了名字与路径，不够用。 */
  async getProject(projectId) {
    return this._projectRpc('get', { id: String(projectId || '').trim() }, '读取项目');
  }

  /** 改显示字段（官方 `projects.update`）：只放行 name / description / color 三个键，
   *  空字符串表示清除（与 gateway 契约一致）。 */
  async updateProject(input) {
    const o = input || {};
    const id = String(o.id || '').trim();
    const patch = {};
    if (typeof o.name === 'string' && o.name.trim()) patch.name = o.name.trim().slice(0, 80);
    if (typeof o.description === 'string') patch.description = o.description.slice(0, 400);
    if (typeof o.color === 'string') patch.color = o.color.slice(0, 16);
    if (!Object.keys(patch).length) return { ok: false, error: '没有要更新的字段' };
    return this._projectRpc('update', { id, ...patch }, '保存项目');
  }

  /** 项目文件夹维护（官方 projects.add_folder / remove_folder / set_primary）。
   *  op 走白名单，方法名与参数拼装都在这里，渲染层传不进任意 RPC。 */
  async projectFolder(input) {
    const o = input || {};
    const op = String(o.op || '');
    const path0 = String(o.path || '').trim();
    if (!path0.startsWith('/') || path0.length > 512) return { ok: false, error: '文件夹需为绝对路径' };
    if (op === 'add') return this._projectRpc('add', { id: String(o.id || '').trim(), path: path0 }, '添加文件夹');
    if (op === 'remove') return this._projectRpc('remove', { id: String(o.id || '').trim(), path: path0 }, '移除文件夹');
    if (op === 'primary') return this._projectRpc('primary', { id: String(o.id || '').trim(), path: path0 }, '设为主文件夹');
    return { ok: false, error: '不支持的项目文件夹操作' };
  }

  /** 项目类 RPC 的公共壳：key 只认 PROJECT_RPC 里的常量，id 先校验、补 profile，
   *  返回的项目对象收敛成渲染层需要的窄形状。 */
  async _projectRpc(key, params, label) {
    const method = PROJECT_RPC[String(key || '')];
    if (!method) return { ok: false, error: '不支持的项目操作' };
    const id = String((params && params.id) || '').trim();
    if (!PROJECT_ID_RE.test(id) || id.includes('..')) return { ok: false, error: '项目标识无效' };
    try {
      await this._ensureGateway();
      const gw = this.gateway;
      if (!gw) return { ok: false, error: 'gateway 连接已重置，请重试' };
      const res = await gw.rpc(method, { ...params, id, profile: profile.current() }, 20000);
      return { ok: true, project: projectInfo(res && res.project) };
    } catch (err) {
      const msg = String((err && err.message) || err || label || '操作失败');
      log.warn('chat', `${method}: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /** 应用启动时预热后端（不阻塞窗口） */
  startBackend() { this.backend.start().catch((e) => log.error('chat', `backend prewarm: ${e.message}`)); }
  stopBackend() {
    // 切换 profile 会让所有在途审批失效：先拒绝，避免旧会话悬挂
    this._denyAllApprovals();
    this.backend.stop();
    if (this.gateway) { try { this.gateway.close(); } catch {} this.gateway = null; }
    // 切换 profile 后必须清空：否则 _ensureGateway 会复用旧后端的连接 promise
    this.gatewayReady = null;
    this._resetLiveSessions();
    this._epochStamp += 1;
  }

  _denyAllApprovals() {
    for (const [rid, p] of this._pendingApprovals) {
      clearTimeout(p.timer);
      try {
        this.gateway?.rpc('approval.respond', { session_id: p.sid, request_id: rid, choice: 'deny' }, 5000).catch(() => {});
      } catch { /* 连接已关闭 */ }
    }
    this._pendingApprovals.clear();
  }

  /** 活会话 id 只在其所属 serve 进程内有效；进程一换，必须全部作废。
   *  storedId 保留，下一轮由 GatewayTurn 走 session.resume 恢复历史。 */
  _resetLiveSessions() {
    this.liveByTab.clear();
    this.activeTurns.clear();
    for (const tab of this.tabs.values()) tab.liveId = '';
  }

  /** 后端换代 / 掉线：关连接、废活会话、清空排队，避免重连旧端口或把旧 liveId 打给新后端。 */
  _invalidateBackend(reason) {
    this._epochStamp += 1;
    this._denyAllApprovals();
    if (this.gateway) { try { this.gateway.close(); } catch {} this.gateway = null; }
    this.gatewayReady = null;
    this._resetLiveSessions();
    // 先排空队列：否则在途回合收尾触发 _next() 会把排队消息灌进正在重启的后端
    for (const tab of this.tabs.values()) {
      const pending = tab.queue.splice(0);
      for (const q of pending) {
        // 排队请求没有 onStarted，只给 onError 会让渲染层永远停在 running=true
        try { q.callbacks.onError && q.callbacks.onError(new Error(`${reason}，已取消排队请求，请重试`)); } catch {}
        try { q.callbacks.onClose && q.callbacks.onClose({ exitCode: 1, queued: true, error: reason }); } catch {}
      }
    }
    // 在途回合立即收尾，不等 prompt.submit 的 10 分钟超时；迟到的 RPC reject 会被 finished 挡掉
    for (const tab of this.tabs.values()) {
      const turn = tab.current;
      if (!turn || turn.finished) continue;
      try { turn.cb.onError && turn.cb.onError(new Error(`${reason}，本轮未完成，请重试`)); } catch {}
      turn._finish({ exitCode: 1, error: reason });
    }
  }

  _onBackendStatus(s) {
    const gen = Number(s && s.generation) || 0;
    const state = s && s.state;
    if (gen && gen !== this._backendEpoch) {
      const first = this._backendEpoch === 0; // 首次启动不算「重启」
      this._backendEpoch = gen;
      if (!first) {
        this._invalidateBackend(state === 'idle' ? 'hermes serve 已停止' : 'hermes serve 正在重启');
      }
      this._emitStatus();
      return;
    }
    // 同一代进程异常退出：新进程还没 spawn，generation 未变，也要立刻停掉旧连接
    if ((state === 'error' || state === 'idle') && this._backendEpoch > 0) {
      this._invalidateBackend('hermes serve 连接中断');
    }
    this._emitStatus();
  }

  /** gateway WS 的连接状态（断线重连由 gateway-client 自己排期，这里只负责让状态可见）。 */
  _onGatewayStatus(st) {
    this._emitStatus(!!(st && st.connected));
  }

  /** 连接状态快照：不含 token，只给渲染层判断「能不能用 / 要不要重连」。
   *  `linked` = WS 是否**建立过**（现在断没断都算）。空闲启动时应用一条 RPC 都没发过，
   *  WS 还没建、connected 必然是 false —— 这不是故障，别让状态点显示成「连接中」。 */
  statusSnapshot() {
    const info = this.backendInfo();
    return {
      state: info.state,
      port: info.port,
      epoch: info.generation,
      connected: !!(this.gateway && this.gateway.connected),
      linked: !!this.gateway,
    };
  }

  _emitStatus(forceConnected) {
    const info = this.backendInfo();
    const connected = forceConnected === undefined ? !!(this.gateway && this.gateway.connected) : forceConnected;
    try {
      this._onStatusCb({
        state: info.state, port: info.port, epoch: info.generation,
        connected, linked: !!this.gateway || connected === true,
      });
    } catch { /* 状态回调异常不影响主流程 */ }
  }

  /**
   * 手动重连：丢到现有 gateway 后重新建连。gateway-client 有自己的退避重连，
   * 这里给用户一个「立刻再试一次」的入口（自动重连连续失败时最常见）。
   * 后端进程本身挂了会经 backend.start() 的幂等启动路径重新拉起。
   */
  async reconnect() {
    try { if (this.gateway) this.gateway.close(); } catch { /* 已关闭 */ }
    this.gateway = null;
    this.gatewayReady = null;
    this._emitStatus(false);
    try {
      await this._ensureGateway();
      this._emitStatus();
      return { ok: true };
    } catch (err) {
      const msg = String((err && err.message) || err || '重连失败');
      log.warn('chat', `reconnect: ${msg}`);
      this._emitStatus(false);
      return { ok: false, error: msg };
    }
  }

  async _ensureGateway() {
    if (this.gateway && this.gateway.connected) return;
    if (this.gatewayReady) return this.gatewayReady;
    this.gatewayReady = (async () => {
      const port = await this.backend.start(); // 内部幂等：退避重启期间会等待，不会叠加 spawn
      const stamp = this._epochStamp;
      if (!port || !this.backend.token) throw new Error('hermes serve 未返回有效端口');
      if (this.gateway) { try { this.gateway.close(); } catch {} this.gateway = null; }
      const gw = this._gatewayFactory({
        port, token: this.backend.token,
        onStatus: (st) => this._onGatewayStatus(st),
      });
      // 服务端请求（approval.received 等）：回 ack 并按 yolo 自动响应
      gw.onRequest(({ method, params }) => {
        if (method === 'approval.received') {
          this._handleApproval(params || {}).catch((e) => log.error('chat', `approval: ${e.message}`));
        }
        return {};
      });
      gw.onEvent((env) => this._routeEvent(env));
      let ok = false;
      try {
        gw.connect();
        // 等待 connected
        await new Promise((resolve, reject) => {
          const t0 = Date.now();
          const iv = setInterval(() => {
            if (gw.connected) { clearInterval(iv); resolve(); }
            else if (Date.now() - t0 > this._connectTimeoutMs) { clearInterval(iv); reject(new Error('gateway WS 连接超时')); }
          }, 100);
        });
        // 等待期间后端换过代：这条连接指向旧端口/旧 token，绝不能挂上去
        if (stamp !== this._epochStamp) throw new Error('hermes serve 已重启，连接作废，请重试');
        this.gateway = gw;
        ok = true;
      } finally {
        // 失败时不能留下一个后台无限重连、又永远不会被 close 的孤儿连接
        if (!ok) { try { gw.close(); } catch {} }
      }
    })();
    try {
      await this.gatewayReady;
    } finally {
      this.gatewayReady = null;
    }
  }

  /** 危险操作审批：交给渲染层做「允许 / 拒绝」确认，超时或无 UI 时默认拒绝。
   *  yolo 模式保持原有自动放行行为。不改变 CLI 侧协议，只是不再静默 deny。 */
  async _handleApproval(params) {
    const sid = String(params.session_id || '');
    const requestId = String(params.request_id || '');
    if (!requestId) return;
    let tabId = this.liveByTab.get(sid);
    if (!tabId && sid) {
      for (const [lid, tid] of this.liveByTab) {
        const t = this.tabs.get(tid);
        if (t && (t.storedId === sid || lid === sid)) { tabId = tid; break; }
      }
    }
    const tab = tabId ? this.tabs.get(tabId) : null;
    const yolo = !!(tab && tab.current && tab.current.opts.yolo);
    if (yolo) {
      await this.gateway.rpc('approval.respond', { session_id: sid, request_id: requestId, choice: 'approve' }, 15000);
      return;
    }
    const detail = {
      requestId, tabId: tabId || '', sessionId: sid,
      tool: String(params.tool || params.tool_name || params.name || ''),
      command: String(params.command || params.cmd || params.description || params.reason || ''),
      risk: String(params.risk || params.level || ''),
    };
    const sent = this._approvalHandler && this._approvalHandler(detail);
    if (!sent) {
      await this.gateway.rpc('approval.respond', { session_id: sid, request_id: requestId, choice: 'deny' }, 15000);
      if (tab && tab.current) tab.current._emit({ type: 'text', text: '\n\n> ⚠️ 已拒绝危险操作（无可用确认界面）\n\n' });
      return;
    }
    // 25s 内没有用户响应就按拒绝处理，避免后端一直挂着等 ack
    const timer = setTimeout(() => {
      if (!this._pendingApprovals.has(requestId)) return;
      this._pendingApprovals.delete(requestId);
      this.gateway?.rpc('approval.respond', { session_id: sid, request_id: requestId, choice: 'deny' }, 15000).catch(() => {});
    }, 25000);
    this._pendingApprovals.set(requestId, { tabId, sid, timer });
  }

  setApprovalHandler(fn) { this._approvalHandler = typeof fn === 'function' ? fn : null; }

  /** 渲染层回传用户选择；校验 requestId 归属，防止跨会话误批准。 */
  respondApproval(requestId, choice, tabId) {
    const p = this._pendingApprovals.get(String(requestId || ''));
    if (!p) return false;
    if (tabId && p.tabId && String(tabId) !== String(p.tabId)) return false;
    clearTimeout(p.timer);
    this._pendingApprovals.delete(String(requestId));
    const c = choice === 'approve' || choice === 'always' ? 'approve' : 'deny';
    this.gateway?.rpc('approval.respond', { session_id: p.sid, request_id: String(requestId), choice: c }, 15000)
      .catch((e) => log.error('chat', `approval respond: ${e.message}`));
    return true;
  }

  _routeEvent(env) {
    // 按 session_id 路由到活跃回合（兼容 live/stored 两种 id）
    let tabId = this.liveByTab.get(env.session_id || '');
    if (!tabId && env.session_id) {
      for (const [lid, tid] of this.liveByTab) {
        const tab = this.tabs.get(tid);
        if (tab && tab.storedId === env.session_id) { tabId = tid; break; }
      }
    }
    if (tabId) {
      const tab = this.tabs.get(tabId);
      if (tab && tab.current) tab.current.handleEvent(env);
    } else if (env.type === 'message.complete' || env.type === 'error') {
      // 无归属的完成事件：忽略（广播型）
    }
  }

  submit(tabId, opts, callbacks) {
    const cb = callbacks || {};
    const failFast = (msg) => {
      try { cb.onError && cb.onError(new Error(msg)); } catch {}
      // 只发 onError 不够：渲染层 send() 已把 tab.running 置 true，没有 close 就永远解不开
      try { cb.onClose && cb.onClose({ exitCode: 1, error: msg }); } catch {}
    };
    if (!tabId) { failFast('缺少会话页签，无法发送'); return null; }
    const tab = this.tabs.get(tabId) || { queue: [], current: null, sessionId: '', liveId: '', storedId: '', model: '' };
    this.tabs.set(tabId, tab);
    if (tab.queue.length >= 8) {
      log.warn('chat', 'submit queue full', { tabId });
      failFast('排队请求过多，请稍后重试');
      return this.getTabState(tabId);
    }
    tab.queue.push({ opts, callbacks: cb });
    if (!tab.current) this._next(tabId);
    return this.getTabState(tabId);
  }

  _next(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.current || tab.queue.length === 0) return;
    const q = tab.queue.shift();
    const opts = q.opts || {};
    const callbacks = q.callbacks || {};
    const turn = new GatewayTurn(this, tabId, { ...opts, sessionId: opts.sessionId || tab.sessionId || tab.storedId }, {
      onEvent: (evt) => callbacks.onEvent(evt),
      onError: (err) => callbacks.onError && callbacks.onError(err),
      onClose: (summary) => {
        if (summary.sessionId) { tab.sessionId = summary.sessionId; tab.storedId = summary.sessionId; }
        if (summary.model) tab.model = summary.model;
        tab.current = null;
        // 单个回调异常不能堵住队列：否则后续排队回合永远不会启动
        try { callbacks.onClose && callbacks.onClose(summary); }
        catch (e) { log.warn('chat', `onClose callback: ${e.message}`); }
        this._next(tabId);
      },
    });
    tab.current = turn;
    try { callbacks.onStarted && callbacks.onStarted(turn); } catch {}
  }

  abort(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    // 停止必须同时废掉排队中的后续回合，否则中断当前轮后 _next() 会自动开下一轮
    const pending = tab.queue.splice(0);
    for (const q of pending) {
      try { q.callbacks.onClose && q.callbacks.onClose({ aborted: true, exitCode: 130 }); } catch {}
    }
    if (tab.current) tab.current.abort();
  }

  abortAll() { for (const tabId of this.tabs.keys()) this.abort(tabId); }

  getTabState(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? { sessionId: tab.sessionId || tab.storedId, model: tab.model, running: !!tab.current, queued: tab.queue.length } : null;
  }
}

module.exports = { ChatChannel, GatewayTurn, resolveHermesBin, DEFAULT_HERMES };
