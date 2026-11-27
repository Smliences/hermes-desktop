'use strict';
/* ═══════════ Hermes Desktop Client — 设置 / 诊断 / MCP / Cron / Profile ═══════════ */
/* global $, esc, arr, clip, safeStringify, safeGet, safeSet, fmtTokens, uid, a11y, state, api, hasNative, toast, showConfirm, closeSubpages, syncInert, pushFocus, popFocus, openSession, refreshSessions, renderTabs, newTab, renderChat, applySettings, syncModelDrift, refreshProfileChip, doSwitchProfile */

/* ---------- 设置页（dsh 式大弹层：左导航 + 右面板 + 保存/取消） ----------
 * 分类注册表驱动：新增设置分类只需向 SETTINGS_CATEGORIES 追加描述符，
 * 渲染/脏检测/保存流程全部复用。存储经 SettingsStore 抽象——当前为
 * localStorage，接 hermes config.yaml 时替换 provider 即可，UI 不变。 */
const SETTINGS_CATEGORIES = [
  {
    id: 'general', label: '通用设置', ico: '⚙',
    groups: [
      { title: '权限', items: [
        { type: 'select', key: 'approvalMode', label: '新会话权限模式', hint: '选择新会话的默认审批模式', value: '工作区内修改',
          options: ['工作区内修改', '自动批准全部', '每次询问'] },
      ]},
      { title: '外观', bare: true, items: [
        { type: 'cards', key: 'theme', value: 'light', options: [
          { v: 'light', label: '浅色', ico: '☀' }, { v: 'dark', label: '深色', ico: '☾' }, { v: 'system', label: '跟随系统', ico: '🖥' },
        ]},
      ]},
      { title: '字体', items: [
        { type: 'stepper', key: 'fontSize', label: '字号大小', hint: '正文/输入框/信息行同步缩放，默认 16', value: 16, min: 10, max: 20, unit: 'px' },
      ]},
      { title: '行为', items: [
        { type: 'select', key: 'stepDetail', label: '工作步骤展示', hint: '选择希望看到多少工具调用细节', value: '详细', options: ['详细', '简洁'] },
        { type: 'toggle', key: 'streamThink', label: '流式思考', hint: '实时显示模型的思考过程（需上游已开启思考输出）', value: true },
        { type: 'action', key: 'reasoningUpstream', label: '上游思考输出', hint: '关闭时 CLI 一句推理都不下发，「思考过程」必然是空的',
          actionLabel: '检查', run: (row) => enableUpstreamReasoning(row) },
        { type: 'toggle', key: 'autoCollapse', label: '工作步骤收起时机', hint: '回答结束后自动收起工作步骤', value: true },
      ]},
    ],
  },
  {
    id: 'model', label: '模型', ico: '▤', custom: 'model',
    desc: '模型提供商与已配置模型来自 hermes CLI（providers.json / models.json）。',
  },
  {
    id: 'profile', label: 'Profile', ico: '◈', custom: 'profile',
    desc: '每个 profile 是一整套独立实例：各自的会话库、插件、技能、模型与凭证。切换后整个应用改用另一套。',
  },
  {
    id: 'shortcuts', label: '快捷键', ico: '⌨', custom: 'shortcuts',
    desc: '点击键位后按下新组合即可录制。必须带 ⌘ / Ctrl，Escape 与 ? 为系统保留键，冲突会被拒绝。',
  },
  {
    id: 'memory', label: '记忆', ico: '◈', custom: 'memory',
    desc: '只读查看 CLI 记忆状态与内置记忆文件；启停、重置等写操作仍以 hermes CLI 为准，桌面端不代劳。',
  },
  {
    id: 'tools', label: '工具集', ico: '⛭', custom: 'tools',
    desc: '控制 agent 在 CLI 平台能用哪些能力（shell、文件、浏览器等）。开关直接写 hermes CLI 配置，每次操作后回读确认，桌面端不缓存状态。',
  },
  {
    id: 'health', label: '健康检查', ico: '✚', custom: 'health',
    desc: '只读诊断，原样展示 CLI 输出；退出码非 0 有时只是「有建议」，不等于配置损坏。深度体检约 40 秒。',
  },
  {
    id: 'mcp', label: 'MCP 服务器', ico: '◇', custom: 'mcp',
    desc: '连接测试只读取不改动；添加会写入 CLI 的 config.yaml 并真实连接远端，移除需二次确认。增删的结果以 CLI 回读为准。',
  },
  {
    id: 'cron', label: '定时任务', ico: '◷', custom: 'cron',
    desc: '新建任务一律创建为暂停，不会立刻唤醒 agent 消耗额度；恢复、立即运行、移除都要二次确认。',
  },
  {
    id: 'kanban', label: '看板编排', ico: '◱', custom: 'kanban',
    desc: '看板卡片的自动处理方式。三档模式是 config.yaml 里两个开关的派生值；桌面端不缓存，每次打开都回读。',
  },
];
const SETTINGS_STORE_KEY = 'hermes.settings';
const SETTINGS_DEFAULTS = {
  theme: 'light', fontSize: 16, approvalMode: '工作区内修改',
  stepDetail: '详细', streamThink: true, autoCollapse: true,
};
const SETTINGS_ENUMS = {
  theme: ['light', 'dark', 'system'],
  approvalMode: ['工作区内修改', '自动批准全部', '每次询问'],
  stepDetail: ['详细', '简洁'],
};
/** 设置值会被拼进 innerHTML：类型 + 枚举 + 范围全部收敛，杜绝存储型 XSS，
 *  也防止被篡改的 localStorage 把任意 HTML 带进设置页。 */
function cleanSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, def] of Object.entries(SETTINGS_DEFAULTS)) {
    const v = raw[k];
    if (v === undefined || typeof v !== typeof def) continue;
    if (SETTINGS_ENUMS[k] && !SETTINGS_ENUMS[k].includes(v)) continue;
    if (k === 'fontSize' && (!Number.isFinite(v) || v < 10 || v > 20)) continue;
    out[k] = v;
  }
  return out;
}
function settingsRead() {
  let raw = null;
  try { raw = JSON.parse(safeGet(SETTINGS_STORE_KEY) || '{}'); } catch {}
  return cleanSettings(raw);
}
const SettingsStore = {
  get(k, fallback) { const s = settingsRead(); return s[k] !== undefined ? s[k] : fallback; },
  set(patch) {
    const next = { ...settingsRead(), ...cleanSettings(patch) };
    return safeSet(SETTINGS_STORE_KEY, JSON.stringify(next));
  },
  // 预留：接入 hermes config.yaml 时在此切换为 IPC provider，渲染层无需改动
};
let settingsCat = 'general';
let settingsDraft = {};      // 当前编辑中的值（key → value）
function settingsValue(key, fallback) {
  return settingsDraft[key] !== undefined ? settingsDraft[key] : SettingsStore.get(key, fallback);
}
function markSettingsDirty() { $('#set-save').classList.add('dirty'); $('#set-hint').textContent = '有未保存的更改'; }
function toggleSettings(show) {
  $('#settings-page').hidden = !show;
  if (show) {
    settingsDraft = {};
    $('#set-save').classList.remove('dirty');
    $('#set-hint').textContent = '更改需保存后生效';
    renderSettingsNav(); renderSettingsPanel();
    $('#set-panel').scrollTop = 0;
    // 预取两份「贵列表」：工具集 6.5–7.5s、MCP 约 2.5s。缓存命中时这两个调用
    // 是毫秒级（不会起子进程），过期才在后台重拉；用户点分类时通常已经就绪。
    if (isNativeCLI()) {
      try { api.toolsList(); api.mcpList(); } catch {}
    }
  }
}
function renderSettingsNav() {
  const nav = $('#set-nav'); nav.innerHTML = '';
  SETTINGS_CATEGORIES.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'set-nav-item' + (c.id === settingsCat ? ' active' : '');
    b.innerHTML = `<span class="set-nav-ico">${esc(c.ico)}</span>${esc(c.label)}`;
    b.onclick = () => { settingsCat = c.id; renderSettingsNav(); renderSettingsPanel(); };
    nav.appendChild(b);
  });
}
function setRow(label, hint, control) {
  const row = document.createElement('div'); row.className = 'set-row';
  row.innerHTML = `<div class="set-row-main"><div class="set-row-label">${esc(label)}</div>${hint ? `<div class="set-row-hint">${esc(hint)}</div>` : ''}</div>`;
  row.appendChild(control);
  return row;
}
function buildControl(c) {
  const val = () => settingsValue(c.key, c.value);
  if (c.type === 'select') {
    const wrap = document.createElement('button'); wrap.className = 'set-select';
    const render = () => { wrap.innerHTML = `${esc(val())} <span class="set-caret">▾</span>`; };
    render();
    wrap.onclick = () => {
      const menu = document.createElement('div'); menu.className = 'set-menu';
      c.options.forEach((o) => {
        const b = document.createElement('button');
        b.textContent = o; if (o === val()) b.classList.add('active');
        b.onclick = (e) => { e.stopPropagation(); settingsDraft[c.key] = o; markSettingsDirty(); render(); menu.remove(); };
        menu.appendChild(b);
      });
      document.body.appendChild(menu);
      const r = wrap.getBoundingClientRect();
      menu.style.left = Math.min(r.left, window.innerWidth - 190) + 'px';
      menu.style.top = r.bottom + 6 + 'px';
      const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
    };
    return wrap;
  }
  if (c.type === 'toggle') {
    const sw = document.createElement('button');
    sw.className = 'plg-switch' + (val() ? ' on' : ''); sw.setAttribute('role', 'switch');
    sw.onclick = () => { sw.classList.toggle('on'); settingsDraft[c.key] = sw.classList.contains('on'); markSettingsDirty(); };
    return sw;
  }
  if (c.type === 'stepper') {
    const wrap = document.createElement('div'); wrap.className = 'set-stepper';
    const num = document.createElement('span'); num.className = 'set-step-num'; num.textContent = val();
    const unit = document.createElement('span'); unit.className = 'set-step-unit'; unit.textContent = c.unit || '';
    const minus = document.createElement('button'); minus.textContent = '−'; minus.setAttribute('aria-label', '减小字号');
    const plus = document.createElement('button'); plus.textContent = '＋'; plus.setAttribute('aria-label', '增大字号');
    const clamp = (v) => Math.min(c.max, Math.max(c.min, v));
    minus.onclick = () => { settingsDraft[c.key] = clamp((+num.textContent) - 1); num.textContent = settingsDraft[c.key]; markSettingsDirty(); };
    plus.onclick = () => { settingsDraft[c.key] = clamp((+num.textContent) + 1); num.textContent = settingsDraft[c.key]; markSettingsDirty(); };
    wrap.append(minus, num, unit, plus);
    return wrap;
  }
  if (c.type === 'cards') {
    const wrap = document.createElement('div'); wrap.className = 'set-cards';
    const render = () => {
      wrap.innerHTML = '';
      c.options.forEach((o) => {
        const card = document.createElement('button');
        card.className = 'set-card' + (o.v === val() ? ' active' : '');
        card.innerHTML = `<span class="set-card-ico">${esc(o.ico)}</span>${esc(o.label)}`;
        card.onclick = () => { settingsDraft[c.key] = o.v; markSettingsDirty(); render(); };
        wrap.appendChild(card);
      });
    };
    render();
    return wrap;
  }
  if (c.type === 'action') {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'mk-btn'; btn.textContent = c.actionLabel || '执行';
    btn.onclick = () => { if (typeof c.run === 'function') c.run(btn.closest('.set-row')); };
    return btn;
  }
  if (c.type === 'text') {
    const input = document.createElement('input');
    input.className = 'set-input'; input.value = val(); input.spellcheck = false;
    input.oninput = () => { settingsDraft[c.key] = input.value; markSettingsDirty(); };
    return input;
  }
  return document.createElement('div');
}
/* 异步 custom 面板的代次戳：切分类后旧 CLI 结果不得写进新面板。 */
let settingsPanelEpoch = 0;
function renderSettingsPanel() {
  const cat = SETTINGS_CATEGORIES.find((c) => c.id === settingsCat);
  const panel = $('#set-panel'); panel.innerHTML = '';
  settingsPanelEpoch++;
  // 底部栏是「保存到本地设置」的语义；自带「应用」按钮的面板会把它收起来，
  // 切回来时必须还原，否则别的分类会失去保存入口。
  const saveBtn = $('#set-save'), cancelBtn = $('#set-cancel'), hintEl = $('#set-hint');
  const isGeneral = cat.id === 'general';
  if (saveBtn) saveBtn.hidden = !isGeneral;
  if (cancelBtn) cancelBtn.textContent = isGeneral ? '取消' : '关闭';
  if (hintEl) {
    if (!isGeneral) hintEl.textContent = '';
    else if (saveBtn && saveBtn.classList.contains('dirty')) hintEl.textContent = '有未保存的更改';
    else hintEl.textContent = '更改需保存后生效';
  }
  if (cat.custom === 'model') { renderModelPanel(panel, cat); return; }
  if (cat.custom === 'profile') { renderProfilePanel(panel, cat); return; }
  if (cat.custom === 'shortcuts') { renderShortcutPanel(panel, cat); return; }
  if (cat.custom === 'memory') { renderMemoryPanel(panel, cat); return; }
  if (cat.custom === 'tools') { renderToolsPanel(panel, cat); return; }
  if (cat.custom === 'health') { renderHealthPanel(panel, cat); return; }
  if (cat.custom === 'mcp') { renderMcpPanel(panel, cat); return; }
  if (cat.custom === 'cron') { renderCronPanel(panel, cat); return; }
  if (cat.custom === 'kanban') { renderKanbanModePanel(panel, cat); return; }
  cat.groups.forEach((g) => {
    const gt = document.createElement('div'); gt.className = 'pp-group-label'; gt.textContent = g.title;
    panel.appendChild(gt);
    g.items.forEach((c) => {
      if (g.bare) { panel.appendChild(buildControl(c)); return; }
      panel.appendChild(setRow(c.label, c.hint, buildControl(c)));
    });
  });
}
/**
 * 设置页「默认模型」区块：状态对照 + 一键写入桌面端默认模型。
 * 置于「模型提供商」之前——先确认当前生效值，再看可用来源。
 * 只经 setModel → cfg:set 写 userData/config.json，绝不写 CLI 的 config.yaml。
 */
function buildDefaultModelBlock(ms, models) {
  const cliDefault = (ms && ms.defaultModel) || '';
  const rows = modelRows(ms, models, state.config.model);
  const block = document.createElement('section');
  block.className = 'dm-block';

  const title = document.createElement('div');
  title.className = 'pp-group-label'; title.textContent = '默认模型';
  block.appendChild(title);
  const desc = document.createElement('div');
  desc.className = 'set-desc dm-desc';
  desc.textContent = '桌面端默认模型保存在本机配置，新会话自动沿用；CLI 全局默认仅作对照，不会被修改。';
  block.appendChild(desc);

  const stateCard = document.createElement('div');
  stateCard.className = 'dm-state';
  stateCard.setAttribute('aria-live', 'polite');
  const mkRow = (label) => {
    const row = document.createElement('div'); row.className = 'dm-state-row';
    const k = document.createElement('span'); k.className = 'dm-state-k'; k.textContent = label;
    const v = document.createElement('span'); v.className = 'dm-state-v';
    const tag = document.createElement('span'); tag.className = 'dm-tag';
    row.append(k, v, tag);
    stateCard.appendChild(row);
    return { v, tag };
  };
  const curRow = mkRow('当前默认');
  const cliRow = mkRow('CLI 默认');
  block.appendChild(stateCard);

  const actions = document.createElement('div');
  actions.className = 'dm-actions';
  const label = document.createElement('label');
  label.className = 'dm-select-label'; label.textContent = '选择模型';
  const select = document.createElement('hm-select');
  select.className = 'dm-select';
  select.setAttribute('aria-label', '选择要设为默认模型的模型');
  const dmOptions = () => select.setOptions(rows.map((r) => ({
    value: r.key, label: r.tag ? `${r.name} · ${r.tag}` : r.name,
  })));
  dmOptions();
  label.appendChild(select);
  const setBtn = document.createElement('button');
  setBtn.type = 'button'; setBtn.className = 'mk-btn primary dm-set';
  setBtn.textContent = '设为默认模型';
  const follow = document.createElement('button');
  follow.type = 'button'; follow.className = 'dm-link';
  follow.textContent = '跟随 CLI 默认';
  actions.append(label, setBtn, follow);
  block.appendChild(actions);

  const note = document.createElement('div');
  note.className = 'dm-note';
  note.textContent = '点击后立即写入桌面端配置并同步顶部模型选择器；不会改动 CLI 配置文件。';
  block.appendChild(note);

  function sync() {
    const cur = state.config.model || '';
    const same = !!cliDefault && cur === cliDefault;
    curRow.v.textContent = cur || '未设置';
    curRow.tag.textContent = cur ? '已生效' : '未设置';
    curRow.tag.className = 'dm-tag' + (cur ? ' on' : '');
    cliRow.v.textContent = cliDefault || '不可读取';
    cliRow.tag.textContent = cliDefault ? (same ? '一致' : '不同') : '未知';
    cliRow.tag.className = 'dm-tag' + (same ? ' on' : (cliDefault ? ' warn' : ''));
    if (cur && !rows.some((r) => r.key === cur)) {
      rows.push({ key: cur, name: cur + ' · 当前配置' });
      dmOptions();
    }
    select.value = cur || cliDefault || (rows[0] ? rows[0].key : '');
    setBtn.disabled = !select.value;
    follow.disabled = !cliDefault || same;
  }
  setBtn.onclick = () => {
    const v = select.value;
    if (!v) return;
    setModel(v);
    sync();
    a11y('默认模型已设为 ' + v);
  };
  follow.onclick = () => {
    if (!cliDefault) return;
    select.value = cliDefault;
    setModel(cliDefault);
    sync();
    a11y('已跟随 CLI 默认模型 ' + cliDefault);
  };
  // 表单内 Escape 只失焦，不冒泡到全局（否则会关掉整个设置页 / 中断生成回合）
  guardFieldKey(select, () => select.blur());
  sync();
  return block;
}

