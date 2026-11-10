// 可编程 Mock 上游：模拟 srdcloud CodeFree 的 OAuth / 模型 / 额度 / 聊天接口，
// 用于在没有第二个真实账号的情况下回归多账号池逻辑。
import http from 'node:http';

const MODEL_LIST = {
  optResult: 0,
  data: [
    { modelName: 'GLM-5.2', displayName: 'GLM-5.2', modelType: 'chat', maxTokens: 184000, maxOutputTokens: 16000 },
    { modelName: 'Qwen3.8-27B', displayName: 'Qwen3.8-27B（多模态）', modelType: 'multimodal', maxTokens: 200000, maxOutputTokens: 16000 },
    { modelName: 'Legacy-Free', displayName: 'Legacy Free（免额度）', modelType: 'chat', maxTokens: 128000, maxOutputTokens: 16000, accessMode: 'LEGACY' },
  ],
};

/**
 * 启动 mock 上游。
 * accounts: { [accountKey]: { accessToken, userId, fiveHour, sevenDay, chat, quotaStatus } }
 *   chat: 'ok' | '429' | '401' | '500'
 * refresh token 轮换：初始 refresh token 即 accountKey，轮换后生成别名指向同一账号对象，
 * 因此通过 /__control 按 accountKey 修改行为对轮换后的 token 同样生效。
 */
