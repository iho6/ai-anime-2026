"""
API router for the "Create Video Timeline" flow.

A timeline is a multi-track composite of clips: materialized character-sequence
videos, location/shot images, and music placeholders. Timelines live under
``storage/timelines/<timeline_key>/`` (see ``services.timeline_storage``).
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from services import logic, timeline_asset_storage, timeline_storage
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


@router.post("/timeline/{timeline_key}/import_audio")
def timeline_import_audio(timeline_key: str, body: dict[str, str]) -> dict[str, Any]:
    """Copy a gallery audio file into the timeline's ``clips/`` folder."""
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    rel = (body.get("sourceRelPath") or "").strip()
    if not rel:
        raise HTTPException(400, "sourceRelPath is required.")
    src_abs = str(resolve_storage_rel_file(rel))
    info = logic.import_audio_to_timeline_clip(
        src_abs, timeline_storage.timeline_clips_dir(timeline_key)
    )
    return {
        "type": "audio",
        "srcRelPath": storage_rel_from_abs(info["absPath"]),
        "durationSec": info.get("durationSec") or 0,
    }


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


@router.get("/timeline/{timeline_key}/assets")
def timeline_assets_layout(timeline_key: str) -> dict[str, Any]:
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    return timeline_asset_storage.get_layout(timeline_key)


@router.delete("/timeline/{timeline_key}/assets/{asset_id}")
def timeline_asset_delete(timeline_key: str, asset_id: str) -> dict[str, bool]:
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    ok = timeline_asset_storage.delete_asset(timeline_key, asset_id)
    if not ok:
        raise HTTPException(404, "Asset not found.")
    return {"ok": True}


