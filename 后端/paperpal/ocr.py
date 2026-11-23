"""Adapter around the bundled RapidOCR pipeline.

The heavy imports (OpenCV, ONNX Runtime, RapidOCR models) happen on first use
so the HTTP service starts instantly and can report a helpful status when the
optional OCR dependencies are missing.
"""

from __future__ import annotations

import sys
import threading
from typing import Any, Callable

from . import config


class OCRUnavailable(RuntimeError):
    """The OCR engine or its dependencies are not installed."""


class OCRBusy(RuntimeError):
    """Another scan is being processed by the same pipeline."""


class OCRInputError(ValueError):
    """The uploaded image or one of the options is invalid."""


class OCRService:
    def __init__(self, factory: Callable[[], Any] | None = None):
        self._factory = factory
        self._pipeline: Any = None
        self._lock = threading.Lock()
        self._last_error: str | None = None
        self.engine = "rapidocr-onnxruntime"

    @property
    def ready(self) -> bool:
        pipeline = self._pipeline
        if pipeline is None:
            return False
        try:
            return bool(pipeline.ready)
        except Exception:
            return False

    @property
    def last_error(self) -> str | None:
        return self._last_error

    def _default_factory(self) -> Any:
        if str(config.OCR_ROOT) not in sys.path:
            sys.path.insert(0, str(config.OCR_ROOT))
        try:
            from mobile_ocr.pipeline import OCRPipeline
        except ImportError as exc:  # pragma: no cover - depends on environment
            raise OCRUnavailable(
                "OCR 引擎未安装。请运行 start.ps1 安装 requirements.txt 后重试。"
            ) from exc
        return OCRPipeline()

    def _get_pipeline(self) -> Any:
        if self._pipeline is not None:
            return self._pipeline
        with self._lock:
            if self._pipeline is None:
                factory = self._factory or self._default_factory
                try:
                    self._pipeline = factory()
                except OCRUnavailable:
                    raise
                except Exception as exc:  # pragma: no cover - model/runtime failure
                    self._last_error = str(exc)
                    raise OCRUnavailable(
                        "OCR 引擎初始化失败，请检查依赖和模型文件。"
                    ) from exc
        return self._pipeline

    def process(
        self,
        image_bytes: bytes,
        *,
        mode: str = "auto",
        min_confidence: float = 0.45,
        max_side: int = 1920,
        rotation: int = 0,
        split: str = "none",
        split_position: float = 0.5,
    ) -> dict:
        """Return the compact shape stored by the app."""
        result = self.process_raw(
            image_bytes,
            mode=mode,
            min_confidence=min_confidence,
            max_side=max_side,
            rotation=rotation,
            split=split,
            split_position=split_position,
        )
        return self.normalize(result)

    def process_raw(
        self,
        image_bytes: bytes,
        *,
        mode: str = "auto",
        min_confidence: float = 0.45,
        max_side: int = 1920,
        rotation: int = 0,
        split: str = "none",
        split_position: float = 0.5,
    ) -> dict:
        """Return the full pipeline document (legacy /api/ocr contract)."""
        if not image_bytes:
            raise OCRInputError("没有收到图片，请重新拍摄。")
        pipeline = self._get_pipeline()
        try:
            return pipeline.process(
                image_bytes,
                mode=mode,
                min_confidence=min_confidence,
                max_side=max_side,
                rotation=rotation,
                split=split,
                split_position=split_position,
            )
        except ValueError as exc:
            raise OCRInputError(str(exc) or "图片或参数不符合要求。") from exc
        except RuntimeError as exc:
            message = str(exc)
            if "另一张" in message or "忙" in message:
                raise OCRBusy("上一张照片仍在识别中，请稍等几秒再试。") from exc
            self._last_error = message
            raise OCRUnavailable(message or "OCR 引擎暂时不可用。") from exc

    @staticmethod
    def normalize(result: dict) -> dict:
        """Turn a pipeline document into the shape stored by the backend."""
        raw_lines = result.get("lines") or []
        ordered = sorted(raw_lines, key=lambda line: line.get("reading_order", 0))
        lines: list[dict] = []
        for index, line in enumerate(ordered, 1):
            text = str(line.get("text") or "").strip()
            if not text:
                continue
            lines.append(
                {
                    "reading_order": index,
                    "text": text,
                    "confidence": float(line.get("confidence") or 0),
                    "region_id": str(line.get("region_id") or ""),
                    "block_id": str(line.get("block_id") or ""),
                    "bbox": line.get("bbox_source") or line.get("bbox_rectified") or [],
                }
            )
        regions = result.get("regions") or []
        rectified = None
        if regions and isinstance(regions[0], dict):
            rectified = regions[0].get("rectified_image")
        return {
            "document_id": result.get("document_id", ""),
            "engine": result.get("engine", "rapidocr-onnxruntime"),
            "source_size": result.get("source_size") or [0, 0],
            "rotated_size": result.get("rotated_size") or [0, 0],
            "text": "\n".join(line["text"] for line in lines),
            "lines": lines,
            "regions": [
                {
                    "id": region.get("id"),
                    "label": region.get("label"),
                    "kind": region.get("kind"),
                    "rectified_size": region.get("rectified_size"),
                    "warnings": region.get("warnings") or [],
                }
                for region in regions
                if isinstance(region, dict)
            ],
            "warnings": result.get("warnings") or [],
            "timing_ms": result.get("timing_ms") or {},
            "rectified_image": rectified,
        }


class FakeOCRService(OCRService):
    """Deterministic service for tests and demos without OCR dependencies."""

    def __init__(self, lines: list[str] | None = None):
        super().__init__(factory=lambda: _FakePipeline(lines or ["读书使人充实。"]))
        self._pipeline = _FakePipeline(lines or ["读书使人充实。"])

    @property
    def ready(self) -> bool:
        return True


class _FakePipeline:
    ready = True

    def __init__(self, lines: list[str]):
        self.lines = lines

    def process(self, image_bytes: bytes, **options: Any) -> dict:
        if not image_bytes:
            raise ValueError("没有收到图片。")
        return {
            "document_id": "fake-document",
            "engine": "fake",
            "source_size": [1200, 1600],
            "text": "\n".join(self.lines),
            "lines": [
                {
                    "reading_order": index,
                    "text": text,
                    "confidence": 0.98,
                    "region_id": "page-1",
                    "block_id": "block-1",
                    "bbox_source": [10, index * 40, 600, 30],
                    "polygon_source": [[10, index * 40], [610, index * 40], [610, index * 40 + 30], [10, index * 40 + 30]],
                }
                for index, text in enumerate(self.lines, 1)
            ],
            "regions": [
                {
                    "id": "page-1",
                    "label": "完整页面",
                    "kind": "page",
                    "rectified_size": [1200, 1600],
                    "rectified_image": "data:image/jpeg;base64,AA==",
                    "line_ids": [f"line-{index}" for index in range(1, len(self.lines) + 1)],
                    "warnings": [],
                }
            ],
            "warnings": [],
            "timing_ms": {"total": 12.0},
        }
