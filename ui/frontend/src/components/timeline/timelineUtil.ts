import { assetUrlFromRelPath, apiTimelineImportPngBase64 } from "../../lib/api";
import type {
  GeometryTemplate,
  TimelineClip,
  TimelineGeometry,
  TimelineManifest,
  TimelineTrack,
} from "../../lib/api";
import { cloneTimelineGeometry, createGeometryData, VECTOR_ARTBOARD_SIZE } from "./geometryTemplates";
import { rasterizeGeometryToPngBase64 } from "./geometryRasterize";
import { estimateTextClipNaturalSize } from "./textMeasure";
import { resolveTrajectoryTransformAt } from "./trajectoryMotion";
import { layersForTransition } from "./transitionEffects";
import type { TransitionActiveLayer } from "./transitionEffects";

export type { TransitionActiveLayer as ActiveLayer } from "./transitionEffects";

export type ClipTransform = {
  x: number;
  y: number;
  scale: number;
  rotation?: number;
  opacity?: number;
};
export type ClipRect = { left: number; top: number; width: number; height: number };

export const IMAGE_CLIP_DEFAULT_SEC = 3;

let _idSeq = 0;
export function genId(prefix: string): string {
  _idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idSeq}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Visual selection outline (pointer-events none); below interactive hit targets. */
export const PREVIEW_SELECTION_CHROME_Z = 300;

/** Interactive clip hit targets stack above selection chrome. */
export const PREVIEW_HIT_Z = 310;
/**
 * Integer gap per track so CSS z-index (integer-only) keeps higher tracks on top.
 * Fractional steps (e.g. 0.01) collapse to the same integer and lower tracks steal clicks.
 */
export const PREVIEW_HIT_TRACK_STEP = 2;

/**
 * Trajectory / geometry / text edit overlays sit above clip hit targets.
 * Headroom allows ~90 tracks at PREVIEW_HIT_TRACK_STEP before colliding.
 */
export const PREVIEW_EDIT_Z = 500;
/** Scale handles for selection and trajectory ghost. */
export const PREVIEW_HANDLE_Z = 501;
/** Trajectory toolbar, style bars, etc. */
export const PREVIEW_EDIT_TOOLBAR_Z = 502;

export const PREVIEW_NUDGE_PX = 1;
export const PREVIEW_NUDGE_SHIFT_PX = 8;

/** Trajectory waypoint pointer targets: capped so zoomed clips stay clickable. */
export const TRAJECTORY_WAYPOINT_HIT_MIN_PX = 32;
export const TRAJECTORY_WAYPOINT_HIT_MAX_PX = 64;
export const TRAJECTORY_WAYPOINT_HIT_BASE_PX = 40;

/** Hit radius (px) around a waypoint diamond; scales mildly with clip scale, capped. */
export function trajectoryWaypointHitRadiusPx(scale: number): number {
  const s = Math.max(0.1, scale ?? 1);
  const sized = TRAJECTORY_WAYPOINT_HIT_BASE_PX * 0.5 * Math.sqrt(s);
  return clamp(sized, TRAJECTORY_WAYPOINT_HIT_MIN_PX / 2, TRAJECTORY_WAYPOINT_HIT_MAX_PX / 2);
}

/** Square hit rect centered on a waypoint (SVG / frame px). */
export function trajectoryWaypointHitRectAt(
  centerSx: number,
  centerSy: number,
  scale: number
): ClipRect {
  const r = trajectoryWaypointHitRadiusPx(scale);
  return { left: centerSx - r, top: centerSy - r, width: r * 2, height: r * 2 };
}

export function pointInTrajectoryWaypointHit(
  sx: number,
  sy: number,
  centerSx: number,
  centerSy: number,
  scale: number
): boolean {
  const { left, top, width, height } = trajectoryWaypointHitRectAt(centerSx, centerSy, scale);
  return sx >= left && sx <= left + width && sy >= top && sy <= top + height;
}

/** Preview hit-target stacking: track order dominates; selected tie-break (+1). */
export function previewClipHitZIndex(opts: {
  trackZ: number;
  selected: boolean;
}): number {
  return (
    PREVIEW_HIT_Z +
    opts.trackZ * PREVIEW_HIT_TRACK_STEP +
    (opts.selected ? 1 : 0)
  );
}

/**
 * Pointer displacement in frame-local space, compensating for the preview frame
 * shifting on screen when drag padding/scroll changes layout under the cursor.
 */
export function pointerClientDeltaInFrameSpace(params: {
  clientX: number;
  clientY: number;
  startClientX: number;
  startClientY: number;
  frameLeft: number;
  frameTop: number;
  startFrameLeft: number;
  startFrameTop: number;
}): { dx: number; dy: number } {
  const shiftX = params.frameLeft - params.startFrameLeft;
  const shiftY = params.frameTop - params.startFrameTop;
  return {
    dx: params.clientX - params.startClientX - shiftX,
    dy: params.clientY - params.startClientY - shiftY,
  };
}

/** Apply a pixel nudge to fractional clip transform (preview frame space). */
export function nudgeClipTransform(
  tf: ClipTransform,
  dxPx: number,
  dyPx: number,
  frameW: number,
  frameH: number
): ClipTransform {
  return {
    ...tf,
    x: tf.x + (frameW > 0 ? dxPx / frameW : 0),
    y: tf.y + (frameH > 0 ? dyPx / frameH : 0),
  };
}

/** Logical output frame for fit math (preview + export reference). */
export function referenceFrameSize(
  previewAspect: TimelineManifest["previewAspect"]
): { w: number; h: number } {
  const w = 1920;
  const h = Math.round(w / aspectRatio(previewAspect));
  return { w, h };
}

/** Contained box size for an image inside a frame (same math as imageRectFor). */
export function containedBoxSize(
  nW: number,
  nH: number,
  frameW: number,
  frameH: number
): { w: number; h: number } {
  let baseW = frameW;
  let baseH = frameH;
  if (nW > 0 && nH > 0 && frameW > 0 && frameH > 0) {
    const imgA = nW / nH;
    const frmA = frameW / frameH;
    if (imgA > frmA) {
      baseW = frameW;
      baseH = frameW / imgA;
    } else {
      baseH = frameH;
      baseW = frameH * imgA;
    }
  }
  return { w: baseW, h: baseH };
}

/**
 * On-screen rectangle (in frame px) of a clip's displayed image, given the
 * frame size + the clip's natural aspect + its transform. Matches an
 * ``object-fit: contain`` base box, then applies scale (about center) and the
 * fractional translate.
 */
export function clipImageRect(
  clip: TimelineClip,
  tf: ClipTransform,
  frameW: number,
  frameH: number
): ClipRect {
  const nW = clip.naturalW ?? 0;
  const nH = clip.naturalH ?? 0;
  const { w: baseW, h: baseH } = containedBoxSize(nW, nH, frameW, frameH);
  const w = baseW * tf.scale;
  const h = baseH * tf.scale;
  const cx = frameW / 2 + tf.x * frameW;
  const cy = frameH / 2 + tf.y * frameH;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
}

export const PREVIEW_ALIGN_SNAP_PX = 8;

