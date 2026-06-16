"""Tests for figure crop / placement utilities."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from services.figure_crop import (
    MIN_SQUARE_WORKING_SIZE,
    build_placed_figure_meta,
    composite_rgba_on_white_plate,
    crop_image,
    extract_square_working_crop,
    pad_clamp_bbox,
    pad_clamp_square_bbox,
    paste_patch_on_canvas,
    paste_square_working_onto_canvas,
    placement_box,
    upscale_to_working_square,
)


def test_pad_clamp_bbox_expands_and_clamps() -> None:
    box = pad_clamp_bbox(100, 100, 200, 300, 400, 400, pad_frac=0.1, min_size=64)
    x, y, w, h = placement_box(box)
    assert x >= 0
    assert y >= 0
    assert x + w <= 400
    assert y + h <= 400
    assert w >= 64
    assert h >= 64


def test_pad_clamp_square_bbox_is_square() -> None:
    box = pad_clamp_square_bbox(100, 100, 200, 300, 400, 400, pad_frac=0.1, min_size=64)
    x, y, w, h = placement_box(box)
    assert w == h
    assert x >= 0
    assert y >= 0
    assert x + w <= 400
    assert y + h <= 400


def test_build_placed_figure_meta_squares_placement() -> None:
    meta = build_placed_figure_meta(1280, 720, {"x": 10, "y": 20, "width": 100, "height": 200})
    assert meta["canvas"] == {"width": 1280, "height": 720}
    assert meta["placement"]["width"] == meta["placement"]["height"]
    assert meta["workingSquareSize"] == MIN_SQUARE_WORKING_SIZE


def test_upscale_to_working_square_never_downscales() -> None:
    big = Image.new("RGB", (1200, 1200), color=(1, 2, 3))
    out = upscale_to_working_square(big, min_side=1024)
    assert out.size == (1200, 1200)


def test_upscale_to_working_square_upscales_small() -> None:
    small = Image.new("RGB", (80, 80), color=(1, 2, 3))
    out = upscale_to_working_square(small, min_side=1024)
    assert out.size == (1024, 1024)


def test_extract_square_working_crop_upscales() -> None:
    src = Image.new("RGB", (400, 300), color=(10, 20, 30))
    box = {"x": 50, "y": 40, "width": 120, "height": 120}
    out = extract_square_working_crop(src, box, min_side=1024)
    assert out.size == (1024, 1024)


def test_paste_patch_position() -> None:
    patch = Image.new("RGB", (50, 80), color=(255, 0, 0))
    canvas = paste_patch_on_canvas(
        patch, 200, 150, {"x": 30, "y": 40, "width": 50, "height": 80}
    )
    assert canvas.size == (200, 150)
    assert canvas.getpixel((30, 40))[:3] == (255, 0, 0)
    assert canvas.getpixel((0, 0))[:3] == (255, 255, 255)
    assert canvas.getpixel((199, 149))[:3] == (255, 255, 255)


def test_paste_square_working_onto_canvas_full_size() -> None:
    working = Image.new("RGB", (1024, 1024), color=(0, 255, 0))
    plate = paste_square_working_onto_canvas(
        working, 1600, 400, {"x": 1200, "y": 50, "width": 200, "height": 200}
    )
    assert plate.size == (1600, 400)
    assert plate.getpixel((0, 0)) == (255, 255, 255)


def test_composite_rgba_on_white_plate() -> None:
    rgba = Image.new("RGBA", (40, 60), color=(0, 128, 0, 200))
    plate = composite_rgba_on_white_plate(
        rgba, 120, 90, {"x": 10, "y": 15, "width": 40, "height": 60}
    )
    assert plate.size == (120, 90)
    assert plate.mode == "RGB"
    assert plate.getpixel((0, 0)) == (255, 255, 255)


def test_crop_image_round_trip() -> None:
    src = Image.new("RGB", (100, 80), color=(10, 20, 30))
    box = {"x": 20, "y": 10, "width": 40, "height": 50}
    cropped = crop_image(src, box)
    assert cropped.size == (40, 50)
