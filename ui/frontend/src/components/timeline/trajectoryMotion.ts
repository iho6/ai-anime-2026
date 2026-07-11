/** Motion math mirrored in services/timeline_export.py for MP4 export. */
import type { TimelineClip, TrajectoryMotionId } from "../../lib/api";
import type { ClipTransform } from "./timelineUtil";
import { clamp } from "./timelineUtil";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const TAU = Math.PI * 2;

export const TRAJECTORY_MOTION_OPTIONS: { id: TrajectoryMotionId; label: string }[] = [
  { id: "none", label: "None" },
  { id: "pulse", label: "Pulse" },
  { id: "sway", label: "Sway" },
  { id: "flicker", label: "Flicker" },
  { id: "drift", label: "Drift" },
  { id: "bounce", label: "Bounce" },
  { id: "orbit", label: "Orbit" },
  { id: "overshoot", label: "Overshoot" },
  { id: "bob", label: "Bob" },
  { id: "shake", label: "Shake" },
  { id: "wiggle", label: "Wiggle" },
  { id: "jitter", label: "Jitter" },
];

export type MotionOffset = {
  dx: number;
  dy: number;
  dScale: number;
  dRotation: number;
  dOpacity: number;
};

const ZERO_OFFSET: MotionOffset = {
  dx: 0,
  dy: 0,
  dScale: 0,
  dRotation: 0,
  dOpacity: 0,
};

/** Interpolate waypoint path at playhead (no procedural motion). */
export function trajectoryTransformAt(
  clip: TimelineClip,
  playhead: number
): { x: number; y: number; scale: number } | null {
  const wps = clip.trajectory?.waypoints;
  if (!wps || wps.length < 2) return null;

  const t = clamp((playhead - clip.start) / clip.duration, 0, 1);

  let i = wps.length - 2;
  for (let j = 0; j < wps.length - 1; j++) {
    if (t <= wps[j + 1].t) {
      i = j;
      break;
    }
  }

  const a = wps[i];
  const b = wps[i + 1];
  const span = b.t - a.t;
  const s = span < 1e-9 ? 0 : clamp((t - a.t) / span, 0, 1);

  let x: number;
  let y: number;
  if (a.cpx != null && a.cpy != null) {
    const cp = { x: a.cpx, y: a.cpy };
    x = (1 - s) * (1 - s) * a.x + 2 * (1 - s) * s * cp.x + s * s * b.x;
    y = (1 - s) * (1 - s) * a.y + 2 * (1 - s) * s * cp.y + s * s * b.y;
  } else {
    x = lerp(a.x, b.x, s);
    y = lerp(a.y, b.y, s);
  }

  return { x, y, scale: lerp(a.scale, b.scale, s) };
}

function motionAmount(clip: TimelineClip): number {
  return clamp((clip.trajectory?.motionAmount ?? 50) / 100, 0, 1);
}

/** Fade procedural motion to zero over the last motionTailSec seconds of the clip. */
export function motionTailEnvelope(clip: TimelineClip, localTimeSec: number): number {
  const tailSec = Math.max(0, clip.trajectory?.motionTailSec ?? 0);
  if (tailSec <= 0) return 1;
  const duration = clip.duration;
  if (duration <= 0) return 1;
  const timeToEnd = duration - Math.max(0, localTimeSec);
  if (timeToEnd >= tailSec) return 1;
  if (timeToEnd <= 0) return 0;
  const u = clamp(timeToEnd / tailSec, 0, 1);
  return u * u * (3 - 2 * u);
}

function sinWave(t: number, hz: number): number {
  return Math.sin(TAU * hz * t);
}

