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

  cdp.close(); srv.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\nUI 冒烟：${results.length - fails.length} 通过 / ${fails.length} 失败${fails.length ? '（截图在 /tmp/hermes-ui-*.png）' : ''}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('UI 冒烟异常：', e.message); process.exit(1); });
