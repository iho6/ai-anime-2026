"""Generate low-resolution preview proxies for timeline video clips.

Preview only needs a small frame (a few hundred px tall) but currently decodes
the full-resolution master. This module produces a ~480p proxy beside each
master so the preview player and the server RGBA compositor decode far less
data. Export keeps using the master.

Proxies live next to their master under ``storage/timelines/<key>/clips/``:

    clip_x.mp4                -> clip_x.proxy.mp4                 (plain video)
    clip_x_rmbg.webm          -> clip_x_rmbg.proxy.webm           (color)
    clip_x_rmbg.alpha.mkv     -> clip_x_rmbg.proxy.alpha.mkv      (alpha companion)
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from services.logic import probe_video_meta
from services.timeline_export import (
    TIMELINES_STORAGE_ROOT,
    _alpha_companion_path,
    _resolve_storage_rel_file,
)

logger = logging.getLogger(__name__)

# Target max height for preview proxies. 480p is plenty for the small preview
# frame while cutting decode cost dramatically vs 1080p/4K masters.
PROXY_MAX_H = 480
# Skip generating an alpha proxy for very long clips to bound memory (alpha
# proxying decodes RGBA frames into memory before re-encoding).
ALPHA_PROXY_MAX_FRAMES = 900


def _rel_from_abs(abs_path: Path) -> str:
    """``timelines/...`` relative path for a proxy under the timelines root."""
    p = abs_path.resolve()
    rel = p.relative_to(TIMELINES_STORAGE_ROOT.resolve())
    return str(Path("timelines") / rel).replace("\\", "/")


def _scaled_even(w: int, h: int) -> tuple[int, int]:
    """Scale (w, h) so height <= PROXY_MAX_H, preserving aspect, even dims."""
    if h <= 0 or w <= 0:
        return max(2, w), max(2, h)
    if h <= PROXY_MAX_H:
        out_w, out_h = w, h
    else:
        scale = PROXY_MAX_H / float(h)
        out_w = max(2, int(round(w * scale)))
        out_h = PROXY_MAX_H
    if out_w % 2:
        out_w -= 1
    if out_h % 2:
        out_h -= 1
    return max(2, out_w), max(2, out_h)


def _is_fresh(proxy: Path, master: Path) -> bool:
    try:
        return (
            proxy.is_file()
            and proxy.stat().st_mtime >= master.stat().st_mtime
            and proxy.stat().st_size > 0
        )
    except OSError:
        return False


def _transcode_plain_h264(master: Path, proxy: Path, out_w: int, out_h: int) -> None:
    import av

    proxy.parent.mkdir(parents=True, exist_ok=True)
    in_container = av.open(str(master))
    try:
        in_stream = in_container.streams.video[0]
        rate = in_stream.average_rate or in_stream.base_rate or 24
        with av.open(str(proxy), mode="w") as out_container:
            out_stream = out_container.add_stream("libx264", rate=rate)
            out_stream.width = out_w
            out_stream.height = out_h
            out_stream.pix_fmt = "yuv420p"
            out_stream.options = {"crf": "26", "preset": "veryfast"}
            for frame in in_container.decode(in_stream):
                reframed = frame.reformat(width=out_w, height=out_h, format="yuv420p")
                for pkt in out_stream.encode(reframed):
                    out_container.mux(pkt)
            for pkt in out_stream.encode(None):
                out_container.mux(pkt)
    finally:
        in_container.close()


def _transcode_alpha_webm(
    clip: dict[str, Any],
    master: Path,
    proxy_webm: Path,
    out_w: int,
    out_h: int,
) -> bool:
    """Downscale a color+alpha clip into a proxy WebM (+ .alpha.mkv companion).

    Returns False (skip) when the clip is too long to buffer safely.
    """
    import av
    import numpy as np
    from PIL import Image

    from services.logic import encode_rgba_frames_to_webm

    alpha_rel = str(clip.get("alphaRelPath") or "").strip() or None
    alpha_path = _alpha_companion_path(master, alpha_rel)
    if alpha_path is None:
        return False

    color_container = av.open(str(master))
    alpha_container = av.open(str(alpha_path))
    try:
        cstream = color_container.streams.video[0]
        rate = cstream.average_rate or cstream.base_rate or 24
        color_iter = color_container.decode(cstream)
        alpha_iter = alpha_container.decode(alpha_container.streams.video[0])

        rgba_frames: list[Any] = []
        for av_frame in color_iter:
            try:
                alpha_frame = next(alpha_iter)
            except StopIteration:
                break
            color_np = av_frame.to_ndarray(format="rgb24")
            alpha_np = alpha_frame.to_ndarray(format="gray")
            combined = np.dstack([color_np, alpha_np])
            img = Image.fromarray(combined, mode="RGBA").resize(
                (out_w, out_h), Image.BILINEAR
            )
            rgba_frames.append(np.asarray(img, dtype=np.uint8))
            if len(rgba_frames) > ALPHA_PROXY_MAX_FRAMES:
                return False
    finally:
        color_container.close()
        alpha_container.close()

    if not rgba_frames:
        return False

    encode_rgba_frames_to_webm(
        rgba_frames,
        fps=float(rate),
        width=out_w,
        height=out_h,
        output_path=proxy_webm,
    )
    return True


def ensure_clip_proxy(clip: dict[str, Any]) -> dict[str, str] | None:
    """Ensure a preview proxy exists for a video clip.

    Returns the fields to merge into the clip (``proxyRelPath`` and, for alpha
    clips, ``proxyAlphaRelPath``) or ``None`` when no proxy is needed / possible
    (image clips, already-small sources, or on failure -> fall back to master).
    """
    if str(clip.get("type") or "") != "video":
        return None
    rel = str(clip.get("srcRelPath") or "").strip()
    if not rel:
        return None
    try:
        master = _resolve_storage_rel_file(rel)
    except ValueError:
        return None

    try:
        meta = probe_video_meta(master)
    except Exception:
        return None
    w = int(meta.get("width") or 0)
    h = int(meta.get("height") or 0)
    if h <= 0 or w <= 0 or h <= PROXY_MAX_H:
        return None  # already small enough; preview can use the master

    out_w, out_h = _scaled_even(w, h)
    has_alpha = bool(str(clip.get("alphaRelPath") or "").strip()) or (
        _alpha_companion_path(master, None) is not None
    )

    try:
        if has_alpha:
            proxy_webm = master.parent / (master.stem + ".proxy.webm")
            proxy_alpha = master.parent / (proxy_webm.stem + ".alpha.mkv")
            if _is_fresh(proxy_webm, master) and proxy_alpha.is_file():
                return {
                    "proxyRelPath": _rel_from_abs(proxy_webm),
                    "proxyAlphaRelPath": _rel_from_abs(proxy_alpha),
                }
            ok = _transcode_alpha_webm(clip, master, proxy_webm, out_w, out_h)
            if not ok or not proxy_webm.is_file():
                return None
            result = {"proxyRelPath": _rel_from_abs(proxy_webm)}
            if proxy_alpha.is_file():
                result["proxyAlphaRelPath"] = _rel_from_abs(proxy_alpha)
            return result

        proxy_mp4 = master.parent / (master.stem + ".proxy.mp4")
        if _is_fresh(proxy_mp4, master):
            return {"proxyRelPath": _rel_from_abs(proxy_mp4)}
        _transcode_plain_h264(master, proxy_mp4, out_w, out_h)
        if not proxy_mp4.is_file():
            return None
        return {"proxyRelPath": _rel_from_abs(proxy_mp4)}
    except Exception as ex:
        logger.warning("Proxy generation failed for %s: %s", master.name, ex)
        return None


def ensure_manifest_proxies(manifest: dict[str, Any]) -> int:
    """Generate missing proxies for every video clip; mutate manifest in place.

    Returns the number of clips whose proxy fields were updated.
    """
    updated = 0
    for track in manifest.get("tracks") or []:
        for clip in track.get("clips") or []:
            if str(clip.get("type") or "") != "video":
                continue
            fields = ensure_clip_proxy(clip)
            if not fields:
                continue
            if all(clip.get(k) == v for k, v in fields.items()):
                continue
            clip.update(fields)
            updated += 1
    return updated
