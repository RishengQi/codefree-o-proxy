# CodeFree-O Desktop 1.10.1 模型目录 · 额度 · 账号语义侦察报告

> 侦察对象：CodeFree-O Desktop 1.10.1（Electron + opencode 内核），已解包只读目录 `%USERPROFILE%\AppData\Local\Temp\codefree-asar`。
> 侦察方式：静态检索 + 逐段上下文确认（grep/read），未启动 GUI、未修改任何代码。
> 对照对象：本仓库 `<repo>`（`server.mjs`、`lib/*.mjs`）。
> 对照基线：主仓库已升级 **v2.4.0**（commit `9373f8b`，含模型 capabilities 与版本自动识别）。第 2.5 节与 P1 中已按 v2.4.0 现状标注"已实现/剩余"，P0 项经复核仍未实现（`lib/quota.mjs`/`lib/pool.mjs` 无 `statusReason`/`LEGACY`/`periodDetails` 消费，`server.mjs` 流式路径未特判流内耗尽）。
> 报告日期：2026-11-10。

## 0. 证据路径缩写

| 缩写 | 实际文件 |
| --- | --- |
| `node-CC-GAWt2.js` | `out\main\chunks\node-CC-GAWt2.js`（33MB opencode 引擎 bundle） |
| `index.js` | `out\main\index.js`（Electron 主进程） |
| `main-DYeEwXNf.js` | `out\renderer\assets\main-DYeEwXNf.js`（渲染器主包，含额度状态机与横幅） |
| `index-qzGIr_t2.js` | `out\renderer\assets\index-qzGIr_t2.js`（设置页「剩余额度」组件） |
| `zh-CFSgfJVU.js` | `out\renderer\assets\zh-CFSgfJVU.js`（中文语言包） |
| `package.json` | 解包根目录 `package.json`（`version: 1.10.1`） |

行号即该文件行号；跨行区间写作 `文件:起-止`。

## 1. 结论摘要（先看这里）

1. **模型目录单一权威源是 `modelmgr`**，其条目只提供 7 个有效字段（`modelName/displayName/modelType/maxTokens/maxOutputTokens/maxTotalTokens/accessMode`）；引擎其余能力全部**硬编码推断**：`reasoning=true`、`toolcall=true`、`interleaved={field:"reasoning_content"}`、`cost=0`、`limit.output=0`（`node-CC-GAWt2.js:461395-461451`）。
2. **请求侧 `max_tokens` 恒为 32000**：`limit.output=0` 使 `maxOutputTokens(model)=min(0,32000)||32000`，`modelmgr.maxOutputTokens` **不约束请求**，只参与上下文缺省计算（`node-CC-GAWt2.js:461396-461425`、`:460991-460993`、`:484739`、`:461351`）。
3. **额度是"状态机 + 服务端阈值"，不是简单百分比**：只有 `quotaStatus=ACTIVE && statusReason=null && !vip` 才算管控生效；`BYPASSED`（`OUTSIDE_WORK_TIME`/`VIP`/`OUTSIDE_GRAY_SCOPE`）、`DISABLED`、`DEGRADED` 各有独立语义；窗口 `status` 存在 `NOT_STARTED/ACTIVE/EXHAUSTED`（`main-DYeEwXNf.js:103958`、`index-qzGIr_t2.js:3016-3031`、`main-DYeEwXNf.js:126683-126695`）。
4. **额度告警走 SSE 内嵌 `codefree.notifications[]`**，判定资格是"`usagePercent===100` 或 `usagePercent>=thresholdPercent`"，`thresholdPercent` **由服务端下发、客户端无硬编码**；桌面端按 `period:eventId:usagePercent` 去重并持久化（`node-CC-GAWt2.js:369096-369170`、`:459765-459768`、`index.js:2045-2073`）。
5. **桌面端不支持多个 CodeFree 账号**：仅一份 `codefree.json` 运行时 + 单一 `/codefree/auth/{status,login,logout}`；`account/account_state/control_account` 表属于 opencode 自己的控制面（设备码 OAuth + 组织切换），与 CodeFree 配额无关（`node-CC-GAWt2.js:706533-706580`、`:67425-67534`、`:459569-459618`）。
6. **我们代理最值得立刻补的三类差距**：引号外（1）额度生效门控与窗口状态解析；（2）模型级 `accessMode=LEGACY` 绕过额度；（3）多窗口耗尽的 `periodDetails` 冷却语义。详见第 6 节 P0。

---

## 2. 模型目录：`modelmgr` 与 `modelproviders`

### 2.1 发现路径与握手

| 项 | 值 | 证据 |
| --- | --- | --- |
| 模型目录 URL | `/api/acbackend/modelmgr/v1/clients/codefree-o/versions/${VERSION}` | `node-CC-GAWt2.js:461381` |
| 请求头 | 无显式业务头（仅 `codefreeFetch` 注入的 `X-Cf-Token/userId/projectId` 与 `X-Cf-*` 签名） | `node-CC-GAWt2.js:461380-461382`、`:396417-396432` |
| 成功判定 | HTTP ok **且** `body.optResult === 0` | `node-CC-GAWt2.js:461383-461394` |
| 超时 | 30 秒（`Effect.timeout("30 seconds")`） | `node-CC-GAWt2.js:465774-465777` |
| 供应商目录 URL | `/api/acbackend/modelproviders/v1/providers` | `node-CC-GAWt2.js:461454`、`:688363` |
| 供应商目录请求头 | `{ clientType: "codefree-o" }`（仅此） | `node-CC-GAWt2.js:688364-688367` |
| 供应商目录超时 | 10 秒 | `node-CC-GAWt2.js:688344` |

### 2.2 `modelmgr` 字段与引擎落点

`data[]` 每一项被映射成 opencode 内部 `Model` 对象，键为 `modelName`：

| 上游字段 | 类型/缺省 | 引擎落点 | 证据 |
| --- | --- | --- | --- |
| `modelName` | string（必填语义） | `id`、`api.id` | `node-CC-GAWt2.js:461398-461407` |
| `displayName` | string | `name` | `node-CC-GAWt2.js:461404` |
| `maxTokens` | number，缺省 `8e4` | 计算缺省 `limit.context/input` 的加数 | `node-CC-GAWt2.js:461396`、`:461423-461425` |
| `maxOutputTokens` | number，缺省 `8e3` | 仅参与缺省 `limit.context` 计算；**不进入 `limit.output`** | `node-CC-GAWt2.js:461397`、`:461423-461425` |
| `maxTotalTokens` | number | **优先**作为 `limit.context` 与 `limit.input` | `node-CC-GAWt2.js:461423-461425` |
| `modelType` | string，如 `"multimodal"` | `attachment`、`input.image`（仅等于 `"multimodal"` 时为真） | `node-CC-GAWt2.js:461430`、`:461435` |
| `accessMode` | string，如 `"LEGACY"` | `options.accessMode`（透传，UI 消费） | `node-CC-GAWt2.js:461413` |
| `optResult` / `msg` | number / string | 非 0 直接抛错，模型目录不可用 | `node-CC-GAWt2.js:461392-461394` |

映射结果（引擎内部模型对象）：

