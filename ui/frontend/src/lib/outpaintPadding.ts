export type OutpaintBoxPx = {
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
};

export type OutpaintPaddingPx = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type OutpaintStage = OutpaintPaddingPx;

/** Qwen model native working width (workflow scales input to this). */
export const QWEN_NATIVE_OUTPAINT_DIM = 1024;

/** Default max padding per pass per side = half the native dim. */
export const DEFAULT_MAX_OUTPAINT_PER_PASS = 512;

export const MIN_MAX_OUTPAINT_PER_PASS = 128;
export const MAX_MAX_OUTPAINT_PER_PASS = 1024;
export const MAX_OUTPAINT_PER_PASS_STEP = 64;

export const OUTPAINT_PAD_STEP = 8;

export function snapOutpaintPadding(value: number, step = OUTPAINT_PAD_STEP): number {
  const v = Math.max(0, Math.round(value));
  if (v === 0) return 0;
  return Math.max(step, Math.round(v / step) * step);
}

/** Map output canvas box (natural px) to ImagePadForOutpaint padding. Image occupies [0,w]×[0,h]. */
export function paddingFromOutpaintBox(
  box: OutpaintBoxPx,
  nat: { w: number; h: number }
): OutpaintPaddingPx {
  return {
    left: snapOutpaintPadding(Math.max(0, -box.bx0)),
    top: snapOutpaintPadding(Math.max(0, -box.by0)),
    right: snapOutpaintPadding(Math.max(0, box.bx1 - nat.w)),
    bottom: snapOutpaintPadding(Math.max(0, box.by1 - nat.h)),
  };
}

export function hasOutpaintPadding(pad: OutpaintPaddingPx): boolean {
  return pad.left > 0 || pad.top > 0 || pad.right > 0 || pad.bottom > 0;
}

export function initialOutpaintBox(nat: { w: number; h: number }): OutpaintBoxPx {
  return { bx0: 0, by0: 0, bx1: nat.w, by1: nat.h };
}

function splitSideIntoChunks(total: number, maxPerPass: number): number[] {
  if (total <= 0) return [];
  const cap = Math.max(OUTPAINT_PAD_STEP, snapOutpaintPadding(maxPerPass));
  const chunks: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    if (remaining <= cap) {
      chunks.push(remaining);
      break;
    }
    chunks.push(cap);
    remaining -= cap;
  }
  return chunks;
}

/** Split total padding into stages capped by maxPerPass per side (Qwen native dim / 2 by default). */
export function splitOutpaintIntoStages(
  pad: OutpaintPaddingPx,
  maxPerPass: number = DEFAULT_MAX_OUTPAINT_PER_PASS
): OutpaintStage[] {
  const leftChunks = splitSideIntoChunks(pad.left, maxPerPass);
  const topChunks = splitSideIntoChunks(pad.top, maxPerPass);
  const rightChunks = splitSideIntoChunks(pad.right, maxPerPass);
  const bottomChunks = splitSideIntoChunks(pad.bottom, maxPerPass);
  const numStages = Math.max(
    leftChunks.length,
    topChunks.length,
    rightChunks.length,
    bottomChunks.length,
    1
  );
  const stages: OutpaintStage[] = [];
  for (let i = 0; i < numStages; i++) {
    const stage: OutpaintStage = {
      left: leftChunks[i] ?? 0,
      top: topChunks[i] ?? 0,
      right: rightChunks[i] ?? 0,
      bottom: bottomChunks[i] ?? 0,
    };
    if (hasOutpaintPadding(stage)) stages.push(stage);
  }
  return stages.length ? stages : [{ left: 0, top: 0, right: 0, bottom: 0 }];
}

export function clampMaxOutpaintPerPass(value: number): number {
  const snapped = Math.round(value / MAX_OUTPAINT_PER_PASS_STEP) * MAX_OUTPAINT_PER_PASS_STEP;
  return Math.min(MAX_MAX_OUTPAINT_PER_PASS, Math.max(MIN_MAX_OUTPAINT_PER_PASS, snapped));
}
