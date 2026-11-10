# CodeFree-O 深扒与优化清单（2026-11-10）

| 项 | 内容 |
|----|------|
| 分析对象 | CodeFree-O Desktop **1.10.1**（Electron + opencode 内核，app.asar 121MB） |
| REA 工件证据 | `app.asar` sha256 `d585b03ba7a12387d815cb8fcdff55fc7a67df326f05c9660512ff9792b74419`，format=asar（REA inspect_artifact，evidence `ev_e5b08ae4…`） |
| 静态分析材料 | 解包目录 `%TEMP%\codefree-asar`（`out/main/chunks/node-CC-GAWt2.js` 32.8MB 主 bundle） |
| 本机实测 | 代理 8787 池模式 + 真实双账号 + 真实上游 GLM-5.2 |

> REA `analyze_javascript_application` 对 121MB asar 目录分析 **超时（240s 上限）**，本次结论以
> REA 工件级证据 + bundle 字符串级定位为主；行号引用为解包 bundle 内偏移，随客户端版本变化。

---

## 1. 确认的上游行为（对照当前实现）

| # | App 行为（证据） | 当前代理实现 | 差距 |
|---|------------------|--------------|------|
| 1 | `/chat/completions` 被重写到 `/api/acbackend/codechat/v1/completions`；`/embeddings` → `/api/aebackend/codefree-embedding-svc/v1/text-to-embedding-vector`（`node-CC-GAWt2.js` 内 fetch 拦截器） | 已一致 | ✅ |
| 2 | 聊天头：`X-Codefree-Quota-Schema: 1`、`modelName`（body.model）、`subService`（`x-codefree-sub-service` 或默认 `codefree_o_chat`；environment 模式为 `codefree_o_sandbox`）、`codefreeClient: codefreeo`、`sessionId`（来自 `x-session-affinity`） | 已一致（`server.mjs` upstreamHeaders） | ✅ |
| 3 | 签名头：`X-Cf-Token` / `userId` / `projectId: 0` / `X-Cf-AppId/Timestamp/Nonce/Signature`；删除客户端 `apiKey/Authorization` | 已一致 | ✅ |
| 4 | 请求用途：`x-codefree-request-purpose: title\|answer`（默认 answer），app 在转发前删除该头；`title` 请求**不发布额度提醒** | 未镜像 | **本轮已实现**：代理收到 title 时不写入被动额度快照（仍计 token） |
| 5 | 模型发现路径：`/api/acbackend/modelmgr/v1/clients/codefree-o/versions/${installation.VERSION}`；`clientVersion` 头同源 | 配置写死 `1.10.1` | **本轮已实现**：从本机 `app.asar` 读取 `package.json.version` 自动识别（env > 自动 > 配置） |
| 6 | 模型能力映射：`input=maxTokens\|\|80000`、`output=maxOutputTokens\|\|8000`、`limit.context=maxTotalTokens\|\|input+output`；`capabilities={temperature,reasoning,toolcall,attachment/vision:modelType==="multimodal",interleaved:{field:"reasoning_content"}}` | `/v1/models` 只有基础 meta | **本轮已实现**：补充 `contextWindow`/`capabilities`/`limit` |
| 7 | 流末尾回传 `usage`（实测无需 `stream_options.include_usage`）；`tapCodefreeResponse` 解析 SSE 额度提醒与 429 的 `AI_QUOTA_EXHAUSTED` | 流式未解析 usage（tokens 统计为 0） | **本轮已实现**：SSE 扫描 usage → 计入账号统计与 `/metrics` |
| 8 | 重试：429/503/504/529 可重试；解析 `retry-after-ms`、`retry-after`（秒/HTTP 日期）、`ratelimit-reset-after` 作为重试窗口 | 429 固定冷却 30s（retryAfter:5 未落库） | **本轮已实现**：解析 Retry-After 参与账号冷却（上限 6h） |
| 9 | 额度提醒选择：按 5H/7D 取最新通知；`usagePercent===100` 视为耗尽，否则 `usagePercent >= thresholdPercent` 才提示；`quotaWorkTime` 随提醒下发 | 已解析 notifications/thresholdPercent，但未持久化 threshold/windowId，未用 quotaWorkTime | P1（候选优化） |
| 10 | 模型提供方白名单：`GET /api/acbackend/modelproviders/v1/providers`，按 `providers[].name` 过滤模型 | 未使用 | P2（多提供方场景再实现） |
| 11 | 安装版本来源：`installation.VERSION`（app.asar package.json） | 已可通过 `CODEFREE_VERSION` 覆盖 | ✅（本轮自动识别） |
| 12 | 超时：OpenAI provider `HEADER_TIMEOUT_DEFAULT = 300000`（5 分钟） | `requestTimeoutMs=300000` | ✅ 一致 |
| 13 | 流中断/空闲：无法从 bundle 直接确认聊天 SSE 空闲超时（相关 idle 常量属于 WebSocket 池） | 无空闲超时，仅透传 | P2（可配置 SSE 空闲超时） |
| 14 | 环境模式鉴权：`~/.srdcloud_env` 的 `SRDCLOUD_CF_ACCESS_TOKEN/USERID/PROJECTID` | 未支持 | P2（K8s/CI 部署场景） |
| 15 | 客户端类型：桌面 `clientType=codefree-o`；非桌面为 `cli`（`resolveCodefreeClientType`） | 固定 `codefree-o` | P2（如需模拟 CLI 归因） |

