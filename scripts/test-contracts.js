'use strict';
/**
 * test-contracts.js — 静态契约与工程一致性检查
 *
 * 防止三类高发回归：
 *   1. main 注册的 IPC handler 与 preload 暴露 / renderer 调用脱节
 *   2. index.html 删改元素后 app.js 里残留死绑定（$() 返回 null 再赋 onclick 会抛）
 *   3. 语法错误、CSS 括号失衡、CSP 被放宽、主题 token 少定义
 *
 * 纯静态、零依赖、只读。运行：npm test 或 node scripts/test-contracts.js
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const uniq = (a) => [...new Set(a)].sort();
const collect = (text, re) => { const out = []; let m; while ((m = re.exec(text))) out.push(m[1]); return out; };

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + '\n      ' + ((e && e.message) || e)); }
}
const section = (s) => console.log('\n' + s);
const assert = require('assert');

const mainSrc = read('main/main.js');
const preloadSrc = read('preload/preload.js');
const appSrc = read('renderer/app.js');
const htmlSrc = read('renderer/index.html');
const cssSrc = read('renderer/styles.css');
const sessSrc = read('main/services/hermes-sessions.js');

section('1. IPC 契约：main ↔ preload ↔ renderer');
const handlers = uniq([
  ...collect(mainSrc, /\bhandle\('([^']+)'/g),
  ...collect(mainSrc, /ipcMain\.handle\('([^']+)'/g),
]);
const invokes = uniq(collect(preloadSrc, /ipcRenderer\.invoke\('([^']+)'/g));
const preloadKeys = uniq(collect(preloadSrc, /^\s{2}([A-Za-z_$][\w$]*)\s*:/gm));

t(`主进程注册了 ${handlers.length} 个 handler，preload 调用 ${invokes.length} 个通道`, () => {
  assert.ok(handlers.length >= 35, 'handler 数量异常偏少，可能解析失败');
  assert.ok(invokes.length >= 35, 'invoke 数量异常偏少，可能解析失败');
});
t('preload 的每个 invoke 都有对应 handler', () => {
  const missing = invokes.filter((c) => !handlers.includes(c));
  assert.deepStrictEqual(missing, [], '缺少 handler：' + missing.join(', '));
});
t('没有从未被调用的孤儿 handler', () => {
  const orphan = handlers.filter((c) => !invokes.includes(c));
  assert.deepStrictEqual(orphan, [], '孤儿 handler：' + orphan.join(', '));
});
t('事件通道在 main 中存在发送方', () => {
  const events = uniq(collect(preloadSrc, /ipcRenderer\.on\('([^']+)'/g));
  assert.ok(events.length >= 6, '事件通道数量异常');
  const missing = events.filter((c) => !mainSrc.includes("'" + c + "'"));
  assert.deepStrictEqual(missing, [], 'main 未发送：' + missing.join(', '));
});
t('renderer 调用的 api 方法都在 preload 暴露面里', () => {
  const used = uniq([
    ...collect(appSrc, /\bapi\.([A-Za-z_$][\w$]*)\s*\(/g),
    ...collect(appSrc, /\bhermesAPI\.([A-Za-z_$][\w$]*)\s*\(/g),
    ...collect(appSrc, /\bmkApi\(\)\.([A-Za-z_$][\w$]*)\s*\(/g),
  ]);
  assert.ok(used.length >= 25, 'api 调用数量异常偏少，可能解析失败：' + used.length);
  const missing = used.filter((k) => !preloadKeys.includes(k));
  assert.deepStrictEqual(missing, [], 'preload 未暴露：' + missing.join(', '));
});

section('2. DOM 契约：HTML id ↔ app.js 引用');
const htmlIds = uniq(collect(htmlSrc, /\bid="([^"]+)"/g));
const jsIds = uniq([
  ...collect(appSrc, /\$\('#([A-Za-z0-9_-]+)'\)/g),
  ...collect(appSrc, /getElementById\('([A-Za-z0-9_-]+)'\)/g),
]);
// 不算死绑定：前三处本来就有 null 保护；后两个是抽屉渲染时才生成的节点
// （renderKanbanDetail 拼进 #kb-drawer-body，静态 index.html 里查不到）
const NULL_GUARDED = new Set(['activity', 'activity-text', 'chat-title', 'kbd-assignee', 'kbd-reassign-note']);
t(`HTML 有 ${htmlIds.length} 个 id，app.js 引用 ${jsIds.length} 个`, () => {
  assert.ok(htmlIds.length >= 100 && jsIds.length >= 80, 'id/引用数量异常，可能解析失败');
});
t('app.js 没有引用不存在的 id', () => {
  const dead = jsIds.filter((id) => !htmlIds.includes(id) && !NULL_GUARDED.has(id));
  assert.deepStrictEqual(dead, [], '死绑定：' + dead.join(', '));
});

section('3. 语法与样式基线');
const jsFiles = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith('.js')) jsFiles.push(rel);
  }
};
['main', 'preload', 'renderer', 'scripts'].forEach(walk);
t(`${jsFiles.length} 个 JS 文件全部通过 node --check`, () => {
  const bad = [];
  for (const f of jsFiles) {
    try { cp.execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
    catch (e) { bad.push(f); }
  }
  assert.deepStrictEqual(bad, [], '语法错误：' + bad.join(', '));
});
t('CSS 花括号平衡', () => {
  assert.strictEqual((cssSrc.match(/\{/g) || []).length, (cssSrc.match(/\}/g) || []).length);
});
t('亮/深两主题都定义了 --on-blue 与四级文字色', () => {
  assert.strictEqual((cssSrc.match(/--on-blue:/g) || []).length, 2, '--on-blue 应在 :root 与 [data-theme="dark"] 各定义一次');
  for (const token of ['--text:', '--text-2:', '--text-3:', '--caption:']) {
    assert.ok(cssSrc.includes(token), '缺少 ' + token);
  }
});
t('CSP 关键指令未被放宽', () => {
  const csp = (htmlSrc.match(/Content-Security-Policy[^>]*content="([^"]+)"/) || [])[1] || '';
  assert.ok(csp, '找不到 CSP meta');
  for (const d of ["default-src 'self'", "base-uri 'none'", "object-src 'none'", "form-action 'none'", 'frame-src', "connect-src 'none'"]) {
    assert.ok(csp.includes(d), 'CSP 缺少 ' + d);
  }
  assert.ok(!/'unsafe-eval'/.test(csp), 'CSP 不应允许 unsafe-eval');
  // 未显式写 script-src 时脚本策略回落到 default-src，它不能带 unsafe-inline
  // （style-src 里的 'unsafe-inline' 是内联样式所需，不在此约束内）。
  const scriptPolicy = (csp.match(/script-src[^;]*/) || csp.match(/default-src[^;]*/) || [''])[0];
  assert.ok(!/'unsafe-inline'/.test(scriptPolicy), '脚本策略允许 unsafe-inline');
});

