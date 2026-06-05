"""
API router for the "Create Video Timeline" flow.

A timeline is a multi-track composite of clips: materialized character-sequence
videos, location/shot images, and music placeholders. Timelines live under
``storage/timelines/<timeline_key>/`` (see ``services.timeline_storage``).
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from services import logic, timeline_storage
from services.character_storage import sanitize_for_folder
from .storage_paths import (
    TIMELINES_STORAGE_ROOT,
    resolve_storage_rel_file,
    storage_rel_from_abs,
)
from .ws_streaming import run_with_log_stream, safe_send_json

router = APIRouter(tags=["timeline"])

_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def _timeline_dir(timeline_key: str) -> Path:
    return (TIMELINES_STORAGE_ROOT / sanitize_for_folder(timeline_key)).resolve()


def _cover_for_timeline(timeline_key: str) -> str | None:
    d = _timeline_dir(timeline_key)
    poster = d / "poster.png"
    if poster.is_file():
        return storage_rel_from_abs(str(poster))
    # Fall back to the first imported image clip, if any.
    clips = d / "clips"
    if clips.is_dir():
        for p in sorted(clips.iterdir()):
            if p.is_file() and p.suffix.lower() in _IMG_EXTS:
                return storage_rel_from_abs(str(p))
    return None


@router.get("/timeline/hub/items")
def timeline_hub_items() -> list[dict[str, str]]:
    TIMELINES_STORAGE_ROOT.mkdir(parents=True, exist_ok=True)
    out: list[dict[str, str]] = []
    for key in timeline_storage.list_timeline_keys():
        out.append(
            {"timelineKey": key, "coverRelPath": _cover_for_timeline(key) or ""}
        )
    return out


@router.post("/timeline/create")
def timeline_create(body: dict[str, str] | None = None) -> dict[str, str]:
    name = ((body or {}).get("name") or "Timeline").strip() or "Timeline"
    key = timeline_storage.create_timeline(name)
    return {"timelineKey": key}


@router.post("/timeline/hub/{timeline_key}/rename")
def timeline_hub_rename(timeline_key: str, body: dict[str, str]) -> dict[str, str]:
    nn = sanitize_for_folder((body.get("newName") or "").strip())
    if not nn:
        raise HTTPException(400, "Name cannot be empty.")
    old = _timeline_dir(timeline_key)
    if not old.is_dir():
        raise HTTPException(404, "Timeline not found.")
    new = _timeline_dir(nn)
    if new.exists():
        raise HTTPException(400, "Timeline already exists.")
    old.rename(new)
    return {"newTimelineKey": nn}


@router.post("/timeline/hub/{timeline_key}/delete")
def timeline_hub_delete(timeline_key: str) -> dict[str, bool]:
    d = _timeline_dir(timeline_key)
    if d.is_dir():
        shutil.rmtree(d)
    return {"ok": True}


@router.get("/timeline/{timeline_key}/manifest")
def timeline_get_manifest(timeline_key: str) -> dict[str, Any]:
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    try:
        return timeline_storage.read_manifest(timeline_key)
    except FileNotFoundError:
        # Backfill a default manifest for older/empty folders.
        manifest = timeline_storage.default_manifest()
        timeline_storage.write_manifest(timeline_key, manifest)
        return manifest


@router.put("/timeline/{timeline_key}/manifest")
def timeline_put_manifest(timeline_key: str, body: dict[str, Any]) -> dict[str, bool]:
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    if not isinstance(body, dict):
        raise HTTPException(400, "Manifest must be an object.")
    timeline_storage.write_manifest(timeline_key, body)
    return {"ok": True}


@router.post("/timeline/{timeline_key}/import_image")
def timeline_import_image(timeline_key: str, body: dict[str, str]) -> dict[str, Any]:
    """Copy a location/shot/character image into the timeline's ``clips/`` folder
    and return the new clip's storage-relative path + dimensions."""
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    rel = (body.get("sourceRelPath") or "").strip()
    if not rel:
        raise HTTPException(400, "sourceRelPath is required.")
    src_abs = str(resolve_storage_rel_file(rel))
    info = logic.import_image_to_timeline_clip(
        src_abs, timeline_storage.timeline_clips_dir(timeline_key)
    )
    return {
        "type": "image",
        "srcRelPath": storage_rel_from_abs(info["absPath"]),
        "width": info.get("width") or 0,
        "height": info.get("height") or 0,
    }


