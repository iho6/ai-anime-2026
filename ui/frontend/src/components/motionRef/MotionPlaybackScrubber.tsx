"use client";

import React, { useCallback, useRef, useState } from "react";
import type { CameraKeyframe } from "../../lib/api";
import { CameraIcon } from "../IconPrimitives";

type Props = {
  totalFrames: number;
  frameIndex: number;
  playbackStart: number;
  playbackEnd: number;
  cameraKeyframes: CameraKeyframe[];
  disabled?: boolean;
  onFrameChange: (frame: number) => void;
  onRangeChange: (start: number, end: number) => void;
  onCameraKeyframeClick: (kf: CameraKeyframe) => void;
  onCameraKeyframeContextMenu: (kf: CameraKeyframe, x: number, y: number) => void;
};

function frameToPct(frame: number, maxFrame: number): number {
  if (maxFrame <= 0) return 0;
  return (frame / maxFrame) * 100;
}

function CameraKeyframeMarker(props: {
  kf: CameraKeyframe;
  leftPct: number;
  disabled: boolean;
  onClick: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { kf, leftPct, disabled, onClick, onContextMenu } = props;
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const color = pressed ? "#888" : hovered ? "#6eb5ff" : "#fff";
  const bg = pressed ? "rgba(0,0,0,0.55)" : hovered ? "rgba(110,181,255,0.18)" : "rgba(0,0,0,0.35)";
  const border = pressed
    ? "rgba(255,255,255,0.25)"
    : hovered
      ? "#6eb5ff"
      : "rgba(255,255,255,0.55)";
  const scale = hovered && !pressed ? 1.12 : 1;

  const hold = kf.holdFrames != null && kf.holdFrames > 0 ? kf.holdFrames : 0;
  const title =
    hold > 0
      ? `Camera f${kf.frameIndex} · hold ${hold}f`
      : `Camera f${kf.frameIndex}`;

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        setPressed(true);
      }}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      style={{
        position: "absolute",
        left: `calc(${leftPct}% - 9px)`,
        top: 0,
        width: 18,
        height: 18,
        padding: 0,
        border: `1px solid ${border}`,
        background: bg,
        color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        zIndex: 4,
        boxSizing: "border-box",
        transform: `scale(${scale})`,
        transition: "transform 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease",
      }}
    >
      <CameraIcon size={11} />
    </button>
  );
}

const TRACK_STYLE: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  height: 12,
  border: "1px solid rgba(255,255,255,0.35)",
  background: "rgba(0,0,0,0.35)",
  boxSizing: "border-box",
};

const HANDLE_STYLE: React.CSSProperties = {
  position: "absolute",
  bottom: -1,
  width: 8,
  height: 14,
  background: "#fff",
  border: "1px solid rgba(0,0,0,0.55)",
  boxSizing: "border-box",
  zIndex: 3,
};

