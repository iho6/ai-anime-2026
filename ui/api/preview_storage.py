"""Copy temp / upload files into character-scoped folders served by /assets/storage/."""

from __future__ import annotations

import shutil
from pathlib import Path

from services.character_storage import unique_suffix
from services import logic

from .storage_paths import ensure_path_under_character, storage_rel_from_abs


def persist_preview_from_abs(abs_src: str, char_key: str) -> str:
    """Copy a temp or external file into ``<character>/.react_previews/``; return storage rel path."""
    src = Path(abs_src)
    if not src.is_file():
        raise ValueError(f"Preview source not found: {src}")
    character = logic.get_character_paths(char_key)
    dest_dir = character.character_dir / ".react_previews"
    dest_dir.mkdir(parents=True, exist_ok=True)
    ext = src.suffix.lower() or ".png"
    dest = dest_dir / f"preview_{unique_suffix()}{ext}"
    shutil.copy2(src, dest)
    ensure_path_under_character(char_key, dest)
    return storage_rel_from_abs(str(dest))


def save_staging_upload(char_key: str, data: bytes, original_name: str) -> str:
    """Write upload bytes under ``<character>/.react_staging/``; return storage rel path."""
    character = logic.get_character_paths(char_key)
    dest_dir = character.character_dir / ".react_staging"
    dest_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(original_name or "").suffix.lower()
    _allowed = {
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif",
        ".mp4", ".webm", ".mov", ".mkv", ".avi",
    }
    if suffix not in _allowed:
        suffix = ".png"
    dest = dest_dir / f"upload_{unique_suffix()}{suffix}"
    dest.write_bytes(data)
    ensure_path_under_character(char_key, dest)
    return storage_rel_from_abs(str(dest))
