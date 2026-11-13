'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, dialog, clipboard, powerMonitor, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 受限环境兼容：禁用硬件加速，避免 GPU 子进程不可用时启动失败
app.disableHardwareAcceleration();

const log = require('./services/logger');
const isDev = process.argv.includes('--dev');

/* 调试口：仅显式授权时开启。
   旧实现只要 /tmp/hermes_cdp_port 存在就 appendSwitch，而 /tmp 全局可写，
   等于给生产实例开了一个本地任意代码执行的后门。现在只接受进程环境变量
   （启动者显式注入），打包版还需 HERMES_ALLOW_CDP=1 或 --dev。 */
(function enableCDP() {
  if (app.isPackaged && !isDev && process.env.HERMES_ALLOW_CDP !== '1') return;
  const raw = process.env.HERMES_CDP_PORT || (isDev ? '9555' : '');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
  app.commandLine.appendSwitch('remote-debugging-port', String(port));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
})();

const { ChatChannel, resolveHermesBin } = require('./services/hermes-chat');
const sessions = require('./services/hermes-sessions');
const { serveStatus } = require('./services/gateway-client');
const hermesGateway = require('./services/hermes-gateway');
const hermesPreview = require('./services/hermes-preview');
const profile = require('./services/hermes-profile');
const yamlCfg = require('./services/hermes-config-yaml');
const hermesExport = require('./services/hermes-export');
const hermesTools = require('./services/hermes-tools');
const hermesMcp = require('./services/hermes-mcp');
const hermesCron = require('./services/hermes-cron');
const { createKanbanClient } = require('./services/hermes-kanban');
const { createOrb } = require('./orb');
const { createOrbChat } = require('./orb-chat');
const { createOrbAccess, ACCEL_LABEL } = require('./orb-access');

/* ---------------- 生产级启动 ----------------
   常驻 `hermes serve` 与 config.yaml 写队列都是进程内状态，多开会拉起多个后端、
   并发写坏配置。取单实例锁，第二个实例聚焦已有窗口后直接退出。 */
let restoreMain = () => {};

