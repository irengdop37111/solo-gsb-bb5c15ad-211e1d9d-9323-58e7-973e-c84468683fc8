'use strict';
/**
 * 节奏计划与分类（纯逻辑，不访问数据库，供校验 / API / 测试复用）。
 *
 * 排演时可为草稿提示填写「相对开演的计划秒数 planned_seconds」与「容许偏差秒数
 * tolerance_seconds」，均为非负整数，计划秒数按提示顺序不递减；发布后随版本锁定，
 * 旧版未设置计划的提示（planned_seconds 为 NULL）不参与节奏统计。
 *
 * 计时起点：每场演出以「原演出启动时间」为计时起点；接续演出沿接续链回溯到最初演出，
 * 承接（carried）触发按原操作时间计算，未执行提示按新版计划判断。
 *
 * 分类（仅针对设置了计划的提示）：
 *   early   提前：有效触发时间早于 计划-容差
 *   ontime  准时：触发时间落在 计划±容差（含边界）
 *   late    逾时（已执行）：有效触发时间晚于 计划+容差
 *   skipped 跳过：跳过不计偏差
 *   overdue 逾时待执行：未执行且当前时间已超过 计划+容差
 *   pending 待执行：未执行且尚未超过计划上限（含尚未到计划时间）
 * 撤回（retracted）使原触发退出当前统计：有效结果为空，按未执行重判；原触发流水仍保留，
 * 历史回看时保留其当时分类。重触发按新流水重新计算。
 */

const RHYTHM_STATUS_TEXT = {
  early: '提前',
  ontime: '准时',
  late: '逾时',
  skipped: '跳过',
  overdue: '逾时待执行',
  pending: '待执行',
};

/** 计划秒数 / 容许偏差秒数上限（30 天），超出同样视为非法 */
const MAX_PLAN_SECONDS = 30 * 24 * 3600;

/**
 * 解析非负整数：接受 number 整数与纯整数字符串；空 / null / 小数 / 负数 / 非数字均非法。
 * @returns {{ok:true,value:number}|{ok:false}}
 */
function parseNonNegInt(raw) {
  if (raw == null) return { ok: false };
  if (typeof raw === 'boolean') return { ok: false };
  if (typeof raw === 'number') {
    if (Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_PLAN_SECONDS) return { ok: true, value: raw };
    return { ok: false };
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n <= MAX_PLAN_SECONDS) return { ok: true, value: n };
    }
  }
  return { ok: false };
}

