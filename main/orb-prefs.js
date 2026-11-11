'use strict';
/**
 * 小球的「常驻 / 仅快捷键唤起」偏好（菜单栏托盘已移除，只剩快捷键入口）。
 *
 * 红线：只写 app.getPath('userData')/orb-prefs.json，绝不碰 ~/.hermes、
 * 不碰 CLI 的 config.yaml / current 指针。纯 fs + 严格白名单，文件损坏或
 * 被塞了非法值一律回默认，不能因为一个坏配置文件把桌面入口弄丢。
 *
 * 这个模块刻意不 require('electron')：可以在零依赖的 Node 单测里直接跑。
 */
const fs = require('fs');
const path = require('path');

const FILE = 'orb-prefs.json';
const MODES = ['always', 'hotkey'];
const DEFAULTS = { mode: 'always', hotkey: true };

function prefsPath(userDataDir) { return path.join(userDataDir, FILE); }

/** 只认两个枚举值 + 布尔开关，其余字段一律丢弃（不允许渲染层塞任意结构） */
function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: MODES.includes(o.mode) ? o.mode : DEFAULTS.mode,
    hotkey: typeof o.hotkey === 'boolean' ? o.hotkey : DEFAULTS.hotkey,
  };
}

function load(userDataDir) {
  try { return normalize(JSON.parse(fs.readFileSync(prefsPath(userDataDir), 'utf8'))); }
  catch { return { ...DEFAULTS }; }
}

/** 写失败（只读 userData / 磁盘满）也要返回内存里的规范态，不让球菜单崩掉 */
function save(userDataDir, patch) {
  const incoming = patch && typeof patch === 'object' ? patch : {};
  const next = normalize({ ...load(userDataDir), ...incoming });
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(prefsPath(userDataDir), JSON.stringify(next, null, 2));
  } catch { /* 内存态照常生效 */ }
  return next;
}

module.exports = { load, save, normalize, prefsPath, MODES, DEFAULTS, FILE };
