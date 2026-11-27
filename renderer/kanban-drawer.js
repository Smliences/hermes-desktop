// 看板任务详情抽屉：编辑 / 日志 / 拆解 / 补规格 / 估算 / 评论 / 改派 / 删除
/* ---- 任务详情抽屉 ---- */
function kbDrawerNeighbors(id) {
  if (!id) return { prev: '', next: '', index: -1, total: 0 };
  const groups = kbGroups();
  for (const g of groups) {
    const list = g.tasks.some((x) => x.id === id) ? g.tasks
      : (g.all.some((x) => x.id === id) ? g.all : null);
    if (!list) continue;
    const idx = list.findIndex((x) => x.id === id);
    return {
      prev: idx > 0 ? list[idx - 1].id : '',
      next: idx >= 0 && idx < list.length - 1 ? list[idx + 1].id : '',
      index: idx,
      total: list.length,
    };
  }
  return { prev: '', next: '', index: -1, total: 0 };
}
function kbSyncDrawerNav() {
  const nav = $('#kbd-nav'), prev = $('#kbd-prev'), next = $('#kbd-next'), pos = $('#kbd-nav-pos');
  if (!nav) return;
  const info = kbDrawerNeighbors(KB.detailId);
  if (info.index < 0 || info.total <= 0) { nav.hidden = true; return; }
  nav.hidden = false;
  if (prev) prev.disabled = !info.prev;
  if (next) next.disabled = !info.next;
  if (pos) pos.textContent = `${info.index + 1}/${info.total}`;
}
function kbDrawerStep(dir) {
  if (!KB.detailId) return false;
  const info = kbDrawerNeighbors(KB.detailId);
  const target = dir < 0 ? info.prev : info.next;
  if (!target) return false;
  openKanbanTask(target);
  const card = document.querySelector(`#kb-scroll .kb-card[data-kb-task="${target}"]`);
  if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}
function kbdMoreToggle(open) {
  const btn = $('#kbd-more'), menu = $('#kbd-menu');
  const on = !!open;
  if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  if (menu) menu.hidden = !on;
}
function closeKanbanDrawer() {
  const d = $('#kb-drawer'), m = $('#kb-drawer-mask'), mw = $('#kbd-more-wrap'), nav = $('#kbd-nav');
  kbdMoreToggle(false);
  if (mw) mw.hidden = true;
  if (nav) nav.hidden = true;
  if (d) d.hidden = true;
  if (m) m.hidden = true;
  KB.detailEpoch += 1;
  KB.detailId = '';
  KB.detail = null;
  document.querySelectorAll('.kb-card.sel').forEach((el) => el.classList.remove('sel'));
}
async function openKanbanTask(id, silent) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return;
  if (KB.dispatch.open) kbDispatchToggle(false);
  kbdMoreToggle(false);
  const a = kbApi();
  const my = ++KB.detailEpoch;
  KB.detailId = id;
  KB.focusId = id;
  kbSyncDrawerNav();
  const d = $('#kb-drawer'), m = $('#kb-drawer-mask'), body = $('#kb-drawer-body');
  if (!d || !m || !body) return;
  d.hidden = false; m.hidden = false;
  document.querySelectorAll('.kb-card.sel').forEach((el) => el.classList.remove('sel'));
  const card = document.querySelector(`.kb-card[data-kb-task="${id}"]`);
  if (card) card.classList.add('sel');
  if (!silent) {
    const mw = $('#kbd-more-wrap');
    if (mw) mw.hidden = true;
    body.scrollTop = 0;
    body.innerHTML = '<div class="kbd-loading">读取任务详情…</div>';
  }
  if (!a || !a.kanbanTask) { body.innerHTML = '<div class="kbd-empty">需要 Hermes 桌面端才能读取任务详情</div>'; return; }
  try {
    const r = await a.kanbanTask(id, kbParams());
    if (my !== KB.detailEpoch || d.hidden) return;
    if (!r || !r.ok) { body.innerHTML = `<div class="kb-message">${esc((r && r.error) || '读取失败')}</div>`; return; }
    KB.detail = r;
    const editForm = $('#kbd-edit-form');
    const logBody = $('#kbd-log-body');
    const hasConfirm = !!body.querySelector('.op-confirm');
    const busyView = (editForm && !editForm.hidden) || (logBody && !logBody.hidden) || hasConfirm;
    if (silent && busyView) {
      if (!body.querySelector('#kbd-stale-hint')) {
        const hint = document.createElement('div');
        hint.id = 'kbd-stale-hint';
        hint.className = 'kb-message';
        hint.innerHTML = '任务有新动态，<button class="kbd-link" type="button" data-kb-refresh-detail="1">点此刷新</button>';
        body.prepend(hint);
      }
      return;
    }
    renderKanbanDetail(r);
  } catch (e) {
    if (my === KB.detailEpoch) body.innerHTML = `<div class="kb-message">${esc((e && e.message) || '读取失败')}</div>`;
  }
}
function kbdRow(label, value, time) {
  if (!value) return '';
  // 事件 payload 是对象：直接 String() 会拍成 "[object Object]"，日志就没意义了
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `<li class="kbd-row">${time ? `<time>${esc(time)}</time>` : ''}<b>${esc(label)}</b> ${esc(clip(text, 800))}</li>`;
}
/**
 * 运行中的卡片：点开抽屉最上方那块「profile 工作进度」。
 * 只读 task / runs / events 里已有的字段，不打额外接口 —— 卡片点开就能看到
 * 谁在跑（profile）、跑了多久、预算还剩多少、最近一步做了什么、这个 profile
 * 名下还有哪些卡在跑。秒表由 kbRunWatch 每秒推进，事件驱动的轮询再补文字。
 */
