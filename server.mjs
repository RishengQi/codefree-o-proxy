#!/usr/bin/env node
// CodeFree-O -> OpenAI 兼容代理（多账号池 / 额度感知自动切换）
//
// 兼容 CodeFree-O Desktop 1.10.x（opencode 内核）与 1.7.x 凭据格式。
// 架构：
//   配置(config.json) -> 账号池(AccountPool) -> 额度服务(QuotaService) -> 选择器(AccountSelector)
//   -> 上游(UpstreamClient) -> OpenAI /v1/* 或管理面 /admin/*
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, resolveAccountSpecs } from './lib/config.mjs';
import { Journal, readAuthFile, resolveRefreshTokenRef } from './lib/credentials.mjs';
import { QuotaService, SseFrameScanner, extractQuotaSignal, summarizeQuota } from './lib/quota.mjs';
import { UpstreamClient, UnauthorizedError } from './lib/upstream.mjs';
import { AlertManager } from './lib/alerts.mjs';
import { renderPrometheus } from './lib/metrics.mjs';
import {
  AccountPool,
  AccountSelector,
  ConsumerLimiter,
  SessionAffinity,
  classifyFailure,
} from './lib/pool.mjs';
import {
  AuthExpiredError,
  ConsumerRateLimitError,
  ModelNotFoundError,
  PoolUnavailableError,
  QuotaExhaustedError,
  UpstreamError,
  createLogger,
  openAiError,
  parseRetryAfterMs,
  readRequestBody,
  sendJson,
} from './lib/util.mjs';

const APP_ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

function buildRuntime(cfg, logger) {
  const journal = new Journal({ file: cfg.journal.file, enabled: cfg.journal.enabled, logger });
  const quota = new QuotaService({ config: cfg, logger });
  const upstream = new UpstreamClient({ config: cfg, logger });
  const alerts = new AlertManager({ config: cfg, logger });
  const pool = new AccountPool({ config: cfg, logger, upstream, journal, quota, alerts });
  const affinity = new SessionAffinity({ config: cfg, logger });
  const selector = new AccountSelector({ config: cfg, logger, pool, quota, affinity, alerts });
  const consumers = new ConsumerLimiter({ config: cfg, logger });
  return { journal, quota, upstream, pool, affinity, selector, consumers, alerts };
}

// ---------------------------------------------------------------------------
// 错误映射（附录 B）
// ---------------------------------------------------------------------------
function mapError(res, error) {
  if (error instanceof AuthExpiredError) {
    return openAiError(res, 401, String(error.message || error), 'auth_expired', 'codefree_auth_expired', {
      detail: error.detail || undefined,
    });
  }
  if (error instanceof QuotaExhaustedError) {
    return openAiError(res, 429, String(error.message || error), 'insufficient_quota', 'codefree_quota_exhausted', {
      periods: error.info?.periods || [],
      reset_at: error.info?.resetAt ? new Date(error.info.resetAt).toISOString() : undefined,
      retry_after: secondsUntil(error.info?.retryAt || error.info?.resetAt),
    });
  }
  if (error instanceof ConsumerRateLimitError) {
    return openAiError(res, 429, String(error.message || error), 'rate_limit_exceeded', 'consumer_rate_limited', {
      scope: error.scope,
      retry_after: 1,
    });
  }
  if (error instanceof PoolUnavailableError) {
    return openAiError(res, 503, String(error.message || error), 'service_unavailable', error.reason || 'pool_unavailable');
  }
  if (error instanceof ModelNotFoundError) {
    return openAiError(res, 404, String(error.message || error), 'invalid_request_error', 'model_not_found', { model: error.model });
  }
  if (error instanceof UpstreamError) {
    const httpStatus = error.status && error.status >= 400 && error.status < 600 && error.status !== 429 ? error.status : 502;
    const errType = error.status === 429 ? 'rate_limit_exceeded' : 'upstream_error';
    const errCode = error.status === 429 ? 'codefree_rate_limited' : 'codefree_upstream_error';
    return openAiError(res, httpStatus, String(error.message || error), errType, errCode, {
      upstream_status: error.status,
      detail: error.body ? String(error.body).slice(0, 500) : undefined,
      retry_after: error.status === 429 ? 5 : undefined,
    });
  }
  const statusNum = Number(error?.status);
  const status = Number.isFinite(statusNum) && statusNum >= 400 && statusNum < 600 ? statusNum : 502;
  const type =
    error?.type ||
    (status === 400 || status === 401 || status === 403
      ? 'invalid_request_error'
      : status === 404
        ? 'not_found_error'
        : 'proxy_error');
  return openAiError(res, status, String(error?.message || error), type, error?.code || 'proxy_error');
}

function secondsUntil(ts) {
  if (!ts) return undefined;
  const s = Math.ceil((Number(ts) - Date.now()) / 1000);
  return s > 0 ? s : undefined;
}

// ---------------------------------------------------------------------------
// 对外路由
// ---------------------------------------------------------------------------
function sessionKeyOf(body, req) {
  return String(
    body?.session_id ||
      body?.sessionId ||
      req.headers['x-session-affinity'] ||
      req.headers['x-session-id'] ||
      '',
  );
}

