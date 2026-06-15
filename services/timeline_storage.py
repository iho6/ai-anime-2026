"""
Storage helpers for multi-track video **timelines** under
``storage/timelines/<timeline_key>/``.

A timeline is a composite of clips (materialized character-sequence videos,
location/shot images, and music placeholders) arranged on layered tracks. Like
shots, a timeline is not owned by a single character, so it lives at its own
top-level storage root parallel to ``characters/``, ``locations/`` and ``shots/``.

Per-timeline layout::

    storage/timelines/<timeline_key>/
        manifest.json     # tracks[] -> clips[] (see TimelineManifest in the UI)
        poster.png        # hub cover (first visible frame), optional
        clips/            # materialized clip assets (mp4s + copied images)
        assets/           # generated gallery assets (T2I, etc.)
        assets_index.json # gallery order + metadata
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from services.character_storage import DEFAULT_STORAGE_ROOT, sanitize_for_folder

# ``DEFAULT_STORAGE_ROOT`` points at ``storage/characters``; timelines sit beside it.
TIMELINES_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "timelines").resolve()

_MANIFEST_NAME = "manifest.json"


def timelines_root() -> Path:
    return TIMELINES_STORAGE_ROOT


def timeline_dir(timeline_key: str) -> Path:
    return (TIMELINES_STORAGE_ROOT / sanitize_for_folder(timeline_key)).resolve()


def timeline_clips_dir(timeline_key: str) -> Path:
    return timeline_dir(timeline_key) / "clips"


def timeline_assets_dir(timeline_key: str) -> Path:
    return timeline_dir(timeline_key) / "assets"


def list_timeline_keys() -> list[str]:
    root = TIMELINES_STORAGE_ROOT
    if not root.exists():
        return []
    return sorted(
        [p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")],
        key=lambda s: s.lower(),
    )


def unique_timeline_key(base_name: str) -> str:
    """Return a sanitized, currently-unused folder key for a new timeline."""
    key = sanitize_for_folder(base_name) or "timeline"
    if not (TIMELINES_STORAGE_ROOT / key).exists():
        return key
    i = 2
    while (TIMELINES_STORAGE_ROOT / f"{key}_{i}").exists():
        i += 1
    return f"{key}_{i}"


def default_manifest() -> dict[str, Any]:
    return {
        "version": 2,
        "fps": 24,
        "previewAspect": "16:9",
        "tracks": [],
    }


def read_manifest(timeline_key: str) -> dict[str, Any]:
    path = timeline_dir(timeline_key) / _MANIFEST_NAME
    if not path.is_file():
        raise FileNotFoundError(f"Timeline manifest not found: {timeline_key}")
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("Invalid timeline manifest: expected an object.")
    return data


def write_manifest(timeline_key: str, manifest: dict[str, Any]) -> None:
    if not isinstance(manifest, dict):
        raise ValueError("Invalid timeline manifest: expected an object.")
    d = timeline_dir(timeline_key)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / (_MANIFEST_NAME + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    tmp.replace(d / _MANIFEST_NAME)


def create_timeline(base_name: str) -> str:
    """Create an empty timeline folder + manifest; return its key."""
    key = unique_timeline_key(base_name)
    d = timeline_dir(key)
    (d / "clips").mkdir(parents=True, exist_ok=True)
    (d / "assets").mkdir(parents=True, exist_ok=True)
    write_manifest(key, default_manifest())
    return key
