import type { BuilderEntry } from "./builderTypes";

export function displayRelPath(e: {
  previewRelPath: string | null;
  sourceRelPath?: string;
  fileRelPath?: string;
}): string {
  if (e.previewRelPath) return e.previewRelPath;
  if (e.fileRelPath) return e.fileRelPath;
  return e.sourceRelPath ?? "";
}

export function buildBuilderEntriesPreserve(
  entries: BuilderEntry[]
): Map<string, Partial<BuilderEntry>> {
  const m = new Map<string, Partial<BuilderEntry>>();
  for (const x of entries) {
    m.set(x.tileId, {
      previewRelPath: x.previewRelPath,
      beforeNoiseRelPath: x.beforeNoiseRelPath,
      builderHidden: x.builderHidden,
      removed: x.removed,
    });
  }
  return m;
}

/** Pose vs expression section for a tile id (strip membership). */
export function builderSectionForTileId(
  tileId: string,
  poseStripIds: string[],
  exprStripIds: string[]
): "pose" | "expr" | null {
  if (poseStripIds.includes(tileId)) return "pose";
  if (exprStripIds.includes(tileId)) return "expr";
  return null;
}

/**
 * Tile ids in UI order: pose strip then expression strip.
 * @param requireSelectable - if true, skip removed and builderHidden entries.
 */
export function builderStripOrderedTileIds(
  entries: BuilderEntry[],
  poseStripIds: string[],
  exprStripIds: string[],
  opts?: { requireSelectable?: boolean }
): string[] {
  const map = new Map(entries.map((e) => [e.tileId, e]));
  const out: string[] = [];
  const consider = (id: string) => {
    const e = map.get(id);
    if (!e || e.removed) return;
    if (opts?.requireSelectable && e.builderHidden) return;
    out.push(id);
  };
  for (const id of poseStripIds) consider(id);
  for (const id of exprStripIds) consider(id);
  return out;
}

/** Strip order, only tiles that can be shift-selected / select-all (not builder-hidden). */
export function builderSectionSelectableIds(
  entries: BuilderEntry[],
  sectionStripIds: string[]
): string[] {
  const map = new Map(entries.map((e) => [e.tileId, e]));
  return sectionStripIds.filter((id) => {
    const e = map.get(id);
    return e && !e.removed && !e.builderHidden;
  });
}

export function defaultBuilderStripsFromEntries(entries: BuilderEntry[]): {
  pose: string[];
  expr: string[];
} {
  const pose: string[] = [];
  const expr: string[] = [];
  for (const e of entries) {
    if (e.removed) continue;
    if (e.sourceKind === "expr") expr.push(e.tileId);
    else pose.push(e.tileId);
  }
  return { pose, expr };
}

export function syncBuilderStripsFromApi(
  next: BuilderEntry[],
  src: { poseStripIds?: string[]; exprStripIds?: string[] }
): { pose: string[]; expr: string[] } {
  const notRemoved = new Set(next.filter((e) => !e.removed).map((e) => e.tileId));
  let p = src.poseStripIds ?? [];
  let e = src.exprStripIds ?? [];
  if (p.length === 0 && e.length === 0) {
    return defaultBuilderStripsFromEntries(next);
  }
  p = p.filter((id) => notRemoved.has(id));
  e = e.filter((id) => notRemoved.has(id));
  const covered = new Set([...p, ...e]);
  for (const entry of next) {
    if (entry.removed || covered.has(entry.tileId)) continue;
    covered.add(entry.tileId);
    if (entry.sourceKind === "expr") e.push(entry.tileId);
    else p.push(entry.tileId);
  }
  return { pose: p, expr: e };
}
