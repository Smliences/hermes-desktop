'use strict';
/* ---------- 附件（图片 / PDF / 任意文件） ---------- */
const ATTACH_MAX = 8;
const RE_ATTACH_IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;
const RE_ATTACH_PDF = /\.pdf$/i;
function attachKindOf(p) {
  if (RE_ATTACH_IMAGE.test(p)) return 'image';
  if (RE_ATTACH_PDF.test(p)) return 'pdf';
  return 'file';
}
// 单色线性图标，与侧栏 / 工具栏的 SVG 语言一致（emoji 会在深色主题里显彩、基线也不稳）
const ATTACH_ICON = {
  image: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.8"/><circle cx="6" cy="6.4" r="1.1"/><path d="M3.2 11.4l3.1-3 2.4 2.3 2-1.8 2.1 2"/></svg>',
  pdf: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.6h5l3 3v7.8H4z"/><path d="M9 2.6v3h3"/><path d="M6 8.6h4M6 10.8h4"/></svg>',
  file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.6h5l3 3v7.8H4z"/><path d="M9 2.6v3h3"/></svg>',
};
/** 取真实绝对路径：Electron 32+ 没有 File.path，必须经 preload 的 webUtils */
function pathOfFile(file) {
  if (!file) return '';
  try {
    if (api && typeof api.pathForFile === 'function') {
      const p = api.pathForFile(file);
      if (p) return p;
    }
  } catch {}
  return file.path || '';
}
function tabAttachments(tab = activeTab()) {
  if (!tab) return [];
  if (!Array.isArray(tab.attachments)) tab.attachments = [];
  return tab.attachments;
}
function addAttachments(paths) {
  const list = tabAttachments();
  let added = 0, skipped = 0;
  for (const raw of paths) {
    const p = String(raw || '').trim();
    if (!p) continue;
    if (list.length >= ATTACH_MAX) { skipped += 1; continue; }
    if (list.some((a) => a.path === p)) { skipped += 1; continue; }
    list.push({
      path: p, name: p.split('/').pop() || p, kind: attachKindOf(p),
    });
    added += 1;
  }
  renderAttach();
  if (skipped && !added) toast(`最多附加 ${ATTACH_MAX} 个文件，或文件已在列表中`, 2200);
  else if (skipped) toast(`已附加 ${added} 个，${skipped} 个超出上限或重复`, 2200);
  else if (added) toast(`已附加 ${added} 个文件（下一回合生效）`, 1800);
}
function removeAttachment(p) {
  const tab = activeTab();
  if (!tab) return;
  tab.attachments = tabAttachments(tab).filter((a) => a.path !== p);
  renderAttach();
}

/* ---------- 发送 ---------- */
/** displayText：命令改写出来的回合要在气泡里显示命令原文（如 `/plan …`），
 *  而真正提交给 agent 的是改写后的 prompt。两者不同就分开传。 */
