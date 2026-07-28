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
import logging
from pathlib import Path
from typing import Any

from services.character_storage import DEFAULT_STORAGE_ROOT, sanitize_for_folder

# ``DEFAULT_STORAGE_ROOT`` points at ``storage/characters``; timelines sit beside it.
TIMELINES_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "timelines").resolve()

_MANIFEST_NAME = "manifest.json"
logger = logging.getLogger(__name__)


def timelines_root() -> Path:
    return TIMELINES_STORAGE_ROOT


def timeline_dir(timeline_key: str) -> Path:
    return (TIMELINES_STORAGE_ROOT / sanitize_for_folder(timeline_key)).resolve()


def timeline_clips_dir(timeline_key: str) -> Path:
    return timeline_dir(timeline_key) / "clips"


def timeline_assets_dir(timeline_key: str) -> Path:
    return timeline_dir(timeline_key) / "assets"


def timeline_frames_root(timeline_key: str) -> Path:
    """Root of all per-clip / per-group frame folders for a timeline."""
    return timeline_dir(timeline_key) / "frames"


def timeline_frames_dir(timeline_key: str, clip_id: str) -> Path:
    return timeline_frames_root(timeline_key) / sanitize_for_folder(clip_id)


def timeline_abs_to_rel(abs_path: Path | str) -> str:
    p = Path(abs_path).resolve()
    rel = p.relative_to(TIMELINES_STORAGE_ROOT.resolve())
    return str(Path("timelines") / rel).replace("\\", "/")


def timeline_rel_to_abs(rel_path: str) -> Path:
    rel = Path(str(rel_path).replace("\\", "/").lstrip("/"))
    parts = rel.parts
    if parts and parts[0].lower() == "timelines":
        rel = Path(*parts[1:])
    target = (TIMELINES_STORAGE_ROOT / rel).resolve()
    root = TIMELINES_STORAGE_ROOT.resolve()
    if root != target and root not in target.parents:
        raise ValueError("Timeline-relative path escapes root")
    return target


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
    text = path.read_text(encoding="utf-8")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as ex:
        # Trailing junk (e.g. an extra ``}``) — take the first complete object.
        if "Extra data" not in str(ex):
            raise
        data, end = json.JSONDecoder().raw_decode(text)
        leftover = text[end:].strip()
        logger.warning(
            "Timeline %s manifest has trailing data after first JSON object "
            "(%r); using first object only.",
            timeline_key,
            leftover[:80],
        )
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
