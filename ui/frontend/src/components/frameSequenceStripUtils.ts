import type {
  FrameSequencePayload,
  FrameSequenceStripSlot,
  SequenceCrop,
  TimelineFrameEdit,
} from "../lib/api";
import { cloneCrop } from "../lib/sequenceCrop";

/** Mirror backend ``_frame_sequence_strip_slot_visible_for_export``. */
export function stripSlotVisibleForExport(slot: FrameSequenceStripSlot | undefined): boolean {
  return (
    slot?.kind === "image" &&
    slot.hidden !== true &&
    !!slot.relPath?.trim()
  );
}

export function frameSequenceHasExportableFrames(payload: FrameSequencePayload): boolean {
  return payload.strip.some(stripSlotVisibleForExport);
}

function cropEqual(a?: SequenceCrop, b?: SequenceCrop): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.translateXFrac === b.translateXFrac &&
    a.translateYFrac === b.translateYFrac &&
    a.scale === b.scale
  );
}

function stripSlotEqual(a: FrameSequenceStripSlot, b: FrameSequenceStripSlot): boolean {
  return (
    a.kind === b.kind &&
    (a.relPath ?? "") === (b.relPath ?? "") &&
    !!a.hidden === !!b.hidden &&
    !!a.trimHidden === !!b.trimHidden &&
    cropEqual(a.crop, b.crop) &&
    (a.sourceKeypointRelPath ?? "") === (b.sourceKeypointRelPath ?? "") &&
    JSON.stringify(a.placedFigure ?? null) === JSON.stringify(b.placedFigure ?? null)
  );
}

export function frameSequencePayloadEqual(
  a: FrameSequencePayload,
  b: FrameSequencePayload
): boolean {
  if (a.sequenceGroupId !== b.sequenceGroupId) return false;
  if (a.strip.length !== b.strip.length) return false;
  return a.strip.every((slot, i) => stripSlotEqual(slot, b.strip[i]!));
}

function applyTrimHidden(slot: FrameSequenceStripSlot, outside: boolean): FrameSequenceStripSlot {
  if (outside) {
    if (slot.hidden && !slot.trimHidden) return slot;
    return slot.hidden && slot.trimHidden ? slot : { ...slot, hidden: true, trimHidden: true };
  }
  if (!slot.trimHidden) return slot;
  const { hidden: _hidden, trimHidden: _trimHidden, ...rest } = slot;
  return rest;
}

/** Auto-hide strip frames outside clip inPoint/outPoint (timeline video edit). */
export function syncTrimHiddenToFrameSequence(
  frameSequence: FrameSequencePayload,
  clip: { inPoint: number; outPoint: number },
  frameEdit: TimelineFrameEdit | undefined,
  fps: number
): FrameSequencePayload {
  const inPoint = clip.inPoint ?? 0;
  const outPoint = clip.outPoint ?? 0;
  const rate = Math.max(1, frameEdit?.extractFps ?? fps);
  const mp4Aligned = frameEdit?.mp4Aligned === true;
  let mp4Frame = 0;

  const nextStrip = frameSequence.strip.map((slot, stripIndex) => {
    if (slot.kind !== "image") return slot;
    if (mp4Aligned) {
      // Manual-hidden frames were omitted from the encoded MP4. Auto-hidden
      // frames still own an MP4 frame and must participate in future trim sync.
      if (!slot.relPath?.trim() || (slot.hidden && !slot.trimHidden)) return slot;
      const sourceSec = mp4Frame / rate;
      mp4Frame += 1;
      const outside = sourceSec < inPoint || sourceSec >= outPoint;
      return applyTrimHidden(slot, outside);
    }
    const sourceSec = (frameEdit?.extractInPointSec ?? 0) + stripIndex / rate;
    const outside = sourceSec < inPoint || sourceSec >= outPoint;
    return applyTrimHidden(slot, outside);
  });

  return { ...frameSequence, strip: nextStrip, hidden: [] };
}

export function frameSequenceStripSlotHasImage(
  slot: FrameSequenceStripSlot | undefined
): slot is FrameSequenceStripSlot & { kind: "image"; relPath: string } {
  return slot?.kind === "image" && !!slot.relPath?.trim();
}

