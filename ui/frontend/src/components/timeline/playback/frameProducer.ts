/**
 * Produce layout-correct FINAL ImageBitmaps for the PreviewEngine cache.
 * Composes into full preview frame using clipImageRect transforms.
 * Layer decode prefers DOM capture, then proxy RGB/alpha, then HTTP rgba.
 */

import { apiTimelineClipRgbaFrameUrl, assetUrlFromRelPath } from "../../../lib/api";
import type { TimelineManifest } from "../../../lib/api";
import { frameIdxFromSourceTime } from "../alphaFrameFetch";
import { timelineEffectiveStripPreviewRelPath } from "../timelineStripPreview";
import {
  clipImageRect,
  clipTransformAtPlayhead,
} from "../timelineUtil";
import {
  presentComposedFrame,
  type CompositorLayerDraw,
  type CompositorRequest,
} from "./compositorPresenter";
import { createFairPrefetchQueue, type FairPrefetchQueue } from "./fairPrefetchQueue";
import {
  createFrameStageCache,
  planPrefetch,
  type FrameStageCache,
} from "./frameStageCache";
import { applyLumaMatteToContext } from "./lumaMatte";
import { resolvePreviewMedia, type PreviewAlphaKind } from "./mediaProvider";
import {
  resolveScene,
  sceneContentHash,
  type ResolvedScene,
  type SceneLayer,
} from "./resolveScene";
import { createVideoDecodePool, type VideoDecodePool } from "./videoDecodePool";

export type FrameSize = { w: number; h: number };

export type FrameProducerOptions = {
  timelineKey: string;
  cache: FrameStageCache;
  resolveScale?: number;
  concurrency?: number;
  /** Preview frame CSS pixels; produce is a no-op until both > 0. */
  frameSize?: FrameSize;
  /** Optional compose override (worker path). */
  compose?: (req: CompositorRequest) => Promise<ImageBitmap | null>;
  /**
   * Prefer bitmaps from already-synced DOM media (zero seek).
   * Return video/canvas if readyState>=2 / painted.
   */
  captureDomLayer?: (
    clipId: string
  ) => CanvasImageSource | HTMLVideoElement | null | undefined;
  loadImageBitmap?: (url: string) => Promise<ImageBitmap | null>;
  fetchRgbaBitmap?: (
    timelineKey: string,
    clipId: string,
    sourceTimeSec: number,
    frameIdx: number
  ) => Promise<ImageBitmap | null>;
  videoPool?: VideoDecodePool;
};

export type FrameProducer = {
  ensureFinal: (
    manifest: TimelineManifest,
    frame: number,
    quality?: "playback" | "paused"
  ) => Promise<ImageBitmap | null>;
  schedulePrefetch: (
    manifest: TimelineManifest,
    playheadFrame: number,
    ahead?: number,
    behind?: number
  ) => void;
  setFrameSize: (size: FrameSize) => void;
  setResolveScale: (scale: number) => void;
  setCaptureDomLayer: (
    fn: FrameProducerOptions["captureDomLayer"] | null
  ) => void;
  /** Layout-valid FINAL key for look-ups (includes outW×outH). */
  finalKeyFor: (
    manifest: TimelineManifest,
    frame: number,
    quality?: "playback" | "paused"
  ) => { stage: "final"; quality: "playback" | "paused"; frame: number; sceneHash: string } | null;
  clearQueue: () => void;
  dispose: () => void;
  queue: FairPrefetchQueue;
};

/** Scene hash + layout size so pre-fix unscaled FINALs never match. */
export function layoutFinalSceneHash(
  scene: ResolvedScene,
  outW: number,
  outH: number
): string {
  return `${sceneContentHash(scene)}|L${outW}x${outH}`;
}

export function layoutOutputSize(
  frameW: number,
  frameH: number,
  resolveScale: number
): { outW: number; outH: number } | null {
  if (frameW < 1 || frameH < 1) return null;
  const s = Math.max(0.25, Math.min(1, resolveScale));
  return {
    outW: Math.max(1, Math.round(frameW * s)),
    outH: Math.max(1, Math.round(frameH * s)),
  };
}

async function defaultLoadImageBitmap(url: string): Promise<ImageBitmap | null> {
  if (!url || typeof createImageBitmap !== "function") return null;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

async function defaultFetchRgbaBitmap(
  timelineKey: string,
  clipId: string,
  sourceTimeSec: number,
  frameIdx: number
): Promise<ImageBitmap | null> {
  const rounded = Math.round(sourceTimeSec * 1000) / 1000;
  const url = `${apiTimelineClipRgbaFrameUrl(timelineKey, clipId, rounded)}&fi=${frameIdx}`;
  return defaultLoadImageBitmap(url);
}

export async function compositeRgbAlpha(
  rgb: ImageBitmap,
  alpha: ImageBitmap,
  alphaKind: PreviewAlphaKind = "alphaChannel"
): Promise<ImageBitmap | null> {
  if (typeof OffscreenCanvas === "undefined") return rgb;
  const w = rgb.width;
  const h = rgb.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", {
    willReadFrequently: alphaKind === "luma",
  });
  if (!ctx) return null;
  ctx.drawImage(rgb, 0, 0, w, h);
  if (alphaKind === "luma") {
    if (!applyLumaMatteToContext(ctx, alpha, w, h)) return null;
  } else {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(alpha, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }
  try {
    rgb.close();
  } catch {
    /* ignore */
  }
  try {
    alpha.close();
  } catch {
    /* ignore */
  }
  return createImageBitmap(canvas);
}

