"""Sequence MP4 export dimensions from source image aspect (not previewAspect)."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from services.logic import (
    _SEQUENCE_TIMELINE_EXPORT_MAX_H,
    _SEQUENCE_TIMELINE_EXPORT_MAX_W,
    _sequence_export_dimensions_from_images,
)


def test_empty_paths_fallback() -> None:
    assert _sequence_export_dimensions_from_images([]) == (1280, 720)


def test_square_image_export(tmp_path: Path) -> None:
    p = tmp_path / "sq.png"
    Image.new("RGB", (512, 512), (255, 0, 0)).save(p)
    w, h = _sequence_export_dimensions_from_images([p])
    assert w == h
    assert w % 2 == 0 and h % 2 == 0
    assert w <= _SEQUENCE_TIMELINE_EXPORT_MAX_W
    assert h <= _SEQUENCE_TIMELINE_EXPORT_MAX_H
    assert w == 1080


def test_largest_area_wins_mixed_aspects(tmp_path: Path) -> None:
    portrait = tmp_path / "portrait.png"
    landscape = tmp_path / "landscape.png"
    Image.new("RGB", (768, 1024), (0, 255, 0)).save(portrait)
    Image.new("RGB", (1920, 1080), (0, 0, 255)).save(landscape)
    w, h = _sequence_export_dimensions_from_images([portrait, landscape])
    assert w == 1920
    assert h == 1080
    assert abs((w / h) - (1920 / 1080)) < 0.02


def test_portrait_only_not_16_9(tmp_path: Path) -> None:
    p = tmp_path / "tall.png"
    Image.new("RGB", (900, 1600), (128, 128, 128)).save(p)
    w, h = _sequence_export_dimensions_from_images([p])
    assert h > w
    assert w % 2 == 0 and h % 2 == 0
    assert w <= _SEQUENCE_TIMELINE_EXPORT_MAX_W
    assert h <= _SEQUENCE_TIMELINE_EXPORT_MAX_H
