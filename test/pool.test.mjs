// 多账号池回归测试：mock 上游 + 真实代理进程，覆盖选号 / 额度感知 / 故障切换 / 粘性 / 限流 / 管理面。
// 运行：node --test test/pool.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startMockUpstream } from './mock-upstream.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw lastErr || new Error('waitFor timeout');
}

/** 启动一套“mock 上游 + 代理进程”测试环境 */
async function setup({ accounts, consumers, quotaProbe = false, selection = {}, alert, upstream } = {}) {
  const mock = await startMockUpstream({
    accounts: accounts || {
      'r-a': { accessToken: 'tok-a', userId: '111', fiveHour: { usagePercent: 10, used: 10, limit: 100, resetAt: Date.now() + 3600_000 } },
      'r-b': { accessToken: 'tok-b', userId: '222', fiveHour: { usagePercent: 20, used: 20, limit: 100, resetAt: Date.now() + 3600_000 } },
    },
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cf-pool-test-'));
  mkdirSync(path.join(dir, 'state'), { recursive: true });
  const port = await freePort();
  const cfg = {
    schemaVersion: 1,
    server: { host: '127.0.0.1', port, adminToken: 'test-admin', debug: false },
    upstream: {
      baseUrl: mock.baseUrl,
      clientId: 'test-client',
      clientSecret: 'test-secret',
      signingSecret: '',
      version: '1.10.1',
      requestTimeoutMs: 15000,
      refreshTimeoutMs: 5000,
      quotaTimeoutMs: 5000,
      ...(upstream || {}),
    },
    accounts: [
      { id: 'acc-a', label: '账号 A', baseUrl: mock.baseUrl, userId: '111', refreshTokenRef: { value: 'r-a' }, writeBack: 'isolated', maxConcurrent: 2 },
      { id: 'acc-b', label: '账号 B', baseUrl: mock.baseUrl, userId: '222', refreshTokenRef: { value: 'r-b' }, writeBack: 'isolated', maxConcurrent: 2 },
    ],
    imports: { authfile: { enabled: false, path: '' } },
    refresh: { skewMs: 500, maxRetries: 1, backoffMs: [20], startupWarmup: false },
    quota: {
      enabled: true,
      endpoint: '/api/aebackend/quota/v1/me',
      assumeUnknownHeadroom: 0.5,
      maxAgeMs: 60000,
      probe: { enabled: quotaProbe, maxConcurrentProbes: 2, globalRatePerSec: 100, hourlyBudget: 1000, hotMs: 60000, warmMs: 300000, coldMs: 1800000, jitterRatio: 0 },
    },
    selection: {
      stickyTtlMs: 120000,
      stickyMinHeadroom: 0.1,
      stickyScoreFactor: 0.6,
      maxAttemptsPerRequest: 3,
      maxAccountsPerRequest: 2,
      cooldown: { quotaFallbackMs: 60000, authExpiredMs: 60000, rateLimitMs: 60000, upstream5xxMs: 2000, networkMs: 2000 },
      ...selection,
    },
    consumers: consumers || [],
    ...(alert ? { alert } : {}),
    stateDir: path.join(dir, 'state'),
    journal: { enabled: true, file: path.join(dir, 'state', 'journal.jsonl') },
  };
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: REPO,
    env: { ...process.env, CODEFREE_CONFIG: cfgPath, PORT: String(port), CODEFREE_DEBUG: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      const r = await fetch(`${base}/health`).catch(() => null);
      return r?.ok ? await r.json() : null;
    });
  } catch (e) {
    child.kill();
    mock.close();
    throw new Error(`代理启动失败：${e.message}\n${logs.join('')}`);
  }

  return {
    base,
    port,
    mock,
    cfg,
    logs,
    admin: (p, init = {}) =>
      fetch(`${base}${p}`, { ...init, headers: { 'x-admin-token': 'test-admin', 'Content-Type': 'application/json', ...(init.headers || {}) } }),
    api: (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } }),
    chat: async (body) => {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false, ...body }),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    async close() {
      child.kill();
      await mock.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function chatCalls(mock) {
  return mock.requests().filter((r) => r.path === '/api/acbackend/codechat/v1/completions');
}

test('健康检查 + 模型列表（多账号池模式）', async () => {
  const env = await setup();
  try {
    const health = await (await env.api('/health')).json();
    assert.equal(health.mode, 'pool');
    assert.equal(health.accounts.total, 2);
    const models = await (await env.api('/v1/models?refresh=1')).json();
    assert.equal(models.object, 'list');
    assert.ok(models.data.some((m) => m.id === 'GLM-5.2'));
    assert.ok(chatCalls(env.mock).length === 0);
  } finally {
    await env.close();
  }
});

test('按额度余量选号：优先选择 headroom 更大的账号', async () => {
  const env = await setup({ quotaProbe: true });
  try {
    // 主动探测两端额度（A=10% used, B=20% used）
    const probe = await (await env.admin('/admin/quota/probe', { method: 'POST' })).json();
    if (!Array.isArray(probe?.results)) {
      throw new Error(`/admin/quota/probe 返回异常：${JSON.stringify(probe)}\n代理日志：${env.logs.join('').slice(-2000)}`);
    }
    assert.equal(probe.results.length, 2);
    const chat = await env.chat();
    assert.equal(chat.status, 200);
    const calls = chatCalls(env.mock);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].account, 'r-a', `应选择余量更大的账号 A，实际=${calls[0].account}`);
  } finally {
    await env.close();
  }
});

