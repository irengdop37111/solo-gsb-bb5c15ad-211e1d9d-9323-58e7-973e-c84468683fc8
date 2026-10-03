'use strict';
/**
 * API 路由与业务逻辑。
 * 错误约定：返回 { error: 消息, ... } ，状态码语义：
 *   400 参数/前置条件错误（含无已发布版本、版本未发布、跳过/撤回/驳回缺原因）
 *   404 资源不存在
 *   409 冲突（提示已有结果、版本已发布不可改、撤回时当前状态不允许或下游仍已触发、
 *       复核申请重复/已处置/处置人身份不符、待复核期间跳过或撤回、
 *       对只读（已接续）/已封场演出执行写操作或接续 / 封场、接续核对存在编号冲突、
 *       封场被阻项保持可操作、重复封场）
 *   422 校验未通过（缺失引用/循环依赖）、前置未触发（受阻，含复核确认时前置失效）
 *       或受未解除设备故障影响（触发 / 复核确认被冻结，附 blocked_by_faults，申请保持待复核）；
 *       需预备提示在未发口令 / 口令待确认 / 就绪已失效（前置流水变化或故障）时触发、成组触发
 *       或双人复核确认同样 422（附 needs_prep / prep_status，不改任何数据）；
 *       封场前核对存在阻项（未完成提示 / 待复核申请 / 未解除故障 / 待签收交接单）
 */
const { db, withTx } = require('./db');
const { validateCues, CUE_TYPES } = require('./validate');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

/* ---------------- 工具 ---------------- */

const ACTION_TEXT = { fired: '已触发', skipped: '已跳过', retracted: '已撤回' };
const REQUEST_STATUS_TEXT = { pending: '待复核', confirmed: '已确认', cancelled: '已撤销', rejected: '已驳回' };
// 预备口令状态与就绪失效原因（执行台 / 交接 / 封场报告展示用）
const PREP_STATUS_TEXT = {
  pending: '待确认',
  ready: '已就绪',
  consumed: '已消耗',
  superseded: '已被重新发出作废',
  invalidated: '已失效',
};
const PREP_INVALID_REASON_TEXT = {
  dep_changed: '前置有效触发流水变化',
  fault: '受未解除故障影响',
  cue_skipped: '提示已跳过',
  performance_continued: '演出已接续',
};
// 接续核对提示标记：触发 / 跳过 / 撤回流水、复核申请、承接结果
const HINT_FLAG_TEXT = {
  fired: '有触发流水',
  skipped: '有跳过流水',
  retracted: '有撤回流水',
  review: '有复核申请',
  carried: '有承接结果',
};

function sanitizeCue(raw) {
  const deps = Array.isArray(raw && raw.deps) ? raw.deps : [];
  return {
    label: String((raw && raw.label) != null ? raw.label : '').trim().slice(0, 50),
    type: CUE_TYPES.includes(raw && raw.type) ? raw.type : 'other',
    description: String((raw && raw.description) != null ? raw.description : '').trim().slice(0, 500),
    deps: [...new Set(deps.map((d) => String(d).trim()).filter(Boolean))].slice(0, 50),
    needs_review: raw && raw.needs_review ? 1 : 0,
    needs_prep: raw && raw.needs_prep ? 1 : 0,
  };
}

function getShow(id) {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
  if (!show) throw new HttpError(404, '场次不存在');
  return show;
}

function getVersion(id) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!v) throw new HttpError(404, '版本不存在');
  return v;
}

function getVersionCues(versionId) {
  return db
    .prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq')
    .all(versionId)
    .map((c) => ({ ...c, deps: JSON.parse(c.deps) }));
}

function conflictError(existing) {
  return new HttpError(
    409,
    `该提示已有结果：${ACTION_TEXT[existing.action]}（操作人 ${existing.operator}，时间 ${existing.created_at}）`,
    { current: existing }
  );
}

/**
 * 演出内各提示的最新一条事件（cue_id -> event）。
 * 当前有效结果规则：最新事件为 fired/skipped 即有效；retracted（已撤回）或无事件 = 无有效结果。
 * 所有写操作在 BEGIN IMMEDIATE 事务内"读最新→判定→写入"，保证至多一个当前有效结果。
 */
function latestEventsByCue(performanceId) {
  const rows = db.prepare('SELECT * FROM cue_events WHERE performance_id = ? ORDER BY id').all(performanceId);
  const map = new Map();
  for (const e of rows) map.set(e.cue_id, e);
  return map;
}

function effectiveAction(latest) {
  return latest && latest.action !== 'retracted' ? latest.action : null;
}

/** 演出与提示的存在性校验（提示须属于演出锁定的版本），供各写操作复用。
 *  在写事务内调用：同时拒绝已转只读（已接续）的演出，保证接续与现场操作串行判定。 */
function getPerfCue(performanceId, cueId) {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (!perf) throw new HttpError(404, '演出不存在');
  assertActiveInTx(perf);
  const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cueId, perf.version_id);
  if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');
  return { perf, cue };
}

/** 已接续的原演出为只读 / 已封场演出为终态只读：拒绝一切现场写操作
 *  （须在 BEGIN IMMEDIATE 事务内调用以读到最新状态） */
function assertActiveInTx(perf) {
  if (perf && perf.status === 'closed') {
    throw new HttpError(
      409,
      '该演出已封场结项，所有现场处置、复核、故障、交接与接续写操作均已关闭；原记录与封场报告仅可回看',
      { readonly: true, closed: true }
    );
  }
  if (perf && perf.status === 'readonly') {
    const next = db.prepare(
      'SELECT np.id, np.name, v.version_number FROM performances np JOIN versions v ON v.id = np.version_id WHERE np.continued_from_performance_id = ? ORDER BY np.id LIMIT 1'
    ).get(perf.id);
    throw new HttpError(
      409,
      `该演出已按修订执行单接续（接续时间 ${perf.continued_at || '-'}，操作人 ${perf.continued_by || '-'}），原演出保持原快照且为只读，请到接续演出继续操作`,
      {
        readonly: true,
        closed: false,
        continued_at: perf.continued_at || null,
        continued_by: perf.continued_by || null,
        ...(next
          ? { continuation: { performance_id: next.id, name: next.name, version_number: next.version_number } }
          : {}),
      }
    );
  }
}

/** 该演出某提示当前待复核的申请（无则 null）。须在事务内调用以保证判定一致 */
function pendingRequestFor(performanceId, cueId) {
  return db.prepare(
    "SELECT * FROM cue_review_requests WHERE performance_id = ? AND cue_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
  ).get(performanceId, cueId) || null;
}

/** 当前有效结果为"已触发"的提示编号集合（已撤回的不算） */
function firedLabelSet(versionId, latestByCue) {
  const rows = db.prepare('SELECT id, label FROM cues WHERE version_id = ?').all(versionId);
  return new Set(
    rows.filter((r) => {
      const e = latestByCue.get(r.id);
      return e && e.action === 'fired';
    }).map((r) => r.label)
  );
}

/* ---- 现场设备故障：影响范围计算（沿已发布执行单的前置关系反向传播） ---- */

/**
 * 某演出当前未解除（active）的故障列表（附提示编号与序号，最新在前）。
 * 须在事务内调用，保证与后续判定读到同一快照。
 */
function activeFaultRows(performanceId) {
  return db.prepare(`
    SELECT f.*, c.label AS label, c.seq AS seq FROM cue_faults f
    JOIN cues c ON c.id = f.cue_id
    WHERE f.performance_id = ? AND f.status = 'active'
    ORDER BY f.id DESC
  `).all(performanceId);
}

/** 该演出全部故障登记（含已解除，最新在前），附提示编号与序号 */
function allFaultRows(performanceId) {
  return db.prepare(`
    SELECT f.*, c.label AS label, c.seq AS seq FROM cue_faults f
    JOIN cues c ON c.id = f.cue_id
    WHERE f.performance_id = ?
    ORDER BY f.id DESC
  `).all(performanceId);
}

/**
 * 计算每条未解除故障的影响范围：故障提示本身 + 沿前置关系可达的全部后续提示
 * （即直接或间接 deps 中包含故障编号的提示），按版本序号排序。
 * 同时汇总 blockedByLabel：受影响编号 -> 阻断它的故障来源清单（label -> [fault...]）。
 * 返回 { faults:[{...fault, affected_labels:[...]}], blockedByLabel:Map<label, [fault...]> }。
 */
function faultImpact(cues, activeFaults) {
  // 前置关系反向索引：编号 -> 以它为前置的后续提示
  const childrenOf = new Map();
  for (const c of cues) {
    for (const dep of c.deps) {
      if (!childrenOf.has(dep)) childrenOf.set(dep, []);
      childrenOf.get(dep).push(c);
    }
  }
  const seqOf = new Map(cues.map((c) => [c.label, c.seq]));

  const blockedByLabel = new Map();
  const faults = activeFaults.map((f) => {
    const affected = [];
    const seen = new Set();
    const queue = [f.label];
    while (queue.length) {
      const cur = queue.shift();
      for (const child of childrenOf.get(cur) || []) {
        if (seen.has(child.label)) continue;
        seen.add(child.label);
        affected.push(child.label);
        queue.push(child.label);
      }
    }
    affected.sort((a, b) => (seqOf.get(a) || 0) - (seqOf.get(b) || 0) || a.localeCompare(b));
    const affected_labels = [f.label, ...affected.filter((l) => l !== f.label)];
    for (const l of affected_labels) {
      if (!blockedByLabel.has(l)) blockedByLabel.set(l, []);
      blockedByLabel.get(l).push(f);
    }
    return { ...f, affected_labels };
  });

  // blockedByLabel 内每条来源也保持最新登记在前
  for (const list of blockedByLabel.values()) {
    list.sort((a, b) => b.id - a.id);
  }
  return { faults, blockedByLabel };
}

/**
 * 触发被故障阻断时的统一错误（422：前置条件当前不满足；申请保留、不改任何数据）。
 * @param {Array} sources 阻断该提示的未解除故障（含 label / reported_by / reason）
 */
function faultBlockedError(sources) {
  const detail = sources
    .map((f) => `「${f.label}」故障（登记人 ${f.reported_by}：${f.reason}）`)
    .join('、');
  return new HttpError(
    422,
    `存在未解除的设备故障，受影响提示不得触发：${detail}。请先解除故障或改走跳过`,
    { blocked_by_faults: sources.map(faultBrief) }
  );
}

/** 故障在错误响应 / 列表中的精简结构 */
function faultBrief(f) {
  return {
    fault_id: f.id,
    label: f.label,
    reported_by: f.reported_by,
    reason: f.reason,
    reported_at: f.reported_at,
    ...(f.affected_labels ? { affected_labels: f.affected_labels } : {}),
  };
}

/* ---- 预备口令（warning/standby）：发出 / 确认 / 就绪失效扫描 / 消耗 ---- */

/** 某提示当前活动口令（pending 或 ready），无则 null。须在事务内调用 */
function activePrepFor(performanceId, cueId) {
  return db.prepare(`
    SELECT * FROM cue_prep_commands
    WHERE performance_id = ? AND cue_id = ? AND status IN ('pending','ready')
    ORDER BY id DESC LIMIT 1
  `).get(performanceId, cueId) || null;
}

/** 该演出全部活动口令（pending/ready），附编号与序号 */
function activePrepRows(performanceId) {
  return db.prepare(`
    SELECT k.*, c.label AS label, c.seq AS seq FROM cue_prep_commands k
    JOIN cues c ON c.id = k.cue_id
    WHERE k.performance_id = ? AND k.status IN ('pending','ready')
    ORDER BY k.id
  `).all(performanceId);
}

/** 该演出全部预备口令（最新在前），附编号与序号（交接 / 封场回看留痕） */
function allPrepRows(performanceId) {
  return db.prepare(`
    SELECT k.*, c.label AS label, c.seq AS seq FROM cue_prep_commands k
    JOIN cues c ON c.id = k.cue_id
    WHERE k.performance_id = ? ORDER BY k.id DESC
  `).all(performanceId);
}

/** 预备口令对外结构（快照解析为对象） */
function presentPrep(row) {
  let snapshot = null;
  if (row.dep_event_snapshot) {
    try { snapshot = JSON.parse(row.dep_event_snapshot); } catch { snapshot = null; }
  }
  return {
    id: row.id,
    performance_id: row.performance_id,
    cue_id: row.cue_id,
    ...(row.label ? { label: row.label, seq: row.seq } : {}),
    status: row.status,
    status_text: PREP_STATUS_TEXT[row.status] || row.status,
    issued_by: row.issued_by,
    issued_at: row.issued_at,
    confirmed_by: row.confirmed_by || null,
    confirmed_at: row.confirmed_at || null,
    dep_event_snapshot: snapshot,
    superseded_by_command_id: row.superseded_by_command_id || null,
    invalidated_reason: row.invalidated_reason || null,
    invalidated_reason_text: row.invalidated_reason ? (PREP_INVALID_REASON_TEXT[row.invalidated_reason] || row.invalidated_reason) : null,
    invalidated_detail: row.invalidated_detail || null,
    consumed_event_id: row.consumed_event_id || null,
    invalidated_at: row.invalidated_at || null,
  };
}

/** 触发被"未预备"阻断时的统一错误（422；不改任何数据） */
function prepNotReadyError(cue, command, detail) {
  if (!command) {
    return new HttpError(
      422,
      `提示「${cue.label}」需预备确认：尚未发出预备口令，请先由舞台监督发出预备口令并经另一操作人确认就绪后再触发`,
      { needs_prep: true, prep_status: 'none' }
    );
  }
  if (command.status === 'pending') {
    return new HttpError(
      422,
      `提示「${cue.label}」的预备口令尚待确认（发令人 ${command.issued_by}，时间 ${command.issued_at}），须由另一操作人确认就绪后方可触发`,
      { needs_prep: true, prep_status: 'pending', prep_command: presentPrep(command) }
    );
  }
  // ready 但判定瞬间已失效（扫描尚未运行或并发窗口）：给出明确原因
  return new HttpError(
    422,
    detail || `提示「${cue.label}」的预备口令已不再满足就绪条件，请重新发出预备口令并确认就绪后再触发`,
    { needs_prep: true, prep_status: 'stale', prep_command: presentPrep(command) }
  );
}

/**
 * 就绪口令当前是否仍满足就绪条件：
 *  1) 每个前置的"当前有效结果为已触发"，且其最新 fired 事件 id 与确认时固定的快照一致；
 *  2) 该提示当前不受任何未解除故障影响（含故障编号本身）。
 * @param {object} cue 提示（含 label/deps）
 * @param {object} cmd ready 口令（dep_event_snapshot 为 JSON 文本）
 * @param {Map} firedEventIdByLabel label -> 当前有效 fired 事件 id（null 表示未有效触发）
 * @param {object} faultImpactNow faultImpact 结果
 * @returns {{ok:true}|{ok:false,reason:'dep_changed'|'fault', detail:string, labels:string[]}}
 */
function checkReadyStillValid(cue, cmd, firedEventIdByLabel, faultImpactNow) {
  let snapshot;
  try { snapshot = JSON.parse(cmd.dep_event_snapshot || '{}'); } catch { snapshot = {}; }
  const changedLabels = [];
  const unmetLabels = [];
  for (const dep of cue.deps) {
    const curId = firedEventIdByLabel.get(dep) ?? null;
    if (curId == null) unmetLabels.push(dep);
    if (curId !== (Object.prototype.hasOwnProperty.call(snapshot, dep) ? snapshot[dep] : null)) {
      changedLabels.push(dep);
    }
  }
  if (unmetLabels.length || changedLabels.length) {
    const parts = [];
    if (unmetLabels.length) parts.push(`前置不再处于有效已触发：${unmetLabels.join('、')}`);
    if (changedLabels.length) parts.push(`前置有效触发流水已变化：${changedLabels.join('、')}`);
    return { ok: false, reason: 'dep_changed', detail: parts.join('；'), labels: [...new Set([...unmetLabels, ...changedLabels])] };
  }
  if ((faultImpactNow.blockedByLabel.get(cue.label) || []).length) {
    return {
      ok: false,
      reason: 'fault',
      detail: `提示「${cue.label}」受未解除故障影响：${[...new Set((faultImpactNow.blockedByLabel.get(cue.label) || []).map((f) => f.label))].join('、')}`,
      labels: [cue.label],
    };
  }
  return { ok: true };
}

