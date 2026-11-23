param(
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$addresses = @()
try {
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -and $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
        Select-Object -ExpandProperty IPAddress -Unique
} catch {
    $addresses = @()
}
$ip = ($addresses | Select-Object -First 1)
if (-not $ip) {
    $line = ipconfig | Select-String 'IPv4' | Select-Object -First 1
    if ($line -and ($line.Line -match '(\d{1,3}(?:\.\d{1,3}){3})')) {
        $ip = $Matches[1]
    }
}
if (-not $ip) { $ip = "电脑局域网IP" }

Write-Host ""
Write-Host "纸伴 · 手机 / iPhone 局域网访问（HTTP 模式）" -ForegroundColor Green
Write-Host "1. 让手机和电脑连接同一个 Wi-Fi。"
Write-Host "2. 在 iPhone Safari 打开：http://${ip}:${Port}" -ForegroundColor Cyan
Write-Host ""
Write-Host "注意：HTTP 模式下 iPhone 会禁止相机、麦克风和离线安装。" -ForegroundColor Yellow
Write-Host "      要拍照扫描书页，请改用手机测试模式（HTTPS），或直接双击：启动手机测试.bat" -ForegroundColor Yellow
Write-Host "      它会自动生成证书、显示二维码，并提供一键安装的 iOS 描述文件。" -ForegroundColor DarkGray
Write-Host "3. 如果 Windows 防火墙询问，请允许专用网络访问。" -ForegroundColor DarkGray
Write-Host ""

& (Join-Path $projectRoot "start.ps1") -BindAddress "0.0.0.0" -Port $Port