export function MotionPlaybackScrubber(props: Props) {
  const {
    totalFrames,
    frameIndex,
    playbackStart,
    playbackEnd,
    cameraKeyframes,
    disabled = false,
    onFrameChange,
    onRangeChange,
    onCameraKeyframeClick,
    onCameraKeyframeContextMenu,
  } = props;

  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<"in" | "out" | "playhead" | null>(null);

  const maxFrame = Math.max(0, totalFrames - 1);
  const startPct = frameToPct(playbackStart, maxFrame);
  const endPct = frameToPct(playbackEnd, maxFrame);
  const playPct = frameToPct(frameIndex, maxFrame);
  const trimWidthPct = Math.max(0, endPct - startPct);

  const frameFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || maxFrame <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(t * maxFrame);
    },
    [maxFrame]
  );

  const clampPlayheadFrame = useCallback(
    (f: number) => Math.min(Math.max(playbackStart, f), playbackEnd),
    [playbackStart, playbackEnd]
  );

  const startPlayheadDrag = useCallback(
    (e: React.PointerEvent) => {
      if (disabled || totalFrames === 0 || e.button !== 0) return;
      e.preventDefault();
      dragRef.current = "playhead";
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      onFrameChange(clampPlayheadFrame(frameFromClientX(e.clientX)));
    },
    [clampPlayheadFrame, disabled, frameFromClientX, onFrameChange, totalFrames]
  );

  const onPointerDownHandle = (
    e: React.PointerEvent,
    kind: "in" | "out"
  ) => {
    if (disabled || totalFrames === 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = kind;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const kind = dragRef.current;
    if (!kind) return;
    const f = frameFromClientX(e.clientX);
    if (kind === "playhead") {
      onFrameChange(clampPlayheadFrame(f));
      return;
    }
    if (kind === "in") {
      const nextStart = Math.min(f, playbackEnd - 1);
      onRangeChange(Math.max(0, nextStart), playbackEnd);
      return;
    }
    const nextEnd = Math.max(f, playbackStart + 1);
    onRangeChange(playbackStart, Math.min(maxFrame, nextEnd));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  if (totalFrames <= 0) {
    return (
      <div style={{ flex: 1, minWidth: 120, height: 28, opacity: 0.4 }}>
        <div style={{ ...TRACK_STYLE, position: "relative", marginTop: 16 }} />
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        minWidth: 120,
        height: 28,
        touchAction: "none",
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {totalFrames > 1 &&
        cameraKeyframes.map((kf) => {
          const pct = frameToPct(kf.frameIndex, maxFrame);
          return (
            <CameraKeyframeMarker
              key={kf.id}
              kf={kf}
              leftPct={pct}
              disabled={disabled}
              onClick={() => onCameraKeyframeClick(kf)}
              onContextMenu={(x, y) => onCameraKeyframeContextMenu(kf, x, y)}
            />
          );
        })}

      <div
        ref={trackRef}
        style={{ ...TRACK_STYLE, cursor: disabled ? "not-allowed" : "pointer" }}
        onPointerDown={startPlayheadDrag}
      >
        {/* Dimmed outside trim */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${startPct}%`,
            background: "rgba(0,0,0,0.5)",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `${endPct}%`,
            top: 0,
            bottom: 0,
            right: 0,
            background: "rgba(0,0,0,0.5)",
            pointerEvents: "none",
          }}
        />

        {/* Active trim fill */}
        <div
          style={{
            position: "absolute",
            left: `${startPct}%`,
            width: `${trimWidthPct}%`,
            top: 0,
            bottom: 0,
            background: "rgba(255,255,255,0.55)",
            pointerEvents: "none",
          }}
        />

        {/* Playhead */}
        <div
          role="slider"
          aria-label="Playhead"
          onPointerDown={(e) => {
            e.stopPropagation();
            startPlayheadDrag(e);
          }}
          style={{
            position: "absolute",
            left: `calc(${playPct}% - 3px)`,
            top: -2,
            width: 6,
            height: 16,
            background: "#fff",
            border: "1px solid rgba(0,0,0,0.6)",
            boxSizing: "border-box",
            cursor: disabled ? "not-allowed" : "grab",
            zIndex: 5,
          }}
        />
      </div>

      {/* In handle */}
      <div
        role="slider"
        aria-label="Trim in"
        onPointerDown={(e) => onPointerDownHandle(e, "in")}
        style={{
          ...HANDLE_STYLE,
          left: `calc(${startPct}% - 4px)`,
          cursor: disabled ? "not-allowed" : "ew-resize",
        }}
      />

      {/* Out handle */}
      <div
        role="slider"
        aria-label="Trim out"
        onPointerDown={(e) => onPointerDownHandle(e, "out")}
        style={{
          ...HANDLE_STYLE,
          left: `calc(${endPct}% - 4px)`,
          cursor: disabled ? "not-allowed" : "ew-resize",
        }}
      />
    </div>
  );
}
