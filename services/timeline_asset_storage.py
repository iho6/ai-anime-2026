"""
Per-timeline generated asset gallery (T2I and future kinds).

Layout::

    storage/timelines/<timeline_key>/
        assets/              # generated images not yet placed on a track
        assets_index.json    # flat gallery order + metadata
"""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from services.timeline_storage import timeline_assets_dir, timeline_dir

_INDEX_NAME = "assets_index.json"


def _index_path(timeline_key: str) -> Path:
    return timeline_dir(timeline_key) / _INDEX_NAME


def _empty_index() -> dict[str, Any]:
    return {"order": [], "items": {}}


def _read_index(timeline_key: str) -> dict[str, Any]:
    path = _index_path(timeline_key)
    if not path.is_file():
        return _empty_index()
    with path.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        return _empty_index()
    order = raw.get("order") if isinstance(raw.get("order"), list) else []
    items = raw.get("items") if isinstance(raw.get("items"), dict) else {}
    return {
        "order": [str(x) for x in order],
        "items": {str(k): v for k, v in items.items() if isinstance(v, dict)},
    }


def _write_index(timeline_key: str, index: dict[str, Any]) -> None:
    d = timeline_dir(timeline_key)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / (_INDEX_NAME + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    tmp.replace(_index_path(timeline_key))


def _storage_rel(timeline_key: str, filename: str) -> str:
    return f"timelines/{timeline_key}/assets/{filename}".replace("\\", "/")


def add_asset(
    timeline_key: str,
    local_abs_path: str,
    *,
    kind: str = "t2i",
    prompt: str = "",
    model_mode: str = "general",
    width: int = 0,
    height: int = 0,
) -> dict[str, Any]:
    """Copy image into timeline assets/ and register in the gallery index."""
    src = Path(local_abs_path)
    if not src.is_file():
        raise ValueError(f"Asset source not found: {local_abs_path}")

    assets_dir = timeline_assets_dir(timeline_key)
    assets_dir.mkdir(parents=True, exist_ok=True)

    ext = src.suffix.lower() or ".png"
    asset_id = f"asset_{uuid.uuid4().hex}"
    filename = f"{asset_id}{ext}"
    dest = assets_dir / filename
    shutil.copy2(src, dest)

    item: dict[str, Any] = {
        "id": asset_id,
        "relPath": _storage_rel(timeline_key, filename),
        "kind": kind,
        "prompt": prompt,
        "modelMode": model_mode,
        "width": int(width),
        "height": int(height),
        "createdAt": int(time.time()),
    }

    index = _read_index(timeline_key)
    index["items"][asset_id] = item
    index["order"] = [asset_id] + [x for x in index["order"] if x != asset_id]
    _write_index(timeline_key, index)
    return item


def delete_asset(timeline_key: str, asset_id: str) -> bool:
    index = _read_index(timeline_key)
    item = index["items"].pop(asset_id, None)
    if not item:
        return False
    index["order"] = [x for x in index["order"] if x != asset_id]
    _write_index(timeline_key, index)

    rel = str(item.get("relPath") or "")
    if rel:
        parts = rel.replace("\\", "/").split("/")
        if len(parts) >= 3 and parts[0] == "timelines":
            fname = parts[-1]
            fp = timeline_assets_dir(timeline_key) / fname
            if fp.is_file():
                fp.unlink()
    return True


def get_layout(timeline_key: str) -> dict[str, Any]:
    index = _read_index(timeline_key)
    items_out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for aid in index["order"]:
        it = index["items"].get(aid)
        if isinstance(it, dict):
            items_out.append(dict(it))
            seen.add(aid)
    for aid, it in index["items"].items():
        if aid not in seen and isinstance(it, dict):
            items_out.append(dict(it))
    return {"order": [x["id"] for x in items_out if x.get("id")], "items": items_out}
