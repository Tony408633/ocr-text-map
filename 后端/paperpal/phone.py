"""局域网 / 手机接入：地址发现、二维码、证书下载与 HTTPS 启动。

用法::

    python -m paperpal phone            # 生成证书并以 HTTPS 启动，手机可访问
    python -m paperpal phone --port 8443 --no-browser
"""

from __future__ import annotations

import ipaddress
import json
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import certs, config

DEFAULT_PHONE_PORT = 8443
DEFAULT_DIAGNOSTIC_PORT = 8080
PUBLIC_URL_FILENAME = "public_url.txt"
PORT_RULE_NAME = "PaperPal Phone TCP"
PROGRAM_RULE_NAME = "PaperPal Phone Program"

#: 诊断页实际监听的端口（0 = 没起来）
_diagnostic_port = 0


def _usable(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if ip.version != 4 or ip.is_loopback or ip.is_link_local or ip.is_multicast:
        return False
    # 198.18.0.0/15 是 Clash / VPN 常见 TUN 网段，手机连不上
    if ip in ipaddress.ip_network("198.18.0.0/15"):
        return False
    return True


def lan_addresses() -> list[dict[str, str]]:
    """返回本机可被手机访问的 IPv4 地址，按"最可能是 Wi-Fi"排序。"""
    found: list[str] = []
    # 1) 主机名解析：Windows 上通常覆盖所有网卡
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = item[4][0]
            if _usable(address) and address not in found:
                found.append(address)
    except OSError:
        pass
    # 2) 默认路由地址：一定存在且最可能是手机连的那张网卡
    default_address = None
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        default_address = probe.getsockname()[0]
    except OSError:
        default_address = None
    finally:
        probe.close()
    if default_address and _usable(default_address):
        found = [default_address] + [item for item in found if item != default_address]

    def score(address: str) -> tuple[int, str]:
        # 家用 Wi-Fi / 以太网常见网段优先
        if address.startswith("192.168."):
            rank = 0
        elif address.startswith("10."):
            rank = 1
        elif address.startswith("172."):
            rank = 2
        else:
            rank = 3
        return (rank, address)

    return [
        {"ip": address, "url_host": address, "label": _label(address)}
        for address in sorted(found, key=score)
    ]


def _label(address: str) -> str:
    if address.startswith("192.168."):
        return "家用 Wi-Fi / 路由器"
    if address.startswith("10."):
        return "公司或校园 Wi-Fi"
    if address.startswith("172."):
        return "虚拟网卡或热点"
    return "局域网"


def primary_lan_ip() -> str | None:
    items = lan_addresses()
    return items[0]["ip"] if items else None


# --------------------------------------------------------------------------- #
# 端口：被占用时自动往后找，避免"端口已被占住"这种卡死
# --------------------------------------------------------------------------- #


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError:
            return False
    return True


def pick_free_port(host: str, preferred: int, attempts: int = 40) -> int:
    """从 preferred 开始往后找一个能绑定的端口。"""
    for offset in range(attempts):
        candidate = preferred + offset
        if candidate > 65535:
            break
        if port_is_free(host, candidate):
            return candidate
    raise OSError(f"{host} 上 {preferred}–{preferred + attempts - 1} 都没有空闲端口。")



# --------------------------------------------------------------------------- #
# 公网隧道地址（cloudflared）：手机在校园网/蜂窝网络也能打开
# --------------------------------------------------------------------------- #


def public_url_file() -> Path:
    return config.data_dir() / PUBLIC_URL_FILENAME


def write_public_url(url: str) -> None:
    config.ensure_dirs()
    public_url_file().write_text(str(url).strip() + "\n", encoding="utf-8")


_public_url_cache: dict[str, float | str | None] = {"checked_at": 0.0, "value": None}


def _public_url_alive(url: str) -> bool:
    """隧道进程被强杀时文件会残留，这里探一下还活着没有（结果缓存 30 秒）。"""
    now = time.time()
    cached_at = float(_public_url_cache.get("checked_at") or 0)
    if now - cached_at < 30 and _public_url_cache.get("value") == url:
        return True
    if now - cached_at < 30 and _public_url_cache.get("value") is None:
        return False
    alive = False
    try:
        request = urllib.request.Request(url + "/api/health", headers={"User-Agent": "PaperPal/1.1"})
        with urllib.request.urlopen(request, timeout=4) as response:
            alive = response.status == 200
    except Exception:  # noqa: BLE001 - 连不上就当它失效
        alive = False
    _public_url_cache["checked_at"] = now
    _public_url_cache["value"] = url if alive else None
    return alive


def read_public_url(max_age: float = 12 * 3600) -> str | None:
    path = public_url_file()
    if not path.is_file():
        return None
    try:
        if time.time() - path.stat().st_mtime > max_age:
            return None
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not value.startswith("https://"):
        return None
    if not _public_url_alive(value):
        return None
    return value


def clear_public_url() -> None:
    try:
        public_url_file().unlink(missing_ok=True)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Windows 防火墙
# --------------------------------------------------------------------------- #


def _netsh(*args: str) -> str:
    try:
        result = subprocess.run(
            ["netsh", *args],
            capture_output=True,
            text=True,
            timeout=20,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return (result.stdout or "") + (result.stderr or "")


def firewall_status(port: int) -> dict:
    """查询是否已放行（不需要管理员权限）。"""
    text = _netsh("advfirewall", "firewall", "show", "rule", f"name={PORT_RULE_NAME}")
    port_rule = "Action:" in text and "Allow" in text and str(port) in text
    program_text = _netsh("advfirewall", "firewall", "show", "rule", f"name={PROGRAM_RULE_NAME}")
    program_rule = "Action:" in program_text and "Allow" in program_text
    return {
        "port_rule": port_rule,
        "program_rule": program_rule,
        "ok": bool(port_rule or program_rule),
    }


def firewall_script(port: int, python_exe: str | None = None) -> str:
    """给"以管理员身份运行"用的一小段命令，全部幂等。"""
    lines = [
        f'netsh advfirewall firewall delete rule name="{PORT_RULE_NAME}" >nul 2>&1',
        f'netsh advfirewall firewall add rule name="{PORT_RULE_NAME}" dir=in action=allow '
        f"protocol=TCP localport={port} profile=any",
    ]
    if python_exe:
        lines += [
            f'netsh advfirewall firewall delete rule name="{PROGRAM_RULE_NAME}" >nul 2>&1',
            f'netsh advfirewall firewall add rule name="{PROGRAM_RULE_NAME}" dir=in action=allow '
            f'program="{python_exe}" profile=any enable=yes',
        ]
    return "\n".join(lines)


def firewall_help(port: int, python_exe: str | None = None) -> str:
    return (
        "手机打不开最常见的原因是 Windows 防火墙拦截了入站连接。\n"
        "请以【管理员身份】打开 PowerShell，粘贴执行下面两行，然后重新启动手机测试：\n\n"
        + firewall_script(port, python_exe)
        + "\n"
    )


# --------------------------------------------------------------------------- #
# 诊断用的极简 HTTP 服务（不需要证书，用来区分"网络不通"还是"证书问题"）
# --------------------------------------------------------------------------- #

_DIAGNOSTIC_HTML = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>纸伴 · 网络自检</title>
<style>
body{{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
background:#f4f2ea;color:#1c2421;padding:28px 20px;line-height:1.6}}
.card{{background:#fff;border:1px solid #dfe3dd;border-radius:18px;padding:22px;max-width:520px;margin:0 auto}}
h1{{font-size:22px;margin:0 0 6px}}
.ok{{color:#0f6b58;font-weight:700;font-size:18px}}
a.btn{{display:block;text-align:center;background:#0f6b58;color:#fff;text-decoration:none;
padding:16px;border-radius:14px;font-size:18px;margin:18px 0 10px}}
code{{background:#eef1ec;padding:3px 6px;border-radius:6px;word-break:break-all}}
.tip{{color:#5a635f;font-size:14px}}
</style></head>
<body><div class="card">
<p class="ok">✅ 手机已经连上电脑</p>
<h1>网络是通的</h1>
<p>能看到这一页，说明 <b>手机 → 电脑</b> 的网络与防火墙都没问题。
接下来用 HTTPS 地址打开纸伴；第一次会提示证书不受信任，点「显示详细信息 → 访问此网站」。</p>
<a class="btn" href="{https_url}">打开纸伴（HTTPS）</a>
<p class="tip">HTTPS 地址：<code>{https_url}</code></p>
<p class="tip">如果点按钮后一直转圈，说明 443/8443 端口被网络限制，请改用电脑上的「启动手机隧道.bat」（公网 HTTPS，无需同网段）。</p>
<p class="tip">电脑 IP：{ip}　HTTPS 端口：{https_port}</p>
</div></body></html>
"""


class _DiagnosticHandler(BaseHTTPRequestHandler):
    https_port = DEFAULT_PHONE_PORT
    ip = ""

    def log_message(self, *_args):  # 安静一点
        return

    def do_GET(self):  # noqa: N802 - stdlib 约定
        if self.path.startswith("/ping"):
            body = b"pong"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        https_url = f"https://{self.ip}:{self.https_port}"
        html = _DIAGNOSTIC_HTML.format(
            https_url=https_url, ip=self.ip or "电脑IP", https_port=self.https_port
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(html)


def start_diagnostic_server(
    https_port: int,
    *,
    host: str = "0.0.0.0",
    port: int | None = None,
) -> ThreadingHTTPServer | None:
    """在另一个端口起一个免证书的小页面，用来定位"手机打不开"的原因。

    8080 经常被代理 / 其它软件占用，所以按 8080 → 8081 → 8088 → 8098 依次尝试。
    """
    global _diagnostic_port
    ip = primary_lan_ip() or "127.0.0.1"
    handler = type("Handler", (_DiagnosticHandler,), {"https_port": https_port, "ip": ip})
    candidates = [port] if port else [DEFAULT_DIAGNOSTIC_PORT, 8081, 8088, 8098]
    for candidate in candidates:
        try:
            server = ThreadingHTTPServer((host, candidate), handler)
        except OSError:
            continue
        _diagnostic_port = candidate
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server
    _diagnostic_port = 0
    return None


def diagnostic_port() -> int:
    """诊断页实际监听的端口（0 表示没起来）。"""
    return _diagnostic_port



def _hostnames() -> list[str]:
    names = ["localhost", "127.0.0.1"]
    try:
        host = socket.gethostname()
        if host:
            names.append(host)
    except OSError:
        pass
    for item in lan_addresses():
        names.append(item["ip"])
    return names


def ensure_certificates() -> certs.CertBundle:
    """确保当前局域网地址在证书里，返回证书包。"""
    return certs.ensure_certs(_hostnames())


def qr_svg(text: str, *, scale: int = 5, border: int = 2) -> str | None:
    """生成内联 SVG 二维码；没有 segno 时返回 None（前端会退回纯文字引导）。"""
    try:
        import segno
    except ImportError:
        return None
    try:
        code = segno.make_qr(text, error="m")
        # light=None 表示透明背景，深色模式也能正常显示
        return code.svg_inline(scale=scale, border=border, dark="#0d1117", light=None, omitsize=True)
    except Exception:  # pragma: no cover - segno 版本差异
        try:
            code = segno.make_qr(text, error="m")
            return code.svg_inline(scale=scale, border=border)
        except Exception:
            return None


def phone_payload(
    *,
    scheme: str,
    host: str,
    port: int,
    secure_context: bool,
    auth_required: bool,
) -> dict:
    """给前端"手机连接"页用的数据。"""
    bundle = ensure_certificates()
    addresses = lan_addresses()
    lan_ip = addresses[0]["ip"] if addresses else None
    # 443/8443 之外的端口要带端口号；隧道地址自带端口
    port_part = "" if port in (80, 443) else f":{port}"
    urls = []
    for item in addresses:
        url = f"{scheme}://{item['ip']}{port_part}"
        urls.append({"url": url, "label": item["label"], "ip": item["ip"]})

    public = read_public_url()
    if public:
        mode = "tunnel"
        primary = public
        # 公网模式下局域网地址与诊断端口没有意义，避免把错误地址显示给用户
        urls = []
        diagnostic = None
        firewall = {"ok": True, "skipped": True}
    elif lan_ip:
        mode = "lan"
        primary = f"{scheme}://{lan_ip}{port_part}"
        active = diagnostic_port()
        diagnostic = f"http://{lan_ip}:{active}" if active else None
        firewall = firewall_status(port)
    else:
        mode = "local"
        primary = f"{scheme}://{host}{port_part}"
        diagnostic = None
        firewall = firewall_status(port)

    return {
        "mode": mode,
        "server": {"scheme": scheme, "host": host, "port": port, "https": scheme == "https"},
        "secure_context": secure_context or mode == "tunnel",
        "lan_ip": lan_ip,
        "urls": urls,
        "primary_url": primary,
        "qr_target": primary,
        "qr_svg": qr_svg(primary, scale=5, border=1),
        "diagnostic_url": diagnostic,
        "public_url": public,
        "access": {
            "mode": mode,
            "lan_urls": urls,
            "diagnostic_url": diagnostic,
            "public_url": public,
            "firewall": firewall,
        },
        "certificate": {
            "ca_url": "/paperpal-ca.crt",
            "profile_url": "/paperpal.mobileconfig",
            "fingerprint": bundle.fingerprint,
            "hosts": bundle.hosts,
        },
        "auth_required": auth_required,
        "steps": _steps(mode=mode, secure_context=secure_context, scheme=scheme, primary=primary),
    }


def _steps(*, mode: str, secure_context: bool, scheme: str, primary: str) -> list[dict[str, str]]:
    if mode == "tunnel":
        return [
            {
                "title": "直接扫码打开",
                "text": "这是公网 HTTPS 地址，手机用 4G/5G 或任意 Wi-Fi 都能打开，不用装证书、不用同一网段。",
            },
            {
                "title": "添加到主屏幕",
                "text": "Safari 分享菜单 → 添加到主屏幕，就能像 App 一样全屏打开，相机和麦克风都可用。",
            },
            {
                "title": "连蓝牙耳机",
                "text": "耳机用系统蓝牙配对，然后在「设备测试台」点一次“启用耳机按键”，用耳机键翻行、暂停。",
            },
            {
                "title": "地址会变",
                "text": "临时隧道地址每次重启都会变；以电脑上显示的二维码为准，不要在手机上收藏旧地址。",
            },
        ]
    if scheme == "https":
        return [
            {"title": "同一个 Wi-Fi", "text": "让手机和电脑连同一个 Wi-Fi（或电脑开热点给手机连）。"},
            {
                "title": "安装证书（只需一次）",
                "text": "在手机上打开本页，点“下载证书描述文件”，按提示安装，然后在 设置 → 通用 → 关于本机 → 证书信任设置 里打开完全信任。",
            },
            {"title": "扫码打开", "text": f"用手机相机扫右边的二维码，或直接输入 {primary}"},
            {
                "title": "打不开怎么办",
                "text": "先试「诊断网址」，能看到“网络是通的”就说明是证书问题；看不到就说明防火墙或 Wi-Fi 隔离，改用「启动手机隧道.bat」。",
            },
        ]
    return [
        {"title": "同一个 Wi-Fi", "text": "让手机和电脑连同一个 Wi-Fi。"},
        {
            "title": "改用 HTTPS 启动",
            "text": "当前是 HTTP：可以阅读和写批注，但 iPhone 会禁止相机、离线缓存和安装。请在电脑上运行 启动手机测试.bat，或直接用 启动手机隧道.bat。",
        },
        {
            "title": "先扫码试试",
            "text": f"用手机相机扫二维码打开 {primary}；如果需要拍照扫描，请改用 HTTPS 启动。",
        },
    ]



def add_firewall_rule(port: int) -> tuple[bool, str]:
    """尝试放行端口（需要管理员权限），失败时返回可读提示。"""
    name = f"PaperPal Phone {port}"
    script = (
        f"New-NetFirewallRule -DisplayName '{name}' -Direction Inbound -Action Allow "
        f"-Protocol TCP -LocalPort {port} -Profile Private,Domain -ErrorAction Stop | Out-Null"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"无法调用防火墙命令：{exc}"
    if result.returncode == 0:
        return True, f"已在 Windows 防火墙放行 TCP {port}（专用网络）。"
    detail = (result.stderr or result.stdout or "").strip().splitlines()
    message = detail[-1] if detail else "未知错误"
    return False, (
        f"自动放行失败（通常是没有管理员权限）：{message}\n"
        f"可以手动在“Windows 安全中心 → 防火墙 → 高级设置 → 入站规则”放行 TCP {port}。"
    )


def start_https(host: str, port: int, *, open_browser: bool = True) -> int:
    bundle = ensure_certificates()
    try:
        import uvicorn
    except ImportError:
        print("缺少 Web 依赖，请先安装 requirements.txt。", file=sys.stderr)
        return 1
    from . import config

    config.ensure_dirs()
    # 局域网模式启动时，清理上一次隧道留下的公网地址，避免二维码指向旧隧道
    clear_public_url()
    preferred_port = port
    try:
        port = pick_free_port(host, preferred_port)
    except OSError as exc:
        print(f"找不到空闲端口：{exc}", file=sys.stderr)
        return 1
    if port != preferred_port:
        print(f"端口 {preferred_port} 被占用，已改用 {port}。")
    lan = primary_lan_ip()
    diagnostic = start_diagnostic_server(port)
    firewall = firewall_status(port)
    print()
    print("纸伴 · 手机测试模式（局域网 HTTPS）")
    print("=" * 52)
    if lan:
        print(f"  手机打开： https://{lan}:{port}")
    print(f"  本机打开： https://127.0.0.1:{port}")
    if diagnostic:
        print(f"  网络自检： http://{lan or '127.0.0.1'}:{diagnostic_port()}（手机能打开=网络通）")
    print(f"  证书指纹： {bundle.fingerprint}")
    print("-" * 52)
    if firewall.get("ok"):
        print("  防火墙：已放行（Python 程序或端口规则存在）")
    else:
        print("  防火墙：未确认放行！这通常是手机一直转圈的原因。")
        print("  请以管理员身份运行一次 后端\\start-phone.ps1，或按下面命令放行：")
        print("    " + firewall_script(port, sys.executable).replace("\n", "\n    "))
    print("-" * 52)
    print("  第一次在手机上打开会提示证书不受信任：")
    print("    点“显示详细信息 → 访问此网站”，或在电脑上打开 /phone 页面扫码安装证书。")
    print("  如果手机一直转圈打不开，请改用 启动手机隧道.bat（公网 HTTPS，不受校园网限速/隔离影响）。")
    print("=" * 52)
    print("按 Ctrl+C 停止。")
    print()
    if open_browser:
        try:
            import webbrowser

            webbrowser.open(f"https://127.0.0.1:{port}/#/phone")
        except Exception:  # pragma: no cover - 浏览器不可用
            pass
    uvicorn.run(
        "paperpal.api:app",
        host=host,
        port=port,
        ssl_certfile=str(certs.server_cert_file()),
        ssl_keyfile=str(certs.server_key_file()),
    )
    return 0


def certificate_files() -> tuple[Path, Path, Path]:
    bundle = ensure_certificates()
    directory = certs.certs_dir()
    (directory / "ca.crt").write_text(bundle.ca_cert_pem, encoding="ascii")
    (directory / "paperpal-ca.der").write_bytes(bundle.ca_der)
    (directory / "paperpal.mobileconfig").write_bytes(certs.mobileconfig(bundle))
    return directory / "ca.crt", directory / "paperpal-ca.der", directory / "paperpal.mobileconfig"
