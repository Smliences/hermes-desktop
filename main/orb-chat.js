'use strict';
/**
 * 迷你聊天窗：点球弹出来的那块 380×520 悬浮面板，就地聊天，
 * 不去恢复 1360×860 的主窗口。
 *
 * 关键设计——**共用同一个 chat tab**：
 *   主窗口「收起」只是 hide()，它的渲染层与 tab.items 都还活着，后端事件
 *   照样写进主窗口的 DOM。所以这边发消息时只要拿主窗口上报的 tabId 走同一条
 *   `chat.submit()`，两边天然是同一个会话；主窗口恢复后看到的是完整对话，
 *   不会出现「小窗聊了半天、回主窗一片空白」。
 *
 * 窗口参数的坑与球一致（见 orb.js）：不加 panel 类型、acceptFirstMouse、
 * 透明 + 无边框，圆角由 CSS 裁。
 */
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

const W = 380;
const H = 520;
const GAP = 12;    // 与小球的间距
const EDGE = 10;   // 距屏幕工作区的留白
const DRAFT_MAX = 4000;
const TEXT_MAX = 8000;

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

/**
 * @param {object} opts
 * @param {object} opts.log
 * @param {function} opts.getAnchor  () => {x,y,width,height} 球的窗口 bounds
 * @param {function} opts.getContext () => {tabId,sessionId,title,model,theme,messages,running}
 * @param {function} opts.onSubmit   (text) => Promise<{ok:boolean,error?:string,running?:boolean}>
 * @param {function} opts.onAbort    () => void
 * @param {function} opts.onApprove  (requestId, choice) => void
 * @param {function} opts.onExpand   () => void  在 Hermes 主窗口中打开
 * @param {function} opts.onVisibilityChange () => void  开/关之后同步球上的「已展开」态
 */
