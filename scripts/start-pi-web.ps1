# 启动/停止 pi-web（web + sessiond），并配置好连接本机 CodeFree-O 代理所需的 Windows 参数
#
# 背景：
#   - pi-web 在 Windows 上不能使用文件路径作为 sessiond socket（Node 会按命名管道解析导致 EACCES），
#     必须改用 TCP：sessiond 监听 PI_WEB_SESSIOND_PORT，web 用 PI_WEB_SESSIOND_URL 连接。
#   - 模型 provider 由 scripts/setup-pi-web.ps1 写入 ~/.pi/agent/models.json，指向本代理 /v1。
#
# 用法：
#   .\scripts\start-pi-web.ps1                 # 启动 sessiond + web（后台），打印地址
#   .\scripts\start-pi-web.ps1 -Stop           # 停止本脚本启动的 pi-web 进程
#   .\scripts\start-pi-web.ps1 -Build          # 先构建前端产物再启动（首次 UI 使用前需要）
param(
    [switch]$Stop,
    [switch]$Build,
    [string]$PiWebDir = '<pi-web-repo>',
    [int]$SessiondPort = 8511,
    [int]$WebPort = 8504
)

$ErrorActionPreference = 'Stop'
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)?.Source
if (-not $npm) {
    $nodeRoot = Split-Path -Parent (Get-Command node).Source
    $npm = Join-Path $nodeRoot 'npm.cmd'
}
if (-not (Test-Path -LiteralPath $npm)) { throw "找不到 npm.cmd：$npm" }
if (-not (Test-Path -LiteralPath $PiWebDir)) { throw "pi-web 目录不存在：$PiWebDir" }

$env:ELECTRON_RUN_AS_NODE = ''
$env:PATH = (Join-Path $PiWebDir 'node_modules\.bin') + ';' + $env:PATH

function Get-PiWebProcesses {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -match 'pi-web-ChineseTranslation' -and
            ($_.CommandLine -match 'src/server/index\.ts' -or $_.CommandLine -match 'src/server/sessiond\.ts' -or $_.CommandLine -match 'dev-sessiond\.mjs')
        }
}

if ($Stop) {
    $procs = Get-PiWebProcesses
    if ($procs.Count -eq 0) { Write-Host '没有找到运行中的 pi-web 进程'; return }
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Host "已停止 PID $($p.ProcessId)" } catch { Write-Host "停止 PID $($p.ProcessId) 失败：$($_.Exception.Message)" }
    }
    return
}

if ($Build) {
    Write-Host '[1/2] 构建 pi-web 前端产物（npm run build）...'
    Push-Location $PiWebDir
    try {
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw "构建失败，退出码 $LASTEXITCODE" }
    } finally { Pop-Location }
}

# ---- 启动 sessiond（TCP） ----
$sessiondEnv = @{
    PI_WEB_SESSIOND_PORT = "$SessiondPort"
    PI_WEB_SESSIOND_HOST = '127.0.0.1'
}
Write-Host "[启动] sessiond（127.0.0.1:$SessiondPort）..."
$sd = Start-Process -FilePath $npm -ArgumentList 'run', 'start:sessiond' -WorkingDirectory $PiWebDir -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -State Listen -LocalPort $SessiondPort -ErrorAction SilentlyContinue) { break }
}
if (-not (Get-NetTCPConnection -State Listen -LocalPort $SessiondPort -ErrorAction SilentlyContinue)) {
    throw "sessiond 未在 ${SessiondPort} 端口就绪（查看进程输出或 npm run start:sessiond）"
}
Write-Host "[就绪] sessiond"

# ---- 启动 web（用 URL 连接 daemon） ----
Write-Host "[启动] pi-web web（http://127.0.0.1:$WebPort）..."
$webEnv = @{ PI_WEB_SESSIOND_URL = "http://127.0.0.1:$SessiondPort" }
# Start-Process 不直接接受环境变量：通过 cmd 包装设置
$cmdLine = "set PI_WEB_SESSIOND_URL=http://127.0.0.1:$SessiondPort&& set PI_WEB_SESSIOND_PORT=$SessiondPort&& set PI_WEB_SESSIOND_HOST=127.0.0.1&& `"$npm`" start"
$web = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmdLine -WorkingDirectory $PiWebDir -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/api/pi-web/health" -TimeoutSec 2
        if ($r.ok) { break }
    } catch {}
}
try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$WebPort/api/pi-web/health" -TimeoutSec 3 } catch { $r = $null }
if (-not $r -or -not $r.ok) { throw "pi-web web 未在 $WebPort 端口就绪" }

Write-Host ''
Write-Host "✅ pi-web 已启动"
Write-Host "   Web/UI : http://127.0.0.1:$WebPort"
Write-Host "   Sessiond: 127.0.0.1:$SessiondPort"
Write-Host "   停止   : .\scripts\start-pi-web.ps1 -Stop"
Write-Host ''
Write-Host '首次使用需在 UI 里设置普通模式口令（或调用 POST /api/normal-auth/setup）。'
Write-Host '模型选择 codefree/GLM-5.2；如列表为空请先运行 scripts\setup-pi-web.ps1 并新建项目。'
