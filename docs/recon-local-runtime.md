# CodeFree-O Desktop v1.10.1 本机运行时侦察报告

> 侦察对象：本机正在运行的 CodeFree-O Desktop（Electron 1.10.1，基于 opencode 的 sidecar 架构）
> 侦察时间：2026-11-10 10:00–10:30（Asia/Shanghai）
> 侦察方式：只读。未停止/重启应用、未修改 `codefree.db`、未改动 `app.asar`、未调用任何会产生会话/消耗额度的模型接口。
> 敏感信息处理：用户令牌一律脱敏（仅保留前 8 / 后 4 位）；二进制中硬编码的协议常量单独标注并给出全值（实现代理所必需，非用户凭据）。

---

## 0. 结论摘要（TL;DR）

| 问题 | 结论 |
|---|---|
| 应用是否已登录？ | **是，已登录**。`GET /codefree/auth/status` 返回 `authenticated=true, userId=10001, baseUrl=https://www.srdcloud.cn`。此前"未登录"的判断来自 `account` 等 SQLite 表 0 行——但那几张表**不用于** CodeFree 登录态，属实为误判（见 §3）。 |
| 登录凭据存在哪？ | `%USERPROFILE%\.codefree-o\.local\share\codefree.json`（v2 格式，AES-256-GCM 加密的 refresh token + userId + baseUrl + 到期时间）。access token（cfToken）**只在内存中**，不落盘。 |
| sidecar 认证方式 | HTTP **Basic**：用户名固定 `codefree`，口令是主进程每次启动生成的 `crypto.randomUUID()`，**仅存在于主进程内存**（并通过 IPC 交给渲染进程）。本机实测口令已定位（`c97c4ba9…6afc`），`GET /api/health` → `200 {"healthy":true}`。 |
| 认证是否已打通？ | **是**。已用真实凭据枚举 sidecar：`/doc` 返回 OpenAPI 3.1（184 路径 / 210 操作）、`/config`、`/provider`、`/codefree/auth/*` 等均可访问。 |
| 代理可走的路线 | ① 复用桌面 sidecar（Basic 认证，零凭据复制）；② 独立进程重新托管同一 opencode `Server`（已实测成功）；③ 直接对上上游 `www.srdcloud.cn` 发签名请求（refresh token 可本地解密 → 换取 cfToken）。三条路线及风险见 §11。 |
| 模型目录 | CodeFree provider 仅 3 个模型：`GLM-5.2`、`Qwen3.8-27B`（多模态，默认）、`DeepSeek-V4-Flash-0731`；均为 200k 上下文、cost=0、`accessMode=LEGACY`、支持 reasoning/tools。 |
| 上游鉴权 | 不是 `Authorization: Bearer`，而是 **HMAC 签名头** `X-Cf-Token / userId / projectId / X-Cf-AppId / X-Cf-Timestamp / X-Cf-Nonce / X-Cf-Signature`（§9）。 |
| 本地配额信息 | **无本地配额计量**。`session` 表有 `cost / tokens_*` 列但当前 0 行；模型 cost 全为 0；配额由上游 429 表达（客户端把 `insufficient quota|quota exceeded` 归类为 `QuotaExceededReason`）。 |
| 登录流程形态 | **浏览器 OAuth 2.0 + PKCE**（SRD Cloud 用户中心），支持回调到本机 loopback；另支持手动粘贴授权码（3 次重试）。**没有**应用内账号密码框、二维码、设备码流程。 |

---

## 1. 侦察环境与产物位置

| 对象 | 路径 / 值 |
|---|---|
| 应用安装目录 | `%USERPROFILE%\AppData\Local\Programs\codefree-desktop` |
| 主包 | `resources\app.asar`（121,292,590 B；内含 4,999 个文件；`package.json` main = `out/main/index.js`） |
| 服务端 bundle | `out/main/chunks/node-CC-GAWt2.js`（33,045,544 B，即 opencode `Server`，ESM，导入仅 Node 内置 + 3 个原生可选依赖） |
| sidecar 引导脚本 | `out/main/sidecar.js`（3,381 B，全部逻辑见 §4） |
| 原生 MCP | `resources\localmcp\mgmcp.exe`（15,250,432 B，manifest v1.3.4） |
| 业务数据目录 | `%USERPROFILE%\.codefree-o`（`.config` / `.cache` / `.local`） |
| SQLite | `~\.codefree-o\.local\share\codefree.db`（WAL，4,096 B + wal 263,712 B） |
| CodeFree 登录态 | `~\.codefree-o\.local\share\codefree.json`（230 B） |
| sidecar 日志 | `~\.codefree-o\.local\share\log\codefree.log` |
| Electron userData | `%USERPROFILE%\AppData\Roaming\ai.codefree.desktop`（`logs\20261110T012354\main.log`、`Network\Cookies`、`Local Storage\leveldb`） |
| 本报告用到的临时产物（可清理） | `%TEMP%\dsh-recon\`（提取的 asar 文件、OpenAPI JSON、内存扫描脚本、独立 sidecar 测试脚本） |

> 侦察脚本均位于 `%TEMP%\dsh-recon\`：`asar.mjs`（asar 读取/检索/提取）、`probe.mjs`/`probe2.mjs`（HTTP 探测）、`readdb.py`（DB 副本读取）、`memscan.py`（进程内存 UUID 扫描）、`decrypt.mjs`（refresh token 解密）、`spawn-own.mjs`（独立 sidecar 复现）。它们只写 `%TEMP%`，不进入仓库。

---

## 2. 进程拓扑与监听端口

### 2.1 实测命令

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'CodeFree-O.exe' } |
  Select-Object ProcessId, ParentProcessId, CommandLine | Format-List

Get-NetTCPConnection -State Listen | Where-Object {
  $_.OwningProcess -in (Get-Process CodeFree-O).Id } |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

### 2.2 结果（2026-11-10 10:00 采样）

| PID | 父 PID | 角色 | 关键命令行特征 |
|---|---|---|---|
| 9364 | 9548 | 主进程（Electron main） | `"…\CodeFree-O.exe"`（无额外参数） |
| 29920 | 9364 | renderer | `--type=renderer … --app-path="…\resources\app.asar" --enable-sandbox` |
| 21612 | 9364 | **sidecar** | `--type=utility --utility-sub-type=node.mojom.NodeService --service-sandbox-type=none` |
| 26116 | 9364 | 网络服务 | `--utility-sub-type=network.mojom.NetworkService` |
| 29416 | 9364 | GPU | `--type=gpu-process` |
| 27252 | 9364 | crashpad | `--type=crashpad-handler` |

监听端口（OwningProcess）：

| 地址 | 端口 | 归属 | 说明 |
|---|---|---|---|
| `::1` | 56136 | 9364 | 主进程内置本地 HTML 服务器（`main.log`: `local html server started { origin: 'http://localhost:56136' }`） |
| `127.0.0.1` | **56139** | 21612 | **sidecar HTTP API（opencode Server）** |
| `127.0.0.1` | 65490 | 21612 | sidecar 的第二个监听（PTY/WebSocket 相关） |

另有一个 `mgmcp.exe`（PID 31596，10:00:40 启动，端口 30678），由 sidecar 的 MCP 服务按需拉起，记录在
`~\.codefree-o\.local\state\mgmcp\claim.json`：

```json
{"state":"ready","port":30678,"executable":"…\\resources\\localmcp\\mgmcp.exe",
 "startedAt":1794276040546,"pid":31596,"launcherPid":30952,"readyAt":1794276040912}
