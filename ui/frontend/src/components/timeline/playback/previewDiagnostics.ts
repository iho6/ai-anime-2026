/**
 * Dev-only preview diagnostics: per-clip paint recency plus a render-time
 * snapshot of decode-budget / readiness state, surfaced as an overlay when
 * the page is loaded with ?previewDebug=1 (or localStorage previewDebug=1).
 */

export type ClipLayerDiagnostic = {
  clipId: string;
  /** Free-run decode slot winner (DOM fallback path). */
  playSlot: boolean;
  readyState: number;
  paused: boolean;
  currentTime: number;
  wantTime: number;
};

let debugFlag: boolean | null = null;

export function previewDebugEnabled(): boolean {
  if (debugFlag != null) return debugFlag;
  if (typeof window === "undefined") return false;
  try {
    const qs = new URLSearchParams(window.location.search);
    debugFlag =
      qs.get("previewDebug") === "1" ||
      window.localStorage.getItem("previewDebug") === "1";
  } catch {
    debugFlag = false;
  }
  return debugFlag;
}

const lastPaintMs = new Map<string, number>();

export function reportClipPaint(clipId: string): void {
  lastPaintMs.set(clipId, performance.now());
}

export function clipPaintAgeMs(clipId: string): number | null {
  const at = lastPaintMs.get(clipId);
  return at == null ? null : performance.now() - at;
}

export function forgetClipPaint(clipId: string): void {
  lastPaintMs.delete(clipId);
}

/** Engine promotion/demotion counters (Phase 3 telemetry). */
export const engineTelemetry = {
  promotions: 0,
  demotions: 0,
  missedFrames: 0,
};
