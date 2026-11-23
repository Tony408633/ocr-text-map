"""连续自动扫描的判定逻辑：这一帧是"同一页"还是"翻页了"。

盲人用户把手机固定在书页上方后，不应该需要拍照、点按钮。相机连续取帧，
后端每次识别完都要回答两个问题：

1. 这是不是刚才那一页？（是 → 就地更新，保留批注和阅读位置）
2. 如果不是，最像书里的哪一页？（可能是往回翻）

这里只放纯函数，方便单元测试。
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

#: 归一化时丢掉的字符（标点、空白、常见 OCR 噪声）
_NOISE = re.compile(r"[\s\u3000，。！？、；：,.!?;:\"'“”‘’（）()《》〈〉\[\]【】\-—_~·…]")

#: 相似度达到这个值就认为"还是同一页"
SAME_PAGE_THRESHOLD = 0.72
#: 比同页阈值更高，说明几乎没有变化，可以完全跳过更新
UNCHANGED_THRESHOLD = 0.97


def normalize(text: str) -> str:
    return _NOISE.sub("", str(text or "")).lower()


def similarity(left: str, right: str) -> float:
    """0–1 的文本相似度；空文本返回 0。"""
    a = normalize(left)
    b = normalize(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # 长度差太大时先快速排除，避免对整页做昂贵的比对
    if min(len(a), len(b)) / max(len(a), len(b)) < 0.45:
        return 0.0
    ratio = SequenceMatcher(None, a, b, autojunk=False).ratio()
    return round(ratio, 4)


def page_text(page: dict) -> str:
    lines = page.get("lines") or []
    if lines:
        return "\n".join(str(line.get("text") or "") for line in lines)
    return str(page.get("text") or "")


def decide(
    incoming_text: str,
    pages: list[dict],
    *,
    same_threshold: float = SAME_PAGE_THRESHOLD,
) -> dict:
    """判断新识别的一页属于书里的哪一页。

    ``pages`` 是 ``[{"page_number": 3, "text": "..."}]``（可以只带最近几页）。
    返回::

        {
          "action": "same" | "new",
          "page_number": 命中的页码（new 时为 None）,
          "similarity": 最高相似度,
          "unchanged": 是否几乎没有变化,
          "scores": [(页码, 相似度), ...]
        }
    """
    best_number = None
    best_score = 0.0
    scores: list[tuple[int, float]] = []
    for page in pages:
        number = int(page.get("page_number") or 0)
        if number <= 0:
            continue
        score = similarity(incoming_text, page_text(page))
        scores.append((number, score))
        if score > best_score:
            best_score = score
            best_number = number
    scores.sort(key=lambda item: item[1], reverse=True)
    if best_number is not None and best_score >= same_threshold:
        return {
            "action": "same",
            "page_number": best_number,
            "similarity": best_score,
            "unchanged": best_score >= UNCHANGED_THRESHOLD,
            "scores": scores[:5],
        }
    return {
        "action": "new",
        "page_number": None,
        "similarity": best_score,
        "unchanged": False,
        "scores": scores[:5],
    }


def best_line_index(target: str, lines: list[dict]) -> int:
    """在重新识别的行里找到和原行最像的一行，用来保持朗读位置。"""
    cleaned = normalize(target)
    if not cleaned:
        return 0
    best_index = 0
    best_score = -1.0
    for index, line in enumerate(lines):
        score = similarity(cleaned, str(line.get("text") or ""))
        if score > best_score:
            best_score = score
            best_index = index
    return best_index