| 内部字段 | 值 | 证据 |
| --- | --- | --- |
| 固定为 `active` | 不读 `status` | `node-CC-GAWt2.js:461411` |
| `api.npm` | `"@ai-sdk/openai-compatible"` | `node-CC-GAWt2.js:461409` |
| `api.url` | 当前运行时 `baseUrl` | `node-CC-GAWt2.js:461408` |
| `cost` | `{input:0, output:0, cache:{read:0, write:0}}` | `node-CC-GAWt2.js:461414-461421` |
| `limit.context` | `maxTotalTokens \|\| (maxTokens+maxOutputTokens)`；缺省 8e4+8e3 | `node-CC-GAWt2.js:461423-461424` |
| `limit.input` | 同 `limit.context` | `node-CC-GAWt2.js:461424` |
| `limit.output` | **`0`** | `node-CC-GAWt2.js:461425` |
| `capabilities.temperature` | `true` | `node-CC-GAWt2.js:461428` |
| `capabilities.reasoning` | **`true`（无条件）** | `node-CC-GAWt2.js:461429` |
| `capabilities.attachment` | `modelType === "multimodal"` | `node-CC-GAWt2.js:461430` |
| `capabilities.toolcall` | **`true`（无条件）** | `node-CC-GAWt2.js:461431` |
| `capabilities.input` | `{text:true, audio:false, image:multimodal, video:false, pdf:false}` | `node-CC-GAWt2.js:461432-461438` |
| `capabilities.output` | `{text:true, audio/image/video/pdf:false}` | `node-CC-GAWt2.js:461439-461445` |
| `capabilities.interleaved` | `{field:"reasoning_content"}` | `node-CC-GAWt2.js:461446` |
| `release_date` | `""` | `node-CC-GAWt2.js:461448` |

> 语义含义：**所有 CodeFree 模型在客户端侧都被视为"可推理 + 可调工具 + 交错 reasoning_content"**，多模态输入只看 `modelType === "multimodal"`。这是"客户端能力契约"，与上游真实能力无关，代理对外暴露模型元数据时应对齐这个口径。

### 2.3 请求参数与线上改写

| 行为 | 规则 | 证据 |
| --- | --- | --- |
| `max_tokens`（输出上限） | `min(limit.output, OUTPUT_TOKEN_MAX) \|\| OUTPUT_TOKEN_MAX`，`OUTPUT_TOKEN_MAX=32e3` → CodeFree 恒 32000 | `node-CC-GAWt2.js:460991-460993`、`:461351`、`:484739` |
| 输出上限环境变量 | `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` 可覆盖 | `node-CC-GAWt2.js:416130` |
| 路径改写 | `/chat/completions` → `/api/acbackend/codechat/v1/completions`；`/embeddings` → `/api/aebackend/codefree-embedding-svc/v1/text-to-embedding-vector` | `node-CC-GAWt2.js:464385` |
| 请求头 `clientType` / `clientVersion` | `codefree-o` / `InstallationVersion` | `node-CC-GAWt2.js:464460-464463` |
| `X-Codefree-Quota-Schema: 1` | **仅 chat/completions** 请求加 | `node-CC-GAWt2.js:464394-464395` |
| `modelName` 头 | 取自请求体 `model`（仅 chat 路径解析） | `node-CC-GAWt2.js:464382`、`:464399-464400` |
| `subService` 头 | 环境模式→`codefree_o_sandbox_chat`；否则读入站 `x-codefree-sub-service` 或 `resolveSubService()` | `node-CC-GAWt2.js:464401-464402`、`:414196-414221` |
| `sessionId` 头 | 由入站 `x-session-affinity` 复制 | `node-CC-GAWt2.js:464396-464398` |
| `codefreeClient` 头 | `codefreeo` | `node-CC-GAWt2.js:464403` |
| `x-codefree-request-purpose` | 消费后**删除**（见 3.4） | `node-CC-GAWt2.js:464391-464393` |

`subService` 归属值表（引擎侧产品矩阵）：

| client 标识（入站 `x-codefree-o-client`） | app | service | subService | 证据 |
| --- | --- | --- | --- | --- |
| 缺省 | `codefree-o` | `codefree-o` | `codefree_o_chat` | `node-CC-GAWt2.js:414200-414204` |
| `cfs-desktop` | `cfs-desktop` | `cfs-desktop` | `cfs_desktop_chat` | `node-CC-GAWt2.js:414210-414215` |
| `codefree-o-desktop` | `codefree-o` | `codefree-o-desktop` | `codefree_o_desktop_chat` | `node-CC-GAWt2.js:414216-414220` |
| 环境/沙箱模式（强制） | `codefree-o` | `codefree-o-sandbox` | `codefree_o_sandbox_chat` | `node-CC-GAWt2.js:414205-414209`、`:464401` |

### 2.4 `modelproviders`：两套消费方与目录结构

同一接口被两处消费，职责不同：

| 消费方 | 读取字段 | 用途 | 证据 |
| --- | --- | --- | --- |
| 允许清单 `discoverProviders` | `providers[].name` | 过滤 models.dev 目录中"后端允许的第三方 provider"，非允许 provider 从 UI 删除 | `node-CC-GAWt2.js:461453-461468`、`:465827-465837` |
| 目录替换 `adaptProviders`/`fetchCatalogText` | `providers[].id`、`providers[].value` | 用后端返回的 models.dev 目录整体替换内置 models.dev 数据源 | `node-CC-GAWt2.js:688297-688336`、`:688337-688404` |

`value` 符合 models.dev `Provider` 结构：

| 字段 | 类型 | 证据 |
| --- | --- | --- |
| `id` / `name` / `api` / `npm` / `env[]` | string / string / string? / string? / string[] | `node-CC-GAWt2.js:192147-192154` |
| `models{modelID: Model}` | record | `node-CC-GAWt2.js:192153` |
| `Model.id/name/family/release_date` | string | `node-CC-GAWt2.js:192108-192112` |
| `Model.attachment/reasoning/temperature/tool_call` | boolean | `node-CC-GAWt2.js:192113-192116` |
| `Model.reasoning_options` | `[{type:"effort",values[]} \| {type:"toggle"} \| {type:"budget_tokens",min,max}]` | `node-CC-GAWt2.js:192094-192107` |
| `Model.interleaved` | boolean \| string \| `{field}` | `node-CC-GAWt2.js:192118-192124` |
| `Model.cost` | `{input,output,cache_read?,cache_write?}` | `node-CC-GAWt2.js:192076-192093` |
| `Model.limit` | `{context,input?,output}` | `node-CC-GAWt2.js:192126-192130` |
| `Model.modalities` | `{input:[text\|audio\|image\|video\|pdf], output:[...]}` | `node-CC-GAWt2.js:192131-192134` |
| `Model.status` | `alpha \| beta \| deprecated \| active` | `node-CC-GAWt2.js:192144`、`:461485` |
| `Model.provider` | `{npm?, api?}` | `node-CC-GAWt2.js:192145` |

目录过滤规则（引擎侧）：

| 规则 | 证据 |
| --- | --- |
| `status=alpha` 且未开启实验模型 → 删除 | `node-CC-GAWt2.js:465796-465797`、`:465954-465955` |
| `status=deprecated` → 删除 | `node-CC-GAWt2.js:465798-465799` |
| 配置 `blacklist/whitelist` → 删除 | `node-CC-GAWt2.js:465800-465801` |
| 非允许 provider（不在 `modelproviders.providers[].name` 集合内）→ 删除 | `node-CC-GAWt2.js:465831-465837` |
| CodeFree 自有模型由 `modelmgr` 合并进同名 provider，存在则保留 | `node-CC-GAWt2.js:465780-465783` |

### 2.5 与我们的 `/v1/models` 对照

当前实现（v2.4.0，`lib/upstream.mjs:106-153`）：

