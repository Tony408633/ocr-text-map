"""Desktop app window launcher for PaperPal.

The web frontend is reused inside a standalone desktop application window:

* default: Edge/Chrome ``--app=`` window (no address bar, no tabs);
* optional: ``pywebview`` + Microsoft Edge WebView2 (native Python-owned window);
* fallback: the default browser.

Run with ``python -m paperpal desktop`` or ``python run_app.py``.
"""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

DEFAULT_HOST = "127.0.0.1"
DEFAULT_WIDTH = 430
DEFAULT_HEIGHT = 900


def _port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((DEFAULT_HOST, port))
        except OSError:
            return False
        return True


def _free_port(preferred: int = 8000) -> int:
    for port in [preferred, *range(8001, 8030)]:
        if _port_available(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((DEFAULT_HOST, 0))
        return int(sock.getsockname()[1])


def _wait_for_server(url: str, thread: threading.Thread, timeout: float = 45.0) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if not thread.is_alive():
            raise RuntimeError("纸伴服务线程意外退出，请查看终端错误。")
        try:
            with urlopen(f"{url}/api/v1/health", timeout=1.5) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError, OSError) as exc:
            last_error = exc
        time.sleep(0.25)
    raise RuntimeError(f"纸伴服务启动超时：{last_error}")


def _start_server(port: int, data_dir: Path):
    try:
        import uvicorn
    except ImportError as exc:
        raise RuntimeError(
            "缺少运行依赖。请在项目目录运行 start-app.ps1，"
            "或先安装 requirements-desktop.txt。"
        ) from exc

    try:
        from . import config
        from .api import create_app
    except ImportError as exc:
        raise RuntimeError(f"纸伴后端无法导入：{exc}") from exc

    config.ensure_dirs()
    app = create_app()
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=DEFAULT_HOST,
            port=port,
            log_level="warning",
            access_log=False,
        )
    )
    thread = threading.Thread(target=server.run, name="paperpal-server", daemon=True)
    thread.start()
    url = f"http://{DEFAULT_HOST}:{port}"
    _wait_for_server(url, thread)
    return server, thread, url


def _stop_server(server, thread: threading.Thread) -> None:
    try:
        server.should_exit = True
    except Exception:
        pass
    thread.join(timeout=5)


def _browser_executable() -> str | None:
    candidates = [
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("ProgramFiles", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("ProgramFiles(x86)", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def _run_app_window(url: str, data_dir: Path, width: int, height: int) -> bool:
    """Open a standalone chromeless Edge/Chrome app window."""
    executable = _browser_executable()
    if not executable:
        return False
    profile = data_dir / "desktop-profile"
    profile.mkdir(parents=True, exist_ok=True)
    args = [
        executable,
        f"--app={url}",
        f"--window-size={width},{height}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
    ]
    try:
        process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError:
        return False
    started = time.monotonic()
    try:
        returncode = process.wait()
    except KeyboardInterrupt:
        return True
    # Edge may hand a second app window to an already-running browser process.
    # In that case keep the local server alive until the user presses Ctrl+C.
    if returncode == 0 and time.monotonic() - started < 2.0:
        print("应用窗口已交给现有浏览器进程。关闭窗口后按 Ctrl+C 结束纸伴服务。")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return True
    return True


def _run_webview(url: str, data_dir: Path, width: int, height: int, debug: bool) -> None:
    import webview  # imported lazily so the normal web server has no extra dependency

    storage = data_dir / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    webview.create_window(
        "纸伴 · 陪你读书",
        url,
        width=width,
        height=height,
        min_size=(360, 620),
        resizable=True,
        background_color="#f4f2ea",
        text_select=True,
        zoomable=True,
        confirm_close=False,
    )
    webview.start(
        private_mode=False,
        storage_path=str(storage),
        debug=debug,
    )


def run(
    *,
    port: int = 0,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    data_dir: Path | None = None,
    debug: bool = False,
    backend: str = "auto",
) -> int:
    if width < 360 or height < 620:
        print("窗口尺寸太小，至少需要 360×620。", file=sys.stderr)
        return 2
    if port and not _port_available(port):
        print(f"端口 {port} 已被占用，请换一个端口或使用 --port 0。", file=sys.stderr)
        return 2

    resolved_data = Path(data_dir).expanduser().resolve() if data_dir else None
    if resolved_data:
        os.environ["PAPERPAL_DATA_DIR"] = str(resolved_data)
    else:
        from . import config

        resolved_data = config.data_dir()

    chosen_port = port or _free_port(8000)
    print("正在启动纸伴桌面版…")
    try:
        server, thread, url = _start_server(chosen_port, resolved_data)
    except Exception as exc:
        print(f"启动失败：{exc}", file=sys.stderr)
        return 1

    print(f"服务地址：{url}")
    print("关闭应用窗口即可退出纸伴。\n")
    try:
        if backend == "native":
            try:
                _run_webview(url, resolved_data, width, height, debug)
                return 0
            except ImportError:
                print(
                    "未安装 pywebview。请运行：\n"
                    "  pip install pywebview\n"
                    "或改用 --backend app 使用独立应用窗口。",
                    file=sys.stderr,
                )
                return 1
            except Exception as exc:
                print(f"原生窗口启动失败：{exc}", file=sys.stderr)
                return 1

        if backend in {"auto", "app"}:
            if _run_app_window(url, resolved_data, width, height):
                return 0
            if backend == "app":
                print("没有找到 Edge/Chrome，无法打开应用窗口。", file=sys.stderr)
                return 1
            print("没有找到 Edge/Chrome，改用默认浏览器。")

        webbrowser.open(url)
        print("已打开默认浏览器。关闭纸伴后按 Ctrl+C 结束服务。")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return 0
    finally:
        _stop_server(server, thread)
        print("纸伴服务已停止。")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m paperpal desktop",
        description="以桌面 App 窗口运行纸伴（原生 WebView2，或 Edge/Chrome 应用窗口）。",
    )
    parser.add_argument("--port", type=int, default=0, help="监听端口；0 表示自动选择，默认从 8000 开始")
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH, help="窗口宽度，默认 430")
    parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT, help="窗口高度，默认 900")
    parser.add_argument("--data-dir", type=Path, help="数据目录，默认项目 data/")
    parser.add_argument("--debug", action="store_true", help="打开 WebView 调试工具")
    parser.add_argument(
        "--backend",
        choices=("auto", "native", "app", "browser"),
        default="auto",
        help="auto/app=独立应用窗口（Edge/Chrome）；native=pywebview；browser=默认浏览器",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    try:
        return run(
            port=args.port,
            width=args.width,
            height=args.height,
            data_dir=args.data_dir,
            debug=args.debug,
            backend=args.backend,
        )
    except KeyboardInterrupt:
        print("\n已取消。")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
