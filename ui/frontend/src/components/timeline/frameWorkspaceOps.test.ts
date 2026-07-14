import { describe, expect, it, vi } from "vitest";
import type { FrameSequencePayload } from "../../lib/api";
import {
  moveTimelineFrames,
  mutateTimelineFrameSlots,
  placeGallerySequence,
} from "./frameWorkspaceOps";

function payload(
  sequenceGroupId: string,
  strip: FrameSequencePayload["strip"]
): FrameSequencePayload {
  return { sequenceGroupId, strip, hidden: [] };
}

describe("placeGallerySequence", () => {
  it("duplicates gallery assets while preserving the target sequence group", async () => {
    const duplicate = vi.fn(async (path: string) => `target/${path.split("/").at(-1)}`);
    const placed = await placeGallerySequence(
      payload("target-group", [{ kind: "empty" }]),
      payload("source-group", [
        { kind: "image", relPath: "source/a.png" },
        { kind: "image", relPath: "source/b.png" },
      ]),
      0,
      duplicate
    );

    expect(placed.payload.sequenceGroupId).toBe("target-group");
    expect(placed.payload.strip.map((slot) => slot.relPath)).toEqual([
      "target/a.png",
      "target/b.png",
    ]);
    expect(duplicate).toHaveBeenCalledTimes(2);
  });
});

describe("moveTimelineFrames", () => {
  it("swaps a single frame with its target", () => {
    const moved = moveTimelineFrames(
      payload("g", [
        { kind: "image", relPath: "a.png" },
        { kind: "image", relPath: "b.png" },
      ]),
      0,
      1,
      new Set([0])
    );
    expect(moved?.payload.strip.map((slot) => slot.relPath)).toEqual(["b.png", "a.png"]);
    expect([...moved!.selectedIndices]).toEqual([1]);
  });

  it("moves multiple selected frames together and preserves their spacing", () => {
    const moved = moveTimelineFrames(
      payload("g", [
        { kind: "image", relPath: "a.png" },
        { kind: "empty" },
        { kind: "image", relPath: "b.png" },
        { kind: "empty" },
        { kind: "empty" },
      ]),
      0,
      1,
      new Set([0, 2])
    );
    expect(moved?.payload.strip.map((slot) => slot.relPath ?? null)).toEqual([
      null,
      "a.png",
      null,
      "b.png",
      null,
    ]);
    expect([...moved!.selectedIndices]).toEqual([1, 3]);
  });

  it("rejects a multi-frame move that collides with an unselected frame", () => {
    const original = payload("g", [
      { kind: "image", relPath: "a.png" },
      { kind: "empty" },
      { kind: "image", relPath: "b.png" },
      { kind: "image", relPath: "blocked.png" },
    ]);
    expect(moveTimelineFrames(original, 0, 1, new Set([0, 2]))).toBeNull();
  });
});

describe("mutateTimelineFrameSlots", () => {
  const autoHidden = payload("g", [
    { kind: "image", relPath: "a.png", hidden: true, trimHidden: true },
  ]);

  it("manual hide clears trimHidden", () => {
    expect(mutateTimelineFrameSlots(autoHidden, new Set([0]), "hide").strip[0]).toEqual({
      kind: "image",
      relPath: "a.png",
      hidden: true,
    });
  });

  it("unhide removes hidden and trimHidden", () => {
    expect(mutateTimelineFrameSlots(autoHidden, new Set([0]), "unhide").strip[0]).toEqual({
      kind: "image",
      relPath: "a.png",
    });
  });
});