async function renderModelPanel(panel, cat) {
  // 本面板是 async：切分类后旧响应不得写进同一个 #set-panel
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  // 三路只读并行（configModelState 是纯文件读取、零子进程），任一失败降级为空列表不阻断面板
  const [ms, provRes, modelRes] = await Promise.all([
    (isNativeCLI() && typeof api.configModelState === 'function')
      ? api.configModelState().catch(() => null) : Promise.resolve(null),
    isNativeCLI() ? api.configProviders().catch(() => null) : Promise.resolve(null),
    isNativeCLI() ? api.configModels().catch(() => null) : Promise.resolve(null),
  ]);
  if (!alive()) return;
  const providers = provRes && provRes.ok ? arr(provRes.providers) : [];
  const models = modelRes && modelRes.ok ? arr(modelRes.models) : [];

  panel.appendChild(buildDefaultModelBlock(ms, models));

  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">提供商</div><div class="set-desc">${cat.desc}</div>`;
  panel.appendChild(head);
  const list = document.createElement('div'); list.className = 'set-provider-list';
  panel.appendChild(list);
  if (!providers.length) {
    const empty = document.createElement('div'); empty.className = 'set-row';
    empty.innerHTML = `<div class="set-row-main"><div class="set-row-label">${isNativeCLI() ? '未找到模型提供商' : '演示模式'}</div><div class="set-row-hint">${isNativeCLI() ? '检查 ~/.hermes/providers.json 或通过 hermes CLI 登录配置' : '真机运行时此处展示 hermes 的模型提供商'}</div></div>`;
    list.appendChild(empty);
  } else {
    providers.forEach((p) => {
      const count = models.filter((m) => m.provider === p.name).length;
      const row = document.createElement('div'); row.className = 'set-provider';
      row.innerHTML = `
        <span class="set-provider-dot"></span>
        <span class="set-provider-main">
          <span class="set-provider-name">${esc(p.name)}</span>
          <span class="set-provider-hint">${esc(p.baseUrl || '')}${count ? ` · ${count} 个模型` : ''}</span>
        </span>
        <button class="set-provider-edit" title="只读列表：点击打开配置文件">只读 · 打开配置</button>`;
      row.querySelector('.set-provider-edit').onclick = () => {
        if (isNativeCLI() && typeof api.configOpenFile === 'function') {
          api.configOpenFile('providersJson').then((r) => {
            if (!r || !r.ok) toast((r && r.error) || '请通过 hermes CLI 编辑 ~/.hermes/providers.json', 2400);
          }).catch(() => toast('请通过 hermes CLI 编辑 ~/.hermes/providers.json', 2400));
        } else {
          toast('提供商列表为只读（请通过 hermes CLI 编辑 providers.json）', 2400);
        }
      };
      list.appendChild(row);
    });
  }
  const add = document.createElement('button'); add.className = 'set-add-provider'; add.textContent = '配置说明：通过 CLI 添加/修改提供商（只读）';
  add.onclick = () => toast('请通过 hermes CLI 配置提供商（hermes login / config.yaml）', 2400);
  panel.appendChild(add);
}
/* ---------- 设置页：快捷键自定义（立即生效，独立存储） ---------- */
function shortcutsReset() {
  const ok = safeSet(SHORTCUT_STORE_KEY, '{}');
  _shortcutCache = null;
  return ok;
}
function renderShortcutPanel(panel, cat) {
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">键盘快捷键</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const map = shortcutMap();
  const groups = [...new Set(SHORTCUT_DEFS.map((d) => d.group))];
  groups.forEach((g) => {
    const gt = document.createElement('div'); gt.className = 'pp-group-label'; gt.textContent = g;
    panel.appendChild(gt);
    SHORTCUT_DEFS.filter((d) => d.group === g).forEach((d) => {
      const row = document.createElement('div'); row.className = 'set-row';
      row.innerHTML = `<div class="set-row-main"><div class="set-row-label">${esc(d.label)}</div>` +
        `<div class="set-row-hint">默认 ${esc(comboLabel(d.def))}</div></div>`;
      const wrap = document.createElement('div'); wrap.className = 'sk-control';
      const btn = document.createElement('button');
      btn.className = 'sk-key'; btn.type = 'button';
      btn.textContent = comboLabel(map[d.id]);
      btn.setAttribute('aria-label', `${d.label}，当前 ${comboLabel(map[d.id])}，点击录制新快捷键`);
      btn.onclick = () => {
        if (shortcutCapture) return;
        btn.classList.add('capturing'); btn.textContent = '请按组合键…';
        beginShortcutCapture(d.id, (combo, err) => {
          if (combo) shortcutsSave({ [d.id]: combo });
          if (err) toast(err, 2400);
          else toast(`${d.label} → ${comboLabel(combo)}`, 1800);
          renderSettingsPanel(); // 重绘以反映新键位 / 取消状态
          renderHelp(true);      // 帮助页同步，不残留旧键位
        });
      };
      const reset = document.createElement('button');
      reset.className = 'sk-reset'; reset.type = 'button';
      reset.textContent = '恢复默认'; reset.title = `恢复为 ${comboLabel(d.def)}`;
      reset.disabled = map[d.id] === d.def;
      reset.onclick = () => {
        const next = { ...shortcutsRead() }; delete next[d.id];
        shortcutsSave(next);
        renderSettingsPanel(); renderHelp(true);
        toast(`${d.label} 已恢复默认`, 1600);
      };
      wrap.append(btn, reset);
      row.appendChild(wrap);
      panel.appendChild(row);
    });
  });
  const foot = document.createElement('div'); foot.className = 'sk-foot';
  const note = document.createElement('span');
  note.textContent = '修改立即生效并保存在本机；Escape 保留给浮层关闭与中断生成，? 保留给帮助。';
  const all = document.createElement('button');
  all.type = 'button'; all.className = 'sk-reset'; all.textContent = '全部恢复默认';
  all.onclick = () => { shortcutsReset(); renderSettingsPanel(); renderHelp(true); toast('快捷键已全部恢复默认', 1600); };
  foot.append(note, all);
  panel.appendChild(foot);
}

/* ---------- 设置页：记忆（只读诊断 + 文件元信息，无写操作） ---------- */
async function renderMemoryPanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">记忆状态</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const statusBox = document.createElement('div'); statusBox.className = 'mem-status';
  statusBox.textContent = isNativeCLI() ? '正在读取…' : '演示模式：需要桌面端原生环境读取 CLI 记忆状态。';
  panel.appendChild(statusBox);
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新 CLI 状态';
  refresh.disabled = !isNativeCLI();
  refresh.onclick = async () => {
    refresh.disabled = true; statusBox.textContent = '正在执行只读诊断（hermes memory status）…';
    try {
      const r = await api.diagnosticsRun('memory:status');
      statusBox.textContent = r && r.text ? r.text : (r && r.error) || 'CLI 未返回内容';
      statusBox.classList.toggle('is-error', !(r && r.ok));
    } catch (e) { statusBox.textContent = '读取失败：' + (e && e.message ? e.message : e); statusBox.classList.add('is-error'); }
    refresh.disabled = false;
  };
  panel.appendChild(refresh);

  const fTitle = document.createElement('div'); fTitle.className = 'pp-group-label'; fTitle.textContent = '内置记忆文件';
  panel.appendChild(fTitle);
  const list = document.createElement('div'); list.className = 'mem-files';
  list.innerHTML = '<div class="set-row-hint">正在读取…</div>';
  panel.appendChild(list);
  const note = document.createElement('div'); note.className = 'pf-note';
  note.innerHTML = `内置记忆（<code>MEMORY.md</code> / <code>USER.md</code>）由 hermes CLI 始终启用；` +
    `外部记忆 provider 的启停、配置与重置是交互式写操作，桌面端不代劳，请在终端执行 ` +
    `<code>hermes memory setup|off|reset</code>。此页只读取状态与文件元信息，不读取记忆正文、不改动任何文件。`;
  panel.appendChild(note);

  let files = [];
  if (isNativeCLI()) {
    try { const r = await api.diagnosticsMemoryFiles(); if (r && r.ok) files = arr(r.files); } catch {}
  }
  if (!alive()) return;
  list.innerHTML = '';
  if (!files.length) {
    list.innerHTML = '<div class="set-row-hint">未读取到记忆文件信息。</div>';
  } else {
    files.forEach((f) => {
      const row = document.createElement('div'); row.className = 'set-row';
      const when = f.mtime ? new Date(f.mtime).toLocaleString('zh-CN') : '—';
      row.innerHTML = `<div class="set-row-main"><div class="set-row-label">${esc(f.name)}</div>` +
        `<div class="set-row-hint">${f.exists ? `${fmtBytes(f.bytes)} · 更新于 ${esc(when)}` : '尚未创建'}</div></div>`;
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'sk-reset'; open.textContent = '打开文件';
      open.disabled = !f.exists || !isNativeCLI();
      open.onclick = async () => {
        const key = f.name === 'MEMORY.md' ? 'memoryMd' : 'userMd';
        const r = await api.configOpenFile(key);
        if (!r || !r.ok) toast((r && r.error) || '打开失败', 2200);
      };
      row.appendChild(open);
      list.appendChild(row);
    });
  }
  // 打开设置页即拉取一次只读状态，不阻塞其它分区
  if (isNativeCLI()) refresh.click();
}

/* ---------- 设置页：工具集开关（CLI 为准，操作后回读） ----------
   只展示 / 只修改 cli 平台分段：`hermes tools list` 在接入 telegram、discord 后
   会多出同名分段，那些开关必须留给对应平台的设置，桌面端不代劳。
   开关不做「乐观更新后就不管」：失败把开关拨回去并提示；成功用 CLI 回读的
   真实状态重绘，避免界面与配置文件不一致（CLI 静默失败时最容易出现这种幻觉）。 */