```

### 2.3 重要附注：实例锁令牌 ≠ HTTP 口令

`~\.codefree-o\.local\state\locks\<60-hex>\meta.json` 中有一条令牌：

```json
{"token":"08b08f3e-f87b-4a1e-aacb-271d907a2019","pid":21612,
 "hostname":"HOST","createdAt":"2026-11-10T02:00:38.534Z"}
```

这是 opencode 的**实例锁（flock）token**，用于目录实例互斥，**不是** sidecar 的 HTTP 认证口令。
实测把它当作 `Authorization: Bearer` / `Basic codefree:<它>` / `?password=` 全部返回 401（矩阵见 §5.2）。

---

## 3. 登录状态判定（推翻"未登录"结论）

### 3.1 SQLite：`account` / `control_account` / `credential` 均为 0 行（但不是登录态来源）

为避免 WAL 锁，先把 DB 三件套复制到 `%TEMP%\dsh-recon\db\` 再用 Python 3.12 `sqlite3` 读取：

```powershell
# 复制（不触碰原库）
Copy-Item "$env:USERPROFILE\.codefree-o\.local\share\codefree.db*" "$env:TEMP\dsh-recon\db\"
python "$env:TEMP\dsh-recon\readdb.py"
```

结果（节选）：

```
journal_mode = wal ; user_version = 0 ; page_size = 4096
  account: rows=0
    CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL,
      access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer,
      time_created integer NOT NULL, time_updated integer NOT NULL)
  account_state: rows=0        (id, active_account_id, active_org_id)
  control_account: rows=0      (email,url,access_token,refresh_token,token_expiry,active,…)
  credential: rows=0
  migration: rows=41           ← 仅 schema 迁移时间戳（全部 = 1794273836282…，即首次启动）
  project: rows=1              ← {"id":"global","worktree":"/","time_created":1794276038418}
  session / message / part / todo / event / workspace / permission … 全部 0 行
```

**结论**：`account`/`control_account` 是上游 opencode 的通用多账号/Console 组织切换功能表，CodeFree 登录**不使用**它们。
因此"这些表 0 行 ⇒ 未登录"不成立。`migration` 中 41 条记录说明数据库是本次安装（09:23:54）新建的。

### 3.2 权威判据：`GET /codefree/auth/status`

```powershell
$pw = (Get-Content -Raw "$env:TEMP\dsh-recon\sidecar-pw.txt").Trim()   # 见 §5
$auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("codefree:$pw"))
Invoke-RestMethod 'http://127.0.0.1:56139/codefree/auth/status' -Headers @{ Authorization = $auth }
```

```json
{
  "authenticated": true,
  "baseUrl": "https://www.srdcloud.cn",
  "userId": "10001",
  "clientId": "<REDACTED_CLIENT_ID>",
  "expiresAt": 1794277837266
}
```

- `expiresAt=1794277837266`（毫秒 epoch）= **2026-11-10 10:30:37 +08:00**，即当前 cfToken 的到期时刻。
- `clientId` 与 §8 中"生产环境 OAuth client_id"一致。
- `userId=10001` 与 `codefree.json` 中 `userId` 一致。

### 3.3 旁证：启动日志的时序 + MCP 连接

`~\.codefree-o\.local\share\log\codefree.log`：

```
01:23:56Z(09:23:56+08) ERROR Failed to fetch models.dev … "ResourceManager model catalog request skipped: waiting-auth"
01:23:56Z             INFO  "skillconfig.sync skipped: no credentials" service=skillconfig
01:23:56Z             WARN  "Skipping ResourceManager model catalog request while waiting-auth"
02:00:38Z(10:00:38+08) INFO  "creating instance" directory="%USERPROFILE%"   ← 新实例
02:00:38Z             INFO  "global event connected" / "bootstrapping directory"
02:00:39Z             INFO  "loaded SRD Cloud MCP config" servers=[…26 个…] securityRegistrationCount=2
02:00:40Z             INFO  "[mgmcp-ux] Started mgmcp" port=30678 pid=30952
02:00:52Z             WARN  "background dependency install failed" … @opencode-ai/plugin@1.10.1
```

- 09:23:56 首次启动时确实处于 `waiting-auth`（当时还没有有效 cfToken，`codefree.json` 尚未被刷新）；
- 10:00:38 之后 MCP 全部 `connected`、models.dev 请求不再被跳过，说明**此时已具备有效登录态**。

`codefree.json` 的时间戳也印证了 refresh 流程在运行：

| 采样时刻 | `refreshCfTokenExpiresAt` | 文件 mtime | 换算 |
|---|---|---|---|
| 10:01 | 1794880837266 | — | 2026-11-17 09:40:37 +08 |
| 10:14 | 1794881619854 | — | 2026-11-17 10:13:39 +08 |
| 10:15:49 | 1794881749465 | 10:15:49 | 2026-11-17 10:15:49 +08 |

**refresh token 每次刷新都会轮换并向前滚动 7 天**（这正是"刷新即换新"的证据，见 §8.4）。

---

## 4. sidecar 如何被拉起（进程、参数、环境、工作目录）

### 4.1 代码证据（`app.asar!/out/main/index.js`，提取后行号）

```js
// L5340  sidecar 连接初始化
logger.log("sidecar connection started", { version: SIDECAR_VERSION });   // 本机为 "v1"
...
// L5357-5377  端口：优先 OPENCODE_PORT，否则 bind(0) 取临时端口（127.0.0.1）
const port = … process.env.OPENCODE_PORT … socket.listen(0, "127.0.0.1", …)
// L5378-5380
const hostname = "127.0.0.1";
const url = `http://${hostname}:${port}`;
const password = randomUUID();                    // ← sidecar 口令：每次启动随机 UUID
logger.log("spawning sidecar", { url });
// L5383-5389
spawnLocalServer(hostname, port, password, {
  userDataPath: app.getPath("userData"),
  onStdout: (m) => write("server", "stdout", { message: m }),
  onStderr: (m) => write("server", "stderr", { message: m }, "warn"),
  onExit: (code) => write("utility", "sidecar exited", { code }, "warn")
})
```

`spawnLocalServer`（L2955-3063）：

```js
const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js");
const child = utilityProcess.fork(sidecar, [], {
  cwd: process.cwd(),              // 继承主进程工作目录
  env: createSidecarEnv(),         // 继承 process.env（删除 DEBUG / linux 下 LD_PRELOAD）
  serviceName: SIDECAR_SERVICE_NAME,
  stdio: "pipe"
});
…
child.postMessage({ type: "start", hostname, port, password, userDataPath });
// 之后每 100ms 轮询 GET /api/health、/global/health（带 Basic）直到 200
```

`app.asar!/out/main/sidecar.js`（全文 3.4 KB）：

```js
const { Server } = await import("./chunks/node-CC-GAWt2.js");
listener = await Server.listen({
  port: command.port,
  hostname: command.hostname,
  username: "codefree",                 // ← 固定用户名
  password: command.password,           // ← 随机 UUID
  cors: ["oc://renderer"]               // ← CORS 只放行自定义 scheme oc://renderer
});
```

```js
function prepareSidecarEnv(password, userDataPath) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "codefree",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath
  });
}
```

### 4.2 实测结果

- sidecar 是 Electron `utilityProcess`（`--type=utility --utility-sub-type=node.mojom.NodeService`），父进程为主进程 9364；
  其 `CommandLine` 只有 Electron 引导参数，**没有**端口/口令参数——参数通过 Mojo `postMessage` 传递。
- 端口：本机 56139（`main.log`: `spawning sidecar { url: 'http://127.0.0.1:56139' }`、`server ready { url: … }`）。
- 工作目录：`process.cwd()` 继承主进程；数据根通过 `XDG_STATE_HOME`（= `app.getPath("userData")`）+ opencode `Path.data` 落到 `~\.codefree-o\.local\share`。
- 环境变量（从代码可确定）：`OPENCODE_SERVER_USERNAME=codefree`、`OPENCODE_SERVER_PASSWORD=<uuid>`、`XDG_STATE_HOME=<userData>`，其余继承主进程；进程环境无法用 WMI 直接读取（Windows 不暴露），故以代码为证。

---

## 5. sidecar 认证机制（已打通）

### 5.1 协议：HTTP Basic（用户名固定 `codefree`）

未认证请求 `GET http://127.0.0.1:56139/`：

