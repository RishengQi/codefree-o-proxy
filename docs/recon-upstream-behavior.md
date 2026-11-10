# CodeFree-O Desktop 1.10.1 上游请求 / SSE / 重试行为侦察报告

| 项 | 内容 |
|----|------|
| 分析对象 | CodeFree-O Desktop 1.10.1（Electron 主进程 + opencode 内核 bundle） |
| 分析材料（只读） | `%USERPROFILE%\AppData\Local\Temp\codefree-asar\out\main\chunks\node-CC-GAWt2.js`（714,556 行，32.8MB）；`out\renderer\assets\main-DYeEwXNf.js`（桌面端渲染层，用于确认 `x-codefree-o-client` 取值） |
| 证据坐标 | 行号均为上述解包 bundle 的当前行号（随客户端版本变化，升级后需复核）；`node-CC-GAWt2.js:NNN` 指该文件第 NNN 行 |
| 方法 | 纯静态检索（grep/read）+ 与工作区代理代码逐段对照；未运行 GUI、未发起真实上游请求、未改动任何代码 |
| 对照对象 | `<repo>` 工作区快照（**2026-11-10 15:45 读取**；该仓库正由其他成员并行迭代，行号以该时刻为准） |
| 结论定位 | 补充 `docs/optimization-backlog.md` 的协议证据；不替代其中的优化实施记录 |

---

## 0. 摘要（TL;DR）

1. **CodeFree 聊天走 AI SDK `@ai-sdk/openai-compatible`**：`buildCodefreeOptions()` 注入自定义 `fetch`，把 SDK 发出的 `POST {baseUrl}/chat/completions` 重写为 **`POST {baseUrl}/api/acbackend/codechat/v1/completions`**（`node-CC-GAWt2.js:464373-464404`，尤其 `464381-464385`）。这关闭了既有设计文档的 OQ-5。
2. **超时是"两段式"而非"总时长"**：请求头 300s + **每块 SSE 数据 300s 空闲**超时，没有整请求总超时（`466018-466046`、`464292-464334`）。代理当前用单一 `AbortSignal.timeout(300000)` 覆盖整个响应体（`lib/upstream.mjs:54`），会把**超过 5 分钟的流式回答硬切**——这是当前最大的行为偏差（P0-1）。
3. **桌面链路真实 `subService` 是 `codefree_o_desktop_chat`**（`x-codefree-o-client: codefree-o-desktop` → `PRODUCT_BY_CLIENT`，`node-CC-GAWt2.js:414149-414220`；渲染层取值见 `main-DYeEwXNf.js:162307`、`54362-54371`），而代理默认 `codefree_o_chat`（`lib/config.mjs:28`）。归属/计量口径不一致（P0-2）。
4. **SSE 内额度耗尽不是"仅提示"**：app 检测到 `AI_QUOTA_EXHAUSTED` 帧后**取消 reader、以带 code 的错误终止流**，并保留已产出内容（`459635-459716`）。代理只记快照、继续透传（`server.mjs:344-351`），客户端会误以为正常结束且账号不冷却（P0-3）。
5. **重试分三层，CodeFree 聊天实际只吃"会话级重试"**：AI SDK 层 `maxRetries = input.retries ?? 0`（`485068`，即 0）；会话级 `RETRY_MAX_RETRIES=5`、2s 指数 + 25% 抖动、解析 `retry-after(-ms)`/HTTP-date（`485165-485195`、`485313`）；但 **provider 为 `codefree` 且状态 429 时明确不重试**（`485203-485204`）。`RequestExecutor` 的 429/503/504/529 重试属于 native LLM 通道，不用于 CodeFree 聊天（`55332-55359`、`55539-55542`）。
6. **Token 刷新并发保护完整**：60s 提前量 + `refreshPromise` 单飞 + `authRevision`/`clearPromise` 双闸 + 写盘前后校验 + `0o600` 加密落盘 + "他人已轮换则重读存储再试一次"（`395391-395475`、`395814-395846`）。代理在单飞/回读/加密写回上已对齐，差异见 §4。
7. **SSE usage 由 app 强制索取**：`stream_options:{include_usage:true}` 对 openai-compatible 恒定注入（`465979-465981` + `273643-273647`），最终 chunk 的 `usage` 在 `finish` 时进入 token 记账（`273703-273705`、`273892-273897`、`467915-467976`）。代理当前依赖"上游默认返回 usage"，未注入该字段（P1）。

---

## 1. Chat 请求构造

### 1.1 调用链拓扑

