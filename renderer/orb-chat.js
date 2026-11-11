'use strict';
/**
 * 迷你聊天窗渲染层。
 *
 * 它和主窗口**共用同一个 chat tab**（tabId 由主窗口渲染层上报，见 app.js 的
 * publishOrbContext）：主窗口只是 hide()，它的渲染层与 tab.items 都还活着，
 * 所以这边发出去的消息、流式回复，主窗口恢复后同样是完整的，不会出现
 * 「小窗聊了半天、回主窗一片空白」。
 *
 * 这里刻意只渲染「用户 / 助手 / 一行工具状态 / 错误 / 审批」五类：
 * 小窗宽度只有 380px，工具卡片与推理块在主窗口里看更合适。
 */
const api = window.orbChat;

const els = {
  shell: document.querySelector('.oc-shell'),
  title: document.getElementById('oc-title'),
  meta: document.getElementById('oc-meta'),
  feed: document.getElementById('oc-feed'),
  empty: document.getElementById('oc-empty'),
  status: document.getElementById('oc-status'),
  input: document.getElementById('oc-input'),
  send: document.getElementById('oc-send'),
  stop: document.getElementById('oc-stop'),
};

const S = {
  tabId: '',
  title: '新会话',
  model: '',
  theme: 'light',
  running: false,
  turnRunning: false,  // 只认主进程下发的回合态：连接轨呼吸的唯一依据
  items: [],        // { kind:'user'|'ai'|'tool'|'error'|'approval', ... }
  ready: false,     // bootstrap 完成前不接受输入
};

/** 回合态唯一入口。bootstrap / sync / state 都由主进程给快照，
 *  渲染层不根据本地事件流自造状态机 —— 否则小窗点开时机的不同会让
 *  连接轨和球上的 busy 弧对不上。 */
function applyTurnState(running) {
  S.turnRunning = !!running;
  document.body.dataset.running = S.turnRunning ? 'true' : 'false';
}

/* ---------------- 渲染 ---------------- */

let raf = 0;
/** 合帧：流式 delta 一秒可能上百条，逐条重建 DOM 会抖 */
function render() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; paint(); });
}

function nearBottom() {
  const f = els.feed;
  return f.scrollHeight - f.scrollTop - f.clientHeight < 56;
}

/** 极简 Markdown：只处理围栏代码块与行内 code，其余按纯文本 + 保留换行。
 *  用 textContent 落地，任何模型输出都不会变成可执行 HTML。 */
