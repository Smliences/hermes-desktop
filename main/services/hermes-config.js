'use strict';
/**
 * hermes-config.js — hermes 全局配置只读通道 + 配置文件直达
 *
 * providers/models 来自 ~/.hermes/providers.json、models.json（hermes 官方存储）。
 * 只读展示；写操作仍以 hermes CLI / 手动编辑 config.yaml 为准。
 */
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

const profile = require('./hermes-profile');
const { resolveHermesBin } = require('./hermes-bin');
const hermesHome = () => profile.home();

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

/** YAML 标量：引号内的 # 不当注释，裸值尾部注释剥掉。 */
function scalar(v) {
  const s = String(v == null ? '' : v).trim();
  const q = s[0];
  if ((q === '"' || q === "'") && s.length > 1) {
    const end = s.indexOf(q, 1);
    if (end > 0) return s.slice(1, end).trim();
  }
  return s.replace(/\s+#.*$/, '').trim();
}

/**
 * 只读解析 config.yaml 顶层 `model:` 块（行级，不引入 YAML 库、不改写文件）。
 * 必须限定在块内：文件后面 `providers:` / `agents:` 等也可能出现 `model:` 或
 * `default:`，全局正则会把别人的默认值当成 CLI 默认模型。
 */
function parseModelBlock(text) {
  const out = { defaultModel: '', provider: '', baseUrl: '' };
  let inBlock = false;
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    if (/^model\s*:\s*(?:#.*)?$/.test(raw)) { inBlock = true; continue; }
    if (inBlock && /^\S/.test(raw)) inBlock = false; // 遇到下一个顶层键即退出
    if (!inBlock) continue;
    const line = raw.replace(/\t/g, '  ');
    let m = line.match(/^\s+default\s*:\s*(.+)$/);
    if (m) { out.defaultModel = scalar(m[1]); continue; }
    m = line.match(/^\s+provider\s*:\s*(.+)$/);
    if (m) { out.provider = scalar(m[1]); continue; }
    m = line.match(/^\s+base_url\s*:\s*(.+)$/);
    if (m) out.baseUrl = scalar(m[1]);
  }
  return out;
}

/**
 * 模型状态快照（纯只读，零子进程）：CLI 默认模型来自 config.yaml，
 * 已配置模型来自 models.json。桌面端 userData/config.json 不在这里读，
 * 由渲染层拿 env.config.model 自行比较，避免服务层耦合 Electron userData。
 */
function modelState() {
  const configPath = path.join(hermesHome(), 'config.yaml');
  const modelsPath = path.join(hermesHome(), 'models.json');
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); }
  catch (err) {
    return { ok: false, defaultModel: '', provider: '', models: [], inModelsList: false,
      configPath, modelsPath, error: 'config.yaml 不可读：' + String((err && err.message) || err) };
  }
  const parsed = parseModelBlock(text);
  const rawModels = readJson(modelsPath);
  const models = (Array.isArray(rawModels) ? rawModels : [])
    .filter((m) => m && typeof m === 'object' && typeof m.model === 'string' && m.model)
    .map((m) => ({ id: m.id, name: m.name || m.model, provider: m.provider || '', model: m.model }));
  return {
    ok: !!parsed.defaultModel,
    defaultModel: parsed.defaultModel,
    provider: parsed.provider,
    baseUrl: parsed.baseUrl,
    models,
    inModelsList: !!parsed.defaultModel && models.some((m) => m.model === parsed.defaultModel),
    configPath, modelsPath,
  };
}

/** 模型提供商列表（真实 providers.json） */
function listProviders() {
  const data = readJson(path.join(hermesHome(),'providers.json'));
  const providers = Array.isArray(data?.providers) ? data.providers : [];
  return { ok: providers.length > 0, providers: providers.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl || '' })) };
}

/** 已配置模型列表（真实 models.json） */
function listModels() {
  const data = readJson(path.join(hermesHome(),'models.json'));
  const models = Array.isArray(data) ? data : [];
  return { ok: models.length > 0, models: models.map((m) => ({ id: m.id, name: m.name, provider: m.provider, model: m.model })) };
}

