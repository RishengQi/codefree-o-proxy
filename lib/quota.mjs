// 额度解析与额度服务：摘要归一、被动信号提取、主动探测缓存
import { nowIso } from './util.mjs';

/** 解析单个额度窗口（上游结构未公开，做多候选字段兼容） */
export function parseQuotaWindow(w, period) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  const num = (...keys) => {
    for (const k of keys) {
      const v = w[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const win = {
    period,
    usagePercent: num('usagePercent', 'usePercent', 'usedPercent', 'percent'),
    used: num('used', 'usedTokens', 'usedCount', 'usage', 'consumed'),
    limit: num('limit', 'total', 'totalTokens', 'quota', 'tokenLimit'),
    resetAt: num('resetAt', 'resetTime', 'reset_at', 'resetsAt'),
    retryAt: num('retryAt', 'retryTime'),
    level: typeof w.level === 'string' ? w.level : undefined,
    windowId: typeof w.windowId === 'string' ? w.windowId : undefined,
    status: (() => {
      for (const k of ['status', 'Status', 'windowStatus']) {
        const v = w[k];
        if (typeof v === 'string') return v.toUpperCase();
      }
      return undefined;
    })(),
    startedAt: (() => {
      for (const k of ['startedAt', 'startTime', 'started_at']) {
        const v = w[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      }
      return undefined;
    })(),
    thresholdPercent: num('thresholdPercent', 'threshold', 'ThresholdPercent'),
  };
  if (typeof win.remaining !== 'number' && typeof win.limit === 'number' && typeof win.used === 'number') {
    win.remaining = Math.max(0, win.limit - win.used);
  }
  const hasAny = ['usagePercent', 'used', 'limit', 'remaining'].some((k) => typeof win[k] === 'number');
  return hasAny ? win : null;
}

/** 额度查询响应归一化 */
export function summarizeQuota(raw) {
  const out = { raw: raw ?? null, fetchedAt: Date.now() };
  try {
    const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
    const root = rec(raw) || {};
    const data = rec(root.data) || root;

    out.quotaStatus = typeof data.quotaStatus === 'string' ? data.quotaStatus : undefined;
    out.statusReason = typeof data.statusReason === 'string' ? data.statusReason : undefined;
    out.vip = typeof data.vip === 'boolean' ? data.vip : undefined;
    out.canUpgrade = typeof data.canUpgrade === 'boolean' ? data.canUpgrade : undefined;
    out.gradingPending = typeof data.gradingPending === 'boolean' ? data.gradingPending : undefined;
    if (rec(data.level) && typeof data.level.level === 'string') {
      out.level = data.level.level;
      out.levelName = data.level.displayName;
    } else if (typeof data.level === 'string') {
      out.level = data.level;
    }
    if (rec(data.quotaWorkTime)) out.quotaWorkTime = data.quotaWorkTime;
    if (typeof data.nextUpgradeAt === 'number') out.nextUpgradeAt = data.nextUpgradeAt;

    out.windows = {};
    const five = parseQuotaWindow(data.fiveHour, '5H');
    const seven = parseQuotaWindow(data.sevenDay, '7D');
    if (five) out.windows['5H'] = five;
    if (seven) out.windows['7D'] = seven;

    const pickNum = (...keys) => {
      for (const k of keys) {
        const v = data[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      }
      return undefined;
    };
    out.limit = pickNum('limit', 'total', 'quota', 'tokenLimit');
    out.used = pickNum('used', 'usedTokens', 'usage', 'consumed');
    out.remaining =
      typeof out.limit === 'number' && typeof out.used === 'number'
        ? Math.max(0, out.limit - out.used)
        : pickNum('remaining', 'left');
    out.resetAt = pickNum('resetAt', 'resetTime', 'reset_at');

    out.enforced =
      out.quotaStatus === 'ACTIVE' &&
      (out.statusReason === undefined || out.statusReason === null) &&
      out.vip !== true;
    out.bypassed =
      out.quotaStatus === 'BYPASSED' ||
      (out.quotaStatus === 'DISABLED' && out.statusReason === 'CONTROL_DISABLED');
    out.exhausted = Object.values(out.windows).some(
      (w) => w.status === 'EXHAUSTED' || (typeof w.usagePercent === 'number' && w.usagePercent >= 100),
    );
    if (data.nextLevel !== undefined) out.nextLevel = data.nextLevel;
  } catch {}
  return out;
}

/** 从聊天 SSE 帧 / 429 body 提取额度信号 */export function extractQuotaSignal(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const rec = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const root = rec(obj) || {};
  const payload = rec(root.data) || root;

  if (root.code === 'AI_QUOTA_EXHAUSTED' || payload.code === 'AI_QUOTA_EXHAUSTED') {
    const src = payload.code === 'AI_QUOTA_EXHAUSTED' ? payload : root;
    const periods = [
      ...(src.period === '5H' || src.period === '7D' ? [src.period] : []),
      ...(Array.isArray(src.periods) ? src.periods.filter((p) => p === '5H' || p === '7D') : []),
    ];
    const mask = typeof src.exhaustedMask === 'number' ? src.exhaustedMask : undefined;
    if (periods.length === 0 && mask !== undefined) {
      if (mask & 1) periods.push('5H');
      if (mask & 2) periods.push('7D');
    }
    const details = Array.isArray(src.periodDetails) ? src.periodDetails : [];
    const numFrom = (obj, keys) => {
      for (const k of keys) {
        const v = obj?.[k];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
      }
      return undefined;
    };
    const detailResets = details
      .map((d) => ({
        period: String(d?.period || d?.Period || '').toUpperCase(),
        resetAt: numFrom(d, ['resetAt', 'ResetAt', 'reset_at', 'resetTime']),
        retryAt: numFrom(d, ['retryAt', 'RetryAt', 'retryTime']),
      }))
      .filter((d) => d.resetAt || d.retryAt);
    const resetCandidates = [src.resetAt, ...detailResets.map((d) => d.resetAt)].filter(
      (n) => typeof n === 'number' && Number.isFinite(n) && n > 0,
    );
    const retryCandidates = [src.retryAt, ...detailResets.map((d) => d.retryAt)].filter(
      (n) => typeof n === 'number' && Number.isFinite(n) && n > 0,
    );
    return {
      kind: 'exhausted',
      periods: [...new Set(periods)],
      exhaustedMask: mask,
      periodDetails: details.length ? details : src.periodDetails,
      used: src.used,
      limit: src.limit,
      resetAt: resetCandidates.length ? Math.max(...resetCandidates) : src.resetAt,
      retryAt: retryCandidates.length ? Math.max(...retryCandidates) : src.retryAt,
      canUpgrade: src.canUpgrade,
      level: src.level,
    };
  }

  const codefree = rec(payload.codefree);
  const notifications = Array.isArray(codefree?.notifications) ? codefree.notifications : null;
  if (notifications) {
    const wanted = notifications
      .filter((n) => rec(n)?.type === 'QUOTA_WARNING' && (n.period === '5H' || n.period === '7D'))
      .map((n) => ({
        period: n.period,
        usagePercent: typeof n.usagePercent === 'number' ? n.usagePercent : undefined,
        resetAt: n.resetAt,
        eventId: n.eventId,
        used: n.used,
        limit: n.limit,
        thresholdPercent: n.thresholdPercent,
        canUpgrade: n.canUpgrade,
        windowId: n.windowId,
      }));
    if (wanted.length === 0) return null;
    return { kind: 'warning', notifications: wanted, canUpgrade: codefree.canUpgrade, quotaWorkTime: codefree.quotaWorkTime };
  }
  return null;
}

/** SSE 增量解析器：喂 chunk，回调每帧 data JSON */
export class SseFrameScanner {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = '';
    this.decoder = new TextDecoder();
  }

  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const m = this.buffer.match(/\r?\n\r?\n/);
      if (!m) break;
      const idx = m.index;
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + m[0].length);
      this.#handleFrame(frame);
    }
  }

  end() {
    this.buffer += this.decoder.decode();
    if (this.buffer.trim()) this.#handleFrame(this.buffer);
    this.buffer = '';
  }

  #handleFrame(frame) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    try {
      this.onFrame(parsed);
    } catch {}
  }
}

