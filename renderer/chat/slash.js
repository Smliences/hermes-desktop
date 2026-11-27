'use strict';
/* ---------- 命令面板 ---------- */
const COMMANDS = [
  { cmd: '/new', desc: '新建会话', run: () => newTab() },
  { cmd: '/model', desc: '切换模型', run: () => openModelPicker() },
  { cmd: '/effort', desc: '推理力度 (none…ultra)', run: () => openEffortPicker() },
  { cmd: '/yolo', desc: '切换审批模式', run: () => $('#chip-yolo').click() },
  { cmd: '/rail', desc: '开关右侧预览 / 看板面板', run: () => toggleRail() },
  { cmd: '/sessions', desc: '搜索会话', run: () => { setSidebar(true); $('#session-search').focus(); } },
  { cmd: '/export', desc: '导出会话记录为 Markdown 文件', run: exportTranscript },
  { cmd: '/copy', desc: '复制会话记录到剪贴板', run: () => copyTranscript() },
  { cmd: '/help', desc: '快捷键与操作帮助', run: () => toggleHelp(true) },
  { cmd: '/gateway', desc: '查看 hermes serve 状态', run: showGateway },
  { cmd: '/kanban', desc: '打开 CLI 原生任务看板（新建 / 提交派发 / 手动 tick）', run: () => showKanban(true) },
  { cmd: '/orb', desc: '收成桌面小圆球（点球弹出迷你聊天窗）', run: () => api.enterOrb && api.enterOrb() },
];
let paletteSel = 0, paletteItems = COMMANDS;

/* ---------- CLI 命令目录（serve 的 commands.catalog） ----------
   桌面端原来只有上面这 12 条本地命令，CLI 的 COMMAND_REGISTRY 有 100+ 条，
   在输入框里敲 /status、/context、/usage、/insights 全都匹配不到，Enter 被拦下 ——
   命令一条都用不了。
   这些命令不需要在这里重写：serve 有审过的执行通道（slash.exec），桌面端只做
   「取目录 / 送命令 / 显示结果」。目录拿不到（serve 没起、权限不足）就静默退回本地表，
   输入体验不受影响。 */
const cliCatalog = { ok: false, at: 0, commands: [], categories: [], alias: {}, error: '' };
let cliCatalogInflight = null;
const CLIENT_CATALOG_TTL = 5 * 60 * 1000;

function loadCliCatalog(force = false) {
  // 只看桥有没有这个方法：Demo 桥也提供目录，浏览器里能演示合并后的菜单
  if (typeof api.cliCommandsCatalog !== 'function') return Promise.resolve(cliCatalog);
  if (cliCatalogInflight) return cliCatalogInflight;
  if (!force && cliCatalog.ok && Date.now() - cliCatalog.at < CLIENT_CATALOG_TTL) return Promise.resolve(cliCatalog);
  cliCatalogInflight = api.cliCommandsCatalog()
    .then((res) => {
      if (res && res.ok) {
        Object.assign(cliCatalog, {
          ok: true, at: res.at || Date.now(),
          commands: Array.isArray(res.commands) ? res.commands : [],
          categories: Array.isArray(res.categories) ? res.categories : [],
          alias: res.alias || {}, error: '',
        });
        // 目录回来时菜单若正开着（用户敲得太快，先看到的是「加载中」占位），就地重画一次，
        // 否则那一屏占位会一直挂着，直到用户再敲一个字符。
        if (typeof slashMenuOpen === 'function' && slashMenuOpen()) slashSync();
      } else {
        cliCatalog.error = (res && res.error) || '命令目录不可用';
      }
      return cliCatalog;
    })
    .catch((e) => { cliCatalog.error = String((e && e.message) || e); return cliCatalog; })
    .finally(() => { cliCatalogInflight = null; });
  return cliCatalogInflight;
}

/** 命令匹配打分：名字精确 > 名字前缀 > 名字包含 > 描述包含；-1 表示不匹配。 */
function commandScore(row, q) {
  if (!q) return 2;
  const name = row.cmd.slice(1).toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  return row.desc && row.desc.toLowerCase().includes(q) ? 3 : -1;
}

/**
 * 斜杠菜单的所有候选：本地动作在前，CLI 命令在后。
 * 同名已被主进程的 DESKTOP_OWN 过滤掉，这里不重复去重。
 */
