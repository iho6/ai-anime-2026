"""Generate low-resolution preview proxies for timeline video clips.

Preview only needs a small frame (a few hundred px tall) but currently decodes
the full-resolution master. This module produces a ~480p proxy beside each
master so the preview player and the server RGBA compositor decode far less
data. Export keeps using the master.

Proxies live next to their master under ``storage/timelines/<key>/clips/``:

    clip_x.mp4                -> clip_x.proxy.mp4                 (plain video)
    clip_x_rmbg.webm          -> clip_x_rmbg.proxy.webm           (VP9 + alpha)
    (+ clip_x_rmbg.alpha.mkv master kept for export only)

Alpha clips get a **single** VP9 WebM with a real alpha channel so preview
play is one decode (no runtime color/matte pairing). Masters stay split for
export quality.

Encode settings prioritize browser scrub/seek (short GOP). Bump
``PROXY_ENCODE_VERSION`` when those settings change so stale proxies regenerate.
"""

from __future__ import annotations

import json
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

# Seek-friendly encode profile. Bump when options change so old long-GOP
# proxies are rebuilt on next ensure_clip_proxy.
# v4: alpha preview is one VP9 WebM with alpha (no H.264 color+matte pair).
PROXY_ENCODE_VERSION = 4
PROXY_KEYINT = 12

_H264_PROXY_OPTIONS = {
    "crf": "26",
    "preset": "veryfast",
    "g": str(PROXY_KEYINT),
    "keyint_min": str(PROXY_KEYINT),
    "scenecut": "0",
}


def _sidecar_path(proxy: Path) -> Path:
    """Sidecar metadata: ``clip.proxy.mp4.proxy.json``."""
    return Path(str(proxy) + ".proxy.json")


def _write_proxy_sidecar(proxy: Path) -> None:
    meta = {
        "encodeVersion": PROXY_ENCODE_VERSION,
        "keyint": PROXY_KEYINT,
    }
    _sidecar_path(proxy).write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _sidecar_matches_version(proxy: Path) -> bool:
    side = _sidecar_path(proxy)
    if not side.is_file():
        return False
    try:
        data = json.loads(side.read_text(encoding="utf-8"))
        return int(data.get("encodeVersion", -1)) == PROXY_ENCODE_VERSION
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


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
    """True when proxy exists, is newer than master, and matches encode version."""
    try:
        if not (
            proxy.is_file()
            and proxy.stat().st_mtime >= master.stat().st_mtime
            and proxy.stat().st_size > 0
        ):
            return False
        return _sidecar_matches_version(proxy)
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
            out_stream.options = dict(_H264_PROXY_OPTIONS)
            for frame in in_container.decode(in_stream):
                reframed = frame.reformat(width=out_w, height=out_h, format="yuv420p")
                for pkt in out_stream.encode(reframed):
                    out_container.mux(pkt)
            for pkt in out_stream.encode(None):
                out_container.mux(pkt)
    finally:
        in_container.close()
    _write_proxy_sidecar(proxy)


def _transcode_alpha_webm_rgba(
    clip: dict[str, Any],
    master: Path,
    proxy_webm: Path,
    out_w: int,
    out_h: int,
) -> bool:
    """Bake color+alpha masters into one VP9 WebM with a real alpha channel.

    Uses ffmpeg alphamerge so pairing is done once at bake time; preview play
    is a single decode. libvpx-vp9 requires ``-auto-alt-ref 0`` for alpha.
    """
    import subprocess

    from utils.video_utils import require_ffmpeg

    alpha_rel = str(clip.get("alphaRelPath") or "").strip() or None
    alpha_path = _alpha_companion_path(master, alpha_rel)
    if alpha_path is None:
        return False

    proxy_webm.parent.mkdir(parents=True, exist_ok=True)
    # Remove stale output so a failed encode cannot look "fresh".
    try:
        if proxy_webm.is_file():
            proxy_webm.unlink()
    except OSError:
        pass

    ffmpeg = require_ffmpeg()
    # Color + gray matte → single yuva420p stream (pairing at bake).
    filt = (
        f"[0:v]scale={out_w}:{out_h}:flags=bicubic,format=yuv420p[c];"
        f"[1:v]scale={out_w}:{out_h}:flags=bicubic,format=gray[a];"
        f"[c][a]alphamerge,format=yuva420p[v]"
    )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(master),
        "-i",
        str(alpha_path),
        "-filter_complex",
        filt,
        "-map",
        "[v]",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-g",
        str(PROXY_KEYINT),
        "-keyint_min",
        str(PROXY_KEYINT),
        "-crf",
        "32",
        "-b:v",
        "0",
        "-cpu-used",
        "8",
        "-row-mt",
        "1",
        "-an",
        str(proxy_webm),
    ]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=600,
        )
    except (OSError, subprocess.TimeoutExpired) as ex:
        logger.warning("VP9 alpha proxy ffmpeg failed for %s: %s", master.name, ex)
        return False
    if proc.returncode != 0 or not proxy_webm.is_file() or proxy_webm.stat().st_size <= 0:
        tail = (proc.stderr or "")[-800:]
        logger.warning(
            "VP9 alpha proxy encode failed for %s (code %s): %s",
            master.name,
            proc.returncode,
            tail,
        )
        return False
    _write_proxy_sidecar(proxy_webm)
    return True


def ensure_clip_proxy(clip: dict[str, Any]) -> dict[str, str] | None:
    """Ensure a seek-friendly preview proxy exists for a video clip.

    Returns fields to merge into the clip (``proxyRelPath`` only). Alpha clips
    get a unified ``.proxy.webm``; callers should drop stale
    ``proxyAlphaRelPath``. Returns ``None`` when not possible.

    Always re-encodes for short-GOP even when the master is already ≤480p;
    dimensions are capped via ``_scaled_even`` (no upscale).
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
    if h <= 0 or w <= 0:
        return None

    out_w, out_h = _scaled_even(w, h)
    has_alpha = bool(str(clip.get("alphaRelPath") or "").strip()) or (
        _alpha_companion_path(master, None) is not None
    )

    try:
        if has_alpha:
            proxy_webm = master.parent / (master.stem + ".proxy.webm")
            if _is_fresh(proxy_webm, master):
                return {"proxyRelPath": _rel_from_abs(proxy_webm)}
            ok = _transcode_alpha_webm_rgba(
                clip, master, proxy_webm, out_w, out_h
            )
            if not ok:
                return None
            return {"proxyRelPath": _rel_from_abs(proxy_webm)}

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
    Drops stale ``proxyAlphaRelPath`` when a unified WebM proxy is installed.
    """
    updated = 0
    for track in manifest.get("tracks") or []:
        for clip in track.get("clips") or []:
            if str(clip.get("type") or "") != "video":
                continue
            fields = ensure_clip_proxy(clip)
            if not fields:
                continue
            proxy_rel = str(fields.get("proxyRelPath") or "")
            clear_alpha = proxy_rel.lower().endswith(".webm")
            already = all(clip.get(k) == v for k, v in fields.items()) and (
                not clear_alpha or "proxyAlphaRelPath" not in clip
            )
            if already:
                continue
            clip.update(fields)
            if clear_alpha:
                clip.pop("proxyAlphaRelPath", None)
            updated += 1
    return updated
