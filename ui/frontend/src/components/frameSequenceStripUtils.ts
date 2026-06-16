import type { FrameSequencePayload, FrameSequenceStripSlot } from "../lib/api";
import { cloneCrop } from "../lib/sequenceCrop";

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
    strip: strip.map((s) =>
      s.kind === "image"
        ? {
            kind: "image",
            relPath: s.relPath || "",
            crop: cloneCrop(s.crop),
            ...(s.hidden ? { hidden: true } : {}),
          }
        : s.hidden
          ? { kind: "empty", hidden: true }
          : { kind: "empty" }
    ),
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
