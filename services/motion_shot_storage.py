"""
Global motion-ref shot bookmarks under ``storage/motion_refs/``.

Layout::

    storage/motion_refs/
        shots.json          # ordered shot entries
        shots_ui.json       # folder layout for the shots gallery
        <motion_key>/shots/<shot_id>.png
"""

from __future__ import annotations

import base64
import json
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from services.character_storage import sanitize_for_folder
from services.motion_ref_storage import (
    MOTION_REFS_STORAGE_ROOT,
    list_motion_ref_keys,
    motion_ref_dir,
    motion_ref_shots_dir,
)

SHOTS_MANIFEST = "shots.json"
SHOTS_UI_MANIFEST = "shots_ui.json"
FOLDER_TOKEN_PREFIX = "folder:"


def _shots_manifest_path() -> Path:
    return MOTION_REFS_STORAGE_ROOT / SHOTS_MANIFEST


def _shots_ui_path() -> Path:
    return MOTION_REFS_STORAGE_ROOT / SHOTS_UI_MANIFEST


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _folder_token(folder_id: str) -> str:
    return f"{FOLDER_TOKEN_PREFIX}{folder_id}"


def _parse_folder_token(token: str) -> str | None:
    s = str(token).strip()
    if s.startswith(FOLDER_TOKEN_PREFIX):
        return s[len(FOLDER_TOKEN_PREFIX) :]
    return None


def _write_json_dict(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _read_manifest() -> list[dict[str, Any]]:
    path = _shots_manifest_path()
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_manifest(entries: list[dict[str, Any]]) -> None:
    path = _shots_manifest_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def _empty_ui_layout() -> dict[str, Any]:
    return {"rootOrder": [], "folders": [], "folderOrder": {}}


def _read_ui_layout() -> dict[str, Any]:
    path = _shots_ui_path()
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
        "folders": [dict(f) for f in folders if isinstance(f, dict) and f.get("id")],
        "folderOrder": {
            str(k): [str(x) for x in (v or [])]
            for k, v in folder_order.items()
            if isinstance(v, list)
        },
    }


def _write_ui_layout(layout: dict[str, Any]) -> None:
    _write_json_dict(_shots_ui_path(), layout)


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


def _shot_ids_in_folders(layout: dict[str, Any]) -> set[str]:
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


def _find_item_container(
    layout: dict[str, Any], item_id: str
) -> tuple[str | None, list[str]]:
    iid = str(item_id)
    for fid, order in layout.get("folderOrder", {}).items():
        if iid in order:
            return fid, order
    return None, layout.get("rootOrder", [])


def _folder_dict_for_api(folder: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(folder.get("id")),
        "name": str(folder.get("name") or folder.get("id")),
    }
    parent = _parent_id_for_folder(folder)
    if parent:
        out["parentId"] = parent
    linked = folder.get("linkedPoseFolderId")
    if linked:
        out["linkedPoseFolderId"] = str(linked)
    return out


def _abs_to_storage_rel(abs_path: Path) -> str:
    rel = abs_path.resolve().relative_to(MOTION_REFS_STORAGE_ROOT)
    return ("motion_refs/" + str(rel).replace("\\", "/")).rstrip("/")


def resolve_shot_rel(rel_path: str) -> Path:
    rel = Path(str(rel_path).replace("\\", "/").lstrip("/"))
    parts = rel.parts
    if parts and parts[0].lower() == "motion_refs":
        rel = Path(*parts[1:])
    target = (MOTION_REFS_STORAGE_ROOT / rel).resolve()
    if MOTION_REFS_STORAGE_ROOT != target and MOTION_REFS_STORAGE_ROOT not in target.parents:
        raise ValueError("Invalid shot path")
    return target


def list_shots() -> list[dict[str, Any]]:
    entries = _read_manifest()
    out: list[dict[str, Any]] = []
    for e in entries:
        try:
            if resolve_shot_rel(e.get("relPath", "")).is_file():
                out.append(e)
        except Exception:
            continue
    if len(out) != len(entries):
        _write_manifest(out)
    return out