| 阶段 | 代码位置 | 行为 |
|------|----------|------|
| 会话层组装 | `484663-484794` | 合并 model/agent/variant options；生成 `prepared.headers`（含 `x-session-affinity`、`X-Session-Id`、`User-Agent`）与 CodeFree 专用本地头（`x-codefree-sub-service`、`x-codefree-request-purpose`） |
| AI SDK streamText | `484967-485093` | `streamText({ ..., maxRetries: input.retries ?? 0, headers: headers82 })`；headers 覆盖 `clientType/clientVersion` 等 provider 级头 |
| provider 配置 | `464455-464465` | `apiKey: OAUTH_DUMMY_KEY`、`baseURL: cred.baseUrl`、`headers: { clientType:"codefree-o", clientVersion:"1.10.1" }`、`fetch: fetcher` |
| url/头重写 | `464373-464404` | `/chat/completions` → `/api/acbackend/codechat/v1/completions`；`/embeddings` → `/api/aebackend/codefree-embedding-svc/v1/text-to-embedding-vector`；追加 `X-Codefree-Quota-Schema/modelName/sessionId/subService/codefreeClient` |
| 签名与重放 | `396393-396439` | 缓冲 body → 设 `X-Cf-Token/userId/projectId` + `X-Cf-*` 签名 → 删除 `Authorization/apiKey` → 发送；401 时刷新并**用同一 body 重放一次** |
| 超时包装 | `466018-466046` | headers 超时 300s + SSE 逐块空闲 300s；`fetch(..., { timeout:false })` 关闭 undici 默认超时 |

### 1.2 出站请求头全清单

| 头 | 取值 / 来源 | 是否发出上游 | 证据 |
|----|-------------|--------------|------|
| `clientType` | 固定 `codefree-o` | 是 | `464461` |
| `clientVersion` | `InstallationVersion` = `1.10.1`（`68785`），同时用于 modelmgr 路径 | 是 | `464462`、`461381` |
| `Authorization` | `Bearer opencode-oauth-dummy-key`（占位）→ 发送前**删除** | 否 | `402744`、`273398`、`396431` |
| `X-Codefree-Quota-Schema` | 固定 `1`，仅 chat | 是 | `464394-464395` |
| `modelName` | `body.model` | 是 | `464399-464400` |
| `subService` | OAuth 模式：本地 `x-codefree-sub-service` → 默认 `resolveSubService()`；environment 模式：`codefree_o_sandbox_chat` | 是 | `464401-464402`、`414181-414220` |
| `codefreeClient` | 固定 `codefreeo` | 是 | `464403` |
| `sessionId` | 来自入站 `x-session-affinity` | 是 | `464396-464398` |
| `x-session-affinity` / `X-Session-Id` | 会话层原样携带，未删除 | 是（双份） | `484782-484786` |
| `User-Agent` | `opencode/1.10.1` + AI SDK 后缀（`ai-sdk/openai-compatible/<v>`、`ai-sdk/provider-utils/<v>` 等按序空格拼接） | 是 | `484677`、`484781`、`209811-209816`、`273401`、`211350-211353` |
| `X-Cf-Token` / `userId` / `projectId` | token.cfToken / token.userId / 固定 `"0"` | 是 | `396417-396424` |
| `X-Cf-AppId/Timestamp/Nonce/Signature` | HMAC-SHA256(`${METHOD}\n${appId}\n${ts秒}\n${nonce}`)，密钥硬编码 `HJhz…9n4=` | 是 | `394684-394703` |
| `Content-Type` | `application/json` | 是 | `211300-211321` |
| `x-codefree-request-purpose` | 本地头：agent 名 `title` → `title`，否则 `answer`；**发送前删除** | 否（仅本地判定） | `459810`、`484973-484975`、`464391-464393` |
| `x-codefree-sub-service` | 本地头，发送前删除并折叠为 `subService` | 否 | `464401-464402` |
| `x-parent-session-id` / agent chain 头 | 子会话/子代理链路透传 | 是 | `484787-484790` |

> environment 模式（`SRDCLOUD_*` 环境变量托管）不发签名头，改发 `accessToken/userId/projectId`，且 401 直接抛错不刷新（`396444-396477`）。

### 1.3 请求体字段

