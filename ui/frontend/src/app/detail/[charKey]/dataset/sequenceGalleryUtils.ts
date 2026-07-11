import type {
  FrameSequenceStripSlot,
  SequenceCrop,
  SequenceManifest,
} from "../../../../lib/api";

/** Strip slot fields needed to duplicate assets onto the timeline (visible images only). */
export type FrameSequenceVisibleSlot = {
  relPath: string;
  crop?: SequenceCrop;
};

/** True when this strip slot should become a timeline cell on drop (not empty / strip-hidden). */
export function frameSequenceStripSlotHasTimelineImage(slot: FrameSequenceStripSlot): boolean {
  return slot.kind === "image" && Boolean(slot.relPath?.trim()) && !slot.hidden;
}

/**
 * Ordered strip slots that produce a timeline image cell on drop (same predicate as
 * {@link frameSequenceStripSlotHasTimelineImage}). This is not “columns consumed”; full strip
 * length reserves one timeline column per index — gaps use missing `frames` rows.
 */
export function visibleFrameSequenceStripSlots(
  strip: FrameSequenceStripSlot[]
): FrameSequenceVisibleSlot[] {
  const out: FrameSequenceVisibleSlot[] = [];
  for (const slot of strip) {
    if (!frameSequenceStripSlotHasTimelineImage(slot)) continue;
    out.push({ relPath: slot.relPath!, crop: slot.crop });
  }
  return out;
}

export type TimelineFrameCell = {
  cellId: string;
  relPath: string;
  crop?: SequenceCrop;
  sequenceGroupId?: string;
};

/**
 * Before placing `n` consecutive frames at `anchor`, drop the cell at `anchor` and shift every
 * index strictly greater than `anchor` right by `n - 1` (injective reindexing).
 */
export function shiftTimelineMapForFrameSequenceDrop<T extends TimelineFrameCell>(
  map: Map<number, T>,
  anchor: number,
  n: number
): Map<number, T> {
  if (n <= 0) return new Map(map);
  const next = new Map<number, T>();
  for (const [i, v] of map) {
    if (i < anchor) next.set(i, v);
    else if (i === anchor) continue;
    else next.set(i + (n - 1), v);
  }
  return next;
}

/** Custom MIME for HTML5 drag from dataset builder tiles to sequence buttons. */
export const SEQUENCE_BUILDER_DRAG_MIME = "application/x-anime2026-seq-source";

/** @dnd-kit droppable on frame-sequence modal backdrop: add strip image to sequence gallery. */
export const FS_MODAL_GALLERY_BACKDROP_DROP_ID = "seq-fs-add-to-gallery-backdrop";

/** Per-track droppable prefix when dragging a frame-sequence strip slot onto the timeline. */
export const TIMELINE_STRIP_FRAME_DROP_PREFIX = "timeline-track-drop:";

/** Matches SequenceEditor strip length: min cells, max occupied index + tail padding. */
export function computeSequenceTimelineSpan(manifest: SequenceManifest): number {
  const MIN_FRAMES = 48;
  const TAIL_PAD = 24;
  let maxIdx = -1;
  for (const fr of manifest.frames) maxIdx = Math.max(maxIdx, fr.index);
  return Math.max(MIN_FRAMES, maxIdx + 1 + TAIL_PAD);
}

/**
 * Logical timeline column indices shown in the sequence editor grid: every `step` index
 * (`timelineViewStep` 2 → step 2, else step 1) from `0` to `frameCount - 1`.
 */
export function visibleTimelineColumnIndices(
  manifest: SequenceManifest,
  frameCount: number
): number[] {
  const step = manifest.timelineViewStep === 2 ? 2 : 1;
  const out: number[] = [];
  for (let i = 0; i < frameCount; i += step) out.push(i);
  return out;
}

export function newGalleryId(): string {
  return `g_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
