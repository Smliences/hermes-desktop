'use strict';
/* ---------- 全局快捷键（可自定义） ----------
   组合格式固定为 mod+[alt+][shift+]key，mod 统一代表 ⌘ / Ctrl。
   约束：必须带 mod（或 '?' 这种仅在非输入态生效的固定别名），避免劫持普通打字；
   Escape 是浮层关闭 / 中断生成的系统键，不开放自定义。
   存储经 cleanShortcuts() 白名单 + 冲突去重，被篡改的 localStorage 不会注入任意动作。 */
/* ---------- 会话内查找（⌘F） ----------
   命中高亮用 CSS Custom Highlight API：只创建 Range，不插 <mark>，因此
   流式输出的增量重建、代码块横向滚动、悬停操作条都不会被打断。
   浏览器不支持时降级为「只有计数、没有高亮」，功能不消失。 */
const FIND_MAX = 800;
const FIND_STATE = { open: false, query: '', ranges: [], index: -1, scrollTop: 0 };
const FIND_HL_SUPPORTED = (() => {
  try { return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'; }
  catch { return false; }
})();
function findReset() {
  if (FIND_HL_SUPPORTED) {
    try { CSS.highlights.delete('hermes-find'); CSS.highlights.delete('hermes-find-active'); } catch {}
  }
  FIND_STATE.ranges = [];
  FIND_STATE.index = -1;
}
/** 收集 #chat 里的纯文本命中。跳过脚本、样式与读屏专用节点。 */
function findCollect(query) {
  findReset();
  const root = $('#chat');
  const needle = String(query || '').toLowerCase();
  if (!root || !needle) { findPaintCount(); return; }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const v = n.nodeValue;
      if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (p && p.closest('script, style, .sr-only, .hidden, [hidden]')) return NodeFilter.FILTER_REJECT;
      const det = p && p.closest('details:not([open])');
      if (det && !p.closest('summary')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  outer:
  while ((node = walker.nextNode())) {
    const hay = node.nodeValue.toLowerCase();
    let from = 0;
    for (;;) {
      if (FIND_STATE.ranges.length >= FIND_MAX) break outer;
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + needle.length);
      FIND_STATE.ranges.push(r);
      from = at + needle.length;
    }
  }
  if (FIND_STATE.ranges.length) FIND_STATE.index = 0;
  findPaint();
}
function findPaintCount() {
  const el = $('#find-count');
  if (!el) return;
  const n = FIND_STATE.ranges.length;
  if (!FIND_STATE.query) { el.textContent = '0/0'; el.classList.remove('empty'); return; }
  el.textContent = n ? `${FIND_STATE.index + 1}/${n}` : '0/0';
  el.classList.toggle('empty', !n);
  const prev = $('#find-prev'), next = $('#find-next');
  if (prev) prev.disabled = !n;
  if (next) next.disabled = !n;
}
function findPaint() {
  if (FIND_HL_SUPPORTED) {
    try {
      const active = FIND_STATE.index >= 0 ? FIND_STATE.ranges[FIND_STATE.index] : null;
      const rest = FIND_STATE.ranges.filter((r) => r !== active);
      if (rest.length) CSS.highlights.set('hermes-find', new Highlight(...rest));
      else CSS.highlights.delete('hermes-find');
      if (active) CSS.highlights.set('hermes-find-active', new Highlight(active));
      else CSS.highlights.delete('hermes-find-active');
    } catch {}
  }
  findPaintCount();
}
/** 把当前命中滚到可视区中部；只动 #chat-scroll 的 scrollTop，不 scrollIntoView
 *  （后者会连带滚动外层容器，把侧栏也带偏）。 */
function findReveal() {
  const r = FIND_STATE.ranges[FIND_STATE.index];
  const scroller = $('#chat-scroll');
  if (!r || !scroller) return;
  const rect = r.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  const pad = 48;
  if (rect.top < box.top + pad || rect.bottom > box.bottom - pad) {
    scroller.scrollTop += rect.top - box.top - (box.height / 2);
  }
}
function findStep(dir) {
  const n = FIND_STATE.ranges.length;
  if (!n) return;
  FIND_STATE.index = (FIND_STATE.index + dir + n) % n;
  findPaint();
  findReveal();
}
function findOpen(initial) {
  const bar = $('#find-bar'), input = $('#find-input');
  if (!bar || !input) return;
  if (!FIND_STATE.open) {
    FIND_STATE.open = true;
    const sc = $('#chat-scroll');
    FIND_STATE.scrollTop = sc ? sc.scrollTop : 0;
    bar.hidden = false;
  }
  if (typeof initial === 'string' && initial) input.value = initial;
  input.focus();
  input.select();
  FIND_STATE.query = input.value.trim();
  findCollect(FIND_STATE.query);
}
function findClose() {
  const bar = $('#find-bar');
  if (!bar || !FIND_STATE.open) return;
  FIND_STATE.open = false;
  bar.hidden = true;
  findReset();
  FIND_STATE.query = '';
  const input = $('#find-input');
  if (input) input.value = '';
  const btn = $('#btn-find');
  if (btn && document.activeElement === btn) btn.blur();
}
/** 会话已打开（有消息）时 ⌘F 走会话内查找，空态才回落到侧栏搜索。 */
function hasOpenTranscript() {
  const chat = $('#chat');
  const main = $('#main');
  return !!(chat && chat.children.length && main && !main.classList.contains('empty'));
}
(function wireFindBar() {
  const input = $('#find-input');
  if (!input) return;
  const btn = $('#btn-find');
  if (btn) btn.onclick = () => findOpen();
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      FIND_STATE.query = input.value.trim();
      findCollect(FIND_STATE.query);
      findReveal();
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      // 必须 stopPropagation：否则全局 Escape 会继续往下走，把正在生成的回合也中断掉
      e.preventDefault(); e.stopPropagation();
      findClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); findStep(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); findStep(-1);
    }
  });
  const prev = $('#find-prev'), next = $('#find-next'), close = $('#find-close');
  if (prev) prev.onclick = () => findStep(-1);
  if (next) next.onclick = () => findStep(1);
  if (close) close.onclick = () => findClose();
  // 流式输出会持续重建 #chat：防抖后重算命中，保持计数与高亮同步
  const chat = $('#chat');
  if (chat && typeof MutationObserver === 'function') {
    let mo = null;
    new MutationObserver(() => {
      if (!FIND_STATE.open || !FIND_STATE.query) return;
      if (mo) return;
      mo = setTimeout(() => {
        mo = null;
        const keep = FIND_STATE.index;
        findCollect(FIND_STATE.query);
        if (FIND_STATE.ranges.length && keep >= 0) {
          FIND_STATE.index = Math.min(keep, FIND_STATE.ranges.length - 1);
          findPaint();
        }
      }, 220);
    }).observe(chat, { childList: true, subtree: true, characterData: true });
  }
})();

