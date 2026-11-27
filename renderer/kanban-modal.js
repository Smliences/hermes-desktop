// 看板弹窗：新建任务 / 新建与编辑看板 / 项目设置与目录管理
/* ---- 新建弹窗 ---- */
function kbSetBackgroundInert(_on) {
  // 弹窗已移到 #frame 之外：背景隔离统一交给 syncPageLead 按 modalOpen 计算 frame.inert，
  // 与设置 / 命令面板 / 帮助层共用一套状态，避免互相覆盖；遮罩与弹窗本身不被锁住。
  syncPageLead();
}
function kbModalErr(text) {
  const e = $('#kb-modal-err');
  if (!e) return;
  e.textContent = text || '';
  e.hidden = !text;
}
/** 起始状态对应的底注：ready 会被调度器认领，必须给出警示色。
 *  收集箱也不能写「不会派发」—— gateway 每个 tick 会把 triage 卡交给自动分解器
 *  （kanban.auto_decompose，默认开），补全 spec、填受让人、推到 todo→ready 后照样拉起
 *  worker。只有把 auto_decompose 关掉，收集箱才真的停住。 */
function kbSyncStatusNote() {
  const sel = $('#kb-f-status'), note = $('#kb-f-note');
  if (!sel || !note) return;
  const ready = sel.value === 'ready';
  note.classList.toggle('warn', ready);
  note.textContent = ready
    ? '就绪状态可能被调度器立即认领并启动 worker 执行，请确认后再创建。'
    : '收集箱默认等 gateway 自动分解（kanban.auto_decompose）补全并推进，不会立刻拉起。';
}
/* 官方 project-dialog.tsx 的本地等价：一个弹窗四种模式
   （create / rename / add-folder / settings）+ 一个删除确认弹窗。
   文件夹由主进程原生目录选择器给出，第一个为主；选完自动以 basename 命名项目。 */
