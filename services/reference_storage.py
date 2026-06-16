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
PLACED_DIRNAME = "placed"
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


def placed_dir() -> Path:
    return REFERENCES_STORAGE_ROOT / PLACED_DIRNAME


def _ensure_dirs() -> None:
    for d in (images_dir(), keypoints_dir(), keypoints_video_dir(), preview_dir(), placed_dir()):
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


def _parent_id_for_folder(folder: dict[str, Any]) -> str | None:
    pid = folder.get("parentId")
    if pid is None:
        return None
    s = str(pid).strip()
    return s if s else None


def _folder_parent_map(folders: list[dict[str, Any]]) -> dict[str, str | None]:
    return {
        str(f.get("id")): _parent_id_for_folder(f)
        for f in folders
        if f.get("id")
    }


def _is_root_folder(folder: dict[str, Any]) -> bool:
    return _parent_id_for_folder(folder) is None


def _keypoint_ids_in_folders(layout: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for order in (layout.get("folderOrder") or {}).values():
        for tok in order:
            if not _parse_folder_token(tok):
                ids.add(str(tok))
    return ids


def _remove_item_from_all_containers(layout: dict[str, Any], item_id: str) -> None:
    iid = str(item_id)
    layout["rootOrder"] = [t for t in layout["rootOrder"] if t != iid]
    for fk in list(layout["folderOrder"].keys()):
        layout["folderOrder"][fk] = [
            x for x in layout["folderOrder"].get(fk, []) if x != iid
        ]


def _insert_after_in_list(lst: list[str], after_id: str, new_token: str) -> list[str]:
    if after_id not in lst:
        if new_token not in lst:
            lst.append(new_token)
        return lst
    out = [t for t in lst if t != new_token]
    idx = out.index(after_id)
    return out[: idx + 1] + [new_token] + out[idx + 1 :]


def _find_item_container(
    layout: dict[str, Any], item_id: str
) -> tuple[str | None, list[str]]:
    iid = str(item_id)
    for fid, order in layout.get("folderOrder", {}).items():
        if iid in order:
            return fid, order
    return None, layout.get("rootOrder", [])


def _find_token_container(
    layout: dict[str, Any], token: str
) -> tuple[str | None, list[str]]:
    for fid, order in layout.get("folderOrder", {}).items():
        if token in order:
            return fid, order
    if token in layout.get("rootOrder", []):
        return None, layout["rootOrder"]
    return None, layout.get("rootOrder", [])


def _folder_dict_for_api(folder: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(folder.get("id")),
        "name": str(folder.get("name") or folder.get("id")),
    }
    parent = _parent_id_for_folder(folder)
    if parent:
        out["parentId"] = parent
    return out


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
        str(f.get("id")): dict(f)
        for f in layout.get("folders", [])
        if f.get("id")
    }
    folder_parents = _folder_parent_map(list(folder_by_id.values()))
    root_folder_ids = {fid for fid, f in folder_by_id.items() if _is_root_folder(f)}

    folder_order: dict[str, list[str]] = {}
    in_folder: set[str] = set()
    for fid, ids in (layout.get("folderOrder") or {}).items():
        if fid not in folder_by_id:
            continue
        cleaned: list[str] = []
        seen: set[str] = set()
        for tok in ids:
            s = str(tok).strip()
            if not s or s in seen:
                continue
            child_fid = _parse_folder_token(s)
            if child_fid is not None:
                if child_fid in folder_by_id and folder_parents.get(child_fid) == fid:
                    cleaned.append(_folder_token(child_fid))
                    seen.add(s)
                continue
            if s in valid_ids:
                cleaned.append(s)
                seen.add(s)
                in_folder.add(s)
        folder_order[fid] = cleaned

    root_order: list[str] = []
    seen_root: set[str] = set()
    for tok in layout.get("rootOrder") or []:
        s = str(tok).strip()
        if not s or s in seen_root:
            continue
        fid = _parse_folder_token(s)
        if fid is not None:
            if fid in folder_by_id and fid in root_folder_ids:
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

    for fid in root_folder_ids:
        tok = _folder_token(fid)
        if tok not in seen_root:
            root_order.append(tok)
            seen_root.add(tok)

    for fid, f in folder_by_id.items():
        parent = _parent_id_for_folder(f)
        if parent and parent in folder_by_id:
            tok = _folder_token(fid)
            parent_order = folder_order.setdefault(parent, [])
            if tok not in parent_order:
                parent_order.append(tok)

    root_order = [
        t
        for t in root_order
        if _parse_folder_token(t) is None
        or _parse_folder_token(t) in root_folder_ids
    ]
    seen_root = set(root_order)

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

    for fid in folder_by_id:
        folder_order.setdefault(fid, [])

    folders = [_folder_dict_for_api(f) for f in folder_by_id.values()]

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
    items = []
    for e in entries:
        item: dict[str, Any] = {
            "id": e["id"],
            "referenceRelPath": e["referenceRelPath"],
            "keypointRelPath": e["keypointRelPath"],
        }
        if isinstance(e.get("placedFigure"), dict):
            item["placedFigure"] = e["placedFigure"]
        items.append(item)
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
    root_folder_ids = {
        str(f.get("id"))
        for f in layout["folders"]
        if f.get("id") and _is_root_folder(f)
    }
    in_folder = _keypoint_ids_in_folders(layout)

    next_root: list[str] = []
    seen: set[str] = set()
    for tok in order or []:
        s = str(tok).strip()
        if not s or s in seen:
            continue
        fid = _parse_folder_token(s)
        if fid is not None:
            if fid in root_folder_ids:
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
            if fid is not None and fid in root_folder_ids and _folder_token(fid) not in seen:
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
    folder_by_id = {str(f.get("id")): f for f in layout["folders"] if f.get("id")}
    folder_parents = _folder_parent_map(layout["folders"])
    if fid not in folder_by_id:
        raise ValueError("Folder not found.")

    cleaned: list[str] = []
    seen: set[str] = set()
    for iid in order or []:
        s = str(iid).strip()
        if not s or s in seen:
            continue
        child_fid = _parse_folder_token(s)
        if child_fid is not None:
            if child_fid in folder_by_id and folder_parents.get(child_fid) == fid:
                cleaned.append(_folder_token(child_fid))
                seen.add(s)
            continue
        if s in valid_ids:
            cleaned.append(s)
            seen.add(s)
    for iid in layout["folderOrder"].get(fid, []):
        s = str(iid).strip()
        if not s or s in seen:
            continue
        child_fid = _parse_folder_token(s)
        if child_fid is not None:
            if child_fid in folder_by_id and folder_parents.get(child_fid) == fid:
                cleaned.append(_folder_token(child_fid))
                seen.add(s)
            continue
        if s in valid_ids:
            cleaned.append(s)
            seen.add(s)

    layout["folderOrder"][fid] = cleaned
    in_folder = _keypoint_ids_in_folders(layout)
    layout["rootOrder"] = [
        t for t in layout["rootOrder"] if _parse_folder_token(t) or t not in in_folder
    ]
    _write_ui_layout(layout)


