import type { TimelineClip } from "../../lib/api";



export type TrajectoryWaypoint = NonNullable<TimelineClip["trajectory"]>["waypoints"][number];



export const DEFAULT_HOLD_SEC = 0;

export const DEFAULT_BLEND_EASE = 0;

export const PAUSE_HOLD_SEC_STEP = 0.01;

export const PAUSE_HOLD_SEC_UI_MAX = 2;

export function pauseHoldSecSliderMax(segmentMaxSec: number): number {
  return Math.min(PAUSE_HOLD_SEC_UI_MAX, Math.max(0, segmentMaxSec));
}



export function normalizeHoldPct(v: number | undefined | null): number {

  if (v == null || !Number.isFinite(v)) return 0;

  return Math.max(0, Math.min(100, Math.round(v)));

}



export function normalizeHoldSec(v: number | undefined | null, maxSec: number): number {

  if (v == null || !Number.isFinite(v)) return DEFAULT_HOLD_SEC;

  const max = Math.max(0, maxSec);

  return Math.max(0, Math.min(max, Math.round(v * 100) / 100));

}



export function normalizeBlendEase(v: number | undefined | null): number {

  if (v == null || !Number.isFinite(v)) return DEFAULT_BLEND_EASE;

  return Math.max(0, Math.min(100, Math.round(v)));

}



/** Absolute hold seconds for waypoint on segment a→b (migrates legacy holdPct). */

export function effectiveHoldSec(

  wp: TrajectoryWaypoint,

  aT: number,

  bT: number,

  durationSec: number

): number {

  const span = bT - aT;

  const maxSec = Math.max(0, span * durationSec);

  if (wp.holdSec != null && Number.isFinite(wp.holdSec)) {

    return normalizeHoldSec(wp.holdSec, maxSec);

  }

  if (wp.holdPct != null && Number.isFinite(wp.holdPct)) {

    const fromPct = (normalizeHoldPct(wp.holdPct) / 100) * maxSec;

    return normalizeHoldSec(fromPct, maxSec);

  }

  return DEFAULT_HOLD_SEC;

}



/** Clip-fraction time when hold ends on segment a→b. */

export function holdTEnd(

  wp: TrajectoryWaypoint,

  aT: number,

  bT: number,

  durationSec: number

): number {

  const span = bT - aT;

  if (span < 1e-9 || durationSec <= 0) return aT;

  const holdSec = effectiveHoldSec(wp, aT, bT, durationSec);

  return aT + Math.min(holdSec / durationSec, span);

}



/** @deprecated Use holdTEnd with holdSec. */

export function holdTFromPct(

  holdPct: number | undefined | null,

  aT: number,

  bT: number

): number {

  const span = bT - aT;

  if (span < 1e-9) return aT;

  const pct = normalizeHoldPct(holdPct) / 100;

  return aT + pct * span;

}



export function maxHoldSecForSegment(aT: number, bT: number, durationSec: number): number {

  return Math.max(0, (bT - aT) * durationSec);

}



export type GlideEaseMode = "arrival" | "departure";



/** Temporal easing on segment parameter s (0–1). */

export function applyGlideEase(s: number, easePct: number, mode: GlideEaseMode): number {

  const w = normalizeBlendEase(easePct) / 100;

  if (w <= 0) return s;

  const eased =

    mode === "arrival"

      ? 1 - Math.pow(1 - s, 3)

      : s * s * s;

  return s + (eased - s) * w;

}



export function linearT(t: number, start: number, end: number): number {

  const span = end - start;

  if (span <= 0) return t >= end ? 1 : 0;

  return Math.max(0, Math.min(1, (t - start) / span));

}



export type WaypointPose = { x: number; y: number; scale: number };



export function waypointPose(wp: TrajectoryWaypoint): WaypointPose {

  return { x: wp.x, y: wp.y, scale: wp.scale };

}



export function linearPoseAtS(

  a: TrajectoryWaypoint,

  b: TrajectoryWaypoint,

  s: number

): WaypointPose {

  let x: number;

  let y: number;

  if (a.cpx != null && a.cpy != null) {

    const cp = { x: a.cpx, y: a.cpy };

    x = (1 - s) * (1 - s) * a.x + 2 * (1 - s) * s * cp.x + s * s * b.x;

    y = (1 - s) * (1 - s) * a.y + 2 * (1 - s) * s * cp.y + s * s * b.y;

  } else {

    x = a.x + (b.x - a.x) * s;

    y = a.y + (b.y - a.y) * s;

  }

  return { x, y, scale: a.scale + (b.scale - a.scale) * s };

}


