# CodeFree-O 代理检测机制侦察报告

| 项 | 内容 |
|----|------|
| 文档编号 | CFO-DETECT-001 |
| 日期 | 2026-11-10 |
| 对象 | CodeFree-O Desktop **1.10.1**（Electron + opencode 内核） |
| 方法 | 解包 bundle 静态检索（`out/main/chunks/node-CC-GAWt2.js` 32.8MB + `out/renderer/assets/*.js`）+ 代理侧实测 |
| REA 工件证据 | `app.asar` sha256 `d585b03ba7a12387d815cb8fcdff55fc7a67df326f05c9660512ff9792b74419` |
| 结论 | **客户端未见针对"代理/中转/多账号"的主动检测**；服务端侧存在可用于关联分析的信号（IP、活动指标、审计、管控状态），但服务端策略不可见 |

---

## 0. 摘要（先看这里）

1. **客户端没有"代理检测"**：bundle 中 `proxy` 相关命中全部是通用依赖
   （npm config 的 `http_proxy/no_proxy`、`proxy-agent`、SolidJS 的 `Proxy` 对象），
   没有 `session.setProxy`、没有系统代理/网络环境探测、没有进程/调试器扫描、
   没有设备指纹上报到 CodeFree 后端；`node-machine-id` 仅被 OpenTelemetry SDK 的
   `HostDetector` 用作 `host.id` 资源属性（默认未配置 OTLP exporter 时不会外发）。
2. **协议指纹已对齐**：官方客户端聊天头（`User-Agent: opencode/1.10.1 ai-sdk/...`、
   `clientType/clientVersion`、`subService=codefree_o_desktop_chat`、
   `X-Codefree-Quota-Schema:1`、`codefreeClient`、`modelName`、`sessionId`）与
   聊天体（`stream=true` + `stream_options.include_usage`）代理均已对齐。
3. **真正需要关注的不是"检测"，而是"关联信号"**：官方桌面聊天在发请求的同时还会向
   `/api/acbackend/statserver/v1/activity_record` 上报活动指标（含 `chat_count`、
   `chat_gen_code_count/line`、`tools_gen_*`、`command_count`，以及 `client.gitUrls`），
   代理链路没有这些上报。若服务端做"聊天用量 vs 活动指标"对账，理论上可形成异常信号——
   但服务端是否这样做**静态不可知**（服务端代码不在客户端 bundle 中）。
4. 本轮新增两项低风险加固：可选的**按账号隔离 sessionId**（避免故障切换后同一会话跨账号）
   与**额度管控状态告警/指标**（`CONTROL_DISABLED` / `DISABLED` / `DEGRADED` 变化可观测）。

---

## 1. 客户端主动检测排查

| 检测维度 | 是否发现 | 证据 / 说明 |
|---|---|---|
| 系统代理/VPN 探测 | ❌ | 未见 `session.setProxy` / `resolveProxy` / PAC 读取；仅通用 npm config 支持 `http_proxy/no_proxy`（说明官方允许企业代理网络） |
| 网络环境/机房特征 | ❌ | `networkInterfaces()` 仅用于 npm 缓存路径/本地地址展示，未上报 |
| 设备指纹（机器码/MAC/序列号） | ❌（默认不外发） | `getMachineId` 只出现在 OTel `HostDetector`（`node-CC-GAWt2.js:112950-112955`），需显式配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 才会导出 |
| 进程扫描 / 调试器检测 | ❌ | 未发现扫描进程、`ptrace`/调试端口检测逻辑 |
| 多开检测 | ❌（风控意义上） | 仅有 opencode 本地实例锁/端口占用（用于本地多实例管理，不是风控） |
| 客户端证书绑定 / 双向 TLS | ❌ | 普通 HTTPS + 应用层签名头 |
| 请求签名绑定设备 | ❌ | `X-Cf-Signature = HMAC(METHOD\nappId\ntimestamp\nnonce)`，不包含 body/设备/IP（`node-CC-GAWt2.js:394684-394703`） |
| 多账号检测（桌面端） | 单账号设计 | 桌面端只有一份 `codefree.json`；`account/control_account` 属于 opencode 控制面设备码账号，与 CodeFree 配额无关（见 `docs/recon-models-quota.md` §5） |

