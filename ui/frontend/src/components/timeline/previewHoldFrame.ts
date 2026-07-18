import type { TimelineClip, TimelineFrameEdit } from "../../lib/api";

/** 1 = every frame (24fps grid); 2 = hold every other frame (12fps look). */
export type PreviewHoldStep = 1 | 2;

export function normalizePreviewHoldStep(step: unknown): PreviewHoldStep {
  return step === 2 ? 2 : 1;
}

/** Preview hold from clip frame-edit settings (sequence-set 12/24 control). */
export function clipPreviewHoldStep(
  clip: Pick<TimelineClip, "frameEdit"> | null | undefined
): PreviewHoldStep {
  return normalizePreviewHoldStep(clip?.frameEdit?.timelineViewStep);
}

export function holdQuantizeFrameIndex(frameIdx: number, step: PreviewHoldStep): number {
  const st = step >= 2 ? 2 : 1;
  if (st === 1) return Math.max(0, Math.trunc(frameIdx));
  return Math.floor(Math.max(0, Math.trunc(frameIdx)) / st) * st;
}

/**
 * Snap source time to the start of the held frame window.
 * Timeline duration unchanged — odd frames are held visually.
 */
export function heldSourceTimeSec(
  clip: Pick<TimelineClip, "inPoint" | "outPoint">,
  sourceTimeSec: number,
  fps: number,
  holdStep: PreviewHoldStep = 1
): number {
  const rate = Math.max(1, fps);
  const inP = clip.inPoint ?? 0;
  let t = Math.max(sourceTimeSec, inP);
  if ((clip.outPoint ?? 0) > 0) t = Math.min(t, clip.outPoint!);
  if (holdStep < 2) return t;
  const rawIdx = Math.round((t - inP) * rate);
  const heldIdx = holdQuantizeFrameIndex(rawIdx, holdStep);
  return inP + heldIdx / rate;
}

export function withTimelineViewStep(
  frameEdit: TimelineFrameEdit | undefined,
  step: PreviewHoldStep
): TimelineFrameEdit {
  return {
    framesDirRel: frameEdit?.framesDirRel ?? "",
    ...(frameEdit?.extractInPointSec != null
      ? { extractInPointSec: frameEdit.extractInPointSec }
      : {}),
    ...(frameEdit?.extractFps != null ? { extractFps: frameEdit.extractFps } : {}),
    ...(frameEdit?.mp4Aligned ? { mp4Aligned: true } : {}),
    timelineViewStep: step,
  };
}
