# ZCode 端到端冒烟测试：用 ZCode CLI 发一条真实 prompt，经本机 CodeFree-O 代理转发到上游。
#
# 前置：
#   1) 已登录 CodeFree-O 桌面端（~/.codefree-o/.local/share/codefree.json）
#   2) 代理已启动（默认 http://127.0.0.1:8787）
#   3) 已执行 scripts\setup-zcode.ps1 注册 custom:codefree-proxy
#
# 用法：
#   .\scripts\zcode-smoke-test.ps1                      # 默认 prompt「只回复两个字：收到」
#   .\scripts\zcode-smoke-test.ps1 -Prompt "回复OK"      # 自定义 prompt
#   .\scripts\zcode-smoke-test.ps1 -ZCodeRoot D:\AI-Tools\Apps\ZCode
param(
    [string]$Prompt = '只回复两个字：收到',
    [string]$ZCodeRoot = 'D:\AI-Tools\Apps\ZCode',
    [string]$ProxyHealthUrl = 'http://127.0.0.1:8787/health'
)

$ErrorActionPreference = 'Stop'

# 1) 代理存活检查
try {
    $health = Invoke-RestMethod -Uri $ProxyHealthUrl -TimeoutSec 5
    Write-Host "[1/3] 代理正常：version=$($health.version)，auth.authenticated=$($health.auth.authenticated)"
} catch {
    throw "代理不可达（$ProxyHealthUrl）：请先运行 node server.mjs。$($_.Exception.Message)"
}

# 2) ZCode CLI 入口与 provider 配置
$cli = Join-Path $ZCodeRoot 'resources\glm\zcode.cjs'
if (-not (Test-Path -LiteralPath $cli)) { throw "未找到 ZCode CLI：$cli" }
$builtin = Join-Path $ZCodeRoot 'resources\config\provider\zcode-builtin.json'
$personal = Join-Path $env:USERPROFILE '.zcode\v2\provider_config.json'
if (-not (Test-Path -LiteralPath $builtin)) { throw "未找到内置 provider 配置：$builtin" }
if (-not (Test-Path -LiteralPath $personal)) { throw "未找到个人 provider 配置：$personal（先运行 scripts\setup-zcode.ps1）" }

# 3) 运行无头 prompt
$env:ELECTRON_RUN_AS_NODE = ''
$env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = $builtin
$env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = $personal

$work = Join-Path $env:TEMP ('zcode-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
Push-Location $work
try {
    Write-Host "[2/3] 执行 ZCode 无头调用：$Prompt"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $output = & node $cli -p $Prompt --json --no-color --surface terminal 2>&1
    $code = $LASTEXITCODE
    $sw.Stop()
} finally {
    Pop-Location
}

$text = ($output | Out-String).Trim()
Write-Host "[3/3] 退出码=$code，耗时=$([math]::Round($sw.TotalSeconds,1))s"
Write-Host "----- ZCode 输出 -----"
Write-Host $text

# 校验：JSON 可解析 + response 非空 + 至少 1 次模型请求
try {
    $json = $text | ConvertFrom-Json
} catch {
    throw "ZCode 输出不是合法 JSON，调用失败（见上方输出）"
}
if (-not $json.response) { throw "ZCode 未返回 response，调用失败" }
if (-not $json.usage -or [int]$json.usage.modelRequestCount -lt 1) { throw "未发生模型请求，调用失败" }

Write-Host ""
Write-Host "✅ 通过：ZCode → CodeFree-O 代理 → 上游 真实调用成功"
Write-Host "   response       : $($json.response)"
Write-Host "   model 请求次数 : $($json.usage.modelRequestCount)"
Write-Host "   tokens(输入/输出): $($json.usage.inputTokens)/$($json.usage.outputTokens)"
Write-Host "   sessionId      : $($json.sessionId)"
