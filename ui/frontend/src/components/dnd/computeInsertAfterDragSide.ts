import type { ClientRect } from "@dnd-kit/core";

/** For wrapped grids: use row (Y) when centers differ enough, else column (X). */
export function computeInsertAfterDragSide(
  activeRect: ClientRect | null | undefined,
  overRect: ClientRect | null | undefined
): boolean {
  if (!activeRect || !overRect) return false;
  const ax = activeRect.left + activeRect.width / 2;
  const ay = activeRect.top + activeRect.height / 2;
  const ox = overRect.left + overRect.width / 2;
  const oy = overRect.top + overRect.height / 2;
  const rowThreshold = Math.min(activeRect.height, overRect.height) * 0.5;
  if (Math.abs(ay - oy) > rowThreshold) {
    return ay > oy;
  }
  return ax > ox;
}