| 字段 | 值/构造 | 证据 |
|------|---------|------|
| `model` | `model.api.id`（=`modelName`） | `273529` |
| `messages` | system + 历史消息；assistant 携带 `reasoning_content`（interleaved 字段）与 `tool_calls` | `273090-273169`、`461446` |
| `tools` / `tool_choice` | 由 opencode tool 定义转换，**按名称字典序排序**后下发 | `273521-273524`、`484771-484772` |
| `temperature` / `top_p` | 依模型族规则（CLAUDE 系不带；GLM-4.6/4.7、minimax-m2、kimi-k2 thinking 等取 1；其余缺省） | `460305-460338`、`484736-484738` |
| `max_tokens` | `min(model.limit.output, 32000) \|\| 32000`；CodeFree 模型 `limit.output=0` → 恒为 **32000** | `460991-460993`、`461422-461426` |
| `stream` | 恒 `true`（会话聊天只走流式） | `273643-273647` |
| `stream_options.include_usage` | **恒 `true`**（openai-compatible 强制） | `465979-465981`、`273646` |
| `reasoning_effort` | codefree 的 variants 为空 → 不下发 | `460515-460520` |
| `chat_template_kwargs.enable_thinking` | **小模型/title 请求**附加 `{enable_thinking:false}` | `460955-460957` |
| 其它 provider options | 未在 openai-compatible schema 白名单中的键原样展开进 body（如 `accessMode`） | `273547-273552`、`274355-274360`、`461413` |

### 1.4 超时与中断语义（与代理差异的关键）

| 机制 | App 行为 | 证据 |
|------|----------|------|
| headers 超时 | 300,000ms；超时抛 `HeaderTimeoutError`（`ProviderHeaderTimeoutError`），被归类为**可重试** | `466018-466027`、`402963-402974`、`415061-415069` |
| SSE 逐块空闲超时 | 300,000ms；仅在 `content-type: text/event-stream` 且 `res.body` 存在时启用；某次 `reader.read()` 超时即 `ResponseStreamError("SSE read timed out")`，同样**可重试** | `464292-464334`、`466044-466046`、`415070-415077` |
| 整请求总超时 | **没有**（会话聊天未传 `timeout` 选项） | `485028-485093`（无 `timeout` 键） |
| Abort 传播 | 会话停止/退出时通过 Scope finalizer `ctrl.abort(reason)` → `abortSignal` → fetch 中止 | `485096-485104`、`486017-486021` |
| undici 默认超时 | 显式 `timeout:false` 关闭，只依赖上述自管理超时 | `466040-466043` |
| 非流式响应 | 不享受 chunk 空闲超时（`wrapSSE2` 只包 `text/event-stream`） | `464293-464298` |

> **结论**：代理的 `requestTimeoutMs=300000`（`config.json:21`；`lib/upstream.mjs:54` 的 `AbortSignal.timeout`）在语义上等价于"整请求总超时 5 分钟"，而不是 app 的"首包 5 分钟 + 空闲 5 分钟"。长时间生成（大 diff、长工具链）必然被切断。

---

## 2. SSE 消费与 usage

### 2.1 帧解析

| 环节 | App 行为 | 证据 |
|------|----------|------|
| 解码/分行 | `TextDecoderStream` → `EventSourceParserStream`（标准 SSE：多 `data:` 行合并、忽略注释/空行） | `210826-210838` |
| `[DONE]` | 直接跳过，不产生事件 | `210831-210834` |
| JSON 解析失败 | 产出 `{success:false}` chunk → 上层转 `error` incident（`finishReason="error"`） | `210835`、`273681-273693` |
| 业务错误帧 | chunk schema 是 union：`{id,choices,usage}` 或 `{error:{message,type,param,code}}`；后者转成 `error` incident 并**终止流（Effect.fail）** | `274343-274354`、`274401-274428` | 
| 帧内 `finish_reason:"network_error"` | 特殊处理为 `ResponseStreamError`（可重试） | `467943-467945` |
| CodeFree 额度帧 | 独立旁路解析（不改写帧）：按空行切帧 → 收集 `data:` 行 → `[DONE]` 跳过 → `parseCodefreeQuotaExhausted/parseCodefreeQuotaWarning` | `459718-459759` |

### 2.2 增量事件映射（AI SDK openai-compatible）

| 上游 delta | 客户端事件 | 备注 | 证据 |
|------------|-----------|------|------|
| `delta.reasoning_content`（或 `delta.reasoning`） | `reasoning-start` / `reasoning-delta`（id `reasoning-0`） | 首个 reasoning 前自动补 start；遇到 content/tool_calls 时补 end | `273717-273748`、`273750-273757` |
| `delta.content` | `text-start` / `text-delta`（id `txt-0`） | — | `273732-273749` |
| `delta.tool_calls[]` | `tool-input-start/delta`；`arguments` 成为可解析 JSON 时才发 `tool-input-end` + `tool-call` | 首帧要求 `id` 与 `function.name` 非空，否则抛 `InvalidResponseDataError` | `273750-273853`、`273761-273772` |
| 流结束 `flush` | 补齐未完成的 reasoning/text 关闭事件；对未完成的 tool_call 强制收尾并下发 | — | `273855-273881` |
| `finish` | `{finishReason, usage, providerMetadata}` | usage 在 finish 时汇总 | `273892-273897` |

