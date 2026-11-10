// 账号池核心：Account / TokenRefresher / AccountPool / SessionAffinity / AccountSelector / ConsumerLimiter
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolveRefreshTokenRef, readAuthFile, writeAuthFileAtomic } from './credentials.mjs';
import { summarizeQuota } from './quota.mjs';
import {
  AuthExpiredError,
  ConsumerRateLimitError,
  ModelNotFoundError,
  QuotaExhaustedError,
  UpstreamError,
  nowIso,
  redact,
  sha256,
  shortHash,
  sleep,
} from './util.mjs';
import { UnauthorizedError } from './upstream.mjs';

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------
let ACTIVE_SEQUENCE = 0;

export class Account {
  constructor(spec, cfg, logger) {
    this.id = spec.id;
    this.label = spec.label || spec.id;
    this.email = spec.email || '';
    this.baseUrl = (spec.baseUrl || cfg.upstream.baseUrl).replace(/\/+$/, '');
    this.userId = spec.userId || '';
    this.clientId = spec.clientId || cfg.upstream.clientId;
    this.writeBack = spec.writeBack || 'isolated';
    this.authFile = spec.authFile || '';
    this.stateFile = path.join(cfg.stateDir, 'accounts', `${safeId(spec.id)}.json`);
    this.maxConcurrent = Math.max(1, Number(spec.maxConcurrent ?? 3));
    this.priority = Number(spec.priority ?? 0);
    this.preferred = Boolean(spec.preferred);
    this.tags = spec.tags || [];
    this.enabledByConfig = spec.enabled !== false;
    this.enabled = this.enabledByConfig;
    this.logger = logger;

    this.refreshToken = spec.refreshToken || '';
    this.refreshTokenExpiresAt = Number(spec.refreshTokenExpiresAt || 0);
    this.accessToken = '';
    this.accessTokenExpiresAt = 0;
    this.revision = 0;

    this.health = 'ready'; // ready | cooling | auth-expired | disabled
    this.cooldownUntil = 0;
    this.cooldownReason = '';
    this.credentialMissing = false;
    this.deniedModels = new Map(); // model -> until ts
    this.leases = 0;
    this.refreshing = null;

    this.stats = {
      requests: 0,
      successes: 0,
      failures: 0,
      tokensIn: 0,
      tokensOut: 0,
      lastLatencyMs: null,
      lastUsedAt: 0,
      lastError: null,
      lastRefreshAt: 0,
      lastProbeAt: 0,
      lastAuthRetryAt: 0,
    };
    this.createdAt = nowIso();
    this.order = ++ACTIVE_SEQUENCE;
  }

  get available() {
    const now = Date.now();
    return (
      this.enabled &&
      !this.credentialMissing &&
      this.health !== 'auth-expired' &&
      this.cooldownUntil <= now &&
      this.leases < this.maxConcurrent
    );
  }

  modelDenied(model, now = Date.now()) {
    if (!model) return false;
    const until = this.deniedModels.get(model);
    if (!until) return false;
    if (until <= now) {
      this.deniedModels.delete(model);
      return false;
    }
    return true;
  }

  snapshot({ redact: doRedact = true } = {}) {
    const now = Date.now();
    return {
      id: this.id,
      label: this.label,
      email: this.email,
      baseUrl: this.baseUrl,
      userId: this.userId,
      clientId: this.clientId,
      enabled: this.enabled,
      health: this.health,
      cooldownUntil: this.cooldownUntil || 0,
      cooldownReason: this.cooldownReason || '',
      cooldownMsLeft: Math.max(0, this.cooldownUntil - now),
      credentialMissing: this.credentialMissing,
      writeBack: this.writeBack,
      authFile: this.authFile || null,
      maxConcurrent: this.maxConcurrent,
      activeLeases: this.leases,
      priority: this.priority,
      preferred: this.preferred,
      tags: this.tags,
      accessToken: doRedact ? redact(this.accessToken) : this.accessToken,
      accessTokenExpiresInSec: this.accessTokenExpiresAt ? Math.max(0, Math.round((this.accessTokenExpiresAt - now) / 1000)) : 0,
      refreshTokenExpiresAt: this.refreshTokenExpiresAt || null,
      stats: { ...this.stats },
    };
  }
}

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '_');
}

// ---------------------------------------------------------------------------
// Token 刷新（单账号互斥 + 轮换写回 + journal）
// ---------------------------------------------------------------------------
export class TokenRefresher {
  constructor({ config, logger, upstream, journal }) {
    this.config = config;
    this.logger = logger;
    this.upstream = upstream;
    this.journal = journal;
  }

  async ensureFresh(account, { force = false } = {}) {
    // 强制刷新时先对账凭据文件：用户重新登录后 authFile 可能已有新 token
    if (force) this.#reconcileFromSources(account, { force: true });
    const recoveredFromMissing = Boolean(account.credentialMissing && account.refreshToken);
    if (account.credentialMissing && !account.refreshToken) {
      throw new AuthExpiredError(`账号 ${account.id} 缺少 refresh token，无法刷新`, 'credential_missing');
    }
    // 非强制刷新时 auth-expired 直接拒绝；强制刷新允许尝试恢复（管理员刷新/自动恢复）
    if (account.health === 'auth-expired' && !force) {
      throw new AuthExpiredError(`账号 ${account.id} 登录已过期，请重新登录后更新凭据`, account.stats.lastError || '');
    }
    const skew = this.config.refresh.skewMs;
    if (!force && account.accessToken && account.accessTokenExpiresAt - Date.now() > skew) {
      return account.accessToken;
    }
    if (account.refreshing) return account.refreshing;
    account.refreshing = (async () => {
      const token = await this.#refresh(account, { force });
      // 只有刷新成功后才把凭据缺失账号恢复为可用，避免刷新失败时变成“无 token 但可选”
      if (recoveredFromMissing) {
        account.credentialMissing = false;
        if (account.enabledByConfig) account.enabled = true;
        this.logger?.info('已从凭据文件恢复账号', { account: account.id, userId: account.userId || null });
      }
      return token;
    })().finally(() => {
      account.refreshing = null;
    });
    return account.refreshing;
  }

