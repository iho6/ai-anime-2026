"""
Per-timeline saved custom geometry shapes.

Layout::

    storage/timelines/<timeline_key>/
        saved_shapes_index.json
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from services.timeline_storage import timeline_dir

_INDEX_NAME = "saved_shapes_index.json"


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


def list_shapes(timeline_key: str) -> list[dict[str, Any]]:
    index = _read_index(timeline_key)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sid in index["order"]:
        it = index["items"].get(sid)
        if isinstance(it, dict):
            out.append(dict(it))
            seen.add(sid)
    for sid, it in index["items"].items():
        if sid not in seen and isinstance(it, dict):
            out.append(dict(it))
    return out


def save_shape(timeline_key: str, name: str, geometry: dict[str, Any]) -> dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise ValueError("Shape name is required.")
    if not isinstance(geometry, dict):
        raise ValueError("geometry must be an object.")

    shape_id = f"shape_{uuid.uuid4().hex}"
    item: dict[str, Any] = {
        "id": shape_id,
        "name": name,
        "createdAt": int(time.time()),
        "geometry": geometry,
    }

    index = _read_index(timeline_key)
    index["items"][shape_id] = item
    index["order"] = [shape_id] + [x for x in index["order"] if x != shape_id]
    _write_index(timeline_key, index)
    return item


def delete_shape(timeline_key: str, shape_id: str) -> bool:
    index = _read_index(timeline_key)
    if shape_id not in index["items"]:
        return False
    del index["items"][shape_id]
    index["order"] = [x for x in index["order"] if x != shape_id]
    _write_index(timeline_key, index)
    return True
