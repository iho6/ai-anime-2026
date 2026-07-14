import type { FrameSequencePayload, FrameSequenceStripSlot } from "../../lib/api";

export function cloneFrameSequencePayload(payload: FrameSequencePayload): FrameSequencePayload {
  return {
    ...payload,
    strip: payload.strip.map((slot) => ({
      ...slot,
      crop: slot.crop ? { ...slot.crop } : undefined,
    })),
    hidden: payload.hidden.map((item) => ({
      ...item,
      crop: item.crop ? { ...item.crop } : undefined,
    })),
  };
}

export function mutateTimelineFrameSlots(
  payload: FrameSequencePayload,
  selectedIndices: ReadonlySet<number>,
  mutation: "delete" | "hide" | "unhide"
): FrameSequencePayload {
  const strip = payload.strip.map((slot, index): FrameSequenceStripSlot => {
    if (!selectedIndices.has(index)) return slot;
    if (mutation === "delete") return { kind: "empty" };
    if (slot.kind !== "image") return slot;
    if (mutation === "hide") {
      const { trimHidden: _trimHidden, ...rest } = slot;
      return { ...rest, hidden: true };
    }
    const { hidden: _hidden, trimHidden: _trimHidden, ...rest } = slot;
    return rest;
  });
  return { ...payload, strip };
}

export type TimelineFrameMove = {
  payload: FrameSequencePayload;
  selectedIndices: Set<number>;
};

export function moveTimelineFrames(
  payload: FrameSequencePayload,
  fromIndex: number,
  toIndex: number,
  selectedIndices: ReadonlySet<number>
): TimelineFrameMove | null {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= payload.strip.length ||
    toIndex < 0
  ) {
    return null;
  }

  const selectedOccupied = [...selectedIndices]
    .filter((index) => payload.strip[index]?.kind === "image")
    .sort((a, b) => a - b);
  if (selectedOccupied.length > 1 && selectedOccupied.includes(fromIndex)) {
    const delta = toIndex - fromIndex;
    const sourceIndices = new Set(selectedOccupied);
    const targets = selectedOccupied.map((index) => index + delta);
    if (
      targets.some(
        (index) =>
          index < 0 ||
          (payload.strip[index]?.kind === "image" && !sourceIndices.has(index))
      )
    ) {
      return null;
    }
    const strip = [...payload.strip];
    const moving = selectedOccupied.map((index) => strip[index]!);
    for (const index of selectedOccupied) strip[index] = { kind: "empty" };
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      while (strip.length <= target) strip.push({ kind: "empty" });
      strip[target] = moving[index]!;
    }
    return { payload: { ...payload, strip }, selectedIndices: new Set(targets) };
  }

  const strip = [...payload.strip];
  const moving = strip[fromIndex]!;
  const target = strip[toIndex] ?? { kind: "empty" as const };
  strip[fromIndex] = target;
  while (strip.length <= toIndex) strip.push({ kind: "empty" });
  strip[toIndex] = moving;
  return { payload: { ...payload, strip }, selectedIndices: new Set([toIndex]) };
}

export async function placeGallerySequence(
  target: FrameSequencePayload,
  source: FrameSequencePayload,
  toIndex: number,
  duplicateAsset?: (sourceRelPath: string) => Promise<string>
): Promise<{ payload: FrameSequencePayload; selectedIndices: Set<number> }> {
  const sourceClone = cloneFrameSequencePayload(source);
  const inserted = duplicateAsset
    ? await Promise.all(
        sourceClone.strip.map(async (slot) => {
          if (slot.kind !== "image" || !slot.relPath?.trim()) return slot;
          return { ...slot, relPath: await duplicateAsset(slot.relPath) };
        })
      )
    : sourceClone.strip;
  const strip = [...target.strip];
  while (strip.length < toIndex) strip.push({ kind: "empty" });
  strip.splice(toIndex, 1, ...inserted);
  return {
    payload: { ...target, strip },
    selectedIndices: new Set(inserted.map((_, index) => toIndex + index)),
  };
}
