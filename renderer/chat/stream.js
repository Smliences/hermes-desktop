'use strict';
/* ---------- 渲染：聊天流 / 轨迹 ---------- */
/* ---------- 新会话落地页：时段问候 + 快捷开始 ----------
   四个 chip 全部是已接线的真实入口；「看看指令」把输入框填成 / 直接拉起
   内联指令菜单，与 placeholder 的承诺一一对应。事件走 #landing 委托。 */
const LANDING_ACTIONS = {
  slash: () => {
    const inp = $('#input');
    inp.value = '/'; autoGrow(); updateCount();
    inp.focus();
    slashSync();
  },
  kanban: () => showKanban(true),
  model: () => openModelPicker(),
  project: () => kbProjectDialog('create'),
};
function landingGreet() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了，想做点什么？';
  if (h < 12) return '早上好，今天想做点什么？';
  if (h < 14) return '中午好，想做点什么？';
  if (h < 18) return '下午好，想做点什么？';
  return '晚上好，想做点什么？';
}
function renderLanding() {
  $('#landing').innerHTML = `
    <div class="landing-inner">
      <div class="landing-greet">${esc(landingGreet())}</div>
      <div class="landing-chips" role="toolbar" aria-label="快捷开始">
        <button class="landing-chip" data-landing="slash">/ 看看指令</button>
        <button class="landing-chip" data-landing="kanban">打开看板</button>
        <button class="landing-chip" data-landing="model">切换模型</button>
        <button class="landing-chip" data-landing="project">新建项目会话</button>
      </div>
    </div>`;
}
$('#landing').addEventListener('click', (e) => {
  const chip = e.target.closest && e.target.closest('[data-landing]');
  if (!chip) return;
  const fn = LANDING_ACTIONS[chip.dataset.landing];
  if (fn) fn();
});

