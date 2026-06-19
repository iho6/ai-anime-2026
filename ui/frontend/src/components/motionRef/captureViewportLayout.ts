import type { SequencePreviewAspect } from "../../lib/api";
import { aspectDimensionsForId, fitAspectBox } from "../../lib/sequenceAspect";

export type CaptureViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Largest centered axis-aligned rect with the given aspect inside the container. */
export function computeCaptureViewportLayout(
  containerW: number,
  containerH: number,
  aspectId: SequencePreviewAspect,
): CaptureViewportRect {
  const { w: arW, h: arH } = aspectDimensionsForId(aspectId);
  const { w, h } = fitAspectBox(containerW, containerH, arW, arH);
  return {
    x: (containerW - w) / 2,
    y: (containerH - h) / 2,
    width: w,
    height: h,
  };
}

/** Icon box fitting in maxPx with exact aspect w:h and sharp corners. */
export function aspectIconBoxSize(
  w: number,
  h: number,
  maxPx = 14,
): { width: number; height: number } {
  if (w <= 0 || h <= 0 || maxPx <= 0) return { width: 0, height: 0 };
  if (w >= h) {
    return { width: maxPx, height: (maxPx * h) / w };
  }
  return { width: (maxPx * w) / h, height: maxPx };
}
