/** Shared folder leaf selection for KeypointsLayout / MotionShotsLayout grids. */

const FOLDER_PREFIX = "folder:";
const VIDEO_PREFIX = "video:";

export type FolderLayoutLike = {
  folderOrder: Record<string, string[]>;
};

export function parseFolderToken(token: string): string | null {
  const s = String(token).trim();
  if (s.startsWith(FOLDER_PREFIX)) return s.slice(FOLDER_PREFIX.length);
  return null;
}

/** All selectable leaf tokens inside a folder (recurses nested folders). */
export function collectFolderLeafIds(
  folderId: string,
  layout: FolderLayoutLike,
  isLeaf: (token: string) => boolean
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  function walk(fid: string) {
    for (const tok of layout.folderOrder[fid] ?? []) {
      const nested = parseFolderToken(tok);
      if (nested) {
        walk(nested);
        continue;
      }
      if (isLeaf(tok) && !seen.has(tok)) {
        seen.add(tok);
        out.push(tok);
      }
    }
  }

  walk(folderId);
  return out;
}

/** Folder ids in post-order (children before parents) for safe nested delete. */
export function collectFolderIdsPostOrder(
  folderId: string,
  layout: FolderLayoutLike
): string[] {
  const out: string[] = [];

  function walk(fid: string) {
    for (const tok of layout.folderOrder[fid] ?? []) {
      const nested = parseFolderToken(tok);
      if (nested) walk(nested);
    }
    out.push(fid);
  }

  walk(folderId);
  return out;
}

export function folderContainsFolderId(
  rootFolderId: string,
  candidateFolderId: string | null | undefined,
  layout: FolderLayoutLike
): boolean {
  if (!candidateFolderId) return false;
  if (rootFolderId === candidateFolderId) return true;

  function walk(fid: string): boolean {
    for (const tok of layout.folderOrder[fid] ?? []) {
      const nested = parseFolderToken(tok);
      if (nested && (nested === candidateFolderId || walk(nested))) return true;
    }
    return false;
  }

  return walk(rootFolderId);
}

export function folderSelectionState(
  folderId: string,
  layout: FolderLayoutLike,
  selectedIds: Set<string>,
  isLeaf: (token: string) => boolean
): { checked: boolean; indeterminate: boolean } {
  const leaves = collectFolderLeafIds(folderId, layout, isLeaf);
  if (!leaves.length) return { checked: false, indeterminate: false };
  const selectedCount = leaves.filter((id) => selectedIds.has(id)).length;
  if (selectedCount === 0) return { checked: false, indeterminate: false };
  if (selectedCount === leaves.length) return { checked: true, indeterminate: false };
  return { checked: false, indeterminate: true };
}

export function toggleFolderSelection(
  folderId: string,
  layout: FolderLayoutLike,
  selectedIds: Set<string>,
  on: boolean,
  isLeaf: (token: string) => boolean
): Set<string> {
  const leaves = collectFolderLeafIds(folderId, layout, isLeaf);
  const next = new Set(selectedIds);
  for (const id of leaves) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

export function isKeypointGridLeaf(
  token: string,
  itemIds: Set<string>,
  videoIds: Set<string>
): boolean {
  if (token.startsWith(VIDEO_PREFIX)) {
    return videoIds.has(token.slice(VIDEO_PREFIX.length));
  }
  if (parseFolderToken(token)) return false;
  return itemIds.has(token);
}

export function isShotGridLeaf(token: string, shotIds: Set<string>): boolean {
  if (parseFolderToken(token)) return false;
  return shotIds.has(token);
}
