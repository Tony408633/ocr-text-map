"""Filesystem locations and runtime defaults for the PaperPal backend."""

from __future__ import annotations

import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_DIR.parent          # 后端/
PROJECT_HOME = PROJECT_ROOT.parent         # 项目根目录（包含 前端/ 与 后端/）
OCR_ROOT = PROJECT_ROOT / "ocr-text-map-main"
APP_DIR = PROJECT_HOME / "前端"
READER_DIR = OCR_ROOT / "reader"
OCR_STATIC_DIR = OCR_ROOT / "mobile_ocr" / "static"

DEFAULT_PROFILE_ID = "local"
DEFAULT_PROFILE_NAME = "我"

API_PREFIX = "/api/v1"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_JSON_BYTES = 4 * 1024 * 1024
THUMBNAIL_WIDTH = 520

#: Keys accepted by ``PUT /api/v1/settings``; unknown keys are stored too but
#: these carry defaults and range validation.
DEFAULT_SETTINGS: dict[str, object] = {
    "interaction_mode": "guided",
    "voice_enabled": True,
    "voice_rate": 1.0,
    "voice_pitch": 1.0,
    "verbosity": "standard",
    "theme": "auto",
    "high_contrast": False,
    "font_scale": 1.0,
    "auto_advance": False,
    "auto_advance_delay": 2.5,
    "reading_mode": "manual",
    "text_script": "simplified",
    "translation_target": "off",
    "speak_translation": False,
    "haptics": True,
    "guidance_sounds": True,
    "always_listen": False,
    "screen_reader_mode": False,
    "reader_name": "",
    "keep_screen_awake": True,
}

_THEMES = {"auto", "light", "dark"}
_VERBOSITY = {"brief", "standard", "detailed"}
_MODES = {"guided", "command"}
_SCRIPTS = {"simplified", "traditional"}
_TRANSLATIONS = {"off", "en", "zh"}
_READING_MODES = {"manual", "page", "overnight"}


def data_dir() -> Path:
    """Directory for the SQLite database and scanned page images."""
    override = os.environ.get("PAPERPAL_DATA_DIR")
    return Path(override).expanduser().resolve() if override else PROJECT_ROOT / "data"


def db_path() -> Path:
    override = os.environ.get("PAPERPAL_DB")
    return Path(override).expanduser().resolve() if override else data_dir() / "paperpal.db"


def images_dir() -> Path:
    return data_dir() / "images"


def ensure_dirs() -> None:
    data_dir().mkdir(parents=True, exist_ok=True)
    images_dir().mkdir(parents=True, exist_ok=True)


def auth_token() -> str | None:
    token = os.environ.get("PAPERPAL_TOKEN", "").strip()
    return token or None


def seed_demo() -> bool:
    return os.environ.get("PAPERPAL_SEED_DEMO", "1").strip().lower() not in {"0", "false", "no"}


def valid_settings(payload: dict) -> dict:
    """Clamp and reject invalid values instead of persisting garbage."""
    clean: dict[str, object] = {}
    for key, value in payload.items():
        if key in ("interaction_mode",):
            if value not in _MODES:
                raise ValueError("interaction_mode 必须是 guided 或 command。")
        elif key in ("theme",):
            if value not in _THEMES:
                raise ValueError("theme 必须是 auto、light 或 dark。")
        elif key in ("verbosity",):
            if value not in _VERBOSITY:
                raise ValueError("verbosity 必须是 brief、standard 或 detailed。")
        elif key in ("text_script",):
            if value not in _SCRIPTS:
                raise ValueError("text_script 必须是 simplified 或 traditional。")
        elif key in ("translation_target",):
            if value not in _TRANSLATIONS:
                raise ValueError("translation_target 必须是 off、en 或 zh。")
        elif key in ("reading_mode",):
            if value not in _READING_MODES:
                raise ValueError("reading_mode 必须是 manual、page 或 overnight。")
        elif key in ("voice_rate",):
            value = _number(value, 0.5, 2.0, "voice_rate")
        elif key in ("voice_pitch",):
            value = _number(value, 0.5, 2.0, "voice_pitch")
        elif key in ("font_scale",):
            value = _number(value, 0.85, 1.6, "font_scale")
        elif key in ("auto_advance_delay",):
            value = _number(value, 0.5, 20.0, "auto_advance_delay")
        elif key in (
            "voice_enabled",
            "high_contrast",
            "auto_advance",
            "haptics",
            "guidance_sounds",
            "always_listen",
            "screen_reader_mode",
            "speak_translation",
            "keep_screen_awake",
        ):
            if not isinstance(value, bool):
                raise ValueError(f"{key} 必须是布尔值。")
        elif key == "reader_name":
            value = str(value)[:40]
        else:
            raise ValueError(f"未知设置项：{key}")
        clean[key] = value
    return clean


def _number(value: object, low: float, high: float, name: str) -> float:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} 必须是数字。") from exc
    if number != number or number < low or number > high:
        raise ValueError(f"{name} 必须在 {low} 到 {high} 之间。")
    return round(number, 2)
