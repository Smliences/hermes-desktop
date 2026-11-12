'use strict';
/* ═══════════ Hermes Desktop — UI 冒烟（npm run test:ui） ═══════════
 * 把「CDP + Demo 页」的交互冒烟固化成可重跑脚本，零外部依赖（ws 已在 dependencies）。
 * 原理：本地 http.server 起 renderer/（命中 mock-bridge.js，不碰真 CLI），
 *       headless Chrome 开 CDP，用 Runtime.evaluate 断言 + Input.dispatchMouseEvent
 *       发真指针事件（拖列必须真指针，合成的 pointerdown 不会触发 Pointer Events 链）。
 * 覆盖场景：
 *   S1 看板加载与列结构          S2 抽屉动作（估算/补规格/确认卡）
 *   S3 抽屉「移到」行（新）      S4 拖列改状态（真指针 + running 强制确认 + 同列短路）
 *   S5 评论（空拒/确认/发布）    S6 半自动模式拆解按钮（待办②实证）
 *   S7 轻浮层菜单键盘导航（新）  S8 深色主题对比度
 *   S9 内联指令菜单（/ 起手）+ 新会话落地页（问候/chip/无匹配不误发）
 * Chrome 不在默认路径时用 HERMES_UI_CHROME 指定；找不到 Chrome 则 SKIP（exit 0），
 * 因为它只服务本机交互回归，不作为 CI 硬闸。 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const RENDERER = path.join(__dirname, '..', 'renderer');
const CHROME_CANDIDATES = [
  process.env.HERMES_UI_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 断言收集 ---------- */
const results = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : `  ← ${detail}`));
}

/* ---------- 静态服务（只读 renderer/，命中 mock-bridge） ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
function startServer() {
  return new Promise((res) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(RENDERER, rel);
      if (!file.startsWith(RENDERER) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

/* ---------- CDP 连接 ---------- */
async function connect(port, url) {
  const child = spawn(CHROME_BIN, ['--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), 'hermes-ui-' + Date.now())}`,
    '--window-size=1440,900', url], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((x) => x.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* chrome 还没起来 */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) { try { child.kill('SIGKILL'); } catch {} throw new Error('CDP 连不上'); }
  const ws = new WebSocket(wsUrl);
  let seq = 0; const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  });
  await new Promise((r) => ws.on('open', r));
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++seq; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || expression));
    return r.result.value;
  };
  return { child, ws, send, ev, close: () => { try { ws.close(); } catch {} try { child.kill('SIGKILL'); } catch {} } };
}
const key = (cdp, k, vk) => Promise.all([
  cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk }),
  cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }),
]);
const shot = async (cdp, file) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(os.tmpdir(), file), Buffer.from(r.data, 'base64'));
};

let CHROME_BIN = null;

