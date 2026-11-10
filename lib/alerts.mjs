// 池级告警：全池额度耗尽 / 全池鉴权失效 / 恢复通知，支持企微等 text webhook。
// 触发在维护定时器与请求失败路径上，带冷却时间避免刷屏。

export class AlertManager {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.cfg = config.alert || {};
    this.lastSentAt = new Map(); // event -> ts
    this.refreshWarnedAt = new Map(); // accountId -> ts
    this.activeEvent = null;
  }

  get enabled() {
    return Boolean(this.cfg.enabled && this.cfg.webhookUrl);
  }

  #cooldownMs() {
    return Number(this.cfg.cooldownMs || 600000);
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
        await this.#send(
          `【CodeFree-O 代理】账号登录即将过期\n账号：${account.id}(user ${account.userId || '?'})\n剩余：${hoursLeft} 小时\n请重新登录 CodeFree-O 客户端并更新代理凭据`,
          `refresh_expiring_${account.id}`,
        );
      }
    }
    return notified;
  }

  /** 评估池状态；返回本次产生的事件（便于测试） */
  async evaluate(pool, quota, { reason = 'periodic' } = {}) {
    const accounts = pool.list().filter((a) => a.enabled && !a.credentialMissing);
    if (accounts.length === 0) return null;
    const now = Date.now();
    const authExpiredAll = accounts.every((a) => a.health === 'auth-expired');
    const quotaExhaustedAll =
      !authExpiredAll &&
      accounts.every((a) => a.cooldownReason === 'quota_exhausted' || quota.get(a.id)?.exhausted === true);

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
        return `${a.id}(user ${a.userId || '?'}) health=${a.health} cooldown=${a.cooldownReason || '-'} quota=${snap?.quotaStatus || '-'} windows=${periods}`;
      })
      .join('\n');
    const title = event === 'all_auth_expired' ? '全池登录失效' : '全池额度耗尽';
    const text = `【CodeFree-O 代理】${title}\n触发：${reason}\n账号状态：\n${detail}\n时间：${new Date(now).toISOString()}\n处理：请登录/换号或等待额度恢复`;
    await this.#send(text, event);
    return { type: event, suppressed: false };
  }

  async #send(text, event) {
    this.logger?.warn('触发池告警', { event, text });
    if (!this.enabled) return;
    try {
      const res = await fetch(this.cfg.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) this.logger?.warn('告警 webhook 返回非 2xx', { status: res.status });
    } catch (e) {
      this.logger?.warn('告警 webhook 发送失败', { error: e.message });
    }
  }
}