  async #refresh(account, { force }) {
    // 1) 先对账凭据文件：桌面端可能已轮换 refresh token
    this.#reconcileFromSources(account);

    if (!account.refreshToken) {
      account.credentialMissing = true;
      account.health = 'disabled';
      throw new AuthExpiredError(`账号 ${account.id} 缺少 refresh token`, 'credential_missing');
    }
    if (account.refreshTokenExpiresAt && Date.now() > account.refreshTokenExpiresAt) {
      this.#markAuthExpired(account, 'refresh token 已过期');
      throw new AuthExpiredError(
        `CodeFree 登录已过期（refresh token 于 ${nowIso(account.refreshTokenExpiresAt)} 过期），请重新登录 CodeFree-O 客户端后重试`,
      );
    }

    const backoffs = this.config.refresh.backoffMs;
    const maxRetries = Math.max(1, this.config.refresh.maxRetries);
    let lastErr;
    this.journal.append({ action: 'refresh_start', accountId: account.id, oldHash: shortHash(account.refreshToken) });
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const tokens = await this.upstream.refreshToken(account);
        account.accessToken = tokens.accessToken;
        account.accessTokenExpiresAt = tokens.accessTokenExpiresAt;
        account.refreshToken = tokens.refreshToken;
        account.refreshTokenExpiresAt = tokens.refreshTokenExpiresAt;
        if (tokens.userId) account.userId = tokens.userId;
        account.revision++;
        account.health = 'ready';
        account.cooldownUntil = 0;
        account.cooldownReason = '';
        account.stats.lastRefreshAt = Date.now();
        account.stats.lastError = null;
        this.journal.append({
          action: 'refresh_ok',
          accountId: account.id,
          newHash: shortHash(account.refreshToken),
          refreshTokenExpiresAt: account.refreshTokenExpiresAt,
        });
        this.#persist(account);
        this.logger?.info('CodeFree token 已刷新', {
          account: account.id,
          userId: account.userId,
          expiresInSec: Math.round((account.accessTokenExpiresAt - Date.now()) / 1000),
          refreshExpiresAt: nowIso(account.refreshTokenExpiresAt),
        });
        return account.accessToken;
      } catch (e) {
        lastErr = e;
        if (e instanceof AuthExpiredError) {
          this.journal.append({ action: 'refresh_rejected', accountId: account.id, error: String(e.message).slice(0, 200) });
          this.#markAuthExpired(account, e.message);
          throw e;
        }
        if (attempt < maxRetries - 1) {
          const wait = backoffs[Math.min(attempt, backoffs.length - 1)] || 500;
          this.logger?.warn('刷新 token 失败，稍后重试', { account: account.id, attempt: attempt + 1, error: e.message, waitMs: wait });
          await sleep(wait);
          continue;
        }
        this.journal.append({ action: 'refresh_failed', accountId: account.id, error: String(e.message).slice(0, 200) });
        account.stats.lastError = String(e.message);
        throw e;
      }
    }
    throw lastErr;
  }

  /** 用最新可用的凭据源覆盖账号上的 refresh token（桌面端轮换同步） */
  #reconcileFromSources(account, { force = false } = {}) {
    const sources = [];
    if (account.authFile) sources.push(account.authFile);
    sources.push(account.stateFile);
    let best = null;
    for (const file of sources) {
      const cred = readAuthFile(file, this.logger);
      if (!cred) continue;
      if (!best || (cred.refreshTokenExpiresAt || 0) > (best.refreshTokenExpiresAt || 0)) best = cred;
    }
    if (best && best.refreshToken && best.refreshToken !== account.refreshToken) {
      // 普通刷新仅在对方更新（expiresAt 更大）或本地为空时采用，避免吞掉自己刚写入的轮换结果；
      // 强制恢复时以凭据文件为准，允许采用重新登录后的 token（即使 expiry 相同/缺失）。
      const newer = (best.refreshTokenExpiresAt || 0) > (account.refreshTokenExpiresAt || 0);
      if (!account.refreshToken || newer || force) {
        this.logger?.info('检测到外部轮换的 refresh token，采用文件中的新值', {
          account: account.id,
          file: best.file,
          refreshExpiresAt: nowIso(best.refreshTokenExpiresAt),
        });
        this.journal.append({ action: 'adopt_external', accountId: account.id, source: best.file, newHash: shortHash(best.refreshToken) });
        account.refreshToken = best.refreshToken;
        // 强制恢复且文件未带 expiry 时置 0（未知），避免沿用旧 token 的过期时间导致直接拒绝
        account.refreshTokenExpiresAt = best.refreshTokenExpiresAt || (force ? 0 : account.refreshTokenExpiresAt);
        if (best.userId) account.userId = best.userId;
        if (best.clientId) account.clientId = best.clientId;
      }
    }
  }

  #persist(account) {
    const cred = {
      refreshToken: account.refreshToken,
      refreshTokenExpiresAt: account.refreshTokenExpiresAt,
      userId: account.userId,
      baseUrlSnapshot: account.baseUrl !== this.config.upstream.baseUrl ? account.baseUrl : '',
    };
    try {
      if (account.authFile && (account.writeBack === 'mirror' || account.writeBack === 'takeover')) {
        writeAuthFileAtomic(account.authFile, cred, { logger: this.logger });
      } else {
        writeAuthFileAtomic(account.stateFile, cred, { logger: this.logger, backup: false });
      }
      // 无论写回哪里，都保留一份自有状态副本，便于重启恢复
      if (account.writeBack === 'mirror' || account.writeBack === 'takeover') {
        writeAuthFileAtomic(account.stateFile, cred, { logger: this.logger, backup: false });
      }
    } catch (e) {
      this.logger?.warn('写回凭据失败', { account: account.id, error: e.message });
    }
  }

  #markAuthExpired(account, reason) {
    account.health = 'auth-expired';
    account.stats.lastError = String(reason || 'auth expired');
    this.logger?.warn('账号登录失效', { account: account.id, reason: account.stats.lastError });
  }
}