```
HTTP/1.1 401
www-authenticate: Basic realm="Secure Area"
vary: Origin
transfer-encoding: chunked
connection: keep-alive
```

`GET /api/health` 未认证时还有 JSON 错误体：

```json
{"_tag":"UnauthorizedError","message":"Authentication required"}
```

服务端实现（`out/main/chunks/…js`，约 32.5 MB 偏移处）：

```js
var AUTH_TOKEN_QUERY = "auth_token", WWW_AUTHENTICATE = 'Basic realm="Secure Area"';
function credentialFromRequest(request) {
  const token = new URL(request.url, "http://localhost").searchParams.get(AUTH_TOKEN_QUERY);
  if (token) return decodeCredential(token);                  // ← 也接受 ?auth_token=<base64(user:pass)>
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "");
  if (match) return decodeCredential(match[1]);
  return Effect.succeed(emptyCredential());
}
```

即两种等价写法：

```
Authorization: Basic base64("codefree:<password>")
GET /global/health?auth_token=base64("codefree:<password>")
```

两者均已实测 200（后者返回 `{"healthy":true,"version":"1.10.1"}`）。

### 5.2 候选口令矩阵（节选，全部 401，用于排除）

对 `/`、`/doc`、`/global/health`、`/app`、`/config`、`/provider`、`/session`、`/event`、`/health`、`/openapi.json`
分别尝试：无头、`Bearer <lock-token>`、`x-opencode-token`、`x-sidecar-token`、`x-token`、
`Basic opencode:<lock-token>`、`Basic user:<lock-token>`、`?password=<lock>`、`Origin: oc://app`、`Origin: null`
→ **全部 401**（说明认证与 Origin/实例锁无关，只认 Basic/`auth_token` 且口令必须匹配）。

### 5.3 口令实际来源与获取方法（本机已取得）

口令 = **主进程内存中的 `randomUUID()`**，不落盘、不进命令行、不写日志。
获取方法：只读扫描主进程内存（`OpenProcess(PROCESS_VM_READ)` + `VirtualQueryEx` + `ReadProcessMemory`），
正则匹配 UUIDv4，再逐个做一次 `GET /api/health` Basic 试探。

`%TEMP%\dsh-recon\memscan.py` 实测输出（PID 9364）：

```
pid=9364 regions_scanned=1372 bytes_scanned=438124544 uuid_candidates=84
  HIT c97c4ba9...6afc -> /api/health 200
```

→ 口令 `c97c4ba9-****-****-****-************6afc`（36 字符 UUIDv4），`/api/health` 返回 `{"healthy":true}`。
（完整值仅保存在 `%TEMP%\dsh-recon\sidecar-pw.txt`，未写入仓库、未出现在本报告中。）

> 说明：这是本机只读的认证侦察手段，用于证明"口令可从运行时恢复"；它不是持久凭据——应用重启即失效。
> 另一个等价来源是渲染进程（同机同用户）：主进程通过 IPC `awaitInitialization` 把 `{url, username:'codefree', password}` 交给渲染进程。

---

## 6. 本地 API 清单（需认证）

### 6.1 总览

| 项 | 值 |
|---|---|
| OpenAPI | `GET /doc` → **OpenAPI 3.1.0**，`info.title = "opencode"`，**184 个 path / 210 个操作**（完整定义已保存到 `%TEMP%\dsh-recon\api\openapi.json`，526,133 B） |
| 健康 | `GET /global/health` → `{"healthy":true,"version":"1.10.1"}`；`GET /api/health` → `{"healthy":true}` |
| Web UI | `GET /app` → 内嵌 SPA HTML（2,884 B）；未匹配路径（如 `/tui/status`、`/auth`、`/experimental/health`）会回落到同一 HTML |
| 事件流 | `GET /event`、`GET /global/event`、`GET /api/event`、`GET /api/session/{id}/event` → `text/event-stream` |
| CORS | 仅 `oc://renderer`（sidecar 启动参数） |

### 6.2 关键端点（按用途）

**CodeFree 登录态**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/codefree/auth/status` | 登录状态（`authenticated/baseUrl/userId/clientId/expiresAt/mode/managedBy/canLogin/canLogout/login{state,startedAt,authUrl,message}`） |
| POST | `/codefree/auth/login` | 启动或复用登录流程（返回同上结构，`login.authUrl` 给出浏览器授权 URL） |
| POST | `/codefree/auth/logout` | 清除本地凭据与登录流程状态 |

**会话 / 对话（v1 与 v2 两套）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/session` | 列出 / 新建会话（当前 `[]`） |
| POST | `/session/{sessionID}/message` | 发送消息（v1） |
| POST | `/session/{sessionID}/prompt_async` | 异步发送消息 |
| POST | `/session/{sessionID}/command`、`/shell`、`/abort`、`/summarize`、`/fork`、`/revert` | 会话控制 |
| GET/POST | `/api/session`（+ `/active`） | v2 会话列表 / 新建 |
| POST | `/api/session/{sessionID}/prompt` | **v2 发送消息**（`/api/*` 是桌面端主要使用的一套） |
| POST | `/api/session/{sessionID}/model`、`/agent` | 切换模型 / agent |
| POST | `/api/session/{sessionID}/interrupt`、`/wait` | 中断 / 等待 |
| GET | `/api/session/{sessionID}/context`、`/history`、`/message` | 上下文 / 历史 / 消息 |
| POST | `/api/session/{sessionID}/compact`、`/revert/stage|clear|commit` | 压缩 / 回滚 |

