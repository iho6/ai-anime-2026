"""
API router for the "Create Shot" flow.

A shot composites a location backdrop with one or more character images and is
rendered into a finished frame by the Qwen image-edit service (two image
inputs: pristine backdrop + flattened composite). Shots live under
``storage/shots/<shot_key>/`` (see ``services.shot_storage``).
"""

from __future__ import annotations

import base64
import binascii
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from services import logic, shot_storage
from services.character_storage import sanitize_for_folder
from .storage_paths import (
    SHOTS_STORAGE_ROOT,
    resolve_storage_rel_file,
    storage_rel_from_abs,
)
from .ws_streaming import run_with_log_stream, safe_send_json

router = APIRouter(tags=["shot"])

_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def _shot_dir(shot_key: str) -> Path:
    return (SHOTS_STORAGE_ROOT / sanitize_for_folder(shot_key)).resolve()


def _generated_image_for_shot(shot_key: str) -> Path | None:
    d = _shot_dir(shot_key)
    if not d.is_dir():
        return None
    for n in ("generated.png", "generated.jpg", "generated.jpeg", "generated.webp"):
        p = d / n
        if p.is_file():
            return p
    for p in sorted(d.iterdir()):
        if p.is_file() and p.suffix.lower() in _IMG_EXTS:
            return p
    return None


@router.get("/shot/hub/items")
def shot_hub_items() -> list[dict[str, str]]:
    SHOTS_STORAGE_ROOT.mkdir(parents=True, exist_ok=True)
    out: list[dict[str, str]] = []
    for key in shot_storage.list_shot_keys():
        if key.startswith("_"):
            continue
        cover = _generated_image_for_shot(key)
        if not cover:
            continue
        out.append({"shotKey": key, "coverRelPath": storage_rel_from_abs(str(cover))})
    return out


@router.post("/shot/hub/{shot_key}/rename")
def shot_hub_rename(shot_key: str, body: dict[str, str]) -> dict[str, str]:
    nn = sanitize_for_folder((body.get("newName") or "").strip())
    if not nn:
        raise HTTPException(400, "Name cannot be empty.")
    old = _shot_dir(shot_key)
    if not old.is_dir():
        raise HTTPException(404, "Shot not found.")
    new = _shot_dir(nn)
    if new.exists():
        raise HTTPException(400, "Shot already exists.")
    old.rename(new)
    return {"newShotKey": nn}


@router.post("/shot/hub/{shot_key}/delete")
def shot_hub_delete(shot_key: str) -> dict[str, bool]:
    d = _shot_dir(shot_key)
    if d.is_dir():
        shutil.rmtree(d)
    return {"ok": True}


@router.post("/shot/hub/{shot_key}/set_generated")
def shot_hub_set_generated(shot_key: str, body: dict[str, str]) -> dict[str, str]:
    """Replace a shot's generated cover image with an already-staged image
    (e.g. the angled PNG produced by ``/shot/make_angle/ws``)."""
    rel = (body.get("relPath") or "").strip()
    if not rel:
        raise HTTPException(400, "relPath is required.")
    src = resolve_storage_rel_file(rel)
    d = _shot_dir(shot_key)
    if not d.is_dir():
        raise HTTPException(404, "Shot not found.")
    # Drop any existing generated.* so the new one becomes the unambiguous cover.
    for n in ("generated.png", "generated.jpg", "generated.jpeg", "generated.webp"):
        p = d / n
        if p.is_file():
            p.unlink()
    dest = d / "generated.png"
    shutil.copy2(src, dest)
    return {"coverRelPath": storage_rel_from_abs(str(dest))}


def _decode_composite_to_tmp(composite_b64: str, tmp_dir: Path) -> Path:
    raw = (composite_b64 or "").strip()
    if not raw:
        raise ValueError("compositePngBase64 is required.")
    # Tolerate a data URL prefix (``data:image/png;base64,...``).
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"Invalid composite base64: {e}") from e
    if not data:
        raise ValueError("Composite image decoded to empty bytes.")
    dest = tmp_dir / "composite.png"
    dest.write_bytes(data)
    return dest


