"""Resolve timeline preview frames with the same source precedence as export."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from services.clip_coloring import apply_clip_coloring_rgba
from services.timeline_export import (
    _clip_should_use_frame_sequence_strip,
    _resolve_storage_rel_file,
    _strip_frame_index_at_source_time,
    _strip_rgba_at_index,
)
from services.timeline_preview_cache import preview_decoder_cache


def _proxy_decode_target(
    clip: dict[str, Any], master_abs: Path
) -> tuple[dict[str, Any], Path]:
    """Return (clip_for_decode, video_path) preferring the preview proxy.

    Preview decodes the ~480p proxy when present; the decode clip's media fields
    are rewritten to the proxy so the alpha companion resolves to the proxy's own
    ``.alpha.mkv`` rather than the full-res master alpha (which would mismatch).
    """
    proxy_rel = str(clip.get("proxyRelPath") or "").strip()
    if not proxy_rel:
        return clip, master_abs
    try:
        proxy_abs = _resolve_storage_rel_file(proxy_rel)
    except ValueError:
        return clip, master_abs
    decode_clip = dict(clip)
    decode_clip["srcRelPath"] = proxy_rel
    proxy_alpha_rel = str(clip.get("proxyAlphaRelPath") or "").strip()
    # Clear the master alpha; the decoder falls back to the proxy's companion.
    decode_clip["alphaRelPath"] = proxy_alpha_rel or ""
    return decode_clip, proxy_abs


def timeline_preview_rgba(
    timeline_key: str,
    manifest: dict[str, Any],
    clip: dict[str, Any],
    abs_path: Path,
    source_time: float,
) -> Any:
    """Return RGBA for preview; alpha mattes beat opaque RGB frameSequence strips."""
    from PIL import Image

    clip_type = str(clip.get("type") or "")
    if clip_type == "image":
        with Image.open(abs_path) as im:
            rgba = im.convert("RGBA")
    elif _clip_should_use_frame_sequence_strip(clip):
        strip = (clip.get("frameSequence") or {}).get("strip") or []
        idx = _strip_frame_index_at_source_time(
            clip,
            strip,
            float(manifest.get("fps") or 24),
            source_time,
        )
        rgba = _strip_rgba_at_index(strip, idx, {})
    else:
        decode_clip, video_path = _proxy_decode_target(clip, abs_path)
        return preview_decoder_cache.get_rgba_frame(
            timeline_key, decode_clip, video_path, source_time
        )
    return apply_clip_coloring_rgba(rgba, clip.get("coloring"))
