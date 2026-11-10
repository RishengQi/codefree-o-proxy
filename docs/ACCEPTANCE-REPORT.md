# CodeFree-O 多账号共享代理 —— 验收报告

| 项目 | 内容 |
|------|------|
| 文档编号 | CFO-ACCEPT-001 |
| 版本 | v1.0（终验） |
| 日期 | 2026-11-10 |
| 验收对象 | `<repo>`（codefree-o-proxy） |
| 上游版本 | CodeFree-O Desktop **1.10.1**（Electron + opencode 内核） |
| 运行环境 | Windows（Node.js v24.21.0）；本机代理 `127.0.0.1:8787` |
| 结论 | **通过**（1 项环境依赖项待自然观察，见 §7） |

---

## 1. 验收结论（目标对照）

| # | 原始目标 | 交付结果 | 状态 |
|---|----------|----------|------|
| 1 | 在**当前最新版** CodeFree-O 上也能实现 | 针对 1.10.1 重新逆向并适配：凭据文件 v2（AES-256-GCM）、`refresh_x_cf_token`、`X-Cf-*` 签名、`/api/acbackend/codechat/v1/completions`、模型发现、额度接口均按 1.10.1 实测 | ✅ |
| 2 | 在**本机先实现** | 本机 Windows 直接运行 `node server.mjs`，无需 Linux；真实账号登录态直连上游，真实对话可用 | ✅ |
| 3 | 多人账号**额度一起使用** | 双真实账号池（10001 / 10002）+ 每使用者 API Key（发放/轮换/限额/计量），额度与调用共享一个池 | ✅ |
| 4 | 根据**额度情况自动切换账号** | headroom 加权选号 + 主动/被动额度探测 + 429 额度耗尽冷却 + 401/5xx 故障转移 + 粘性会话 + 并发租约 | ✅（真实额度窗口待观察） |
| 5 | 多 agent 协同设计 | 两个 teammate：运行时侦察（184 路径/210 操作）与多账号池设计（CFO-POOL-DESIGN-001 v1.1，1763 行） | ✅ |
| 6 | 不了解的部分用 REA 深入分析 | 用 REA/ASAR 静态提取逆向 1.10.1 Electron 应用（app.asar 121MB → 4873 文件），定位鉴权/额度/聊天/模型接口与常量 | ✅ |

---

## 2. 验收环境

| 项 | 值 |
|----|----|
| 操作系统 | Windows（HOST） |
| Node.js | v24.21.0 |
| CodeFree-O 客户端 | Desktop 1.10.1（`%LOCALAPPDATA%\Programs\codefree-desktop`） |
| 登录态 | `~/.codefree-o/.local/share/codefree.json`（账号 A userId 10001） |
| 第二账号 | `secrets/acc-b.codefree.json`（账号 B userId 10002，代理专属 isolated） |
| pi-web（实际消费方） | `<pi-web-repo>` v2.202611.9（Pi SDK 1.4.0） |
| ZCode（旁路验证） | `D:\AI-Tools\Apps\ZCode` 3.16.3 |
| 代理配置 | `config.json`（池模式，2 账号；管理令牌见 `.admin-token.txt`，均 gitignore） |

---

## 3. 交付物清单

| 类别 | 内容 |
|------|------|
| 代理核心 | `server.mjs` + `lib/{config,credentials,quota,upstream,pool,metrics,alerts,util}.mjs` |
| 账号池 | 多凭据导入（authfile / 显式 accounts / `/admin/import`）、token 单飞刷新 + 轮换写回 + journal 崩溃恢复 |
| 额度感知 | `GET /api/aebackend/quota/v1/me` 主动探测（5H/7D）+ SSE `QUOTA_WARNING` / 429 `AI_QUOTA_EXHAUSTED` 被动信号 |
| 选号与容错 | headroom 加权 + 粘性 + 冷却状态机 + 并发租约 + 失败分类转移 |
| 多人共享 | 消费者 API Key 运行时发放/轮换/限额/删除（`state/consumers.json` 持久化） |
| 可观测性 | `GET /metrics`（Prometheus）、`/admin/*` 9+ 接口、`state/usage.json` 用量持久化、企微 webhook 告警 |
| 接入脚本 | `scripts/setup-pi-web.ps1`、`scripts/setup-zcode.ps1`、`scripts/setup-pool.ps1`、`scripts/issue-consumer-key.ps1`、`scripts/start-pi-web.ps1` |
| 验收脚本 | `test/pool.test.mjs`（11 项）、`test/multi-account-acceptance.mjs`、`test/pi-web-compat.mjs`、`test/pi-web-runtime-e2e.mjs`、`test/pi-web-ui-e2e.mjs` |
| 文档 | `README.md`、`docs/design-multi-account.md`、`docs/recon-local-runtime.md`、本报告 |
| 证据 | `docs/evidence/zcode-gui-verified.png`、`pi-web-ui-model-picker.png`、`pi-web-ui-chat.png`、`pi-web-ui-session.png` |