let traceFilter = 'all';
function renderChat() {
  const tab = activeTab(); const chat = $('#chat');
  if (!tab) { chat.innerHTML = ''; return; }
  if (tab._rafText) { cancelAnimationFrame(tab._rafText); tab._rafText = 0; }
  const isTrace = state.view === 'trace';
  const traceItems = isTrace ? tab.items.filter((i) => ['user', 'thinking', 'tool', 'approval', 'command', 'error'].includes(i.kind)) : tab.items;
  const hasTraceSteps = isTrace && traceItems.some((i) => ['thinking', 'tool', 'approval', 'command', 'error'].includes(i.kind));
  const items = (isTrace && traceFilter !== 'all')
    ? traceItems.filter((i) => i.kind === traceFilter || (traceFilter === 'error' && i.kind === 'tool' && i.isError))
    : traceItems;
  const showHeads = !isTrace;
  chat.innerHTML = '';
  if (isTrace && hasTraceSteps) {
    const counts = {
      all: traceItems.filter((i) => i.kind !== 'user').length,
      tool: traceItems.filter((i) => i.kind === 'tool').length,
      error: traceItems.filter((i) => i.kind === 'error' || (i.kind === 'tool' && i.isError)).length,
      approval: traceItems.filter((i) => i.kind === 'approval').length,
    };
    const bar = document.createElement('div');
    bar.className = 'trace-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '轨迹筛选');
    const defs = [['all', '全部'], ['tool', '工具'], ['error', '错误'], ['approval', '审批']];
    bar.innerHTML = defs.map(([k, lbl]) =>
      `<button type="button" class="trace-pill${traceFilter === k ? ' active' : ''}" data-tf="${k}">${lbl} <span>${counts[k]}</span></button>`
    ).join('');
    bar.onclick = (e) => {
      const b = e.target.closest && e.target.closest('[data-tf]');
      if (!b) return;
      traceFilter = b.dataset.tf;
      renderChat();
    };
    chat.appendChild(bar);
  }
  if (isTrace && !hasTraceSteps) {
    const empty = document.createElement('div');
    empty.className = 'trace-empty';
    empty.innerHTML = '<div class="te-title">当前会话暂无工具调用或斜杠记录</div><div class="te-sub">当 Agent 调用工具、执行命令或触发审批时，这里会按提问轮次展示完整轨迹。</div><button type="button" class="btn" id="trace-back-chat">回到对话</button>';
    chat.appendChild(empty);
    const backBtn = empty.querySelector('#trace-back-chat');
    if (backBtn) backBtn.onclick = () => {
      state.view = 'chat';
      document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
      renderChat();
    };
    $('#landing').hidden = true;
    $('#main').classList.remove('empty');
    const findBtn = $('#btn-find');
    if (findBtn) findBtn.hidden = true;
    syncComposerState();
    return;
  }
  // WB 式结构：每轮响应块（紧随用户消息）仅首个元素带「头像+名字」头，其余流式内容顶格
  const turnHeadEl = () => {
    const d = document.createElement('div');
    d.className = 'turn-head';
    d.innerHTML = `<img class="turn-avatar" src="assets/hermes-logo.png" alt="" /><span class="turn-name">Hermes</span>`;
    return d;
  };
  let prevKind = null;
  // 每条 assistant 的脚注先攒着，等这一轮（下一条 user 消息之前）结束再统一挂一次：
  // 位置代表「这一整轮回复」，所以文本和 token 都按整轮累加，复制拿到的也是完整回复。
  let tail = null;      // 本轮最后追加的节点，脚注挂在它后面
  let acc = null;       // { text: [], tokens, ts, turnMs, tps }
  const flushTurnFoot = () => {
    if (acc) {
      const merged = {
        kind: 'assistant',
        text: acc.text.join('\n\n'),
        tokens: acc.real ? acc.tokens : 0,
        ts: acc.ts,
        turnMs: acc.turnMs,
        tps: acc.tps,
      };
      const tpl = document.createElement('div');
      tpl.innerHTML = msgActionBar(merged, false);
      const foot = tpl.firstElementChild;
      if (foot) {
        foot._item = merged;
        if (tail && tail.parentNode) tail.after(foot);
        else chat.appendChild(foot);
      }
    }
    acc = null;
    tail = null;
  };
  for (let i = 0; i < items.length; ) {
    const it = items[i];
    if (it.kind === 'tool') {
      const wrap = document.createElement('div');
      wrap.className = 'tool-stream';
      if (showHeads && prevKind === 'user') wrap.appendChild(turnHeadEl());
      // 连续 ≥2 次调用才收成「执行 N 步」的父行（单次不加一层壳）；
      // 轨迹视图是逐条排查用的，保持平铺，不做折叠。
      const run = [];
      while (i < items.length && items[i].kind === 'tool') { run.push(items[i]); i++; }
      if (run.length > 1 && state.view !== 'trace') wrap.appendChild(stepGroupEl(run));
      else for (const t of run) wrap.appendChild(renderItem(t));
      chat.appendChild(wrap);
      tail = wrap;
      prevKind = 'tool';
    } else {
      if (it.kind === 'user') flushTurnFoot();
      const head = showHeads && it.kind === 'assistant' && prevKind === 'user';
      const el = renderItem(it, head);
      chat.appendChild(el);
      if (it.kind === 'assistant') {
        acc = acc || { text: [], tokens: 0, real: true, ts: 0, turnMs: 0, tps: 0 };
        if (it.text) acc.text.push(it.text);
        // 整轮 token 只在每条都是真实值时才相加；有一条是估算就整轮交给 msgTokens 估，
        // 免得把「估的数」显示成「真实用量」。
        if (it.tokens > 0) acc.tokens += it.tokens; else acc.real = false;
        if (it.ts) acc.ts = it.ts;
        if (it.turnMs) acc.turnMs = it.turnMs;
        if (it.tps) acc.tps = it.tps;
      }
      tail = el;
      prevKind = it.kind; i++;
    }
  }
  if (!tab.running) flushTurnFoot();
  if (tab.running && tab.showTyping) {
    chat.appendChild(typingIndicator(tab, showHeads && prevKind === 'user'));
  }
  const hasContent = tab.items.some((i) => i.kind !== 'landing');
  // 用 hidden 属性而非 style.display：全局 [hidden]{display:none!important} 会让
  // style.display='' 永远无法让 landing 显示出来。
  $('#landing').hidden = hasContent || state.view === 'trace';
  if (!$('#landing').hidden) renderLanding();
  // 空会话：问候 + 输入框作为一组垂直居中（#main.empty 布局）
  $('#main').classList.toggle('empty', !hasContent && state.view !== 'trace');
  // 查找入口只在有内容时出现（轨迹/空态没有可查找文本）
  const findBtn = $('#btn-find');
  if (findBtn) findBtn.hidden = !hasContent || state.view === 'trace';
  syncComposerState();
  syncCodeScrollHints();
  scrollBottom();
  publishOrbContext();
}

/* ---------- 迷你聊天窗的上下文同步 ----------
   小窗读不到主窗口的 DOM，但它必须绑定「同一个会话」：这里按 300ms 节流把
   tabId / 标题 / 模型 / 主题 / 最近十几条纯文本推给主进程缓存。
   只走内存，不落盘、不进日志（消息正文不该留在日志里）。 */
let orbCtxTimer = null;
function publishOrbContext() {
  if (!hasNative || typeof api.orbContext !== 'function') return;
  if (orbCtxTimer) return;
  orbCtxTimer = setTimeout(() => {
    orbCtxTimer = null;
    const tab = activeTab();
    if (!tab) return;
    const messages = tab.items
      .filter((i) => (i.kind === 'user' || i.kind === 'assistant') && i.text)
      .slice(-14)
      .map((i) => ({
        role: i.kind === 'user' ? 'user' : 'assistant',
        text: String(i.text).slice(0, 4000),
        done: i.done !== false,
      }));
    try {
      api.orbContext({
        tabId: tab.id,
        sessionId: tab.sessionId || null,
        title: tab.title || '新会话',
        model: tab.model || (state.config && state.config.model) || '',
        cwd: tab.cwd || undefined,
        theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
        fontSize: typeof SettingsStore !== 'undefined' ? SettingsStore.get('fontSize', 16) : 16,
        messages,
      });
    } catch { /* 退出中：主进程已不可达 */ }
  }, 300);
}
/** macOS 隐藏式滚动条会让长代码行看起来像被截断；仅在实际超宽时给头部一个明确提示。 */
function syncCodeScrollHints() {
  for (const box of document.querySelectorAll('.md-code')) {
    const pre = box.querySelector('pre');
    if (pre) box.classList.toggle('scroll-x', pre.scrollWidth > pre.clientWidth + 4);
  }
}
/** 每条消息 hover 出现的操作条：复制 / 重试 / 本回合用量 / 绝对时间。
    dsh 用图标而非文字按钮（点赞/倒赞按用户 2026-11-11 要求不做）。 */