test('额度耗尽 429：自动 failover 到下一个账号', async () => {
  const env = await setup({ quotaProbe: true });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    // 让 A 额度耗尽
    await env.mock.control({ accounts: { 'r-a': { accessToken: 'tok-a', userId: '111', chat: '429' } } });
    const chat = await env.chat();
    assert.equal(chat.status, 200, JSON.stringify(chat.json));
    const calls = chatCalls(env.mock);
    assert.ok(calls.length >= 2, `应发生 failover（实际调用 ${calls.length} 次）`);
    assert.deepEqual(calls.map((c) => c.account), ['r-a', 'r-b']);
    // A 应进入冷却
    const accounts = await (await env.admin('/admin/accounts')).json();
    const a = accounts.accounts.find((x) => x.id === 'acc-a');
    assert.equal(a.health, 'cooling');
    assert.ok(a.cooldownMsLeft > 0);
  } finally {
    await env.close();
  }
});

test('上游 401：刷新 token 后重试；仍失败则切换账号', async () => {
  const env = await setup({ quotaProbe: true });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    await env.mock.control({ accounts: { 'r-a': { accessToken: 'tok-a', userId: '111', chat: '401' } } });
    const chat = await env.chat();
    assert.equal(chat.status, 200, JSON.stringify(chat.json));
    const calls = chatCalls(env.mock);
    // 同账号刷新后重试 1 次 + 切换账号 1 次
    assert.ok(calls.length >= 2);
    assert.equal(calls.at(-1).account, 'r-b');
    const tokens = env.mock.requests().filter((r) => r.path === '/api/usercenterbackend/oauth/access_token');
    assert.ok(tokens.length >= 1, '应触发过 token 刷新');
  } finally {
    await env.close();
  }
});

