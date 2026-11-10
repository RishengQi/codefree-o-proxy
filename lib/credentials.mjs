// 凭据文件与 journal：CodeFree-O codefree.json v2（AES-256-GCM 加密 refresh token）读写
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nowIso, shortHash } from './util.mjs';

export const ENCRYPT_KEY_STR = 'codefree-o-refresh-token-local-encryption-key-v1';
const ENCRYPT_KEY = createHash('sha256').update(ENCRYPT_KEY_STR).digest();

export function encryptRefreshToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ENCRYPT_KEY, iv);
  const enc = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${enc.toString('base64')}:${tag.toString('base64')}`;
}

export function decryptRefreshToken(encoded) {
  const [ver, ivB64, ctB64, tagB64] = String(encoded).split(':');
  if (ver !== 'v1' || !ivB64 || !ctB64 || !tagB64) throw new Error('invalid encrypted refresh token format');
  const decipher = createDecipheriv('aes-256-gcm', ENCRYPT_KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** 读取 codefree.json（v2：加密或明文均可），返回规范化的凭据对象 */
export function readAuthFile(file, logger) {
  if (!file || !existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    logger?.warn('凭据文件不是合法 JSON', { file, error: e.message });
    return null;
  }
  const base = {
    file,
    version: raw.version ?? 2,
    refreshTokenExpiresAt: Number(raw.refreshCfTokenExpiresAt || 0),
    userId: raw.userId ? String(raw.userId) : '',
    clientId: raw.clientId || '',
    baseUrlSnapshot: raw.baseUrlSnapshot || '',
    raw,
    revision: shortHash(JSON.stringify({ e: raw.encryptedRefreshCfToken || raw.refreshCfToken, t: raw.refreshCfTokenExpiresAt })),
  };
  if (raw.encryptedRefreshCfToken) {
    try {
      return { ...base, refreshToken: decryptRefreshToken(raw.encryptedRefreshCfToken), encrypted: true };
    } catch (e) {
      logger?.warn('refresh token 解密失败', { file, error: e.message });
      return null;
    }
  }
  if (raw.refreshCfToken) return { ...base, refreshToken: String(raw.refreshCfToken), encrypted: false };
  return null;
}

/**
 * 原子写回凭据文件（与桌面端 v2 persistable 格式对齐）。
 * 保留未知字段；首次写回前备份；tmp + rename 原子替换。
 */
export function writeAuthFileAtomic(file, cred, { logger, backup = true } = {}) {
  if (!file) return;
  let current = {};
  try {
    if (existsSync(file)) current = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    current = {};
  }
  if (backup && (!existsSync(file) || !current.encryptedRefreshCfToken)) {
    const bak = `${file}.bak.proxy.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      if (existsSync(file)) copyFileSync(file, bak);
      logger?.info?.('已备份凭据文件', { from: file, to: bak });
    } catch (e) {
      logger?.warn?.('备份凭据文件失败（忽略）', { file, error: e.message });
    }
  }
  const next = { ...current };
  next.version = 2;
  next.encryptedRefreshCfToken = encryptRefreshToken(cred.refreshToken);
  next.refreshCfTokenExpiresAt = Number(cred.refreshTokenExpiresAt || 0);
  if (cred.userId) next.userId = String(cred.userId);
  const snapshot = cred.baseUrlSnapshot || current.baseUrlSnapshot || '';
  if (snapshot) next.baseUrlSnapshot = snapshot;
  delete next.refreshCfToken;
  delete next.accessToken;

  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  logger?.debug?.('凭据文件已写回', { file });
}

/** 从刷新响应中解析 token 字段（兼容 x_cf_* 与 OAuth 命名） */
export function normalizeTokenResponse(json, fallback = {}) {
  const accessToken = json.x_cf_token || json.cf_token || (json.token_type === 'cf_token' ? json.access_token : '');
  const refreshToken = json.x_cf_refresh_token || json.refresh_token || json.refresh_cf_token || '';
  if (!accessToken || !refreshToken) return null;
  const expiresIn = positiveSeconds(
    json.x_cf_token_expires_in ?? json.cf_token_expires_in ?? json.expires_in,
    7200,
  );
  const refreshExpiresIn = positiveSeconds(
    json.x_cf_refresh_token_expires_in ?? json.refresh_token_expires_in ?? json.refresh_cf_token_expires_in,
    604800,
  );
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: Date.now() + expiresIn * 1000,
    refreshTokenExpiresAt: Date.now() + refreshExpiresIn * 1000,
    userId: String(json.id ?? json.user_id ?? json.uid ?? json.userId ?? fallback.userId ?? ''),
  };
}

function positiveSeconds(v, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 解析 refreshTokenRef：{ env } / { file } / { value } */
export function resolveRefreshTokenRef(ref, { cwd = process.cwd(), env = process.env } = {}) {
  if (!ref) return '';
  if (typeof ref === 'string') return ref;
  if (ref.value) return String(ref.value);
  if (ref.env && env[ref.env]) return String(env[ref.env]).trim();
  if (ref.file) {
    try {
      return readFileSync(path.resolve(cwd, ref.file), 'utf8').trim();
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * 刷新 journal：先记 refresh_start，再记 refresh_ok/refresh_fail。
 * 崩溃恢复时凭最后一个 start 与文件内 token 对比判定是否已由他方完成轮换。
 */
export class Journal {
  constructor({ file, enabled = true, logger } = {}) {
    this.file = file;
    this.enabled = enabled !== false;
    this.logger = logger;
  }

  append(entry) {
    if (!this.enabled || !this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify({ ts: nowIso(), ...entry }) + '\n', { mode: 0o600 });
    } catch (e) {
      this.logger?.warn?.('写 journal 失败（忽略）', { error: e.message });
    }
  }

  readAll(limit = 5000) {
    if (!this.file || !existsSync(this.file)) return [];
    try {
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 每个账号最后一条记录（用于崩溃恢复） */
  lastByAccount() {
    const out = new Map();
    for (const e of this.readAll()) {
      if (e.accountId) out.set(e.accountId, e);
    }
    return out;
  }
}
