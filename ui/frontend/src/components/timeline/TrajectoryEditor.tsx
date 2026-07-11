"use client";

import React, { useCallback, useRef, useState } from "react";
import { assetUrlFromRelPath, TimelineClip, TrajectoryMotionId } from "../../lib/api";
import { TRAJECTORY_MOTION_OPTIONS } from "./trajectoryMotion";

export type TrajectoryWaypoint = NonNullable<TimelineClip["trajectory"]>["waypoints"][number];

type Props = {
  clip: TimelineClip;
  frameW: number;
  frameH: number;
  playing: boolean;
  /** Called on every waypoint change (real-time, no undo checkpoint). */
  onWaypointsChange: (waypoints: TrajectoryWaypoint[]) => void;
  /** Called when dragging a waypoint — syncs playhead to that t value. */
  onPlayheadSync: (clipTime: number) => void;
  /** Called when the user requests to delete the entire trajectory. */
  onDeleteTrajectory?: () => void;
  onMotionChange?: (motion: TrajectoryMotionId, motionAmount: number) => void;
};

// ── Coordinate helpers ────────────────────────────────────────────────────────

function fracToSvg(x: number, y: number, fw: number, fh: number) {
  return { sx: fw / 2 + x * fw, sy: fh / 2 + y * fh };
}

function svgToFrac(sx: number, sy: number, fw: number, fh: number) {
  return { x: (sx - fw / 2) / fw, y: (sy - fh / 2) / fh };
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** Recompute t for a middle waypoint by projecting its position onto the start→end axis. */
function recomputeT(idx: number, wps: TrajectoryWaypoint[]): number {
  const start = wps[0], end = wps[wps.length - 1];
  const dx = end.x - start.x, dy = end.y - start.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return wps[idx].t;
  const wp = wps[idx];
  const proj = ((wp.x - start.x) * dx + (wp.y - start.y) * dy) / len2;
  const lo = idx > 0 ? wps[idx - 1].t : 0;
  const hi = idx < wps.length - 1 ? wps[idx + 1].t : 1;
  return clamp(proj, lo, hi);
}

/** Distance from point to a quadratic bezier curve (sampled). */
function distToBezier(
  px: number, py: number,
  ax: number, ay: number,
  cpx: number, cpy: number,
  bx: number, by: number,
  samples = 20
): number {
  let minD = Infinity;
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const x = (1 - s) * (1 - s) * ax + 2 * (1 - s) * s * cpx + s * s * bx;
    const y = (1 - s) * (1 - s) * ay + 2 * (1 - s) * s * cpy + s * s * by;
    minD = Math.min(minD, Math.hypot(px - x, py - y));
  }
  return minD;
}

/** Distance from point to a path segment (bezier or straight). */
function distToPathSeg(
  px: number, py: number,
  w1: TrajectoryWaypoint, w2: TrajectoryWaypoint,
  fw: number, fh: number
): number {
  const pa = fracToSvg(w1.x, w1.y, fw, fh);
  const pb = fracToSvg(w2.x, w2.y, fw, fh);
  if (w1.cpx != null && w1.cpy != null) {
    const cp = fracToSvg(w1.cpx, w1.cpy, fw, fh);
    return distToBezier(px, py, pa.sx, pa.sy, cp.sx, cp.sy, pb.sx, pb.sy);
  }
  // Straight segment: check distance to the chord
  const dx = pb.sx - pa.sx, dy = pb.sy - pa.sy;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - pa.sx, py - pa.sy);
  const t = clamp(((px - pa.sx) * dx + (py - pa.sy) * dy) / len2, 0, 1);
  return Math.hypot(px - (pa.sx + t * dx), py - (pa.sy + t * dy));
}

