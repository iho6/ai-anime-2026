import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineManifest, TimelineTrack } from "../../lib/api";
import {
  applyPreviewDragToTrajectory,
  buildTimelineClipClipboard,
  clampClipRectToFrame,
  clipImageRect,
  cloneTimelineClipForPaste,
  clipTransformAtPlayhead,
  dedupeTimelineManifestClips,
  moveClipBetweenTracks,
  pasteTimelineClipClipboard,
  playbackEndPlayhead,
  previewClipHitZIndex,
  previewMoveTransformFromPointerDelta,
  PREVIEW_MIN_VISIBLE_PX,
  PREVIEW_SELECTION_CHROME_Z,
  snapClipRectToFrameScaleAware,
  translateClipRect,
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
        motionTailSec: 0.75,
        waypoints: [{ t: 0, x: 0, y: 0, scale: 1 }],
      },
    };
    const cloned = cloneTimelineClipForPaste(clip);
    expect(cloned.id).not.toBe("clip_src");
    expect(cloned.srcRelPath).toBe(clip.srcRelPath);
    expect(cloned.geometry).not.toBe(clip.geometry);
    expect(cloned.trajectory).not.toBe(clip.trajectory);
    expect(cloned.trajectory?.waypoints).not.toBe(clip.trajectory?.waypoints);
    expect(cloned.trajectory?.motionTailSec).toBe(0.75);
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