export type AlignGuide = {
  axis: "x" | "y";
  pos: number;
  kind: "center" | "border";
};

/** Inverse of clipImageRect: fractional x/y from a rect's center position. */
export function clipTransformFromRectCenter(
  rect: ClipRect,
  frameW: number,
  frameH: number
): Pick<ClipTransform, "x" | "y"> {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return {
    x: frameW > 0 ? (cx - frameW / 2) / frameW : 0,
    y: frameH > 0 ? (cy - frameH / 2) / frameH : 0,
  };
}

type SnapCandidate = { delta: number; guide: AlignGuide };

function snapAxis(
  candidates: SnapCandidate[],
  thresholdPx: number
): { delta: number; guide: AlignGuide | null } {
  let bestDelta = 0;
  let bestDist = thresholdPx;
  let bestGuide: AlignGuide | null = null;
  for (const c of candidates) {
    const dist = Math.abs(c.delta);
    if (dist < bestDist) {
      bestDist = dist;
      bestDelta = c.delta;
      bestGuide = c.guide;
    }
  }
  return { delta: bestDelta, guide: bestGuide };
}

/** Shift a clip rect by pointer delta (preview move drag). */
export function translateClipRect(rect: ClipRect, dxPx: number, dyPx: number): ClipRect {
  return {
    ...rect,
    left: rect.left + dxPx,
    top: rect.top + dyPx,
  };
}

/** Minimum on-screen strip (px) kept inside the frame so a dragged clip stays reachable. */
export const PREVIEW_MIN_VISIBLE_PX = 24;

export type PreviewFrameExtension = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export const PREVIEW_FRAME_EXTENSION_NONE: PreviewFrameExtension = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

export const PREVIEW_OVERFLOW_PAD_PX = 32;

