'use strict';
/**
 * hermes-cron.js — 定时任务管理（CLI 是唯一真源）
 *
 * 设计边界（生产级）：
 *   - 全部经 `hermes -p <profile> cron …` 子进程，子命令白名单、execFile 无 shell、
 *     串行队列 + 超时 SIGKILL。渲染层只能传结构化字段，拿不到任意 argv。
 *   - `cron create` 默认加 `--paused`：新建任务不会立刻唤醒 agent 消耗额度，
 *     必须用户显式「恢复」。与市场安装的 --no-enable --no-deps 是同一套安全默认。
 *   - schedule / prompt / name 都过白名单并拒绝以 '-' 开头（argparse 会把这种
 *     positional 当成选项），拒绝控制字符；不做 shell，也不做字符串拼接。
 *   - `run` 会真实触发一次 agent 回合，`remove` 不可逆，`pause/resume` 改调度状态：
 *     四类写操作一律要求调用方先展示确认卡（服务层不判断 UI，但只放行固定 op）。
 *   - 写操作后回读 `cron list --all` 确认终态；回读失败返回 warning 而非假装失败。
 */
const { execFile } = require('child_process');
const profile = require('./hermes-profile');
const { resolveHermesBin } = require('./hermes-bin');
const log = require('./logger');

const HERMES_BIN = process.env.HERMES_BIN || resolveHermesBin();
const TIMEOUT_MS = 25000;
const MAX_OUTPUT = 64000;

/** uuid4().hex[:12]，兼容历史/自定义 id。 */
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
/** '30m' / 'every 2h' / '0 9 * * *' / '@daily'。 */
const SCHEDULE_RE = /^[A-Za-z0-9@][A-Za-z0-9 ,*/?#:@.-]{0,63}$/;
const ACTIONS = Object.freeze({ pause: 'pause', resume: 'resume', run: 'run', remove: 'remove' });
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

let queue = Promise.resolve();
function enqueue(job) {
  const p = queue.then(job, job);
  queue = p.catch(() => {});
  return p;
}
function strip(s) { return String(s || '').replace(ANSI_RE, ''); }

function exec(argv, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(killer); resolve(v); } };
    const killer = setTimeout(() => {
      if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
      finish({ ok: false, error: '命令超时', text: '' });
    }, timeout + 3000);
    try {
      child = execFile(HERMES_BIN, profile.cliArgs(argv), {
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        env: profile.env({ NO_COLOR: '1' }),
      }, (err, stdout, stderr) => {
        const text = strip(stdout).slice(0, MAX_OUTPUT);
        if (err) {
          const lines = strip(stderr).split('\n').map((x) => x.trim()).filter(Boolean);
          return finish({ ok: false, text, error: lines.length ? lines[lines.length - 1] : String(err.message).split('\n')[0] });
        }
        finish({ ok: true, text });
      });
      child.on('error', (e) => finish({ ok: false, text: '', error: String(e) }));
      if (child.stdin) child.stdin.end();
    } catch (e) {
      finish({ ok: false, text: '', error: String(e) });
    }
  });
}

/**
 * 解析 `cron list --all` 的分块输出：
 *   ┌ banner ┐
 *     <job_id> [active]
 *       Name:      xxx
 *       Schedule:  every 30m
 *       Next run:  2026-11-09…
 * 不做数值断言：CLI 文案/字段随版本变，缺字段就留空由 UI 兜底。
 */
function parseCronList(text) {
  const jobs = [];
  let cur = null;
  for (const raw of strip(text).split('\n')) {
    const line = raw.replace(/\r/g, '');
    const head = line.match(/^\s{2}([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})\s+\[(active|paused|disabled|completed)\]\s*$/);
    if (head) {
      cur = { id: head[1], state: head[2], fields: {} };
      jobs.push(cur);
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s{4}([A-Za-z][A-Za-z ]{0,15}):\s+(.*)$/);
    if (kv) cur.fields[kv[1].trim()] = kv[2].trim();
  }
  return jobs.map((j) => ({
    id: j.id,
    state: j.state,
    name: j.fields.Name || '（未命名）',
    schedule: j.fields.Schedule || '',
    repeat: j.fields.Repeat || '',
    nextRun: j.fields['Next run'] || j.fields.Overdue || '',
    deliver: j.fields.Deliver || '',
    lastRun: j.fields['Last run'] || '',
    workdir: j.fields.Workdir || '',
    skills: j.fields.Skills || '',
  }));
}

/** `cron status` 只取两个关键事实，其余原样交给 UI。 */
function parseCronStatus(text) {
  const t = strip(text);
  const host = t.match(/^\s*Scheduler host:\s*(.+)$/m);
  const beat = t.match(/^\s*Ticker heartbeat:\s*(.+)$/m);
  return {
    running: /✓\s*Gateway is running|cron jobs will fire automatically/i.test(t),
    notReady: /Scheduler is not ready/i.test(t),
    host: host ? host[1].trim() : '',
    heartbeat: beat ? beat[1].trim() : '',
    raw: t.slice(0, 4000),
  };
}

/** `<id>  <status>  job=<job_id>  source=<source>  <claimed_at>` + 缩进 error 行 */
function parseCronRuns(text) {
  const t = strip(text);
  const runs = [];
  for (const raw of t.split('\n')) {
    const m = raw.match(/^(\S+)\s+(\S+)\s+job=(\S+)\s+source=(\S+)\s+(.+)$/);
    if (m) runs.push({ id: m[1], status: m[2], jobId: m[3], source: m[4], at: m[5].trim(), error: '' });
    else if (runs.length && /^\s{4}\S/.test(raw)) {
      runs[runs.length - 1].error = raw.trim();
    }
  }
  return runs;
}

