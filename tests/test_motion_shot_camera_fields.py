"""Tests for shot camera field persistence (distance/slideX/slideY round-trip)."""

from __future__ import annotations

import base64

import services.motion_shot_storage as mss

_PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n").decode("ascii")


def test_shot_item_for_api_echoes_camera_fields() -> None:
    entry = {
        "id": "abc123",
        "motionKey": "m1",
        "frameIndex": 7,
        "azimuth": 20.0,
        "elevation": 15.0,
        "distance": 3.4,
        "slideX": 0.12,
        "slideY": -0.05,
        "relPath": "motion_refs/m1/shots/abc123.png",
        "createdAt": 1.0,
    }
    item = mss._shot_item_for_api(entry)
    assert item["distance"] == 3.4
    assert item["slideX"] == 0.12
    assert item["slideY"] == -0.05


def test_shot_item_for_api_backward_compat_without_camera_fields() -> None:
    entry = {
        "id": "old1",
        "motionKey": "m1",
        "frameIndex": 0,
        "azimuth": 10.0,
        "elevation": 5.0,
        "relPath": "motion_refs/m1/shots/old1.png",
        "createdAt": 1.0,
    }
    item = mss._shot_item_for_api(entry)
    assert "distance" not in item
    assert "slideX" not in item
    assert "slideY" not in item


def test_save_shot_round_trips_camera_fields(tmp_path, monkeypatch) -> None:
    root = tmp_path / "motion_refs"
    root.mkdir(parents=True, exist_ok=True)
    key = "m1"
    shots_dir = root / key / "shots"

    monkeypatch.setattr(mss, "MOTION_REFS_STORAGE_ROOT", root)
    monkeypatch.setattr(mss, "list_motion_ref_keys", lambda: [key])
    monkeypatch.setattr(mss, "motion_ref_shots_dir", lambda k: root / k / "shots")
    del shots_dir  # created by save_shot

    item = mss.save_shot(
        motion_key=key,
        png_base64=_PNG,
        frame_index=3,
        azimuth=22.0,
        elevation=11.0,
        distance=2.75,
        slide_x=0.2,
        slide_y=-0.1,
    )
    assert item["distance"] == 2.75
    assert item["slideX"] == 0.2
    assert item["slideY"] == -0.1

    # Reload from manifest to confirm persistence on disk.
    reloaded = mss.list_shots()
    saved = next(s for s in reloaded if s["id"] == item["id"])
    assert saved["distance"] == 2.75
    assert saved["slideX"] == 0.2
    assert saved["slideY"] == -0.1
