import { assetUrlFromRelPath } from "../../lib/api";
import type {
  GeometryTemplate,
  TimelineClip,
  TimelineManifest,
  TimelineTrack,
} from "../../lib/api";
import { createGeometryData, VECTOR_ARTBOARD_SIZE } from "./geometryTemplates";
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

const MIN_CLIP_SCALE = 0.1;
const MAX_CLIP_SCALE = 6;

type ScaleSnapCandidate = { scale: number; delta: number; guide: AlignGuide };

/**
 * Snap uniform scale so a clip edge sticks to the frame border while the
 * transform center stays fixed (bottom-right scale handle in preview).
 */
export function snapClipScaleToFrame(
  clip: TimelineClip,
  tf: ClipTransform,
  frameW: number,
  frameH: number,
  thresholdPx = PREVIEW_ALIGN_SNAP_PX
): { scale: number; guides: AlignGuide[] } {
  const clampedTentative = clamp(tf.scale, MIN_CLIP_SCALE, MAX_CLIP_SCALE);
  const nW = clip.naturalW ?? 0;
  const nH = clip.naturalH ?? 0;
  const { w: baseW, h: baseH } = containedBoxSize(nW, nH, frameW, frameH);
  if (baseW <= 0 || baseH <= 0 || frameW <= 0 || frameH <= 0) {
    return { scale: clampedTentative, guides: [] };
  }

  const cx = frameW / 2 + tf.x * frameW;
  const cy = frameH / 2 + tf.y * frameH;
  const rect = clipImageRect(clip, { ...tf, scale: clampedTentative }, frameW, frameH);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;

  const candidates: ScaleSnapCandidate[] = [];

  const tryEdge = (edgeDelta: number, scale: number, guide: AlignGuide) => {
    if (Math.abs(edgeDelta) >= thresholdPx) return;
    const snapped = clamp(scale, MIN_CLIP_SCALE, MAX_CLIP_SCALE);
    if (!Number.isFinite(snapped)) return;
    candidates.push({ scale: snapped, delta: Math.abs(edgeDelta), guide });
  };

  tryEdge(-rect.left, (2 * cx) / baseW, { axis: "x", pos: 0, kind: "border" });
  tryEdge(frameW - right, (2 * (frameW - cx)) / baseW, {
    axis: "x",
    pos: frameW,
    kind: "border",
  });
  tryEdge(-rect.top, (2 * cy) / baseH, { axis: "y", pos: 0, kind: "border" });
  tryEdge(frameH - bottom, (2 * (frameH - cy)) / baseH, {
    axis: "y",
    pos: frameH,
    kind: "border",
  });

  if (candidates.length === 0) {
    return { scale: clampedTentative, guides: [] };
  }

  candidates.sort((a, b) => a.delta - b.delta);
  const best = candidates[0]!;
  return { scale: best.scale, guides: [best.guide] };
}

/** Effective transform at playhead (trajectory + motion when present). */
export function clipTransformAtPlayhead(clip: TimelineClip, playhead: number): ClipTransform {
  const traj = resolveTrajectoryTransformAt(clip, playhead, { applyMotion: true });
  if (traj) return traj;
  return clip.transform ?? defaultImageClipTransform();
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
}): TimelineClip {
  const dur = Math.max(0.05, params.durationSec);
  return {
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
    geometry: createGeometryData(params.template),
  };
}

export function buildTextClip(params: {
  content?: string;
  start?: number;
  durationSec?: number;
  fontFamilyId?: string;
}): TimelineClip {
  const dur = params.durationSec ?? IMAGE_CLIP_DEFAULT_SEC;
  return {
    id: genId("clip"),
    type: "text",
    srcRelPath: "",
    start: params.start ?? 0,
    inPoint: 0,
    outPoint: dur,
    speed: 1,
    duration: dur,
    naturalW: VECTOR_ARTBOARD_SIZE,
    naturalH: VECTOR_ARTBOARD_SIZE,
    transform: defaultVectorClipTransform(),
    text: {
      content: params.content ?? "Text",
      fontFamilyId: params.fontFamilyId ?? "inter",
      fontWeight: 400,
      fontStyle: "normal",
      fontSize: 48,
      color: "#ffffff",
      align: "center",
    },
  };
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
  for (const c of sorted) {
    if (t >= c.start && t < clipEnd(c)) {
      return [soloLayer(c)];
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

  const outgoing = sorted[idx - 1];
  if (!isConnectedPair(outgoing, clip) || !outgoing.transitionOut) {
    return sourceTimeAt(clip, t);
  }

  const d = effectiveTransitionDuration(outgoing, clip);
  const fadeStart = clip.start - d;
  if (t >= fadeStart && t < clip.start) {
    const local = Math.max(0, t - fadeStart);
    return clip.inPoint + local * clip.speed;
  }
  return sourceTimeAt(clip, t);
}

/** Source-media time (seconds) for a video/audio clip at timeline time ``t``. */
export function sourceTimeAt(clip: TimelineClip, t: number): number {
  return clip.inPoint + (t - clip.start) * clip.speed;
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

function loadHTMLImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

async function clipWithResolvedDims(clip: TimelineClip): Promise<TimelineClip> {
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
    loadHTMLImage(assetUrlFromRelPath(backdrop.srcRelPath)),
    loadHTMLImage(assetUrlFromRelPath(overlay.srcRelPath)),
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