### 2.3 usage 采集

| 环节 | 行为 | 证据 |
|------|------|------|
| 索取 | body 恒带 `stream_options:{include_usage:true}` | `465979-465981`、`273646` |
| 提取 | 任一 chunk `value.usage != null` 即记为最新 usage（空 choices 的 usage-only chunk 也覆盖） | `273703-273705` |
| 结构 | `looseObject`：`prompt_tokens/completion_tokens/total_tokens` + `prompt_tokens_details.cached_tokens` + `completion_tokens_details.reasoning_tokens/...` | `274361-274373` |
| 记账 | `finish` 事件携带 `usage` → 适配层映射为 `inputTokens/outputTokens/totalTokens/reasoningTokens/cache*` → 会话与统计使用 | `467915-467976` |
| 流式无 usage 时 | `usage=undefined`，不阻断流；`finish` 仍发出 | `273892-273897`、`467915-467919` |

### 2.4 额度通知与耗尽（CodeFree 特有）

| 语义 | 行为 | 证据 |
|------|------|------|
| 请求侧开关 | 所有 chat 请求都带 `X-Codefree-Quota-Schema: 1` | `464394-464395` |
| 通知载体 | 任意 SSE 帧（或 429 body）：`{data:{codefree:{notifications:[{type:"QUOTA_WARNING",period:"5H"\|"7D",usagePercent,resetAt,eventId,used?,limit?,thresholdPercent?,canUpgrade?,windowId?}], canUpgrade?, quotaWorkTime?}}}` | `369096-369133` |
| 选择规则 | 同周期取最新（按数组序）；`usagePercent===100` 视为耗尽；未耗尽时仅当 `usagePercent >= thresholdPercent` 才提示；耗尽优先 `7D`，否则 `5H` | `369134-369170` |
| 去重 | 键 `${period}:${eventId}:${usagePercent}`，避免重复弹提醒 | `459760-459774` |
| title 请求抑制 | `shouldPublishCodefreeQuotaNotice(purpose) = purpose !== "title"`；即 title 请求**不发布**额度提醒（但请求本身仍带 quota-schema 头） | `459802-459809`、`464391-464392`、`484973-484975` |
| 流内耗尽 | 检测到 `AI_QUOTA_EXHAUSTED` 帧后：停止转发后续帧、`reader.cancel()`、把已拼好的输出先 enqueue，再 `controller.error(带 code 的 Error)`；错误体为 `{code:"AI_QUOTA_EXHAUSTED", periods, exhaustedMask?, periodDetails}` | `459688-459706`、`459692-459698` |
| 429 耗尽 | 克隆 body 解析 `AI_QUOTA_EXHAUSTED`（`period/periods/exhaustedMask/periodDetails/resetAt/retryAt/used/limit/canUpgrade/level/quotaWorkTime`），`exhaustedMask` 位 `1=5H`、`2=7D` | `459636-459644`、`369171-369207` |
| 语义后果 | 额度耗尽映射为 `APIError{statusCode:429,isRetryable:false}`，会话层把 `AI_QUOTA_EXHAUSTED` 视为**不可重试**并追加"额度已耗尽"文本 | `415012-415025`、`485196-485204`、`485975-485983` |

---

## 3. 重试、失败分类与 Retry-After

### 3.1 三层重试的实际归属

| 层 | 参数 | 是否作用于 CodeFree 聊天 | 证据 |
|----|------|--------------------------|------|
| AI SDK 内建重试（`retryWithExponentialBackoffRespectingRetryHeaders`） | 默认 `maxRetries=2`，但会话显式传 `maxRetries: input.retries ?? 0` → **0** | 否（被显式关闭） | `403/404:404033-404137`、`485068` |
| 会话级重试（`SessionRetry.policy`） | `RETRY_MAX_RETRIES=5`；`RETRY_INITIAL_DELAY=2000`；`BACKOFF_FACTOR=2`；`JITTER=0.25`；无 retry-after 头上限 30s，有头上限 2^31-1 ms | **是**（包裹整段流消费） | `485313`、`485292-485311`、`486022-486034` |
| LLM `RequestExecutor` 重试（native 通道） | `MAX_RETRIES=2`、`BASE_DELAY=500ms`、`MAX_DELAY=10s`、可重试状态 `429/503/504/529` | 否（CodeFree 走 AI SDK 通道） | `55332`、`55346-55359`、`55535-55542` |