export function mergePreviewFrameExtension(
  a: PreviewFrameExtension,
  b: PreviewFrameExtension
): PreviewFrameExtension {
  return {
    top: Math.max(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
    left: Math.max(a.left, b.left),
  };
}

/**
 * Display-only growth past a drag-start baseline so already-overflowing clips
 * do not instantly open a huge canvas; pad grows as the gesture pushes further out.
 */
export function growExtensionFromBaseline(
  current: PreviewFrameExtension,
  baseline: PreviewFrameExtension
): PreviewFrameExtension {
  return {
    top: Math.max(0, current.top - baseline.top),
    right: Math.max(0, current.right - baseline.right),
    bottom: Math.max(0, current.bottom - baseline.bottom),
    left: Math.max(0, current.left - baseline.left),
  };
}

/** Map inner-frame clip rect to extended-layer local coords (inside negative inset). */
export function clipRectInExtendedLayer(
  rect: ClipRect,
  extend: PreviewFrameExtension
): ClipRect {
  return {
    left: rect.left + extend.left,
    top: rect.top + extend.top,
    width: rect.width,
    height: rect.height,
  };
}

/** Dimmed opacity for clip pixels outside the white frame during pointer drag. */
export const PREVIEW_OUTSIDE_FRAME_OPACITY = 0.35;

/**
 * clip-path polygon (evenodd) for the extended canvas that excludes the inner
 * frame rectangle — used to render only out-of-frame pixels in the overflow pass.
 * Coordinates are in extended-layer local space (origin = top-left of extended box).
 */
export function clipPathOutsideInnerFrame(
  frameW: number,
  frameH: number,
  extend: PreviewFrameExtension
): string {
  const W = frameW + extend.left + extend.right;
  const H = frameH + extend.top + extend.bottom;
  if (W <= 0 || H <= 0) return "polygon(0 0, 0 0, 0 0)";
  const L = extend.left;
  const T = extend.top;
  const R = L + frameW;
  const B = T + frameH;
  return `polygon(evenodd, 0 0, ${W}px 0, ${W}px ${H}px, 0 ${H}px, 0 0, ${L}px ${T}px, ${R}px ${T}px, ${R}px ${B}px, ${L}px ${B}px, ${L}px ${T}px)`;
}

/** Overflow (+ pad) required to fit the given clip rects inside an expandable canvas. */
export function previewFrameExtensionForRects(
  rects: ClipRect[],
  frameW: number,
  frameH: number,
  padPx = PREVIEW_OVERFLOW_PAD_PX
): PreviewFrameExtension {
  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;
  if (frameW <= 0 || frameH <= 0) {
    return PREVIEW_FRAME_EXTENSION_NONE;
  }
  for (const rect of rects) {
    top = Math.max(top, Math.max(0, -rect.top));
    left = Math.max(left, Math.max(0, -rect.left));
    right = Math.max(right, Math.max(0, rect.left + rect.width - frameW));
    bottom = Math.max(bottom, Math.max(0, rect.top + rect.height - frameH));
  }
  // Pad only sides that actually overflow — never grow empty axes.
  const edge = (v: number) => (v > 0 ? Math.ceil(v + padPx) : 0);
  return {
    top: edge(top),
    right: edge(right),
    bottom: edge(bottom),
    left: edge(left),
  };
}

/** Equal padding on all sides (max of edges) so the inner frame stays visually centered. */
export function symmetricPreviewFrameExtension(
  ext: PreviewFrameExtension
): PreviewFrameExtension {
  const m = Math.max(ext.top, ext.right, ext.bottom, ext.left);
  return { top: m, right: m, bottom: m, left: m };
}

/** Extra px above waypoint diamond for the number badge in trajectory edit UI. */
const TRAJECTORY_WAYPOINT_BADGE_PX = 12;

/** Display margin for trajectory edit from waypoint hits (+ optional clip rect at playhead). */
export function computeTrajectoryEditFrameExtension(
  waypoints: NonNullable<TimelineClip["trajectory"]>["waypoints"],
  frameW: number,
  frameH: number,
  padPx = PREVIEW_OVERFLOW_PAD_PX,
  clipBounds?: ClipRect | null
): PreviewFrameExtension {
  if (frameW <= 0 || frameH <= 0) {
    return PREVIEW_FRAME_EXTENSION_NONE;
  }
  const rects: ClipRect[] = [];
  if (clipBounds) rects.push(clipBounds);
  for (const wp of waypoints) {
    const sx = frameW / 2 + wp.x * frameW;
    const sy = frameH / 2 + wp.y * frameH;
    const r = trajectoryWaypointHitRadiusPx(wp.scale ?? 1);
    rects.push({
      left: sx - r,
      top: sy - r - TRAJECTORY_WAYPOINT_BADGE_PX,
      width: r * 2,
      height: r * 2 + TRAJECTORY_WAYPOINT_BADGE_PX,
    });
  }
  if (rects.length === 0) return PREVIEW_FRAME_EXTENSION_NONE;
  return previewFrameExtensionForRects(rects, frameW, frameH, padPx);
}

function clipHasPreviewDimensions(clip: TimelineClip): boolean {
  if (clip.type === "geometry" || clip.type === "text") return true;
  return (clip.naturalW ?? 0) > 0 && (clip.naturalH ?? 0) > 0;
}

/** Max clip overflow beyond base frame on each side (+ pad), in frame px. */
export function computePreviewFrameExtension(
  clips: TimelineClip[],
  playhead: number,
  frameW: number,
  frameH: number,
  padPx = PREVIEW_OVERFLOW_PAD_PX
): PreviewFrameExtension {
  let top = 0;
  let right = 0;
  let bottom = 0;
  let left = 0;
  if (frameW <= 0 || frameH <= 0) {
    return PREVIEW_FRAME_EXTENSION_NONE;
  }
  for (const clip of clips) {
    if (!clipHasPreviewDimensions(clip)) continue;
    const tf = clipTransformAtPlayhead(clip, playhead);
    const rect = clipImageRect(clip, tf, frameW, frameH);
    top = Math.max(top, Math.max(0, -rect.top));
    left = Math.max(left, Math.max(0, -rect.left));
    right = Math.max(right, Math.max(0, rect.left + rect.width - frameW));
    bottom = Math.max(bottom, Math.max(0, rect.top + rect.height - frameH));
  }
  const edge = (v: number) => (v > 0 ? Math.ceil(v + padPx) : 0);
  return {
    top: edge(top),
    right: edge(right),
    bottom: edge(bottom),
    left: edge(left),
  };
}

/**
 * Keep a dragged clip reachable: at least `minVisible` px of the rect must remain
 * inside the expanded canvas on each axis (or 10% of the smaller frame dimension,
 * whichever is larger). Large scaled clips still move freely, they just can't leave a
 * grabbable strip inside the canvas.
 *
 * Rects and the returned position use **inner-frame coordinates** (0,0 = white-frame
 * top-left). Top/left extension opens the canvas into negative coords
 * (`[-extend.top, frameH + extend.bottom]`), not a shifted positive origin.
 */
export function clampClipRectToFrame(
  rect: ClipRect,
  frameW: number,
  frameH: number,
  minVisiblePx = PREVIEW_MIN_VISIBLE_PX,
  extend: PreviewFrameExtension = PREVIEW_FRAME_EXTENSION_NONE
): ClipRect {
  const { left, top, width, height } = rect;
  const minVisible = Math.max(minVisiblePx, 0.1 * Math.min(frameW, frameH));

  const clampAxis = (
    pos: number,
    size: number,
    marginBefore: number,
    baseExtent: number,
    marginAfter: number
  ): number => {
    // Canvas span in frame space: [-marginBefore, baseExtent + marginAfter]
    const lo = -marginBefore + minVisible - size;
    const hi = baseExtent + marginAfter - minVisible;
    if (lo > hi) return pos;
    return clamp(pos, lo, hi);
  };

  return {
    left: clampAxis(left, width, extend.left, frameW, extend.right),
    top: clampAxis(top, height, extend.top, frameH, extend.bottom),
    width,
    height,
  };
}

/**
 * Snap clip rect to frame center and near borders only.
 * Border targets are included only when that edge is within threshold of the frame
 * (avoids oversized scaled clips fighting snap far off-screen).
 */
export function snapClipRectToFrameScaleAware(
  rect: ClipRect,
  frameW: number,
  frameH: number,
  thresholdPx = PREVIEW_ALIGN_SNAP_PX
): { rect: ClipRect; guides: AlignGuide[] } {
  const guides: AlignGuide[] = [];
  let { left, top, width, height } = rect;

  const cx = left + width / 2;
  const right = left + width;
  const xCandidates: SnapCandidate[] = [
    { delta: frameW / 2 - cx, guide: { axis: "x", pos: frameW / 2, kind: "center" } },
  ];
  if (Math.abs(left) < thresholdPx) {
    xCandidates.push({ delta: -left, guide: { axis: "x", pos: 0, kind: "border" } });
  }
  if (Math.abs(frameW - right) < thresholdPx) {
    xCandidates.push({
      delta: frameW - right,
      guide: { axis: "x", pos: frameW, kind: "border" },
    });
  }
  const xSnap = snapAxis(xCandidates, thresholdPx);
  left += xSnap.delta;
  if (xSnap.guide) guides.push(xSnap.guide);

  const cy = top + height / 2;
  const bottom = top + height;
  const yCandidates: SnapCandidate[] = [
    { delta: frameH / 2 - cy, guide: { axis: "y", pos: frameH / 2, kind: "center" } },
  ];
  if (Math.abs(top) < thresholdPx) {
    yCandidates.push({ delta: -top, guide: { axis: "y", pos: 0, kind: "border" } });
  }
  if (Math.abs(frameH - bottom) < thresholdPx) {
    yCandidates.push({
      delta: frameH - bottom,
      guide: { axis: "y", pos: frameH, kind: "border" },
    });
  }
  const ySnap = snapAxis(yCandidates, thresholdPx);
  top += ySnap.delta;
  if (ySnap.guide) guides.push(ySnap.guide);

  return { rect: { left, top, width, height }, guides };
}

/** Snap clip rect to frame center and borders; nearest target per axis within threshold. */
export function snapClipRectToFrame(
  rect: ClipRect,
  frameW: number,
  frameH: number,
  thresholdPx = PREVIEW_ALIGN_SNAP_PX
): { rect: ClipRect; guides: AlignGuide[] } {
  const guides: AlignGuide[] = [];
  let { left, top, width, height } = rect;

  const cx = left + width / 2;
  const right = left + width;
  const xSnap = snapAxis(
    [
      { delta: frameW / 2 - cx, guide: { axis: "x", pos: frameW / 2, kind: "center" } },
      { delta: -left, guide: { axis: "x", pos: 0, kind: "border" } },
      { delta: frameW - right, guide: { axis: "x", pos: frameW, kind: "border" } },
    ],
    thresholdPx
  );
  left += xSnap.delta;
  if (xSnap.guide) guides.push(xSnap.guide);

  const cy = top + height / 2;
  const bottom = top + height;
  const ySnap = snapAxis(
    [
      { delta: frameH / 2 - cy, guide: { axis: "y", pos: frameH / 2, kind: "center" } },
      { delta: -top, guide: { axis: "y", pos: 0, kind: "border" } },
      { delta: frameH - bottom, guide: { axis: "y", pos: frameH, kind: "border" } },
    ],
    thresholdPx
  );
  top += ySnap.delta;
  if (ySnap.guide) guides.push(ySnap.guide);

  return { rect: { left, top, width, height }, guides };
}

/** Pixel-anchored preview move: translate start rect by pointer delta, snap, convert to transform. */
export function previewMoveTransformFromPointerDelta(params: {
  orig: ClipTransform;
  startRect: ClipRect;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  frameW: number;
  frameH: number;
  extend?: PreviewFrameExtension;
}): { to: ClipTransform; guides: AlignGuide[]; extend: PreviewFrameExtension } {
  const {
    orig,
    startRect,
    startClientX,
    startClientY,
    clientX,
    clientY,
    frameW,
    frameH,
    extend = PREVIEW_FRAME_EXTENSION_NONE,
  } = params;
  const dx = clientX - startClientX;
  const dy = clientY - startClientY;
  const rawRect = translateClipRect(startRect, dx, dy);
  const { rect: snappedRect, guides } = snapClipRectToFrameScaleAware(
    rawRect,
    frameW,
    frameH
  );
  const activeExtend = mergePreviewFrameExtension(
    extend,
    previewFrameExtensionForRects([snappedRect], frameW, frameH)
  );
  const clampedRect = clampClipRectToFrame(
    snappedRect,
    frameW,
    frameH,
    PREVIEW_MIN_VISIBLE_PX,
    activeExtend
  );
  const { x, y } = clipTransformFromRectCenter(clampedRect, frameW, frameH);
  return {
    to: { ...orig, x, y },
    guides,
    extend: activeExtend,
  };
}

const MIN_CLIP_SCALE = 0.1;
const MAX_CLIP_SCALE = 6;

/**
 * Alignment guides while scaling from the transform center (bottom-right handle).
 * Scale is not snapped to borders — clips stay centered and can grow past frame edges.
 */
export function snapClipScaleToFrame(
  clip: TimelineClip,
  tf: ClipTransform,
  frameW: number,
  frameH: number,
  thresholdPx = PREVIEW_ALIGN_SNAP_PX
): { scale: number; guides: AlignGuide[] } {
  const scale = clamp(tf.scale, MIN_CLIP_SCALE, MAX_CLIP_SCALE);
  const nW = clip.naturalW ?? 0;
  const nH = clip.naturalH ?? 0;
  const { w: baseW, h: baseH } = containedBoxSize(nW, nH, frameW, frameH);
  if (baseW <= 0 || baseH <= 0 || frameW <= 0 || frameH <= 0) {
    return { scale, guides: [] };
  }

  const rect = clipImageRect(clip, { ...tf, scale }, frameW, frameH);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const guides: AlignGuide[] = [];

  if (Math.abs(rect.left) < thresholdPx) {
    guides.push({ axis: "x", pos: 0, kind: "border" });
  }
  if (Math.abs(frameW - right) < thresholdPx) {
    guides.push({ axis: "x", pos: frameW, kind: "border" });
  }
  if (Math.abs(rect.top) < thresholdPx) {
    guides.push({ axis: "y", pos: 0, kind: "border" });
  }
  if (Math.abs(frameH - bottom) < thresholdPx) {
    guides.push({ axis: "y", pos: frameH, kind: "border" });
  }

  return { scale, guides };
}

/** Effective transform at playhead (trajectory + motion when present). */
export function clipTransformAtPlayhead(clip: TimelineClip, playhead: number): ClipTransform {
  const traj = resolveTrajectoryTransformAt(clip, playhead, { applyMotion: true });
  if (traj) return traj;
  return clip.transform ?? defaultImageClipTransform();
}

export function clipHasEditableTrajectory(clip: TimelineClip): boolean {
  return (clip.trajectory?.waypoints?.length ?? 0) >= 2;
}

/** Apply preview drag delta to all trajectory waypoints (move whole path or uniform scale). */
export function applyPreviewDragToTrajectory(
  clip: TimelineClip,
  from: Pick<ClipTransform, "x" | "y" | "scale">,
  to: Pick<ClipTransform, "x" | "y" | "scale">,
  mode: "move" | "scale"
): NonNullable<TimelineClip["trajectory"]> | null {
  const traj = clip.trajectory;
  if (!traj || traj.waypoints.length < 2) return null;

  if (mode === "move") {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return {
      ...traj,
      waypoints: traj.waypoints.map((w) => ({
        ...w,
        x: w.x + dx,
        y: w.y + dy,
      })),
    };
  }

  const ratio = from.scale > 1e-6 ? to.scale / from.scale : 1;
  return {
    ...traj,
    waypoints: traj.waypoints.map((w) => ({
      ...w,
      scale: clamp((w.scale ?? 1) * ratio, 0.1, 6),
    })),
  };
}

/** Initial transform for a newly imported image: centered, scale 1 (contain handled in layout). */
export function defaultImageClipTransform(): ClipTransform {
  return { x: 0, y: 0, scale: 1 };
}

/** Initial transform for vector clips (geometry/text): centered, moderate scale. */
export function defaultVectorClipTransform(): ClipTransform {
  return { x: 0, y: 0, scale: 0.35 };
}

export { VECTOR_ARTBOARD_SIZE };

/** Build a standard image clip object for addClip(). */
export function buildAudioClip(params: {
  srcRelPath: string;
  durationSec: number;
  start?: number;
  /** EBU R128 loudness correction from import analysis (default 1). */
  normalizationGain?: number;
}): TimelineClip {
  const dur = Math.max(0.05, params.durationSec);
  const clip: TimelineClip = {
    id: genId("clip"),
    type: "audio",
    srcRelPath: params.srcRelPath,
    start: params.start ?? 0,
    inPoint: 0,
    outPoint: dur,
    speed: 1,
    duration: dur,
    srcDuration: dur,
  };
  if (
    typeof params.normalizationGain === "number" &&
    params.normalizationGain > 0 &&
    Math.abs(params.normalizationGain - 1) > 1e-3
  ) {
    clip.normalizationGain = params.normalizationGain;
  }
  return clip;
}

export type VideoBgReplaceTimingFallback = {
  inPoint?: number;
  outPoint?: number;
  speed?: number;
  reversed?: boolean;
  /** Full source media length before trim (seconds). */
  srcDuration?: number;
  /** Timeline span on the sequence (seconds); not source trim. */
  duration?: number;
};

export type VideoBgReplaceProbe = {
  durationSec?: number;
  fps?: number;
  frames?: number;
};

/** Preserve trim + timeline span when swapping in a bg-removed video. */
export function resolveVideoBgReplaceTiming(
  probe: VideoBgReplaceProbe,
  fallback: VideoBgReplaceTimingFallback
): {
  inPoint: number;
  outPoint: number;
  speed: number;
  srcDuration: number;
  duration: number;
} {
  const probedDur = Math.max(0, probe.durationSec ?? 0);
  const fromFrames =
    probe.frames != null && probe.fps != null && probe.fps > 0
      ? probe.frames / probe.fps
      : 0;
  const mediaDur = Math.max(probedDur, fromFrames);

  const inPoint = fallback.inPoint ?? 0;
  const preservedOut = fallback.outPoint;
  const preservedSrcDur = fallback.srcDuration ?? preservedOut ?? 0;

  // Never let a short probe or timeline duration shrink below the user's prior trim.
  const sourceDur =
    Math.max(mediaDur, preservedSrcDur, preservedOut ?? 0) ||
    mediaDur ||
    preservedSrcDur ||
    5;

  let outPoint = preservedOut ?? sourceDur;
  outPoint = Math.min(Math.max(outPoint, inPoint + 0.001), sourceDur);

  const speed = fallback.speed ?? 1;
  const span = Math.max(0.001, outPoint - inPoint);
  const duration =
    fallback.duration != null && fallback.duration > 0
      ? fallback.duration
      : Math.max(0.05, span / speed);

  return { inPoint, outPoint, speed, srcDuration: sourceDur, duration };
}

export function buildVideoClip(params: {
  srcRelPath: string;
  durationSec: number;
  width: number;
  height: number;
  start?: number;
}): TimelineClip {
  const dur = Math.max(0.05, params.durationSec);
  return {
    id: genId("clip"),
    type: "video",
    srcRelPath: params.srcRelPath,
    start: params.start ?? 0,
    inPoint: 0,
    outPoint: dur,
    speed: 1,
    duration: dur,
    srcDuration: dur,
    ...(params.width > 0 ? { naturalW: params.width } : {}),
    ...(params.height > 0 ? { naturalH: params.height } : {}),
    transform: defaultImageClipTransform(),
  };
}

export function buildImageClip(params: {
  srcRelPath: string;
  width: number;
  height: number;
  source?: TimelineClip["source"];
  start?: number;
  durationSec?: number;
}): TimelineClip {
  const dur = params.durationSec ?? IMAGE_CLIP_DEFAULT_SEC;
  return {
    id: genId("clip"),
    type: "image",
    srcRelPath: params.srcRelPath,
    start: params.start ?? 0,
    inPoint: 0,
    outPoint: dur,
    speed: 1,
    duration: dur,
    ...(params.width > 0 ? { naturalW: params.width } : {}),
    ...(params.height > 0 ? { naturalH: params.height } : {}),
    ...(params.source ? { source: params.source } : {}),
    transform: defaultImageClipTransform(),
  };
}

export function buildGeometryClip(params: {
  template: GeometryTemplate;
  geometry?: TimelineGeometry;
  start?: number;
  durationSec?: number;
}): TimelineClip {
  const dur = params.durationSec ?? IMAGE_CLIP_DEFAULT_SEC;
  return {
    id: genId("clip"),
    type: "geometry",
    srcRelPath: "",
    start: params.start ?? 0,
    inPoint: 0,
    outPoint: dur,
    speed: 1,
    duration: dur,
    naturalW: VECTOR_ARTBOARD_SIZE,
    naturalH: VECTOR_ARTBOARD_SIZE,
    transform: defaultVectorClipTransform(),
    geometry: params.geometry ?? createGeometryData(params.template),
  };
}

export function buildTextClip(params: {
  content?: string;
  start?: number;
  durationSec?: number;
  fontFamilyId?: string;
}): TimelineClip {
  const dur = params.durationSec ?? IMAGE_CLIP_DEFAULT_SEC;
  const text = {
    content: params.content ?? "Text",
    fontFamilyId: params.fontFamilyId ?? "inter",
    fontWeight: 400,
    fontStyle: "normal" as const,
    fontSize: 48,
    color: "#ffffff",
    align: "center" as const,
  };
  const { width, height } = estimateTextClipNaturalSize(text);
  return {
    id: genId("clip"),
    type: "text",
    srcRelPath: "",
    start: params.start ?? 0,
    inPoint: 0,
    outPoint: dur,
    speed: 1,
    duration: dur,
    naturalW: width,
    naturalH: height,
    transform: defaultVectorClipTransform(),
    text,
  };
}

export function clipActsAsImage(clip: TimelineClip): boolean {
  return clip.type === "image" || clip.type === "geometry";
}

export function clipTrackLabel(clip: TimelineClip): string {
  if (clip.type === "image" && clip.source?.combined) return "combined";
  if (clip.type === "text" && clip.text?.content) {
    const t = clip.text.content.trim();
    return t.length > 18 ? `${t.slice(0, 18)}…` : t || "text";
  }
  return clip.type;
}

export function loadImageDimensionsFromUrl(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not load image dimensions."));
    img.src = url;
  });
}

