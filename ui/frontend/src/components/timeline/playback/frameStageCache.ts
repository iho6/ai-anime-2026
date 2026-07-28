/**
 * Blender-style multi-stage preview frame cache (FINAL-focused v1).
 * Prefetch ahead of playhead; evict farthest outside the window.
 */

export type FrameCacheStage = "raw" | "preprocessed" | "composite" | "final";

export type FrameCacheKey = {
  sceneHash: string;
  frame: number;
  stage: FrameCacheStage;
  quality: "playback" | "paused";
};

function keyString(k: FrameCacheKey): string {
  return `${k.stage}|${k.quality}|${k.frame}|${k.sceneHash}`;
}

export type FrameStageCache = {
  get: (key: FrameCacheKey) => ImageBitmap | null;
  set: (key: FrameCacheKey, bitmap: ImageBitmap) => void;
  has: (key: FrameCacheKey) => boolean;
  invalidateScenePrefix: (sceneHashPrefix?: string) => void;
  /** Drop entries outside [playhead - behind, playhead + ahead]. */
  evictOutsideWindow: (playheadFrame: number, behind: number, ahead: number) => void;
  size: () => number;
  clear: () => void;
};

export function createFrameStageCache(maxEntries = 96): FrameStageCache {
  const map = new Map<string, ImageBitmap>();
  const order: string[] = [];

  const dispose = (k: string) => {
    const bmp = map.get(k);
    if (bmp) {
      try {
        bmp.close();
      } catch {
        /* already closed */
      }
      map.delete(k);
    }
    const ix = order.indexOf(k);
    if (ix >= 0) order.splice(ix, 1);
  };

  const touch = (k: string) => {
    const ix = order.indexOf(k);
    if (ix >= 0) order.splice(ix, 1);
    order.push(k);
  };

  const trim = () => {
    while (order.length > maxEntries) {
      const oldest = order[0];
      if (!oldest) break;
      dispose(oldest);
    }
  };

  return {
    get: (key) => {
      const k = keyString(key);
      const v = map.get(k) ?? null;
      if (v) touch(k);
      return v;
    },
    set: (key, bitmap) => {
      const k = keyString(key);
      if (map.has(k)) dispose(k);
      map.set(k, bitmap);
      order.push(k);
      trim();
    },
    has: (key) => map.has(keyString(key)),
    invalidateScenePrefix: (prefix) => {
      if (!prefix) {
        for (const k of [...order]) dispose(k);
        return;
      }
      for (const k of [...order]) {
        if (k.includes(prefix)) dispose(k);
      }
    },
    evictOutsideWindow: (playheadFrame, behind, ahead) => {
      const lo = playheadFrame - behind;
      const hi = playheadFrame + ahead;
      for (const k of [...order]) {
        const parts = k.split("|");
        const frame = Number(parts[2]);
        if (!Number.isFinite(frame) || frame < lo || frame > hi) dispose(k);
      }
    },
    size: () => map.size,
    clear: () => {
      for (const k of [...order]) dispose(k);
    },
  };
}

export type PrefetchPlan = {
  frames: number[];
  quality: "playback" | "paused";
};

/** Frames to prefetch ahead of playhead (and a small behind for scrub). */
export function planPrefetch(
  playheadFrame: number,
  ahead = 24,
  behind = 4
): PrefetchPlan {
  const frames: number[] = [];
  for (let f = Math.max(0, playheadFrame - behind); f <= playheadFrame + ahead; f++) {
    frames.push(f);
  }
  return { frames, quality: "playback" };
}
