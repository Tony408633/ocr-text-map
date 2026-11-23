param(
    [int]$Port = 8443,
    [int]$DiagnosticPort = 8080,
    [switch]$NoBrowser,
    [switch]$SkipFirewall
)

# 纸伴 · 手机测试模式（局域网 HTTPS）
# 会自动：检查 Python、放行 Windows 防火墙（需要时会弹一次 UAC）、生成证书、
# 启动诊断端口 8080，并打开带二维码的「用手机打开」页面。

$ErrorActionPreference = "Continue"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path   # 后端/
$projectHome = Split-Path -Parent $projectRoot                  # 项目根目录
$portRuleName = "PaperPal Phone TCP"
$programRuleName = "PaperPal Phone Program"

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

function Get-LanIp {
    $addresses = @()
    try {
        $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object {
                $_.IPAddress -and
                $_.IPAddress -notmatch '^(127\.|169\.254\.|198\.1[89]\.)'
            } |
            Select-Object -ExpandProperty IPAddress -Unique
    } catch {
        $addresses = @()
    }
    if (-not $addresses) {
        $collected = @()
        foreach ($line in (ipconfig | Select-String -Pattern 'IPv4')) {
            if ($line.Line -match '(\d{1,3}(?:\.\d{1,3}){3})') {
                $candidate = $Matches[1]
                if ($candidate -notmatch '^(127\.|169\.254\.|198\.1[89]\.)') {
                    $collected += $candidate
                }
            }
        }
        $addresses = $collected | Select-Object -Unique
    }
    $addresses = @($addresses)
    if ($addresses.Count -gt 0) {
        $preferred = $addresses | Where-Object { $_ -like '192.168.*' } | Select-Object -First 1
        if ($preferred) { return $preferred }
        $preferred = $addresses | Where-Object { $_ -like '10.*' } | Select-Object -First 1
        if ($preferred) { return $preferred }
        return ($addresses | Select-Object -First 1)
    }
    return $null
}

function Test-PortBusy([int]$port) {
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect("127.0.0.1", $port)
        return $client.Connected
    } catch {
        return $false
    } finally {
        if ($client) { $client.Close() }
    }
}

function Get-FirewallState([int]$port) {
    $text = (netsh advfirewall firewall show rule name="$portRuleName" 2>&1) -join "`n"
    $portRule = ($text -match 'Allow|允许') -and ($text -match "$port")
    $programText = (netsh advfirewall firewall show rule name="$programRuleName" 2>&1) -join "`n"
    $programRule = ($programText -match 'Allow|允许')
    return [pscustomobject]@{
        PortRule    = [bool]$portRule
        ProgramRule = [bool]$programRule
        Ok          = [bool]($portRule -or $programRule)
    }
}

function Set-FirewallRules([int]$port, [string]$pythonExe) {
    $lines = @(
        "netsh advfirewall firewall delete rule name=`"$portRuleName`" | Out-Null",
        "netsh advfirewall firewall add rule name=`"$portRuleName`" dir=in action=allow protocol=TCP localport=$port profile=any",
        "netsh advfirewall firewall delete rule name=`"$programRuleName`" | Out-Null",
        "netsh advfirewall firewall add rule name=`"$programRuleName`" dir=in action=allow program=`"$pythonExe`" profile=any enable=yes"
    )
    $scriptPath = Join-Path $env:TEMP "paperpal-firewall.ps1"
    Set-Content -LiteralPath $scriptPath -Value $lines -Encoding UTF8
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Host ""
        Write-Host "手机要访问电脑，需要在 Windows 防火墙放行一次（会弹出一个 UAC 窗口，请点“是”）。" -ForegroundColor Yellow
        try {
            Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -ArgumentList @(
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath
            )
        } catch {
            Write-Host "没有获得管理员权限，防火墙未放行。" -ForegroundColor Red
            return $false
        }
    } else {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath
    }
    Start-Sleep -Milliseconds 400
    return (Get-FirewallState $port).Ok
}

$python = Find-Python
$version = & $python -c "import sys; print(str(sys.version_info.major) + '.' + str(sys.version_info.minor))"
if ($version -notin @("3.10", "3.11", "3.12")) {
    Write-Host "当前 Python 版本是 $version，纸伴需要 3.10–3.12。" -ForegroundColor Yellow
}

$runtimeDeps = Join-Path $projectHome ".runtime\deps"
$venvPython = Join-Path $projectRoot ".venv\Scripts\python.exe"