// ---------------------------------------------------------------------------
// 账号池
// ---------------------------------------------------------------------------
export class AccountPool {
  constructor({ config, logger, upstream, journal, quota, alerts }) {
    this.config = config;
    this.logger = logger;
    this.upstream = upstream;
    this.journal = journal;
    this.quota = quota;
    this.alerts = alerts;
    this.accounts = [];
    this.byId = new Map();
    /** model id -> accessMode（LEGACY 为不受额度限制的通道） */
    this.modelAccess = new Map();
    this.refresher = new TokenRefresher({ config, logger, upstream, journal });
    this.probeTimer = null;
    this.probeInflight = new Set();
    this.lastGlobalProbeAt = 0;
  }

  /** 记住模型元数据（accessMode 等），用于 LEGACY 免额度判定 */
  rememberModels(models) {
    if (!Array.isArray(models)) return;
    for (const m of models) {
      const id = m?.id;
      if (!id) continue;
      const accessMode = m?.meta?.accessMode ?? m?.accessMode ?? '';
      if (accessMode) this.modelAccess.set(String(id), String(accessMode).toUpperCase());
      else if (!this.modelAccess.has(String(id))) this.modelAccess.set(String(id), '');
    }
  }

  /** 该模型是否走 LEGACY 免额度通道（官方 UI 视为无限额度） */
  isQuotaExemptModel(model) {
    if (!model) return false;
    return this.modelAccess.get(String(model)) === 'LEGACY';
  }

  async load(specs) {
    this.accounts = [];
    this.byId.clear();
    for (const spec of specs) {
      const account = new Account(spec, this.config, this.logger);
      // refresh token 引用（env/file）
      if (!account.refreshToken && spec.refreshTokenRef) {
        account.refreshToken = resolveRefreshTokenRef(spec.refreshTokenRef, { cwd: this.config.__cwd });
      }
      // 从文件恢复
      const sources = [account.authFile, account.stateFile].filter(Boolean);
      let best = null;
      for (const file of sources) {
        const cred = readAuthFile(file, this.logger);
        if (!cred) continue;
        if (!best || (cred.refreshTokenExpiresAt || 0) > (best.refreshTokenExpiresAt || 0)) best = cred;
      }
      if (best) {
        if (!account.refreshToken) account.refreshToken = best.refreshToken;
        account.refreshTokenExpiresAt = Math.max(account.refreshTokenExpiresAt || 0, best.refreshTokenExpiresAt || 0);
        if (!account.userId && best.userId) account.userId = best.userId;
        if (!account.clientId && best.clientId) account.clientId = best.clientId;
        if (!account.baseUrl && best.baseUrlSnapshot) account.baseUrl = best.baseUrlSnapshot;
      }
      if (!account.refreshToken) {
        account.credentialMissing = true;
        account.enabled = false;
        account.health = 'disabled';
        this.logger?.warn('账号缺少 refresh token，已禁用', { account: account.id, authFile: account.authFile || null });
      }
      // journal 崩溃恢复
      this.#reconcileJournal(account);
      this.accounts.push(account);
      this.byId.set(account.id, account);
    }
    this.logger?.info('账号池已加载', {
      accounts: this.accounts.length,
      enabled: this.accounts.filter((a) => a.enabled).length,
      ids: this.accounts.map((a) => a.id),
    });
    return this.accounts;
  }

