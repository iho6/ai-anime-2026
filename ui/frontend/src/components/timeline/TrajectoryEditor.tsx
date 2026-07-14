"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { assetUrlFromRelPath, TimelineClip, TrajectoryMotionId } from "../../lib/api";
import { TRAJECTORY_MOTION_OPTIONS } from "./trajectoryMotion";
import { clipImageRect, pointInTrajectoryWaypointHit, PREVIEW_EDIT_TOOLBAR_Z, PREVIEW_EDIT_Z, PREVIEW_FRAME_EXTENSION_NONE, PREVIEW_HANDLE_Z, trajectoryWaypointHitRectAt, type ClipRect, type PreviewFrameExtension } from "./timelineUtil";
import { TrajectoryWaypointFlyout, type TrajectoryWaypointFlyoutBridgeSide, type TrajectoryWaypointPatchValues } from "./TrajectoryWaypointFlyout";
import { normalizeBlendEase, effectiveHoldSec, maxHoldSecForSegment, normalizeHoldSec } from "./trajectoryWaypoint";

export type TrajectoryWaypoint = NonNullable<TimelineClip["trajectory"]>["waypoints"][number];

type Props = {
  clip: TimelineClip;
  frameW: number;
  frameH: number;
  /** Outside-frame pad; SVG viewBox spans the white frame plus this margin. */
  extend?: PreviewFrameExtension;
  /** Clip image bounds at the current playhead (for click-outside exit). */
  clipBoundsAtPlayhead: ClipRect | null;
  playing: boolean;
  /** Called on every waypoint change (real-time, no undo checkpoint). */
  onWaypointsChange: (waypoints: TrajectoryWaypoint[]) => void;
  /** Called when dragging a waypoint — syncs playhead to that t value. */
  onPlayheadSync: (clipTime: number) => void;
  /** Save checkpoint and leave trajectory edit (Esc / Enter / click outside clip). */
  onExit?: () => void;
  /** Called when the user requests to delete the entire trajectory. */
  onDeleteTrajectory?: () => void;
  onMotionChange?: (motion: TrajectoryMotionId, motionAmount: number) => void;
  onWaypointPatchCommit?: () => void;
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
  // Coincident start/end produce an invisible zero-length path — stub a short
  // segment so Add Trajectory / stacked waypoints still show a gold dash.
  if (wps.length === 2) {
    const dx = pts[1].sx - pts[0].sx;
    const dy = pts[1].sy - pts[0].sy;
    if (Math.hypot(dx, dy) < 1) {
      const stub = MIN_PATH_STUB_PX;
      return `M ${pts[0].sx - stub} ${pts[0].sy} L ${pts[0].sx + stub} ${pts[0].sy}`;
    }
  }
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

const DIAMOND_SIZE = 12;
const HIT_RADIUS = 20;    // legacy fallback radius (px)
const SEG_HIT_DIST = 8;   // max px from path line to trigger segment drag
/** Minimum visible path length (frame px) when start/end coincide. */
const MIN_PATH_STUB_PX = 28;
const FLYOUT_VIEWPORT_MARGIN = 8;
const FLYOUT_GAP_PX = 4;

function pointInClipBounds(
  sx: number,
  sy: number,
  bounds: ClipRect | null
): boolean {
  if (!bounds) return false;
  return (
    sx >= bounds.left &&
    sx <= bounds.left + bounds.width &&
    sy >= bounds.top &&
    sy <= bounds.top + bounds.height
  );
}

function pointInWaypointHit(
  sx: number,
  sy: number,
  wp: TrajectoryWaypoint,
  frameW: number,
  frameH: number
): boolean {
  const { sx: cx, sy: cy } = fracToSvg(wp.x, wp.y, frameW, frameH);
  return pointInTrajectoryWaypointHit(sx, sy, cx, cy, wp.scale ?? 1);
}

export function TrajectoryEditor(props: Props) {
  const {
    clip,
    frameW,
    frameH,
    extend = PREVIEW_FRAME_EXTENSION_NONE,
    clipBoundsAtPlayhead,
    playing,
    onWaypointsChange,
    onPlayheadSync,
    onExit,
    onDeleteTrajectory,
    onMotionChange,
    onWaypointPatchCommit,
  } = props;
  const wps = clip.trajectory?.waypoints ?? [];
  const motion = clip.trajectory?.motion ?? "none";
  const motionAmount = clip.trajectory?.motionAmount ?? 50;
  const viewW = frameW + extend.left + extend.right;
  const viewH = frameH + extend.top + extend.bottom;
  const viewBox = `${-extend.left} ${-extend.top} ${Math.max(1, viewW)} ${Math.max(1, viewH)}`;

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [ghostScale, setGhostScale] = useState<number | null>(null);
  const [hoverFlyout, setHoverFlyout] = useState<{ idx: number } | null>(null);
  const [flyoutLayout, setFlyoutLayout] = useState<{
    left: number;
    top: number;
    bridgeSide: TrajectoryWaypointFlyoutBridgeSide;
  } | null>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const flyoutCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelFlyoutClose = useCallback(() => {
    if (flyoutCloseTimerRef.current) {
      clearTimeout(flyoutCloseTimerRef.current);
      flyoutCloseTimerRef.current = null;
    }
  }, []);

  const scheduleFlyoutClose = useCallback(() => {
    cancelFlyoutClose();
    flyoutCloseTimerRef.current = setTimeout(() => {
      setHoverFlyout(null);
      setFlyoutLayout(null);
    }, 300);
  }, [cancelFlyoutClose]);

  useEffect(() => () => cancelFlyoutClose(), [cancelFlyoutClose]);

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

  /** Convert client coordinates to SVG viewBox coordinates (frame space). */
  function getSvgPos(e: { clientX: number; clientY: number }): { sx: number; sy: number } {
    const svg = svgRef.current;
    if (!svg) return { sx: 0, sy: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      const rect = svg.getBoundingClientRect();
      const scaleX = viewW / (rect.width || 1);
      const scaleY = viewH / (rect.height || 1);
      return {
        sx: (e.clientX - rect.left) * scaleX - extend.left,
        sy: (e.clientY - rect.top) * scaleY - extend.top,
      };
    }
    const inv = ctm.inverse();
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(inv);
    return { sx: svgPt.x, sy: svgPt.y };
  }

  function waypointClientCenter(idx: number): { x: number; y: number } | null {
    const wp = wps[idx];
    const svg = svgRef.current;
    if (!wp || !svg) return null;
    const { sx, sy } = fracToSvg(wp.x, wp.y, frameW, frameH);
    const ctm = svg.getScreenCTM();
    if (!ctm) {
      const rect = svg.getBoundingClientRect();
      const scaleX = rect.width / (viewW || 1);
      const scaleY = rect.height / (viewH || 1);
      return {
        x: rect.left + (sx + extend.left) * scaleX,
        y: rect.top + (sy + extend.top) * scaleY,
      };
    }
    const pt = svg.createSVGPoint();
    pt.x = sx;
    pt.y = sy;
    const screen = pt.matrixTransform(ctm);
    return { x: screen.x, y: screen.y };
  }

  function computeFlyoutLayout(
    dotX: number,
    dotY: number,
    flyoutW: number,
    flyoutH: number
  ): { left: number; top: number; bridgeSide: TrajectoryWaypointFlyoutBridgeSide } {
    let bridgeSide: TrajectoryWaypointFlyoutBridgeSide = "left";
    let left = dotX + FLYOUT_GAP_PX;
    let top = dotY - flyoutH / 2;

    if (left + flyoutW > window.innerWidth - FLYOUT_VIEWPORT_MARGIN) {
      left = dotX - flyoutW - FLYOUT_GAP_PX;
      bridgeSide = "right";
    }

    left = clamp(
      left,
      FLYOUT_VIEWPORT_MARGIN,
      Math.max(FLYOUT_VIEWPORT_MARGIN, window.innerWidth - flyoutW - FLYOUT_VIEWPORT_MARGIN)
    );
    top = clamp(
      top,
      FLYOUT_VIEWPORT_MARGIN,
      Math.max(FLYOUT_VIEWPORT_MARGIN, window.innerHeight - flyoutH - FLYOUT_VIEWPORT_MARGIN)
    );

    return { left, top, bridgeSide };
  }

  useLayoutEffect(() => {
    if (hoverFlyout == null) {
      setFlyoutLayout(null);
      return;
    }
    const center = waypointClientCenter(hoverFlyout.idx);
    if (!center) return;
    const el = flyoutRef.current;
    const measured = el?.getBoundingClientRect();
    const flyoutW = measured && measured.width > 0 ? measured.width : 280;
    const flyoutH = measured && measured.height > 0 ? measured.height : 160;
    const next = computeFlyoutLayout(center.x, center.y, flyoutW, flyoutH);
    setFlyoutLayout((prev) =>
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.bridgeSide === next.bridgeSide
        ? prev
        : next
    );
  }, [hoverFlyout, wps, frameW, frameH]);

  useEffect(() => {
    if (!hoverFlyout) return;
    const el = flyoutRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const center = waypointClientCenter(hoverFlyout.idx);
      if (!center) return;
      const measured = el.getBoundingClientRect();
      const flyoutW = measured.width > 0 ? measured.width : 280;
      const flyoutH = measured.height > 0 ? measured.height : 160;
      const next = computeFlyoutLayout(center.x, center.y, flyoutW, flyoutH);
      setFlyoutLayout((prev) =>
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.bridgeSide === next.bridgeSide
          ? prev
          : next
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hoverFlyout, wps, frameW, frameH]);

  function openWaypointFlyout(idx: number) {
    if (playing || dragRef.current) return;
    if (idx < 0 || idx >= wps.length) return;
    cancelFlyoutClose();
    setHoverFlyout((prev) => (prev?.idx === idx ? prev : { idx }));
  }

  function patchWaypoint(idx: number, patch: TrajectoryWaypointPatchValues) {
    const isLast = idx === wps.length - 1;
    const aT = isLast ? wps[idx - 1]!.t : wps[idx]!.t;
    const bT = isLast ? wps[idx]!.t : wps[idx + 1]!.t;
    // Final waypoint has no outgoing segment — Pause stays 0; Glide ease still applies.
    const maxSec = isLast ? 0 : maxHoldSecForSegment(aT, bT, clip.duration);
    const next = wps.map((w, i) =>
      i !== idx
        ? w
        : {
            ...w,
            holdSec: normalizeHoldSec(patch.holdSec, maxSec),
            blendEase: normalizeBlendEase(patch.blendEase),
            holdPct: undefined,
          }
    );
    onWaypointsChange(next);
  }

  useEffect(() => {
    if (playing) {
      setHoverFlyout(null);
      setFlyoutLayout(null);
    }
  }, [playing]);

  // ── Context menu (right-click waypoint to delete / delete trajectory) ───────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; idx: number | null } | null>(null);

  function beginWaypointDrag(
    i: number,
    sx: number,
    sy: number,
    e: React.PointerEvent<Element>
  ) {
    if (playing) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setCtxMenu(null);
    setHoverFlyout(null);
    setSelectedIdx(i);
    setGhostScale(wps[i].scale);
    dragRef.current = {
      kind: "waypoint",
      idx: i,
      startSx: sx,
      startSy: sy,
      origWps: wps.map((w) => ({ ...w })),
    };
    onPlayheadSync(clip.start + wps[i].t * clip.duration);
  }

  // ── Pointer down on path / waypoints (SVG background is pass-through) ─────
  function onTrajPointerDown(e: React.PointerEvent<Element>) {
    if (playing) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setCtxMenu(null);
    setHoverFlyout(null);

    const { sx, sy } = getSvgPos(e);

    // 1. Waypoint hit (small target around diamond, end → start)
    for (let i = wps.length - 1; i >= 0; i--) {
      if (pointInWaypointHit(sx, sy, wps[i], frameW, frameH)) {
        beginWaypointDrag(i, sx, sy, e);
        return;
      }
    }

    // 2. Path segment hit
    for (let i = 0; i < wps.length - 1; i++) {
      const d = distToPathSeg(sx, sy, wps[i], wps[i + 1], frameW, frameH);
      if (d <= SEG_HIT_DIST) {
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

    setSelectedIdx(null);
    setGhostScale(null);
  }

  function onBackgroundPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (playing) return;
    e.stopPropagation();
    const { sx, sy } = getSvgPos(e);
    if (pointInClipBounds(sx, sy, clipBoundsAtPlayhead)) {
      setSelectedIdx(null);
      setGhostScale(null);
    } else {
      onExit?.();
    }
  }

  function onTrajPointerMove(e: React.PointerEvent<Element>) {
    const d = dragRef.current;
    if (!d) return;
    e.preventDefault();

    const { sx, sy } = getSvgPos(e);
    const next = d.origWps.map((w) => ({ ...w }));

    if (d.kind === "waypoint") {
      const { x, y } = svgToFrac(sx, sy, frameW, frameH);
      next[d.idx] = {
        ...next[d.idx],
        // Unbounded — canvas extension grows with waypoints (no ±1.5 hard stop).
        x: Number.isFinite(x) ? x : next[d.idx].x,
        y: Number.isFinite(y) ? y : next[d.idx].y,
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

  function onTrajPointerUp(e: React.PointerEvent<Element>) {
    const d = dragRef.current;
    if (!d) return;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);

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
    for (let i = wps.length - 1; i >= 0; i--) {
      if (
        pointInWaypointHit(sx, sy, wps[i], frameW, frameH) ||
        Math.hypot(
          sx - fracToSvg(wps[i].x, wps[i].y, frameW, frameH).sx,
          sy - fracToSvg(wps[i].x, wps[i].y, frameW, frameH).sy
        ) <= HIT_RADIUS
      ) {
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

  // Ghost rect in extended-layer pixels so it tracks frame-space waypoints.
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
    const { sx: cx, sy: cy } = fracToSvg(wp.x, wp.y, frameW, frameH);
    return {
      left: extend.left + cx - w / 2,
      top: extend.top + cy - h / 2,
      width: w,
      height: h,
    };
  }

  return (
    <div
      data-trajectory-editor
      style={{
        position: "absolute",
        inset: 0,
        zIndex: PREVIEW_EDIT_Z,
        pointerEvents: "none",
      }}
    >
      {/* Click-through catcher: empty preview exits; inside clip deselects waypoint */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "auto",
          zIndex: 0,
        }}
        onPointerDown={onBackgroundPointerDown}
      />
      {/* Ghost image when waypoint selected — visual only; SVG handles interaction */}
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
              zIndex: 1,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={ghostSrc}
              alt=""
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "fill",
                opacity: 0.35,
                display: "block",
                pointerEvents: "none",
              }}
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
                zIndex: PREVIEW_HANDLE_Z,
              }}
            />
          </div>
        );
      })()}

      {/* SVG overlay — pass-through except path and waypoints */}
      <svg
        ref={svgRef}
        viewBox={viewBox}
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          overflow: "visible",
          pointerEvents: "none",
          zIndex: 1,
        }}
        onContextMenu={onSvgContextMenu}
      >
        {/* Path line — wide invisible stroke for hit testing */}
        {pathD && (
          <>
            <path
              d={pathD}
              fill="none"
              stroke="transparent"
              strokeWidth={SEG_HIT_DIST * 2}
              pointerEvents="stroke"
              style={{ cursor: playing ? "default" : "crosshair" }}
              onPointerDown={onTrajPointerDown}
              onPointerMove={onTrajPointerMove}
              onPointerUp={onTrajPointerUp}
            />
            <path
              d={pathD}
              fill="none"
              stroke="rgba(255,209,102,0.7)"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              pointerEvents="none"
            />
          </>
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
          // High-contrast fills so diamonds stay readable on light figures / plates.
          const fill = isSelected
            ? "#ffd166"
            : isStart
              ? "#ffe8a3"
              : isEnd
                ? "#ff9f43"
                : "#ffd166";

          // Check if another waypoint is nearby (for stagger)
          const nearbyOffset = wps.some((w2, j) => j !== i && Math.hypot(
            fracToSvg(w2.x, w2.y, frameW, frameH).sx - sx,
            fracToSvg(w2.x, w2.y, frameW, frameH).sy - sy
          ) < 10) ? (i % 2 === 0 ? -12 : 12) : 0;

          return (
            <g key={i} pointerEvents="visiblePainted">
              {/* Hit target — capped square around diamond center */}
              {(() => {
                const hitRect = trajectoryWaypointHitRectAt(sx, sy, wp.scale ?? 1);
                return (
                  <rect
                    x={hitRect.left}
                    y={hitRect.top}
                    width={hitRect.width}
                    height={hitRect.height}
                    fill="transparent"
                    pointerEvents="all"
                    style={{ cursor: playing ? "default" : "move" }}
                    onPointerDown={onTrajPointerDown}
                    onPointerMove={onTrajPointerMove}
                    onPointerUp={onTrajPointerUp}
                    onMouseEnter={() => {
                      if (!playing && !dragRef.current) {
                        openWaypointFlyout(i);
                      }
                    }}
                    onMouseLeave={scheduleFlyoutClose}
                  />
                );
              })()}
              {/* Scale ring */}
              <circle
                cx={sx} cy={sy}
                r={Math.max(10, DIAMOND_SIZE * (wp.scale ?? 1) * 0.8)}
                fill="none"
                stroke="rgba(255,209,102,0.55)"
                strokeWidth={1.5}
                pointerEvents="none"
              />
              {/* Diamond */}
              <rect
                x={sx - DIAMOND_SIZE / 2}
                y={sy - DIAMOND_SIZE / 2}
                width={DIAMOND_SIZE}
                height={DIAMOND_SIZE}
                fill={fill}
                stroke="#0b0b0b"
                strokeWidth={isSelected ? 2 : 1.5}
                transform={`rotate(45, ${sx}, ${sy})`}
                pointerEvents="none"
              />
              {/* Number badge */}
              <text
                x={sx + nearbyOffset}
                y={sy - DIAMOND_SIZE - 3}
                textAnchor="middle"
                fill="#ffd166"
                stroke="#0b0b0b"
                strokeWidth={0.6}
                paintOrder="stroke"
                fontSize={10}
                fontWeight={700}
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
          top: extend.top + 8,
          left: extend.left + 8,
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
          zIndex: PREVIEW_EDIT_TOOLBAR_Z,
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
              background: "#0b0b0b",
              color: "#eee",
              border: "1px solid rgba(255,255,255,0.9)",
            }}
          >
            {TRAJECTORY_MOTION_OPTIONS.map((opt) => (
              <option
                key={opt.id}
                value={opt.id}
                style={{ background: "#0b0b0b", color: "#eee" }}
              >
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
        <span style={{ opacity: 0.55, fontSize: 10, marginLeft: 4 }}>Esc / Enter — done</span>
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
            zIndex: 70,
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

      {hoverFlyout && !playing && hoverFlyout.idx < wps.length ? (() => {
        const idx = hoverFlyout.idx;
        const isLast = idx === wps.length - 1;
        const aT = isLast ? wps[idx - 1]!.t : wps[idx]!.t;
        const bT = isLast ? wps[idx]!.t : wps[idx + 1]!.t;
        const maxHold = isLast ? 0 : maxHoldSecForSegment(aT, bT, clip.duration);
        return (
          <TrajectoryWaypointFlyout
            ref={flyoutRef}
            x={flyoutLayout?.left ?? 0}
            y={flyoutLayout?.top ?? 0}
            bridgeSide={flyoutLayout?.bridgeSide ?? "left"}
            holdSec={isLast ? 0 : effectiveHoldSec(wps[idx], aT, bT, clip.duration)}
            maxHoldSec={maxHold}
            showPause={!isLast}
            blendEase={normalizeBlendEase(wps[idx].blendEase)}
            onPatchChange={(patch) => patchWaypoint(idx, patch)}
            onPatchCommit={() => onWaypointPatchCommit?.()}
            onMouseEnter={cancelFlyoutClose}
            onMouseLeave={scheduleFlyoutClose}
          />
        );
      })() : null}
    </div>
  );
}

export { trajectoryTransformAt } from "./trajectoryMotion";
