# 生成多账号池 config.json（按 codefree.json 凭据文件列表）
#
# 规则：
#   - 第一个账号默认 writeBack=mirror（与桌面端共用登录态，代理刷新后写回原文件）；
#   - 其余账号默认 writeBack=isolated（代理专属：刷新后的 token 写 state/accounts/<id>.json，
#     源文件只读不写回，避免与对方客户端互相轮换失效）。
#   - 自动生成管理令牌并写入 .admin-token.txt（已 gitignore）。
#
# 用法：
#   .\scripts\setup-pool.ps1 -AuthFiles "C:\Users\<你>\.codefree-o\.local\share\codefree.json,<repo>\secrets\acc-b.codefree.json"
#   .\scripts\setup-pool.ps1 -AuthFiles "..." -Force    # 覆盖已有 config.json（自动备份）
param(
    [Parameter(Mandatory = $true)][string]$AuthFiles,
    [string]$Root = '<repo>',
    [int]$Port = 8787,
    [string]$AdminToken,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$files = $AuthFiles.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($files.Count -eq 0) { throw '至少需要一个 codefree.json 路径' }

$configPath = Join-Path $Root 'config.json'
if ((Test-Path -LiteralPath $configPath) -and -not $Force) {
    throw "config.json 已存在：$configPath（如确需覆盖请加 -Force）"
}
if ((Test-Path -LiteralPath $configPath) -and $Force) {
    $bak = "$configPath.bak." + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $configPath -Destination $bak -Force
    Write-Host "已备份旧配置：$bak"
}

if (-not $AdminToken) {
    $bytes = New-Object byte[] 18
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $AdminToken = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

$accounts = @()
$index = 0
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file)) { throw "凭据文件不存在：$file" }
    $raw = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not $raw.encryptedRefreshCfToken -and -not $raw.refreshCfToken) { throw "不是有效的 codefree.json（缺少 refresh token）：$file" }
    $userId = if ($raw.userId) { [string]$raw.userId } else { '' }
    $index++
    $writeBack = if ($index -eq 1) { 'mirror' } else { 'isolated' }
    $accounts += [pscustomobject]@{
        id           = if ($userId) { "acc-$index-u$userId" } else { "acc-$index" }
        label        = if ($userId) { "账号$index（userId $userId）" } else { "账号$index" }
        userId       = $userId
        baseUrl      = if ($raw.baseUrlSnapshot) { $raw.baseUrlSnapshot } else { 'https://www.srdcloud.cn' }
        authFile     = $file.Replace('\', '/')
        writeBack    = $writeBack
        maxConcurrent = 3
        priority     = 0
        tags         = @($writeBack)
        enabled      = $true
    }
}

$config = [ordered]@{
    schemaVersion = 1
    server        = [ordered]@{
        host = '127.0.0.1'; port = $Port; adminToken = $AdminToken; adminTokenEnv = 'CODEFREE_ADMIN_TOKEN'
        allowRemoteAdmin = $false; maxBodyBytes = 33554432; shutdownTimeoutMs = 15000; debug = $false
    }
    upstream      = [ordered]@{
        baseUrl = 'https://www.srdcloud.cn'
        clientId = $env:CODEFREE_CLIENT_ID
        clientSecret = $env:CODEFREE_CLIENT_SECRET
        signingSecret = $env:CODEFREE_SIGNING_SECRET
        version = '1.10.1'; subService = 'codefree_o_chat'; clientTag = 'codefreeo'
        requestTimeoutMs = 300000; refreshTimeoutMs = 15000; quotaTimeoutMs = 8000
    }
    accounts      = $accounts
    imports       = [ordered]@{ authfile = [ordered]@{ enabled = $false; path = ''; mode = 'mirror' } }
    refresh       = [ordered]@{ skewMs = 120000; maxRetries = 3; backoffMs = @(300, 900, 2700); preRefreshWindowMs = 600000; startupWarmup = $false }
    quota         = [ordered]@{
        enabled = $true; endpoint = '/api/aebackend/quota/v1/me'; assumeUnknownHeadroom = 0.5; maxAgeMs = 60000
        probe = [ordered]@{ enabled = $true; timeoutMs = 8000; maxConcurrentProbes = 2; globalRatePerSec = 1; perAccountQps = 0.2; hourlyBudget = 120; hotMs = 60000; warmMs = 300000; coldMs = 1800000; jitterRatio = 0.2; backoffMaxMs = 1800000 }
    }
    selection     = [ordered]@{
        stickyTtlMs = 1800000; stickyMinHeadroom = 0.1; stickyScoreFactor = 0.6; maxAttemptsPerRequest = 3; maxAccountsPerRequest = 2; maxSameAccountRetries = 1
        weights = [ordered]@{ headroom = 1.0; health = 0.5; load = 0.5; priority = 0.2; preferred = 0.3 }
        cooldown = [ordered]@{ quotaFallbackMs = 300000; authExpiredMs = 600000; rateLimitMs = 30000; upstream5xxMs = 15000; networkMs = 10000 }
    }
    consumers     = @()
    stateDir      = './state'
    journal       = [ordered]@{ enabled = $true; file = '' }
}

$json = $config | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $Root '.admin-token.txt'), $AdminToken, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "✅ 已生成池配置：$configPath"
Write-Host "   管理令牌已写入：$(Join-Path $Root '.admin-token.txt')（已 gitignore）"
Write-Host ''
$accounts | ForEach-Object { Write-Host ("   [{0}] {1}  writeBack={2}  file={3}" -f $_.id, $_.label, $_.writeBack, $_.authFile) }
Write-Host ''
Write-Host "启动：`$env:CODEFREE_CONFIG='$configPath'; node server.mjs"
Write-Host "验收：node test/multi-account-acceptance.mjs"