const CMD_MENU_MAX = 40;
/** 别名表（`canon`）的用法：CLI 的目录**只列规范名**，别名只出现在 `canon` 里
    （`command_discovery._catalog_registry` 只 add `/{cmd.name}`）。
    所以 /compact 这种别名在菜单里永远匹配不到 —— 敲它只会看到「没有匹配的指令」，
    Enter 再把 /compact 当正文发给模型，看起来就是「命令不能用」。 */
function cliAliasIndex() {
  const out = new Map(); // 规范名（小写，带 /）→ [别名…]
  const map = (cliCatalog && cliCatalog.alias) || {};
  for (const [from, to] of Object.entries(map)) {
    if (typeof to !== 'string' || !to.startsWith('/')) continue;
    const key = to.toLowerCase();
    const list = out.get(key) || [];
    list.push(String(from).toLowerCase());
    out.set(key, list);
  }
  return out;
}
function commandRows(q) {
  const s = (q || '').trim().toLowerCase();
  const local = COMMANDS.map((c) => ({ cmd: c.cmd, desc: c.desc, source: 'local', argMode: null, sub: [], run: c.run }));
  const scored = [];
  for (const row of local) {
    const sc = commandScore(row, s);
    if (sc >= 0) scored.push({ row, sc, local: true });
  }
  const aliases = cliAliasIndex();
  for (const c of cliCatalog.commands) {
    const row = { cmd: c.cmd, desc: c.desc || '', source: 'cli', argMode: c.argMode || null, sub: c.sub || [], scope: c.scope || '' };
    let sc = commandScore(row, s);
    let aliasHit = '';
    // 别名也参与匹配：敲 /compact 要能出 /compress 这一行（排在同名规范名之后，别抢排序）
    for (const al of (aliases.get(String(c.cmd || '').toLowerCase()) || [])) {
      const as = commandScore({ cmd: al, desc: '' }, s);
      if (as >= 0 && (sc < 0 || as + 0.5 < sc)) { sc = as + 0.5; aliasHit = al; }
    }
    if (sc >= 0) scored.push({ row: aliasHit ? { ...row, aliasHit } : row, sc, local: false });
  }
  // 同分时本地优先；同组内保持目录原有顺序（sort 稳定）
  scored.sort((a, b) => a.sc - b.sc || (a.local === b.local ? 0 : a.local ? -1 : 1));
  // 描述匹配（3 分）只是兜底：只要有任何名字层面的命中（精确/前缀/包含/别名），
  // 描述里恰好撞词的命令就不该混进来 —— 否则敲 /compac 会把 desc 是
  // 「Toggle compact display mode」的 /density 也带出来，看起来像匹配错了对象。
  const best = scored.length ? Math.min(...scored.map((x) => x.sc)) : -1;
  const picked = scored.filter((x) => x.sc < 3 || best >= 3).map((x) => x.row);
  if (picked.length <= CMD_MENU_MAX) return picked;
  // 太多时不要砍掉本地动作：本地全留，剩下的名额给 CLI
  const locals = picked.filter((r) => r.source === 'local');
  const rest = picked.filter((r) => r.source !== 'local');
  return locals.concat(rest.slice(0, Math.max(0, CMD_MENU_MAX - locals.length)));
}

/** 一条完整的斜杠命令（可带参数）→ 目录行；只认**精确**名字，不做模糊匹配。
    顺序：本地动作 → CLI 规范名 → CLI 别名（/compact → /compress）。
    找不到返回 null（自由文本，按普通消息发）。 */
function resolveSlashCommand(text) {
  const s = String(text || '').trim();
  if (!/^\/[A-Za-z0-9]/.test(s)) return null;
  const at = s.search(/\s/);
  const name = (at < 0 ? s : s.slice(0, at)).toLowerCase();
  if (!/^\/[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name)) return null;
  const arg = at < 0 ? '' : s.slice(at + 1).trim();
  const local = COMMANDS.find((c) => c.cmd.toLowerCase() === name);
  if (local) return { row: { cmd: local.cmd, desc: local.desc, source: 'local', argMode: null, sub: [], run: local.run }, arg };
  const cli = cliCatalog.commands.find((c) => String(c.cmd || '').toLowerCase() === name);
  if (cli) {
    return { row: { cmd: cli.cmd, desc: cli.desc || '', source: 'cli', argMode: cli.argMode || null, sub: cli.sub || [], scope: cli.scope || '' }, arg };
  }
  const canon = ((cliCatalog.alias || {})[name] || '').toLowerCase();
  const viaAlias = canon && cliCatalog.commands.find((c) => String(c.cmd || '').toLowerCase() === canon);
  if (viaAlias) {
    return {
      row: { cmd: viaAlias.cmd, desc: viaAlias.desc || '', source: 'cli', argMode: viaAlias.argMode || null,
        sub: viaAlias.sub || [], scope: viaAlias.scope || '', aliasHit: name },
      arg,
    };
  }
  return null;
}