async function send(text, displayText, targetTab) {
  const tab = targetTab || activeTab();
  if (!tab) return;
  const visible = tab.id === state.activeTabId;
  text = text.trim(); if (!text) return;
  if (tab.running) {
    if (displayText) return;
    if (!Array.isArray(tab.queued)) tab.queued = [];
    if (tab.queued.length >= 5) { toast('发送队列已满（最多 5 条）', 2000); return; }
    const queuedAtts = tabAttachments(tab).slice();
    tab.queued.push({ text, attachments: queuedAtts });
    if (queuedAtts.length) { tab.attachments = []; renderAttach(); }
    renderQueue();
    if (visible) { $('#input').value = ''; autoGrow(); updateCount(); slashClose(); }
    toast(`已加入发送队列（待发 ${tab.queued.length} 条）`, 1800);
    return;
  }
  /* 斜杠命令兜底：菜单被 Esc 关掉、或敲的是别名时，Enter 绝不能把 `/compact` 当正文
     发给模型 —— 那正是「命令不能用」的样子。精确匹配（含别名）就跑命令；目录已就绪
     但确实没这条，也交给 CLI 回答（它会回「Unknown command /x — nothing was sent.」）。
     只有用户自己发起的那次发送（displayText 为空）才走这条，命令改写的 prompt 不受影响。 */
  if (!displayText) {
    const hit = resolveSlashCommand(text);
    if (hit) {
      if (visible) { $('#input').value = ''; autoGrow(); updateCount(); slashClose(); }
      return runSlashCommand(hit.row, hit.arg, hit.row.aliasHit || hit.row.cmd, tab);
    }
    const m = text.match(/^(\/[A-Za-z0-9][A-Za-z0-9_.:-]*)(\s+[\s\S]*)?$/);
    if (m && !cliCatalog.ok) {
      // 目录还在路上：别把 /compact 当正文发出去，也别默默吞掉 —— 说清楚在等什么
      loadCliCatalog();
      if (visible) toast('命令目录还在加载，稍等一下再按 Enter', 2400);
      return;
    }
    if (cliCatalog.ok && m) {
      if (visible) { $('#input').value = ''; autoGrow(); updateCount(); slashClose(); }
      return runSlashCommand({ cmd: m[1], desc: '', source: 'cli', argMode: null, sub: [], scope: '' },
        (m[2] || '').trim(), m[1], tab);
    }
  }
  const shown = String(displayText || text).trim() || text;
  if (visible && state.view === 'trace') {
    state.view = 'chat';
    document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
  }
  const atts = tabAttachments(tab);
  if (visible) slashClose(); // 乐观清空不走 input 事件，指令菜单必须在这里显式收起
  state.sendHistory.push(shown); state.histIdx = state.sendHistory.length; state.histDraft = ''; state.histBrowsing = false;
  tab.items.push({ kind: 'user', text: shown, ts: Date.now(), files: atts.map((a) => a.name) });
  if (visible) {
    // 取消在途草稿定时器：否则发送后它仍会以「清空后的输入框」再写一次草稿归属
    if ($('#input')._draftTimer) { clearTimeout($('#input')._draftTimer); $('#input')._draftTimer = null; }
    // 立即清空输入框（乐观发送）；放在 await 之后会吞掉用户在这段时间里新敲的内容
    $('#input').value = ''; autoGrow(); updateCount();
  }
  if (typeof clearDraftFor === 'function') clearDraftFor(tab);
  if (tab.title === '新会话') tab.title = shown.slice(0, 24);
  tab.running = true; tab.startedAt = Date.now(); tab.deltas = 0;
  // 回合开始时的累计用量：结算时用它做差，得到「本条消息自己的 token」
  tab.usageBase = (tab.usage && tab.usage.total) || 0;
  tab.showTyping = true; tab.activity = '思考中…';
  if (visible) {
    closeSubpages();
    renderTabs(); renderChat(); scrollBottom(true); setActivity('思考中…'); syncActivityBar();
  } else {
    renderTabs();
  }
  if (typeof renderSessions === 'function') renderSessions();
  const payload = {
    tabId: tab.id, query: text, sessionId: tab.sessionId || undefined,
    model: state.config.model || undefined, reasoning: state.config.reasoning,
    yolo: state.config.yolo || undefined,
    // 项目内新建的页签带着项目根：首轮 session.create 以此为 cwd，CLI 按
    // git 仓库根把会话归属到项目（每轮都传无害，resume 不再使用它）
    cwd: tab.cwd || undefined,
    attachments: atts.length ? atts.map((a) => a.path) : undefined,
  };
  tab.attachments = []; renderAttach();
  if (hasNative) {
    try {
      const st = await api.send(payload);
      if (st && st.sessionId && !tab.sessionId) tab.sessionId = st.sessionId;
    } catch (e) {
      tab.items.push({ kind: 'error', text: (e && e.message) || String(e) });
      tab.running = false; tab.showTyping = false;
      renderTabs();
      if (tab.id !== state.activeTabId) {
        tab.unread = true;
      } else {
        renderChat(); syncActivityBar(); syncComposerState(); setActivity('空闲');
      }
      if (typeof renderSessions === 'function') renderSessions();
    }
  } else {
    window.__mockAPI.__sendDemo(payload, (evt) => {
      state.turnTab.set(evt.turnId, tab.id); routeEvent(evt);
    }, (summary) => handleClose({ tabId: tab.id, summary }));
  }
  updateStatus();
}
function handleClose({ tabId, summary }) {
  const tab = state.tabs.find((t) => t.id === tabId); if (!tab) return;
  const s = summary || {};
  // 后台页签收尾不能重置当前页签的状态条 / 重绘聊天流 / 抢占读屏播报
  const visible = tab.id === state.activeTabId;
  tab.running = false; tab.showTyping = false;
  if (s.turnId) state.turnTab.delete(s.turnId);
  applyAutoCollapse(tab);
  if (s.sessionId) tab.sessionId = s.sessionId;
  if (s.model) tab.model = s.model;
  if (s.aborted) {
    if (!tab.stoppedByUser) tab.items.push({ kind: 'error', text: '已手动停止本回合' });
  } else if (s.exitCode !== 0 && !tab.items.some((i) => i.kind === 'error')) {
    const tail = (s.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ');
    const text = tail || `hermes 进程退出码 ${s.exitCode}`;
    tab.items.push({ kind: 'error', text, failure: parseFailure('', text) });
  }
  tab.stoppedByUser = false;
  renderTabs();
  if (typeof renderSessions === 'function') renderSessions();
  if (visible) {
    renderChat(); updateStatus(); setActivity('空闲');
    syncActivityBar(); syncComposerState();
    a11y(s.aborted ? '本轮已停止' : '本轮回复已完成');
  }
  // 非聚焦完成通知已统一由主进程 notifyDesktop 发送（带点击回焦与 orb 态判断），避免双弹
  refreshSessions($('#session-search').value.trim());
  if (tab.sessionId && hasNative) api.sessionStats(tab.sessionId).then(() => updateStatus()).catch(() => {});
  if (!s.aborted && Array.isArray(tab.queued) && tab.queued.length) {
    const next = tab.queued.shift();
    renderQueue();
    if (next && next.text) setTimeout(() => {
      if (!state.tabs.includes(tab)) return;
      if (Array.isArray(next.attachments) && next.attachments.length) {
        tab.attachments = next.attachments;
        renderAttach();
      }
      send(next.text, undefined, tab);
    }, 60);
  } else {
    renderQueue();
  }
}

/* ---------- 状态条 ---------- */
/* 底部状态栏显示文字；聊天流里的 .typing-msg 显示转动图标 + 计时。
   输入框上方的旧 #activity 条已移除，避免同一状态出现两次。 */
function setActivity(text) {
  $('#st-activity').textContent = text;
  const a = $('#activity-text'); if (a) a.textContent = text;
}
/** 切换 / 新建会话时必须复位用量 UI，否则会残留上一个会话的 token 与上下文占用 */
/* 上下文圆环周长：r=8（viewBox 20×20），2π×8 ≈ 50.27。
   JS 写 dashoffset 必须和 CSS 的 dasharray 同值，否则环会在 0 处露一道缝。 */
const CTX_RING_C = 50.27;
function resetUsageUI() {
  setStCell('#st-tokens', MSG_ICO_DB, '0 tok');
  $('#st-tps').textContent = '';
  $('#st-duration').textContent = '';
  setStCell('#st-rounds', MSG_ICO_RETRY, '');
  // 上下文圆环：无用量时整组连环一起收起（留个空环会像装饰噪点）
  const ctxEl = $('#st-ctx');
  if (ctxEl) {
    ctxEl.hidden = true;
    ctxEl.classList.remove('hot');
    ctxEl.title = '暂无用量数据';
    const pctEl = $('#st-ctx-pct'); if (pctEl) pctEl.textContent = '';
    const arcEl = $('#ctx-ring-arc'); if (arcEl) arcEl.style.strokeDashoffset = String(CTX_RING_C);
  }
}
function updateStatus() {
  const tab = activeTab();
  // 未显式选模型时发送走 CLI 默认：状态条如实说「跟随 CLI 默认」，不说误导性的「未选择」
  $('#st-model').textContent = '⬢ ' + ((tab && tab.model) || state.config.model || '跟随 CLI 默认');
  // 会话 id 是 48 位哈希：状态条只留前 8 位，完整值放 title（否则会挤掉中间的用量组）
  const sid = (tab && tab.sessionId) || '';
  const sessEl = $('#st-session');
  sessEl.textContent = sid ? sid.slice(0, 8) : '—';
  sessEl.title = sid ? `${sid}（点击复制）` : '尚未建立会话';
  sessEl.style.cursor = sid ? 'pointer' : '';
  sessEl.onclick = sid ? () => {
    copyText(sid).then(() => toast('已复制会话 ID', 1400)).catch(() => toast('复制失败', 1400));
  } : null;
  // 用量优先取后端 session.usage（真实口径），退回 result.tokens
  const r = tab && tab.lastResult;
  const u = tab && (tab.usage || (r && r.tokens) || null);
  // 状态条第一组：轮次 / 步数（本会话已发生的助手回合与工具调用）
  const rounds = tab ? tab.items.filter((i) => i.kind === 'assistant' && i.done).length : 0;
  const steps = tab ? tab.items.filter((i) => i.kind === 'tool').length : 0;
  const roundsEl = $('#st-rounds');
  if (roundsEl) setStCell('#st-rounds', MSG_ICO_RETRY, rounds ? `${rounds} 轮${steps ? ' ' + steps + ' 步' : ''}` : '');
  if (u) {
    const inTok = u.input || 0, outTok = u.output || 0;
    const total = u.total || (inTok + outTok);
    // dsh 用量带口径：总量 + 缓存命中率，输入/输出拆分放进 title 供细看
    let tokTxt = `${fmtTokens(total)} tok`;
    if (u.cacheHitPct) tokTxt += ` · 缓存命中 ${u.cacheHitPct}%`;
    else if (u.cacheRead) tokTxt += ` · 缓存 ${fmtTokens(u.cacheRead)}`;
    if (u.cost > 0) tokTxt += ` · $${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(2)}`;
    setStCell('#st-tokens', MSG_ICO_DB, tokTxt);
    $('#st-tokens').title = `输入 ${fmtTokens(inTok)} · 输出 ${fmtTokens(outTok)}${u.cacheRead ? ' · 缓存读 ' + fmtTokens(u.cacheRead) : ''}`;
    // 速率：输出太少时 tok/s 没有参考意义（2 tok / 5s = 0.4），改显 API 延迟
    const tps = u.tps || (r && r.duration_ms && outTok ? outTok / (r.duration_ms / 1000) : 0);
    // 组内用「·」分隔（dsh 口径：`↻ 4 轮 44 步 · 172 tok/s`），没有轮次时不留孤零零的点
    const tpsTxt = (outTok >= 20 && tps)
      ? `${tps.toFixed(1)} tok/s`
      : (u.latencyS ? `${u.latencyS.toFixed(1)}s/次调用` : '');
    $('#st-tps').textContent = tpsTxt ? (rounds ? '· ' + tpsTxt : tpsTxt) : '';
    $('#st-duration').textContent = r && r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '';
    // 上下文占用：有真实口径就用，否则按本轮 tokens 估算并标注
    let pct, label;
    if (u.contextMax) {
      pct = u.contextPercent != null ? u.contextPercent : Math.round((u.contextUsed / u.contextMax) * 100);
      label = `上下文 ${fmtTokens(u.contextUsed)}/${fmtTokens(u.contextMax)} · ${pct}%` + (u.contextEstimated ? '（估算）' : '');
    } else {
      const used = inTok + outTok;
      pct = Math.min(100, Math.round((used / 128000) * 100));
      label = `上下文估算 ${pct}%（${fmtTokens(used)}/128k）`;
    }
    pct = Math.max(0, Math.min(100, pct));
    const ctxEl = $('#st-ctx');
    if (ctxEl) {
      ctxEl.hidden = false;
      const pctEl = $('#st-ctx-pct');
      if (pctEl) pctEl.textContent = pct + '%';
      // 环从 12 点起顺时针填：dashoffset = 周长 ×（1 − 占比）
      const arcEl = $('#ctx-ring-arc');
      if (arcEl) arcEl.style.strokeDashoffset = (CTX_RING_C * (1 - pct / 100)).toFixed(2);
      ctxEl.classList.toggle('hot', pct > 80);
      ctxEl.title = pct >= 80 ? `${label} · 点击执行 /compress 压缩上下文` : label;
      ctxEl.style.cursor = pct >= 80 ? 'pointer' : '';
      ctxEl.onclick = pct >= 80 ? () => send('/compress') : null;
    }
  } else {
    resetUsageUI();
  }
  const yoloBtn = $('#chip-yolo');
  yoloBtn.classList.toggle('on', state.config.yolo);
  yoloBtn.setAttribute('aria-pressed', String(!!state.config.yolo));
  // 文案对齐 dsh 的权限胶囊：完全权限 / 审批模式（这是开关不是菜单，所以不加下拉箭头）
  yoloBtn.textContent = state.config.yolo ? '⊙ 完全权限' : '⊙ 审批模式';
  // 思考程度并进了模型菜单：只在非默认值时才在 chip 上带一句，避免常态噪音
  const eff = state.config.reasoning && state.config.reasoning !== 'none' ? ' · ' + state.config.reasoning : '';
  $('#chip-model').textContent = (state.config.model || '请选择模型') + eff + ' ⌄';
}
function renderQueue() {
  const bar = $('#queue-bar');
  if (!bar) return;
  const tab = activeTab();
  const q = (tab && Array.isArray(tab.queued)) ? tab.queued : [];
  bar.textContent = '';
  if (!q.length) { bar.hidden = true; return; }
  bar.hidden = false;
  q.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    row.setAttribute('role', 'listitem');
    const lbl = document.createElement('span');
    lbl.className = 'qi-text';
    const attCount = Array.isArray(entry.attachments) ? entry.attachments.length : 0;
    lbl.textContent = '◷ 排队中：' + String(entry.text || '').replace(/\s+/g, ' ').slice(0, 80) + (attCount ? ` · 📎${attCount}` : '');
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'qi-x'; rm.textContent = '×';
    rm.title = '取消排队';
    rm.onclick = () => { q.splice(idx, 1); renderQueue(); };
    row.append(lbl, rm);
    bar.appendChild(row);
  });
}
/** 附件条：空列表整体隐藏，不占用输入框布局高度 */
function renderAttach() {
  const box = $('#attach-list');
  if (!box) return;
  box.textContent = '';
  const list = tabAttachments();
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  for (const a of list) {
    const item = document.createElement('span');
    item.className = 'attach-item';
    item.setAttribute('role', 'listitem');
    if (a.kind === 'image' && a.path) {
      const img = document.createElement('img');
      img.className = 'ai-thumb';
      img.src = 'file://' + encodeURI(a.path).replace(/#/g, '%23').replace(/\?/g, '%3F');
      img.alt = a.name;
      item.appendChild(img);
    } else {
      const ico = document.createElement('span');
      ico.className = 'ai-ico';
      ico.innerHTML = ATTACH_ICON[a.kind] || ATTACH_ICON.file;
      ico.setAttribute('aria-hidden', 'true');
      item.appendChild(ico);
    }
    const name = document.createElement('span');
    name.className = 'ai-name'; name.textContent = a.name;
    name.title = a.path;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'ai-x'; x.textContent = '×';
    x.setAttribute('aria-label', `移除附件 ${a.name}`);
    x.onclick = () => removeAttachment(a.path);
    item.append(name, x);
    box.appendChild(item);
  }
}

/* ---------- Composer ---------- */
/** 发送键两态：空输入时是淡底软键，有内容才落成实心强调色（dsh 的亲和提示） */
function syncSendState() {
  const b = $('#btn-send'); if (!b) return;
  const inp = $('#input');
  b.classList.toggle('ready', !!(inp && inp.value.trim()));
}
function autoGrow() {
  const inp = $('#input'); inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 200) + 'px';
  syncSendState();
}
$('#input').addEventListener('input', () => {
  state.histBrowsing = false;
  autoGrow(); updateCount();
  slashSync(); // / 起手弹内联指令菜单；非 / 起手自动收起
  clearTimeout($('#input')._draftTimer);
  $('#input')._draftTimer = setTimeout(() => { if (typeof saveDraftFor === 'function') saveDraftFor(activeTab()); }, 400);
});
$('#input').addEventListener('keydown', (e) => {
  // 指令菜单开着时：↑↓/Home/End 移行、Enter 执行高亮行（拦在发送之前）
  if (slashNav(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#input').value); }
  else if (e.key === 'ArrowUp' && state.sendHistory.length) {
    const inp = $('#input');
    const atTop = !inp.value || (inp.selectionStart === 0 && inp.selectionEnd === 0);
    if (state.histBrowsing || atTop) {
      e.preventDefault();
      if (!state.histBrowsing) {
        state.histDraft = inp.value;
        state.histIdx = state.sendHistory.length;
        state.histBrowsing = true;
      }
      state.histIdx = Math.max(0, state.histIdx - 1);
      inp.value = state.sendHistory[state.histIdx] || '';
      autoGrow(); updateCount();
    }
  } else if (e.key === 'ArrowDown' && state.histBrowsing && state.sendHistory.length) {
    e.preventDefault();
    const inp = $('#input');
    state.histIdx = Math.min(state.sendHistory.length, state.histIdx + 1);
    if (state.histIdx >= state.sendHistory.length) {
      inp.value = state.histDraft || '';
      state.histBrowsing = false;
    } else {
      inp.value = state.sendHistory[state.histIdx] || '';
    }
    autoGrow(); updateCount();
  }
});
$('#btn-send').onclick = () => send($('#input').value);
$('#btn-stop').onclick = () => {
  const t = activeTab(); if (!t || !t.running) return;
  // 本地立即复位：不能依赖主进程 close 事件，漏发会永久卡在「正在停止」并挡住后续发送
  if (t._rafText) { cancelAnimationFrame(t._rafText); t._rafText = 0; }
  const last = t.items[t.items.length - 1];
  if (last && last.kind === 'assistant' && !last.done) last.done = true;
  if (Array.isArray(t.queued)) { t.queued = []; renderQueue(); }
  t.running = false; t.showTyping = false; t.stoppedByUser = true;
  invalidateTurn(t);
  if (hasNative && api.abort) Promise.resolve(api.abort(t.id)).catch(() => {});
  renderTabs(); if (typeof renderSessions === 'function') renderSessions();
  renderChat(); updateStatus(); syncActivityBar(); syncComposerState();
  setActivity('已停止'); a11y('本轮已停止'); toast('已停止本回合', 1400);
};
const newSessionAction = () => {
  const t = activeTab();
  if (t && !t.items.length && !t.running) {
    // 即使当前已是空会话，也必须关闭插件/技能/设置等子页面并回到聊天视图
    closeSubpages();
    state.view = 'chat';
    document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
    renderChat(); renderSessions(); updateStatus();
    $('#input').focus();
    toast('当前已是新会话，直接输入即可', 1600);
  } else {
    newTab();
    $('#input').focus();
  }
};
$('#btn-new-tab').onclick = newSessionAction;
$('#btn-new-session').onclick = () => { newSessionAction(); if (window.innerWidth < 1000) setSidebar(false, { persist: false }); };
const togglePage = (page) => toggleSubpage(page, page.hidden);
// 注意：只绑实际存在的元素；$() 命中 null 会在赋值 .onclick 时抛 TypeError，中断后续所有绑定
$('#btn-plugins2').onclick = () => { setSidebar(true); togglePage($('#plugins-page')); };
$('#btn-skills2').onclick = () => { setSidebar(true); togglePage($('#skills-page')); };
$('#btn-kanban').onclick = () => { setSidebar(true); showKanban(); };
// 侧栏「新建项目」入口：弹窗在 #frame 外，直接在当前页面弹出，不跳看板页
$('#sb-new-project').onclick = () => kbProjectDialog('create');
// 官方「打开文件夹为项目」：选一个目录即建/进工作空间，不必先填表
$('#sb-open-folder').onclick = () => openFolderAsProject();
$('#btn-kanban-ir').onclick = () => showKanban();
$('#btn-settings').onclick = () => toggleSettings(true);
$('#btn-gw').onclick = showGateway;
$('#btn-gw-ir').onclick = showGateway;
$('#btn-plugins-ir').onclick = () => togglePage($('#plugins-page'));
$('#btn-skills-ir').onclick = () => togglePage($('#skills-page'));
$('#btn-settings-ir').onclick = () => toggleSettings(true);
$('#chip-model').onclick = () => openModelPicker();
// 去抖 180ms：每敲一个字都发两次 IPC（列表 + FTS）会造成输入卡顿与结果闪回
let searchDebounce = null;
$('#session-search').addEventListener('input', (e) => {
  $('#search-clear').hidden = !e.target.value;
  const v = e.target.value.trim();
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => refreshSessions(v), 180);
});
$('#search-clear').onclick = () => {
  clearTimeout(searchDebounce);
  $('#session-search').value = ''; $('#search-clear').hidden = true; refreshSessions('');
};
document.querySelectorAll('.quick-actions button').forEach((b) => { b.onclick = () => send(b.dataset.q); });

/* 侧栏显隐（复刻参考页 rail 交互）：
   展开侧栏 / 收起图标栏是两套 DOM，但只由下面这一个状态驱动：
   偏好记忆 + ⌘B 切换 + 点品牌 logo 展开 + 隐藏的一栏不参与键盘焦点。
   宽度交给 CSS 变量 --sb-w，避免内联 width 覆盖 .collapsed 的 width:0。 */
const SB_STATE_KEY = 'hermes.sidebar';
function sidebarOpen() { return !$('#sidebar').classList.contains('collapsed'); }
function syncSidebar() {
  const open = sidebarOpen();
  const sb = $('#sidebar'), ir = $('#iconrail');
  $('#frame').classList.toggle('sb-open', open);
  // 侧栏收起时：左上角（红绿灯右侧）出现「展开侧栏 + 新会话」
  $('#btn-expand').hidden = open;
  $('#btn-expand').setAttribute('aria-expanded', String(open));
  // 透明/零宽的一栏仍会被 Tab 聚焦，用 inert + aria-hidden 彻底移出交互树
  sb.inert = !open; ir.inert = open;
  sb.setAttribute('aria-hidden', String(!open));
  ir.setAttribute('aria-hidden', String(open));
  // 所有页面级引导按钮（整页浮层 + 设置弹层）与侧栏状态保持一致
  const label = open ? '收起侧栏 ⌘B' : '展开侧栏 ⌘B';
  document.querySelectorAll('[data-lead="sidebar"]').forEach((b) => {
    b.title = label;
    b.setAttribute('aria-label', label.replace(' ⌘B', ''));
    b.setAttribute('aria-expanded', String(open));
  });
}
function setSidebar(open, opts = {}) {
  const next = !!open;
  const sb = $('#sidebar'), frame = $('#frame');
  // 隐藏窗口里 CSS 过渡时间线不推进（document.timeline 停在 0），
  // 切换会卡在动画起点；此时直接落到终态，回到前台即为正确布局。
  const skipAnim = document.hidden || frame.classList.contains('sb-init');
  if (skipAnim) frame.classList.add('sb-noanim');
  sb.classList.toggle('collapsed', !next);
  syncSidebar();
  if (skipAnim) {
    void document.body.offsetWidth; // 强制同步布局到终态
    frame.classList.remove('sb-noanim');
  }
  if (opts.persist !== false) {
    try { localStorage.setItem(SB_STATE_KEY, next ? 'open' : 'closed'); } catch {}
  }
}
function toggleSidebar() { setSidebar(!sidebarOpen()); }
$('#btn-sidebar-collapse').onclick = () => setSidebar(false);
$('#btn-expand').onclick = () => setSidebar(true);
$('#btn-sessions').onclick = () => { setSidebar(true); $('#session-search').focus(); };
// 收起态点击图标栏品牌 logo 展开侧栏（参考页 brand 行为），键盘同样可达
{
  const irLogo = $('.ir-logo');
  if (irLogo) {
    irLogo.onclick = () => setSidebar(true);
    irLogo.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSidebar(true); }
    };
  }
}
{
  const sbStorage = $('#sb-storage-btn');
  if (sbStorage) sbStorage.onclick = (e) => { e.stopPropagation(); toggleStoragePop(); };
}
// 点击空白处收起会话菜单 / 空间浮层
document.addEventListener('click', (e) => {
  const m = $('#session-menu');
  if (m && !m.hidden && !m.contains(e.target) && !(e.target.closest && e.target.closest('.s-actions'))) closeSessionMenu();
  const p = $('#storage-pop');
  if (p && !p.hidden && !p.contains(e.target) && !(e.target.closest && e.target.closest('#sb-storage-btn'))) p.hidden = true;
});
// 启动按偏好恢复：HTML 默认展开，首帧 sb-init 禁用过渡，避免闪一次宽度动画。
// 用 setTimeout 而非 rAF —— 后台窗口的 rAF 会被节流，导致 sb-init 永远留着。
(function restoreSidebar() {
  let saved = null;
  try { saved = localStorage.getItem(SB_STATE_KEY); } catch {}
  setSidebar(saved !== 'closed', { persist: false });
  setTimeout(() => $('#frame').classList.remove('sb-init'), 60);
})();

