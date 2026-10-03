'use strict';
/**
 * 执行单校验：编号重复、缺失引用（前置不存在）、自依赖、循环依赖；
 * 以及节奏计划参数：planned_seconds/tolerance_seconds 须为非负整数（≤30 天），
 * 设置计划的提示按提示顺序其计划秒数不递减（未设置计划的提示不参与排序）。
 * 输入为提示数组（通常为 sanitizeCue 结果，也兼容原始输入）。
 */

const CUE_TYPES = ['light', 'sound', 'set', 'other'];
const { parsePlanFields, MAX_PLAN_SECONDS } = require('./rhythm');

/** 取一条提示的计划参数（优先 sanitizeCue 标记，其次按原始输入重新解析） */
function planOf(c) {
  if (c._planned_invalid || c._tolerance_invalid || c.planned_seconds !== undefined) {
    return {
      planned_seconds: c.planned_seconds == null ? null : c.planned_seconds,
      tolerance_seconds: c.tolerance_seconds == null ? null : c.tolerance_seconds,
      planned_invalid: !!c._planned_invalid,
      tolerance_invalid: !!c._tolerance_invalid,
    };
  }
  return parsePlanFields(c);
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
    // 节奏计划参数：均为非负整数（≤30 天）；未填计划秒数视为不设置计划
    const plan = planOf(c);
    if (plan.planned_invalid) {
      errors.push(`${pos}（${c.label || '未命名'}）：计划秒数非法，须为 0 至 ${MAX_PLAN_SECONDS} 之间的非负整数`);
    }
    if (plan.tolerance_invalid) {
      errors.push(`${pos}（${c.label || '未命名'}）：容许偏差秒数非法，须为 0 至 ${MAX_PLAN_SECONDS} 之间的非负整数`);
    }
  });

  // 计划秒数按提示顺序不递减（仅检查设置了计划的提示，未设置计划的跳过不参与）
  let prevPlan = null;
  let prevLabel = null;
  let prevPos = null;
  cues.forEach((c, i) => {
    const plan = planOf(c);
    if (plan.planned_seconds == null || plan.planned_invalid) return;
    if (prevPlan != null && plan.planned_seconds < prevPlan) {
      errors.push(
        `计划秒数须按提示顺序不递减：第 ${i + 1} 条（${c.label || '未命名'}）计划 ${plan.planned_seconds} 秒，`
        + `小于前一条设置计划的提示（第 ${prevPos} 条「${prevLabel}」）的 ${prevPlan} 秒`
      );
    }
    prevPlan = plan.planned_seconds;
    prevLabel = c.label || '未命名';
    prevPos = i + 1;
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

  return errors;
}

module.exports = { validateCues, CUE_TYPES };
