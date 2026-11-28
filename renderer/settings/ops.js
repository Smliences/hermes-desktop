'use strict';
/* ══════════ 设置页运维类面板（工具集 / MCP 服务器 / 看板编排 / 定时任务） ══════════ */
/* global $, esc, arr, toast, api, isNativeCLI, settingsPanelEpoch, subscribeCatalog, kbLoadMode, opConfirm */
/* ---------- 设置页：工具集开关（CLI 为准，操作后回读） ----------
   只展示 / 只修改 cli 平台分段：`hermes tools list` 在接入 telegram、discord 后
   会多出同名分段，那些开关必须留给对应平台的设置，桌面端不代劳。
   开关不做「乐观更新后就不管」：失败把开关拨回去并提示；成功用 CLI 回读的
   真实状态重绘，避免界面与配置文件不一致（CLI 静默失败时最容易出现这种幻觉）。 */
function toolRow(item, onToggle) {
  const row = document.createElement('div'); row.className = 'set-row';
  const main = document.createElement('div'); main.className = 'set-row-main';
  const label = document.createElement('div'); label.className = 'set-row-label';
  // label 来自 CLI 输出（含 emoji），一律走 textContent，不进 innerHTML
  label.textContent = item.label || item.name;
  const hint = document.createElement('div'); hint.className = 'set-row-hint';
  hint.textContent = item.name;
  main.append(label, hint);
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'plg-switch' + (item.enabled ? ' on' : '');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', item.enabled ? 'true' : 'false');
  sw.setAttribute('aria-label', (item.label || item.name) + ' 开关');
  sw.onclick = () => onToggle(item, sw);
  row.append(main, sw);
  return row;
}
async function renderToolsPanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">工具集 · CLI 平台</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const status = document.createElement('div'); status.className = 'mem-status';
  status.textContent = isNativeCLI() ? '正在读取工具列表…' : '演示模式：需要桌面端原生环境读取 CLI 工具列表。';
  panel.appendChild(status);
  const list = document.createElement('div'); list.className = 'tool-list';
  panel.appendChild(list);
  const note = document.createElement('div'); note.className = 'pf-note';
  note.innerHTML = '开关等同 <code>hermes tools enable|disable &lt;name&gt;</code>（默认 cli 平台）。' +
    '关闭 <code>terminal</code> / <code>file</code> 后 agent 将无法执行命令或改文件，请谨慎操作。' +
    '其它平台（Telegram / Discord 等）的工具集不在此页展示。';
  panel.appendChild(note);

  let others = [];
  let staleNow = false;
  const draw = (sections) => {
    list.innerHTML = '';
    const total = (sections || []).reduce((n, s) => n + s.items.length, 0);
    const on = (sections || []).reduce((n, s) => n + s.items.filter((i) => i.enabled).length, 0);
    status.textContent = `已启用 ${on}/${total}` + (others.length
      ? `（另有 ${others.join(' / ')} 平台的工具集未在此展示）` : '') +
      (staleNow ? ' · 后台刷新中' : '');
    status.classList.remove('is-error');
    if (!sections || !sections.length) {
      list.innerHTML = '<div class="set-row-hint">未读取到工具集。</div>';
      return;
    }
    sections.forEach((sec) => {
      const gt = document.createElement('div'); gt.className = 'pp-group-label';
      gt.textContent = `${sec.title}（${sec.items.filter((i) => i.enabled).length}/${sec.items.length} 已启用）`;
      list.appendChild(gt);
      sec.items.forEach((item) => list.appendChild(toolRow(item, toggle)));
    });
  };

  let busy = false;
  async function toggle(item, sw) {
    if (busy) return;
    busy = true;
    const next = !sw.classList.contains('on');
    const prev = sw.classList.contains('on');
    // 先给即时反馈，结果回来再对齐
    sw.classList.toggle('on', next);
    sw.setAttribute('aria-checked', next ? 'true' : 'false');
    sw.disabled = true;
    try {
      const r = await api.toolsToggle(item.name, next);
      if (r && r.ok) {
        toast(`${item.label || item.name} 已${r.enabled ? '启用' : '停用'}`, 1600);
        if (r.sections) draw(r.sections);
      } else {
        sw.classList.toggle('on', prev);
        sw.setAttribute('aria-checked', prev ? 'true' : 'false');
        toast(`操作失败：${(r && r.error) || '未知错误'}`, 3200);
        if (r && r.sections) draw(r.sections);
      }
    } catch (e) {
      sw.classList.toggle('on', prev);
      toast('操作失败：' + ((e && e.message) || e), 3000);
    }
    sw.disabled = false;
    busy = false;
  }

  let r = null;
  if (isNativeCLI()) {
    status.textContent = '正在读取工具列表…';
    try { r = await api.toolsList(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  }
  if (!isNativeCLI()) { status.textContent = '演示模式：不做 CLI 调用。'; return; }
  if (!alive()) return;
  if (!r || !r.ok) {
    status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
    status.classList.add('is-error');
    return;
  }
  others = arr(r.otherPlatforms);
  staleNow = !!r.stale;
  draw(r.sections);
  // 后台刷新完成：重取一次（主进程内存已最新，毫秒返回）并原地重绘
  subscribeCatalog((p) => {
    if (!p || p.kind !== 'tools' || !panel.isConnected) return;
    api.toolsList().then((rr) => {
      if (!rr || !rr.ok || !panel.isConnected) return;
      others = arr(rr.otherPlatforms);
      staleNow = !!rr.stale;
      draw(rr.sections);
    }).catch(() => {});
  });
}

/* ---------- 设置页：MCP 服务器 / 定时任务 ----------
   两者都完全以 hermes CLI 为真源。危险写操作统一走「内联确认卡」：
   先明示将执行的 CLI 命令与影响，二次点击才下发；所有来自 CLI 的文本
   一律走 textContent，不进 innerHTML。异步结果用 settingsPanelEpoch 作废旧响应。 */

/** 危险操作的内联确认卡。返回插入的 DOM，取消即移除，不改动任何数据。 */
function opConfirm(host, { title, cmd, note, confirmLabel = '确认执行', onGo }) {
  host.querySelectorAll('.op-confirm').forEach((n) => n.remove());
  const box = document.createElement('div');
  box.className = 'op-confirm';
  const h = document.createElement('div'); h.className = 'op-confirm-title'; h.textContent = title;
  const pre = document.createElement('code'); pre.className = 'op-confirm-cmd'; pre.textContent = cmd;
  const p = document.createElement('p'); p.className = 'op-confirm-note'; p.textContent = note;
  const btns = document.createElement('div'); btns.className = 'op-confirm-btns';
  const go = document.createElement('button');
  go.type = 'button'; go.className = 'mk-btn primary'; go.textContent = confirmLabel;
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'mk-btn'; cancel.textContent = '取消';
  cancel.onclick = () => box.remove();
  go.onclick = async () => { box.remove(); await onGo(); };
  btns.append(go, cancel);
  box.append(h, pre, p, btns);
  host.appendChild(box);
  try { go.focus({ preventScroll: true }); } catch { /* 已卸载 */ }
  return box;
}

/**
 * 「上游思考输出」：CLI 的 display.show_reasoning 为 false 时，网关一条 reasoning.delta
 * 都不会发（`agent_callbacks._emit_reasoning_delta` 直接短路），桌面端不可能凭空显示思考；
 * 之前的「思考过程」块里其实是 thinking.delta 的颜文字等待提示，所以看起来是空的。
 *
 * 这里只读状态 → 需要时出二次确认卡 → 调 `hermes config set display.show_reasoning`。
 * 写的是 CLI 配置（命令行同样受影响），因此只能由用户点卡确认，绝不自动执行。
 */
async function enableUpstreamReasoning(host) {
  if (!isNativeCLI() || typeof api.reasoningDisplay !== 'function') {
    toast('仅桌面版可读写 CLI 配置', 2400); return;
  }
  let st = null;
  try { st = await api.reasoningDisplay(); }
  catch (e) { st = { ok: false, error: String((e && e.message) || e) }; }
  if (!st || !st.ok) { toast('读取 CLI 配置失败：' + ((st && st.error) || '未知错误'), 3200); return; }
  if (st.enabled) { toast('上游已开启思考输出（display.show_reasoning: true）', 2800); return; }
  const cardHost = (host && (host.querySelector('.set-row-main') || host)) || $('#set-panel');
  opConfirm(cardHost, {
    title: '打开 CLI 的思考输出？',
    cmd: 'hermes config set display.show_reasoning true',
    note: `将写入 ${st.configPath} 的 display.show_reasoning: true。这一项同时决定命令行（hermes CLI / TUI）是否显示思考过程；`
      + '已经打开的会话仍按旧值运行，需要新开一个会话（⌘N）才会拿到思考内容。',
    confirmLabel: '写入并打开',
    onGo: async () => {
      let r = null;
      try { r = await api.setReasoningDisplay(true); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || !r.ok) { toast('写入失败：' + ((r && r.error) || '未知错误'), 3600); return; }
      toast('已打开思考输出 · 新开会话（⌘N）后即可看到', 4000);
    },
  });
}

/** 表单输入里的 Escape 只收起本表单，不冒泡到全局（否则会关掉整个设置页）。 */function guardFieldKey(el, onEscape) {
  el.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onEscape(); }
  };
}
function fieldRow(label, hint, input) {
  const wrap = document.createElement('div'); wrap.className = 'op-field';
  const lab = document.createElement('label'); lab.className = 'op-field-label'; lab.textContent = label;
  const inp = input;
  lab.appendChild(inp);
  wrap.appendChild(lab);
  if (hint) { const h = document.createElement('div'); h.className = 'op-field-hint'; h.textContent = hint; wrap.appendChild(h); }
  return wrap;
}
function textField(placeholder, maxLength) {
  const i = document.createElement('input');
  i.type = 'text'; i.className = 'set-input op-input'; i.placeholder = placeholder;
  i.spellcheck = false; i.maxLength = maxLength || 120;
  return i;
}