async function mainThreadCompose(req: CompositorRequest): Promise<ImageBitmap | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(req.width, req.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.clearRect(0, 0, req.width, req.height);
    for (const layer of req.layers) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      ctx.drawImage(layer.bitmap, layer.dx, layer.dy, layer.dw, layer.dh);
      ctx.restore();
    }
    return createImageBitmap(canvas);
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  presentComposedFrame(canvas, req);
  return createImageBitmap(canvas);
}

function visibleMediaLayers(scene: ResolvedScene): SceneLayer[] {
  return scene.layers.filter((l) => {
    if (l.preload) return false;
    if (l.opacity < 0.01) return false;
    const t = l.clip.type;
    return t === "video" || t === "image";
  });
}

async function bitmapFromDomSource(
  source: CanvasImageSource | HTMLVideoElement
): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    if (source instanceof HTMLVideoElement) {
      if (source.readyState < 2 || source.videoWidth < 1) return null;
      return await createImageBitmap(source);
    }
    return await createImageBitmap(source as CanvasImageSource);
  } catch {
    return null;
  }
}

export function createFrameProducer(options: FrameProducerOptions): FrameProducer {
  let resolveScale = options.resolveScale ?? 0.5;
  let frameSize: FrameSize = options.frameSize ?? { w: 0, h: 0 };
  let captureDom = options.captureDomLayer ?? null;
  const queue = createFairPrefetchQueue(options.concurrency ?? 2);
  const ownedPool = options.videoPool ?? createVideoDecodePool(6);
  const loadImage = options.loadImageBitmap ?? defaultLoadImageBitmap;
  const fetchRgba = options.fetchRgbaBitmap ?? defaultFetchRgbaBitmap;
  const compose = options.compose ?? mainThreadCompose;
  const inFlightFinal = new Map<string, Promise<ImageBitmap | null>>();
  const scheduledFinal = new Set<string>();
  let lastPrefetchFrame = -1;

  const buildKey = (
    scene: ResolvedScene,
    quality: "playback" | "paused"
  ) => {
    const out = layoutOutputSize(frameSize.w, frameSize.h, resolveScale);
    if (!out) return null;
    return {
      stage: "final" as const,
      quality,
      frame: scene.frame,
      sceneHash: layoutFinalSceneHash(scene, out.outW, out.outH),
      outW: out.outW,
      outH: out.outH,
    };
  };

  const produceLayer = async (
    layer: SceneLayer,
    fps: number
  ): Promise<ImageBitmap | null> => {
    const clip = layer.clip;

    // Prefer already-synced DOM media (no seek).
    if (captureDom) {
      const el = captureDom(clip.id);
      if (el) {
        const fromDom = await bitmapFromDomSource(el);
        if (fromDom) return fromDom;
      }
    }

    if (clip.type === "image") {
      return loadImage(assetUrlFromRelPath(clip.srcRelPath));
    }
    if (clip.type !== "video") return null;

    const strip = timelineEffectiveStripPreviewRelPath(clip, layer.sourceTimeSec, fps);
    if (strip) {
      return loadImage(assetUrlFromRelPath(strip));
    }

    const media = resolvePreviewMedia(clip);
    const hasAlpha = Boolean(clip.alphaRelPath?.trim());

    if (hasAlpha) {
      if (media.alphaUrl) {
        const [rgb, alpha] = await Promise.all([
          ownedPool.capture(media.rgbUrl, layer.sourceTimeSec),
          ownedPool.capture(media.alphaUrl, layer.sourceTimeSec),
        ]);
        if (rgb && alpha) return compositeRgbAlpha(rgb, alpha, media.alphaKind);
        if (rgb) {
          try {
            alpha?.close();
          } catch {
            /* ignore */
          }
          return rgb;
        }
      }
      const frameIdx = frameIdxFromSourceTime(layer.sourceTimeSec, fps);
      return fetchRgba(options.timelineKey, clip.id, layer.sourceTimeSec, frameIdx);
    }

    return ownedPool.capture(media.rgbUrl, layer.sourceTimeSec);
  };

  const produceFinal = async (
    manifest: TimelineManifest,
    frame: number,
    quality: "playback" | "paused"
  ): Promise<ImageBitmap | null> => {
    const out = layoutOutputSize(frameSize.w, frameSize.h, resolveScale);
    if (!out) return null;

    const scene = resolveScene(manifest, frame);
    const keyParts = buildKey(scene, quality);
    if (!keyParts) return null;
    const key = {
      stage: keyParts.stage,
      quality: keyParts.quality,
      frame: keyParts.frame,
      sceneHash: keyParts.sceneHash,
    };
    const hit = options.cache.get(key);
    if (hit) return hit;

    const inflightKey = `${quality}|${frame}|${keyParts.sceneHash}`;
    const existing = inFlightFinal.get(inflightKey);
    if (existing) return existing;

    const work = (async () => {
      const layers = visibleMediaLayers(scene);
      if (layers.length === 0) return null;

      const settled = await Promise.all(
        layers.map(async (layer) => {
          const bmp = await produceLayer(layer, scene.fps);
          return bmp ? ({ layer, bmp } as const) : null;
        })
      );
      const bitmaps = settled.filter(
        (x): x is { layer: SceneLayer; bmp: ImageBitmap } => x != null
      );
      if (bitmaps.length === 0) return null;

      const order = new Map(layers.map((l, i) => [l.clip.id, i]));
      bitmaps.sort(
        (a, b) => (order.get(a.layer.clip.id) ?? 0) - (order.get(b.layer.clip.id) ?? 0)
      );

      const scale = Math.max(0.25, Math.min(1, resolveScale));
      const drawLayers: CompositorLayerDraw[] = bitmaps.map(({ layer, bmp }) => {
        const tf = clipTransformAtPlayhead(layer.clip, scene.timeSec);
        const rect = clipImageRect(layer.clip, tf, frameSize.w, frameSize.h);
        return {
          bitmap: bmp,
          opacity: layer.opacity,
          dx: Math.round(rect.left * scale),
          dy: Math.round(rect.top * scale),
          dw: Math.max(1, Math.round(rect.width * scale)),
          dh: Math.max(1, Math.round(rect.height * scale)),
        };
      });

      const composed = await compose({
        width: keyParts.outW,
        height: keyParts.outH,
        layers: drawLayers,
      });

      for (const { bmp } of bitmaps) {
        try {
          bmp.close();
        } catch {
          /* may be transferred */
        }
      }

      if (composed) {
        options.cache.set(key, composed);
      }
      return composed;
    })();

    inFlightFinal.set(inflightKey, work);
    try {
      return await work;
    } finally {
      inFlightFinal.delete(inflightKey);
    }
  };

  return {
    ensureFinal: (manifest, frame, quality = "playback") =>
      produceFinal(manifest, frame, quality),
    schedulePrefetch: (manifest, playheadFrame, ahead = 24, behind = 4) => {
      if (frameSize.w < 1 || frameSize.h < 1) return;
      // Large seeks: drop stale queue work.
      if (
        lastPrefetchFrame >= 0 &&
        Math.abs(playheadFrame - lastPrefetchFrame) > 8
      ) {
        queue.clear();
        scheduledFinal.clear();
      }
      lastPrefetchFrame = playheadFrame;

      const plan = planPrefetch(playheadFrame, ahead, behind);
      for (const f of plan.frames) {
        const scene = resolveScene(manifest, f);
        const keyParts = buildKey(scene, "playback");
        if (!keyParts) continue;
        const cacheKey = {
          stage: keyParts.stage,
          quality: keyParts.quality,
          frame: keyParts.frame,
          sceneHash: keyParts.sceneHash,
        };
        if (options.cache.has(cacheKey)) continue;
        const sk = `playback|${f}|${keyParts.sceneHash}`;
        if (scheduledFinal.has(sk) || inFlightFinal.has(sk)) continue;
        scheduledFinal.add(sk);
        const dist = Math.abs(f - playheadFrame);
        // Current frame = priority 0; ahead frames are lower priority (higher number).
        const priority = f === playheadFrame ? 0 : dist + 1;
        const media = visibleMediaLayers(scene);
        const fairnessKey =
          media.length > 0
            ? media[Math.abs(f) % media.length]!.clip.id
            : `frame:${f}`;
        void queue
          .enqueue({
            key: fairnessKey,
            priority,
            run: () => produceFinal(manifest, f, "playback"),
          })
          .catch(() => {
            /* cleared */
          })
          .finally(() => {
            scheduledFinal.delete(sk);
          });
      }
    },
    setFrameSize: (size) => {
      frameSize = { w: size.w, h: size.h };
    },
    setResolveScale: (scale) => {
      resolveScale = scale;
    },
    setCaptureDomLayer: (fn) => {
      captureDom = fn ?? null;
    },
    finalKeyFor: (manifest, frame, quality = "playback") => {
      const scene = resolveScene(manifest, frame);
      const keyParts = buildKey(scene, quality);
      if (!keyParts) return null;
      return {
        stage: keyParts.stage,
        quality: keyParts.quality,
        frame: keyParts.frame,
        sceneHash: keyParts.sceneHash,
      };
    },
    clearQueue: () => {
      queue.clear();
      scheduledFinal.clear();
    },
    dispose: () => {
      queue.clear();
      scheduledFinal.clear();
      ownedPool.dispose();
    },
    queue,
  };
}

export function createProducerTestCache(max = 96): FrameStageCache {
  return createFrameStageCache(max);
}
