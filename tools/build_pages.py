"""把 前端/ 打包成可直接放到 GitHub Pages 的静态站（docs/）。

GitHub Pages 的项目站点在 https://<user>.github.io/<repo>/ 下，
所以所有以 / 开头的资源路径都要改成相对路径；同时生成一份相对路径的 Service Worker。
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONT = ROOT / "前端"
DOCS = ROOT / "docs"

SKIP_DIRS = {"design", "docs"}


def copy_tree() -> None:
    if DOCS.exists():
        shutil.rmtree(DOCS)
    DOCS.mkdir(parents=True)
    for item in FRONT.iterdir():
        if item.name in SKIP_DIRS:
            continue
        target = DOCS / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    # 截图单独放，供 Pages 上的预览页使用
    shots = FRONT / "docs" / "screenshots"
    if shots.is_dir():
        shutil.copytree(shots, DOCS / "screenshots")


def rewrite_html() -> None:
    path = DOCS / "index.html"
    text = path.read_text(encoding="utf-8")
    text = text.replace('href="/app-assets/', 'href="./')
    text = text.replace('src="/app-assets/', 'src="./')
    text = text.replace('href="/manifest.webmanifest"', 'href="./manifest.webmanifest"')
    text = text.replace('href="/favicon.svg"', 'href="./icon.svg"')
    path.write_text(text, encoding="utf-8")


def rewrite_js() -> None:
    app = DOCS / "js" / "app.js"
    text = app.read_text(encoding="utf-8")
    text = text.replace('navigator.serviceWorker.register("/sw.js")',
                        'navigator.serviceWorker.register("./sw.js")')
    app.write_text(text, encoding="utf-8")


def rewrite_manifest() -> None:
    path = DOCS / "manifest.webmanifest"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["id"] = "./"
    data["start_url"] = "./#/welcome"
    data["scope"] = "./"
    for icon in data.get("icons", []):
        icon["src"] = icon["src"].replace("/app-assets/", "./").replace("/favicon.svg", "./icon.svg")
    for shortcut in data.get("shortcuts", []):
        shortcut["url"] = shortcut["url"].replace("/#/", "./#/")
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


SERVICE_WORKER = """/* 纸伴 Pages 版 Service Worker：相对路径，项目站点可用。 */
const VERSION = "paperpal-pages-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/api.js",
  "./js/ui.js",
  "./js/voice.js",
  "./js/store.js",
  "./js/bluetooth.js",
  "./js/input.js",
  "./js/media.js",
  "./js/autoscan.js",
  "./js/devices.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("./index.html")) || Response.error())
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return response;
          })
          .catch(() => cached)
    )
  );
});
"""


def write_service_worker() -> None:
    (DOCS / "sw.js").write_text(SERVICE_WORKER, encoding="utf-8")


def write_pages_extras() -> None:
    (DOCS / ".nojekyll").write_text("", encoding="utf-8")
    # 项目站点上没有后端：把 /api 请求当成断网，App 会自动进入离线演示
    demo_shim = """<script>
/* PaperPal Pages 演示模式：没有后端，把 /api 请求当作断网，自动进入离线演示。 */
(function () {
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf("/api/") !== -1) {
      return Promise.reject(new TypeError("paperpal-demo-offline"));
    }
    return realFetch ? realFetch(input, init) : Promise.reject(new Error("no fetch"));
  };
  var RealXHR = window.XMLHttpRequest;
  if (RealXHR) {
    window.XMLHttpRequest = class extends RealXHR {
      open(method, url) {
        this.__paperpalDemo = String(url).indexOf("/api/") !== -1;
        return super.open.apply(this, arguments);
      }
      send(body) {
        if (this.__paperpalDemo) {
          setTimeout(() => this.dispatchEvent(new Event("error")), 0);
          return;
        }
        return super.send(body);
      }
    };
  }
})();
</script>
"""
    banner = """<div id="pagesBanner" style="position:fixed;left:12px;right:12px;bottom:76px;z-index:9999;
background:#0f6b58;color:#fff;border-radius:12px;padding:10px 14px;font:14px/1.5 -apple-system,'PingFang SC',sans-serif;
box-shadow:0 6px 20px rgba(0,0,0,.18);display:none;gap:10px;align-items:center">
  <span style="flex:1">界面演示（无后端）：点首页的「继续上次阅读」或「先体验演示阅读」即可看到阅读效果。</span>
  <button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,.18);border:0;color:#fff;
border-radius:8px;padding:6px 10px;font-size:13px">知道了</button>
</div>
<script>setTimeout(function(){var b=document.getElementById('pagesBanner');if(b)b.style.display='flex';},1600);</script>
"""
    index = DOCS / "index.html"
    text = index.read_text(encoding="utf-8")
    if "paperpal-demo-offline" not in text:
        text = text.replace(
            '<script type="module" src="./js/app.js"></script>',
            demo_shim + '<script type="module" src="./js/app.js"></script>',
        )
    if "pagesBanner" not in text:
        text = text.replace("</body>", banner + "\n</body>")
    index.write_text(text, encoding="utf-8")


def main() -> None:
    copy_tree()
    rewrite_html()
    rewrite_js()
    rewrite_manifest()
    write_service_worker()
    write_pages_extras()
    files = sum(1 for _ in DOCS.rglob("*") if _.is_file())
    print(f"docs/ 生成完成：{files} 个文件，{DOCS}")


if __name__ == "__main__":
    main()