function toolRow(item, onToggle) {
  const row = document.createElement('div'); row.className = 'set-row';
  const main = document.createElement('div'); main.className = 'set-row-main';
  const label = document.createElement('div'); label.className = 'set-row-label';
  // label 来自 CLI 输出（含 emoji），一律走 textContent，不进 innerHTML
  label.textContent = item.label || item.name;
  const hint = document.createElement('div'); hint.className = 'set-row-hint';
  hint.textContent = item.name;
  main.append(label, hint);
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'plg-switch' + (item.enabled ? ' on' : '');
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', item.enabled ? 'true' : 'false');
  sw.setAttribute('aria-label', (item.label || item.name) + ' 开关');
  sw.onclick = () => onToggle(item, sw);
  row.append(main, sw);
  return row;
}
async function renderToolsPanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">工具集 · CLI 平台</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const status = document.createElement('div'); status.className = 'mem-status';
  status.textContent = isNativeCLI() ? '正在读取工具列表…' : '演示模式：需要桌面端原生环境读取 CLI 工具列表。';
  panel.appendChild(status);
  const list = document.createElement('div'); list.className = 'tool-list';
  panel.appendChild(list);
  const note = document.createElement('div'); note.className = 'pf-note';
  note.innerHTML = '开关等同 <code>hermes tools enable|disable &lt;name&gt;</code>（默认 cli 平台）。' +
    '关闭 <code>terminal</code> / <code>file</code> 后 agent 将无法执行命令或改文件，请谨慎操作。' +
    '其它平台（Telegram / Discord 等）的工具集不在此页展示。';
  panel.appendChild(note);

  let others = [];
  let staleNow = false;
  const draw = (sections) => {
    list.innerHTML = '';
    const total = (sections || []).reduce((n, s) => n + s.items.length, 0);
    const on = (sections || []).reduce((n, s) => n + s.items.filter((i) => i.enabled).length, 0);
    status.textContent = `已启用 ${on}/${total}` + (others.length
      ? `（另有 ${others.join(' / ')} 平台的工具集未在此展示）` : '') +
      (staleNow ? ' · 后台刷新中' : '');
    status.classList.remove('is-error');
    if (!sections || !sections.length) {
      list.innerHTML = '<div class="set-row-hint">未读取到工具集。</div>';
      return;
    }
    sections.forEach((sec) => {
      const gt = document.createElement('div'); gt.className = 'pp-group-label';
      gt.textContent = `${sec.title}（${sec.items.filter((i) => i.enabled).length}/${sec.items.length} 已启用）`;
      list.appendChild(gt);
      sec.items.forEach((item) => list.appendChild(toolRow(item, toggle)));
    });
  };

  let busy = false;
  async function toggle(item, sw) {
    if (busy) return;
    busy = true;
    const next = !sw.classList.contains('on');
    const prev = sw.classList.contains('on');
    // 先给即时反馈，结果回来再对齐
    sw.classList.toggle('on', next);
    sw.setAttribute('aria-checked', next ? 'true' : 'false');
    sw.disabled = true;
    try {
      const r = await api.toolsToggle(item.name, next);
      if (r && r.ok) {
        toast(`${item.label || item.name} 已${r.enabled ? '启用' : '停用'}`, 1600);
        if (r.sections) draw(r.sections);
      } else {
        sw.classList.toggle('on', prev);
        sw.setAttribute('aria-checked', prev ? 'true' : 'false');
        toast(`操作失败：${(r && r.error) || '未知错误'}`, 3200);
        if (r && r.sections) draw(r.sections);
      }
    } catch (e) {
      sw.classList.toggle('on', prev);
      toast('操作失败：' + ((e && e.message) || e), 3000);
    }
    sw.disabled = false;
    busy = false;
  }

  let r = null;
  if (isNativeCLI()) {
    status.textContent = '正在读取工具列表…';
    try { r = await api.toolsList(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  }
  if (!isNativeCLI()) { status.textContent = '演示模式：不做 CLI 调用。'; return; }
  if (!alive()) return;
  if (!r || !r.ok) {
    status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
    status.classList.add('is-error');
    return;
  }
  others = arr(r.otherPlatforms);
  staleNow = !!r.stale;
  draw(r.sections);
  // 后台刷新完成：重取一次（主进程内存已最新，毫秒返回）并原地重绘
  subscribeCatalog((p) => {
    if (!p || p.kind !== 'tools' || !panel.isConnected) return;
    api.toolsList().then((rr) => {
      if (!rr || !rr.ok || !panel.isConnected) return;
      others = arr(rr.otherPlatforms);
      staleNow = !!rr.stale;
      draw(rr.sections);
    }).catch(() => {});
  });
}

/* ---------- 设置页：MCP 服务器 / 定时任务 ----------
   两者都完全以 hermes CLI 为真源。危险写操作统一走「内联确认卡」：
   先明示将执行的 CLI 命令与影响，二次点击才下发；所有来自 CLI 的文本
   一律走 textContent，不进 innerHTML。异步结果用 settingsPanelEpoch 作废旧响应。 */

/** 危险操作的内联确认卡。返回插入的 DOM，取消即移除，不改动任何数据。 */
function opConfirm(host, { title, cmd, note, confirmLabel = '确认执行', onGo }) {
  host.querySelectorAll('.op-confirm').forEach((n) => n.remove());
  const box = document.createElement('div');
  box.className = 'op-confirm';
  const h = document.createElement('div'); h.className = 'op-confirm-title'; h.textContent = title;
  const pre = document.createElement('code'); pre.className = 'op-confirm-cmd'; pre.textContent = cmd;
  const p = document.createElement('p'); p.className = 'op-confirm-note'; p.textContent = note;
  const btns = document.createElement('div'); btns.className = 'op-confirm-btns';
  const go = document.createElement('button');
  go.type = 'button'; go.className = 'mk-btn primary'; go.textContent = confirmLabel;
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'mk-btn'; cancel.textContent = '取消';
  cancel.onclick = () => box.remove();
  go.onclick = async () => { box.remove(); await onGo(); };
  btns.append(go, cancel);
  box.append(h, pre, p, btns);
  host.appendChild(box);
  try { go.focus({ preventScroll: true }); } catch { /* 已卸载 */ }
  return box;
}

/**
 * 「上游思考输出」：CLI 的 display.show_reasoning 为 false 时，网关一条 reasoning.delta
 * 都不会发（`agent_callbacks._emit_reasoning_delta` 直接短路），桌面端不可能凭空显示思考；
 * 之前的「思考过程」块里其实是 thinking.delta 的颜文字等待提示，所以看起来是空的。
 *
 * 这里只读状态 → 需要时出二次确认卡 → 调 `hermes config set display.show_reasoning`。
 * 写的是 CLI 配置（命令行同样受影响），因此只能由用户点卡确认，绝不自动执行。
 */
async function enableUpstreamReasoning(host) {
  if (!isNativeCLI() || typeof api.reasoningDisplay !== 'function') {
    toast('仅桌面版可读写 CLI 配置', 2400); return;
  }
  let st = null;
  try { st = await api.reasoningDisplay(); }
  catch (e) { st = { ok: false, error: String((e && e.message) || e) }; }
  if (!st || !st.ok) { toast('读取 CLI 配置失败：' + ((st && st.error) || '未知错误'), 3200); return; }
  if (st.enabled) { toast('上游已开启思考输出（display.show_reasoning: true）', 2800); return; }
  const cardHost = (host && (host.querySelector('.set-row-main') || host)) || $('#set-panel');
  opConfirm(cardHost, {
    title: '打开 CLI 的思考输出？',
    cmd: 'hermes config set display.show_reasoning true',
    note: `将写入 ${st.configPath} 的 display.show_reasoning: true。这一项同时决定命令行（hermes CLI / TUI）是否显示思考过程；`
      + '已经打开的会话仍按旧值运行，需要新开一个会话（⌘N）才会拿到思考内容。',
    confirmLabel: '写入并打开',
    onGo: async () => {
      let r = null;
      try { r = await api.setReasoningDisplay(true); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || !r.ok) { toast('写入失败：' + ((r && r.error) || '未知错误'), 3600); return; }
      toast('已打开思考输出 · 新开会话（⌘N）后即可看到', 4000);
    },
  });
}

/** 表单输入里的 Escape 只收起本表单，不冒泡到全局（否则会关掉整个设置页）。 */function guardFieldKey(el, onEscape) {
  el.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onEscape(); }
  };
}
function fieldRow(label, hint, input) {
  const wrap = document.createElement('div'); wrap.className = 'op-field';
  const lab = document.createElement('label'); lab.className = 'op-field-label'; lab.textContent = label;
  const inp = input;
  lab.appendChild(inp);
  wrap.appendChild(lab);
  if (hint) { const h = document.createElement('div'); h.className = 'op-field-hint'; h.textContent = hint; wrap.appendChild(h); }
  return wrap;
}
function textField(placeholder, maxLength) {
  const i = document.createElement('input');
  i.type = 'text'; i.className = 'set-input op-input'; i.placeholder = placeholder;
  i.spellcheck = false; i.maxLength = maxLength || 120;
  return i;
}