---

## 4. 功能验收明细

### 4.1 CodeFree-O 1.10.1 适配

| 项 | 实测 |
|----|------|
| 凭据读取 | v2 加密 `encryptedRefreshCfToken` 解密成功（AES-256-GCM，key=SHA256(`codefree-o-refresh-token-local-encryption-key-v1`)） |
| token 刷新 | `POST /api/usercenterbackend/oauth/access_token`，`grant_type=refresh_x_cf_token`，30 分钟 access / 7 天 refresh，轮换写回成功 |
| 模型发现 | `GLM-5.2` / `Qwen3.8-27B` / `DeepSeek-V4-Flash-0731` |
| 非流式对话 | `POST /v1/chat/completions` → 「收到」 |
| 流式对话 | SSE 透传 + 帧级额度信号采集 |
| 额度查询 | `quotaStatus=BYPASSED`（当前账号不在额度灰度范围，无 5H/7D 窗口） |

### 4.2 多账号池与切换（真实双账号）

| 验证项 | 结果 |
|--------|------|
| 池加载 + 双账号刷新 | ✅ 2/2 ready |
| 额度主动探测 | ✅ 两账号均返回 `BYPASSED`，headroom=1 |
| 基线对话 | ✅ 选 `acc-a`，回复「收到」（6.5s） |
| 冷却 `acc-a` 后自动切号 | ✅ 切到 `acc-b`，回复「收到」（4.8s） |
| 恢复 `acc-a`、冷却 `acc-b` | ✅ 切回 `acc-a`（5.5s） |
| 4 路并发分摊 | ✅ 2/2 均衡到两账号，全部 200 |
| 凭据轮换写回 | ✅ `acc-a` mirror 写回桌面文件；`acc-b` isolated 写 `state/accounts/acc-b.json`（源文件只读） |

### 4.3 pi-web 接入（实际消费方）

| 层级 | 验证方式 | 结果 |
|------|----------|------|
| 协议/SDK | pi-web 依赖的 Pi SDK `ModelRuntime` + `models.json` provider | ✅ 流式、工具调用、工具结果续跑全部通过 |
| 运行时 | 真实 pi-web web + sessiond，API 建项目/会话/选模型/发消息 | ✅ 回复「收到」（7.1s） |
| UI | 无头 Chrome 真实操作界面 | ✅ 模型选择器显示 `codefree` 三模型；UI 发送后 11.7s 收到回复 |

### 4.4 ZCode 旁路验证

| 项 | 结果 |
|----|------|
| CLI 真实调用 | ✅ `response: 收到`，modelRequestCount=1 |
| 桌面端真实调用 | ✅ 模型芯片 `GLM-5.2`，对话框收发正常（见 `docs/evidence/zcode-gui-verified.png`） |

### 4.5 多人共享（消费者 API Key）

| 验证项 | 结果 |
|--------|------|
| 配置消费者后匿名请求 | ✅ 401 |
| 张三 / 李四各自 Key | ✅ 均 200，回复「收到」 |
| 用量归因 | ✅ `/admin/usage`、`/metrics` 按 consumer 分开计数 |
| 轮换 Key | ✅ 旧 Key 401、新 Key 正常 |
| 删除消费者 | ✅ Key 失效，恢复匿名模式 |
| pi-web 用消费者 Key 运行 | ✅ 回复「收到」（新项目复制带 Key 的 models.json） |

### 4.6 可观测性与告警

| 项 | 实测 |
|----|------|
| `/metrics` | ✅ Prometheus 文本（本次 7675 字节，`mode="pool"`，2 账号指标齐全） |
| 用量持久化 | ✅ 重启后 `acc-a successes=1/tokensIn=11` 完整恢复 |
| 全池告警 | ✅ 本地 webhook 断言「全池额度耗尽」消息（含账号明细），冷却限流生效 |

---

## 5. 测试矩阵与最终结果

| # | 命令 | 覆盖 | 结果 |
|---|------|------|------|
| 1 | `node server.mjs --check` | 真实账号刷新 + 模型 + 额度 | ✅ `ok: true` |
| 2 | `npm run test:pool` | 选号/额度/429/401/粘性/限流/管理面/指标/持久化/告警/消费者（11 项） | ✅ 11/11 |
| 3 | `node test/pi-web-compat.mjs` | Pi SDK 契约（流式/工具调用/工具续跑） | ✅ `ok: true` |
| 4 | `node test/pi-web-runtime-e2e.mjs` | pi-web 运行时真实会话 | ✅ 回复「收到」7.1s |
| 5 | `node test/pi-web-ui-e2e.mjs` | pi-web UI 真实交互 | ✅ 回复「收到」11.7s |
| 6 | `node test/multi-account-acceptance.mjs` | 真实双账号基线/强制切换/切回 | ✅ `ok: true` |
| 7 | ZCode CLI / 桌面端 | 独立客户端真实调用 | ✅ 收到 |
| 8 | `/metrics`、`/admin/*` | 观测面 | ✅ 正常 |

