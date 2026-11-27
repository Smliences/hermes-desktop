// 看板派发控制台：试运行 / 二次确认 / 真派发
/* ---- 派发控制台：试运行 → 二次确认 → 真派发 → 写后回读 ---- */
const KB_DP_SUBMITTABLE = ['triage', 'todo', 'scheduled', 'blocked', 'review'];
function kbDpState(text, cls) {
  const el = $('#kb-dp-state');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'kb-dp-state' + (cls ? ' ' + cls : '');
}
function kbDpClearConfirm() {
  const host = $('#kb-dp-confirm');
  if (host) host.querySelectorAll('.op-confirm').forEach((n) => n.remove());
}
/**
 * 派发容量：CLI 的 max_spawn 是「本看板并发上限（running + 本次）」，不是本次批量。
 * 所以先按本地上限减去已在跑的 worker，算出本次真正能新增几个。
 */
function kbDispatchCapacity() {
  // 上限语义与 CLI dispatch_once 对齐：max_spawn 是「本看板并发上限（running + 本次）」，
  // CLI 的 POST /dispatch 默认 max=8，这里不再人为砍到 4；本地上限只截到 8。
  const max = Math.max(1, Math.min(8, Number($('#kb-dp-max') && $('#kb-dp-max').value) || 1));
  const tasks = KB.board ? (KB.board.columns || []).flatMap((c) => c.tasks || []) : [];
  const running = tasks.filter((t) => String(t.status || '') === 'running').length;
  const ready = tasks.filter((t) => {
    const s = String(t.status || '');
    return (s === 'ready' || s === 'review') && !!t.assignee;
  });
  const candidates = [...new Set(ready.map((t) => String(t.assignee)))];
  const nonProfiles = candidates.filter((a) => !kbIsProfile(a));
  return { max, running, room: Math.max(0, max - running), ready: ready.length, candidates, nonProfiles };
}
function kbRenderCapacity() {
  const host = $('#kb-dp-cap');
  const run = $('#kb-dp-run');
  if (!host) return;
  const c = kbDispatchCapacity();
  const bits = [
    `并发上限 ${c.max}`,
    `当前在跑 ${c.running}`,
    c.room ? `本次最多新增 ${c.room}` : '并发已满，本次不会启动新 worker',
  ];
  if (c.ready) bits.push(`ready/待复审 ${c.ready} 张（受让人 ${c.candidates.join(' / ')}）`);
  if (c.nonProfiles.length) bits.push(`其中 ${c.nonProfiles.join(' / ')} 不是 profile，会被跳过`);
  host.textContent = bits.join(' · ');
  host.classList.toggle('warn', !c.room || c.nonProfiles.length > 0);
  if (run) {
    const blocked = !c.room;
    run.disabled = blocked;
    run.title = blocked
      ? `本看板已有 ${c.running} 个 worker 在跑，达到并发上限 ${c.max}；调高上限或等它们结束后再派发`
      : '';
  }
}
function kbDispatchToggle(show) {
  const panel = $('#kb-dispatch-panel'), mask = $('#kb-dp-mask');
  const on = !!show;
  if (on) closeKanbanDrawer();
  KB.dispatch.open = on;
  KB.dispatch.epoch += 1; // 收起时作废所有在途响应
  kbDpClearConfirm();
  if (panel) panel.hidden = !on;
  if (mask) mask.hidden = !on;
  // 菜单项是唯一的入口（页头按钮已收进「⋯」），它的文字跟着开合状态走
  const item = document.querySelector('#kb-more-menu [data-kb-more="dispatch"]');
  if (item) {
    item.setAttribute('aria-expanded', on ? 'true' : 'false');
    item.textContent = on ? '收起派发控制台' : '手动派发控制台';
  }
  if (on) { kbDpState('控制台已就绪', ''); kbDispatchLoadWorkers(); kbRenderCapacity(); }
  else { kbDpState('', ''); KB.dispatch.busy = false; }
}
async function kbDispatchLoadWorkers() {
  const host = $('#kb-dp-workers');
  if (!host || !KB.dispatch.open) return;
  const a = kbApi(), my = KB.dispatch.epoch;
  if (!a || !a.kanbanActiveWorkers) {
    host.innerHTML = '<div class="kb-dp-empty">需要 Hermes 桌面端才能读取活跃 worker。</div>';
    return;
  }
  try {
    const r = await a.kanbanActiveWorkers({ board: KB.filters.board || undefined });
    if (my !== KB.dispatch.epoch || !KB.dispatch.open) return;
    renderDispatchWorkers(r);
  } catch (e) {
    if (my === KB.dispatch.epoch) host.innerHTML = `<div class="kb-dp-empty">${esc((e && e.message) || '读取失败')}</div>`;
  }
}
function renderDispatchWorkers(r) {
  const host = $('#kb-dp-workers');
  if (!host) return;
  if (!r || !r.ok) {
    host.innerHTML = `<div class="kb-dp-empty">${esc((r && r.error) || '读取活跃 worker 失败')}</div>`;
    return;
  }
  const ws = Array.isArray(r.workers) ? r.workers : [];
  if (!ws.length) {
    host.innerHTML = '<div class="kb-dp-empty">当前没有运行中的 worker。派发成功后这里会列出新启动的执行记录。</div>';
    return;
  }
  host.innerHTML = ws.map((w) => `<div class="kb-dp-worker"><b>${esc(String(w.task_title || w.task_id || 'worker'))}</b>
    <span>${esc(String(w.profile || w.task_assignee || ''))} · ${esc(kbAgo(w.started_at) || '运行中')}</span></div>`).join('');
}
function kbDpList(label, arr, fmt) {
  const list = Array.isArray(arr) ? arr : [];
  if (!list.length) return '';
  const items = list.slice(0, 12).map(fmt || ((x) => `<li><code>${esc(String(x))}</code></li>`)).join('');
  const more = list.length > 12 ? `<li class="kb-dp-num">还有 ${list.length - 12} 项未列出</li>` : '';
  return `<div class="kb-dp-lead">${esc(label)} · ${list.length}</div><ul class="kb-dp-list">${items}${more}</ul>`;
}
function renderDispatchResult(r, errText) {
  const host = $('#kb-dp-result'), tag = $('#kb-dp-result-tag');
  if (!host) return;
  if (!r || !r.ok) {
    if (tag) { tag.textContent = ''; tag.className = 'kb-dp-tag'; }
    host.innerHTML = `<div class="kb-dp-empty">${esc(errText || '派发请求失败')}</div>`;
    return;
  }
  const dry = r.dryRun !== false;
  const spawned = Array.isArray(r.spawned) ? r.spawned : [];
  if (tag) {
    tag.textContent = dry ? '试运行 · 未启动 agent' : `已派发 · ${spawned.length} 个 worker`;
    tag.className = 'kb-dp-tag' + (dry ? '' : ' real');
  }
  const lists = r.lists || {}, counts = r.counts || {};
  let html = `<div class="kb-dp-lead">${dry ? '本次将启动' : '本次已启动'} <b>${spawned.length}</b> 个 worker${spawned.length ? '' : '（没有 ready 且已分配受让人的任务）'}</div>`;
  html += kbDpList(dry ? '预览：将被派发' : '已启动', spawned,
    (x) => `<li><code>${esc(x.taskId)}</code> <span class="kb-dp-num">→ ${esc(x.assignee || 'default')}</span></li>`);
  const countBits = [];
  if (Number(counts.reclaimed)) countBits.push(`回收认领 ${Number(counts.reclaimed)}`);
  if (Number(counts.promoted)) countBits.push(`依赖解锁 ${Number(counts.promoted)}`);
  if (counts.skipped_locked) countBits.push('另一派发器正持锁，本次跳过');
  if (counts.rate_limited) countBits.push('触发速率限制');
  if (counts.memory_pressure) countBits.push('内存压力，已限流');
  if (countBits.length) html += `<div class="kb-dp-lead">调度器动作：${esc(countBits.join(' · '))}</div>`;
  const groups = [
    ['未分配受让人（不会被派发）', lists.skipped_unassigned],
    ['受让人不是 Hermes profile', lists.skipped_nonspawnable],
    ['已自动套用默认受让人', lists.auto_assigned_default],
    ['该 profile 并发已满', lists.skipped_per_profile_capped],
    ['重生保护（冷却中）', lists.respawn_guarded],
    ['崩溃回收', lists.crashed], ['超时回收', lists.timed_out], ['心跳过期', lists.stale],
    ['连续失败自动阻塞', lists.auto_blocked], ['孤儿 running 重新入队', lists.reconciled_orphans],
    ['回收终态残留 worker', lists.reaped_terminal_workers],
  ];
  for (const [label, arr] of groups) {
    if (label === '该 profile 并发已满') {
      html += kbDpList(label, r.skippedPerProfile,
        (x) => `<li><code>${esc(x.taskId)}</code> <span class="kb-dp-num">→ ${esc(x.assignee)} · 在跑 ${Number(x.current) || 0}</span></li>`);
    } else if (label === '重生保护（冷却中）') {
      html += kbDpList(label, r.respawnGuarded,
        (x) => `<li><code>${esc(x.taskId)}</code> <span class="kb-dp-num">${esc(x.reason)}</span></li>`);
    } else html += kbDpList(label, arr);
  }
  if (!spawned.length && !countBits.length && !html.includes('kb-dp-list')) {
    html += '<div class="kb-dp-empty">当前没有可派发的任务。把卡片推进到 ready 并分配受让人后再试；收集箱 triage 与 todo 不会被派发。</div>';
  }
  host.innerHTML = html;
}
async function kbDispatchRun(dryRun) {
  if (KB.dispatch.busy || !KB.dispatch.open) return;
  const a = kbApi();
  if (!a || !a.kanbanDispatch) { kbDpState('此页需要 Hermes 桌面端才能派发', 'err'); return; }
  const my = KB.dispatch.epoch;
  const preview = $('#kb-dp-preview'), run = $('#kb-dp-run');
  KB.dispatch.busy = true;
  if (preview) preview.disabled = true;
  if (run) run.disabled = true;
  kbDpState(dryRun ? '正在试运行…' : '正在派发…', '');
  const max = Math.max(1, Math.min(8, Number($('#kb-dp-max') && $('#kb-dp-max').value) || 1));
  try {
    const r = await a.kanbanDispatch({ board: KB.filters.board || '', dryRun: !!dryRun, max });
    if (my !== KB.dispatch.epoch || !KB.dispatch.open) return;
    renderDispatchResult(r, r && r.error);
    if (!r || !r.ok) { kbDpState('派发失败', 'err'); return; }
    kbDpState(dryRun ? '预览完成，未启动任何 agent' : `已派发 ${(r.spawned || []).length} 个 worker`, 'on');
    if (!dryRun) {
      toast(`派发完成：启动 ${(r.spawned || []).length} 个 worker`, 2000);
      await kanbanLoad(true); // 写后回读 CLI 列表
    }
    kbDispatchLoadWorkers();
  } catch (e) {
    if (my === KB.dispatch.epoch) {
      renderDispatchResult(null, (e && e.message) || '派发请求失败');
      kbDpState('派发失败', 'err');
    }
  } finally {
    KB.dispatch.busy = false;
    if (preview) preview.disabled = false;
    kbRenderCapacity(); // 含「并发已满则禁用真派发」，不能无条件放开按钮
  }
}
function kbDispatchConfirm() {
  const host = $('#kb-dp-confirm');
  const a = kbApi();
  if (!host || !a || !a.kanbanDispatch) { toast('此页需要 Hermes 桌面端才能派发', 1800); return; }
  const cap = kbDispatchCapacity();
  if (!cap.room) {
    kbDpState(`并发已满（在跑 ${cap.running} / 上限 ${cap.max}）`, 'err');
    toast('本看板已触达并发上限，本次不会启动新 worker', 2200);
    return;
  }
  const max = cap.max;
  const board = String(KB.filters.board || 'current').replace(/[^a-z0-9_-]/g, '');
  opConfirm(host, {
    title: '立即派发一次？',
    cmd: `POST /api/plugins/kanban/dispatch?dry_run=false&max=${max}&board=${board}`,
    note: `本看板并发上限 ${max}，当前在跑 ${cap.running} 个 worker，本次最多新增 ${cap.room} 个：它们会以各自的受让人 profile（hermes -p <受让人>）启动，可能消耗模型额度；调度器还会顺带回收超时 / 崩溃的 worker。这是真实写入，不是预览。`,
    confirmLabel: '确认派发',
    onGo: () => kbDispatchRun(false),
  });
}
/** 抽屉里的「提交派发」：把 triage / todo / blocked 等推进到 ready。 */
function kbSubmitTask(id, host) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return;
  const a = kbApi();
  if (!host || !a || !a.kanbanSubmitTask) { toast('此页需要 Hermes 桌面端才能提交派发', 1800); return; }
  opConfirm(host, {
    title: '把这个任务提交派发？',
    cmd: `PATCH /api/plugins/kanban/tasks/${id}  { status: "ready" }`,
    note: '状态推进到 ready 后，运行中的调度器（默认每 60 秒一次）可能立即认领它并启动 agent worker，产生模型调用。若不想被自动派发，请让任务留在 triage / todo。',
    confirmLabel: '提交派发',
    onGo: async () => {
      const r = await a.kanbanSubmitTask(id, kbParams());
      if (!r || !r.ok) { toast('提交失败：' + ((r && r.error) || '未知错误'), 2600); return; }
      toast('任务已进入 ready 队列', 1800);
      await kanbanLoad(true); // 写后回读
      if (KB.dispatch.open) kbDispatchLoadWorkers();
    },
  });
}
