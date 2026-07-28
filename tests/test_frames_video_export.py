"""Auto WebM/MP4 selection and transparency detection for frame slideshow export."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from services.logic import (
    _encode_slideshow_video,
    _frames_need_webm,
    _image_has_transparency,
    timeline_frame_sequence_to_video,
)


def test_image_has_transparency_rgb_is_false(tmp_path: Path) -> None:
    p = tmp_path / "opaque.png"
    Image.new("RGB", (32, 32), (255, 0, 0)).save(p)
    assert _image_has_transparency(p) is False


def test_image_has_transparency_rgba_full_opaque_is_false(tmp_path: Path) -> None:
    p = tmp_path / "full_alpha.png"
    Image.new("RGBA", (32, 32), (0, 255, 0, 255)).save(p)
    assert _image_has_transparency(p) is False


def test_image_has_transparency_rgba_partial_alpha_is_true(tmp_path: Path) -> None:
    p = tmp_path / "cutout.png"
    im = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    im.paste(Image.new("RGBA", (16, 16), (255, 0, 0, 128)), (8, 8))
    im.save(p)
    assert _image_has_transparency(p) is True


def test_frames_need_webm_mixed(tmp_path: Path) -> None:
    rgb = tmp_path / "rgb.png"
    rgba = tmp_path / "rgba.png"
    Image.new("RGB", (16, 16), (10, 10, 10)).save(rgb)
    im = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    im.save(rgba)
    assert _frames_need_webm([rgb]) is False
    assert _frames_need_webm([rgb, rgba]) is True


@pytest.mark.parametrize(
    "maker,expected_ext",
    [
        ("opaque", "mp4"),
        ("transparent", "webm"),
    ],
)
def test_encode_slideshow_video_auto_format(
    tmp_path: Path, maker: str, expected_ext: str
) -> None:
    p = tmp_path / "frame.png"
    if maker == "opaque":
        Image.new("RGB", (64, 64), (200, 100, 50)).save(p)
    else:
        Image.new("RGBA", (64, 64), (200, 100, 50, 0)).save(p)

    out = tmp_path / "out"
    result = _encode_slideshow_video(
        segments=[(p, None, 2)],
        fps=12.0,
        output_path=out,
    )
    assert result["ext"] == expected_ext
    assert Path(result["absPath"]).is_file()
    assert result["absPath"].endswith(f".{expected_ext}")
    if expected_ext == "webm":
        assert result["mediaType"] == "video/webm"
    else:
        assert result["mediaType"] == "video/mp4"


def test_transparent_timeline_strip_round_trips_alpha_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import timeline_storage
    from ui.api import storage_paths
    from ui.api.timeline_router import _timeline_video_clip_result

    timelines_root = tmp_path / "timelines"
    monkeypatch.setattr(timeline_storage, "TIMELINES_STORAGE_ROOT", timelines_root)
    monkeypatch.setattr(storage_paths, "TIMELINES_STORAGE_ROOT", timelines_root)
    frame_dir = timeline_storage.timeline_frames_dir("timeline-1", "group-1")
    frame_dir.mkdir(parents=True)
    frame = frame_dir / "transparent.png"
    Image.new("RGBA", (64, 64), (200, 100, 50, 0)).save(frame)
    frame_rel = timeline_storage.timeline_abs_to_rel(frame)

    encoded = timeline_frame_sequence_to_video(
        "timeline-1",
        {
            "sequenceGroupId": "group-1",
            "strip": [{"kind": "image", "relPath": frame_rel}],
            "hidden": [],
        },
        fps=12,
        output_basename="transparent-strip",
    )
    webm = Path(encoded["absPath"])
    alpha = webm.with_name(f"{webm.stem}.alpha.mkv")
    result = _timeline_video_clip_result(encoded["absPath"])

    assert webm.suffix == ".webm"
    assert webm.is_file()
    assert alpha.is_file()
    assert encoded["srcRelPath"] == "timelines/timeline-1/clips/transparent-strip.webm"
    assert result["srcRelPath"] == encoded["srcRelPath"]
    assert result["alphaRelPath"] == (
        "timelines/timeline-1/clips/transparent-strip.alpha.mkv"
    )


def test_encode_allows_frames_under_clip_dir_when_sequence_group_mismatches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Gallery seed mints sg_* ids while duplicate_timeline_frame_asset writes under clipId."""
    from services import timeline_storage

    timelines_root = tmp_path / "timelines"
    monkeypatch.setattr(timeline_storage, "TIMELINES_STORAGE_ROOT", timelines_root)
    frame_dir = timeline_storage.timeline_frames_dir("timeline-1", "clip_abc")
    frame_dir.mkdir(parents=True)
    frame = frame_dir / "frame.png"
    Image.new("RGB", (32, 32), (10, 20, 30)).save(frame)
    frame_rel = timeline_storage.timeline_abs_to_rel(frame)

    encoded = timeline_frame_sequence_to_video(
        "timeline-1",
        {
            "sequenceGroupId": "sg_mismatch",
            "strip": [{"kind": "image", "relPath": frame_rel}],
            "hidden": [],
        },
        fps=12,
        output_basename="mismatch-gid",
    )
    assert Path(encoded["absPath"]).is_file()
    assert encoded["srcRelPath"] == "timelines/timeline-1/clips/mismatch-gid.mp4"


def test_encode_rejects_character_strip_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from services import logic, timeline_storage

    timelines_root = tmp_path / "timelines"
    storage_root = tmp_path / "storage"
    storage_root.mkdir()
    monkeypatch.setattr(timeline_storage, "TIMELINES_STORAGE_ROOT", timelines_root)
    monkeypatch.setattr(logic, "DEFAULT_STORAGE_ROOT", storage_root)
    timeline_storage.timeline_frames_root("timeline-1").mkdir(parents=True)

    with pytest.raises(ValueError, match="path outside allowed directory"):
        timeline_frame_sequence_to_video(
            "timeline-1",
            {
                "sequenceGroupId": "sg_any",
                "strip": [
                    {
                        "kind": "image",
                        "relPath": "characters/office1/sequence/seq/gallery/frame.png",
                    }
                ],
                "hidden": [],
            },
            fps=12,
            output_basename="char-strip",
        )
