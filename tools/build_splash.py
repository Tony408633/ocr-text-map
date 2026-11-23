"""生成 iOS “添加到主屏幕”的启动图（apple-touch-startup-image）。

没有 Mac 也能让 PWA 启动时不白屏：iOS 会先显示这张启动图，再加载页面。
生成后自动把 <link> 写进 前端/index.html 的 splash 标记之间。
"""

from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "前端" / "splash"
INDEX = ROOT / "前端" / "index.html"

BG = (244, 242, 234)          # 与网页浅色主题一致
JADE = (15, 107, 88)
INK = (28, 36, 33)
MUTED = (90, 99, 95)

# (CSS 宽, CSS 高, DPR) —— 覆盖常见 iPhone
DEVICES = [
    (430, 932, 3),
    (428, 926, 3),
    (414, 896, 2),
    (414, 896, 3),
    (393, 852, 3),
    (390, 844, 3),
    (375, 812, 3),
    (375, 667, 2),
    (320, 568, 2),
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\simhei.ttf"):
        if Path(path).is_file():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render(width: int, height: int, dpr: int) -> Path:
    pixel_w, pixel_h = width * dpr, height * dpr
    image = Image.new("RGB", (pixel_w, pixel_h), BG)
    draw = ImageDraw.Draw(image)

    logo = int(min(pixel_w, pixel_h) * 0.20)
    left = (pixel_w - logo) // 2
    top = int(pixel_h * 0.40)
    radius = logo // 4
    draw.rounded_rectangle([left, top, left + logo, top + logo], radius=radius, fill=JADE)

    glyph_font = load_font(int(logo * 0.5))
    glyph = "纸"
    box = draw.textbbox((0, 0), glyph, font=glyph_font)
    draw.text(
        (left + (logo - (box[2] - box[0])) / 2 - box[0],
         top + (logo - (box[3] - box[1])) / 2 - box[1]),
        glyph,
        font=glyph_font,
        fill=(255, 255, 255),
    )

    title_font = load_font(int(logo * 0.36))
    title = "纸伴"
    box = draw.textbbox((0, 0), title, font=title_font)
    draw.text(((pixel_w - (box[2] - box[0])) / 2 - box[0], top + logo + int(logo * 0.22)), title, font=title_font, fill=INK)

    tip_font = load_font(int(logo * 0.20))
    tip = "陪你读书"
    box = draw.textbbox((0, 0), tip, font=tip_font)
    draw.text(
        ((pixel_w - (box[2] - box[0])) / 2 - box[0], top + logo + int(logo * 0.78)),
        tip,
        font=tip_font,
        fill=MUTED,
    )

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"launch-{width}x{height}@{dpr}x.png"
    image.save(path, optimize=True)
    return path


def links() -> str:
    lines = []
    for width, height, dpr in DEVICES:
        href = f"./splash/launch-{width}x{height}@{dpr}x.png"
        media = (
            f"(device-width: {width}px) and (device-height: {height}px) "
            f"and (-webkit-device-pixel-ratio: {dpr})"
        )
        lines.append(f'  <link rel="apple-touch-startup-image" href="{href}" media="{media}">')
    return "\n".join(lines)


def patch_index(html: str) -> str:
    block = "  <!-- splash:start -->\n" + links() + "\n  <!-- splash:end -->"
    if "<!-- splash:start -->" in html:
        return re.sub(r"  <!-- splash:start -->.*?<!-- splash:end -->", block, html, flags=re.S)
    return html.replace("  <link rel=\"manifest\"", block + "\n  <link rel=\"manifest\"", 1)


def main() -> None:
    for width, height, dpr in DEVICES:
        render(width, height, dpr)
    html = INDEX.read_text(encoding="utf-8")
    INDEX.write_text(patch_index(html), encoding="utf-8")
    files = sorted(OUT.glob("*.png"))
    total = sum(path.stat().st_size for path in files)
    print(f"生成 {len(files)} 张启动图，共 {total/1024:.0f} KB")
    print("已写入 前端/index.html")


if __name__ == "__main__":
    main()