function kbRunPanel(t, d) {
  if (String((t && t.status) || '') !== 'running') return '';
  const start = kbRunStart(t);
  if (!start) return '';
  const limit = kbRunLimit(t);
  const elapsed = kbRunElapsed(start);
  const pct = kbRunPct(elapsed, limit).toFixed(1);
  const runs = Array.isArray(d && d.runs) ? d.runs : [];
  // 当前这次运行 = 状态还是 running 的最后一条；CLI 没给就退到最近一条
  const cur = runs.filter((r) => String((r && r.status) || '') === 'running').pop()
    || runs[runs.length - 1] || {};
  // profile 以 run.profile 为准（真正被拉起的 worker），没跑过 worker 时退回受让人
  const profile = String(cur.profile || t.assignee || '').trim();
  const facts = [];
  if (limit) facts.push(`上限 ${kbDur(limit)}`);
  const pg = t.progress;
  if (pg && Number(pg.total)) facts.push(`子任务 ${Number(pg.done) || 0}/${Number(pg.total)}`);
  const fails = Number(t.consecutive_failures) || 0;
  if (fails > 0) facts.push(`连续失败 ${fails} 次`);
  if (t.workspace_kind) facts.push(`工作区 ${String(t.workspace_kind)}`);
  const ev = (Array.isArray(d && d.events) && d.events.length) ? d.events[d.events.length - 1] : null;
  const evText = ev
    ? [
      String(ev.kind || 'event'),
      ev.payload ? clip(typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload), 160) : '',
      ev.created_at ? kbAgo(ev.created_at) : '',
    ].filter(Boolean).map((x) => esc(x)).join(' · ')
    : '';
  const summary = String(t.latest_summary || '').trim();
  const sibs = kbRunSiblings(t);
  const hot = limit && elapsed / limit >= 0.85;
  return `<div class="kbd-prog${hot ? ' is-hot' : ''}" data-kb-run="${start}" data-kb-run-max="${limit}">
    <div class="kbd-prog-head">
      <span class="kbd-prog-pulse" aria-hidden="true"></span>
      <span class="kbd-prog-who">${profile ? `<b>${esc(profile)}</b> 的工作进度` : '正在执行'}</span>
      ${cur.id ? `<span class="kbd-prog-run">运行 #${esc(String(cur.id))}</span>` : ''}
      <span class="kbd-prog-clock kb-run-txt">${esc(kbRunClockText(elapsed, limit))}</span>
    </div>
    ${limit ? `<div class="kbd-prog-bar kb-run-bar"><i style="width:${pct}%"></i></div>` : ''}
    ${facts.length ? `<div class="kbd-prog-facts">${facts.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
    ${evText ? `<div class="kbd-prog-now"><b>最近活动</b>${evText}</div>` : ''}
    ${summary ? `<div class="kbd-prog-now"><b>最新回报</b>${esc(clip(summary, 300))}</div>` : ''}
    ${sibs.length ? `<div class="kbd-prog-sibs">同 profile 还在跑 ${sibs.length} 张：
      ${sibs.map((x) => `<button class="kbd-link" type="button" data-kb-task="${esc(x.id)}">${esc(clip(String(x.title || x.id), 26))}</button>`).join('')}
    </div>` : ''}
  </div>`;
}
const kbDrafts = {};
function renderKanbanDetail(d) {
  const body = $('#kb-drawer-body');
  if (!body) return;
  const t = d.task || {};
  // 抽屉会随看板事件整体重渲染：先把手打了一半的评论存下来，渲染后填回，
  // 否则盯着运行进度时输入框会被一次同步清空。
  const draftEl = $('#kbd-comment-input');
  if (draftEl && t.id) kbDrafts[String(t.id)] = draftEl.value;
  const meta = [];
  // 与卡片一致：显示归组后的中文状态，CLI 原值留在 title 里，免得同一个 triage
  // 在卡片上叫「收集箱」、在抽屉里叫「triage」
  if (t.status) meta.push(`<span class="kb-chip st" title="CLI 状态：${esc(t.status)}">${esc(KB_STATUS_LABEL[t.status] || t.status)}</span>`);
  if (Number(t.priority)) { const pm = kbPriMeta(t.priority); meta.push(`<span class="kb-chip pri ${pm.cls}" title="${esc(pm.title)}">${pm.tag}</span>`); }
  if (t.assignee) meta.push(kbAssigneeChip(t.assignee));
  if (t.tenant) meta.push(`<span class="kb-chip">${esc(t.tenant)}</span>`);
  if (t.created_at) meta.push(`<span class="kb-chip">创建 ${esc(kbTime(t.created_at))}</span>`);
  if (t.completed_at) meta.push(`<span class="kb-chip">完成 ${esc(kbTime(t.completed_at))}</span>`);

  const jump = /^[A-Za-z0-9_-]{1,80}$/.test(String(t.session_id || ''))
    ? `<div class="kbd-section"><button class="kbd-link" type="button" data-kb-session="${esc(t.session_id)}">↗ 跳转到关联会话 ${esc(String(t.session_id).slice(0, 12))}…</button></div>` : '';
  // 工作区：worker 实际在哪干活。scratch/dir/worktree 三种；合进一张紧凑键值表
  const WS_KIND_LABEL = {
    scratch: '临时沙箱（scratch）',
    dir: '指定目录（dir）',
    worktree: 'git worktree（隔离副本）',
  };
  const projMap = {};
  for (const p of ((KB.overview && Array.isArray(KB.overview.projects)) ? KB.overview.projects : [])) {
    projMap[String(p.id || '')] = String(p.name || p.slug || '');
    projMap[String(p.slug || '')] = String(p.name || p.slug || '');
  }
  const wsRows = [
    ['类型', WS_KIND_LABEL[String(t.workspace_kind || 'scratch')] || String(t.workspace_kind || '')],
    ['路径', t.workspace_path ? String(t.workspace_path) : ''],
    ['分支', t.branch_name ? String(t.branch_name) : ''],
    ['项目', t.project_id ? (projMap[String(t.project_id)] || String(t.project_id)) : '（未绑定）'],
  ].filter((r) => r[1]);
  const wsHtml = `<div class="kbd-section"><h3>工作区</h3><dl class="kbd-kv">${
    wsRows.map((r) => `<div class="kbd-kv-row"><dt>${esc(r[0])}</dt><dd class="kbd-val">${esc(r[1])}</dd></div>`).join('')
  }</dl></div>`;
  const links = d.links || {};
  const linkTaskMap = new Map();
  for (const lt of (Array.isArray(d.linkTasks) ? d.linkTasks : [])) {
    if (lt && lt.id) linkTaskMap.set(String(lt.id), lt);
  }
  const renderLinkItem = (roleLabel, x) => {
    const lt = linkTaskMap.get(String(x));
    const title = lt && lt.title ? lt.title : x;
    const stTag = lt && lt.status ? ` <span class="kb-chip st">${esc(KB_STATUS_LABEL[lt.status] || lt.status)}</span>` : '';
    return `<li class="kbd-row">${roleLabel} <button class="kbd-link" type="button" data-kb-task="${esc(x)}">${esc(clip(String(title), 40))}</button>${stTag}</li>`;
  };
  const linkRows = [
    ...(links.parents || []).map((x) => renderLinkItem('父任务', x)),
    ...(links.children || []).map((x) => renderLinkItem('子任务', x)),
  ].join('');
  const childResults = (Array.isArray(d.childResults) ? d.childResults : []).map((c) => {
    const stTag = c.status ? ` <span class="kb-chip st">${esc(KB_STATUS_LABEL[c.status] || c.status)}</span>` : '';
    const sum = clip(String(c.latest_summary || c.result || ''), 240);
    return `<li class="kbd-row"><button class="kbd-link" type="button" data-kb-task="${esc(c.id)}">${esc(clip(String(c.title || c.id), 36))}</button>${stTag}${sum ? `<div>${esc(sum)}</div>` : ''}</li>`;
  }).join('');
  const comments = (d.comments || []).slice().reverse().map((c) =>
    kbdRow(String(c.author || 'agent') + '：', c.body, kbTime(c.created_at))).join('');
  const events = (d.events || []).slice().reverse().slice(0, 20).map((e) =>
    kbdRow(String(e.kind || 'event'), e.payload, kbTime(e.created_at))).join('');
  const runs = (d.runs || []).slice().reverse().map((r) => {
    const summary = [r.outcome, r.error].filter(Boolean).join(' · ');
    return `<li class="kbd-row">${r.started_at ? `<time>${esc(kbTime(r.started_at))}</time>` : ''}<button class="kbd-link" type="button" data-kb-run="${esc(r.id)}">#${esc(r.id)} ${esc(r.status || '')}</button>${summary ? ' ' + esc(clip(summary, 400)) : ''}<div class="kbd-run-detail" id="kbd-run-${esc(r.id)}" hidden></div></li>`;
  }).join('');
  const atts = (d.attachments || []).map((x) =>
    kbdRow('附件', `${x.filename} (${Number(x.size) || 0} B)`)).join('');
  const canDelete = /^t_[A-Za-z0-9_-]{1,64}$/.test(String(t.id || ''));
  const mw = $('#kbd-more-wrap');
  if (mw) mw.hidden = !canDelete;
  const canSubmit = canDelete && KB_DP_SUBMITTABLE.includes(String(t.status || ''));
  const dispatchAct = canSubmit
    ? `<div class="kbd-actions" id="kbd-actions"><button class="kb-btn kb-btn-accent" type="button" data-kb-submit="${esc(t.id)}" title="推进到 ready，等待调度器认领">⚡ 提交派发</button></div>` : '';
  const curSt = String(t.status || '');
  const isTriage = curSt === 'triage';
  const curGroup = KB_GROUPS.find((g) => g.statuses.includes(curSt));
  const moveRow = canDelete && curGroup
    ? `<div class="kbd-actions" id="kbd-actions-move"><span>移到</span>${
        KB_GROUPS.filter((g) => g.key !== curGroup.key).map((g) => {
          const verb = KB_GROUP_STATUS[g.key] || '';
          return `<button class="kb-btn" type="button" data-kb-move="${esc(verb)}" title="${esc(KB_STATUS_ACTION[verb] || g.label)}">${esc(g.label)}</button>`;
        }).join('')
      }</div>`
    : '';
  const specifyAct = canDelete && isTriage
    ? `<div class="kbd-actions" id="kbd-actions-specify">
        <button class="kb-btn" type="button" data-kb-specify="${esc(t.id)}"${KB.specifyBusy ? ' disabled' : ''} title="让辅助模型把这句随手记补成 Goal / Approach / 验收标准，并推进到待办（会产生费用）">✎ 补规格</button>
        <span class="kbd-act-note">${KB.specifyBusy ? '补规格中…最长 2 分钟' : ''}</span>
      </div>` : '';
  const estView = KB.estimate[String(t.id || '')];
  const estimateAct = canDelete
    ? `<div class="kbd-actions" id="kbd-actions-estimate">
        <button class="kb-btn" type="button" data-kb-estimate="${esc(t.id)}"${KB.estimateBusy ? ' disabled' : ''} title="按「读文件 + 工具调用 + 改代码 + 重试」估一次 token 量级（约几百 token 开销，不改任务）">⌛ 估算</button>
        <span class="kbd-act-note" id="kbd-estimate-note">${estView ? esc(kbEstimateLine(estView)) : (KB.estimateBusy ? '估算中…' : '')}</span>
      </div>` : '';
  const decomposeAct = canDelete && isTriage
    ? `<div class="kbd-actions" id="kbd-actions-decompose">
        <button class="kb-btn" type="button" data-kb-decompose="${esc(t.id)}"${KB.decomposeBusy ? ' disabled' : ''} title="${KB.mode && KB.mode.mode === 'auto'
          ? '让辅助模型把这张卡拆成子任务图并按 profile 分派（会产生费用；自动编排本来也会拆）'
          : '让辅助模型把这张卡拆成子任务图并按 profile 分派（会产生费用）'}">⚗ 拆解</button>
        <span class="kbd-act-note">${KB.decomposeBusy ? '拆解中…最长 3 分钟' : ''}</span>
      </div>` : '';
  const actBar = [estimateAct, specifyAct, decomposeAct, dispatchAct].filter(Boolean).join('');
  // 改派：拖拽的等价入口（拖拽仍在，但抽屉里要有不靠鼠标的路径）。
  // done / archived 再改派没有意义，直接不显示。
  const canReassign = canDelete && !['done', 'archived'].includes(String(t.status || ''));
  const reassignAct = canReassign
    ? `<div class="kbd-section" id="kbd-reassign"><h3>改派受让人</h3>
        <div class="kbd-reassign">
          <hm-select id="kbd-assignee" class="ui-select" aria-label="改派受让人"></hm-select>
          <button class="kb-btn" type="button" data-kb-reassign="${esc(t.id)}">保存改派</button>
        </div>
        <div class="kbd-reassign-note" id="kbd-reassign-note">受让人 = profile 名（<code>hermes -p &lt;名字&gt;</code>），留空取消指派。</div>
      </div>` : '';
  // 评论输入：追加文本、不计费、不改状态；发布仍过一次确认（与全部写操作一致）。
  const commentBox = canDelete
    ? `<div class="kbd-comment-box" id="kbd-comment-box">
        <textarea id="kbd-comment-input" rows="3" maxlength="4000"
          placeholder="给这张卡写条评论（worker 与看板都会看到）…"></textarea>
        <div class="kbd-comment-foot">
          <span class="kbd-hint">追加一条文本 · 不计费 · 不改状态</span>
          <button class="kb-btn" type="button" data-kb-comment="${esc(t.id)}">发布评论</button>
        </div>
      </div>` : '';

  body.innerHTML = `
    <div class="kbd-eyebrow"><span class="kbd-id">${esc(t.id || '')}</span><div class="kbd-meta">${meta.join('')}</div></div>
    <div class="kbd-title-row">
      <h2 class="kbd-title">${esc(t.title || '(无标题)')}</h2>
      ${canDelete ? `<button class="kb-btn kbd-edit-btn" type="button" data-kb-edit="${esc(t.id)}">✎ 编辑</button>` : ''}
    </div>
    ${canDelete ? `<div class="kbd-edit-form" id="kbd-edit-form" hidden>
      <label class="kb-frow"><span>标题</span><input id="kbd-edit-title" type="text" maxlength="200" value="${esc(t.title || '')}" /></label>
      <label class="kb-frow"><span>优先级</span><hm-select id="kbd-edit-priority" class="ui-select"><option value="0">P4 · 普通（默认）</option><option value="1">P3 · 低优先级</option><option value="2">P2 · 中优先级</option><option value="3">P1 · 高优先级</option><option value="10">P0 · 最紧急</option></hm-select></label>
      <label class="kb-frow"><span>描述</span><textarea id="kbd-edit-body" rows="4" maxlength="20000">${esc(t.body || '')}</textarea></label>
      <div class="kbd-actions">
        <button class="kb-btn primary" type="button" data-kb-edit-save="${esc(t.id)}">保存修改</button>
        <button class="kb-btn" type="button" data-kb-edit-cancel="1">取消</button>
      </div>
    </div>` : ''}
    ${kbRunPanel(t, d)}
    ${actBar ? `<div class="kbd-act-bar">${actBar}</div>` : ''}
    ${canDelete ? '<div class="kbd-danger" id="kbd-danger"></div>' : ''}
    ${moveRow}
    ${reassignAct}
    ${wsHtml}
    ${jump}
    ${t.body ? `<div class="kbd-section"><h3>描述</h3><div class="kbd-text md">${typeof renderMarkdown === 'function' ? renderMarkdown(clip(t.body, 20000)) : esc(clip(t.body, 20000))}</div></div>` : ''}
    ${t.result || t.latest_summary ? `<div class="kbd-section"><h3>结果 / 交接</h3><div class="kbd-text md">${typeof renderMarkdown === 'function' ? renderMarkdown(clip(t.result || t.latest_summary, 20000)) : esc(clip(t.result || t.latest_summary, 20000))}</div></div>` : ''}
    <div class="kbd-section"><h3>依赖 (${(links.parents || []).length + (links.children || []).length})</h3>
      ${linkRows ? `<ul class="kbd-list">${linkRows}</ul>` : '<div class="kbd-empty">无父子依赖</div>'}</div>
    ${childResults ? `<div class="kbd-section"><h3>子任务结果 (${(d.childResults || []).length})</h3><ul class="kbd-list">${childResults}</ul></div>` : ''}
    <div class="kbd-section"><h3>评论 (${(d.comments || []).length})</h3>
      ${comments ? `<ul class="kbd-list">${comments}</ul>` : '<div class="kbd-empty">暂无评论</div>'}
      ${commentBox}</div>
    <div class="kbd-section"><h3>运行记录 (${(d.runs || []).length})</h3>
      ${runs ? `<ul class="kbd-list">${runs}</ul>` : '<div class="kbd-empty">尚无运行记录</div>'}</div>
    <div class="kbd-section">
      <div class="kbd-log-head"><h3>执行日志</h3><button class="kb-btn kbd-log-btn" type="button" data-kb-log="${esc(t.id)}">查看日志</button></div>
      <div class="kbd-empty" id="kbd-log-meta">按需读取 worker stdout/stderr 尾部输出</div>
      <pre class="kbd-log" id="kbd-log-body" hidden></pre>
    </div>
    ${atts ? `<div class="kbd-section"><h3>附件</h3><ul class="kbd-list">${atts}</ul></div>` : ''}
    <div class="kbd-section"><h3>最近事件</h3>
      ${events ? `<ul class="kbd-list">${events}</ul>` : '<div class="kbd-empty">暂无事件</div>'}</div>`;

  // 改派下拉的候选：磁盘上真实存在的 profile 优先；当前受让人即使不在清单里也要能显示出来
  const editPri = $('#kbd-edit-priority');
  if (editPri && canDelete) {
    const curPri = String(Number(t.priority) || 0);
    const items = KB_PRI_OPTIONS.map(([v, l]) => ({ value: v, label: l }));
    if (!KB_PRI_OPTIONS.some(([v]) => v === curPri)) items.push({ value: curPri, label: `${kbPriMeta(curPri).tag}（权重 ${curPri}）` });
    if (editPri.setOptions) editPri.setOptions(items);
    editPri.value = curPri;
  }
  const sel = $('#kbd-assignee');
  if (sel && canReassign) {
    const cur = String(t.assignee || '');
    const names = [...new Set([...(cur ? [cur] : []), ...[...kbProfileSet()].sort()])];
    const items = names.map((n) => ({
      value: n,
      label: kbProfileSet().has(n) || !kbProfileSet().size ? n : `${n}（非 profile）`,
    }));
    if (sel.setOptions) sel.setOptions(items, cur ? '取消指派（留空）' : '未指派 · 选择 profile');
    if (cur) sel.value = cur;
  }
  // 草稿填回（只在重渲染之间保命，发送成功后由提交处清掉）
  const draftBox = $('#kbd-comment-input');
  const draft = kbDrafts[String(t.id || '')];
  if (draftBox && draft) draftBox.value = draft;
  // running 才需要秒表；渲染完立刻推一次，避免首帧停在模板里的 0:00
  if (String(t.status || '') === 'running') kbRunWatch();
}
/**
 * 拆解此任务（抽屉里的 ⚗ 按钮）。
 *
 * 这条链路是桌面端唯一会花 LLM 钱的写操作，所以三道闸：
 *   ① 只在收集箱（triage）任务上出现 —— 后端对其余状态直接 ok:false；
 *   ② 点击先出确认卡，写清「调辅助模型 / 会计费 / 最长 3 分钟」；
 *   ③ 服务层再独立校验 confirm === true，任何顺手调用都发不出请求。
 * 在途期间按钮禁用 + 全局 KB.decomposeBusy，避免连点拆两次、计两份费。
 */
