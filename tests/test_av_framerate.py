"""Unit tests for PyAV-compatible output framerate normalization."""

from __future__ import annotations

import os
import tempfile
from fractions import Fraction

import numpy as np
import pytest

from services.utils import av_output_framerate, av_stream_time_base


class _MockRational:
    def __init__(self, numerator: int, denominator: int) -> None:
        self.numerator = numerator
        self.denominator = denominator


def test_float_framerate_becomes_millisecond_fraction() -> None:
    assert av_output_framerate(24.0) == Fraction(24000, 1000)


def test_int_framerate_becomes_millisecond_fraction() -> None:
    assert av_output_framerate(30) == Fraction(30000, 1000)


def test_none_uses_default_24fps() -> None:
    assert av_output_framerate(None) == Fraction(24, 1)


def test_fraction_passes_through() -> None:
    rate = Fraction(30000, 1001)
    assert av_output_framerate(rate) == rate


def test_rational_with_numerator_denominator_passes_through() -> None:
    assert av_output_framerate(_MockRational(24, 1)) == Fraction(24, 1)


def test_av_stream_time_base_from_float() -> None:
    assert av_stream_time_base(24.0) == Fraction(1, 24)


def test_vp9_yuva420p_encode_with_explicit_time_base() -> None:
    """Smoke test: codec_context.time_base is None before first encode on PyAV 14+."""
    av = pytest.importorskip("av")

    out_rate = av_output_framerate(24.0)
    tb = av_stream_time_base(out_rate)
    fd, path = tempfile.mkstemp(suffix=".webm")
    os.close(fd)
    try:
        rgba = np.zeros((64, 64, 4), dtype=np.uint8)
        rgba[:, :, 3] = 255
        with av.open(path, mode="w", format="webm") as container:
            stream = container.add_stream("libvpx-vp9", rate=out_rate)
            stream.time_base = tb
            stream.width = 64
            stream.height = 64
            stream.pix_fmt = "yuva420p"
            stream.options = {
                "crf": "10",
                "b:v": "0",
                "deadline": "realtime",
                "cpu-used": "8",
                "auto-alt-ref": "0",
            }
            frame = av.VideoFrame.from_ndarray(rgba, format="rgba")
            frame = frame.reformat(format="yuva420p")
            frame.pts = 0
            frame.time_base = tb
            for pkt in stream.encode(frame):
                container.mux(pkt)
            for pkt in stream.encode(None):
                container.mux(pkt)
        assert os.path.getsize(path) > 0
    finally:
        os.remove(path)
