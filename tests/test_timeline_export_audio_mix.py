"""Tests for timeline export audio mix (WinError 206 filtergraph path)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from services.timeline_export import (
    UNITY_VOLUME_LEVEL,
    _mix_timeline_audio,
    _volume_envelope_filter_parts,
)


def _clip_with_volume_automation(*, out_point: float = 10.0) -> dict:
    return {
        "type": "audio",
        "srcRelPath": "timelines/T/a.wav",
        "start": 0.0,
        "duration": out_point,
        "inPoint": 0.0,
        "outPoint": out_point,
        "speed": 1.0,
        "volumeAutomation": {
            "points": [
                {"t": 0.0, "level": UNITY_VOLUME_LEVEL},
                {"t": 0.5, "level": 25.0},
                {"t": 1.0, "level": UNITY_VOLUME_LEVEL},
            ]
        },
    }


def test_volume_envelope_uses_0_1_second_step():
    clip = _clip_with_volume_automation(out_point=10.0)
    parts = _volume_envelope_filter_parts(clip, "pre", "out")
    # 10s / 0.1s ≈ 100 segments (not 500 from the old 0.02s step).
    assert 95 <= len(parts) <= 105
    assert all("volume=volume=" in p for p in parts)


def test_mix_timeline_audio_uses_filter_complex_script(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    audio_file = tmp_path / "a.wav"
    audio_file.write_bytes(b"RIFF....")  # path must exist for resolve stub
    output_aac = tmp_path / "mixed.aac"
    captured: dict = {}

    def fake_run(cmd, check=True, capture_output=True):
        captured["cmd"] = list(cmd)
        output_aac.write_bytes(b"aac")
        return MagicMock(returncode=0)

    monkeypatch.setattr(
        "services.timeline_export._collect_audio_clips",
        lambda _m: [_clip_with_volume_automation(out_point=2.0)],
    )
    monkeypatch.setattr(
        "services.timeline_export._resolve_storage_rel_file",
        lambda _rel: audio_file,
    )
    monkeypatch.setattr(
        "services.timeline_export._require_ffmpeg",
        lambda: "ffmpeg",
    )
    monkeypatch.setattr("services.timeline_export.subprocess.run", fake_run)

    ok = _mix_timeline_audio({"tracks": []}, duration_sec=2.0, output_aac=output_aac, log_cb=None)
    assert ok is True
    cmd = captured["cmd"]
    assert "-filter_complex" not in cmd
    assert "-filter_complex_script" in cmd
    script_idx = cmd.index("-filter_complex_script") + 1
    script_path = Path(cmd[script_idx])
    assert script_path.is_file()
    text = script_path.read_text(encoding="utf-8")
    assert "amix=inputs=1" in text
    assert "[aout]" in text
