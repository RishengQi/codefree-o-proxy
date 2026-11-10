// 真实多账号验收：对运行中的池模式代理执行「双账号独立出流 + 故障切换」验证。
// 不修改上游数据，仅通过管理面冷却/恢复来驱动选号。
//
// 用法：
//   PROXY_BASE=http://127.0.0.1:8787 ADMIN_TOKEN=xxx node test/multi-account-acceptance.mjs
//   （ADMIN_TOKEN 也可从 .admin-token.txt 读取；或设置 CODEFREE_ADMIN_TOKEN）
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.PROXY_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ROOT = process.env.PROXY_ROOT || '<repo>';
const ADMIN_TOKEN =
  process.env.ADMIN_TOKEN ||
  process.env.CODEFREE_ADMIN_TOKEN ||
  (fs.existsSync(path.join(ROOT, '.admin-token.txt')) ? fs.readFileSync(path.join(ROOT, '.admin-token.txt'), 'utf8').trim() : '');
const MODEL = process.env.CF_MODEL || 'GLM-5.2';
const PROMPT = process.env.CF_PROMPT || '只回复两个字：收到';
const result = { base: BASE, model: MODEL, steps: [] };
const fail = (msg) => {
  result.ok = false;
  result.error = msg;
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'x-admin-token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}
async function usage() {
  const r = await admin('GET', '/admin/usage');
  if (r.status >= 400) throw new Error(`/admin/usage ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}
async function chat(sessionId) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      session_id: sessionId,
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, elapsedMs: Date.now() - t0, text };
}
function accountDeltas(before, after) {
  const map = new Map();
  for (const a of after.accounts) map.set(a.id, a.stats);
  const out = {};
  for (const a of before.accounts) {
    const now = map.get(a.id) || {};
    out[a.id] = {
      successes: (now.successes || 0) - (a.stats.successes || 0),
      requests: (now.requests || 0) - (a.stats.requests || 0),
      tokensIn: (now.tokensIn || 0) - (a.stats.tokensIn || 0),
      tokensOut: (now.tokensOut || 0) - (a.stats.tokensOut || 0),
    };
  }
  return out;
}
function usedAccount(deltas) {
  const ids = Object.entries(deltas).filter(([, d]) => d.successes > 0);
  if (ids.length === 0) return null;
  if (ids.length > 1) return ids.map(([id]) => id).join('+');
  return ids[0][0];
}
async function clearCooldowns(accounts) {
  for (const a of accounts) await admin('POST', `/admin/accounts/${encodeURIComponent(a.id)}/cooldown`, { clear: true });
}

// 1) 基础健康/账号/额度
const healthRes = await fetch(BASE + '/health');
const health = await healthRes.json();
result.health = { mode: health.mode, accounts: health.accounts, pool: health.pool };
if (health.mode !== 'pool') fail(`代理不是池模式（mode=${health.mode}）`);
const accounts = (await usage()).accounts;
if (!accounts || accounts.length < 2) fail('池内账号少于 2 个，无法做双号验收');
result.accounts = accounts.map((a) => ({ id: a.id, health: a.health }));
result.steps.push({ step: 'health', ok: true, accounts: accounts.length });

// 2) 主动探测额度
const probe = await admin('POST', '/admin/quota/probe', {});
if (probe.status >= 400) fail(`额度探测失败 HTTP ${probe.status}`);
result.quotaProbe = probe.json.results.map((r) => ({
  id: r.id,
  ok: r.ok,
  quotaStatus: r.snapshot?.quotaStatus,
  bypassed: r.snapshot?.bypassed,
  windows: r.snapshot?.windows ? Object.keys(r.snapshot.windows) : [],
  headroom: r.headroom,
}));
const probedIds = new Set(result.quotaProbe.map((r) => r.id));
if (!accounts.every((a) => probedIds.has(a.id))) fail('额度探测未覆盖全部账号');
result.steps.push({ step: 'quotaProbe', ok: true, count: result.quotaProbe.length });

// 3) 基线对话（自然选号）
let before = await usage();
let res1 = await chat('accept-baseline');
if (res1.status !== 200) fail(`基线对话失败 HTTP ${res1.status}: ${res1.text.slice(0, 300)}`);
let after = await usage();
let deltas = accountDeltas(before, after);
const baselineAccount = usedAccount(deltas);
result.baseline = { account: baselineAccount, elapsedMs: res1.elapsedMs, reply: extractText(res1.json) };
if (!baselineAccount) fail('基线对话未记录到账号用量（检查 /admin/usage）');
result.steps.push({ step: 'baselineChat', ok: true, account: baselineAccount });

// 4) 冷却基线账号，强制切换到另一个账号
const otherAccount = accounts.find((a) => a.id !== baselineAccount);
const cooldownA = await admin('POST', `/admin/accounts/${encodeURIComponent(baselineAccount)}/cooldown`, { ms: 120000, reason: 'acceptance-test' });
if (cooldownA.status >= 400) fail(`冷却账号失败 HTTP ${cooldownA.status}`);
before = await usage();
const res2 = await chat('accept-switch-' + Date.now());
if (res2.status !== 200) fail(`切换后对话失败 HTTP ${res2.status}: ${res2.text.slice(0, 300)}`);
after = await usage();
deltas = accountDeltas(before, after);
const switchedAccount = usedAccount(deltas);
result.forcedSwitch = { cooled: baselineAccount, expected: otherAccount.id, actual: switchedAccount, elapsedMs: res2.elapsedMs, reply: extractText(res2.json) };
if (switchedAccount !== otherAccount.id) fail(`切换失败：预期 ${otherAccount.id}，实际 ${switchedAccount}`);
result.steps.push({ step: 'forcedSwitch', ok: true, from: baselineAccount, to: switchedAccount });

// 5) 反向验证：冷却另一个账号，切回
await admin('POST', `/admin/accounts/${encodeURIComponent(switchedAccount)}/cooldown`, { ms: 120000, reason: 'acceptance-test' });
await admin('POST', `/admin/accounts/${encodeURIComponent(baselineAccount)}/cooldown`, { clear: true });
before = await usage();
const res3 = await chat('accept-switch-back-' + Date.now());
if (res3.status !== 200) fail(`切回对话失败 HTTP ${res3.status}: ${res3.text.slice(0, 300)}`);
after = await usage();
deltas = accountDeltas(before, after);
const backAccount = usedAccount(deltas);
result.switchBack = { expected: baselineAccount, actual: backAccount, elapsedMs: res3.elapsedMs, reply: extractText(res3.json) };
if (backAccount !== baselineAccount) fail(`切回失败：预期 ${baselineAccount}，实际 ${backAccount}`);
result.steps.push({ step: 'switchBack', ok: true, to: backAccount });

// 6) 清理冷却
await clearCooldowns(accounts);
const finalUsage = await usage();
result.finalCooldowns = finalUsage.accounts.map((a) => ({ id: a.id, health: a.health, cooldownMsLeft: a.cooldownMsLeft }));
result.ok = true;
console.log(JSON.stringify(result, null, 2));

function extractText(json) {
  try {
    return json.choices?.[0]?.message?.content ?? '';
  } catch {
    return '';
  }
}