**模型与 Provider**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/provider`、`/config/providers` | Provider 与模型目录（CodeFree 3 个模型，见 §7） |
| GET | `/provider/auth` | 各 Provider 支持的认证方式 |
| GET | `/api/model` | v2 全量模型目录（本机 5,675 条，来自 models.dev；**不含** codefree legacy provider） |
| GET | `/api/provider`、`/api/provider/{id}` | v2 Provider |
| POST | `/provider/{providerID}/oauth/authorize|callback` | Provider OAuth（如 GitHub Copilot） |
| PUT/DELETE | `/auth/{providerID}` | 写入 / 删除 Provider 凭据 |

**运行环境 / 工具**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/path` | `{home,state,config,worktree,directory}` |
| GET | `/config`、`/global/config`，PATCH 同名 | 合并后的配置（本机 `/config` 6,983 B） |
| GET | `/agent` | Agent 列表（`build` 等 native agent，含权限矩阵） |
| GET | `/mcp`、`/skill`、`/command`、`/lsp`、`/formatter` | 能力状态（本机 26 个远程 MCP 全部 `connected`） |
| GET | `/project`、`/project/current` | 项目（当前仅 `global`，`worktree="/"`） |
| GET | `/file`、`/file/content`、`/find*`、`/vcs*` | 文件/检索/版本控制 |
| GET/POST | `/pty*`、`/question*`、`/permission*` | 终端、问答、权限交互 |
| GET | `/api/location`、`/api/integration`、`/api/skill`、`/api/fs/*` | v2 位置/集成/技能/文件系统 |
| GET/POST | `/api/market/{skills,mcps,plugins,workers}*` | 市场（技能/MCP/插件/数字员工） |
| POST | `/experimental/control-plane/move-session`、`/experimental/console*` | 控制面/Console（本机 `switchableOrgCount=0`） |

> 完整 210 条操作清单见附录 A。

### 6.3 关键响应实测摘录

`GET /path`：

```json
{"home":"%USERPROFILE%",
 "state":"%USERPROFILE%\\.codefree-o\\.local\\state",
 "config":"%USERPROFILE%\\.codefree-o\\.config",
 "worktree":"/","directory":"%USERPROFILE%"}
```

`GET /provider`（`codefree`，节选）：

```json
{"all":[{"id":"codefree","name":"CodeFree","source":"custom","env":[],
  "options":{"apiKey":"opencode-oauth-dummy-key",
             "baseURL":"https://www.srdcloud.cn",
             "headers":{"clientType":"codefree-o","clientVersion":"1.10.1"}},
  "models":{ "GLM-5.2": …, "Qwen3.8-27B": …, "DeepSeek-V4-Flash-0731": … }}],
 "default":{"codefree":"Qwen3.8-27B"},"connected":[]}
```

`GET /mcp`（26 个远程 MCP，全部已连接；URL 均为 `https://www.srdcloud.cn/api/acbackend/streamablemcp/mcp`，以 `mcpId` 区分）：

```json
{"API中心":{"status":"connected"},"Wiki":{"status":"connected"},…,"UX-MCP":{"status":"connected"}}
```

`GET /config`（节选：MCP 条目通过 `x-codefree-auth*` 标记注入鉴权）：

```json
{"mcp":{"API中心":{"type":"remote","url":"https://www.srdcloud.cn/api/acbackend/streamablemcp/mcp",
  "headers":{"mcpId":"3","gitUrls":"unknown","clientType":"codefree-o",
  "x-codefree-auth":"1","x-codefree-auth-client-type":"codefree-o","x-codefree-auth-base-path":"/"}}, …}}
```

---

## 7. 模型目录（CodeFree Provider）

`GET /provider` / `GET /config/providers` 中 `codefree` provider 全部模型（仅 3 个）：

| model id | 显示名 | 上下文 | 输出上限 | reasoning | tools | 附件 | cost | accessMode |
|---|---|---|---|---|---|---|---|---|
| `GLM-5.2` | GLM-5.2 | 200,000 | 0 | ✓ | ✓ | ✗ | 0 | LEGACY |
| `Qwen3.8-27B` | Qwen3.8-27B（多模态） | 200,000 | 0 | ✓ | ✓ | ✓（image） | 0 | LEGACY |
| `DeepSeek-V4-Flash-0731` | DeepSeek-V4-Flash-0731 | 200,000 | 0 | ✓ | ✓ | ✗ | 0 | LEGACY |

- 默认模型：`Qwen3.8-27B`。
- 三者 SDK 描述一致：`api.npm = "@ai-sdk/openai-compatible"`，`api.url = "https://www.srdcloud.cn"`。
- `cost` 全 0 → 计费/配额在服务端，不在本地。
- `options.accessMode = "LEGACY"`（与 `/api/model` 的 v2 模型不同，CF 走 legacy provider 通道）。

---

## 8. 登录流程、令牌存储与格式

### 8.1 登录是"浏览器 OAuth 2.0 + PKCE"（SRD Cloud 用户中心）

服务端代码常量（`out/main/chunks/…js`）：

```js
authPath   = "/login/oauth/authorize"
tokenPath  = "/api/usercenterbackend/oauth/access_token"
userPath   = "/api/usercenterbackend/user"
userFrontPath = "/api/usercenterbackend/user-cfwebview/v1/get-user-front/"
redirectPath  = "/login/oauth-srdcloud-redirect"
refreshSkew   = 60 * 1000           // 到期前 60s 主动刷新
oauthTimeout  = 5 * 60 * 1000       // 登录流程 5 分钟超时
manualAttemptLimit = 3              // 手动粘贴授权码最多 3 次
```

授权 URL 构造（实测逻辑）：

```js
// 1) 本机起临时 loopback 监听（随机端口）
const local = `http://127.0.0.1:${port}/oauth2callback?from=codefree-o&randomCode=${rnd}`;
const state = Buffer.from(local).toString("base64");
// 2) 生成 PKCE
const verifier = …(64 字符 [A-Za-z0-9-._~])…;  challenge = base64url(sha256(verifier));
// 3) 拼授权 URL（state 里编码了回调地址）
const params = new URLSearchParams({
  client_id: client(baseUrl),                    // 见 §8.2
  redirect_uri: `${baseUrl}/login/oauth-srdcloud-redirect`,
  response_type: "code",
  state, code_challenge: challenge, code_challenge_method: "S256"
});
const url = `${baseUrl}/login/oauth/authorize?${params}`;
// 4) 打开系统浏览器；等待回调（或允许用户手动粘贴 code）
```

回调处理：接受 `http://127.0.0.1:<port>/oauth2callback` 或 `…/login/oauth-srdcloud-redirect`，
校验 `state`、取 `code`；也接受用户直接粘贴授权码（最多 3 次，错误提示："授权码输入错误，请重试，最多可输入3次。"）。