```text
{ id, object:"model", created:0, owned_by:"codefree",
  meta:{ displayName, modelType, maxTokens: m.maxTokens ?? m.maxTotalTokens, maxOutputTokens,
         accessMode, contextWindow, capabilities:{...}, limit:{context, output} } }
```

v2.4.0 已对齐引擎口径的能力/上下文（`contextWindow = maxTotalTokens || maxTokens || 80000`、`capabilities.reasoning/toolCall/attachment/vision/interleaved`、`limit.context`），仍存在的差距：

| 差距 | 引擎口径 | 建议 | 影响 |
| --- | --- | --- | --- |
| `limit.output` 语义偏差 | 引擎请求侧 `max_tokens` 恒为 `min(limit.output, 32000) \|\| 32000`（CodeFree `limit.output=0` → 32000）；`modelmgr.maxOutputTokens` 不约束请求 | `limit.output` 改为请求硬顶 32000，另设 `upstreamMaxOutputTokens` 保留服务端声明值 | 客户端按 `limit.output=8000` 设 `max_tokens` 与官方行为不一致，长回答被截断 |
| 无 `cost/status/release_date/family` | `cost` 全 0、`status:"active"`、`release_date:""` | 补齐只读字段 | 计费/展示/排序缺字段 |
| 无第三方 provider 白名单与目录 | `modelproviders` 的 models.dev 目录 + 白名单 | 增加可选目录合并（缓存 10min，失败降级） | 缺能力/成本/推理档位等权威元数据（见 P1-2） |
| `meta.maxTokens` 优先序 | 引擎优先 `maxTotalTokens` 作上下文 | `meta.maxTokens` 仅为兼容保留，上下文以 `contextWindow` 为准（已满足） | 旧客户端字段歧义 |

---

## 3. 额度语义

### 3.1 接口与错误契约

| 项 | 值 | 证据 |
| --- | --- | --- |
| 查询 | `GET /api/aebackend/quota/v1/me`（Accept: application/json） | `node-CC-GAWt2.js:707148-707149`、`:709861-709872` |
| 升级 | `POST /api/aebackend/quota/v1/me/upgrade` | `node-CC-GAWt2.js:707150`、`:707170-707177` |
| 成功响应结构 | **`Schema.Unknown`**（无正式 schema，透传原样） | `node-CC-GAWt2.js:707152`、`:707168` |
| 成功状态码 | GET：`200`；POST：`200` 或 `202` | `node-CC-GAWt2.js:709876-709877` |
| 错误映射 | 400→`AI_QUOTA_INVALID_ARGUMENT`；401→`CODEFREE_AUTH_REQUIRED`；409→`AI_QUOTA_UPGRADE_NOT_AVAILABLE`；其余→`AI_QUOTA_DATA_UNAVAILABLE`(503) | `node-CC-GAWt2.js:709837-709845`、`:709816-709822` |
| 401 上游成因分类 | 环境鉴权失败 / refresh 被拒 → `CODEFREE_AUTH_REQUIRED` | `node-CC-GAWt2.js:709793-709802` |
| 非 JSON 成功体 | 视为 `AI_QUOTA_DATA_UNAVAILABLE` | `node-CC-GAWt2.js:709806-709811` |
| 升级结果码 | `APPLIED` / `PENDING_SYNC`（后者轮询查询最多 5 次、间隔 500ms） | `index-qzGIr_t2.js:3051-3066` |

### 3.2 响应字段（渲染器实际消费口径）

| 字段 | 可能值 | 含义 | 证据 |
| --- | --- | --- | --- |
| `quotaStatus` | `ACTIVE` / `BYPASSED` / `DISABLED` / `DEGRADED` | 额度管控总状态；`DEGRADED`+`CONFIG_UNAVAILABLE` 是前端默认"不可用"态 | `main-DYeEwXNf.js:103958`、`:104033-104045`、`index-qzGIr_t2.js:2992` |
| `statusReason` | `null` / `VIP` / `OUTSIDE_GRAY_SCOPE` / `OUTSIDE_WORK_TIME` / `CONTROL_DISABLED` / `CONFIG_UNAVAILABLE` | 旁路原因；`OUTSIDE_WORK_TIME`=当前不在工作时段 | `index-qzGIr_t2.js:3019-3031`、`:2992` |
| `vip` | boolean | VIP 用户额度不适用 | `main-DYeEwXNf.js:103958`、`:126583-126584` |
| `level` | `{ level: string, displayName: string }` | 当前等级 | `main-DYeEwXNf.js:104035`、`:103691`、`index-qzGIr_t2.js:3139` |
| `fiveHour` / `sevenDay` | 窗口对象（见 3.3） | 5 小时 / 7 天窗口 | `main-DYeEwXNf.js:126683-126695` |
| `quotaWorkTime` | `{startTime:string, endTime:string, timeZone?:string}` | 额度生效工作时段；缺失时前端默认 `08:30-17:30` | `main-DYeEwXNf.js:103736-103739`、`node-CC-GAWt2.js:457375-457379` |
| `canUpgrade` | boolean | 是否可升级（决定横幅按钮文案） | `index-qzGIr_t2.js:3015`、`main-DYeEwXNf.js:126844` |
| `gradingPending` | boolean | 等级评定中（前端已解析、当前 UI 未消费） | `main-DYeEwXNf.js:104041` |
| `nextLevel` / `nextUpgradeAt` | 任意 / number | 下一级与可升级时间（已解析、当前 UI 未消费） | `main-DYeEwXNf.js:104043-104044` |

### 3.3 窗口对象（`fiveHour`/`sevenDay`）

| 字段 | 可能值/含义 | 证据 |
| --- | --- | --- |
| `status` | `NOT_STARTED`（首次使用前）、`ACTIVE`、`EXHAUSTED` | `main-DYeEwXNf.js:126685-126690`、`:104071-104081` |
| `usagePercent` | 0–100，已用百分比 | `main-DYeEwXNf.js:103684-103689`、`:126630-126631` |
| `startedAt` | 窗口开始时间；5H 窗口"从首条消息开始" | `main-DYeEwXNf.js:103693`、`:zh-CFSgfJVU.js:848` |
| `resetAt` | 重置时间，**number(ms) 或 ISO string 均可** | `main-DYeEwXNf.js:103712-103734`、`:104015-104020`、`:126677-126682` |
| `thresholdPercent` | 服务端下发的告警阈值（无硬编码） | `main-DYeEwXNf.js:103999-104000`、`:126613-126615`、`node-CC-GAWt2.js:369121` |
| `warning` | 派生字段：告警已触发 | `main-DYeEwXNf.js:104076-104080`、`:126692` |

派生规则：`remainingPercent = 100 - usagePercent`（`main-DYeEwXNf.js:103684-103689`）；窗口缺失时按 `NOT_STARTED`、`usagePercent=0` 处理（`main-DYeEwXNf.js:126683-126690`）。

### 3.4 生效条件（关键状态机）