/** Resolve dimensions from API result, falling back to client-side image load. */
export async function resolveImportDimensions(
  srcRelPath: string,
  apiWidth: number,
  apiHeight: number
): Promise<{ width: number; height: number }> {
  if (apiWidth > 0 && apiHeight > 0) return { width: apiWidth, height: apiHeight };
  try {
    const dims = await loadImageDimensionsFromUrl(assetUrlFromRelPath(srcRelPath));
    return { width: dims.w, height: dims.h };
  } catch {
    return { width: apiWidth, height: apiHeight };
  }
}

/** Preview box aspect ratio (width / height). */
export function aspectRatio(previewAspect: TimelineManifest["previewAspect"]): number {
  switch (previewAspect) {
    case "4:3":
      return 4 / 3;
    case "1:1":
      return 1;
    case "9:16":
      return 9 / 16;
    case "16:9":
    default:
      return 16 / 9;
  }
}

/** End time (seconds) of a clip on the timeline. */
export function clipEnd(clip: TimelineClip): number {
  return clip.start + Math.max(0, clip.duration);
}

/** Total timeline duration across all tracks/clips (seconds). */
export function timelineDuration(manifest: TimelineManifest): number {
  let max = 0;
  for (const t of manifest.tracks) {
    for (const c of t.clips) {
      max = Math.max(max, clipEnd(c));
    }
  }
  return max;
}