const KB_PROJECT_KINDS = ['project', 'project-rename', 'project-add-folder', 'project-settings', 'project-delete'];
function kbProjectFolderBasename(dir) {
  return String(dir || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
}
/** 重绘文件夹列表：首条标「主」，逐条可移除；设置模式还能「设为主」。
 *  路径只走 textContent 落地，绝不拼进 HTML。 */
function kbRenderProjectFolders() {
  const host = $('#kb-p-folders');
  if (!host) return;
  const settings = !!KB.projectDialog && KB.projectDialog.mode === 'settings';
  host.innerHTML = '';
  if (!KB.projFolders.length) {
    const empty = document.createElement('div');
    empty.className = 'kb-pfold-empty';
    empty.textContent = '尚未添加文件夹。';
    host.appendChild(empty);
    return;
  }
  KB.projFolders.forEach((dir, i) => {
    const row = document.createElement('div');
    row.className = 'kb-pfold';
    row.setAttribute('role', 'listitem');
    row.innerHTML = '<span class="kb-pfold-ico">📁</span><span class="kb-pfold-path"></span>' +
      (i === 0 ? '<span class="kb-pfold-primary">主</span>' : '') +
      (settings && i > 0 ? '<button class="kb-pfold-pri" type="button" title="设为主文件夹">设为主</button>' : '') +
      '<button class="kb-pfold-rm" type="button" title="移除" aria-label="移除">×</button>';
    const label = row.querySelector('.kb-pfold-path');
    label.textContent = dir;
    label.title = dir;
    const pri = row.querySelector('.kb-pfold-pri');
    if (pri) {
      pri.onclick = () => {
        KB.projFolders = [dir, ...KB.projFolders.filter((x) => x !== dir)];
        kbRenderProjectFolders();
      };
    }
    row.querySelector('.kb-pfold-rm').onclick = () => {
      KB.projFolders = KB.projFolders.filter((x) => x !== dir);
      kbRenderProjectFolders();
      kbSyncProjectSubmit();
    };
    host.appendChild(row);
  });
}
/** 提交按钮条件：名称非空 + 至少一个文件夹（没有文件夹的项目无法认领会话）。
 *  设置模式下文件夹也不能被删空，否则项目会变成谁也进不去的空壳。 */
function kbSyncProjectSubmit() {
  if ((KB.modal !== 'project' && KB.modal !== 'project-settings') || KB.modalBusy) return;
  const submit = $('#kb-modal-submit');
  if (!submit) return;
  submit.disabled = !((($('#kb-p-name')?.value || '').trim()) && KB.projFolders.length > 0);
}
/** 项目写操作后：侧栏树即时收录，看板项目候选下次进页重读。 */
async function kbApplyProjectWrite() {
  KB.overview = null; kbSelectSig = '';
  try { await refreshSessions(currentSearch()); } catch {}
}
/** 弹窗里点「添加文件夹…」：create 模式累加去重；add-folder 模式选完即写入。 */
async function kbPickProjectFolders() {
  const a = kbApi();
  if (!a || typeof a.pickProjectFolders !== 'function' || typeof a.projectAction !== 'function') {
    kbModalErr('此页需要 Hermes 桌面端才能选择文件夹'); return;
  }
  const mode = (KB.projectDialog && KB.projectDialog.mode) || 'create';
  let r = null;
  try { r = await a.pickProjectFolders({ multiple: mode !== 'add-folder' }); } catch { r = null; }
  if (!r || !r.ok) { if (r && !r.canceled) kbModalErr(r.error || '选择文件夹失败'); return; }
  const picked = (Array.isArray(r.folders) ? r.folders : [])
    .filter((p) => typeof p === 'string' && p.startsWith('/')).slice(0, 8);
  if (!picked.length) return;
  if (mode === 'add-folder') { await kbSubmitAddFolders(picked); return; }
  KB.projFolders = [...new Set([...KB.projFolders, ...picked])].slice(0, 8);
  const nameEl = $('#kb-p-name');
  if (nameEl && !nameEl.value.trim()) nameEl.value = kbProjectFolderBasename(picked[0]);
  kbRenderProjectFolders();
  kbSyncProjectSubmit();
}
/** 官方 add-folder 模式：一次多选里的每个目录各写一次 CLI，失败保留弹窗可重试。 */
async function kbSubmitAddFolders(folders) {
  if (KB.modalBusy) return;
  const a = kbApi();
  const target = KB.projectDialog || {};
  if (!a || typeof a.projectAction !== 'function' || !target.projectId) {
    kbModalErr('缺少目标项目'); return;
  }
  KB.modalBusy = true;
  const submit = $('#kb-modal-submit');
  if (submit) submit.disabled = true;
  kbModalErr('');
  try {
    for (const folder of folders) {
      const r = await a.projectAction({ op: 'addFolder', id: target.projectId, folder });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '添加文件夹失败'); return; }
    }
    kbModalClose();
    toast(`已添加 ${folders.length} 个文件夹`, 1800);
    await kbApplyProjectWrite();
  } catch (e) {
    kbModalErr((e && e.message) || '操作失败');
  } finally {
    KB.modalBusy = false;
    if (submit) submit.disabled = false;
    kbSyncProjectSubmit();
  }
}
/** 设置弹窗预填：侧栏树只有名字与主路径，描述和全部文件夹要读一次 projects.get。 */
async function kbFillProjectSettings() {
  const d = KB.projectDialog || {};
  const a = kbApi();
  if (!d.projectId || !a || typeof a.projectGet !== 'function') {
    kbModalErr('此页需要 Hermes 桌面端才能编辑项目'); return;
  }
  let r = null;
  try { r = await a.projectGet(d.projectId); } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
  // 期间关了弹窗或换了目标项目：旧响应不许写进新面板
  if (!KB.projectDialog || KB.projectDialog.projectId !== d.projectId || KB.modal !== 'project-settings') return;
  if (!r || !r.ok || !r.project) { kbModalErr((r && r.error) || '读取项目失败'); return; }
  const pr = r.project;
  const nameEl = $('#kb-p-name'), descEl = $('#kb-p-sdesc');
  if (nameEl) nameEl.value = pr.name || d.projectName || '';
  if (descEl) descEl.value = pr.description || '';
  KB.projFolders = (Array.isArray(pr.folders) ? pr.folders : [])
    .map((f) => String((f && f.path) || '')).filter((p) => p.startsWith('/')).slice(0, 8);
  KB.projectDialog.snapshot = {
    name: pr.name || d.projectName || '',
    description: pr.description || '',
    folders: KB.projFolders.slice(),
    primary: pr.primaryPath || KB.projFolders[0] || '',
  };
  kbRenderProjectFolders();
  kbSyncProjectSubmit();
}
/** 设置弹窗保存：按快照算差量，只写真正改过的部分（名称+描述一次 RPC，文件夹逐项增删/设主）。 */
async function kbSubmitProjectSettings() {
  const d = KB.projectDialog || {};
  const a = kbApi();
  const snap = d.snapshot || {};
  const id = d.projectId;
  if (!id) { kbModalErr('缺少目标项目'); return; }
  if (!a || typeof a.projectUpdate !== 'function' || typeof a.projectFolder !== 'function') {
    kbModalErr('此页需要 Hermes 桌面端才能保存项目设置'); return;
  }
  const name = ($('#kb-p-name')?.value || '').trim();
  const desc = ($('#kb-p-sdesc')?.value || '').trim();
  if (!name) { kbModalErr('请填写项目名称'); return; }
  if (!KB.projFolders.length) { kbModalErr('至少保留一个文件夹'); return; }
  const before = Array.isArray(snap.folders) ? snap.folders : [];
  const removed = before.filter((f) => !KB.projFolders.includes(f));
  const added = KB.projFolders.filter((f) => !before.includes(f));
  const primary = KB.projFolders[0] || '';
  const patch = {};
  if (name !== (snap.name || '')) patch.name = name;
  if (desc !== (snap.description || '')) patch.description = desc;
  const submit = $('#kb-modal-submit');
  KB.modalBusy = true;
  if (submit) submit.disabled = true;
  kbModalErr('');
  try {
    if (Object.keys(patch).length) {
      const r = await a.projectUpdate({ id, ...patch });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '保存名称/描述失败'); return; }
    }
    for (const folder of removed) {
      const r = await a.projectFolder({ op: 'remove', id, path: folder });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '移除文件夹失败'); return; }
    }
    for (const folder of added) {
      const r = await a.projectFolder({ op: 'add', id, path: folder });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '添加文件夹失败'); return; }
    }
    if (primary && (snap.primary || '') && primary !== snap.primary) {
      const r = await a.projectFolder({ op: 'primary', id, path: primary });
      if (!r || !r.ok) { kbModalErr((r && r.error) || '设为主文件夹失败'); return; }
    }
    kbModalClose();
    toast('项目设置已保存', 1800);
    await kbApplyProjectWrite();
  } catch (e) {
    kbModalErr((e && e.message) || '保存失败');
  } finally {
    KB.modalBusy = false;
    if (submit) submit.disabled = false;
    kbSyncProjectSubmit();
  }
}
/** 「新建文件夹…」：在第一个（主）文件夹下建一层，成功后直接加入列表。
 *  原生面板也能新建（createDirectory），这里给不想翻面板的用户一条捷径。 */
