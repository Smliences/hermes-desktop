/**
 * renderer/modules/state.js —— 共享状态与 IPC 桥
 *
 * 整个渲染层只有这一份「会话 / 页签 / 配置」状态，和唯一的 IPC 取用口 `api`。
 * 模块化之后这些不能再靠全局变量传递，所以统一放这里，谁需要谁 import。
 * 约定：这里只放数据与最薄的访问器，不放渲染逻辑（避免所有模块都依赖渲染）。
 */

/** 页面级状态树：页签、当前视图、会话列表、启动阶段标记、待附加文件。 */
export const state = {
  tabs: [], activeTabId: null, view: 'chat',
  turnTab: new Map(),
  invalidTurns: new Set(),   // 已中止回合的 turnId：延迟到达的事件直接丢弃
  env: null, config: { model: '', reasoning: 'none', yolo: false },
  sessions: [], sendHistory: [], histIdx: -1,
  projectsTree: [],         // 侧栏项目树投影（/api/profiles/projects/tree，降级为 []）
  projectsTreeOk: false,    // 树请求是否成功；后端冷启慢于首屏时由 ensureSidebarTree 重试
  booted: false,            // 会话列表是否已成功落地过一次（false = 首屏骨架 + 后端启动提示）
  bootError: '',            // 首屏拉取失败的原因（骨架里显示，便于区分「慢」和「挂了」）
  attachments: [],           // [{ path, name, kind }] 本回合待附加的本地文件
};

// Electron 真机走 preload 暴露的 hermesAPI；浏览器直开 index.html 时走 mock-bridge 的演示桥。
// 注意 hasNative 必须在这里定版：后续大量分支用它决定「走 IPC 还是走演示数据」。
export const hasNative = typeof hermesAPI !== 'undefined';
export const api = hasNative ? hermesAPI : window.__mockAPI;

/** 页签工厂与查找（新建 / 激活 / 关闭的渲染副作用仍在各自的域里）。 */
export function activeTab() { return state.tabs.find((t) => t.id === state.activeTabId); }