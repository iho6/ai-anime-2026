"""
Motion reference generation service — KiMoD persistent worker.

Architecture: persistent HTTP worker (same pattern as vid_bckgrnd_removal_ai_service).
KiMoD and its LLM2Vec text encoder load once at startup; all subsequent
generation calls are fast.

Endpoints
─────────
GET  /health        → {"ok": true}
POST /generate      → generate 3D motion from text prompts; store NPZ + joints

Shots are captured client-side (WebGL screenshot of the live viewer), so this
worker no longer renders frames — it is used only for generation.

CLI
───
# Start persistent worker (called by _ensure_worker in this module):
python -m services.motion_ref_gen_ai_service.serverless --serve [--serve-port 8766]

# One-shot for testing:
python -m services.motion_ref_gen_ai_service.serverless \\
    --prompt "walking forward" --duration 3.0 --output /tmp/test_motion

Environment variables
─────────────────────
TEXT_ENCODER_DEVICE=cuda  (default when GPU available) — text encoder VRAM on GPU
TEXT_ENCODER_DEVICE=cpu   — lower VRAM (~3 GB motion-only) but slower encoding
TEXT_ENCODER_MODE=api     — set automatically on motion worker (do not use local Llama)
KIMODO_TEXT_ENCODER_PORT=9550
KIMODO_TEXT_ENCODER_READY_TIMEOUT=600  — first Llama load (seconds)
KIMODO_MOTION_WORKER_READY_TIMEOUT=300 — motion diffusion model load (seconds)
KIMODO_MODEL=kimodo-smplx-rp  (default model name — SMPL-X checkpoint for mesh skinning)
SMPLX_MODEL_DIR=storage/body_models  (parent of the smplx/ body-model folder)
MOTION_REF_SKIN_CHUNK_FRAMES=32  (frames per skinning batch; 0 = default 32)
MOTION_REF_SKIN_DEVICE=auto|cuda|cpu  (override skinning device)

Text encoder auto-starts on first motion-gen request (headless Gradio on port 9550).
Manual: python -m kimodo.scripts.run_text_encoder_server --headless
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d - %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("motion_ref_gen")

_SERVICE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SERVICE_DIR.parents[1]

# ── SOMA 77-joint bone pairs (child_index, parent_index) ─────────────────────
# Derived from SOMASkeleton77.bone_order_names_with_parents in kimodo/skeleton/definitions.py
# The list position IS the joint index; None parent → root (index 0 / Hips).

SOMA_JOINT_NAMES: list[str] = [
    "Hips",            # 0
    "Spine1",          # 1
    "Spine2",          # 2
    "Chest",           # 3
    "Neck1",           # 4
    "Neck2",           # 5
    "Head",            # 6
    "HeadEnd",         # 7
    "Jaw",             # 8
    "LeftEye",         # 9
    "RightEye",        # 10
    "LeftShoulder",    # 11
    "LeftArm",         # 12
    "LeftForeArm",     # 13
    "LeftHand",        # 14
    "LeftHandThumb1",  # 15
    "LeftHandThumb2",  # 16
    "LeftHandThumb3",  # 17
    "LeftHandThumbEnd",# 18
    "LeftHandIndex1",  # 19
    "LeftHandIndex2",  # 20
    "LeftHandIndex3",  # 21
    "LeftHandIndex4",  # 22
    "LeftHandIndexEnd",# 23
    "LeftHandMiddle1", # 24
    "LeftHandMiddle2", # 25
    "LeftHandMiddle3", # 26
    "LeftHandMiddle4", # 27
    "LeftHandMiddleEnd",# 28
    "LeftHandRing1",   # 29
    "LeftHandRing2",   # 30
    "LeftHandRing3",   # 31
    "LeftHandRing4",   # 32
    "LeftHandRingEnd", # 33
    "LeftHandPinky1",  # 34
    "LeftHandPinky2",  # 35
    "LeftHandPinky3",  # 36
    "LeftHandPinky4",  # 37
    "LeftHandPinkyEnd",# 38
    "RightShoulder",   # 39
    "RightArm",        # 40
    "RightForeArm",    # 41
    "RightHand",       # 42
    "RightHandThumb1", # 43
    "RightHandThumb2", # 44
    "RightHandThumb3", # 45
    "RightHandThumbEnd",# 46
    "RightHandIndex1", # 47
    "RightHandIndex2", # 48
    "RightHandIndex3", # 49
    "RightHandIndex4", # 50
    "RightHandIndexEnd",# 51
    "RightHandMiddle1",# 52
    "RightHandMiddle2",# 53
    "RightHandMiddle3",# 54
    "RightHandMiddle4",# 55
    "RightHandMiddleEnd",# 56
    "RightHandRing1",  # 57
    "RightHandRing2",  # 58
    "RightHandRing3",  # 59
    "RightHandRing4",  # 60
    "RightHandRingEnd",# 61
    "RightHandPinky1", # 62
    "RightHandPinky2", # 63
    "RightHandPinky3", # 64
    "RightHandPinky4", # 65
    "RightHandPinkyEnd",# 66
    "LeftLeg",         # 67
    "LeftShin",        # 68
    "LeftFoot",        # 69
    "LeftToeBase",     # 70
    "LeftToeEnd",      # 71
    "RightLeg",        # 72
    "RightShin",       # 73
    "RightFoot",       # 74
    "RightToeBase",    # 75
    "RightToeEnd",     # 76
]

# (child_index, parent_index) pairs — for drawing bones as line segments.
# parent_index==-1 means root (no line drawn from root upward).
SOMA_BONES: list[tuple[int, int]] = [
    (1, 0), (2, 1), (3, 2), (4, 3), (5, 4), (6, 5), (7, 6),  # spine + neck + head
    (8, 6), (9, 6), (10, 6),                                    # jaw, eyes
    (11, 3), (12, 11), (13, 12), (14, 13),                      # left arm
    (15, 14), (16, 15), (17, 16), (18, 17),                     # L thumb
    (19, 14), (20, 19), (21, 20), (22, 21), (23, 22),           # L index
    (24, 14), (25, 24), (26, 25), (27, 26), (28, 27),           # L middle
    (29, 14), (30, 29), (31, 30), (32, 31), (33, 32),           # L ring
    (34, 14), (35, 34), (36, 35), (37, 36), (38, 37),           # L pinky
    (39, 3), (40, 39), (41, 40), (42, 41),                      # right arm
    (43, 42), (44, 43), (45, 44), (46, 45),                     # R thumb
    (47, 42), (48, 47), (49, 48), (50, 49), (51, 50),           # R index
    (52, 42), (53, 52), (54, 53), (55, 54), (56, 55),           # R middle
    (57, 42), (58, 57), (59, 58), (60, 59), (61, 60),           # R ring
    (62, 42), (63, 62), (64, 63), (65, 64), (66, 65),           # R pinky
    (67, 0), (68, 67), (69, 68), (70, 69), (71, 70),            # left leg
    (72, 0), (73, 72), (74, 73), (75, 74), (76, 75),            # right leg
]

# ── Model cache ───────────────────────────────────────────────────────────────

_MODEL_CACHE: dict[str, Any] = {}
# SMPL-X checkpoint so we can skin a real body mesh for the viewer. Override via KIMODO_MODEL.
_DEFAULT_MODEL = os.environ.get("KIMODO_MODEL", "kimodo-smplx-rp")
_DEFAULT_SERVE_PORT = 8766
_DEFAULT_DIFFUSION_STEPS = 100
# Overlap frames blended between consecutive multi-prompt segments (Kimodo default is 5).
# Larger values give smoother transitions for dramatic pose changes at the cost of
# segment time spent transitioning. Override via KIMODO_NUM_TRANSITION_FRAMES.
_DEFAULT_NUM_TRANSITION_FRAMES = int(os.environ.get("KIMODO_NUM_TRANSITION_FRAMES", "5") or "5")
_MAX_SEGMENT_DURATION_SEC = 10.0
_MIN_SEGMENT_DURATION_SEC = 0.5
_DEFAULT_CFG_TEXT_WEIGHT = 2.0
_DEFAULT_CFG_CONSTRAINT_WEIGHT = 2.0
_MIN_CFG_TEXT_WEIGHT = 1.0
_MAX_CFG_TEXT_WEIGHT = 4.0


def _load_kimodo_model(model_name: str = _DEFAULT_MODEL) -> Any:
    """Load and cache the KiMoD model. Downloads weights on first call."""
    if model_name in _MODEL_CACHE:
        return _MODEL_CACHE[model_name]

    # Default text encoder device when API fallback is needed.
    if "TEXT_ENCODER_DEVICE" not in os.environ:
        import torch as _torch

        os.environ["TEXT_ENCODER_DEVICE"] = "cuda" if _torch.cuda.is_available() else "cpu"

    # The repo root is prepended to sys.path by our startup code, which causes
    # Python to find ./kimodo/ as a bare namespace package instead of the
    # editable install. Prepend the actual kimodo source dir so that
    # kimodo/kimodo/__init__.py is found first.
    _kimodo_src = str(_SERVICE_DIR.parents[1] / "kimodo")
    if _kimodo_src not in sys.path:
        sys.path.insert(0, _kimodo_src)

    # Prepend kimodo source dir so kimodo/kimodo/__init__.py wins over
    # the ./kimodo/ namespace package found via repo root in sys.path.
    import sys as _sys
    _kimodo_src = str(_SERVICE_DIR.parents[1] / 'kimodo')
    if _kimodo_src not in _sys.path:
        _sys.path.insert(0, _kimodo_src)

    _kimodo_src = str(_SERVICE_DIR.parents[1] / 'kimodo')
    if _kimodo_src not in sys.path:
        sys.path.insert(0, _kimodo_src)

    import torch
    from kimodo import load_model

    device = "cuda" if torch.cuda.is_available() else "cpu"
    logger.info(
        "Loading KiMoD model '%s' on %s (TEXT_ENCODER_DEVICE=%s)…",
        model_name, device, os.environ.get("TEXT_ENCODER_DEVICE", "auto"),
    )
    model = load_model(model_name, device=device)
    _MODEL_CACHE[model_name] = model
    logger.info("KiMoD model loaded.")
    _check_kimodo_multiprompt_api(model)
    return model


def _log_kimodo_commit() -> None:
    """Best-effort log of the installed Kimodo git SHA (read-only; never pulls)."""
    kimodo_dir = _SERVICE_DIR.parents[1] / "kimodo"
    if not (kimodo_dir / ".git").exists():
        return
    try:
        proc = subprocess.run(
            ["git", "-C", str(kimodo_dir), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        sha = (proc.stdout or "").strip()
        if proc.returncode == 0 and sha:
            logger.info("Kimodo source at commit %s", sha)
    except Exception:
        # Version logging is diagnostic only; never block model load on it.
        pass


def _check_kimodo_multiprompt_api(model: Any) -> None:
    """
    Verify the installed Kimodo exposes the sequential multi-prompt API.

    Read-only: logs the commit and fails fast with guidance if the API is too old.
    It never updates Kimodo — updating is opt-in via ``KIMODO_GIT_UPDATE=1`` on Launch.
    """
    import inspect

    _log_kimodo_commit()

    has_seq = hasattr(model, "_multiprompt")
    accepts_transition = False
    try:
        sig = inspect.signature(model.__call__)
        accepts_transition = "num_transition_frames" in sig.parameters
    except (TypeError, ValueError):
        # Some callables don't expose a signature; fall back to the _multiprompt check.
        accepts_transition = has_seq

    if not (has_seq and accepts_transition):
        raise RuntimeError(
            "Installed Kimodo does not expose the sequential multi-prompt API "
            "(missing Kimodo._multiprompt / num_transition_frames). Multi-segment "
            "motion needs Kimodo >= 2026-04-24. Update by re-running Launch with "
            "KIMODO_GIT_UPDATE=1 (this re-pulls and reinstalls Kimodo safely)."
        )


# ── Core generation ───────────────────────────────────────────────────────────


def generate_motion(
    segments: list[dict],            # [{"text": str, "duration": float}, …]
    dest_dir: Path | str,
    *,
    model_name: str = _DEFAULT_MODEL,
    num_samples: int = 1,
    diffusion_steps: int = _DEFAULT_DIFFUSION_STEPS,
    num_transition_frames: int = _DEFAULT_NUM_TRANSITION_FRAMES,
    cfg_text_weight: float = _DEFAULT_CFG_TEXT_WEIGHT,
    starting_pose: list[list[float]] | None = None,  # 77×3 joint positions
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """
    Generate a 3D motion sequence from text prompts using KiMoD.

    With more than one segment, Kimodo's sequential multi-prompt path
    (``multi_prompt=True``) is used: each segment is generated in order, the last
    ``num_transition_frames`` of the previous segment seed full-body + end-effector
    constraints at the start of the next, and the shared overlap is blended for a
    smooth transition (see Kimodo tech report Sec. 4.4).

    If ``starting_pose`` is supplied (77×3 joint positions from the puppet editor),
    a FullBodyConstraintSet is applied at frame 0 of the first segment to start
    generation from that pose.

    Returns a manifest dict:
        {motion_key, fps, frame_count, joint_count, joints_gz_path, npz_path, segments}
    """
    import numpy as np
    from services.motion_ref_gen_ai_service.smplx_skinning import bones_from_skeleton

    def _log(msg: str) -> None:
        logger.info(msg)
        if log_cb:
            log_cb(msg)

    if not segments:
        raise ValueError("At least one segment (text + duration) is required.")

    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "shots").mkdir(exist_ok=True)

    model = _load_kimodo_model(model_name)
    fps: int = getattr(model, "fps", 30)

    texts = [str(s["text"]).strip() for s in segments]
    durations = [float(s.get("duration", 3.0)) for s in segments]
    for i, d in enumerate(durations):
        if d > _MAX_SEGMENT_DURATION_SEC:
            raise ValueError(
                f"Each segment duration must be at most {_MAX_SEGMENT_DURATION_SEC:g} seconds "
                f"(Kimodo limit); segment {i + 1} is {d:g}s."
            )
        if d < _MIN_SEGMENT_DURATION_SEC:
            raise ValueError(
                f"Each segment duration must be at least {_MIN_SEGMENT_DURATION_SEC:g} seconds; "
                f"segment {i + 1} is {d:g}s."
            )

    cfg_text = float(cfg_text_weight)
    cfg_text = max(_MIN_CFG_TEXT_WEIGHT, min(_MAX_CFG_TEXT_WEIGHT, cfg_text))
    num_frames_list = [max(1, int(round(d * fps))) for d in durations]

    multi_prompt = len(texts) > 1
    transition = max(1, int(num_transition_frames))

    if multi_prompt:
        _log(
            f"Generating motion: {len(texts)} segments generated sequentially, "
            f"{sum(num_frames_list)} frames @ {fps} fps, transition={transition} frames"
        )
    else:
        _log(f"Generating motion: 1 segment, {sum(num_frames_list)} frames @ {fps} fps")
    _log(f"Prompt adherence (CFG text weight): {cfg_text:.1f}")
    for i, (t, nf) in enumerate(zip(texts, num_frames_list)):
        _log(f"  Segment {i+1}/{len(texts)}: '{t[:80]}' → {nf} frames ({durations[i]:.1f}s)")

    # Build starting-pose constraint if the user specified one.
    constraint_lst: list = []
    if starting_pose:
        _log(f"Using starting pose constraint ({len(starting_pose)} joints).")
        try:
            constraint_lst = [_build_fullbody_constraint_at_frame0(model, starting_pose)]
        except Exception as exc:
            _log(f"Warning: could not build starting pose constraint: {exc}. Generating unconstrained.")
            constraint_lst = []

    # Silence Kimodo's tqdm in the worker subprocess (its stdout is parsed for logs).
    def _silent_progress(iterable: Any = None, *args: Any, **kwargs: Any) -> Any:
        return iterable if iterable is not None else iter(())

    # Multi-prompt: mirror the official CLI (kimodo/scripts/generate.py) — pass list
    # prompts/frames so multi_prompt runs the sequential transition path with
    # num_samples variations of the whole sequence.
    # Single-prompt: pass a string + int so ``num_samples`` produces independent
    # variations (Kimodo overrides num_samples to len(prompts) when prompts is a list).
    model_kwargs: dict[str, Any] = dict(
        prompts=texts if multi_prompt else texts[0],
        num_frames=num_frames_list if multi_prompt else num_frames_list[0],
        num_denoising_steps=diffusion_steps,
        multi_prompt=multi_prompt,
        num_samples=num_samples,
        constraint_lst=constraint_lst,
        return_numpy=True,
        post_processing=True,
        progress_bar=_silent_progress,
        cfg_type="separated",
        cfg_weight=[cfg_text, _DEFAULT_CFG_CONSTRAINT_WEIGHT],
    )
    if multi_prompt:
        model_kwargs["num_transition_frames"] = transition

    output: dict = model(**model_kwargs)

    # Extract posed_joints: shape [T, J, 3] (or [B, T, J, 3] for num_samples>1)
    posed_joints_raw = output["posed_joints"]
    if posed_joints_raw.ndim == 4:
        posed_joints_raw = posed_joints_raw[0]  # take first sample
    posed_joints: np.ndarray = posed_joints_raw.astype(np.float32)  # [T, J, 3]
    T, J, _ = posed_joints.shape
    _log(f"Generated {T} frames, {J} joints.")

    # ── Save NPZ ────────────────────────────────────────────────────────────
    npz_path = dest / "motion.npz"
    np.savez_compressed(str(npz_path), **{k: v for k, v in output.items()})
    _log(f"Saved motion.npz ({npz_path.stat().st_size // 1024} KB)")

    # ── Save joints.json.gz (for browser streaming) ─────────────────────────
    # posed_joints centred around origin (subtract mean root XZ for nicer display)
    joints_centered = posed_joints.copy()
    mean_xz = posed_joints[:, 0, [0, 2]].mean(axis=0)  # mean Hips X,Z
    joints_centered[:, :, 0] -= mean_xz[0]
    joints_centered[:, :, 2] -= mean_xz[1]

    joints_list = joints_centered.tolist()  # [T][J][3] nested lists
    joints_json = json.dumps(joints_list).encode("utf-8")
    joints_gz_path = dest / "joints.json.gz"
    with gzip.open(str(joints_gz_path), "wb") as f:
        f.write(joints_json)
    _log(f"Saved joints.json.gz ({joints_gz_path.stat().st_size // 1024} KB)")

    # ── Skin SMPL-X mesh → mesh.f16.gz + mesh_faces.json.gz ─────────────────
    has_mesh = False
    vertex_count = 0
    face_count = 0
    bones = bones_from_skeleton(model.skeleton)
    try:
        has_mesh, vertex_count, face_count = _write_mesh_stream(
            dest,
            output,
            skeleton=model.skeleton,
            center_xz=(float(mean_xz[0]), float(mean_xz[1])),
            log=_log,
        )
    except Exception as exc:  # best-effort — generation still succeeds without the mesh
        logger.exception("SMPL-X skinning failed")
        _log(f"Warning: could not skin SMPL-X mesh: {exc}")

    display_mode = "mesh" if has_mesh else "skeleton"

    # ── Write manifest ───────────────────────────────────────────────────────
    manifest = {
        "fps": fps,
        "frame_count": T,
        "joint_count": J,
        "has_mesh": has_mesh,
        "vertex_count": vertex_count,
        "face_count": face_count,
        "bones": bones,
        "display_mode": display_mode,
        "segments": [{"text": t, "duration": d} for t, d in zip(texts, durations)],
        "model": model_name,
    }
    with (dest / "manifest.json").open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    return {
        "fps": fps,
        "frame_count": T,
        "joint_count": J,
        "has_mesh": has_mesh,
        "vertex_count": vertex_count,
        "face_count": face_count,
        "bones": bones,
        "display_mode": display_mode,
        "npz_path": str(npz_path),
        "joints_gz_path": str(joints_gz_path),
        "segments": manifest["segments"],
    }


def _write_mesh_stream(
    dest: Path,
    output: dict,
    *,
    skeleton: Any,
    center_xz: tuple[float, float],
    log: Callable[[str], None],
) -> tuple[bool, int, int]:
    """
    Skin the SMPL-X mesh and persist it next to the joints:
      - ``mesh.f16.gz``        — gzipped float16 little-endian ``[T, V, 3]`` vertex stream
      - ``mesh_faces.json.gz`` — gzipped JSON face index array ``[F][3]``
    Returns ``(has_mesh, vertex_count, face_count)``.
    """
    import numpy as np
    from services.motion_ref_gen_ai_service.smplx_skinning import skin_sequence

    vertices, faces = skin_sequence(output, center_xz=center_xz, skeleton=skeleton)
    vertices = np.ascontiguousarray(vertices, dtype=np.float16)  # [T, V, 3]
    T, V, _ = vertices.shape
    F = int(faces.shape[0])

    mesh_path = dest / "mesh.f16.gz"
    with gzip.open(str(mesh_path), "wb") as f:
        f.write(vertices.tobytes())
    faces_path = dest / "mesh_faces.json.gz"
    with gzip.open(str(faces_path), "wb") as f:
        f.write(json.dumps(faces.tolist()).encode("utf-8"))

    log(
        f"Saved mesh.f16.gz ({mesh_path.stat().st_size // 1024} KB, {T}×{V} verts) "
        f"+ mesh_faces.json.gz ({F} faces)"
    )
    return True, V, F


# ── Post-generation reskin ────────────────────────────────────────────────────

def reskin_motion(motion_key: str, log_cb: Callable[[str], None] | None = None) -> dict:
    """
    Reskin an existing skeleton-only motion by rerunning SMPL-X skinning on the
    stored ``motion.npz``.  Writes ``mesh.f16.gz`` + ``mesh_faces.json.gz`` next to
    the existing joints file and updates ``manifest.json``.

    Returns a dict with ``motionKey``, ``hasMesh``, ``vertexCount``, ``faceCount``.
    """
    import numpy as np
    from services import motion_ref_storage

    def _log(msg: str) -> None:
        logger.info(msg)
        if log_cb:
            log_cb(msg)

    motion_dir = motion_ref_storage.motion_ref_dir(motion_key)
    npz_path = motion_dir / "motion.npz"
    if not npz_path.is_file():
        raise FileNotFoundError(f"motion.npz not found for motion '{motion_key}'")

    manifest = motion_ref_storage.read_manifest(motion_key)
    if not manifest:
        raise FileNotFoundError(f"manifest.json not found for motion '{motion_key}'")

    _log(f"Loading motion.npz for '{motion_key}'…")
    output = dict(np.load(str(npz_path), allow_pickle=True))

    # Re-derive center_xz from posed_joints (same logic as generate_motion).
    posed_joints_raw = output.get("posed_joints")
    if posed_joints_raw is None:
        raise RuntimeError(
            "motion.npz does not contain 'posed_joints'; cannot derive center for skinning."
        )
    posed_joints = np.asarray(posed_joints_raw, dtype=np.float32)
    if posed_joints.ndim == 4:
        posed_joints = posed_joints[0]
    mean_xz = posed_joints[:, 0, [0, 2]].mean(axis=0)

    model_name = manifest.get("model", _DEFAULT_MODEL)
    _log(f"Loading KiMoD model '{model_name}' (cached after first use)…")
    model = _load_kimodo_model(model_name)

    _log("Running SMPL-X skinning…")
    has_mesh, V, F = _write_mesh_stream(
        motion_dir,
        output,
        skeleton=model.skeleton,
        center_xz=(float(mean_xz[0]), float(mean_xz[1])),
        log=_log,
    )

    manifest.update(
        has_mesh=has_mesh,
        vertex_count=V,
        face_count=F,
        display_mode="mesh" if has_mesh else "skeleton",
    )
    motion_ref_storage.write_manifest(motion_key, manifest)
    _log(f"Manifest updated — has_mesh={has_mesh}, V={V}, F={F}")

    return {
        "motionKey": motion_key,
        "hasMesh": has_mesh,
        "vertexCount": V,
        "faceCount": F,
    }


# ── Pose-constrained generation ───────────────────────────────────────────────


def _build_fullbody_constraint_at_frame0(
    model: Any,
    joints_in: list[list[float]],
) -> Any:
    """
    Construct a ``FullBodyConstraintSet`` that pins frame 0 of generation to the
    given joint positions (from the puppet editor).

    Mirrors ``kimodo/demo/generation.py`` ``compute_model_constraints_lst``:
    constraints are built against the model's **internal** skeleton
    (``model.skeleton``), not the unwrapped SOMA 77-joint skeleton. When the model
    uses the SOMA 30-joint skeleton and the puppet supplies the 77-joint pose, the
    pose is sliced down with ``get_skel_slice`` so joint indices line up.

    Only positions are available from the puppet, so identity global rotations are
    used as the rotation component; the model refines orientation while honoring the
    positional seed. This is a soft constraint at frame 0 of the first segment only;
    ``_multiprompt`` crops it temporally per segment.
    """
    import torch
    from kimodo.constraints import FullBodyConstraintSet

    try:
        from kimodo.skeleton import SOMASkeleton30
    except Exception:  # pragma: no cover - skeleton class may move between versions
        SOMASkeleton30 = ()  # type: ignore[assignment]

    skel = model.skeleton  # model's internal skeleton (do NOT unwrap to somaskel77)
    joints_tensor = torch.tensor(joints_in, dtype=torch.float32)  # [J_in, 3]
    j_in = int(joints_tensor.shape[0])
    model_nb = int(getattr(skel, "nbjoints", j_in))

    # SOMA 30-joint model + SOMA 77-joint puppet pose → slice to the model joints.
    if (
        isinstance(skel, SOMASkeleton30)
        and j_in != model_nb
        and hasattr(skel, "somaskel77")
    ):
        skel_slice = skel.get_skel_slice(skel.somaskel77)
        joints_tensor = joints_tensor[skel_slice]

    j = int(joints_tensor.shape[0])
    if j != model_nb:
        raise ValueError(
            f"Starting pose has {j} joints but model skeleton expects {model_nb}; "
            "cannot build a full-body constraint for this model."
        )

    joints_tensor = joints_tensor.unsqueeze(0)  # [1, J, 3]
    frame_indices = torch.tensor([0], dtype=torch.long)
    # Positions-only seed: identity global rotations, refined by the model.
    identity_rot = torch.eye(3).reshape(1, 1, 3, 3).expand(1, j, 3, 3).contiguous()

    # Positional constructor matches the demo (skeleton, frames, pos, rot).
    return FullBodyConstraintSet(
        skel,
        frame_indices,
        joints_tensor,
        identity_rot,
    )


# ── Persistent HTTP worker ────────────────────────────────────────────────────
# NOTE: server-side frame rendering was removed. Shots are now captured as a
# WebGL screenshot of the live viewer on the client (no KiMoD worker needed),
# which eliminated the OOM crash from spinning up the model just to draw a frame.

def _make_request_handler(model_name: str) -> type:
    class _Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            logger.debug(fmt, *args)

        def _send_json(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/health":
                from services.motion_ref_gen_ai_service.smplx_skinning import smplx_body_model_ready

                self._send_json(200, {"ok": True, "smplx_ready": smplx_body_model_ready()})
            elif self.path == "/bones":
                from services.motion_ref_gen_ai_service.smplx_skinning import bones_from_skeleton

                model = _load_kimodo_model(model_name)
                skel = model.skeleton
                bones = bones_from_skeleton(skel)
                joint_names = list(skel.bone_order_names)
                self._send_json(200, {"bones": bones, "joint_names": joint_names})
            else:
                self.send_error(404)

        def _read_body(self) -> dict:
            n = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(n).decode())

        def do_POST(self) -> None:
            if self.path == "/generate":
                payload = self._read_body()
                segments = payload.get("segments") or []
                dest_dir = payload.get("dest_dir", "")
                diffusion_steps = int(payload.get("diffusion_steps") or _DEFAULT_DIFFUSION_STEPS)
                num_samples = int(payload.get("num_samples") or 1)
                num_transition_frames = int(
                    payload.get("num_transition_frames") or _DEFAULT_NUM_TRANSITION_FRAMES
                )
                starting_pose = payload.get("starting_pose") or None
                cfg_text_weight = float(
                    payload.get("cfg_text_weight") or _DEFAULT_CFG_TEXT_WEIGHT
                )
                logs: list[str] = []
                try:
                    result = generate_motion(
                        segments,
                        dest_dir,
                        model_name=model_name,
                        num_samples=num_samples,
                        diffusion_steps=diffusion_steps,
                        num_transition_frames=num_transition_frames,
                        cfg_text_weight=cfg_text_weight,
                        starting_pose=starting_pose,
                        log_cb=lambda m: logs.append(m),
                    )
                    self._send_json(200, {"result": result, "error": None, "logs": logs})
                except Exception as exc:
                    logger.exception("Generation failed")
                    self._send_json(200, {"result": None, "error": str(exc), "logs": logs})

            else:
                self.send_error(404)

    return _Handler


def serve_forever(
    port: int = _DEFAULT_SERVE_PORT,
    model_name: str = _DEFAULT_MODEL,
) -> None:
    """Load model once, then serve requests indefinitely."""
    logger.info("Pre-loading KiMoD model '%s'…", model_name)
    _load_kimodo_model(model_name)
    logger.info("Model ready. Starting HTTP server on 127.0.0.1:%d", port)
    httpd = HTTPServer(("127.0.0.1", port), _make_request_handler(model_name))
    print(f"READY:{port}", flush=True)
    logger.info("Motion ref gen server listening on port %d", port)
    httpd.serve_forever()


# ── Persistent worker client (called by motion_ref_router) ────────────────────

_worker_lock = threading.Lock()
_worker_proc: subprocess.Popen | None = None  # type: ignore[type-arg]
_worker_port: int = _DEFAULT_SERVE_PORT


def _server_is_up(port: int) -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def _wait_for_server(
    proc: subprocess.Popen,  # type: ignore[type-arg]
    port: int,
    timeout: float | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    from services.motion_ref_gen_ai_service.text_encoder_worker import (
        motion_worker_ready_timeout,
    )

    if timeout is None:
        timeout = motion_worker_ready_timeout()
    deadline = time.monotonic() + timeout
    ready_event = threading.Event()
    stderr_lines: list[str] = []

    def _read_stdout() -> None:
        for line in proc.stdout:  # type: ignore[union-attr]
            line = line.strip()
            if line.startswith("READY:"):
                ready_event.set()
                break
            if log_cb:
                log_cb(f"[motion-ref-worker] {line}")

    def _read_stderr() -> None:
        for line in proc.stderr:  # type: ignore[union-attr]
            line = line.strip()
            stderr_lines.append(line)
            logger.debug("[motion-ref-worker] %s", line)
            if log_cb:
                log_cb(f"[motion-ref-worker] {line}")

    threading.Thread(target=_read_stdout, daemon=True).start()
    threading.Thread(target=_read_stderr, daemon=True).start()

    while time.monotonic() < deadline:
        if ready_event.is_set() or _server_is_up(port):
            return
        if proc.poll() is not None:
            tail = "\n".join(stderr_lines[-10:])
            raise RuntimeError(
                f"Motion ref worker exited (code {proc.returncode}).\n{tail}"
            )
        time.sleep(0.3)

    raise RuntimeError(f"Motion ref worker did not start on port {port} within {timeout:.0f}s.")


def ensure_worker(
    port: int = _DEFAULT_SERVE_PORT,
    model_name: str = _DEFAULT_MODEL,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Start the persistent motion-ref worker if not already running. Thread-safe."""
    from services.motion_ref_gen_ai_service.text_encoder_worker import (
        ensure_text_encoder,
        motion_worker_child_env,
        text_encoder_port,
    )

    global _worker_proc, _worker_port

    with _worker_lock:
        _worker_port = port

        if _server_is_up(port):
            return f"http://127.0.0.1:{port}"

        if _worker_proc is not None and _worker_proc.poll() is None:
            _wait_for_server(_worker_proc, port, log_cb=log_cb)
            return f"http://127.0.0.1:{port}"

        ensure_text_encoder(log_cb=log_cb, port=text_encoder_port())

        from services.kimodo_setup import apply_kimodo_patches, _KIMODO_DIR

        apply_kimodo_patches(_KIMODO_DIR, log_cb=log_cb)

        if log_cb:
            log_cb(
                f"Starting KiMoD motion worker (model={model_name}, port={port}). "
                "Loading diffusion model only…"
            )
        cmd = [
            sys.executable, "-m",
            "services.motion_ref_gen_ai_service.serverless",
            "--serve",
            "--serve-port", str(port),
            "--model", model_name,
        ]
        _worker_proc = subprocess.Popen(
            cmd,
            cwd=str(_REPO_ROOT),
            env=motion_worker_child_env(text_encoder_port()),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        _wait_for_server(_worker_proc, port, log_cb=log_cb)

        if log_cb:
            log_cb(f"KiMoD worker ready on port {port}.")
        logger.info("KiMoD worker ready on port %d.", port)
        return f"http://127.0.0.1:{port}"


def call_generate(
    segments: list[dict],
    dest_dir: str,
    *,
    port: int = _DEFAULT_SERVE_PORT,
    model_name: str = _DEFAULT_MODEL,
    num_samples: int = 1,
    diffusion_steps: int = _DEFAULT_DIFFUSION_STEPS,
    num_transition_frames: int = _DEFAULT_NUM_TRANSITION_FRAMES,
    cfg_text_weight: float = _DEFAULT_CFG_TEXT_WEIGHT,
    starting_pose: list[list[float]] | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Call /generate on the persistent worker."""
    import urllib.request

    base = ensure_worker(port=port, model_name=model_name, log_cb=log_cb)
    if log_cb:
        log_cb("Sending generation request to KiMoD worker…")

    payload = json.dumps({
        "segments": segments,
        "dest_dir": dest_dir,
        "num_samples": num_samples,
        "diffusion_steps": diffusion_steps,
        "num_transition_frames": num_transition_frames,
        "cfg_text_weight": cfg_text_weight,
        "starting_pose": starting_pose,
    }).encode()

    req = urllib.request.Request(
        f"{base}/generate", data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=7200) as resp:
        body = json.loads(resp.read().decode())

    if body.get("logs") and log_cb:
        for line in body["logs"]:
            log_cb(line)

    if body.get("error"):
        raise RuntimeError(body["error"])

    return body["result"]


# ── CLI entry point ───────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Motion reference generation — KiMoD")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--serve", action="store_true", help="Persistent HTTP worker mode.")
    mode.add_argument(
        "--inspect-smplx",
        action="store_true",
        help="Diagnostic: run a tiny generation and dump the model/output schema (for wiring SMPL-X skinning).",
    )
    p.add_argument("--serve-port", type=int, default=_DEFAULT_SERVE_PORT)
    p.add_argument("--model", type=str, default=_DEFAULT_MODEL)
    p.add_argument("--diffusion-steps", type=int, default=_DEFAULT_DIFFUSION_STEPS)
    # One-shot args
    p.add_argument("--prompt", type=str, default=None, help="Text prompt (one-shot mode)")
    p.add_argument("--duration", type=float, default=3.0)
    p.add_argument("--output", type=str, default=None)
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    if args.serve:
        serve_forever(port=args.serve_port, model_name=args.model)
        return

    if args.inspect_smplx:
        _inspect_smplx(model_name=args.model, prompt=args.prompt or "a person walks forward")
        return

    # One-shot mode
    if not args.prompt:
        print(json.dumps({"result": None, "error": "--prompt is required in one-shot mode"}))
        sys.exit(1)

    import tempfile
    dest = args.output or str(Path(tempfile.gettempdir()) / f"motion_{uuid.uuid4().hex[:8]}")
    try:
        result = generate_motion(
            [{"text": args.prompt, "duration": args.duration}],
            dest,
            model_name=args.model,
            diffusion_steps=args.diffusion_steps,
            log_cb=lambda msg: print(msg, file=sys.stderr),
        )
        print(json.dumps({"result": result, "error": None}))
    except Exception as exc:
        logger.exception("One-shot generation failed")
        print(json.dumps({"result": None, "error": str(exc)}))
        sys.exit(1)


def _inspect_smplx(model_name: str, prompt: str) -> None:
    """
    Diagnostic helper: load the (SMPL-X) model, run a short generation, and print the
    structure of the model + output so the skinning adapter can be confirmed/adjusted.
    Run in the container where kimodo + the checkpoint are available.
    """
    import numpy as np

    def _describe(v: Any) -> str:
        if hasattr(v, "shape"):
            return f"{type(v).__name__} shape={tuple(v.shape)} dtype={getattr(v, 'dtype', '?')}"
        if isinstance(v, (list, tuple)):
            return f"{type(v).__name__} len={len(v)}"
        return type(v).__name__

    model = _load_kimodo_model(model_name)
    print("=== MODEL ===")
    print("type:", type(model).__name__)
    print("public attrs:", [a for a in dir(model) if not a.startswith("_")])
    for cand in ("skeleton", "body_model", "smplx", "faces"):
        if hasattr(model, cand):
            print(f"model.{cand}:", _describe(getattr(model, cand)))
    skel = getattr(model, "skeleton", None)
    if skel is not None:
        print("skeleton type:", type(skel).__name__)
        print("skeleton public attrs:", [a for a in dir(skel) if not a.startswith("_")])

    out: dict = model(
        prompts=prompt,
        num_frames=10,
        num_denoising_steps=10,
        multi_prompt=False,
        num_samples=1,
        return_numpy=True,
        post_processing=True,
    )
    print("\n=== OUTPUT ===")
    print("keys:", sorted(out.keys()))
    for k in sorted(out.keys()):
        print(f"  {k}: {_describe(out[k])}")

    print("\n=== SKIN ATTEMPT ===")
    skel = getattr(model, "skeleton", None)
    try:
        from services.motion_ref_gen_ai_service.smplx_skinning import skin_sequence

        verts, faces = skin_sequence(out, skeleton=skel)
        print("OK (native/legacy) vertices:", _describe(np.asarray(verts)), "faces:", _describe(np.asarray(faces)))
    except Exception as exc:
        print("skin_sequence error:", exc)


if __name__ == "__main__":
    main()