function kbMkdirToggle(show) {
  const row = $('#kb-p-mkdir'), hint = $('#kb-p-mkdir-hint'), input = $('#kb-p-mkdir-name');
  if (!row) return;
  if (!show) {
    row.hidden = true;
    if (hint) hint.hidden = true;
    if (input) input.value = '';
    return;
  }
  const parent = KB.projFolders[0] || '';
  if (!parent) { kbModalErr('请先添加一个文件夹作为父目录'); return; }
  const base = kbProjectFolderBasename(parent) || parent;
  if (input) { input.value = ''; input.placeholder = `新文件夹名称（建在 ${base}/ 下）`; }
  if (hint) { hint.hidden = false; hint.textContent = `将在 ${parent} 下新建一个空文件夹。`; }
  row.hidden = false;
  kbModalErr('');
  try { if (input) { input.focus({ preventScroll: true }); input.select(); } } catch {}
}
async function kbMkdirSubmit() {
  const a = kbApi();
  const parent = KB.projFolders[0] || '';
  const name = ($('#kb-p-mkdir-name')?.value || '').trim();
  if (!a || typeof a.projectMkdir !== 'function') { kbModalErr('此页需要 Hermes 桌面端才能新建文件夹'); return; }
  if (!parent) { kbModalErr('请先添加一个文件夹作为父目录'); return; }
  if (!name) { kbModalErr('请填写文件夹名称'); return; }
  const okBtn = $('#kb-p-mkdir-ok');
  if (okBtn) okBtn.disabled = true;
  kbModalErr('');
  try {
    const r = await a.projectMkdir({ parent, name });
    if (!r || !r.ok) { kbModalErr((r && r.error) || '新建文件夹失败'); return; }
    const dir = String(r.path || '');
    if (dir.startsWith('/') && !KB.projFolders.includes(dir)) {
      KB.projFolders = [...KB.projFolders, dir].slice(0, 8);
      const nameEl = $('#kb-p-name');
      if (nameEl && !nameEl.value.trim()) nameEl.value = kbProjectFolderBasename(dir);
      kbRenderProjectFolders();
      kbSyncProjectSubmit();
    }
    kbMkdirToggle(false);
    toast('已新建文件夹 ' + dir, 2000);
  } finally {
    if (okBtn) okBtn.disabled = false;
  }
}
/** 删除项目确认弹窗：默认只删记录；勾选「移到废纸篓」才由主进程按项目自己的文件夹清理磁盘。
 *  文件夹列表读一次 projects.get（含附属文件夹），读不到就退回侧栏树里的主路径。 */