| 条件 | 结论 | 证据 |
| --- | --- | --- |
| `quotaStatus==="ACTIVE" && statusReason===null && !vip` | 管控生效（才参与"额度快用尽"判定） | `main-DYeEwXNf.js:103958` |
| `vip===true` | 永不显示额度告警 | `main-DYeEwXNf.js:126584` |
| `quotaStatus!=="ACTIVE"` | 不显示告警/横幅 | `main-DYeEwXNf.js:126584` |
| `statusReason==="OUTSIDE_WORK_TIME"` | 不显示告警；设置页提示"非工作时间可无限使用" | `main-DYeEwXNf.js:126584`、`index-qzGIr_t2.js:3025`、`zh-CFSgfJVU.js:854` |
| `BYPASSED + VIP` | "您享有无限使用额度" | `index-qzGIr_t2.js:3021`、`zh-CFSgfJVU.js:859` |
| `BYPASSED + (OUTSIDE_GRAY_SCOPE \| null)` / `DISABLED + CONTROL_DISABLED` | "暂无额度管控" | `index-qzGIr_t2.js:3022-3023`、`zh-CFSgfJVU.js:856` |
| `DISABLED`（其他） | "额度限制功能暂未开启" | `index-qzGIr_t2.js:3026`、`zh-CFSgfJVU.js:857` |
| `DEGRADED` | "额度系统暂时无法响应" | `index-qzGIr_t2.js:3020`、`zh-CFSgfJVU.js:855` |

策略文案（等价于服务端契约）：

| 文案 | 中文原句 | 证据 |
| --- | --- | --- |
| 工作日生效 | 「额度限制仅在工作日 {{workTime}} 生效」 | `zh-CFSgfJVU.js:853`、`main-DYeEwXNf.js:45079` |
| 非工作时段不限 | 「非工作时段（{{workTime}}以外）不受额度限制」 | `zh-CFSgfJVU.js:854`、`main-DYeEwXNf.js:45080` |
| 5H 起算 | 「从发送第一条消息开始后的5小时额度限制」 | `zh-CFSgfJVU.js:848`、`main-DYeEwXNf.js:45074` |
| 7D 滚动 | 「按滚动7天统计；遇到法定节假日，重置周期顺延相应天数」 | `zh-CFSgfJVU.js:849`、`main-DYeEwXNf.js:45075` |

> 推论（重要）：**服务端在非工作时段应返回 `quotaStatus=BYPASSED`/`statusReason=OUTSIDE_WORK_TIME`**，客户端据此完全不限制使用。代理若只读 `usagePercent`，会在夜间/周末把"昨日已耗尽"的账号继续当耗尽处理，这是当前最大可用性风险之一。

### 3.5 重置与重试语义

| 概念 | 语义 | 证据 |
| --- | --- | --- |
| `resetAt` | 窗口重置时间；UI 只用于展示"将于 X 重置" | `main-DYeEwXNf.js:103712-103734`、`:126829-126831` |
| `used`/`limit` | 窗口已用/总量（可选） | `node-CC-GAWt2.js:369119-369120`、`:369252-369254` |
| `retryAt` | 服务端建议重试时间；引擎解析并写入耗尽事件，UI 当前未消费 | `node-CC-GAWt2.js:369192-369202`、`:457420-457423` |
| 双窗口耗尽主周期 | `periods.includes("7D") ? "7D" : "5H"`（7D 优先） | `node-CC-GAWt2.js:369189` |
| 5H 低用量但 7D 耗尽 | 主周期=7D；`resetAt` 取 7D `periodDetails.resetAt` | `node-CC-GAWt2.js:369188-369192` |
| 工作时段外 | 不消耗、不限制（见 3.4） | 同上 |

### 3.6 与 `lib/quota.mjs` 的差距

| 差距 | 现状（我方） | 官方口径 | 影响 |
| --- | --- | --- | --- |
| 未解析 `quotaStatus/statusReason/vip` 的生效门控 | `headroom()` 只处理 `bypassed = quotaStatus==='BYPASSED'`（`lib/quota.mjs:74`、`:275-292`） | `ACTIVE && statusReason===null && !vip` 才生效；`OUTSIDE_WORK_TIME`/`VIP`/`OUTSIDE_GRAY_SCOPE`/`DISABLED` 均视为不限制 | 非工作时段/未纳管/功能关闭账号被错误扣分或按 0.5 假设；选号偏差 |
| 未解析窗口 `status/startedAt/thresholdPercent` | `parseQuotaWindow` 只取 `usagePercent/used/limit/resetAt/retryAt/level/windowId`（`lib/quota.mjs:5-29`） | `NOT_STARTED` 表示首用前、`thresholdPercent` 决定告警、`startedAt` 标识窗口起点 | 首用前窗口被当"未知/半额"，告警阈值缺失 |
| `exhausted` 只看 `usagePercent===100` | `lib/quota.mjs:75`、`:261` | 还需尊重 `status=EXHAUSTED` 与 `periodDetails` | 边界（如 99.5 向上取整、状态直给）漏判 |
| 缺 `nextLevel/nextUpgradeAt/gradingPending` 输出 | 仅 `summarizeQuota` 读 `gradingPending` 未用（`lib/quota.mjs:43`） | 属于契约字段 | 运维面无法展示等级/升级时机 |
| `periodDetails` 未消费 | `extractQuotaSignal` 透传原始 `periodDetails`（`lib/quota.mjs:102`），`recordPassive` 忽略 | 每窗口独立 `used/limit/usagePercent/resetAt/retryAt`（含 PascalCase 兼容） | 多窗口耗尽时冷却时间取错（见 P0-4） |
| 无工作时段感知 | `headroom` 线性用 `usagePercent` | 工作日 + `quotaWorkTime` + 节假日顺延 | 冷却跨越非工作时段仍生效，可用性浪费 |
| `nextResetAt()` 未被使用 | `lib/quota.mjs:295-300` 定义但无调用点 | — | 冷却/放行缺少统一"最早恢复时间"来源 |

---

## 4. 额度告警与耗尽

### 4.1 `QUOTA_WARNING` 的传输位置与结构

告警**不是独立 HTTP 事件**，而是嵌在 chat 响应流（SSE）或 429 响应体中的业务信封：

| 层 | 结构 | 证据 |
| --- | --- | --- |
| 信封 | `{ ..., codefree: { notifications: [...], canUpgrade?, quotaWorkTime? } }`，`data` 包裹可有可无 | `node-CC-GAWt2.js:369096-369131` |
| 通知项 | `type:"QUOTA_WARNING"`、`period:"5H"\|"7D"`、`usagePercent:number`、`resetAt:number`、`eventId:string`（必填）、`used?`、`limit?`、`thresholdPercent?`、`canUpgrade?`、`windowId?` | `node-CC-GAWt2.js:369102-369124`、`:457380-457389` |
| 资格过滤 | 非法字段（无 period/usagePercent/resetAt/eventId 或越界）直接丢弃 | `node-CC-GAWt2.js:369106-369111` |
| 发布事件 | `codefree.quota.warning`：`{sessionID, provider:"codefree", requestID?, notification, exhausted, canUpgrade?, quotaWorkTime?}` | `node-CC-GAWt2.js:457398-457408`、`:464415-464425` |

### 4.2 阈值与选择/去重

| 规则 | 内容 | 证据 |
| --- | --- | --- |
| 告警资格 | `usagePercent===100` 或（`<100` 且 `thresholdPercent!==undefined` 且 `usagePercent>=thresholdPercent`） | `node-CC-GAWt2.js:369166-369169` |
| 每周期取最新 | 以 `period` 为键取最后一条 | `node-CC-GAWt2.js:369134-369137` |
| 选择顺序 | 已耗尽：7D 100% > 5H 100% > 5H ?? 7D；未耗尽：5H 优先，7D 作为附加 | `node-CC-GAWt2.js:369144-369165` |
| 流内去重 | `warningID = ${period}:${eventId}:${usagePercent}`，同流内不重复发布 | `node-CC-GAWt2.js:459765-459768` |
| 跨重启去重 | 桌面主进程按 `(period, user, eventId)` claim/release，持久化到 `opencode.global.dat` 键 `codefree-quota-notices.v3` | `index.js:2045-2073`、`:2103-2105`、`:2345-2350` |
| 渲染器去重 | 按 `(period,user,eventId)` 决定是否弹系统通知 | `index.js:2068-2070` |
| 横幅退订 | 按 `(userId,type,period,resetAt)` 持久化；键 `codefree-quota-banner-dismissals.v1` | `index.js:2077-2101`、`:2104-2105`、`main-DYeEwXNf.js:126635-126698` |

