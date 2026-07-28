/**
 * Runway-gated promotion policy: the engine may own presentation only while
 * it can prove a decoded runway for every visible video layer. Any underrun
 * demotes instantly back to the DOM stack.
 */

import type { EngineRenderResult } from "./engineHost";

/** Decoded frames required ahead of the playhead before promoting (~0.4s@30). */
export const PROMOTION_RUNWAY_FRAMES = 12;
/** Consecutive healthy renders required before promoting. */
export const PROMOTION_HEALTHY_RENDERS = 3;

export type PromotionState = {
  owns: boolean;
  healthyStreak: number;
};

export const initialPromotionState: PromotionState = {
  owns: false,
  healthyStreak: 0,
};

export function renderIsHealthy(
  result: EngineRenderResult,
  videoClipIds: ReadonlyArray<string>,
  minRunway: number = PROMOTION_RUNWAY_FRAMES
): boolean {
  if (!result.ok) return false;
  if (result.missingClipIds.length > 0) return false;
  for (const clipId of videoClipIds) {
    const runway = result.runwayFrames[clipId];
    if (runway == null || runway < minRunway) return false;
  }
  return true;
}

/**
 * Advance the promotion state machine after a render.
 * Promote after N consecutive healthy renders; demote on the first unhealthy
 * one (no hysteresis on the way down — a stall is visible immediately).
 */
export function advancePromotion(
  state: PromotionState,
  healthy: boolean,
  healthyRendersRequired: number = PROMOTION_HEALTHY_RENDERS
): PromotionState {
  if (!healthy) {
    return { owns: false, healthyStreak: 0 };
  }
  const streak = state.healthyStreak + 1;
  return {
    owns: state.owns || streak >= healthyRendersRequired,
    healthyStreak: streak,
  };
}
