"""Draws the app's store and launcher artwork from the same ⧉ brand mark the
desktop app uses, then `npx @capacitor/assets generate --android` turns these
into every size Android and Play need.

    python scripts/make-assets.py

Writes into mobile/assets/:
  icon.png             1024×1024, the plain icon (store listing, legacy icon)
  icon-foreground.png  1024×1024, mark only, inside the adaptive-icon safe area
  icon-background.png  1024×1024, the solid brand colour
  splash.png           2732×2732, mark centred on the brand colour
  splash-dark.png      same, dark background
"""
from pathlib import Path

from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parent.parent / "assets"
BLUE = (59, 110, 245, 255)
DARK = (15, 18, 22, 255)
WHITE = (255, 255, 255, 255)


def mark(size: int, scale: float, colour=WHITE) -> Image.Image:
    """The two overlapping rounded squares, centred, occupying `scale` of the canvas."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(image)
    side = size * scale
    left = (size - side) / 2
    top = (size - side) / 2
    unit = side / 10
    line = max(2, int(unit * 1.15))
    # Back square: outline. Front square: solid, offset down-right.
    d.rounded_rectangle(
        (left, top, left + unit * 7, top + unit * 7), radius=unit * 1.2, outline=colour, width=line
    )
    d.rounded_rectangle(
        (left + unit * 3, top + unit * 3, left + unit * 10, top + unit * 10),
        radius=unit * 1.2,
        fill=colour,
    )
    return image


def main() -> None:
    ASSETS.mkdir(exist_ok=True)

    icon = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    ImageDraw.Draw(icon).rounded_rectangle((32, 32, 992, 992), radius=220, fill=BLUE)
    icon.alpha_composite(mark(1024, 0.52))
    icon.save(ASSETS / "icon.png")

    # Adaptive icon: the launcher masks and animates these two layers, and it
    # crops generously, so the mark stays well inside the middle.
    Image.new("RGBA", (1024, 1024), BLUE).save(ASSETS / "icon-background.png")
    mark(1024, 0.40).save(ASSETS / "icon-foreground.png")

    for name, background in (("splash.png", BLUE), ("splash-dark.png", DARK)):
        splash = Image.new("RGBA", (2732, 2732), background)
        splash.alpha_composite(mark(2732, 0.16 if background == DARK else 0.16))
        splash.save(ASSETS / name)

    print("wrote", ", ".join(p.name for p in sorted(ASSETS.glob("*.png"))))


if __name__ == "__main__":
    main()
