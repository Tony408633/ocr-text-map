param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$Upstream = "Livia-W/ocr-text-map",
    [string]$RepoName = "ocr-text-map",
    [switch]$SkipFork,
    [switch]$Private,
    [string]$Message = "feat: 纸伴 PaperPal — 语音优先的盲人纸书阅读伙伴"
)

# 一键：fork 上游仓库 → 推送本项目 → 打开 GitHub Pages（/docs 目录）
#
# 用法：
#   .\tools\publish_to_github.ps1 -Token ghp_xxxxxxxx
#   $env:GITHUB_TOKEN = "ghp_..."; .\tools\publish_to_github.ps1 -Token $env:GITHUB_TOKEN
#
# Token 至少需要 repo 权限（勾选 public_repo 即可）。脚本只在本次推送时使用，
# 推送完会把 origin 改回不带 token 的地址。

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $projectRoot

function Get-Git {
    $candidate = Join-Path $projectRoot ".runtime\tools\git\cmd\git.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    $command = Get-Command git -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    throw "找不到 git。可以运行 tools\publish_to_github.ps1 前先安装 Git，或用项目里的便携版。"
}

$git = Get-Git
$headers = @{
    Authorization          = "Bearer $Token"
    "User-Agent"           = "PaperPal-Publisher"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
}
$api = "https://api.github.com"

Write-Host "1/5 验证 GitHub 账号…" -ForegroundColor Cyan
$me = Invoke-RestMethod -Uri "$api/user" -Headers $headers -Method Get
$login = $me.login
Write-Host "    已登录：$login" -ForegroundColor Green

Write-Host "2/5 准备 fork：$Upstream → $login/$RepoName" -ForegroundColor Cyan
$forkReady = $false
if (-not $SkipFork) {
    try {
        $existing = Invoke-RestMethod -Uri "$api/repos/$login/$RepoName" -Headers $headers -Method Get
        $forkReady = $true
        Write-Host "    已经存在同名仓库，直接复用。" -ForegroundColor Yellow
    } catch {
        $body = @{ name = $RepoName; default_branch_only = $false } | ConvertTo-Json
        $null = Invoke-RestMethod -Uri "$api/repos/$Upstream/forks" -Headers $headers -Method Post -Body $body -ContentType "application/json"
        Write-Host "    已发起 fork，等待 GitHub 创建…"
    }
} else {
    $forkReady = $true
}

if (-not $forkReady) {
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        try {
            $null = Invoke-RestMethod -Uri "$api/repos/$login/$RepoName" -Headers $headers -Method Get
            $forkReady = $true
            break
        } catch {
            Write-Host "    还没好，继续等（$i）…"
        }
    }
}
if (-not $forkReady) { throw "fork 创建超时，请到 GitHub 网页确认后再用 -SkipFork 重试。" }

Write-Host "3/5 推送代码（force 覆盖 fork 的 main）…" -ForegroundColor Cyan
$remoteWithToken = "https://x-access-token:$Token@github.com/$login/$RepoName.git"
& $git remote remove origin 2>$null
& $git remote add origin $remoteWithToken
& $git push --force origin main
if ($LASTEXITCODE -ne 0) { throw "推送失败：检查 token 是否有 repo 权限，或网络是否能访问 github.com。" }
& $git remote set-url origin "https://github.com/$login/$RepoName.git"

Write-Host "4/5 打开 GitHub Pages（main / docs）…" -ForegroundColor Cyan
$pagesBody = @{ source = @{ branch = "main"; path = "/docs" } } | ConvertTo-Json -Depth 5
$pagesUrl = $null
try {
    $pages = Invoke-RestMethod -Uri "$api/repos/$login/$RepoName/pages" -Headers $headers -Method Post -Body $pagesBody -ContentType "application/json"
    $pagesUrl = $pages.html_url
} catch {
    try {
        $pages = Invoke-RestMethod -Uri "$api/repos/$login/$RepoName/pages" -Headers $headers -Method Put -Body $pagesBody -ContentType "application/json"
        $pagesUrl = $pages.html_url
    } catch {
        Write-Host "    自动开启 Pages 失败（可能需要在仓库 Settings → Pages 手动选 main /docs）。" -ForegroundColor Yellow
        Write-Host "    $($_.Exception.Message)" -ForegroundColor DarkGray
    }
}
if (-not $pagesUrl) { $pagesUrl = "https://$login.github.io/$RepoName/" }

Write-Host "5/5 触发一次 Pages 构建…" -ForegroundColor Cyan
try {
    $null = Invoke-RestMethod -Uri "$api/repos/$login/$RepoName/pages/builds" -Headers $headers -Method Post -Body "{}" -ContentType "application/json"
} catch {
    Write-Host "    （首次构建由 GitHub 自动触发，忽略此提示）" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "完成！" -ForegroundColor Green
Write-Host "  仓库：https://github.com/$login/$RepoName"
Write-Host "  页面：$pagesUrl" -ForegroundColor Cyan
Write-Host "  Pages 首次生效通常需要 1–2 分钟；若 404，等待后刷新。" -ForegroundColor DarkGray
Write-Host "  提示：token 已从 origin 地址移除，但建议在 GitHub 设置里定期轮换。" -ForegroundColor DarkGray
