"""
WYSIWYG timeline MP4 export — frame compositor matching frontend preview layout.

Layout/transform math mirrors:
  ui/frontend/src/components/timeline/timelineUtil.ts
  ui/frontend/src/components/timeline/trajectoryMotion.ts
"""

from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

from services.character_storage import DEFAULT_STORAGE_ROOT
from services.logic import probe_video_meta
from utils.video_utils import require_ffmpeg as _require_ffmpeg

LOCATION_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "locations").resolve()
SHOTS_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "shots").resolve()
REFERENCES_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "references").resolve()
TIMELINES_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "timelines").resolve()
MOTION_REFS_STORAGE_ROOT = (DEFAULT_STORAGE_ROOT.parent / "motion_refs").resolve()

TAU = math.pi * 2
_EXPORT_MAX_W = 1920
_EXPORT_MAX_H = 1080
_LOG_EVERY_N_FRAMES = 30


# ── Storage path resolution ───────────────────────────────────────────────────


def _resolve_storage_rel_file(rel_path: str) -> Path:
    """Resolve clip ``srcRelPath`` (same roots as ``ui/api/storage_paths.py``)."""
    rel = Path(rel_path)
    parts = rel.parts
    if parts and parts[0].lower() == "locations":
        root = LOCATION_STORAGE_ROOT
        rel = Path(*parts[1:])
    elif parts and parts[0].lower() == "shots":
        root = SHOTS_STORAGE_ROOT
        rel = Path(*parts[1:])
    elif parts and parts[0].lower() == "references":
        root = REFERENCES_STORAGE_ROOT
        rel = Path(*parts[1:])
    elif parts and parts[0].lower() == "timelines":
        root = TIMELINES_STORAGE_ROOT
        rel = Path(*parts[1:])
    elif parts and parts[0].lower() == "motion_refs":
        root = MOTION_REFS_STORAGE_ROOT
        rel = Path(*parts[1:])
    else:
        root = DEFAULT_STORAGE_ROOT.resolve()
    target = (root / rel).resolve()
    if root != target and root not in target.parents:
        raise ValueError(f"Invalid storage path: {rel_path}")
    if not target.is_file():
        raise ValueError(f"File not found: {rel_path}")
    return target



# ── Layout helpers (keep in sync with timelineUtil.ts) ────────────────────────


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _aspect_ratio(preview_aspect: str) -> float:
    if preview_aspect == "4:3":
        return 4 / 3
    if preview_aspect == "1:1":
        return 1.0
    if preview_aspect == "9:16":
        return 9 / 16
    return 16 / 9


def _reference_frame_size(preview_aspect: str) -> tuple[int, int]:
    w = _EXPORT_MAX_W
    h = int(round(w / _aspect_ratio(preview_aspect)))
    if w % 2:
        w -= 1
    if h % 2:
        h -= 1
    return max(2, w), max(2, h)


def _contained_box_size(
    n_w: float, n_h: float, frame_w: float, frame_h: float
) -> tuple[float, float]:
    base_w, base_h = float(frame_w), float(frame_h)
    if n_w > 0 and n_h > 0 and frame_w > 0 and frame_h > 0:
        img_a = n_w / n_h
        frm_a = frame_w / frame_h
        if img_a > frm_a:
            base_w = frame_w
            base_h = frame_w / img_a
        else:
            base_h = frame_h
            base_w = frame_h * img_a
    return base_w, base_h


def _clip_image_rect(
    clip: dict[str, Any],
    tf: dict[str, float],
    frame_w: float,
    frame_h: float,
) -> dict[str, float]:
    n_w = float(clip.get("naturalW") or 0)
    n_h = float(clip.get("naturalH") or 0)
    base_w, base_h = _contained_box_size(n_w, n_h, frame_w, frame_h)
    scale = float(tf.get("scale", 1))
    w = base_w * scale
    h = base_h * scale
    cx = frame_w / 2 + float(tf.get("x", 0)) * frame_w
    cy = frame_h / 2 + float(tf.get("y", 0)) * frame_h
    return {"left": cx - w / 2, "top": cy - h / 2, "width": w, "height": h}


def _clip_end(clip: dict[str, Any]) -> float:
    return float(clip.get("start", 0)) + max(0.0, float(clip.get("duration", 0)))


def _timeline_duration(manifest: dict[str, Any]) -> float:
    max_end = 0.0
    for track in manifest.get("tracks", []):
        for clip in track.get("clips", []):
            max_end = max(max_end, _clip_end(clip))
    return max_end


_CONNECT_EPS = 0.05
_TRANSITION_DURATION_MIN = 0.1
_TRANSITION_DURATION_MAX = 2.0
_DEFAULT_TRANSITION_DURATION = 0.5