/* ---------------- MCP 服务器 ---------------- */
async function renderMcpPanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">MCP 服务器</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);

  const bar = document.createElement('div'); bar.className = 'op-bar';
  const status = document.createElement('div'); status.className = 'mem-status';
  status.textContent = isNativeCLI() ? '正在读取服务器列表…' : '演示模式：需要桌面端原生环境读取 MCP 配置。';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新';
  bar.append(status, refresh); panel.appendChild(bar);

  const list = document.createElement('div'); list.className = 'op-list'; panel.appendChild(list);

  const addWrap = document.createElement('div'); addWrap.className = 'op-form';
  const addTitle = document.createElement('div'); addTitle.className = 'pp-group-label'; addTitle.textContent = '添加服务器（URL）';
  addWrap.appendChild(addTitle);
  const nameIn = textField('名称，如 my-server', 64);
  const urlIn = textField('https://… 或 http://127.0.0.1:端口/…', 300);
  const timeoutIn = textField('连接超时（秒，1–60）', 3); timeoutIn.value = '10';
  const addBtns = document.createElement('div'); addBtns.className = 'op-form-btns';
  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'mk-btn primary'; addBtn.textContent = '添加';
  const addClear = document.createElement('button');
  addClear.type = 'button'; addClear.className = 'mk-btn'; addClear.textContent = '清空';
  addBtns.append(addBtn, addClear);
  addWrap.append(fieldRow('名称', '只允许字母、数字、_ . -；会作为 config.yaml 的键。', nameIn),
    fieldRow('地址', '仅 https 或本机 http。添加时会真实连接并发现工具，工具默认全部启用。', urlIn),
    fieldRow('连接超时', '', timeoutIn), addBtns);
  guardFieldKey(nameIn, () => addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(urlIn, () => addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(timeoutIn, () => addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  addClear.onclick = () => { nameIn.value = ''; urlIn.value = ''; timeoutIn.value = '10'; addWrap.querySelectorAll('.op-confirm').forEach((n) => n.remove()); };
  panel.appendChild(addWrap);

  const note = document.createElement('div'); note.className = 'pf-note';
  note.textContent = '仅提供 URL 型接入。stdio 型（--command/--args）、OAuth 登录与工具筛选是 CLI 的交互式流程，请在终端用 hermes mcp add / login / configure 完成。移除会改写 CLI 的 config.yaml，其它平台不受影响。';
  panel.appendChild(note);

  let servers = [];
  let staleNow = false;
  const draw = () => {
    list.innerHTML = '';
    const on = servers.filter((s) => s.enabled).length;
    status.textContent = `已配置 ${servers.length} 个 · 启用 ${on} 个` + (staleNow ? ' · 后台刷新中' : '');
    status.classList.remove('is-error');
    if (!servers.length) {
      const empty = document.createElement('div'); empty.className = 'op-empty';
      empty.textContent = '尚未配置 MCP 服务器。'; list.appendChild(empty); return;
    }
    servers.forEach((s) => list.appendChild(mcpCard(s)));
  };

  function mcpCard(s) {
    const card = document.createElement('div'); card.className = 'op-card';
    const top = document.createElement('div'); top.className = 'op-card-top';
    const name = document.createElement('span'); name.className = 'op-name'; name.textContent = s.name;
    const badge = document.createElement('span');
    badge.className = 'op-badge' + (s.enabled ? ' on' : '');
    badge.textContent = s.enabled ? '已启用' : '已停用';
    top.append(name, badge);
    const meta = document.createElement('div'); meta.className = 'op-meta';
    const tr = document.createElement('code'); tr.className = 'op-code'; tr.textContent = s.transport;
    const tools = document.createElement('span'); tools.textContent = '工具 ' + s.tools;
    meta.append(tr, tools);
    const acts = document.createElement('div'); acts.className = 'op-acts';
    const testBtn = document.createElement('button');
    testBtn.type = 'button'; testBtn.className = 'mk-btn'; testBtn.textContent = '测试连接';
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'mk-btn danger'; delBtn.textContent = '移除';
    acts.append(testBtn, delBtn);
    const out = document.createElement('div'); out.className = 'op-out'; out.hidden = true;
    card.append(top, meta, acts, out);

    testBtn.onclick = async () => {
      if (!isNativeCLI()) { toast('演示模式不可用', 1800); return; }
      testBtn.disabled = true; testBtn.textContent = '测试中…';
      out.hidden = false; out.textContent = '正在连接并发现工具（最多 60 秒）…';
      let r;
      try { r = await api.mcpTest(s.name); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!alive()) return;
      testBtn.disabled = false; testBtn.textContent = '测试连接';
      out.textContent = '';
      if (!r || !r.ok) { out.textContent = '测试失败：' + ((r && r.error) || '未知错误'); out.classList.add('is-error'); return; }
      out.classList.remove('is-error');
      const line = document.createElement('div'); line.className = 'op-out-head';
      line.textContent = r.connected
        ? `✓ 连接成功 · ${r.latencyMs == null ? '' : r.latencyMs + 'ms · '}${r.toolCount} 个工具`
        : '✗ 未连接';
      out.appendChild(line);
      if (r.transport) { const t = document.createElement('div'); t.textContent = r.transport; out.appendChild(t); }
      if (r.tools && r.tools.length) {
        const pre = document.createElement('pre'); pre.className = 'op-pre'; pre.textContent = r.tools.join('\n');
        out.appendChild(pre);
      }
      if (r.error) { const e = document.createElement('div'); e.textContent = r.error; out.appendChild(e); }
    };
    delBtn.onclick = () => opConfirm(card, {
      title: `移除「${s.name}」？`,
      cmd: `hermes -p <current> mcp remove ${s.name}`,
      note: '会从 CLI 的 config.yaml 删除该服务器，正在使用它的会话需要重开才生效。此操作不可撤销。',
      confirmLabel: '确认移除',
      onGo: async () => { await applyWrite(() => api.mcpRemove(s.name), '已移除', '移除失败'); },
    });
    return card;
  }

  async function applyWrite(fn, okMsg, failMsg) {
    if (!isNativeCLI()) { toast('演示模式不可用', 1800); return false; }
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return false;
    if (!r || !r.ok) { toast(`${failMsg}：${(r && r.error) || '未知错误'}`, 3400); return false; }
    if (Array.isArray(r.servers)) { servers = r.servers; draw(); }
    else { await reload(); }
    toast(r.warning || okMsg, r.warning ? 3200 : 1600);
    return true;
  }

  addBtn.onclick = () => opConfirm(addWrap, {
    title: '添加一个 MCP 服务器？',
    cmd: `hermes -p <current> mcp add ${nameIn.value.trim() || '<name>'} --url ${urlIn.value.trim() || '<url>'}`,
    note: '会写入 CLI 的 config.yaml 并真实连接该地址、发现工具（默认全部启用）。连接失败时 CLI 默认不保存配置。请确认来源可信。',
    confirmLabel: '确认添加',
      onGo: () => applyWrite(() => api.mcpAdd({
        name: nameIn.value.trim(), url: urlIn.value.trim(), connectTimeout: Number(timeoutIn.value),
      }), '已添加', '添加失败').then((ok) => {
        if (ok) { nameIn.value = ''; urlIn.value = ''; timeoutIn.value = '10'; }
      }),
  });

  async function reload(opts = {}) {
    if (!isNativeCLI()) { status.textContent = '演示模式：不做 CLI 调用。'; return; }
    status.textContent = opts.force ? '正在重新读取 MCP 服务器（约 2–3 秒）…' : '正在读取 MCP 服务器…';
    let r;
    try { r = await api.mcpList(opts); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error'); return;
    }
    servers = arr(r.servers);
    staleNow = !!r.stale;
    draw();
    if (r.warning) toast(`列表刷新失败，显示上次结果：${r.warning}`, 3200);
  }
  refresh.onclick = () => reload({ force: true });
  await reload();
  // 后台刷新完成：重取缓存里的新列表并重绘（不阻塞、不闪）
  subscribeCatalog((p) => {
    if (!p || p.kind !== 'mcp' || !alive()) return;
    api.mcpList().then((rr) => {
      if (!rr || !rr.ok || !alive()) return;
      servers = arr(rr.servers);
      staleNow = !!rr.stale;
      draw();
    }).catch(() => {});
  });
}

/* ---------------- 定时任务 ---------------- */
/**
 * 设置页「看板编排」：三档模式的唯一入口。
 *
 * 这里写的是 hermes CLI 的 config.yaml（kanban 段），改的是 gateway 的自动派发 ——
 * 不只是本应用，所以每次改动都过二次确认卡，并把「要不要重启」如实写在结果里。
 * 模式本身不存储：它是 auto_decompose / dispatch_in_gateway 两个布尔的派生值。
 */
async function renderKanbanModePanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;

  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">看板编排</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);

  // 底部那个「保存」写的是本地 localStorage，对编排开关无效 —— 收起来，
  // 只留面板内的「应用」这一个写入口，两个入口会让人不知道该按哪个。
  const saveBtn = $('#set-save'), hintEl = $('#set-hint');
  if (saveBtn) saveBtn.hidden = true;
  if (hintEl) hintEl.textContent = '此页的改动点「应用」才写入 CLI 配置';

  const bar = document.createElement('div'); bar.className = 'op-bar';
  const status = document.createElement('div'); status.className = 'mem-status';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新';
  bar.append(status, refresh); panel.appendChild(bar);

  const stage = document.createElement('div'); panel.appendChild(stage);

  const note = document.createElement('div'); note.className = 'pf-note';
  note.textContent = '写的是 hermes CLI 的 config.yaml（kanban 段），影响 gateway 的自动派发，不只是这个应用。'
    + '自动分解每轮重读，下一轮 tick 就生效；派发器开关只在 gateway 启动时读一次，改完必须重启 gateway。';
  panel.appendChild(note);

  let state = null;   // 最近一次回读的生效值
  let pick = null;    // 用户选中但未应用的档位
  let busy = false;

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button'; applyBtn.className = 'mk-btn primary'; applyBtn.textContent = '应用';
  const actions = document.createElement('div'); actions.className = 'kbm-actions';
  const hint = document.createElement('div'); hint.className = 'set-row-hint';
  actions.append(applyBtn, hint);

  /** 会写进 config.yaml 的键值，逐行列出（不是假命令行，是真的键）。 */
  const planLines = (modeId) => {
    const m = state && state.modes ? state.modes.find((x) => x.id === modeId) : null;
    if (!m) return '';
    const lines = [];
    if (state.autoDecompose !== m.decompose) lines.push(`kanban.auto_decompose = ${m.decompose}`);
    if (state.dispatchInGateway !== m.dispatch) lines.push(`kanban.dispatch_in_gateway = ${m.dispatch}`);
    return lines.length ? lines.join('\n') : '（与当前一致，不会有任何写入）';
  };

  const draw = () => {
    stage.innerHTML = '';
    if (!state) { status.textContent = '当前模式读取失败'; return; }
    const sw = [];
    sw.push(`派发器${state.dispatchInGateway ? '运行中' : '已停止'}`);
    sw.push(`自动分解${state.autoDecompose ? '开' : '关'}`);
    if (state.autoPromoteChildren) sw.push('子任务自动推进开');
    status.textContent = `${state.modeLabel} · ${sw.join(' · ')}`;
    status.classList.remove('is-error');

    const group = document.createElement('div');
    group.className = 'kbm-list';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', '看板编排模式');
    (state.modes || []).forEach((m) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'kbm-card' + (m.id === pick ? ' on' : '');
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', m.id === pick ? 'true' : 'false');
      card.dataset.mode = m.id;
      // 远端 / 档位文案一律 textContent，绝不拼进 innerHTML
      const name = document.createElement('b'); name.textContent = m.label;
      const sum = document.createElement('span'); sum.textContent = m.summary;
      card.append(name, sum);
      if (m.id === pick) {
        const det = document.createElement('em'); det.textContent = m.detail;
        card.appendChild(det);
        if (m.needsRestart) {
          const warn = document.createElement('em'); warn.className = 'kbm-warn';
          warn.textContent = '这一档关掉的是 gateway 里的派发器，改完必须重启 gateway 才生效。';
          card.appendChild(warn);
        }
      }
      card.onclick = () => { if (busy) return; pick = m.id; draw(); };
      group.appendChild(card);
    });
    stage.appendChild(group);
    // 操作紧跟在卡片后面：三张卡 + 「应用」要能在首屏同时看到，
    // 生效值明细是可以滚着看的次要信息，不能把它们顶到折叠线以下。
    stage.appendChild(actions);

    // 明细是「现在生效的值」，不是「改完会变成的值」—— 不标清楚，
    // 选了全手动却看到 auto_decompose=开，会以为没生效。
    const factsLabel = document.createElement('div');
    factsLabel.className = 'set-row-hint';
    factsLabel.textContent = '当前生效值（不含尚未应用的改动）';
    stage.appendChild(factsLabel);

    const facts = document.createElement('div'); facts.className = 'kbm-facts';
    const rows = [
      ['自动分解', 'auto_decompose', state.autoDecompose ? '开' : '关', '下一轮 tick 生效'],
      ['派发器', 'dispatch_in_gateway', state.dispatchInGateway ? '开' : '关', '改动需重启 gateway'],
      ['子任务自动推进', 'auto_promote_children', state.autoPromoteChildren ? '开' : '关', ''],
      ['默认受让人', 'default_assignee', state.resolvedAssignee || state.defaultAssignee || '（跟随当前 profile）', ''],
    ];
    rows.forEach(([label, key, val, tip]) => {
      const r = document.createElement('div');
      const a = document.createElement('b'); a.textContent = label;
      const b = document.createElement('span'); b.textContent = key;
      const c = document.createElement('i'); c.textContent = val;
      r.append(a, b, c);
      if (tip) { const t = document.createElement('u'); t.textContent = tip; r.appendChild(t); }
      facts.appendChild(r);
    });
    stage.appendChild(facts);

    if (state.decomposeStranded) {
      const warn = document.createElement('div'); warn.className = 'kbm-warn';
      warn.textContent = '自动分解还开着，但派发器已停 —— 分解出来的卡只会堆在就绪队列里没人认领。';
      stage.appendChild(warn);
    }
    if (state.degraded) {
      const w = document.createElement('div'); w.className = 'kbm-warn';
      w.textContent = '看板后端暂不可用'
        + (state.restError ? `（${state.restError}）` : '')
        + '：上面是 config.yaml 里的值，可能与运行中 gateway 的实际状态不一致，此时切换也无法写入。';
      stage.appendChild(w);
    }

    applyBtn.disabled = busy || !pick || pick === state.mode;
    hint.textContent = pick && pick !== state.mode
      ? `将写入：${planLines(pick).replace(/\n/g, '；')}`
      : '当前没有待应用的改动';
  };

  const runApply = async (modeId) => {
    busy = true; applyBtn.disabled = true;
    status.classList.remove('is-error');
    status.textContent = '正在写入 CLI 配置…（派发器开关要冷启 CLI，约 5–10 秒）';
    let r = null;
    try { r = await api.kanbanSetMode(modeId); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    busy = false;
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '切换失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error');
      draw();
      return;
    }
    state = r.state || state;
    pick = state.mode;
    draw();
    if (hintEl) hintEl.textContent = r.needsRestart ? '已写入 CLI 配置 · 需重启 gateway' : '已写入 CLI 配置';
    // 看板页头那枚只读标记跟着更新：模式一变，卡会不会自己跑掉就变了
    try { kbLoadMode(); } catch {}
    if (r.needsRestart) {
      status.textContent = '已写入。需要重启 gateway 才生效：hermes gateway restart';
      toast('已保存，需重启 gateway 生效', 3200);
    } else {
      status.textContent = '已生效（下一轮 tick 生效，不用重启）';
      toast('看板编排已切换', 1800);
    }
  };

  applyBtn.onclick = () => {
    if (!state || busy || !pick || pick === state.mode) return;
    const m = (state.modes || []).find((x) => x.id === pick);
    if (!m) return;
    opConfirm(stage, {
      title: `把看板编排改成「${m.label}」？`,
      cmd: planLines(pick),
      note: m.dispatch
        ? '改的是 gateway 的自动派发行为，下一轮 tick 生效，不需要重启。'
        : '这一档会停掉 gateway 里的派发器：改完必须重启 gateway 才真正生效，且所有看板都不再自动派发。',
      confirmLabel: '确认切换',
      onGo: () => runApply(pick),
    });
  };

  const load = async () => {
    if (!isNativeCLI()) {
      status.textContent = '演示模式：需要桌面端原生环境读取编排开关。';
      return;
    }
    status.textContent = '正在读取当前模式…';
    let r = null;
    try { r = await api.kanbanOrchestration(); } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error');
      return;
    }
    state = r;
    pick = r.mode;
    draw();
  };
  refresh.onclick = () => { if (!busy) load(); };
  await load();
}

