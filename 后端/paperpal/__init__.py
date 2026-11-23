"""纸伴（PaperPal）后端：书架、书页、批注、阅读进度与 OCR 服务。

The package is intentionally dependency-light at import time: FastAPI is only
imported by :mod:`paperpal.api` and the OCR engine only when a page is scanned,
so ``paperpal.db`` and the repository can be exercised with the standard
library alone.
"""

__version__ = "1.0.0"
__all__ = ["__version__"]
