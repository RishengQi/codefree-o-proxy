// 通用工具：日志、错误类型、脱敏、哈希、请求体读取
import { createHash } from 'node:crypto';

export function createLogger({ debug = false } = {}) {  const log = (level, msg, fields = {}) => {
    const line = { ts: new Date().toISOString(), level, msg, ...fields };
    console.log(JSON.stringify(line));
  };
  return {
    info: (m, f) => log('INFO', m, f),
    warn: (m, f) => log('WARN', m, f),
    error: (m, f) => log('ERROR', m, f),
    debug: (m, f) => debug && log('DEBUG', m, f),
  };
}

export function redact(value, keep = 4) {
  if (typeof value !== 'string' || !value) return value;
  if (value.length <= keep * 2) return '***';
  return `${value.slice(0, keep)}…${value.slice(-keep)}(len=${value.length})`;
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function shortHash(value) {
  return sha256(value).slice(0, 12);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AuthExpiredError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.name = 'AuthExpiredError';
    this.authExpired = true;
    this.detail = detail;
  }
}

export class UpstreamError extends Error {
  constructor(message, status = 502, body = '', code = 'upstream_error') {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export class QuotaExhaustedError extends Error {
  constructor(info, label = '') {
    super(`CodeFree 额度已用尽${label ? `（${label}）` : ''}${info?.periods?.length ? ` [${info.periods.join('/')}]` : ''}`);
    this.name = 'QuotaExhaustedError';
    this.quota = true;
    this.info = info || {};
  }
}

export class PoolUnavailableError extends Error {
  constructor(message, reason = 'pool_unavailable') {
    super(message);
    this.name = 'PoolUnavailableError';
    this.reason = reason;
    this.status = 503;
  }
}

export class ModelNotFoundError extends Error {
  constructor(model) {
    super(`模型不存在：${model}`);
    this.name = 'ModelNotFoundError';
    this.model = model;
    this.status = 404;
  }
}

export class ConsumerRateLimitError extends Error {
  constructor(message, scope = 'key') {
    super(message);
    this.name = 'ConsumerRateLimitError';
    this.scope = scope;
    this.status = 429;
  }
}

export function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj, extraHeaders = {}) {
  const buf = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(buf),
    ...extraHeaders,
  });
  res.end(buf);
}

export function openAiError(res, status, message, type, code, extra = {}) {
  sendJson(res, status, { error: { message, type, code, ...extra } });
}

export function nowIso(ts = Date.now()) {
  return new Date(ts).toISOString();
}

// 幂等的 JSON 深合并（数组整体覆盖）
export function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (base && typeof base === 'object' && patch && typeof patch === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return patch === undefined ? base : patch;
}


/** 解析上游 Retry-After 相关头，返回毫秒（0 表示无有效值；上限 6 小时） */
export function parseRetryAfterMs(headers) {
  const pick = (name) => {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') {
      const v = headers.get(name);
      if (v != null) return v;
    }
    const lower = String(name).toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (String(k).toLowerCase() === lower && v != null) return v;
    }
    return undefined;
  };
  const cap = (ms) => (Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), 6 * 3600_000) : 0);
  const msHeader = Number(pick('retry-after-ms'));
  if (Number.isFinite(msHeader) && msHeader > 0) return cap(msHeader);
  const retryAfter = pick('retry-after');
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return cap(seconds * 1000);
    const at = Date.parse(String(retryAfter));
    if (!Number.isNaN(at)) return cap(at - Date.now());
  }
  for (const name of ['x-ratelimit-reset-after', 'ratelimit-reset-after']) {
    const seconds = Number(pick(name));
    if (Number.isFinite(seconds) && seconds > 0) return cap(seconds * 1000);
  }
  for (const name of ['x-ratelimit-reset', 'ratelimit-reset']) {
    const raw = pick(name);
    if (raw === undefined) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds > 1e6 ? cap(seconds - Date.now()) : cap(seconds * 1000);
    }
    const at = Date.parse(String(raw));
    if (!Number.isNaN(at)) return cap(at - Date.now());
  }
  return 0;
}
