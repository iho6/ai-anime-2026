"""
API router for the "Create Video Timeline" flow.

A timeline is a multi-track composite of clips: materialized character-sequence
videos, location/shot images, and music placeholders. Timelines live under
``storage/timelines/<timeline_key>/`` (see ``services.timeline_storage``).
"""

from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import (
    APIRouter,
    File,
    HTTPException,
    Query,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import Response

from services import logic, timeline_asset_storage, timeline_saved_shapes, timeline_storage
from services.constant import WAN_VIDEO_DEFAULT_LENGTH
from services.character_storage import sanitize_for_folder
from services.timeline_preview_cache import preview_decoder_cache
from services.timeline_preview_frame_cache import preview_frame_cache
from services.timeline_preview_frames import timeline_preview_rgba
from services.timeline_proxy import ensure_manifest_proxies
from .storage_paths import (
    TIMELINES_STORAGE_ROOT,
    resolve_storage_rel_file,
    storage_rel_from_abs,
)
from .ws_streaming import run_with_log_stream, safe_send_json

router = APIRouter(tags=["timeline"])

_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}
_AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus"}
_MAX_UPLOAD_FILES = 32
_MAX_UPLOAD_FILE_BYTES = 2 * 1024 * 1024 * 1024
_MAX_UPLOAD_TOTAL_BYTES = 4 * 1024 * 1024 * 1024


def _classify_uploaded_media(
    filename: str, content_type: str | None
) -> tuple[str, str]:
    ext = Path(filename).suffix.lower()
    if ext in _IMG_EXTS:
        return "image", ext
    if ext in _VIDEO_EXTS:
        return "video", ext
    if ext in _AUDIO_EXTS:
        return "audio", ext

    mime = (content_type or "").lower()
    if mime.startswith("image/"):
        return "image", {
            "image/jpeg": ".jpg",
            "image/webp": ".webp",
            "image/bmp": ".bmp",
        }.get(mime, ".png")
    if mime.startswith("video/"):
        return "video", {
            "video/webm": ".webm",
            "video/quicktime": ".mov",
        }.get(mime, ".mp4")
    if mime.startswith("audio/"):
        return "audio", {
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
            "audio/flac": ".flac",
            "audio/ogg": ".ogg",
            "audio/mp4": ".m4a",
            "audio/opus": ".opus",
        }.get(mime, ".mp3")
    raise ValueError(f"Unsupported media type for {filename!r}.")


def _timeline_video_clip_result(out_abs: str, **fields: Any) -> dict[str, Any]:
    """Build WS result for a bg-removed WebM, including alpha companion path when present."""
    out = Path(out_abs).resolve()
    result: dict[str, Any] = dict(fields)
    result["srcRelPath"] = storage_rel_from_abs(str(out))
    alpha = out.parent / (out.stem + ".alpha.mkv")
    if alpha.is_file():
        result["alphaRelPath"] = storage_rel_from_abs(str(alpha.resolve()))
    return result


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
    preview_decoder_cache.invalidate_timeline(timeline_key)
    preview_frame_cache.invalidate_timeline(timeline_key)
    return {"ok": True}


def _rewrite_duplicate_manifest(old_key: str, new_key: str) -> None:
    """After copytree, rewrite srcRelPath values so the copy references its own clips/."""
    manifest_path = _timeline_dir(new_key) / "manifest.json"
    if not manifest_path.is_file():
        return
    old_folder = sanitize_for_folder(old_key)
    new_folder = sanitize_for_folder(new_key)
    text = manifest_path.read_text(encoding="utf-8")
    text = text.replace(f"timelines/{old_folder}/", f"timelines/{new_folder}/")
    manifest_path.write_text(text, encoding="utf-8")


