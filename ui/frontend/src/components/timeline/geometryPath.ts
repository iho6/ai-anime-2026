import type { GeometryPoint, TimelineGeometry } from "../../lib/api";
import type { ClipRect } from "./timelineUtil";
import { VECTOR_ARTBOARD_SIZE } from "./geometryTemplates";

const ARTBOARD = VECTOR_ARTBOARD_SIZE;

export type GeometryBounds = { minX: number; minY: number; maxX: number; maxY: number };

export type BboxHandleId = "nw" | "n" | "ne" | "w" | "e" | "sw" | "s" | "se";

function lerpPt(a: { x: number; y: number }, b: { x: number; y: number }, t: number) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function includePoint(
  bounds: GeometryBounds,
  x: number,
  y: number
): GeometryBounds {
  return {
    minX: Math.min(bounds.minX, x),
    minY: Math.min(bounds.minY, y),
    maxX: Math.max(bounds.maxX, x),
    maxY: Math.max(bounds.maxY, y),
  };
}

/** Tight axis-aligned bbox in 0–1 artboard space (anchors, handles, sampled curves). */
export function geometryBounds(
  geometry: TimelineGeometry,
  padding = 0.01
): GeometryBounds {
  const pts = geometry.points;
  if (pts.length === 0) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }

  let b: GeometryBounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };

  for (const pt of pts) {
    b = includePoint(b, pt.x, pt.y);
    if (pt.handleIn) b = includePoint(b, pt.handleIn.x, pt.handleIn.y);
    if (pt.handleOut) b = includePoint(b, pt.handleOut.x, pt.handleOut.y);
  }

  const segCount = geometry.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const bp = pts[(i + 1) % pts.length];
    for (let s = 0; s <= 16; s++) {
      const p = pointOnSegment(a, bp, s / 16);
      b = includePoint(b, p.x, p.y);
    }
  }

  if (!Number.isFinite(b.minX)) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }

  return {
    minX: Math.max(0, b.minX - padding),
    minY: Math.max(0, b.minY - padding),
    maxX: Math.min(1, b.maxX + padding),
    maxY: Math.min(1, b.maxY + padding),
  };
}

export function geometryBoundsToScreen(bounds: GeometryBounds, clipRect: ClipRect): ClipRect {
  return {
    left: clipRect.left + bounds.minX * clipRect.width,
    top: clipRect.top + bounds.minY * clipRect.height,
    width: Math.max(1, (bounds.maxX - bounds.minX) * clipRect.width),
    height: Math.max(1, (bounds.maxY - bounds.minY) * clipRect.height),
  };
}

export function geometryBoundsToScreenPadded(
  bounds: GeometryBounds,
  clipRect: ClipRect,
  padPx: number
): ClipRect {
  const r = geometryBoundsToScreen(bounds, clipRect);
  return {
    left: r.left - padPx,
    top: r.top - padPx,
    width: r.width + padPx * 2,
    height: r.height + padPx * 2,
  };
}

function scaleCoord(v: number, anchor: number, scale: number) {
  return anchor + (v - anchor) * scale;
}

function scalePoint(
  p: { x: number; y: number },
  anchor: { x: number; y: number },
  scaleX: number,
  scaleY: number
) {
  return {
    x: scaleCoord(p.x, anchor.x, scaleX),
    y: scaleCoord(p.y, anchor.y, scaleY),
  };
}

/** Scale all anchors and handles about an anchor point. */
export function scaleGeometryPoints(
  geometry: TimelineGeometry,
  anchor: { x: number; y: number },
  scaleX: number,
  scaleY: number
): TimelineGeometry {
  const points = geometry.points.map((pt) => {
    const next: GeometryPoint = {
      ...pt,
      ...scalePoint(pt, anchor, scaleX, scaleY),
    };
    if (pt.handleIn) next.handleIn = scalePoint(pt.handleIn, anchor, scaleX, scaleY);
    if (pt.handleOut) next.handleOut = scalePoint(pt.handleOut, anchor, scaleX, scaleY);
    return next;
  });
  return { ...geometry, points };
}

/** Translate all anchors and handles by a delta in artboard space. */
export function translateGeometryPoints(
  geometry: TimelineGeometry,
  dx: number,
  dy: number
): TimelineGeometry {
  const shift = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
  const points = geometry.points.map((pt) => {
    const next: GeometryPoint = { ...pt, ...shift(pt) };
    if (pt.handleIn) next.handleIn = shift(pt.handleIn);
    if (pt.handleOut) next.handleOut = shift(pt.handleOut);
    return next;
  });
  return { ...geometry, points };
}

