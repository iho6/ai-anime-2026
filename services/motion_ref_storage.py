"""
Storage helpers for motion reference sequences under
``storage/motion_refs/<motion_key>/``.

Layout::

    storage/motion_refs/<motion_key>/
        motion.npz          # raw KiMoD output (posed_joints etc.)
        joints.json.gz      # gzipped [[T, J, 3]] float32 list for browser streaming
        camera_trajectory.json  # saved orbit camera keyframes per frame
        shots/              # rendered frame PNGs saved by the user
            0_frame042.png
            1_frame007.png
            ...
"""

from __future__ import annotations

import json
import shutil
import uuid
from pathlib import Path
from typing import Any

from services.character_storage import DEFAULT_STORAGE_ROOT, sanitize_for_folder

MOTION_REFS_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "motion_refs").resolve()


def motion_refs_root() -> Path:
    return MOTION_REFS_STORAGE_ROOT


def motion_ref_dir(motion_key: str) -> Path:
    return (MOTION_REFS_STORAGE_ROOT / sanitize_for_folder(motion_key)).resolve()


def motion_ref_shots_dir(motion_key: str) -> Path:
    return motion_ref_dir(motion_key) / "shots"


def list_motion_ref_keys() -> list[str]:
    root = MOTION_REFS_STORAGE_ROOT
    if not root.exists():
        return []
    return sorted(
        [
            p.name for p in root.iterdir()
            if p.is_dir() and not p.name.startswith("_") and (p / "manifest.json").is_file()
        ],
        key=lambda s: s.lower(),
    )


def unique_motion_ref_key(base_name: str) -> str:
    """Return a sanitized, currently-unused folder key for a new motion."""
    key = sanitize_for_folder(base_name) or "motion"
    if not (MOTION_REFS_STORAGE_ROOT / key).exists():
        return key
    i = 2
    while (MOTION_REFS_STORAGE_ROOT / f"{key}_{i}").exists():
        i += 1
    return f"{key}_{i}"


def create_motion_ref(base_name: str) -> str:
    """Create an empty motion ref directory; return its key."""
    key = unique_motion_ref_key(base_name)
    d = motion_ref_dir(key)
    (d / "shots").mkdir(parents=True, exist_ok=True)
    return key


def read_manifest(motion_key: str) -> dict:
    """Read per-motion metadata (fps, frame_count, joint_count, segments)."""
    path = motion_ref_dir(motion_key) / "manifest.json"
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_manifest(motion_key: str, manifest: dict) -> None:
    d = motion_ref_dir(motion_key)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "manifest.json.tmp"
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    tmp.replace(d / "manifest.json")


def delete_motion_ref(motion_key: str) -> None:
    d = motion_ref_dir(motion_key)
    if d.is_dir():
        shutil.rmtree(d)


def _camera_trajectory_path(motion_key: str) -> Path:
    return motion_ref_dir(motion_key) / "camera_trajectory.json"


_SENTINEL_PLAYBACK = object()


def read_camera_trajectory(motion_key: str) -> dict:
    path = _camera_trajectory_path(motion_key)
    if not path.is_file():
        return {"keyframes": [], "playbackRange": None}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    keyframes = data.get("keyframes") if isinstance(data, dict) else []
    if not isinstance(keyframes, list):
        keyframes = []
    playback_range = data.get("playbackRange") if isinstance(data, dict) else None
    if not isinstance(playback_range, dict):
        playback_range = None
    return {"keyframes": keyframes, "playbackRange": playback_range}


def write_camera_trajectory(
    motion_key: str,
    keyframes: list[dict],
    *,
    playback_range: dict | None = _SENTINEL_PLAYBACK,  # type: ignore
) -> dict:
    d = motion_ref_dir(motion_key)
    d.mkdir(parents=True, exist_ok=True)
    sorted_kf = sorted(keyframes, key=lambda k: int(k.get("frameIndex", 0)))
    existing = read_camera_trajectory(motion_key)
    payload: dict[str, Any] = {"keyframes": sorted_kf}
    if playback_range is _SENTINEL_PLAYBACK:
        pr = existing.get("playbackRange")
    else:
        pr = playback_range
    if isinstance(pr, dict):
        payload["playbackRange"] = {
            "startFrame": int(pr.get("startFrame", 0)),
            "endFrame": int(pr.get("endFrame", 0)),
        }
    tmp = d / "camera_trajectory.json.tmp"
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    tmp.replace(_camera_trajectory_path(motion_key))
    return payload


