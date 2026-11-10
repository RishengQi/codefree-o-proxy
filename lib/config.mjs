// 配置加载：config.json + 环境变量覆盖 + 旧版单账号兼容
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deepMerge } from './util.mjs';
import { detectClientVersion } from './codefree-app.mjs';

export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  server: {
    host: '127.0.0.1',
    port: 8787,
    adminToken: '',
    adminTokenEnv: 'CODEFREE_ADMIN_TOKEN',
    allowRemoteAdmin: false,
    maxBodyBytes: 10 * 1024 * 1024,
    shutdownTimeoutMs: 15000,
    debug: false,
  },
  upstream: {
    baseUrl: 'https://www.srdcloud.cn',
    clientId: '',
    clientSecret: '',
    signingSecret: '',
    version: '1.10.1',
    /** 从本机安装的 CodeFree-O app.asar 自动识别版本（客户端升级后无需改配置）；false 则固定用 version */
    autoDetectVersion: true,
    subService: 'codefree_o_desktop_chat',
    clientTag: 'codefreeo',
    /** 上游 User-Agent；默认按 opencode/<version> ai-sdk/openai-compatible 生成 */
    userAgent: '',
    requestTimeoutMs: 300000,
    /** 流式响应逐块空闲超时（对齐 App 的 wrapSSE 300s；0 表示禁用） */
    streamIdleTimeoutMs: 300000,
    /** 为 true 时按账号派生上游 sessionId，避免故障切换后同一会话跨账号出现（多账号池建议开启） */
    sessionIdIsolation: false,
    refreshTimeoutMs: 15000,
    quotaTimeoutMs: 8000,
  },
  accounts: [],
  imports: {
    authfile: { enabled: true, path: '', mode: 'mirror' },
    sqlite: { enabled: false, path: '', mode: 'mirror', onStartup: false },
  },
  refresh: {
    skewMs: 120000,
    maxRetries: 3,
    backoffMs: [300, 900, 2700],
    preRefreshWindowMs: 600000,
    startupWarmup: false,
    /** auth-expired / 凭据缺失账号的自动恢复尝试间隔（0 = 关闭自动恢复） */
    authRecoveryMs: 600000,
  },
  quota: {
    enabled: true,
    endpoint: '/api/aebackend/quota/v1/me',
    assumeUnknownHeadroom: 0.5,
    maxAgeMs: 180000,
    probe: {
      enabled: true,
      timeoutMs: 8000,
      maxConcurrentProbes: 2,
      globalRatePerSec: 1,
      perAccountQps: 0.2,
      hourlyBudget: 120,
      hotMs: 60000,
      warmMs: 300000,
      coldMs: 1800000,
      jitterRatio: 0.2,
      backoffMaxMs: 1800000,
    },
  },
  selection: {
    stickyTtlMs: 1800000,
    stickyMinHeadroom: 0.1,
    /** 会话映射上限（超出按最近使用淘汰；0 = 不限制） */
    maxSessions: 10000,
    stickyScoreFactor: 0.6,
    maxAttemptsPerRequest: 3,
    maxAccountsPerRequest: 2,
    maxSameAccountRetries: 1,
    leaseWaitMs: 0,
    weights: { headroom: 1.0, health: 0.5, load: 0.5, priority: 0.2, preferred: 0.3, sessions: 0.5 },
    sessionBalancing: {
      enabled: true,
      maxSessionsPerAccount: 0,
    },
    cooldown: {
      quotaFallbackMs: 300000,
      authExpiredMs: 600000,
      rateLimitMs: 30000,
      upstream5xxMs: 15000,
      networkMs: 10000,
    },
  },
  consumers: [],
  metrics: { enabled: true },
  alert: {
    enabled: false,
    webhookUrl: '',
    msgType: 'text',
    cooldownMs: 600000,
    accountCooldownMs: 21600000,
    quotaWarnPercent: 80,
    refreshExpiryWarnHours: 48,
    webhookTimeoutMs: 10000,
    mentionedList: [],
    mentionedMobileList: [],
  },
  stateDir: './state',
  journal: { enabled: true, file: '' },
};

function readJson(file, logger) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    logger?.warn('配置文件解析失败，使用默认配置', { file, error: e.message });
    return null;
  }
}

/**
 * 加载配置。
 * 优先级：显式文件 > 环境变量 CODEFREE_CONFIG 指向的文件 > 当前工作目录 config.json > 默认值
 */
