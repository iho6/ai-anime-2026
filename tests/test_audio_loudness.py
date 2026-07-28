"""Tests for EBU R128 loudness analysis and normalization gain."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from services.audio_loudness import (
    MAX_NORMALIZATION_GAIN,
    MIN_NORMALIZATION_GAIN,
    TARGET_LUFS,
    analyze_normalization_gain,
    measure_integrated_lufs,
    normalization_gain_for_lufs,
)


def test_gain_math_toward_target():
    # 6 dB below target -> ~2x boost (clamped exactly at 2).
    assert normalization_gain_for_lufs(-20.0) == pytest.approx(
        10 ** ((TARGET_LUFS + 20.0) / 20.0)
    )
    # 6 dB above target -> ~0.5x cut.
    assert normalization_gain_for_lufs(-8.0) == pytest.approx(0.501, abs=0.01)
    # At target -> unity.
    assert normalization_gain_for_lufs(TARGET_LUFS) == pytest.approx(1.0)


def test_gain_clamps():
    assert normalization_gain_for_lufs(-60.0) == MAX_NORMALIZATION_GAIN
    assert normalization_gain_for_lufs(20.0) == MIN_NORMALIZATION_GAIN


def test_measure_missing_file_returns_none(tmp_path: Path):
    assert measure_integrated_lufs(tmp_path / "nope.wav") is None
    assert analyze_normalization_gain(tmp_path / "nope.wav") == 1.0


def _write_sine_wav(path: Path, *, seconds: float = 2.0, amplitude: float = 0.1) -> None:
    import av

    rate = 48000
    n = int(rate * seconds)
    t = np.arange(n, dtype=np.float64) / rate
    samples = (amplitude * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
    with av.open(str(path), mode="w") as container:
        stream = container.add_stream("pcm_s16le", rate=rate)
        stream.layout = "mono"
        frame = av.AudioFrame.from_ndarray(
            samples.reshape(1, -1), format="fltp", layout="mono"
        )
        frame.sample_rate = rate
        for pkt in stream.encode(frame):
            container.mux(pkt)
        for pkt in stream.encode(None):
            container.mux(pkt)


def _ffmpeg_available() -> bool:
    try:
        from utils.video_utils import require_ffmpeg

        require_ffmpeg()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _ffmpeg_available(), reason="ffmpeg not on PATH")
def test_measure_and_analyze_real_audio(tmp_path: Path):
    wav = tmp_path / "tone.wav"
    _write_sine_wav(wav)

    lufs = measure_integrated_lufs(wav)
    assert lufs is not None
    # A -20 dBFS sine lands far below streaming loudness targets.
    assert -60.0 < lufs < -5.0

    gain = analyze_normalization_gain(wav)
    assert MIN_NORMALIZATION_GAIN <= gain <= MAX_NORMALIZATION_GAIN
    # Quiet tone must be boosted.
    assert gain > 1.0
