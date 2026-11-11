'use strict';
/**
 * 小球窗口专用 preload。
 *
 * 刻意**不复用** preload/preload.js：那颗球只需要四个动作（拖动、松开、
 * 恢复主窗口、右键菜单），拿不到任何 CLI / 会话 / 配置接口，也没有 token。
 * 沙箱仍是 true + contextIsolation true，暴露面是一个封闭白名单。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbAPI', {
  drag: (x, y) => ipcRenderer.send('orb:drag', { x: Number(x), y: Number(y) }),
  dragEnd: () => ipcRenderer.send('orb:dragend'),
  /** 点一下球 = 开关旁边的迷你聊天窗（不恢复主窗口） */
  click: () => ipcRenderer.send('orb:click'),
  restore: () => ipcRenderer.send('orb:restore'),
  menu: () => ipcRenderer.send('orb:menu'),
  onStatus: (fn) => {
    if (typeof fn !== 'function') return () => {};
    const handler = (_event, status) => fn(status);
    ipcRenderer.on('orb:status', handler);
    return () => ipcRenderer.removeListener('orb:status', handler);
  },
});
