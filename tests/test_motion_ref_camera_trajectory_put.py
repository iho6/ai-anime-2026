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
