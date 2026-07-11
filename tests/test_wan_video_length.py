"""Wan 2.2 I2V / FLF length normalization and timeline encode fps."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from PIL import Image

from services.constant import WAN_VIDEO_DEFAULT_LENGTH, WAN_VIDEO_FPS, WAN_VIDEO_MAX_LENGTH
from services.logic import encode_frames_to_mp4, normalize_wan_video_length, probe_video_meta


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (121, 121),
        (129, 121),
        (33, 33),
        (25, 25),
        (24, 25),
        (200, 121),
        (1, 25),
        (127, 121),
    ],
)
def test_normalize_wan_video_length(raw: int, expected: int) -> None:
    assert normalize_wan_video_length(raw) == expected


def test_wan_default_is_model_max() -> None:
    assert WAN_VIDEO_DEFAULT_LENGTH == WAN_VIDEO_MAX_LENGTH == 121


def test_wan_max_duration_at_model_fps() -> None:
    assert WAN_VIDEO_MAX_LENGTH / WAN_VIDEO_FPS == pytest.approx(7.5625, rel=1e-4)


def test_timeline_encode_121_frames_at_16fps() -> None:
    pytest.importorskip("av")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        frames = []
        for i in range(121):
            fp = tmp_path / f"frame_{i:04d}.png"
            Image.new("RGB", (64, 64), color=(i % 256, 0, 0)).save(fp)
            frames.append(fp)
        out = tmp_path / "clip.mp4"
        encode_frames_to_mp4(frames, out, fps=WAN_VIDEO_FPS)
        meta = probe_video_meta(out)
        assert meta["durationSec"] == pytest.approx(121 / WAN_VIDEO_FPS, rel=0.02)
