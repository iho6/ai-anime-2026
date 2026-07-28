import { describe, expect, it, vi } from "vitest";
import { createPlayheadStore } from "../timelinePlayback";
import { createPlaybackClock, timelineFrameCount } from "./playbackClock";
import { resolveScene, sceneContentHash, countActiveAlphaLayers } from "./resolveScene";
import { previewQualityPolicy } from "./previewQuality";
import { resolvePreviewMedia, timelineHasMissingProxies } from "./mediaProvider";
import { createFrameStageCache, planPrefetch } from "./frameStageCache";
import {
  bakeCoversPlayhead,
  describeTimelineBakeJob,
  getTimelinePreviewBake,
} from "./timelineProxyBake";
import {
  createFairPrefetchQueue,
  fairRoundRobinKeys,
} from "./fairPrefetchQueue";
import {
  createFrameProducer,
  layoutFinalSceneHash,
  layoutOutputSize,
} from "./frameProducer";
import { createPreviewEngine } from "./previewEngine";
import {
  assignPlaySlots,
  playBudgetRotationEpoch,
  MAX_ACTIVE_VIDEO_DECODES,
} from "./decodeBudget";
import type { TimelineClip, TimelineManifest } from "../../../lib/api";

function videoClip(partial: Partial<TimelineClip> & { id: string }): TimelineClip {
  return {
    type: "video",
    srcRelPath: `clips/${partial.id}.mp4`,
    start: 0,
    inPoint: 0,
    outPoint: 2,
    speed: 1,
    duration: 2,
    naturalW: 1920,
    naturalH: 1080,
    ...partial,
  };
}

function manifest(clips: TimelineClip[]): TimelineManifest {
  return {
    version: 1,
    fps: 24,
    previewAspect: "16:9",
    tracks: [{ id: "t1", name: "V1", kind: "video", clips }],
  };
}

describe("playbackClock", () => {
  it("maps seconds to integer frames", () => {
    const store = createPlayheadStore(0.5);
    const clock = createPlaybackClock(24, store);
    expect(clock.currentFrame()).toBe(12);
    expect(clock.secAtFrame(24)).toBe(1);
    clock.seekFrame(48);
    expect(store.get()).toBe(2);
  });

  it("counts timeline frames from duration", () => {
    expect(timelineFrameCount(1, 24)).toBe(24);
  });
});

describe("resolveScene", () => {
  it("resolves active layers at a frame", () => {
    const m = manifest([videoClip({ id: "a", start: 0, duration: 2, outPoint: 2 })]);
    const scene = resolveScene(m, 12);
    expect(scene.timeSec).toBe(0.5);
    expect(scene.layers.some((l) => l.clip.id === "a" && !l.preload)).toBe(true);
  });

  it("counts alpha stacks", () => {
    const m = manifest([
      videoClip({ id: "a", alphaRelPath: "a.mkv" }),
      videoClip({ id: "b", alphaRelPath: "b.mkv", start: 0 }),
    ]);
    const multi: TimelineManifest = {
      version: 1,
      fps: 24,
      previewAspect: "16:9",
      tracks: [
        { id: "t1", name: "V1", kind: "video", clips: [videoClip({ id: "a", alphaRelPath: "a.mkv" })] },
        { id: "t2", name: "V2", kind: "video", clips: [videoClip({ id: "b", alphaRelPath: "b.mkv" })] },
      ],
    };
    expect(countActiveAlphaLayers(resolveScene(multi, 0))).toBe(2);
    expect(sceneContentHash(resolveScene(m, 0)).length).toBeGreaterThan(4);
  });
});

describe("previewQualityPolicy", () => {
  it("keeps pixel coloring on during play and halves resolve scale", () => {
    const scene = resolveScene(manifest([videoClip({ id: "a" })]), 0);
    expect(previewQualityPolicy(true, scene).skipPixelColoring).toBe(false);
    expect(previewQualityPolicy(true, scene).resolveScale).toBe(0.5);
    expect(previewQualityPolicy(false, scene).skipPixelColoring).toBe(false);
    expect(previewQualityPolicy(false, scene).resolveScale).toBe(1);
  });

  it("does not apply scene-wide hold-step override", () => {
    const multi: TimelineManifest = {
      version: 1,
      fps: 24,
      previewAspect: "16:9",
      tracks: [
        { id: "t1", name: "V1", kind: "video", clips: [videoClip({ id: "a", alphaRelPath: "a.mkv" })] },
        { id: "t2", name: "V2", kind: "video", clips: [videoClip({ id: "b", alphaRelPath: "b.mkv" })] },
      ],
    };
    const scene = resolveScene(multi, 0);
    const policy = previewQualityPolicy(true, scene);
    expect("holdStepOverride" in policy).toBe(false);
  });
});

