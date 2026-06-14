"use client";

import React, { useRef, useState } from "react";
import type { TimelineClip } from "../../lib/api";
import {
  defaultVolumeAutomationPoints,
  type VolumeAutomationPoint,
} from "./volumeAutomation";
import { clamp } from "./timelineUtil";

const LINE_HIT_DIST = 12;

function levelToY(level: number, h: number): number {
  return (1 - level / 100) * h;
}

function yToLevel(sy: number, h: number): number {
  return clamp((1 - sy / Math.max(h, 1)) * 100, 0, 100);
}

function representativeLevel(points: VolumeAutomationPoint[]): number {
  if (points.length === 0) return 50;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const first = sorted[0].level;
  const last = sorted[sorted.length - 1].level;
  return (first + last) / 2;
}

export function VolumeAutomationEditor(props: {
  clip: TimelineClip;
  clipWidthPx: number;
  clipHeightPx: number;
  points: VolumeAutomationPoint[];
  onPointsChange: (points: VolumeAutomationPoint[]) => void;
  onSeek?: (timelineSec: number) => void;
  onClear?: () => void;
}) {
  const { clip, clipWidthPx, clipHeightPx, points, onPointsChange, onSeek, onClear } =
    props;
  const w = Math.max(6, clipWidthPx);
  const h = Math.max(20, clipHeightPx);
  const level = representativeLevel(points);
  const lineY = levelToY(level, h);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const dragRef = useRef(false);

  function getSvgPos(e: React.PointerEvent): { sx: number; sy: number } {
    const el = svgRef.current;
    if (!el) return { sx: 0, sy: 0 };
    const rect = el.getBoundingClientRect();
    return {
      sx: ((e.clientX - rect.left) / rect.width) * w,
      sy: ((e.clientY - rect.top) / rect.height) * h,
    };
  }

  function emitLevel(newLevel: number) {
    const clamped = clamp(newLevel, 0, 100);
    onPointsChange([
      { t: 0, level: clamped },
      { t: 1, level: clamped },
    ]);
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as SVGElement).setPointerCapture?.(e.pointerId);
    setCtxMenu(null);

    const { sx, sy } = getSvgPos(e);
    if (Math.abs(sy - lineY) > LINE_HIT_DIST) return;

    dragRef.current = true;
    onSeek?.(clip.start + (sx / Math.max(w, 1)) * clip.duration);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!dragRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const { sy } = getSvgPos(e);
    emitLevel(yToLevel(sy, h));
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!dragRef.current) return;
    (e.target as SVGElement).releasePointerCapture?.(e.pointerId);
    dragRef.current = false;
  }

  function onContextMenu(e: React.MouseEvent<SVGSVGElement>) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }

  const unityY = levelToY(50, h);

  return (
    <>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        style={{
          display: "block",
          background: "rgba(0,0,0,0.35)",
          cursor: "ns-resize",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={onContextMenu}
      >
        <line
          x1={0}
          y1={unityY}
          x2={w}
          y2={unityY}
          stroke="rgba(255,255,255,0.2)"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <line
          x1={0}
          y1={lineY}
          x2={w}
          y2={lineY}
          stroke="transparent"
          strokeWidth={16}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={0}
          y1={lineY}
          x2={w}
          y2={lineY}
          stroke="#7ec8ff"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {ctxMenu ? (
        <div
          style={{
            position: "fixed",
            top: ctxMenu.y,
            left: ctxMenu.x,
            background: "#1e1e1e",
            border: "1px solid rgba(255,255,255,0.25)",
            zIndex: 10200,
            minWidth: 140,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setCtxMenu(null);
              onClear?.();
              onPointsChange(defaultVolumeAutomationPoints());
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 12px",
              background: "transparent",
              color: "#eee",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            Clear automation
          </button>
        </div>
      ) : null}
    </>
  );
}
