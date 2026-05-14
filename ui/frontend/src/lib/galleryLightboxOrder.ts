import { assetUrlFromRelPath, type GallerySplit } from "./api";

export type GalleryDragContainers = { visible: string[]; hidden: string[] };

export type FlatGalleryLightboxTitles = { visible: string; hidden: string };

/**
 * Build lightbox paths in the same order as the sortable grid (dragContainers),
 * falling back to API split order when the clicked id is not in either drag list.
 */
export function buildFlatGalleryLightboxPaths(
  split: GallerySplit | null,
  dragContainers: GalleryDragContainers,
  clickedItemId: string,
  titles: FlatGalleryLightboxTitles
): { paths: string[]; index: number; title: string } | null {
  const byId = new Map<string, GallerySplit["visible"][number]>();
  for (const x of [...(split?.visible ?? []), ...(split?.hidden ?? [])]) {
    byId.set(x.itemId, x);
  }

  const inVis = dragContainers.visible.includes(clickedItemId);
  const inHid = dragContainers.hidden.includes(clickedItemId);

  if (inVis) {
    const out = walkOrderedIds(dragContainers.visible, byId, clickedItemId, titles.visible);
    if (out) return out;
    return fallbackSplitOrder(split, clickedItemId, "visible", titles.visible);
  }
  if (inHid) {
    const out = walkOrderedIds(dragContainers.hidden, byId, clickedItemId, titles.hidden);
    if (out) return out;
    return fallbackSplitOrder(split, clickedItemId, "hidden", titles.hidden);
  }

  return (
    fallbackSplitOrder(split, clickedItemId, "visible", titles.visible) ??
    fallbackSplitOrder(split, clickedItemId, "hidden", titles.hidden)
  );
}

function walkOrderedIds(
  orderedIds: string[],
  byId: Map<string, GallerySplit["visible"][number]>,
  clickedItemId: string,
  title: string
): { paths: string[]; index: number; title: string } | null {
  const paths: string[] = [];
  let index = -1;
  for (const id of orderedIds) {
    const it = byId.get(id);
    if (!it?.relPath) continue;
    if (id === clickedItemId) index = paths.length;
    paths.push(assetUrlFromRelPath(it.relPath));
  }
  if (index < 0) return null;
  return { paths, index, title };
}

function fallbackSplitOrder(
  split: GallerySplit | null,
  clickedItemId: string,
  section: "visible" | "hidden",
  titleForSection: string
): { paths: string[]; index: number; title: string } | null {
  const items = section === "visible" ? (split?.visible ?? []) : (split?.hidden ?? []);
  const withRel = items.filter((x) => Boolean(x.relPath));
  const idx = withRel.findIndex((x) => x.itemId === clickedItemId);
  if (idx < 0) return null;
  return {
    paths: withRel.map((x) => assetUrlFromRelPath(x.relPath as string)),
    index: idx,
    title: titleForSection,
  };
}
