"""Duration-preserving keyframed RMBG / anime-seg video background removal."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest
from PIL import Image

from services.logic import (
    _keyframed_rgba_sequence,
    probe_video_fps_and_frame_count,
    remove_video_background_rmbg,
)
from services.utils import av_output_framerate, av_stream_time_base, video_subsample_stride


def test_keyframed_rgba_sequence_preserves_frame_count() -> None:
    n = 10
    stride = 2
    all_rgb = [np.full((4, 4, 3), i * 20, dtype=np.uint8) for i in range(n)]
    calls: list[int] = []

    def process(rgb: np.ndarray, i: int) -> np.ndarray:
        calls.append(i)
        rgba = np.zeros((4, 4, 4), dtype=np.uint8)
        rgba[:, :, :3] = rgb
        rgba[:, :, 3] = 100 + i
        return rgba

    out = _keyframed_rgba_sequence(
        all_rgb,
        stride=stride,
        process_every_frame=False,
        process_frame=process,
    )
    assert len(out) == n
    assert calls == [0, 2, 4, 6, 8]
    assert out[1][0, 0, 0] == 20
    assert out[1][0, 0, 3] == 100


def test_keyframed_rgba_sequence_every_frame() -> None:
    n = 5
    all_rgb = [np.zeros((2, 2, 3), dtype=np.uint8) for _ in range(n)]
    calls: list[int] = []

    def process(rgb: np.ndarray, i: int) -> np.ndarray:
        calls.append(i)
        return np.dstack([rgb, np.full((2, 2), 255, dtype=np.uint8)])

    out = _keyframed_rgba_sequence(
        all_rgb,
        stride=2,
        process_every_frame=True,
        process_frame=process,
    )
    assert len(out) == n
    assert calls == list(range(n))


def _write_test_mp4(path: Path, *, n_frames: int, fps: float) -> None:
    av = pytest.importorskip("av")

    rate = av_output_framerate(fps)
    tb = av_stream_time_base(rate)
    with av.open(str(path), mode="w", format="mp4") as container:
        stream = container.add_stream("libx264", rate=rate)
        stream.width = 32
        stream.height = 32
        stream.pix_fmt = "yuv420p"
        stream.time_base = tb
        for i in range(n_frames):
            rgb = np.full((32, 32, 3), i * 8, dtype=np.uint8)
            frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
            frame.pts = i
            frame.time_base = tb
            for pkt in stream.encode(frame):
                container.mux(pkt)
        for pkt in stream.encode(None):
            container.mux(pkt)


def _fake_rmbg(src_path: str, **kwargs: object) -> str:
    with Image.open(src_path) as im:
        rgb = np.asarray(im.convert("RGB"))
    rgba = np.dstack([rgb, np.full(rgb.shape[:2], 200, dtype=np.uint8)])
    out = Path(src_path).with_suffix(".rgba.png")
    Image.fromarray(rgba, "RGBA").save(out)
    return str(out)


@pytest.mark.parametrize("source_fps,n_frames", [(24.0, 24), (12.0, 12)])
def test_remove_video_background_rmbg_default_preserves_duration(
    tmp_path: Path, source_fps: float, n_frames: int
) -> None:
    pytest.importorskip("av")

    src = tmp_path / "in.mp4"
    out = tmp_path / "out.webm"
    _write_test_mp4(src, n_frames=n_frames, fps=source_fps)

    with patch(
        "services.logic.remove_background_to_temp_file",
        side_effect=_fake_rmbg,
    ) as mock_rmbg:
        meta = remove_video_background_rmbg(src, out)

    stride = video_subsample_stride(source_fps, 12.0)
    expected_rmbg = sum(1 for i in range(n_frames) if i % stride == 0)
    assert mock_rmbg.call_count == expected_rmbg

    assert meta["frames"] == n_frames
    assert meta["fps"] == pytest.approx(source_fps, rel=0.05)
    assert meta["durationSec"] == pytest.approx(n_frames / source_fps, rel=0.05)

    out_fps, out_count = probe_video_fps_and_frame_count(out)
    assert out_count == n_frames
    assert out_fps == pytest.approx(source_fps, rel=0.05)
