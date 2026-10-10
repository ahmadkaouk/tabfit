"""Regenerate the checked-in extension icons. Requires Pillow; not needed to run TabFit."""
from pathlib import Path
from PIL import Image, ImageDraw

destination = Path(__file__).resolve().parents[1] / "extension" / "icons"
destination.mkdir(exist_ok=True)
for size in (16, 32, 48, 128):
    scale = 4
    canvas = Image.new("RGBA", (128 * scale, 128 * scale))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((0, 0, 128 * scale - 1, 128 * scale - 1), radius=30 * scale, fill="#49644e")
    draw.arc((28 * scale, 28 * scale, 100 * scale, 100 * scale), 5, 295, fill="#f8f9f4", width=19 * scale)
    draw.arc((28 * scale, 28 * scale, 100 * scale, 100 * scale), 297, 365, fill="#b5c3a4", width=19 * scale)
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(destination / f"icon-{size}.png")