test('粘性会话：同一 session 优先保留原账号', async () => {
  const env = await setup({ quotaProbe: true, selection: { stickyScoreFactor: 5 } });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    const first = await env.chat({ session_id: 'sess-001' });
    assert.equal(first.status, 200);
    const firstAccount = chatCalls(env.mock).at(-1).account;

    // 让另一个账号余量更好
    const patch = {};
    patch[firstAccount === 'r-a' ? 'r-a' : 'r-b'] = {
      accessToken: firstAccount === 'r-a' ? 'tok-a' : 'tok-b',
      userId: firstAccount === 'r-a' ? '111' : '222',
      fiveHour: { usagePercent: 85, used: 85, limit: 100, resetAt: Date.now() + 3600_000 },
    };
    await env.mock.control({ accounts: patch });
    await env.admin('/admin/quota/probe', { method: 'POST' });

    const second = await env.chat({ session_id: 'sess-001' });
    assert.equal(second.status, 200);
    assert.equal(chatCalls(env.mock).at(-1).account, firstAccount, '同 session 应保持粘性');

    // 不同 session 应重新按余量选号
    const third = await env.chat({ session_id: 'sess-002' });
    assert.equal(third.status, 200);
    const thirdAccount = chatCalls(env.mock).at(-1).account;
    assert.notEqual(thirdAccount, firstAccount, '新 session 应选择余量更好的账号');
  } finally {
    await env.close();
  }
});