---

## 2. 本轮已落地的优化（v2.4.0）

| 优化 | 实现 | 验证 |
|------|------|------|
| 客户端版本自动识别 | 新增 `lib/codefree-app.mjs`：解析 asar 头与 `package.json`，`config.upstream.autoDetectVersion`（默认 true），优先级 env `CODEFREE_VERSION` > 安装包识别 > 配置值；`/health` 增加 `versionSource` | `node --test test/version-detect.test.mjs` 4/4；实机 `/health` → `version=1.10.1, versionSource=app-asar` |
| 流式 usage 统计 | `server.mjs` SSE 扫描 `frame.usage`，成功后写入账号 tokensIn/tokensOut 与日志 | 实机流式对话：`acc-a successes 16→17, tokensIn 77→88, tokensOut 14→16`；pool 测试新增用例通过 |
| Retry-After 冷却 | `lib/util.mjs#parseRetryAfterMs` + `classifyFailure`/`onFailure` 按上游头设置冷却 | mock 429 `Retry-After: 120` → 账号冷却 ≥100s（新增测试通过） |
| 模型能力元数据 | `/v1/models` meta 增加 `contextWindow`/`capabilities`/`limit` | 实机：GLM-5.2 vision=false、Qwen3.8 vision=true、contextWindow=200000（新增测试通过） |
| title 请求不污染额度快照 | `x-codefree-request-purpose: title` 时不写入被动额度 | 代码路径覆盖（未单独建测试，逻辑与 app `shouldPublishCodefreeQuotaNotice` 一致） |

回归：`node --test test/pool.test.mjs` **14/14**；`test/version-detect.test.mjs` **4/4**。

---

## 3. 待优化清单（按优先级）

### P1（建议下一轮）

1. **额度提醒阈值语义对齐**：持久化 `thresholdPercent/windowId/canUpgrade/quotaWorkTime`；只有 `usagePercent >= thresholdPercent` 或 `===100` 时才影响 headroom/告警，避免过早降权。
2. **quotaWorkTime 参与判断**：窗口仅在工作时段生效时，非工作时段不应把 5H 使用率当作“当前压力”；可在 headroom 计算中加入时段因子。
3. **SSE 空闲超时**：为流式转发增加可配置空闲超时（如 120s 无数据 abort 并标记账号网络异常），防止长连接僵死占用租约。
4. **refresh token 到期告警**：`refreshTokenExpiresAt < now+48h` 时 logger.warn + 告警事件，避免“某天突然登录过期”。
5. **模型提供方白名单**：接入 `modelproviders/v1/providers`，按可用 provider 过滤模型（多提供方/灰度场景）。

### P2（按需）

6. **环境模式鉴权**：支持 `~/.srdcloud_env` / `SRDCLOUD_*`，便于 CI/K8s 无桌面登录场景。
7. **客户端类型可配**：`clientType` 支持 `codefree-o|cli`，便于归因测试。
8. **多模态输入透传验证**：Qwen3.8 已标记 vision=true；补一个真实图片输入用例（data URL/base64）验证上游兼容。
9. **REA 深度分析自动化**：对 asar 目录分析超时的问题，可先按入口文件拆分（如仅 `out/main/index.js`、按 chunk 分片）再送 `analyze_javascript_application`。
10. **指标扩展**：`codefree_stream_idle_aborts_total`、`codefree_retry_after_cooldowns_total`、按用途（title/answer）的请求计数。

---

## 4. 证据与复现

