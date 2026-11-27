// 看板入口：列折叠 / 键盘快捷键 / setupKanban 事件绑定
function kbToggleCol(key) {
  const k = String(key || '');
  if (!k || KB.status || !kbValidGroupKey(k)) return;
  if (KB.collapsed.has(k)) KB.collapsed.delete(k);
  else KB.collapsed.add(k);
  kbSavePrefs();
  renderKanbanBody();
}
function kbIsTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (el.closest && el.closest('.us-pop')) return true;
  return false;
}
function kbMoveCardFocus(dir) {
  const cards = [...document.querySelectorAll('#kb-scroll .kb-card[data-kb-task]')]
    .filter((el) => el.getClientRects().length > 0);
  if (!cards.length) return false;
  const ae = document.activeElement;
  let idx = ae && ae.classList && ae.classList.contains('kb-card')
    ? cards.indexOf(ae)
    : cards.findIndex((c) => c.getAttribute('data-kb-task') === KB.focusId);
  if (idx < 0) idx = dir > 0 ? 0 : cards.length - 1;
  else idx = Math.max(0, Math.min(cards.length - 1, idx + dir));
  const target = cards[idx];
  if (!target) return false;
  KB.focusId = String(target.getAttribute('data-kb-task') || '');
  try { target.focus({ preventScroll: false }); } catch {}
  if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}
function kbHandleKeydown(e) {
  if (!e || e.metaKey || e.ctrlKey || e.altKey) return;
  const page = $('#kanban-page');
  if (!page || page.hidden) return;
  if (KbDrag.on || KbDrag.armed) return;
  // 任何全局 / 看板弹层或菜单打开时不抢键位
  for (const sel of ['#kb-modal', '#palette', '#help-modal', '#settings-page', '#kb-more-menu', '#kbd-menu', '#kb-dispatch-panel']) {
    const el = $(sel);
    if (el && !el.hidden) return;
  }
  if (document.querySelector('.us-pop:not([hidden])')) return;
  if (kbIsTypingTarget(e.target) || kbIsTypingTarget(document.activeElement)) return;

  const drawer = $('#kb-drawer');
  if (drawer && !drawer.hidden) {
    if (e.key === 'ArrowUp') { e.preventDefault(); kbDrawerStep(-1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); kbDrawerStep(1); return; }
    return;
  }
  const k = (e.key || '').toLowerCase();
  if (k === 'n') { e.preventDefault(); kbModalOpen('task'); return; }
  if (e.key === '/') {
    e.preventDefault();
    const q = $('#kb-search');
    if (q) { q.focus(); q.select(); }
    return;
  }
  if (k === 'r') {
    e.preventDefault();
    const rf = $('#kb-refresh');
    if (rf) rf.click(); else kanbanLoad(true);
    return;
  }
  if (e.key === 'ArrowRight') { e.preventDefault(); kbMoveCardFocus(1); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); kbMoveCardFocus(-1); return; }
  if (e.key === 'Enter') {
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('kb-card')) {
      const id = ae.getAttribute('data-kb-task');
      if (id) { e.preventDefault(); KB.focusId = id; openKanbanTask(id); }
      return;
    }
    if (KB.focusId && (!ae || ae === document.body || ae === page || ae.id === 'kb-scroll')) {
      const visCard = document.querySelector(`#kb-scroll .kb-card[data-kb-task="${KB.focusId}"]`);
      if (visCard && visCard.getClientRects().length > 0) {
        e.preventDefault();
        openKanbanTask(KB.focusId);
      }
    }
  }
}