def create_keypoint_folder(
    name: str,
    item_ids: list[str],
    parent_folder_id: str | None = None,
) -> dict[str, Any]:
    label = (name or "").strip() or "Folder"
    entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(entries)
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    ids = [str(x) for x in item_ids if str(x) in valid_ids]
    if not ids:
        raise ValueError("Select at least one keypoint to folder.")

    parent = str(parent_folder_id).strip() if parent_folder_id else None
    if parent and not any(str(f.get("id")) == parent for f in layout["folders"]):
        raise ValueError("Parent folder not found.")

    fid = _new_id()
    folder: dict[str, Any] = {"id": fid, "name": label}
    if parent:
        folder["parentId"] = parent
    layout["folders"].append(folder)
    for iid in ids:
        _remove_item_from_all_containers(layout, iid)
    layout["folderOrder"][fid] = ids
    tok = _folder_token(fid)
    if parent:
        parent_order = layout["folderOrder"].setdefault(parent, [])
        if tok not in parent_order:
            parent_order.append(tok)
    elif tok not in layout["rootOrder"]:
        layout["rootOrder"].append(tok)
    _write_ui_layout(layout)
    return _folder_dict_for_api(folder)


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
    folder_obj = next(
        (f for f in layout["folders"] if str(f.get("id")) == fid),
        None,
    )
    if not folder_obj:
        return False
    parent = _parent_id_for_folder(folder_obj)
    layout["folders"] = [f for f in layout["folders"] if str(f.get("id")) != fid]
    released = list(layout["folderOrder"].pop(fid, []))
    tok = _folder_token(fid)
    layout["rootOrder"] = [t for t in layout["rootOrder"] if t != tok]

    dest: list[str]
    if parent:
        dest = layout["folderOrder"].setdefault(parent, [])
    else:
        dest = layout["rootOrder"]

    for item in released:
        child_fid = _parse_folder_token(item)
        if child_fid:
            child = next(
                (f for f in layout["folders"] if str(f.get("id")) == child_fid),
                None,
            )
            if child:
                if parent:
                    child["parentId"] = parent
                else:
                    child.pop("parentId", None)
        if item not in dest:
            dest.append(item)
    _write_ui_layout(layout)
    return True