> 会话级重试的等待时间：优先 `retry-after-ms`（毫秒）→ `retry-after`（秒或 HTTP-date）→ 否则 `2s * 2^(attempt-1) * (1 + 0.25*rand)`；上限在有 retry-after 头时几乎是"无限"（2^31-1ms），无头时 30s（`485165-485195`）。
> 重试状态通过 `status.set(sessionID,{type:"retry",attempt,message,action,next})` 暴露给 UI（`486025-486033`）。

### 3.2 会话级可重试判定矩阵（provider = `codefree`）

| 错误类别 | 是否重试 | 证据 |
|----------|----------|------|
| `AI_QUOTA_EXHAUSTED`（流内/429/嵌套 cause） | **否** | `485196-485198`、`415012-415025` |
| 上下文溢出（`ContextOverflowError` / `413` / `context_length_exceeded`） | **否**（转自动压缩流程） | `485199-485200`、`402942-402951`、`55463-55468` |
| `APIError` 且 `provider==="codefree" && statusCode===429` | **否** | `485203-485204` |
| `APIError` 且 `isRetryable===true` 或 `status>=500` 或 message/body 命中可重试正则 | 是 | `485201-485206`、`485318-485326` |
| `429` 但 body 命中 `insufficient_quota|quota_exceeded` | 归为 `QuotaExceededReason`（统计/展示语义），不等同限流 | `55452-55461` |
| `HeaderTimeoutError` / `ResponseStreamError` / `ECONNRESET` / `ZlibError` | 是（映射为可重试 `APIError`） | `415039-415077` |
| 流内 `{type:"error"}` 业务帧（非配额、非上下文） | 以 `Effect.fail` 结束流，再由 message 正则尽力判定（"exhausted/unavailable/rate limit/…"可能被重试） | `468103-468104`、`485255-485269` |
| 中止（AbortError） | 否（直接结束） | `415028-415031` |

### 3.3 Retry-After 解析（三处实现细节）

| 位置 | 支持的头 | 上限 | 证据 |
|------|----------|------|------|
| 会话级重试 | `retry-after-ms`、`retry-after`（秒/HTTP-date） | 有头 2^31-1ms；无头 30s | `485165-485195` |
| AI SDK 内建（CodeFree 未启用） | `retry-after-ms`、`retry-after`；仅当 `<60s` 或小于指数退避时采用 | — | `404033-404060` |
| `RequestExecutor`（native） | `retry-after-ms`、`retry-after`（秒/date） | 10s | `55346-55359`、`55535-55538` |
| 限流头解析（通用工具） | `retry-after`、`ratelimit-reset-after`、`x-ratelimit-reset-after`、`ratelimit-reset`、`x-ratelimit-reset` | 用于 rate-limit 详情 | `43204-43234`、`55363-55393` |

> App 不消费额度相关的**响应头**做业务决策（只读 `content-type`）：`464297`、`464646`。既有设计文档 OQ-14 的 HeaderProbe 在 app 侧没有证据支持。

### 3.4 Token 刷新并发（CodeFree 认证子系统）

| 机制 | 行为 | 证据 |
|------|------|------|
| 提前量 | `refreshSkew = 60s`；`cfTokenExpiresAt - now > 60s` 直接用缓存，否则刷新 | `395497`、`395839-395846` |
| 单飞 | `refreshPromise` 存在即复用；`finally` 清空 | `395443-395450`、`395814-395821` |
| 版本闸 | `authRevision` 在 `clear()` 时自增；`load/refresh/writeCache` 前后校验 revision，防止"清除后又被旧协程写回" | `395643-395659`、`395767-395812`、`395391-395404` |
| 401 重放 | chat 请求先缓冲 body；401 → `CodefreeAuth.refresh()` → 用**同一 body + 新签名**重放一次；第二次仍 401 则返回响应不再刷新 | `396393-396439` |
| 轮换冲突 | 刷新被 400/401 拒绝时重读本地存储；若存储中的 `refreshCfToken` 已被其他写者轮换，则用新 token **再试一次**；否则清凭据并抛"CodeFree authorization expired" | `395405-395423`、`395443-395475` |
| 落盘 | 加密 v2（`encryptedRefreshCfToken`，AES-256-GCM 静态密钥）+ 权限 `0o600`（mode 384）+ 写入后 revision 复核；另有 legacy 明文兼容与多候选路径回读 | `395395`、`395478-395526`、`395356-395390` |
| 失败语义 | 刷新被拒 → 清空凭据文件、后续请求走"重新登录"；environment 模式不刷新、401 直接抛错 | `395789-395812`、`396452-396457` |

---

## 4. 与工作区代理的逐项差距

### 4.1 已对齐项（无需动作）

