"""Tests for alpha-aware clip coloring."""

from __future__ import annotations

import numpy as np
from PIL import Image

from services.clip_coloring import (
    apply_clip_coloring_rgba,
    is_default_clip_coloring,
    normalize_clip_coloring,
)


def _rgba_with_transparent_corner(size: int = 32) -> Image.Image:
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    arr[:, :, :3] = 200
    arr[:, :, 3] = 255
    arr[0:8, 0:8, 3] = 0
    arr[16:24, 16:24, :3] = [100, 50, 25]
    return Image.fromarray(arr, mode="RGBA")


def test_default_coloring_is_noop() -> None:
    im = _rgba_with_transparent_corner()
    out = apply_clip_coloring_rgba(im, None)
    assert np.array_equal(np.array(im), np.array(out))
    assert is_default_clip_coloring(None)
    assert is_default_clip_coloring({})


def test_rgb_gain_only_affects_opaque_pixels() -> None:
    im = _rgba_with_transparent_corner()
    out = apply_clip_coloring_rgba(im, {"r": 200, "g": 100, "b": 100})
    arr = np.array(out)
    assert arr[0, 0, 3] == 0
    assert arr[16, 16, 0] == 200
    assert arr[16, 16, 1] == 50
    assert arr[16, 16, 2] == 25


def test_lightness_white_on_subject_only() -> None:
    im = _rgba_with_transparent_corner()
    out = apply_clip_coloring_rgba(im, {"lightness": 100})
    arr = np.array(out)
    assert arr[0, 0, 3] == 0
    assert tuple(arr[16, 16, :3]) == (255, 255, 255)
    assert arr[16, 16, 3] == 255


def test_lightness_black_on_subject_only() -> None:
    im = _rgba_with_transparent_corner()
    out = apply_clip_coloring_rgba(im, {"lightness": -100})
    arr = np.array(out)
    assert arr[0, 0, 3] == 0
    assert tuple(arr[16, 16, :3]) == (0, 0, 0)
    assert arr[16, 16, 3] == 255


def test_opacity_scales_alpha_not_transparent_holes() -> None:
    im = _rgba_with_transparent_corner()
    out = apply_clip_coloring_rgba(im, {"opacity": 50})
    arr = np.array(out)
    assert arr[0, 0, 3] == 0
    assert arr[16, 16, 3] == 127


def test_normalize_clip_coloring_clamps() -> None:
    n = normalize_clip_coloring({"r": 999, "g": -5, "lightness": -200, "opacity": 150})
    assert n["r"] == 200
    assert n["g"] == 0
    assert n["lightness"] == -100
    assert n["opacity"] == 100


def test_blur_defaults_are_noop() -> None:
    assert is_default_clip_coloring({"borderBlur": 0, "imageBlur": 0})
    n = normalize_clip_coloring({})
    assert n["borderBlur"] == 0
    assert n["imageBlur"] == 0


def test_normalize_clip_coloring_clamps_blur() -> None:
    n = normalize_clip_coloring({"borderBlur": 999, "imageBlur": -5})
    assert n["borderBlur"] == 100
    assert n["imageBlur"] == 0


def test_image_blur_changes_pixels() -> None:
    im = _rgba_with_transparent_corner()
    assert not is_default_clip_coloring({"imageBlur": 50})
    out = apply_clip_coloring_rgba(im, {"imageBlur": 100})
    assert not np.array_equal(np.array(im), np.array(out))


def test_border_blur_feathers_alpha_edge() -> None:
    im = _rgba_with_transparent_corner()
    out = apply_clip_coloring_rgba(im, {"borderBlur": 100})
    arr = np.array(out)
    # The hard boundary between the transparent corner and opaque region
    # should now contain intermediate alpha values.
    edge = arr[0:16, 0:16, 3]
    assert np.any((edge > 0) & (edge < 255))