export function bboxHandlePosition(bounds: GeometryBounds, handle: BboxHandleId): { x: number; y: number } {
  const { minX, minY, maxX, maxY } = bounds;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  switch (handle) {
    case "nw":
      return { x: minX, y: minY };
    case "n":
      return { x: midX, y: minY };
    case "ne":
      return { x: maxX, y: minY };
    case "w":
      return { x: minX, y: midY };
    case "e":
      return { x: maxX, y: midY };
    case "sw":
      return { x: minX, y: maxY };
    case "s":
      return { x: midX, y: maxY };
    case "se":
      return { x: maxX, y: maxY };
  }
}

export function bboxAnchorForHandle(bounds: GeometryBounds, handle: BboxHandleId): { x: number; y: number } {
  const { minX, minY, maxX, maxY } = bounds;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  switch (handle) {
    case "nw":
      return { x: maxX, y: maxY };
    case "n":
      return { x: midX, y: maxY };
    case "ne":
      return { x: minX, y: maxY };
    case "w":
      return { x: maxX, y: midY };
    case "e":
      return { x: minX, y: midY };
    case "sw":
      return { x: maxX, y: minY };
    case "s":
      return { x: midX, y: minY };
    case "se":
      return { x: minX, y: minY };
  }
}

export function distToGeometrySegment(
  px: number,
  py: number,
  geometry: TimelineGeometry,
  threshold = 0.03
): { segIndex: number; t: number; dist: number } | null {
  return distToSegment(px, py, geometry, threshold);
}

export function geometryToSvgPath(geometry: TimelineGeometry): string {
  const pts = geometry.points;
  if (pts.length === 0) return "";

  const parts: string[] = [];
  const first = pts[0];
  parts.push(`M ${first.x * ARTBOARD} ${first.y * ARTBOARD}`);

  for (let i = 1; i < pts.length; i++) {
    parts.push(segmentToSvg(pts[i - 1], pts[i]));
  }

  if (geometry.closed && pts.length > 1) {
    parts.push(segmentToSvg(pts[pts.length - 1], pts[0]));
    parts.push("Z");
  }
  return parts.join(" ");
}

function segmentToSvg(a: GeometryPoint, b: GeometryPoint): string {
  const ax = a.x * ARTBOARD;
  const ay = a.y * ARTBOARD;
  const bx = b.x * ARTBOARD;
  const by = b.y * ARTBOARD;
  if (a.handleOut && b.handleIn) {
    return `C ${a.handleOut.x * ARTBOARD} ${a.handleOut.y * ARTBOARD} ${b.handleIn.x * ARTBOARD} ${b.handleIn.y * ARTBOARD} ${bx} ${by}`;
  }
  return `L ${bx} ${by}`;
}

/** Sample points along the path for hit-testing (local 0–1 space). */
export function sampleGeometryPath(
  geometry: TimelineGeometry,
  samplesPerSegment = 24
): Array<{ x: number; y: number; segIndex: number; t: number }> {
  const pts = geometry.points;
  if (pts.length < 2) return pts.map((p, i) => ({ x: p.x, y: p.y, segIndex: 0, t: i }));

  const out: Array<{ x: number; y: number; segIndex: number; t: number }> = [];
  const segCount = geometry.closed ? pts.length : pts.length - 1;

  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    for (let s = 0; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const p = pointOnSegment(a, b, t);
      out.push({ x: p.x, y: p.y, segIndex: i, t });
    }
  }
  return out;
}

