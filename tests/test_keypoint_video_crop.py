"""Cropped-video keypoint path with per-frame placement."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from services import reference_storage
from services.figure_crop import (
    paste_working_keypoint_onto_canvas,
    placed_figure_from_crop_meta,
)
from services.logic import make_reference_keypoint_video_from_staged_frames
from services.motion_ref_pose_batch import _placed_figure_from_frame


class PlacedFigureFromCropMetaTests(unittest.TestCase):
    def test_builds_full_meta_with_canvas(self) -> None:
        pf = placed_figure_from_crop_meta(
            {"x": 40, "y": 60, "width": 200, "height": 200},
            800,
            600,
        )
        self.assertIsNotNone(pf)
        assert pf is not None
        self.assertEqual(pf["canvas"], {"width": 800, "height": 600})
        self.assertIn("placement", pf)
        self.assertEqual(pf.get("workingSquareSize"), 1024)

    def test_motion_ref_frame_helper_matches(self) -> None:
        fr = {
            "cropBox": {"x": 10, "y": 20, "width": 100, "height": 100},
            "imageWidth": 640,
            "imageHeight": 480,
        }
        direct = placed_figure_from_crop_meta(fr["cropBox"], 640, 480)
        via_batch = _placed_figure_from_frame(fr)
        self.assertEqual(direct, via_batch)

    def test_missing_crop_returns_none(self) -> None:
        self.assertIsNone(placed_figure_from_crop_meta(None, 100, 100))


class PasteWorkingKeypointTests(unittest.TestCase):
    def test_pastes_square_at_placement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            square = Path(tmp) / "sq.png"
            Image.new("RGB", (1024, 1024), (255, 0, 0)).save(square)
            pf = placed_figure_from_crop_meta(
                {"x": 100, "y": 80, "width": 200, "height": 200},
                640,
                480,
            )
            assert pf is not None
            out = paste_working_keypoint_onto_canvas(square, pf, dest_path=Path(tmp) / "out.png")
            with Image.open(out) as im:
                self.assertEqual(im.size, (640, 480))
                px = im.getpixel((150, 130))
                self.assertGreater(px[0], 200)


class FindPlacedFigureTests(unittest.TestCase):
    def test_finds_on_video_strip_slot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            refs_root = Path(tmp) / "references"
            kp_path = refs_root / "keypoints_video" / "kv_test" / "kp" / "frame_000001.png"
            kp_path.parent.mkdir(parents=True)
            Image.new("RGB", (640, 480), (0, 0, 0)).save(kp_path)
            pf = placed_figure_from_crop_meta(
                {"x": 0, "y": 0, "width": 200, "height": 200},
                640,
                480,
            )
            rel = f"references/keypoints_video/kv_test/kp/frame_000001.png"
            entry = {
                "id": "kv_test",
                "videoRelPath": "references/keypoints_video/kv_test/source.mp4",
                "fps": 24,
                "frameSequence": {
                    "sequenceGroupId": "sg1",
                    "strip": [
                        {
                            "kind": "image",
                            "relPath": rel,
                            "referenceRelPath": rel.replace("/kp/", "/ref/"),
                            "placedFigure": pf,
                        }
                    ],
                    "hidden": [],
                },
            }
            with patch(
                "services.reference_storage.REFERENCES_STORAGE_ROOT",
                refs_root,
            ), patch(
                "services.reference_storage.list_keypoint_videos",
                return_value=[entry],
            ):
                found = reference_storage.find_placed_figure_for_keypoint_abs(str(kp_path))
            self.assertEqual(found, pf)


class AddKeypointVideoPlacedFigureTests(unittest.TestCase):
    def test_strip_slots_include_placed_figure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            refs_root = Path(tmp) / "references"
            refs_root.mkdir()
            video = Path(tmp) / "source.mp4"
            ref_p = Path(tmp) / "ref.png"
            kp_p = Path(tmp) / "kp.png"
            Image.new("RGB", (64, 64), (1, 2, 3)).save(ref_p)
            Image.new("RGB", (64, 64), (4, 5, 6)).save(kp_p)
            video.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
            pf = placed_figure_from_crop_meta(
                {"x": 0, "y": 0, "width": 64, "height": 64},
                64,
                64,
            )
            with patch(
                "services.reference_storage.REFERENCES_STORAGE_ROOT",
                refs_root,
            ), patch(
                "services.reference_storage.list_keypoints",
                return_value=[],
            ), patch(
                "services.reference_storage._sync_ui_layout_with_keypoints",
                return_value={"rootOrder": [], "folders": [], "folderOrder": {}},
            ), patch(
                "services.reference_storage._write_ui_layout",
            ):
                entry = reference_storage.add_keypoint_video(
                    str(video),
                    [str(ref_p)],
                    [str(kp_p)],
                    fps=12,
                    placed_figures=[pf],
                )
            strip = entry["frameSequence"]["strip"]
            self.assertEqual(len(strip), 1)
            self.assertIn("placedFigure", strip[0])
            self.assertEqual(strip[0]["placedFigure"]["canvas"], {"width": 64, "height": 64})


class StagedFramesPipelineTests(unittest.TestCase):
    def test_make_reference_keypoint_video_from_staged_frames(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            refs_root = Path(tmp) / "references"
            refs_root.mkdir()
            staging = Path(tmp) / "staging"
            staging.mkdir()
            frame = staging / "frame_00000.png"
            Image.new("RGB", (320, 240), (30, 60, 90)).save(frame)
            rel = "chars/hero/.react_staging/frame_00000.png"
            meta = [
                {
                    "cropBox": {"x": 40, "y": 30, "width": 160, "height": 160},
                    "imageWidth": 320,
                    "imageHeight": 240,
                }
            ]

            def fake_kp_video(_video_abs: str, log_cb=None) -> list[str]:
                out = Path(tmp) / "kp_sq.png"
                Image.new("RGB", (1024, 1024), (255, 128, 0)).save(out)
                return [str(out)]

            captured: dict[str, object] = {}

            def capture_add_keypoint_video(
                video_abs: str,
                ref_frame_paths: list[str],
                kp_frame_paths: list[str],
                *,
                fps: int = 24,
                placed_figures=None,
            ) -> dict:
                captured["video_abs"] = video_abs
                captured["ref_paths"] = ref_frame_paths
                captured["kp_paths"] = kp_frame_paths
                captured["placed_figures"] = placed_figures
                captured["fps"] = fps
                with Image.open(kp_frame_paths[0]) as kp_im:
                    captured["kp_size"] = kp_im.size
                return {
                    "id": "kv_mock",
                    "videoRelPath": "references/keypoints_video/kv_mock/source.mp4",
                    "fps": fps,
                    "frameSequence": {
                        "sequenceGroupId": "sg",
                        "strip": [
                            {
                                "kind": "image",
                                "relPath": "references/keypoints_video/kv_mock/kp/frame_000001.png",
                                "referenceRelPath": "references/keypoints_video/kv_mock/ref/frame_000001.png",
                                "placedFigure": placed_figures[0] if placed_figures else None,
                            }
                        ],
                        "hidden": [],
                    },
                }

            def fake_encode(abs_paths, fps, output_path):
                out = Path(str(output_path))
                if out.suffix.lower() not in (".mp4", ".webm"):
                    out = out.with_suffix(".mp4")
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
                return {"absPath": str(out), "ext": "mp4", "fps": fps, "frameCount": len(abs_paths)}

            with patch(
                "services.logic.resolve_storage_rel_path_to_abs",
                return_value=frame,
            ), patch(
                "services.logic.write_frames_video_from_abs_paths",
                side_effect=fake_encode,
            ), patch(
                "services.logic.run_pose_keypoint_for_video_frames",
                side_effect=fake_kp_video,
            ), patch(
                "services.reference_storage.add_keypoint_video",
                side_effect=capture_add_keypoint_video,
            ):
                entry = make_reference_keypoint_video_from_staged_frames(
                    [rel],
                    meta,
                    fps=12,
                )

            self.assertEqual(entry["id"], "kv_mock")
            self.assertEqual(captured["fps"], 12)
            self.assertEqual(captured["kp_size"], (320, 240))
            pfs = captured["placed_figures"]
            assert isinstance(pfs, list) and len(pfs) == 1
            self.assertEqual(pfs[0]["canvas"], {"width": 320, "height": 240})


if __name__ == "__main__":
    unittest.main()
