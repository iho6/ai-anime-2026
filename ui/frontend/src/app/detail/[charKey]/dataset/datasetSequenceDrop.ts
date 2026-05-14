import type React from "react";
import {
  apiSequenceDuplicateAsset,
  apiSequenceGet,
  apiSequencePut,
} from "../../../../lib/api";
import { defaultSequenceCrop } from "../../../../lib/sequenceCrop";
import { newGalleryId, SEQUENCE_BUILDER_DRAG_MIME } from "./sequenceGalleryUtils";

export function parseSequenceBuilderDrop(e: React.DragEvent): string | null {
  try {
    const raw = e.dataTransfer.getData(SEQUENCE_BUILDER_DRAG_MIME);
    if (!raw?.trim()) return null;
    const o = JSON.parse(raw) as { relPath?: string };
    return typeof o.relPath === "string" && o.relPath.length > 0 ? o.relPath : null;
  } catch {
    return null;
  }
}

export async function addImageToSequenceGallery(
  charKey: string,
  sequenceName: string,
  sourceRelPath: string
): Promise<void> {
  const { relPath } = await apiSequenceDuplicateAsset({
    charKey,
    sequenceName,
    sourceRelPath,
    subfolder: "gallery",
  });
  const manifest = await apiSequenceGet(charKey, sequenceName);
  const crop = defaultSequenceCrop();
  await apiSequencePut(charKey, sequenceName, {
    ...manifest,
    gallery: [
      ...manifest.gallery,
      { id: newGalleryId(), relPath, crop },
    ],
  });
}
