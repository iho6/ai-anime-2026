import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineTrack } from "../../lib/api";
import { previewAudioOutputsAt } from "./timelinePreviewAudio";

function clip(
  id: string,
  type: "audio" | "video",
  start = 0,
  duration = 4
): TimelineClip {
  return {
    id,
    type,
    srcRelPath: `timelines/test/clips/${id}.${type === "audio" ? "mp3" : "mp4"}`,
    start,
    inPoint: 0,
    outPoint: duration,
    speed: 1,
    duration,
    srcDuration: duration,
  };
}

function track(
  id: string,
  kind: "audio" | "video",
  clips: TimelineClip[],
  hidden = false
): TimelineTrack {
  return { id, name: id, kind, clips, hidden };
}

describe("previewAudioOutputsAt", () => {
  it("collects explicit audio and embedded video sound together", () => {
    const audio = clip("music", "audio");
    const video = clip("scene", "video");
    const outputs = previewAudioOutputsAt(
      [track("audio", "audio", [audio]), track("video", "video", [video])],
      1
    );

    expect(outputs.map((o) => o.clip.id).sort()).toEqual(["music", "scene"]);
    expect(outputs.find((o) => o.clip.id === "music")?.sourceKind).toBe("audio-track");
    expect(outputs.find((o) => o.clip.id === "scene")?.sourceKind).toBe("video");
  });

  it("excludes hidden tracks and clips outside the playhead", () => {
    const hidden = track("hidden", "audio", [clip("hidden-music", "audio")], true);
    const later = track("later", "video", [clip("later-video", "video", 10)]);
    expect(previewAudioOutputsAt([hidden, later], 1)).toEqual([]);
  });

  it("deduplicates a clip id and keeps the strongest active gain", () => {
    const sharedA = clip("shared", "video");
    const sharedB = { ...sharedA };
    const outputs = previewAudioOutputsAt(
      [track("v1", "video", [sharedA]), track("v2", "video", [sharedB])],
      1
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0].clip.id).toBe("shared");
    expect(outputs[0].gain).toBe(1);
  });

  it("applies explicit volume automation gain", () => {
    const audio = {
      ...clip("quiet", "audio"),
      volumeAutomation: {
        points: [
          { t: 0, level: 25 },
          { t: 1, level: 25 },
        ],
      },
    };
    const [output] = previewAudioOutputsAt([track("audio", "audio", [audio])], 2);
    expect(output.gain).toBeCloseTo(0.5);
  });

  it("weights video transition audio by layer opacity", () => {
    const outgoing = {
      ...clip("outgoing", "video", 0, 2),
      transitionOut: { type: "fade" as const, duration: 1 },
    };
    const incoming = clip("incoming", "video", 2, 2);
    const outputs = previewAudioOutputsAt(
      [track("video", "video", [outgoing, incoming])],
      1.5
    );

    expect(outputs).toHaveLength(2);
    expect(outputs.find((o) => o.clip.id === "outgoing")?.gain).toBeCloseTo(0.5);
    expect(outputs.find((o) => o.clip.id === "incoming")?.gain).toBeCloseTo(0.5);
  });
});
