"use client";

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  TimelineManifest,
  TimelineClip,
  TimelineTrack,
  TimelineTransitionOut,
} from "../../lib/api";
import { TIMELINE_STRIP_FRAME_DROP_PREFIX } from "../../app/detail/[charKey]/dataset/sequenceGalleryUtils";
import { ClipTransitionMenu } from "./ClipTransitionMenu";
import { usePlayheadValue, type PlayheadStore } from "./timelinePlayback";
import { TrackLabelTag } from "./TrackLabelTag";
import { VolumeAutomationEditor } from "./VolumeAutomationEditor";
import { transitionBadge } from "./transitionEffects";
import { isFlatVolumeAutomation } from "./volumeAutomation";
import type { VolumeAutomationPoint } from "./volumeAutomation";
import {
  clamp,
  clipEnd,
  clipTrackLabel,
  connectedClipPairs,
  moveClipBetweenTracks,
  timelineDuration,
} from "./timelineUtil";

const LABEL_W = 120;
export const TIMELINE_TRACKS_LABEL_W = LABEL_W;
const ROW_H = 56;
const RULER_H = 22;

export function AddTrackStrip(props: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const { onClick, disabled = false } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: ROW_H,
        flexShrink: 0,
        border: "none",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        background: "#141414",
        color: "#888",
        cursor: disabled ? "not-allowed" : "pointer",
        font: "inherit",
        fontSize: 13,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      + Track
    </button>
  );
}
const MIN_DUR = 0.05;
const MIN_PXPS = 20;
const MAX_PXPS = 400;
const SNAP_PX = 8; // pixel radius for snapping clip edges to the playhead.
const PLAYHEAD_HIT_W = 12;

export function timeFromClientX(
  clientX: number,
  laneEl: HTMLElement,
  pxPerSec: number
): number {
  const rect = laneEl.getBoundingClientRect();
  return (clientX - rect.left + laneEl.scrollLeft - LABEL_W) / pxPerSec;
}

