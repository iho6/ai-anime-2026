"""
Global reference library storage under ``storage/references/``.

Unlike characters/locations/shots, the reference library is a single global
store shared across the whole app. It holds two ordered collections:

* **images** — generic reference images (e.g. Qwen-Image text-to-image generations).
* **keypoints** — (original-image, skeleton) pairs produced by the SD pose
  service. This collection is shared with the per-character pose picker so every
  character can pick from the same skeleton references.

Layout::

    storage/references/
        images/      img_<id>.<ext>
        keypoints/   ref_<id>.<ext>   kp_<id>.<ext>
        _preview/    prev_<id>.png        # scratch for un-committed generations
        images.json     # ordered: [{id, relPath, createdAt}]
        keypoints.json  # ordered: [{id, referenceRelPath, keypointRelPath, createdAt}]
        .migrated       # marker: per-character pose refs migrated once

Paths in the JSON manifests and returned by these functions are
storage-relative with a ``references/`` prefix (e.g.
``references/images/img_ab12.png``), resolvable by the UI asset endpoint.
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from services.character_storage import DEFAULT_STORAGE_ROOT

# ``DEFAULT_STORAGE_ROOT`` points at ``storage/characters``; references sit beside it.
REFERENCES_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "references").resolve()

IMAGES_DIRNAME = "images"
KEYPOINTS_DIRNAME = "keypoints"
PREVIEW_DIRNAME = "_preview"
IMAGES_MANIFEST = "images.json"
KEYPOINTS_MANIFEST = "keypoints.json"
MIGRATED_MARKER = ".migrated"

_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


# --- paths --------------------------------------------------------------------


def references_root() -> Path:
    return REFERENCES_STORAGE_ROOT


def images_dir() -> Path:
    return REFERENCES_STORAGE_ROOT / IMAGES_DIRNAME


def keypoints_dir() -> Path:
    return REFERENCES_STORAGE_ROOT / KEYPOINTS_DIRNAME


def preview_dir() -> Path:
    return REFERENCES_STORAGE_ROOT / PREVIEW_DIRNAME


def _ensure_dirs() -> None:
    for d in (images_dir(), keypoints_dir(), preview_dir()):
        d.mkdir(parents=True, exist_ok=True)


def _abs_to_storage_rel(abs_path: Path) -> str:
    """Return ``references/<...>`` for a path under the references root."""
    rel = abs_path.resolve().relative_to(REFERENCES_STORAGE_ROOT)
    return ("references/" + str(rel).replace("\\", "/")).rstrip("/")


def resolve_rel(rel: str) -> Path:
    """Resolve a ``references/<...>`` storage-relative path to an absolute path."""
    return _resolve_rel(rel)


def _resolve_rel(rel: str) -> Path:
    """Resolve a ``references/<...>`` storage-relative path to an absolute path."""
    r = str(rel).replace("\\", "/").lstrip("/")
    if r.lower().startswith("references/"):
        r = r[len("references/") :]
    target = (REFERENCES_STORAGE_ROOT / r).resolve()
    root = REFERENCES_STORAGE_ROOT
    if root != target and root not in target.parents:
        raise ValueError("Reference-relative path escapes root")
    return target


# --- manifest helpers ---------------------------------------------------------


def _read_manifest(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_manifest(path: Path, entries: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def _images_manifest_path() -> Path:
    return REFERENCES_STORAGE_ROOT / IMAGES_MANIFEST


def _keypoints_manifest_path() -> Path:
    return REFERENCES_STORAGE_ROOT / KEYPOINTS_MANIFEST


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


# --- images -------------------------------------------------------------------


def add_image(src_abs: str) -> dict[str, Any]:
    """Copy ``src_abs`` into ``images/`` and prepend to the manifest."""
    _ensure_dirs()
    src = Path(src_abs)
    if not src.is_file():
        raise ValueError(f"Source image not found: {src}")
    rid = _new_id()
    ext = src.suffix.lower() or ".png"
    dest = images_dir() / f"img_{rid}{ext}"
    shutil.copy2(src, dest)
    entry = {
        "id": rid,
        "relPath": _abs_to_storage_rel(dest),
        "createdAt": time.time(),
    }
    entries = _read_manifest(_images_manifest_path())
    entries.insert(0, entry)
    _write_manifest(_images_manifest_path(), entries)
    return entry


def list_images() -> list[dict[str, Any]]:
    """Return image entries whose files still exist, in manifest order."""
    entries = _read_manifest(_images_manifest_path())
    out: list[dict[str, Any]] = []
    for e in entries:
        try:
            if _resolve_rel(e.get("relPath", "")).is_file():
                out.append(e)
        except Exception:
            continue
    return out


def delete_image(image_id: str) -> bool:
    entries = _read_manifest(_images_manifest_path())
    remaining: list[dict[str, Any]] = []
    found = False
    for e in entries:
        if e.get("id") == image_id:
            found = True
            try:
                _resolve_rel(e.get("relPath", "")).unlink(missing_ok=True)
            except Exception:
                pass
        else:
            remaining.append(e)
    if found:
        _write_manifest(_images_manifest_path(), remaining)
    return found


def set_images_order(order_ids: list[str]) -> None:
    entries = _read_manifest(_images_manifest_path())
    by_id = {e.get("id"): e for e in entries}
    ordered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rid in order_ids:
        e = by_id.get(rid)
        if e is not None and rid not in seen:
            ordered.append(e)
            seen.add(rid)
    for e in entries:  # append any not mentioned, preserving relative order
        if e.get("id") not in seen:
            ordered.append(e)
    _write_manifest(_images_manifest_path(), ordered)


# --- keypoints ----------------------------------------------------------------


def add_keypoint_pair(source_abs: str, keypoint_abs: str) -> dict[str, Any]:
    """Copy an (original, skeleton) pair into ``keypoints/`` and prepend."""
    _ensure_dirs()
    src = Path(source_abs)
    kp = Path(keypoint_abs)
    if not src.is_file():
        raise ValueError(f"Source image not found: {src}")
    if not kp.is_file():
        raise ValueError(f"Keypoint image not found: {kp}")
    rid = _new_id()
    src_ext = src.suffix.lower() or ".png"
    kp_ext = kp.suffix.lower() or ".png"
    ref_dest = keypoints_dir() / f"ref_{rid}{src_ext}"
    kp_dest = keypoints_dir() / f"kp_{rid}{kp_ext}"
    shutil.copy2(src, ref_dest)
    shutil.copy2(kp, kp_dest)
    entry = {
        "id": rid,
        "referenceRelPath": _abs_to_storage_rel(ref_dest),
        "keypointRelPath": _abs_to_storage_rel(kp_dest),
        "createdAt": time.time(),
    }
    entries = _read_manifest(_keypoints_manifest_path())
    entries.insert(0, entry)
    _write_manifest(_keypoints_manifest_path(), entries)
    return entry


def list_keypoints() -> list[dict[str, Any]]:
    """Return keypoint pairs whose files still exist. Triggers lazy migration."""
    migrate_character_pose_refs_once()
    entries = _read_manifest(_keypoints_manifest_path())
    out: list[dict[str, Any]] = []
    for e in entries:
        try:
            ref_ok = _resolve_rel(e.get("referenceRelPath", "")).is_file()
            kp_ok = _resolve_rel(e.get("keypointRelPath", "")).is_file()
        except Exception:
            continue
        if ref_ok and kp_ok:
            out.append(e)
    return out


def delete_keypoint(keypoint_id: str) -> bool:
    entries = _read_manifest(_keypoints_manifest_path())
    remaining: list[dict[str, Any]] = []
    found = False
    for e in entries:
        if e.get("id") == keypoint_id:
            found = True
            for key in ("referenceRelPath", "keypointRelPath"):
                try:
                    _resolve_rel(e.get(key, "")).unlink(missing_ok=True)
                except Exception:
                    pass
        else:
            remaining.append(e)
    if found:
        _write_manifest(_keypoints_manifest_path(), remaining)
    return found


def set_keypoints_order(order_ids: list[str]) -> None:
    entries = _read_manifest(_keypoints_manifest_path())
    by_id = {e.get("id"): e for e in entries}
    ordered: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rid in order_ids:
        e = by_id.get(rid)
        if e is not None and rid not in seen:
            ordered.append(e)
            seen.add(rid)
    for e in entries:
        if e.get("id") not in seen:
            ordered.append(e)
    _write_manifest(_keypoints_manifest_path(), ordered)


# --- scratch / preview --------------------------------------------------------


def add_preview(src_abs: str) -> str:
    """Copy ``src_abs`` into the ``_preview/`` scratch dir. Returns its rel path."""
    _ensure_dirs()
    src = Path(src_abs)
    if not src.is_file():
        raise ValueError(f"Source image not found: {src}")
    ext = src.suffix.lower() or ".png"
    dest = preview_dir() / f"prev_{_new_id()}{ext}"
    shutil.copy2(src, dest)
    return _abs_to_storage_rel(dest)


def commit_preview(preview_rel: str) -> dict[str, Any]:
    """Move a ``_preview/*`` file into ``images/`` and prepend to the manifest."""
    _ensure_dirs()
    src = _resolve_rel(preview_rel)
    if src.parent.resolve() != preview_dir().resolve():
        raise ValueError("Preview path is not under the preview scratch dir.")
    if not src.is_file():
        raise ValueError(f"Preview image not found: {src}")
    rid = _new_id()
    ext = src.suffix.lower() or ".png"
    dest = images_dir() / f"img_{rid}{ext}"
    shutil.move(str(src), str(dest))
    entry = {
        "id": rid,
        "relPath": _abs_to_storage_rel(dest),
        "createdAt": time.time(),
    }
    entries = _read_manifest(_images_manifest_path())
    entries.insert(0, entry)
    _write_manifest(_images_manifest_path(), entries)
    return entry


# --- migration ----------------------------------------------------------------


def migrate_character_pose_refs_once() -> int:
    """Copy every per-character ``.pose_references`` pair into the global store.

    Idempotent: writes a ``.migrated`` marker on first run and is a no-op after.
    Returns the number of pairs migrated (0 if already migrated).
    """
    marker = REFERENCES_STORAGE_ROOT / MIGRATED_MARKER
    if marker.exists():
        return 0
    _ensure_dirs()

    migrated = 0
    chars_root = DEFAULT_STORAGE_ROOT.resolve()
    try:
        char_dirs = [p for p in chars_root.iterdir() if p.is_dir()]
    except OSError:
        char_dirs = []

    existing = _read_manifest(_keypoints_manifest_path())
    for char_dir in char_dirs:
        manifest = char_dir / ".pose_references" / "refs.json"
        if not manifest.is_file():
            continue
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                continue
        except Exception:
            continue
        for e in data:
            if not isinstance(e, dict):
                continue
            ref_rel = e.get("referenceRelPath") or ""
            kp_rel = e.get("keypointRelPath") or ""
            # On-disk pose refs are character-relative (no <char_key>/ prefix).
            ref_abs = (char_dir / str(ref_rel).replace("\\", "/").lstrip("/")).resolve()
            kp_abs = (char_dir / str(kp_rel).replace("\\", "/").lstrip("/")).resolve()
            if not (ref_abs.is_file() and kp_abs.is_file()):
                continue
            rid = _new_id()
            ref_dest = keypoints_dir() / f"ref_{rid}{ref_abs.suffix.lower() or '.png'}"
            kp_dest = keypoints_dir() / f"kp_{rid}{kp_abs.suffix.lower() or '.png'}"
            try:
                shutil.copy2(ref_abs, ref_dest)
                shutil.copy2(kp_abs, kp_dest)
            except OSError:
                continue
            existing.append(
                {
                    "id": rid,
                    "referenceRelPath": _abs_to_storage_rel(ref_dest),
                    "keypointRelPath": _abs_to_storage_rel(kp_dest),
                    "createdAt": time.time(),
                }
            )
            migrated += 1

    _write_manifest(_keypoints_manifest_path(), existing)
    try:
        marker.write_text(f"migrated={migrated} at {time.time()}\n", encoding="utf-8")
    except OSError:
        pass
    return migrated