/**
 * 执行一条斜杠命令。
 * CLI 命令的三种返回（gateway/session_commands.py）：
 *   exec  → 文本结果，作为一条命令卡片留在对话里
 *   send / skill → 命令改写成一轮 prompt，回到正常提交流程
 * 失败也给出卡片：网关只放行审过的命令，被拒时它会给「改用哪条命令」的提示。
 */
async function runSlashCommand(row, argText, typedName) {
  const targetTab = arguments[3] || null;
  const tab = targetTab || activeTab();
  if (!tab) return;
  if (row.source === 'local') {
    if (targetTab && tab.id !== state.activeTabId) return;
    const fn = typeof row.run === 'function' ? row.run : (COMMANDS.find((c) => c.cmd === row.cmd) || {}).run;
    if (typeof fn === 'function') fn();
    return;
  }
  if (tab.running) {
    if (tab.id === state.activeTabId) toast('本回合还在进行，命令要等它结束', 2200);
    return;
  }
  if (!tab.sessionId) {
    if (tab.id === state.activeTabId) toast('这个会话还没有建立：先发一条消息，再用命令', 2600);
    return;
  }

  const arg = String(argText || '').trim();
  const full = arg ? `${row.cmd} ${arg}` : row.cmd;
  // 卡片上写用户真正敲的名字（/compact），送进 CLI 的仍是规范名（/compress）
  const shown = arg ? `${typedName || row.cmd} ${arg}` : (typedName || row.cmd);
  const isCompress = /^\/(compress|compact)$/i.test(row.cmd);
  const item = { kind: 'command', cmd: shown, state: 'running', text: '', ts: Date.now() };
  tab.items.push(item);
  if (tab.id === state.activeTabId) { renderChat(); scrollBottom(true); }
  else { renderTabs(); }

  let res = null;
  try { res = await api.cliCommandExec({ sessionId: tab.sessionId, command: full }); }
  catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  /* /compress 要的是「这个会话的活 agent」。刚打开的历史会话里 agent 是**异步**建起来的
     （session.resume → _schedule_agent_build），此刻命令会返回空输出 —— 看起来就是点了没反应。
     稍等一次再试，仍为空就给一句能照做的提示，而不是「（该命令没有输出）」。 */
  if (isCompress && res && res.ok && !res.type && !String(res.text || '').trim()) {
    await new Promise((r) => setTimeout(r, 900));
    try {
      const again = await api.cliCommandExec({ sessionId: tab.sessionId, command: full });
      if (again && again.ok && String(again.text || '').trim()) res = again;
    } catch { /* 保留第一次的空结果，下面给提示 */ }
  }

  // 命令被改写成一轮 prompt：撤掉占位卡，走正常提交（显示命令原文，提交改写后的内容）
  if (res && res.ok && (res.type === 'send' || res.type === 'skill') && res.text) {
    const idx = tab.items.indexOf(item);
    if (idx >= 0) tab.items.splice(idx, 1);
    if (tab.id === state.activeTabId) renderChat();
    if (!tab.running) send(res.text, res.display || full, tab);
    return;
  }

  const emptyText = isCompress
    ? 'CLI 还没把这个会话的 agent 建起来（刚打开的历史会话常见）。先发一条消息，或稍等几秒再敲一次。'
    : '（该命令没有输出）';
  item.state = res && res.ok ? 'done' : 'error';
  item.text = res && res.ok ? (res.text || emptyText) : (res && res.error) || '命令执行失败';
  if (tab.id === state.activeTabId) { renderChat(); scrollBottom(true); }
  else { renderTabs(); }
}

