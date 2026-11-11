'use strict';
/**
 * hermes-gateway.js — 消息平台接入页的数据层
 *
 * 快速路径（默认）：直接读 ~/.hermes 下的状态 JSON / config.yaml / .env 的**键名**，
 * 不 spawn 子进程、不回显任何凭证值，打开页面即时出数据。
 * 操作路径：只在用户显式点击启停时 spawn `hermes gateway start|stop|restart`。
 *
 * 平台清单来自 hermes_cli/platforms.py，凭证键来自 gateway/config_env.py
 * (_ENV_ENABLE_CREDENTIALS)，均与本机 hermes CLI 保持一致。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const profile = require('./hermes-profile');
const curHome = () => profile.home();
const HERMES_BIN = process.env.HERMES_BIN || path.join(os.homedir(), '.local/bin/hermes');

const PLATFORMS = [
  { key: 'telegram', label: 'Telegram', ico: '📱', group: 'common', env: ['TELEGRAM_BOT_TOKEN'], setup: 'hermes gateway setup' },
  { key: 'discord', label: 'Discord', ico: '💬', group: 'common', env: ['DISCORD_BOT_TOKEN'], setup: 'hermes gateway setup' },
  { key: 'slack', label: 'Slack', ico: '💼', group: 'common', env: ['SLACK_BOT_TOKEN'], setup: 'hermes slack' },
  { key: 'whatsapp', label: 'WhatsApp', ico: '📱', group: 'common', env: ['WHATSAPP_ENABLED'], setup: 'hermes whatsapp' },
  { key: 'whatsapp_cloud', label: 'WhatsApp Business (Cloud)', ico: '📱', group: 'common', env: ['WHATSAPP_CLOUD_PHONE_NUMBER_ID', 'WHATSAPP_CLOUD_ACCESS_TOKEN'], setup: 'hermes whatsapp-cloud' },
  { key: 'signal', label: 'Signal', ico: '📡', group: 'common', env: ['SIGNAL_HTTP_URL'], setup: 'hermes gateway setup' },
  { key: 'bluebubbles', label: 'BlueBubbles', ico: '💙', group: 'common', env: ['BLUEBUBBLES_SERVER_URL', 'BLUEBUBBLES_PASSWORD'], setup: 'hermes gateway setup' },
  { key: 'email', label: 'Email', ico: '📧', group: 'common', env: ['EMAIL_ADDRESS', 'EMAIL_PASSWORD', 'EMAIL_IMAP_HOST', 'EMAIL_SMTP_HOST'], setup: 'hermes gateway setup' },
  { key: 'mattermost', label: 'Mattermost', ico: '💬', group: 'common', env: ['MATTERMOST_TOKEN'], setup: 'hermes gateway setup' },
  { key: 'matrix', label: 'Matrix', ico: '💬', group: 'common', env: ['MATRIX_ACCESS_TOKEN', 'MATRIX_PASSWORD'], setup: 'hermes gateway setup' },
  { key: 'weixin', label: '微信', ico: '💬', group: 'cn', env: ['WEIXIN_TOKEN', 'WEIXIN_ACCOUNT_ID'], setup: 'hermes gateway setup' },
  { key: 'feishu', label: '飞书', ico: '🪽', group: 'cn', env: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'], setup: 'hermes gateway setup' },
  { key: 'dingtalk', label: '钉钉', ico: '💬', group: 'cn', env: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'], setup: 'hermes gateway setup' },
  { key: 'wecom', label: '企业微信', ico: '💬', group: 'cn', env: ['WECOM_BOT_ID', 'WECOM_SECRET'], setup: 'hermes gateway setup' },
  { key: 'wecom_callback', label: '企业微信回调', ico: '💬', group: 'cn', env: ['WECOM_CALLBACK_CORP_ID', 'WECOM_CALLBACK_CORP_SECRET'], setup: 'hermes gateway setup' },
  { key: 'qqbot', label: 'QQ 机器人', ico: '💬', group: 'cn', env: ['QQ_APP_ID', 'QQ_CLIENT_SECRET'], setup: 'hermes gateway setup' },
  { key: 'yuanbao', label: '元宝', ico: '🤖', group: 'cn', env: ['YUANBAO_APP_ID', 'YUANBAO_APP_SECRET'], setup: 'hermes gateway setup' },
  { key: 'api_server', label: 'API Server', ico: '🌐', group: 'advanced', env: ['API_SERVER_KEY'], setup: 'hermes gateway setup' },
  { key: 'webhook', label: 'Webhook', ico: '🔗', group: 'advanced', env: [], setup: 'hermes webhook' },
  { key: 'cron', label: 'Cron', ico: '⏰', group: 'advanced', env: [], setup: 'hermes cron' },
  { key: 'cli', label: 'CLI', ico: '🖥️', group: 'advanced', env: [], setup: 'hermes gateway setup' },
];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 只取 .env 的键名，绝不读取/返回值 */
function envKeySet() {
  const keys = new Set();
  try {
    for (const line of fs.readFileSync(path.join(curHome(), '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) keys.add(m[1]);
    }
  } catch {}
  // 进程环境里显式设置的平台凭证也算（键名可能不在 .env 文件里）
  for (const p of PLATFORMS) for (const k of p.env) if (process.env[k]) keys.add(k);
  return keys;
}

/** 解析 config.yaml 的 platforms 段，只返回每个平台的 enabled 布尔与是否声明，不含任何值 */
function configPlatforms() {
  const out = {};
  let lines = [];
  try { lines = fs.readFileSync(path.join(curHome(), 'config.yaml'), 'utf8').split('\n'); } catch { return out; }
  let inside = false;
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (indent === 0) {
      if (text.startsWith('platforms:')) { inside = true; cur = null; continue; }
      if (inside) break;
      continue;
    }
    if (!inside) continue;
    if (indent <= 2 && text.includes(':')) {
      cur = text.split(':')[0].trim();
      out[cur] = { declared: true, enabled: true };
      const v = text.slice(text.indexOf(':') + 1).trim();
      if (v === 'false') out[cur].enabled = false;
      continue;
    }
    if (cur && /^enabled\s*:/.test(text)) out[cur].enabled = !/false/i.test(text);
  }
  return out;
}

function pidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

// profile 清单与摘要统一由 hermes-profile.js 提供（当前标记随桌面端切换变化）
const profileNames = () => profile.names();
const profileHome = (name) => profile.home(name);
const profileInfo = (name) => profile.info(name);

/** gateway_state.json 的 start_time 是内部时间单位（非标准 epoch），统一成可读字符串 */
function fmtTime(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 19).replace('T', ' ');
  let n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n > 1e14) n /= 1e9;        // ns → s
  else if (n > 1e12) n /= 1e3;   // ms → s
  else if (n > 1e10) n /= 100;   // gateway_state.json 的百分秒
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
}

