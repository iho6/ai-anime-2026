import type { ClientRect, CollisionDetection, UniqueIdentifier } from "@dnd-kit/core";
import { closestCorners, pointerWithin, rectIntersection } from "@dnd-kit/core";

const CONTAINER_ID_PREFIX = "container:";

function expandRect(rect: ClientRect, pad: number): ClientRect {
  const top = rect.top - pad;
  const left = rect.left - pad;
  const bottom = rect.bottom + pad;
  const right = rect.right + pad;
  return {
    width: right - left,
    height: bottom - top,
    top,
    left,
    bottom,
    right,
  };
}

/** Prefer sortable item hits over parent container droppables when both overlap. */
function preferItemsOverContainers<T extends { id: UniqueIdentifier }>(hits: T[]): T[] {
  const withoutContainers = hits.filter((h) => {
    const sid = String(h.id);
    return !sid.startsWith(CONTAINER_ID_PREFIX) && sid !== "__container__";
  });
  return withoutContainers.length ? withoutContainers : hits;
}

/** Drop self as collision target when any other target exists (fallback keeps original if only self). */
function withActiveFiltered<T extends { id: UniqueIdentifier }>(hits: T[], activeId: UniqueIdentifier): T[] {
  const filtered = hits.filter((h) => h.id !== activeId);
  return filtered.length ? filtered : hits;
}

/**
 * DnD hit targets for gallery grids: pointer-first with inflated rects (easier “crossing”),
 * then rect intersection (inflated dragged rect), then closest corners.
 */
export function galleryCollisionDetection(padPx = 20): CollisionDetection {
  return (args) => {
    const { droppableRects, pointerCoordinates, active, collisionRect } = args;
    const activeId = active.id;

    if (pointerCoordinates) {
      const inflated = new Map<UniqueIdentifier, ClientRect>();
      for (const [id, rect] of droppableRects) {
        inflated.set(id, expandRect(rect, padPx));
      }
      const pointerHits = pointerWithin({
        ...args,
        droppableRects: inflated,
      });
      const noSelf = withActiveFiltered(pointerHits, activeId);
      const preferred = preferItemsOverContainers(noSelf);
      if (preferred.length) return preferred;
    }

    const inter = rectIntersection({
      ...args,
      collisionRect: expandRect(collisionRect, padPx),
    });
    const interNoSelf = withActiveFiltered(inter, activeId);
    const interPreferred = preferItemsOverContainers(interNoSelf);
    if (interPreferred.length) return interPreferred;

    const corners = closestCorners(args);
    const cornersNoSelf = withActiveFiltered(corners, activeId);
    return cornersNoSelf;
  };
}