const PERIODS = ['5H', '7D'];

/**
 * 额度服务：每个账号维护 QuotaSnapshot。
 * snapshot = { windows: { '5H': {...}, '7D': {...} }, quotaStatus, bypassed, fetchedAt, source, confidence }
 */
export class QuotaService {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.snapshots = new Map(); // accountId -> snapshot
    this.probeState = new Map(); // accountId -> { nextAt, backoff, hourly }
    /** 额度管控状态告警去重：accountId -> {status, at} */
    this.controlWarnedAt = new Map();
  }

  get(accountId) {
    return this.snapshots.get(accountId) || null;
  }

  all() {
    return Object.fromEntries([...this.snapshots.entries()]);
  }

  /** 主动探测写入（来自上游 quota/v1/me） */
  recordProbe(accountId, summary) {
    const prev = this.snapshots.get(accountId) || { windows: {} };
    const windows = { ...prev.windows };
    for (const p of PERIODS) {
      if (summary.windows?.[p]) windows[p] = { ...summary.windows[p], at: Date.now() };
    }
    const snap = {
      ...prev,
      windows,
      quotaStatus: summary.quotaStatus,
      statusReason: summary.statusReason,
      enforced: summary.enforced,
      bypassed: summary.bypassed,
      exhausted: summary.exhausted,
      vip: summary.vip,
      canUpgrade: summary.canUpgrade,
      gradingPending: summary.gradingPending,
      ...(summary.quotaWorkTime ? { quotaWorkTime: summary.quotaWorkTime } : {}),
      ...(summary.nextLevel !== undefined ? { nextLevel: summary.nextLevel } : {}),
      ...(summary.nextUpgradeAt !== undefined ? { nextUpgradeAt: summary.nextUpgradeAt } : {}),
      level: summary.level,
      fetchedAt: Date.now(),
      source: 'probe',
      confidence: 1.0,
    };
    this.snapshots.set(accountId, snap);
    // 管控状态异常（可能是限流/封禁/降级的前兆）记录一次告警，6 小时去重
    const controlStatus =
      summary.statusReason === 'CONTROL_DISABLED'
        ? 'CONTROL_DISABLED'
        : summary.quotaStatus === 'DISABLED' || summary.quotaStatus === 'DEGRADED'
          ? summary.quotaStatus
          : '';
    if (controlStatus) {
      const prev = this.controlWarnedAt.get(accountId);
      if (!prev || prev.status !== controlStatus || Date.now() - prev.at > 6 * 3600_000) {
        this.controlWarnedAt.set(accountId, { status: controlStatus, at: Date.now() });
        this.logger?.warn('额度管控状态异常，可能受限流/控制策略影响', {
          account: accountId,
          quotaStatus: summary.quotaStatus,
          statusReason: summary.statusReason,
        });
      }
    }
    return snap;
  }

  /** 被动信号写入（SSE / 429） */
  recordPassive(accountId, signal) {
    if (!signal) return null;
    const prev = this.snapshots.get(accountId) || { windows: {} };
    const windows = { ...prev.windows };
    let source = 'passive-warning';
    if (signal.kind === 'warning') {
      for (const n of signal.notifications || []) {
        windows[n.period] = {
          ...windows[n.period],
          period: n.period,
          usagePercent: n.usagePercent ?? windows[n.period]?.usagePercent,
          used: n.used ?? windows[n.period]?.used,
          limit: n.limit ?? windows[n.period]?.limit,
          resetAt: n.resetAt ?? windows[n.period]?.resetAt,
          at: Date.now(),
        };
      }
    } else if (signal.kind === 'exhausted') {
      source = 'passive-exhausted';
      for (const p of signal.periods || []) {
        windows[p] = {
          ...windows[p],
          period: p,
          status: 'EXHAUSTED',
          usagePercent: 100,
          used: signal.used ?? windows[p]?.used,
          limit: signal.limit ?? windows[p]?.limit,
          resetAt: signal.resetAt ?? windows[p]?.resetAt,
          retryAt: signal.retryAt,
          at: Date.now(),
        };
      }
    }
    const snap = {
      ...prev,
      windows,
      ...(signal.quotaWorkTime ? { quotaWorkTime: signal.quotaWorkTime } : {}),
      ...(typeof signal.canUpgrade === 'boolean' ? { canUpgrade: signal.canUpgrade } : {}),
      exhausted: PERIODS.some(
        (p) => windows[p]?.status === 'EXHAUSTED' || (windows[p]?.usagePercent ?? 0) >= 100,
      ),
      fetchedAt: Date.now(),
      source,
      confidence: 0.8,
    };
    this.snapshots.set(accountId, snap);
    return snap;
  }

  /**
   * 账号剩余额度比例（0..1）。
   * - BYPASSED / 无窗口数据 -> assumeUnknownHeadroom
   * - 取所有已知窗口中最紧的余量
   */
  headroom(accountId) {
    const snap = this.snapshots.get(accountId);
    const assume = this.config.quota.assumeUnknownHeadroom;
    if (!snap || !snap.windows) return assume;
    // 额度未生效（BYPASSED/DISABLED/非工作时段/VIP 等）时不构成额度压力
    if (snap.enforced === false) return 1;
    if (snap.bypassed) return 1;
    const known = PERIODS.map((p) => snap.windows[p]).filter((w) => w && w.status !== 'NOT_STARTED');
    if (known.length === 0) return assume;
    let min = 1;
    for (const w of known) {
      if (typeof w.usagePercent === 'number') min = Math.min(min, 1 - w.usagePercent / 100);
      else if (typeof w.remaining === 'number' && typeof w.limit === 'number' && w.limit > 0) {
        min = Math.min(min, w.remaining / w.limit);
      } else if (typeof w.used === 'number' && typeof w.limit === 'number' && w.limit > 0) {
        min = Math.min(min, 1 - w.used / w.limit);
      }
    }
    return Math.max(0, Math.min(1, min));
  }

  /** 最近恢复时间（用于冷却：额度耗尽后最早 resetAt） */
  nextResetAt(accountId) {
    const snap = this.snapshots.get(accountId);
    if (!snap?.windows) return 0;
    const times = PERIODS.map((p) => snap.windows[p]?.resetAt).filter((v) => typeof v === 'number');
    return times.length ? Math.min(...times) : 0;
  }

  /** 额度耗尽后的恢复时间：取"已耗尽窗口"中最晚的 resetAt/retryAt；无耗尽则取最晚 resetAt */
  exhaustedRecoveryAt(accountId) {
    const snap = this.snapshots.get(accountId);
    if (!snap?.windows) return 0;
    const times = [];
    for (const period of PERIODS) {
      const w = snap.windows[period];
      if (!w) continue;
      const exhausted = w.status === 'EXHAUSTED' || (typeof w.usagePercent === 'number' && w.usagePercent >= 100);
      for (const t of [w.resetAt, w.retryAt]) {
        if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
          if (exhausted) times.push(t);
        }
      }
    }
    if (times.length) return Math.max(...times);
    const fallback = PERIODS.map((p) => snap.windows[p]?.resetAt).filter((v) => typeof v === 'number' && v > 0);
    return fallback.length ? Math.max(...fallback) : 0;
  }

  /** 是否可探测（限速 + 每小时预算） */
  canProbe(accountId, now = Date.now()) {
    const st = this.probeState.get(accountId) || { nextAt: 0, hourly: [] };
    if (now < st.nextAt) return false;
    st.hourly = st.hourly.filter((t) => now - t < 3600_000);
    if (st.hourly.length >= this.config.quota.probe.hourlyBudget) return false;
    return true;
  }

  markProbed(accountId, { ok, now = Date.now() } = {}) {
    const st = this.probeState.get(accountId) || { nextAt: 0, hourly: [], backoff: 0 };
    st.hourly.push(now);
    const { hotMs, warmMs, coldMs, jitterRatio, backoffMaxMs } = this.config.quota.probe;
    if (ok) {
      st.backoff = 0;
      st.nextAt = now + jitter(hotMs, jitterRatio);
    } else {
      st.backoff = Math.min(backoffMaxMs, Math.max(warmMs, st.backoff * 2 || warmMs));
      st.nextAt = now + jitter(st.backoff, jitterRatio);
    }
    this.probeState.set(accountId, st);
  }
}

/**
 * 判断当前时间是否处于额度工作时段（quotaWorkTime={timeZone,startTime,endTime}）
 * @returns {{known:boolean, active:boolean}} known=false 表示字段缺失/无法解析
 */
export function quotaWorkTimeActive(workTime, now = Date.now()) {
  if (!workTime || typeof workTime !== 'object') return { known: false, active: true };
  const toMinutes = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 24 || mi > 59) return null;
    return h * 60 + mi;
  };
  const start = toMinutes(workTime.startTime ?? workTime.start);
  const end = toMinutes(workTime.endTime ?? workTime.end);
  if (start === null || end === null) return { known: false, active: true };
  let hhmm = null;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: workTime.timeZone || 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(now));
    const hh = Number(parts.find((p) => p.type === 'hour')?.value);
    const mm = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isFinite(hh) && Number.isFinite(mm)) hhmm = hh * 60 + mm;
  } catch {
    return { known: false, active: true };
  }
  if (hhmm === null) return { known: false, active: true };
  const active = start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
  return { known: true, active };
}

export function jitter(ms, ratio = 0.2, rand = Math.random) {
  const delta = ms * ratio * (rand() * 2 - 1);
  return Math.max(0, Math.round(ms + delta));
}