@router.post("/timeline/hub/{timeline_key}/duplicate")
def timeline_hub_duplicate(timeline_key: str) -> dict[str, str]:
    src = _timeline_dir(timeline_key)
    if not src.is_dir():
        raise HTTPException(404, "Timeline not found.")
    new_key = timeline_storage.unique_timeline_key(timeline_key + "_copy")
    dst = _timeline_dir(new_key)
    shutil.copytree(str(src), str(dst))
    _rewrite_duplicate_manifest(timeline_key, new_key)
    return {"newTimelineKey": new_key}


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


def _clip_media_signatures(manifest: dict[str, Any]) -> dict[str, tuple]:
    """Map clip id -> a signature of the fields that affect decoded media.

    Only ``srcRelPath`` / ``alphaRelPath`` / ``frameSequence`` require dropping a
    cached decoder. Transform, coloring, timing, etc. are applied after decode
    (or are path-keyed) and must NOT trigger invalidation, otherwise every
    autosave would race the in-flight preview decodes.
    """
    sigs: dict[str, tuple] = {}
    for track in manifest.get("tracks") or []:
        for clip in track.get("clips") or []:
            cid = str(clip.get("id") or "")
            if not cid:
                continue
            fs = clip.get("frameSequence")
            fs_sig: Any
            if isinstance(fs, dict):
                strip = fs.get("strip") or []
                fs_sig = tuple(
                    (str(s.get("relPath") or ""), bool(s.get("hidden")))
                    for s in strip
                    if isinstance(s, dict)
                )
            else:
                fs_sig = None
            sigs[cid] = (
                str(clip.get("srcRelPath") or ""),
                str(clip.get("alphaRelPath") or ""),
                fs_sig,
            )
    return sigs


def _find_timeline_clip(manifest: dict[str, Any], clip_id: str) -> dict[str, Any] | None:
    want = str(clip_id or "").strip()
    if not want:
        return None
    for track in manifest.get("tracks") or []:
        for clip in track.get("clips") or []:
            if str(clip.get("id") or "") == want:
                return clip
    return None


@router.get("/timeline/{timeline_key}/clip-rgba-frame")
def timeline_clip_rgba_frame(
    timeline_key: str,
    clipId: str = Query(...),
    sourceTimeSec: float = Query(0.0),
) -> Response:
    """RGBA PNG for a timeline clip frame (alpha companion composited + coloring applied)."""
    if not _timeline_dir(timeline_key).is_dir():
        raise HTTPException(404, "Timeline not found.")
    try:
        manifest = timeline_storage.read_manifest(timeline_key)
    except FileNotFoundError:
        raise HTTPException(404, "Timeline not found.") from None
    clip = _find_timeline_clip(manifest, clipId)
    if clip is None:
        raise HTTPException(404, "Clip not found.")
    clip_type = str(clip.get("type") or "")
    if clip_type not in ("image", "video"):
        raise HTTPException(400, "Clip type must be image or video.")
    rel = str(clip.get("srcRelPath") or "").strip()
    if not rel:
        raise HTTPException(400, "Clip has no srcRelPath.")
    abs_p = resolve_storage_rel_file(rel)
    in_point = float(clip.get("inPoint", 0))
    out_point = float(clip.get("outPoint", 0))
    st = max(float(sourceTimeSec), in_point)
    if out_point > 0:
        st = min(st, out_point)

    coloring = clip.get("coloring")
    cached = preview_frame_cache.get(timeline_key, clipId, st, coloring)
    if cached is not None:
        return Response(content=cached, media_type="image/png")

    from io import BytesIO

    rgba = timeline_preview_rgba(timeline_key, manifest, clip, abs_p, st)

    buf = BytesIO()
    rgba.save(buf, format="PNG")
    png = buf.getvalue()
    preview_frame_cache.put(timeline_key, clipId, st, coloring, png)
    return Response(content=png, media_type="image/png")