/* 页面级引导按钮：整页（插件/技能/消息平台/市场）会盖住 #chat-head，
   此时由 #page-lead 接管「侧栏切换 / 新建会话」；设置弹层内用同一组件契约。
   只监听 hidden 属性变化，不需要改 5 处页面开关函数。 */
let lastModalOpen = false;
let modalOpener = null;
function syncPageLead() {
  const lead = $('#page-lead'), head = $('#chat-head');
  if (!lead || !head) return;
  const pageOpen = [...document.querySelectorAll('.subpage')].some((p) => !p.hidden);
  // 新建弹窗（含项目 / 工作空间）也是 #frame 之外的全局浮层：从聊天页直接打开时，
  // 同样要把 frame 锁进 inert，并纳入下面的焦点归还链。
  const modals = [$('#settings-page'), $('#palette'), $('#help-modal'), $('#kb-modal')];
  const modalOpen = modals.some((m) => m && !m.hidden);
  lead.hidden = !pageOpen;
  // 被整页/模态遮罩盖住的元素不参与 Tab 焦点，读屏也不会读到一层看不见的按钮
  head.inert = pageOpen || modalOpen;
  lead.inert = modalOpen;
  // 模态打开时整块背景 inert：否则 Tab 会跳到遮罩下的侧栏/输入区按钮（WCAG 2.4.3）。
  // 三个 .palette 浮层与新建弹窗都在 #frame 之外，不受影响；整页 .subpage 在 frame 内，故仅模态时隔离。
  const frame = $('#frame');
  if (frame) frame.inert = modalOpen;
  // 关闭模态后把焦点还给触发者（Escape / 关闭按钮 / 点遮罩都经 hidden 变更，统一在此收口）。
  const active = document.activeElement;
  if (modalOpen && !lastModalOpen) {
    const inModal = modals.some((m) => m && m.contains(active));
    modalOpener = active && active !== document.body && !inModal ? active : null;
  } else if (!modalOpen && lastModalOpen) {
    const stuck = !active || active === document.body ||
      modals.some((m) => m && m.contains(active));
    if (stuck) {
      // 触发者不可用时（帮助层会把焦点直接放进模态内），回落到输入框。
      // 必须等上面的 frame.inert 解除后再 focus，否则 inert 内元素会静默拒绝聚焦。
      const fallback = $('#input');
      const target = (modalOpener && document.contains(modalOpener) && !modalOpener.closest('[inert]'))
        ? modalOpener
        : (fallback && !fallback.closest('[inert]') ? fallback : null);
      if (target) { try { target.focus({ preventScroll: true }); } catch { /* 已卸载 */ } }
    }
    modalOpener = null;
  }
  lastModalOpen = modalOpen;
}
(function watchPageLead() {
  const obs = new MutationObserver(syncPageLead);
  document.querySelectorAll('.subpage, #settings-page, #palette, #help-modal, #kb-modal')
    .forEach((p) => obs.observe(p, { attributes: true, attributeFilter: ['hidden'] }));
  syncPageLead();
})();

