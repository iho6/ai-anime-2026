"""Timeline video bg-remove result timing and frame extract hygiene."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from ui.api.timeline_router import _timeline_video_clip_result


def test_timeline_video_clip_result_prefers_frame_derived_duration(tmp_path: Path) -> None:
    webm = tmp_path / "clip_rmbg.webm"
    webm.write_bytes(b"\x00")
    result = _timeline_video_clip_result(
        str(webm),
        durationSec=0.875,
        fps=24.0,
        frames=129,
        width=1080,
        height=1080,
    )
    assert result["durationSec"] == 5.375
    assert result["frames"] == 129


def test_timeline_video_clip_result_probes_when_duration_missing(tmp_path: Path) -> None:
    webm = tmp_path / "clip_rmbg.webm"
    webm.write_bytes(b"\x00")
    with patch("ui.api.timeline_router.logic.probe_video_meta") as probe_meta:
        probe_meta.return_value = {
            "durationSec": 0.875,
            "fps": 24.0,
            "frames": 0,
            "width": 1080,
            "height": 1080,
        }
        with patch(
            "ui.api.timeline_router.logic.probe_video_fps_and_frame_count"
        ) as probe_count:
            probe_count.return_value = (24.0, 129)
            result = _timeline_video_clip_result(
                str(webm),
                durationSec=0.0,
                fps=24.0,
                frames=0,
                width=1080,
                height=1080,
            )
    assert result["durationSec"] == 5.375
    assert result["frames"] == 129


def test_frame_extract_prunes_orphan_pngs(tmp_path: Path) -> None:
    from services import timeline_storage
    from services.logic import timeline_video_to_frame_sequence

    timeline_key = "Test_Timing"
    clip_id = "clip_test"
    frames_dir = timeline_storage.timeline_frames_dir(timeline_key, clip_id)
    frames_dir.mkdir(parents=True, exist_ok=True)
    for i in range(1, 130):
        (frames_dir / f"frame_{i:06d}.png").write_bytes(b"png")

    clips_dir = timeline_storage.timeline_clips_dir(timeline_key)
    clips_dir.mkdir(parents=True, exist_ok=True)
    video = clips_dir / "source.webm"
    video.write_bytes(b"\x00")

    with patch("services.logic.probe_video_fps_and_frame_count", return_value=(24.0, 21)):
        with patch(
            "services.utils.extract_video_frames_range_to_rgba_pngs",
            return_value=[str(frames_dir / f"frame_{i:06d}.png") for i in range(1, 22)],
        ):
            out = timeline_video_to_frame_sequence(
                timeline_key,
                clip_id,
                timeline_storage.timeline_abs_to_rel(video),
                in_point_sec=0.0,
                out_point_sec=0.875,
            )

    assert len(out["frameSequence"]["strip"]) == 21
    remaining = list(frames_dir.glob("frame_*.png"))
    assert len(remaining) == 21
    assert all(p.name <= "frame_000021.png" for p in remaining)
