"""前端资产与接线的契约测试。

目标：避免出现"页面上有按钮、但 JS 里没有对应处理"这种"功能没导入成功"的问题。
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FRONT = ROOT / "前端"
HTML = (FRONT / "index.html").read_text(encoding="utf-8")
APP = (FRONT / "js" / "app.js").read_text(encoding="utf-8")


def test_every_clickable_action_has_a_handler():
    actions = sorted(set(re.findall(r'data-action="([a-z0-9-]+)"', HTML)))
    assert actions, "index.html 里没有找到 data-action"
    missing = [action for action in actions if f'case "{action}"' not in APP]
    assert not missing, f"这些按钮没有对应处理：{missing}"


def test_every_icon_reference_exists():
    used = set(re.findall(r'<use href="#(i-[a-z0-9-]+)"', HTML))
    defined = set(re.findall(r'<symbol id="(i-[a-z0-9-]+)"', HTML))
    assert used <= defined, f"缺少图标定义：{sorted(used - defined)}"
    # JS 里通过 iconName: "name" 或 #i-name 动态使用的图标也要存在
    dynamic = {f"i-{name}" for name in re.findall(r'iconName: "([a-z0-9-]+)"', APP)}
    dynamic |= set(re.findall(r'href="#(i-[a-z0-9-]+)"', APP))
    assert dynamic <= defined, f"缺少动态图标定义：{sorted(dynamic - defined)}"


def test_each_screen_route_is_declared():
    screens = set(re.findall(r'data-route="([a-z]+)"', HTML))
    app_routes = set(re.findall(r'^  "([a-z]+)",$', APP.split("const ROUTES", 1)[1].split("]);", 1)[0], re.M))
    assert screens <= app_routes, f"页面存在但路由表没有：{sorted(screens - app_routes)}"
    assert "phone" in app_routes


def test_service_worker_shell_files_exist():
    source = (FRONT / "sw.js").read_text(encoding="utf-8")
    shell = source.split("const SHELL", 1)[1].split("];", 1)[0]
    paths = re.findall(r'"([^"]+)"', shell)
    assert paths
    for path in paths:
        if path == "/":
            assert (FRONT / "index.html").is_file()
            continue
        local = path.replace("/app-assets/", "")
        if path.startswith("/app-assets/"):
            assert (FRONT / local).is_file(), f"Service Worker 缓存了不存在的文件：{path}"
        elif path == "/manifest.webmanifest":
            assert (FRONT / "manifest.webmanifest").is_file()
        elif path == "/favicon.svg":
            assert (FRONT / "icon.svg").is_file()


def test_manifest_icons_exist():
    import json

    manifest = json.loads((FRONT / "manifest.webmanifest").read_text(encoding="utf-8"))
    for item in manifest["icons"]:
        src = item["src"]
        local = src.replace("/app-assets/", "").replace("/favicon.svg", "icon.svg")
        assert (FRONT / local).is_file(), f"manifest 图标不存在：{src}"


def test_modules_are_importable_files():
    for name in ("api.js", "store.js", "voice.js", "ui.js", "input.js", "media.js", "bluetooth.js", "app.js"):
        assert (FRONT / "js" / name).is_file(), f"缺少模块：{name}"
    assert "input.js" in HTML or (FRONT / "js" / "app.js").read_text(encoding="utf-8").count("input.js") > 0