> 结论：桌面端本身不检测"你是不是代理"，也无法区分"请求来自本地 opencode 还是本地代理进程"。

---

## 2. 客户端会向服务端发送什么（可关联数据）

| 数据 | 端点 / 位置 | 内容 | 证据 |
|---|---|---|---|
| 聊天请求 | `POST /api/acbackend/codechat/v1/completions` | 头：`X-Cf-Token`、`userId`、`projectId:0`、签名、`clientType`、`clientVersion`、`subService`、`codefreeClient`、`modelName`、`sessionId`、UA；体：stream + messages（工具/推理字段） | `node-CC-GAWt2.js:464373-464404`、`396393-396439` |
| 活动指标 | `POST /api/acbackend/statserver/v1/activity_record` | `{userId, app, service, time, client:{type, version, gitUrls[]}, activities:[{key, subKey, value:{count}}]}` | `node-CC-GAWt2.js:498681`、`498701` |
| 指标键 | 同上 | `chat_count`（按 `at/no_at` 分）、`chat_gen_code_count/line`、`tools_gen_code_count/line`、`tools_gen_accepted_code_*`、`command_count`、`plugin_subagent_use_count`、`de_subagent_use_count` 等 | `498897`、`498989`、`499115` |
| 安全审计（工具检查） | `POST {security-center}/srdsca/v1/security/tool-check` | `decision/layer/latency/reason/confidence/risk/toolType/toolName/toolParams/userId/sessionId/callId/recentPrompts` | `node-CC-GAWt2.js:692872-692875` |
| 登录/刷新 | `/api/usercenterbackend/oauth/access_token` | `grant_type=refresh_x_cf_token`、`client_id`、`x_cf_refresh_token`、`client_secret`（无设备字段） | `lib/upstream.mjs:70-78` |

> 注意：`activity_record` 的 `client.gitUrls` 是**仓库指纹**（当前工作区 git remote URL 列表），
> 只有真实桌面客户端会带；代理不自造该数据。

---

## 3. 服务端可用的检测/关联面（推断）

| 信号 | 服务端如何获得 | 说明 |
|---|---|---|
| 出口 IP / 频次 | 网络层 | 同 IP 多账号在**企业 NAT 下非常常见**，单凭 IP 不足以判定代理 |
| userId + token | 头字段 | 可关联同一账号的请求，跨设备/跨 IP 行为可被发现 |
| sessionId | 头字段 | 官方客户端 session 由客户端生成；同一 sessionId 出现在不同 userId 下属异常模式 |
| 协议指纹 | headers | UA/clientVersion/subService/请求体结构；代理已对齐桌面口径 |
| 活动指标对账 | activity_record | 桌面聊天会产生 `chat_count` 等指标；代理链路无上报，**潜在缺口信号**（服务端是否使用未知） |
| 安全审计 | tool-check | 仅本地工具执行发生；代理不产生（若服务端要求桌面流量必带审计，同样构成缺口） |
| 管控状态 | quotaStatus/statusReason | `BYPASSED`/`OUTSIDE_GRAY_SCOPE`/`CONTROL_DISABLED`/`DEGRADED` 是服务端下发的控制信号；`CONTROL_DISABLED` 可能代表账号被控制 |
| 限流/并发 | HTTP 429/并发限制 | 代理实测：单账号 6 并发时仅 3 个进入上游（其余被代理本地 503 拒绝，`maxConcurrent=3`），未触发上游并发限制 |

> 服务端风控代码不可见：是否存在专门"代理/共享账号"策略、是否对账 activity_record、
> 是否校验 IP/设备/并发，静态分析**无法确认**。

---

## 4. 对我们代理的风险矩阵

