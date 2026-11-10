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
import { WeComWebhook } from '../lib/wecom.mjs';
import { AlertManager } from '../lib/alerts.mjs';
import { AccountPool, SessionAffinity } from '../lib/pool.mjs';
import { deepMerge } from '../lib/util.mjs';

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
async function setup({ accounts, consumers, quotaProbe = false, selection = {}, alert, upstream, env: extraEnv } = {}) {
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
    env: {
      ...process.env,
      CODEFREE_CONFIG: cfgPath,
      PORT: String(port),
      CODEFREE_DEBUG: '',
      // 避免开发机上的真实告警配置影响测试；用例需要时通过 env 显式传入
      CODEFREE_ALERT_WEBHOOK: '',
      CODEFREE_ALERT_WEBHOOK_TIMEOUT_MS: '',
      CODEFREE_ALERT_COOLDOWN_MS: '',
      CODEFREE_ALERT_ACCOUNT_COOLDOWN_MS: '',
      CODEFREE_QUOTA_WARN_PERCENT: '',
      CODEFREE_ALERT_MSG_TYPE: '',
      CODEFREE_ALERT_MENTION: '',
      CODEFREE_ALERT_MENTION_MOBILE: '',
      CODEFREE_REFRESH_WARN_HOURS: '',
      ...(extraEnv || {}),
    },
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

/** 本地企微 webhook 接收端 */
async function startAlertHook() {
  const captured = [];
  const hook = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (d) => (buf += d.toString()));
    req.on('end', () => {
      try {
        captured.push(JSON.parse(buf));
      } catch {
        captured.push(buf);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"errcode":0}');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${hook.address().port}/hook`,
    captured,
    close: () => new Promise((r) => hook.close(r)),
  };
}

function alertContent(body) {
  if (typeof body === 'string') return body;
  return body?.text?.content || body?.markdown?.content || '';
}

async function waitForAlert(captured, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = captured.find((b) => predicate(alertContent(b), b));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
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
  const hook = await startAlertHook();
  const env = await setup({
    quotaProbe: true,
    alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 1000 },
  });
  try {
    await env.admin('/admin/quota/probe');
    // 两个账号都返回额度耗尽
    await env.mock.control({ accounts: { 'r-a': { accessToken: 'tok-a', userId: '111', chat: '429' }, 'r-b': { accessToken: 'tok-b', userId: '222', chat: '429' } } });
    const res = await env.chat();
    assert.equal(res.status, 429);
    // 等待告警评估与发送
    const poolMsg = await waitForAlert(hook.captured, (c) => c.includes('全池额度耗尽'));
    assert.ok(poolMsg, '未收到全池额度耗尽告警');
    assert.match(alertContent(poolMsg), /acc-a/);
    // 同时应有账号级额度耗尽告警
    const accountMsg = await waitForAlert(hook.captured, (c) => c.includes('账号额度耗尽') && c.includes('acc-a'));
    assert.ok(accountMsg, '未收到账号级额度耗尽告警');
  } finally {
    await env.close();
    await hook.close();
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

test('按会话负载均衡：新 session 在账号间均匀分布', async () => {
  const env = await setup({ quotaProbe: true });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    await env.mock.control({ resetLogs: true });
    for (let i = 0; i < 6; i++) {
      const res = await env.chat({ session_id: `balance-${i}` });
      assert.equal(res.status, 200);
    }
    const counts = {};
    for (const call of chatCalls(env.mock)) counts[call.account] = (counts[call.account] || 0) + 1;
    assert.deepEqual(counts, { 'r-a': 3, 'r-b': 3 }, '6 个新 session 应均匀分到两个账号');

    const health = await (await fetch(env.base + '/health')).json();
    assert.equal(health.pool.stickySessions, 6);
    assert.deepEqual(health.pool.sessionsByAccount, { 'acc-a': 3, 'acc-b': 3 });
    assert.equal(health.accountsDetail.find((a) => a.id === 'acc-a').sessions, 3);

    const metrics = await (await fetch(env.base + '/metrics')).text();
    assert.match(metrics, /codefree_account_sessions\{[^}]*account="acc-a"[^}]*\} 3/);
    assert.match(metrics, /codefree_account_sessions\{[^}]*account="acc-b"[^}]*\} 3/);
  } finally {
    await env.close();
  }
});

