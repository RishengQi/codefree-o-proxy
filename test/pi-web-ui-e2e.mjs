// pi-web UI 交互式端到端验收：真实浏览器操作 pi-web 界面
//   打开项目 → 会话 → 打开模型选择器（确认 codefree 模型）→ 输入 prompt → 发送 → 等待回复
// 截图默认写入 docs/evidence/。
//
// 前置：
//   1. pi-web 已启动（web 8504 + sessiond）
//   2. 代理已启动且已执行 scripts/setup-pi-web.ps1
//   3. 已存在一个名为 codefree-e2e 的项目（或通过 PROJECT_TEXT 指定）
//
// 用法：
//   node test/pi-web-ui-e2e.mjs
//   PI_WEB_PASSWORD=xxx PROMPT="只回复两个字：收到" node test/pi-web-ui-e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9449);
const BASE = (process.env.PI_WEB_BASE || 'http://127.0.0.1:8504').replace(/\/+$/, '');
const PASSWORD = process.env.PI_WEB_PASSWORD || 'change-me';
const PROJECT_TEXT = process.env.PROJECT_TEXT || 'codefree-e2e';
const PROMPT = process.env.PROMPT || '只回复两个字：收到';
const OUT_DIR = process.env.OUT_DIR || path.resolve(import.meta.dirname, '..', 'docs', 'evidence');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const result = { base: BASE, project: PROJECT_TEXT, prompt: PROMPT, steps: [] };
const fail = (msg) => {
  result.ok = false;
  result.error = msg;
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
};
fs.mkdirSync(OUT_DIR, { recursive: true });

