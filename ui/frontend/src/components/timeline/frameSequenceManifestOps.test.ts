import { describe, expect, it } from "vitest";
import type {
  FrameSequencePayload,
  TimelineClip,
  TimelineManifest,
} from "../../lib/api";
import {
  applyEncodedFrameSequenceReplacements,
  applyFrameSequencePayloads,
  syncGallerySequenceOntoClip,
} from "./frameSequenceManifestOps";

function strip(group: string, relPath: string): FrameSequencePayload {
  return {
    sequenceGroupId: group,
    strip: [{ kind: "image", relPath }],
    hidden: [],
  };
}

function clip(id: string): TimelineClip {
  return {
    id,
    type: "video",
    srcRelPath: `clips/${id}.mp4`,
    start: 0,
    inPoint: 1,
    outPoint: 3,
    speed: 1,
    duration: 2,
    proxyRelPath: `clips/${id}.proxy.mp4`,
    proxyAlphaRelPath: `clips/${id}.proxy.alpha.mkv`,
  };
}

function manifest(): TimelineManifest {
  return {
    version: 1,
    fps: 24,
    previewAspect: "16:9",
    tracks: [
      { id: "t1", name: "one", kind: "video", clips: [clip("a"), clip("untouched")] },
      { id: "t2", name: "two", kind: "video", clips: [clip("b")] },
    ],
  };
}

describe("applyFrameSequencePayloads", () => {
  it("updates every target clip atomically without touching unrelated clips", () => {
    const input = manifest();
    const untouched = input.tracks[0]!.clips[1]!;
    const out = applyFrameSequencePayloads(input, {
      a: strip("ga", "a.png"),
      b: strip("gb", "b.png"),
    });

    expect(out.tracks[0]!.clips[0]!.frameSequence?.sequenceGroupId).toBe("ga");
    expect(out.tracks[1]!.clips[0]!.frameSequence?.sequenceGroupId).toBe("gb");
    expect(out.tracks[0]!.clips[1]).toBe(untouched);
    expect(input.tracks[0]!.clips[0]!.frameSequence).toBeUndefined();
  });
});

describe("syncGallerySequenceOntoClip", () => {
  it("copies gallery frameSequence onto the clip when different", () => {
    const c = clip("a");
    c.sequenceGallery = [
      {
        id: "gal1",
        relPath: "g/a.png",
        frameSequence: strip("gallery-g", "g/a.png"),
      },
    ];
    c.frameSequence = strip("old", "old.png");
    const synced = syncGallerySequenceOntoClip(c, "gal1");
    expect(synced.frameSequence?.sequenceGroupId).toBe("gallery-g");
    expect(synced.frameSequence?.strip[0]).toMatchObject({
      kind: "image",
      relPath: "g/a.png",
    });
  });

  it("is a no-op when gallery matches clip strip", () => {
    const fs = strip("same", "a.png");
    const c = clip("a");
    c.frameSequence = fs;
    c.sequenceGallery = [{ id: "gal1", relPath: "a.png", frameSequence: fs }];
    expect(syncGallerySequenceOntoClip(c)).toBe(c);
  });

  it("is a no-op without gallery strip", () => {
    const c = clip("a");
    expect(syncGallerySequenceOntoClip(c)).toBe(c);
  });
});

describe("applyEncodedFrameSequenceReplacements", () => {
  function apply(alphaRelPath?: string) {
    const input = manifest();
    input.tracks[0]!.clips[0]!.alphaRelPath = "clips/a-old.alpha.mkv";
    const untouched = input.tracks[0]!.clips[1]!;
    const replacement = {
      clipId: "a",
      strip: strip("ga", "a.png"),
      srcRelPath: "clips/a-new.webm",
      durationSec: 4,
      ...(alphaRelPath ? { alphaRelPath } : {}),
    };
    const out = applyEncodedFrameSequenceReplacements(input, [replacement]);
    const updated = out.tracks[0]!.clips[0]!;
    expect(updated).not.toHaveProperty("proxyRelPath");
    expect(updated).not.toHaveProperty("proxyAlphaRelPath");
    expect(out.tracks[0]!.clips[1]).toBe(untouched);
    return updated;
  }

  it("retains a new alpha path", () => {
    expect(apply("clips/a-new.alpha.mkv").alphaRelPath).toBe("clips/a-new.alpha.mkv");
  });

  it("removes a stale alpha path when the replacement has none", () => {
    expect(apply().alphaRelPath).toBeUndefined();
  });

  it("preserves sequenceGallery across encode/apply", () => {
    const input = manifest();
    const gallery = [
      {
        id: "gal1",
        relPath: "gallery/a.png",
        frameSequence: strip("gallery-group", "gallery/a.png"),
      },
    ];
    input.tracks[0]!.clips[0]!.sequenceGallery = gallery;
    input.tracks[0]!.clips[0]!.frameSequence = strip("old-strip", "old.png");
    const out = applyEncodedFrameSequenceReplacements(input, [
      {
        clipId: "a",
        strip: strip("new-strip", "new.png"),
        srcRelPath: "clips/a-new.webm",
        durationSec: 4,
      },
    ]);
    const updated = out.tracks[0]!.clips[0]!;
    expect(updated.frameSequence?.sequenceGroupId).toBe("new-strip");
    expect(updated.sequenceGallery).toEqual(gallery);
  });
});