async function handleHealth(ctx, req, res) {
  const { pool, quota, config, affinity } = ctx;
  const accounts = pool.list();
  const snapshot = pool.snapshot().map((s) => ({ ...s, sessions: affinity.countByAccount(s.id) }));
  const ready = accounts.filter((a) => a.available).length;
  const single = accounts.length <= 1 ? accounts[0] : null;
  const quotaSummary = single ? quota.get(single.id) : null;
  const body = {
    ok: true,
    service: 'codefree-o-openai-proxy',
    version: config.upstream.version,
    versionSource: config.upstream.versionSource || 'config',
    mode: accounts.length > 1 ? 'pool' : 'single',
    upstream: config.upstream.baseUrl,
    endpoints: ['/v1/models', '/v1/chat/completions', '/v1/quota', '/v1/embeddings', '/admin/*'],
    accounts: {
      total: accounts.length,
      enabled: accounts.filter((a) => a.enabled).length,
      ready,
      cooling: accounts.filter((a) => a.cooldownUntil > Date.now()).length,
      authExpired: accounts.filter((a) => a.health === 'auth-expired').length,
    },
    pool: {
      available: ready,
      activeLeases: accounts.reduce((s, a) => s + a.leases, 0),
      stickySessions: affinity.size(),
      sessionsByAccount: affinity.countsByAccount(),
    },
    accountsDetail: snapshot,
    quota: single
      ? {
          account: single.id,
          fetchedAt: quotaSummary?.fetchedAt || 0,
          quotaStatus: quotaSummary?.quotaStatus,
          windows: quotaSummary?.windows || null,
          headroom: quota.headroom(single.id),
          source: quotaSummary?.source,
        }
      : { perAccount: Object.fromEntries(accounts.map((a) => [a.id, quota.get(a.id) || null])) },
    consumers: { enabled: ctx.consumers.enabled, count: (config.consumers || []).length },
  };
  if (single) {
    body.auth = {
      authenticated: Boolean(single.accessToken) || Boolean(single.refreshToken),
      account: single.id,
      userId: single.userId,
      baseUrl: single.baseUrl,
      tokenExpiresInSec: single.accessTokenExpiresAt ? Math.max(0, Math.round((single.accessTokenExpiresAt - Date.now()) / 1000)) : 0,
      refreshExpiresAt: single.refreshTokenExpiresAt ? new Date(single.refreshTokenExpiresAt).toISOString() : null,
      authFile: single.authFile || single.stateFile,
      health: single.health,
      lastError: single.stats.lastError || null,
    };
  }
  sendJson(res, 200, body);
}