def rename_keypoint_folder(folder_id: str, name: str) -> dict[str, Any]:
    fid = str(folder_id).strip()
    label = (name or "").strip() or "Folder"
    entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(entries)
    for f in layout["folders"]:
        if str(f.get("id")) == fid:
            f["name"] = label
            _write_ui_layout(layout)
            return _folder_dict_for_api(f)
    raise ValueError("Folder not found.")


def find_keypoint_by_id(keypoint_id: str) -> dict[str, Any] | None:
    kid = str(keypoint_id).strip()
    return next((e for e in list_keypoints() if str(e.get("id")) == kid), None)


def find_keypoint_folder_by_name(
    name: str,
    *,
    parent_folder_id: str | None = None,
) -> str | None:
    label = (name or "").strip()
    if not label:
        return None
    entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(entries)
    parent = str(parent_folder_id).strip() if parent_folder_id else None
    for f in layout["folders"]:
        if str(f.get("name") or "") != label:
            continue
        if _parent_id_for_folder(f) == parent:
            return str(f.get("id"))
    return None


def ensure_keypoint_folder_exists(
    folder_id: str,
    *,
    name: str,
    parent_folder_id: str | None = None,
) -> str | None:
    """Return ``folder_id`` if it still exists with matching parent, else ``None``."""
    fid = str(folder_id).strip()
    if not fid:
        return None
    entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(entries)
    parent = str(parent_folder_id).strip() if parent_folder_id else None
    for f in layout["folders"]:
        if str(f.get("id")) == fid and _parent_id_for_folder(f) == parent:
            return fid
    return None


def ensure_keypoint_folder_empty(
    name: str,
    *,
    parent_folder_id: str | None = None,
) -> str:
    """Create an empty keypoint gallery folder and return its id."""
    label = (name or "").strip() or "Folder"
    entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(entries)
    parent = str(parent_folder_id).strip() if parent_folder_id else None
    if parent and not any(str(f.get("id")) == parent for f in layout["folders"]):
        raise ValueError("Parent folder not found.")

    existing = find_keypoint_folder_by_name(label, parent_folder_id=parent)
    if existing:
        return existing

    fid = _new_id()
    folder: dict[str, Any] = {"id": fid, "name": label}
    if parent:
        folder["parentId"] = parent
    layout["folders"].append(folder)
    layout["folderOrder"][fid] = []
    tok = _folder_token(fid)
    if parent:
        parent_order = layout["folderOrder"].setdefault(parent, [])
        if tok not in parent_order:
            parent_order.append(tok)
    elif tok not in layout["rootOrder"]:
        layout["rootOrder"].append(tok)
    _write_ui_layout(layout)
    return fid


