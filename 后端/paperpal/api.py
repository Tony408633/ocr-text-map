"""FastAPI application: JSON API, OCR integration and static app hosting.

Run with ``python -m paperpal serve``. The legacy ``/api/ocr`` and
``/api/health`` routes from the original OCR service remain available so the
debug page under ``/static`` keeps working.
"""

from __future__ import annotations

import hmac
import json
import mimetypes
import os
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import __version__, config
from .db import Database
from .ocr import OCRBusy, OCRInputError, OCRService, OCRUnavailable
from .repository import (
    Conflict,
    NotFound,
    Repository,
    ValidationError,
    new_id,
)
from .storage import ImageStore
from .text import TextTransformError, TranslationUnavailable, transform as transform_text

ACCEPTED_IMAGE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/octet-stream",
    "",
}
NO_STORE = {"Cache-Control": "no-store"}


def _error(message: str, *, code: str = "error") -> dict[str, str]:
    return {"error": message, "code": code}


def _client_profile(request: Request) -> str:
    requested = (request.headers.get("x-paperpal-profile") or "").strip()
    return requested or config.DEFAULT_PROFILE_ID


def _require_auth(request: Request) -> None:
    expected = config.auth_token()
    if not expected:
        return
    header = request.headers.get("authorization", "")
    supplied = header[7:].strip() if header.lower().startswith("bearer ") else ""
    if not supplied:
        supplied = request.headers.get("x-paperpal-token", "").strip()
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="访问令牌无效或缺失。")


async def _read_image(request: Request) -> bytes:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in ACCEPTED_IMAGE_TYPES:
        raise HTTPException(
            status_code=415,
            detail="请发送 JPEG、PNG 或 WebP 图像的原始二进制数据。",
        )
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            length = int(content_length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="图像数据长度无效。") from exc
        if length < 0:
            raise HTTPException(status_code=400, detail="图像数据长度无效。")
        if length > config.MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=413,
                detail="原始照片不能超过 8 MiB，请压缩图片后重试。",
            )
    body = bytearray()
    try:
        async for chunk in request.stream():
            if len(body) + len(chunk) > config.MAX_IMAGE_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="原始照片不能超过 8 MiB，请压缩图片后重试。",
                )
            body.extend(chunk)
    except HTTPException:
        raise
    except Exception as exc:  # client disconnected mid-upload
        raise HTTPException(status_code=400, detail="图像上传已中断，请重新上传照片。") from exc
    if not body:
        raise HTTPException(status_code=400, detail="图像数据为空，请选择照片后重试。")
    return bytes(body)


def _page_payload(page: dict) -> dict:
    """Add convenience fields for the frontend without leaking file names."""
    page = dict(page)
    page.pop("old_paths", None)
    page["line_count"] = len(page.get("lines", []))
    return page


