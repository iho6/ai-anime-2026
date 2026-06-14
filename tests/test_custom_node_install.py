"""ComfyUI custom node install helpers (no Comfy/GPU required)."""

from __future__ import annotations

from pathlib import Path

from services.logic import _custom_node_installed


def test_custom_node_not_installed_when_missing(tmp_path: Path) -> None:
    dest = tmp_path / "ComfyUI-RMBG"
    dest.mkdir()
    assert _custom_node_installed(dest, "__init__.py") is False


def test_custom_node_not_installed_when_empty_dir_exists(tmp_path: Path) -> None:
    dest = tmp_path / "ComfyUI-RMBG"
    dest.mkdir()
    (dest / "README.md").write_text("placeholder", encoding="utf-8")
    assert _custom_node_installed(dest, "__init__.py") is False


def test_custom_node_installed_when_marker_present(tmp_path: Path) -> None:
    dest = tmp_path / "ComfyUI-RMBG"
    dest.mkdir()
    (dest / "__init__.py").write_text("# node pack\n", encoding="utf-8")
    assert _custom_node_installed(dest, "__init__.py") is True