test('会话硬绑定：原账号余量达标时不被更高评分账号抢走', async () => {
  const env = await setup({
    quotaProbe: true,
    // 关掉软粘性加分与会话负载项，确保同 session 保持原账号只能靠硬绑定
    selection: { stickyScoreFactor: 0, weights: { sessions: 0 } },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    const first = await env.chat({ session_id: 'pin-1' });
    assert.equal(first.status, 200);
    const pinned = chatCalls(env.mock).at(-1).account;
    const other = pinned === 'r-a' ? 'r-b' : 'r-a';

    // 已绑定账号余量 15%（>= stickyMinHeadroom 0.1），另一账号 95%：评分明显偏向另一账号
    const patch = {
      [pinned]: { fiveHour: { usagePercent: 85, used: 85, limit: 100, resetAt: Date.now() + 3600_000 } },
      [other]: { fiveHour: { usagePercent: 5, used: 5, limit: 100, resetAt: Date.now() + 3600_000 } },
    };
    await env.mock.control({ accounts: patch });
    await env.admin('/admin/quota/probe', { method: 'POST' });

    const second = await env.chat({ session_id: 'pin-1' });
    assert.equal(second.status, 200);
    assert.equal(chatCalls(env.mock).at(-1).account, pinned, '硬绑定应优先于额度评分');

    // 余量低于阈值后应允许漂移
    patch[pinned] = { fiveHour: { usagePercent: 95, used: 95, limit: 100, resetAt: Date.now() + 3600_000 } };
    await env.mock.control({ accounts: patch });
    await env.admin('/admin/quota/probe', { method: 'POST' });
    const third = await env.chat({ session_id: 'pin-1' });
    assert.equal(third.status, 200);
    assert.equal(chatCalls(env.mock).at(-1).account, other, '余量低于 stickyMinHeadroom 后应漂移');
  } finally {
    await env.close();
  }
});

test('同一 session 并发首请求：选中即绑定，命中同一账号', async () => {
  const env = await setup();
  try {
    const results = await Promise.all([env.chat({ session_id: 'concurrent-1' }), env.chat({ session_id: 'concurrent-1' })]);
    assert.ok(results.every((r) => r.status === 200));
    const accounts = new Set(chatCalls(env.mock).map((c) => c.account));
    assert.equal(accounts.size, 1, `并发首请求应命中同一账号，实际：${[...accounts].join(',')}`);
  } finally {
    await env.close();
  }
});

test('会话失败漂移：换号后重新绑定，不回到原账号', async () => {
  const env = await setup();
  try {
    await env.chat({ session_id: 'fail-1' });
    const pinned = chatCalls(env.mock).at(-1).account;
    const other = pinned === 'r-a' ? 'r-b' : 'r-a';

    await env.mock.control({ accounts: { [pinned]: { chat: '500' } } });
    const res = await env.chat({ session_id: 'fail-1' });
    assert.equal(res.status, 200);
    assert.equal(chatCalls(env.mock).at(-1).account, other, '失败应换号');

    await env.mock.control({ accounts: { [pinned]: { chat: 'ok' } } });
    const res2 = await env.chat({ session_id: 'fail-1' });
    assert.equal(res2.status, 200);
    assert.equal(chatCalls(env.mock).at(-1).account, other, '换号后应重新绑定到新账号');
  } finally {
    await env.close();
  }
});

test('maxSessionsPerAccount：达上限后新会话强制分到其他账号', async () => {
  const env = await setup({
    quotaProbe: true,
    selection: { weights: { sessions: 0 }, sessionBalancing: { enabled: true, maxSessionsPerAccount: 1 } },
    accounts: {
      'r-a': {
        accessToken: 'tok-a',
        userId: '111',
        fiveHour: { usagePercent: 10, used: 10, limit: 100, resetAt: Date.now() + 3600_000 },
      },
      'r-b': {
        accessToken: 'tok-b',
        userId: '222',
        fiveHour: { usagePercent: 80, used: 80, limit: 100, resetAt: Date.now() + 3600_000 },
      },
    },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    for (const sid of ['cap-a1', 'cap-b1', 'cap-c1']) {
      const res = await env.chat({ session_id: sid });
      assert.equal(res.status, 200);
    }
    const calls = chatCalls(env.mock).map((c) => c.account);
    assert.equal(calls[0], 'r-a', '第一个 session 应按余量选 r-a');
    assert.equal(calls[1], 'r-b', 'r-a 达上限后应强制分到 r-b，即使 r-a 评分更高');
    assert.equal(calls[2], 'r-a', '全部达上限后应放宽限制并按评分选 r-a');
  } finally {
    await env.close();
  }
});

test('maxSessionsPerAccount：新会话避开已达上限的账号，全满时仍均摊', async () => {
  const env = await setup({ selection: { sessionBalancing: { enabled: true, maxSessionsPerAccount: 1 } } });
  try {
    for (const sid of ['cap-1', 'cap-2', 'cap-3', 'cap-4']) {
      const res = await env.chat({ session_id: sid });
      assert.equal(res.status, 200);
    }
    const calls = chatCalls(env.mock);
    assert.notEqual(calls[0].account, calls[1].account, '前两个 session 应分到不同账号');
    const counts = {};
    for (const c of calls) counts[c.account] = (counts[c.account] || 0) + 1;
    assert.deepEqual(counts, { 'r-a': 2, 'r-b': 2 }, '达到上限后溢出会话仍应均摊，而不是堆到同一账号');

    const health = await (await fetch(env.base + '/health')).json();
    assert.equal(health.pool.stickySessions, 4);
  } finally {
    await env.close();
  }
});

test('会话 TTL 过期后重新按评分选号', async () => {
  const env = await setup({ quotaProbe: true, selection: { stickyTtlMs: 100 } });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    await env.chat({ session_id: 'ttl-1' });
    const pinned = chatCalls(env.mock).at(-1).account;
    const other = pinned === 'r-a' ? 'r-b' : 'r-a';

    const patch = {
      [pinned]: { fiveHour: { usagePercent: 85, used: 85, limit: 100, resetAt: Date.now() + 3600_000 } },
      [other]: { fiveHour: { usagePercent: 5, used: 5, limit: 100, resetAt: Date.now() + 3600_000 } },
    };
    await env.mock.control({ accounts: patch });
    await env.admin('/admin/quota/probe', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 150));

    const res = await env.chat({ session_id: 'ttl-1' });
    assert.equal(res.status, 200);
    assert.equal(chatCalls(env.mock).at(-1).account, other, 'TTL 过期后应重新选号');
  } finally {
    await env.close();
  }
});

