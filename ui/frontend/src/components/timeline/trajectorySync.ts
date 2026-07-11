import type { TimelineClip, TimelineManifest } from "../../lib/api";
import {
  clipEnd,
  clipTransformAtPlayhead,
  defaultImageClipTransform,
  isConnectedPair,
} from "./timelineUtil";
import { trajectoryTransformAt } from "./trajectoryMotion";

const TRAJECTORY_SYNC_CLIP_TYPES = new Set<TimelineClip["type"]>([
  "image",
  "video",
  "geometry",
  "text",
]);

export function clipSupportsTrajectorySync(clip: TimelineClip): boolean {
  return TRAJECTORY_SYNC_CLIP_TYPES.has(clip.type);
}

export function clipHasTrajectory(clip: TimelineClip): boolean {
  return (clip.trajectory?.waypoints?.length ?? 0) >= 2;
}

export function findTrajectorySyncPair(
  manifest: TimelineManifest,
  selectedClipIds: string[]
): { trackId: string; outgoing: TimelineClip; incoming: TimelineClip } | null {
  const uniqueIds = [...new Set(selectedClipIds)];
  if (uniqueIds.length !== 2) return null;

  const resolved: Array<{ trackId: string; clip: TimelineClip }> = [];
  for (const track of manifest.tracks) {
    for (const clip of track.clips) {
      if (uniqueIds.includes(clip.id) && clipSupportsTrajectorySync(clip)) {
        resolved.push({ trackId: track.id, clip });
      }
    }
  }

  if (resolved.length !== 2) return null;
  if (resolved[0].trackId !== resolved[1].trackId) return null;

  const [first, second] = [...resolved].sort((a, b) => a.clip.start - b.clip.start);
  const outgoing = first.clip;
  const incoming = second.clip;

  if (!isConnectedPair(outgoing, incoming)) return null;
  if (!clipHasTrajectory(outgoing) && !clipHasTrajectory(incoming)) return null;

  return { trackId: first.trackId, outgoing, incoming };
}

function applyMotionTailToOutgoing(
  outgoing: TimelineClip,
  motionTailSec: number
): TimelineClip {
  const tailSec = Math.max(0, motionTailSec);
  if (outgoing.trajectory) {
    return {
      ...outgoing,
      trajectory: { ...outgoing.trajectory, motionTailSec: tailSec },
    };
  }
  if (tailSec <= 0) return outgoing;
  const tf = outgoing.transform ?? defaultImageClipTransform();
  return {
    ...outgoing,
    trajectory: {
      motion: "none",
      motionAmount: 50,
      motionTailSec: tailSec,
      waypoints: [
        { t: 0, x: tf.x, y: tf.y, scale: tf.scale },
        { t: 1, x: tf.x, y: tf.y, scale: tf.scale },
      ],
    },
  };
}

function endTargetTransform(
  outgoing: TimelineClip,
  endPlayhead: number,
  motionTailSec: number
): { x: number; y: number; scale: number } {
  if (motionTailSec > 0) {
    const pathEnd = trajectoryTransformAt(outgoing, endPlayhead);
    if (pathEnd) return pathEnd;
    return outgoing.transform ?? defaultImageClipTransform();
  }
  return clipTransformAtPlayhead(outgoing, endPlayhead);
}

function alignIncomingStart(
  incoming: TimelineClip,
  target: { x: number; y: number; scale: number }
): TimelineClip {
  if (clipHasTrajectory(incoming)) {
    const waypoints = incoming.trajectory!.waypoints.map((w) => ({ ...w }));
    let startIdx = 0;
    for (let i = 1; i < waypoints.length; i++) {
      if (waypoints[i].t < waypoints[startIdx].t) startIdx = i;
    }
    waypoints[startIdx] = {
      ...waypoints[startIdx],
      x: target.x,
      y: target.y,
      scale: target.scale,
    };
    return {
      ...incoming,
      trajectory: { ...incoming.trajectory!, waypoints },
    };
  }

  return {
    ...incoming,
    transform: { x: target.x, y: target.y, scale: target.scale },
  };
}

/** Apply motion tail on outgoing and align incoming start pose to outgoing end. */
export function syncMotionPair(
  outgoing: TimelineClip,
  incoming: TimelineClip,
  fps: number,
  motionTailSec: number
): { outgoing: TimelineClip; incoming: TimelineClip } {
  const sampleEps = Math.max(1e-6, 1 / Math.max(1, fps));
  const endPlayhead = clipEnd(outgoing) - sampleEps;
  const tailSec = Math.max(0, motionTailSec);
  const outgoingWithTail = applyMotionTailToOutgoing(outgoing, tailSec);
  const target = endTargetTransform(outgoingWithTail, endPlayhead, tailSec);
  const syncedIncoming = alignIncomingStart(incoming, target);
  return { outgoing: outgoingWithTail, incoming: syncedIncoming };
}

/** Align incoming clip start pose to outgoing clip effective end (path + motion). */
export function syncMotionIncomingToOutgoing(
  outgoing: TimelineClip,
  incoming: TimelineClip,
  fps: number
): TimelineClip {
  return syncMotionPair(outgoing, incoming, fps, 0).incoming;
}