if ((Test-Path -LiteralPath (Join-Path $runtimeDeps "fastapi")) -and $version -eq "3.12") {
    $env:PYTHONPATH = "$runtimeDeps;$projectRoot"
    $servePython = $python
} elseif (Test-Path -LiteralPath $venvPython) {
    $servePython = $venvPython
} else {
    Write-Host "还没有安装依赖。先运行一次 后端\start.ps1 完成安装，再回来启动手机测试。" -ForegroundColor Yellow
    Write-Host "正在尝试创建虚拟环境并安装依赖（首次需要几分钟）…" -ForegroundColor Cyan
    & $python -m venv (Join-Path $projectRoot ".venv")
    & $venvPython -m pip install -r (Join-Path $projectRoot "requirements.txt")
    $servePython = $venvPython
}

$existing = $null
if (Test-PortBusy $Port) {
    # 端口被占用：看占用者是不是 python（大概率是上一次没关掉的纸伴）
    $listener = netstat -ano | Select-String ":$Port\s+.*LISTENING" | Select-Object -First 1
    if ($listener) {
        $ownerId = ($listener.Line -split '\s+')[-1]
        $owner = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
        if ($owner -and $owner.ProcessName -like 'python*') {
            $existing = "python"
        }
    }
}

if ($existing) {
    $ip = Get-LanIp
    Write-Host ""
    Write-Host "纸伴已经在运行（端口 $Port 被上一次的窗口占用）。" -ForegroundColor Green
    if ($ip) { Write-Host "手机打开：https://${ip}:$Port" -ForegroundColor Cyan }
    Write-Host "如果页面不是最新的，请先关闭那个纸伴窗口（任务管理器里结束 python.exe）再运行本脚本。" -ForegroundColor DarkGray
    Write-Host "也可以换端口：.\后端\start-phone.ps1 -Port 8444" -ForegroundColor DarkGray
    if (-not $NoBrowser) { try { Start-Process "https://127.0.0.1:$Port/#/phone" } catch {} }
    exit 0
}

if (-not $SkipFirewall) {
    $state = Get-FirewallState $Port
    $detail = @()
    if ($state.PortRule) { $detail += "端口规则" }
    if ($state.ProgramRule) { $detail += "程序规则" }
    if ($state.Ok) {
        Write-Host "防火墙：已放行（$($detail -join '、')）" -ForegroundColor Green
    } else {
        Write-Host "防火墙：未放行，手机很可能会一直转圈。正在尝试放行…" -ForegroundColor Yellow
        $ok = Set-FirewallRules $Port $servePython
        if ($ok) {
            Write-Host "防火墙：已放行。" -ForegroundColor Green
        } else {
            Write-Host "防火墙：仍未放行。请用管理员身份打开 PowerShell 执行：" -ForegroundColor Red
            Write-Host "  netsh advfirewall firewall add rule name=`"$portRuleName`" dir=in action=allow protocol=TCP localport=$Port profile=any" -ForegroundColor DarkGray
            Write-Host "  netsh advfirewall firewall add rule name=`"$programRuleName`" dir=in action=allow program=`"$servePython`" profile=any enable=yes" -ForegroundColor DarkGray
            Write-Host "或者直接改用 启动手机隧道.bat（公网 HTTPS，不需要防火墙和同一网段）。" -ForegroundColor Yellow
        }
    }
}

$ip = Get-LanIp
Write-Host ""
Write-Host "纸伴 · 手机测试模式（局域网 HTTPS）" -ForegroundColor Green
Write-Host "  端口：$Port　诊断端口：$DiagnosticPort"
if ($ip) {
    Write-Host "  手机打开：https://${ip}:$Port" -ForegroundColor Cyan
    Write-Host "  网络自检：http://${ip}:$DiagnosticPort （手机能打开=网络通）" -ForegroundColor DarkGray
} else {
    Write-Host "  没有检测到局域网地址：请先让电脑连上 Wi-Fi。" -ForegroundColor Yellow
}
Write-Host "  第一次在手机上打开会提示证书不受信任，装一次描述文件即可。" -ForegroundColor DarkGray
Write-Host "  如果一直转圈：关掉电脑上的代理/VPN，或改用 启动手机隧道.bat。" -ForegroundColor DarkGray
Write-Host "  按 Ctrl+C 停止服务。" -ForegroundColor DarkGray
Write-Host ""

$serveArgs = @("-m", "paperpal", "phone", "--port", "$Port")
if ($NoBrowser) { $serveArgs += "--no-browser" }

Push-Location $projectRoot
try {
    & $servePython @serveArgs
} finally {
    Pop-Location
}