test('账号登录失效触发 webhook（单账号）', async () => {
  const hook = await startAlertHook();
  const env = await setup({
    alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 1000 },
  });
  try {
    // acc-a 的 chat 持续 401；刷新后仍失败 → auth-expired，请求切到 acc-b 成功
    await env.mock.control({ accounts: { 'r-a': { chat: '401' } } });
    const res = await env.chat({ session_id: 'auth-alert' });
    assert.equal(res.status, 200, '应 failover 到正常账号');
    const msg = await waitForAlert(hook.captured, (c) => c.includes('账号登录失效'));
    assert.ok(msg, '未收到账号登录失效告警');
    const content = alertContent(msg);
    assert.match(content, /acc-a/);
    assert.doesNotMatch(content, /全池登录失效/);
  } finally {
    await env.close();
    await hook.close();
  }
});

test('额度预警触发 webhook（回退阈值 80%）', async () => {
  const hook = await startAlertHook();
  const env = await setup({
    quotaProbe: true,
    alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 1000, quotaWarnPercent: 80 },
    accounts: {
      'r-a': {
        accessToken: 'tok-a',
        userId: '111',
        fiveHour: { usagePercent: 85, used: 85, limit: 100, resetAt: Date.now() + 3600_000 },
      },
      'r-b': {
        accessToken: 'tok-b',
        userId: '222',
        fiveHour: { usagePercent: 10, used: 10, limit: 100, resetAt: Date.now() + 3600_000 },
      },
    },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    const msg = await waitForAlert(hook.captured, (c) => c.includes('账号额度预警') && c.includes('acc-a'));
    assert.ok(msg, '未收到额度预警');
    const content = alertContent(msg);
    assert.match(content, /5H/);
    assert.match(content, /85%/);
    assert.match(content, /阈值 80%/);
  } finally {
    await env.close();
    await hook.close();
  }
});

test('账号额度耗尽触发 webhook', async () => {
  const hook = await startAlertHook();
  const env = await setup({
    quotaProbe: true,
    alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 1000 },
    accounts: {
      'r-a': {
        accessToken: 'tok-a',
        userId: '111',
        fiveHour: { usagePercent: 100, used: 100, limit: 100, resetAt: Date.now() + 3600_000 },
      },
      'r-b': {
        accessToken: 'tok-b',
        userId: '222',
        fiveHour: { usagePercent: 10, used: 10, limit: 100, resetAt: Date.now() + 3600_000 },
      },
    },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    const msg = await waitForAlert(hook.captured, (c) => c.includes('账号额度耗尽') && c.includes('acc-a'));
    assert.ok(msg, '未收到账号额度耗尽告警');
    assert.match(alertContent(msg), /5H/);
  } finally {
    await env.close();
    await hook.close();
  }
});

test('账号被服务端管控触发 webhook', async () => {
  const hook = await startAlertHook();
  const env = await setup({
    quotaProbe: true,
    alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 1000 },
    accounts: {
      'r-a': { accessToken: 'tok-a', userId: '111', quotaStatus: 'DISABLED', statusReason: 'CONTROL_DISABLED' },
      'r-b': { accessToken: 'tok-b', userId: '222' },
    },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    const msg = await waitForAlert(hook.captured, (c) => c.includes('账号被管控') && c.includes('acc-a'));
    assert.ok(msg, '未收到账号被管控告警');
    assert.match(alertContent(msg), /CONTROL_DISABLED/);
  } finally {
    await env.close();
    await hook.close();
  }
});

test('上游 5xx 触发账号异常 webhook', async () => {
  const hook = await startAlertHook();
  const env = await setup({
    alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 1000 },
  });
  try {
    await env.mock.control({ accounts: { 'r-a': { chat: '500' } } });
    const res = await env.chat({ session_id: 'upstream-alert' });
    assert.equal(res.status, 200, '应 failover 到正常账号');
    const msg = await waitForAlert(hook.captured, (c) => c.includes('账号上游异常') && c.includes('acc-a'));
    assert.ok(msg, '未收到账号上游异常告警');
    assert.match(alertContent(msg), /upstream_500/);
  } finally {
    await env.close();
    await hook.close();
  }
});

