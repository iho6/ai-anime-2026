"use client";

import React, { useEffect, useRef, useState } from "react";
import { assetUrlFromRelPath } from "../lib/api";
import { PauseBarsIcon, TimelinePlayIcon } from "./IconPrimitives";

type Props = {
  frameRelPaths: string[];
  fps?: number;
  maxWidth?: number | string;
  maxHeight?: number | string;
};

export function PoseRefFramePreview(props: Props) {
  const { frameRelPaths, fps = 24, maxWidth = 140, maxHeight = 140 } = props;
  const paths = frameRelPaths.filter(Boolean);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setIdx(0);
    setPlaying(false);
  }, [paths.join("|")]);

  useEffect(() => {
    if (!playing || paths.length <= 1) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    const ms = Math.max(50, Math.round(1000 / Math.max(1, fps)));
    timerRef.current = setInterval(() => {
      setIdx((i) => (i + 1) % paths.length);
    }, ms);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [playing, paths.length, fps]);

  if (!paths.length) {
    return (
      <div
        style={{
          width: maxWidth,
          height: maxHeight,
          border: "1px solid rgba(0,0,0,0.35)",
          background: "rgba(0,0,0,0.02)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          opacity: 0.7,
        }}
      >
        No frames
      </div>
    );
  }

  const src = assetUrlFromRelPath(paths[idx] ?? paths[0]);
  const canPlay = paths.length > 1;

  return (
    <div
      style={{
        position: "relative",
        width: maxWidth,
        height: maxHeight,
        flexShrink: 0,
        border: "1px solid rgba(0,0,0,0.35)",
        overflow: "hidden",
        background: "#f3f3f3",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
          pointerEvents: "none",
        }}
        draggable={false}
      />
      {canPlay ? (
        <>
          {!playing ? (
            <button
              type="button"
              aria-label="Play frame preview"
              title="Play frame preview"
              onClick={(e) => {
                e.stopPropagation();
                setPlaying(true);
              }}
              style={{
                position: "absolute",
                inset: 0,
                margin: "auto",
                width: 36,
                height: 36,
                display: "grid",
                placeItems: "center",
                padding: 0,
                border: "none",
                borderRadius: 0,
                background: "rgba(120,120,120,0.35)",
                color: "rgba(255,255,255,0.9)",
                cursor: "pointer",
                zIndex: 2,
              }}
            >
              <TimelinePlayIcon size={18} />
            </button>
          ) : null}
          {playing && hover ? (
            <button
              type="button"
              aria-label="Pause frame preview"
              title="Pause"
              onClick={(e) => {
                e.stopPropagation();
                setPlaying(false);
              }}
              style={{
                position: "absolute",
                inset: 0,
                margin: "auto",
                width: 36,
                height: 36,
                display: "grid",
                placeItems: "center",
                padding: 0,
                border: "none",
                borderRadius: 0,
                background: "rgba(80,80,80,0.55)",
                color: "#fff",
                cursor: "pointer",
                zIndex: 2,
              }}
            >
              <PauseBarsIcon />
            </button>
          ) : null}
        </>
      ) : null}
      {paths.length > 1 ? (
        <span
          style={{
            position: "absolute",
            bottom: 4,
            right: 4,
            fontSize: 9,
            padding: "1px 4px",
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
            pointerEvents: "none",
          }}
        >
          {idx + 1}/{paths.length}
        </span>
      ) : null}
    </div>
  );
}