/**
 * 就绪失效扫描（须在写事务内、任何流水 / 故障写入之后调用）：
 * 遍历该演出全部 ready 口令，凡前置有效触发流水相对确认时快照发生变化
 * （含前置被撤回 / 跳过导致不再有效）或当前受未解除故障影响的，置 invalidated 并留痕。
 * pending（待确认）口令不因此失效——确认时会重新判定。解除故障不触发自动恢复。
 * 返回本次失效的口令清单（presentPrep）。
 */
function sweepPrepReadiness(performanceId, versionId) {
  const cues = getVersionCues(versionId);
  const byLabel = new Map(cues.map((c) => [c.label, c]));
  const latestByCue = latestEventsByCue(performanceId);
  const firedEventIdByLabel = new Map();
  for (const c of cues) {
    const e = latestByCue.get(c.id);
    firedEventIdByLabel.set(c.label, e && e.action === 'fired' ? e.id : null);
  }
  const impactNow = faultImpact(cues, activeFaultRows(performanceId));

  const invalidated = [];
  for (const cmd of activePrepRows(performanceId)) {
    if (cmd.status !== 'ready') continue;
    const cue = byLabel.get(cmd.label);
    if (!cue) continue;
    const check = checkReadyStillValid(cue, cmd, firedEventIdByLabel, impactNow);
    if (check.ok) continue;
    db.prepare(`
      UPDATE cue_prep_commands SET status = 'invalidated', invalidated_reason = ?,
        invalidated_detail = ?, invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND status = 'ready'
    `).run(check.reason, check.detail, cmd.id);
    invalidated.push(presentPrep(db.prepare(`
      SELECT k.*, c.label AS label, c.seq AS seq FROM cue_prep_commands k
      JOIN cues c ON c.id = k.cue_id WHERE k.id = ?
    `).get(cmd.id)));
  }
  return invalidated;
}

/** 口令被消耗（触发 / 跳过导致）：ready → consumed，关联消耗它的流水 */
function markPrepConsumed(commandId, eventId) {
  db.prepare(`
    UPDATE cue_prep_commands SET status = 'consumed', consumed_event_id = ?
    WHERE id = ? AND status IN ('pending','ready')
  `).run(eventId, commandId);
}

/** 活动口令作废：pending/ready → invalidated（附原因与说明） */
function markPrepInvalidated(commandId, reason, detail) {
  db.prepare(`
    UPDATE cue_prep_commands SET status = 'invalidated', invalidated_reason = ?,
      invalidated_detail = ?, invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND status IN ('pending','ready')
  `).run(reason, detail || null, commandId);
}

/* ---------------- 路由表 ---------------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, rx, keys, handler });
}

/* ---- 场次 ---- */

route('GET', '/api/shows', () => {
  const shows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id) AS version_count,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id AND v.status = 'published') AS published_count,
      (SELECT COUNT(*) FROM performances p WHERE p.show_id = s.id) AS performance_count
    FROM shows s ORDER BY s.id DESC
  `).all();
  return { shows };
});

route('POST', '/api/shows', (body) => {
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, '场次名称不能为空');
  const info = db.prepare('INSERT INTO shows (name) VALUES (?)').run(name);
  return { show: db.prepare('SELECT * FROM shows WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/shows/:id', (body, p) => {
  const show = getShow(p.id);
  const versions = db.prepare(
    'SELECT id, show_id, version_number, status, note, created_at, published_at FROM versions WHERE show_id = ? ORDER BY version_number DESC'
  ).all(show.id);
  const performances = db.prepare(`
    SELECT p.*, v.version_number,
      p2.name AS continued_from_name, v2.version_number AS continued_from_version_number
    FROM performances p
    JOIN versions v ON v.id = p.version_id
    LEFT JOIN performances p2 ON p2.id = p.continued_from_performance_id
    LEFT JOIN versions v2 ON v2.id = p2.version_id
    WHERE p.show_id = ? ORDER BY p.id DESC
  `).all(show.id);
  return { show, versions, performances };
});

/* ---- 版本（执行单） ---- */

route('POST', '/api/shows/:id/versions', (body, p) => {
  const show = getShow(p.id);
  return withTx(() => {
    // 基准版本：指定 from_version_id，否则取最新版本；没有则建空白草稿
    let base = null;
    if (body.from_version_id != null) {
      base = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?')
        .get(body.from_version_id, show.id);
      if (!base) throw new HttpError(404, '基准版本不存在');
    } else {
      base = db.prepare('SELECT * FROM versions WHERE show_id = ? ORDER BY version_number DESC LIMIT 1')
        .get(show.id);
    }
    const nextNo = (db.prepare('SELECT COALESCE(MAX(version_number), 0) AS m FROM versions WHERE show_id = ?')
      .get(show.id).m) + 1;
    const info = db.prepare('INSERT INTO versions (show_id, version_number, status, note) VALUES (?,?,?,?)')
      .run(show.id, nextNo, 'draft', String(body.note || '').slice(0, 200));
    const newId = Number(info.lastInsertRowid);
    if (base) {
      const cues = db.prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq').all(base.id);
      const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps, needs_review, needs_prep) VALUES (?,?,?,?,?,?,?,?)');
      for (const c of cues) ins.run(newId, c.seq, c.label, c.type, c.description, c.deps, c.needs_review, c.needs_prep);
    }
    return { version: getVersion(newId), cues: getVersionCues(newId) };
  });
});

route('GET', '/api/versions/:id', (body, p) => {
  const version = getVersion(p.id);
  return { version, cues: getVersionCues(version.id) };
});

route('PUT', '/api/versions/:id/cues', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') {
    throw new HttpError(409, '该版本已发布，内容不可修改；请新建草稿版本');
  }
  if (!Array.isArray(body.cues)) throw new HttpError(400, '请求格式错误：cues 应为数组');
  if (body.cues.length > 500) throw new HttpError(400, '提示数量过多（上限 500）');

  const cues = body.cues.map(sanitizeCue);
  withTx(() => {
    db.prepare('DELETE FROM cues WHERE version_id = ?').run(version.id);
    const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps, needs_review, needs_prep) VALUES (?,?,?,?,?,?,?,?)');
    cues.forEach((c, i) => ins.run(version.id, i + 1, c.label, c.type, c.description, JSON.stringify(c.deps), c.needs_review, c.needs_prep));
  });
  // 草稿允许暂存不完整内容，同时返回校验结果供界面提示
  return { ok: true, errors: validateCues(cues), cues: getVersionCues(version.id) };
});

route('POST', '/api/versions/:id/validate', (body, p) => {
  getVersion(p.id);
  const cues = Array.isArray(body.cues) ? body.cues.map(sanitizeCue) : getVersionCues(p.id);
  return { errors: validateCues(cues) };
});

route('POST', '/api/versions/:id/publish', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') throw new HttpError(409, '该版本已发布');
  const cues = getVersionCues(version.id);
  const errors = validateCues(cues);
  if (errors.length) {
    throw new HttpError(422, '校验未通过，无法发布', { errors });
  }
  withTx(() => {
    db.prepare("UPDATE versions SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(version.id);
  });
  return { version: getVersion(version.id) };
});

/* ---- 演出 ---- */

route('POST', '/api/shows/:id/performances', (body, p) => {
  const show = getShow(p.id);
  let version;
  if (body.version_id != null) {
    version = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?').get(body.version_id, show.id);
    if (!version) throw new HttpError(404, '版本不存在');
    if (version.status !== 'published') {
      throw new HttpError(400, `版本 v${version.version_number} 尚未发布，不能用于启动演出`);
    }
  } else {
    version = db.prepare(
      "SELECT * FROM versions WHERE show_id = ? AND status = 'published' ORDER BY version_number DESC LIMIT 1"
    ).get(show.id);
    if (!version) throw new HttpError(400, '无已发布版本，请先发布执行单后再启动演出');
  }
  const name = String(body.name || '').trim().slice(0, 100);
  const operator = String(body.operator || '').trim().slice(0, 50);
  const info = db.prepare('INSERT INTO performances (show_id, version_id, name, started_by) VALUES (?,?,?,?)')
    .run(show.id, version.id, name, operator);
  return { performance: db.prepare('SELECT * FROM performances WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/performances/:id', (body, p) => {
  const perf = db.prepare(`
    SELECT p.*, s.name AS show_name, v.version_number,
      p2.name AS continued_from_name, v2.version_number AS continued_from_version_number,
      p3.id AS continued_to_id, p3.name AS continued_to_name, v3.version_number AS continued_to_version_number
    FROM performances p
    JOIN shows s ON s.id = p.show_id
    JOIN versions v ON v.id = p.version_id
    LEFT JOIN performances p2 ON p2.id = p.continued_from_performance_id
    LEFT JOIN versions v2 ON v2.id = p2.version_id
    LEFT JOIN performances p3 ON p3.continued_from_performance_id = p.id
    LEFT JOIN versions v3 ON v3.id = p3.version_id
    WHERE p.id = ?
  `).get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');

  // 接续关系（供执行台展示）：从何版本何演出承接；已接续时指向接续演出
  const continuation = {
    from: perf.continued_from_performance_id
      ? {
          performance_id: perf.continued_from_performance_id,
          name: perf.continued_from_name,
          version_number: perf.continued_from_version_number,
        }
      : null,
    to: perf.continued_to_id
      ? {
          performance_id: perf.continued_to_id,
          name: perf.continued_to_name,
          version_number: perf.continued_to_version_number,
        }
      : null,
    readonly: perf.status === 'readonly',
    closed: perf.status === 'closed',
  };

  // 可作为接续目标的版本：同场次、版本号更高、已发布（仅可操作演出列出）
  const targets = perf.status === 'active'
    ? db.prepare(`
        SELECT v.id, v.version_number, v.note, v.published_at FROM versions v
        WHERE v.show_id = ? AND v.status = 'published' AND v.version_number > ?
        ORDER BY v.version_number
      `).all(perf.show_id, perf.version_number)
    : [];

  const cues = getVersionCues(perf.version_id);
  // 完整流水（含撤回、承接），按时间升序；返回时倒序（最新在上）
  const events = db.prepare(`
    SELECT e.*, c.label, c.seq FROM cue_events e
    JOIN cues c ON c.id = e.cue_id
    WHERE e.performance_id = ? ORDER BY e.id
  `).all(perf.id);

  // 归约当前有效结果：fired/skipped 生效，retracted 清除该提示的有效结果
  const eventByCue = new Map();
  for (const e of events) {
    if (e.action === 'retracted') eventByCue.delete(e.cue_id);
    else eventByCue.set(e.cue_id, e);
  }
  const firedLabels = new Set();
  for (const e of eventByCue.values()) {
    if (e.action === 'fired') firedLabels.add(e.label);
  }

  const cueStates = cues.map((c) => {
    const event = eventByCue.get(c.id) || null;
    let status;
    let unmet = [];
    if (event) {
      status = event.action; // fired / skipped
    } else {
      // 未执行提示一律按新版依赖计算状态（承接的已触发会进入 firedLabels，满足前置）
      unmet = c.deps.filter((d) => !firedLabels.has(d));
      status = unmet.length ? 'blocked' : 'pending';
    }
    return { ...c, status, unmet, event };
  });

  // 双人复核申请流水（最新在上）；待复核申请同时挂到对应提示上，便于执行台禁用操作
  const reviewRequests = db.prepare(`
    SELECT r.*, c.label, c.seq FROM cue_review_requests r
    JOIN cues c ON c.id = r.cue_id
    WHERE r.performance_id = ? ORDER BY r.id DESC
  `).all(perf.id);
  const pendingByCue = new Map();
  for (const r of reviewRequests) {
    if (r.status === 'pending' && !pendingByCue.has(r.cue_id)) pendingByCue.set(r.cue_id, r);
  }
  for (const c of cueStates) c.pending_request = pendingByCue.get(c.id) || null;

  // 现场设备故障：全部登记 / 解除记录（最新在上）+ 未解除故障沿前置关系的影响范围；
  // 每个提示挂上 fault_blocked（被哪些未解除故障阻断，含故障编号本身）与自身故障信息
  const impact = faultImpact(cues, activeFaultRows(perf.id));
  const activeFaults = impact.faults;
  const ownFaultByCue = new Map(activeFaults.map((f) => [f.cue_id, f]));
  for (const c of cueStates) {
    const sources = impact.blockedByLabel.get(c.label) || [];
    c.fault_blocked = sources.map(faultBrief);
    c.fault_blocked_labels = [...new Set(sources.map((s) => s.label))];
    c.own_fault = ownFaultByCue.has(c.id) ? faultBrief(ownFaultByCue.get(c.id)) : null;
  }
  const faults = allFaultRows(perf.id).map((row) => {
    const active = activeFaults.find((f) => f.id === row.id);
    return {
      ...row,
      affected_labels: active ? active.affected_labels : [],
    };
  });

  // 预备口令：每个需预备提示挂上当前活动口令（pending/ready）；
  // 顶层给出全部口令历史（最新在上）与活动口令计数。口令本身不是触发，不改变提示状态。
  const prepCommands = allPrepRows(perf.id).map(presentPrep);
  const activePrepByCue = new Map();
  for (const k of prepCommands) {
    if ((k.status === 'pending' || k.status === 'ready') && !activePrepByCue.has(k.cue_id)) {
      activePrepByCue.set(k.cue_id, k);
    }
  }
  for (const c of cueStates) c.prep_command = activePrepByCue.get(c.id) || null;

  // 现场换班交接：当前待签收交接单（附按最新状态实时计算的差异）与全部交接历史
  // （已签收为不可变历史；被重提替换 / 接续作废旧单同样留痕）
  const pendingHandover = pendingHandoverRow(perf.id);
  const handover = pendingHandover
    ? presentHandover(pendingHandover, diffHandoverSnapshot(perf, parseSnapshot(pendingHandover)))
    : null;
  const handover_history = handoverListRows(perf.id).map((row) => presentHandover(row, null));

  // 封场结项：封场后携带不可变结项报告（未封场为 null）；原记录（流水/复核/故障/交接）仍可回看
  const closing = closingRowFor(perf.id);

  return {
    performance: perf,
    continuation,
    continue_targets: targets,
    cues: cueStates,
    events: events.slice().reverse(),
    review_requests: reviewRequests,
    faults,
    active_fault_count: activeFaults.length,
    prep_commands: prepCommands,
    active_prep_count: activePrepByCue.size,
    handover,
    handover_history,
    closing,
  };
});

/* ---- 触发 / 跳过 / 撤回（并发安全：BEGIN IMMEDIATE 事务内读最新事件再判定写入） ---- */

function recordEvent(performanceId, cueId, action, operator, reason) {
  return withTx(() => {
    const { perf, cue } = getPerfCue(performanceId, cueId);

    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(cueId) || null;
    if (effectiveAction(current)) throw conflictError(current);

    // 待复核申请处理前，该提示禁止跳过（fire 对需复核提示已在路由层转为登记申请，不会走到这里）
    const pending = pendingRequestFor(performanceId, cueId);
    if (pending) {
      throw new HttpError(
        409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能${action === 'skipped' ? '跳过' : '触发'}`,
        { request: pending }
      );
    }

    // 未解除的设备故障：受影响提示（故障编号本身及沿前置关系依赖它的后续提示）不得触发。
    // 跳过（skipped）不受故障影响，仍按原有规则执行。
    let impact = null;
    if (action === 'fired') {
      impact = faultImpact(getVersionCues(perf.version_id), activeFaultRows(performanceId));
      const sources = impact.blockedByLabel.get(cue.label) || [];
      if (sources.length) throw faultBlockedError(sources);
    }

    if (action === 'fired') {
      const deps = JSON.parse(cue.deps);
      if (deps.length) {
        // 前置是否满足以"当前有效结果为已触发"判定（已撤回的前置不算）
        const fired = firedLabelSet(perf.version_id, latestByCue);
        const unmet = deps.filter((d) => !fired.has(d));
        if (unmet.length) {
          throw new HttpError(422, `前置提示未触发，无法触发：${unmet.join('、')}`, { unmet });
        }
      }
      // 需预备提示：仅当存在"已就绪"口令才可触发（口令本身不是触发，不能满足下游前置）。
      // 确认就绪后若前置流水变化或出现故障，扫描已将其置为失效；此处再按快照重查一遍（防御并发）。
      if (cue.needs_prep) {
        const prep = activePrepFor(performanceId, cueId);
        if (!prep || prep.status !== 'ready') throw prepNotReadyError(cue, prep);
        const cuesNow = getVersionCues(perf.version_id);
        const firedEventIdByLabel = new Map();
        for (const c of cuesNow) {
          const e = latestByCue.get(c.id);
          firedEventIdByLabel.set(c.label, e && e.action === 'fired' ? e.id : null);
        }
        const check = checkReadyStillValid({ ...cue, deps }, prep, firedEventIdByLabel, impact);
        if (!check.ok) throw prepNotReadyError(cue, prep, `预备口令已失效（${PREP_INVALID_REASON_TEXT[check.reason]}：${check.detail}），请重新预备`);
      }
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, cueId, action, operator, reason);
    const eventId = Number(info.lastInsertRowid);

    // 跳过或触发消耗预备口令：触发须 ready（上方已保证）→ consumed 并关联触发流水；
    // 跳过不要求先就绪——ready 口令同样 consumed，pending（待确认）口令置 invalidated(cue_skipped)。
    const prep = activePrepFor(performanceId, cueId);
    if (prep) {
      if (prep.status === 'ready') {
        markPrepConsumed(prep.id, eventId);
      } else if (action === 'skipped') {
        markPrepInvalidated(prep.id, 'cue_skipped', `提示「${cue.label}」已跳过（操作人 ${operator}，时间见跳过流水 #${eventId}）`);
      }
    }

    // 本次流水可能改变某提示的"前置有效触发流水"：扫描其余已就绪口令，失效项独立留痕。
    const invalidatedPrep = sweepPrepReadiness(performanceId, perf.version_id);

    const event = db.prepare('SELECT * FROM cue_events WHERE id = ?').get(eventId);
    return { event, ...(invalidatedPrep.length ? { invalidated_prep: invalidatedPrep } : {}) };
  });
}

