// 上游客户端：签名请求、token 刷新、模型发现、额度查询、聊天、向量
import { createHmac, randomUUID } from 'node:crypto';
import { normalizeTokenResponse } from './credentials.mjs';
import { AuthExpiredError, UpstreamError } from './util.mjs';

export class UnauthorizedError extends Error {
  constructor(message = 'upstream 401', body = '') {
    super(message);
    this.name = 'UnauthorizedError';
    this.status = 401;
    this.body = body;
  }
}

/** 客户端输出上限硬顶（对齐引擎 OUTPUT_TOKEN_MAX=32000；CodeFree 模型 limit.output=0 时请求恒为 32000） */
const OUTPUT_TOKEN_MAX = 32000;

export class UpstreamClient {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
  }

  signHeaders(method, appId) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const content = `${String(method).toUpperCase()}\n${appId}\n${timestamp}\n${nonce}`;
    const signature = createHmac('sha256', Buffer.from(this.config.upstream.signingSecret, 'base64'))
      .update(content)
      .digest('base64');
    return {
      'X-Cf-AppId': appId,
      'X-Cf-Timestamp': timestamp,
      'X-Cf-Nonce': nonce,
      'X-Cf-Signature': signature,
    };
  }

  /** 调用上游，自动附加签名头与 token；不处理 401 重试（交给调用方做 refresh+failover） */
  async request(account, relPath, { method = 'GET', body, headers = {}, timeoutMs, signal } = {}) {
    const appId = account.clientId || this.config.upstream.clientId;
    const finalHeaders = {
      'X-Cf-Token': account.accessToken,
      userId: account.userId || '0',
      projectId: '0',
      clientType: 'codefree-o',
      clientVersion: this.config.upstream.version,
      codefreeClient: this.config.upstream.clientTag,
      ...this.signHeaders(method, appId),
      ...headers,
    };
    const url = relPath.startsWith('http') ? relPath : `${account.baseUrl}${relPath}`;
    const userAgent = this.config.upstream.userAgent;
    if (userAgent && !finalHeaders['User-Agent'] && !finalHeaders['user-agent']) finalHeaders['User-Agent'] = userAgent;
    // 非流式：整请求超时；流式：由调用方传入 signal（首包 300s + 逐块空闲 300s，无总超时，对齐 App 语义）
    let timeoutController;
    let timeoutTimer;
    if (!signal) {
      timeoutController = new AbortController();
      timeoutTimer = setTimeout(
        () => timeoutController.abort(new Error('upstream request timeout')),
        timeoutMs || this.config.upstream.requestTimeoutMs,
      );
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
        signal: signal || timeoutController.signal,
      });
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
    if (res.status === 401) {
      const text = await res.text().catch(() => '');
      throw new UnauthorizedError('CodeFree 上游返回 401', text);
    }
    return res;
  }

  /** 刷新 token（refresh_x_cf_token）；轮换语义由调用方负责写回 */
  async refreshToken(account) {
    const params = new URLSearchParams({
      grant_type: 'refresh_x_cf_token',
      client_id: account.clientId || this.config.upstream.clientId,
      x_cf_refresh_token: account.refreshToken,
    });
    if (this.config.upstream.clientSecret) params.set('client_secret', this.config.upstream.clientSecret);

    let res;
    try {
      res = await fetch(`${account.baseUrl}/api/usercenterbackend/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: params,
        signal: AbortSignal.timeout(this.config.upstream.refreshTimeoutMs),
      });
    } catch (e) {
      throw new UpstreamError(`无法连接 CodeFree 认证服务：${e.message}`, 502, '', 'upstream_unreachable');
    }
    const text = await res.text();
    if (!res.ok) {
      const lower = text.toLowerCase();
      if (
        res.status === 400 || res.status === 401
          ? lower.includes('invalid_client') || lower.includes('incorrect_client_credentials') || lower.includes('invalid_grant')
          : false
      ) {
        throw new AuthExpiredError('CodeFree 登录已过期或 refresh token 已失效，请重新登录 CodeFree-O 客户端后重试', text.slice(0, 300));
      }
      throw new UpstreamError(`CodeFree 刷新 token 失败 ${res.status}: ${text.slice(0, 300)}`, res.status, text, 'refresh_failed');
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new UpstreamError('CodeFree 刷新 token 返回非 JSON', 502, text.slice(0, 300), 'refresh_bad_payload');
    }
    const tokens = normalizeTokenResponse(json, { userId: account.userId });
    if (!tokens) throw new UpstreamError('CodeFree token 响应缺少 x_cf_token/x_cf_refresh_token', 502, text.slice(0, 300), 'refresh_missing_token');
    return tokens;
  }

  async models(account) {
    const res = await this.request(
      account,
      `/api/acbackend/modelmgr/v1/clients/codefree-o/versions/${this.config.upstream.version}`,
      { headers: { Accept: 'application/json' } },
    );
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(`CodeFree 模型发现失败 HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text, 'model_discovery_failed');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new UpstreamError('CodeFree 模型发现返回非 JSON', 502, text.slice(0, 300), 'model_discovery_bad_payload');
    }
    if (json.optResult !== 0) {
      throw new UpstreamError(`CodeFree 模型发现失败：${json.msg || json.optResult}`, 502, text.slice(0, 300), 'model_discovery_failed');
    }
    return (json.data || []).map((m) => {
      const multimodal = m.modelType === 'multimodal';
      const contextWindow = Number(m.maxTotalTokens || m.maxTokens || 80000);
      const maxOutputTokens = Number(m.maxOutputTokens || 8000);
      return {
        id: m.modelName,
        object: 'model',
        created: 0,
        owned_by: 'codefree',
        meta: {
          displayName: m.displayName,
          modelType: m.modelType,
          maxTokens: m.maxTokens ?? m.maxTotalTokens,
          maxOutputTokens,
          accessMode: m.accessMode,
          // LEGACY 通道不受额度限制（官方 UI 隐藏额度横幅、视为无限）
          quotaExempt: m.accessMode === 'LEGACY',
          contextWindow,
          capabilities: {
            temperature: true,
            reasoning: true,
            toolCall: true,
            attachment: multimodal,
            vision: multimodal,
            interleaved: { field: 'reasoning_content' },
            input: { text: true, image: multimodal },
            output: { text: true },
          },
          // 引擎请求侧 max_tokens = min(limit.output, 32000) || 32000；CodeFree 恒 32000
          limit: { context: contextWindow, output: OUTPUT_TOKEN_MAX },
          upstreamMaxOutputTokens: maxOutputTokens,
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          status: 'active',
          releaseDate: '',
          family: '',
        },
      };
    });
  }

  /** 模型提供方目录（models.dev 结构 + 允许清单）；用于 /v1/models 元数据增强 */
  async modelProviders(account) {
    const res = await this.request(account, '/api/acbackend/modelproviders/v1/providers', {
      headers: { Accept: 'application/json', clientType: 'codefree-o' },
      timeoutMs: this.config.upstream.quotaTimeoutMs,
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(`CodeFree provider 目录获取失败 HTTP ${res.status}`, res.status, text.slice(0, 300), 'provider_catalog_failed');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new UpstreamError('CodeFree provider 目录返回非 JSON', 502, text.slice(0, 300), 'provider_catalog_bad_payload');
    }
    if (json.optResult !== undefined && json.optResult !== 0) {
      throw new UpstreamError(`CodeFree provider 目录失败：${json.msg || json.optResult}`, 502, text.slice(0, 300), 'provider_catalog_failed');
    }
    const raw = json.providers;
    const providerCount = Array.isArray(raw) ? raw.length : raw && typeof raw === 'object' ? Object.keys(raw).length : 0;
    if (providerCount === 0) {
      this.logger?.info('modelproviders 返回空目录', {
        jsonKeys: Object.keys(json || {}),
        sample: text.slice(0, 200),
      });
    }
    if (Array.isArray(raw)) return raw;
    // 兼容 providers 为 record（id -> Provider）的形态
    if (raw && typeof raw === 'object') {
      return Object.entries(raw).map(([id, value]) => ({
        id,
        name: value?.name || id,
        value,
      }));
    }
    return [];
  }

  async quota(account) {
    const res = await this.request(account, this.config.quota.endpoint, {
      headers: { Accept: 'application/json' },
      timeoutMs: this.config.upstream.quotaTimeoutMs,
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(`CodeFree 额度查询失败 ${res.status}: ${text.slice(0, 300)}`, res.status, text, 'quota_failed');
    try {
      return JSON.parse(text);
    } catch {
      throw new UpstreamError('CodeFree 额度查询返回非 JSON', 502, text.slice(0, 300), 'quota_bad_payload');
    }
  }

  async chat(account, body, { headers = {}, timeoutMs, signal } = {}) {
    return this.request(account, '/api/acbackend/codechat/v1/completions', {
      method: 'POST',
      body,
      headers,
      timeoutMs,
      signal,
    });
  }

  async embeddings(account, body) {
    return this.request(account, '/api/aebackend/codefree-embedding-svc/v1/text-to-embedding-vector', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
  }
}
