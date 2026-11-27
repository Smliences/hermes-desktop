// 看板视图：投递区 / 拖拽 / 卡片 / 列 / 网格 / Rail 速览
function renderKanbanDock() {
  const host = $('#kb-dock-workers');
  if (!host) return;
  if (KbDrag.on) return; // 拖动中不重建，否则正在悬停的投放目标会被换掉
  const scrollLeft = host.scrollLeft;   // 重建会把滚动位置打回 0，chip 会莫名「漂」一下
  const { verified, list } = kbWorkerList();
  const focused = document.activeElement && document.activeElement.getAttribute
    ? document.activeElement.getAttribute('data-kb-worker') : null;
  if (!list.length) {
    host.innerHTML = '<span class="kb-dock-empty">未发现可派发的 profile —— 受让人必须与磁盘上的 Hermes profile 同名，派发器才能用 <code>hermes -p &lt;受让人&gt;</code> 启动 worker。</span>';
    return;
  }
  host.innerHTML = list.map((w) => {
    const tip = `${w.name} · ${w.running ? w.running + ' 个 worker 在跑' : '空闲'}`
      + (verified ? '' : '（profile 清单未读到，名字按看板受让人推断）')
      + ' · 把卡片拖到这里可指派';
    return `<button class="kb-worker${w.running ? ' busy' : ''}" type="button"
      data-kb-worker="${esc(w.name)}" title="${esc(tip)}"
      aria-label="${esc(w.name)}${w.running ? `，${w.running} 个 worker 在跑` : ''}，可投放卡片">${esc(w.name)}${w.running ? `<span class="kb-worker-n">${w.running} 在跑</span>` : ''}</button>`;
  }).join('');
  host.scrollLeft = scrollLeft;
  if (focused) {
    const back = host.querySelector(`[data-kb-worker="${focused}"]`);
    if (back) { try { back.focus({ preventScroll: true }); } catch {} }
  }
}
function kbDockHint(text) {
  const el = $('#kb-dock-hint');
  if (el && el.textContent !== text) el.textContent = text;
}
/** 投放区状态文字：成功提示 8s 自动退场，错误留 12s 够看清；关页时一并清掉。
 *  dock 现在是浮层，这一条也跟着浮动 —— 由 #kb-dock-status 的 .on 控制显隐，
 *  不能靠「有没有文字」：空 span 也会占位，浮层会在底部留一条空白。 */
let kbDockMsgTimer = null;
function kbDockMsg(text, cls) {
  const el = $('#kb-dock-msg'), box = $('#kb-dock-status');
  if (!el) return;
  if (kbDockMsgTimer) { clearTimeout(kbDockMsgTimer); kbDockMsgTimer = null; }
  el.textContent = text || '';
  el.className = 'kb-dock-msg' + (cls ? ' ' + cls : '');
  if (box) box.classList.toggle('on', !!text);
  if (text) {
    kbDockMsgTimer = setTimeout(() => {
      kbDockMsgTimer = null;
      el.textContent = '';
      el.className = 'kb-dock-msg';
      if (box) box.classList.remove('on');
    }, cls === 'err' ? 12000 : 8000);
  }
}

/* ---- 指针拖拽（不用 HTML5 DnD：可控、能吞掉误触 click、能量到投放目标） ----
   两条铁律，改之前先看：
   ① 投放区几何在拖动期间必须恒定。label 是定宽槽位、状态文字挪到 dock 外独立一行，
      否则提示文案一变，chip 就在指针底下漂移，根本对不准（原来就是这么坏的）。
   ② 幽灵卡浮在指针上方而不是贴着抓取点盖住指针 —— 否则它正好挡住要投放的那个 chip。 */
const KB_DOCK_IDLE = '拖到这里派发';
const KB_DOCK_SNAP = 26;   // 落在 chip 缝隙里也能吸附到最近的一个
function kbReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch { return false; }
}
function kbDragBegin() {
  if (KbDrag.on || !KbDrag.id) return;
  KbDrag.on = true;
  document.body.classList.add('kb-dragging');
  const dock = $('#kb-dock');
  if (dock) dock.classList.add('is-drag');
  // 按下后到越过阈值之间可能正好赶上轮询重渲染，原卡片节点会脱离文档：
  // 按 id 重新取当前节点，否则「变暗」的视觉反馈会丢失。
  if (!KbDrag.card || !KbDrag.card.isConnected) {
    KbDrag.card = document.querySelector(`.kb-card[data-kb-task="${KbDrag.id}"]`);
  }
  const src = KbDrag.card;
  if (src) src.classList.add('is-dragging');
  const r = src ? src.getBoundingClientRect() : { width: 240, height: 64 };
  const g = document.createElement('div');
  g.className = 'kb-drag-ghost';
  g.setAttribute('aria-hidden', 'true');
  if (src) {
    // 幽灵是整张卡的克隆：一眼看出在搬哪一张，比只有标题的小方块直观
    const clone = src.cloneNode(true);
    // 但只能做视觉：抹掉所有会和真实卡片抢命中 / 抢键盘的标识
    clone.removeAttribute('data-kb-task');
    clone.removeAttribute('data-kb-drag');
    clone.removeAttribute('title');
    clone.classList.remove('is-dragging', 'sel');
    clone.classList.add('kb-ghost-card');
    clone.setAttribute('tabindex', '-1');
    clone.setAttribute('aria-hidden', 'true');
    g.appendChild(clone);
  }
  const tip = document.createElement('small');
  tip.className = 'kb-ghost-tip';
  tip.textContent = (KbDrag.status ? KbDrag.status + ' · ' : '') + '松手到列里改状态，或落到 profile 上改派';
  g.appendChild(tip);
  g.style.width = Math.round(Math.min(r.width || 240, 300)) + 'px';
  document.body.appendChild(g);
  KbDrag.ghost = g;
  KbDrag.gh = g.getBoundingClientRect().height || 0;
  g.classList.add('on');
  // 槽位里显示正在搬的卡片标题（槽宽固定，超出省略，绝不挤动右侧 chip）
  kbDockHint(KbDrag.title ? '⠿ ' + KbDrag.title : '⠿ 正在拖动');
  kbDragScrollLoop();
}
/** 幽灵卡落点：水平居中于指针、垂直浮在指针上方 18px，再夹进视口。
 *  纯函数，契约会直接跑数值断言 —— 幽灵的底边必须始终在指针上方，
 *  否则它正好盖住要投放的那个 chip。 */
