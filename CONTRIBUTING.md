# 协作开发指南（CONTRIBUTING）

本仓库是 **CodeFree-O 多账号共享代理**：把本机已登录的 CodeFree-O 请求封装为 OpenAI 兼容接口，
支持多账号池、额度感知选号、多使用者 API Key，并可接入 pi-web / ZCode 等客户端。

> ⚠️ 本仓库为**脱敏公开版**：不包含上游客户端 appId/secret/签名密钥与真实账号信息；仅限合法合规用途。

## 1. 目录结构

```
server.mjs                 # 入口：HTTP 路由、/v1/*、/admin/*、启动/关闭
lib/
  config.mjs               # 配置加载（config.json + 环境变量 + 账号导入）
  credentials.mjs          # codefree.json v2 加解密、原子写回、journal
  quota.mjs                # 额度解析、SSE 帧扫描、QuotaService
  upstream.mjs             # 上游签名请求、token 刷新、模型/额度/聊天/向量
  pool.mjs                 # Account / TokenRefresher / AccountPool / 选择器 / 消费者限额
  metrics.mjs              # Prometheus 文本指标
  alerts.mjs               # 全池告警（企微 webhook）
test/
  pool.test.mjs            # 11 项 mock 回归（无需真实账号，CI 必跑）
  mock-upstream.mjs        # 可编程 mock 上游（OAuth 轮换/额度/429/401/500/SSE）
  multi-account-acceptance.mjs  # 真实双账号切换验收（需账号与本机登录态）
  pi-web-*.mjs             # pi-web SDK / 运行时 / UI 三级验收（需 pi-web 仓库）
scripts/                   # 一键接入/运维脚本（PowerShell）
docs/                      # 设计、运行时侦察、终验报告
```

## 2. 环境准备

| 场景 | 要求 |
|------|------|
| 只改代码 / 跑单测 | Node.js ≥ 20（本机实测 v24.21.0），无需账号 |
| 真实联调（代理打通上游） | 安装 **CodeFree-O Desktop** 并登录；凭据默认在 `~/.codefree-o/.local/share/codefree.json` |
| pi-web 联调 | clone `pi-web-ChineseTranslation`，按 `README` 的 pi-web 章节构建/启动 |
| Windows 额外 | PowerShell 5.1 下 `.ps1` 必须带 UTF-8 BOM（仓库内脚本已带） |

## 3. 本地开发

```powershell
git clone https://github.com/RishengQi/codefree-o-proxy.git
cd codefree-o-proxy
node --check server.mjs
node --test test/pool.test.mjs        # 无需账号，先确认环境
# 需要真实联调时：
Copy-Item config.example.json config.json     # 填 accounts/consumers/adminToken
$env:CODEFREE_CONFIG="<绝对路径>\config.json"; node server.mjs
node server.mjs --check                        # 自检：刷新 token + 拉模型 + 查额度
```

`config.json`、`secrets/`、`state/`、`.admin-token.txt`、`.auth-state.json` 均为本地文件，
**已被 .gitignore 忽略，任何情况下都不要提交**。

## 4. 测试分层

| 层级 | 命令 | 前置 |
|------|------|------|
| 语法检查 | `for f in server.mjs lib/*.mjs test/*.mjs; do node --check "$f"; done` | 无 |
| mock 回归（CI） | `node --test test/pool.test.mjs` | 无 |
| 单账号自检 | `node server.mjs --check` | CodeFree-O 登录态 |
| 真实双账号切换 | `node test/multi-account-acceptance.mjs` | 池模式运行 + 2 个真实账号 |
| pi-web SDK | `node test/pi-web-compat.mjs` | pi-web 仓库 + 代理 |
| pi-web 运行时 | `node test/pi-web-runtime-e2e.mjs` | pi-web web+sessiond |
| pi-web UI | `node test/pi-web-ui-e2e.mjs` | 同上 + 项目 `codefree-e2e` |

提交前至少保证 **`node --test test/pool.test.mjs` 全绿**。