async function renderCronPanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">定时任务</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);

  const bar = document.createElement('div'); bar.className = 'op-bar';
  const status = document.createElement('div'); status.className = 'mem-status';
  status.textContent = isNativeCLI() ? '正在读取调度器与任务…' : '演示模式：需要桌面端原生环境读取定时任务。';
  const refresh = document.createElement('button');
  refresh.type = 'button'; refresh.className = 'mem-refresh'; refresh.textContent = '刷新';
  bar.append(status, refresh); panel.appendChild(bar);

  const list = document.createElement('div'); list.className = 'op-list'; panel.appendChild(list);

  const runsWrap = document.createElement('div'); runsWrap.className = 'op-out'; runsWrap.hidden = true;
  panel.appendChild(runsWrap);

  const form = document.createElement('div'); form.className = 'op-form';
  const fTitle = document.createElement('div'); fTitle.className = 'pp-group-label'; fTitle.textContent = '新建任务';
  form.appendChild(fTitle);
  const schedIn = textField('30m / every 2h / 0 9 * * *', 64);
  const nameIn = textField('任务名称（可选）', 80);
  const promptIn = document.createElement('textarea');
  promptIn.className = 'set-input op-input op-textarea'; promptIn.placeholder = '任务内容（可选，自包含的提示词）';
  promptIn.spellcheck = false; promptIn.maxLength = 4000; promptIn.rows = 3;
  const fBtns = document.createElement('div'); fBtns.className = 'op-form-btns';
  const createBtn = document.createElement('button');
  createBtn.type = 'button'; createBtn.className = 'mk-btn primary'; createBtn.textContent = '创建（暂停）';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button'; clearBtn.className = 'mk-btn'; clearBtn.textContent = '清空';
  fBtns.append(createBtn, clearBtn);
  const presets = document.createElement('div');
  presets.className = 'op-form-btns';
  presets.style.marginBottom = '6px';
  for (const [label, val] of [['每 15 分钟', 'every 15m'], ['每小时', 'every 1h'], ['每天 9:00', '0 9 * * *'], ['工作日 9:00', '0 9 * * 1-5']]) {
    const pb = document.createElement('button');
    pb.type = 'button'; pb.className = 'mk-btn'; pb.textContent = label;
    pb.onclick = () => { schedIn.value = val; schedIn.focus(); };
    presets.appendChild(pb);
  }
  form.append(fieldRow('调度', '支持相对间隔、every 间隔与 5 段 cron 表达式。', schedIn),
    presets,
    fieldRow('名称', '', nameIn), fieldRow('内容', '每行会原样作为 CLI 的位置参数；不要以 - 开头。', promptIn), fBtns);
  guardFieldKey(schedIn, () => form.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(nameIn, () => form.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  guardFieldKey(promptIn, () => form.querySelectorAll('.op-confirm').forEach((n) => n.remove()));
  clearBtn.onclick = () => { schedIn.value = ''; nameIn.value = ''; promptIn.value = ''; form.querySelectorAll('.op-confirm').forEach((n) => n.remove()); };
  panel.appendChild(form);

  const note = document.createElement('div'); note.className = 'pf-note';
  note.textContent = '新建任务恒为暂停（--paused），需手动「恢复」才会按计划唤醒 agent。「立即运行」会真实触发一次模型回合并消耗额度；移除不可撤销。调度器由桌面端常驻后端驱动，关闭应用后任务不会触发。';
  panel.appendChild(note);

  let jobs = [];
  const draw = () => {
    list.innerHTML = '';
    const active = jobs.filter((j) => j.state === 'active').length;
    status.textContent = `${jobs.length} 个任务 · ${active} 个活跃` +
      (scheduler && scheduler.running ? ' · 调度器运行中' : ' · 调度器未就绪');
    status.classList.remove('is-error');
    if (!jobs.length) {
      const empty = document.createElement('div'); empty.className = 'op-empty';
      empty.textContent = '暂无定时任务。'; list.appendChild(empty); return;
    }
    jobs.forEach((j) => list.appendChild(cronCard(j)));
  };
  let scheduler = null;

  function kv(label, value, code) {
    if (!value) return null;
    const row = document.createElement('div'); row.className = 'op-kv';
    const k = document.createElement('span'); k.className = 'op-kv-k'; k.textContent = label;
    const v = document.createElement('span'); v.className = code ? 'op-code' : 'op-kv-v'; v.textContent = value;
    row.append(k, v); return row;
  }

  function cronCard(j) {
    const card = document.createElement('div'); card.className = 'op-card';
    const top = document.createElement('div'); top.className = 'op-card-top';
    const name = document.createElement('span'); name.className = 'op-name'; name.textContent = j.name;
    const badge = document.createElement('span');
    const stateMap = { active: '活跃', paused: '已暂停', completed: '已完成', disabled: '已停用' };
    badge.className = 'op-badge' + (j.state === 'active' ? ' on' : '');
    badge.textContent = stateMap[j.state] || j.state;
    top.append(name, badge); card.appendChild(top);
    const grid = document.createElement('div'); grid.className = 'op-grid';
    [kv('任务 ID', j.id, true), kv('调度', j.schedule), kv('下次运行', j.nextRun),
      kv('重复', j.repeat), kv('投递', j.deliver), kv('上次运行', j.lastRun)]
      .forEach((n) => { if (n) grid.appendChild(n); });
    card.appendChild(grid);
    const acts = document.createElement('div'); acts.className = 'op-acts';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button'; toggleBtn.className = 'mk-btn';
    toggleBtn.textContent = j.state === 'active' ? '暂停' : '恢复';
    const runBtn = document.createElement('button');
    runBtn.type = 'button'; runBtn.className = 'mk-btn'; runBtn.textContent = '立即运行';
    const histBtn = document.createElement('button');
    histBtn.type = 'button'; histBtn.className = 'mk-btn'; histBtn.textContent = '运行历史';
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'mk-btn danger'; delBtn.textContent = '移除';
    acts.append(toggleBtn, runBtn, histBtn, delBtn);
    card.appendChild(acts);

    toggleBtn.onclick = () => opConfirm(card, {
      title: `${j.state === 'active' ? '暂停' : '恢复'}「${j.name}」？`,
      cmd: `hermes -p <current> cron ${j.state === 'active' ? 'pause' : 'resume'} ${j.id}`,
      note: j.state === 'active' ? '暂停后不再按计划触发，任务与配置保留。' : '恢复后会重新排入下一次触发时间。',
      confirmLabel: j.state === 'active' ? '确认暂停' : '确认恢复',
      onGo: () => write(() => api.cronAction(j.state === 'active' ? 'pause' : 'resume', j.id), '已更新', '操作失败'),
    });
    runBtn.onclick = () => opConfirm(card, {
      title: `立即运行「${j.name}」？`,
      cmd: `hermes -p <current> cron run ${j.id}`,
      note: '会真实触发一次完整的 agent 回合并消耗模型额度，最长等待 60 秒。',
      confirmLabel: '确认运行',
      onGo: () => write(() => api.cronAction('run', j.id), '已触发', '触发失败'),
    });
    delBtn.onclick = () => opConfirm(card, {
      title: `移除「${j.name}」？`,
      cmd: `hermes -p <current> cron remove ${j.id}`,
      note: '任务及其调度配置会被删除，此操作不可撤销。',
      confirmLabel: '确认移除',
      onGo: () => write(() => api.cronAction('remove', j.id), '已移除', '移除失败'),
    });
    histBtn.onclick = async () => {
      if (!isNativeCLI()) { toast('演示模式不可用', 1800); return; }
      histBtn.disabled = true; histBtn.textContent = '读取中…';
      let r;
      try { r = await api.cronRuns(j.id, 20); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!alive()) return;
      histBtn.disabled = false; histBtn.textContent = '运行历史';
      runsWrap.hidden = false; runsWrap.textContent = '';
      const t = document.createElement('div'); t.className = 'op-out-head';
      t.textContent = `${j.name} · 最近运行记录`; runsWrap.appendChild(t);
      if (!r || !r.ok) { runsWrap.appendChild(document.createTextNode('读取失败：' + ((r && r.error) || '未知错误'))); return; }
      const runs = arr(r.runs);
      if (!runs.length) { runsWrap.appendChild(document.createTextNode('暂无运行记录。')); return; }
      runs.forEach((x) => {
        const line = document.createElement('div'); line.className = 'op-run';
        line.textContent = `${x.at}  ${x.status}  ·  ${x.source}${x.error ? '  ·  ' + x.error : ''}`;
        runsWrap.appendChild(line);
      });
    };
    return card;
  }

  async function write(fn, okMsg, failMsg) {
    if (!isNativeCLI()) { toast('演示模式不可用', 1800); return false; }
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return false;
    if (!r || !r.ok) { toast(`${failMsg}：${(r && r.error) || '未知错误'}`, 3400); return false; }
    if (Array.isArray(r.jobs)) { jobs = r.jobs; draw(); }
    else await reload();
    toast(r.warning || okMsg, r.warning ? 3200 : 1600);
    return true;
  }

  const isValidSchedule = (v) => {
    if (!v || v.startsWith('-')) return false;
    if (/^(?:every\s+)?\d+\s*[smhd]$/i.test(v)) return true;
    const parts = v.split(/\s+/);
    return parts.length === 5 && parts.every((p) => /^[\d*,/-]+$/.test(p));
  };
  createBtn.onclick = () => {
    const sched = schedIn.value.trim();
    if (!isValidSchedule(sched)) {
      toast('调度格式无效：请填写如 30m、every 2h 或 5 段 cron（0 9 * * *）', 2600);
      schedIn.focus();
      return;
    }
    opConfirm(form, {
      title: '创建这个定时任务？',
      cmd: `hermes -p <current> cron create ${sched} --paused`,
      note: '任务以暂停状态创建，不会立刻运行；恢复后才会按调度唤醒 agent。',
      confirmLabel: '确认创建',
      onGo: async () => {
        const ok = await write(() => api.cronCreate({
          schedule: sched, name: nameIn.value.trim(), prompt: promptIn.value.trim(),
        }), '已创建（暂停）', '创建失败');
        if (ok) { schedIn.value = ''; nameIn.value = ''; promptIn.value = ''; }
        return ok;
      },
    });
  };

  async function reload() {
    if (!isNativeCLI()) { status.textContent = '演示模式：不做 CLI 调用。'; return; }
    status.textContent = '正在执行 hermes cron list --all / status…';
    let r;
    try { r = await api.cronOverview(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!alive()) return;
    if (!r || !r.ok) {
      status.textContent = '读取失败：' + ((r && r.error) || '未知错误');
      status.classList.add('is-error'); return;
    }
    jobs = arr(r.jobs); scheduler = r.status || null; draw();
  }
  refresh.onclick = reload;
  await reload();
}

/* ---------- 设置页：健康检查（只读诊断，原样展示 CLI 输出） ----------
   不做结构化解析：CLI 的排版本 / 文案随版本变，把「✓」硬解析成布尔很容易误报。
   退出码非 0 也可能只是 doctor 报告了待办建议，因此状态区分：
     有输出 → 完成（附退出码）；无输出 / 超时 / error → 失败。 */
const HEALTH_CHECKS = [
  { key: 'status', label: '组件状态', cmd: 'hermes status', hint: '模型、provider、网关与任务概览', slow: false },
  { key: 'config:check', label: '配置检查', cmd: 'hermes config check', hint: '配置版本与缺失/可选环境变量', slow: false },
  { key: 'fallback:list', label: '备用模型链', cmd: 'hermes fallback list', hint: '主模型失败时按顺序尝试的 provider', slow: false },
  { key: 'memory:status', label: '记忆状态', cmd: 'hermes memory status', hint: '内置记忆与外部 provider', slow: false },
  { key: 'doctor', label: '深度体检', cmd: 'hermes doctor', hint: '枚举全部工具与环境，约 40 秒，建议单独运行', slow: true },
];
let healthRunning = false;
function healthStatusLine(r, ms) {
  const secs = (ms / 1000).toFixed(1) + 's';
  if (r && r.timedOut) return `超时（${secs}）`;
  if (r && r.hasOutput) return r.ok ? `完成 · 退出码 0 · ${secs}` : `完成 · 退出码 ${r.code}（可能含建议） · ${secs}`;
  return `未取得输出 · ${secs}`;
}
async function runHealthCard(check, card, onDone) {
  const epoch = settingsPanelEpoch;
  const btn = card.querySelector('.hc-run');
  const out = card.querySelector('.hc-out');
  const meta = card.querySelector('.hc-meta');
  btn.disabled = true; meta.textContent = '运行中…'; meta.classList.remove('is-error');
  const t0 = performance.now();
  let r;
  try { r = await api.diagnosticsRun(check.key); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e), text: '' }; }
  if (epoch !== settingsPanelEpoch || !card.isConnected) { if (onDone) onDone(); return; }
  const ms = performance.now() - t0;
  out.textContent = r && r.text ? r.text : (r && r.error) || 'CLI 未返回内容';
  out.hidden = false;
  meta.textContent = healthStatusLine(r, ms);
  const failed = !!(r && !r.hasOutput);
  meta.classList.toggle('is-error', failed);
  card.classList.toggle('is-error', failed);
  btn.disabled = false;
  if (onDone) onDone();
}
function renderHealthPanel(panel, cat) {
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">只读诊断</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const actions = document.createElement('div'); actions.className = 'hc-actions';
  const runQuick = document.createElement('button');
  runQuick.type = 'button'; runQuick.className = 'hc-quick'; runQuick.textContent = '运行快速检查（4 项）';
  runQuick.disabled = !isNativeCLI() || healthRunning;
  const note = document.createElement('span'); note.className = 'hc-note';
  note.textContent = '命令由服务层白名单固定，串行执行，均不带 --fix / --live，不发真实网络探测。';
  actions.append(runQuick, note);
  panel.appendChild(actions);

  const grid = document.createElement('div'); grid.className = 'hc-grid';
  const cards = new Map();
  HEALTH_CHECKS.forEach((c) => {
    const card = document.createElement('div'); card.className = 'hc-card' + (c.slow ? ' slow' : '');
    card.innerHTML = `<div class="hc-head"><span class="hc-name">${esc(c.label)}</span>` +
      `<span class="hc-meta">未运行</span></div>` +
      `<div class="hc-cmd">${esc(c.cmd)}</div><div class="hc-hint">${esc(c.hint)}</div>`;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'hc-run'; btn.textContent = c.slow ? '运行深度体检' : '运行';
    btn.disabled = !isNativeCLI();
    btn.onclick = () => { if (!healthRunning) runHealthCard(c, card); };
    const out = document.createElement('pre'); out.className = 'hc-out'; out.hidden = true;
    card.append(btn, out);
    grid.appendChild(card);
    cards.set(c.key, { check: c, card });
  });
  panel.appendChild(grid);

  const disclaimer = document.createElement('div'); disclaimer.className = 'pf-note';
  disclaimer.innerHTML = `这里只做<strong>只读</strong>诊断，不会修复、改写配置或安装依赖。` +
    `CLI 输出原样展示，<code>hermes doctor</code> 的退出码 1 通常只表示「有待处理建议」，` +
    `不能据此判定配置损坏；请以输出里的具体条目为准。修复请在终端执行对应 CLI 命令。`;
  panel.appendChild(disclaimer);

  runQuick.onclick = async () => {
    if (healthRunning) return;
    healthRunning = true; runQuick.disabled = true; runQuick.textContent = '运行中…';
    for (const c of HEALTH_CHECKS.filter((x) => !x.slow)) {
      const entry = cards.get(c.key);
      if (entry) await runHealthCard(c, entry.card);
    }
    healthRunning = false; runQuick.disabled = false; runQuick.textContent = '运行快速检查（4 项）';
    toast('快速检查完成', 1400);
  };
}

