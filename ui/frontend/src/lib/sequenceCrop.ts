import type { CSSProperties } from "react";
import type { SequenceCrop } from "./api";

export function defaultSequenceCrop(): SequenceCrop {
  return { translateXFrac: 0, translateYFrac: 0, scale: 1 };
}

export function normalizeCrop(c: SequenceCrop | undefined | null): SequenceCrop {
  const d = defaultSequenceCrop();
  if (!c) return d;
  const tx =
    typeof c.translateXFrac === "number" && Number.isFinite(c.translateXFrac)
      ? c.translateXFrac
      : 0;
  const ty =
    typeof c.translateYFrac === "number" && Number.isFinite(c.translateYFrac)
      ? c.translateYFrac
      : 0;
  const sc =
    typeof c.scale === "number" && Number.isFinite(c.scale) && c.scale >= 1 ? c.scale : 1;
  return { translateXFrac: tx, translateYFrac: ty, scale: sc };
}

export function cloneCrop(c: SequenceCrop | undefined | null): SequenceCrop {
  const n = normalizeCrop(c);
  return { translateXFrac: n.translateXFrac, translateYFrac: n.translateYFrac, scale: n.scale };
}

/** Transform only — apply to a non-replaced wrapper around `<img>` for reliable clipping.
 *
 * Translation uses CSS percentages so it scales with the wrapper's own size; the wrapper
 * is sized 100% of its parent, so the same crop renders identically in any container
 * (lightbox viewport, timeline cell, modal preview, MP4 raster). */
export function sequenceCropImageStyle(crop: SequenceCrop | undefined | null): CSSProperties {
  const c = normalizeCrop(crop);
  return {
    transform: `translate(${c.translateXFrac * 100}%, ${c.translateYFrac * 100}%) scale(${c.scale})`,
    transformOrigin: "center center",
  };
}

/** Outer cell: fills parent, clips overflow, flex-centers child; use `minWidth`/`minHeight` 0 to avoid flex blow-out. */
export const SEQUENCE_CROP_OUTER_CLIP_FLEX: CSSProperties = {
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 0,
  minHeight: 0,
};

/** Inner wrapper around `<img>`: fills clip cell so image fits the frame at scale 1; carries crop transform. */
export function sequenceCropTransformWrapperStyle(
  crop: SequenceCrop | undefined | null
): CSSProperties {
  return {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: 0,
    ...sequenceCropImageStyle(crop),
  };
}