/** 配置文件路径（渲染端「打开配置文件」用） */
function configPaths() {
  return {
    configYaml: path.join(hermesHome(),'config.yaml'),
    providersJson: path.join(hermesHome(),'providers.json'),
    modelsJson: path.join(hermesHome(),'models.json'),
    memoryMd: path.join(hermesHome(),'memories','MEMORY.md'),
    userMd: path.join(hermesHome(),'memories','USER.md'),
  };
}

/**
 * 只读：`display.show_reasoning`（CLI 默认 true）。
 *
 * 这是「上游到底发不发推理」的唯一开关：v0.23.0 的 tui_gateway 在
 * agent_callbacks._emit_reasoning_delta 里直接用 `_session_show_reasoning(sid)` 短路，
 * 值为 false 时连一条 reasoning.delta 都不会下发（thinking.delta 是等待提示，不是推理）。
 * 关掉时桌面端再怎么渲染也拿不到内容，所以设置页要能看见这个真实状态。
 *
 * 只看 display 段里**恰好两格缩进**的 show_reasoning：`display.platforms.<x>.show_reasoning`
 * 是更深的键，gateway 的 _load_show_reasoning() 并不读它，混进来会误报「已开启」。
 */
function reasoningDisplay() {
  const configPath = path.join(hermesHome(), 'config.yaml');
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); }
  catch (err) {
    return { ok: false, enabled: true, explicit: false, configPath,
      error: 'config.yaml 不可读：' + String((err && err.message) || err) };
  }
  return { ok: true, configPath, ...parseReasoningDisplay(text) };
}

/** reasoningDisplay 的纯解析部分（便于单测：不碰文件系统）。 */
function parseReasoningDisplay(text) {
  let inDisplay = false;
  let enabled = true;
  let explicit = false;
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (/^display\s*:\s*(?:#.*)?$/.test(line)) { inDisplay = true; continue; }
    if (inDisplay && /^\S/.test(line)) break;          // 下一个顶层键
    if (!inDisplay) continue;
    const m = line.match(/^ {2}show_reasoning\s*:\s*(.+)$/);
    if (m) { explicit = true; enabled = !/^(?:false|no|off|0)\b/i.test(scalar(m[1])); }
  }
  return { enabled, explicit };
}

/**
 * 写 `display.show_reasoning`。走官方 `hermes config set`（唯一会做键校验 + 正确回写的路径；
 * 桌面端自己改 yaml 容易把注释和引号弄丢）。
 *
 * 这是**写 CLI 配置**：会同时改变命令行（hermes CLI / TUI）是否显示思考过程，
 * 因此只能由用户点二次确认卡触发，渲染层不得自动调用。
 */
function setReasoningDisplay(on) {
  return new Promise((resolve) => {
    const argv = profile.cliArgs(['config', 'set', 'display.show_reasoning', on ? 'true' : 'false']);
    let child = null;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(killer); resolve(v); } };
    const killer = setTimeout(() => {
      if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, error: '写入超时（hermes config set 未在 40s 内返回）' });
    }, 40000);
    try {
      child = execFile(resolveHermesBin(), argv, {
        timeout: 40000, maxBuffer: 1024 * 1024, env: profile.env({ NO_COLOR: '1' }),
      }, (err, stdout) => {
        const text = String(stdout || '').trim().slice(0, 2000);
        if (err) {
          const msg = String((err && err.message) || err).split('\n')[0];
          return finish({ ok: false, error: msg || '写入失败', text });
        }
        finish({ ok: true, text, state: reasoningDisplay() });
      });
      child.on('error', (e) => finish({ ok: false, error: String(e) }));
    } catch (e) { finish({ ok: false, error: String(e) }); }
  });
}

module.exports = {
  listProviders, listModels, configPaths, hermesHome, parseModelBlock, modelState,
  reasoningDisplay, parseReasoningDisplay, setReasoningDisplay,
};
