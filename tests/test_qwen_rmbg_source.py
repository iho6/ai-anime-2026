"""HD Qwen source resolution and RMBG compositing tests."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

from services import logic
from services.figure_crop import composite_rgba_on_transparent_canvas, qwen_sidecar_path


def test_qwen_sidecar_path_naming() -> None:
    assert qwen_sidecar_path("/tmp/frame_001.png") == Path("/tmp/frame_001_qwen.png")


def test_persist_qwen_sidecar_for_plate(tmp_path: Path) -> None:
    plate = tmp_path / "frame_001.png"
    Image.new("RGB", (100, 80), (255, 255, 255)).save(plate)
    qwen_tmp = tmp_path / "native_qwen.png"
    Image.new("RGB", (128, 128), (10, 20, 30)).save(qwen_tmp)

    meta = logic._persist_qwen_sidecar_for_plate(
        plate,
        {
            "canvas": {"width": 100, "height": 80},
            "placement": {"x": 0, "y": 0, "width": 50, "height": 50},
            "_qwenTmpPath": str(qwen_tmp),
        },
        storage_root=tmp_path,
    )
    sidecar = qwen_sidecar_path(plate)
    assert sidecar.is_file()
    assert meta is not None
    assert meta.get("qwenOutputRelPath") == "frame_001_qwen.png"


def test_resolve_rmbg_input_prefers_sidecar(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    plate = tmp_path / "pose_001.png"
    Image.new("RGB", (200, 100), (255, 255, 255)).save(plate)
    sidecar = qwen_sidecar_path(plate)
    Image.new("RGB", (64, 64), (40, 50, 60)).save(sidecar)

    monkeypatch.setattr(logic, "DEFAULT_STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(
        logic,
        "_abs_path_for_image_rel",
        lambda rel: tmp_path / Path(str(rel).replace("\\", "/")).name,
    )

    src, pf, label = logic.resolve_rmbg_input("pose_001.png")
    assert src == sidecar
    assert pf is None
    assert "native Qwen" in label
    assert "sidecar" in label


def test_resolve_rmbg_input_falls_back_to_plate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    plate = tmp_path / "pose_old.png"
    Image.new("RGB", (120, 90), (255, 255, 255)).save(plate)

    monkeypatch.setattr(logic, "DEFAULT_STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(
        logic,
        "_abs_path_for_image_rel",
        lambda rel: tmp_path / Path(str(rel).replace("\\", "/")).name,
    )

    src, _pf, label = logic.resolve_rmbg_input("pose_old.png")
    assert src == plate
    assert "plate fallback" in label


def test_run_keypoint_image_edit_exposes_qwen_tmp_path(tmp_path: Path) -> None:
    identity = tmp_path / "identity.png"
    keypoint = tmp_path / "keypoint.png"
    Image.new("RGB", (400, 200), (255, 255, 255)).save(identity)
    Image.new("RGB", (400, 200), (0, 0, 0)).save(keypoint)

    placed = {
        "canvas": {"width": 800, "height": 400},
        "placement": {"x": 100, "y": 50, "width": 200, "height": 200},
        "workingSquareSize": 1024,
    }

    def fake_run(module: str, argv: list[str], log_cb=None) -> dict:
        _ = module, log_cb
        qwen_out = tmp_path / "qwen_fake.png"
        Image.new("RGB", (96, 96), (10, 20, 30)).save(qwen_out)
        return {"results": [{"url": str(qwen_out)}]}

    with patch.object(logic, "_run_service_testmode", side_effect=fake_run):
        plate_path, square_meta = logic._run_keypoint_image_edit_with_plate(
            "test_char",
            str(identity),
            str(keypoint),
            placed,
            "test prompt",
        )

    assert Path(plate_path).is_file()
    assert square_meta is not None
    assert Path(square_meta["_qwenTmpPath"]).is_file()


def test_remove_bg_to_temp_with_hd_source_composites_canvas(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    plate = tmp_path / "frame.png"
    Image.new("RGB", (80, 60), (255, 255, 255)).save(plate)
    sidecar = qwen_sidecar_path(plate)
    Image.new("RGBA", (32, 32), (200, 40, 40, 255)).save(sidecar)

    placed = {
        "canvas": {"width": 80, "height": 60},
        "placement": {"x": 10, "y": 5, "width": 20, "height": 30},
    }

    rgba_matte = tmp_path / "matte.png"
    Image.new("RGBA", (32, 32), (200, 40, 40, 200)).save(rgba_matte)

    monkeypatch.setattr(
        logic,
        "resolve_rmbg_input",
        lambda _rel, _pf=None: (sidecar, placed, "native Qwen"),
    )
    monkeypatch.setattr(
        logic,
        "remove_bg_to_temp_file",
        lambda *_a, **_k: str(rgba_matte),
    )

    out = logic.remove_bg_to_temp_with_hd_source("frame.png")
    try:
        with Image.open(out) as im:
            assert im.size == (80, 60)
            assert im.mode == "RGBA"
            assert im.getpixel((0, 0))[3] == 0
            assert im.getpixel((15, 15))[3] > 0
    finally:
        Path(out).unlink(missing_ok=True)


def test_remove_bg_full_plate_is_not_placed_twice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    plate = tmp_path / "frame.png"
    Image.new("RGB", (80, 60), (255, 255, 255)).save(plate)
    placed = {
        "canvas": {"width": 80, "height": 60},
        "placement": {"x": 10, "y": 5, "width": 20, "height": 30},
    }
    matte = tmp_path / "full_matte.png"
    full = Image.new("RGBA", (80, 60), (0, 0, 0, 0))
    full.putpixel((50, 40), (20, 30, 40, 180))
    full.save(matte)

    monkeypatch.setattr(
        logic,
        "resolve_rmbg_input",
        lambda _rel, _pf=None: (plate, placed, "RMBG source: plate fallback"),
    )
    monkeypatch.setattr(
        logic, "remove_bg_to_temp_file", lambda *_a, **_k: str(matte)
    )

    out = logic.remove_bg_to_temp_with_hd_source("frame.png")
    assert out == str(matte)
    with Image.open(out) as im:
        assert im.size == (80, 60)
        assert im.getpixel((50, 40))[3] == 180
        assert im.getpixel((15, 15))[3] == 0


def test_composite_rgba_on_transparent_canvas() -> None:
    matte = Image.new("RGBA", (20, 20), (255, 0, 0, 255))
    out = composite_rgba_on_transparent_canvas(
        matte,
        60,
        40,
        {"x": 5, "y": 3, "width": 20, "height": 20},
    )
    assert out.size == (60, 40)
    assert out.getpixel((0, 0))[3] == 0
    assert out.getpixel((10, 10))[0] == 255


def test_composite_rgba_preserves_partial_alpha_edge() -> None:
    matte = Image.new("RGBA", (2, 2), (255, 0, 0, 128))
    out = composite_rgba_on_transparent_canvas(
        matte,
        4,
        4,
        {"x": 1, "y": 1, "width": 2, "height": 2},
    )
    assert out.getpixel((1, 1)) == (255, 0, 0, 128)