授权码换令牌：

```js
POST `${baseUrl}/api/usercenterbackend/oauth/access_token`
Content-Type: application/x-www-form-urlencoded
grant_type=authorization_code&client_id=<client>&code=<code>
  &redirect_uri=<baseUrl>/login/oauth-srdcloud-redirect&code_verifier=<PKCE verifier>
```

响应二选一：

- 直接返回 CF 令牌：`x_cf_token` / `cf_token`、`x_cf_refresh_token`、`x_cf_token_expires_in`、`x_cf_refresh_token_expires_in`；
- 或返回标准 `access_token`（此时再 `GET /api/usercenterbackend/user` `Authorization: Bearer <access_token>` 换取 cfToken）。

**因此"应用需要什么才能登录"**：一个有效的 **SRD Cloud（www.srdcloud.cn）账号**，在系统浏览器里完成其 Web SSO 登录。
应用内**没有**账号密码表单、**没有**二维码、**没有**设备码；登录结果落到本机 loopback 回调。

### 8.2 OAuth 客户端标识（生产环境，来自二进制硬编码）

| 环境 | `client_id` | `client_secret`（refresh 时提交） |
|---|---|---|
| dev（`*.dev.srdcloud.cn`） | `<REDACTED_DEV_CLIENT_ID>` | 见代码常量（同样硬编码） |
| test（`*.test.srdcloud.cn`） | `<REDACTED_TEST_CLIENT_ID>` | 同上 |
| **prod（`www.srdcloud.cn`，本机）** | **`<REDACTED_CLIENT_ID>`** | **`<REDACTED_CLIENT_SECRET>`** |

> 这两个是**产品内嵌的公共客户端常量**（不是用户凭据），实现代理换取 cfToken 时必须使用；
> 生产值已与 `/codefree/auth/status` 返回的 `clientId` 交叉验证一致。

### 8.3 本地存储：`codefree.json` v2（AES-256-GCM）

路径解析（代码）：

```js
authFileOverride = process.env.OPENCODE_CODEFREE_AUTH_FILE?.trim();
file = authFileOverride || path.join(Path.data, "codefree.json");   // Path.data = ~/.codefree-o/.local/share
fallbackFiles = [
  ~/.local/share/opencode/codefree.json,
  ~/.codefree/common/agent/core/.codefree-o/codefree.json
];
```

当前内容（脱敏）：

```json
{
  "version": 2,
  "encryptedRefreshCfToken": "<redacted-refresh-token>",
  "refreshCfTokenExpiresAt": 1794881749465,
  "userId": "10001",
  "baseUrlSnapshot": "https://www.srdcloud.cn"
}
```

加密实现（代码原文）：

```js
function credentialCipherKey() {
  return createHash("sha256").update(refreshTokenCipherKey).digest();
}
function encryptRefreshCfToken(input) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialCipherKey(), iv);
  const encrypted = Buffer.concat([cipher.update(input, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), encrypted.toString("base64"),
          cipher.getAuthTag().toString("base64")].join(":");
}
var refreshTokenCipherKey = "codefree-o-refresh-token-local-encryption-key-v1";  // 硬编码、全机器相同
```

- 格式：`v1:<base64 iv 12B>:<base64 ciphertext>:<base64 GCM tag 16B>`；
- 密钥：`sha256("codefree-o-refresh-token-local-encryption-key-v1")`（**静态**，不依赖 DPAPI/机器绑定）；
- 还存在 `plaintextStored`（v2 明文）与 `legacyStored`（v1）兼容路径，前者可被直接读取，后者读到即清除。

**实测解密**（`decrypt.mjs`，用上述静态密钥）：

```
blobFormat = v1:iv(12B):ct(13B):tag(16B)
decrypted  = 25784a…  (opaque, 1 段, 长度 13 字符, 非 JWT)
```

即 **refresh token 是不透明的短令牌（13 字符）**，不是 JWT；`refreshCfTokenExpiresAt` 为毫秒 epoch。

### 8.4 令牌生命周期与轮换

- access token（cfToken）：由 token 端点下发，默认 `expires_in` = 7200s（代码 fallback：`positiveSeconds(..., 7200)`）；
  实际观测 `/codefree/auth/status.expiresAt` = `1794277837266` → 2026-11-10 10:30:37 +08。
- refresh token：默认 604800s（7 天）；**每次刷新都会重新下发并在 `codefree.json` 中轮换**（§3.3 三次采样 mtime 与到期时间均前移）。
- 刷新提前量：`refreshSkew = 60_000 ms`（到期前 60s 触发）。
- 刷新请求（代码原文）：

```js
POST `${baseUrl}/api/usercenterbackend/oauth/access_token`
Content-Type: application/x-www-form-urlencoded
grant_type=refresh_x_cf_token
client_id=<clientId>
x_cf_refresh_token=<解密后的 refresh token>
client_secret=<clientSecret>          // clientSecret() 非空时带上
```

响应字段归一化：`x_cf_token/cf_token`、`x_cf_refresh_token/refresh_token`、
`x_cf_token_expires_in`（默认 7200）、`x_cf_refresh_token_expires_in`（默认 604800）、`userId`。

> ⚠️ **轮换告警**：refresh token 是"一次性轮换"的共享状态。若代理与桌面端各自用同一份 refresh token 去换新，
> 后换的一方可能让先换的一方凭据失效（互相踢下线）。详见 §11 的风险与建议。

### 8.5 环境变量模式（绕过 OAuth 的旁路）

代码中存在第二套鉴权模式：

```js
const authVariableNames = ["SRDCLOUD_CF_ACCESS_TOKEN","SRDCLOUD_USERID",
                           "SRDCLOUD_PROJECTID","SRDCLOUD_BASE_URL"];
function resolveAuthConfig(env) {
  const missing = authVariableNames.filter(n => !readTrimmed(env[n]));
  if (missing.length === authVariableNames.length) return { mode: "oauth" };  // 全空 → OAuth
  if (missing.length > 0) throw Error("Incomplete SRDCLOUD environment auth configuration…");
  return { mode:"environment", accessToken, userId, projectId, baseUrl };      // 四个齐全 → 环境模式
}
```

环境模式下请求头改为 `accessToken / userId / projectId`（不再做 HMAC 签名，且仅允许 `baseUrl` 同源目标）：

```js
headers.delete("x-cf-*"); headers.delete("Authorization"); headers.delete("apiKey");
headers.set("accessToken", runtime.accessToken);
headers.set("userId", runtime.userId);
headers.set("projectId", runtime.projectId);
```

