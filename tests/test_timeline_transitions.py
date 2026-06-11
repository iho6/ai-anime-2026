"""Transition / crossfade layer tests (mirrors timelineUtil.ts)."""

from __future__ import annotations

import pytest

from services.timeline_export import (
    _active_layers_at,
    _compute_slide_offsets,
    _effective_transition_duration,
    _is_connected_pair,
    _source_time_at_with_transition,
)


def _pair_manifest(transition: dict | None = None) -> dict:
    return {
        "id": "trk",
        "kind": "video",
        "clips": [
            {
                "id": "a",
                "type": "image",
                "start": 0.0,
                "duration": 2.0,
                "transitionOut": transition or {"type": "fade", "duration": 1.0},
            },
            {
                "id": "b",
                "type": "image",
                "start": 2.0,
                "duration": 2.0,
            },
        ],
    }


def test_is_connected_pair() -> None:
    a = {"start": 0.0, "duration": 2.0}
    b = {"start": 2.0, "duration": 1.0}
    assert _is_connected_pair(a, b) is True
    assert _is_connected_pair(a, {"start": 2.1, "duration": 1.0}) is False


def test_crossfade_midpoint_opacities() -> None:
    track = _pair_manifest()
    # Junction at 2.0, duration 1.0 → fade 1.0–2.0, midpoint 1.5
    layers = _active_layers_at(track, 1.5)
    assert len(layers) == 2
    ops = sorted(l["opacity"] for l in layers)
    assert ops[0] == pytest.approx(0.5, abs=0.01)
    assert ops[1] == pytest.approx(0.5, abs=0.01)


def test_dissolve_differs_from_linear_fade() -> None:
    track = _pair_manifest({"type": "dissolve", "duration": 1.0})
    # progress 0.25 at t=1.25
    layers = _active_layers_at(track, 1.25)
    incoming = next(l for l in layers if l["clip"]["id"] == "b")
    assert incoming["opacity"] == pytest.approx(0.15625, abs=0.01)


def test_wipe_midpoint_two_layers_full_opacity() -> None:
    track = _pair_manifest({"type": "wipe", "duration": 1.0, "direction": "left"})
    layers = _active_layers_at(track, 1.5)
    assert len(layers) == 2
    assert all(l["opacity"] == pytest.approx(1.0) for l in layers)
    incoming = next(l for l in layers if l["role"] == "incoming")
    assert incoming["transitionType"] == "wipe"
    assert incoming["progress"] == pytest.approx(0.5, abs=0.01)


def test_slide_midpoint_has_offsets() -> None:
    track = _pair_manifest({"type": "slide", "duration": 1.0, "direction": "left"})
    layers = _active_layers_at(track, 1.5)
    assert len(layers) == 2
    outgoing = next(l for l in layers if l["role"] == "outgoing")
    incoming = next(l for l in layers if l["role"] == "incoming")
    assert outgoing["slideOffsetX"] == pytest.approx(-0.5, abs=0.01)
    assert incoming["slideOffsetX"] == pytest.approx(-0.5, abs=0.01)


def test_slide_direction_right_differs_from_left() -> None:
    left = _compute_slide_offsets("left", 0.5, "incoming")
    right = _compute_slide_offsets("right", 0.5, "incoming")
    assert left != right
    assert left[0] == pytest.approx(-0.5, abs=0.01)
    assert right[0] == pytest.approx(0.5, abs=0.01)


def test_source_time_with_transition_for_wipe() -> None:
    track = _pair_manifest({"type": "wipe", "duration": 1.0})
    incoming = track["clips"][1]
    incoming["type"] = "video"
    incoming["inPoint"] = 0.0
    incoming["speed"] = 1.0
    # During overlap at t=1.5, incoming should play from local 0.5s
    st = _source_time_at_with_transition(incoming, 1.5, track)
    assert st == pytest.approx(0.5, abs=0.01)


def test_no_crossfade_when_disconnected() -> None:
    track = _pair_manifest()
    track["clips"][1]["start"] = 3.0
    layers = _active_layers_at(track, 1.5)
    assert len(layers) == 1
    assert layers[0]["clip"]["id"] == "a"


def test_duration_clamped_by_clip_length() -> None:
    outgoing = {"duration": 0.4, "transitionOut": {"type": "fade", "duration": 2.0}}
    incoming = {"duration": 1.0}
    d = _effective_transition_duration(outgoing, incoming)
    assert d == pytest.approx(0.2, abs=0.01)
