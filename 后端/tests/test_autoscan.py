"""连续自动扫描：判定逻辑 + 接口行为。"""

from __future__ import annotations


def _document(lines: list[str]) -> dict:
    return {
        "document_id": "doc",
        "engine": "fake",
        "source_size": [1200, 1600],
        "lines": [
            {
                "reading_order": index + 1,
                "text": text,
                "confidence": 0.99,
                "region_id": "region-1",
                "block_id": "block-1",
                "bbox": [10, index * 40, 600, 30],
            }
            for index, text in enumerate(lines)
        ],
        "regions": [],
        "warnings": [],
        "timing_ms": {"total": 1.0},
    }


def test_similarity_ignores_punctuation_and_spacing():
    from paperpal import autoscan

    left = "读书使人充实，讨论使人机智。"
    right = "读书使人充实 讨论使人机智"
    assert autoscan.similarity(left, right) == 1.0
    assert autoscan.similarity(left, "今天天气很好。") < 0.4
    assert autoscan.similarity("", left) == 0.0


def test_decide_same_page_and_turn():
    from paperpal import autoscan

    pages = [
        {"page_number": 3, "text": "读书使人充实，讨论使人机智。"},
        {"page_number": 4, "text": "读史使人明智，读诗使人灵秀。"},
    ]
    same = autoscan.decide("读书使人充实，讨论使人机智", pages)
    assert same["action"] == "same"
    assert same["page_number"] == 3
    assert same["unchanged"] is True

    turned = autoscan.decide("科学使人深刻，伦理使人庄重。", pages)
    assert turned["action"] == "new"
    assert turned["page_number"] is None

    # 往回翻也要认得出
    back = autoscan.decide("读史使人明智 读诗使人灵秀", pages)
    assert back["action"] == "same"
    assert back["page_number"] == 4


def test_best_line_index_keeps_reading_position():
    from paperpal import autoscan

    lines = [{"text": "第一行"}, {"text": "第二行的内容"}, {"text": "第三行"}]
    assert autoscan.best_line_index("第二行内容", lines) == 1
    assert autoscan.best_line_index("第一行", lines) == 0


def test_auto_scan_endpoint_reuses_page_and_detects_turn(app_bundle, client):
    _app, _db, service = app_bundle
    book = client.post("/api/v1/books", json={"title": "自动扫描书"}).json()
    queue: list[dict] = []

    def fake_process(_image_bytes, **_options):
        return queue.pop(0)

    service.process = fake_process  # type: ignore[method-assign]

    def post() -> dict:
        response = client.post(
            f"/api/v1/books/{book['id']}/auto-scan?layout=none&rotation=0",
            content=b"frame",
            headers={"Content-Type": "image/jpeg"},
        )
        assert response.status_code == 200, response.text
        return response.json()

    queue.append(_document(["读书使人充实。", "讨论使人机智。"]))
    first = post()
    assert first["action"] == "new"
    assert first["page"]["page_number"] == 1

    queue.append(_document(["读书使人充实。", "讨论使人机智。"]))
    second = post()
    assert second["action"] == "same"
    assert second["unchanged"] is True
    assert second["page"]["page_number"] == 1

    queue.append(_document(["读史使人明智。", "读诗使人灵秀。"]))
    third = post()
    assert third["action"] == "new"
    assert third["page"]["page_number"] == 2

    # 往回翻到第一页：页码不新增
    queue.append(_document(["读书使人充实。", "讨论使人机智。"]))
    back = post()
    assert back["action"] == "same"
    assert back["page"]["page_number"] == 1

    pages = client.get(f"/api/v1/books/{book['id']}").json()["pages"]
    assert [page["page_number"] for page in pages] == [1, 2]
