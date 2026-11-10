// pi-web / Pi SDK 兼容性测试：用 pi-web 依赖的 @earendil-works/pi-coding-agent ModelRuntime，
// 按 pi-web 的 models.json 格式接入本机 CodeFree-O 代理，做真实流式对话 + 工具调用验证。
//
// 用法：
//   node test/pi-web-compat.mjs                       # 默认代理 http://127.0.0.1:8788
//   PI_WEB_DIR=D:\...\pi-web-ChineseTranslation node test/pi-web-compat.mjs
//   PROXY_BASE=http://127.0.0.1:8787 node test/pi-web-compat.mjs
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PI_WEB_DIR = process.env.PI_WEB_DIR || '<pi-web-repo>';
const PROXY_BASE = (process.env.PROXY_BASE || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const MODEL_ID = process.env.CF_MODEL || 'GLM-5.2';
const PROVIDER = 'codefree';

const results = { proxy: PROXY_BASE, provider: PROVIDER, model: MODEL_ID, steps: [] };
const fail = (msg) => {
  results.ok = false;
  results.error = msg;
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
};

// 1) 准备 agentDir：auth.json + models.json（pi-web ProjectAuthService 使用的同款结构）
const agentDir = mkdtempSync(path.join(os.tmpdir(), 'pi-web-compat-'));
mkdirSync(agentDir, { recursive: true });
writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({}), 'utf8');
const modelsJson = {
  providers: {
    [PROVIDER]: {
      name: 'CodeFree-O Proxy',
      baseUrl: `${PROXY_BASE}/v1`,
      apiKey: process.env.CF_API_KEY || 'codefree-local',
      api: 'openai-completions',
      models: [
        {
          id: MODEL_ID,
          name: MODEL_ID,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 184000,
          maxTokens: 16000,
        },
      ],
    },
  },
};
writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(modelsJson, null, 2), 'utf8');
results.agentDir = agentDir;

// 2) 用 pi-web 依赖的 Pi SDK 创建 ModelRuntime
const sdkEntry = path.join(PI_WEB_DIR, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
let sdk;
try {
  sdk = await import(new URL(`file://${sdkEntry.replace(/\\/g, '/')}`).href);
} catch (e) {
  fail(`无法加载 pi-web 的 Pi SDK（${sdkEntry}）：${e.message}`);
}
const { ModelRuntime } = sdk;
if (!ModelRuntime) fail('Pi SDK 未导出 ModelRuntime');

const runtime = await ModelRuntime.create({
  authPath: path.join(agentDir, 'auth.json'),
  modelsPath: path.join(agentDir, 'models.json'),
  allowModelNetwork: false,
});
const model = runtime.getModel(PROVIDER, MODEL_ID);
if (!model) fail(`ModelRuntime 未识别模型 ${PROVIDER}/${MODEL_ID}`);
results.modelResolved = { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl };
results.steps.push({ step: 'modelRuntime', ok: true });

// 3) 流式对话：验证 SSE 解析、文本增量、结束事件、usage
async function streamChat(context, label) {
  const events = [];
  let text = '';
  let thinking = '';
  const toolCalls = [];
  let done = null;
  let error = null;
  const stream = runtime.stream(model, context);
  for await (const event of stream) {
    events.push(event.type);
    if (event.type === 'text_delta') text += event.delta;
    else if (event.type === 'thinking_delta') thinking += event.delta;
    else if (event.type === 'toolcall_end') toolCalls.push(event.toolCall);
    else if (event.type === 'done') done = event;
    else if (event.type === 'error') error = event.error;
  }
  const finalMessage = await stream.result();
  return { label, events, text, thinking, toolCalls, doneReason: done?.reason, error, usage: finalMessage?.usage, content: finalMessage?.content };
}

const ctx1 = {
  systemPrompt: '你是简洁助手。',
  messages: [{ role: 'user', content: '只回复两个字：收到', timestamp: Date.now() }],
};
const chat1 = await streamChat(ctx1, 'plain-stream');
results.steps.push({
  step: 'plainStream',
  ok: !chat1.error && typeof chat1.text === 'string' && chat1.text.trim().length > 0,
  text: chat1.text,
  eventTypes: [...new Set(chat1.events)],
  doneReason: chat1.doneReason,
  usage: chat1.usage,
});
if (!results.steps.at(-1).ok) {
  fail(`流式对话失败：${chat1.error?.errorMessage || '无文本返回'}（事件：${chat1.events.join(',')}）`);
}

// 4) 工具调用：验证 OpenAI tools 透传与 tool_calls 流式解析
const tools = [
  {
    name: 'get_weather',
    description: '查询指定城市的天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
  },
];
const ctx2 = {
  systemPrompt: '你必须使用提供的工具来获取信息，不要凭空回答。',
  messages: [{ role: 'user', content: '帮我查一下南宁现在的天气，请调用工具。', timestamp: Date.now() }],
  tools,
};
const chat2 = await streamChat(ctx2, 'tool-call');
const toolOk = !chat2.error && chat2.toolCalls.length > 0;
results.steps.push({
  step: 'toolCall',
  ok: toolOk,
  toolCalls: chat2.toolCalls,
  text: chat2.text,
  eventTypes: [...new Set(chat2.events)],
  error: chat2.error?.errorMessage,
  usage: chat2.usage,
});
if (!toolOk) fail(`工具调用未通过：${chat2.error?.errorMessage || '模型未返回 toolCall'}`);

// 5) 工具结果回传后继续对话（pi-web agent 循环的关键路径）
const call = chat2.toolCalls[0];
ctx2.messages.push({
  role: 'assistant',
  content: chat2.content,
  timestamp: Date.now(),
});
ctx2.messages.push({
  role: 'toolResult',
  toolCallId: call.id,
  toolName: call.name,
  content: [{ type: 'text', text: '南宁：晴，26℃，东南风 2 级' }],
  isError: false,
  timestamp: Date.now(),
});
const chat3 = await streamChat(ctx2, 'after-tool');
results.steps.push({
  step: 'afterToolResult',
  ok: !chat3.error && chat3.text.trim().length > 0,
  text: chat3.text,
  eventTypes: [...new Set(chat3.events)],
  usage: chat3.usage,
});
if (!results.steps.at(-1).ok) fail(`工具结果续跑失败：${chat3.error?.errorMessage || '无文本返回'}`);

results.ok = true;
console.log(JSON.stringify(results, null, 2));