async function kbSaveTaskEdit(taskId) {
  const id = String(taskId || '');
  const a = kbApi();
  if (!a || !a.kanbanUpdateTask) { toast('此页需要 Hermes 桌面端才能编辑任务', 1800); return; }
  const titleEl = $('#kbd-edit-title'), priEl = $('#kbd-edit-priority'), bodyEl = $('#kbd-edit-body');
  const title = titleEl ? titleEl.value.trim() : '';
  if (!title) { toast('任务标题不能为空', 2000); if (titleEl) titleEl.focus(); return; }
  const priRaw = priEl ? Number(priEl.value) : 0;
  const priority = Number.isFinite(priRaw) ? Math.max(0, Math.min(100, Math.round(priRaw))) : 0;
  const body = bodyEl ? bodyEl.value : '';
  const saveBtn = document.querySelector('[data-kb-edit-save]');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const r = await a.kanbanUpdateTask(id, { board: KB.filters.board || '', title, priority, body });
    if (!r || !r.ok) {
      toast('保存失败：' + ((r && r.error) || '未知错误'), 2800);
      if (saveBtn && saveBtn.isConnected) saveBtn.disabled = false;
      return;
    }
    const ef = $('#kbd-edit-form');
    if (ef) ef.hidden = true;
    toast('任务已更新', 1600);
    await kanbanLoad(true);
    await openKanbanTask(id, true);
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || '未知错误'), 2800);
    if (saveBtn && saveBtn.isConnected) saveBtn.disabled = false;
  }
}