describe("applyPreviewDragToTrajectory", () => {
  const baseClip: TimelineClip = {
    ...videoClip("clip_a", 0),
    trajectory: {
      motion: "none",
      motionAmount: 50,
      waypoints: [
        { t: 0, x: -0.1, y: 0, scale: 1 },
        { t: 0.5, x: 0.1, y: 0.05, scale: 1.2 },
        { t: 1, x: 0.2, y: 0.1, scale: 1 },
      ],
    },
  };

  it("offsets all waypoint positions on move drag", () => {
    const updated = applyPreviewDragToTrajectory(
      baseClip,
      { x: 0, y: 0, scale: 1 },
      { x: 0.05, y: -0.02, scale: 1 },
      "move"
    );
    expect(updated!.waypoints[0].x).toBeCloseTo(-0.05, 5);
    expect(updated!.waypoints[0].y).toBeCloseTo(-0.02, 5);
    expect(updated!.waypoints[1].x).toBeCloseTo(0.15, 5);
    expect(updated!.waypoints[1].y).toBeCloseTo(0.03, 5);
    expect(updated!.waypoints[2].x).toBeCloseTo(0.25, 5);
    expect(updated!.waypoints[2].y).toBeCloseTo(0.08, 5);
  });

  it("scales all waypoint scales uniformly", () => {
    const updated = applyPreviewDragToTrajectory(
      baseClip,
      { x: 0, y: 0, scale: 1 },
      { x: 0, y: 0, scale: 1.5 },
      "scale"
    );
    expect(updated!.waypoints[0].scale).toBeCloseTo(1.5, 5);
    expect(updated!.waypoints[1].scale).toBeCloseTo(1.8, 5);
    expect(updated!.waypoints[2].scale).toBeCloseTo(1.5, 5);
  });

  it("returns null when clip has no trajectory", () => {
    const clip = videoClip("clip_a", 0);
    expect(
      applyPreviewDragToTrajectory(clip, { x: 0, y: 0, scale: 1 }, { x: 1, y: 0, scale: 1 }, "move")
    ).toBeNull();
  });

  it("does not clamp waypoint positions on large move deltas", () => {
    const updated = applyPreviewDragToTrajectory(
      baseClip,
      { x: 0, y: 0, scale: 1 },
      { x: 2.5, y: -2, scale: 1 },
      "move"
    );
    expect(updated!.waypoints[0].x).toBeCloseTo(2.4, 5);
    expect(updated!.waypoints[0].y).toBeCloseTo(-2, 5);
  });

  it("move stays absolute across a gesture when applied from the origin clip", () => {
    const from = { x: 0, y: 0, scale: 1 };
    // Simulate a multi-move gesture; the caller always passes the ORIGIN clip.
    let result: NonNullable<TimelineClip["trajectory"]> | null = null;
    for (const to of [
      { x: 0.05, y: 0, scale: 1 },
      { x: 0.2, y: -0.1, scale: 1 },
      { x: 0.5, y: -0.3, scale: 1 },
    ]) {
      result = applyPreviewDragToTrajectory(baseClip, from, to, "move");
    }
    // Final position reflects ONLY the last `to` (absolute), no accumulation.
    expect(result!.waypoints[0].x).toBeCloseTo(-0.1 + 0.5, 5);
    expect(result!.waypoints[0].y).toBeCloseTo(0 - 0.3, 5);
    expect(result!.waypoints[1].x).toBeCloseTo(0.1 + 0.5, 5);
    expect(result!.waypoints[2].x).toBeCloseTo(0.2 + 0.5, 5);
  });

  it("move is idempotent w.r.t. earlier frames (origin-based)", () => {
    const from = { x: 0, y: 0, scale: 1 };
    const to2 = { x: 0.3, y: 0.15, scale: 1 };
    const direct = applyPreviewDragToTrajectory(baseClip, from, to2, "move");
    const afterFirst = applyPreviewDragToTrajectory(
      baseClip,
      from,
      { x: 0.1, y: 0.05, scale: 1 },
      "move"
    );
    void afterFirst;
    const viaGesture = applyPreviewDragToTrajectory(baseClip, from, to2, "move");
    expect(viaGesture!.waypoints[0].x).toBeCloseTo(direct!.waypoints[0].x, 5);
    expect(viaGesture!.waypoints[0].y).toBeCloseTo(direct!.waypoints[0].y, 5);
  });

  it("scale stays absolute across a gesture when applied from the origin clip", () => {
    const from = { x: 0, y: 0, scale: 1 };
    let result: NonNullable<TimelineClip["trajectory"]> | null = null;
    for (const to of [
      { x: 0, y: 0, scale: 1.2 },
      { x: 0, y: 0, scale: 1.6 },
      { x: 0, y: 0, scale: 2 },
    ]) {
      result = applyPreviewDragToTrajectory(baseClip, from, to, "scale");
    }
    // ratio = 2/1 applied to origin scales, not compounded (1 -> 2, 1.2 -> 2.4).
    expect(result!.waypoints[0].scale).toBeCloseTo(1 * 2, 5);
    expect(result!.waypoints[1].scale).toBeCloseTo(1.2 * 2, 5);
    expect(result!.waypoints[2].scale).toBeCloseTo(1 * 2, 5);
  });
});