const MSG_ICO_COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor"></rect><path d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z" fill="currentColor" stroke="none"></path></svg>';
const MSG_ICO_RETRY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><path d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1" stroke="currentColor"></path><path d="M14.4999 1.5V5.1H10.8999" stroke="currentColor"></path></svg>';
/* 用量图标：dsh 用的是「三层数据库圆柱」——顶椭圆 + 两条等距分隔弧 + 圆弧底，
   宽高比 12:14（dsh 实测 13.3×15 css，≈0.89）。早先是两层 + 更瘦的 rx，视觉上明显不像。 */
/* 用量图标：dsh 的 database-outline 原样（顶椭圆 + 左右直边 + 两条等距弧），
   之前是自己凑的三层圆柱，弧长和椭圆曲率都对不上。 */
const MSG_ICO_DB = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><path d="M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z" stroke="currentColor"></path><path d="M2 3.80371V11.7848" stroke="currentColor"></path><path d="M14 3.80371V11.7848" stroke="currentColor"></path><path d="M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396" stroke="currentColor"></path><path d="M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847" stroke="currentColor"></path></svg>';
/** 状态条（底部用量带）的格子：图标也用 dsh 原版字形，不再用 ▤ / ↻ 字符。
    字符在不同系统字体里宽高不一致，会和右侧数字基线错位；SVG 定 13px 才稳。
    空内容必须清成空串，否则 `.st-metrics > :empty{display:none}` 失效会留白。 */
function setStCell(sel, svg, text) {
  const el = $(sel); if (!el) return;
  el.innerHTML = text ? `<span class="st-ico" aria-hidden="true">${svg}</span><span class="st-txt"></span>` : '';
  if (text) el.lastElementChild.textContent = text;
}
/** 耗时文案：dsh 是「用时 33 秒」整秒口径，短回合才给一位小数「8.8 秒」 */
function fmtDur(ms) {
  const s = ms / 1000;
  return s >= 10 ? String(Math.round(s)) : s.toFixed(1);
}
/** 这条消息的 token 数：优先真实值（实时回合由会话累计差算出）；
    历史消息 CLI 不写 messages.token_count（实测整列为 NULL），只能按字符估算并标 ≈。 */
function msgTokens(item) {
  if (item.tokens > 0) return { n: item.tokens, est: false };
  const txt = item.text || item.output || '';
  if (!txt) return null;
  // 中英分开算：汉字约 1.3 字 / token，其余约 3.8 字符 / token
  const cjk = (txt.match(/[\u4e00-\u9fff]/g) || []).length;
  const rest = txt.length - cjk;
  return { n: Math.max(1, Math.round(cjk / 1.3 + rest / 3.8)), est: true };
}
/** 消息底部信息行（dsh 版式）：`[图标组] ▤ N tok  HH:MM`，整行常显。
    dsh 实测（2x 截图逐列量）：图标在最左、glyph 左缘与正文左缘对齐，
    用量居中、绝对时间压最右；用户消息整行改用 row-reverse 靠右
    （dsh 的用户脚注是 `12:33 [复制]`，图标贴气泡右缘）。
    **用户自己说的话不显示 token 用量**（2026-11-11 要求），只有助手回合才有。 */
function msgActionBar(item, canRetry) {
  const t = item.kind === 'user' ? null : msgTokens(item);
  const usage = t
    ? `<span class="msg-usage" title="${t.est ? '按字符估算（CLI 未记录本条 token）' : '本回合真实用量'} · ${fmtTokens(t.n)} token">` +
      `<span class="mu-ico" aria-hidden="true">${MSG_ICO_DB}</span>${fmtTokens(t.n)} tok</span>`
    : '';
  return `<div class="msg-foot-row">
    <span class="msg-actions" role="group" aria-label="消息操作">
      <button type="button" class="msg-act" data-msg-act="copy" title="复制这条消息" aria-label="复制">${MSG_ICO_COPY}</button>
      ${canRetry ? `<button type="button" class="msg-act" data-msg-act="retry" title="用这条提问重新发起一轮" aria-label="重试">${MSG_ICO_RETRY}</button>` : ''}
      <button type="button" class="msg-act" data-msg-act="to-task" title="转为看板任务" aria-label="转为看板任务">⊞</button>
    </span>
    ${usage}
    ${item.ts ? `<time class="msg-ts" title="发送于 ${esc(fmtTime(item.ts))}">${esc(fmtTime(item.ts).slice(0, 5))}</time>` : ''}
  </div>`;
}
/** 连续调用的父行：WB 的 task-compact 树形头部 —— 一行说清「跑了几步、都是些什么」，
    点开才铺开缩进的子项，子项自己仍能展开看详情（那就是第三层）。
    WB 的多级本来就来自 Task 子代理（父 = 子代理、子 = 它内部调用的工具），
    但 CLI 的 tool.start / tool.complete 是扁平事件、没有 parent 字段，
    所以层级建在「一轮里的连续调用」上，视觉与交互沿用它的那一套。
    默认展开条件：跑着或有失败（否则看不到进度），全部成功就收成一行。 */
