"""Local Gaussian noise images (NumPy + Pillow). No network / Comfy."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

_MAX_DIMENSION = 16_384


def _validate_dimensions(width: int, height: int) -> None:
    if not isinstance(width, int) or not isinstance(height, int):
        raise TypeError("width and height must be integers")
    if width < 1 or height < 1:
        raise ValueError("width and height must be positive")
    if width > _MAX_DIMENSION or height > _MAX_DIMENSION:
        raise ValueError(
            f"width and height must be at most {_MAX_DIMENSION} (got {width}x{height})"
        )


def gaussian_noise_image(
    width: int,
    height: int,
    *,
    channels: int = 3,
    seed: int | None = None,
    mean: float = 127.5,
    std: float = 25.0,
    grayscale: bool = False,
) -> Image.Image:
    """
    Build an ``RGB`` Pillow image of i.i.d. Gaussian noise per pixel (per channel).

    If ``grayscale`` is True, one noise plane is drawn and broadcast to RGB.
    If ``channels`` is 1 (and not grayscale), a single plane is broadcast to RGB.
    """
    _validate_dimensions(width, height)
    if grayscale:
        plane_count = 1
    else:
        if channels not in (1, 3):
            raise ValueError("channels must be 1 or 3")
        plane_count = channels

    rng = np.random.default_rng(seed)
    raw = rng.normal(loc=mean, scale=std, size=(height, width, plane_count))
    if raw.shape[2] == 1:
        raw = np.repeat(raw, 3, axis=2)
    arr = np.clip(raw, 0.0, 255.0).astype(np.uint8)
    return Image.fromarray(arr, mode="RGB")


def save_noise_png(
    path: str | Path,
    width: int,
    height: int,
    **kwargs: Any,
) -> None:
    """Generate noise and write a PNG to ``path``. ``kwargs`` match ``gaussian_noise_image``."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    img = gaussian_noise_image(width, height, **kwargs)
    img.save(path, format="PNG")
