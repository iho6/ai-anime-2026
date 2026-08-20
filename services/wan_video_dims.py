"""Wan 2.2 I2V / FLF canvas size from a source still (native generate, no SR)."""

from __future__ import annotations

from pathlib import Path

from services.constant import WAN_VIDEO_MAX_EDGE

WAN_VIDEO_DIM_STEP = 16


def _round_to_step(n: float, step: int = WAN_VIDEO_DIM_STEP) -> int:
    return max(step, int(round(float(n) / step) * step))


def wan_dims_from_source(
    w: int,
    h: int,
    *,
    max_edge: int = WAN_VIDEO_MAX_EDGE,
) -> tuple[int, int]:
    """Scale so max(W, H) == max_edge, round to 16px, never below 16.

    1920×1080 → 1280×720; square → 1280×1280.
    """
    src_w = max(1, int(w))
    src_h = max(1, int(h))
    cap = max(WAN_VIDEO_DIM_STEP, int(max_edge))
    long_edge = max(src_w, src_h)
    scale = cap / float(long_edge)
    out_w = _round_to_step(src_w * scale)
    out_h = _round_to_step(src_h * scale)
    if max(out_w, out_h) > cap:
        shrink = cap / float(max(out_w, out_h))
        out_w = _round_to_step(out_w * shrink)
        out_h = _round_to_step(out_h * shrink)
    if max(out_w, out_h) < cap and long_edge >= 1:
        # Rounding can undershoot the cap on the long edge (e.g. 1272 → 1264).
        if out_w >= out_h:
            out_w = cap
        else:
            out_h = cap
    return out_w, out_h


def wan_dims_from_image_paths(
    *paths: str | Path,
    fallback: tuple[int, int] | None = None,
) -> tuple[int, int]:
    """Use the first readable still; if several, take max source width/height then scale."""
    from PIL import Image

    sizes: list[tuple[int, int]] = []
    for raw in paths:
        p = Path(raw)
        if not p.is_file():
            continue
        try:
            with Image.open(p) as im:
                iw, ih = im.size
        except OSError:
            continue
        if iw >= 1 and ih >= 1:
            sizes.append((iw, ih))
    if not sizes:
        if fallback is not None:
            return fallback
        return WAN_VIDEO_MAX_EDGE, WAN_VIDEO_MAX_EDGE
    src_w = max(s[0] for s in sizes)
    src_h = max(s[1] for s in sizes)
    return wan_dims_from_source(src_w, src_h)


def resolve_wan_job_dims(
    width: int | None,
    height: int | None,
    *paths: str | Path,
    fallback: tuple[int, int] | None = None,
) -> tuple[int, int]:
    """Explicit width+height win; otherwise 1280 long-edge from source stills."""
    if width is not None and height is not None:
        return int(width), int(height)
    return wan_dims_from_image_paths(
        *paths,
        fallback=fallback or (WAN_VIDEO_MAX_EDGE, WAN_VIDEO_MAX_EDGE),
    )