function togglePalette(show) {
  $('#palette').hidden = !show;
  if (show) {
    $('#palette-input').value = ''; $('#palette-input').placeholder = '输入命令…';
    paletteFilter(''); setTimeout(() => $('#palette-input').focus(), 30);
  }
}
function paletteFilter(q) {
  paletteItems = COMMANDS.filter((c) => !q || c.cmd.includes(q) || c.desc.includes(q));
  paletteSel = 0; renderPalette();
}
function renderPalette() {
  const ul = $('#palette-list'); ul.innerHTML = '';
  paletteItems.forEach((c, i) => {
    const li = document.createElement('li'); if (i === paletteSel) li.classList.add('sel');
    li.innerHTML = `<span class="p-cmd">${esc(c.cmd)}</span><span class="p-desc">${esc(c.desc)}</span>`;
    li.onclick = () => { togglePalette(false); c.run(); };
    ul.appendChild(li);
  });
}
$('#palette-input').addEventListener('input', (e) => paletteFilter(e.target.value.trim()));
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { paletteSel = Math.min(paletteItems.length - 1, paletteSel + 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { paletteSel = Math.max(0, paletteSel - 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'Enter') { const c = paletteItems[paletteSel]; togglePalette(false); c && c.run(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); togglePalette(false); }
});
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') togglePalette(false); });

const MODELS = ['deepseek-v4.1-flash', 'claude-sonnet-4', 'claude-opus-4', 'gpt-5.2', 'kimi-k2.5'];

/** WB 式 chip 下拉菜单：锚定 anchor 向上弹出，rows=[{key,name,tag}], 选中项打 ✓ */
let chipMenuCleanup = null;
/** 二级菜单挂在 body 上、用 fixed 定位：`#chip-menu` 是 overflow:hidden，
 *  子菜单嵌进去会被裁掉一条。全局同时只存在一个，关闭时清空内容。 */
function ensureChipSubmenu() { return $('#chip-submenu'); }
function chipSubClose() {
  const sub = $('#chip-submenu');
  if (sub) { sub.hidden = true; sub.innerHTML = ''; }
  document.querySelectorAll('#chip-menu .wb-menu-row[aria-expanded="true"]')
    .forEach((r) => r.setAttribute('aria-expanded', 'false'));
}
/**
 * chip 下拉菜单。rows 里带 sub 数组的行是「有二级」的入口（例如模型 → 思考程度）：
 * 悬停 / 点击 / → 展开，← 或 Esc 收起；选中二级项时 onPick(child, parentRow)。
 * 返回 { close, openSub }，调用方可以让某个二级菜单默认展开（/effort 直接落到力度上）。
 */
function openChipMenu(anchor, rows, selectedKey, onPick) {
  // 清理上一次未释放的监听（防残留 onDoc 吞点击）
  if (chipMenuCleanup) chipMenuCleanup();
  const menu = $('#chip-menu');
  menu.dataset.slash = ''; // 清掉上一轮内联指令菜单的标记（slashSync 打开时会重新打上）
  chipSubClose();
  const rowHtml = (r) => {
    if (Array.isArray(r.sub)) {
      return `<div class="wb-menu-row has-sub" data-key="${esc(r.key)}" tabindex="0" role="menuitem"
        aria-haspopup="menu" aria-expanded="false">
        <span class="wb-menu-name">${esc(r.name)}</span>
        ${r.subValue ? `<span class="wb-menu-tag">${esc(r.subValue)}</span>` : ''}
        <span class="wb-menu-caret" aria-hidden="true">›</span>
      </div>`;
    }
    const sel = String(r.key) === String(selectedKey);
    return `<div class="wb-menu-row${sel ? ' selected' : ''}" data-key="${esc(r.key)}" tabindex="0" role="menuitem">
      <span class="wb-menu-name">${esc(r.name)}</span>
      ${r.badge ? `<span class="wb-menu-badge">${esc(r.badge)}</span>` : ''}
      ${r.tag ? `<span class="wb-menu-tag">${esc(r.tag)}</span>` : ''}
      <span class="wb-menu-check">${sel ? '✓' : ''}</span>
    </div>`;
  };
  menu.innerHTML = `<div class="wb-menu-list">${rows.map(rowHtml).join('')}</div>`;
  menu.hidden = false;
  // 定位：chip 上方弹出，左右不超出视口
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = Math.min(Math.max(8, rect.left), vw - mw - 8);
  let top = rect.top - mh - 8;
  if (top < 8) top = Math.min(rect.bottom + 8, vh - mh - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  const subOpen = (rowEl) => {
    const src = rows.find((x) => String(x.key) === String(rowEl.dataset.key));
    if (!src || !Array.isArray(src.sub)) return;
    const sub = ensureChipSubmenu();
    sub.innerHTML = `<div class="wb-menu-list">${src.sub.map((c) => `
      <div class="wb-menu-row${String(c.key) === String(src.subValue) ? ' selected' : ''}"
        data-key="${esc(c.key)}" tabindex="0" role="menuitem">
        <span class="wb-menu-name">${esc(c.name)}</span>
        ${c.tag ? `<span class="wb-menu-tag">${esc(c.tag)}</span>` : ''}
        <span class="wb-menu-check">${String(c.key) === String(src.subValue) ? '✓' : ''}</span>
      </div>`).join('')}</div>`;
    sub.hidden = false;
    // 默认贴右；右侧放不下就翻到左侧，再夹进视口
    const r = rowEl.getBoundingClientRect();
    const sw = sub.offsetWidth, sh = sub.offsetHeight;
    let sl = r.right + 4;
    if (sl + sw > vw - 8) sl = Math.max(8, r.left - sw - 4);
    const st = Math.min(Math.max(8, r.top - 5), Math.max(8, vh - sh - 8));
    sub.style.left = sl + 'px';
    sub.style.top = st + 'px';
    rowEl.setAttribute('aria-expanded', 'true');
    sub.querySelectorAll('.wb-menu-row').forEach((el) => {
      el.onclick = () => {
        const picked = src.sub.find((x) => String(x.key) === String(el.dataset.key));
        close();
        if (picked) onPick(picked, src);
      };
    });
  };

  const close = () => {
    chipSubClose();
    menu.hidden = true;
    chipMenuCleanup = null;
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  chipMenuCleanup = close;
  const onDoc = (e) => {
    const sub = $('#chip-submenu');
    if (menu.contains(e.target) || (sub && sub.contains(e.target))) return;
    if (e.target === anchor || anchor.contains(e.target)) return;
    close();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    // Esc 先收二级，再收一级：跟目录树的习惯一致
    const sub = $('#chip-submenu');
    if (sub && !sub.hidden) { chipSubClose(); return; }
    close();
  };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);

  menu.querySelectorAll('.wb-menu-row').forEach((row) => {
    const src = rows.find((x) => String(x.key) === String(row.dataset.key));
    if (src && Array.isArray(src.sub)) {
      row.onmouseenter = () => subOpen(row);
      row.onclick = () => { if (row.getAttribute('aria-expanded') === 'true') chipSubClose(); else subOpen(row); };
      row.onkeydown = (e) => {
        if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); subOpen(row); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); chipSubClose(); }
      };
      return;
    }
    // 移回普通行就收起二级，避免「菜单还停在别的行上」
    row.onmouseenter = chipSubClose;
    row.onclick = () => { close(); if (src) onPick(src); };
    // role=menuitem 的键盘可达性：Enter / Space 触发（与 has-sub 行的 Enter 同语义）
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    };
  });

  return {
    close,
    openSub: (key) => {
      const row = menu.querySelector(`.wb-menu-row[data-key="${key}"]`);
      if (row) subOpen(row);
    },
  };
}

