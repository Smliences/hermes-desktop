'use strict';
/**
 * hermes-diagnostics.js — 只读 CLI 诊断命令的统一通道
 *
 * 设计边界（与生产级要求对齐）：
 *   - 命令是**白名单常量**，渲染层只能传 key，不能传 argv；不接受任意 op / 参数。
 *   - 全部只读：memory status / status / doctor / fallback list / config check
 *     都不带 --fix / --live，不改写 ~/.hermes，不发真实网络探测。
 *   - 所有子进程经 resolveHermesBin() + profile.cliArgs()（恒定带 -p <name>），
 *     注入 profile.env() 与 NO_COLOR，带超时与输出上限。
 *   - 不做「不可靠结构化解析」：CLI 输出是给人看的文本，随版本会变。
 *     这里原样返回（转义由渲染层负责），只附带最少的元信息。
 */
const fs = require('fs');
const path = require('path');

const profile = require('./hermes-profile');
const { resolveHermesBin } = require('./hermes-bin');
const { runSpawn } = require('./hermes-exec');

const HERMES_BIN = process.env.HERMES_BIN || resolveHermesBin();
const MAX_OUTPUT = 12000;

/** key → argv（不含 -p 前缀）。新增命令必须显式登记，且必须是只读子命令。 */
const COMMANDS = Object.freeze({
  'memory:status': ['memory', 'status'],
  'status': ['status'],
  'doctor': ['doctor'],
  'fallback:list': ['fallback', 'list'],
  'config:check': ['config', 'check'],
});
// doctor 实测约 41s（枚举全部工具/环境，无网络探测），必须给足余量；
// 它是显式手动入口，不进「快速检查」。
const TIMEOUTS = Object.freeze({
  'memory:status': 20000, status: 20000, doctor: 60000,
  'fallback:list': 15000, 'config:check': 20000,
});

/** 串行队列：避免快速连点拉起多个 CLI 抢占同一 profile 的配置读取。 */
let queue = Promise.resolve();

/** 只认自有属性：`COMMANDS['__proto__']` 会命中 Object.prototype，
 *  若不做 hasOwnProperty 校验就可能把非数组对象交给 spawn。 */
function allowed(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, key)
    && Array.isArray(COMMANDS[key]) ? COMMANDS[key] : null;
}

async function runOnce(key) {
  const argv = allowed(key);
  if (!argv) return { ok: false, error: '不支持的诊断命令', text: '' };
  const args = profile.cliArgs(argv.slice());
  const r = await runSpawn(HERMES_BIN, args, {
    timeout: TIMEOUTS[key] || 15000,
    killGraceMs: 3000,
    hardGraceMs: 5000,
    maxOutput: MAX_OUTPUT,
    env: profile.env({ NO_COLOR: '1' }),
  });
  if (r.timedOut) {
    return { ok: false, code: -1, timedOut: true, text: '', error: '诊断命令超时', at: Date.now() };
  }
  const text = (r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''))
    .replace(/\r/g, '').slice(0, MAX_OUTPUT).trim();
  // 注意：doctor 发现「待办建议」时会返回退出码 1，但输出是完整的。
  // ok 只表示进程正常结束并给出了输出，不等于「配置完美无问题」。
  return { ok: r.code === 0, hasOutput: !!text, code: r.code, text, at: Date.now() };
}

/** 只读执行一个白名单诊断命令。非法 key 在 spawn 之前就被拒绝。 */
function run(key) {
  if (!allowed(key)) return Promise.resolve({ ok: false, error: '不支持的诊断命令', text: '' });
  const job = queue.then(() => runOnce(key), () => runOnce(key));
  queue = job.catch(() => {});
  return job;
}

/** 内置记忆文件的只读元信息（不读内容，避免把记忆正文带进渲染层）。
 *  CLI 的真实布局是 <profile home>/memories/MEMORY.md|USER.md，
 *  不是 home 根目录；写错会一律显示「尚未创建」。 */
function memoryFiles() {
  const dir = path.join(profile.home(), 'memories');
  const files = ['MEMORY.md', 'USER.md'];
  return files.map((name) => {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      return { name, path: file, exists: true, bytes: st.size, mtime: Math.round(st.mtimeMs) };
    } catch { return { name, path: file, exists: false, bytes: 0, mtime: 0 }; }
  });
}

module.exports = { run, memoryFiles, COMMANDS, MAX_OUTPUT, HERMES_BIN };
