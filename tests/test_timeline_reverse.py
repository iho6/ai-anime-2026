"""Reverse-playback source-time mapping (mirrors timelineUtil.ts)."""

from __future__ import annotations

from services.timeline_export import _source_time_at, _source_time_at_with_transition


def _video_clip(**overrides) -> dict:
    base = {
        "id": "clip",
        "type": "video",
        "start": 10.0,
        "inPoint": 2.0,
        "outPoint": 8.0,
        "speed": 1.0,
        "duration": 6.0,
    }
    base.update(overrides)
    return base


def test_source_time_forward() -> None:
    clip = _video_clip()
    assert _source_time_at(clip, 10.0) == 2.0
    assert _source_time_at(clip, 13.0) == 5.0
    assert _source_time_at(clip, 16.0) == 8.0


def test_source_time_reversed() -> None:
    clip = _video_clip(reversed=True)
    assert _source_time_at(clip, 10.0) == 8.0
    assert _source_time_at(clip, 13.0) == 5.0
    assert _source_time_at(clip, 16.0) == 2.0


def test_source_time_reversed_with_speed() -> None:
    clip = _video_clip(reversed=True, speed=2.0, duration=3.0)
    assert _source_time_at(clip, 10.0) == 8.0
    assert _source_time_at(clip, 11.5) == 5.0
    assert _source_time_at(clip, 13.0) == 2.0


def test_source_time_reversed_fade_in_region() -> None:
    track = {
        "id": "trk",
        "kind": "video",
        "clips": [
            {
                "id": "a",
                "type": "image",
                "start": 0.0,
                "duration": 2.0,
                "transitionOut": {"type": "fade", "duration": 1.0},
            },
            {
                "id": "b",
                "type": "video",
                "start": 2.0,
                "duration": 4.0,
                "inPoint": 0.0,
                "outPoint": 4.0,
                "speed": 1.0,
                "reversed": True,
            },
        ],
    }
    incoming = track["clips"][1]
    # Fade starts at 1.0; halfway through fade at 1.5 → local 0.5 from outPoint 4.0
    assert _source_time_at_with_transition(incoming, 1.5, track) == 3.5
    assert _source_time_at_with_transition(incoming, 2.0, track) == 4.0