/* ---------- 内联指令菜单（输入框以 / 开头时浮现） ----------
   placeholder 承诺「/ 调用指令」，但此前只有 ⌘K 面板一条路 —— 在输入框里敲
   /new 会被当字面文本发给 CLI。现在复用 #chip-menu 浮层 + COMMANDS 表：
   输入 / 起手即弹候选（按指令名/描述过滤），↑↓/Home/End 选行、Enter 执行、
   Esc 关闭；无匹配时显示占位行而不是关菜单，避免 /xyz 被误发出去。 */
function slashRows(q) { return commandRows(q); }
function slashMenuOpen() {
  const m = $('#chip-menu');
  return !m.hidden && !!chipMenuCleanup && m.dataset.slash === '1';
}
function slashSync() {
  const inp = $('#input');
  const v = inp.value || '';
  const tab = activeTab();
  if (!v.startsWith('/') || (tab && tab.running) || state.view !== 'chat') { slashClose(); return; }
  // 目录按需拉取：敲第一个 / 才建连取目录，空闲启动不为此唤醒 serve
  if (!cliCatalog.ok) loadCliCatalog();
  const q = v.slice(1);
  const rows = slashRows(q);
  const menu = $('#chip-menu');
  openChipMenu($('#composer'), rows.map((c) => ({
    // 敲的是别名时把别名标出来（/compact），让人知道这一行就是它
    key: c.cmd, name: c.cmd,
    // CLI 有些 desc 会把整段 usage 塞进括号（/compress 的有 100+ 字符），
    // 菜单里只留说明本身，超宽交给 CSS 省略号兜底
    tag: String(c.desc || '').replace(/\s*\(usage:[\s\S]*$/, ''),
    badge: c.aliasHit ? c.aliasHit : (c.source === 'cli' ? 'CLI' : ''),
  })), null, (picked) => {
    const row = rows.find((c) => c.cmd === picked.key);
    if (!row) return;
    const spaceAt = q.search(/\s/);
    // 已有参数（`/title 新名字`）或命令本身要吃参数：交回给调用方，别把整串当命令名
    const argText = spaceAt >= 0 ? q.slice(spaceAt + 1) : '';
    const typedName = '/' + (spaceAt >= 0 ? q.slice(0, spaceAt) : q).trim();
    // 命令名已经完整敲出来了（`/save` 而不是 `/sa`）＝ 用户就是要跑它：
    // 裸命令直接送给 CLI，它会回 usage；比「补个空格就没动静」清楚得多。
    // 只有还在输入命令名的中途（`/sa`）才补全并把焦点留在参数位。
    // 别名敲全（`/compact`）同样算敲全：它就是这个命令的另一个名字。
    const qn = q.trim().toLowerCase();
    const typedFull = qn === row.cmd.replace(/^\//, '').toLowerCase()
      || (!!row.aliasHit && qn === row.aliasHit.replace(/^\//, '').toLowerCase());
    const needsArg = row.source === 'cli' && row.argMode && !argText && !typedFull;
    if (needsArg) {
      // 只补全命令名，把光标留在名字后面让用户接着敲参数
      inp.value = row.cmd + ' ';
      autoGrow(); updateCount();
      inp.focus();
      try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
      slashClose();
      return;
    }
    inp.value = ''; autoGrow(); updateCount();
    // 只敲了半截就从菜单里点：卡片上写真正执行的那条命令，不是半截输入
    runSlashCommand(row, argText, typedFull ? typedName : row.cmd);
  });
  menu.dataset.slash = '1'; // 必须在 openChipMenu 之后打标记（其入口会先清空）
  if (!rows.length) {
    // 目录还没回来时别用「没有匹配」误导：CLI 那 100+ 条只是还在路上
    const msg = cliCatalog.ok ? '没有匹配的指令 · 清空后重试或按 Esc 关闭' : 'CLI 命令加载中…（本地指令可直接用）';
    menu.innerHTML = `<div class="wb-menu-list"><div class="wb-menu-row wb-menu-empty" role="status">${msg}</div></div>`;
  }
}
function slashClose() {
  const m = $('#chip-menu');
  if (m.dataset.slash === '1' && typeof chipMenuCleanup === 'function') chipMenuCleanup();
  if (m.dataset.slash === '1') { delete m.dataset.slash; m.hidden = true; }
}
/** 输入框内 ↑↓/Home/End/Enter 对指令菜单的接管：焦点没离开输入框时 Enter 执行高亮行。 */
function slashNav(e) {
  if (!slashMenuOpen()) return false;
  const rows = [...document.querySelectorAll('#chip-menu .wb-menu-row:not(.wb-menu-empty)')];
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && rows.length) {
    e.preventDefault();
    const idx = rows.indexOf(document.activeElement);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
    else next = idx < 0 ? rows.length - 1 : Math.max(0, idx - 1);
    rows[next].focus();
    return true;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    // 没有候选时别把 Enter 拦死：alias / 目录里没列的命令交给 send() 的兜底 ——
    // 它会精确解析（含别名）或让 CLI 自己回答「Unknown command」。
    // 只有目录还没回来时才拦下，避免把 /compact 当正文发出去。
    if (!rows.length && cliCatalog.ok) return false;
    e.preventDefault();
    if (rows.length) {
      const ae = document.activeElement;
      (rows.indexOf(ae) >= 0 ? ae : rows[0]).click();
    }
    return true;
  }
  return false;
}