`/codefree/auth/status` 的 schema 也预留了 `mode:"environment"`、`managedBy:"cloud-cli"`。
→ **给应用预置这 4 个环境变量并重启，即可跳过 OAuth**（但本机当前实例已启动，改 env 需重启，未做）。

---

## 9. 上游（www.srdcloud.cn）请求的签名与鉴权

### 9.1 OAuth 模式下：HMAC 签名头（无 Authorization）

`codefreeFetch()` → `signedRequest()`（代码原文）：

```js
headers.set("X-Cf-Token", token.cfToken);
headers.set("userId", token.userId);
headers.set("projectId", "0");
for (const [k, v] of Object.entries(await codefreeAuthHeaders({ method, appId: token.clientId }))) {
  headers.set(k, v);                       // X-Cf-AppId / X-Cf-Timestamp / X-Cf-Nonce / X-Cf-Signature
}
headers.delete("apiKey");
headers.delete("Authorization");
// 若响应 401：refresh() 后用新 cfToken 重新签名，重试一次
```

签名算法（代码原文）：

```js
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomUUID();
const stringToSign = [method.toUpperCase(), appId, timestamp, nonce].join("\n");
const signature = createHmac("sha256", Buffer.from(getSigningSecret(), "base64"))
  .update(stringToSign).digest("base64");
// 头：
//   X-Cf-AppId:    <clientId>
//   X-Cf-Timestamp:<unix 秒>
//   X-Cf-Nonce:    <uuid>
//   X-Cf-Signature:<base64 HMAC-SHA256>
```

其中 `getSigningSecret()` 返回**产品内嵌的静态 base64 密钥**（非用户凭据，实现代理必需）：

```
<REDACTED_SIGNING_SECRET>
```

### 9.2 该模式被用于哪些请求

`codefreeFetch()` 的已证实调用点全部指向 `https://www.srdcloud.cn/api/…` 业务接口，例如：

- `/api/acbackend/skillmarketplace/v1/skillconfigs?scenario=cli`（技能配置）
- `/api/pluginmarketback/plugin-market-web/v1/packages|category`（插件市场）
- MCP：`/api/acbackend/streamablemcp/mcp`（通过 `x-codefree-auth*` 标记 + `CodefreeMcpAuth.fetchWithAuth` 转发）

模型请求走的 `codefree` provider 也是经由同一签名 fetch（同一 `CodefreeAuth` 运行时对象），
但**具体 URL 路径未能 100% 确证**：provider 声明为 `@ai-sdk/openai-compatible` + `api.url=https://www.srdcloud.cn`，
按该 SDK 的拼接习惯应为 `POST https://www.srdcloud.cn/chat/completions`。此项标为**推断（中置信度）**，
未做真实调用验证（会消耗账号额度并产生会话数据，按只读原则未执行）。

### 9.3 环境模式下

`accessToken / userId / projectId` 三个普通头，无签名；目标必须与 `SRDCLOUD_BASE_URL` 同源同路径前缀，
否则抛 `Untrusted CodeFree environment request target`；401 直接报错（不自动刷新）。

---

## 10. 本地可发现的配额 / 用量表示

**结论：本地没有独立的配额计数或额度缓存。** 可发现的相关表示只有三类：

1. **会话级用量列**（`codefree.db` 的 `session` 表，当前 0 行）：

```sql
cost real DEFAULT 0 NOT NULL,
tokens_input integer DEFAULT 0 NOT NULL,
tokens_output integer DEFAULT 0 NOT NULL,
tokens_reasoning integer DEFAULT 0 NOT NULL,
tokens_cache_read integer DEFAULT 0 NOT NULL,
tokens_cache_write integer DEFAULT 0 NOT NULL
```

   `message` / `part` 表中还有每条消息的 usage 数据（`data` JSON 列），当前均为空。

2. **模型目录 cost 全为 0**：三个 CodeFree 模型 `cost={input:0, output:0, cache:{read:0,write:0}}` →
   订阅/网关计费，客户端不维护金额。

3. **配额只在上游以 HTTP 状态表达**，客户端仅做错误归类（代码原文）：

```js
if (input.status === 429) {
  if (/insufficient[-_\s]?quota|quota[-_\s]?exceeded/i.test(body)) return new QuotaExceededReason(…);
  return new RateLimitReason(…);
}
// 403 → AuthenticationReason{kind:"insufficient-permissions"}
// 401 → AuthenticationReason{kind:"invalid"}
```

另有 **org / 控制面** 字段（`account_state.active_org_id`、`control_account`、`/experimental/console/orgs`），
但本机 `switchableOrgCount=0`、`orgs=[]`，属于 opencode 通用 Console 能力，与 CodeFree 配额无直接关系。

**建议**：若代理需要展示额度，只能通过上游接口/429 响应或自行统计 token 用量，不能依赖本地状态。

---

## 11. 对 `server.mjs` 代理的可行路线（含风险）

### 路线 A：复用正在运行的桌面 sidecar（推荐用于"零凭据、零额度风险"联调）

- 认证：`Authorization: Basic base64("codefree:<uuid>")`，UUID 从主进程内存恢复（§5.3，已实测）；
- 优点：不需要复制/刷新用户令牌，不触碰 refresh token 轮换，模型/Provider 配置现成；
- 缺点：口令每次启动随机，需在启动时重新获取（可自动化：扫描主进程内存 + `/api/health` 探测）；
  且 sidecar 端口也是动态的（`OPENCODE_PORT` 可固定）；
- 端点：优先 `/api/session*`（v2，桌面端主用）或 `/session*`（v1），事件用 SSE `/event` 或 `/api/session/{id}/event`。

### 路线 B：独立进程重新托管同一 opencode Server（已实测可行）

- 依据：`out/main/chunks/node-CC-GAWt2.js` 是自包含 ESM bundle，导出 `Server`；
  用普通 Node 24 即可 `import` 并 `Server.listen({port, hostname, username, password, cors})`；
- 实测（`spawn-own.mjs`，隔离 `OPENCODE_TEST_HOME`/`XDG_*` 与临时数据目录）：

```
module keys: Config, Database, Server, bootstrap
Server.listen OK in 1776ms; url=http://127.0.0.1:56789
GET /global/health -> 200 :: {"healthy":true,"version":"1.10.1"}
GET /path -> 200 :: {"home":"…\\Temp\\dsh-recon\\own-sidecar-home", …}
no-auth /global/health -> 401
listener.stop() done
```

- 前置条件：把 `resources\app.asar.unpacked\node_modules\@lydell\node-pty-win32-x64`、
  `@parcel\watcher-win32-x64`、`@msgpackr-extract\msgpackr-extract-win32-x64` 以 junction 形式放到 bundle 同级 `node_modules`；
