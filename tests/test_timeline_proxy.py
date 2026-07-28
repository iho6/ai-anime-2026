"""Tests for preview proxy sizing, freshness, and seek-friendly encode helpers."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from services.timeline_proxy import (
    PROXY_ENCODE_VERSION,
    PROXY_KEYINT,
    PROXY_MAX_H,
    _is_fresh,
    _scaled_even,
    _sidecar_path,
    _transcode_alpha_webm_rgba,
    _transcode_plain_h264,
    _write_proxy_sidecar,
    ensure_clip_proxy,
)


def test_scaled_even_downscales_tall_source():
    w, h = _scaled_even(1920, 1080)
    assert h == PROXY_MAX_H
    assert w % 2 == 0 and h % 2 == 0
    # Aspect ratio preserved (16:9 -> ~853x480, rounded to even).
    assert abs(w / h - 1920 / 1080) < 0.02


def test_scaled_even_leaves_small_source_but_makes_even():
    w, h = _scaled_even(641, 361)
    assert h <= PROXY_MAX_H
    assert w % 2 == 0 and h % 2 == 0


def test_scaled_even_guards_zero():
    assert _scaled_even(0, 0) == (2, 2)


def test_is_fresh_requires_sidecar_version(tmp_path: Path):
    master = tmp_path / "clip.mp4"
    proxy = tmp_path / "clip.proxy.mp4"
    master.write_bytes(b"master")
    proxy.write_bytes(b"proxy-bytes")

    assert _is_fresh(proxy, master) is False

    _write_proxy_sidecar(proxy)
    assert _is_fresh(proxy, master) is True

    side = _sidecar_path(proxy)
    side.write_text(json.dumps({"encodeVersion": 1, "keyint": 12}), encoding="utf-8")
    assert _is_fresh(proxy, master) is False

    side.write_text(
        json.dumps({"encodeVersion": PROXY_ENCODE_VERSION, "keyint": PROXY_KEYINT}),
        encoding="utf-8",
    )
    assert _is_fresh(proxy, master) is True


def test_is_fresh_false_when_master_newer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    master = tmp_path / "clip.mp4"
    proxy = tmp_path / "clip.proxy.mp4"
    proxy.write_bytes(b"proxy")
    _write_proxy_sidecar(proxy)
    master.write_bytes(b"master-newer")

    # Ensure master mtime is strictly after proxy.
    import os
    import time

    now = time.time()
    os.utime(proxy, (now - 10, now - 10))
    os.utime(master, (now, now))
    assert _is_fresh(proxy, master) is False


def _write_tiny_h264(path: Path, *, width: int = 320, height: int = 240, frames: int = 24) -> None:
    import av

    path.parent.mkdir(parents=True, exist_ok=True)
    with av.open(str(path), mode="w") as container:
        stream = container.add_stream("libx264", rate=24)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "yuv420p"
        stream.options = {"crf": "28", "preset": "ultrafast"}
        for i in range(frames):
            rgb = np.zeros((height, width, 3), dtype=np.uint8)
            rgb[:, :, 0] = (i * 10) % 256
            frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
            frame = frame.reformat(format="yuv420p")
            for pkt in stream.encode(frame):
                container.mux(pkt)
        for pkt in stream.encode(None):
            container.mux(pkt)


def test_transcode_plain_h264_writes_sidecar_and_short_gop(tmp_path: Path):
    master = tmp_path / "src.mp4"
    proxy = tmp_path / "src.proxy.mp4"
    _write_tiny_h264(master, width=640, height=360, frames=36)

    _transcode_plain_h264(master, proxy, 640, 360)
    assert proxy.is_file() and proxy.stat().st_size > 0
    assert _sidecar_path(proxy).is_file()
    meta = json.loads(_sidecar_path(proxy).read_text(encoding="utf-8"))
    assert meta["encodeVersion"] == PROXY_ENCODE_VERSION
    assert meta["keyint"] == PROXY_KEYINT
    assert _is_fresh(proxy, master) is True


def test_ensure_clip_proxy_for_small_height_master(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """≤480p masters used to skip proxy; they must now get a seek proxy."""
    master = tmp_path / "small.mp4"
    _write_tiny_h264(master, width=320, height=240, frames=12)

    def _resolve(rel: str) -> Path:
        return master

    monkeypatch.setattr(
        "services.timeline_proxy._resolve_storage_rel_file",
        _resolve,
    )
    monkeypatch.setattr(
        "services.timeline_proxy.probe_video_meta",
        lambda _p: {"width": 320, "height": 240, "durationSec": 0.5, "fps": 24},
    )
    monkeypatch.setattr(
        "services.timeline_proxy._rel_from_abs",
        lambda p: f"timelines/test/{p.name}",
    )
    monkeypatch.setattr(
        "services.timeline_proxy._alpha_companion_path",
        lambda *_a, **_k: None,
    )

    fields = ensure_clip_proxy(
        {
            "type": "video",
            "id": "c1",
            "srcRelPath": "timelines/test/small.mp4",
        }
    )
    assert fields is not None
    assert fields["proxyRelPath"].endswith("small.proxy.mp4")
    proxy = tmp_path / "small.proxy.mp4"
    assert proxy.is_file()
    assert _sidecar_path(proxy).is_file()


def _write_gray_matte_mkv(path: Path, *, width: int, height: int, frames: int) -> None:
    import av

    with av.open(str(path), mode="w", format="matroska") as container:
        stream = container.add_stream("ffv1", rate=24)
        stream.width = width
        stream.height = height
        stream.pix_fmt = "gray"
        for i in range(frames):
            gray = np.full((height, width), 255 if i % 2 == 0 else 40, dtype=np.uint8)
            frame = av.VideoFrame.from_ndarray(gray, format="gray")
            for pkt in stream.encode(frame):
                container.mux(pkt)
        for pkt in stream.encode(None):
            container.mux(pkt)


def test_transcode_alpha_webm_rgba_writes_single_webm(tmp_path: Path):
    """v4 alpha proxies are one VP9 WebM with a real alpha channel."""
    master = tmp_path / "clip_rmbg.mp4"
    matte = tmp_path / "clip_rmbg.alpha.mkv"
    _write_tiny_h264(master, width=320, height=240, frames=12)
    _write_gray_matte_mkv(matte, width=320, height=240, frames=12)

    proxy = tmp_path / "clip_rmbg.proxy.webm"
    ok = _transcode_alpha_webm_rgba({"alphaRelPath": ""}, master, proxy, 320, 240)
    assert ok is True
    assert proxy.is_file() and proxy.stat().st_size > 0
    assert _sidecar_path(proxy).is_file()
    meta = json.loads(_sidecar_path(proxy).read_text(encoding="utf-8"))
    assert meta["encodeVersion"] == PROXY_ENCODE_VERSION

    import av

    with av.open(str(proxy)) as container:
        stream = container.streams.video[0]
        assert stream.codec_context.name in ("vp9", "libvpx-vp9")
        # VP9 alpha lives in WebM metadata (alpha_mode=1), not always as yuva
        # when decoded via PyAV — browsers honor alpha_mode on <video>.
        meta = {k.lower(): v for k, v in (stream.metadata or {}).items()}
        assert str(meta.get("alpha_mode", "")).strip() in ("1", "true")
        frame = next(container.decode(stream))
        assert frame.width == 320 and frame.height == 240


def test_transcode_alpha_webm_rgba_requires_matte(tmp_path: Path):
    master = tmp_path / "clip.mp4"
    _write_tiny_h264(master, width=64, height=64, frames=4)
    ok = _transcode_alpha_webm_rgba(
        {"alphaRelPath": ""},
        master,
        tmp_path / "clip.proxy.webm",
        64,
        64,
    )
    assert ok is False


def test_ensure_clip_proxy_alpha_returns_webm_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    master = tmp_path / "clip_rmbg.mp4"
    matte = tmp_path / "clip_rmbg.alpha.mkv"
    _write_tiny_h264(master, width=160, height=120, frames=8)
    _write_gray_matte_mkv(matte, width=160, height=120, frames=8)

    monkeypatch.setattr(
        "services.timeline_proxy._resolve_storage_rel_file",
        lambda _rel: master,
    )
    monkeypatch.setattr(
        "services.timeline_proxy.probe_video_meta",
        lambda _p: {"width": 160, "height": 120, "durationSec": 0.3, "fps": 24},
    )
    monkeypatch.setattr(
        "services.timeline_proxy._rel_from_abs",
        lambda p: f"timelines/test/{p.name}",
    )
    monkeypatch.setattr(
        "services.timeline_proxy._alpha_companion_path",
        lambda *_a, **_k: matte,
    )

    fields = ensure_clip_proxy(
        {
            "type": "video",
            "id": "c1",
            "srcRelPath": "timelines/test/clip_rmbg.mp4",
            "alphaRelPath": "timelines/test/clip_rmbg.alpha.mkv",
            "proxyAlphaRelPath": "timelines/test/stale.proxy.alpha.mp4",
        }
    )
    assert fields is not None
    assert fields["proxyRelPath"].endswith("clip_rmbg.proxy.webm")
    assert "proxyAlphaRelPath" not in fields
    assert (tmp_path / "clip_rmbg.proxy.webm").is_file()