  #reconcileJournal(account) {
    const last = this.journal.lastByAccount().get(account.id);
    if (last?.action !== 'refresh_start') return;
    this.logger?.warn('检测到上次刷新可能中断，尝试从凭据文件恢复', { account: account.id, at: last.ts });
    const sources = [account.stateFile, account.authFile].filter(Boolean);
    for (const file of sources) {
      const cred = readAuthFile(file, this.logger);
      if (cred && cred.refreshToken) {
        if (shortHash(cred.refreshToken) !== last.oldHash) {
          account.refreshToken = cred.refreshToken;
          account.refreshTokenExpiresAt = cred.refreshTokenExpiresAt || account.refreshTokenExpiresAt;
          this.journal.append({ action: 'refresh_recovered', accountId: account.id, source: file, hash: shortHash(cred.refreshToken) });
          this.logger?.info('已从凭据文件恢复轮换后的 refresh token', { account: account.id, file });
          return;
        }
      }
    }
    this.journal.append({ action: 'refresh_recovered_unknown', accountId: account.id });
  }

  list() {
    return this.accounts;
  }

  /** 运行时新增账号（/admin/import） */
  async add(spec) {
    if (this.byId.has(spec.id)) throw Object.assign(new Error(`账号已存在：${spec.id}`), { status: 409 });
    const account = new Account(spec, this.config, this.logger);
    if (!account.refreshToken) {
      for (const file of [account.authFile, account.stateFile].filter(Boolean)) {
        const cred = readAuthFile(file, this.logger);
        if (cred?.refreshToken) {
          account.refreshToken = cred.refreshToken;
          account.refreshTokenExpiresAt = cred.refreshTokenExpiresAt || 0;
          if (!account.userId && cred.userId) account.userId = cred.userId;
          break;
        }
      }
    }
    if (!account.refreshToken) throw Object.assign(new Error('账号缺少 refresh token'), { status: 400 });
    this.accounts.push(account);
    this.byId.set(account.id, account);
    this.logger?.info('账号已加入池', { account: account.id, authFile: account.authFile || null });
    return account;
  }

  get(id) {
    return this.byId.get(id);
  }

  async ensureFresh(account, opts) {
    return this.refresher.ensureFresh(account, opts);
  }

  setCooldown(account, ms, reason) {
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + Math.max(0, ms));
    account.cooldownReason = reason || '';
    if (account.health !== 'auth-expired') account.health = 'cooling';
    this.logger?.warn('账号进入冷却', { account: account.id, ms, reason });
  }

  clearCooldown(account) {
    account.cooldownUntil = 0;
    account.cooldownReason = '';
    if (account.health === 'cooling') account.health = 'ready';
  }

  markSuccess(account, { latencyMs, tokensIn, tokensOut } = {}) {
    account.health = account.health === 'auth-expired' ? account.health : 'ready';
    this.clearCooldown(account);
    account.stats.successes++;
    account.stats.lastUsedAt = Date.now();
    if (typeof latencyMs === 'number') account.stats.lastLatencyMs = latencyMs;
    if (typeof tokensIn === 'number') account.stats.tokensIn += tokensIn;
    if (typeof tokensOut === 'number') account.stats.tokensOut += tokensOut;
  }

  denyModel(account, model, ttlMs = 300000) {
    if (!model) return;
    account.deniedModels.set(model, Date.now() + ttlMs);
    this.logger?.warn('账号临时不支持该模型', { account: account.id, model, ttlMs });
  }

  snapshot({ redact: doRedact = true } = {}) {
    return this.accounts.map((a) => a.snapshot({ redact: doRedact }));
  }

  // ---- 用量持久化（重启后不丢统计） ----
  loadStats() {
    const file = path.join(this.config.stateDir, 'usage.json');
    try {
      if (!existsSync(file)) return { consumers: {} };
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      let applied = 0;
      for (const account of this.accounts) {
        const saved = raw.accounts?.[account.id];
        if (!saved?.stats) continue;
        const s = saved.stats;
        for (const key of ['requests', 'successes', 'failures', 'tokensIn', 'tokensOut']) {
          if (Number.isFinite(Number(s[key]))) account.stats[key] = Number(s[key]);
        }
        if (Number.isFinite(Number(s.lastLatencyMs))) account.stats.lastLatencyMs = Number(s.lastLatencyMs);
        if (Number.isFinite(Number(s.lastUsedAt))) account.stats.lastUsedAt = Number(s.lastUsedAt);
        if (Number.isFinite(Number(s.lastRefreshAt))) account.stats.lastRefreshAt = Number(s.lastRefreshAt);
        applied++;
      }
      this.logger?.info('已恢复历史用量统计', { file, accounts: applied, savedAt: raw.savedAt || null });
      return { consumers: raw.consumers || {} };
    } catch (e) {
      this.logger?.warn('读取历史用量统计失败（忽略）', { file, error: e.message });
      return { consumers: {} };
    }
  }

  saveStats({ consumers = {} } = {}) {
    const file = path.join(this.config.stateDir, 'usage.json');
    const data = {
      savedAt: new Date().toISOString(),
      accounts: Object.fromEntries(
        this.accounts.map((a) => [a.id, { userId: a.userId, label: a.label, stats: { ...a.stats } }]),
      ),
      consumers,
    };
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
      return true;
    } catch (e) {
      this.logger?.warn('保存用量统计失败', { file, error: e.message });
      return false;
    }
  }

  // ---- 额度探测 ----
  startQuotaProbeLoop() {
    if (!this.config.quota.enabled || !this.config.quota.probe.enabled || this.probeTimer) return;
    const tickMs = 15000;
    this.probeTimer = setInterval(() => this.#probeTick().catch(() => {}), tickMs);
    this.probeTimer.unref?.();
    this.#probeTick().catch(() => {});
  }

  stopQuotaProbeLoop() {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  async #probeTick() {
    const now = Date.now();
    const { maxConcurrentProbes, globalRatePerSec } = this.config.quota.probe;
    const minGap = Math.ceil(1000 / Math.max(0.1, globalRatePerSec));
    if (now - this.lastGlobalProbeAt < minGap) return;
    const candidates = this.accounts
      .filter((a) => a.enabled && !a.credentialMissing && a.health !== 'auth-expired')
      .filter((a) => !this.probeInflight.has(a.id))
      .filter((a) => this.quota.canProbe(a.id, now))
      .sort((a, b) => (this.quota.get(a.id)?.fetchedAt || 0) - (this.quota.get(b.id)?.fetchedAt || 0));
    for (const account of candidates.slice(0, maxConcurrentProbes)) {
      this.probeInflight.add(account.id);
      this.lastGlobalProbeAt = now;
      this.probeQuota(account).catch(() => {}).finally(() => this.probeInflight.delete(account.id));
    }
  }

  async probeQuota(account) {
    try {
      await this.ensureFresh(account);
      const raw = await this.upstream.quota(account);
      const summary = summarizeQuota(raw);
      this.quota.recordProbe(account.id, summary);
      this.quota.markProbed(account.id, { ok: true });
      account.stats.lastProbeAt = Date.now();
      this.logger?.debug('额度探测成功', {
        account: account.id,
        quotaStatus: summary.quotaStatus,
        windows: Object.keys(summary.windows || {}),
      });
      return summary;
    } catch (e) {
      this.quota.markProbed(account.id, { ok: false });
      if (e instanceof AuthExpiredError) {
        account.health = 'auth-expired';
        account.stats.lastError = e.message;
      }
      this.logger?.debug('额度探测失败', { account: account.id, error: e.message });
      throw e;
    } finally {
      // 探测结果写入后立即评估告警（额度预警/耗尽/管控状态），不阻塞探测流程
      this.alerts?.evaluate(this, this.quota, { reason: 'quota_probe' }).catch(() => {});
    }
  }

  /**
   * 自动恢复 auth-expired / 凭据缺失账号：用户重新登录后 authFile 可能已有新 token。
   * 按 refresh.authRecoveryMs 节流，避免对上游反复发起无效刷新。
   */
  async recoverAuthExpired() {
    const interval = Number(this.config.refresh.authRecoveryMs ?? 600000);
    if (!(interval > 0)) return;
    const now = Date.now();
    for (const account of this.accounts) {
      if (!account.enabled && !account.credentialMissing) continue;
      if (account.health !== 'auth-expired' && !account.credentialMissing) continue;
      if (account.refreshing) continue;
      if (now - (account.stats.lastAuthRetryAt || 0) < interval) continue;
      account.stats.lastAuthRetryAt = now;
      try {
        await this.ensureFresh(account, { force: true });
        this.logger?.info('账号登录状态已恢复', { account: account.id, userId: account.userId || null });
        this.alerts?.evaluate(this, this.quota, { reason: 'auth_recovered' }).catch(() => {});
      } catch (e) {
        this.logger?.debug('账号登录恢复尝试失败', {
          account: account.id,
          error: String(e?.message || e).slice(0, 200),
        });
      }
    }
  }

  /** 启动预热：并行为已启用账号刷新 token（失败仅记录，不阻塞启动） */
  async warmup({ timeoutMs = 20000 } = {}) {
    const targets = this.accounts.filter((a) => a.enabled && !a.credentialMissing);
    if (targets.length === 0) return;
    const tasks = targets.map((a) =>
      this.ensureFresh(a).catch((e) => this.logger?.warn('账号预热失败', { account: a.id, error: e.message })),
    );
    await Promise.race([Promise.allSettled(tasks), sleep(timeoutMs)]);
  }
}

