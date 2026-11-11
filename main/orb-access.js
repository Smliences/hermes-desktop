'use strict';
/**
 * 小球唯一的系统级入口：全局快捷键。
 *
 * 为什么单独一个模块：globalShortcut 是 app 级资源，必须成对注册与注销，
 * 不能散在 enterOrb/leaveOrb 里随窗口开合反复 register。它只在主进程存在，
 * renderer 拿不到任何新 IPC —— 两个小窗的 preload 暴露面保持原样，
 * token / CLI / 文件接口一概不新增。
 *
 * 2026-11-11 用户要求「小圆球的托盘去掉」：菜单栏 Tray 图标整体删除。
 * 模式开关（常驻球 / 仅快捷键）与快捷键开关改由**球自己的右键菜单**承担
 * （main/orb.js 的 renderMenu，数据由 main.js 的 getPrefs/getShortcutLabel 提供），
 * 偏好仍只写 userData/orb-prefs.json。
 *
 * 模式（userData/orb-prefs.json，只写桌面端配置）：
 *   always  默认：主窗口收起后球常驻桌面（原有行为）。
 *   hotkey  仅快捷键：球不常驻，只有迷你聊天窗打开时才出现；
 *           全局快捷键随时把「球 + 小窗」一起唤起。
 */
const { globalShortcut } = require('electron');
const prefs = require('./orb-prefs');

const ACCELERATOR = 'Alt+Shift+H';
const ACCEL_LABEL = process.platform === 'darwin' ? '⌥⇧H' : 'Alt+Shift+H';

/**
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {object} opts.log
 * @param {function} opts.onHotkey      全局快捷键：开关迷你聊天窗
 * @param {function} opts.onModeChange  (mode) => void  主窗口据此显隐球
 */
function createOrbAccess(opts) {
  const log = opts.log || { info() {}, warn() {} };
  let state = prefs.load(opts.userDataDir);
  let registered = false;

  const call = (fn, ...args) => {
    if (typeof fn !== 'function') return;
    try { fn(...args); }
    catch (err) { log.warn('orb-access', 'action failed', { err: String((err && err.message) || err) }); }
  };

  /** 快捷键只注册一次；被别的程序占用时记日志，不抛给调用方 */
  function syncShortcut() {
    if (state.hotkey && !registered) {
      try {
        registered = globalShortcut.register(ACCELERATOR, () => call(opts.onHotkey));
      } catch (err) {
        registered = false;
        log.warn('orb-access', 'shortcut register threw', { err: String((err && err.message) || err) });
      }
      if (!registered) log.warn('orb-access', 'global shortcut unavailable', { accel: ACCELERATOR });
    } else if (!state.hotkey && registered) {
      try { globalShortcut.unregister(ACCELERATOR); } catch { /* 已释放 */ }
      registered = false;
    }
    return registered;
  }

  function setMode(mode) {
    if (!prefs.MODES.includes(mode)) return { ...state };
    state = prefs.save(opts.userDataDir, { mode });
    log.info('orb-access', 'mode changed', { mode: state.mode });
    call(opts.onModeChange, state.mode);
    return { ...state };
  }

  function setHotkey(on) {
    state = prefs.save(opts.userDataDir, { hotkey: !!on });
    log.info('orb-access', 'hotkey changed', { hotkey: state.hotkey });
    syncShortcut();
    return { ...state };
  }

  function destroy() {
    if (registered) {
      try { globalShortcut.unregister(ACCELERATOR); } catch { /* 已释放 */ }
      registered = false;
    }
  }

  syncShortcut();
  log.info('orb-access', 'ready', {
    mode: state.mode, hotkey: state.hotkey, registered, accel: ACCELERATOR,
  });

  return {
    prefs: () => ({ ...state }),
    setMode, setHotkey, destroy,
    shortcutRegistered: () => registered,
    accelerator: ACCELERATOR,
    shortcutLabel: ACCEL_LABEL,
  };
}

module.exports = { createOrbAccess, ACCELERATOR, ACCEL_LABEL };