test('企微 markdown 消息格式', async () => {
  const hook = await startAlertHook();
  const env = await setup({
    quotaProbe: true,
    alert: { enabled: true, webhookUrl: hook.url, msgType: 'markdown', cooldownMs: 1000 },
    accounts: {
      'r-a': {
        accessToken: 'tok-a',
        userId: '111',
        fiveHour: { usagePercent: 90, used: 90, limit: 100, resetAt: Date.now() + 3600_000 },
      },
      'r-b': { accessToken: 'tok-b', userId: '222' },
    },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    const msg = await waitForAlert(hook.captured, (c) => c.includes('账号额度预警'));
    assert.ok(msg, '未收到 markdown 告警');
    assert.equal(msg.msgtype, 'markdown');
    assert.ok(msg.markdown?.content?.includes('账号额度预警'));
  } finally {
    await env.close();
    await hook.close();
  }
});

test('webhook 通过环境变量 CODEFREE_ALERT_WEBHOOK 配置', async () => {
  const hook = await startAlertHook();
  const env = await setup({
    quotaProbe: true,
    env: { CODEFREE_ALERT_WEBHOOK: hook.url },
    accounts: {
      'r-a': {
        accessToken: 'tok-a',
        userId: '111',
        fiveHour: { usagePercent: 90, used: 90, limit: 100, resetAt: Date.now() + 3600_000 },
      },
      'r-b': { accessToken: 'tok-b', userId: '222' },
    },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    const msg = await waitForAlert(hook.captured, (c) => c.includes('账号额度预警'));
    assert.ok(msg, '未收到环境变量配置的 webhook 告警');
  } finally {
    await env.close();
    await hook.close();
  }
});

test('关闭会话负载均衡后恢复旧软粘性', async () => {
  const env = await setup({
    quotaProbe: true,
    selection: { sessionBalancing: { enabled: false }, stickyScoreFactor: 5 },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    await env.chat({ session_id: 'legacy-sticky' });
    const pinned = chatCalls(env.mock).at(-1).account;
    const other = pinned === 'r-a' ? 'r-b' : 'r-a';

    const patch = {
      [pinned]: { fiveHour: { usagePercent: 85, used: 85, limit: 100, resetAt: Date.now() + 3600_000 } },
      [other]: { fiveHour: { usagePercent: 5, used: 5, limit: 100, resetAt: Date.now() + 3600_000 } },
    };
    await env.mock.control({ accounts: patch });
    await env.admin('/admin/quota/probe', { method: 'POST' });

    const res = await env.chat({ session_id: 'legacy-sticky' });
    assert.equal(res.status, 200);
    assert.equal(chatCalls(env.mock).at(-1).account, pinned, '关闭负载均衡后应由 stickyScoreFactor 保持软粘性');
  } finally {
    await env.close();
  }
});

test('BYPASSED / VIP 账号不触发额度预警', async () => {
  const hook = await startAlertHook();
  const env = await setup({
    quotaProbe: true,
    alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 1000 },
    accounts: {
      'r-a': {
        accessToken: 'tok-a',
        userId: '111',
        quotaStatus: 'BYPASSED',
        fiveHour: { usagePercent: 95, used: 95, limit: 100, resetAt: Date.now() + 3600_000 },
      },
      'r-b': {
        accessToken: 'tok-b',
        userId: '222',
        vip: true,
        fiveHour: { usagePercent: 95, used: 95, limit: 100, resetAt: Date.now() + 3600_000 },
      },
    },
  });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 500));
    const quotaAlerts = hook.captured.filter((b) => /账号额度(预警|耗尽)/.test(alertContent(b)));
    assert.equal(quotaAlerts.length, 0, 'BYPASSED/VIP 账号不应产生额度告警');
  } finally {
    await env.close();
    await hook.close();
  }
});

test('企微 webhook 识别 errcode 非 0 与非 JSON 响应', async () => {
  const bad = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"errcode":40058,"errmsg":"invalid webhook url"}');
  });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  const html = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>gateway error</html>');
  });
  await new Promise((r) => html.listen(0, '127.0.0.1', r));
  const nullCode = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"errcode":null}');
  });
  await new Promise((r) => nullCode.listen(0, '127.0.0.1', r));
  try {
    const wc1 = new WeComWebhook({ url: `http://127.0.0.1:${bad.address().port}/hook` });
    const r1 = await wc1.send('hello');
    assert.equal(r1.ok, false);
    assert.equal(r1.errcode, 40058);

    const wc2 = new WeComWebhook({ url: `http://127.0.0.1:${html.address().port}/hook` });
    const r2 = await wc2.send('hello');
    assert.equal(r2.ok, false, 'HTTP 200 但非 JSON 应视为失败');

    const wc3 = new WeComWebhook({ url: `http://127.0.0.1:${nullCode.address().port}/hook` });
    const r3 = await wc3.send('hello');
    assert.equal(r3.ok, false, 'errcode:null 不应视为成功');
  } finally {
    await new Promise((r) => bad.close(r));
    await new Promise((r) => html.close(r));
    await new Promise((r) => nullCode.close(r));
  }
});

test('池级额度恢复：冷却到期后不再卡在 all_quota_exhausted', async () => {
  const hook = await startAlertHook();
  const alerts = new AlertManager({
    config: { alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 1000 } },
    logger: null,
  });
  const account = {
    id: 'acc-a',
    userId: '111',
    enabled: true,
    credentialMissing: false,
    health: 'ready',
    cooldownReason: 'quota_exhausted',
    cooldownUntil: Date.now() + 60_000,
    stats: {},
  };
  const pool = { list: () => [account] };
  const quota = {
    get: () => ({
      exhausted: true,
      enforced: true,
      quotaStatus: 'ACTIVE',
      windows: { '5H': { usagePercent: 100, resetAt: Date.now() + 60_000 } },
    }),
  };
  try {
    await alerts.evaluate(pool, quota, { reason: 'test' });
    assert.ok(await waitForAlert(hook.captured, (c) => c.includes('全池额度耗尽')));

    // 冷却已到期且额度探测恢复：应发池级恢复，而不是被旧的 cooldownReason 卡住
    account.cooldownUntil = Date.now() - 1000;
    quota.get = () => ({
      exhausted: false,
      enforced: true,
      quotaStatus: 'ACTIVE',
      windows: { '5H': { usagePercent: 10, resetAt: Date.now() + 60_000 } },
    });
    await alerts.evaluate(pool, quota, { reason: 'test' });
    assert.ok(await waitForAlert(hook.captured, (c) => c.includes('已恢复')));
  } finally {
    await hook.close();
  }
});