// ---------------------------------------------------------------------------
// 会话粘性
// ---------------------------------------------------------------------------
export class SessionAffinity {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.map = new Map();
    /** accountId -> 当前绑定的有效会话数 */
    this.counts = new Map();
    this.lastSweepAt = 0;
  }

  #key(consumerId, sessionKey) {
    const raw = String(sessionKey || '');
    // 超长 session key 哈希后存储，避免客户端用超大 x-session-id/session_id 占用内存
    const safe = raw.length > 256 ? `sha256:${sha256(raw)}` : raw;
    return `${consumerId || 'anonymous'}::${safe}`;
  }

  #decrement(accountId) {
    const left = (this.counts.get(accountId) || 0) - 1;
    if (left > 0) this.counts.set(accountId, left);
    else this.counts.delete(accountId);
  }

  #remove(key) {
    const rec = this.map.get(key);
    if (!rec) return false;
    this.map.delete(key);
    this.#decrement(rec.accountId);
    return true;
  }

  get(consumerId, sessionKey) {
    if (!sessionKey) return null;
    const key = this.#key(consumerId, sessionKey);
    const rec = this.map.get(key);
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) {
      this.#remove(key);
      return null;
    }
    return rec.accountId;
  }

  set(consumerId, sessionKey, accountId, { ttlMs = this.config.selection.stickyTtlMs } = {}) {
    if (!sessionKey) return;
    const key = this.#key(consumerId, sessionKey);
    const prev = this.map.get(key);
    if (prev?.accountId !== accountId) {
      if (prev) this.#decrement(prev.accountId);
      this.counts.set(accountId, (this.counts.get(accountId) || 0) + 1);
    }
    // 删除后重插：Map 插入顺序即最近使用顺序，容量淘汰时从最旧开始
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { accountId, expiresAt: Date.now() + ttlMs });
    const maxSessions = Math.max(0, Number(this.config.selection.maxSessions || 0));
    while (maxSessions > 0 && this.map.size > maxSessions) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.#remove(oldest);
    }
  }

  invalidate(consumerId, sessionKey) {
    this.#remove(this.#key(consumerId, sessionKey));
  }

  invalidateByAccount(accountId) {
    for (const [key, rec] of this.map) if (rec.accountId === accountId) this.#remove(key);
    this.counts.delete(accountId);
  }

  sweep() {
    const now = Date.now();
    for (const [key, rec] of this.map) if (rec.expiresAt <= now) this.#remove(key);
    this.lastSweepAt = now;
  }

  /** 节流清理过期映射：让计数/指标不再最多陈旧 15s，同时避免每次请求全量扫描。 */
  sweepIfDue(minIntervalMs = 1000) {
    const now = Date.now();
    if (now - this.lastSweepAt < minIntervalMs) return;
    this.sweep();
  }

  countByAccount(accountId) {
    this.sweepIfDue();
    return this.counts.get(accountId) || 0;
  }

  countsByAccount() {
    this.sweepIfDue();
    return Object.fromEntries(this.counts);
  }

  size() {
    this.sweepIfDue();
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// 选择器
// ---------------------------------------------------------------------------
export class Lease {
  constructor(account, ctx) {
    this.account = account;
    this.ctx = ctx || {};
    this.released = false;
    account.leases++;
    account.stats.requests++;
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.account.leases = Math.max(0, this.account.leases - 1);
  }
}

export function classifyFailure(error) {
  if (!error) return { kind: 'unknown' };
  if (error instanceof QuotaExhaustedError || error?.quota) {
    return { kind: 'quota', retryAt: error.info?.retryAt || error.info?.resetAt || 0 };
  }
  if (error instanceof AuthExpiredError || error?.authExpired || error instanceof UnauthorizedError) {
    return { kind: 'auth' };
  }
  if (error instanceof ModelNotFoundError) return { kind: 'model', model: error.model };
  if (error instanceof UpstreamError) {
    if (error.code === 'context_length_exceeded') return { kind: 'context' };
    const retryAfterMs = Number(error.retryAfterMs || (error.retryAfter ? Number(error.retryAfter) * 1000 : 0)) || 0;
    if (error.status === 429) return { kind: 'rate-limit', retryAfterMs };
    if (error.status >= 500) return { kind: 'upstream5xx', status: error.status, retryAfterMs };
    if (error.status === 404 || error.status === 400) return { kind: 'model' };
    return { kind: 'upstream', status: error.status };
  }
  const msg = String(error.message || error);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|socket/i.test(msg)) return { kind: 'network' };
  return { kind: 'unknown' };
}

export class AccountSelector {
  constructor({ config, logger, pool, quota, affinity, alerts }) {
    this.config = config;
    this.logger = logger;
    this.pool = pool;
    this.quota = quota;
    this.affinity = affinity;
    this.alerts = alerts;
  }