const SHORTCUT_DEFS = [
  { id: 'palette', label: '命令面板', group: '会话', def: 'mod+k' },
  { id: 'sidebar', label: '显示或隐藏侧边栏', group: '会话', def: 'mod+b' },
  { id: 'newTab', label: '新建会话页签', group: '会话', def: 'mod+t' },
  { id: 'viewChat', label: '切换到「对话」视图', group: '会话', def: 'mod+1' },
  { id: 'viewTrace', label: '切换到「轨迹」视图', group: '会话', def: 'mod+2' },
  { id: 'focusSearch', label: '会话内查找 / 会话搜索', group: '会话', def: 'mod+f' },
  { id: 'send', label: '发送（任意焦点）', group: '输入', def: 'mod+enter' },
  { id: 'copyLast', label: '复制上一条回复', group: '消息', def: 'mod+shift+c' },
  { id: 'help', label: '打开快捷键帮助', group: '其他', def: 'mod+/' },
  // id 沿用 terminal：用户 localStorage 里已存的 mod+` 绑定不能因为改名失效
  { id: 'terminal', label: '切换右侧面板', group: '其他', def: 'mod+`' },
];
const SHORTCUT_STORE_KEY = 'hermes.shortcuts';
const FIXED_COMBOS = Object.freeze({ escape: 'Escape', helpAlias: '?' });
const COMBO_RE = /^(?:mod\+)(?:alt\+)?(?:shift\+)?(?:[a-z0-9`\/,.;'[\]\\=-]|enter|space)$/;
const isMac = /mac/i.test((navigator.platform || '') + (navigator.userAgent || ''));

function validCombo(v) {
  return typeof v === 'string' && (COMBO_RE.test(v) || v === '?');
}
function cleanShortcuts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const used = new Set(Object.values(FIXED_COMBOS).map((s) => s.toLowerCase()));
  for (const d of SHORTCUT_DEFS) {
    const v = raw[d.id];
    if (!validCombo(v) || used.has(v.toLowerCase())) continue; // 冲突项直接丢弃，回落到默认值
    used.add(v.toLowerCase());
    out[d.id] = v;
  }
  return out;
}
function shortcutsRead() {
  let raw = null;
  try { raw = JSON.parse(safeGet(SHORTCUT_STORE_KEY) || '{}'); } catch {}
  return cleanShortcuts(raw);
}
let _shortcutCache = null;
function shortcutMap() {
  if (!_shortcutCache) {
    const saved = shortcutsRead();
    _shortcutCache = Object.fromEntries(SHORTCUT_DEFS.map((d) => [d.id, saved[d.id] || d.def]));
  }
  return _shortcutCache;
}
function shortcutsSave(patch) {
  const next = cleanShortcuts({ ...shortcutsRead(), ...(patch || {}) });
  const ok = safeSet(SHORTCUT_STORE_KEY, JSON.stringify(next));
  _shortcutCache = null; // 失效缓存，下一次按键立即用新映射
  return ok;
}
function comboFromEvent(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let k = (e.key || '').toLowerCase();
  if (k === ' ') k = 'space';
  if (['control', 'meta', 'alt', 'shift', 'dead'].includes(k)) return '';
  // '?' 是 shift+/ 的产物，作为固定别名直接归一化，避免记成 shift+?
  if (k === '?') return '?';
  parts.push(k);
  return parts.join('+');
}
function comboLabel(combo) {
  return String(combo || '').split('+').map((p) => ({
    mod: isMac ? '⌘' : 'Ctrl', alt: isMac ? '⌥' : 'Alt', shift: isMac ? '⇧' : 'Shift',
    enter: 'Enter', space: 'Space',
  }[p] || (/^[a-z]$/.test(p) ? p.toUpperCase() : p))).join(isMac ? ' ' : '+');
}
const SHORTCUT_ACTIONS = {
  palette: () => togglePalette($('#palette').hidden),
  sidebar: () => toggleSidebar(),
  newTab: () => newTab(),
  viewChat: () => setView('chat'),
  viewTrace: () => setView('trace'),
  focusSearch: () => {
    if (hasOpenTranscript()) { findOpen(); return; }
    setSidebar(true);
    const el = $('#session-search');
    if (el) el.focus();
  },
  send: () => send($('#input').value),
  copyLast: () => copyLastReply(),
  help: () => toggleHelp(),
  terminal: () => toggleRail(),
};

/** 录制态：点击设置页某个键位按钮后，下一次按键被这里优先捕获。 */
let shortcutCapture = null; // { id, onDone }
function beginShortcutCapture(id, onDone) {
  shortcutCapture = { id, onDone };
}
function endShortcutCapture() {
  const c = shortcutCapture; shortcutCapture = null; return c;
}

window.addEventListener('keydown', (e) => {
  // 录制优先于一切动作；Escape 取消，纯修饰键忽略
  if (shortcutCapture) {
    if (e.key === 'Escape') { e.preventDefault(); const c = endShortcutCapture(); if (c) c.onDone(null, '已取消'); return; }
    const combo = comboFromEvent(e);
    if (!combo) return;
    e.preventDefault(); e.stopPropagation();
    const c = endShortcutCapture();
    if (!c) return;
    if (!validCombo(combo) || combo === 'escape') { c.onDone(null, '该按键不能作为全局快捷键'); return; }
    const map = { ...shortcutMap() };
    const clash = SHORTCUT_DEFS.find((d) => d.id !== c.id && map[d.id].toLowerCase() === combo.toLowerCase());
    if (clash) { c.onDone(null, `与「${clash.label}」冲突`); return; }
    if (Object.values(FIXED_COMBOS).some((x) => x.toLowerCase() === combo.toLowerCase())) {
      c.onDone(null, '该按键已保留给系统'); return;
    }
    c.onDone(combo, '');
    return;
  }
  const combo = comboFromEvent(e);
  if (!combo) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')
    || !!(e.target && e.target.isContentEditable);
  const map = shortcutMap();
  const hit = SHORTCUT_DEFS.find((d) => map[d.id].toLowerCase() === combo.toLowerCase());
  if (hit && SHORTCUT_ACTIONS[hit.id]) {
    // '?' 只在非输入态生效，其余都带 mod，不会劫持打字
    if (combo !== '?' || !typing) { e.preventDefault(); SHORTCUT_ACTIONS[hit.id](); }
    return;
  }
  if (combo === '?' && !typing) { e.preventDefault(); toggleHelp(true); return; }
  if (e.key === 'Escape') {
    // 严格单层命中即 return 栈：最上层优先，每次 Esc 只关最顶层一个
    if (KbDrag.on || KbDrag.armed) { kbDragReset(); return; }
    if (closeAllOverlays()) return;
    const kbMoreMenu = $('#kb-more-menu');
    if (kbMoreMenu && !kbMoreMenu.hidden) { kbMoreToggle(false); return; }
    const kbModalEl = $('#kb-modal');
    if (kbModalEl && !kbModalEl.hidden) { kbModalClose(); return; }
    // 统一按「最上层优先」收起：全部浮层关完后，若仍在生成则中断本回合
    if (FIND_STATE.open) { findClose(); return; }
    if (!$('#help-modal').hidden) { toggleHelp(false); return; }
    if (!$('#palette').hidden) { togglePalette(false); return; }
    if (!$('#settings-page').hidden) { toggleSettings(false); return; }
    const mkPage = $('#market-page');
    if (mkPage && !mkPage.hidden) {
      if (typeof closeMarket === 'function') closeMarket();
      else mkPage.hidden = true;
      return;
    }
    for (const pg of document.querySelectorAll('.subpage')) {
      if (pg.hidden) continue;
      if (pg.id === 'gateway-page') closeGatewayPage();
      else if (pg.id === 'kanban-page') {
        // 最上层优先：新建弹窗 → 抽屉内确认卡 → 抽屉更多菜单 → 详情抽屉 → 派发确认卡 → 派发面板 → 整页
        const drawerCard = document.querySelector('#kb-drawer-body .op-confirm');
        const dpCard = document.querySelector('#kb-dp-confirm .op-confirm');
        const dockCard = document.querySelector('#kb-dock-confirm .op-confirm');
        const kbdMenu = $('#kbd-menu');
        if (!$('#kb-modal').hidden) kbModalClose();
        else if (drawerCard) drawerCard.remove();
        else if (kbdMenu && !kbdMenu.hidden) kbdMoreToggle(false);
        else if (!$('#kb-drawer').hidden) closeKanbanDrawer();
        else if (dockCard) dockCard.remove();
        else if (dpCard) dpCard.remove();
        else if (!$('#kb-dispatch-panel').hidden) kbDispatchToggle(false);
        else closeKanbanPage();
      } else toggleSubpage(pg, false);
      return;
    }
    if (activeTab() && activeTab().running) {
      e.preventDefault();
      $('#btn-stop').click(); // Escape 中断生成（Claude Code 行为）
    }
  }
});


/* ═══════════ 生产级增强层：状态同步 / 帮助 / 草稿 / 消息操作 / 审批 ═══════════ */

/** Escape 统一收起所有轻浮层；返回是否确实关掉了东西（决定要不要中断生成）。 */
function closeAllOverlays() {
  let closed = false;
  ['#pf-menu', '#session-menu', '#storage-pop', '#chip-menu', '#chip-submenu'].forEach((sel) => {
    const el = $(sel);
    if (el && !el.hidden) { el.hidden = true; closed = true; }
  });
  document.querySelectorAll('.subpage .pp-menu').forEach((m) => {
    if (!m.hidden) { m.hidden = true; closed = true; }
  });
  const menus = document.querySelectorAll('.set-menu');
  menus.forEach((m) => m.remove());
  if (menus.length) closed = true;
  return closed;
}
/** 轻浮层菜单的 ↑↓/Home/End 焦点导航（Esc 关闭与 Enter 激活各处已有，这里只补移动）。
 *  覆盖所有「打开即挂 tabindex/menuitem」的浮层：chip 一二级、看板 ⋯、会话/项目 ⋯、
 *  profile、插件/技能页「＋添加」菜单。菜单没开就立刻返回，零开销。 */
const MENU_NAV_ROOTS = ['#chip-menu', '#chip-submenu', '#kb-more-menu', '#kbd-menu', '#session-menu', '#pf-menu'];
function openMenuRoot() {
  // 焦点已经在哪个菜单里，就留在哪个菜单（一级/二级互不打架）；否则取第一个打开的
  const ae = document.activeElement;
  if (ae) {
    const host = MENU_NAV_ROOTS.map((s) => $(s)).find((el) => el && !el.hidden && el.contains(ae));
    if (host) return host;
  }
  const fixed = MENU_NAV_ROOTS.map((s) => $(s)).find((el) => el && !el.hidden);
  if (fixed) return fixed;
  return Array.from(document.querySelectorAll('.subpage .pp-menu')).find((m) => !m.hidden) || null;
}
function menuItems(root) {
  return Array.from(root.querySelectorAll('[role="menuitem"], button, input'))
    .filter((el) => !el.closest('[hidden]') && !el.disabled);
}
function menuArrowNav(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const root = openMenuRoot();
  if (!root) return;
  // 焦点在输入框里（菜单外的搜索框等）不抢箭头键；菜单内的 checkbox/input 不受限
  const ae = document.activeElement;
  const inRoot = ae && root.contains(ae);
  if (!inRoot && ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox') return;
  const items = menuItems(root);
  if (!items.length) return;
  const idx = inRoot ? items.indexOf(ae) : -1;
  let next;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  else if (e.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
  else next = idx < 0 ? items.length - 1 : Math.max(0, idx - 1);
  e.preventDefault();
  e.stopPropagation();
  if (items[next] && items[next] !== ae) items[next].focus();
}
document.addEventListener('keydown', menuArrowNav, true);
/** 消息操作条里的绝对时间（HH:MM:SS）。 */
function fmtTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** 输入框字符计数。 */
function updateCount() {
  const el = $('#input-count'); if (!el) return;
  const n = ($('#input').value || '').length;
  el.textContent = n ? `${n} 字符` : '';
}
/** 发送/停止按钮与输入框状态的唯一真源，避免各处手动切 hidden 打架。
 *  不改按钮几何：生成中只显示停止按钮、给发送按钮加状态类，输入框文案变为提示。 */
function syncComposerState() {
  const tab = activeTab();
  const running = !!(tab && tab.running);
  const stop = $('#btn-stop'), sendBtn = $('#btn-send'), inp = $('#input');
  if (stop) stop.hidden = !running;
  if (sendBtn) sendBtn.classList.toggle('is-busy', running);
  if (inp) {
    inp.setAttribute('aria-busy', String(running));
    inp.placeholder = running ? '正在生成…可按 Esc 或 ■ 停止' : '发消息或创建任务，/ 调用指令，拖入文件可附加';
  }
  updateCount();
}

/** 草稿：按 sessionId（无则 tabId）隔离，切页签/重启后不丢未发送的输入。 */
const DRAFT_KEY = 'hermes.drafts';
function draftMap() {
  try {
    const v = JSON.parse(safeGet(DRAFT_KEY) || '{}');
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
function draftKeyOf(tab) { return (tab && (tab.sessionId || tab.id)) || ''; }
function saveDraftFor(tab) {
  const k = draftKeyOf(tab); if (!k) return;
  const m = draftMap();
  const v = ($('#input') && $('#input').value) || '';
  if (v.trim()) m[k] = v.slice(0, 20000); else delete m[k];
  const keys = Object.keys(m); // 只留最近 40 份，避免 localStorage 无限增长
  if (keys.length > 40) for (const old of keys.slice(0, keys.length - 40)) delete m[old];
  safeSet(DRAFT_KEY, JSON.stringify(m));
}
function restoreDraftFor(tab) {
  const inp = $('#input'); if (!inp) return;
  const k = draftKeyOf(tab);
  inp.value = k ? (draftMap()[k] || '') : '';
  autoGrow(); updateCount();
}
function clearDraftFor(tab) {
  const k = draftKeyOf(tab); if (!k) return;
  const m = draftMap(); if (!(k in m)) return;
  delete m[k]; safeSet(DRAFT_KEY, JSON.stringify(m));
}

/** 标记本页签所有在途回合失效：停止后延迟到达的 delta 不再串进正文。 */
function invalidateTurn(tab) {
  if (!tab) return;
  for (const [tid, id] of state.turnTab) if (id === tab.id) state.invalidTurns.add(tid);
  if (tab.lastResult && tab.lastResult.turnId) state.invalidTurns.add(tab.lastResult.turnId);
  if (state.invalidTurns.size > 200) state.invalidTurns.clear();
}

/** 回合收尾：按设置自动折叠已完成的工具详情与长思考块。
    失败的留着展开 —— 用户要能直接看到错因，收起来等于把报错藏了。 */
function applyAutoCollapse(tab) {
  if (!tab || SettingsStore.get('autoCollapse', true) === false) return;
  for (const i of tab.items) {
    if (i.kind === 'tool' && i.state === 'done' && !i.isError && !i.userToggled) i.open = false;
    if (i.kind === 'thinking' && (i.text || '').length > 300) i.open = false;
  }
}

function copyText(text) {
  const t = String(text || '');
  if (!t) return Promise.reject(new Error('empty'));
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
  return Promise.reject(new Error('clipboard unavailable'));
}
function copyLastReply() {
  const tab = activeTab();
  const last = tab && [...tab.items].reverse().find((i) => i.kind === 'assistant' && i.text);
  if (!last) { toast('没有可复制的回复'); return; }
  copyText(last.text).then(() => toast('已复制上一条回复', 1400)).catch(() => toast('复制失败（剪贴板不可用）'));
}
/** 从某条用户提问重试：截断该提问及其之后的所有消息，用原文重新发起一轮。 */
function retryFrom(item) {
  const tab = activeTab();
  if (!tab || tab.running) { toast('请等待当前回合结束再重试'); return; }
  const idx = tab.items.indexOf(item);
  if (idx < 0 || !item || item.kind !== 'user') return;
  tab.items = tab.items.slice(0, idx);
  tab.lastResult = null;
  send(item.text);
  a11y('已用原提问重新发起一轮');
}
/** 失败卡的「用当前模型重试」：往前找该轮失败对应的用户提问。
 *  若当前模型恰好就是上游判定不可用的那个，先打开模型选择器，避免又撞一次 400。 */
function retryFailedTurn(item) {
  const tab = activeTab();
  if (!tab || !item) return;
  const idx = tab.items.indexOf(item);
  if (idx < 0) { toast('找不到这条失败记录'); return; }
  let target = null;
  for (let i = idx - 1; i >= 0; i--) if (tab.items[i].kind === 'user') { target = tab.items[i]; break; }
  if (!target) { toast('这条失败记录前没有可重发的提问'); return; }
  const bad = item.failure && item.failure.model;
  if (bad && bad === state.config.model) {
    toast('当前模型仍是 ' + bad + '，请先切换模型', 2600);
    openModelPicker();
    return;
  }
  retryFrom(target);
  toast('已用 ' + (state.config.model || '默认模型') + ' 重新发起');
}
function setView(view) {
  const v = view === 'trace' ? 'trace' : 'chat';
  state.view = v;
  document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  renderChat();
}

/* ---------- 快捷键帮助（对标 Claude Code 的 ? / ⌘/） ---------- */
/** 可自定义项从当前映射实时取键位，固定项保留说明文案。 */
function helpGroups() {
  const m = shortcutMap();
  const k = (id) => comboLabel(m[id]);
  return [
    ['会话', [[k('newTab'), '新建页签'], [k('palette'), '命令面板'],
      [k('viewChat') + ' / ' + k('viewTrace'), '对话 / 轨迹视图'],
      [k('sidebar'), '显示或隐藏侧边栏'], [k('focusSearch'), '聚焦会话搜索'],
      ['⌘⇧M', '收成桌面小圆球（点球弹出迷你聊天窗）'],
      ['Esc', '关闭浮层；无浮层时停止本回合']]],
    ['输入', [['Enter', '发送'], ['Shift Enter', '换行'], [k('send'), '发送（任意焦点）'],
      ['↑ / ↓', '复用上一条 / 下一条提问'], ['/help', '斜杠命令列表']]],
    ['消息', [[k('copyLast'), '复制上一条回复'], ['悬停消息', '复制单条 / 重试'],
      ['代码块右上', '复制代码'], ['点击工具行', '展开输入输出详情']]],
    ['其他', [[k('help') + ' 或 ?', '打开本帮助'], [k('terminal'), '切换右侧面板'],
      ['点击图标栏 logo', '展开侧栏']]],
    ['看板', [['N', '新建任务'], ['/', '聚焦搜索'], ['R', '刷新看板'],
      ['← / →', '在卡片间移动'], ['Enter', '打开选中卡片详情'],
      ['↑ / ↓', '详情抽屉内切上一张 / 下一张']]],
  ];
}
function renderHelp(force) {
  const body = $('#help-body'); if (!body) return;
  if (!force && body.childElementCount) return; // 自定义快捷键后传 force 强制重绘
  const footKey = $('#help-foot-palette');
  if (footKey) footKey.textContent = comboLabel(shortcutMap().palette);
  body.innerHTML = helpGroups().map(([title, rows]) =>
    `<section class="help-group"><h3>${esc(title)}</h3>${rows.map(([ky, d]) =>
      `<div class="help-row"><kbd>${esc(ky)}</kbd><span>${esc(d)}</span></div>`).join('')}</section>`).join('');
}
function toggleHelp(force) {
  const modal = $('#help-modal'); if (!modal) return;
  const show = force === undefined ? modal.hidden : !!force;
  modal.hidden = !show;
  if (show) { renderHelp(true); const c = $('#help-close'); if (c) c.focus(); }
  else { const i = $('#input'); if (i) i.focus(); }
}
if ($('#btn-help')) $('#btn-help').onclick = () => toggleHelp(true);
if ($('#help-close')) $('#help-close').onclick = () => toggleHelp(false);
if ($('#help-modal')) $('#help-modal').addEventListener('click', (e) => { if (e.target.id === 'help-modal') toggleHelp(false); });
