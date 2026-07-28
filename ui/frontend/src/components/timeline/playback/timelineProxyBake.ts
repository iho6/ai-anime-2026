/**
 * Optional baked low-res timeline proxy (Blender “offline” timeline proxy).
 * When present on the manifest, preview can play this strip instead of stacking clips.
 */

import type { TimelineManifest, TimelinePreviewBake } from "../../../lib/api";

export type { TimelinePreviewBake };

export type TimelineManifestWithBake = TimelineManifest;

export function getTimelinePreviewBake(
  manifest: TimelineManifest
): TimelinePreviewBake | null {
  const bake = manifest.previewBake;
  if (!bake?.srcRelPath?.trim()) return null;
  if (!(bake.outPointSec > bake.inPointSec)) return null;
  return bake;
}

/** Whether the current playhead falls inside a usable bake. */
export function bakeCoversPlayhead(
  bake: TimelinePreviewBake,
  playheadSec: number
): boolean {
  return playheadSec >= bake.inPointSec && playheadSec < bake.outPointSec;
}

/**
 * Placeholder for a future server/local bake job.
 * Returns a description of work that would be queued (no network yet).
 */
export function describeTimelineBakeJob(params: {
  timelineKey: string;
  inPointSec: number;
  outPointSec: number;
  fps: number;
  maxWidth?: number;
}): {
  kind: "timeline_preview_bake";
  timelineKey: string;
  inPointSec: number;
  outPointSec: number;
  fps: number;
  maxWidth: number;
} {
  return {
    kind: "timeline_preview_bake",
    timelineKey: params.timelineKey,
    inPointSec: params.inPointSec,
    outPointSec: params.outPointSec,
    fps: Math.max(1, params.fps),
    maxWidth: params.maxWidth ?? 960,
  };
}