function writeMetrics(res, ctx) {
  let text;
  try {
    text = renderPrometheus({
      config: ctx.config,
      pool: ctx.pool,
      quota: ctx.quota,
      consumers: ctx.consumers,
      affinity: ctx.affinity,
      chatInFlight: chatInFlight.total,
      modelsCacheAt: modelsCache.at || 0,
      startedAt: ctx.startedAt,
    });
  } catch (e) {
    ctx.logger?.warn('渲染指标失败', { error: e.message });
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('# metrics render failed\n');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function handleMetrics(ctx, req, res) {
  const { config } = ctx;
  const tokenConfigured = Boolean(config.server.adminToken || process.env[config.server.adminTokenEnv || 'CODEFREE_ADMIN_TOKEN']);
  if (tokenConfigured && !isLoopback(req)) requireAdmin(ctx, req);
  writeMetrics(res, ctx);
}

async function withLease(ctx, { consumer, sessionKey, model, excludeIds }) {
  const { selector } = ctx;
  const result = selector.select({ consumerId: consumer.id, sessionKey, model, excludeIds });
  return result;
}

async function acquireUpstream(ctx, lease, exec) {
  // 执行一次上游调用；401 时尝试刷新一次后重试（同账号最多 1 次）
  const { pool } = ctx;
  const account = lease.account;
  await pool.ensureFresh(account);
  try {
    return await exec(account);
  } catch (e) {
    if (e instanceof UnauthorizedError || e?.authExpired) {
      ctx.logger?.warn('上游 401，尝试强制刷新后重试一次', { account: account.id });
      await pool.ensureFresh(account, { force: true });
      return await exec(account);
    }
    throw e;
  }
}

const chatInFlight = { total: 0 };

async function handleChat(ctx, req, res) {
  const { config, pool, quota, selector, consumers } = ctx;
  const bodyLimit = config.server.maxBodyBytes;

  let consumer;
  let releaseConsumer = () => {};
  let body;
  try {
    consumer = consumers.identify(req);
    releaseConsumer = consumers.acquire(consumer);
    const buf = await readRequestBody(req, bodyLimit);
    body = JSON.parse(buf.toString('utf8') || '{}');
  } catch (e) {
    releaseConsumer();
    return mapError(res, e);
  }
  if (!body.model) {
    releaseConsumer();
    return openAiError(res, 400, 'model is required', 'invalid_request_error', 'missing_model');
  }

  // 首次请求某个模型时确保模型元数据已知（LEGACY 免额度判定依赖 accessMode）
  if (!ctx.pool.modelAccess.has(String(body.model))) {
    try {
      await ensureModels(ctx);
    } catch {}
  }
  const wantStream = body.stream === true;
  const quotaExempt = ctx.pool.isQuotaExemptModel(body.model);
  // CodeFree 客户端用 x-codefree-request-purpose: title 标记标题生成请求，上游对此类请求不发布额度提醒；
  // 代理镜像该语义：title 请求不把额度信号写入被动额度快照（避免污染选号），但仍计入 token 用量。
  // LEGACY 免额度模型同样不写额度快照（官方 UI 视为无限额度）。
  const requestPurpose = String(req.headers['x-codefree-request-purpose'] || 'answer').toLowerCase();
  const quotaPassiveEnabled = requestPurpose !== 'title' && !quotaExempt;
  // App 对 openai-compatible 恒注入 stream_options.include_usage=true（AI SDK 强制），代理对齐
  if (wantStream && body && typeof body === 'object') {
    const so = body.stream_options && typeof body.stream_options === 'object' ? body.stream_options : {};
    if (so.include_usage === undefined) body.stream_options = { ...so, include_usage: true };
  }
  const sessionKey = sessionKeyOf(body, req);
  const maxAttempts = Math.max(1, config.selection.maxAttemptsPerRequest);
  const maxAccounts = Math.max(1, config.selection.maxAccountsPerRequest);
  const excludeAccounts = new Set();
  let lastFailure = null;
  let attempts = 0;
  chatInFlight.total++;

  try {
    while (attempts < maxAttempts && excludeAccounts.size < maxAccounts) {
      attempts++;
      const { lease, reason, details } = await withLease(ctx, {
        consumer,
        sessionKey,
        model: body.model,
        excludeIds: excludeAccounts,
      });
      if (!lease) {
        lastFailure = new PoolUnavailableError(
          `暂无可用账号（${reason}；细明：${JSON.stringify(details)}）`,
          reason,
        );
        break;
      }
      const account = lease.account;
      const t0 = Date.now();
      try {
        const upstreamHeaders = {
          'Content-Type': 'application/json',
          Accept: wantStream ? 'text/event-stream' : 'application/json',
          'X-Codefree-Quota-Schema': '1',
          modelName: String(body.model),
          subService: req.headers['x-codefree-sub-service'] || body.subService || config.upstream.subService,
        };
        const affinityHeader = req.headers['x-session-affinity'] || req.headers['x-session-id'];
        if (affinityHeader) {
          const rawSession = String(affinityHeader);
          // 可选：按账号派生上游 sessionId，避免同一 sessionId 在故障切换后出现在不同账号名下
          // （官方客户端不会跨账号复用 sessionId；多账号池默认关闭以保持与客户端一致）
          upstreamHeaders.sessionId = config.upstream.sessionIdIsolation
            ? `${rawSession}-${createHash('sha256').update(`${account.id}:${rawSession}`).digest('hex').slice(0, 12)}`
            : rawSession;
        }
        if (req.headers['x-session-id']) upstreamHeaders['X-Session-Id'] = String(req.headers['x-session-id']);
        if (req.headers['x-parent-session-id']) {
          upstreamHeaders['x-parent-session-id'] = String(req.headers['x-parent-session-id']);
        }

        const streamAbort = wantStream ? new AbortController() : null;
        let headerTimer = null;
        if (streamAbort) {
          headerTimer = setTimeout(() => {
            try {
              streamAbort.abort(new Error('upstream header timeout'));
            } catch {}
          }, config.upstream.requestTimeoutMs);
        }
        let clientClosed = false;
        const onClientClose = () => {
          if (!res.writableEnded) {
            clientClosed = true;
            try {
              streamAbort?.abort(new Error('client closed'));
            } catch {}
          }
        };
        if (streamAbort) res.on('close', onClientClose);
        let upstreamRes;
        try {
          upstreamRes = await acquireUpstream(ctx, lease, (acc) =>
            ctx.upstream.chat(acc, body, { headers: upstreamHeaders, signal: streamAbort?.signal }),
          );
        } finally {
          if (headerTimer) clearTimeout(headerTimer);
        }

        if (!upstreamRes.ok) {
          const text = await upstreamRes.text().catch(() => '');
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {}
          const signal = parsed ? extractQuotaSignal(parsed) : null;
          if (signal && quotaPassiveEnabled) quota.recordPassive(account.id, signal);
          if (signal?.kind === 'exhausted') throw new QuotaExhaustedError(signal, account.label);
          if (upstreamRes.status === 429) {
            const retryAfterMs = Math.max(
              parseRetryAfterMs(upstreamRes.headers),
              parsed && Number(parsed.retryAt || parsed.resetAt)
                ? Math.max(0, Number(parsed.retryAt || parsed.resetAt) - Date.now())
                : 0,
              5000,
            );
            throw Object.assign(new UpstreamError(`上游限流 ${upstreamRes.status}`, 429, text, 'rate_limited'), {
              retryAfter: Math.max(1, Math.round(retryAfterMs / 1000)),
              retryAfterMs,
            });
          }
          if (parsed && parsed.retCode !== undefined) {
            throw Object.assign(
              new UpstreamError(
                `CodeFree 调用失败：retCode=${parsed.retCode}${parsed.msg ? ' ' + parsed.msg : ''}`,
                502,
                text,
                String(parsed.retCode),
              ),
              { retryAfterMs: parseRetryAfterMs(upstreamRes.headers) },
            );
          }
          throw Object.assign(new UpstreamError(`上游返回 ${upstreamRes.status}`, upstreamRes.status, text, 'upstream_error'), {
            retryAfterMs: parseRetryAfterMs(upstreamRes.headers),
          });
        }

        const contentType = upstreamRes.headers.get('content-type') || (wantStream ? 'text/event-stream' : 'application/json');

        if (wantStream && contentType.includes('text/event-stream')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          });
          const idleMs = Number(config.upstream.streamIdleTimeoutMs ?? 300000);
          let lastChunkAt = Date.now();
          let streamUsage = null;
          let quotaExhausted = null;
          let businessError = null;
          const scanner = new SseFrameScanner((frame) => {
            if (!frame || typeof frame !== 'object') return;
            if (frame.usage && typeof frame.usage === 'object') streamUsage = frame.usage;
            if (frame.error && typeof frame.error === 'object') businessError = frame.error;
            const signal = extractQuotaSignal(frame);
            if (!signal) return;
            if (signal.kind === 'exhausted') quotaExhausted = signal;
            if (quotaPassiveEnabled) quota.recordPassive(account.id, signal);
          });
          const idleTimer =
            idleMs > 0
              ? setInterval(() => {
                  if (Date.now() - lastChunkAt > idleMs) {
                    try {
                      streamAbort?.abort(new Error('SSE idle timeout'));
                    } catch {}
                  }
                }, Math.max(100, Math.min(1000, Math.floor(idleMs / 4))))
              : null;
          const reader = upstreamRes.body.getReader();
          let streamError = null;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              lastChunkAt = Date.now();
              try {
                scanner.push(value);
              } catch {}
              try {
                res.write(value);
              } catch {}
              if (quotaExhausted || businessError || clientClosed) {
                try {
                  await reader.cancel();
                } catch {}
                break;
              }
            }
          } catch (e) {
            streamError = e;
          } finally {
            if (idleTimer) clearInterval(idleTimer);
          }
          try {
            scanner.end();
          } catch {}
          const writeErrorFrame = (payload) => {
            if (res.writableEnded) return;
            try {
              res.write(`data: ${JSON.stringify({ error: payload })}\n\n`);
            } catch {}
          };
          // 客户端主动断开：不计成功/失败，已通过 abort 取消上游
          if (clientClosed) {
            ctx.logger?.info('客户端已断开，已取消上游流', { account: account.id, elapsedMs: Date.now() - t0 });
            try {
              res.end();
            } catch {}
            return;
          }
          // 流内额度耗尽：终止流并按 resetAt/retryAt 冷却账号（对齐 App 语义）
          if (quotaExhausted) {
            ctx.logger?.warn('流内额度耗尽，终止流并冷却账号', {
              account: account.id,
              periods: quotaExhausted.periods,
              resetAt: quotaExhausted.resetAt,
            });
            writeErrorFrame({
              message: '额度已耗尽',
              type: 'insufficient_quota',
              code: 'codefree_quota_exhausted',
              periods: quotaExhausted.periods || [],
              reset_at: quotaExhausted.resetAt ? new Date(quotaExhausted.resetAt).toISOString() : undefined,
              retry_after: secondsUntil(quotaExhausted.retryAt || quotaExhausted.resetAt),
            });
            try {
              res.end();
            } catch {}
            selector.onFailure(lease, new QuotaExhaustedError(quotaExhausted, account.label));
            return;
          }
          // 流内业务错误帧：原始错误帧已透传，按错误语义结束并参与失败分类
          if (businessError) {
            const code = String(businessError.code || businessError.type || 'stream_error');
            const msg = String(businessError.message || code);
            ctx.logger?.warn('上游流内返回业务错误', { account: account.id, code, msg: msg.slice(0, 200) });
            try {
              res.end();
            } catch {}
            const contextOverflow = /context|length_exceeded|too many tokens|maximum context/i.test(`${code} ${msg}`);
            const err = new UpstreamError(`上游流内错误：${msg}`, contextOverflow ? 400 : 502, JSON.stringify(businessError).slice(0, 500), code);
            if (contextOverflow) err.code = 'context_length_exceeded';
            selector.onFailure(lease, err);
            return;
          }
          // 网络/空闲超时等流中断：不得记成功（对齐 App 把 ResponseStreamError 视为可重试失败）
          if (streamError) {
            ctx.logger?.warn('SSE 流中断', {
              account: account.id,
              error: String(streamError.message || streamError),
              elapsedMs: Date.now() - t0,
            });
            writeErrorFrame({ message: '上游流中断', type: 'upstream_error', code: 'codefree_stream_interrupted' });
            try {
              res.end();
            } catch {}
            selector.onFailure(lease, new UpstreamError('上游流中断', 502, '', 'stream_interrupted'));
            return;
          }
          try {
            res.end();
          } catch {}
          selector.onSuccess(lease, {
            latencyMs: Date.now() - t0,
            tokensIn: streamUsage?.prompt_tokens,
            tokensOut: streamUsage?.completion_tokens,
          });
          ctx.logger?.info('聊天请求完成', {
            consumer: consumer.id,
            account: account.id,
            model: body.model,
            stream: true,
            attempted: attempts,
            elapsedMs: Date.now() - t0,
            tokensIn: streamUsage?.prompt_tokens,
            tokensOut: streamUsage?.completion_tokens,
          });
          return;
        }

        const text = await upstreamRes.text();
        try {
          const parsed = JSON.parse(text);
          const signal = extractQuotaSignal(parsed);
          if (signal && quotaPassiveEnabled) {
            quota.recordPassive(account.id, signal);
            // 成功响应里也可能带 QUOTA_WARNING：立即评估账号级额度预警
            ctx.alerts?.evaluate(ctx.pool, ctx.quota, { reason: 'quota_signal' }).catch(() => {});
          }
        } catch {}
        res.writeHead(upstreamRes.status, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        res.end(text);
        let tokensIn, tokensOut;
        try {
          const usage = JSON.parse(text).usage;
          tokensIn = usage?.prompt_tokens;
          tokensOut = usage?.completion_tokens;
        } catch {}
        selector.onSuccess(lease, { latencyMs: Date.now() - t0, tokensIn, tokensOut });
        ctx.logger?.info('聊天请求完成', {
          consumer: consumer.id,
          account: account.id,
          model: body.model,
          stream: false,
          attempted: attempts,
          elapsedMs: Date.now() - t0,
        });
        return;
      } catch (e) {
        lastFailure = e;
        const cls = selector.onFailure(lease, e);
        // 鉴权类失败：同账号刷新后已重试仍失败，直接排除该账号
        if (cls?.kind === 'auth' || cls?.kind === 'quota' || cls?.kind === 'rate-limit') {
          excludeAccounts.add(account.id);
        } else {
          excludeAccounts.add(account.id);
        }
        ctx.logger?.warn('本次尝试失败，准备切换账号', {
          account: account.id,
          kind: cls?.kind,
          error: String(e?.message || e).slice(0, 200),
          attempted: attempts,
        });
      } finally {
        lease.release();
      }
    }
    if (!res.headersSent) {
      ctx.alerts?.evaluate(ctx.pool, ctx.quota, { reason: 'chat_failure' }).catch(() => {});
      mapError(res, lastFailure || new PoolUnavailableError('无可用账号'));
    } else res.end();
  } finally {
    chatInFlight.total = Math.max(0, chatInFlight.total - 1);
    releaseConsumer();
  }
}

