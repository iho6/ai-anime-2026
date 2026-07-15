"""Duration-preserving keyframed RMBG / anime-seg video background removal."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest
from PIL import Image

from services.logic import (
    _decoded_rgba_frame_holds,
    _keyframed_rgba_sequence,
    probe_video_fps_and_frame_count,
    remove_video_background_anime_seg,
    remove_video_background_rmbg,
)
from services.utils import (
    VideoFrameSampler,
    av_output_framerate,
    av_stream_time_base,
    video_sample_indices,
)
from ui.api.timeline_router import _process_every_frame_from_message


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
    # A skipped source slot holds the complete processed frame, not current RGB
    # combined with stale alpha.
    assert out[1][0, 0, 0] == 0
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


@pytest.mark.parametrize(
    ("source_fps", "frame_count", "expected"),
    [
        (10.0, 10, list(range(10))),
        (12.0, 12, list(range(12))),
        (24.0, 24, list(range(0, 24, 2))),
        (30.0, 30, [0, 3, 5, 8, 10, 13, 15, 18, 20, 23, 25, 28]),
    ],
)
def test_video_sample_indices_are_time_based(
    source_fps: float, frame_count: int, expected: list[int]
) -> None:
    assert video_sample_indices(frame_count, source_fps) == expected


def test_video_sampler_prefers_valid_pts() -> None:
    sampler = VideoFrameSampler(30.0)
    # Deliberately irregular timestamps: selection follows media time, not index.
    times = [0.0, 0.02, 0.09, 0.10, 0.17]
    selected = [
        i
        for i, pts_time in enumerate(times)
        if sampler.should_sample(i, pts=int(pts_time * 1000), time_base=1 / 1000)
    ]
    assert selected == [0, 2, 4]


def test_process_every_frame_api_option_and_legacy_fallback() -> None:
    assert _process_every_frame_from_message({"processEveryFrame": True})
    assert not _process_every_frame_from_message(
        {"processEveryFrame": False, "outputFps24": True, "recycleMask": True}
    )
    assert _process_every_frame_from_message({"outputFps24": True})
    assert not _process_every_frame_from_message({"recycleMask": True})


def test_streaming_holds_full_rgba_and_skips_rgb_conversion() -> None:
    class FakeFrame:
        def __init__(self, index: int) -> None:
            self.index = index
            self.pts = index
            self.time_base = 1 / 24
            self.converted = False

        def to_ndarray(self, *, format: str) -> np.ndarray:
            assert format == "rgb24"
            self.converted = True
            return np.full((2, 2, 3), self.index * 10, dtype=np.uint8)

    frames = [FakeFrame(i) for i in range(5)]

    def process(rgb: np.ndarray, i: int) -> np.ndarray:
        return np.dstack([rgb, np.full((2, 2), 100 + i, dtype=np.uint8)])

    out = list(
        _decoded_rgba_frame_holds(
            frames,
            source_fps=24.0,
            process_every_frame=False,
            process_frame=process,
        )
    )
    assert [f.converted for f in frames] == [True, False, True, False, True]
    assert out[1][0, 0].tolist() == out[0][0, 0].tolist()
    assert out[3][0, 0].tolist() == out[2][0, 0].tolist()


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


@pytest.mark.parametrize(
    "source_fps,n_frames", [(30.0, 30), (24.0, 24), (12.0, 12)]
)
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

    expected_rmbg = len(video_sample_indices(n_frames, source_fps))
    assert mock_rmbg.call_count == expected_rmbg

    assert meta["frames"] == n_frames
    assert meta["fps"] == pytest.approx(source_fps, rel=0.05)
    assert meta["durationSec"] == pytest.approx(n_frames / source_fps, rel=0.05)

    out_fps, out_count = probe_video_fps_and_frame_count(out)
    assert out_count == n_frames
    assert out_fps == pytest.approx(source_fps, rel=0.05)
    alpha = out.with_name(f"{out.stem}.alpha.mkv")
    alpha_fps, alpha_count = probe_video_fps_and_frame_count(alpha)
    assert alpha_count == out_count
    assert alpha_fps == pytest.approx(out_fps, rel=0.05)


def test_remove_video_background_anime_seg_uses_same_full_frame_holds(
    tmp_path: Path,
) -> None:
    pytest.importorskip("av")
    src = tmp_path / "anime_in.mp4"
    out = tmp_path / "anime_out.webm"
    _write_test_mp4(src, n_frames=10, fps=30.0)

    with patch(
        "services.logic.remove_anime_seg_to_temp_file",
        side_effect=_fake_rmbg,
    ) as mock_seg:
        meta = remove_video_background_anime_seg(src, out)

    assert mock_seg.call_count == len(video_sample_indices(10, 30.0))
    assert meta["frames"] == 10
    out_fps, out_count = probe_video_fps_and_frame_count(out)
    assert out_count == 10
    assert out_fps == pytest.approx(30.0, rel=0.05)
    alpha = out.with_name(f"{out.stem}.alpha.mkv")
    _alpha_fps, alpha_count = probe_video_fps_and_frame_count(alpha)
    assert alpha_count == out_count
