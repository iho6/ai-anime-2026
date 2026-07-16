import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineManifest, TimelineTrack } from "../../lib/api";
import {
  activeLayersAt,
  applyPreviewDragToTrajectory,
  buildAudioClip,
  buildImageClip,
  buildVideoClip,
  buildTimelineClipClipboard,
  clampClipRectToFrame,
  clipImageRect,
  clipPathOutsideInnerFrame,
  clipRectInExtendedLayer,
  clipTransformFromRectCenter,
  computePreviewFrameExtension,
  computeTrajectoryEditFrameExtension,
  HARD_CUT_PRELOAD_SEC,
  PREVIEW_OUTSIDE_FRAME_OPACITY,
  mergePreviewFrameExtension,
  growExtensionFromBaseline,
  symmetricPreviewFrameExtension,
  cloneTimelineClipForPaste,
  clipTransformAtPlayhead,
  dedupeTimelineManifestClips,
  moveClipBetweenTracks,
  pasteTimelineClipClipboard,
  playbackEndPlayhead,
  placeExternalMediaBatch,
  previewClipHitZIndex,
  pointerClientDeltaInFrameSpace,
  previewMoveTransformFromPointerDelta,
  PREVIEW_EDIT_Z,
  PREVIEW_HIT_Z,
  PREVIEW_HIT_TRACK_STEP,
  PREVIEW_MIN_VISIBLE_PX,
  PREVIEW_SELECTION_CHROME_Z,
  nudgeClipTransform,
  PREVIEW_NUDGE_PX,
  PREVIEW_NUDGE_SHIFT_PX,
  snapClipRectToFrameScaleAware,
  trajectoryWaypointHitRadiusPx,
  trajectoryWaypointHitRectAt,
  TRAJECTORY_WAYPOINT_HIT_MAX_PX,
  TRAJECTORY_WAYPOINT_HIT_MIN_PX,
  translateClipRect,
  resolveVideoBgReplaceTiming,
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

describe("placeExternalMediaBatch", () => {
  const emptyManifest = (): TimelineManifest => ({
    version: 1,
    fps: 24,
    previewAspect: "16:9",
    tracks: [],
  });

  it("places mixed media sequentially per kind from the same timestamp", () => {
    const image = buildImageClip({ srcRelPath: "a.png", width: 100, height: 100 });
    const audioA = buildAudioClip({ srcRelPath: "a.mp3", durationSec: 2 });
    const video = buildVideoClip({
      srcRelPath: "v.mp4",
      durationSec: 3,
      width: 1920,
      height: 1080,
    });
    const audioB = buildAudioClip({ srcRelPath: "b.mp3", durationSec: 4 });
    const result = placeExternalMediaBatch({
      manifest: emptyManifest(),
      targetTrackId: null,
      startSec: 5,
      clips: [image, audioA, video, audioB],
    });
    const visual = result.manifest.tracks.find((track) => track.kind === "video")!;
    const audio = result.manifest.tracks.find((track) => track.kind === "audio")!;
    expect(visual.clips.map((clip) => [clip.srcRelPath, clip.start])).toEqual([
      ["a.png", 5],
      ["v.mp4", 8],
    ]);
    expect(audio.clips.map((clip) => [clip.srcRelPath, clip.start])).toEqual([
      ["a.mp3", 5],
      ["b.mp3", 7],
    ]);
  });

  it("promotes an empty neutral target and creates a lane for an incompatible group", () => {
    const neutral: TimelineTrack = { id: "neutral", name: "Track", kind: "neutral", clips: [] };
    const result = placeExternalMediaBatch({
      manifest: { ...emptyManifest(), tracks: [neutral] },
      targetTrackId: neutral.id,
      startSec: 2,
      clips: [
        buildAudioClip({ srcRelPath: "sound.wav", durationSec: 1 }),
        buildImageClip({ srcRelPath: "still.png", width: 10, height: 10 }),
      ],
    });
    expect(result.manifest.tracks.find((track) => track.id === neutral.id)?.kind).toBe("audio");
    expect(result.manifest.tracks.some((track) => track.kind === "video")).toBe(true);
  });

  it("does not ripple or overlap an occupied target lane", () => {
    const target: TimelineTrack = {
      id: "video",
      name: "Video 1",
      kind: "video",
      clips: [videoClip("existing", 4)],
    };
    const result = placeExternalMediaBatch({
      manifest: { ...emptyManifest(), tracks: [target] },
      targetTrackId: target.id,
      startSec: 5,
      clips: [buildImageClip({ srcRelPath: "new.png", width: 10, height: 10 })],
    });
    expect(result.manifest.tracks[0].clips).toEqual(target.clips);
    expect(result.manifest.tracks).toHaveLength(2);
    expect(result.manifest.tracks[1].clips[0].start).toBe(5);
  });
});

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

  it("previewMoveTransformFromPointerDelta clamps a huge fling to stay reachable in expanded canvas", () => {
    const minVisible = Math.max(PREVIEW_MIN_VISIBLE_PX, 0.1 * Math.min(frameW, frameH));
    const startRect = clipImageRect(scaledClip, orig, frameW, frameH);
    const { to, extend } = previewMoveTransformFromPointerDelta({
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
    const canvasLeft = -extend.left;
    const canvasTop = -extend.top;
    const canvasRight = frameW + extend.right;
    const canvasBottom = frameH + extend.bottom;
    const overlapX =
      Math.min(canvasRight, rect.left + rect.width) - Math.max(canvasLeft, rect.left);
    const overlapY =
      Math.min(canvasBottom, rect.top + rect.height) - Math.max(canvasTop, rect.top);
    expect(overlapX).toBeGreaterThanOrEqual(minVisible - 0.001);
    expect(overlapY).toBeGreaterThanOrEqual(minVisible - 0.001);
  });

  it("clampClipRectToFrame with bottom extension allows further downward drag", () => {
    const minVisible = Math.max(PREVIEW_MIN_VISIBLE_PX, 0.1 * Math.min(frameW, frameH));
    const rect = { left: 100, top: frameH - minVisible + 80, width: 200, height: 120 };
    const baseClamped = clampClipRectToFrame(rect, frameW, frameH);
    expect(baseClamped.top).toBeLessThanOrEqual(frameH - minVisible);
    const extended = clampClipRectToFrame(rect, frameW, frameH, PREVIEW_MIN_VISIBLE_PX, {
      top: 0,
      right: 0,
      bottom: 200,
      left: 0,
    });
    expect(extended.top).toBeGreaterThan(baseClamped.top);
  });

  it("clampClipRectToFrame with top extension allows further upward drag", () => {
    const minVisible = Math.max(PREVIEW_MIN_VISIBLE_PX, 0.1 * Math.min(frameW, frameH));
    const rect = { left: 100, top: minVisible - 80 - 120, width: 200, height: 120 };
    const baseClamped = clampClipRectToFrame(rect, frameW, frameH);
    expect(baseClamped.top).toBeGreaterThanOrEqual(minVisible - 120);
    const extended = clampClipRectToFrame(rect, frameW, frameH, PREVIEW_MIN_VISIBLE_PX, {
      top: 200,
      right: 0,
      bottom: 0,
      left: 0,
    });
    expect(extended.top).toBeLessThan(baseClamped.top);
    expect(extended.top).toBe(rect.top);
  });

  it("clampClipRectToFrame with left extension allows further leftward drag", () => {
    const minVisible = Math.max(PREVIEW_MIN_VISIBLE_PX, 0.1 * Math.min(frameW, frameH));
    const rect = { left: minVisible - 80 - 200, top: 100, width: 200, height: 120 };
    const baseClamped = clampClipRectToFrame(rect, frameW, frameH);
    const extended = clampClipRectToFrame(rect, frameW, frameH, PREVIEW_MIN_VISIBLE_PX, {
      top: 0,
      right: 0,
      bottom: 0,
      left: 200,
    });
    expect(extended.left).toBeLessThan(baseClamped.left);
    expect(extended.left).toBe(rect.left);
  });

  it("previewMoveTransformFromPointerDelta expands canvas when dragging past top", () => {
    const startRect = clipImageRect(scaledClip, orig, frameW, frameH);
    const { to, extend } = previewMoveTransformFromPointerDelta({
      orig,
      startRect,
      startClientX: 0,
      startClientY: 0,
      clientX: 0,
      clientY: -400,
      frameW,
      frameH,
    });
    expect(extend.top).toBeGreaterThan(0);
    const rect = clipImageRect(scaledClip, to, frameW, frameH);
    expect(rect.top).toBeLessThan(1);
  });

  it("previewMoveTransformFromPointerDelta expands canvas when dragging past left", () => {
    const startRect = clipImageRect(scaledClip, orig, frameW, frameH);
    const { to, extend } = previewMoveTransformFromPointerDelta({
      orig,
      startRect,
      startClientX: 0,
      startClientY: 0,
      clientX: -400,
      clientY: 0,
      frameW,
      frameH,
    });
    expect(extend.left).toBeGreaterThan(0);
    const rect = clipImageRect(scaledClip, to, frameW, frameH);
    expect(rect.left).toBeLessThan(1);
  });

  it("computePreviewFrameExtension reports overflow on each side", () => {
    const clip: TimelineClip = {
      ...scaledClip,
      transform: { x: 0, y: 1.2, scale: 1 },
    };
    const ext = computePreviewFrameExtension([clip], 0, frameW, frameH, 0);
    expect(ext.bottom).toBeGreaterThan(0);
    expect(ext.top).toBe(0);
  });

  it("previewMoveTransformFromPointerDelta expands canvas when dragging past bottom", () => {
    const startRect = clipImageRect(scaledClip, orig, frameW, frameH);
    const { to, extend } = previewMoveTransformFromPointerDelta({
      orig,
      startRect,
      startClientX: 0,
      startClientY: 0,
      clientX: 0,
      clientY: 400,
      frameW,
      frameH,
    });
    expect(extend.bottom).toBeGreaterThan(0);
    const rect = clipImageRect(scaledClip, to, frameW, frameH);
    expect(rect.top + rect.height).toBeGreaterThan(frameH - 1);
  });

  it("previewMoveTransformFromPointerDelta grows extension monotonically across drag steps", () => {
    const startRect = clipImageRect(scaledClip, orig, frameW, frameH);
    const step1 = previewMoveTransformFromPointerDelta({
      orig,
      startRect,
      startClientX: 0,
      startClientY: 0,
      clientX: 200,
      clientY: 0,
      frameW,
      frameH,
    });
    const step2 = previewMoveTransformFromPointerDelta({
      orig,
      startRect,
      startClientX: 0,
      startClientY: 0,
      clientX: 500,
      clientY: 0,
      frameW,
      frameH,
      extend: step1.extend,
    });
    expect(step2.extend.right).toBeGreaterThanOrEqual(step1.extend.right);
    expect(step2.extend.right).toBeGreaterThan(0);
  });

  it("clipRectInExtendedLayer offsets by extension margins", () => {
    const rect = { left: 10, top: -50, width: 100, height: 80 };
    const extend = { top: 200, right: 30, bottom: 40, left: 25 };
    const layer = clipRectInExtendedLayer(rect, extend);
    expect(layer.left).toBe(35);
    expect(layer.top).toBe(150);
    expect(layer.width).toBe(100);
    expect(layer.height).toBe(80);
    // Visual position from frame origin: inset.top + layer.top === rect.top
    expect(-extend.top + layer.top).toBe(rect.top);
  });

  it("clipPathOutsideInnerFrame returns evenodd polygon with inner hole", () => {
    const extend = { top: 50, right: 20, bottom: 30, left: 40 };
    const path = clipPathOutsideInnerFrame(320, 180, extend);
    expect(path).toMatch(/^polygon\(evenodd,/);
    expect(path).toContain("40px 50px");
    expect(path).toContain("360px 50px");
    expect(path).toContain("360px 230px");
    expect(path).toContain("40px 230px");
    expect(path).toContain("380px 0");
    expect(path).toContain("380px 260px");
  });

  it("clipPathOutsideInnerFrame degenerates when canvas has no size", () => {
    expect(clipPathOutsideInnerFrame(0, 180, { top: 0, right: 0, bottom: 0, left: 0 })).toBe(
      "polygon(0 0, 0 0, 0 0)"
    );
  });

  it("PREVIEW_OUTSIDE_FRAME_OPACITY matches trajectory ghost", () => {
    expect(PREVIEW_OUTSIDE_FRAME_OPACITY).toBe(0.35);
  });

  it("computeTrajectoryEditFrameExtension expands right when waypoints past frame edge", () => {
    const frameW = 320;
    const frameH = 180;
    const wps = [
      { t: 0, x: 0.57, y: 0.07, scale: 1 },
      { t: 1, x: -0.09, y: 0.07, scale: 1 },
    ] as const;
    const ext = computeTrajectoryEditFrameExtension([...wps], frameW, frameH, 0);
    expect(ext.right).toBeGreaterThan(0);
  });

  it("computeTrajectoryEditFrameExtension expands top when waypoints above frame", () => {
    const frameW = 320;
    const frameH = 180;
    const wps = [
      { t: 0, x: 0, y: -0.8, scale: 1 },
      { t: 1, x: 0.1, y: 0, scale: 1 },
    ] as const;
    const ext = computeTrajectoryEditFrameExtension([...wps], frameW, frameH, 0);
    expect(ext.top).toBeGreaterThan(0);
  });

  it("computeTrajectoryEditFrameExtension expands left when waypoints past left edge", () => {
    const frameW = 320;
    const frameH = 180;
    const wps = [
      { t: 0, x: -0.8, y: 0, scale: 1 },
      { t: 1, x: 0, y: 0, scale: 1 },
    ] as const;
    const ext = computeTrajectoryEditFrameExtension([...wps], frameW, frameH, 0);
    expect(ext.left).toBeGreaterThan(0);
  });

  it("computeTrajectoryEditFrameExtension grows from out-of-frame clip bounds", () => {
    const frameW = 320;
    const frameH = 180;
    const wps = [
      { t: 0, x: 0, y: 0, scale: 0.35 },
      { t: 1, x: 0.05, y: 0, scale: 0.35 },
    ] as const;
    const without = computeTrajectoryEditFrameExtension([...wps], frameW, frameH, 0);
    expect(without).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    const withClip = computeTrajectoryEditFrameExtension(
      [...wps],
      frameW,
      frameH,
      0,
      { left: -80, top: 40, width: 100, height: 80 }
    );
    expect(withClip.left).toBeGreaterThan(0);
  });

  it("computeTrajectoryEditFrameExtension is zero for in-bounds waypoints", () => {
    const frameW = 320;
    const frameH = 180;
    const wps = [
      { t: 0, x: 0, y: 0, scale: 0.35 },
      { t: 1, x: 0.1, y: -0.1, scale: 0.35 },
    ] as const;
    const ext = computeTrajectoryEditFrameExtension([...wps], frameW, frameH, 0);
    expect(ext).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("computeTrajectoryEditFrameExtension default pad does not grow empty sides", () => {
    const frameW = 320;
    const frameH = 180;
    const wps = [
      { t: 0, x: 0, y: 0, scale: 0.35 },
      { t: 1, x: 0.1, y: -0.1, scale: 0.35 },
    ] as const;
    const inFrame = computeTrajectoryEditFrameExtension([...wps], frameW, frameH);
    expect(inFrame).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    const above = computeTrajectoryEditFrameExtension(
      [
        { t: 0, x: 0, y: -0.8, scale: 1 },
        { t: 1, x: 0, y: -0.8, scale: 1 },
      ],
      frameW,
      frameH
    );
    expect(above.top).toBeGreaterThan(0);
    expect(above.left).toBe(0);
    expect(above.right).toBe(0);
    expect(above.bottom).toBe(0);
  });

  it("symmetricPreviewFrameExtension uses max edge on all sides", () => {
    expect(
      symmetricPreviewFrameExtension({ top: 5, right: 20, bottom: 10, left: 3 })
    ).toEqual({ top: 20, right: 20, bottom: 20, left: 20 });
  });

  it("computeTrajectoryEditFrameExtension is stable for same waypoints", () => {
    const frameW = 320;
    const frameH = 180;
    const wps = [
      { t: 0, x: 0.57, y: 0.07, scale: 1 },
      { t: 1, x: -0.09, y: 0.07, scale: 1 },
    ] as const;
    const extA = computeTrajectoryEditFrameExtension([...wps], frameW, frameH, 0);
    const extB = computeTrajectoryEditFrameExtension([...wps], frameW, frameH, 0);
    expect(extA).toEqual(extB);
    const extC = computeTrajectoryEditFrameExtension(
      [{ t: 0, x: 0.57, y: 0.07, scale: 1 }, { t: 0.5, x: 0.9, y: 0, scale: 1 }, { t: 1, x: -0.09, y: 0.07, scale: 1 }],
      frameW,
      frameH,
      0
    );
    expect(extC.right).toBeGreaterThan(extA.right);
  });

  it("computePreviewFrameExtension shrinks when clip returns in-bounds", () => {
    const outClip: TimelineClip = {
      ...scaledClip,
      transform: { x: 0, y: -1.5, scale: 1 },
    };
    const outExt = computePreviewFrameExtension([outClip], 0, frameW, frameH, 0);
    expect(outExt.top).toBeGreaterThan(0);

    const inClip: TimelineClip = {
      ...scaledClip,
      transform: { x: 0, y: 0, scale: 1 },
    };
    const inExt = computePreviewFrameExtension([inClip], 0, frameW, frameH, 0);
    expect(inExt.top).toBeLessThan(outExt.top);
    expect(inExt.top).toBe(0);
  });
});

describe("growExtensionFromBaseline", () => {
  it("returns zero when current matches baseline", () => {
    const base = { top: 40, right: 10, bottom: 20, left: 5 };
    expect(growExtensionFromBaseline(base, base)).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("keeps only growth past the baseline per edge", () => {
    const baseline = { top: 100, right: 0, bottom: 0, left: 50 };
    const current = { top: 140, right: 30, bottom: 0, left: 40 };
    expect(growExtensionFromBaseline(current, baseline)).toEqual({
      top: 40,
      right: 30,
      bottom: 0,
      left: 0,
    });
  });
});

describe("pointerClientDeltaInFrameSpace", () => {
  it("matches raw viewport delta when the frame has not moved", () => {
    const { dx, dy } = pointerClientDeltaInFrameSpace({
      clientX: 140,
      clientY: 220,
      startClientX: 100,
      startClientY: 200,
      frameLeft: 50,
      frameTop: 80,
      startFrameLeft: 50,
      startFrameTop: 80,
    });
    expect(dx).toBe(40);
    expect(dy).toBe(20);
  });

  it("subtracts frame shift so padding growth does not invert drag", () => {
    // Mouse moved up 100px; frame also shifted down 60px from top padding growth.
    const { dx, dy } = pointerClientDeltaInFrameSpace({
      clientX: 100,
      clientY: 100,
      startClientX: 100,
      startClientY: 200,
      frameLeft: 50,
      frameTop: 140,
      startFrameLeft: 50,
      startFrameTop: 80,
    });
    expect(dx).toBe(0);
    // Viewport dy = -100; frame moved +60 → frame-local dy = -160 (still upward).
    expect(dy).toBe(-160);
  });
});

describe("previewClipHitZIndex", () => {
  it("orders hits by trackZ so higher tracks win overlap", () => {
    const topTrack = previewClipHitZIndex({ trackZ: 3, selected: false });
    const bottomTrack = previewClipHitZIndex({ trackZ: 1, selected: false });
    expect(topTrack).toBeGreaterThan(bottomTrack);
    expect(topTrack - bottomTrack).toBe(2 * PREVIEW_HIT_TRACK_STEP);
  });

  it("uses integer steps so CSS z-index truncation cannot collapse tracks", () => {
    expect(Number.isInteger(PREVIEW_HIT_TRACK_STEP)).toBe(true);
    expect(Number.isInteger(previewClipHitZIndex({ trackZ: 1, selected: false }))).toBe(
      true
    );
    expect(Number.isInteger(previewClipHitZIndex({ trackZ: 2, selected: true }))).toBe(
      true
    );
  });

  it("does not let selected lower track beat unselected higher track", () => {
    const selectedLow = previewClipHitZIndex({ trackZ: 1, selected: true });
    const unselectedHigh = previewClipHitZIndex({ trackZ: 3, selected: false });
    expect(unselectedHigh).toBeGreaterThan(selectedLow);
  });

  it("gives selected clip a +1 tie-break on the same trackZ", () => {
    const selected = previewClipHitZIndex({ trackZ: 2, selected: true });
    const unselected = previewClipHitZIndex({ trackZ: 2, selected: false });
    expect(selected).toBeGreaterThan(unselected);
    expect(selected - unselected).toBe(1);
  });
});

describe("PREVIEW_HIT_Z and PREVIEW_SELECTION_CHROME_Z", () => {
  it("stacks hit targets above visual selection chrome", () => {
    expect(PREVIEW_HIT_Z).toBeGreaterThan(PREVIEW_SELECTION_CHROME_Z);
    expect(previewClipHitZIndex({ trackZ: 99, selected: false })).toBeGreaterThan(
      PREVIEW_SELECTION_CHROME_Z
    );
  });

  it("stacks edit overlays above typical clip hit targets", () => {
    expect(PREVIEW_EDIT_Z).toBeGreaterThan(
      previewClipHitZIndex({ trackZ: 90, selected: true })
    );
  });
});

describe("trajectoryWaypointHitRadiusPx", () => {
  it("caps hit size for large waypoint scale", () => {
    expect(trajectoryWaypointHitRadiusPx(6)).toBe(TRAJECTORY_WAYPOINT_HIT_MAX_PX / 2);
  });

  it("keeps a minimum hit size for tiny scale", () => {
    expect(trajectoryWaypointHitRadiusPx(0.05)).toBe(TRAJECTORY_WAYPOINT_HIT_MIN_PX / 2);
  });

  it("centers hit rect on waypoint", () => {
    const rect = trajectoryWaypointHitRectAt(100, 200, 1);
    expect(rect.left + rect.width / 2).toBeCloseTo(100);
    expect(rect.top + rect.height / 2).toBeCloseTo(200);
  });
});

describe("nudgeClipTransform", () => {
  it("converts pixel delta to fractional translate", () => {
    const tf = { x: 0.1, y: -0.05, scale: 1 };
    const nudged = nudgeClipTransform(tf, 8, -4, 800, 400);
    expect(nudged.x).toBeCloseTo(0.11);
    expect(nudged.y).toBeCloseTo(-0.06);
    expect(nudged.scale).toBe(1);
  });

  it("uses nudge step constants", () => {
    expect(PREVIEW_NUDGE_PX).toBe(1);
    expect(PREVIEW_NUDGE_SHIFT_PX).toBe(8);
  });
});

describe("activeLayersAt hard-cut preload", () => {
  function imageClip(id: string, start: number, duration = 2): TimelineClip {
    return {
      id,
      type: "image",
      srcRelPath: `clips/${id}.png`,
      start,
      inPoint: 0,
      outPoint: duration,
      speed: 1,
      duration,
    };
  }

  it("preloads the next abutting clip before a hard cut", () => {
    const out = videoClip("v", 0);
    const inn = imageClip("i", 2);
    const tr = track("trk", [out, inn]);
    const layers = activeLayersAt(tr, 2 - HARD_CUT_PRELOAD_SEC / 2);
    expect(layers.map((l) => l.clip.id)).toEqual(["v", "i"]);
    expect(layers[1]?.preload).toBe(true);
    expect(layers[1]?.opacity).toBe(0);
  });

  it("does not preload far from the junction", () => {
    const out = videoClip("v", 0);
    const inn = imageClip("i", 2);
    const tr = track("trk", [out, inn]);
    const layers = activeLayersAt(tr, 0.5);
    expect(layers.map((l) => l.clip.id)).toEqual(["v"]);
  });

  it("fills a float micro-gap between connected clips", () => {
    const out = videoClip("v", 0);
    out.duration = 1.97;
    out.outPoint = 1.97;
    const inn = imageClip("i", 2);
    const tr = track("trk", [out, inn]);
    const layers = activeLayersAt(tr, 1.985);
    expect(layers.map((l) => l.clip.id)).toEqual(["i"]);
  });
});

describe("resolveVideoBgReplaceTiming", () => {
  const fullSource = {
    inPoint: 0,
    outPoint: 5.375,
    speed: 0.55,
    srcDuration: 5.375,
    duration: 9.772727272727273,
  };

  it("keeps full trim when probe under-reports WebM duration", () => {
    const timing = resolveVideoBgReplaceTiming(
      { durationSec: 0.875, fps: 24, frames: 21 },
      fullSource
    );
    expect(timing.srcDuration).toBeCloseTo(5.375);
    expect(timing.outPoint).toBeCloseTo(5.375);
    expect(timing.duration).toBeCloseTo(fullSource.duration!);
    expect(timing.speed).toBe(0.55);
  });

  it("uses frame-derived duration when larger than durationSec", () => {
    const timing = resolveVideoBgReplaceTiming(
      { durationSec: 0.875, fps: 24, frames: 129 },
      { inPoint: 0, outPoint: 5.375, srcDuration: 5.375, speed: 1 }
    );
    expect(timing.srcDuration).toBeCloseTo(5.375);
    expect(timing.outPoint).toBeCloseTo(5.375);
  });

  it("preserves intentional short trims on long media", () => {
    const timing = resolveVideoBgReplaceTiming(
      { durationSec: 5.375, fps: 24, frames: 129 },
      { inPoint: 0, outPoint: 0.875, srcDuration: 5.375, speed: 0.55, duration: 1.59 }
    );
    expect(timing.srcDuration).toBeCloseTo(5.375);
    expect(timing.outPoint).toBeCloseTo(0.875);
    expect(timing.duration).toBeCloseTo(1.59);
  });

  it("does not use timeline duration as source length", () => {
    const timing = resolveVideoBgReplaceTiming(
      { durationSec: 0 },
      { inPoint: 0, duration: 1.59, speed: 0.55 }
    );
    expect(timing.srcDuration).toBe(5);
    expect(timing.outPoint).toBe(5);
  });
});
