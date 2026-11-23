"""Fork 上游仓库、推送本项目、开启 GitHub Pages。

用法：
    set PAPERPAL_GH_TOKEN=ghp_xxx
    python .runtime/publish_github.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = "Livia-W/ocr-text-map"
REPO_NAME = "ocr-text-map"
GIT = ROOT / ".runtime" / "tools" / "git" / "cmd" / "git.exe"
API = "https://api.github.com"


def client(token: str) -> httpx.Client:
    return httpx.Client(
        base_url=API,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "PaperPal-Publisher",
        },
        timeout=60,
    )


def fail(message: str, response: httpx.Response | None = None) -> None:
    print(f"[ERR] {message}")
    if response is not None:
        print(f"   HTTP {response.status_code}: {response.text[:400]}")
    sys.exit(1)


def run_git(*args: str, allow_fail: bool = False) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    result = subprocess.run(
        [str(GIT), *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    if result.returncode != 0 and not allow_fail:
        print(f"❌ git {' '.join(args[:2])} 失败")
        print((result.stdout or "")[-800:])
        print((result.stderr or "")[-800:])
        sys.exit(1)
    return result


def main() -> int:
    token = ""
    for index, item in enumerate(sys.argv):
        if item == "--token" and index + 1 < len(sys.argv):
            token = sys.argv[index + 1].strip()
    token = token or os.environ.get("PAPERPAL_GH_TOKEN", "").strip()
    if not token:
        fail("没有拿到 token（--token 或 PAPERPAL_GH_TOKEN）")
    if not GIT.is_file():
        fail(f"找不到便携 git：{GIT}")
    api = client(token)

    print("1/6 验证 token …")
    me = api.get("/user")
    if me.status_code != 200:
        fail("token 无效或没有权限", me)
    login = me.json()["login"]
    print(f"    账号：{login}")

    print("2/6 检查上游仓库 …")
    upstream = api.get(f"/repos/{UPSTREAM}")
    if upstream.status_code != 200:
        fail(f"上游仓库不可访问：{UPSTREAM}", upstream)
    parent = upstream.json()
    print(f"    上游：{parent['full_name']}（默认分支 {parent['default_branch']}）")

    print("3/6 创建 / 复用 fork …")
    fork_full = f"{login}/{REPO_NAME}"
    existing = api.get(f"/repos/{fork_full}")
    if existing.status_code == 200:
        print(f"    已经存在：{fork_full}，直接复用")
    else:
        created = api.post(f"/repos/{UPSTREAM}/forks", json={"name": REPO_NAME, "default_branch_only": False})
        if created.status_code not in (200, 201, 202):
            fail("创建 fork 失败", created)
        print("    已发起 fork，等待 GitHub 准备…")
        for attempt in range(40):
            time.sleep(2)
            if api.get(f"/repos/{fork_full}").status_code == 200:
                break
            if attempt % 5 == 4:
                print(f"      仍在等待（{attempt + 1}）…")
        else:
            fail("fork 等待超时，请到 GitHub 网页确认是否已创建")
    print(f"    fork 就绪：{fork_full}")

    print("4/6 推送代码（force 覆盖 fork 的 main）…")
    remote = f"https://x-access-token:{token}@github.com/{fork_full}.git"
    run_git("remote", "remove", "origin", allow_fail=True)
    run_git("remote", "add", "origin", remote)
    head = run_git("rev-parse", "--short", "HEAD").stdout.strip()
    run_git("push", "--force", "origin", "main")
    run_git("remote", "set-url", "origin", f"https://github.com/{fork_full}.git")
    print(f"    已推送 main @ {head}")

    print("5/6 开启 GitHub Pages（main / docs）…")
    payload = {"source": {"branch": "main", "path": "/docs"}}
    pages = api.post(f"/repos/{fork_full}/pages", json=payload)
    if pages.status_code in (200, 201):
        pages_url = pages.json().get("html_url")
    elif pages.status_code == 409:
        pages = api.put(f"/repos/{fork_full}/pages", json=payload)
        pages_url = pages.json().get("html_url") if pages.status_code in (200, 201) else None
    else:
        pages_url = None
        print(f"    ⚠️ 自动开启失败（HTTP {pages.status_code}）：{pages.text[:200]}")
        print("    可以在仓库 Settings → Pages 里手动选择 main / docs")
    if not pages_url:
        pages_url = f"https://{login}.github.io/{REPO_NAME}/"
    print(f"    页面地址：{pages_url}")

    print("6/6 触发构建 …")
    build = api.post(f"/repos/{fork_full}/pages/builds", json={})
    print(f"    构建请求：HTTP {build.status_code}")

    repo = api.get(f"/repos/{fork_full}").json()
    print()
    print("[OK] 完成")
    print(f"   仓库：{repo['html_url']}")
    print(f"   页面：{pages_url}")
    print("   Pages 首次生效通常 1–2 分钟；期间 404 属于正常。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