export function loadConfig({ cwd = process.cwd(), env = process.env, logger } = {}) {
  const envFile = env.CODEFREE_CONFIG?.trim();
  const localFile = path.join(cwd, 'config.json');
  const file = envFile || (existsSync(localFile) ? localFile : '');
  let raw = {};
  if (file && existsSync(file)) {
    raw = readJson(file, logger) || {};
  }

  let cfg = deepMerge(structuredClone(DEFAULT_CONFIG), raw);

  // ---- 环境变量覆盖（保持旧版行为） ----
  if (env.PORT) cfg.server.port = Number(env.PORT);
  if (env.HOST) cfg.server.host = env.HOST;
  if (env.CODEFREE_BASE_URL) cfg.upstream.baseUrl = env.CODEFREE_BASE_URL;
  if (env.CODEFREE_CLIENT_ID) cfg.upstream.clientId = env.CODEFREE_CLIENT_ID;
  if (env.CODEFREE_CLIENT_SECRET) cfg.upstream.clientSecret = env.CODEFREE_CLIENT_SECRET;
  if (env.CODEFREE_SIGNING_SECRET) cfg.upstream.signingSecret = env.CODEFREE_SIGNING_SECRET;
  if (env.CODEFREE_VERSION) cfg.upstream.version = env.CODEFREE_VERSION;
  if (env.CODEFREE_SUB_SERVICE) cfg.upstream.subService = env.CODEFREE_SUB_SERVICE;  if (env.CODEFREE_TIMEOUT_MS) cfg.upstream.requestTimeoutMs = Number(env.CODEFREE_TIMEOUT_MS);
  if (env.CODEFREE_DEBUG === '1' || env.CODEFREE_DEBUG === 'true') cfg.server.debug = true;
  if (env.CODEFREE_STATE_DIR) cfg.stateDir = env.CODEFREE_STATE_DIR;
  const alertWebhook = env.CODEFREE_ALERT_WEBHOOK?.trim();
  if (alertWebhook) {
    cfg.alert.webhookUrl = alertWebhook;
    cfg.alert.enabled = true;
  }
  if (env.CODEFREE_ALERT_WEBHOOK_TIMEOUT_MS) cfg.alert.webhookTimeoutMs = Number(env.CODEFREE_ALERT_WEBHOOK_TIMEOUT_MS);
  if (env.CODEFREE_ALERT_COOLDOWN_MS) cfg.alert.cooldownMs = Number(env.CODEFREE_ALERT_COOLDOWN_MS);
  if (env.CODEFREE_ALERT_ACCOUNT_COOLDOWN_MS) cfg.alert.accountCooldownMs = Number(env.CODEFREE_ALERT_ACCOUNT_COOLDOWN_MS);
  if (env.CODEFREE_QUOTA_WARN_PERCENT) cfg.alert.quotaWarnPercent = Number(env.CODEFREE_QUOTA_WARN_PERCENT);
  if (env.CODEFREE_ALERT_MSG_TYPE) cfg.alert.msgType = env.CODEFREE_ALERT_MSG_TYPE === 'markdown' ? 'markdown' : 'text';
  if (env.CODEFREE_ALERT_MENTION) {
    cfg.alert.mentionedList = env.CODEFREE_ALERT_MENTION.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.CODEFREE_ALERT_MENTION_MOBILE) {
    cfg.alert.mentionedMobileList = env.CODEFREE_ALERT_MENTION_MOBILE.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.CODEFREE_REFRESH_WARN_HOURS) cfg.alert.refreshExpiryWarnHours = Number(env.CODEFREE_REFRESH_WARN_HOURS);

  // ---- 客户端版本：环境变量 > 本机安装包自动识别 > 配置文件值 ----
  if (env.CODEFREE_VERSION) {
    cfg.upstream.versionSource = 'env';
  } else if (cfg.upstream.autoDetectVersion !== false) {
    const detected = detectClientVersion({ env, logger });
    if (detected) {
      cfg.upstream.version = detected.version;
      cfg.upstream.versionSource = 'app-asar';
      cfg.upstream.detectedAppAsar = detected.appAsar;
    } else {
      cfg.upstream.versionSource = 'config-default';
    }
  } else {
    cfg.upstream.versionSource = 'config';
  }

  // 旧版凭据文件路径
  const defaultAuthFile = path.join(os.homedir(), '.codefree-o', '.local', 'share', 'codefree.json');
  const legacyAuthFile = env.CODEFREE_AUTH_FILE?.trim() || defaultAuthFile;
  if (!cfg.imports.authfile.path) cfg.imports.authfile.path = legacyAuthFile;
  if (env.CODEFREE_AUTH_FILE) cfg.imports.authfile.path = env.CODEFREE_AUTH_FILE;
  if (env.CODEFREE_AUTH_FILES) {
    const extra = env.CODEFREE_AUTH_FILES.split(',').map((s) => s.trim()).filter(Boolean);
    const base = cfg.imports.authfile.path;
    cfg.imports.authfile.path = [base, ...extra].filter((p, i, a) => p && a.indexOf(p) === i).join(',');
  }
  if (env.CODEFREE_SYNC_AUTH_FILE === 'false') cfg.imports.authfile.mode = 'readonly';
  if (env.CODEFREE_QUOTA_TTL_MS) cfg.quota.maxAgeMs = Number(env.CODEFREE_QUOTA_TTL_MS);

  // ---- 派生默认值 ----
  if (!cfg.upstream.userAgent) {
    cfg.upstream.userAgent = `opencode/${cfg.upstream.version} ai-sdk/openai-compatible`;
  }
  cfg.upstream.baseUrl = String(cfg.upstream.baseUrl || '').replace(/\/+$/, '');
  cfg.upstream.clientId = cfg.upstream.clientId || clientIdForBaseUrl(cfg.upstream.baseUrl);
  cfg.upstream.clientSecret = cfg.upstream.clientSecret || clientSecretForBaseUrl(cfg.upstream.baseUrl);
  if (!cfg.stateDir || !path.isAbsolute(cfg.stateDir)) cfg.stateDir = path.resolve(cwd, cfg.stateDir || './state');
  if (!cfg.journal.file) cfg.journal.file = path.join(cfg.stateDir, 'journal.jsonl');
  cfg.__file = file;
  cfg.__cwd = cwd;
  return cfg;
}

