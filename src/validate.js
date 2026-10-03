'use strict';
/**
 * 执行单校验：编号重复、缺失引用（前置不存在）、自依赖、循环依赖，
 * 以及提示计划节奏（计划秒数 / 容许偏差秒数）的合法性。
 * 输入为提示数组 [{ label, type, description, deps: [label...],
 *   planned_offset_seconds, tolerance_seconds }]，返回错误字符串数组。
 */

const CUE_TYPES = ['light', 'sound', 'set', 'other'];

/** 非负整数（数值或纯数字字符串）；null/空串由调用方按"未填写"另行处理 */
function isNonNegativeInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isInteger(n) && n >= 0;
  }
  return false;
}

/**
 * 计划节奏校验：
 *  - 计划秒数（相对开演）与容许偏差秒数均须为非负整数；
 *  - 只填容许偏差而未填计划秒数 → 非法（只填计划秒数时容许偏差按 0 处理，见 sanitizeCue）；
 *  - 设置了计划秒数的提示，其计划秒数按提示顺序不递减。
 */
function validatePlan(cues, errors) {
  const plannedSeq = []; // [{ label, planned, pos }]（仅收集合法计划值，参与不递减核对）
  cues.forEach((c, i) => {
    const pos = `第 ${i + 1} 条`;
    const name = c.label || '未命名';
    const hasPlanned = c.planned_offset_seconds != null && c.planned_offset_seconds !== '';
    const hasTolerance = c.tolerance_seconds != null && c.tolerance_seconds !== '';
    if (hasPlanned && !isNonNegativeInt(c.planned_offset_seconds)) {
      errors.push(`${pos}（${name}）：计划秒数须为非负整数（相对开演的秒数），当前为「${c.planned_offset_seconds}」`);
    }
    if (hasTolerance && !isNonNegativeInt(c.tolerance_seconds)) {
      errors.push(`${pos}（${name}）：容许偏差秒数须为非负整数，当前为「${c.tolerance_seconds}」`);
    }
    if (!hasPlanned && hasTolerance) {
      errors.push(`${pos}（${name}）：已填写容许偏差秒数但未填写计划秒数；请补上计划秒数或清空容许偏差`);
    }
    if (hasPlanned && isNonNegativeInt(c.planned_offset_seconds)) {
      plannedSeq.push({ label: name, planned: Number(c.planned_offset_seconds), pos: i + 1 });
    }
  });
  for (let k = 1; k < plannedSeq.length; k += 1) {
    const prev = plannedSeq[k - 1];
    const cur = plannedSeq[k];
    if (cur.planned < prev.planned) {
      errors.push(
        `计划秒数须按提示顺序不递减：第 ${cur.pos} 条（${cur.label}，计划 ${cur.planned} 秒）` +
        `小于前一条有计划提示（${prev.label}，计划 ${prev.planned} 秒）`
      );
    }
  }
}

function validateCues(cues) {
  const errors = [];

  if (!Array.isArray(cues) || cues.length === 0) {
    errors.push('执行单为空：至少需要一条提示');
    return errors;
  }

  const byLabel = new Map();
  cues.forEach((c, i) => {
    const pos = `第 ${i + 1} 条`;
    if (!c.label) {
      errors.push(`${pos}：提示编号不能为空`);
    } else if (byLabel.has(c.label)) {
      errors.push(`提示编号重复：「${c.label}」`);
    } else {
      byLabel.set(c.label, c);
    }
    if (!CUE_TYPES.includes(c.type)) {
      errors.push(`${pos}（${c.label || '未命名'}）：类型无效，应为 light/sound/set/other`);
    }
  });

  // 缺失引用 / 自依赖
  for (const c of cues) {
    if (!c.label) continue;
    for (const dep of c.deps) {
      if (dep === c.label) {
        errors.push(`提示「${c.label}」不能依赖自身`);
      } else if (!byLabel.has(dep)) {
        errors.push(`提示「${c.label}」的前置「${dep}」不存在（缺失引用）`);
      }
    }
  }

  // 循环依赖：DFS 找环并给出路径
  const state = new Map(); // 1=在栈中 2=已完成
  const stack = [];
  const seenCycles = new Set();

  function dfs(label) {
    state.set(label, 1);
    stack.push(label);
    for (const dep of byLabel.get(label).deps) {
      if (!byLabel.has(dep) || dep === label) continue;
      const s = state.get(dep) || 0;
      if (s === 0) {
        dfs(dep);
      } else if (s === 1) {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        const key = cycle.join('→');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          errors.push(`检测到循环依赖：${cycle.join(' → ')}`);
        }
      }
    }
    stack.pop();
    state.set(label, 2);
  }

  for (const label of byLabel.keys()) {
    if (!(state.get(label) || 0)) dfs(label);
  }

  // 计划节奏：计划秒数 / 容许偏差秒数合法性与不递减
  validatePlan(cues, errors);

  return errors;
}

module.exports = { validateCues, CUE_TYPES, isNonNegativeInt };