function fieldPresent(v) {
  if (v == null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

/**
 * 解析一条提示的计划参数（兼容 planned_seconds 与旧别名 plan_seconds）。
 * 规则：
 *  - 未填计划秒数（null/undefined/空串）视为「未设置计划」；此时容差忽略（不视为错误）；
 *  - 计划秒数已填但非法 → planned_invalid；容差非法 → tolerance_invalid；
 *  - 已设置计划但容差留空 → 容差默认 0。
 * @returns {{planned_seconds:number|null,tolerance_seconds:number|null,
 *            planned_invalid:boolean,tolerance_invalid:boolean}}
 */
function parsePlanFields(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const result = {
    planned_seconds: null,
    tolerance_seconds: null,
    planned_invalid: false,
    tolerance_invalid: false,
  };
  const plannedRaw = fieldPresent(src.planned_seconds) ? src.planned_seconds
    : (fieldPresent(src.plan_seconds) ? src.plan_seconds : null);
  if (plannedRaw != null) {
    const r = parseNonNegInt(plannedRaw);
    if (r.ok) result.planned_seconds = r.value;
    else result.planned_invalid = true;
  }
  if (fieldPresent(src.tolerance_seconds)) {
    const r = parseNonNegInt(src.tolerance_seconds);
    if (r.ok) result.tolerance_seconds = r.value;
    else result.tolerance_invalid = true;
  }
  // 未设置计划：容差不生效；已设置计划但容差留空：容差默认 0
  if (result.planned_seconds == null) result.tolerance_seconds = null;
  else if (result.tolerance_seconds == null && !result.tolerance_invalid) result.tolerance_seconds = 0;
  return result;
}

/** 触发相对计划的偏差秒数（正=晚、负=早），毫秒级精度四舍五入到 0.001 秒 */
function deviationSeconds(triggerIso, originIso, plannedSeconds) {
  const ms = Date.parse(triggerIso) - Date.parse(originIso) - plannedSeconds * 1000;
  return Math.round((ms / 1000) * 1000) / 1000;
}

/** 已执行（fired）分类：按偏差与容差比较 */
function classifyFired(deviation, toleranceSeconds) {
  if (deviation < -toleranceSeconds) return 'early';
  if (deviation > toleranceSeconds) return 'late';
  return 'ontime';
}

/** 未执行分类：elapsedSeconds 为当前相对开演已过去的秒数 */
function classifyUnfired(elapsedSeconds, plannedSeconds, toleranceSeconds) {
  return elapsedSeconds > plannedSeconds + toleranceSeconds ? 'overdue' : 'pending';
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * 构造一场演出当前的节奏视图（仅统计设置了计划的提示）。
 * @param {Array} cues 演出版本提示（含 planned_seconds/tolerance_seconds/label/seq）
 * @param {Map<number,{action:string,created_at:string,id:number,source?:string}>} effectiveByCueId
 *   cue_id -> 当前有效事件（fired/skipped；撤回 / 无事件不在 Map 中）
 * @param {string} originIso 原演出启动时间（计时起点，ISO）
 * @param {string} [nowIso] 当前时间（ISO），默认取系统当前时间
 * @returns {{origin:string, items:Array, summary:object}}
 */
function buildRhythmView(cues, effectiveByCueId, originIso, nowIso) {
  const now = nowIso || new Date().toISOString();
  const elapsed = round3((Date.parse(now) - Date.parse(originIso)) / 1000);
  const items = [];
  const counts = { early: 0, ontime: 0, late: 0, skipped: 0, overdue: 0, pending: 0 };
  let deviationSum = 0;
  let firedCount = 0;

  for (const c of cues) {
    if (c.planned_seconds == null) continue;
    const tolerance = c.tolerance_seconds == null ? 0 : c.tolerance_seconds;
    const ev = effectiveByCueId.get(c.id) || null;
    let status;
    let deviation = null;
    if (ev && ev.action === 'fired') {
      deviation = deviationSeconds(ev.created_at, originIso, c.planned_seconds);
      status = classifyFired(deviation, tolerance);
    } else if (ev && ev.action === 'skipped') {
      status = 'skipped'; // 跳过不计偏差
    } else {
      status = classifyUnfired(elapsed, c.planned_seconds, tolerance);
    }
    counts[status] += 1;
    if (status === 'early' || status === 'ontime' || status === 'late') {
      firedCount += 1;
      deviationSum += deviation;
    }
    items.push({
      cue_id: c.id,
      label: c.label,
      seq: c.seq,
      planned_seconds: c.planned_seconds,
      tolerance_seconds: tolerance,
      status,
      status_text: RHYTHM_STATUS_TEXT[status],
      deviation_seconds: deviation,
      event_id: ev ? ev.id : null,
      source: ev ? (ev.source || 'manual') : null,
    });
  }

  const executedCount = counts.early + counts.ontime + counts.late + counts.skipped;
  const summary = {
    timing_origin: originIso,
    elapsed_seconds: elapsed,
    planned_count: items.length,
    early_count: counts.early,
    ontime_count: counts.ontime,
    late_count: counts.late,
    skipped_count: counts.skipped,
    overdue_count: counts.overdue,
    pending_count: counts.pending,
    executed_count: executedCount,
    fired_count: firedCount,
    // 准时率：已触发（含提前 / 准时 / 逾时）中准时的比例；无已触发为 null
    on_time_rate: firedCount ? round3(counts.ontime / firedCount) : null,
    // 平均偏差仅统计已触发提示（跳过不计偏差）
    avg_deviation_seconds: firedCount ? round3(deviationSum / firedCount) : null,
  };
  return { origin: originIso, items, summary };
}

/**
 * 为一条历史流水计算节奏分类（历史回看用；撤回的原触发保留其当时分类）。
 * fired → early/ontime/late（附偏差）；skipped → skipped；retracted / 无计划 → null。
 * @returns {{status:string,status_text:string,deviation_seconds:number}|null}
 */
function classifyEvent(event, cue, originIso) {
  if (!cue || cue.planned_seconds == null) return null;
  if (event.action === 'retracted') return null;
  if (event.action === 'skipped') {
    return { status: 'skipped', status_text: RHYTHM_STATUS_TEXT.skipped, deviation_seconds: null };
  }
  if (event.action === 'fired') {
    const deviation = deviationSeconds(event.created_at, originIso, cue.planned_seconds);
    const status = classifyFired(deviation, cue.tolerance_seconds == null ? 0 : cue.tolerance_seconds);
    return { status, status_text: RHYTHM_STATUS_TEXT[status], deviation_seconds: deviation };
  }
  return null;
}

module.exports = {
  RHYTHM_STATUS_TEXT,
  MAX_PLAN_SECONDS,
  parseNonNegInt,
  parsePlanFields,
  deviationSeconds,
  classifyFired,
  classifyUnfired,
  buildRhythmView,
  classifyEvent,
};
