"""HTTP contract tests for the PaperPal backend."""

from __future__ import annotations

from pathlib import Path


def test_health_and_bootstrap(client):
    health = client.get("/api/v1/health")
    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "ok"
    assert body["ocr"]["ready"] is True

    bootstrap = client.get("/api/v1/bootstrap")
    assert bootstrap.status_code == 200
    data = bootstrap.json()
    assert data["profile"]["id"] == "local"
    assert data["settings"]["interaction_mode"] == "guided"
    assert data["books"] == []
    assert data["notes"] == []
    assert data["stats"]["books"] == 0


def test_books_crud(client):
    created = client.post(
        "/api/v1/books",
        json={"title": "看不见的城市", "author": "卡尔维诺", "color": "indigo"},
    )
    assert created.status_code == 201
    book = created.json()
    assert book["title"] == "看不见的城市"
    assert book["page_count"] == 0

    renamed = client.patch(
        f"/api/v1/books/{book['id']}", json={"title": "看不见的城市（新版）"}
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"].endswith("（新版）")

    listed = client.get("/api/v1/books").json()
    assert listed["total"] == 1

    deleted = client.delete(f"/api/v1/books/{book['id']}")
    assert deleted.status_code == 200
    assert client.get("/api/v1/books").json()["total"] == 0


def test_book_validation(client):
    assert client.post("/api/v1/books", json={"title": ""}).status_code == 422
    assert client.post("/api/v1/books", json={"title": "书", "color": "neon"}).status_code == 422
    assert client.get("/api/v1/books/bk_missing").status_code == 404


def test_scan_page_persists_lines_and_image(client, book):
    response = client.post(
        f"/api/v1/books/{book['id']}/pages?page_number=7&layout=pages&rotation=90",
        content=b"fake-image-bytes",
        headers={"Content-Type": "image/jpeg"},
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    page = payload["page"]
    assert page["page_number"] == 7
    assert page["line_count"] == 3
    assert [line["text"] for line in page["lines"]] == [
        "读书使人充实。",
        "讨论使人机智。",
        "笔记使人准确。",
    ]
    assert page["layout"] == "pages"
    assert page["rotation"] == 90
    assert page["has_image"] is True

    fetched = client.get(f"/api/v1/pages/{page['id']}").json()
    assert fetched["lines"][1]["reading_order"] == 2

    by_number = client.get(f"/api/v1/books/{book['id']}/pages/7")
    assert by_number.status_code == 200
    assert by_number.json()["id"] == page["id"]
    assert client.get(f"/api/v1/books/{book['id']}/pages/8").status_code == 404

    image = client.get(page["image_url"])
    assert image.status_code == 200
    assert image.headers["content-type"].startswith("image/")
    assert image.content == b"fake-image-bytes"

    book_detail = client.get(f"/api/v1/books/{book['id']}").json()
    assert book_detail["page_count"] == 1
    assert book_detail["last_page"] == 7


def test_rescan_same_page_reuses_page_id(client, book):
    first = client.post(
        f"/api/v1/books/{book['id']}/pages?page_number=3",
        content=b"first",
        headers={"Content-Type": "image/jpeg"},
    )
    assert first.status_code == 201
    page_id = first.json()["page"]["id"]

    second = client.post(
        f"/api/v1/books/{book['id']}/pages?page_number=3",
        content=b"second",
        headers={"Content-Type": "image/jpeg"},
    )
    assert second.status_code == 201
    assert second.json()["page"]["id"] == page_id
    assert len(second.json()["page"]["lines"]) == 3

    books = client.get("/api/v1/books").json()["books"]
    assert books[0]["page_count"] == 1


def test_scan_rejects_bad_input(client, book):
    missing_type = client.post(
        f"/api/v1/books/{book['id']}/pages?page_number=2",
        content=b"x",
        headers={"Content-Type": "text/plain"},
    )
    assert missing_type.status_code == 415

    empty = client.post(
        f"/api/v1/books/{book['id']}/pages?page_number=2",
        content=b"",
        headers={"Content-Type": "image/jpeg"},
    )
    assert empty.status_code == 400

    bad_rotation = client.post(
        f"/api/v1/books/{book['id']}/pages?page_number=2&rotation=45",
        content=b"x",
        headers={"Content-Type": "image/jpeg"},
    )
    assert bad_rotation.status_code == 422


def test_notes_lifecycle(client, scanned_page):
    created = client.post(
        "/api/v1/notes",
        json={
            "book_id": scanned_page["book_id"],
            "page_id": scanned_page["id"],
            "page_number": 7,
            "line_number": 2,
            "scope": "line",
            "text": "这里让我想到讨论的价值。",
        },
    )
    assert created.status_code == 201, created.text
    note = created.json()
    assert note["book_title"] == "测试书籍"
    assert note["scope"] == "line"

    listed = client.get("/api/v1/notes?q=讨论").json()
    assert listed["total"] == 1
    assert listed["notes"][0]["id"] == note["id"]

    empty = client.get("/api/v1/notes?q=不存在的词").json()
    assert empty["total"] == 0

    updated = client.patch(
        f"/api/v1/notes/{note['id']}",
        json={"text": "补充：讨论让思路更清楚。", "scope": "page"},
    )
    assert updated.status_code == 200
    assert updated.json()["scope"] == "page"
    assert updated.json()["line_number"] is None

    deleted = client.delete(f"/api/v1/notes/{note['id']}")
    assert deleted.status_code == 200
    assert client.get("/api/v1/notes").json()["total"] == 0


def test_note_requires_existing_book(client):
    response = client.post(
        "/api/v1/notes",
        json={"book_id": "bk_missing", "page_number": 1, "scope": "page", "text": "x"},
    )
    assert response.status_code == 404

    response = client.post(
        "/api/v1/notes",
        json={"book_id": "bk_missing", "page_number": 1, "scope": "line", "text": "x"},
    )
    assert response.status_code == 404


def test_progress_and_activity_stats(client, scanned_page):
    put = client.put(
        "/api/v1/progress",
        json={
            "book_id": scanned_page["book_id"],
            "page_number": 12,
            "line_index": 4,
        },
    )
    assert put.status_code == 200
    assert put.json()["page_number"] == 12

    progress = client.get("/api/v1/progress").json()["progress"]
    assert progress[0]["line_index"] == 4

    for _ in range(2):
        recorded = client.post(
            "/api/v1/activity",
            json={
                "kind": "read",
                "book_id": scanned_page["book_id"],
                "page_number": 12,
                "lines": 5,
                "seconds": 60,
            },
        )
        assert recorded.status_code == 201

    stats = client.get("/api/v1/stats?days=7").json()
    assert stats["reading_seconds"] == 120
    assert stats["lines"] >= 3
    assert stats["streak_days"] == 1
    assert stats["today"]["seconds"] == 120
    assert len(stats["daily"]) == 7


def test_progress_beacon_post_alias(client, scanned_page):
    """sendBeacon can only POST; the alias must save the same progress."""
    response = client.post(
        "/api/v1/progress",
        json={
            "book_id": scanned_page["book_id"],
            "page_number": 12,
            "line_index": 2,
        },
    )
    assert response.status_code == 200
    assert response.json()["line_index"] == 2
    progress = client.get("/api/v1/progress").json()["progress"]
    assert progress[0]["line_index"] == 2


def test_settings_validation(client):
    updated = client.put(
        "/api/v1/settings",
        json={
            "voice_rate": 1.25,
            "theme": "dark",
            "interaction_mode": "command",
            "text_script": "traditional",
            "translation_target": "en",
            "reading_mode": "overnight",
        },
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["voice_rate"] == 1.25
    assert body["theme"] == "dark"
    assert body["text_script"] == "traditional"
    assert body["translation_target"] == "en"
    assert body["reading_mode"] == "overnight"

    assert client.put("/api/v1/settings", json={"voice_rate": 9}).status_code == 422
    assert client.put("/api/v1/settings", json={"theme": "neon"}).status_code == 422
    assert client.put("/api/v1/settings", json={"unknown": True}).status_code == 422
    assert client.put("/api/v1/settings", json={"voice_enabled": "yes"}).status_code == 422
    assert client.put("/api/v1/settings", json={"text_script": "latin"}).status_code == 422
    assert client.put("/api/v1/settings", json={"translation_target": "fr"}).status_code == 422
    assert client.put("/api/v1/settings", json={"reading_mode": "sleep"}).status_code == 422


def test_text_transform_conversion(client):
    response = client.post(
        "/api/v1/text/transform",
        json={"lines": ["读书使人充实，讨论使人机智。"], "script": "traditional"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["script"] == "traditional"
    assert body["lines"][0]["text"] == "讀書使人充實，討論使人機智。"
    assert body["lines"][0]["translation"] is None

    simplified = client.post(
        "/api/v1/text/transform",
        json={"lines": ["讀書使人充實。"], "script": "simplified"},
    )
    assert simplified.json()["lines"][0]["text"] == "读书使人充实。"


def test_text_transform_translation(client, monkeypatch):
    from paperpal import text as text_module

    def fake_translate(text, target, script):
        return f"[{target}] {text}"

    monkeypatch.setattr(text_module, "_translate_line", fake_translate)
    response = client.post(
        "/api/v1/text/transform",
        json={
            "lines": ["读书使人充实。", "读史使人明智。"],
            "script": "simplified",
            "translation": "en",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["translation"] == "en"
    assert body["lines"][0]["translation"] == "[en] 读书使人充实。"
    assert body["lines"][1]["translation"] == "[en] 读史使人明智。"


def test_text_transform_validation(client):
    assert client.post("/api/v1/text/transform", json={"lines": []}).status_code == 422
    assert (
        client.post(
            "/api/v1/text/transform", json={"lines": "not-a-list"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/text/transform",
            json={"lines": ["x"], "script": "latin"},
        ).status_code
        == 422
    )


def test_export_import_roundtrip(client, scanned_page):
    client.post(
        "/api/v1/notes",
        json={
            "book_id": scanned_page["book_id"],
            "page_id": scanned_page["id"],
            "page_number": 7,
            "line_number": 1,
            "scope": "line",
            "text": "导出测试批注",
        },
    )
    export = client.get("/api/v1/export")
    assert export.status_code == 200
    assert "attachment" in export.headers["content-disposition"]
    payload = export.json()
    assert payload["format"] == "paperpal-export"
    assert payload["books"][0]["pages"][0]["lines"]

    assert client.delete("/api/v1/data").status_code == 200
    assert client.get("/api/v1/books").json()["total"] == 0

    imported = client.post("/api/v1/import?mode=replace", json=payload)
    assert imported.status_code == 200, imported.text
    assert imported.json()["imported"]["books"] == 1
    assert imported.json()["imported"]["notes"] == 1

    books = client.get("/api/v1/books").json()["books"]
    assert len(books) == 1
    notes = client.get("/api/v1/notes").json()["notes"]
    assert notes[0]["text"] == "导出测试批注"


def test_clear_data_keeps_settings(client, book):
    client.put("/api/v1/settings", json={"theme": "dark"})
    cleared = client.delete("/api/v1/data")
    assert cleared.status_code == 200
    assert client.get("/api/v1/settings").json()["theme"] == "dark"
    assert client.get("/api/v1/books").json()["total"] == 0


def test_demo_book_endpoint(client):
    created = client.post("/api/v1/demo-book")
    assert created.status_code == 200, created.text
    demo = created.json()
    assert demo["demo"] is True
    assert demo["pages"][0]["line_count"] == 6

    again = client.post("/api/v1/demo-book")
    assert again.status_code == 200
    assert again.json()["id"] == demo["id"]


def test_static_app_and_pwa_assets(client):
    index = client.get("/")
    assert index.status_code == 200
    assert "纸伴" in index.text

    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200
    assert manifest.headers["content-type"].startswith("application/manifest+json")

    worker = client.get("/sw.js")
    assert worker.status_code == 200
    assert worker.headers["service-worker-allowed"] == "/"


def test_security_headers(client):
    response = client.get("/api/v1/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "no-store"


def test_auth_token(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from paperpal.api import create_app
    from paperpal.db import Database
    from paperpal.ocr import FakeOCRService
    from paperpal.storage import ImageStore

    monkeypatch.setenv("PAPERPAL_TOKEN", "secret-token")
    app = create_app(
        db=Database(tmp_path / "auth.db"),
        ocr=FakeOCRService(),
        images=ImageStore(tmp_path / "auth-images"),
        seed_demo=False,
    )
    with TestClient(app) as protected:
        denied = protected.get("/api/v1/books")
        assert denied.status_code == 401
        allowed = protected.get(
            "/api/v1/books", headers={"Authorization": "Bearer secret-token"}
        )
        assert allowed.status_code == 200
        assert protected.get("/api/health").status_code == 200


def test_legacy_ocr_endpoint_returns_full_contract(client):
    response = client.post(
        "/api/ocr?mode=auto&rotation=0", content=b"fake", headers={"Content-Type": "image/jpeg"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["engine"] == "fake"
    assert len(body["lines"]) == 3
    assert body["lines"][0]["text"] == "读书使人充实。"
    # 旧调试页 / 旧阅读页依赖这些坐标与分区字段，不能被精简掉的 v1 结构替换。
    assert body["lines"][0]["polygon_source"]
    assert body["regions"][0]["rectified_image"].startswith("data:image/jpeg;base64,")
    assert body["regions"][0]["line_ids"] == ["line-1", "line-2", "line-3"]


def test_schema_version(app_bundle):
    _, database, _ = app_bundle
    database.initialize()
    assert database.schema_version() == 1