/** t parameter along the bezier closest to (px,py), used for waypoint insertion. */
function bezierParamAt(
  px: number, py: number,
  ax: number, ay: number,
  cpx: number, cpy: number,
  bx: number, by: number,
  samples = 20
): number {
  let minD = Infinity, best = 0;
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const x = (1 - s) * (1 - s) * ax + 2 * (1 - s) * s * cpx + s * s * bx;
    const y = (1 - s) * (1 - s) * ay + 2 * (1 - s) * s * cpy + s * s * by;
    const d = Math.hypot(px - x, py - y);
    if (d < minD) { minD = d; best = s; }
  }
  return best;
}

/** t parameter of the closest point on chord (ax,ay)→(bx,by) to (px,py). */
function projectOntoChord(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0;
  return clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
}

/** Build SVG path string for the trajectory. */
function buildPathD(wps: TrajectoryWaypoint[], fw: number, fh: number): string {
  if (wps.length < 2) return "";
  const pts = wps.map((w) => fracToSvg(w.x, w.y, fw, fh));
  let d = `M ${pts[0].sx} ${pts[0].sy}`;
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i], b = wps[i + 1];
    const pa = pts[i], pb = pts[i + 1];
    if (a.cpx != null && a.cpy != null) {
      const cp = fracToSvg(a.cpx, a.cpy, fw, fh);
      d += ` Q ${cp.sx} ${cp.sy} ${pb.sx} ${pb.sy}`;
    } else {
      d += ` L ${pb.sx} ${pb.sy}`;
    }
  }
  return d;
}

// ── Component ─────────────────────────────────────────────────────────────────

const DIAMOND_SIZE = 9;
const HIT_RADIUS = 14;    // pointer hit area around diamonds
const SEG_HIT_DIST = 8;   // max px from path line to trigger segment drag