export function clientIdForBaseUrl(baseUrl) {
  if (baseUrl.includes('dev')) return '';
  if (baseUrl.includes('test')) return '';
  return '';
}

export function clientSecretForBaseUrl(baseUrl) {
  if (baseUrl.includes('dev')) return '';
  if (baseUrl.includes('test')) return '';
  return '';
}

/** 从配置 + 导入源构建账号规格（不含运行态） */
export function resolveAccountSpecs(cfg, logger) {
  const specs = [];
  const seen = new Set();

  for (const acc of cfg.accounts || []) {
    if (!acc || !acc.id) continue;
    if (seen.has(acc.id)) continue;
    seen.add(acc.id);
    specs.push({
      id: String(acc.id),
      label: acc.label || acc.email || String(acc.id),
      email: acc.email || '',
      baseUrl: (acc.baseUrl || cfg.upstream.baseUrl).replace(/\/+$/, ''),
      userId: acc.userId ? String(acc.userId) : '',
      clientId: acc.clientId || '',
      refreshToken: acc.refreshToken || '',
      refreshTokenRef: acc.refreshTokenRef || null,
      refreshTokenExpiresAt: Number(acc.refreshTokenExpiresAt || 0),
      authFile: acc.authFile || '',
      writeBack: acc.writeBack || 'isolated',
      maxConcurrent: Number(acc.maxConcurrent ?? 3),
      priority: Number(acc.priority ?? 0),
      preferred: Boolean(acc.preferred),
      tags: Array.isArray(acc.tags) ? acc.tags : [],
      enabled: acc.enabled !== false,
    });
  }

  // 自动导入：authfile（可多个，逗号分隔）
  const authImport = cfg.imports?.authfile;
  if (authImport?.enabled !== false && authImport?.path) {
    for (const file of String(authImport.path).split(',').map((s) => s.trim()).filter(Boolean)) {
      const abs = path.resolve(cfg.__cwd, file);
      const probe = safeReadAuthMeta(abs, logger);
      if (!probe) continue;
      const id = probe.userId ? `u:${probe.userId}` : `f:${abs}`;
      if (seen.has(id)) continue;
      seen.add(id);
      specs.push({
        id,
        label: probe.userId ? `CodeFree ${probe.userId}` : path.basename(abs),
        email: '',
        baseUrl: (probe.baseUrlSnapshot || cfg.upstream.baseUrl).replace(/\/+$/, ''),
        userId: probe.userId || '',
        clientId: probe.clientId || '',
        refreshToken: '',
        refreshTokenExpiresAt: probe.refreshTokenExpiresAt || 0,
        authFile: abs,
        writeBack: authImport.mode || 'mirror',
        maxConcurrent: 3,
        priority: 0,
        preferred: false,
        tags: ['authfile'],
        enabled: true,
      });
    }
  }
  return specs;
}

// 只做最小解析，避免把解密逻辑耦合到配置层
function safeReadAuthMeta(file, logger) {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || (!raw.refreshCfToken && !raw.encryptedRefreshCfToken)) return null;
    return {
      userId: raw.userId ? String(raw.userId) : '',
      clientId: raw.clientId || '',
      baseUrlSnapshot: raw.baseUrlSnapshot || '',
      refreshTokenExpiresAt: Number(raw.refreshCfTokenExpiresAt || 0),
    };
  } catch (e) {
    logger?.debug?.('解析凭据文件元数据失败', { file, error: e.message });
    return null;
  }
}