function pointOnSegment(a: GeometryPoint, b: GeometryPoint, t: number): { x: number; y: number } {
  if (a.handleOut && b.handleIn) {
    const u = 1 - t;
    const x =
      u * u * u * a.x +
      3 * u * u * t * a.handleOut.x +
      3 * u * t * t * b.handleIn.x +
      t * t * t * b.x;
    const y =
      u * u * u * a.y +
      3 * u * u * t * a.handleOut.y +
      3 * u * t * t * b.handleIn.y +
      t * t * t * b.y;
    return { x, y };
  }
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function distToSegment(
  px: number,
  py: number,
  geometry: TimelineGeometry,
  threshold = 0.03
): { segIndex: number; t: number; dist: number } | null {
  const samples = sampleGeometryPath(geometry, 32);
  let best: { segIndex: number; t: number; dist: number } | null = null;
  for (const s of samples) {
    const d = Math.hypot(px - s.x, py - s.y);
    if (d < threshold && (!best || d < best.dist)) {
      best = { segIndex: s.segIndex, t: s.t, dist: d };
    }
  }
  return best;
}

/** Insert a new point on segment at fractional t (0–1 along segment). */
export function insertPointOnSegment(
  geometry: TimelineGeometry,
  segIndex: number,
  t: number
): TimelineGeometry {
  return splitSegmentAt(geometry, segIndex, t).geometry;
}

/** Insert point with proper bezier handles (de Casteljau for cubics). */
export function splitSegmentAt(
  geometry: TimelineGeometry,
  segIndex: number,
  t: number
): { geometry: TimelineGeometry; insertIndex: number } {
  const pts = geometry.points.map((p) => ({ ...p }));
  const segCount = geometry.closed ? pts.length : pts.length - 1;
  if (segIndex < 0 || segIndex >= segCount) {
    return { geometry, insertIndex: segIndex + 1 };
  }

  const a = pts[segIndex];
  const bi = (segIndex + 1) % pts.length;
  const b = pts[bi];
  const insertAt = segIndex + 1;

  if (a.handleOut && b.handleIn) {
    const p0 = { x: a.x, y: a.y };
    const p1 = a.handleOut;
    const p2 = b.handleIn;
    const p3 = { x: b.x, y: b.y };
    const p01 = lerpPt(p0, p1, t);
    const p12 = lerpPt(p1, p2, t);
    const p23 = lerpPt(p2, p3, t);
    const p012 = lerpPt(p01, p12, t);
    const p123 = lerpPt(p12, p23, t);
    const p0123 = lerpPt(p012, p123, t);

    pts[segIndex] = { ...a, handleOut: p01 };
    pts[bi] = { ...b, handleIn: p23 };
    const newPoint: GeometryPoint = {
      x: p0123.x,
      y: p0123.y,
      handleIn: p012,
      handleOut: p123,
    };
    pts.splice(insertAt, 0, newPoint);
    return { geometry: { ...geometry, points: pts }, insertIndex: insertAt };
  }

  const mid = pointOnSegment(a, b, t);
  const tangent = { x: b.x - a.x, y: b.y - a.y };
  const len = Math.hypot(tangent.x, tangent.y) || 1;
  const off = 0.15 * len;
  const tx = tangent.x / len;
  const ty = tangent.y / len;
  const newPoint: GeometryPoint = {
    x: mid.x,
    y: mid.y,
    handleIn: { x: mid.x - tx * off, y: mid.y - ty * off },
    handleOut: { x: mid.x + tx * off, y: mid.y + ty * off },
  };
  pts.splice(insertAt, 0, newPoint);
  return { geometry: { ...geometry, points: pts }, insertIndex: insertAt };
}

/** Bend a segment by placing shared cubic control at midHandle. */
export function bendSegment(
  geometry: TimelineGeometry,
  segIndex: number,
  midHandle: { x: number; y: number }
): TimelineGeometry {
  const pts = geometry.points.map((p) => ({ ...p }));
  const segCount = geometry.closed ? pts.length : pts.length - 1;
  if (segIndex < 0 || segIndex >= segCount) return geometry;

  const bi = (segIndex + 1) % pts.length;
  pts[segIndex] = { ...pts[segIndex], handleOut: { x: midHandle.x, y: midHandle.y } };
  pts[bi] = { ...pts[bi], handleIn: { x: midHandle.x, y: midHandle.y } };
  return { ...geometry, points: pts };
}

export function segmentControlOrigin(
  a: GeometryPoint,
  b: GeometryPoint
): { x: number; y: number } {
  if (a.handleOut) return { x: a.handleOut.x, y: a.handleOut.y };
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function pointInBounds(
  x: number,
  y: number,
  bounds: GeometryBounds
): boolean {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

export function localFromScreen(
  sx: number,
  sy: number,
  rectLeft: number,
  rectTop: number,
  rectW: number,
  rectH: number,
  clamp = true
): { x: number; y: number } {
  const x = rectW > 0 ? (sx - rectLeft) / rectW : 0;
  const y = rectH > 0 ? (sy - rectTop) / rectH : 0;
  if (!clamp) return { x, y };
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
  };
}

export function screenFromLocal(
  lx: number,
  ly: number,
  rectLeft: number,
  rectTop: number,
  rectW: number,
  rectH: number
): { x: number; y: number } {
  return {
    x: rectLeft + lx * rectW,
    y: rectTop + ly * rectH,
  };
}
