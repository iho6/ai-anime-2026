"use client";

import React, { useEffect, useRef } from "react";
import type { TimelineClip } from "../../lib/api";
import { apiTimelineClipRgbaFrameUrl, assetUrlFromRelPath } from "../../lib/api";
import { applyColoringToImageData } from "../../lib/clipColoring";

const DEFAULT_PREVIEW_FPS = 24;
const SCRUB_DEBOUNCE_MS = 80;

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
  const lastFetchedFrameRef = useRef<number | null>(null);
  const fetchGenRef = useRef(0);
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceTimeRef = useRef(sourceTimeSec);
  sourceTimeRef.current = sourceTimeSec;

  const src = assetUrlFromRelPath(clip.srcRelPath);
  const hasAlphaVideo = Boolean(clip.alphaRelPath?.trim());
  const fps = Math.max(1, previewFps || DEFAULT_PREVIEW_FPS);

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

  function paintRgbaImage(img: HTMLImageElement) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    ctx?.drawImage(img, 0, 0);
  }

  function fetchRgbaFrame(sourceTime: number, frameIdx: number) {
    if (lastFetchedFrameRef.current === frameIdx) return;
    lastFetchedFrameRef.current = frameIdx;
    const gen = ++fetchGenRef.current;
    const rounded = Math.round(sourceTime * 1000) / 1000;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (gen !== fetchGenRef.current) return;
      paintRgbaImage(img);
    };
    img.onerror = () => {
      /* keep previous frame */
    };
    img.src = `${apiTimelineClipRgbaFrameUrl(timelineKey, clip.id, rounded)}&_=${rounded}`;
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

  // Non-alpha video: draw from hidden <video> each RAF (coloring applied client-side).
  useEffect(() => {
    if (clip.type !== "video" || hasAlphaVideo) return;
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
  }, [clip.type, hasAlphaVideo, clip.coloring, clip.id, src]);

  // Alpha video: hidden color <video> for sync/play; fetch composited RGBA at video frame rate.
  useEffect(() => {
    if (clip.type !== "video" || !hasAlphaVideo) return;

    if (playing) {
      if (scrubTimerRef.current != null) {
        clearTimeout(scrubTimerRef.current);
        scrubTimerRef.current = null;
      }
      const tick = () => {
        const video = videoRef.current;
        const t =
          video && video.readyState >= 2
            ? video.currentTime
            : sourceTimeRef.current;
        const frameIdx = Math.max(0, Math.round(t * fps));
        fetchRgbaFrame(t, frameIdx);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      return () => {
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      };
    }

    // Paused / scrubbing: debounce fetches to avoid request storms.
    // First paint (no frame yet) is immediate.
    const delayMs = lastFetchedFrameRef.current == null ? 0 : SCRUB_DEBOUNCE_MS;
    if (scrubTimerRef.current != null) clearTimeout(scrubTimerRef.current);
    scrubTimerRef.current = setTimeout(() => {
      scrubTimerRef.current = null;
      const t = sourceTimeRef.current;
      const frameIdx = Math.max(0, Math.round(t * fps));
      fetchRgbaFrame(t, frameIdx);
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
    playing,
    timelineKey,
    clip.id,
    fps,
    clip.coloring,
    // When paused, re-run debounce when scrub time changes.
    playing ? 0 : sourceTimeSec,
  ]);

  // Invalidate frame cache when coloring / clip identity changes so we refetch.
  useEffect(() => {
    lastFetchedFrameRef.current = null;
  }, [clip.coloring, clip.id, timelineKey]);

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