  #priorityScore(account) {
    const clamped = Math.max(-10, Math.min(10, account.priority || 0));
    return (clamped + 10) / 20;
  }

  score(account, { sticky = false, quotaExempt = false, sessionLoad = 0 } = {}) {
    const w = this.config.selection.weights;
    // LEGACY 模型不受额度限制：额度权重固定为满分，避免因账号额度低而选不到
    const headroom = quotaExempt ? 1 : this.quota.headroom(account.id);
    const load = 1 - account.leases / Math.max(1, account.maxConcurrent);
    const health = account.health === 'ready' ? 1 : 0.2;
    const priority = this.#priorityScore(account);
    const preferred = account.preferred ? 1 : 0;
    const stickyBonus = sticky ? this.config.selection.stickyScoreFactor : 0;
    const sessions = Number(w.sessions || 0) * sessionLoad;
    return (
      w.headroom * headroom +
      w.health * health +
      w.load * load +
      w.priority * priority +
      w.preferred * preferred +
      sessions +
      stickyBonus
    );
  }

  /**
   * 选一个账号并返回 Lease。
   * @returns {{lease: Lease|null, reason?: string, details?: object}}
   */
  select({ consumerId = 'anonymous', sessionKey = '', model = '', excludeIds = new Set(), now = Date.now() } = {}) {
    const all = this.pool.list();
    const eligible = all.filter(
      (a) =>
        a.enabled &&
        !a.credentialMissing &&
        a.health !== 'auth-expired' &&
        a.health !== 'disabled' &&
        a.cooldownUntil <= now &&
        a.leases < a.maxConcurrent &&
        !excludeIds.has(a.id) &&
        !a.modelDenied(model, now),
    );
    if (eligible.length === 0) {
      const details = {
        total: all.length,
        excluded: excludeIds.size,
        busy: all.filter((a) => a.leases >= a.maxConcurrent).map((a) => a.id),
        cooling: all.filter((a) => a.cooldownUntil > now).map((a) => a.id),
        authExpired: all.filter((a) => a.health === 'auth-expired').map((a) => a.id),
        disabled: all.filter((a) => !a.enabled || a.credentialMissing).map((a) => a.id),
      };
      let reason = 'pool_unavailable';
      if (details.cooling.length && details.cooling.length + details.busy.length + details.authExpired.length + details.disabled.length === all.length) {
        reason = details.authExpired.length === all.length ? 'all_auth_expired' : 'all_cooling';
      } else if (details.busy.length === all.length) reason = 'all_busy';
      return { lease: null, reason, details };
    }

    const balancing = this.config.selection.sessionBalancing?.enabled !== false;
    const maxSessions = Math.max(0, Number(this.config.selection.sessionBalancing?.maxSessionsPerAccount || 0));
    const quotaExempt = this.pool.isQuotaExemptModel(model);
    const headroomOf = (account) => (quotaExempt ? 1 : this.quota.headroom(account.id));
    const stickyMinHeadroom = Number(this.config.selection.stickyMinHeadroom ?? 0.1);
    const pinnedId = sessionKey ? this.affinity.get(consumerId, sessionKey) : null;

    // 会话硬绑定：原账号仍可调度且余量达标时固定使用，避免同会话被评分抢走
    if (balancing && pinnedId) {
      const pinned = eligible.find((a) => a.id === pinnedId);
      if (pinned && headroomOf(pinned) >= stickyMinHeadroom) {
        this.affinity.set(consumerId, sessionKey, pinned.id);
        const lease = new Lease(pinned, { consumerId, sessionKey, model, sticky: true, pinned: true });
        this.logger?.debug('会话硬绑定', {
          account: pinned.id,
          consumer: consumerId,
          sessions: this.affinity.countByAccount(pinned.id),
          headroom: Number(headroomOf(pinned).toFixed(3)),
        });
        return { lease, reason: null, details: { candidates: eligible.length, chosen: pinned.id, sticky: true, pinned: true } };
      }
    }

    // 新会话/漂移：按评分选择，并把会话数作为负载因子
    let candidates = eligible;
    // 硬绑定因余量不达标而未命中时，优先换到其他账号，避免再次选回原账号
    if (balancing && pinnedId && candidates.length > 1) {
      const others = candidates.filter((a) => a.id !== pinnedId);
      if (others.length) candidates = others;
    }
    if (balancing && sessionKey && maxSessions > 0) {
      const under = candidates.filter((a) => this.affinity.countByAccount(a.id) < maxSessions);
      if (under.length) candidates = under;
    }
    const counts = candidates.map((a) => this.affinity.countByAccount(a.id));
    const sessionRef = maxSessions > 0 ? maxSessions : Math.max(1, ...counts);
    const scored = candidates.map((account) => {
      const count = this.affinity.countByAccount(account.id);
      // 允许负值：超过 maxSessionsPerAccount 的账号仍按会话数排序，溢出时才不会全部打平
      const sessionLoad = balancing && sessionKey ? 1 - count / sessionRef : 0;
      // 关闭负载均衡时保持旧软粘性语义（LEGACY 模型也使用原始额度余量判断）
      const sticky =
        !balancing && account.id === pinnedId && this.quota.headroom(account.id) >= stickyMinHeadroom;
      return { account, count, sticky, sessionLoad };
    });
    for (const item of scored) {
      item.score = this.score(item.account, { sticky: item.sticky, quotaExempt, sessionLoad: item.sessionLoad });
    }
    scored.sort((a, b) => b.score - a.score || a.account.id.localeCompare(b.account.id));
    const chosen = scored[0];
    // 选中即绑定：同一 session 的并发首请求不会落到不同账号；失败时 onFailure 会解绑
    if (balancing && sessionKey) this.affinity.set(consumerId, sessionKey, chosen.account.id);
    const lease = new Lease(chosen.account, { consumerId, sessionKey, model, sticky: chosen.sticky, pinned: false });
    this.logger?.debug('选号完成', {
      account: chosen.account.id,
      score: Number(chosen.score.toFixed(3)),
      sticky: chosen.sticky,
      sessions: chosen.count,
      headroom: Number(headroomOf(chosen.account).toFixed(3)),
      leases: chosen.account.leases,
    });
    return {
      lease,
      reason: null,
      details: { candidates: scored.length, chosen: chosen.account.id, sticky: chosen.sticky, sessions: chosen.count },
    };
  }

  onSuccess(lease, info = {}) {
    if (!lease) return;
    const { account, ctx } = lease;
    this.pool.markSuccess(account, info);
    if (ctx.sessionKey) this.affinity.set(ctx.consumerId, ctx.sessionKey, account.id);
  }

  onFailure(lease, failure) {
    if (!lease) return;
    const { account, ctx } = lease;
    const cls = classifyFailure(failure);
    const cd = this.config.selection.cooldown;
    account.stats.failures++;
    account.stats.lastError = String(failure?.message || failure);
    this.affinity.invalidate(ctx.consumerId, ctx.sessionKey);
    switch (cls.kind) {
      case 'quota': {
        if (this.pool.isQuotaExemptModel(ctx.model)) {
          this.logger?.info('LEGACY 免额度模型不走账号额度冷却', { account: account.id, model: ctx.model });
          break;
        }
        const retryAt = Number(cls.retryAt || 0);
        // 多窗口耗尽时取"已耗尽窗口"最晚恢复时间（避免早于 7D 重置反复 429），上限 7 天
        const recoveryAt = Math.max(retryAt, this.quota?.exhaustedRecoveryAt?.(account.id) || 0);
        const fromRetry = recoveryAt > Date.now() ? Math.min(recoveryAt - Date.now(), 7 * 24 * 3600_000) : 0;
        this.pool.setCooldown(account, Math.max(cd.quotaFallbackMs, fromRetry), 'quota_exhausted');
        break;
      }
      case 'auth':
        account.health = 'auth-expired';
        this.pool.setCooldown(account, cd.authExpiredMs, 'auth_expired');
        this.logger?.warn('账号鉴权失效，已移出候选', { account: account.id });
        break;
      case 'rate-limit':
        if (this.pool.isQuotaExemptModel(ctx.model)) {
          this.logger?.info('LEGACY 免额度模型不走限流冷却', { account: account.id, model: ctx.model });
          break;
        }
        this.pool.setCooldown(account, Math.max(cd.rateLimitMs, Math.min(Number(cls.retryAfterMs || 0), 6 * 3600_000)), 'rate_limited');
        break;
      case 'upstream5xx':
        this.pool.setCooldown(
          account,
          Math.max(cd.upstream5xxMs, Math.min(Number(cls.retryAfterMs || 0), 6 * 3600_000)),
          `upstream_${cls.status || '5xx'}`,
        );
        break;
      case 'network':
        this.pool.setCooldown(account, cd.networkMs, 'network');
        break;
      case 'model':
        if (ctx.model) this.pool.denyModel(account, ctx.model, 300000);
        break;
      case 'context':
        // 上下文超限不是账号/模型不可用：不冷却、不降权
        this.logger?.warn('请求上下文超出模型上限', { account: account.id, model: ctx.model });
        break;
      default:
        this.pool.setCooldown(account, cd.networkMs, 'unknown_failure');
    }
    // 失败后立即评估账号级告警（登录失效/额度耗尽/上游异常等），不阻塞请求重试
    this.alerts?.evaluate(this.pool, this.quota, { reason: `failure_${cls.kind}` }).catch(() => {});
    return cls;
  }
}