/* 窄主区降级：窗口最小 940px、侧栏又能拖到 520px，叠加后主区仅约 370px，
   输入行（尤其发送按钮）与插件/技能工具栏会被挤出可视区。
   只依据 #main 的实际宽度切 class，主区 >600px 时不改变任何定版几何。 */
const COMPACT_MAX = 600;
function syncCompactLayout() {
  const main = $('#main');
  if (!main) return;
  const w = main.clientWidth;
  if (w > 0) document.documentElement.classList.toggle('compact', w <= COMPACT_MAX);
}
(function initCompactLayout() {
  const main = $('#main'), sidebar = $('#sidebar');
  if (!main) return;
  syncCompactLayout();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncCompactLayout).observe(main);
  window.addEventListener('resize', syncCompactLayout);
  // 侧栏宽度由 JS 写 --sb-w。窗口隐藏 / 最小化时 ResizeObserver 可能不派发，
  // 因此额外监听 style 变化，保证拖拽与恢复偏好后都能立刻同步（微任务内合并，无循环）。
  if (sidebar && typeof MutationObserver !== 'undefined') {
    new MutationObserver(syncCompactLayout).observe(sidebar, { attributes: true, attributeFilter: ['style'] });
  }
})();
/* 视口漂移上报：macOS 唤醒 / 退出全屏后，窗口 frame 变了但内容区可能没跟上，
   表现为窗口右侧一整块未绘制的白区。这里只上报真实 innerWidth/innerHeight，
   由主进程与窗口 bounds 比对，确有漂移才重新校准（平时不做任何动作）。 */