/* ---------------- MCP 服务器 ---------------- */
async function renderMcpPanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">MCP 服务器</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);

  const bar = document.createElement('div'); bar.className = 'op-bar';
  const status = document.createElement('div'); status.className = 'mem-status';
  status.textContent = isNativeCLI() ? '正在读取服务器列表…' : '演示模式：需要桌面端原生环境读取 MCP 配置。';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新';
  bar.append(status, refresh); panel.appendChild(bar);

  const list = document.createElement('div'); list.className = 'op-list'; panel.appendChild(list);

  const addWrap = document.createElement('div'); addWrap.className = 'op-form';
  const addTitle = document.createElement('div'); addTitle.className = 'pp-group-label'; addTitle.textContent = '添加服务器（URL）';
  addWrap.appendChild(addTitle);
  const nameIn = textField('名称，如 my-server', 64);
  const urlIn = textField('https://… 或 http://127.0.0.1:端口/…', 300);
  const timeoutIn = textField('连接超时（秒，1–60）', 3); timeoutIn.value = '10';
  const addBtns = document.createElement('div'); addBtns.className = 'op-form-btns';
  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'mk-btn primary'; addBtn.textContent = '添加';
  const addClear = document.createElement('button');
  addClear.type = 'button'; addClear.className = 'mk-btn'; addClear.textContent = '清空';
  addBtns.append(addBtn, addClear);
  addWrap.append(fieldRow('名称', '只允许字母、数字、_ . -；会作为 config.yaml 的键。', nameIn),
    fieldRow('地址', '仅 https 或本机 http。添加时会真实连接并发现工具，工具默认全部启用。', urlIn),
    fieldRow('连接超时', '', timeoutIn), addBtns);
  guardFieldKey(nameIn, () => addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(urlIn, () => addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(timeoutIn, () => addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  addClear.onclick = () => { nameIn.value = ''; urlIn.value = ''; timeoutIn.value = '10'; addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()); };
  panel.appendChild(addWrap);

  const note = document.createElement('div'); note.className = 'pf-note';
  note.textContent = '仅提供 URL 型接入。stdio 型（--command/--args）、OAuth 登录与工具筛选是 CLI 的交互式流程，请在终端用 hermes mcp add / login / configure 完成。移除会改写 CLI 的 config.yaml，其它平台不受影响。';
  panel.appendChild(note);

  let servers = [];
  let staleNow = false;
  const draw = () => {
    list.innerHTML = '';
    const on = servers.filter((s) => s.enabled).length;
    status.textContent = `已配置 ${servers.length} 个 · 启用 ${on} 个` + (staleNow ? ' · 后台刷新中' : '');
    status.classList.remove('is-error');
    if (!servers.length) {
      const empty = document.createElement('div'); empty.className = 'op-empty';
      empty.textContent = '尚未配置 MCP 服务器。'; list.appendChild(empty); return;
    }
    servers.forEach((s) => list.appendChild(mcpCard(s)));
  };

  function mcpCard(s) {
    const card = document.createElement('div'); card.className = 'op-card';
    const top = document.createElement('div'); top.className = 'op-card-top';
    const name = document.createElement('span'); name.className = 'op-name'; name.textContent = s.name;
    const badge = document.createElement('span');
    badge.className = 'op-badge' + (s.enabled ? ' on' : '');
    badge.textContent = s.enabled ? '已启用' : '已停用';
    top.append(name, badge);
    const meta = document.createElement('div'); meta.className = 'op-meta';
    const tr = document.createElement('code'); tr.className = 'op-code'; tr.textContent = s.transport;
    const tools = document.createElement('span'); tools.textContent = '工具 ' + s.tools;
    meta.append(tr, tools);
    const acts = document.createElement('div'); acts.className = 'op-acts';
    const testBtn = document.createElement('button');
    testBtn.type = 'button'; testBtn.className = 'mk-btn'; testBtn.textContent = '测试连接';
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'mk-btn danger'; delBtn.textContent = '移除';
    acts.append(testBtn, delBtn);
    const out = document.createElement('div'); out.className = 'op-out'; out.hidden = true;
    card.append(top, meta, acts, out);

    testBtn.onclick = async () => {
      if (!isNativeCLI()) { toast('演示模式不可用', 1800); return; }
      testBtn.disabled = true; testBtn.textContent = '测试中…';
      out.hidden = false; out.textContent = '正在连接并发现工具（最多 60 秒）…';
      let r;
      try { r = await api.mcpTest(s.name); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!alive()) return;
      testBtn.disabled = false; testBtn.textContent = '测试连接';
      out.textContent = '';
      if (!r || !r.ok) { out.textContent = '测试失败：' + ((r && r.error) || '未知错误'); out.classList.add('is-error'); return; }
      out.classList.remove('is-error');
      const line = document.createElement('div'); line.className = 'op-out-head';
      line.textContent = r.connected
        ? `✓ 连接成功 · ${r.latencyMs == null ? '' : r.latencyMs + 'ms · '}${r.toolCount} 个工具`
        : '✗ 未连接';
      out.appendChild(line);
      if (r.transport) { const t = document.createElement('div'); t.textContent = r.transport; out.appendChild(t); }
      if (r.tools && r.tools.length) {
        const pre = document.createElement('pre'); pre.className = 'op-pre'; pre.textContent = r.tools.join('\n');
        out.appendChild(pre);
      }
      if (r.error) { const e = document.createElement('div'); e.textContent = r.error; out.appendChild(e); }
    };
    delBtn.onclick = () => opConfirm(card, {
      title: `移除「${s.name}」？`,
      cmd: `hermes -p <current> mcp remove ${s.name}`,
      note: '会从 CLI 的 config.yaml 删除该服务器，正在使用它的会话需要重开才生效。此操作不可撤销。',
      confirmLabel: '确认移除',
      onGo: async () => { await applyWrite(() => api.mcpRemove(s.name), '已移除', '移除失败'); },
    });
    return card;
  }

  async function applyWrite(fn, okMsg, failMsg) {
    if (!isNativeCLI()) { toast('演示模式不可用', 1800); return false; }
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return false;
    if (!r || !r.ok) { toast(`${failMsg}：${(r && r.error) || '未知错误'}`, 3400); return false; }
    if (Array.isArray(r.servers)) { servers = r.servers; draw(); }
    else { await reload(); }
    toast(r.warning || okMsg, r.warning ? 3200 : 1600);
    return true;
  }

  addBtn.onclick = () => opConfirm(addWrap, {
    title: '添加一个 MCP 服务器？',
    cmd: `hermes -p <current> mcp add ${nameIn.value.trim() || '<name>'} --url ${urlIn.value.trim() || '<url>'}`,
    note: '会写入 CLI 的 config.yaml 并真实连接该地址、发现工具（默认全部启用）。连接失败时 CLI 默认不保存配置。请确认来源可信。',
    confirmLabel: '确认添加',
      onGo: () => applyWrite(() => api.mcpAdd({
        name: nameIn.value.trim(), url: urlIn.value.trim(), connectTimeout: Number(timeoutIn.value),
      }), '已添加', '添加失败').then((ok) => {
        if (ok) { nameIn.value = ''; urlIn.value = ''; timeoutIn.value = '10'; }
      }),
  });

  async function reload(opts = {}) {
    if (!isNativeCLI()) { status.textContent = '演示模式：不做 CLI 调用。'; return; }
    status.textContent = opts.force ? '正在重新读取 MCP 服务器（约 2–3 秒）…' : '正在读取 MCP 服务器…';
    let r;
    try { r = await api.mcpList(opts); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error'); return;
    }
    servers = arr(r.servers);
    staleNow = !!r.stale;
    draw();
    if (r.warning) toast(`列表刷新失败，显示上次结果：${r.warning}`, 3200);
  }
  refresh.onclick = () => reload({ force: true });
  await reload();
  // 后台刷新完成：重取缓存里的新列表并重绘（不阻塞、不闪）
  subscribeCatalog((p) => {
    if (!p || p.kind !== 'mcp' || !alive()) return;
    api.mcpList().then((rr) => {
      if (!rr || !rr.ok || !alive()) return;
      servers = arr(rr.servers);
      staleNow = !!rr.stale;
      draw();
    }).catch(() => {});
  });
}

/* ---------------- 定时任务 ---------------- */
/**
 * 设置页「看板编排」：三档模式的唯一入口。
 *
 * 这里写的是 hermes CLI 的 config.yaml（kanban 段），改的是 gateway 的自动派发 ——
 * 不只是本应用，所以每次改动都过二次确认卡，并把「要不要重启」如实写在结果里。
 * 模式本身不存储：它是 auto_decompose / dispatch_in_gateway 两个布尔的派生值。
 */
async function renderKanbanModePanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;

  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">看板编排</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);

  // 底部那个「保存」写的是本地 localStorage，对编排开关无效 —— 收起来，
  // 只留面板内的「应用」这一个写入口，两个入口会让人不知道该按哪个。
  const saveBtn = $('#set-save'), hintEl = $('#set-hint');
  if (saveBtn) saveBtn.hidden = true;
  if (hintEl) hintEl.textContent = '此页的改动点「应用」才写入 CLI 配置';

  const bar = document.createElement('div'); bar.className = 'op-bar';
  const status = document.createElement('div'); status.className = 'mem-status';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新';
  bar.append(status, refresh); panel.appendChild(bar);

  const stage = document.createElement('div'); panel.appendChild(stage);

  const note = document.createElement('div'); note.className = 'pf-note';
  note.textContent = '写的是 hermes CLI 的 config.yaml（kanban 段），影响 gateway 的自动派发，不只是这个应用。'
    + '自动分解每轮重读，下一轮 tick 就生效；派发器开关只在 gateway 启动时读一次，改完必须重启 gateway。';
  panel.appendChild(note);

  let state = null;   // 最近一次回读的生效值
  let pick = null;    // 用户选中但未应用的档位
  let busy = false;

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button'; applyBtn.className = 'mk-btn primary'; applyBtn.textContent = '应用';
  const actions = document.createElement('div'); actions.className = 'kbm-actions';
  const hint = document.createElement('div'); hint.className = 'set-row-hint';
  actions.append(applyBtn, hint);

  /** 会写进 config.yaml 的键值，逐行列出（不是假命令行，是真的键）。 */
  const planLines = (modeId) => {
    const m = state && state.modes ? state.modes.find((x) => x.id === modeId) : null;
    if (!m) return '';
    const lines = [];
    if (state.autoDecompose !== m.decompose) lines.push(`kanban.auto_decompose = ${m.decompose}`);
    if (state.dispatchInGateway !== m.dispatch) lines.push(`kanban.dispatch_in_gateway = ${m.dispatch}`);
    return lines.length ? lines.join('\n') : '（与当前一致，不会有任何写入）';
  };

  const draw = () => {
    stage.innerHTML = '';
    if (!state) { status.textContent = '当前模式读取失败'; return; }
    const sw = [];
    sw.push(`派发器${state.dispatchInGateway ? '运行中' : '已停止'}`);
    sw.push(`自动分解${state.autoDecompose ? '开' : '关'}`);
    if (state.autoPromoteChildren) sw.push('子任务自动推进开');
    status.textContent = `${state.modeLabel} · ${sw.join(' · ')}`;
    status.classList.remove('is-error');

    const group = document.createElement('div');
    group.className = 'kbm-list';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', '看板编排模式');
    (state.modes || []).forEach((m) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'kbm-card' + (m.id === pick ? ' on' : '');
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', m.id === pick ? 'true' : 'false');
      card.dataset.mode = m.id;
      // 远端 / 档位文案一律 textContent，绝不拼进 innerHTML
      const name = document.createElement('b'); name.textContent = m.label;
      const sum = document.createElement('span'); sum.textContent = m.summary;
      card.append(name, sum);
      if (m.id === pick) {
        const det = document.createElement('em'); det.textContent = m.detail;
        card.appendChild(det);
        if (m.needsRestart) {
          const warn = document.createElement('em'); warn.className = 'kbm-warn';
          warn.textContent = '这一档关掉的是 gateway 里的派发器，改完必须重启 gateway 才生效。';
          card.appendChild(warn);
        }
      }
      card.onclick = () => { if (busy) return; pick = m.id; draw(); };
      group.appendChild(card);
    });
    stage.appendChild(group);
    // 操作紧跟在卡片后面：三张卡 + 「应用」要能在首屏同时看到，
    // 生效值明细是可以滚着看的次要信息，不能把它们顶到折叠线以下。
    stage.appendChild(actions);

    // 明细是「现在生效的值」，不是「改完会变成的值」—— 不标清楚，
    // 选了全手动却看到 auto_decompose=开，会以为没生效。
    const factsLabel = document.createElement('div');
    factsLabel.className = 'set-row-hint';
    factsLabel.textContent = '当前生效值（不含尚未应用的改动）';
    stage.appendChild(factsLabel);

    const facts = document.createElement('div'); facts.className = 'kbm-facts';
    const rows = [
      ['自动分解', 'auto_decompose', state.autoDecompose ? '开' : '关', '下一轮 tick 生效'],
      ['派发器', 'dispatch_in_gateway', state.dispatchInGateway ? '开' : '关', '改动需重启 gateway'],
      ['子任务自动推进', 'auto_promote_children', state.autoPromoteChildren ? '开' : '关', ''],
      ['默认受让人', 'default_assignee', state.resolvedAssignee || state.defaultAssignee || '（跟随当前 profile）', ''],
    ];
    rows.forEach(([label, key, val, tip]) => {
      const r = document.createElement('div');
      const a = document.createElement('b'); a.textContent = label;
      const b = document.createElement('span'); b.textContent = key;
      const c = document.createElement('i'); c.textContent = val;
      r.append(a, b, c);
      if (tip) { const t = document.createElement('u'); t.textContent = tip; r.appendChild(t); }
      facts.appendChild(r);
    });
    stage.appendChild(facts);

    if (state.decomposeStranded) {
      const warn = document.createElement('div'); warn.className = 'kbm-warn';
      warn.textContent = '自动分解还开着，但派发器已停 —— 分解出来的卡只会堆在就绪队列里没人认领。';
      stage.appendChild(warn);
    }
    if (state.degraded) {
      const w = document.createElement('div'); w.className = 'kbm-warn';
      w.textContent = '看板后端暂不可用'
        + (state.restError ? `（${state.restError}）` : '')
        + '：上面是 config.yaml 里的值，可能与运行中 gateway 的实际状态不一致，此时切换也无法写入。';
      stage.appendChild(w);
    }

    applyBtn.disabled = busy || !pick || pick === state.mode;
    hint.textContent = pick && pick !== state.mode
      ? `将写入：${planLines(pick).replace(/\n/g, '；')}`
      : '当前没有待应用的改动';
  };

  const runApply = async (modeId) => {
    busy = true; applyBtn.disabled = true;
    status.classList.remove('is-error');
    status.textContent = '正在写入 CLI 配置…（派发器开关要冷启 CLI，约 5–10 秒）';
    let r = null;
    try { r = await api.kanbanSetMode(modeId); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    busy = false;
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '切换失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error');
      draw();
      return;
    }
    state = r.state || state;
    pick = state.mode;
    draw();
    if (hintEl) hintEl.textContent = r.needsRestart ? '已写入 CLI 配置 · 需重启 gateway' : '已写入 CLI 配置';
    // 看板页头那枚只读标记跟着更新：模式一变，卡会不会自己跑掉就变了
    try { kbLoadMode(); } catch {}
    if (r.needsRestart) {
      status.textContent = '已写入。需要重启 gateway 才生效：hermes gateway restart';
      toast('已保存，需重启 gateway 生效', 3200);
    } else {
      status.textContent = '已生效（下一轮 tick 生效，不用重启）';
      toast('看板编排已切换', 1800);
    }
  };

  applyBtn.onclick = () => {
    if (!state || busy || !pick || pick === state.mode) return;
    const m = (state.modes || []).find((x) => x.id === pick);
    if (!m) return;
    opConfirm(stage, {
      title: `把看板编排改成「${m.label}」？`,
      cmd: planLines(pick),
      note: m.dispatch
        ? '改的是 gateway 的自动派发行为，下一轮 tick 生效，不需要重启。'
        : '这一档会停掉 gateway 里的派发器：改完必须重启 gateway 才真正生效，且所有看板都不再自动派发。',
      confirmLabel: '确认切换',
      onGo: () => runApply(pick),
    });
  };

  const load = async () => {
    if (!isNativeCLI()) {
      status.textContent = '演示模式：需要桌面端原生环境读取编排开关。';
      return;
    }
    status.textContent = '正在读取当前模式…';
    let r = null;
    try { r = await api.kanbanOrchestration(); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error');
      return;
    }
    state = r;
    pick = r.mode;
    draw();
  };
  refresh.onclick = () => { if (!busy) load(); };
  await load();
}