// 模型缓存（池内任意可用账号拉取即可）
const modelsCache = { at: 0, data: null };
/** modelproviders 目录缓存（models.dev 结构；10 分钟） */
const providersCache = { at: 0, data: null, error: null };
const PROVIDERS_TTL_MS = 10 * 60 * 1000;

/** 拉取/复用 modelproviders 目录，构建 modelId -> models.dev Model 映射 */
async function loadProviderCatalog(ctx, { force = false } = {}) {
  const { logger, selector, pool } = ctx;
  if (!force && providersCache.data && Date.now() - providersCache.at < PROVIDERS_TTL_MS) return providersCache.data;
  let lastErr = null;
  for (let attempt = 0; attempt < Math.min(2, Math.max(1, pool.list().length)); attempt++) {
    const { lease } = selector.select({ consumerId: 'providers' });
    if (!lease) break;
    try {
      const providers = await acquireUpstream(ctx, lease, (acc) => ctx.upstream.modelProviders(acc));
      const byModelId = new Map();
      const summary = [];
      for (const p of providers) {
        const value = p?.value && typeof p.value === 'object' ? p.value : null;
        const models = value?.models && typeof value.models === 'object' ? value.models : {};
        const count = Object.keys(models).length;
        summary.push({ id: p?.id ?? p?.name ?? '', name: p?.name ?? p?.id ?? '', models: count });
        for (const [modelId, model] of Object.entries(models)) {
          if (!byModelId.has(modelId)) byModelId.set(modelId, { ...model, provider: p?.name || p?.id || '' });
        }
      }
      providersCache.at = Date.now();
      providersCache.data = { providers: summary, byModelId, rawCount: providers.length };
      providersCache.error = null;
      logger?.info('modelproviders 目录已更新', { providers: summary.length, models: byModelId.size });
      return providersCache.data;
    } catch (e) {
      lastErr = e;
      logger?.warn('modelproviders 目录获取失败', { error: String(e?.message || e).slice(0, 200) });
      const cls = selector.onFailure(lease, e);
      if (cls?.kind === 'auth' || cls?.kind === 'quota' || cls?.kind === 'rate-limit') break;
    } finally {
      lease.release();
    }
  }
  providersCache.error = String(lastErr?.message || lastErr || 'unavailable');
  if (providersCache.data) return providersCache.data;
  return null;
}