def create_app(
    *,
    db: Database | None = None,
    ocr: OCRService | None = None,
    images: ImageStore | None = None,
    seed_demo: bool | None = None,
) -> FastAPI:
    database = db or Database()
    service = ocr or OCRService()
    store = images or ImageStore()
    repository = Repository(database)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        config.ensure_dirs()
        database.initialize(seed_demo=seed_demo)
        yield

    app = FastAPI(
        title="纸伴 PaperPal API",
        version=__version__,
        description=(
            "语音优先纸书阅读应用的后端：书架、书页 OCR、批注、阅读进度与统计。"
            "摄影照片只保存到本机 data 目录。"
        ),
        lifespan=lifespan,
    )
    app.state.db = database
    app.state.repo = repository
    app.state.ocr = service
    app.state.images = store

    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )

    @app.middleware("http")
    async def secure_headers(request: Request, call_next):
        length = request.headers.get("content-length")
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if (
            request.method in {"POST", "PUT", "PATCH"}
            and content_type == "application/json"
            and length
            and length.isdigit()
            and int(length) > config.MAX_JSON_BYTES
        ):
            return JSONResponse(
                _error("请求内容过大。", code="too_large"),
                status_code=413,
                headers=NO_STORE,
            )
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(self), microphone=(self), geolocation=()"
        )
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        elif request.url.path.startswith("/app-assets/"):
            response.headers.setdefault("Cache-Control", "no-cache")
        if (
            request.url.path == "/"
            and response.headers.get("content-type", "").startswith("text/html")
        ):
            response.headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' blob: data:; media-src 'self' blob:; font-src 'self'; "
                "connect-src 'self'; worker-src 'self'; manifest-src 'self'; "
                "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
            )
        return response

    # ------------------------------------------------------------------
    # Error handling
    # ------------------------------------------------------------------
    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        fields = []
        for item in exc.errors():
            loc = [str(part) for part in item.get("loc", []) if part not in ("body", "query", "path")]
            fields.append(".".join(loc) or "参数")
        message = "请求参数不正确：" + "、".join(sorted(set(fields)))
        return JSONResponse(_error(message, code="invalid_request"), status_code=422, headers=NO_STORE)

    @app.exception_handler(HTTPException)
    async def http_error_handler(request: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else "请求未能完成。"
        return JSONResponse(
            _error(detail, code=f"http_{exc.status_code}"),
            status_code=exc.status_code,
            headers=NO_STORE,
        )

    @app.exception_handler(NotFound)
    async def not_found_handler(request: Request, exc: NotFound):
        return JSONResponse(_error(str(exc), code="not_found"), status_code=404, headers=NO_STORE)

    @app.exception_handler(ValidationError)
    async def validation_error_handler(request: Request, exc: ValidationError):
        return JSONResponse(_error(str(exc), code="invalid"), status_code=422, headers=NO_STORE)

    @app.exception_handler(Conflict)
    async def conflict_handler(request: Request, exc: Conflict):
        return JSONResponse(_error(str(exc), code="conflict"), status_code=409, headers=NO_STORE)

    @app.exception_handler(OCRUnavailable)
    async def ocr_unavailable_handler(request: Request, exc: OCRUnavailable):
        return JSONResponse(_error(str(exc), code="ocr_unavailable"), status_code=503, headers=NO_STORE)

    @app.exception_handler(OCRBusy)
    async def ocr_busy_handler(request: Request, exc: OCRBusy):
        return JSONResponse(_error(str(exc), code="ocr_busy"), status_code=503, headers=NO_STORE)

    @app.exception_handler(OCRInputError)
    async def ocr_input_handler(request: Request, exc: OCRInputError):
        return JSONResponse(_error(str(exc), code="ocr_invalid"), status_code=400, headers=NO_STORE)

    @app.exception_handler(TranslationUnavailable)
    async def translation_unavailable_handler(request: Request, exc: TranslationUnavailable):
        return JSONResponse(
            _error(str(exc), code="translation_unavailable"), status_code=503, headers=NO_STORE
        )

    @app.exception_handler(TextTransformError)
    async def text_transform_handler(request: Request, exc: TextTransformError):
        return JSONResponse(
            _error(str(exc), code="text_transform_unavailable"), status_code=503, headers=NO_STORE
        )

    # ------------------------------------------------------------------
    # Health (public)
    # ------------------------------------------------------------------
    @app.get("/api/health", tags=["system"])
    async def legacy_health() -> dict:
        return {
            "status": "ok",
            "engine": service.engine,
            "ready": service.ready,
            "version": __version__,
        }

    @app.get(f"{config.API_PREFIX}/health", tags=["system"])
    async def health() -> dict:
        summary = repository.summary()
        return {
            "status": "ok",
            "version": __version__,
            "ocr": {
                "ready": service.ready,
                "engine": service.engine,
                "message": (
                    "OCR 已就绪"
                    if service.ready
                    else "OCR 引擎将在第一次扫描时加载模型；如未安装依赖请运行 start.ps1。"
                ),
            },
            "storage": summary,
            "auth_required": bool(config.auth_token()),
        }

    # ------------------------------------------------------------------
    # Protected API
    # ------------------------------------------------------------------
    api = APIRouter(prefix=config.API_PREFIX, dependencies=[Depends(_require_auth)])

    @api.get("/phone", tags=["system"])
    async def phone_info(request: Request) -> dict:
        """手机接入口：局域网地址、二维码、证书指纹与安装步骤。"""
        from . import phone

        scheme = request.url.scheme or "http"
        host = request.url.hostname or "127.0.0.1"
        port = request.url.port or (443 if scheme == "https" else 80)
        payload = await run_in_threadpool(
            phone.phone_payload,
            scheme=scheme,
            host=host,
            port=port,
            secure_context=scheme == "https",
            auth_required=bool(config.auth_token()),
        )
        return payload

    @api.get("/diagnostics", tags=["system"])
    async def diagnostics() -> dict:
        """环境快照：依赖、OCR、数据目录与证书，用于排障。"""
        from . import selfcheck

        report = await run_in_threadpool(selfcheck.environment_report)
        report["ocr"] = {
            "ready": service.ready,
            "engine": service.engine,
            "last_error": service.last_error,
        }
        return report

    @api.post("/ocr/self-test", tags=["system"])
    async def ocr_self_test() -> dict:
        """用程序生成的中文图片跑一次真实 OCR，确认识别链路是否通。"""
        from . import selfcheck

        return await run_in_threadpool(selfcheck.run_ocr_self_test, service)


    @api.get("/bootstrap", tags=["app"])
    async def bootstrap(request: Request) -> dict:
        profile_id = _client_profile(request)
        return {
            "profile": repository.profile(profile_id),
            "settings": repository.settings(profile_id),
            "books": repository.list_books(profile_id),
            "progress": repository.progress(profile_id),
            "notes": repository.list_notes(profile_id, limit=50)["notes"],
            "stats": repository.stats(profile_id, days=14),
            "server": {
                "version": __version__,
                "ocr_ready": service.ready,
                "ocr_engine": service.engine,
                "auth_required": bool(config.auth_token()),
            },
        }

    @api.get("/profile", tags=["profile"])
    async def get_profile(request: Request) -> dict:
        return repository.profile(_client_profile(request))

    @api.patch("/profile", tags=["profile"])
    async def patch_profile(request: Request, payload: dict = Body(...)) -> dict:
        return repository.rename_profile(
            payload.get("name", ""), _client_profile(request)
        )

    @api.get("/settings", tags=["settings"])
    async def get_settings(request: Request) -> dict:
        return repository.settings(_client_profile(request))

    @api.put("/settings", tags=["settings"])
    async def put_settings(request: Request, payload: dict = Body(...)) -> dict:
        if not isinstance(payload, dict):
            raise ValidationError("设置必须是一个对象。")
        return repository.update_settings(payload, _client_profile(request))

    @api.post("/text/transform", tags=["text"])
    async def transform_page_text(request: Request, payload: dict = Body(...)) -> dict:
        """繁简转换与可选译文；只处理调用方提交的当前文字。"""
        if not isinstance(payload, dict):
            raise ValidationError("请求内容必须是对象。")
        lines = payload.get("lines")
        if not isinstance(lines, list) or not lines:
            raise ValidationError("lines 必须是非空的文字数组。")
        if len(lines) > 400:
            raise ValidationError("一次最多转换 400 行文字。")
        clean_lines: list[str] = []
        for line in lines:
            if not isinstance(line, str):
                raise ValidationError("lines 中每一项都必须是文字。")
            if len(line) > 4000:
                raise ValidationError("单行文字不能超过 4000 个字符。")
            clean_lines.append(line)
        script = payload.get("script", "simplified")
        if script not in {"simplified", "traditional"}:
            raise ValidationError("script 必须是 simplified 或 traditional。")
        translation = payload.get("translation", "off")
        if translation not in {"off", "en", "zh"}:
            raise ValidationError("translation 必须是 off、en 或 zh。")
        try:
            return await run_in_threadpool(
                transform_text,
                clean_lines,
                script=script,
                translation=translation,
            )
        except TranslationUnavailable:
            raise
        except TextTransformError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            raise HTTPException(status_code=503, detail=f"文字处理失败：{exc}") from exc

    # Books ------------------------------------------------------------
    @api.get("/books", tags=["books"])
    async def list_books(request: Request, archived: bool = False) -> dict:
        books = repository.list_books(_client_profile(request), archived=archived)
        return {"books": books, "total": len(books)}

    @api.post("/books", tags=["books"], status_code=201)
    async def create_book(request: Request, payload: dict = Body(...)) -> dict:
        if not isinstance(payload, dict):
            raise ValidationError("请求内容必须是对象。")
        book = repository.create_book(
            payload.get("title", ""),
            payload.get("author", ""),
            color=payload.get("color", "jade"),
            profile_id=_client_profile(request),
        )
        return book

    @api.get("/books/{book_id}", tags=["books"])
    async def get_book(request: Request, book_id: str) -> dict:
        return repository.get_book(book_id, _client_profile(request))

    @api.patch("/books/{book_id}", tags=["books"])
    async def update_book(request: Request, book_id: str, payload: dict = Body(...)) -> dict:
        return repository.update_book(book_id, payload, _client_profile(request))

    @api.delete("/books/{book_id}", tags=["books"])
    async def delete_book(request: Request, book_id: str) -> dict:
        profile_id = _client_profile(request)
        book = repository.get_book(book_id, profile_id)
        for page in book.get("pages", []):
            paths = repository.page_paths(page["id"])
            store.delete([paths["image"], paths["thumb"], paths["rectified"]])
        return repository.delete_book(book_id, profile_id)

    @api.post("/demo-book", tags=["books"])
    async def ensure_demo_book(request: Request) -> dict:
        profile_id = _client_profile(request)
        existing = next(
            (book for book in repository.list_books(profile_id) if book.get("demo")),
            None,
        )
        if existing:
            return repository.get_book(existing["id"], profile_id)
        database.seed_demo()
        demo = repository.list_books(profile_id)
        demo = next((book for book in demo if book.get("demo")), None)
        if not demo:
            raise HTTPException(status_code=500, detail="演示书籍创建失败。")
        return repository.get_book(demo["id"], profile_id)

    # Pages ------------------------------------------------------------
    @api.post("/books/{book_id}/pages", tags=["pages"], status_code=201)
    async def scan_page(
        request: Request,
        book_id: str,
        page_number: int = Query(default=1, ge=1, le=99_999),
        layout: Literal["none", "pages", "columns"] = "none",
        rotation: int = Query(default=0),
        mode: Literal["none", "perspective", "auto"] = "auto",
        min_confidence: float = Query(default=0.45, ge=0, le=1),
        max_side: int = Query(default=1920, ge=640, le=2560),
        split_position: float = Query(default=0.5, ge=0.1, le=0.9),
    ) -> dict:
        profile_id = _client_profile(request)
        if rotation not in (0, 90, 180, 270):
            raise HTTPException(status_code=422, detail="旋转角度必须是 0、90、180 或 270。")
        book = repository.get_book(book_id, profile_id)
        image_bytes = await _read_image(request)
        result = await run_in_threadpool(
            service.process,
            image_bytes,
            mode=mode,
            min_confidence=min_confidence,
            max_side=max_side,
            rotation=rotation,
            split=layout,
            split_position=split_position,
        )
        if not result.get("lines"):
            raise HTTPException(
                status_code=422,
                detail=result.get("warnings", ["没有识别到文字，请调整光线、角度或分栏后重试。"])[0],
            )
        existing = repository.find_page(book_id, page_number, profile_id)
        page_id = existing["id"] if existing else new_id("pg")
        saved = store.save_page(
            page_id,
            image_bytes,
            rectified_data_url=result.get("rectified_image"),
        )
        page = repository.save_page(
            book_id,
            page_number,
            profile_id=profile_id,
            result=result,
            lines=result["lines"],
            image_path=saved["image_path"],
            thumb_path=saved["thumb_path"],
            rectified_path=saved["rectified_path"],
            layout=layout,
            rotation=rotation,
            page_id_hint=page_id,
            width=saved["width"],
            height=saved["height"],
        )
        repository.record_activity(
            {
                "kind": "scan",
                "book_id": book["id"],
                "page_number": page_number,
            },
            profile_id,
        )
        return {
            "page": _page_payload(page),
            "ocr": {
                "engine": result.get("engine"),
                "document_id": result.get("document_id"),
                "warnings": result.get("warnings", []),
                "regions": result.get("regions", []),
                "timing_ms": result.get("timing_ms", {}),
            },
        }

    @api.get("/books/{book_id}/pages/{page_number}", tags=["pages"])
    async def get_page_by_number(request: Request, book_id: str, page_number: int) -> dict:
        page = repository.find_page(book_id, page_number, _client_profile(request))
        if page is None:
            raise NotFound("这一页还没有扫描，请先扫描书页。")
        return _page_payload(page)

    @api.post("/books/{book_id}/auto-scan", tags=["pages"])
    async def auto_scan_page(
        request: Request,
        book_id: str,
        page_number: int | None = Query(default=None, ge=1, le=99_999),
        layout: Literal["none", "pages", "columns"] = "none",
        rotation: int = Query(default=0),
        min_confidence: float = Query(default=0.4, ge=0, le=1),
        max_side: int = Query(default=1280, ge=640, le=2560),
        split_position: float = Query(default=0.5, ge=0.1, le=0.9),
        same_threshold: float = Query(default=0.72, ge=0.3, le=1.0),
    ) -> dict:
        """免按键连续扫描：自动判断是"同一页"还是"翻页了"。

        * 同一页 → 就地更新（页码、页面 ID、批注都保留），几乎没变化时直接跳过。
        * 新的一页 → 追加到这本书最后，页码自动 +1。
        * 往回翻 → 命中已有的某一页，回到那一页。
        """
        from . import autoscan

        profile_id = _client_profile(request)
        if rotation not in (0, 90, 180, 270):
            raise HTTPException(status_code=422, detail="旋转角度必须是 0、90、180 或 270。")
        book = repository.get_book(book_id, profile_id)
        image_bytes = await _read_image(request)
        result = await run_in_threadpool(
            service.process,
            image_bytes,
            mode="auto",
            min_confidence=min_confidence,
            max_side=max_side,
            rotation=rotation,
            split=layout,
            split_position=split_position,
        )
        lines = result.get("lines") or []
        if not lines:
            return {
                "action": "empty",
                "page": None,
                "similarity": 0.0,
                "scores": [],
                "message": (result.get("warnings") or ["没有识别到文字。"])[0],
            }

        incoming_text = "\n".join(str(line.get("text") or "") for line in lines)
        pages = book.get("pages") or []
        recent = repository.recent_page_texts(book_id, limit=8, profile_id=profile_id)
        decision = autoscan.decide(
            incoming_text,
            recent,
            same_threshold=same_threshold,
        )

        numbers = [int(item.get("page_number") or 0) for item in pages]
        if decision["action"] == "same":
            target_number = int(decision["page_number"])
            existing = repository.find_page(book_id, target_number, profile_id)
            if decision["unchanged"] and existing is not None:
                # 画面没变：不重复写库，只把当前状态回给前端
                return {
                    "action": "same",
                    "unchanged": True,
                    "similarity": decision["similarity"],
                    "scores": decision["scores"],
                    "page": _page_payload(existing),
                }
        else:
            target_number = page_number if page_number else (max(numbers, default=0) + 1)
            if target_number in numbers and page_number is None:
                target_number = max(numbers) + 1
            existing = repository.find_page(book_id, target_number, profile_id)

        page_id = existing["id"] if existing else new_id("pg")
        saved = store.save_page(
            page_id,
            image_bytes,
            rectified_data_url=result.get("rectified_image"),
        )
        page = repository.save_page(
            book_id,
            target_number,
            profile_id=profile_id,
            result=result,
            lines=lines,
            image_path=saved["image_path"],
            thumb_path=saved["thumb_path"],
            rectified_path=saved["rectified_path"],
            layout=layout,
            rotation=rotation,
            page_id_hint=page_id,
            width=saved["width"],
            height=saved["height"],
        )
        if decision["action"] == "new":
            repository.record_activity(
                {"kind": "scan", "book_id": book["id"], "page_number": target_number},
                profile_id,
            )
        return {
            "action": decision["action"],
            "unchanged": False,
            "similarity": decision["similarity"],
            "scores": decision["scores"],
            "page": _page_payload(page),
            "ocr": {
                "engine": result.get("engine"),
                "warnings": result.get("warnings", []),
                "timing_ms": result.get("timing_ms", {}),
            },
        }

    @api.get("/pages/{page_id}", tags=["pages"])
    async def get_page(request: Request, page_id: str) -> dict:
        return _page_payload(repository.get_page(page_id, _client_profile(request)))

    @api.delete("/pages/{page_id}", tags=["pages"])
    async def delete_page(request: Request, page_id: str) -> dict:
        profile_id = _client_profile(request)
        page = repository.get_page(page_id, profile_id)
        paths = repository.page_paths(page_id)
        result = repository.delete_page(page_id, profile_id)
        store.delete([paths["image"], paths["thumb"], paths["rectified"]])
        return result

    @api.get("/pages/{page_id}/image", tags=["pages"])
    async def page_image(
        request: Request,
        page_id: str,
        kind: Literal["original", "thumb", "rectified"] = "original",
    ) -> FileResponse:
        repository.get_page(page_id, _client_profile(request))
        paths = repository.page_paths(page_id)
        name = paths["image"] if kind == "original" else paths[kind]
        path = store.locate(name)
        if path is None and kind != "original":
            path = store.locate(paths["image"])
        if path is None:
            raise NotFound("这一页的图片不存在。")
        media_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
        return FileResponse(
            path,
            media_type=media_type,
            headers={"Cache-Control": "private, max-age=86400"},
        )

    # Notes ------------------------------------------------------------
    @api.get("/notes", tags=["notes"])
    async def list_notes(
        request: Request,
        book_id: str | None = None,
        q: str | None = Query(default=None, max_length=120),
        scope: Literal["line", "page"] | None = None,
        limit: int = Query(default=200, ge=1, le=500),
        offset: int = Query(default=0, ge=0, le=100_000),
    ) -> dict:
        return repository.list_notes(
            _client_profile(request),
            book_id=book_id,
            query=q,
            scope=scope,
            limit=limit,
            offset=offset,
        )

    @api.post("/notes", tags=["notes"], status_code=201)
    async def create_note(request: Request, payload: dict = Body(...)) -> dict:
        return repository.create_note(payload, _client_profile(request))

    @api.get("/notes/{note_id}", tags=["notes"])
    async def get_note(request: Request, note_id: str) -> dict:
        return repository.get_note(note_id, _client_profile(request))

    @api.patch("/notes/{note_id}", tags=["notes"])
    async def update_note(request: Request, note_id: str, payload: dict = Body(...)) -> dict:
        return repository.update_note(note_id, payload, _client_profile(request))

    @api.delete("/notes/{note_id}", tags=["notes"])
    async def delete_note(request: Request, note_id: str) -> dict:
        return repository.delete_note(note_id, _client_profile(request))

    # Progress and statistics -----------------------------------------
    @api.get("/progress", tags=["reading"])
    async def get_progress(request: Request) -> dict:
        progress = repository.progress(_client_profile(request))
        return {"progress": progress}

    @api.put("/progress", tags=["reading"])
    async def put_progress(request: Request, payload: dict = Body(...)) -> dict:
        return repository.save_progress(payload, _client_profile(request))

    @api.post("/progress", include_in_schema=False)
    async def post_progress_beacon(request: Request, payload: dict = Body(...)) -> dict:
        """sendBeacon fallback: the browser can only POST a Blob."""
        return repository.save_progress(payload, _client_profile(request))

    @api.post("/activity", tags=["reading"], status_code=201)
    async def post_activity(request: Request, payload: dict = Body(...)) -> dict:
        return repository.record_activity(payload, _client_profile(request))

    @api.get("/stats", tags=["reading"])
    async def get_stats(request: Request, days: int = Query(default=14, ge=1, le=90)) -> dict:
        return repository.stats(_client_profile(request), days=days)

    # Backup and reset -------------------------------------------------
    @api.get("/export", tags=["data"])
    async def export_data(request: Request) -> Response:
        payload = repository.export_all(_client_profile(request))
        body = json.dumps(payload, ensure_ascii=False, indent=2)
        filename = f"paperpal-backup-{date.today().isoformat()}.json"
        return Response(
            content=body,
            media_type="application/json; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )

    @api.post("/import", tags=["data"])
    async def import_data(
        request: Request,
        payload: dict = Body(...),
        mode: Literal["merge", "replace"] = "merge",
    ) -> dict:
        profile_id = _client_profile(request)
        old_files: list[str] = []
        if mode == "replace":
            for book in repository.list_books(profile_id, archived=None):
                full = repository.get_book(book["id"], profile_id)
                for page in full.get("pages", []):
                    paths = repository.page_paths(page["id"])
                    old_files.extend([paths["image"], paths["thumb"], paths["rectified"]])
        imported = repository.import_data(payload, profile_id, mode=mode)
        if old_files:
            store.delete(old_files)
        return {"imported": imported, "mode": mode}

    @api.delete("/data", tags=["data"])
    async def clear_data(request: Request, keep_settings: bool = True) -> dict:
        profile_id = _client_profile(request)
        books = repository.list_books(profile_id, archived=None)
        for book in books:
            full = repository.get_book(book["id"], profile_id)
            for page in full.get("pages", []):
                paths = repository.page_paths(page["id"])
                store.delete([paths["image"], paths["thumb"], paths["rectified"]])
        result = repository.clear_data(profile_id)
        return {**result, "keep_settings": keep_settings}

    app.include_router(api)

    # ------------------------------------------------------------------
    # Legacy OCR API (used by the original debug page)
    # ------------------------------------------------------------------
    @app.post("/api/ocr", tags=["legacy"])
    async def legacy_ocr(
        request: Request,
        mode: Literal["none", "perspective", "auto"] = "auto",
        min_confidence: float = Query(default=0.45, ge=0, le=1),
        max_side: int = Query(default=1920, ge=640, le=2560),
        rotation: int = 0,
        split: Literal["none", "pages", "columns"] = "none",
        split_position: float = Query(default=0.5, ge=0.1, le=0.9),
    ) -> dict:
        if rotation not in (0, 90, 180, 270):
            raise HTTPException(status_code=422, detail="旋转角度必须是 0、90、180 或 270。")
        image_bytes = await _read_image(request)
        return await run_in_threadpool(
            service.process_raw,
            image_bytes,
            mode=mode,
            min_confidence=min_confidence,
            max_side=max_side,
            rotation=rotation,
            split=split,
            split_position=split_position,
        )

    # ------------------------------------------------------------------
    # Web app and PWA assets
    # ------------------------------------------------------------------
    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        path = config.APP_DIR / "index.html"
        if not path.is_file():
            raise HTTPException(status_code=503, detail="纸伴应用文件缺失。")
        return FileResponse(path, headers={"Cache-Control": "no-cache"})

    @app.get("/manifest.webmanifest", include_in_schema=False)
    async def manifest() -> FileResponse:
        path = config.APP_DIR / "manifest.webmanifest"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="清单文件不存在。")
        return FileResponse(
            path,
            media_type="application/manifest+json",
            headers={"Cache-Control": "no-cache"},
        )

    @app.get("/sw.js", include_in_schema=False)
    async def service_worker() -> FileResponse:
        path = config.APP_DIR / "sw.js"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="Service Worker 不存在。")
        return FileResponse(
            path,
            media_type="text/javascript",
            headers={
                "Cache-Control": "no-cache",
                "Service-Worker-Allowed": "/",
            },
        )

    @app.get("/favicon.svg", include_in_schema=False)
    async def favicon() -> FileResponse:
        path = config.APP_DIR / "icon.svg"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="图标不存在。")
        return FileResponse(path, media_type="image/svg+xml")

    # ------------------------------------------------------------------
    # 本机 HTTPS 证书：手机安装一次，之后相机与 PWA 都能用
    # ------------------------------------------------------------------
    @app.get("/paperpal-ca.crt", include_in_schema=False)
    async def trust_certificate() -> Response:
        from . import phone

        await run_in_threadpool(phone.certificate_files)
        from . import certs as cert_module

        path = cert_module.certs_dir() / "ca.crt"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="还没有生成本机证书，请用 HTTPS 模式启动。")
        return FileResponse(
            path,
            media_type="application/x-x509-ca-cert",
            filename="paperpal-ca.crt",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/paperpal.mobileconfig", include_in_schema=False)
    async def trust_profile() -> Response:
        from . import phone

        await run_in_threadpool(phone.certificate_files)
        from . import certs as cert_module

        path = cert_module.certs_dir() / "paperpal.mobileconfig"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="还没有生成描述文件，请用 HTTPS 模式启动。")
        return FileResponse(
            path,
            media_type="application/x-apple-aspen-config",
            filename="paperpal.mobileconfig",
            headers={"Cache-Control": "no-store"},
        )


    @app.get("/reader", include_in_schema=False)
    async def legacy_reader() -> FileResponse:
        path = config.READER_DIR / "index.html"
        if not path.is_file():
            raise HTTPException(status_code=503, detail="阅读页文件缺失。")
        return FileResponse(path, headers={"Cache-Control": "no-cache"})

    if config.APP_DIR.is_dir():
        app.mount(
            "/app-assets",
            StaticFiles(directory=config.APP_DIR, html=False),
            name="app-assets",
        )
    if config.OCR_STATIC_DIR.is_dir():
        app.mount(
            "/static",
            StaticFiles(directory=config.OCR_STATIC_DIR, html=False),
            name="static",
        )
    if config.READER_DIR.is_dir():
        app.mount(
            "/reader-assets",
            StaticFiles(directory=config.READER_DIR, html=False),
            name="reader-assets",
        )
    return app


app = create_app()


def main() -> int:  # pragma: no cover - exercised through the CLI
    import uvicorn

    uvicorn.run("paperpal.api:app", host="127.0.0.1", port=8000)
    return 0