/** 页面首屏数据（纯本地文件读取，毫秒级） */
function overview() {
  const state = readJson(path.join(curHome(), 'gateway_state.json')) || {};
  const life = readJson(path.join(curHome(), 'state', 'gateway.lifecycle.json')) || {};
  const envKeys = envKeySet();
  const cfg = configPlatforms();
  const running = pidAlive(state.pid) && !/stopped|exited|dead/i.test(String(life.phase || ''));

  const platforms = PLATFORMS.map((p) => {
    const declared = !!(cfg[p.key] && cfg[p.key].declared);
    const envConfigured = p.env.length > 0 && p.env.some((k) => envKeys.has(k));
    const configured = declared || envConfigured || p.env.length === 0;
    const enabled = declared ? cfg[p.key].enabled !== false : envConfigured;
    return {
      ...p,
      configured,
      enabled,
      hasCredentials: envConfigured,
      declared,
      missingEnv: p.env.filter((k) => !envKeys.has(k)),
      presentEnv: p.env.filter((k) => envKeys.has(k)),
    };
  });

  return {
    ok: true,
    hermesHome: curHome(),
    running,
    service: {
      pid: state.pid || null,
      kind: state.kind || life.phase || '',
      gatewayState: state.gateway_state || '',
      exitReason: state.exit_reason || life.exit_reason || '',
      startedAt: fmtTime(state.start_time || life.start_time || ''),
      updatedAt: fmtTime(state.updated_at || life.exited_at || ''),
      codeVersion: state.code_version || '',
      sessionStore: (state.session_store && state.session_store.status) || '',
      activeAgents: Array.isArray(state.active_agents) ? state.active_agents.length : 0,
    },
    platforms,
    profiles: profileNames().map(profileInfo),
    configuredCount: platforms.filter((p) => p.hasCredentials || p.declared).length,
    envFile: path.join(curHome(), '.env'),
    configFile: path.join(curHome(), 'config.yaml'),
  };
}

function run(args, timeout = 60000) {
  return new Promise((resolve) => {
    try {
      const p = spawn(HERMES_BIN, profile.cliArgs(args), { timeout, env: profile.env({ NO_COLOR: '1' }) });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('close', (code) => resolve({ ok: code === 0, code, output: (stdout + stderr).trim() }));
      p.on('error', (err) => resolve({ ok: false, error: String(err), output: '' }));
    } catch (err) { resolve({ ok: false, error: String(err), output: '' }); }
  });
}

/** 只允许白名单操作；start/stop/restart 会操作系统服务，UI 需二次确认 */
async function action(op) {
  if (!['start', 'stop', 'restart'].includes(op)) return { ok: false, error: '不支持的操作' };
  const r = await run(['gateway', op]);
  return { ...r, overview: overview() };
}

/** 状态文本（刷新按钮可选走 CLI，权威但慢） */
async function cliStatus() {
  const r = await run(['gateway', 'status'], 30000);
  return { ok: r.ok, text: r.output.split('\n').slice(0, 24).join('\n') };
}

module.exports = { overview, action, cliStatus, PLATFORMS, get HOME() { return curHome(); } };
