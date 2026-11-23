"""Disk storage for scanned page images and thumbnails."""

from __future__ import annotations

import base64
import binascii
import io
import os
import tempfile
from pathlib import Path

from . import config

try:  # Pillow ships with the OCR requirements; the service still boots without it.
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover - exercised only in minimal installs
    Image = None  # type: ignore[assignment]
    ImageOps = None  # type: ignore[assignment]


class ImageStore:
    def __init__(self, directory: Path | None = None):
        self.directory = Path(directory) if directory is not None else config.images_dir()
        self.directory.mkdir(parents=True, exist_ok=True)

    def path(self, name: str) -> Path:
        candidate = (self.directory / name).resolve()
        root = self.directory.resolve()
        if candidate.parent != root:
            raise ValueError("非法的图片路径。")
        return candidate

    def _write_atomic(self, target: Path, data: bytes) -> None:
        handle, temporary = tempfile.mkstemp(dir=self.directory, suffix=target.suffix)
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
            os.replace(temporary, target)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise

    def save_page(
        self, page_id: str, image_bytes: bytes, *, rectified_data_url: str | None = None
    ) -> dict:
        """Persist the original capture, a thumbnail and the rectified preview.

        Browser uploads may be PNG/WebP/HEIC-converted; the stored original is
        normalised to an EXIF-oriented JPEG so the image endpoint always has a
        matching content type.
        """
        original_name = f"{page_id}.jpg"
        thumb_name = None
        rectified_name = None
        size = (0, 0)
        oriented = None
        if Image is not None:
            try:
                with Image.open(io.BytesIO(image_bytes)) as image:
                    oriented = ImageOps.exif_transpose(image).convert("RGB")
                    size = oriented.size
            except Exception:
                oriented = None
        if oriented is not None:
            buffer = io.BytesIO()
            oriented.save(buffer, "JPEG", quality=92, optimize=True)
            self._write_atomic(self.path(original_name), buffer.getvalue())
            thumb = oriented.copy()
            thumb.thumbnail((config.THUMBNAIL_WIDTH, 10_000))
            thumb_buffer = io.BytesIO()
            thumb.save(thumb_buffer, "JPEG", quality=72, optimize=True)
            thumb_name = f"{page_id}.thumb.jpg"
            self._write_atomic(self.path(thumb_name), thumb_buffer.getvalue())
        else:
            # Minimal installs or undecodable previews keep the raw upload.
            self._write_atomic(self.path(original_name), image_bytes)
        rectified = self._decode_data_url(rectified_data_url)
        if rectified and Image is not None:
            try:
                with Image.open(io.BytesIO(rectified)) as image:
                    preview = image.convert("RGB")
                    rectified_name = f"{page_id}.rectified.jpg"
                    preview_buffer = io.BytesIO()
                    preview.save(preview_buffer, "JPEG", quality=90, optimize=True)
                    self._write_atomic(self.path(rectified_name), preview_buffer.getvalue())
                    size = size if size[0] else preview.size
            except Exception:
                rectified_name = None
        return {
            "image_path": original_name,
            "thumb_path": thumb_name,
            "rectified_path": rectified_name,
            "width": size[0],
            "height": size[1],
        }

    @staticmethod
    def _decode_data_url(value: str | None) -> bytes | None:
        if not value or not isinstance(value, str):
            return None
        header, separator, payload = value.partition(",")
        if not separator or ";base64" not in header:
            return None
        try:
            return base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError):
            return None

    def delete(self, names: list[str] | tuple[str, ...]) -> None:
        for name in names:
            if not name:
                continue
            try:
                self.path(name).unlink(missing_ok=True)
            except (OSError, ValueError):
                continue

    def locate(self, name: str | None) -> Path | None:
        if not name:
            return None
        try:
            candidate = self.path(name)
        except ValueError:
            return None
        return candidate if candidate.is_file() else None
