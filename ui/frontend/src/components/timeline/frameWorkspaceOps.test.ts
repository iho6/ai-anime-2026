import { describe, expect, it, vi } from "vitest";
import type { FrameSequencePayload } from "../../lib/api";
import {
  moveTimelineFrames,
  mutateTimelineFrameSlots,
  placeGallerySequence,
  seedSequenceGalleryFromStrip,
} from "./frameWorkspaceOps";

function payload(
  sequenceGroupId: string,
  strip: FrameSequencePayload["strip"]
): FrameSequencePayload {
  return { sequenceGroupId, strip, hidden: [] };
}

describe("seedSequenceGalleryFromStrip", () => {
  it("duplicates strip assets into a new gallery row with a new group id", async () => {
    const duplicate = vi.fn(async (path: string) => `dup/${path}`);
    const strip = payload("strip-group", [
      { kind: "image", relPath: "source/a.png" },
      { kind: "image", relPath: "source/b.png" },
    ]);
    const gallery = await seedSequenceGalleryFromStrip(strip, duplicate);

    expect(gallery).toHaveLength(1);
    const row = gallery[0]!;
    expect(row.frameSequence?.sequenceGroupId).not.toBe("strip-group");
    expect(row.frameSequence?.strip.map((slot) => slot.relPath)).toEqual([
      "dup/source/a.png",
      "dup/source/b.png",
    ]);
    expect(row.relPath).toBe("dup/source/a.png");
    expect(duplicate).toHaveBeenCalledTimes(2);
    // Original strip paths unchanged (gallery isolation).
    expect(strip.strip.map((slot) => slot.relPath)).toEqual([
      "source/a.png",
      "source/b.png",
    ]);
  });

  it("returns empty when strip has no images", async () => {
    const duplicate = vi.fn(async (path: string) => path);
    const gallery = await seedSequenceGalleryFromStrip(
      payload("g", [{ kind: "empty" }]),
      duplicate
    );
    expect(gallery).toEqual([]);
    expect(duplicate).not.toHaveBeenCalled();
  });
});

describe("placeGallerySequence", () => {
  it("always assigns a new sequence group id and duplicates assets", async () => {
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

    expect(placed.payload.sequenceGroupId).not.toBe("target-group");
    expect(placed.payload.sequenceGroupId).not.toBe("source-group");
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

  it("slides a multi-selection into occupied cells and overwrites", () => {
    const moved = moveTimelineFrames(
      payload("g", [
        { kind: "image", relPath: "a.png" },
        { kind: "empty" },
        { kind: "image", relPath: "b.png" },
        { kind: "image", relPath: "blocked.png" },
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
    ]);
    expect([...moved!.selectedIndices].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it("slides a dense contiguous selection right by one, overwriting the displaced frame", () => {
    const moved = moveTimelineFrames(
      payload("g", [
        { kind: "image", relPath: "a.png" },
        { kind: "image", relPath: "b.png" },
        { kind: "image", relPath: "c.png" },
        { kind: "image", relPath: "d.png" },
      ]),
      0,
      1,
      new Set([0, 1])
    );
    expect(moved?.payload.strip.map((slot) => slot.relPath ?? null)).toEqual([
      null,
      "a.png",
      "b.png",
      "d.png",
    ]);
    expect([...moved!.selectedIndices].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("rejects a multi-frame move that would go past the left edge", () => {
    expect(
      moveTimelineFrames(
        payload("g", [
          { kind: "image", relPath: "a.png" },
          { kind: "image", relPath: "b.png" },
        ]),
        1,
        0,
        new Set([0, 1])
      )
    ).toBeNull();
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
