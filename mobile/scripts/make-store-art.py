"""Draws the two images Google Play asks for, from the same brand mark the app
already uses.

    py scripts/make-store-art.py

Writes into mobile/assets/play/:
  icon-512.png          512x512, the store icon (Play wants 32-bit PNG)
  feature-1024x500.png  1024x500, the graphic at the top of the listing
                        (no alpha channel — Play rejects one)

Play may draw the app's name over part of the feature graphic on some
surfaces, so the artwork keeps its text inside the middle band and leaves the
edges quiet.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OUT = ASSETS / "play"

BLUE = (59, 110, 245, 255)
BLUE_DEEP = (28, 62, 168, 255)
WHITE = (255, 255, 255, 255)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REGULAR = "C:/Windows/Fonts/segoeui.ttf"


def mark(size: int, scale: float, colour=WHITE) -> Image.Image:
    """The two overlapping rounded squares, centred, occupying `scale` of the canvas."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)
    side = size * scale
    left = top = (size - side) / 2
    unit = side / 10
    line = max(2, int(unit * 1.15))
    d.rounded_rectangle(
        (left, top, left + unit * 7, top + unit * 7), radius=unit * 1.2, outline=colour, width=line
    )
    d.rounded_rectangle(
        (left + unit * 3, top + unit * 3, left + unit * 10, top + unit * 10),
        radius=unit * 1.2,
        fill=colour,
    )
    return image


def store_icon() -> None:
    """The launcher icon at the size the store wants, drawn rather than scaled."""
    icon = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    ImageDraw.Draw(icon).rounded_rectangle((16, 16, 496, 496), radius=110, fill=BLUE)
    icon.alpha_composite(mark(512, 0.52))
    icon.save(OUT / "icon-512.png")


def feature_graphic() -> None:
    width, height = 1024, 500
    image = Image.new("RGB", (width, height), BLUE[:3])

    # A soft diagonal wash so the panel is not a flat rectangle.
    wash = Image.new("RGB", (width, height))
    for x in range(width):
        t = x / (width - 1)
        wash.paste(
            tuple(round(BLUE_DEEP[i] * t + BLUE[i] * (1 - t)) for i in range(3)),
            (x, 0, x + 1, height),
        )
    image = Image.blend(image, wash, 0.85)

    image.paste(
        mark(260, 0.62).convert("RGB"),
        (92, 120),
        mark(260, 0.62),
    )

    d = ImageDraw.Draw(image)
    title = ImageFont.truetype(FONT_BOLD, 72)
    tagline = ImageFont.truetype(FONT_REGULAR, 34)
    small = ImageFont.truetype(FONT_REGULAR, 26)

    d.text((392, 150), "Clipboard Sync", font=title, fill=WHITE[:3])
    d.text(
        (396, 244),
        "Your clipboard, passwords and files",
        font=tagline,
        fill=(226, 234, 255),
    )
    d.text((396, 288), "on every device — and yours alone", font=tagline, fill=(226, 234, 255))
    d.text((396, 360), "One of the products of GhoMicrosystems", font=small, fill=(186, 203, 255))

    image.save(OUT / "feature-1024x500.png")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    store_icon()
    feature_graphic()
    for path in sorted(OUT.glob("*.png")):
        with Image.open(path) as opened:
            print(f"{path.name}: {opened.size[0]}x{opened.size[1]} {opened.mode}")


if __name__ == "__main__":
    main()