def update_playback_range(motion_key: str, start_frame: int, end_frame: int) -> dict:
    if not motion_ref_dir(motion_key).is_dir():
        raise FileNotFoundError(f"Motion not found: {motion_key}")
    data = read_camera_trajectory(motion_key)
    keyframes: list[dict] = list(data.get("keyframes") or [])
    return write_camera_trajectory(
        motion_key,
        keyframes,
        playback_range={"startFrame": int(start_frame), "endFrame": int(end_frame)},
    )


def upsert_camera_keyframe(motion_key: str, keyframe: dict) -> dict:
    if not motion_ref_dir(motion_key).is_dir():
        raise FileNotFoundError(f"Motion not found: {motion_key}")
    data = read_camera_trajectory(motion_key)
    keyframes: list[dict] = list(data.get("keyframes") or [])
    frame_index = int(keyframe.get("frameIndex", 0))
    entry = {
        "id": str(keyframe.get("id") or uuid.uuid4().hex),
        "frameIndex": frame_index,
        "azimuth": float(keyframe.get("azimuth", 0)),
        "elevation": float(keyframe.get("elevation", 0)),
        "distance": float(keyframe.get("distance", 2.6)),
        "slideX": float(keyframe.get("slideX", 0)),
        "slideY": float(keyframe.get("slideY", 0)),
    }
    cam_pos = keyframe.get("cameraPosition")
    if isinstance(cam_pos, list) and len(cam_pos) >= 3:
        entry["cameraPosition"] = [float(cam_pos[0]), float(cam_pos[1]), float(cam_pos[2])]
    look_at = keyframe.get("lookAtTarget")
    if isinstance(look_at, list) and len(look_at) >= 3:
        entry["lookAtTarget"] = [float(look_at[0]), float(look_at[1]), float(look_at[2])]
    hold = keyframe.get("holdFrames")
    if hold is not None:
        entry["holdFrames"] = max(0, int(hold))
    ease = keyframe.get("blendEase")
    if ease is not None:
        entry["blendEase"] = max(0, min(100, int(ease)))
    replaced = False
    for i, kf in enumerate(keyframes):
        if int(kf.get("frameIndex", -1)) == frame_index:
            entry["id"] = str(kf.get("id") or entry["id"])
            if "holdFrames" not in entry and kf.get("holdFrames") is not None:
                entry["holdFrames"] = max(0, int(kf.get("holdFrames", 0)))
            if "blendEase" not in entry and kf.get("blendEase") is not None:
                entry["blendEase"] = max(0, min(100, int(kf.get("blendEase", 100))))
            keyframes[i] = entry
            replaced = True
            break
    if not replaced:
        keyframes.append(entry)
    return write_camera_trajectory(motion_key, keyframes)


def delete_camera_keyframe(motion_key: str, keyframe_id: str) -> bool:
    data = read_camera_trajectory(motion_key)
    keyframes: list[dict] = list(data.get("keyframes") or [])
    new_kf = [k for k in keyframes if str(k.get("id")) != str(keyframe_id)]
    if len(new_kf) == len(keyframes):
        return False
    write_camera_trajectory(motion_key, new_kf)
    return True


def patch_camera_keyframe(
    motion_key: str,
    keyframe_id: str,
    *,
    hold_frames: int | None = None,
    blend_ease: int | None = None,
) -> dict:
    if not motion_ref_dir(motion_key).is_dir():
        raise FileNotFoundError(f"Motion not found: {motion_key}")
    if hold_frames is None and blend_ease is None:
        raise ValueError("At least one of hold_frames or blend_ease is required.")
    data = read_camera_trajectory(motion_key)
    keyframes: list[dict] = list(data.get("keyframes") or [])
    found = False
    for i, kf in enumerate(keyframes):
        if str(kf.get("id")) == str(keyframe_id):
            updated = dict(kf)
            if hold_frames is not None:
                updated["holdFrames"] = max(0, int(hold_frames))
            if blend_ease is not None:
                updated["blendEase"] = max(0, min(100, int(blend_ease)))
            keyframes[i] = updated
            found = True
            break
    if not found:
        raise FileNotFoundError(f"Camera keyframe not found: {keyframe_id}")
    return write_camera_trajectory(motion_key, keyframes)


def patch_camera_keyframe_hold(motion_key: str, keyframe_id: str, hold_frames: int) -> dict:
    return patch_camera_keyframe(motion_key, keyframe_id, hold_frames=hold_frames)