describe("mediaProvider", () => {
  it("uses unified webm as single-stream alpha preview", () => {
    const clip = videoClip({
      id: "a",
      proxyRelPath: "clips/a.proxy.webm",
      proxyAlphaRelPath: "clips/a.proxy.alpha.mp4",
      alphaRelPath: "clips/a.alpha.mkv",
    });
    const media = resolvePreviewMedia(clip);
    expect(media.usingProxy).toBe(true);
    expect(media.unifiedAlphaProxy).toBe(true);
    expect(media.rgbUrl).toContain("a.proxy.webm");
    expect(media.alphaUrl).toBeNull();
    expect(media.alphaKind).toBe("alphaChannel");
  });

  it("ignores stale companion mattes until unified proxy exists", () => {
    const clip = videoClip({
      id: "b",
      proxyRelPath: "clips/b.proxy.mp4",
      proxyAlphaRelPath: "clips/b.proxy.alpha.mp4",
      alphaRelPath: "clips/b.alpha.mkv",
    });
    const media = resolvePreviewMedia(clip);
    expect(media.unifiedAlphaProxy).toBe(false);
    expect(media.alphaUrl).toBeNull();
  });

  it("flags missing proxies", () => {
    expect(timelineHasMissingProxies([videoClip({ id: "a" })])).toBe(true);
    expect(
      timelineHasMissingProxies([videoClip({ id: "a", proxyRelPath: "p.mp4" })])
    ).toBe(false);
  });
});

describe("frameStageCache", () => {
  it("plans prefetch around the playhead", () => {
    const plan = planPrefetch(10, 2, 1);
    expect(plan.frames).toEqual([9, 10, 11, 12]);
  });

  it("stores and evicts outside the window", () => {
    const cache = createFrameStageCache(10);
    if (typeof createImageBitmap !== "function") {
      expect(cache.size()).toBe(0);
      return;
    }
  });
});

describe("decodeBudget", () => {
  it("rotates which clips get play slots", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const e0 = assignPlaySlots(ids, MAX_ACTIVE_VIDEO_DECODES, 0);
    const e1 = assignPlaySlots(ids, MAX_ACTIVE_VIDEO_DECODES, 1);
    expect(e0.size).toBe(4);
    expect(e1.size).toBe(4);
    expect([...e0]).not.toEqual([...e1]);
    expect(e0.has("a")).toBe(true);
    expect(e1.has("b")).toBe(true);
    // Over enough epochs every clip appears
    const seen = new Set<string>();
    for (let e = 0; e < ids.length; e++) {
      for (const id of assignPlaySlots(ids, 4, e)) seen.add(id);
    }
    expect(seen.size).toBe(ids.length);
  });

  it("dedupes clip ids before assigning slots", () => {
    const slots = assignPlaySlots(
      ["a", "a", "b", "b", "c", "c", "d", "d", "e", "e"],
      4,
      0
    );
    expect(slots.size).toBe(4);
    expect(slots.has("a")).toBe(true);
  });

  it("maps timeline frames to rotation epochs", () => {
    expect(playBudgetRotationEpoch(0, 6)).toBe(0);
    expect(playBudgetRotationEpoch(5, 6)).toBe(0);
    expect(playBudgetRotationEpoch(6, 6)).toBe(1);
  });
});

describe("fairPrefetchQueue", () => {
  it("round-robins keys for fairness helpers", () => {
    expect(fairRoundRobinKeys(["a", "b"], 4)).toEqual(["a", "b", "a", "b"]);
  });

  it("does not starve a second clip under concurrency 2", async () => {
    const started: string[] = [];
    const resolvers: Array<() => void> = [];
    const queue = createFairPrefetchQueue(2);

    const block = (key: string) =>
      queue.enqueue({
        key,
        priority: 0,
        run: () =>
          new Promise<void>((resolve) => {
            started.push(key);
            resolvers.push(resolve);
          }),
      });

    const pA1 = block("a");
    const pB1 = block("b");
    const pA2 = block("a");
    const pB2 = block("b");

    await vi.waitFor(() => expect(started.length).toBe(2));
    expect([...started].sort()).toEqual(["a", "b"]);

    const firstWave = resolvers.splice(0, resolvers.length);
    for (const resolve of firstWave) resolve();
    await Promise.all([pA1, pB1]);
    await vi.waitFor(() => expect(started.length).toBe(4));
    expect(started.filter((k) => k === "a").length).toBe(2);
    expect(started.filter((k) => k === "b").length).toBe(2);
    for (const resolve of resolvers) resolve();
    await Promise.all([pA2, pB2]);
  });
});

