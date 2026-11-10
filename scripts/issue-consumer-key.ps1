# 为使用者发放/轮换 CodeFree-O 代理的消费者 API Key（多人共享）
#
# 依赖运行中的代理与管理令牌（默认读取项目根目录 .admin-token.txt）。
#
# 用法：
#   .\scripts\issue-consumer-key.ps1 -Name "张三" -Rpm 60 -MaxConcurrent 3
#   .\scripts\issue-consumer-key.ps1 -Name "李四" -Id li-si -Rpm 30
#   .\scripts\issue-consumer-key.ps1 -List
#   .\scripts\issue-consumer-key.ps1 -Rotate zhangsan
#   .\scripts\issue-consumer-key.ps1 -Remove zhangsan
#   .\scripts\issue-consumer-key.ps1 -Name "王五" -PiWebModels <pi-web-repo>\.pi\models.json
param(
    [string]$Name,
    [string]$Id,
    [int]$Rpm = 0,
    [int]$MaxConcurrent = 0,
    [string]$ProxyBase = 'http://127.0.0.1:8787',
    [string]$AdminToken,
    [string]$TokenFile,
    [string]$PiWebModels,
    [string]$ProviderId = 'codefree',
    [switch]$List,
    [string]$Rotate,
    [string]$Remove
)

$ErrorActionPreference = 'Stop'
if (-not $TokenFile) { $TokenFile = Join-Path '<repo>' '.admin-token.txt' }
if (-not $AdminToken -and (Test-Path -LiteralPath $TokenFile)) {
    $AdminToken = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
}
if (-not $AdminToken) { throw '缺少管理令牌：请用 -AdminToken 传入或先运行 scripts\setup-pool.ps1 生成 .admin-token.txt' }

$headers = @{ 'X-Admin-Token' = $AdminToken; 'Content-Type' = 'application/json' }

if ($List) {
    $res = Invoke-RestMethod -Uri "$ProxyBase/admin/consumers" -Headers $headers -TimeoutSec 10
    Write-Host "消费者（enabled=$($res.enabled)）："
    $res.consumers | Format-Table id, name, keyPrefix, rpm, maxConcurrent, enabled, total, active, windowRpm -AutoSize | Out-String | Write-Host
    return
}
if ($Rotate) {
    $res = Invoke-RestMethod -Uri "$ProxyBase/admin/consumers/$([uri]::EscapeDataString($Rotate))/rotate" -Method POST -Headers $headers -TimeoutSec 10
    Write-Host "已轮换 $($res.consumer.id) 的 API Key："
    Write-Host "  $($res.key)"
    return
}
if ($Remove) {
    Invoke-RestMethod -Uri "$ProxyBase/admin/consumers/$([uri]::EscapeDataString($Remove))" -Method DELETE -Headers $headers -TimeoutSec 10 | Out-Null
    Write-Host "已删除消费者：$Remove"
    return
}
if (-not $Name) { throw '缺少 -Name（或用 -List / -Rotate / -Remove）' }

$body = @{ name = $Name; rpm = $Rpm; maxConcurrent = $MaxConcurrent } | ConvertTo-Json -Compress
if ($Id) { $body = @{ id = $Id; name = $Name; rpm = $Rpm; maxConcurrent = $MaxConcurrent } | ConvertTo-Json -Compress }
# Windows PowerShell 5.1 默认按单字节编码发送字符串 body，中文会变 "??"；显式转 UTF-8 字节
$bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
$res = Invoke-RestMethod -Uri "$ProxyBase/admin/consumers" -Method POST -Headers $headers -Body $bodyBytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 10

Write-Host ''
Write-Host "✅ 已发放消费者 API Key"
Write-Host "   id     : $($res.consumer.id)"
Write-Host "   name   : $($res.consumer.name)"
Write-Host "   rpm    : $($res.consumer.rpm)"
Write-Host "   maxConc: $($res.consumer.maxConcurrent)"
Write-Host "   key    : $($res.key)"
Write-Host ''
Write-Host '使用方式：客户端请求头带 Authorization: Bearer <key>（或 x-api-key: <key>）。'

if ($PiWebModels) {
    if (-not (Test-Path -LiteralPath $PiWebModels)) { throw "pi-web models.json 不存在：$PiWebModels" }
    $json = [System.IO.File]::ReadAllText($PiWebModels, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not $json.providers -or -not $json.providers.$ProviderId) { throw "models.json 中没有 provider：$ProviderId" }
    $json.providers.$ProviderId | Add-Member -NotePropertyName apiKey -NotePropertyValue $res.key -Force
    $bak = "$PiWebModels.bak-consumer-key"
    if (-not (Test-Path -LiteralPath $bak)) { Copy-Item -LiteralPath $PiWebModels -Destination $bak -Force; Write-Host "已备份：$bak" }
    [System.IO.File]::WriteAllText($PiWebModels, ($json | ConvertTo-Json -Depth 30), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "已将新 Key 写入 pi-web models.json 的 provider「$ProviderId」：$PiWebModels"
}