@router.websocket("/timeline/{timeline_key}/t2i/ws")
async def timeline_t2i_ws(ws: WebSocket, timeline_key: str) -> None:
    """Text-to-image → timeline asset gallery entry."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        prompt = (msg.get("promptText") or "").strip()
        if not prompt:
            raise ValueError("promptText is required.")
        model_mode = (msg.get("modelMode") or "general").strip().lower()
        preview_aspect = (msg.get("previewAspect") or "16:9").strip()
        width = msg.get("width")
        height = msg.get("height")

        def work(log_cb: Any) -> dict[str, Any]:
            item = logic.generate_t2i_timeline_asset(
                timeline_key,
                prompt,
                model_mode,
                preview_aspect=preview_aspect,
                width=int(width) if width is not None else None,
                height=int(height) if height is not None else None,
                log_cb=log_cb,
            )
            return {"item": item}

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/remove_video_bg/ws")
async def timeline_remove_video_bg_ws(ws: WebSocket, timeline_key: str) -> None:
    """Remove background from a video clip via RobustVideoMatting.  Outputs WebM+alpha."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    try:
        d = _timeline_dir(timeline_key)
        if not d.is_dir():
            raise ValueError("Timeline not found.")
        rel = (msg.get("videoRelPath") or "").strip()
        if not rel:
            raise ValueError("videoRelPath is required.")
        from .storage_paths import resolve_storage_rel_file
        abs_src = str(resolve_storage_rel_file(rel))
        rvm_opts = logic._resolve_rvm_options(msg)

        def work(log_cb: Any) -> dict[str, Any]:
            from services.vid_bckgrnd_removal_ai_service.serverless import (
                remove_video_background_persistent,
            )
            clips_dir = timeline_storage.timeline_clips_dir(timeline_key)
            stem = Path(abs_src).stem
            out_path = str(Path(clips_dir) / f"{stem}_nobg_{int(time.time())}.webm")
            result = remove_video_background_persistent(
                abs_src,
                out_path,
                backbone=rvm_opts["backbone"],
                downsample_ratio=rvm_opts["downsample_ratio"],
                alpha_dilate_px=rvm_opts["alpha_dilate_px"],
                use_source_rgb=rvm_opts["use_source_rgb"],
                log_cb=log_cb,
            )
            out_abs = result.get("url") or out_path
            meta = logic.probe_video_meta(out_abs)
            fps = float(result.get("fps") or meta.get("fps") or 0)
            duration = float(meta.get("durationSec") or 0)
            if duration <= 0 and result.get("frames") and fps > 0:
                duration = float(result["frames"]) / fps
            return {
                "srcRelPath": storage_rel_from_abs(out_abs),
                "width": result.get("width") or meta.get("width") or 0,
                "height": result.get("height") or meta.get("height") or 0,
                "durationSec": duration,
                "fps": fps,
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/remove_video_bg_rmbg/ws")
async def timeline_remove_video_bg_rmbg_ws(ws: WebSocket, timeline_key: str) -> None:
    """Remove background from a video clip via per-frame RMBG-2.0.  Outputs WebM+alpha."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    try:
        d = _timeline_dir(timeline_key)
        if not d.is_dir():
            raise ValueError("Timeline not found.")
        rel = (msg.get("videoRelPath") or "").strip()
        if not rel:
            raise ValueError("videoRelPath is required.")
        from .storage_paths import resolve_storage_rel_file
        abs_src = str(resolve_storage_rel_file(rel))
        output_fps_24 = bool(msg.get("outputFps24") or msg.get("output_fps_24"))
        recycle_mask = bool(msg.get("recycleMask") or msg.get("recycle_mask"))
        if recycle_mask and not output_fps_24:
            recycle_mask = False
        raw_rmbg = msg.get("rmbg")
        rmbg_overrides = raw_rmbg if isinstance(raw_rmbg, dict) else None

        def work(log_cb: Any) -> dict[str, Any]:
            clips_dir = timeline_storage.timeline_clips_dir(timeline_key)
            stem = Path(abs_src).stem
            out_path = str(Path(clips_dir) / f"{stem}_rmbg_{int(time.time())}.webm")
            result = logic.remove_video_background_rmbg(
                abs_src,
                out_path,
                output_fps_24=output_fps_24,
                recycle_mask=recycle_mask,
                rmbg_overrides=rmbg_overrides,
                log_cb=log_cb,
            )
            out_abs = result.get("absPath") or result.get("url") or out_path
            meta = logic.probe_video_meta(out_abs)
            return {
                "srcRelPath": storage_rel_from_abs(out_abs),
                "width": result.get("width") or meta.get("width") or 0,
                "height": result.get("height") or meta.get("height") or 0,
                "durationSec": float(
                    result.get("durationSec") or meta.get("durationSec") or 0
                ),
                "fps": float(result.get("fps") or meta.get("fps") or 0),
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


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


def _parse_segment_coords_relaxed(msg: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    pos = msg.get("positiveCoords") or msg.get("positive_coords") or []
    neg = msg.get("negativeCoords") or msg.get("negative_coords") or []
    if not isinstance(pos, list):
        raise ValueError("positiveCoords must be a list when provided.")
    if not isinstance(neg, list):
        raise ValueError("negativeCoords must be a list when provided.")
    return pos, neg


def _parse_segment_prompt(msg: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None]:
    pos, neg = _parse_segment_coords_relaxed(msg)
    raw = msg.get("textPrompt") or msg.get("text_prompt") or ""
    text = str(raw).strip() if raw is not None else ""
    if not pos and not text:
        raise ValueError("Provide at least one positive point or a text prompt.")
    return pos, neg, text or None


def _segment_clip_fields(msg: dict[str, Any]) -> dict[str, Any]:
    rel = (msg.get("clipRelPath") or msg.get("clip_rel_path") or "").strip()
    clip_type = (msg.get("clipType") or msg.get("clip_type") or "image").strip().lower()
    if not rel:
        raise ValueError("clipRelPath is required.")
    if clip_type not in ("image", "video"):
        raise ValueError("clipType must be 'image' or 'video'.")
    return {
        "rel": rel,
        "clip_type": clip_type,
        "in_point_sec": float(msg.get("inPointSec") or msg.get("in_point_sec") or 0),
        "local_time_sec": float(msg.get("localTimeSec") or msg.get("local_time_sec") or 0),
        "speed": float(msg.get("speed") or 1.0),
    }


@router.websocket("/timeline/{timeline_key}/segment_preview/ws")
async def timeline_segment_preview_ws(ws: WebSocket, timeline_key: str) -> None:
    """SAM3 mask preview for a timeline clip frame (image or video at playhead)."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        fields = _segment_clip_fields(msg)
        pos, neg, text_prompt = _parse_segment_prompt(msg)
        src_abs = str(resolve_storage_rel_file(fields["rel"]))
        sam3_raw = msg.get("sam3Options") or msg.get("sam3_options")
        sam3_options = sam3_raw if isinstance(sam3_raw, dict) else None

        def work(log_cb: Any) -> dict[str, Any]:
            mask_b64 = logic.segment_preview_mask_png_base64(
                clip_type=fields["clip_type"],
                source_abs_path=src_abs,
                positive_coords=pos,
                negative_coords=neg,
                text_prompt=text_prompt,
                sam3_options=sam3_options,
                in_point_sec=fields["in_point_sec"],
                local_time_sec=fields["local_time_sec"],
                speed=fields["speed"],
                log_cb=log_cb,
            )
            return {"maskPngBase64": mask_b64}

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/segment/ws")
async def timeline_segment_ws(ws: WebSocket, timeline_key: str) -> None:
    """SAM3 segment → RGBA PNG (image) or WebM+alpha (video) in timeline clips/."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        fields = _segment_clip_fields(msg)
        pos, neg, text_prompt = _parse_segment_prompt(msg)
        src_abs = str(resolve_storage_rel_file(fields["rel"]))
        sam3_raw = msg.get("sam3Options") or msg.get("sam3_options")
        sam3_options = sam3_raw if isinstance(sam3_raw, dict) else None

        def work(log_cb: Any) -> dict[str, Any]:
            info = logic.segment_to_timeline_clip(
                clip_type=fields["clip_type"],
                source_abs_path=src_abs,
                dest_dir=timeline_storage.timeline_clips_dir(timeline_key),
                positive_coords=pos,
                negative_coords=neg,
                text_prompt=text_prompt,
                sam3_options=sam3_options,
                in_point_sec=fields["in_point_sec"],
                local_time_sec=fields["local_time_sec"],
                speed=fields["speed"],
                log_cb=log_cb,
            )
            out: dict[str, Any] = {
                "type": info.get("type") or fields["clip_type"],
                "srcRelPath": storage_rel_from_abs(info["absPath"]),
                "width": info.get("width") or 0,
                "height": info.get("height") or 0,
            }
            if out["type"] == "video":
                out["durationSec"] = float(info.get("durationSec") or 0)
            return out

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


@router.websocket("/timeline/{timeline_key}/export_mp4/ws")
async def timeline_export_mp4_ws(ws: WebSocket, timeline_key: str) -> None:
    """Composite timeline manifest to MP4 (multi-track video + mixed audio)."""
    await ws.accept()
    try:
        await ws.receive_json()  # consume handshake (no payload needed)
    except WebSocketDisconnect:
        return

    try:
        d = _timeline_dir(timeline_key)
        if not d.is_dir():
            raise ValueError("Timeline not found.")

        manifest = timeline_storage.read_manifest(timeline_key)

        def work(log_cb: Any) -> dict[str, Any]:
            from services.timeline_export import write_timeline_manifest_mp4

            out_dir = d / "exports"
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / f"export_{int(time.time())}.mp4"
            write_timeline_manifest_mp4(manifest, d, out_path, log_cb)
            return {"relPath": storage_rel_from_abs(str(out_path))}

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})