function validJobId(id) { return typeof id === 'string' && JOB_ID_RE.test(id); }
function validSchedule(s) { return typeof s === 'string' && SCHEDULE_RE.test(s) && !CONTROL_RE.test(s); }
function validText(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL_RE.test(v) && !v.startsWith('-');
}

/**
 * 一次拿齐面板首屏：任务列表（--all 含停用/已完成）、调度器状态、doctor 原文。
 * 整组作为一个作业入队，保证不会与写操作并发；组内三个命令都是只读，
 * 彼此并行（CLI 冷启动约 7s，串行三次会让首屏等 20s 以上）。
 */
function overview() {
  return enqueue(async () => {
    const [listRes, statusRes, doctorRes] = await Promise.all([
      exec(['cron', 'list', '--all']),
      exec(['cron', 'status']),
      exec(['cron', 'doctor']),
    ]);
    if (!listRes.ok) return { ok: false, error: listRes.error || '读取定时任务失败' };
    return {
      ok: true,
      jobs: parseCronList(listRes.text),
      status: parseCronStatus(statusRes.ok ? statusRes.text : ''),
      doctor: (doctorRes.ok ? doctorRes.text : (doctorRes.error || '')).slice(0, 4000),
      emptyHint: /No scheduled jobs/i.test(listRes.text),
      listRaw: listRes.text.slice(0, 6000),
    };
  });
}

/** 运行历史。limit 1–500，jobId 可空（查全部）。 */
function listRuns(jobId, limit = 20) {
  const id = jobId == null || jobId === '' ? null : String(jobId);
  if (id !== null && !validJobId(id)) return Promise.resolve({ ok: false, error: '非法任务 id' });
  const n = Number(limit);
  const safeLimit = Number.isFinite(n) ? Math.min(500, Math.max(1, Math.floor(n))) : 20;
  return enqueue(async () => {
    const argv = ['cron', 'runs'];
    if (id) argv.push(id);
    argv.push('--limit', String(safeLimit));
    const r = await exec(argv);
    if (!r.ok) return { ok: false, error: r.error || '读取运行历史失败' };
    return { ok: true, runs: parseCronRuns(r.text), raw: r.text.slice(0, 6000) };
  });
}

/** pause / resume / run / remove；op 白名单，其余一律拒绝。 */
function action(op, jobId) {
  const cmd = ACTIONS[op];
  if (!cmd) return Promise.resolve({ ok: false, error: '不支持的操作' });
  if (!validJobId(jobId)) return Promise.resolve({ ok: false, error: '非法任务 id' });
  return enqueue(async () => {
    const r = await exec(['cron', cmd, jobId], { timeout: cmd === 'run' ? 60000 : TIMEOUT_MS });
    if (!r.ok) return { ok: false, error: r.error || '操作失败', raw: r.text.slice(0, 2000) };
    if (/^Failed to /m.test(r.text)) return { ok: false, error: r.text.trim().split('\n')[0], raw: r.text.slice(0, 2000) };
    return await readBack(cmd, r.text);
  });
}

/**
 * 创建任务。默认 --paused（安全默认），--name 可选，prompt 可选。
 * 返回回读后的真实任务列表，UI 不自行插入乐观数据。
 */
function create({ schedule, prompt = '', name = '', paused = true } = {}) {
  if (!validSchedule(schedule)) return Promise.resolve({ ok: false, error: '调度表达式不合法' });
  if (prompt !== '' && !validText(prompt, 4000)) return Promise.resolve({ ok: false, error: '任务内容不合法（过长、含控制字符或以 - 开头）' });
  if (name !== '' && !validText(name, 80)) return Promise.resolve({ ok: false, error: '任务名称不合法' });
  return enqueue(async () => {
    const argv = ['cron', 'create', schedule];
    if (prompt) argv.push(prompt);
    if (name) argv.push('--name', name);
    argv.push('--paused');   // 恒为暂停：不因渲染层传参而变成「创建即跑」
    void paused;
    const r = await exec(argv);
    if (!r.ok) return { ok: false, error: r.error || '创建失败', raw: r.text.slice(0, 2000) };
    if (/Failed to create job/m.test(r.text)) return { ok: false, error: r.text.trim().split('\n')[0], raw: r.text.slice(0, 2000) };
    return await readBack('create', r.text);
  });
}

async function readBack(verb, outText = '') {
  const after = await exec(['cron', 'list', '--all']);
  if (!after.ok) {
    log.warn('cron', 'readback failed', { verb, error: log.redact(after.error || '') });
    return { ok: true, warning: `${verb} 已执行，但回读列表失败，请点刷新`, jobs: null, raw: outText.slice(0, 2000) };
  }
  return {
    ok: true,
    jobs: parseCronList(after.text),
    emptyHint: /No scheduled jobs/i.test(after.text),
    listRaw: after.text.slice(0, 6000),
    raw: outText.slice(0, 2000),
  };
}

module.exports = {
  overview, listRuns, action, create,
  parseCronList, parseCronStatus, parseCronRuns,
  validJobId, validSchedule, validText, ACTIONS,
};
