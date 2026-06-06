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

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D  # noqa: F401

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from services import motion_ref_storage
from services.character_storage import sanitize_for_folder
from services.motion_ref_gen_ai_service.serverless import (
    call_generate,
    call_render_frame,
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
        headers={"Content-Encoding": "gzip", "Cache-Control": "no-cache"},
    )


# ── Render raw joints as skeleton PNG (GPU-free, matplotlib) ─────────────────

_BONES_SIMPLIFIED = [
    # Spine + neck + head
    (1,0),(2,1),(3,2),(4,3),(5,4),(6,5),(7,6),
    # Left arm (to wrist)
    (11,3),(12,11),(13,12),(14,13),
    # Right arm (to wrist)
    (39,3),(40,39),(41,40),(42,41),
    # Left leg
    (67,0),(68,67),(69,68),(70,69),(71,70),
    # Right leg
    (72,0),(73,72),(74,73),(75,74),(76,75),
]


@router.post("/motion_ref/render_joints")
def motion_ref_render_joints(body: dict[str, Any]) -> dict[str, str]:
    """Render a SOMA 77-joint pose as a skeleton PNG.  Pure matplotlib — no GPU."""
    raw = body.get("joints")
    if not raw or len(raw) < 7:
        raise HTTPException(400, "joints must be a list of at least 7 [x,y,z] positions.")
    joints = [[float(v) for v in j[:3]] for j in raw]

    azimuth   = float(body.get("azimuth")   or 0)
    elevation = float(body.get("elevation") or 20)
    width     = int(body.get("width")   or 512)
    height    = int(body.get("height")  or 512)

    dpi = 100
    fig = plt.figure(figsize=(width / dpi, height / dpi), dpi=dpi, facecolor="black")
    ax  = fig.add_subplot(111, projection="3d", facecolor="black")
    ax.set_facecolor("black")

    xs = [j[0] for j in joints]
    ys = [j[1] for j in joints]
    zs = [j[2] for j in joints]

    # Draw bones
    for (ci, pi) in _BONES_SIMPLIFIED:
        if ci >= len(joints) or pi >= len(joints):
            continue
        c, p = joints[ci], joints[pi]
        ax.plot([p[0], c[0]], [p[2], c[2]], [p[1], c[1]],
                color="#66aaff", linewidth=1.5, zorder=2)

    # Draw joints
    ax.scatter(xs, zs, ys, c="#ff4444", s=12, zorder=3, depthshade=False)

    ax.set_xlim(-1.2, 1.2)
    ax.set_ylim(-1.2, 1.2)
    ax.set_zlim(-1.2, 1.0)
    ax.axis("off")
    ax.grid(False)
    ax.xaxis.pane.fill = False
    ax.yaxis.pane.fill = False
    ax.zaxis.pane.fill = False

    # Match Three.js camera: elevation from horizontal, azimuth around Y
    ax.view_init(elev=elevation, azim=azimuth - 90)

    puppet_dir = MOTION_REFS_STORAGE_ROOT / "puppet_poses"
    puppet_dir.mkdir(parents=True, exist_ok=True)
    out_path = puppet_dir / f"pose_{int(time.time() * 1000)}.png"
    fig.savefig(str(out_path), dpi=dpi, bbox_inches="tight", facecolor="black", pad_inches=0)
    plt.close(fig)

    return {"shotRelPath": storage_rel_from_abs(str(out_path))}


# ── Render one frame as PNG ───────────────────────────────────────────────────

@router.post("/motion_ref/{motion_key}/render_frame")
def motion_ref_render_frame(
    motion_key: str,
    body: dict[str, Any],
) -> dict[str, str]:
    d = _motion_dir(motion_key)
    if not d.is_dir():
        raise HTTPException(404, "Motion not found.")

    frame_index = int(body.get("frameIndex") or 0)
    azimuth = float(body.get("azimuth") or 0)
    elevation = float(body.get("elevation") or 20)
    width = int(body.get("width") or 512)
    height = int(body.get("height") or 512)
    # Named shot — caller can pass a custom output filename stem
    shot_name = (body.get("shotName") or f"shot_{frame_index:05d}").strip()
    out_path = str(d / "shots" / f"{sanitize_for_folder(shot_name)}.png")

    try:
        abs_path = call_render_frame(
            str(d), frame_index, azimuth, elevation,
            port=_DEFAULT_PORT,
            width=width,
            height=height,
            output_path=out_path,
        )
    except Exception as e:
        raise HTTPException(500, str(e))

    return {"shotRelPath": storage_rel_from_abs(abs_path)}


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
                "segments": result["segments"],
                "model": model_name,
            })
            return {
                "motionKey": motion_key,
                "fps": result["fps"],
                "frameCount": result["frame_count"],
                "jointCount": result["joint_count"],
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