function renderText(el, text) {
  const src = String(text == null ? '' : text);
  src.split(/```/).forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement('pre');
      pre.textContent = part.replace(/^[A-Za-z0-9_+-]*\n/, '').replace(/\n$/, '');
      el.appendChild(pre);
      return;
    }
    if (!part) return;
    const seg = document.createElement('span');
    part.split(/(`[^`\n]+`)/).forEach((s) => {
      if (/^`[^`\n]+`$/.test(s)) {
        const c = document.createElement('code');
        c.textContent = s.slice(1, -1);
        seg.appendChild(c);
      } else if (s) {
        seg.appendChild(document.createTextNode(s));
      }
    });
    el.appendChild(seg);
  });
}

function typingNode() {
  const wrap = document.createElement('span');
  wrap.className = 'oc-typing';
  wrap.appendChild(document.createElement('i'));
  wrap.appendChild(document.createElement('i'));
  wrap.appendChild(document.createElement('i'));
  return wrap;
}

function approvalNode(it) {
  const card = document.createElement('div');
  card.className = 'oc-approval';
  const head = document.createElement('div');
  head.className = 'oc-approval-head';
  head.textContent = '需要确认：' + (it.tool || '工具调用');
  card.appendChild(head);

  const cmd = document.createElement('div');
  cmd.className = 'oc-approval-cmd';
  cmd.textContent = String(it.command || '').slice(0, 600) || '（无命令预览）';
  card.appendChild(cmd);

  if (it.choice) {
    const done = document.createElement('div');
    done.className = 'oc-approval-done';
    done.textContent = it.choice === 'approve' ? '已允许该操作' : '已拒绝该操作';
    card.appendChild(done);
    return card;
  }

  const row = document.createElement('div');
  row.className = 'oc-approval-row';
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.textContent = '拒绝';
  deny.addEventListener('click', () => decide(it, 'deny'));
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'oc-allow';
  allow.textContent = '允许';
  allow.addEventListener('click', () => decide(it, 'approve'));
  row.appendChild(deny);
  row.appendChild(allow);
  card.appendChild(row);
  return card;
}

function nodeOf(it) {
  const row = document.createElement('div');

  if (it.kind === 'approval') return approvalNode(it);

  if (it.kind === 'tool') {
    row.className = 'oc-msg is-tool' + (it.state === 'running' ? '' : it.isError ? ' is-error' : ' is-done');
    const dot = document.createElement('span');
    dot.className = 'oc-tool-dot';
    const label = document.createElement('span');
    label.textContent = (it.name || '工具') + (it.state === 'running' ? ' · 运行中' : '');
    row.appendChild(dot);
    row.appendChild(label);
    return row;
  }

  const body = document.createElement('div');
  body.className = 'oc-body';

  if (it.kind === 'error') {
    row.className = 'oc-msg is-error';
    body.textContent = String(it.text || '出错了');
    row.appendChild(body);
    return row;
  }

  if (it.kind === 'user') {
    row.className = 'oc-msg is-user';
    body.textContent = String(it.text || '');
    row.appendChild(body);
    return row;
  }

  row.className = 'oc-msg is-ai';
  if (!it.text && !it.done) body.appendChild(typingNode());
  else renderText(body, it.text);
  row.appendChild(body);
  return row;
}

function paint() {
  const stick = nearBottom();
  const frag = document.createDocumentFragment();
  if (!S.items.length) frag.appendChild(els.empty);
  else for (const it of S.items) frag.appendChild(nodeOf(it));
  els.feed.replaceChildren(frag);
  if (stick) els.feed.scrollTop = els.feed.scrollHeight;

  // 主窗只在上报时给标题，而新会话的标题要等第一句话才有意义：这里自己兜一层
  if ((!S.title || S.title === '新会话') && S.items.length) {
    const first = S.items.find((i) => i.kind === 'user' && i.text);
    if (first) S.title = String(first.text).replace(/\s+/g, ' ').slice(0, 24);
  }
  els.title.textContent = S.title || '新会话';
  document.documentElement.setAttribute('data-theme', S.theme === 'dark' ? 'dark' : 'light');

  const running = S.running;
  els.send.hidden = running;
  els.stop.hidden = !running;
  els.send.disabled = !S.ready || !els.input.value.trim();
  syncMeta();
}

function syncMeta() {
  if (!S.ready) { els.meta.textContent = '连接中…'; return; }
  if (S.running) { els.meta.textContent = '运行中…'; return; }
  els.meta.textContent = S.model ? S.model : '就绪';
}

let statusTimer = null;
function setStatus(text, isError) {
  if (!text) { els.status.hidden = true; return; }
  els.status.textContent = text;
  els.status.classList.toggle('is-error', !!isError);
  els.status.hidden = false;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusTimer = null;
    if (!S.running) els.status.hidden = true;
  }, 4000);
}

/* ---------------- 数据 ---------------- */

function bump() { render(); }

function pushItem(it) { S.items.push(it); bump(); }

function lastAi() {
  for (let i = S.items.length - 1; i >= 0; i--) {
    const it = S.items[i];
    if (it.kind === 'ai') return it;
    if (it.kind === 'user') return null;
  }
  return null;
}

/* v0.23.0 起 thinking.delta 是「等待提示」而不是推理：
   ⏳ waiting on … / ⚙ processing prompt 这类可以进状态行，
   颜文字 spinner 一律丢弃 —— 它不是能被展示的内容（主窗口同一套规则）。 */
const RE_PROVIDER_WAIT = /^(?:⏳|⚠|↻|⚙)\s*(?:(?:still\s+)?waiting on|loading|processing prompt|no (?:output|response)|model returned|rate limited|provider (?:overloaded|temporarily unavailable))/i;
function providerWaitText(text) {
  const v = String(text == null ? '' : text).trim();
  return RE_PROVIDER_WAIT.test(v) ? v : '';
}

function onEvent(evt) {
  if (!evt) return;
  switch (evt.type) {
    case 'text': {
      let last = lastAi();
      if (!last || last.done) { last = { kind: 'ai', text: '', done: false }; S.items.push(last); }
      last.text += String(evt.text || '');
      S.running = true;
      bump();
      break;
    }
    case 'thinking': {
      // 小窗不铺推理正文（380px 塞不下），只在状态行示意
      S.running = true;
      setStatus('思考中…');
      break;
    }
    case 'thinking_wait': {
      const wait = providerWaitText(evt.text);
      if (wait) setStatus(wait);
      break;
    }
    case 'tool_use': {
      const last = lastAi();
      if (last && !last.done) last.done = true;
      pushItem({ kind: 'tool', name: evt.name || '工具', state: 'running', isError: false });
      setStatus('执行 ' + (evt.name || '工具') + '…');
      break;
    }
    case 'tool_result': {
      for (let i = S.items.length - 1; i >= 0; i--) {
        const it = S.items[i];
        if (it.kind === 'tool' && it.state === 'running') {
          it.state = 'done';
          it.isError = !!evt.is_error;
          break;
        }
      }
      bump();
      break;
    }
    case 'notice': {
      if (evt.text) setStatus(String(evt.text).slice(0, 120), true);
      break;
    }
    case 'system': {
      if (evt.model) { S.model = evt.model; syncMeta(); }
      break;
    }
    case 'result': {
      const last = lastAi();
      if (last && !last.done) {
        last.done = true;
        if (!last.text && evt.text) last.text = String(evt.text);
      } else if (!last && evt.text) {
        pushItem({ kind: 'ai', text: String(evt.text), done: true });
      }
      S.running = false;
      setStatus('');
      bump();
      break;
    }
    default: break;
  }
}

/* ---------------- 发送 / 停止 / 审批 ---------------- */

function autoGrow() {
  const el = els.input;
  el.style.height = 'auto';
  el.style.height = Math.min(96, el.scrollHeight) + 'px';
}

let draftTimer = null;
function saveDraft() {
  if (draftTimer) return;
  draftTimer = setTimeout(() => {
    draftTimer = null;
    try { api.draft(els.input.value); } catch { /* ignore */ }
  }, 300);
}

async function send() {
  const text = els.input.value.replace(/\s+$/, '');
  if (!text || S.running || !S.ready) return;

  els.input.value = '';
  autoGrow();
  els.send.disabled = true;
  pushItem({ kind: 'user', text });
  const placeholder = { kind: 'ai', text: '', done: false };
  S.items.push(placeholder);
  S.running = true;
  setStatus('已发送，等待回复…');
  bump();

  try {
    const r = await api.send(text);
    if (r && r.ok === false) throw new Error(r.error || '发送失败');
    if (r && typeof r.running === 'boolean') { S.running = r.running; applyTurnState(r.running); }
    bump();
  } catch (err) {
    // 发送失败：撤掉占位气泡，换成错误卡，别让三点动画一直转
    const i = S.items.indexOf(placeholder);
    if (i >= 0) S.items.splice(i, 1);
    S.running = false;
    applyTurnState(false);
    pushItem({ kind: 'error', text: '发送失败：' + ((err && err.message) || err) });
    setStatus('发送失败', true);
  }
}

function decide(it, choice) {
  if (!it || it.choice) return;
  it.choice = choice === 'deny' ? 'deny' : 'approve';
  bump();
  try { api.approve(it.requestId, choice); } catch { /* 主进程已过期 */ }
}

function stop() {
  if (!S.running) return;
  try { api.abort(); } catch { /* ignore */ }
  setStatus('已请求停止…');
}

/* ---------------- 绑定 ---------------- */

els.input.addEventListener('input', () => {
  autoGrow();
  els.send.disabled = !els.input.value.trim();
  saveDraft();
});

els.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    api.close();
  }
});

els.send.addEventListener('click', send);
els.stop.addEventListener('click', stop);
document.getElementById('oc-close').addEventListener('click', () => api.close());
document.getElementById('oc-expand').addEventListener('click', () => api.expand());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); api.close(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') { event.preventDefault(); api.close(); }
});

document.addEventListener('dragstart', (event) => event.preventDefault());

api.onEvent(onEvent);

api.onApproval((req) => {
  if (!req || !req.requestId) return;
  pushItem({
    kind: 'approval',
    requestId: req.requestId,
    tool: req.tool || '工具调用',
    command: req.command || '',
  });
  setStatus('有操作待确认', true);
});

api.onApprovalResolved((p) => {
  if (!p || !p.requestId) return;
  const it = S.items.find((x) => x.kind === 'approval' && x.requestId === p.requestId);
  if (it && !it.choice) { it.choice = p.choice === 'deny' ? 'deny' : 'approve'; bump(); }
});

api.onState((p) => {
  if (!p) return;
  if (typeof p.running === 'boolean') { S.running = p.running; applyTurnState(p.running); }
  if (S.running) {
    setStatus('');
  } else {
    const last = lastAi();
    if (last && !last.done) last.done = true;
    setStatus('');
  }
  bump();
});

/** 主进程按球与面板的实时坐标算方位：面板被拖到球的另一侧时要跟着翻 */
function applySide(side) {
  document.body.dataset.side = side === 'left' ? 'left' : 'right';
}

/** 主进程每次「点球 / ⌥⇧H」把面板亮出来都会发这条：光标直接落进输入框，
 *  并把插入点放到草稿末尾（不选中，避免误覆盖）——用户不用再点一下才能打字。 */
api.onFocus(() => {
  try {
    els.input.focus();
    const n = els.input.value.length;
    els.input.setSelectionRange(n, n);
  } catch { /* 面板正在销毁 */ }
});

api.onSync((p) => {
  if (!p) return;
  if (p.side) applySide(p.side);
  if (p.theme) S.theme = p.theme;
  if (p.title) S.title = p.title;
  if (p.model) S.model = p.model;
  if (typeof p.running === 'boolean') { S.running = p.running; applyTurnState(p.running); }
  // 主窗那边的会话换了（或主窗新加载了历史）：整块换掉。
  // 两种情况都要换：本地面板是空的（第一次打开 / 刚收起过），或者回合已经结束。
  // 唯独「本地正在流式输出」时不能换，那会把刚收到的半截回复冲掉。
  if (Array.isArray(p.messages) && (!S.running || !S.items.length)) {
    hydrate(p.messages, S.running);
    S.tabId = p.tabId || S.tabId;
    S.sessionId = p.sessionId || null;
  }
  bump();
});

/** 把主窗快照铺进面板：最后一条助手消息在回合未结束时保持 done=false，
 *  这样紧接着到达的 delta 会续写同一条，而不是另起一段。 */
function hydrate(messages, running) {
  const arr = Array.isArray(messages) ? messages : [];
  S.items = arr.map((m, i) => ({
    kind: m && m.role === 'user' ? 'user' : 'ai',
    text: String((m && m.text) || ''),
    done: i === arr.length - 1 ? !running : true,
  }));
}

(async function boot() {
  try {
    const b = await api.bootstrap();
    if (b) {
      applySide(b.side);
      S.tabId = b.tabId || '';
      S.sessionId = b.sessionId || null;
      S.title = b.title || '新会话';
      S.model = b.model || '';
      S.theme = b.theme === 'dark' ? 'dark' : 'light';
      S.running = !!b.running;
      applyTurnState(S.running);
      hydrate(b.messages, S.running);
      if (b.draft) els.input.value = b.draft;
    }
  } catch (err) {
    pushItem({ kind: 'error', text: '无法连接主进程：' + ((err && err.message) || err) });
  }
  S.ready = true;
  autoGrow();
  paint();
  setTimeout(() => { try { els.input.focus(); } catch { /* ignore */ } }, 60);
})();
