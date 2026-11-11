'use strict';
/**
 * 小球模式（orb）：主窗口收起后，桌面上留一颗可拖动的小圆球。
 * 点球弹出旁边的迷你聊天窗（main/orb-chat.js），不恢复主窗口。
 *
 * 为什么是独立 BrowserWindow，而不是把主窗口缩成 52px：
 *   - 主窗口几何是用户多轮定版的，缩小再放大会牵动尺寸/位置/滚动位置/视口自愈，
 *     任何一步出错都是「右侧白块」或几何漂移；
 *   - 独立小窗可以透明 + 置顶 + 跨空间可见，主窗口只 hide()，恢复时零成本。
 *
 * 窗口参数的坑（参考 ~/IdeaProjects/github/Smliences/hermes-orb 的实测）：
 *   - **不要给窗口加 panel 类型**：Electron 33 + macOS 13 会报
 *     `NSWindow does not support nonactivating panel styleMask 0x80`，
 *     并且窗口完全收不到鼠标事件（球画得出来但点不动）；
 *   - acceptFirstMouse 必须 true：否则应用未激活时第一次点击只用来激活应用；
 *   - focusable 保持 true，配合 showInactive() 实现「出现但不抢焦点」。
 */
const { BrowserWindow, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const BALL = 52;   // 可见球直径
const WIN = 68;    // 窗口边长：四周各留 8px 给阴影与忙碌时的旋转弧
const EDGE = 24;   // 贴屏幕边缘的留白

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/**
 * @param {object} opts
 * @param {string} opts.userDataDir  位置持久化目录
 * @param {function} opts.getStatus  () => ({ state:'idle|busy|approval|offline', count:number })
 * @param {function} opts.onClick    点球 → 开关迷你聊天窗（默认行为）
 * @param {function} opts.onRestore  右键「打开 Hermes 窗口」→ 恢复主窗口
 * @param {function} opts.onDragStart 开始拖动 → 收起迷你聊天窗，免得被拖着跑
 * @param {function} opts.onMinimizeToDock  右键「最小化到程序坞」逃生口
 * @param {function} opts.onQuit
 * @param {function} opts.getPrefs   () => {mode:'always|hotkey',hotkey:boolean} 球偏好
 * @param {function} opts.onSetMode  (mode) => void
 * @param {function} opts.onSetHotkey (on:boolean) => void
 * @param {function} opts.onHideBall 右键「隐藏小圆球」：只隐球，不恢复主窗口
 * @param {string} opts.shortcutLabel  全局快捷键的展示文案
 * @param {function} opts.menuSections () => Promise<Array> 菜单顶部的 Profile /
 *                   最近会话分组（主进程拼装，球窗口不接触任何会话数据）
 * @param {object} opts.log
 */
function createOrb(opts) {
  const log = opts.log || { info() {}, warn() {} };
  const posPath = path.join(opts.userDataDir, 'orb.json');

  let win = null;
  let status = { state: 'idle', count: 0 };
  let dragging = false;   // 一次拖动只通知一次「收起小窗」

  /** 默认位置：主屏右侧、竖向偏下（避开菜单栏与 Dock） */
  function defaultPos() {
    const a = screen.getPrimaryDisplay().workArea;
    return { x: a.x + a.width - WIN - EDGE, y: a.y + Math.round(a.height * 0.62) };
  }

  /** 把坐标收进某块屏幕的可见区：整颗球必须留在 workArea 内，
   *  否则用户把球拖到屏幕外就再也找不回来了（也避免压住菜单栏 / Dock）。
   *
   *  跨屏坑：拿整块 probe 去 getDisplayMatching，球刚跨过屏幕边界时仍会被
   *  判给原屏幕，然后 clamp 回来 —— 表现为「拖到边缘就卡住，拖不到副屏」。
   *  改成：① 已完整落在某块 workArea 内就直接放行；② 否则按球心找屏幕再夹。 */
  function clampToDisplay(pos) {
    const probe = { x: Math.round(pos.x), y: Math.round(pos.y), width: WIN, height: WIN };
    const inside = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return probe.x >= a.x && probe.y >= a.y
        && probe.x + probe.width <= a.x + a.width
        && probe.y + probe.height <= a.y + a.height;
    });
    if (inside) return { x: probe.x, y: probe.y };
    const a = screen.getDisplayMatching({
      x: probe.x + Math.round(WIN / 2), y: probe.y + Math.round(WIN / 2), width: 1, height: 1,
    }).workArea;
    return {
      x: clamp(probe.x, a.x, Math.max(a.x, a.x + a.width - WIN)),
      y: clamp(probe.y, a.y, Math.max(a.y, a.y + a.height - WIN)),
    };
  }

  function readPos() {
    try {
      const raw = JSON.parse(fs.readFileSync(posPath, 'utf8'));
      if (Number.isFinite(raw && raw.x) && Number.isFinite(raw && raw.y)) return clampToDisplay(raw);
    } catch { /* 首次运行 / 文件损坏都回默认位置 */ }
    return clampToDisplay(defaultPos());
  }

  /** 拖动结束时立即落盘：只在 dragend 调一次，不需要节流。
   *  早期版本用 400ms 定时器节流，用户「拖完立刻退出」时定时器被 destroy 清掉，
   *  位置就丢了；而且拖动过程中本来就不写盘，节流并没有省下什么。 */
  function savePos() {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      fs.mkdirSync(path.dirname(posPath), { recursive: true });
      fs.writeFileSync(posPath, JSON.stringify({ x: b.x, y: b.y }));
    } catch (err) {
      log.warn('orb', 'save position failed', { err: String((err && err.message) || err) });
    }
  }

  function push() {
    if (win && !win.isDestroyed()) win.webContents.send('orb:status', status);
  }

  let menuBusy = false;
  /** 右键 / 下拉箭头 / 键盘 ArrowDown 都走这里。顶部两组（Profile、最近会话）
   *  由主进程异步拼装，失败时仍弹出原有菜单，不让球变得「点不动」。 */
  async function contextMenu() {
    if (menuBusy) return;
    menuBusy = true;
    try {
      let sections = [];
      if (typeof opts.menuSections === 'function') {
        try {
          const extra = await opts.menuSections();
          if (Array.isArray(extra)) sections = extra;
        } catch (err) {
          log.warn('orb', 'menu sections failed', { err: String((err && err.message) || err) });
        }
      }
      renderMenu(sections);
    } finally {
      menuBusy = false;
    }
  }

  function renderMenu(sections) {
    // 模式开关与全局快捷键共用同一份偏好（主进程内存态 + userData/orb-prefs.json），
    // 球的 preload 不因新增功能而多开任何通道。菜单栏托盘已移除（2026-11-11），
    // 这里就是模式 / 快捷键的唯一可视化入口。
    const p = (typeof opts.getPrefs === 'function' && opts.getPrefs()) || { mode: 'always', hotkey: true };
    const shortcut = opts.shortcutLabel || 'Alt+Shift+H';
    Menu.buildFromTemplate([
      ...sections,
      { label: '打开聊天', click: () => { (opts.onClick || opts.onRestore)(); } },
      { label: '打开 Hermes 窗口', click: () => opts.onRestore() },
      { type: 'separator' },
      { label: '常驻小圆球', type: 'radio', checked: p.mode === 'always', click: () => opts.onSetMode && opts.onSetMode('always') },
      { label: '仅快捷键唤起', type: 'radio', checked: p.mode === 'hotkey', click: () => opts.onSetMode && opts.onSetMode('hotkey') },
      { label: `全局快捷键 ${shortcut}`, type: 'checkbox', checked: !!p.hotkey, click: () => opts.onSetHotkey && opts.onSetHotkey(!p.hotkey) },
      { type: 'separator' },
      { label: '隐藏小圆球', click: () => opts.onHideBall && opts.onHideBall() },
      { label: '最小化到程序坞', click: () => { hide(); opts.onMinimizeToDock(); } },
      { label: '退出 Hermes', click: () => opts.onQuit() },
    ]).popup({ window: win || undefined });
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    const pos = readPos();
    win = new BrowserWindow({
      x: pos.x, y: pos.y, width: WIN, height: WIN,
      frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      hasShadow: false, skipTaskbar: true, autoHideMenuBar: true,
      alwaysOnTop: true, acceptFirstMouse: true, focusable: true, show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'orb-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        // 球在后台时也要保持 rAF 速率，否则忙碌弧会一顿一顿
        backgroundThrottling: false,
      },
    });
    win.setMenu(null);
    win.setAlwaysOnTop(true, 'pop-up-menu', 1);
    // 跨桌面空间 + 全屏应用之上都可见：悬浮球的意义就在这里
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 非 macOS */ }
    win.loadFile(path.join(__dirname, '..', 'renderer', 'orb.html'));
    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      win.showInactive();
      push();
    });
    win.on('closed', () => { win = null; });
    return win;
  }

  /* ---- IPC ---- */
  const own = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.on('orb:drag', (event, p) => {
    if (!own(event) || !p) return;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // 球一动，旁边那块聊天面板就没地方待了：收起一次即可。
    // 一帧一个 drag IPC，每帧都 close 会反复触发 onVisibilityChange / 状态回推。
    if (!dragging) {
      dragging = true;
      if (opts.onDragStart) opts.onDragStart();
    }
    const target = clampToDisplay({ x, y });
    win.setPosition(Math.round(target.x), Math.round(target.y));
  });
  ipcMain.on('orb:dragend', (event) => {
    if (!own(event)) return;
    dragging = false;
    savePos();   // 立即写盘，不等定时器
  });
  ipcMain.on('orb:click', (event) => {
    if (!own(event)) return;
    (opts.onClick || opts.onRestore)();
  });
  ipcMain.on('orb:restore', (event) => { if (own(event)) opts.onRestore(); });
  ipcMain.on('orb:menu', (event) => {
    if (!own(event)) return;
    Promise.resolve(contextMenu()).catch((err) => {
      log.warn('orb', 'menu failed', { err: String((err && err.message) || err) });
    });
  });

  function show(next) {
    status = next || status;
    dragging = false;
    const w = ensureWindow();
    if (w.isMinimized()) w.restore();
    const pos = clampToDisplay(w.getBounds());
    w.setPosition(pos.x, pos.y);
    w.showInactive();
    push();
    return true;
  }

  function hide() {
    dragging = false;   // 拖动中途球被隐去，dragend 可能不会再到达
    if (win && !win.isDestroyed()) win.hide();
  }

  function isVisible() {
    return !!(win && !win.isDestroyed() && win.isVisible());
  }

  /** 迷你聊天窗要靠它贴着球摆位（返回屏幕坐标，不是相对坐标） */
  function bounds() {
    if (!win || win.isDestroyed()) return null;
    return win.getBounds();
  }

  function setStatus(next) {
    status = next || status;
    push();
  }

  function destroy() {
    dragging = false;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return { show, hide, isVisible, bounds, setStatus, destroy, BALL, WIN };
}

module.exports = { createOrb, BALL, WIN };
