import type { FrameSequenceStripSlot, TimelineClip } from "../../lib/api";
import { stripSlotVisibleForExport } from "../frameSequenceStripUtils";

export function stripFrameIndexAtSourceTime(
  clip: Pick<TimelineClip, "inPoint" | "outPoint">,
  sourceTimeSec: number,
  fps: number,
  stripLength: number
): number {
  if (stripLength < 1) return 0;
  let t = Math.max(sourceTimeSec, clip.inPoint);
  if (clip.outPoint > 0) t = Math.min(t, clip.outPoint);
  const index = Math.round((t - clip.inPoint) * Math.max(1, fps));
  return Math.max(0, Math.min(index, stripLength - 1));
}

/** Resolve the last visible strip image at or before the requested index. */
export function resolveStripSlotRelPath(
  strip: FrameSequenceStripSlot[],
  index: number
): string | null {
  const target = Math.max(0, Math.min(Math.trunc(index), strip.length - 1));
  for (let i = target; i >= 0; i--) {
    const slot = strip[i];
    if (stripSlotVisibleForExport(slot)) return slot!.relPath!.trim();
  }
  return null;
}

export function timelineStripPreviewRelPath(
  clip: TimelineClip,
  sourceTimeSec: number,
  fps: number
): string | null {
  const strip = clip.frameSequence?.strip;
  if (!strip?.length) return null;
  const index = stripFrameIndexAtSourceTime(
    clip,
    sourceTimeSec,
    fps,
    strip.length
  );
  return resolveStripSlotRelPath(strip, index);
}

/**
 * Opaque RGB frameSequence strips must not override a real alpha matte.
 * When alphaRelPath is set, prefer video+alpha decode for true transparency.
 */
export function clipPrefersAlphaDecodeOverStrip(clip: TimelineClip): boolean {
  return Boolean(clip.alphaRelPath?.trim());
}

/** Strip path for preview painting — null when alpha decode should win. */
export function timelineEffectiveStripPreviewRelPath(
  clip: TimelineClip,
  sourceTimeSec: number,
  fps: number
): string | null {
  if (clipPrefersAlphaDecodeOverStrip(clip)) return null;
  return timelineStripPreviewRelPath(clip, sourceTimeSec, fps);
}
