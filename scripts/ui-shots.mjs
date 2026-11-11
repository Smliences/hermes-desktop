// UI 自动截图：通过 CDP 驱动页面并截图到 /tmp/hermes-ui/
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = 9333;
const OUT = '/tmp/hermes-ui';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('未找到页面 target');
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function cdp(method, params = {}) {
  return new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) console.log('EVAL-ERR', JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
}
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('shot:', name);
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await sleep(2500);

// 1. 主界面（收起侧栏态）
await shot('01-main');

// 2. 展开侧栏
await evalJs(`setSidebar(true); 'ok'`);
await sleep(600);
await shot('02-sidebar');

// 3. 插件页
await evalJs(`toggleSubpage(document.querySelector('#plugins-page'), true); 'ok'`);
await sleep(2000);
await shot('03-plugins');

// 4. 插件详情（点第一行）
await evalJs(`document.querySelector('#pp-list .pp-row, .pp-listview .pp-row, [data-pp-row]')?.click(); 'ok'`);
await sleep(500);
await shot('04-plugins-detail');
await evalJs(`showSubpageList(document.querySelector('#plugins-page')); 'ok'`);
await sleep(300);

// 5. 技能页
await evalJs(`toggleSubpage(document.querySelector('#skills-page'), true); 'ok'`);
await sleep(2000);
await shot('05-skills');

// 6. 设置页（通用）
await evalJs(`toggleSettings(true); 'ok'`);
await sleep(800);
await shot('06-settings-general');

// 7. 设置页-模型
await evalJs(`[...document.querySelectorAll('.set-nav-item')].find(el=>/模型|model/i.test(el.textContent))?.click(); 'ok'`);
await sleep(500);
await shot('07-settings-model');

// 8. 回到主界面发一条消息前的输入态
await evalJs(`toggleSettings(false); setSidebar(false); 'ok'`);
await sleep(400);
await evalJs(`const i=document.querySelector('#input'); if(i){i.focus(); i.value='你好，请用一句话介绍你自己'; i.dispatchEvent(new Event('input',{bubbles:true}));} 'ok'`);
await sleep(300);
await shot('08-compose');

// 9. 发送，等待真实 hermes 回复
await evalJs(`document.querySelector('#btn-send')?.click(); 'ok'`);
console.log('sent, waiting for reply...');
await sleep(25000);
await shot('09-reply');

console.log('ALL DONE');
process.exit(0);
