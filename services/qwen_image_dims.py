"""Official Qwen-Image / Edit Plus canvas buckets (native generate, no SR)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from PIL import Image

# Qwen-Image preferred resolutions (already multiples of 8).
QWEN_IMAGE_BUCKETS: tuple[tuple[int, int], ...] = (
    (1328, 1328),
    (1664, 928),
    (928, 1664),
    (1472, 1104),
    (1104, 1472),
    (1584, 1056),
    (1056, 1584),
)

QWEN_IMAGE_SQUARE = (1328, 1328)


def snap_to_qwen_bucket(w: int, h: int) -> tuple[int, int]:
    """Nearest official Qwen bucket by aspect ratio."""
    src_w = max(1, int(w))
    src_h = max(1, int(h))
    ar = src_w / src_h
    return min(QWEN_IMAGE_BUCKETS, key=lambda wh: abs((wh[0] / wh[1]) - ar))


def qwen_bucket_from_image_paths(*paths: str | Path) -> tuple[int, int]:
    """Bucket from the largest readable input (so a 1328 mesh wins over a 1024 still)."""
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
        return QWEN_IMAGE_SQUARE
    ref = max(sizes, key=lambda s: s[0] * s[1])
    return snap_to_qwen_bucket(ref[0], ref[1])


def resize_image_file_to_bucket(src: str | Path, width: int, height: int) -> str:
    """LANCZOS resize to WxH; writes a temp PNG. Returns src unchanged if already that size."""
    path = Path(src)
    with Image.open(path) as im:
        if im.size == (int(width), int(height)):
            return str(path)
        rgb = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
        out = rgb.resize((int(width), int(height)), Image.Resampling.LANCZOS)
        suffix = ".png"
        fd, tmp = tempfile.mkstemp(prefix="qwen_bucket_", suffix=suffix)
        os.close(fd)
        out.save(tmp, format="PNG")
        return tmp


def snap_paths_to_shared_qwen_bucket(
    primary: str,
    auxiliary: list[str],
) -> tuple[str, list[str], list[str]]:
    """Resize local primary + aux files to one Qwen bucket. Returns temps to delete."""
    locals_: list[str] = [p for p in (primary, *auxiliary) if p and os.path.isfile(p)]
    if not locals_:
        return primary, list(auxiliary), []
    bw, bh = qwen_bucket_from_image_paths(*locals_)
    temps: list[str] = []

    def snap_one(ref: str) -> str:
        if not ref or not os.path.isfile(ref):
            return ref
        out = resize_image_file_to_bucket(ref, bw, bh)
        if os.path.normpath(out) != os.path.normpath(ref):
            temps.append(out)
        return out

    return snap_one(primary), [snap_one(a) for a in auxiliary], temps

