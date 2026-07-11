import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../lib/api";
import {
  resolveStripSlotRelPath,
  stripFrameIndexAtSourceTime,
  timelineStripPreviewRelPath,
} from "./timelineStripPreview";

const clip: TimelineClip = {
  id: "clip-1",
  type: "video",
  srcRelPath: "timelines/t/clips/source.webm",
  start: 0,
  inPoint: 1,
  outPoint: 3,
  speed: 1,
  duration: 2,
  frameSequence: {
    sequenceGroupId: "seq",
    strip: [
      { kind: "image", relPath: "frames/0.png" },
      { kind: "empty" },
      { kind: "image", relPath: "frames/2.png", hidden: true },
      { kind: "image", relPath: "frames/3.png" },
    ],
    hidden: [],
  },
};

describe("stripFrameIndexAtSourceTime", () => {
  it("maps trimmed source time to a clamped strip index", () => {
    expect(stripFrameIndexAtSourceTime(clip, 1, 2, 4)).toBe(0);
    expect(stripFrameIndexAtSourceTime(clip, 2.5, 2, 4)).toBe(3);
    expect(stripFrameIndexAtSourceTime(clip, 10, 2, 4)).toBe(3);
  });
});

describe("resolveStripSlotRelPath", () => {
  it("holds the last visible frame across empty and hidden slots", () => {
    const strip = clip.frameSequence!.strip;
    expect(resolveStripSlotRelPath(strip, 0)).toBe("frames/0.png");
    expect(resolveStripSlotRelPath(strip, 1)).toBe("frames/0.png");
    expect(resolveStripSlotRelPath(strip, 2)).toBe("frames/0.png");
    expect(resolveStripSlotRelPath(strip, 3)).toBe("frames/3.png");
  });
});

describe("timelineStripPreviewRelPath", () => {
  it("resolves the matching visible strip image", () => {
    expect(timelineStripPreviewRelPath(clip, 2.5, 2)).toBe("frames/3.png");
  });

  it("returns null without a frameSequence strip", () => {
    expect(
      timelineStripPreviewRelPath({ ...clip, frameSequence: undefined }, 1, 24)
    ).toBeNull();
  });
});
