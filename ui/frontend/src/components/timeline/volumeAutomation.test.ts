import { describe, expect, it } from "vitest";
import {
  AUDIO_EDGE_DURATION_MIN,
  buildAudioEdgeVolumePoints,
  clampAudioEdgeDurationSec,
  inferAudioEdgeTransitions,
} from "./volumeAutomation";

function levelNear(points: { t: number; level: number }[], t: number): number {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return 50;
  if (t <= sorted[0]!.t) return sorted[0]!.level;
  if (t >= sorted[sorted.length - 1]!.t) return sorted[sorted.length - 1]!.level;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const s = span < 1e-9 ? 0 : (t - a.t) / span;
      return a.level + (b.level - a.level) * s;
    }
  }
  return sorted[sorted.length - 1]!.level;
}

describe("buildAudioEdgeVolumePoints", () => {
  it("fade in only → first level ~0, mid ~50", () => {
    const pts = buildAudioEdgeVolumePoints(10, {
      fadeInSec: 0.5,
      fadeOutSec: null,
      crescendoSec: null,
    });
    expect(pts[0]!.level).toBe(0);
    expect(levelNear(pts, 0.5)).toBeCloseTo(50, 0);
    expect(pts[pts.length - 1]!.level).toBe(50);
  });

  it("fade out only → last ~0", () => {
    const pts = buildAudioEdgeVolumePoints(10, {
      fadeInSec: null,
      fadeOutSec: 0.5,
      crescendoSec: null,
    });
    expect(pts[0]!.level).toBe(50);
    expect(pts[pts.length - 1]!.level).toBe(0);
  });

  it("crescendo only → last ~100", () => {
    const pts = buildAudioEdgeVolumePoints(10, {
      fadeInSec: null,
      fadeOutSec: null,
      crescendoSec: 0.5,
    });
    expect(pts[0]!.level).toBe(50);
    expect(pts[pts.length - 1]!.level).toBe(100);
  });

  it("applying crescendo after fade out → end is crescendo, not zero", () => {
    const pts = buildAudioEdgeVolumePoints(10, {
      fadeInSec: null,
      fadeOutSec: 0.5,
      crescendoSec: 0.5,
    });
    expect(pts[pts.length - 1]!.level).toBe(100);
    expect(pts[pts.length - 1]!.level).not.toBe(0);
  });

  it("fade in stacks with fade out", () => {
    const pts = buildAudioEdgeVolumePoints(10, {
      fadeInSec: 0.5,
      fadeOutSec: 0.5,
      crescendoSec: null,
    });
    expect(pts[0]!.level).toBe(0);
    expect(levelNear(pts, 0.5)).toBeCloseTo(50, 0);
    expect(pts[pts.length - 1]!.level).toBe(0);
  });

  it("duration clamp respects short clips", () => {
    expect(clampAudioEdgeDurationSec(1, 3)).toBeCloseTo(0.49, 5);
    expect(clampAudioEdgeDurationSec(0.05, 0.5)).toBeLessThan(AUDIO_EDGE_DURATION_MIN);
    const pts = buildAudioEdgeVolumePoints(1, {
      fadeInSec: 3,
      fadeOutSec: 3,
      crescendoSec: null,
    });
    const head = pts.find((p) => Math.abs(p.level - 50) < 1);
    expect(head).toBeDefined();
    expect(head!.t).toBeLessThanOrEqual(0.49);
    expect(pts[pts.length - 1]!.level).toBe(0);
  });
});

describe("inferAudioEdgeTransitions", () => {
  it("infers fade in / fade out from built points", () => {
    const pts = buildAudioEdgeVolumePoints(10, {
      fadeInSec: 0.5,
      fadeOutSec: 0.5,
      crescendoSec: null,
    });
    const inferred = inferAudioEdgeTransitions(10, pts);
    expect(inferred.fadeInSec).toBeCloseTo(0.5, 1);
    expect(inferred.fadeOutSec).toBeCloseTo(0.5, 1);
    expect(inferred.crescendoSec).toBeNull();
  });

  it("infers crescendo, not fade out", () => {
    const pts = buildAudioEdgeVolumePoints(10, {
      fadeInSec: null,
      fadeOutSec: null,
      crescendoSec: 0.75,
    });
    const inferred = inferAudioEdgeTransitions(10, pts);
    expect(inferred.crescendoSec).toBeCloseTo(0.75, 1);
    expect(inferred.fadeOutSec).toBeNull();
  });
});
