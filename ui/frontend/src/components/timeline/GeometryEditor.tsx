"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeometryPoint, TimelineClip, TimelineGeometry } from "../../lib/api";
import {
  bendSegment,
  bboxAnchorForHandle,
  bboxHandlePosition,
  bboxHandlePositionOffset,
  distToSegment,
  geometryPathBounds,
  geometryToSvgPath,
  localFromScreen,
  localHitRadius,
  pointInBounds,
  scaleGeometryPoints,
  segmentControlOrigin,
  splitSegmentAtClick,
  translateGeometryPoints,
  type BboxHandleId,
  type GeometryBounds,
} from "./geometryPath";
import { VECTOR_ARTBOARD_SIZE } from "./geometryTemplates";
import { GeometryPickerModals } from "./GeometryPickerModals";
import { GeometryStyleBar, type GeometryStyleModal } from "./GeometryStyleBar";
import { clipImageRect, type ClipTransform } from "./timelineUtil";

type Props = {
  clip: TimelineClip;
  frameW: number;
  frameH: number;
  transform: ClipTransform;
  onGeometryChange: (geometry: TimelineGeometry) => void;
  onCommit?: () => void;
  onExit?: () => void;
  onStyleModalChange?: (open: boolean) => void;
  onGeometryContextMenu?: (clipId: string, clientX: number, clientY: number) => void;
};

const ARTBOARD = VECTOR_ARTBOARD_SIZE;
const BBOX_HANDLE_IDS: BboxHandleId[] = ["nw", "n", "ne", "w", "e", "sw", "s", "se"];

const CHROME_STROKE = "#fff";
const CHROME_FILL = "#000";
const CHROME_MUTED = "rgba(255,255,255,0.5)";
const CHROME_MUTED_STRONG = "rgba(255,255,255,0.6)";
const CHROME_ANCHOR_IDLE = "rgba(255,255,255,0.45)";

const HIT_POINT_PX = 12;
const HIT_HANDLE_PX = 12;
const HIT_BBOX_PX = 14;
const HIT_SEG_PX = 8;
const HANDLE_HALF = 7;
const HANDLE_OFFSET_PX = 6;

type DragState =
  | { kind: "point"; index: number }
  | { kind: "handleIn"; index: number }
  | { kind: "handleOut"; index: number }
  | {
      kind: "segment";
      segIndex: number;
      hitT: number;
      startLocal: { x: number; y: number };
      cpOrig: { x: number; y: number };
      origGeometry: TimelineGeometry;
    }
  | {
      kind: "bbox";
      handle: BboxHandleId;
      anchor: { x: number; y: number };
      handleStart: { x: number; y: number };
      origBounds: GeometryBounds;
      origGeometry: TimelineGeometry;
      fixedAspect: boolean;
    }
  | {
      kind: "moveAll";
      startLocal: { x: number; y: number };
      origGeometry: TimelineGeometry;
    };

function cloneGeometry(geometry: TimelineGeometry): TimelineGeometry {
  return {
    ...geometry,
    points: geometry.points.map((p) => ({
      ...p,
      handleIn: p.handleIn ? { ...p.handleIn } : undefined,
      handleOut: p.handleOut ? { ...p.handleOut } : undefined,
    })),
  };
}

function isCornerHandle(handle: BboxHandleId): boolean {
  return handle === "nw" || handle === "ne" || handle === "sw" || handle === "se";
}

function cursorForHandle(handle: BboxHandleId): string {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "w":
    case "e":
      return "ew-resize";
  }
}