```powershell
# 版本自动识别
node --test test/version-detect.test.mjs
node -e "console.log(require('./config.json').upstream.version)"   # 配置值仅兜底
curl http://127.0.0.1:8787/health | jq '{version,versionSource}'

# 流式 usage
node --test test/pool.test.mjs   # 用例：流式对话解析 usage

# Retry-After
node --test test/pool.test.mjs   # 用例：429 Retry-After 参与账号冷却

# 模型能力
curl http://127.0.0.1:8787/v1/models
```

> 附：`docs/recon-upstream-behavior.md`（请求/SSE/重试细节）与
> `docs/recon-models-quota.md`（模型目录/额度/账号语义）为并行深挖报告，含更多 file:line 证据。


---

## 10. v2.5.0 追加：并行深挖结论与 P0 修复记录（2026-11-10）

两路并行静态深挖完成，补充证据见：

- `docs/recon-upstream-behavior.md`（请求/SSE/重试/token 刷新，305 行）
- `docs/recon-models-quota.md`（模型目录/额度/账号/版本，496 行）

> 说明：REA `analyze_javascript_application` 对 121MB asar 目录仍会超时（240s），
> 本次改由解包后 bundle 字符串级定位 + REA 工件级证据（sha256/asar 格式）完成。

### 10.1 对 §1 表格的校正（以深挖报告为准）

| 原表述 | 校正 |
|--------|------|
| 超时与 App 一致（5 分钟） | ❌ App 是"首包 300s + SSE 逐块空闲 300s、**无总超时**"（`recon-upstream-behavior.md` §1.4）；代理原单 300s 总超时会硬切长流 |
| 无法确认聊天 SSE 空闲超时 | ✅ 已确认：`wrapSSE2` 对 `text/event-stream` 施加逐块 300000ms 空闲超时 |
| "429/503/504/529 可重试" | ⚠️ 该集合属 native LLM 通道；CodeFree 聊天由会话级重试处理，且 **codefree 的 429 明确不重试** |
| environment 模式 subService | 值应为 `codefree_o_sandbox_chat`；桌面 OAuth 为 `codefree_o_desktop_chat` |
| 流式 usage "无需 include_usage" | App 侧**恒注入** `stream_options.include_usage:true`；上游实测即使不注入也返回 usage，但协议应对齐 |

### 10.2 额度语义补充（recon-models-quota）

- **生效门控**：仅 `quotaStatus=ACTIVE && statusReason===null && !vip` 才管控；`BYPASSED`
  （VIP/OUTSIDE_GRAY_SCOPE/OUTSIDE_WORK_TIME）、`DISABLED`、`DEGRADED` 均不应按用量扣分。
- **窗口状态**：`NOT_STARTED / ACTIVE / EXHAUSTED`；缺窗口视为 NOT_STARTED、usagePercent=0；
  `thresholdPercent` 由服务端下发，仅用于告警资格（`usagePercent===100 || >=thresholdPercent`）。
- **耗尽恢复**：多窗口耗尽时按 `periods.includes("7D") ? "7D" : "5H"` 取主周期，
  `resetAt` 优先取该周期 `periodDetails.resetAt`，避免冷却早于 7D 重置导致反复 429。
- **多账号**：桌面端只支持单 CodeFree 账号；`account/account_state/control_account` 是 opencode
  控制面（设备码登录）账号，与额度无关——多账号池仍需"多份 codefree.json"方案。

### 10.3 本轮 P0 修复清单（v2.5.0）

| # | 问题 | 修复 |
|---|------|------|
| 1 | 流式被整请求 300s 总超时硬切 | `lib/upstream.mjs` 支持外部 signal；`server.mjs` 流式用"首包 300s + 逐块空闲 300s"（`upstream.streamIdleTimeoutMs`），非流式保留总超时 |
| 2 | 桌面流 `subService` 归属错误 | 默认改为 `codefree_o_desktop_chat`（config.example / 本机 config 同步） |
| 3 | 流内 `AI_QUOTA_EXHAUSTED` 仅记录、记成功 | 检测后取消 reader、写配额错误帧、`onFailure` 按 `resetAt/retryAt` 冷却（多窗口取最晚恢复时间，上限 7 天） |
| 4 | 流中断被记成功 | 流错误改为写 `codefree_stream_interrupted` 帧 + 记失败/网络冷却 |
| 5 | 客户端断开不取消上游 | `res.on('close')` → `AbortController.abort()`，上游 reader 被取消 |
| 6 | 429 冷却未优先用 body `resetAt/retryAt` | 429 无 Retry-After 时用 body 的 `resetAt/retryAt` 兜底 |
| 7 | 未注入 `stream_options.include_usage` | 流式请求默认注入（客户端显式设置则尊重） |
| 8 | 流内业务错误帧不解析 | 识别 `{"error":{...}}`，上下文超限不冷却账号、其它按上游错误记失败 |
| 9 | 额度门控/窗口状态未接入 | `summarizeQuota` 产出 `enforced/bypassed`，`headroom` 忽略 NOT_STARTED 窗口；未生效账号不扣分 |
| 10 | 告警/阈值字段未持久化 | 快照保留 `thresholdPercent/windowId/canUpgrade/quotaWorkTime/nextLevel`，新增 `codefree_quota_enforced` 等指标 |
| 11 | refresh token 到期无提醒 | `AlertManager.maybeWarnRefreshExpiry`（默认 48h 内告警，12h 去重）+ `codefree_account_refresh_expires_in_seconds` 指标 |