function kbGhostPos(x, y, w, h, vw, vh) {
  const left = Math.max(8, Math.min(x - w / 2, Math.max(8, vw - w - 8)));
  const top = Math.max(8, Math.min(y - h - 18, Math.max(8, vh - h - 8)));
  return { left: Math.round(left), top: Math.round(top) };
}
function kbDragFollow(x, y) {
  const g = KbDrag.ghost;
  if (!g) return;
  const w = g.offsetWidth || 240;
  const h = KbDrag.gh || g.offsetHeight || 0;
  const p = kbGhostPos(x, y, w, h, window.innerWidth || 0, window.innerHeight || 0);
  g.style.transform = `translate3d(${p.left}px, ${p.top}px, 0)`;
}
function kbChipAt(x, y) {
  const dock = $('#kb-dock');
  if (!dock) return null;
  try {
    const el = document.elementFromPoint(x, y);
    const hit = el && el.closest ? el.closest('.kb-worker') : null;
    if (hit && dock.contains(hit)) return hit;
  } catch { /* elementFromPoint 在极端坐标下会抛 */ }
  // 落在 chip 之间或 dock 的空白里：吸附到最近的一个，别让「差几像素」白拖
  const d = dock.getBoundingClientRect();
  if (y < d.top - 8 || y > d.bottom + 8) return null;
  const row = $('#kb-dock-workers');
  const rr = row ? row.getBoundingClientRect() : null;
  let best = null, bestD = KB_DOCK_SNAP;
  dock.querySelectorAll('.kb-worker').forEach((c) => {
    const b = c.getBoundingClientRect();
    if (rr && (b.right < rr.left + 2 || b.left > rr.right - 2)) return; // 被横向滚动裁掉的
    const dx = x < b.left ? b.left - x : (x > b.right ? x - b.right : 0);
    const dy = y < b.top ? b.top - y : (y > b.bottom ? y - b.bottom : 0);
    const dist = Math.hypot(dx, dy);
    if (dist < bestD) { bestD = dist; best = c; }
  });
  return best;
}
function kbSetDropTarget(chip) {
  if (KbDrag.target === chip) return;
  const prev = KbDrag.target;
  if (prev && prev.classList) prev.classList.remove('over');
  KbDrag.target = chip || null;
  if (chip && chip.classList) chip.classList.add('over');
  if (KbDrag.ghost) KbDrag.ghost.classList.toggle('ok', !!chip);
  const name = chip ? String(chip.getAttribute('data-kb-worker') || '') : '';
  kbDockHint(name ? '松手 → ' + name : (KbDrag.title ? '⠿ ' + KbDrag.title : '⠿ 正在拖动'));
}
function kbDragHover(x, y) {
  const chip = kbChipAt(x, y);
  kbSetDropTarget(chip);
  // profile chip 优先：落在 chip 上就只算改派，不再高亮列，避免一次拖拽两个投放目标
  kbSetColTarget(chip ? null : kbColAt(x, y));
  kbDragAutoScroll(x, y);
}
/** 指针下面是不是某一列（列头与列体都算）。返回 {el, status}；「已归档」列返回 null。 */
function kbColAt(x, y) {
  try {
    const el = document.elementFromPoint(x, y);
    const hit = el && el.closest ? el.closest('.kb-col[data-group]') : null;
    if (!hit) return null;
    const status = KB_GROUP_STATUS[String(hit.getAttribute('data-group') || '')] || '';
    return status ? { el: hit, status } : null;
  } catch { return null; }
}
function kbSetColTarget(next) {
  const cur = KbDrag.col;
  if ((cur && next && cur.el === next.el) || (!cur && !next)) return;
  if (cur && cur.el) cur.el.classList.remove('over');
  KbDrag.col = next || null;
  if (next && next.el) next.el.classList.add('over');
  if (KbDrag.ghost) KbDrag.ghost.classList.toggle('ok', !!next || !!KbDrag.target);
  if (next) kbDockHint(`松手 → ${KB_STATUS_ACTION[next.status] || next.status}`);
  else if (!KbDrag.target) kbDockHint(KbDrag.title ? '⠿ ' + KbDrag.title : '⠿ 正在拖动');
}
/** 指针靠近 chip 行的左右边缘就自动横向滚动，否则窄窗口里根本够不到后面的 profile */
function kbDragAutoScroll(x, y) {
  const row = $('#kb-dock-workers'), dock = $('#kb-dock');
  if (!row || !dock) { KbDrag.vel = 0; return; }
  const d = dock.getBoundingClientRect();
  if (y < d.top - 48 || y > d.bottom + 48) { KbDrag.vel = 0; return; }
  const r = row.getBoundingClientRect();
  if (r.scrollWidth <= r.width + 1) { KbDrag.vel = 0; return; }
  KbDrag.vel = Math.round(kbScrollVel(x, r, 44, 12) * 10) / 10;
}
/** 边缘自动滚动的速度（px/帧）：离边缘越近越快，中间与区外都是 0。纯函数，便于数值断言。 */
function kbScrollVel(x, r, edge, max) {
  if (x >= r.left - edge && x < r.left + edge) return -max * Math.min(1, (r.left + edge - x) / (edge * 2));
  if (x <= r.right + edge && x > r.right - edge) return max * Math.min(1, (x - (r.right - edge)) / (edge * 2));
  return 0;
}
/** 自动滚动只占一个 rAF 循环，拖动结束立刻停；不用 setInterval 是为了绝不叠定时器 */
function kbDragScrollLoop() {
  if (KbDrag.raf) return;
  const step = () => {
    KbDrag.raf = 0;
    if (!KbDrag.on) return;
    const row = $('#kb-dock-workers');
    if (row && KbDrag.vel) row.scrollLeft += KbDrag.vel;
    KbDrag.raf = requestAnimationFrame(step);
  };
  KbDrag.raf = requestAnimationFrame(step);
}
function kbDragReset(instant) {
  const wasOn = KbDrag.on;
  if (KbDrag.raf) { cancelAnimationFrame(KbDrag.raf); KbDrag.raf = 0; }
  if (KbDrag.target && KbDrag.target.classList) KbDrag.target.classList.remove('over');
  if (KbDrag.col && KbDrag.col.el) KbDrag.col.el.classList.remove('over');
  if (KbDrag.card && KbDrag.card.classList) KbDrag.card.classList.remove('is-dragging');
  const g = KbDrag.ghost;
  if (g) {
    g.classList.remove('on');
    g.classList.add('out');
    if (instant || kbReducedMotion()) { try { g.remove(); } catch { /* 已被移除 */ } }
    else setTimeout(() => { try { g.remove(); } catch { /* 已被移除 */ } }, 140);
  }
  document.body.classList.remove('kb-dragging');
  const dock = $('#kb-dock');
  if (dock) dock.classList.remove('is-drag');
  KbDrag.armed = false; KbDrag.on = false; KbDrag.id = ''; KbDrag.title = '';
  KbDrag.status = ''; KbDrag.card = null; KbDrag.ghost = null; KbDrag.target = null;
  KbDrag.col = null; KbDrag.vel = 0; KbDrag.gh = 0;
  kbDockHint(KB_DOCK_IDLE);
  return wasOn;
}
function kbDragDown(e) {
  if (!e || e.button !== 0 || e.pointerType === 'touch') return; // 触摸留给滚动，避免和滚动手势打架
  const card = e.target && e.target.closest ? e.target.closest('.kb-card') : null;
  if (!card || card.getAttribute('data-kb-drag') !== '1') return;
  const id = String(card.getAttribute('data-kb-task') || '');
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(id)) return;
  KbDrag.armed = true;
  KbDrag.id = id;
  KbDrag.card = card;
  KbDrag.x0 = e.clientX;
  KbDrag.y0 = e.clientY;
  const t = kbFindTask(id);
  KbDrag.status = String((t && t.status) || '');
  const titleEl = card.querySelector('.kb-card-title');
  KbDrag.title = (titleEl && titleEl.textContent ? titleEl.textContent : '').trim();
}
function kbDragMove(e) {
  if (!KbDrag.armed && !KbDrag.on) return;
  if (!KbDrag.on) {
    if (Math.abs(e.clientX - KbDrag.x0) < 5 && Math.abs(e.clientY - KbDrag.y0) < 5) return;
    kbDragBegin();
    if (!KbDrag.on) return;
  }
  if (e.cancelable) e.preventDefault();
  kbDragFollow(e.clientX, e.clientY);
  kbDragHover(e.clientX, e.clientY);
}
function kbDragUp() {
  if (!KbDrag.armed && !KbDrag.on) return;
  const dropped = KbDrag.target ? KbDrag.target.getAttribute('data-kb-worker') : '';
  const col = KbDrag.col ? KbDrag.col.status : '';
  const id = KbDrag.id;
  const from = KbDrag.status;
  const moved = kbDragReset();
  if (moved) {
    // 拖动结束后浏览器会补一个 click；先吞掉，再在下一个任务里复位标志
    KbDrag.suppressClick = true;
    setTimeout(() => { KbDrag.suppressClick = false; }, 0);
  }
  if (!moved) return;
  if (dropped && KB_ASSIGNEE_RE.test(dropped)) { kbDropToWorker(id, dropped); return; }
  if (col) kbDropToStatus(id, col, from);
}