export function GeometryEditor(props: Props) {
  const {
    clip,
    frameW,
    frameH,
    transform,
    onGeometryChange,
    onCommit,
    onExit,
    onStyleModalChange,
    onGeometryContextMenu,
  } = props;
  const geom = clip.geometry;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [activeSeg, setActiveSeg] = useState<number | null>(null);
  const [styleModal, setStyleModal] = useState<GeometryStyleModal>(null);

  const rect = clipImageRect(clip, transform, frameW, frameH);
  const bounds = useMemo(
    () => (geom ? geometryPathBounds(geom, 0.002, { width: rect.width, height: rect.height }) : null),
    [geom, rect.width, rect.height]
  );

  const hit = useMemo(
    () => ({
      point: localHitRadius(HIT_POINT_PX, rect),
      handle: localHitRadius(HIT_HANDLE_PX, rect),
      bbox: localHitRadius(HIT_BBOX_PX, rect),
      seg: localHitRadius(HIT_SEG_PX, rect),
      handleOffset: localHitRadius(HANDLE_OFFSET_PX, rect),
    }),
    [rect.width, rect.height]
  );

  useEffect(() => {
    onStyleModalChange?.(styleModal != null);
  }, [styleModal, onStyleModalChange]);

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
        if (styleModal) {
          setStyleModal(null);
          return;
        }
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
  }, [selectedIndex, geom, onGeometryChange, onCommit, onExit, styleModal]);

  if (!geom || !bounds || frameW < 1 || frameH < 1) return null;

  function clientToLocal(clientX: number, clientY: number) {
    return localFromScreen(clientX, clientY, rect.left, rect.top, rect.width, rect.height, false);
  }

  function hitBboxHandle(loc: { x: number; y: number }): BboxHandleId | null {
    for (const handle of BBOX_HANDLE_IDS) {
      const p = bboxHandlePositionOffset(bounds!, handle, hit.handleOffset);
      if (Math.hypot(loc.x - p.x, loc.y - p.y) <= hit.bbox) return handle;
    }
    return null;
  }

  function onSvgPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);

    const loc = clientToLocal(e.clientX, e.clientY);

    const bboxHandle = hitBboxHandle(loc);
    if (bboxHandle) {
      const anchor = bboxAnchorForHandle(bounds!, bboxHandle);
      const handleStart = bboxHandlePosition(bounds!, bboxHandle);
      dragRef.current = {
        kind: "bbox",
        handle: bboxHandle,
        anchor,
        handleStart,
        origBounds: { ...bounds! },
        origGeometry: cloneGeometry(geom!),
        fixedAspect: e.shiftKey && isCornerHandle(bboxHandle),
      };
      return;
    }

    for (let i = 0; i < geom!.points.length; i++) {
      const pt = geom!.points[i];
      if (pt.handleIn && Math.hypot(loc.x - pt.handleIn.x, loc.y - pt.handleIn.y) <= hit.handle) {
        dragRef.current = { kind: "handleIn", index: i };
        setSelectedIndex(i);
        return;
      }
      if (pt.handleOut && Math.hypot(loc.x - pt.handleOut.x, loc.y - pt.handleOut.y) <= hit.handle) {
        dragRef.current = { kind: "handleOut", index: i };
        setSelectedIndex(i);
        return;
      }
      if (Math.hypot(loc.x - pt.x, loc.y - pt.y) <= hit.point) {
        dragRef.current = { kind: "point", index: i };
        setSelectedIndex(i);
        return;
      }
    }

    const segHit = distToSegment(loc.x, loc.y, geom!, hit.seg);
    if (segHit) {
      const a = geom!.points[segHit.segIndex];
      const b = geom!.points[(segHit.segIndex + 1) % geom!.points.length];
      dragRef.current = {
        kind: "segment",
        segIndex: segHit.segIndex,
        hitT: segHit.t,
        startLocal: loc,
        cpOrig: segmentControlOrigin(a, b),
        origGeometry: cloneGeometry(geom!),
      };
      setActiveSeg(segHit.segIndex);
      return;
    }

    if (pointInBounds(loc.x, loc.y, bounds!)) {
      dragRef.current = {
        kind: "moveAll",
        startLocal: loc,
        origGeometry: cloneGeometry(geom!),
      };
      return;
    }

    setSelectedIndex(null);
  }

  function onSvgPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();
    const loc = clientToLocal(e.clientX, e.clientY);

    if (d.kind === "point") {
      updatePoint(d.index, { x: loc.x, y: loc.y });
    } else if (d.kind === "handleIn") {
      updatePoint(d.index, { handleIn: { x: loc.x, y: loc.y } });
    } else if (d.kind === "handleOut") {
      updatePoint(d.index, { handleOut: { x: loc.x, y: loc.y } });
    } else if (d.kind === "segment") {
      const mid = {
        x: d.cpOrig.x + (loc.x - d.startLocal.x),
        y: d.cpOrig.y + (loc.y - d.startLocal.y),
      };
      onGeometryChange(bendSegment(d.origGeometry, d.segIndex, mid));
    } else if (d.kind === "moveAll") {
      const dx = loc.x - d.startLocal.x;
      const dy = loc.y - d.startLocal.y;
      onGeometryChange(translateGeometryPoints(d.origGeometry, dx, dy));
    } else if (d.kind === "bbox") {
      let scaleX = 1;
      let scaleY = 1;
      const { anchor, handleStart, origBounds, origGeometry, handle } = d;

      if (isCornerHandle(handle)) {
        const denomX = handleStart.x - anchor.x;
        const denomY = handleStart.y - anchor.y;
        scaleX = Math.abs(denomX) > 1e-6 ? (loc.x - anchor.x) / denomX : 1;
        scaleY = Math.abs(denomY) > 1e-6 ? (loc.y - anchor.y) / denomY : 1;
        if (d.fixedAspect || e.shiftKey) {
          const aspect =
            (origBounds.maxX - origBounds.minX) / Math.max(origBounds.maxY - origBounds.minY, 1e-6);
          if (Math.abs(loc.x - anchor.x) / aspect >= Math.abs(loc.y - anchor.y)) {
            scaleY = scaleX;
          } else {
            scaleX = scaleY;
          }
        }
      } else if (handle === "n" || handle === "s") {
        const denomY = handleStart.y - anchor.y;
        scaleY = Math.abs(denomY) > 1e-6 ? (loc.y - anchor.y) / denomY : 1;
      } else {
        const denomX = handleStart.x - anchor.x;
        scaleX = Math.abs(denomX) > 1e-6 ? (loc.x - anchor.x) / denomX : 1;
      }

      scaleX = Math.max(0.02, scaleX);
      scaleY = Math.max(0.02, scaleY);
      onGeometryChange(scaleGeometryPoints(origGeometry, anchor, scaleX, scaleY));
    }
  }

  function onSvgPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    const d = dragRef.current;
    if (!d) return;
    (e.currentTarget as SVGElement).releasePointerCapture?.(e.pointerId);

    if (d.kind === "segment" && geom) {
      const loc = clientToLocal(e.clientX, e.clientY);
      const movedPx = Math.hypot(
        (loc.x - d.startLocal.x) * rect.width,
        (loc.y - d.startLocal.y) * rect.height
      );
      if (movedPx < 4) {
        const segHit = distToSegment(loc.x, loc.y, geom, hit.seg);
        const t = segHit?.segIndex === d.segIndex ? segHit.t : d.hitT;
        const { geometry: next, insertIndex } = splitSegmentAtClick(geom, d.segIndex, t);
        onGeometryChange(next);
        setSelectedIndex(insertIndex);
      }
    }

    dragRef.current = null;
    setActiveSeg(null);
    onCommit?.();
  }

  function onSvgContextMenu(e: React.MouseEvent<SVGSVGElement>) {
    e.preventDefault();
    e.stopPropagation();
    onGeometryContextMenu?.(clip.id, e.clientX, e.clientY);
  }

  const pathD = geometryToSvgPath(geom);
  const bx = bounds.minX * ARTBOARD;
  const by = bounds.minY * ARTBOARD;
  const bw = (bounds.maxX - bounds.minX) * ARTBOARD;
  const bh = (bounds.maxY - bounds.minY) * ARTBOARD;
  const styleBarRect = {
    left: rect.left + bounds.minX * rect.width,
    top: rect.top + bounds.minY * rect.height,
    width: Math.max(1, (bounds.maxX - bounds.minX) * rect.width),
    height: Math.max(1, (bounds.maxY - bounds.minY) * rect.height),
  };

  return (
    <>
      <GeometryStyleBar geometry={geom} rect={styleBarRect} onOpenModal={setStyleModal} />
      {styleModal ? (
        <GeometryPickerModals
          open={styleModal}
          geometry={geom}
          onClose={() => {
            setStyleModal(null);
            onCommit?.();
          }}
          onChange={(patch) => onGeometryChange({ ...geom, ...patch })}
        />
      ) : null}
      <svg
        ref={svgRef}
        data-geometry-editor
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
        viewBox={`0 0 ${ARTBOARD} ${ARTBOARD}`}
        preserveAspectRatio="none"
        onPointerDown={onSvgPointerDown}
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onContextMenu={onSvgContextMenu}
      >
        {/* 1. Bbox fill — no pointer capture */}
        <rect
          x={bx}
          y={by}
          width={bw}
          height={bh}
          fill="rgba(255,255,255,0.03)"
          stroke={CHROME_STROKE}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
          style={{ cursor: "move", pointerEvents: "none" }}
        />

        {/* 2. Path hit area */}
        <path
          d={pathD}
          fill="none"
          stroke="transparent"
          strokeWidth={20}
          style={{ cursor: "pointer", pointerEvents: "stroke" }}
        />

        {/* 3. Path dash outline */}
        <path
          d={pathD}
          fill="none"
          stroke={CHROME_STROKE}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: "none" }}
        />

        {/* 4. Active segment guides */}
        {activeSeg !== null && (() => {
          const a = geom.points[activeSeg];
          const b = geom.points[(activeSeg + 1) % geom.points.length];
          const mid = segmentControlOrigin(a, b);
          const ax = a.x * ARTBOARD;
          const ay = a.y * ARTBOARD;
          const bx2 = b.x * ARTBOARD;
          const by2 = b.y * ARTBOARD;
          const mx = mid.x * ARTBOARD;
          const my = mid.y * ARTBOARD;
          return (
            <g style={{ pointerEvents: "none" }}>
              <line x1={ax} y1={ay} x2={mx} y2={my} stroke={CHROME_MUTED_STRONG} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <line x1={bx2} y1={by2} x2={mx} y2={my} stroke={CHROME_MUTED_STRONG} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <circle cx={mx} cy={my} r={5} fill={CHROME_STROKE} stroke={CHROME_FILL} strokeWidth={1} />
            </g>
          );
        })()}

        {/* 5. Anchor points + bezier handles */}
        {geom.points.map((pt, i) => {
          const sx = pt.x * ARTBOARD;
          const sy = pt.y * ARTBOARD;
          const sel = selectedIndex === i;
          return (
            <g key={i} style={{ pointerEvents: "none" }}>
              {pt.handleIn ? (
                <>
                  <line
                    x1={sx}
                    y1={sy}
                    x2={pt.handleIn.x * ARTBOARD}
                    y2={pt.handleIn.y * ARTBOARD}
                    stroke={CHROME_MUTED}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={pt.handleIn.x * ARTBOARD}
                    cy={pt.handleIn.y * ARTBOARD}
                    r={5}
                    fill={CHROME_STROKE}
                    stroke={CHROME_FILL}
                    strokeWidth={1}
                  />
                </>
              ) : null}
              {pt.handleOut ? (
                <>
                  <line
                    x1={sx}
                    y1={sy}
                    x2={pt.handleOut.x * ARTBOARD}
                    y2={pt.handleOut.y * ARTBOARD}
                    stroke={CHROME_MUTED}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    cx={pt.handleOut.x * ARTBOARD}
                    cy={pt.handleOut.y * ARTBOARD}
                    r={5}
                    fill={CHROME_STROKE}
                    stroke={CHROME_FILL}
                    strokeWidth={1}
                  />
                </>
              ) : null}
              <circle
                cx={sx}
                cy={sy}
                r={sel ? 8 : 6}
                fill={sel ? CHROME_STROKE : CHROME_ANCHOR_IDLE}
                stroke={CHROME_FILL}
                strokeWidth={1}
              />
            </g>
          );
        })}

        {/* 6. Bbox resize handles — on top */}
        {BBOX_HANDLE_IDS.map((handle) => {
          const p = bboxHandlePositionOffset(bounds, handle, hit.handleOffset);
          const cx = p.x * ARTBOARD;
          const cy = p.y * ARTBOARD;
          return (
            <rect
              key={handle}
              x={cx - HANDLE_HALF}
              y={cy - HANDLE_HALF}
              width={HANDLE_HALF * 2}
              height={HANDLE_HALF * 2}
              fill={CHROME_FILL}
              stroke={CHROME_STROKE}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              style={{ cursor: cursorForHandle(handle) }}
            />
          );
        })}
      </svg>
    </>
  );
}