async function kbLoadTaskLog(taskId) {
  const id = String(taskId || '');
  const a = kbApi();
  const meta = $('#kbd-log-meta'), pre = $('#kbd-log-body'), btn = document.querySelector('[data-kb-log]');
  if (!a || !a.kanbanTaskLog) { toast('此页需要 Hermes 桌面端才能读取日志', 1800); return; }
  if (btn) btn.disabled = true;
  if (meta) meta.textContent = '读取日志中…';
  try {
    const r = await a.kanbanTaskLog(id, { board: KB.filters.board || '', tail: 32768 });
    if (!r || !r.ok) {
      if (meta) meta.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      return;
    }
    if (!r.exists || !r.content) {
      if (meta) meta.textContent = '暂无执行日志（任务可能尚未启动过 worker）';
      if (pre) { pre.hidden = true; pre.textContent = ''; }
    } else {
      if (meta) meta.textContent = `日志大小 ${r.sizeBytes} B${r.truncated ? '（已截取末尾 32 KB）' : ''}`;
      if (pre) {
        const wasHidden = pre.hidden;
        const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48;
        pre.hidden = false;
        pre.textContent = r.content;
        if (wasHidden || nearBottom) pre.scrollTop = pre.scrollHeight;
      }
    }
    if (btn && btn.isConnected) btn.textContent = '刷新日志';
  } catch (e) {
    if (meta) meta.textContent = '读取失败：' + ((e && e.message) || '未知错误');
  } finally {
    if (btn && btn.isConnected) btn.disabled = false;
  }
}

