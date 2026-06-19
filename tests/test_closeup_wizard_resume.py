"""Tests for closeup wizard resume / hydrate-from-disk behavior."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from services.logic import (
    _CLOSEUP_STEPS,
    _load_closeup_saved_from_disk,
    start_closeup_wizard,
)


def _setup_char_dir(tmp_path: Path, char_key: str) -> Path:
    base_dir = tmp_path / char_key
    base_dir.mkdir(parents=True)
    base_img = base_dir / "base.png"
    Image.new("RGB", (128, 256), color=(0, 128, 0)).save(base_img)
    return base_dir


def _patch_character_paths(
    monkeypatch: pytest.MonkeyPatch, base_dir: Path, char_key: str
) -> None:
    monkeypatch.setattr(
        "services.logic.get_character_paths",
        lambda _k: SimpleNamespace(base_dir=base_dir, character_dir=base_dir),
    )
    monkeypatch.setattr(
        "services.logic.character_base_source_image_path",
        lambda _k: str(base_dir / "base.png"),
    )
    monkeypatch.setattr(
        "services.logic.resolve_storage_rel_path_to_abs",
        lambda rel: Path(rel) if Path(rel).is_absolute() else base_dir / Path(rel).name,
    )
    monkeypatch.setattr(
        "services.logic._abs_to_storage_rel",
        lambda p: Path(p).name,
    )


def test_load_closeup_saved_from_disk_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    char_key = "empty_char"
    base_dir = _setup_char_dir(tmp_path, char_key)
    _patch_character_paths(monkeypatch, base_dir, char_key)
    assert _load_closeup_saved_from_disk(char_key) == {}


def test_load_closeup_saved_from_disk_partial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    char_key = "partial_char"
    base_dir = _setup_char_dir(tmp_path, char_key)
    front_path = base_dir / "base_closeup_front.png"
    left_path = base_dir / "base_closeup_left.png"
    Image.new("RGB", (64, 64), color=(255, 0, 0)).save(front_path)
    Image.new("RGB", (64, 64), color=(0, 0, 255)).save(left_path)
    _patch_character_paths(monkeypatch, base_dir, char_key)

    saved = _load_closeup_saved_from_disk(char_key)
    assert saved == {
        "front": "base_closeup_front.png",
        "left": "base_closeup_left.png",
    }


def test_start_closeup_wizard_initial_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    char_key = "initial_char"
    base_dir = _setup_char_dir(tmp_path, char_key)
    _patch_character_paths(monkeypatch, base_dir, char_key)

    result = start_closeup_wizard(char_key, resume=False)
    assert result["currentStepIndex"] == 0
    assert result["saved"] == {}
    assert result["failed"] == {}
    assert "compositePreviewRelPath" not in result


def test_start_closeup_wizard_resume_hydrates_all_four(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    char_key = "full_char"
    base_dir = _setup_char_dir(tmp_path, char_key)
    for step_key, _aid, _label in _CLOSEUP_STEPS:
        stem = f"base_closeup_{step_key}"
        Image.new("RGB", (64, 64), color=(128, 128, 128)).save(
            base_dir / f"{stem}.png"
        )
    _patch_character_paths(monkeypatch, base_dir, char_key)

    result = start_closeup_wizard(char_key, resume=True)
    assert set(result["saved"].keys()) == {"front", "left", "right", "back"}
    assert result["currentStepIndex"] == 3
    assert result["stepKey"] == "back"
    assert isinstance(result.get("compositePreviewRelPath"), str)
    assert result["compositePreviewRelPath"]
    assert result.get("candidateRelPath") == result["saved"]["back"]
    assert (base_dir / "base_closeup.png").is_file()
    assert (base_dir / "base_combined.png").is_file()


def test_start_closeup_wizard_resume_partial_step_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    char_key = "partial_resume_char"
    base_dir = _setup_char_dir(tmp_path, char_key)
    Image.new("RGB", (64, 64), color=(255, 0, 0)).save(
        base_dir / "base_closeup_front.png"
    )
    Image.new("RGB", (64, 64), color=(0, 0, 255)).save(
        base_dir / "base_closeup_left.png"
    )
    _patch_character_paths(monkeypatch, base_dir, char_key)

    result = start_closeup_wizard(char_key, resume=True)
    assert result["currentStepIndex"] == 2
    assert result["stepKey"] == "right"
    assert set(result["saved"].keys()) == {"front", "left"}
    assert isinstance(result.get("compositePreviewRelPath"), str)
    assert result["compositePreviewRelPath"]
    assert "candidateRelPath" not in result
