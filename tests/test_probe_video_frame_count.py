"""Unit tests for video frame-count probing (WebM VP9+alpha metadata gaps)."""

from __future__ import annotations

import os
import tempfile

import numpy as np
import pytest

from services.logic import encode_rgba_frames_to_webm, probe_video_fps_and_frame_count


def test_probe_webm_frame_count_after_encode() -> None:
    pytest.importorskip("av")

    frames = [
        np.zeros((32, 32, 4), dtype=np.uint8),
        np.full((32, 32, 4), 128, dtype=np.uint8),
        np.full((32, 32, 4), 255, dtype=np.uint8),
    ]
    for arr in frames:
        arr[:, :, 3] = 255

    fd, path = tempfile.mkstemp(suffix=".webm")
    os.close(fd)
    try:
        meta = encode_rgba_frames_to_webm(
            frames,
            fps=12.0,
            width=32,
            height=32,
            output_path=path,
        )
        assert meta["frames"] == 3

        fps, total = probe_video_fps_and_frame_count(path)
        assert fps > 0
        assert total == 3
    finally:
        os.remove(path)
