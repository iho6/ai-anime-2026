"""Tests for partial closeup quadrant compositing."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from services.logic import (
    _CLOSEUP_COMPOSITE_BG_RGB,
    _CLOSEUP_COMPOSITE_TILE_SIZE,
    _build_closeup_quadrant_image,
    _write_closeup_and_combined,
)


def test_build_quadrant_partial_fills_missing_with_blank(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    front_path = tmp_path / "base_closeup_front.png"
    Image.new("RGB", (64, 64), color=(255, 0, 0)).save(front_path)

    saved = {"front": str(front_path)}
    monkeypatch.setattr(
        "services.logic.resolve_storage_rel_path_to_abs",
        lambda rel: Path(rel),
    )

    quad = _build_closeup_quadrant_image(saved, allow_partial=True)
    size = _CLOSEUP_COMPOSITE_TILE_SIZE
    assert quad.size == (size * 2, size * 2)

    sample = quad.getpixel((size // 2, size // 2))
    assert sample[0] > 200

    blank = quad.getpixel((size + size // 2, size // 2))
    assert blank == _CLOSEUP_COMPOSITE_BG_RGB


def test_write_closeup_and_combined_partial_writes_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    char_key = "test_char_partial"
    base_dir = tmp_path / char_key
    base_dir.mkdir(parents=True)
    base_img = base_dir / "base.png"
    Image.new("RGB", (128, 256), color=(0, 128, 0)).save(base_img)
    front_path = base_dir / "base_closeup_front.png"
    Image.new("RGB", (64, 64), color=(255, 0, 0)).save(front_path)

    monkeypatch.setattr(
        "services.logic.get_character_paths",
        lambda _k: SimpleNamespace(base_dir=base_dir, character_dir=base_dir),
    )
    monkeypatch.setattr(
        "services.logic.character_base_source_image_path",
        lambda _k: str(base_img),
    )
    monkeypatch.setattr(
        "services.logic.resolve_storage_rel_path_to_abs",
        lambda rel: Path(rel),
    )
    monkeypatch.setattr(
        "services.logic._abs_to_storage_rel",
        lambda p: Path(p).name,
    )

    saved = {"front": str(front_path)}
    closeup_rel, combined_rel = _write_closeup_and_combined(
        char_key, saved, allow_partial=True
    )
    assert closeup_rel == "base_closeup.png"
    assert combined_rel == "base_combined.png"
    assert (base_dir / "base_closeup.png").is_file()
    assert (base_dir / "base_combined.png").is_file()


def test_write_closeup_and_combined_strict_raises_on_missing_step(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    front_path = tmp_path / "base_closeup_front.png"
    Image.new("RGB", (8, 8), color=(255, 0, 0)).save(front_path)
    monkeypatch.setattr(
        "services.logic.resolve_storage_rel_path_to_abs",
        lambda rel: Path(rel),
    )
    with pytest.raises(ValueError, match="Missing saved step"):
        _write_closeup_and_combined(
            "any", {"front": str(front_path)}, allow_partial=False
        )


def test_write_closeup_and_combined_empty_saved_returns_none() -> None:
    assert _write_closeup_and_combined("any", {}, allow_partial=True) == (None, None)