function enrichModelsWithCatalog(models, catalog) {
  if (!catalog?.byModelId) return models;
  return models.map((m) => {
    const c = catalog.byModelId.get(m.id);
    if (!c) return m;
    return {
      ...m,
      meta: {
        ...m.meta,
        catalog: {
          provider: c.provider || null,
          family: c.family ?? null,
          status: c.status ?? null,
          releaseDate: c.release_date ?? c.releaseDate ?? null,
          cost: c.cost ?? null,
          limit: c.limit ?? null,
          modalities: c.modalities ?? null,
          reasoning: c.reasoning ?? null,
          attachment: c.attachment ?? null,
          toolCall: c.tool_call ?? c.toolCall ?? null,
          interleaved: c.interleaved ?? null,
        },
      },
    };
  });
}

async function ensureModels(ctx, { force = false } = {}) {
  const { pool, selector } = ctx;
  if (!force && modelsCache.data && Date.now() - modelsCache.at < 60000) return modelsCache.data;
  const exclude = new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < Math.min(2, Math.max(1, pool.list().length)); attempt++) {
    const { lease } = selector.select({ consumerId: 'models', excludeIds: exclude });
    if (!lease) break;
    try {
      const models = await acquireUpstream(ctx, lease, (acc) => ctx.upstream.models(acc));
      pool.rememberModels(models);
      let enriched = models;
      try {
        const catalog = await loadProviderCatalog(ctx, { force });
        enriched = enrichModelsWithCatalog(models, catalog);
      } catch (e) {
        ctx.logger?.debug('模型目录元数据合并失败（忽略）', { error: String(e?.message || e).slice(0, 200) });
      }
      modelsCache.at = Date.now();
      modelsCache.data = enriched;
      return enriched;
    } catch (e) {
      lastErr = e;
      const cls = selector.onFailure(lease, e);
      exclude.add(lease.account.id);
      ctx.logger?.warn('模型发现失败，切换账号重试', { account: lease.account.id, kind: cls?.kind });
    } finally {
      lease.release();
    }
  }
  throw lastErr || new PoolUnavailableError('无可用账号可拉取模型列表');
}

async function handleModels(ctx, req, res) {
  const force = /[?&](refresh|force)=1/.test(req.url || '');
  try {
    const data = await ensureModels(ctx, { force });
    return sendJson(res, 200, { object: 'list', data });
  } catch (e) {
    return mapError(res, e);
  }
}

async function handleQuota(ctx, req, res) {
  const { pool, quota } = ctx;
  const force = /[?&](refresh|force)=1/.test(req.url || '');
  const accounts = pool.list().filter((a) => a.enabled);
  const results = [];
  for (const account of accounts) {
    let snap = quota.get(account.id);
    const stale = !snap || Date.now() - (snap.fetchedAt || 0) > ctx.config.quota.maxAgeMs;
    if (force || stale) {
      if (quota.canProbe(account.id) || force) {
        try {
          await pool.probeQuota(account);
          snap = quota.get(account.id);
        } catch (e) {
          results.push({ id: account.id, label: account.label, error: String(e.message || e) });
          continue;
        }
      }
    }
    results.push({
      id: account.id,
      label: account.label,
      label2: account.email || undefined,
      userId: account.userId,
      enabled: account.enabled,
      health: account.health,
      headroom: quota.headroom(account.id),
      snapshot: snap || null,
    });
  }
  const headrooms = results.filter((r) => r.snapshot).map((r) => r.headroom);
  const body = {
    object: 'codefree.quota.pool',
    fetchedAt: Date.now(),
    pool: {
      accounts: results.length,
      bestHeadroom: headrooms.length ? Math.max(...headrooms) : null,
      exhausted: results.filter((r) => r.snapshot?.exhausted).length,
      cooling: pool.list().filter((a) => a.cooldownUntil > Date.now()).length,
    },
    accounts: results,
  };
  if (results.length === 1) {
    body.account = results[0].id;
    body.userId = results[0].userId;
    body.headroom = results[0].headroom;
    body.quotaStatus = results[0].snapshot?.quotaStatus;
    body.windows = results[0].snapshot?.windows || null;
  }
  sendJson(res, 200, body);
}