/**
 * 撤回误触发：仅当前有效结果为"已触发"可撤回；已跳过 / 未触发（含已撤回）拒绝。
 * 若沿前置关系可达的后续提示仍有有效"已触发"，整体拒绝并列出受影响编号，任何记录都不改变。
 * 成功后写入 retracted 流水（原触发记录保留），提示回到 待执行 / 受阻，可再次触发或跳过。
 */
function retractEvent(performanceId, cueId, operator, reason) {
  return withTx(() => {
    const { perf, cue } = getPerfCue(performanceId, cueId);

    // 待复核申请处理前禁止撤回（此时提示本就无有效结果，这里给出更明确的错误）
    const pending = pendingRequestFor(performanceId, cueId);
    if (pending) {
      throw new HttpError(
        409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能撤回`,
        { request: pending }
      );
    }

    const latestByCue = latestEventsByCue(performanceId);
    const latest = latestByCue.get(cueId) || null;
    const current = effectiveAction(latest);
    if (current === 'skipped') {
      throw new HttpError(
        409,
        `该提示当前结果为已跳过，不能撤回（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
        { current: latest }
      );
    }
    if (current !== 'fired') {
      throw new HttpError(409, '该提示当前未处于已触发状态，不能撤回', { current: latest });
    }

    // 反向 BFS：沿前置关系找出所有下游提示，其中仍有效"已触发"的即为受影响项
    const cues = getVersionCues(perf.version_id);
    const childrenOf = new Map();
    for (const c of cues) {
      for (const dep of c.deps) {
        if (!childrenOf.has(dep)) childrenOf.set(dep, []);
        childrenOf.get(dep).push(c);
      }
    }
    const affected = [];
    const visited = new Set([cue.label]);
    const queue = [cue.label];
    while (queue.length) {
      const curLabel = queue.shift();
      for (const child of childrenOf.get(curLabel) || []) {
        if (visited.has(child.label)) continue;
        visited.add(child.label);
        queue.push(child.label);
        const e = latestByCue.get(child.id);
        if (e && e.action === 'fired') affected.push(child.label);
      }
    }
    if (affected.length) {
      throw new HttpError(
        409,
        `无法撤回：以下后续提示仍处于已触发状态，请先撤回：${affected.join('、')}`,
        { affected }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, cueId, 'retracted', operator, reason);
    // 撤回改变前置的有效触发流水：以该提示（及其上游）为前置的就绪口令立即失效（解除 / 重发不自动恢复）
    const invalidatedPrep = sweepPrepReadiness(performanceId, perf.version_id);
    const event = db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(info.lastInsertRowid));
    return { event, ...(invalidatedPrep.length ? { invalidated_prep: invalidatedPrep } : {}) };
  });
}

/* ---- 预备口令：发出 / 确认 ---- */

/**
 * 发出预备口令：舞台监督填写本人姓名（issued_by）。仅需预备（needs_prep）且当前无有效结果
 * 的提示可发；只读 / 封场演出拒绝。同一提示同时至多一条活动口令：重新发出时旧活动口令
 * 置 superseded（全量留痕）后写入新的待确认口令。口令本身不是触发。
 */
function issuePrepCommand(performanceId, cueId, issuedBy) {
  return withTx(() => {
    const { cue } = getPerfCue(performanceId, cueId);
    if (!cue.needs_prep) {
      throw new HttpError(400, `提示「${cue.label}」未标记需预备确认，可直接按既有规则触发`);
    }

    const latestByCue = latestEventsByCue(performanceId);
    if (effectiveAction(latestByCue.get(cueId) || null)) {
      throw conflictError(latestByCue.get(cueId));
    }

    const existing = activePrepFor(performanceId, cueId);
    let supersededId = null;
    if (existing) {
      db.prepare(`
        UPDATE cue_prep_commands SET status = 'superseded',
          invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND status IN ('pending','ready')
      `).run(existing.id);
      supersededId = existing.id;
    }

    const info = db.prepare(
      'INSERT INTO cue_prep_commands (performance_id, cue_id, issued_by) VALUES (?,?,?)'
    ).run(performanceId, cueId, issuedBy);
    const newId = Number(info.lastInsertRowid);
    if (supersededId) {
      db.prepare('UPDATE cue_prep_commands SET superseded_by_command_id = ? WHERE id = ?').run(newId, supersededId);
    }
    return {
      command: presentPrep(db.prepare('SELECT * FROM cue_prep_commands WHERE id = ?').get(newId)),
      superseded_command_id: supersededId,
    };
  });
}

/**
 * 确认预备口令：须由发令人之外的另一操作人执行；确认瞬间重查——
 * 提示仍无有效结果、前置当前均已有效触发（并固定各自 fired 流水 id 快照）、无未解除故障影响，
 * 口令才置为 ready。任一不满足返回 422，口令保持待确认（可稍后重新确认；不自动失败）。
 */
function confirmPrepCommand(performanceId, commandId, operator) {
  return withTx(() => {
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
    if (!perf) throw new HttpError(404, '演出不存在');
    assertActiveInTx(perf);

    const cmd = db.prepare(
      'SELECT * FROM cue_prep_commands WHERE id = ? AND performance_id = ?'
    ).get(commandId, performanceId);
    if (!cmd) throw new HttpError(404, '预备口令不存在');
    if (cmd.status !== 'pending') {
      throw new HttpError(
        409,
        `该预备口令已处置：${PREP_STATUS_TEXT[cmd.status]}（发令人 ${cmd.issued_by}）；请重新发出预备口令`,
        { command: presentPrep(cmd) }
      );
    }
    if (cmd.issued_by === operator) {
      throw new HttpError(409, '预备口令确认人不能与发令人相同，须由另一操作人确认', { command: presentPrep(cmd) });
    }

    const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cmd.cue_id, perf.version_id);
    if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');

    const latestByCue = latestEventsByCue(performanceId);
    if (effectiveAction(latestByCue.get(cue.id) || null)) {
      throw conflictError(latestByCue.get(cue.id));
    }

    const deps = JSON.parse(cue.deps);
    const cues = getVersionCues(perf.version_id);
    const firedEventIdByLabel = new Map();
    for (const c of cues) {
      const e = latestByCue.get(c.id);
      firedEventIdByLabel.set(c.label, e && e.action === 'fired' ? e.id : null);
    }
    const unmet = deps.filter((d) => firedEventIdByLabel.get(d) == null);
    if (unmet.length) {
      throw new HttpError(
        422,
        `前置提示未全部有效触发，预备口令保持待确认：${unmet.join('、')}`,
        { unmet, command: presentPrep(cmd) }
      );
    }
    const impact = faultImpact(cues, activeFaultRows(performanceId));
    const faultSources = impact.blockedByLabel.get(cue.label) || [];
    if (faultSources.length) {
      throw new HttpError(
        422,
        `该提示受未解除的设备故障影响，故障解除前预备口令不能确认就绪（口令保持待确认）：${
          faultSources.map((f) => `「${f.label}」（${f.reason}）`).join('、')}`,
        { blocked_by_faults: faultSources.map(faultBrief), command: presentPrep(cmd) }
      );
    }

    // 固定确认瞬间各前置的有效 fired 流水 id：之后任一前置的有效流水变化即判定就绪失效
    const snapshot = {};
    for (const d of deps) snapshot[d] = firedEventIdByLabel.get(d);

    db.prepare(`
      UPDATE cue_prep_commands SET status = 'ready', confirmed_by = ?, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        dep_event_snapshot = ? WHERE id = ? AND status = 'pending'
    `).run(operator, JSON.stringify(snapshot), cmd.id);
    return { command: presentPrep(db.prepare('SELECT * FROM cue_prep_commands WHERE id = ?').get(cmd.id)) };
  });
}

/* ---- 双人复核：触发申请 / 确认 / 撤销 / 驳回 ---- */

/**
 * 登记触发申请：仅登记申请人与时间，提示不算已触发、下游前置仍受阻。
 * 重复申请（已有待复核）或提示已有结果时 409。前置是否满足在确认时才判定，申请阶段不限制。
 */
function createReviewRequest(performanceId, cueId, operator) {
  return withTx(() => {
    const { cue } = getPerfCue(performanceId, cueId);

    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(cueId) || null;
    if (effectiveAction(current)) throw conflictError(current);

    const existing = pendingRequestFor(performanceId, cueId);
    if (existing) {
      throw new HttpError(
        409,
        `该提示已存在待复核的触发申请（申请人 ${existing.requested_by}，时间 ${existing.requested_at}），请勿重复申请`,
        { request: existing }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_review_requests (performance_id, cue_id, requested_by) VALUES (?,?,?)'
    ).run(performanceId, cueId, operator);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/** 取申请并校验属于该演出；只读（已接续）演出拒绝复核处置 */
function getReviewRequest(performanceId, requestId) {
  const req = db.prepare(
    'SELECT * FROM cue_review_requests WHERE id = ? AND performance_id = ?'
  ).get(requestId, performanceId);
  if (!req) throw new HttpError(404, '复核申请不存在');
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (perf) assertActiveInTx(perf);
  return req;
}

function requestConflict(req) {
  return new HttpError(
    409,
    `该申请已处置：${REQUEST_STATUS_TEXT[req.status]}（处置人 ${req.resolved_by || '-'}，时间 ${req.resolved_at || '-'}）`,
    { request: req }
  );
}

/**
 * 确认申请：须为申请人之外的另一操作人；且前置当前均已触发，否则 422 且申请保持待复核。
 * 确认与撤销/驳回在同一事务内判定，并发只有一种结局。确认后写入有效 fired 流水并关联申请。
 */
function confirmReviewRequest(performanceId, requestId, operator) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by === operator) {
      throw new HttpError(409, '复核确认人不能与申请人相同，须由另一操作人确认', { request: req });
    }

    const { perf, cue } = getPerfCue(performanceId, req.cue_id);
    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(req.cue_id) || null;
    if (effectiveAction(current)) throw conflictError(current);

    // 未解除设备故障期间：待复核申请保留，但受影响提示不得确认（申请保持待复核，解除后可再确认）
    const impact = faultImpact(getVersionCues(perf.version_id), activeFaultRows(performanceId));
    const faultSources = impact.blockedByLabel.get(cue.label) || [];
    if (faultSources.length) {
      throw new HttpError(
        422,
        `该提示受未解除的设备故障影响，故障解除前不能确认触发，申请保持待复核：${
          faultSources.map((f) => `「${f.label}」（${f.reason}）`).join('、')}`,
        { blocked_by_faults: faultSources.map(faultBrief), request: req }
      );
    }

    // 前置失效（未触发或已撤回）时拒绝确认，申请保持待复核
    const deps = JSON.parse(cue.deps);
    let cuesVersion = null;
    let firedEventIdByLabel = null;
    if (deps.length) {
      const fired = firedLabelSet(perf.version_id, latestByCue);
      const unmet = deps.filter((d) => !fired.has(d));
      if (unmet.length) {
        throw new HttpError(422, `前置提示未触发，无法确认：${unmet.join('、')}`, { unmet, request: req });
      }
    }

    // 双人复核确认也须重查预备：同时标记需预备的提示，仅当预备口令已就绪才可确认触发
    if (cue.needs_prep) {
      cuesVersion = getVersionCues(perf.version_id);
      firedEventIdByLabel = new Map();
      for (const c of cuesVersion) {
        const e = latestByCue.get(c.id);
        firedEventIdByLabel.set(c.label, e && e.action === 'fired' ? e.id : null);
      }
      const prep = activePrepFor(performanceId, req.cue_id);
      if (!prep || prep.status !== 'ready') {
        throw new HttpError(
          422,
          prep
            ? `提示「${cue.label}」的预备口令尚待确认（发令人 ${prep.issued_by}），预备就绪前复核确认不能触发，申请保持待复核`
            : `提示「${cue.label}」需预备确认，请先发预备口令并确认就绪后再复核确认，申请保持待复核`,
          { needs_prep: true, prep_status: prep ? prep.status : 'none', request: req }
        );
      }
      const checkPrep = checkReadyStillValid({ ...cue, deps }, prep, firedEventIdByLabel, impact);
      if (!checkPrep.ok) {
        throw new HttpError(
          422,
          `预备口令已失效（${PREP_INVALID_REASON_TEXT[checkPrep.reason]}：${checkPrep.detail}），请重新预备后再复核确认，申请保持待复核`,
          { needs_prep: true, prep_status: 'invalidated', request: req }
        );
      }
    }

    const evInfo = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, req.cue_id, 'fired', operator, `双人复核确认（申请人：${req.requested_by}）`);
    const eventId = Number(evInfo.lastInsertRowid);
    // 复核确认触发同样消耗就绪口令
    if (cue.needs_prep) {
      const prep = activePrepFor(performanceId, req.cue_id);
      if (prep) markPrepConsumed(prep.id, eventId);
    }
    // 本次触发可能改变下游的前置流水：扫描其余就绪口令
    const invalidatedPrep = sweepPrepReadiness(performanceId, perf.version_id);
    db.prepare(
      "UPDATE cue_review_requests SET status = 'confirmed', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), event_id = ? WHERE id = ?"
    ).run(operator, eventId, req.id);
    return {
      request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id),
      event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(eventId),
      ...(invalidatedPrep.length ? { invalidated_prep: invalidatedPrep } : {}),
    };
  });
}

/** 撤销申请：仅申请人本人可撤销待复核申请 */
function cancelReviewRequest(performanceId, requestId, operator) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by !== operator) {
      throw new HttpError(409, `只能由申请人本人（${req.requested_by}）撤销该申请`, { request: req });
    }
    db.prepare(
      "UPDATE cue_review_requests SET status = 'cancelled', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(operator, req.id);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id) };
  });
}

/** 驳回申请：申请人之外的其他人填写原因驳回 */
function rejectReviewRequest(performanceId, requestId, operator, reason) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by === operator) {
      throw new HttpError(409, '申请人请使用撤销；驳回须由其他操作人执行', { request: req });
    }
    db.prepare(
      "UPDATE cue_review_requests SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolve_reason = ? WHERE id = ?"
    ).run(operator, reason, req.id);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id) };
  });
}

