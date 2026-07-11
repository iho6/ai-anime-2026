"use client";

import React, { useEffect, useRef } from "react";
import type { TimelineClip } from "../../lib/api";
import { apiTimelineClipRgbaFrameUrl, assetUrlFromRelPath } from "../../lib/api";
import { applyColoringToImageData } from "../../lib/clipColoring";

export function ClipColoringCanvas(props: {
  clip: TimelineClip;
  timelineKey: string;
  sourceTimeSec: number;
  style: React.CSSProperties;
  setVideoRef?: (el: HTMLVideoElement | null) => void;
}) {
  const { clip, timelineKey, sourceTimeSec, style, setVideoRef } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const src = assetUrlFromRelPath(clip.srcRelPath);
  const hasAlphaVideo = Boolean(clip.alphaRelPath?.trim());

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

  useEffect(() => {
    if (clip.type !== "video" || !hasAlphaVideo) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      ctx?.drawImage(img, 0, 0);
    };
    img.onerror = () => {
      /* keep previous frame */
    };
    const rounded = Math.round(sourceTimeSec * 1000) / 1000;
    img.src = `${apiTimelineClipRgbaFrameUrl(timelineKey, clip.id, rounded)}&_=${rounded}`;
    return () => {
      cancelled = true;
    };
  }, [
    clip.type,
    hasAlphaVideo,
    timelineKey,
    clip.id,
    sourceTimeSec,
    clip.coloring,
  ]);

  return (
    <>
      {clip.type === "video" && !hasAlphaVideo ? (
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