桌面呈现链路：`codefree.quota.warning` → 渲染器更新 overlay（`main-DYeEwXNf.js:104064-104103`）→ 250ms 防抖后重新 `GET /quota/v1/me`（`:104051-104063`）→ 横幅/通知按阈值与退订记录渲染（`:126578-126634`、`:126818-126860`）。

### 4.3 耗尽信号（429 / 流内）

| 项 | 内容 | 证据 |
| --- | --- | --- |
| 429 响应体 | `{ code:"AI_QUOTA_EXHAUSTED", period?/periods?, exhaustedMask?, periodDetails?, used?, limit?, resetAt?, retryAt?, canUpgrade?, level?, quotaWorkTime? }` | `node-CC-GAWt2.js:369171-369207`、`:459635-459644` |
| 流内 data 帧 | 同上结构（`inspectFrame` 逐帧解析；命中即中止读取） | `node-CC-GAWt2.js:369752`（`inspectFrame` 调用 `parseCodefreeQuotaExhausted`）、`:459746-459794` |
| 中止语义 | 命中耗尽帧 → `reader.cancel()`，把剩余帧转成 `Error(JSON)` 抛给上层，不再当正常内容 | `node-CC-GAWt2.js:459688-459705` |
| `exhaustedMask` 位语义 | 位 0（值 1）= `5H`，位 1（值 2）= `7D` | `node-CC-GAWt2.js:369179-369185` |
| `periodDetails` 形状 | 数组或对象均可；字段兼容 PascalCase（`Period/Used/Limit/UsagePercent/ResetAt/RetryAt`） | `node-CC-GAWt2.js:369243-369270` |
| 主周期与 resetAt | `period = periods.includes("7D") ? "7D" : "5H"`；`resetAt = periodDetails[period].resetAt ?? root.resetAt` | `node-CC-GAWt2.js:369189-369192` |
| 发布事件 | `codefree.quota.exhausted`（含 `exhaustedMask/periodDetails/used/limit/resetAt/retryAt/level/quotaWorkTime`） | `node-CC-GAWt2.js:457410-457429`、`:464430-464451` |
| 对话呈现 | 追加文本「额度用尽，已停止回答。」并把 assistant 标记失败，失败体为 `AI_QUOTA_EXHAUSTED` JSON | `node-CC-GAWt2.js:369298`、`:369489-369500` |

### 4.4 请求用途抑制（title 请求不产生额度提示）

| 项 | 内容 | 证据 |
| --- | --- | --- |
| 头名 | `x-codefree-request-purpose`，值 `title` / `answer` | `node-CC-GAWt2.js:459810` |
| 注入点 | 仅 CodeFree provider：`input.agent.name === "title" ? "title" : "answer"` | `node-CC-GAWt2.js:484967-484975` |
| 消费点 | fetcher 读取后删除该头；`title` 用途不发布 warning/exhausted 事件 | `node-CC-GAWt2.js:464391-464393`、`:459802-459809` |
| 意义 | 背景标题生成等辅助请求不会打扰用户、也不会触发额度横幅 | 同上 |

### 4.5 与我们的差距

| 差距 | 现状 | 官方口径 | 影响 |
| --- | --- | --- | --- |
| 无 `thresholdPercent` 判定 | 任意 `QUOTA_WARNING` 都记录（`lib/quota.mjs:112-130`、`server.mjs:328-331`） | 仅 `===100` 或 `>=thresholdPercent` 视为有效告警 | 误告警、过度保守 |
| 无 `eventId` 去重 | 每帧都处理 | 同流 `period:eventId:usagePercent` 去重；跨重启持久化 | 重复告警/重复刷新 |
| 无 `periodDetails` 消费 | 仅根字段（`lib/quota.mjs:243-256`） | 每窗口独立 reset/retry，主周期 7D 优先 | 冷却时间取错（P0） |
| 无 title 用途语义 | 不发送该头 | title 请求抑制通知 | 若代理引入标题/摘要请求会产生额外通知与计量 |
| 仅池级告警 | `lib/alerts.mjs:22-60` 只有"全池耗尽/全池失效" | 单账号按窗口阈值告警 + 退订 | 运维滞后，无法提前扩容 |

---

## 5. 多账号与鉴权

### 5.1 CodeFree SSO：单账号运行时

| 环节 | 实现 | 证据 |
| --- | --- | --- |
| 登录方式 | OAuth2 授权码 + PKCE（S256），授权页 `/login/oauth/authorize` | `node-CC-GAWt2.js:395282-395355`、`:395477` |
| 回调 | `http://127.0.0.1:<随机端口>/oauth2callback?from=codefree-o&randomCode=NNNN`；`redirect_uri=<baseUrl>/login/oauth-srdcloud-redirect` | `node-CC-GAWt2.js:395288-395296` |
| state | `base64(本地回调 URL)`（防 CSRF/回填，非随机数） | `node-CC-GAWt2.js:395290-395291` |
| 超时/重试 | 5 分钟超时；手动粘贴授权码最多 3 次 | `node-CC-GAWt2.js:395017`、`:395319-395343` |
| token 端点 | `/api/usercenterbackend/oauth/access_token` | `node-CC-GAWt2.js:395477` |
| 刷新 | `grant_type=refresh_x_cf_token` + `client_id` + `x_cf_refresh_token` + `client_secret` | `node-CC-GAWt2.js:395405-395413` |
| token 字段归一 | `x_cf_token`/`cf_token`、`x_cf_refresh_token`/`refresh_token`；默认有效期 7200s / 604800s | `node-CC-GAWt2.js:395169-395184` |
| 提前刷新窗口 | 60 秒 | `node-CC-GAWt2.js:395497`、`:395839-395846` |
| 刷新被拒 | 400/401 → `CodeFree authorization expired`（要求重新登录） | `node-CC-GAWt2.js:395405-395423` |
| 轮换竞态兜底 | 刷新被拒时**回读凭据文件**，若 refresh token 已变则用文件值重试一次 | `node-CC-GAWt2.js:395451-395475` |
| 凭据文件 | `Path.data/codefree.json`（v2：加密或明文 refresh token + `userId`/`clientId`/`baseUrlSnapshot`） | `node-CC-GAWt2.js:395491-395520` |
| 备用路径 | `~/.local/share/opencode/codefree.json`、`~/.codefree/common/agent/core/.codefree-o/codefree.json` | `node-CC-GAWt2.js:395493-395496` |
| 加密算法 | AES-256-GCM，密钥=sha256(常量 `codefree-o-refresh-token-local-encryption-key-v1`) | `node-CC-GAWt2.js:394893-394913`、`:395477` |
| v1 兼容 | 检测到 legacy 结构（`encryptedApiKey`/`sessionId`）→ 直接清除凭据 | `node-CC-GAWt2.js:395385-395388`、`:395521-395526` |
| 登录状态接口 | `GET /codefree/auth/status`；`POST /codefree/auth/login`；`POST /codefree/auth/logout` | `node-CC-GAWt2.js:706533-706580` |
| 状态字段 | `authenticated/baseUrl/mode?/managedBy?/canLogin?/canLogout?/userId?/clientId?/expiresAt?/login{state,startedAt,authUrl,message}` | `node-CC-GAWt2.js:706537-706555` |
| 资料接口 | `GET /codefree/auth/profile`（内部 `userFrontPath=/api/usercenterbackend/user-cfwebview/v1/get-user-front/{userId}`） | `node-CC-GAWt2.js:712155-712181`、`:395221-395239` |
| 桌面入口 | 仅「退出登录」一个动作（无账号切换） | `index.js:44226`、`main-DYeEwXNf.js:108755-108889` |