/** Keep the final frame active because clip intervals use an exclusive end. */
export function playbackEndPlayhead(total: number, fps: number): number {
  if (total <= 0) return 0;
  return Math.max(0, total - 1 / Math.max(1, fps));
}

export const CONNECT_EPS = 0.05;
export const TRANSITION_DURATION_MIN = 0.1;
export const TRANSITION_DURATION_MAX = 2.0;
export const DEFAULT_TRANSITION_DURATION = 0.5;

export type ConnectedClipPair = {
  outgoing: TimelineClip;
  incoming: TimelineClip;
  junctionTime: number;
};

export function sortedTrackClips(track: TimelineTrack): TimelineClip[] {
  return [...track.clips].sort((a, b) => a.start - b.start);
}

export function isConnectedPair(outgoing: TimelineClip, incoming: TimelineClip): boolean {
  return Math.abs(clipEnd(outgoing) - incoming.start) <= CONNECT_EPS;
}

export function pruneBrokenTransitions(manifest: TimelineManifest): TimelineManifest {
  return {
    ...manifest,
    tracks: manifest.tracks.map((t) => {
      const pairs = connectedClipPairs(t);
      const outgoingIds = new Set(pairs.map((p) => p.outgoing.id));
      return {
        ...t,
        clips: t.clips.map((c) =>
          c.transitionOut && !outgoingIds.has(c.id)
            ? { ...c, transitionOut: undefined }
            : c
        ),
      };
    }),
  };
}

export function connectedClipPairs(track: TimelineTrack): ConnectedClipPair[] {
  const sorted = sortedTrackClips(track);
  const pairs: ConnectedClipPair[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const outgoing = sorted[i];
    const incoming = sorted[i + 1];
    if (isConnectedPair(outgoing, incoming)) {
      pairs.push({
        outgoing,
        incoming,
        junctionTime: incoming.start,
      });
    }
  }
  return pairs;
}

/** Effective crossfade duration clamped to clip lengths and UI bounds. */
export function effectiveTransitionDuration(
  outgoing: TimelineClip,
  incoming: TimelineClip
): number {
  const raw = outgoing.transitionOut?.duration ?? DEFAULT_TRANSITION_DURATION;
  const capped = clamp(raw, TRANSITION_DURATION_MIN, TRANSITION_DURATION_MAX);
  const maxByClips = Math.min(outgoing.duration, incoming.duration) * 0.5;
  return Math.min(capped, Math.max(TRANSITION_DURATION_MIN, maxByClips));
}