测试：`node --test test/pool.test.mjs` **18/18**、`test/version-detect.test.mjs` 4/4、
`test/quota.test.mjs` 3/3。

### 10.4 仍未完成的 P0/P1（下一轮候选）

1. **`accessMode=LEGACY` 模型跳过额度评分/冷却**（recon-models-quota P0-3）：需要把模型元数据
   缓存接入选择器。
2. **`modelproviders` 目录/白名单**：目前只暴露 modelmgr 的 7 字段；富元数据（modalities、
   interleaved、cost、release_date）需从 `/api/acbackend/modelproviders/v1/providers` 补齐。
3. **工作时段感知的 headroom**：`quotaWorkTime` 已解析并入快照；非工作时段如何影响 5H/7D
   使用率仍待真实账号验证（当前两账号 BYPASSED）。
4. **UA / `X-Session-Id` / `x-parent-session-id` 透传**：指纹一致性与子代理归因。
5. **environment 模式（`SRDCLOUD_*`）**：CI/K8s 无桌面场景。
6. **title 请求小模型参数**（`chat_template_kwargs.enable_thinking=false`）：仅影响标题质量。


---

## 11. v2.6.0 追加：LEGACY 免额度 / modelproviders / 请求指纹（2026-11-10）

### 11.1 本轮修复

| # | 问题 | 修复 |
|---|------|------|
| 1 | `accessMode=LEGACY` 模型未参与额度判定（recon-models-quota P0-3） | 模型目录缓存 accessMode；LEGACY 模型选号忽略额度权重、额度/限流失败不冷却账号、不写被动额度快照；`/v1/models` 暴露 `meta.quotaExempt` |
| 2 | `limit.output` 语义偏差（引擎请求恒 32000） | `limit.output=32000`，另保留 `upstreamMaxOutputTokens`（modelmgr 声明值） |
| 3 | 缺 cost/status/release_date/family | meta 补齐只读字段 |
| 4 | modelproviders 目录未接入 | 新增 `/admin/modelproviders`（管理员）+ `/v1/models` `meta.catalog` 合并（models.dev 结构，10 分钟缓存，失败降级） |
| 5 | UA / 会话归因头缺失 | 默认 `User-Agent: opencode/<version> ai-sdk/openai-compatible`；透传 `X-Session-Id`、`x-parent-session-id` |
| 6 | 客户端未先拉 /v1/models 时 LEGACY 判定缺失 | 首次遇到未知模型时惰性拉取模型目录（`ensureModels`） |

### 11.2 实机观察（重要）

本机真实账号的 3 个模型 **均为 `accessMode="LEGACY"`**：

```text
GLM-5.2 / Qwen3.8-27B / DeepSeek-V4-Flash-0731 → quotaExempt=true, limit.output=32000
```

即当前上游把全部模型放在"LEGACY 免额度通道"（与 quotaStatus=BYPASSED 一致）。
代理行为：这些模型不参与额度评分/冷却；未来出现非 LEGACY 模型时自动恢复额度感知选号。

`modelproviders` 实测返回 `{"providers":[],"optResult":0}`（当前账号/环境无第三方目录），
目录合并逻辑已做降级验证（不报错、不阻塞 /v1/models）。

### 11.3 更新后的剩余清单

1. 工作时段感知的 headroom（需真实额度窗口出现后验证）；
2. environment 模式鉴权（`SRDCLOUD_*`，CI/K8s）；
3. title 小模型参数（`chat_template_kwargs.enable_thinking=false`）与 tools 排序（P2）；
4. 若上游开放非 LEGACY 模型，复测额度评分/冷却链路（mock 已覆盖，真实待观察）。
