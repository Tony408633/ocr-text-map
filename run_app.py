"""Cursor / Python 一键入口：打开纸伴桌面 App 窗口。

在 Cursor 中直接运行本文件，或在终端执行：
    python run_app.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "后端"
for candidate in (BACKEND, ROOT / ".runtime" / "deps"):
    if candidate.is_dir() and str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))
os.chdir(ROOT)

try:
    from paperpal.desktop import main
except ImportError as exc:  # pragma: no cover - 依赖缺失时给出可执行提示
    print("缺少桌面运行依赖。请在 Cursor 终端执行：")
    print("  pip install -r requirements-desktop.txt")
    print(f"详细错误：{exc}")
    raise SystemExit(1) from exc

if __name__ == "__main__":
    raise SystemExit(main())
