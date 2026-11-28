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
  await cdp.ev(`(() => { const i = document.getElementById('input'); i.focus(); i.value = '/zzz'; activeTab().sessionId = activeTab().sessionId || 's_demo_live'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(250);
  const s9e1 = await cdp.ev(`(() => ({ emptyRow: !!document.querySelector('#chip-menu .wb-menu-empty'), hidden: document.querySelector('#chip-menu').hidden }))()`);
  ok('无匹配显示占位行而非关菜单', s9e1.emptyRow && !s9e1.hidden, JSON.stringify(s9e1));
  await key(cdp, 'Enter', 13); await sleep(500);
  const s9e2 = await cdp.ev(`(() => { const cards = [...document.querySelectorAll('.msg-command .cmd-line')]; return { tabs: state.tabs.length, inputVal: document.getElementById('input').value, userMsgs: document.querySelectorAll('.msg-user').length, last: cards.length ? cards[cards.length - 1].textContent : '' }; })()`);
  // 目录已就绪时不再把 Enter 拦死（按了没反应），也不许把 /zzz 当正文发给模型：
  // 交给 CLI 回答，结果落成一张命令卡（Demo 桥回「不支持」）
  ok('无匹配 Enter 不当作正文发送：交给 CLI 回答、落成命令卡',
    s9e2.tabs === tabCountBefore + 1 && s9e2.inputVal === '' && s9e2.userMsgs === 0 && s9e2.last === '/zzz',
    JSON.stringify(s9e2));

  /* CLI 命令（目录来自 serve 的 commands.catalog，Demo 桥给最小样例）：
     选中即执行、结果落成命令卡、吃参数的命令只补全不误跑 */
  await cdp.ev(`(() => { const i = document.getElementById('input'); i.focus(); i.value = '/sta'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(280);
  const s9f = await cdp.ev(`(() => { const rows = [...document.querySelectorAll('#chip-menu .wb-menu-row')]; const hit = rows.find((r) => r.dataset.key === '/status'); return { n: rows.length, hit: !!hit, badge: hit && hit.querySelector('.wb-menu-badge') ? hit.querySelector('.wb-menu-badge').textContent : null }; })()`);
  ok('CLI 命令进入候选、与本地动作同列但带 CLI 徽标', s9f.hit && s9f.badge === 'CLI', JSON.stringify(s9f));
  await cdp.ev(`(() => { activeTab().sessionId = 's_demo_live'; const rows = [...document.querySelectorAll('#chip-menu .wb-menu-row')]; const hit = rows.find((r) => r.dataset.key === '/status'); hit.click(); return 1; })()`);
  await sleep(700);
  const s9g = await cdp.ev(`(() => { const cards = [...document.querySelectorAll('.msg-command .cmd-card')]; const card = cards[cards.length - 1]; return { has: !!card, done: !!document.querySelector('.cmd-card.is-done'), cmd: card ? card.querySelector('.cmd-line').textContent : '', out: card ? card.querySelector('.cmd-out').textContent.slice(0, 60) : '' }; })()`);
  ok('选中 CLI 命令即执行，并在对话里留下结果卡', s9g.has && s9g.done && s9g.cmd === '/status' && s9g.out.includes('Session'), JSON.stringify(s9g));
  // 只敲了命令名的一半（/tit）→ 选中只补全，把光标留在参数位，绝不误跑
  const cardCountBefore = await cdp.ev(`document.querySelectorAll('.msg-command').length`);
  await cdp.ev(`(() => { const i = document.getElementById('input'); i.focus(); i.value = '/tit'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(280);
  await cdp.ev(`(() => { const rows = [...document.querySelectorAll('#chip-menu .wb-menu-row')]; const hit = rows.find((r) => r.dataset.key === '/title'); if (hit) hit.click(); return 1; })()`);
  await sleep(350);
  const s9h = await cdp.ev(`({ val: document.getElementById('input').value, cards: document.querySelectorAll('.msg-command').length })`);
  ok('半截命令名只补全、把光标留在参数位',
    s9h.val === '/title ' && s9h.cards === cardCountBefore, JSON.stringify(s9h));

  // 命令名敲全了（/title）→ Enter 就是要跑它：CLI 回 usage，落成结果卡
  await cdp.ev(`(() => { const i = document.getElementById('input'); i.focus(); i.value = '/title'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(280);
  await key(cdp, 'Enter', 13); await sleep(600);
  const s9i = await cdp.ev(`(() => { const cards = [...document.querySelectorAll('.msg-command .cmd-card')]; const last = cards[cards.length - 1]; return { n: cards.length, val: document.getElementById('input').value, cmd: last ? last.querySelector('.cmd-line').textContent : '', out: last ? last.querySelector('.cmd-out').textContent : '' }; })()`);
  ok('敲全命令名后 Enter 直接执行（不再卡在补全空格）',
    s9i.n === cardCountBefore + 1 && s9i.val === '' && s9i.cmd === '/title' && s9i.out.includes('Usage'),
    JSON.stringify(s9i));

  // 别名：/compact 是 /compress 的别名（CLI 目录只列规范名，别名只在 canon 里）
  await cdp.ev(`(() => { const i = document.getElementById('input'); i.focus(); i.value = '/compact'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(320);
  const s9j = await cdp.ev(`(() => { const rows = [...document.querySelectorAll('#chip-menu .wb-menu-row')]; const hit = rows.find((r) => r.dataset.key === '/compress'); return { n: rows.length, hit: !!hit, badge: hit && hit.querySelector('.wb-menu-badge') ? hit.querySelector('.wb-menu-badge').textContent : '' }; })()`);
  ok('别名 /compact 能匹配到 /compress（徽标标出敲的是别名）', s9j.hit && s9j.badge === '/compact', JSON.stringify(s9j));
  await key(cdp, 'Enter', 13); await sleep(700);
  const s9k = await cdp.ev(`(() => { const cards = [...document.querySelectorAll('.msg-command .cmd-card')]; const last = cards[cards.length - 1]; return { n: cards.length, cmd: last ? last.querySelector('.cmd-line').textContent : '', out: last ? last.querySelector('.cmd-out').textContent : '', userMsgs: document.querySelectorAll('.msg-user').length }; })()`);
  ok('别名敲全后 Enter 直接执行：卡片写 /compact、结果是压缩反馈',
    s9k.n === cardCountBefore + 2 && s9k.cmd === '/compact' && s9k.out.includes('Compressed') && s9k.userMsgs === 0,
    JSON.stringify(s9k));
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

  /* S11+ 自动跟随口径：只读工具不抢页签，只认确实写了文件的工具。
     桩一律回 !ok —— 只记录「有没有打算跟随」，不真的 setPreview，零副作用。 */
  console.log('\nS11+ 自动跟随只认写入类工具');
  await cdp.ev(`(() => {
    window.__pvOrigResolve = api.previewResolve;
    window.__pvCalls = [];
    api.previewResolve = async (p) => { window.__pvCalls.push(p); return { ok: false }; };
    return 1;
  })()`);
  const pvTrial = (evt) => cdp.ev(`(async () => {
    window.__pvCalls = [];
    await maybeAutoPreview(${JSON.stringify(evt)});
    return window.__pvCalls.slice();
  })()`);
  const P = '/tmp/demo/report.md';
  const t1 = await pvTrial({ name: 'read_file', input: { file_path: P }, output: `Contents of ${P}` });
  ok('Agent 只读一个 .md 不再弹预览', t1.length === 0, JSON.stringify(t1));
  const t2 = await pvTrial({ name: 'grep', input: { pattern: 'x' }, output: `${P}:1: hit` });
  ok('grep 结果里的路径不算产物', t2.length === 0, JSON.stringify(t2));
  const t3 = await pvTrial({ name: 'write_file', input: { file_path: P, content: '见 /tmp/demo/data.csv' }, output: 'ok' });
  ok('write_file 跟随目标文件，且不把 content 里提到的路径当产物',
    t3.length > 0 && t3[0] === P && !t3.includes('/tmp/demo/data.csv'), JSON.stringify(t3));
  const t4 = await pvTrial({ name: 'write_file', input: { file_path: P }, output: 'failed', isError: true });
  ok('执行失败不跟随', t4.length === 0, JSON.stringify(t4));
  const t5 = await pvTrial({ name: 'bash', input: { command: 'ls -la /tmp/demo' }, output: P });
  ok('ls / git status 输出里的路径不误触发', t5.length === 0, JSON.stringify(t5));
  const t6 = await pvTrial({ name: 'bash', input: { command: `python gen.py > ${P}` }, output: '' });
  ok('命令带重定向目标时仍会跟随', t6.length > 0 && t6[0] === P, JSON.stringify(t6));
  const t7 = await pvTrial({ name: 'bash', input: { command: 'node gen.js' }, output: `Wrote ${P}` });
  ok('结果里有写入信号时仍会跟随', t7.length > 0 && t7.includes(P), JSON.stringify(t7));
  await cdp.ev(`(api.previewResolve = window.__pvOrigResolve, 1)`);

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
      && s12b.stats.length === 6 && s12b.board.length > 0, JSON.stringify(s12b));

  const s12b2 = await cdp.ev(`(() => {
    const el = document.querySelector('#rkb-board');
    const trig = el && el.querySelector('.us-trigger');
    return { tag: el ? el.tagName : '', value: el ? el.value : '',
      label: trig ? trig.textContent.trim() : '',
      opts: el && el._items ? el._items.map((i) => i.label) : [] };
  })()`);
  ok('栏头是看板切换器：当前看板占位 + 末尾「＋ 新建看板…」动作行',
    s12b2.tag === 'HM-SELECT' && s12b2.value === '' && s12b2.label.includes('main')
      && s12b2.opts.length >= 2 && s12b2.opts[s12b2.opts.length - 1].includes('新建看板'),
    JSON.stringify(s12b2));

  // 视觉结构：分组顺序按紧迫度、比例条只高亮两种状态、卡片是两列方块、图标是矢量
  const s12b1 = await cdp.ev(`(() => {
    const segs = [...document.querySelectorAll('#rkb-meter .rkb-seg')];
    const rows = [...document.querySelectorAll('.rkb-card')];
    const order = [...document.querySelectorAll('.rkb-group')]
      .map((g) => g.dataset.rkbGroup || (g.querySelector('.rkb-group-head') ? 'flat' : ''));
    const rect = (el) => { const b = el.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top),
        w: Math.round(b.width), h: Math.round(b.height) }; };
    const boxes = rows.slice(0, 4).map(rect);
    // 同一组里两张卡才是「同一行」：跨组的相邻卡各自在自己的网格里，不等高是正常的
    const grid = [...document.querySelectorAll('.rkb-cards')].find((g) => g.children.length > 1);
    const pair = grid ? [...grid.children].slice(0, 2).map(rect) : [];
    const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
    const first = rows[0];
    return {
      order,
      segs: segs.length,
      grow: segs.map((s) => s.style.flexGrow),
      colored: segs.map((s) => ({ dot: s.dataset.dot, bg: getComputedStyle(s).backgroundColor })),
      boxes, pair, cols,
      parts: first ? { top: !!first.querySelector('.rkb-card-top'),
        bot: !!first.querySelector('.rkb-card-bot'),
        clamp: getComputedStyle(first.querySelector('.rkb-title')).webkitLineClamp } : {},
      icons: document.querySelectorAll('#kanban-pane .rkb-btn svg').length,
      hot: document.querySelectorAll('.rkb-group-head.is-hot').length,
      sticky: [...document.querySelectorAll('.rkb-group-head')]
        .every((h) => getComputedStyle(h).position === 'sticky')
    };
  })()`);
  const TRANSPARENT = (bg) => /rgba?\(0, 0, 0, 0\)|transparent/.test(bg);
  ok('分组按「进行中 → 受阻 → 就绪 → 待办 → 已完成」排，进行中组头强调',
    s12b1.order[0] === 'running' && s12b1.order.join(',') === 'running,blocked,ready,todo,done'
      && s12b1.hot === 1, JSON.stringify(s12b1.order));
  ok('比例条按任务数分段，只有进行中 / 受阻上色（其余留中性轨）',
    s12b1.segs === 5 && s12b1.grow.every((g) => Number(g) > 0)
      && s12b1.colored.filter((c) => c.dot === 'green' || c.dot === 'red').every((c) => !TRANSPARENT(c.bg))
      && s12b1.colored.filter((c) => c.dot !== 'green' && c.dot !== 'red').every((c) => TRANSPARENT(c.bg)),
    JSON.stringify(s12b1.colored));
  ok('任务卡是两列方块：同行等宽等高、有顶行与底行、标题按行截断',
    s12b1.cols === 2 && s12b1.parts.top && s12b1.parts.bot && s12b1.parts.clamp === '2'
      && s12b1.pair.length === 2 && s12b1.pair[0].y === s12b1.pair[1].y
      && s12b1.pair[0].h === s12b1.pair[1].h
      && s12b1.boxes.every((b) => b.h >= 104 && b.w > 140),
    JSON.stringify({ pair: s12b1.pair, parts: s12b1.parts, cols: s12b1.cols }));
  ok('组头吸顶（长列表滚下去还知道是哪一段）', s12b1.sticky, String(s12b1.sticky));
  ok('栏头三个图标都是矢量（不是三个字形方块）', s12b1.icons === 3, String(s12b1.icons));

  // 空组不占地方：清空一组后组数与比例条段数同时减一，恢复后回来
  const s12b3 = await cdp.ev(`(() => {
    const col = KB.board.columns.find((c) => c.name === 'blocked');
    const saved = (col.tasks || []).slice();
    col.tasks = [];
    renderRailKanban();
    const empty = { groups: document.querySelectorAll('.rkb-group').length,
      segs: document.querySelectorAll('.rkb-seg').length };
    col.tasks = saved;
    renderRailKanban();
    return { empty, back: document.querySelectorAll('.rkb-group').length,
      segsBack: document.querySelectorAll('.rkb-seg').length };
  })()`);
  ok('零任务的组整段隐藏，速览里不堆「暂无任务」',
    s12b3.empty.groups === 4 && s12b3.empty.segs === 4
      && s12b3.back === 5 && s12b3.segsBack === 5, JSON.stringify(s12b3));

  const s12c = await cdp.ev(`(() => {
    document.querySelector('.rkb-group[data-rkb-group="todo"]').open = false;
    renderRailKanban();
    return { open: document.querySelector('.rkb-group[data-rkb-group="todo"]').open,
             cards: document.querySelectorAll('.rkb-card').length };
  })()`);
  ok('折叠状态在轮询重渲染后保留', s12c.open === false && s12c.cards > 0, JSON.stringify(s12c));

  const s12c2 = await cdp.ev(`(() => {
    document.querySelector('.rkb-stat[data-rkb-group="running"]').click();
    const one = { groups: document.querySelectorAll('.rkb-group').length,
      cards: document.querySelectorAll('.rkb-card').length,
      on: document.querySelectorAll('.rkb-stat.is-on').length,
      flat: document.querySelectorAll('.rkb-group.is-flat').length,
      dots: [...document.querySelectorAll('.rkb-card')].map((c) => c.dataset.dot) };
    document.querySelector('.rkb-stat[data-rkb-group="running"]').click();
    const all = { groups: document.querySelectorAll('.rkb-group').length,
      on: document.querySelectorAll('.rkb-stat.is-on').length };
    return { one, all };
  })()`);
  ok('点状态 chip 只在本地筛出一组、再点一次回到全部',
    s12c2.one.groups === 1 && s12c2.one.flat === 1 && s12c2.one.cards > 0
      && s12c2.one.dots.every((d) => d === 'green') && s12c2.all.groups === 5
      && s12c2.all.on === 1, JSON.stringify(s12c2));

  const s12c3 = await cdp.ev(`(async () => {
    const el = document.querySelector('#rkb-board');
    el.value = 'ops-2026';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 260));
    return { filter: KB.filters.board, value: el.value,
      label: el.querySelector('.us-value').textContent };
  })()`);
  ok('选另一块看板 = 改 KB.filters.board，栏头名字跟着变',
    s12c3.filter === 'ops-2026' && s12c3.value === '' && s12c3.label.includes('ops-2026'),
    JSON.stringify(s12c3));
  await cdp.ev(`(async () => {
    KB.filters.board = ''; KB.overview = null; kbSelectSig = ''; rkbBoardSig = '';
    await kanbanLoad(true); return 1;
  })()`);

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

  /* S13 运行中卡片：卡面秒表 + 抽屉里的 profile 工作进度
     不依赖前面步骤留下的 Demo 状态（那张 running 卡可能已被拖走），这里自带夹具：
     卡面用 KB.board 里的任务，抽屉用一次性的 kanbanTask 桩，断言只针对渲染逻辑。 */
  console.log('\nS13 运行中的 profile 工作进度');
  await cdp.ev(`(() => {
    closeKanbanDrawer(); showKanban(true);
    const now = Math.floor(Date.now() / 1000);
    const t = (KB.board.columns || []).flatMap((c) => c.tasks || []).find((x) => x.id === 't_demo07')
      || { id: 't_demo07', title: '给设置页补上快捷键冲突提示' };
    Object.assign(t, { status: 'running', assignee: 'writer', started_at: now - 300,
      current_run_started_at: now - 300, max_runtime_seconds: 900, progress: { done: 1, total: 4 } });
    if (!(KB.board.columns || []).some((c) => (c.tasks || []).includes(t))) {
      const col = (KB.board.columns || []).find((c) => c.name === 'running');
      if (col) col.tasks = (col.tasks || []).concat([t]);
    }
    renderKanban();
    return 1;
  })()`);
  await sleep(300);
  const s13a = await cdp.ev(`(() => {
    const card = document.querySelector('.kb-card[data-kb-task="t_demo07"]');
    const run = card && card.querySelector('.kb-run');
    return { has: !!card, run: !!run,
      text: run ? run.querySelector('.kb-run-txt').textContent.trim() : '',
      bar: run ? parseFloat(run.querySelector('.kb-run-bar > i').style.width) : 0,
      hot: run ? run.classList.contains('is-hot') : null };
  })()`);
  ok('运行中的卡片带会走的秒表与预算条',
    s13a.has && s13a.run && /^◷ \d+:\d\d \/ \d+:\d\d$/.test(s13a.text)
      && s13a.bar > 0 && s13a.bar <= 100 && s13a.hot === false, JSON.stringify(s13a));

  const s13b = await cdp.ev(`(async () => {
    const now = Math.floor(Date.now() / 1000);
    const task = { id: 't_demo07', title: '给设置页补上快捷键冲突提示', body: '', status: 'running',
      priority: 2, assignee: 'writer', tenant: '', created_at: now - 2400, started_at: now - 300,
      current_run_started_at: now - 300, max_runtime_seconds: 900, completed_at: 0,
      latest_summary: '正在梳理现有键位表', result: '', comment_count: 0,
      progress: { done: 1, total: 4 }, warnings: { count: 0 }, session_id: '', workspace_kind: 'scratch' };
    let taskCalls = 0, workerCalls = 0;
    const origT = __mockAPI.kanbanTask, origW = __mockAPI.kanbanActiveWorkers;
    __mockAPI.kanbanTask = async () => {
      taskCalls += 1;
      return { ok: true, task, comments: [], attachments: [], links: { parents: [], children: [] },
        events: [{ id: 7, task_id: task.id, run_id: 12, kind: 'step', payload: '扫描 keymap 表 18 处绑定', created_at: now - 90 }],
        runs: [{ id: 12, task_id: task.id, profile: 'writer', status: 'running', started_at: now - 300, max_runtime_seconds: 900 }] };
    };
    __mockAPI.kanbanActiveWorkers = async (...a) => { workerCalls += 1; return origW.apply(__mockAPI, a); };
    await openKanbanTask('t_demo07');
    __mockAPI.kanbanTask = origT; __mockAPI.kanbanActiveWorkers = origW;
    const p = document.querySelector('#kb-drawer-body .kbd-prog');
    return { taskCalls, workerCalls, panel: !!p,
      who: p ? p.querySelector('.kbd-prog-who').textContent.trim() : '',
      run: p ? (p.querySelector('.kbd-prog-run') || {}).textContent || '' : '',
      clock: p ? p.querySelector('.kb-run-txt').textContent.trim() : '',
      bar: p ? parseFloat(p.querySelector('.kbd-prog-bar > i').style.width) : 0,
      facts: p ? p.querySelector('.kbd-prog-facts').textContent.trim() : '',
      now: p ? (p.querySelector('.kbd-prog-now') || {}).textContent || '' : '',
      sibs: p ? document.querySelectorAll('.kbd-prog-sibs [data-kb-task]').length : 0 };
  })()`);
  ok('抽屉顶部给出 profile 工作进度：谁在跑 / 运行号 / 耗时预算 / 子任务 / 最近活动',
    s13b.panel && s13b.who.includes('writer') && /运行 #/.test(s13b.run)
      && /^◷ \d+:\d\d \/ \d+:\d\d$/.test(s13b.clock) && s13b.bar > 0 && s13b.bar <= 100
      && s13b.facts.includes('子任务') && s13b.now.includes('最近活动'), JSON.stringify(s13b));
  ok('进度只读一次任务详情，不再额外拉 worker 列表',
    s13b.taskCalls === 1 && s13b.workerCalls === 0, JSON.stringify({ t: s13b.taskCalls, w: s13b.workerCalls }));

  const s13c = await cdp.ev(`(() => {
    kbRunTick();
    return { timer: !!kbRunTimer, nodes: document.querySelectorAll('[data-kb-run]').length };
  })()`);
  ok('有可见进度节点时秒表在跑', s13c.timer && s13c.nodes > 0, JSON.stringify(s13c));

  const s13d = await cdp.ev(`(() => {
    closeKanbanDrawer();
    closeKanbanPage();
    kbRunTick();
    return { timer: !!kbRunTimer,
      visible: [...document.querySelectorAll('[data-kb-run]')].filter((el) => el.getClientRects().length).length };
  })()`);
  ok('抽屉与看板都收起后秒表自停（不留空转定时器）',
    !s13d.timer && s13d.visible === 0, JSON.stringify(s13d));

  const s13e = await cdp.ev(`(() => {
    showKanban(true);
    const now = Math.floor(Date.now() / 1000);
    const t = (KB.board.columns || []).flatMap((c) => c.tasks || []).find((x) => x.id === 't_demo07');
    if (!t) return { found: false };
    Object.assign(t, { status: 'running', current_run_started_at: now - 870, max_runtime_seconds: 900 });
    renderKanban();
    const run = document.querySelector('.kb-card[data-kb-task="t_demo07"] .kb-run');
    return { found: true, hot: !!run && run.classList.contains('is-hot'),
      bar: run ? parseFloat(run.querySelector('.kb-run-bar > i').style.width) : 0 };
  })()`);
  ok('预算用掉 85% 转预警态，进度条钳在 100% 内',
    s13e.found && s13e.hot && s13e.bar > 85 && s13e.bar <= 100, JSON.stringify(s13e));
  await cdp.ev(`(() => { closeKanbanPage(); closeKanbanDrawer(); return 1; })()`);

  /* S14 工具调用多级下拉与自动展开 / 收起 */
  console.log('\nS14 工具调用多级下拉与自动展开 / 收起');
  const s14a = await cdp.ev(`(() => {
    newTab();
    const tab = activeTab();
    tab.items.push(
      { kind: 'user', text: '帮我查一下配置', ts: Date.now() },
      { kind: 'tool', id: 't1', name: 'read_file', input: { path: '/tmp/a.txt' }, state: 'running', isError: false },
      { kind: 'tool', id: 't2', name: 'execute_command', input: { command: 'ls -la' }, state: 'running', isError: false }
    );
    renderChat();
    const grp = document.querySelector('.step-group');
    const head = grp && grp.querySelector('.step-head');
    const body = grp && grp.querySelector('.step-body');
    return {
      hasGrp: !!grp,
      open: !!grp && grp.classList.contains('open'),
      running: !!head && head.classList.contains('running'),
      expanded: head ? head.getAttribute('aria-expanded') : null,
      bodyVisible: !!body && !body.classList.contains('hidden'),
      children: body ? body.querySelectorAll('.tool-item').length : 0,
    };
  })()`);
  ok('连续工具运行中自动展开，且子项落在 .step-body 内',
    s14a.hasGrp && s14a.open && s14a.running && s14a.expanded === 'true' && s14a.bodyVisible && s14a.children === 2,
    JSON.stringify(s14a));

  const s14b = await cdp.ev(`(() => {
    const tab = activeTab();
    tab.items.filter((i) => i.kind === 'tool').forEach((t) => { t.state = 'done'; t.result = 'ok'; });
    renderChat();
    const grp = document.querySelector('.step-group');
    const head = grp && grp.querySelector('.step-head');
    const body = grp && grp.querySelector('.step-body');
    return {
      open: !!grp && grp.classList.contains('open'),
      done: !!head && head.classList.contains('done'),
      expanded: head ? head.getAttribute('aria-expanded') : null,
      bodyHidden: !!body && body.classList.contains('hidden'),
    };
  })()`);
  ok('工具全部成功后自动收起成一行',
    !s14b.open && s14b.done && s14b.expanded === 'false' && s14b.bodyHidden,
    JSON.stringify(s14b));

  const s14c = await cdp.ev(`(() => {
    document.querySelector('.step-head').click();
    renderChat();
    const grp = document.querySelector('.step-group');
    return {
      openAfterRerender: !!grp && grp.classList.contains('open'),
      remembered: activeTab().items.find((i) => i.kind === 'tool').groupOpen === true,
    };
  })()`);
  ok('用户手动点开后重绘仍保持展开态', s14c.openAfterRerender && s14c.remembered, JSON.stringify(s14c));

  const s14d = await cdp.ev(`(() => {
    newTab();
    const tab = activeTab();
    tab.items.push(
      { kind: 'user', text: '跑个失败命令', ts: Date.now() },
      { kind: 'tool', id: 'e1', name: 'read_file', input: { path: '/tmp/a' }, state: 'done', result: 'ok', isError: false },
      { kind: 'tool', id: 'e2', name: 'execute_command', input: { command: 'false' }, state: 'done', result: 'exit 1', isError: true }
    );
    renderChat();
    const grp = document.querySelector('.step-group');
    const head = grp && grp.querySelector('.step-head');
    return { open: !!grp && grp.classList.contains('open'), err: !!head && head.classList.contains('error') };
  })()`);
  ok('含失败工具时整段标红并自动展开', s14d.open && s14d.err, JSON.stringify(s14d));

  /* S15 窄主区 .compact 降级与模态 inert 隔离 */
  console.log('\nS15 窄主区 .compact 降级与模态 inert 隔离');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const s15a = await cdp.ev(`(() => {
    const btn = document.querySelector('#btn-send');
    const r = btn ? btn.getBoundingClientRect() : { width: 0, height: 0 };
    return { compact: document.documentElement.classList.contains('compact'), sendVis: r.width > 0 && r.height > 0 };
  })()`);
  ok('窄窗口（#main ≤ 600px）触发 .compact 且发送键可见', s15a.compact && s15a.sendVis, JSON.stringify(s15a));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const s15b = await cdp.ev(`document.documentElement.classList.contains('compact')`);
  ok('恢复 1440px 宽度后自动退出 .compact', s15b === false, String(s15b));

  await cdp.ev(`(document.querySelector('#btn-settings').click(), 1)`);
  await sleep(200);
  const s15c = await cdp.ev(`({ open: !document.querySelector('#settings-page').hidden, inert: !!document.querySelector('#frame').inert })`);
  ok('打开设置模态时背景 #frame 被 inert 隔离', s15c.open && s15c.inert, JSON.stringify(s15c));

  await cdp.ev(`({ open: !document.querySelector('#settings-page').hidden, inert: !!document.querySelector('#frame').inert })`);
  await key(cdp, 'Escape', 27);
  await sleep(200);
  const s15d = await cdp.ev(`({ closed: !!document.querySelector('#settings-page').hidden, inert: !!document.querySelector('#frame').inert })`);
  ok('Esc 关闭设置模态后解除 #frame.inert', s15d.closed && !s15d.inert, JSON.stringify(s15d));

  /* S16 任务抽屉编辑（标题/优先级/描述）与执行日志 */
  console.log('\nS16 任务抽屉编辑与执行日志');
  await cdp.ev(`(showKanban(true), 1)`); await sleep(400);
  await cdp.ev(`openKanbanTask('t_demo07')`); await sleep(300);
  const s16a = await cdp.ev(`(async () => {
    const editBtn = document.querySelector('[data-kb-edit]');
    if (!editBtn) return { hasBtn: false };
    editBtn.click();
    const form = document.querySelector('#kbd-edit-form');
    if (!form || form.hidden) return { hasBtn: true, opened: false };
    document.querySelector('#kbd-edit-title').value = '给设置页补上快捷键冲突提示（已编辑）';
    document.querySelector('#kbd-edit-priority').value = '3';
    document.querySelector('#kbd-edit-body').value = '补充描述内容';
    document.querySelector('[data-kb-edit-save]').click();
    await new Promise((r) => setTimeout(r, 200));
    const title = (document.querySelector('.kbd-title') || {}).textContent || '';
    const logBtn = document.querySelector('[data-kb-log]');
    if (logBtn) logBtn.click();
    await new Promise((r) => setTimeout(r, 200));
    const logBody = document.querySelector('#kbd-log-body');
    return {
      hasBtn: true, opened: true, title,
      logVisible: !!logBody && !logBody.hidden,
      logText: logBody ? logBody.textContent : '',
    };
  })()`);
  ok('抽屉内联编辑保存后标题实时更新',
    s16a.hasBtn && s16a.opened && s16a.title.includes('已编辑'), JSON.stringify(s16a));
  ok('抽屉可按需读取 worker 执行日志',
    s16a.logVisible && s16a.logText.includes('worker started'), JSON.stringify(s16a));
  await cdp.ev(`(() => { closeKanbanDrawer(); closeKanbanPage(); return 1; })()`);

  /* S17 看板第二期：排序 / 持久化 / 快捷键 / 搜索高亮 / 卡住提示 / 列折叠 / 抽屉切卡 / 整列落点 */
  console.log('\nS17 看板第二期交互完善');
  await cdp.ev(`(() => { localStorage.removeItem('kb-prefs'); KB._prefsScope = ''; kbResetFilters(); showKanban(true); return 1; })()`);
  await sleep(600);

  // F5 卡住提示
  const s17Stuck = await cdp.ev(`(() => {
    const badges = [...document.querySelectorAll('.kb-card .kb-stuck')].map((el) => el.textContent.trim());
    return { count: badges.length, sample: badges.slice(0, 3) };
  })()`);
  ok('卡住提示：就绪 / 受阻超时卡片显示琥珀色「已等 X」小标',
    s17Stuck.count >= 1 && s17Stuck.sample.some((t) => /^已等\s+/.test(t)), JSON.stringify(s17Stuck));

  // F3 '/' 聚焦搜索 + F4 搜索高亮（含 XSS 安全转义）
  const pressChar = async (ch, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
  };
  await cdp.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await pressChar('/', 'Slash', 191);
  await sleep(150);
  const s17Slash = await cdp.ev(`(() => { const q = document.querySelector('#kb-search'); return { focused: document.activeElement === q, val: q ? q.value : null }; })()`);
  ok('快捷键 / 聚焦搜索框且不把斜杠输入文本框', s17Slash.focused && s17Slash.val === '', JSON.stringify(s17Slash));

  await cdp.ev(`(() => { const q = document.querySelector('#kb-search'); q.value = '反馈'; q.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await sleep(250);
  const s17Mark = await cdp.ev(`(() => {
    const marks = [...document.querySelectorAll('#kb-scroll .kb-card mark.kb-mark')].map((m) => m.textContent);
    return { count: marks.length, first: marks[0] || '' };
  })()`);
  ok('搜索命中词在标题/摘要内以 <mark> 高亮', s17Mark.count >= 1 && s17Mark.first === '反馈', JSON.stringify(s17Mark));
  await key(cdp, 'Escape', 27);
  await sleep(150);
  await cdp.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);

  // F1 ⋯ 菜单排序
  await cdp.ev(`(() => { kbMoreToggle(true); document.querySelector('#kb-more-menu [data-kb-sort="priority"]').click(); kbMoreToggle(false); return 1; })()`);
  await sleep(200);
  const s17Sort = await cdp.ev(`(() => {
    const ids = [...document.querySelectorAll('.kb-col[data-group="ready"] .kb-card')].map((c) => c.dataset.kbTask);
    const pris = ids.map((id) => {
      const t = (KB.board.columns || []).flatMap((c) => c.tasks || []).find((x) => x.id === id);
      return t ? (Number(t.priority) || 0) : -1;
    });
    const sorted = pris.every((v, i) => i === 0 || pris[i - 1] >= v);
    return { sort: KB.sort, ids, pris, sorted };
  })()`);
  ok('⋯ 菜单按优先级排序只在本地重排且降序生效', s17Sort.sort === 'priority' && s17Sort.ids.length >= 2 && s17Sort.sorted, JSON.stringify(s17Sort));

  // F6 列折叠为 44px 竖条
  await cdp.ev(`document.querySelector('.kb-col[data-group="done"] [data-kb-collapse="done"]').click()`);
  await sleep(150);
  const s17Col = await cdp.ev(`(() => {
    const col = document.querySelector('.kb-col[data-group="done"]');
    const r = col ? col.getBoundingClientRect() : { width: 0 };
    const wm = col ? getComputedStyle(col.querySelector('.kb-col-name')).writingMode : '';
    return { collapsed: !!col && col.classList.contains('is-collapsed'), width: Math.round(r.width), wm };
  })()`);
  ok('列折叠收成 44px 竖条且列名竖排', s17Col.collapsed && s17Col.width === 44 && /vertical/.test(s17Col.wm), JSON.stringify(s17Col));

  // F8 整列虚线落点 + 空列动作文案（暂时筛到 writer 让 todo 列为空）
  await cdp.ev(`(() => { KB.filters.assignee = 'writer'; renderKanbanStatusbar(); renderKanbanBody(); return 1; })()`);
  await sleep(150);
  const dEmpty = await drag('.kb-card[data-kb-task="t_demo07"]', '.kb-col[data-group="todo"]');
  const s17Drop = await cdp.ev(`(() => {
    const col = document.querySelector('.kb-col[data-group="todo"]');
    const prompt = col ? col.querySelector('.kb-drop-prompt') : null;
    const vis = prompt ? getComputedStyle(prompt).display !== 'none' : false;
    return { dragging: document.body.classList.contains('kb-dragging'), empty: !!col && col.classList.contains('is-empty'), over: !!col && col.classList.contains('over'), vis, text: prompt ? prompt.textContent : '' };
  })()`);
  await key(cdp, 'Escape', 27);
  if (dEmpty) await mouse('mouseReleased', dEmpty.b.x, dEmpty.b.y);
  await cdp.ev(`(() => { KB.filters.assignee = ''; kbSavePrefs(); renderKanbanStatusbar(); renderKanbanBody(); return 1; })()`);
  await sleep(150);
  ok('拖拽时整列落点高亮，空列显示动作文案「松手 → 放回待办」',
    s17Drop.dragging && s17Drop.empty && s17Drop.over && s17Drop.vis && s17Drop.text.includes('放回待办'), JSON.stringify(s17Drop));

  // F2 偏好持久化（按 profile + 看板保存，搜索词不落盘）
  const s17Persist = await cdp.ev(`(() => {
    const raw = JSON.parse(localStorage.getItem('kb-prefs') || '{}');
    closeKanbanPage();
    KB.sort = 'default'; KB.collapsed = new Set(); KB.status = 'blocked'; KB._prefsScope = '';
    KB.filters.q = 'should-not-persist';
    showKanban(true);
    return {
      keys: Object.keys(raw),
      sortRestored: KB.sort === 'priority',
      colRestored: KB.collapsed.has('done'),
      statusRestored: KB.status === '',
      noSearchSaved: !JSON.stringify(raw).includes('should-not-persist'),
    };
  })()`);
  await sleep(500);
  ok('偏好持久化按 profile + 看板恢复 sort / 折叠列 / 分组，不保存搜索词',
    s17Persist.sortRestored && s17Persist.colRestored && s17Persist.statusRestored && s17Persist.noSearchSaved, JSON.stringify(s17Persist));
  await cdp.ev(`(() => { KB.filters.q = ''; renderKanbanStatusbar(); renderKanbanBody(); return 1; })()`);
  await sleep(150);

  // F3 N 新建弹窗快捷键 + ←/→/Enter 导航开抽屉
  await cdp.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await pressChar('n', 'KeyN', 78);
  await sleep(200);
  const s17N = await cdp.ev(`(() => {
    const m = document.querySelector('#kb-modal'), t = document.querySelector('#kb-f-title');
    return { open: !!m && !m.hidden, mode: KB.modal, titleEmpty: t ? t.value === '' : false };
  })()`);
  ok('快捷键 N 打开新建弹窗且不带入字符 n', s17N.open && s17N.mode === 'task' && s17N.titleEmpty, JSON.stringify(s17N));
  await key(cdp, 'Escape', 27);
  await sleep(200);

  await cdp.ev(`document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
  await key(cdp, 'ArrowRight', 39); await sleep(120);
  await key(cdp, 'ArrowRight', 39); await sleep(120);
  const s17Nav = await cdp.ev(`(() => {
    const ae = document.activeElement;
    return {
      isCard: !!ae && ae.classList.contains('kb-card'),
      id: ae && ae.dataset ? (ae.dataset.kbTask || '') : '',
      tag: ae ? ae.tagName : '',
      focusId: KB.focusId,
      cards: document.querySelectorAll('#kb-scroll .kb-card[data-kb-task]').length,
    };
  })()`);
  await key(cdp, 'Enter', 13);
  await sleep(400);
  const s17Open = await cdp.ev(`({ open: !document.querySelector('#kb-drawer').hidden, detailId: KB.detailId })`);
  ok('← / → 在卡片间移动焦点，Enter 打开对应详情抽屉',
    s17Nav.isCard && s17Nav.id && s17Open.open && s17Open.detailId === s17Nav.id, JSON.stringify({ s17Nav, s17Open }));

  // F7 抽屉内 ‹ › 与 ↑/↓ 切到同列上一张 / 下一张
  await cdp.ev(`openKanbanTask('t_demo03')`); await sleep(400);
  const s17Step0 = await cdp.ev(`({ id: KB.detailId, pos: (document.querySelector('#kbd-nav-pos') || {}).textContent, hidden: document.querySelector('#kbd-nav').hidden })`);
  await key(cdp, 'ArrowDown', 40); await sleep(350);
  const s17Step1 = await cdp.ev(`({ id: KB.detailId, pos: (document.querySelector('#kbd-nav-pos') || {}).textContent })`);
  await key(cdp, 'ArrowUp', 38); await sleep(350);
  const s17Step2 = await cdp.ev(`({ id: KB.detailId, pos: (document.querySelector('#kbd-nav-pos') || {}).textContent })`);
  ok('抽屉内 ↑ / ↓ 与 ‹ › 切换同列上一张 / 下一张卡片',
    !s17Step0.hidden && s17Step1.id !== s17Step0.id && s17Step2.id === s17Step0.id, JSON.stringify({ s17Step0, s17Step1, s17Step2 }));

  await cdp.ev(`(() => { closeKanbanDrawer(); closeKanbanPage(); toggleHelp(true); return 1; })()`);
  await sleep(150);
  const s17Help = await cdp.ev(`[...document.querySelectorAll('#help-body .help-group h3')].map((h) => h.textContent)`);
  ok('快捷键帮助页包含「看板」分组', s17Help.includes('看板'), JSON.stringify(s17Help));
  await cdp.ev(`(() => { toggleHelp(false); localStorage.removeItem('kb-prefs'); return 1; })()`);

  /* S18 富文本高亮/折叠 + 预览历史/清空 + 运行中消息排队 */
  console.log('\nS18 富文本高亮折叠、预览历史与消息排队');
  const s18Md = await cdp.ev(`(() => {
    const longCode = Array.from({ length: 35 }, (_, i) => 'const x' + i + ' = ' + i + ';').join('\\n');
    const html = renderMarkdown('\`\`\`js\\n' + longCode + '\\n\`\`\`\\n\\n\`\`\`css\\n.box { color: #3f3e39; z-index: 2; font-family: "Inter"; }\\n\`\`\`\\n\\n| A | B |\\n| --- | --- |\\n| 1 | 2 |');
    const box = document.createElement('div');
    box.innerHTML = html;
    document.querySelector('#chat').appendChild(box);
    const codeEl = box.querySelector('.md-code');
    const foldBtn = box.querySelector('.md-code-fold');
    const hasKw = !!box.querySelector('.hl-kw');
    const cssNum = !!box.querySelectorAll('.md-code pre')[1]?.querySelector('.hl-num');
    const collapsedBefore = !!codeEl && codeEl.classList.contains('collapsed');
    if (foldBtn) foldBtn.click();
    const collapsedAfter = !!codeEl && codeEl.classList.contains('collapsed');
    const tblBtns = [...box.querySelectorAll('.md-table-copy')].map((b) => b.dataset.fmt);
    box.remove();
    return { hasKw, cssNum, collapsedBefore, collapsedAfter, tblBtns };
  })()`);
  ok('超 30 行代码块默认折叠、支持语法高亮与展开/收起切换（CSS #色值不吞行尾）', s18Md.hasKw && s18Md.cssNum && s18Md.collapsedBefore && !s18Md.collapsedAfter, JSON.stringify(s18Md));
  ok('GFM 表格渲染 Markdown 与 CSV 复制按钮', s18Md.tblBtns.includes('md') && s18Md.tblBtns.includes('csv'), JSON.stringify(s18Md.tblBtns));

  await cdp.ev(`(async () => { toggleRail(true); setRailTab('preview'); await loadPreviewInput('/tmp/demo/report.md'); await loadPreviewInput('/tmp/demo/data.csv'); })()`);
  await sleep(300);
  const s18Pv1 = await cdp.ev(`({ path: document.querySelector('#pv-path').value, backDis: document.querySelector('#pv-back').disabled, fwdDis: document.querySelector('#pv-fwd').disabled })`);
  await cdp.ev(`document.querySelector('#pv-back').click()`); await sleep(250);
  const s18PvBack = await cdp.ev(`({ path: document.querySelector('#pv-path').value, fwdDis: document.querySelector('#pv-fwd').disabled })`);
  await cdp.ev(`document.querySelector('#pv-fwd').click()`); await sleep(250);
  const s18PvFwd = await cdp.ev(`({ path: document.querySelector('#pv-path').value })`);
  await cdp.ev(`document.querySelector('#pv-clear').click()`); await sleep(200);
  const s18PvClr = await cdp.ev(`({ path: document.querySelector('#pv-path').value, emptyVisible: !document.querySelector('#pv-empty').hidden })`);
  ok('预览栏支持后退 / 前进历史导航与清空重置',
    s18Pv1.path.endsWith('data.csv') && !s18Pv1.backDis && s18Pv1.fwdDis &&
    s18PvBack.path.endsWith('report.md') && !s18PvBack.fwdDis &&
    s18PvFwd.path.endsWith('data.csv') &&
    s18PvClr.path === '' && s18PvClr.emptyVisible,
    JSON.stringify({ s18Pv1, s18PvBack, s18PvFwd, s18PvClr }));

  const s18Queue = await cdp.ev(`(() => {
    const tab = activeTab();
    const prevRun = tab.running;
    tab.running = true;
    tab.queued = [];
    send('排队消息测试');
    const len = tab.queued.length;
    const first = tab.queued[0] && tab.queued[0].text;
    tab.queued = [];
    tab.running = prevRun;
    return { len, first };
  })()`);
  ok('回合运行中发送消息自动进入 tab.queued 排队', s18Queue.len === 1 && s18Queue.first === '排队消息测试', JSON.stringify(s18Queue));

  cdp.close(); srv.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\nUI 冒烟：${results.length - fails.length} 通过 / ${fails.length} 失败${fails.length ? '（截图在 /tmp/hermes-ui-*.png）' : ''}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('UI 冒烟异常：', e.message); process.exit(1); });
