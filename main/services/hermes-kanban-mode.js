'use strict';
/**
 * hermes-kanban-mode.js — 「看板编排」三档模式 ↔ 两个 CLI 开关的映射
 *
 * 模式不是独立存储的值，而是从两个布尔**推导**出来的派生结果。反过来说，
 * 如果模式单独存一份，就会出现「显示半自动、实际 auto_decompose=true」这种
 * 自相矛盾的状态，用户看到的和 gateway 做的不是一回事。
 *
 *   全自动 auto    dispatch_in_gateway=true   auto_decompose=true
 *   半自动 semi    dispatch_in_gateway=true   auto_decompose=false
 *   全手动 manual  dispatch_in_gateway=false
 *
 * 两个开关走两条通道，因为能力边界不同：
 *   - auto_decompose      → 看板 REST `PUT /orchestration`（几十毫秒，官方端点）
 *   - dispatch_in_gateway → `hermes config set`（5–7 秒；**不在**上面那个端点的
 *                           白名单里，那边只管 auto_decompose / auto_promote_children / 两个 profile）
 *
 * 生效时机也不同（gateway 源码实读）：
 *   - auto_decompose      每 tick 实时重读 → 下一轮生效，**不用重启**
 *   - dispatch_in_gateway watcher 启动时读一次 → **改完必须重启 gateway**
 * 所以 apply() 会把 needsRestart 明确交回渲染层，不能吞掉。
 */

/** 三档模式。顺序即 UI 顺序：从全自动到全手动，控制力递增、自动化递减。 */
const MODES = Object.freeze([
  Object.freeze({
    id: 'auto', label: '全自动', dispatch: true, decompose: true,
    summary: '收集箱的卡会自动拆分并派发执行',
    detail: '新卡进收集箱后，gateway 每 60 秒取最多 3 张交给分解器，补齐标题/正文/受让人并推进到 ready，再由调度器拉起 worker。',
  }),
  Object.freeze({
    id: 'semi', label: '半自动', dispatch: true, decompose: false,
    summary: '收集箱停住，其余照常自动执行',
    detail: '只有 triage 不再自动处理；依赖推进、ready 派发、review 自动验收、僵死回收都照旧。收集箱的卡要手动拆解才会动。',
  }),
  Object.freeze({
    id: 'manual', label: '全手动', dispatch: false, decompose: false,
    summary: '派发器整体停止，只有你手动派发才会执行',
    detail: 'gateway 的 tick 不再 claim/spawn，todo 也不用等自动推进。改这一档必须重启 gateway 才对进程生效。',
  }),
]);

const MODE_IDS = Object.freeze(MODES.map((m) => m.id));

/** 两个布尔 → 模式 id。dispatch 关闭压倒一切：分解开着也只是往 ready 里堆卡。 */
function modeOf({ dispatchInGateway, autoDecompose }) {
  if (!dispatchInGateway) return 'manual';
  return autoDecompose ? 'auto' : 'semi';
}

/**
 * 推导模式，并指出「开关组合与档位不完全吻合」的情况：
 * 例如 dispatch=false 但 auto_decompose=true —— 分解照跑，可结果只会堆在 ready
 * 队列里没人认领。这不是 bug，是需要如实告诉用户的状态。
 */
function describeMode(switches) {
  const s = switches && typeof switches === 'object' ? switches : {};
  const dispatchInGateway = s.dispatch_in_gateway !== false;
  const autoDecompose = s.auto_decompose !== false;
  const id = modeOf({ dispatchInGateway, autoDecompose });
  const mode = MODES.find((m) => m.id === id) || MODES[0];
  return {
    mode: id,
    modeLabel: mode.label,
    dispatchInGateway,
    autoDecompose,
    autoPromoteChildren: s.auto_promote_children !== false,
    orchestratorProfile: String(s.orchestrator_profile || ''),
    defaultAssignee: String(s.default_assignee || ''),
    // 分解还在跑但没人认领：卡会一张张堆进 ready，用户必须知道。
    decomposeStranded: !dispatchInGateway && autoDecompose,
  };
}

/**
 * @param {{kanban: object, cfg: object}} deps
 *   kanban — hermes-kanban 的客户端（orchestration / setOrchestration）
 *   cfg    — hermes-config（kanbanSwitches 同步读、setKanbanSwitch 异步写）
 */