function kbProjectDeleteDialog(p) {
  KB.delProject = {
    id: String((p && p.id) || ''), label: String((p && (p.label || p.id)) || ''),
    folders: (p && p.path) ? [String(p.path)] : [],
  };
  kbModalOpen('project-delete');
}
async function kbFillProjectDelete() {
  const d = KB.delProject || {};
  const who = $('#kb-p-del-who'), list = $('#kb-p-del-folders'), trash = $('#kb-p-del-trash');
  if (who) who.textContent = `将删除项目「${d.label || d.id}」及其文件夹关联。`;
  if (trash) trash.checked = false;
  kbRenderDeleteFolders();
  const a = kbApi();
  if (!d.id || !a || typeof a.projectGet !== 'function') return;
  let r = null;
  try { r = await a.projectGet(d.id); } catch {}
  if (!KB.delProject || KB.delProject.id !== d.id || KB.modal !== 'project-delete') return;
  if (r && r.ok && r.project && Array.isArray(r.project.folders) && r.project.folders.length) {
    KB.delProject.folders = r.project.folders.map((f) => String((f && f.path) || '')).filter((x) => x.startsWith('/'));
    kbRenderDeleteFolders();
  }
}
function kbRenderDeleteFolders() {
  const list = $('#kb-p-del-folders');
  if (!list) return;
  list.innerHTML = '';
  const folders = (KB.delProject && KB.delProject.folders) || [];
  const trash = $('#kb-p-del-trash');
  // 没有文件夹可删时不让勾选，避免提交后才报错
  if (trash) { trash.disabled = !folders.length; if (!folders.length) trash.checked = false; }
  if (!folders.length) {
    const d = document.createElement('div');
    d.className = 'kb-pfold-empty';
    d.textContent = '该项目没有文件夹记录。';
    list.appendChild(d);
    return;
  }
  for (const f of folders) {
    const row = document.createElement('div');
    row.className = 'kb-pfold';
    row.innerHTML = '<span class="kb-pfold-ico">📁</span><span class="kb-pfold-path"></span>';
    const label = row.querySelector('.kb-pfold-path');
    label.textContent = f;
    label.title = f;
    list.appendChild(row);
  }
}
async function kbSubmitProjectDelete() {
  if (KB.modalBusy) return;
  const d = KB.delProject || {};
  const submit = $('#kb-modal-submit');
  if (!d.id) { kbModalErr('缺少目标项目'); return; }
  const trash = !!($('#kb-p-del-trash') && $('#kb-p-del-trash').checked);
  if (trash && !(d.folders || []).length) { kbModalErr('该项目没有可删除的磁盘文件夹'); return; }
  KB.modalBusy = true;
  if (submit) submit.disabled = true;
  kbModalErr('');
  try {
    const r = await deleteProjectFromSidebar(
      { id: d.id, label: d.label, path: (d.folders || [])[0] || '' },
      { trash, folders: trash ? d.folders : [] },
    );
    if (!r || !r.ok) { kbModalErr((r && r.error) || '删除失败'); return; }
    kbModalClose();
  } finally {
    KB.modalBusy = false;
    if (submit) submit.disabled = false;
  }
}
/** 项目行 ⋯ / 侧栏入口统一走这里。弹窗是全局浮层，不切看板页也能开。 */
function kbProjectDialog(mode, project) {
  setSidebar(true);
  if (mode !== 'create') {
    const p = project || {};
    KB.projectDialog = {
      mode, projectId: String(p.id || ''), projectName: String(p.label || p.id || ''),
      snapshot: null,
    };
  }
  const kind = mode === 'create' ? 'project'
    : (mode === 'rename' ? 'project-rename'
      : (mode === 'settings' ? 'project-settings' : 'project-add-folder'));
  kbModalOpen(kind);
}
function kbModalOpen(kind, presetArg) {
  const modal = $('#kb-modal'), mask = $('#kb-modal-mask');
  if (!modal || !mask || (kind !== 'task' && kind !== 'board' && kind !== 'bind' && !KB_PROJECT_KINDS.includes(kind))) return;
  const prefill = (presetArg && typeof presetArg === 'object') ? presetArg : null;
  const presetStatus = prefill ? prefill.status : presetArg;
  KB.modal = kind;
  KB.modalBusy = false;
  KB.modalSessionId = (kind === 'task' && prefill && prefill.sessionId) ? String(prefill.sessionId) : '';
  KB.modalKey = 'desktop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const taskForm = $('#kb-form-task'), boardForm = $('#kb-form-board'), bindForm = $('#kb-form-bind');
  const projForm = $('#kb-form-project'), delForm = $('#kb-form-project-del');
  // 每次打开都从空白开始：上一次取消/创建留下的标题、受让人不能带进来
  if (taskForm) {
    taskForm.reset();
    taskForm.querySelectorAll('hm-select').forEach((el) => { if (el.reset) el.reset(); });
    taskForm.hidden = kind !== 'task';
    if (kind === 'task' && prefill) {
      if (prefill.title && $('#kb-f-title')) $('#kb-f-title').value = String(prefill.title).slice(0, 200);
      if (prefill.body && $('#kb-f-body')) $('#kb-f-body').value = String(prefill.body).slice(0, 20000);
      if (prefill.projectId && $('#kb-f-project')) $('#kb-f-project').value = String(prefill.projectId);
    }
  }
  // 列尾「＋ 添加任务」带过来的起始状态。后端只认 triage / ready，其它值一律忽略，
  // 免得界面暗示「能直接建到进行中 / 受阻 / 已完成」。
  const preset = (kind === 'task' && (presetStatus === 'ready' || presetStatus === 'triage'))
    ? presetStatus : '';
  const statusSel = $('#kb-f-status');
  if (preset && statusSel) statusSel.value = preset;
  if (boardForm) { boardForm.reset(); boardForm.hidden = kind !== 'board'; }
  if (bindForm) { bindForm.reset(); bindForm.hidden = kind !== 'bind'; }
  // 官方：每次打开都从空白开始，上一次取消/创建留下的名称与文件夹不能带进来
  const isProject = KB_PROJECT_KINDS.includes(kind);
  const isDelete = kind === 'project-delete';
  const mode = kind === 'project-rename' ? 'rename'
    : (kind === 'project-add-folder' ? 'add-folder'
      : (kind === 'project-settings' ? 'settings' : (isDelete ? 'delete' : 'create')));
  if (kind === 'project') KB.projectDialog = { mode: 'create', projectId: '', projectName: '', snapshot: null };
  if (projForm) { projForm.reset(); projForm.hidden = !isProject || isDelete; }
  if (delForm) { delForm.reset(); delForm.hidden = !isDelete; }
  KB.projFolders = [];
  kbRenderProjectFolders();
  const nameRow = $('#kb-p-name-row'), foldersRow = $('#kb-p-folders-row');
  const addBtn = $('#kb-p-add'), createOnly = $('#kb-p-create-only'), addNote = $('#kb-p-addnote');
  const settingsBlock = $('#kb-p-settings');
  if (nameRow) nameRow.hidden = mode === 'add-folder' || mode === 'delete';
  if (foldersRow) foldersRow.hidden = (mode !== 'create' && mode !== 'settings');
  if (addBtn) {
    addBtn.hidden = mode === 'rename';
    addBtn.textContent = mode === 'add-folder' ? '＋ 选择文件夹…' : '＋ 添加文件夹…';
  }
  if (createOnly) createOnly.hidden = mode !== 'create';
  if (addNote) addNote.hidden = mode !== 'add-folder';
  if (settingsBlock) settingsBlock.hidden = mode !== 'settings';
  // 新建文件夹的入口只在能改文件夹列表的模式里出现（重命名 / 删除都不需要）
  const mkOpen = $('#kb-p-mkdir-open');
  if (mkOpen) mkOpen.hidden = mode === 'rename' || mode === 'add-folder' || mode === 'delete';
  kbMkdirToggle(false);
  if (mode === 'rename') {
    const nameEl = $('#kb-p-name');
    if (nameEl) nameEl.value = (KB.projectDialog && KB.projectDialog.projectName) || '';
  }
  if (isProject && !isDelete) {
    // 绑定一次的点击入口：重开弹窗时重新赋值即可，不会叠加监听
    if (mkOpen) mkOpen.onclick = () => kbMkdirToggle(true);
    const mkOk = $('#kb-p-mkdir-ok'), mkCancel = $('#kb-p-mkdir-cancel'), mkInput = $('#kb-p-mkdir-name');
    if (mkOk) mkOk.onclick = () => kbMkdirSubmit();
    if (mkCancel) mkCancel.onclick = () => kbMkdirToggle(false);
    if (mkInput) mkInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); kbMkdirSubmit(); } };
  }
  kbSyncStatusNote();
  kbSyncProjectSelects();
  if (kind === 'task') kbSyncAdvSelects();
  kbToggleAdv('f', false);
  kbToggleAdv('b', false);
  const title = $('#kb-modal-title');
  const TITLES = { task: '新建任务', bind: '绑定项目', project: '新建项目', board: '新建看板',
    'project-rename': '重命名项目', 'project-add-folder': '添加文件夹',
    'project-settings': '项目设置', 'project-delete': '删除项目' };
  if (title) title.textContent = TITLES[kind] || '新建';
  kbModalErr('');
  const submit = $('#kb-modal-submit');
  if (submit) {
    submit.disabled = false;
    submit.textContent = kind === 'task' ? '创建任务' : (kind === 'bind' ? '保存绑定' :
      (kind === 'project' ? '创建项目' : (kind === 'project-rename' ? '保存名称' :
        (kind === 'project-add-folder' ? '选择文件夹…'
          : (kind === 'project-settings' ? '保存设置'
            : (isDelete ? '删除项目' : '创建看板'))))));
    // 官方 add-folder 模式没有底部提交按钮：选完目录直接写入
    submit.hidden = kind === 'project-add-folder';
    submit.classList.toggle('danger', isDelete);
  }
  // 设置 / 删除的字段不随表单静态 HTML 带出来，打开后按项目补一次
  if (kind === 'project-settings') kbFillProjectSettings();
  if (isDelete) kbFillProjectDelete();
  kbSyncProjectSubmit();
  kbSyncSelects();
  modal.hidden = false; mask.hidden = false;
  kbSetBackgroundInert(true);
  const first = kind === 'task' ? $('#kb-f-title') : (kind === 'bind' ? $('#kb-b-project') :
    (kind === 'project-add-folder' ? $('#kb-p-add')
      : (isDelete ? $('#kb-p-del-trash') : (isProject ? $('#kb-p-name') : $('#kb-b-slug')))));
  try { if (first) { first.focus({ preventScroll: true }); if (first.select) first.select(); } } catch {}
}
function kbModalClose() {
  const modal = $('#kb-modal'), mask = $('#kb-modal-mask');
  if (modal) modal.hidden = true;
  if (mask) mask.hidden = true;
  KB.modal = '';
  KB.modalBusy = false;
  KB.projFolders = [];
  KB.projectDialog = null;
  KB.delProject = null;
  const submit = $('#kb-modal-submit');
  if (submit) { submit.hidden = false; submit.classList.remove('danger'); }
  kbSetBackgroundInert(false);
  kbModalErr('');
  // 先解 inert 再 focus（inert 内元素会静默拒绝聚焦）
  const back = $('#kb-new-task');
  try { if (back && !$('#kanban-page').hidden) back.focus({ preventScroll: true }); } catch {}
}
function kbModalSubmit() {
  if (KB.modalBusy || !KB.modal) return Promise.resolve();
  // 设置 / 删除各有自己的写路径（差量保存、可选移废纸篓），不进看板那套 payload
  if (KB.modal === 'project-settings') return kbSubmitProjectSettings();
  if (KB.modal === 'project-delete') return kbSubmitProjectDelete();
  const a = kbApi();
  if (!a || !a.kanbanCreateTask || !a.kanbanCreateBoard) { kbModalErr('此页需要 Hermes 桌面端才能写入看板'); return Promise.resolve(); }
  const kind = KB.modal, key = KB.modalKey;
  let payload;
  if (kind === 'task') {
    const title = ($('#kb-f-title')?.value || '').trim();
    if (!title) { kbModalErr('请填写任务标题'); return Promise.resolve(); }
    const maxRt = Number($('#kb-f-maxrt')?.value);
    const goalTurns = Number($('#kb-f-goal-turns')?.value);
    const parentVal = ($('#kb-f-parents')?.value || '').trim();
    const skillVal = ($('#kb-f-skills')?.value || '').trim();
    const modelVal = ($('#kb-f-model')?.value || '').trim();
    payload = {
      title,
      body: $('#kb-f-body')?.value || '',
      status: $('#kb-f-status')?.value === 'ready' ? 'ready' : 'triage',
      priority: Number($('#kb-f-priority')?.value) || 0,
      assignee: $('#kb-f-assignee')?.value || '',
      tenant: $('#kb-f-tenant')?.value || '',
      board: $('#kb-f-board')?.value || KB.filters.board || '',
      // 空值 = 继承看板绑定（服务层只在非空时透传 project_id）
      projectId: $('#kb-f-project')?.value || '',
      workspaceKind: $('#kb-f-wskind')?.value || '',
      workspacePath: ($('#kb-f-wspath')?.value || '').trim(),
      parents: parentVal ? [parentVal] : [],
      skills: skillVal ? [skillVal] : [],
      maxRuntimeSeconds: Number.isInteger(maxRt) && maxRt > 0 ? maxRt : 0,
      goalMode: !!($('#kb-f-goal') && $('#kb-f-goal').checked),
      goalMaxTurns: Number.isInteger(goalTurns) && goalTurns > 0 ? goalTurns : 0,
      modelOverride: modelVal,
      providerOverride: modelVal ? (kbModelProviders[modelVal] || '') : '',
      reasoningEffort: $('#kb-f-effort')?.value || '',
      sessionId: KB.modalSessionId || undefined,
      idempotencyKey: key,
    };
  } else if (kind === 'bind') {
    const meta = kbCurrentBoardMeta();
    if (!meta.slug) { kbModalErr('当前看板未就绪，请稍后重试'); return Promise.resolve(); }
    if (!a.kanbanBindBoard) { kbModalErr('此页需要 Hermes 桌面端才能绑定项目'); return Promise.resolve(); }
    payload = { slug: meta.slug, projectId: $('#kb-b-project')?.value || '' };
  } else if (kind === 'project') {
    if (!a.kanbanCreateProject) { kbModalErr('此页需要 Hermes 桌面端才能创建项目'); return Promise.resolve(); }
    const pname = ($('#kb-p-name')?.value || '').trim();
    if (!pname) { kbModalErr('请填写项目名称'); return Promise.resolve(); }
    // 官方：项目按文件夹（cwd 前缀）认领会话，没有文件夹的项目既进不了分组也放不了会话
    if (!KB.projFolders.length) { kbModalErr('请至少添加一个文件夹'); return Promise.resolve(); }
    payload = {
      name: pname,
      folders: KB.projFolders.slice(),
      slug: ($('#kb-p-slug')?.value || '').trim(),
      description: ($('#kb-p-desc')?.value || '').trim(),
      idea: ($('#kb-p-idea')?.value || '').trim(),
      use: true, // 官方 createProject({ use: true })
    };
  } else if (kind === 'project-rename') {
    if (!a.projectAction) { kbModalErr('此页需要 Hermes 桌面端才能重命名项目'); return Promise.resolve(); }
    const pname = ($('#kb-p-name')?.value || '').trim();
    if (!pname) { kbModalErr('请填写项目名称'); return Promise.resolve(); }
    const id = (KB.projectDialog && KB.projectDialog.projectId) || '';
    if (!id) { kbModalErr('缺少目标项目'); return Promise.resolve(); }
    payload = { op: 'rename', id, name: pname };
  } else if (kind === 'project-add-folder') {
    kbModalErr('请点击「＋ 选择文件夹…」');
    return Promise.resolve();
  } else {
    payload = {
      slug: ($('#kb-b-slug')?.value || '').trim(),
      name: ($('#kb-b-name')?.value || '').trim(),
      description: ($('#kb-b-desc')?.value || '').trim(),
      icon: ($('#kb-b-icon')?.value || '').trim(),
      color: ($('#kb-b-color')?.value || '').trim(),
    };
  }
  const submit = $('#kb-modal-submit');
  KB.modalBusy = true;
  if (submit) submit.disabled = true;
  kbModalErr('');
  return (async () => {
    try {
      let r;
      if (kind === 'task') r = await a.kanbanCreateTask(payload);
      else if (kind === 'bind') r = await a.kanbanBindBoard(payload);
      else if (kind === 'project') r = await a.kanbanCreateProject(payload);
      else if (kind === 'project-rename') r = await a.projectAction(payload);
      else r = await a.kanbanCreateBoard(payload);
      if (KB.modal !== kind) return; // 期间已关弹窗，旧响应不写 DOM
      if (!r || !r.ok) { kbModalErr((r && r.error) || '操作失败'); return; }
      kbModalClose();
      toast(kind === 'bind'
        ? (payload.projectId ? '已绑定项目，生效见该板任务的默认工作区' : '已解除项目绑定')
        : (kind === 'task' ? '任务已创建' : (kind === 'project' ? '项目已创建' :
          (kind === 'project-rename' ? '项目已重命名' : '看板已创建'))), 1800);
      if (r.warning) toast('调度器提示：' + r.warning, 3600);
      if (kind !== 'task') { KB.overview = null; kbSelectSig = ''; }
      await kanbanLoad(true); // 写后回读 CLI 列表
      if (KB_PROJECT_KINDS.includes(kind)) await refreshSessions(currentSearch()); // 侧栏项目树即时收录
      if (kind === 'project') {
        if (r.ideaWarning) toast(r.ideaWarning, 3600);
        // 官方 createProject(use:true) + enterProject：建完设为活动项目，并在项目根开新会话。
        // 弹窗若是从聊天 / 设置页打开的，不要顺手关掉本来就没显示的看板页。
        const root = payload.folders[0];
        if (root) {
          if (!$('#kanban-page').hidden) closeKanbanPage();
          newTabInProject(root);
        }
      }
    } catch (e) {
      if (KB.modal === kind) kbModalErr((e && e.message) || '操作失败');
    } finally {
      KB.modalBusy = false;
      if (submit) submit.disabled = false;
      kbSyncProjectSubmit(); // 失败保留表单时按官方条件重新禁用/启用
    }
  })();
}