function boot() {
  log.init(app.getPath('userData'));
  // 必须在拉起后端之前完成：所有 CLI 子进程靠它拿到 `-p <name>` 与 HERMES_HOME
  profile.init(app.getPath('userData'));

  let mainWindow = null;
  // 连接状态变化 → 推给所有窗口（含小球聊天窗）：掉线要让用户看见，
  // 而不是等下一次操作失败才在 toast 里露一句「连接已重置」
  const pushConnStatus = (st) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w && !w.isDestroyed()) { try { w.webContents.send('hermes:status', st); } catch {} }
    }
  };
  const chat = new ChatChannel('', { onStatus: pushConnStatus });
  const warmTimers = { plugins: null, skills: null };

  // 进程加载即预热常驻 `hermes serve` 后端（比窗口创建更早，对话零冷启动）
  chat.startBackend();

  // ---- 配置（userData/config.json）----
  const CONFIG_SCHEMA = { model: 'string', reasoning: 'string', yolo: 'boolean' };
  function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
  function loadConfig() {
    const base = { model: '', reasoning: 'none', yolo: false };
    try { return { ...base, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; }
    catch { return base; }
  }
  // 从 hermes 全局配置（当前 profile 的 config.yaml）读默认模型。
  // 与「模型状态」只读通道共用同一个行级解析器，避免两处解析规则漂移。
  function hermesYamlModel() {
    try {
      const yaml = fs.readFileSync(profile.configPath(), 'utf8');
      return require('./services/hermes-config').parseModelBlock(yaml).defaultModel || '';
    } catch { return ''; }
  }
  /** 只接受白名单字段与正确类型：渲染层不能借 cfg:set 往配置里塞任意结构。 */
  function saveConfig(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
      if (CONFIG_SCHEMA[k] && typeof v === CONFIG_SCHEMA[k]) clean[k] = v;
    }
    const cfg = { ...loadConfig(), ...clean };
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
    return cfg;
  }

  /** 外部链接：只允许 https，或本机 loopback（预览开发服务器）。 */
  function safeExternal(url) {
    if (typeof url !== 'string') return false;
    return /^https:\/\//i.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url);
  }

  /* ---- 小球模式 ----
     黄灯 / ⌘M / ⌘⇧M / 命令面板 `/orb` 都把主窗口收成桌面上一颗小球；
     点球弹出迷你聊天窗（380×520），在球旁边就能继续对话。
     主窗口只 hide()，不改尺寸与位置，恢复时零成本、不会触发视口自愈。 */
  let orb = null;
  let orbChat = null;
  let orbAccess = null;      // 全局快捷键 + 偏好（app 级资源，只创建一次；托盘已移除）
  let orbActive = false;     // 主窗口是否已收起（球态），与球是否可见解耦
  let orbTimer = null;
  let orbChatLastRunning = null;  // 上一次推给小窗的回合态，避免每次 syncOrb 重复推
  let allowNativeMinimize = false;
  let busyTurns = 0;
  let pendingApprovals = 0;
  /** 主窗口渲染层上报的当前会话上下文（tabId / 标题 / 最近消息 / 主题）。
   *  迷你窗靠它绑定「同一个会话」，所以它由渲染层推、主进程只做缓存。 */
  let orbCtx = null;

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1360, height: 860, minWidth: 940, minHeight: 600,
      backgroundColor: '#f2f4f3',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 13 } : undefined,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // 旧实现把任意 url 交给系统（file: / 自定义 scheme 都能启动外部程序）
      if (safeExternal(url)) shell.openExternal(url);
      else log.warn('window', 'blocked window.open', { url: log.redact(url) });
      return { action: 'deny' };
    });
    // 从最小化 / 全屏退出恢复时，窗口 frame 已变而内容区未必跟上，补一次校准
    mainWindow.on('restore', () => scheduleViewportHeal('restore'));
    // 黄灯：收成小球而不是进程序坞（右键菜单里留了「最小化到程序坞」逃生口）
    mainWindow.on('minimize', () => {
      if (allowNativeMinimize) { allowNativeMinimize = false; return; }
      enterOrb();
    });
  }

  /* ---- 小球模式：开合 + 状态推送 ---- */
  function orbStatus() {
    if (pendingApprovals > 0) return { state: 'approval', count: pendingApprovals };
    if (busyTurns > 0) return { state: 'busy', count: 0 };
    // starting / idle 是启动瞬间的常态，不该在球上亮红点；只有 stopped 才是真的没后端
    if (chat.backendInfo().state === 'stopped') return { state: 'offline', count: 0 };
    return { state: 'idle', count: 0 };
  }
  /** 状态快照里顺带告诉球「迷你聊天窗是否展开」：球据此亮内环，
   *  与小窗朝球那一侧的连接轨呼应，点球→开窗形成可见的状态闭环。 */
  function orbSnapshot() {
    return { ...orbStatus(), open: !!(orbChat && orbChat.isOpen()) };
  }
  /** 球态、迷你小窗的状态对齐都收在这一处：
   *  - 球：状态点 / 内环 / 读屏播报；
   *  - 小窗：回合运行态（连接轨呼吸只认主进程下发的这个值）；
   *  - hotkey 模式：球只允许在迷你聊天窗打开时出现，收起即隐去。
   *  （菜单栏托盘已按用户 2026-11-11 要求删除，这里不再推 tray 文案） */
  function syncOrb() {
    if (orb) orb.setStatus(orbSnapshot());
    if (orbChat && orbChat.isOpen() && (busyTurns > 0) !== orbChatLastRunning) {
      pushOrbChatRunning(busyTurns > 0);
    }
    const chatOpen = !!(orbChat && orbChat.isOpen());
    const hotkeyOnly = !!(orbAccess && orbAccess.prefs().mode === 'hotkey');
    // 球只在两种情况下允许留在桌面：主窗口已收起（球态），或小窗正开着。
    // 主窗口还在前台时用快捷键临时叫出的球，收起小窗后要跟着隐去。
    if (orb && orb.isVisible() && !chatOpen && (hotkeyOnly || !orbActive)) {
      orb.hide();
    }
  }
  /** 主进程唯一的小窗回合态出口：submitTurn / onClose / syncOrb 都走这里，
   *  渲染层不自造状态机，也不会因为同一次回合收到两份矛盾的 running。 */
  function pushOrbChatRunning(running, extra) {
    orbChatLastRunning = !!running;
    if (orbChat) orbChat.pushState({ running: !!running, ...(extra || {}) });
  }
  /** 球态期间低频对一次状态：后端可能自己停掉 / 换代。
   *  用递归 setTimeout 而不是 setInterval —— 契约里有一条「主进程不得轮询窗口位置」，
   *  递归超时能保证任何时候都只有一个在途定时器，退出时也能一次清干净。
   *  判据是「主窗口已收起」而不是「球可见」：hotkey 模式球平时是隐去的，
   *  若按球可见来判，状态对齐就再也不会发生。 */
  function scheduleOrbTick() {
    if (orbTimer) return;
    orbTimer = setTimeout(() => {
      orbTimer = null;
      if (!orbActive) return;
      syncOrb();
      scheduleOrbTick();
    }, 5000);
    if (orbTimer.unref) orbTimer.unref();
  }

  /** 球窗口懒创建。全局快捷键也要能唤起它，所以不再只在 enterOrb 里建。 */
  function ensureOrb() {
    if (orb) return orb;
    orb = createOrb({
      userDataDir: app.getPath('userData'),
      log,
      getStatus: orbStatus,
      onClick: toggleOrbChat,
      onRestore: leaveOrb,
      onDragStart: () => { if (orbChat) orbChat.close(); },
      onMinimizeToDock: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        allowNativeMinimize = true;
        mainWindow.minimize();
      },
      onQuit: () => app.quit(),
      getPrefs: () => (orbAccess ? orbAccess.prefs() : { mode: 'always', hotkey: true }),
      onSetMode: (mode) => { if (orbAccess) orbAccess.setMode(mode); },
      onSetHotkey: (on) => { if (orbAccess) orbAccess.setHotkey(on); },
      onHideBall: () => hideOrbBall(),
      shortcutLabel: orbAccess ? orbAccess.shortcutLabel : 'Alt+Shift+H',
      menuSections: orbMenuSections,
    });
    return orb;
  }

  /* ---------------- 球的 Profile / 最近会话下拉 ----------------
     菜单数据全在主进程拼装：profile 名来自桌面端唯一真源，会话列表只读
     各自 profile 的 state.db（路径由服务层白名单化），渲染层拿不到任何
     绝对路径 / token。菜单项只发一个结构化意图给主窗口，profile 切换
     复用渲染层既有链路（后端重启 + reload），球里不另造状态机。 */
  const ORB_RECENT = 5;
  const ORB_MORE_LIMIT = 20;

  function orbMenuLabel(s) {
    const t = String((s && s.title) || '未命名会话').replace(/[\r\n\t]+/g, ' ').trim();
    return t.length > 44 ? t.slice(0, 43) + '…' : t;
  }
  function orbSessionItem(profileName, s) {
    return { label: orbMenuLabel(s), click: () => openOrbSession(profileName, String(s.id || '')) };
  }
  function orbOpenProfile(name) {
    if (!name || name === profile.current()) return;
    leaveOrb();
    safeSend('orb:open-session', { profile: name, sessionId: '', needsSwitch: true });
  }
  function openOrbSession(profileName, sessionId) {
    if (!sessionId) return orbOpenProfile(profileName);
    const needsSwitch = profileName !== profile.current();
    leaveOrb();
    safeSend('orb:open-session', { profile: profileName, sessionId, needsSwitch });
  }
  function orbProfileSubmenu(entry, current) {
    const head = [{
      label: entry.name === current ? '当前 Profile' : `切换到 ${entry.name}`,
      enabled: entry.name !== current,
      click: () => orbOpenProfile(entry.name),
    }, { type: 'separator' }];
    const recent = entry.sessions.slice(0, ORB_RECENT);
    const more = entry.sessions.slice(ORB_RECENT);
    const list = recent.length
      ? recent.map((s) => orbSessionItem(entry.name, s))
      : [{ label: '（暂无会话）', enabled: false }];
    if (more.length) {
      list.push({
        label: `更多会话 (${more.length})`,
        submenu: more.map((s) => orbSessionItem(entry.name, s)),
      });
    }
    return head.concat(list);
  }
  /** 异步拉一次快照；失败时仍返回可用的菜单（只是会话列表为空），不阻塞弹菜单。 */
  async function orbMenuSections() {
    const snap = profile.snapshot();
    const current = snap.current;
    const names = snap.profiles.map((p) => p.name).filter((n) => profile.validName(n));
    const entries = await Promise.all(names.map(async (name) => {
      let rows = [];
      try { rows = await sessions.listSessions({ limit: ORB_MORE_LIMIT, profileName: name }); }
      catch (err) {
        log.warn('orb', 'recent sessions unavailable', { name, err: String((err && err.message) || err) });
      }
      return {
        name,
        sessions: (Array.isArray(rows) ? rows : []).filter((s) => s && s.id)
          .slice(0, ORB_MORE_LIMIT).map((s) => ({ id: String(s.id), title: String(s.title || s.id) })),
      };
    }));
    const cur = entries.find((e) => e.name === current);
    const recentItems = cur && cur.sessions.length
      ? cur.sessions.slice(0, ORB_RECENT).map((s) => orbSessionItem(current, s))
      : [{ label: '（暂无会话）', enabled: false }];
    if (cur && cur.sessions.length > ORB_RECENT) {
      recentItems.push({
        label: `更多会话 (${cur.sessions.length - ORB_RECENT})`,
        submenu: cur.sessions.slice(ORB_RECENT).map((s) => orbSessionItem(current, s)),
      });
    }
    return [
      {
        label: `切换 Profile · 当前 ${current}`,
        submenu: entries.map((e) => ({
          label: e.name === current ? `${e.name}（当前）` : e.name,
          submenu: orbProfileSubmenu(e, current),
        })),
      },
      { label: '最近会话', submenu: recentItems },
      { type: 'separator' },
    ];
  }

  function enterOrb() {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (orbActive && orb && orb.isVisible()) return true;
    if (mainWindow.isFullScreen()) {
      // 全屏窗口不能直接 hide()，先退全屏再收（一次性事件，避免递归）
      mainWindow.once('leave-full-screen', () => enterOrb());
      mainWindow.setFullScreen(false);
      return true;
    }
    const o = ensureOrb();
    orbActive = true;
    // hotkey 模式：主窗口收起后桌面不常驻球，球随小窗一起出现。
    if (orbAccess && orbAccess.prefs().mode === 'hotkey') o.hide();
    else orb.show(orbSnapshot());
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    scheduleOrbTick();
    log.info('orb', 'collapsed to ball', { mode: orbAccess ? orbAccess.prefs().mode : 'always' });
    return true;
  }

  /** 全局快捷键 / 点球都要先把球亮出来，小窗才有可依附的锚点。 */
  function revealBallForChat() {
    const o = ensureOrb();
    if (!o.isVisible()) o.show(orbSnapshot());
  }

  /** 只隐球，不恢复主窗口：always 模式下用户也能把桌面清干净，
   *  全局快捷键随时把球 + 小窗一起叫回来。 */
  function hideOrbBall() {
    if (orbChat) orbChat.close();
    if (orb) orb.hide();
    syncOrb();
  }

  /** 球右键菜单切换常驻 / 快捷键模式：不重建窗口、不碰主窗口几何。 */
  function applyOrbMode(mode) {
    if (mode === 'always' && orbActive) {
      const o = ensureOrb();
      if (!o.isVisible()) o.show(orbSnapshot());
    }
    syncOrb();   // hotkey 模式里，这一步会按「球可见但小窗未开」把球隐去
  }

  /** 迷你聊天窗：懒创建。它只认主窗口上报的会话（orbCtx），
   *  所以在主窗口还没 ready 之前不会弹出空面板。 */
  function ensureOrbChat() {
    if (orbChat) return orbChat;
    orbChat = createOrbChat({
      log,
      getAnchor: () => (orb && orb.isVisible() ? orb.bounds() : null),
      getContext: () => ({
        tabId: orbCtx ? orbCtx.tabId : '',
        sessionId: orbCtx ? orbCtx.sessionId : null,
        title: (orbCtx && orbCtx.title) || '新会话',
        model: (orbCtx && orbCtx.model) || '',
        theme: (orbCtx && orbCtx.theme) || 'light',
        messages: (orbCtx && orbCtx.messages) || [],
        running: busyTurns > 0,
      }),
      onSubmit: (text) => {
        if (!orbCtx || !orbCtx.tabId) return { ok: false, error: '还没有可用的会话，先回主窗口发一条' };
        const tabId = orbCtx.tabId;
        submitTurn(tabId, { query: text, sessionId: orbCtx.sessionId || null });
        // 主窗口只是 hide，渲染层还活着：告诉它补一条用户消息，
        // 否则小窗聊的内容回主窗后「只有回答、没有提问」。
        safeSend('orb:user-message', { tabId, text });
        if (orbCtx) {
          orbCtx.messages = [...(orbCtx.messages || []), { role: 'user', text, done: true }].slice(-14);
        }
        return { ok: true, running: true };
      },
      onAbort: () => { if (orbCtx && orbCtx.tabId) chat.abort(orbCtx.tabId); },
      onApprove: (requestId, choice) => respondApproval(requestId, choice, orbCtx && orbCtx.tabId),
      onExpand: () => leaveOrb(),
      // 点球 / Esc / × / 拖球 / 展开都会走 open() 或 close()，统一在这里回推球态，
      // 免得漏掉某条路径让球一直亮着内环。
      onVisibilityChange: () => syncOrb(),
    });
    return orbChat;
  }

  /** 点球 / 全局快捷键：开着就收起，没开就弹出来（不恢复主窗口）。
   *  hotkey 模式下球平时隐着，唤起小窗前先把它亮出来。 */
  function toggleOrbChat() {
    const oc = ensureOrbChat();
    if (oc.isOpen()) return oc.close();
    revealBallForChat();
    const ok = oc.open();
    if (!ok) syncOrb();   // 主窗口还没上报 tab：别把球孤零零留在桌面上
    return ok;
  }

  function leaveOrb() {
    if (orbTimer) { clearTimeout(orbTimer); orbTimer = null; }
    orbActive = false;
    if (orbChat) orbChat.close();
    if (orb) orb.hide();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      try { app.focus({ steal: true }); } catch { /* 非 macOS / 无权限 */ }
      mainWindow.focus();
      scheduleViewportHeal('orb-exit');
    }
    log.info('orb', 'restored window');
  }

  /* ---- 窗口内容区自愈 ----
     macOS 睡眠唤醒、解锁、退出全屏或显示器变化后，AppKit 偶尔只更新窗口
     frame，不同步 WebContentsView：表现是窗口右侧（或下方）一整块从未绘制
     的白色区域，而渲染层 innerWidth 仍停在 minWidth（940）。
     同值 setContentSize 不会触发重排，所以先抖 1px 再复位，强制重新布局。 */
  let healTimer = null;
  function healViewport(reason) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w, h] = mainWindow.getContentSize();
    if (!(w > 0 && h > 0)) return;
    try {
      mainWindow.setContentSize(w, h + 1);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setContentSize(w, h);
      }, 80);
      log.info('window', 'viewport healed', { reason, size: [w, h] });
    } catch (err) {
      log.warn('window', 'viewport heal failed', { reason, err: String((err && err.message) || err) });
    }
  }
  /** 合并 400ms 内的重复触发，避免唤醒瞬间多个事件各抖一次窗口。 */
  function scheduleViewportHeal(reason) {
    if (healTimer) clearTimeout(healTimer);
    healTimer = setTimeout(() => { healTimer = null; healViewport(reason); }, 400);
  }

  /* ---- 窗口不越出显示器 ----
     窗口大于剩余桌面空间时（小屏 / 换过外接显示器 / 拖到边缘），右侧或底部
     会被屏幕裁掉，看起来像「页面少了一块」。启动与显示器变化时把它收回可见区。 */
  function fitWindowToDisplay() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const b = mainWindow.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(b.width, area.width);
    const height = Math.min(b.height, area.height);
    const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
    if (x === b.x && y === b.y && width === b.width && height === b.height) return;
    log.info('window', 'fit to display', { from: [b.x, b.y, b.width, b.height], to: [x, y, width, height] });
    try { mainWindow.setBounds({ x, y, width, height }); }
    catch (err) { log.warn('window', 'fit to display failed', { err: String((err && err.message) || err) }); }
  }

  function safeSend(channel, payload, wc) {
    const target = wc || mainWindow?.webContents;
    if (target && !target.isDestroyed()) { target.send(channel, payload); return true; }
    return false;
  }

  /** 后端事件双投：主窗口照旧，迷你聊天窗同时收一份。
   *  小窗只有一块面板，所以只在事件属于它绑定的那个 tab 时才转发，
   *  避免主窗口开多个会话时把别的页签的流式内容串进小窗。 */
  function fanoutEvent(tabId, evt) {
    safeSend('hermes:event', { tabId, evt });
    if (orbChat && orbChat.isOpen() && (!orbCtx || !orbCtx.tabId || orbCtx.tabId === tabId)) {
      orbChat.pushEvent(evt);
    }
  }

  /** 统一 IPC 包装：异常不外泄成 Electron 的 "Error occurred in handler"，
   *  脱敏后落日志，并返回稳定形态（数组型调用点可指定 fallback）。 */
  function handle(channel, fn, fallback) {
    ipcMain.handle(channel, async (event, ...args) => {
      try { return await fn(event, ...args); }
      catch (err) {
        const msg = log.redact(String((err && err.message) || err));
        log.error('ipc', `${channel}: ${msg}`);
        return fallback !== undefined ? fallback : { ok: false, error: msg };
      }
    });
  }

  // ---------------- IPC ----------------

  handle('hermes:env', async () => {
    const bin = resolveHermesBin();
    const dbOk = await sessions.dbAvailable();
    let version = '';
    try { version = (await new Promise((res) => {
      const { execFile } = require('child_process');
      execFile(bin, ['--version'], { timeout: 6000 }, (e, out) => res(e ? '' : String(out).trim()));
    })) || ''; } catch {}
    const cfg = loadConfig();
    if (!cfg.model) cfg.model = hermesYamlModel();
    return { hermesBin: bin, hermesFound: fs.existsSync(bin) || bin === 'hermes', version,
      dbOk, dbPath: sessions.getDB(), config: cfg, profile: profile.current() };
  }, { config: { model: '', reasoning: 'none', yolo: false } });

  /* 提交一个回合。主窗口（hermes:send）与迷你聊天窗（orbchat:send）共用这一条，
     保证 busyTurns / 球态计数 / 事件投递 / 关闭收尾只有一个口径。 */
  function submitTurn(tabId, payload) {
    const p = payload || {};
    // 项目内新建会话：渲染层可以带 cwd（项目根）。必须是真实存在的绝对目录，
    // 否则丢弃 —— session.create 兜底 homedir，绝不把伪造路径交给 CLI。
    if (typeof p.cwd !== 'string' || !path.isAbsolute(p.cwd) || !fs.existsSync(p.cwd)) p.cwd = undefined;
    busyTurns += 1;
    pushOrbChatRunning(true);
    syncOrb();
    chat.submit(tabId, {
      query: p.query, sessionId: p.sessionId, model: p.model, reasoning: p.reasoning,
      yolo: p.yolo, toolsets: p.toolsets, skills: p.skills,
      attachments: p.attachments, image: p.image, cwd: p.cwd,
    }, {
      onEvent: (evt) => fanoutEvent(tabId, evt),
      onError: (err) => {
        safeSend('hermes:error', { tabId, message: err.message });
        if (orbChat) orbChat.pushEvent({ type: 'error', text: err.message });
      },
      onClose: (summary) => {
        busyTurns = Math.max(0, busyTurns - 1);
        pushOrbChatRunning(busyTurns > 0, { summary: summary || null });
        syncOrb();
        safeSend('hermes:close', { tabId, summary });
      },
    });
    return chat.getTabState(tabId);
  }

  handle('hermes:send', (e, payload) => {
    const p = payload || {};
    return submitTurn(p.tabId, p);
  });

  handle('hermes:abort', (_e, tabId) => { chat.abort(tabId); return true; });
  handle('hermes:tabState', (_e, tabId) => chat.getTabState(tabId));
  // 后端连接状态：读快照 + 手动重连（掉线时侧栏状态点可点）
  handle('chat:status', () => chat.statusSnapshot());
  handle('chat:reconnect', () => chat.reconnect());

  // 会话管理（数组型结果异常时返回 []，渲染层不必处理 throw）
  handle('sessions:list', (_e, args) => sessions.listSessions(args || {}), []);
  handle('sessions:history', (_e, args) => {
    const a = args || {};
    if (!a.sessionId) return [];
    return sessions.loadHistory(a.sessionId, { limit: a.limit });
  }, []);
  handle('sessions:stats', (_e, sessionId) => sessions.sessionStats(sessionId));
  handle('sessions:search', (_e, q) => sessions.searchMessages(q), []);
  handle('sessions:storage', () => sessions.storageStats());
  handle('sessions:delete', (_e, id) => sessions.deleteSession(id));
  // 会话移到项目：官方 session.workspace.move（换 cwd + git 身份，树分组跟着走）
  handle('sessions:move', (_e, id, cwd) => chat.moveSession(id, cwd));
  handle('sessions:rename', (_e, id, title) => sessions.renameSession(id, title));
  handle('sessions:pin', (_e, id, pinned) => sessions.setPinned(id, pinned));
  handle('sessions:usage', (_e, id) => sessions.sessionUsage(id), null);

  /* ---- 会话导出 ----
     路径由主进程的保存对话框决定，渲染层只传 { sessionId, format, title }，
     拿不到任意可写路径，也不能自己拼 argv。成功后返回落盘路径供「在访达中显示」。 */
  handle('sessions:export', async (e, args) => {
    const a = args || {};
    const fmt = String(a.format || '').toLowerCase();
    const ext = hermesExport.FORMATS[fmt];
    if (!ext) return { ok: false, error: '不支持的导出格式' };
    if (!hermesExport.validSessionId(String(a.sessionId || ''))) return { ok: false, error: '非法会话 id' };
    const safe = String(a.title || 'hermes-session')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'hermes-session';
    const parent = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    const { canceled, filePath } = await dialog.showSaveDialog(parent, {
      title: '导出会话',
      defaultPath: path.join(app.getPath('downloads'), safe + ext),
      filters: [{ name: fmt.toUpperCase(), extensions: [ext.slice(1)] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const res = await hermesExport.exportSession({ sessionId: a.sessionId, format: fmt, outPath: filePath });
    if (res.ok) shell.showItemInFolder(res.path);
    return res;
  });

  handle('app:reveal', (_e, p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
    try { shell.showItemInFolder(p); return true; } catch { return false; }
  });

  // 右侧栏多类型预览（网页 / PDF / 图片 / 文档 / 表格）
  handle('preview:resolve', (_e, input, baseDir) => hermesPreview.resolveLocal(input, baseDir));
  // 文本类才开放内容读取，白名单与 512KB 上限在 hermes-preview 里二次校验
  handle('preview:read', (_e, input, baseDir) => hermesPreview.readText(input, baseDir));
  handle('preview:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择要预览的文件',
      properties: ['openFile'],
      // 不给「所有文件」：选进来也会被 resolveLocal 拒掉，不如在对话框里就收口
      filters: [
        { name: '网页', extensions: ['html', 'htm', 'xhtml', 'svg'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'] },
        { name: '文档 / 源码', extensions: ['md', 'markdown', 'txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'css', 'scss', 'sh', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sql', 'toml'] },
        { name: '表格', extensions: ['csv', 'tsv'] },
      ],
    });
    if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
    return hermesPreview.resolveLocal(r.filePaths[0]);
  });
  handle('preview:watch', (_e, filePath) =>
    hermesPreview.watch(filePath, (p) => safeSend('preview:changed', { filePath: p })));
  handle('preview:unwatch', () => hermesPreview.unwatch());
  handle('preview:open-external', (_e, target) => {
    if (!target) return { ok: false, error: '路径为空' };
    if (/^https?:\/\//i.test(target)) {
      if (!safeExternal(target)) return { ok: false, error: '仅允许 https 或本机地址' };
      shell.openExternal(target); return { ok: true };
    }
    const r = hermesPreview.resolveLocal(target);
    if (!r.ok) return r;
    if (r.kind === 'url') {
      if (!safeExternal(r.url)) return { ok: false, error: '仅允许 https 或本机地址' };
      shell.openExternal(r.url); return { ok: true };
    }
    shell.openPath(r.filePath);
    return { ok: true, file: r.filePath };
  });

  /* ---- Kanban 看板（读 + 受控写 + 派发）----
     复用常驻 serve 已挂载的 /api/plugins/kanban/* 插件路由，不直读 kanban.db、
     不新起进程。会话 token 由 createKanbanClient 在主进程内部注入，
     渲染层只看得到投影后的字段。后端换代时 client 每次现取快照。
     写路径与 body 全由服务层白名单构造；派发默认 dry-run、单次上限 4、串行执行。 */
  const kanban = createKanbanClient(() => chat.backendInfo());
  async function ensureBackendReady() {
    if (chat.backendInfo().port) return true;
    try { await chat.backend.whenReady(8000); } catch {}
    return !!chat.backendInfo().port;
  }
  handle('kanban:board', async (_e, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.board(opts || {});
  });
  handle('kanban:task', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.task(taskId, opts || {});
  });
  handle('kanban:overview', async (_e, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.overview(opts || {});
  });
  // 侧栏项目树（GET /api/profiles/projects/tree）：会话按项目归组的数据源
  // profile 由主进程注入，渲染层传不进来：这个端点缺省会扫**所有** profile 并按文件夹
  // 合并，不限定就会把别的 profile 的项目并进当前侧栏（会话列表却只读当前 profile）。
  handle('projects:tree', async (_e, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.projectsTree({ ...(opts || {}), profile: profile.current() });
  });
  handle('kanban:run', async (_e, runId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.run(runId, opts || {});
  });
  handle('kanban:create-task', async (_e, input) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.createTask(input || {});
  });
  handle('kanban:create-board', async (_e, input) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.createBoard(input || {});
  });
  // 项目（命名工作空间）：列表随 kanban:overview 下发；绑定走 PATCH /boards/{slug}
  handle('kanban:bind-board', async (_e, input) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.bindBoard(input || {});
  });
  // 建项目没有 REST 端点，唯一官方入口是 CLI 子命令（写 projects.db，用户点击触发）
  handle('kanban:create-project', async (_e, input) => {
    return require('./services/hermes-project-cli').createProject(input || {});
  });
  // 官方 project-dialog 的文件夹选择：原生目录选择器（可多选），只回绝对路径且真实存在的目录。
  // 「打开文件夹为项目」走单选，同一个通道用 multiple:false 收敛。
  handle('project:pick-folders', async (_e, input) => {
    const o = input || {};
    const multiple = o.multiple !== false;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: multiple ? '添加文件夹' : '选择文件夹',
      buttonLabel: '添加',
      // createDirectory：macOS 原生面板自带「新建文件夹」，用户不必先到访达里建好
      properties: multiple ? ['openDirectory', 'multiSelections', 'createDirectory'] : ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !Array.isArray(r.filePaths) || !r.filePaths.length) return { ok: false, canceled: true };
    const folders = r.filePaths.filter((p) => {
      if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    }).slice(0, 8);
    return folders.length ? { ok: true, folders } : { ok: false, canceled: true };
  });
  // 在既有目录下新建空文件夹（弹窗里的「新建文件夹…」）；只建一层，父目录必须存在
  handle('project:mkdir', (_e, input) => require('./services/hermes-project-cli').createFolder(input || {}));
  // 既有项目的重命名 / 加文件夹 / 设为活动：argv 由服务层白名单拼装，用户点击触发
  handle('project:action', async (_e, input) => {
    return require('./services/hermes-project-cli').projectAction(input || {});
  });
  // 项目设置弹窗的读写：读完整项目、改名称/描述、维护文件夹（官方 projects.* RPC，方法名写死）
  handle('project:get', (_e, id) => chat.getProject(id));
  handle('project:update', (_e, input) => chat.updateProject(input || {}));
  handle('project:folder', (_e, input) => chat.projectFolder(input || {}));
  // 删除项目：CLI 没有 delete 子命令，官方桌面版走 `projects.delete` RPC。默认只删项目记录、
  // 不动磁盘文件；勾选「同时移到废纸篓」时才把**该项目自己的文件夹**逐个 trashItem（可恢复），
  // 且先读一次项目核对路径，免得渲染层传来任意目录。
  handle('project:delete', async (_e, input) => {
    const o = typeof input === 'string' ? { id: input } : (input || {});
    const id = String(o.id || '');
    const trash = o.trash === true;
    if (!trash) return chat.deleteProject(id);
    const cur = await chat.getProject(id);
    if (!cur || !cur.ok) return cur || { ok: false, error: '读取项目失败' };
    const allowed = new Set((cur.project.folders || []).map((f) => f.path));
    const wanted = (Array.isArray(o.folders) ? o.folders : [])
      .map((p) => String(p || '')).filter((p) => p.startsWith('/'));
    if (!wanted.length) return { ok: false, error: '该项目没有可删除的磁盘文件夹' };
    if (wanted.some((p) => !allowed.has(p))) return { ok: false, error: '文件夹不属于该项目，已取消删除' };
    const trashed = []; const failed = [];
    for (const dir of wanted.slice(0, 8)) {
      try {
        // 目录早就不在了：没什么可移的，跳过而不是把整个删除拦住
        if (!fs.existsSync(dir)) continue;
        if (!fs.statSync(dir).isDirectory()) { failed.push(dir + '（不是文件夹）'); continue; }
        await shell.trashItem(dir); // 走系统废纸篓：可恢复，绝不做硬删除
        trashed.push(dir);
      } catch (e) { failed.push(dir + '：' + String((e && e.message) || e).slice(0, 120)); }
    }
    if (failed.length) {
      return { ok: false, error: '未能全部移到废纸篓，项目记录已保留：' + failed.join('；').slice(0, 300), trashed };
    }
    const r = await chat.deleteProject(id);
    return (r && r.ok) ? { ...r, trashed } : r;
  });
  handle('app:copy', (_e, text) => {
    const s = String(text || '').slice(0, 512);
    if (!s) return false;
    try { clipboard.writeText(s); return true; } catch { return false; }
  });
  handle('kanban:delete-task', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.deleteTask(taskId, opts || {});
  });
  handle('kanban:submit-task', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.submitTask(taskId, opts || {});
  });
  // 拆解收集箱任务（调用 CLI 的辅助模型，最长 180s）：渲染层必须先过确认卡，
  // 服务层再要求显式 confirm === true 才发请求。
  handle('kanban:decompose', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.decomposeTask(taskId, opts || {});
  });
  // 补规格（辅助模型，120s）：同样要求渲染层带 confirm:true，成功会把任务推出收集箱
  handle('kanban:specify', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.specifyTask(taskId, opts || {});
  });
  // 估算工作量（辅助模型，60s，不改数据）：会计费，所以也要 confirm
  handle('kanban:estimate', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.estimateTask(taskId, opts || {});
  });

  // 添加评论：追加文本，不计费、不改状态；空白内容在服务层本地就拒。
  handle('kanban:add-comment', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.addComment(taskId, opts || {});
  });
  // 拖拽指派：改派受让人（可选同时推进到 ready），不启动任何进程
  handle('kanban:reassign', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.reassignTask(taskId, opts || {});
  });
  // 拖列改状态：把卡片拖进另一列（PATCH /tasks/{id}，body 只放 status）
  handle('kanban:set-status', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.setTaskStatus(taskId, opts || {});
  });
  // 拖拽派发：dry_run 预演确认队首就是这张卡片，再真派发 1 个名额
  handle('kanban:dispatch-task', async (_e, taskId, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.dispatchTask(taskId, opts || {});
  });
  handle('kanban:dispatch', async (_e, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.dispatch(opts || {});
  });
  handle('kanban:workers', async (_e, opts) => {
    if (!await ensureBackendReady()) return { ok: false, error: '后端正在启动，请稍后重试' };
    return kanban.activeWorkers(opts || {});
  });

  // 消息平台线：按用户要求保持原样，不纳入本轮改造
  ipcMain.handle('gw:status', () => serveStatus());
  ipcMain.handle('gw:overview', () => hermesGateway.overview());
  ipcMain.handle('gw:action', (_e, op) => hermesGateway.action(op));
  ipcMain.handle('gw:cli-status', () => hermesGateway.cliStatus());
  ipcMain.handle('gw:open-file', (_e, kind) => {
    const file = kind === 'env' ? profile.envFilePath() : profile.configPath();
    if (!fs.existsSync(file)) return { ok: false, error: '文件不存在：' + file };
    shell.openPath(file);
    return { ok: true, file };
  });

  handle('cfg:set', (_e, patch) => saveConfig(patch));
  handle('app:openExternal', (_e, url) => {
    if (safeExternal(url)) shell.openExternal(url);
    else log.warn('ipc', 'blocked openExternal', { url: log.redact(url) });
    return true;
  });
  handle('app:path', (_e, name) => {
    const map = { home: os.homedir(), hermesHome: profile.home(), workspace: path.join(__dirname, '..') };
    return map[name] || '';
  });

  /* 渲染层上报真实视口，主进程与窗口 frame 比对。
     窗口比视口大出 4px 以上说明内容区没跟上（典型是右侧白块），
     此时按窗口尺寸重新 setContentSize 把它拉回来。 */
  ipcMain.on('window:viewport', (event, size) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (event.sender !== mainWindow.webContents) return;
    const w = Number(size && size.width);
    const h = Number(size && size.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    const b = mainWindow.getContentBounds();
    if (b.width - w <= 4 && b.height - h <= 4) return;
    log.warn('window', 'viewport drift', { bounds: [b.width, b.height], viewport: [w, h] });
    try {
      mainWindow.setContentSize(b.width, b.height + 1);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setContentSize(b.width, b.height);
      }, 80);
    } catch (err) {
      log.warn('window', 'viewport resync failed', { err: String((err && err.message) || err) });
    }
  });

  // 插件 / 技能 / 配置（真实 hermes CLI 集成）
  const hermesPlugins = require('./services/hermes-plugins');
  const hermesSkills = require('./services/hermes-skills');
  const hermesConfig = require('./services/hermes-config');
  const hermesMarket = require('./services/hermes-market');
  hermesMarket.setEmitter((p) => safeSend('market:progress', p));
  // 插件 / 技能列表走「磁盘缓存 + 后台刷新」：刷新完成时通知渲染层原地重绘，
  // 用户先看到上次运行的结果，不必在页面里等 6–8s 的 CLI 冷启。
  hermesPlugins.setEmitter((p) => safeSend('catalog:updated', p));
  hermesSkills.setEmitter((p) => safeSend('catalog:updated', p));
  hermesTools.setEmitter((p) => safeSend('catalog:updated', p));
  hermesMcp.setEmitter((p) => safeSend('catalog:updated', p));
  handle('market:search', (_e, kind, query, opts) => hermesMarket.search(kind, query, opts || {}));
  handle('market:action', (_e, kind, op, identifier, opts) => hermesMarket.action(kind, op, identifier, opts || {}));
  handle('market:check-updates', (_e, kind) => hermesMarket.checkUpdates(kind));
  handle('plugins:list', (_e, opts) => hermesPlugins.listPlugins(opts || {}));
  handle('plugins:set-enabled', (_e, name, enabled) => hermesPlugins.setPluginEnabled(name, enabled));
  handle('skills:list', (_e, opts) => hermesSkills.listSkills(opts || {}));
  handle('skills:set-enabled', (_e, name, enabled) => hermesSkills.setSkillEnabled(name, enabled));

  // Profile 切换：串行化，避免快速连点叠加 stop/start 拉起多个后端
  handle('profile:list', () => profile.snapshot());
  let switchChain = Promise.resolve();
  let switchSeq = 0;
  handle('profile:switch', (_e, name) => {
    const my = ++switchSeq;
    const job = switchChain.then(async () => {
      if (my !== switchSeq) return { ok: false, error: '已有切换正在进行' };
      const res = profile.setCurrent(name);
      if (!res.ok || !res.changed) return res;
      // 顺序要紧：先停后端，再换 home，最后用新 profile 重新拉起
      chat.abortAll();
      chat.stopBackend();
      hermesPlugins.invalidate();
      hermesSkills.invalidate();
      hermesTools.invalidate();
      hermesMcp.invalidate();
      yamlCfg.rewatch();
      chat.startBackend();
      clearTimeout(warmTimers.plugins); clearTimeout(warmTimers.skills);
      warmTimers.plugins = setTimeout(() => { hermesPlugins.warm(); }, 500);
      warmTimers.skills = setTimeout(() => { hermesSkills.warm(); }, 1100);
      log.info('profile', `switched to ${name}`);
      return res;
    });
    switchChain = job.catch(() => {});
    return job;
  });

  // 错峰预热：timer 集中登记，退出时可清理
  app.whenReady().then(() => {
    warmTimers.plugins = setTimeout(() => { hermesPlugins.warm(); }, 1200);
    warmTimers.skills = setTimeout(() => { hermesSkills.warm(); }, 2200);
  });
  handle('hermes-config:providers', () => hermesConfig.listProviders());
  handle('hermes-config:models', () => hermesConfig.listModels());
  // 只读：把 CLI config.yaml 的默认模型 / models.json 列表一起交给渲染层。
  // 桌面端自己的 config.json 由 env.config.model 给出，两者比较出「配置漂移」。
  handle('hermes-config:model-state', () => hermesConfig.modelState());
  // 上游思考输出：只读状态 + 受控写入（display.show_reasoning）。
  // 写入是**改 CLI 配置**，只有渲染层二次确认卡的回调会调它；桌面端不自动写。
  handle('hermes-config:reasoning-display', () => hermesConfig.reasoningDisplay());
  handle('hermes-config:set-reasoning-display', (_e, on) => hermesConfig.setReasoningDisplay(on === true));
  // 看板编排：三档模式 = 两个 CLI 开关的派生值（不单独存模式，避免自相矛盾）。
  // 读走「config.yaml 原文 + 看板 REST」，写 auto_decompose 走 REST、
  // 写 dispatch_in_gateway 走 `hermes config set`（5–7s，且改完必须重启 gateway）。
  // 这是**改 CLI 配置**，只有渲染层二次确认卡的回调会调 set-mode。
  const kanbanMode = require('./services/hermes-kanban-mode').createKanbanMode({ kanban, cfg: hermesConfig });
  handle('kanban:orchestration', () => kanbanMode.read());
  handle('kanban:set-mode', (_e, mode) => kanbanMode.apply(String(mode || '')));
  // 只读诊断：白名单 key → argv，渲染层无法传任意命令 / 参数
  const diagnostics = require('./services/hermes-diagnostics');
  handle('diagnostics:run', (_e, key) => diagnostics.run(key));
  handle('diagnostics:memory-files', () => ({ ok: true, files: diagnostics.memoryFiles() }));
  // 工具集：列表走缓存（CLI 6.5–7.5s），开关后的回读仍是真 CLI；名称在服务层过白名单正则
  handle('tools:list', (_e, opts) => hermesTools.listTools(opts || {}));
  handle('tools:toggle', (_e, name, enabled) => hermesTools.setTool(name, !!enabled));
  // MCP 服务器：只读列表 / 连接测试 / 增删（增删带 UI 确认卡，服务层回读确认）
  handle('mcp:list', (_e, opts) => hermesMcp.listServers(opts || {}));
  handle('mcp:test', (_e, name) => hermesMcp.testServer(name));
  handle('mcp:add', (_e, args) => hermesMcp.addServer(args || {}));
  handle('mcp:remove', (_e, name) => hermesMcp.removeServer(name));
  // 定时任务：首屏聚合 / 运行历史 / 四类动作 / 创建（默认暂停）
  handle('cron:overview', () => hermesCron.overview());
  handle('cron:runs', (_e, jobId, limit) => hermesCron.listRuns(jobId, limit));
  handle('cron:action', (_e, op, jobId) => hermesCron.action(op, jobId));
  handle('cron:create', (_e, args) => hermesCron.create(args || {}));
  handle('hermes-config:open-file', (_e, key) => {
    const paths = hermesConfig.configPaths();
    if (!Object.prototype.hasOwnProperty.call(paths, key)) return { ok: false, error: '不允许打开该文件' };
    const file = paths[key];
    if (file && fs.existsSync(file)) { shell.openPath(file); return { ok: true, file }; }
    return { ok: false, error: '文件不存在：' + file };
  });

  // ---- 危险操作审批：把后端请求交给渲染层确认（默认拒绝，30s 超时） ----
  // 主窗口与迷你聊天窗都能表态；任一侧表决后广播 resolved，另一侧立刻把卡片收口，
  // 否则那侧 24s 的自动拒绝定时器还会再发一次（对同一 requestId 的重复表态）。
  function respondApproval(requestId, choice, tabId) {
    chat.respondApproval(requestId, choice, tabId);
    pendingApprovals = Math.max(0, pendingApprovals - 1);
    syncOrb();
    safeSend('orb:approval-resolved', { requestId, choice });
    if (orbChat) orbChat.pushApprovalResolved({ requestId, choice });
  }
  chat.setApprovalHandler((req) => {
    const toMain = safeSend('hermes:approval', req);
    let toOrb = false;
    // 刻意不抢焦点：用户可能正在别的应用里打字，抢焦点比漏看一次更烦人。
    // 球上有珊瑚色「待确认」徽标，面板里有确认卡，回来就能看到。
    if (orbChat && orbChat.isOpen()) toOrb = orbChat.pushApproval(req);
    if (!toMain && !toOrb) return false;
    pendingApprovals += 1;
    syncOrb();
    return true;
  });
  handle('hermes:approval-respond', (_e, payload) => {
    const p = payload || {};
    respondApproval(p.requestId, p.choice, p.tabId);
    return true;
  });

  /* 主窗口渲染层上报当前会话上下文（节流后的快照）。
     迷你聊天窗据此绑定「同一个会话」，主进程只做缓存、不解析内容。 */
  ipcMain.on('orb:context', (event, ctx) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    if (!ctx || typeof ctx !== 'object' || typeof ctx.tabId !== 'string' || !ctx.tabId) return;
    orbCtx = {
      tabId: ctx.tabId,
      sessionId: typeof ctx.sessionId === 'string' ? ctx.sessionId : null,
      title: typeof ctx.title === 'string' ? ctx.title.slice(0, 80) : '',
      model: typeof ctx.model === 'string' ? ctx.model.slice(0, 80) : '',
      theme: ctx.theme === 'dark' ? 'dark' : 'light',
      messages: Array.isArray(ctx.messages) ? ctx.messages.slice(-14).map((m) => ({
        role: m && m.role === 'user' ? 'user' : 'assistant',
        text: String((m && m.text) || '').slice(0, 4000),
        done: !m || m.done !== false,
      })) : [],
    };
    if (orbChat && orbChat.isOpen()) orbChat.pushSync();
  });

  // 小球模式：命令面板 / 菜单之外的第三个入口（渲染层主动收起）
  handle('orb:enter', () => enterOrb());

  // ---------------- 生命周期 ----------------
  app.whenReady().then(() => {
    createWindow();
    // 全局快捷键是 app 级资源：必须在 whenReady 之后注册，且只建一次。
    // 收起成球之后主窗口仍 hide 着，⌥⇧H 是用户找回应用的兜底（托盘图标已移除）。
    orbAccess = createOrbAccess({
      userDataDir: app.getPath('userData'),
      log,
      onHotkey: () => toggleOrbChat(),
      onModeChange: (mode) => applyOrbMode(mode),
    });
    // 睡眠唤醒 / 解锁是内容区尺寸失同步的高发点（窗口 frame 变了、view 没变）。
    // 等窗口真正回到前台再校准，避免在唤醒动画中间抖尺寸。
    try {
      powerMonitor.on('resume', () => scheduleViewportHeal('resume'));
      powerMonitor.on('unlock-screen', () => scheduleViewportHeal('unlock-screen'));
    } catch (err) {
      log.warn('window', 'powerMonitor unavailable', { err: String((err && err.message) || err) });
    }
    // Dock 图标被点时：球态下先展开主窗口。hotkey 模式的球是隐去的，
    // 所以判据要加上「主窗口本身被 hide 了」，否则点 Dock 会毫无反应。
    app.on('activate', () => {
      const hidden = mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible();
      if ((orb && orb.isVisible()) || orbActive || hidden) { leaveOrb(); return; }
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    // 显示器分辨率 / 排列变化后，窗口可能落到可见区外，重新收拢一次
    setTimeout(fitWindowToDisplay, 300);
    screen.on('display-metrics-changed', () => setTimeout(fitWindowToDisplay, 300));
    screen.on('display-removed', () => setTimeout(fitWindowToDisplay, 300));
  });
  app.on('window-all-closed', () => { chat.abortAll(); if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => {
    chat.stopBackend();
    if (orbTimer) { clearTimeout(orbTimer); orbTimer = null; }
    if (orbAccess) { orbAccess.destroy(); orbAccess = null; }
    if (orb) { orb.destroy(); orb = null; }
    if (orbChat) { orbChat.destroy(); orbChat = null; }
    try { hermesPreview.unwatch(); } catch {}
    try { yamlCfg.dispose(); } catch {}
    Object.values(warmTimers).forEach((t) => clearTimeout(t));
    log.info('app', 'will-quit: resources disposed');
  });

  // 应用菜单（生产包不暴露 DevTools 开关）
  const viewMenu = {
    label: '视图',
    submenu: [
      { role: 'reload' },
      ...(isDev || !app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
      { type: 'separator' }, { role: 'togglefullscreen' },
    ],
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Hermes', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { role: 'find' }] },
    viewMenu,
    { label: '窗口', submenu: [
      { label: '收起成小圆球', accelerator: 'CmdOrCtrl+Shift+M', click: () => enterOrb() },
      // 只写文案、不挂 accelerator：真正的全局快捷键由 globalShortcut 注册，
      // 这里再挂一次会变成「只在本应用前台生效」的第二套键位，容易互相抢。
      { label: `打开 / 收起迷你聊天窗（${ACCEL_LABEL}）`, click: () => toggleOrbChat() },
      { type: 'separator' },
      { role: 'minimize' }, { role: 'zoom' },
    ] },
  ]));
  // 第二个实例（再次双击 app）要把球态收回来，而不是去 focus 一颗球
  restoreMain = leaveOrb;
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    restoreMain();
  });
  boot();
} else {
  app.quit();
}