结论：**桌面端同一时刻只有一个 CodeFree 身份**；`/codefree/auth/status` 只有一个 `userId`，没有账号列表；切换身份 = 退出再登录。

### 5.2 请求签名与鉴权头

| 模式 | 头 | 证据 |
| --- | --- | --- |
| OAuth 模式 | `X-Cf-Token`、`userId`、`projectId:"0"`、`X-Cf-AppId`、`X-Cf-Timestamp`、`X-Cf-Nonce`、`X-Cf-Signature`；删除 `Authorization`/`apiKey` | `node-CC-GAWt2.js:396417-396432` |
| 签名算法 | `HMAC-SHA256(secret, "METHOD\nappId\ntimestamp\nnonce")`，Base64 | `node-CC-GAWt2.js:394691-394703` |
| clientId/secret 分环境 | 按 `baseUrl` 含 `dev`/`test`/其他 三档硬编码（我方 `lib/config.mjs:154-164` 已有同映射） | `node-CC-GAWt2.js:394764-394785`、`:394776-394785` |
| 环境变量覆盖 client secret | `CODEFREE_CLIENT_SECRET` | `node-CC-GAWt2.js:394776-394779` |
| 基础 URL 解析 | `CODEFREE_BASE_URL` > channel（dev/test/latest）> version 字符串包含 dev/test 的兜底 | `node-CC-GAWt2.js:394538-394548` |

### 5.3 环境托管（SRDCLOUD_*）

| 项 | 内容 | 证据 |
| --- | --- | --- |
| 四件套 | `SRDCLOUD_CF_ACCESS_TOKEN`、`SRDCLOUD_USERID`、`SRDCLOUD_PROJECTID`、`SRDCLOUD_BASE_URL` | `node-CC-GAWt2.js:394505-394510` |
| 判定 | 全缺→`mode:"oauth"`；部分缺→直接报错（不允许半配置） | `node-CC-GAWt2.js:394518-394535` |
| 文件形式 | `~/.srdcloud_env`，只接受 `export KEY='value'` 行；缺失/非法分别返回状态 | `node-CC-GAWt2.js:394557-394590` |
| 传输方式 | 以 `accessToken`/`userId`/`projectId` 头替代 `X-Cf-*` 与签名，删除 `Authorization`/`apiKey`，`redirect:"error"` | `node-CC-GAWt2.js:396444-396477` |
| 基址校验 | 必须 HTTPS、无凭据/查询串/fragment | `node-CC-GAWt2.js:394474-394490` |
| 限制 | 环境模式禁止保存/清除/刷新/登录（`managedBy:"cloud-cli"`） | `node-CC-GAWt2.js:395767-395772`、`:395789-395812`、`:706544-706555` |
| 子进程隔离 | 环境模式下从派生子进程环境中剥离这四个变量 | `node-CC-GAWt2.js:394852-394856`、`:395499-395504` |

### 5.4 `account` / `account_state` / `control_account`：opencode 控制面账号（与 CodeFree 无关）

| 项 | 内容 | 证据 |
| --- | --- | --- |
| 表结构 | `account{id,email,url,access_token,refresh_token,token_expiry}`；`account_state{id,active_account_id,active_org_id}`；`control_account{email,url,access_token,refresh_token,active}` | `node-CC-GAWt2.js:67425-67534`、`:68444-68473`、`:459126-459152` |
| 迁移 | `selected_org_id` 从 `account` 移到 `account_state.active_org_id` | `node-CC-GAWt2.js:67537-67553` |
| 登录方式 | **设备码 OAuth**（`clientId:"opencode-cli"`）：`POST {server}/auth/device/code`、`POST {server}/auth/device/token`（grant `urn:ietf:params:oauth:grant-type:device_code`） | `node-CC-GAWt2.js:459357`、`:459569-459618` |
| 关联接口 | `GET {server}/api/user`、`GET {server}/api/orgs`、`GET {server}/api/config`（带 `x-org-id`） | `node-CC-GAWt2.js:459514-459520`、`:459557-459567` |
| 多账号/组织切换 | `Account.list/use/orgsByAccount/remove`；`account_state.active_account_id/active_org_id` | `node-CC-GAWt2.js:459285-459328`、`:459536-459556` |
| 桌面暴露 | `experimental.console`/`consoleOrgs`/`consoleSwitch`（switchableOrgCount、activeOrgName） | `node-CC-GAWt2.js:708135-708173` |
| 用途 | 连接 opencode 控制面/远程实例的账号与组织，**不参与 CodeFree 模型调用与额度**（CodeFree provider 用 `CodefreeAuth.loadRuntime()` 单运行时） | `node-CC-GAWt2.js:465811-465826`、`:464373-464375` |

> 结论：把 `account*` 表理解为"桌面端可管理多个 CodeFree 账号"是误读；它们属于 opencode console 账号体系。桌面端 CodeFree 侧仍是单账号。

### 5.5 与我们的多账号代理对比

| 维度 | 官方桌面 1.10.1 | 我们的代理 |
| --- | --- | --- |
| 账号数量 | 1 个活动 CodeFree 身份 | 多账号（`config.accounts` + 多个 authfile；`lib/config.mjs:167-225`） |
| 切换方式 | 退出→重新登录（`/codefree/auth/logout`+`login`） | 池选号 + `preferred` + sticky 会话（`lib/pool.mjs:671-716`） |
| 凭据存储 | 单 `codefree.json` v2（AES-GCM） | 读取多个 `codefree.json` v2、解密、镜像写回（`lib/credentials.mjs:26-94`） |
| 刷新轮换 | 回读文件重试 + 被拒即清除（`node-CC-GAWt2.js:395451-395475`） | journal + `#reconcileFromSources` + 原子写回（`lib/credentials.mjs:139-184`、`lib/pool.mjs:228-276`） |
| 组织 | opencode console org（无关） | 无 |
| 环境托管 | `SRDCLOUD_*` / `.srdcloud_env` | 暂不支持（建议 P2 补齐） |
| 账号资料 | `userFront`（name/userAccount） | 无（可用作 label 增强） |
| 共用同一 `codefree.json` 时 | 官方回读重试兜底 | 我方 mirror 写回会与官方**互相轮换**，需外部变更检测/只读模式 |

---

## 6. 版本路径（VERSION）与升级影响

### 6.1 版本来源与使用点

| 项 | 内容 | 证据 |
| --- | --- | --- |
| 引擎版本常量 | `InstallationVersion = "1.10.1"`（**硬编码在引擎 bundle 内**） | `node-CC-GAWt2.js:68785` |
| 导出 | `VERSION37 = InstallationVersion` → `Installation.VERSION` | `node-CC-GAWt2.js:394125` |
| modelmgr 路径 | `/api/acbackend/modelmgr/v1/clients/codefree-o/versions/${VERSION}` | `node-CC-GAWt2.js:461381` |
| `clientVersion` 头 | `clientVersion: InstallationVersion` | `node-CC-GAWt2.js:464462` |
| User-Agent | `opencode/${InstallationChannel}/${InstallationVersion}/${client}` | `node-CC-GAWt2.js:394086-394087` |
| 桌面包版本 | `package.json` `version: 1.10.1`（当前构建与引擎版本一致） | `package.json` |