async function handleEmbeddings(ctx, req, res) {
  const { consumers, selector } = ctx;
  const consumer = consumers.identify(req);
  const releaseConsumer = consumers.acquire(consumer);
  try {
    const buf = await readRequestBody(req, ctx.config.server.maxBodyBytes);
    const body = JSON.parse(buf.toString('utf8') || '{}');
    const { lease } = selector.select({ consumerId: consumer.id, model: body.model || '' });
    if (!lease) throw new PoolUnavailableError('暂无可用账号');
    try {
      const upstreamRes = await acquireUpstream(ctx, lease, (acc) => ctx.upstream.embeddings(acc, body));
      const text = await upstreamRes.text();
      res.writeHead(upstreamRes.status, { 'Content-Type': upstreamRes.headers.get('content-type') || 'application/json' });
      res.end(text);
    } finally {
      lease.release();
    }
  } catch (e) {
    if (!res.headersSent) mapError(res, e);
    else res.end();
  } finally {
    releaseConsumer();
  }
}

// ---------------------------------------------------------------------------
// 管理面
// ---------------------------------------------------------------------------
function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** 定长哈希后比较，避免管理令牌比较产生时序侧信道。 */
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function requireAdmin(ctx, req) {
  const { config } = ctx;
  const token = config.server.adminToken || process.env[config.server.adminTokenEnv || 'CODEFREE_ADMIN_TOKEN'] || '';
  if (token) {
    const provided = String(req.headers['x-admin-token'] || '').trim();
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!safeEqual(provided, token) && !safeEqual(bearer, token)) {
      const err = new Error('管理接口需要 X-Admin-Token');
      err.status = 401;
      err.code = 'admin_unauthorized';
      err.type = 'invalid_request_error';
      throw err;
    }
    return true;
  }
  if (isLoopback(req)) return true;
  if (config.server.allowRemoteAdmin) return true;
  const err = new Error('未配置管理令牌时仅允许本机访问 /admin');
  err.status = 403;
  err.code = 'admin_forbidden';
  err.type = 'invalid_request_error';
  throw err;
}