/** Procedural offset layered on the path (fractional frame units unless noted). */
export function motionOffsetAt(clip: TimelineClip, localTimeSec: number): MotionOffset {
  const motion = clip.trajectory?.motion ?? "none";
  if (motion === "none") return ZERO_OFFSET;

  const amount = motionAmount(clip) * motionTailEnvelope(clip, localTimeSec);
  if (amount <= 0) return ZERO_OFFSET;

  const t = Math.max(0, localTimeSec);

  switch (motion) {
    case "pulse":
      return {
        ...ZERO_OFFSET,
        dScale: 0.04 * amount * sinWave(t, 1.2),
      };

    case "sway":
      return {
        dx: 0.02 * amount * sinWave(t, 0.6),
        dy: 0,
        dScale: 0,
        dRotation: 2.5 * amount * sinWave(t, 0.6 + 0.25),
        dOpacity: 0,
      };

    case "flicker":
      return {
        ...ZERO_OFFSET,
        dOpacity: -0.15 * amount * sinWave(t, 3),
      };

    case "drift":
      return {
        dx:
          amount *
          (0.012 * sinWave(t, 0.15) +
            0.008 * sinWave(t, 0.23 + 0.7) +
            0.005 * sinWave(t, 0.31 + 1.3)),
        dy:
          amount *
          (0.01 * sinWave(t, 0.19 + 0.4) +
            0.007 * sinWave(t, 0.27 + 1.1) +
            0.004 * sinWave(t, 0.33 + 2)),
        dScale: 0,
        dRotation: 0,
        dOpacity: 0,
      };

    case "bounce": {
      const period = 1.4;
      const tm = t % period;
      const k = 2.2;
      const omega = TAU * 2.5;
      return {
        ...ZERO_OFFSET,
        dy: 0.025 * amount * Math.exp(-k * tm) * Math.sin(omega * tm),
      };
    }

    case "orbit": {
      const f = 0.5;
      const r = 0.022 * amount;
      const ang = TAU * f * t;
      return {
        dx: r * Math.cos(ang),
        dy: r * Math.sin(ang),
        dScale: 0,
        dRotation: 0,
        dOpacity: 0,
      };
    }

    case "overshoot": {
      const settleSec = 1.2;
      if (t >= settleSec) return ZERO_OFFSET;
      const zeta = 0.45;
      const omega = TAU * 2.2;
      const env = Math.exp(-zeta * omega * t);
      const osc = Math.sin(omega * Math.sqrt(1 - zeta * zeta) * t);
      const amp = 0.03 * amount;
      return {
        dx: amp * env * osc,
        dy: amp * 0.35 * env * Math.cos(omega * 0.9 * t),
        dScale: 0,
        dRotation: 0,
        dOpacity: 0,
      };
    }

    case "bob":
      return {
        ...ZERO_OFFSET,
        dy: 0.02 * amount * sinWave(t, 0.8),
      };

    case "shake": {
      const a = 0.012 * amount;
      return {
        dx: a * (sinWave(t, 12) + 0.5 * sinWave(t, 17 + 0.3)),
        dy: a * 0.6 * sinWave(t, 23 + 0.5),
        dScale: 0,
        dRotation: 1.2 * amount * sinWave(t, 15),
        dOpacity: 0,
      };
    }

    case "wiggle":
      return {
        ...ZERO_OFFSET,
        dRotation: 3 * amount * sinWave(t, 2),
      };

    case "jitter": {
      const a = 0.006 * amount;
      return {
        dx: a * (sinWave(t, 8) + sinWave(t, 13 + 0.2) + 0.5 * sinWave(t, 19 + 0.8)),
        dy: a * (sinWave(t, 11 + 0.5) + 0.7 * sinWave(t, 16 + 1.1)),
        dScale: 0,
        dRotation: 0,
        dOpacity: 0,
      };
    }

    default:
      return ZERO_OFFSET;
  }
}

export function resolveTrajectoryTransformAt(
  clip: TimelineClip,
  playhead: number,
  opts: { applyMotion: boolean }
): ClipTransform | null {
  const base = trajectoryTransformAt(clip, playhead);
  if (!base) return null;

  if (!opts.applyMotion) {
    return { ...base, rotation: 0, opacity: 1 };
  }

  const localTimeSec = Math.max(0, playhead - clip.start);
  const off = motionOffsetAt(clip, localTimeSec);

  const opacity = clamp(1 + off.dOpacity, 0.05, 1);

  return {
    x: base.x + off.dx,
    y: base.y + off.dy,
    scale: Math.max(0.05, base.scale * (1 + off.dScale)),
    rotation: off.dRotation,
    opacity,
  };
}