| 项 | App 证据 | 代理证据 |
|----|----------|----------|
| chat/embeddings 路径重写 | `464381-464385` | `lib/upstream.mjs:152-166` |
| 签名头与 `X-Cf-Token/userId/projectId:0`、删除 `Authorization/apiKey` | `394684-394703`、`396417-396439` | `lib/upstream.mjs:21-61` |
| `clientType/clientVersion`、`X-Codefree-Quota-Schema`、`modelName`、`subService`、`sessionId`、`codefreeClient` | `464390-464403` | `server.mjs:289-297` |
| 每请求换取/校验 token（60s 提前量 vs 代理 120s） | `395497`、`395839-395846` | `lib/pool.mjs:140-156` |
| 刷新单飞 + 多源回读 + 加密 0o600 写回 | `395443-395475` | `lib/pool.mjs:140-275` |
| `QUOTA_WARNING`/`AI_QUOTA_EXHAUSTED` 解析（5H/7D、mask、periodDetails） | `369096-369207` | `lib/quota.mjs:81-132` |
| SSE 帧切分（空行、`data:` 合并、`[DONE]`） | `459718-459759` | `lib/quota.mjs:135-178` |
| `Retry-After` 系列头与冷却 | `485165-485195` | `lib/util.mjs:136-174`、`lib/pool.mjs:615-631`、`server.mjs:312-318` |
| 流式 usage 采集（v2.4.0 已落地） | `273703-273705`、`273892-273897` | `server.mjs:343-351`、`376-380` |
| title 请求不污染额度快照（v2.4.0 已落地） | `459802-459809` | `server.mjs:257-261` |

### 4.2 差异与冲突（需决策）

| # | 差异 | App 行为 | 代理行为 | 判断 |
|---|------|----------|----------|------|
| D1 | 超时模型 | 首包 300s + 逐块空闲 300s，无总超时 | 整请求 300s 总超时 | **P0 修正**（见 5.1） |
| D2 | `subService` 归属 | 桌面链路 `codefree_o_desktop_chat` | 默认 `codefree_o_chat` | **P0 修正** |
| D3 | 429 处理 | codefree 的 429 一律不重试，等 UI/用户 | 多账号池：切号重试 + 冷却 | **保留差异**（池化增值），但需保证同账号 429 不再打，并优先用 `resetAt/retryAt` 冷却 |
| D4 | 刷新失败处置 | 清空本地凭据，强制重登 | 标记 `auth-expired`，不清共享凭据文件 | **保留差异**（多账号/镜像写回更安全），文档明示语义不同 |
| D5 | 刷新网络重试 | 仅在"他人已轮换"时重读重试一次 | 3 次指数退避（300/900/2700ms） | 保留（更强），但 `maxRetries` 建议可配 |
| D6 | 重试次数/退避 | 会话级 5 次、2s 起、25% 抖动 | 请求级 `maxAttemptsPerRequest=3`、换号 `maxAccountsPerRequest=2` | 保留（池化语义不同）；如单账号退化模式，应对齐 5 次/2s 指数 |
| D7 | 流内错误帧 | 解析 `{error:{...}}`，区分 context/quota/retryable | 不解析，原样透传 | 见 5.2 P1 |
| D8 | 客户端断开 | AbortSignal 全链路取注销费 | 未见入站 `close` → 上游取消的绑定 | 见 5.2 P1 |
| D9 | 认证模式 | 支持 environment（`SRDCLOUD_*`，无签名） | 不支持 | P2（已列 backlog） |
| D10 | UA/会话副头 | `opencode/1.10.1 ai-sdk/...` + `X-Session-Id` | 无 UA，仅 `sessionId` | P2（指纹一致性） |

> 代理相对 App 的结构性优势（**不要**为对齐而删除）：多账号池/选号/租约/冷却/headroom 探测/告警/多消费者限额/管理面——App 单账号模型下不存在这些概念。冲突点仅在于"同一账号的失败语义"与"请求超时语义"。

---

## 5. 优先级差距清单（P0 / P1 / P2）

### 5.1 P0（正确性/合规，先做）

