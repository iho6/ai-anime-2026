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
KEYPOINTS_UI_MANIFEST = "keypoints_ui.json"
KEYPOINTS_VIDEO_DIRNAME = "keypoints_video"
KEYPOINTS_VIDEO_MANIFEST = "keypoints_video.json"
FOLDER_TOKEN_PREFIX = "folder:"
VIDEO_TOKEN_PREFIX = "video:"
MIGRATED_MARKER = ".migrated"

_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi"}


# --- paths --------------------------------------------------------------------


def references_root() -> Path:
    return REFERENCES_STORAGE_ROOT


def images_dir() -> Path:
    return REFERENCES_STORAGE_ROOT / IMAGES_DIRNAME


def keypoints_dir() -> Path:
    return REFERENCES_STORAGE_ROOT / KEYPOINTS_DIRNAME


def keypoints_video_dir() -> Path:
    return REFERENCES_STORAGE_ROOT / KEYPOINTS_VIDEO_DIRNAME


def preview_dir() -> Path:
    return REFERENCES_STORAGE_ROOT / PREVIEW_DIRNAME


def _ensure_dirs() -> None:
    for d in (images_dir(), keypoints_dir(), keypoints_video_dir(), preview_dir()):
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


def _keypoints_ui_path() -> Path:
    return REFERENCES_STORAGE_ROOT / KEYPOINTS_UI_MANIFEST


def _keypoints_video_manifest_path() -> Path:
    return REFERENCES_STORAGE_ROOT / KEYPOINTS_VIDEO_MANIFEST


def _empty_ui_layout() -> dict[str, Any]:
    return {"rootOrder": [], "folders": [], "folderOrder": {}}


def _read_ui_layout() -> dict[str, Any]:
    path = _keypoints_ui_path()
    if not path.is_file():
        return _empty_ui_layout()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return _empty_ui_layout()
    if not isinstance(raw, dict):
        return _empty_ui_layout()
    folders = raw.get("folders") if isinstance(raw.get("folders"), list) else []
    root_order = raw.get("rootOrder") if isinstance(raw.get("rootOrder"), list) else []
    folder_order = raw.get("folderOrder") if isinstance(raw.get("folderOrder"), dict) else {}
    return {
        "rootOrder": [str(x) for x in root_order],
        "folders": [f for f in folders if isinstance(f, dict) and f.get("id")],
        "folderOrder": {
            str(k): [str(x) for x in (v or [])]
            for k, v in folder_order.items()
            if isinstance(v, list)
        },
    }


def _write_ui_layout(layout: dict[str, Any]) -> None:
    _write_manifest(_keypoints_ui_path(), layout)


def _folder_token(folder_id: str) -> str:
    return f"{FOLDER_TOKEN_PREFIX}{folder_id}"


def _parse_folder_token(token: str) -> str | None:
    s = str(token).strip()
    if s.startswith(FOLDER_TOKEN_PREFIX):
        return s[len(FOLDER_TOKEN_PREFIX) :]
    return None


def _video_token(video_id: str) -> str:
    return f"{VIDEO_TOKEN_PREFIX}{video_id}"


def _parse_video_token(token: str) -> str | None:
    s = str(token).strip()
    if s.startswith(VIDEO_TOKEN_PREFIX):
        return s[len(VIDEO_TOKEN_PREFIX) :]
    return None


