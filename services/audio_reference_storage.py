"""
Global audio reference library under ``storage/references/audio/``.

Mirrors the keypoint gallery folder layout (``audio_ui.json``) for the timeline
Add Audio picker.
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from services.reference_storage import REFERENCES_STORAGE_ROOT, resolve_rel

AUDIO_DIRNAME = "audio"
AUDIO_MANIFEST = "audio.json"
AUDIO_UI_MANIFEST = "audio_ui.json"
FOLDER_TOKEN_PREFIX = "folder:"

_AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus"}


def audio_dir() -> Path:
    return REFERENCES_STORAGE_ROOT / AUDIO_DIRNAME


def _audio_manifest_path() -> Path:
    return REFERENCES_STORAGE_ROOT / AUDIO_MANIFEST


def _audio_ui_path() -> Path:
    return REFERENCES_STORAGE_ROOT / AUDIO_UI_MANIFEST


def _ensure_dirs() -> None:
    audio_dir().mkdir(parents=True, exist_ok=True)


def _abs_to_storage_rel(abs_path: Path) -> str:
    rel = abs_path.resolve().relative_to(REFERENCES_STORAGE_ROOT)
    return ("references/" + str(rel).replace("\\", "/")).rstrip("/")


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


def _write_json_dict(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _empty_ui_layout() -> dict[str, Any]:
    return {"rootOrder": [], "folders": [], "folderOrder": {}}


def _read_ui_layout() -> dict[str, Any]:
    path = _audio_ui_path()
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
    _write_json_dict(_audio_ui_path(), layout)


def _folder_token(folder_id: str) -> str:
    return f"{FOLDER_TOKEN_PREFIX}{folder_id}"


def _parse_folder_token(token: str) -> str | None:
    s = str(token).strip()
    if s.startswith(FOLDER_TOKEN_PREFIX):
        return s[len(FOLDER_TOKEN_PREFIX) :]
    return None


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def list_audio_items() -> list[dict[str, Any]]:
    entries = _read_manifest(_audio_manifest_path())
    out: list[dict[str, Any]] = []
    for e in entries:
        try:
            if resolve_rel(e.get("relPath", "")).is_file():
                out.append(e)
        except Exception:
            continue
    if len(out) != len(entries):
        _write_manifest(_audio_manifest_path(), out)
    return out


def _sync_ui_layout_with_items(entries: list[dict[str, Any]]) -> dict[str, Any]:
    layout = _read_ui_layout()
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    folder_by_id = {
        str(f.get("id")): f for f in layout.get("folders", []) if f.get("id")
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


def get_audio_layout() -> dict[str, Any]:
    entries = list_audio_items()
    layout = _sync_ui_layout_with_items(entries)
    items = [
        {
            "id": e["id"],
            "relPath": e["relPath"],
            **({"label": e["label"]} if e.get("label") else {}),
            **({"mode": e["mode"]} if e.get("mode") else {}),
            **({"tags": e["tags"]} if e.get("tags") else {}),
        }
        for e in entries
    ]
    return {
        "folders": layout["folders"],
        "rootOrder": layout["rootOrder"],
        "folderOrder": layout["folderOrder"],
        "items": items,
    }


def add_audio_item(
    source_abs: str,
    *,
    mode: str = "audio",
    tags: str = "",
    label: str = "",
) -> dict[str, Any]:
    _ensure_dirs()
    src = Path(source_abs)
    if not src.is_file():
        raise ValueError(f"Source audio not found: {source_abs}")
    aid = _new_id()
    ext = src.suffix.lower()
    if ext not in _AUDIO_EXTS:
        ext = ".mp3"
    dest = audio_dir() / f"aud_{aid}{ext}"
    shutil.copy2(src, dest)
    entry = {
        "id": aid,
        "relPath": _abs_to_storage_rel(dest),
        "mode": mode,
        "tags": (tags or "").strip(),
        "createdAt": time.time(),
    }
    if label.strip():
        entry["label"] = label.strip()
    entries = _read_manifest(_audio_manifest_path())
    entries.insert(0, entry)
    _write_manifest(_audio_manifest_path(), entries)
    layout = _sync_ui_layout_with_items(entries)
    if aid not in layout["rootOrder"]:
        layout["rootOrder"].insert(0, aid)
    _write_ui_layout(layout)
    return entry


def set_audio_root_order(order: list[str]) -> None:
    entries = list_audio_items()
    layout = _sync_ui_layout_with_items(entries)
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    folder_ids = {str(f.get("id")) for f in layout["folders"] if f.get("id")}
    in_folder = {i for ids in layout["folderOrder"].values() for i in ids}

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


def set_audio_folder_order(folder_id: str, order: list[str]) -> None:
    fid = str(folder_id).strip()
    if not fid:
        raise ValueError("folderId is required.")
    entries = list_audio_items()
    layout = _sync_ui_layout_with_items(entries)
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


def create_audio_folder(name: str, item_ids: list[str]) -> dict[str, Any]:
    label = (name or "").strip() or "Folder"
    entries = list_audio_items()
    layout = _sync_ui_layout_with_items(entries)
    valid_ids = {str(e.get("id")) for e in entries if e.get("id")}
    ids = [str(x) for x in item_ids if str(x) in valid_ids]
    if not ids:
        raise ValueError("Select at least one audio item to folder.")

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


def delete_audio_folder(folder_id: str) -> bool:
    fid = str(folder_id).strip()
    if not fid:
        return False
    entries = list_audio_items()
    layout = _sync_ui_layout_with_items(entries)
    if not any(str(f.get("id")) == fid for f in layout["folders"]):
        return False
    layout["folders"] = [f for f in layout["folders"] if str(f.get("id")) != fid]
    layout["folderOrder"].pop(fid, None)
    layout["rootOrder"] = [
        t for t in layout["rootOrder"] if _parse_folder_token(t) != fid
    ]
    _write_ui_layout(layout)
    return True


def delete_audio_item(audio_id: str) -> bool:
    aid = str(audio_id).strip()
    if not aid:
        return False
    entries = _read_manifest(_audio_manifest_path())
    kept: list[dict[str, Any]] = []
    removed = False
    for e in entries:
        if str(e.get("id")) == aid:
            removed = True
            try:
                p = resolve_rel(e.get("relPath", ""))
                if p.is_file():
                    p.unlink()
            except Exception:
                pass
        else:
            kept.append(e)
    if not removed:
        return False
    _write_manifest(_audio_manifest_path(), kept)
    layout = _sync_ui_layout_with_items(kept)
    layout["rootOrder"] = [t for t in layout["rootOrder"] if t != aid]
    fo: dict[str, list[str]] = {}
    for fk, ids in layout["folderOrder"].items():
        fo[fk] = [i for i in ids if i != aid]
    layout["folderOrder"] = fo
    _write_ui_layout(layout)
    return True
