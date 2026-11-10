# 将本机 CodeFree-O 代理接入 pi-web / Pi Coding Agent
#
# 原理：pi-web 的普通模式提供器来自 Pi agent 的 models.json
#   - 全局：~/.pi/agent/models.json（pi-web 首次注册项目时复制到项目托管目录）
#   - 项目：<项目>/.pi/models.json（可选，项目级覆盖）
# 本脚本把 provider（默认 codefree）写入指定 models.json，模型清单优先从代理 /v1/models 拉取。
#
# 用法：
#   .\scripts\setup-pi-web.ps1                          # 写全局 ~/.pi/agent/models.json
#   .\scripts\setup-pi-web.ps1 -ProjectDir D:\some\repo # 同时写 <repo>\.pi\models.json
#   .\scripts\setup-pi-web.ps1 -Remove                  # 移除本脚本写入的 provider
param(
    [string]$ProxyBase = 'http://127.0.0.1:8787/v1',
    [string]$ProviderId = 'codefree',
    [string]$ProviderName = 'CodeFree-O Proxy',
    [string]$ApiKey = 'codefree-local',
    [string]$ProjectDir,
    [switch]$Remove,
    [string]$GlobalModelsPath
)

$ErrorActionPreference = 'Stop'

if (-not $GlobalModelsPath) {
    $GlobalModelsPath = Join-Path $env:USERPROFILE '.pi\agent\models.json'
}

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    if (-not $text.Trim()) { return $null }
    return ($text | ConvertFrom-Json)
}

function Write-JsonFile([string]$path, $obj) {
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json = ($obj | ConvertTo-Json -Depth 30)
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ---- 从代理拉取模型清单（失败时用静态兜底） ----
$fallbackModels = @(
    @{ id = 'GLM-5.2'; contextWindow = 184000; maxTokens = 16000; input = @('text') },
    @{ id = 'Qwen3.8-27B'; contextWindow = 200000; maxTokens = 16000; input = @('text', 'image') },
    @{ id = 'DeepSeek-V4-Flash-0731'; contextWindow = 200000; maxTokens = 16000; input = @('text') }
)
$models = $fallbackModels
try {
    $healthUrl = ($ProxyBase -replace '/v1$', '') + '/v1/models'
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 8
    if ($resp.data -and $resp.data.Count -gt 0) {
        $models = @($resp.data | ForEach-Object {
            $m = $_
            $ctx = 184000
            $out = 16000
            if ($m.meta) {
                if ($m.meta.maxTokens) { $ctx = [int]$m.meta.maxTokens }
                if ($m.meta.maxOutputTokens) { $out = [int]$m.meta.maxOutputTokens }
            }
            $input = @('text')
            if ($m.meta -and $m.meta.modelType -eq 'multimodal') { $input = @('text', 'image') }
            @{ id = $m.id; contextWindow = $ctx; maxTokens = $out; input = $input }
        })
        Write-Host "已从代理拉取模型清单：$($models.Count) 个"
    }
} catch {
    Write-Host "警告：无法从代理拉取模型清单（$($_.Exception.Message)），使用静态兜底清单"
}

$modelEntries = @($models | ForEach-Object {
    [pscustomobject]@{
        id = $_.id
        name = $_.id
        reasoning = $false
        input = @($_.input)
        cost = [pscustomobject]@{ input = 0; output = 0; cacheRead = 0; cacheWrite = 0 }
        contextWindow = [int]$_.contextWindow
        maxTokens = [int]$_.maxTokens
    }
})

# ---- 更新目标文件（全局 + 可选项目） ----
function Update-ModelsFile([string]$path) {
    $root = Read-JsonFile $path
    if (-not $root) { $root = [pscustomobject]@{ providers = [pscustomobject]@{} } }
    if (-not $root.providers) {
        $root | Add-Member -NotePropertyName providers -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $providers = $root.providers
    $existing = $null
    if ($providers.PSObject.Properties[$ProviderId]) { $existing = $providers.$ProviderId }

    if ($Remove) {
        if ($existing) { $providers.PSObject.Properties.Remove($ProviderId) }
        Write-JsonFile $path $root
        Write-Host "已从 $path 移除 provider：$ProviderId"
        return
    }

    if (-not (Test-Path -LiteralPath "$path.bak-codefreeproxy")) {
        if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination "$path.bak-codefreeproxy" -Force; Write-Host "已备份：$path.bak-codefreeproxy" }
    }

    $provider = [pscustomobject]@{
        name = $ProviderName
        baseUrl = $ProxyBase
        apiKey = $ApiKey
        api = 'openai-completions'
        models = $modelEntries
    }
    $providers | Add-Member -NotePropertyName $ProviderId -NotePropertyValue $provider -Force
    Write-JsonFile $path $root
    Write-Host "已写入 $path"
    Write-Host "  provider : $ProviderId ($ProviderName)"
    Write-Host "  baseUrl  : $ProxyBase"
    Write-Host "  models   : $($modelEntries.id -join ', ')"
}

Update-ModelsFile $GlobalModelsPath
if ($ProjectDir) {
    $projectModels = Join-Path $ProjectDir '.pi\models.json'
    Update-ModelsFile $projectModels
}

Write-Host ''
Write-Host '提示：pi-web 已在运行的项目需重启 session daemon 才会重建 provider registry（详见 pi-web docs/config.md）。'
Write-Host '      全新项目首次注册时会从全局 ~/.pi/agent/models.json 复制一份 models.json。'
