// pi-web 运行时端到端测试：驱动真实的 pi-web 服务（web + sessiond），
// 用 codefree 提供器完成一次真实会话，验证「pi-web → 本代理 → srdcloud」全链路。
//
// 前置：
//   1. 代理已启动（默认 http://127.0.0.1:8787），且已执行 scripts/setup-pi-web.ps1
//   2. pi-web 已启动：npm start + npm run start:sessiond
//      （Windows 需设置 PI_WEB_SESSIOND_PORT=8511、PI_WEB_SESSIOND_HOST=127.0.0.1）
//   3. 首次运行 pi-web 需设置普通模式口令；脚本会自动 setup/login
//
// 用法：
//   node test/pi-web-runtime-e2e.mjs
//   PI_WEB_BASE=http://127.0.0.1:8504 PI_WEB_PASSWORD=xxx node test/pi-web-runtime-e2e.mjs
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.PI_WEB_BASE || 'http://127.0.0.1:8504').replace(/\/+$/, '');
const PASSWORD = process.env.PI_WEB_PASSWORD || 'change-me';
const PROVIDER = process.env.CF_PROVIDER || 'codefree';
const MODEL = process.env.CF_MODEL || 'GLM-5.2';
const PROMPT = process.env.CF_PROMPT || '只回复两个字：收到';
const result = { base: BASE, provider: PROVIDER, model: MODEL, steps: [] };
const fail = (msg) => {
  result.ok = false;
  result.error = msg;
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
};

