"""Command-line entry point for the PaperPal backend.

Usage::

    python -m paperpal serve [--host 127.0.0.1] [--port 8000] [--reload]
    python -m paperpal init [--demo/--no-demo]
    python -m paperpal export [--output backup.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__, config
from .db import Database
from .repository import Repository


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m paperpal",
        description="纸伴 PaperPal 后端：书架、OCR、批注、进度与统计。",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="启动网页应用与 API")
    serve.add_argument("--host", default="127.0.0.1", help="监听地址，局域网使用 0.0.0.0")
    serve.add_argument("--port", type=int, default=8000, help="监听端口，默认 8000")
    serve.add_argument("--reload", action="store_true", help="开发模式：代码改动后自动重启")
    serve.add_argument("--ssl-certfile", type=Path, help="HTTPS 证书文件")
    serve.add_argument("--ssl-keyfile", type=Path, help="HTTPS 私钥文件")
    serve.add_argument(
        "--https",
        action="store_true",
        help="自动生成本机证书并以 HTTPS 启动（手机相机、离线安装需要）",
    )

    phone = sub.add_parser("phone", help="以 HTTPS 启动，供手机/iPad 通过局域网访问")
    phone.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0（局域网可访问）")
    phone.add_argument("--port", type=int, default=8443, help="HTTPS 端口，默认 8443")
    phone.add_argument("--no-browser", action="store_true", help="启动后不自动打开本机浏览器")

    tunnel = sub.add_parser(
        "tunnel", help="用 Cloudflare 临时隧道提供公网 HTTPS（手机任意网络都能打开）"
    )
    tunnel.add_argument(
        "--port", type=int, default=8900, help="本机 HTTP 端口，默认 8900（被占用会自动往后找）"
    )
    tunnel.add_argument("--no-browser", action="store_true", help="启动后不自动打开本机浏览器")

    desktop = sub.add_parser("desktop", help="以独立应用窗口运行纸伴（Edge/WebView2，无浏览器地址栏）")
    desktop.add_argument("--port", type=int, default=0, help="端口；0 表示自动选择")
    desktop.add_argument("--width", type=int, default=430, help="窗口宽度，默认 430")
    desktop.add_argument("--height", type=int, default=900, help="窗口高度，默认 900")
    desktop.add_argument("--data-dir", type=Path, help="数据目录，默认项目 data/")
    desktop.add_argument("--debug", action="store_true", help="打开 WebView 调试工具")
    desktop.add_argument(
        "--backend",
        choices=("auto", "native", "app", "browser"),
        default="auto",
        help="auto=优先原生窗口；native=pywebview；app=Edge/Chrome 应用窗口；browser=默认浏览器",
    )

    init = sub.add_parser("init", help="初始化数据库")
    init.add_argument("--demo", dest="demo", action="store_true", default=None)
    init.add_argument("--no-demo", dest="demo", action="store_false")

    export = sub.add_parser("export", help="导出全部数据为 JSON 备份")
    export.add_argument("--output", type=Path, help="输出文件；省略时写到标准输出")

    return parser


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "init":
        config.ensure_dirs()
        database = Database()
        database.initialize(seed_demo=args.demo)
        print(f"数据库已就绪：{database.path}（结构版本 {database.schema_version()}）")
        return 0

    if args.command == "export":
        database = Database()
        database.initialize()
        payload = Repository(database).export_all()
        serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            args.output.write_text(serialized, encoding="utf-8")
            print(f"已导出：{args.output}", file=sys.stderr)
        else:
            sys.stdout.write(serialized)
        return 0

    if args.command == "desktop":
        from .desktop import run

        return run(
            port=args.port,
            width=args.width,
            height=args.height,
            data_dir=args.data_dir,
            debug=args.debug,
            backend=args.backend,
        )

    if args.command == "phone":
        from .phone import start_https

        if not 1 <= args.port <= 65535:
            parser.error("端口必须在 1 到 65535 之间。")
        return start_https(args.host, args.port, open_browser=not args.no_browser)

    if args.command == "tunnel":
        from .tunnel import run as run_tunnel

        if not 1 <= args.port <= 65535:
            parser.error("端口必须在 1 到 65535 之间。")
        return run_tunnel(args.port, open_browser=not args.no_browser)

    if args.command == "serve":
        if args.https:
            from . import certs
            from .phone import ensure_certificates

            ensure_certificates()
            args.ssl_certfile = certs.server_cert_file()
            args.ssl_keyfile = certs.server_key_file()
        if bool(args.ssl_certfile) != bool(args.ssl_keyfile):
            parser.error("--ssl-certfile 和 --ssl-keyfile 必须同时提供。")
        if not 1 <= args.port <= 65535:
            parser.error("端口必须在 1 到 65535 之间。")
        for file_path in (args.ssl_certfile, args.ssl_keyfile):
            if file_path is not None and not file_path.is_file():
                parser.error(f"HTTPS 文件不存在：{file_path}")
        try:
            import uvicorn
        except ImportError:
            print(
                "缺少 Web 依赖，请先安装 requirements.txt（fastapi、uvicorn）。",
                file=sys.stderr,
            )
            return 1
        config.ensure_dirs()
        scheme = "https" if args.ssl_certfile else "http"
        print(f"纸伴后端 {__version__} · {scheme}://{args.host}:{args.port}")
        uvicorn.run(
            "paperpal.api:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
            ssl_certfile=str(args.ssl_certfile) if args.ssl_certfile else None,
            ssl_keyfile=str(args.ssl_keyfile) if args.ssl_keyfile else None,
        )
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
