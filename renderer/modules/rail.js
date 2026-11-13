/**
 * renderer/modules/rail.js —— 右侧 rail 的页签状态（预览 | 看板）
 *
 * rail 是一个横跨两个域的外壳：预览需要它「当前是不是预览」，看板需要它
 * 「当前是不是看板」来决定轮询开停。所以页签状态放这里，两个域都 import 它，
 * 谁也不 import 谁 —— 避免 kanban ↔ preview 的循环依赖。
 *
 * 面板渲染（renderRailKanban / pv*）仍由各域实现，这里只登记回调。
 */
import { $ } from './utils.js';

/** 当前 rail 页签：'preview' | 'kanban'。 */
let railTab = 'preview';

/** 活变量出口：模块导出的是只读绑定，跨模块读写都要经过这个对象。 */
export const RAIL_TAB_REF = {
  get: () => railTab,
  set: (v) => { railTab = v; },
};

export function railTabNow() { return railTab; }

/** 看板域初始化时登记：切到看板页签时要做的渲染/拉数/开轮询。 */
export const railKanbanHooks = { onShow: () => {}, onHide: () => {} };

/** 看板页签是否被看见（rail 展开且选中看板）。 */
export function railKanbanVisible() {
  const rail = $('#rail');
  return !!rail && !rail.hidden && railTab === 'kanban';
}
/** 整页看板或 rail 看板，任一可见即为 true（决定轮询要不要继续跑）。 */
export function kanbanAnyVisible() {
  const page = $('#kanban-page');
  return (!!page && !page.hidden) || railKanbanVisible();
}