def duplicate_keypoint(keypoint_id: str) -> dict[str, Any]:
    kid = str(keypoint_id).strip()
    entries = list_keypoints()
    src_entry = next((e for e in entries if str(e.get("id")) == kid), None)
    if not src_entry:
        raise ValueError("Keypoint not found.")
    _ensure_dirs()
    ref_abs = _resolve_rel(src_entry["referenceRelPath"])
    kp_abs = _resolve_rel(src_entry["keypointRelPath"])
    rid = _new_id()
    ref_dest = keypoints_dir() / f"ref_{rid}{ref_abs.suffix.lower() or '.png'}"
    kp_dest = keypoints_dir() / f"kp_{rid}{kp_abs.suffix.lower() or '.png'}"
    shutil.copy2(ref_abs, ref_dest)
    shutil.copy2(kp_abs, kp_dest)
    new_entry = {
        "id": rid,
        "referenceRelPath": _abs_to_storage_rel(ref_dest),
        "keypointRelPath": _abs_to_storage_rel(kp_dest),
        "createdAt": time.time(),
    }
    idx = next(i for i, e in enumerate(entries) if str(e.get("id")) == kid)
    entries.insert(idx + 1, new_entry)
    _write_manifest(_keypoints_manifest_path(), entries)

    layout = _sync_ui_layout_with_keypoints(entries)
    container_key, _ = _find_item_container(layout, kid)
    if container_key is None:
        layout["rootOrder"] = _insert_after_in_list(layout["rootOrder"], kid, rid)
    else:
        layout["folderOrder"][container_key] = _insert_after_in_list(
            layout["folderOrder"][container_key], kid, rid
        )
    _write_ui_layout(layout)
    return new_entry


def duplicate_keypoint_video(video_id: str) -> dict[str, Any]:
    vid = str(video_id).strip()
    entries = _read_manifest(_keypoints_video_manifest_path())
    src_entry = next((e for e in entries if str(e.get("id")) == vid), None)
    if not src_entry:
        raise ValueError("Video reference not found.")
    old_base = _resolve_rel(src_entry["videoRelPath"]).parent
    if not old_base.is_dir():
        raise ValueError("Video reference files not found.")
    rid = f"kv_{_new_id()}"
    new_base = keypoints_video_dir() / rid
    shutil.copytree(old_base, new_base)

    def _remap_path(rel: str) -> str:
        return str(rel).replace(vid, rid)

    fs = src_entry.get("frameSequence") or {}
    strip = fs.get("strip") if isinstance(fs.get("strip"), list) else []
    new_strip: list[dict[str, Any]] = []
    for slot in strip:
        if not isinstance(slot, dict):
            continue
        ns = dict(slot)
        if ns.get("relPath"):
            ns["relPath"] = _remap_path(str(ns["relPath"]))
        if ns.get("referenceRelPath"):
            ns["referenceRelPath"] = _remap_path(str(ns["referenceRelPath"]))
        new_strip.append(ns)

    new_entry: dict[str, Any] = {
        "id": rid,
        "videoRelPath": _remap_path(str(src_entry["videoRelPath"])),
        "fps": int(src_entry.get("fps") or 24),
        "frameSequence": {
            "sequenceGroupId": _new_id(),
            "strip": new_strip,
            "hidden": [],
        },
        "createdAt": time.time(),
    }
    idx = next(i for i, e in enumerate(entries) if str(e.get("id")) == vid)
    entries.insert(idx + 1, new_entry)
    _write_manifest(_keypoints_video_manifest_path(), entries)

    kp_entries = list_keypoints()
    layout = _sync_ui_layout_with_keypoints(kp_entries, video_entries=entries)
    src_tok = _video_token(vid)
    new_tok = _video_token(rid)
    container_key, _ = _find_token_container(layout, src_tok)
    if container_key is None:
        layout["rootOrder"] = _insert_after_in_list(layout["rootOrder"], src_tok, new_tok)
    else:
        layout["folderOrder"][container_key] = _insert_after_in_list(
            layout["folderOrder"][container_key], src_tok, new_tok
        )
    _write_ui_layout(layout)
    return new_entry


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