const STEP_ICO = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.4 4.2h3.2M2.4 8h3.2M2.4 11.8h3.2"></path><path d="M8.6 4.2h5M8.6 8h5M8.6 11.8h5"></path></svg>';
/** 父行摘要用的短类型词（两个汉字），跟行上的三态词是两套：后者带时态不能拼句 */
const STEP_BRIEF = {
  read: '读取', write: '编辑', create: '写入', cmd: '运行', search: '搜索',
  list: '列举', web: '网页', gen: '生成', dispatch: '派发', todo: '计划',
  memory: '记忆', ask: '提问', unknown: '调用',
};
function stepGroupEl(list) {
  const wrap = document.createElement('div');
  const running = list.some((t) => t.state === 'running');
  const failed = list.some((t) => t.isError);
  const state = running ? 'running' : failed ? 'error' : 'done';
  wrap.className = `step-group ${state}`;
  let open = list[0].groupOpen;
  if (typeof open !== 'boolean') open = running || failed;

  // 摘要 = 各步动作去重（读取、编辑、运行），最多三个。
  // 用类型词而不是三态词：「已读取」这类带时态的词拼成一句话读不通，也太长。
  const verbs = [];
  let errCount = 0;
  let totalMs = 0;
  for (const t of list) {
    const v = STEP_BRIEF[toolMeta(t.name, t.input, 'done').kind] || '调用';
    if (!verbs.includes(v)) verbs.push(v);
    if (t.isError) errCount++;
    if (t.durationMs > 0) totalMs += t.durationMs;
  }
  const brief = verbs.slice(0, 3).join('、') + (verbs.length > 3 ? '等' : '');
  const headText = `${running ? '正在执行' : '执行了'} ${list.length} 步`;
  const groupMeta = errCount > 0
    ? `<span class="tmeta"><i class="td">${errCount} 失败</i></span>`
    : (!running && totalMs >= 100 ? `<span class="tmeta">${(totalMs / 1000).toFixed(1)}s</span>` : '');

  wrap.innerHTML = `<div class="step-head ${state}" role="button" tabindex="0" aria-expanded="${open}" title="${esc(list.map((t) => t.name).join(' · '))}">
      <span class="ticon" aria-hidden="true">${STEP_ICO}</span>
      <span class="tstate${running ? ' loading-text' : ''}">${headText}</span>
      <span class="tobj">${esc(brief)}</span>
      ${groupMeta}
      <span class="tchev" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6.5 4 4 4-4"></path></svg></span>
    </div>`;
  const body = document.createElement('div');
  body.className = 'step-body' + (open ? '' : ' hidden');
  for (const t of list) body.appendChild(renderItem(t, false, true));
  wrap.appendChild(body);
  wrap.classList.toggle('open', open);

  const head = wrap.querySelector('.step-head');
  const toggle = () => {
    open = !open;
    list[0].groupOpen = open; // 记住用户的选择，重绘不丢
    wrap.classList.toggle('open', open);
    body.classList.toggle('hidden', !open);
    head.setAttribute('aria-expanded', String(open));
  };
  head.onclick = toggle;
  head.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  };
  return wrap;
}
function renderItem(item, header = false, sub = false) {
  const el = document.createElement('div');
  if (item.kind === 'user') {
    el.className = 'msg msg-user';
    const files = Array.isArray(item.files) && item.files.length
      ? `<div class="bubble-files">${item.files.map((f) => `<span class="bf-item">${esc(f)}</span>`).join('')}</div>`
      : '';
    el.innerHTML = `<div class="bubble">${esc(item.text)}${files}</div><div class="avatar">你</div>${msgActionBar(item, true)}`;
  } else if (item.kind === 'assistant') {
    el.className = 'msg msg-assistant';
    const cursor = item.done ? '' : '<span class="cursor"></span>';
    // 助手消息不带头像/名字头，正文顶格；「已完成，用时 N 秒 · ⌁ x tok/s」压在正文上方，
    // 下面跟一条整列发丝横线（用户 2026-11-11 先要求挪到底部、随即改回上方，以此为准）。
    const meta = item.done
      ? `<div class="turn-meta">已完成${item.turnMs >= 500 ? `，用时 ${fmtDur(item.turnMs)} 秒` : ''}${item.tps ? ` · ⌁ ${item.tps.toFixed(1)} tok/s` : ''}</div>`
      : '';
    el.innerHTML = `${meta}<div class="content md">${renderMarkdown(item.text)}${cursor}</div>`;
    // 脚注（N tok / 时间 / 复制）不挂在正文下面：一轮里正文之后还跟着工具调用，
    // 挂在中间正好把「正文 → 步骤」切开（用户 2026-11-14 要求挪到结束）。
    // 交给 renderChat 收到整轮末尾再挂，并按整轮合并文本与用量。
    el._footHTML = msgActionBar(item, false);
  } else if (item.kind === 'tool') {
    /* WorkBuddy 的 single-line-tool-header：图标 · 状态词 · 对象 · 次要信息 · 箭头。
       状态词随三态换（读取 / 已读取 / 读取失败），运行中走渐变扫光而不是转圈；
       折叠只切 .card-content 的 hidden，行本身不动画。 */
    const running = item.state === 'running';
    const state = running ? 'running' : item.isError ? 'error' : 'done';
    /* 自动展开只给「跑着的或失败的」：跑着要能看到在干什么，失败要能直接读到错因；
       成功的立刻收成一行，不占版面。item.open 只在用户点过之后才有值，那之后就听用户的。 */
    let open = typeof item.open === 'boolean' ? item.open : (running || !!item.isError);
    el.className = 'tool-item' + (sub ? ' sub' : '') + (open ? ' open' : '');
    const meta = toolMeta(item.name, item.input, state);
    const dur = item.durationMs ? (item.durationMs / 1000).toFixed(1) + 's' : '';
    const extra = meta.extra
      ? `<span class="tmeta">${meta.extra.text ? esc(meta.extra.text)
        : `<i class="ta">+${meta.extra.add}</i><i class="td">−${meta.extra.del}</i>`}</span>`
      : (!running && dur ? `<span class="tmeta tmeta-dur">${esc(dur)}</span>` : '');
    // 详情可能是空串（跑着的命令还没有输出）：那时只留详情头，不塞「暂无」占位
    const detailHTML = toolDetailHTML(item);
    const inp = item.input && typeof item.input === 'object' ? item.input : null;
    const directPath = inp && (inp.file_path || inp.path || inp.target_file || inp.filename);
    const pvPath = (typeof directPath === 'string' && extractPreviewPaths(directPath)[0])
      || extractPreviewPaths(JSON.stringify(item.input || {})).pop() || '';
    const pvBtn = pvPath
      ? `<button class="tdh-pv-btn" type="button" data-pv-open="${esc(pvPath)}" title="在右侧预览此文件">在右侧预览</button>`
      : '';
    el.innerHTML = `<div class="tool-row collapsible ${state}" role="button" tabindex="0" aria-expanded="${open}" title="${esc(item.name || '')}">
        <span class="ticon" aria-hidden="true">${meta.icon}</span>
        <span class="tstate${running ? ' loading-text' : ''}">${esc(meta.label)}</span>
        ${meta.obj ? `<span class="tobj">${esc(meta.obj)}</span>` : ''}
        ${extra}
        <span class="tchev" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6.5 4 4 4-4"></path></svg></span></div>
      <div class="tool-detail card-content${open ? '' : ' hidden'}">
        <div class="tool-detail-head">
          <span class="tdh-name">${esc(item.name || '工具')}</span>
          ${pvBtn}
          <span class="tdh-state ${state}">${running ? '执行中' : item.isError ? '失败' : '完成'}${dur ? ' · ' + dur : ''}</span>
        </div>
        ${detailHTML || (running ? '' : '<div class="detail-section"><div class="detail-label">详情</div><pre class="detail-content">暂无</pre></div>')}
      </div>`;
    // 局部切 class 而不是整页 renderChat：详情是静态 HTML，不需要重绘；
    // 更重要的是键盘展开时焦点能留在这条工具行上。
    const row = el.querySelector('.tool-row');
    const body = el.querySelector('.card-content');
    const toggle = () => {
      open = !open;
      item.open = open;       // 点过就固化成用户的选择，之后不再被状态派生改写
      item.userToggled = true;
      el.classList.toggle('open', open);
      body.classList.toggle('hidden', !open);
      row.setAttribute('aria-expanded', String(open));
    };
    row.onclick = toggle;
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    };
  } else if (item.kind === 'error') {
    el.className = 'msg msg-error';
    el.innerHTML = item.failure
      ? failureHTML(item.failure) + msgActionBar(item, false)
      : `<div class="error-card"><span class="e-dot"></span>
      <div class="e-body"><div class="e-title">本轮运行失败</div>
      <div class="e-desc">${esc(clip(item.text, 4000))}</div></div>
      <span class="e-badge">${esc(item.code || errorCodeOf(item.text))}</span></div>${msgActionBar(item, false)}`;
  } else if (item.kind === 'thinking') {
    // Claude 式思考轨道：默认折叠，点击展开；不与正文混排
    el.className = 'msg msg-thinking';
    el.innerHTML = `<details class="think-box"${item.open ? ' open' : ''}>
      <summary>⌁ 思考过程 <span class="think-len">${(item.text || '').length} 字</span></summary>
      <div class="think-body">${esc(clip(item.text, 12000))}</div></details>`;
    const d = el.querySelector('details');
    if (d) d.addEventListener('toggle', () => { item.open = d.open; });
  } else if (item.kind === 'command') {
    // 命令卡片：CLI 斜杠命令的结果。等宽输出 + 顶部命令行，和 agent 正文分开，
    // 一眼能看出「这是我敲的命令，不是模型说的话」。
    el.className = 'msg msg-command';
    const running = item.state === 'running';
    const cls = running ? 'is-running' : item.state === 'error' ? 'is-error' : 'is-done';
    const stateText = running ? '执行中…' : item.state === 'error' ? '不可用' : '完成';
    el.innerHTML = `<div class="cmd-card ${cls}">
      <div class="cmd-head"><span class="cmd-line">${esc(item.cmd)}</span>
        <span class="cmd-state">${stateText}</span></div>
      ${item.text ? `<pre class="cmd-out">${esc(clip(item.text, 20000))}</pre>` : ''}
    </div>${item.text ? msgActionBar(item, false) : ''}`;
  } else if (item.kind === 'approval') {
    el.className = 'msg msg-approval';
    const actions = item.choice
      ? `<span class="ap-done ${item.choice === 'deny' ? 'no' : 'yes'}">${item.choice === 'deny' ? '已拒绝' : '已允许'}</span>`
      : `<button type="button" class="ap-btn ap-allow" data-ap="approve">允许</button>
         <button type="button" class="ap-btn ap-always" data-ap="always">始终允许</button>
         <button type="button" class="ap-btn ap-deny" data-ap="deny">拒绝</button>`;
    el.innerHTML = `<div class="approval-card">
      <div class="ap-head"><span class="ap-dot"></span><b>需要确认危险操作</b></div>
      <div class="ap-tool">${esc(item.tool || '工具调用')}${item.risk ? ` · ${esc(item.risk)}` : ''}</div>
      ${item.command ? `<pre class="ap-cmd">${esc(clip(item.command, 2000))}</pre>` : ''}
      <div class="ap-actions">${actions}</div></div>`;
  }
  el._item = item; // 事件委托据此取回数据，避免用易失效的数组下标
  return el;
}
/** 同步「↓ 回到底部」悬浮胶囊显隐与运行态脉冲圆点。 */
function syncScrollBottomBtn() {
  const btn = $('#scroll-bottom-btn');
  const sc = $('#chat-scroll');
  if (!btn || !sc) return;
  const show = !!sc._userScrolledAway && sc.scrollHeight > sc.clientHeight + 24;
  btn.hidden = !show;
  const tab = activeTab();
  btn.classList.toggle('is-running', !!(tab && tab.running));
}
{
  const sc = $('#chat-scroll');
  if (sc) {
    sc.addEventListener('scroll', () => {
      const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 48;
      sc._userScrolledAway = !atBottom;
      syncScrollBottomBtn();
    }, { passive: true });
  }
  const sbb = $('#scroll-bottom-btn');
  if (sbb) sbb.addEventListener('click', () => scrollBottom(true));
}
/** 只在用户本来就贴着底部时自动跟随；查看历史时保留当前锚点。 */
function scrollBottom(force = false) {
  const sc = $('#chat-scroll');
  if (!sc) return;
  if (!force && sc._userScrolledAway) { syncScrollBottomBtn(); return; }
  sc._userScrolledAway = false;
  sc.scrollTop = sc.scrollHeight;
  syncScrollBottomBtn();
}
/** 「响应中」指示器：WB 式纯状态行（本轮首个块带轮次头） */
function typingIndicator(tab, header = false) {
  const el = document.createElement('div');
  el.className = 'msg typing-msg';
  const head = header ? `<div class="turn-head"><img class="turn-avatar" src="assets/hermes-logo.png" alt="" /><span class="turn-name">Hermes</span></div>` : '';
  el.innerHTML = `${head}<div class="status-line"><span class="spin">◠</span>
    <span class="t-status">${esc(tab.activity || '思考中…')}</span><span class="t-elapsed"></span></div>`;
  return el;
}
/** 底部活动条显示/隐藏 */
function syncActivityBar() {
  const tab = activeTab();
  const el = $('#activity');
  if (el) el.hidden = !(tab && tab.running);
}
// 指示器计时（响应已用时）
setInterval(() => {
  const tab = activeTab();
  if (!tab || !tab.running || !tab.startedAt) return;
  const el = document.querySelector('.typing-msg .t-elapsed');
  if (el) el.textContent = Math.round((Date.now() - tab.startedAt) / 1000) + 's';
}, 500);