(function initViewportWatch() {
  if (!api || typeof api.reportViewport !== 'function') return;
  let t = null;
  const report = () => {
    try { api.reportViewport({ width: innerWidth, height: innerHeight }); } catch {}
  };
  const later = () => { if (t) clearTimeout(t); t = setTimeout(report, 400); };
  window.addEventListener('resize', later);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) later(); });
  window.addEventListener('focus', later);
  later();
})();
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-lead]');
  if (!btn) return;
  if (btn.dataset.lead === 'sidebar') {
    // 设置是模态遮罩，先退出再切换，否则用户看不到侧栏变化
    if (!$('#settings-page').hidden) toggleSettings(false);
    toggleSidebar();
  } else if (btn.dataset.lead === 'new') {
    document.querySelectorAll('.subpage').forEach((pg) => { pg.hidden = true; });
    if (!$('#settings-page').hidden) toggleSettings(false);
    newSessionAction();
  }
});

// 侧栏右缘横向拖拽调宽（PointerEvents + setPointerCapture；宽度记忆到 localStorage）
(function () {
  const handle = $('#sb-resize'), sidebar = $('#sidebar');
  const MIN = 260, MAX = 560, DEF = 317;
  // 只写 --sb-w，不再写 inline width（否则会盖掉 .collapsed 的 width:0）
  const setW = (w) => sidebar.style.setProperty('--sb-w', w + 'px');
  const getW = () => parseFloat(sidebar.style.getPropertyValue('--sb-w')) || DEF;
  try {
    const saved = parseFloat(localStorage.getItem('sb-width'));
    if (saved >= MIN && saved <= MAX) setW(saved);
  } catch {}
  let startX = 0, startW = 0, activeId = null;
  const finish = () => {
    if (!document.body.classList.contains('resizing')) return;
    document.body.classList.remove('resizing');
    if (activeId !== null) { try { handle.releasePointerCapture(activeId); } catch {} activeId = null; }
    try { localStorage.setItem('sb-width', String(Math.round(getW()))); } catch {}
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || sidebar.classList.contains('collapsed')) return;
    startX = e.clientX;
    startW = getW();
    activeId = e.pointerId;
    try { handle.setPointerCapture(activeId); } catch {}
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!document.body.classList.contains('resizing')) return;
    setW(Math.min(MAX, Math.max(MIN, startW + (e.clientX - startX))));
  });
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
})();

