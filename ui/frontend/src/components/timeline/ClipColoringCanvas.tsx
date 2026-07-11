"use client";

import React, { useEffect, useRef } from "react";
import type { TimelineClip } from "../../lib/api";
import { apiTimelineClipRgbaFrameUrl, assetUrlFromRelPath } from "../../lib/api";
import { applyColoringToImageData } from "../../lib/clipColoring";
import {
  frameIdxFromSourceTime,
  planAlphaFrameFetch,
  planAlphaFrameFetchAfterComplete,
  planAlphaFrameFetchAfterError,
  resetAlphaFrameFetchState,
  type AlphaFrameFetchState,
} from "./alphaFrameFetch";
import { timelineStripPreviewRelPath } from "./timelineStripPreview";

const DEFAULT_PREVIEW_FPS = 24;
const SCRUB_DEBOUNCE_MS = 80;
const FETCH_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 250;

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
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alphaFetchRef = useRef<AlphaFrameFetchState>(resetAlphaFrameFetchState());
  const hasPaintedRef = useRef(false);
  const requestEpochRef = useRef(0);
  const latestSourceTimeRef = useRef(sourceTimeSec);
  const sourceTimeRef = useRef(sourceTimeSec);
  sourceTimeRef.current = sourceTimeSec;
  latestSourceTimeRef.current = sourceTimeSec;

  const src = assetUrlFromRelPath(clip.srcRelPath);
  const hasAlphaVideo = Boolean(clip.alphaRelPath?.trim());
  const fps = Math.max(1, previewFps || DEFAULT_PREVIEW_FPS);
  const stripRelPath = timelineStripPreviewRelPath(clip, sourceTimeSec, fps);

  function paintFromSource(source: CanvasImageSource, w: number, h: number) {
    const canvas = canvasRef.current;
    if (!canvas || w < 1 || h < 1) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    applyColoringToImageData(imageData, clip.coloring);
    ctx.putImageData(imageData, 0, 0);
  }

  function paintRgbaImage(img: HTMLImageElement): boolean {
    const canvas = canvasRef.current;
    if (!canvas || img.naturalWidth < 1 || img.naturalHeight < 1) return false;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    hasPaintedRef.current = true;
    return true;
  }

  function startAlphaFrameFetch(frameIdx: number, sourceTime: number) {
    const epoch = requestEpochRef.current;
    const rounded = Math.round(sourceTime * 1000) / 1000;
    const img = new Image();
    let settled = false;
    const finishError = () => {
      if (settled || epoch !== requestEpochRef.current) return;
      settled = true;
      clearTimeout(timeout);
      alphaFetchRef.current = planAlphaFrameFetchAfterError(alphaFetchRef.current);
      if (retryTimerRef.current != null) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        scheduleAlphaFrameFetch(latestSourceTimeRef.current, !hasPaintedRef.current);
      }, RETRY_DELAY_MS);
    };
    const timeout = setTimeout(finishError, FETCH_TIMEOUT_MS);
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (settled || epoch !== requestEpochRef.current) return;
      settled = true;
      clearTimeout(timeout);
      if (!paintRgbaImage(img)) {
        alphaFetchRef.current = planAlphaFrameFetchAfterError(alphaFetchRef.current);
        return;
      }
      const after = planAlphaFrameFetchAfterComplete(alphaFetchRef.current, frameIdx);
      alphaFetchRef.current = after.state;
      if (after.plan.action === "fetch") {
        startAlphaFrameFetch(after.plan.frameIdx, latestSourceTimeRef.current);
      }
    };
    img.onerror = finishError;
    img.src = `${apiTimelineClipRgbaFrameUrl(timelineKey, clip.id, rounded)}&_=${rounded}`;
  }

  function scheduleAlphaFrameFetch(sourceTime: number, force = false) {
    latestSourceTimeRef.current = sourceTime;
    const frameIdx = frameIdxFromSourceTime(sourceTime, fps);
    const planned = planAlphaFrameFetch(alphaFetchRef.current, frameIdx, {
      force,
    });
    alphaFetchRef.current = planned.state;
    if (planned.plan.action === "fetch") {
      startAlphaFrameFetch(planned.plan.frameIdx, sourceTime);
    }
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

  // Edited clips preview the same frameSequence PNGs used by frame edit and export.
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

  // Non-alpha video: draw from hidden <video> each RAF (coloring applied client-side).
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

  // Reset request state before the scheduler effect runs for a new clip/coloring.
  useEffect(() => {
    requestEpochRef.current += 1;
    alphaFetchRef.current = resetAlphaFrameFetchState();
    hasPaintedRef.current = false;
    if (retryTimerRef.current != null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, [clip.coloring, clip.id, timelineKey]);

  // Alpha video: hidden color <video> for sync/play; fetch composited RGBA at video frame rate.
  useEffect(() => {
    if (clip.type !== "video" || !hasAlphaVideo || stripRelPath) return;

    if (playing) {
      if (scrubTimerRef.current != null) {
        clearTimeout(scrubTimerRef.current);
        scrubTimerRef.current = null;
      }
      const tick = () => {
        scheduleAlphaFrameFetch(sourceTimeRef.current, !hasPaintedRef.current);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => {
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      };
    }

    // Paused / scrubbing: debounce fetches to avoid request storms.
    const delayMs =
      alphaFetchRef.current.lastPaintedFrame == null ? 0 : SCRUB_DEBOUNCE_MS;
    if (scrubTimerRef.current != null) clearTimeout(scrubTimerRef.current);
    scrubTimerRef.current = setTimeout(() => {
      scrubTimerRef.current = null;
      scheduleAlphaFrameFetch(sourceTimeRef.current, !hasPaintedRef.current);
    }, delayMs);

    return () => {
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
    timelineKey,
    clip.id,
    fps,
    clip.coloring,
    playing ? 0 : sourceTimeSec,
  ]);

  useEffect(
    () => () => {
      requestEpochRef.current += 1;
      if (retryTimerRef.current != null) clearTimeout(retryTimerRef.current);
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