describe("preview move drag helpers", () => {
  const frameW = 800;
  const frameH = 450;
  const scaledClip: TimelineClip = {
    ...videoClip("clip_scaled"),
    naturalW: 1600,
    naturalH: 900,
  };
  const orig = { x: 0, y: 0, scale: 3 };

  it("translateClipRect shifts left/top by pointer delta", () => {
    const rect = { left: 10, top: 20, width: 100, height: 50 };
    expect(translateClipRect(rect, 5, -3)).toEqual({
      left: 15,
      top: 17,
      width: 100,
      height: 50,
    });
  });

  it("previewMoveTransformFromPointerDelta tracks cursor 1:1 before snap", () => {
    const startRect = clipImageRect(scaledClip, orig, frameW, frameH);
    const { to } = previewMoveTransformFromPointerDelta({
      orig,
      startRect,
      startClientX: 100,
      startClientY: 200,
      clientX: 140,
      clientY: 200,
      frameW,
      frameH,
    });
    expect(to.x - orig.x).toBeCloseTo(40 / frameW, 5);
    expect(to.y - orig.y).toBeCloseTo(0, 5);
    expect(to.scale).toBe(3);
  });

  it("small pointer delta produces small transform delta (no jump)", () => {
    const startRect = clipImageRect(scaledClip, orig, frameW, frameH);
    const { to } = previewMoveTransformFromPointerDelta({
      orig,
      startRect,
      startClientX: 0,
      startClientY: 0,
      clientX: 2,
      clientY: -1,
      frameW,
      frameH,
    });
    expect(Math.abs(to.x - orig.x)).toBeLessThan(0.01);
    expect(Math.abs(to.y - orig.y)).toBeLessThan(0.01);
  });

  it("snapClipRectToFrameScaleAware skips far-off left border for oversized rects", () => {
    const oversized = { left: -200, top: 0, width: frameW + 400, height: frameH };
    const { rect } = snapClipRectToFrameScaleAware(oversized, frameW, frameH);
    expect(rect.left).toBe(-200);
  });

  it("snapClipRectToFrameScaleAware snaps near left border within threshold", () => {
    const nearLeft = { left: -4, top: 100, width: 200, height: 100 };
    const { rect, guides } = snapClipRectToFrameScaleAware(nearLeft, frameW, frameH);
    expect(rect.left).toBe(0);
    expect(guides.some((g) => g.axis === "x" && g.kind === "border" && g.pos === 0)).toBe(true);
  });

  it("clampClipRectToFrame keeps a grabbable strip inside the frame", () => {
    const minVisible = Math.max(PREVIEW_MIN_VISIBLE_PX, 0.1 * Math.min(frameW, frameH));
    const flungRight = { left: frameW + 500, top: frameH + 500, width: 200, height: 120 };
    const clamped = clampClipRectToFrame(flungRight, frameW, frameH);
    expect(clamped.left).toBeLessThanOrEqual(frameW - minVisible);
    expect(clamped.left + clamped.width).toBeGreaterThanOrEqual(minVisible);
    expect(clamped.top).toBeLessThanOrEqual(frameH - minVisible);
    expect(clamped.top + clamped.height).toBeGreaterThanOrEqual(minVisible);
  });

  it("clampClipRectToFrame leaves an in-bounds rect untouched", () => {
    const inside = { left: 100, top: 100, width: 200, height: 120 };
    expect(clampClipRectToFrame(inside, frameW, frameH)).toEqual(inside);
  });

  it("previewMoveTransformFromPointerDelta clamps a huge fling to stay reachable", () => {
    const minVisible = Math.max(PREVIEW_MIN_VISIBLE_PX, 0.1 * Math.min(frameW, frameH));
    const startRect = clipImageRect(scaledClip, orig, frameW, frameH);
    const { to } = previewMoveTransformFromPointerDelta({
      orig,
      startRect,
      startClientX: 0,
      startClientY: 0,
      clientX: 5000,
      clientY: 5000,
      frameW,
      frameH,
    });
    const rect = clipImageRect(scaledClip, to, frameW, frameH);
    const overlapX = Math.min(frameW, rect.left + rect.width) - Math.max(0, rect.left);
    const overlapY = Math.min(frameH, rect.top + rect.height) - Math.max(0, rect.top);
    expect(overlapX).toBeGreaterThanOrEqual(minVisible - 0.001);
    expect(overlapY).toBeGreaterThanOrEqual(minVisible - 0.001);
  });
});

describe("previewClipHitZIndex", () => {
  it("keeps selected top-track clip above unselected lower-track overlap", () => {
    const selectedTop = previewClipHitZIndex({ trackZ: 3, selected: true, inEditMode: false });
    const unselectedBottom = previewClipHitZIndex({ trackZ: 1, selected: false, inEditMode: false });
    expect(selectedTop).toBeGreaterThan(unselectedBottom);
  });

  it("uses low z-index while editing so editors stay on top", () => {
    expect(previewClipHitZIndex({ trackZ: 3, selected: true, inEditMode: true })).toBe(50);
  });
});

describe("PREVIEW_SELECTION_CHROME_Z", () => {
  it("stacks above clip hit targets and timeline track UI", () => {
    expect(PREVIEW_SELECTION_CHROME_Z).toBeGreaterThan(previewClipHitZIndex({ trackZ: 99, selected: true, inEditMode: false }));
  });
});