### 6.2 升级影响

| 影响 | 说明 | 证据 |
| --- | --- | --- |
| 模型目录可能为空 | 路径含版本；服务端不认该版本 → 非 0 `optResult`/404 → 引擎抛错，UI 无模型 | `node-CC-GAWt2.js:461383-461394`、`:465774-465789` |
| 客户端可能被风控/统计异常（推断） | `clientVersion` 与 UA 携带版本，服务端可按版本做限流/灰度；版本不匹配的行为无静态证据，标注为**推断** | `node-CC-GAWt2.js:464462`、`:394086-394087` |
| 升级后自动发现失效 | 我方默认 `1.10.1` 固定值；`autoDetectVersion` 已从 asar `package.json` 读取 | `lib/config.mjs:24-27`、`lib/codefree-app.mjs:1-93` |

### 6.3 自动识别的增强建议

| 优先级 | 方案 | 依据 | 备注 |
| --- | --- | --- | --- |
| 已有 | 环境变量 `CODEFREE_VERSION` 显式覆盖 | `lib/config.mjs:120` | 保留 |
| 已有 | 读安装目录 asar 的 `package.json.version` | `lib/codefree-app.mjs:49-93` | 得到**桌面包**版本 |
| 建议 | 在 asar 内扫描引擎 chunk，正则提取 `var InstallationVersion = "x.y.z"` | `node-CC-GAWt2.js:68785` | 得到**引擎真实版本**（与桌面包版本可能不同步；modelmgr 用的是引擎版本） |
| 建议 | CLI/无桌面场景读 npm 全局 `@srdcloud/codefree-o/package.json` | 包名见 `node-CC-GAWt2.js:394101` | WSL/服务器部署常见 |
| 建议 | 远端探测兜底：以候选版本请求 modelmgr，`optResult===0` 即采用，结果缓存并定期过期 | 依据 `node-CC-GAWt2.js:461392`（`optResult` 判定） | 无官方"版本列表"接口，只能探测 |

---

## 7. 优先级差距清单

### P0（正确性/可用性，建议立即处理）

| # | 差距 | 证据 | 一句话理由与影响 |
| --- | --- | --- | --- |
| P0-1 | 额度"是否生效"门控未接入选号/冷却：仅识别 `quotaStatus==='BYPASSED'`，未处理 `DISABLED`、`statusReason`（`OUTSIDE_WORK_TIME/VIP/OUTSIDE_GRAY_SCOPE/CONTROL_DISABLED`）、`vip`、`DEGRADED` | 官方：`main-DYeEwXNf.js:103958`、`:126584`、`index-qzGIr_t2.js:3016-3031`；我方：`lib/quota.mjs:74`、`:275-292`、`lib/pool.mjs:725-765` | BYPASSED/DISABLED 时额度本就不限制，按百分比冷却会让账号在夜间/周末/未纳管期被错误降权甚至长时间冷却，直接损失可用容量。 |
| P0-2 | 窗口 `status`/`startedAt`/`thresholdPercent` 未解析，`NOT_STARTED` 被当作未知半额 | 官方：`main-DYeEwXNf.js:126683-126695`、`:103991-104013`；我方：`lib/quota.mjs:5-29`、`:275-292` | 5H 窗口"首用前"不应扣分，当前 `assumeUnknownHeadroom=0.5` 会让新账号/新窗口在无消耗时被保守降权。 |
| P0-3 | 模型级 `accessMode=LEGACY` 未参与额度判定 | 官方：`node-CC-GAWt2.js:461413`、`main-DYeEwXNf.js:128822`（LEGACY 模型隐藏额度横幅、视为无限）；我方：`server.mjs:283-295`、`lib/pool.mjs:649-665` | LEGACY 通道不受额度限制，代理仍按账号额度评分/冷却会导致使用免费不限额度模型时被限流。 |
| P0-4 | 多窗口耗尽的 `periodDetails`/`retryAt` 未消费，冷却时间取错 | 官方：`node-CC-GAWt2.js:369189-369192`、`:369243-369270`（7D 优先、按窗口自身 reset/retry）；我方：`lib/quota.mjs:102`、`:243-256`、`lib/pool.mjs:734-738` | 429 只带 `periodDetails` 而无根 `resetAt` 时，当前会退化为 300s 冷却，早于 7D 重置 → 反复撞 429，并且污染账号健康统计。 |
| P0-5 | 流内 `AI_QUOTA_EXHAUSTED` 未按"失败"处理（仍透传帧、仍 `onSuccess`） | 官方：`node-CC-GAWt2.js:459688-459705`、`:369489-369500`、`:369298`；我方：`server.mjs:328-355`（scan 后直接转发并 `onSuccess`） | 流内耗尽意味着账号已不可用，当前既未冷却也未判失败，下一次请求仍可能选中该账号；客户端还会收到非标准业务帧。 |

### P1（能力/契约对齐，建议近期处理）

| # | 差距 | 证据 | 一句话理由与影响 |
| --- | --- | --- | --- |
| P1-1 | `/v1/models` 剩余差距：`limit.output` 语义偏差（官方请求硬顶 32000，我方输出 `maxOutputTokens=8000`）、缺 `cost/status/release_date/family` | 官方：`node-CC-GAWt2.js:461395-461451`、`:460991-460993`；我方：`lib/upstream.mjs:123-152`（v2.4.0 已补 capabilities/contextWindow/limit） | 客户端按 `limit.output` 设 `max_tokens` 会与官方行为不一致（长回答截断）；计费/展示字段缺失影响兼容。 |
| P1-2 | 未接 `modelproviders` 目录（能力/成本/推理档位/状态 + provider 白名单） | 官方：`node-CC-GAWt2.js:461453-461468`、`:688297-688404`、`:192108-192154`、`:465827-465837` | 这是唯一权威的富元数据来源，缺它只能靠硬编码推断，模型升级/新增后能力失真。 |
| P1-3 | 告警阈值/去重未实现：无 `thresholdPercent` 判定、无 `eventId` 去重 | 官方：`node-CC-GAWt2.js:369166-369169`、`:459765-459768`、`index.js:2045-2073`；我方：`lib/quota.mjs:112-130` | 任何通知都当告警会造成误报与重复刷新，运维噪声大且过早保守。 |
| P1-4 | 额度契约字段输出不全：`level/nextLevel/nextUpgradeAt/gradingPending/vip/quotaWorkTime/retryAt` | 官方：`main-DYeEwXNf.js:104033-104045`、`:103736-103739`、`index-qzGIr_t2.js:3015-3031`；我方：`lib/quota.mjs:32-78`、`server.mjs:452-502` | 运维面无法展示等级/升级时机/工作时段，排障与容量评估缺关键信息。 |
| P1-5 | 版本自识别仅覆盖桌面 asar `package.json`（v2.4.0 已实现该路径）；缺引擎 chunk 版本、CLI npm 包与远端探测兜底 | 官方：`node-CC-GAWt2.js:68785`（引擎版本常量）、`:461381`；我方：`lib/codefree-app.mjs:1-93` | 引擎版本才是 modelmgr 路径与 `clientVersion` 的真实来源；桌面/CLI 升级不同步时模型目录可能拉空。 |
| P1-6 | 刷新鉴权失败判定偏窄（按关键字判定 `invalid_grant/invalid_client`） | 官方：`node-CC-GAWt2.js:395405-395423`（任何 400/401 即视为 reauth required） | 上游错误体变化时会漏判为普通失败，造成无意义重试与错误的冷却策略。 |
| P1-7 | 共用官方 `codefree.json` 时缺少"外部轮换"检测 | 官方同类兜底：`node-CC-GAWt2.js:395451-395475`；我方：`lib/credentials.mjs:62-94`、`lib/pool.mjs:228-276` | 桌面端与代理同时持有同一 refresh token 会互相踢下线；需要写回前比对 revision、冲突时回读，或强制只读模式。 |