async function handleAdmin(ctx, req, res, pathname) {
  const { pool, quota, selector, affinity, consumers, config } = ctx;
  requireAdmin(ctx, req);

  if (req.method === 'GET' && pathname === '/admin/health') {
    return handleHealth(ctx, req, res);
  }
  if (req.method === 'GET' && pathname === '/admin/metrics') {
    return writeMetrics(res, ctx);
  }
  if (req.method === 'GET' && pathname === '/admin/modelproviders') {
    const force = /[?&](refresh|force)=1/.test(req.url || '');
    const catalog = await loadProviderCatalog(ctx, { force });
    return sendJson(res, 200, {
      object: 'codefree.modelproviders',
      fetchedAt: providersCache.at || 0,
      error: providersCache.error,
      providers: catalog?.providers || [],
      models: catalog?.byModelId?.size || 0,
    });
  }
  if (req.method === 'GET' && pathname === '/admin/accounts') {
    return sendJson(res, 200, {
      object: 'codefree.accounts',
      fetchedAt: Date.now(),
      accounts: pool.snapshot().map((s) => ({ ...s, sessions: affinity.countByAccount(s.id) })),
    });
  }
  if (req.method === 'GET' && pathname === '/admin/quota') {
    const accounts = pool.list();
    return sendJson(res, 200, {
      object: 'codefree.quota.pool',
      fetchedAt: Date.now(),
      accounts: accounts.map((a) => ({
        id: a.id,
        label: a.label,
        headroom: quota.headroom(a.id),
        snapshot: quota.get(a.id) || null,
        probe: config.quota.probe.enabled,
      })),
    });
  }
  if (req.method === 'GET' && pathname === '/admin/usage') {
    return sendJson(res, 200, {
      object: 'codefree.usage',
      fetchedAt: Date.now(),
      accounts: pool.list().map((a) => ({
        id: a.id,
        stats: { ...a.stats },
        leases: a.leases,
        sessions: affinity.countByAccount(a.id),
        health: a.health,
        cooldownMsLeft: Math.max(0, a.cooldownUntil - Date.now()),
      })),
      consumers: consumers.snapshot(),
      chatInFlight: chatInFlight.total,
      stickySessions: affinity.size(),
      sessionsByAccount: affinity.countsByAccount(),
      modelsCachedAt: modelsCache.at || null,
    });
  }
  if (req.method === 'POST' && /^\/admin\/accounts\/[^/]+\/activate$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split('/')[3]);
    const account = pool.get(id);
    if (!account) return openAiError(res, 404, `账号不存在：${id}`, 'invalid_request_error', 'account_not_found');
    for (const a of pool.list()) a.preferred = a.id === id;
    ctx.logger?.info('已切换首选账号', { account: id });
    return sendJson(res, 200, { object: 'codefree.account', account: account.snapshot() });
  }
  if (req.method === 'POST' && /^\/admin\/accounts\/[^/]+\/refresh$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split('/')[3]);
    const account = pool.get(id);
    if (!account) return openAiError(res, 404, `账号不存在：${id}`, 'invalid_request_error', 'account_not_found');
    try {
      await pool.ensureFresh(account, { force: true });
      ctx.alerts?.evaluate(ctx.pool, ctx.quota, { reason: 'admin_refresh' }).catch(() => {});
      ctx.logger?.info('管理员强制刷新账号成功', { account: id });
      return sendJson(res, 200, { object: 'codefree.account', account: account.snapshot() });
    } catch (e) {
      ctx.logger?.warn('管理员强制刷新账号失败', { account: id, error: String(e?.message || e).slice(0, 200) });
      return mapError(res, e);
    }
  }
  if (req.method === 'POST' && /^\/admin\/accounts\/[^/]+\/cooldown$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split('/')[3]);
    const account = pool.get(id);
    if (!account) return openAiError(res, 404, `账号不存在：${id}`, 'invalid_request_error', 'account_not_found');
    let payload = {};
    try {
      payload = JSON.parse((await readRequestBody(req, 65536)).toString('utf8') || '{}');
    } catch {}
    const ms = Number(payload.ms || 60000);
    if (payload.clear) {
      pool.clearCooldown(account);
      account.health = account.health === 'auth-expired' ? account.health : 'ready';
    } else {
      pool.setCooldown(account, ms, payload.reason || 'admin');
    }
    return sendJson(res, 200, { object: 'codefree.account', account: account.snapshot() });
  }
  if (req.method === 'POST' && pathname === '/admin/quota/probe') {
    let payload = {};
    try {
      payload = JSON.parse((await readRequestBody(req, 65536)).toString('utf8') || '{}');
    } catch {}
    const targets = payload.accountId ? [pool.get(payload.accountId)].filter(Boolean) : pool.list().filter((a) => a.enabled);
    const out = [];
    for (const account of targets) {
      try {
        await pool.probeQuota(account);
        out.push({ id: account.id, ok: true, snapshot: quota.get(account.id) });
      } catch (e) {
        out.push({ id: account.id, ok: false, error: String(e.message || e) });
      }
    }
    return sendJson(res, 200, { object: 'codefree.quota.probe', results: out });
  }
  if (req.method === 'POST' && pathname === '/admin/import') {
    let payload = {};
    try {
      payload = JSON.parse((await readRequestBody(req, 65536)).toString('utf8') || '{}');
    } catch {}
    const file = payload.path;
    if (!file) return openAiError(res, 400, 'path is required', 'invalid_request_error', 'missing_path');
    const abs = path.resolve(config.__cwd, file);
    const cred = readAuthFile(abs, ctx.logger);
    if (!cred) return openAiError(res, 400, `无法读取凭据文件：${abs}`, 'invalid_request_error', 'invalid_auth_file');
    const id = payload.id || (cred.userId ? `u:${cred.userId}` : `f:${abs}`);
    if (pool.get(id)) return openAiError(res, 409, `账号已存在：${id}`, 'invalid_request_error', 'account_exists');
    const account = {
      id,
      label: payload.label || (cred.userId ? `CodeFree ${cred.userId}` : path.basename(abs)),
      email: payload.email || '',
      baseUrl: (cred.baseUrlSnapshot || config.upstream.baseUrl).replace(/\/+$/, ''),
      userId: cred.userId,
      clientId: cred.clientId || '',
      refreshTokenPresent: true,
    };
    // 复用 Account 实现：把导入文件注册为新账号
    const spec = {
      id,
      label: account.label,
      email: account.email,
      baseUrl: account.baseUrl,
      userId: account.userId,
      clientId: account.clientId,
      refreshToken: cred.refreshToken,
      refreshTokenExpiresAt: cred.refreshTokenExpiresAt,
      authFile: abs,
      writeBack: payload.writeBack || 'mirror',
      maxConcurrent: Number(payload.maxConcurrent ?? 3),
      priority: Number(payload.priority ?? 0),
      tags: ['imported'],
      enabled: payload.enabled !== false,
    };
    await pool.add(spec);
    ctx.logger?.info('已导入账号', { account: id, file: abs });
    return sendJson(res, 200, { object: 'codefree.account', account: pool.get(id).snapshot() });
  }
  if (req.method === 'GET' && pathname === '/admin/consumers') {
    return sendJson(res, 200, {
      object: 'codefree.consumers',
      enabled: consumers.enabled,
      consumers: consumers.snapshot(),
    });
  }
  if (req.method === 'POST' && pathname === '/admin/consumers') {
    let payload = {};
    try {
      payload = JSON.parse((await readRequestBody(req, 65536)).toString('utf8') || '{}');
    } catch {}
    const { consumer, key } = consumers.issue(payload);
    ctx.logger?.info('已发放消费者 Key', { consumer: consumer.id, name: consumer.name });
    return sendJson(res, 201, { object: 'codefree.consumer', consumer: consumers.redacted(consumer), key });
  }
  if (req.method === 'POST' && /^\/admin\/consumers\/[^/]+\/rotate$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split('/')[3]);
    const { consumer, key } = consumers.rotate(id);
    return sendJson(res, 200, { object: 'codefree.consumer', consumer: consumers.redacted(consumer), key });
  }
  if ((req.method === 'PATCH' || req.method === 'DELETE') && /^\/admin\/consumers\/[^/]+$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split('/')[3]);
    if (req.method === 'DELETE') {
      consumers.remove(id);
      return sendJson(res, 200, { object: 'codefree.consumer', deleted: id });
    }
    let payload = {};
    try {
      payload = JSON.parse((await readRequestBody(req, 65536)).toString('utf8') || '{}');
    } catch {}
    const consumer = consumers.patch(id, payload);
    return sendJson(res, 200, { object: 'codefree.consumer', consumer: consumers.redacted(consumer) });
  }
  if (req.method === 'POST' && pathname === '/admin/usage/save') {
    const ok = pool.saveStats({ consumers: consumers.exportTotals() });
    return sendJson(res, 200, { object: 'codefree.usage.saved', ok, file: path.join(config.stateDir, 'usage.json') });
  }
  if (req.method === 'POST' && pathname === '/admin/reload') {
    ctx.logger?.info('收到配置重载请求（新账号/额度配置在下次重启生效）');
    return sendJson(res, 200, { ok: true, note: '当前版本 reload 仅清理缓存；账号增删请重启或用 /admin/import' });
  }
  return openAiError(res, 404, `未知管理接口：${pathname}`, 'not_found_error', 'not_found');
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function runCheck(ctx) {
  const { pool, config } = ctx;
  const result = { configFile: config.__file || null, accounts: pool.list().length };
  const account = pool.list().find((a) => a.enabled) || pool.list()[0];
  if (!account) {
    console.log(JSON.stringify({ ...result, ok: false, error: '未找到可用账号（请检查 config.json / codefree.json）' }, null, 2));
    process.exitCode = 2;
    return;
  }
  try {
    await pool.ensureFresh(account, { force: true });
    result.auth = { account: account.id, userId: account.userId, tokenExpiresInSec: Math.round((account.accessTokenExpiresAt - Date.now()) / 1000) };
  } catch (e) {
    console.log(JSON.stringify({ ...result, ok: false, error: `${e.name}: ${e.message}` }, null, 2));
    process.exitCode = 3;
    return;
  }
  try {
    result.models = (await ctx.upstream.models(account)).map((m) => m.id);
  } catch (e) {
    result.modelsError = `${e.name}: ${e.message}`;
  }
  try {
    result.quota = summarizeQuota(await ctx.upstream.quota(account));
  } catch (e) {
    result.quotaError = `${e.name}: ${e.message}`;
  }
  result.ok = !result.modelsError;
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 4;
}