function setupKanban() {
  const refresh = $('#kb-refresh');
  if (refresh) refresh.onclick = async () => {
    const sp = refresh.querySelector('.kb-spin'), g = refresh.querySelector('.kb-refresh-glyph');
    if (sp) sp.hidden = false; if (g) g.hidden = true;
    await kanbanLoad(true);
    if (sp) sp.hidden = true; if (g) g.hidden = false;
  };
  const close = $('#kb-close'); if (close) close.onclick = () => closeKanbanPage();
  // 页头模式标记：只读展示，点击跳设置（设置页是独立 palette，不关看板页）
  const modeChip = $('#kb-head-mode');
  if (modeChip) modeChip.onclick = () => { settingsCat = 'kanban'; try { toggleSettings(true); } catch {} };
  const dclose = $('#kb-drawer-close'); if (dclose) dclose.onclick = () => closeKanbanDrawer();
  const mask = $('#kb-drawer-mask'); if (mask) mask.onclick = () => closeKanbanDrawer();
  const kbdPrev = $('#kbd-prev'); if (kbdPrev) kbdPrev.onclick = () => kbDrawerStep(-1);
  const kbdNext = $('#kbd-next'); if (kbdNext) kbdNext.onclick = () => kbDrawerStep(1);
  const kbdMoreBtn = $('#kbd-more'), kbdMenu = $('#kbd-menu'), kbdDel = $('#kbd-menu-delete');
  if (kbdMoreBtn) kbdMoreBtn.onclick = () => kbdMoreToggle(kbdMenu ? kbdMenu.hidden : true);
  if (kbdDel) kbdDel.onclick = () => {
    kbdMoreToggle(false);
    const bodyEl = $('#kb-drawer-body');
    const host = (bodyEl && bodyEl.querySelector('#kbd-danger')) || bodyEl;
    if (KB.detailId) kbDeleteTask(KB.detailId, host);
    if (host && host.scrollIntoView) host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  if (kbdMenu) {
    document.addEventListener('pointerdown', (e) => {
      if (!kbdMenu || kbdMenu.hidden) return;
      if (kbdMenu.contains(e.target)) return;
      if (kbdMoreBtn && kbdMoreBtn.contains(e.target)) return;
      kbdMoreToggle(false);
    }, true);
  }

  // 「⋯」菜单：新建看板 / 新建项目 / 绑定项目 / 手动派发 / 切换视图 / 显示已归档
  const moreBtn = $('#kb-more'), moreMenu = $('#kb-more-menu');
  if (moreBtn) moreBtn.onclick = () => kbMoreToggle(moreMenu ? moreMenu.hidden : true);
  if (moreMenu) {
    moreMenu.addEventListener('click', (e) => {
      const sortBtn = e.target.closest && e.target.closest('[data-kb-sort]');
      if (sortBtn) {
        const nextSort = sortBtn.getAttribute('data-kb-sort') || 'default';
        if (KB_SORT_MODES.includes(nextSort) && KB.sort !== nextSort) {
          KB.sort = nextSort;
          kbSavePrefs();
          kbMoreSync();
          renderKanbanBody();
          if (!$('#kb-drawer').hidden && KB.detailId) kbSyncDrawerNav();
        }
        return;
      }
      const item = e.target.closest && e.target.closest('[data-kb-more]');
      if (!item) return;
      const what = item.getAttribute('data-kb-more');
      // 勾选框那一项不关菜单：用户可能想连着看两个结果
      if (what === 'board') { kbMoreToggle(false); kbModalOpen('board'); return; }
      if (what === 'project') { kbMoreToggle(false); kbModalOpen('project'); return; }
      if (what === 'bind') { kbMoreToggle(false); kbModalOpen('bind'); return; }
      if (what === 'dispatch') { kbMoreToggle(false); kbDispatchToggle(!KB.dispatch.open); return; }
      if (what === 'view') {
        KB.view = KB.view === 'grid' ? 'cols' : 'grid';
        kbSavePrefs();
        kbMoreSync(); renderKanbanBody(); return;
      }
    });
    // 点菜单外面收起（捕获阶段：免得页面里的按钮先响应再收菜单）
    document.addEventListener('pointerdown', (e) => {
      if (!moreMenu || moreMenu.hidden) return;
      if (moreMenu.contains(e.target)) return;
      if (moreBtn && moreBtn.contains(e.target)) return;
      kbMoreToggle(false);
    }, true);
  }

  // 派发控制台：默认 dry-run；真派发走 opConfirm 二次确认。
  // 入口只有一个 —— 「⋯」菜单里的「手动派发控制台」，这里不再绑页头按钮。
  const dpMask = $('#kb-dp-mask'); if (dpMask) dpMask.onclick = () => kbDispatchToggle(false);
  const dpClose = $('#kb-dp-close'); if (dpClose) dpClose.onclick = () => kbDispatchToggle(false);
  const dpPreview = $('#kb-dp-preview'); if (dpPreview) dpPreview.onclick = () => kbDispatchRun(true);
  const dpRun = $('#kb-dp-run'); if (dpRun) dpRun.onclick = () => kbDispatchConfirm();
  const dpRefresh = $('#kb-dp-workers-refresh'); if (dpRefresh) dpRefresh.onclick = () => kbDispatchLoadWorkers();
  const dpMax = $('#kb-dp-max');
  if (dpMax) {
    dpMax.onchange = () => { kbDpClearConfirm(); kbDpState('', ''); };
    // 下拉里按 Esc 只收派发面板，不冒泡关掉整页
    guardFieldKey(dpMax, () => kbDispatchToggle(false));
  }

  const newTask = $('#kb-new-task'); if (newTask) newTask.onclick = () => kbModalOpen('task');
  const mclose = $('#kb-modal-close'); if (mclose) mclose.onclick = () => kbModalClose();
  const mcancel = $('#kb-modal-cancel'); if (mcancel) mcancel.onclick = () => kbModalClose();
  const mmask = $('#kb-modal-mask'); if (mmask) mmask.onclick = () => kbModalClose();
  const msubmit = $('#kb-modal-submit'); if (msubmit) msubmit.onclick = () => kbModalSubmit();
  // 官方 project-dialog：目录选择器、输入即时校验、想法模板 chip
  const padd = $('#kb-p-add'); if (padd) padd.onclick = () => kbPickProjectFolders();
  const pname = $('#kb-p-name'); if (pname) pname.addEventListener('input', kbSyncProjectSubmit);
  const pideas = $('#kb-p-ideas');
  if (pideas) pideas.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('.kb-pchip');
    const idea = $('#kb-p-idea');
    if (chip && idea) { idea.value = chip.getAttribute('data-idea') || ''; idea.focus(); }
  });
  // 表单里按 Esc 只收本弹窗，不冒泡关掉整页；字段用 keydown 守卫，命令面板同理。
  document.querySelectorAll('#kb-form-task input, #kb-form-task hm-select, #kb-form-task textarea, #kb-form-board input, #kb-form-board textarea, #kb-form-bind hm-select, #kb-form-project input, #kb-form-project textarea')
    .forEach((el) => {
      guardFieldKey(el, () => kbModalClose());
      // 文本字段里回车即提交；textarea 保留换行，不抢全局快捷键
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && el.tagName !== 'TEXTAREA') {
          e.preventDefault(); e.stopPropagation(); kbModalSubmit();
        }
      });
    });
  const statusSel = $('#kb-f-status');
  if (statusSel) statusSel.onchange = () => kbSyncStatusNote();
  // 选了具体项目时，底注实时说明它对工作区的决定作用
  const fproj = $('#kb-f-project');
  if (fproj) fproj.addEventListener('change', () => kbSyncProjectNote());
  // 受让人手打的名字如果不是磁盘上的 profile，说明文字立刻转红字警告
  const assigneeInput = $('#kb-f-assignee');
  if (assigneeInput) assigneeInput.addEventListener('change', () => kbSyncAssigneeHint());
  // 表单里回车提交（textarea 除外），不触发全局快捷键
  ['#kb-form-task', '#kb-form-board'].forEach((s) => {
    const form = $(s);
    if (!form) return;
    form.onsubmit = (e) => { e.preventDefault(); kbModalSubmit(); };
  });

  // 视图切换与「显示已归档」都在「⋯」菜单里，页面上没有对应的常驻按钮
  const statusbar = $('#kb-statusbar');
  if (statusbar) statusbar.addEventListener('click', (e) => {
    const chip = e.target.closest && e.target.closest('[data-kb-status]');
    if (!chip) return;
    const v = chip.getAttribute('data-kb-status') || '';
    KB.status = KB.status === v ? '' : v;
    kbSavePrefs();
    renderKanbanStatusbar();
    renderKanbanBody();
  });

  let qTimer = null;
  const q = $('#kb-search');
  if (q) q.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      KB.filters.q = q.value.trim();
      const clear = $('#kb-search-clear');
      if (clear) clear.hidden = !KB.filters.q;
      renderKanbanStatusbar();
      renderKanbanBody();
    }, 160);
  });
  const qclear = $('#kb-search-clear');
  if (qclear) qclear.onclick = () => {
    if (q) q.value = '';
    KB.filters.q = ''; qclear.hidden = true;
    renderKanbanStatusbar();
    renderKanbanBody();
    if (q) q.focus();
  };
  if (q) q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (q.value || KB.filters.q)) {
      e.preventDefault();
      e.stopPropagation();
      q.value = '';
      KB.filters.q = '';
      if (qclear) qclear.hidden = true;
      renderKanbanStatusbar();
      renderKanbanBody();
    }
  });
  const clearFilters = $('#kb-clear-filters');
  if (clearFilters) clearFilters.onclick = kbResetFilters;
  if ($('#kb-f-adv-btn')) $('#kb-f-adv-btn').onclick = () => kbToggleAdv('f');
  if ($('#kb-b-adv-btn')) $('#kb-b-adv-btn').onclick = () => kbToggleAdv('b');
  const kbPage = $('#kanban-page');
  if (kbPage) kbPage.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-kb-clear-filters]')) kbResetFilters();
  });
  const assignee = $('#kb-assignee');
  if (assignee) assignee.onchange = () => {
    KB.filters.assignee = assignee.value;
    kbSavePrefs();
    renderKanbanStatusbar(); renderKanbanBody();
  };
  const tenant = $('#kb-tenant');
  if (tenant) tenant.onchange = () => { KB.filters.tenant = tenant.value; kanbanLoad(false); };
  const boardSel = $('#kb-board');
  if (boardSel) boardSel.onchange = () => {
    KB.filters.board = boardSel.value;
    KB.overview = null; kbSelectSig = '';
    kbLoadPrefs();
    kanbanLoad(true);
  };
  const archived = $('#kb-archived');
  if (archived) archived.onchange = () => {
    KB.filters.archived = !!archived.checked;
    // 渲染完再滚：此时第 6 列才存在，scrollWidth 才是六列的值
    kanbanLoad(false).then(() => kbScrollToArchived(KB.filters.archived));
  };

  const scroll = $('#kb-scroll');
  if (scroll) {
    scroll.addEventListener('pointerdown', kbDragDown);
    scroll.addEventListener('click', (e) => {
      // 拖动结束后浏览器补发的 click 要吞掉，否则会顺手打开详情抽屉
      if (KbDrag.suppressClick) { KbDrag.suppressClick = false; return; }
      const colToggle = e.target.closest && e.target.closest('[data-kb-collapse]');
      if (colToggle) { kbToggleCol(colToggle.getAttribute('data-kb-collapse')); return; }
      const collapsedCol = e.target.closest && e.target.closest('.kb-col.is-collapsed');
      if (collapsedCol) { kbToggleCol(collapsedCol.getAttribute('data-group')); return; }
      const n = e.target.closest && e.target.closest('[data-kb-new]');
      if (n) { kbModalOpen('task', n.getAttribute('data-kb-new-status') || ''); return; }
      const card = e.target.closest && e.target.closest('[data-kb-task]');
      if (card) { KB.focusId = String(card.getAttribute('data-kb-task') || ''); openKanbanTask(card.getAttribute('data-kb-task')); }
    });
  }
  // 拖拽走指针事件：document 级监听才能接住「拖出滚动区再松手」
  document.addEventListener('pointermove', kbDragMove, { passive: false });
  document.addEventListener('pointerup', kbDragUp);
  document.addEventListener('pointercancel', () => { if (KbDrag.armed || KbDrag.on) kbDragReset(); });
  window.addEventListener('blur', () => { if (KbDrag.armed || KbDrag.on) kbDragReset(); });
  const body = $('#kb-drawer-body');
  if (body) body.addEventListener('click', (e) => {
    const sub = e.target.closest && e.target.closest('[data-kb-submit]');
    if (sub) { kbSubmitTask(sub.getAttribute('data-kb-submit'), sub.closest('.kbd-actions') || body); return; }
    const dec = e.target.closest && e.target.closest('[data-kb-decompose]');
    if (dec) { kbDecomposeTask(dec.getAttribute('data-kb-decompose'), dec.closest('.kbd-actions') || body); return; }
    const edt = e.target.closest && e.target.closest('[data-kb-edit]');
    if (edt) {
      const form = $('#kbd-edit-form');
      if (form) { form.hidden = !form.hidden; if (!form.hidden && $('#kbd-edit-title')) $('#kbd-edit-title').focus(); }
      return;
    }
    const edtCancel = e.target.closest && e.target.closest('[data-kb-edit-cancel]');
    if (edtCancel) { const form = $('#kbd-edit-form'); if (form) form.hidden = true; return; }
    const edtSave = e.target.closest && e.target.closest('[data-kb-edit-save]');
    if (edtSave) { kbSaveTaskEdit(edtSave.getAttribute('data-kb-edit-save')); return; }
    const logBtn = e.target.closest && e.target.closest('[data-kb-log]');
    if (logBtn) { kbLoadTaskLog(logBtn.getAttribute('data-kb-log')); return; }
    const refBtn = e.target.closest && e.target.closest('[data-kb-refresh-detail]');
    if (refBtn && KB.detailId) { openKanbanTask(KB.detailId, false); return; }
    const runBtn = e.target.closest && e.target.closest('button[data-kb-run-id]');
    if (runBtn) {
      const runId = runBtn.getAttribute('data-kb-run-id');
      const box = $('#kbd-run-' + runId);
      if (box) {
        if (!box.hidden) { box.hidden = true; return; }
        box.hidden = false; box.textContent = '读取运行详情…';
        const a = kbApi();
        const epoch = KB.detailEpoch;
        if (a && a.kanbanRun) {
          a.kanbanRun(runId, kbParams()).then((r) => {
            if (KB.detailEpoch !== epoch || !box.isConnected) return;
            if (!r || !r.ok || !r.run) { box.textContent = (r && r.error) || '读取失败'; return; }
            const u = r.run;
            box.textContent = [u.profile && ('profile: ' + u.profile), u.step_key && ('step: ' + u.step_key), u.summary || u.outcome || u.error || ''].filter(Boolean).join(' · ') || '无更多详情';
          }).catch(() => { if (KB.detailEpoch === epoch && box.isConnected) box.textContent = '读取失败'; });
        } else {
          box.textContent = '当前环境不支持读取运行详情';
        }
      }
      return;
    }
    const spec = e.target.closest && e.target.closest('[data-kb-specify]');
    if (spec) { kbSpecifyTask(spec.getAttribute('data-kb-specify'), spec.closest('.kbd-actions') || body); return; }
    const est = e.target.closest && e.target.closest('[data-kb-estimate]');
    if (est) { kbEstimateTask(est.getAttribute('data-kb-estimate'), est.closest('.kbd-actions') || body); return; }
    const mv = e.target.closest && e.target.closest('[data-kb-move]');
    if (mv && KB.detailId) { kbDropToStatus(KB.detailId, mv.getAttribute('data-kb-move')); return; }
    const del = e.target.closest && e.target.closest('[data-kb-delete]');
    if (del) { kbDeleteTask(del.getAttribute('data-kb-delete'), del.closest('.kbd-danger')); return; }
    const re = e.target.closest && e.target.closest('[data-kb-reassign]');
    if (re) { kbReassignTask(re.getAttribute('data-kb-reassign'), re.closest('.kbd-reassign') || body); return; }
    const cmt = e.target.closest && e.target.closest('[data-kb-comment]');
    if (cmt) { kbAddComment(cmt.getAttribute('data-kb-comment')); return; }
    const t = e.target.closest && e.target.closest('[data-kb-task]');
    if (t) { openKanbanTask(t.getAttribute('data-kb-task')); return; }
    const s = e.target.closest && e.target.closest('[data-kb-session]');
    if (s) kbJumpToSession(s.getAttribute('data-kb-session'));
  });
  document.addEventListener('keydown', kbHandleKeydown);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && $('#kanban-page') && !$('#kanban-page').hidden) kanbanLoad(false);
  });
}
setupKanban();
init();
