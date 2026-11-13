/**
 * renderer/modules/kanban-state.js —— 看板的状态词汇表与共享状态树
 *
 * 这一层没有任何 DOM 与 IPC：全是常量表（9 个 CLI 状态 → 5 组中文列、列 → 落地状态、
 * 可拖拽状态集合）加上一份共享状态树 KB 与拖拽状态 KbDrag，以及几个只读时间格式函数。
 * 看板的渲染层（kanban-view / kanban-detail）和外壳（app.js 的 rail）都只读这里。
 *
 * 从 app.js 的整体看板块中拆出，行为零变化。
 */
import { api } from './state.js';

/** `kbSelectSig` 是可变的模块级绑定（换板 / 写后回读都要作废下拉缓存）。
 *  模块导出的是只读绑定，跨模块写要通过这个引用对象。 */
export const kbSelectSigRef = {
  get v() { return kbSelectSig; },
  set v(x) { kbSelectSig = x; },
};

/* ---- 状态归组：9 个 CLI 状态 → 5 个中文列 ----
   归组只影响「看」的粒度，不改任何状态：卡片上的细 chip 仍是 CLI 原值。
   ① scheduled 归「待办」而不是「受阻」：受阻是等人（需要人动手），scheduled 是
     等时间（不需要人动手），塞进同一列会把「受阻」计数顶高，把人叫去处理本来
     不该碰的任务。
   ② archived 不进 5 列：它由「显示已归档」开关单独控制，打开时追加为最后一列，
     否则「已完成」的计数会跟着归档一起虚高，两套开关还会互相打架。 */
export const KB_GROUPS = Object.freeze([
  { key: 'todo', label: '待办', statuses: ['triage', 'todo', 'scheduled'], dot: 'yellow',
    hint: '还没开始跑：收集箱、等依赖，或已排期在等时间' },
  { key: 'ready', label: '就绪', statuses: ['ready'], dot: 'accent',
    hint: '依赖满足且已指派，调度器随时可能认领派发' },
  { key: 'running', label: '进行中', statuses: ['running', 'review'], dot: 'green',
    hint: 'worker 正在执行，或已跑完待验收' },
  { key: 'blocked', label: '受阻', statuses: ['blocked'], dot: 'red',
    hint: '需要人工介入：等人确认或等外部事件' },
  { key: 'done', label: '已完成', statuses: ['done'], dot: 'muted',
    hint: '已完成，不再参与派发' },
]);
export const KB_GROUP_ARCHIVED = Object.freeze({
  key: 'archived', label: '已归档', statuses: ['archived'], dot: 'muted',
  hint: '已归档，只在开启「显示已归档」时出现',
});
/** 细粒度状态的中文短名：卡片 chip 用它，title 里保留 CLI 原值。 */
export const KB_STATUS_LABEL = Object.freeze({
  triage: '收集箱', todo: '待办', scheduled: '已排期', ready: '就绪',
  running: '运行中', blocked: '受阻', review: '待验收', done: '已完成', archived: '已归档',
});
/** 允许拖拽改派的状态。running 要先 reclaim 才能换人，done / archived 再派发没有意义。 */
export const KB_DRAGGABLE = Object.freeze(['triage', 'todo', 'scheduled', 'ready', 'blocked', 'review']);
/** 拖拽源比改派宽两档：running 要能拖出去（卡在运行中的任务很常见，得能强制收尾），
 *  done 要能拖回去重开（reopen）；archived 不给拖 —— CLI 侧归档单向，误拖没有回退口。
 *  注意 running 只在**拖列**里放行：拖到 profile chip 上仍按改派处理并被拒。 */
export const KB_DRAG_SOURCE = Object.freeze([...KB_DRAGGABLE, 'running', 'done']);
/** 列 → 落地状态。这 5 个都是 CLI 认的状态动词（PATCH /tasks/{id} 的 status）：
 *  「进行中」列落 review —— 人不能把任务直接设成 running（只能调度器认领），
 *  能做的只有「提交待验收」，语义上也正好落在这一列。 */
export const KB_GROUP_STATUS = Object.freeze({
  todo: 'todo', ready: 'ready', running: 'review', blocked: 'blocked', done: 'done',
});
/** 松手提示与 toast 共用的动作文案。 */
export const KB_STATUS_ACTION = Object.freeze({
  todo: '放回待办', ready: '提到就绪', review: '提交待验收', blocked: '标记受阻', done: '标记完成',
});
/** 渲染层能请求的落地状态集合（= 上表的取值），拖拽入口据此做最后一道校验。 */
export const KB_STATUS_SETTABLE = Object.freeze(Object.values(KB_GROUP_STATUS));
/** 指针拖拽的共享状态（一次只有一个拖动中的卡片）。 */
export const KbDrag = {
  armed: false, on: false, id: '', title: '', status: '',
  x0: 0, y0: 0, card: null, ghost: null, target: null, col: null, suppressClick: false,
  gh: 0, vel: 0, raf: 0,
};
export const KB = {
  epoch: 0, detailEpoch: 0, timer: null, busy: false,
  board: null, overview: null, detail: null, detailId: '',
  lastEventId: 0, error: '',
  // 默认列视图：5 组固定成列，一屏看清全貌；网格视图留给窄主区（⋯ 菜单里切）
  view: 'cols', status: '', modal: '', modalKey: '', modalBusy: false,
  dispatch: { open: false, busy: false, epoch: 0 },
  // 拆解会调用辅助模型（计费、最长 3 分钟）：全局只允许一次在途，防重复计费
  decomposeBusy: false,
  // 补规格同样是计费 + 改数据（会把卡推出收集箱），一次只跑一个
  specifyBusy: false,
  // 估算只读、最便宜，但也要防连点；结果按 taskId 缓存，重开抽屉不用再算一遍
  estimateBusy: false, estimate: {},
  filters: { q: '', assignee: '', tenant: '', archived: false, board: '' },
  // 页头那枚只读模式标记的数据（null = 还没读到 / 读不到，此时不显示）
  mode: null,
  // 官方 project-dialog 的本地等价状态：一次选择可以带回多个文件夹，第一个为主；
  // projectDialog 记录 create / rename / add-folder 三种模式共用的目标项目。
  projFolders: [], projectDialog: null, delProject: null,
};
export let kbSelectSig = '';

/* 看板 API 的取用口。不再用 hasNative 拦：Demo 模式的 mock-bridge 已经实现了
   全部看板方法与演示数据，能不能用应该按「这个桥有没有 kanbanBoard」判断，
   否则浏览器预览一打开就是「Demo 模式没有本地看板数据」。 */
export const kbApi = () => (api && typeof api.kanbanBoard === 'function' ? api : null);
export function kbParams() {
  const f = KB.filters;
  const p = { includeArchived: !!f.archived };
  if (f.board) p.board = f.board;
  if (f.tenant) p.tenant = f.tenant;
  return p;
}
export function kbTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n < 1e12 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function kbAgo(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - (n < 1e12 ? n : n / 1000)));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  return Math.floor(sec / 86400) + ' 天前';
}
export function kbFullTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n < 1e12 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
