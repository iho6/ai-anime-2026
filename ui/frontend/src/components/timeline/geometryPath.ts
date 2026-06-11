import type { GeometryPoint, TimelineGeometry } from "../../lib/api";
import { VECTOR_ARTBOARD_SIZE } from "./geometryTemplates";

const ARTBOARD = VECTOR_ARTBOARD_SIZE;

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
  const pts = [...geometry.points];
  const segCount = geometry.closed ? pts.length : pts.length - 1;
  if (segIndex < 0 || segIndex >= segCount) return geometry;

  const a = pts[segIndex];
  const b = pts[(segIndex + 1) % pts.length];
  const mid = pointOnSegment(a, b, t);

  const newPoint: GeometryPoint = { x: mid.x, y: mid.y };
  const insertAt = segIndex + 1;
  pts.splice(insertAt, 0, newPoint);
  return { ...geometry, points: pts };
}

export function localFromScreen(
  sx: number,
  sy: number,
  rectLeft: number,
  rectTop: number,
  rectW: number,
  rectH: number
): { x: number; y: number } {
  const x = rectW > 0 ? (sx - rectLeft) / rectW : 0;
  const y = rectH > 0 ? (sy - rectTop) / rectH : 0;
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
