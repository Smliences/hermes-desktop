'use strict';
/* ═══════════ Hermes Desktop Client — renderer 主逻辑（dsh web 风格） ═══════════ */
/* global hermesAPI */

/* ══════════ 工具行 ══════════
   直接照搬运 WorkBuddy 的 single-line-tool-header：一行五段
     [图标 14px] [状态词] [对象] [次要信息] [箭头 16px]
   拦包看过它的实现（renderer/assets/src-*.css + i18n 的 tool.* 表），要点：
   · 状态词不是一个泛泛的「完成」，每类工具各有一套三态词（读取 / 已读取 / 读取失败）；
   · 运行中的状态词走渐变扫光（background-clip:text + 2.2s 线性往复），不是转圈图标；
   · 箭头默认朝右（rotate(-90deg)），展开转正朝下；WorkBuddy 里 hover 才显，这里改成常显；
   · 折叠只切 card-content 的 hidden，行本身不做动画。
   图标按工具类型分（读/写/命令/搜索/列表/网页/生成/派发/清单/记忆），lucide 线性字形。 */
const TOOL_ICONS = {
  read: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"></circle><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"></circle></svg>',
  write: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.1 2.4a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5 2.4 13.4l.9-3.2Z"></path><path d="M9.9 3.6a1.6 1.6 0 0 1 2.3 2.3"></path></svg>',
  create: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.4 2.1H4.6c-.8 0-1.5.7-1.5 1.5v8.8c0 .8.7 1.5 1.5 1.5h6.8c.8 0 1.5-.7 1.5-1.5V5.6Z"></path><path d="M9.3 2.2v3.5h3.6"></path><path d="M8 8.1v3.4M6.3 9.8h3.4"></path></svg>',
  cmd: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.7" width="12.4" height="10.6" rx="2.1"></rect><path d="M4.9 6.4 6.5 8 4.9 9.6"></path><path d="M8.4 9.9h2.4"></path></svg>',
  list: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.4 4.2h8.2M5.4 8h8.2M5.4 11.8h8.2"></path><path d="M2.4 4.2h.6M2.4 8h.6M2.4 11.8h.6"></path></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.2" cy="7.2" r="4.9"></circle><path d="m10.9 10.9 2.6 2.6"></path></svg>',
  web: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"></circle><path d="M1.9 8h12.2"></path><path d="M8 1.8c1.7 1.9 2.6 4 2.6 6.2S9.7 12.3 8 14.2C6.3 12.3 5.4 10.2 5.4 8S6.3 3.7 8 1.8Z"></path></svg>',
  gen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 1.9 1.5 4 4 1.5-4 1.5L8 12.9l-1.5-4-4-1.5 4-1.5Z"></path><path d="M12.6 11.4l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7Z"></path></svg>',
  dispatch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.2 1.8 7 9M14.2 1.8 9.6 14.2l-2.6-5.2L1.8 6.4Z"></path></svg>',
  todo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.6 4.1h7.2M6.6 8h7.2M6.6 11.9h7.2"></path><path d="m2.1 4 1.1 1.1 1.9-2M2.1 8l1.1 1.1L5.1 7"></path></svg>',
  memory: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="8" cy="4" rx="5.6" ry="2.2"></ellipse><path d="M2.4 4v8c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2V4"></path><path d="M2.4 8c0 1.2 2.5 2.2 5.6 2.2s5.6-1 5.6-2.2"></path></svg>',
  ask: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.8 7.3c0 3-2.6 5.4-5.8 5.4-.8 0-1.6-.1-2.3-.4L2.2 13.4l1.2-3a5 5 0 0 1-1-3.1C2.4 4.3 5 1.9 8.2 1.9s5.6 2.4 5.6 5.4Z"></path><path d="M6.3 6.6a1.8 1.8 0 1 1 2.4 1.7c-.4.2-.6.5-.6.9M8 11h.01"></path></svg>',
  unknown: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"></circle><path d="M8 11.2h.01M6.5 6.2a1.6 1.6 0 1 1 2.2 1.5c-.3.1-.5.5-.5.8"></path></svg>',
};
/* 每类工具的三态词，照 WorkBuddy i18n 的 tool.* 表逐条对：它是
   「动作 / 已动作 / 失败了」三种说法，而不是一个笼统的完成态。 */
const TOOL_SPECS = [
  { re: /^(read_file|view_file|cat|skill_view|skills_list|drive_preview|desktop_preview|session_search)/,
    kind: 'read', running: '读取', done: '已读取', error: '读取失败' },
  { re: /^(write_file|apply_layout|annotate_preview)/,
    kind: 'create', running: '生成中', done: '创建', error: '生成失败' },
  { re: /^(patch|edit_file|multi_edit)/,
    kind: 'write', running: '编辑中', done: '编辑', error: '修改失败' },
  { re: /^(terminal|bash|shell|exec_command|run_command|execute_code|process_manage|cronjob_manage)/,
    kind: 'cmd', running: '执行中…', done: '运行成功', error: '执行失败' },
  { re: /^(glob|find_files)/,
    kind: 'search', running: '搜索中', done: '搜索文件', error: '搜索失败' },
  { re: /^(grep|search_files|rg)/,
    kind: 'search', running: '搜索中', done: '搜索文件内容', error: '搜索失败' },
  { re: /^(list_files|ls|tree)/,
    kind: 'list', running: '列出中', done: '已列出', error: '读取失败' },
  { re: /^(web_search|x_search|search_web)/,
    kind: 'web', running: '搜索网页中…', done: '搜索网页', error: '搜索失败' },
  { re: /^(web_fetch|web_extract|http_request|fetch_url)/,
    kind: 'web', running: '读取中', done: '读取网页内容', error: '读取失败' },
  { re: /^browser_/,
    kind: 'web', running: '操作浏览器中', done: '已操作浏览器', error: '浏览器操作失败' },
  { re: /^(image_generate|video_generate|text_to_speech)/,
    kind: 'gen', running: '生成中', done: '已生成', error: '生成失败' },
  { re: /^(vision_analyze|video_analyze)/,
    kind: 'read', running: '分析中', done: '已分析', error: '分析失败' },
  { re: /^(delegate_task|subagent)/,
    kind: 'dispatch', running: '派发中', done: '已派发', error: '派发失败' },
  { re: /^(todo_list|todo_write|update_plan)/,
    kind: 'todo', running: '更新计划中', done: '已更新计划', error: '计划处理失败' },
  { re: /^(memory|memory_store)/,
    kind: 'memory', running: '写入记忆中', done: '已更新记忆', error: '记忆操作失败' },
  { re: /_(ask|question|confirm)$|^ask/,
    kind: 'ask', running: '等待你的回答…', done: '已回答', error: '提问失败' },
];
const TOOL_SPEC_FALLBACK = { kind: 'unknown', running: '执行中', done: '已完成', error: '执行失败' };
/** 对象：这次调用最该被看见的那个参数（文件名取末段、命令取首行、搜索取关键词） */
function toolObject(input) {
  if (!input || typeof input !== 'object') return '';
  const f = input.file_path || input.path || input.filename || input.notebook_path;
  const c = input.command || input.cmd || input.script;
  const q = input.query || input.pattern || input.url || input.skill || input.topic || input.action;
  let obj = '';
  if (f) obj = String(f).split('/').filter(Boolean).pop() || String(f);
  else if (c) obj = String(c).split('\n')[0].replace(/\s+/g, ' ').trim();
  else if (q) obj = String(q).replace(/\s+/g, ' ').trim();
  return obj.length > 60 ? obj.slice(0, 60) + '…' : obj;
}
/** 次要信息：编辑类的增删行数（WorkBuddy 的 +7 −0 就是这一格），其余留空 */
function toolExtra(name, input) {
  if (!input || typeof input !== 'object') return null;
  if (Array.isArray(input.edits) && input.edits.length) return { text: `${input.edits.length} 处修改` };
  const o = input.old_string, n = input.new_string;
  if (typeof o === 'string' && typeof n === 'string') {
    const rows = lineDiff(o, n);
    let add = 0, del = 0;
    for (const r of rows) { if (r.t === '+') add++; else if (r.t === '-') del++; }
    return { add, del };
  }
  return null;
}
/** state: 'running' | 'done' | 'error' —— 三种状态换的是词，不是图标颜色 */
function toolMeta(name, input, state) {
  const n = String(name || '');
  const spec = TOOL_SPECS.find((s) => s.re.test(n)) || TOOL_SPEC_FALLBACK;
  const label = state === 'running' ? spec.running : state === 'error' ? spec.error : spec.done;
  return { icon: TOOL_ICONS[spec.kind] || TOOL_ICONS.unknown, label, obj: toolObject(input), extra: toolExtra(n, input), kind: spec.kind };
}
/** 行级 diff（LCS 回溯）：patch 的 old/new 通常十几行，O(n·m) 足够；
    超过 400×400 就退化成「整段删 + 整段增」，不为超大文件构造表格。 */