export type TransitionWindow = {
  outgoing: TimelineClip;
  incoming: TimelineClip;
  progress: number;
  duration: number;
};

export function findTransitionWindow(
  track: TimelineTrack,
  t: number
): TransitionWindow | null {
  if (track.kind !== "video") return null;
  const sorted = sortedTrackClips(track);
  for (let i = 1; i < sorted.length; i++) {
    const outgoing = sorted[i - 1];
    const incoming = sorted[i];
    const tr = outgoing.transitionOut;
    if (!tr || !isConnectedPair(outgoing, incoming)) continue;
    const d = effectiveTransitionDuration(outgoing, incoming);
    const fadeStart = incoming.start - d;
    if (t >= fadeStart && t < incoming.start) {
      const progress = d > 0 ? (t - fadeStart) / d : 1;
      return { outgoing, incoming, progress, duration: d };
    }
  }
  return null;
}

function soloLayer(clip: TimelineClip): TransitionActiveLayer {
  return { clip, opacity: 1, role: "solo", progress: 0 };
}

/** How far before a hard-cut junction to mount the incoming clip at opacity 0. */
export const HARD_CUT_PRELOAD_SEC = 0.35;

function preloadLayer(clip: TimelineClip): TransitionActiveLayer {
  return { clip, opacity: 0, role: "solo", progress: 0, preload: true };
}

/** Video-track layers at time t (fade / dissolve / wipe / slide). */
export function activeLayersAt(track: TimelineTrack, t: number): TransitionActiveLayer[] {
  if (track.kind !== "video") {
    for (const c of track.clips) {
      if (t >= c.start && t < clipEnd(c)) {
        return [soloLayer(c)];
      }
    }
    return [];
  }

  const win = findTransitionWindow(track, t);
  if (win && win.outgoing.transitionOut) {
    return layersForTransition(
      win.outgoing,
      win.incoming,
      win.progress,
      win.outgoing.transitionOut
    );
  }

  const sorted = sortedTrackClips(track);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    if (t >= c.start && t < clipEnd(c)) {
      const layers: TransitionActiveLayer[] = [soloLayer(c)];
      const next = sorted[i + 1];
      // Hard cut: start decoding the next clip early so video↔image doesn't flash black.
      if (
        next &&
        isConnectedPair(c, next) &&
        !c.transitionOut &&
        t >= next.start - HARD_CUT_PRELOAD_SEC &&
        t < next.start
      ) {
        layers.push(preloadLayer(next));
      }
      return layers;
    }
  }

  // Float gap within CONNECT_EPS: hold the incoming clip so the playhead isn't empty.
  for (let i = 1; i < sorted.length; i++) {
    const outgoing = sorted[i - 1]!;
    const incoming = sorted[i]!;
    if (!isConnectedPair(outgoing, incoming)) continue;
    const gapLo = Math.min(clipEnd(outgoing), incoming.start);
    const gapHi = Math.max(clipEnd(outgoing), incoming.start);
    if (t >= gapLo && t < gapHi) {
      return [soloLayer(incoming)];
    }
  }

  return [];
}

/** The clip active at time ``t`` on a track (last one wins on overlap). */
export function activeClipAt(track: TimelineTrack, t: number): TimelineClip | null {
  const layers = activeLayersAt(track, t);
  if (layers.length === 0) return null;
  return layers[layers.length - 1].clip;
}

function previewLayerVisible(layer: TransitionActiveLayer): boolean {
  if (layer.preload) return true;
  if (layer.opacity > 0.001) return true;
  if (layer.clipPath) return true;
  if (layer.slideOffsetX || layer.slideOffsetY) return true;
  return false;
}

/** Unique preview clips visible at playhead (matches TimelinePreviewPlayer interaction layers). */
export function collectPreviewInteractionClips(
  manifest: TimelineManifest,
  playhead: number
): TimelineClip[] {
  const seen = new Set<string>();
  const out: TimelineClip[] = [];
  const videoTracks = manifest.tracks.filter((t) => t.kind === "video" || t.kind === undefined);
  for (const track of videoTracks) {
    const layers = activeLayersAt(track, playhead).filter(
      (l) => previewLayerVisible(l) && !l.preload
    );
    for (let j = layers.length - 1; j >= 0; j--) {
      const clip = layers[j]!.clip;
      if (seen.has(clip.id)) continue;
      seen.add(clip.id);
      out.push(clip);
    }
  }
  return out;
}

/** Timeline time for video seek when clip is in fade-in region before its start. */
export function sourceTimeAtWithTransition(
  clip: TimelineClip,
  t: number,
  track: TimelineTrack
): number {
  if (clip.type !== "video") {
    return sourceTimeAt(clip, t);
  }
  const sorted = sortedTrackClips(track);
  const idx = sorted.findIndex((c) => c.id === clip.id);
  if (idx <= 0) return sourceTimeAt(clip, t);

  const outgoing = sorted[idx - 1]!;
  if (!isConnectedPair(outgoing, clip)) {
    return sourceTimeAt(clip, t);
  }

  // Hard-cut preload: pin to the first media frame (don't seek before inPoint).
  if (!outgoing.transitionOut && t < clip.start) {
    return clip.reversed ? clip.outPoint : clip.inPoint;
  }

  if (!outgoing.transitionOut) {
    return sourceTimeAt(clip, t);
  }

  const d = effectiveTransitionDuration(outgoing, clip);
  const fadeStart = clip.start - d;
  if (t >= fadeStart && t < clip.start) {
    const local = Math.max(0, t - fadeStart);
    const speed = clip.speed || 1;
    if (clip.reversed) {
      return clip.outPoint - local * speed;
    }
    return clip.inPoint + local * speed;
  }
  return sourceTimeAt(clip, t);
}