const kbModelProviders = {};
function kbSyncAdvSelects() {
  const cols = (KB.board && Array.isArray(KB.board.columns)) ? KB.board.columns : [];
  const tasks = cols.filter((c) => c.name !== 'archived').flatMap((c) => c.tasks || []);
  kbFillSelect('#kb-f-parents', tasks.map((t) => ({
    value: String(t.id),
    label: `${String(t.id).slice(0, 10)} · ${String(t.title || '').slice(0, 32)}`,
  })), '', '无前置任务');

  const fillSkills = (list) => {
    const skillItems = [...new Set((Array.isArray(list) ? list : [])
      .map((s) => String(s.name || s.id || '')).filter(Boolean))].sort()
      .map((n) => ({ value: n, label: n }));
    kbFillSelect('#kb-f-skills', skillItems, $('#kb-f-skills')?.value || '', '不限技能');
  };
  fillSkills(state.skills);
  if ((!Array.isArray(state.skills) || !state.skills.length) && api && api.skillsList) {
    api.skillsList().then((r) => {
      if (r && r.ok && Array.isArray(r.items)) { state.skills = r.items; fillSkills(r.items); }
    }).catch(() => {});
  }

  const rawModels = [
    ...(Array.isArray(state.modelState?.models) ? state.modelState.models : []),
    ...(Array.isArray(state.env?.models) ? state.env.models : []),
  ];
  for (const m of rawModels) {
    if (m && m.model && m.provider) kbModelProviders[String(m.model)] = String(m.provider);
  }
  const rows = typeof modelRows === 'function'
    ? modelRows(state.modelState, state.env && state.env.models, state.config && state.config.model)
    : [];
  const modelItems = rows.map((m) => {
    const key = String(m.key || '');
    const prov = kbModelProviders[key] || (m.tag && !['CLI 默认', '内置', '当前配置'].includes(m.tag) ? m.tag : '');
    if (key && prov) kbModelProviders[key] = prov;
    return {
      value: key,
      label: m.tag && m.tag !== '内置' ? `${m.name || key} (${m.tag})` : String(m.name || key),
    };
  }).filter((m) => m.value);
  kbFillSelect('#kb-f-model', modelItems, '', '跟随 profile 默认');
}

function kbToggleAdv(prefix, forceOpen) {
  const card = $(`#kb-${prefix}-adv`), btn = $(`#kb-${prefix}-adv-btn`);
  if (!card || !btn) return;
  const open = typeof forceOpen === 'boolean' ? forceOpen : card.hidden;
  card.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const label = prefix === 'f' ? '更多设置（看板 / 项目 / 租户 / 工作区 / 模型）' : '高级设置（图标 / 主题色）';
  btn.textContent = (open ? '▾ ' : '▸ ') + label;
}