async function main() {
  const cfg = loadConfig({ cwd: process.cwd() });
  const logger = createLogger({ debug: cfg.server.debug });
  const ctx = buildRuntime(cfg, logger);
  ctx.config = cfg;
  ctx.logger = logger;

  const specs = resolveAccountSpecs(cfg, logger);
  if (specs.length === 0) {
    logger.warn('未发现任何账号（config.accounts 为空且 authfile 不存在），代理将以无账号状态启动', {
      authFile: cfg.imports.authfile.path,
    });
    // 占位：仍启动服务，方便 /health 与 /admin 排查
    const placeholder = {
      id: 'unconfigured',
      label: '未配置账号',
      baseUrl: cfg.upstream.baseUrl,
      refreshToken: '',
      writeBack: 'isolated',
      enabled: false,
    };
    await ctx.pool.load([placeholder]);
  } else {
    await ctx.pool.load(specs);
  }

  if (process.argv.includes('--check')) {
    await runCheck(ctx);
    return;
  }

  // 恢复历史用量统计（重启不丢）
  const loadedUsage = ctx.pool.loadStats();
  if (loadedUsage?.consumers) ctx.consumers.importTotals(loadedUsage.consumers);
  const startedAt = Date.now();
  ctx.startedAt = startedAt;

  if (cfg.refresh.startupWarmup) {
    await ctx.pool.warmup();
  }
  ctx.pool.startQuotaProbeLoop();

  const maintenance = setInterval(() => {
    ctx.affinity.sweep();
    const now = Date.now();
    for (const account of ctx.pool.list()) {
      if (account.cooldownUntil && account.cooldownUntil <= now && account.health === 'cooling') {
        account.health = 'ready';
        account.cooldownUntil = 0;
      }
    }
    // 自动尝试恢复 auth-expired / 凭据缺失账号（内部按 refresh.authRecoveryMs 节流）
    ctx.pool.recoverAuthExpired().catch(() => {});
  }, 15000);
  maintenance.unref?.();

  // 用量持久化（60s）与池级告警评估（30s）
  const persistTimer = setInterval(() => {
    ctx.pool.saveStats({ consumers: ctx.consumers.exportTotals() });
  }, 60000);
  persistTimer.unref?.();
  const alertTimer = setInterval(() => {
    ctx.alerts.evaluate(ctx.pool, ctx.quota, { reason: 'periodic' }).catch(() => {});
    ctx.alerts.maybeWarnRefreshExpiry(ctx.pool.list()).catch(() => {});
  }, 30000);
  alertTimer.unref?.();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const route = async () => {
      if (pathname === '/' || pathname === '/health') return handleHealth(ctx, req, res);
      if (req.method === 'GET' && pathname === '/v1/models') return handleModels(ctx, req, res);
      if (req.method === 'POST' && pathname === '/v1/chat/completions') return handleChat(ctx, req, res);
      if (req.method === 'POST' && pathname === '/v1/embeddings') return handleEmbeddings(ctx, req, res);
      if (req.method === 'GET' && pathname === '/v1/quota') return handleQuota(ctx, req, res);
      if (req.method === 'GET' && pathname === '/metrics') return handleMetrics(ctx, req, res);
      if (pathname.startsWith('/admin/')) return handleAdmin(ctx, req, res, pathname);
      return openAiError(res, 404, `Not found: ${pathname}`, 'not_found_error', 'not_found');
    };
    Promise.resolve(route()).catch((e) => {
      logger.error('未捕获异常', { path: pathname, error: String(e?.message || e) });
      if (!res.headersSent) mapError(res, e);
      else res.end();
    });
  });

  server.listen(cfg.server.port, cfg.server.host, () => {
    logger.info('CodeFree-O OpenAI 兼容代理已启动', {
      url: `http://${cfg.server.host}:${cfg.server.port}`,
      mode: ctx.pool.list().length > 1 ? 'pool' : 'single',
      upstream: cfg.upstream.baseUrl,
      version: cfg.upstream.version,
      accounts: ctx.pool.list().map((a) => ({ id: a.id, userId: a.userId, health: a.health })),
      configFile: cfg.__file || null,
      adminToken: cfg.server.adminToken || process.env[cfg.server.adminTokenEnv] ? 'configured' : 'loopback-only',
      alerts: cfg.alert.enabled && cfg.alert.webhookUrl ? `enabled(${cfg.alert.msgType || 'text'})` : 'disabled',
    });
  });

  const shutdown = () => {
    logger.info('收到退出信号，正在关闭');
    clearInterval(maintenance);
    clearInterval(persistTimer);
    clearInterval(alertTimer);
    try {
      ctx.pool.saveStats({ consumers: ctx.consumers.exportTotals() });
    } catch {}
    ctx.pool.stopQuotaProbeLoop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), cfg.server.shutdownTimeoutMs).unref();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
}

main().catch((e) => {
  console.error(JSON.stringify({ level: 'ERROR', msg: '启动失败', error: String(e?.message || e), stack: e?.stack }));
  process.exit(1);
});