(async () => {
  CHROME_BIN = CHROME_CANDIDATES.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (!CHROME_BIN) { console.log('SKIP：找不到 Chrome（可用 HERMES_UI_CHROME 指定路径），UI 冒烟不作为硬闸'); process.exit(0); }

  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}/index.html`;
  const cdp = await connect(9300 + Math.floor(Math.random() * 400), base);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: base }); await sleep(2600);
  for (let i = 0; i < 40; i++) { if (await cdp.ev(`typeof state === 'object'`)) break; await sleep(200); }
  await cdp.ev(`(showKanban(true), 1)`); await sleep(1500);
  const cols = () => cdp.ev(`[...document.querySelectorAll('.kb-col')].map((c) => [c.dataset.group, c.querySelectorAll('.kb-card').length])`);
  const statusOf = (id) => cdp.ev(`(() => { const t = (KB.board.columns || []).flatMap((c) => c.tasks || []).find((x) => x.id === ${JSON.stringify(id)}); return t ? t.status : 'missing'; })()`);

  /* S1 看板加载 */
  console.log('\nS1 看板加载与列结构');
  const s1 = await cols();
  ok('五个固定列都在且不窄于归档列的挤窄布局', Array.isArray(s1) && s1.length >= 5, JSON.stringify(s1));
  ok('总卡数 > 0（mock 板有数据）', s1.reduce((a, [, n]) => a + n, 0) > 0, JSON.stringify(s1));

  /* S2 抽屉动作：估算 / 补规格 / 确认卡 */
  console.log('\nS2 抽屉动作（估算 / 补规格 / 确认卡）');
  await cdp.ev(`openKanbanTask('t_demo01')`); await sleep(900);
  const s2a = await cdp.ev(`({ spec: !!document.querySelector('[data-kb-specify]'), est: !!document.querySelector('[data-kb-estimate]'), dec: !!document.querySelector('[data-kb-decompose]'), move: !!document.querySelector('#kbd-actions-move') })`);
  ok('triage 任务抽屉：补规格 / 估算 / 拆解 / 移到 四组入口都在', s2a.spec && s2a.est && s2a.dec && s2a.move, JSON.stringify(s2a));
  await cdp.ev(`document.querySelector('[data-kb-estimate]').click()`); await sleep(400);
  const s2b = await cdp.ev(`(() => { const c = document.querySelector('#kbd-actions-estimate .op-confirm'); return c ? c.querySelector('.op-confirm-cmd').textContent : null; })()`);
  ok('估算确认卡带命令预览（POST …/estimate）', /POST .*\/estimate/.test(String(s2b)), String(s2b));
  await cdp.ev(`(() => { const b = [...document.querySelectorAll('#kbd-actions-estimate .op-confirm button')].find((x) => x.textContent.includes('开始估算')); if (b) b.click(); return !!b; })()`);
  await sleep(1300);
  const s2c = await cdp.ev(`(document.querySelector('#kbd-estimate-note') || {}).textContent || ''`);
  ok('估算结果内联显示（复杂度 S/M/L + token 量级）', /(S|M|L)/.test(s2c) && /tokens|tok/.test(s2c), s2c);
  await cdp.ev(`document.querySelector('[data-kb-specify]').click()`); await sleep(400);
  await cdp.ev(`(() => { const b = [...document.querySelectorAll('#kbd-actions-specify .op-confirm button')].find((x) => x.textContent.includes('开始补规格')); if (b) b.click(); return !!b; })()`);
  await sleep(1600);
  ok('补规格后 triage → todo（CLI 顺手推进）', (await statusOf('t_demo01')) === 'todo', await statusOf('t_demo01'));

  /* S3 抽屉「移到」行 */
  console.log('\nS3 抽屉「移到」行（拖列之外的第二条改状态路径）');
  const s3a = await cdp.ev(`(() => { const row = document.querySelector('#kbd-actions-move'); if (!row) return null;
    return { verbs: [...row.querySelectorAll('[data-kb-move]')].map((b) => b.getAttribute('data-kb-move')), labels: [...row.querySelectorAll('[data-kb-move]')].map((b) => b.textContent) }; })()`);
  ok('「移到」行有 4 个目标（排除当前所在列「待办」）',
    s3a && s3a.verbs.length === 4 && !s3a.verbs.includes('todo'), JSON.stringify(s3a));
  ok('目标动词是 KB_GROUP_STATUS 的值（todo/ready/review/blocked/done）',
    s3a && s3a.verbs.every((v) => ['todo', 'ready', 'review', 'blocked', 'done'].includes(v)), JSON.stringify(s3a && s3a.verbs));
  const colsBefore = await cols();
  await cdp.ev(`(() => { const b = [...document.querySelectorAll('#kbd-actions-move [data-kb-move]')].find((x) => x.getAttribute('data-kb-move') === 'ready'); if (b) b.click(); return !!b; })()`);
  await sleep(1400);
  ok('点「就绪」→ 任务进 ready（写后回读 + 抽屉刷新）', (await statusOf('t_demo01')) === 'ready', await statusOf('t_demo01'));
  const colsAfter = await cols();
  const readyDelta = (colsAfter.find(([g]) => g === 'ready') || [0, 0])[1] - (colsBefore.find(([g]) => g === 'ready') || [0, 0])[1];
  ok('就绪列计数 +1', readyDelta === 1, JSON.stringify({ colsBefore, colsAfter }));

  /* S4 拖列改状态（真指针） */
  console.log('\nS4 拖列改状态（真指针）');
  // 抽屉开着时 kb-drawer-mask 会盖住列区，第一下按压会被遮罩吞掉 —— 先关抽屉
  await cdp.ev(`(closeKanbanDrawer(), 1)`); await sleep(400);
  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent',
    { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const center = async (sel) => cdp.ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(60, r.height / 2)) }; })()`);
  const drag = async (fromSel, toSel) => {
    const a = await center(fromSel), b = await center(toSel);
    if (!a || !b) return null;
    await mouse('mousePressed', a.x, a.y); await sleep(60);
    await mouse('mouseMoved', a.x + 12, a.y + 6); await sleep(60);
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', Math.round(a.x + (b.x - a.x) * i / 6), Math.round(a.y + (b.y - a.y) * i / 6));
      await sleep(40);
    }
    await sleep(120);
    return { a, b, during: await cdp.ev(`({ over: [...document.querySelectorAll('.kb-col.over')].map((c) => c.dataset.group), hint: (document.querySelector('#kb-dock-hint') || {}).textContent })`) };
  };
  const d1 = await drag('.kb-card[data-kb-task="t_demo02"]', '.kb-col[data-group="ready"]');
  ok('拖拽中：落点列高亮 + 松手提示', d1 && d1.during.over.includes('ready') && /就绪/.test(d1.during.hint), JSON.stringify(d1 && d1.during));
  await shot(cdp, 'hermes-ui-drag-over.png');
  await mouse('mouseReleased', d1.b.x, d1.b.y); await sleep(1100);
  ok('待办卡片拖进就绪列 → status=ready', (await statusOf('t_demo02')) === 'ready', await statusOf('t_demo02'));
  const d2 = await drag('.kb-card[data-kb-task="t_demo04"]', '.kb-col[data-group="done"]');
  await mouse('mouseReleased', d2 ? d2.b.x : 0, d2 ? d2.b.y : 0); await sleep(600);
  const s4c = await cdp.ev(`(() => { const c = document.querySelector('#kb-dock-confirm .op-confirm'); return c ? { cmd: c.querySelector('.op-confirm-cmd').textContent, btn: [...c.querySelectorAll('button')].map((b) => b.textContent).join('|') } : null; })()`);
  ok('运行中拖出 → 过「强制」确认卡', s4c && /status.*done|"status":"done"/.test(s4c.cmd) && s4c.btn.includes('强制标为完成'), JSON.stringify(s4c));
  await shot(cdp, 'hermes-ui-drag-force.png');
  await cdp.ev(`(() => { const b = [...document.querySelectorAll('#kb-dock-confirm button')].find((x) => x.textContent.includes('强制标为完成')); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
  ok('确认后 running → done', (await statusOf('t_demo04')) === 'done', await statusOf('t_demo04'));
  const sameBefore = await cdp.ev(`KB.board.columns.flatMap((c) => c.tasks || []).filter((t) => t.status === 'todo').length`);
  const d3 = await drag('.kb-card[data-kb-task="t_demo01"]', '.kb-col[data-group="ready"]');
  await mouse('mouseReleased', d3 ? d3.b.x : 0, d3 ? d3.b.y : 0); await sleep(700);
  const s4e = await cdp.ev(`(document.querySelector('#kb-dock-msg') || {}).textContent || ''`);
  ok('同列拖拽短路（已是就绪，不写库）', /已经是/.test(s4e), s4e);

  /* S5 评论 */
  console.log('\nS5 评论（空拒 / 确认卡 / 发布）');
  await cdp.ev(`openKanbanTask('t_demo02')`); await sleep(900);
  const cBefore = await cdp.ev(`document.querySelectorAll('#kb-drawer-body .kbd-list .kbd-row').length`);
  await cdp.ev(`(() => { const ta = document.querySelector('#kbd-comment-input'); ta.value = '   '; document.querySelector('[data-kb-comment]').click(); return !!document.querySelector('#kb-drawer-body .op-confirm'); })()`);
  const s5a = await cdp.ev(`!!document.querySelector('#kb-drawer-body .op-confirm')`);
  ok('空白输入本地拒（不出确认卡）', s5a === false, String(s5a));
  await cdp.ev(`(() => { const ta = document.querySelector('#kbd-comment-input'); ta.value = 'test:ui 冒烟评论'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-kb-comment]').click(); return 1; })()`);
  await sleep(500);
  const s5b = await cdp.ev(`(() => { const c = document.querySelector('#kb-drawer-body .op-confirm'); return c ? c.querySelector('.op-confirm-cmd').textContent : null; })()`);
  ok('评论确认卡带端点预览（POST …/comments）', /POST .*\/comments/.test(String(s5b)), String(s5b));
  await cdp.ev(`(() => { const b = document.querySelector('#kb-drawer-body .op-confirm .mk-btn.primary'); if (b) b.click(); return !!b; })()`);
  await sleep(1400);
  const s5c = await cdp.ev(`(() => ({ rows: document.querySelectorAll('#kb-drawer-body .kbd-list .kbd-row').length, hit: [...document.querySelectorAll('#kb-drawer-body .kbd-list .kbd-row')].some((r) => r.textContent.includes('test:ui')), cleared: !(document.querySelector('#kbd-comment-input') || {}).value }))()`);
  ok('发布后列表 +1、内容出现、输入框清空', s5c.rows === cBefore + 1 && s5c.hit && s5c.cleared, JSON.stringify(s5c));

  /* S6 半自动模式拆解按钮（待办②实证） */
  console.log('\nS6 半自动模式拆解按钮');
  const s6a = await cdp.ev(`(async () => {
    kbModeChip({ ok: true, mode: 'semi', modeLabel: '半自动' });
    await api.kanbanCreateTask({ title: '冒烟-半自动拆解', body: '', status: 'triage', priority: 0 });
    await kanbanLoad(true);
    const t = (KB.board.columns || []).flatMap((c) => c.tasks || []).find((x) => x.title === '冒烟-半自动拆解');
    if (!t) return { created: false };
    openKanbanTask(t.id);
    return { created: true, id: t.id };
  })()`);
  await sleep(900);
  const s6b = await cdp.ev(`({ mode: KB.mode && KB.mode.mode, dec: !!document.querySelector('[data-kb-decompose]'), note: ((document.querySelector('#kbd-actions-decompose .kbd-act-note') || {}).textContent || '').slice(0, 60) })`);
  ok('semi 模式下 triage 任务抽屉仍有「拆解此任务」按钮（待办②已失效）', s6a.created && s6b.mode === 'semi' && s6b.dec, JSON.stringify({ s6a, s6b }));

  /* S7 轻浮层菜单键盘导航 */
  console.log('\nS7 菜单键盘导航（↑↓/Home/End/Esc）');
  await cdp.ev(`(() => { closeKanbanDrawer(); kbMoreToggle(true); return !document.querySelector('#kb-more-menu').hidden; })()`);
  await sleep(250);
  await key(cdp, 'ArrowDown', 40); await sleep(150);
  const s7a = await cdp.ev(`(() => { const ae = document.activeElement; const items = [...document.querySelectorAll('#kb-more-menu button, #kb-more-menu input')].filter((el) => !el.closest('[hidden]'));
    return { inMenu: ae && document.querySelector('#kb-more-menu').contains(ae), first: ae === items[0], tag: ae && ae.tagName }; })()`);
  ok('打开「⋯」菜单按 ↓：焦点落到第一个条目', s7a.inMenu && s7a.first, JSON.stringify(s7a));
  await key(cdp, 'End', 35); await sleep(150);
  const s7b = await cdp.ev(`(() => { const items = [...document.querySelectorAll('#kb-more-menu button, #kb-more-menu input')].filter((el) => !el.closest('[hidden]')); return document.activeElement === items[items.length - 1]; })()`);
  ok('End 跳到最后一个条目', s7b === true, String(s7b));
  await key(cdp, 'Escape', 27); await sleep(250);
  const s7c = await cdp.ev(`document.querySelector('#kb-more-menu').hidden`);
  ok('Esc 收起菜单', s7c === true, String(s7c));
  await cdp.ev(`(() => { openChipMenu(document.querySelector('#chip-model'), [{ key: 'a', name: '甲' }, { key: 'b', name: '乙' }], 'a', () => {}); return 1; })()`);
  await sleep(250);
  await key(cdp, 'ArrowDown', 40); await sleep(150);
  await key(cdp, 'ArrowDown', 40); await sleep(150);
  const s7d = await cdp.ev(`(() => { const rows = [...document.querySelectorAll('#chip-menu .wb-menu-row')]; const ae = document.activeElement; return { open: !document.querySelector('#chip-menu').hidden, focusIdx: rows.indexOf(ae) }; })()`);
  ok('chip 菜单 ↓ 连按两步移到第 2 行（role=menuitem 的 div 行）', s7d.open && s7d.focusIdx === 1, JSON.stringify(s7d));
  await cdp.ev(`(() => { const c = window.chipMenuCleanup; if (c) c(); document.querySelector('#chip-menu').hidden = true; return 1; })()`);

  /* S8 深色主题对比度 */
  console.log('\nS8 深色主题对比度');
  await cdp.ev(`(() => { closeKanbanPage(); document.documentElement.setAttribute('data-theme', 'dark'); return 1; })()`);
  await cdp.ev(`(showKanban(true), 1)`); await sleep(1200);
  await sleep(300); // 主题切换后等样式重算，别读到中间态
  const s8 = await cdp.ev(`(() => {
    const lum = (c) => { const [r, g, b] = String(c).match(/\\d+/g).slice(0, 3).map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const el = document.querySelector('.kb-card-title'); if (!el) return null;
    let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)') break; n = n.parentElement; }
    const a = lum(getComputedStyle(el).color), b = lum(getComputedStyle(n).backgroundColor);
    return { ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100, theme: document.documentElement.dataset.theme };
  })()`);
  ok('深色主题卡片标题对比度 ≥ 4.5:1', s8 && s8.theme === 'dark' && s8.ratio >= 4.5, JSON.stringify(s8));
  await shot(cdp, 'hermes-ui-dark.png');

  /* S9 内联指令菜单 + 新会话落地页 */
  console.log('\nS9 内联指令菜单（/ 起手）与落地页');
  await cdp.ev(`(() => { document.documentElement.setAttribute('data-theme', 'light'); setView('chat'); newTab(); return 1; })()`);
  await sleep(500);
  const s9a = await cdp.ev(`(() => ({ greet: !!document.querySelector('#landing .landing-greet'), chips: document.querySelectorAll('#landing .landing-chip').length, empty: document.getElementById('main').classList.contains('empty') }))()`);
  ok('落地页显示问候 + 4 个快捷 chip（#main.empty）', s9a.greet && s9a.chips === 4 && s9a.empty, JSON.stringify(s9a));
  await cdp.ev(`document.querySelector('[data-landing="slash"]').click()`);
  await sleep(300);
  const s9b = await cdp.ev(`(() => ({ open: !document.querySelector('#chip-menu').hidden, rows: document.querySelectorAll('#chip-menu .wb-menu-row').length, val: document.getElementById('input').value }))()`);
  ok('落地页「/ 看看指令」chip 拉起内联菜单', s9b.open && s9b.rows > 0 && s9b.val === '/', JSON.stringify(s9b));
  await cdp.ev(`(() => { const i = document.getElementById('input'); i.focus(); i.value = '/new'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(250);
  const s9c = await cdp.ev(`(() => { const rows = [...document.querySelectorAll('#chip-menu .wb-menu-row')]; return { n: rows.length, key: rows[0] ? rows[0].dataset.key : null }; })()`);
  ok('输入 /new 过滤出唯一指令', s9c.n === 1 && s9c.key === '/new', JSON.stringify(s9c));
  const tabCountBefore = await cdp.ev(`state.tabs.length`);
  await key(cdp, 'Enter', 13); await sleep(400);
  const s9d = await cdp.ev(`({ tabs: state.tabs.length, menuHidden: document.querySelector('#chip-menu').hidden, cleared: !document.getElementById('input').value })`);
  ok('Enter 执行 /new：新建页签、菜单收起、输入框清空', s9d.tabs === tabCountBefore + 1 && s9d.menuHidden && s9d.cleared, JSON.stringify(s9d));
  await cdp.ev(`(() => { const i = document.getElementById('input'); i.focus(); i.value = '/zzz'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(250);
  const s9e1 = await cdp.ev(`(() => ({ emptyRow: !!document.querySelector('#chip-menu .wb-menu-empty'), hidden: document.querySelector('#chip-menu').hidden }))()`);
  ok('无匹配显示占位行而非关菜单', s9e1.emptyRow && !s9e1.hidden, JSON.stringify(s9e1));
  await key(cdp, 'Enter', 13); await sleep(300);
  const s9e2 = await cdp.ev(`({ tabs: state.tabs.length, stillEmpty: !!document.querySelector('#chip-menu .wb-menu-empty'), inputVal: document.getElementById('input').value })`);
  ok('无匹配 Enter 被拦下：不建页签、不发送、不清输入', s9e2.tabs === tabCountBefore + 1 && s9e2.stillEmpty && s9e2.inputVal === '/zzz', JSON.stringify(s9e2));
  await cdp.ev(`(() => { document.getElementById('input').value = ''; slashClose(); return 1; })()`);
  await shot(cdp, 'hermes-ui-landing.png');

  /* S10 项目会话隐藏项目选择器（运行时显隐，静态契约查不到 hidden 属性） */
  console.log('\nS10 项目会话隐藏项目选择器');
  await cdp.ev(`(() => { setView('chat'); newTab(); return 1; })()`);
  await sleep(250);
  const s10a = await cdp.ev(`(() => { const e = document.querySelector('#chip-project'); return { hidden: e.hidden, display: getComputedStyle(e).display, projects: composerProjectOptions().length }; })()`);
  ok('默认会话保留「选择项目」入口', !s10a.hidden && s10a.display !== 'none' && s10a.projects > 0, JSON.stringify(s10a));
  await cdp.ev(`(() => { window.__s10Tab = activeTab().id; newTabInProject('/tmp/demo-repo'); return 1; })()`);
  await sleep(250);
  const s10b = await cdp.ev(`(() => { const p = activeTabProject(); return { hidden: document.querySelector('#chip-project').hidden, project: p ? (p.label || p.id) : null }; })()`);
  ok('项目下新建会话收起选择器（归属读得到）', s10b.hidden && s10b.project === 'Hermes Agent', JSON.stringify(s10b));
  await cdp.ev(`setActiveTab(window.__s10Tab)`); await sleep(200);
  const s10c = await cdp.ev(`document.querySelector('#chip-project').hidden`);
  ok('切回默认会话恢复选择器', s10c === false, String(s10c));
  await cdp.ev(`(async () => { await openSession('s_demo_0'); return 1; })()`); await sleep(400);
  const s10d = await cdp.ev(`(() => ({ hidden: document.querySelector('#chip-project').hidden, project: (activeTabProject() || {}).label || null }))()`);
  ok('打开项目分组里的历史会话也收起', s10d.hidden && s10d.project === 'Hermes Agent', JSON.stringify(s10d));
  await cdp.ev(`(async () => { await openSession('s_demo_2'); return 1; })()`); await sleep(400);
  const s10e = await cdp.ev(`document.querySelector('#chip-project').hidden`);
  ok('打开未归类会话恢复选择器', s10e === false, String(s10e));
  await cdp.ev(`document.querySelector('#chip-project .us-trigger').click()`); await sleep(150);
  const s10f = await cdp.ev(`(() => { const open = !document.querySelector('#ui-select-pop').hidden; activeTab().cwd = '/tmp/demo-repo-2'; syncComposerProject(); return { open, popHidden: document.querySelector('#ui-select-pop').hidden, chipHidden: document.querySelector('#chip-project').hidden }; })()`);
  ok('隐藏时下拉面板一并收起，不留孤儿浮层', s10f.open && s10f.popHidden && s10f.chipHidden, JSON.stringify(s10f));

  /* S11 预览页签按类型分流：网页 / PDF / 图片 / 文档 / 表格 */
  console.log('\nS11 预览页签按类型分流');
  const pvProbe = `(() => ({
    type: pv.type, view: pv.view, kind: document.querySelector('#pv-kind').textContent,
    viewsHidden: document.querySelector('#pv-views').hidden,
    btns: [...document.querySelectorAll('.pv-vbtn')].map((b) => b.dataset.pvView),
    shown: ['#pv-frame','#pv-image','#pv-doc','#pv-table','#pv-raw'].filter((s) => !document.querySelector(s).hidden)
  }))()`;
  await cdp.ev(`(() => { setView('chat'); toggleRail(true); setRailTab('preview'); return 1; })()`);
  await sleep(200);
  await cdp.ev(`(async () => { await loadPreviewInput('/tmp/demo/report.md'); return 1; })()`);
  const s11a = await cdp.ev(pvProbe);
  ok('Markdown 走文档面，视图条出现「渲染 / 源码」',
    s11a.type === 'doc' && !s11a.viewsHidden && s11a.kind === '文档'
      && s11a.btns.join(',') === 'render,source' && s11a.shown.join(',') === '#pv-doc', JSON.stringify(s11a));
  const s11a2 = await cdp.ev(`document.querySelector('#pv-doc').textContent.includes('文档渲染视图')`);
  ok('文档视图复用聊天流 Markdown 渲染（标题可见）', s11a2 === true, String(s11a2));
  await cdp.ev(`document.querySelector('[data-pv-view="source"]').click()`); await sleep(140);
  const s11b = await cdp.ev(pvProbe);
  const s11b2 = await cdp.ev(`document.querySelector('#pv-raw').textContent.includes('# 文档渲染视图')`);
  ok('切「源码」只显示原文（textContent，不解释 HTML）',
    s11b.view === 'source' && s11b.shown.join(',') === '#pv-raw' && s11b2 === true, JSON.stringify(s11b));
  await cdp.ev(`(async () => { await loadPreviewInput('/tmp/demo/data.csv'); return 1; })()`);
  const s11c = await cdp.ev(pvProbe);
  const s11c2 = await cdp.ev(`document.querySelectorAll('#pv-table tbody tr').length`);
  ok('CSV 走表格面并解析出数据行（含引号内逗号）',
    s11c.type === 'table' && s11c.shown.join(',') === '#pv-table' && s11c.kind === '表格' && s11c2 === 4,
    JSON.stringify(s11c) + ' rows=' + s11c2);
  await cdp.ev(`(async () => { await loadPreviewInput('/tmp/demo/chart.png'); return 1; })()`);
  const s11d = await cdp.ev(pvProbe);
  const s11d2 = await cdp.ev(`document.querySelector('#pv-img').getAttribute('src') || ''`);
  ok('图片走 img 面，不读字节', s11d.type === 'image' && s11d.shown.join(',') === '#pv-image'
    && String(s11d2).startsWith('data:image'), JSON.stringify(s11d));
  await cdp.ev(`(async () => { await loadPreviewInput('/tmp/demo/manual.pdf'); return 1; })()`);
  const s11e = await cdp.ev(pvProbe);
  const s11e2 = await cdp.ev(`document.querySelector('#pv-frame').getAttribute('srcdoc') || ''`);
  ok('PDF 走 iframe 面（真机 Chromium viewer，Demo 占位）',
    s11e.type === 'pdf' && s11e.shown.join(',') === '#pv-frame' && String(s11e2).length > 0, JSON.stringify(s11e));
  await cdp.ev(`(async () => { await loadPreviewInput('/tmp/demo/page.html'); return 1; })()`);
  const s11f = await cdp.ev(pvProbe);
  ok('网页保留「渲染 / 源码」双视图',
    s11f.type === 'web' && s11f.btns.join(',') === 'render,source' && s11f.shown.join(',') === '#pv-frame',
    JSON.stringify(s11f));
  await cdp.ev(`document.querySelector('[data-pv-view="source"]').click()`); await sleep(140);
  const s11f2 = await cdp.ev(`document.querySelector('#pv-raw').textContent.includes('<!doctype html>')`);
  ok('网页源码视图读得到原文', s11f2 === true, String(s11f2));
  await cdp.ev(`(async () => { await loadPreviewInput('http://127.0.0.1:9/x.html'); return 1; })()`);
  const s11g = await cdp.ev(`(() => ({ type: pv.type, sandbox: document.querySelector('#pv-frame').getAttribute('sandbox') }))()`);
  ok('远程页面 sandbox 收紧到 allow-scripts',
    s11g.type === 'url' && s11g.sandbox === 'allow-scripts', JSON.stringify(s11g));
  const railBefore = await cdp.ev(`document.querySelector('#rail').offsetWidth`);
  await cdp.ev(`(async () => { document.documentElement.setAttribute('data-theme', 'dark'); await loadPreviewInput('/tmp/demo/report.md'); return 1; })()`);
  const s11h = await cdp.ev(`(() => ({ bg: getComputedStyle(document.querySelector('#pv-doc')).backgroundColor,
    rail: document.querySelector('#rail').offsetWidth, views: !document.querySelector('#pv-views').hidden }))()`);
  ok('深色主题文档面跟随 --canvas，rail 定版宽度不变',
    s11h.bg !== 'rgb(250, 249, 245)' && s11h.bg !== 'rgb(255, 255, 255)'
      && s11h.rail === railBefore && s11h.views, JSON.stringify(s11h));
  await cdp.ev(`document.documentElement.setAttribute('data-theme', 'light'); 'ok'`);

  /* S12 右侧 rail 看板：终端下线、紧凑视图与整页共用数据 */
  console.log('\nS12 右侧 rail 看板（替代终端页签）');
  const s12a = await cdp.ev(`(() => ({
    tabs: [...document.querySelectorAll('#rail-tabs .rt')].map((b) => b.dataset.rail),
    term: !!document.querySelector('#term-pane, #term-out, #term-in, #term-mode'),
    pane: !!document.querySelector('#kanban-pane')
  }))()`);
  ok('页签只剩预览 / 看板，终端 DOM 已移除',
    s12a.tabs.join(',') === 'preview,kanban' && !s12a.term && s12a.pane, JSON.stringify(s12a));

  await cdp.ev(`(() => { setView('chat'); toggleRail(true); setRailTab('kanban'); return 1; })()`);
  await cdp.ev(`(async () => { await kanbanLoad(true); return 1; })()`);
  const s12b = await cdp.ev(`(() => ({
    tab: railTab,
    previewHidden: document.querySelector('#preview-pane').hidden,
    kanbanHidden: document.querySelector('#kanban-pane').hidden,
    groups: document.querySelectorAll('.rkb-group').length,
    openGroups: document.querySelectorAll('.rkb-group[open]').length,
    cards: document.querySelectorAll('.rkb-card').length,
    stats: [...document.querySelectorAll('.rkb-stat b')].map((b) => Number(b.textContent)),
    board: document.querySelector('#rkb-board').textContent,
    cols: KB.board && KB.board.columns ? KB.board.columns.length : 0
  }))()`);
  ok('看板页签渲染 5 组紧凑卡片，数据来自同一份 KB.board',
    s12b.tab === 'kanban' && s12b.previewHidden && !s12b.kanbanHidden
      && s12b.groups === 5 && s12b.openGroups > 0 && s12b.cards > 0 && s12b.cols > 0
      && s12b.stats.length === 5 && s12b.board.length > 0, JSON.stringify(s12b));

  const s12c = await cdp.ev(`(() => {
    document.querySelector('.rkb-group[data-rkb-group="todo"]').open = false;
    renderRailKanban();
    return { open: document.querySelector('.rkb-group[data-rkb-group="todo"]').open,
             cards: document.querySelectorAll('.rkb-card').length };
  })()`);
  ok('折叠状态在轮询重渲染后保留', s12c.open === false && s12c.cards > 0, JSON.stringify(s12c));

  const s12d = await cdp.ev(`(() => {
    const card = document.querySelector('.rkb-card[data-rkb-task]');
    const id = card ? card.dataset.rkbTask : '';
    if (card) card.click();
    return { id, page: !document.querySelector('#kanban-page').hidden,
             detail: !document.querySelector('#kb-drawer').hidden,
             railHidden: document.querySelector('#rail').hidden };
  })()`);
  ok('点卡片收起 rail、打开完整看板页与详情抽屉（不并排两份看板）',
    !!s12d.id && s12d.page && s12d.detail && s12d.railHidden, JSON.stringify(s12d));

  const s12e = await cdp.ev(`(() => {
    closeKanbanPage();
    toggleRail(true);
    showKanban(true);
    closeKanbanPage();
    return { railVisible: railKanbanVisible(), pageHidden: document.querySelector('#kanban-page').hidden,
             timer: !!KB.timer };
  })()`);
  ok('关整页看板后 rail 轮询继续在跑（不误停）',
    s12e.railVisible && s12e.pageHidden && s12e.timer, JSON.stringify(s12e));

  await cdp.ev(`(async () => { await loadPreviewInput('/tmp/demo/report.md'); return 1; })()`);
  const s12f = await cdp.ev(`(() => ({ tab: railTab, hint: document.querySelector('#rail-hint').textContent }))()`);
  ok('Agent 写文件触发预览时不抢看板页签',
    s12f.tab === 'kanban' && s12f.hint.includes('看板'), JSON.stringify(s12f));

  await cdp.ev(`(() => { setRailTab('preview'); return 1; })()`);
  const s12g = await cdp.ev(`(() => ({ tab: railTab,
    kHidden: document.querySelector('#kanban-pane').hidden,
    pHidden: document.querySelector('#preview-pane').hidden, timer: !!KB.timer }))()`);
  ok('切回预览：看板面收起、预览面恢复、轮询停表',
    s12g.tab === 'preview' && s12g.kHidden && !s12g.pHidden && !s12g.timer, JSON.stringify(s12g));

  const railBefore12 = await cdp.ev(`document.querySelector('#rail').offsetWidth`);
  await cdp.ev(`(() => { document.documentElement.setAttribute('data-theme', 'dark'); setRailTab('kanban'); return 1; })()`);
  const s12h = await cdp.ev(`(() => ({ card: getComputedStyle(document.querySelector('.rkb-card')).backgroundColor,
    rail: document.querySelector('#rail').offsetWidth }))()`);
  ok('深色主题卡片跟随 --canvas，rail 定版宽度不变',
    s12h.card !== 'rgb(255, 255, 255)' && s12h.card !== 'rgb(250, 249, 245)'
      && s12h.rail === railBefore12, JSON.stringify(s12h));
  await cdp.ev(`(() => { document.documentElement.setAttribute('data-theme', 'light'); setRailTab('preview'); toggleRail(false); return 1; })()`);

  cdp.close(); srv.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\nUI 冒烟：${results.length - fails.length} 通过 / ${fails.length} 失败${fails.length ? '（截图在 /tmp/hermes-ui-*.png）' : ''}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('UI 冒烟异常：', e.message); process.exit(1); });
