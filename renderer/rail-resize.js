/* 右侧 rail（预览 | 终端）左缘调宽 —— 独立增强层，零依赖。
   只写一个 CSS 变量 --rail-w，不触碰任何已定版的几何；默认仍是 400px。
   rail 没有 zoom，指针位移就是布局 px；方向与左侧栏相反：向左拖 = 面板变宽。
   iframe 是跨文档，会吞掉 pointermove，所以用 pointer capture + 拖拽期禁用 iframe 命中。 */
(function () {
  'use strict';
  const RAIL_MIN = 280;
  const RAIL_MAX = 760;
  const RAIL_DEFAULT = 400;
  const MIN_MAIN = 420;   // 主区最小可读宽度，再窄就交给既有 compact 降级
  const KEY = 'rail-width';

  const rail = document.getElementById('rail');
  const main = document.getElementById('main');
  const handle = document.getElementById('rail-resize');
  if (!rail || !main || !handle) return;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const readW = () => parseFloat(rail.style.getPropertyValue('--rail-w')) || RAIL_DEFAULT;

  /** 上限随窗口实时变化：可用宽度 = rail + main（这样不必换算侧栏的 zoom 1.1）。
   *  panel 隐藏时量不到尺寸，退回绝对上限，避免启动时把用户偏好砍掉。 */
  function limits() {
    if (rail.hidden) return { min: RAIL_MIN, max: RAIL_MAX };
    const avail = rail.getBoundingClientRect().width + main.getBoundingClientRect().width;
    if (!avail) return { min: RAIL_MIN, max: RAIL_MAX };
    return {
      min: RAIL_MIN,
      max: Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(avail - MIN_MAIN))),
    };
  }
  let lim = limits();

  function setW(w, persist) {
    const v = Math.round(clamp(w, lim.min, lim.max));
    rail.style.setProperty('--rail-w', v + 'px');
    handle.setAttribute('aria-valuenow', String(v));
    handle.setAttribute('aria-valuemax', String(lim.max));
    handle.setAttribute('aria-valuetext', v + ' 像素');
    if (persist) {
      try { localStorage.setItem(KEY, String(v)); } catch (err) { /* 隐私模式下忽略 */ }
    }
    return v;
  }

  // 恢复偏好：rail 启动时通常 hidden，此时只做 280–760 的静态校验
  let saved = NaN;
  try { saved = parseFloat(localStorage.getItem(KEY)); } catch (err) { /* 忽略 */ }
  setW(isFinite(saved) && saved > 0 ? saved : RAIL_DEFAULT, false);

  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return; // 触摸留给滚动手势
    lim = limits();
    drag = { id: e.pointerId, x: e.clientX, w: readW() };
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件可能无活跃指针 */ }
    document.body.classList.add('rail-resizing');
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // 面板贴右边缘：向左拖 100px → 400 + 100 = 500
    setW(drag.w - (e.clientX - drag.x), false);
    e.preventDefault();
  });
  function endDrag(e) {
    if (!drag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== drag.id) return;
    drag = null;
    document.body.classList.remove('rail-resizing');
    setW(readW(), true); // 结束即落盘，避免拖完立刻退出丢宽度
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);

  // 键盘等价操作：← 变宽 / → 变窄（Shift 加速）、Home/End 到边界、Enter 复位。
  // 手柄是 focusable separator，aria-valuenow 由 setW 同步更新，读屏能播报。
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); handle.blur(); return; }
    lim = limits();
    const step = e.shiftKey ? 48 : 16;
    let target;
    if (e.key === 'ArrowLeft') target = readW() + step;
    else if (e.key === 'ArrowRight') target = readW() - step;
    else if (e.key === 'Home') target = lim.min;
    else if (e.key === 'End') target = lim.max;
    else if (e.key === 'Enter') target = RAIL_DEFAULT;
    else return;
    e.preventDefault();
    e.stopPropagation();
    setW(target, true);
  });
  handle.addEventListener('dblclick', (e) => {
    e.preventDefault();
    lim = limits();
    setW(RAIL_DEFAULT, true);
  });

  /** 窗口变窄 / rail 重新打开时收紧到合法范围，但不覆盖用户存下的偏好。 */
  function revalidate() {
    if (drag) return;
    lim = limits();
    setW(readW(), false);
  }
  window.addEventListener('resize', revalidate);
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(revalidate).observe(rail, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