---

## 6. 关键设计决策（摘要）

| 决策 | 结论 |
|------|------|
| 接入路线 | 直连 srdcloud 上游（C 路线）；sidecar 仅作健康检查/兜底，不做池化承载 |
| 凭据归属 | 池内账号默认 `isolated`（代理专属刷新）；与桌面端共用的账号用 `mirror` 写回 |
| 额度信号 | 主动探测 + 被动校验 + 本地估算三级，任一账号出现窗口即参与 headroom 排序 |
| 选号 | headroom 加权（取最紧周期）+ 粘性会话 + 冷却 + 每账号并发租约 + 确定性 tie-break |
| 失败转移 | 额度/鉴权/限流/5xx/网络分类分别冷却；SSE 已开始输出后不切换 |
| 写回安全 | 刷新前重读凭据文件、单飞刷新、原子临时文件替换、journal 崩溃恢复 |

---

## 7. 已知限制与注意事项

1. **真实额度耗尽场景尚未自然出现**：两个账号当前均为 `BYPASSED`（不受 5H/7D 窗口限制），
   因此「额度耗尽自动换号」由 mock 回归（429 → 冷却 → 切换）与真实冷却切换共同验证；
   待任一账号进入额度灰度后可直接观察，无需改代码。
2. **refresh token 单写者约束**：同一账号同一时刻只应有一个刷新方（桌面端或代理）。
   池内非共享账号请保持 `isolated`，避免与对方客户端互相轮换失效。
3. **isolated 账号源文件为只读**：轮换后的新 token 写在 `state/accounts/<id>.json`；
   若该账号要在其它客户端继续使用，需重新登录。
4. **Windows 下 pi-web 的 sessiond 必须用 TCP**：`PI_WEB_SESSIOND_PORT=8511` + web 侧
   `PI_WEB_SESSIOND_URL=http://127.0.0.1:8511`（文件 socket 会 EACCES）。
5. **pi-web 项目模型注册表是一次性快照**：新增 provider 需新建项目（或删除项目托管目录重建）。
6. **凭据安全**：`config.json`、`secrets/`、`state/`、`.admin-token.txt` 均不入 Git；
   仓库含 CodeFree 签名密钥与 appId，保持仓库私有。

---

## 8. 运行手册（本机）

```powershell
# 1. 启动池代理（双账号，端口 8787）
$env:CODEFREE_CONFIG='<repo>\config.json'; node server.mjs

# 2. 发放使用者 Key（可选，多人共享）
.\scripts\issue-consumer-key.ps1 -Name "张三" -Id zhangsan -Rpm 60 -MaxConcurrent 3
.\scripts\issue-consumer-key.ps1 -List

# 3. 启动 pi-web（web + sessiond，Windows TCP）
.\scripts\start-pi-web.ps1 -Build     # 首次构建前端；之后可省略 -Build

# 4. 观测
curl http://127.0.0.1:8787/metrics
curl -H "X-Admin-Token: <token>" http://127.0.0.1:8787/admin/accounts
curl -H "X-Admin-Token: <token>" http://127.0.0.1:8787/admin/quota
curl -H "X-Admin-Token: <token>" http://127.0.0.1:8787/admin/usage

# 5. 验收回归
npm run test:pool
node test/multi-account-acceptance.mjs
node test/pi-web-runtime-e2e.mjs
node test/pi-web-ui-e2e.mjs
```

---

## 9. 后续建议

1. **生产部署**：Linux + systemd（仓库已含 `codefree-o-proxy.service`），搭配反向代理与 TLS；
2. **观测看板**：Prometheus 抓取 `/metrics` + Grafana 面板（账号余量/切换次数/每 Key 用量）；
3. **账号扩容**：新增账号按 `scripts/setup-pool.ps1` 流程导入，观察 `/admin/quota` 自动参与选号；
4. **真实额度观察**：任一账号出现额度窗口后，重点复核 headroom 排序、冷却时长与切换日志；
5. **安全加固**：管理令牌轮换、按使用者 Key 定期轮换（`/admin/consumers/:id/rotate`）。

---

*附：证据截图见 `docs/evidence/`；测试脚本见 `test/`；设计文档见 `docs/design-multi-account.md`。*