// ---------------------------------------------------------------------------
// 消费者认证与限额
// ---------------------------------------------------------------------------
export class ConsumerLimiter {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    this.consumers = new Map(); // id -> consumer
    this.byKey = new Map(); // key -> id
    this.removed = new Set(); // 运行时删除的 id（config 源也不再生效）
    this.state = new Map(); // id -> { rpm:[], active, total }
    this.persistedFile = path.join(config.stateDir, 'consumers.json');
    for (const c of config.consumers || []) {
      if (!c || !c.key) continue;
      const id = String(c.id || c.name || String(c.key).slice(0, 8));
      this.#set({
        id,
        name: String(c.name || id),
        key: String(c.key),
        rpm: Number(c.rpm || 0),
        maxConcurrent: Number(c.maxConcurrent || 0),
        enabled: c.enabled !== false,
        origin: 'config',
      });
    }
    this.loadPersisted();
  }

  get enabled() {
    return this.consumers.size > 0;
  }

  #set(consumer) {
    const existing = this.consumers.get(consumer.id);
    if (existing) this.byKey.delete(existing.key);
    this.consumers.set(consumer.id, consumer);
    this.byKey.set(consumer.key, consumer.id);
    return consumer;
  }

  #removeLocal(id) {
    const c = this.consumers.get(id);
    if (!c) return false;
    this.consumers.delete(id);
    this.byKey.delete(c.key);
    this.state.delete(id);
    return true;
  }

  loadPersisted() {
    try {
      if (!existsSync(this.persistedFile)) return;
      const raw = JSON.parse(readFileSync(this.persistedFile, 'utf8'));
      for (const id of raw.removed || []) {
        this.#removeLocal(String(id));
        this.removed.add(String(id));
      }
      for (const c of raw.consumers || []) {
        if (!c?.id || !c?.key) continue;
        this.#set({
          id: String(c.id),
          name: String(c.name || c.id),
          key: String(c.key),
          rpm: Number(c.rpm || 0),
          maxConcurrent: Number(c.maxConcurrent || 0),
          enabled: c.enabled !== false,
          origin: 'runtime',
        });
      }
      if ((raw.consumers || []).length || (raw.removed || []).length) {
        this.logger?.info('已恢复运行时消费者配置', {
          file: this.persistedFile,
          runtimeConsumers: (raw.consumers || []).length,
          removed: (raw.removed || []).length,
        });
      }
    } catch (e) {
      this.logger?.warn('读取消费者状态失败（忽略）', { error: e.message });
    }
  }

  persist() {
    try {
      mkdirSync(path.dirname(this.persistedFile), { recursive: true });
      const data = {
        savedAt: new Date().toISOString(),
        consumers: [...this.consumers.values()]
          .filter((c) => c.origin === 'runtime')
          .map(({ id, name, key, rpm, maxConcurrent, enabled }) => ({ id, name, key, rpm, maxConcurrent, enabled })),
        removed: [...this.removed],
      };
      const tmp = `${this.persistedFile}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.persistedFile);
      return true;
    } catch (e) {
      this.logger?.warn('保存消费者状态失败', { error: e.message });
      return false;
    }
  }

  list() {
    return [...this.consumers.values()];
  }

  get(id) {
    return this.consumers.get(id);
  }

  /** 发放新消费者 key（返回含明文 key 的对象，仅此一次） */
  issue({ id, name, rpm = 0, maxConcurrent = 0, key } = {}) {
    const cid = String(id || `consumer-${Date.now().toString(36)}`);
    if (this.consumers.has(cid)) {
      const err = new Error(`消费者已存在：${cid}`);
      err.status = 409;
      throw err;
    }
    const finalKey = String(key || generateConsumerKey());
    if (this.byKey.has(finalKey)) {
      const err = new Error('API Key 已存在');
      err.status = 409;
      throw err;
    }
    const consumer = this.#set({
      id: cid,
      name: String(name || cid),
      key: finalKey,
      rpm: Number(rpm || 0),
      maxConcurrent: Number(maxConcurrent || 0),
      enabled: true,
      origin: 'runtime',
    });
    this.removed.delete(cid);
    this.persist();
    this.logger?.info('已发放消费者 API Key', { consumer: cid, name: consumer.name, rpm: consumer.rpm, maxConcurrent: consumer.maxConcurrent });
    return { consumer, key: finalKey };
  }

  rotate(id) {
    const c = this.consumers.get(String(id));
    if (!c) {
      const err = new Error(`消费者不存在：${id}`);
      err.status = 404;
      throw err;
    }
    this.byKey.delete(c.key);
    c.key = generateConsumerKey();
    c.origin = 'runtime';
    this.byKey.set(c.key, c.id);
    this.persist();
    this.logger?.info('已轮换消费者 API Key', { consumer: c.id });
    return { consumer: c, key: c.key };
  }

  patch(id, patch = {}) {
    const c = this.consumers.get(String(id));
    if (!c) {
      const err = new Error(`消费者不存在：${id}`);
      err.status = 404;
      throw err;
    }
    if (patch.name !== undefined) c.name = String(patch.name);
    if (patch.rpm !== undefined) c.rpm = Number(patch.rpm || 0);
    if (patch.maxConcurrent !== undefined) c.maxConcurrent = Number(patch.maxConcurrent || 0);
    if (patch.enabled !== undefined) c.enabled = Boolean(patch.enabled);
    c.origin = 'runtime';
    this.persist();
    return c;
  }

  remove(id) {
    const c = this.consumers.get(String(id));
    if (!c) {
      const err = new Error(`消费者不存在：${id}`);
      err.status = 404;
      throw err;
    }
    this.#removeLocal(String(id));
    this.removed.add(String(id));
    this.persist();
    this.logger?.info('已删除消费者', { consumer: id });
    return true;
  }

  /** 对外展示用（key 脱敏） */
  redacted(c) {
    const st = this.#state(c.id);
    return {
      id: c.id,
      name: c.name,
      keyPrefix: `${String(c.key).slice(0, 7)}…${String(c.key).slice(-4)}`,
      rpm: c.rpm,
      maxConcurrent: c.maxConcurrent,
      enabled: c.enabled,
      origin: c.origin || 'runtime',
      windowRpm: st.rpm.filter((t) => Date.now() - t < 60000).length,
      active: st.active,
      total: st.total,
    };
  }

  identify(req) {
    if (!this.enabled) return { id: 'anonymous', name: 'anonymous', rpm: 0, maxConcurrent: 0 };
    const auth = String(req.headers.authorization || '');
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-key'] || '');
    if (!key) {
      const err = new Error('缺少 API Key（Authorization: Bearer <key>）');
      err.status = 401;
      err.code = 'invalid_api_key';
      err.type = 'invalid_request_error';
      throw err;
    }
    const consumerId = this.byKey.get(key);
    const consumer = consumerId ? this.consumers.get(consumerId) : undefined;
    if (!consumer || !consumer.enabled) {
      const err = new Error('无效的 API Key');
      err.status = 401;
      err.code = 'invalid_api_key';
      err.type = 'invalid_request_error';
      throw err;
    }
    return consumer;
  }

  #state(consumerId) {
    let st = this.state.get(consumerId);
    if (!st) {
      st = { rpm: [], active: 0, total: 0 };
      this.state.set(consumerId, st);
    }
    return st;
  }

  acquire(consumer) {
    if (!consumer || consumer.id === 'anonymous') return () => {};
    const st = this.#state(consumer.id);
    const now = Date.now();
    st.rpm = st.rpm.filter((t) => now - t < 60000);
    if (consumer.rpm && st.rpm.length >= consumer.rpm) {
      throw new ConsumerRateLimitError(`消费者 ${consumer.name} 超过每分钟请求上限（${consumer.rpm} RPM）`, 'rpm');
    }
    if (consumer.maxConcurrent && st.active >= consumer.maxConcurrent) {
      throw new ConsumerRateLimitError(`消费者 ${consumer.name} 超过并发上限（${consumer.maxConcurrent}）`, 'concurrency');
    }
    st.rpm.push(now);
    st.active++;
    st.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      st.active = Math.max(0, st.active - 1);
    };
  }

  snapshot() {
    return this.list().map((c) => this.redacted(c));
  }

  /** 导出累计计数（持久化用） */
  exportTotals() {
    return Object.fromEntries(this.list().map((c) => [c.id, { total: this.#state(c.id).total }]));
  }

  /** 恢复累计计数 */
  importTotals(totals) {
    if (!totals || typeof totals !== 'object') return;
    for (const c of this.list()) {
      const saved = totals[c.id];
      if (saved && Number.isFinite(Number(saved.total))) this.#state(c.id).total = Number(saved.total);
    }
  }
}

function generateConsumerKey() {
  return `sk-cf-${randomBytes(18).toString('base64url')}`;
}