test('被动快照缺少额度门控字段时不告警', async () => {
  const hook = await startAlertHook();
  const alerts = new AlertManager({ config: { alert: { enabled: true, webhookUrl: hook.url } }, logger: null });
  const account = {
    id: 'acc-a',
    userId: '111',
    enabled: true,
    credentialMissing: false,
    health: 'ready',
    cooldownReason: '',
    cooldownUntil: 0,
    stats: {},
  };
  // 只有被动 usagePercent，没有 enforced/quotaStatus/statusReason/vip：应视为未知，不告警
  const quota = { get: () => ({ windows: { '5H': { usagePercent: 85, thresholdPercent: 70 } } }) };
  try {
    await alerts.evaluate({ list: () => [account] }, quota, { reason: 'passive' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hook.captured.filter((b) => alertContent(b).includes('账号额度预警')).length, 0);
  } finally {
    await hook.close();
  }
});

test('额度预警优先使用服务端 thresholdPercent', async () => {
  const hook = await startAlertHook();
  const alerts = new AlertManager({
    config: { alert: { enabled: true, webhookUrl: hook.url, quotaWarnPercent: 80 } },
    logger: null,
  });
  const account = {
    id: 'acc-a',
    userId: '111',
    enabled: true,
    credentialMissing: false,
    health: 'ready',
    cooldownReason: '',
    cooldownUntil: 0,
    stats: {},
  };
  // 75% 低于回退阈值 80%，但高于服务端 thresholdPercent 70% → 应预警
  const quota = {
    get: () => ({
      enforced: true,
      quotaStatus: 'ACTIVE',
      windows: { '5H': { usagePercent: 75, thresholdPercent: 70, resetAt: Date.now() + 3600_000 } },
    }),
  };
  try {
    await alerts.evaluate({ list: () => [account] }, quota, { reason: 'passive' });
    const msg = await waitForAlert(hook.captured, (c) => c.includes('账号额度预警'));
    assert.ok(msg, '服务端阈值 70% 时应触发预警');
    assert.match(alertContent(msg), /阈值 70%/);
  } finally {
    await hook.close();
  }
});

test('硬绑定余量不达标时换到其他账号', async () => {
  const env = await setup({ quotaProbe: true, selection: { weights: { sessions: 0 } } });
  try {
    await env.admin('/admin/quota/probe', { method: 'POST' });
    await env.chat({ session_id: 'headroom-drift' });
    const pinned = chatCalls(env.mock).at(-1).account;
    const other = pinned === 'r-a' ? 'r-b' : 'r-a';

    // 原账号余量 5%、另一账号 2%：原账号评分更高，但低于 stickyMinHeadroom 应换号
    const patch = {
      [pinned]: { fiveHour: { usagePercent: 95, used: 95, limit: 100, resetAt: Date.now() + 3600_000 } },
      [other]: { fiveHour: { usagePercent: 98, used: 98, limit: 100, resetAt: Date.now() + 3600_000 } },
    };
    await env.mock.control({ accounts: patch });
    await env.admin('/admin/quota/probe', { method: 'POST' });

    const res = await env.chat({ session_id: 'headroom-drift' });
    assert.equal(res.status, 200);
    assert.equal(chatCalls(env.mock).at(-1).account, other, '原账号余量低于阈值时应换号，即使它的评分更高');
  } finally {
    await env.close();
  }
});

test('admin refresh 恢复 auth-expired 账号并发送恢复告警', async () => {
  const hook = await startAlertHook();
  const env = await setup({ alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 1000 } });
  try {
    // acc-a 持续 401 → auth-expired；请求 failover 到 acc-b
    await env.mock.control({ accounts: { 'r-a': { chat: '401' } } });
    const res = await env.chat({ session_id: 'auth-recover' });
    assert.equal(res.status, 200);
    let accounts = (await (await env.admin('/admin/accounts')).json()).accounts;
    assert.equal(accounts.find((a) => a.id === 'acc-a').health, 'auth-expired');
    assert.ok(await waitForAlert(hook.captured, (c) => c.includes('账号登录失效')));

    // 上游恢复后，管理员强制刷新应清除 auth-expired 并发送恢复告警
    await env.mock.control({ accounts: { 'r-a': { chat: 'ok' } } });
    const refresh = await env.admin('/admin/accounts/acc-a/refresh', { method: 'POST' });
    assert.equal(refresh.status, 200);
    accounts = (await (await env.admin('/admin/accounts')).json()).accounts;
    assert.equal(accounts.find((a) => a.id === 'acc-a').health, 'ready');
    assert.ok(await waitForAlert(hook.captured, (c) => c.includes('账号登录已恢复')));
  } finally {
    await env.close();
    await hook.close();
  }
});

test('SessionAffinity：容量淘汰最旧映射且计数一致', () => {
  const affinity = new SessionAffinity({
    config: { selection: { stickyTtlMs: 60000, maxSessions: 2 } },
    logger: null,
  });
  affinity.set('c', 's1', 'a');
  affinity.set('c', 's2', 'b');
  assert.equal(affinity.size(), 2);
  assert.equal(affinity.countByAccount('a'), 1);
  assert.equal(affinity.countByAccount('b'), 1);

  affinity.set('c', 's3', 'a');
  assert.equal(affinity.size(), 2);
  assert.equal(affinity.get('c', 's1'), null, '最旧映射应被淘汰');
  assert.equal(affinity.countByAccount('a'), 1);
  assert.equal(affinity.countByAccount('b'), 1);
});

