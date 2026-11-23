"""自检：不用手机也能确认 OCR、数据库、证书和依赖是否正常。"""

from __future__ import annotations

import importlib
import io
import os
import platform
import sys
import time
from pathlib import Path

from . import config

TEST_SENTENCE = "纸伴陪你读书"
TEST_LINES = ["纸伴陪你读书", "把手机固定在书页上方"]


def _font(size: int):
    from PIL import ImageFont

    candidates = [
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhl.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    ]
    for path in candidates:
        try:
            if Path(path).is_file():
                return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make_test_image(lines: list[str] | None = None) -> bytes:
    """画一张干净的中文测试页，交给 OCR 识别。"""
    from PIL import Image, ImageDraw

    lines = lines or TEST_LINES
    width, height = 1200, 360
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    font = _font(64)
    y = 40
    for line in lines:
        draw.text((60, y), line, fill="black", font=font)
        y += 120
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def run_ocr_self_test(service) -> dict:
    """跑一次真实 OCR，返回识别到的文字与耗时。"""
    started = time.monotonic()
    image = make_test_image()
    try:
        result = service.process(image, mode="auto", min_confidence=0.3, max_side=1280)
    except Exception as exc:  # noqa: BLE001 - 自检要把错误原文给用户
        return {
            "ok": False,
            "stage": "recognize",
            "error": str(exc),
            "hint": _ocr_hint(exc),
            "elapsed_ms": round((time.monotonic() - started) * 1000),
        }
    elapsed = round((time.monotonic() - started) * 1000)
    text = result.get("text") or ""
    lines = [line.get("text", "") for line in result.get("lines", [])]
    expected = "".join(TEST_LINES).replace(" ", "")
    got = "".join(lines).replace(" ", "")
    matched = sum(1 for char in expected if char in got)
    return {
        "ok": bool(lines),
        "stage": "done",
        "engine": result.get("engine", getattr(service, "engine", "")),
        "elapsed_ms": elapsed,
        "lines": lines,
        "text": text,
        "expected": TEST_LINES,
        "match_ratio": round(matched / max(1, len(expected)), 2),
        "timing_ms": result.get("timing_ms") or {},
        "hint": (
            "OCR 工作正常。"
            if lines
            else "OCR 没有识别到文字：请检查图片清晰度，或重新安装 requirements.txt 里的 OCR 依赖。"
        ),
    }


def _ocr_hint(exc: Exception) -> str:
    message = str(exc)
    if "未安装" in message or "ImportError" in type(exc).__name__:
        return "缺少 OCR 依赖。请运行 后端\\start.ps1 或重新安装 requirements.txt。"
    if "模型" in message or "model" in message.lower():
        return "OCR 模型文件缺失或损坏。请重新安装 rapidocr-onnxruntime。"
    if "onnx" in message.lower():
        return "onnxruntime 初始化失败。请确认是 64 位 Python 3.10–3.12。"
    return "OCR 引擎报错，下面的原文可以帮助定位问题。"


def _module_version(name: str) -> str | None:
    try:
        module = importlib.import_module(name)
    except Exception:  # noqa: BLE001 - 缺少依赖是正常情况
        return None
    return str(getattr(module, "__version__", "已安装"))


def environment_report() -> dict:
    """给“设置 → 关于”和排障用的环境快照。"""
    packages = {}
    for name in ("fastapi", "uvicorn", "pydantic", "PIL", "numpy", "onnxruntime", "zhconv", "rapidocr_onnxruntime", "segno"):
        packages[name] = _module_version(name)
    try:
        import ssl

        openssl = ssl.OPENSSL_VERSION
    except Exception:  # noqa: BLE001
        openssl = None
    data_dir = config.data_dir()
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "executable": sys.executable,
        "openssl": openssl,
        "packages": packages,
        "data_dir": str(data_dir),
        "data_writable": os.access(data_dir, os.W_OK) if data_dir.exists() else False,
        "packages_path": [entry for entry in sys.path if "deps" in entry],
        "https_certs": {
            "ca": str(config.data_dir() / "https" / "ca.crt"),
            "server": str(config.data_dir() / "https" / "server.crt"),
            "exists": (config.data_dir() / "https" / "server.crt").is_file(),
        },
    }