// 1) 获取登录 cookie（普通模式）
let cookie = process.env.PI_WEB_COOKIE || '';
if (!cookie) {
  const login = await fetch(`${BASE}/api/normal-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (login.status >= 400) fail(`普通模式登录失败 HTTP ${login.status}（检查 PI_WEB_PASSWORD）`);
  const setCookie = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  cookie = setCookie[0].split(';')[0].split('=')[1];
}

// 2) 启动无头 Chrome + CDP
const userDir = path.join(process.env.TEMP, 'pi-web-ui-e2e-' + Date.now());
const child = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  '--remote-allow-origins=*',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1600,1000',
  '--user-data-dir=' + userDir,
  'about:blank',
], { stdio: 'ignore' });

let targets;
for (let i = 0; i < 80; i++) {
  await sleep(400);
  try {
    targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    if (targets?.length) break;
  } catch {}
}
if (!targets?.length) {
  child.kill();
  fail('Chrome CDP 未就绪');
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const cdp = (method, params = {}) =>
  new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 1000));
  return r.result?.result?.value;
};
const closeBrowser = () => { try { ws.close(); } catch {} child.kill(); };

try {
  await cdp('Network.enable');
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.setCookie', { name: 'pi_web_normal_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true });
  await cdp('Page.navigate', { url: BASE + '/' });
  await sleep(12000);

  // 安装 shadow DOM 元素收集器
  await evaluate(`(() => {
    window.__pwCollect = () => {
      const out = []; window.__pwItems = [];
      const walk = (root, depth) => {
        if (!root || depth > 14 || out.length > 2500) return;
        const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const el of nodes) {
          if (!el.isConnected) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2 || rect.left < 0 || rect.top < 0) { if (el.shadowRoot) walk(el.shadowRoot, depth + 1); continue; }
          const own = Array.from(el.childNodes || []).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(' ');
          const aria = el.getAttribute?.('aria-label') || '';
          const ph = el.getAttribute?.('placeholder') || '';
          const role = el.getAttribute?.('role') || '';
          const title = el.getAttribute?.('title') || '';
          const ce = el.getAttribute?.('contenteditable') || '';
          const label = (own || aria || ph || title).slice(0, 120);
          if (label || role || ce || el.tagName.includes('-')) {
            out.push({ idx: out.length, tag: el.tagName.toLowerCase(), role, ce, label, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height), depth });
            window.__pwItems.push(el);
          }
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        }
      };
      walk(document, 0);
      return out;
    };
    return true;
  })()`);
  const collect = () => evaluate('window.__pwCollect()');
  const click = async (item) => {
    const { x, y } = item;
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const shot = async (name) => {
    const s = await cdp('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT_DIR, name + '.png');
    if (s.result?.data) fs.writeFileSync(p, Buffer.from(s.result.data, 'base64'));
    return p;
  };
  const escape = async () => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  };
  const bubbles = async () => (await collect()).filter((i) => i.tag === 'p' && i.label).map((i) => i.label);
  const sendStart = Date.now();

  // 3) 打开项目（自动进入上次会话）
  let items = await collect();
  const project = items.find((i) => i.tag === 'bdi' && i.label.includes(PROJECT_TEXT)) || items.find((i) => i.label.includes(PROJECT_TEXT));
  if (!project) fail(`未找到项目「${PROJECT_TEXT}」（先在 pi-web 里注册项目，或设置 PROJECT_TEXT）`);
  await click(project);
  await sleep(3000);
  items = await collect();
  const modelBtn = items.find((i) => /codefree\s*\/\s*\w/.test(i.label));
  if (!modelBtn) fail('项目会话页未找到模型按钮（会话未打开？）');
  const sessionShot = await shot('pi-web-ui-session');
  result.steps.push({ step: 'session', ok: true, modelButton: modelBtn.label, screenshot: sessionShot });

  // 4) 模型选择器：确认 codefree 模型清单
  await click(modelBtn);
  await sleep(1500);
  const pickerShot = await shot('pi-web-ui-model-picker');
  const pickerItems = (await collect()).filter((i) => i.label && /codefree|GLM-5\.2|Qwen3\.8|DeepSeek/i.test(i.label));
  const pickerLabels = pickerItems.map((i) => i.label);
  const hasCodefree = pickerLabels.some((l) => /codefree/i.test(l)) || pickerLabels.some((l) => /GLM-5\.2/.test(l));
  result.steps.push({ step: 'modelPicker', ok: hasCodefree, screenshot: pickerShot, labels: [...new Set(pickerLabels)].slice(0, 20) });
  if (!hasCodefree) fail('模型选择器未出现 codefree 模型（检查 scripts/setup-pi-web.ps1 与项目注册表）');
  await escape();
  await sleep(800);

  // 5) 记录当前消息数，输入并发送
  const beforeBubbles = await bubbles();
  items = await collect();
  const composer = items.find((i) => i.role === 'textbox' && i.ce === 'true');
  if (!composer) fail('未找到消息输入框');
  await click(composer);
  await sleep(400);
  await cdp('Input.insertText', { text: PROMPT });
  await sleep(600);
  items = await collect();
  const sendBtn = items.find((i) => i.label === '发送消息');
  if (sendBtn) await click(sendBtn);
  else {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
  result.steps.push({ step: 'send', ok: true, via: sendBtn ? 'button' : 'enter', beforeMessages: beforeBubbles.length });

  // 6) 等待回复：消息数增加且出现新的助手气泡
  let replied = false;
  let lastBubbles = beforeBubbles;
  for (let i = 0; i < 90 && !replied; i++) {
    await sleep(1000);
    lastBubbles = await bubbles();
    const newOnes = lastBubbles.slice(beforeBubbles.length);
    const hasUser = newOnes.some((b) => b.includes(PROMPT.slice(0, 6)));
    const hasReply = newOnes.some((b) => b.replace(/\s/g, '').length > 0 && !b.includes(PROMPT.slice(0, 6)));
    if (hasUser && hasReply) replied = true;
  }
  const chatShot = await shot('pi-web-ui-chat');
  result.steps.push({
    step: 'reply',
    ok: replied,
    elapsedMs: Date.now() - sendStart,
    screenshot: chatShot,
    newMessages: lastBubbles.slice(beforeBubbles.length),
  });
  if (!replied) fail('等待 pi-web UI 回复超时');
  result.ok = true;
} catch (e) {
  result.ok = false;
  result.error = String(e?.message || e);
} finally {
  closeBrowser();
}
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