export function startMockUpstream({ accounts } = {}) {
  const state = {
    accounts: {},
    aliases: new Map(), // rotated refresh token -> account object
    accessToAccount: new Map(), // access token -> account object
    requests: [],
  };
  for (const [key, value] of Object.entries(accounts || {})) {
    const account = { accountKey: key, accessToken: `tok-${key}`, userId: '10001', ...value };
    state.accounts[key] = account;
  }

  const resolveRefresh = (token) => state.accounts[token] || state.aliases.get(token) || null;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = req.headers['x-cf-token'];
    const account = token ? state.accessToAccount.get(token) : null;
    const entry = {
      method: req.method,
      path: url.pathname,
      account: account?.accountKey,
      headers: {
        token,
        userId: req.headers.userid,
        appId: req.headers['x-cf-appid'],
        signature: Boolean(req.headers['x-cf-signature']),
        clientVersion: req.headers.clientversion,
        subService: req.headers.subservice,
        userAgent: req.headers['user-agent'],
        sessionId: req.headers.sessionid,
        parentSessionId: req.headers['x-parent-session-id'],
      },
      body: body ? safeJson(body) : undefined,
      at: Date.now(),
    };
    state.requests.push(entry);

    const send = (status, obj, headers = {}) => {
      const buf = typeof obj === 'string' ? obj : JSON.stringify(obj);
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(buf);
    };

    // 控制面：设置 mock 行为
    if (url.pathname === '/__control') {
      const patch = safeJson(body) || {};
      if (patch.accounts) {
        for (const [key, value] of Object.entries(patch.accounts)) {
          const target = state.accounts[key] || state.aliases.get(key);
          if (target) Object.assign(target, value);
          else {
            const created = { accountKey: key, accessToken: `tok-${key}`, userId: '10001', ...value };
            state.accounts[key] = created;
          }
        }
      }
      if (patch.resetLogs) state.requests = [];
      return send(200, { ok: true, accounts: Object.keys(state.accounts) });
    }
    if (url.pathname === '/__requests') return send(200, { requests: state.requests });

    // OAuth 刷新（refresh token 轮换）
    if (url.pathname === '/api/usercenterbackend/oauth/access_token' && req.method === 'POST') {
      const params = new URLSearchParams(body);
      const refresh = params.get('x_cf_refresh_token');
      const acc = resolveRefresh(refresh);
      if (!acc) return send(400, { error: 'invalid_grant', error_description: 'invalid refresh token' });
      const accessToken = acc.accessToken;
      state.accessToAccount.set(accessToken, acc);
      acc.rotate = (acc.rotate || 0) + 1;
      const rotated = `${acc.accountKey}-r${acc.rotate}`;
      state.aliases.set(rotated, acc);
      return send(200, {
        x_cf_token: accessToken,
        x_cf_refresh_token: rotated,
        x_cf_token_expires_in: acc.expiresIn ?? 1800,
        x_cf_refresh_token_expires_in: 604800,
        id: acc.userId || '10001',
      });
    }

    // 模型发现
    if (url.pathname.startsWith('/api/acbackend/modelmgr/v1/clients/codefree-o/versions/')) {
      if (!req.headers['x-cf-signature']) return send(401, { error: 'missing signature' });
      return send(200, MODEL_LIST);
    }

    // 模型提供方目录（models.dev 结构）
    if (url.pathname === '/api/acbackend/modelproviders/v1/providers') {
      if (!req.headers['x-cf-signature']) return send(401, { error: 'missing signature' });
      return send(200, {
        optResult: 0,
        providers: [
          {
            name: 'codefree',
            id: 'codefree',
            value: {
              models: {
                'GLM-5.2': {
                  id: 'GLM-5.2',
                  name: 'GLM-5.2',
                  family: 'glm',
                  release_date: '2026-01-01',
                  reasoning: true,
                  attachment: false,
                  temperature: true,
                  tool_call: true,
                  interleaved: { field: 'reasoning_content' },
                  cost: { input: 1, output: 2 },
                  limit: { context: 200000, output: 32000 },
                  modalities: { input: ['text'], output: ['text'] },
                  status: 'active',
                },
              },
            },
          },
        ],
      });
    }

    // 额度
    if (url.pathname === '/api/aebackend/quota/v1/me') {
      const acc = account || {};
      if (acc.quotaStatus === '401') return send(401, { code: 'CODEFREE_AUTH_REQUIRED' });
      return send(200, {
        level: { level: 'L3', displayName: 'L3' },
        vip: acc.vip ?? false,
        quotaStatus: acc.quotaStatus || 'ACTIVE',
        statusReason: acc.statusReason !== undefined ? acc.statusReason : null,
        fiveHour: acc.fiveHour === null ? null : acc.fiveHour ?? { usagePercent: 10, used: 10, limit: 100, resetAt: Date.now() + 3600_000 },
        sevenDay: acc.sevenDay === null ? null : acc.sevenDay ?? { usagePercent: 20, used: 200, limit: 1000, resetAt: Date.now() + 86400_000 },
        quotaWorkTime: { timeZone: 'Asia/Shanghai', startTime: '08:30', endTime: '17:30' },
        gradingPending: false,
        canUpgrade: false,
      });
    }

    // 聊天
    if (url.pathname === '/api/acbackend/codechat/v1/completions' && req.method === 'POST') {
      const acc = account || {};
      const mode = acc.chat || 'ok';
      if (mode === '401') return send(401, { error: 'unauthorized' });
      if (mode === '500') return send(500, { error: 'internal' });
      if (mode === '429-retry') {
        return send(429, { error: 'rate limited' }, { 'Retry-After': '120' });
      }
      if (mode === '429' || mode === 'quota') {
        return send(429, {
          code: 'AI_QUOTA_EXHAUSTED',
          periods: ['5H'],
          exhaustedMask: 1,
          used: 100,
          limit: 100,
          resetAt: Date.now() + 60_000,
          retryAt: Date.now() + 60_000,
        });
      }
      const reqBody = safeJson(body) || {};
      const model = reqBody.model || 'GLM-5.2';
      const stream = reqBody.stream === true;
      if (stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const id = `chatcmpl-mock-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const chunk = (delta, finish = '') =>
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        if (mode === 'stream-stall') {
          // 只发首帧后挂起，用于验证代理的 SSE 空闲超时
          res.write(chunk({ role: 'assistant', content: '收到' }));
          return;
        }
        if (mode === 'stream-quota') {
          res.write(chunk({ role: 'assistant', content: '收到' }));
          res.write(
            `data: ${JSON.stringify({ code: 'AI_QUOTA_EXHAUSTED', periods: ['5H'], resetAt: Date.now() + 120_000 })}\n\n`,
          );
          return; // 不主动结束：代理应检测到耗尽并自行取消
        }
        if (mode === 'stream-error') {
          res.write(chunk({ role: 'assistant', content: '收到' }));
          res.write(
            `data: ${JSON.stringify({ error: { message: 'context length exceeded', code: 'context_length_exceeded', type: 'invalid_request_error' } })}\n\n`,
          );
          return res.end();
        }
        res.write(chunk({ role: 'assistant', content: '收到' }));
        res.write(chunk({}, 'stop'));
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return send(200, {
        id: `chatcmpl-mock-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: '收到' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      });
    }

    return send(404, { error: `mock: no route ${url.pathname}` });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        server,
        port,
        baseUrl,
        state,
        control: async (patch) => {
          const r = await fetch(`${baseUrl}/__control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
          return r.json();
        },
        requests: () => state.requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text || undefined;
  }
}
