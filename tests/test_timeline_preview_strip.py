"""Timeline preview uses edited frameSequence strips before video decoding."""

from pathlib import Path

from PIL import Image

from services import timeline_preview_frames
from services.timeline_export import (
    _clip_prefers_alpha_decode_over_strip,
    _clip_should_use_frame_sequence_strip,
)


def test_timeline_preview_prefers_frame_sequence_strip(monkeypatch) -> None:
    clip = {
        "id": "clip-1",
        "type": "video",
        "inPoint": 1.0,
        "outPoint": 3.0,
        "frameSequence": {
            "strip": [
                {"kind": "image", "relPath": "frames/0.png"},
                {"kind": "image", "relPath": "frames/1.png"},
            ]
        },
        "coloring": {"r": 200},
    }
    seen: dict[str, int] = {}

    monkeypatch.setattr(
        timeline_preview_frames,
        "_clip_should_use_frame_sequence_strip",
        lambda _clip: True,
    )
    monkeypatch.setattr(
        timeline_preview_frames,
        "_strip_frame_index_at_source_time",
        lambda _clip, _strip, _fps, _time: 1,
    )

    def fake_strip_frame(_strip, idx, _cache):
        seen["idx"] = idx
        return Image.new("RGBA", (2, 2), (10, 20, 30, 255))

    monkeypatch.setattr(
        timeline_preview_frames, "_strip_rgba_at_index", fake_strip_frame
    )
    monkeypatch.setattr(
        timeline_preview_frames.preview_decoder_cache,
        "get_rgba_frame",
        lambda *_args: (_ for _ in ()).throw(AssertionError("decoder must not run")),
    )

    rgba = timeline_preview_frames.timeline_preview_rgba(
        "timeline-1",
        {"fps": 24},
        clip,
        Path("/unused/source.webm"),
        1.5,
    )

    assert seen["idx"] == 1
    assert rgba.getpixel((0, 0)) == (20, 20, 30, 255)


def test_clip_with_alpha_skips_opaque_frame_sequence_strip(monkeypatch) -> None:
    clip = {
        "id": "clip-alpha",
        "type": "video",
        "inPoint": 0.0,
        "outPoint": 2.0,
        "alphaRelPath": "clips/clip.alpha.mkv",
        "frameSequence": {
            "strip": [
                {"kind": "image", "relPath": "frames/0.png"},
            ]
        },
    }
    assert _clip_prefers_alpha_decode_over_strip(clip) is True
    assert _clip_should_use_frame_sequence_strip(clip) is False

    called: dict[str, bool] = {"decoder": False}

    def fake_decoder(*_args, **_kwargs):
        called["decoder"] = True
        return Image.new("RGBA", (2, 2), (1, 2, 3, 0))

    monkeypatch.setattr(
        timeline_preview_frames,
        "_proxy_decode_target",
        lambda c, p: (c, p),
    )
    monkeypatch.setattr(
        timeline_preview_frames.preview_decoder_cache,
        "get_rgba_frame",
        fake_decoder,
    )
    monkeypatch.setattr(
        timeline_preview_frames,
        "_strip_rgba_at_index",
        lambda *_args: (_ for _ in ()).throw(AssertionError("strip must not run")),
    )

    rgba = timeline_preview_frames.timeline_preview_rgba(
        "timeline-1",
        {"fps": 24},
        clip,
        Path("/unused/source.webm"),
        0.5,
    )

    assert called["decoder"] is True
    assert rgba.getpixel((0, 0))[3] == 0
