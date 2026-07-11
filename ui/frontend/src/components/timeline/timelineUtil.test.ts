import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineManifest, TimelineTrack } from "../../lib/api";
import {
  buildTimelineClipClipboard,
  cloneTimelineClipForPaste,
  clipTransformAtPlayhead,
  dedupeTimelineManifestClips,
  moveClipBetweenTracks,
  pasteTimelineClipClipboard,
  playbackEndPlayhead,
} from "./timelineUtil";
import { createGeometryData } from "./geometryTemplates";

function videoClip(id: string, start = 0): TimelineClip {
  return {
    id,
    type: "video",
    srcRelPath: `clips/${id}.mp4`,
    start,
    inPoint: 0,
    outPoint: 2,
    speed: 1,
    duration: 2,
    srcDuration: 2,
  };
}

function manifest(tracks: TimelineTrack[]): TimelineManifest {
  return { version: 2, fps: 24, previewAspect: "16:9", tracks };
}

function track(id: string, clips: TimelineClip[]): TimelineTrack {
  return { id, name: id, kind: "video", clips };
}

describe("playbackEndPlayhead", () => {
  it("holds the final frame inside the exclusive clip end", () => {
    expect(playbackEndPlayhead(2, 24)).toBeCloseTo(2 - 1 / 24);
  });

  it("clamps short and empty timelines to zero", () => {
    expect(playbackEndPlayhead(0, 24)).toBe(0);
    expect(playbackEndPlayhead(0.01, 24)).toBe(0);
  });
});

describe("dedupeTimelineManifestClips", () => {
  it("drops duplicate clip ids on the same track", () => {
    const clip = videoClip("clip_a");
    const m = manifest([track("trk_1", [clip, { ...clip }, { ...clip }])]);
    const { manifest: out, changed } = dedupeTimelineManifestClips(m);
    expect(changed).toBe(true);
    expect(out.tracks[0].clips).toHaveLength(1);
    expect(out.tracks[0].clips[0].id).toBe("clip_a");
  });

  it("re-ids a clip that appears on multiple tracks", () => {
    const clip = videoClip("clip_shared");
    const m = manifest([
      track("trk_1", [clip]),
      track("trk_2", [{ ...clip, start: 5 }]),
    ]);
    const { manifest: out, changed } = dedupeTimelineManifestClips(m);
    expect(changed).toBe(true);
    expect(out.tracks[0].clips[0].id).toBe("clip_shared");
    expect(out.tracks[1].clips[0].id).not.toBe("clip_shared");
    expect(out.tracks[1].clips[0].start).toBe(5);
  });

  it("returns unchanged when manifest is already clean", () => {
    const m = manifest([
      track("trk_1", [videoClip("clip_a")]),
      track("trk_2", [videoClip("clip_b")]),
    ]);
    const { manifest: out, changed } = dedupeTimelineManifestClips(m);
    expect(changed).toBe(false);
    expect(out).toBe(m);
  });
});

describe("moveClipBetweenTracks", () => {
  it("moves a clip to another track", () => {
    const clip = videoClip("clip_a", 1);
    const m = manifest([track("trk_a", [clip]), track("trk_b", [])]);
    const out = moveClipBetweenTracks(m, "trk_b", clip, 3);
    expect(out.tracks[0].clips).toHaveLength(0);
    expect(out.tracks[1].clips).toHaveLength(1);
    expect(out.tracks[1].clips[0].id).toBe("clip_a");
    expect(out.tracks[1].clips[0].start).toBe(3);
  });

  it("is idempotent when called twice with the same target", () => {
    const clip = videoClip("clip_a", 1);
    const m = manifest([track("trk_a", [clip]), track("trk_b", [])]);
    const once = moveClipBetweenTracks(m, "trk_b", clip, 3);
    const twice = moveClipBetweenTracks(once, "trk_b", { ...clip, start: 3 }, 4);
    expect(twice.tracks[1].clips).toHaveLength(1);
    expect(twice.tracks[1].clips[0].start).toBe(4);
    const allIds = twice.tracks.flatMap((t) => t.clips.map((c) => c.id));
    expect(allIds.filter((id) => id === "clip_a")).toHaveLength(1);
  });

  it("removes stale copies before placing on the target track", () => {
    const clip = videoClip("clip_a", 1);
    const corrupted = manifest([
      track("trk_a", [clip, { ...clip, start: 1 }, { ...clip, start: 1 }]),
      track("trk_b", []),
    ]);
    const out = moveClipBetweenTracks(corrupted, "trk_b", clip, 2);
    expect(out.tracks[0].clips).toHaveLength(0);
    expect(out.tracks[1].clips).toHaveLength(1);
    expect(out.tracks[1].clips[0].start).toBe(2);
  });
});