@router.websocket("/shot/create/ws")
async def shot_create_ws(ws: WebSocket) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    try:
        # The shot name is optional in the UI; default to "shot" when blank
        # (``unique_shot_key`` then disambiguates with a numeric suffix).
        shot_name = (msg.get("shotName") or "").strip() or "shot"

        location_rel = (msg.get("locationImageRelPath") or "").strip()
        if not location_rel:
            raise ValueError("locationImageRelPath is required.")
        backdrop_src = resolve_storage_rel_file(location_rel)

        composite_b64 = msg.get("compositePngBase64") or ""
        characters = msg.get("characters") or []
        if not isinstance(characters, list):
            raise ValueError("characters must be a list.")
        location_key = (msg.get("locationKey") or "").strip() or None
        prompt_text = msg.get("promptText") or ""
        mode = (msg.get("mode") or "i2i").strip().lower()

        shot_key = shot_storage.unique_shot_key(shot_name)

        tmp_dir = Path(tempfile.mkdtemp(prefix="shot_create_"))
        try:
            backdrop_ext = backdrop_src.suffix.lower() or ".png"
            backdrop_tmp = tmp_dir / f"backdrop{backdrop_ext}"
            shutil.copy2(backdrop_src, backdrop_tmp)
            composite_tmp = _decode_composite_to_tmp(composite_b64, tmp_dir)

            def work(log_cb: Any) -> dict[str, str]:
                if mode == "as_is":
                    return logic.save_shot_as_is(
                        shot_name=shot_key,
                        backdrop_abs_path=str(backdrop_tmp),
                        composite_abs_path=str(composite_tmp),
                        location_key=location_key,
                        location_image_rel_path=location_rel,
                        characters=characters,
                        log_cb=log_cb,
                    )
                return logic.create_shot(
                    shot_name=shot_key,
                    backdrop_abs_path=str(backdrop_tmp),
                    composite_abs_path=str(composite_tmp),
                    location_key=location_key,
                    location_image_rel_path=location_rel,
                    characters=characters,
                    prompt_text=prompt_text,
                    log_cb=log_cb,
                )

            result, err = await run_with_log_stream(ws, work)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/shot/make_angle/ws")
async def shot_make_angle_ws(ws: WebSocket) -> None:
    """Generate a new camera angle for a single image (shot composer character /
    backdrop / generated scene, or a sequence frame) and return the angled PNG saved
    to the ``shots/_angle/`` scratch dir. Mirrors ``/shot/remove_bg/ws``."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    try:
        image_rel = (msg.get("imageRelPath") or "").strip()
        if not image_rel:
            raise ValueError("imageRelPath is required.")
        angle_id = int(msg.get("angleId"))
        src_abs = str(resolve_storage_rel_file(image_rel))

        def work(log_cb: Any) -> dict[str, str]:
            temp_path = logic.make_angle_to_temp_file(src_abs, angle_id, log_cb=log_cb)
            dest_dir = SHOTS_STORAGE_ROOT / "_angle"
            dest_dir.mkdir(parents=True, exist_ok=True)
            ext = Path(temp_path).suffix.lower() or ".png"
            dest = dest_dir / f"angle_{uuid.uuid4().hex}{ext}"
            shutil.copy2(temp_path, dest)
            return {"relPath": storage_rel_from_abs(str(dest))}

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/shot/remove_bg/ws")
async def shot_remove_bg_ws(ws: WebSocket) -> None:
    """Cut out a character layer's background (RMBG-2.0) and return a transparent
    PNG saved to the ``shots/_rembg/`` scratch dir (never listed as a shot)."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    try:
        image_rel = (msg.get("imageRelPath") or "").strip()
        if not image_rel:
            raise ValueError("imageRelPath is required.")
        src_abs = str(resolve_storage_rel_file(image_rel))

        def work(log_cb: Any) -> dict[str, str]:
            if bool(msg.get("inPlace")):
                rel = logic.remove_background_next_to_source(image_rel, log_cb=log_cb)
                return {"relPath": rel}
            temp_path = logic.remove_background_to_temp_file(src_abs, log_cb=log_cb)
            dest_dir = SHOTS_STORAGE_ROOT / "_rembg"
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / f"rembg_{uuid.uuid4().hex}.png"
            shutil.copy2(temp_path, dest)
            return {"relPath": storage_rel_from_abs(str(dest))}

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})
