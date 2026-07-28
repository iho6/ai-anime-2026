import type { TimelineClip } from "../../lib/api";
import { clamp } from "./timelineUtil";

export type VolumeAutomationPoint = NonNullable<
  TimelineClip["volumeAutomation"]
>["points"][number];

const UNITY_LEVEL = 50;
const SILENCE_LEVEL = 0;
const CRESCENDO_PEAK_LEVEL = 100;

export const AUDIO_EDGE_DURATION_DEFAULT = 0.5;
export const AUDIO_EDGE_DURATION_MIN = 0.05;
export const AUDIO_EDGE_DURATION_MAX = 3;

export type AudioEdgeTransitions = {
  fadeInSec: number | null;
  fadeOutSec: number | null;
  crescendoSec: number | null;
};

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

/** EBU R128 loudness correction stored on the clip (default 1). */
export function clipNormalizationGain(clip: TimelineClip): number {
  const gain = clip.normalizationGain;
  return typeof gain === "number" && gain > 0 ? gain : 1;
}

export function volumeGainAt(clip: TimelineClip, playhead: number): number {
  return clamp(
    levelToGain(volumeLevelAt(clip, playhead)) * clipNormalizationGain(clip),
    0,
    2
  );
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

/** Max edge duration so head/tail never cross (each ≤ 49% of clip). */
export function clampAudioEdgeDurationSec(
  durationSec: number,
  requestedSec: number
): number {
  const dur = Math.max(0, durationSec);
  const maxEdge = Math.min(AUDIO_EDGE_DURATION_MAX, dur * 0.49);
  if (maxEdge < AUDIO_EDGE_DURATION_MIN) {
    return Math.max(0, maxEdge);
  }
  return clamp(requestedSec, AUDIO_EDGE_DURATION_MIN, maxEdge);
}

export function defaultAudioEdgeDurationSec(durationSec: number): number {
  return clampAudioEdgeDurationSec(durationSec, AUDIO_EDGE_DURATION_DEFAULT);
}

/**
 * Build volume automation from edge fade/crescendo shapes.
 * Fade out and crescendo are mutually exclusive: if both set, crescendo wins.
 */
export function buildAudioEdgeVolumePoints(
  durationSec: number,
  edges: AudioEdgeTransitions
): VolumeAutomationPoint[] {
  const dur = Math.max(1e-6, durationSec);
  let fadeInSec = edges.fadeInSec;
  let fadeOutSec = edges.fadeOutSec;
  let crescendoSec = edges.crescendoSec;

  if (crescendoSec != null && fadeOutSec != null) {
    fadeOutSec = null;
  }

  const headT =
    fadeInSec != null && fadeInSec > 0
      ? clampAudioEdgeDurationSec(dur, fadeInSec) / dur
      : 0;
  const exitSec = crescendoSec != null ? crescendoSec : fadeOutSec;
  const exitKind: "none" | "fadeOut" | "crescendo" =
    crescendoSec != null && crescendoSec > 0
      ? "crescendo"
      : fadeOutSec != null && fadeOutSec > 0
        ? "fadeOut"
        : "none";
  const tailT =
    exitKind !== "none" && exitSec != null && exitSec > 0
      ? clampAudioEdgeDurationSec(dur, exitSec) / dur
      : 0;

  // Guard against pathological short clips where clamp collapses edges.
  const safeHead = headT > 1e-6 ? Math.min(headT, 0.49) : 0;
  const safeTail = tailT > 1e-6 ? Math.min(tailT, 0.49) : 0;
  if (safeHead + safeTail > 0.98) {
    const scale = 0.98 / (safeHead + safeTail);
    return assembleEdgePoints(safeHead * scale, safeTail * scale, exitKind);
  }
  return assembleEdgePoints(safeHead, safeTail, exitKind);
}

function assembleEdgePoints(
  headT: number,
  tailT: number,
  exitKind: "none" | "fadeOut" | "crescendo"
): VolumeAutomationPoint[] {
  const pts: VolumeAutomationPoint[] = [];

  if (headT > 1e-6) {
    pts.push({ t: 0, level: SILENCE_LEVEL });
    pts.push({ t: headT, level: UNITY_LEVEL });
  } else {
    pts.push({ t: 0, level: UNITY_LEVEL });
  }

  const exitStart = 1 - tailT;
  if (exitKind !== "none" && tailT > 1e-6) {
    // Ensure a unity point before the exit ramp when head doesn't cover it.
    if (exitStart > headT + 1e-6) {
      pts.push({ t: exitStart, level: UNITY_LEVEL });
    }
    pts.push({
      t: 1,
      level: exitKind === "crescendo" ? CRESCENDO_PEAK_LEVEL : SILENCE_LEVEL,
    });
  } else {
    if (pts[pts.length - 1]!.t < 1 - 1e-9) {
      pts.push({ t: 1, level: UNITY_LEVEL });
    } else {
      pts[pts.length - 1] = { t: 1, level: UNITY_LEVEL };
    }
  }

  return dedupePoints(pts);
}

function dedupePoints(pts: VolumeAutomationPoint[]): VolumeAutomationPoint[] {
  const out: VolumeAutomationPoint[] = [];
  for (const p of pts) {
    const t = clamp(p.t, 0, 1);
    const level = clamp(p.level, 0, 100);
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - t) < 1e-6) {
      out[out.length - 1] = { t, level };
      continue;
    }
    out.push({ t, level });
  }
  if (out.length < 2) return defaultVolumeAutomationPoints();
  if (out[0]!.t > 1e-9) out.unshift({ t: 0, level: out[0]!.level });
  if (out[out.length - 1]!.t < 1 - 1e-9) {
    out.push({ t: 1, level: out[out.length - 1]!.level });
  }
  return out;
}