@router.put("/timeline/{timeline_key}/manifest")
def timeline_put_manifest(timeline_key: str, body: dict[str, Any]) -> dict[str, bool]:
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    if not isinstance(body, dict):
        raise HTTPException(400, "Manifest must be an object.")
    try:
        prev = timeline_storage.read_manifest(timeline_key)
    except FileNotFoundError:
        prev = None
    timeline_storage.write_manifest(timeline_key, body)
    # Only drop decoders for clips whose media source actually changed. Autosave
    # fires on every transform/coloring/timing edit, so a blanket invalidation
    # here races in-flight clip-rgba-frame decodes (Container is not open).
    if prev is None:
        preview_decoder_cache.invalidate_timeline(timeline_key)
        preview_frame_cache.invalidate_timeline(timeline_key)
    else:
        old_sigs = _clip_media_signatures(prev)
        new_sigs = _clip_media_signatures(body)
        for cid, new_sig in new_sigs.items():
            if old_sigs.get(cid) != new_sig:
                preview_decoder_cache.invalidate_clip(timeline_key, cid)
                preview_frame_cache.invalidate_clip(timeline_key, cid)
        for cid in old_sigs.keys() - new_sigs.keys():
            preview_decoder_cache.invalidate_clip(timeline_key, cid)
            preview_frame_cache.invalidate_clip(timeline_key, cid)
    return {"ok": True}


@router.post("/timeline/{timeline_key}/ensure-proxies")
def timeline_ensure_proxies(timeline_key: str) -> dict[str, Any]:
    """Generate missing ~480p preview proxies for video clips (idempotent).

    Safe to call on load: clips that already have a fresh proxy (or are small
    enough to preview from the master) are skipped. Returns the updated manifest
    when any proxy fields changed so the client can refresh without a reload.
    """
    if not _timeline_dir(timeline_key).is_dir():
        raise HTTPException(404, "Timeline not found.")
    try:
        manifest = timeline_storage.read_manifest(timeline_key)
    except FileNotFoundError:
        raise HTTPException(404, "Timeline not found.") from None
    updated = ensure_manifest_proxies(manifest)
    if updated:
        timeline_storage.write_manifest(timeline_key, manifest)
    return {"ok": True, "updated": updated, "manifest": manifest if updated else None}


@router.post("/timeline/{timeline_key}/import_files")
async def timeline_import_files(
    timeline_key: str,
    files: list[UploadFile] = File(...),
) -> dict[str, Any]:
    """Import an ordered batch of local image/video/audio files atomically."""
    if not _timeline_dir(timeline_key).is_dir():
        raise HTTPException(404, "Timeline not found.")
    if not files:
        raise HTTPException(400, "At least one file is required.")
    if len(files) > _MAX_UPLOAD_FILES:
        raise HTTPException(400, f"At most {_MAX_UPLOAD_FILES} files may be imported.")

    clips_dir = timeline_storage.timeline_clips_dir(timeline_key)
    imported_paths: list[Path] = []
    temp_paths: list[Path] = []
    items: list[dict[str, Any]] = []
    total_bytes = 0
    try:
        for upload in files:
            original_name = Path(upload.filename or "").name
            if not original_name or original_name in {".", ".."}:
                raise ValueError("Every upload must have a valid filename.")
            media_type, suffix = _classify_uploaded_media(
                original_name, upload.content_type
            )

            with tempfile.NamedTemporaryFile(
                prefix="timeline_upload_", suffix=suffix, delete=False
            ) as tmp:
                temp_path = Path(tmp.name)
                temp_paths.append(temp_path)
                file_bytes = 0
                while chunk := await upload.read(1024 * 1024):
                    file_bytes += len(chunk)
                    total_bytes += len(chunk)
                    if file_bytes > _MAX_UPLOAD_FILE_BYTES:
                        raise ValueError(f"{original_name!r} exceeds the 2 GiB limit.")
                    if total_bytes > _MAX_UPLOAD_TOTAL_BYTES:
                        raise ValueError("The upload batch exceeds the 4 GiB limit.")
                    tmp.write(chunk)
            await upload.close()
            if file_bytes <= 0:
                raise ValueError(f"{original_name!r} is empty.")

            if media_type == "image":
                info = logic.import_image_to_timeline_clip(temp_path, clips_dir)
            elif media_type == "video":
                info = logic.import_video_to_timeline_clip(temp_path, clips_dir)
            else:
                info = logic.import_audio_to_timeline_clip(temp_path, clips_dir)

            imported = Path(str(info["absPath"])).resolve()
            imported_paths.append(imported)
            item: dict[str, Any] = {
                "originalName": original_name,
                "type": media_type,
                "srcRelPath": storage_rel_from_abs(str(imported)),
            }
            if media_type in {"video", "audio"}:
                item["durationSec"] = float(info.get("durationSec") or 0)
            if media_type in {"image", "video"}:
                item["width"] = int(info.get("width") or 0)
                item["height"] = int(info.get("height") or 0)
            if media_type == "video":
                item["fps"] = float(info.get("fps") or 0)
            items.append(item)
    except Exception as exc:
        for path in imported_paths:
            path.unlink(missing_ok=True)
        raise HTTPException(400, f"Media import failed: {exc}") from exc
    finally:
        for upload in files:
            await upload.close()
        for path in temp_paths:
            path.unlink(missing_ok=True)

    return {"items": items}


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