function TrackLaneDropZone(props: {
  trackId: string;
  dropActive: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
  onExternalFilesDrop?: (trackId: string, clientX: number, files: File[]) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const {
    trackId,
    dropActive,
    style,
    children,
    onExternalFilesDrop,
    onPointerDown,
    onContextMenu,
  } = props;
  const [nativeFileOver, setNativeFileOver] = useState(false);
  const { setNodeRef, isOver } = useDroppable({
    id: `${TIMELINE_STRIP_FRAME_DROP_PREFIX}${trackId}`,
    data: { trackId },
    disabled: !dropActive,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        outline:
          nativeFileOver || (dropActive && isOver)
            ? "2px solid rgba(110,181,255,0.85)"
            : undefined,
        outlineOffset: -2,
      }}
      onDragEnter={(e) => {
        if (!onExternalFilesDrop || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setNativeFileOver(true);
      }}
      onDragOver={(e) => {
        if (!onExternalFilesDrop || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setNativeFileOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setNativeFileOver(false);
      }}
      onDrop={(e) => {
        if (!onExternalFilesDrop) return;
        const files = Array.from(e.dataTransfer.files ?? []);
        setNativeFileOver(false);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        onExternalFilesDrop(trackId, e.clientX, files);
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  );
}

type RulerTick = { sec: number; label: string | null; major: boolean };

function formatRulerMinutes(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildRulerTicks(
  contentSec: number,
  total: number,
  pxPerSec: number
): RulerTick[] {
  const maxSec = Math.ceil(contentSec);
  const ticks: RulerTick[] = [];

  if (total < 60) {
    const step = pxPerSec >= 80 ? 1 : pxPerSec >= 40 ? 5 : 10;
    for (let s = 0; s <= maxSec; s += step) {
      ticks.push({ sec: s, label: `${s}s`, major: true });
    }
    return ticks;
  }

  const majorStep = pxPerSec >= 40 ? 10 : 30;
  const minorStep = pxPerSec >= 60 ? 1 : 0;
  for (let s = 0; s <= maxSec; s++) {
    const isMajor = s % majorStep === 0;
    const isMinor = minorStep > 0 && s % minorStep === 0 && !isMajor;
    if (!isMajor && !isMinor) continue;
    ticks.push({
      sec: s,
      label: isMajor ? formatRulerMinutes(s) : null,
      major: isMajor,
    });
  }
  return ticks;
}

type DragKind = "move" | "trimL" | "trimR";
type DragState = {
  kind: DragKind;
  trackId: string;
  clipId: string;
  startX: number;
  orig: TimelineClip;
  /** Set when dragging multiple selected clips — original start per clip. */
  multiOrig?: { trackId: string; clipId: string; origStart: number }[];
  /** True when we deferred collapsing the selection; cancel if drag occurs. */
  collapseSelectionOnUp?: boolean;
};

export type TimelineTracksHandle = {
  ensurePlayheadVisible: (t?: number) => void;
  timeAtClientX: (clientX: number) => number;
  /** Resolve a non-audio track under the pointer for SequenceEditor → timeline drops. */
  dropTargetAtClientPoint: (
    clientX: number,
    clientY: number
  ) => { trackId: string; startSec: number } | null;
};

type MarqueeState = {
  startClientX: number;
  startClientY: number;
  curClientX: number;
  curClientY: number;
  /** When true, union hit clips into the existing selection. */
  additive: boolean;
};

/** Clips whose time range overlaps [t0,t1] on tracks [trackIdx0, trackIdx1] (inclusive). */
export function clipIdsInMarquee(
  tracks: TimelineTrack[],
  t0: number,
  t1: number,
  trackIdx0: number,
  trackIdx1: number
): string[] {
  const loT = Math.min(t0, t1);
  const hiT = Math.max(t0, t1);
  const loIdx = Math.max(0, Math.min(trackIdx0, trackIdx1));
  const hiIdx = Math.min(tracks.length - 1, Math.max(trackIdx0, trackIdx1));
  if (hiIdx < 0 || loIdx > hiIdx) return [];
  const ids: string[] = [];
  for (let i = loIdx; i <= hiIdx; i++) {
    const track = tracks[i];
    if (!track) continue;
    for (const clip of track.clips) {
      const end = clipEnd(clip);
      if (clip.start < hiT && end > loT) ids.push(clip.id);
    }
  }
  return ids;
}

/**
 * Playhead line + drag scrubber, isolated so live 60fps updates re-render only
 * this element rather than the whole (clip-heavy) tracks tree.
 */
function PlayheadOverlay(props: {
  store: PlayheadStore;
  pxPerSec: number;
  labelW: number;
  hitW: number;
  total: number;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const { store, pxPerSec, labelW, hitW, total, onPointerDown } = props;
  const playhead = usePlayheadValue(store);
  return (
    <>
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: labelW + playhead * pxPerSec - 1,
          width: 2,
          background: "#ff5d5d",
          pointerEvents: "none",
          zIndex: 5,
        }}
      />
      <div
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={playhead}
        onPointerDown={onPointerDown}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: labelW + playhead * pxPerSec - hitW / 2,
          width: hitW,
          cursor: "ew-resize",
          zIndex: 6,
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: "50%",
            transform: "translateX(-50%)",
            width: 0,
            height: 0,
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderTop: "7px solid #ff5d5d",
            pointerEvents: "none",
          }}
        />
      </div>
    </>
  );
}

export const TimelineTracks = forwardRef<TimelineTracksHandle, {
  manifest: TimelineManifest;
  pxPerSec: number;
  playhead: number;
  playheadStore: PlayheadStore;
  selectedClipIds: string[];
  onSeek: (t: number) => void;
  onSelectClip: (clipId: string | null, additive: boolean) => void;
  /** Box-select result: replace selection, or union when additive. */
  onSelectClips?: (clipIds: string[], additive: boolean) => void;
  onChange: (updater: (prev: TimelineManifest) => TimelineManifest) => void;
  onCommit: () => void;
  setPxPerSec: (updater: (prev: number) => number) => void;
  externalStripDropActive?: boolean;
  onExternalFilesDrop?: (trackId: string, clientX: number, files: File[]) => void;
  onClipContextMenu: (
    trackId: string,
    clipId: string,
    clientX: number,
    clientY: number
  ) => void;
  onTrackContextMenu: (trackId: string, clientX: number, clientY: number) => void;
  onSurfaceContextMenu?: (
    trackId: string | null,
    clientX: number,
    clientY: number
  ) => void;
  onTransitionChange?: (
    trackId: string,
    outgoingClipId: string,
    transition: TimelineTransitionOut | undefined
  ) => void;
  onTransitionCommit?: () => void;
  onPruneTransitions?: () => void;
  syncMotionTailSec?: number;
  onSyncMotionTailSecChange?: (sec: number) => void;
  onSyncMotionApply?: (
    trackId: string,
    outgoingClipId: string,
    incomingClipId: string
  ) => void;
  onSyncColorApply?: (
    trackId: string,
    outgoingClipId: string,
    incomingClipId: string
  ) => void;
  syncBusy?: boolean;
  onAddTrack?: () => void;
  volumeEditClipId?: string | null;
  onVolumePointsChange?: (clipId: string, points: VolumeAutomationPoint[]) => void;
  onVolumeSeek?: (t: number) => void;
  onVolumeClear?: (clipId: string) => void;
}>(function TimelineTracks(props, ref) {
  const {
    manifest,
    pxPerSec,
    playhead,
    playheadStore,
    selectedClipIds,
    onSeek,
    onSelectClip,
    onSelectClips,
    onChange,
    onCommit,
    setPxPerSec,
    onClipContextMenu,
    onTrackContextMenu,
    onSurfaceContextMenu,
    onTransitionChange,
    onTransitionCommit,
    onPruneTransitions,
    syncMotionTailSec = 0.5,
    onSyncMotionTailSecChange,
    onSyncMotionApply,
    onSyncColorApply,
    syncBusy = false,
    onAddTrack,
    volumeEditClipId,
    onVolumePointsChange,
    onVolumeSeek,
    onVolumeClear,
    externalStripDropActive = false,
    onExternalFilesDrop,
  } = props;

  const dragRef = useRef<DragState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const [marqueeBox, setMarqueeBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [hoveredJunction, setHoveredJunction] = useState<string | null>(null);
  const [transitionMenu, setTransitionMenu] = useState<{
    x: number;
    y: number;
    trackId: string;
    outgoingClipId: string;
  } | null>(null);
  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const gestureCommittedRef = useRef(false);
  const playheadDragRef = useRef(false);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  const ensurePlayheadVisible = useCallback((t?: number) => {
    const el = laneAreaRef.current;
    if (!el) return;
    const time = t ?? playheadRef.current;
    const x = LABEL_W + time * pxPerSec;
    const margin = 40;
    const viewL = el.scrollLeft;
    const viewR = viewL + el.clientWidth;
    if (x < viewL + margin) {
      el.scrollLeft = Math.max(0, x - LABEL_W - margin);
    } else if (x > viewR - margin) {
      el.scrollLeft = x - el.clientWidth + margin;
    }
  }, [pxPerSec]);

  useImperativeHandle(
    ref,
    () => ({
      ensurePlayheadVisible,
      timeAtClientX: (clientX: number) => {
        const el = laneAreaRef.current;
        if (!el) return 0;
        return clamp(timeFromClientX(clientX, el, pxPerSec), 0, Infinity);
      },
      dropTargetAtClientPoint: (clientX: number, clientY: number) => {
        const el = laneAreaRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const idx = Math.floor((clientY - rect.top - RULER_H) / ROW_H);
        if (idx < 0 || idx >= manifest.tracks.length) return null;
        const track = manifest.tracks[idx];
        if (!track || track.kind === "audio") return null;
        const startSec = clamp(timeFromClientX(clientX, el, pxPerSec), 0, Infinity);
        return { trackId: track.id, startSec };
      },
    }),
    [ensurePlayheadVisible, manifest.tracks, pxPerSec]
  );

  // Track drag-to-reorder state.
  const trackDragRef = useRef<{ trackId: string; startY: number } | null>(null);
  const [trackDropIndex, setTrackDropIndex] = useState<number | null>(null);
  // Pending cursor anchor to keep the time-under-cursor fixed across a wheel zoom.
  const zoomAnchorRef = useRef<{ cursorTime: number; offsetX: number } | null>(null);

  // Native (non-passive) wheel listener so we can preventDefault to zoom.
  useEffect(() => {
    const el = laneAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      if (!e.shiftKey) {
        // Default wheel → horizontal scroll.
        el.scrollLeft += e.deltaY || e.deltaX;
        e.preventDefault();
        return;
      }
      if (offsetX < LABEL_W) {
        // Track name / ruler corner — don't hijack wheel for zoom.
        return;
      }
      e.preventDefault();
      const cursorTime = (offsetX + el.scrollLeft - LABEL_W) / pxPerSec;
      zoomAnchorRef.current = { cursorTime: Math.max(0, cursorTime), offsetX };
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setPxPerSec((p) => clamp(p * factor, MIN_PXPS, MAX_PXPS));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pxPerSec, setPxPerSec]);

  // After a wheel zoom re-render, restore the anchored scroll position.
  useEffect(() => {
    const el = laneAreaRef.current;
    const a = zoomAnchorRef.current;
    if (!el || !a) return;
    el.scrollLeft = a.cursorTime * pxPerSec + LABEL_W - a.offsetX;
    zoomAnchorRef.current = null;
  }, [pxPerSec]);

  const total = timelineDuration(manifest);
  const contentSec = Math.max(total + 5, 20);
  const laneWidth = contentSec * pxPerSec;
  const rulerTicks = buildRulerTicks(contentSec, total, pxPerSec);

  function renameTrack(trackId: string, name: string) {
    onCommit();
    onChange((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) => (t.id === trackId ? { ...t, name } : t)),
    }));
  }

  function toggleTrackHidden(trackId: string) {
    onCommit();
    onChange((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.id === trackId ? { ...t, hidden: !t.hidden } : t
      ),
    }));
  }

  function mutateClip(trackId: string, clipId: string, patch: Partial<TimelineClip>) {
    onChange((prev) => ({
      ...prev,
      tracks: prev.tracks.map((t) =>
        t.id !== trackId
          ? t
          : {
              ...t,
              clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
            }
      ),
    }));
  }

  /** Move a clip to another track (cross-lane drag), placing it at ``newStart``. */
  function moveClipToTrack(
    _fromTrackId: string,
    toTrackId: string,
    clip: TimelineClip,
    newStart: number
  ) {
    onChange((prev) => moveClipBetweenTracks(prev, toTrackId, clip, newStart));
  }

  /** Candidate snap times (seconds): playhead, 0, and every other clip's edges. */
  function snapTimes(excludeClipId: string): number[] {
    const out: number[] = [playhead, 0];
    for (const t of manifest.tracks) {
      for (const c of t.clips) {
        if (c.id === excludeClipId) continue;
        out.push(c.start, clipEnd(c));
      }
    }
    return out;
  }

  /** Snap a single edge time to the nearest candidate within SNAP_PX; else null. */
  function snapEdge(edgeTime: number, excludeClipId: string): number | null {
    let best: number | null = null;
    let bestPx = SNAP_PX;
    for (const c of snapTimes(excludeClipId)) {
      const d = Math.abs((edgeTime - c) * pxPerSec);
      if (d < bestPx) {
        bestPx = d;
        best = c;
      }
    }
    return best;
  }

  /** Snap a moving clip so its start OR end aligns to the nearest candidate. */
  function snapMove(newStart: number, duration: number, excludeClipId: string): number {
    let best = newStart;
    let bestPx = SNAP_PX;
    for (const c of snapTimes(excludeClipId)) {
      const dStart = Math.abs((newStart - c) * pxPerSec);
      if (dStart < bestPx) {
        bestPx = dStart;
        best = c;
      }
      const dEnd = Math.abs((newStart + duration - c) * pxPerSec);
      if (dEnd < bestPx) {
        bestPx = dEnd;
        best = Math.max(0, c - duration);
      }
    }
    return best;
  }

  /** Which track row the pointer is over (for cross-lane dragging). */
  function trackIdAtClientY(clientY: number): string | null {
    const idx = trackIndexAtClientY(clientY);
    if (idx < 0 || idx >= manifest.tracks.length) return null;
    return manifest.tracks[idx].id;
  }

  function trackIndexAtClientY(clientY: number): number {
    const el = laneAreaRef.current;
    if (!el) return -1;
    const rect = el.getBoundingClientRect();
    return Math.floor((clientY - rect.top - RULER_H) / ROW_H);
  }

  function contentPointFromClient(clientX: number, clientY: number): { x: number; y: number } {
    const el = laneAreaRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: clientX - rect.left + el.scrollLeft,
      y: clientY - rect.top + el.scrollTop,
    };
  }

  function marqueeBoxFromState(m: MarqueeState) {
    const a = contentPointFromClient(m.startClientX, m.startClientY);
    const b = contentPointFromClient(m.curClientX, m.curClientY);
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x),
      height: Math.abs(a.y - b.y),
    };
  }

  function startMarquee(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Capture on the scroll root so move/up keep flowing through onPointerMove/Up.
    laneAreaRef.current?.setPointerCapture?.(e.pointerId);
    const m: MarqueeState = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      curClientX: e.clientX,
      curClientY: e.clientY,
      additive: e.shiftKey,
    };
    marqueeRef.current = m;
    setMarqueeBox(marqueeBoxFromState(m));
  }

  function finishMarquee() {
    const m = marqueeRef.current;
    marqueeRef.current = null;
    setMarqueeBox(null);
    if (!m) return;
    const el = laneAreaRef.current;
    if (!el) return;
    const dx = Math.abs(m.curClientX - m.startClientX);
    const dy = Math.abs(m.curClientY - m.startClientY);
    // Tiny gesture: treat as clear (replace) or no-op (additive).
    if (dx < 4 && dy < 4) {
      if (!m.additive) onSelectClip(null, false);
      return;
    }
    const t0 = timeFromClientX(m.startClientX, el, pxPerSec);
    const t1 = timeFromClientX(m.curClientX, el, pxPerSec);
    const i0 = trackIndexAtClientY(m.startClientY);
    const i1 = trackIndexAtClientY(m.curClientY);
    const ids = clipIdsInMarquee(manifest.tracks, t0, t1, i0, i1);
    if (onSelectClips) {
      onSelectClips(ids, m.additive);
    } else if (ids.length === 0) {
      if (!m.additive) onSelectClip(null, false);
    } else {
      onSelectClip(ids[0], false);
      for (let i = 1; i < ids.length; i++) onSelectClip(ids[i], true);
    }
  }

  function onClipPointerDown(
    e: React.PointerEvent,
    track: TimelineTrack,
    clip: TimelineClip,
    kind: DragKind
  ) {
    if (e.button === 2) return; // right-click — selection handled by onContextMenu, don't override
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    const isModified = e.shiftKey || e.ctrlKey || e.metaKey;
    const isAlreadySelected = selectedClipIds.includes(clip.id);
    // Drag all selected clips together when clicking an already-selected clip without modifier.
    const isMultiDrag = kind === "move" && !isModified && isAlreadySelected && selectedClipIds.length > 1;

    if (isMultiDrag) {
      // Defer selection collapse until pointer-up (in case this turns out to be just a click, not a drag).
    } else {
      onSelectClip(clip.id, isModified);
    }

    gestureCommittedRef.current = false;

    let multiOrig: DragState["multiOrig"];
    if (isMultiDrag) {
      multiOrig = [];
      for (const t of manifest.tracks) {
        for (const c of t.clips) {
          if (selectedClipIds.includes(c.id)) {
            multiOrig.push({ trackId: t.id, clipId: c.id, origStart: c.start });
          }
        }
      }
    }

    dragRef.current = {
      kind,
      trackId: track.id,
      clipId: clip.id,
      startX: e.clientX,
      orig: clip,
      multiOrig,
      collapseSelectionOnUp: isMultiDrag,
    };
  }

  function startTrackDrag(trackId: string, e: React.PointerEvent) {
    trackDragRef.current = { trackId, startY: e.clientY };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setTrackDropIndex(manifest.tracks.findIndex((t) => t.id === trackId));
  }

  function getTrackDropIndexFromY(clientY: number): number {
    const el = laneAreaRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const relY = clientY - rect.top - RULER_H + el.scrollTop;
    return clamp(Math.round(relY / ROW_H), 0, manifest.tracks.length);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (marqueeRef.current) {
      marqueeRef.current = {
        ...marqueeRef.current,
        curClientX: e.clientX,
        curClientY: e.clientY,
      };
      setMarqueeBox(marqueeBoxFromState(marqueeRef.current));
      return;
    }

    if (playheadDragRef.current) {
      seekFromClientX(e.clientX);
      ensurePlayheadVisible();
      return;
    }

    // Track reorder drag takes priority.
    if (trackDragRef.current) {
      setTrackDropIndex(getTrackDropIndexFromY(e.clientY));
      return;
    }

    const d = dragRef.current;
    if (!d) return;
    // One undo checkpoint per drag, captured before the first applied change.
    if (!gestureCommittedRef.current) {
      onCommit();
      gestureCommittedRef.current = true;
    }
    const dt = (e.clientX - d.startX) / pxPerSec;
    const o = d.orig;
    const speed = o.speed || 1;
    const hasSrc = o.type === "video" || o.type === "audio";
    const maxDur =
      hasSrc && o.srcDuration
        ? Math.max(MIN_DUR, (o.srcDuration - o.inPoint) / speed)
        : Infinity;

    if (d.kind === "move") {
      // Cancel the deferred selection collapse since this is a real drag.
      d.collapseSelectionOnUp = false;

      const newStart = snapMove(clamp(o.start + dt, 0, Infinity), o.duration, o.id);
      const delta = newStart - o.start;

      if (d.multiOrig && d.multiOrig.length > 1) {
        // Multi-clip drag: apply the same time delta to all selected clips.
        onChange((prev) => ({
          ...prev,
          tracks: prev.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              const m = d.multiOrig!.find((x) => x.clipId === c.id);
              if (!m) return c;
              return { ...c, start: Math.max(0, m.origStart + delta) };
            }),
          })),
        }));
        return;
      }

      // Single clip drag: support cross-lane drop.
      const targetId = trackIdAtClientY(e.clientY);
      const target = targetId
        ? manifest.tracks.find((t) => t.id === targetId)
        : null;
      const dragKind = o.type === "audio" ? "audio" : "video";
      const canDropOnTarget =
        target &&
        target.id !== d.trackId &&
        (target.kind === dragKind ||
          (target.kind === "neutral" && target.clips.length === 0));
      if (canDropOnTarget) {
        moveClipToTrack(d.trackId, target.id, { ...o, start: newStart }, newStart);
        d.trackId = target.id;
      } else {
        mutateClip(d.trackId, d.clipId, { start: newStart });
      }
      return;
    }
    if (d.kind === "trimL") {
      // Drag head: limit so duration stays >= MIN_DUR and inPoint >= 0.
      const minShift = hasSrc
        ? o.reversed
          ? o.srcDuration
            ? -(o.srcDuration - o.outPoint) / speed
            : -Infinity
          : -o.inPoint / speed
        : -Infinity;
      const maxShift = o.duration - MIN_DUR;
      let shift = clamp(dt, Math.max(minShift, -o.start), maxShift);
      // Snap the head to the playhead or another clip edge when close.
      const snappedHead = snapEdge(o.start + shift, o.id);
      if (snappedHead != null) {
        shift = clamp(snappedHead - o.start, Math.max(minShift, -o.start), maxShift);
      }
      const newStart = o.start + shift;
      const newDuration = o.duration - shift;
      if (o.reversed && hasSrc) {
        const newOutPoint = o.outPoint - shift * speed;
        mutateClip(d.trackId, d.clipId, {
          start: newStart,
          outPoint: Math.max(o.inPoint + MIN_DUR * speed, newOutPoint),
          duration: newDuration,
        });
      } else {
        const newInPoint = hasSrc ? o.inPoint + shift * speed : o.inPoint;
        mutateClip(d.trackId, d.clipId, {
          start: newStart,
          inPoint: Math.max(0, newInPoint),
          duration: newDuration,
          outPoint: hasSrc ? Math.max(0, newInPoint) + newDuration * speed : o.outPoint,
        });
      }
      return;
    }
    if (d.kind === "trimR") {
      let newDuration = clamp(o.duration + dt, MIN_DUR, maxDur);
      // Snap the tail to the playhead or another clip edge when close.
      const snappedTail = snapEdge(o.start + newDuration, o.id);
      if (snappedTail != null) {
        newDuration = clamp(snappedTail - o.start, MIN_DUR, maxDur);
      }
      if (o.reversed && hasSrc) {
        mutateClip(d.trackId, d.clipId, {
          duration: newDuration,
          inPoint: Math.max(0, o.outPoint - newDuration * speed),
        });
      } else {
        mutateClip(d.trackId, d.clipId, {
          duration: newDuration,
          outPoint: hasSrc ? o.inPoint + newDuration * speed : o.outPoint,
        });
      }
      return;
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (marqueeRef.current) {
      laneAreaRef.current?.releasePointerCapture?.(e.pointerId);
      finishMarquee();
      return;
    }

    if (playheadDragRef.current) {
      playheadDragRef.current = false;
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      ensurePlayheadVisible();
      return;
    }

    // Finish track reorder drag.
    if (trackDragRef.current) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      const { trackId } = trackDragRef.current;
      const dropIdx = getTrackDropIndexFromY(e.clientY);
      trackDragRef.current = null;
      setTrackDropIndex(null);
      const fromIdx = manifest.tracks.findIndex((t) => t.id === trackId);
      if (fromIdx !== -1 && dropIdx !== fromIdx && dropIdx !== fromIdx + 1) {
        onCommit();
        onChange((prev) => {
          const idx = prev.tracks.findIndex((t) => t.id === trackId);
          if (idx === -1 || dropIdx === idx || dropIdx === idx + 1) return prev;
          const next = [...prev.tracks];
          const [moved] = next.splice(idx, 1);
          const insertAt = dropIdx > idx ? dropIdx - 1 : dropIdx;
          next.splice(insertAt, 0, moved);
          return { ...prev, tracks: next };
        });
      }
      return;
    }
    if (dragRef.current) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      const hadGesture = gestureCommittedRef.current;
      const { clipId, collapseSelectionOnUp } = dragRef.current;
      dragRef.current = null;
      gestureCommittedRef.current = false;
      // If the user clicked (no drag) on an already-selected clip in a multi-selection,
      // collapse the selection to just that clip now.
      if (collapseSelectionOnUp && !hadGesture) {
        onSelectClip(clipId, false);
      }
      if (hadGesture) onPruneTransitions?.();
    }
  }

  function openTransitionMenu(
    e: React.PointerEvent,
    trackId: string,
    outgoingClipId: string
  ) {
    e.preventDefault();
    e.stopPropagation();
    setTransitionMenu({
      x: e.clientX,
      y: e.clientY,
      trackId,
      outgoingClipId,
    });
  }

  const menuOutgoingClip = transitionMenu
    ? manifest.tracks
        .find((t) => t.id === transitionMenu.trackId)
        ?.clips.find((c) => c.id === transitionMenu.outgoingClipId)
    : undefined;

  const menuIncomingClip = (() => {
    if (!transitionMenu || !menuOutgoingClip) return undefined;
    const track = manifest.tracks.find((t) => t.id === transitionMenu.trackId);
    if (!track) return undefined;
    const pair = connectedClipPairs(track).find(
      (p) => p.outgoing.id === transitionMenu.outgoingClipId
    );
    return pair?.incoming;
  })();

  function seekFromClientX(clientX: number) {
    const el = laneAreaRef.current;
    if (!el) return;
    const t = timeFromClientX(clientX, el, pxPerSec);
    onSeek(clamp(t, 0, Infinity));
  }

  function startPlayheadDrag(e: React.PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    playheadDragRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX);
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#141414",
        border: "1px solid rgba(255,255,255,0.12)",
      }}
    >
      <div
        ref={laneAreaRef}
        style={{
          position: "relative",
          overflowX: "auto",
          overflowY: "hidden",
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
      <div style={{ position: "relative", width: LABEL_W + laneWidth }}>
        {/* Ruler */}
        <div
          style={{
            display: "flex",
            height: RULER_H,
            position: "relative",
          }}
        >
          <div
            style={{
              position: "sticky",
              left: 0,
              zIndex: 4,
              width: LABEL_W,
              minWidth: LABEL_W,
              background: "#1b1b1b",
              borderRight: "1px solid rgba(255,255,255,0.15)",
              borderBottom: "1px solid rgba(255,255,255,0.12)",
            }}
          />
          <div
            style={{
              position: "relative",
              width: laneWidth,
              borderBottom: "1px solid rgba(255,255,255,0.12)",
              cursor: "text",
            }}
            onPointerDown={(e) => {
              onSelectClip(null, false);
              startPlayheadDrag(e);
            }}
            onContextMenu={(e) => {
              if (!onSurfaceContextMenu) return;
              e.preventDefault();
              e.stopPropagation();
              onSurfaceContextMenu(null, e.clientX, e.clientY);
            }}
          >
            {rulerTicks.map((tick) => (
              <div
                key={tick.sec}
                style={{
                  position: "absolute",
                  left: tick.sec * pxPerSec,
                  top: 0,
                  height: RULER_H,
                  borderLeft: tick.major
                    ? "1px solid rgba(255,255,255,0.22)"
                    : "1px solid rgba(255,255,255,0.08)",
                  paddingLeft: 3,
                  fontSize: 9,
                  color: tick.major
                    ? "rgba(255,255,255,0.55)"
                    : "rgba(255,255,255,0.25)",
                  userSelect: "none",
                }}
              >
                {tick.label ?? ""}
              </div>
            ))}
          </div>
        </div>

        {/* Track rows */}
        {manifest.tracks.map((track, trackIdx) => (
          <React.Fragment key={track.id}>
            {/* Drop indicator — shown above this track when dragging */}
            {trackDropIndex === trackIdx && (
              <div style={{ height: 3, background: "#ffd166", marginLeft: LABEL_W, width: laneWidth }} />
            )}
            <div
              style={{
                display: "flex",
                height: ROW_H,
                opacity: trackDragRef.current?.trackId === track.id ? 0.4 : 1,
              }}
            >
            <TrackLabelTag
              name={track.name}
              kind={track.kind}
              width={LABEL_W}
              hidden={!!track.hidden}
              onToggleHidden={() => toggleTrackHidden(track.id)}
              onRename={(next) => renameTrack(track.id, next)}
              onContextMenu={(x, y) => onTrackContextMenu(track.id, x, y)}
              onDragHandlePointerDown={(e) => startTrackDrag(track.id, e)}
            />
            <TrackLaneDropZone
              trackId={track.id}
              dropActive={externalStripDropActive && track.kind !== "audio"}
              onExternalFilesDrop={onExternalFilesDrop}
              style={{
                position: "relative",
                width: laneWidth,
                borderBottom: "1px solid rgba(255,255,255,0.08)",
                background:
                  track.kind === "audio"
                    ? "#16201a"
                    : track.kind === "neutral"
                    ? "#1a1a1a"
                    : "#171b22",
                opacity: track.hidden ? 0.4 : 1,
              }}
              onPointerDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.ctrlKey || e.metaKey) {
                  startMarquee(e);
                  return;
                }
                onSelectClip(null, false);
                startPlayheadDrag(e);
              }}
              onContextMenu={(e) => {
                if (!onSurfaceContextMenu || e.target !== e.currentTarget) return;
                e.preventDefault();
                e.stopPropagation();
                onSurfaceContextMenu(track.id, e.clientX, e.clientY);
              }}
            >
              {track.clips.map((clip) => {
                const left = clip.start * pxPerSec;
                const width = Math.max(6, clip.duration * pxPerSec);
                const clipHeight = ROW_H - 14;
                const selected = selectedClipIds.includes(clip.id);
                const bg =
                  clip.type === "video"
                    ? "#274b73"
                    : clip.type === "image"
                    ? "#4a3a6b"
                    : clip.type === "geometry"
                    ? "#6b4a2a"
                    : clip.type === "text"
                    ? "#4a5b6b"
                    : "#2f5b3a";
                return (
                  <div
                    key={clip.id}
                    onPointerDown={(e) => {
                      if (volumeEditClipId === clip.id) {
                        e.stopPropagation();
                        return;
                      }
                      onClipPointerDown(e, track, clip, "move");
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // Keep an existing multi-selection if right-clicking a selected clip.
                      if (!selectedClipIds.includes(clip.id)) onSelectClip(clip.id, false);
                      onClipContextMenu(track.id, clip.id, e.clientX, e.clientY);
                    }}
                    style={{
                      position: "absolute",
                      left,
                      top: 6,
                      width,
                      height: clipHeight,
                      background: bg,
                      border: selected
                        ? "2px solid #ffd166"
                        : "1px solid rgba(255,255,255,0.25)",
                      borderRadius: 0,
                      boxSizing: "border-box",
                      cursor: "grab",
                      overflow: "hidden",
                      color: "#dfe7f1",
                      fontSize: 10,
                      padding: "2px 8px",
                      whiteSpace: "nowrap",
                      userSelect: "none",
                    }}
                  >
                    {clip.type === "audio" && !clip.srcRelPath
                      ? "♪ audio (empty)"
                      : `${clipTrackLabel(clip)} · ${clip.reversed ? "↩ · " : ""}${clip.speed !== 1 ? `${clip.speed}× · ` : ""}${clip.duration.toFixed(1)}s`}
                    {clip.trajectory && (
                      <span style={{ marginLeft: 4, fontSize: 8, opacity: 0.75 }} title="Has trajectory">↗</span>
                    )}
                    {clip.trajectory?.motion && clip.trajectory.motion !== "none" && (
                      <span
                        style={{ marginLeft: 4, fontSize: 8, opacity: 0.75 }}
                        title={`Motion: ${clip.trajectory.motion}`}
                      >
                        ≋
                      </span>
                    )}
                    {clip.transitionOut?.type ? (
                      <span
                        style={{ marginLeft: 4, fontSize: 8, opacity: 0.75 }}
                        title={`${clip.transitionOut.type} transition`}
                      >
                        {transitionBadge(clip.transitionOut.type)}
                      </span>
                    ) : null}
                    {clip.type === "audio" &&
                    clip.volumeAutomation &&
                    !isFlatVolumeAutomation(clip.volumeAutomation.points) ? (
                      <span
                        style={{ marginLeft: 4, fontSize: 8, opacity: 0.75 }}
                        title="Volume automation"
                      >
                        ⌇
                      </span>
                    ) : null}
                    {volumeEditClipId === clip.id && clip.type === "audio" ? (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          zIndex: 3,
                          pointerEvents: "all",
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <VolumeAutomationEditor
                          clip={clip}
                          clipWidthPx={width}
                          clipHeightPx={clipHeight}
                          points={
                            clip.volumeAutomation?.points ?? [
                              { t: 0, level: 50 },
                              { t: 1, level: 50 },
                            ]
                          }
                          onPointsChange={(pts) => onVolumePointsChange?.(clip.id, pts)}
                          onSeek={onVolumeSeek}
                          onClear={() => onVolumeClear?.(clip.id)}
                        />
                      </div>
                    ) : null}
                    {/* Trim handles */}
                    <div
                      onPointerDown={(e) => onClipPointerDown(e, track, clip, "trimL")}
                      style={handleStyle("left")}
                    />
                    <div
                      onPointerDown={(e) => onClipPointerDown(e, track, clip, "trimR")}
                      style={handleStyle("right")}
                    />
                  </div>
                );
              })}
              {track.kind === "video"
                ? connectedClipPairs(track).map((pair) => {
                    const key = `${pair.outgoing.id}_${pair.incoming.id}`;
                    const junctionLeft = pair.junctionTime * pxPerSec;
                    const hovered = hoveredJunction === key;
                    const hasTransition = Boolean(pair.outgoing.transitionOut?.type);
                    return (
                      <div
                        key={key}
                        onMouseEnter={() => setHoveredJunction(key)}
                        onMouseLeave={() =>
                          setHoveredJunction((h) => (h === key ? null : h))
                        }
                        onPointerDown={(e) =>
                          openTransitionMenu(e, track.id, pair.outgoing.id)
                        }
                        style={{
                          position: "absolute",
                          left: junctionLeft - 10,
                          top: 6,
                          width: 20,
                          height: ROW_H - 14,
                          zIndex: 4,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                        }}
                      >
                        {hovered || hasTransition ? (
                          <div
                            style={{
                              width: 18,
                              height: 18,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background: "#1a1a1a",
                              border: hasTransition
                                ? "1px solid #ffd166"
                                : "1px solid rgba(255,255,255,0.35)",
                              color: hasTransition ? "#ffd166" : "#eee",
                              fontSize: 14,
                              lineHeight: 1,
                              userSelect: "none",
                            }}
                          >
                            +
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                : null}
            </TrackLaneDropZone>
            </div>  {/* close row div */}
          </React.Fragment>
        ))}
        {/* Drop indicator at the very bottom */}
        {trackDropIndex === manifest.tracks.length && (
          <div style={{ height: 3, background: "#ffd166", marginLeft: LABEL_W, width: laneWidth }} />
        )}

        {/* Playhead line + scrubber (isolated live-updating overlay). */}
        <PlayheadOverlay
          store={playheadStore}
          pxPerSec={pxPerSec}
          labelW={LABEL_W}
          hitW={PLAYHEAD_HIT_W}
          total={total}
          onPointerDown={startPlayheadDrag}
        />

        {marqueeBox && marqueeBox.width + marqueeBox.height > 0 ? (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: marqueeBox.left,
              top: marqueeBox.top,
              width: marqueeBox.width,
              height: marqueeBox.height,
              border: "1px dashed rgba(255,209,102,0.95)",
              background: "rgba(255,209,102,0.12)",
              pointerEvents: "none",
              zIndex: 20,
              boxSizing: "border-box",
            }}
          />
        ) : null}
      </div>
      </div>

      {onAddTrack ? <AddTrackStrip onClick={onAddTrack} /> : null}

      <ClipTransitionMenu
        open={!!transitionMenu}
        x={transitionMenu?.x ?? 0}
        y={transitionMenu?.y ?? 0}
        transition={menuOutgoingClip?.transitionOut}
        outgoingClip={menuOutgoingClip}
        incomingClip={menuIncomingClip}
        syncMotionTailSec={syncMotionTailSec}
        syncBusy={syncBusy}
        onSyncMotionTailSecChange={onSyncMotionTailSecChange}
        onSyncMotionApply={() => {
          if (!transitionMenu || !menuIncomingClip) return;
          onSyncMotionApply?.(
            transitionMenu.trackId,
            transitionMenu.outgoingClipId,
            menuIncomingClip.id
          );
        }}
        onSyncColorApply={() => {
          if (!transitionMenu || !menuIncomingClip) return;
          onSyncColorApply?.(
            transitionMenu.trackId,
            transitionMenu.outgoingClipId,
            menuIncomingClip.id
          );
        }}
        onChange={(tr) => {
          if (!transitionMenu) return;
          onTransitionChange?.(
            transitionMenu.trackId,
            transitionMenu.outgoingClipId,
            tr
          );
        }}
        onCommit={() => onTransitionCommit?.()}
        onClose={() => setTransitionMenu(null)}
      />
    </div>
  );
});

function handleStyle(side: "left" | "right"): React.CSSProperties {
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    [side]: 0,
    width: 7,
    cursor: "ew-resize",
    background: "rgba(255,255,255,0.25)",
  };
}

export const TIMELINE_LABEL_W = LABEL_W;
export const TIMELINE_ROW_H = ROW_H;
