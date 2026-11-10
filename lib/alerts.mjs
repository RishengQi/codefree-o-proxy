// 告警：池级（全池登录失效/额度耗尽/恢复）+ 账号级（登录失效、额度预警/耗尽、账号被管控、
// 上游异常、恢复）。通过企业微信群机器人 webhook 推送，按事件去重与冷却，避免刷屏。
import { WeComWebhook } from './wecom.mjs';

const PERIODS = ['5H', '7D'];

function secondsLeft(until, now) {
  return Math.max(0, Math.round((Number(until || 0) - now) / 1000));
}

function formatTs(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function controlStatusOf(snap) {
  if (!snap) return '';
  if (snap.statusReason === 'CONTROL_DISABLED') return 'CONTROL_DISABLED';
  if (snap.quotaStatus === 'DEGRADED') return 'DEGRADED';
  return '';
}

export class AlertManager {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.cfg = config.alert || {};
    this.webhook = new WeComWebhook({
      url: this.cfg.webhookUrl,
      msgType: this.cfg.msgType,
      mentionedList: this.cfg.mentionedList,
      mentionedMobileList: this.cfg.mentionedMobileList,
      timeoutMs: this.cfg.webhookTimeoutMs,
      logger,
    });
    this.lastSentAt = new Map(); // event key -> ts
    this.refreshWarnedAt = new Map(); // accountId -> ts
    this.accountState = new Map(); // accountId -> { auth, control, quota, error }
    this.activeEvent = null; // 当前池级异常
    this.running = null;
    this.pending = null;
  }

  get enabled() {
    return Boolean(this.cfg.enabled && this.webhook.enabled);
  }

  #cooldownMs() {
    return Number(this.cfg.cooldownMs || 600000);
  }

  #accountCooldownMs() {
    return Number(this.cfg.accountCooldownMs || 6 * 3600_000);
  }

  #quotaWarnPercent() {
    const n = Number(this.cfg.quotaWarnPercent);
    return Number.isFinite(n) && n > 0 ? n : 80;
  }

  /** 同一 key 在冷却期内只发一次；返回是否应发送。 */
  #claim(key, cooldownMs) {
    const now = Date.now();
    const last = this.lastSentAt.get(key) || 0;
    if (now - last < cooldownMs) return false;
    this.lastSentAt.set(key, now);
    return true;
  }

  /**
   * 检查 refresh token 即将过期的账号（默认 48h 内），记录告警并（可选）发 webhook。
   * @returns {string[]} 本次触发告警的账号 id
   */
  async maybeWarnRefreshExpiry(accounts, now = Date.now()) {
    const warnHours = Number(this.cfg.refreshExpiryWarnHours ?? 48);
    if (!(warnHours > 0)) return [];
    const warnMs = warnHours * 3600_000;
    const notified = [];
    for (const account of accounts || []) {
      if (!account?.enabled || !account.refreshTokenExpiresAt) continue;
      const leftMs = account.refreshTokenExpiresAt - now;
      if (leftMs <= 0 || leftMs > warnMs) continue;
      const last = this.refreshWarnedAt.get(account.id) || 0;
      if (now - last < 12 * 3600_000) continue;
      this.refreshWarnedAt.set(account.id, now);
      notified.push(account.id);
      const hoursLeft = +(leftMs / 3600_000).toFixed(1);
      this.logger?.warn('refresh token 即将过期，请重新登录 CodeFree-O 客户端', {
        account: account.id,
        userId: account.userId || null,
        expiresAt: new Date(account.refreshTokenExpiresAt).toISOString(),
        hoursLeft,
      });
      if (this.enabled) {
        const res = await this.#send(
          `【CodeFree-O 代理】账号登录即将过期\n账号：${account.id}（user ${account.userId || '?'}）\n剩余：${hoursLeft} 小时\n请重新登录 CodeFree-O 客户端并更新代理凭据`,
          `refresh_expiring_${account.id}`,
        );
        // 发送失败时允许下一轮重试，而不是等 12h
        if (!res.ok) this.refreshWarnedAt.delete(account.id);
      }
    }
    return notified;
  }

  /**
   * 评估池与账号状态。可被定时器、失败路径、额度探测多处调用；
   * 内部串行化并合并短时间内的重复触发，避免并发发送重复告警。
   */
  async evaluate(pool, quota, { reason = 'periodic' } = {}) {
    this.pending = { pool, quota, reason };
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        while (this.pending) {
          const job = this.pending;
          this.pending = null;
          await this.#evaluate(job.pool, job.quota, { reason: job.reason });
        }
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async #evaluate(pool, quota, { reason }) {
    const sent = [];
    // 池级事件优先发送，保持既有告警语义
    const poolEvent = await this.#evaluatePool(pool, quota, { reason });
    if (poolEvent) sent.push(poolEvent);

    const now = Date.now();
    for (const account of pool.list()) {
      const events = await this.#evaluateAccount(account, quota.get(account.id), now);
      sent.push(...events);
    }
    return sent.length ? { events: sent } : null;
  }

  async #evaluatePool(pool, quota, { reason }) {
    const accounts = pool.list().filter((a) => a.enabled && !a.credentialMissing);
    if (accounts.length === 0) return null;
    const now = Date.now();
    const authExpiredAll = accounts.every((a) => a.health === 'auth-expired');
    const quotaExhaustedAll =
      !authExpiredAll &&
      accounts.every(
        (a) =>
          (a.cooldownReason === 'quota_exhausted' && Number(a.cooldownUntil) > now) ||
          quota.get(a.id)?.exhausted === true,
      );

    const event = authExpiredAll ? 'all_auth_expired' : quotaExhaustedAll ? 'all_quota_exhausted' : null;

    if (!event) {
      if (this.activeEvent) {
        const prev = this.activeEvent;
        this.activeEvent = null;
        const text = `【CodeFree-O 代理】已恢复\n事件：${prev}\n原因：至少一个账号恢复可用\n时间：${new Date(now).toISOString()}`;
        await this.#send(text, `recovered_${prev}`);
        return { type: 'recovered', previous: prev };
      }
      return null;
    }

    this.activeEvent = event;
    const last = this.lastSentAt.get(event) || 0;
    if (now - last < this.#cooldownMs()) return { type: event, suppressed: true };
    this.lastSentAt.set(event, now);

    const detail = accounts
      .map((a) => {
        const snap = quota.get(a.id);
        const periods = snap?.windows ? Object.keys(snap.windows).join('/') : '-';
        return `${a.id}（user ${a.userId || '?'}）health=${a.health} cooldown=${a.cooldownReason || '-'} quota=${snap?.quotaStatus || '-'} windows=${periods}`;
      })
      .join('\n');
    const title = event === 'all_auth_expired' ? '全池登录失效' : '全池额度耗尽';
    const text = `【CodeFree-O 代理】${title}\n触发：${reason}\n账号状态：\n${detail}\n时间：${new Date(now).toISOString()}\n处理：请登录/换号或等待额度恢复`;
    await this.#send(text, event);
    return { type: event, suppressed: false };
  }

  async #evaluateAccount(account, snap, now) {
    const out = [];
    // 手动禁用的账号不告警；凭据缺失的账号即使被禁用也要告警
    if (!account.enabled && !account.credentialMissing) return out;

    const st = this.accountState.get(account.id) || { auth: 'ok', control: '', quota: {}, error: '' };

    // ---- 登录失效 / 凭据缺失 ----
    const authKey = `auth_expired:${account.id}`;
    const authBad = account.health === 'auth-expired' || account.credentialMissing;
    if (authBad) {
      const transition = st.auth !== 'bad';
      if (transition || this.#claim(authKey, this.#accountCooldownMs())) {
        if (transition) this.lastSentAt.set(authKey, now);
        await this.#send(this.#formatAuthExpired(account, now), authKey);
        out.push({ type: 'account_auth_expired', account: account.id });
      }
      st.auth = 'bad';
    } else {
      if (st.auth === 'bad') {
        await this.#send(this.#formatRecovered(account, '账号登录已恢复', 'auth-expired', now), `auth_recovered_${account.id}`);
        out.push({ type: 'account_auth_recovered', account: account.id });
      }
      st.auth = 'ok';
    }

    // ---- 服务端管控状态 ----
    const control = controlStatusOf(snap);
    if (control) {
      const key = `control:${account.id}:${control}`;
      const transition = st.control !== control;
      if (transition || this.#claim(key, this.#accountCooldownMs())) {
        if (transition) this.lastSentAt.set(key, now);
        await this.#send(this.#formatControl(account, snap, control, now), key);
        out.push({ type: 'account_control_disabled', account: account.id, control });
      }
      st.control = control;
    } else {
      if (st.control) {
        await this.#send(this.#formatRecovered(account, '账号管控状态已恢复', st.control, now), `control_recovered_${account.id}`);
        out.push({ type: 'account_control_recovered', account: account.id });
      }
      st.control = '';
    }

    // ---- 额度窗口预警 / 耗尽 ----
    // 对齐 CodeFree-O 桌面端：只有 ACTIVE + statusReason=null + !vip 才参与额度判定；
    // 被动快照可能没有 enforced/quotaStatus 字段，此时视为“未知”，不告警。
    const enforced =
      Boolean(snap) &&
      snap.vip !== true &&
      !snap.bypassed &&
      (snap.enforced === true ||
        (snap.quotaStatus === 'ACTIVE' &&
          (snap.statusReason === undefined || snap.statusReason === null)));
    st.quota = st.quota || {};
    for (const period of PERIODS) {
      const w = snap?.windows?.[period];
      const prev = st.quota[period] || { level: 'ok', resetAt: 0 };
      const usable = enforced && w && w.status !== 'NOT_STARTED';
      let level = 'ok';
      let threshold = null;
      let usage = null;
      if (usable) {
        usage = Number(w.usagePercent);
        const rawThreshold = Number(w.thresholdPercent);
        threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : this.#quotaWarnPercent();
        if (w.status === 'EXHAUSTED' || (Number.isFinite(usage) && usage >= 100)) level = 'exhausted';
        else if (Number.isFinite(usage) && usage >= threshold) level = 'warning';
      }
      const resetChanged =
        Number(prev.resetAt) > 0 && Number(w?.resetAt) > 0 && Number(prev.resetAt) !== Number(w.resetAt);
      const prevLevel = resetChanged ? 'ok' : prev.level;
      if (level === 'exhausted') {
        const key = `quota_exhausted:${account.id}:${period}:${w?.resetAt || w?.windowId || ''}`;
        const transition = prevLevel !== 'exhausted';
        if (transition || this.#claim(key, this.#accountCooldownMs())) {
          if (transition) this.lastSentAt.set(key, now);
          await this.#send(this.#formatQuota(account, period, w, 'exhausted', snap, threshold, now), key);
          out.push({ type: 'account_quota_exhausted', account: account.id, period });
        }
      } else if (level === 'warning') {
        const key = `quota_warning:${account.id}:${period}:${w?.resetAt || w?.windowId || ''}`;
        const transition = prevLevel !== 'warning' && prevLevel !== 'exhausted';
        if (transition || this.#claim(key, this.#accountCooldownMs())) {
          if (transition) this.lastSentAt.set(key, now);
          await this.#send(this.#formatQuota(account, period, w, 'warning', snap, threshold, now), key);
          out.push({ type: 'account_quota_warning', account: account.id, period });
        }
      } else if (level === 'ok' && prevLevel !== 'ok') {
        // 窗口缺失/探测失败不等于恢复；只有窗口数据存在时才发恢复通知
        if (w) {
          const key = `quota_recovered:${account.id}:${period}:${w?.resetAt || ''}`;
          this.lastSentAt.set(key, now);
          await this.#send(this.#formatQuotaRecovered(account, period, prevLevel, snap, now), key);
          out.push({ type: 'account_quota_recovered', account: account.id, period });
        }
      }
      st.quota[period] = { level, resetAt: Number(w?.resetAt) || 0 };
    }

    // ---- 上游 5xx / 网络 / 未知失败（限流与额度已由上面的路径覆盖） ----
    const cooldownReason = String(account.cooldownReason || '');
    const transient =
      /^(upstream_|network$|unknown_failure$|rate_limited$)/.test(cooldownReason) &&
      Number(account.cooldownUntil) > now;
    if (transient) {
      const key = `upstream_error:${account.id}:${cooldownReason}`;
      if (this.#claim(key, this.#accountCooldownMs())) {
        await this.#send(this.#formatUpstreamError(account, now), key);
        out.push({ type: 'account_upstream_error', account: account.id, reason: cooldownReason });
      }
      st.error = cooldownReason;
    } else {
      st.error = '';
    }

    this.accountState.set(account.id, st);
    return out;
  }

  #accountLine(account) {
    return `${account.id}${account.userId ? `（user ${account.userId}）` : ''}`;
  }

  #timeLine(now) {
    return `时间：${new Date(now).toISOString()}`;
  }

  #formatAuthExpired(account, now) {
    return [
      '【CodeFree-O 代理】账号登录失效',
      `账号：${this.#accountLine(account)}`,
      `健康：${account.health}${account.credentialMissing ? '（缺少 refresh token）' : ''}`,
      account.cooldownReason
        ? `冷却：${account.cooldownReason}（剩余 ${secondsLeft(account.cooldownUntil, now)}s）`
        : null,
      account.stats?.lastError ? `原因：${String(account.stats.lastError).slice(0, 200)}` : null,
      this.#timeLine(now),
      '处理：请重新登录 CodeFree-O 客户端并更新代理凭据',
    ]
      .filter(Boolean)
      .join('\n');
  }

  #formatControl(account, snap, control, now) {
    return [
      '【CodeFree-O 代理】账号被管控',
      `账号：${this.#accountLine(account)}`,
      `管控类型：${control}`,
      `额度状态：${snap?.quotaStatus || '-'}${snap?.statusReason ? `（${snap.statusReason}）` : ''}`,
      snap?.level ? `等级：${snap.level}` : null,
      this.#timeLine(now),
      '处理：该账号可能被服务端限流/控制，请检查账号状态或更换账号',
    ]
      .filter(Boolean)
      .join('\n');
  }

  #formatQuota(account, period, w, level, snap, threshold, now) {
    const usage = Number(w?.usagePercent);
    const usageText = Number.isFinite(usage) ? `${Math.round(usage)}%` : '未知';
    const usedText = w?.used != null && w?.limit != null ? `用量：${w.used}/${w.limit}` : null;
    const resetText = formatTs(w?.resetAt);
    return [
      `【CodeFree-O 代理】${level === 'exhausted' ? '账号额度耗尽' : '账号额度预警'}`,
      `账号：${this.#accountLine(account)}`,
      `窗口：${period} 已用 ${usageText}${level === 'warning' && threshold ? `（阈值 ${threshold}%）` : ''}`,
      usedText,
      resetText ? `重置：${resetText}` : null,
      `额度状态：${snap?.quotaStatus || '-'}${snap?.statusReason ? `（${snap.statusReason}）` : ''}`,
      this.#timeLine(now),
      `处理：${level === 'exhausted' ? '该账号已进入冷却，代理会自动切换其他账号' : '额度即将耗尽，代理会优先使用其他账号'}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  #formatQuotaRecovered(account, period, prevLevel, snap, now) {
    const w = snap?.windows?.[period];
    const usage = Number(w?.usagePercent);
    return [
      '【CodeFree-O 代理】账号额度恢复',
      `账号：${this.#accountLine(account)}`,
      `窗口：${period}`,
      `原状态：${prevLevel}`,
      Number.isFinite(usage) ? `当前用量：${Math.round(usage)}%` : null,
      formatTs(w?.resetAt) ? `重置：${formatTs(w?.resetAt)}` : null,
      this.#timeLine(now),
    ]
      .filter(Boolean)
      .join('\n');
  }

  #formatRecovered(account, title, previous, now) {
    return [
      `【CodeFree-O 代理】${title}`,
      `账号：${this.#accountLine(account)}`,
      `原状态：${previous}`,
      `当前健康：${account.health}`,
      this.#timeLine(now),
    ].join('\n');
  }

  #formatUpstreamError(account, now) {
    return [
      '【CodeFree-O 代理】账号上游异常',
      `账号：${this.#accountLine(account)}`,
      `类型：${account.cooldownReason || 'unknown'}`,
      `冷却剩余：${secondsLeft(account.cooldownUntil, now)}s`,
      account.stats?.lastError ? `最近错误：${String(account.stats.lastError).slice(0, 200)}` : null,
      this.#timeLine(now),
      '处理：代理已自动切换账号；若持续出现请检查上游/网络',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async #send(text, event) {
    this.logger?.warn('触发告警', { event, text });
    if (!this.enabled) return { ok: false, skipped: true };
    const res = await this.webhook.send(text);
    // 发送失败时清掉去重时间戳，下一次评估会重试，避免一次网络抖动丢失 6h 告警
    if (!res.ok && event) this.lastSentAt.delete(event);
    return res;
  }
}
