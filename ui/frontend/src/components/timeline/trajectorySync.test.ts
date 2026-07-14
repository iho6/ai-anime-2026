import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineManifest, TimelineTrack } from "../../lib/api";
import { clipTransformAtPlayhead } from "./timelineUtil";
import { motionOffsetAt, motionTailEnvelope, trajectoryTransformAt } from "./trajectoryMotion";
import {
  findTrajectorySyncPair,
  syncMotionIncomingToOutgoing,
  syncMotionPair,
} from "./trajectorySync";

function imageClip(
  id: string,
  start: number,
  opts?: Partial<TimelineClip>
): TimelineClip {
  return {
    id,
    type: "image",
    srcRelPath: `clips/${id}.png`,
    start,
    inPoint: 0,
    outPoint: 2,
    speed: 1,
    duration: 2,
    transform: { x: 0, y: 0, scale: 1 },
    ...opts,
  };
}

function manifest(tracks: TimelineTrack[]): TimelineManifest {
  return { version: 2, fps: 24, previewAspect: "16:9", tracks };
}

function track(id: string, clips: TimelineClip[]): TimelineTrack {
  return { id, name: id, kind: "video", clips };
}

describe("findTrajectorySyncPair", () => {
  it("accepts connected same-track pair when one clip has a trajectory", () => {
    const outgoing = imageClip("clip_a", 0, {
      trajectory: {
        motion: "none",
        motionAmount: 50,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0.1, y: 0, scale: 1 },
        ],
      },
    });
    const incoming = imageClip("clip_b", 2);
    const m = manifest([track("trk_1", [outgoing, incoming])]);
    const pair = findTrajectorySyncPair(m, ["clip_a", "clip_b"]);
    expect(pair).not.toBeNull();
    expect(pair!.trackId).toBe("trk_1");
    expect(pair!.outgoing.id).toBe("clip_a");
    expect(pair!.incoming.id).toBe("clip_b");
  });

  it("rejects clips on different tracks", () => {
    const a = imageClip("clip_a", 0, {
      trajectory: {
        motion: "none",
        motionAmount: 50,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0, y: 0, scale: 1 },
        ],
      },
    });
    const b = imageClip("clip_b", 2);
    const m = manifest([track("trk_a", [a]), track("trk_b", [b])]);
    expect(findTrajectorySyncPair(m, ["clip_a", "clip_b"])).toBeNull();
  });

  it("rejects gapped clips on the same track", () => {
    const a = imageClip("clip_a", 0, {
      trajectory: {
        motion: "none",
        motionAmount: 50,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0, y: 0, scale: 1 },
        ],
      },
    });
    const b = imageClip("clip_b", 5);
    const m = manifest([track("trk_1", [a, b])]);
    expect(findTrajectorySyncPair(m, ["clip_a", "clip_b"])).toBeNull();
  });

  it("rejects when neither clip has a trajectory", () => {
    const a = imageClip("clip_a", 0);
    const b = imageClip("clip_b", 2);
    const m = manifest([track("trk_1", [a, b])]);
    expect(findTrajectorySyncPair(m, ["clip_a", "clip_b"])).toBeNull();
  });
});

describe("syncMotionIncomingToOutgoing", () => {
  it("sets static incoming transform to outgoing effective end with motion", () => {
    const outgoing = imageClip("clip_a", 0, {
      duration: 2,
      trajectory: {
        motion: "pulse",
        motionAmount: 100,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0, y: 0, scale: 1 },
        ],
      },
    });
    const incoming = imageClip("clip_b", 2, {
      transform: { x: 0.5, y: -0.2, scale: 0.8 },
    });
    const endPose = clipTransformAtPlayhead(outgoing, 2 - 1 / 24);
    expect(endPose.scale).not.toBe(1);

    const synced = syncMotionIncomingToOutgoing(outgoing, incoming, 24);
    expect(synced.transform).toEqual({
      x: endPose.x,
      y: endPose.y,
      scale: endPose.scale,
    });
    expect(clipTransformAtPlayhead(synced, synced.start)).toMatchObject({
      x: endPose.x,
      y: endPose.y,
      scale: endPose.scale,
    });
  });

  it("updates incoming trajectory start waypoint to match outgoing end", () => {
    const outgoing = imageClip("clip_a", 0, {
      duration: 2,
      trajectory: {
        motion: "sway",
        motionAmount: 100,
        waypoints: [
          { t: 0, x: -0.2, y: 0, scale: 1 },
          { t: 1, x: 0.2, y: 0, scale: 1 },
        ],
      },
    });
    const incoming = imageClip("clip_b", 2, {
      trajectory: {
        motion: "none",
        motionAmount: 50,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0.3, y: 0.1, scale: 1.1 },
        ],
      },
    });
    const endPose = clipTransformAtPlayhead(outgoing, 2 - 1 / 24);
    const synced = syncMotionIncomingToOutgoing(outgoing, incoming, 24);
    const startWp = synced.trajectory!.waypoints.find((w) => w.t === 0)!;
    expect(startWp.x).toBeCloseTo(endPose.x, 5);
    expect(startWp.y).toBeCloseTo(endPose.y, 5);
    expect(startWp.scale).toBeCloseTo(endPose.scale, 5);
    expect(synced.transform).toEqual({
      x: endPose.x,
      y: endPose.y,
      scale: endPose.scale,
    });
    expect(clipTransformAtPlayhead(synced, synced.start).x).toBeCloseTo(
      endPose.x,
      5
    );
  });

  it("syncs trajectory incoming to static outgoing transform", () => {
    const outgoing = imageClip("clip_a", 0, {
      transform: { x: 0.15, y: -0.05, scale: 0.9 },
    });
    const incoming = imageClip("clip_b", 2, {
      trajectory: {
        motion: "none",
        motionAmount: 50,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0.4, y: 0, scale: 1 },
        ],
      },
    });
    const synced = syncMotionIncomingToOutgoing(outgoing, incoming, 24);
    const startWp = synced.trajectory!.waypoints.find((w) => w.t === 0)!;
    expect(startWp.x).toBe(0.15);
    expect(startWp.y).toBe(-0.05);
    expect(startWp.scale).toBe(0.9);
  });
});