/**
 * 落地：把卡片拖进另一列 = 让 CLI 走一次状态动词（PATCH /tasks/{id} {status}）。
 * 状态机规则全在 CLI（父任务没做完会 409 并点名），桌面端只负责确认与文案：
 *   - running → done/review 是「人类强制覆盖在跑 worker 的认领」，先过确认卡；
 *   - 其余迁移没有副作用，直接写。
 */
async function kbDropToStatus(taskId, status, srcStatus) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(taskId || ''))) return;
  const target = String(status || '');
  if (!KB_STATUS_SETTABLE.includes(target)) return;
  const a = kbApi();
  if (!a || !a.kanbanSetStatus) { kbDockMsg('此页需要 Hermes 桌面端才能改状态', 'err'); return; }
  const task = kbFindTask(taskId);
  if (!task) { kbDockMsg('找不到这张卡片，先刷新看板', 'err'); return; }
  const from = String(task.status || srcStatus || '');
  const label = KB_STATUS_LABEL[target] || target;
  // 同列内拖（例如 scheduled 拖到「待办」）：目标状态已经成立，别白写一条事件
  if (from === target) { kbDockMsg(`这张卡已经是「${label}」`, ''); return; }
  const go = async () => {
    kbDockMsg(`正在把 ${taskId} 改成「${label}」…`, '');
    try {
      const r = await a.kanbanSetStatus(taskId, { status: target, board: KB.filters.board || '' });
      if (!r || !r.ok) { kbDockMsg('改状态失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
      await kanbanLoad(true); // 写后回读：列归组、计数、chip 都跟着变
      if (KB.detailId === taskId) openKanbanTask(taskId, true);
      kbDockMsg(`已改成「${label}」`, 'on');
    } catch (e) {
      kbDockMsg('改状态失败：' + ((e && e.message) || '未知错误'), 'err');
    }
  };
  // 从「运行中」拖出 = 覆盖在跑的 worker 的认领（CLI 侧是 force），先问一句
  if (from === 'running') {
    const host = $('#kb-dock-confirm');
    if (host) {
      opConfirm(host, {
        title: `这张卡还在跑：${String(task.title || taskId).slice(0, 32)}`,
        cmd: `PATCH /api/plugins/kanban/tasks/${taskId}   {"status":"${target}"}`,
        note: `worker 可能还在执行。CLI 把人工动作当作强制覆盖：这一轮的结果会被丢弃，任务直接记成「${label}」。确定现在改吗？`,
        confirmLabel: target === 'done' ? '强制标为完成' : `强制改为${label}`,
        onGo: go,
      });
      return;
    }
  }
  await go();
}

/** 落地第一步：改派受让人（顺带推进到 ready）。不启动任何进程。 */
async function kbDropToWorker(taskId, profile) {
  if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(String(taskId || ''))) return;
  if (!KB_ASSIGNEE_RE.test(String(profile || ''))) return;
  const a = kbApi();
  if (!a || !a.kanbanReassign) { kbDockMsg('此页需要 Hermes 桌面端才能改派', 'err'); return; }
  const task = kbFindTask(taskId);
  if (!task) { kbDockMsg('找不到这张卡片，先刷新看板', 'err'); return; }
  const st = String(task.status || '');
  if (!KB_DRAGGABLE.includes(st)) {
    kbDockMsg(st === 'running'
      ? '运行中的卡片不能改派：先在 CLI 里 reclaim 掉它的认领，再拖一次。'
      : `「${st || '该'}」状态的卡片不会再派发，改派没有意义。`, 'err');
    return;
  }
  // 已经是指定 profile 且已在 ready：省掉一次 PATCH，少写一条 assigned 事件
  if (String(task.assignee || '') === profile && st === 'ready') {
    kbDockMsg(`已指派给 ${profile}`, 'on');
    kbAskDispatch(taskId, profile, task.title || '');
    return;
  }
  kbDockMsg(`正在把 ${taskId} 指派给 ${profile}…`, '');
  try {
    const r = await a.kanbanReassign(taskId, {
      assignee: profile, status: 'ready', board: KB.filters.board || '',
    });
    if (!r || !r.ok) { kbDockMsg('改派失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
    await kanbanLoad(true); // 写后回读：卡片落到 ready、受让人 chip 跟着变
    kbDockMsg(`已指派给 ${profile}`, 'on');
    kbAskDispatch(taskId, profile, task.title || '');
  } catch (e) {
    kbDockMsg('改派失败：' + ((e && e.message) || '未知错误'), 'err');
  }
}
/** 落地第二步：真派发必须过二次确认卡（会 spawn 进程、花额度）。 */
function kbAskDispatch(taskId, profile, title) {
  const host = $('#kb-dock-confirm');
  if (!host) return;
  opConfirm(host, {
    title: `现在启动 worker：${String(title || taskId).slice(0, 36)}`,
    cmd: `POST /api/plugins/kanban/dispatch?dry_run=false&max=1   ←   hermes -p ${profile}`,
    note: `卡片已在 ready 队列并指派给 ${profile}。点「立即启动」才真派发：调度器会用 hermes -p ${profile} 拉起一个 worker 执行它，消耗模型额度。点「取消」就只保持指派，等调度器 60 秒内的自动 tick 或手动派发。派发前会先做一次 dry-run，确认队首就是这张卡片，不会顺带唤醒别的任务。`,
    confirmLabel: '立即启动 worker',
    onGo: () => kbDispatchTaskNow(taskId, profile),
  });
}
async function kbDispatchTaskNow(taskId, profile) {
  const a = kbApi();
  if (!a || !a.kanbanDispatchTask) { kbDockMsg('此页需要 Hermes 桌面端才能派发', 'err'); return; }
  kbDockMsg('正在派发…', '');
  try {
    const r = await a.kanbanDispatchTask(taskId, { board: KB.filters.board || '' });
    if (!r || !r.ok) { kbDockMsg('派发失败：' + ((r && r.error) || '未知错误'), 'err'); return; }
    // 只在投放区状态条上说，不再叠一条 toast：两者都是底部居中，会互相压住
    if (r.dispatched) kbDockMsg(`worker 已启动：${taskId} → ${profile}`, 'on');
    else kbDockMsg(r.reason || '调度器本次没有启动 worker', 'err');
    await kanbanLoad(true); // 写后回读：running 卡片与活跃 worker 都会变
    if (KB.dispatch.open) kbDispatchLoadWorkers();
  } catch (e) {
    kbDockMsg('派发失败：' + ((e && e.message) || '未知错误'), 'err');
  }
}

function kbMatch(t) {
  const f = KB.filters;
  if (f.assignee && String(t.assignee || '') !== f.assignee) return false;
  if (!f.q) return true;
  const q = f.q.toLowerCase();
  return [t.id, t.title, t.body, t.latest_summary, t.result, t.assignee, t.tenant]
    .some((v) => String(v || '').toLowerCase().includes(q));
}
/** 统一 P 级映射：后端 priority 数值越大越先派发（10/3/2/1/0），前端按工程习惯展示 P0 最紧急 → P4 普通。
 *  视觉梯度：P0/P1 红 → P2 陶土橙 → P3 赭黄，P4 在卡面不渲染以减少噪点。 */
function kbPriMeta(raw) {
  const n = Number(raw) || 0;
  if (n >= 10) return { tag: 'P0', cls: 'p0', rcls: 'p3', title: `优先级 P0 · 最紧急（后端权重 ${n}，优先派发）` };
  if (n >= 3) return { tag: 'P1', cls: 'hi', rcls: 'p3', title: `优先级 P1 · 高（后端权重 ${n}）` };
  if (n === 2) return { tag: 'P2', cls: 'mid', rcls: 'p2', title: '优先级 P2 · 中（后端权重 2）' };
  if (n === 1) return { tag: 'P3', cls: 'lo', rcls: 'p1', title: '优先级 P3 · 低（后端权重 1）' };
  return { tag: 'P4', cls: 'n0', rcls: '', title: '优先级 P4 · 普通（默认权重 0）' };
}
const KB_PRI_OPTIONS = [
  ['0', 'P4 · 普通（默认）'],
  ['1', 'P3 · 低优先级'],
  ['2', 'P2 · 中优先级'],
  ['3', 'P1 · 高优先级'],
  ['10', 'P0 · 最紧急'],
];

function kbCardHtml(t, colName, opts) {
  const o = opts || {};
  const st = String(colName || t.status || '');
  const draggable = KB_DRAG_SOURCE.includes(st) ? '1' : '0';
  const pri = Number(t.priority) || 0;
  const pm = kbPriMeta(pri);
  const priHtml = pri > 0 ? `<span class="kb-pri ${pm.cls}" title="${esc(pm.title)}">${pm.tag}</span>` : '';
  const ago = kbAgo(t.created_at);
  const stuck = kbStuckInfo(t, st);
  const stuckHtml = stuck ? `<span class="kb-stuck" title="${esc(stuck.title)}">${esc(stuck.label)}</span>` : '';
  const whenHtml = ago ? `<span class="kb-card-when" title="创建于 ${esc(kbFullTime(t.created_at))}">${esc(ago)}</span>` : '';
  const timeWrap = (stuckHtml || whenHtml) ? `<span class="kb-card-time">${stuckHtml}${whenHtml}</span>` : '';
  // 来源行：细粒度状态 chip 只有跨组展示（网格 / 搜索结果）才需要；
  // 受让人与弱指标收进发丝脚行（ID 只留在抽屉里）。
  const chips = [];
  if (o.showStatus && st) chips.push(`<span class="kb-chip st" title="CLI 状态：${esc(st)}">${esc(KB_STATUS_LABEL[st] || st)}</span>`);
  if (t.tenant) chips.push(`<span class="kb-chip" title="租户">${esc(t.tenant)}</span>`);
  const wn = t.warnings && Number(t.warnings.count);
  if (wn) chips.push(`<span class="kb-chip warn" title="有诊断告警">${wn} 项告警</span>`);

  // 脚行：受让人徽标 · 评论图标计数 · 子任务迷你进度 + 右侧卡住标与弱化时间。
  const foot = [];
  const asg = kbAssigneeFoot(t.assignee);
  if (asg) foot.push(asg);
  const cc = Number(t.comment_count) || 0;
  if (cc) {
    foot.push(`<span class="kb-foot-stat" title="${cc} 条评论"><svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H6.5l-3 2.5V11H4A1.5 1.5 0 0 1 2.5 9.5V4z"/></svg>${cc}</span>`);
  }
  const pg = t.progress;
  if (pg && Number(pg.total)) {
    const done = Number(pg.done) || 0, tot = Number(pg.total);
    const pct = Math.min(100, Math.max(0, Math.round((done / tot) * 100)));
    foot.push(`<span class="kb-foot-stat" title="子任务进度 ${done}/${tot}"><span class="kb-sub-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>${done}/${tot}</span>`);
  }

  // 卡面描述：优先最新执行回报（latest_summary = task_runs.summary），
  // 没跑过 worker 的任务回退到建任务时写的描述 body —— 否则新卡永远是光杆标题。
  const sum = String(t.latest_summary || t.body || '').trim();
  const q = KB.filters.q;
  // 运行中的卡：顶部 2px 绿条 + 秒表，不用点开就知道进度；
  const runHtml = st === 'running' ? kbRunStrip(t) : '';
  const dragHint = draggable === '1'
    ? '拖动：落到别的列改状态，落到上方 profile 上改派'
    : `${st || '该状态'} 不支持拖拽（已归档的卡片不参与拖动）`;
  return `<button class="kb-card${KB.detailId === t.id ? ' sel' : ''}" data-kb-task="${esc(t.id)}" data-kb-drag="${draggable}" type="button" title="${esc(t.title || '')}　·　${esc(dragHint)}">
    ${priHtml}
    <div class="kb-card-title">${kbHighlight(t.title || '(无标题)', q)}</div>
    ${sum ? `<div class="kb-card-sum">${kbHighlight(clip(sum, 200), q)}</div>` : ''}
    ${chips.length ? `<div class="kb-card-meta">${chips.join('')}</div>` : ''}
    ${runHtml}
    <div class="kb-card-foot">${foot.join('')}${timeWrap}</div>
  </button>`;
}

/** 按归组摊平当前看板：每组带原始条数 all 与过滤后条数 tasks。
 *  计数（chip 上的数字）恒用 all，不随搜索 / 受让人筛选变化 —— 否则筛完就失去全局感。 */
function kbGroups() {
  const by = new Map();
  const cols = (KB.board && Array.isArray(KB.board.columns)) ? KB.board.columns : [];
  for (const c of cols) {
    const name = String((c && c.name) || '');
    if (!name) continue;
    const list = Array.isArray(c.tasks) ? c.tasks : [];
    by.set(name, list.map((t) => (t && typeof t === 'object' && !t.status ? { ...t, status: name } : t)));
  }
  const defs = KB.filters.archived ? [...KB_GROUPS, KB_GROUP_ARCHIVED] : [...KB_GROUPS];
  return defs.map((g) => {
    const all = kbSortTasks(g.statuses.reduce((acc, s) => acc.concat(by.get(s) || []), []));
    return { key: g.key, label: g.label, hint: g.hint, dot: g.dot, all, tasks: all.filter(kbMatch) };
  });
}
/** 页头只写两样：当前看板名 + 一行概览。原来那排统计卡会把首屏挤掉，
 *  各组条数已经在筛选 chip 上各出现一次，这里只留「总量 + 进行中」。 */
/**
 * 页头那枚编排模式标记：只读 + 点击去设置，绝不在这里改任何东西。
 * 三档模式由主进程从 config.yaml 的两个开关推导，渲染层只管显示 ——
 * 否则 UI 会多出一份可以和 gateway 实际状态不一致的「模式」。
 */
const KB_MODE_TIP = Object.freeze({
  auto: '收集箱的卡会自动拆解并派发执行。点击到设置里更改。',
  semi: '收集箱停住，其余仍自动执行。点击到设置里更改。',
  manual: '派发器已停，只有手动派发才会执行。点击到设置里更改。',
});
function kbModeChip(state) {
  const el = $('#kb-head-mode');
  if (!el) return;
  if (!state || !state.ok) { el.hidden = true; return; }
  KB.mode = state;
  el.hidden = false;
  el.dataset.mode = state.mode;
  el.textContent = '自动编排·' + (state.modeLabel || state.mode);
  el.title = KB_MODE_TIP[state.mode] || '看板编排模式（只读）';
  el.classList.toggle('is-manual', state.mode === 'manual');
}
async function kbLoadMode() {
  const el = $('#kb-head-mode');
  if (!el) return;
  if (!kbApi() || !isNativeCLI()) { el.hidden = true; return; }
  let r = null;
  try { r = await api.kanbanOrchestration(); } catch { r = null; }
  kbModeChip(r);
}

function renderKanbanHead() {
  const nameEl = $('#kb-board-name'), statEl = $('#kb-head-stat'), sep = $('.kb-meta-sep');
  const o = KB.overview || {};
  // 筛到别的看板时页头要跟着显示被筛的看板，而不是 gateway 的当前看板
  const name = String(KB.filters.board || o.currentBoard || '当前看板');
  const boards = Array.isArray(o.boards) ? o.boards : [];
  if (nameEl) {
    nameEl.textContent = name;
    // 多看板时页头直接由 #kb-board 下拉显示并切换，避免同名写两遍
    nameEl.hidden = boards.length > 1;
  }
  if (!statEl) return;
  let text = '';
  if (!KB.board) text = KB.busy ? '读取中…' : '';
  else {
    const groups = kbGroups();
    const total = groups.reduce((n, g) => n + g.all.length, 0);
    const running = (groups.find((g) => g.key === 'running') || { all: [] }).all.length;
    text = total ? (running ? `${total} 张任务 · ${running} 张进行中` : `${total} 张任务`) : '暂无任务';
    // 看板绑定了项目时把项目名亮在概览行：项目决定该板任务的默认工作区
    const bm = (Array.isArray(o.boards) ? o.boards : [])
      .find((x) => String((x && x.slug) || '') === name);
    if (bm && bm.project_name) text += ` · 项目 ${bm.project_name}`;
  }
  statEl.textContent = text;
  // 统计为空时连分隔符一起收起，否则页头会挂一个孤零零的「·」
  if (sep) sep.hidden = !text;
}

/** 秒数 → 人话时长（「最早就绪已等 12 分钟」用）。 */
function kbAge(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时';
  return Math.floor(s / 86400) + ' 天';
}

/** 分组 chip：点一次只看该组，再点回全部。数字恒为该组的全局条数（不随筛选变），
 *  这样筛完还能看见「别处还有多少」，不会失去全局感。重建后把焦点还给同一个 chip。 */
function renderKanbanStatusbar() {
  const host = $('#kb-statusbar');
  if (!host) return;
  const focused = document.activeElement && document.activeElement.getAttribute
    ? document.activeElement.getAttribute('data-kb-status') : null;
  const groups = kbGroups();
  const all = groups.reduce((n, g) => n + g.all.length, 0);
  let html = `<button class="kb-status-chip${KB.status ? '' : ' on'}" type="button" data-kb-status="" aria-pressed="${KB.status ? 'false' : 'true'}">全部 <span class="kb-sc-num">${all}</span></button>`;
  html += groups.map((g) => `<button class="kb-status-chip${KB.status === g.key ? ' on' : ''}" type="button"
      data-kb-status="${esc(g.key)}" data-group="${esc(g.key)}" data-dot="${esc(g.dot)}"
      aria-pressed="${KB.status === g.key ? 'true' : 'false'}" title="${esc(g.hint)}">
      <span class="kb-sc-dot"></span>${esc(g.label)} <span class="kb-sc-num">${g.all.length}</span></button>`).join('');
  host.innerHTML = html;
  if (focused !== null) {
    const back = host.querySelector(`[data-kb-status="${focused}"]`);
    if (back) { try { back.focus({ preventScroll: true }); } catch {} }
  }
}

/** 看板主区空状态模板：空板与无匹配筛选共用。 */
function kbEmptyStateHtml(total, shown, allowNoMatch) {
  if (!total) {
    return `<div class="kb-empty-state"><h2>这个看板还没有任务</h2>
         <p>任务由 CLI 的 hermes kanban create、agent 的 kanban_* 工具或这里的新建按钮创建；数据落在同一份 kanban.db，终端与 Dashboard 立即可见。</p>
         <button class="kb-btn primary" type="button" data-kb-new="task">＋ 新建第一个任务</button></div>`;
  }
  if (allowNoMatch && shown === 0) {
    return `<div class="kb-empty-state"><h2>没有匹配的任务</h2><p>试试清空搜索、切换分组或放宽受让人筛选。</p><button class="kb-btn" type="button" data-kb-clear-filters="1">清空筛选条件</button></div>`;
  }
  return '';
}

/** 主体渲染。默认列视图：固定 5 组，组内纵向滚动；网格视图只画有卡片的分组。
 *  列尾的「＋ 添加任务」只给待办 / 就绪 —— 后端 CREATE_STATUSES 只认 triage 与 ready，
 *  在其余列放这个按钮只会建出一张落在收集箱的卡，文案会骗人。 */
function renderKanbanBody() {
  const groupsHost = $('#kb-groups'), colsHost = $('#kb-columns');
  const ae = document.activeElement;
  const focusedCardId = ae && ae.classList && ae.classList.contains('kb-card')
    ? String(ae.getAttribute('data-kb-task') || '') : '';
  const focusedCollapseKey = ae && ae.getAttribute ? ae.getAttribute('data-kb-collapse') : null;
  const groups = kbGroups();
  const wanted = KB.status ? groups.filter((g) => g.key === KB.status) : groups;
  let shown = 0, total = 0;
  groups.forEach((g) => { total += g.all.length; });
  wanted.forEach((g) => { shown += g.tasks.length; });

  const isGrid = KB.view === 'grid';
  // 「显示已归档」＝在五列右侧追加一列。类挂在容器上而不是列上有两个原因：
  //  ① 容器不随 innerHTML 重建，class 不会被冲掉；
  //  ② 宽度策略由 CSS 一处决定，列自己不必知道自己是第几列。
  // 按分组筛选时只剩一列，那一列应该独占宽度，所以此时不加这个类。
  if (colsHost) colsHost.classList.toggle('has-archived', !!KB.filters.archived && !KB.status);
  if (groupsHost) groupsHost.hidden = !isGrid;
  if (colsHost) colsHost.hidden = isGrid;

  if (isGrid) {
    const visible = wanted.filter((g) => g.tasks.length > 0 || KB.status);
    const body = visible.map((g) => `<section class="kb-group" data-group="${esc(g.key)}" data-dot="${esc(g.dot)}">
      <div class="kb-group-head" title="${esc(g.hint)}"><span class="kb-group-dot"></span><span class="kb-group-name">${esc(g.label)}</span>
        <span class="kb-group-num">${g.tasks.length}${g.tasks.length !== g.all.length ? ' / ' + g.all.length : ''} 张</span>
        <span class="kb-group-rule"></span></div>
      <div class="kb-group-cards">${g.tasks.length ? g.tasks.map((t) => kbCardHtml(t, t.status || g.statuses[0], { showStatus: true })).join('')
        : `<div class="kb-col-empty">${KB.filters.q || KB.filters.assignee ? '没有匹配的任务' : '暂无任务'}</div>`}</div>
    </section>`).join('');
    const empty = kbEmptyStateHtml(total, shown, true);
    const addCard = (!KB.status && !empty)
      ? `<div class="kb-add-row"><button class="kb-add-card" type="button" data-kb-new="task">＋ 新建任务<span>默认落在收集箱 triage · 等自动分解</span></button></div>`
      : '';
    if (groupsHost) groupsHost.innerHTML = body + addCard + empty;
    if (colsHost) colsHost.innerHTML = '';
  } else {
    const empty = kbEmptyStateHtml(total, shown, false);
    const body = wanted.map((g) => {
      const emptyCls = g.tasks.length === 0 ? ' is-empty' : '';
      const isCollapsed = !KB.status && KB.collapsed.has(g.key);
      const colCls = emptyCls + (isCollapsed ? ' is-collapsed' : '');
      const canAdd = g.key === 'todo' || g.key === 'ready';
      const addStatus = g.key === 'ready' ? 'ready' : 'triage';
      const add = canAdd
        ? `<button class="kb-add-col" type="button" data-kb-new="task" data-kb-new-status="${addStatus}"
             title="${g.key === 'ready' ? '新建并直接进入就绪：可能被调度器立即派发' : '新建到收集箱：派发器不会直接拉起，等自动分解补全后才会被派发'}">＋ 添加任务</button>`
        : '';
      const dropVerb = KB_GROUP_STATUS[g.key] || '';
      const dropPrompt = dropVerb ? `<span class="kb-drop-prompt">松手 → ${esc(KB_STATUS_ACTION[dropVerb] || g.label)}</span>` : '';
      const collapseBtn = !KB.status
        ? `<button class="kb-col-collapse" type="button" data-kb-collapse="${esc(g.key)}"
             aria-expanded="${isCollapsed ? 'false' : 'true'}"
             title="${isCollapsed ? '展开「' + esc(g.label) + '」列' : '收起「' + esc(g.label) + '」列'}"
             aria-label="${isCollapsed ? '展开' : '收起'}${esc(g.label)}列"><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${isCollapsed ? 'M4.5 2.5 8 6 4.5 9.5' : 'M7.5 2.5 4 6l3.5 3.5'}"/></svg></button>`
        : '';
      return `<div class="kb-col${colCls}" data-group="${esc(g.key)}" data-dot="${esc(g.dot)}" title="${esc(g.hint)}">
        <div class="kb-col-head"><span class="kb-col-dot" aria-hidden="true"></span><span class="kb-col-name">${esc(g.label)}</span>
          <span class="kb-col-num">${g.tasks.length}${g.tasks.length !== g.all.length ? '/' + g.all.length : ''}</span>${collapseBtn}</div>
        <div class="kb-col-body">${g.tasks.length
          ? g.tasks.map((t) => kbCardHtml(t, t.status || g.statuses[0])).join('')
          : `<div class="kb-col-empty"><b>${g.all.length ? '无匹配' : '暂无任务'}</b><span class="kb-hint-long">${esc(g.hint)}</span>${dropPrompt}</div>`}${add}</div>
      </div>`;
    }).join('');
    if (colsHost) colsHost.innerHTML = body + empty;
    if (groupsHost) groupsHost.innerHTML = '';
  }
  if (focusedCardId) {
    const back = document.querySelector(`#kb-scroll .kb-card[data-kb-task="${focusedCardId}"]`);
    if (back) { try { back.focus({ preventScroll: true }); } catch {} }
  } else if (focusedCollapseKey) {
    const back = document.querySelector(`#kb-columns [data-kb-collapse="${focusedCollapseKey}"]`);
    if (back) { try { back.focus({ preventScroll: true }); } catch {} }
  }
  // 只有筛选生效时才出数字：平时任务数只在分组 chip 上出现一次
  const count = $('#kb-count');
  if (count) count.textContent = (shown !== total && total) ? `筛选出 ${shown} / ${total} 张` : '';
  const clearBtn = $('#kb-clear-filters');
  if (clearBtn) clearBtn.hidden = !kbHasActiveFilters();
  return { shown, total };
}

function kbHasActiveFilters() {
  return !!(KB.status || KB.filters.q || KB.filters.assignee || KB.filters.tenant);
}
function kbResetFilters() {
  const hadTenant = !!KB.filters.tenant;
  KB.status = '';
  KB.filters.q = '';
  KB.filters.assignee = '';
  KB.filters.tenant = '';
  const q = $('#kb-search'), qc = $('#kb-search-clear');
  if (q) q.value = '';
  if (qc) qc.hidden = true;
  if ($('#kb-assignee')) $('#kb-assignee').value = '';
  if ($('#kb-tenant')) $('#kb-tenant').value = '';
  kbSavePrefs();
  if (hadTenant) kanbanLoad(false);
  else renderKanban();
}

/** 打开「显示已归档」后把第 6 列带进视野：用户刚点开归档却什么都没变（那列在右侧
 *  视口外），等于按钮失灵。只在切开关这一次滚，日常渲染绝不抢滚动位置。
 *  关掉时回到最左：第六列没了，留在右端的空白位置看起来像五列丢了内容。 */
function kbScrollToArchived(on) {
  const sc = $('#kb-scroll') || document.querySelector('.kb-scroll');
  if (!sc) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const go = (left) => {
    try { sc.scrollTo({ left, behavior: reduce ? 'auto' : 'smooth' }); }
    catch { sc.scrollLeft = left; }
  };
  if (!on) { if (sc.scrollLeft > 0) go(0); return; }
  if (sc.scrollWidth <= sc.clientWidth + 1) return;
  go(sc.scrollWidth);
}

function renderKanban() {
  kbSyncSelects();
  renderKanbanHead();
  renderKanbanStatusbar();
  renderKanbanDock();
  renderKanbanBody();
  if (!$('#kb-drawer').hidden && KB.detailId) kbSyncDrawerNav();
  // 只保留错误条：「没有进行中的任务」这类提示交给列本身表达，
  // 再挂一条横幅等于把首屏又挤掉一行（五列的计数已经说得很清楚）。
  const msg = $('#kb-message');
  if (msg) { msg.hidden = !KB.error; if (KB.error) msg.textContent = KB.error; }
  renderRailKanban(); // 同一份数据，整页刷新时顺带把 rail 速览带新
}

/* ---- 右侧 rail 紧凑看板 -------------------------------------------------
   与整页共用 KB.board / kbGroups()，不另开 REST、不另起轮询。400px 放不下
   五列等分，所以排成「看板切换 + 状态筛选 + 方块卡片网格」：
     · 栏头是看板下拉，换板 = 改 KB.filters.board（走同一条 kanbanLoad）；
     · 状态 chip 只在本地过滤，点一下只看这一组、再点回到全部，不发请求；
     · 正文是按紧迫度分组的两列方块卡（宽度自适应 2–4 列），标题 4 行截断；
     · 折叠状态存 DOM，轮询重渲染不重置；每组最多 RKB_MAX_CARDS 张。
   写操作一律回完整看板页（详情抽屉挂在整页里），这里只留「新建任务 / 新建看板」
   两个全局弹窗入口，避免两处状态机各写一份。 */
/** 一屏两列 × 4 行：再多的卡就在详情抽屉里看，速览不负责穷举。 */
const RKB_MAX_CARDS = 8;
/** rail 的分组顺序：先看「在跑 / 卡住」的，再看排队与历史。
 *  整页五列仍用 KB_GROUPS 原序（那里是流程顺序，看得见全貌）；
 *  这里是速览，顺序应该按「我现在要关心什么」排。 */
const RKB_ORDER = Object.freeze(['running', 'blocked', 'ready', 'todo', 'done']);
function rkbOrdered(groups) {
  const idx = (k) => { const i = RKB_ORDER.indexOf(k); return i < 0 ? RKB_ORDER.length : i; };
  return groups.slice().sort((a, b) => idx(a.key) - idx(b.key));
}
/** '' = 全部；其余是 KB_GROUPS 的 key。纯渲染层状态，不进 KB.filters（别影响整页）。 */
let rkbFilter = '';
/** 看板下拉的候选指纹：只有候选 / 当前看板变了才重建选项，免得每 5 秒把展开的面板顶掉。 */
let rkbBoardSig = '';
/** 细粒度状态 → 行首色条：跟随所在分组的语义色，与整页 chip 永远一致。 */
function rkbDotFor(status) {
  const g = KB_GROUPS.find((x) => x.statuses.indexOf(status) >= 0);
  return g ? g.dot : 'muted';
}
/** 值得在行里单独标出来的细状态。组名已经说明的（待办 / 进行中）再标一遍是噪音，
 *  但「收集箱 / 已排期 / 待验收」跟组名不是一回事，漏掉就分不出卡处在哪一步。 */
const RKB_SUB_STATUS = Object.freeze(['triage', 'scheduled', 'review']);
/** 栏头的看板切换器。当前看板本身用「占位项」表示（选中它 = 不筛），所以要从候选里
 *  剔除，否则同一个看板会出现两行；候选末尾挂一个动作行，顺手给了新建看板的入口。 */
function rkbSyncBoardSwitch() {
  const el = $('#rkb-board');
  if (!el || typeof el.setOptions !== 'function') return;
  const o = KB.overview || {};
  const boards = (Array.isArray(o.boards) ? o.boards : []).map((x) => ({
    value: String((x && (x.slug || x.name)) || ''),
    label: String((x && (x.name || x.slug)) || '')
      + (Number(x && x.total) ? ` (${Number(x && x.total)})` : ''),
  })).filter((x) => x.value);
  const cur = String(KB.filters.board || o.currentBoard || '');
  const sig = JSON.stringify([boards, cur]);
  if (sig === rkbBoardSig) return;
  rkbBoardSig = sig;
  el.setOptions(
    boards.filter((x) => x.value !== cur)
      .concat([{ value: '__new-board', label: '＋ 新建看板…', action: true }]),
    // 占位项显示的就是看板名本身：多一个「看板 · 」前缀只是把这一行最要紧的字推远
    cur || '当前看板');
}
/** 一张方块卡（网格单元）：顶行 [状态点] [优先级] [细状态] …… [时效]，
 *  中间标题最多 3 行 + 摘要最多 3 行，底行受让人；运行中的卡在底边压一条
 *  2px 进度条（宽度走内联 --rkb-p）。
 *  方形卡如果只放标题和一行名字，中间会空出一大片——所以把整页卡片用的
 *  latest_summary / body 摘要也搬过来：有摘要时刚好填满，没摘要时留白当呼吸。 */
function rkbCardHtml(t) {
  const st = String((t && t.status) || '');
  const asg = String((t && t.assignee) || '').trim();
  const ago = kbAgo(t && t.created_at);
  const title = String((t && t.title) || '未命名任务');
  const stLabel = KB_STATUS_LABEL[st] || st;
  // 组名已经说明了状态（待办 / 进行中），只有更细的（收集箱 / 已排期 / 待验收）才标
  const sub = RKB_SUB_STATUS.indexOf(st) >= 0 ? stLabel : '';
  const pri = Number((t && t.priority) || 0);
  const pm = kbPriMeta(pri);
  const runStart = st === 'running' ? kbRunStart(t) : 0;
  const limit = runStart ? kbRunLimit(t) : 0;
  const sum = String((t && (t.latest_summary || t.body)) || '').trim();
  const time = runStart
    ? `<span class="rkb-run" data-kb-run="${runStart}" data-kb-run-max="${limit}"><span class="kb-run-txt">${esc(kbRunClockText(kbRunElapsed(runStart), limit))}</span></span>`
    : (ago ? `<span class="rkb-age">${esc(ago)}</span>` : '');
  const dot = rkbDotFor(st);
  const pct = runStart && limit ? Math.round(kbRunPct(kbRunElapsed(runStart), limit)) : 0;
  const tip = [title, stLabel || '未知状态', asg, ago].filter(Boolean).join(' · ');
  return `<button class="rkb-card${runStart ? ' is-running' : ''}" type="button"`
    + ` data-rkb-task="${esc((t && t.id) || '')}" data-dot="${esc(dot)}" title="${esc(tip)}"`
    + (pct ? ` style="--rkb-p:${pct}%"` : '') + '>'
    + '<span class="rkb-card-top">'
    + `<span class="rkb-dot" data-dot="${esc(dot)}"></span>`
    // 默认权重(0)不占位；其余用统一 P 级（P0 最紧急）
    + (pri > 0 ? `<span class="rkb-pri ${pm.rcls}" title="${esc(pm.title)}">${pm.tag}</span>` : '')
    + (sub ? `<span class="rkb-st">${esc(sub)}</span>` : '')
    + time
    + '</span>'
    + `<span class="rkb-title">${esc(title)}</span>`
    + (sum ? `<span class="rkb-sum">${esc(clip(sum, 160))}</span>` : '')
    + `<span class="rkb-card-bot">${asg ? `<span class="rkb-asg">${esc(asg)}</span>` : ''}</span>`
    + '</button>';
}
/** 组头右侧的折叠箭头：三个按钮已经是矢量图标了，箭头再用字符会跟字体基线打架。 */
const RKB_CARET = '<svg class="rkb-caret" viewBox="0 0 12 12" width="10" height="10" fill="none"'
  + ' stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
  + ' aria-hidden="true"><path d="M4.6 2.6 8 6l-3.4 3.4" /></svg>';
function rkbGroupHtml(g, state) {
  const tasks = g.all.slice(0, RKB_MAX_CARDS);
  const cards = tasks.map((t) => rkbCardHtml(t)).join('');
  const more = g.all.length > tasks.length
    ? `<button class="rkb-more" type="button" data-rkb-more="${esc(g.key)}">还有 ${g.all.length - tasks.length} 张 →</button>`
    : '';
  const body = cards ? `<div class="rkb-cards">${cards}</div>` : '<div class="rkb-none">这一组是空的</div>';
  // 进行中永远是这一屏的主角：组名给正文色 + 加粗，眼睛第一眼就落在上面
  const cls = `rkb-group-head${g.key === 'running' ? ' is-hot' : ''}`;
  const head = `<span class="rkb-dot" data-dot="${esc(g.dot)}"></span>`
    + `<span class="rkb-group-name">${esc(g.label)}</span>`
    + `<span class="rkb-group-num">${g.all.length}</span>`;
  // 按筛选只剩一组时不做折叠：点 chip 就是为了看卡片，再收起来没有意义
  if (state.flat) {
    return `<div class="rkb-group is-flat"><div class="${cls} is-static" title="${esc(g.hint)}">${head}</div>`
      + `${body}${more}</div>`;
  }
  // 首次渲染只展开「不是已完成」的组：已完成常常几十张，一进来就淹没在历史里
  const open = state.first ? (g.key !== 'done') : !!state.opened[g.key];
  return `<details class="rkb-group" data-rkb-group="${esc(g.key)}"${open ? ' open' : ''}>`
    + `<summary class="${cls}" title="${esc(g.hint)}">${head}${RKB_CARET}</summary>`
    + `${body}${more}</details>`;
}
function renderRailKanban() {
  const host = $('#rkb-groups');
  if (!host) return;
  const groups = rkbOrdered(kbGroups());
  const total = groups.reduce((n, g) => n + g.all.length, 0);
  const running = (groups.find((g) => g.key === 'running') || { all: [] }).all.length;
  rkbSyncBoardSwitch();
  // 比例条：一眼看出这个板是「一堆排队」还是「大半跑完」。
  // 只在有任务时画；空组不占灰段，否则零任务的看板会挂一条纯灰线。
  const meter = $('#rkb-meter');
  if (meter) {
    meter.innerHTML = total
      ? groups.filter((g) => g.all.length > 0).map((g) =>
        `<span class="rkb-seg" data-dot="${esc(g.dot)}" style="flex-grow:${g.all.length}"`
        + ` title="${esc(g.label)} ${g.all.length} 张"></span>`).join('')
      : '';
  }
  // 统计与筛选合一：点一下只看这一组，再点一次回到全部（本地过滤，不打 REST）
  const sum = $('#rkb-summary');
  if (sum) {
    const chip = (key, label, dot, n, tip) =>
      `<button class="rkb-stat${rkbFilter === key ? ' is-on' : ''}" type="button" data-rkb-group="${esc(key)}"`
      + (dot ? ` data-dot="${esc(dot)}"` : '')
      + ` aria-pressed="${rkbFilter === key ? 'true' : 'false'}" title="${esc(tip)}">`
      + (dot ? '<span class="rkb-dot"></span>' : '')
      + `${esc(label)}<b>${Number(n) || 0}</b></button>`;
    sum.innerHTML = chip('', '全部', '', total, '显示全部任务')
      + groups.map((g) => chip(g.key, g.label, g.dot, g.all.length, `${g.hint} · 点一下只看这一组`)).join('');
  }
  if (KB.error) {
    host.innerHTML = `<div class="rkb-empty"><div class="rkb-empty-main">${esc(KB.error)}</div></div>`;
  } else if (!KB.board) {
    host.innerHTML = '<div class="rkb-empty"><div class="rkb-empty-main">正在读取看板…</div></div>';
  } else {
    // 折叠状态存在 DOM 里：重渲染前读一次，避免每 5 秒同步把用户收起的组又打开。
    // 「首次」按有没有分组节点判断，不能按 host 是否为空 —— 加载态 / 空态占位会让
    // 数据回来时误判成非首次，五个组全被折叠。
    const opened = {};
    const existing = host.querySelectorAll('details.rkb-group');
    const first = existing.length === 0;
    existing.forEach((d) => { opened[d.dataset.rkbGroup] = d.open; });
    // 速览用 g.all：整页的搜索 / 受让人筛选不该悄悄改变这边的全局感。
    // 不筛选时把 0 张的组整个藏掉 —— 一排「暂无任务」在速览里只是占地方，
    // 想知道哪组是空的看上面的 chip 计数就够了；筛选时反而要留着（空态也是信息）。
    const shown = rkbFilter
      ? groups.filter((g) => g.key === rkbFilter)
      : groups.filter((g) => g.all.length > 0);
    host.innerHTML = shown.length
      ? shown.map((g) => rkbGroupHtml(g, { first, opened, flat: !!rkbFilter })).join('')
      : `<div class="rkb-empty">
          <div class="rkb-empty-ico">◫</div>
          <div class="rkb-empty-main">这个看板还没有任务</div>
          <div class="rkb-empty-hint">点栏头的 ＋ 新建一个，或打开完整看板批量拆分</div>
        </div>`;
  }
  const foot = $('#rkb-foot-text');
  if (foot) {
    // 筛选时脚注要说明「看到的是子集」：光看一组卡片会忘了全板还有多少
    const picked = groups.find((g) => g.key === rkbFilter);
    foot.textContent = KB.error || (!KB.board ? '等待数据'
      : picked ? `${picked.label} ${picked.all.length} 张 / 共 ${total} 张`
        // 「每 5 秒同步」在页签栏已经写着「实时同步」，脚注不再重复一遍
        : `${total} 张${running ? ` · 进行中 ${running}` : ''}`);
  }
  kbRunWatch(); // 运行中的卡在缩略视图里也要走表；没有可见节点会自停
}