route('POST', '/api/performances/:id/cues/:cueId/fire', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perfId = Number(p.id);
  const cueId = Number(p.cueId);
  // 需双人复核的提示：触发接口转为登记复核申请，不能绕过复核直接写入触发流水；
  // 普通提示保持原有行为与响应（{ event }）
  const { cue } = getPerfCue(perfId, cueId);
  if (cue.needs_review) return createReviewRequest(perfId, cueId, operator);
  return recordEvent(perfId, cueId, 'fired', operator, null);
});

route('POST', '/api/performances/:id/cues/:cueId/review-requests', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perfId = Number(p.id);
  const cueId = Number(p.cueId);
  const { cue } = getPerfCue(perfId, cueId);
  if (!cue.needs_review) {
    throw new HttpError(400, `提示「${cue.label}」未标记需双人复核，可直接触发`);
  }
  return createReviewRequest(perfId, cueId, operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/confirm', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return confirmReviewRequest(Number(p.id), Number(p.reqId), operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/cancel', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return cancelReviewRequest(Number(p.id), Number(p.reqId), operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/reject', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '驳回必须填写原因');
  return rejectReviewRequest(Number(p.id), Number(p.reqId), operator, reason);
});

/* ---- 预备口令（需预备提示：发出 → 另一操作人确认就绪 → 才可触发） ---- */

route('POST', '/api/performances/:id/cues/:cueId/prep-commands', (body, p) => {
  // 兼容 issued_by（舞台监督发令人）与 operator 两种字段
  const issuedBy = String(body.issued_by || body.operator || '').trim().slice(0, 50);
  if (!issuedBy) throw new HttpError(400, '请填写发令的舞台监督姓名');
  return issuePrepCommand(Number(p.id), Number(p.cueId), issuedBy);
});

route('POST', '/api/performances/:id/prep-commands/:cmdId/confirm', (body, p) => {
  const operator = String(body.operator || body.confirmed_by || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写确认操作人');
  return confirmPrepCommand(Number(p.id), Number(p.cmdId), operator);
});

route('POST', '/api/performances/:id/cues/:cueId/skip', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '跳过必须填写原因');
  return recordEvent(Number(p.id), Number(p.cueId), 'skipped', operator, reason);
});

route('POST', '/api/performances/:id/cues/:cueId/retract', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '撤回必须填写原因');
  return retractEvent(Number(p.id), Number(p.cueId), operator, reason);
});

/* ---- 现场设备故障：登记 / 解除（与现场操作、接续同一 BEGIN IMMEDIATE 串行判定） ---- */

/**
 * 登记故障：舞台监督在当前可操作演出中按提示编号登记，填写操作人与原因。
 *  - 编号不属于该演出使用的版本 → 404（提示须属于该演出的已发布执行单）
 *  - 操作人 / 原因为空 → 400
 *  - 该编号已有未解除故障 → 409（附当前故障）
 *  - 只读（已接续）演出 → 409
 * 登记不改写既有执行流水；返回故障记录及沿前置关系标出的影响范围。
 */
function registerFault(performanceId, cueId, operator, reason) {
  return withTx(() => {
    const { cue } = getPerfCue(performanceId, cueId);

    const existing = db.prepare(
      "SELECT * FROM cue_faults WHERE performance_id = ? AND cue_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(performanceId, cueId);
    if (existing) {
      throw new HttpError(
        409,
        `提示「${cue.label}」已有未解除故障（登记人 ${existing.reported_by}，时间 ${existing.reported_at}），请先解除后再登记`,
        { fault: existing }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_faults (performance_id, cue_id, reported_by, reason) VALUES (?,?,?,?)'
    ).run(performanceId, cueId, operator, reason);
    const faultId = Number(info.lastInsertRowid);

    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);

    // 故障影响已就绪口令：故障提示本身及下游的 ready 口令立即失效（解除故障不自动恢复）。
    // 待确认（pending）口令不失效——确认时会因故障被拒并保持待确认。
    const invalidatedPrep = sweepPrepReadiness(performanceId, perf.version_id);

    // 事务内按最新状态计算影响范围（故障提示本身 + 所有依赖它的后续提示）
    const row = db.prepare(`
      SELECT f.*, c.label AS label, c.seq AS seq FROM cue_faults f
      JOIN cues c ON c.id = f.cue_id WHERE f.id = ?
    `).get(faultId);
    const { faults } = faultImpact(getVersionCues(perf.version_id), [row]);
    return { fault: faults[0], ...(invalidatedPrep.length ? { invalidated_prep: invalidatedPrep } : {}) };
  });
}

/**
 * 解除故障：须记录操作人与原因；该编号存在未解除故障才可解除。
 * 解除后不写入 / 改写任何执行流水，提示状态由 GET 按当前有效结果与前置关系重算
 * （已触发的提示维持已触发并继续满足下游前置；未执行的提示恢复 待执行 / 受阻）。
 */
function resolveFault(performanceId, faultId, operator, reason) {
  return withTx(() => {
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
    if (!perf) throw new HttpError(404, '演出不存在');
    assertActiveInTx(perf);

    const fault = db.prepare(
      'SELECT * FROM cue_faults WHERE id = ? AND performance_id = ?'
    ).get(faultId, performanceId);
    if (!fault) throw new HttpError(404, '故障记录不存在');
    if (fault.status !== 'active') {
      throw new HttpError(
        409,
        `该故障已解除（解除人 ${fault.resolved_by || '-'}，时间 ${fault.resolved_at || '-'}）`,
        { fault }
      );
    }

    db.prepare(`
      UPDATE cue_faults SET status = 'resolved',
        resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolve_reason = ?
      WHERE id = ?
    `).run(operator, reason, fault.id);

    const row = db.prepare(`
      SELECT f.*, c.label AS label, c.seq AS seq FROM cue_faults f
      JOIN cues c ON c.id = f.cue_id WHERE f.id = ?
    `).get(fault.id);
    // 解除后剩余的未解除故障及影响范围（供调用方立即按最新状态展示）
    const { faults: remaining, blockedByLabel } = faultImpact(getVersionCues(perf.version_id), activeFaultRows(performanceId));
    return {
      fault: { ...row, affected_labels: [] },
      remaining_active_faults: remaining,
      still_blocked_labels: [...blockedByLabel.keys()],
    };
  });
}

route('POST', '/api/performances/:id/cues/:cueId/faults', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '登记故障必须填写原因');
  return registerFault(Number(p.id), Number(p.cueId), operator, reason);
});

route('POST', '/api/performances/:id/faults/:faultId/resolve', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '解除故障必须填写原因');
  return resolveFault(Number(p.id), Number(p.faultId), operator, reason);
});

/* ---- 修订执行单接续（核对 + 执行；与现场操作同一 BEGIN IMMEDIATE 串行判定） ---- */

/**
 * 沿 continued_from_performance_id 回溯整条接续链（含当前演出）。
 * 越靠后的元素越早：[当前演出, 来源演出, 来源的来源演出, ...]。
 */
function continuationChain(performanceId) {
  const chain = [];
  const seen = new Set();
  let cur = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    if (!cur.continued_from_performance_id) break;
    cur = db.prepare('SELECT * FROM performances WHERE id = ?').get(cur.continued_from_performance_id);
  }
  return chain;
}

/**
 * 按编号汇总整条接续链中"有任意痕迹"的提示：触发/跳过/撤回流水、复核申请、承接结果。
 * 返回 Map<label, { label, flags:Set, records:[{...}], pending:[request...] }>。
 */
function collectChainHints(chain) {
  const hints = new Map();
  const ensure = (label) => {
    if (!hints.has(label)) hints.set(label, { label, flags: new Set(), records: [], pending: [] });
    return hints.get(label);
  };
  for (const perf of chain) {
    const eventRows = db.prepare(`
      SELECT e.*, c.label AS label FROM cue_events e
      JOIN cues c ON c.id = e.cue_id
      WHERE e.performance_id = ? ORDER BY e.id
    `).all(perf.id);
    for (const e of eventRows) {
      const h = ensure(e.label);
      // 承接事件同时标出「承接」与其结果类型（触发/跳过），便于核对时辨认
      h.flags.add(e.action);
      if (e.source === 'carried') h.flags.add('carried');
      h.records.push({
        performance_id: perf.id,
        version_number: perf.versionNumberForHints,
        action: e.action,
        source: e.source,
        operator: e.operator,
        created_at: e.created_at,
        reason: e.reason || null,
        carried_from_performance_id: e.carried_from_performance_id || null,
      });
    }
    const reqRows = db.prepare(`
      SELECT r.*, c.label AS label FROM cue_review_requests r
      JOIN cues c ON c.id = r.cue_id
      WHERE r.performance_id = ? ORDER BY r.id
    `).all(perf.id);
    for (const r of reqRows) {
      const h = ensure(r.label);
      h.flags.add('review');
      h.records.push({
        performance_id: perf.id,
        version_number: perf.versionNumberForHints,
        review_request: {
          id: r.id,
          status: r.status,
          requested_by: r.requested_by,
          requested_at: r.requested_at,
          resolved_by: r.resolved_by || null,
          resolve_reason: r.resolve_reason || null,
        },
      });
      if (r.status === 'pending') h.pending.push({ ...r, performance_id: perf.id });
    }
  }
  return hints;
}

/** 接续目标版本校验：同场次、已发布、版本号更高 */
function resolveContinueTarget(perf, targetVersionIdRaw) {
  const targetVersionId = Number(targetVersionIdRaw);
  if (!Number.isInteger(targetVersionId)) throw new HttpError(400, '请指定目标版本（version_id）');
  const target = db.prepare('SELECT * FROM versions WHERE id = ?').get(targetVersionId);
  if (!target) throw new HttpError(404, '目标版本不存在');
  if (target.show_id !== perf.show_id) throw new HttpError(400, '目标版本不属于该场次，不能接续');
  if (target.status !== 'published') {
    throw new HttpError(400, `目标版本 v${target.version_number} 尚未发布，不能用于接续`);
  }
  const current = db.prepare('SELECT * FROM versions WHERE id = ?').get(perf.version_id);
  if (target.version_number <= current.version_number) {
    throw new HttpError(
      400,
      `目标版本须为同场次更高版本：当前 v${current.version_number}，目标 v${target.version_number}`
    );
  }
  return target;
}

/**
 * 接续核对（纯读，不改任何数据）：
 *  - 汇总整条接续链中每个有痕迹编号的标记（触发/跳过/撤回/复核/承接）；
 *  - 新版须保留这些编号，且类型、描述、前置编号集合、复核标记完全一致，否则记为冲突；
 *  - 存在待处理（pending）复核申请则冲突（先去处置：确认/撤销/驳回）。
 * 返回 { can_continue, conflicts, pending_requests, hints, carried, target }。
 */
function buildContinuationPlan(perf, target) {
  const chain = continuationChain(perf.id).map((p) => {
    const v = db.prepare('SELECT version_number FROM versions WHERE id = ?').get(p.version_id);
    return { ...p, versionNumberForHints: v ? v.version_number : null };
  });
  const hints = collectChainHints(chain);

  const targetCues = getVersionCues(target.id);
  const targetByLabel = new Map(targetCues.map((c) => [c.label, c]));
  // 当前演出版本中各编号的内容（冲突核对以"当前可操作演出的版本"为准）
  const currentByLabel = new Map(getVersionCues(perf.version_id).map((c) => [c.label, c]));

  const conflictsMap = new Map();
  const addConflict = (label, reason) => {
    if (!conflictsMap.has(label)) conflictsMap.set(label, []);
    const arr = conflictsMap.get(label);
    if (!arr.includes(reason)) arr.push(reason);
  };

  for (const label of hints.keys()) {
    const tc = targetByLabel.get(label);
    if (!tc) {
      addConflict(label, '新版缺失该编号（修订执行单须保留有流水或复核申请的提示编号）');
      continue;
    }
    const cur = currentByLabel.get(label);
    // 编号在更早版本出现、当前版本已不存在：本身就已不可接续，同样按缺失核对
    if (!cur) {
      addConflict(label, '当前演出版本已无该编号，无法核对承接内容');
      continue;
    }
    if (tc.type !== cur.type) addConflict(label, `类型不一致：v${target.version_number} 为 ${tc.type}，当前为 ${cur.type}`);
    if (tc.description !== cur.description) addConflict(label, '描述被修改（有记录的提示描述须原样保留）');
    const curDeps = new Set(cur.deps);
    const newDeps = new Set(tc.deps);
    const missingDeps = cur.deps.filter((d) => !newDeps.has(d));
    const addedDeps = tc.deps.filter((d) => !curDeps.has(d));
    if (missingDeps.length || addedDeps.length) {
      const parts = [];
      if (missingDeps.length) parts.push(`缺少前置：${missingDeps.join('、')}`);
      if (addedDeps.length) parts.push(`新增前置：${addedDeps.join('、')}`);
      addConflict(label, `前置编号集合不一致（${parts.join('；')}）`);
    }
    if (Boolean(tc.needs_review) !== Boolean(cur.needs_review)) {
      addConflict(label, `复核标记不一致：v${target.version_number} 为${tc.needs_review ? '需复核' : '无需复核'}，当前为${cur.needs_review ? '需复核' : '无需复核'}`);
    }
  }

  // 待处理复核申请：链上（防御性）与当前演出的 pending 申请全部列出并构成冲突
  const pendingRequests = [];
  for (const h of hints.values()) {
    for (const rq of h.pending) {
      pendingRequests.push({
        label: h.label,
        request_id: rq.id,
        requested_by: rq.requested_by,
        requested_at: rq.requested_at,
        performance_id: rq.performance_id,
      });
      addConflict(h.label, '存在待处理的复核申请，接续前须先确认、撤销或驳回');
    }
  }

  // 未解除设备故障：接续前必须全部解除（故障登记、解除与接续串行判定）；
  // 防御性地覆盖整条接续链，通常只有当前可操作演出可能存在 active 故障。
  const chainCuesByPerf = new Map(chain.map((p) => [p.id, getVersionCues(p.version_id)]));
  const activeFaults = [];
  for (const p of chain) {
    const rows = activeFaultRows(p.id);
    if (!rows.length) continue;
    const imp = faultImpact(chainCuesByPerf.get(p.id) || [], rows);
    for (const f of imp.faults) {
      activeFaults.push({
        performance_id: p.id,
        fault_id: f.id,
        label: f.label,
        reported_by: f.reported_by,
        reported_at: f.reported_at,
        reason: f.reason,
        affected_labels: f.affected_labels,
      });
      addConflict(f.label, '存在未解除的设备故障，接续前须先解除并记录操作人与原因');
    }
  }

  // 承接清单：当前演出的有效结果（fired/skipped；retracted=无有效结果，不承接）
  const latestByCue = latestEventsByCue(perf.id);
  const carried = [];
  for (const cue of targetCues) {
    const cur = currentByLabel.get(cue.label);
    if (!cur) continue;
    const e = latestByCue.get(cur.id);
    if (e && e.action !== 'retracted') {
      carried.push({
        label: cue.label,
        action: e.action,
        operator: e.operator,
        created_at: e.created_at,
        source_event_id: e.id,
        target_cue_id: cue.id,
      });
    }
  }

  const hintList = [...hints.values()]
    .map((h) => ({
      label: h.label,
      flags: [...h.flags],
      flag_text: h.flags.size ? [...h.flags].map((f) => HINT_FLAG_TEXT[f] || f).join('、') : '',
      records: h.records.map((r) => {
        if (r.review_request) {
          return {
            kind: 'review',
            performance_id: r.performance_id,
            version_number: r.version_number,
            status: r.review_request.status,
            operator: r.review_request.requested_by,
            time: r.review_request.requested_at,
            reason: r.review_request.resolve_reason,
          };
        }
        return {
          kind: r.action,
          performance_id: r.performance_id,
          version_number: r.version_number,
          source: r.source,
          operator: r.operator,
          time: r.created_at,
          reason: r.reason,
          carried_from_performance_id: r.carried_from_performance_id,
        };
      }),
    }))
    .sort((a, b) => {
      const ia = targetByLabel.has(a.label) ? targetByLabel.get(a.label).seq : Number.MAX_SAFE_INTEGER;
      const ib = targetByLabel.has(b.label) ? targetByLabel.get(b.label).seq : Number.MAX_SAFE_INTEGER;
      return ia - ib || a.label.localeCompare(b.label);
    });

  const conflicts = [...conflictsMap.entries()]
    .map(([label, reasons]) => ({ label, reasons }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    can_continue: conflicts.length === 0,
    conflicts,
    pending_requests: pendingRequests.sort((a, b) => a.label.localeCompare(b.label)),
    active_faults: activeFaults.sort((a, b) => a.label.localeCompare(b.label)),
    hints: hintList,
    carried,
  };
}

route('POST', '/api/performances/:id/continue/preview', (body, p) => {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');
  if (perf.status === 'closed') {
    throw new HttpError(409, '该演出已封场结项，不能再发起接续；封场报告可回看', { readonly: true, closed: true });
  }
  if (perf.status === 'readonly') {
    throw new HttpError(409, '该演出已接续并转为只读，不能再发起接续；请从当前可操作（接续）演出发起', { readonly: true });
  }
  const target = resolveContinueTarget(perf, body.version_id);
  const plan = buildContinuationPlan(perf, target);
  return {
    performance: { id: perf.id, name: perf.name },
    target_version: { id: target.id, version_number: target.version_number, note: target.note },
    ...plan,
  };
});

/**
 * 执行接续：
 *  事务内再次核对（与触发/跳过/撤回/复核串行），有冲突整体放弃，原演出保持可操作、不产生接续记录；
 *  通过则新建接续演出（绑定目标版本），把当前演出有效结果复制为 carried 流水（保留原操作人与时间，
 *  非再次触发、标出来源），并将原演出置为 readonly（仍绑定原快照，仅可回看）。
 */
function continuePerformance(perf, target, operator, name) {
  return withTx(() => {
    // 事务内读最新状态：可能在排队期间已被接续 / 被现场操作改动
    const fresh = db.prepare('SELECT * FROM performances WHERE id = ?').get(perf.id);
    assertActiveInTx(fresh);

    const plan = buildContinuationPlan(fresh, target);
    if (plan.conflicts.length) {
      throw new HttpError(409, '接续核对未通过，请按冲突清单处理后重试', {
        conflicts: plan.conflicts,
        pending_requests: plan.pending_requests,
        active_faults: plan.active_faults,
      });
    }

    const perfName = name
      || `${fresh.name || '演出'}（接续 v${target.version_number}）`;
    const info = db.prepare(`
      INSERT INTO performances (show_id, version_id, name, started_by, status,
                                continued_from_performance_id, continued_at, continued_by)
      VALUES (?,?,?,?,'active',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)
    `).run(fresh.show_id, target.id, perfName.slice(0, 100), operator, fresh.id, operator);
    const newId = Number(info.lastInsertRowid);

    // 承接有效结果：复制为 carried 流水，沿用原操作人与原时间，指向来源事件/来源演出；
    // action 仍为 fired/skipped，故状态归约与前置判定复用现有逻辑（绝非再次触发）
    const ins = db.prepare(`
      INSERT INTO cue_events (performance_id, cue_id, action, operator, reason, created_at,
                              source, carried_from_performance_id, carried_from_event_id)
      VALUES (?,?,?,?,?,?, 'carried', ?, ?)
    `);
    for (const item of plan.carried) {
      ins.run(newId, item.target_cue_id, item.action, item.operator,
        `自演出 #${fresh.id} 承接（${ACTION_TEXT[item.action]}）`,
        item.created_at, fresh.id, item.source_event_id);
    }

    // 原演出转只读：仍绑定原版本快照，流水与申请全部保留；记录接续时间与操作人
    db.prepare(`
      UPDATE performances SET status = 'readonly',
        continued_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), continued_by = ?
      WHERE id = ?
    `).run(operator, fresh.id);

    // 原演出的待签收交接单随接续一并作废旧单（只读演出不能提交、重提或签收）；
    // 已签收历史与被替换旧单原样保留。串行判定保证此刻不会与签收 / 重提交叉。
    db.prepare(`
      UPDATE cue_handovers SET status = 'superseded',
        superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE performance_id = ? AND status = 'pending'
    `).run(fresh.id);

    // 接续演出不承接预备状态：原演出的待确认 / 已就绪口令全部作废留痕；
    // 接续演出（新演出、新 cue_id）无任何口令，需预备提示一律重新预备。
    db.prepare(`
      UPDATE cue_prep_commands SET status = 'invalidated', invalidated_reason = 'performance_continued',
        invalidated_detail = ?, invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE performance_id = ? AND status IN ('pending','ready')
    `).run(`原演出接续到演出 #${newId}（v${target.version_number}），预备状态不承接`, fresh.id);

    const newPerf = db.prepare('SELECT * FROM performances WHERE id = ?').get(newId);
    return {
      performance: newPerf,
      source_performance_id: fresh.id,
      target_version: { id: target.id, version_number: target.version_number, note: target.note },
      carried_count: plan.carried.length,
      carried: plan.carried.map((c) => ({ label: c.label, action: c.action, operator: c.operator })),
    };
  });
}

route('POST', '/api/performances/:id/continue', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');
  if (perf.status === 'closed') {
    throw new HttpError(409, '该演出已封场结项，不能重复接续；封场报告可回看', { readonly: true, closed: true });
  }
  if (perf.status === 'readonly') {
    throw new HttpError(409, '该演出已接续并转为只读，不能重复接续；请从当前可操作（接续）演出发起', { readonly: true });
  }
  const target = resolveContinueTarget(perf, body.version_id);
  const name = String(body.name || '').trim().slice(0, 100);
  return continuePerformance(perf, target, operator, name);
});

