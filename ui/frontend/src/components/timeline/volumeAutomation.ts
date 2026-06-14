import type { TimelineClip } from "../../lib/api";
import { clamp } from "./timelineUtil";

export type VolumeAutomationPoint = NonNullable<
  TimelineClip["volumeAutomation"]
>["points"][number];

const UNITY_LEVEL = 50;

export function defaultVolumeAutomationPoints(): VolumeAutomationPoint[] {
  return [
    { t: 0, level: UNITY_LEVEL },
    { t: 1, level: UNITY_LEVEL },
  ];
}

export function levelToGain(level: number): number {
  return clamp(level / UNITY_LEVEL, 0, 2);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sortedPoints(clip: TimelineClip): VolumeAutomationPoint[] {
  const pts = clip.volumeAutomation?.points;
  if (!pts || pts.length < 2) return defaultVolumeAutomationPoints();
  return [...pts].sort((a, b) => a.t - b.t);
}

/** Interpolate automation level (0–100) at timeline playhead. */
export function volumeLevelAt(clip: TimelineClip, playhead: number): number {
  const wps = sortedPoints(clip);
  const dur = clip.duration;
  if (dur <= 0) return UNITY_LEVEL;

  const t = clamp((playhead - clip.start) / dur, 0, 1);

  let segI = wps.length - 2;
  for (let j = 0; j < wps.length - 1; j++) {
    if (t <= wps[j + 1].t) {
      segI = j;
      break;
    }
  }

  const a = wps[segI];
  const b = wps[segI + 1];
  const span = b.t - a.t;
  const s = span < 1e-9 ? 0 : clamp((t - a.t) / span, 0, 1);

  if (a.cpt != null && a.cpl != null) {
    return (
      (1 - s) * (1 - s) * a.level +
      2 * (1 - s) * s * a.cpl +
      s * s * b.level
    );
  }
  return lerp(a.level, b.level, s);
}

export function volumeGainAt(clip: TimelineClip, playhead: number): number {
  return levelToGain(volumeLevelAt(clip, playhead));
}

export function isFlatVolumeAutomation(
  points: VolumeAutomationPoint[] | undefined
): boolean {
  if (!points || points.length === 0) return true;
  for (const p of points) {
    if (p.cpt != null || p.cpl != null) return false;
    if (Math.abs(p.level - UNITY_LEVEL) > 0.01) return false;
  }
  return true;
}
