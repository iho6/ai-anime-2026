import { describe, expect, it } from "vitest";
import { clipIdsInMarquee } from "./TimelineTracks";
import type { TimelineTrack } from "../../lib/api";

function track(
  id: string,
  clips: { id: string; start: number; duration: number }[]
): TimelineTrack {
  return {
    id,
    name: id,
    kind: "video",
    clips: clips.map((c) => ({
      id: c.id,
      type: "image",
      srcRelPath: "",
      start: c.start,
      duration: c.duration,
      inPoint: 0,
      outPoint: c.duration,
      speed: 1,
      reversed: false,
      transform: { x: 0, y: 0, scale: 1 },
    })),
  };
}

describe("clipIdsInMarquee", () => {
  const tracks = [
    track("t0", [
      { id: "a", start: 0, duration: 2 },
      { id: "b", start: 3, duration: 1 },
    ]),
    track("t1", [{ id: "c", start: 1, duration: 2 }]),
    track("t2", [{ id: "d", start: 0, duration: 5 }]),
  ];

  it("selects overlapping clips across track rows and time", () => {
    expect(clipIdsInMarquee(tracks, 0.5, 2.5, 0, 1).sort()).toEqual(["a", "c"]);
  });

  it("includes clip when marquee only grazes its interior", () => {
    expect(clipIdsInMarquee(tracks, 3.2, 3.5, 0, 0)).toEqual(["b"]);
  });

  it("returns empty when box misses clips", () => {
    expect(clipIdsInMarquee(tracks, 10, 12, 0, 2)).toEqual([]);
  });

  it("clamps inverted track indices", () => {
    expect(clipIdsInMarquee(tracks, 0, 1.5, 2, 0).sort()).toEqual(["a", "c", "d"]);
  });
});