### P2（体验/运维增强，可按需排期）

| # | 差距 | 证据 | 一句话理由与影响 |
| --- | --- | --- | --- |
| P2-1 | 不支持 `SRDCLOUD_*` / `~/.srdcloud_env` 环境托管凭据 | 官方：`node-CC-GAWt2.js:394505-394590`、`:396444-396477` | 云/CI 部署可零登录接入，减少账号文件分发与密钥落盘。 |
| P2-2 | 账号资料未接入 `userFront`（name/userAccount） | 官方：`node-CC-GAWt2.js:395221-395239`、`:712155-712181` | `/admin/accounts` 的 label 可用真实姓名/工号，提升多账号运维可读性。 |
| P2-3 | `codefree.json` 备用路径未覆盖 | 官方：`node-CC-GAWt2.js:395493-395496`（`~/.local/share/opencode/...`、`~/.codefree/common/agent/core/.codefree-o/...`） | 提高不同安装方式（WSL/旧布局）下的凭据导入成功率。 |
| P2-4 | `subService` 归属不可按客户端选择（固定 `codefree_o_chat`） | 官方：`node-CC-GAWt2.js:414200-414221`、`:464401` | 便于区分桌面/CLI/沙箱流量与统计归因（不改变配额语义）。 |
| P2-5 | 无额度升级透传接口（`POST /quota/v1/me/upgrade`，200/202，`APPLIED/PENDING_SYNC`，409 冲突） | 官方：`node-CC-GAWt2.js:707148-707178`、`:709861-709881`、`index-qzGIr_t2.js:3051-3074` | 管理面可一键升级并轮询同步，减少人工登录桌面操作。 |
| P2-6 | 告警仅池级，缺单账号按窗口阈值 + 退订语义 | 官方：`index.js:2077-2101`、`main-DYeEwXNf.js:126613-126634`；我方：`lib/alerts.mjs:22-60` | 可按 (userId, period, resetAt) 提前预警与免打扰，贴合官方体验。 |
| P2-7 | 探测频率/并发为代理自定义，无"仅在需要时探测"的官方约束 | 官方仅渲染器打开/额度事件后拉取：`main-DYeEwXNf.js:103697-103711`、`:104051-104063`；我方：`lib/pool.mjs:481-534` | 保持现有主动探测（收益明确）但应维持限速与预算，避免触发上游风控。 |

---

## 8. 附：关键 HTTP 契约速查

| 接口 | 方法 | 请求要点 | 响应要点 | 证据 |
| --- | --- | --- | --- | --- |
| `/api/acbackend/modelmgr/v1/clients/codefree-o/versions/{version}` | GET | 签名/token 头；无 `clientType` | `{optResult:0, data:[item...]}` | `node-CC-GAWt2.js:461380-461451` |
| `/api/acbackend/modelproviders/v1/providers` | GET | `clientType: codefree-o` | `{optResult:0, providers:[{id,name?,value:Provider}]}` | `node-CC-GAWt2.js:461453-461468`、`:688297-688404` |
| `/api/acbackend/codechat/v1/completions` | POST | `X-Codefree-Quota-Schema:1`、`modelName`、`subService`、`sessionId`、`codefreeClient` | OpenAI 兼容流/非流；流内可含 `codefree.notifications[]` 或 `AI_QUOTA_EXHAUSTED` | `node-CC-GAWt2.js:464373-464405`、`:459746-459794` |
| `/api/aebackend/codefree-embedding-svc/v1/text-to-embedding-vector` | POST | 与原 `/embeddings` 请求体一致 | 透传 | `node-CC-GAWt2.js:464385` |
| `/api/aebackend/quota/v1/me` | GET | `Accept: application/json` | 透传（无正式 schema） | `node-CC-GAWt2.js:707148`、`:709861-709877` |
| `/api/aebackend/quota/v1/me/upgrade` | POST | 透传 | 200/202；`APPLIED`/`PENDING_SYNC` | `node-CC-GAWt2.js:707150`、`index-qzGIr_t2.js:3057-3066` |
| `/api/usercenterbackend/oauth/access_token` | POST | `grant_type=authorization_code` 或 `refresh_x_cf_token` | `x_cf_token`/`x_cf_refresh_token` 等 | `node-CC-GAWt2.js:395260-395281`、`:395405-395424` |
| `/api/usercenterbackend/user` | GET | `Authorization: Bearer <accessToken>` | 用户信息/`userId` | `node-CC-GAWt2.js:395240-395258` |
| `/api/usercenterbackend/user-cfwebview/v1/get-user-front/{userId}` | GET | `X-Cf-Token`、`userId`、`projectId:"0"`、签名 | `{name, userAccount}` | `node-CC-GAWt2.js:395221-395239` |
| `/codefree/auth/status` | GET | 本机 opencode server | 单账号状态 | `node-CC-GAWt2.js:706556-706580` |

## 9. 未确认项与侦察边界说明

未确认项（静态证据不足，需真实抓包/运行时验证后再定稿）：

- `modelproviders` 响应中 `providers[].name`（白名单消费，`node-CC-GAWt2.js:461468`）与 `providers[].id/.value`（目录消费，`:688314-688335`）是否为同一次返回的同一形状——待抓包确认。
- 版本不匹配是否会被服务端风控/限流：仅从 `clientVersion`/UA 存在推断，**尚无证据**。
- `quota/v1/me` 在服务端是否始终下发 `thresholdPercent/startedAt/status/vip/level`：客户端对缺失字段均有兜底，服务端实际最小必填字段未知。
- `accessMode` 的完整取值集合：仅确认 `"LEGACY"`（不限额度通道），其余取值语义未知。
- `gradingPending/nextLevel/nextUpgradeAt` 的业务含义：客户端已解析但当前 UI 未消费，无法从代码反推完整语义。

以下为侦察方法边界：

1. `quota/v1/me` 在引擎侧定义为 `Schema.Unknown`（`node-CC-GAWt2.js:707152`、`:707168`），上述字段来自渲染器消费代码与默认值对象，属**客户端期望契约**；服务端真实返回可能新增/调整字段，代理应保持宽松解析。
2. `modelproviders` 响应同时存在 `.name`（白名单消费）与 `.id/.value`（目录消费）两条读取路径（`node-CC-GAWt2.js:461468` vs `:688314-688335`），静态证据无法确认二者是否指向同一次返回的同一形状；建议接入时以真实抓包校验。
3. 版本不匹配是否会被服务端风控/限流，仅能从 `clientVersion`/UA 存在推断，**尚无静态或运行时证据**。
4. 本报告未打印任何密钥明文；`signingSecret`、`clientId/clientSecret` 等常量位置已在文中标注，取值与本仓库 `lib/config.mjs:24`、`:154-164` 一致。
5. 未运行 CodeFree-O GUI、未发起任何上游请求，全部结论来自静态代码阅读。
