"""
API router for the Motion Reference Generation system (KiMoD).

Motions live under ``storage/motion_refs/<motion_key>/`` (see
``services.motion_ref_storage``).  The generation job is streamed via
WebSocket to support live log output during long inference runs.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import time

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from services import motion_ref_storage, motion_shot_storage
from services.character_storage import sanitize_for_folder
from services.motion_ref_gen_ai_service.serverless import (
    call_generate,
    ensure_worker,
    reskin_motion,
)
from .storage_paths import (
    MOTION_REFS_STORAGE_ROOT,
    storage_rel_from_abs,
)
from .ws_streaming import run_with_log_stream, safe_send_json

router = APIRouter(tags=["motion_ref"])

_DEFAULT_PORT = 8766


def _motion_dir(motion_key: str) -> Path:
    return (MOTION_REFS_STORAGE_ROOT / sanitize_for_folder(motion_key)).resolve()


# ── Hub listing ───────────────────────────────────────────────────────────────

@router.get("/motion_ref/list")
def motion_ref_list() -> list[dict[str, Any]]:
    MOTION_REFS_STORAGE_ROOT.mkdir(parents=True, exist_ok=True)
    out = []
    for key in motion_ref_storage.list_motion_ref_keys():
        manifest = motion_ref_storage.read_manifest(key)
        shots_dir = _motion_dir(key) / "shots"
        thumbnail = None
        if shots_dir.is_dir():
            pngs = sorted(shots_dir.glob("*.png"))
            if pngs:
                thumbnail = storage_rel_from_abs(str(pngs[0]))
        out.append(
            {
                "motionKey": key,
                "fps": manifest.get("fps", 30),
                "frameCount": manifest.get("frame_count", 0),
                "jointCount": manifest.get("joint_count", 77),
                "hasMesh": bool(manifest.get("has_mesh", False)),
                "vertexCount": manifest.get("vertex_count", 0),
                "faceCount": manifest.get("face_count", 0),
                "bones": manifest.get("bones", []),
                "displayMode": manifest.get("display_mode", "mesh"),
                "thumbnailRelPath": thumbnail or "",
                "segments": manifest.get("segments", []),
            }
        )
    return out


@router.post("/motion_ref/{motion_key}/delete")
def motion_ref_delete(motion_key: str) -> dict[str, bool]:
    motion_ref_storage.delete_motion_ref(motion_key)
    return {"ok": True}


# ── Joints file (gzipped JSON for browser streaming) ─────────────────────────

@router.get("/motion_ref/{motion_key}/joints")
def motion_ref_joints(motion_key: str) -> FileResponse:
    gz = _motion_dir(motion_key) / "joints.json.gz"
    if not gz.is_file():
        raise HTTPException(404, "joints.json.gz not found — run generation first.")
    return FileResponse(
        str(gz),
        media_type="application/gzip",
        headers={"Cache-Control": "no-cache"},
    )


# ── SMPL-X mesh stream (gzipped float16 vertices + static faces) ─────────────

@router.get("/motion_ref/{motion_key}/mesh")
def motion_ref_mesh(motion_key: str) -> FileResponse:
    """Gzipped float16 little-endian [T, V, 3] vertex stream for the SMPL-X mesh."""
    gz = _motion_dir(motion_key) / "mesh.f16.gz"
    if not gz.is_file():
        raise HTTPException(404, "mesh.f16.gz not found — this motion has no skinned mesh.")
    return FileResponse(
        str(gz),
        media_type="application/gzip",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/motion_ref/{motion_key}/mesh_faces")
def motion_ref_mesh_faces(motion_key: str) -> FileResponse:
    """Gzipped JSON face index array [F][3] for the SMPL-X mesh (static across frames)."""
    gz = _motion_dir(motion_key) / "mesh_faces.json.gz"
    if not gz.is_file():
        raise HTTPException(404, "mesh_faces.json.gz not found — this motion has no skinned mesh.")
    return FileResponse(
        str(gz),
        media_type="application/gzip",
        headers={"Cache-Control": "no-cache"},
    )


# ── Save a client screenshot as the motion thumbnail ─────────────────────────

@router.post("/motion_ref/{motion_key}/save_shot_image")
def motion_ref_save_shot_image(
    motion_key: str,
    body: dict[str, Any],
) -> dict[str, str]:
    """
    Persist a client-side canvas screenshot (base64 PNG) into the motion's
    ``shots/`` dir.  Pure file IO — no KiMoD worker, no rendering.  Used so the
    Motion Gallery thumbnail populates after Save Shot.
    """
    import base64

    d = _motion_dir(motion_key)
    if not d.is_dir():
        raise HTTPException(404, "Motion not found.")

    raw = str(body.get("pngBase64") or "")
    if "," in raw:  # tolerate a data: URL prefix
        raw = raw.split(",", 1)[1]
    if not raw:
        raise HTTPException(400, "pngBase64 is required.")
    try:
        data = base64.b64decode(raw)
    except Exception as e:
        raise HTTPException(400, f"Invalid base64 PNG: {e}")

    shot_name = (body.get("shotName") or f"shot_{int(time.time() * 1000)}").strip()
    shots_dir = d / "shots"
    shots_dir.mkdir(parents=True, exist_ok=True)
    out_path = shots_dir / f"{sanitize_for_folder(shot_name)}.png"
    out_path.write_bytes(data)

    return {"shotRelPath": storage_rel_from_abs(str(out_path))}


# ── Camera trajectory (orbit keyframes per motion) ───────────────────────────


class CameraKeyframeBody(BaseModel):
    id: str | None = None
    frameIndex: int
    azimuth: float
    elevation: float
    distance: float
    slideX: float | None = None
    slideY: float | None = None
    cameraPosition: list[float] | None = None
    lookAtTarget: list[float] | None = None
    holdFrames: int | None = None
    blendEase: int | None = None


class CameraKeyframePatchBody(BaseModel):
    holdFrames: int | None = None
    blendEase: int | None = None


def _serialize_camera_trajectory(data: dict) -> dict[str, Any]:
    keyframes = data.get("keyframes") or []
    out = []
    for kf in keyframes:
        out.append(
            {
                "id": str(kf.get("id", "")),
                "frameIndex": int(kf.get("frameIndex", 0)),
                "azimuth": float(kf.get("azimuth", 0)),
                "elevation": float(kf.get("elevation", 0)),
                "distance": float(kf.get("distance", 2.6)),
                "slideX": float(kf.get("slideX", 0)),
                "slideY": float(kf.get("slideY", 0)),
                "cameraPosition": kf.get("cameraPosition"),
                "lookAtTarget": kf.get("lookAtTarget"),
                "holdFrames": int(kf.get("holdFrames", 0)),
                "blendEase": int(kf.get("blendEase", 100)),
            }
        )
    result: dict[str, Any] = {"keyframes": out}
    pr = data.get("playbackRange")
    if isinstance(pr, dict):
        result["playbackRange"] = {
            "startFrame": int(pr.get("startFrame", 0)),
            "endFrame": int(pr.get("endFrame", 0)),
        }
    return result


class PlaybackRangeBody(BaseModel):
    startFrame: int
    endFrame: int


class V2PoseSeqBody(BaseModel):
    folderName: str
    frames: list[dict[str, Any]]


class V2PoseSeqStartBody(BaseModel):
    folderName: str


class V2PoseSeqFrameBody(BaseModel):
    frameIndex: int
    pngBase64: str
    cropBox: dict[str, int] | None = None
    imageWidth: int | None = None
    imageHeight: int | None = None
    azimuth: float | None = None
    elevation: float | None = None


@router.post("/motion_ref/{motion_key}/v2pose_seq/start")
def motion_ref_v2pose_seq_start(
    motion_key: str, body: V2PoseSeqStartBody
) -> dict[str, Any]:
    if not _motion_dir(motion_key).is_dir():
        raise HTTPException(404, "Motion not found.")
    from services.motion_ref_pose_batch import create_v2pose_folder

    try:
        return create_v2pose_folder(body.folderName, motion_key=motion_key)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/motion_ref/{motion_key}/v2pose_seq/{folder_id}/frame")
def motion_ref_v2pose_seq_frame(
    motion_key: str, folder_id: str, body: V2PoseSeqFrameBody
) -> dict[str, Any]:
    if not _motion_dir(motion_key).is_dir():
        raise HTTPException(404, "Motion not found.")
    from services.motion_ref_pose_batch import process_v2pose_frame

    try:
        item = process_v2pose_frame(
            folder_id,
            body.model_dump(),
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return {"item": item}


@router.get("/motion_ref/{motion_key}/camera_trajectory")
def motion_ref_camera_trajectory_get(motion_key: str) -> dict[str, Any]:
    if not _motion_dir(motion_key).is_dir():
        raise HTTPException(404, "Motion not found.")
    return _serialize_camera_trajectory(motion_ref_storage.read_camera_trajectory(motion_key))


@router.post("/motion_ref/{motion_key}/camera_trajectory")
def motion_ref_camera_trajectory_upsert(
    motion_key: str, body: CameraKeyframeBody
) -> dict[str, Any]:
    try:
        data = motion_ref_storage.upsert_camera_keyframe(
            motion_key,
            body.model_dump(),
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return _serialize_camera_trajectory(data)


@router.delete("/motion_ref/{motion_key}/camera_trajectory/{keyframe_id}")
def motion_ref_camera_trajectory_delete(
    motion_key: str, keyframe_id: str
) -> dict[str, Any]:
    if not _motion_dir(motion_key).is_dir():
        raise HTTPException(404, "Motion not found.")
    ok = motion_ref_storage.delete_camera_keyframe(motion_key, keyframe_id)
    if not ok:
        raise HTTPException(404, "Camera keyframe not found.")
    return _serialize_camera_trajectory(motion_ref_storage.read_camera_trajectory(motion_key))


@router.patch("/motion_ref/{motion_key}/camera_trajectory/{keyframe_id}")
def motion_ref_camera_trajectory_patch(
    motion_key: str, keyframe_id: str, body: CameraKeyframePatchBody
) -> dict[str, Any]:
    if body.holdFrames is None and body.blendEase is None:
        raise HTTPException(400, "holdFrames or blendEase required")
    try:
        data = motion_ref_storage.patch_camera_keyframe(
            motion_key,
            keyframe_id,
            hold_frames=body.holdFrames,
            blend_ease=body.blendEase,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return _serialize_camera_trajectory(data)


@router.post("/motion_ref/{motion_key}/playback_range")
def motion_ref_playback_range_update(
    motion_key: str, body: PlaybackRangeBody
) -> dict[str, Any]:
    try:
        data = motion_ref_storage.update_playback_range(
            motion_key, body.startFrame, body.endFrame
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return _serialize_camera_trajectory(data)


# ── Global motion shots gallery ───────────────────────────────────────────────


class MotionShotSaveBody(BaseModel):
    motionKey: str
    pngBase64: str
    frameIndex: int
    azimuth: float
    elevation: float
    distance: float | None = None
    slideX: float | None = None
    slideY: float | None = None
    cropBox: dict[str, int] | None = None
    imageWidth: int | None = None
    imageHeight: int | None = None


class MotionShotFolderBody(BaseModel):
    name: str
    itemIds: list[str] = []
    parentFolderId: str | None = None


class MotionShotFolderRenameBody(BaseModel):
    name: str


class MotionShotFolderAssignBody(BaseModel):
    folderId: str | None = None
    itemIds: list[str]


@router.get("/motion_ref/shots/layout")
def motion_ref_shots_layout() -> dict[str, Any]:
    MOTION_REFS_STORAGE_ROOT.mkdir(parents=True, exist_ok=True)
    return motion_shot_storage.get_shots_layout()


@router.post("/motion_ref/shots")
def motion_ref_shots_save(body: MotionShotSaveBody) -> dict[str, Any]:
    try:
        item = motion_shot_storage.save_shot(
            motion_key=body.motionKey,
            png_base64=body.pngBase64,
            frame_index=body.frameIndex,
            azimuth=body.azimuth,
            elevation=body.elevation,
            distance=body.distance,
            slide_x=body.slideX,
            slide_y=body.slideY,
            crop_box=body.cropBox,
            image_width=body.imageWidth,
            image_height=body.imageHeight,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"item": item}


@router.delete("/motion_ref/shots/{shot_id}")
def motion_ref_shots_delete(shot_id: str) -> dict[str, bool]:
    ok = motion_shot_storage.delete_shot(shot_id)
    if not ok:
        raise HTTPException(404, "Shot not found.")
    return {"ok": True}


@router.post("/motion_ref/shots/reorder")
def motion_ref_shots_reorder(body: dict[str, Any]) -> dict[str, bool]:
    scope = str(body.get("scope") or "flat").strip()
    order = [str(x) for x in (body.get("order") or [])]
    try:
        if scope == "folder":
            folder_id = str(body.get("folderId") or "").strip()
            if not folder_id:
                raise HTTPException(400, "folderId is required for folder scope.")
            motion_shot_storage.set_shot_folder_order(folder_id, order)
        elif scope == "root":
            motion_shot_storage.set_shots_root_order(order)
        else:
            motion_shot_storage.set_shots_root_order(order)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@router.post("/motion_ref/shots/folders")
def motion_ref_shots_create_folder(body: MotionShotFolderBody) -> dict[str, Any]:
    try:
        folder = motion_shot_storage.create_shot_folder(
            body.name, body.itemIds, body.parentFolderId
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"folder": folder}


@router.patch("/motion_ref/shots/folders/{folder_id}")
def motion_ref_shots_rename_folder(
    folder_id: str, body: MotionShotFolderRenameBody
) -> dict[str, Any]:
    try:
        folder = motion_shot_storage.rename_shot_folder(folder_id, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"folder": folder}


@router.post("/motion_ref/shots/folders/assign")
def motion_ref_shots_assign_folder(body: MotionShotFolderAssignBody) -> dict[str, bool]:
    try:
        motion_shot_storage.assign_shots_to_folder(body.folderId, body.itemIds)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@router.delete("/motion_ref/shots/folders/{folder_id}")
def motion_ref_shots_delete_folder(folder_id: str) -> dict[str, bool]:
    ok = motion_shot_storage.delete_shot_folder(folder_id)
    if not ok:
        raise HTTPException(404, "Folder not found.")
    return {"ok": True}


@router.websocket("/motion_ref/shots/{shot_id}/add_to_pose/ws")
async def motion_ref_shot_add_to_pose_ws(ws: WebSocket, shot_id: str) -> None:
    await ws.accept()
    try:

        def work(log_cb: Any) -> dict[str, Any]:
            return motion_shot_storage.add_shot_to_pose_ref(shot_id, log_cb=log_cb)

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/motion_ref/{motion_key}/v2pose_seq/ws")
async def motion_ref_v2pose_seq_ws(ws: WebSocket, motion_key: str) -> None:
    """Batch SDPose from client-captured frames into a new pose keypoint folder."""
    await ws.accept()
    try:
        accumulated: list[dict[str, Any]] = []
        folder_name = ""
        while True:
            try:
                msg = await ws.receive_json()
            except WebSocketDisconnect:
                return
            t = msg.get("type")
            if t == "init":
                folder_name = str(msg.get("folderName") or msg.get("folder_name") or "").strip()
            elif t == "frames":
                batch = msg.get("frames")
                if isinstance(batch, list):
                    accumulated.extend(batch)
            elif t == "start":
                break
            else:
                # backward compat: legacy single-shot { folderName, frames }
                folder_name = str(
                    msg.get("folderName") or msg.get("folder_name") or folder_name
                ).strip()
                legacy = msg.get("frames")
                if isinstance(legacy, list):
                    accumulated.extend(legacy)
                break

        if not accumulated:
            await safe_send_json(
                ws, {"type": "done", "ok": False, "error": "frames array required"}
            )
            return
        if not folder_name:
            folder_name = f"v2pose_{motion_key}"

        from services.motion_ref_pose_batch import batch_v2pose_from_frames

        def work(log_cb: Any) -> dict[str, Any]:
            return batch_v2pose_from_frames(
                motion_key,
                folder_name,
                accumulated,
                log_cb=log_cb,
            )

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


# ── Reskin (WebSocket, streams logs) ─────────────────────────────────────────

@router.websocket("/motion_ref/{motion_key}/skin/ws")
async def motion_ref_skin_ws(ws: WebSocket, motion_key: str) -> None:
    """Re-run SMPL-X skinning on an existing skeleton-only motion.

    Streams ``{"type":"log","line":"..."}`` during skinning, then:
    ``{"type":"done","ok":true,"result":{"motionKey","hasMesh","vertexCount","faceCount"}}``
    """
    await ws.accept()
    try:
        def work(log_cb: Any) -> dict[str, Any]:
            return reskin_motion(motion_key, log_cb=log_cb)

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


# ── Generation (WebSocket, streams logs) ─────────────────────────────────────

@router.websocket("/motion_ref/generate/ws")
async def motion_ref_generate_ws(ws: WebSocket) -> None:
    """Generate a motion sequence from text-prompt segments.

    Input JSON:
        {
          "motionName": "optional name",
          "segments": [{"text": "...", "duration": 3.0}, ...],
          "numSamples": 1,
          "diffusionSteps": 100,
          "model": "kimodo-soma-rp"   // optional
        }

    Streams ``{"type":"log","line":"..."}`` during inference, then:
        {"type":"done","ok":true,"result":{"motionKey","fps","frameCount","jointCount","jointsRelPath","segments"}}
    """
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    try:
        segments = msg.get("segments") or []
        if not isinstance(segments, list) or not segments:
            raise ValueError("segments must be a non-empty list of {text, duration}.")
        for seg in segments:
            if not isinstance(seg, dict) or not seg.get("text"):
                raise ValueError("Each segment must have a non-empty 'text' field.")

        motion_name = (msg.get("motionName") or "motion").strip() or "motion"
        num_samples = int(msg.get("numSamples") or 1)
        diffusion_steps = int(msg.get("diffusionSteps") or 100)
        model_name_req = (msg.get("model") or "").strip() or None

        from services.motion_ref_gen_ai_service.serverless import _DEFAULT_MODEL
        model_name = model_name_req or _DEFAULT_MODEL

        motion_key = motion_ref_storage.unique_motion_ref_key(motion_name)
        dest_dir = str(motion_ref_storage.motion_ref_dir(motion_key))

        def work(log_cb: Any) -> dict[str, Any]:
            # Ensure worker running (first call may take a while to load model).
            ensure_worker(port=_DEFAULT_PORT, model_name=model_name, log_cb=log_cb)
            result = call_generate(
                segments,
                dest_dir,
                port=_DEFAULT_PORT,
                model_name=model_name,
                num_samples=num_samples,
                diffusion_steps=diffusion_steps,
                log_cb=log_cb,
            )
            # Persist manifest in storage layer too.
            motion_ref_storage.write_manifest(motion_key, {
                "fps": result["fps"],
                "frame_count": result["frame_count"],
                "joint_count": result["joint_count"],
                "has_mesh": result.get("has_mesh", False),
                "vertex_count": result.get("vertex_count", 0),
                "face_count": result.get("face_count", 0),
                "bones": result.get("bones", []),
                "display_mode": result.get("display_mode", "mesh"),
                "segments": result["segments"],
                "model": model_name,
            })
            return {
                "motionKey": motion_key,
                "fps": result["fps"],
                "frameCount": result["frame_count"],
                "jointCount": result["joint_count"],
                "hasMesh": result.get("has_mesh", False),
                "vertexCount": result.get("vertex_count", 0),
                "faceCount": result.get("face_count", 0),
                "bones": result.get("bones", []),
                "displayMode": result.get("display_mode", "mesh"),
                "jointsRelPath": storage_rel_from_abs(result["joints_gz_path"]),
                "segments": result["segments"],
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})
