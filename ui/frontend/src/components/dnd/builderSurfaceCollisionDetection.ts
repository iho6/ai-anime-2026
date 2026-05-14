import type { CollisionDetection, UniqueIdentifier } from "@dnd-kit/core";
import { closestCenter, pointerWithin } from "@dnd-kit/core";

const CONTAINER_PREFIX = "container:";

function withActiveFiltered<T extends { id: UniqueIdentifier }>(
  hits: T[],
  activeId: UniqueIdentifier
): T[] {
  const filtered = hits.filter((h) => h.id !== activeId);
  return filtered.length ? filtered : hits;
}

function preferItemsOverContainers<T extends { id: UniqueIdentifier }>(hits: T[]): T[] {
  const noCont = hits.filter((h) => !String(h.id).startsWith(CONTAINER_PREFIX));
  return noCont.length ? noCont : hits;
}

/**
 * Dataset builder grids: pointer-first without inflated rects to avoid
 * layout ↔ collision feedback when hovering near tile edges.
 */
export function builderSurfaceCollisionDetection(): CollisionDetection {
  return (args) => {
    const { active } = args;
    const pointerHits = pointerWithin(args);
    const noSelf = withActiveFiltered(pointerHits, active.id);
    const pref = preferItemsOverContainers(noSelf);
    if (pref.length) return pref;
    const center = closestCenter(args);
    return withActiveFiltered(center, active.id);
  };
}
