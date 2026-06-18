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


def read_camera_trajectory(motion_key: str) -> dict:
    path = _camera_trajectory_path(motion_key)
    if not path.is_file():
        return {"keyframes": []}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    keyframes = data.get("keyframes") if isinstance(data, dict) else []
    if not isinstance(keyframes, list):
        keyframes = []
    return {"keyframes": keyframes}


def write_camera_trajectory(motion_key: str, keyframes: list[dict]) -> dict:
    d = motion_ref_dir(motion_key)
    d.mkdir(parents=True, exist_ok=True)
    sorted_kf = sorted(keyframes, key=lambda k: int(k.get("frameIndex", 0)))
    payload = {"keyframes": sorted_kf}
    tmp = d / "camera_trajectory.json.tmp"
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    tmp.replace(_camera_trajectory_path(motion_key))
    return payload


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
    }
    replaced = False
    for i, kf in enumerate(keyframes):
        if int(kf.get("frameIndex", -1)) == frame_index:
            entry["id"] = str(kf.get("id") or entry["id"])
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
