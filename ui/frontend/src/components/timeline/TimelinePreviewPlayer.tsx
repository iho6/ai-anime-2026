"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { assetUrlFromRelPath, TimelineManifest, TimelineClip } from "../../lib/api";
import {
  activeClipAt,
  aspectRatio,
  clamp,
  clipImageRect,
  clipTransformFromRectCenter,
  snapClipRectToFrame,
  sourceTimeAt,
  timelineDuration,
  type AlignGuide,
  type ClipTransform,
} from "./timelineUtil";
import { TrajectoryEditor, TrajectoryWaypoint } from "./TrajectoryEditor";
import { resolveTrajectoryTransformAt } from "./trajectoryMotion";
import type { TrajectoryMotionId } from "../../lib/api";

/**
 * Resolve the effective transform for a clip at a given playhead time.
 * Trajectory interpolation only applies while playing or while the clip
 * is the active trajectory clip — otherwise the static transform is used
 * so manual dragging in the preview continues to work normally.
 */
function clipTransform(
  clip: TimelineClip,
  playhead: number,
  isTrajectoryActive: boolean,
  isPlaying: boolean
): ClipTransform {
  if (isPlaying || isTrajectoryActive) {
    const traj = resolveTrajectoryTransformAt(clip, playhead, {
      applyMotion: isPlaying || isTrajectoryActive,
    });
    if (traj) return traj;
  }
  return { ...(clip.transform ?? { x: 0, y: 0, scale: 1 }), rotation: 0, opacity: 1 };
}

/**
 * Browser real-time composite preview. Stacks one element per *visible* video
 * track (top track = topmost layer) plus audio elements, all driven by a single
 * playhead clock owned by the parent. While playing, a rAF loop advances the
 * playhead; media elements run natively and are re-seeked on (de)activation and
 * when the parent scrubs. Each layer is clickable to select it, and when paused
 * the selected layer can be moved/scaled directly (handles hug the image).
 */