function createKanbanMode({ kanban, cfg }) {
  /** 读当前状态。REST 失败也返回 config.yaml 里的值，标 degraded 而不是整块失败。 */
  async function read() {
    const local = cfg.kanbanSwitches();
    const desc = describeMode(local);
    let rest = null;
    let degraded = false;
    try {
      const r = await kanban.orchestration();
      if (r && r.ok) rest = r;
      else degraded = true;
    } catch { degraded = true; }
    if (rest) {
      // REST 是权威（写入后 CLI 会回读），但 dispatch_in_gateway 只能来自文件。
      desc.autoDecompose = rest.autoDecompose;
      desc.autoPromoteChildren = rest.autoPromoteChildren;
      desc.orchestratorProfile = rest.orchestratorProfile;
      desc.defaultAssignee = rest.defaultAssignee;
      desc.resolvedOrchestrator = rest.resolvedOrchestrator;
      desc.resolvedAssignee = rest.resolvedAssignee;
      desc.activeProfile = rest.activeProfile;
      desc.mode = modeOf({ dispatchInGateway: desc.dispatchInGateway, autoDecompose: desc.autoDecompose });
      desc.decomposeStranded = !desc.dispatchInGateway && desc.autoDecompose;
      const m = MODES.find((x) => x.id === desc.mode);
      desc.modeLabel = m ? m.label : desc.mode;
    }
    return {
      ok: true,
      degraded,
      warn: local.ok ? '' : String(local.error || ''),
      ...desc,
      modes: MODES.map((m) => ({
        id: m.id, label: m.label, summary: m.summary, detail: m.detail,
        // dispatch / decompose 必须一起下发：渲染层要用它们算「这次会写哪几个键」，
        // 只给 needsRestart 会让「全自动」也显示重启警告（这两个值不能靠猜）。
        dispatch: m.dispatch, decompose: m.decompose, needsRestart: !m.dispatch,
      })),
    };
  }

  /**
   * 应用一个档位。只写需要变的开关，未变的绝不重写（写 CLI 配置是慢操作，
   * 5–7 秒一次，能少一次就少一次）。返回的 values 是**期望值**，不是回读值：
   * CLI 回读还要再等 5–7 秒，这里先让 UI 立刻有反馈，step 里带上失败说明。
   */
  async function apply(modeId) {
    if (!MODE_IDS.includes(modeId)) return { ok: false, error: '未知的编排模式：' + String(modeId) };
    const target = MODES.find((m) => m.id === modeId);
    const before = await read();
    const steps = [];
    let needsRestart = false;

    const decomposeChanged = before.autoDecompose !== target.decompose;
    const dispatchChanged = before.dispatchInGateway !== target.dispatch;

    // 顺序有讲究：先 REST 写 auto_decompose，再 CLI 写 dispatch ——
    // `hermes config set` 会重读 config.yaml 后整体回写，放在后面才不会盖掉前一步。
    if (decomposeChanged) {
      const r = await kanban.setOrchestration({ auto_decompose: target.decompose });
      steps.push({ step: 'auto_decompose', ok: !!(r && r.ok), error: (r && r.error) || '' });
      if (!r || !r.ok) {
        return { ok: false, error: '写 auto_decompose 失败：' + ((r && r.error) || '未知错误'), steps, needsRestart };
      }
    }

    if (dispatchChanged) {
      const r = await cfg.setKanbanSwitch('dispatch_in_gateway', target.dispatch);
      steps.push({ step: 'dispatch_in_gateway', ok: !!(r && r.ok), error: (r && r.error) || '' });
      if (!r || !r.ok) {
        return { ok: false, error: '写 dispatch_in_gateway 失败：' + ((r && r.error) || '未知错误'), steps, needsRestart };
      }
      // watcher 只在启动时读这个开关，改了不重启等于没改。
      needsRestart = true;
    }

    const after = await read();
    return {
      ok: true, mode: after.mode, modeLabel: after.modeLabel,
      changed: steps.map((s) => s.step), needsRestart, steps, state: after,
    };
  }

  return { read, apply, MODES, MODE_IDS, describeMode, modeOf };
}

module.exports = {
  createKanbanMode, describeMode, modeOf, MODES, MODE_IDS,
};