describe("motionTailEnvelope", () => {
  it("returns 1 outside the tail zone and 0 at clip end", () => {
    const clip = imageClip("clip_a", 0, {
      duration: 4,
      trajectory: {
        motion: "pulse",
        motionAmount: 100,
        motionTailSec: 1,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0, y: 0, scale: 1 },
        ],
      },
    });
    expect(motionTailEnvelope(clip, 2)).toBe(1);
    expect(motionTailEnvelope(clip, 4)).toBe(0);
    expect(motionTailEnvelope(clip, 3.5)).toBeGreaterThan(0);
    expect(motionTailEnvelope(clip, 3.5)).toBeLessThan(1);
  });

  it("scales motion offset down near clip end", () => {
    const clip = imageClip("clip_a", 0, {
      duration: 2,
      trajectory: {
        motion: "pulse",
        motionAmount: 100,
        motionTailSec: 1,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0, y: 0, scale: 1 },
        ],
      },
    });
    const mid = motionOffsetAt(clip, 0.5);
    const nearEnd = motionOffsetAt(clip, 1.95);
    expect(Math.abs(mid.dScale)).toBeGreaterThan(Math.abs(nearEnd.dScale));
    expect(Math.abs(nearEnd.dScale)).toBeLessThan(0.001);
  });
});

describe("syncMotionPair", () => {
  it("stores motionTailSec on outgoing and aligns incoming to path end when tail > 0", () => {
    const outgoing = imageClip("clip_a", 0, {
      duration: 2,
      trajectory: {
        motion: "pulse",
        motionAmount: 100,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0.2, y: 0.1, scale: 1 },
        ],
      },
    });
    const incoming = imageClip("clip_b", 2, {
      transform: { x: 0.5, y: -0.2, scale: 0.8 },
    });
    const motionEnd = clipTransformAtPlayhead(outgoing, 2 - 1 / 24);
    expect(motionEnd.scale).not.toBe(1);
    const pathEnd = trajectoryTransformAt(outgoing, 2 - 1 / 24)!;

    const synced = syncMotionPair(outgoing, incoming, 24, 0.5);
    expect(synced.outgoing.trajectory?.motionTailSec).toBe(0.5);
    expect(synced.incoming.transform).toEqual(pathEnd);
    expect(synced.incoming.transform!.scale).not.toBeCloseTo(motionEnd.scale, 3);
  });

  it("with tail 0 matches effective end including motion", () => {
    const outgoing = imageClip("clip_a", 0, {
      duration: 2,
      trajectory: {
        motion: "pulse",
        motionAmount: 100,
        waypoints: [
          { t: 0, x: 0, y: 0, scale: 1 },
          { t: 1, x: 0, y: 0, scale: 1 },
        ],
      },
    });
    const incoming = imageClip("clip_b", 2);
    const endPose = clipTransformAtPlayhead(outgoing, 2 - 1 / 24);
    const synced = syncMotionPair(outgoing, incoming, 24, 0);
    expect(synced.outgoing.trajectory?.motionTailSec).toBe(0);
    expect(synced.incoming.transform).toEqual({
      x: endPose.x,
      y: endPose.y,
      scale: endPose.scale,
    });
  });

  it("syncs coordinates from video outgoing to static image incoming", () => {
    const outgoing: TimelineClip = {
      id: "clip_v",
      type: "video",
      srcRelPath: "clips/v.mp4",
      start: 0,
      inPoint: 0,
      outPoint: 2,
      speed: 1,
      duration: 2,
      srcDuration: 2,
      transform: { x: 0.22, y: -0.18, scale: 1.35 },
    };
    const incoming = imageClip("clip_i", 2, {
      transform: { x: 0, y: 0, scale: 1 },
    });
    const synced = syncMotionPair(outgoing, incoming, 24, 0);
    expect(synced.incoming.type).toBe("image");
    expect(synced.incoming.transform).toEqual({
      x: 0.22,
      y: -0.18,
      scale: 1.35,
    });
  });

  it("syncs coordinates from image outgoing to video incoming (transform + traj start)", () => {
    const outgoing = imageClip("clip_i", 0, {
      transform: { x: -0.1, y: 0.25, scale: 0.85 },
    });
    const incoming: TimelineClip = {
      id: "clip_v",
      type: "video",
      srcRelPath: "clips/v.mp4",
      start: 2,
      inPoint: 0,
      outPoint: 2,
      speed: 1,
      duration: 2,
      srcDuration: 2,
      transform: { x: 0, y: 0, scale: 1 },
      trajectory: {
        motion: "none",
        motionAmount: 50,
        waypoints: [
          { t: 0, x: 0.4, y: 0.4, scale: 2 },
          { t: 1, x: 0.4, y: 0.4, scale: 2 },
        ],
      },
    };
    const synced = syncMotionPair(outgoing, incoming, 24, 0);
    expect(synced.incoming.transform).toEqual({
      x: -0.1,
      y: 0.25,
      scale: 0.85,
    });
    const startWp = synced.incoming.trajectory!.waypoints.find((w) => w.t === 0)!;
    expect(startWp.x).toBe(-0.1);
    expect(startWp.y).toBe(0.25);
    expect(startWp.scale).toBe(0.85);
  });
});