| # | 差距 | 一句话理由 | 影响 |
|---|------|------------|------|
| P0-1 | 流式请求被"整请求 300s 总超时"硬切（`lib/upstream.mjs:54`、`config.json:21`），而 App 是"首包 300s + SSE 空闲 300s、无总超时"（`node-CC-GAWt2.js:466018-466046`、`464292-464334`） | 语义不同导致长回答必失败 | 超过 5 分钟的大 diff/长工具链 100% 中断并收到错误帧；SSE 空闲超时反而缺失，僵死连接无法回收 |
| P0-2 | 桌面流量的 `subService` 归属错误：默认 `codefree_o_chat`（`lib/config.mjs:28`），真实桌面为 `codefree_o_desktop_chat`（`node-CC-GAWt2.js:414149-414220`；`main-DYeEwXNf.js:162307`、`54370`） | 上游计量/风控按 subService 归因 | 与真实客户端流量口径不一致，可能被识别为异常客户端或统计异常 |
| P0-3 | 流内 `AI_QUOTA_EXHAUSTED` 未终止流、未触发冷却（`server.mjs:344-351` 仅 `recordPassive`），App 会取消 reader 并以带 code 的错误终止（`459635-459716`） | 耗尽语义被吞 | 客户端把耗尽当正常结束；账号未按 `resetAt` 冷却，继续被选中反复打 429 |
| P0-4 | 上游流中断被记成功（`server.mjs:361-380`：`streamError` 只 warn/写帧，随后 `selector.onSuccess`） | 失败信号丢失 | 账号健康度失真、坏账号不被冷却；与 App 把 `ResponseStreamError` 标为可重试（`415070-415077`）的语义相反 |

### 5.2 P1（建议下一轮；与 backlog 的 P1 并列）

| # | 差距 | 一句话理由 | 影响 |
|---|------|------------|------|
| P1-1 | 未强制 `stream_options.include_usage:true`（App 恒注入：`465979-465981`、`273646`；代理注释称实测可不带：`server.mjs:346`） | 依赖上游默认行为 | 上游策略微调即丢失流式 usage，token 统计/配额对冲失真 |
| P1-2 | 不解析流内 `{"error":{...}}` 帧（App：`274343-274428`、`468103-468104`、`402942-402961`） | 错误分类缺失 | `context_length_exceeded` 被当普通流结束；`insufficient_quota` 不触发配额路径；错误不参与失败分类 |
| P1-3 | 客户端断开未取消上游请求（全仓无 `req.on('close')`；App：`485096-485104`、`486017-486021`） | 上游仍在生成 | 白耗额度、占租约；长流场景放大成本 |
| P1-4 | 429 冷却未优先采用 `AI_QUOTA_EXHAUSTED.resetAt/retryAt`（代理：`server.mjs:312-318` 以 Retry-After 为准） | 额度窗口与限流窗口不同 | 额度型 429 的解封时间可能远晚于 Retry-After，冷却过短导致反复失败 |
| P1-5 | 仅按 `thresholdPercent` 存疑：被动 warning 未持久化 `thresholdPercent/windowId`（App：`369102-369133`；代理：`lib/quota.mjs:117-127` 已解析未全部落快照） | 过早降权 | headroom/选号偏保守，浪费可用额度（与 backlog P1-1 同源） |
| P1-6 | `quotaWorkTime` 未参与判断（App 仅解析并随通知下发：`369096-369133`、`459780-459793`） | "仅工作时段消耗"语义 | 非工作时段把 5H 使用率当实时压力，误冷却 |
| P1-7 | 非流式 200-but-business-error（`retCode != 0`）已有处理（`server.mjs:319-329`），但未映射到 4xx/429 语义 | 错误码可读性 | 客户端拿到 502 而非可重试/可提示错误 |

### 5.3 P2（按需）

| # | 差距 | 理由 |
|---|------|------|
| P2-1 | `User-Agent` 未模拟（App：`opencode/1.10.1 ai-sdk/openai-compatible/...`，`484781`、`209811-209816`、`273401`） | 指纹一致性；当前上游未见强校验 |
| P2-2 | 未透传 `X-Session-Id` / `x-parent-session-id` / agent chain 头（App：`484775-484791`） | 多会话/子代理归因 |
| P2-3 | 未使用 `modelproviders/v1/providers` 白名单（App：`461453-461469`） | 多提供方灰度场景 |
| P2-4 | environment 认证模式未支持（App：`396444-396477`） | CI/K8s 无桌面场景 |
| P2-5 | title 小模型参数 `chat_template_kwargs.enable_thinking=false` 未镜像（App：`460955-460957`） | 仅影响 title 生成质量，无需镜像 |
| P2-6 | tools 未按名称排序（App：`484771-484772`） | prompt 缓存命中率，非功能项 |
| P2-7 | `Accept` 头差异（App 不设，代理设 `text/event-stream`） | 无实际影响，记录备案 |

---

## 6. 未确认 / 残余可疑点（诚实清单）