/**
 * Best-effort infer edge shapes from existing points for flyout initial state.
 */
export function inferAudioEdgeTransitions(
  durationSec: number,
  points: VolumeAutomationPoint[] | undefined
): AudioEdgeTransitions {
  const empty: AudioEdgeTransitions = {
    fadeInSec: null,
    fadeOutSec: null,
    crescendoSec: null,
  };
  if (!points || points.length < 2 || durationSec <= 0) return empty;

  const sorted = [...points].sort((a, b) => a.t - b.t);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;

  let fadeInSec: number | null = null;
  if (Math.abs(first.level - SILENCE_LEVEL) < 2 && first.t < 0.05) {
    // Find first near-unity point.
    for (const p of sorted) {
      if (Math.abs(p.level - UNITY_LEVEL) < 3 && p.t > first.t) {
        fadeInSec = clampAudioEdgeDurationSec(durationSec, p.t * durationSec);
        break;
      }
    }
  }

  let fadeOutSec: number | null = null;
  let crescendoSec: number | null = null;
  if (Math.abs(last.t - 1) < 0.05) {
    if (Math.abs(last.level - SILENCE_LEVEL) < 2) {
      for (let i = sorted.length - 2; i >= 0; i--) {
        const p = sorted[i]!;
        if (Math.abs(p.level - UNITY_LEVEL) < 3) {
          fadeOutSec = clampAudioEdgeDurationSec(
            durationSec,
            (1 - p.t) * durationSec
          );
          break;
        }
      }
    } else if (last.level >= CRESCENDO_PEAK_LEVEL - 5) {
      for (let i = sorted.length - 2; i >= 0; i--) {
        const p = sorted[i]!;
        if (Math.abs(p.level - UNITY_LEVEL) < 3) {
          crescendoSec = clampAudioEdgeDurationSec(
            durationSec,
            (1 - p.t) * durationSec
          );
          break;
        }
      }
    }
  }

  if (crescendoSec != null) fadeOutSec = null;
  return { fadeInSec, fadeOutSec, crescendoSec };
}
