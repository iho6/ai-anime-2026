"""Tests for replacing motion-ref camera trajectory keyframes (undo support)."""

from __future__ import annotations

import json

import pytest

from services import motion_ref_storage


def test_write_camera_trajectory_replace_preserves_playback_range(tmp_path, monkeypatch) -> None:
    root = tmp_path / "motion_refs"
    key = "test_motion"
    motion_dir = root / key
    motion_dir.mkdir(parents=True)
    (motion_dir / "manifest.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(motion_ref_storage, "MOTION_REFS_STORAGE_ROOT", root)

    kf_a = {
        "id": "a1",
        "frameIndex": 0,
        "azimuth": 0.0,
        "elevation": 15.0,
        "distance": 2.6,
        "slideX": 0.0,
        "slideY": 0.0,
        "holdFrames": 0,
        "blendEase": 100,
    }
    kf_b = {
        "id": "b2",
        "frameIndex": 50,
        "azimuth": 45.0,
        "elevation": 15.0,
        "distance": 2.6,
        "slideX": 0.0,
        "slideY": 0.0,
        "holdFrames": 0,
        "blendEase": 100,
    }

    motion_ref_storage.write_camera_trajectory(
        key,
        [kf_a, kf_b],
        playback_range={"startFrame": 5, "endFrame": 80},
    )

    motion_ref_storage.write_camera_trajectory(key, [kf_a])

    path = motion_dir / "camera_trajectory.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert len(data["keyframes"]) == 1
    assert data["keyframes"][0]["id"] == "a1"
    assert data["playbackRange"]["startFrame"] == 5
    assert data["playbackRange"]["endFrame"] == 80


def test_preview_camera_round_trip_and_trajectory_writes_preserve_it(
    tmp_path, monkeypatch
) -> None:
    root = tmp_path / "motion_refs"
    key = "camera_pref_motion"
    motion_dir = root / key
    motion_dir.mkdir(parents=True)
    (motion_dir / "manifest.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(motion_ref_storage, "MOTION_REFS_STORAGE_ROOT", root)

    camera = {
        "azimuth": 137.5,
        "elevation": -12.25,
        "distance": 4.75,
        "slideX": 0.4,
        "slideY": -0.2,
    }
    saved = motion_ref_storage.update_preview_camera(key, camera)
    assert saved["previewCamera"] == camera
    assert saved["keyframes"] == []

    keyframe = {
        "id": "pose-1",
        "frameIndex": 4,
        "azimuth": 20,
        "elevation": 15,
        "distance": 3,
        "slideX": 0,
        "slideY": 0,
    }
    after_upsert = motion_ref_storage.upsert_camera_keyframe(key, keyframe)
    assert after_upsert["previewCamera"] == camera

    after_range = motion_ref_storage.update_playback_range(key, 2, 20)
    assert after_range["previewCamera"] == camera

    replacement = {**keyframe, "id": "pose-2", "frameIndex": 8}
    after_replace = motion_ref_storage.write_camera_trajectory(key, [replacement])
    assert after_replace["previewCamera"] == camera

    assert motion_ref_storage.delete_camera_keyframe(key, "pose-2") is True
    final = motion_ref_storage.read_camera_trajectory(key)
    assert final["previewCamera"] == camera
    assert final["keyframes"] == []
    assert final["playbackRange"] == {"startFrame": 2, "endFrame": 20}


def test_preview_camera_serialization(tmp_path, monkeypatch) -> None:
    from ui.api.motion_ref_router import _serialize_camera_trajectory

    root = tmp_path / "motion_refs"
    key = "serialize_camera"
    (root / key).mkdir(parents=True)
    monkeypatch.setattr(motion_ref_storage, "MOTION_REFS_STORAGE_ROOT", root)

    motion_ref_storage.update_preview_camera(
        key,
        {
            "azimuth": 90,
            "elevation": 5,
            "distance": 0.01,
            "slideX": 1,
            "slideY": -1,
        },
    )
    serialized = _serialize_camera_trajectory(
        motion_ref_storage.read_camera_trajectory(key)
    )
    assert serialized["previewCamera"] == {
        "azimuth": 90.0,
        "elevation": 5.0,
        "distance": 0.05,
        "slideX": 1.0,
        "slideY": -1.0,
    }


def test_keyframes_entries_from_replace_body_rejects_duplicate_frame() -> None:
    from ui.api.motion_ref_router import (
        CameraKeyframeBody,
        _keyframes_entries_from_replace_body,
    )

    bodies = [
        CameraKeyframeBody(
            frameIndex=0,
            azimuth=0,
            elevation=15,
            distance=2.6,
        ),
        CameraKeyframeBody(
            frameIndex=0,
            azimuth=10,
            elevation=15,
            distance=2.6,
        ),
    ]
    with pytest.raises(ValueError, match="Duplicate frameIndex"):
        _keyframes_entries_from_replace_body(bodies)
