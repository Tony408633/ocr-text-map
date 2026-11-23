"""Data-access layer for books, pages, notes, progress and reading statistics.

All SQL lives here so the HTTP layer stays thin and the same operations can be
tested without FastAPI. Rows are returned as JSON-ready dictionaries.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from . import config
from .db import Database, utcnow

BOOK_COLORS = {"jade", "amber", "indigo", "rose", "slate", "clay"}
SCOPES = {"line", "page"}
ACTIVITY_KINDS = {"read", "scan", "note", "session"}


class NotFound(LookupError):
    """Raised when a resource does not exist for the active profile."""


class Conflict(ValueError):
    """Raised when a request would violate a uniqueness rule."""


class ValidationError(ValueError):
    """Raised when input is well-formed JSON but semantically invalid."""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _now() -> str:
    return utcnow()


def _json(value: Any, default: Any) -> Any:
    if value is None or value == "":
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _like(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _clean_text(value: Any, field: str, *, max_length: int, required: bool = True) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise ValidationError(f"{field}不能为空。")
    if len(text) > max_length:
        raise ValidationError(f"{field}不能超过 {max_length} 个字符。")
    return text


def _clean_int(value: Any, field: str, *, low: int = 0, high: int = 10_000) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"{field}必须是整数。") from exc
    if number < low or number > high:
        raise ValidationError(f"{field}必须在 {low} 到 {high} 之间。")
    return number


def _page_summary(row: Any) -> dict:
    return {
        "id": row["id"],
        "book_id": row["book_id"],
        "page_number": row["page_number"],
        "line_count": row["line_count"],
        "confidence": round(float(row["confidence"] or 0), 4),
        "layout": row["layout"],
        "rotation": row["rotation"],
        "width": row["width"],
        "height": row["height"],
        "has_image": bool(row["image_path"]),
        "has_thumb": bool(row["thumb_path"]),
        "has_rectified": bool(row["rectified_path"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class Repository:
    def __init__(self, db: Database):
        self.db = db

    # ------------------------------------------------------------------
    # Profile and settings
    # ------------------------------------------------------------------
    def profile(self, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        with self.db.cursor() as cursor:
            cursor.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,))
            row = cursor.fetchone()
        if row is None:
            raise NotFound("找不到这个读者档案。")
        return {
            "id": row["id"],
            "name": row["name"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def rename_profile(self, name: str, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        clean = _clean_text(name, "称呼", max_length=40)
        with self.db.cursor(write=True) as cursor:
            cursor.execute(
                "UPDATE profiles SET name = ?, updated_at = ? WHERE id = ?",
                (clean, _now(), profile_id),
            )
        return self.profile(profile_id)

    def settings(self, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        merged = dict(config.DEFAULT_SETTINGS)
        with self.db.cursor() as cursor:
            cursor.execute("SELECT key, value FROM settings WHERE profile_id = ?", (profile_id,))
            for row in cursor.fetchall():
                merged[row["key"]] = _json(row["value"], row["value"])
        return merged

    def update_settings(
        self, payload: dict, profile_id: str = config.DEFAULT_PROFILE_ID
    ) -> dict:
        try:
            clean = config.valid_settings(payload)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc
        now = _now()
        with self.db.cursor(write=True) as cursor:
            for key, value in clean.items():
                cursor.execute(
                    "INSERT INTO settings(profile_id, key, value) VALUES(?, ?, ?) "
                    "ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value",
                    (profile_id, key, json.dumps(value, ensure_ascii=False)),
                )
            cursor.execute(
                "UPDATE profiles SET updated_at = ? WHERE id = ?", (now, profile_id)
            )
        return self.settings(profile_id)

    # ------------------------------------------------------------------
    # Books
    # ------------------------------------------------------------------
    def list_books(
        self,
        profile_id: str = config.DEFAULT_PROFILE_ID,
        *,
        archived: bool | None = False,
    ) -> list[dict]:
        where = ["b.profile_id = ?"]
        params: list[Any] = [profile_id]
        if archived is not None:
            where.append("b.archived = ?")
            params.append(1 if archived else 0)
        clause = " AND ".join(where)
        with self.db.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT b.*,
                       (SELECT COUNT(*) FROM pages p WHERE p.book_id = b.id) AS page_count,
                       (SELECT COUNT(*) FROM notes n WHERE n.book_id = b.id) AS note_count,
                       pr.page_number AS last_page,
                       pr.line_index  AS last_line,
                       pr.updated_at  AS last_read_at
                  FROM books b
                  LEFT JOIN progress pr
                         ON pr.book_id = b.id AND pr.profile_id = b.profile_id
                 WHERE {clause}
              ORDER BY COALESCE(pr.updated_at, b.updated_at) DESC, b.created_at DESC
                """,
                params,
            )
            return [self._book_row(row) for row in cursor.fetchall()]

    def get_book(self, book_id: str, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        with self.db.cursor() as cursor:
            cursor.execute(
                """
                SELECT b.*,
                       (SELECT COUNT(*) FROM pages p WHERE p.book_id = b.id) AS page_count,
                       (SELECT COUNT(*) FROM notes n WHERE n.book_id = b.id) AS note_count,
                       pr.page_number AS last_page,
                       pr.line_index  AS last_line,
                       pr.updated_at  AS last_read_at
                  FROM books b
                  LEFT JOIN progress pr
                         ON pr.book_id = b.id AND pr.profile_id = b.profile_id
                 WHERE b.id = ? AND b.profile_id = ?
                """,
                (book_id, profile_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise NotFound("找不到这本书。")
            book = self._book_row(row)

            cursor.execute(
                "SELECT * FROM pages WHERE book_id = ? ORDER BY page_number", (book_id,)
            )
            book["pages"] = [_page_summary(page) for page in cursor.fetchall()]
        return book

    @staticmethod
    def _book_row(row: Any) -> dict:
        return {
            "id": row["id"],
            "title": row["title"],
            "author": row["author"],
            "color": row["color"],
            "demo": bool(row["demo"]),
            "archived": bool(row["archived"]),
            "page_count": int(row["page_count"]),
            "note_count": int(row["note_count"]),
            "last_page": row["last_page"],
            "last_line": row["last_line"],
            "last_read_at": row["last_read_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def create_book(
        self,
        title: str,
        author: str = "",
        *,
        color: str = "jade",
        profile_id: str = config.DEFAULT_PROFILE_ID,
    ) -> dict:
        clean_title = _clean_text(title, "书名", max_length=120)
        clean_author = _clean_text(author, "作者", max_length=80, required=False)
        if color not in BOOK_COLORS:
            raise ValidationError("书封颜色不在可选范围内。")
        book_id = new_id("bk")
        now = _now()
        with self.db.cursor(write=True) as cursor:
            cursor.execute(
                "INSERT INTO books(id, profile_id, title, author, color, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (book_id, profile_id, clean_title, clean_author, color, now, now),
            )
        return self.get_book(book_id, profile_id)

    def update_book(
        self,
        book_id: str,
        payload: dict,
        profile_id: str = config.DEFAULT_PROFILE_ID,
    ) -> dict:
        book = self.get_book(book_id, profile_id)
        title = _clean_text(payload.get("title", book["title"]), "书名", max_length=120)
        author = _clean_text(
            payload.get("author", book["author"]), "作者", max_length=80, required=False
        )
        color = payload.get("color", book["color"])
        if color not in BOOK_COLORS:
            raise ValidationError("书封颜色不在可选范围内。")
        archived = bool(payload.get("archived", book["archived"]))
        with self.db.cursor(write=True) as cursor:
            cursor.execute(
                "UPDATE books SET title = ?, author = ?, color = ?, archived = ?, updated_at = ? "
                "WHERE id = ? AND profile_id = ?",
                (title, author, color, 1 if archived else 0, _now(), book_id, profile_id),
            )
        return self.get_book(book_id, profile_id)

    def delete_book(self, book_id: str, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        book = self.get_book(book_id, profile_id)
        with self.db.cursor(write=True) as cursor:
            cursor.execute(
                "DELETE FROM books WHERE id = ? AND profile_id = ?", (book_id, profile_id)
            )
        return {"deleted": True, "book_id": book["id"], "title": book["title"]}

    def touch_book(self, book_id: str) -> None:
        with self.db.cursor(write=True) as cursor:
            cursor.execute("UPDATE books SET updated_at = ? WHERE id = ?", (_now(), book_id))

    # ------------------------------------------------------------------
    # Pages
    # ------------------------------------------------------------------
    def get_page(self, page_id: str, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        with self.db.cursor() as cursor:
            cursor.execute(
                """
                SELECT p.*, b.title AS book_title, b.author AS book_author,
                       b.color AS book_color, b.demo AS book_demo
                  FROM pages p JOIN books b ON b.id = p.book_id
                 WHERE p.id = ? AND b.profile_id = ?
                """,
                (page_id, profile_id),
            )
            row = cursor.fetchone()
            if row is None:
                raise NotFound("找不到这一页。")
            page = self._page_row(row)
            cursor.execute(
                "SELECT reading_order, text, confidence, region_id, block_id, bbox "
                "FROM page_lines WHERE page_id = ? ORDER BY reading_order",
                (page_id,),
            )
            page["lines"] = [
                {
                    "reading_order": line["reading_order"],
                    "text": line["text"],
                    "confidence": round(float(line["confidence"] or 0), 4),
                    "region_id": line["region_id"],
                    "block_id": line["block_id"],
                    "bbox": _json(line["bbox"], []),
                }
                for line in cursor.fetchall()
            ]
        return page

    def find_page(
        self, book_id: str, page_number: int, profile_id: str = config.DEFAULT_PROFILE_ID
    ) -> dict | None:
        with self.db.cursor() as cursor:
            cursor.execute(
                "SELECT p.id FROM pages p JOIN books b ON b.id = p.book_id "
                "WHERE p.book_id = ? AND p.page_number = ? AND b.profile_id = ?",
                (book_id, page_number, profile_id),
            )
            row = cursor.fetchone()
        return self.get_page(row["id"], profile_id) if row else None

    def recent_page_texts(
        self, book_id: str, limit: int = 8, profile_id: str = config.DEFAULT_PROFILE_ID
    ) -> list[dict]:
        """最近几页的文字，用于自动扫描时判断"是不是同一页"。"""
        with self.db.cursor() as cursor:
            cursor.execute(
                """
                SELECT p.page_number, p.text
                  FROM pages p JOIN books b ON b.id = p.book_id
                 WHERE p.book_id = ? AND b.profile_id = ?
                 ORDER BY p.page_number DESC
                 LIMIT ?
                """,
                (book_id, profile_id, max(1, int(limit))),
            )
            return [
                {"page_number": row["page_number"], "text": row["text"] or ""}
                for row in cursor.fetchall()
            ]


    @staticmethod
    def _page_row(row: Any) -> dict:
        return {
            "id": row["id"],
            "book_id": row["book_id"],
            "book_title": row["book_title"],
            "book_author": row["book_author"],
            "book_color": row["book_color"],
            "book_demo": bool(row["book_demo"]),
            "page_number": row["page_number"],
            "document_id": row["document_id"],
            "width": row["width"],
            "height": row["height"],
            "line_count": row["line_count"],
            "text": row["text"],
            "confidence": round(float(row["confidence"] or 0), 4),
            "layout": row["layout"],
            "rotation": row["rotation"],
            "warnings": _json(row["warnings"], []),
            "timing_ms": _json(row["timing_ms"], {}),
            "has_image": bool(row["image_path"]),
            "has_thumb": bool(row["thumb_path"]),
            "has_rectified": bool(row["rectified_path"]),
            "image_url": f"{config.API_PREFIX}/pages/{row['id']}/image" if row["image_path"] else None,
            "thumb_url": f"{config.API_PREFIX}/pages/{row['id']}/image?kind=thumb" if row["thumb_path"] else None,
            "rectified_url": (
                f"{config.API_PREFIX}/pages/{row['id']}/image?kind=rectified"
                if row["rectified_path"]
                else None
            ),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def save_page(
        self,
        book_id: str,
        page_number: int,
        *,
        profile_id: str = config.DEFAULT_PROFILE_ID,
        result: dict,
        lines: Iterable[dict],
        image_path: str | None,
        thumb_path: str | None,
        rectified_path: str | None,
        layout: str,
        rotation: int,
        page_id_hint: str | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> dict:
        """Insert or replace the OCR result for one book page.

        The existing page id is reused so notes anchored to this page survive a
        rescan. Old image files are reported back to the caller for cleanup.
        """
        self.get_book(book_id, profile_id)  # ownership check
        page_number = _clean_int(page_number, "页码", low=1, high=99_999)
        lines = list(lines)
        text = "\n".join(str(line.get("text", "")) for line in lines)
        confidence = 0.0
        if lines:
            confidence = sum(float(line.get("confidence") or 0) for line in lines) / len(lines)
        warnings = result.get("warnings") or []
        timing = result.get("timing_ms") or {}
        now = _now()
        old_paths: list[str] = []
        source_size = result.get("source_size") or [0, 0]
        page_width = int(width or (source_size[0] if len(source_size) > 0 else 0))
        page_height = int(height or (source_size[1] if len(source_size) > 1 else 0))

        with self.db.cursor(write=True) as cursor:
            cursor.execute(
                "SELECT id, image_path, thumb_path, rectified_path FROM pages "
                "WHERE book_id = ? AND page_number = ?",
                (book_id, page_number),
            )
            existing = cursor.fetchone()
            if existing:
                page_id = existing["id"]
                old_paths = [
                    path
                    for path in (existing["image_path"], existing["thumb_path"], existing["rectified_path"])
                    if path
                ]
                cursor.execute(
                    """
                    UPDATE pages
                       SET document_id = ?, image_path = ?, thumb_path = ?, rectified_path = ?,
                           width = ?, height = ?, line_count = ?, text = ?, confidence = ?,
                           layout = ?, rotation = ?, warnings = ?, timing_ms = ?, updated_at = ?
                     WHERE id = ?
                    """,
                    (
                        str(result.get("document_id") or ""),
                        image_path,
                        thumb_path,
                        rectified_path,
                        page_width,
                        page_height,
                        len(lines),
                        text,
                        round(confidence, 4),
                        layout,
                        rotation,
                        json.dumps(warnings, ensure_ascii=False),
                        json.dumps(timing, ensure_ascii=False),
                        now,
                        page_id,
                    ),
                )
                cursor.execute("DELETE FROM page_lines WHERE page_id = ?", (page_id,))
            else:
                page_id = page_id_hint or new_id("pg")
                cursor.execute(
                    """
                    INSERT INTO pages(id, book_id, page_number, document_id, image_path, thumb_path,
                                      rectified_path, width, height, line_count, text, confidence,
                                      layout, rotation, warnings, timing_ms, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        page_id,
                        book_id,
                        page_number,
                        str(result.get("document_id") or ""),
                        image_path,
                        thumb_path,
                        rectified_path,
                        page_width,
                        page_height,
                        len(lines),
                        text,
                        round(confidence, 4),
                        layout,
                        rotation,
                        json.dumps(warnings, ensure_ascii=False),
                        json.dumps(timing, ensure_ascii=False),
                        now,
                        now,
                    ),
                )
            for index, line in enumerate(lines, 1):
                cursor.execute(
                    "INSERT INTO page_lines(page_id, reading_order, text, confidence, region_id, block_id, bbox) "
                    "VALUES(?, ?, ?, ?, ?, ?, ?)",
                    (
                        page_id,
                        index,
                        str(line.get("text", "")),
                        float(line.get("confidence") or 0),
                        str(line.get("region_id") or ""),
                        str(line.get("block_id") or ""),
                        json.dumps(line.get("bbox") or [], ensure_ascii=False),
                    ),
                )
            cursor.execute(
                "INSERT INTO progress(profile_id, book_id, page_number, line_index, updated_at) "
                "VALUES(?, ?, ?, 0, ?) "
                "ON CONFLICT(profile_id, book_id) DO UPDATE SET "
                "page_number = excluded.page_number, line_index = 0, updated_at = excluded.updated_at",
                (profile_id, book_id, page_number, now),
            )
            cursor.execute("UPDATE books SET updated_at = ? WHERE id = ?", (now, book_id))
        page = self.get_page(page_id, profile_id)
        page["old_paths"] = old_paths
        return page

    def delete_page(self, page_id: str, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        page = self.get_page(page_id, profile_id)
        with self.db.cursor(write=True) as cursor:
            cursor.execute("DELETE FROM pages WHERE id = ?", (page_id,))
        return {"deleted": True, "page_id": page_id, "book_id": page["book_id"]}

    def page_paths(self, page_id: str) -> dict:
        with self.db.cursor() as cursor:
            cursor.execute(
                "SELECT image_path, thumb_path, rectified_path FROM pages WHERE id = ?", (page_id,)
            )
            row = cursor.fetchone()
        if row is None:
            raise NotFound("找不到这一页。")
        return {
            "image": row["image_path"],
            "thumb": row["thumb_path"],
            "rectified": row["rectified_path"],
        }

    # ------------------------------------------------------------------
    # Notes
    # ------------------------------------------------------------------
    def list_notes(
        self,
        profile_id: str = config.DEFAULT_PROFILE_ID,
        *,
        book_id: str | None = None,
        query: str | None = None,
        scope: str | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> dict:
        where = ["n.profile_id = ?"]
        params: list[Any] = [profile_id]
        if book_id:
            where.append("n.book_id = ?")
            params.append(book_id)
        if scope:
            if scope not in SCOPES:
                raise ValidationError("批注范围必须是 line 或 page。")
            where.append("n.scope = ?")
            params.append(scope)
        if query:
            where.append(
                "(n.text LIKE ? ESCAPE '\\' OR b.title LIKE ? ESCAPE '\\' "
                "OR CAST(n.page_number AS TEXT) LIKE ? ESCAPE '\\')"
            )
            params.extend([_like(query)] * 3)
        clause = " AND ".join(where)
        with self.db.cursor() as cursor:
            cursor.execute(
                f"SELECT COUNT(*) AS n FROM notes n LEFT JOIN books b ON b.id = n.book_id WHERE {clause}",
                params,
            )
            total = int(cursor.fetchone()["n"])
            cursor.execute(
                f"""
                SELECT n.*, b.title AS book_title, b.color AS book_color, b.demo AS book_demo
                  FROM notes n LEFT JOIN books b ON b.id = n.book_id
                 WHERE {clause}
              ORDER BY n.updated_at DESC
                 LIMIT ? OFFSET ?
                """,
                [*params, max(1, min(limit, 500)), max(0, offset)],
            )
            notes = [self._note_row(row) for row in cursor.fetchall()]
        return {"notes": notes, "total": total}

    @staticmethod
    def _note_row(row: Any) -> dict:
        return {
            "id": row["id"],
            "book_id": row["book_id"],
            "book_title": row["book_title"] or "已删除的书",
            "book_color": row["book_color"] or "slate",
            "page_id": row["page_id"],
            "page_number": row["page_number"],
            "line_number": row["line_number"],
            "scope": row["scope"],
            "text": row["text"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def create_note(
        self,
        payload: dict,
        profile_id: str = config.DEFAULT_PROFILE_ID,
    ) -> dict:
        text = _clean_text(payload.get("text"), "批注内容", max_length=4000)
        scope = payload.get("scope", "line")
        if scope not in SCOPES:
            raise ValidationError("批注范围必须是 line 或 page。")
        book_id = payload.get("book_id")
        if not book_id:
            raise ValidationError("批注必须关联一本书。")
        book = self.get_book(str(book_id), profile_id)
        page_number = _clean_int(payload.get("page_number", 1), "页码", low=1, high=99_999)
        line_number = payload.get("line_number")
        if scope == "line":
            if line_number is None:
                raise ValidationError("行批注需要行号。")
            line_number = _clean_int(line_number, "行号", low=1, high=100_000)
        else:
            line_number = None
        page_id = payload.get("page_id")
        if page_id:
            page = self.get_page(str(page_id), profile_id)
            if page["book_id"] != book["id"]:
                raise ValidationError("这一页不属于所选书籍。")
        else:
            page = self.find_page(book["id"], page_number, profile_id)
            page_id = page["id"] if page else None
        note_id = new_id("nt")
        now = _now()
        with self.db.cursor(write=True) as cursor:
            cursor.execute(
                "INSERT INTO notes(id, profile_id, book_id, page_id, page_number, line_number, scope, "
                "text, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (note_id, profile_id, book["id"], page_id, page_number, line_number, scope, text, now, now),
            )
        return self.get_note(note_id, profile_id)

    def get_note(self, note_id: str, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        with self.db.cursor() as cursor:
            cursor.execute(
                "SELECT n.*, b.title AS book_title, b.color AS book_color, b.demo AS book_demo "
                "FROM notes n LEFT JOIN books b ON b.id = n.book_id "
                "WHERE n.id = ? AND n.profile_id = ?",
                (note_id, profile_id),
            )
            row = cursor.fetchone()
        if row is None:
            raise NotFound("找不到这条批注。")
        return self._note_row(row)

    def update_note(
        self,
        note_id: str,
        payload: dict,
        profile_id: str = config.DEFAULT_PROFILE_ID,
    ) -> dict:
        note = self.get_note(note_id, profile_id)
        text = _clean_text(payload.get("text", note["text"]), "批注内容", max_length=4000)
        scope = payload.get("scope", note["scope"])
        if scope not in SCOPES:
            raise ValidationError("批注范围必须是 line 或 page。")
        page_number = _clean_int(
            payload.get("page_number", note["page_number"]), "页码", low=1, high=99_999
        )
        line_number = payload.get("line_number", note["line_number"])
        if scope == "line":
            if line_number is None:
                raise ValidationError("行批注需要行号。")
            line_number = _clean_int(line_number, "行号", low=1, high=100_000)
        else:
            line_number = None
        with self.db.cursor(write=True) as cursor:
            cursor.execute(
                "UPDATE notes SET text = ?, scope = ?, page_number = ?, line_number = ?, updated_at = ? "
                "WHERE id = ? AND profile_id = ?",
                (text, scope, page_number, line_number, _now(), note_id, profile_id),
            )
        return self.get_note(note_id, profile_id)

    def delete_note(self, note_id: str, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        note = self.get_note(note_id, profile_id)
        with self.db.cursor(write=True) as cursor:
            cursor.execute("DELETE FROM notes WHERE id = ? AND profile_id = ?", (note_id, profile_id))
        return {"deleted": True, "note_id": note_id, "book_id": note["book_id"]}

    # ------------------------------------------------------------------
    # Progress and activity
    # ------------------------------------------------------------------
    def progress(self, profile_id: str = config.DEFAULT_PROFILE_ID) -> list[dict]:
        with self.db.cursor() as cursor:
            cursor.execute(
                "SELECT pr.*, b.title AS book_title, b.color AS book_color, "
                "p.line_count AS page_line_count "
                "FROM progress pr JOIN books b ON b.id = pr.book_id "
                "LEFT JOIN pages p ON p.book_id = pr.book_id AND p.page_number = pr.page_number "
                "WHERE pr.profile_id = ? ORDER BY pr.updated_at DESC",
                (profile_id,),
            )
            return [self._progress_row(row) for row in cursor.fetchall()]

    @staticmethod
    def _progress_row(row: Any) -> dict:
        return {
            "book_id": row["book_id"],
            "book_title": row["book_title"],
            "book_color": row["book_color"],
            "page_number": row["page_number"],
            "line_index": row["line_index"],
            "page_line_count": row["page_line_count"] or 0,
            "updated_at": row["updated_at"],
        }

    def save_progress(
        self,
        payload: dict,
        profile_id: str = config.DEFAULT_PROFILE_ID,
    ) -> dict:
        book_id = str(payload.get("book_id") or "")
        if not book_id:
            raise ValidationError("缺少 book_id。")
        book = self.get_book(book_id, profile_id)
        page_number = _clean_int(payload.get("page_number", 1), "页码", low=1, high=99_999)
        line_index = _clean_int(payload.get("line_index", 0), "行索引", low=0, high=100_000)
        now = _now()
        with self.db.cursor(write=True) as cursor:
            cursor.execute(
                "INSERT INTO progress(profile_id, book_id, page_number, line_index, updated_at) "
                "VALUES(?, ?, ?, ?, ?) ON CONFLICT(profile_id, book_id) DO UPDATE SET "
                "page_number = excluded.page_number, line_index = excluded.line_index, "
                "updated_at = excluded.updated_at",
                (profile_id, book["id"], page_number, line_index, now),
            )
            cursor.execute("UPDATE books SET updated_at = ? WHERE id = ?", (now, book["id"]))
        return {
            "book_id": book["id"],
            "book_title": book["title"],
            "page_number": page_number,
            "line_index": line_index,
            "updated_at": now,
        }

    def record_activity(
        self,
        payload: dict,
        profile_id: str = config.DEFAULT_PROFILE_ID,
    ) -> dict:
        kind = str(payload.get("kind") or "read")
        if kind not in ACTIVITY_KINDS:
            raise ValidationError("活动类型无效。")
        seconds = _clean_int(payload.get("seconds", 0), "时长", low=0, high=3600)
        lines = _clean_int(payload.get("lines", 0), "行数", low=0, high=100_000)
        book_id = payload.get("book_id")
        if book_id:
            self.get_book(str(book_id), profile_id)
        page_number = payload.get("page_number")
        if page_number is not None:
            page_number = _clean_int(page_number, "页码", low=1, high=99_999)
        with self.db.cursor(write=True) as cursor:
            cursor.execute(
                "INSERT INTO activity(profile_id, kind, book_id, page_number, lines, seconds, created_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (profile_id, kind, book_id, page_number, lines, seconds, _now()),
            )
        return {"recorded": True, "kind": kind, "seconds": seconds, "lines": lines}

    # ------------------------------------------------------------------
    # Statistics
    # ------------------------------------------------------------------
    def stats(self, profile_id: str = config.DEFAULT_PROFILE_ID, *, days: int = 14) -> dict:
        days = max(1, min(int(days), 90))
        today = date.today()
        start = today - timedelta(days=days - 1)
        with self.db.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS books FROM books WHERE profile_id = ? AND archived = 0",
                (profile_id,),
            )
            books = int(cursor.fetchone()["books"])
            cursor.execute(
                "SELECT COUNT(*) AS pages, COALESCE(SUM(line_count), 0) AS lines FROM pages p "
                "JOIN books b ON b.id = p.book_id WHERE b.profile_id = ?",
                (profile_id,),
            )
            page_row = cursor.fetchone()
            cursor.execute(
                "SELECT COUNT(*) AS notes FROM notes WHERE profile_id = ?", (profile_id,)
            )
            notes = int(cursor.fetchone()["notes"])
            cursor.execute(
                "SELECT COALESCE(SUM(seconds), 0) AS seconds FROM activity WHERE profile_id = ?",
                (profile_id,),
            )
            reading_seconds = int(cursor.fetchone()["seconds"])
            cursor.execute(
                "SELECT substr(created_at, 1, 10) AS day, "
                "       COALESCE(SUM(lines), 0) AS lines, "
                "       COALESCE(SUM(seconds), 0) AS seconds, "
                "       COUNT(*) AS events "
                "  FROM activity "
                " WHERE profile_id = ? AND created_at >= ? "
                " GROUP BY day ORDER BY day",
                (profile_id, start.isoformat()),
            )
            rows = cursor.fetchall()

        by_day = {row["day"]: row for row in rows}
        daily = []
        for offset in range(days):
            day = (start + timedelta(days=offset)).isoformat()
            row = by_day.get(day)
            daily.append(
                {
                    "date": day,
                    "lines": int(row["lines"]) if row else 0,
                    "seconds": int(row["seconds"]) if row else 0,
                    "events": int(row["events"]) if row else 0,
                }
            )
        streak = self._streak(by_day, today)
        today_row = by_day.get(today.isoformat())
        return {
            "books": books,
            "pages": int(page_row["pages"]),
            "lines": int(page_row["lines"]),
            "notes": notes,
            "reading_seconds": reading_seconds,
            "streak_days": streak,
            "today": {
                "date": today.isoformat(),
                "lines": int(today_row["lines"]) if today_row else 0,
                "seconds": int(today_row["seconds"]) if today_row else 0,
            },
            "daily": daily,
        }

    @staticmethod
    def _streak(by_day: dict, today: date) -> int:
        count = 0
        cursor = today
        if cursor.isoformat() not in by_day:
            cursor = today - timedelta(days=1)
        while cursor.isoformat() in by_day:
            count += 1
            cursor -= timedelta(days=1)
        return count

    # ------------------------------------------------------------------
    # Backup, restore and reset
    # ------------------------------------------------------------------
    def export_all(self, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        profile = self.profile(profile_id)
        books = []
        for book in self.list_books(profile_id, archived=None):
            full = self.get_book(book["id"], profile_id)
            full["pages"] = [
                self.get_page(page["id"], profile_id) for page in full["pages"]
            ]
            books.append(full)
        notes = self.list_notes(profile_id, limit=500)["notes"]
        return {
            "format": "paperpal-export",
            "version": 1,
            "exported_at": _now(),
            "profile": profile,
            "settings": self.settings(profile_id),
            "books": books,
            "notes": notes,
            "progress": self.progress(profile_id),
        }

    def import_data(
        self,
        payload: dict,
        profile_id: str = config.DEFAULT_PROFILE_ID,
        *,
        mode: str = "merge",
    ) -> dict:
        if not isinstance(payload, dict):
            raise ValidationError("导入文件格式不正确。")
        if mode not in {"merge", "replace"}:
            raise ValidationError("导入模式必须是 merge 或 replace。")
        books_in = payload.get("books") or []
        notes_in = payload.get("notes") or []
        progress_in = payload.get("progress") or []
        settings_in = payload.get("settings") or {}
        if not isinstance(books_in, list) or not isinstance(notes_in, list):
            raise ValidationError("导入文件缺少 books 或 notes 列表。")
        if len(books_in) > 500 or len(notes_in) > 20_000:
            raise ValidationError("导入内容过多。")

        imported = {"books": 0, "pages": 0, "notes": 0}
        book_map: dict[str, str] = {}
        with self.db.cursor(write=True) as cursor:
            if mode == "replace":
                cursor.execute(
                    "DELETE FROM notes WHERE profile_id = ?", (profile_id,)
                )
                cursor.execute(
                    "DELETE FROM books WHERE profile_id = ?", (profile_id,)
                )
            now = _now()
            for book in books_in:
                if not isinstance(book, dict):
                    continue
                title = _clean_text(book.get("title"), "书名", max_length=120)
                author = _clean_text(book.get("author"), "作者", max_length=80, required=False)
                color = book.get("color") if book.get("color") in BOOK_COLORS else "jade"
                old_id = str(book.get("id") or "")
                book_id = new_id("bk")
                cursor.execute(
                    "INSERT INTO books(id, profile_id, title, author, color, demo, archived, "
                    "created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        book_id,
                        profile_id,
                        title,
                        author,
                        color,
                        1 if book.get("demo") else 0,
                        1 if book.get("archived") else 0,
                        now,
                        now,
                    ),
                )
                imported["books"] += 1
                if old_id:
                    book_map[old_id] = book_id
                for page in book.get("pages") or []:
                    if not isinstance(page, dict):
                        continue
                    page_number = _clean_int(page.get("page_number", 1), "页码", low=1, high=99_999)
                    lines = page.get("lines") if isinstance(page.get("lines"), list) else []
                    page_id = new_id("pg")
                    text = "\n".join(str(line.get("text", "")) for line in lines if isinstance(line, dict))
                    confidence = page.get("confidence") or 0
                    cursor.execute(
                        "INSERT INTO pages(id, book_id, page_number, document_id, width, height, "
                        "line_count, text, confidence, layout, rotation, warnings, timing_ms, "
                        "created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            page_id,
                            book_id,
                            page_number,
                            str(page.get("document_id") or ""),
                            int(page.get("width") or 0),
                            int(page.get("height") or 0),
                            len(lines),
                            text,
                            float(confidence or 0),
                            str(page.get("layout") or "none"),
                            int(page.get("rotation") or 0),
                            json.dumps(page.get("warnings") or [], ensure_ascii=False),
                            json.dumps(page.get("timing_ms") or {}, ensure_ascii=False),
                            now,
                            now,
                        ),
                    )
                    for index, line in enumerate(lines, 1):
                        if not isinstance(line, dict):
                            continue
                        cursor.execute(
                            "INSERT INTO page_lines(page_id, reading_order, text, confidence, "
                            "region_id, block_id, bbox) VALUES(?, ?, ?, ?, ?, ?, ?)",
                            (
                                page_id,
                                index,
                                str(line.get("text", "")),
                                float(line.get("confidence") or 0),
                                str(line.get("region_id") or ""),
                                str(line.get("block_id") or ""),
                                json.dumps(line.get("bbox") or [], ensure_ascii=False),
                            ),
                        )
                    imported["pages"] += 1

            for note in notes_in:
                if not isinstance(note, dict):
                    continue
                text = _clean_text(note.get("text"), "批注内容", max_length=4000)
                scope = note.get("scope") if note.get("scope") in SCOPES else "page"
                book_id = book_map.get(str(note.get("book_id") or ""))
                if book_id:
                    cursor.execute(
                        "SELECT id FROM pages WHERE book_id = ? AND page_number = ?",
                        (book_id, int(note.get("page_number") or 1)),
                    )
                    row = cursor.fetchone()
                    page_id = row["id"] if row else None
                else:
                    page_id = None
                cursor.execute(
                    "INSERT INTO notes(id, profile_id, book_id, page_id, page_number, line_number, "
                    "scope, text, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        new_id("nt"),
                        profile_id,
                        book_id,
                        page_id,
                        int(note.get("page_number") or 1),
                        note.get("line_number"),
                        scope,
                        text,
                        str(note.get("created_at") or now),
                        str(note.get("updated_at") or now),
                    ),
                )
                imported["notes"] += 1

            for entry in progress_in:
                if not isinstance(entry, dict):
                    continue
                book_id = book_map.get(str(entry.get("book_id") or ""))
                if not book_id:
                    continue
                cursor.execute(
                    "INSERT INTO progress(profile_id, book_id, page_number, line_index, updated_at) "
                    "VALUES(?, ?, ?, ?, ?) ON CONFLICT(profile_id, book_id) DO UPDATE SET "
                    "page_number = excluded.page_number, line_index = excluded.line_index, "
                    "updated_at = excluded.updated_at",
                    (
                        profile_id,
                        book_id,
                        int(entry.get("page_number") or 1),
                        int(entry.get("line_index") or 0),
                        str(entry.get("updated_at") or now),
                    ),
                )
        if settings_in:
            try:
                self.update_settings(dict(settings_in), profile_id)
            except ValueError:
                pass
        return imported

    def clear_data(self, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        with self.db.cursor(write=True) as cursor:
            cursor.execute("DELETE FROM notes WHERE profile_id = ?", (profile_id,))
            cursor.execute("DELETE FROM books WHERE profile_id = ?", (profile_id,))
            cursor.execute("DELETE FROM progress WHERE profile_id = ?", (profile_id,))
            cursor.execute("DELETE FROM activity WHERE profile_id = ?", (profile_id,))
        return {"cleared": True}

    def summary(self, profile_id: str = config.DEFAULT_PROFILE_ID) -> dict:
        with self.db.cursor() as cursor:
            cursor.execute(
                "SELECT (SELECT COUNT(*) FROM books WHERE profile_id = ?) AS books, "
                "(SELECT COUNT(*) FROM notes WHERE profile_id = ?) AS notes",
                (profile_id, profile_id),
            )
            row = cursor.fetchone()
        return {"books": int(row["books"]), "notes": int(row["notes"])}


_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def valid_date(value: str) -> bool:
    return bool(_ISO_RE.match(value))


def parse_datetime(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