- 优点：口令自定、端口自定，可与桌面端并存；
- 缺点：若共用 `~\.codefree-o\.local\share`，两个进程会共享 DB/codefree.json（实例锁 + 刷新竞争），建议给代理副本独立 `OPENCODE_TEST_HOME`，
  但独立 home 下没有登录态，需要 `OPENCODE_CODEFREE_AUTH_FILE` 指向一份 `codefree.json` 副本（见路线 C 的轮换警告）。

### 路线 C：直接调用上游 `www.srdcloud.cn`（最贴近现有 `server.mjs` 的设计）

1. 读 `~\.codefree-o\.local\share\codefree.json`，用静态密钥 AES-256-GCM 解密出 refresh token；
2. `POST https://www.srdcloud.cn/api/usercenterbackend/oauth/access_token`
   `grant_type=refresh_x_cf_token&client_id=<REDACTED_CLIENT_ID>&x_cf_refresh_token=<rt>&client_secret=<REDACTED_CLIENT_SECRET>`
   → 得到 `x_cf_token`（约 2h）与新 `x_cf_refresh_token`；
3. 对每个请求构造签名头（§9.1）后发往 `https://www.srdcloud.cn`；
4. 新 refresh token 用同一静态密钥加密后**原子写回** `codefree.json`（保持桌面端可用）。

风险（务必在实现时处理）：

- **refresh token 轮换竞争**：桌面端与代理同时持有一份 refresh token，任何一方刷新都会轮换；
  建议加文件锁 + 每次刷新前重读文件 + 写回后立即生效；否则可能互相失效导致需要重新登录。
- **cfToken 只在内存**：无法从磁盘取得；只能自己刷新或从进程内存恢复。
- **路径假设**：`/chat/completions` 为推断（中置信度），需用一次真实请求验证。
- 当前 cfToken 到期时间已过（10:30:37），任何上游调用都会先触发一次 refresh 轮换。

---

## 12. 未解决项与限制（诚实清单）

| 项 | 状态 / 原因 |
|---|---|
| Chromium `Network\Cookies` 内容 | **未能读取**。该文件被网络服务进程（PID 26116）以独占方式持有，`CopyFile`/`FileStream(FileShare.ReadWrite)` 均报 `ERROR_SHARING_VIOLATION`；未通过停止应用来解锁。 |
| 渲染进程 `Local Storage\leveldb` | 已检查：`000003.log` 为 0 字节、无数据 → 渲染层未持久化令牌。 |
| cfToken（access token）本体 | **未落盘**，仅存在于主进程/ sidecar 内存，本报告未导出其值。 |
| 模型调用真实路径与响应形状 | 未执行真实对话请求（会消耗账号额度/写入会话），仅给出代码推断。 |
| 应用内登录 UI 的按钮/文案 | 未在 GUI 上人工点击；登录协议已从服务端代码与 `/doc` schema 完整还原。 |
| sidecar 进程环境变量 | Windows 无法通过 WMI 读取其他进程环境；以 `sidecar.js`/`index.js` 代码为据（`OPENCODE_SERVER_USERNAME/PASSWORD`、`XDG_STATE_HOME`）。 |
| `account`/`control_account` 用途 | 判定为 opencode 通用多账号/组织切换能力，CodeFree 登录不使用（实证：登录态存在而两表 0 行）。 |
| `?auth_token=` 的完整语义 | 已实测等价可用；代码中另用于 PTY WebSocket ticket，未展开。 |
| 应用重启后口令 | 随机 UUID，必然变化；代理需在每次启动时重新获取（路线 A 的主要代价）。 |

---

## 附录 A：完整端点数 210 条（OpenAPI 3.1，`GET /doc`）

<details>
<summary>展开逐条列表</summary>

