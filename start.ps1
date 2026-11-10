# 启动 CodeFree-O OpenAI 兼容代理（Windows PowerShell 5.1+ / PowerShell 7+）
# 用法：  .\start.ps1            # 前台运行
#         .\start.ps1 -Check     # 只做自检（刷新 token、拉模型、查额度）
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '未找到 node，请先安装 Node.js 20+'
}

$nodeVersion = (node -v) -replace '^v', ''
if ([int]([version]$nodeVersion).Major -lt 20) {
    throw "当前 Node 版本 $nodeVersion 过低，需要 20+（内置 fetch）"
}

if ($Check) {
    node server.mjs --check
} else {
    node server.mjs
}
