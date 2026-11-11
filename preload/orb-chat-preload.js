'use strict';
/**
 * 迷你聊天窗专用 preload。
 *
 * 刻意**不复用** preload/preload.js：这颗球弹出的小窗只需要
 * 会话内三件事（发送 / 中止 / 审批表态）+ 两件窗口事（回主窗 / 收起），
 * 拿不到 CLI、配置文件、看板、终端、导出路径，也没有 token。
 * sandbox 仍为 true、contextIsolation 仍为 true，暴露面是封闭白名单。
 */
const { contextBridge, ipcRenderer } = require('electron');

/** 订阅型通道统一收口：非法入参返回空解绑函数，避免渲染层拿到 undefined 再调用 */
function on(channel, fn) {
  if (typeof fn !== 'function') return () => {};
  const handler = (_event, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('orbChat', {
  /** 打开面板时拉一次：绑定的 tab / 会话标题 / 最近消息 / 主题 / 是否在跑 */
  bootstrap: () => ipcRenderer.invoke('orbchat:bootstrap'),
  send: (text) => ipcRenderer.invoke('orbchat:send', { text: String(text == null ? '' : text) }),
  abort: () => ipcRenderer.invoke('orbchat:abort'),
  approve: (requestId, choice) => ipcRenderer.invoke('orbchat:approve', { requestId, choice }),
  expand: () => ipcRenderer.send('orbchat:expand'),
  close: () => ipcRenderer.send('orbchat:close'),
  /** 草稿只落在主进程内存里：收起再点开不会把人写了一半的话弄丢 */
  draft: (text) => ipcRenderer.send('orbchat:draft', String(text == null ? '' : text)),
  onEvent: (fn) => on('orbchat:event', fn),
  onApproval: (fn) => on('orbchat:approval', fn),
  onApprovalResolved: (fn) => on('orbchat:approval-resolved', fn),
  onState: (fn) => on('orbchat:state', fn),
  onSync: (fn) => on('orbchat:sync', fn),
  /** 面板每次被亮出来时点一下输入框（主进程在 open() 里发，纯提示型通道） */
  onFocus: (fn) => on('orbchat:focus', fn),
});
