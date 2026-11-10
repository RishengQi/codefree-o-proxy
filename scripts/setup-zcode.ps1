# 将本机 CodeFree-O 代理接入 ZCode（写入 ZCode 的自定义 Provider 配置）
#
# 作用：在 ZCode 的 provider 配置里注册一个 OpenAI 兼容 provider：
#   providerId : custom:codefree-proxy
#   baseUrl    : http://127.0.0.1:8787/v1
#   模型       : GLM-5.2 / Qwen3.8-27B / DeepSeek-V4-Flash-0731
# 并把它设为默认模型（如未指定其他默认）。
#
# 用法：
#   .\setup-zcode.ps1                 # 安装/更新 provider
#   .\setup-zcode.ps1 -Remove         # 移除 provider（尽量恢复原默认模型）
#   .\setup-zcode.ps1 -ProxyBase http://127.0.0.1:8788/v1
param(
    [switch]$Remove,
    [string]$ProxyBase = 'http://127.0.0.1:8787/v1',
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

if (-not $ConfigPath) {
    $ConfigPath = Join-Path $env:USERPROFILE '.zcode\v2\provider_config.json'
}

$ProviderId = 'custom:codefree-proxy'
$ProviderName = 'CodeFree Proxy (本机)'
$Models = @('GLM-5.2', 'Qwen3.8-27B', 'DeepSeek-V4-Flash-0731')

function Read-JsonFile([string]$path) {
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    return ($text | ConvertFrom-Json)
}

function Write-JsonFile([string]$path, $obj) {
    $json = ($obj | ConvertTo-Json -Depth 30)
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------- 读取现有配置（不存在则构造空骨架） ----------
$root = $null
if (Test-Path -LiteralPath $ConfigPath) {
    try { $root = Read-JsonFile $ConfigPath } catch { $root = $null }
}
if (-not $root) {
    $root = [pscustomobject]@{
        schemaVersion = 1
        config = [pscustomobject]@{
            providerConfigRules = [pscustomobject]@{ providerRules = @() }
            modelConfigRules = [pscustomobject]@{
                providerModelRules = @()
                manualProviderModelRules = @()
            }
        }
    }
}

# 结构兜底
if (-not $root.config) { $root | Add-Member -NotePropertyName config -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $root.config.providerConfigRules) {
    $root.config | Add-Member -NotePropertyName providerConfigRules -NotePropertyValue ([pscustomobject]@{ providerRules = @() }) -Force
}
if (-not $root.config.providerConfigRules.providerRules) {
    $root.config.providerConfigRules | Add-Member -NotePropertyName providerRules -NotePropertyValue @() -Force
}
if (-not $root.config.modelConfigRules) {
    $root.config.modelConfigRules | Add-Member -NotePropertyName modelConfigRules -NotePropertyValue ([pscustomobject]@{
        providerModelRules = @(); manualProviderModelRules = @()
    }) -Force
}
if (-not $root.config.modelConfigRules.providerModelRules) {
    $root.config.modelConfigRules | Add-Member -NotePropertyName providerModelRules -NotePropertyValue @() -Force
}
if (-not $root.config.modelConfigRules.manualProviderModelRules) {
    $root.config.modelConfigRules | Add-Member -NotePropertyName manualProviderModelRules -NotePropertyValue @() -Force
}

# 备份（仅首次）
$bak = "$ConfigPath.bak-codefreeproxy"
if ((Test-Path -LiteralPath $ConfigPath) -and -not (Test-Path -LiteralPath $bak)) {
    Copy-Item -LiteralPath $ConfigPath -Destination $bak -Force
    Write-Host "已备份原配置：$bak"
}

function Test-OurId($rule) { return ($rule -and $rule.providerId -eq $ProviderId) }

# ---------- 移除 ----------
if ($Remove) {
    $root.config.providerConfigRules.providerRules = @($root.config.providerConfigRules.providerRules | Where-Object { -not (Test-OurId $_) })
    $root.config.modelConfigRules.providerModelRules = @($root.config.modelConfigRules.providerModelRules | Where-Object { -not (Test-OurId $_) })
    if ($root.config.providerOrder) {
        $root.config.providerOrder = @($root.config.providerOrder | Where-Object { $_ -ne $ProviderId })
    }
    if ($root.config.defaultModelSelection -and (Test-OurId $root.config.defaultModelSelection)) {
        $root.config.PSObject.Properties.Remove('defaultModelSelection')
    }
    Write-JsonFile $ConfigPath $root
    Write-Host "已移除 ZCode 自定义 Provider：$ProviderId"
    return
}

# ---------- 安装 / 更新 ----------
# 1) provider 规则（同 id 覆盖）
$providerConfig = [pscustomobject]@{
    group = 'standard-personal'
    visibility = 'visible'
    access = [pscustomobject]@{ type = 'api-key'; apiKey = 'codefree-local' }
    api = [pscustomobject]@{ type = 'openai-chat-completions'; baseUrl = $ProxyBase }
    personalModelIds = $Models
    modelOrder = $Models
}
$providerRule = [pscustomobject]@{
    providerId = $ProviderId
    providerName = $ProviderName
    enabled = $true
    config = $providerConfig
}
$rules = @($root.config.providerConfigRules.providerRules | Where-Object { -not (Test-OurId $_) })
$rules += $providerRule
$root.config.providerConfigRules.providerRules = $rules

# 2) 模型规则（同 provider 覆盖）
$modelRules = @($root.config.modelConfigRules.providerModelRules | Where-Object { -not (Test-OurId $_) })
foreach ($m in $Models) {
    $modelRules += [pscustomobject]@{
        providerId = $ProviderId
        modelId = $m
        config = [pscustomobject]@{ enabled = $true }
    }
}
$root.config.modelConfigRules.providerModelRules = $modelRules

# 3) provider 顺序（追加到末尾，不破坏用户已有顺序）
$order = @()
if ($root.config.providerOrder) { $order = @($root.config.providerOrder | Where-Object { $_ -ne $ProviderId }) }
$order += $ProviderId
$root.config | Add-Member -NotePropertyName providerOrder -NotePropertyValue $order -Force

# 4) 默认模型：仅在用户尚未设置默认时设置，避免劫持
if (-not $root.config.defaultModelSelection) {
    $root.config | Add-Member -NotePropertyName defaultModelSelection -NotePropertyValue ([pscustomobject]@{
        providerId = $ProviderId
        modelId = $Models[0]
    }) -Force
    Write-Host "已设置默认模型：$ProviderId / $($Models[0])"
} else {
    Write-Host "保留原有默认模型：$($root.config.defaultModelSelection.providerId) / $($root.config.defaultModelSelection.modelId)"
}

Write-JsonFile $ConfigPath $root
Write-Host "已写入 ZCode Provider 配置：$ConfigPath"
Write-Host "Provider：$ProviderName ($ProviderId)"
Write-Host "BaseUrl ：$ProxyBase"
Write-Host "模型    ：$($Models -join ', ')"
Write-Host ""
Write-Host "提示：ZCode 桌面端如正在运行，请重启或刷新模型列表后，在模型选择器中选择「$ProviderName」。"