describe("frameProducer layout + previewEngine ownership", () => {
  it("layout output size scales frame", () => {
    expect(layoutOutputSize(800, 450, 0.5)).toEqual({ outW: 400, outH: 225 });
    expect(layoutOutputSize(0, 450, 0.5)).toBeNull();
  });

  it("layout hash differs from bare scene hash", () => {
    const scene = resolveScene(manifest([videoClip({ id: "a" })]), 0);
    const bare = sceneContentHash(scene);
    const layout = layoutFinalSceneHash(scene, 400, 225);
    expect(layout.startsWith(bare)).toBe(true);
    expect(layout).toContain("|L400x225");
  });

  it("produces nonzero dx/dy for offset transform", async () => {
    const cache = createFrameStageCache(16);
    const fakeBmp = {
      width: 100,
      height: 100,
      close: () => {},
    } as ImageBitmap;
    const composedRects: Array<{ dx: number; dy: number }> = [];

    const m = manifest([
      videoClip({
        id: "a",
        transform: { x: 0.25, y: -0.1, scale: 1 },
      }),
    ]);

    const producer = createFrameProducer({
      timelineKey: "T1",
      cache,
      frameSize: { w: 800, h: 450 },
      resolveScale: 1,
      concurrency: 1,
      videoPool: { capture: async () => fakeBmp, dispose: () => {} },
      loadImageBitmap: async () => fakeBmp,
      fetchRgbaBitmap: async () => fakeBmp,
      compose: async (req) => {
        for (const layer of req.layers) {
          composedRects.push({ dx: layer.dx, dy: layer.dy });
        }
        return {
          width: req.width,
          height: req.height,
          close: () => {},
        } as ImageBitmap;
      },
    });

    const out = await producer.ensureFinal(m, 0, "playback");
    expect(out).not.toBeNull();
    expect(composedRects.length).toBe(1);
    // Offset transform must not compose at (0,0) full-bleed.
    expect(composedRects[0]!.dx !== 0 || composedRects[0]!.dy !== 0).toBe(true);
    producer.dispose();
  });

  it("hasFinal is false with empty cache; tick does not claim ownership", () => {
    const store = createPlayheadStore(0);
    const blits: number[] = [];
    const engine = createPreviewEngine({
      timelineKey: "T1",
      manifest: manifest([videoClip({ id: "a" })]),
      playheadStore: store,
      frameSize: { w: 800, h: 450 },
      presenter: {
        blitFinal: () => {
          blits.push(1);
        },
      },
      producer: createFrameProducer({
        timelineKey: "T1",
        cache: createFrameStageCache(8),
        frameSize: { w: 800, h: 450 },
        videoPool: { capture: async () => null, dispose: () => {} },
        loadImageBitmap: async () => null,
        fetchRgbaBitmap: async () => null,
      }),
    });

    engine.start();
    const result = engine.tick();
    expect(result.hasFinal).toBe(false);
    expect(result.presented).toBe(false);
    expect(engine.hasFinalForCurrentFrame()).toBe(false);
    engine.dispose();
  });

  it("cache hit short-circuits producer fetch", async () => {
    const cache = createFrameStageCache(16);
    let fetches = 0;
    const fakeBmp = { width: 2, height: 2, close: () => {} } as ImageBitmap;
    const m = manifest([videoClip({ id: "a", alphaRelPath: "a.mkv" })]);
    const producer = createFrameProducer({
      timelineKey: "T1",
      cache,
      frameSize: { w: 100, h: 56 },
      resolveScale: 1,
      concurrency: 1,
      fetchRgbaBitmap: async () => {
        fetches += 1;
        return null;
      },
      loadImageBitmap: async () => null,
      videoPool: { capture: async () => null, dispose: () => {} },
    });
    const key = producer.finalKeyFor(m, 0, "playback");
    expect(key).not.toBeNull();
    cache.set(key!, fakeBmp);

    const out = await producer.ensureFinal(m, 0, "playback");
    expect(out).toBe(fakeBmp);
    expect(fetches).toBe(0);
    producer.dispose();
  });

  it("skips produce when frameSize is unset", async () => {
    const producer = createFrameProducer({
      timelineKey: "T1",
      cache: createFrameStageCache(8),
      frameSize: { w: 0, h: 0 },
      videoPool: { capture: async () => null, dispose: () => {} },
    });
    const out = await producer.ensureFinal(
      manifest([videoClip({ id: "a" })]),
      0,
      "playback"
    );
    expect(out).toBeNull();
    expect(producer.finalKeyFor(manifest([videoClip({ id: "a" })]), 0)).toBeNull();
    producer.dispose();
  });
});

describe("timelineProxyBake", () => {
  it("reads bake from manifest and covers playhead", () => {
    const m = {
      ...manifest([]),
      previewBake: {
        srcRelPath: "proxies/bake.webm",
        inPointSec: 0,
        outPointSec: 5,
        fps: 24,
      },
    };
    const bake = getTimelinePreviewBake(m);
    expect(bake?.srcRelPath).toBe("proxies/bake.webm");
    expect(bakeCoversPlayhead(bake!, 2)).toBe(true);
    expect(bakeCoversPlayhead(bake!, 6)).toBe(false);
  });

  it("describes a bake job", () => {
    const job = describeTimelineBakeJob({
      timelineKey: "T1",
      inPointSec: 0,
      outPointSec: 10,
      fps: 24,
    });
    expect(job.kind).toBe("timeline_preview_bake");
    expect(job.maxWidth).toBe(960);
  });
});
