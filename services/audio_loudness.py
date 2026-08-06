"""EBU R128 loudness analysis and normalization gain for timeline audio.

Measures integrated loudness (LUFS) with ffmpeg's ``ebur128`` filter and
converts the distance to the target into a linear gain. The gain is stored
non-destructively on the clip (``normalizationGain``) and applied as a
multiplier in both preview (volumeGainAt) and export (_volume_gain_at); the
source file is never rewritten.
"""

from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

# Streaming-style loudness target. -14 LUFS keeps dialogue/music previews hot
# without the +/-2x gain cap flattening most corrections.
TARGET_LUFS = -14.0
# Keep corrections inside the 0..2 gain range used by preview math before the
# HTML volume / export clamp to 1 (with headroom for user automation on top).
MIN_NORMALIZATION_GAIN = 0.25
MAX_NORMALIZATION_GAIN = 2.0

_LUFS_RE = re.compile(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS")


def measure_integrated_lufs(path: Path | str, timeout_sec: float = 120.0) -> float | None:
    """Integrated LUFS of the first audio stream, or None when unmeasurable."""
    from utils.video_utils import require_ffmpeg

    p = Path(path)
    if not p.is_file():
        return None
    try:
        ffmpeg = require_ffmpeg()
    except Exception as ex:
        logger.warning("ffmpeg unavailable for loudness probe: %s", ex)
        return None
    try:
        proc = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-nostats",
                "-i",
                str(p),
                "-map",
                "a:0",
                "-filter:a",
                "ebur128",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
    except (OSError, subprocess.SubprocessError) as ex:
        logger.warning("Loudness probe failed for %s: %s", p.name, ex)
        return None

    # Progress lines and the final summary both print "I: ... LUFS"; the last
    # match is the integrated summary value.
    matches = _LUFS_RE.findall(proc.stderr or "")
    if not matches:
        return None
    try:
        lufs = float(matches[-1])
    except ValueError:
        return None
    # ebur128 reports -70 for silence / undecodable input.
    if lufs <= -69.0:
        return None
    return lufs


def normalization_gain_for_lufs(
    measured_lufs: float, target_lufs: float = TARGET_LUFS
) -> float:
    """Linear gain moving ``measured_lufs`` to the target, clamped to safe range."""
    gain = 10.0 ** ((target_lufs - measured_lufs) / 20.0)
    return max(MIN_NORMALIZATION_GAIN, min(MAX_NORMALIZATION_GAIN, gain))


def analyze_normalization_gain(path: Path | str) -> float:
    """Measure and convert in one step; 1.0 (no change) when unmeasurable."""
    lufs = measure_integrated_lufs(path)
    if lufs is None:
        return 1.0
    return round(normalization_gain_for_lufs(lufs), 4)