function kbDecomposeTask(taskId, host) {
  const id = String(taskId || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  if (KB.decomposeBusy) { toast('已经有一次拆解在进行中', 1600); return; }
  const a = kbApi();
  if (!host || !a || !a.kanbanDecompose) { toast('此页需要 Hermes 桌面端才能拆解任务', 1800); return; }
  opConfirm(host, {
    title: '拆解这张任务？',
    cmd: `POST /api/plugins/kanban/tasks/${id}/decompose`,
    note: '会调用 CLI 的辅助模型（auxiliary.kanban_decomposer）把这张卡拆成一棵子任务图，'
      + '按各 profile 的描述分派。这一步会消耗 token 并计费，最长可能跑 3 分钟。'
      + '拆完根任务会离开收集箱，子任务出现在各列；如果模型判断它本来就是单一任务，'
      + '就只改写标题与规格、留在原地。',
    confirmLabel: '开始拆解',
    onGo: async () => {
      const act = $('#kbd-actions-decompose');
      const note = act && act.querySelector('.kbd-act-note');
      const btn = act && act.querySelector('[data-kb-decompose]');
      const say = (text, bad) => {
        if (!note) return;
        note.textContent = text;
        note.classList.toggle('warn', !!bad);
      };
      KB.decomposeBusy = true;
      if (btn) btn.disabled = true;
      say('拆解中…最长 3 分钟，可以先去别的列看看', false);
      try {
        const r = await a.kanbanDecompose(id, { board: KB.filters.board || '', confirm: true });
        if (!r || !r.ok) {
          const why = (r && (r.reason || r.error)) || '未知原因';
          say('拆解未完成：' + why, true);
          toast('拆解未完成：' + why, 3200);
          return;
        }
        if (r.fanout && r.childIds && r.childIds.length) {
          toast(`已拆成 ${r.childIds.length} 个子任务：${r.childIds.join('、')}`, 3600);
        } else if (r.single) {
          toast(r.newTitle ? `模型判断这已是单一任务，标题改为「${r.newTitle}」` : '模型判断这已是单一任务，已改写规格', 3600);
        } else {
          toast('拆解完成，但模型没有给出子任务', 3000);
        }
        await kanbanLoad(true);       // 写后回读：根任务换列 + 子任务出现在各列
        await openKanbanTask(id, true); // 抽屉保持打开，依赖区能看到新建的子任务
      } catch (e) {
        const why = (e && e.message) || '未知错误';
        say('拆解失败：' + why, true);
        toast('拆解失败：' + why, 3000);
      } finally {
        KB.decomposeBusy = false;
        // 抽屉可能已被重绘（按钮是新的），禁用态由渲染时读 KB.decomposeBusy 决定，
        // 这里只兜底恢复仍挂在 DOM 上的那个旧节点
        if (btn && btn.isConnected) btn.disabled = false;
      }
    },
  });
}

/**
 * 估算结果的一行文案：`复杂度 M · 约 4.2 万 tokens · 要改两三处并补测试`。
 * 空字段一律跳过 —— CLI 的 complexity / rationale 都可能是 null。
 */
function kbKilo(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v >= 10000) return String(Math.round(v / 1000) / 10) + ' 万';
  if (v >= 1000) return String(Math.round(v / 100) / 10) + 'k';
  return String(v);
}
function kbEstimateLine(e) {
  const o = e && typeof e === 'object' ? e : {};
  const parts = [];
  if (o.complexity) parts.push(`复杂度 ${o.complexity}`);
  if (Number(o.estTokens) > 0) parts.push(`约 ${kbKilo(o.estTokens)} tokens`);
  const head = parts.join(' · ') || '估算完成';
  return o.rationale ? `${head} · ${o.rationale}` : head;
}