def add_keypoint_pair(
    source_abs: str,
    keypoint_abs: str,
    *,
    placed_figure: dict[str, Any] | None = None,
) -> dict[str, Any]:
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
    entry: dict[str, Any] = {
        "id": rid,
        "referenceRelPath": _abs_to_storage_rel(ref_dest),
        "keypointRelPath": _abs_to_storage_rel(kp_dest),
        "createdAt": time.time(),
    }
    if placed_figure:
        entry["placedFigure"] = placed_figure
    entries = _read_manifest(_keypoints_manifest_path())
    entries.insert(0, entry)
    _write_manifest(_keypoints_manifest_path(), entries)
    layout = _sync_ui_layout_with_keypoints(entries)
    if rid not in layout["rootOrder"]:
        layout["rootOrder"].insert(0, rid)
    _write_ui_layout(layout)
    return entry


def find_keypoint_by_keypoint_rel(keypoint_rel: str) -> dict[str, Any] | None:
    """Return manifest entry whose ``keypointRelPath`` matches (normalized)."""
    target = str(keypoint_rel).replace("\\", "/").lstrip("/")
    for e in _read_manifest(_keypoints_manifest_path()):
        rel = str(e.get("keypointRelPath") or "").replace("\\", "/").lstrip("/")
        if rel == target:
            return e
    return None


def find_keypoint_by_keypoint_abs(abs_path: str) -> dict[str, Any] | None:
    """Return manifest entry whose keypoint file matches ``abs_path``."""
    target = Path(abs_path).resolve()
    for e in _read_manifest(_keypoints_manifest_path()):
        try:
            if _resolve_rel(e.get("keypointRelPath", "")).resolve() == target:
                return e
        except Exception:
            continue
    return None


def update_placed_figure_outputs(
    keypoint_id: str,
    *,
    figure_crop_rgba_abs: str | None = None,
    figure_plate_abs: str | None = None,
    figure_square_crop_abs: str | None = None,
    square_ref_crop_abs: str | None = None,
    square_keypoint_crop_abs: str | None = None,
) -> dict[str, Any]:
    """Attach generated square crops + full plate paths to a keypoint entry."""
    _ensure_dirs()
    entries = _read_manifest(_keypoints_manifest_path())
    for e in entries:
        if e.get("id") != keypoint_id:
            continue
        pf = dict(e.get("placedFigure") or {})
        if figure_crop_rgba_abs:
            dest = placed_dir() / f"pf_{keypoint_id}_figure.png"
            shutil.copy2(figure_crop_rgba_abs, dest)
            pf["figureCropRgbaRelPath"] = _abs_to_storage_rel(dest)
        if figure_square_crop_abs:
            dest = placed_dir() / f"pf_{keypoint_id}_square.png"
            shutil.copy2(figure_square_crop_abs, dest)
            pf["figureSquareCropRelPath"] = _abs_to_storage_rel(dest)
        if figure_plate_abs:
            dest = placed_dir() / f"pf_{keypoint_id}_plate.png"
            shutil.copy2(figure_plate_abs, dest)
            pf["figurePlateRelPath"] = _abs_to_storage_rel(dest)
        if square_ref_crop_abs:
            dest = placed_dir() / f"pf_{keypoint_id}_ref_square.png"
            shutil.copy2(square_ref_crop_abs, dest)
            pf["squareRefCropRelPath"] = _abs_to_storage_rel(dest)
        if square_keypoint_crop_abs:
            dest = placed_dir() / f"pf_{keypoint_id}_kp_square.png"
            shutil.copy2(square_keypoint_crop_abs, dest)
            pf["squareKeypointCropRelPath"] = _abs_to_storage_rel(dest)
        e["placedFigure"] = pf
        _write_manifest(_keypoints_manifest_path(), entries)
        return e
    raise ValueError(f"Keypoint not found: {keypoint_id}")


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
            pf = e.get("placedFigure") if isinstance(e.get("placedFigure"), dict) else {}
            for key in (
                "figureCropRgbaRelPath",
                "figureSquareCropRelPath",
                "figurePlateRelPath",
                "squareRefCropRelPath",
                "squareKeypointCropRelPath",
            ):
                try:
                    _resolve_rel(pf.get(key, "")).unlink(missing_ok=True)
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
