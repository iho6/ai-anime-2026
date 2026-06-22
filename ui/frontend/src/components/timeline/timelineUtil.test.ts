import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineManifest, TimelineTrack } from "../../lib/api";
import {
  dedupeTimelineManifestClips,
  moveClipBetweenTracks,
} from "./timelineUtil";

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
