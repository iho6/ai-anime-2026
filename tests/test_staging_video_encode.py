"""Staging encode helpers for motion-ref V2Pose video keypoint path."""

from __future__ import annotations

import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

from services.logic import write_frames_video_from_rel_paths
from ui.api.preview_storage import (
    save_staging_encoded_video,
    staging_video_output_stem,
)


class StagingVideoEncodeTests(unittest.TestCase):
    def _patch_character(self, base_dir: Path) -> None:
        base_dir.mkdir(parents=True, exist_ok=True)
        paths = SimpleNamespace(character_dir=base_dir)
        self.patch_get_paths = patch(
            "ui.api.preview_storage.logic.get_character_paths",
            return_value=paths,
        )
        self.patch_ensure = patch(
            "ui.api.preview_storage.ensure_path_under_character",
            return_value=None,
        )
        self.patch_rel = patch(
            "ui.api.preview_storage.storage_rel_from_abs",
            side_effect=lambda p: f"chars/test/.react_staging/{Path(p).name}",
        )
        self.patch_get_paths.start()
        self.patch_ensure.start()
        self.patch_rel.start()

    def tearDown(self) -> None:
        for name in ("patch_get_paths", "patch_ensure", "patch_rel"):
            p = getattr(self, name, None)
            if p is not None:
                p.stop()

    def test_staging_video_output_stem_under_react_staging(self) -> None:
        with self.subTest("stem path"):
            char_dir = Path(self._testMethodName) / "hero"
            self._patch_character(char_dir)
            stem = staging_video_output_stem("hero")
            self.assertEqual(stem.parent, char_dir / ".react_staging")
            self.assertTrue(stem.name.startswith("motion_vid_"))

    def test_save_staging_encoded_video_missing_raises(self) -> None:
        char_dir = Path(self._testMethodName) / "hero"
        self._patch_character(char_dir)
        with self.assertRaises(ValueError):
            save_staging_encoded_video("hero", str(char_dir / "nope.mp4"))

    def test_write_frames_video_from_rel_paths_empty_raises(self) -> None:
        with self.assertRaises(ValueError):
            write_frames_video_from_rel_paths([], 24, "/tmp/out")

    def test_staging_encode_roundtrip(self) -> None:
        char_dir = Path(self._testMethodName) / "hero"
        staging = char_dir / ".react_staging"
        staging.mkdir(parents=True)
        frame = staging / "frame.png"
        Image.new("RGB", (32, 32), (40, 80, 120)).save(frame)

        with patch(
            "services.logic._resolve_storage_rel_file_for_export",
            side_effect=lambda rel: staging / Path(rel).name,
        ):
            self._patch_character(char_dir)
            out_stem = staging_video_output_stem("hero")
            result = write_frames_video_from_rel_paths([str(frame)], 12.0, out_stem)
            video_rel = save_staging_encoded_video("hero", result["absPath"])
            self.assertTrue(video_rel.endswith(f".{result['ext']}"))
            self.assertTrue(Path(result["absPath"]).is_file())


if __name__ == "__main__":
    unittest.main()
