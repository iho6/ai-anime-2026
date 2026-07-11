import { describe, expect, it } from "vitest";
import type { FrameSequenceStripSlot, TimelineClip } from "../../lib/api";
import {
  clipSupportsFlfEndpoint,
  flfStripEndpointRelPath,
  selectedFlfClips,
} from "./timelineFlfUtils";

function clip(id: string, type: TimelineClip["type"], start: number): TimelineClip {
  return {
    id,
    type,
    srcRelPath: `timelines/t1/clips/${id}.png`,
    start,
    inPoint: 0,
    outPoint: 3,
    speed: 1,
    duration: 3,
  };
}

describe("selectedFlfClips", () => {
  it("orders by timeline start", () => {
    const all = [clip("b", "video", 5), clip("a", "image", 1), clip("c", "audio", 2)];
    const out = selectedFlfClips(all, ["b", "a"]);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("filters unsupported clip types", () => {
    const all = [clip("a", "image", 0), clip("b", "audio", 1)];
    expect(selectedFlfClips(all, ["a", "b"])).toHaveLength(1);
  });
});

describe("clipSupportsFlfEndpoint", () => {
  it("allows image, video, and geometry", () => {
    expect(clipSupportsFlfEndpoint(clip("a", "image", 0))).toBe(true);
    expect(clipSupportsFlfEndpoint(clip("b", "video", 0))).toBe(true);
    expect(clipSupportsFlfEndpoint(clip("c", "geometry", 0))).toBe(true);
    expect(clipSupportsFlfEndpoint(clip("d", "audio", 0))).toBe(false);
  });
});

describe("flfStripEndpointRelPath", () => {
  const strip: FrameSequenceStripSlot[] = [
    { kind: "empty" },
    { kind: "image", relPath: "a.png", hidden: true },
    { kind: "image", relPath: "b.png" },
    { kind: "image", relPath: "c.png" },
    { kind: "image", relPath: "d.png", hidden: true },
  ];

  it("returns first and last export-visible slots", () => {
    expect(flfStripEndpointRelPath(strip, "start")).toBe("b.png");
    expect(flfStripEndpointRelPath(strip, "end")).toBe("c.png");
  });
});
