"""Simplified/Traditional conversion and optional online translation.

The app never translates automatically: the reader explicitly selects a
translation target.  Only the current page's text is sent to the translation
provider, and results are cached in memory for the process lifetime.
"""

from __future__ import annotations

import html
import json
import os
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import Iterable


class TextTransformError(RuntimeError):
    """The requested script conversion is unavailable."""


class TranslationUnavailable(TextTransformError):
    """The optional online translation provider failed."""


PROVIDER = "MyMemory / Google（在线）"
MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get"
GOOGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single"
HTTP_TIMEOUT = 6.0

#: 连不上的提供方会被暂时跳过，避免一页文字每条都要等超时。
_disabled_providers: set[str] = set()


def _script_name(script: str) -> str:
    if script == "traditional":
        return "zh-hant"
    if script == "simplified":
        return "zh-hans"
    raise TextTransformError("文字版本必须是 simplified 或 traditional。")


def convert_script(text: str, script: str) -> str:
    if not text:
        return ""
    target = _script_name(script)
    try:
        import zhconv
    except ImportError as exc:  # pragma: no cover - depends on optional install
        raise TextTransformError(
            "繁简转换组件未安装。请运行 start.ps1 或安装 requirements.txt 中的 zhconv。"
        ) from exc
    return zhconv.convert(text, target)


def _langpair(target: str, script: str) -> tuple[str, str]:
    if target == "en":
        return ("zh-TW" if script == "traditional" else "zh-CN"), "en"
    if target == "zh":
        return "en", "zh-CN"
    raise TranslationUnavailable("翻译方向必须是 en 或 zh。")


def _http_json(url: str) -> dict | list:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (PaperPal/1.0 local reading app)",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
        return json.load(response)


def _translate_mymemory(text: str, source: str, destination: str) -> str:
    params = urllib.parse.urlencode({"q": text, "langpair": f"{source}|{destination}"})
    payload = _http_json(f"{MYMEMORY_ENDPOINT}?{params}")
    if not isinstance(payload, dict):
        raise TranslationUnavailable("翻译服务返回了无法解析的内容。")
    if payload.get("quotaFinished"):
        raise TranslationUnavailable("今天的免费翻译额度已用完。")
    status = payload.get("responseStatus")
    if status not in (200, "200"):
        raise TranslationUnavailable(str(payload.get("responseDetails") or "翻译服务返回异常。"))
    translated = (payload.get("responseData") or {}).get("translatedText") or ""
    return html.unescape(str(translated)).strip()


def _translate_google(text: str, source: str, destination: str) -> str:
    params = urllib.parse.urlencode(
        {
            "client": "gtx",
            "sl": source.split("-")[0],
            "tl": destination.split("-")[0],
            "dt": "t",
            "q": text,
        }
    )
    payload = _http_json(f"{GOOGLE_ENDPOINT}?{params}")
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], list):
        raise TranslationUnavailable("翻译服务返回了无法解析的内容。")
    parts = [str(chunk[0]) for chunk in payload[0] if isinstance(chunk, list) and chunk]
    return "".join(parts).strip()


def _translate_custom(text: str, source: str, destination: str) -> str:
    """自建/自托管的 LibreTranslate 兼容接口，例如 http://127.0.0.1:5000/translate。"""
    endpoint = os.environ.get("PAPERPAL_TRANSLATE_URL", "").strip()
    if not endpoint:
        raise TranslationUnavailable("没有配置自建翻译端点。")
    body = json.dumps(
        {"q": text, "source": source.split("-")[0], "target": destination.split("-")[0], "format": "text"}
    ).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
        payload = json.load(response)
    translated = payload.get("translatedText") if isinstance(payload, dict) else None
    return str(translated or "").strip()


_PROVIDERS = [
    ("custom", _translate_custom, True),
    ("mymemory", _translate_mymemory, False),
    ("google", _translate_google, False),
]


@lru_cache(maxsize=4096)
def _translate_line(text: str, target: str, script: str) -> str:
    if not text.strip():
        return ""
    source, destination = _langpair(target, script)
    errors: list[str] = []
    for name, function, optional in _PROVIDERS:
        if optional and not os.environ.get("PAPERPAL_TRANSLATE_URL"):
            continue
        if name in _disabled_providers:
            continue
        try:
            translated = function(text, source, destination)
        except TranslationUnavailable as exc:
            errors.append(str(exc))
            if optional:
                continue
            _disabled_providers.add(name)
            continue
        except Exception as exc:  # noqa: BLE001 - 网络错误统一处理
            errors.append(str(exc))
            if not optional:
                _disabled_providers.add(name)
            continue
        if translated:
            return translated
        errors.append(f"{name} 没有返回译文。")
    detail = errors[0] if errors else "没有可用的翻译服务。"
    raise TranslationUnavailable(
        "在线翻译连不上（可能被网络屏蔽或超时）。可以先用本机繁简转换，"
        "换一个网络，或用 PAPERPAL_TRANSLATE_URL 指向自建翻译服务。"
        f"（{detail}）"
    )



def translate_lines(
    lines: list[str], *, target: str, script: str
) -> tuple[list[str], list[str]]:
    """Translate lines independently so line mapping stays exact."""
    if target == "off":
        return ["" for _ in lines], []
    provider_enabled = os.environ.get("PAPERPAL_TRANSLATE_PROVIDER", "").strip().lower()
    if provider_enabled in {"0", "off", "false", "none", "disabled"}:
        raise TranslationUnavailable("在线翻译已被管理员关闭。")
    translations: list[str] = [""] * len(lines)
    warnings: list[str] = []
    jobs = [(index, line) for index, line in enumerate(lines) if line.strip()]
    if not jobs:
        return translations, warnings

    def run(job):
        index, line = job
        try:
            return index, _translate_line(line, target, script), None
        except TranslationUnavailable as exc:
            return index, "", str(exc)

    with ThreadPoolExecutor(max_workers=min(4, len(jobs))) as pool:
        results = list(pool.map(run, jobs))
    errors = []
    for index, translated, error in results:
        if error:
            errors.append(error)
        else:
            translations[index] = translated
    if errors and not any(translations):
        raise TranslationUnavailable(errors[0])
    if errors:
        warnings.append(errors[0])
    return translations, warnings


def transform(
    lines: Iterable[str],
    *,
    script: str = "simplified",
    translation: str = "off",
) -> dict:
    values = [str(line) for line in lines]
    converted = [convert_script(line, script) for line in values]
    translations: list[str] = ["" for _ in values]
    warnings: list[str] = []
    if translation != "off":
        translations, warnings = translate_lines(
            converted, target=translation, script=script
        )
    return {
        "script": script,
        "translation": translation,
        "lines": [
            {"text": text, "translation": translated or None}
            for text, translated in zip(converted, translations)
        ],
        "provider": PROVIDER if translation != "off" else None,
        "warnings": warnings,
    }