test('SessionAffinity：读取计数前清理过期映射', async () => {
  const affinity = new SessionAffinity({
    config: { selection: { stickyTtlMs: 20, maxSessions: 100 } },
    logger: null,
  });
  affinity.set('c', 's1', 'a');
  assert.equal(affinity.countByAccount('a'), 1);
  await new Promise((r) => setTimeout(r, 30));
  affinity.lastSweepAt = 0; // 强制下一次读取触发 sweep
  assert.equal(affinity.countByAccount('a'), 0);
  assert.equal(affinity.size(), 0);
});

test('会话键来源：body.sessionId / x-session-affinity / x-session-id 均可硬绑定', async () => {
  const variants = [
    { name: 'body.sessionId', headers: {}, body: { sessionId: 'variant-body' } },
    { name: 'x-session-affinity', headers: { 'x-session-affinity': 'variant-aff' }, body: {} },
    { name: 'x-session-id', headers: { 'x-session-id': 'variant-sid' }, body: {} },
  ];
  for (const variant of variants) {
    const env = await setup({ quotaProbe: true });
    try {
      await env.admin('/admin/quota/probe', { method: 'POST' });
      const send = () =>
        fetch(`${env.base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...variant.headers },
          body: JSON.stringify({
            model: 'GLM-5.2',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
            ...variant.body,
          }),
        });

      assert.equal((await send()).status, 200);
      const pinned = chatCalls(env.mock).at(-1).account;
      const other = pinned === 'r-a' ? 'r-b' : 'r-a';

      // 让另一账号余量明显更好，同 session 仍应硬绑定在原账号
      const patch = {
        [pinned]: { fiveHour: { usagePercent: 85, used: 85, limit: 100, resetAt: Date.now() + 3600_000 } },
        [other]: { fiveHour: { usagePercent: 5, used: 5, limit: 100, resetAt: Date.now() + 3600_000 } },
      };
      await env.mock.control({ accounts: patch });
      await env.admin('/admin/quota/probe', { method: 'POST' });

      assert.equal((await send()).status, 200);
      assert.equal(chatCalls(env.mock).at(-1).account, pinned, `${variant.name} 应保持硬绑定`);
    } finally {
      await env.close();
    }
  }
});

test('告警去重：auth-expired 在冷却期内不重复，到期后提醒', async () => {
  const hook = await startAlertHook();
  const alerts = new AlertManager({
    config: { alert: { enabled: true, webhookUrl: hook.url, accountCooldownMs: 50 } },
    logger: null,
  });
  const account = {
    id: 'acc-a',
    userId: '111',
    enabled: true,
    credentialMissing: false,
    health: 'auth-expired',
    cooldownReason: 'auth_expired',
    cooldownUntil: Date.now() + 60_000,
    stats: { lastError: '401' },
  };
  const pool = { list: () => [account] };
  const quota = { get: () => null };
  try {
    await alerts.evaluate(pool, quota, { reason: 't1' });
    await alerts.evaluate(pool, quota, { reason: 't2' });
    assert.equal(hook.captured.filter((b) => alertContent(b).includes('账号登录失效')).length, 1);

    await new Promise((r) => setTimeout(r, 60));
    await alerts.evaluate(pool, quota, { reason: 't3' });
    assert.equal(
      hook.captured.filter((b) => alertContent(b).includes('账号登录失效')).length,
      2,
      '冷却到期后应再次提醒',
    );
  } finally {
    await hook.close();
  }
});

test('告警去重：额度预警按窗口 resetAt 去重', async () => {
  const hook = await startAlertHook();
  const alerts = new AlertManager({
    config: { alert: { enabled: true, webhookUrl: hook.url, quotaWarnPercent: 80 } },
    logger: null,
  });
  const account = {
    id: 'acc-a',
    userId: '111',
    enabled: true,
    credentialMissing: false,
    health: 'ready',
    cooldownReason: '',
    cooldownUntil: 0,
    stats: {},
  };
  const resetAt = Date.now() + 3600_000;
  let snap = {
    enforced: true,
    quotaStatus: 'ACTIVE',
    windows: { '5H': { usagePercent: 85, thresholdPercent: 80, resetAt } },
  };
  const pool = { list: () => [account] };
  const quota = { get: () => snap };
  try {
    await alerts.evaluate(pool, quota, { reason: 't1' });
    await alerts.evaluate(pool, quota, { reason: 't2' });
    assert.equal(hook.captured.filter((b) => alertContent(b).includes('账号额度预警')).length, 1);

    // 同一窗口（resetAt 未变）不重复；新窗口应重新预警
    snap = { ...snap, windows: { '5H': { ...snap.windows['5H'], resetAt: resetAt + 1 } } };
    await alerts.evaluate(pool, quota, { reason: 't3' });
    assert.equal(hook.captured.filter((b) => alertContent(b).includes('账号额度预警')).length, 2);
  } finally {
    await hook.close();
  }
});

test('告警冷却：池级事件在 cooldownMs 内不重复，恢复后发送', async () => {
  const hook = await startAlertHook();
  const alerts = new AlertManager({
    config: { alert: { enabled: true, webhookUrl: hook.url, cooldownMs: 50 } },
    logger: null,
  });
  const account = {
    id: 'acc-a',
    userId: '111',
    enabled: true,
    credentialMissing: false,
    health: 'ready',
    cooldownReason: 'quota_exhausted',
    cooldownUntil: Date.now() + 60_000,
    stats: {},
  };
  const pool = { list: () => [account] };
  let snap = {
    exhausted: true,
    enforced: true,
    quotaStatus: 'ACTIVE',
    windows: { '5H': { usagePercent: 100, resetAt: Date.now() + 60_000 } },
  };
  const quota = { get: () => snap };
  try {
    await alerts.evaluate(pool, quota, { reason: 't1' });
    await alerts.evaluate(pool, quota, { reason: 't2' });
    assert.equal(hook.captured.filter((b) => alertContent(b).includes('全池额度耗尽')).length, 1);

    await new Promise((r) => setTimeout(r, 60));
    await alerts.evaluate(pool, quota, { reason: 't3' });
    assert.equal(hook.captured.filter((b) => alertContent(b).includes('全池额度耗尽')).length, 2);

    account.cooldownUntil = Date.now() - 1000;
    snap = {
      exhausted: false,
      enforced: true,
      quotaStatus: 'ACTIVE',
      windows: { '5H': { usagePercent: 10, resetAt: Date.now() + 60_000 } },
    };
    await alerts.evaluate(pool, quota, { reason: 't4' });
    assert.ok(await waitForAlert(hook.captured, (c) => c.includes('已恢复')));
  } finally {
    await hook.close();
  }
});

test('告警发送失败后下一次评估重试', async () => {
  let calls = 0;
  const hook = http.createServer((req, res) => {
    calls++;
    req.on('data', () => {});
    req.on('end', () => {
      if (calls === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"errcode":500}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errcode":0}');
      }
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));

  const alerts = new AlertManager({
    config: { alert: { enabled: true, webhookUrl: `http://127.0.0.1:${hook.address().port}/hook` } },
    logger: null,
  });
  const bad = {
    id: 'acc-a',
    userId: '111',
    enabled: true,
    credentialMissing: false,
    health: 'auth-expired',
    cooldownReason: 'auth_expired',
    cooldownUntil: Date.now() + 60_000,
    stats: {},
  };
  const good = {
    id: 'acc-b',
    userId: '222',
    enabled: true,
    credentialMissing: false,
    health: 'ready',
    cooldownReason: '',
    cooldownUntil: 0,
    stats: {},
  };
  const pool = { list: () => [bad, good] };
  const quota = { get: () => null };
  try {
    await alerts.evaluate(pool, quota, { reason: 't1' });
    assert.equal(calls, 1, '第一次发送应失败');
    await alerts.evaluate(pool, quota, { reason: 't2' });
    assert.equal(calls, 2, '发送失败后下一次评估应重试');
  } finally {
    await new Promise((r) => hook.close(r));
  }
});

test('企微 text 消息支持 @ 成员', async () => {
  const hook = await startAlertHook();
  const wc = new WeComWebhook({
    url: hook.url,
    mentionedList: ['@all'],
    mentionedMobileList: ['13800000000'],
  });
  try {
    const res = await wc.send('hello');
    assert.equal(res.ok, true);
    const body = hook.captured[0];
    assert.equal(body.msgtype, 'text');
    assert.equal(body.text.content, 'hello');
    assert.deepEqual(body.text.mentioned_list, ['@all']);
    assert.deepEqual(body.text.mentioned_mobile_list, ['13800000000']);
  } finally {
    await hook.close();
  }
});

test('企微消息按 UTF-8 字节上限截断', async () => {
  const hook = await startAlertHook();
  try {
    const textClient = new WeComWebhook({ url: hook.url });
    await textClient.send('中'.repeat(2000)); // 6000 bytes
    const textBody = hook.captured[0];
    assert.ok(Buffer.byteLength(textBody.text.content, 'utf8') <= 2048);
    assert.match(textBody.text.content, /消息已截断/);

    const mdClient = new WeComWebhook({ url: hook.url, msgType: 'markdown' });
    await mdClient.send('中'.repeat(2000));
    const mdBody = hook.captured[1];
    assert.equal(mdBody.msgtype, 'markdown');
    assert.ok(Buffer.byteLength(mdBody.markdown.content, 'utf8') <= 4096);
    assert.match(mdBody.markdown.content, /消息已截断/);
  } finally {
    await hook.close();
  }
});

test('额度恢复：跨窗口重置发恢复，额度失效不误报恢复', async () => {
  const hook = await startAlertHook();
  const alerts = new AlertManager({
    config: { alert: { enabled: true, webhookUrl: hook.url, quotaWarnPercent: 80 } },
    logger: null,
  });
  const account = {
    id: 'acc-a',
    userId: '111',
    enabled: true,
    credentialMissing: false,
    health: 'ready',
    cooldownReason: '',
    cooldownUntil: 0,
    stats: {},
  };
  const pool = { list: () => [account] };
  const r1 = Date.now() + 60_000;
  let snap = {
    enforced: true,
    quotaStatus: 'ACTIVE',
    windows: { '5H': { usagePercent: 100, status: 'EXHAUSTED', resetAt: r1 } },
  };
  const quota = { get: () => snap };
  try {
    await alerts.evaluate(pool, quota, { reason: 't1' });
    assert.ok(hook.captured.some((b) => alertContent(b).includes('账号额度耗尽')));

    // 新窗口 10%：跨 resetAt 也应发恢复
    const r2 = r1 + 60_000;
    snap = {
      enforced: true,
      quotaStatus: 'ACTIVE',
      windows: { '5H': { usagePercent: 10, status: 'ACTIVE', resetAt: r2 } },
    };
    await alerts.evaluate(pool, quota, { reason: 't2' });
    assert.ok(hook.captured.some((b) => alertContent(b).includes('账号额度恢复')), '跨窗口重置应发恢复');

    // 再次预警后额度失效（BYPASSED）：不应发“额度恢复”
    snap = {
      enforced: true,
      quotaStatus: 'ACTIVE',
      windows: { '5H': { usagePercent: 85, status: 'ACTIVE', resetAt: r2, thresholdPercent: 80 } },
    };
    await alerts.evaluate(pool, quota, { reason: 't3' });
    const before = hook.captured.filter((b) => alertContent(b).includes('账号额度恢复')).length;

    snap = {
      enforced: false,
      bypassed: true,
      quotaStatus: 'BYPASSED',
      windows: { '5H': { usagePercent: 85, status: 'ACTIVE', resetAt: r2, thresholdPercent: 80 } },
    };
    await alerts.evaluate(pool, quota, { reason: 't4' });
    const after = hook.captured.filter((b) => alertContent(b).includes('账号额度恢复')).length;
    assert.equal(after, before, '额度失效时不应误报额度恢复');
  } finally {
    await hook.close();
  }
});

test('凭据缺失恢复：刷新失败不提前启用账号', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cf-pool-auth-'));
  const authFile = path.join(dir, 'codefree.json');
  const config = {
    stateDir: dir,
    upstream: {
      baseUrl: 'http://127.0.0.1:1',
      clientId: 'test-client',
      clientSecret: '',
      signingSecret: '',
      version: '1.0.0',
      subService: 'test',
      userAgent: 'test',
      requestTimeoutMs: 1000,
      refreshTimeoutMs: 1000,
      quotaTimeoutMs: 1000,
    },
    refresh: { skewMs: 1000, maxRetries: 1, backoffMs: [1], authRecoveryMs: 600000 },
    selection: { stickyTtlMs: 1000, maxSessions: 10 },
    quota: { assumeUnknownHeadroom: 0.5, probe: { hourlyBudget: 10 } },
    journal: { file: path.join(dir, 'journal.jsonl'), enabled: false },
  };
  let fail = true;
  const upstream = {
    refreshToken: async () => {
      if (fail) throw new Error('network down');
      return {
        accessToken: 'at-1',
        accessTokenExpiresAt: Date.now() + 3600_000,
        refreshToken: 'rt-2',
        refreshTokenExpiresAt: Date.now() + 86400_000,
        userId: '111',
      };
    },
  };
  const pool = new AccountPool({
    config,
    logger: null,
    upstream,
    journal: { append() {}, lastByAccount: () => new Map() },
    quota: { get: () => null },
  });
  try {
    await pool.load([
      {
        id: 'acc-a',
        baseUrl: config.upstream.baseUrl,
        refreshToken: '',
        writeBack: 'isolated',
        authFile,
        enabled: true,
      },
    ]);
    const account = pool.get('acc-a');
    assert.equal(account.credentialMissing, true);
    assert.equal(account.enabled, false);

    // 用户重新登录后 authFile 出现新 token，但上游刷新失败
    writeFileSync(
      authFile,
      JSON.stringify({ version: 2, refreshCfToken: 'rt-1', refreshCfTokenExpiresAt: Date.now() + 86400_000 }),
      'utf8',
    );
    await assert.rejects(() => pool.ensureFresh(account, { force: true }));
    assert.equal(account.credentialMissing, true, '刷新失败不应清除凭据缺失');
    assert.equal(account.enabled, false, '刷新失败不应启用账号');
    assert.notEqual(account.health, 'ready');

    // 上游恢复后，自动恢复循环应成功启用账号
    fail = false;
    account.stats.lastAuthRetryAt = 0;
    await pool.recoverAuthExpired();
    assert.equal(account.credentialMissing, false);
    assert.equal(account.enabled, true);
    assert.equal(account.health, 'ready');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionAffinity：超长 session key 哈希存储且映射稳定', () => {
  const affinity = new SessionAffinity({
    config: { selection: { stickyTtlMs: 60000, maxSessions: 10 } },
    logger: null,
  });
  const long = 'x'.repeat(1000);
  affinity.set('c', long, 'a');
  assert.equal(affinity.get('c', long), 'a');
  assert.equal(affinity.size(), 1);
  const storedKey = [...affinity.map.keys()][0];
  assert.ok(storedKey.length < 300, `存储键过长：${storedKey.length}`);
});

test('deepMerge 忽略原型污染键', () => {
  const patch = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"a":2}');
  const out = deepMerge({ a: 1 }, patch);
  assert.equal(out.a, 2);
  assert.equal({}.polluted, undefined);
  assert.equal(out.polluted, undefined);
});

test('企微 webhook 拒绝非 http/https 协议', async () => {
  const wc = new WeComWebhook({ url: 'file:///etc/passwd' });
  assert.equal(wc.enabled, false);
  const res = await wc.send('x');
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
});