1. **上游是否真的对 `title` 请求不发布额度通知**：App 只是本地 `shouldPublishCodefreeQuotaNotice` 抑制（`459802-459809`），服务端是否识别 purpose 未知；也可能是服务端对所有请求都发、客户端自行过滤。
2. **429 响应体中 `AI_QUOTA_EXHAUSTED` 的完整 schema**：`exhaustedMask` 位语义（1=5H、2=7D）是 App 解析代码的推断（`369179-369190`），未经真实响应验证。
3. **流内 `AI_QUOTA_EXHAUSTED` 的出现时机**：与 `QUOTA_WARNING` 是否可同帧、是否固定出现在流末尾、还是伴随某个 `finish_reason`，静态不可知；App 的实现允许"任意帧、同帧内先 warning 后 exhausted"（`459746-459759`）。
4. **`chunkTimeout` 对上游流式 keep-alive 的心跳帧是否重置**：`wrapSSE2` 按 `reader.read()` 返回即重置（`464300-464323`），若上游发送 SSE 注释/空帧也会被视作"有数据"，实际空闲判定偏宽。
5. **签名时间戳/nonce 的服务端校验窗口**（重放防护）未知；App 每次请求/每次 401 重放都重新生成（`394691-394703`、`396425-396430`），代理同样。
6. **上游对 `x-codefree-o-client` 的具体使用方式**（仅计量？还有能力门控？）未知；App 服务端仅把它写入本地上下文（`414149-414153`）。
7. **环境模式 401 不重试的动机**：代码直接抛 `CodefreeEnvironmentAuthError`（`396452-396457`），推测避免共享环境凭据被刷新；未验证。
8. **`quotaWorkTime` 的实际语义**（是否"仅工作时段计费/限额"）与字段边界未知，App 只做透传（`459780-459793`）。
9. **App 是否还存在其他 CodeFree 业务头**：本次只覆盖 `buildCodefreeOptions` 重写路径与 llm 会话头；`plugin.trigger("chat.headers")` 允许插件追加头，默认无（`484742-484750`）。
10. **上游对非流式（`stream:false`）请求的支持度**：App 聊天恒为流式（`273643-273647`），非流式为代理自建能力，缺少 App 侧对照。

---

## 7. 对既有文档的校正（供 Lead 合并）

| 既有表述（`docs/optimization-backlog.md`） | 本次证据校正 |
|-------------------------------------------|--------------|
| "超时：OpenAI provider `HEADER_TIMEOUT_DEFAULT=300000`；`requestTimeoutMs=300000` 一致 ✅" | `OPENAI_HEADER_TIMEOUT_DEFAULT` 只作用于 `openai` provider 配置（`464525`、`465329`）；CodeFree 走的是 **resolveSDK 默认 `chunkTimeout/headerTimeout` 各 300000**（`466018-466019`），且**无总超时**。代理的单一 300s 总超时并不一致（P0-1）。 |
| "无法从 bundle 直接确认聊天 SSE 空闲超时（相关 idle 常量属于 WebSocket 池）" | 已确认：`wrapSSE2` 对 `text/event-stream` 施加逐块 300000ms 空闲超时（`464292-464334`、`466044-466046`）。 |
| "重试：429/503/504/529 可重试" | 该集合属于 `RequestExecutor`（native LLM 通道，`55346`）；CodeFree 聊天实际由会话级重试处理，且 **codefree 的 429 被显式排除**（`485203-485204`）。AI SDK 层重试被 `maxRetries:0` 关闭（`485068`）。 |
| "environment 模式 subService 为 `codefree_o_sandbox`" | 代码值为 `codefree_o_sandbox_chat`（`414205-414208`）；桌面 OAuth 模式为 `codefree_o_desktop_chat`（`414216-414220`）。 |
| "流末尾回传 usage（实测无需 include_usage）" | App 侧**恒注入** `stream_options.include_usage:true`（`465979-465981`、`273646`）。上游无视该字段返回 usage 是实测结论，但协议对齐仍应注入（P1-1）。 |

---

## 附：关键证据索引（按主题）

| 主题 | 主要行号 |
|------|----------|
| provider 工厂/头/URL 重写 | `464373-464404`、`464455-464465` |
| 本地 purpose/subService 头 → 上游头 | `459810`、`484967-484976`、`464390-464403` |
| 签名 | `394684-394703`、`396417-396439` |
| 会话头（affinity/UA） | `484663-484794` |
| body 组装/default 参数 | `273465-273559`、`460305-460338`、`460991-461446` |
| 超时包装/wrapSSE | `464292-464342`、`466018-466046` |
| AI SDK 流式解析/事件映射/usage | `273640-273903`、`274343-274428`、`210826-210838` |
| 错误类型与重试分类 | `402942-402980`、`415012-415121`、`485165-485311`、`486022-486034` |
| 额度信号（warning/exhausted） | `369096-369240`、`459635-459793` |
| Token 刷新与并发 | `395391-395526`、`395814-395846`、`396393-396439` |
| 模型/提供方发现 | `461380-461469` |