```
PUT    /auth/{providerID}                                    Delete / Set auth credentials
DELETE /auth/{providerID}
POST   /log
POST   /experimental/control-plane/move-session
GET    /global/health
GET    /global/event
GET    /global/config
PATCH  /global/config
POST   /global/dispose
POST   /global/upgrade
GET    /api/market/skills
GET    /api/market/skills/categories
POST   /api/market/skills/install
POST   /api/market/skills/remove
POST   /api/market/skills/update
GET    /api/market/mcps
GET    /api/market/mcps/categories
POST   /api/market/mcps/install
POST   /api/market/mcps/remove
GET    /api/market/plugins
GET    /api/market/plugins/categories
POST   /api/market/plugins/install
POST   /api/market/plugins/remove
POST   /api/market/plugins/update
GET    /api/market/workers
GET    /api/market/workers/categories
POST   /api/market/workers/install
POST   /api/market/workers/remove
POST   /api/market/workers/update
GET    /event
GET    /config
PATCH  /config
GET    /config/providers
GET    /experimental/capabilities
GET    /experimental/console
GET    /experimental/console/orgs
POST   /experimental/console/switch
GET    /experimental/tool
GET    /experimental/tool/ids
GET    /experimental/worktree
POST   /experimental/worktree
DELETE /experimental/worktree
POST   /experimental/worktree/reset
GET    /experimental/session
POST   /experimental/session/{sessionID}/background
GET    /experimental/resource
GET    /find
GET    /find/file
GET    /find/symbol
GET    /file
GET    /file/content
GET    /file/status
POST   /instance/dispose
GET    /path
GET    /vcs
GET    /vcs/status
GET    /vcs/diff
GET    /vcs/diff/raw
POST   /vcs/apply
GET    /command
GET    /agent
GET    /skill
GET    /lsp
GET    /formatter
GET    /mcp
POST   /mcp
POST   /mcp/{name}/auth
DELETE /mcp/{name}/auth
POST   /mcp/{name}/auth/callback
POST   /mcp/{name}/auth/authenticate
POST   /mcp/{name}/connect
POST   /mcp/{name}/disconnect
GET    /project
GET    /project/current
POST   /project/git/init
PATCH  /project/{projectID}
GET    /project/{projectID}/directories
POST   /experimental/project/{projectID}/copy/generate-name
GET    /pty/shells
GET    /pty
POST   /pty
GET    /pty/{ptyID}
PUT    /pty/{ptyID}
DELETE /pty/{ptyID}
POST   /pty/{ptyID}/connect-token
GET    /question
POST   /question/{requestID}/reply
POST   /question/{requestID}/reject
GET    /permission
POST   /permission/{requestID}/reply
GET    /provider
GET    /provider/auth
POST   /provider/{providerID}/oauth/authorize
POST   /provider/{providerID}/oauth/callback
GET    /session
POST   /session
GET    /session/status
GET    /session/{sessionID}
DELETE /session/{sessionID}
PATCH  /session/{sessionID}
GET    /session/{sessionID}/children
GET    /session/{sessionID}/todo
GET    /session/{sessionID}/diff
GET    /session/{sessionID}/message
POST   /session/{sessionID}/message
GET    /session/{sessionID}/message/{messageID}
DELETE /session/{sessionID}/message/{messageID}
POST   /session/{sessionID}/fork
POST   /session/{sessionID}/abort
POST   /session/{sessionID}/init
POST   /session/{sessionID}/share
DELETE /session/{sessionID}/share
POST   /session/{sessionID}/summarize
POST   /session/{sessionID}/prompt_async
POST   /session/{sessionID}/command
POST   /session/{sessionID}/shell
POST   /session/{sessionID}/revert
POST   /session/{sessionID}/unrevert
POST   /session/{sessionID}/permissions/{permissionID}
DELETE /session/{sessionID}/message/{messageID}/part/{partID}
PATCH  /session/{sessionID}/message/{messageID}/part/{partID}
POST   /sync/start
POST   /sync/replay
POST   /sync/steal
POST   /sync/history
POST   /tui/append-prompt
POST   /tui/open-help
POST   /tui/open-sessions
POST   /tui/open-themes
POST   /tui/open-models
POST   /tui/submit-prompt
POST   /tui/clear-prompt
POST   /tui/execute-command
POST   /tui/show-toast
POST   /tui/publish
POST   /tui/select-session
GET    /tui/control/next
POST   /tui/control/response
GET    /experimental/workspace/adapter
GET    /experimental/workspace
POST   /experimental/workspace
POST   /experimental/workspace/sync-list
GET    /experimental/workspace/status
DELETE /experimental/workspace/{id}
POST   /experimental/workspace/warp
GET    /api/health
GET    /codefree/auth/status
POST   /codefree/auth/login
POST   /codefree/auth/logout
GET    /api/location
GET    /api/agent
GET    /api/session
POST   /api/session
GET    /api/session/active
GET    /api/session/{sessionID}
POST   /api/session/{sessionID}/agent
POST   /api/session/{sessionID}/model
POST   /api/session/{sessionID}/prompt
POST   /api/session/{sessionID}/compact
POST   /api/session/{sessionID}/wait
POST   /api/session/{sessionID}/revert/stage
POST   /api/session/{sessionID}/revert/clear
POST   /api/session/{sessionID}/revert/commit
GET    /api/session/{sessionID}/context
GET    /api/session/{sessionID}/history
GET    /api/session/{sessionID}/event
POST   /api/session/{sessionID}/interrupt
GET    /api/session/{sessionID}/message/{messageID}
GET    /api/session/{sessionID}/message
GET    /api/model
GET    /api/provider
GET    /api/provider/{providerID}
GET    /api/integration
GET    /api/integration/{integrationID}
POST   /api/integration/{integrationID}/connect/key
POST   /api/integration/{integrationID}/connect/oauth
GET    /api/integration/attempt/{attemptID}
DELETE /api/integration/attempt/{attemptID}
POST   /api/integration/attempt/{attemptID}/complete
PATCH  /api/credential/{credentialID}
DELETE /api/credential/{credentialID}
GET    /api/permission/request
GET    /api/permission/saved
DELETE /api/permission/saved/{id}
POST   /api/session/{sessionID}/permission
GET    /api/session/{sessionID}/permission
GET    /api/session/{sessionID}/permission/{requestID}
POST   /api/session/{sessionID}/permission/{requestID}/reply
GET    /api/fs/read/*
GET    /api/fs/list
GET    /api/fs/find
GET    /api/command
GET    /api/skill
GET    /api/event
GET    /api/pty
POST   /api/pty
GET    /api/pty/{ptyID}
PUT    /api/pty/{ptyID}
DELETE /api/pty/{ptyID}
POST   /api/pty/{ptyID}/connect-token
GET    /api/pty/{ptyID}/connect
GET    /api/question/request
GET    /api/session/{sessionID}/question
POST   /api/session/{sessionID}/question/{requestID}/reply
POST   /api/session/{sessionID}/question/{requestID}/reject
GET    /api/reference
POST   /experimental/project/{projectID}/copy
DELETE /experimental/project/{projectID}/copy
POST   /experimental/project/{projectID}/copy/refresh
GET    /pty/{ptyID}/connect
```

</details>

---

## 附录 B：关键命令速查（复现用）

```powershell
# 1) 进程与端口
Get-CimInstance Win32_Process | ? Name -eq 'CodeFree-O.exe' | Select ProcessId,ParentProcessId,CommandLine
Get-NetTCPConnection -State Listen | ? OwningProcess -in (Get-Process CodeFree-O).Id

# 2) 登录态（明文可见，无需解密）
Get-Content -Raw "$env:USERPROFILE\.codefree-o\.local\share\codefree.json"

# 3) DB 只读副本 + 表清单
Copy-Item "$env:USERPROFILE\.codefree-o\.local\share\codefree.db*" "$env:TEMP\dsh-recon\db\"
python "$env:TEMP\dsh-recon\readdb.py"

# 4) 从 asar 提取主进程/sidecar 代码（无需 electron）
node "$env:TEMP\dsh-recon\asar.mjs" extract "$env:TEMP\dsh-recon\extract" package.json out/main/sidecar.js out/main/index.js
node "$env:TEMP\dsh-recon\asar.mjs" grep "Secure Area" "OPENCODE_SERVER_USERNAME"

# 5) 恢复 sidecar 口令（只读内存扫描 + /api/health 校验）
python "$env:TEMP\dsh-recon\memscan.py" 9364

# 6) 认证枚举
$pw=(Get-Content -Raw "$env:TEMP\dsh-recon\sidecar-pw.txt").Trim()
node "$env:TEMP\dsh-recon\probe2.mjs" $pw
node "$env:TEMP\dsh-recon\dump2.mjs"  $pw

# 7) 解密 refresh token（静态密钥）
node "$env:TEMP\dsh-recon\decrypt.mjs"

# 8) 独立托管同一 Server（隔离 HOME/XDG）
$env:ELECTRON_RUN_AS_NODE=''; node "$env:TEMP\dsh-recon\spawn-own.mjs"
```

---

## 附录 C：与旧版协议的差异提示（给 `server.mjs` 维护者）

旧 `README.md` / `server.mjs` 按 1.7.0 CLI 时代协议实现；1.10.1 的关键差异：

1. **登录不再是 CLI 交互**，而是浏览器 OAuth+PKCE（§8.1）；不存在 CLI 可复用的设备码/密码流。
2. **上游不再用 `Authorization: Bearer`**，改为 `X-Cf-Token` + `X-Cf-*` HMAC 签名头（§9.1）；
   环境变量模式则用 `accessToken` 头。
3. **API 面大幅扩张**：sidecar 暴露 210 个操作，且存在 v1（`/session*`）与 v2（`/api/session*`）两套；
   桌面端主用 v2。
4. **本地登录态文件迁移**：`codefree.json` v2（加密）取代旧明文/v1；旧文件读到即清除。
5. **动态口令**：桌面 sidecar 口令每次启动随机，且不允许远程/持久接入——代理要么每次恢复口令（路线 A），
   要么自托管/直连上游（路线 B/C）。

---

*报告完。所有结论均可由 §附录 B 命令在本机复现；唯一无法复现的是 Chromium Cookies（被进程独占锁定）与 cfToken 值（仅内存）。*
