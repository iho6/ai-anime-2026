"""Auto WebM/MP4 selection and transparency detection for frame slideshow export."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from services.logic import (
    _encode_slideshow_video,
    _frames_need_webm,
    _image_has_transparency,
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
