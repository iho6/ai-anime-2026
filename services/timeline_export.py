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


def _require_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError(
            "ffmpeg is required for timeline audio export but was not found on PATH."
        )
    return exe


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


def _active_clip_at(track: dict[str, Any], t: float) -> dict[str, Any] | None:
    found: dict[str, Any] | None = None
    for clip in track.get("clips", []):
        if t >= float(clip.get("start", 0)) and t < _clip_end(clip):
            found = clip
    return found


def _source_time_at(clip: dict[str, Any], t: float) -> float:
    return float(clip.get("inPoint", 0)) + (t - float(clip.get("start", 0))) * float(
        clip.get("speed", 1)
    )


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

    def __init__(self, path: Path) -> None:
        import av

        self._path = path
        self._container = av.open(str(path))
        self._stream = self._container.streams.video[0]
        rate = self._stream.average_rate or self._stream.base_rate
        self._fps = float(rate) if rate else 24.0
        self._iter = self._container.decode(self._stream)
        self._idx = -1
        self._last: Any = None
        self._natural: tuple[int, int] | None = None

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
                rgb = av_frame.to_ndarray(format="rgb24")
                self._last = Image.fromarray(rgb).convert("RGBA")
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

    def close(self) -> None:
        if self._container is not None:
            self._container.close()
            self._container = None


class _CompositorState:
    def __init__(self) -> None:
        self._image_cache: dict[str, Any] = {}
        self._video_decoders: dict[str, _VideoFrameDecoder] = {}
        self._clip_dims: dict[str, tuple[int, int]] = {}

    def close(self) -> None:
        for dec in self._video_decoders.values():
            dec.close()
        self._video_decoders.clear()
        self._image_cache.clear()

    def _ensure_dims(self, clip: dict[str, Any], abs_path: Path) -> tuple[int, int]:
        cid = str(clip.get("id", ""))
        if cid not in self._clip_dims:
            self._clip_dims[cid] = _clip_natural_size(clip, abs_path)
        return self._clip_dims[cid]

    def get_rgba_frame(self, clip: dict[str, Any], abs_path: Path, source_time: float) -> Any:
        from PIL import Image

        key = str(abs_path)
        clip_type = str(clip.get("type", "image"))
        if clip_type == "image":
            if key not in self._image_cache:
                with Image.open(abs_path) as im:
                    self._image_cache[key] = im.convert("RGBA")
            return self._image_cache[key]

        cid = str(clip.get("id", key))
        if cid not in self._video_decoders:
            self._video_decoders[cid] = _VideoFrameDecoder(abs_path)
        out_point = float(clip.get("outPoint", 0))
        st = max(0.0, source_time)
        if out_point > 0 and st > out_point:
            st = out_point
        return self._video_decoders[cid].frame_at_source_time(st)

    def clip_with_dims(self, clip: dict[str, Any], abs_path: Path) -> dict[str, Any]:
        n_w, n_h = self._ensure_dims(clip, abs_path)
        out = dict(clip)
        out["naturalW"] = n_w
        out["naturalH"] = n_h
        return out


def _draw_clip_on_canvas(
    canvas: Any,
    pil_image: Any,
    rect: dict[str, float],
    rotation_deg: float,
    opacity: float,
) -> None:
    from PIL import Image

    w = int(round(rect["width"]))
    h = int(round(rect["height"]))
    if w < 1 or h < 1:
        return
    layer = pil_image.resize((w, h), Image.Resampling.LANCZOS).convert("RGBA")
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

    state = _CompositorState()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        with av.open(str(output_path), mode="w") as container:
            stream = container.add_stream("libx264", rate=fps)
            stream.width = frame_w
            stream.height = frame_h
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "23", "preset": "veryfast"}

            for n in range(total_frames):
                t = n / float(fps)
                canvas = Image.new("RGBA", (frame_w, frame_h), (0, 0, 0, 255))

                for track in reversed(video_tracks):
                    clip = _active_clip_at(track, t)
                    if not clip:
                        continue
                    rel = str(clip.get("srcRelPath") or "").strip()
                    if not rel:
                        continue
                    try:
                        abs_p = _resolve_storage_rel_file(rel)
                    except ValueError:
                        continue

                    clip_dim = state.clip_with_dims(clip, abs_p)
                    tf = clip_transform_at_playhead(clip_dim, t)
                    rect = _clip_image_rect(clip_dim, tf, frame_w, frame_h)
                    source_t = _source_time_at(clip, t)
                    rgba = state.get_rgba_frame(clip_dim, abs_p, source_t)
                    _draw_clip_on_canvas(
                        canvas,
                        rgba,
                        rect,
                        float(tf.get("rotation", 0)),
                        float(tf.get("opacity", 1)),
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