/* ---------- 思考轨（reasoning）辅助 ---------- */
/** 设置页「流式思考」是唯一开关：关掉就不再画推理块（上游可能照样在下发）。 */
function streamThinkOn() {
  try { return SettingsStore.get('streamThink', true) !== false; } catch { return true; }
}
/** 本回合的推理块：跨过本轮的 user 消息就新建，别把上一轮的思考接着往下写。 */
function reasoningItemOf(tab) {
  for (let i = tab.items.length - 1; i >= 0; i--) {
    const it = tab.items[i];
    if (it.kind === 'thinking') return it;
    if (it.kind === 'user') return null;
  }
  return null;
}
/** 推理块插在本轮 user 之后、工具与正文之前：后端可能先发正文，再补完整推理快照。 */
function turnInsertIndex(tab) {
  for (let i = tab.items.length - 1; i >= 0; i--) if (tab.items[i].kind === 'user') return i + 1;
  return tab.items.length;
}
/** 按数据项找 DOM 节点（renderItem 给每个节点挂了 _item），比按 className 猜更可靠。 */
function reasoningNode(item) {
  const chat = $('#chat');
  if (!chat) return null;
  for (const n of chat.children) if (n._item === item) return n;
  return null;
}
/**
 * 只把「说明过的 provider 等待」当状态文案（与官方桌面版 store/provider-wait.ts 同款白名单）：
 * `⏳ loading … / ⚙ processing prompt / ⚠ rate limited …`。颜文字 spinner 一律丢弃，
 * 它们只是活动指示，不是能被展示的思考内容。
 */