/**
 * 补规格（抽屉里的 ✎ 按钮）：把收集箱里的一句话扩成可执行的 spec，
 * **CLI 会顺手把任务推进到待办**（triage → todo），所以它是「写数据 + 计费」双属性。
 * 与拆解同样的三道闸：只认 triage、点击先过确认卡、服务层再校验 confirm === true。
 */
function kbSpecifyTask(taskId, host) {
  const id = String(taskId || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  if (KB.specifyBusy) { toast('已经有一次补规格在进行中', 1600); return; }
  const a = kbApi();
  if (!host || !a || !a.kanbanSpecify) { toast('此页需要 Hermes 桌面端才能补规格', 1800); return; }
  opConfirm(host, {
    title: '让模型补全这张卡的规格？',
    cmd: `POST /api/plugins/kanban/tasks/${id}/specify`,
    note: '会调用 CLI 的辅助模型（auxiliary.triage_specifier）把标题收紧、正文补成 '
      + 'Goal / Approach / 验收标准 / 不做的事 四段，然后把任务从收集箱推进到待办。'
      + '这一步会消耗 token 并计费，最长约 2 分钟。模型只补全、不改需求；'
      + '原文已经写得够细时只重排格式。',
    confirmLabel: '开始补规格',
    onGo: async () => {
      const act = $('#kbd-actions-specify');
      const note = act && act.querySelector('.kbd-act-note');
      const btn = act && act.querySelector('[data-kb-specify]');
      const say = (text, bad) => {
        if (!note) return;
        note.textContent = text;
        note.classList.toggle('warn', !!bad);
      };
      KB.specifyBusy = true;
      if (btn) btn.disabled = true;
      say('补规格中…最长 2 分钟', false);
      try {
        const r = await a.kanbanSpecify(id, { board: KB.filters.board || '', confirm: true });
        if (!r || !r.ok) {
          const why = (r && (r.reason || r.error)) || '未知原因';
          say('补规格未完成：' + why, true);
          toast('补规格未完成：' + why, 3200);
          return;
        }
        toast(r.newTitle
          ? `已补规格并推进到待办，标题改为「${r.newTitle}」`
          : '已补规格并推进到待办', 3600);
        await kanbanLoad(true);        // 状态变了：收集箱少一张、待办多一张
        await openKanbanTask(id, true); // 抽屉保持打开，能看到新正文
      } catch (e) {
        const why = (e && e.message) || '未知错误';
        say('补规格失败：' + why, true);
        toast('补规格失败：' + why, 3000);
      } finally {
        KB.specifyBusy = false;
        if (btn && btn.isConnected) btn.disabled = false;
      }
    },
  });
}

/**
 * 估算工作量（抽屉里的 ⌛ 按钮）：只读一次辅助模型，返回 token 量级 + S/M/L。
 * 不改任何字段，所以不需要回读看板，只把结果就地写进说明行并缓存。
 */
function kbEstimateTask(taskId, host) {
  const id = String(taskId || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  if (KB.estimateBusy) { toast('已经有一次估算在进行中', 1600); return; }
  const a = kbApi();
  if (!host || !a || !a.kanbanEstimate) { toast('此页需要 Hermes 桌面端才能估算', 1800); return; }
  opConfirm(host, {
    title: '估一下这张卡有多大？',
    cmd: `POST /api/plugins/kanban/tasks/${id}/estimate`,
    note: '会调用一次辅助模型（kanban_estimator）估出整轮 agent run 的 token 量级与 S/M/L 复杂度。'
      + '只花几百 token，是三条计费路径里最便宜的，并且不会修改任何字段 —— 这张卡还是原样。',
    confirmLabel: '开始估算',
    onGo: async () => {
      const act = $('#kbd-actions-estimate');
      const note = act && (act.querySelector('#kbd-estimate-note') || act.querySelector('.kbd-act-note'));
      const btn = act && act.querySelector('[data-kb-estimate]');
      const say = (text, bad) => {
        if (!note) return;
        note.textContent = text;
        note.classList.toggle('warn', !!bad);
      };
      KB.estimateBusy = true;
      if (btn) btn.disabled = true;
      say('估算中…最长 1 分钟', false);
      try {
        const r = await a.kanbanEstimate(id, { board: KB.filters.board || '', confirm: true });
        if (!r || !r.ok) {
          const why = (r && (r.reason || r.error)) || '未知原因';
          say('估算没成功：' + why, true);
          toast('估算没成功：' + why, 3000);
          return;
        }
        const view = {
          estTokens: Math.max(0, Math.round(Number(r.estTokens || r.est_tokens) || 0)),
          complexity: String(r.complexity || ''),
          rationale: String(r.rationale || ''),
          model: String(r.model || ''),
        };
        KB.estimate[id] = view; // 同一张卡重开抽屉不必再花一次钱
        say(kbEstimateLine(view), false);
        toast('估算完成：' + kbEstimateLine(view), 3000);
      } catch (e) {
        const why = (e && e.message) || '未知错误';
        say('估算失败：' + why, true);
        toast('估算失败：' + why, 3000);
      } finally {
        KB.estimateBusy = false;
        if (btn && btn.isConnected) btn.disabled = false;
      }
    },
  });
}

/**
 * 发布评论（抽屉评论区）：追加文本，不计费、不改状态、永不覆盖已有内容。
 * 与其余写操作一致，发布前过一次确认卡（写清「作者记为 dashboard」）；
 * 成功后重读任务详情，评论列表就地刷新。
 */
function kbAddComment(taskId) {
  const id = String(taskId || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  const input = $('#kbd-comment-input');
  const box = $('#kbd-comment-box');
  const text = input ? String(input.value || '').trim() : '';
  if (!text) { toast('先写点什么再发布', 1600); if (input) input.focus(); return; }
  const a = kbApi();
  // 确认卡挂在评论框内：抽屉很长，挂 body 末尾会掉到可视区外
  const host = box || $('#kb-drawer-body');
  if (!host || !a || !a.kanbanAddComment) { toast('此页需要 Hermes 桌面端才能发评论', 1800); return; }
  const clip = text.length > 60 ? text.slice(0, 60) + '…' : text;
  opConfirm(host, {
    title: '发布这条评论？',
    cmd: `POST /api/plugins/kanban/tasks/${id}/comments`,
    note: `追加一条评论（作者记为 dashboard）：「${clip}」。不计费、不改状态，发布后不能撤回。`,
    confirmLabel: '发布评论',
    onGo: async () => {
      const btn = box && box.querySelector('[data-kb-comment]');
      if (btn) btn.disabled = true;
      try {
        const r = await a.kanbanAddComment(id, { board: KB.filters.board || '', body: text });
        if (!r || !r.ok) {
          toast('评论没发出去：' + ((r && r.error) || '未知错误'), 3000);
          if (btn && btn.isConnected) btn.disabled = false;
          return;
        }
        toast('评论已发布', 1600);
        // 先清空输入框再重读：否则 renderKanbanDetail 会把刚发出去的内容又当草稿存回来
        const sent = $('#kbd-comment-input');
        if (sent) sent.value = '';
        delete kbDrafts[String(id)]; // 发出去了就不再当草稿保留
        await openKanbanTask(id, true); // 重读详情，评论列表就地刷新
      } catch (e) {
        toast('评论失败：' + ((e && e.message) || '未知错误'), 3000);
        if (btn && btn.isConnected) btn.disabled = false;
      }
    },
  });
}

/** 抽屉里的「保存改派」：只写 assignee，不推进状态（推进 ready 走「提交派发」）。 */
async function kbReassignTask(taskId, host) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(taskId || ''))) return;
  const sel = $('#kbd-assignee'), note = $('#kbd-reassign-note');
  const name = sel ? String(sel.value || '').trim() : '';
  const say = (text, bad) => {
    if (!note) return;
    note.textContent = text;
    note.classList.toggle('warn', !!bad);
  };
  if (name && !KB_ASSIGNEE_RE.test(name)) {
    say('受让人必须是合法的 profile 名（字母或数字开头，可含 . _ -）', true);
    return;
  }
  const a = kbApi();
  if (!a || !a.kanbanReassign) { say('此页需要桌面端才能改派', true); return; }
  const btn = host && host.querySelector('[data-kb-reassign]');
  if (btn) btn.disabled = true;
  try {
    const r = await a.kanbanReassign(taskId, { assignee: name, board: KB.filters.board || '' });
    if (!r || !r.ok) { say('改派失败：' + ((r && r.error) || '未知错误'), true); return; }
    say(name ? `已改派给 ${name}` : '已取消指派', false);
    await kanbanLoad(true);          // 写后回读：卡片受让人 chip 跟着变
    await openKanbanTask(taskId, true); // 抽屉保持打开，内容刷新
  } catch (e) {
    say('改派失败：' + ((e && e.message) || '未知错误'), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
function kbJumpToSession(sid) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(sid || ''))) return;
  closeKanbanPage();
  try { openSession(String(sid)); toast('已跳转到关联会话', 1400); }
  catch (e) { toast('跳转失败：' + (e.message || ''), 1800); }
}

/* ---- 删除任务（二次确认卡） ---- */
function kbDeleteTask(id, host) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return;
  const a = kbApi();
  if (!host || !a || !a.kanbanDeleteTask) { toast('此页需要 Hermes 桌面端才能删除任务', 1800); return; }
  opConfirm(host, {
    title: '删除这个任务？',
    cmd: `DELETE /api/plugins/kanban/tasks/${id}`,
    note: '任务、评论、事件与依赖关系会从 CLI 的 kanban.db 一起移除，不可撤销。不会改动 CLI 配置，也不会停止任何正在运行的 worker。',
    confirmLabel: '确认删除',
    onGo: async () => {
      const r = await a.kanbanDeleteTask(id, kbParams());
      if (!r || !r.ok) { toast('删除失败：' + ((r && r.error) || '未知错误'), 2600); return; }
      closeKanbanDrawer();
      toast('任务已删除', 1600);
      await kanbanLoad(true); // 写后回读
    },
  });
}
