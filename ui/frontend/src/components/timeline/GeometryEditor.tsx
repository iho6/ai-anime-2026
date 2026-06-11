"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GeometryPoint, TimelineClip, TimelineGeometry } from "../../lib/api";
import { geometryToSvgPath } from "./geometryPath";
import { distToSegment, insertPointOnSegment, localFromScreen } from "./geometryPath";
import { VECTOR_ARTBOARD_SIZE } from "./geometryTemplates";
import { clipImageRect, type ClipTransform } from "./timelineUtil";

type Props = {
  clip: TimelineClip;
  frameW: number;
  frameH: number;
  transform: ClipTransform;
  onGeometryChange: (geometry: TimelineGeometry) => void;
  onCommit?: () => void;
  onExit?: () => void;
};

type DragState =
  | { kind: "point"; index: number }
  | { kind: "handleIn"; index: number }
  | { kind: "handleOut"; index: number };

export function GeometryEditor(props: Props) {
  const { clip, frameW, frameH, transform, onGeometryChange, onCommit, onExit } = props;
  const geom = clip.geometry;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const rect = clipImageRect(clip, transform, frameW, frameH);

  const updatePoint = useCallback(
    (index: number, patch: Partial<GeometryPoint>) => {
      if (!geom) return;
      const points = geom.points.map((p, i) => (i === index ? { ...p, ...patch } : p));
      onGeometryChange({ ...geom, points });
    },
    [geom, onGeometryChange]
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onExit?.();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIndex != null && geom) {
        if (geom.points.length <= 2) return;
        e.preventDefault();
        const points = geom.points.filter((_, i) => i !== selectedIndex);
        onGeometryChange({ ...geom, points });
        setSelectedIndex(null);
        onCommit?.();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIndex, geom, onGeometryChange, onCommit, onExit]);

  if (!geom || frameW < 1 || frameH < 1) return null;

  function clientToLocal(clientX: number, clientY: number) {
    return localFromScreen(clientX, clientY, rect.left, rect.top, rect.width, rect.height);
  }

  function onPointerDownPoint(e: React.PointerEvent, index: number) {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { kind: "point", index };
    setSelectedIndex(index);
  }

  function onPointerDownHandle(
    e: React.PointerEvent,
    index: number,
    kind: "handleIn" | "handleOut"
  ) {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { kind, index };
    setSelectedIndex(index);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || !geom) return;
    const loc = clientToLocal(e.clientX, e.clientY);
    const pt = geom.points[d.index];
    if (!pt) return;

    if (d.kind === "point") {
      updatePoint(d.index, { x: loc.x, y: loc.y });
    } else if (d.kind === "handleIn") {
      updatePoint(d.index, { handleIn: { x: loc.x, y: loc.y } });
    } else {
      updatePoint(d.index, { handleOut: { x: loc.x, y: loc.y } });
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (dragRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
      onCommit?.();
    }
  }

  function onPathClick(e: React.PointerEvent) {
    if (!geom || dragRef.current) return;
    const loc = clientToLocal(e.clientX, e.clientY);
    const hit = distToSegment(loc.x, loc.y, geom, 0.04);
    if (hit) {
      const next = insertPointOnSegment(geom, hit.segIndex, hit.t);
      onGeometryChange(next);
      setSelectedIndex(hit.segIndex + 1);
      onCommit?.();
    }
  }

  const pathD = geometryToSvgPath(geom);

  return (
    <>
    <svg
      ref={svgRef}
      style={{
        position: "absolute",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        zIndex: 10001,
        overflow: "visible",
        pointerEvents: "auto",
      }}
      viewBox={`0 0 ${VECTOR_ARTBOARD_SIZE} ${VECTOR_ARTBOARD_SIZE}`}
      preserveAspectRatio="none"
    >
      <path
        d={pathD}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: "copy", pointerEvents: "stroke" }}
        onPointerDown={onPathClick}
      />
      <path
        d={pathD}
        fill="none"
        stroke="#5ad7ff"
        strokeWidth={2}
        strokeDasharray="4 4"
        vectorEffect="non-scaling-stroke"
        style={{ pointerEvents: "none" }}
      />
      {geom.points.map((pt, i) => {
        const sx = pt.x * VECTOR_ARTBOARD_SIZE;
        const sy = pt.y * VECTOR_ARTBOARD_SIZE;
        const sel = selectedIndex === i;
        return (
          <g key={i}>
            {pt.handleIn ? (
              <>
                <line
                  x1={sx}
                  y1={sy}
                  x2={pt.handleIn.x * VECTOR_ARTBOARD_SIZE}
                  y2={pt.handleIn.y * VECTOR_ARTBOARD_SIZE}
                  stroke="#888"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={pt.handleIn.x * VECTOR_ARTBOARD_SIZE}
                  cy={pt.handleIn.y * VECTOR_ARTBOARD_SIZE}
                  r={5}
                  fill="#aaa"
                  stroke="#000"
                  strokeWidth={1}
                  style={{ cursor: "grab" }}
                  onPointerDown={(e) => onPointerDownHandle(e, i, "handleIn")}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
              </>
            ) : null}
            {pt.handleOut ? (
              <>
                <line
                  x1={sx}
                  y1={sy}
                  x2={pt.handleOut.x * VECTOR_ARTBOARD_SIZE}
                  y2={pt.handleOut.y * VECTOR_ARTBOARD_SIZE}
                  stroke="#888"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={pt.handleOut.x * VECTOR_ARTBOARD_SIZE}
                  cy={pt.handleOut.y * VECTOR_ARTBOARD_SIZE}
                  r={5}
                  fill="#aaa"
                  stroke="#000"
                  strokeWidth={1}
                  style={{ cursor: "grab" }}
                  onPointerDown={(e) => onPointerDownHandle(e, i, "handleOut")}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
              </>
            ) : null}
            <circle
              cx={sx}
              cy={sy}
              r={sel ? 8 : 6}
              fill={sel ? "#ffd166" : "#5ad7ff"}
              stroke="#000"
              strokeWidth={1}
              style={{ cursor: "grab" }}
              onPointerDown={(e) => onPointerDownPoint(e, i)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          </g>
        );
      })}
    </svg>
    {geom.template === "rect" ? (
      <div
        style={{
          position: "absolute",
          left: rect.left,
          top: Math.max(0, rect.top - 28),
          zIndex: 10002,
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color: "#eee",
          pointerEvents: "auto",
          background: "rgba(0,0,0,0.7)",
          padding: "2px 6px",
          borderRadius: 3,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span>Corner</span>
        <input
          type="number"
          min={0}
          max={200}
          step={1}
          value={Math.round((geom.cornerRadius ?? 0) * 100)}
          onChange={(e) => {
            const v = Math.max(0, Math.min(200, Number(e.target.value) || 0)) / 100;
            onGeometryChange({ ...geom, cornerRadius: v });
          }}
          onBlur={() => onCommit?.()}
          style={{ width: 48, fontSize: 11 }}
        />
      </div>
    ) : null}
    </>
  );
}
