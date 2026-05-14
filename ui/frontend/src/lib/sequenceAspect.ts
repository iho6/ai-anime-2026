import type { SequencePreviewAspect } from "./api";

export const SEQUENCE_PREVIEW_ASPECT_OPTIONS: {
  id: SequencePreviewAspect;
  w: number;
  h: number;
  label: string;
}[] = [
  { id: "1:1", w: 1, h: 1, label: "1:1" },
  { id: "4:3", w: 4, h: 3, label: "4:3" },
  { id: "16:9", w: 16, h: 9, label: "16:9" },
  { id: "9:16", w: 9, h: 16, label: "9:16" },
];

const ALLOWED_IDS = new Set<string>(SEQUENCE_PREVIEW_ASPECT_OPTIONS.map((o) => o.id));

export function normalizeSequencePreviewAspect(v: string | undefined): SequencePreviewAspect {
  if (v && ALLOWED_IDS.has(v)) return v as SequencePreviewAspect;
  return "16:9";
}

/** Largest axis-aligned box with aspect rw:rh that fits in maxW × maxH. */
export function fitAspectBox(maxW: number, maxH: number, rw: number, rh: number): { w: number; h: number } {
  if (maxW <= 0 || maxH <= 0 || rw <= 0 || rh <= 0) return { w: 0, h: 0 };
  const r = rw / rh;
  let w = Math.min(maxW, maxH * r);
  let h = w / r;
  if (h > maxH) {
    h = maxH;
    w = h * r;
  }
  if (w > maxW) {
    w = maxW;
    h = w / r;
  }
  return { w, h };
}

export function aspectDimensionsForId(id: SequencePreviewAspect): { w: number; h: number } {
  const o = SEQUENCE_PREVIEW_ASPECT_OPTIONS.find((x) => x.id === id);
  return o ? { w: o.w, h: o.h } : { w: 16, h: 9 };
}
