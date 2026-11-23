param(
    [int]$Port = 8900,
    [switch]$NoBrowser
)

# 纸伴 · 公网隧道模式
# 用 Cloudflare 临时隧道给手机一个公网 HTTPS 地址：
#   * 手机用 4G/5G 或任意 Wi-Fi 都能打开；
#   * 不需要装证书、不需要同一个网段、不受校园网客户端隔离影响；
#   * 相机、麦克风、添加到主屏幕全部可用，因为证书是公网受信任的。
#
# 本机端口（默认 8900）如果被上一次没关掉的纸伴占用，会自动往后找一个空闲端口，
# 不会再出现“端口已被占住”启动不了的情况。

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path   # 后端/
$projectHome = Split-Path -Parent $projectRoot                  # 项目根目录

function Find-Python {
    $command = Get-Command python -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
        (Join-Path $env:ProgramFiles "Python312\python.exe")
    )
    foreach ($path in $candidates) {
        if ($path -and (Test-Path -LiteralPath $path)) { return $path }
    }
    throw "没有找到 Python。请安装 Python 3.10–3.12 并勾选 Add to PATH。"
}

$python = Find-Python
$version = & $python -c "import sys; print(str(sys.version_info.major) + '.' + str(sys.version_info.minor))"
$runtimeDeps = Join-Path $projectHome ".runtime\deps"
$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"

if ((Test-Path -LiteralPath (Join-Path $runtimeDeps "fastapi")) -and $version -eq "3.12") {
    $env:PYTHONPATH = "$runtimeDeps;$projectRoot"
    $servePython = $python
} elseif (Test-Path -LiteralPath $venvPython) {
    $servePython = $venvPython
} else {
    Write-Host "还没有安装依赖。先运行一次 后端\start.ps1 完成安装，再回来启动隧道。" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "纸伴 · 公网隧道模式" -ForegroundColor Green
Write-Host "  手机用 4G/5G 也能打开，不需要装证书、不需要同一个 Wi-Fi。" -ForegroundColor DarkGray
Write-Host "  第一次运行会自动下载 cloudflared（约 55 MB），之后不用再下。" -ForegroundColor DarkGray
Write-Host "  隧道地址是临时的：每次重启都会换一个新的，以二维码为准。" -ForegroundColor DarkGray
Write-Host "  本机端口被占用时会自动换端口（默认 8900 起）。" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  如果卡住不动，多半是上一次的纸伴没关：在任务管理器结束 python.exe 后重试。" -ForegroundColor DarkGray
Write-Host ""

$serveArgs = @("-m", "paperpal", "tunnel", "--port", "$Port")
if ($NoBrowser) { $serveArgs += "--no-browser" }

Push-Location $projectRoot
try {
    & $servePython @serveArgs
} finally {
    Pop-Location
}
