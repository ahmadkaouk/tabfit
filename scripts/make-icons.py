"""Regenerate the checked-in extension icons. Requires Pillow; not needed to run TabFit."""
from math import cos, pi, sin
from pathlib import Path
from PIL import Image, ImageDraw

destination = Path(__file__).resolve().parents[1] / "extension" / "icons"
destination.mkdir(exist_ok=True)
scale = 8
size = 128 * scale


def cubic(p0, p1, p2, p3, steps=24):
    return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d
                  for a, b, c, d in zip(p0, p1, p2, p3)) for t in (i / steps for i in range(1, steps + 1))]


def arc(center, radius, start, end, steps=24):
    return [(center[0] + radius * cos(a), center[1] + radius * sin(a))
            for a in (start + (end - start) * i / steps for i in range(1, steps + 1))]


# The mark: a browser tab rising from its tab strip, the same path as the popup's
# "M1.5 20.5c2 0 3.5-1 3.5-3V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v9.5c0 2 1.5 3 3.5 3z".
tab = [(1.5, 20.5), *cubic((1.5, 20.5), (3.5, 20.5), (5, 19.5), (5, 17.5)), (5, 8),
       *arc((8, 8), 3, pi, 1.5 * pi), (16, 5), *arc((16, 8), 3, 1.5 * pi, 2 * pi), (19, 17.5),
       *cubic((19, 17.5), (19, 19.5), (20.5, 20.5), (22.5, 20.5))]
unit = 76 * scale / 21  # the tab is 21 units wide; draw it 76px wide at 128px
left, top = (size - 21 * unit) / 2, (size - 15.5 * unit) / 2

canvas = Image.new("RGBA", (size, size))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=28 * scale, fill="#2f5bff")
draw.polygon([(left + (x - 1.5) * unit, top + (y - 5) * unit) for x, y in tab], fill="#ffffff")
for px in (16, 32, 48, 128):
    canvas.resize((px, px), Image.Resampling.LANCZOS).save(destination / f"icon-{px}.png")