def _sorted_track_clips(track: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(track.get("clips", []), key=lambda c: float(c.get("start", 0)))


def _is_connected_pair(outgoing: dict[str, Any], incoming: dict[str, Any]) -> bool:
    return abs(_clip_end(outgoing) - float(incoming.get("start", 0))) <= _CONNECT_EPS


def _effective_transition_duration(
    outgoing: dict[str, Any], incoming: dict[str, Any]
) -> float:
    tr = outgoing.get("transitionOut") or {}
    raw = float(tr.get("duration") or _DEFAULT_TRANSITION_DURATION)
    capped = _clamp(raw, _TRANSITION_DURATION_MIN, _TRANSITION_DURATION_MAX)
    max_by_clips = min(
        float(outgoing.get("duration", 0)), float(incoming.get("duration", 0))
    ) * 0.5
    return min(capped, max(_TRANSITION_DURATION_MIN, max_by_clips))


def _smoothstep(p: float) -> float:
    t = max(0.0, min(1.0, p))
    return t * t * (3.0 - 2.0 * t)


def _resolve_transition_direction(tr: dict[str, Any]) -> str:
    return str(tr.get("direction") or "left")


def _compute_slide_offsets(
    direction: str, progress: float, role: str
) -> tuple[float, float]:
    p = max(0.0, min(1.0, progress))
    slide_x = 0.0
    slide_y = 0.0
    if direction == "left":
        slide_x = -(1.0 - p) if role == "incoming" else -p
    elif direction == "right":
        slide_x = (1.0 - p) if role == "incoming" else p
    elif direction == "up":
        slide_y = -(1.0 - p) if role == "incoming" else -p
    elif direction == "down":
        slide_y = (1.0 - p) if role == "incoming" else p
    return slide_x, slide_y


def _layers_for_transition(
    outgoing: dict[str, Any],
    incoming: dict[str, Any],
    progress: float,
    transition: dict[str, Any],
) -> list[dict[str, Any]]:
    type_ = str(transition.get("type") or "fade")
    direction = _resolve_transition_direction(transition)
    p = max(0.0, min(1.0, progress))
    base: dict[str, Any] = {
        "progress": p,
        "transitionType": type_,
        "direction": direction,
    }

    if type_ == "fade":
        return [
            {"clip": outgoing, "opacity": 1.0 - p, "role": "outgoing", **base},
            {"clip": incoming, "opacity": p, "role": "incoming", **base},
        ]
    if type_ == "dissolve":
        sp = _smoothstep(p)
        return [
            {"clip": outgoing, "opacity": 1.0 - sp, "role": "outgoing", **base},
            {"clip": incoming, "opacity": sp, "role": "incoming", **base},
        ]
    if type_ == "wipe":
        return [
            {"clip": outgoing, "opacity": 1.0, "role": "outgoing", **base},
            {"clip": incoming, "opacity": 1.0, "role": "incoming", **base},
        ]
    out_x, out_y = _compute_slide_offsets(direction, p, "outgoing")
    in_x, in_y = _compute_slide_offsets(direction, p, "incoming")
    return [
        {
            "clip": outgoing,
            "opacity": 1.0,
            "role": "outgoing",
            "slideOffsetX": out_x,
            "slideOffsetY": out_y,
            **base,
        },
        {
            "clip": incoming,
            "opacity": 1.0,
            "role": "incoming",
            "slideOffsetX": in_x,
            "slideOffsetY": in_y,
            **base,
        },
    ]


def _find_transition_window(
    track: dict[str, Any], t: float
) -> tuple[dict[str, Any], dict[str, Any], float, float] | None:
    if track.get("kind") != "video":
        return None
    sorted_clips = _sorted_track_clips(track)
    for i in range(1, len(sorted_clips)):
        outgoing = sorted_clips[i - 1]
        incoming = sorted_clips[i]
        tr = outgoing.get("transitionOut") or {}
        if not tr or not _is_connected_pair(outgoing, incoming):
            continue
        d = _effective_transition_duration(outgoing, incoming)
        fade_start = float(incoming.get("start", 0)) - d
        if t >= fade_start and t < float(incoming.get("start", 0)):
            progress = (t - fade_start) / d if d > 0 else 1.0
            return outgoing, incoming, progress, d
    return None


def _solo_layer(clip: dict[str, Any]) -> dict[str, Any]:
    return {"clip": clip, "opacity": 1.0, "role": "solo", "progress": 0.0}


def _active_layers_at(track: dict[str, Any], t: float) -> list[dict[str, Any]]:
    """Return layer dicts for compositing (mirrors timelineUtil.activeLayersAt)."""
    if track.get("kind") != "video":
        for c in track.get("clips", []):
            if t >= float(c.get("start", 0)) and t < _clip_end(c):
                return [_solo_layer(c)]
        return []

    win = _find_transition_window(track, t)
    if win:
        outgoing, incoming, progress, _d = win
        tr = outgoing.get("transitionOut") or {}
        return _layers_for_transition(outgoing, incoming, progress, tr)

    sorted_clips = _sorted_track_clips(track)
    for c in sorted_clips:
        if t >= float(c.get("start", 0)) and t < _clip_end(c):
            return [_solo_layer(c)]
    return []


def _active_clip_at(track: dict[str, Any], t: float) -> dict[str, Any] | None:
    layers = _active_layers_at(track, t)
    if not layers:
        return None
    return layers[-1]["clip"]


def _source_time_at_with_transition(
    clip: dict[str, Any], t: float, track: dict[str, Any]
) -> float:
    if str(clip.get("type")) != "video":
        return _source_time_at(clip, t)
    sorted_clips = _sorted_track_clips(track)
    idx = next((i for i, c in enumerate(sorted_clips) if c is clip), -1)
    if idx <= 0:
        return _source_time_at(clip, t)
    outgoing = sorted_clips[idx - 1]
    if not _is_connected_pair(outgoing, clip):
        return _source_time_at(clip, t)
    if not outgoing.get("transitionOut"):
        return _source_time_at(clip, t)
    d = _effective_transition_duration(outgoing, clip)
    fade_start = float(clip.get("start", 0)) - d
    if t >= fade_start and t < float(clip.get("start", 0)):
        local = max(0.0, t - fade_start)
        speed = float(clip.get("speed", 1))
        if clip.get("reversed"):
            return float(clip.get("outPoint", 0)) - local * speed
        return float(clip.get("inPoint", 0)) + local * speed
    return _source_time_at(clip, t)


def _source_time_at(clip: dict[str, Any], t: float) -> float:
    local = t - float(clip.get("start", 0))
    speed = float(clip.get("speed", 1))
    clip_type = str(clip.get("type") or "")
    if clip.get("reversed") and clip_type in ("video", "audio"):
        return float(clip.get("outPoint", 0)) - local * speed
    return float(clip.get("inPoint", 0)) + local * speed


# ── Trajectory + motion (keep in sync with trajectoryMotion.ts) ───────────────


def _trajectory_transform_at(
    clip: dict[str, Any], playhead: float
) -> dict[str, float] | None:
    traj = clip.get("trajectory") or {}
    wps = traj.get("waypoints") or []
    if len(wps) < 2:
        return None

    dur = float(clip.get("duration", 0))
    if dur <= 0:
        return None
    t = _clamp((playhead - float(clip.get("start", 0))) / dur, 0, 1)

    seg_i = len(wps) - 2
    for j in range(len(wps) - 1):
        if t <= float(wps[j + 1].get("t", 0)):
            seg_i = j
            break

    a = wps[seg_i]
    b = wps[seg_i + 1]
    span = float(b.get("t", 0)) - float(a.get("t", 0))
    s = 0.0 if span < 1e-9 else _clamp((t - float(a.get("t", 0))) / span, 0, 1)

    cpx = a.get("cpx")
    cpy = a.get("cpy")
    if cpx is not None and cpy is not None:
        cp_x, cp_y = float(cpx), float(cpy)
        x = (1 - s) ** 2 * float(a.get("x", 0)) + 2 * (1 - s) * s * cp_x + s**2 * float(
            b.get("x", 0)
        )
        y = (1 - s) ** 2 * float(a.get("y", 0)) + 2 * (1 - s) * s * cp_y + s**2 * float(
            b.get("y", 0)
        )
    else:
        x = _lerp(float(a.get("x", 0)), float(b.get("x", 0)), s)
        y = _lerp(float(a.get("y", 0)), float(b.get("y", 0)), s)

    return {
        "x": x,
        "y": y,
        "scale": _lerp(float(a.get("scale", 1)), float(b.get("scale", 1)), s),
    }


# ── Volume automation (keep in sync with volumeAutomation.ts) ────────────────

UNITY_VOLUME_LEVEL = 50.0


def _default_volume_points() -> list[dict[str, Any]]:
    return [{"t": 0.0, "level": UNITY_VOLUME_LEVEL}, {"t": 1.0, "level": UNITY_VOLUME_LEVEL}]


def _volume_level_at(clip: dict[str, Any], playhead: float) -> float:
    vol = clip.get("volumeAutomation") or {}
    wps = sorted(
        vol.get("points") or _default_volume_points(),
        key=lambda p: float(p.get("t", 0)),
    )
    if len(wps) < 2:
        wps = _default_volume_points()

    dur = float(clip.get("duration", 0))
    if dur <= 0:
        return UNITY_VOLUME_LEVEL
    t = _clamp((playhead - float(clip.get("start", 0))) / dur, 0, 1)

    seg_i = len(wps) - 2
    for j in range(len(wps) - 1):
        if t <= float(wps[j + 1].get("t", 0)):
            seg_i = j
            break

    a = wps[seg_i]
    b = wps[seg_i + 1]
    span = float(b.get("t", 0)) - float(a.get("t", 0))
    s = 0.0 if span < 1e-9 else _clamp((t - float(a.get("t", 0))) / span, 0, 1)

    cpt = a.get("cpt")
    cpl = a.get("cpl")
    if cpt is not None and cpl is not None:
        cp_l = float(cpl)
        return (
            (1 - s) ** 2 * float(a.get("level", UNITY_VOLUME_LEVEL))
            + 2 * (1 - s) * s * cp_l
            + s**2 * float(b.get("level", UNITY_VOLUME_LEVEL))
        )
    return _lerp(float(a.get("level", UNITY_VOLUME_LEVEL)), float(b.get("level", UNITY_VOLUME_LEVEL)), s)


def _volume_gain_at(clip: dict[str, Any], playhead: float) -> float:
    return _clamp(_volume_level_at(clip, playhead) / UNITY_VOLUME_LEVEL, 0, 2)


def _volume_envelope_needs_apply(clip: dict[str, Any]) -> bool:
    vol = clip.get("volumeAutomation")
    if not vol:
        return False
    for p in vol.get("points") or []:
        if p.get("cpt") is not None or p.get("cpl") is not None:
            return True
        if abs(float(p.get("level", UNITY_VOLUME_LEVEL)) - UNITY_VOLUME_LEVEL) > 0.01:
            return True
    return False


def _volume_envelope_filter_parts(clip: dict[str, Any], in_label: str, out_label: str) -> list[str]:
    in_pt = float(clip.get("inPoint", 0))
    out_pt = float(clip.get("outPoint", 0))
    speed = max(0.01, float(clip.get("speed", 1)))
    post_dur = max(1e-6, (out_pt - in_pt) / speed)
    step = 0.02
    parts: list[str] = []
    cur = in_label
    idx = 0
    t = 0.0
    while t < post_dur - 1e-9:
        t1 = min(post_dur, t + step)
        frac0 = t / post_dur
        frac1 = t1 / post_dur
        ph0 = float(clip.get("start", 0)) + frac0 * float(clip.get("duration", 0))
        ph1 = float(clip.get("start", 0)) + frac1 * float(clip.get("duration", 0))
        g = (_volume_gain_at(clip, ph0) + _volume_gain_at(clip, ph1)) / 2.0
        nxt = out_label if t1 >= post_dur - 1e-9 else f"{out_label}v{idx}"
        parts.append(
            f"[{cur}]volume=volume={g:.6f}:enable='between(t,{t:.6f},{t1:.6f})'[{nxt}]"
        )
        cur = nxt
        idx += 1
        t = t1
    return parts


def _sin_wave(t: float, hz: float) -> float:
    return math.sin(TAU * hz * t)


def _motion_amount(clip: dict[str, Any]) -> float:
    traj = clip.get("trajectory") or {}
    return _clamp(float(traj.get("motionAmount", 50)) / 100.0, 0, 1)


def _motion_offset_at(clip: dict[str, Any], local_time_sec: float) -> dict[str, float]:
    traj = clip.get("trajectory") or {}
    motion = str(traj.get("motion") or "none")
    zero = {"dx": 0.0, "dy": 0.0, "dScale": 0.0, "dRotation": 0.0, "dOpacity": 0.0}
    if motion == "none":
        return zero

    amount = _motion_amount(clip)
    if amount <= 0:
        return zero

    t = max(0.0, local_time_sec)

    if motion == "pulse":
        return {**zero, "dScale": 0.04 * amount * _sin_wave(t, 1.2)}
    if motion == "sway":
        return {
            "dx": 0.02 * amount * _sin_wave(t, 0.6),
            "dy": 0.0,
            "dScale": 0.0,
            "dRotation": 2.5 * amount * _sin_wave(t, 0.6 + 0.25),
            "dOpacity": 0.0,
        }
    if motion == "flicker":
        return {**zero, "dOpacity": -0.15 * amount * _sin_wave(t, 3)}
    if motion == "drift":
        return {
            "dx": amount
            * (
                0.012 * _sin_wave(t, 0.15)
                + 0.008 * _sin_wave(t, 0.23 + 0.7)
                + 0.005 * _sin_wave(t, 0.31 + 1.3)
            ),
            "dy": amount
            * (
                0.01 * _sin_wave(t, 0.19 + 0.4)
                + 0.007 * _sin_wave(t, 0.27 + 1.1)
                + 0.004 * _sin_wave(t, 0.33 + 2)
            ),
            "dScale": 0.0,
            "dRotation": 0.0,
            "dOpacity": 0.0,
        }
    if motion == "bounce":
        period = 1.4
        tm = t % period
        k = 2.2
        omega = TAU * 2.5
        return {**zero, "dy": 0.025 * amount * math.exp(-k * tm) * math.sin(omega * tm)}
    if motion == "orbit":
        f = 0.5
        r = 0.022 * amount
        ang = TAU * f * t
        return {
            "dx": r * math.cos(ang),
            "dy": r * math.sin(ang),
            "dScale": 0.0,
            "dRotation": 0.0,
            "dOpacity": 0.0,
        }
    if motion == "overshoot":
        settle_sec = 1.2
        if t >= settle_sec:
            return zero
        zeta = 0.45
        omega = TAU * 2.2
        env = math.exp(-zeta * omega * t)
        osc = math.sin(omega * math.sqrt(1 - zeta * zeta) * t)
        amp = 0.03 * amount
        return {
            "dx": amp * env * osc,
            "dy": amp * 0.35 * env * math.cos(omega * 0.9 * t),
            "dScale": 0.0,
            "dRotation": 0.0,
            "dOpacity": 0.0,
        }
    if motion == "bob":
        return {**zero, "dy": 0.02 * amount * _sin_wave(t, 0.8)}
    if motion == "shake":
        a = 0.012 * amount
        return {
            "dx": a * (_sin_wave(t, 12) + 0.5 * _sin_wave(t, 17 + 0.3)),
            "dy": a * 0.6 * _sin_wave(t, 23 + 0.5),
            "dScale": 0.0,
            "dRotation": 1.2 * amount * _sin_wave(t, 15),
            "dOpacity": 0.0,
        }
    if motion == "wiggle":
        return {**zero, "dRotation": 3 * amount * _sin_wave(t, 2)}
    if motion == "jitter":
        a = 0.006 * amount
        return {
            "dx": a
            * (
                _sin_wave(t, 8)
                + _sin_wave(t, 13 + 0.2)
                + 0.5 * _sin_wave(t, 19 + 0.8)
            ),
            "dy": a
            * (_sin_wave(t, 11 + 0.5) + 0.7 * _sin_wave(t, 16 + 1.1)),
            "dScale": 0.0,
            "dRotation": 0.0,
            "dOpacity": 0.0,
        }
    return zero


def _resolve_trajectory_transform_at(
    clip: dict[str, Any], playhead: float, *, apply_motion: bool
) -> dict[str, float] | None:
    base = _trajectory_transform_at(clip, playhead)
    if base is None:
        return None
    if not apply_motion:
        return {**base, "rotation": 0.0, "opacity": 1.0}

    local_time_sec = max(0.0, playhead - float(clip.get("start", 0)))
    off = _motion_offset_at(clip, local_time_sec)
    opacity = _clamp(1.0 + off["dOpacity"], 0.05, 1.0)
    return {
        "x": base["x"] + off["dx"],
        "y": base["y"] + off["dy"],
        "scale": max(0.05, base["scale"] * (1.0 + off["dScale"])),
        "rotation": off["dRotation"],
        "opacity": opacity,
    }


def clip_transform_at_playhead(clip: dict[str, Any], playhead: float) -> dict[str, float]:
    """Public helper for tests — matches ``clipTransformAtPlayhead`` in TS."""
    traj = _resolve_trajectory_transform_at(clip, playhead, apply_motion=True)
    if traj:
        return traj
    tf = clip.get("transform") or {"x": 0, "y": 0, "scale": 1}
    return {
        "x": float(tf.get("x", 0)),
        "y": float(tf.get("y", 0)),
        "scale": float(tf.get("scale", 1)),
        "rotation": 0.0,
        "opacity": 1.0,
    }


# ── Media loading ─────────────────────────────────────────────────────────────


def _alpha_companion_path(
    video_path: Path,
    alpha_rel: str | None = None,
) -> Path | None:
    """Resolve FFv1 alpha companion for WebM bg-removed clips."""
    if alpha_rel:
        try:
            resolved = _resolve_storage_rel_file(str(alpha_rel).strip())
            if resolved.is_file():
                return resolved
        except ValueError:
            pass
    companion = video_path.parent / (video_path.stem + ".alpha.mkv")
    return companion if companion.is_file() else None


def _clip_expects_alpha_companion(clip: dict[str, Any], video_path: Path) -> bool:
    if clip.get("alphaRelPath"):
        return True
    stem = video_path.stem.lower()
    return "_rmbg_" in stem or "_nobg_" in stem or "_anime_seg_" in stem


def _av_frame_to_rgba_image(av_frame: Any) -> Any:
    """Decode a PyAV video frame to PIL RGBA, preferring real alpha when present."""
    import numpy as np
    from PIL import Image

    for fmt in ("rgba", "yuva420p"):
        try:
            arr = av_frame.to_ndarray(format=fmt)
        except Exception:
            continue
        if fmt == "yuva420p" and arr.ndim == 3 and arr.shape[2] >= 4:
            rgba = arr[:, :, :4].copy()
            if rgba.dtype != np.uint8:
                rgba = rgba.astype(np.uint8)
            return Image.fromarray(rgba, mode="RGBA")
        if arr.ndim == 3 and arr.shape[2] == 4:
            if arr.dtype != np.uint8:
                arr = arr.astype(np.uint8)
            return Image.fromarray(arr, mode="RGBA")
    rgb = av_frame.to_ndarray(format="rgb24")
    if rgb.dtype != np.uint8:
        rgb = rgb.astype(np.uint8)
    h, w = rgb.shape[:2]
    alpha = np.full((h, w), 255, dtype=np.uint8)
    return Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA")


def _image_has_transparent_alpha(im_rgba: Any) -> bool:
    from PIL import Image

    if im_rgba.mode != "RGBA":
        im_rgba = im_rgba.convert("RGBA")
    lo, _hi = im_rgba.getchannel("A").getextrema()
    return int(lo) < 255


def _clip_has_exportable_frame_sequence(clip: dict[str, Any]) -> bool:
    from services.logic import _frame_sequence_strip_slot_visible_for_export

    fs = clip.get("frameSequence")
    if not isinstance(fs, dict):
        return False
    strip = fs.get("strip")
    if not isinstance(strip, list) or not strip:
        return False
    return any(
        isinstance(s, dict) and _frame_sequence_strip_slot_visible_for_export(s) for s in strip
    )


def _strip_frame_index_at_source_time(
    clip: dict[str, Any],
    strip: list[dict[str, Any]],
    manifest_fps: float,
    source_time: float,
) -> int:
    """Map trimmed source time to a strip slot index (one slot per extracted frame)."""
    in_point = float(clip.get("inPoint", 0))
    out_point = float(clip.get("outPoint", 0))
    st = source_time
    if out_point > 0:
        st = min(st, out_point)
    st = max(st, in_point)
    local_frames = (st - in_point) * float(manifest_fps)
    idx = int(round(local_frames))
    return max(0, min(idx, len(strip) - 1))


def _resolve_strip_slot_path(rel: str) -> Path:
    from services.logic import _timeline_strip_rel_to_abs

    rel_norm = str(rel or "").strip().replace("\\", "/").lstrip("/")
    if not rel_norm:
        raise ValueError("Strip slot relPath is empty.")
    return _timeline_strip_rel_to_abs(rel_norm)


def _strip_rgba_at_index(
    strip: list[dict[str, Any]],
    idx: int,
    image_cache: dict[str, Any],
) -> Any:
    """Hold-last-visible: empty/hidden slots repeat the previous visible PNG."""
    from PIL import Image

    from services.logic import _frame_sequence_strip_slot_visible_for_export

    target = max(0, min(int(idx), len(strip) - 1))
    last_im: Any = None
    for i in range(target + 1):
        slot = strip[i]
        if not isinstance(slot, dict):
            continue
        if str(slot.get("kind") or "") == "image" and slot.get("hidden") is True:
            continue
        if not _frame_sequence_strip_slot_visible_for_export(slot):
            continue
        rel = str(slot.get("relPath") or "").strip()
        if not rel:
            continue
        path = _resolve_strip_slot_path(rel)
        cache_key = str(path.resolve())
        if cache_key not in image_cache:
            with Image.open(path) as im:
                image_cache[cache_key] = im.convert("RGBA")
        last_im = image_cache[cache_key]
    if last_im is None:
        return Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    return last_im.copy()


def _log_overlapping_video_tracks(
    tracks: list[dict[str, Any]],
    log_cb: Callable[[str], None] | None,
) -> None:
    """Inform when multiple visible video clips overlap in time."""
    if not log_cb:
        return
    intervals: list[tuple[float, float, str]] = []
    for track in tracks:
        for clip in track.get("clips") or []:
            if str(clip.get("type") or "") not in ("video", "image"):
                continue
            rel = str(clip.get("srcRelPath") or "").strip()
            if not rel and not _clip_has_exportable_frame_sequence(clip):
                continue
            start = float(clip.get("start", 0))
            dur = float(clip.get("duration", 0))
            if dur <= 0:
                continue
            label = str(clip.get("id") or rel.split("/")[-1])
            intervals.append((start, start + dur, label))
    overlaps = False
    for i, (a0, a1, la) in enumerate(intervals):
        for b0, b1, lb in intervals[i + 1 :]:
            if a0 < b1 and b0 < a1:
                if not overlaps:
                    log_cb(
                        "Note: multiple visible video clips overlap in time "
                        "(e.g. original + bg-removed). Hide tracks you do not want exported."
                    )
                    overlaps = True
                    return


def _clip_natural_size(clip: dict[str, Any], abs_path: Path) -> tuple[int, int]:
    n_w = int(clip.get("naturalW") or 0)
    n_h = int(clip.get("naturalH") or 0)
    if n_w > 0 and n_h > 0:
        return n_w, n_h
    if str(clip.get("type")) == "image":
        from PIL import Image

        with Image.open(abs_path) as im:
            return im.size
    meta = probe_video_meta(abs_path)
    return int(meta.get("width") or 0), int(meta.get("height") or 0)


class _VideoFrameDecoder:
    """Sequential PyAV decoder with hold-last-frame at EOF."""

    def __init__(
        self,
        path: Path,
        clip: dict[str, Any],
        *,
        log_cb: Callable[[str], None] | None = None,
        warned: set[str] | None = None,
    ) -> None:
        import av

        self._path = path
        self._clip = clip
        self._log_cb = log_cb
        self._warned = warned if warned is not None else set()
        self._container = av.open(str(path))
        self._stream = self._container.streams.video[0]
        rate = self._stream.average_rate or self._stream.base_rate
        self._fps = float(rate) if rate else 24.0
        self._iter = self._container.decode(self._stream)
        self._idx = -1
        self._last: Any = None
        self._natural: tuple[int, int] | None = None

        alpha_rel = str(clip.get("alphaRelPath") or "").strip() or None
        alpha_path = _alpha_companion_path(path, alpha_rel)
        if alpha_path is not None:
            self._alpha_container: Any = av.open(str(alpha_path))
            self._alpha_iter: Any = self._alpha_container.decode(
                self._alpha_container.streams.video[0]
            )
        else:
            self._alpha_container = None
            self._alpha_iter = None
            if _clip_expects_alpha_companion(clip, path):
                warn_key = str(path.resolve())
                if warn_key not in self._warned:
                    self._warned.add(warn_key)
                    msg = (
                        f"Alpha companion missing for {path.name}; "
                        "export may show the original background. "
                        f"Expected {path.stem}.alpha.mkv beside the WebM."
                    )
                    if self._log_cb:
                        self._log_cb(msg)

    @property
    def natural_size(self) -> tuple[int, int]:
        if self._natural is None:
            self._natural = (int(self._stream.width or 0), int(self._stream.height or 0))
        return self._natural

    def frame_at_source_time(self, source_time: float) -> Any:
        from PIL import Image

        target = max(0, int(round(source_time * self._fps)))
        if target < self._idx:
            self._reopen()
        while self._idx < target:
            try:
                av_frame = next(self._iter)
                self._idx += 1
                if self._alpha_iter is not None:
                    try:
                        alpha_frame = next(self._alpha_iter)
                        import numpy as np

                        color_np = av_frame.to_ndarray(format="rgb24")
                        alpha_np = alpha_frame.to_ndarray(format="gray")
                        combined = np.dstack([color_np, alpha_np])
                        self._last = Image.fromarray(combined, mode="RGBA")
                    except StopIteration:
                        self._last = _av_frame_to_rgba_image(av_frame)
                else:
                    self._last = _av_frame_to_rgba_image(av_frame)
            except StopIteration:
                break
        if self._last is None:
            return Image.new("RGBA", (64, 64), (0, 0, 0, 255))
        return self._last.copy()

    def _reopen(self) -> None:
        import av

        self.close()
        self._container = av.open(str(self._path))
        self._stream = self._container.streams.video[0]
        self._iter = self._container.decode(self._stream)
        self._idx = -1
        alpha_rel = str(self._clip.get("alphaRelPath") or "").strip() or None
        alpha_path = _alpha_companion_path(self._path, alpha_rel)
        if alpha_path is not None:
            self._alpha_container = av.open(str(alpha_path))
            self._alpha_iter = self._alpha_container.decode(
                self._alpha_container.streams.video[0]
            )
        else:
            self._alpha_container = None
            self._alpha_iter = None

    def close(self) -> None:
        if self._container is not None:
            self._container.close()
            self._container = None
        if self._alpha_container is not None:
            self._alpha_container.close()
            self._alpha_container = None


class _CompositorState:
    def __init__(
        self,
        manifest_fps: float,
        log_cb: Callable[[str], None] | None = None,
    ) -> None:
        self._manifest_fps = float(manifest_fps)
        self._log_cb = log_cb
        self._image_cache: dict[str, Any] = {}
        self._strip_image_cache: dict[str, Any] = {}
        self._video_decoders: dict[str, _VideoFrameDecoder] = {}
        self._clip_dims: dict[str, tuple[int, int]] = {}
        self._alpha_warnings: set[str] = set()

    def close(self) -> None:
        for dec in self._video_decoders.values():
            dec.close()
        self._video_decoders.clear()
        self._image_cache.clear()
        self._strip_image_cache.clear()

    def _ensure_dims(self, clip: dict[str, Any], abs_path: Path) -> tuple[int, int]:
        cid = str(clip.get("id", ""))
        if cid not in self._clip_dims:
            self._clip_dims[cid] = _clip_natural_size(clip, abs_path)
        return self._clip_dims[cid]

    def _strip_rgba_at_source_time(
        self, clip: dict[str, Any], source_time: float
    ) -> Any:
        fs = clip.get("frameSequence") or {}
        strip = fs.get("strip") or []
        if not isinstance(strip, list):
            strip = []
        idx = _strip_frame_index_at_source_time(
            clip, strip, self._manifest_fps, source_time
        )
        return _strip_rgba_at_index(strip, idx, self._strip_image_cache)

    def get_rgba_frame(self, clip: dict[str, Any], abs_path: Path, source_time: float) -> Any:
        from PIL import Image

        in_point = float(clip.get("inPoint", 0))
        out_point = float(clip.get("outPoint", 0))
        st = source_time
        if out_point > 0:
            st = min(st, out_point)
        st = max(st, in_point)

        if _clip_has_exportable_frame_sequence(clip):
            return self._strip_rgba_at_source_time(clip, st)

        key = str(abs_path)
        clip_type = str(clip.get("type", "image"))
        if clip_type == "image":
            if key not in self._image_cache:
                with Image.open(abs_path) as im:
                    self._image_cache[key] = im.convert("RGBA")
            return self._image_cache[key]

        cid = str(clip.get("id", key))
        if cid not in self._video_decoders:
            self._video_decoders[cid] = _VideoFrameDecoder(
                abs_path,
                clip,
                log_cb=self._log_cb,
                warned=self._alpha_warnings,
            )
        return self._video_decoders[cid].frame_at_source_time(st)

    def clip_with_dims(self, clip: dict[str, Any], abs_path: Path) -> dict[str, Any]:
        n_w, n_h = self._ensure_dims(clip, abs_path)
        out = dict(clip)
        out["naturalW"] = n_w
        out["naturalH"] = n_h
        return out


_ARTBOARD = 1000.0


def _point_on_segment(a: dict[str, Any], b: dict[str, Any], t: float) -> tuple[float, float]:
    h_out = a.get("handleOut")
    h_in = b.get("handleIn")
    if h_out and h_in:
        u = 1.0 - t
        ax, ay = float(a.get("x", 0)), float(a.get("y", 0))
        bx, by = float(b.get("x", 0)), float(b.get("y", 0))
        cox, coy = float(h_out.get("x", 0)), float(h_out.get("y", 0))
        cix, ciy = float(h_in.get("x", 0)), float(h_in.get("y", 0))
        x = u * u * u * ax + 3 * u * u * t * cox + 3 * u * t * t * cix + t * t * t * bx
        y = u * u * u * ay + 3 * u * u * t * coy + 3 * u * t * t * ciy + t * t * t * by
        return x, y
    ax, ay = float(a.get("x", 0)), float(a.get("y", 0))
    bx, by = float(b.get("x", 0)), float(b.get("y", 0))
    return ax + (bx - ax) * t, ay + (by - ay) * t


def _sample_geometry_points(geometry: dict[str, Any], samples: int = 32) -> list[tuple[float, float]]:
    pts = geometry.get("points") or []
    if len(pts) < 2:
        return [(float(p.get("x", 0)), float(p.get("y", 0))) for p in pts]
    closed = bool(geometry.get("closed"))
    seg_count = len(pts) if closed else len(pts) - 1
    out: list[tuple[float, float]] = []
    for i in range(seg_count):
        a = pts[i]
        b = pts[(i + 1) % len(pts)]
        for s in range(samples + 1):
            t = s / float(samples)
            out.append(_point_on_segment(a, b, t))
    return out


def _layer_wipe_mask(rect: dict[str, float], layer: dict[str, Any]) -> Any | None:
    if layer.get("transitionType") != "wipe" or layer.get("role") != "incoming":
        return None
    w = max(1, int(round(rect["width"])))
    h = max(1, int(round(rect["height"])))
    return _wipe_reveal_mask(
        w,
        h,
        str(layer.get("direction") or "left"),
        float(layer.get("progress") or 0),
    )


def _draw_geometry_on_canvas(
    canvas: Any,
    clip: dict[str, Any],
    rect: dict[str, float],
    rotation_deg: float,
    opacity: float,
    *,
    wipe_mask: Any | None = None,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
) -> None:
    from PIL import Image, ImageDraw

    rect = _rect_with_slide(rect, offset_x, offset_y)
    geometry = clip.get("geometry") or {}
    pts_local = _sample_geometry_points(geometry, 32)
    if not pts_local:
        return

    w = max(1, int(round(rect["width"])))
    h = max(1, int(round(rect["height"])))
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    poly = [(p[0] * w, p[1] * h) for p in pts_local]
    fill = geometry.get("fill") or "none"
    stroke_info = geometry.get("stroke") or {}
    stroke = stroke_info.get("color") or "#000000"
    stroke_w = max(1, int(round(float(stroke_info.get("width", 2)) * (w / _ARTBOARD))))

    if geometry.get("closed") and fill and fill != "none":
        draw.polygon(poly, fill=fill, outline=stroke, width=stroke_w)
    else:
        if len(poly) >= 2:
            draw.line(poly, fill=stroke, width=stroke_w, joint="curve")

    if wipe_mask is not None:
        layer = _apply_wipe_mask_to_layer(layer, wipe_mask)
    if opacity < 1.0:
        r, g, b, a = layer.split()
        a = a.point(lambda p: int(p * opacity))
        layer = Image.merge("RGBA", (r, g, b, a))

    if rotation_deg:
        layer = layer.rotate(
            -rotation_deg,
            resample=Image.Resampling.BILINEAR,
            expand=True,
        )

    cx = rect["left"] + rect["width"] / 2
    cy = rect["top"] + rect["height"] / 2
    paste_x = int(round(cx - layer.width / 2))
    paste_y = int(round(cy - layer.height / 2))
    canvas.alpha_composite(layer, (paste_x, paste_y))


def _parse_hex_color(color: str) -> tuple[int, int, int, int]:
    c = str(color or "#ffffff").strip()
    if c.startswith("#") and len(c) >= 7:
        return (
            int(c[1:3], 16),
            int(c[3:5], 16),
            int(c[5:7], 16),
            255,
        )
    return (255, 255, 255, 255)


def _draw_text_on_canvas(
    canvas: Any,
    clip: dict[str, Any],
    rect: dict[str, float],
    rotation_deg: float,
    opacity: float,
    *,
    wipe_mask: Any | None = None,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
) -> None:
    from PIL import Image, ImageDraw, ImageFont

    from services.timeline_fonts import resolve_timeline_font_path

    rect = _rect_with_slide(rect, offset_x, offset_y)
    text = clip.get("text") or {}
    content = str(text.get("content") or "")
    if not content:
        return

    w = max(1, int(round(rect["width"])))
    h = max(1, int(round(rect["height"])))
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    font_size = max(8, int(round(float(text.get("fontSize", 48)) * (h / _ARTBOARD))))
    family_id = str(text.get("fontFamilyId") or "inter")
    weight = int(text.get("fontWeight") or 400)
    try:
        font_path = resolve_timeline_font_path(family_id, weight)
        font = ImageFont.truetype(str(font_path), font_size)
    except (OSError, FileNotFoundError):
        font = ImageFont.load_default()

    color = _parse_hex_color(str(text.get("color") or "#ffffff"))
    if opacity < 1.0:
        color = (color[0], color[1], color[2], int(color[3] * opacity))

    align = str(text.get("align") or "center")
    bbox = draw.multiline_textbbox((0, 0), content, font=font, align=align)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    if align == "left":
        x = 4
    elif align == "right":
        x = max(4, w - tw - 4)
    else:
        x = max(0, (w - tw) // 2)
    y = max(0, (h - th) // 2)
    draw.multiline_text((x, y), content, font=font, fill=color, align=align)

    if wipe_mask is not None:
        layer = _apply_wipe_mask_to_layer(layer, wipe_mask)

    if rotation_deg:
        layer = layer.rotate(
            -rotation_deg,
            resample=Image.Resampling.BILINEAR,
            expand=True,
        )

    cx = rect["left"] + rect["width"] / 2
    cy = rect["top"] + rect["height"] / 2
    paste_x = int(round(cx - layer.width / 2))
    paste_y = int(round(cy - layer.height / 2))
    canvas.alpha_composite(layer, (paste_x, paste_y))


def _wipe_reveal_mask(
    width: int, height: int, direction: str, progress: float
) -> Any:
    from PIL import Image, ImageDraw

    w = max(1, width)
    h = max(1, height)
    p = max(0.0, min(1.0, progress))
    mask = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(mask)
    if direction == "left":
        draw.rectangle([0, 0, int(w * p), h], fill=255)
    elif direction == "right":
        draw.rectangle([int(w * (1.0 - p)), 0, w, h], fill=255)
    elif direction == "up":
        draw.rectangle([0, 0, w, int(h * p)], fill=255)
    else:
        draw.rectangle([0, int(h * (1.0 - p)), w, h], fill=255)
    return mask


def _rect_with_slide(
    rect: dict[str, float], offset_x: float, offset_y: float
) -> dict[str, float]:
    if not offset_x and not offset_y:
        return rect
    return {
        **rect,
        "left": rect["left"] + offset_x * rect["width"],
        "top": rect["top"] + offset_y * rect["height"],
    }


def _apply_wipe_mask_to_layer(layer: Any, wipe_mask: Any | None) -> Any:
    from PIL import Image

    if wipe_mask is None:
        return layer
    if layer.size != wipe_mask.size:
        wipe_mask = wipe_mask.resize(layer.size, Image.Resampling.NEAREST)
    r, g, b, a = layer.split()
    a = Image.composite(a, Image.new("L", layer.size, 0), wipe_mask)
    return Image.merge("RGBA", (r, g, b, a))


def _draw_clip_on_canvas(
    canvas: Any,
    pil_image: Any,
    rect: dict[str, float],
    rotation_deg: float,
    opacity: float,
    *,
    wipe_mask: Any | None = None,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
) -> None:
    from PIL import Image

    rect = _rect_with_slide(rect, offset_x, offset_y)
    w = int(round(rect["width"]))
    h = int(round(rect["height"]))
    if w < 1 or h < 1:
        return
    layer = pil_image.resize((w, h), Image.Resampling.LANCZOS).convert("RGBA")
    if wipe_mask is not None:
        layer = _apply_wipe_mask_to_layer(layer, wipe_mask)
    if opacity < 1.0:
        r, g, b, a = layer.split()
        a = a.point(lambda p: int(p * opacity))
        layer = Image.merge("RGBA", (r, g, b, a))
    if rotation_deg:
        layer = layer.rotate(
            -rotation_deg,
            resample=Image.Resampling.BILINEAR,
            expand=True,
        )
    cx = rect["left"] + rect["width"] / 2
    cy = rect["top"] + rect["height"] / 2
    paste_x = int(round(cx - layer.width / 2))
    paste_y = int(round(cy - layer.height / 2))
    canvas.alpha_composite(layer, (paste_x, paste_y))


def _flatten_rgba_to_rgb(im_rgba: Any) -> Any:
    from PIL import Image

    if im_rgba.mode != "RGBA":
        im_rgba = im_rgba.convert("RGBA")
    w, h = im_rgba.size
    bg = Image.new("RGB", (w, h), (0, 0, 0))
    bg.paste(im_rgba, mask=im_rgba.split()[3])
    return bg


def _visible_video_tracks(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        t
        for t in manifest.get("tracks", [])
        if t.get("kind") == "video" and not t.get("hidden")
    ]


def _visible_audio_tracks(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        t
        for t in manifest.get("tracks", [])
        if t.get("kind") == "audio" and not t.get("hidden")
    ]


def _collect_audio_clips(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    clips: list[dict[str, Any]] = []
    for track in _visible_audio_tracks(manifest):
        for clip in track.get("clips", []):
            rel = str(clip.get("srcRelPath") or "").strip()
            if rel and str(clip.get("type")) == "audio":
                clips.append(clip)
    return clips


def _has_exportable_video(manifest: dict[str, Any]) -> bool:
    for track in _visible_video_tracks(manifest):
        for clip in track.get("clips", []):
            clip_type = str(clip.get("type") or "")
            if clip_type in ("geometry", "text"):
                return True
            if str(clip.get("srcRelPath") or "").strip():
                return True
    return False


def _atempo_filters(speed: float) -> str:
    filters: list[str] = []
    s = max(0.01, float(speed))
    while s > 2.0:
        filters.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        filters.append("atempo=0.5")
        s /= 0.5
    filters.append(f"atempo={s:.6f}")
    return ",".join(filters)


def _mix_timeline_audio(
    manifest: dict[str, Any],
    duration_sec: float,
    output_aac: Path,
    log_cb: Callable[[str], None] | None,
) -> bool:
    """Return True if an audio file was written."""
    audio_clips = _collect_audio_clips(manifest)
    if not audio_clips:
        return False

    ffmpeg = _require_ffmpeg()
    inputs: list[str] = []
    filter_parts: list[str] = []
    resolved: list[tuple[dict[str, Any], Path]] = []

    for clip in audio_clips:
        rel = str(clip.get("srcRelPath") or "").strip()
        try:
            abs_p = _resolve_storage_rel_file(rel)
        except ValueError as ex:
            if log_cb:
                log_cb(f"Skipping audio {rel}: {ex}")
            continue
        resolved.append((clip, abs_p))

    if not resolved:
        return False

    for abs_p in (p for _, p in resolved):
        inputs.extend(["-i", str(abs_p)])

    for i, (clip, _) in enumerate(resolved):
        in_pt = float(clip.get("inPoint", 0))
        out_pt = float(clip.get("outPoint", 0))
        speed = float(clip.get("speed", 1))
        start_ms = int(round(float(clip.get("start", 0)) * 1000))
        trim = f"atrim=start={in_pt:.6f}:end={out_pt:.6f},asetpts=PTS-STARTPTS"
        tempo = _atempo_filters(speed)
        if _volume_envelope_needs_apply(clip):
            pre = f"a{i}pre"
            vol_out = f"a{i}vol"
            filter_parts.append(f"[{i}:a]{trim},{tempo}[{pre}]")
            filter_parts.extend(_volume_envelope_filter_parts(clip, pre, vol_out))
            filter_parts.append(f"[{vol_out}]adelay={start_ms}|{start_ms}[a{i}]")
        else:
            chain = f"[{i}:a]{trim},{tempo},adelay={start_ms}|{start_ms}[a{i}]"
            filter_parts.append(chain)

    mix_inputs = "".join(f"[a{i}]" for i in range(len(resolved)))
    filter_parts.append(
        f"{mix_inputs}amix=inputs={len(resolved)}:duration=longest:dropout_transition=0[aout]"
    )
    filter_complex = ";".join(filter_parts)

    cmd = [
        ffmpeg,
        "-y",
        *inputs,
        "-filter_complex",
        filter_complex,
        "-map",
        "[aout]",
        "-t",
        f"{duration_sec:.6f}",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        str(output_aac),
    ]
    if log_cb:
        log_cb(f"Mixing {len(resolved)} audio clip(s)...")
    subprocess.run(cmd, check=True, capture_output=True)
    return output_aac.is_file()


def _render_video_track(
    manifest: dict[str, Any],
    output_path: Path,
    log_cb: Callable[[str], None] | None,
) -> tuple[int, int, float, int]:
    import av
    import numpy as np
    from PIL import Image

    fps = max(1, min(120, int(manifest.get("fps", 30))))
    preview_aspect = str(manifest.get("previewAspect") or "16:9")
    frame_w, frame_h = _reference_frame_size(preview_aspect)
    duration_sec = _timeline_duration(manifest)
    if duration_sec <= 0:
        raise ValueError("Timeline has zero duration.")

    total_frames = max(1, int(math.ceil(duration_sec * fps)))
    video_tracks = _visible_video_tracks(manifest)
    if not video_tracks:
        raise ValueError("No visible video tracks to export.")

    if log_cb:
        log_cb(
            "Hide original clips on other tracks when exporting bg-removed versions only."
        )
        _log_overlapping_video_tracks(video_tracks, log_cb)

    state = _CompositorState(fps, log_cb=log_cb)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    from services.utils import av_output_framerate

    out_rate = av_output_framerate(fps)

    try:
        with av.open(str(output_path), mode="w") as container:
            stream = container.add_stream("libx264", rate=out_rate)
            stream.width = frame_w
            stream.height = frame_h
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "23", "preset": "veryfast"}

            for n in range(total_frames):
                t = n / float(fps)
                canvas = Image.new("RGBA", (frame_w, frame_h), (0, 0, 0, 255))

                for track in reversed(video_tracks):
                    for layer in _active_layers_at(track, t):
                        clip = layer["clip"]
                        layer_op = float(layer.get("opacity", 1))
                        slide_x = float(layer.get("slideOffsetX") or 0)
                        slide_y = float(layer.get("slideOffsetY") or 0)
                        if (
                            layer_op <= 0.001
                            and not slide_x
                            and not slide_y
                            and layer.get("transitionType") != "wipe"
                        ):
                            continue
                        clip_type = str(clip.get("type") or "")
                        clip_dim = dict(clip)
                        n_w = float(clip.get("naturalW") or 0)
                        n_h = float(clip.get("naturalH") or 0)
                        if n_w > 0 and n_h > 0:
                            clip_dim["naturalW"] = n_w
                            clip_dim["naturalH"] = n_h
                        tf = clip_transform_at_playhead(clip_dim, t)
                        rect = _clip_image_rect(clip_dim, tf, frame_w, frame_h)
                        rot = float(tf.get("rotation", 0))
                        op = float(tf.get("opacity", 1)) * layer_op
                        wipe_mask = _layer_wipe_mask(rect, layer)

                        if clip_type == "geometry":
                            _draw_geometry_on_canvas(
                                canvas,
                                clip,
                                rect,
                                rot,
                                op,
                                wipe_mask=wipe_mask,
                                offset_x=slide_x,
                                offset_y=slide_y,
                            )
                            continue
                        if clip_type == "text":
                            _draw_text_on_canvas(
                                canvas,
                                clip,
                                rect,
                                rot,
                                op,
                                wipe_mask=wipe_mask,
                                offset_x=slide_x,
                                offset_y=slide_y,
                            )
                            continue

                        rel = str(clip.get("srcRelPath") or "").strip()
                        if not rel:
                            continue
                        try:
                            abs_p = _resolve_storage_rel_file(rel)
                        except ValueError:
                            continue

                        clip_dim = state.clip_with_dims(clip_dim, abs_p)
                        tf = clip_transform_at_playhead(clip_dim, t)
                        rect = _clip_image_rect(clip_dim, tf, frame_w, frame_h)
                        wipe_mask = _layer_wipe_mask(rect, layer)
                        source_t = _source_time_at_with_transition(clip, t, track)
                        rgba = state.get_rgba_frame(clip_dim, abs_p, source_t)
                        _draw_clip_on_canvas(
                            canvas,
                            rgba,
                            rect,
                            rot,
                            op,
                            wipe_mask=wipe_mask,
                            offset_x=slide_x,
                            offset_y=slide_y,
                        )

                rgb = _flatten_rgba_to_rgb(canvas)
                arr = np.asarray(rgb, dtype=np.uint8)
                frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
                frame = frame.reformat(format="yuv420p")
                for packet in stream.encode(frame):
                    if packet is not None:
                        container.mux(packet)

                if log_cb and n % _LOG_EVERY_N_FRAMES == 0:
                    log_cb(f"Rendering frame {n + 1}/{total_frames}")

            for packet in stream.encode(None):
                if packet is not None:
                    container.mux(packet)
    finally:
        state.close()

    return frame_w, frame_h, duration_sec, fps


def write_timeline_manifest_mp4(
    manifest: dict[str, Any],
    timeline_dir: Path,
    output_path: Path,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """
    Composite timeline manifest to MP4 (video + mixed audio).

    ``timeline_dir`` is reserved for future temp artifacts; clip paths come from
    manifest ``srcRelPath`` via storage resolution.
    """
    _ = timeline_dir  # reserved
    if not _has_exportable_video(manifest):
        raise ValueError("No video/image clips found.")

    if log_cb:
        log_cb("Starting composited export...")

    out_dir = output_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="timeline_export_") as tmp:
        tmp_dir = Path(tmp)
        video_only = tmp_dir / "video_only.mp4"
        _render_video_track(manifest, video_only, log_cb)
        duration_sec = _timeline_duration(manifest)

        audio_aac = tmp_dir / "mixed.aac"
        has_audio = _mix_timeline_audio(manifest, duration_sec, audio_aac, log_cb)

        if has_audio:
            ffmpeg = _require_ffmpeg()
            if log_cb:
                log_cb("Muxing video and audio...")
            subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-i",
                    str(video_only),
                    "-i",
                    str(audio_aac),
                    "-c:v",
                    "copy",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "192k",
                    "-shortest",
                    str(output_path),
                ],
                check=True,
                capture_output=True,
            )
        else:
            shutil.copy2(video_only, output_path)

    if log_cb:
        log_cb(f"Done -> {output_path.name}")
