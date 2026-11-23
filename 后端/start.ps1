param(
    [string]$BindAddress = "127.0.0.1",
    [int]$Port = 8000,
    [switch]$Reload
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectHome = Split-Path -Parent $projectRoot
$url = "http://{0}:{1}" -f $BindAddress, $Port

# 如果已经有纸伴在运行，直接打开页面，避免重复启动或端口冲突。
$running = $false
$client = $null
try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect("127.0.0.1", $Port)
    $running = $client.Connected
}
catch {
    $running = $false
}
finally {
    if ($client) { $client.Close() }
}
if ($running) {
    Write-Host "纸伴已经在运行：$url" -ForegroundColor Green
    try { Start-Process $url } catch { Write-Host "请手动在浏览器打开：$url" }
    return
}

$shortcutPath = Join-Path $projectHome "Python 3.12 (64-bit).lnk"
$userPython = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
$basePython = $null

if ($pythonCommand) {
    $basePython = $pythonCommand.Source
}
elseif (Test-Path -LiteralPath $userPython) {
    $basePython = $userPython
}
elseif (Test-Path -LiteralPath $shortcutPath) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if (Test-Path -LiteralPath $shortcut.TargetPath) {
        $basePython = $shortcut.TargetPath
    }
}

if (-not $basePython) {
    throw "没有找到 Python。请把 Python 3.10–3.12 安装目录加入 PATH，或在工作区放入指向 python.exe 的快捷方式。"
}

# 本机已经安装好的运行环境（可选）：直接使用，省去创建虚拟环境。
$runtimeDeps = Join-Path $projectHome ".runtime\deps"
$pythonVersion = & $basePython -c "import sys; print(str(sys.version_info.major) + '.' + str(sys.version_info.minor))"
if ($pythonVersion -eq "3.12" -and (Test-Path -LiteralPath (Join-Path $runtimeDeps "fastapi"))) {
    $env:PYTHONPATH = "$runtimeDeps;$projectRoot"
    Set-Location $projectRoot
    Write-Host ""
    Write-Host "纸伴已启动：$url" -ForegroundColor Green
    Write-Host "API 文档：$url/docs    服务状态：$url/api/v1/health" -ForegroundColor DarkGray
    Write-Host "按 Ctrl+C 停止服务。" -ForegroundColor DarkGray
    Write-Host ""
    $serveArgs = @("-m", "paperpal", "serve", "--host", $BindAddress, "--port", "$Port")
    if ($Reload) { $serveArgs += "--reload" }
    & $basePython @serveArgs
    return
}

$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "正在创建 Python 虚拟环境…" -ForegroundColor Cyan
    & $basePython -m venv (Join-Path $projectRoot ".venv")
    if ($LASTEXITCODE -ne 0) { throw "创建 Python 虚拟环境失败。" }
}

Write-Host "正在检查并安装依赖（首次需要几分钟）…" -ForegroundColor Cyan
& $venvPython -m pip install -r (Join-Path $projectRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Python 依赖安装失败。" }

Set-Location $projectRoot
$url = "http://{0}:{1}" -f $BindAddress, $Port
Write-Host ""
Write-Host "纸伴已启动：$url" -ForegroundColor Green
Write-Host "API 文档：$url/docs    服务状态：$url/api/v1/health" -ForegroundColor DarkGray
Write-Host "按 Ctrl+C 停止服务。" -ForegroundColor DarkGray
Write-Host ""

$serveArgs = @("-m", "paperpal", "serve", "--host", $BindAddress, "--port", "$Port")
if ($Reload) { $serveArgs += "--reload" }
& $venvPython @serveArgs
