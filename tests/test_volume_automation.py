"""Tests for timeline audio volume automation (keep in sync with volumeAutomation.ts)."""

from __future__ import annotations

import pytest

from services.timeline_export import (
    UNITY_VOLUME_LEVEL,
    _volume_gain_at,
    _volume_level_at,
)


def _clip(**kwargs):
    base = {
        "start": 0.0,
        "duration": 10.0,
        "inPoint": 0.0,
        "outPoint": 10.0,
        "speed": 1.0,
    }
    base.update(kwargs)
    return base


def test_missing_automation_defaults_to_unity():
    clip = _clip()
    assert _volume_level_at(clip, 5.0) == UNITY_VOLUME_LEVEL
    assert _volume_gain_at(clip, 5.0) == pytest.approx(1.0)


def test_linear_segment_interpolation():
    clip = _clip(
        volumeAutomation={
            "points": [
                {"t": 0, "level": 0},
                {"t": 1, "level": 100},
            ]
        }
    )
    assert _volume_level_at(clip, 0.0) == pytest.approx(0.0)
    assert _volume_level_at(clip, 5.0) == pytest.approx(50.0)
    assert _volume_level_at(clip, 10.0) == pytest.approx(100.0)
    assert _volume_gain_at(clip, 5.0) == pytest.approx(1.0)


def test_bezier_segment_with_control_point():
    clip = _clip(
        volumeAutomation={
            "points": [
                {"t": 0, "level": 50, "cpt": 0.5, "cpl": 100},
                {"t": 1, "level": 50},
            ]
        }
    )
    # Mid-segment should bow toward control level 100, above linear 50.
    mid = _volume_level_at(clip, 5.0)
    assert mid > 50.0
    assert mid < 100.0


def test_gain_clamps_at_extremes():
    clip = _clip(
        volumeAutomation={
            "points": [
                {"t": 0, "level": 0},
                {"t": 1, "level": 100},
            ]
        }
    )
    assert _volume_gain_at(clip, 0.0) == pytest.approx(0.0)
    assert _volume_gain_at(clip, 10.0) == pytest.approx(2.0)
