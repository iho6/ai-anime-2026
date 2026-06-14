"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  TimelineManifest,
  TimelineClip,
  TimelineTrack,
  TimelineTransitionOut,
} from "../../lib/api";
import { ClipTransitionMenu } from "./ClipTransitionMenu";
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
  promoteTrackKind,
  timelineDuration,
  trackKindForClip,
} from "./timelineUtil";

const LABEL_W = 120;
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

type DragKind = "move" | "trimL" | "trimR";
type DragState = {
  kind: DragKind;
  trackId: string;
  clipId: string;
  startX: number;
  orig: TimelineClip;
};

export function TimelineTracks(props: {
  manifest: TimelineManifest;
  pxPerSec: number;
  playhead: number;
  selectedClipIds: string[];
  onSeek: (t: number) => void;
  onSelectClip: (clipId: string | null, additive: boolean) => void;
  onChange: (next: TimelineManifest) => void;
  onCommit: () => void;
  setPxPerSec: (updater: (prev: number) => number) => void;
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
  onAddTrack?: () => void;
  volumeEditClipId?: string | null;
  onVolumePointsChange?: (clipId: string, points: VolumeAutomationPoint[]) => void;
  onVolumeSeek?: (t: number) => void;
  onVolumeClear?: (clipId: string) => void;
}) {
  const {
    manifest,
    pxPerSec,
    playhead,
    selectedClipIds,
    onSeek,
    onSelectClip,
    onChange,
    onCommit,
    setPxPerSec,
    onClipContextMenu,
    onTrackContextMenu,
    onSurfaceContextMenu,
    onTransitionChange,
    onTransitionCommit,
    onPruneTransitions,
    onAddTrack,
    volumeEditClipId,
    onVolumePointsChange,
    onVolumeSeek,
    onVolumeClear,
  } = props;

  const dragRef = useRef<DragState | null>(null);
  const [hoveredJunction, setHoveredJunction] = useState<string | null>(null);
  const [transitionMenu, setTransitionMenu] = useState<{
    x: number;
    y: number;
    trackId: string;
    outgoingClipId: string;
  } | null>(null);
  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const gestureCommittedRef = useRef(false);

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
      if (e.shiftKey) {
        // Shift+wheel → horizontal scroll.
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

  function renameTrack(trackId: string, name: string) {
    onCommit();
    onChange({
      ...manifest,
      tracks: manifest.tracks.map((t) => (t.id === trackId ? { ...t, name } : t)),
    });
  }

  function toggleTrackHidden(trackId: string) {
    onCommit();
    onChange({
      ...manifest,
      tracks: manifest.tracks.map((t) =>
        t.id === trackId ? { ...t, hidden: !t.hidden } : t
      ),
    });
  }

  function mutateClip(trackId: string, clipId: string, patch: Partial<TimelineClip>) {
    onChange({
      ...manifest,
      tracks: manifest.tracks.map((t) =>
        t.id !== trackId
          ? t
          : {
              ...t,
              clips: t.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
            }
      ),
    });
  }

  /** Move a clip to another track (cross-lane drag), placing it at ``newStart``. */
  function moveClipToTrack(
    fromTrackId: string,
    toTrackId: string,
    clip: TimelineClip,
    newStart: number
  ) {
    onChange({
      ...manifest,
      tracks: manifest.tracks.map((t) => {
        if (t.id === fromTrackId) {
          return { ...t, clips: t.clips.filter((c) => c.id !== clip.id) };
        }
        if (t.id === toTrackId) {
          const base =
            t.kind === "neutral" && t.clips.length === 0
              ? promoteTrackKind(t, trackKindForClip(clip), manifest.tracks)
              : t;
          return { ...base, clips: [...base.clips, { ...clip, start: newStart }] };
        }
        return t;
      }),
    });
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
    const el = laneAreaRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const idx = Math.floor((clientY - rect.top - RULER_H) / ROW_H);
    if (idx < 0 || idx >= manifest.tracks.length) return null;
    return manifest.tracks[idx].id;
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
    onSelectClip(clip.id, e.shiftKey || e.ctrlKey || e.metaKey);
    gestureCommittedRef.current = false;
    dragRef.current = {
      kind,
      trackId: track.id,
      clipId: clip.id,
      startX: e.clientX,
      orig: clip,
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
      const newStart = snapMove(clamp(o.start + dt, 0, Infinity), o.duration, o.id);
      // Cross-lane drag: drop onto whichever same-kind track row is under the cursor.
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
      const minShift = hasSrc ? -o.inPoint / speed : -Infinity;
      const maxShift = o.duration - MIN_DUR;
      let shift = clamp(dt, Math.max(minShift, -o.start), maxShift);
      // Snap the head to the playhead or another clip edge when close.
      const snappedHead = snapEdge(o.start + shift, o.id);
      if (snappedHead != null) {
        shift = clamp(snappedHead - o.start, Math.max(minShift, -o.start), maxShift);
      }
      const newStart = o.start + shift;
      const newInPoint = hasSrc ? o.inPoint + shift * speed : o.inPoint;
      const newDuration = o.duration - shift;
      mutateClip(d.trackId, d.clipId, {
        start: newStart,
        inPoint: Math.max(0, newInPoint),
        duration: newDuration,
        outPoint: hasSrc ? Math.max(0, newInPoint) + newDuration * speed : o.outPoint,
      });
      return;
    }
    if (d.kind === "trimR") {
      let newDuration = clamp(o.duration + dt, MIN_DUR, maxDur);
      // Snap the tail to the playhead or another clip edge when close.
      const snappedTail = snapEdge(o.start + newDuration, o.id);
      if (snappedTail != null) {
        newDuration = clamp(snappedTail - o.start, MIN_DUR, maxDur);
      }
      mutateClip(d.trackId, d.clipId, {
        duration: newDuration,
        outPoint: hasSrc ? o.inPoint + newDuration * speed : o.outPoint,
      });
      return;
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    // Finish track reorder drag.
    if (trackDragRef.current) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      const { trackId } = trackDragRef.current;
      const dropIdx = getTrackDropIndexFromY(e.clientY);
      trackDragRef.current = null;
      setTrackDropIndex(null);
      const tracks = manifest.tracks;
      const fromIdx = tracks.findIndex((t) => t.id === trackId);
      if (fromIdx !== -1 && dropIdx !== fromIdx && dropIdx !== fromIdx + 1) {
        const next = [...tracks];
        const [moved] = next.splice(fromIdx, 1);
        const insertAt = dropIdx > fromIdx ? dropIdx - 1 : dropIdx;
        next.splice(insertAt, 0, moved);
        onCommit();
        onChange({ ...manifest, tracks: next });
      }
      return;
    }
    if (dragRef.current) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      const hadGesture = gestureCommittedRef.current;
      dragRef.current = null;
      gestureCommittedRef.current = false;
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

  function seekFromClientX(clientX: number) {
    const el = laneAreaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // The ruler/lanes begin after the sticky LABEL_W column; subtract it so the
    // click maps to the same content-x the playhead overlay is drawn at.
    const t = (clientX - rect.left + el.scrollLeft - LABEL_W) / pxPerSec;
    onSeek(clamp(t, 0, Infinity));
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
              seekFromClientX(e.clientX);
            }}
            onContextMenu={(e) => {
              if (!onSurfaceContextMenu) return;
              e.preventDefault();
              e.stopPropagation();
              onSurfaceContextMenu(null, e.clientX, e.clientY);
            }}
          >
            {Array.from({ length: Math.ceil(contentSec) + 1 }).map((_, s) => (
              <div
                key={s}
                style={{
                  position: "absolute",
                  left: s * pxPerSec,
                  top: 0,
                  height: RULER_H,
                  borderLeft: "1px solid rgba(255,255,255,0.12)",
                  paddingLeft: 3,
                  fontSize: 9,
                  color: "rgba(255,255,255,0.45)",
                  userSelect: "none",
                }}
              >
                {s}s
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
            <div
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
                if (e.target === e.currentTarget) {
                  onSelectClip(null, false);
                  seekFromClientX(e.clientX);
                }
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
                      : `${clipTrackLabel(clip)} · ${clip.speed !== 1 ? `${clip.speed}× · ` : ""}${clip.duration.toFixed(1)}s`}
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
            </div>
            </div>  {/* close row div */}
          </React.Fragment>
        ))}
        {/* Drop indicator at the very bottom */}
        {trackDropIndex === manifest.tracks.length && (
          <div style={{ height: 3, background: "#ffd166", marginLeft: LABEL_W, width: laneWidth }} />
        )}

        {/* Playhead overlay (spans ruler + rows, offset past the label column). */}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: LABEL_W + playhead * pxPerSec,
            width: 2,
            background: "#ff5d5d",
            pointerEvents: "none",
            zIndex: 5,
          }}
        />
      </div>
      </div>

      {onAddTrack ? <AddTrackStrip onClick={onAddTrack} /> : null}

      <ClipTransitionMenu
        open={!!transitionMenu}
        x={transitionMenu?.x ?? 0}
        y={transitionMenu?.y ?? 0}
        transition={menuOutgoingClip?.transitionOut}
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
}

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
