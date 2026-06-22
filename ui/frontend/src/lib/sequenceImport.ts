import type { FrameSequenceStripSlot, SequenceManifest } from "./api";

function stripSlotVisibleForExport(slot: FrameSequenceStripSlot): boolean {
  if (slot.kind !== "image") return false;
  if (slot.hidden === true) return false;
  const rel = (slot.relPath ?? "").trim().replace(/\\/g, "/").replace(/^\//, "");
  return Boolean(rel);
}

function timelineHasExportableFrames(manifest: SequenceManifest): boolean {
  for (const fr of manifest.frames ?? []) {
    if (fr.hidden === true) continue;
    const rel = (fr.relPath ?? "").trim().replace(/\\/g, "/").replace(/^\//, "");
    if (rel) return true;
  }
  return false;
}

function firstExportableGalleryFrameSequenceId(
  manifest: SequenceManifest
): string | undefined {
  for (const item of manifest.gallery ?? []) {
    const strip = item.frameSequence?.strip ?? [];
    if (strip.some(stripSlotVisibleForExport)) {
      return item.id;
    }
  }
  return undefined;
}

/** Gallery item to use when importing a sequence whose timeline grid has no frames. */
export function resolveSequenceImportGalleryItemId(
  manifest: SequenceManifest
): string | undefined {
  if (timelineHasExportableFrames(manifest)) return undefined;
  return firstExportableGalleryFrameSequenceId(manifest);
}
