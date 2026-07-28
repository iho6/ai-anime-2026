import { describe, expect, it } from "vitest";
import {
  advancePromotion,
  initialPromotionState,
  PROMOTION_HEALTHY_RENDERS,
  renderIsHealthy,
} from "./promotion";

const okResult = (runway: Record<string, number>) => ({
  ok: true,
  missingClipIds: [] as string[],
  runwayFrames: runway,
});

describe("renderIsHealthy", () => {
  it("requires ok and no missing clips", () => {
    expect(
      renderIsHealthy(
        { ok: false, missingClipIds: [], runwayFrames: {} },
        [],
        1
      )
    ).toBe(false);
    expect(
      renderIsHealthy(
        { ok: true, missingClipIds: ["a"], runwayFrames: {} },
        [],
        1
      )
    ).toBe(false);
  });

  it("requires runway for every visible video clip", () => {
    expect(renderIsHealthy(okResult({ a: 12, b: 12 }), ["a", "b"], 12)).toBe(true);
    expect(renderIsHealthy(okResult({ a: 12, b: 6 }), ["a", "b"], 12)).toBe(false);
    expect(renderIsHealthy(okResult({ a: 12 }), ["a", "b"], 12)).toBe(false);
  });

  it("image-only scenes (no video clips) are healthy when ok", () => {
    expect(renderIsHealthy(okResult({}), [], 12)).toBe(true);
  });
});

describe("advancePromotion", () => {
  it("promotes only after N consecutive healthy renders", () => {
    let s = initialPromotionState;
    for (let i = 0; i < PROMOTION_HEALTHY_RENDERS - 1; i++) {
      s = advancePromotion(s, true);
      expect(s.owns).toBe(false);
    }
    s = advancePromotion(s, true);
    expect(s.owns).toBe(true);
  });

  it("demotes instantly on an unhealthy render", () => {
    let s = { owns: true, healthyStreak: 10 };
    s = advancePromotion(s, false);
    expect(s.owns).toBe(false);
    expect(s.healthyStreak).toBe(0);
  });

  it("unhealthy render resets the streak", () => {
    let s = initialPromotionState;
    s = advancePromotion(s, true);
    s = advancePromotion(s, false);
    s = advancePromotion(s, true);
    expect(s.healthyStreak).toBe(1);
    expect(s.owns).toBe(false);
  });

  it("stays promoted while healthy", () => {
    let s = { owns: true, healthyStreak: 5 };
    s = advancePromotion(s, true);
    expect(s.owns).toBe(true);
  });
});
