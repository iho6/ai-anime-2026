/**
 * Hybrid PreviewEngine: background FINAL produce + present only when layout-ready.
 * DOM stack remains presentation truth until hasFinal(currentFrame).
 */

import type { TimelineManifest } from "../../../lib/api";
import type { PlayheadStore } from "../timelinePlayback";
import { createPlaybackClock, type PlaybackClock } from "./playbackClock";
import {
  createFrameProducer,
  type FrameProducer,
  type FrameSize,
} from "./frameProducer";
import {
  createFrameStageCache,
  type FrameStageCache,
} from "./frameStageCache";
import { previewQualityPolicy } from "./previewQuality";
import { resolveScene } from "./resolveScene";
import type { CompositorRequest } from "./compositorPresenter";

export type PreviewEnginePresenter = {
  blitFinal: (bitmap: ImageBitmap) => void;
  compose?: (req: CompositorRequest) => Promise<ImageBitmap | null>;
};

export type PreviewEngineOptions = {
  timelineKey: string;
  manifest: TimelineManifest;
  playheadStore: PlayheadStore;
  presenter: PreviewEnginePresenter;
  cache?: FrameStageCache;
  producer?: FrameProducer;
  frameSize?: FrameSize;
};

export type PreviewTickResult = {
  frame: number;
  /** True when a layout-correct FINAL was blitted this tick. */
  presented: boolean;
  hasFinal: boolean;
};

export type PreviewEngine = {
  /** Background produce + optional present; returns hit status for ownership. */
  tick: () => PreviewTickResult;
  start: () => void;
  stop: () => void;
  invalidate: () => void;
  setManifest: (next: TimelineManifest) => void;
  setFrameSize: (size: FrameSize) => void;
  /** True when layout FINAL exists for current playhead frame. */
  hasFinalForCurrentFrame: () => boolean;
  isActive: () => boolean;
  cache: FrameStageCache;
  producer: FrameProducer;
  clock: PlaybackClock;
  dispose: () => void;
};

export function blitImageBitmapToCanvas(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap
): void {
  if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
  if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
}

export function createPreviewEngine(options: PreviewEngineOptions): PreviewEngine {
  const cache = options.cache ?? createFrameStageCache(96);
  let manifest = options.manifest;
  const clock = createPlaybackClock(manifest.fps, options.playheadStore);
  let active = false;
  let disposed = false;

  const producer =
    options.producer ??
    createFrameProducer({
      timelineKey: options.timelineKey,
      cache,
      resolveScale: 0.5,
      concurrency: 2,
      frameSize: options.frameSize,
      compose: options.presenter.compose,
    });

  if (options.frameSize) {
    producer.setFrameSize(options.frameSize);
  }

  const hasFinal = (frame: number): boolean => {
    const key = producer.finalKeyFor(manifest, frame, "playback");
    if (!key) return false;
    return cache.has(key);
  };

  const tryPresent = (frame: number): boolean => {
    const key = producer.finalKeyFor(manifest, frame, "playback");
    if (!key) return false;
    const bmp = cache.get(key);
    if (!bmp) return false;
    options.presenter.blitFinal(bmp);
    return true;
  };

  return {
    tick: () => {
      const frame = clock.currentFrame();
      if (disposed || !active) {
        return { frame, presented: false, hasFinal: hasFinal(frame) };
      }
      const scene = resolveScene(manifest, frame);
      const policy = previewQualityPolicy(true, scene);
      producer.setResolveScale(policy.resolveScale);

      const hit = hasFinal(frame);
      const presented = hit ? tryPresent(frame) : false;

      // Background fill — never used as ownership without a hit.
      void producer.ensureFinal(manifest, frame, "playback").then((bmp) => {
        if (disposed || !active || !bmp) return;
        if (clock.currentFrame() === frame && hasFinal(frame)) {
          options.presenter.blitFinal(bmp);
        }
      });
      producer.schedulePrefetch(manifest, frame, 24, 4);
      cache.evictOutsideWindow(frame, 8, 32);

      return { frame, presented, hasFinal: hit };
    },
    start: () => {
      if (disposed) return;
      active = true;
      const frame = clock.currentFrame();
      tryPresent(frame);
      void producer.ensureFinal(manifest, frame, "playback");
      producer.schedulePrefetch(manifest, frame, 24, 4);
    },
    stop: () => {
      active = false;
      producer.clearQueue();
    },
    invalidate: () => {
      cache.clear();
      producer.clearQueue();
    },
    setManifest: (next) => {
      manifest = next;
    },
    setFrameSize: (size) => {
      producer.setFrameSize(size);
    },
    hasFinalForCurrentFrame: () => hasFinal(clock.currentFrame()),
    isActive: () => active,
    cache,
    producer,
    clock,
    dispose: () => {
      disposed = true;
      active = false;
      producer.dispose();
      cache.clear();
    },
  };
}
