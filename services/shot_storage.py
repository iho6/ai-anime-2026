"""
Storage helpers for film "shots" under ``storage/shots/<shot_key>/``.

A shot composites one location backdrop with one or more character images and
is rendered into a finished frame by the Qwen image-edit service. Unlike
characters/locations a shot is not owned by a single character, so it lives at
its own top-level storage root parallel to ``characters/`` and ``locations/``.

Per-shot layout::

    storage/shots/<shot_key>/
        backdrop.png      # original location image (Qwen image 1, pristine)
        composite.png     # flattened backdrop + character overlay (Qwen image 2)
        generated.png     # Qwen output
        metadata.json     # see ``write_shot_metadata``
"""

from __future__ import annotations

from pathlib import Path

from services.character_storage import DEFAULT_STORAGE_ROOT, sanitize_for_folder

# ``DEFAULT_STORAGE_ROOT`` points at ``storage/characters``; shots sit beside it.
SHOTS_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "shots").resolve()


def shots_root() -> Path:
    return SHOTS_STORAGE_ROOT


def shot_dir(shot_key: str) -> Path:
    return SHOTS_STORAGE_ROOT / sanitize_for_folder(shot_key)


def list_shot_keys() -> list[str]:
    root = SHOTS_STORAGE_ROOT
    if not root.exists():
        return []
    return sorted(
        [p.name for p in root.iterdir() if p.is_dir()],
        key=lambda s: s.lower(),
    )


def unique_shot_key(base_name: str) -> str:
    """Return a sanitized, currently-unused folder key for a new shot."""
    key = sanitize_for_folder(base_name)
    if not (SHOTS_STORAGE_ROOT / key).exists():
        return key
    i = 2
    while (SHOTS_STORAGE_ROOT / f"{key}_{i}").exists():
        i += 1
    return f"{key}_{i}"