function setupSettings() {
  $('#set-close').onclick = () => toggleSettings(false);
  $('#settings-page').addEventListener('click', (e) => { if (e.target.id === 'settings-page') toggleSettings(false); });
  $('#set-cancel').onclick = () => toggleSettings(false);
  $('#set-save').onclick = () => {
    const prevMode = settingsRead().approvalMode;
    const ok = SettingsStore.set(settingsDraft);
    settingsDraft = {};
    $('#set-save').classList.remove('dirty');
    if (!ok) { $('#set-hint').textContent = '保存失败（本地存储不可用）'; toast('设置无法保存', 2400); return; }
    // 设置此前只写不读，全部是摆设；保存后立刻应用到界面
    applySettings();
    const nextMode = settingsRead().approvalMode;
    if (nextMode !== prevMode && state && state.config) {
      state.config.yolo = nextMode === '自动批准全部';
      if (hasNative && api.setConfig) api.setConfig({ yolo: state.config.yolo });
      if (typeof syncComposerState === 'function') syncComposerState();
      if (typeof updateStatus === 'function') updateStatus();
    }
    $('#set-hint').textContent = '已保存并生效';
    toast('设置已保存并生效', 1400);
  };
  $('#set-open-config').onclick = async () => {
    if (isNativeCLI()) {
      const r = await window.hermesAPI.configOpenFile('configYaml');
      if (!r.ok) toast(r.error || '打开失败', 2200);
    } else {
      toast('配置文件位于 ~/.hermes/config.yaml（真机可直接打开）', 2400);
    }
  };
}
/* ---------- Profile：品牌行下拉 + 设置页分区共用一套数据/切换 ---------- */
let pfSnapshot = null;
const pfNative = () => hasNative && typeof api.profileList === 'function';
const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
};