const RE_PROVIDER_WAIT = /^(?:⏳|⚠|↻|⚙)\s*(?:(?:still\s+)?waiting on|loading|processing prompt|no (?:output|response)|model returned|rate limited|provider (?:overloaded|temporarily unavailable))/i;
function providerWaitText(text) {
  const v = String(text == null ? '' : text).trim();
  return RE_PROVIDER_WAIT.test(v) ? v : '';
}

/* ---------- 事件处理（stream-json 协议） ---------- */
function routeEvent(evt, explicitTabId) {
  if (!evt) return;
  // 已停止的回合：延迟到达的事件一律丢弃，不再冒出内容
  if (evt.turnId && state.invalidTurns.has(evt.turnId)) return;
  // 主进程已经在 hermes:event 里带了 tabId，优先用它；turnTab 只作 demo 通道兜底。
  // 绝不回落到 activeTabId —— 那会把后台页签的流式内容串到当前页签。
  const tabId = explicitTabId || (evt.turnId ? state.turnTab.get(evt.turnId) : null);
  const tab = state.tabs.find((t) => t.id === tabId); if (!tab) return;
  // 数据模型始终更新；但只有当前可见页签能改 DOM / 全局状态条。
  // 否则后台页签的流式内容会替换掉用户正在看的那条消息，或把状态条误置为「空闲」。
  const visible = tab.id === state.activeTabId;
  if (evt.type === 'notice') {
    // 附件附加失败等非致命提示：只提示，不打断回合、不生成错误卡
    if (visible) { toast(evt.text || '提示', 3600); a11y(evt.text || '提示'); }
    return;
  }
  if (evt.type === 'system' && evt.subtype === 'init') {
    if (evt.session_id && !tab.sessionId) { tab.sessionId = evt.session_id; refreshSessions($('#session-search').value.trim()); }
    if (evt.model) { tab.model = evt.model; updateStatus(); }
  } else if (evt.type === 'text') {
    let last = tab.items[tab.items.length - 1];
    if (!last || last.kind !== 'assistant' || last.done) {
      last = { kind: 'assistant', text: '', done: false, ts: Date.now() };
      tab.items.push(last);
    }
    last.text += evt.text;
    tab.deltas += 1;
    tab.showTyping = false; tab.activity = '生成中…';
    if (visible && state.view === 'chat') {
      if (!tab._rafText) {
        tab._rafText = requestAnimationFrame(() => {
          tab._rafText = 0;
          if (tab.id !== state.activeTabId || state.view !== 'chat') return;
          const chat = $('#chat');
          chat.querySelector('.typing-msg')?.remove();
          const curLast = [...tab.items].reverse().find((i) => i.kind === 'assistant');
          if (!curLast) return;
          const node = renderItem(curLast);
          const existing = [...chat.children].reverse().find((n) => n._item === curLast && n.classList.contains('msg-assistant'));
          if (existing) chat.replaceChild(node, existing);
          else chat.appendChild(node);
          scrollBottom();
        });
      }
    }
    if (visible) liveActivity(tab);
  } else if (evt.type === 'thinking_wait') {
    // v0.23.0 的 thinking.delta 是「等待提示」（颜文字 spinner / provider 等待），不是推理。
    // 它只喂底部状态行；颜文字那类连状态行都不进，避免把占位文案伪装成思考内容。
    const wait = providerWaitText(evt.text);
    if (wait) {
      tab.activity = wait;
      if (visible && state.view === 'chat') {
        setActivity(wait);
        const el = document.querySelector('#chat .typing-msg .t-status');
        if (el) el.textContent = wait;
      }
    }
  } else if (evt.type === 'thinking') {
    // 只认真·推理（reasoning.delta / reasoning.available / message.complete.reasoning）。
    // 设置里关掉「流式思考」就整块不显示，不做「半截空壳」。
    if (!streamThinkOn()) return;
    let item = reasoningItemOf(tab);
    if (!item) {
      item = { kind: 'thinking', text: '', open: false, ts: Date.now() };
      tab.items.splice(turnInsertIndex(tab), 0, item);   // 后端可能先发正文再补快照，插在本轮开头
    }
    if (evt.final) item.text = evt.text; else item.text += evt.text;
    if (visible && state.view === 'chat') {
      const node = reasoningNode(item);
      const body = node && node.querySelector('.think-body');
      const len = node && node.querySelector('.think-len');
      if (body && len) { body.textContent = clip(item.text, 12000); len.textContent = item.text.length + ' 字'; }
      else renderChat();
    }
  } else if (evt.type === 'tool_use') {
    if (tab._rafText) { cancelAnimationFrame(tab._rafText); tab._rafText = 0; }
    const last = tab.items[tab.items.length - 1];
    if (last && last.kind === 'assistant') last.done = true;
    // 状态行也用人话（「读取 app.js」「执行中… npm test」），比「执行 bash…」好认
    const tm = toolMeta(evt.name, evt.input, 'running');
    const label = tm.obj ? `${tm.label} ${tm.obj}` : tm.label;
    // 不给 open：展开与否交给渲染层按状态派生（跑着 / 失败才自动展开，成功收起），
    // 用户点过之后 item.open 才写成布尔值，此后以用户的选择为准。
    tab.items.push({ kind: 'tool', name: evt.name, toolCallId: evt.tool_call_id || '', input: evt.input || null, state: 'running', ts: Date.now() });
    tab.showTyping = true; tab.activity = label;
    if (visible) { renderChat(); setActivity(label); syncActivityBar(); }
    // 自动跟随只在工具跑完之后做：此刻文件还没写出来，先 resolve 只会拿到旧内容或失败。
  } else if (evt.type === 'tool_result') {
    const item = (evt.tool_call_id
      ? [...tab.items].reverse().find((i) => i.kind === 'tool' && i.toolCallId === evt.tool_call_id && i.state === 'running')
      : null)
      || [...tab.items].reverse().find((i) => i.kind === 'tool' && i.name === evt.name && i.state === 'running');
    if (item) {
      item.output = evt.output ?? ''; item.isError = !!evt.is_error;
      item.durationMs = evt.duration_ms || 0; item.state = 'done'; item.done = true;
      tab.showTyping = true; tab.activity = '生成中…';
      if (visible) renderChat();
      if (visible) maybeAutoPreview({
        name: item.name, input: item.input, output: evt.output,
        preview: evt.preview, isError: !!evt.is_error,
      }).catch(() => {});
    }
  } else if (evt.type === 'usage') {
    // 后端 session.usage（回合中按间隔推送 / resume 初值）：token、tps、上下文占用
    tab.usage = evt.usage || null;
    updateStatus();
  } else if (evt.type === 'result') {
    if (tab._rafText) { cancelAnimationFrame(tab._rafText); tab._rafText = 0; }
    tab.lastResult = evt;
    if (evt.tokens) tab.usage = evt.tokens;
    const last = tab.items[tab.items.length - 1];
    if (last && last.kind === 'assistant') {
      last.done = true;
      last.turnMs = Date.now() - (tab.startedAt || Date.now());
      last.tps = (tab.usage && tab.usage.tps) || 0;
      // 会话累计值的差 = 本回合消耗（后端只给累计口径，没有单回合字段）
      const base = tab.usageBase || 0;
      const nowTotal = (tab.usage && tab.usage.total) || 0;
      last.tokens = nowTotal > base ? nowTotal - base : 0;
      // gateway 的 result 不带 duration_ms，用本回合实测耗时补上（状态条/脚注共用）
      if (!evt.duration_ms) evt.duration_ms = last.turnMs;
      // result.text 是全量回复：仅当本轮没有任何 text delta 时才用它兜底，避免与已渲染的流式文本重复
      if (tab.deltas === 0) last.text = evt.text || last.text;
    } else if (evt.text && tab.deltas === 0) tab.items.push({ kind: 'assistant', text: evt.text, done: true });
    for (const i of tab.items) if (i.kind === 'tool' && i.state === 'running') { i.state = 'done'; i.isError = true; i.output = i.output || '（回合结束，无结果回传）'; }
    tab.running = false; tab.showTyping = false;
    if (!visible) tab.unread = true;
    applyAutoCollapse(tab);
    if (evt.exit_code !== 0 && evt.error) {
      const f = parseFailure('', String(evt.error));
      tab.items.push({ kind: 'error', text: f.error, failure: f });
    }
    renderTabs(); // 页签上的 running 指示对后台页签也要刷新
    if (typeof renderSessions === 'function') renderSessions();
    if (visible) { renderChat(); updateStatus(); setActivity('空闲'); syncActivityBar(); }
    if (evt.turnId) state.turnTab.delete(evt.turnId);
  }
}
function liveActivity(tab) {
  const running = tab.items.filter((i) => i.kind === 'assistant' && !i.done);
  if (running.length) {
    const chars = running.reduce((n, i) => n + i.text.length, 0);
    const secs = Math.max(0.5, (Date.now() - tab.startedAt) / 1000);
    $('#st-tps').textContent = `· ${(chars / 4 / secs).toFixed(1)} tok/s`;
  }
}