@router.websocket("/timeline/{timeline_key}/import_sequence/ws")
async def timeline_import_sequence_ws(ws: WebSocket, timeline_key: str) -> None:
    """Materialize a character sequence (or one gallery video item) to an mp4 in
    the timeline's ``clips/`` folder. Rendering is slow so logs stream live."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        char_key = (msg.get("charKey") or "").strip()
        sequence_name = (msg.get("sequenceName") or "").strip()
        if not char_key or not sequence_name:
            raise ValueError("charKey and sequenceName are required.")
        gallery_item_id = (msg.get("galleryItemId") or "").strip() or None

        def work(log_cb: Any) -> dict[str, Any]:
            info = logic.materialize_sequence_to_timeline_clip(
                char_key,
                sequence_name,
                gallery_item_id,
                timeline_storage.timeline_clips_dir(timeline_key),
                log_cb=log_cb,
            )
            return {
                "type": "video",
                "srcRelPath": storage_rel_from_abs(info["absPath"]),
                "durationSec": info.get("durationSec") or 0,
                "width": info.get("width") or 0,
                "height": info.get("height") or 0,
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/flf/ws")
async def timeline_flf_ws(ws: WebSocket, timeline_key: str) -> None:
    """FLF (first-last-frame) between two timeline image clips → new video clip."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        rel_a = (msg.get("imageRelPathA") or "").strip()
        rel_b = (msg.get("imageRelPathB") or "").strip()
        if not rel_a or not rel_b:
            raise ValueError("imageRelPathA and imageRelPathB are required.")
        abs_a = str(resolve_storage_rel_file(rel_a))
        abs_b = str(resolve_storage_rel_file(rel_b))
        length = int(msg.get("length") or 33)

        def work(log_cb: Any) -> dict[str, Any]:
            info = logic.generate_flf_to_timeline_clip(
                abs_a,
                abs_b,
                timeline_storage.timeline_clips_dir(timeline_key),
                length=length,
                log_cb=log_cb,
            )
            return {
                "type": "video",
                "srcRelPath": storage_rel_from_abs(info["absPath"]),
                "durationSec": info.get("durationSec") or 0,
                "width": info.get("width") or 0,
                "height": info.get("height") or 0,
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/i2v/ws")
async def timeline_i2v_ws(ws: WebSocket, timeline_key: str) -> None:
    """I2V (image-to-video) from one timeline image clip + prompt → new video clip."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        rel = (msg.get("imageRelPath") or "").strip()
        prompt = (msg.get("prompt") or "").strip()
        if not rel:
            raise ValueError("imageRelPath is required.")
        if not prompt:
            raise ValueError("prompt is required.")
        src_abs = str(resolve_storage_rel_file(rel))
        length = int(msg.get("length") or 129)
        width = msg.get("width")
        height = msg.get("height")

        def work(log_cb: Any) -> dict[str, Any]:
            info = logic.generate_i2v_to_timeline_clip(
                src_abs,
                prompt,
                timeline_storage.timeline_clips_dir(timeline_key),
                length=length,
                width=int(width) if width else None,
                height=int(height) if height else None,
                log_cb=log_cb,
            )
            return {
                "type": "video",
                "srcRelPath": storage_rel_from_abs(info["absPath"]),
                "durationSec": info.get("durationSec") or 0,
                "width": info.get("width") or 0,
                "height": info.get("height") or 0,
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/ai_edit/ws")
async def timeline_ai_edit_ws(ws: WebSocket, timeline_key: str) -> None:
    """AI-edit a timeline image clip (prompt + optional mask) → new image clip."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        rel = (msg.get("imageRelPath") or "").strip()
        prompt = (msg.get("prompt") or "").strip()
        if not rel:
            raise ValueError("imageRelPath is required.")
        if not prompt:
            raise ValueError("prompt is required.")
        src_abs = str(resolve_storage_rel_file(rel))
        mask_b64 = msg.get("maskPngBase64") or None

        def work(log_cb: Any) -> dict[str, Any]:
            info = logic.ai_edit_to_timeline_clip(
                src_abs,
                prompt,
                timeline_storage.timeline_clips_dir(timeline_key),
                mask_png_base64=mask_b64,
                log_cb=log_cb,
            )
            return {
                "type": "image",
                "srcRelPath": storage_rel_from_abs(info["absPath"]),
                "width": info.get("width") or 0,
                "height": info.get("height") or 0,
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})