async function loadProfiles(force) {
  if (!pfNative()) return null;
  if (!force && pfSnapshot) return pfSnapshot;
  try { pfSnapshot = await api.profileList(); } catch { pfSnapshot = null; }
  return pfSnapshot;
}

async function refreshProfileChip() {
  const snap = await loadProfiles(true);
  if (!snap) return;
  $('#pf-name').textContent = snap.current;
  $('#pf-chip').title = `当前 Profile：${snap.current}（点击切换）`;
}

/** 真正执行切换：主进程停后端 → 换 home → 重新拉起，随后重载渲染层重建所有列表。 */
async function doSwitchProfile(name) {
  if (!pfNative()) { toast('当前环境不支持切换 Profile', 2200); return false; }
  toast(`正在切换到 ${name}…`, 2000);
  let r;
  try { r = await api.profileSwitch(name); } catch (e) { toast('切换失败：' + (e?.message || e), 3000); return false; }
  if (!r || !r.ok) { toast('切换失败：' + ((r && r.error) || '未知错误'), 3000); return false; }
  if (r.changed === false) return true;
  location.reload();
  return true;
}
function askSwitch(name) {
  if (name === pfSnapshot?.current) return;
  const old = document.querySelector('.pf-switch-confirm');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'palette pf-switch-confirm';
  const box = document.createElement('div');
  box.className = 'palette-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', '确认切换 Profile');
  box.style.padding = '16px 18px';
  const card = document.createElement('div');
  card.className = 'op-confirm';
  const h = document.createElement('div');
  h.className = 'op-confirm-title';
  h.textContent = `切换到 profile「${name}」？`;
  const p = document.createElement('p');
  p.className = 'op-confirm-note';
  p.textContent = '将重启后端并重载界面，当前进行中的对话会中断。桌面端只改自己的选择，不会写入 ~/.hermes，终端 CLI 不受影响。';
  const btns = document.createElement('div');
  btns.className = 'op-confirm-btns';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'mk-btn'; cancel.textContent = '取消';
  const ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'mk-btn primary'; ok.textContent = '确认切换';
  cancel.onclick = () => wrap.remove();
  ok.onclick = () => { wrap.remove(); doSwitchProfile(name); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  btns.append(cancel, ok);
  card.append(h, p, btns);
  box.append(card);
  wrap.append(box);
  document.body.append(wrap);
  ok.focus();
}

function renderPfMenu() {
  const m = $('#pf-menu');
  const snap = pfSnapshot || (!pfNative() ? { current: 'default', profiles: [{ name: 'default', current: true }] } : null);
  if (!snap) { m.innerHTML = '<div class="pf-menu-head"><span>正在读取 Profile…</span></div>'; return; }
  const list = Array.isArray(snap.profiles) ? snap.profiles : [];
  m.innerHTML = `<div class="pf-menu-head"><span>工作区 Profile</span><span class="pf-menu-count">${list.length}</span></div>` +
    list.map((p) => {
      const cur = !!p.current || p.name === snap.current;
      return `<button class="pf-menu-item${cur ? ' is-current' : ''}" type="button" data-name="${esc(p.name)}">` +
        `<span class="pf-dot${cur ? '' : ' muted'}" aria-hidden="true"></span>` +
        `<span class="pf-mi-name">${esc(p.name)}</span>` +
        (cur ? '<span class="pf-mi-tag" aria-label="当前"><svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.3 5 8.8 9.5 3.5"/></svg></span>' : '') +
        `</button>`;
    }).join('') +
    `<div class="pf-menu-foot">切换会重启后端并重载界面，不写入 <code>~/.hermes</code>。</div>`;
}
function togglePfMenu(show) {
  const m = $('#pf-menu');
  const chip = $('#pf-chip');
  const on = show !== undefined ? show : m.hidden;
  m.hidden = !on;
  if (chip) {
    chip.classList.toggle('open', !!on);
    chip.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  if (!on) return;
  const r = chip.getBoundingClientRect();
  m.style.left = Math.max(10, Math.min(r.right - 232, window.innerWidth - 242)) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  renderPfMenu();
}
$('#pf-chip').onclick = (e) => {
  e.stopPropagation();
  togglePfMenu();
  loadProfiles(true).then(() => { if (!$('#pf-menu').hidden) renderPfMenu(); });
};
$('#pf-menu').addEventListener('click', (e) => {
  const b = e.target.closest('.pf-menu-item');
  if (!b) return;
  togglePfMenu(false);
  askSwitch(b.dataset.name);
});
document.addEventListener('click', (e) => {
  const m = $('#pf-menu');
  if (!m.hidden && !m.contains(e.target) && !$('#pf-chip').contains(e.target)) togglePfMenu(false);
});

/** 设置页 → Profile 分区 */
async function renderProfilePanel(panel, cat) {
  const epoch = settingsPanelEpoch;
  const alive = () => epoch === settingsPanelEpoch;
  const head = document.createElement('div');
  head.innerHTML = `<div class="pp-group-label">实例</div><div class="set-desc">${esc(cat.desc)}</div>`;
  panel.appendChild(head);
  const grid = document.createElement('div');
  grid.className = 'pf-grid';
  grid.innerHTML = '<div class="set-row-hint">正在读取 profile…</div>';
  panel.appendChild(grid);
  const note = document.createElement('div');
  note.className = 'pf-note';
  note.innerHTML = `当前选择保存在桌面端自己的应用数据目录（Electron userData），` +
    `切换时所有 hermes CLI 子进程显式带 <code>-p &lt;名&gt;</code>。<br>` +
    `因此不会新建、修改或删除 <code>~/.hermes</code> 下的任何文件，也不会改动 hermes CLI 安装目录；` +
    `终端里执行 <code>hermes profile use &lt;名&gt;</code> 设置的 sticky 默认与桌面端互不干扰。` +
    `<br>切换会重启常驻后端并重载界面，进行中的对话会中断。`;
  panel.appendChild(note);

  const snap = await loadProfiles(true);
  if (!alive()) return;
  if (!snap) {
    grid.innerHTML = '<div class="set-row-hint">需要桌面端原生环境才能切换 profile。</div>';
    return;
  }
  grid.innerHTML = '';
  snap.profiles.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'pf-card' + (p.current ? ' active' : '');
    card.innerHTML = `
      <div class="pf-card-top"><span class="pf-card-name">${esc(p.name)}</span>
        ${p.current ? '<span class="pf-badge">当前使用中</span>' : ''}
        ${p.cliActive && !p.current ? '<span class="pf-badge">CLI 默认</span>' : ''}</div>
      <div class="pf-card-meta">${esc(p.model)}<br>${esc(Number(p.skills) || 0)} 个技能 · 会话库 ${fmtBytes(p.dbBytes)}<br>${esc(p.home)}</div>`;
    const btn = document.createElement('button');
    btn.className = 'pf-card-btn';
    btn.textContent = p.current ? '当前使用中' : '切换到此';
    btn.disabled = !!p.current;
    btn.onclick = () => askSwitch(p.name);
    card.appendChild(btn);
    grid.appendChild(card);
  });
  refreshProfileChip();
}

setupSettings();
