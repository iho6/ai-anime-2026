import type { ReferencePickerSelection } from "../components/ReferencePicker";
import type { KeypointRefEntry } from "./keypointRefGeneration";

export function selectionHasUsableRefs(sel: ReferencePickerSelection): boolean {
  return sel.singles.length + sel.videos.length + sel.folders.length > 0;
}

/** Build ordered queue from picker selection (folders, then singles, then videos). */
export function buildKeypointRefQueueFromSelection(
  sel: ReferencePickerSelection
): KeypointRefEntry[] {
  const out: KeypointRefEntry[] = [];
  for (const f of sel.folders ?? []) {
    out.push({
      kind: "folder",
      folderId: f.folder.id,
      folderName: f.folder.name,
      keypoints: f.keypoints,
    });
  }
  for (const ref of sel.singles) out.push({ kind: "single", ref });
  for (const ref of sel.videos) out.push({ kind: "video", ref });
  return out;
}

/**
 * Timeline / single-ref flows: one video, one folder, or first single.
 * Returns null when selection is empty or mixes incompatible types.
 */
export function pickSingleKeypointRefFromSelection(
  sel: ReferencePickerSelection
): KeypointRefEntry | null {
  const { singles, videos, folders } = sel;
  if (videos.length === 1 && !singles.length && !folders.length) {
    return { kind: "video", ref: videos[0] };
  }
  if (folders.length === 1 && !singles.length && !videos.length) {
    const f = folders[0];
    return {
      kind: "folder",
      folderId: f.folder.id,
      folderName: f.folder.name,
      keypoints: f.keypoints,
    };
  }
  if (singles.length >= 1 && !videos.length && !folders.length) {
    return { kind: "single", ref: singles[0] };
  }
  return null;
}
