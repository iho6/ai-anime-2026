"""Timeline preview uses edited frameSequence strips before video decoding."""

from pathlib import Path

from PIL import Image

from services import timeline_preview_frames


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
        "_clip_has_exportable_frame_sequence",
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
