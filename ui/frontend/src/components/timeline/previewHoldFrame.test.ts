import { describe, expect, it } from "vitest";
import {
  clipPreviewHoldStep,
  heldSourceTimeSec,
  holdQuantizeFrameIndex,
  normalizePreviewHoldStep,
} from "./previewHoldFrame";

describe("previewHoldFrame", () => {
  it("normalizes step to 1 or 2", () => {
    expect(normalizePreviewHoldStep(undefined)).toBe(1);
    expect(normalizePreviewHoldStep(1)).toBe(1);
    expect(normalizePreviewHoldStep(2)).toBe(2);
    expect(normalizePreviewHoldStep(3)).toBe(1);
  });

  it("reads hold step from frameEdit", () => {
    expect(clipPreviewHoldStep({})).toBe(1);
    expect(clipPreviewHoldStep({ frameEdit: { framesDirRel: "x", timelineViewStep: 2 } })).toBe(
      2
    );
  });

  it("quantizes frame indices for hold", () => {
    expect(holdQuantizeFrameIndex(0, 2)).toBe(0);
    expect(holdQuantizeFrameIndex(1, 2)).toBe(0);
    expect(holdQuantizeFrameIndex(2, 2)).toBe(2);
    expect(holdQuantizeFrameIndex(3, 2)).toBe(2);
    expect(holdQuantizeFrameIndex(5, 1)).toBe(5);
  });

  it("holds source time without changing timeline span math", () => {
    const clip = { inPoint: 0, outPoint: 5.375 };
    expect(heldSourceTimeSec(clip, 0.04, 24, 2)).toBeCloseTo(0, 5);
    expect(heldSourceTimeSec(clip, 1 / 24, 24, 2)).toBeCloseTo(0, 5);
    expect(heldSourceTimeSec(clip, 2 / 24, 24, 2)).toBeCloseTo(2 / 24, 5);
    expect(heldSourceTimeSec(clip, 0.5, 24, 1)).toBeCloseTo(0.5, 5);
  });
});
