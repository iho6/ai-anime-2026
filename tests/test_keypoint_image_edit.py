"""Tests for keypoint image-edit routing (full identity + cropped keypoint aux)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from services import logic


def test_run_keypoint_image_edit_with_plate_uses_full_primary_and_cropped_aux(
    tmp_path: Path,
) -> None:
    from PIL import Image as PILImage

    identity = tmp_path / "identity.png"
    keypoint = tmp_path / "keypoint.png"
    PILImage.new("RGB", (400, 200), (255, 255, 255)).save(identity)
    PILImage.new("RGB", (400, 200), (0, 0, 0)).save(keypoint)

    placed = {
        "canvas": {"width": 800, "height": 400},
        "placement": {"x": 100, "y": 50, "width": 200, "height": 200},
        "workingSquareSize": 1024,
    }

    from PIL import Image as PILImage

    captured_argv: list[str] = []

    def fake_run(module: str, argv: list[str], log_cb=None) -> dict:
        _ = module, log_cb
        captured_argv[:] = argv
        qwen_out = tmp_path / "qwen_fake.png"
        PILImage.new("RGB", (64, 64), (10, 20, 30)).save(qwen_out)
        return {"results": [{"url": str(qwen_out)}]}

    with patch.object(logic, "_run_service_testmode", side_effect=fake_run):
        plate_path, _square_meta = logic._run_keypoint_image_edit_with_plate(
            "test_char",
            str(identity),
            str(keypoint),
            placed,
            "test prompt",
        )

    assert Path(plate_path).is_file()
    assert "--image-url" in captured_argv
    primary_idx = captured_argv.index("--image-url") + 1
    assert captured_argv[primary_idx] == str(identity)
    assert "primary_square" not in " ".join(captured_argv)

    aux_idx = captured_argv.index("--auxiliary-image-urls-json") + 1
    aux_urls = json.loads(captured_argv[aux_idx])
    assert aux_urls[-1].endswith("kp_square.png")
    assert str(keypoint) not in aux_urls[-1] or aux_urls[-1] != str(keypoint)


def test_keypoint_crop_abs_for_placed_figure_extracts(tmp_path: Path) -> None:
    from PIL import Image

    keypoint = tmp_path / "wide_kp.png"
    im = Image.new("RGB", (400, 200), (0, 0, 0))
    im.save(keypoint)

    placed = {
        "placement": {"x": 50, "y": 20, "width": 100, "height": 100},
        "workingSquareSize": 1024,
    }
    crop_path, source = logic._keypoint_crop_abs_for_placed_figure(
        str(keypoint), placed, tmp_path / "work"
    )
    assert source == "extracted"
    assert crop_path.is_file()
    assert crop_path.stat().st_size > 0