## 5. 分支与提交规范

- `main` 为可发布分支，建议开启保护：仅允许 PR 合并、要求 CI 通过、至少 1 人 review。
- 分支命名：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`、`test/<topic>`。
- 提交信息：Conventional Commits 风格，例如
  `feat: quota probe backoff`、`fix: sse usage capture`、`docs: update runbook`。
- PR 描述中写清：动机、改动点、验证方式（贴命令与结果）；涉及接口/配置变更需同步 README。

## 6. 敏感信息与安全

1. 仓库私有；上游 `CLIENT_SECRET` / `SIGNING_SECRET` 是从 CodeFree-O 客户端逆向得到的常量，
   已在 `upstream` 配置中内置，勿公开仓库、勿外传。
2. 账号凭据（`codefree.json` 及其 refresh token）**只存在本机**：放 `secrets/` 或环境变量，
   不要贴到 Issue/PR/群聊。
3. 管理令牌（`.admin-token.txt`）与消费者 Key 同理；泄露后用
   `POST /admin/consumers/:id/rotate` 或重新生成 `config.json` 的 `server.adminToken`。
4. `isolated` 账号的源文件只读，轮换 token 写 `state/accounts/<id>.json`；该账号在其他客户端
   继续使用需重新登录（refresh token 单写者约束）。

## 7. 常见坑

- **pi-web 在 Windows 上 sessiond 必须用 TCP**：`PI_WEB_SESSIOND_PORT=8511`，
  web 侧 `PI_WEB_SESSIOND_URL=http://127.0.0.1:8511`（文件 socket 会 EACCES）。
- **pi-web 项目模型注册表是一次性快照**：新增 provider 需新建项目或删除项目托管目录重建。
- **PowerShell 5.1 无 BOM 的 UTF-8 `.ps1` 会被按 GBK 解析**（中文导致语法错误）：新增脚本请保存为 UTF-8 with BOM。
- **PowerShell 5.1 发送中文 JSON body 需显式 UTF-8 字节**（参考 `scripts/issue-consumer-key.ps1`）。
- **刷新 token 轮换**：同一账号同一时间只能有一个刷新方；池内账号默认 isolated，勿与桌面端混用。

## 8. 新增账号 / 使用者
```powershell
# 账号：把 codefree.json 放入 secrets/，生成/更新池配置
.\scripts\setup-pool.ps1 -AuthFiles "<账号1 codefree.json>,<账号2 codefree.json>" -Force

# 使用者：发放消费者 Key（每人一个）
.\scripts\issue-consumer-key.ps1 -Name "张三" -Id zhangsan -Rpm 60 -MaxConcurrent 3
.\scripts\issue-consumer-key.ps1 -List
```

## 9. 公开发布（脱敏快照）

仓库分为「内部私有版」与「对外公开版」：

- 私有版保留完整历史与本地配置约定，**永远不要直接公开**（历史提交里包含逆向常量）；
- 公开版由 `scripts/export-public.mjs` 生成：复制 tracked 文件 → 按
  `scripts/export-public.local.json`（已 gitignore，含真实敏感串）替换 → 校验无泄漏 →
  初始化**全新单提交历史** → 推送到公开仓库。

```powershell
# 1) 生成脱敏规则（首次）：参考 scripts/export-public.example.json，写入 scripts/export-public.local.json
# 2) 生成公开快照到外部目录并检查
node scripts/export-public.mjs --out ..\codefree-o-proxy-public
# 3) 校验通过后推送（配置 publicRepo 或 --repo-url）
node scripts/export-public.mjs --out ..\codefree-o-proxy-public --push
```

原则：真实 appId/secret/签名密钥、账号 userId、个人路径与主机名、webhook key、
明文/加密 refresh token 样本一律不得进入公开版；公开版运行凭据由使用者自行配置。

## 10. 版本与发布

- `package.json` 语义化版本；每次发布同步更新 README「变更记录」。
- 当前版本见 `package.json`；验收基线见 `docs/ACCEPTANCE-REPORT.md`。
