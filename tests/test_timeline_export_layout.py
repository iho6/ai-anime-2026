"""Layout/transform parity tests for timeline MP4 export (mirrors frontend TS)."""

from __future__ import annotations

import pytest

from services.timeline_export import (
    _clip_image_rect,
    _clip_end,
    _motion_offset_at,
    _reference_frame_size,
    _timeline_duration,
    _trajectory_transform_at,
    clip_transform_at_playhead,
)


def _sample_trajectory_clip() -> dict:
    return {
        "id": "c1",
        "type": "image",
        "start": 0.0,
        "duration": 4.0,
        "inPoint": 0.0,
        "outPoint": 4.0,
        "speed": 1.0,
        "naturalW": 1920,
        "naturalH": 1080,
        "trajectory": {
            "motion": "pulse",
            "motionAmount": 100,
            "waypoints": [
                {"t": 0, "x": -0.1, "y": 0, "scale": 1},
                {"t": 1, "x": 0.1, "y": 0, "scale": 1.2},
            ],
        },
    }


def test_reference_frame_size_16_9() -> None:
    w, h = _reference_frame_size("16:9")
    assert w == 1920
    assert h == 1080


def test_timeline_duration() -> None:
    manifest = {
        "tracks": [
            {
                "kind": "video",
                "clips": [
                    {"start": 0, "duration": 3},
                    {"start": 2, "duration": 5},
                ],
            }
        ]
    }
    assert _timeline_duration(manifest) == pytest.approx(7.0)


def test_trajectory_linear_midpoint() -> None:
    clip = _sample_trajectory_clip()
    tf = _trajectory_transform_at(clip, 2.0)
    assert tf is not None
    assert tf["x"] == pytest.approx(0.0, abs=1e-9)
    assert tf["scale"] == pytest.approx(1.1, abs=1e-9)


def test_motion_pulse_nonzero() -> None:
    clip = _sample_trajectory_clip()
    off = _motion_offset_at(clip, 0.25)
    assert off["dScale"] != 0.0
    assert off["dRotation"] == 0.0


def test_motion_wiggle_rotation_only() -> None:
    clip = _sample_trajectory_clip()
    clip["trajectory"]["motion"] = "wiggle"
    off = _motion_offset_at(clip, 0.5)
    assert off["dRotation"] != 0.0
    assert off["dx"] == 0.0
    assert off["dy"] == 0.0


def test_motion_jitter_translate_only() -> None:
    clip = _sample_trajectory_clip()
    clip["trajectory"]["motion"] = "jitter"
    off = _motion_offset_at(clip, 0.5)
    assert off["dRotation"] == 0.0
    assert abs(off["dx"]) + abs(off["dy"]) > 0.0


def test_motion_none_zero_offset() -> None:
    clip = _sample_trajectory_clip()
    clip["trajectory"]["motion"] = "none"
    off = _motion_offset_at(clip, 1.0)
    assert off == {
        "dx": 0.0,
        "dy": 0.0,
        "dScale": 0.0,
        "dRotation": 0.0,
        "dOpacity": 0.0,
    }


def test_clip_transform_static_fallback() -> None:
    clip = {
        "id": "c2",
        "start": 0,
        "duration": 2,
        "transform": {"x": 0.25, "y": -0.1, "scale": 0.8},
    }
    tf = clip_transform_at_playhead(clip, 0.5)
    assert tf["x"] == 0.25
    assert tf["scale"] == 0.8
    assert tf["rotation"] == 0.0
    assert tf["opacity"] == 1.0


def test_clip_image_rect_centered() -> None:
    clip = {"naturalW": 1000, "naturalH": 1000}
    frame_w, frame_h = 1920, 1080
    rect = _clip_image_rect(
        clip,
        {"x": 0, "y": 0, "scale": 1},
        frame_w,
        frame_h,
    )
    cx = rect["left"] + rect["width"] / 2
    cy = rect["top"] + rect["height"] / 2
    assert cx == pytest.approx(frame_w / 2, abs=0.5)
    assert cy == pytest.approx(frame_h / 2, abs=0.5)


def test_overshoot_settles_after_window() -> None:
    clip = _sample_trajectory_clip()
    clip["trajectory"]["motion"] = "overshoot"
    off_early = _motion_offset_at(clip, 0.3)
    off_late = _motion_offset_at(clip, 2.0)
    assert abs(off_early["dx"]) > 0.0
    assert off_late == {
        "dx": 0.0,
        "dy": 0.0,
        "dScale": 0.0,
        "dRotation": 0.0,
        "dOpacity": 0.0,
    }


def test_flicker_opacity_swing() -> None:
    clip = _sample_trajectory_clip()
    clip["trajectory"]["motion"] = "flicker"
    tf_low = clip_transform_at_playhead(clip, 0.25)
    tf_high = clip_transform_at_playhead(clip, 0.75)
    assert tf_low["opacity"] != tf_high["opacity"]
    assert min(tf_low["opacity"], tf_high["opacity"]) >= 0.05


def test_clip_end() -> None:
    assert _clip_end({"start": 1.5, "duration": 3}) == pytest.approx(4.5)
