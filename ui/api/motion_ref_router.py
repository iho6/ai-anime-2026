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

from services import motion_ref_storage
from services.character_storage import sanitize_for_folder
from services.motion_ref_gen_ai_service.serverless import (
    call_generate,
    ensure_worker,
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
