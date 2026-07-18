"use client";

import React, { useEffect, useRef } from "react";
import type { TimelineClip } from "../../lib/api";
import { apiTimelineClipRgbaFrameUrl, assetUrlFromRelPath, previewSrcRelPath } from "../../lib/api";
import { applyColoringToImageData } from "../../lib/clipColoring";
import { frameIdxFromSourceTime } from "./alphaFrameFetch";
import {
  clampSourceTime,
  createAlphaFrameCache,
  estimateFrameCount,
  frameIndicesForClip,
  prefetchFrames,
  shouldBulkPreload,
  sourceTimeFromFrameIdx,
  type AlphaFrameCache,
} from "./alphaFrameCache";
import { clipPreviewHoldStep, holdQuantizeFrameIndex } from "./previewHoldFrame";
import { timelineEffectiveStripPreviewRelPath } from "./timelineStripPreview";

const DEFAULT_PREVIEW_FPS = 24;
const SCRUB_DEBOUNCE_MS = 80;
const FETCH_TIMEOUT_MS = 5000;
const PREFETCH_AHEAD = 4;
const PREFETCH_BEHIND = 1;

type VideoFrameRequestCallbackMetadata = {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
};

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (
      now: DOMHighResTimeStamp,
      metadata: VideoFrameRequestCallbackMetadata
    ) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function ClipColoringCanvas(props: {
  clip: TimelineClip;
  timelineKey: string;
  sourceTimeSec: number;
  playing?: boolean;
  previewFps?: number;
  style: React.CSSProperties;
  setVideoRef?: (el: HTMLVideoElement | null) => void;
}) {
  const {
    clip,
    timelineKey,
    sourceTimeSec,
    playing = false,
    previewFps = DEFAULT_PREVIEW_FPS,
    style,
    setVideoRef,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const rvfcHandleRef = useRef<number | null>(null);
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheRef = useRef<AlphaFrameCache>(createAlphaFrameCache());
  const inFlightRef = useRef<Set<number>>(new Set());
  const hasPaintedRef = useRef(false);
  const requestEpochRef = useRef(0);
  const lastPaintedFrameIdxRef = useRef<number | null>(null);
  const sourceTimeRef = useRef(sourceTimeSec);
  sourceTimeRef.current = sourceTimeSec;

  const src = assetUrlFromRelPath(previewSrcRelPath(clip));
  const hasAlphaVideo = Boolean(clip.alphaRelPath?.trim());
  const fps = Math.max(1, previewFps || DEFAULT_PREVIEW_FPS);
  const holdStep = clipPreviewHoldStep(clip);
  // Opaque RGB strips must not win over alpha.mkv mats (black reads as solid).
  const stripRelPath = timelineEffectiveStripPreviewRelPath(clip, sourceTimeSec, fps);
  const maxFrameIdx = Math.max(0, estimateFrameCount(clip, fps) - 1);

  function paintFromSource(source: CanvasImageSource, w: number, h: number) {
    const canvas = canvasRef.current;
    if (!canvas || w < 1 || h < 1) return;
    // Compose offscreen first so the visible canvas is never cleared to empty
    // while a hard-cut preload / coloring pass is in flight.
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const offCtx = off.getContext("2d", { willReadFrequently: true });
    if (!offCtx) return;
    offCtx.drawImage(source, 0, 0, w, h);
    const imageData = offCtx.getImageData(0, 0, w, h);
    applyColoringToImageData(imageData, clip.coloring);
    offCtx.putImageData(imageData, 0, 0);

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Replace buffer so transparent RMBG/alpha frames don't stack on prior pixels.
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(off, 0, 0);
    hasPaintedRef.current = true;
  }

  function paintRgbaImage(img: HTMLImageElement): boolean {
    const canvas = canvasRef.current;
    if (!canvas || img.naturalWidth < 1 || img.naturalHeight < 1) return false;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    // Draw to an offscreen canvas first so resizing the display canvas never
    // leaves a cleared blank frame on screen.
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const offCtx = off.getContext("2d");
    if (!offCtx) return false;
    offCtx.drawImage(img, 0, 0);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    // Replace buffer so transparent RMBG/alpha frames don't stack on prior pixels.
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(off, 0, 0);
    hasPaintedRef.current = true;
    return true;
  }

  function loadRgbaFrameOnce(
    url: string,
    epoch: number
  ): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const finish = (result: HTMLImageElement | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => finish(null), FETCH_TIMEOUT_MS);
      img.crossOrigin = "anonymous";
      img.onload = () => {
        finish(epoch === requestEpochRef.current ? img : null);
      };
      img.onerror = () => finish(null);
      img.src = url;
    });
  }

  async function fetchAlphaFrameImage(
    frameIdx: number,
    epoch: number
  ): Promise<HTMLImageElement | null> {
    if (epoch !== requestEpochRef.current) return null;
    const sourceTime = clampSourceTime(
      sourceTimeFromFrameIdx(frameIdx, fps),
      clip
    );
    const rounded = Math.round(sourceTime * 1000) / 1000;
    const baseUrl = `${apiTimelineClipRgbaFrameUrl(timelineKey, clip.id, rounded)}&fi=${frameIdx}`;

    const first = await loadRgbaFrameOnce(baseUrl, epoch);
    if (first || epoch !== requestEpochRef.current) return first;

    // A transient server error (e.g. a decoder-cache reset) can 500 a single
    // frame; retry once with a cache-buster before giving up so the canvas
    // doesn't stay blank.
    return loadRgbaFrameOnce(`${baseUrl}&retry=${Date.now()}`, epoch);
  }

  function paintFrameFromCache(frameIdx: number): boolean {
    const cached = cacheRef.current.get(frameIdx);
    if (!cached) return false;
    lastPaintedFrameIdxRef.current = frameIdx;
    return paintRgbaImage(cached);
  }

  async function ensureFrameAvailable(
    frameIdx: number,
    epoch: number,
    paint: boolean
  ): Promise<void> {
    if (epoch !== requestEpochRef.current) return;
    if (cacheRef.current.has(frameIdx)) {
      if (paint) paintFrameFromCache(frameIdx);
      return;
    }
    if (inFlightRef.current.has(frameIdx)) return;
    inFlightRef.current.add(frameIdx);
    try {
      const img = await fetchAlphaFrameImage(frameIdx, epoch);
      if (!img || epoch !== requestEpochRef.current) return;
      cacheRef.current.set(frameIdx, img);
      if (paint) {
        lastPaintedFrameIdxRef.current = frameIdx;
        paintRgbaImage(img);
      }
    } finally {
      inFlightRef.current.delete(frameIdx);
    }
  }

  function prefetchAhead(fromFrameIdx: number, epoch: number) {
    // Prefetch a window around the playhead so both playback (ahead) and small
    // scrub jitter (behind) stay warm.
    for (let offset = -PREFETCH_BEHIND; offset <= PREFETCH_AHEAD; offset++) {
      if (offset === 0) continue;
      const idx = fromFrameIdx + offset;
      if (idx < 0 || idx > maxFrameIdx) continue;
      if (cacheRef.current.has(idx) || inFlightRef.current.has(idx)) continue;
      void ensureFrameAvailable(idx, epoch, false);
    }
  }

  function handleAlphaFrameAtTime(sourceTime: number, epoch: number, prefetch: boolean) {
    const t = clampSourceTime(sourceTime, clip);
    const frameIdx = Math.min(
      maxFrameIdx,
      holdQuantizeFrameIndex(frameIdxFromSourceTime(t, fps), holdStep)
    );
    if (frameIdx === lastPaintedFrameIdxRef.current && cacheRef.current.has(frameIdx)) {
      return;
    }
    if (paintFrameFromCache(frameIdx)) {
      if (prefetch) prefetchAhead(frameIdx, epoch);
      return;
    }
    void ensureFrameAvailable(frameIdx, epoch, true).then(() => {
      if (prefetch && epoch === requestEpochRef.current) {
        prefetchAhead(frameIdx, epoch);
      }
    });
  }

  useEffect(() => {
    if (clip.type !== "image") return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      paintFromSource(img, img.naturalWidth, img.naturalHeight);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [clip.type, src, clip.coloring, clip.id]);

  useEffect(() => {
    if (clip.type !== "video" || !stripRelPath) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      paintFromSource(img, img.naturalWidth, img.naturalHeight);
      hasPaintedRef.current = true;
    };
    img.src = assetUrlFromRelPath(stripRelPath);
    return () => {
      cancelled = true;
    };
  }, [clip.type, stripRelPath, clip.coloring, clip.id]);

  useEffect(() => {
    if (clip.type !== "video" || hasAlphaVideo || stripRelPath) return;
    const video = videoRef.current;
    if (!video) return;

    const draw = () => {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        paintFromSource(video, video.videoWidth, video.videoHeight);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [clip.type, hasAlphaVideo, stripRelPath, clip.coloring, clip.id, src]);

  useEffect(() => {
    if (clip.type !== "video" || !hasAlphaVideo || stripRelPath) return;

    requestEpochRef.current += 1;
    const epoch = requestEpochRef.current;
    cacheRef.current = createAlphaFrameCache();
    inFlightRef.current.clear();
    // Keep whatever is already on the canvas until the next frame paints —
    // resetting hasPainted / clearing pixels causes a black blink at hard cuts.
    lastPaintedFrameIdxRef.current = null;

    if (shouldBulkPreload(clip, fps)) {
      void prefetchFrames(frameIndicesForClip(clip, fps), (idx) => fetchAlphaFrameImage(idx, epoch), {
        cache: cacheRef.current,
        shouldAbort: () => epoch !== requestEpochRef.current,
      });
    }
  }, [clip.type, hasAlphaVideo, stripRelPath, clip.id, timelineKey, clip.coloring, fps, clip.inPoint, clip.outPoint, clip.srcDuration, holdStep]);

  useEffect(() => {
    if (clip.type !== "video" || !hasAlphaVideo || stripRelPath) return;
    const video = videoRef.current as VideoWithFrameCallback | null;
    if (!video) return;

    const epoch = requestEpochRef.current;

    const stopRvfc = () => {
      if (rvfcHandleRef.current != null && video.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(rvfcHandleRef.current);
        rvfcHandleRef.current = null;
      }
    };

    // Hold-step preview is playhead-driven (every-other-frame), not free-running decode.
    if (playing && holdStep < 2) {
      if (scrubTimerRef.current != null) {
        clearTimeout(scrubTimerRef.current);
        scrubTimerRef.current = null;
      }

      const onVideoFrame = () => {
        if (epoch !== requestEpochRef.current) return;
        handleAlphaFrameAtTime(video.currentTime, epoch, true);
        if (video.requestVideoFrameCallback) {
          rvfcHandleRef.current = video.requestVideoFrameCallback(onVideoFrame);
        }
      };

      const onTimeUpdate = () => {
        if (epoch !== requestEpochRef.current) return;
        handleAlphaFrameAtTime(video.currentTime, epoch, true);
      };

      if (video.requestVideoFrameCallback) {
        rvfcHandleRef.current = video.requestVideoFrameCallback(onVideoFrame);
      } else {
        video.addEventListener("timeupdate", onTimeUpdate);
      }

      return () => {
        stopRvfc();
        video.removeEventListener("timeupdate", onTimeUpdate);
      };
    }

    const delayMs = hasPaintedRef.current && holdStep < 2 ? SCRUB_DEBOUNCE_MS : 0;
    if (scrubTimerRef.current != null) clearTimeout(scrubTimerRef.current);
    scrubTimerRef.current = setTimeout(() => {
      scrubTimerRef.current = null;
      handleAlphaFrameAtTime(sourceTimeRef.current, epoch, true);
    }, delayMs);

    return () => {
      stopRvfc();
      if (scrubTimerRef.current != null) {
        clearTimeout(scrubTimerRef.current);
        scrubTimerRef.current = null;
      }
    };
  }, [
    clip.type,
    hasAlphaVideo,
    stripRelPath,
    playing,
    clip.id,
    fps,
    maxFrameIdx,
    holdStep,
    playing ? 0 : sourceTimeSec,
    holdStep > 1 ? sourceTimeSec : 0,
  ]);

  useEffect(
    () => () => {
      requestEpochRef.current += 1;
    },
    []
  );

  return (
    <>
      {clip.type === "video" ? (
        <video
          ref={(el) => {
            videoRef.current = el;
            setVideoRef?.(el);
          }}
          src={src}
          muted
          playsInline
          style={{ display: "none", pointerEvents: "none" }}
        />
      ) : null}
      <canvas
        ref={canvasRef}
        style={{
          ...style,
          display: "block",
        }}
      />
    </>
  );
}