def get_shot(shot_id: str) -> dict[str, Any] | None:
    sid = str(shot_id).strip()
    return next((e for e in list_shots() if str(e.get("id")) == sid), None)


def _sync_ui_layout_with_shots(entries: list[dict[str, Any]]) -> dict[str, Any]:
    layout = _read_ui_layout()
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    folder_by_id = {
        str(f.get("id")): dict(f)
        for f in layout.get("folders", [])
        if f.get("id")
    }
    folder_parents = _folder_parent_map(list(folder_by_id.values()))

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
            if fid in folder_by_id:
                root_order.append(_folder_token(fid))
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
            t for t in root_order if not _parse_folder_token(t)
        }:
            root_order.append(iid)

    folders = []
    for fid, f in folder_by_id.items():
        folder_copy = dict(f)
        folder_copy["id"] = fid
        folders.append(folder_copy)

    out = {"rootOrder": root_order, "folders": folders, "folderOrder": folder_order}
    _write_ui_layout(out)
    return out


def _shot_item_for_api(e: dict[str, Any]) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": str(e["id"]),
        "motionKey": str(e.get("motionKey") or ""),
        "frameIndex": int(e.get("frameIndex") or 0),
        "azimuth": float(e.get("azimuth") or 0),
        "elevation": float(e.get("elevation") or 0),
        "relPath": str(e.get("relPath") or ""),
        "createdAt": float(e.get("createdAt") or 0),
    }
    if e.get("keypointId"):
        item["keypointId"] = str(e["keypointId"])
    crop = e.get("cropBox")
    if isinstance(crop, dict):
        item["cropBox"] = crop
    if e.get("imageWidth") is not None:
        item["imageWidth"] = int(e["imageWidth"])
    if e.get("imageHeight") is not None:
        item["imageHeight"] = int(e["imageHeight"])
    return item


def get_shots_layout() -> dict[str, Any]:
    entries = list_shots()
    layout = _sync_ui_layout_with_shots(entries)
    return {
        "folders": [_folder_dict_for_api(f) for f in layout["folders"]],
        "rootOrder": layout["rootOrder"],
        "folderOrder": layout["folderOrder"],
        "items": [_shot_item_for_api(e) for e in entries],
    }


def save_shot(
    *,
    motion_key: str,
    png_base64: str,
    frame_index: int,
    azimuth: float,
    elevation: float,
    crop_box: dict[str, Any] | None = None,
    image_width: int | None = None,
    image_height: int | None = None,
) -> dict[str, Any]:
    key = sanitize_for_folder(motion_key)
    if key not in list_motion_ref_keys():
        raise ValueError("Motion not found.")
    raw = str(png_base64 or "")
    if "," in raw:
        raw = raw.split(",", 1)[1]
    if not raw:
        raise ValueError("pngBase64 is required.")
    try:
        data = base64.b64decode(raw)
    except Exception as e:
        raise ValueError(f"Invalid base64 PNG: {e}") from e

    sid = _new_id()
    shots_dir = motion_ref_shots_dir(key)
    shots_dir.mkdir(parents=True, exist_ok=True)
    out_path = shots_dir / f"{sid}.png"
    out_path.write_bytes(data)

    entry: dict[str, Any] = {
        "id": sid,
        "motionKey": key,
        "frameIndex": int(frame_index),
        "azimuth": float(azimuth),
        "elevation": float(elevation),
        "relPath": _abs_to_storage_rel(out_path),
        "createdAt": time.time(),
    }
    if isinstance(crop_box, dict) and crop_box.get("width") and crop_box.get("height"):
        entry["cropBox"] = {
            "x": int(crop_box["x"]),
            "y": int(crop_box["y"]),
            "width": int(crop_box["width"]),
            "height": int(crop_box["height"]),
        }
    if image_width is not None:
        entry["imageWidth"] = int(image_width)
    if image_height is not None:
        entry["imageHeight"] = int(image_height)

    entries = _read_manifest()
    entries.insert(0, entry)
    _write_manifest(entries)
    layout = _sync_ui_layout_with_shots(entries)
    if sid not in layout["rootOrder"]:
        layout["rootOrder"].insert(0, sid)
    _write_ui_layout(layout)
    return _shot_item_for_api(entry)


