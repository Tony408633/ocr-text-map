"""脚本编码守护：Windows PowerShell 5.1 读取无 BOM 的 UTF-8 中文脚本会解析失败。

这个测试保证所有含中文的 .ps1 都带 UTF-8 BOM，所有 .bat 只使用 ASCII，
避免再出现“表达式或语句中包含意外的标记”这类启动失败。
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKIP_DIRS = {".runtime", ".tmp", ".git", "node_modules", "data", "后端/data"}


def _iter_files(suffixes: tuple[str, ...]):
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in suffixes:
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        yield path


def test_powershell_scripts_use_utf8_bom():
    problems = []
    for path in _iter_files((".ps1",)):
        raw = path.read_bytes()
        has_non_ascii = any(byte > 127 for byte in raw)
        has_bom = raw.startswith(b"\xef\xbb\xbf")
        if has_non_ascii and not has_bom:
            problems.append(str(path.relative_to(ROOT)))
    assert not problems, f"这些 .ps1 含中文但没有 UTF-8 BOM，PowerShell 5.1 会解析失败：{problems}"


def test_batch_files_are_ascii():
    problems = []
    for path in _iter_files((".bat",)):
        raw = path.read_bytes()
        if any(byte > 127 for byte in raw):
            problems.append(str(path.relative_to(ROOT)))
    assert not problems, f"这些 .bat 含非 ASCII 字符，cmd 可能无法解析：{problems}"


def test_entry_scripts_exist():
    for name in ("启动纸伴App.bat", "启动手机测试.bat", "启动手机隧道.bat"):
        assert (ROOT / name).is_file(), f"缺少入口脚本：{name}"
    for name in ("start.ps1", "start-phone.ps1", "start-tunnel.ps1", "start-app.ps1"):
        assert (ROOT / "后端" / name).is_file(), f"缺少后端脚本：{name}"
