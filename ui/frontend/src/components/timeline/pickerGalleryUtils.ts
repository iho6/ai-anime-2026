import { assetUrlFromRelPath } from "../../lib/api";

export function orderedGalleryRelPaths(
  sections: { images: { relPath: string }[] }[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const img of section.images) {
      if (!img.relPath || seen.has(img.relPath)) continue;
      seen.add(img.relPath);
      out.push(img.relPath);
    }
  }
  return out;
}

export function lightboxForRelPath(
  relPaths: string[],
  clicked: string,
  title: string
): { paths: string[]; index: number; title: string } {
  const urls = relPathsToPreviewUrls(relPaths);
  const idx = relPaths.indexOf(clicked);
  return {
    paths: urls,
    index: Math.max(0, idx),
    title,
  };
}

export function relPathsToPreviewUrls(relPaths: string[]): string[] {
  return relPaths.map((p) => assetUrlFromRelPath(p));
}

export function toggleSetMember<T>(prev: Set<T>, key: T, on: boolean): Set<T> {
  const next = new Set(prev);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}
