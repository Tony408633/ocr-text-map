"""Shared fixtures for backend tests.

The environment override runs before ``paperpal.api`` is imported so the
module-level app uses a throwaway data directory instead of the real one.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
import sys

import pytest

# ---------------------------------------------------------------------------
# Windows sandbox compatibility
#
# Python on this machine grants mode 0o700 directories a DACL that the current
# process cannot traverse, which breaks tempfile.mkdtemp and pytest's tmp_path.
# Force permissive modes for directories created inside the test process.
# ---------------------------------------------------------------------------
_real_mkdir = os.mkdir
_real_makedirs = os.makedirs


def _mkdir(path, mode=0o777, *args, **kwargs):
    return _real_mkdir(path, 0o777, *args, **kwargs)


def _makedirs(name, mode=0o777, exist_ok=False):
    return _real_makedirs(name, 0o777, exist_ok=exist_ok)


os.mkdir = _mkdir
os.makedirs = _makedirs


def _mkdtemp(suffix=None, prefix=None, dir=None):
    base = dir or tempfile.gettempdir()
    for _ in range(100):
        name = (prefix or "tmp") + next(tempfile._get_candidate_names()) + (suffix or "")
        path = os.path.join(base, name)
        try:
            os.mkdir(path)
        except FileExistsError:
            continue
        return path
    raise FileExistsError("could not create temporary directory")


tempfile.mkdtemp = _mkdtemp

ROOT = Path(__file__).resolve().parents[1]
TEST_DATA = ROOT / ".tmp" / "test-data"
TEST_DATA.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("PAPERPAL_DATA_DIR", str(TEST_DATA))
os.environ.pop("PAPERPAL_TOKEN", None)
os.environ.pop("PAPERPAL_DB", None)

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from paperpal.db import Database  # noqa: E402
from paperpal.ocr import FakeOCRService  # noqa: E402
from paperpal.storage import ImageStore  # noqa: E402


@pytest.fixture()
def app_bundle(tmp_path):
    from paperpal.api import create_app

    database = Database(tmp_path / "paperpal.db")
    images = ImageStore(tmp_path / "images")
    service = FakeOCRService(
        [
            "读书使人充实。",
            "讨论使人机智。",
            "笔记使人准确。",
        ]
    )
    app = create_app(db=database, ocr=service, images=images, seed_demo=False)
    return app, database, service


@pytest.fixture()
def client(app_bundle):
    from fastapi.testclient import TestClient

    app, _, _ = app_bundle
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def book(client):
    response = client.post("/api/v1/books", json={"title": "测试书籍", "author": "作者"})
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture()
def scanned_page(client, book):
    response = client.post(
        f"/api/v1/books/{book['id']}/pages?page_number=7&layout=none&rotation=0",
        content=b"fake-image-bytes",
        headers={"Content-Type": "image/jpeg"},
    )
    assert response.status_code == 201, response.text
    return response.json()["page"]
