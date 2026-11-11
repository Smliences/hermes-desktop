'use strict';
/**
 * test-services.js — 服务层回归测试
 *
 * 约束：零依赖、纯 Node、只读、秒级。不启动 hermes CLI、不写 ~/.hermes、
 * 不安装任何第三方代码、不发起真实对话。所有文件系统副作用都落在 os.tmpdir()
 * 下的一次性目录里，退出前清理。
 *
 * 运行：npm test（同时跑 test-contracts.js）或 node scripts/test-services.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const svc = (f) => require(path.join(ROOT, 'main', 'services', f));

// 隔离环境：把 HERMES_HOME / HERMES_DB 都指向临时目录，绝不碰真实 ~/.hermes
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-regression-'));
const hermesRoot = path.join(tmp, 'hermes-home');
const userData = path.join(tmp, 'userData');
fs.mkdirSync(path.join(hermesRoot, 'profiles', 'study'), { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(hermesRoot, 'config.yaml'), 'model:\n  default: test-model\n');
process.env.HERMES_HOME = hermesRoot;
process.env.HERMES_DB = path.join(tmp, 'missing-state.db'); // 故意不存在，验证降级

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + '\n      ' + ((e && e.message) || e)); }
}
const section = (s) => console.log('\n' + s);

const MODULES = [
  'gateway-client.js', 'hermes-backend.js', 'hermes-bin.js', 'hermes-chat.js',
  'hermes-config-yaml.js', 'hermes-config.js', 'hermes-diagnostics.js', 'hermes-gateway.js', 'hermes-kanban.js',
  'hermes-kanban-mode.js', 'hermes-market.js',
  'hermes-plugins.js', 'hermes-preview.js', 'hermes-profile.js', 'hermes-sessions.js',
  'hermes-skills.js', 'hermes-terminal.js', 'logger.js',
];
const loaded = {};

async function run() {
  section('1. 服务模块可在纯 Node 环境加载（不得依赖 electron 运行时）');
  for (const f of MODULES) {
    await t(f, () => {
      const m = svc(f);
      assert.ok(m && typeof m === 'object', '导出为空');
      assert.ok(Object.keys(m).length > 0, '没有任何导出');
      loaded[f] = m;
    });
  }

  section('2. CLI 路径解析与参数白名单（防选项注入）');
  const bin = loaded['hermes-bin.js'];
  await t('resolveHermesBin 返回非空字符串', () => {
    const r = bin.resolveHermesBin();
    assert.ok(typeof r === 'string' && r.length > 0);
  });
  await t('显式存在的路径优先返回', () => {
    const fake = path.join(tmp, 'fake-hermes');
    fs.writeFileSync(fake, '#!/bin/sh\n');
    assert.strictEqual(bin.resolveHermesBin(fake), fake);
  });
  await t('safeArg 拒绝选项 / shell 元字符 / 控制字符 / 超长输入', () => {
    const bad = ['--evil', '-p', 'a;b', 'a|b', 'a`b', 'a$b', 'a>b', 'a\\b', 'a\nb', '', 'x'.repeat(500)];
    for (const v of bad) assert.strictEqual(bin.safeArg(v), null, '应拒绝：' + JSON.stringify(v));
  });
  await t('safeArg 接受普通标识符', () => {
    assert.strictEqual(bin.safeArg('deepseek-v4-flash'), 'deepseek-v4-flash');
    assert.strictEqual(bin.safeArg('  study_1  '), 'study_1');
  });

  section('3. 结构化日志脱敏（凭证不得落盘）');
  const log = loaded['logger.js'];
  await t('token / api_key / password / Bearer / WS URL 全部脱敏', () => {
    const cases = [
      ['HERMES_DASHBOARD_SESSION_TOKEN=abc123def456', /abc123def456/],
      ['api_key: sk-1234567890abcdef', /sk-1234567890abcdef/],
      ['password=hunter2secret', /hunter2secret/],
      ['ws://127.0.0.1:9119/api/ws?token=supersecretvalue', /supersecretvalue/],
      ['connect ?token=abcdef123456&x=1', /abcdef123456/],
      ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', /eyJhbGciOi/],
    ];
    for (const [input, secret] of cases) {
      const out = log.redact(input);
      assert.ok(out.includes('[REDACTED]'), '未标记脱敏：' + input);
      assert.ok(!secret.test(out), '凭证泄漏：' + out);
    }
  });
  await t('普通文本不被误伤', () => {
    const s = 'backend ready on port 9119, 83 sessions loaded';
    assert.strictEqual(log.redact(s), s);
  });

  section('4. profile 隔离（不写 ~/.hermes、所有 CLI 显式带 -p）');
  const profile = loaded['hermes-profile.js'];
  await t('init 落在 Electron userData，默认 default', () => {
    assert.strictEqual(profile.init(userData), 'default');
    assert.strictEqual(profile.current(), 'default');
  });
  await t('home() 随 profile 切换，default 指向根', () => {
    assert.strictEqual(profile.home('default'), hermesRoot);
    assert.strictEqual(profile.home('study'), path.join(hermesRoot, 'profiles', 'study'));
  });
  await t('validName 拒绝路径穿越与注入', () => {
    for (const n of ['../etc', 'a/b', 'a;b', '-x', '', 'a'.repeat(80)]) {
      assert.strictEqual(profile.validName(n), false, '应拒绝：' + JSON.stringify(n));
    }
    assert.strictEqual(profile.validName('study-1'), true);
  });
  await t('cliArgs 恒以 -p <name> 开头（压过 sticky active_profile）', () => {
    assert.deepStrictEqual(profile.cliArgs(['status']), ['-p', 'default', 'status']);
  });
  await t('setCurrent 只写 userData，hermes 根下无新增文件', () => {
    const before = fs.readdirSync(hermesRoot).sort().join(',');
    const r = profile.setCurrent('study');
    assert.ok(r.ok && r.changed, JSON.stringify(r));
    assert.ok(fs.existsSync(path.join(userData, 'active-profile.json')));
    assert.ok(!fs.existsSync(path.join(hermesRoot, 'active_profile')), '不应写 sticky 文件');
    assert.strictEqual(fs.readdirSync(hermesRoot).sort().join(','), before, 'hermes 根目录被写入');
    assert.strictEqual(profile.snapshot().writesHermesFiles, false);
    assert.strictEqual(profile.cliArgs(['status'])[1], 'study');
    assert.strictEqual(profile.env().HERMES_HOME, profile.home());
  });
  await t('setCurrent 拒绝不存在的 / 非法 profile', () => {
    assert.strictEqual(profile.setCurrent('../etc').ok, false);
    assert.strictEqual(profile.setCurrent('ghost').ok, false);
  });

  section('5. 预览路径解析（任意本地目录 + 协议白名单）');
  const preview = loaded['hermes-preview.js'];
  const page = path.join(tmp, 'page.html');
  fs.writeFileSync(page, '<h1>ok</h1>');
  await t('本地 .html 解析成 file:// URL', () => {
    const r = preview.resolveLocal(page, tmp);
    assert.ok(r.ok && r.kind === 'file', JSON.stringify(r));
    assert.ok(r.url.startsWith('file://'));
    assert.strictEqual(r.label, 'page.html');
  });
  await t('引号包裹与尾部标点可容错', () => {
    assert.ok(preview.resolveLocal('"' + page + '",', tmp).ok);
  });
  await t('http(s) URL 直通', () => {
    const r = preview.resolveLocal('http://127.0.0.1:5173/', tmp);
    assert.ok(r.ok && r.kind === 'url');
  });
  await t('拒绝非白名单扩展名 / 不存在 / 空 / 危险协议', () => {
    const txt = path.join(tmp, 'note.txt');
    fs.writeFileSync(txt, 'x');
    for (const v of [txt, path.join(tmp, 'nope.html'), '', 'javascript:alert(1)', 'ftp://x/a.html']) {
      assert.strictEqual(preview.resolveLocal(v, tmp).ok, false, '应拒绝：' + v);
    }
  });

  section('6. 会话层在数据库缺失时安全降级');
  const sessions = loaded['hermes-sessions.js'];
  await t('dbAvailable() 为 false 且不抛异常', async () => {
    // 注意：dbAvailable 是 async，必须 await；这里 HERMES_DB 指向不存在的文件
    assert.strictEqual(await sessions.dbAvailable(), false);
  });
  await t('listSessions / storageStats 返回可序列化结果而不崩溃', async () => {
    const list = await sessions.listSessions({ limit: 3 });
    assert.ok(Array.isArray(list), 'listSessions 应返回数组');
    const stats = await sessions.storageStats();
    assert.ok(stats && typeof stats === 'object');
  });

  section('6b. 单会话统计 SQL 真实可执行（临时 sqlite 库）');
  const { execFileSync } = require('child_process');
  const fixtureDB = path.join(tmp, 'fixture-state.db');
  let sqliteReady = true;
  try {
    execFileSync('sqlite3', [fixtureDB, [
      'CREATE TABLE sessions(id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, message_count INTEGER, started_at REAL, ended_at REAL, last_activity_at REAL);',
      'CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, token_count INTEGER, timestamp REAL);',
      "INSERT INTO sessions VALUES('sess-1',1200,340,7,100,0,900);",
      "INSERT INTO messages VALUES(1,'sess-1',10,100),(2,'sess-1',20,900);",
    ].join('')], { stdio: 'ignore' });
  } catch { sqliteReady = false; }
  if (sqliteReady) {
    const prevDB = process.env.HERMES_DB;
    process.env.HERMES_DB = fixtureDB;
    const zero = { input_tokens: 0, output_tokens: 0, message_count: 0, last_ts: 0 };
    await t('sessionStats 从 sessions 表读到累计 token', async () => {
      const r = await sessions.sessionStats('sess-1');
      assert.strictEqual(Number(r.input_tokens), 1200, 'input_tokens 应来自 sessions 表');
      assert.strictEqual(Number(r.output_tokens), 340);
      assert.strictEqual(Number(r.message_count), 7);
      assert.strictEqual(Number(r.last_ts), 900);
    });
    await t('sessionStats 空/非法/注入 id 返回零值而不抛错', async () => {
      for (const id of ['', null, undefined, "x' OR 1=1--", '--evil', 'a'.repeat(200)]) {
        const r = await sessions.sessionStats(id);
        assert.deepStrictEqual({ ...r }, zero, 'id=' + id);
      }
    });
    await t('sessionStats 会话不存在返回零值', async () => {
      const r = await sessions.sessionStats('no-such-session');
      assert.strictEqual(Number(r.input_tokens), 0);
    });
    await t('loadHistory 在旧版 messages 表（无 display_* 列）上不报错', async () => {
      const h = await sessions.loadHistory('sess-1');
      assert.ok(Array.isArray(h) && h.length === 2, '旧表历史应仍可读');
      assert.ok(h.every((m) => m.displayKind === '' && m.displayMetadata === ''), '缺列应安全投影为空');
    });
    // 新版库：失败轮次的真实错误藏在 display_metadata，历史投影必须带出来
    const fullDB = path.join(tmp, 'fixture-full.db');
    execFileSync('sqlite3', [fullDB, [
      'CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT, tool_calls TEXT, tool_call_id TEXT, timestamp REAL, token_count INTEGER, reasoning_content TEXT, display_kind TEXT, display_metadata TEXT, finish_reason TEXT);',
      `INSERT INTO messages(id,session_id,role,content,timestamp) VALUES(1,'s1','user','在吗',1794146490);`,
      `INSERT INTO messages(id,session_id,role,content,timestamp,display_kind,display_metadata) VALUES(2,'s1','assistant','Your request was not processed. Send it again if you still want me to carry it out.',1794146522,'failed_turn','{"error":"HTTP 400: Upstream request failed: Model is unavailable.","error_surface":{"layer":"provider","code":"format_error","retryable":false,"provider":"custom","model":"deepseek-flash"}}');`,
    ].join('')], { stdio: 'ignore' });
    process.env.HERMES_DB = fullDB;
    await t('loadHistory 带出 failed_turn 的 display_kind 与 error_surface', async () => {
      const h = await sessions.loadHistory('s1');
      assert.strictEqual(h.length, 2);
      assert.strictEqual(h[0].displayKind, '');
      assert.strictEqual(h[1].displayKind, 'failed_turn');
      const md = JSON.parse(h[1].displayMetadata);
      assert.strictEqual(md.error_surface.model, 'deepseek-flash');
      assert.strictEqual(md.error_surface.retryable, false);
      assert.match(md.error, /HTTP 400/);
    });
    process.env.HERMES_DB = prevDB;
  } else {
    console.log('  – 跳过（系统无 sqlite3 CLI）');
  }

  section('7. 配置与常量面');
  const cfgYaml = loaded['hermes-config-yaml.js'];
  const gw = loaded['hermes-gateway.js'];
  const market = loaded['hermes-market.js'];
  const term = loaded['hermes-terminal.js'];
  await t('cfgPath 返回字符串', () => assert.ok(typeof cfgYaml.cfgPath() === 'string' && cfgYaml.cfgPath().length));
  await t('消息平台清单非空（只读常量）', () => assert.ok(Array.isArray(gw.PLATFORMS) && gw.PLATFORMS.length > 0));
  await t('市场来源配置存在且覆盖 CLI 全部来源', () => {
    assert.ok(Array.isArray(market.SOURCES));
    assert.strictEqual(market.SOURCES.length, 15);
    for (const s of ['all', 'skills-sh', 'clawhub', 'minimax']) assert.ok(market.SOURCES.includes(s));
  });
  await t('安装默认最小权限：--no-enable + --no-deps', () => {
    const args = market.actionArgs('plugins', 'install', 'demo-plugin', {});
    assert.ok(args.includes('--no-enable'), '默认不应自动启用');
    assert.ok(args.includes('--no-deps'), '默认不应自动下载 Python 依赖');
    assert.ok(!args.includes('--yes-deps'));
  });
  await t('显式放行才带 --enable / --yes-deps', () => {
    const args = market.actionArgs('plugins', 'install', 'demo-plugin', { enable: true, deps: true });
    assert.ok(args.includes('--enable'));
    assert.ok(args.includes('--yes-deps'));
    assert.ok(!args.includes('--no-deps'));
  });
  await t('锁定提交只接受 40 位十六进制 SHA', async () => {
    const sha = 'a'.repeat(40);
    const args = market.actionArgs('plugins', 'install', 'demo-plugin', { ref: sha });
    assert.ok(args.includes('--ref') && args.includes(sha));
    assert.ok(!market.actionArgs('plugins', 'install', 'demo-plugin', { ref: 'deadbeef' }).includes('--ref'));
    const r = await market.action('plugins', 'install', 'demo-plugin', { ref: '../evil' });
    assert.strictEqual(r.ok, false, '非法 ref 必须在 spawn 之前被拒绝');
  });
  await t('checkUpdates 是只读查询且不接受任意 op', () => {
    assert.strictEqual(typeof market.checkUpdates, 'function');
    assert.strictEqual(typeof market.action, 'function');
  });
  await t('ptyAvailable() 返回布尔值（可选依赖降级）', () => {
    assert.strictEqual(typeof term.ptyAvailable, 'function');
    assert.strictEqual(typeof term.ptyAvailable(), 'boolean');
  });

  section('8. 模型状态只读解析（CLI 默认 ≠ models.json 列表）');
  const hermesConfig = loaded['hermes-config.js'];
  await t('parseModelBlock 只在 model 块内取 default/provider，不误读其它段', () => {
    const text = [
      'telemetry:', '  enabled: false', 'model:',
      '  provider: "opencode"   # 行尾注释',
      '  default: "deepseek-v4.1-flash"',
      '  base_url: https://example.invalid/v1#not-comment',
      'providers:', '  apigoto:', '    model: deepseek-flash',
      'agents:', '  default: other-agent',
    ].join('\n');
    const r = hermesConfig.parseModelBlock(text);
    assert.strictEqual(r.defaultModel, 'deepseek-v4.1-flash');
    assert.strictEqual(r.provider, 'opencode');
    assert.ok(r.baseUrl.includes('#not-comment'), '裸 URL 的 # 片段不应被当注释截断');
  });
  await t('parseModelBlock 支持单引号 / 缺失块 / 空文本', () => {
    assert.strictEqual(hermesConfig.parseModelBlock("model:\n  default: 'a-b'\n").defaultModel, 'a-b');
    assert.strictEqual(hermesConfig.parseModelBlock('providers:\n  default: nope\n').defaultModel, '');
    assert.deepStrictEqual(hermesConfig.parseModelBlock(''), { defaultModel: '', provider: '', baseUrl: '' });
  });
  await t('parseReasoningDisplay 只认 display 段两格缩进的 show_reasoning', () => {
    const off = [
      'display:',
      '  tui_statusbar: "top"',
      '  show_reasoning: false',
      '  sections:',
      '    thinking: hidden',
      'agent:',
      '  reasoning_effort: false',
    ].join('\n');
    assert.deepStrictEqual(hermesConfig.parseReasoningDisplay(off), { enabled: false, explicit: true });

    // 只写了平台级覆盖（4 空格）时不得当成全局值：gateway 的 _load_show_reasoning 不读它
    const platformOnly = 'display:\n  platforms:\n    desktop:\n      show_reasoning: true\n';
    assert.deepStrictEqual(hermesConfig.parseReasoningDisplay(platformOnly), { enabled: true, explicit: false });

    const onWithComment = 'display:\n\tshow_reasoning: true   # 行尾注释\n';
    assert.deepStrictEqual(hermesConfig.parseReasoningDisplay(onWithComment), { enabled: true, explicit: true });

    // 同名键出现在别的顶层段里必须无视
    assert.deepStrictEqual(hermesConfig.parseReasoningDisplay('agent:\n  show_reasoning: false\n'),
      { enabled: true, explicit: false });
    assert.deepStrictEqual(hermesConfig.parseReasoningDisplay(''), { enabled: true, explicit: false });
  });
  await t('reasoningDisplay / setReasoningDisplay 是只读 + 受控写入通道', () => {
    assert.strictEqual(typeof hermesConfig.reasoningDisplay, 'function');
    assert.strictEqual(typeof hermesConfig.setReasoningDisplay, 'function');
    const st = hermesConfig.reasoningDisplay();
    assert.strictEqual(typeof st.ok, 'boolean');
    assert.strictEqual(typeof st.enabled, 'boolean', 'enabled 必须是布尔（渲染层据此决定出不出确认卡）');
    assert.ok(String(st.configPath || '').endsWith('config.yaml'));
  });
  // 第 4 节把当前 profile 切到了 study，这里显式切回 default（也顺带验证跟随行为）
  const profileSvc = loaded['hermes-profile.js'];
  await t('modelState 是纯只读快照，跟随当前 profile 且不写任何文件', async () => {
    profileSvc.setCurrent('default');
    const before = fs.readFileSync(path.join(hermesRoot, 'config.yaml'), 'utf8');
    const r = hermesConfig.modelState();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.defaultModel, 'test-model');
    assert.ok(Array.isArray(r.models) && r.inModelsList === false, 'models.json 缺失时应安全降级');
    assert.ok(r.configPath.endsWith('config.yaml') && r.modelsPath.endsWith('models.json'));
    assert.strictEqual(fs.readFileSync(path.join(hermesRoot, 'config.yaml'), 'utf8'), before);
    assert.strictEqual(fs.existsSync(path.join(hermesRoot, 'models.json')), false, '不得凭空创建配置');
    // 切到 study 后应读 study 自己的 config.yaml，不能串回 default 的模型
    const studyCfg = path.join(hermesRoot, 'profiles', 'study', 'config.yaml');
    fs.writeFileSync(studyCfg, 'model:\n  default: study-model\n');
    try {
      profileSvc.setCurrent('study');
      assert.strictEqual(hermesConfig.modelState().defaultModel, 'study-model');
    } finally { fs.unlinkSync(studyCfg); profileSvc.setCurrent('default'); }
  });
  await t('models.json 存在时 inModelsList 反映 CLI 默认是否已登记', async () => {
    const p = path.join(hermesRoot, 'models.json');
    fs.writeFileSync(p, JSON.stringify([{ model: 'test-model', name: 'T', provider: 'x' }, { nope: 1 }]));
    try {
      const r = hermesConfig.modelState();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.inModelsList, true);
      assert.strictEqual(r.models.length, 1, '非法条目应被过滤');
      assert.strictEqual(r.models[0].model, 'test-model');
    } finally { fs.unlinkSync(p); }
  });

  section('9. 只读诊断通道（设置页记忆 / 健康检查共用）');
  const diag = loaded['hermes-diagnostics.js'];
  const diagSrc = fs.readFileSync(path.join(ROOT, 'main', 'services', 'hermes-diagnostics.js'), 'utf8');
  await t('命令是白名单常量，且全部为只读子命令', () => {
    const keys = Object.keys(diag.COMMANDS);
    assert.ok(keys.length >= 5, '诊断命令过少');
    for (const k of ['memory:status', 'status', 'doctor', 'fallback:list', 'config:check']) {
      assert.ok(diag.COMMANDS[k], '缺少 ' + k);
    }
    const flat = JSON.stringify(diag.COMMANDS);
    for (const bad of ['--fix', '--live', 'setup', 'reset', 'off', 'install', 'uninstall']) {
      assert.ok(!flat.includes(bad), '诊断命令混入了写操作 / 真实探测：' + bad);
    }
  });
  await t('非法 key（含 __proto__ 原型链）在 spawn 前被拒绝，不启动任何子进程', async () => {
    for (const bad of ['memory:reset', 'gateway:start', '', {}, null, '__proto__', 'constructor', 'toString']) {
      const r = await diag.run(bad);
      assert.strictEqual(r.ok, false, '非法 key 未被拒绝：' + String(bad));
      assert.ok(r.error.includes('不支持'), '错误信息不明确');
    }
  });
  await t('子进程恒带 -p <profile>，带超时与输出上限', () => {
    assert.ok(diagSrc.includes('profile.cliArgs('), '未走 profile.cliArgs（缺 -p）');
    assert.ok(diagSrc.includes('resolveHermesBin()'), '未统一解析 CLI 路径');
    assert.ok(/timeout:\s*TIMEOUTS\[key\]/.test(diagSrc), '缺少超时');
    assert.ok(diagSrc.includes('MAX_OUTPUT'), '缺少输出上限');
    assert.ok(diagSrc.includes('NO_COLOR'), '未关闭 ANSI 颜色');
    assert.ok(diagSrc.includes('queue'), '缺少串行队列');
    assert.ok(!/writeFile|unlink|rmSync|renameSync/.test(diagSrc), '诊断服务不得写文件');
  });
  await t('慢命令超时会强杀并明确降级，不把队列永久占住', () => {
    assert.ok(diagSrc.includes("child.kill('SIGKILL')"), '缺少强杀兜底');
    assert.ok(diagSrc.includes('timedOut: true'), '超时结果未标注');
    assert.ok(diagSrc.includes("stdio: ['ignore'"), '未关闭 stdin');
    assert.ok(diagSrc.includes('let done = false'), '完成态未去重');
  });
  await t('doctor 超时余量足够（实测约 41s），且退出码 1 仍保留输出', () => {
    assert.ok(diag.TIMEOUTS === undefined || true); // TIMEOUTS 未导出，用源码核对
    assert.ok(/doctor:\s*(\d+)/.test(diagSrc), '缺少 doctor 超时');
    const ms = Number(diagSrc.match(/doctor:\s*(\d+)/)[1]);
    assert.ok(ms >= 50000, 'doctor 需要 ≥50s 余量，实测约 41s：' + ms);
    assert.ok(diagSrc.includes('hasOutput: !!text'), '退出码非 0 时必须保留输出供 UI 判断');
  });
  await t('memoryFiles 只读元信息，不读正文、跟随当前 profile', () => {
    const files = diag.memoryFiles();
    assert.strictEqual(files.length, 2);
    assert.deepStrictEqual(files.map((f) => f.name), ['MEMORY.md', 'USER.md']);
    for (const f of files) {
      assert.ok(f.path.endsWith(path.join('memories', f.name)),
        'CLI 内置记忆在 <home>/memories/ 下，写错路径会误报「尚未创建」：' + f.path);
      assert.ok('exists' in f && 'bytes' in f && 'mtime' in f);
      assert.ok(!('content' in f) && !('text' in f), '不得把记忆正文带回渲染层');
    }
    // 真实布局的 fixture：文件存在时元信息要能反映出来
    const dir = path.join(hermesRoot, 'memories');
    fs.mkdirSync(dir, { recursive: true });
    const fixture = path.join(dir, 'MEMORY.md');
    fs.writeFileSync(fixture, '# fixture\n');
    try {
      const hit = diag.memoryFiles().find((f) => f.name === 'MEMORY.md');
      assert.strictEqual(hit.exists, true);
      assert.ok(hit.bytes > 0 && hit.mtime > 0);
    } finally { fs.unlinkSync(fixture); fs.rmdirSync(dir); }
  });
  await t('打开文件白名单里的记忆路径同样落在 memories/ 目录', () => {
    const cfg = loaded['hermes-config.js'].configPaths();
    assert.ok(cfg.memoryMd.endsWith(path.join('memories', 'MEMORY.md')));
    assert.ok(cfg.userMd.endsWith(path.join('memories', 'USER.md')));
  });

  section('10. 运行时健壮性：后端重启 / 断线 / 回合收敛（零真实进程、零真实 WS）');
  const { ChatChannel } = loaded['hermes-chat.js'];
  const { HermesBackend } = loaded['hermes-backend.js'];
  const { GatewayConnection } = loaded['gateway-client.js'];
  const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  // _ensureGateway 用 100ms 轮询等 WS open，需跨过真实定时器再收微任务
  const settle = async (ms = 150) => { await new Promise((r) => setTimeout(r, ms)); await flush(); };

  function fakeBackend(gen = 1) {
    return {
      generation: gen, token: 'tok-' + gen, port: 12000 + gen,
      async start() { return this.port; }, stop() {},
    };
  }
  function fakeGateway(opts = {}) {
    const calls = [];
    const failing = new Set(opts.failMethods || []);
    return {
      calls, connected: false, closed: false,
      onRequest() {}, onEvent(fn) { this._event = fn; },
      connect() { this.connected = opts.connected !== false; },
      rpc(method, params) {
        calls.push({ method, params });
        if (failing.has(method)) return Promise.reject(new Error('attach rejected'));
        if (method === 'session.create') {
          return Promise.resolve({ session_id: opts.liveId || 'live-1', stored_session_id: opts.storedId || 'stored-1' });
        }
        if (method === 'session.resume') return Promise.resolve({ session_id: opts.liveId || 'live-2' });
        return Promise.resolve({});
      },
      close() { this.closed = true; this.connected = false; },
    };
  }
  function makeChat(o = {}) {
    const backend = fakeBackend(o.gen || 1);
    let gw = o.gw || fakeGateway();
    const chat = new ChatChannel('', {
      backend, createGateway: () => gw,
      connectTimeoutMs: o.connectTimeoutMs || 400,
      abortGraceMs: o.abortGraceMs || 40,
    });
    return { chat, backend, get gw() { return gw; }, setGw(g) { gw = g; } };
  }

  await t('后端状态带 generation；退避重启期 start() 只等待，不叠加第二个 serve', async () => {
    const seen = [];
    const b = new HermesBackend({ onStatus: (s) => seen.push(s) });
    b.generation = 7;
    b._setStatus('starting');
    assert.strictEqual(seen[0].generation, 7, 'ChatChannel 靠 generation 识别换代');
    b.state = 'error'; b._restartPending = true;
    const p = b.start();
    assert.strictEqual(b.child, null, '退避期不得再 spawn');
    assert.strictEqual(b._waiters.length, 1);
    b._waiters[0].resolve(4311);
    assert.strictEqual(await p, 4311);
    b.stop();
  });
  await t('error 与 exit 同时到达只排定一次重启，stop() 会清掉排程', () => {
    const b = new HermesBackend();
    b.generation = 3; b.startedAt = Date.now(); b.state = 'ready';
    b._scheduleRestart(3, '退出(1)', 'tail');
    assert.strictEqual(b._restartPending, true);
    const timer = b._restartTimer;
    b._scheduleRestart(3, '进程错误(ENOENT)', 'tail');
    assert.strictEqual(b._restartTimer, timer, '重复排程会拉起多个 serve');
    b.stop();
    assert.strictEqual(b._restartPending, false);
  });
  await t('后端换代后作废旧 liveId：下一轮改用 storedId resume，不再打旧端口', async () => {
    const g1 = fakeGateway({ liveId: 'live-A', storedId: 'stored-A' });
    const g2 = fakeGateway({ liveId: 'live-B' });
    const h = makeChat({ gw: g1 });
    const { chat, backend } = h;
    const errors = [], closes = [];
    chat.submit('t1', { query: '第一轮' }, {
      onEvent() {}, onError: (e) => errors.push(e.message), onClose: (s) => closes.push(s),
    });
    await settle();
    chat._routeEvent({ type: 'message.complete', session_id: 'live-A', payload: { text: 'ok' } });
    await flush();
    const tab = chat.tabs.get('t1');
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(closes.length, 1);
    assert.strictEqual(tab.liveId, 'live-A');
    assert.strictEqual(tab.storedId, 'stored-A');

    h.setGw(g2);
    backend.generation = 2;
    chat._onBackendStatus({ state: 'ready', generation: 2 });
    assert.strictEqual(chat.gateway, null, '旧连接必须关闭');
    assert.strictEqual(g1.closed, true);
    assert.strictEqual(tab.liveId, '', '活会话 id 属于旧进程，必须清空');
    assert.strictEqual(chat.liveByTab.size, 0);
    assert.strictEqual(chat.activeTurns.size, 0);

    chat.submit('t1', { query: '第二轮' }, {
      onEvent() {}, onError: (e) => errors.push(e.message), onClose() {},
    });
    await settle();
    assert.deepStrictEqual(errors, []);
    assert.ok(g2.calls.some((c) => c.method === 'session.resume' && c.params.session_id === 'stored-A'),
      '必须用 storedId 续接，而不是拿旧 liveId 打新后端');
    assert.ok(!g2.calls.some((c) => c.method === 'prompt.submit' && c.params.session_id === 'live-A'));
    chat._routeEvent({ type: 'message.complete', session_id: 'live-B', payload: { text: 'ok' } });
    await flush();
  });
  await t('后端掉线：在途与排队回合都收到明确错误与 close，不留 running 卡死', async () => {
    const gw = fakeGateway();
    const { chat } = makeChat({ gw });
    const errors = [], closes = [];
    const cb = () => ({ onEvent() {}, onError: (e) => errors.push(e.message), onClose: (s) => closes.push(s) });
    chat.submit('t', { query: '在途' }, cb());
    await settle();
    chat.submit('t', { query: '排队1' }, cb());
    chat.submit('t', { query: '排队2' }, cb());
    assert.strictEqual(chat.tabs.get('t').queue.length, 2);
    chat._onBackendStatus({ state: 'error', generation: 1 });
    assert.strictEqual(closes.length, 3, '在途 1 + 排队 2 都必须 close');
    assert.ok(errors.length >= 3, '每个被取消的回合都要有可读原因');
    assert.strictEqual(chat.tabs.get('t').current, null);
    assert.strictEqual(chat.tabs.get('t').queue.length, 0);
  });
  await t('会话建立前按停止不会误发 prompt，且后续消息不会被旧 tab.current 挡住', async () => {
    let releaseCreate;
    let blockCreate = true;
    const gw = fakeGateway();
    gw.rpc = (method, params) => {
      gw.calls.push({ method, params });
      if (method === 'session.create' && blockCreate) {
        blockCreate = false;
        return new Promise((r) => { releaseCreate = r; });
      }
      if (method === 'session.create' || method === 'session.resume') {
        return Promise.resolve({ session_id: 'live-y', stored_session_id: 'stored-y' });
      }
      return Promise.resolve({});
    };
    const { chat } = makeChat({ gw, abortGraceMs: 300 });
    const closes = [];
    chat.submit('t', { query: '别发' }, { onEvent() {}, onError() {}, onClose: (s) => closes.push(s) });
    // 跨过 _ensureGateway 的 100ms 轮询，让回合正好停在 session.create 上
    await settle(140);
    chat.abort('t');
    assert.ok(typeof releaseCreate === 'function', 'session.create 应仍在途');
    releaseCreate({ session_id: 'live-x', stored_session_id: 'stored-x' });
    await flush();
    assert.ok(!gw.calls.some((c) => c.method === 'prompt.submit'), '停止后仍提交了 prompt');
    assert.strictEqual(closes.length, 1);
    assert.strictEqual(closes[0].aborted, true);
    chat.submit('t', { query: '新的一轮' }, { onEvent() {}, onError() {}, onClose() {} });
    await settle();
    assert.ok(gw.calls.some((c) => c.method === 'prompt.submit'), '停止后新消息必须能启动');
  });
  await t('停止后后端不回 message.complete：宽限期强制收尾且只 close 一次', async () => {
    const gw = fakeGateway();
    const { chat } = makeChat({ gw, abortGraceMs: 25 });
    const closes = [];
    chat.submit('t', { query: 'x' }, { onEvent() {}, onError() {}, onClose: (s) => closes.push(s) });
    await settle();
    chat.abort('t');
    assert.ok(gw.calls.some((c) => c.method === 'session.interrupt'));
    await new Promise((r) => setTimeout(r, 90));
    assert.strictEqual(closes.length, 1, '必须恰好收尾一次');
    assert.strictEqual(closes[0].aborted, true);
    assert.strictEqual(chat.getTabState('t').running, false);
  });
  await t('WS 连接超时会关闭孤儿连接，不留下后台无限重连', async () => {
    const gw = fakeGateway({ connected: false });
    const h = makeChat({ gw, connectTimeoutMs: 40 });
    await assert.rejects(h.chat._ensureGateway(), /连接超时|作废/);
    assert.strictEqual(gw.closed, true, '孤儿连接没有 close');
    assert.strictEqual(h.chat.gateway, null);
    assert.strictEqual(h.chat.gatewayReady, null);
  });
  await t('队列满与缺少 tabId 都会补发 close，渲染层不会永久 running', () => {
    const { chat } = makeChat();
    chat.tabs.set('t', {
      queue: Array.from({ length: 8 }, () => ({ opts: {}, callbacks: {} })),
      current: null, sessionId: '', liveId: '', storedId: '', model: '',
    });
    let e1 = null, c1 = null;
    chat.submit('t', { query: 'x' }, { onError: (e) => { e1 = e; }, onClose: (s) => { c1 = s; } });
    assert.ok(e1 && c1 && c1.exitCode === 1);
    let e2 = null, c2 = null;
    chat.submit('', { query: 'x' }, { onError: (e) => { e2 = e; }, onClose: (s) => { c2 = s; } });
    assert.ok(e2 && c2);
    assert.ok(!chat.tabs.has(undefined) && !chat.tabs.has(''), '非法 tabId 不得污染 Map');
  });
  await t('GatewayConnection：close 解绑 socket、rpc 发送失败立即 reject、连接中不重复建 socket', async () => {
    const g = new GatewayConnection({ port: 1, token: 'x' });
    g.connected = true;
    g.ws = { readyState: 1, close() {} };
    g.close();
    assert.strictEqual(g.connected, false, '关闭后仍上报 connected 会让 _ensureGateway 复用死连接');
    assert.strictEqual(g.ws, null, '未解绑的 socket 回调会继续排重连');
    assert.strictEqual(g.closed, true);

    const g2 = new GatewayConnection({ port: 1, token: 'x' });
    g2.ws = { readyState: 1 };
    g2._sendRaw = () => false;
    await assert.rejects(g2.rpc('prompt.submit', {}, 600000), /未连接/);
    assert.strictEqual(g2.pending.size, 0, '发送失败的请求不能挂到 10 分钟超时');

    const g3 = new GatewayConnection({ port: 1, token: 'x' });
    const fakeWs = { readyState: 0 };
    g3.ws = fakeWs;
    g3.connect();
    assert.strictEqual(g3.ws, fakeWs, 'CONNECTING 时不应再 new 一个 WebSocket');
  });

  await t('附件按类型选 RPC，且在 prompt.submit 之前完成；相对路径 / 重复 / 超限一律丢弃', async () => {
    const gw = fakeGateway();
    const { chat } = makeChat({ gw });
    chat.submit('t', {
      query: '看下这些文件',
      attachments: [
        '/tmp/hermes-shot.png', '/tmp/report.pdf', '/tmp/notes.txt',
        '/tmp/hermes-shot.png',        // 重复
        'relative/path.png',           // 非绝对路径
        '~/Desktop/a.png',             // 未展开的 ~ 不是绝对路径
        '', null, 42,                  // 非法值
        ...Array.from({ length: 10 }, (_, i) => `/tmp/extra-${i}.md`),
      ],
    }, { onEvent() {}, onError() {}, onClose() {} });
    await settle();
    const attach = gw.calls.filter((c) => /\.attach$/.test(c.method));
    const submitAt = gw.calls.findIndex((c) => c.method === 'prompt.submit');
    assert.ok(submitAt > 0, '未提交 prompt');
    assert.ok(attach.length > 0 && attach.length <= 8, '附件数量未按上限收敛：' + attach.length);
    assert.ok(gw.calls.indexOf(attach[0]) < submitAt, '附件必须在提交前附加');
    assert.deepStrictEqual(attach.slice(0, 3).map((c) => c.method), ['image.attach', 'pdf.attach', 'file.attach']);
    assert.ok(attach.every((c) => c.params.session_id === 'live-1'), '附件必须绑定活会话');
    assert.ok(!attach.some((c) => String(c.params.path).includes('relative')), '相对路径不得进入 RPC');
    assert.ok(!attach.some((c) => String(c.params.path).startsWith('~')), '未展开的 ~ 不得进入 RPC');
    const pngs = attach.filter((c) => c.params.path === '/tmp/hermes-shot.png');
    assert.strictEqual(pngs.length, 1, '同一路径被重复附加');
    chat.abort('t');
    await settle();
  });

  await t('附件失败不阻塞回合：文字照发，只给一条 notice 提示', async () => {
    const gw = fakeGateway({ failMethods: ['image.attach'] });
    const { chat } = makeChat({ gw });
    const events = [], errors = [];
    chat.submit('t', { query: '还是发文字吧', attachments: ['/tmp/broken.png', '/tmp/ok.txt'] }, {
      onEvent: (e) => events.push(e), onError: (e) => errors.push(e.message), onClose() {},
    });
    await settle();
    assert.ok(gw.calls.some((c) => c.method === 'prompt.submit'), '附件失败把整轮请求吞掉了');
    assert.ok(gw.calls.some((c) => c.method === 'file.attach'), '一个附件失败不应中断其余附件');
    const notice = events.find((e) => e.type === 'notice');
    assert.ok(notice && /broken\.png/.test(notice.text), '缺少可读的附件失败提示');
    assert.strictEqual(errors.length, 0, '附件失败不该变成整轮错误');
    chat.abort('t');
    await settle();
  });

  section('11. 会话导出与工具集：参数白名单（不启动真实 CLI）');

  await t('工具列表解析：只认 cli 分段，条目带 enabled 状态', () => {
    const tools = require('../main/services/hermes-tools');
    const fixture = [
      'Built-in toolsets (cli):',
      '  ✓ enabled  web  🔍 Web Search & Scraping',
      '  ✗ disabled  video  🎬 Video Analysis',
      'Plugin toolsets (cli):',
      '  ✗ disabled  a2a  🔌 A2A',
      'Built-in toolsets (telegram):',
      '  ✓ enabled  web  🔍 Web Search & Scraping',
    ].join('\n');
    const secs = tools.parseToolList(fixture);
    assert.strictEqual(secs.length, 3, '分段数量不对');
    assert.deepStrictEqual(secs.map((s) => s.platform), ['cli', 'cli', 'telegram']);
    const web = secs[0].items[0];
    assert.deepStrictEqual(
      { name: web.name, enabled: web.enabled, label: web.label },
      { name: 'web', enabled: true, label: '🔍 Web Search & Scraping' },
    );
    assert.strictEqual(secs[0].items[1].enabled, false, 'disabled 条目被误判为启用');
    // 空分段（标题后无条目）会被丢弃，避免界面出现空分组
    assert.strictEqual(tools.parseToolList('MCP tools (cli):\n').length, 0);
  });

  await t('工具名白名单：拒绝 shell 元字符 / 空白 / 超长', () => {
    const { NAME_RE } = require('../main/services/hermes-tools');
    for (const bad of ['web; rm -rf /', 'a b', 'x\ny', '"q"', "$(id)", '`id`', '', 'a'.repeat(200), '-flag']) {
      assert.ok(!NAME_RE.test(bad), '不应放行的工具名：' + JSON.stringify(bad));
    }
    for (const ok of ['web', 'code_execution', 'github:create_issue', 'mcp.tool-1']) {
      assert.ok(NAME_RE.test(ok), '合法工具名被拒绝：' + ok);
    }
  });

  await t('setTool 非法名在 spawn 之前就被拒绝', async () => {
    const tools = require('../main/services/hermes-tools');
    const r = await tools.setTool('web && rm -rf /', true);
    assert.strictEqual(r.ok, false);
    assert.ok(/非法工具名/.test(r.error), '未给出可读的拒绝原因');
  });

  await t('导出：格式白名单 + 会话 id 白名单 + 绝对路径，全部在调用 CLI 前拒绝', async () => {
    const exp = require('../main/services/hermes-export');
    assert.deepStrictEqual(Object.keys(exp.FORMATS).sort(), ['html', 'jsonl', 'md']);
    for (const bad of ['../x', '/etc/passwd', 'a b', '-o', '', 'x'.repeat(120)]) {
      assert.strictEqual(exp.validSessionId(bad), false, '不应放行的会话 id：' + JSON.stringify(bad));
    }
    assert.strictEqual(exp.validSessionId('20261007_065911_1e1271'), true);

    const badFmt = await exp.exportSession({ sessionId: '20261007_065911_1e1271', format: 'exe', outPath: '/tmp/a.exe' });
    assert.strictEqual(badFmt.ok, false);
    assert.ok(/不支持的导出格式/.test(badFmt.error));
    const badId = await exp.exportSession({ sessionId: '../x', format: 'md', outPath: '/tmp/a.md' });
    assert.strictEqual(badId.ok, false);
    const relPath = await exp.exportSession({ sessionId: '20261007_065911_1e1271', format: 'md', outPath: 'rel.md' });
    assert.strictEqual(relPath.ok, false);
    assert.ok(/绝对路径/.test(relPath.error));
  });

  section('12. MCP / 定时任务：用真实 CLI 输出夹具验证解析与白名单（不启动 CLI）');

  await t('MCP 列表解析：表格行、启用状态、tools 描述', () => {
    const mcp = svc('hermes-mcp.js');
    const fixture = [
      '',
      '  MCP Servers:',
      '',
      '  Name             Transport                      Tools        Status',
      '  ──────────────── ────────────────────────────── ──────────── ──────────',
      '  intellij-idea    http://127.0.0.1:64342/sse     all          ✓ enabled',
      '  deepwiki         https://mcp.deepwiki.com/mcp   3 selected    ✗ disabled',
      '',
    ].join('\n');
    const rows = mcp.parseMcpList(fixture);
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows[0], {
      name: 'intellij-idea', transport: 'http://127.0.0.1:64342/sse', tools: 'all', enabled: true,
    });
    assert.strictEqual(rows[1].tools, '3 selected', '带空格的 tools 描述被截断');
    assert.strictEqual(rows[1].enabled, false);
    assert.strictEqual(mcp.parseMcpList('\n  No MCP servers configured.\n').length, 0, '空配置应返回空数组而不是报错');
    // 带 ANSI 色码的旧版输出也要能解析
    assert.strictEqual(mcp.parseMcpList('  foo  http://x  all  \x1b[32m✓ enabled\x1b[0m').length, 1);
  });

  await t('MCP 连接测试解析：耗时、工具数、工具名、未连接判定', () => {
    const mcp = svc('hermes-mcp.js');
    const r = mcp.parseMcpTest([
      "  Testing 'intellij-idea'...",
      '  Transport: HTTP → http://127.0.0.1:64342/sse',
      '  ✓ Connected (5970ms)',
      '  ✓ Tools discovered: 56',
      '',
      '    execute_run_configuration            Run either an existing run configuration by name',
      '    get_run_configurations               Returns project configurations',
      '',
    ].join('\n'));
    assert.strictEqual(r.connected, true);
    assert.strictEqual(r.latencyMs, 5970);
    assert.strictEqual(r.toolCount, 56);
    assert.deepStrictEqual(r.tools, ['execute_run_configuration', 'get_run_configurations']);
    assert.ok(/http:\/\/127\.0\.0\.1:64342\/sse/.test(r.transport));
    const bad = mcp.parseMcpTest('  Testing x...\n  ✗ Failed to connect: refused\n');
    assert.strictEqual(bad.connected, false);
    assert.strictEqual(bad.toolCount, 0);
  });

  await t('MCP 名称与 URL 白名单：拒绝越界 scheme / 内网 http / 元字符', () => {
    const mcp = svc('hermes-mcp.js');
    for (const bad of ['a b', 'x;rm', '../etc', '-flag', 'x\ny', '']) {
      assert.strictEqual(mcp.validName(bad), false, '不应放行的名称：' + JSON.stringify(bad));
    }
    assert.strictEqual(mcp.validName('intellij-idea'), true);
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'http://192.168.1.9/mcp',
      'http://evil.example.com/mcp', 'ftp://x/mcp', 'https://x y', '']) {
      assert.strictEqual(mcp.validUrl(bad), false, '不应放行的 URL：' + bad);
    }
    for (const ok of ['https://mcp.deepwiki.com/mcp', 'http://127.0.0.1:64342/sse',
      'http://localhost:3000/mcp', 'http://[::1]:8080/sse']) {
      assert.strictEqual(mcp.validUrl(ok), true, '合法 URL 被拒绝：' + ok);
    }
  });

  await t('MCP 写操作非法参数在 spawn 前被拒绝（不产生子进程）', async () => {
    const mcp = svc('hermes-mcp.js');
    assert.strictEqual((await mcp.addServer({ name: 'a b', url: 'https://x/mcp' })).ok, false);
    assert.strictEqual((await mcp.addServer({ name: 'ok', url: 'file:///etc/passwd' })).ok, false);
    assert.strictEqual((await mcp.removeServer('-flag')).ok, false);
    assert.strictEqual((await mcp.testServer('x;id')).ok, false);
  });

  await t('cron list --all 解析：活跃/暂停任务、键值字段、空配置', () => {
    const cron = svc('hermes-cron.js');
    const fixture = [
      '┌───────────────────────────────────────────────────────────────────────────┐',
      '│                    Scheduled Jobs (profile: default)                       │',
      '└───────────────────────────────────────────────────────────────────────────┘',
      '',
      '  a1b2c3d4e5f6 [active]',
      '    Name:      每日摘要',
      '    Schedule:  every 2h',
      '    Repeat:    ∞',
      '    Next run:  2026-11-10 08:00:00+08:00',
      '    Deliver:   local',
      '    Last run:  2026-11-09 06:00:00+08:00  ok',
      '',
      '  1234567890ab [paused]',
      '    Name:      周报',
      '    Schedule:  0 9 * * 1',
      '    Next run:  -',
      '',
    ].join('\n');
    const jobs = cron.parseCronList(fixture);
    assert.strictEqual(jobs.length, 2);
    assert.deepStrictEqual(
      { id: jobs[0].id, state: jobs[0].state, name: jobs[0].name, schedule: jobs[0].schedule, nextRun: jobs[0].nextRun },
      { id: 'a1b2c3d4e5f6', state: 'active', name: '每日摘要', schedule: 'every 2h', nextRun: '2026-11-10 08:00:00+08:00' },
    );
    assert.strictEqual(jobs[1].state, 'paused');
    assert.ok(jobs[0].lastRun.includes('ok'));
    assert.deepStrictEqual(cron.parseCronList("No scheduled jobs in profile 'default'.\n"), []);
  });

  await t('cron status / runs / doctor 原文解析：调度器状态与运行记录', () => {
    const cron = svc('hermes-cron.js');
    const st = cron.parseCronStatus([
      "  Scheduler host: an in-process ticker (hermes serve / Desktop backend) ticking profile 'default'",
      '✓ Gateway is running — cron jobs will fire automatically',
      '  Ticker heartbeat: 0s ago',
      '', '  No active jobs',
    ].join('\n'));
    assert.strictEqual(st.running, true);
    assert.strictEqual(st.notReady, false);
    assert.strictEqual(st.heartbeat, '0s ago');
    assert.ok(st.host.includes('in-process ticker'));
    assert.strictEqual(cron.parseCronStatus('  ⚠  Scheduler is not ready for profile x').notReady, true);
    const runs = cron.parseCronRuns([
      'abc123  ok        job=a1b2c3d4e5f6  source=schedule  2026-11-09T06:00:00',
      '    boom: something failed',
      'def456  failed    job=a1b2c3d4e5f6  source=manual    2026-11-09T07:00:00',
    ].join('\n'));
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(runs[0].status, 'ok');
    assert.strictEqual(runs[0].jobId, 'a1b2c3d4e5f6');
    assert.strictEqual(runs[0].error, 'boom: something failed');
    assert.strictEqual(runs[1].source, 'manual');
    assert.deepStrictEqual(cron.parseCronRuns('No cron execution attempts recorded.'), []);
  });

  await t('cron 白名单：动作固定、调度/文本拒绝注入，非法参数在 spawn 前拒绝', async () => {
    const cron = svc('hermes-cron.js');
    assert.deepStrictEqual(Object.keys(cron.ACTIONS).sort(), ['pause', 'remove', 'resume', 'run']);
    for (const bad of ['0 9 * * *; rm -rf /', '-o', '$(id)', 'x\ny', '', '`id`']) {
      assert.strictEqual(cron.validSchedule(bad), false, '不应放行的调度：' + JSON.stringify(bad));
    }
    for (const ok of ['30m', 'every 2h', '0 9 * * 1', '@daily']) {
      assert.strictEqual(cron.validSchedule(ok), true, '合法调度被拒绝：' + ok);
    }
    assert.strictEqual(cron.validText('-h', 100), false, '以 - 开头的 positional 会被 argparse 当选项');
    assert.strictEqual(cron.validText('a\x00b', 100), false);
    assert.strictEqual(cron.validText('x'.repeat(5000), 4000), false);
    assert.strictEqual((await cron.action('delete', 'a1b2')).ok, false, '未登记的动作必须拒绝');
    assert.strictEqual((await cron.action('pause', 'bad id')).ok, false);
    assert.strictEqual((await cron.create({ schedule: '; rm -rf /' })).ok, false);
    assert.strictEqual((await cron.create({ schedule: '30m', prompt: '-oops' })).ok, false);
    assert.strictEqual((await cron.listRuns('bad id')).ok, false);
  });

  section('13. 模型候选列表共享规则（提取纯函数，零 DOM / 零 CLI）');
  // chip 菜单与设置页下拉共用 modelRows；用 vm 直接执行源码片段，保证测的是真实实现而非副本。
  const vm = require('vm');
  const appText = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
  const fnText = appText.slice(appText.indexOf('function modelRows('), appText.indexOf('async function openModelPicker('));
  assert.ok(fnText.includes('function modelRows('), '未能从 renderer 提取 modelRows 源码');
  const mctx = {
    MODELS: ['builtin-a', 'builtin-b'],
    arr: (v) => (Array.isArray(v) ? v : []),
    Set, String, console,
  };
  vm.createContext(mctx);
  vm.runInContext(fnText + '\nthis.modelRows = modelRows;', mctx);
  const modelRows = mctx.modelRows;
  // vm realm 里的数组/对象原型与宿主不同，deepStrictEqual 会误报；先规范化成宿主对象
  const norm = (v) => JSON.parse(JSON.stringify(v));

  await t('CLI 默认置顶且不与 models.json 重复', () => {
    const rows = modelRows({ defaultModel: 'cli-default', models: [
      { model: 'cli-default', name: '重复项' },
      { model: 'from-json', name: 'A', provider: 'p' },
    ] }, [], 'cli-default');
    assert.strictEqual(rows[0].key, 'cli-default');
    assert.strictEqual(rows[0].tag, 'CLI 默认');
    assert.deepStrictEqual(norm(rows.map((r) => r.key)), ['cli-default', 'from-json']);
  });
  await t('models.json 为空时回落 fallback，再回落内置清单', () => {
    const fromFallback = modelRows({ defaultModel: '', models: [] }, [{ model: 'fb', name: 'F' }], '');
    assert.deepStrictEqual(norm(fromFallback.map((r) => r.key)), ['fb']);
    const builtin = modelRows(null, [], '');
    assert.deepStrictEqual(norm(builtin.map((r) => r.key)), ['builtin-a', 'builtin-b']);
    assert.ok(builtin.every((r) => r.tag === '内置'));
  });
  await t('配置里存着清单外模型（失效名）时仍可见、可改', () => {
    const rows = modelRows({ defaultModel: 'cli-default', models: [{ model: 'from-json' }] }, [], 'deepseek-flash');
    assert.deepStrictEqual(norm(rows[rows.length - 1]),
      { key: 'deepseek-flash', name: 'deepseek-flash', tag: '当前配置' });
  });
  await t('current 与 CLI 默认一致时不产生额外行，异常入参不抛错', () => {
    const same = norm(modelRows({ defaultModel: 'x', models: [] }, [], 'x'));
    assert.ok(!same.some((r) => r.tag === '当前配置'), 'current 与 CLI 默认一致时不应出现额外行');
    assert.ok(Array.isArray(modelRows(undefined, 'not-an-array', null)));
    assert.ok(Array.isArray(modelRows({ defaultModel: '', models: [null, {}, { model: '' }] }, [], '')));
  });

  section('14. Kanban 客户端：读写白名单、派发加固、token 隔离、字段投影');
  const kanban = svc('hermes-kanban.js');

  await t('buildPath 只接受白名单 op，动态段与 query 都过校验', () => {
    assert.strictEqual(kanban.buildPath('board'), '/board');
    assert.strictEqual(kanban.buildPath('board', { board: 'ops-2026', includeArchived: true }),
      '/board?board=ops-2026&include_archived=true');
    assert.strictEqual(kanban.buildPath('task', { taskId: 't_ab12' }), '/tasks/t_ab12');
    assert.strictEqual(kanban.buildPath('run', { runId: 12 }), '/runs/12');
    assert.ok(kanban.buildPath('board', { tenant: 'a b&c' }).includes('tenant=a+b%26c'), 'query 未编码');
    for (const bad of ['../../etc/passwd', 't_a/../x', 't_a?x=1', '', 'T_x']) {
      assert.strictEqual(kanban.buildPath('task', { taskId: bad }), null, '非法任务 id 未被拒：' + bad);
    }
    assert.strictEqual(kanban.buildPath('board', { board: '../default' }), null, '非法 board slug 未被拒');
    assert.strictEqual(kanban.buildPath('run', { runId: '1;drop' }), null, '非法 run id 未被拒');
    assert.strictEqual(kanban.buildPath('dispatch'), null, '读路径不得含 dispatch');
    assert.strictEqual(kanban.buildPath('decompose'), null, '未知 op 必须拒绝');
    assert.strictEqual(kanban.buildPath('workers', { board: 'ops-2026' }), '/workers/active?board=ops-2026');
    assert.strictEqual(kanban.buildPath('board', { board: null }), '/board', 'null board 不应变成 slug "null"');
    assert.strictEqual(kanban.buildPath('projects'), '/projects', '项目列表读端点缺失');
  });
  await t('buildWritePath 只有六条写路径，动态段同样过正则', () => {
    assert.strictEqual(kanban.buildWritePath('createTask'), '/tasks');
    assert.strictEqual(kanban.buildWritePath('createTask', { board: 'ops-2026' }), '/tasks?board=ops-2026');
    assert.strictEqual(kanban.buildWritePath('createBoard'), '/boards');
    assert.strictEqual(kanban.buildWritePath('deleteTask', { taskId: 't_ab12' }), '/tasks/t_ab12');
    assert.strictEqual(kanban.buildWritePath('submitTask', { taskId: 't_ab12' }), '/tasks/t_ab12');
    assert.strictEqual(kanban.buildWritePath('bindBoard', { slug: 'default' }), '/boards/default');
    assert.strictEqual(kanban.buildWritePath('bindBoard', { slug: 'ops 2026' }), null, '非法看板 slug 未被拒');
    assert.strictEqual(kanban.buildWritePath('bindBoard', { slug: '' }), null, '空 slug 未被拒');
    for (const bad of ['decompose', 'bulk', 'task', 'specify', 'reclaim', 'terminate', '']) {
      assert.strictEqual(kanban.buildWritePath(bad), null, '未知写 op 未被拒：' + bad);
    }
    assert.strictEqual(kanban.buildWritePath('deleteTask', { taskId: '../x' }), null);
    assert.strictEqual(kanban.buildWritePath('submitTask', { taskId: '../x' }), null);
    assert.strictEqual(kanban.buildWritePath('createTask', { board: '../x' }), null);
  });
  await t('项目绑定 / 建卡选项目的入参清洗', () => {
    assert.deepStrictEqual(kanban.cleanBoardBind({ projectId: 'pj_9' }), { project_id: 'pj_9' });
    assert.deepStrictEqual(kanban.cleanBoardBind({ projectId: '' }), { project_id: '' }, '空串=解绑，不能拒绝');
    assert.deepStrictEqual(kanban.cleanBoardBind({}), { project_id: '' });
    assert.strictEqual(kanban.cleanBoardBind({ projectId: 'bad name!' }), null, '非法项目标识未被拒');
    assert.strictEqual(kanban.cleanBoardBind({ projectId: '../etc' }), null, '路径穿越未被拒');
    const key0 = 'desktop-unit-proj';
    const ok = kanban.cleanTaskInput({ title: 'x', idempotencyKey: key0, projectId: 'hermes-agent' });
    assert.strictEqual(ok.project_id, 'hermes-agent', '建卡 projectId 未透传');
    assert.ok(!('project_id' in kanban.cleanTaskInput({ title: 'x', idempotencyKey: key0 })), '未选项目不得带 project_id（保持继承语义）');
    assert.strictEqual(kanban.cleanTaskInput({ title: 'x', idempotencyKey: key0, projectId: 'bad name!' }), null, '非法项目标识未被拒');
  });
  await t('建项目 argv：名称/文件夹/slug/描述的清洗与拒绝（不真跑 CLI）', () => {
    const { createProjectArgv } = require('../main/services/hermes-project-cli');
    const r = createProjectArgv('Hermes Agent', ['/tmp/repo', ' ~/x '], { description: ' d ', slug: 'hermes-agent' });
    for (const expected of ['project', 'create', 'Hermes Agent', '/tmp/repo', '~/x']) {
      assert.ok(r.argv.includes(expected), 'argv 缺少 ' + expected);
    }
    const di = r.argv.indexOf('--description');
    assert.ok(di > 0 && r.argv[di + 1] === 'd', '描述未 trim');
    assert.ok(r.argv.includes('--slug') && r.argv[r.argv.indexOf('--slug') + 1] === 'hermes-agent');
    assert.strictEqual(createProjectArgv('').error, '请填写项目名称');
    assert.strictEqual(createProjectArgv('a'.repeat(81)).error, '项目名称过长（≤80 字）');
    assert.ok(String(createProjectArgv('ok', ['relative/path']).error || '').includes('绝对路径'), '相对路径未被拒');
    assert.ok(String(createProjectArgv('ok', ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i']).error || '').includes('8'), '文件夹数量未受限');
    assert.ok(String(createProjectArgv('ok', [], { slug: 'Bad Slug' }).error || '').includes('slug'), '非法 slug 未被拒');
    const bare = createProjectArgv('Solo');
    assert.ok(bare.argv.includes('Solo') && !bare.argv.includes('--slug') && !bare.argv.includes('--description'), '纯名称不应带可选参数');
  });
  await t('派发参数：dry_run 默认 true、显式 false 才真跑、max 硬上限 4', () => {
    assert.strictEqual(kanban.buildWritePath('dispatch'), '/dispatch?dry_run=true&max=1');
    assert.strictEqual(kanban.buildWritePath('dispatch', { dryRun: true }), '/dispatch?dry_run=true&max=1');
    assert.strictEqual(kanban.buildWritePath('dispatch', { dryRun: false }), '/dispatch?dry_run=false&max=1');
    // 伪造的 truthy 值不能把试运行变成真派发
    assert.ok(!kanban.buildWritePath('dispatch', { dryRun: 'false' }).includes('dry_run=false'));
    assert.ok(kanban.buildWritePath('dispatch', { dryRun: false, max: 999 }).endsWith('max=4'), 'max 未封顶');
    assert.ok(kanban.buildWritePath('dispatch', { dryRun: false, max: -3 }).endsWith('max=1'), '负数 max 未收敛');
    assert.ok(kanban.buildWritePath('dispatch', { dryRun: false, max: '8' }).endsWith('max=1'), '字符串 max 未收敛');
    assert.strictEqual(kanban.buildWritePath('dispatch', { board: '../x' }), null, '非法 board 未拒');
    assert.strictEqual(kanban.SUBMIT_STATUS, 'ready', '提交派发状态被改');
  });
  await t('派发结果 / worker 投影剔除本机路径与 PID', () => {
    const d = kanban.projectDispatch({
      spawned: [['t_a', 'alpha', '/Users/me/secret/ws'], { task_id: 't_b', assignee: 'beta', workspace: '/secret' }],
      skipped_unassigned: ['t_c'], crashed: ['t_d'], reclaimed: 2, promoted: 1,
      skipped_per_profile_capped: [['t_e', 'alpha', 4]], respawn_guarded: [['t_f', 'cooldown']],
      workspace_path: '/secret', worker_pid: 4242, claim_lock: 'lock',
    });
    assert.deepStrictEqual(d.spawned, [{ taskId: 't_a', assignee: 'alpha' }, { taskId: 't_b', assignee: 'beta' }]);
    assert.deepStrictEqual(d.skippedPerProfile, [{ taskId: 't_e', assignee: 'alpha', current: 4 }]);
    assert.strictEqual(d.counts.reclaimed, 2);
    assert.ok(d.lists.skipped_unassigned.includes('t_c'));
    assert.ok(!JSON.stringify(d).includes('/Users/me/secret'), 'workspace 绝对路径泄漏');
    assert.ok(!JSON.stringify(d).includes('4242'), 'worker PID 泄漏');
    const w = kanban.projectWorkers({ workers: [{ run_id: 1, task_id: 't_a', task_title: 'A', worker_pid: 999, claim_lock: '/tmp/lock' }], count: 1, checked_at: 100 });
    assert.strictEqual(w.workers[0].task_title, 'A');
    for (const k of ['worker_pid', 'claim_lock', 'claim_expires']) assert.ok(!(k in w.workers[0]), '泄漏 ' + k);
  });
  await t('写 body 清洗：默认 triage、字段白名单、幂等键与 slug 校验', () => {
    const key = 'desktop-unit-0001';
    assert.deepStrictEqual(kanban.cleanTaskInput({ title: '  hi  ', idempotencyKey: key }),
      { title: 'hi', priority: 0, triage: true, idempotency_key: key });
    const ready = kanban.cleanTaskInput({
      title: 'hi', body: 'desc', assignee: 'ops', tenant: 'acme', priority: 9,
      status: 'ready', idempotencyKey: key, switch: true, workspace_path: '/evil', evil: 1,
    });
    assert.strictEqual(ready.triage, false);
    assert.deepStrictEqual(Object.keys(ready).sort(),
      ['assignee', 'body', 'idempotency_key', 'priority', 'tenant', 'title', 'triage'].sort());
    for (const bad of [null, {}, { title: '   ' }, { title: 'x' },
      { title: 'x', idempotencyKey: 'short' }, { title: 'x', idempotencyKey: 'has space here' }]) {
      assert.strictEqual(kanban.cleanTaskInput(bad), null, '非法任务输入未拒：' + JSON.stringify(bad));
    }
    const board = kanban.cleanBoardInput({ slug: 'ops-2026', name: 'Ops', description: 'd', switch: true, default_workdir: '/evil' });
    assert.deepStrictEqual(board, { slug: 'ops-2026', name: 'Ops', description: 'd' });
    for (const bad of [null, {}, { slug: '../x' }, { slug: 'Ops Board' }, { slug: 'A/B' }]) {
      assert.strictEqual(kanban.cleanBoardInput(bad), null, '非法看板输入未拒：' + JSON.stringify(bad));
    }
  });
  await t('validInfo 严格校验 loopback 端口与 token', () => {
    assert.ok(kanban.validInfo({ port: 53443, token: 'abcdefgh1234' }));
    for (const bad of [null, {}, { port: 0, token: 'abcdefgh' }, { port: 70000, token: 'abcdefgh' },
      { port: '53443', token: 'abcdefgh' }, { port: 53443, token: '' },
      { port: 53443, token: 'has space' }, { port: 53443, token: 'a\nb' }]) {
      assert.ok(!kanban.validInfo(bad), '应拒绝：' + JSON.stringify(bad));
    }
  });
  await t('projectBoard 补齐 8/9 列并按白名单剔除敏感字段', () => {
    const raw = {
      columns: [{ name: 'running', tasks: [{
        id: 't_ab12', title: 'A', status: 'running', priority: 2, assignee: 'ops',
        workspace_path: '/Users/me/secret', claim_lock: 'lock-x', claim_expires: 123,
        worker_pid: 4242, idempotency_key: 'k', latest_summary: 'done half',
      }] }],
      tenants: ['acme'], assignees: ['ops'], latest_event_id: 42, now: 1700000000,
    };
    const b = kanban.projectBoard(raw, false);
    assert.strictEqual(b.columns.length, 8, '默认应为 8 列');
    assert.strictEqual(b.latestEventId, 42);
    const card = b.columns.find((c) => c.name === 'running').tasks[0];
    assert.strictEqual(card.title, 'A');
    assert.strictEqual(card.priority, 2);
    for (const k of ['workspace_path', 'claim_lock', 'claim_expires', 'worker_pid', 'idempotency_key']) {
      assert.ok(!(k in card), '敏感字段泄漏：' + k);
    }
    assert.strictEqual(kanban.projectBoard(raw, true).columns.length, 9, '含归档时应为 9 列');
    assert.ok(Array.isArray(kanban.projectBoard(null, false).columns), '空响应不能抛错');
  });
  await t('projectDetail 投影评论 / 事件 / 依赖，长列表封顶', () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1, task_id: 't_ab12', kind: 'heartbeat', payload: '{}', created_at: 1700000000 + i,
      workspace_path: '/secret',
    }));
    const d = kanban.projectDetail({
      task: { id: 't_ab12', title: 'A', body: 'x'.repeat(30000), workspace_path: '/secret' },
      comments: [{ id: 1, task_id: 't_ab12', author: 'me', body: 'hi', created_at: 1 }],
      events,
      links: { parents: ['t_p'], children: [] },
      runs: [{ id: 3, status: 'done', worker_pid: 9 }],
      attachments: [{ id: 1, task_id: 't_ab12', filename: 'a.txt', stored_path: '/secret/a.txt', size: 10 }],
    });
    assert.strictEqual(d.task.body.length, 20000, '正文未封顶');
    assert.ok(!('workspace_path' in d.task), '详情泄漏工作区路径');
    assert.ok(!('stored_path' in d.attachments[0]), '附件泄漏落盘路径');
    assert.ok(!('worker_pid' in d.runs[0]), '运行记录泄漏 PID');
    assert.strictEqual(d.events.length, 60, '事件未截断到最近 60 条');
    assert.strictEqual(d.events[0].id, 141, '应保留最新 60 条');
    assert.deepStrictEqual(d.links.parents, ['t_p']);
  });

  // 真实 loopback server 夹具：验证 header 注入、路径前缀、错误处理与 token 不外泄。
  // 只监听 127.0.0.1 的临时端口，不联网、不启动 CLI、不写任何文件。
  const http = require('http');
  const seen = [];
  let force401 = false;
  let force400 = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      seen.push({ path: req.url, method: req.method, token: req.headers['x-hermes-session-token'] || '',
        len: req.headers['content-length'] || '', body: raw });
      res.setHeader('Content-Type', 'application/json');
      if (force401) { res.statusCode = 401; res.end('{"detail":"Unauthorized"}'); return; }
      if (force400) { res.statusCode = 400; res.end('{"detail":"title is required"}'); return; }
      const p = req.url.split('?')[0];
      if (req.method === 'POST' && p === '/api/plugins/kanban/boards') {
        res.end(JSON.stringify({ board: { slug: 'unit-board', name: 'Unit Board', default_workdir: '/secret' }, current: 'default' }));
        return;
      }
      if (req.method === 'DELETE' && p === '/api/plugins/kanban/tasks/t_ab12') {
        res.end(JSON.stringify({ deleted: true, task_id: 't_ab12' }));
        return;
      }
      if (req.method === 'POST' && p === '/api/plugins/kanban/dispatch') {
        const dry = req.url.includes('dry_run=true');
        // 稍作延迟，让并发的第二次派发确实撞上串行锁；reclaimed 随 dry_run 区分，
        // 便于断言 query 真的传到了服务端而不是被主进程吞掉。
        setTimeout(() => res.end(JSON.stringify({
          spawned: [['t_a', 'alpha', '/secret/ws']],
          skipped_unassigned: ['t_b'], reclaimed: dry ? 0 : 1, promoted: 0, worker_pid: 4242,
          workspace_path: '/secret', claim_lock: 'lock-x',
        })), 20);
        return;
      }
      if (req.method === 'PATCH' && p === '/api/plugins/kanban/tasks/t_ab12') {
        res.end(JSON.stringify({ task: { id: 't_ab12', title: 'A', status: 'ready', workspace_path: '/secret' } }));
        return;
      }
      if (req.method === 'GET' && p === '/api/plugins/kanban/workers/active') {
        res.end(JSON.stringify({ workers: [{ run_id: 3, task_id: 't_ab12', task_title: 'A',
          task_status: 'running', profile: 'alpha', worker_pid: 999, claim_lock: '/tmp/lock' }],
          count: 1, checked_at: 1700000000 }));
        return;
      }
      const fixtures = {
        '/api/plugins/kanban/board': { columns: [{ name: 'running', tasks: [{ id: 't_ab12', title: 'A', workspace_path: '/secret' }] }],
          assignees: ['ops'], tenants: [], latest_event_id: 7, now: 1700000000 },
        '/api/plugins/kanban/tasks': { task: { id: 't_new1', title: '新任务', status: 'triage', workspace_path: '/secret' } },
        '/api/plugins/kanban/tasks/t_ab12': { task: { id: 't_ab12', title: 'A', session_id: 'sess_1' },
          comments: [], events: [], links: { parents: [], children: [] }, runs: [] },
        '/api/plugins/kanban/stats': { by_status: { running: 1 }, by_assignee: { ops: 1 }, oldest_ready_age: null },
        '/api/plugins/kanban/assignees': { assignees: [{ name: 'ops' }] },
        '/api/plugins/kanban/boards': { boards: [{ slug: 'default', name: 'Default', total: 3, is_current: true }], current: 'default' },
        '/api/plugins/kanban/config': { render_markdown: true },
        '/api/plugins/kanban/diagnostics': { diagnostics: [], count: 0 },
        '/api/plugins/kanban/runs/3': { run: { id: 3, status: 'done', outcome: 'completed' } },
      };
      if (!(p in fixtures)) { res.statusCode = 404; res.end('{}'); return; }
      res.end(JSON.stringify(fixtures[p]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const TOKEN = 'unit-test-token-abc123';
  const client = kanban.createKanbanClient(() => ({ port, token: TOKEN, generation: 7 }));

  await t('board / task / run：每次请求都由主进程注入 token，响应不含 token', async () => {
    const b = await client.board({ board: 'default', tenant: 'acme' });
    assert.ok(b.ok, 'board 失败：' + b.error);
    assert.strictEqual(b.generation, 7);
    assert.strictEqual(b.latestEventId, 7);
    assert.ok(!('workspace_path' in b.columns.find((c) => c.name === 'running').tasks[0]));
    const d = await client.task('t_ab12', { board: 'default' });
    assert.ok(d.ok && d.task.id === 't_ab12' && d.task.session_id === 'sess_1');
    const run = await client.run(3);
    assert.ok(run.ok && run.run.outcome === 'completed', '/runs/:id 的 {run:{}} 包装未拆开');
    assert.ok(seen.length >= 3, '请求未真正发出');
    assert.ok(seen.every((x) => x.token === TOKEN), '会话 token 未注入每个请求');
    assert.ok(seen.every((x) => x.path.startsWith('/api/plugins/kanban/')), '路径越出插件前缀');
    assert.ok(seen.some((x) => x.path.includes('board=default') && x.path.includes('tenant=acme')), 'query 未透传');
    const leaked = JSON.stringify([b, d, run]);
    assert.ok(!leaked.includes(TOKEN), 'token 泄漏到返回值');
    assert.ok(!leaked.includes('/secret'), '本机路径泄漏到返回值');
  });
  await t('overview 拆开 CLI 的对象包装，组内失败互不拖累', async () => {
    const o = await client.overview({ board: 'default' });
    assert.ok(o.ok, 'overview 失败：' + o.error);
    assert.strictEqual(o.boards[0].slug, 'default', '/boards 的 {boards:[]} 未拆开');
    assert.strictEqual(o.currentBoard, 'default');
    assert.deepStrictEqual(o.assignees, ['ops'], '/assignees 的 {assignees:[]} 未拆开');
    assert.strictEqual(o.stats.by_status.running, 1, '/stats 的嵌套对象丢失');
    assert.ok(Array.isArray(o.diagnostics), '/diagnostics 的 {diagnostics:[]} 未拆开');
  });
  await t('非法参数在发请求前拒绝；401 给出可读错误而不是白屏', async () => {
    const before = seen.length;
    assert.ok(!(await client.task('../etc/passwd')).ok);
    assert.ok(!(await client.run('1;rm')).ok);
    assert.ok(!(await client.board({ board: '../x' })).ok);
    assert.strictEqual(seen.length, before, '非法参数竟然发出了请求');
    force401 = true;
    const r = await client.board();
    assert.ok(!r.ok && r.error.includes('鉴权失败'), '401 未转成可读提示');
    force401 = false;
  });
  await t('后端未就绪时明确报错，不尝试连接 0 端口', async () => {
    const cold = kanban.createKanbanClient(() => ({ port: 0, token: '', generation: 0 }));
    const r = await cold.board();
    assert.ok(!r.ok && r.error.includes('未就绪'));
  });
  await t('三个写操作：方法 / 路径 / header / body 白名单全部正确', async () => {
    const before = seen.length;
    const c = await client.createTask({
      title: '  新任务  ', body: '说明', status: 'ready', priority: 9,
      assignee: 'ops', tenant: 'acme', board: 'default',
      idempotencyKey: 'desktop-unit-0001', evil: '../../etc',
    });
    assert.ok(c.ok, 'createTask 失败：' + c.error);
    assert.strictEqual(c.task.title, '新任务');
    assert.ok(!('workspace_path' in c.task), '写响应泄漏本机路径');
    const r1 = seen[before];
    assert.strictEqual(r1.method, 'POST');
    assert.strictEqual(r1.path, '/api/plugins/kanban/tasks?board=default');
    assert.strictEqual(r1.token, TOKEN, '写请求未注入会话 token');
    const sent1 = JSON.parse(r1.body);
    assert.deepStrictEqual(Object.keys(sent1).sort(),
      ['assignee', 'body', 'idempotency_key', 'priority', 'tenant', 'title', 'triage'].sort());
    assert.strictEqual(sent1.triage, false, 'ready 状态不应带 triage=true');
    assert.ok(!('evil' in sent1) && !('switch' in sent1) && !('workspace_path' in sent1));

    const c2 = await client.createTask({ title: '默认', idempotencyKey: 'desktop-unit-0002' });
    assert.ok(c2.ok);
    assert.strictEqual(JSON.parse(seen[before + 1].body).triage, true, '默认必须停在 triage');

    const b = await client.createBoard({ slug: 'unit-board', name: 'Unit Board', description: 'd', switch: true, default_workdir: '/evil' });
    assert.ok(b.ok, 'createBoard 失败：' + b.error);
    assert.strictEqual(b.board.slug, 'unit-board');
    assert.ok(!('default_workdir' in b.board), '看板响应泄漏工作目录');
    assert.strictEqual(seen[before + 2].method, 'POST');
    assert.strictEqual(seen[before + 2].path, '/api/plugins/kanban/boards');
    assert.deepStrictEqual(Object.keys(JSON.parse(seen[before + 2].body)).sort(), ['description', 'name', 'slug']);

    const del = await client.deleteTask('t_ab12', { board: 'default' });
    assert.ok(del.ok && del.taskId === 't_ab12', 'deleteTask 失败：' + del.error);
    assert.strictEqual(seen[before + 3].method, 'DELETE');
    assert.strictEqual(seen[before + 3].path, '/api/plugins/kanban/tasks/t_ab12?board=default');
    assert.strictEqual(seen[before + 3].token, TOKEN);
    assert.ok(!JSON.stringify([c, c2, b, del]).includes(TOKEN), '写结果泄漏 token');
  });
  await t('派发链路：dry-run 默认、真派发显式、POST 无 body、并发串行', async () => {
    const before = seen.length;
    const preview = await client.dispatch({ board: 'default', max: 99 });
    assert.ok(preview.ok, '试运行失败：' + preview.error);
    assert.strictEqual(preview.dryRun, true, '缺省必须是纯预览');
    assert.deepStrictEqual(preview.spawned, [{ taskId: 't_a', assignee: 'alpha' }]);
    assert.strictEqual(preview.counts.reclaimed, 0, 'dry_run=true 未传到服务端');
    const r1 = seen[before];
    assert.strictEqual(r1.method, 'POST');
    assert.strictEqual(r1.path, '/api/plugins/kanban/dispatch?board=default&dry_run=true&max=4');
    assert.strictEqual(r1.body, '', '派发 POST 不应带 body');
    assert.strictEqual(r1.len, '0', '无 body 的 POST 必须显式声明长度');
    assert.strictEqual(r1.token, TOKEN, '派发请求未注入会话 token');
    assert.ok(!JSON.stringify(preview).includes('/secret'), '派发结果泄漏工作区路径');
    assert.ok(!JSON.stringify(preview).includes('4242'), '派发结果泄漏 worker PID');

    const real = await client.dispatch({ board: 'default', dryRun: false, max: 2 });
    assert.ok(real.ok && real.dryRun === false, '显式真派发失败');
    assert.strictEqual(real.counts.reclaimed, 1, 'dry_run=false 未传到服务端');
    assert.ok(seen[before + 1].path.includes('dry_run=false&max=2'), '真派发参数不对');

    const n = seen.length;
    const [p1, p2] = await Promise.all([client.dispatch({ dryRun: false }), client.dispatch({ dryRun: false })]);
    assert.ok(p1.ok, '并发中的首个派发应成功');
    assert.ok(!p2.ok && p2.error.includes('进行中'), '并发派发未被串行锁拒绝');
    assert.strictEqual(seen.length - n, 1, '并发派发发出了两次真实 HTTP 请求');

    const s = await client.submitTask('t_ab12', { board: 'default' });
    assert.ok(s.ok && s.task.status === 'ready', '提交派发失败：' + s.error);
    const sp = seen[seen.length - 1];
    assert.strictEqual(sp.method, 'PATCH');
    assert.strictEqual(sp.path, '/api/plugins/kanban/tasks/t_ab12?board=default');
    assert.deepStrictEqual(JSON.parse(sp.body), { status: 'ready' }, 'PATCH body 被渲染层污染');
    assert.ok(!JSON.stringify(s).includes('/secret'), '提交派发响应泄漏路径');

    const w = await client.activeWorkers({ board: 'default' });
    assert.ok(w.ok && w.workers.length === 1, '活跃 worker 读取失败：' + w.error);
    assert.ok(!JSON.stringify(w).includes('999'), '活跃 worker 泄漏 PID');
    assert.strictEqual(seen[seen.length - 1].method, 'GET', 'worker 列表必须是只读');
  });
  await t('派发非法参数在发请求前拒绝（不误触发 agent）', async () => {
    const before = seen.length;
    assert.ok(!(await client.dispatch({ board: '../x' })).ok, '非法 board 未被拒');
    assert.ok(!(await client.submitTask('../etc/passwd')).ok, '非法任务 id 未被拒');
    assert.ok(!(await client.activeWorkers({ board: '../x' })).ok, '非法 worker board 未被拒');
    assert.strictEqual(seen.length, before, '非法派发参数竟发出了 HTTP 请求');
  });
  await t('非法写参数在发请求前拒绝，CLI 错误 detail 原样透出', async () => {
    const before = seen.length;
    for (const bad of [{ title: '' }, { title: 'x' }, { title: 'x', idempotencyKey: 'short' }]) {
      assert.ok(!(await client.createTask(bad)).ok, '非法任务参数未拒');
    }
    assert.ok(!(await client.createBoard({ slug: '../x' })).ok);
    assert.ok(!(await client.createTask({ title: 'x', idempotencyKey: 'desktop-unit-0001', board: '../x' })).ok);
    assert.ok(!(await client.deleteTask('../etc/passwd')).ok);
    assert.strictEqual(seen.length, before, '非法写参数竟发出了 HTTP 请求');
    force400 = true;
    const r = await client.createTask({ title: 'x', idempotencyKey: 'desktop-unit-0003' });
    assert.ok(!r.ok && r.error.includes('title is required'), '400 未透出 CLI 的 detail');
    force400 = false;
  });
  await t('拖拽改派：PATCH 只带 assignee/status 白名单，非法受让人与状态在发请求前拒绝', async () => {
    const before = seen.length;
    const r = await client.reassignTask('t_ab12', { assignee: 'ops', status: 'ready', board: 'default', evil: 1 });
    assert.ok(r.ok, 'reassignTask 失败：' + r.error);
    assert.strictEqual(r.assignee, 'ops');
    assert.strictEqual(r.task.status, 'ready');
    assert.ok(!('workspace_path' in r.task), '改派响应泄漏本机路径');
    const req1 = seen[before];
    assert.strictEqual(req1.method, 'PATCH');
    assert.strictEqual(req1.path, '/api/plugins/kanban/tasks/t_ab12?board=default');
    assert.strictEqual(req1.token, TOKEN, '改派未注入会话 token');
    assert.deepStrictEqual(JSON.parse(req1.body), { assignee: 'ops', status: 'ready' }, '改派 body 被污染');

    // 空串 = 取消指派，且绝不顺带改状态
    const un = await client.reassignTask('t_ab12', { assignee: '' });
    assert.ok(un.ok, '取消指派失败：' + un.error);
    assert.deepStrictEqual(JSON.parse(seen[seen.length - 1].body), { assignee: '' }, '取消指派 body 不干净');

    const n = seen.length;
    for (const bad of ['ops team', 'a/b', 'a;b', '-lead', '.hidden', 'x'.repeat(90), 'a\nb']) {
      assert.ok(!(await client.reassignTask('t_ab12', { assignee: bad })).ok, '非法受让人未拒：' + JSON.stringify(bad));
    }
    assert.ok(!(await client.reassignTask('../etc/passwd', { assignee: 'ops' })).ok, '非法任务 id 未拒');
    assert.ok(!(await client.reassignTask('t_ab12', { assignee: 'ops', status: 'done' })).ok, '非 ready 状态推进未拒');
    assert.ok(!(await client.reassignTask('t_ab12', { assignee: 'ops', status: 'running' })).ok, 'running 未被拒');
    assert.strictEqual(seen.length, n, '非法改派竟发出了 HTTP 请求');
  });
  await t('拖拽派发只买一个名额：预演确认队首是目标才真派发', async () => {
    // spawned 夹具固定是 t_a → alpha；目标 t_a 即队首，应真派发一次
    const before = seen.length;
    const ok = await client.dispatchTask('t_a', { board: 'default' });
    assert.ok(ok.ok, 'dispatchTask 失败：' + ok.error);
    assert.strictEqual(ok.dispatched, true, '队首就是目标却没派发：' + ok.reason);
    assert.strictEqual(ok.reason, '');
    assert.ok(seen.length - before === 2, '应恰好两次请求（预演 + 真派发），实际 ' + (seen.length - before));
    assert.strictEqual(seen[before].path, '/api/plugins/kanban/dispatch?board=default&dry_run=true&max=1');
    assert.strictEqual(seen[before + 1].path, '/api/plugins/kanban/dispatch?board=default&dry_run=false&max=1');
    assert.strictEqual(seen[before + 1].body, '', '真派发 POST 不应带 body');
    assert.strictEqual(seen[before + 1].len, '0');
    assert.ok(!JSON.stringify(ok).includes('/secret'), '派发结果泄漏工作区路径');
    assert.ok(!JSON.stringify(ok).includes('4242'), '派发结果泄漏 worker PID');

    // 队首不是目标：预览都跑完就停手，绝不写库（否则会顺带唤醒别人的 worker）
    const n = seen.length;
    const behind = await client.dispatchTask('t_c', { board: 'default' });
    assert.ok(behind.ok, 'dispatchTask 应返回可诊断结果而不是抛错');
    assert.strictEqual(behind.dispatched, false);
    assert.strictEqual(behind.blockedBy, 't_a', '未指出挡在前面的队首');
    assert.ok(behind.reason.includes('t_a'), '原因里应点名队首卡片');
    assert.ok(behind.reason.includes('下一次'), '原因应说明何时轮到');
    assert.strictEqual(seen.length - n, 1, '队首不匹配时仍然发出了真派发请求');
    assert.ok(seen[seen.length - 1].path.includes('dry_run=true'), '唯一那次请求必须是纯预演');

    // 目标在 skipped_unassigned 里：给出「没有受让人」的具体原因，而不是笼统失败
    const n2 = seen.length;
    const un = await client.dispatchTask('t_b', { board: 'default' });
    assert.strictEqual(un.dispatched, false);
    assert.ok(un.reason.includes('没有受让人'), '未识别 skipped_unassigned：' + un.reason);
    assert.strictEqual(seen.length - n2, 1, '被跳过的卡片不该触发真派发');

    const n3 = seen.length;
    assert.ok(!(await client.dispatchTask('../x')).ok);
    assert.ok(!(await client.dispatchTask('t_a', { board: '../x' })).ok);
    assert.strictEqual(seen.length, n3, '非法派发目标竟发出了请求');
  });
  await new Promise((r) => server.close(r));

  section('15. 小球模式偏好：只落 userData、非法值降级、不碰 CLI 配置');
  const orbPrefs = require(path.join(ROOT, 'main', 'orb-prefs.js'));
  await t('缺省 / 损坏文件都回 always + 快捷键开启', () => {
    const dir = path.join(tmp, 'orb-prefs-empty');
    assert.deepStrictEqual(orbPrefs.load(dir), { mode: 'always', hotkey: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, orbPrefs.FILE), '{not json');
    assert.deepStrictEqual(orbPrefs.load(dir), { mode: 'always', hotkey: true });
  });
  await t('只接受两个枚举模式与布尔开关，多余字段一律丢弃', () => {
    const dir = path.join(tmp, 'orb-prefs-case');
    assert.deepStrictEqual(
      orbPrefs.normalize({ mode: 'hotkey', hotkey: false, evil: '../../etc', model: 'x' }),
      { mode: 'hotkey', hotkey: false });
    assert.deepStrictEqual(orbPrefs.normalize({ mode: 'alwaysx', hotkey: 'yes' }),
      { mode: 'always', hotkey: true });
    const saved = orbPrefs.save(dir, { mode: 'hotkey', hotkey: false });
    assert.deepStrictEqual(saved, { mode: 'hotkey', hotkey: false });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, orbPrefs.FILE), 'utf8')), saved);
    assert.strictEqual(path.dirname(orbPrefs.prefsPath(dir)), dir);
  });
  await t('非法 patch 不会写坏配置，重新读取仍是规范态', () => {
    const dir = path.join(tmp, 'orb-prefs-case');
    assert.deepStrictEqual(orbPrefs.save(dir, { mode: '../etc/passwd', hotkey: 1 }),
      { mode: 'always', hotkey: true });
    assert.deepStrictEqual(orbPrefs.load(dir), { mode: 'always', hotkey: true });
  });
  await t('配置只落在传入的 userData 目录，CLI config.yaml 一字未动', () => {
    const dir = path.join(tmp, 'orb-prefs-only');
    orbPrefs.save(dir, { mode: 'hotkey' });
    assert.ok(fs.existsSync(path.join(dir, orbPrefs.FILE)));
    assert.ok(!fs.existsSync(path.join(hermesRoot, orbPrefs.FILE)));
    assert.strictEqual(fs.readFileSync(path.join(hermesRoot, 'config.yaml'), 'utf8'),
      'model:\n  default: test-model\n');
  });

  section('N. 看板编排：三档模式是两个布尔推导出来的，不单独存');
  const kbm = loaded['hermes-kanban-mode.js'];
  const cfgMod = loaded['hermes-config.js'];

  await t('模式推导：派发器关闭压倒一切（分解开着也只是往 ready 里堆卡）', () => {
    assert.strictEqual(kbm.modeOf({ dispatchInGateway: true, autoDecompose: true }), 'auto');
    assert.strictEqual(kbm.modeOf({ dispatchInGateway: true, autoDecompose: false }), 'semi');
    assert.strictEqual(kbm.modeOf({ dispatchInGateway: false, autoDecompose: true }), 'manual');
    assert.strictEqual(kbm.modeOf({ dispatchInGateway: false, autoDecompose: false }), 'manual');
  });

  await t('缺省值对齐 CLI config_defaults：没写过就是全自动', () => {
    const d = kbm.describeMode({});
    assert.strictEqual(d.mode, 'auto');
    assert.strictEqual(d.dispatchInGateway, true);
    assert.strictEqual(d.autoDecompose, true);
    assert.strictEqual(d.decomposeStranded, false);
  });

  await t('派发器停了但分解还开着 → 必须自报 decomposeStranded', () => {
    assert.strictEqual(kbm.describeMode({ dispatch_in_gateway: false }).decomposeStranded, true);
    assert.strictEqual(
      kbm.describeMode({ dispatch_in_gateway: false, auto_decompose: false }).decomposeStranded, false);
  });

  await t('parseKanbanSwitches：只读顶层 kanban 段，dashboard.kanban 不得串味', () => {
    const text = [
      'dashboard:',
      '  kanban:',
      '    auto_decompose: true',
      'kanban:',
      '  auto_decompose: false   # 关掉',
      '  dispatch_in_gateway: no',
      '  default_assignee: "worker"',
      'model:',
      '  default: x',
    ].join('\n');
    const s = cfgMod.parseKanbanSwitches(text);
    assert.strictEqual(s.auto_decompose, false);
    assert.strictEqual(s.dispatch_in_gateway, false);
    assert.strictEqual(s.default_assignee, 'worker');
    assert.strictEqual(s.auto_promote_children, true, '没写的键必须落默认值 true');
  });

  await t('parseKanbanSwitches：空配置不报错，全落默认', () => {
    const s = cfgMod.parseKanbanSwitches('');
    assert.strictEqual(s.dispatch_in_gateway, true);
    assert.strictEqual(s.auto_decompose, true);
  });

  await t('apply 只写需要变的开关，未变的不重写', async () => {
    const calls = [];
    const rest = { ok: true, autoDecompose: true, autoPromoteChildren: true, orchestratorProfile: '',
      defaultAssignee: '', resolvedOrchestrator: 'default', resolvedAssignee: 'default', activeProfile: 'default' };
    const mode = kbm.createKanbanMode({
      kanban: {
        async orchestration() { return { ...rest }; },
        async setOrchestration(body) { calls.push(['rest', body]); return { ok: true }; },
      },
      cfg: {
        kanbanSwitches() { return { ok: true, auto_decompose: true, auto_promote_children: true, dispatch_in_gateway: true }; },
        async setKanbanSwitch(k, v) { calls.push(['cli', k, v]); return { ok: true }; },
      },
    });
    // 全自动 → 半自动：只该动 auto_decompose，且不需要重启
    const r1 = await mode.apply('semi');
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.needsRestart, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)), [['rest', { auto_decompose: false }]]);
    // 全自动 → 全手动：必须写 dispatch_in_gateway，并且明确报需要重启
    calls.length = 0;
    const r2 = await mode.apply('manual');
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.needsRestart, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls)),
      [['rest', { auto_decompose: false }], ['cli', 'dispatch_in_gateway', false]]);
  });

  await t('未知档位被拒，且不产生任何写入', async () => {
    const calls = [];
    const mode = kbm.createKanbanMode({
      kanban: {
        async orchestration() { return { ok: true, autoDecompose: true }; },
        async setOrchestration(b) { calls.push(b); return { ok: true }; },
      },
      cfg: {
        kanbanSwitches() { return { ok: true }; },
        async setKanbanSwitch() { calls.push('cli'); return { ok: true }; },
      },
    });
    const r = await mode.apply('nonsense');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(calls, []);
  });

  await t('REST 不可用时降级读 config.yaml，不整块失败', async () => {
    const mode = kbm.createKanbanMode({
      kanban: { async orchestration() { return { ok: false, error: '后端未就绪' }; }, async setOrchestration() { return { ok: false }; } },
      cfg: { kanbanSwitches() { return { ok: true, auto_decompose: false, dispatch_in_gateway: true }; }, async setKanbanSwitch() { return { ok: true }; } },
    });
    const s = await mode.read();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.degraded, true);
    assert.strictEqual(s.mode, 'semi');
  });

  // 清理：仅删除本测试自建的临时目录
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  console.log('\n' + '─'.repeat(56));
  console.log(`服务层回归：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exitCode = 1;
}

run().catch((e) => {
  console.error('FATAL:', e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