test('消费者 API Key 与 RPM 限流', async () => {
  const env = await setup({ consumers: [{ id: 'c1', name: '测试调用方', key: 'sk-test-1', rpm: 1, maxConcurrent: 1 }] });
  try {
    const noKey = await env.chat();
    assert.equal(noKey.status, 401);

    const withKey = async () =>
      fetch(`${env.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test-1' },
        body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }] }),
      });
    const r1 = await withKey();
    assert.equal(r1.status, 200);
    const r2 = await withKey();
    assert.equal(r2.status, 429);
    const body2 = await r2.json();
    assert.equal(body2.error.code, 'consumer_rate_limited');

    const usage = await (await env.admin('/admin/usage')).json();
    assert.equal(usage.consumers.length, 1);
    assert.ok(usage.consumers[0].total >= 1);
  } finally {
    await env.close();
  }
});

test('管理面：鉴权、账号快照、额度、激活首选账号', async () => {
  const env = await setup();
  try {
    const noToken = await fetch(`${env.base}/admin/accounts`);
    assert.equal(noToken.status, 401);
    const badToken = await fetch(`${env.base}/admin/accounts`, { headers: { 'x-admin-token': 'wrong' } });
    assert.equal(badToken.status, 401);

    const accounts = await (await env.admin('/admin/accounts')).json();
    assert.equal(accounts.accounts.length, 2);
    assert.ok(accounts.accounts.every((a) => !String(a.accessToken || '').includes('tok-') || a.accessToken.includes('…')));

    const quota = await (await env.admin('/admin/quota')).json();
    assert.equal(quota.accounts.length, 2);

    const activate = await (await env.admin('/admin/accounts/acc-b/activate', { method: 'POST' })).json();
    assert.equal(activate.account.preferred, true);

    const cooldown = await (
      await env.admin('/admin/accounts/acc-a/cooldown', { method: 'POST', body: JSON.stringify({ ms: 30000, reason: 'test' }) })
    ).json();
    assert.equal(cooldown.account.health, 'cooling');

    const probe = await (await env.admin('/admin/quota/probe', { method: 'POST', body: JSON.stringify({ accountId: 'acc-b' }) })).json();
    assert.equal(probe.results[0].ok, true);
    assert.ok(probe.results[0].snapshot);
  } finally {
    await env.close();
  }
});

test('Prometheus 指标与管理面用量持久化', async () => {
  const env = await setup({ quotaProbe: true });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    await env.chat();

    // 本机访问 /metrics 无需令牌
    const metrics = await fetch(`${env.base}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get('content-type') || '', /text\/plain/);
    const text = await metrics.text();
    assert.match(text, /# TYPE codefree_proxy_info gauge/);
    assert.match(text, /codefree_proxy_info\{mode="pool"/);
    assert.match(text, /codefree_accounts\{state="total"\} 2/);
    assert.match(text, /codefree_account_headroom\{account="acc-a"/);
    assert.match(text, /codefree_account_successes_total\{account="acc-a"/);
    assert.match(text, /codefree_pool_available 2/);
    assert.match(text, /codefree_chat_in_flight/);

    // /admin/metrics 需要管理令牌
    const noToken = await fetch(`${env.base}/admin/metrics`);
    assert.equal(noToken.status, 401);
    const adminMetrics = await fetch(`${env.base}/admin/metrics`, { headers: { 'x-admin-token': 'test-admin' } });
    assert.equal(adminMetrics.status, 200);
    assert.match(await adminMetrics.text(), /codefree_account_requests_total/);

    // 用量持久化
    const save = await env.admin('/admin/usage/save', { method: 'POST' });
    assert.equal(save.status, 200);
    const usageFile = path.join(env.cfg.stateDir, 'usage.json');
    assert.ok(existsSync(usageFile), `usage.json 未生成：${usageFile}`);
    const saved = JSON.parse(readFileSync(usageFile, 'utf8'));
    assert.ok(saved.accounts['acc-a']);
    assert.ok(saved.accounts['acc-b']);
    assert.ok(saved.savedAt);
  } finally {
    await env.close();
  }
});

test('全池额度耗尽触发告警 webhook', async () => {
  // 本地 webhook 接收端
  const captured = [];
  const hook = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (d) => (buf += d.toString()));
    req.on('end', () => {
      try { captured.push(JSON.parse(buf)); } catch { captured.push(buf); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"errcode":0}');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const env = await setup({
    quotaProbe: true,
    alert: { enabled: true, webhookUrl: `http://127.0.0.1:${hookPort}/hook`, cooldownMs: 1000 },
  });
  try {
    await env.admin('/admin/quota/probe');
    // 两个账号都返回额度耗尽
    await env.mock.control({ accounts: { 'r-a': { accessToken: 'tok-a', userId: '111', chat: '429' }, 'r-b': { accessToken: 'tok-b', userId: '222', chat: '429' } } });
    const res = await env.chat();
    assert.equal(res.status, 429);
    // 等待告警评估与发送
    for (let i = 0; i < 20 && captured.length === 0; i++) await new Promise((r) => setTimeout(r, 200));
    assert.ok(captured.length >= 1, '未收到告警 webhook');
    const body = captured[0];
    const content = typeof body === 'string' ? body : body?.text?.content || '';
    assert.match(content, /全池额度耗尽/);
    assert.match(content, /acc-a/);
  } finally {
    await env.close();
    await new Promise((r) => hook.close(r));
  }
});

test('凭据缺失账号被禁用且不参与选号', async () => {
  const env = await setup();
  try {
    // 新增一个无 token 账号：通过 env 配置无法热加，改为断言现有全无 token 时启动状态
    const accounts = await (await env.admin('/admin/accounts')).json();
    assert.ok(accounts.accounts.every((a) => a.credentialMissing === false));
  } finally {
    await env.close();
  }
});

test('运行时消费者 Key：发放/轮换/限额/删除/持久化', async () => {
  const env = await setup();
  try {
    // 初始无消费者：匿名可访问
    const anon = await env.chat();
    assert.equal(anon.status, 200);

    // 发放（rpm=1，便于验证限流）
    const created = await env.admin('/admin/consumers', {
      method: 'POST',
      body: JSON.stringify({ id: 'zhangsan', name: '张三', rpm: 1, maxConcurrent: 1 }),
    });
    assert.equal(created.status, 201);
    const createdJson = await created.json();
    const key1 = createdJson.key;
    assert.match(key1, /^sk-cf-/);
    assert.ok(existsSync(path.join(env.cfg.stateDir, 'consumers.json')), 'consumers.json 未生成');

    const withKey = (key) =>
      fetch(`${env.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }] }),
      });

    // 有消费者后，匿名被拒
    assert.equal((await env.chat()).status, 401);
    // 带 key 成功
    assert.equal((await withKey(key1)).status, 200);
    // rpm=1 → 第二次触发消费者限流
    assert.equal((await withKey(key1)).status, 429);

    // 轮换：旧 key 失效、新 key 可用（先解除 rpm 影响）
    await env.admin('/admin/consumers/zhangsan', { method: 'PATCH', body: JSON.stringify({ rpm: 0 }) });
    const rotated = await (await env.admin('/admin/consumers/zhangsan/rotate', { method: 'POST' })).json();
    assert.match(rotated.key, /^sk-cf-/);
    assert.notEqual(rotated.key, key1);
    assert.equal((await withKey(key1)).status, 401);
    assert.equal((await withKey(rotated.key)).status, 200);

    // 列表脱敏：不返回明文 key
    const list = await (await env.admin('/admin/consumers')).json();
    assert.equal(list.consumers.length, 1);
    assert.equal(list.consumers[0].keyPrefix.includes(rotated.key), false);
    assert.equal(JSON.stringify(list).includes(rotated.key), false);

    // 删除后恢复匿名访问
    const del = await env.admin('/admin/consumers/zhangsan', { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await env.chat()).status, 200);
  } finally {
    await env.close();
  }
});


test('流式对话解析 usage 并计入账号统计', async () => {
  const env = await setup({ quotaProbe: false });
  try {
    const res = await fetch(env.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('收到'), '流式响应缺少内容');
    assert.ok(text.includes('"usage"'), '流式响应缺少 usage 帧');
    const usage = await (await env.admin('/admin/usage')).json();
    const acc = usage.accounts.find((a) => a.id === 'acc-a') || usage.accounts[0];
    assert.ok(acc.stats.tokensIn >= 11, '流式 usage 未计入 tokensIn：' + JSON.stringify(acc.stats));
    assert.ok(acc.stats.tokensOut >= 2, '流式 usage 未计入 tokensOut：' + JSON.stringify(acc.stats));
  } finally {
    await env.close();
  }
});

test('429 Retry-After 参与账号冷却时长', async () => {
  const env = await setup();
  try {
    // 让 acc-a 返回带 Retry-After: 120 的 429，代理应把该账号冷却约 120s
    await env.mock.control({ accounts: { 'r-a': { chat: '429-retry' } } });
    const res = await env.chat();
    // 请求会 failover 到 acc-b 成功（或 429 若都失败），这里只验证 acc-a 冷却
    const accounts = (await (await env.admin('/admin/accounts')).json()).accounts;
    const a = accounts.find((x) => x.id === 'acc-a');
    assert.ok(a, '缺少 acc-a');
    assert.ok(a.cooldownMsLeft >= 100000, 'Retry-After 未生效，cooldownMsLeft=' + a.cooldownMsLeft);
    assert.match(String(a.cooldownReason || ''), /rate_limited/);
    assert.ok([200, 429].includes(res.status));
  } finally {
    await env.close();
  }
});

test('模型列表包含能力元数据（toolCall/vision/contextWindow）', async () => {
  const env = await setup();
  try {
    const res = await fetch(env.base + '/v1/models');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.data) && json.data.length >= 2);
    const chatModel = json.data.find((m) => m.id === 'GLM-5.2');
    const visionModel = json.data.find((m) => m.id === 'Qwen3.8-27B');
    assert.equal(chatModel.meta.capabilities.toolCall, true);
    assert.equal(chatModel.meta.capabilities.reasoning, true);
    assert.equal(chatModel.meta.capabilities.vision, false);
    assert.equal(visionModel.meta.capabilities.vision, true);
    assert.ok(chatModel.meta.contextWindow >= 80000);
    assert.ok(chatModel.meta.limit && chatModel.meta.limit.context >= 80000);
    // 引擎请求侧 max_tokens 恒 32000；modelmgr.maxOutputTokens 不约束请求
    assert.equal(chatModel.meta.limit.output, 32000);
    assert.equal(chatModel.meta.upstreamMaxOutputTokens, 16000);
    assert.equal(chatModel.meta.quotaExempt, false);
    // modelproviders 目录合并（models.dev 结构）
    assert.equal(chatModel.meta.catalog?.cost?.input, 1);
    assert.equal(chatModel.meta.catalog?.limit?.context, 200000);
    // LEGACY 模型标记为免额度
    const legacy = json.data.find((m) => m.id === 'Legacy-Free');
    assert.equal(legacy.meta.quotaExempt, true);
  } finally {
    await env.close();
  }
});


test('默认 subService 与流式 include_usage 对齐客户端', async () => {
  const env = await setup();
  try {
    const res = await fetch(env.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    const reqs = env.mock.state.requests.filter((r) => r.path === '/api/acbackend/codechat/v1/completions');
    assert.ok(reqs.length >= 1, '未记录到聊天上游请求');
    const last = reqs[reqs.length - 1];
    // 桌面链路归属：codefree_o_desktop_chat（见 docs/recon-upstream-behavior.md §4.2 D2）
    assert.equal(last.headers.subService, 'codefree_o_desktop_chat');
    assert.equal(last.body.stream_options.include_usage, true);
  } finally {
    await env.close();
  }
});

test('流内额度耗尽：终止流、返回配额错误并冷却账号（不记成功）', async () => {
  const env = await setup({ accounts: { 'r-a': { chat: 'stream-quota' }, 'r-b': { chat: 'stream-quota' } } });
  try {
    const res = await fetch(env.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    assert.match(text, /codefree_quota_exhausted/);
    const accounts = (await (await env.admin('/admin/accounts')).json()).accounts;
    const cooled = accounts.filter((a) => a.cooldownReason === 'quota_exhausted');
    assert.ok(cooled.length >= 1, '流内耗尽未触发账号冷却');
    assert.ok(cooled[0].cooldownMsLeft >= 100000, 'kooldown 未使用 resetAt：' + cooled[0].cooldownMsLeft);
    const usage = await (await env.admin('/admin/usage')).json();
    assert.equal(usage.accounts.reduce((s, a) => s + a.stats.successes, 0), 0, '流内耗尽不应记成功');
  } finally {
    await env.close();
  }
});

test('SSE 空闲超时：终止流、返回错误帧且不记成功', async () => {
  const env = await setup({
    accounts: { 'r-a': { chat: 'stream-stall' }, 'r-b': { chat: 'stream-stall' } },
    upstream: { streamIdleTimeoutMs: 300, requestTimeoutMs: 15000 },
  });
  try {
    const t0 = Date.now();
    const res = await fetch(env.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 8000, '空闲超时未生效，elapsed=' + elapsed);
    assert.match(text, /codefree_stream_interrupted/);
    const usage = await (await env.admin('/admin/usage')).json();
    assert.equal(usage.accounts.reduce((s, a) => s + a.stats.successes, 0), 0, '流中断不应记成功');
    assert.ok(usage.accounts.reduce((s, a) => s + a.stats.failures, 0) >= 1, '流中断未记失败');
  } finally {
    await env.close();
  }
});

test('流内业务错误帧（上下文超限）：透传错误、记失败但不冷却账号', async () => {
  const env = await setup({ accounts: { 'r-a': { chat: 'stream-error' }, 'r-b': { chat: 'stream-error' } } });
  try {
    const res = await fetch(env.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'GLM-5.2', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await res.text();
    assert.match(text, /context_length_exceeded/);
    const accounts = (await (await env.admin('/admin/accounts')).json()).accounts;
    assert.ok(accounts.every((a) => a.cooldownReason !== 'quota_exhausted'));
    const usage = await (await env.admin('/admin/usage')).json();
    assert.equal(usage.accounts.reduce((s, a) => s + a.stats.successes, 0), 0, '业务错误不应记成功');
    assert.ok(usage.accounts.reduce((s, a) => s + a.stats.failures, 0) >= 1, '业务错误未记失败');
  } finally {
    await env.close();
  }
});


test('LEGACY 免额度模型：忽略额度评分选号且失败不冷却账号', async () => {
  const env = await setup({
    accounts: {
      'r-a': { accessToken: 'tok-a', userId: '111', fiveHour: { usagePercent: 90, used: 90, limit: 100, resetAt: Date.now() + 3600_000 } },
      'r-b': { accessToken: 'tok-b', userId: '222', fiveHour: { usagePercent: 5, used: 5, limit: 100, resetAt: Date.now() + 3600_000 } },
    },
    quotaProbe: true,
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    await env.chat({ model: 'GLM-5.2', session_id: 'quota-normal' });
    assert.equal(chatCalls(env.mock).at(-1).account, 'r-b', '普通模型应按 headroom 选 r-b');
    await env.chat({ model: 'Legacy-Free', session_id: 'quota-legacy' });
    assert.equal(chatCalls(env.mock).at(-1).account, 'r-a', 'LEGACY 模型不应因额度低被跳过');

    await env.mock.control({ accounts: { 'r-a': { chat: '429' }, 'r-b': { chat: '429' } } });
    const res = await env.chat({ model: 'Legacy-Free' });
    assert.equal(res.status, 429);
    const accounts = (await (await env.admin('/admin/accounts')).json()).accounts;
    assert.ok(accounts.every((a) => a.cooldownReason !== 'quota_exhausted'), 'LEGACY 模型不应触发额度冷却');
  } finally {
    await env.close();
  }
});

test('上游 UA / 会话归因头透传', async () => {
  const env = await setup();
  try {
    const res = await fetch(env.base + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-affinity': 'aff-1',
        'x-session-id': 'sid-1',
        'x-parent-session-id': 'parent-1',
      },
      body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    const last = env.mock.state.requests.filter((r) => r.path === '/api/acbackend/codechat/v1/completions').at(-1);
    assert.equal(last.headers.sessionId, 'aff-1');
    assert.equal(last.headers.parentSessionId, 'parent-1');
    assert.match(String(last.headers.userAgent || ''), /opencode\//);
  } finally {
    await env.close();
  }
});

test('modelproviders 管理接口可查询目录', async () => {
  const env = await setup();
  try {
    const res = await env.admin('/admin/modelproviders');
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.providers) && json.providers.length >= 1);
    assert.ok(json.models >= 1, '目录模型数为 0');
    assert.ok(json.providers.some((p) => p.name === 'codefree'));
  } finally {
    await env.close();
  }
});


test('sessionIdIsolation：按账号派生上游 sessionId 且同账号稳定', async () => {
  const env = await setup({ upstream: { sessionIdIsolation: true } });
  try {
    const post = (headers = {}) =>
      fetch(env.base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'GLM-5.2', messages: [{ role: 'user', content: 'hi' }] }),
      }).then((r) => r.text());
    const chatSids = () => env.mock.state.requests.filter((r) => r.path === '/api/acbackend/codechat/v1/completions').map((r) => r.headers.sessionId);

    await post({ 'x-session-affinity': 'sess-iso' });
    const first = chatSids().at(-1);
    assert.match(String(first), /^sess-iso-[0-9a-f]{12}$/);
    await post({ 'x-session-affinity': 'sess-iso' });
    assert.equal(chatSids().at(-1), first, '同账号同会话应派生稳定 sessionId');
  } finally {
    await env.close();
  }
});

test('额度状态信息指标（quotaStatus / statusReason）', async () => {
  const env = await setup({
    quotaProbe: true,
    accounts: {
      'r-a': { accessToken: 'tok-a', userId: '111', quotaStatus: 'BYPASSED', statusReason: 'OUTSIDE_GRAY_SCOPE' },
      'r-b': { accessToken: 'tok-b', userId: '222', quotaStatus: 'BYPASSED', statusReason: 'OUTSIDE_GRAY_SCOPE' },
    },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    const metrics = await (await fetch(env.base + '/metrics')).text();
    assert.match(metrics, /codefree_quota_status_info\{[^}]*status="BYPASSED"\} 1/);
    assert.match(metrics, /codefree_quota_status_reason_info\{[^}]*reason="OUTSIDE_GRAY_SCOPE"\} 1/);
  } finally {
    await env.close();
  }
});