| 检测面 | 官方客户端行为 | 代理现状 | 风险 | 建议/状态 |
|---|---|---|---|---|
| 协议指纹（UA/subService/version/流式参数） | 桌面口径 | 已对齐（v2.5/v2.6，UA 默认 `opencode/<version>`） | 低 | ✅ 已完成 |
| 活动指标缺失（activity_record） | 每次聊天后上报 chat_count 等 | 无上报 | 中（未知是否被对账） | ⚠️ 不建议伪造（伪造痕迹更异常）；如需最严格，可在关键账号上由真实桌面客户端产生流量，或后续做受控上报评估 |
| 同 IP 多账号 | 单账号 | 双账号同机 | 低-中 | 企业 NAT 常见；规模化时建议每账号独立出口 IP |
| 跨账号复用 sessionId | 不会发生 | 故障切换时同一客户端 sessionId 可能到另一账号 | 中 | 已新增 `upstream.sessionIdIsolation`（按账号派生，默认关闭，建议多账号池开启） |
| refresh token 轮换/多写者 | 单写者 + 回读重试 | 已实现单飞 + 回读 + 加密写回 | 低 | ✅ 已有 |
| 单账号并发/速率 | 由引擎/用户操作决定 | `maxConcurrent` 3/2，实测生效 | 低 | ✅ 已有（可按账号调整） |
| 设备指纹 | 无（默认） | 无 | 低 | — |
| 账号被控制状态 | 服务端下发 | 已解析 quotaStatus/statusReason | 低 | ✅ 本轮新增告警 + 指标 |

---

## 5. 本轮新增加固

1. **`upstream.sessionIdIsolation`（默认 false）**：开启后上游 `sessionId = <clientSessionId>-<hash(accountId, sessionId)>`，
   同一会话在故障切换后不会以相同 sessionId 出现在不同账号名下（多账号池建议开启）。
2. **额度管控状态告警与指标**：`QuotaService.recordProbe` 检测
   `CONTROL_DISABLED` / `DISABLED` / `DEGRADED` 并写告警日志（6 小时去重）；
   `/metrics` 新增 `codefree_quota_status_info{status=...}` 与
   `codefree_quota_status_reason_info{reason=...}`，便于发现账号被限流/控制。
3. 并发实测：同账号 6 并发 → 3 个 200、3 个本地 503（maxConcurrent=3 生效），未触发上游限制。

---

## 6. 未确认项与局限

1. 服务端风控策略（是否识别代理/共享账号、阈值、处置方式）无法从客户端 bundle 得到。
2. `activity_record` 是否被用于风险对账未知；`chat_count` 仅在客户端"routed"聊天时上报。
3. `CONTROL_DISABLED` 的触发条件未知（可能来自管理员、风控或灰度控制）。
4. 未做真实多 IP/多设备实验（避免触发生产风控）；并发实验仅通过代理本地限流，未压到上游限制。
5. 建议的安全使用边界：账号来源合法、不转售、每账号独立出口 IP、控制单账号并发、
   避免把同一账号同时给多个自然人使用；监控 `codefree_quota_status_reason_info` 变化。

---

## 7. 证据索引

| 主题 | 位置 |
|---|---|
| 活动指标上报 | `node-CC-GAWt2.js:498672-498760`（`CodefreeMetricService.build_request`、`activity_record`） |
| 指标键 | `498897`（chat_gen_code）、`498989`（tools_gen_code）、`499115`（chat_count） |
| 工具安全审计 | `692872-692875`（`reportToolCheck` → `/srdsca/v1/security/tool-check`） |
| OTel 机器码 | `112950-112955`（`HostDetector` 使用 `getMachineId`） |
| 渲染层风控/安全文案 | `out/renderer/assets/main-DYeEwXNf.js`（仅工具安全提醒，无代理/共享检测文案） |
| 桌面归属/请求头 | `464373-464404`、`396393-396439`、`402619`（`x-codefree-o-client`） |
| 签名算法 | `394684-394703` |
