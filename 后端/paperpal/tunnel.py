"""公网隧道模式：让手机在任意网络（校园网、4G/5G）都能打开纸伴。

校园网/公共 Wi-Fi 常有客户端隔离，手机即使和电脑连同一个 Wi-Fi 也访问不到电脑；
iPhone 又必须 HTTPS 才能用相机。这里用 Cloudflare 的临时隧道解决两个问题：

* 公网 HTTPS 地址，证书由 Cloudflare 签发，手机**不需要安装任何证书**；
* 不需要同一网段，手机用流量也能打开。

用法::

    python -m paperpal tunnel                 # 默认本机 8899 + 临时隧道
    python -m paperpal tunnel --port 8899 --no-browser
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from . import config, phone

CLOUDFLARED_URL = (
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
)
URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
STARTUP_TIMEOUT = 75


def tools_dir() -> Path:
    return config.PROJECT_ROOT / "tools"


def cloudflared_path() -> Path:
    return tools_dir() / "cloudflared.exe"


def ensure_cloudflared() -> Path:
    """没有就下载一份（约 55 MB，放在 后端/tools/）。"""
    path = cloudflared_path()
    if path.is_file() and path.stat().st_size > 1_000_000:
        return path
    tools_dir().mkdir(parents=True, exist_ok=True)
    print(f"正在下载 cloudflared（约 55 MB，只需一次）…\n  来源：{CLOUDFLARED_URL}")
    request = urllib.request.Request(CLOUDFLARED_URL, headers={"User-Agent": "PaperPal/1.1"})
    with urllib.request.urlopen(request, timeout=120) as response:
        total = int(response.headers.get("Content-Length") or 0)
        written = 0
        last_report = 0
        temporary = path.with_suffix(".part")
        with open(temporary, "wb") as handle:
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                handle.write(chunk)
                written += len(chunk)
                if total:
                    percent = int(written * 100 / total)
                    if percent >= last_report + 10:
                        last_report = percent
                        print(f"  已下载 {percent}%")
                else:
                    print(f"  已下载 {written // (1024 * 1024)} MB", end="\r")
    temporary.replace(path)
    print(f"已保存：{path}")
    return path


def _wait_for_server(port: int, timeout: float = 40.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as response:
                if response.status == 200:
                    return True
        except Exception:  # noqa: BLE001 - 启动中会一直失败
            time.sleep(0.4)
    return False


def _pump(process: subprocess.Popen, lines: list[str]) -> None:
    """持续读取 cloudflared 输出，顺便把最近的日志留作排障。"""
    assert process.stdout is not None
    for line in process.stdout:
        text = line.strip()
        if text:
            lines.append(text)
            if len(lines) > 40:
                del lines[0]


def run(port: int = 8900, *, open_browser: bool = True, host: str = "127.0.0.1") -> int:
    import uvicorn

    config.ensure_dirs()
    phone.clear_public_url()
    exe = ensure_cloudflared()

    preferred = port
    try:
        port = phone.pick_free_port(host, preferred)
    except OSError as exc:
        print(f"找不到空闲端口：{exc}", file=sys.stderr)
        return 1

    print()
    print("纸伴 · 公网隧道模式")
    print("=" * 52)
    if port != preferred:
        print(f"  本机端口 {preferred} 被占用，已改用 {port}。")
        try:
            with urllib.request.urlopen(f"http://{host}:{preferred}/api/health", timeout=2) as response:
                if response.status == 200:
                    print(f"  注意：端口 {preferred} 上还有一个纸伴在运行（窗口关了但进程没退出）。")
                    print("  想彻底关掉：任务管理器 → 详细信息 → 结束 python.exe。")
        except Exception:  # noqa: BLE001 - 占用者不是纸伴就忽略
            pass
    print("  正在启动本机服务…")
    server = uvicorn.Server(
        uvicorn.Config("paperpal.api:app", host=host, port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    if not _wait_for_server(port):
        print("本机服务启动失败，请运行 后端\\start.ps1 检查依赖。", file=sys.stderr)
        server.should_exit = True
        return 1
    print("  本机服务已就绪，正在建立 Cloudflare 隧道…")

    process = subprocess.Popen(
        [
            str(exe),
            "tunnel",
            "--url",
            f"http://{host}:{port}",
            "--no-autoupdate",
            "--protocol",
            "http2",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    lines: list[str] = []
    reader = threading.Thread(target=_pump, args=(process, lines), daemon=True)
    reader.start()

    public_url = ""
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        for entry in list(lines):
            match = URL_PATTERN.search(entry)
            if match:
                public_url = match.group(0)
                break
        if public_url:
            break
        time.sleep(0.5)

    if not public_url:
        print("隧道建立失败。cloudflared 最近输出：", file=sys.stderr)
        for entry in lines[-15:]:
            print("  " + entry, file=sys.stderr)
        print(
            "\n可能的解决方式：\n"
            "  1. 检查电脑能否访问外网（代理软件可能拦截 cloudflared）；\n"
            "  2. 换一个网络再试；\n"
            "  3. 或者退回局域网模式：启动手机测试.bat（需要放行防火墙、且手机与电脑同网段）。",
            file=sys.stderr,
        )
        process.terminate()
        server.should_exit = True
        return 1

    phone.write_public_url(public_url)
    print("-" * 52)
    print("  手机打开：", public_url)
    print("  （公网 HTTPS，无需安装证书，4G/5G 也能打开）")
    print("-" * 52)
    print("  在电脑上打开下面的页面，用手机扫二维码：")
    print(f"    http://127.0.0.1:{port}/#/phone")
    print("  按 Ctrl+C 停止（隧道地址随之失效）。")
    print("=" * 52)
    print()
    if open_browser:
        try:
            import webbrowser

            webbrowser.open(f"http://127.0.0.1:{port}/#/phone")
        except Exception:  # pragma: no cover
            pass

    try:
        while process.poll() is None:
            time.sleep(0.6)
        print("隧道已断开。", file=sys.stderr)
    except KeyboardInterrupt:
        print("\n正在关闭…")
    finally:
        try:
            process.terminate()
        except Exception:  # noqa: BLE001
            pass
        # 只清掉自己写的地址，避免把新开隧道的地址误删
        try:
            if phone.public_url_file().read_text(encoding="utf-8").strip() == public_url:
                phone.clear_public_url()
        except OSError:
            pass
        server.should_exit = True
        thread.join(timeout=5)
    return 0


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - 手工运行
    argv = list(sys.argv[1:] if argv is None else argv)
    port = 8900
    open_browser = True
    if "--port" in argv:
        index = argv.index("--port")
        port = int(argv[index + 1])
    if "--no-browser" in argv:
        open_browser = False
    return run(port, open_browser=open_browser)


if __name__ == "__main__":  # pragma: no cover
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    raise SystemExit(main())