function lineDiff(oldText, newText) {
  const A = String(oldText == null ? '' : oldText).split('\n');
  const B = String(newText == null ? '' : newText).split('\n');
  const n = A.length, m = B.length;
  if (n * m > 160000) {
    return [...A.map((s) => ({ t: '-', s })), ...B.map((s) => ({ t: '+', s }))];
  }
  // 从右下角倒推公共子序列长度；Uint16 足够（单文件不会超过 65535 行）
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', s: A[i] }); i++; }
    else { out.push({ t: '+', s: B[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', s: A[i++] });
  while (j < m) out.push({ t: '+', s: B[j++] });
  return out;
}
/** WB 的 diff-viewer：一行一条，左侧 16px 竖条（增绿减红），行号条不画，
    行高 18px 与它的 12px×1.5 一致。超过 400 行截断并提示，不塞满 DOM。 */
function toolDiffHTML(oldText, newText) {
  const rows = lineDiff(oldText, newText);
  const CAP = 400;
  const shown = rows.length > CAP ? rows.slice(0, CAP) : rows;
  const body = shown.map((r) => {
    const cls = r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'same';
    const glyph = r.t === '+' ? '+' : r.t === '-' ? '−' : '';
    return `<div class="dv-row ${cls}"><span class="dv-g">${glyph}</span><span class="dv-t">${esc(r.s) || '&nbsp;'}</span></div>`;
  }).join('');
  const more = rows.length > CAP
    ? `<div class="dv-more">还有 ${rows.length - CAP} 行未显示</div>` : '';
  return `<div class="dv">${body}${more}</div>`;
}
/** 命令类：WB 的 .execute-command .stdout-content —— 详情里只有输出本身，
    不在详情里重复一遍命令行（命令已经在上面那行里了），无底色无描边。 */
function toolStdoutHTML(item) {
  const out = item.output == null ? '' : String(item.output);
  const fail = !!item.isError;
  // 跑着的命令会自动展开（要让人看到这一步在干什么），但此刻还没有任何输出：
  // 不能写成「运行成功」，也不摆一个只有「执行中…」的空盒子 —— 行上和详情头
  // 已经各说过一次状态了。详情里就只留那一行头。
  if (!out.trim()) {
    if (item.state === 'running') return '';
    return `<div class="stdout-content"><span class="exec-status-text${fail ? ' err' : ''}">${fail ? '执行失败' : '运行成功'}</span></div>`;
  }
  return `<div class="stdout-content"><pre class="content${fail ? ' err-text' : ''}">${esc(clip(out, 20000))}</pre></div>`;
}
/** 详情内容：照 WB 的三个渲染器分流，而不是一套 JSON 走天下 ——
    · 编辑类（patch/写文件）→ diff（WB 的 diff-viewer，绿增红删 + 竖条）
    · 命令类（terminal/bash）→ 整块 stdout（WB 的 ExecuteCommandRenderer）
    · 其余 → Arguments / Result 两段格式化 JSON（WB 的 DefaultToolRenderer）
    段结构沿用 WB：.detail-section > .detail-label + .detail-content（pre）。 */
function toolDetailHTML(item) {
  const name = String(item.name || '');
  const input = item.input;
  const isEdit = /^(patch|edit_file|multi_edit|apply_layout|annotate_preview)/.test(name);
  const isWrite = /^write_file/.test(name);
  const isCmd = /^(terminal|bash|shell|exec_command|run_command|execute_code|process_manage|cronjob_manage)/.test(name);
  const sec = (label, body) =>
    `<div class="detail-section"><div class="detail-label">${esc(label)}</div>${body}</div>`;

  if (isCmd) {
    const cmd = input && typeof input === 'object' ? String(input.command || input.cmd || input.script || '') : '';
    const cmdHtml = cmd.trim() ? sec('命令', `<pre class="detail-content">${esc(clip(cmd, 8000))}</pre>`) : '';
    return cmdHtml + toolStdoutHTML(item);
  }

  let html = '';
  if (isEdit && input && typeof input === 'object') {
    if (Array.isArray(input.edits) && input.edits.length) {
      html += input.edits.map((e, i) => sec(`修改 ${i + 1}/${input.edits.length}`,
        toolDiffHTML(e && e.old_string, e && e.new_string))).join('');
    } else if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
      html += sec('改动', toolDiffHTML(input.old_string, input.new_string));
    }
  } else if (isWrite && input && typeof input.content === 'string') {
    html += sec('新内容', toolDiffHTML('', input.content));
  }
  // 参数：没走 diff 的工具才铺参数，且用格式化 JSON（WB 的 DefaultToolRenderer 就是
  // JSON.stringify(args, null, 2)）—— 上一版的两列键值虽然好读，但不是 WB 的形态。
  if (!html && input != null && input !== '') {
    html += sec('参数', `<pre class="detail-content">${esc(clip(safeStringify(input), 12000))}</pre>`);
  }
  if (item.output != null) {
    const out = String(item.output);
    if (out.trim()) {
      html += sec('输出', `<pre class="detail-content${item.isError ? ' err-text' : ''}">${esc(clip(out, 20000))}</pre>`);
    }
  }
  return html;
}
/** 从错误文本里提取 mono 状态胶囊（如 MISSING_CREDENTIAL / exit=1） */
function errorCodeOf(text) {
  const m = String(text).match(/\b([A-Z][A-Z_]{4,})\b/);
  if (m) return m[1];
  const e = String(text).match(/退出码\s*(\d+)|exit(?:_code)?[=:]\s*(\d+)/i);
  if (e) return `EXIT ${e[1] || e[2]}`;
  return 'ERROR';
}

/* ---------- 失败轮次：把 CLI 的占位英文还原成可读的结构化错误 ----------
 * 后端在请求失败时会补写一条 display_kind='failed_turn' 的助手消息，正文恒为
 * "Your request was not processed…"，真实原因在 display_metadata.error_surface。
 * 旧版投影没把这两列带出来，界面只能显示「请重发」，而上游往往标记 retryable=false。 */
function parseFailure(raw, fallback) {
  let md = raw;
  if (typeof md === 'string') { try { md = md ? JSON.parse(md) : {}; } catch { md = {}; } }
  if (!md || typeof md !== 'object') md = {};
  const s = (md.error_surface && typeof md.error_surface === 'object') ? md.error_surface : {};
  const err = String(md.error || '').trim();
  const text = err || String(fallback || '').trim() || '上游未返回可用回复';
  return {
    error: text,
    http: (text.match(/HTTP\s*(\d{3})/i) || [])[1] || '',
    code: String(s.code || ''),
    layer: String(s.layer || ''),
    provider: String(s.provider || s.provider_label || ''),
    model: String(s.model || ''),
    retryable: typeof s.retryable === 'boolean' ? s.retryable : null,
    raw: [typeof raw === 'string' ? raw.trim() : JSON.stringify(md, null, 2),
      err && fallback ? `占位回复：${String(fallback).trim()}` : ''].filter(Boolean).join('\n\n') || text,
  };
}
/** 依据上游错误给出可执行的下一步，而不是笼统的「再发一次」。 */
function failureHint(f, sameModel) {
  const e = String(f.error || '').toLowerCase();
  if (/model is unavailable|model.*not found|unknown model|does not exist|no such model/.test(e))
    return sameModel
      ? '这个会话绑定的模型名已不可用，且应用当前也选中了它。请先切换模型再重试。'
      : '这个会话绑定的模型名已不可用（常见于旧会话沿用了旧模型）。请先切换模型再重试，或新建一个会话。';
  if (/api key|unauthorized|401|expired|credential|凭据/.test(e))
    return '上游凭据无效或已过期，请检查 API key 配置后再试。';
  if (/403|forbidden|permission|not allowed|仅限/.test(e))
    return '上游拒绝了本次请求（权限或客户端限制），重复发送同一条消息通常无效。';
  if (/402|quota|insufficient|额度|余额|credit|payment/.test(e))
    return '账户额度或余额不足，请先检查额度再试。';
  if (/429|rate limit|限流|too many requests/.test(e))
    return '触发限流，稍等片刻再重试。';
  if (/timed? out|timeout|connection|network|econn|unreachable/.test(e))
    return '网络或超时问题，可稍后重试。';
  if (f.retryable === false)
    return '上游判定此错误不可重试，重复发送同一条消息仍会失败；建议先调整模型或配置。';
  return '请核对上方错误与当前模型配置；需要继续时，可切换模型后重试。';
}
function failureHTML(f) {
  const meta = [
    f.model ? ['模型', f.model] : null,
    f.provider ? ['提供方', f.provider] : null,
    f.code ? ['错误码', f.code] : null,
    f.layer ? ['层级', f.layer] : null,
    f.retryable === false ? ['可重试', '否'] : (f.retryable === true ? ['可重试', '是'] : null),
  ].filter(Boolean);
  const badge = f.http ? `HTTP ${f.http}` : (f.code || 'FAILED');
  // 桌面端 config.json 会覆盖 CLI 的 config.yaml 默认模型；若两者都是失效模型，
  // 用户「新建会话再发」也一样失败，必须在卡里直接点破。
  const sameModel = !!(f.model && typeof state !== 'undefined' && state.config && f.model === state.config.model);
  return `<div class="err-card">
    <div class="err-head"><span class="e-dot"></span><b>本轮未获得模型回复</b><span class="e-badge">${esc(badge)}</span></div>
    <p class="err-msg">${esc(clip(f.error, 600))}</p>
    ${meta.length ? `<div class="err-meta">${meta.map(([k, v]) =>
      `<span class="err-chip"><span>${esc(k)}</span><code>${esc(clip(v, 80))}</code></span>`).join('')}</div>` : ''}
    <p class="err-hint">${esc(failureHint(f, sameModel))}</p>
    ${sameModel ? `<p class="err-hint err-same">当前应用选择的模型也是 <code>${esc(f.model)}</code>，新建会话同样会失败；请先切换模型。</p>` : ''}
    <div class="err-actions">
      <button type="button" class="err-btn primary" data-err-act="model">切换模型</button>
      <button type="button" class="err-btn" data-err-act="retry">用当前模型重试</button>
      <button type="button" class="err-btn ghost" data-err-act="detail">查看原始错误</button>
    </div>
    <pre class="err-raw" hidden>${esc(clip(f.raw, 4000))}</pre>
  </div>`;
}

/* ---------- 状态 ---------- */
const state = {
  tabs: [], activeTabId: null, view: 'chat',
  turnTab: new Map(),
  invalidTurns: new Set(),   // 已中止回合的 turnId：延迟到达的事件直接丢弃
  env: null, config: { model: '', reasoning: 'none', yolo: false },
  sessions: [], sendHistory: [], histIdx: -1, histDraft: '', histBrowsing: false,
  projectsTree: [],         // 侧栏项目树投影（/api/profiles/projects/tree，降级为 []）
  projectsTreeOk: false,    // 树请求是否成功；后端冷启慢于首屏时由 ensureSidebarTree 重试
  booted: false,            // 会话列表是否已成功落地过一次（false = 首屏骨架 + 后端启动提示）
  bootError: '',            // 首屏拉取失败的原因（骨架里显示，便于区分「慢」和「挂了」）
  attachments: [],           // [{ path, name, kind }] 本回合待附加的本地文件
};
const hasNative = typeof hermesAPI !== 'undefined';
const api = hasNative ? hermesAPI : window.__mockAPI;

function syncApprovalModeFromSettings() {
  if (typeof settingsRead !== 'function') return;
  const apMode = settingsRead().approvalMode;
  if (apMode === undefined) return;
  const wantYolo = apMode === '自动批准全部';
  if (!!state.config.yolo !== wantYolo) {
    state.config.yolo = wantYolo;
    if (hasNative && api.setConfig) api.setConfig({ yolo: wantYolo });
  }
}
function newTab(sessionId = null, title = '新会话', silent = false) {
  if (!sessionId) syncApprovalModeFromSettings();
  const tab = { id: 'tab_' + uid(), sessionId, title, model: '', running: false, items: [], startedAt: 0, lastResult: null, deltas: 0 };
  state.tabs.push(tab);
  setActiveTab(tab.id, silent);
  return tab;
}
function activeTab() { return state.tabs.find((t) => t.id === state.activeTabId); }
function setActiveTab(id, silent) {
  const prev = activeTab();
  // 400ms 草稿防抖定时器在切页签后 firing 会用「新页签」的 key 保存输入框内容；
  // 这里先取消，再由下面针对旧页签的显式 saveDraftFor(prev) 落地正确归属。
  const inp = $('#input');
  if (inp && inp._draftTimer) { clearTimeout(inp._draftTimer); inp._draftTimer = null; }
  if (prev && prev.id !== id && typeof saveDraftFor === 'function') saveDraftFor(prev);
  state.activeTabId = id; state.view = 'chat';
  const _cur = state.tabs.find((x) => x.id === id);
  if (_cur) _cur.unread = false;
  const _sc = $('#chat-scroll');
  if (_sc) _sc._userScrolledAway = false;
  closeSubpages();
  document.querySelectorAll('.vt').forEach((b) => b.classList.toggle('active', b.dataset.view === 'chat'));
  renderTabs(); renderChat(); renderSessions(); updateStatus();
  if (typeof renderAttach === 'function') renderAttach();
  if (typeof renderQueue === 'function') renderQueue();
  syncComposerProject(); // 项目下拉按当前页签的 cwd 回填
  if (typeof restoreDraftFor === 'function') restoreDraftFor(state.tabs.find((x) => x.id === id));
  if (!silent && hasNative) api.tabState(id).then((st) => {
    // 必须按发起请求的 tabId 落地：A→B 快速切换时，A 的响应不能写进 B
    const t = state.tabs.find((x) => x.id === id);
    if (t && st && st.sessionId && !t.sessionId) {
      t.sessionId = st.sessionId;
      if (t.id === state.activeTabId) updateStatus();
    }
  }).catch(() => {});
}
function closeTab(id) {
  const i = state.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tab = state.tabs[i];
  if (tab._rafText) { cancelAnimationFrame(tab._rafText); tab._rafText = 0; }
  for (const [tid, tb] of state.turnTab) {
    if (tb === id) state.turnTab.delete(tid);
  }
  if (hasNative && api.abort) api.abort(id, { close: true });
  state.tabs.splice(i, 1);
  if (!state.tabs.length) newTab();
  else if (state.activeTabId === id) setActiveTab(state.tabs[Math.max(0, i - 1)].id);
}

/* ---------- 渲染：标题 / 会话列表 ---------- */
function renderTabs() {
  const tab = activeTab();
  const tEl = $('#chat-title'); if (tEl) tEl.textContent = tab ? (tab.running ? '◷ ' : '') + tab.title : '';
}

/** 搜索词高亮（只标第一处，输出安全 HTML） */
function hlMark(text, q) {
  const t = String(text || '');
  if (!q) return esc(t);
  const i = t.toLowerCase().indexOf(String(q).toLowerCase());
  if (i < 0) return esc(t);
  return esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
}
/** 侧栏搜索框当前词：会话菜单、看板写后刷新、项目树启动自愈共用（全局，勿塞进某个函数作用域） */
function currentSearch() { const el = $('#session-search'); return el ? el.value.trim() : ''; }
/** 侧栏只认用户显式创建的项目。auto 项目是 CLI 按历史会话 cwd/git 根动态推导的
 *  （.hermes / bin / memories / .pi 这类），Home 桶也不渲染。
 *  过滤必须发生在树落地时：认领会话排除集合与项目分组共用同一份数据，
 *  否则被 auto 项目认领的会话既不在分组里、也不会回到时间分组。 */
function sidebarProjectNodes(projects) {
  return (Array.isArray(projects) ? projects : [])
    .filter((p) => p && p.id && !p.isNoProject && !p.isAuto);
}
/** 会话列表：标题 + 消息全文命中合并（FTS5 由主进程提供，几十毫秒） */
let sessionsSeq = 0;
async function refreshSessions(search = '') {
  const seq = ++sessionsSeq;
  const q = String(search || '').trim();
  // 项目树与列表并行：项目归组失败不拖累会话列表本身（只降级成纯时间分组）
  // 只看通道是否存在：浏览器 Demo 桥也实现了 projectsTree，别用 hasNative 把它挡在门外
  const treeP = (typeof api.projectsTree === 'function')
    ? Promise.resolve(api.projectsTree({ previewLimit: 3 })).catch(() => null)
    : Promise.resolve(null);
  try {
    const [allR, treeR] = await Promise.all([api.listSessions({ limit: 200, search: q }), treeP]);
    const all = arr(allR);
    let hits = [];
    if (q && typeof api.searchMessages === 'function') {
      try { hits = arr(await api.searchMessages(q)); } catch (e) { console.warn('fts', e); }
    }
    // 搜索是高频输入：只接受最新一次请求的结果，避免后发先至把列表刷回旧结果
    if (seq !== sessionsSeq) return;
    const hitMap = new Map(hits.filter((h) => h && h.id).map((h) => [h.id, h]));
    const ql = q.toLowerCase();
    const merged = all.map((s) => ({ ...s, snippet: (hitMap.get(s.id) || {}).snippet || '', fulltext: hitMap.has(s.id) }));
    if (q && hits.length) {
      const seen = new Set(all.map((s) => s.id));
      for (const h of hits) {
        if (!h || !h.id || seen.has(h.id)) continue;
        seen.add(h.id);
        merged.push({
          id: h.id,
          title: h.title || h.id,
          started_at: h.started_at || 0,
          ended_at: h.ended_at || 0,
          snippet: h.snippet || '',
          fulltext: true,
        });
      }
    }
    state.sessions = merged
      .filter((s) => !q || sessionLabel(s).toLowerCase().includes(ql) || String(s.id).toLowerCase().includes(ql) || s.fulltext)
      .slice(0, 80);
    // 后端冷启（CLI 常要 5~12s）会晚于首屏：树请求失败时保留上一次的分组，不把侧栏刷空，
    // 并用 projectsTreeOk 标记给启动自愈判断是否还要重试。成功才覆盖树。
    if (treeR && treeR.ok) {
      state.projectsTree = sidebarProjectNodes(treeR.projects);
      state.projectsTreeOk = true;
    } else {
      state.projectsTreeOk = false;
    }
    syncComposerProject(); // 树刷新后同步候选（冷启自愈落地时也走这里）
    // 有数据 = 后端确实答了话，首屏可以收骨架；空列表则等连接状态或下一次重试来确认。
    // 这里不调 bootSettled()：它会再补拉一次列表，而本次结果就是最新的。
    if (state.sessions.length && !state.booted) {
      state.booted = true;
      bootRetry = 0;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    }
    state.bootError = '';
    renderSessions(q);
    if (!state.booted) ensureSidebarBoot();
  } catch (e) {
    state.projectsTreeOk = false;
    state.bootError = (e && e.message) || '会话列表读取失败';
    console.warn('sessions', e);
    if (!state.booted) { renderSessions(currentSearch()); ensureSidebarBoot(); }
  }
}
/** 后端冷启（gateway 常需 5~12s）会晚于首屏：树接口失败时按退避重试，直到项目分组落地。
 *  独立拉树、成功即落地并重绘侧栏，不与会话列表的并发代次（sessionsSeq）互相拖累。 */
let sidebarTreeRetry = 0;
function ensureSidebarTree() {
  if (typeof api.projectsTree !== 'function') return;
  if (state.projectsTreeOk) { sidebarTreeRetry = 0; return; }
  if (sidebarTreeRetry >= 10) return;
  const n = ++sidebarTreeRetry;
  setTimeout(async () => {
    if (state.projectsTreeOk) { sidebarTreeRetry = 0; return; }
    let r = null;
    try { r = await api.projectsTree({ previewLimit: 3 }); } catch {}
    if (r && r.ok) {
      state.projectsTree = sidebarProjectNodes(r.projects);
      state.projectsTreeOk = true;
      sidebarTreeRetry = 0;
      try { renderSessions(currentSearch()); syncComposerProject(); } catch {}
      return;
    }
    ensureSidebarTree();
  }, Math.min(1000 + n * 800, 3500));
}
/* ---------- 窗口重新获得焦点：补齐「后端侧发生的变化」 ----------
   项目树与会话列表只在启动和本地操作后刷新，终端里 `hermes project create`、
   或别的窗口新建的会话，切回来是看不到的。聚焦补一次，但要防抖（避免切来切去
   反复重建列表）并保住滚动位置。 */
const FOCUS_REFRESH_MS = 6000;
// 启动时的首屏刷新算作一次，别让紧接着的 focus 立刻再拉一遍
let lastFocusRefresh = Date.now();
let focusRefreshBusy = false;
function refreshOnFocus() {
  if (document.hidden) return;
  const now = Date.now();
  if (focusRefreshBusy || (lastFocusRefresh && now - lastFocusRefresh < FOCUS_REFRESH_MS)) return;
  lastFocusRefresh = now;
  focusRefreshBusy = true;
  const ul = $('#session-list');
  const top = ul ? ul.scrollTop : 0;
  Promise.resolve(refreshSessions(currentSearch()))
    .catch(() => {})
    .then(() => {
      // renderSessions 重建了整个列表，滚动位置要还回去（越界时浏览器会自己夹住）
      if (ul) ul.scrollTop = top;
      focusRefreshBusy = false;
      ensureSidebarTree();
    });
}
/* ---------- 首屏启动骨架 ----------
   CLI 冷启要 5~7.5s、gateway 10~15s，而首屏一开始就 await 会话列表：这段时间侧栏
   是一片空白，看起来像「没有历史会话」而不是「还在启动」。这里在列表区先铺骨架 + 一句
   状态说明，等后端真的可用（或列表已带回数据）再收掉；期间按退避重试拉列表，
   因为「后端还没起来」和「真的一条会话都没有」在界面上必须是两种东西。 */
let bootRetry = 0;
let bootTimer = null;
function bootSettled() {
  if (state.booted) return;
  state.booted = true;
  state.bootError = '';
  bootRetry = 0;
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  try { renderSessions(currentSearch()); } catch {}
  // 骨架收起后补拉一次：后端刚 ready 的那一刻，列表可能还是上一次的失败结果
  try { refreshSessions(currentSearch()).catch(() => {}); } catch {}
}
function ensureSidebarBoot() {
  if (state.booted || currentSearch()) return;
  if (bootRetry >= 12) {
    // 约 30s 还没答案就停下：一直转下去比承认「慢」更像卡死
    if (!state.bootError) {
      state.bootError = '后端启动超时';
      try { renderSessions(currentSearch()); } catch {}
    }
    return;
  }
  const n = ++bootRetry;
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = setTimeout(async () => {
    bootTimer = null;
    if (state.booted) return;
    try { await refreshSessions(currentSearch()); } catch {}
  }, Math.min(1200 + n * 500, 3000));
}
/** 骨架里的两行文案：慢、断开、超时是三种情况，不能都写成「正在启动」。 */
function bootCopy() {
  if (!state.bootError) return ['正在启动本地后端…', '首次启动要拉起 hermes serve，通常 5–15 秒'];
  if (state.bootError === '后端启动超时') return ['后端启动较慢', '仍在等待；可点左下角状态点重连，或稍后再试'];
  return ['后端未连接', '桌面端会自动重试，也可以点左下角状态点手动重连'];
}
function renderSidebarSkeleton(ul) {
  const [title, sub] = bootCopy();
  const head = document.createElement('li');
  head.className = 's-boot';
  head.setAttribute('role', 'presentation');
  const t = document.createElement('span');
  t.className = 's-boot-title';
  t.textContent = title;
  const s = document.createElement('span');
  s.className = 's-boot-sub';
  s.textContent = sub;
  head.append(t, s);
  ul.appendChild(head);
  for (let i = 0; i < 4; i++) {
    const li = document.createElement('li');
    li.className = 's-skel';
    li.setAttribute('role', 'presentation');
    li.setAttribute('aria-hidden', 'true');
    // 逐条错相，四条骨架不会像一块整体在闪
    li.style.setProperty('--i', String(i));
    const dot = document.createElement('span'); dot.className = 's-skel-dot';
    const bar = document.createElement('span'); bar.className = 's-skel-bar';
    li.append(dot, bar);
    ul.appendChild(li);
  }
}

/* ---------- 后端连接状态 ----------
   gateway 掉线过去只在「下一次操作失败」时以 toast 出现，用户看到的是一堆「连接已重置」，
   却不知道原因。这里把主进程推来的状态落成侧栏底部一个点：绿=可用、蓝=正在连、
   红=断开（点击重连）。状态只反映事实，不主动探测端口。 */
const CONN_TEXT = { ready: '已连接', connecting: '连接中', offline: '已断开' };
function renderConnStatus(st) {
  const btn = $('#btn-conn');
  if (!btn) return;
  const s = st || {};
  // 局部量别叫 state：外层还有一个全局 state（会话/页签模型），重名会把 booted 写丢
  let mode = 'connecting';
  if (s.connected) mode = 'ready';
  else if (s.state === 'error' || s.state === 'idle' || s.state === 'stopped') mode = 'offline';
  // serve 已就绪、但 WS 还没建立过（空闲启动后一条 RPC 都没发）＝ 正常待用，不是故障：
  // 会话列表读 SQLite、项目树走短连 HTTP，首轮对话才会建 WS。这里若报「连接中」，
  // 用户会在完全健康的空闲态看到一个永远转不完的蓝点。
  else if (s.state === 'ready' && !s.linked) mode = 'ready';
  btn.dataset.state = mode;
  // 后端刚可用 = 首屏骨架该收起了：即使一条会话都没有，也已经是确定答案
  // （首次装机的空列表和「还没拉回来」在界面上必须是两种东西）
  if (mode === 'ready' && !state.booted) bootSettled();
  else if (mode === 'offline' && !state.booted) { state.bootError = '后端未连接'; renderSessions(currentSearch()); }
  // 已经建立过长连接再补拉：此时取目录零成本；空闲启动不为它去唤醒 serve
  if (mode === 'ready' && s.linked && !cliCatalog.ok && typeof loadCliCatalog === 'function') loadCliCatalog();
  const label = CONN_TEXT[mode] || '未知';
  const txt = btn.querySelector('.sb-conn-text');
  if (txt) txt.textContent = label;
  const portTxt = s.port ? `（端口 ${s.port}）` : '';
  btn.title = mode === 'ready'
    ? (s.connected ? `后端已连接${portTxt}` : `后端已就绪${portTxt || '，'}，对话时按需建立长连接`)
    : (mode === 'offline' ? '后端未连接，点击重连' : '正在连接后端…');
  btn.setAttribute('aria-label', '后端' + label);
}
function initConnStatus() {
  const btn = $('#btn-conn');
  if (!btn) return;
  if (typeof api.onBackendStatus === 'function') {
    try { api.onBackendStatus(renderConnStatus); } catch { /* 订阅失败不影响主流程 */ }
  }
  const pull = () => {
    if (typeof api.backendStatus !== 'function') return;
    Promise.resolve(api.backendStatus()).then(renderConnStatus).catch(() => {});
  };
  pull();
  let busy = false;
  btn.onclick = async () => {
    if (busy) return;
    // 已连接时点一下只是复查，不做破坏性动作（用户可能是想确认状态）
    if (btn.dataset.state === 'ready') { pull(); toast('后端连接正常', 1400); return; }
    busy = true;
    btn.dataset.state = 'connecting';
    const txt = btn.querySelector('.sb-conn-text');
    if (txt) txt.textContent = '重连中';
    let r = null;
    try { r = await api.reconnectBackend(); }
    catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    busy = false;
    if (r && r.ok) toast('后端已重新连接', 1800);
    else toast('重连失败：' + ((r && r.error) || '未知错误'), 3200);
    pull();
  };
}
function initFocusRefresh() {
  window.addEventListener('focus', refreshOnFocus);
  // 切标签页回来时 focus 不一定会触发，可见性变化要单独接一次
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshOnFocus(); });
}
/* ---------- 对话/轨迹 视图切换 ---------- */
document.querySelectorAll('.vt').forEach((b) => {
  b.onclick = () => {
    state.view = b.dataset.view;
    document.querySelectorAll('.vt').forEach((x) => x.classList.toggle('active', x === b));
    renderChat();
  };
});

/* ---------- 模型配置漂移 ----------
   桌面端 userData/config.json 的 model 会覆盖 CLI config.yaml 的 model.default。
   旧实现只列 models.json，而 CLI 默认模型常常不在那个列表里 —— 用户即使知道
   默认值也选不到，失败后只能看到错误卡。这里把 CLI 默认作为选择器首项，
   并在启动时对「已保存的模型 ≠ CLI 默认」给出非阻断提示。
   提示只是信息，唯一会写配置的入口是用户点「跟随 CLI 默认」。 */
let cliModelState = null;
let driftDismissed = false;

async function readCliModelState(force) {
  if (!force && cliModelState) return cliModelState;
  if (typeof api.configModelState !== 'function') return cliModelState;
  try {
    const r = await api.configModelState();
    if (r && r.ok) { cliModelState = r; return r; }
  } catch {}
  return cliModelState; // 读失败沿用上次快照，绝不阻断界面
}

async function syncModelDrift(force) {
  const box = $('#model-drift');
  if (!box) return;
  if (driftDismissed) { box.hidden = true; return; }
  const ms = await readCliModelState(force);
  const cliDefault = ms && ms.defaultModel;
  const current = state.config.model || '';
  if (!cliDefault || !current || current === cliDefault) { box.hidden = true; return; }
  const tip = ms.inModelsList
    ? '。'
    : '；该默认模型未列入 models.json，现已加入模型选择器。';
  $('#model-drift-text').innerHTML =
    `桌面端配置使用 <code>${esc(current)}</code>，会覆盖 CLI 默认 <code>${esc(cliDefault)}</code>${tip}` +
    ' 若调用失败，可一键跟随（只改桌面端配置，不动 CLI）。';
  box.dataset.cliDefault = cliDefault;
  box.hidden = false;
}

$('#btn-md-follow').onclick = () => {
  const box = $('#model-drift');
  const v = box && box.dataset.cliDefault;
  if (!v) return;
  setModel(v); // 用户主动点击才写 userData/config.json
  box.hidden = true;
  toast('已跟随 CLI 默认模型：' + v);
};
$('#btn-md-later').onclick = () => { driftDismissed = true; $('#model-drift').hidden = true; };
$('#btn-md-close').onclick = () => { driftDismissed = true; $('#model-drift').hidden = true; };

/**
 * 模型候选行：CLI 默认置顶 → models.json → 内置兜底，按 key 去重。
 * chip 菜单与设置页「默认模型」下拉共用同一份规则，避免两处列表漂移。
 * current 单独兜底：配置里存着不在任何清单中的模型（例如失效名）时仍可见、可改。
 */
function modelRows(ms, fallback, current) {
  const rows = [];
  const seen = new Set();
  const cliDefault = ms && ms.defaultModel;
  if (cliDefault) {
    rows.push({ key: cliDefault, name: cliDefault, tag: 'CLI 默认' });
    seen.add(cliDefault);
  }
  const fromState = arr(ms && ms.models);
  const real = fromState.length ? fromState : arr(fallback);
  if (real.length) {
    for (const m of real) {
      if (!m || !m.model || seen.has(m.model)) continue;
      seen.add(m.model);
      rows.push({ key: m.model, name: m.name || m.model, tag: m.provider || '' });
    }
  } else {
    for (const m of MODELS) {
      if (seen.has(m)) continue;
      seen.add(m);
      rows.push({ key: m, name: m, tag: '内置' });
    }
  }
  const cur = String(current || '');
  if (cur && !seen.has(cur)) rows.push({ key: cur, name: cur, tag: '当前配置' });
  return rows;
}

const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
async function openModelPicker(opts) {
  // 每次打开都重读一次：CLI 侧 config.yaml 可能被手工改过，缓存会掩盖新默认值
  const ms = await readCliModelState(true);
  let fallback = [];
  if (!arr(ms && ms.models).length) {
    try { if (hasNative) { const r = await api.configModels(); if (r && r.ok) fallback = arr(r.models); } } catch {}
  }
  const rows = modelRows(ms, fallback, state.config.model);
  // 思考程度是「跟模型一起决定输出形态」的二级参数，收进模型菜单的最后一项
  rows.push({
    key: '::effort', name: '思考程度',
    subValue: state.config.reasoning || 'none',
    sub: EFFORT_LEVELS.map((l) => ({ key: l, name: l, tag: l === 'none' ? '不思考' : '' })),
  });
  const h = openChipMenu($('#chip-model'), rows, state.config.model, (r, parent) => {
    if (parent && parent.key === '::effort') setEffort(r.key);
    else setModel(r.key);
  });
  if (opts && opts.effort && h) h.openSub('::effort');
}

/** 思考程度只写桌面端 config.json 的 reasoning，不碰 CLI 的 agent.reasoning_effort */
function setEffort(level) {
  state.config.reasoning = level;
  if (hasNative) api.setConfig({ reasoning: level });
  updateStatus();
  toast('思考程度 → ' + level);
}

function setModel(m) {
  state.config.model = m;
  if (hasNative) api.setConfig({ model: state.config.model });
  // 用户已主动做出选择，本次会话不再反复提示漂移
  driftDismissed = true;
  const box = $('#model-drift'); if (box) box.hidden = true;
  updateStatus(); toast('模型 → ' + state.config.model);
}

/** 唯一入口在模型 chip 里；/effort 只是把同一个菜单打开并直接落到二级上 */
function openEffortPicker() {
  return openModelPicker({ effort: true });
}
function transcriptText() {
  const tab = activeTab(); if (!tab) return '';
  const lines = [`# ${tab.title || 'Hermes 会话'}`, `> 导出时间：${new Date().toLocaleString('zh-CN')}`];
  for (const i of tab.items) {
    if (i.kind === 'user') lines.push(`## 你\n${i.text}`);
    else if (i.kind === 'assistant') lines.push(`## Hermes\n${i.text}`);
    else if (i.kind === 'tool') lines.push(`## 工具 ${i.name} [${i.state}]\n${i.output || ''}`);
    else if (i.kind === 'thinking') lines.push(`<details><summary>思考过程</summary>\n\n${i.text}\n\n</details>`);
    else if (i.kind === 'approval') lines.push(`## 审批：${i.tool || ''}（${i.choice === 'deny' ? '已拒绝' : i.choice ? '已允许' : '待确认'}）\n${i.command || ''}`);
    else lines.push(`## 错误\n${i.text}`);
  }
  return lines.join('\n\n');
}
/** 导出为本地 .md 文件（Claude Code 的 transcript 导出习惯），并保留剪贴板副本命令。 */
function exportTranscript() {
  const tab = activeTab(); if (!tab) return;
  const text = transcriptText();
  try {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = String(tab.title || 'hermes-session').replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 48);
    a.href = url; a.download = `${safe}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('会话记录已导出为 Markdown', 1800);
  } catch (e) { toast('导出失败：' + ((e && e.message) || e), 2400); }
}
function copyTranscript() {
  const text = transcriptText(); if (!text) return;
  navigator.clipboard.writeText(text)
    .then(() => toast('会话记录已复制'))
    .catch(() => toast('复制失败，请改用 /export 导出', 2200));
}
/* ---------- 消息平台接入页 ---------- */
const GW_GROUPS = [
  { key: 'common', label: '常用平台' },
  { key: 'cn', label: '国内平台' },
  { key: 'advanced', label: '其他通道' },
];
let gwData = null;

/** 菜单入口：打开/关闭「消息平台接入」整页（原为一条 toast） */
function showGateway() {
  const page = $('#gateway-page');
  if (!page) return;
  if (!page.hidden) { page.hidden = true; return; }
  ['#plugins-page', '#skills-page', '#market-page'].forEach((s) => { const p = $(s); if (p) p.hidden = true; });
  try { closeKanbanPage(); } catch {}
  page.hidden = false;
  loadGatewayOverview();
}
function closeGatewayPage() {
  const p = $('#gateway-page'); if (p) p.hidden = true;
  const cf = $('#gw-confirm'); if (cf) { cf.hidden = true; cf.innerHTML = ''; }
  const out = $('#gw-cli-out'); if (out) { out.hidden = true; out.textContent = ''; }
}

async function loadGatewayOverview() {
  const stateEl = $('#gw-service-state');
  if (stateEl) stateEl.textContent = '读取中…';
  const api = window.hermesAPI;
  if (!api || !api.gwOverview) {
    gwData = { ok: false, error: '此页需要在 Hermes 桌面端运行（Demo 模式无本地配置）', platforms: [] };
  } else {
    try { gwData = await api.gwOverview(); }
    catch (e) { gwData = { ok: false, error: e.message, platforms: [] }; }
  }
  renderGatewayPage();
}

function gwStatusOf(p) {
  if (p.declared && !p.enabled) return { cls: 'off', text: '已禁用' };
  if (!p.env.length) return { cls: '', text: '内置通道' };
  if (p.presentEnv.length === p.env.length) return { cls: 'ok', text: '已配置' };
  if (p.presentEnv.length > 0) return { cls: 'part', text: `缺 ${p.missingEnv.length} 项` };
  return { cls: '', text: '未配置' };
}

function renderGatewayPage() {
  const d = gwData || { ok: false, error: '尚未加载', platforms: [] };
  const stateEl = $('#gw-service-state'), metaEl = $('#gw-service-meta'), dot = $('#gw-live-dot');
  if (!d.ok) {
    if (stateEl) stateEl.textContent = '无法读取';
    if (metaEl) metaEl.textContent = d.error || '';
  } else {
    if (stateEl) stateEl.textContent = d.running ? '运行中' : '已停止';
    if (dot) dot.classList.toggle('on', !!d.running);
    const s = d.service || {};
    const bits = [];
    if (d.running && s.pid) bits.push(`PID ${s.pid}`);
    if (s.kind) bits.push(String(s.kind));
    if (s.startedAt) bits.push(`启动于 ${s.startedAt}`);
    if (!d.running && s.exitReason) bits.push(`上次退出：${s.exitReason}`);
    if (s.codeVersion) bits.push(String(s.codeVersion));
    if (metaEl) metaEl.textContent = bits.join(' · ') || '暂无历史状态';
    document.querySelectorAll('.gw-hero-actions .gw-btn').forEach((b) => {
      if (b.dataset.act === 'start') b.disabled = !!d.running;
      if (b.dataset.act === 'stop') b.disabled = !d.running;
    });
  }

  const cur = (d.profiles || []).find((p) => p.current);
  const homeLabel = (d.hermesHome && String(d.hermesHome))
    || (cur && cur.name && cur.name !== 'default' ? `~/.hermes/profiles/${cur.name}` : '~/.hermes');
  const envLabel = (d.envFile && String(d.envFile)) || `${homeLabel}/.env`;
  const subEnv = $('#gw-sub-env'); if (subEnv) subEnv.textContent = envLabel;
  const footEnv = $('#gw-foot-env'); if (footEnv) footEnv.textContent = envLabel;

  const stats = $('#gw-stats');
  if (stats) {
    const ps = d.platforms || [];
    const configured = typeof d.configuredCount === 'number'
      ? d.configuredCount
      : ps.filter((p) => gwStatusOf(p).cls === 'ok').length;
    stats.innerHTML = [
      [`${configured} / ${ps.length}`, '已配置平台'],
      [cur ? cur.name : 'default', '当前 Profile'],
      [(d.service && d.service.sessionStore) || '—', '会话库状态'],
      [homeLabel, '配置目录'],
    ].map(([v, k]) => `<div class="gw-stat"><b>${esc(String(v))}</b><span>${esc(k)}</span></div>`).join('');
  }

  const q = ($('#gw-search') && $('#gw-search').value || '').trim().toLowerCase();
  const all = d.platforms || [];
  const ps = all.filter((p) => !q || (p.label + ' ' + p.key + ' ' + p.env.join(' ')).toLowerCase().indexOf(q) >= 0);
  const cnt = $('#gw-count'); if (cnt) cnt.textContent = q ? `${ps.length} / ${all.length}` : `共 ${all.length} 个`;
  const clr = $('#gw-search-clear'); if (clr) clr.hidden = !q;
  const groups = $('#gw-groups');
  if (groups) {
    groups.innerHTML = ps.length ? GW_GROUPS.map((g) => {
      const cards = ps.filter((p) => p.group === g.key);
      if (!cards.length) return '';
      return `<div class="gw-section-label">${esc(g.label)} <span style="font-weight:400;color:var(--text-3)">（${cards.length}）</span></div>
        <div class="gw-grid">${cards.map(gwCardHtml).join('')}</div>`;
    }).join('') : '<div class="gw-empty">没有匹配的平台</div>';
  }

  const profiles = $('#gw-profiles');
  if (profiles) {
    const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB');
    profiles.innerHTML = (d.profiles || []).map((p) => `
      <div class="gw-prof-card ${p.current ? 'current' : ''}">
        <div class="gw-prof-top"><b>${esc(p.name)}</b>${p.current ? '<span class="gw-prof-badge">当前</span>' : '<span class="gw-prof-badge dim">未激活</span>'}</div>
        <div class="gw-prof-meta">${esc(p.model || '未指定模型')}</div>
        <div class="gw-prof-meta dim">会话库 ${mb(p.dbBytes || 0)} · 技能 ${p.skills || 0}</div>
      </div>`).join('');
  }
}

function gwCardHtml(p) {
  const st = gwStatusOf(p);
  const envPath = (gwData && gwData.envFile) || '~/.hermes/.env';
  const envHtml = p.env.length
    ? `<div class="gw-env-label">所需凭证（写入 ${esc(envPath)}）</div><div class="gw-env-keys">${p.env.map((k) =>
        `<code class="${p.presentEnv.indexOf(k) >= 0 ? 'present' : ''}">${esc(k)}</code>`).join('')}</div>`
    : '<div class="gw-env-label">无需额外凭证，由 Gateway 内置提供</div>';
  return `<div class="gw-card" data-key="${esc(p.key)}">
    <div class="gw-card-top">
      <span class="gw-card-ico">${p.ico}</span>
      <div class="gw-card-title">
        <div class="gw-card-name">${esc(p.label)}<span class="gw-badge ${st.cls}">${st.text}</span></div>
        <div class="gw-card-key">${esc(p.key)}</div>
      </div>
    </div>
    ${envHtml}
    <div class="gw-card-actions">
      <button data-act="copy-setup" data-cmd="${esc(p.setup)}">复制配置命令</button>
      <button data-act="open-env">打开 .env</button>
    </div>
  </div>`;
}

function gwCopy(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; } } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

function gwShowCliOut(text, isErr) {
  const pre = $('#gw-cli-out');
  if (!pre) return;
  const body = String(text || '').trim();
  if (!body) { pre.hidden = true; pre.textContent = ''; return; }
  pre.hidden = false;
  pre.classList.toggle('err', !!isErr);
  pre.textContent = body;
}
async function gwCheckCliStatus() {
  const btn = $('#gw-cli-status');
  const api = window.hermesAPI;
  if (!api || !api.gwCliStatus) { toast('此页需要在 Hermes 桌面端运行', 2000); return; }
  if (btn) btn.disabled = true;
  gwShowCliOut('正在执行 hermes gateway status…', false);
  try {
    const r = await api.gwCliStatus();
    if (r && r.ok) gwShowCliOut(r.text || '（无输出）', false);
    else gwShowCliOut((r && (r.text || r.error)) || '读取 CLI 状态失败', true);
  } catch (e) {
    gwShowCliOut((e && e.message) || '读取 CLI 状态失败', true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
let gwActionBusy = false;
function gwRunAction(op) {
  if (gwActionBusy) { toast('已有 Gateway 操作正在执行，请稍候', 1800); return; }
  const label = { start: '启动', stop: '停止', restart: '重启' }[op];
  const host = $('#gw-confirm');
  if (!host) return;
  host.hidden = false;
  host.innerHTML = `<div class="op-confirm" role="alertdialog" aria-label="确认操作">
    <div class="op-confirm-title">${esc(label)} Gateway 后台服务？</div>
    <code class="op-confirm-cmd">hermes gateway ${esc(op)}</code>
    <div class="op-confirm-note">会影响所有消息平台的收发。</div>
    <div class="op-confirm-btns">
      <button class="kb-btn primary" type="button" data-gw-go="1">确认${esc(label)}</button>
      <button class="kb-btn" type="button" data-gw-cancel="1">取消</button>
    </div>
  </div>`;
  host.querySelector('[data-gw-cancel]').onclick = () => { host.hidden = true; host.innerHTML = ''; };
  host.querySelector('[data-gw-go]').onclick = async () => {
    if (gwActionBusy) return;
    host.hidden = true; host.innerHTML = '';
    const api = window.hermesAPI;
    if (!api || !api.gwAction) { toast('需要在桌面端运行', 2200); return; }
    gwActionBusy = true;
    const btns = ['#gw-start', '#gw-stop', '#gw-restart'].map((s) => $(s)).filter(Boolean);
    btns.forEach((b) => { b.disabled = true; });
    toast(`正在${label} Gateway…`, 2000);
    try {
      const r = await api.gwAction(op);
      if (r && r.ok) {
        gwData = r.overview || gwData;
        renderGatewayPage();
        gwShowCliOut(r.output || '', false);
        toast(`Gateway 已${label}`, 2200);
      } else {
        const errTxt = (r && (r.output || r.error)) || '未知错误';
        gwShowCliOut(errTxt, true);
        toast(`${label}失败，详见上方输出`, 3600);
      }
    } catch (e) {
      gwShowCliOut(e.message, true);
      toast(`${label}失败：${e.message}`, 3200);
    } finally {
      gwActionBusy = false;
      btns.forEach((b) => { b.disabled = false; });
    }
  };
}

$('#gw-refresh').onclick = () => loadGatewayOverview();
$('#gw-close').onclick = closeGatewayPage;
$('#gw-open-config').onclick = async () => {
  const api = window.hermesAPI;
  if (api && api.gwOpenFile) { const r = await api.gwOpenFile('config'); if (!r.ok) toast(r.error, 2600); }
};
$('#gw-search').addEventListener('input', renderGatewayPage);
$('#gw-search-clear').onclick = () => { $('#gw-search').value = ''; renderGatewayPage(); $('#gw-search').focus(); };
$('#gateway-page').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act;
  if (act === 'cli-status') return gwCheckCliStatus();
  if (act === 'start' || act === 'stop' || act === 'restart') return gwRunAction(act);
  if (act === 'copy-setup') {
    const cmd = b.dataset.cmd || 'hermes gateway setup';
    toast(gwCopy(cmd) ? `已复制：${cmd}` : '复制失败，请手动复制', 2200);
    return;
  }
  if (act === 'open-env') {
    const api = window.hermesAPI;
    if (api && api.gwOpenFile) { const r = await api.gwOpenFile('env'); if (!r.ok) toast(r.error, 2600); }
  }
});

/* ---------- 右侧 rail：预览 | 看板 ---------- */
const RAIL_TAB_KEY = 'rail-tab';
/* ---------- 聊天区事件委托：消息操作 / 代码复制 / 审批 ---------- */
$('#chat').addEventListener('click', (e) => {
  const t = e.target;
  const ap = t.closest && t.closest('[data-ap]');
  if (ap) {
    const msg = ap.closest('.msg'); const item = msg && msg._item;
    if (item && !item.choice) resolveApproval(item, ap.dataset.ap);
    return;
  }
  const ea = t.closest && t.closest('[data-err-act]');
  if (ea) {
    const msg = ea.closest('.msg'); const item = msg && msg._item;
    const kind = ea.dataset.errAct;
    if (kind === 'model') openModelPicker();
    else if (kind === 'retry') retryFailedTurn(item);
    else if (kind === 'detail') {
      const raw = msg && msg.querySelector('.err-raw');
      if (raw) { raw.hidden = !raw.hidden; ea.textContent = raw.hidden ? '查看原始错误' : '收起原始错误'; }
    }
    return;
  }
  const pvOpen = t.closest && t.closest('[data-pv-open]');
  if (pvOpen) {
    e.stopPropagation();
    const target = pvOpen.dataset.pvOpen;
    if (target) {
      toggleRail(true);
      setRailTab('preview');
      loadPreviewInput(target);
    }
    return;
  }
  const act = t.closest && t.closest('[data-msg-act]');
  if (act) {
    // 助手脚注已经不在 .msg 里了（挪到了整轮末尾），兜一层从脚注行自己取回数据
    const msg = act.closest('.msg');
    const row = act.closest('.msg-foot-row');
    const item = (msg && msg._item) || (row && row._item);
    if (!item) return;
    if (act.dataset.msgAct === 'copy') {
      copyText(item.text || item.output || '').then(() => toast('已复制该消息', 1200)).catch(() => toast('复制失败'));
    } else if (act.dataset.msgAct === 'retry') retryFrom(item);
    else if (act.dataset.msgAct === 'to-task' && typeof kbModalOpen === 'function') {
      const tab = activeTab();
      const raw = String(item.text || item.output || '').trim();
      const firstLine = (raw.split('\n')[0] || '对话转任务').replace(/^#+\s*/, '').slice(0, 80);
      kbModalOpen('task', {
        title: firstLine,
        body: raw,
        sessionId: (tab && tab.sessionId) || '',
        projectId: (tab && tab.sessionId && typeof sessionProjectId === 'function') ? sessionProjectId(tab.sessionId) : '',
      });
    }
    return;
  }
});

/* ---------- 危险操作审批：主进程请求 → 聊天流卡片 → 用户选择回传 ---------- */
function onApprovalRequest(req) {
  const r = req || {};
  if (!r.requestId) return;
  const tab = (r.tabId && state.tabs.find((t) => t.id === r.tabId)) || activeTab();
  if (!tab) {
    if (hasNative && api.approvalRespond) Promise.resolve(api.approvalRespond({ requestId: r.requestId, choice: 'deny', tabId: r.tabId })).catch(() => {});
    return;
  }
  const item = {
    kind: 'approval', requestId: r.requestId, tabId: r.tabId || tab.id,
    tool: r.tool || '工具调用', command: r.command || '', risk: r.risk || '',
  };
  tab.items.push(item);
  if (tab.id === state.activeTabId) {
    renderChat(); scrollBottom(true);
  } else {
    toast(`后台会话「${tab.title || '会话'}」需要确认危险操作`, 12000, {
      actionLabel: '立即查看并处理',
      onClick: () => { state.view = 'chat'; setActiveTab(tab.id); scrollBottom(true); },
    });
  }
  a11y('需要确认危险操作');
  // 主进程 25s 后自动拒绝，这里提前收口，避免卡片永久停在「待确认」
  setTimeout(() => { if (!item.choice) resolveApproval(item, 'deny', true); }, 24000);
}
function resolveApproval(item, choice, silent) {
  if (!item || item.choice) return;
  item.choice = choice === 'deny' ? 'deny' : 'approve';
  item.always = choice === 'always';
  if (hasNative && api.approvalRespond) {
    Promise.resolve(api.approvalRespond({ requestId: item.requestId, choice, tabId: item.tabId }))
      .then((ok) => {
        if (ok === false) {
          item.choice = 'deny';
          item.expired = true;
          if (item.tabId === state.activeTabId) renderChat();
          if (!silent) toast('该审批已超时或已在小窗处理', 2200);
        }
      })
      .catch(() => {});
  }
  if (item.tabId === state.activeTabId) renderChat();
  if (!silent) toast(choice === 'deny' ? '已拒绝该操作' : '已允许该操作', 1500);
}

/** 设置落盘后立刻生效；字号只作用于聊天正文，不动用户定稿的几何尺寸。 */
function applySettings() {
  const s = settingsRead();
  const theme = s.theme === 'dark' ? 'dark'
    : s.theme === 'system' ? ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light')
      : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  // 字号是一个旋钮：写 --ui-fs，正文/气泡/摘要行/信息行/输入框/状态条全部按比例派生
  const fsPx = (Math.max(10, Math.min(20, Number(s.fontSize) || 16))) + 'px';
  document.documentElement.style.setProperty('--ui-fs', fsPx);
  document.documentElement.style.setProperty('--msg-font-size', fsPx);
  document.documentElement.classList.toggle('compact-steps', s.stepDetail === '简洁');
  // 主题变了迷你聊天窗也要跟着变（它自己读不到主窗口的 localStorage）
  publishOrbContext();
}
if (window.matchMedia) {
  const _mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  if (_mqDark && typeof _mqDark.addEventListener === 'function') {
    _mqDark.addEventListener('change', () => {
      if (settingsRead().theme === 'system') applySettings();
    });
  }
}


/* ---------- 初始化 ---------- */
async function init() {
  refreshProfileChip(); // 尽早刷新，不受后续会话加载/后端重启阻塞
  applySettings();      // 设置此前只写不读：启动时也要恢复主题/字号/步骤详略
  // 先铺骨架：下面 env / 会话列表都要等后端，空白侧栏会被误读成「没有历史会话」
  try { renderSessions(''); } catch {}
  try { const env = await api.env(); state.env = env; state.config = { ...state.config, ...env.config }; } catch {}
  syncApprovalModeFromSettings();
  // env-chip 已按需求移除（侧栏左下角改为齿轮按钮），仅保留 state.env 数据
  await refreshSessions();
  ensureSidebarTree(); // 首屏树若撞上后端冷启失败，后台补拉，不阻塞首屏
  newTab();
  updateStatus();
  if (hasNative) {
    api.onEvent(({ tabId, evt }) => { state.turnTab.set(evt.turnId, tabId); routeEvent(evt); });
    api.onError(({ tabId, message }) => {
      const tab = state.tabs.find((t) => t.id === tabId); if (!tab) return;
      tab.items.push({ kind: 'error', text: message, failure: parseFailure('', message) });
      if (tab.id === state.activeTabId) renderChat();
    });
    api.onClose(handleClose);
    if (api.onApproval) api.onApproval(onApprovalRequest);
    // 迷你聊天窗发出的消息：主窗口只是补数据模型（用户消息是渲染层自己 push 的，
    // 小窗那条绕过了它）。不补的话，回主窗口看到的会是「只有回答、没有提问」。
    if (api.onOrbUserMessage) api.onOrbUserMessage(({ tabId, text }) => {
      if (!tabId || !text) return;
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      tab.items.push({ kind: 'user', text: String(text), ts: Date.now(), fromOrb: true });
      tab.running = true;
      tab.showTyping = true;
      tab.activity = '思考中…';
      if (tab.title === '新会话') tab.title = String(text).slice(0, 24);
      if (tab.id === state.activeTabId) { renderChat(); syncActivityBar(); syncComposerState(); }
      renderTabs();
    });
    // 小窗里点了「允许 / 拒绝」：主窗口那张卡立刻收口，
    // 否则它 24s 的自动拒绝定时器还会对同一个 requestId 再表一次态。
    // 球下拉选了某个 profile 里的会话：主进程已经先展开主窗，这里只负责
    // 「切 profile（复用既有后端重启链路）」或「直接打开当前 profile 的会话」。
    if (api.onOrbOpenSession) api.onOrbOpenSession((p) => {
      if (!p || !p.profile) return;
      if (p.needsSwitch) {
        // doSwitchProfile 内部会 location.reload()；把待打开会话记到
        // sessionStorage，重载后由 init() 末尾消费（只在本窗口生命周期有效）。
        try {
          sessionStorage.setItem('orb:open-session', JSON.stringify({
            profile: p.profile, sessionId: p.sessionId || '', at: Date.now(),
          }));
        } catch {}
        doSwitchProfile(p.profile);
        return;
      }
      if (p.sessionId) openSession(p.sessionId);
    });
    if (api.onOrbApprovalResolved) api.onOrbApprovalResolved(({ requestId, choice }) => {
      if (!requestId) return;
      for (const tab of state.tabs) {
        const it = tab.items.find((i) => i.kind === 'approval' && i.requestId === requestId);
        if (it && !it.choice) {
          it.choice = choice === 'deny' ? 'deny' : 'approve';
          if (tab.id === state.activeTabId) renderChat();
        }
      }
    });
    if (api.onMenuAction) api.onMenuAction((act) => {
      if (act === 'settings') toggleSettings(true);
      else if (act === 'new-session') newSessionAction();
      else if (act === 'kanban' && typeof showKanban === 'function') showKanban(true);
      else if (act && typeof act === 'object' && act.type === 'set-model') {
        state.config.model = String(act.model || '');
        driftDismissed = true;
        const box = $('#model-drift'); if (box) box.hidden = true;
        updateStatus();
      }
    });
    if (api.onFocusTab) api.onFocusTab((tabId) => {
      if (tabId && state.tabs.some((t) => t.id === tabId)) {
        closeSubpages();
        state.view = 'chat';
        setActiveTab(tabId);
        scrollBottom(true);
      }
    });
    // 菜单「消息平台」是整页入口，不再被 serve 状态文字覆盖
  }
  syncComposerState();
  syncComposerProject(); // 首屏把项目下拉的候选与当前页签状态落地
  initConnStatus();      // 后端连接状态点：先拉一次快照，之后靠主进程推送
  // CLI 命令目录不在这里预热：空闲启动会为此唤醒 serve。第一次敲 / 时才拉（slashSync）。
  initFocusRefresh();    // 切回窗口时补齐终端 / 其他窗口产生的变化
  // 非阻断：启动即核对桌面端模型与 CLI 默认是否漂移；切 profile 会 reload 重跑
  syncModelDrift(true);
  // 球下拉里选了别的 profile 的会话：doSwitchProfile 重载后在这里补上打开动作。
  // 带 30s 时效，避免切换失败时残留到下次启动莫名其妙打开旧会话。
  try {
    const raw = sessionStorage.getItem('orb:open-session');
    if (raw) {
      sessionStorage.removeItem('orb:open-session');
      const p = JSON.parse(raw);
      if (p && p.sessionId && Number.isFinite(p.at) && Date.now() - p.at < 30000) {
        openSession(p.sessionId);
      }
    }
  } catch {}
}