let authHeader = {};
let cookie = '';
async function api(method, apiPath, body) {
  const headers = { 'Content-Type': 'application/json', ...authHeader, ...(cookie ? { Cookie: cookie } : {}) };
  const res = await fetch(BASE + apiPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}
async function must(method, apiPath, body, label) {
  const r = await api(method, apiPath, body);
  if (r.status >= 400) {
    throw new Error(`${label || apiPath} 失败 HTTP ${r.status}: ${String(r.text).slice(0, 500)}`);
  }
  return r.json;
}

// 1) 认证：优先 Bearer 口令；未设置口令则 setup
try {
  const st = await api('GET', '/api/normal-auth/status');
  result.steps.push({ step: 'authStatus', status: st.status, body: st.json });
  if (st.json?.configured === false) {
    const setup = await api('POST', '/api/normal-auth/setup', { password: PASSWORD });
    if (setup.status >= 400) throw new Error(`口令设置失败 HTTP ${setup.status}: ${setup.text.slice(0, 300)}`);
    result.steps.push({ step: 'authSetup', ok: true });
  }
  authHeader = { Authorization: `Bearer ${PASSWORD}` };
  // 校验授权
  const check = await api('GET', '/api/projects');
  if (check.status === 401) {
    cookie = '';
    authHeader = {};
    const login = await api('POST', '/api/normal-auth/login', { password: PASSWORD });
    if (login.status >= 400) throw new Error(`普通模式登录失败 HTTP ${login.status}: ${login.text.slice(0, 300)}`);
    result.steps.push({ step: 'authLogin', ok: true, via: 'cookie' });
  } else {
    result.steps.push({ step: 'authCheck', ok: true, via: 'bearer' });
  }
} catch (e) {
  fail(`认证阶段失败：${e.message}`);
}

// 2) 运行时状态（确认 sessiond 已连接）
let runtime;
try {
  runtime = await must('GET', '/api/pi-web/runtime', undefined, 'runtime');
  const sessiond = runtime?.components?.sessiond;
  result.runtime = {
    web: runtime?.components?.web?.available,
    sessiond: sessiond?.available,
    sessiondVersion: sessiond?.runtimeVersion,
    piVersion: runtime?.components?.web?.piVersion,
  };
  result.steps.push({ step: 'runtime', ok: true, sessiondAvailable: sessiond?.available });
  if (sessiond && sessiond.available === false) fail('pi-web sessiond 不可用（检查 PI_WEB_SESSIOND_PORT 与 sessiond 进程）');
} catch (e) {
  fail(`运行时状态获取失败：${e.message}`);
}

// 3) 注册项目
const projectDir = process.env.PI_WEB_PROJECT || mkdtempSync(path.join(os.tmpdir(), 'pi-web-e2e-'));
mkdirSync(projectDir, { recursive: true });
let project;
try {
  const projects = await must('GET', '/api/projects', undefined, 'projects');
  project = Array.isArray(projects) ? projects.find((p) => p.path === projectDir) : undefined;
  if (!project) {
    project = await must('POST', '/api/projects', { name: 'codefree-e2e', path: projectDir, create: true }, 'addProject');
  }
  result.project = { id: project.id, path: project.path };
  result.steps.push({ step: 'project', ok: true, id: project.id });
} catch (e) {
  fail(`注册项目失败：${e.message}`);
}

// 4) 创建会话
let session;
try {
  session = await must('POST', '/api/sessions', { cwd: projectDir }, 'createSession');
  const sessionId = session?.sessionId || session?.id || session?.session?.id;
  if (!sessionId) throw new Error(`创建会话返回缺少 sessionId：${JSON.stringify(session).slice(0, 400)}`);
  result.sessionId = sessionId;
  result.steps.push({ step: 'session', ok: true, sessionId });
} catch (e) {
  fail(`创建会话失败：${e.message}`);
}
const sessionId = result.sessionId;
const cwdQuery = `?cwd=${encodeURIComponent(projectDir)}`;

// 5) 检查模型注册表并选择模型
try {
  const catalog = await api('GET', `/api/sessions/${sessionId}/models/catalog${cwdQuery}`);
  const catalogJson = catalog.json;
  const ids = JSON.stringify(catalogJson);
  const hasProvider = ids.includes(PROVIDER);
  const hasModel = ids.includes(MODEL);
  result.modelsCatalog = { status: catalog.status, hasProvider, hasModel, sample: ids.slice(0, 400) };
  if (!hasProvider || !hasModel) {
    fail(`项目模型注册表缺少 ${PROVIDER}/${MODEL}。请先运行 scripts/setup-pi-web.ps1 并用全新项目测试。目录：${projectDir}`);
  }
  const selection = await api('POST', `/api/sessions/${sessionId}/model`, { cwd: projectDir, provider: PROVIDER, modelId: MODEL });
  result.modelSelection = { status: selection.status, body: selection.json };
  if (selection.status >= 400) {
    fail(`选择模型失败 HTTP ${selection.status}: ${String(selection.text).slice(0, 400)}`);
  }
  result.steps.push({ step: 'model', ok: true, provider: PROVIDER, model: MODEL });
} catch (e) {
  fail(`模型选择阶段失败：${e.message}`);
}

// 6) 发送 prompt 并轮询回复
try {
  const t0 = Date.now();
  const promptRes = await api('POST', `/api/sessions/${sessionId}/prompt`, { cwd: projectDir, text: PROMPT });
  if (promptRes.status >= 400) fail(`发送 prompt 失败 HTTP ${promptRes.status}: ${String(promptRes.text).slice(0, 400)}`);
  result.steps.push({ step: 'prompt', ok: true });

  const extractText = (messages) => {
    const arr = Array.isArray(messages) ? messages : Array.isArray(messages?.messages) ? messages.messages : [];
    const parts = [];
    for (const m of arr) {
      const role = m?.role || m?.info?.role;
      const content = m?.content ?? m?.parts ?? m?.message?.content;
      const collect = (c) => {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || x?.content || '')).join('');
        if (c && typeof c === 'object') return c.text || '';
        return '';
      };
      const text = collect(content);
      if (text) parts.push({ role, text });
    }
    return { arr, parts };
  };

  let last;
  let replied = false;
  for (let i = 0; i < 90 && !replied; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await api('GET', `/api/sessions/${sessionId}/messages${cwdQuery}&limit=50`);
    last = r;
    if (r.status >= 400) continue;
    const { parts } = extractText(r.json);
    const assistant = parts.filter((p) => p.role === 'assistant');
    if (assistant.some((p) => p.text.includes('收到') || p.text.trim().length > 0)) {
      result.reply = assistant.map((p) => p.text).join('\n');
      result.messages = parts;
      result.elapsedMs = Date.now() - t0;
      result.steps.push({ step: 'reply', ok: true, elapsedMs: result.elapsedMs });
      replied = true;
    }
  }
  if (!result.reply) {
    fail(`等待回复超时（90s）。最后响应 HTTP ${last?.status}: ${String(last?.text || '').slice(0, 500)}`);
  }
} catch (e) {
  fail(`对话阶段失败：${e.message}`);
}

result.ok = true;
result.projectDir = projectDir;
console.log(JSON.stringify(result, null, 2));
