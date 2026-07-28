/**
 * Pure scene resolve at an integer timeline frame (industry resolveTimeline pattern).
 * Preview and export should both consume this.
 */

import type { TimelineClip, TimelineManifest, TimelineTrack } from "../../../lib/api";
import {
  activeLayersAt,
  clipEnd,
  sourceTimeAtWithTransition,
  type ActiveLayer,
} from "../timelineUtil";
import { clipPreviewHoldStep, heldSourceTimeSec } from "../previewHoldFrame";

export type SceneLayer = {
  clip: TimelineClip;
  trackId: string;
  trackIndex: number;
  opacity: number;
  role: ActiveLayer["role"];
  progress: number;
  preload?: boolean;
  clipPath?: string;
  slideOffsetX?: number;
  slideOffsetY?: number;
  /** Source media time (seconds), hold-quantized for preview. */
  sourceTimeSec: number;
};

export type ResolvedScene = {
  frame: number;
  timeSec: number;
  fps: number;
  layers: SceneLayer[];
};

function videoTracks(manifest: TimelineManifest): TimelineTrack[] {
  return manifest.tracks.filter((t) => t.kind === "video" || t.kind === undefined);
}

/** Resolve visible scene at integer timeline frame. */
export function resolveScene(manifest: TimelineManifest, frame: number): ResolvedScene {
  const fps = Math.max(1, Math.round(manifest.fps) || 24);
  const timeSec = Math.max(0, frame) / fps;
  const layers: SceneLayer[] = [];
  const tracks = videoTracks(manifest);

  tracks.forEach((track, trackIndex) => {
    for (const layer of activeLayersAt(track, timeSec)) {
      let sourceTimeSec = sourceTimeAtWithTransition(layer.clip, timeSec, track);
      if (layer.clip.type === "video") {
        const hold = clipPreviewHoldStep(layer.clip);
        sourceTimeSec = heldSourceTimeSec(layer.clip, sourceTimeSec, fps, hold);
      }
      layers.push({
        clip: layer.clip,
        trackId: track.id,
        trackIndex,
        opacity: layer.opacity,
        role: layer.role,
        progress: layer.progress,
        preload: layer.preload,
        clipPath: layer.clipPath,
        slideOffsetX: layer.slideOffsetX,
        slideOffsetY: layer.slideOffsetY,
        sourceTimeSec,
      });
    }
  });

  return { frame: Math.max(0, frame), timeSec, fps, layers };
}

/** Stable hash for cache invalidation when scene contents change. */
export function sceneContentHash(scene: ResolvedScene): string {
  const parts = scene.layers.map((l) => {
    const c = l.clip;
    return [
      c.id,
      c.srcRelPath ?? "",
      c.proxyRelPath ?? "",
      c.alphaRelPath ?? "",
      c.proxyAlphaRelPath ?? "",
      String(c.speed ?? 1),
      String(c.inPoint ?? 0),
      String(c.outPoint ?? 0),
      String(l.opacity),
      String(Math.round(l.sourceTimeSec * 1000)),
      c.coloring ? JSON.stringify(c.coloring) : "",
      c.frameSequence?.sequenceGroupId ?? "",
    ].join(":");
  });
  return `${scene.frame}|${scene.fps}|${parts.join(";")}`;
}

/** Count stacked non-preload video layers with alpha (for quality policy). */
export function countActiveAlphaLayers(scene: ResolvedScene): number {
  let n = 0;
  for (const l of scene.layers) {
    if (l.preload) continue;
    if (l.opacity < 0.01) continue;
    if (l.clip.type === "video" && l.clip.alphaRelPath?.trim()) n += 1;
  }
  return n;
}

export function sceneClipIds(scene: ResolvedScene): string[] {
  return scene.layers.filter((l) => !l.preload).map((l) => l.clip.id);
}

export function longestClipEnd(manifest: TimelineManifest): number {
  let max = 0;
  for (const t of manifest.tracks) {
    for (const c of t.clips) max = Math.max(max, clipEnd(c));
  }
  return max;
}