export function TimelinePreviewPlayer(props: {
  manifest: TimelineManifest;
  playing: boolean;
  playhead: number;
  selectedClipId: string | null;
  editable: boolean;
  onPlayheadChange: (t: number) => void;
  onEnded: () => void;
  onSelectClip: (clipId: string | null, additive?: boolean) => void;
  onClipTransformChange: (clipId: string, transform: ClipTransform) => void;
  onTransformStart?: () => void;
  onClipContextMenu?: (clipId: string, x: number, y: number) => void;
  trajectoryClipId?: string | null;
  onWaypointChange?: (clipId: string, waypoints: TrajectoryWaypoint[]) => void;
  onMotionChange?: (
    clipId: string,
    motion: TrajectoryMotionId,
    motionAmount: number
  ) => void;
  onDeleteTrajectory?: (clipId: string) => void;
  height?: number;
}) {
  const {
    manifest,
    playing,
    playhead,
    selectedClipId,
    editable,
    onPlayheadChange,
    onEnded,
    onSelectClip,
    onClipTransformChange,
    onTransformStart,
    onClipContextMenu,
    trajectoryClipId,
    onWaypointChange,
    onMotionChange,
    onDeleteTrajectory,
    height = 260,
  } = props;

  const total = timelineDuration(manifest);
  const ratio = aspectRatio(manifest.previewAspect);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const mediaRefs = useRef<Map<string, HTMLVideoElement | HTMLAudioElement>>(new Map());
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const [alignGuides, setAlignGuides] = useState<AlignGuide[]>([]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cr = e.contentRect;
        setFrameSize({ w: cr.width, h: cr.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Visible tracks only (hidden tracks excluded from playback compositing).
  const videoTracks = useMemo(
    () => manifest.tracks.filter((t) => t.kind === "video" && !t.hidden),
    [manifest.tracks]
  );
  const audioTracks = useMemo(
    () => manifest.tracks.filter((t) => t.kind === "audio" && !t.hidden),
    [manifest.tracks]
  );

  // rAF master clock while playing.
  const rafRef = useRef<number | null>(null);
  const anchorRef = useRef<{ wall: number; head: number } | null>(null);

  useEffect(() => {
    if (!playing) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      anchorRef.current = null;
      return;
    }
    anchorRef.current = { wall: performance.now(), head: playhead };
    const tick = () => {
      const a = anchorRef.current;
      if (!a) return;
      const t = a.head + (performance.now() - a.wall) / 1000;
      if (total > 0 && t >= total) {
        onPlayheadChange(total);
        onEnded();
        return;
      }
      onPlayheadChange(t);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, total]);

  // Sync media elements: seek + play/pause to match the current playhead.
  useEffect(() => {
    const seen = new Set<string>();
    const allTracks = [...videoTracks, ...audioTracks];
    for (const track of allTracks) {
      const clip = activeClipAt(track, playhead);
      if (!clip || clip.type === "image") continue;
      seen.add(clip.id);
      const el = mediaRefs.current.get(clip.id);
      if (!el) continue;
      const want = sourceTimeAt(clip, playhead);
      el.playbackRate = clip.speed || 1;
      if (!playing) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - want) > 0.05) {
          try {
            el.currentTime = want;
          } catch {
            /* not seekable yet */
          }
        }
      } else {
        if (Math.abs(el.currentTime - want) > 0.35) {
          try {
            el.currentTime = want;
          } catch {
            /* not seekable yet */
          }
        }
        if (el.paused) void el.play().catch(() => {});
      }
    }
    for (const [id, el] of mediaRefs.current) {
      if (!seen.has(id) && !el.paused) el.pause();
    }
  }, [playhead, playing, videoTracks, audioTracks]);

  // --- Layer move / scale drag (operates on a specific clip) --------------
  const dragRef = useRef<
    | {
        mode: "move" | "scale";
        clipId: string;
        startX: number;
        startY: number;
        orig: ClipTransform;
        w: number;
        h: number;
      }
    | null
  >(null);

  function beginDrag(
    e: React.PointerEvent,
    clip: TimelineClip,
    mode: "move" | "scale"
  ) {
    e.preventDefault();
    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    onSelectClip(clip.id, additive);
    if (!editable) return; // selection only while playing
    onTransformStart?.();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode,
      clipId: clip.id,
      startX: e.clientX,
      startY: e.clientY,
      orig: clipTransform(clip, playhead, clip.id === trajectoryClipId, playing),
      w: frameSize.w || 1,
      h: frameSize.h || 1,
    };
  }

  function onDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === "move") {
      const x = d.orig.x + (e.clientX - d.startX) / d.w;
      const y = d.orig.y + (e.clientY - d.startY) / d.h;
      const clip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
      const frameW = d.w;
      const frameH = d.h;
      if (clip && frameW > 0 && frameH > 0) {
        const rawRect = clipImageRect(clip, { ...d.orig, x, y }, frameW, frameH);
        const { rect: snappedRect, guides } = snapClipRectToFrame(rawRect, frameW, frameH);
        const snapped = clipTransformFromRectCenter(snappedRect, frameW, frameH);
        setAlignGuides(guides);
        onClipTransformChange(d.clipId, {
          ...d.orig,
          x: clamp(snapped.x, -1.5, 1.5),
          y: clamp(snapped.y, -1.5, 1.5),
        });
      } else {
        setAlignGuides([]);
        onClipTransformChange(d.clipId, {
          ...d.orig,
          x: clamp(x, -1.5, 1.5),
          y: clamp(y, -1.5, 1.5),
        });
      }
    } else {
      const scale = clamp(d.orig.scale + ((e.clientX - d.startX) / d.w) * 2, 0.1, 6);
      onClipTransformChange(d.clipId, { ...d.orig, scale });
    }
  }

  function endDrag(e: React.PointerEvent) {
    if (dragRef.current) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
      setAlignGuides([]);
    }
  }

  const noVisibleLayer = videoTracks.every((t) => !activeClipAt(t, playhead));

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div
        ref={frameRef}
        onPointerDown={(e) => {
          // Click on empty frame background → deselect.
          if (e.target === e.currentTarget) onSelectClip(null, false);
        }}
        style={{
          position: "relative",
          height,
          aspectRatio: String(ratio),
          background: "#000",
          overflow: "visible",
          border: "2px solid rgba(255,255,255,0.45)",
          boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
        }}
      >
        {/*
          Two-pass rendering:
          Pass 1 (inside overflow:hidden) — images clipped to the frame boundary.
          Pass 2 (outside overflow:hidden) — pointer events + selection outlines that can extend beyond the frame.
        */}

        {/* Pass 1: image layer — clipped to frame */}
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
          {videoTracks.map((track, i) => {
            const clip = activeClipAt(track, playhead);
            if (!clip) return null;
            const z = videoTracks.length - i;
            const tf = clipTransform(clip, playhead, clip.id === trajectoryClipId, playing);
            const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
            const src = assetUrlFromRelPath(clip.srcRelPath);
            const mediaStyle: React.CSSProperties = {
              width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none",
            };
            const rot = tf.rotation ?? 0;
            const op = tf.opacity ?? 1;
            return (
              <div
                key={clip.id}
                style={{
                  position: "absolute",
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  zIndex: z,
                  transform: rot !== 0 ? `rotate(${rot}deg)` : undefined,
                  transformOrigin: "center center",
                }}
              >
                {clip.type === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    alt=""
                    draggable={false}
                    style={{ ...mediaStyle, opacity: op }}
                  />
                ) : (
                  <video
                    ref={(el) => {
                      if (el) mediaRefs.current.set(clip.id, el);
                      else mediaRefs.current.delete(clip.id);
                    }}
                    src={src}
                    muted
                    playsInline
                    style={{ ...mediaStyle, opacity: op }}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Pass 2: interaction + outline layer — overflow visible, outlines extend beyond frame */}
        {videoTracks.map((track, i) => {
          const clip = activeClipAt(track, playhead);
          if (!clip) return null;
          const z = videoTracks.length - i;
          const tf = clipTransform(clip, playhead, clip.id === trajectoryClipId, playing);
          const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
          const selected = clip.id === selectedClipId;
          return (
            <div
              key={clip.id}
              onPointerDown={(e) => beginDrag(e, clip, "move")}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClipContextMenu?.(clip.id, e.clientX, e.clientY);
              }}
              style={{
                position: "absolute",
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                zIndex: z,
                cursor: editable ? "move" : "pointer",
                outline: selected
                  ? editable ? "2px dashed #ffd166" : "2px solid #5ad7ff"
                  : "none",
                outlineOffset: 2,
              }}
            >
              {/* Scale handle */}
              {selected && editable ? (
                <div
                  onPointerDown={(e) => beginDrag(e, clip, "scale")}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  style={{
                    position: "absolute",
                    right: -7,
                    bottom: -7,
                    width: 14,
                    height: 14,
                    background: "#ffd166",
                    border: "1px solid #000",
                    cursor: "nwse-resize",
                  }}
                />
              ) : null}
            </div>
          );
        })}

        {/* Alignment guide lines (shown while dragging) */}
        {alignGuides.length > 0 ? (
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 9998 }}>
            {alignGuides.map((guide, i) => (
              <div
                key={`${guide.axis}-${guide.pos}-${guide.kind}-${i}`}
                style={
                  guide.axis === "x"
                    ? {
                        position: "absolute",
                        left: guide.pos,
                        top: 0,
                        bottom: 0,
                        width: 0,
                        borderLeft: `1px dashed ${guide.kind === "center" ? "#5ad7ff" : "#ffd166"}`,
                      }
                    : {
                        position: "absolute",
                        top: guide.pos,
                        left: 0,
                        right: 0,
                        height: 0,
                        borderTop: `1px dashed ${guide.kind === "center" ? "#5ad7ff" : "#ffd166"}`,
                      }
                }
              />
            ))}
          </div>
        ) : null}

        {/* Trajectory editor overlay */}
        {trajectoryClipId && (() => {
          const trajClip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === trajectoryClipId);
          if (!trajClip || !trajClip.trajectory) return null;
          return (
            <TrajectoryEditor
              key={trajClip.id}
              clip={trajClip}
              frameW={frameSize.w}
              frameH={frameSize.h}
              playing={playing}
              onWaypointsChange={(wps) => onWaypointChange?.(trajClip.id, wps)}
              onMotionChange={(motion, motionAmount) =>
                onMotionChange?.(trajClip.id, motion, motionAmount)
              }
              onPlayheadSync={onPlayheadChange}
              onDeleteTrajectory={() => onDeleteTrajectory?.(trajClip.id)}
            />
          );
        })()}

        {/* Hidden audio elements for music/audio tracks. */}
        {audioTracks.map((track) => {
          const clip = activeClipAt(track, playhead);
          if (!clip || clip.type !== "audio" || !clip.srcRelPath) return null;
          return (
            <audio
              key={clip.id}
              ref={(el) => {
                if (el) mediaRefs.current.set(clip.id, el);
                else mediaRefs.current.delete(clip.id);
              }}
              src={assetUrlFromRelPath(clip.srcRelPath)}
            />
          );
        })}

        {noVisibleLayer ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "rgba(255,255,255,0.4)",
              fontSize: 13,
              zIndex: 0,
              pointerEvents: "none",
            }}
          >
            No layer at playhead
          </div>
        ) : null}
      </div>
    </div>
  );
}
