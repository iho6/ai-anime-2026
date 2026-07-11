"""Resolve timeline preview frames with the same source precedence as export."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from services.clip_coloring import apply_clip_coloring_rgba
from services.timeline_export import (
    _clip_has_exportable_frame_sequence,
    _strip_frame_index_at_source_time,
    _strip_rgba_at_index,
)
from services.timeline_preview_cache import preview_decoder_cache


def timeline_preview_rgba(
    timeline_key: str,
    manifest: dict[str, Any],
    clip: dict[str, Any],
    abs_path: Path,
    source_time: float,
) -> Any:
    """Return RGBA for preview, preferring edited frameSequence strip images."""
    from PIL import Image

    clip_type = str(clip.get("type") or "")
    if clip_type == "image":
        with Image.open(abs_path) as im:
            rgba = im.convert("RGBA")
    elif _clip_has_exportable_frame_sequence(clip):
        strip = (clip.get("frameSequence") or {}).get("strip") or []
        idx = _strip_frame_index_at_source_time(
            clip,
            strip,
            float(manifest.get("fps") or 24),
            source_time,
        )
        rgba = _strip_rgba_at_index(strip, idx, {})
    else:
        return preview_decoder_cache.get_rgba_frame(
            timeline_key, clip, abs_path, source_time
        )
    return apply_clip_coloring_rgba(rgba, clip.get("coloring"))