def _sync_ui_layout_with_keypoints(
    entries: list[dict[str, Any]],
    *,
    video_entries: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Ensure UI layout exists and references only valid keypoint/folder/video ids."""
    layout = _read_ui_layout()
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    videos = video_entries if video_entries is not None else list_keypoint_videos()
    valid_video_ids = {str(e.get("id")) for e in videos if e.get("id")}
    folder_by_id = {
        str(f.get("id")): f
        for f in layout.get("folders", [])
        if f.get("id")
    }

    folder_order: dict[str, list[str]] = {}
    in_folder: set[str] = set()
    for fid, ids in (layout.get("folderOrder") or {}).items():
        if fid not in folder_by_id:
            continue
        cleaned = [i for i in ids if i in valid_ids]
        folder_order[fid] = cleaned
        in_folder.update(cleaned)

    root_order: list[str] = []
    seen_root: set[str] = set()
    for tok in layout.get("rootOrder") or []:
        s = str(tok).strip()
        if not s or s in seen_root:
            continue
        fid = _parse_folder_token(s)
        if fid is not None:
            if fid in folder_by_id:
                root_order.append(_folder_token(fid))
                seen_root.add(s)
            continue
        vid = _parse_video_token(s)
        if vid is not None:
            if vid in valid_video_ids:
                root_order.append(_video_token(vid))
                seen_root.add(s)
            continue
        if s in valid_ids and s not in in_folder:
            root_order.append(s)
            seen_root.add(s)

    for fid in folder_by_id:
        tok = _folder_token(fid)
        if tok not in seen_root:
            root_order.append(tok)
            seen_root.add(tok)

    for e in entries:
        iid = str(e.get("id"))
        if iid not in in_folder and iid not in {
            t for t in root_order
            if not _parse_folder_token(t) and not _parse_video_token(t)
        }:
            root_order.append(iid)

    for e in videos:
        iid = str(e.get("id"))
        tok = _video_token(iid)
        if tok not in seen_root:
            root_order.insert(0, tok)
            seen_root.add(tok)

    folders = [
        {"id": fid, "name": str(folder_by_id[fid].get("name") or fid)}
        for fid in folder_order
    ]
    for fid, f in folder_by_id.items():
        if fid not in folder_order:
            folders.append({"id": fid, "name": str(f.get("name") or fid)})
            folder_order.setdefault(fid, [])

    out = {"rootOrder": root_order, "folders": folders, "folderOrder": folder_order}
    _write_ui_layout(out)
    return out


def _remove_keypoint_from_ui(keypoint_id: str) -> None:
    entries = _read_manifest(_keypoints_manifest_path())
    layout = _sync_ui_layout_with_keypoints(
        [e for e in entries if e.get("id") != keypoint_id]
    )
    kid = str(keypoint_id)
    layout["rootOrder"] = [t for t in layout["rootOrder"] if t != kid]
    fo: dict[str, list[str]] = {}
    for fid, ids in layout["folderOrder"].items():
        fo[fid] = [i for i in ids if i != kid]
    layout["folderOrder"] = fo
    _write_ui_layout(layout)


def get_keypoints_layout() -> dict[str, Any]:
    """Return picker layout: folders, rootOrder, folderOrder, keypoint and video items."""
    entries = list_keypoints()
    video_entries = list_keypoint_videos()
    layout = _sync_ui_layout_with_keypoints(entries, video_entries=video_entries)
    items = [
        {
            "id": e["id"],
            "referenceRelPath": e["referenceRelPath"],
            "keypointRelPath": e["keypointRelPath"],
        }
        for e in entries
    ]
    video_items = [
        {
            "id": e["id"],
            "videoRelPath": e["videoRelPath"],
            "fps": int(e.get("fps") or 24),
            "frameSequence": e.get("frameSequence") or {},
        }
        for e in video_entries
    ]
    return {
        "folders": layout["folders"],
        "rootOrder": layout["rootOrder"],
        "folderOrder": layout["folderOrder"],
        "items": items,
        "videoItems": video_items,
    }


def set_keypoints_root_order(order: list[str]) -> None:
    entries = list_keypoints()
    video_entries = list_keypoint_videos()
    layout = _sync_ui_layout_with_keypoints(entries, video_entries=video_entries)
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    valid_video_ids = {str(e.get("id")) for e in video_entries if e.get("id")}
    folder_ids = {str(f.get("id")) for f in layout["folders"] if f.get("id")}
    in_folder: set[str] = set()
    for ids in layout["folderOrder"].values():
        in_folder.update(ids)

    next_root: list[str] = []
    seen: set[str] = set()
    for tok in order or []:
        s = str(tok).strip()
        if not s or s in seen:
            continue
        fid = _parse_folder_token(s)
        if fid is not None:
            if fid in folder_ids:
                next_root.append(_folder_token(fid))
                seen.add(s)
            continue
        vid = _parse_video_token(s)
        if vid is not None:
            if vid in valid_video_ids:
                next_root.append(_video_token(vid))
                seen.add(s)
            continue
        if s in valid_ids and s not in in_folder:
            next_root.append(s)
            seen.add(s)

    for tok in layout["rootOrder"]:
        if tok not in seen:
            fid = _parse_folder_token(tok)
            if fid is not None and _folder_token(fid) not in seen:
                next_root.append(_folder_token(fid))
                seen.add(tok)
            elif _parse_video_token(tok) and _parse_video_token(tok) in valid_video_ids:
                vt = _video_token(_parse_video_token(tok) or "")
                if vt not in seen:
                    next_root.append(vt)
                    seen.add(tok)
            elif tok in valid_ids and tok not in in_folder and tok not in seen:
                next_root.append(tok)
                seen.add(tok)

    layout["rootOrder"] = next_root
    _write_ui_layout(layout)


def set_keypoint_folder_order(folder_id: str, order: list[str]) -> None:
    fid = str(folder_id).strip()
    if not fid:
        raise ValueError("folderId is required.")
    entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(entries)
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    if not any(str(f.get("id")) == fid for f in layout["folders"]):
        raise ValueError("Folder not found.")

    cleaned: list[str] = []
    seen: set[str] = set()
    for iid in order or []:
        s = str(iid).strip()
        if s in valid_ids and s not in seen:
            cleaned.append(s)
            seen.add(s)
    for iid in layout["folderOrder"].get(fid, []):
        if iid in valid_ids and iid not in seen:
            cleaned.append(iid)
            seen.add(iid)

    layout["folderOrder"][fid] = cleaned
    in_folder = {i for ids in layout["folderOrder"].values() for i in ids}
    layout["rootOrder"] = [
        t for t in layout["rootOrder"] if _parse_folder_token(t) or t not in in_folder
    ]
    _write_ui_layout(layout)


def create_keypoint_folder(name: str, item_ids: list[str]) -> dict[str, Any]:
    label = (name or "").strip() or "Folder"
    entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(entries)
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    ids = [str(x) for x in item_ids if str(x) in valid_ids]
    if not ids:
        raise ValueError("Select at least one keypoint to folder.")

    fid = _new_id()
    folder = {"id": fid, "name": label}
    layout["folders"].append(folder)
    for iid in ids:
        layout["rootOrder"] = [t for t in layout["rootOrder"] if t != iid]
        for fk in list(layout["folderOrder"].keys()):
            layout["folderOrder"][fk] = [
                x for x in layout["folderOrder"].get(fk, []) if x != iid
            ]
    layout["folderOrder"][fid] = ids
    if _folder_token(fid) not in layout["rootOrder"]:
        layout["rootOrder"].append(_folder_token(fid))
    _write_ui_layout(layout)
    return folder


def assign_keypoints_to_folder(folder_id: str | None, item_ids: list[str]) -> None:
    entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(entries)
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    ids = [str(x) for x in item_ids if str(x) in valid_ids]
    if not ids:
        return

    if folder_id:
        fid = str(folder_id).strip()
        if not any(str(f.get("id")) == fid for f in layout["folders"]):
            raise ValueError("Folder not found.")
        for iid in ids:
            layout["rootOrder"] = [t for t in layout["rootOrder"] if t != iid]
            for fk in list(layout["folderOrder"].keys()):
                layout["folderOrder"][fk] = [
                    x for x in layout["folderOrder"].get(fk, []) if x != iid
                ]
        existing = layout["folderOrder"].get(fid, [])
        merged = existing + [i for i in ids if i not in existing]
        layout["folderOrder"][fid] = merged
        if _folder_token(fid) not in layout["rootOrder"]:
            layout["rootOrder"].append(_folder_token(fid))
    else:
        for iid in ids:
            for fk in list(layout["folderOrder"].keys()):
                layout["folderOrder"][fk] = [
                    x for x in layout["folderOrder"].get(fk, []) if x != iid
                ]
            if iid not in layout["rootOrder"]:
                layout["rootOrder"].append(iid)
    _write_ui_layout(layout)


def delete_keypoint_folder(folder_id: str) -> bool:
    fid = str(folder_id).strip()
    if not fid:
        return False
    entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(entries)
    before = len(layout["folders"])
    layout["folders"] = [f for f in layout["folders"] if str(f.get("id")) != fid]
    if len(layout["folders"]) == before:
        return False
    released = list(layout["folderOrder"].pop(fid, []))
    tok = _folder_token(fid)
    layout["rootOrder"] = [t for t in layout["rootOrder"] if t != tok]
    for iid in released:
        if iid not in layout["rootOrder"]:
            layout["rootOrder"].append(iid)
    _write_ui_layout(layout)
    return True


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
    layout = _sync_ui_layout_with_keypoints(entries)
    if rid not in layout["rootOrder"]:
        layout["rootOrder"].insert(0, rid)
    _write_ui_layout(layout)
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
        _remove_keypoint_from_ui(keypoint_id)
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
    set_keypoints_root_order([str(x) for x in order_ids])


# --- keypoint videos ----------------------------------------------------------


def add_keypoint_video(
    video_abs: str,
    ref_frame_paths: list[str],
    kp_frame_paths: list[str],
    *,
    fps: int = 24,
) -> dict[str, Any]:
    """Store a video reference with per-frame ref/kp pairs and frameSequence strip."""
    if len(ref_frame_paths) != len(kp_frame_paths):
        raise ValueError("ref and kp frame counts must match.")
    if not ref_frame_paths:
        raise ValueError("At least one frame is required.")
    _ensure_dirs()
    keypoints_video_dir().mkdir(parents=True, exist_ok=True)
    rid = f"kv_{_new_id()}"
    base = keypoints_video_dir() / rid
    ref_dir = base / "ref"
    kp_dir = base / "kp"
    ref_dir.mkdir(parents=True, exist_ok=True)
    kp_dir.mkdir(parents=True, exist_ok=True)

    src = Path(video_abs)
    if not src.is_file():
        raise ValueError(f"Video not found: {src}")
    ext = src.suffix.lower()
    if ext not in _VIDEO_EXTS:
        ext = ".mp4"
    video_dest = base / f"source{ext}"
    shutil.copy2(src, video_dest)

    strip: list[dict[str, Any]] = []
    for i, (ref_p, kp_p) in enumerate(zip(ref_frame_paths, kp_frame_paths)):
        frame_name = f"frame_{i + 1:06d}.png"
        ref_dest = ref_dir / frame_name
        kp_dest = kp_dir / frame_name
        shutil.copy2(ref_p, ref_dest)
        shutil.copy2(kp_p, kp_dest)
        strip.append(
            {
                "kind": "image",
                "relPath": _abs_to_storage_rel(kp_dest),
                "referenceRelPath": _abs_to_storage_rel(ref_dest),
            }
        )

    entry: dict[str, Any] = {
        "id": rid,
        "videoRelPath": _abs_to_storage_rel(video_dest),
        "fps": int(fps) if fps else 24,
        "frameSequence": {
            "sequenceGroupId": _new_id(),
            "strip": strip,
            "hidden": [],
        },
        "createdAt": time.time(),
    }
    entries = _read_manifest(_keypoints_video_manifest_path())
    entries.insert(0, entry)
    _write_manifest(_keypoints_video_manifest_path(), entries)

    kp_entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(kp_entries, video_entries=entries)
    tok = _video_token(rid)
    if tok not in layout["rootOrder"]:
        layout["rootOrder"].insert(0, tok)
    _write_ui_layout(layout)
    return entry


def list_keypoint_videos() -> list[dict[str, Any]]:
    entries = _read_manifest(_keypoints_video_manifest_path())
    out: list[dict[str, Any]] = []
    for e in entries:
        try:
            vid_ok = _resolve_rel(e.get("videoRelPath", "")).is_file()
            fs = e.get("frameSequence") or {}
            strip = fs.get("strip") if isinstance(fs, dict) else []
            frames_ok = bool(strip) and all(
                _resolve_rel(s.get("relPath", "")).is_file()
                for s in strip
                if isinstance(s, dict) and s.get("kind") == "image"
            )
        except Exception:
            continue
        if vid_ok and frames_ok:
            out.append(e)
    return out


def get_keypoint_video(video_id: str) -> dict[str, Any] | None:
    vid = str(video_id).strip()
    for e in list_keypoint_videos():
        if e.get("id") == vid:
            return e
    return None


def update_keypoint_video_strip(
    video_id: str,
    frame_sequence: dict[str, Any],
) -> dict[str, Any]:
    vid = str(video_id).strip()
    entries = _read_manifest(_keypoints_video_manifest_path())
    found: dict[str, Any] | None = None
    for e in entries:
        if e.get("id") == vid:
            fs = frame_sequence if isinstance(frame_sequence, dict) else {}
            strip = fs.get("strip") if isinstance(fs.get("strip"), list) else []
            e["frameSequence"] = {
                "sequenceGroupId": str(
                    fs.get("sequenceGroupId")
                    or (e.get("frameSequence") or {}).get("sequenceGroupId")
                    or _new_id()
                ),
                "strip": strip,
                "hidden": [],
            }
            found = e
            break
    if not found:
        raise ValueError("Video reference not found.")
    _write_manifest(_keypoints_video_manifest_path(), entries)
    return found


def delete_keypoint_video(video_id: str) -> bool:
    vid = str(video_id).strip()
    entries = _read_manifest(_keypoints_video_manifest_path())
    remaining: list[dict[str, Any]] = []
    found = False
    for e in entries:
        if e.get("id") == vid:
            found = True
            try:
                base = _resolve_rel(e.get("videoRelPath", "")).parent
                if base.is_dir():
                    shutil.rmtree(base, ignore_errors=True)
            except Exception:
                pass
        else:
            remaining.append(e)
    if found:
        _write_manifest(_keypoints_video_manifest_path(), remaining)
        kp_entries = list_keypoints()
        video_entries = list_keypoint_videos()
        layout = _sync_ui_layout_with_keypoints(
            kp_entries, video_entries=video_entries
        )
        layout["rootOrder"] = [
            t for t in layout["rootOrder"] if t != _video_token(vid)
        ]
        _write_ui_layout(layout)
    return found


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
