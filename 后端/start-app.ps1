param(
    [switch]$Browser
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectHome = Split-Path -Parent $projectRoot
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
    throw "没有找到 Python。请安装 Python 3.10–3.12，或把 python.exe 加入 PATH。"
}

Set-Location $projectRoot
$desktopArgs = @("-m", "paperpal", "desktop")
if ($Browser) { $desktopArgs += @("--backend", "browser") }

Write-Host "正在启动纸伴桌面 App…" -ForegroundColor Cyan
Write-Host "关闭应用窗口即可退出；终端窗口可以留着。" -ForegroundColor DarkGray

# 已经准备好的运行环境（本项目当前机器可直接使用）。
$runtimeDeps = Join-Path $projectHome ".runtime\deps"
$pythonVersion = & $basePython -c "import sys; print(str(sys.version_info.major) + '.' + str(sys.version_info.minor))"
if ($pythonVersion -eq "3.12" -and (Test-Path -LiteralPath (Join-Path $runtimeDeps "fastapi"))) {
    $env:PYTHONPATH = "$runtimeDeps;$projectRoot"
    & $basePython @desktopArgs
    exit $LASTEXITCODE
}

# 标准安装路径：创建虚拟环境并安装桌面依赖。
$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host "正在创建 Python 虚拟环境…" -ForegroundColor Cyan
    & $basePython -m venv (Join-Path $projectRoot ".venv")
    if ($LASTEXITCODE -ne 0) { throw "创建 Python 虚拟环境失败。" }
}

Write-Host "正在安装桌面窗口依赖（首次需要几分钟）…" -ForegroundColor Cyan
& $venvPython -m pip install -r (Join-Path $projectRoot "requirements-desktop.txt")
if ($LASTEXITCODE -ne 0) { throw "桌面依赖安装失败。" }

$env:PYTHONPATH = $projectRoot
& $venvPython @desktopArgs
exit $LASTEXITCODE
