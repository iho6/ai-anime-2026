import { describe, expect, it } from "vitest";
import type {
  FrameSequencePayload,
  TimelineClip,
  TimelineManifest,
} from "../../lib/api";
import {
  applyEncodedFrameSequenceReplacements,
  applyFrameSequencePayloads,
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
});