// 附件（文件选择 + 粘贴 + 拖放）：图片走多模态、PDF 走解析、其余按文件引用，统一交主进程附加
$('#btn-attach').onclick = () => $('#file-input').click();
$('#input').addEventListener('paste', (e) => {
  const files = e.clipboardData && e.clipboardData.files ? Array.from(e.clipboardData.files) : [];
  const paths = files.map(pathOfFile).filter(Boolean);
  if (paths.length) { e.preventDefault(); addAttachments(paths); return; }
  const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
  const imgItem = items.find((it) => it.kind === 'file' && /^image\//i.test(it.type || ''));
  if (!imgItem || typeof api.saveClipboardImage !== 'function') return;
  const blob = imgItem.getAsFile();
  if (!blob) return;
  e.preventDefault();
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const r = await api.saveClipboardImage(String(reader.result || ''));
      if (r && r.ok && r.path) addAttachments([r.path]);
      else toast((r && r.error) || '截图粘贴失败', 2000);
    } catch { toast('截图粘贴失败', 2000); }
  };
  reader.readAsDataURL(blob);
});
$('#file-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  const paths = files.map(pathOfFile).filter(Boolean);
  if (paths.length) addAttachments(paths);
  else if (files.length) toast('未能读取文件路径，请改用拖拽或检查系统权限', 2600);
  e.target.value = '';
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
    document.body.classList.add('dropping');
  }
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dropping');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const files = Array.from(e.dataTransfer?.files || []);
  if (!files.length) return;
  const paths = files.map(pathOfFile).filter(Boolean);
  if (paths.length) addAttachments(paths);
  else toast('未能读取文件路径，请改用「⊕ 附件」选择文件', 2600);
});

// 审批模式
$('#chip-yolo').onclick = () => {
  state.config.yolo = !state.config.yolo; updateStatus();
  toast(state.config.yolo ? '已开启：本会话跳过危险命令审批' : '已恢复审批模式', 1600);
  if (hasNative) api.setConfig({ yolo: state.config.yolo });
};
// 项目选择：与审批模式同组；change 由自绘下拉派发（ui-select.js 的 _pick）
$('#chip-project').addEventListener('change', (e) => applyComposerProject(e.target.value));
// 下拉末尾的「＋ 新建项目…」是动作行，不改 value，只派发 select-action
$('#chip-project').addEventListener('select-action', () => onComposerNewProject());
