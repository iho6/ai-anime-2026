/** Client cache for composited alpha-video preview frames (PNG from API). */

import type { ClipColoring, TimelineClip } from "../../lib/api";
import { normalizeClipColoring } from "../../lib/clipColoring";

export const PRELOAD_MAX_FRAMES = 64;
export const PRELOAD_MAX_SRC_DURATION_SEC = 5;
export const SLIDING_CACHE_MAX_FRAMES = 32;
export const DEFAULT_PREFETCH_CONCURRENCY = 4;

export function coloringSignature(coloring: ClipColoring | undefined): string {
  const n = normalizeClipColoring(coloring);
  return `${n.r},${n.g},${n.b},${n.opacity},${n.lightness}`;
}

export function estimateFrameCount(
  clip: Pick<TimelineClip, "inPoint" | "outPoint">,
  fps: number
): number {
  const inPt = clip.inPoint ?? 0;
  const outPt = clip.outPoint ?? 0;
  const dur = Math.max(0, outPt - inPt);
  return Math.max(1, Math.ceil(dur * Math.max(1, fps)));
}

export function shouldBulkPreload(
  clip: Pick<TimelineClip, "inPoint" | "outPoint" | "srcDuration">,
  fps: number
): boolean {
  const frames = estimateFrameCount(clip, fps);
  const inPt = clip.inPoint ?? 0;
  const outPt = clip.outPoint ?? 0;
  const srcDur = clip.srcDuration ?? Math.max(0, outPt - inPt);
  return frames <= PRELOAD_MAX_FRAMES || srcDur <= PRELOAD_MAX_SRC_DURATION_SEC;
}

export function frameIndicesForClip(
  clip: Pick<TimelineClip, "inPoint" | "outPoint">,
  fps: number
): number[] {
  const n = estimateFrameCount(clip, fps);
  return Array.from({ length: n }, (_, i) => i);
}

export function clampSourceTime(
  t: number,
  clip: Pick<TimelineClip, "inPoint" | "outPoint">
): number {
  const inPt = clip.inPoint ?? 0;
  const outPt = clip.outPoint ?? 0;
  let st = Math.max(t, inPt);
  if (outPt > 0) st = Math.min(st, outPt);
  return st;
}

export function sourceTimeFromFrameIdx(frameIdx: number, fps: number): number {
  return frameIdx / Math.max(1, fps);
}

export type AlphaFrameCache = {
  get: (frameIdx: number) => HTMLImageElement | undefined;
  set: (frameIdx: number, img: HTMLImageElement) => void;
  has: (frameIdx: number) => boolean;
  clear: () => void;
};

export function createAlphaFrameCache(options?: {
  maxEntries?: number;
}): AlphaFrameCache {
  const maxEntries = options?.maxEntries ?? SLIDING_CACHE_MAX_FRAMES;
  const frames = new Map<number, HTMLImageElement>();
  const lru: number[] = [];

  function touch(idx: number) {
    const pos = lru.indexOf(idx);
    if (pos >= 0) lru.splice(pos, 1);
    lru.push(idx);
    while (lru.length > maxEntries) {
      const evict = lru.shift();
      if (evict != null) frames.delete(evict);
    }
  }

  return {
    get(frameIdx) {
      const img = frames.get(frameIdx);
      if (img) touch(frameIdx);
      return img;
    },
    set(frameIdx, img) {
      frames.set(frameIdx, img);
      touch(frameIdx);
    },
    has(frameIdx) {
      return frames.has(frameIdx);
    },
    clear() {
      frames.clear();
      lru.length = 0;
    },
  };
}

export async function prefetchFrames(
  frameIndices: number[],
  fetchFrame: (frameIdx: number) => Promise<HTMLImageElement | null>,
  options?: {
    concurrency?: number;
    cache?: AlphaFrameCache;
    shouldAbort?: () => boolean;
  }
): Promise<void> {
  const concurrency = options?.concurrency ?? DEFAULT_PREFETCH_CONCURRENCY;
  const cache = options?.cache;
  const shouldAbort = options?.shouldAbort ?? (() => false);
  const queue = frameIndices.filter((idx) => !cache?.has(idx));

  if (queue.length === 0) return;

  await new Promise<void>((resolve) => {
    let ptr = 0;
    let active = 0;

    function pump() {
      if (shouldAbort()) {
        if (active === 0) resolve();
        return;
      }
      while (active < concurrency && ptr < queue.length) {
        const frameIdx = queue[ptr++];
        active++;
        fetchFrame(frameIdx)
          .then((img) => {
            if (img && cache && !shouldAbort()) cache.set(frameIdx, img);
          })
          .finally(() => {
            active--;
            if (shouldAbort() && active === 0) {
              resolve();
              return;
            }
            if (ptr >= queue.length && active === 0) resolve();
            else pump();
          });
      }
    }

    pump();
  });
}