@router.post("/timeline/{timeline_key}/duplicate_frame_asset")
def timeline_duplicate_frame_asset(timeline_key: str, body: dict[str, str]) -> dict[str, str]:
    """Copy a frame image into ``timelines/<key>/frames/<clip_id>/`` for strip paste."""
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    clip_id = (body.get("clipId") or "").strip()
    rel = (body.get("sourceRelPath") or "").strip()
    if not clip_id:
        raise HTTPException(400, "clipId is required.")
    if not rel:
        raise HTTPException(400, "sourceRelPath is required.")
    src_abs = str(resolve_storage_rel_file(rel))
    try:
        new_rel = logic.duplicate_timeline_frame_asset(timeline_key, clip_id, src_abs)
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"relPath": new_rel}


@router.post("/timeline/{timeline_key}/import_png_base64")
def timeline_import_png_base64(timeline_key: str, body: dict[str, str]) -> dict[str, Any]:
    """Save a client-rasterized PNG (e.g. geometry clip) into ``clips/``."""
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    png_b64 = (body.get("pngBase64") or "").strip()
    if not png_b64:
        raise HTTPException(400, "pngBase64 is required.")
    info = logic.save_png_base64_to_timeline_clip(
        png_b64, timeline_storage.timeline_clips_dir(timeline_key)
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


@router.get("/timeline/{timeline_key}/shapes")
def timeline_saved_shapes_list(timeline_key: str) -> dict[str, Any]:
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    return {"items": timeline_saved_shapes.list_shapes(timeline_key)}


@router.post("/timeline/{timeline_key}/shapes")
async def timeline_saved_shapes_save(timeline_key: str, body: dict[str, Any]) -> dict[str, Any]:
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    name = str(body.get("name") or "")
    geometry = body.get("geometry")
    if not isinstance(geometry, dict):
        raise HTTPException(400, "geometry is required.")
    try:
        item = timeline_saved_shapes.save_shape(timeline_key, name, geometry)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"item": item}