async function renderCronPanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">定时任务</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);

  const bar = document.createElement('div'); bar.className = 'op-bar';
  const status = document.createElement('div'); status.className = 'mem-status';
  status.textContent = isNativeCLI() ? '正在读取调度器与任务…' : '演示模式：需要桌面端原生环境读取定时任务。';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新';
  bar.append(status, refresh); panel.appendChild(bar);

  const list = document.createElement('div'); list.className = 'op-list'; panel.appendChild(list);

  const runsWrap = document.createElement('div'); runsWrap.className = 'op-out'; runsWrap.hidden = true;
  panel.appendChild(runsWrap);

  const form = document.createElement('div'); form.className = 'op-form';
  const fTitle = document.createElement('div'); fTitle.className = 'pp-group-label'; fTitle.textContent = '新建任务';
  form.appendChild(fTitle);
  const schedIn = textField('30m / every 2h / 0 9 * * *', 64);
  const nameIn = textField('任务名称（可选）', 80);
  const promptIn = document.createElement('textarea');
  promptIn.className = 'set-input op-input op-textarea'; promptIn.placeholder = '任务内容（可选，自包含的提示词）';
  promptIn.spellcheck = false; promptIn.maxLength = 4000; promptIn.rows = 3;
  const fBtns = document.createElement('div'); fBtns.className = 'op-form-btns';
  const createBtn = document.createElement('button');
  createBtn.type = 'button'; createBtn.className = 'mk-btn primary'; createBtn.textContent = '创建（暂停）';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button'; clearBtn.className = 'mk-btn'; clearBtn.textContent = '清空';
  fBtns.append(createBtn, clearBtn);
  const presets = document.createElement('div');
  presets.className = 'op-form-btns';
  presets.style.marginBottom = '6px';
  for (const [label, val] of [['每 15 分钟', 'every 15m'], ['每小时', 'every 1h'], ['每天 9:00', '0 9 * * *'], ['工作日 9:00', '0 9 * * 1-5']]) {
    const pb = document.createElement('button');
    pb.type = 'button'; pb.className = 'mk-btn'; pb.textContent = label;
    pb.onclick = () => { schedIn.value = val; schedIn.focus(); };
    presets.appendChild(pb);
  }
  form.append(fieldRow('调度', '支持相对间隔、every 间隔与 5 段 cron 表达式。', schedIn),
    presets,
    fieldRow('名称', '', nameIn), fieldRow('内容', '每行会原样作为 CLI 的位置参数；不要以 - 开头。', promptIn), fBtns);
  guardFieldKey(schedIn, () => form.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(nameIn, () => form.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(promptIn, () => form.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  clearBtn.onclick = () => { schedIn.value = ''; nameIn.value = ''; promptIn.value = ''; form.querySelectorAll('.op-confirm').forEach((n) => n.remove()); };
  panel.appendChild(form);

  const note = document.createElement('div'); note.className = 'pf-note';
  note.textContent = '新建任务恒为暂停（--paused），需手动「恢复」才会按计划唤醒 agent。「立即运行」会真实触发一次模型回合并消耗额度；移除不可撤销。调度器由桌面端常驻后端驱动，关闭应用后任务不会触发。';
  panel.appendChild(note);

  let jobs = [];
  const draw = () => {
    list.innerHTML = '';
    const active = jobs.filter((j) => j.state === 'active').length;
    status.textContent = `${jobs.length} 个任务 · ${active} 个活跃` +
      (scheduler && scheduler.running ? ' · 调度器运行中' : ' · 调度器未就绪');
    status.classList.remove('is-error');
    if (!jobs.length) {
      const empty = document.createElement('div'); empty.className = 'op-empty';
      empty.textContent = '暂无定时任务。'; list.appendChild(empty); return;
    }
    jobs.forEach((j) => list.appendChild(cronCard(j)));
  };
  let scheduler = null;

  function kv(label, value, code) {
    if (!value) return null;
    const row = document.createElement('div'); row.className = 'op-kv';
    const k = document.createElement('span'); k.className = 'op-kv-k'; k.textContent = label;
    const v = document.createElement('span'); v.className = code ? 'op-code' : 'op-kv-v'; v.textContent = value;
    row.append(k, v); return row;
  }

  function cronCard(j) {
    const card = document.createElement('div'); card.className = 'op-card';
    const top = document.createElement('div'); top.className = 'op-card-top';
    const name = document.createElement('span'); name.className = 'op-name'; name.textContent = j.name;
    const badge = document.createElement('span');
    const stateMap = { active: '活跃', paused: '已暂停', completed: '已完成', disabled: '已停用' };
    badge.className = 'op-badge' + (j.state === 'active' ? ' on' : '');
    badge.textContent = stateMap[j.state] || j.state;
    top.append(name, badge); card.appendChild(top);
    const grid = document.createElement('div'); grid.className = 'op-grid';
    [kv('任务 ID', j.id, true), kv('调度', j.schedule), kv('下次运行', j.nextRun),
      kv('重复', j.repeat), kv('投递', j.deliver), kv('上次运行', j.lastRun)]
      .forEach((n) => { if (n) grid.appendChild(n); });
    card.appendChild(grid);
    const acts = document.createElement('div'); acts.className = 'op-acts';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'mk-btn';
    toggleBtn.textContent = j.state === 'active' ? '暂停' : '恢复';
    const runBtn = document.createElement('button');
    runBtn.type = 'button'; runBtn.className = 'mk-btn'; runBtn.textContent = '立即运行';
    const histBtn = document.createElement('button');
    histBtn.type = 'button'; histBtn.className = 'mk-btn'; histBtn.textContent = '运行历史';
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'mk-btn danger'; delBtn.textContent = '移除';
    acts.append(toggleBtn, runBtn, histBtn, delBtn);
    card.appendChild(acts);

    toggleBtn.onclick = () => opConfirm(card, {
      title: `${j.state === 'active' ? '暂停' : '恢复'}「${j.name}」？`,
      cmd: `hermes -p <current> cron ${j.state === 'active' ? 'pause' : 'resume'} ${j.id}`,
      note: j.state === 'active' ? '暂停后不再按计划触发，任务与配置保留。' : '恢复后会重新排入下一次触发时间。',
      confirmLabel: j.state === 'active' ? '确认暂停' : '确认恢复',
      onGo: () => write(() => api.cronAction(j.state === 'active' ? 'pause' : 'resume', j.id), '已更新', '操作失败'),
    });
    runBtn.onclick = () => opConfirm(card, {
      title: `立即运行「${j.name}」？`,
      cmd: `hermes -p <current> cron run ${j.id}`,
      note: '会真实触发一次完整的 agent 回合并消耗模型额度，最长等待 60 秒。',
      confirmLabel: '确认运行',
      onGo: () => write(() => api.cronAction('run', j.id), '已触发', '触发失败'),
    });
    delBtn.onclick = () => opConfirm(card, {
      title: `移除「${j.name}」？`,
      cmd: `hermes -p <current> cron remove ${j.id}`,
      note: '任务及其调度配置会被删除，此操作不可撤销。',
      confirmLabel: '确认移除',
      onGo: () => write(() => api.cronAction('remove', j.id), '已移除', '移除失败'),
    });
    histBtn.onclick = async () => {
      if (!isNativeCLI()) { toast('演示模式不可用', 1800); return; }
      histBtn.disabled = true; histBtn.textContent = '读取中…';
      let r;
      try { r = await api.cronRuns(j.id, 20); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!alive()) return;
      histBtn.disabled = false; histBtn.textContent = '运行历史';
      runsWrap.hidden = false; runsWrap.textContent = '';
      const t = document.createElement('div'); t.className = 'op-out-head';
      t.textContent = `${j.name} · 最近运行记录`; runsWrap.appendChild(t);
      if (!r || !r.ok) { runsWrap.appendChild(document.createTextNode('读取失败：' + ((r && r.error) || '未知错误'))); return; }
      const runs = arr(r.runs);
      if (!runs.length) { runsWrap.appendChild(document.createTextNode('暂无运行记录。')); return; }
      runs.forEach((x) => {
        const line = document.createElement('div'); line.className = 'op-run';
        line.textContent = `${x.at}  ${x.status}  ·  ${x.source}${x.error ? '  ·  ' + x.error : ''}`;
        runsWrap.appendChild(line);
      });
    };
    return card;
  }

  async function write(fn, okMsg, failMsg) {
    if (!isNativeCLI()) { toast('演示模式不可用', 1800); return false; }
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return false;
    if (!r || !r.ok) { toast(`${failMsg}：${(r && r.error) || '未知错误'}`, 3400); return false; }
    if (Array.isArray(r.jobs)) { jobs = r.jobs; draw(); }
    else await reload();
    toast(r.warning || okMsg, r.warning ? 3200 : 1600);
    return true;
  }

  const isValidSchedule = (v) => {
    if (!v || v.startsWith('-')) return false;
    if (/^(?:every\s+)?\d+\s*[smhd]$/i.test(v)) return true;
    const parts = v.split(/\s+/);
    return parts.length === 5 && parts.every((p) => /^[\d*,/-]+$/.test(p));
  };
  createBtn.onclick = () => {
    const sched = schedIn.value.trim();
    if (!isValidSchedule(sched)) {
      toast('调度格式无效：请填写如 30m、every 2h 或 5 段 cron（0 9 * * *）', 2600);
      schedIn.focus();
      return;
    }
    opConfirm(form, {
      title: '创建这个定时任务？',
      cmd: `hermes -p <current> cron create ${sched} --paused`,
      note: '任务以暂停状态创建，不会立刻运行；恢复后才会按调度唤醒 agent。',
      confirmLabel: '确认创建',
      onGo: async () => {
        const ok = await write(() => api.cronCreate({
          schedule: sched, name: nameIn.value.trim(), prompt: promptIn.value.trim(),
        }), '已创建（暂停）', '创建失败');
        if (ok) { schedIn.value = ''; nameIn.value = ''; promptIn.value = ''; }
        return ok;
      },
    });
  };

  async function reload() {
    if (!isNativeCLI()) { status.textContent = '演示模式：不做 CLI 调用。'; return; }
    status.textContent = '正在执行 hermes cron list --all / status…';
    let r;
    try { r = await api.cronOverview(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error'); return;
    }
    jobs = arr(r.jobs); scheduler = r.status || null; draw();
  }
  refresh.onclick = reload;
  await reload();
}