/* ---- 现场换班交接（提交 / 重提替换 / 签收核对；与现场操作、复核、故障、接续同一 BEGIN IMMEDIATE 串行判定） ---- */

const HANDOVER_STATUS_TEXT = { pending: '待签收', signed: '已签收', superseded: '已被重提替换' };
// 尚未完成提示的阻塞原因（快照固定，签收时按最新状态逐项核对）
const PENDING_REASON_TEXT = {
  blocked: '受阻：前置未触发',
  review_pending: '待复核申请未处置',
  own_fault: '本提示有未解除故障',
  fault_blocked: '受未解除故障影响，触发冻结',
  prep_none: '需预备确认：尚未发出预备口令',
  prep_pending: '预备口令待另一操作人确认就绪',
  pending: '待执行',
};

/** 该演出当前待签收交接单（无则 null）。须在事务内调用以读到最新状态 */
function pendingHandoverRow(performanceId) {
  return db.prepare(
    "SELECT * FROM cue_handovers WHERE performance_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
  ).get(performanceId) || null;
}

/** 该演出全部交接单（最新在上） */
function handoverListRows(performanceId) {
  return db.prepare(
    'SELECT * FROM cue_handovers WHERE performance_id = ? ORDER BY id DESC'
  ).all(performanceId);
}

function parseSnapshot(row) {
  try {
    return JSON.parse(row.snapshot);
  } catch {
    return null;
  }
}

function cueEffectiveSummary(latestByCue, cueId) {
  const e = latestByCue.get(cueId) || null;
  return e && e.action !== 'retracted'
    ? { action: e.action, event_id: e.id, operator: e.operator, created_at: e.created_at }
    : null;
}

/**
 * 固定交接快照：各提示当前有效结果、最新流水位置（cue_events 最大 id）、
 * 待复核申请（全部申请状态；含待处理明细）、未解除故障（含沿前置关系的影响范围）、
 * 尚未完成的提示（无有效结果）及阻塞原因。
 * 须在 BEGIN IMMEDIATE 事务内调用，保证与提交 / 签收判定读到同一状态。
 */
function buildHandoverSnapshot(perf) {
  const cues = getVersionCues(perf.version_id);
  const latestByCue = latestEventsByCue(perf.id);
  const firedLabels = new Set();
  for (const c of cues) {
    const e = latestByCue.get(c.id);
    if (e && e.action === 'fired') firedLabels.add(c.label);
  }

  const impact = faultImpact(cues, activeFaultRows(perf.id));
  const ownFaultCueIds = new Set(impact.faults.map((f) => f.cue_id));

  const pendingRequests = db.prepare(`
    SELECT r.*, c.label AS label FROM cue_review_requests r
    JOIN cues c ON c.id = r.cue_id
    WHERE r.performance_id = ? ORDER BY r.id
  `).all(perf.id);

  // 当前活动预备口令（待确认 / 已就绪）：交接快照固定，签收时按最新状态核对
  const activePreps = activePrepRows(perf.id);
  const activePrepByCueIds = new Map(activePreps.map((k) => [k.cue_id, k]));

  const cue_results = cues.map((c) => {
    const summary = cueEffectiveSummary(latestByCue, c.id);
    return {
      cue_id: c.id,
      label: c.label,
      seq: c.seq,
      status: summary ? summary.action : null, // fired / skipped / null
      event_id: summary ? summary.event_id : null,
      operator: summary ? summary.operator : null,
      created_at: summary ? summary.created_at : null,
    };
  });

  const pending_cues = [];
  for (const c of cues) {
    if (cueEffectiveSummary(latestByCue, c.id)) continue; // 已有有效结果（已触发 / 已跳过）即已完成
    const reasons = [];
    const unmet = c.deps.filter((d) => !firedLabels.has(d));
    if (unmet.length) reasons.push({ code: 'blocked', text: PENDING_REASON_TEXT.blocked, unmet });
    const req = pendingRequestFor(perf.id, c.id);
    if (req) {
      reasons.push({
        code: 'review_pending',
        text: PENDING_REASON_TEXT.review_pending,
        requested_by: req.requested_by,
        requested_at: req.requested_at,
        request_id: req.id,
      });
    }
    if (ownFaultCueIds.has(c.id)) reasons.push({ code: 'own_fault', text: PENDING_REASON_TEXT.own_fault });
    else if ((impact.blockedByLabel.get(c.label) || []).length) {
      reasons.push({ code: 'fault_blocked', text: PENDING_REASON_TEXT.fault_blocked });
    }
    const prep = activePrepByCueIds.get(c.id);
    if (c.needs_prep) {
      if (!prep) {
        reasons.push({ code: 'prep_none', text: PENDING_REASON_TEXT.prep_none });
      } else if (prep.status === 'pending') {
        reasons.push({
          code: 'prep_pending',
          text: PENDING_REASON_TEXT.prep_pending,
          issued_by: prep.issued_by,
          issued_at: prep.issued_at,
          command_id: prep.id,
        });
      }
      // ready 不构成阻塞（已就绪待触发）
    }
    if (!reasons.length) reasons.push({ code: 'pending', text: PENDING_REASON_TEXT.pending });
    pending_cues.push({
      cue_id: c.id,
      label: c.label,
      seq: c.seq,
      reasons,
      reason_codes: reasons.map((r) => r.code),
      reason_text: reasons.map((r) => {
        if (r.code === 'blocked') return `${r.text}（${r.unmet.join('、')}）`;
        if (r.code === 'review_pending') return `${r.text}（申请人 ${r.requested_by}）`;
        if (r.code === 'prep_pending') return `${r.text}（发令人 ${r.issued_by}）`;
        return r.text;
      }).join('；'),
    });
  }

  return {
    version: 20261003,
    taken_at: new Date().toISOString(),
    version_id: perf.version_id,
    latest_event_id: latestByCue.size
      ? Math.max(...[...latestByCue.values()].map((e) => e.id))
      : null,
    cue_results,
    pending_requests: pendingRequests.map((r) => ({
      request_id: r.id,
      cue_id: r.cue_id,
      label: r.label,
      status: r.status,
      requested_by: r.requested_by,
      requested_at: r.requested_at,
      resolved_by: r.resolved_by || null,
      resolved_at: r.resolved_at || null,
      resolve_reason: r.resolve_reason || null,
      event_id: r.event_id || null,
    })),
    active_prep_commands: activePreps.map((k) => ({
      command_id: k.id,
      cue_id: k.cue_id,
      label: k.label,
      status: k.status,
      issued_by: k.issued_by,
      issued_at: k.issued_at,
      confirmed_by: k.confirmed_by || null,
      confirmed_at: k.confirmed_at || null,
    })),
    active_faults: impact.faults.map((f) => ({
      fault_id: f.id,
      cue_id: f.cue_id,
      label: f.label,
      reported_by: f.reported_by,
      reason: f.reason,
      reported_at: f.reported_at,
      affected_labels: f.affected_labels,
    })),
    pending_cues,
  };
}

/**
 * 签收核对：把快照与当前最新状态逐项比对，返回差异清单（现场交接期间操作照常，差异即变化项）。
 * 分五组：最新流水位置、有效结果、待复核申请、未解除故障、尚未完成提示（含阻塞原因）。
 * 须在 BEGIN IMMEDIATE 事务内调用；纯读，不改变任何数据。
 */