export function TrajectoryEditor(props: Props) {
  const {
    clip,
    frameW,
    frameH,
    playing,
    onWaypointsChange,
    onPlayheadSync,
    onDeleteTrajectory,
    onMotionChange,
  } = props;
  const wps = clip.trajectory?.waypoints ?? [];
  const motion = clip.trajectory?.motion ?? "none";
  const motionAmount = clip.trajectory?.motionAmount ?? 50;

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [ghostScale, setGhostScale] = useState<number | null>(null);

  // Active drag state (ref, no re-render per frame)
  const dragRef = useRef<{
    kind: "waypoint" | "segment" | "ghost-scale";
    idx: number;
    startSx: number;
    startSy: number;
    origWps: TrajectoryWaypoint[];
    // For segment drags: SVG coords of the control point at drag start (for relative movement)
    cpOrigSx?: number;
    cpOrigSy?: number;
    origGhostScale?: number;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  /** Convert client coordinates to SVG viewBox coordinates. */
  function getSvgPos(e: { clientX: number; clientY: number }): { sx: number; sy: number } {
    const svg = svgRef.current;
    if (!svg) return { sx: 0, sy: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      const rect = svg.getBoundingClientRect();
      const scaleX = (frameW || 1) / (rect.width || 1);
      const scaleY = (frameH || 1) / (rect.height || 1);
      return { sx: (e.clientX - rect.left) * scaleX, sy: (e.clientY - rect.top) * scaleY };
    }
    const inv = ctm.inverse();
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(inv);
    return { sx: svgPt.x, sy: svgPt.y };
  }

  // ── Context menu (right-click waypoint to delete / delete trajectory) ───────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; idx: number | null } | null>(null);

  // ── Pointer down on SVG ───────────────────────────────────────────────────
  function onSvgPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (playing) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as SVGElement).setPointerCapture?.(e.pointerId);
    setCtxMenu(null);

    const { sx, sy } = getSvgPos(e);

    // 1. Check if clicking a waypoint diamond
    for (let i = 0; i < wps.length; i++) {
      const p = fracToSvg(wps[i].x, wps[i].y, frameW, frameH);
      if (Math.hypot(sx - p.sx, sy - p.sy) <= HIT_RADIUS) {
        setSelectedIdx(i);
        setGhostScale(wps[i].scale);
        dragRef.current = { kind: "waypoint", idx: i, startSx: sx, startSy: sy, origWps: wps.map((w) => ({ ...w })) };
        onPlayheadSync(clip.start + wps[i].t * clip.duration);
        return;
      }
    }

    // 2. Check if clicking a path segment (uses actual bezier curve for hit detection)
    for (let i = 0; i < wps.length - 1; i++) {
      const d = distToPathSeg(sx, sy, wps[i], wps[i + 1], frameW, frameH);
      if (d <= SEG_HIT_DIST) {
        // Segment drag starts from the current control point position (relative movement)
        // so re-adjusting an existing curve feels natural.
        const pa = fracToSvg(wps[i].x, wps[i].y, frameW, frameH);
        const pb = fracToSvg(wps[i + 1].x, wps[i + 1].y, frameW, frameH);
        const cpOrigSx = wps[i].cpx != null
          ? fracToSvg(wps[i].cpx!, wps[i].cpy!, frameW, frameH).sx
          : (pa.sx + pb.sx) / 2;
        const cpOrigSy = wps[i].cpy != null
          ? fracToSvg(wps[i].cpx!, wps[i].cpy!, frameW, frameH).sy
          : (pa.sy + pb.sy) / 2;
        dragRef.current = {
          kind: "segment", idx: i, startSx: sx, startSy: sy,
          origWps: wps.map((w) => ({ ...w })),
          cpOrigSx, cpOrigSy,
        };
        return;
      }
    }

    // 3. Deselect
    setSelectedIdx(null);
    setGhostScale(null);
  }

  function onSvgPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();

    const { sx, sy } = getSvgPos(e);
    const next = d.origWps.map((w) => ({ ...w }));

    if (d.kind === "waypoint") {
      const { x, y } = svgToFrac(sx, sy, frameW, frameH);
      next[d.idx] = {
        ...next[d.idx],
        x: clamp(x, -1.5, 1.5),
        y: clamp(y, -1.5, 1.5),
      };
      // Recompute t for middle waypoints based on projection
      if (d.idx > 0 && d.idx < next.length - 1) {
        next[d.idx].t = recomputeT(d.idx, next);
      }
      onWaypointsChange(next);
      onPlayheadSync(clip.start + next[d.idx].t * clip.duration);

    } else if (d.kind === "segment") {
      // Move control point RELATIVE to drag start — so re-adjusting existing curves is natural
      const newCpSx = (d.cpOrigSx ?? sx) + (sx - d.startSx);
      const newCpSy = (d.cpOrigSy ?? sy) + (sy - d.startSy);
      const { x, y } = svgToFrac(newCpSx, newCpSy, frameW, frameH);
      next[d.idx] = { ...next[d.idx], cpx: x, cpy: y };
      onWaypointsChange(next);
    }
  }

  function onSvgPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    const d = dragRef.current;
    if (!d) return;
    (e.target as SVGElement).releasePointerCapture?.(e.pointerId);

    const { sx, sy } = getSvgPos(e);
    const dx = Math.abs(sx - d.startSx), dy = Math.abs(sy - d.startSy);
    const moved = Math.hypot(dx, dy) > 4;

    if (!moved && d.kind === "segment") {
      // Click on segment without dragging → insert new waypoint ON the curve
      const w1 = wps[d.idx], w2 = wps[d.idx + 1];
      const pa = fracToSvg(w1.x, w1.y, frameW, frameH);
      const pb = fracToSvg(w2.x, w2.y, frameW, frameH);

      let seg_t: number;
      let newX: number, newY: number;

      if (w1.cpx != null && w1.cpy != null) {
        const cp = fracToSvg(w1.cpx, w1.cpy, frameW, frameH);
        seg_t = bezierParamAt(sx, sy, pa.sx, pa.sy, cp.sx, cp.sy, pb.sx, pb.sy);
        newX = (1 - seg_t) * (1 - seg_t) * w1.x + 2 * (1 - seg_t) * seg_t * w1.cpx! + seg_t * seg_t * w2.x;
        newY = (1 - seg_t) * (1 - seg_t) * w1.y + 2 * (1 - seg_t) * seg_t * w1.cpy! + seg_t * seg_t * w2.y;
      } else {
        seg_t = projectOntoChord(sx, sy, pa.sx, pa.sy, pb.sx, pb.sy);
        newX = lerp(w1.x, w2.x, seg_t);
        newY = lerp(w1.y, w2.y, seg_t);
      }

      const newT = lerp(w1.t, w2.t, seg_t);
      const newScale = lerp(w1.scale, w2.scale, seg_t);
      // Remove cp from the upstream waypoint when splitting (user can re-curve each sub-segment)
      const splitWps = wps.map((w) => ({ ...w }));
      splitWps[d.idx] = { ...splitWps[d.idx], cpx: undefined, cpy: undefined };
      const next = [
        ...splitWps.slice(0, d.idx + 1),
        { t: newT, x: newX, y: newY, scale: newScale },
        ...splitWps.slice(d.idx + 1),
      ];
      onWaypointsChange(next);
      setSelectedIdx(d.idx + 1);
      setGhostScale(newScale);
    }

    dragRef.current = null;
  }

  function onSvgContextMenu(e: React.MouseEvent<SVGSVGElement>) {
    e.preventDefault();
    e.stopPropagation();
    const { sx, sy } = getSvgPos(e);
    for (let i = 0; i < wps.length; i++) {
      const p = fracToSvg(wps[i].x, wps[i].y, frameW, frameH);
      if (Math.hypot(sx - p.sx, sy - p.sy) <= HIT_RADIUS) {
        if (i === 0 || i === wps.length - 1) {
          // Start/end point → offer to delete the whole trajectory
          setCtxMenu({ x: e.clientX, y: e.clientY, idx: null });
        } else {
          setCtxMenu({ x: e.clientX, y: e.clientY, idx: i });
        }
        return;
      }
    }
  }

  function deleteWaypoint(idx: number) {
    setCtxMenu(null);
    if (idx === 0 || idx === wps.length - 1) return;
    const next = wps.filter((_, i) => i !== idx);
    onWaypointsChange(next);
    if (selectedIdx === idx) { setSelectedIdx(null); setGhostScale(null); }
  }

  // ── Ghost scale drag ───────────────────────────────────────────────────────
  function onGhostScalePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (selectedIdx === null) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      kind: "ghost-scale",
      idx: selectedIdx,
      startSx: e.clientX,
      startSy: e.clientY,
      origWps: wps.map((w) => ({ ...w })),
      origGhostScale: wps[selectedIdx].scale,
    };
  }

  function onGhostScalePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.kind !== "ghost-scale") return;
    e.preventDefault();
    const delta = (e.clientX - d.startSx) / (frameW * 0.5);
    const newScale = clamp((d.origGhostScale ?? 1) + delta * 2, 0.1, 6);
    setGhostScale(newScale);
    const next = d.origWps.map((w) => ({ ...w }));
    next[d.idx] = { ...next[d.idx], scale: newScale };
    onWaypointsChange(next);
  }

  function onGhostScalePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.kind === "ghost-scale") {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const pathD = buildPathD(wps, frameW, frameH);
  const activeSeg = dragRef.current?.kind === "segment" ? dragRef.current.idx : null;

  const ghostWp = selectedIdx !== null ? wps[selectedIdx] : null;
  const ghostSrc = clip.srcRelPath ? assetUrlFromRelPath(clip.srcRelPath) : null;

  // Compute ghost rect as percentages of the container so it matches the SVG overlay.
  function ghostRect(wp: TrajectoryWaypoint) {
    const nW = clip.naturalW ?? frameW;
    const nH = clip.naturalH ?? frameH;
    const imgA = nW / nH;
    const frmA = frameW / frameH;
    let baseW = frameW, baseH = frameH;
    if (imgA > frmA) { baseW = frameW; baseH = frameW / imgA; }
    else { baseH = frameH; baseW = frameH * imgA; }
    const w = baseW * (ghostScale ?? wp.scale);
    const h = baseH * (ghostScale ?? wp.scale);
    // wp.x / wp.y are fractions relative to frame center; convert to % of container
    const cx = 0.5 + wp.x;      // fraction [0,1] of frameW
    const cy = 0.5 + wp.y;      // fraction [0,1] of frameH
    const wPct = (w / frameW) * 100;
    const hPct = (h / frameH) * 100;
    return {
      left: `${cx * 100 - wPct / 2}%`,
      top: `${cy * 100 - hPct / 2}%`,
      width: `${wPct}%`,
      height: `${hPct}%`,
    };
  }

  return (
    <div
      data-trajectory-editor
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 10001,
        pointerEvents: "none",
      }}
    >
      {/* Ghost image when waypoint selected */}
      {ghostWp && ghostSrc && (() => {
        const r = ghostRect(ghostWp);
        return (
          <div
            style={{
              position: "absolute",
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
              pointerEvents: "none",
              userSelect: "none",
              zIndex: 0,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={ghostSrc}
              alt=""
              draggable={false}
              style={{ width: "100%", height: "100%", objectFit: "fill", opacity: 0.35, display: "block" }}
            />
            {/* Scale drag handle */}
            <div
              onPointerDown={onGhostScalePointerDown}
              onPointerMove={onGhostScalePointerMove}
              onPointerUp={onGhostScalePointerUp}
              style={{
                position: "absolute",
                right: -8,
                bottom: -8,
                width: 16,
                height: 16,
                background: "#ffd166",
                border: "1px solid #000",
                cursor: "nwse-resize",
                pointerEvents: "auto",
                zIndex: 3,
              }}
            />
          </div>
        );
      })()}

      {/* SVG overlay — below toolbar so motion controls stay clickable */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${frameW || 1} ${frameH || 1}`}
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          overflow: "visible",
          cursor: playing ? "default" : "crosshair",
          pointerEvents: "auto",
          zIndex: 1,
        }}
        onPointerDown={onSvgPointerDown}
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onContextMenu={onSvgContextMenu}
      >
        {/* Transparent rect so the full SVG area captures pointer events */}
        <rect x={0} y={0} width={frameW || 1} height={frameH || 1} fill="transparent" />
        {/* Path line */}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke="rgba(255,209,102,0.7)"
            strokeWidth={1.5}
            strokeDasharray="5 4"
          />
        )}

        {/* Bezier handles (active segment drag only) */}
        {activeSeg !== null && wps[activeSeg]?.cpx != null && (() => {
          const a = fracToSvg(wps[activeSeg].x, wps[activeSeg].y, frameW, frameH);
          const b = fracToSvg(wps[activeSeg + 1].x, wps[activeSeg + 1].y, frameW, frameH);
          const cp = fracToSvg(wps[activeSeg].cpx!, wps[activeSeg].cpy!, frameW, frameH);
          return (
            <>
              <line x1={a.sx} y1={a.sy} x2={cp.sx} y2={cp.sy} stroke="rgba(255,255,255,0.4)" strokeWidth={1} strokeDasharray="3 3" />
              <line x1={b.sx} y1={b.sy} x2={cp.sx} y2={cp.sy} stroke="rgba(255,255,255,0.4)" strokeWidth={1} strokeDasharray="3 3" />
              <circle cx={cp.sx} cy={cp.sy} r={5} fill="#fff" fillOpacity={0.7} stroke="#aaa" strokeWidth={1} />
            </>
          );
        })()}

        {/* Waypoint diamonds + scale rings + number badges */}
        {wps.map((wp, i) => {
          const { sx, sy } = fracToSvg(wp.x, wp.y, frameW, frameH);
          const isSelected = i === selectedIdx;
          const isStart = i === 0, isEnd = i === wps.length - 1;
          const fill = isSelected ? "#ffd166" : isStart || isEnd ? "#fff" : "rgba(255,255,255,0.75)";

          // Check if another waypoint is nearby (for stagger)
          const nearbyOffset = wps.some((w2, j) => j !== i && Math.hypot(
            fracToSvg(w2.x, w2.y, frameW, frameH).sx - sx,
            fracToSvg(w2.x, w2.y, frameW, frameH).sy - sy
          ) < 10) ? (i % 2 === 0 ? -12 : 12) : 0;

          return (
            <g key={i}>
              {/* Scale ring */}
              <circle
                cx={sx} cy={sy}
                r={Math.max(8, DIAMOND_SIZE * (wp.scale ?? 1) * 0.8)}
                fill="none"
                stroke="rgba(255,209,102,0.25)"
                strokeWidth={1}
              />
              {/* Diamond */}
              <rect
                x={sx - DIAMOND_SIZE / 2}
                y={sy - DIAMOND_SIZE / 2}
                width={DIAMOND_SIZE}
                height={DIAMOND_SIZE}
                fill={fill}
                stroke={isSelected ? "#fff" : "rgba(0,0,0,0.5)"}
                strokeWidth={isSelected ? 1.5 : 1}
                transform={`rotate(45, ${sx}, ${sy})`}
              />
              {/* Number badge */}
              <text
                x={sx + nearbyOffset}
                y={sy - DIAMOND_SIZE - 3}
                textAnchor="middle"
                fill="#fff"
                fontSize={9}
                style={{ userSelect: "none", pointerEvents: "none" }}
              >
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Motion toolbar — rendered above SVG for hit testing */}
      <div
        data-trajectory-toolbar
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          background: "rgba(11,11,11,0.92)",
          border: "1px solid rgba(255,255,255,0.25)",
          borderRadius: 0,
          fontSize: 11,
          color: "#eee",
          pointerEvents: "auto",
          zIndex: 2,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <label
          style={{ display: "flex", alignItems: "center", gap: 6 }}
          title="Procedural motion on the path (applied in preview and MP4 export)"
        >
          <span style={{ opacity: 0.85 }}>Motion</span>
          <select
            className="ui-btn-black"
            value={motion}
            onChange={(e) =>
              onMotionChange?.(e.target.value as TrajectoryMotionId, motionAmount)
            }
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              fontSize: 11,
              padding: "4px 8px",
              borderRadius: 0,
              minWidth: 100,
              pointerEvents: "auto",
            }}
          >
            {TRAJECTORY_MOTION_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            opacity: motion === "none" ? 0.45 : 1,
          }}
        >
          <span style={{ opacity: 0.85 }}>Intensity</span>
          <input
            type="range"
            min={0}
            max={100}
            value={motionAmount}
            disabled={motion === "none"}
            onChange={(e) =>
              onMotionChange?.(motion, Number(e.target.value))
            }
            onPointerDown={(e) => e.stopPropagation()}
            style={{ width: 88, pointerEvents: "auto" }}
          />
          <span style={{ minWidth: 24, opacity: 0.7, fontSize: 11 }}>{motionAmount}</span>
        </label>
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          style={{
            position: "fixed",
            top: ctxMenu.y,
            left: ctxMenu.x,
            background: "#1e1e1e",
            border: "1px solid rgba(255,255,255,0.2)",
            zIndex: 10003,
            minWidth: 140,
            pointerEvents: "all",
          }}
          onMouseLeave={() => setCtxMenu(null)}
        >
          {ctxMenu.idx === null ? (
            <button
              type="button"
              onClick={() => { setCtxMenu(null); onDeleteTrajectory?.(); }}
              style={{ display: "block", width: "100%", padding: "8px 14px", background: "transparent", color: "#eee", border: "none", textAlign: "left", cursor: "pointer", font: "inherit", fontSize: 13 }}
            >
              Delete Trajectory
            </button>
          ) : (
            <button
              type="button"
              onClick={() => deleteWaypoint(ctxMenu.idx as number)}
              style={{ display: "block", width: "100%", padding: "8px 14px", background: "transparent", color: "#eee", border: "none", textAlign: "left", cursor: "pointer", font: "inherit", fontSize: 13 }}
            >
              Delete waypoint
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export { trajectoryTransformAt } from "./trajectoryMotion";