export function canGenerateFlfFromStripSelection(
  strip: FrameSequenceStripSlot[],
  selectedIndices: Set<number>
): { ok: true; start: number; end: number } | { ok: false } {
  const occupied = [...selectedIndices]
    .filter((i) => frameSequenceStripSlotHasImage(strip[i]))
    .sort((a, b) => a - b);
  if (occupied.length < 2) return { ok: false };
  const start = occupied[0]!;
  const end = occupied[occupied.length - 1]!;
  for (let i = start + 1; i < end; i++) {
    const s = strip[i];
    if (frameSequenceStripSlotHasImage(s) && !s.hidden) return { ok: false };
  }
  return { ok: true, start, end };
}

export function canGenerateI2vFromStripSelection(
  strip: FrameSequenceStripSlot[],
  selectedIndices: Set<number>
): { ok: true; index: number; relPath: string } | { ok: false } {
  const occupied = [...selectedIndices].filter((i) => frameSequenceStripSlotHasImage(strip[i]));
  if (occupied.length !== 1) return { ok: false };
  const ix = occupied[0]!;
  const slot = strip[ix]!;
  if (slot.kind !== "image" || !slot.relPath?.trim()) return { ok: false };
  return { ok: true, index: ix, relPath: slot.relPath.trim() };
}

export function relPathsFromStripSelection(
  strip: FrameSequenceStripSlot[],
  selectedIndices: Set<number>
): string[] {
  return [...selectedIndices]
    .sort((a, b) => a - b)
    .map((i) => strip[i])
    .filter(frameSequenceStripSlotHasImage)
    .map((s) => s.relPath.trim());
}

/** Reverse slot content at occupied indices in the selection (indices stay fixed). */
export function reverseStripSelection(
  strip: FrameSequenceStripSlot[],
  selectedIndices: Set<number>
): FrameSequenceStripSlot[] {
  const indices = [...selectedIndices]
    .filter((i) => i >= 0 && i < strip.length && frameSequenceStripSlotHasImage(strip[i]))
    .sort((a, b) => a - b);
  if (indices.length < 2) return strip;
  const slots = indices.map((i) => strip[i]!);
  const reversed = [...slots].reverse();
  const next = [...strip];
  indices.forEach((i, j) => {
    next[i] = reversed[j]!;
  });
  return next;
}

export function occupiedStripSelectionCount(
  strip: FrameSequenceStripSlot[],
  selectedIndices: Set<number>
): number {
  return [...selectedIndices].filter(
    (i) => i >= 0 && i < strip.length && frameSequenceStripSlotHasImage(strip[i])
  ).length;
}

export function spliceStripFrames(
  strip: FrameSequenceStripSlot[],
  startIndex: number,
  removeCount: number,
  insert: FrameSequenceStripSlot[]
): FrameSequenceStripSlot[] {
  return [...strip.slice(0, startIndex), ...insert, ...strip.slice(startIndex + removeCount)];
}

export function outputDirFromRelPath(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/");
  const ix = norm.lastIndexOf("/");
  return ix >= 0 ? norm.slice(0, ix) : norm;
}

/** Pad shorter strips with empty slots so every layer shares the same column count. */
export function alignFrameStripsToLength(
  strips: FrameSequenceStripSlot[][]
): FrameSequenceStripSlot[][] {
  const maxLen = Math.max(0, ...strips.map((s) => s.length));
  return strips.map((strip) => {
    if (strip.length >= maxLen) return strip;
    const padded = [...strip];
    while (padded.length < maxLen) padded.push({ kind: "empty" });
    return padded;
  });
}

export function buildFrameSequencePayload(
  sequenceGroupId: string,
  strip: FrameSequenceStripSlot[]
): FrameSequencePayload {
  return {
    sequenceGroupId,
    strip: strip.map((s) => ({
      ...s,
      ...(s.kind === "image" ? { relPath: s.relPath || "", crop: cloneCrop(s.crop) } : {}),
    })),
    hidden: [],
  };
}

export function payloadFromAlignedStrips(
  layers: Array<{ clipId: string; sequenceGroupId: string; strip: FrameSequenceStripSlot[] }>
): Record<string, FrameSequencePayload> {
  const out: Record<string, FrameSequencePayload> = {};
  for (const layer of layers) {
    out[layer.clipId] = buildFrameSequencePayload(layer.sequenceGroupId, layer.strip);
  }
  return out;
}