function diffHandoverSnapshot(perf, snap) {
  const cues = getVersionCues(perf.version_id);
  const latestByCue = latestEventsByCue(perf.id);
  const currentMaxId = latestByCue.size ? Math.max(...[...latestByCue.values()].map((e) => e.id)) : null;

  const groups = {
    event_position: [],
    cue_results: [],
    review_requests: [],
    active_faults: [],
    active_prep_commands: [],
    pending_cues: [],
  };

  // 1) 最新流水位置（任何新增 / 撤回流水都会改变）
  if (!snap || snap.latest_event_id !== currentMaxId) {
    groups.event_position.push({
      field: 'latest_event_id',
      snapshot: snap ? snap.latest_event_id : null,
      current: currentMaxId,
      message: `最新流水位置已变化：快照固定为第 ${snap ? snap.latest_event_id : '-'} 条，当前为第 ${currentMaxId || 0} 条`,
    });
  }

  if (snap) {
    // 2) 各提示有效结果（fired / skipped / 无结果）
    const snapResultByLabel = new Map((snap.cue_results || []).map((r) => [r.label, r]));
    for (const c of cues) {
      const snapR = snapResultByLabel.get(c.label);
      const cur = cueEffectiveSummary(latestByCue, c.id);
      const snapAction = snapR ? snapR.status : null;
      const curAction = cur ? cur.action : null;
      if (snapAction !== curAction) {
        groups.cue_results.push({
          label: c.label,
          snapshot: snapAction
            ? { action: snapAction, operator: snapR.operator, created_at: snapR.created_at }
            : null,
          current: cur,
          message: `提示「${c.label}」有效结果已变化：${snapAction ? ACTION_TEXT[snapAction] : '未完成'} → ${curAction ? ACTION_TEXT[curAction] : '未完成'}`,
        });
      }
    }

    // 3) 待复核申请：快照中的申请若已处置 / 消失，或出现新的待复核申请
    const curReqs = db.prepare(`
      SELECT r.*, c.label AS label FROM cue_review_requests r
      JOIN cues c ON c.id = r.cue_id
      WHERE r.performance_id = ? ORDER BY r.id
    `).all(perf.id);
    const curReqById = new Map(curReqs.map((r) => [r.id, r]));
    for (const sr of snap.pending_requests || []) {
      const cur = curReqById.get(sr.request_id);
      if (!cur || cur.status !== sr.status) {
        groups.review_requests.push({
          request_id: sr.request_id,
          label: sr.label,
          kind: cur && cur.status !== sr.status ? 'changed' : 'missing',
          snapshot: { status: sr.status, requested_by: sr.requested_by },
          current: cur ? { status: cur.status, resolved_by: cur.resolved_by } : null,
          message: cur && cur.status !== sr.status
            ? `提示「${sr.label}」的复核申请已${REQUEST_STATUS_TEXT[cur.status]}（处置人 ${cur.resolved_by || '-'}）`
            : `提示「${sr.label}」的复核申请记录已不存在`,
        });
      }
    }
    const snapReqIds = new Set((snap.pending_requests || []).map((r) => r.request_id));
    for (const r of curReqs) {
      if (!snapReqIds.has(r.id)) {
        groups.review_requests.push({
          request_id: r.id,
          label: r.label,
          kind: 'new',
          snapshot: null,
          current: { status: r.status, requested_by: r.requested_by },
          message: `出现新的复核申请：提示「${r.label}」（申请人 ${r.requested_by}，${REQUEST_STATUS_TEXT[r.status]}）`,
        });
      }
    }

    // 4) 未解除故障：快照中的故障若已解除 / 消失，或登记了新故障（影响范围一并给出）
    const impactNow = faultImpact(cues, activeFaultRows(perf.id));
    const curFaultById = new Map(impactNow.faults.map((f) => [f.id, f]));
    for (const sf of snap.active_faults || []) {
      if (!curFaultById.has(sf.fault_id)) {
        groups.active_faults.push({
          fault_id: sf.fault_id,
          label: sf.label,
          kind: 'resolved',
          snapshot: { reported_by: sf.reported_by, reason: sf.reason },
          current: null,
          message: `故障已解除：提示「${sf.label}」（登记人 ${sf.reported_by}：${sf.reason}）`,
        });
      }
    }
    const snapFaultIds = new Set((snap.active_faults || []).map((f) => f.fault_id));
    for (const f of impactNow.faults) {
      if (!snapFaultIds.has(f.id)) {
        groups.active_faults.push({
          fault_id: f.id,
          label: f.label,
          kind: 'new',
          snapshot: null,
          current: { reported_by: f.reported_by, reason: f.reason, affected_labels: f.affected_labels },
          message: `登记了新故障：提示「${f.label}」（登记人 ${f.reported_by}：${f.reason}），影响 ${f.affected_labels.join('、')}`,
        });
      }
    }

    // 4.5) 活动预备口令：快照中的口令状态变化（待确认→就绪 / 失效 / 被重发作废 / 已消耗 / 被跳过作废），
    //      或出现新的活动口令；就绪因前置流水变化失效已在状态中体现
    const curPreps = activePrepRows(perf.id);
    const curPrepById = new Map(curPreps.map((k) => [k.id, k]));
    const curPrepByCue = new Map(curPreps.map((k) => [k.cue_id, k]));
    for (const sp of snap.active_prep_commands || []) {
      const cur = curPrepById.get(sp.command_id);
      if (!cur || cur.status !== sp.status) {
        let message;
        if (!cur) {
          const full = db.prepare('SELECT * FROM cue_prep_commands WHERE id = ?').get(sp.command_id);
          if (full && full.status === 'consumed') {
            message = `提示「${sp.label}」的预备口令已随触发 / 跳过消耗（${PREP_STATUS_TEXT.consumed}）`;
          } else if (full && full.status === 'invalidated') {
            message = `提示「${sp.label}」的预备口令已失效：${PREP_INVALID_REASON_TEXT[full.invalidated_reason] || full.invalidated_reason || '-'}`;
          } else if (full && full.status === 'superseded') {
            message = `提示「${sp.label}」的预备口令已被重新发出作废`;
          } else {
            message = `提示「${sp.label}」的预备口令记录已不存在`;
          }
        } else {
          message = `提示「${sp.label}」的预备口令状态已变化：${PREP_STATUS_TEXT[sp.status]} → ${PREP_STATUS_TEXT[cur.status]}`;
        }
        groups.active_prep_commands.push({
          command_id: sp.command_id,
          label: sp.label,
          kind: cur && cur.status !== sp.status ? 'changed' : 'gone',
          snapshot: { status: sp.status, status_text: PREP_STATUS_TEXT[sp.status], issued_by: sp.issued_by },
          current: cur ? { status: cur.status, status_text: PREP_STATUS_TEXT[cur.status], confirmed_by: cur.confirmed_by } : null,
          message,
        });
      }
    }
    const snapPrepIds = new Set((snap.active_prep_commands || []).map((k) => k.command_id));
    for (const k of curPreps) {
      if (!snapPrepIds.has(k.id)) {
        groups.active_prep_commands.push({
          command_id: k.id,
          label: k.label,
          kind: 'new',
          snapshot: null,
          current: { status: k.status, status_text: PREP_STATUS_TEXT[k.status], issued_by: k.issued_by, confirmed_by: k.confirmed_by },
          message: `出现新的活动预备口令：提示「${k.label}」（${PREP_STATUS_TEXT[k.status]}，发令人 ${k.issued_by}）`,
        });
      }
    }

    // 5) 尚未完成提示及阻塞原因：以"快照时未完成、当前仍未完成"的提示比对阻塞原因；
    //    新出现 / 已完成的未完成提示已由有效结果差异（cue_results）反映。
    const currentNow = buildHandoverSnapshot(perf);
    const curPendingByLabel = new Map(currentNow.pending_cues.map((p) => [p.label, p]));
    for (const sp of snap.pending_cues || []) {
      const cp = curPendingByLabel.get(sp.label);
      if (!cp) continue; // 当前已完成 → 已由 cue_results 差异覆盖
      const a = sp.reason_codes.join(',');
      const b = cp.reason_codes.join(',');
      if (a !== b) {
        groups.pending_cues.push({
          label: sp.label,
          snapshot: { reason_codes: sp.reason_codes, reason_text: sp.reason_text },
          current: { reason_codes: cp.reason_codes, reason_text: cp.reason_text },
          message: `未完成提示「${sp.label}」阻塞原因已变化：${sp.reason_text} → ${cp.reason_text}`,
        });
      }
    }
  }

  const diff_count = Object.values(groups).reduce((n, arr) => n + arr.length, 0);
  return { matched: diff_count === 0, diff_count, groups };
}

/** 交接单序列化（snapshot 解析为对象；待签收单可附最新差异 live_diff） */
function presentHandover(row, liveDiff) {
  const snap = parseSnapshot(row);
  return {
    id: row.id,
    performance_id: row.performance_id,
    status: row.status,
    status_text: HANDOVER_STATUS_TEXT[row.status] || row.status,
    handed_by: row.handed_by,
    received_by: row.received_by,
    note: row.note,
    created_at: row.created_at,
    signed_at: row.signed_at || null,
    superseded_at: row.superseded_at || null,
    superseded_by_handover_id: row.superseded_by_handover_id || null,
    snapshot: snap,
    ...(liveDiff ? { live_diff: liveDiff } : {}),
  };
}

/** 解析并校验交班人 / 接班人：非空且不同（截断长度与既有操作人一致） */
function parseHandoverPeople(body) {
  const handedBy = String(body.handed_by || '').trim().slice(0, 50);
  const receivedBy = String(body.received_by || '').trim().slice(0, 50);
  if (!handedBy) throw new HttpError(400, '请填写交班人');
  if (!receivedBy) throw new HttpError(400, '请填写接班人');
  if (handedBy === receivedBy) throw new HttpError(400, '交班人与接班人不能为同一人');
  return { handedBy, receivedBy };
}

/**
 * 提交 / 重提交接单：
 *  - 仅当前可操作（active）演出可提交；只读（已接续）演出 409
 *  - 交班人 / 接班人非空且不同，否则 400
 *  - 同一演出只保留一张待签收单：已有待签收单时，须由原交班人用同一姓名重提，
 *    旧单置为 superseded（保留留痕）并写入新快照；非原交班人重提 409。
 * 交接期间现场操作照常：本接口只固定快照，不冻结任何现场操作。
 */
