"""Tests for timeline audio volume automation (keep in sync with volumeAutomation.ts)."""

from __future__ import annotations

import pytest

from services.timeline_export import (
    UNITY_VOLUME_LEVEL,
    _volume_envelope_needs_apply,
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
    # Preview el.volume clamps boost to 1; export matches.
    assert _volume_gain_at(clip, 10.0) == pytest.approx(1.0)


def test_normalization_gain_multiplies_flat_envelope():
    clip = _clip(normalizationGain=1.5)
    # 1.5 would exceed preview volume max; clamp to 1.
    assert _volume_gain_at(clip, 5.0) == pytest.approx(1.0)
    assert _volume_envelope_needs_apply(clip) is True


def test_normalization_gain_multiplies_automation_and_clamps():
    clip = _clip(
        normalizationGain=1.5,
        volumeAutomation={
            "points": [
                {"t": 0, "level": 0},
                {"t": 1, "level": 100},
            ]
        },
    )
    # 50 level (unity) * 1.5 normalization clamps at 1 for preview parity.
    assert _volume_gain_at(clip, 5.0) == pytest.approx(1.0)
    # 100 level * 1.5 also clamps at 1.
    assert _volume_gain_at(clip, 10.0) == pytest.approx(1.0)


def test_unity_normalization_gain_needs_no_apply():
    assert _volume_envelope_needs_apply(_clip(normalizationGain=1.0)) is False
    assert _volume_envelope_needs_apply(_clip()) is False
    # Invalid values fall back to 1.
    assert _volume_envelope_needs_apply(_clip(normalizationGain="bogus")) is False
