"""Timeline FLF endpoint frame index resolution."""

from __future__ import annotations

import pytest

from services import logic


def test_resolve_video_trim_frame_index_first_and_last(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_probe(_path: object, *, log_cb: object = None) -> tuple[float, int]:
        return 24.0, 100

    monkeypatch.setattr(logic, "probe_video_fps_and_frame_count", fake_probe)

    assert logic.resolve_video_trim_frame_index("clip.mp4", 0, 1, edge="first") == 0
    assert logic.resolve_video_trim_frame_index("clip.mp4", 0, 1, edge="last") == 23
    assert logic.resolve_video_trim_frame_index("clip.mp4", 1, 3, edge="first") == 24
    assert logic.resolve_video_trim_frame_index("clip.mp4", 1, 3, edge="last") == 71


def test_resolve_video_trim_frame_index_accepts_end_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        logic,
        "probe_video_fps_and_frame_count",
        lambda *_a, **_k: (10.0, 50),
    )
    assert logic.resolve_video_trim_frame_index("clip.mp4", 0, 5, edge="end") == 49
