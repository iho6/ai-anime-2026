"""Native Wan 1280 long-edge and Qwen 1328 encode-path tests (no GPU)."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

from PIL import Image

from services.constant import WAN_VIDEO_MAX_EDGE
from services.qwen_image_dims import (
    QWEN_IMAGE_SQUARE,
    snap_paths_to_shared_qwen_bucket,
    snap_to_qwen_bucket,
)
from services.wan_video_dims import resolve_wan_job_dims, wan_dims_from_source


def test_wan_dims_from_source_widescreen() -> None:
    assert wan_dims_from_source(1920, 1080) == (1280, 720)


def test_wan_dims_from_source_square() -> None:
    assert wan_dims_from_source(1024, 1024) == (1280, 1280)


def test_wan_dims_from_source_is_multiple_of_16() -> None:
    w, h = wan_dims_from_source(1919, 800)
    assert w % 16 == 0 and h % 16 == 0
    assert max(w, h) == WAN_VIDEO_MAX_EDGE
    assert min(w, h) >= 16


def test_resolve_wan_job_dims_explicit_wins(tmp_path: Path) -> None:
    src = tmp_path / "wide.png"
    Image.new("RGB", (1920, 1080), color=(0, 0, 0)).save(src)
    assert resolve_wan_job_dims(640, 640, src) == (640, 640)


def test_resolve_wan_job_dims_omitted_uses_helper(tmp_path: Path) -> None:
    src = tmp_path / "wide.png"
    Image.new("RGB", (1920, 1080), color=(0, 0, 0)).save(src)
    assert resolve_wan_job_dims(None, None, src) == (1280, 720)


def test_i2v_patch_explicit_size() -> None:
    from services.img2video_ai_service import serverless as i2v

    api = i2v.workflows[i2v.API_KEY]
    patched = i2v._patch_workflow(
        api,
        image_ref="start.png",
        width=640,
        height=640,
        length=25,
        positive_prompt=None,
        negative_prompt=None,
        steps=None,
        cfg=None,
        seed=None,
        fps=None,
        use_lora=None,
    )
    wan = next(
        n for n in patched.values()
        if isinstance(n, dict) and n.get("class_type") == "WanImageToVideo"
    )
    assert wan["inputs"]["width"] == 640
    assert wan["inputs"]["height"] == 640


def test_i2v_graph_default_is_1280() -> None:
    from services.img2video_ai_service import serverless as i2v

    api = i2v.workflows[i2v.API_KEY]
    wan = next(
        n for n in api.values()
        if isinstance(n, dict) and n.get("class_type") == "WanImageToVideo"
    )
    assert wan["inputs"]["width"] == 1280
    assert wan["inputs"]["height"] == 1280


def test_flf_patch_sets_width_height_from_helper(tmp_path: Path) -> None:
    from services.flf2video_ai_service import serverless as flf

    start = tmp_path / "a.png"
    end = tmp_path / "b.png"
    Image.new("RGB", (1920, 1080), color=(1, 2, 3)).save(start)
    Image.new("RGB", (1920, 1080), color=(4, 5, 6)).save(end)
    w_px, h_px = resolve_wan_job_dims(None, None, start, end)
    assert (w_px, h_px) == (1280, 720)

    api = flf.workflows[flf.API_KEY]
    patched = flf._patch_workflow(
        api,
        start_ref=str(start),
        end_ref=str(end),
        length=25,
        positive_prompt=None,
        width=w_px,
        height=h_px,
    )
    wan = next(
        n for n in patched.values()
        if isinstance(n, dict) and n.get("class_type") == "WanFirstLastFrameToVideo"
    )
    assert wan["inputs"]["width"] == 1280
    assert wan["inputs"]["height"] == 720
    assert wan["inputs"]["length"] == 25


def test_flf_patch_explicit_size_wins() -> None:
    from services.flf2video_ai_service import serverless as flf

    api = flf.workflows[flf.API_KEY]
    patched = flf._patch_workflow(
        api,
        start_ref="a.png",
        end_ref="b.png",
        length=33,
        positive_prompt=None,
        width=640,
        height=640,
    )
    wan = next(
        n for n in patched.values()
        if isinstance(n, dict) and n.get("class_type") == "WanFirstLastFrameToVideo"
    )
    assert wan["inputs"]["width"] == 640
    assert wan["inputs"]["height"] == 640


def test_qwen_square_bucket_is_1328() -> None:
    assert snap_to_qwen_bucket(1024, 1024) == QWEN_IMAGE_SQUARE
    assert snap_to_qwen_bucket(1328, 1328) == (1328, 1328)


def test_qwen_snap_character_and_mesh_to_1328(tmp_path: Path) -> None:
    char = tmp_path / "char.png"
    mesh = tmp_path / "mesh.png"
    Image.new("RGB", (1024, 1024), color=(10, 20, 30)).save(char)
    Image.new("RGB", (1328, 1328), color=(40, 50, 60)).save(mesh)
    p, aux, temps = snap_paths_to_shared_qwen_bucket(str(char), [str(mesh)])
    try:
        with Image.open(p) as im:
            assert im.size == (1328, 1328)
        with Image.open(aux[0]) as im:
            assert im.size == (1328, 1328)
    finally:
        for t in temps:
            Path(t).unlink(missing_ok=True)


def test_qwen_encode_path_has_no_flux_kontext() -> None:
    from services.image_edit_ai_service import serverless as edit

    api = deepcopy(edit.workflows[edit.WORKFLOW_STEM])
    edit.rewire_qwen_edit_encode_without_kontext(api)
    assert not any(
        isinstance(n, dict) and n.get("class_type") == "FluxKontextImageScale"
        for n in api.values()
    )
    vae = api[edit._QWEN_EDIT_VAE_ENCODE]["inputs"]["pixels"]
    enc = api[edit._QWEN_EDIT_ENCODER_POS]["inputs"]["image1"]
    assert vae == ["78", 0]
    assert enc == ["78", 0]


def test_qwen_workflow_json_encode_skips_kontext() -> None:
    path = (
        Path(__file__).resolve().parents[1]
        / "services"
        / "image_edit_ai_service"
        / "workflows"
        / "image_qwen_image_edit_2509.json"
    )
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["433:88"]["inputs"]["pixels"][0] == "78"
    assert data["433:111"]["inputs"]["image1"][0] == "78"
    used = json.dumps(data)
    assert "FluxKontextImageScale" not in used or data.get("433:117") is None
    # Encode path must not reference Kontext node ids.
    assert data["433:88"]["inputs"]["pixels"][0] != "433:117"
    assert "433:117" not in json.dumps(data["433:110"])
    assert "433:117" not in json.dumps(data["433:111"])
