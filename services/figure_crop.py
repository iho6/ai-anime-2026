"""
Figure crop / placement helpers for motion-ref keypoint and Qwen generation.

A ``placedFigure`` stores canvas size + pixel placement so SDPose and Qwen can run
on a tight crop while outputs are composited back to the original frame.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image

FIGURE_CROP_PAD_FRAC = 0.15
MIN_CROP_SIZE = 64


def pad_clamp_bbox(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    img_w: int,
    img_h: int,
    *,
    pad_frac: float = FIGURE_CROP_PAD_FRAC,
    min_size: int = MIN_CROP_SIZE,
) -> dict[str, int]:
    """Expand an AABB by ``pad_frac``, clamp to image bounds, enforce minimum size."""
    if img_w < 1 or img_h < 1:
        raise ValueError("Image dimensions must be positive.")
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    bw = max(x2 - x1, 1.0)
    bh = max(y2 - y1, 1.0)
    pad_x = bw * pad_frac
    pad_y = bh * pad_frac
    x1 -= pad_x
    y1 -= pad_y
    x2 += pad_x
    y2 += pad_y
    ix1 = int(max(0, min(img_w - 1, round(x1))))
    iy1 = int(max(0, min(img_h - 1, round(y1))))
    ix2 = int(max(ix1 + 1, min(img_w, round(x2))))
    iy2 = int(max(iy1 + 1, min(img_h, round(y2))))
    w = ix2 - ix1
    h = iy2 - iy1
    if w < min_size:
        extra = min_size - w
        ix1 = max(0, ix1 - extra // 2)
        ix2 = min(img_w, ix1 + min_size)
        ix1 = max(0, ix2 - min_size)
        w = ix2 - ix1
    if h < min_size:
        extra = min_size - h
        iy1 = max(0, iy1 - extra // 2)
        iy2 = min(img_h, iy1 + min_size)
        iy1 = max(0, iy2 - min_size)
        h = iy2 - iy1
    return {"x": ix1, "y": iy1, "width": w, "height": h}


def placement_box(box: dict[str, int]) -> tuple[int, int, int, int]:
    return int(box["x"]), int(box["y"]), int(box["width"]), int(box["height"])


def build_placed_figure_meta(
    canvas_w: int,
    canvas_h: int,
    placement: dict[str, int],
) -> dict[str, Any]:
    x, y, w, h = placement_box(placement)
    return {
        "canvas": {"width": int(canvas_w), "height": int(canvas_h)},
        "placement": {"x": x, "y": y, "width": w, "height": h},
    }


def crop_image(
    image: Image.Image,
    box: dict[str, int],
) -> Image.Image:
    x, y, w, h = placement_box(box)
    return image.crop((x, y, x + w, y + h))


def crop_image_path(src: Path | str, box: dict[str, int], dest: Path | str) -> Path:
    dest_p = Path(dest)
    dest_p.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        crop_image(im.convert("RGB"), box).save(dest_p)
    return dest_p


def paste_patch_on_canvas(
    patch: Image.Image,
    canvas_w: int,
    canvas_h: int,
    box: dict[str, int],
    *,
    background: tuple[int, int, int] = (255, 255, 255),
    feather_px: int = 0,
) -> Image.Image:
    """Paste ``patch`` (RGB or RGBA) onto a fresh canvas at ``box``."""
    x, y, w, h = placement_box(box)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (*background, 255))
    patch_rgba = patch.convert("RGBA")
    if patch_rgba.size != (w, h):
        patch_rgba = patch_rgba.resize((w, h), Image.Resampling.LANCZOS)
    if feather_px > 0 and patch_rgba.mode == "RGBA":
        alpha = patch_rgba.split()[3]
        from PIL import ImageFilter

        alpha = alpha.filter(ImageFilter.GaussianBlur(radius=max(1, feather_px // 2)))
        patch_rgba.putalpha(alpha)
    canvas.paste(patch_rgba, (x, y), patch_rgba)
    return canvas


def paste_on_black_canvas(
    patch: Image.Image,
    canvas_w: int,
    canvas_h: int,
    box: dict[str, int],
) -> Image.Image:
    """Paste RGB patch on black (for SDPose skeleton overlays)."""
    rgb = paste_patch_on_canvas(
        patch, canvas_w, canvas_h, box, background=(0, 0, 0), feather_px=0
    )
    return rgb.convert("RGB")


def composite_rgba_on_white_plate(
    rgba_crop: Image.Image,
    canvas_w: int,
    canvas_h: int,
    box: dict[str, int],
) -> Image.Image:
    """Build a white-plate preview with the RGBA figure at ``box``."""
    return paste_patch_on_canvas(
        rgba_crop, canvas_w, canvas_h, box, background=(255, 255, 255), feather_px=4
    ).convert("RGB")