function createOrbChat(opts) {
  const log = opts.log || { info() {}, warn() {} };

  let win = null;
  let loaded = false;
  let draft = '';
  /** 上次「自动贴球」时球的屏幕坐标：用户手动拖过小窗之后，
   *  只要球没动就尊重用户摆的位置，别每次点开都把人拖回来。 */
  let placedAnchor = null;

  /** 兜底锚点：球窗口意外不在时，贴主屏右下角（和球的默认位置一致） */
  function defaultAnchor() {
    const a = screen.getPrimaryDisplay().workArea;
    return { x: a.x + a.width - 68 - 24, y: a.y + Math.round(a.height * 0.62), width: 68, height: 68 };
  }

  /** 贴着球摆：球在屏幕左半边就开在右边，反之开在左边；垂直方向对齐球心 */
  function place() {
    if (!win || win.isDestroyed()) return;
    const anchor = opts.getAnchor() || defaultAnchor();
    const [w, h] = win.getSize();
    const area = screen.getDisplayMatching({ x: anchor.x, y: anchor.y, width: 1, height: 1 }).workArea;

    let x = anchor.x - w - GAP;
    if (x < area.x + EDGE) x = anchor.x + (anchor.width || 0) + GAP;
    let y = anchor.y + Math.round((anchor.height || 0) / 2) - Math.round(h / 2);

    x = clamp(x, area.x + EDGE, area.x + area.width - w - EDGE);
    y = clamp(y, area.y + EDGE, area.y + area.height - h - EDGE);
    win.setPosition(Math.round(x), Math.round(y));
    placedAnchor = { x: anchor.x, y: anchor.y };
  }

  /** 用户自己拖过 / 缩过窗口：只保证整块面板还在可见区内（换过显示器也能找回来） */
  function clampIntoView() {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(b.width, area.width);
    const height = Math.min(b.height, area.height);
    const x = clamp(b.x, area.x + EDGE, area.x + area.width - width - EDGE);
    const y = clamp(b.y, area.y + EDGE, area.y + area.height - height - EDGE);
    if (x !== b.x || y !== b.y || width !== b.width || height !== b.height) {
      win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
    }
  }

  /** 球在面板的哪一侧：渲染层据此把「连接轨」画在朝球那一边。
   *  每次现算而不是缓存——用户拖过面板或换过显示器后方位会变。 */
  function sideOfBall() {
    const anchor = opts.getAnchor() || defaultAnchor();
    if (!win || win.isDestroyed()) return 'right';
    const b = win.getBounds();
    const ballCenter = anchor.x + (anchor.width || 68) / 2;
    return ballCenter >= b.x + b.width / 2 ? 'right' : 'left';
  }

  function context() {
    let ctx = {};
    try { ctx = opts.getContext() || {}; }
    catch (err) {
      log.warn('orbchat', 'context failed', { err: String((err && err.message) || err) });
    }
    return { ...ctx, side: sideOfBall() };
  }

  const PUSHABLE = new Set([
    'orbchat:event', 'orbchat:approval', 'orbchat:approval-resolved', 'orbchat:state', 'orbchat:sync',
    'orbchat:focus',
  ]);

  /** 只允许推固定几种事件给面板，且窗口必须已加载完（否则首帧 send 会丢） */
  function push(channel, payload) {
    if (!PUSHABLE.has(channel)) return false;
    if (!win || win.isDestroyed() || !loaded) return false;
    win.webContents.send(channel, payload);
    return true;
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: W, height: H,
      show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: true, minWidth: 320, minHeight: 400, maxWidth: 560, maxHeight: 780,
      hasShadow: true, roundedCorners: true, skipTaskbar: true,
      alwaysOnTop: true, acceptFirstMouse: true, autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'orb-chat-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setMenu(null);
    win.setAlwaysOnTop(true, 'pop-up-menu', 1);
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 非 macOS */ }
    loaded = false;
    win.webContents.on('did-finish-load', () => {
      loaded = true;
      // 首次加载由渲染层自己 bootstrap；之后每次重开都靠这条 sync 刷新上下文
      push('orbchat:sync', context());
      // 首帧就是在 open() 里亮出来的（那时还没 loaded，focus 推不进去）：这里补一次
      if (win.isVisible()) push('orbchat:focus', {});
    });
    win.on('closed', () => { win = null; loaded = false; });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'orb-chat.html'));
    return win;
  }

  /* ---- IPC（校验 sender：只有这个面板能调） ---- */
  const own = (event) => !!win && !win.isDestroyed() && event.sender === win.webContents;

  function handle(channel, fn) {
    try { ipcMain.removeHandler(channel); } catch { /* 未注册过 */ }
    ipcMain.handle(channel, async (event, ...args) => {
      if (!own(event)) return { ok: false, error: 'forbidden' };
      try { return await fn(...args); }
      catch (err) {
        const msg = String((err && err.message) || err);
        log.warn('orbchat', `${channel}: ${msg}`);
        return { ok: false, error: msg };
      }
    });
  }

  handle('orbchat:bootstrap', () => ({ ...context(), draft }));

  handle('orbchat:send', async (payload) => {
    const text = String((payload && payload.text) || '').trim();
    if (!text) return { ok: false, error: '消息为空' };
    if (text.length > TEXT_MAX) return { ok: false, error: '消息过长（上限 8000 字）' };
    return opts.onSubmit(text);
  });

  handle('orbchat:abort', () => { opts.onAbort(); return { ok: true }; });

  handle('orbchat:approve', (payload) => {
    const p = payload || {};
    const choice = p.choice === 'deny' ? 'deny' : p.choice === 'always' ? 'always' : 'approve';
    if (!p.requestId) return { ok: false, error: '缺少 requestId' };
    opts.onApprove(String(p.requestId), choice);
    return { ok: true };
  });

  ipcMain.on('orbchat:close', (event) => { if (own(event)) close(); });
  ipcMain.on('orbchat:expand', (event) => { if (own(event)) opts.onExpand(); });
  ipcMain.on('orbchat:draft', (event, text) => {
    if (!own(event)) return;
    draft = String(text == null ? '' : text).slice(0, DRAFT_MAX);
  });

  function open() {
    if (!opts.getContext || !opts.getContext().tabId) {
      // 主窗口还没上报 tab（极早期）：不弹空面板，让球先留着
      return false;
    }
    const w = ensureWindow();
    const anchor = opts.getAnchor() || defaultAnchor();
    // 球自己动过才重新贴靠；否则保留用户手动摆的位置（不然每次点开都被拖回来）
    const anchorMoved = !placedAnchor || placedAnchor.x !== anchor.x || placedAnchor.y !== anchor.y;
    if (anchorMoved) place(); else clampIntoView();
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    // 面板刚亮出来就把光标放进输入框：点球 / 按 ⌥⇧H 之后可以直接打字，
    // 不用再用鼠标点一下（2026-11-11 要求）。窗口 focus 不等于 DOM 焦点，
    // 所以这里显式再推一条给渲染层；首次加载时 push 会失败，did-finish-load 里补。
    push('orbchat:focus', {});
    if (loaded) push('orbchat:sync', context());
    log.info('orbchat', 'opened');
    if (opts.onVisibilityChange) opts.onVisibilityChange();
    return true;
  }

  function close() {
    if (!win || win.isDestroyed()) return false;
    if (!win.isVisible()) return false;
    win.hide();
    log.info('orbchat', 'closed');
    if (opts.onVisibilityChange) opts.onVisibilityChange();
    return true;
  }

  function isOpen() {
    return !!(win && !win.isDestroyed() && win.isVisible());
  }

  function pushEvent(evt) { return push('orbchat:event', evt); }
  function pushApproval(req) { return push('orbchat:approval', req); }
  function pushApprovalResolved(p) { return push('orbchat:approval-resolved', p); }
  function pushState(p) { return push('orbchat:state', p); }
  function pushSync() { return push('orbchat:sync', context()); }

  function destroy() {
    for (const ch of ['orbchat:bootstrap', 'orbchat:send', 'orbchat:abort', 'orbchat:approve']) {
      try { ipcMain.removeHandler(ch); } catch { /* ignore */ }
    }
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    loaded = false;
  }

  return { open, close, isOpen, pushEvent, pushApproval, pushApprovalResolved, pushState, pushSync, destroy, W, H };
}

module.exports = { createOrbChat };