/** Source-media time (seconds) for a video/audio clip at timeline time ``t``. */
export function sourceTimeAt(clip: TimelineClip, t: number): number {
  const local = t - clip.start;
  const speed = clip.speed || 1;
  if (clip.reversed && (clip.type === "video" || clip.type === "audio")) {
    return clip.outPoint - local * speed;
  }
  return clip.inPoint + local * speed;
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function newVideoTrack(name: string): TimelineTrack {
  return { id: genId("trk"), name, kind: "video", clips: [] };
}

export function newAudioTrack(name: string): TimelineTrack {
  return { id: genId("trk"), name, kind: "audio", clips: [] };
}

export function newNeutralTrack(name: string): TimelineTrack {
  return { id: genId("trk"), name, kind: "neutral", clips: [] };
}

export function trackKindForClip(clip: TimelineClip): "video" | "audio" {
  return clip.type === "audio" ? "audio" : "video";
}

export function defaultTrackNameForKind(
  kind: "video" | "audio",
  tracks: TimelineTrack[]
): string {
  if (kind === "audio") {
    return `Music ${tracks.filter((t) => t.kind === "audio").length + 1}`;
  }
  return `Video ${tracks.filter((t) => t.kind === "video").length + 1}`;
}

/** Promote a neutral track to video or audio (renames using standard Video/Music labels). */
export function promoteTrackKind(
  track: TimelineTrack,
  kind: "video" | "audio",
  allTracks: TimelineTrack[]
): TimelineTrack {
  if (track.kind !== "neutral") return track;
  return {
    ...track,
    kind,
    name: defaultTrackNameForKind(kind, allTracks),
  };
}

/** Append a clip to a track, placed at the end of its existing clips. */
export function appendClipToTrack(track: TimelineTrack, clip: TimelineClip): TimelineTrack {
  let start = 0;
  for (const c of track.clips) start = Math.max(start, clipEnd(c));
  return { ...track, clips: [...track.clips, { ...clip, start }] };
}

export function placeExternalMediaBatch(params: {
  manifest: TimelineManifest;
  targetTrackId: string | null;
  startSec: number;
  clips: TimelineClip[];
}): { manifest: TimelineManifest; clipIds: string[] } {
  const startSec = Math.max(0, params.startSec);
  let tracks = [...params.manifest.tracks];
  const usedTrackIds = new Set<string>();
  const groups = new Map<"video" | "audio", TimelineClip[]>();
  const groupOrder: Array<"video" | "audio"> = [];
  for (const clip of params.clips) {
    const kind = trackKindForClip(clip);
    if (!groups.has(kind)) {
      groups.set(kind, []);
      groupOrder.push(kind);
    }
    groups.get(kind)!.push(clip);
  }

  const rangeIsFree = (track: TimelineTrack, endSec: number) =>
    track.clips.every((clip) => clipEnd(clip) <= startSec || clip.start >= endSec);

  for (const kind of groupOrder) {
    const clips = groups.get(kind)!;
    const groupDuration = clips.reduce((sum, clip) => sum + clip.duration, 0);
    const endSec = startSec + groupDuration;
    let trackIndex = -1;

    if (params.targetTrackId && !usedTrackIds.has(params.targetTrackId)) {
      const i = tracks.findIndex((track) => track.id === params.targetTrackId);
      const candidate = tracks[i];
      if (
        candidate &&
        (candidate.kind === kind ||
          (candidate.kind === "neutral" && candidate.clips.length === 0)) &&
        rangeIsFree(candidate, endSec)
      ) {
        trackIndex = i;
      }
    }

    if (trackIndex < 0) {
      for (let i = tracks.length - 1; i >= 0; i--) {
        const candidate = tracks[i];
        if (
          !usedTrackIds.has(candidate.id) &&
          candidate.kind === kind &&
          rangeIsFree(candidate, endSec)
        ) {
          trackIndex = i;
          break;
        }
      }
    }

    if (trackIndex < 0) {
      const name = defaultTrackNameForKind(kind, tracks);
      tracks.push(kind === "audio" ? newAudioTrack(name) : newVideoTrack(name));
      trackIndex = tracks.length - 1;
    }

    let target = tracks[trackIndex];
    if (target.kind === "neutral") {
      target = promoteTrackKind(target, kind, tracks);
    }
    let cursor = startSec;
    const placed = clips.map((clip) => {
      const next = { ...clip, start: cursor };
      cursor += clip.duration;
      return next;
    });
    tracks[trackIndex] = { ...target, clips: [...target.clips, ...placed] };
    usedTrackIds.add(target.id);
  }

  return {
    manifest: { ...params.manifest, tracks },
    clipIds: params.clips.map((clip) => clip.id),
  };
}

/**
 * Move a clip to ``toTrackId``, removing every other copy of ``clip.id`` first.
 * Idempotent: safe to call repeatedly during a drag gesture.
 */
export function moveClipBetweenTracks(
  manifest: TimelineManifest,
  toTrackId: string,
  clip: TimelineClip,
  newStart: number
): TimelineManifest {
  const placed = { ...clip, start: newStart };
  return {
    ...manifest,
    tracks: manifest.tracks.map((t) => {
      const without = t.clips.filter((c) => c.id !== clip.id);
      if (t.id !== toTrackId) {
        return without.length === t.clips.length ? t : { ...t, clips: without };
      }
      const base =
        t.kind === "neutral" && t.clips.length === 0
          ? promoteTrackKind(t, trackKindForClip(clip), manifest.tracks)
          : { ...t, clips: without };
      return { ...base, clips: [...without, placed] };
    }),
  };
}

/** Drop per-track duplicate clip ids; re-id clips that appear on multiple tracks. */
export function dedupeTimelineManifestClips(manifest: TimelineManifest): {
  manifest: TimelineManifest;
  changed: boolean;
} {
  let changed = false;
  const seenGlobal = new Set<string>();

  const tracks = manifest.tracks.map((track) => {
    const seenOnTrack = new Set<string>();
    const clips: TimelineClip[] = [];

    for (const clip of track.clips) {
      if (seenOnTrack.has(clip.id)) {
        changed = true;
        continue;
      }
      seenOnTrack.add(clip.id);

      if (seenGlobal.has(clip.id)) {
        changed = true;
        const reIded = { ...clip, id: genId("clip") };
        seenGlobal.add(reIded.id);
        clips.push(reIded);
      } else {
        seenGlobal.add(clip.id);
        clips.push(clip);
      }
    }

    if (
      clips.length === track.clips.length &&
      clips.every((c, i) => c.id === track.clips[i]?.id)
    ) {
      return track;
    }
    return { ...track, clips };
  });

  if (!changed) return { manifest, changed: false };
  return { manifest: { ...manifest, tracks }, changed: true };
}

function loadHTMLImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

async function loadClipHtmlImage(clip: TimelineClip): Promise<HTMLImageElement> {
  if (clip.type === "geometry") {
    if (!clip.geometry) throw new Error("Geometry clip has no shape data.");
    const b64 = await rasterizeGeometryToPngBase64(clip.geometry);
    return loadHTMLImage(`data:image/png;base64,${b64}`);
  }
  return loadHTMLImage(assetUrlFromRelPath(clip.srcRelPath));
}

async function clipWithResolvedDims(clip: TimelineClip): Promise<TimelineClip> {
  if (clip.type === "geometry") {
    return {
      ...clip,
      naturalW: clip.naturalW ?? VECTOR_ARTBOARD_SIZE,
      naturalH: clip.naturalH ?? VECTOR_ARTBOARD_SIZE,
    };
  }
  const { width, height } = await resolveImportDimensions(
    clip.srcRelPath,
    clip.naturalW ?? 0,
    clip.naturalH ?? 0
  );
  return {
    ...clip,
    ...(width > 0 ? { naturalW: width } : {}),
    ...(height > 0 ? { naturalH: height } : {}),
  };
}

/** Rasterize a geometry clip and import it as a timeline image; return storage path. */
export async function resolveClipImageRelPath(
  timelineKey: string,
  clip: TimelineClip
): Promise<string> {
  if (clip.type === "image") return clip.srcRelPath;
  if (clip.type === "geometry") {
    if (!clip.geometry) throw new Error("Geometry clip has no shape data.");
    const pngBase64 = await rasterizeGeometryToPngBase64(clip.geometry);
    const r = await apiTimelineImportPngBase64({ timelineKey, pngBase64 });
    return r.srcRelPath;
  }
  throw new Error("Clip cannot be used as an image source.");
}

/** Map overlay draw rect from reference-frame coords into backdrop-native pixel placement. */
export function overlayShotLayerPlacement(params: {
  ovRect: ClipRect;
  bgRect: ClipRect;
  overlayNaturalW: number;
  overlayNaturalH: number;
  backdropNaturalW: number;
  backdropNaturalH: number;
}): { x: number; y: number; scale: number } {
  const {
    ovRect,
    bgRect,
    overlayNaturalW,
    overlayNaturalH,
    backdropNaturalW,
    backdropNaturalH,
  } = params;
  const scale = overlayNaturalW > 0 ? ovRect.width / overlayNaturalW : 1;
  const x =
    bgRect.width > 0
      ? (ovRect.left - bgRect.left) * (backdropNaturalW / bgRect.width)
      : 0;
  const y =
    bgRect.height > 0
      ? (ovRect.top - bgRect.top) * (backdropNaturalH / bgRect.height)
      : 0;
  return { x, y, scale };
}

export type TimelineCompositeResult = {
  base64: string;
  bgRect: ClipRect;
  ovRect: ClipRect;
  backdropNaturalW: number;
  backdropNaturalH: number;
  overlayNaturalW: number;
  overlayNaturalH: number;
};

/**
 * Flatten backdrop + overlay to PNG at reference-frame resolution, matching
 * preview layout (contain box + per-clip transform at playhead).
 */
export async function buildTimelineCompositePngBase64(params: {
  backdrop: TimelineClip;
  overlay: TimelineClip;
  previewAspect: TimelineManifest["previewAspect"];
  playhead: number;
}): Promise<TimelineCompositeResult> {
  const backdrop = await clipWithResolvedDims(params.backdrop);
  const overlay = await clipWithResolvedDims(params.overlay);
  const { w: frameW, h: frameH } = referenceFrameSize(params.previewAspect);

  const tfBg = clipTransformAtPlayhead(backdrop, params.playhead);
  const tfOv = clipTransformAtPlayhead(overlay, params.playhead);
  const bgRect = clipImageRect(backdrop, tfBg, frameW, frameH);
  const ovRect = clipImageRect(overlay, tfOv, frameW, frameH);

  const [bgImg, overlayImg] = await Promise.all([
    loadClipHtmlImage(backdrop),
    loadClipHtmlImage(overlay),
  ]);

  const backdropNaturalW = backdrop.naturalW ?? bgImg.naturalWidth;
  const backdropNaturalH = backdrop.naturalH ?? bgImg.naturalHeight;
  const overlayNaturalW = overlay.naturalW ?? overlayImg.naturalWidth;
  const overlayNaturalH = overlay.naturalH ?? overlayImg.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = frameW;
  canvas.height = frameH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");
  const context = ctx;

  function drawLayer(
    img: HTMLImageElement,
    rect: ClipRect,
    tf: ClipTransform
  ) {
    const rot = tf.rotation ?? 0;
    const op = tf.opacity ?? 1;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    context.save();
    context.globalAlpha = op;
    context.translate(cx, cy);
    if (rot !== 0) context.rotate((rot * Math.PI) / 180);
    context.drawImage(img, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
    context.restore();
  }

  drawLayer(bgImg, bgRect, tfBg);
  drawLayer(overlayImg, ovRect, tfOv);

  const base64 = canvas.toDataURL("image/png").split(",", 2)[1] ?? "";

  return {
    base64,
    bgRect,
    ovRect,
    backdropNaturalW,
    backdropNaturalH,
    overlayNaturalW,
    overlayNaturalH,
  };
}

export type TimelineClipClipboardItem = {
  trackId: string;
  start: number;
  clip: TimelineClip;
};

export type TimelineClipClipboard = {
  anchorStart: number;
  items: TimelineClipClipboardItem[];
};

/** Deep-clone a clip for paste (new id; same asset paths). */
export function cloneTimelineClipForPaste(clip: TimelineClip): TimelineClip {
  return {
    ...clip,
    id: genId("clip"),
    transform: clip.transform ? { ...clip.transform } : undefined,
    trajectory: clip.trajectory
      ? {
          motion: clip.trajectory.motion,
          motionAmount: clip.trajectory.motionAmount,
          motionTailSec: clip.trajectory.motionTailSec,
          waypoints: clip.trajectory.waypoints.map((w) => ({ ...w })),
        }
      : undefined,
    geometry: clip.geometry ? cloneTimelineGeometry(clip.geometry) : undefined,
    text: clip.text ? { ...clip.text } : undefined,
    volumeAutomation: clip.volumeAutomation
      ? { points: clip.volumeAutomation.points.map((p) => ({ ...p })) }
      : undefined,
    source: clip.source ? { ...clip.source } : undefined,
    coloring: clip.coloring ? { ...clip.coloring } : undefined,
    transitionOut: clip.transitionOut ? { ...clip.transitionOut } : undefined,
    frameSequence: clip.frameSequence ? structuredClone(clip.frameSequence) : undefined,
    frameEdit: clip.frameEdit ? structuredClone(clip.frameEdit) : undefined,
  };
}

/** Build an in-memory clipboard from the current multi-select. */
export function buildTimelineClipClipboard(
  manifest: TimelineManifest,
  selectedClipIds: string[]
): TimelineClipClipboard | null {
  if (selectedClipIds.length === 0) return null;
  const idSet = new Set(selectedClipIds);
  const items: TimelineClipClipboardItem[] = [];
  for (const t of manifest.tracks) {
    for (const c of t.clips) {
      if (idSet.has(c.id)) {
        items.push({ trackId: t.id, start: c.start, clip: c });
      }
    }
  }
  if (items.length === 0) return null;
  const anchorStart = Math.min(...items.map((i) => i.start));
  return { anchorStart, items };
}

function resolvePasteTrackId(
  manifest: TimelineManifest,
  preferredTrackId: string,
  clip: TimelineClip
): string | null {
  if (manifest.tracks.some((t) => t.id === preferredTrackId)) {
    return preferredTrackId;
  }
  const kind = trackKindForClip(clip);
  const fallback = manifest.tracks.find(
    (t) => t.kind === kind || (t.kind === "neutral" && kind === "video")
  );
  return fallback?.id ?? null;
}

/** Paste clipboard clips anchored at ``playhead``; returns updated manifest and new ids. */
export function pasteTimelineClipClipboard(
  manifest: TimelineManifest,
  clipboard: TimelineClipClipboard,
  playhead: number
): { manifest: TimelineManifest; newClipIds: string[] } {
  const delta = playhead - clipboard.anchorStart;
  const newClipIds: string[] = [];
  let nextManifest = manifest;

  for (const item of clipboard.items) {
    const trackId = resolvePasteTrackId(nextManifest, item.trackId, item.clip);
    if (!trackId) continue;
    const cloned = cloneTimelineClipForPaste(item.clip);
    cloned.start = item.start + delta;
    newClipIds.push(cloned.id);
    nextManifest = {
      ...nextManifest,
      tracks: nextManifest.tracks.map((t) =>
        t.id === trackId ? { ...t, clips: [...t.clips, cloned] } : t
      ),
    };
  }

  return { manifest: nextManifest, newClipIds };
}