def delete_shot(shot_id: str) -> bool:
    sid = str(shot_id).strip()
    if not sid:
        return False
    entries = _read_manifest()
    kept: list[dict[str, Any]] = []
    removed = False
    for e in entries:
        if str(e.get("id")) == sid:
            removed = True
            try:
                p = resolve_shot_rel(e.get("relPath", ""))
                if p.is_file():
                    p.unlink()
            except Exception:
                pass
        else:
            kept.append(e)
    if not removed:
        return False
    _write_manifest(kept)
    layout = _sync_ui_layout_with_shots(kept)
    layout["rootOrder"] = [t for t in layout["rootOrder"] if t != sid]
    fo: dict[str, list[str]] = {}
    for fk, ids in layout["folderOrder"].items():
        fo[fk] = [i for i in ids if i != sid]
    layout["folderOrder"] = fo
    _write_ui_layout(layout)
    return True


def set_shots_root_order(order: list[str]) -> None:
    entries = list_shots()
    layout = _sync_ui_layout_with_shots(entries)
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    folder_ids = {str(f.get("id")) for f in layout["folders"] if f.get("id")}
    in_folder = _shot_ids_in_folders(layout)

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
        if s in valid_ids and s not in in_folder:
            next_root.append(s)
            seen.add(s)

    for tok in layout["rootOrder"]:
        if tok not in seen:
            fid = _parse_folder_token(tok)
            if fid is not None and _folder_token(fid) not in seen:
                next_root.append(_folder_token(fid))
                seen.add(tok)
            elif tok in valid_ids and tok not in in_folder and tok not in seen:
                next_root.append(tok)
                seen.add(tok)

    layout["rootOrder"] = next_root
    _write_ui_layout(layout)


def set_shot_folder_order(folder_id: str, order: list[str]) -> None:
    fid = str(folder_id).strip()
    if not fid:
        raise ValueError("folderId is required.")
    entries = list_shots()
    layout = _sync_ui_layout_with_shots(entries)
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
    in_folder = _shot_ids_in_folders(layout)
    layout["rootOrder"] = [
        t for t in layout["rootOrder"] if _parse_folder_token(t) or t not in in_folder
    ]
    _write_ui_layout(layout)


def create_shot_folder(
    name: str,
    item_ids: list[str],
    parent_folder_id: str | None = None,
) -> dict[str, Any]:
    label = (name or "").strip() or "Folder"
    entries = list_shots()
    layout = _sync_ui_layout_with_shots(entries)
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    ids = [str(x) for x in item_ids if str(x) in valid_ids]

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


def rename_shot_folder(folder_id: str, name: str) -> dict[str, Any]:
    fid = str(folder_id).strip()
    label = (name or "").strip() or "Folder"
    entries = list_shots()
    layout = _sync_ui_layout_with_shots(entries)
    for f in layout["folders"]:
        if str(f.get("id")) == fid:
            f["name"] = label
            _write_ui_layout(layout)
            return _folder_dict_for_api(f)
    raise ValueError("Folder not found.")


def assign_shots_to_folder(folder_id: str | None, item_ids: list[str]) -> None:
    entries = list_shots()
    layout = _sync_ui_layout_with_shots(entries)
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


def delete_shot_folder(folder_id: str) -> bool:
    fid = str(folder_id).strip()
    if not fid:
        return False
    entries = list_shots()
    layout = _sync_ui_layout_with_shots(entries)
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


def _folder_chain_for_shot(shot_id: str, layout: dict[str, Any]) -> list[dict[str, Any]]:
    """Return shots folders from root to leaf containing ``shot_id``."""
    container_fid, _ = _find_item_container(layout, shot_id)
    if not container_fid:
        return []
    folder_by_id = {str(f.get("id")): f for f in layout["folders"] if f.get("id")}
    chain: list[dict[str, Any]] = []
    fid: str | None = container_fid
    while fid and fid in folder_by_id:
        chain.append(folder_by_id[fid])
        fid = _parent_id_for_folder(folder_by_id[fid])
    chain.reverse()
    return chain


