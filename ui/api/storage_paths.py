"""Resolve paths under DEFAULT_STORAGE_ROOT for the React UI API."""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

from services.character_storage import DEFAULT_STORAGE_ROOT
from services import logic

LOCATION_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "locations").resolve()
SHOTS_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "shots").resolve()
REFERENCES_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "references").resolve()
TIMELINES_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "timelines").resolve()
MOTION_REFS_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "motion_refs").resolve()


def resolve_storage_rel_file(rel_path: str) -> Path:
    """
    Resolve a relative path under DEFAULT_STORAGE_ROOT.
    Prevents path traversal by enforcing containment.
    """
    rel = Path(rel_path)
    rel_parts = rel.parts
    if rel_parts and rel_parts[0].lower() == "locations":
        root = LOCATION_STORAGE_ROOT.resolve()
        rel = Path(*rel_parts[1:])
    elif rel_parts and rel_parts[0].lower() == "shots":
        root = SHOTS_STORAGE_ROOT.resolve()
        rel = Path(*rel_parts[1:])
    elif rel_parts and rel_parts[0].lower() == "references":
        root = REFERENCES_STORAGE_ROOT.resolve()
        rel = Path(*rel_parts[1:])
    elif rel_parts and rel_parts[0].lower() == "timelines":
        root = TIMELINES_STORAGE_ROOT.resolve()
        rel = Path(*rel_parts[1:])
    elif rel_parts and rel_parts[0].lower() == "motion_refs":
        root = MOTION_REFS_STORAGE_ROOT.resolve()
        rel = Path(*rel_parts[1:])
    else:
        root = DEFAULT_STORAGE_ROOT.resolve()
    target = (root / rel).resolve()
    if root != target and root not in target.parents:
        raise HTTPException(status_code=403, detail="Invalid path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return target


def storage_rel_from_abs(abs_path: str) -> str:
    p = Path(abs_path)
    try:
        rel = p.resolve().relative_to(DEFAULT_STORAGE_ROOT.resolve())
        return str(rel).replace("\\", "/")
    except Exception:
        pass
    try:
        rel = p.resolve().relative_to(LOCATION_STORAGE_ROOT.resolve())
        return str(Path("locations") / rel).replace("\\", "/")
    except Exception:
        pass
    try:
        rel = p.resolve().relative_to(SHOTS_STORAGE_ROOT.resolve())
        return str(Path("shots") / rel).replace("\\", "/")
    except Exception:
        pass
    try:
        rel = p.resolve().relative_to(REFERENCES_STORAGE_ROOT.resolve())
        return str(Path("references") / rel).replace("\\", "/")
    except Exception:
        pass
    try:
        rel = p.resolve().relative_to(TIMELINES_STORAGE_ROOT.resolve())
        return str(Path("timelines") / rel).replace("\\", "/")
    except Exception:
        pass
    try:
        rel = p.resolve().relative_to(MOTION_REFS_STORAGE_ROOT.resolve())
        return str(Path("motion_refs") / rel).replace("\\", "/")
    except Exception:
        return p.name


def resolve_location_rel_file(rel_path: str) -> Path:
    rel = Path(rel_path)
    rel_parts = rel.parts
    if rel_parts and rel_parts[0].lower() == "locations":
        rel = Path(*rel_parts[1:])
    target = (LOCATION_STORAGE_ROOT / rel).resolve()
    root = LOCATION_STORAGE_ROOT.resolve()
    if root != target and root not in target.parents:
        raise HTTPException(status_code=403, detail="Invalid location path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return target


def _character_dir_resolved(char_key: str) -> Path:
    return logic.get_character_paths(char_key).character_dir.resolve()


def ensure_path_under_character(char_key: str, target: Path) -> None:
    """Raise 403 if target is not under the character folder."""
    char_root = _character_dir_resolved(char_key)
    t = target.resolve()
    if char_root != t and char_root not in t.parents:
        raise HTTPException(status_code=403, detail="Path outside character folder")


def ensure_path_in_new_character_draft_root(target: Path) -> None:
    """Raise 403 unless ``target`` is a file directly inside ``characters/temp``."""
    draft_root = logic.new_character_draft_dir().resolve()
    t = target.resolve()
    if t.parent.resolve() != draft_root:
        raise HTTPException(status_code=403, detail="Path outside new-character draft folder")


def ensure_path_in_character_archive_root(target: Path) -> None:
    """Raise 403 unless ``target`` is a file directly inside ``characters/character_archive``."""
    arc_root = logic.character_archive_dir().resolve()
    t = target.resolve()
    if t.parent.resolve() != arc_root:
        raise HTTPException(status_code=403, detail="Path outside character archive folder")


def ensure_path_in_new_location_draft_root(target: Path) -> None:
    """Raise 403 unless ``target`` is a file directly inside ``locations/_drafts``."""
    draft_root = logic.new_location_draft_dir().resolve()
    t = target.resolve()
    if t.parent.resolve() != draft_root:
        raise HTTPException(status_code=403, detail="Path outside new-location draft folder")


def ensure_path_in_location_archive_root(target: Path) -> None:
    """Raise 403 unless ``target`` is a file directly inside ``locations/_location_archive``."""
    arc_root = logic.location_archive_dir().resolve()
    t = target.resolve()
    if t.parent.resolve() != arc_root:
        raise HTTPException(status_code=403, detail="Path outside location archive folder")
