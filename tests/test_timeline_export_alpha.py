"""Timeline export alpha / frameSequence compositing tests."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from services.logic import encode_rgba_frames_to_webm
from services.timeline_export import (
    _CompositorState,
    _VideoFrameDecoder,
    _alpha_companion_path,
    _clip_has_exportable_frame_sequence,
    _flatten_rgba_to_rgb,
    _strip_frame_index_at_source_time,
    _strip_rgba_at_index,
)


def _rgba_frame_with_transparent_corner(size: int = 64) -> np.ndarray:
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    arr[:, :, :3] = 255
    arr[:, :, 3] = 255
    arr[0:12, 0:12, 3] = 0
    arr[20:44, 20:44, :3] = [200, 40, 40]
    return arr


def _write_webm_with_alpha_companion(tmp_path: Path, stem: str = "clip_test_rmbg") -> Path:
    webm = tmp_path / f"{stem}.webm"
    frames = [_rgba_frame_with_transparent_corner(), _rgba_frame_with_transparent_corner()]
    encode_rgba_frames_to_webm(
        frames,
        fps=24,
        width=64,
        height=64,
        output_path=webm,
    )
    assert (tmp_path / f"{stem}.alpha.mkv").is_file()
    return webm


def test_alpha_companion_path_by_convention(tmp_path: Path) -> None:
    webm = _write_webm_with_alpha_companion(tmp_path)
    companion = _alpha_companion_path(webm)
    assert companion is not None
    assert companion.name == "clip_test_rmbg.alpha.mkv"


def test_alpha_companion_path_falls_back_to_convention(tmp_path: Path) -> None:
    webm = _write_webm_with_alpha_companion(tmp_path, stem="clip_a")
    companion = _alpha_companion_path(webm, alpha_rel="nonexistent/bad.alpha.mkv")
    assert companion is not None
    assert companion.name == "clip_a.alpha.mkv"


def test_video_decoder_uses_alpha_companion(tmp_path: Path) -> None:
    webm = _write_webm_with_alpha_companion(tmp_path)
    clip = {"id": "v1", "type": "video"}
    dec = _VideoFrameDecoder(webm, clip)
    try:
        frame = dec.frame_at_source_time(0.0)
        assert frame.getpixel((4, 4))[3] == 0
        flat = _flatten_rgba_to_rgb(frame)
        assert flat.getpixel((4, 4)) == (0, 0, 0)
    finally:
        dec.close()


def test_video_decoder_warns_when_alpha_companion_missing(tmp_path: Path) -> None:
    pytest.importorskip("av")
    import av

    webm = tmp_path / "clip_x_rmbg_1.webm"
    with av.open(str(webm), mode="w", format="webm") as container:
        stream = container.add_stream("libvpx-vp9", rate=24)
        stream.width = 32
        stream.height = 32
        stream.pix_fmt = "yuv420p"
        frame = av.VideoFrame(32, 32, "rgb24")
        frame.planes[0].update(np.full((32, 32, 3), 255, dtype=np.uint8))
        for pkt in stream.encode(frame):
            container.mux(pkt)
        for pkt in stream.encode():
            container.mux(pkt)

    logs: list[str] = []
    dec = _VideoFrameDecoder(
        webm,
        {"id": "v2", "type": "video"},
        log_cb=logs.append,
    )
    try:
        dec.frame_at_source_time(0.0)
    finally:
        dec.close()
    assert any("Alpha companion missing" in line for line in logs)


def test_strip_rgba_hold_last_visible(tmp_path: Path) -> None:
    png_a = tmp_path / "a.png"
    png_b = tmp_path / "b.png"
    Image.new("RGBA", (32, 32), (0, 255, 0, 128)).save(png_a)
    Image.new("RGBA", (32, 32), (255, 0, 0, 200)).save(png_b)
    strip = [
        {"kind": "image", "relPath": str(png_a)},
        {"kind": "empty"},
        {"kind": "image", "relPath": str(png_b)},
    ]
    cache: dict[str, object] = {}
    import services.timeline_export as te

    orig = te._resolve_strip_slot_path

    def _resolve(rel: str) -> Path:
        p = Path(rel)
        return p if p.is_file() else orig(rel)

    te._resolve_strip_slot_path = _resolve  # type: ignore[method-assign]
    try:
        im0 = _strip_rgba_at_index(strip, 0, cache)
        im1 = _strip_rgba_at_index(strip, 1, cache)
        assert im0.getpixel((0, 0))[:3] == (0, 255, 0)
        assert im1.getpixel((0, 0))[:3] == (0, 255, 0)
        im2 = _strip_rgba_at_index(strip, 2, cache)
        assert im2.getpixel((0, 0))[:3] == (255, 0, 0)
    finally:
        te._resolve_strip_slot_path = orig  # type: ignore[method-assign]


def test_strip_frame_index_respects_in_point() -> None:
    clip = {"inPoint": 1.0, "outPoint": 3.0, "type": "video"}
    strip = [{"kind": "image", "relPath": "a.png"}] * 20
    idx = _strip_frame_index_at_source_time(clip, strip, manifest_fps=24, source_time=1.5)
    assert idx == 12


def test_export_coloring_preserves_alpha_holes_on_video_frame(tmp_path: Path) -> None:
    from services.clip_coloring import apply_clip_coloring_rgba

    webm = _write_webm_with_alpha_companion(tmp_path, stem="clip_color")
    clip = {"id": "v1", "type": "video", "coloring": {"lightness": 100}}
    dec = _VideoFrameDecoder(webm, clip)
    try:
        frame = dec.frame_at_source_time(0.0)
        colored = apply_clip_coloring_rgba(frame, clip.get("coloring"))
        assert colored.getpixel((4, 4))[3] == 0
        assert colored.getpixel((30, 30))[:3] == (255, 255, 255)
    finally:
        dec.close()


def test_compositor_prefers_frame_sequence_over_src(tmp_path: Path) -> None:
    strip_png = tmp_path / "strip.png"
    Image.new("RGBA", (40, 40), (0, 0, 255, 255)).save(strip_png)
    src_png = tmp_path / "src.png"
    Image.new("RGBA", (40, 40), (255, 255, 0, 255)).save(src_png)

    clip = {
        "id": "c-strip",
        "type": "video",
        "inPoint": 0,
        "outPoint": 1,
        "frameSequence": {
            "sequenceGroupId": "c-strip",
            "strip": [{"kind": "image", "relPath": str(strip_png)}],
            "hidden": [],
        },
    }
    assert _clip_has_exportable_frame_sequence(clip)

    state = _CompositorState(24.0)

    # Use absolute strip paths in this unit test.
    import services.timeline_export as te

    orig = te._resolve_strip_slot_path

    def _resolve(rel: str) -> Path:
        p = Path(rel)
        return p if p.is_file() else orig(rel)

    te._resolve_strip_slot_path = _resolve  # type: ignore[method-assign]
    try:
        frame = state.get_rgba_frame(clip, src_png, 0.0)
        assert frame.getpixel((0, 0))[:3] == (0, 0, 255)
    finally:
        te._resolve_strip_slot_path = orig  # type: ignore[method-assign]
        state.close()