section('3b. 用量 UI：无数据时必须复位（防跨会话串数据）');
t('输入框上沿细条已移除，上下文占用只在状态条呈现', () => {
  // 2px 高 + 左右内缩 12px + 只填 18%，实际观感是「边框断口」而非进度条，已被用户否掉
  assert.ok(!htmlIds.includes('ctx-meter'), 'HTML 仍残留 #ctx-meter');
  assert.ok(!htmlIds.includes('ctx-meter-fill'), 'HTML 仍残留 #ctx-meter-fill');
  assert.ok(!/syncContextMeter/.test(appSrc), 'JS 仍引用已删除的 syncContextMeter');
  assert.ok(!/#ctx-meter|data-ctx=/.test(cssSrc), 'CSS 仍残留细条规则');
  // 能力不能丢：状态条里必须仍能读到上下文占用
  assert.ok(htmlIds.includes('st-ctx'), '状态条缺少 #st-ctx');
  assert.ok(!htmlIds.includes('ctxbar'), '状态条仍残留上下文进度轨（2026-11-11 已按 dsh 样式移除）');
});
t('updateStatus 有复位分支，且用圆环写回上下文占比', () => {
  assert.ok(/function resetUsageUI\s*\(/.test(appSrc), 'resetUsageUI 未定义');
  const body = appSrc.slice(appSrc.indexOf('function updateStatus()'), appSrc.indexOf('function renderAttach()'));
  assert.ok(body.includes('resetUsageUI()'), 'updateStatus 缺少无用量时的复位分支');
  assert.ok(body.includes("$('#st-ctx-pct')"), 'updateStatus 未把百分比写进圆环右侧文字');
  assert.ok(body.includes('strokeDashoffset'), 'updateStatus 未更新圆环弧长（圆环永远是空环）');
});
t('上下文圆环：JS 周长与 CSS dasharray 同值，12 点起顺时针', () => {
  const m = appSrc.match(/const CTX_RING_C = ([\d.]+)/);
  assert.ok(m, '缺少 CTX_RING_C 周长常量');
  const c = Number(m[1]);
  assert.ok(Math.abs(c - 2 * Math.PI * 8) < 0.1, '周长与 r=8 不符：' + c);
  const css = cssSrc.slice(cssSrc.indexOf('.ctx-ring-arc'));
  assert.ok(/stroke-dasharray:\s*50\.27/.test(css), 'CSS dasharray 与 JS 常量不一致（环会露缝或多一截）');
  assert.ok(/rotate\(-90deg\)/.test(css), '圆环未从 12 点起画');
  assert.ok(/stroke-linecap:\s*round/.test(css), '圆环端点未做圆角');
  assert.ok(/#st-ctx\[hidden\]\s*\{\s*display:\s*none/.test(cssSrc), 'display:inline-flex 会盖掉 [hidden]，缺显式 display:none');
});
t('上下文只留细环：无进度轨，无用量整组收起', () => {
  const body = appSrc.slice(appSrc.indexOf('function resetUsageUI'), appSrc.indexOf('function updateStatus'));
  assert.ok(body.includes('ctxEl.hidden = true'), 'resetUsageUI 未收起圆环');
  assert.ok(body.includes("$('#st-ctx-pct')"), 'resetUsageUI 未清空百分比文字');
  assert.ok(!/ctxbar/.test(appSrc), 'app.js 仍残留进度轨引用（会变成死绑定）');
  assert.ok(!/ctxbar/.test(cssSrc), 'CSS 仍残留进度轨规则');
});
t('超宽代码块的可横滚提示已完整接线', () => {
  assert.ok(appSrc.includes('md-code-hint'), 'mdCodeBlock 缺少提示节点');
  assert.ok(/function syncCodeScrollHints\s*\(/.test(appSrc), 'syncCodeScrollHints 未定义');
  const body = appSrc.slice(appSrc.indexOf('function renderChat()'), appSrc.indexOf('function msgActionBar('));
  assert.ok(body.includes('syncCodeScrollHints()'), 'renderChat 未调用超宽检测');
  assert.ok(cssSrc.includes('.md-code.scroll-x .md-code-hint'), 'CSS 缺少 scroll-x 显示规则');
});

section('3c. 市场：安全默认、来源一致性与审阅组件');
const marketSrc = read('main/services/hermes-market.js');
t('来源下拉与服务白名单逐项一致', () => {
  const m = marketSrc.match(/const SOURCES = new Set\(\[([^\]]+)\]\)/s);
  assert.ok(m, '找不到 SOURCES 定义');
  const sources = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  const from = htmlSrc.indexOf('id="mk-source"');
  // 自绘下拉 <hm-select> 仍用 <option> 作静态数据源，逐项一致性照旧核对
  const select = htmlSrc.slice(from, htmlSrc.indexOf('</hm-select>', from));
  const opts = [...select.matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]).sort();
  assert.deepStrictEqual(opts, sources, '下拉缺少或多了来源，搜索会静默失败');
});
t('安装默认不自动启用、不自动下载依赖', () => {
  assert.ok(marketSrc.includes("opts.deps === true ? '--yes-deps' : '--no-deps'"), '安全默认被改回 --yes-deps');
  assert.ok(appSrc.includes('deps: !!(deps && deps.checked)'), '界面未把勾选状态传给服务');
  const confirm = appSrc.slice(appSrc.indexOf('const confirmNote = isPlugin'), appSrc.indexOf('const armed = mk.armed'));
  assert.ok(!/<input[^>]*class="mk-deps"[^>]*checked/.test(confirm), '依赖复选框不得默认勾选');
  assert.ok(confirm.includes('--no-enable --no-deps'), '确认卡未说明默认权限');
});
t('技能安装确认卡不误用插件的权限文案', () => {
  // 实跑发现：skills install 只接受 --yes，装完默认启用；旧确认卡却显示
  // 「默认保持停用 / --no-enable --no-deps」，会让用户误判技能未生效。
  assert.ok(appSrc.includes('const isPlugin = mk.kind === \'plugins\';'), '确认卡缺少按类别分支');
  assert.ok(appSrc.includes('技能安装没有停用 / 依赖开关'), '技能确认卡缺少真实权限说明');
  assert.ok(appSrc.includes('hermes skills install ${esc(it.id)} --yes'), '技能确认卡未展示实际命令');
  assert.ok(appSrc.includes('const confirmNote = isPlugin'), '风险提示未按类别区分');
  assert.ok(cssSrc.includes('.mk-perm code { font: 400 10.5px/1.4 var(--mono); color: var(--green); min-width: 0; overflow-wrap: anywhere; }'),
    '长命令需要可换行，否则确认卡会横向溢出');
});
t('只读更新检查通道两端齐备且技能页不暴露不可靠解析', () => {
  assert.ok(mainSrc.includes("handle('market:check-updates'"), '主进程缺少 market:check-updates');
  assert.ok(preloadSrc.includes("invoke('market:check-updates'"), 'preload 缺少对应 invoke');
  assert.ok(appSrc.includes('marketCheckUpdates(\'plugins\')'), '未从插件页发起检查');
  assert.ok(appSrc.includes("$('#mk-check-updates').hidden = kind !== 'plugins'"), '技能页应隐藏无结构化输出的更新检查');
});
t('安装前审阅组件已接线且文案不含私有源假设', () => {
  for (const c of ['mk-cap', 'mk-cap-row', 'mk-review', 'mk-perm', 'mk-adv', 'mk-upd']) {
    assert.ok(cssSrc.includes('.' + c), 'CSS 缺少 .' + c);
  }
  assert.ok(appSrc.includes('function mkCapHTML('), '能力声明渲染函数缺失');
  assert.ok(appSrc.includes('安装前内容预览 · 只读'), '只读预览缺少明确标题');
  assert.ok(!appSrc.includes('私有源 token'), '用户已确认没有私有源，文案应移除该假设');
});
t('详情与确认卡互斥展开，避免确认按钮被推到折叠线以下', () => {
  const clickBody = appSrc.slice(appSrc.indexOf("$('#mk-results').addEventListener('click'"), appSrc.indexOf("$('#mk-refresh').onclick"));
  assert.ok(/act === 'install'[\s\S]{0,160}mk\.expanded\.delete\(idx\)/.test(clickBody), '点安装时应收起详情');
  assert.ok(/act === 'detail'[\s\S]{0,120}mk\.confirm = null/.test(clickBody), '点详情时应收起确认卡');
});
t('市场卡片图标底色满足浅色 WCAG AA', () => {
  assert.ok(cssSrc.includes('.mk-ico { background: var(--fill-2); }'),
    '陶土图标压在 --fill-3 上仅 4.30:1，需 --fill-2 才达 4.5:1');
});

section('3d. 失败轮次：占位英文必须还原为可读错误');
t('历史投影带出 display_kind / display_metadata，且旧库缺列时安全降级', () => {
  assert.ok(sessSrc.includes('PRAGMA table_info(messages)'), '缺少 messages 列探测');
  assert.ok(sessSrc.includes('NULL AS ${name}'), '缺列时应投影为 NULL 而不是让 SQL 报错');
  for (const c of ['display_kind', 'display_metadata', 'finish_reason']) {
    assert.ok(sessSrc.includes("'" + c + "'"), 'loadHistory 未投影 ' + c);
  }
  assert.ok(sessSrc.includes('displayKind:') && sessSrc.includes('displayMetadata:'), '返回对象缺少诊断字段');
});
t('历史里的 failed_turn 先于普通助手消息匹配，不再显示占位英文', () => {
  const body = appSrc.slice(appSrc.indexOf('async function openSession('), appSrc.indexOf('/* ---------- 渲染：聊天流'));
  assert.ok(body.includes("m.displayKind === 'failed_turn'"), 'openSession 未识别失败轮次');
  assert.ok(body.indexOf("m.displayKind === 'failed_turn'") < body.indexOf("m.role === 'assistant'"),
    'failed_turn 的 role 是 assistant，必须先于普通助手分支匹配');
  assert.ok(body.includes('parseFailure(m.displayMetadata, m.content)'), '未解析 error_surface');
});
t('失败卡展示真实原因并给出切换模型 / 重试 / 原始错误入口', () => {
  for (const fn of ['parseFailure', 'failureHint', 'failureHTML', 'retryFailedTurn']) {
    assert.ok(appSrc.includes('function ' + fn + '('), '缺少 ' + fn);
  }
  assert.ok(appSrc.includes('本轮未获得模型回复'), '缺少中文标题');
  assert.ok(appSrc.includes('不可重试'), '未说明 retryable=false 的后果');
  for (const a of ['model', 'retry', 'detail']) {
    assert.ok(appSrc.includes('data-err-act="' + a + '"'), '缺少按钮 ' + a);
    assert.ok(appSrc.includes("kind === '" + a + "'"), '事件委托未处理 ' + a);
  }
  assert.ok(appSrc.includes("kind === 'model') openModelPicker()"), '切换模型未接模型选择器');
  assert.ok(appSrc.includes('bad === state.config.model'), '重试前应拦住仍不可用的旧模型');
  assert.ok(appSrc.includes('sameModel'), '应用当前模型与失效模型相同时应明确警示「新建会话也会失败」');
  assert.ok(appSrc.includes('failureHint(f, sameModel)'), '同模型时不得再建议「新建一个会话」，避免自相矛盾');
  assert.ok(cssSrc.includes('.err-hint.err-same'), '缺少同模型警示样式');
});
t('实时错误与 WS 错误也走结构化卡，而不是只剩一行英文', () => {
  assert.ok(appSrc.includes("parseFailure('', String(evt.error))"), 'result 错误未结构化');
  assert.ok(appSrc.includes('failure: parseFailure(\'\', message)'), 'onError 未结构化');
  assert.ok(appSrc.includes('failure: f'), 'renderItem 未区分结构化错误卡');
});
t('失败卡样式沿用双主题 token，长文本可换行', () => {
  for (const c of ['err-card', 'err-head', 'err-msg', 'err-chip', 'err-hint', 'err-actions', 'err-btn', 'err-raw']) {
    assert.ok(cssSrc.includes('.' + c), 'CSS 缺少 .' + c);
  }
  assert.ok(cssSrc.includes('.err-btn:focus-visible'), '按钮缺少键盘焦点样式');
  assert.ok(cssSrc.includes('.err-chip code') && cssSrc.includes('overflow-wrap: anywhere'), '长模型名可能撑破卡片');
  assert.ok(!/#[0-9a-f]{6}/i.test(cssSrc.slice(cssSrc.indexOf('.err-card'))), '失败卡不应引入硬编码颜色');
});

section('3e. 窄主区降级与模态焦点隔离（生产级可访问性）');
const compactCss = cssSrc.slice(cssSrc.indexOf('11. 窄主区降级层'));
t('主区宽度状态机齐备，且只依据 #main 实际宽度', () => {
  assert.ok(appSrc.includes('ResizeObserver'), '缺少 ResizeObserver 宽度监听');
  assert.ok(appSrc.includes("classList.toggle('compact'"), '缺少 compact 切换');
  assert.ok(/COMPACT_MAX\s*=\s*600/.test(appSrc), '紧凑阈值被改动');
  assert.ok(appSrc.includes('.observe(main)'), '未观察 #main');
  assert.ok(appSrc.includes("attributeFilter: ['style']"), '缺少侧栏宽度变化兜底（隐藏窗口下 ResizeObserver 不派发）');
  assert.ok(appSrc.includes("addEventListener('resize', syncCompactLayout)"), '缺少窗口缩放兜底');
  assert.ok(compactCss.length > 200, '缺少窄主区降级样式块');
});
t('关键控件在窄主区不被裁切：发送按钮 / 页签 / 工具栏 / 状态条', () => {
  for (const sel of ['.compact #composer-row', '.compact #composer-row .send-btn',
                     '.compact #view-tabs', '.compact .vt',
                     '.compact .pp-toolbar', '.compact .pp-search-wrap',
                     '.compact #status-strip']) {
    assert.ok(compactCss.includes(sel), '降级层缺少 ' + sel);
  }
  assert.ok(compactCss.includes('flex-wrap: wrap'), '输入行 / 工具栏未允许换行');
  assert.ok(compactCss.includes('flex-shrink: 0'), 'chip 与发送按钮未禁止挤压');
});
t('卡片网格使用可收缩最小列宽，窄容器自动退单列', () => {
  assert.ok(cssSrc.includes('minmax(min(300px, 100%), 1fr)'), 'cat-grid 固定 300px 最小列宽会撑破窄主区');
  assert.ok(cssSrc.includes('minmax(min(330px, 100%), 1fr)'), 'mk-results 固定 330px 最小列宽会撑破窄主区');
  assert.ok(!cssSrc.includes('minmax(300px, 1fr)') && !cssSrc.includes('minmax(330px, 1fr)'), '仍残留裸固定列宽');
});
t('降级层不触碰用户定版几何', () => {
  assert.ok(!/#sidebar|\.sb-brand|translateX|--sb-w/.test(compactCss), '降级层改动了侧栏 / 品牌行几何');
  assert.ok(!compactCss.includes('#chat {'), '降级层改动了聊天列对齐基准');
});
t('三个模态都有 dialog 语义与可访问名称', () => {
  for (const box of ['palette-box', 'settings-box', 'help-box']) {
    const at = htmlSrc.indexOf('class="' + box + '"');
    assert.ok(at > 0, '找不到 ' + box);
    const seg = htmlSrc.slice(at - 40, at + 220);
    assert.ok(seg.includes('role="dialog"') && seg.includes('aria-modal="true"'), box + ' 缺少 dialog 语义');
  }
  assert.ok(htmlSrc.includes('id="set-title"') && htmlSrc.includes('aria-labelledby="set-title"'), '设置弹层缺少标题关联');
  assert.ok(htmlSrc.includes('aria-labelledby="help-title"'), '帮助弹层缺少标题关联');
});
t('模态打开时整块背景 inert，关闭后焦点归还触发者', () => {
  assert.ok(/frame\.inert\s*=\s*modalOpen/.test(appSrc), '未把 #frame 设为 inert，Tab 会跑到遮罩下');
  assert.ok(/head\.inert\s*=\s*pageOpen \|\| modalOpen/.test(appSrc), '整页状态判定被改坏');
  assert.ok(appSrc.includes('modalOpener') && appSrc.includes('focus({ preventScroll: true })'), '缺少关闭后焦点归还');
  assert.ok(appSrc.includes("const fallback = $('#input')"), '触发者不可用时缺少输入框兜底（帮助层关闭会卡焦点）');
});

section('3f. 模型配置漂移：CLI 默认必须可选，且不得擅自改写用户配置');
const cfgSvcSrc = read('main/services/hermes-config.js');
t('只读模型状态通道三端齐备（handler ↔ preload ↔ renderer）', () => {
  assert.ok(mainSrc.includes("handle('hermes-config:model-state'"), '主进程缺少只读 handler');
  assert.ok(preloadSrc.includes("invoke('hermes-config:model-state')"), 'preload 缺少通道');
  assert.ok(preloadSrc.includes('configModelState:'), 'preload 未暴露方法');
  assert.ok(appSrc.includes('api.configModelState()'), '渲染层未调用');
  assert.ok(cfgSvcSrc.includes('function modelState(') && cfgSvcSrc.includes('function parseModelBlock('),
    '缺少行级解析器 / 只读快照');
  assert.ok(!/modelState[\s\S]{0,600}writeFile|renameSync/.test(cfgSvcSrc), '模型状态通道不得写文件');
});
t('parseModelBlock 限定在 model 块内，不误读 providers 段的 model/default', () => {
  assert.ok(/inBlock\s*&&\s*\/\^\\S\//.test(cfgSvcSrc), '缺少顶层块边界判定');
  assert.ok(/function scalar\(/.test(cfgSvcSrc), '缺少引号 / 注释处理');
  assert.ok(mainSrc.includes('hermesConfig') || mainSrc.includes('parseModelBlock'),
    'env 的 CLI 默认模型应复用同一解析器');
});
t('模型选择器把 CLI 默认列为首项，且不与 models.json 重复', () => {
  const rows = appSrc.slice(appSrc.indexOf('function modelRows('), appSrc.indexOf('async function openModelPicker('));
  const picker = appSrc.slice(appSrc.indexOf('async function openModelPicker('), appSrc.indexOf('function setModel('));
  assert.ok(picker.includes('readCliModelState(true)'), '打开选择器应重读 CLI 默认（外部改过 config.yaml 不能靠缓存）');
  assert.ok(rows.includes('function modelRows(') && picker.includes('modelRows('),
    '选择器必须复用共享候选列表，避免与设置页下拉规则漂移');
  assert.ok(rows.includes("tag: 'CLI 默认'"), '缺少 CLI 默认项');
  assert.ok(rows.indexOf('cliDefault') < rows.indexOf('fromState'), 'CLI 默认必须在回退列表之前');
  assert.ok(rows.includes('seen.has('), '未去重：CLI 默认与 models.json 同名会出两行');
  assert.ok(rows.includes("tag: '当前配置'"), '配置里存着清单外的模型时必须仍可见、可改');
});
t('漂移提示是非阻断浮层，唯一写配置的入口是用户点击「跟随」', () => {
  assert.ok(htmlSrc.includes('id="model-drift"') && htmlSrc.includes('role="status"'), '缺少提示条 DOM / 语义');
  assert.ok(htmlSrc.includes('id="btn-md-follow"') && htmlSrc.includes('id="btn-md-later"'), '缺少跟随 / 忽略按钮');
  const follow = appSrc.slice(appSrc.indexOf("$('#btn-md-follow').onclick"), appSrc.indexOf("$('#btn-md-later').onclick"));
  assert.ok(follow.includes('setModel(v)'), '跟随按钮未切模型');
  const drift = appSrc.slice(appSrc.indexOf('let cliModelState'), appSrc.indexOf('function modelRows('));
  assert.ok(!drift.includes('api.setConfig('), '启动检测不得自动写 userData/config.json');
  assert.ok(!drift.includes('saveConfig(') && !drift.includes('writeFile'), '启动检测不得写 CLI 配置');
  assert.ok(appSrc.includes('syncModelDrift(true)'), 'init 未做启动检测');
  assert.ok(cssSrc.includes('#composer-wrap { position: relative; }') && cssSrc.includes('.model-drift[hidden]'),
    '提示条必须 absolute 零布局占用且可隐藏');
  assert.ok(!/#[0-9a-f]{6}/i.test(cssSrc.slice(cssSrc.indexOf('10b. 模型配置漂移'), cssSrc.indexOf('11. 窄主区降级层'))),
    '提示条不应引入硬编码颜色');
});

section('3g. 设置页补全：快捷键自定义 + 记忆只读诊断');
const diagSrc = read('main/services/hermes-diagnostics.js');
t('诊断通道三端齐备，且白名单在服务层而非渲染层', () => {
  assert.ok(mainSrc.includes("handle('diagnostics:run'"), '缺少诊断 handler');
  assert.ok(mainSrc.includes("handle('diagnostics:memory-files'"), '缺少记忆文件 handler');
  assert.ok(preloadSrc.includes("invoke('diagnostics:run'") && preloadSrc.includes('diagnosticsRun:'), 'preload 未暴露');
  assert.ok(preloadSrc.includes('diagnosticsMemoryFiles:'), 'preload 未暴露记忆文件');
  assert.ok(appSrc.includes('api.diagnosticsRun(') && appSrc.includes('api.diagnosticsMemoryFiles('), '渲染层未调用');
  assert.ok(diagSrc.includes('const COMMANDS = Object.freeze('), '命令白名单应冻结在服务层');
  assert.ok(!/diagnostics:run[\s\S]{0,200}argv/.test(mainSrc), '渲染层不得传 argv');
});
t('记忆分区只做只读诊断，不暴露启停 / 重置等写操作', () => {
  const body = appSrc.slice(appSrc.indexOf('async function renderMemoryPanel('), appSrc.indexOf('function setupSettings('));
  assert.ok(body.includes("diagnosticsRun('memory:status')"), '缺少只读状态查询');
  assert.ok(body.includes('diagnosticsMemoryFiles()'), '缺少文件元信息');
  assert.ok(body.includes("configOpenFile(key)"), '缺少打开内置记忆文件入口');
  assert.ok(!body.includes("diagnosticsRun('memory:off')") && !body.includes("diagnosticsRun('memory:reset')"),
    '不得把写操作接进 UI');
  assert.ok(body.includes('不读取记忆正文'), '缺少只读声明');
  assert.ok(mainSrc.includes("hasOwnProperty.call(paths, key)"), '打开配置文件未做 key 白名单');
});
t('快捷键映射可配置且经白名单清洗，冲突与保留键被拒绝', () => {
  for (const fn of ['validCombo', 'cleanShortcuts', 'shortcutsRead', 'shortcutsSave', 'comboFromEvent', 'comboLabel']) {
    assert.ok(appSrc.includes('function ' + fn + '('), '缺少 ' + fn);
  }
  assert.ok(appSrc.includes('const SHORTCUT_DEFS'), '缺少动作定义表');
  assert.ok(/COMBO_RE\s*=/.test(appSrc), '缺少组合键格式白名单');
  assert.ok(appSrc.includes('SHORTCUT_STORE_KEY'), '缺少独立存储键');
  assert.ok(appSrc.includes('used.has(v.toLowerCase())'), '存储读取时未做冲突去重');
  assert.ok(appSrc.includes('FIXED_COMBOS'), '缺少系统保留键');
  assert.ok(appSrc.includes('shortcutCapture'), '缺少录制态');
  assert.ok(appSrc.includes('const clash = SHORTCUT_DEFS.find('), '录制时未做冲突检测');
  assert.ok(appSrc.includes('SHORTCUT_ACTIONS[hit.id]'), '全局按键未走映射分派');
});
t('设置页新增两个分区，帮助页读当前映射且不残留旧键位', () => {
  assert.ok(appSrc.includes("id: 'shortcuts', label: '快捷键'") && appSrc.includes("id: 'memory', label: '记忆'"),
    '设置页缺少新分区');
  assert.ok(appSrc.includes("cat.custom === 'shortcuts'") && appSrc.includes("cat.custom === 'memory'"),
    '新分区未接进 renderSettingsPanel');
  assert.ok(appSrc.includes('function helpGroups()') && appSrc.includes('comboLabel(m[id])'),
    '帮助页未动态读映射');
  assert.ok(appSrc.includes('renderHelp(true)'), '改键后未强制重绘帮助页');
  assert.ok(htmlSrc.includes('id="help-foot-palette"'), '帮助页脚键位未动态化');
  assert.ok(appSrc.includes("focusSearch: ()"), '帮助页宣称的 ⌘F 搜索会话仍未实现');
});
t('快捷键与记忆面板样式沿用双主题 token，无硬编码色', () => {
  const seg = cssSrc.slice(cssSrc.indexOf('10a. 设置页'), cssSrc.indexOf('10b. 模型配置漂移'));
  assert.ok(seg.includes('.sk-key') && seg.includes('.mem-status') && seg.includes('.mem-refresh'), '缺少新面板样式');
  assert.ok(!/#[0-9a-f]{6}/i.test(seg), '新面板引入硬编码颜色');
  assert.ok(seg.includes(':focus-visible'), '新控件缺少键盘焦点样式');
});

section('3h. 健康检查面板：只读、超时兜底、不误报退出码');
t('面板五项与服务层白名单逐项一致，且只经只读通道', () => {
  const body = appSrc.slice(appSrc.indexOf('const HEALTH_CHECKS'), appSrc.indexOf('function setupSettings('));
  for (const k of ['status', 'config:check', 'fallback:list', 'memory:status', 'doctor']) {
    assert.ok(body.includes("key: '" + k + "'"), '面板缺少 ' + k);
    assert.ok(diagSrc.includes("'" + k + "':"), '服务层白名单缺少 ' + k);
  }
  assert.ok(body.includes('api.diagnosticsRun(check.key)'), '未走只读诊断通道');
  assert.ok(!body.includes("diagnosticsRun('doctor', {") && !body.includes('argv'), '渲染层不得拼 argv');
  assert.ok(body.includes('runQuick') && body.includes('!x.slow'), '深度体检不应进快速检查');
});
t('doctor 退出码 1 不当作失败，且明确不自动修复 / 不真实探测', () => {
  assert.ok(appSrc.includes('hasOutput') && appSrc.includes('可能含建议'), '未区分「有建议」与真失败');
  assert.ok(appSrc.includes('const failed = !!(r && !r.hasOutput)'), '状态判定被改坏');
  assert.ok(appSrc.includes('不会修复、改写配置或安装依赖'), '缺少只读声明');
  assert.ok(!appSrc.includes('--live') || appSrc.includes('不带 --fix / --live'), '未声明禁用真实探测');
  assert.ok(diagSrc.includes("doctor: 60000"), 'doctor 实测约 41s，超时余量不足会假失败');
  assert.ok(diagSrc.includes("'--fix'") === false, '服务层不得带 --fix');
});
t('慢命令有 SIGKILL 兜底，不会永久占住串行队列', () => {
  assert.ok(diagSrc.includes("child.kill('SIGKILL')"), '缺少强杀兜底');
  assert.ok(diagSrc.includes('timedOut: true'), '超时未返回明确状态');
  assert.ok(diagSrc.includes("stdio: ['ignore'"), 'stdin 未关闭，交互式命令可能挂住');
  assert.ok(diagSrc.includes('let done = false') && diagSrc.includes('finish('), '完成态未去重，可能重复 resolve');
});
t('健康检查卡片样式可收缩，双主题 token 无硬编码色', () => {
  const seg = cssSrc.slice(cssSrc.indexOf('.hc-actions'), cssSrc.indexOf('#set-panel .pf-note'));
  assert.ok(seg.includes('minmax(min(320px, 100%), 1fr)'), '卡片固定最小列宽会撑破窄主区');
  assert.ok(seg.includes('.hc-out[hidden]') && seg.includes('max-height'), '长输出未限制高度');
  assert.ok(!/#[0-9a-f]{6}/i.test(seg), '健康检查样式引入硬编码颜色');
});

section('3i. 运行时健壮性：后端换代 / WS 生命周期 / 回合收敛');
const chatSrc = read('main/services/hermes-chat.js');
const gwSrc = read('main/services/gateway-client.js');
const backendSrc = read('main/services/hermes-backend.js');
const readmeSrc = read('README.md');

t('后端状态暴露 generation，且 ChatChannel 真的订阅了 onStatus', () => {
  assert.ok(backendSrc.includes('generation: this.generation'), '状态回调缺 generation，前端无法识别换代');
  assert.ok(/onStatus:\s*\(s\)\s*=>\s*this\._onBackendStatus\(s\)/.test(chatSrc), 'ChatChannel 未订阅后端状态');
  assert.ok(chatSrc.includes('_onBackendStatus(s)'), '缺状态分发入口');
});
t('后端换代必须关旧连接、作废旧 liveId、保留 storedId 走 resume', () => {
  assert.ok(/if \(this\.gateway\).*?this\.gateway\.close\(\)/s.test(chatSrc), '未关闭旧连接会无限重连旧端口');
  assert.ok(chatSrc.includes("_resetLiveSessions()") && chatSrc.includes("tab.liveId = ''"), '活会话 id 必须清空');
  assert.ok(chatSrc.includes('this.storedId') && chatSrc.includes("gw.rpc('session.resume'"), 'storedId 必须用于续接');
  assert.ok(chatSrc.includes('this.gatewayReady = null;'), '旧连接 promise 必须失效');
});
t('后端掉线时排队与在途回合都要收尾，不能只靠 prompt.submit 的 10 分钟超时', () => {
  const invStart = chatSrc.indexOf('_invalidateBackend(reason)');
  const invEnd = chatSrc.indexOf('_onBackendStatus(s) {', invStart);
  assert.ok(invStart > 0 && invEnd > invStart, '未定位到 _invalidateBackend 方法体');
  const inv = chatSrc.slice(invStart, invEnd);
  assert.ok(inv.includes('tab.queue.splice(0)'), '未排空队列会把新消息灌进正在重启的后端');
  assert.ok(inv.includes('q.callbacks.onClose'), '排队回合只发 onError 会让渲染层永久 running');
  assert.ok(inv.includes('turn._finish('), '在途回合未立即收尾');
  assert.ok(inv.indexOf('tab.queue.splice(0)') < inv.indexOf('turn._finish('), '必须先排空队列再收尾在途回合');
  assert.ok(chatSrc.includes('_denyAllApprovals()'), '挂起审批必须默认拒绝，不能跨后端悬挂');
});
t('_ensureGateway 失败不留孤儿连接，且过期连接不得挂上旧端口', () => {
  assert.ok(/if \(!ok\) \{ try \{ gw\.close\(\)/.test(chatSrc), '连接超时后未关闭孤儿 WS');
  assert.ok(chatSrc.includes('const stamp = this._epochStamp;'), '未记录连接建立时的后端代次');
  assert.ok(/stamp !== this\._epochStamp/.test(chatSrc), '后端换代后仍可能挂上使用旧 token 的连接');
  assert.ok(!/const \{ port \} = await/.test(chatSrc), '连接参数必须来自当前 backend');
});
t('后端退避重启不叠加 serve：start 等待、error/exit 去重、spawn 错误也排程', () => {
  assert.ok(/_restartPending\) return this\.whenReady\(\)/.test(backendSrc), '退避期 start() 仍会 spawn 第二个 serve');
  assert.ok(/if \(this\.stopped \|\| this\._restartPending/.test(backendSrc), 'error 与 exit 同时到达会重复排程');
  assert.ok(backendSrc.includes('_scheduleRestart(gen, `进程错误'), 'ENOENT 只发 error 时会永远停在 error 状态');
  assert.ok(backendSrc.includes('this._restartPending = false;'), 'stop()/定时触发后未清理排程标志');
});
// v0.23.0 起 CLI 默认「一台机器一个 machine-level gateway」：hermes -p X serve 会
// 附着到已存在的服务并立刻退出（只打印 already running，不打 READY 哨兵、端口也不是
// 我们的），桌面端会误判启动失败并无限重试。--isolated 才能拿到自己的服务与 token。
t('hermes serve 必须带 --isolated，否则新 CLI 会附着机器级服务直接退出', () => {
  const spawnArgs = (backendSrc.match(/profile\.cliArgs\(\[[^\]]*\]\)/) || [''])[0];
  assert.ok(spawnArgs.includes("'serve'"), '未定位到 serve 启动参数');
  assert.ok(spawnArgs.includes("'--isolated'"), '缺少 --isolated：会附着机器级 gateway 并拿不到 READY 哨兵');
  assert.ok(spawnArgs.includes("'--port', '0'"), '端口必须交给 OS 分配（0）');
  assert.ok(spawnArgs.includes("'--skip-build'"), '缺少 --skip-build 会触发 web UI 构建');
  assert.ok(backendSrc.includes('already running on this host'), '未记录附着语义的排障说明');
});
t('GatewayConnection：旧 socket 回调隔离、close 解绑、发送失败立即拒绝、连接中不重复建 socket', () => {
  assert.ok(/if \(this\.ws !== ws\) return;/.test(gwSrc), '旧 socket 的迟到回调会覆盖新连接状态');
  assert.ok(/readyState === WebSocket\.OPEN \|\| this\.ws\.readyState === WebSocket\.CONNECTING/.test(gwSrc), '缺少重复 connect 防护');
  assert.ok(/const ws = this\.ws;[\s\S]{0,160}this\.ws = null;[\s\S]{0,120}this\.connected = false;/.test(gwSrc), 'close 未先解绑再置 disconnected');
  assert.ok(/if \(!this\._sendRaw\([\s\S]{0,200}reject\(new Error\('gateway 未连接'\)\)/.test(gwSrc), '发送失败会把请求挂到超时');
});
t('停止语义：会话建立前也能停止、后端无 complete 时宽限期强制收尾', () => {
  assert.ok(/if \(this\.finished\) return;\s*\/\/ 即使 liveId[\s\S]{0,120}this\.aborted = true;/.test(chatSrc), 'liveId 未就绪时 abort 直接返回，停止无效');
  assert.ok(/if \(this\.aborted\) \{[\s\S]{0,180}this\._finish\(\{ exitCode: 130/.test(chatSrc), '停止后仍会提交 prompt');
  assert.ok(chatSrc.includes('this.channel._abortGraceMs') && chatSrc.includes('clearTimeout(this._abortTimer)'), '缺少强制收尾或收尾未清理定时器');
});
t('submit 的快失败路径与 onClose 异常都不能让队列卡死', () => {
  assert.ok(chatSrc.includes('const failFast = (msg)') && /cb\.onClose && cb\.onClose\(\{ exitCode: 1/.test(chatSrc), '队列满/缺 tabId 没补 close');
  assert.ok(/catch \(e\) \{ log\.warn\('chat', `onClose callback/.test(chatSrc), '回调异常会堵住 _next');
});
t('渲染层跨页签隔离：后台回合不得改写可见页签 DOM / 状态条', () => {
  const rStart = appSrc.indexOf('function routeEvent(');
  const rEnd = appSrc.indexOf('function liveActivity(', rStart);
  assert.ok(rStart > 0 && rEnd > rStart, '未定位到 routeEvent');
  const route = appSrc.slice(rStart, rEnd);
  assert.ok(route.includes('const visible = tab.id === state.activeTabId;'), '缺少可见页签判定');
  assert.ok(route.includes("if (visible && state.view === 'chat')"), 'text / thinking 分支未做可见性判断');
  assert.ok(route.includes('if (visible) { renderChat(); setActivity'), '后台 tool_use 会整页重绘');
  assert.ok(route.includes('if (visible) renderChat();'), '后台 tool_result 会整页重绘');
  assert.ok(route.includes("if (visible) { renderChat(); updateStatus(); setActivity('空闲')"), '后台回合会误置状态条');
  const textBranch = route.slice(route.indexOf("evt.type === 'text'"), route.indexOf("evt.type === 'thinking'"));
  assert.ok(textBranch.includes('chat.replaceChild(') && !textBranch.includes('renderChat()'),
    '流式文本必须单节点增量更新，按 delta 整页重建会让长会话 O(n²)');

  const cStart = appSrc.indexOf('function handleClose(');
  const cEnd = appSrc.indexOf('/* ---------- 状态条', cStart);
  const close = appSrc.slice(cStart, cEnd);
  assert.ok(close.includes('const visible = tab.id === state.activeTabId;'), 'close 未判定可见页签');
  assert.ok(close.indexOf("setActivity('空闲')") > close.indexOf('if (visible) {'), '后台 close 仍会重置状态条');
  assert.ok(appSrc.includes("if (tab.id === state.activeTabId) renderChat();"), '后台 error 仍会重绘可见页签');
});
t('草稿防抖在切页签 / 发送时取消；观察者是页面级单例且无自激循环', () => {
  assert.ok(appSrc.includes("if (inp && inp._draftTimer) { clearTimeout(inp._draftTimer); inp._draftTimer = null; }"),
    '切页签未取消草稿定时器，会用新页签的 key 保存旧输入');
  assert.ok(appSrc.includes("if ($('#input')._draftTimer) { clearTimeout($('#input')._draftTimer); $('#input')._draftTimer = null; }"),
    '发送后未取消草稿定时器');
  assert.ok(appSrc.includes("attributeFilter: ['hidden']") && appSrc.includes("attributeFilter: ['style']"),
    '观察器必须收窄属性范围，否则会自激回调');
  assert.strictEqual((appSrc.match(/new ResizeObserver\(/g) || []).length, 1, 'ResizeObserver 应只建一次');
  assert.ok(appSrc.includes('if (state.invalidTurns.size > 200) state.invalidTurns.clear();'), '失效回合集合需有上限');
});
t('README 同步运行时健壮性说明，且市场实跑表述不再自相矛盾', () => {
  assert.ok(readmeSrc.includes('运行时健壮性'), 'README 未记录本轮收敛结论');
  assert.ok(!readmeSrc.includes('未在目标机实跑'), '功能表已写「已实跑」，已知边界仍是旧表述');
  assert.ok(readmeSrc.includes('generation') || readmeSrc.includes('换代'), 'README 未说明后端换代');
  assert.ok(readmeSrc.includes('渲染层跨页签隔离'), 'README 未记录跨页签收敛');
});

section('3j. 附件链路：路径必须取真实绝对路径，且真的进到后端');

t('Electron 32+ 没有 File.path：preload 必须用 webUtils 暴露取路径能力', () => {
  assert.ok(/const \{[^}]*webUtils[^}]*\} = require\('electron'\)/.test(preloadSrc), 'preload 未引入 webUtils');
  assert.ok(preloadSrc.includes('webUtils.getPathForFile(file)'), '未用 getPathForFile 取真实路径');
  assert.ok(preloadSrc.includes('pathForFile:'), 'contextBridge 未暴露 pathForFile');
  assert.ok(!/f\.path \|\|/.test(appSrc), '仍把已移除的 File.path 当主路径，附件会退化成文件名');
});

t('附件 UI：多文件、可移除、空态不占布局，且发送时随 payload 一起走', () => {
  assert.ok(htmlSrc.includes('id="attach-list"'), '缺少附件列表容器');
  assert.ok(!htmlSrc.includes('attach-chip'), '旧的单附件 chip 未清理');
  assert.ok(!/id="file-input"[^>]*accept="image\/\*"/.test(htmlSrc), '文件选择仍只允许图片');
  assert.ok(/id="file-input"[^>]*multiple/.test(htmlSrc), '文件选择必须支持多选');
  assert.ok(appSrc.includes('function addAttachments(') && appSrc.includes('function removeAttachment('), '缺少附件增删');
  assert.ok(appSrc.includes('renderAttach()'), '附件列表未接线渲染');
  assert.ok(/attachments: state\.attachments\.length \? state\.attachments\.map\(\(a\) => a\.path\) : undefined/.test(appSrc),
    '发送时没有把附件路径交给主进程');
  assert.ok(/state\.attachments = \[\]; renderAttach\(\);/.test(appSrc), '发送后未清空附件');
  assert.ok(appSrc.includes("if (evt.type === 'notice')"), '附件失败提示没有落点');
});

t('主进程与服务层：只接受绝对路径、按类型选 RPC、提交前附加、失败不吞回合', () => {
  assert.ok(/attachments: p\.attachments/.test(mainSrc), 'IPC 未把附件透传给 ChatChannel');
  assert.ok(chatSrc.includes('const ATTACH_LIMIT = 8;'), '缺少附件数量上限');
  assert.ok(chatSrc.includes("return 'image.attach';") && chatSrc.includes("return 'pdf.attach';") && chatSrc.includes("return 'file.attach';"),
    '三类附件必须走各自的 RPC');
  assert.ok(chatSrc.includes('if (!path.isAbsolute(p)) continue;'), '相对路径可能被当成附件路径');
  assert.ok(chatSrc.includes('if (!out.includes(p)) out.push(p);'), '未按路径去重');
  const runStart = chatSrc.indexOf('async _run()');
  const submitAt = chatSrc.indexOf("gw.rpc('prompt.submit'", runStart);
  const attachAt = chatSrc.indexOf('await this._attachFiles(gw);', runStart);
  assert.ok(attachAt > 0 && attachAt < submitAt, '附件必须在 prompt.submit 之前附加（后端在回合开始时清空 attached_images）');
  const fnStart = chatSrc.indexOf('async _attachFiles(gw)');
  const fnBody = chatSrc.slice(fnStart, chatSrc.indexOf('_emit(evt)', fnStart));
  assert.ok(fnBody.includes('catch (err)') && fnBody.includes("type: 'notice'"), '附件失败必须降级为提示而不是抛错');
  assert.ok(!/throw err/.test(fnBody), '附件失败不得冒泡成整轮错误');
});

t('附件样式只用设计 token，且不撑高输入区', () => {
  assert.ok(cssSrc.includes('.attach-list {'), '缺少附件条样式');
  assert.ok(/\.attach-list\[hidden\] \{ display: none; \}/.test(cssSrc), '空附件条必须完全隐藏');
  assert.ok(/\.attach-list \{[^}]*max-height/.test(cssSrc), '附件过多会撑高 composer');
  const block = cssSrc.slice(cssSrc.indexOf('.attach-list {'), cssSrc.indexOf('/* ══════════ 11.'));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), '附件样式出现硬编码颜色，深色主题会失配');
});

t('窗口内容区自愈：漂移上报 + 唤醒校准，且不干扰正常尺寸', () => {
  assert.ok(/powerMonitor/.test(mainSrc), '主进程未监听睡眠唤醒 / 解锁');
  assert.ok(mainSrc.includes("ipcMain.on('window:viewport'"), '缺少视口上报通道');
  assert.ok(mainSrc.includes('function healViewport(') && mainSrc.includes('function scheduleViewportHeal('),
    '缺少内容区自愈实现');
  // 同值 setContentSize 不会触发重排，必须抖 1px 再复位
  assert.ok(/setContentSize\(w, h \+ 1\)/.test(mainSrc), '自愈未做 1px 抖动，AppKit 不会重新布局内容区');
  assert.ok(/b\.width - w <= 4/.test(mainSrc), '正常窗口也会触发抖动，缺漂移阈值');
  assert.ok(preloadSrc.includes('reportViewport:'), 'preload 未暴露 reportViewport');
  assert.ok(appSrc.includes('initViewportWatch') && appSrc.includes('api.reportViewport('),
    '渲染层没有上报真实视口');
});

t('状态条三段式：用量与上下文居中，模型与状态分列两端', () => {
  const at = htmlSrc.indexOf('id="status-strip"');
  const strip = htmlSrc.slice(at, at + 900);
  assert.ok(strip.includes('class="st-metrics"'), '状态条缺少居中的用量组');
  assert.ok(strip.includes('class="st-end"'), '状态条缺少右侧状态组');
  const metrics = strip.slice(strip.indexOf('st-metrics'), strip.indexOf('st-end'));
  for (const id of ['st-tokens', 'st-ctx', 'st-rounds']) {
    assert.ok(metrics.includes(id), `用量组未包含 ${id}`);
  }
  assert.ok(/#status-strip \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/.test(cssSrc),
    '状态条未用三段网格，中间组无法相对整条居中');
  assert.ok(/#status-strip > \.st-metrics \{[^}]*justify-self: center/.test(cssSrc), '用量组未居中');
  assert.ok(/#status-strip > \.st-end \{[^}]*justify-self: end/.test(cssSrc), '状态组未靠右');
});

t('会话分组入口：SVG 图标 + 可聚焦按钮，不再是 12px unicode 符号', () => {
  assert.ok(htmlSrc.includes('id="sb-quick-search"'), '缺少会话分组内的搜索入口');
  assert.ok(/id="sb-storage-btn"[^>]*class="sb-ga"/.test(htmlSrc), '存储入口未套用按钮样式');
  assert.ok(!htmlSrc.includes('title="搜索">⌕'), '仍是 unicode 搜索符号，字号过小看不清');
  assert.ok(!htmlSrc.includes('⛁'), '仍是 unicode 存储符号');
  // id 必须唯一：sb-search-btn 已被品牌行占用，新增入口不能用同名 id
  const ids = htmlSrc.match(/id="([^"]+)"/g) || [];
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  assert.deepStrictEqual(dup, [], '存在重复 id：' + dup.join(', '));
  const ga = cssSrc.slice(cssSrc.indexOf('.sb-ga {'), cssSrc.indexOf('.sb-ga {') + 400);
  assert.ok(/width: 20px; height: 20px/.test(ga), '入口点击区仍过小');
  assert.ok(appSrc.includes("$('#sb-quick-search')"), '搜索入口未接线');
});

t('窗口不越出显示器：启动与显示器变化时收拢到 workArea', () => {
  assert.ok(mainSrc.includes('function fitWindowToDisplay('), '缺少窗口收拢实现');
  assert.ok(/screen\.getDisplayMatching\(b\)\.workArea/.test(mainSrc), '未按所在显示器的可用区域计算');
  assert.ok(mainSrc.includes("screen.on('display-metrics-changed'"), '显示器分辨率变化后未重新收拢');
  assert.ok(mainSrc.includes('setTimeout(fitWindowToDisplay, 300)'), '启动后未做一次收拢');
  assert.ok(!/setInterval\(/.test(mainSrc), '不应轮询窗口位置');
});

section('3k. 消息流排版：信息行紧随消息、折叠思考条收窄');
t('消息信息行紧跟消息在文档流内，用户消息右对齐', () => {
  const i = cssSrc.indexOf('.msg-foot-row {');
  assert.ok(i > 0, '缺少 .msg-foot-row 样式');
  const block = cssSrc.slice(i, i + 420);
  assert.ok(!/position:\s*absolute/.test(block), '信息行脱离文档流 → 会悬在两条消息正中间（2026-11-11 已改回流内）');
  // dsh 实测：用户脚注是「时间 [复制]」，图标贴气泡右缘 → 用 row-reverse 让 DOM 顺序
  // 与助手消息保持一致，视觉顺序各自成立；旧写法是 justify-content:flex-end。
  assert.ok(/\.msg-user \.msg-foot-row \{[^}]*flex-direction:\s*row-reverse/.test(cssSrc),
    '用户消息信息行未反向排列（图标必须收在气泡右缘）');
  assert.ok(/\.msg-user \.msg-foot-row \{[^}]*justify-content:\s*flex-start/.test(cssSrc),
    '用户消息信息行未右对齐');
  // 用户气泡右侧必须与内容列右边缘对齐
  assert.ok(/\.msg-user \{[^}]*align-items:\s*flex-end/.test(cssSrc), '用户消息未右对齐');
});
t('折叠态思考条按内容收窄，不横贯整列', () => {
  assert.ok(/\.think-box:not\(\[open\]\) \{ width: fit-content/.test(cssSrc), '折叠态思考条仍占满整列宽度');
  assert.ok(/\.think-box \{[^}]*max-width: 100%/.test(cssSrc), '思考条缺少宽度上限');
  assert.ok(htmlSrc.length > 0 && appSrc.includes('class="think-box"'), '思考条标记与样式不同步');
});
t('最后一条消息不贴输入框（#chat 底部内边距）', () => {
  const i = cssSrc.indexOf('#chat { max-width');
  assert.ok(i > 0, '未找到 #chat 宽度定义');
  const block = cssSrc.slice(i, i + 120);
  const m = block.match(/padding:\s*0 24px (\d+)px/);
  assert.ok(m, '#chat 内边距不再是 0 24px Npx 形式');
  // 信息行早已回到文档流（常显），不再需要 26px 让它「露出来」；
  // 但最后一条消息仍要有呼吸区，同时不能像原来 30px 那样松（用户 2026-11-11 反馈「聊天下面的间距太大」）
  assert.ok(Number(m[1]) >= 12, '#chat 底部内边距过小，最后一条消息会贴住输入框');
  assert.ok(Number(m[1]) <= 20, '#chat 底部内边距过大，聊天下面会空出一截');
});
t('字号是单一旋钮：--ui-fs 派生全站，设置一改整片同步', () => {
  assert.ok(/--ui-fs:\s*16px/.test(cssSrc), '缺少字号基准 --ui-fs');
  assert.ok(/--msg-font-size:\s*var\(--ui-fs\)/.test(cssSrc), '正文字号没有接到 --ui-fs 上');
  assert.ok(/--fs-xs:\s*calc\(var\(--ui-fs\)\s*\*\s*0\.75\)/.test(cssSrc), '缺 --fs-xs 派生（信息行/时间/状态条）');
  assert.ok(/--fs-sm:\s*calc\(var\(--ui-fs\)\s*\*\s*0\.875\)/.test(cssSrc), '缺 --fs-sm 派生（摘要行/chip）');
  // 输入框必须与正文同字号；写死 px 就会出现「只有正文变大、输入框纹丝不动」
  const inp = cssSrc.slice(cssSrc.indexOf('#input {'), cssSrc.indexOf('#input::placeholder'));
  assert.ok(/font-size:\s*var\(--ui-fs\)/.test(inp), '输入框字号没跟基准走');
  assert.ok(!/font:\s*400\s*\d+px/.test(inp), '输入框还在用固定 px 的 font 简写');
  // 小字必须用派生值，不能再写死 12px
  const usage = cssSrc.slice(cssSrc.indexOf('.msg-usage {'), cssSrc.indexOf('.msg-usage .mu-ico'));
  assert.ok(/font-size:\s*var\(--fs-xs\)/.test(usage), '用量字号写死了，不随设置缩放');
  const ts = cssSrc.slice(cssSrc.indexOf('.msg-ts {'), cssSrc.indexOf('.msg-ts {') + 160);
  assert.ok(/font-size:\s*var\(--fs-xs\)/.test(ts), '时间字号写死了，不随设置缩放');
  const strip = cssSrc.slice(cssSrc.indexOf('#status-strip {'), cssSrc.indexOf('#status-strip >'));
  assert.ok(/font-size:\s*var\(--fs-xs\)/.test(strip), '状态条字号写死了，不随设置缩放');
  // 摘要行要比正文小一级，否则元信息抢正文的视觉重量
  const meta = cssSrc.slice(cssSrc.indexOf('.turn-meta {'), cssSrc.indexOf('.turn-meta {') + 320);
  assert.ok(/font-size:\s*var\(--fs-sm\)/.test(meta), '回合摘要行字号未比正文降一级');
  // 设置写进基准变量，派生值才会一起动
  assert.ok(/style\.setProperty\('--ui-fs'/.test(appSrc), 'applySettings 没写 --ui-fs，改字号不会同步');
});

section('3l. 会话导出：格式白名单 + 路径由主进程决定');
const exportSrc = read('main/services/hermes-export.js');
t('导出格式是白名单，渲染层只能传键名', () => {
  assert.ok(/FORMATS = Object\.freeze\(\{ md: '\.md', html: '\.html', jsonl: '\.jsonl' \}\)/.test(exportSrc), '导出格式白名单被改动或放宽');
  assert.ok(exportSrc.includes("if (!ext) return { ok: false, error: '不支持的导出格式' }"), '缺少未知格式的拒绝分支');
});
t('会话 id 过正则白名单，且走 execFile 不经 shell', () => {
  assert.ok(/function validSessionId/.test(exportSrc), '缺少 sessionId 校验');
  assert.ok(exportSrc.includes('execFile('), '必须用 execFile（无 shell）');
  assert.ok(!/exec\(|execSync\(|shell:\s*true/.test(exportSrc), '导出链路出现了 shell 执行');
});
t('导出目标路径由主进程保存对话框决定，渲染层拿不到任意可写路径', () => {
  const i = mainSrc.indexOf("handle('sessions:export'");
  assert.ok(i > 0, '缺少 sessions:export handler');
  const block = mainSrc.slice(i, i + 1600);
  assert.ok(block.includes('dialog.showSaveDialog'), '未弹保存对话框，等于让渲染层指定任意路径');
  assert.ok(block.includes('hermesExport.exportSession'), 'handler 未调用导出服务');
  assert.ok(block.includes('BrowserWindow.fromWebContents'), '对话框未挂到发起窗口，会出现游离模态');
  assert.ok(!/outPath\s*[:=]\s*a\./.test(block), '仍接受渲染层传入的 outPath');
});
t('会话菜单有三个导出入口且已接线', () => {
  for (const fmt of ['md', 'html', 'jsonl']) {
    assert.ok(appSrc.includes(`data-act="export" data-fmt="${fmt}"`), '会话菜单缺少 ' + fmt + ' 导出入口');
  }
  assert.ok(appSrc.includes('api.exportSession('), '导出入口未接线到 IPC');
  assert.ok(preloadSrc.includes("invoke('sessions:export'"), 'preload 未暴露导出通道');
  assert.ok(/\.session-menu \{[^}]*max-height/.test(cssSrc), '菜单加了条目后需要高度上限，否则小窗口下底部按钮不可见');
});

section('3m. 工具集开关：只动 cli 平台，状态以 CLI 回读为准');
const toolsSrc = read('main/services/hermes-tools.js');
t('解析与开关都在主进程，渲染层只拿结构化结果', () => {
  assert.ok(/function parseToolList/.test(toolsSrc), '缺少列表解析');
  assert.ok(/const NAME_RE = /.test(toolsSrc), '缺少工具名白名单');
  assert.ok(mainSrc.includes("handle('tools:list'"), 'main 缺少 tools:list');
  assert.ok(mainSrc.includes("handle('tools:toggle'"), 'main 缺少 tools:toggle');
  assert.ok(preloadSrc.includes("invoke('tools:list'") && preloadSrc.includes("invoke('tools:toggle'"), 'preload 未暴露工具集通道');
  assert.ok(appSrc.includes('api.toolsList()') && appSrc.includes('api.toolsToggle('), '设置页未接线');
  // 渲染层不得自己解析 CLI 文本（格式随版本变）
  assert.ok(!/enabled\\s\+\\S\+/.test(appSrc), '渲染层出现了对 CLI 文本的解析');
});
t('只返回 cli 分段，其它平台不展示不可改', () => {
  assert.ok(/s\.platform === 'cli'/.test(toolsSrc), '未按 cli 平台过滤分段');
  assert.ok(/otherPlatforms/.test(toolsSrc), '未把「还有其它平台」告知渲染层');
});
t('开关后回读确认，状态未变则明确报错', () => {
  // 回读必须走「不走缓存」的 readListRaw：列表默认读缓存，回读读缓存就会把
  // 开关之前的状态当成结果，等于自欺欺人
  assert.ok(/const after = await readListRaw\(\)/.test(toolsSrc), '开/关后没有真回读列表');
  assert.ok(!/async function readListRaw\(\)[\s\S]{0,200}listTools\(/.test(toolsSrc), 'readListRaw 不得回头读缓存');
  assert.ok(/hit\.enabled !== !!enabled/.test(toolsSrc), 'CLI 静默失败会被当成成功');
  // 设置页必须处理失败分支（把开关拨回 + 提示）
  const i = appSrc.indexOf('function toolRow(');
  const block = appSrc.slice(i, i + 3600);
  assert.ok(block.includes('sw.classList.toggle(\'on\', prev)'), '失败时未回滚开关');
  assert.ok(block.includes('aria-checked'), '开关缺少 aria-checked');
  assert.ok(block.includes('label.textContent = item.label'), 'CLI 文本未走 textContent（存在注入风险）');
});
t('设置页注册了「工具集」分区并接入面板', () => {
  assert.ok(/id: 'tools', label: '工具集', ico: '[^']+', custom: 'tools'/.test(appSrc), '缺少工具集分类');
  assert.ok(appSrc.includes("cat.custom === 'tools'"), '分类未路由到面板');
});

section('3n. 会话内查找：零布局占用、不改 DOM、Esc 不误中断');
t('查找条结构齐备且不占布局', () => {
  for (const id of ['find-bar', 'find-input', 'find-count', 'find-prev', 'find-next', 'find-close', 'btn-find']) {
    assert.ok(htmlIds.includes(id), 'HTML 缺少 #' + id);
  }
  const i = cssSrc.indexOf('.find-bar {');
  assert.ok(i > 0, '缺少 .find-bar 样式');
  const block = cssSrc.slice(i, i + 300);
  assert.ok(/position:\s*absolute/.test(block), '查找条必须在文档流外，否则会挤压定版几何');
  assert.ok(!/position:\s*fixed/.test(block), '不应使用 fixed（窗口内浮层用 absolute 即可）');
});
t('高亮走 Custom Highlight API，不往 #chat 插节点', () => {
  assert.ok(appSrc.includes("CSS.highlights.set('hermes-find'"), '未使用 Custom Highlight API');
  assert.ok(appSrc.includes("CSS.highlights.set('hermes-find-active'"), '缺少当前命中的独立高亮');
  assert.ok(/::highlight\(hermes-find\)/.test(cssSrc), 'CSS 缺少 ::highlight 规则');
  assert.ok(/::highlight\(hermes-find-active\)[^}]*background-color:\s*var\(--blue\)/.test(cssSrc), '当前命中没有实色底');
  // 关键：查找不得改写 #chat 的 DOM（流式重建会被打断）
  const i = appSrc.indexOf('function findCollect');
  const block = appSrc.slice(i, i + 1500);
  assert.ok(!block.includes('appendChild') && !block.includes('innerHTML'), '查找过程改写了 DOM');
});
t('⌘F 上下文分派：有会话走查找，空态回落侧栏搜索', () => {
  assert.ok(/function hasOpenTranscript/.test(appSrc), '缺少「是否已打开会话」判定');
  const i = appSrc.indexOf('focusSearch: () =>');
  const block = appSrc.slice(i, i + 260);
  assert.ok(block.includes('findOpen()'), '⌘F 未接会话内查找');
  assert.ok(block.includes('session-search'), '空态未回落到侧栏搜索');
});
t('Esc 先关查找条，且输入框内 Esc 不冒泡（不误中断生成）', () => {
  // 用分支内注释定位，不绑定 Escape 后第一行（拖动取消插在最前面，属预期）
  const i = appSrc.indexOf('// 统一按「最上层优先」收起');
  assert.ok(i > 0, '未找到统一 Esc 分支');
  const order = appSrc.slice(i, i + 400);
  assert.ok(order.indexOf('FIND_STATE.open') > 0 && order.indexOf('FIND_STATE.open') < order.indexOf('help-modal'),
    '查找条不在 Esc 处理的最上层');
  const inputBlock = appSrc.slice(appSrc.indexOf('input.addEventListener(\'keydown\''), appSrc.indexOf('input.addEventListener(\'keydown\'') + 700);
  assert.ok(/preventDefault\(\); e\.stopPropagation\(\);/.test(inputBlock), '输入框 Esc 未阻断冒泡，会顺带中断回合');
});
t('流式重建后重算命中（MutationObserver）', () => {
  assert.ok(/new MutationObserver/.test(appSrc.slice(appSrc.indexOf('function wireFindBar'), appSrc.indexOf('function wireFindBar') + 2200)),
    '缺少聊天区变化后的命中重算');
});

t('搜索结果点进会话时带上查询词，直接落到命中处', () => {
  const i = appSrc.indexOf('const carry = s.fulltext ? query : ');
  assert.ok(i > 0, '搜索结果点击未传递查询词');
  const block = appSrc.slice(i, i + 420);
  assert.ok(block.includes('findOpen(carry)'), '未在会话加载后自动打开查找');
  assert.ok(block.includes('t.sessionId === s.id'), '未校验目标会话（过期响应会抢焦点）');
  assert.ok(/s\.fulltext \? query : ''/.test(block), '标题命中也会自动开查找，可能得到 0/0');
});

section('3o. MCP 服务器管理：白名单 argv、只读测试、写后回读');
const mcpSrc = read('main/services/hermes-mcp.js');
t('CLI 调用统一 execFile 无 shell、带 -p profile、串行队列 + 超时强杀', () => {
  // 内部封装函数也叫 exec（本地 Promise 包装），因此不按函数名判 shell，
  // 而是核对 child_process 只解构了 execFile，且没有任何 shell / 同步执行入口。
  assert.ok(/const \{ execFile \} = require\('child_process'\)/.test(mcpSrc), 'child_process 引入了 execFile 之外的执行入口');
  assert.ok(/execFile\(HERMES_BIN, profile\.cliArgs\(argv\)/.test(mcpSrc), '未用 execFile + 数组 argv 调用 CLI');
  assert.ok(!/execSync\(|shell:\s*true|spawn\(|require\('child_process'\)\.exec/.test(mcpSrc), 'MCP 链路出现 shell / 同步执行');
  assert.ok(/profile\.cliArgs\(argv\)/.test(mcpSrc), '未带 -p <profile>，会读到 CLI 的 sticky 默认');
  assert.ok(/let queue = Promise\.resolve\(\)/.test(mcpSrc) && /function enqueue\(/.test(mcpSrc), '缺少串行队列');
  assert.ok(/SIGKILL/.test(mcpSrc) && /function exec\(/.test(mcpSrc), '缺少超时强杀兜底');
});
t('服务器名/URL 白名单：拒绝 file://、任意内网 http 与 shell 元字符', () => {
  assert.ok(/const NAME_RE = /.test(mcpSrc) && /const HTTPS_RE = /.test(mcpSrc), '缺少名称/URL 正则');
  assert.ok(/LOCAL_HTTP_RE/.test(mcpSrc), '未单独放行本机 http');
  assert.ok(mcpSrc.includes('function validName(') && mcpSrc.includes('function validUrl('), '缺少校验函数');
  assert.ok(/if \(!validName\(name\)\)/.test(mcpSrc), '名称未在 spawn 前校验');
  assert.ok(/if \(!validUrl\(url\)\)/.test(mcpSrc), 'URL 未在 spawn 前校验');
});
t('添加只走 --url，喂默认换行避开 CLI 的 TTY 工具选择；失败不落配置', () => {
  const i = mcpSrc.indexOf('function addServer(');
  const block = mcpSrc.slice(i, i + 1300);
  assert.ok(block.includes("'--url'"), '添加未使用 --url');
  assert.ok(block.includes("input: '\\n'"), '非 TTY 下必须喂默认换行，否则 input() EOF 会取消添加');
  assert.ok(!block.includes("'--args'"), 'stdio --args 是 REMAINDER，桌面端不可靠，不应放行');
  assert.ok(/Failed to connect\|Save config anyway/.test(block), '连接失败时未识别 CLI 的不保存结果');
});
t('增删后回读列表确认，回读失败返回 warning 而非谎称失败', () => {
  assert.ok(/async function readBack\(/.test(mcpSrc), '缺少回读');
  assert.ok(/await exec\(\['mcp', 'list'\]\)/.test(mcpSrc), '回读不是真实 CLI 列表');
  assert.ok(/warning:/.test(mcpSrc), '回读失败没有给 UI 明确警示');
  assert.ok(mcpSrc.includes('return await readBack(\'添加\')') && mcpSrc.includes('return await readBack(\'移除\')'),
    '增删未走回读');
});
t('三层接线与设置页分类齐备', () => {
  for (const ch of ['mcp:list', 'mcp:test', 'mcp:add', 'mcp:remove']) {
    assert.ok(mainSrc.includes(`handle('${ch}'`), 'main 缺少 ' + ch);
    assert.ok(preloadSrc.includes(`invoke('${ch}'`), 'preload 缺少 ' + ch);
  }
  for (const k of ['api.mcpList()', 'api.mcpTest(', 'api.mcpAdd(', 'api.mcpRemove(']) {
    assert.ok(appSrc.includes(k), '渲染层未调用 ' + k);
  }
  assert.ok(/id: 'mcp', label: 'MCP 服务器'/.test(appSrc), '缺少 MCP 设置分类');
  assert.ok(appSrc.includes("cat.custom === 'mcp'"), 'MCP 分类未路由到面板');
});

section('3p. 定时任务：默认暂停、动作白名单、二次确认与代次守卫');
const cronSrc = read('main/services/hermes-cron.js');
t('新建恒为 --paused，不因渲染层传参变成「创建即跑」', () => {
  assert.ok(/argv\.push\('--paused'\)/.test(cronSrc), '缺少 --paused 安全默认');
  assert.ok(/void paused;/.test(cronSrc), '渲染层的 paused 参数不得影响安全默认');
  const i = cronSrc.indexOf('function create(');
  assert.ok(cronSrc.slice(i, i + 900).indexOf("argv.push('--paused')") > 0, '--paused 未在创建链路内');
});
t('动作是固定白名单，任务 id / 调度 / 文本都在 spawn 前校验', () => {
  assert.ok(/const ACTIONS = Object\.freeze\(\{ pause: 'pause', resume: 'resume', run: 'run', remove: 'remove' \}\)/.test(cronSrc),
    '动作白名单被改动或放宽');
  assert.ok(/if \(!cmd\)/.test(cronSrc) && /if \(!validJobId\(jobId\)\)/.test(cronSrc), '动作/id 未校验');
  assert.ok(/if \(!validSchedule\(schedule\)\)/.test(cronSrc), '调度表达式未校验');
  assert.ok(/!v\.startsWith\('-'\)\s*;/.test(cronSrc) || /v\.startsWith\('-'\)/.test(cronSrc),
    '未拒绝以 - 开头的 positional（会被 argparse 当成选项）');
  assert.ok(/CONTROL_RE/.test(cronSrc), '缺少控制字符过滤');
  assert.ok(!/execSync\(|shell:\s*true/.test(cronSrc), 'cron 链路出现 shell 执行');
  assert.ok(/profile\.cliArgs\(argv\)/.test(cronSrc), '未带 -p <profile>');
  assert.ok(/SIGKILL/.test(cronSrc) && /let queue = Promise\.resolve\(\)/.test(cronSrc), '缺少串行队列与超时强杀');
});
t('写操作后回读 cron list --all，并返回结构化任务列表', () => {
  assert.ok(/await exec\(\['cron', 'list', '--all'\]\)/.test(cronSrc), '回读不是 --all 真实列表');
  assert.ok(/jobs: parseCronList\(after\.text\)/.test(cronSrc), '回读结果未结构化');
  assert.ok(/warning:/.test(cronSrc), '回读失败没有警示');
});
t('三层接线、分类注册、危险操作必须二次确认', () => {
  for (const ch of ['cron:overview', 'cron:runs', 'cron:action', 'cron:create']) {
    assert.ok(mainSrc.includes(`handle('${ch}'`), 'main 缺少 ' + ch);
    assert.ok(preloadSrc.includes(`invoke('${ch}'`), 'preload 缺少 ' + ch);
  }
  for (const k of ['api.cronOverview()', 'api.cronRuns(', 'api.cronAction(', 'api.cronCreate(']) {
    assert.ok(appSrc.includes(k), '渲染层未调用 ' + k);
  }
  assert.ok(/id: 'cron', label: '定时任务'/.test(appSrc) && appSrc.includes("cat.custom === 'cron'"), '缺少定时任务分类');
  assert.ok(/function opConfirm\(/.test(appSrc), '缺少危险操作确认卡');
  assert.ok((appSrc.match(/opConfirm\(/g) || []).length >= 7, '暂停/恢复/运行/移除/创建/添加/移除未全部走确认卡');
  assert.ok(/async function write\(fn, okMsg, failMsg\)/.test(appSrc), '缺少统一的写操作失败处理');
});
t('异步面板有代次守卫，表单 Esc 不冒泡关掉整个设置页', () => {
  assert.ok(/settingsPanelEpoch\+\+/.test(appSrc), '切分类后旧 CLI 响应会写进新面板');
  assert.ok(/const alive = \(\) => epoch === settingsPanelEpoch/.test(appSrc), '两个面板缺少过期响应检查');
  assert.ok(/function guardFieldKey\(/.test(appSrc) && /e\.stopPropagation\(\)/.test(appSrc.slice(appSrc.indexOf('function guardFieldKey('), appSrc.indexOf('function guardFieldKey(') + 400)),
    '表单 Esc 未阻断冒泡');
});
t('新样式只用设计 token，空结果与隐藏区不占布局', () => {
  const i = cssSrc.indexOf('/* ══════════ 设置页：MCP 服务器 / 定时任务');
  assert.ok(i > 0, '缺少两个面板的样式段');
  const block = cssSrc.slice(i);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), '新样式出现硬编码颜色，深色主题会失配');
  assert.ok(/\.op-out\[hidden\] \{ display: none; \}/.test(block), '隐藏的输出区仍占空间');
  assert.ok(/minmax\(min\(230px, 100%\), 1fr\)/.test(block), '卡片网格在窄设置页会撑破');
});

section('3q. 设置页默认模型：状态对照、只写桌面端配置、代次守卫');
const dmBlockSrc = appSrc.slice(appSrc.indexOf('function buildDefaultModelBlock('), appSrc.indexOf('async function renderModelPanel('));
const dmPanelSrc = appSrc.slice(appSrc.indexOf('async function renderModelPanel('), appSrc.indexOf('function shortcutsReset('));
t('模型面板首屏是默认模型区块，主按钮与双状态对照齐备', () => {
  assert.ok(dmBlockSrc.includes("'设为默认模型'"), '缺少「设为默认模型」主按钮');
  assert.ok(dmBlockSrc.includes("'跟随 CLI 默认'"), '缺少跟随 CLI 默认的快捷入口');
  assert.ok(dmPanelSrc.includes('panel.appendChild(buildDefaultModelBlock(ms, models))'), '默认模型区块未挂到面板');
  assert.ok(appSrc.indexOf('panel.appendChild(buildDefaultModelBlock') < appSrc.indexOf('>提供商<'),
    '默认模型必须排在「模型提供商」之前：状态 → 操作 → 来源');
  assert.ok(dmBlockSrc.includes("mkRow('当前默认')") && dmBlockSrc.includes("mkRow('CLI 默认')"),
    '缺少桌面端 / CLI 双状态对照');
  assert.ok(dmBlockSrc.includes("setAttribute('aria-live', 'polite')"), '状态变化需可播报');
  assert.ok(dmBlockSrc.includes('modelRows(ms, models, state.config.model)'), '下拉必须复用共享候选列表');
});
t('唯一写入口是 setModel → cfg:set，绝不改 CLI 的全局默认', () => {
  assert.ok(dmBlockSrc.includes('setModel(v)') && dmBlockSrc.includes('setModel(cliDefault)'),
    '两个入口都要走唯一写配置函数');
  assert.ok(!/config\s+set|writeFile|saveConfig/.test(dmBlockSrc), '默认模型区块不得触碰 CLI 配置文件');
  const setModel = appSrc.slice(appSrc.indexOf('function setModel('), appSrc.indexOf('function openEffortPicker('));
  assert.ok(setModel.includes('api.setConfig({ model: state.config.model })'), 'setModel 未写桌面端 config.json');
  assert.ok(mainSrc.includes("handle('cfg:set'") && preloadSrc.includes('setConfig:'), 'cfg:set 三层接线断开');
});
t('async 面板切换后旧响应不得写进新面板', () => {
  assert.ok(dmPanelSrc.includes('const epoch = settingsPanelEpoch') && dmPanelSrc.includes('if (!alive()) return'),
    '模型面板缺少 settingsPanelEpoch 代次守卫（同一个 #set-panel 会被旧响应污染）');
  assert.ok(dmPanelSrc.includes('Promise.all('), '三路只读应并行，避免串行冷启动');
});
t('下拉 Esc 只失焦，不冒泡关掉设置页 / 中断生成', () => {
  assert.ok(dmBlockSrc.includes('guardFieldKey(select, () => select.blur())'), 'select 未阻断 Escape 冒泡');
});
t('默认模型样式只用设计 token，双主题与窄面板自动适配', () => {
  const dm = cssSrc.slice(cssSrc.indexOf('设置页 · 模型 / 默认模型'));
  assert.ok(dm.includes('.dm-state') && dm.includes('.dm-select') && dm.includes('.dm-tag'), '缺少核心样式类');
  assert.ok(dm.includes('var(--'), '未使用设计 token');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(dm), '出现硬编码色值，会破坏深色主题');
  assert.ok(dm.includes(':focus-visible'), '键盘焦点不可见');
  assert.ok(/@media \(max-width: 720px\)/.test(dm), '窄设置页缺少回落');
  assert.ok(dm.includes('min-width: 0') && dm.includes('overflow-wrap'), '长模型名可能撑破面板');
});

section('3r. Kanban 看板：受控读写 + 派发、token 不出主进程、代次守卫');
const kbSrc = read('main/services/hermes-kanban.js');
// 切片锚点用注释标题而不是某个常量名：常量重构改名时不会让整段断言静默失空
const KB_ANCHOR = 'Kanban 看板（CLI 原生任务队列）';
const kbAppSrc = appSrc.slice(appSrc.indexOf(KB_ANCHOR), appSrc.indexOf('setupSettings();'));
const kbCss = cssSrc.slice(cssSrc.indexOf('Kanban 看板（CLI 原生任务队列）'));

t('四层接线齐备：页面 DOM、两个入口、IPC、preload、renderer', () => {
  assert.ok(htmlSrc.includes('id="kanban-page"') && htmlSrc.includes('class="subpage"'), '缺少看板整页');
  assert.ok(htmlSrc.includes('id="btn-kanban"') && htmlSrc.includes('id="btn-kanban-ir"'), '缺少侧栏 / 图标栏入口');
  for (const ch of ['kanban:board', 'kanban:task', 'kanban:overview', 'kanban:run',
    'kanban:create-task', 'kanban:create-board', 'kanban:delete-task',
    'kanban:submit-task', 'kanban:reassign', 'kanban:dispatch-task',
    'kanban:dispatch', 'kanban:workers']) {
    assert.ok(mainSrc.includes("handle('" + ch + "'"), 'main 缺少 handler ' + ch);
    assert.ok(preloadSrc.includes("ipcRenderer.invoke('" + ch + "'"), 'preload 缺少通道 ' + ch);
  }
  for (const fn of ['kanbanBoard', 'kanbanTask', 'kanbanOverview',
    'kanbanCreateTask', 'kanbanCreateBoard', 'kanbanDeleteTask',
    'kanbanSubmitTask', 'kanbanReassign', 'kanbanDispatchTask',
    'kanbanDispatch', 'kanbanActiveWorkers']) {
    assert.ok(kbAppSrc.includes('a.' + fn + '(') || kbAppSrc.includes('api.' + fn + '('), 'renderer 未调用 ' + fn);
  }
  assert.ok(mainSrc.includes('chat.backendInfo()'), '主进程未把后端只读快照注入看板客户端');
  assert.ok(read('main/services/hermes-chat.js').includes('backendInfo()'), 'ChatChannel 缺少 backendInfo 快照');
});
t('会话 token 只存在于主进程服务层', () => {
  assert.ok(kbSrc.includes("'X-Hermes-Session-Token': info.token"), '服务层未注入会话 token');
  assert.ok(!preloadSrc.includes('X-Hermes-Session-Token'), 'preload 不应接触 token');
  assert.ok(!appSrc.includes('X-Hermes-Session-Token'), 'renderer 不应接触 token');
  assert.ok(!appSrc.includes('HERMES_DASHBOARD_SESSION_TOKEN'), 'renderer 不应读环境变量里的 token');
  assert.ok(!appSrc.includes('backend.token'), 'renderer 不应直接读后端 token');
  assert.ok(!kbAppSrc.includes('127.0.0.1'), 'renderer 不应自己拼后端地址');
});
t('读写边界：读固定 GET，写只有六条白名单，危险端点一律不暴露', () => {
  assert.ok(kbSrc.includes("requestJSON(info, 'GET', pathWithQuery, null)"), '读端点未固定 GET');
  assert.ok(kbSrc.includes("method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE'"),
    '写方法未收窄');
  assert.ok(kbSrc.includes('function buildWritePath'), '缺少写路径白名单');
  for (const op of ['createTask', 'createBoard', 'deleteTask', 'submitTask', 'reassign', 'dispatch']) {
    assert.ok(kbSrc.includes("case '" + op + "':"), '缺少写端点 ' + op);
  }
  assert.ok(kbSrc.includes('TASK_ID_RE.test(String(p.taskId'), '任务 id 未过正则');
  assert.ok(!kbSrc.includes('execFile') && !kbSrc.includes('child_process') && !kbSrc.includes('spawn('),
    '不得新起 CLI 子进程');
  assert.ok(!kbSrc.includes('sqlite3') && !kbSrc.includes('kanban.db\''), '不得直读 kanban.db');
  for (const op of ['board', 'task', 'run', 'stats', 'assignees', 'boards', 'config', 'diagnostics', 'workers']) {
    assert.ok(kbSrc.includes("case '" + op + "':"), '缺少只读端点 ' + op);
  }
  assert.ok(kbSrc.includes('default: return null'), '白名单之外必须拒绝');
  for (const bad of ["'/decompose'", "'/tasks/bulk'", "'/specify'", "'/estimate'", "'/links'",
    "'/reclaim'", "'/terminate'", "'/orchestration'"]) {
    assert.ok(!kbSrc.includes(bad), '不得暴露端点 ' + bad);
  }
});
t('派发边界：默认 dry-run、显式才真跑、上限 4、串行、提交状态写死', () => {
  assert.ok(kbSrc.includes("case 'dispatch':") && kbSrc.includes("return '/dispatch?' + q.toString()"),
    '派发路径不固定');
  assert.ok(kbSrc.includes("p.dryRun === false ? 'false' : 'true'"), 'dry_run 缺省必须是 true');
  assert.ok(kbSrc.includes('o.dryRun !== false'), '客户端缺省必须是纯预览');
  assert.ok(kbSrc.includes('const DISPATCH_MAX_SPAWN = 4'), '单次启动上限缺失');
  assert.ok(kbSrc.includes('clampMaxSpawn(p.max)'), 'max 未做上限收敛');
  assert.ok(kbSrc.includes('dispatchBusy'), '缺少并发串行锁');
  assert.ok(kbSrc.includes("const SUBMIT_STATUS = 'ready'") && kbSrc.includes('{ status: SUBMIT_STATUS }'),
    'PATCH body 必须由服务层写死');
  assert.ok(kbSrc.includes('const WORKER_FIELDS'), '活跃 worker 缺少字段白名单');
  const wf = kbSrc.slice(kbSrc.indexOf('const WORKER_FIELDS'), kbSrc.indexOf('function strList'));
  for (const bad of ['worker_pid', 'claim_lock', 'claim_expires', 'last_heartbeat_at']) {
    assert.ok(!wf.includes("'" + bad + "'"), 'worker 投影泄漏 ' + bad);
  }
  const pdf = kbSrc.slice(kbSrc.indexOf('function projectDispatch'), kbSrc.indexOf('function projectWorkers'));
  assert.ok(!pdf.includes('workspace_path'), '派发投影出现工作区路径字段');
  assert.ok(pdf.includes('taskId: str(x[0], 80), assignee: str(x[1], 80)'),
    'spawned 三元组必须截断成 id + 受让人');
});
t('新建边界：默认收集箱、幂等键、绝不改 CLI 当前看板指针', () => {
  assert.ok(kbSrc.includes("const CREATE_STATUSES = Object.freeze(['triage', 'ready'])"), '起始状态白名单缺失');
  assert.ok(kbSrc.includes("triage: status !== 'ready'"), '默认必须停在 triage，不能被派发');
  assert.ok(kbSrc.includes('IDEMPOTENCY_RE.test(key)') && kbSrc.includes('idempotency_key: key'), '缺少幂等键');
  assert.ok(kbSrc.includes('function cleanTaskInput') && kbSrc.includes('function cleanBoardInput'), '写 body 未清洗');
  assert.ok(!kbSrc.includes('switch:'), 'createBoard 不得传 switch，避免改 CLI current 指针');
  assert.ok(kbSrc.includes("case 'createBoard': return '/boards';"), '创建看板路径不固定');
  assert.ok(kbSrc.includes('MAX_WRITE_BODY'), '写请求体未限长');
});
t('loopback 加固：端口校验、不跟随重定向、超时与响应体上限', () => {
  assert.ok(kbSrc.includes("host: '127.0.0.1'"), '必须锁定 loopback');
  assert.ok(kbSrc.includes('Number.isInteger(port) && port > 0 && port <= 65535'), '端口未严格校验');
  assert.ok(kbSrc.includes('URLSearchParams'), 'query 未编码');
  assert.ok(kbSrc.includes('status >= 300 && status < 400'), '未拒绝重定向');
  assert.ok(kbSrc.includes('TIMEOUT_MS') && kbSrc.includes('MAX_BODY'), '缺少超时 / 体积上限');
  assert.ok(kbSrc.includes('TASK_ID_RE.test') && kbSrc.includes('BOARD_RE.test'), '动态路径未过白名单');
});
t('字段白名单投影：工作区路径 / 认领锁 / PID 不得进入渲染层', () => {
  assert.ok(kbSrc.includes('const TASK_FIELDS'), '缺少卡片字段白名单');
  const fields = kbSrc.slice(kbSrc.indexOf('const TASK_FIELDS'), kbSrc.indexOf('const RUN_FIELDS'));
  for (const bad of ['workspace_path', 'claim_lock', 'claim_expires', 'worker_pid', 'idempotency_key']) {
    assert.ok(!fields.includes("'" + bad + "'"), '敏感字段被投影：' + bad);
  }
  assert.ok(kbSrc.includes('MAX_TEXT') && kbSrc.includes('MAX_ITEMS'), '正文 / 列表未封顶');
});
t('页面互斥与关闭路径：四处硬编码都覆盖看板', () => {
  assert.ok(appSrc.includes("try { closeKanbanPage(); } catch {}"), 'closeSubpages 未关看板');
  assert.ok(appSrc.includes("if (page.id === 'kanban-page') return;"), 'toggleSubpage 未让看板走专用开关');
  assert.ok(appSrc.includes("pg.id === 'kanban-page'"), 'Escape 未处理看板 / 抽屉');
  assert.ok(appSrc.includes("'/kanban'"), '命令面板缺少 /kanban');
  assert.ok(appSrc.includes('function showKanban(') && appSrc.includes('function closeKanbanPage('), '缺少开关函数');
});
t('新建会话必定落到聊天视图：closeSubpages 覆盖全部整页（含市场 / 消息平台）', () => {
  const fn = grabFn(appSrc, 'closeSubpages');
  // 整页清单直接从 index.html 里取：以后新增一个 .subpage 忘了登记，这里就会红
  const ids = [...htmlSrc.matchAll(/id="([a-z0-9-]+)"[^>]*class="[^"]*\bsubpage\b/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, 'subpage 清单解析失败：' + ids.join(','));
  // 每个整页要么被 #id 直接收起，要么走自己的专用关闭函数（toggleSubpage 对它们会早退）
  const closers = { 'kanban-page': 'closeKanbanPage()', 'gateway-page': 'closeGatewayPage()' };
  for (const id of ids) {
    const ok = fn.includes("'#" + id + "'") || (closers[id] && fn.includes(closers[id]));
    assert.ok(ok, 'closeSubpages 漏关整页：' + id + '（新建会话会停在旧页面上）');
  }
  // 市场页记着来源页并在关闭时把它重新显示出来，顺序反了就等于没关
  const iMk = fn.indexOf("$('#market-page')"), iPl = fn.indexOf("$('#plugins-page')");
  assert.ok(iMk >= 0 && iPl > iMk, '市场页必须排在插件页之前收起');
  const nsa = grabFn(appSrc, 'newSessionAction');
  assert.ok(nsa.includes('closeSubpages()'), '已经在新会话时未关闭子页面（不会跳回聊天）');
  assert.ok(nsa.includes('newTab()'), '新会话分支未建页签');
  assert.ok(appSrc.includes("document.querySelectorAll('.subpage').forEach((pg) => { pg.hidden = true; })"),
    '整页引导按钮的 data-lead="new" 兜底被删');
});

t('异步代次守卫与轮询：切页后旧响应不写 DOM，页面隐藏时停轮询', () => {
  assert.ok(kbAppSrc.includes('const my = ++KB.epoch') && kbAppSrc.includes('if (my !== KB.epoch) return'),
    '首屏缺少代次守卫');
  assert.ok(kbAppSrc.includes('const my = ++KB.detailEpoch') && kbAppSrc.includes('my !== KB.detailEpoch'),
    '详情抽屉缺少独立代次戳');
  assert.ok(kbAppSrc.includes('kanbanStopPolling()') && kbAppSrc.includes('page.hidden'),
    '隐藏时未停轮询');
  assert.ok(kbAppSrc.includes('latestEventId'), '未用 latest_event_id 做事件游标');
  assert.ok(kbAppSrc.includes('KB.filters.q = q.value.trim()'), '搜索未接入过滤');
  assert.ok(kbAppSrc.includes('data-kb-session'), '缺少按 session_id 跳会话');
});
t('看板样式只用设计 token，双主题与键盘可达性齐备', () => {
  for (const s of ['.kb-col', '.kb-card', '.kb-drawer', '.kb-group', '.kb-status-chip',
    '.kb-modal', '.kb-empty-state', '.kb-columns', '.kb-add-col', '.kb-more-menu',
    '.kb-dispatch', '.kb-dp-col', '.kbd-actions', '.kbd-reassign']) {
    assert.ok(kbCss.includes(s), '缺少核心样式 ' + s);
  }
  // 归组色改成 data-dot 驱动（9 状态 → 5 组后不再按单状态上色）
  assert.ok(kbCss.includes('var(--') && kbCss.includes('[data-dot='), '未使用设计 token / 归组色');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(kbCss), '出现硬编码色值，深色主题会失配');
  assert.ok(kbCss.includes(':focus-visible'), '卡片 / 控件缺少键盘焦点');
  assert.ok(kbCss.includes('[hidden] { display: none !important; }'), 'display:flex 会盖过 UA 的 hidden');
  assert.ok(kbCss.includes('.compact .kb-group-cards') && kbCss.includes('prefers-reduced-motion'), '缺少窄主区 / 动效降级');
  assert.ok(!kbCss.includes('writing-mode: vertical'), '空状态不得再用竖排文字');
  assert.ok(kbCss.includes('color-mix('), '遮罩必须用主题色混合而非写死色值');
});
t('新建弹窗里的每个类都有样式，不许退回浏览器默认正文', () => {
  const start = htmlSrc.indexOf('id="kb-modal-mask"');
  const block = htmlSrc.slice(start, htmlSrc.indexOf('</section>', start));
  const used = new Set();
  for (const m of block.matchAll(/class="([^"]+)"/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  }
  const missing = [...used].filter((c) => !kbCss.includes('.' + c));
  assert.deepEqual(missing, [], '这些类没有 CSS 规则，会按浏览器默认字体渲染: ' + missing.join(', '));
  assert.ok(/\.kb-fhint\s*\{[^}]*font:\s*400 11px/.test(kbCss), '字段说明字号必须小于 11.5px 的字段标签');
  assert.ok(/\.kb-fhint\s*\{[^}]*var\(--caption\)/.test(kbCss), '字段说明必须用次级文字色，不能抢标签层级');
  // 每次打开弹窗都从空白开始：上次取消/创建的标题不能带进来
  assert.ok(kbAppSrc.includes('taskForm.reset()') && kbAppSrc.includes('boardForm.reset()'),
    '弹窗未在打开时清空表单');
});
t('创建 / 派发交互：静态表单、二次确认、写后回读、Esc 最上层', () => {
  for (const id of ['kb-new-task', 'kb-more', 'kb-more-menu', 'kb-modal', 'kb-modal-submit',
    'kb-f-title', 'kb-b-slug', 'kb-board-name', 'kb-head-stat', 'kb-statusbar', 'kb-columns',
    'kb-dispatch-panel', 'kb-dp-preview', 'kb-dp-run', 'kb-dp-max',
    'kb-dp-result', 'kb-dp-workers', 'kb-dp-confirm', 'kb-dp-workers-refresh']) {
    assert.ok(htmlSrc.includes('id="' + id + '"'), '缺少页面元素 ' + id);
  }
  assert.ok(kbAppSrc.includes('idempotencyKey: key'), '表单未带幂等键');
  assert.ok(kbAppSrc.includes("KB.modalBusy = true") && kbAppSrc.includes('submit.disabled = true'), '未防连点');
  assert.ok(kbAppSrc.includes('opConfirm(host, {'), '删除未走二次确认卡');
  assert.ok(kbAppSrc.includes('await kanbanLoad(true); // 写后回读'), '写操作后未回读');
  assert.ok(kbAppSrc.includes('kbSetBackgroundInert(true)') && kbAppSrc.includes('kbSetBackgroundInert(false)'),
    '模态未隔离背景交互树');
  assert.ok(kbAppSrc.includes("guardFieldKey(el, () => kbModalClose())"), '表单 Esc 未阻止冒泡');
  assert.ok(appSrc.includes("if (!$('#kb-modal').hidden) kbModalClose();"), '全局 Esc 未优先关弹窗');
  // 视图切换只剩「⋯」菜单一项，写成三元翻转型（菜单项文字随之变）
  assert.ok(/KB\.view = KB\.view === 'grid' \? 'cols' : 'grid'/.test(kbAppSrc), '缺少双视图切换');
  assert.ok(kbAppSrc.includes('function kbMoreSync()'), '菜单里的视图项文字未同步');
  assert.ok(kbAppSrc.includes("KB.status = KB.status === v ? '' : v"), '缺少状态筛选');
  // 派发：真派发与提交派发都必须过二次确认卡，且写后回读；试运行是纯读
  assert.ok(kbAppSrc.includes('function kbDispatchConfirm()') && kbAppSrc.includes('onGo: () => kbDispatchRun(false)'),
    '真派发未走二次确认卡');
  assert.ok(kbAppSrc.includes('function kbSubmitTask(') && kbAppSrc.includes('onGo: async () =>'),
    '提交派发未走二次确认卡');
  assert.ok(kbAppSrc.includes('dryRun: !!dryRun') && kbAppSrc.includes('kbDispatchRun(true)'),
    '缺少独立的试运行入口');
  assert.ok(kbAppSrc.includes('KB_DP_SUBMITTABLE') && kbAppSrc.includes('data-kb-submit'),
    '抽屉缺少按状态门控的提交派发按钮');
  assert.ok(kbAppSrc.includes('KB.dispatch.epoch') && kbAppSrc.includes('my !== KB.dispatch.epoch'),
    '派发面板缺少代次守卫');
  assert.ok(kbAppSrc.includes('KB.dispatch.busy') && kbAppSrc.includes('preview.disabled = true'),
    '派发按钮未防连点');
  assert.ok(appSrc.includes('kbDispatchToggle(false)') && appSrc.includes('dpCard.remove()'),
    '全局 Esc 未处理派发面板与确认卡');
});

t('拖拽派发：投放区齐备、只改指派不越权、真派发仍过二次确认', () => {
  for (const id of ['kb-dock', 'kb-dock-workers', 'kb-dock-hint', 'kb-dock-msg', 'kb-dock-confirm']) {
    assert.ok(htmlSrc.includes('id="' + id + '"'), '缺少投放区元素 ' + id);
  }
  // 拖拽用指针事件而不是 HTML5 DnD：能吞掉误触 click，也不与滚动 / 文本选中打架
  assert.ok(kbAppSrc.includes('function kbDragDown(') && kbAppSrc.includes('function kbDragUp('),
    '缺少指针拖拽骨架');
  assert.ok(!kbAppSrc.includes('dataTransfer') && !appSrc.includes('draggable="true"'),
    '不应依赖 HTML5 拖放：拦不住误触 click，也拦不住拖拽期间的轮询重建');
  assert.ok(kbAppSrc.includes("scroll.addEventListener('pointerdown', kbDragDown)"), '卡片未挂拖拽起点');
  assert.ok(kbAppSrc.includes('KbDrag.suppressClick'), '拖拽结束后未吞掉浏览器补发的 click（会误打开抽屉）');
  // 可拖状态白名单：running 要先 reclaim，done / archived 再派发没有意义
  assert.ok(kbAppSrc.includes("const KB_DRAGGABLE = Object.freeze(['triage', 'todo', 'scheduled', 'ready', 'blocked', 'review'])"),
    '可拖状态白名单被改');
  const dragDecl = kbAppSrc.slice(kbAppSrc.indexOf('const KB_DRAGGABLE'), kbAppSrc.indexOf('const KbDrag'));
  assert.ok(!/['"]running['"]/.test(dragDecl) && !/['"]done['"]/.test(dragDecl) && !/['"]archived['"]/.test(dragDecl),
    'running / done / archived 不应进入可拖白名单');
  assert.ok(kbAppSrc.includes("KB_DRAGGABLE.includes(st) ? '1' : '0'"), '卡片未按状态决定可拖性');
  // 落地只做两件 CLI 原生支持的事：PATCH 改派（可顺带 → ready）+ 派发 1 个名额
  assert.ok(kbAppSrc.includes('a.kanbanReassign(taskId, {'), '落地未走改派通道');
  assert.ok(kbAppSrc.includes("assignee: profile, status: 'ready'"), '落地未把卡片推进到 ready');
  assert.ok(kbAppSrc.includes('function kbAskDispatch(') && kbAppSrc.includes("confirmLabel: '立即启动 worker'"),
    '真派发未过二次确认卡');
  assert.ok(kbAppSrc.includes('a.kanbanDispatchTask(taskId'), '确认后未走单卡派发通道');
  assert.ok(kbAppSrc.includes('await kanbanLoad(true); // 写后回读'), '拖拽写操作后未回读');
  // 拖动中不重建投放区、不停轮询，否则正在悬停的投放目标会被换掉
  assert.ok(kbAppSrc.includes('if (KbDrag.on) return; // 拖动中不重建'), '拖动中仍会重建投放区');
  assert.ok(kbAppSrc.includes('KB.busy || KbDrag.on'), '拖动中仍在轮询重渲染');
  // Esc 最上层：拖动中先取消拖动，其次才是投放确认卡
  assert.ok(/if \(KbDrag\.on \|\| KbDrag\.armed\) \{[^}]*kbDragReset\(\)[^}]*return/.test(appSrc),
    'Esc 未优先取消拖动（撤掉拖动后必须 return，不能顺手关页/中断回合）');
  assert.ok(appSrc.includes("'#kb-dock-confirm .op-confirm'"), 'Esc 未处理投放确认卡');
  assert.ok(appSrc.includes("kbDockMsg('', '')") && appSrc.includes("dockCard.innerHTML = ''"),
    '关闭看板未清理投放区状态');
  assert.ok(kbAppSrc.includes('kbSetBackgroundInert') && kbAppSrc.includes("'.kb-dock-confirm'"),
    '新建弹窗未把投放区一起移出交互树');
});
t('拖拽派发样式：幽灵卡穿透指针、投放目标高亮、双主题无硬编码色', () => {
  for (const s of ['.kb-dock', '.kb-worker', '.kb-drag-ghost', '.kb-dock-confirm', '.kb-card.is-dragging']) {
    assert.ok(kbCss.includes(s), '缺少拖拽样式 ' + s);
  }
  // 投放区改成「只在拖动时浮现」的浮层：唤醒靠 body.kb-dragging，不再是静态 .is-drag
  assert.ok(kbCss.includes('body.kb-dragging .kb-dock'), '拖动中缺少投放区浮现');
  assert.ok(/\.kb-dock \{[^}]*opacity:\s*0/.test(kbCss) && /\.kb-dock \{[^}]*pointer-events:\s*none/.test(kbCss),
    '投放区平时必须不可见且不吃指针（否则浮层会挡住卡片点击）');
  assert.ok(kbCss.includes('.kb-worker.over'), '缺少悬停投放目标高亮');
  assert.ok(kbCss.includes('.kb-card[data-kb-drag="1"]:hover::after'), '可拖卡片缺少拖拽手柄暗示');
  assert.ok(kbCss.includes('pointer-events: none'), '幽灵卡必须穿透指针，否则 elementFromPoint 命不中 chip');
  assert.ok(kbCss.includes('body.kb-dragging'), '拖动中未禁用文本选中');
  assert.ok(kbCss.includes('.compact .kb-dock-label'), '窄主区未适配投放区');
});

section('3s. 插件 / 技能列表：磁盘缓存 + 后台刷新（打开页面不再等 6–8s 冷启）');
const pluginsSrc = read('main/services/hermes-plugins.js');
const skillsSrc = read('main/services/hermes-skills.js');
const profileSrc = read('main/services/hermes-profile.js');
const catalogFor = (src) => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = code.match(/function cachePath\(\)\s*\{([\s\S]*?)\n\}/);
  return { code, cachePathBody: m ? m[1] : '' };
};
const pcat = catalogFor(pluginsSrc);
const scat = catalogFor(skillsSrc);
t('缓存只落 Electron userData，且按 profile 隔离', () => {
  for (const [name, cat, file] of [['插件', pcat, 'catalog-plugins.json'], ['技能', scat, 'catalog-skills.json']]) {
    assert.ok(cat.cachePathBody.includes('profile.dataDir()'), `${name}服务的 cachePath 必须走 profile.dataDir()（userData），不得写 ~/.hermes`);
    assert.ok(!/profile\.(home|root)\(\)/.test(cat.cachePathBody), `${name}服务的缓存路径不得拼 ~/.hermes 目录`);
    assert.ok(cat.code.includes(file), `${name}服务缺少磁盘缓存文件名 ${file}`);
    assert.ok(cat.code.includes('raw.profile !== profile.current()'), `${name}缓存未按 profile 校验，切 profile 会读到别人的列表`);
    assert.ok(cat.code.includes('HARD_TTL'), `${name}缓存缺少最长期限，CLI 升级后可能一直用旧结构`);
  }
  assert.ok(profileSrc.includes('function dataDir()'), 'profile 未导出 dataDir()');
});
t('非 force 读取必须先返回缓存，且后台刷新不 await', () => {
  for (const [name, cat] of [['插件', pcat], ['技能', scat]]) {
    assert.ok(/if \(stale \|\| revalidate\) refresh\(\)\.catch\(\(\) => \{\}\)/.test(cat.code),
      `${name}服务的过期缓存路径必须「先返回、后台 refresh」，不能 await`);
    // 非 force 分支里不允许出现 await refresh()（那等于又把 7s 挡在页面路径上）
    const block = cat.code.slice(cat.code.indexOf('if (!force) {'), cat.code.indexOf('const r = await refresh();'));
    assert.ok(block.length > 0, `${name}服务缺少非 force 快路径`);
    assert.ok(!/await\s+refresh\(\)/.test(block), `${name}服务的快路径里不得 await refresh()`);
    assert.ok(cat.code.includes('revalidate'), `${name}服务缺少 revalidate（装/卸之后强制重拉）`);
  }
});
t('force 刷新失败时退回旧缓存，不把页面清空', () => {
  assert.ok(/if \(_cache\) return \{ ok: true, plugins: _cache\.plugins, cached: true, stale: true, warning/.test(pluginsSrc),
    '插件服务在 CLI 失败时应返回旧缓存 + warning');
  assert.ok(/if \(_cache\) return \{ ok: true, skills: _cache\.skills/.test(skillsSrc),
    '技能服务在 CLI 失败时应返回旧缓存 + warning');
});
t('invalidate 连磁盘缓存一起删，避免装完反而读回装之前那份', () => {
  for (const [name, src] of [['插件', pluginsSrc], ['技能', skillsSrc]]) {
    assert.ok(/function invalidate\(\)[\s\S]{0,320}fs\.unlinkSync\(file\)/.test(src),
      `${name}服务的 invalidate 未删除磁盘缓存`);
  }
});
t('刷新完成经 catalog:updated 回到渲染层，且重绘不跳滚动位置', () => {
  assert.ok(mainSrc.includes('hermesPlugins.setEmitter') && mainSrc.includes('hermesSkills.setEmitter'),
    'main 未把两个服务的 emitter 接到 webContents');
  assert.ok(mainSrc.includes("'catalog:updated'"), 'main 未发送 catalog:updated');
  assert.ok(preloadSrc.includes('onCatalogUpdated'), 'preload 未暴露 onCatalogUpdated');
  assert.ok(appSrc.includes('onCatalogUpdated') && /onCatalogUpdated\(\(p\) => \{[\s\S]{0,300}loadLive\(kind, page, \{ quiet: true \}\)/.test(appSrc),
    'renderer 未订阅 catalog:updated 就地重绘');
  assert.ok(appSrc.includes('withScrollKept'), '后台重绘必须保持滚动位置');
  assert.ok(!/loadLive\(mk\.kind, page, \{ force: true \}\)/.test(appSrc),
    '市场装/卸后不得再 force 冷启 CLI（会阻塞 6–8s），应 revalidate');
});
t('缓存命中时统计条显示数据源，刷新中给出轻提示', () => {
  assert.ok(appSrc.includes('hermes CLI · 刷新中'), '统计条缺少「刷新中」状态');
  assert.ok(appSrc.includes('首次读取 hermes CLI 数据'), '首次冷启的骨架文案未说明代价');
});
t('工具集 / MCP 列表同款缓存，但回读与连接测试永远真跑', () => {
  const tools = read('main/services/hermes-tools.js');
  const mcp = read('main/services/hermes-mcp.js');
  for (const [n, src, file] of [['工具集', tools, 'catalog-tools.json'], ['MCP', mcp, 'catalog-mcp.json']]) {
    assert.ok(src.includes(file), `${n}缺少磁盘缓存文件 ${file}`);
    assert.ok(src.includes('profile.dataDir()'), `${n}缓存必须落 userData`);
    assert.ok(src.includes('raw.profile !== profile.current()'), `${n}缓存未按 profile 校验`);
    assert.ok(src.includes('HARD_TTL'), `${n}缓存缺少最长期限`);
    assert.ok(/function invalidate\(\)[\s\S]{0,320}fs\.unlinkSync\(file\)/.test(src), `${n}的 invalidate 未删磁盘缓存`);
    assert.ok(src.includes('setEmitter'), `${n}缺少刷新完成广播`);
    assert.ok(/if \(stale \|\| revalidate\) refresh\(\)\.catch\(\(\) => \{\}\)/.test(src), `${n}过期缓存必须先返回再后台刷新`);
  }
  // 回读路径不得出现 _cache 读取，否则回读会把开关之前的状态当结果
  assert.ok(!/async function readListRaw\(\)[\s\S]{0,400}_cache/.test(tools), '工具集回读不得读缓存');
  assert.ok(!/function readServersRaw\(\)[\s\S]{0,400}_cache/.test(mcp), 'MCP 回读不得读缓存');
  assert.ok(/function testServer\(name\)[\s\S]{0,500}exec\(\['mcp', 'test'/.test(mcp), 'MCP 连接测试必须真连，不许走缓存');
  // 终端里改 config.yaml（tools enable / mcp add / 手改 yaml）后必须让缓存过期
  for (const [n, src] of [['工具集', tools], ['MCP', mcp]]) {
    assert.ok(/yamlCfg\.watch\(\(\) => \{ if \(_cache\) _cache\.at = Math\.min/.test(src),
      `${n}未响应 config.yaml 的外部变更，最长会显示 30 分钟过期状态`);
  }
});
t('设置页打开即预取工具集 / MCP，刷新按钮 force 真重读', () => {
  assert.ok(/function toggleSettings\(show\)[\s\S]{0,900}api\.toolsList\(\)[\s\S]{0,120}api\.mcpList\(\)/.test(appSrc),
    '打开设置未预取工具集 / MCP 列表');
  assert.ok(appSrc.includes('refresh.onclick = () => reload({ force: true })'), 'MCP 刷新按钮必须 force 真重读');
  assert.ok(appSrc.includes('后台刷新中'), '工具集 / MCP 面板缺少「后台刷新中」提示');
  assert.ok(appSrc.includes('function subscribeCatalog('), '缺少设置面板的 catalog:updated 订阅去重');
});

section('3t. 思考轨：只认真推理，等待提示不得冒充思考内容');
const reasonChatSrc = read('main/services/hermes-chat.js');
t('thinking.delta（等待/spinner）不得变成「思考过程」块，只走状态行', () => {
  // v0.23.0: thinking.delta 是等待提示（gateway/agent_callbacks.py:_agent_thinking_update 明确写着
  // "not reasoning blocks"）；真推理走 reasoning.delta。映射错就会渲染出一条空/占位思考块。
  assert.ok(/\} else if \(t === 'thinking\.delta'\) \{[\s\S]{0,700}type: 'thinking_wait'/.test(reasonChatSrc),
    'thinking.delta 必须映射成 thinking_wait（状态行），不能是 thinking');
  assert.ok(!/t === 'thinking\.delta'[\s\S]{0,400}type: 'thinking'/.test(reasonChatSrc),
    'thinking.delta 仍被当成推理内容');
  assert.ok(/\} else if \(t === 'reasoning\.delta'\) \{[\s\S]{0,320}type: 'thinking'/.test(reasonChatSrc),
    'reasoning.delta 才是推理流');
});
t('reasoning.available 是「替换推理块」的快照，不得混进正文', () => {
  assert.ok(!/t === 'message\.delta' \|\| t === 'message\.interim' \|\| t === 'reasoning\.available'/.test(reasonChatSrc),
    'reasoning.available 仍被当正文追加（会把思考灌进回答里）');
  assert.ok(/t === 'reasoning\.available'[\s\S]{0,320}type: 'thinking', text, final: true/.test(reasonChatSrc),
    'reasoning.available 必须以 final 语义替换推理块');
});
t('message.complete 的 reasoning 兜底在 _finish 之前发出', () => {
  const i = reasonChatSrc.indexOf("t === 'message.complete'");
  const seg = reasonChatSrc.slice(i, i + 1400);
  const emitAt = seg.indexOf("type: 'thinking', text: reasoning, final: true");
  const finishAt = seg.indexOf('this._finish(');
  assert.ok(emitAt > 0, 'message.complete.reasoning 没有被透传');
  assert.ok(finishAt > emitAt, '兜底推理必须在 _finish 之前发出，否则被 finished 拦掉');
});
t('渲染层：等待提示不建消息块，颜文字不进任何 UI', () => {
  assert.ok(/evt\.type === 'thinking_wait'[\s\S]{0,600}providerWaitText\(evt\.text\)/.test(appSrc),
    'thinking_wait 未经 providerWaitText 白名单过滤');
  assert.ok(/evt\.type === 'thinking_wait'[\s\S]{0,700}\} else if \(evt\.type === 'thinking'\)/.test(appSrc),
    'thinking_wait 分支不得 push 任何 item');
  assert.ok(/RE_PROVIDER_WAIT = \/\^\(\?:⏳\|⚠\|↻\|⚙\)/.test(appSrc), 'provider 等待白名单正则缺失');
});
t('渲染层：「流式思考」开关真的生效，推理块按回合隔离', () => {
  assert.ok(/evt\.type === 'thinking'[\s\S]{0,300}if \(!streamThinkOn\(\)\) return/.test(appSrc),
    'streamThink 开关没有参与渲染判断（此前是纯摆设）');
  assert.ok(appSrc.includes('function reasoningItemOf(') && appSrc.includes('function turnInsertIndex('),
    '缺少按回合查找 / 插入推理块的辅助函数');
  assert.ok(/if \(evt\.final\) item\.text = evt\.text; else item\.text \+= evt\.text/.test(appSrc),
    'final 快照必须是替换语义');
});
t('上游思考开关：只读状态 + 写 CLI 配置必须由二次确认卡触发', () => {
  assert.ok(mainSrc.includes("handle('hermes-config:reasoning-display'") &&
    mainSrc.includes("handle('hermes-config:set-reasoning-display'"), '主进程缺少上游思考输出的读写通道');
  assert.ok(/ipcRenderer\.invoke\('hermes-config:set-reasoning-display', on === true\)/.test(preloadSrc),
    'preload 必须把参数收敛成布尔');
  assert.ok(/function enableUpstreamReasoning[\s\S]{0,2200}opConfirm\(/.test(appSrc),
    '写 CLI 配置必须先出二次确认卡');
  const fn = appSrc.slice(appSrc.indexOf('async function enableUpstreamReasoning'));
  const go = fn.indexOf('onGo:');
  assert.ok(go > 0 && fn.indexOf('api.setReasoningDisplay(') > go,
    'api.setReasoningDisplay 只能在 onGo 里调用，不得自动写');
  assert.ok(fn.includes('display.show_reasoning'), '确认卡必须写明要写的键');
  const cfgSrc = read('main/services/hermes-config.js');
  assert.ok(/profile\.cliArgs\(\['config', 'set', 'display\.show_reasoning'/.test(cfgSrc),
    '写配置必须走 hermes config set（不做桌面端自制写盘）');
  assert.ok(/function parseReasoningDisplay[\s\S]{0,400}\^ \{2\}show_reasoning/.test(cfgSrc),
    '只读解析必须限定 display 段两格缩进，避免把 platforms.* 的同名键读成全局值');
});

section('3u. 弹层遮罩：不得用全屏 backdrop-filter（实测关闭一次 290ms）');
t('三个 .palette 弹层共用的遮罩保持纯半透明，不用模糊', () => {
  const blocks = cssSrc.match(/\.palette\s*\{[^}]*\}/g) || [];
  assert.ok(blocks.length > 0, '未找到 .palette 遮罩规则');
  const joined = blocks.join('\n');
  assert.ok(!/backdrop-filter/.test(joined),
    '.palette 又用回 backdrop-filter：设置页/命令面板打开关闭会多花 220ms 并产生 50ms 长任务');
  assert.ok(/color-mix\(in srgb, var\(--n-1000\)/.test(joined),
    '遮罩应改用 color-mix 半透明底色，避免写死 hex 破坏双主题');
});
t('命令面板 / 快捷键帮助 / 设置页确实共用同一套遮罩类', () => {
  const htmlSrc = read('renderer/index.html');
  const n = (htmlSrc.match(/class="palette"/g) || []).length;
  assert.ok(n >= 3, `共用 .palette 的弹层数量异常（${n} 个）`);
});

section('3v. 小球模式：透明置顶窗口 + 沙箱白名单 + 只 hide 不改几何');
const orbSrc = read('main/orb.js');
const orbHtmlSrc = read('renderer/orb.html');
const orbCssSrc = read('renderer/orb.css');
const orbJsSrc = read('renderer/orb.js');
const orbPreSrc = read('preload/orb-preload.js');

t('球窗口：透明 / 无边框 / 置顶 / 不抢焦点，且不用 type:panel', () => {
  for (const re of [/transparent:\s*true/, /frame:\s*false/, /alwaysOnTop:\s*true/, /acceptFirstMouse:\s*true/, /skipTaskbar:\s*true/, /hasShadow:\s*false/]) {
    assert.ok(re.test(orbSrc), '缺少窗口参数 ' + re);
  }
  assert.ok(/setAlwaysOnTop\(true, 'pop-up-menu'/.test(orbSrc), '置顶层级不够，会被全屏应用压住');
  assert.ok(!/type:\s*'panel'/.test(orbSrc),
    "type:'panel' 在 macOS 13 + Electron 33 上会报 nonactivating panel styleMask 并完全收不到鼠标事件");
});

t('球窗口与主窗口同等级沙箱，且必须用独立 preload', () => {
  const from = orbSrc.indexOf('webPreferences');
  const block = orbSrc.slice(from, from + 420);
  assert.ok(/sandbox:\s*true/.test(block), '球窗口未开 sandbox');
  assert.ok(/contextIsolation:\s*true/.test(block), '球窗口未开 contextIsolation');
  assert.ok(/nodeIntegration:\s*false/.test(block), '球窗口不得开 nodeIntegration');
  assert.ok(/orb-preload\.js/.test(block), '球窗口应加载 preload/orb-preload.js');
  assert.ok(!/'preload', 'preload\.js'\)/.test(block), '球窗口不得复用主 preload（会把全部 IPC 暴露给一颗球）');
});

t('球 preload 只开五个动作，通道全部限定在 orb: 前缀', () => {
  const keys = uniq(collect(orbPreSrc, /^\s{2}([A-Za-z_$][\w$]*)\s*:/gm));
  assert.deepStrictEqual(keys, ['click', 'drag', 'dragEnd', 'menu', 'onStatus', 'restore'], '暴露面变化：' + keys.join(', '));
  assert.ok(!/exposeInMainWorld\('hermesAPI'/.test(orbPreSrc), '不得覆盖主窗口的 API');
  const sends = uniq(collect(orbPreSrc, /ipcRenderer\.send\('([^']+)'/g));
  assert.deepStrictEqual(sends, ['orb:click', 'orb:drag', 'orb:dragend', 'orb:menu', 'orb:restore']);
  const listens = uniq(collect(orbSrc, /ipcMain\.on\('([^']+)'/g));
  const orphan = sends.filter((c) => !listens.includes(c));
  assert.deepStrictEqual(orphan, [], '主进程未监听：' + orphan.join(', '));
});

t('球窗口的 IPC 只认自己的 webContents，位置永不越出 workArea', () => {
  assert.ok(/event\.sender === win\.webContents/.test(orbSrc), '未校验 IPC 来源，任意页面都能拖走这颗球');
  assert.ok(/screen\.getDisplayMatching\(/.test(orbSrc) && /workArea/.test(orbSrc), '位置未收进可见区');
  assert.ok(/orb\.json/.test(orbSrc), '位置未持久化');
  assert.ok(/defaultPos\(\)/.test(orbSrc), '读不到位置时应回默认位');
});

t('球页面与主窗口同等级 CSP', () => {
  const csp = (orbHtmlSrc.match(/Content-Security-Policy[^>]*content="([^"]+)"/) || [])[1] || '';
  assert.ok(csp, 'orb.html 缺少 CSP meta');
  for (const d of ["default-src 'self'", "base-uri 'none'", "object-src 'none'", "connect-src 'none'"]) {
    assert.ok(csp.includes(d), 'CSP 缺少 ' + d);
  }
  assert.ok(!/'unsafe-eval'/.test(csp), 'CSP 不应允许 unsafe-eval');
});

t('球页面每个 class 都有样式规则（否则静默退回 14px 深色正文）', () => {
  const classes = uniq(
    collect(orbHtmlSrc, /class="([^"]+)"/g).flatMap((c) => c.split(/\s+/)).filter(Boolean)
  );
  const missing = classes.filter((c) => !orbCssSrc.includes('.' + c));
  assert.deepStrictEqual(missing, [], 'CSS 缺少：' + missing.join(', '));
});

t('拖动用指针事件自己算坐标（透明窗口上 app-region:drag 会吞掉 click）', () => {
  assert.ok(/pointerdown/.test(orbJsSrc) && /pointermove/.test(orbJsSrc), '未用指针事件');
  assert.ok(!/-webkit-app-region/.test(orbCssSrc), '不要用 app-region: drag');
  assert.ok(/DRAG_THRESHOLD/.test(orbJsSrc) && /CLICK_MS/.test(orbJsSrc), '缺少拖动/点击阈值');
  assert.ok(/requestAnimationFrame/.test(orbJsSrc), '拖动未按帧节流');
  assert.ok(/contextmenu/.test(orbJsSrc), '缺少右键菜单入口');
});

t('收起成球只 hide 主窗口，不改任何几何', () => {
  const from = mainSrc.indexOf('function enterOrb()');
  assert.ok(from > 0, '找不到 enterOrb');
  const body = mainSrc.slice(from, mainSrc.indexOf('function leaveOrb()'));
  assert.ok(/mainWindow\.hide\(\)/.test(body), '未隐藏主窗口');
  assert.ok(!/setBounds|setSize|setContentSize|setMinimumSize|setPosition/.test(body),
    'enterOrb 不得改主窗口尺寸/位置（会触发视口漂移与白块）');
  const leave = mainSrc.slice(mainSrc.indexOf('function leaveOrb()'), mainSrc.indexOf('function safeSend'));
  assert.ok(/mainWindow\.show\(\)/.test(leave), '未恢复主窗口');
  assert.ok(/isMinimized\(\)/.test(leave) && /restore\(\)/.test(leave), '最小化态恢复必须先 restore');
});

t('黄灯 / ⌘M 被拦成小球，并留了「最小化到程序坞」逃生口', () => {
  assert.ok(/on\('minimize'[\s\S]{0,220}enterOrb\(\)/.test(mainSrc), '最小化未接到小球');
  assert.ok(/allowNativeMinimize/.test(mainSrc), '缺少原生最小化逃生开关');
  assert.ok(/最小化到程序坞/.test(orbSrc), '球右键菜单缺少「最小化到程序坞」');
});

t('三个入口都能进小球：⌘⇧M 菜单 / 命令面板 /orb / 渲染层 IPC', () => {
  assert.ok(/收起成小圆球/.test(mainSrc) && /CmdOrCtrl\+Shift\+M/.test(mainSrc), '菜单缺少 ⌘⇧M');
  assert.ok(/cmd: '\/orb'/.test(appSrc), '命令面板缺少 /orb');
  assert.ok(/enterOrb: \(\) => ipcRenderer\.invoke\('orb:enter'\)/.test(preloadSrc), 'preload 未暴露 enterOrb');
});

t('球上的状态点由在途回合 / 待审批数推导，且不把启动瞬间报成故障', () => {
  assert.ok(/busyTurns \+= 1/.test(mainSrc) && /busyTurns = Math\.max\(0, busyTurns - 1\)/.test(mainSrc), '在途回合计数缺失');
  assert.ok(/pendingApprovals \+= 1/.test(mainSrc), '待审批计数缺失');
  const body = mainSrc.slice(mainSrc.indexOf('function orbStatus()'), mainSrc.indexOf('function syncOrb'));
  for (const s of ["'approval'", "'busy'", "'offline'", "'idle'"]) assert.ok(body.includes(s), '缺少状态 ' + s);
  assert.ok(!/!== 'ready'/.test(body), 'started/idle 阶段不该亮红点（启动瞬间必然不是 ready）');
  assert.ok(/clearTimeout\(orbTimer\)/.test(mainSrc), '球态定时器未清理');
  assert.ok(!/setInterval\(/.test(mainSrc), '主进程仍不得轮询（用递归 setTimeout 做低频状态对齐）');
});

section('3w. 迷你聊天窗：点球弹出小窗口聊天，与主窗口共用同一个会话');
const ocSrc = read('main/orb-chat.js');
const ocPreSrc = read('preload/orb-chat-preload.js');
const ocHtmlSrc = read('renderer/orb-chat.html');
const ocCssSrc = read('renderer/orb-chat.css');
const ocJsSrc = read('renderer/orb-chat.js');

t('小窗：透明无边框 + 可拖拉尺寸 + 置顶，沙箱与主窗口同等级', () => {
  for (const re of [/transparent:\s*true/, /frame:\s*false/, /alwaysOnTop:\s*true/, /acceptFirstMouse:\s*true/, /resizable:\s*true/]) {
    assert.ok(re.test(ocSrc), '缺少窗口参数 ' + re);
  }
  const from = ocSrc.indexOf('webPreferences');
  const block = ocSrc.slice(from, from + 460);
  assert.ok(/sandbox:\s*true/.test(block), '小窗未开 sandbox');
  assert.ok(/contextIsolation:\s*true/.test(block), '小窗未开 contextIsolation');
  assert.ok(/nodeIntegration:\s*false/.test(block), '小窗不得开 nodeIntegration');
  assert.ok(/orb-chat-preload\.js/.test(block), '小窗应加载 preload/orb-chat-preload.js');
  assert.ok(!/'preload', 'preload\.js'\)/.test(block), '小窗不得复用主 preload（会拿到 CLI / 看板 / 终端全套 IPC）');
});

t('小窗 preload 只开聊天与开关窗动作，通道全在 orbchat: 前缀', () => {
  const keys = uniq(collect(ocPreSrc, /^\s{2}([A-Za-z_$][\w$]*)\s*:/gm));
  assert.deepStrictEqual(keys, [
    'abort', 'approve', 'bootstrap', 'close', 'draft', 'expand',
    'onApproval', 'onApprovalResolved', 'onEvent', 'onFocus', 'onState', 'onSync', 'send',
  ], '暴露面变化：' + keys.join(', '));
  assert.ok(!/exposeInMainWorld\('hermesAPI'/.test(ocPreSrc), '不得覆盖主窗口的 API');
  assert.ok(!/'hermes:/.test(ocPreSrc), '小窗不得直接触碰 hermes:* 通道');
  const calls = [
    ...uniq(collect(ocPreSrc, /ipcRenderer\.invoke\('([^']+)'/g)),
    ...uniq(collect(ocPreSrc, /ipcRenderer\.send\('([^']+)'/g)),
  ];
  const handled = [
    ...uniq(collect(ocSrc, /handle\('([^']+)'/g)),
    ...uniq(collect(ocSrc, /ipcMain\.on\('([^']+)'/g)),
  ];
  const orphan = calls.filter((c) => !handled.includes(c));
  assert.deepStrictEqual(orphan, [], '主进程未接：' + orphan.join(', '));
});

t('小窗与球页面同等级 CSP，且每个 class 都有样式规则', () => {
  const csp = (ocHtmlSrc.match(/Content-Security-Policy[^>]*content="([^"]+)"/) || [])[1] || '';
  assert.ok(csp, 'orb-chat.html 缺少 CSP meta');
  for (const d of ["default-src 'self'", "base-uri 'none'", "object-src 'none'", "connect-src 'none'"]) {
    assert.ok(csp.includes(d), 'CSP 缺少 ' + d);
  }
  assert.ok(!/'unsafe-eval'/.test(csp), 'CSP 不应允许 unsafe-eval');
  const classes = uniq(collect(ocHtmlSrc, /class="([^"]+)"/g).flatMap((c) => c.split(/\s+/)).filter(Boolean));
  const missing = classes.filter((c) => !ocCssSrc.includes('.' + c));
  assert.deepStrictEqual(missing, [], 'CSS 缺少：' + missing.join(', '));
});

t('点球只开关小窗，绝不恢复主窗口', () => {
  const body = mainSrc.slice(mainSrc.indexOf('function toggleOrbChat'), mainSrc.indexOf('function leaveOrb'));
  assert.ok(/isOpen\(\)/.test(body) && /\.close\(\)/.test(body) && /\.open\(\)/.test(body), '点球应 toggle 小窗');
  assert.ok(!/mainWindow\.(show|focus)/.test(body), '点球不得恢复主窗口（那是右键菜单的事）');
  assert.ok(/onClick:\s*toggleOrbChat/.test(mainSrc), '球窗口未接 onClick');
  assert.ok(/orb\.click\(\)/.test(orbJsSrc), '球渲染层点击应走 orb.click()');
  assert.ok(!/orb\.restore\(\)/.test(orbJsSrc), '球渲染层不应再直接 restore 主窗口');
  assert.ok(/onRestore:\s*leaveOrb/.test(mainSrc), '球右键菜单仍要能回主窗口');
});

t('小窗与主窗口共用同一个 chat tab，事件双投且不串页签', () => {
  assert.strictEqual(collect(mainSrc, /chat\.submit\(/g).length, 1,
    'chat.submit 只应有一处（submitTurn）：否则 busyTurns / 球态 / 事件投递会分叉');
  assert.ok(/function submitTurn\(tabId, payload\)/.test(mainSrc), '缺少统一的 submitTurn');
  assert.ok(/return submitTurn\(p\.tabId, p\)/.test(mainSrc), 'hermes:send 未走 submitTurn');
  assert.ok(/submitTurn\(tabId, \{ query: text/.test(mainSrc), '小窗发送未走 submitTurn');
  assert.ok(/if \(!orbCtx \|\| !orbCtx\.tabId\)/.test(mainSrc), '小窗发送必须绑定主窗口上报的 tabId');
  assert.ok(/function fanoutEvent\(tabId, evt\)/.test(mainSrc), '缺少事件双投');
  assert.ok(/orbChat\.pushEvent\(evt\)/.test(mainSrc), '事件未推给小窗');
  assert.ok(/orbCtx\.tabId === tabId/.test(mainSrc), '小窗只应收到自己 tab 的事件');
});

t('主窗口节流上报会话上下文，小窗据此渲染最近对话', () => {
  assert.ok(/function publishOrbContext\(\)/.test(appSrc), '渲染层缺少上下文上报');
  assert.ok(/api\.orbContext\(\{/.test(appSrc) && /tabId: tab\.id/.test(appSrc), '上报缺少 tabId');
  assert.ok(/\[\.\.\.\(|slice\(-14\)/.test(appSrc), '上报应只带最近十几条，不要把整段会话塞进 IPC');
  assert.ok(/ipcMain\.on\('orb:context'/.test(mainSrc), '主进程未接收上下文');
  assert.ok(/event\.sender !== mainWindow\.webContents/.test(mainSrc), '上下文未校验来源');
  assert.ok(/safeSend\('orb:user-message'/.test(mainSrc), '小窗发的消息未回灌主窗口');
  assert.ok(/api\.onOrbUserMessage/.test(appSrc), '主窗口未订阅回灌');
});

t('审批两侧都能表态，任一侧表决后另一侧立刻收口', () => {
  assert.ok(/function respondApproval\(/.test(mainSrc), '缺少统一的审批表态入口');
  assert.ok(/safeSend\('orb:approval-resolved'/.test(mainSrc), '未广播给主窗口');
  assert.ok(/orbChat\.pushApprovalResolved/.test(mainSrc), '未广播给小窗');
  assert.ok(/orbChat\.pushApproval\(req\)/.test(mainSrc), '审批未推给小窗');
  assert.ok(/onOrbApprovalResolved/.test(appSrc) && /it\.choice/.test(appSrc), '主窗口未把卡片收口');
  assert.ok(/orbchat:approve/.test(ocSrc) && /onApprovalResolved/.test(ocJsSrc), '小窗未处理审批');
});

t('小窗渲染只用 textContent，模型输出不可能变成可执行 HTML', () => {
  assert.ok(!/innerHTML/.test(ocJsSrc), '小窗渲染层不得用 innerHTML');
  assert.ok(/textContent/.test(ocJsSrc), '应使用 textContent 落地文本');
  assert.ok(!/eval\(|new Function/.test(ocJsSrc), '不得动态求值');
});

t('拖动球 / 收起小窗 / 回主窗口三条路径各自独立', () => {
  assert.ok(/if \(opts\.onDragStart\) opts\.onDragStart\(\)/.test(orbSrc), '拖动球未先收起小窗');
  assert.ok(/onDragStart:\s*\(\) => \{ if \(orbChat\) orbChat\.close\(\); \}/.test(mainSrc), '主进程未接 onDragStart');
  assert.ok(/onExpand:\s*\(\) => leaveOrb\(\)/.test(mainSrc), '小窗「在主窗口打开」未接回主窗');
  assert.ok(/api\.close\(\)/.test(ocJsSrc) && /api\.expand\(\)/.test(ocJsSrc), '小窗未绑定收起 / 打开主窗');
  assert.ok(/win\.hide\(\)/.test(ocSrc), 'close 应 hide 而不是 destroy（重开要秒开）');
  assert.ok(/if \(orbChat\) \{ orbChat\.destroy\(\); orbChat = null; \}/.test(mainSrc), 'will-quit 未释放小窗');
});

t('草稿只留在主进程内存里：不落盘、不进日志', () => {
  assert.ok(/draft = String\(text == null \? '' : text\)\.slice\(0, DRAFT_MAX\)/.test(ocSrc), '草稿未截断保存');
  assert.ok(!/writeFileSync/.test(ocSrc), '小窗服务不得写盘');
  assert.ok(/orbchat:draft/.test(ocPreSrc), '渲染层未上报草稿');
});

t('用户拖过小窗之后不会被拽回球边（只有球自己动了才重新贴靠）', () => {
  assert.ok(/placedAnchor/.test(ocSrc), '缺少锚点记忆：每次点开都会把面板拽回球旁边');
  assert.ok(/const anchorMoved = !placedAnchor \|\|/.test(ocSrc), '未比较球是否移动过');
  assert.ok(/if \(anchorMoved\) place\(\); else clampIntoView\(\)/.test(ocSrc), '球未动时应保留用户摆的位置');
  assert.ok(/getDisplayMatching\(b\)\.workArea/.test(ocSrc), '保留位置时仍要收进可见区（换显示器后能找回来）');
});

section('3x. 圆球设计系统：球面体积、状态信号去重、球↔小窗连接闭环、无障碍');

t('球面是「有体积的球」：多层渐变 + 顶部镜面高光 + 底部反光', () => {
  const ball = (orbCssSrc.match(/\.orb-ball\s*\{[^}]*\}/) || [])[0] || '';
  assert.ok((ball.match(/radial-gradient\(/g) || []).length >= 2, '球面缺少明暗过渡与镜面光斑两层渐变');
  assert.ok(/inset 0 -7px/.test(ball) || /inset 0 -/.test(ball), '球面下沿缺内暗边');
  assert.ok(/\.orb-ball::before/.test(orbCssSrc), '缺少顶部弧形高光');
  assert.ok(/\.orb-ball::after/.test(orbCssSrc), '缺少底部环境反光');
});

t('每个状态只有一个主视觉信号，不再出现「弧+点」「徽标+点」重复', () => {
  assert.ok(!/body\[data-state="busy"\][^{]*\.orb-dot/.test(orbCssSrc), 'busy 不应再点亮右下角状态点（已有外弧）');
  assert.ok(!/body\[data-state="approval"\][^{]*\.orb-dot/.test(orbCssSrc), 'approval 不应再点亮右下角状态点（已有数字徽标）');
  assert.ok(/body\[data-state="offline"\] \.orb-dot\s*\{/.test(orbCssSrc), 'offline 必须保留状态点');
  assert.ok(/body\[data-state="busy"\] \.orb-ring\s*\{/.test(orbCssSrc), 'busy 必须保留旋转弧');
  assert.ok(/\.orb-badge\s*\{[^}]*border-radius: 9px/.test(orbCssSrc), 'approval 徽标仍应是圆形胶囊');
});

t('点球展开小窗时球亮内环，收起后灭：open 态只在主进程推导', () => {
  assert.ok(/body\[data-open="true"\] \.orb-halo\s*\{/.test(orbCssSrc), '缺少展开态内环');
  assert.ok(/body\[data-open="true"\] \.orb-letter/.test(orbCssSrc), '展开态字标未提亮');
  assert.ok(/function orbSnapshot\(\)/.test(mainSrc), '主进程缺少带 open 的状态快照');
  assert.ok(/open: !!\(orbChat && orbChat\.isOpen\(\)\)/.test(mainSrc), 'open 必须由小窗真实可见性推导');
  assert.ok(/orb\.show\(orbSnapshot\(\)\)/.test(mainSrc) && /orb\.setStatus\(orbSnapshot\(\)\)/.test(mainSrc), '球的两个入口都要带 open');
  assert.ok(/dataset\.open = open \? 'true' : 'false'/.test(orbJsSrc), '球渲染层未消费 open');
});

t('开/关小窗的任何路径都会回推球态（点球 / Esc / × / 拖球 / 展开）', () => {
  assert.ok(/onVisibilityChange:\s*\(\) => syncOrb\(\)/.test(mainSrc), '主进程未接可见性变化');
  assert.ok((ocSrc.match(/opts\.onVisibilityChange\(\)/g) || []).length === 2, 'open 与 close 都必须回推一次');
  assert.ok(/onDragStart:\s*\(\) => \{ if \(orbChat\) orbChat\.close\(\); \}/.test(mainSrc), '拖球收窗路径被改动');
});

t('小窗按实时方位显示朝球一侧的连接轨，圆标与桌面球同为圆形', () => {
  assert.ok(/class="oc-rail"/.test(ocHtmlSrc), '缺少连接轨节点');
  assert.ok(/body\[data-side="right"\] \.oc-rail/.test(ocCssSrc) && /body\[data-side="left"\] \.oc-rail/.test(ocCssSrc), '连接轨缺少左右两侧规则');
  assert.ok(/function sideOfBall\(\)/.test(ocSrc) && /side: sideOfBall\(\)/.test(ocSrc), '主进程未把方位带进上下文');
  assert.ok(/function applySide\(/.test(ocJsSrc) && /dataset\.side/.test(ocJsSrc), '渲染层未消费方位');
  for (const cls of ['oc-glyph', 'oc-empty-mark']) {
    const block = (ocCssSrc.match(new RegExp('\\.' + cls + '\\s*\\{[^}]*\\}')) || [])[0] || '';
    assert.ok(/border-radius:\s*50%/.test(block), cls + ' 必须是圆形（与桌面球同几何）');
  }
});

t('聚焦不是校验错误：边框保持中性，只给品牌色柔光', () => {
  const block = (ocCssSrc.match(/\.oc-composer:focus-within\s*\{[^}]*\}/) || [])[0] || '';
  assert.ok(!/var\(--accent\)/.test(block), 'focus 不得用警示色 --accent（会被读成输入校验失败）');
  assert.ok(/var\(--blue\)/.test(block), 'focus 应使用品牌色 --blue');
  assert.ok(/var\(--line-2\)/.test(block), 'focus 时边框颜色应保持不变');
});

t('球对辅助技术可读：aria-pressed / 动态标签 / 状态播报 / 减少动态效果', () => {
  assert.ok(/aria-pressed="false"/.test(orbHtmlSrc) && /aria-live="polite"/.test(orbHtmlSrc), '缺少按钮按下态或状态播报');
  assert.ok(/class="orb-sr"/.test(orbHtmlSrc) && /\.orb-sr\s*\{/.test(orbCssSrc), '播报节点必须视觉隐藏且有样式规则');
  assert.ok(/setAttribute\('aria-pressed'/.test(orbJsSrc) && /setAttribute\('aria-label'/.test(orbJsSrc), '开合时未更新按钮语义');
  assert.ok(/STATE_TEXT/.test(orbJsSrc) && /live\.textContent/.test(orbJsSrc), '状态变化未播报');
  const reduced = (orbCssSrc.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  assert.ok(/\.orb-halo/.test(reduced) && /\.orb-ring/.test(reduced), '减少动态效果未覆盖新增的内环与旋转弧');
});

section('3y. 全局快捷键模式：app 级入口成对注册、只写 userData（菜单栏托盘已按用户要求移除）');
const accessSrc = read('main/orb-access.js');
const prefSrc = read('main/orb-prefs.js');
const buildYml = read('electron-builder.yml');
/** 注释里会写「绝不碰 ~/.hermes」这类排障说明，负向断言必须只看代码 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const accessCode = stripComments(accessSrc);
const prefCode = stripComments(prefSrc);
const mainCode = stripComments(mainSrc);

t('快捷键只存在于主进程，两个小窗的 preload 暴露面一行未动', () => {
  assert.ok(/require\('electron'\)/.test(accessCode), '快捷键模块应只在主进程加载');
  assert.ok(!/contextBridge|ipcRenderer|ipcMain/.test(accessCode), '不得给快捷键开 IPC 通道');
  assert.ok(!/require\('electron'\)/.test(prefCode), '偏好模块必须能在纯 Node 单测里直接 require');
  for (const src of [preloadSrc, orbPreSrc, ocPreSrc]) {
    assert.ok(!/globalShortcut|new Tray\(|contextBridge\.exposeInMainWorld\('orbTray'/.test(src),
      'renderer / preload 不得拿到托盘或全局快捷键能力');
  }
});

t('全局快捷键只注册一条，关闭开关与退出时都注销', () => {
  assert.strictEqual((accessCode.match(/globalShortcut\.register\(/g) || []).length, 1);
  assert.ok(/globalShortcut\.register\(ACCELERATOR,/.test(accessCode));
  assert.ok(/Alt\+Shift\+H/.test(accessCode), '快捷键必须是不会和普通打字抢的三键组合');
  assert.ok((accessCode.match(/globalShortcut\.unregister\(/g) || []).length >= 2, '注销路径不完整');
  assert.ok(!/globalShortcut/.test(mainCode), '快捷键注册必须集中在 orb-access.js，不能散进 main.js');
});

t('菜单栏托盘已整体移除：不再 new Tray、不再有托盘菜单、图标资源同步删除', () => {
  for (const [name, src] of [['main.js', mainCode], ['orb.js', stripComments(orbSrc)], ['orb-access.js', accessCode]]) {
    assert.ok(!/\bnew Tray\b/.test(src), name + ' 仍在创建菜单栏托盘图标');
    assert.ok(!/setContextMenu|popUpContextMenu/.test(src), name + ' 仍在维护托盘上下文菜单');
    assert.ok(!/setToolTip/.test(src), name + ' 仍在写托盘 tooltip');
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'renderer', 'orb-tray.png')), '托盘图标应随托盘一起删除');
  assert.ok(!fs.existsSync(path.join(ROOT, 'renderer', 'orb-tray@2x.png')));
  assert.ok(!mainSrc.includes('orb-tray'), 'main.js 不得再引用已删除的托盘模块');
  assert.ok(mainSrc.includes("require('./orb-access')"), '主进程必须接上新的快捷键模块');
  assert.ok(buildYml.includes('renderer/**/*'), '渲染层资源仍在打包白名单里（球 / 小窗靠它）');
});

t('模式偏好只写 userData/orb-prefs.json，不碰 CLI 配置 / ~/.hermes', () => {
  assert.ok(/orb-prefs\.json/.test(prefCode));
  assert.ok(/fs\.writeFileSync\(prefsPath\(userDataDir\)/.test(prefCode));
  assert.ok(!/\.hermes|config\.yaml|HERMES_HOME|current/.test(prefCode));
  assert.ok(!/\.hermes|config\.yaml|HERMES_HOME/.test(accessCode));
  assert.ok(/MODES = \['always', 'hotkey'\]/.test(prefCode), '只认两个枚举模式');
});

t('主进程在 whenReady 之后只建一次快捷键，退出时成对释放', () => {
  assert.ok(/const \{ createOrbAccess, ACCEL_LABEL \} = require\('\.\/orb-access'\)/.test(mainSrc));
  assert.ok(/app\.whenReady\(\)\.then\(\(\) => \{[\s\S]{0,700}orbAccess = createOrbAccess\(/.test(mainSrc));
  assert.ok(/if \(orbAccess\) \{ orbAccess\.destroy\(\); orbAccess = null; \}/.test(mainSrc));
  assert.ok(/onHotkey: \(\) => toggleOrbChat\(\)/.test(mainSrc));
  assert.ok(/onModeChange: \(mode\) => applyOrbMode\(mode\)/.test(mainSrc));
});

t('hotkey 模式下球不常驻桌面，唤起小窗才出现，收起即隐去', () => {
  assert.ok(/orbActive = true/.test(mainSrc) && /orbActive = false/.test(mainSrc));
  assert.ok(/if \(orbAccess && orbAccess\.prefs\(\)\.mode === 'hotkey'\) o\.hide\(\);/.test(mainSrc));
  assert.ok(/else orb\.show\(orbSnapshot\(\)\)/.test(mainSrc), 'always 模式必须保持原有常驻行为');
  assert.ok(/function revealBallForChat\(\)/.test(mainSrc));
  assert.ok(/revealBallForChat\(\);[\s\S]{0,140}const ok = oc\.open\(\)/.test(mainSrc));
  assert.ok(/!chatOpen && \(hotkeyOnly \|\| !orbActive\)/.test(mainSrc),
    '球只在「主窗口已收起」或「小窗正开着」时允许留在桌面');
  const hideBody = mainSrc.slice(mainSrc.indexOf('const chatOpen'), mainSrc.indexOf('function pushOrbChatRunning'));
  assert.ok(/orb\.hide\(\)/.test(hideBody));
  assert.ok(/if \(!orbActive\) return;/.test(mainSrc), '球隐去时低频状态对齐不能停摆');
});

t('hotkey 模式点 Dock / 再次打开 app 也能找回主窗口', () => {
  const activate = mainSrc.slice(mainSrc.indexOf("app.on('activate'"), mainSrc.indexOf('// 显示器分辨率'));
  assert.ok(/orbActive/.test(activate) && /!mainWindow\.isVisible\(\)/.test(activate));
  assert.ok(/leaveOrb\(\)/.test(activate));
  assert.ok(/restoreMain = leaveOrb/.test(mainSrc));
});

t('球右键菜单是模式 / 快捷键的唯一可视化入口，且留了隐藏球的入口', () => {
  assert.ok(/常驻小圆球/.test(orbSrc) && /仅快捷键唤起/.test(orbSrc));
  assert.ok(/全局快捷键 \$\{shortcut\}/.test(orbSrc) && /隐藏小圆球/.test(orbSrc));
  assert.ok(/opts\.onSetMode/.test(orbSrc) && /opts\.onSetHotkey/.test(orbSrc));
  assert.ok(/getPrefs: \(\) => \(orbAccess \? orbAccess\.prefs\(\)/.test(mainSrc));
  assert.ok(/orb-prefs/.test(accessSrc), '模式偏好仍由主进程统一持有');
});

section('3z. 连接轨运行中呼吸：只认主进程回合态、减少动态效果有降级');

t('连接轨只在主进程下发 running=true 时呼吸，走既有 orbchat:state 通道', () => {
  assert.ok(/data-running="false"/.test(ocHtmlSrc), 'HTML 要有静态初始态，避免首帧闪一下');
  assert.ok(/body\[data-running="true"\] \.oc-rail\s*\{/.test(ocCssSrc));
  assert.ok(/@keyframes oc-rail-breathe/.test(ocCssSrc));
  const kf = (ocCssSrc.match(/@keyframes oc-rail-breathe\s*\{[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(/translateY\(-50%\)/.test(kf), '动画里必须保留垂直居中');
  assert.ok(/opacity:/.test(kf) && /scaleY\(/.test(kf), '呼吸要有明暗与伸缩两个维度');
  assert.ok(!/body\[data-running="false"\][^{]*animation/.test(ocCssSrc), '空闲态不得呼吸');
  assert.ok(/function applyTurnState\(/.test(ocJsSrc));
  assert.strictEqual((ocJsSrc.match(/dataset\.running\s*=/g) || []).length, 1, '回合态只能有一个写入口');
  for (const call of ['applyTurnState(S.running)', 'applyTurnState(p.running)', 'applyTurnState(r.running)']) {
    assert.ok(ocJsSrc.includes(call), '缺少主进程快照消费点：' + call);
  }
  const evtBody = ocJsSrc.slice(ocJsSrc.indexOf('function onEvent'), ocJsSrc.indexOf('/* ---------------- 发送'));
  assert.ok(!/dataset\.running|applyTurnState/.test(evtBody), '不得根据本地事件流自造回合态');
  assert.ok(/running: busyTurns > 0/.test(mainSrc), '主进程快照必须带真实在途回合数');
  assert.ok(/function pushOrbChatRunning\(/.test(mainSrc) && /pushOrbChatRunning\(true\)/.test(mainSrc));
  assert.ok(/orbchat:state/.test(ocPreSrc) && /pushState/.test(ocSrc), '不新增 IPC 通道');
});

t('打开面板后光标直接落在输入框：点球 / ⌥⇧H 就能打字', () => {
  assert.ok(/onFocus: \(fn\) => on\('orbchat:focus'/.test(ocPreSrc), 'preload 未暴露 focus 订阅');
  assert.ok(/push\('orbchat:focus', \{\}\)/.test(ocSrc), 'open() 未推送 focus');
  assert.ok(/'orbchat:focus'/.test(ocSrc), 'focus 通道不在 PUSHABLE 白名单里会被静默丢弃');
  assert.ok(/did-finish-load[\s\S]{0,420}orbchat:focus/.test(ocSrc), '首次加载要补一次 focus');
  assert.ok(/api\.onFocus\(/.test(ocJsSrc), '渲染层未订阅 focus');
  const body = ocJsSrc.slice(ocJsSrc.indexOf('api.onFocus('), ocJsSrc.indexOf('api.onSync('));
  assert.ok(/els\.input\.focus\(\)/.test(body), '订阅里必须真的调用 input.focus()');
  assert.ok(/setSelectionRange\(n, n\)/.test(body), '插入点应落在草稿末尾（不能全选覆盖）');
});

t('减少动态效果：呼吸停转但保留一条完整可读的静态轨', () => {
  const reduced = (ocCssSrc.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  assert.ok(/body\[data-running="true"\] \.oc-rail/.test(reduced));
  assert.ok(/animation: none !important/.test(reduced),
    '通配符把动画压成 0.001ms 会把轨冻在最暗最短那帧，必须显式停转');
  assert.ok(/opacity: 1/.test(reduced));
});

t('README 同步：两种模式 / 快捷键 / 呼吸语义都要写清', () => {
  assert.ok(readmeSrc.includes('仅快捷键唤起'));
  assert.ok(readmeSrc.includes('Alt+Shift+H') || readmeSrc.includes('⌥⇧H'));
  assert.ok(readmeSrc.includes('呼吸'));
  assert.ok(readmeSrc.includes('orb-prefs.json'));
});

section('3aa. 小球拖动坐标：实机复现「一拖飞到左上角」后的防回归');

const vm = require('vm');
/** 在零依赖沙箱里真跑一遍 renderer/orb.js，捕获它发给主进程的坐标。
 *  静态正则只能查「有没有 pointermove」，查不出公式写反；必须做数值断言。 */
function makeOrbSandbox() {
  const sent = [];
  const handlers = {};
  const ball = {
    classList: { add() {}, remove() {} },
    addEventListener(type, fn) { (handlers[type] || (handlers[type] = [])).push(fn); },
    setPointerCapture() {}, releasePointerCapture() {}, setAttribute() {},
  };
  const nodes = { 'orb-ball': ball, 'orb-badge': {}, 'orb-live': {} };
  let raf = null;
  let now = 0;
  const sandbox = {
    window: {
      orbAPI: {
        drag: (x, y) => sent.push({ drag: [x, y] }),
        dragEnd: () => sent.push('dragEnd'),
        click: () => sent.push('click'),
        restore: () => sent.push('restore'),
        menu: () => sent.push('menu'),
        onStatus: () => () => {},
      },
    },
    document: {
      body: { dataset: {} },
      getElementById: (id) => nodes[id] || {},
      addEventListener() {},
    },
    performance: { now: () => now },
    requestAnimationFrame: (cb) => { raf = cb; return 1; },
    cancelAnimationFrame: () => { raf = null; },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(orbJsSrc, sandbox, { filename: 'renderer/orb.js' });
  const fire = (type, o) => {
    const ev = Object.assign({ type, button: 0, pointerId: 1, preventDefault() {} }, o);
    for (const fn of handlers[type] || []) fn(ev);
  };
  const flushRaf = () => { const cb = raf; raf = null; if (cb) cb(); };
  return { sent, fire, flushRaf, setNow: (v) => { now = v; } };
}

t('拖动 100px：发给主进程的是「窗口原点 + 指针位移」，不是 screenX - 窗口原点', () => {
  const s = makeOrbSandbox();
  const W = { x: 1588, y: 651 };   // 球在屏幕右侧，旧公式在这里会算出 x=126
  s.fire('pointerdown', { screenX: W.x + 26, screenY: W.y + 26, clientX: 26, clientY: 26 });
  s.fire('pointermove', { screenX: W.x + 126, screenY: W.y + 26, clientX: 126, clientY: 26 });
  s.flushRaf();
  assert.deepStrictEqual(s.sent, [{ drag: [W.x + 100, W.y] }],
    '球会飞到屏幕左上角：x 被算成了 clientX 量级');
});

t('窗口跟随移动后继续拖：clientX 随窗口变化也不产生累积漂移', () => {
  const s = makeOrbSandbox();
  const W = { x: 1588, y: 651 };
  s.fire('pointerdown', { screenX: W.x + 26, screenY: W.y + 26, clientX: 26, clientY: 26 });
  s.fire('pointermove', { screenX: W.x + 126, screenY: W.y + 26, clientX: 126, clientY: 26 });
  s.flushRaf();
  // 窗口已跟上，指针回到窗口内原抓取点（clientX 变回 26），再物理右移 100px
  s.fire('pointermove', { screenX: W.x + 226, screenY: W.y + 26, clientX: 26, clientY: 26 });
  s.flushRaf();
  assert.deepStrictEqual(s.sent, [
    { drag: [W.x + 100, W.y] },
    { drag: [W.x + 200, W.y] },
  ]);
});

t('手抖 2px 仍是点击；长按不动不算点击；pointercancel 不得误弹小窗', () => {
  const tap = makeOrbSandbox();
  tap.fire('pointerdown', { screenX: 1614, screenY: 677, clientX: 26, clientY: 26 });
  tap.fire('pointermove', { screenX: 1616, screenY: 677, clientX: 28, clientY: 26 });
  tap.fire('pointerup', { screenX: 1616, screenY: 677, clientX: 28, clientY: 26 });
  assert.deepStrictEqual(tap.sent, ['click'], '轻微位移不应注册 rAF / 发 drag');

  const hold = makeOrbSandbox();
  hold.fire('pointerdown', { screenX: 1614, screenY: 677, clientX: 26, clientY: 26 });
  hold.setNow(400);
  hold.fire('pointerup', { screenX: 1614, screenY: 677, clientX: 26, clientY: 26 });
  assert.deepStrictEqual(hold.sent, ['dragEnd'], '长按不应触发 click');

  const cancel = makeOrbSandbox();
  cancel.fire('pointerdown', { screenX: 1614, screenY: 677, clientX: 26, clientY: 26 });
  cancel.fire('pointercancel', {});
  assert.deepStrictEqual(cancel.sent, ['dragEnd'], '缺屏幕坐标的 pointercancel 不能被当成点击');
});

t('主进程：跨屏按球心选屏、一次拖动只收一次小窗、dragend 立即落盘', () => {
  assert.ok(!/press\.offX|event\.screenX\s*-\s*press\.offX/.test(orbJsSrc), '旧的错误公式又回来了');
  assert.ok(/press\.winX \+ \(event\.screenX - press\.sx\)/.test(orbJsSrc), '缺少增量式坐标');
  assert.ok(/screen\.getAllDisplays\(\)/.test(orbSrc) && /width: 1, height: 1/.test(orbSrc),
    '跨屏拖动必须按球心选屏，否则球会卡在屏幕边缘');
  assert.ok(/if \(!dragging\) \{[\s\S]{0,120}opts\.onDragStart\(\)/.test(orbSrc),
    '每帧 drag IPC 都会关一次小窗');
  assert.ok(/dragging = false;\s*savePos\(\)/.test(orbSrc), '拖动结束未复位标志并落盘');
  assert.ok(!orbSrc.includes('saveTimer'), '拖完立刻退出会丢位置：不能再等 400ms 节流');
  assert.ok(/function hide\(\) \{[\s\S]{0,80}dragging = false/.test(orbSrc),
    '拖动中途球被隐去时要复位标志');
});

t('README 同步：拖动坐标是增量式', () => {
  assert.ok(readmeSrc.includes('增量式') || readmeSrc.includes('拖动坐标'),
    'README 未记录拖动坐标语义');
});

section('3ab. 右侧 rail 宽度可调：方向、上限、键盘等价与 iframe 命中');

const railVm = require('vm');
const railJsSrc = read('renderer/rail-resize.js');

/** 在零依赖沙箱里真跑一遍 renderer/rail-resize.js。
 *  静态正则查不出「方向写反 / 上限算错」，必须做数值断言。 */
function makeRailSandbox(opts = {}) {
  const style = {
    props: {},
    setProperty(k, v) { this.props[k] = String(v); },
    getPropertyValue(k) { return this.props[k] || ''; },
  };
  const handlers = {};
  const handle = {
    attrs: {}, blurred: false,
    addEventListener(type, fn) { (handlers[type] || (handlers[type] = [])).push(fn); },
    setPointerCapture() {}, setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; }, blur() { this.blurred = true; },
  };
  const rail = {
    style,
    hidden: opts.hidden === true,
    getBoundingClientRect: () => ({ width: opts.railW === undefined ? 400 : opts.railW }),
  };
  const main = { getBoundingClientRect: () => ({ width: opts.mainW === undefined ? 643 : opts.mainW }) };
  const classes = new Set();
  const body = { classList: {
    add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, has(c) { return classes.has(c); },
  } };
  const store = Object.assign({}, opts.store || {});
  const sandbox = {
    document: {
      getElementById: (id) => ({ rail, main, 'rail-resize': handle })[id] || null,
      body,
    },
    window: { addEventListener() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    MutationObserver: class { observe() {} },
    console,
  };
  railVm.createContext(sandbox);
  railVm.runInContext(railJsSrc, sandbox, { filename: 'renderer/rail-resize.js' });
  const fire = (type, o) => {
    const ev = Object.assign({
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0,
      preventDefault() {}, stopPropagation() {},
    }, o || {});
    for (const fn of handlers[type] || []) fn(ev);
  };
  return {
    rail, handle, body, store, fire,
    width: () => parseFloat(style.props['--rail-w']) || 400,
  };
}

t('默认 400px；向左拖 100px = 面板变宽 100px（方向与左侧栏相反）', () => {
  const s = makeRailSandbox();
  assert.strictEqual(s.width(), 400, '默认宽度被改，破坏了定版几何');
  s.fire('pointerdown', { clientX: 900 });
  s.fire('pointermove', { clientX: 800 });
  assert.strictEqual(s.width(), 500, '方向写反，或又拿窗口原点当抓取偏移');
  assert.ok(s.body.classList.has('rail-resizing'), '拖拽期未锁定光标 / iframe');
  s.fire('pointerup', { clientX: 800 });
  assert.strictEqual(s.store['rail-width'], '500', '松开后没有落盘');
  assert.strictEqual(s.handle.getAttribute('aria-valuenow'), '500', 'aria 未同步');
  assert.ok(!s.body.classList.has('rail-resizing'), '拖拽结束后未解锁');
});

t('向右拖是变窄，且 280px 下限不会被穿透', () => {
  const s = makeRailSandbox();
  s.fire('pointerdown', { clientX: 900 });
  s.fire('pointermove', { clientX: 960 });
  assert.strictEqual(s.width(), 340);
  s.fire('pointermove', { clientX: 9000 });
  assert.strictEqual(s.width(), 280);
});

t('上限按主区留白实时收紧，不把聊天区挤没', () => {
  const s = makeRailSandbox({ railW: 400, mainW: 643 }); // 可用 1043 → 上限 623
  s.fire('pointerdown', { clientX: 900 });
  s.fire('pointermove', { clientX: -9000 });
  assert.strictEqual(s.width(), 623, '上限未扣掉主区最小宽度 420');
  assert.strictEqual(s.handle.getAttribute('aria-valuemax'), '623', 'aria 上限没跟着窗口变');
});

t('键盘与鼠标等价：←/→ ±16、Shift 加速、Home/End、Enter 与双击复位', () => {
  const s = makeRailSandbox();
  s.fire('keydown', { key: 'ArrowLeft' });
  assert.strictEqual(s.width(), 416);
  s.fire('keydown', { key: 'ArrowRight' });
  assert.strictEqual(s.width(), 400);
  s.fire('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.strictEqual(s.width(), 448);
  s.fire('keydown', { key: 'Home' });
  assert.strictEqual(s.width(), 280);
  s.fire('keydown', { key: 'End' });
  assert.strictEqual(s.width(), 623);
  s.fire('keydown', { key: 'Enter' });
  assert.strictEqual(s.width(), 400);
  s.fire('dblclick', {});
  assert.strictEqual(s.width(), 400);
  s.fire('keydown', { key: 'Escape' });
  assert.ok(s.handle.blurred, 'Esc 应只让手柄失焦，不冒泡关掉别的层');
});

t('偏好恢复：合法值生效、非法值回落、隐藏态不把偏好砍掉', () => {
  assert.strictEqual(makeRailSandbox({ store: { 'rail-width': '560' } }).width(), 560);
  assert.strictEqual(makeRailSandbox({ store: { 'rail-width': 'oops' } }).width(), 400);
  assert.strictEqual(makeRailSandbox({ hidden: true, store: { 'rail-width': '740' } }).width(), 740,
    '面板隐藏时量不到尺寸，不该按 0 宽度夹到下限');
});

t('触摸不抢滚动；pointercancel / lostpointercapture 都能收口', () => {
  const s = makeRailSandbox();
  s.fire('pointerdown', { pointerType: 'touch', clientX: 900 });
  s.fire('pointermove', { clientX: 800 });
  assert.strictEqual(s.width(), 400, '触摸按下不该启动拖拽');
  s.fire('pointerdown', { clientX: 900 });
  s.fire('pointercancel', {});
  assert.ok(!s.body.classList.has('rail-resizing'), '取消后仍锁着全局光标');
  assert.strictEqual(s.store['rail-width'], '400', '取消也要落盘当前值');
});

t('三层接线：手柄语义、CSS 变量、iframe 屏蔽、双主题与动效降级', () => {
  assert.ok(/id="rail-resize"[\s\S]{0,160}role="separator"/.test(htmlSrc), '手柄缺少 separator 语义');
  assert.ok(/id="rail-resize"[\s\S]{0,300}tabindex="0"/.test(htmlSrc), '手柄不可键盘聚焦');
  assert.ok(/<script src="rail-resize\.js"><\/script>/.test(htmlSrc), '增强层脚本没被引入');
  assert.ok(/#rail \{[\s\S]{0,240}width: var\(--rail-w, 400px\)/.test(cssSrc), '默认宽度必须仍是 400px');
  assert.ok(/#rail \{[\s\S]{0,240}position: relative/.test(cssSrc), '手柄缺少定位基准');
  assert.ok(/body\.rail-resizing iframe \{ pointer-events: none; \}/.test(cssSrc),
    'iframe 会吞掉跨文档 pointermove');
  assert.ok(/#rail-resize:focus-visible/.test(cssSrc), '键盘焦点不可见');
  assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,220}#rail-resize::after/.test(cssSrc),
    '指示线缺少减少动态效果降级');
  const seg = cssSrc.slice(cssSrc.indexOf('#rail-resize {'), cssSrc.indexOf('.rail-head'));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(seg), '新手柄样式引入硬编码颜色，深色主题会失配');
  assert.ok(!/rail\.style\.width/.test(railJsSrc), '增强层只该写 CSS 变量');
  assert.ok(/setPointerCapture/.test(railJsSrc) && /pointercancel/.test(railJsSrc), '缺少捕获 / 取消收口');
  assert.ok(/MIN_MAIN = 420/.test(railJsSrc), '主区最小宽度保护被去掉');
});

t('README 同步：方向、范围与主区留白都写清', () => {
  assert.ok(/rail-resize\.js/.test(readmeSrc) && /--rail-w/.test(readmeSrc), 'README 未记录增强层');
  assert.ok(/280–760px/.test(readmeSrc) && /420px/.test(readmeSrc), 'README 未记录范围与主区留白');
});

section('3ac. 品牌行 / 自绘下拉 / 球 Profile 菜单 / 受让人 / 终端乱码');
const uiSelectSrc = read('renderer/ui-select.js');
const termScreenSrc = read('renderer/term-screen.js');
const termSvcSrc = read('main/services/hermes-terminal.js');

t('品牌行左沿对齐菜单，profile 胶囊不再绝对定位 / 不再被裁名字', () => {
  const brand = cssSrc.slice(cssSrc.indexOf('.sb-brand {'), cssSrc.indexOf('.sb-logo'));
  assert.ok(/justify-content:\s*flex-start/.test(brand), '品牌行仍是居中');
  assert.ok(!/translateX\(-20px\)/.test(brand), '居中偏移没去掉');
  assert.ok(/padding:\s*0 10px 10px 20px/.test(brand), 'logo 左沿未与菜单图标持平');
  assert.ok(/\.sb-wordmark\s*\{[\s\S]{0,140}min-width:\s*0/.test(cssSrc), '窄侧栏会挤掉胶囊');
  const chip = cssSrc.slice(cssSrc.indexOf('.pf-chip {'), cssSrc.indexOf('.pf-chip:hover'));
  assert.ok(!/position:\s*absolute/.test(chip) && !/right:\s*-14px/.test(chip), '胶囊仍挂在容器外侧');
  assert.ok(/margin-left:\s*auto/.test(chip) && /flex-shrink:\s*0/.test(chip), '胶囊没有推到右侧且可被压缩');
  assert.ok(/\.pf-name\s*\{[^}]*max-width:\s*72px/.test(cssSrc), 'profile 名又被压成 defa…');
});

t('下拉全部自绘：HTML 无原生 select / datalist，动态创建也走 hm-select', () => {
  assert.ok(!/<select\b/.test(htmlSrc), '还留着 macOS 原生 <select>');
  assert.ok(!/<datalist\b/.test(htmlSrc), '还留着原生 datalist 弹层');
  assert.ok(!/createElement\('select'\)/.test(appSrc), '设置页默认模型仍是原生下拉');
  assert.ok(/<script src="ui-select\.js"><\/script>[\s\S]{0,200}<script src="app\.js">/.test(htmlSrc),
    '组件脚本必须在 app.js 之前加载');
  assert.ok(/customElements\.define\('hm-select'/.test(uiSelectSrc));
  assert.ok(/txt\.textContent = it\.label/.test(uiSelectSrc), '候选文本必须走 textContent');
  assert.ok(/setOptions\(/.test(uiSelectSrc) && /reset\(\)/.test(uiSelectSrc));
  assert.ok(/hm-select/.test(appSrc) && /kbFillSelect/.test(appSrc));
  const usCss = cssSrc.slice(cssSrc.indexOf('.ui-select {'));
  assert.ok(usCss.includes('.us-pop') && usCss.includes(':focus-visible') && usCss.includes('var(--'));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(usCss), '自绘下拉出现硬编码色，会破坏深色主题');
});

/** 最小 DOM stub：让 ui-select.js 的类能在零依赖沙箱里真跑一遍。 */
function makeSelect() {
  class El {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.children = []; this.attrs = {}; this.style = {}; this.dataset = {};
      this.hidden = false; this._events = []; this._handlers = {}; this._classes = new Set();
      const self = this;
      this.classList = {
        add: (c) => self._classes.add(c), remove: (c) => self._classes.delete(c),
        contains: (c) => self._classes.has(c),
        toggle: (c, on) => { if (on) self._classes.add(c); else self._classes.delete(c); },
      };
    }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(' '); }
    set innerHTML(v) { if (v === '') this.children = []; }
    get innerHTML() { return ''; }
    appendChild(c) { this.children.push(c); return c; }
    append(...cs) { cs.forEach((c) => this.appendChild(c)); }
    replaceChildren() { this.children = []; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(type, fn) { (this._handlers[type] || (this._handlers[type] = [])).push(fn); }
    dispatchEvent(e) { this._events.push(e.type); for (const fn of this._handlers[e.type] || []) fn(e); }
    focus() {} blur() {} scrollIntoView() {}
    querySelectorAll(sel) { return sel === '.us-opt' ? this.children.filter((c) => c._classes.has('us-opt')) : []; }
    contains(node) { return node === this || this.children.includes(node); }
    getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 38, width: 100 }; }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text || ''; }
    get scrollHeight() { return 120; }
  }
  const body = new El('body');
  const sandbox = {
    HTMLElement: El,
    customElements: { get: () => null, define: (_n, cls) => { sandbox.Cls = cls; } },
    document: { body, createElement: (tag) => new El(tag), addEventListener() {}, getElementById: () => null },
    window: { innerWidth: 1200, innerHeight: 800, addEventListener() {} },
    Event: class { constructor(type, o) { this.type = type; this.bubbles = !!(o && o.bubbles); } },
    Date, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(uiSelectSrc, sandbox, { filename: 'renderer/ui-select.js' });
  const inst = new sandbox.Cls();
  inst.connectedCallback();
  return inst;
}

t('自绘下拉数值语义：占位项、value、change、reset、自由值', () => {
  const s = makeSelect();
  s.setOptions([{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], '全部');
  assert.strictEqual(s.value, '');
  assert.strictEqual(s._label.textContent, '全部');
  s.value = 'b';
  assert.strictEqual(s._label.textContent, 'Beta');
  s._pick({ value: 'a' });
  assert.strictEqual(s.value, 'a');
  assert.ok(s._events.includes('change') && s._events.includes('input'), '表单收不到 change');
  s.reset();
  assert.strictEqual(s.value, '', 'reset 没回到默认项');
  s.value = 'custom-profile';
  assert.strictEqual(s._label.textContent, 'custom-profile', '自由值不能显示成空白');
  s.setOptions([{ value: 'x', label: 'X' }], '请选择');
  assert.strictEqual(s.value, '', '换候选后旧值必须失效');
});

t('终端屏幕数值断言：ANSI 序列、回车重绘、跨 chunk 与中文 emoji', () => {
  const sandbox = { module: { exports: {} }, window: undefined, console };
  vm.createContext(sandbox);
  vm.runInContext(termScreenSrc, sandbox, { filename: 'renderer/term-screen.js' });
  const { TermScreen } = sandbox.module.exports;
  const s = new TermScreen();
  assert.strictEqual(s.push('\x1b[31m红\x1b[0m色'), '红色', 'SGR 颜色序列漏成可见乱码');
  s.reset();
  assert.strictEqual(s.push('旧提示\r\x1b[2K新提示'), '新提示', '回车 + 清行没有覆盖旧提示符');
  s.reset();
  assert.strictEqual(s.push('A\x1b[1;32'), 'A', '跨 chunk 的半截 CSI 被当成正文');
  assert.strictEqual(s.push('mB'), 'AB', '下一片没接上未完成的 CSI');
  s.reset();
  assert.strictEqual(s.push('\x1b]0;窗口标题\x07OK'), 'OK', 'OSC 标题漏进正文');
  s.reset();
  assert.strictEqual(s.push('\x1b[?25lX\x1b[?25h'), 'X', '光标显隐序列漏进正文');
  s.reset();
  assert.strictEqual(s.push('ab\bc\r\n第二行'), 'ac\n第二行', '退格 / 换行语义不对');
  s.reset();
  assert.strictEqual(s.push('中文🙂'), '中文🙂', '代理对被拆成豆腐块');
  s.reset();
  assert.strictEqual(s.push('\x1b[2J干净'), '干净', '清屏没生效');
  const small = new TermScreen({ maxLines: 3 });
  for (let i = 0; i < 10; i += 1) small.push('L' + i + '\n');
  assert.ok(small.lines.length <= 3, '长输出没有上限，终端会吃满内存');
});

t('终端接线：原始字节不再直接 += 进 DOM，主进程按 UTF-8 分块解码', () => {
  assert.ok(/<script src="term-screen\.js">/.test(htmlSrc));
  assert.ok(appSrc.includes('termScreen.push(data)'));
  assert.ok(!/out\.textContent \+= data/.test(appSrc), '又回到直接追加原始 pty 字节');
  assert.ok(termSvcSrc.includes("require('string_decoder')") && /new StringDecoder\('utf8'\)/.test(termSvcSrc),
    '中文跨 data 事件会被切成 U+FFFD');
  assert.ok(/var\(--mono\), "PingFang SC"/.test(cssSrc), '终端字体缺中文回退，缺字会显示成方块');
  assert.ok(/overflow-wrap: anywhere/.test(cssSrc), 'word-break:break-all 会把长行拆碎');
});

t('看板新建任务：受让人是自绘下拉，候选只认磁盘上的真实 profile', () => {
  assert.ok(/<hm-select id="kb-f-assignee"/.test(htmlSrc), '受让人还是文本输入框');
  assert.ok(!/id="kb-f-assignee-list"/.test(htmlSrc), 'datalist 没删干净');
  assert.ok(/ap\.setOptions\(profiles\.map/.test(appSrc), '候选没有来自 kbProfileSet()');
  assert.ok(/placeholder="留空则不指派"/.test(htmlSrc));
  assert.ok(/assignee: \$\('#kb-f-assignee'\)\?\.value/.test(appSrc), '提交路径仍要读 .value');
  assert.ok(/addEventListener\('change', \(\) => kbSyncAssigneeHint\(\)\)/.test(appSrc));
});

t('球下拉：每个 profile 有二级会话菜单，多出来的收进「更多」', () => {
  assert.ok(/menuSections:\s*orbMenuSections/.test(mainSrc), '球菜单没接主进程数据源');
  assert.ok(/async function orbMenuSections/.test(mainSrc));
  assert.ok(/listSessions\(\{ limit: ORB_MORE_LIMIT, profileName: name \}\)/.test(mainSrc));
  assert.ok(/profile\.validName\(profileName\)/.test(sessSrc) && /profile\.exists\(profileName\)/.test(sessSrc),
    '其它 profile 的 db 路径必须白名单化');
  assert.ok(/ORB_RECENT = 5/.test(mainSrc) && /更多会话 \(\$\{more\.length\}\)/.test(mainSrc));
  assert.ok(/submenu: orbProfileSubmenu/.test(mainSrc) && /submenu: more\.map/.test(mainSrc));
  assert.ok(/await opts\.menuSections\(\)/.test(orbSrc), '球窗口没有等异步菜单数据');
  assert.ok(!/open-session|listSessions|profile:list|sessions:/.test(orbPreSrc),
    '球 preload 不该直接读会话 / profile 数据');
  assert.ok(/orb-caret/.test(orbHtmlSrc) && /\.orb-caret/.test(orbCssSrc), '没有可见的下拉入口');
  assert.ok(/ArrowDown/.test(orbJsSrc) && /orb\.menu\(\)/.test(orbJsSrc), '键盘无法打开下拉');
});

t('球菜单的会话意图复用主窗口既有 profile 链路，不另造状态机', () => {
  assert.ok(preloadSrc.includes('onOrbOpenSession:'));
  assert.ok(mainSrc.includes("safeSend('orb:open-session'"));
  assert.ok(/needsSwitch/.test(mainSrc) && /needsSwitch/.test(appSrc));
  assert.ok(appSrc.includes("sessionStorage.setItem('orb:open-session'"));
  assert.ok(/doSwitchProfile\(p\.profile\)/.test(appSrc), '切 profile 没走既有的重启后端链路');
  assert.strictEqual(collect(mainSrc, /chat\.submit\(/g).length, 1, '球菜单不得另开一条提交通道');
});

t('README 同步：自绘下拉、球菜单、终端解码、品牌行', () => {
  assert.ok(readmeSrc.includes('自绘下拉') || readmeSrc.includes('hm-select'));
  assert.ok(readmeSrc.includes('Profile 下拉') || readmeSrc.includes('最近会话'));
  assert.ok(readmeSrc.includes('ANSI') || readmeSrc.includes('TermScreen'));
});

section('3ad. 看板拖拽：投放区几何恒定、幽灵不挡指针、边缘自动滚动');

/** 从 app.js 里按名字截出整个函数源码（括号配平），再丢进 vm 真跑。
 *  静态正则查不出「幽灵盖住指针」「滚动方向写反」这类数值问题。 */
function grabFn(src, name) {
  // 同时支持 `function name(...) {}` 与 `const name = (...) => {}` 两种写法
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) i = src.indexOf('const ' + name + ' = ');
  assert.ok(i >= 0, '找不到函数 ' + name);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, j + 1);
}
const dragSandbox = { __out: null };
vm.createContext(dragSandbox);
vm.runInContext(
  grabFn(kbAppSrc, 'kbGhostPos') + '\n' + grabFn(kbAppSrc, 'kbScrollVel')
  + '\n__out = { kbGhostPos: kbGhostPos, kbScrollVel: kbScrollVel };',
  dragSandbox,
  { filename: 'renderer/app.js#drag-math' }
);
const { kbGhostPos, kbScrollVel } = dragSandbox.__out;

t('幽灵卡永远浮在指针上方（底边 < 指针 y），且四个角都被夹进视口', () => {
  const normal = kbGhostPos(500, 300, 240, 80, 1200, 800);
  assert.strictEqual(normal.left, 380, '水平未按指针居中');
  assert.ok(normal.top + 80 < 300 - 8, '幽灵盖住了指针，投放目标会被挡住');
  const plain = (o) => JSON.parse(JSON.stringify(o));   // vm 跨 realm 的字面量原型不同，先拍平
  assert.deepStrictEqual(plain(kbGhostPos(4, 4, 240, 80, 1200, 800)), { left: 8, top: 8 }, '左上未夹进视口');
  const br = kbGhostPos(1198, 798, 240, 80, 1200, 800);
  assert.ok(br.left <= 1200 - 240 - 8 && br.top <= 800 - 80 - 8, '右下未夹进视口');
  // 视口比卡片还窄时不能算出负数
  assert.deepStrictEqual(plain(kbGhostPos(40, 40, 240, 80, 100, 90)), { left: 8, top: 8 }, '窄视口算出了负坐标');
});

t('chip 行边缘自动滚动：贴左向左滚、贴右向右滚、中间与区外静止', () => {
  const r = { left: 100, right: 500 };
  assert.strictEqual(kbScrollVel(300, r, 44, 12), 0, '中间不应滚动');
  assert.strictEqual(kbScrollVel(0, r, 44, 12), 0, '区外不应滚动');
  assert.ok(kbScrollVel(100, r, 44, 12) < 0, '贴左边缘应向左滚');
  assert.strictEqual(kbScrollVel(56, r, 44, 12), -12, '最左侧应达到最大速度');
  assert.ok(kbScrollVel(500, r, 44, 12) > 0, '贴右边缘应向右滚');
  assert.strictEqual(kbScrollVel(544, r, 44, 12), 12, '最右侧应达到最大速度');
});

t('投放区几何恒定：label 定宽、状态文字移出 dock、重建保住横向滚动', () => {
  const dock = htmlSrc.slice(htmlSrc.indexOf('id="kb-dock"'), htmlSrc.indexOf('kb-dock-status'));
  assert.ok(!dock.includes('kb-dock-msg'), '状态文字还在 dock 里：文案一变 chip 就会漂移');
  assert.ok(htmlSrc.includes('id="kb-dock-msg"'), '投放结果缺少播报节点');
  assert.ok(kbCss.includes('.kb-dock-status'), '状态行缺少样式');
  const label = kbCss.slice(kbCss.indexOf('.kb-dock-label {'), kbCss.indexOf('.kb-dock-hint'));
  assert.ok(/flex:\s*0 0 \d+px/.test(label) && /width:\s*\d+px/.test(label),
    'label 不是定宽槽位：拖动提示一长一短就会挤动 chip');
  // 投放区平时是隐藏浮层，所以 chip 直接就带「可投放」的虚线圈，不再是拖动时才加
  assert.ok(/\.kb-worker \{[^}]*border-style: dashed/.test(kbCss), '投放 chip 缺少「能放到哪」的范围提示');
  assert.ok(kbAppSrc.includes('const scrollLeft = host.scrollLeft'), '重建 chip 行未保住滚动位置');
  assert.ok(kbAppSrc.includes('host.scrollLeft = scrollLeft'), '重建后未恢复滚动位置');
});

t('拖拽交互：就近吸附、Esc 可撤、拖动中不重建不轮询、补发的 click 不误触', () => {
  assert.ok(kbAppSrc.includes('KB_DOCK_SNAP') && kbAppSrc.includes('function kbChipAt('),
    '缺少 chip 就近吸附：落在缝隙里就白拖');
  assert.ok(kbAppSrc.includes('kbChipAt(x, y)') && kbAppSrc.includes('kbDragAutoScroll(x, y)'),
    'pointermove 未同时做吸附与自动滚动');
  assert.ok(kbAppSrc.includes('requestAnimationFrame(step)'), '自动滚动未走 rAF 单循环');
  assert.ok(!/setInterval\([^)]*\)[\s\S]{0,120}scrollLeft/.test(kbAppSrc), '自动滚动不得用定时器');
  assert.ok(kbAppSrc.includes('function kbDragReset(instant)') && kbAppSrc.includes('kbReducedMotion()'),
    '取消拖动未降级「减少动态效果」');
  assert.ok(/if \(KbDrag\.on \|\| KbDrag\.armed\) \{[^}]*kbDragReset\(\)[^}]*return/.test(appSrc),
    'Esc 未优先取消拖动（撤掉拖动后必须 return，不能顺手关页/中断回合）');
  assert.ok(kbAppSrc.includes('if (KbDrag.on) return; // 拖动中不重建'), '拖动中仍会重建投放区');
  assert.ok(appSrc.includes('if (KbDrag.suppressClick) { KbDrag.suppressClick = false; return; }'),
    '落点补发的 click 会顺带切换筛选');
  // 幽灵只做视觉：克隆出来的卡片不能残留可点击 / 可聚焦标识
  assert.ok(kbAppSrc.includes("clone.removeAttribute('data-kb-task')"), '幽灵卡仍带任务 id，会抢命中');
  assert.ok(kbAppSrc.includes("clone.setAttribute('tabindex', '-1')"), '幽灵卡仍可被键盘聚焦');
  assert.ok(kbCss.includes('.kb-drag-ghost .kb-ghost-card'), '幽灵卡样式缺失');
  assert.ok(kbCss.includes('body.kb-dragging .kb-dock-label'), '拖动中槽位没有状态反馈');
});

section('3ae. 思考程度并进模型菜单：二级下拉、唯一写入口、/effort 仍可达');

t('状态条不再有独立的思考程度 chip，力度收进模型菜单二级', () => {
  assert.ok(!htmlSrc.includes('id="chip-reasoning"'), '独立的思考程度 chip 未移除');
  assert.ok(!appSrc.includes("$('#chip-reasoning')"), 'app.js 仍有指向已删 chip 的死绑定');
  assert.ok(htmlSrc.includes('id="chip-submenu"'), '缺少二级菜单宿主（放 body 层才能不被 overflow 裁掉）');
  assert.ok(kbAppSrc.includes('EFFORT_LEVELS') || appSrc.includes("const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']"),
    '力度档位被改动');
  assert.ok(appSrc.includes("key: '::effort', name: '思考程度'"), '模型菜单里没有思考程度入口');
  assert.ok(appSrc.includes('h.openSub(') && appSrc.includes('openSub:'), '菜单未暴露展开二级的能力');
  assert.ok(appSrc.includes("if (opts && opts.effort && h) h.openSub('::effort');"), '/effort 未直接落到力度二级');
  assert.ok(appSrc.includes('$(\'#chip-model\').onclick = () => openModelPicker();'),
    '模型 chip 仍把事件对象当参数传进 openModelPicker');
});

t('力度只写桌面端 reasoning，不碰 CLI 的 agent.reasoning_effort', () => {
  const setEffort = grabFn(appSrc, 'setEffort');
  assert.ok(setEffort.includes('api.setConfig({ reasoning: level })'), '力度未走桌面端配置通道');
  assert.ok(setEffort.includes('updateStatus()'), '改完力度未刷新状态条');
  assert.ok(!/config set|writeFile|reasoning_effort/.test(setEffort), 'setEffort 不得触碰 CLI 配置');
  const codeOnly = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/reasoning_effort/.test(codeOnly), 'renderer 不应出现 CLI 的 reasoning_effort 键');
  // 二级菜单的选中态与定位：贴右放不下要翻到左边
  assert.ok(appSrc.includes('src.subValue'), '二级菜单没有选中态来源');
  assert.ok(appSrc.includes('if (sl + sw > vw - 8) sl = Math.max(8, r.left - sw - 4);'), '二级菜单未做左右翻边');
  assert.ok(cssSrc.includes('#chip-submenu') && cssSrc.includes('.wb-menu-row.has-sub'),
    '二级菜单缺少样式');
  assert.ok(cssSrc.includes('.wb-menu-caret'), '缺少「有二级」的箭头暗示');
});

section('3af. dsh 输入区改版：圆形附件 / 权限胶囊 / 两态发送键 / 用量带 / 图标操作条');

t('输入区结构与 dsh 对齐：圆形 +、权限胶囊、两态发送键', () => {
  // 图标改用 dsh 的 plus-outline（纯路径加号，不再用字符 +）：两笔 M8 2V14 / M2 8H14
  const attach = (htmlSrc.match(/<button id="btn-attach"[\s\S]*?<\/button>/) || [''])[0];
  assert.ok(/class="cr-icon"/.test(attach) && /aria-label="添加附件"/.test(attach),
    '附件按钮缺少圆形类或 aria-label（纯图标必须有无障碍名）');
  assert.ok(/<svg[\s\S]*M8 2V14[\s\S]*M2 8H14/.test(attach),
    '附件按钮没换成 dsh 的 plus-outline 图标');
  assert.ok(/id="chip-yolo" class="cr-pill"/.test(htmlSrc), '审批模式未改成独立胶囊');
  assert.ok(htmlSrc.includes('aria-pressed="false"'), '权限胶囊缺少 aria-pressed');
  assert.ok(htmlSrc.includes('发消息或创建任务，/ 调用指令，@ 文件或对话'), '占位文案未对齐');
  // 运行态会重写 placeholder：只改 HTML 不改这里，发送一次就跳回旧文案
  assert.ok(appSrc.includes("running ? '正在生成…可按 Esc 或 ■ 停止' : '发消息或创建任务，/ 调用指令，@ 文件或对话'"),
    '运行态的占位文案仍是旧版');
  assert.ok(appSrc.includes("yoloBtn.textContent = state.config.yolo ? '⊙ 完全权限' : '⊙ 审批模式'"),
    '权限胶囊文案未对齐（完全权限 / 审批模式）');
  assert.ok(appSrc.includes('function syncSendState()') && appSrc.includes("b.classList.toggle('ready'"),
    '发送键缺少「空输入软底 / 有内容实心」两态');
  assert.ok(cssSrc.includes('.send-btn.ready'), '缺少发送键实心态样式');
  for (const cls of ['.cr-icon', '.cr-pill']) assert.ok(cssSrc.includes(cls + ' {'), '缺少 ' + cls + ' 样式');
});

t('用量带：轮次/步数 + 总量/缓存命中 + 上下文，且不挤格子', () => {
  assert.ok(htmlSrc.includes('id="st-rounds"'), '状态条缺少轮次/步数');
  // 图标必须是 dsh 原版字形（用户 2026-11-11 二次要求「底部的 token 图标也换」）
  assert.ok(appSrc.includes("setStCell('#st-rounds', MSG_ICO_RETRY, rounds ? `${rounds} 轮"),
    '轮次/步数未渲染或没换成图标');
  assert.ok(appSrc.includes("setStCell('#st-tokens', MSG_ICO_DB, tokTxt)"), '用量未换成数据库图标格');
  assert.ok(appSrc.includes("let tokTxt = `${fmtTokens(total)} tok`"), '用量未改成 dsh 的总量口径');
  // 状态条两处渲染（含复位）都不得再用 ▤ / ↻ 字符
  const stripCode = grabFn(appSrc, 'resetUsageUI') + grabFn(appSrc, 'updateStatus');
  assert.ok(!stripCode.includes('▤'), '状态条仍残留 ▤ 字符图标（已统一为 dsh SVG）');
  assert.ok(!stripCode.includes('`↻ ${rounds} 轮'), '状态条仍残留 ↻ 字符图标（已统一为 dsh SVG）');
  // 图标尺寸必须显式给，否则 SVG 会按 intrinsic 撑满 16px 一行
  assert.ok(/#st-rounds, #st-tokens \{[^}]*align-items: center/.test(cssSrc), '图标格未做垂直居中');
  assert.ok(/\.st-ico svg \{[^}]*width: 13px[^}]*height: 13px/.test(cssSrc), '用量带图标缺少 13px 尺寸');
  assert.ok(cssSrc.includes('#st-session { max-width:'), '会话 id 未封顶，会把中间用量组挤出去');
  assert.ok(appSrc.includes('sid.slice(0, 8)'), '状态条仍显示 48 位会话哈希');
});

t('消息底部：图标 + 用量 + 时间整行常显（不依赖悬停）', () => {
  const bar = grabFn(appSrc, 'msgActionBar');
  assert.ok(bar.includes('MSG_ICO_COPY') && bar.includes('MSG_ICO_RETRY'), '操作按钮未图标化');
  assert.ok(!bar.includes('>复制<') && !bar.includes('>重试<'), '图标仍是文字按钮');
  assert.ok(bar.includes('aria-label="复制"') && bar.includes('aria-label="重试"'), '图标按钮缺少无障碍名');
  assert.ok(bar.includes('msg-foot-row'), '缺少常显的底部信息行容器');
  assert.ok(bar.includes('msg-usage') && bar.includes('MSG_ICO_DB'), '缺少用量（含数据库图标）');
  assert.ok(!/data-msg-act="(like|up|down)"/.test(bar), '不应实现点赞 / 倒赞（用户 2026-11-11 明确不要）');
  // 用量必须写在图标组之外：写在里面就又是「悬停才看得见」（用户 2026-11-11 二次反馈）
  const tpl = bar.slice(bar.indexOf('return `'));
  const actsOpen = tpl.indexOf('class="msg-actions"');
  const actsClose = tpl.indexOf('</span>', actsOpen);
  const usageIdx = tpl.indexOf('${usage}');
  assert.ok(actsOpen > 0 && actsClose > actsOpen && usageIdx > 0, '底部信息行模板缺用量或图标组');
  assert.ok(usageIdx < actsOpen || usageIdx > actsClose,
    '用量仍包在 .msg-actions 里 → 又变成悬停才可见');
  // dsh 版式顺序：图标组 → 用量 → 时间（dsh 截图逐列量：图标在最左，
  // glyph 左缘与正文左缘齐平；用户消息靠 row-reverse 反向排到气泡右缘）
  const tsIdx = tpl.indexOf('${item.ts');
  assert.ok(actsOpen < usageIdx && usageIdx < tsIdx,
    '信息行顺序与 dsh 不一致（应为 图标 → 用量 → 时间）');
  // 信息行必须在文档流内紧随消息（dsh 版式）：absolute 会让它悬在两条消息正中间
  const foot = cssSrc.slice(cssSrc.indexOf('.msg-foot-row {'), cssSrc.indexOf('.msg-user .msg-foot-row'));
  assert.ok(!/position:\s*absolute/.test(foot), '信息行又脱离文档流（会悬在两条消息中间）');
  // dsh 实测：正文块底 → 32px 图标按钮顶 = 15.5px，取 16px
  assert.ok(/margin-top:\s*([4-9]|1[0-2])px/.test(foot), '信息行与正文的间距偏松（用户 2026-11-11 已收两轮）');
  assert.ok(/\.msg \{[^}]*flex-direction:\s*column/.test(cssSrc), '消息容器未纵向排列，信息行会挤到气泡右侧');
  assert.ok(/\.msg-user \{[^}]*align-items:\s*flex-end/.test(cssSrc), '用户气泡未右对齐');
  const acts = cssSrc.slice(cssSrc.indexOf('.msg-actions {'), cssSrc.indexOf('.msg-act {'));
  assert.ok(!/opacity:\s*0/.test(acts), '图标组默认隐藏 → 又回到「悬停才看得见」（用户已两次反馈）');
  assert.ok(!/pointer-events:\s*none/.test(acts), '图标常显却点不到');
  assert.ok(/\.msg:hover \.msg-act/.test(cssSrc), '悬停未提亮图标');
  assert.ok(!/\.msg:hover \.msg-actions[^{]*\{[^}]*display:\s*none/.test(cssSrc), '悬停改变了布局，用量会左右跳');
  // 信息行收在消息内部，消息之间只需 6~16px 呼吸区（按钮盒自带 8px 内留白，2026-11-11 收到 8px）
  assert.ok(/\.msg-assistant \{[^}]*margin: (6|7|8|9|1[0-6])px 0 0/.test(cssSrc), '助手消息底部间距与 dsh 不符');
  assert.ok(/\.msg-user \{[^}]*margin: \d+px 0 0/.test(cssSrc), '用户消息底部间距与 dsh 不符');
  // 用量不再用胶囊描边（dsh 是图标 + 文字），图标放大到 16px 与 dsh 一致
  const u = cssSrc.slice(cssSrc.indexOf('.msg-usage {'), cssSrc.indexOf('.msg-ts {'));
  assert.ok(!/border-radius:\s*999px/.test(u), '用量又变回胶囊样式');
  assert.ok(/width:\s*1[456]px;\s*height:\s*1[456]px/.test(cssSrc.slice(cssSrc.indexOf('.msg-act svg'))),
    '操作图标尺寸偏离 dsh 的 14~16px');
  // 单条用量：实时回合用会话累计差；历史消息 CLI 的 messages.token_count 实测整列 NULL → 按字符估算并标 ≈
  assert.ok(appSrc.includes('tab.usageBase') && appSrc.includes('last.tokens = nowTotal > base'),
    '实时回合未换算单条用量');
  const est = grabFn(appSrc, 'msgTokens');
  assert.ok(/item\.tokens > 0/.test(est), 'msgTokens 未优先用真实 token');
  assert.ok(/est: true/.test(est) && /cjk \/ 1\.3/.test(est), '缺少按字符估算的兜底（中英分开算）');
  assert.ok(!bar.includes('≈'), '估算标记 ≈ 已按用户要求去掉（2026-11-11），不得加回');
  // 用户消息也必须显示用量（用户 2026-11-11 反馈「自己的消息不显示 token」）
  const userLine = appSrc.slice(appSrc.indexOf("el.className = 'msg msg-user'"), appSrc.indexOf("} else if (item.kind === 'assistant')"));
  assert.ok(/msgActionBar\(item, true\)/.test(userLine), '用户消息没有挂底部信息行 → 不显示 token');
});

section('4. 打包配置（静态核对，无需联网 / 原生编译）');
const buildCfg = read('electron-builder.yml');
const pkg = JSON.parse(read('package.json'));
t('package.json 的入口存在且脚本完整', () => {
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), 'main 入口不存在：' + pkg.main);
  for (const s of ['start', 'test', 'test:services', 'test:contracts', 'dist:mac', 'dist:win', 'dist:linux']) {
    assert.ok(pkg.scripts[s], '缺少脚本 ' + s);
  }
});
t('构建白名单覆盖全部运行时目录，且不含构建产物', () => {
  for (const f of ['main/**/*', 'preload/**/*', 'renderer/**/*', 'package.json']) {
    assert.ok(buildCfg.includes(f), 'files 缺少 ' + f);
  }
  assert.ok(!/^\s*-\s*release\//m.test(buildCfg), 'release/ 不应进入构建白名单');
});
t('asar / npmRebuild / node-pty asarUnpack 未被改坏', () => {
  assert.ok(/asar:\s*true/.test(buildCfg));
  assert.ok(/npmRebuild:\s*true/.test(buildCfg));
  assert.ok(/asarUnpack:[\s\S]*node-pty/.test(buildCfg));
});
t('运行时依赖与可选原生依赖齐备', () => {
  assert.ok(pkg.dependencies && pkg.dependencies.ws, 'WS 客户端依赖 ws 缺失');
  assert.ok(pkg.optionalDependencies && pkg.optionalDependencies['node-pty'], 'node-pty 应为可选依赖');
  assert.ok(fs.existsSync(path.join(ROOT, 'main/services/logger.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'main/services/hermes-bin.js')));
});
t('README 与当前架构保持同步', () => {
  const md = read('README.md');
  assert.ok(md.includes('hermes serve'), 'README 未描述 serve 主通道');
  assert.ok(md.includes('npm test'), 'README 未写测试入口');
  assert.ok(!/stream-json 命令执行通道（主通道/.test(md), 'README 仍在宣称 stream-json 是主通道');
});

section('3ag. 看板重设计：9 个 CLI 状态归 5 组，统计与筛选合一');
const kbGroupBlock = kbAppSrc.slice(kbAppSrc.indexOf('const KB_GROUPS'), kbAppSrc.indexOf('const KB_STATUS_LABEL'));
t('归组映射：待办 / 就绪 / 进行中 / 受阻 / 已完成，archived 单独成列', () => {
  assert.ok(kbGroupBlock.includes("statuses: ['triage', 'todo', 'scheduled']"), '待办组必须收 triage / todo / scheduled');
  assert.ok(kbGroupBlock.includes("statuses: ['ready']"), 'ready 必须单独成列（唯一可被派发的状态）');
  assert.ok(kbGroupBlock.includes("statuses: ['running', 'review']"), '进行中必须收 running / review');
  assert.ok(kbGroupBlock.includes("statuses: ['blocked']"), '受阻只收 blocked');
  assert.ok(kbGroupBlock.includes("statuses: ['done']"), '已完成只收 done');
  // scheduled 归待办而不是受阻：受阻是等人，scheduled 是等时间，混在一起会虚高「受阻」
  const blockedDef = kbGroupBlock.slice(kbGroupBlock.indexOf("label: '受阻'"), kbGroupBlock.indexOf("label: '已完成'"));
  assert.ok(!blockedDef.includes('scheduled'), 'scheduled 不得塞进受阻列');
  assert.ok(kbAppSrc.includes("const KB_GROUP_ARCHIVED = Object.freeze("), 'archived 必须独立定义');
  assert.ok(kbAppSrc.includes('KB.filters.archived ? [...KB_GROUPS, KB_GROUP_ARCHIVED] : [...KB_GROUPS]'),
    '归档列只应由「显示已归档」开关追加');
});

t('分组 chip 的计数恒为全局条数，不随筛选变小', () => {
  // 计数用 all（过滤前）：筛完还能看见「别处还有多少」，否则失去全局感
  assert.ok(kbAppSrc.includes('<span class="kb-sc-num">${g.all.length}</span>'), 'chip 计数未用全局条数');
  assert.ok(!kbAppSrc.includes('<span class="kb-sc-num">${g.tasks.length}</span>'), 'chip 计数错用了过滤后条数');
  assert.ok(kbAppSrc.includes("return { key: g.key, label: g.label, hint: g.hint, dot: g.dot, all, tasks: all.filter(kbMatch) };"),
    '分组必须同时保留 all 与 tasks 两份条数');
});

t('列尾「＋ 添加任务」只在待办 / 就绪出现（后端只认 triage / ready）', () => {
  assert.ok(kbAppSrc.includes("const canAdd = g.key === 'todo' || g.key === 'ready';"),
    '不应在其余列给新建入口：后端 CREATE_STATUSES 只有 triage / ready');
  assert.ok(kbAppSrc.includes("const addStatus = g.key === 'ready' ? 'ready' : 'triage';"), '预填状态映射不对');
  assert.ok(kbAppSrc.includes("presetStatus === 'ready' || presetStatus === 'triage'"), '弹窗必须过滤非法起始状态');
});

t('Demo 模式能打开看板：门禁按 kanbanBoard 是否存在判断，不再要求 hasNative', () => {
  assert.ok(kbAppSrc.includes("const kbApi = () => (api && typeof api.kanbanBoard === 'function' ? api : null);"),
    'kbApi 又回到 hasNative 门禁，浏览器预览会打不开看板');
  const mock = read('renderer/mock-bridge.js');
  for (const m of ['kanbanBoard(', 'kanbanOverview(', 'kanbanTask(', 'kanbanCreateTask(', 'kanbanReassign(', 'kanbanDispatch(']) {
    assert.ok(mock.includes(m), 'mock-bridge 缺少看板方法 ' + m);
  }
});

t('低频入口全部收进「⋯」：页面上不再有统计卡 / 视图按钮 / 新建看板按钮', () => {
  for (const id of ['kb-stats', 'kb-view-grid', 'kb-view-cols', 'kb-new-board', 'kb-dispatch-toggle']) {
    assert.ok(!htmlSrc.includes('id="' + id + '"'), '页面仍保留常驻元素 ' + id);
  }
  for (const k of ['board', 'dispatch', 'view']) {
    assert.ok(htmlSrc.includes('data-kb-more="' + k + '"'), '菜单缺少入口 ' + k);
  }
  assert.ok(htmlSrc.includes('id="kb-archived"') && htmlSrc.includes('kb-more-menu'), '归档开关必须收进菜单');
  assert.ok(appSrc.includes('if (kbMoreMenu && !kbMoreMenu.hidden) { kbMoreToggle(false); return; }'),
    'Esc 未优先收起「⋯」菜单');
});

t('抽屉改派只写 assignee，不越权推进状态', () => {
  assert.ok(kbAppSrc.includes('function kbReassignTask('), '缺少抽屉改派实现');
  assert.ok(kbAppSrc.includes('a.kanbanReassign(taskId, { assignee: name, board: KB.filters.board || \'\' })'),
    '改派未走 kanbanReassign');
  const fn = kbAppSrc.slice(kbAppSrc.indexOf('function kbReassignTask('), kbAppSrc.indexOf('function kbJumpToSession('));
  assert.ok(!/status:/.test(fn), '抽屉改派不得顺带改状态（推进 ready 走「提交派发」）');
  assert.ok(kbAppSrc.includes('id="kbd-assignee"'), '抽屉缺少改派下拉');
  // 抽屉里的状态 chip 必须和卡片一样显示中文归组名，不能一处「收集箱」一处 triage
  assert.ok(kbAppSrc.includes('esc(KB_STATUS_LABEL[t.status] || t.status)'), '抽屉状态 chip 未走中文标签');
  assert.ok(!kbAppSrc.includes('meta.push(`<span class="kb-chip">${esc(t.status)}</span>`)'),
    '抽屉状态 chip 又退回原始 CLI 值');
  // 事件 payload 是对象，String() 会把它拍成 "[object Object]"，日志整段失去信息
  assert.ok(kbAppSrc.includes("const text = typeof value === 'string' ? value : JSON.stringify(value);"),
    'kbdRow 未对对象 payload 做 JSON 序列化');
});

t('5 列自适应：列宽恒等分，空列不许抢宽度', () => {
  assert.ok(/\.kb-col \{[^}]*flex: 1 1 0/.test(kbCss), '列必须是可伸缩的（flex 1 1 0）');
  assert.ok(/\.kb-col \{[^}]*min-width: 160px/.test(kbCss), '列最小宽应为 160px，否则五列在默认窗口就要横向滚动');
  assert.ok(!/\.kb-col \{[^}]*min-width: 210px/.test(kbCss), '旧的 210px 固定最小宽会让五列必然横向滚动');
  assert.ok(/\.kb-col-body \{[^}]*overflow-y: auto/.test(kbCss), '列内必须能纵向滚动');
  // 空列曾写成 flex: 0 0 132px，结果「只有已完成有卡」时那一列吃掉其余四列的宽度
  const emptyRule = (kbCss.match(/\.kb-col\.is-empty \{[^}]*\}/) || [''])[0];
  assert.ok(!/flex:|min-width:|width:/.test(emptyRule), '空列不得单独指定宽度，五列必须等分');
});

t('没有冗余横幅：无任务状态交给列表达，错误才出条', () => {
  assert.ok(!htmlSrc.includes('id="kb-summary"'), '首屏不该再挂一条摘要横幅');
  assert.ok(!kbAppSrc.includes('当前没有进行中的任务'), '摘要横幅的文案仍在，说明那段逻辑没删干净');
  assert.ok(kbAppSrc.includes("if (msg) { msg.hidden = !KB.error; if (KB.error) msg.textContent = KB.error; }"),
    '错误条必须保留');
});

t('收集箱不能承诺「不会被派发」：gateway 默认会自动分解 triage', () => {
  // kanban.auto_decompose 默认 true：gateway 每个 tick 把 triage 卡交给分解器，
  // 补 spec + 填受让人 + 推到 todo→ready，随后照样 spawn。旧的「不派发」文案是假承诺。
  const uiText = htmlSrc + kbAppSrc;
  for (const lie of ['不会被自动派发', '收集箱 triage（不派发）', '不派发</span>']) {
    assert.ok(!uiText.includes(lie), '仍在承诺 triage 不会被派发：' + lie);
  }
  assert.ok(kbAppSrc.includes('kanban.auto_decompose'), '新建弹窗底注必须点明自动分解这个真实机制');
  assert.ok(kbAppSrc.includes('等自动分解'), '列尾入口文案要说明收集箱是「等自动分解」，不是「不派发」');
});

t('看板渲染链调用的每个函数都真的有定义', () => {
  // 血泪教训：renderKanban() 调了一个已被改名删除的函数，ReferenceError 把整条
  // 渲染链打断在第一步 —— 页面打开是空的，但 catch 里只留一句 unhandled rejection，
  // 连 KB.error 都是干净的。node --check 只查语法，查不出这种「调用了不存在的名字」。
  const called = new Set();
  for (const m of kbAppSrc.matchAll(/(?<![\w$.])((?:kb|Kb|renderKanban)[A-Za-z0-9_]*)\s*\(/g)) called.add(m[1]);
  assert.ok(called.size > 20, '函数调用扫描失败（正则失效会静默通过）');
  const missing = [...called].filter((name) => !new RegExp(
    '(?:function\\s+' + name + '\\s*\\(|(?:const|let|var)\\s+' + name + '\\s*=|class\\s+' + name + '\\b)').test(appSrc));
  assert.deepStrictEqual(missing, [], '看板段调用了未定义的函数：' + missing.join(', '));
  assert.ok(kbAppSrc.includes('function renderKanbanHead('), '页头渲染函数缺失');
  assert.ok(kbAppSrc.includes('function renderKanbanBody(') && kbAppSrc.includes('function renderKanbanStatusbar('),
    '主体 / 筛选条渲染函数缺失');
});

t('页头只留看板名与一行概览，分隔符随概览收起', () => {
  assert.ok(htmlSrc.includes('id="kb-board-name"') && htmlSrc.includes('id="kb-head-stat"'), '页头缺少看板名 / 概览节点');
  const fn = kbAppSrc.slice(kbAppSrc.indexOf('function renderKanbanHead('), kbAppSrc.indexOf('function kbAge('));
  assert.ok(fn.includes("sep.hidden = !text"), '概览为空时未收起「·」，页头会挂一个孤零零的分隔符');
  assert.ok(!fn.includes('innerHTML'), '页头只写文本，不用 innerHTML');
});

console.log('\n' + '─'.repeat(56));
console.log(`契约与静态检查：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;