def _mirror_shot_folders_to_pose(shot_id: str) -> str | None:
    """Ensure pose-ref folders mirror the shot's folder chain; return leaf pose folder id."""
    from services import reference_storage

    entries = list_shots()
    layout = _sync_ui_layout_with_shots(entries)
    chain = _folder_chain_for_shot(shot_id, layout)
    if not chain:
        return None

    parent_pose_id: str | None = None
    leaf_pose_id: str | None = None

    for shots_folder in chain:
        sfid = str(shots_folder.get("id"))
        name = str(shots_folder.get("name") or "Folder")
        linked = shots_folder.get("linkedPoseFolderId")
        pose_id: str | None = None
        if linked:
            pose_id = reference_storage.ensure_keypoint_folder_exists(
                str(linked), name=name, parent_folder_id=parent_pose_id
            )
        if not pose_id:
            pose_id = reference_storage.find_keypoint_folder_by_name(
                name, parent_folder_id=parent_pose_id
            )
        if not pose_id:
            pose_id = reference_storage.ensure_keypoint_folder_empty(
                name, parent_folder_id=parent_pose_id
            )
        for f in layout["folders"]:
            if str(f.get("id")) == sfid:
                f["linkedPoseFolderId"] = pose_id
                break
        parent_pose_id = pose_id
        leaf_pose_id = pose_id

    _write_ui_layout(layout)
    return leaf_pose_id


def set_shot_keypoint_id(shot_id: str, keypoint_id: str) -> dict[str, Any]:
    sid = str(shot_id).strip()
    kid = str(keypoint_id).strip()
    entries = _read_manifest()
    for e in entries:
        if str(e.get("id")) == sid:
            e["keypointId"] = kid
            _write_manifest(entries)
            return _shot_item_for_api(e)
    raise ValueError("Shot not found.")


def add_shot_to_pose_ref(
    shot_id: str,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Run SDpose on a shot PNG and place the keypoint in a mirrored pose folder."""
    from services import logic, reference_storage

    shot = get_shot(shot_id)
    if not shot:
        raise ValueError("Shot not found.")
    if shot.get("keypointId"):
        kp = reference_storage.find_keypoint_by_id(str(shot["keypointId"]))
        if kp:
            return {
                "skipped": True,
                "item": {
                    "id": kp["id"],
                    "referenceRelPath": kp["referenceRelPath"],
                    "keypointRelPath": kp["keypointRelPath"],
                },
            }

    rel_path = str(shot.get("relPath") or "")
    placed_figure: dict[str, Any] | None = None
    crop = shot.get("cropBox")
    if isinstance(crop, dict) and crop.get("width") and crop.get("height"):
        from services.figure_crop import build_placed_figure_meta

        placement = {
            "x": int(crop["x"]),
            "y": int(crop["y"]),
            "width": int(crop["width"]),
            "height": int(crop["height"]),
        }
        iw = shot.get("imageWidth")
        ih = shot.get("imageHeight")
        if iw and ih:
            placed_figure = build_placed_figure_meta(int(iw), int(ih), placement)
        else:
            placed_figure = {"placement": placement}

    if log_cb:
        log_cb("Running SDpose keypoint detection…")
    entry = logic.make_reference_keypoint(
        rel_path, log_cb=log_cb, placed_figure=placed_figure
    )

    pose_folder_id = _mirror_shot_folders_to_pose(shot_id)
    if pose_folder_id:
        reference_storage.assign_keypoints_to_folder(pose_folder_id, [entry["id"]])
    else:
        reference_storage.assign_keypoints_to_folder(None, [entry["id"]])

    updated = set_shot_keypoint_id(shot_id, entry["id"])
    item: dict[str, Any] = {
        "id": entry["id"],
        "referenceRelPath": entry["referenceRelPath"],
        "keypointRelPath": entry["keypointRelPath"],
    }
    if isinstance(entry.get("placedFigure"), dict):
        item["placedFigure"] = entry["placedFigure"]
    return {"skipped": False, "item": item, "shot": updated}
