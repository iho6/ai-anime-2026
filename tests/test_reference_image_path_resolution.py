"""Tests for reference image path resolution (V2Pose Seq /tmp paths)."""

from __future__ import annotations

import base64
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from services.character_storage import DEFAULT_STORAGE_ROOT
from services.logic import _resolve_reference_image_abs, make_reference_keypoint


def test_resolve_absolute_temp_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "frame_00000.png"
        png.write_bytes(b"\x89PNG\r\n\x1a\n")
        resolved = _resolve_reference_image_abs(str(png))
        assert resolved.is_file()
        assert resolved == png.resolve()


def test_nonexistent_absolute_falls_through_to_storage_root() -> None:
    missing = "/tmp/v2pose_test_missing/frame_00000.png"
    assert not Path(missing).is_file()
    resolved = _resolve_reference_image_abs(missing)
    expected = (DEFAULT_STORAGE_ROOT / "tmp/v2pose_test_missing/frame_00000.png").resolve()
    assert resolved == expected
    assert not resolved.is_file()


def test_empty_path_raises() -> None:
    with pytest.raises(ValueError, match="empty"):
        _resolve_reference_image_abs("   ")


def test_make_reference_keypoint_accepts_absolute_temp_png() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "frame_00000.png"
        png.write_bytes(b"\x89PNG\r\n\x1a\n")
        kp_out = Path(tmp) / "kp.png"
        kp_out.write_bytes(b"\x89PNG\r\n\x1a\n")

        with (
            patch("services.logic.run_pose_keypoint_for_image", return_value=str(kp_out)),
            patch("services.reference_storage.add_keypoint_pair") as add_pair,
        ):
            add_pair.return_value = {
                "id": "kp1",
                "referenceRelPath": "references/kp/ref.png",
                "keypointRelPath": "references/kp/kp.png",
            }
            entry = make_reference_keypoint(str(png))
            assert entry["id"] == "kp1"
            add_pair.assert_called_once()
            call_ref_abs = add_pair.call_args[0][0]
            assert Path(call_ref_abs).resolve() == png.resolve()


def test_process_v2pose_frame_does_not_fail_path_resolution() -> None:
    from services.motion_ref_pose_batch import process_v2pose_frame

    png_bytes = b"\x89PNG\r\n\x1a\n"
    b64 = base64.b64encode(png_bytes).decode("ascii")

    with (
        patch("services.reference_storage.get_keypoints_layout") as layout,
        patch("services.logic.make_reference_keypoint") as mk_kp,
        patch("services.reference_storage.assign_keypoints_to_folder"),
    ):
        layout.return_value = {"folders": [{"id": "folder1"}]}
        mk_kp.return_value = {
            "id": "kp1",
            "referenceRelPath": "references/kp/ref.png",
            "keypointRelPath": "references/kp/kp.png",
        }
        item = process_v2pose_frame(
            "folder1",
            {"frameIndex": 0, "pngBase64": b64},
        )
        assert item["frameIndex"] == 0
        mk_kp.assert_called_once()
        passed_path = mk_kp.call_args[0][0]
        assert Path(passed_path).is_file()
        assert passed_path.endswith("frame_00000.png")