@router.delete("/timeline/{timeline_key}/shapes/{shape_id}")
def timeline_saved_shapes_delete(timeline_key: str, shape_id: str) -> dict[str, bool]:
    d = _timeline_dir(timeline_key)
    if not d.is_dir():
        raise HTTPException(404, "Timeline not found.")
    ok = timeline_saved_shapes.delete_shape(timeline_key, shape_id)
    if not ok:
        raise HTTPException(404, "Shape not found.")
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
            return _timeline_video_clip_result(
                str(out_abs),
                width=result.get("width") or meta.get("width") or 0,
                height=result.get("height") or meta.get("height") or 0,
                durationSec=duration,
                fps=fps,
            )

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
            return _timeline_video_clip_result(
                str(out_abs),
                width=result.get("width") or meta.get("width") or 0,
                height=result.get("height") or meta.get("height") or 0,
                durationSec=float(
                    result.get("durationSec") or meta.get("durationSec") or 0
                ),
                fps=float(result.get("fps") or meta.get("fps") or 0),
            )

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/remove_video_bg_anime_seg/ws")
async def timeline_remove_video_bg_anime_seg_ws(ws: WebSocket, timeline_key: str) -> None:
    """Remove background from a video clip via per-frame anime segmentation. Outputs WebM+alpha."""
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
        raw_anime = msg.get("animeSeg") or msg.get("anime_seg")
        anime_seg_options = raw_anime if isinstance(raw_anime, dict) else None

        def work(log_cb: Any) -> dict[str, Any]:
            clips_dir = timeline_storage.timeline_clips_dir(timeline_key)
            stem = Path(abs_src).stem
            out_path = str(Path(clips_dir) / f"{stem}_anime_seg_{int(time.time())}.webm")
            result = logic.remove_video_background_anime_seg(
                abs_src,
                out_path,
                output_fps_24=output_fps_24,
                recycle_mask=recycle_mask,
                anime_seg_options=anime_seg_options,
                log_cb=log_cb,
            )
            out_abs = result.get("absPath") or result.get("url") or out_path
            meta = logic.probe_video_meta(out_abs)
            return _timeline_video_clip_result(
                str(out_abs),
                width=result.get("width") or meta.get("width") or 0,
                height=result.get("height") or meta.get("height") or 0,
                durationSec=float(
                    result.get("durationSec") or meta.get("durationSec") or 0
                ),
                fps=float(result.get("fps") or meta.get("fps") or 0),
            )

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