function submitHandover(performanceId, handedBy, receivedBy, note) {
  return withTx(() => {
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
    if (!perf) throw new HttpError(404, '演出不存在');
    assertActiveInTx(perf);

    const existing = pendingHandoverRow(performanceId);
    if (existing && existing.handed_by !== handedBy) {
      throw new HttpError(
        409,
        `该演出已有待签收交接单（交班人 ${existing.handed_by}，提交时间 ${existing.created_at}），只能由原交班人重提以替换快照`,
        { handover: presentHandover(existing, null) }
      );
    }

    const snapshot = buildHandoverSnapshot(perf);
    let newId;
    if (existing) {
      // 原交班人重提：旧待签收单标记为已被替换（不可变留痕），再写入新单；
      // 部分唯一索引保证同一演出至多一张 pending
      db.prepare(`
        UPDATE cue_handovers SET status = 'superseded',
          superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).run(existing.id);
      const info = db.prepare(`
        INSERT INTO cue_handovers (performance_id, status, handed_by, received_by, note, snapshot)
        VALUES (?, 'pending', ?, ?, ?, ?)
      `).run(performanceId, handedBy, receivedBy, note, JSON.stringify(snapshot));
      newId = Number(info.lastInsertRowid);
      db.prepare('UPDATE cue_handovers SET superseded_by_handover_id = ? WHERE id = ?').run(newId, existing.id);
    } else {
      const info = db.prepare(`
        INSERT INTO cue_handovers (performance_id, status, handed_by, received_by, note, snapshot)
        VALUES (?, 'pending', ?, ?, ?, ?)
      `).run(performanceId, handedBy, receivedBy, note, JSON.stringify(snapshot));
      newId = Number(info.lastInsertRowid);
    }

    const row = db.prepare('SELECT * FROM cue_handovers WHERE id = ?').get(newId);
    return {
      handover: presentHandover(row, { matched: true, diff_count: 0, groups: emptyDiffGroups() }),
      replaced_handover_id: existing ? existing.id : null,
    };
  });
}

function emptyDiffGroups() {
  return { event_position: [], cue_results: [], review_requests: [], active_faults: [], active_prep_commands: [], pending_cues: [] };
}

/**
 * 接班人签收：事务内按最新状态逐项核对——
 *  - 交班人本人或其他人签收 → 409（只有接班人本人可签收）
 *  - 重复签收（已无待签收单）→ 409
 *  - 任一快照内容已变化 → 409 返回差异（groups/diffs），交接单保持待签收，交班人可据此重提
 *  - 全部一致 → 置为 signed（记录签收时间），成为不可变历史；之后该演出可再次发起新一轮交接
 */
function signHandover(performanceId, operator) {
  return withTx(() => {
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
    if (!perf) throw new HttpError(404, '演出不存在');

    const row = pendingHandoverRow(performanceId);
    // 只读（已接续）演出：待签收单在接续时已自动作废，提交 / 重提 / 签收一律拒绝
    if (perf.status === 'readonly') {
      assertActiveInTx(perf); // 抛出统一的只读错误（附接续演出位置）
    }
    if (!row) {
      const last = db.prepare('SELECT * FROM cue_handovers WHERE performance_id = ? ORDER BY id DESC LIMIT 1').get(performanceId);
      if (last && last.status === 'signed') {
        throw new HttpError(
          409,
          `该演出的交接单已签收（接班人 ${last.received_by}，签收时间 ${last.signed_at}），请勿重复签收；如需再次换班请重新发起交接`,
          { handover: presentHandover(last, null) }
        );
      }
      if (last && last.status === 'superseded') {
        throw new HttpError(409, '该演出的待签收交接单已被重提替换，无待签收交接单可签收');
      }
      throw new HttpError(409, '该演出当前没有待签收交接单');
    }

    if (operator !== row.received_by) {
      throw new HttpError(
        409,
        operator === row.handed_by
          ? `交班人本人不能签收交接单：签收人须为接班人 ${row.received_by}`
          : `只有接班人 ${row.received_by} 本人可以签收该交接单（当前签收人：${operator}）`,
        { handover: presentHandover(row, null), expected_received_by: row.received_by }
      );
    }

    const snap = parseSnapshot(row);
    const diff = diffHandoverSnapshot(perf, snap);
    if (!diff.matched) {
      throw new HttpError(
        409,
        `交接单核对未通过：自 ${row.created_at} 提交以来现场已有 ${diff.diff_count} 项与快照不一致，交接单保持待签收；请逐项核对差异，由交班人 ${row.handed_by} 重提替换快照后再签收`,
        {
          handover: presentHandover(row, diff),
          matched: false,
          diff_count: diff.diff_count,
          groups: diff.groups,
          diffs: flattenDiffs(diff.groups),
        }
      );
    }

    db.prepare(`
      UPDATE cue_handovers SET status = 'signed',
        signed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(row.id);
    const signed = db.prepare('SELECT * FROM cue_handovers WHERE id = ?').get(row.id);
    return { handover: presentHandover(signed, { matched: true, diff_count: 0, groups: emptyDiffGroups() }) };
  });
}

/** 把分组差异打平为统一清单（执行台表格展示用） */
function flattenDiffs(groups) {
  const meta = [
    ['event_position', '最新流水位置'],
    ['cue_results', '有效结果'],
    ['review_requests', '复核申请'],
    ['active_faults', '未解除故障'],
    ['active_prep_commands', '预备口令'],
    ['pending_cues', '未完成提示'],
  ];
  const diffs = [];
  for (const [key, section] of meta) {
    for (const item of groups[key]) {
      diffs.push({ section: key, section_text: section, ...item });
    }
  }
  return diffs;
}

route('POST', '/api/performances/:id/handover', (body, p) => {
  const { handedBy, receivedBy } = parseHandoverPeople(body);
  const note = String(body.note != null ? body.note : '').trim().slice(0, 500);
  return submitHandover(Number(p.id), handedBy, receivedBy, note);
});

route('POST', '/api/performances/:id/handover/sign', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写签收人');
  return signHandover(Number(p.id), operator);
});

/** 签收前只读核对（不改数据）：返回待签收单与当前差异，便于执行台展示 / 调用方预检查 */
route('POST', '/api/performances/:id/handover/check', (body, p) => {
  const perfId = Number(p.id);
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(perfId);
  if (!perf) throw new HttpError(404, '演出不存在');
  return withTx(() => {
    const fresh = db.prepare('SELECT * FROM performances WHERE id = ?').get(perfId);
    const row = pendingHandoverRow(perfId);
    if (!row) {
      throw new HttpError(409, '该演出当前没有待签收交接单', { readonly: fresh.status === 'readonly' });
    }
    const diff = diffHandoverSnapshot(fresh, parseSnapshot(row));
    return {
      handover: presentHandover(row, diff),
      matched: diff.matched,
      diff_count: diff.diff_count,
      groups: diff.groups,
      diffs: flattenDiffs(diff.groups),
    };
  });
});

/* ---- 现场成组处置（逐项预览 + 整组提交；与单项 / 接续同一 BEGIN IMMEDIATE 串行判定） ---- */

const BATCH_ACTIONS = ['fire', 'skip', 'retract'];
const BATCH_ACTION_TEXT = { fire: '触发', skip: '跳过', retract: '撤回' };
const BATCH_MAX_ITEMS = 500;

/**
 * 解析成组请求体并做整组结构校验：本组操作人必填；items 为非空数组（≤500）；
 * 每项编号非空、动作合法；编号不得重复。任一不满足直接拒绝（不进入逐项判定）。
 */
function parseGroupBody(body) {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写本组操作人');
  if (!Array.isArray(body.items)) throw new HttpError(400, '请求格式错误：items 应为数组');
  if (body.items.length === 0) throw new HttpError(400, '成组操作清单为空：请至少添加一项');
  if (body.items.length > BATCH_MAX_ITEMS) throw new HttpError(400, `成组操作项过多（上限 ${BATCH_MAX_ITEMS} 项）`);

  const items = body.items.map((raw, i) => {
    const label = String((raw && raw.label) != null ? raw.label : '').trim().slice(0, 50);
    const action = String((raw && raw.action) || '').trim();
    const reason = String((raw && raw.reason) != null ? raw.reason : '').trim().slice(0, 200);
    if (!label) throw new HttpError(400, `第 ${i + 1} 项：提示编号不能为空`);
    if (!BATCH_ACTIONS.includes(action)) {
      throw new HttpError(400, `第 ${i + 1} 项（编号 ${label}）：动作无效，应为 fire / skip / retract`);
    }
    return { label, action, reason };
  });

  const seen = new Set();
  items.forEach((it, i) => {
    if (seen.has(it.label)) {
      throw new HttpError(400, `第 ${i + 1} 项：编号「${it.label}」在本组清单中重复，每个编号只能出现一次`);
    }
    seen.add(it.label);
  });

  return { operator, items };
}

/**
 * 逐项判定成组处置（核心规则与单项接口完全一致）：
 *  - 按清单顺序逐项处理，每一步基于前序步骤产生的有效结果判定（前置满足、下游保护、待复核限制）；
 *  - 任一项失败只记录该项失败原因，不影响后续项的预览判定（dryRun 时失败项不产生有效结果）；
 *  - dryRun=true（预览）：不写任何数据，成功项以拟操作参与后续判定；
 *  - dryRun=false（提交）：调用方须已持有 BEGIN IMMEDIATE 事务并确认演出可操作；成功项立即写入
 *    与单项一致的 manual 流水，任一项失败由调用方整体回滚（整组不产生流水）。
 * 返回 { results, success_count, failure_count, can_submit }。
 */
function evaluateBatch(perf, operator, items, dryRun) {
  const versionId = perf.version_id;
  const cues = getVersionCues(versionId);
  const byLabel = new Map(cues.map((c) => [c.label, c]));

  // 可变状态：初始为演出当前有效结果，前序成功项实时改写（同一内存快照内串行判定）
  const latestByCue = latestEventsByCue(perf.id);
  const firedLabels = new Set();
  for (const c of cues) {
    const e = latestByCue.get(c.id);
    if (e && e.action === 'fired') firedLabels.add(c.label);
  }

  const pendingRows = db.prepare(
    "SELECT * FROM cue_review_requests WHERE performance_id = ? AND status = 'pending' ORDER BY id"
  ).all(perf.id);
  const pendingByCue = new Map(pendingRows.map((r) => [r.cue_id, r]));

  // 未解除设备故障的影响范围：成组清单不登记 / 解除故障，影响集合在整组判定中恒定，
  // 预览与提交均以最新故障状态初始化（提交事务内重读，与单项 / 接续串行）。
  // 跳过与撤回不受故障影响，仍按原有规则判定。
  const faultImpactNow = faultImpact(cues, activeFaultRows(perf.id));

  // 前置关系反向索引（撤回时的下游保护）
  const childrenOf = new Map();
  for (const c of cues) {
    for (const dep of c.deps) {
      if (!childrenOf.has(dep)) childrenOf.set(dep, []);
      childrenOf.get(dep).push(c);
    }
  }

  // 预备口令的内存态：随本组前序步骤实时推进（与 latestByCue/firedLabels 同理）。
  // activePrepByCue: cue_id -> {id,status,snapshot:Map<label,eventId>}（仅 pending/ready）；
  // firedEventIdByLabel: label -> 当前有效 fired 事件 id（内存态）。
  const activePrepByCue = new Map();
  for (const k of activePrepRows(perf.id)) {
    let snap = {};
    try { snap = JSON.parse(k.dep_event_snapshot || '{}'); } catch { snap = {}; }
    activePrepByCue.set(k.cue_id, { id: k.id, status: k.status, snapshot: new Map(Object.entries(snap)) });
  }
  const firedEventIdByLabel = new Map();
  for (const c of cues) {
    const e = latestByCue.get(c.id);
    firedEventIdByLabel.set(c.label, e && e.action === 'fired' ? e.id : null);
  }
  // 预览（dryRun）不写库，拟触发用负数虚拟 id，保证与确认时快照可区分、正确判定为流水变化
  let virtualEventId = 0;

  /** 就绪口令在当前内存态下是否仍满足条件（前置流水 id 快照一致 + 无故障影响） */
  function prepReadyInMemory(cue, prep) {
    for (const dep of cue.deps) {
      const curId = firedEventIdByLabel.has(dep) ? firedEventIdByLabel.get(dep) : null;
      const snapId = prep.snapshot.has(dep) ? prep.snapshot.get(dep) : null;
      if (curId == null || curId !== snapId) return false;
    }
    if ((faultImpactNow.blockedByLabel.get(cue.label) || []).length) return false;
    return true;
  }

  /**
   * 内存态就绪失效扫描：本组前序步骤改变流水后，检查其余 ready 口令。
   * dryRun：仅更新内存态（标记为已失效，后续步骤不再把它当就绪）；
   * 提交（非 dryRun）：在同一写事务内把失效口令 UPDATE 为 invalidated 留痕。
   * 返回本次失效的口令（内存结构）清单。
   */
  function memSweepPrep() {
    const invalidated = [];
    for (const cue of cues) {
      const prep = activePrepByCue.get(cue.id);
      if (!prep || prep.status !== 'ready') continue;
      if (prepReadyInMemory(cue, prep)) continue;
      prep.status = 'invalidated';
      prep.reason = 'dep_changed';
      invalidated.push({ cue_id: cue.id, label: cue.label, command_id: prep.id });
      if (!dryRun) {
        db.prepare(`
          UPDATE cue_prep_commands SET status = 'invalidated', invalidated_reason = 'dep_changed',
            invalidated_detail = ?, invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ? AND status = 'ready'
        `).run('成组连续处置中前置有效触发流水发生变化', prep.id);
      }
    }
    return invalidated;
  }

  const insertEvent = db.prepare(
    'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
  );
  const getEvent = (id) => db.prepare('SELECT * FROM cue_events WHERE id = ?').get(id);

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  function recordFailure(item, i, cue, status, message, extra) {
    failureCount += 1;
    results.push({
      index: i + 1,
      seq: cue ? cue.seq : null,
      cue_id: cue ? cue.id : null,
      label: item.label,
      action: item.action,
      ok: false,
      status,
      error: message,
      ...(extra || {}),
    });
  }

  function recordSuccess(item, i, cue, action, reason) {
    let event;
    let eventId;
    if (dryRun) {
      // 预览：以拟操作更新内存状态供后续项判定，不写库
      virtualEventId -= 1;
      eventId = virtualEventId;
      event = {
        id: null, performance_id: perf.id, cue_id: cue.id, action,
        operator, reason, created_at: null, source: 'manual',
      };
    } else {
      const info = insertEvent.run(perf.id, cue.id, action, operator, reason);
      event = getEvent(Number(info.lastInsertRowid));
      eventId = event.id;
    }
    latestByCue.set(cue.id, event);
    if (action === 'fired') firedLabels.add(cue.label);
    if (action === 'retracted') firedLabels.delete(cue.label);

    // 预备口令内存态：触发 / 跳过消耗；撤回不影响该提示自身（触发时已消耗），但会级联影响下游
    const prep = activePrepByCue.get(cue.id);
    if (prep && (prep.status === 'ready' || (prep.status === 'pending' && action === 'skipped'))) {
      if (prep.status === 'ready') {
        prep.status = 'consumed';
        if (!dryRun) {
          db.prepare(
            "UPDATE cue_prep_commands SET status = 'consumed', consumed_event_id = ? WHERE id = ? AND status IN ('pending','ready')"
          ).run(event.id || null, prep.id);
        }
      } else {
        prep.status = 'invalidated';
        prep.reason = 'cue_skipped';
        if (!dryRun) {
          db.prepare(`
            UPDATE cue_prep_commands SET status = 'invalidated', invalidated_reason = 'cue_skipped',
              invalidated_detail = ?, invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ? AND status IN ('pending','ready')
          `).run(`提示「${cue.label}」在成组处置中被跳过`, prep.id);
        }
      }
      activePrepByCue.delete(cue.id);
    }
    // 各提示当前有效 fired 事件 id（供后续步骤的就绪判定）
    for (const c of cues) {
      const e = latestByCue.get(c.id);
      firedEventIdByLabel.set(c.label, e && e.action === 'fired' ? (e.id == null ? null : e.id) : null);
    }
    // dryRun 的拟触发事件无真实 id：以负数虚拟 id 标记，使依赖它的就绪口令快照比对立即判为流水变化
    if (action === 'fired') {
      firedEventIdByLabel.set(cue.label, dryRun ? eventId : event.id);
    }
    // 前序步骤可能撤回 / 重发前置：级联失效其余就绪口令
    const prepInvalidated = memSweepPrep();

    successCount += 1;
    results.push({
      index: i + 1,
      seq: cue.seq,
      cue_id: cue.id,
      label: cue.label,
      action: item.action,
      ok: true,
      operator,
      reason,
      planned: dryRun,
      event: dryRun ? null : event,
      ...(prepInvalidated.length ? { invalidated_prep: prepInvalidated } : {}),
    });
  }

  items.forEach((item, i) => {
    const cue = byLabel.get(item.label);
    if (!cue) {
      recordFailure(item, i, null, 404, `提示编号「${item.label}」不存在于当前演出版本`);
      return;
    }

    const pending = pendingByCue.get(cue.id) || null;
    const latest = latestByCue.get(cue.id) || null;
    const effective = effectiveAction(latest);

    if (item.action === 'fire') {
      // 与单项 fire 相同的状态判定；需双人复核提示禁止成组直接触发（不能绕过申请—确认）
      if (effective) {
        recordFailure(
          item, i, cue, 409,
          `该提示已有结果：${ACTION_TEXT[effective]}（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
          { current: latest }
        );
        return;
      }
      if (pending) {
        recordFailure(
          item, i, cue, 409,
          `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能触发`,
          { request: pending }
        );
        return;
      }
      if (cue.needs_review) {
        recordFailure(item, i, cue, 409, '该提示需双人复核，不能在成组操作中直接触发；请先在执行台发起触发申请，并由另一操作人确认');
        return;
      }
      // 需预备提示：成组触发同样要求当前存在已就绪口令（待确认 / 未发口令 / 已失效均拒绝）
      if (cue.needs_prep) {
        const prep = activePrepByCue.get(cue.id);
        if (!prep || prep.status !== 'ready' || !prepReadyInMemory(cue, prep)) {
          recordFailure(
            item, i, cue, 422,
            !prep
              ? `提示「${cue.label}」需预备确认：尚未发出预备口令，请先发口令并经另一操作人确认就绪`
              : prep.status === 'pending'
                ? `提示「${cue.label}」的预备口令尚待确认（发令人另行确认就绪后方可触发）`
                : `提示「${cue.label}」的预备口令已失效（前置流水变化或受故障影响），请重新预备`,
            { needs_prep: true, prep_status: !prep ? 'none' : prep.status === 'pending' ? 'pending' : 'invalidated' }
          );
          return;
        }
      }
      // 未解除故障阻断触发（故障编号本身及所有依赖它的后续提示）；申请—确认同样受此限
      const faultSources = faultImpactNow.blockedByLabel.get(item.label) || [];
      if (faultSources.length) {
        recordFailure(
          item, i, cue, 422,
          `存在未解除的设备故障，受影响提示不得触发：${faultSources
            .map((f) => `「${f.label}」故障（${f.reason}）`).join('、')}。请先解除故障或改走跳过`,
          { blocked_by_faults: faultSources.map(faultBrief) }
        );
        return;
      }
      const unmet = cue.deps.filter((d) => !firedLabels.has(d));
      if (unmet.length) {
        recordFailure(item, i, cue, 422, `前置提示未触发，无法触发：${unmet.join('、')}`, { unmet });
        return;
      }
      recordSuccess(item, i, cue, 'fired', null);
      return;
    }

    if (item.action === 'skip') {
      if (effective) {
        recordFailure(
          item, i, cue, 409,
          `该提示已有结果：${ACTION_TEXT[effective]}（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
          { current: latest }
        );
        return;
      }
      if (pending) {
        recordFailure(
          item, i, cue, 409,
          `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能跳过`,
          { request: pending }
        );
        return;
      }
      if (!item.reason) {
        recordFailure(item, i, cue, 400, '跳过必须填写原因');
        return;
      }
      recordSuccess(item, i, cue, 'skipped', item.reason);
      return;
    }

    // retract：与单项撤回一致（待复核拒绝 / 已跳过或未触发拒绝 / 缺原因 / 下游仍已触发整体拒绝）
    if (pending) {
      recordFailure(
        item, i, cue, 409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能撤回`,
        { request: pending }
      );
      return;
    }
    if (effective === 'skipped') {
      recordFailure(
        item, i, cue, 409,
        `该提示当前结果为已跳过，不能撤回（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
        { current: latest }
      );
      return;
    }
    if (effective !== 'fired') {
      recordFailure(item, i, cue, 409, '该提示当前未处于已触发状态，不能撤回', { current: latest });
      return;
    }
    if (!item.reason) {
      recordFailure(item, i, cue, 400, '撤回必须填写原因');
      return;
    }
    // 反向 BFS：前序步骤刚撤回的下游已从 firedLabels 移除，判定随之级联
    const affected = [];
    const visited = new Set([cue.label]);
    const queue = [cue.label];
    while (queue.length) {
      const curLabel = queue.shift();
      for (const child of childrenOf.get(curLabel) || []) {
        if (visited.has(child.label)) continue;
        visited.add(child.label);
        queue.push(child.label);
        if (firedLabels.has(child.label)) affected.push(child.label);
      }
    }
    if (affected.length) {
      recordFailure(
        item, i, cue, 409,
        `无法撤回：以下后续提示仍处于已触发状态，请先撤回：${affected.join('、')}`,
        { affected }
      );
      return;
    }
    recordSuccess(item, i, cue, 'retracted', item.reason);
  });

  return {
    results,
    success_count: successCount,
    failure_count: failureCount,
    can_submit: failureCount === 0,
  };
}

/** 取演出并拒绝只读（已接续）演出：成组预览与提交均不允许在只读演出上进行 */
function getActivePerformance(performanceId) {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (!perf) throw new HttpError(404, '演出不存在');
  assertActiveInTx(perf);
  return perf;
}

route('POST', '/api/performances/:id/batch/preview', (body, p) => {
  // 先做演出状态判定：已接续只读 / 已封场演出统一 409（优先于清单结构校验）
  const perf = getActivePerformance(Number(p.id));
  const { operator, items } = parseGroupBody(body);
  // Node 单线程同步读：快照内逐项判定，不会穿插其他写操作；不修改任何数据
  const plan = evaluateBatch(perf, operator, items, true);
  const version = db.prepare('SELECT id, version_number FROM versions WHERE id = ?').get(perf.version_id);
  return {
    performance: { id: perf.id, name: perf.name },
    version,
    operator,
    ...plan,
  };
});

route('POST', '/api/performances/:id/batch', (body, p) => {
  const { operator, items } = parseGroupBody(body);
  const perfId = Number(p.id);
  return withTx(() => {
    // 提交瞬间在 BEGIN IMMEDIATE 内重读最新状态并重新逐项判定：
    // 与单项操作、接续串行，排队期间的任何现场变化都会纳入判定，不信任此前预览结果
    const fresh = db.prepare('SELECT * FROM performances WHERE id = ?').get(perfId);
    if (!fresh) throw new HttpError(404, '演出不存在');
    assertActiveInTx(fresh);

    const plan = evaluateBatch(fresh, operator, items, false);
    if (plan.failure_count > 0) {
      // 任一项失败：事务回滚，整组不产生任何流水（含此前各项的拟写入）。
      // 清洗成功项上的拟写入事件（其 id 随回滚失效），统一标记为未生效，避免误以为已落库。
      const rolledBackResults = plan.results.map((r) => r.ok
        ? { ...r, event: null, rolled_back: true }
        : r);
      const overallStatus = rolledBackResults.some((r) => !r.ok && r.status === 422)
        ? 422
        : rolledBackResults.some((r) => !r.ok && r.status === 400)
          ? 400
          : 409;
      const first = rolledBackResults.find((r) => !r.ok);
      throw new HttpError(
        overallStatus,
        `成组操作未执行：第 ${first.index} 项（编号 ${first.label}）${first.error}。整组均未生效、无流水产生，请调整后重新提交`,
        {
          results: rolledBackResults,
          success_count: 0,
          failure_count: plan.failure_count,
        }
      );
    }
    return {
      performance: { id: fresh.id, name: fresh.name },
      submitted: true,
      success_count: plan.success_count,
      failure_count: 0,
      results: plan.results,
      // 提交事务内按最新数据库状态再扫一遍就绪口令（与单项 / 故障 / 接续串行的最终防线）
      invalidated_prep: sweepPrepReadiness(fresh.id, fresh.version_id),
    };
  });
});

/* ---- 演出封场结项（封场前核对 + 一次性固定不可变报告；与全部现场写操作同一 BEGIN IMMEDIATE 串行判定） ---- */

/** 该演出的封场记录（含解析后的报告），未封场返回 null */
function closingRowFor(performanceId) {
  const row = db.prepare('SELECT * FROM performance_closings WHERE performance_id = ?').get(performanceId);
  if (!row) return null;
  let report = null;
  try { report = JSON.parse(row.report); } catch { report = null; }
  return {
    id: row.id,
    performance_id: row.performance_id,
    closed_by: row.closed_by,
    note: row.note,
    closed_at: row.closed_at,
    report,
  };
}

/**
 * 沿接续链追溯一条（可能为承接的）流水至其原流水（manual）：
 * 承接结果沿 carried_from_performance_id / carried_from_event_id 逐级回溯，
 * 返回 { origin, hops }，origin 为最初现场触发/跳过的 manual 流水所在演出与记录；
 * hops 为从本场到原流水的完整承接链（含本场当前事件）。
 */
function traceEventOrigin(event, versionNumberByPerfId) {
  const hops = [];
  let curPerfId = event.performance_id;
  let curEvent = event;
  const seen = new Set();
  for (let guard = 0; guard < 1000; guard += 1) {
    hops.push({
      performance_id: curPerfId,
      version_number: versionNumberByPerfId.get(curPerfId) || null,
      event_id: curEvent.id,
      action: curEvent.action,
      source: curEvent.source,
      operator: curEvent.operator,
      created_at: curEvent.created_at,
    });
    const key = `${curPerfId}:${curEvent.id}`;
    if (seen.has(key)) break;
    seen.add(key);
    if (curEvent.source !== 'carried' || !curEvent.carried_from_event_id) break;
    const nextPerfId = curEvent.carried_from_performance_id;
    const nextEvent = nextPerfId
      ? db.prepare('SELECT * FROM cue_events WHERE id = ? AND performance_id = ?')
        .get(curEvent.carried_from_event_id, nextPerfId)
      : null;
    if (!nextEvent) break;
    curPerfId = nextPerfId;
    curEvent = nextEvent;
  }
  const origin = hops[hops.length - 1];
  return {
    origin: {
      performance_id: origin.performance_id,
      version_number: origin.version_number,
      event_id: origin.event_id,
      operator: origin.operator,
      created_at: origin.created_at,
    },
    hops,
  };
}

/**
 * 封场前核对（须在 BEGIN IMMEDIATE 事务内调用，纯读不改数据）：
 * 按当前演出版本逐条核对提示——每条都须有有效「已触发 / 已跳过」结果（承接结果同样有效，
 * 其来源沿接续链追溯）；并确认无待复核申请、未解除故障、待签收交接单。
 * 返回 { can_close, blockers: { pending_cues, review_requests, active_faults, pending_handovers }, counts }。
 */
function evaluateClosing(perf) {
  const cues = getVersionCues(perf.version_id);
  const latestByCue = latestEventsByCue(perf.id);

  // 未完成提示（无有效结果）：复用交接快照的阻塞原因分类
  // （blocked 前置未触发 / review_pending 待复核 / own_fault 本提示故障 /
  //  fault_blocked 受故障影响触发冻结 / pending 待执行）
  const snapshot = buildHandoverSnapshot(perf);
  const pendingByLabel = new Map(snapshot.pending_cues.map((pc) => [pc.label, pc]));
  const pending_cues = cues
    .filter((c) => {
      const e = latestByCue.get(c.id);
      return !(e && e.action !== 'retracted');
    })
    .map((c) => {
      const pc = pendingByLabel.get(c.label);
      return {
        cue_id: c.id,
        label: c.label,
        seq: c.seq,
        reason_codes: pc ? pc.reason_codes : ['pending'],
        reason_text: pc ? pc.reason_text : PENDING_REASON_TEXT.pending,
      };
    })
    .sort((a, b) => a.seq - b.seq || a.label.localeCompare(b.label));

  // 待复核申请（pending）：确认 / 撤销 / 驳回后方可封场
  const reviewRequests = db.prepare(`
    SELECT r.id, r.requested_by, r.requested_at, c.label AS label, c.seq AS seq
    FROM cue_review_requests r JOIN cues c ON c.id = r.cue_id
    WHERE r.performance_id = ? AND r.status = 'pending'
    ORDER BY r.id
  `).all(perf.id);

  // 未解除故障（含影响范围）：全部解除后方可封场
  const impact = faultImpact(cues, activeFaultRows(perf.id));
  const active_faults = impact.faults
    .map((f) => ({
      fault_id: f.id,
      cue_id: f.cue_id,
      label: f.label,
      reported_by: f.reported_by,
      reason: f.reason,
      reported_at: f.reported_at,
      affected_labels: f.affected_labels,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // 待签收交接单：签收或由交班人重提后再签收 / 等待作废处理后方可封场
  const pendingHandover = pendingHandoverRow(perf.id);
  const pending_handovers = pendingHandover ? [{
    handover_id: pendingHandover.id,
    handed_by: pendingHandover.handed_by,
    received_by: pendingHandover.received_by,
    created_at: pendingHandover.created_at,
  }] : [];

  const blockers = { pending_cues, review_requests: reviewRequests, active_faults, pending_handovers };
  const counts = {
    pending_cues: pending_cues.length,
    review_requests: reviewRequests.length,
    active_faults: active_faults.length,
    pending_handovers: pending_handovers.length,
  };
  return { can_close: counts.pending_cues + counts.review_requests + counts.active_faults + counts.pending_handovers === 0, blockers, counts };
}

/** 构造封场阻项错误（422：封场前条件未满足；演出保持可操作、不产生报告） */
function closingBlockedError(check) {
  const { blockers, counts } = check;
  const parts = [];
  if (counts.pending_cues) parts.push(`${counts.pending_cues} 条提示尚无有效结果（${blockers.pending_cues.map((c) => c.label).join('、')}）`);
  if (counts.review_requests) parts.push(`${counts.review_requests} 个待复核申请未处置（${blockers.review_requests.map((r) => r.label).join('、')}）`);
  if (counts.active_faults) parts.push(`${counts.active_faults} 个未解除故障（${blockers.active_faults.map((f) => f.label).join('、')}）`);
  if (counts.pending_handovers) parts.push(`${counts.pending_handovers} 张待签收交接单`);
  return new HttpError(
    422,
    `封场核对未通过，演出保持可操作、未生成封场报告：${parts.join('；')}。请处理完全部阻项后再封场`,
    { can_close: false, blockers, counts }
  );
}

/**
 * 构造不可变结项报告（须在 BEGIN IMMEDIATE 内、核对通过后调用）：
 * 一次性固定结项时间、结项人、每条提示的最终有效结果及原操作人、时间、流水与来源演出；
 * 承接（carried）结果沿接续链追溯到原流水（origin / hops），原操作人/时间沿用，不算本场再次触发；
 * 同时固定全部复核申请、故障登记/解除、交接单与流水统计，供永久回看。
 */
function buildClosingReport(perf, closedBy, note, closedAt) {
  const cues = getVersionCues(perf.version_id);
  const show = db.prepare('SELECT id, name FROM shows WHERE id = ?').get(perf.show_id);
  const version = db.prepare('SELECT id, version_number, note AS version_note FROM versions WHERE id = ?').get(perf.version_id);

  // 接续链上各演出的版本号（追溯承接结果时展示来源版本）
  const chain = continuationChain(perf.id);
  const versionNumberByPerfId = new Map(chain.map((p) => [
    p.id,
    db.prepare('SELECT version_number FROM versions WHERE id = ?').get(p.version_id)?.version_number || null,
  ]));
  const chain_performance_ids = chain.map((p) => p.id);

  // 本场全部流水（最新在上）；承接流水带出来源演出/来源事件
  const events = db.prepare(`
    SELECT e.*, c.label AS label, c.seq AS seq FROM cue_events e
    JOIN cues c ON c.id = e.cue_id
    WHERE e.performance_id = ? ORDER BY e.id DESC
  `).all(perf.id);
  const latestByCue = latestEventsByCue(perf.id);

  let manualCount = 0;
  let carriedCount = 0;
  let firedCount = 0;
  let skippedCount = 0;
  for (const e of events) {
    if (e.source === 'carried') carriedCount += 1; else manualCount += 1;
  }

  const final_results = cues.map((c) => {
    const e = latestByCue.get(c.id) || null;
    const effective = e && e.action !== 'retracted' ? e.action : null;
    if (effective === 'fired') firedCount += 1;
    if (effective === 'skipped') skippedCount += 1;
    const traced = e ? traceEventOrigin(e, versionNumberByPerfId) : null;
    return {
      cue_id: c.id,
      label: c.label,
      seq: c.seq,
      type: c.type,
      description: c.description,
      deps: c.deps,
      needs_review: !!c.needs_review,
      needs_prep: !!c.needs_prep,
      final_status: effective, // fired / skipped / null（封场核对保证非 null）
      event_id: e ? e.id : null,
      operator: e ? e.operator : null,
      created_at: e ? e.created_at : null,
      reason: e && e.reason ? e.reason : null,
      source: e ? e.source : null, // manual / carried
      carried_from_performance_id: e && e.source === 'carried' ? (e.carried_from_performance_id || null) : null,
      carried_from_event_id: e && e.source === 'carried' ? (e.carried_from_event_id || null) : null,
      origin: traced ? traced.origin : null,
      origin_hops: traced ? traced.hops : null,
    };
  });

  const review_requests = db.prepare(`
    SELECT r.*, c.label AS label, c.seq AS seq FROM cue_review_requests r
    JOIN cues c ON c.id = r.cue_id
    WHERE r.performance_id = ? ORDER BY r.id
  `).all(perf.id).map((r) => ({
    id: r.id, label: r.label, status: r.status,
    requested_by: r.requested_by, requested_at: r.requested_at,
    resolved_by: r.resolved_by || null, resolved_at: r.resolved_at || null,
    resolve_reason: r.resolve_reason || null, event_id: r.event_id || null,
  }));

  const allFaults = allFaultRows(perf.id);
  const activeAtClose = faultImpact(cues, activeFaultRows(perf.id)).faults;
  const faults = allFaults.map((f) => {
    const active = activeAtClose.find((af) => af.id === f.id);
    return {
      id: f.id, label: f.label, status: f.status,
      reported_by: f.reported_by, reason: f.reason, reported_at: f.reported_at,
      resolved_by: f.resolved_by || null, resolved_at: f.resolved_at || null,
      resolve_reason: f.resolve_reason || null,
      affected_labels: active ? active.affected_labels : [],
    };
  }).sort((a, b) => b.id - a.id);

  const handovers = db.prepare('SELECT * FROM cue_handovers WHERE performance_id = ? ORDER BY id').all(perf.id)
    .map((h) => ({
      id: h.id, status: h.status, handed_by: h.handed_by, received_by: h.received_by,
      note: h.note, created_at: h.created_at, signed_at: h.signed_at || null,
      superseded_at: h.superseded_at || null, superseded_by_handover_id: h.superseded_by_handover_id || null,
    }));

  // 预备口令全量历史（发出 / 确认 / 消耗 / 重发作废 / 失效及原因），封场时固定可回看
  const prep_commands = allPrepRows(perf.id).map((k) => ({
    id: k.id, label: k.label, seq: k.seq, status: k.status,
    status_text: PREP_STATUS_TEXT[k.status] || k.status,
    issued_by: k.issued_by, issued_at: k.issued_at,
    confirmed_by: k.confirmed_by || null, confirmed_at: k.confirmed_at || null,
    invalidated_reason: k.invalidated_reason || null,
    invalidated_reason_text: k.invalidated_reason ? (PREP_INVALID_REASON_TEXT[k.invalidated_reason] || k.invalidated_reason) : null,
    invalidated_detail: k.invalidated_detail || null, invalidated_at: k.invalidated_at || null,
    consumed_event_id: k.consumed_event_id || null,
  })).sort((a, b) => a.id - b.id);
  const prepCounts = { pending: 0, ready: 0, consumed: 0, superseded: 0, invalidated: 0 };
  for (const k of prep_commands) prepCounts[k.status] = (prepCounts[k.status] || 0) + 1;

  const eventMaxId = events.length ? Math.max(...events.map((e) => e.id)) : null;
  return {
    report_version: 20261003,
    closed_at: closedAt,
    closed_by: closedBy,
    note,
    show: show ? { id: show.id, name: show.name } : null,
    version: version ? { id: version.id, version_number: version.version_number, note: version.version_note } : null,
    performance: {
      id: perf.id,
      name: perf.name,
      started_by: perf.started_by,
      started_at: perf.started_at,
      continuation_from_performance_id: perf.continued_from_performance_id || null,
      continuation_chain_performance_ids: chain_performance_ids,
    },
    cue_total: cues.length,
    fired_count: firedCount,
    skipped_count: skippedCount,
    manual_event_count: manualCount,
    carried_event_count: carriedCount,
    latest_event_id: eventMaxId,
    final_results,
    review_requests,
    faults,
    handovers,
    prep_commands,
    prep_counts: prepCounts,
    events: events.map((e) => ({
      id: e.id, label: e.label, seq: e.seq, action: e.action, operator: e.operator,
      reason: e.reason || null, created_at: e.created_at, source: e.source,
      carried_from_performance_id: e.carried_from_performance_id || null,
      carried_from_event_id: e.carried_from_event_id || null,
    })),
  };
}

/**
 * 执行封场：封场判定与现场写操作在同一 BEGIN IMMEDIATE 事务内串行——
 * 事务内重读演出状态与全部阻项，通过则一次性写入封场记录（固定结项时间/结项人/不可变报告）
 * 并把演出置为 closed 终态；有阻项则整体回滚（演出保持可操作、不产生报告，不会留下部分结项）。
 */
function closePerformance(perfId, closedBy, note) {
  return withTx(() => {
    const fresh = db.prepare('SELECT * FROM performances WHERE id = ?').get(perfId);
    if (!fresh) throw new HttpError(404, '演出不存在');
    if (fresh.status === 'closed') {
      throw new HttpError(
        409,
        '该演出已封场结项，不能重复封场；可回看原记录与不可变封场报告',
        { readonly: true, closed: true, closing: closingRowFor(fresh.id) }
      );
    }
    assertActiveInTx(fresh); // readonly（已接续）演出不能封场

    const check = evaluateClosing(fresh);
    if (!check.can_close) throw closingBlockedError(check);

    const closedAt = new Date().toISOString();
    const report = buildClosingReport(fresh, closedBy, note, closedAt);
    const info = db.prepare(
      'INSERT INTO performance_closings (performance_id, closed_by, note, closed_at, report) VALUES (?,?,?,?,?)'
    ).run(fresh.id, closedBy, note, closedAt, JSON.stringify(report));
    db.prepare("UPDATE performances SET status = 'closed' WHERE id = ?").run(fresh.id);

    return {
      closing: {
        id: Number(info.lastInsertRowid),
        performance_id: fresh.id,
        closed_by: closedBy,
        note,
        closed_at: closedAt,
        report,
      },
      performance: db.prepare('SELECT * FROM performances WHERE id = ?').get(fresh.id),
    };
  });
}

route('POST', '/api/performances/:id/closeout/check', (body, p) => {
  const perfId = Number(p.id);
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(perfId);
  if (!perf) throw new HttpError(404, '演出不存在');
  if (perf.status === 'closed') {
    throw new HttpError(409, '该演出已封场结项；可回看封场报告', { readonly: true, closed: true, closing: closingRowFor(perfId) });
  }
  if (perf.status === 'readonly') {
    throw new HttpError(409, '已接续的只读演出不能封场；请对当前可操作（接续）演出执行封场', { readonly: true, closed: false });
  }
  return withTx(() => {
    const fresh = db.prepare('SELECT * FROM performances WHERE id = ?').get(perfId);
    assertActiveInTx(fresh);
    const check = evaluateClosing(fresh);
    return {
      performance: { id: fresh.id, name: fresh.name, status: fresh.status },
      can_close: check.can_close,
      blockers: check.blockers,
      counts: check.counts,
    };
  });
});

route('POST', '/api/performances/:id/closeout', (body, p) => {
  const perfId = Number(p.id);
  const closedBy = String(body.closed_by || body.operator || '').trim().slice(0, 50);
  if (!closedBy) throw new HttpError(400, '请填写结项人');
  const note = String(body.note || '').trim().slice(0, 500);
  if (!note) throw new HttpError(400, '请填写封场说明');
  return closePerformance(perfId, closedBy, note);
});

route('GET', '/api/performances/:id/closeout', (body, p) => {
  const perf = db.prepare('SELECT id FROM performances WHERE id = ?').get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');
  const closing = closingRowFor(Number(p.id));
  if (!closing) throw new HttpError(404, '该演出尚未封场，暂无封场报告');
  return { closing };
});

/* ---------------- 分发 ---------------- */

async function handle(req, res, url, body) {
  const pathname = url.pathname;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const result = await r.handler(body, params, req);
    return { status: 200, data: result };
  }
  throw new HttpError(404, '接口不存在');
}

module.exports = { handle, HttpError };
