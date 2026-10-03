"""Draws the app icon (the ⧉ brand mark: two overlapping rounded squares)
at every size Windows uses and writes assets/icon.ico plus a 256 px
assets/icon.png. Rerun after changing the design: python scripts/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parent.parent / "assets"
BLUE = (59, 110, 245, 255)
WHITE = (255, 255, 255, 255)
SIZE = 1024  # drawn large, scaled down for each icon size


def draw() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)
    # Background tile.
    d.rounded_rectangle((32, 32, SIZE - 32, SIZE - 32), radius=220, fill=BLUE)
    # Back square (outline) and front square (solid), offset like ⧉.
    line = 64
    d.rounded_rectangle((250, 250, 640, 640), radius=70, outline=WHITE, width=line)
    d.rounded_rectangle((400, 400, 790, 790), radius=70, fill=WHITE)
    return image


def main() -> None:
    big = draw()
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    big.resize((256, 256), Image.LANCZOS).save(ASSETS / "icon.png")
    big.save(ASSETS / "icon.ico", sizes=[(s, s) for s in sizes])
    print("wrote", ASSETS / "icon.ico", "and icon.png")


if __name__ == "__main__":
    main()
