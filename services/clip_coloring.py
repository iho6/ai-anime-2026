"""Alpha-aware clip coloring for timeline preview and export."""

from __future__ import annotations

from typing import Any

import numpy as np

DEFAULT_CLIP_COLORING: dict[str, int] = {
    "r": 100,
    "g": 100,
    "b": 100,
    "opacity": 100,
    "lightness": 0,
    "borderBlur": 0,
    "imageBlur": 0,
}

# Max Gaussian radius (px) at slider value 100; matches the frontend mapping.
MAX_BLUR_RADIUS_PX = 8.0


def _clamp_int(v: float, lo: int, hi: int) -> int:
    return int(max(lo, min(hi, round(float(v)))))


def normalize_clip_coloring(coloring: dict[str, Any] | None) -> dict[str, int]:
    src = coloring or {}
    out = dict(DEFAULT_CLIP_COLORING)
    for key in DEFAULT_CLIP_COLORING:
        if key in src and src[key] is not None:
            out[key] = _clamp_int(
                src[key],
                -100 if key == "lightness" else 0,
                200 if key in ("r", "g", "b") else 100,
            )
    return out


def is_default_clip_coloring(coloring: dict[str, Any] | None) -> bool:
    if not coloring:
        return True
    return normalize_clip_coloring(coloring) == DEFAULT_CLIP_COLORING


def apply_clip_coloring_rgba(im_rgba: Any, coloring: dict[str, Any] | None) -> Any:
    """Apply RGB gain, lightness, and opacity to opaque pixels only."""
    from PIL import Image

    if is_default_clip_coloring(coloring):
        return im_rgba

    if im_rgba.mode != "RGBA":
        im_rgba = im_rgba.convert("RGBA")

    c = normalize_clip_coloring(coloring)
    arr = np.array(im_rgba, dtype=np.float32)
    alpha = arr[:, :, 3]
    mask = alpha > 0
    if not np.any(mask):
        return im_rgba

    rgb = arr[:, :, :3]
    rgb[mask, 0] = np.clip(rgb[mask, 0] * (c["r"] / 100.0), 0, 255)
    rgb[mask, 1] = np.clip(rgb[mask, 1] * (c["g"] / 100.0), 0, 255)
    rgb[mask, 2] = np.clip(rgb[mask, 2] * (c["b"] / 100.0), 0, 255)

    lightness = c["lightness"]
    if lightness > 0:
        t = lightness / 100.0
        rgb[mask] = np.clip(rgb[mask] * (1.0 - t) + 255.0 * t, 0, 255)
    elif lightness < 0:
        t = -lightness / 100.0
        rgb[mask] = np.clip(rgb[mask] * (1.0 - t), 0, 255)

    opacity_factor = c["opacity"] / 100.0
    arr[:, :, 3] = np.where(mask, np.clip(alpha * opacity_factor, 0, 255), alpha)
    arr[:, :, :3] = rgb

    out = arr.astype(np.uint8)
    img = Image.fromarray(out, mode="RGBA")
    return _apply_blur(img, c)


def _apply_blur(img: Any, c: dict[str, int]) -> Any:
    """Apply whole-image blur then alpha-edge (border) feather blur."""
    from PIL import Image, ImageFilter

    image_blur = c.get("imageBlur", 0)
    if image_blur > 0:
        radius = (image_blur / 100.0) * MAX_BLUR_RADIUS_PX
        img = img.filter(ImageFilter.GaussianBlur(radius))

    border_blur = c.get("borderBlur", 0)
    if border_blur > 0:
        radius = (border_blur / 100.0) * MAX_BLUR_RADIUS_PX
        r, g, b, a = img.split()
        a = a.filter(ImageFilter.GaussianBlur(radius))
        img = Image.merge("RGBA", (r, g, b, a))

    return img