describe("timeline clip clipboard", () => {
  it("buildTimelineClipClipboard uses earliest start as anchor across tracks", () => {
    const m = manifest([
      track("trk_a", [videoClip("clip_a", 5)]),
      { id: "trk_b", name: "trk_b", kind: "audio", clips: [videoClip("clip_b", 2)] },
    ]);
    const cb = buildTimelineClipClipboard(m, ["clip_a", "clip_b"]);
    expect(cb).not.toBeNull();
    expect(cb!.anchorStart).toBe(2);
    expect(cb!.items).toHaveLength(2);
    expect(cb!.items.map((i) => i.trackId).sort()).toEqual(["trk_a", "trk_b"]);
  });

  it("cloneTimelineClipForPaste assigns a new id and deep-copies nested data", () => {
    const clip: TimelineClip = {
      ...videoClip("clip_src", 1),
      type: "geometry",
      geometry: createGeometryData("rect"),
      trajectory: {
        motion: "bounce",
        motionAmount: 40,
        waypoints: [{ t: 0, x: 0, y: 0, scale: 1 }],
      },
    };
    const cloned = cloneTimelineClipForPaste(clip);
    expect(cloned.id).not.toBe("clip_src");
    expect(cloned.srcRelPath).toBe(clip.srcRelPath);
    expect(cloned.geometry).not.toBe(clip.geometry);
    expect(cloned.trajectory).not.toBe(clip.trajectory);
    expect(cloned.trajectory?.waypoints).not.toBe(clip.trajectory?.waypoints);
  });

  it("pasteTimelineClipClipboard shifts starts to playhead and preserves tracks", () => {
    const m = manifest([
      track("trk_a", [videoClip("clip_a", 5)]),
      track("trk_b", [videoClip("clip_b", 8)]),
    ]);
    const cb = buildTimelineClipClipboard(m, ["clip_a", "clip_b"]);
    expect(cb).not.toBeNull();
    expect(cb!.anchorStart).toBe(5);
    const { manifest: out, newClipIds } = pasteTimelineClipClipboard(m, cb!, 10);
    expect(newClipIds).toHaveLength(2);
    const pastedA = out.tracks[0].clips.find((c) => newClipIds.includes(c.id));
    const pastedB = out.tracks[1].clips.find((c) => newClipIds.includes(c.id));
    expect(pastedA?.start).toBe(10);
    expect(pastedB?.start).toBe(13);
    expect(out.tracks[0].clips.some((c) => c.id === "clip_a")).toBe(true);
    expect(out.tracks[1].clips.some((c) => c.id === "clip_b")).toBe(true);
  });
});

describe("clipTransformAtPlayhead", () => {
  it("interpolates trajectory waypoints at different scrub times", () => {
    const clip: TimelineClip = {
      ...videoClip("clip_a", 0),
      duration: 4,
      trajectory: {
        motion: "none",
        motionAmount: 50,
        waypoints: [
          { t: 0, x: -0.2, y: 0, scale: 1 },
          { t: 1, x: 0.2, y: 0.1, scale: 1.1 },
        ],
      },
    };
    const atStart = clipTransformAtPlayhead(clip, 0);
    const atMid = clipTransformAtPlayhead(clip, 2);
    const atEnd = clipTransformAtPlayhead(clip, 4);
    expect(atStart.x).toBeCloseTo(-0.2, 5);
    expect(atMid.x).toBeCloseTo(0, 5);
    expect(atEnd.x).toBeCloseTo(0.2, 5);
    expect(atStart.x).not.toBeCloseTo(atEnd.x, 3);
  });

  it("applies procedural motion while scrubbing within a clip", () => {
    const clip: TimelineClip = {
      ...videoClip("clip_a", 0),
      duration: 4,
      transform: { x: 0, y: 0, scale: 1 },
      trajectory: {
        motion: "pulse",
        motionAmount: 100,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0, y: 0, scale: 1 },
        ],
      },
    };
    const t0 = clipTransformAtPlayhead(clip, 0.5);
    const t1 = clipTransformAtPlayhead(clip, 1.5);
    expect(t0.scale).not.toBeCloseTo(t1.scale, 3);
  });

  it("falls back to clip transform when no trajectory", () => {
    const clip: TimelineClip = {
      ...videoClip("clip_a", 0),
      transform: { x: 0.25, y: -0.1, scale: 0.8 },
    };
    expect(clipTransformAtPlayhead(clip, 1)).toMatchObject({
      x: 0.25,
      y: -0.1,
      scale: 0.8,
    });
  });
});