@router.websocket("/timeline/{timeline_key}/extract_video_frame/ws")
async def timeline_extract_video_frame_ws(ws: WebSocket, timeline_key: str) -> None:
    """Extract one trimmed video frame into timeline clips storage."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        rel = (msg.get("videoRelPath") or "").strip()
        if not rel:
            raise ValueError("videoRelPath is required.")
        edge = (msg.get("edge") or "first").strip().lower()
        if edge not in ("first", "last", "start", "end"):
            raise ValueError("edge must be first or last.")
        in_point = float(msg.get("inPoint") or 0)
        out_point = float(msg.get("outPoint") or 0)

        def work(log_cb: Any) -> dict[str, Any]:
            info = logic.extract_video_trim_frame_to_timeline_clip(
                rel,
                in_point,
                out_point,
                timeline_storage.timeline_clips_dir(timeline_key),
                edge=edge,
                log_cb=log_cb,
            )
            return {
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
        length = int(msg.get("length") or WAN_VIDEO_DEFAULT_LENGTH)

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
        length = int(msg.get("length") or WAN_VIDEO_DEFAULT_LENGTH)
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
            if bool(msg.get("inPlace")):
                new_rel = logic.ai_edit_next_to_source(
                    rel,
                    prompt,
                    mask_png_base64=mask_b64,
                    log_cb=log_cb,
                )
                return {
                    "type": "image",
                    "srcRelPath": new_rel,
                    "width": 0,
                    "height": 0,
                }
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


@router.websocket("/timeline/{timeline_key}/video_frames/extract/ws")
async def timeline_video_frames_extract_ws(ws: WebSocket, timeline_key: str) -> None:
    """Extract a trimmed video clip into per-frame PNGs for frame-sequence editing."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        clip_id = (msg.get("clipId") or "").strip()
        video_rel = (msg.get("videoRelPath") or "").strip()
        alpha_rel = (msg.get("alphaRelPath") or "").strip() or None
        if not clip_id:
            raise ValueError("clipId is required.")
        if not video_rel:
            raise ValueError("videoRelPath is required.")
        in_point = float(msg.get("inPoint") or 0)
        out_point = float(msg.get("outPoint") or 0)
        if out_point <= in_point:
            raise ValueError("outPoint must be greater than inPoint.")

        def work(log_cb: Any) -> dict[str, Any]:
            return logic.timeline_video_to_frame_sequence(
                timeline_key,
                clip_id,
                video_rel,
                in_point_sec=in_point,
                out_point_sec=out_point,
                alpha_rel=alpha_rel,
                log_cb=log_cb,
            )

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/video_frames/encode/ws")
async def timeline_video_frames_encode_ws(ws: WebSocket, timeline_key: str) -> None:
    """Encode a frame-sequence strip to a new timeline clip (MP4 or WebM+alpha)."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        frame_sequence = msg.get("frameSequence")
        if not isinstance(frame_sequence, dict):
            raise ValueError("frameSequence is required.")
        fps = int(msg.get("fps") or 24)
        output_basename = (msg.get("outputBasename") or "").strip() or None

        def work(log_cb: Any) -> dict[str, Any]:
            if log_cb:
                log_cb("Encoding frame sequence…")
            info = logic.timeline_frame_sequence_to_video(
                timeline_key,
                frame_sequence,
                fps=fps,
                output_basename=output_basename,
            )
            return _timeline_video_clip_result(
                info["absPath"],
                type="video",
                durationSec=info.get("durationSec") or 0,
                width=info.get("width") or 0,
                height=info.get("height") or 0,
                fps=info.get("fps") or fps,
            )

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/strip_i2v/ws")
async def timeline_strip_i2v_ws(ws: WebSocket, timeline_key: str) -> None:
    """Mini I2V for a strip frame; writes PNGs into a timeline frames folder."""
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        if not _timeline_dir(timeline_key).is_dir():
            raise ValueError("Timeline not found.")
        image_rel = (msg.get("imageRelPath") or "").strip()
        output_dir_rel = (msg.get("outputDirRel") or "").strip()
        prompt = (msg.get("prompt") or "").strip()
        length = int(msg.get("length") or WAN_VIDEO_DEFAULT_LENGTH)
        if not image_rel:
            raise ValueError("imageRelPath is required.")
        if not output_dir_rel:
            raise ValueError("outputDirRel is required.")
        if not prompt:
            raise ValueError("prompt is required.")
        src_abs = str(timeline_storage.timeline_rel_to_abs(image_rel))
        out_abs = timeline_storage.timeline_rel_to_abs(output_dir_rel)

        def work(log_cb: Any) -> dict[str, Any]:
            rels = logic.generate_i2v_strip_segment(
                out_abs,
                src_abs,
                length=length,
                prompt=prompt,
                width=msg.get("width"),
                height=msg.get("height"),
                log_cb=log_cb,
            )
            return {"relPaths": rels}

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/timeline/{timeline_key}/strip_flf/ws")
async def timeline_strip_flf_ws(ws: WebSocket, timeline_key: str) -> None:
    """Mini FLF between two strip frames; writes PNGs into a timeline frames folder."""
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
        output_dir_rel = (msg.get("outputDirRel") or "").strip()
        length = int(msg.get("length") or WAN_VIDEO_DEFAULT_LENGTH)
        if not rel_a or not rel_b:
            raise ValueError("imageRelPathA and imageRelPathB are required.")
        if not output_dir_rel:
            raise ValueError("outputDirRel is required.")
        abs_a = str(timeline_storage.timeline_rel_to_abs(rel_a))
        abs_b = str(timeline_storage.timeline_rel_to_abs(rel_b))
        out_abs = timeline_storage.timeline_rel_to_abs(output_dir_rel)

        def work(log_cb: Any) -> dict[str, Any]:
            rels = logic.generate_flf_strip_segment(
                out_abs,
                abs_a,
                abs_b,
                length=length,
                log_cb=log_cb,
            )
            return {"relPaths": rels}

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
