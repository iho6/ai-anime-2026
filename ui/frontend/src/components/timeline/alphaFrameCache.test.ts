import { describe, expect, it } from "vitest";
import {
  createAlphaFrameCache,
  estimateFrameCount,
  frameIndicesForClip,
  prefetchFrames,
  shouldBulkPreload,
  SLIDING_CACHE_MAX_FRAMES,
} from "./alphaFrameCache";

function fakeImg(id: number): HTMLImageElement {
  return { naturalWidth: 1, naturalHeight: 1, __id: id } as unknown as HTMLImageElement;
}

describe("estimateFrameCount", () => {
  it("ceil duration times fps", () => {
    expect(estimateFrameCount({ inPoint: 0, outPoint: 1.333 }, 24)).toBe(32);
    expect(estimateFrameCount({ inPoint: 0, outPoint: 1 }, 24)).toBe(24);
  });
});

describe("shouldBulkPreload", () => {
  it("preloads short clips by frame count", () => {
    expect(shouldBulkPreload({ inPoint: 0, outPoint: 1.333, srcDuration: 1.333 }, 24)).toBe(
      true
    );
  });

  it("skips bulk preload for long clips", () => {
    expect(shouldBulkPreload({ inPoint: 0, outPoint: 30, srcDuration: 30 }, 24)).toBe(false);
  });

  it("preloads when srcDuration under cap even if many frames", () => {
    expect(shouldBulkPreload({ inPoint: 0, outPoint: 4, srcDuration: 4 }, 24)).toBe(true);
  });
});

describe("frameIndicesForClip", () => {
  it("returns zero-based contiguous indices", () => {
    expect(frameIndicesForClip({ inPoint: 0, outPoint: 0.5 }, 24)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });
});

describe("createAlphaFrameCache", () => {
  it("evicts LRU beyond max entries", () => {
    const cache = createAlphaFrameCache({ maxEntries: 3 });
    cache.set(0, fakeImg(0));
    cache.set(1, fakeImg(1));
    cache.set(2, fakeImg(2));
    cache.get(0);
    cache.set(3, fakeImg(3));
    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(3)).toBe(true);
  });

  it("clear drops all entries", () => {
    const cache = createAlphaFrameCache();
    cache.set(0, fakeImg(0));
    cache.clear();
    expect(cache.has(0)).toBe(false);
  });
});

describe("prefetchFrames", () => {
  it("respects concurrency and fills cache", async () => {
    const cache = createAlphaFrameCache({ maxEntries: SLIDING_CACHE_MAX_FRAMES });
    let peak = 0;
    let active = 0;
    await prefetchFrames(
      [0, 1, 2, 3],
      async (idx) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return fakeImg(idx);
      },
      { concurrency: 2, cache }
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(3)).toBe(true);
  });

  it("skips indices already cached", async () => {
    const cache = createAlphaFrameCache();
    cache.set(1, fakeImg(1));
    let fetches = 0;
    await prefetchFrames(
      [0, 1, 2],
      async () => {
        fetches++;
        return fakeImg(0);
      },
      { cache }
    );
    expect(fetches).toBe(2);
  });
});
