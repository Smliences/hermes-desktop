'use strict';
/**
 * 小球窗口的渲染逻辑：拖动 / 点击判定 / 状态点。
 *
 * 拖动不用 `-webkit-app-region: drag`：透明窗口上它会把 click 一起吞掉，
 * 表现是「能拖但点不开」。这里自己算窗口左上角的屏幕坐标，通过 IPC 让
 * 主进程 setPosition，指针事件全程留在页面里，点击与拖动可以干净区分。
 *
 * 点一下球 = 弹出旁边的迷你聊天窗（再点收起），不会恢复主窗口；
 * 要整个窗口回来，走球的右键菜单。
 */
const orb = window.orbAPI;
const ball = document.getElementById('orb-ball');
const badge = document.getElementById('orb-badge');
const caret = document.getElementById('orb-caret');

const DRAG_THRESHOLD = 4;   // px：小于这个距离算手抖，不算拖动
const CLICK_MS = 350;       // ms：按住超过这个时长不算点击

let press = null;

ball.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  try { ball.setPointerCapture(event.pointerId); } catch { /* 老版本不支持 */ }
  press = {
    // screenX - clientX 得到的是**窗口左上角的屏幕坐标**（窗口原点），
    // 不是「指针在窗口内的抓取偏移」。曾经把它当成抓取偏移、移动时用
    // screenX - offX 算目标，结果窗口在屏幕右侧时 x 被算成 126，
    // 球一拖就飞到左上角。拖动一律用「原点 + 指针物理位移」的增量式。
    winX: event.screenX - event.clientX,
    winY: event.screenY - event.clientY,
    sx: event.screenX,
    sy: event.screenY,
    at: performance.now(),
    moved: 0,
    raf: 0,
    next: null,
  };
  ball.classList.add('is-dragging');
});

ball.addEventListener('pointermove', (event) => {
  if (!press) return;
  press.moved = Math.max(press.moved, Math.hypot(event.screenX - press.sx, event.screenY - press.sy));
  if (press.moved < DRAG_THRESHOLD) return;
  // 增量式：窗口原点 + 指针自按下以来的屏幕位移。
  // 不用 clientX 是因为窗口一旦跟着移动，clientX 会随窗口一起变；
  // 也不依赖 screenX/clientX 的坐标系跨帧保持一致，窗口没跟上时也不会累积漂移。
  press.next = {
    x: Math.round(press.winX + (event.screenX - press.sx)),
    y: Math.round(press.winY + (event.screenY - press.sy)),
  };
  // 一帧只发一次：指针事件可能一秒上百个，逐条 setPosition 会卡
  if (press.raf) return;
  press.raf = requestAnimationFrame(() => {
    if (!press) return;
    press.raf = 0;
    if (press.next) orb.drag(press.next.x, press.next.y);
  });
});

function endPress(event) {
  if (!press) return;
  const p = press;
  press = null;
  if (p.raf) cancelAnimationFrame(p.raf);
  ball.classList.remove('is-dragging');
  try { ball.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }

  // 手势被系统取消（切窗口 / 系统手势接管）：不能当成一次点击弹出小窗
  if (event.type === 'pointercancel') { orb.dragEnd(); return; }
  // pointerup 偶尔不带屏幕坐标，别把缺失的 0 当成一个巨大位移
  const dx = !Number.isFinite(event.screenX) ? 0 : event.screenX - p.sx;
  const dy = !Number.isFinite(event.screenY) ? 0 : event.screenY - p.sy;
  const moved = Math.max(p.moved, Math.hypot(dx, dy));
  if (moved >= DRAG_THRESHOLD || performance.now() - p.at > CLICK_MS) {
    orb.dragEnd();
    return;
  }
  // 点一下：弹出（或收起）旁边的迷你聊天窗，不动主窗口
  orb.click();
}

ball.addEventListener('pointerup', endPress);
ball.addEventListener('pointercancel', endPress);

// 键盘可达：Enter / Space 等于点一下；↓ / 菜单键打开 Profile 下拉
ball.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ContextMenu') {
    event.preventDefault(); orb.menu(); return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  orb.click();
});

// 球底的小箭头是「下拉」的可视入口：它不走 ball 的 pointerdown 拖动链路，
// 也不会被判成一次点击（点箭头只弹菜单，不开关迷你聊天窗）。
if (caret && caret.addEventListener) {
  caret.addEventListener('pointerdown', (event) => { event.stopPropagation(); event.preventDefault(); });
  caret.addEventListener('click', (event) => { event.stopPropagation(); orb.menu(); });
}

ball.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  event.stopPropagation();
  orb.menu();
});

// 拖拽时不要触发原生文本选择 / 图片拖影
document.addEventListener('dragstart', (event) => event.preventDefault());

/* ---------------- 状态：idle / busy / approval / offline + 小窗开合 ----------------
   状态由主进程推导后整包推过来。这里除了画视觉，还要把同一份信息喂给
   辅助技术：52px 的球没有文字，读屏用户只能靠 aria-label / aria-live 知道
   「正在回复」「有 3 条待审批」「聊天窗已展开」。 */

const STATES = new Set(['busy', 'approval', 'offline']);
const STATE_TEXT = {
  idle: '空闲',
  busy: '正在回复',
  approval: '有危险操作待审批',
  offline: '后端已断开',
};
const live = document.getElementById('orb-live');

orb.onStatus((status) => {
  const s = status || {};
  const state = STATES.has(s.state) ? s.state : 'idle';
  const count = Number(s.count) || 0;
  const open = s.open === true;

  document.body.dataset.state = state;
  document.body.dataset.open = open ? 'true' : 'false';

  if (state === 'approval' && count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.hidden = false;
  } else {
    badge.textContent = '';
    badge.hidden = true;
  }

  ball.setAttribute('aria-pressed', open ? 'true' : 'false');
  const label = open ? '收起迷你聊天窗' : '展开迷你聊天窗';
  ball.setAttribute('aria-label', label);
  ball.title = label + ' · 可拖动';

  let spoken = STATE_TEXT[state];
  if (state === 'approval' && count > 0) spoken += `，${count} 条`;
  if (open) spoken += '，迷你聊天窗已展开';
  // 主进程每 5s 对一次状态；文本没变就不要重复播报
  if (live.textContent !== spoken) live.textContent = spoken;
});
