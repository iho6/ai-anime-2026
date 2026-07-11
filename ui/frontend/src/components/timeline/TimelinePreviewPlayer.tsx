"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  assetUrlFromRelPath,
  TimelineManifest,
  TimelineClip,
  TimelineGeometry,
  TimelineText,
} from "../../lib/api";
import {
  activeClipAt,
  activeLayersAt,
  type ActiveLayer,
  aspectRatio,
  clamp,
  clipImageRect,
  clipTransformFromRectCenter,
  snapClipRectToFrame,
  snapClipScaleToFrame,
  sourceTimeAt,
  sourceTimeAtWithTransition,
  timelineDuration,
  type AlignGuide,
  type ClipTransform,
} from "./timelineUtil";
import type { TimelineTrack } from "../../lib/api";
import { TrajectoryEditor, TrajectoryWaypoint } from "./TrajectoryEditor";
import { resolveTrajectoryTransformAt } from "./trajectoryMotion";
import { volumeGainAt } from "./volumeAutomation";
import type { TrajectoryMotionId } from "../../lib/api";
import { GeometryClipLayer } from "./GeometryClipLayer";
import { GeometryEditor } from "./GeometryEditor";
import { GEOMETRY_STYLE_BAR_OFFSET } from "./GeometryStyleBar";
import { TextClipLayer } from "./TextClipLayer";
import { TextStyleBar, type TextStyleModal } from "./TextStyleBar";
import { TextPickerModals } from "./TextPickerModals";
import { ClipColoringCanvas } from "./ClipColoringCanvas";
import { clipNeedsColoringCanvas } from "../../lib/clipColoring";
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

export function TimelinePreviewPlayer(props: {
  manifest: TimelineManifest;
  timelineKey: string;
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
  geometryEditClipId?: string | null;
  textEditClipId?: string | null;
  onWaypointChange?: (clipId: string, waypoints: TrajectoryWaypoint[]) => void;
  onMotionChange?: (
    clipId: string,
    motion: TrajectoryMotionId,
    motionAmount: number
  ) => void;
  onDeleteTrajectory?: (clipId: string) => void;
  onGeometryChange?: (clipId: string, geometry: TimelineGeometry) => void;
  onGeometryCommit?: () => void;
  onExitGeometryEdit?: () => void;
  onTextChange?: (clipId: string, patch: Partial<TimelineText>) => void;
  onTextContentChange?: (clipId: string, content: string) => void;
  onTextEditEnd?: () => void;
  onRequestTextEdit?: (clipId: string) => void;
  onRequestGeometryEdit?: (clipId: string) => void;
  onGeometryContextMenu?: (clipId: string, clientX: number, clientY: number) => void;
  onExitClipEditModes?: () => void;
  height?: number;
}) {
  const {
    manifest,
    timelineKey,
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
    geometryEditClipId,
    textEditClipId,
    onWaypointChange,
    onMotionChange,
    onDeleteTrajectory,
    onGeometryChange,
    onGeometryCommit,
    onExitGeometryEdit,
    onTextChange,
    onTextContentChange,
    onTextEditEnd,
    onRequestTextEdit,
    onRequestGeometryEdit,
    onGeometryContextMenu,
    onExitClipEditModes,
    height = 260,
  } = props;

  const total = timelineDuration(manifest);
  const ratio = aspectRatio(manifest.previewAspect);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const mediaRefs = useRef<Map<string, HTMLVideoElement | HTMLAudioElement>>(new Map());
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const [alignGuides, setAlignGuides] = useState<AlignGuide[]>([]);
  const [textStyleModal, setTextStyleModal] = useState<TextStyleModal>(null);
  const [geometryStyleModalOpen, setGeometryStyleModalOpen] = useState(false);

  useEffect(() => {
    if (!geometryEditClipId) setGeometryStyleModalOpen(false);
  }, [geometryEditClipId]);

  const selectedClip = useMemo(() => {
    if (!selectedClipId) return null;
    for (const t of manifest.tracks) {
      const c = t.clips.find((x) => x.id === selectedClipId);
      if (c) return c;
    }
    return null;
  }, [manifest.tracks, selectedClipId]);

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

  const videoTracks = useMemo(
    () => manifest.tracks.filter((t) => t.kind === "video" && !t.hidden),
    [manifest.tracks]
  );
  const audioTracks = useMemo(
    () => manifest.tracks.filter((t) => t.kind === "audio" && !t.hidden),
    [manifest.tracks]
  );

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

  useEffect(() => {
    const seen = new Set<string>();
    const allTracks = [...videoTracks, ...audioTracks];
    for (const track of allTracks) {
      const clipsToSync =
        track.kind === "video"
          ? activeLayersAt(track, playhead)
              .filter((l) => l.clip.type === "video" && l.opacity > 0.01)
              .map((l) => l.clip)
          : (() => {
              const c = activeClipAt(track, playhead);
              return c?.type === "audio" ? [c] : [];
            })();
      for (const clip of clipsToSync) {
      seen.add(clip.id);
      const el = mediaRefs.current.get(clip.id);
      if (!el) continue;
      const want =
        track.kind === "video"
          ? sourceTimeAtWithTransition(clip, playhead, track)
          : sourceTimeAt(clip, playhead);
      const reversed = !!clip.reversed;
      el.playbackRate = clip.speed || 1;
      if (track.kind === "audio") {
        el.volume = clamp(volumeGainAt(clip, playhead), 0, 1);
      }
      const seekThreshold = reversed ? 0.05 : playing ? 0.35 : 0.05;
      if (!playing || reversed) {
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - want) > seekThreshold) {
          try {
            el.currentTime = want;
          } catch {
            /* not seekable yet */
          }
        }
      } else {
        if (Math.abs(el.currentTime - want) > seekThreshold) {
          try {
            el.currentTime = want;
          } catch {
            /* not seekable yet */
          }
        }
        if (el.paused) void el.play().catch(() => {});
      }
      }
    }
    for (const [id, el] of mediaRefs.current) {
      if (!seen.has(id) && !el.paused) el.pause();
    }
  }, [playhead, playing, videoTracks, audioTracks]);

  useEffect(() => {
    setTextStyleModal(null);
  }, [selectedClipId]);

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

  const pendingDragRef = useRef<{
    clip: TimelineClip;
    mode: "move" | "scale";
    startX: number;
    startY: number;
    pointerId: number;
    target: HTMLElement;
    wasSelected: boolean;
  } | null>(null);

  const DRAG_THRESHOLD_PX = 4;

  function startDragFromPending(
    e: React.PointerEvent,
    p: NonNullable<typeof pendingDragRef.current>
  ) {
    if (!editable) return;
    e.preventDefault();
    onTransformStart?.();
    p.target.setPointerCapture?.(p.pointerId);
    dragRef.current = {
      mode: p.mode,
      clipId: p.clip.id,
      startX: p.startX,
      startY: p.startY,
      orig: clipTransform(p.clip, playhead, p.clip.id === trajectoryClipId, playing),
      w: frameSize.w || 1,
      h: frameSize.h || 1,
    };
    pendingDragRef.current = null;
    onDragMove(e);
  }

  function beginDrag(
    e: React.PointerEvent,
    clip: TimelineClip,
    mode: "move" | "scale"
  ) {
    if (geometryEditClipId === clip.id) return;
    if (textEditClipId === clip.id) return;
    e.preventDefault();
    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    onSelectClip(clip.id, additive);
    if (!editable) return;
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

  function beginTextPointerDown(
    e: React.PointerEvent,
    clip: TimelineClip,
    mode: "move" | "scale"
  ) {
    if (geometryEditClipId === clip.id) return;
    if (textEditClipId === clip.id) return;
    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    onSelectClip(clip.id, additive);
    if (!editable) return;
    if (mode === "scale") {
      beginDrag(e, clip, "scale");
      return;
    }
    pendingDragRef.current = {
      clip,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      target: e.currentTarget as HTMLElement,
      wasSelected: clip.id === selectedClipId,
    };
  }

  function onPointerMoveCombined(e: React.PointerEvent) {
    const p = pendingDragRef.current;
    if (p) {
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        startDragFromPending(e, p);
      }
    }
    onDragMove(e);
  }

  function onPointerUpCombined(e: React.PointerEvent) {
    const p = pendingDragRef.current;
    if (p && !dragRef.current && p.mode === "move" && p.clip.type === "text" && p.wasSelected) {
      onRequestTextEdit?.(p.clip.id);
    }
    pendingDragRef.current = null;
    endDrag(e);
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
      const clip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
      const tentative = clamp(d.orig.scale + ((e.clientX - d.startX) / d.w) * 2, 0.1, 6);
      if (clip && d.w > 0 && d.h > 0) {
        const { scale, guides } = snapClipScaleToFrame(
          clip,
          { ...d.orig, scale: tentative },
          d.w,
          d.h
        );
        setAlignGuides(guides);
        onClipTransformChange(d.clipId, { ...d.orig, scale });
      } else {
        setAlignGuides([]);
        onClipTransformChange(d.clipId, { ...d.orig, scale: tentative });
      }
    }
  }

  function endDrag(e: React.PointerEvent) {
    if (dragRef.current) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
      setAlignGuides([]);
    }
  }

  function layerVisible(layer: ActiveLayer): boolean {
    if (layer.opacity > 0.001) return true;
    if (layer.clipPath) return true;
    if (layer.slideOffsetX || layer.slideOffsetY) return true;
    return false;
  }

  const videoRenderLayers = useMemo(() => {
    const out: Array<{
      clip: TimelineClip;
      layer: ActiveLayer;
      trackZ: number;
      track: TimelineTrack;
    }> = [];
    videoTracks.forEach((track, i) => {
      const trackZ = videoTracks.length - i;
      for (const layer of activeLayersAt(track, playhead)) {
        if (layerVisible(layer)) {
          out.push({ clip: layer.clip, layer, trackZ, track });
        }
      }
    });
    return out;
  }, [videoTracks, playhead]);

  const interactionLayers = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ clip: TimelineClip; trackZ: number; track: TimelineTrack }> = [];
    videoTracks.forEach((track, i) => {
      const trackZ = videoTracks.length - i;
      const layers = activeLayersAt(track, playhead).filter(layerVisible);
      for (let j = layers.length - 1; j >= 0; j--) {
        const { clip } = layers[j];
        if (seen.has(clip.id)) continue;
        seen.add(clip.id);
        out.push({ clip, trackZ, track });
      }
    });
    return out;
  }, [videoTracks, playhead]);

  const noVisibleLayer = videoRenderLayers.length === 0;

  function renderClipContent(
    clip: TimelineClip,
    op: number,
    sourceTimeSec: number,
    track: TimelineTrack
  ) {
    if (clip.type === "geometry") {
      return (
        <GeometryClipLayer
          clip={clip}
          opacity={op}
          editing={geometryEditClipId === clip.id}
        />
      );
    }
    if (clip.type === "text") {
      if (textEditClipId === clip.id) return null;
      const isSelected = clip.id === selectedClipId;
      return (
        <TextClipLayer
          clip={clip}
          opacity={op}
          selected={isSelected}
          showResizeHandle={isSelected && editable}
          editing={false}
        />
      );
    }
    if (clip.type === "image") {
      const src = assetUrlFromRelPath(clip.srcRelPath);
      if (clipNeedsColoringCanvas(clip)) {
        return (
          <ClipColoringCanvas
            clip={clip}
            timelineKey={timelineKey}
            sourceTimeSec={sourceTimeSec}
            playing={playing}
            previewFps={manifest.fps}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              pointerEvents: "none",
              opacity: op,
            }}
          />
        );
      }
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
            pointerEvents: "none",
            opacity: op,
          }}
        />
      );
    }
    if (clip.type === "video") {
      const src = assetUrlFromRelPath(clip.srcRelPath);
      if (clipNeedsColoringCanvas(clip)) {
        return (
          <ClipColoringCanvas
            clip={clip}
            timelineKey={timelineKey}
            sourceTimeSec={sourceTimeSec}
            playing={playing}
            previewFps={manifest.fps}
            setVideoRef={(el) => {
              if (el) mediaRefs.current.set(clip.id, el);
              else mediaRefs.current.delete(clip.id);
            }}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              pointerEvents: "none",
              opacity: op,
            }}
          />
        );
      }
      return (
        <video
          ref={(el) => {
            if (el) mediaRefs.current.set(clip.id, el);
            else mediaRefs.current.delete(clip.id);
          }}
          src={src}
          muted
          playsInline
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
            pointerEvents: "none",
            opacity: op,
          }}
        />
      );
    }
    return null;
  }

  const selectedTextRect =
    selectedClip?.type === "text" && selectedClipId
      ? clipImageRect(
          selectedClip,
          clipTransform(selectedClip, playhead, false, playing),
          frameSize.w,
          frameSize.h
        )
      : null;

  const geometryEditRect = useMemo(() => {
    if (!geometryEditClipId || frameSize.w < 1) return null;
    const gClip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === geometryEditClipId);
    if (!gClip?.geometry) return null;
    const tf = clipTransform(gClip, playhead, false, playing);
    const clipRect = clipImageRect(gClip, tf, frameSize.w, frameSize.h);
    const styleBand = GEOMETRY_STYLE_BAR_OFFSET + 8;
    return {
      left: clipRect.left,
      top: Math.max(0, clipRect.top - styleBand),
      width: clipRect.width,
      height: clipRect.height + styleBand,
    };
  }, [geometryEditClipId, videoTracks, playhead, playing, frameSize.w, frameSize.h]);

  const textEditRect = useMemo(() => {
    if (!textEditClipId || frameSize.w < 1) return null;
    const tClip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === textEditClipId);
    if (!tClip || tClip.type !== "text") return null;
    const tf = clipTransform(tClip, playhead, false, playing);
    return clipImageRect(tClip, tf, frameSize.w, frameSize.h);
  }, [textEditClipId, videoTracks, playhead, playing, frameSize.w, frameSize.h]);

  function pointInRect(x: number, y: number, rect: { left: number; top: number; width: number; height: number }) {
    const frameEl = frameRef.current;
    if (!frameEl) return false;
    const fr = frameEl.getBoundingClientRect();
    const left = fr.left + rect.left;
    const top = fr.top + rect.top;
    return x >= left && x <= left + rect.width && y >= top && y <= top + rect.height;
  }

  function handleFramePointerDownCapture(e: React.PointerEvent) {
    if (!editable || playing || !onExitClipEditModes) return;
    if (!textEditClipId && !geometryEditClipId) return;

    const target = e.target as HTMLElement;
    if (target.closest("[data-text-style-bar]")) return;
    if (target.closest("[data-geometry-style-bar]")) return;
    if (target.closest("[data-geometry-picker-modal]")) return;
    if (target.closest("[data-geometry-editor]")) return;
    if (target.closest("[data-trajectory-editor]")) return;
    if (target.closest("[data-trajectory-toolbar]")) return;
    if (geometryStyleModalOpen) return;

    const { clientX: x, clientY: y } = e;
    let shouldExit = false;

    if (textEditClipId) {
      const inText =
        textEditRect != null &&
        pointInRect(x, y, textEditRect);
      if (!inText) shouldExit = true;
    }
    if (geometryEditClipId) {
      const inGeometry =
        geometryEditRect != null &&
        pointInRect(x, y, geometryEditRect);
      if (!inGeometry) shouldExit = true;
    }

    if (shouldExit) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      onExitClipEditModes();
    }
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", width: "100%" }}>
      <div
        ref={frameRef}
        data-timeline-preview-frame
        onPointerDownCapture={handleFramePointerDownCapture}
        onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("[data-preview-clip-hit]")) return;
          if (t.closest("[data-trajectory-editor]")) return;
          if (t.closest("[data-geometry-editor]")) return;
          if (t.closest("[data-text-style-bar]")) return;
          onSelectClip(null, false);
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
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
          {videoRenderLayers.map(({ clip, layer, trackZ, track }) => {
            const tf = clipTransform(clip, playhead, clip.id === trajectoryClipId, playing);
            const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
            const rot = tf.rotation ?? 0;
            const op = (tf.opacity ?? 1) * layer.opacity;
            const slideX = layer.slideOffsetX ?? 0;
            const slideY = layer.slideOffsetY ?? 0;
            const transforms = [
              rot !== 0 ? `rotate(${rot}deg)` : "",
              slideX !== 0 || slideY !== 0
                ? `translate(${slideX * rect.width}px, ${slideY * rect.height}px)`
                : "",
            ].filter(Boolean);
            return (
              <div
                key={`${clip.id}-${layer.role}`}
                style={{
                  position: "absolute",
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  zIndex: trackZ,
                  opacity: op,
                  clipPath: layer.clipPath,
                  overflow: layer.clipPath ? "hidden" : undefined,
                  transform: transforms.length > 0 ? transforms.join(" ") : undefined,
                  transformOrigin: "center center",
                }}
              >
                {renderClipContent(
                  clip,
                  1,
                  sourceTimeAtWithTransition(clip, playhead, track),
                  track
                )}
              </div>
            );
          })}
        </div>

        {interactionLayers.map(({ clip, trackZ }) => {
          const tf = clipTransform(clip, playhead, clip.id === trajectoryClipId, playing);
          const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
          const selected = clip.id === selectedClipId;
          const inShapeEdit = geometryEditClipId === clip.id;
          const inTrajectoryEdit = clip.id === trajectoryClipId;
          const isText = clip.type === "text";
          const isGeometry = clip.type === "geometry";
          const isTextEditing = isText && textEditClipId === clip.id;
          const textHandlers = isText
            ? {
                onPointerDown: (e: React.PointerEvent) =>
                  beginTextPointerDown(e, clip, "move"),
                onPointerMove: onPointerMoveCombined,
                onPointerUp: onPointerUpCombined,
              }
            : isGeometry
              ? {
                  onClick: (e: React.MouseEvent) => {
                    if (!editable) return;
                    e.stopPropagation();
                    onRequestGeometryEdit?.(clip.id);
                  },
                }
              : {
                  onPointerDown: (e: React.PointerEvent) => beginDrag(e, clip, "move"),
                  onPointerMove: onDragMove,
                  onPointerUp: endDrag,
                };
          return (
            <div
              key={`hit-${clip.id}`}
              data-preview-clip-hit
              {...textHandlers}
              onDoubleClick={(e) => {
                if (!editable) return;
                if (clip.type === "text") {
                  e.stopPropagation();
                  pendingDragRef.current = null;
                  onRequestTextEdit?.(clip.id);
                  return;
                }
                if (clip.type === "geometry") {
                  e.stopPropagation();
                  pendingDragRef.current = null;
                  onRequestGeometryEdit?.(clip.id);
                }
              }}
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
                zIndex: trackZ + 100,
                cursor:
                  editable && !inShapeEdit && !isTextEditing && !inTrajectoryEdit
                    ? isText
                      ? "default"
                      : "move"
                    : "pointer",
                outline:
                  selected && !inShapeEdit && !isText && !inTrajectoryEdit
                    ? editable
                      ? "2px dashed rgba(255,255,255,0.85)"
                      : "2px solid rgba(255,255,255,0.55)"
                    : "none",
                outlineOffset: 2,
                pointerEvents:
                  inShapeEdit || isTextEditing || inTrajectoryEdit ? "none" : "auto",
              }}
            >
              {isText && selected && editable && !inShapeEdit && !isTextEditing ? (
                <div
                  onPointerDown={(e) => beginTextPointerDown(e, clip, "scale")}
                  onPointerMove={onPointerMoveCombined}
                  onPointerUp={onPointerUpCombined}
                  style={{
                    position: "absolute",
                    right: 0,
                    bottom: 0,
                    width: 14,
                    height: 14,
                    transform: "translate(50%, 50%)",
                    background: "#0b0b0b",
                    border: "1px solid rgba(255,255,255,0.9)",
                    cursor: "nwse-resize",
                    zIndex: 2,
                  }}
                />
              ) : null}
              {!isText && selected && editable && !inShapeEdit && !inTrajectoryEdit ? (
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
                    background: "#0b0b0b",
                    border: "1px solid rgba(255,255,255,0.9)",
                    cursor: "nwse-resize",
                  }}
                />
              ) : null}
            </div>
          );
        })}

        {textEditClipId &&
          editable &&
          (() => {
            const editClip = videoTracks
              .flatMap((t) => t.clips)
              .find((c) => c.id === textEditClipId && c.type === "text");
            if (!editClip) return null;
            const layer = interactionLayers.find((l) => l.clip.id === editClip.id);
            const trackZ = layer?.trackZ ?? 1;
            const tf = clipTransform(editClip, playhead, false, playing);
            const rect = clipImageRect(editClip, tf, frameSize.w, frameSize.h);
            return (
              <div
                key={`text-edit-${editClip.id}`}
                data-preview-clip-hit
                style={{
                  position: "absolute",
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  zIndex: trackZ + 200,
                  pointerEvents: "auto",
                }}
              >
                <TextClipLayer
                  clip={editClip}
                  editing
                  selected
                  onContentChange={(content) =>
                    onTextContentChange?.(editClip.id, content)
                  }
                  onEditEnd={onTextEditEnd}
                />
              </div>
            );
          })()}

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
                        borderLeft: `1px dashed rgba(255,255,255,${guide.kind === "center" ? "0.9" : "0.55"})`,
                      }
                    : {
                        position: "absolute",
                        top: guide.pos,
                        left: 0,
                        right: 0,
                        height: 0,
                        borderTop: `1px dashed rgba(255,255,255,${guide.kind === "center" ? "0.9" : "0.55"})`,
                      }
                }
              />
            ))}
          </div>
        ) : null}

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

        {geometryEditClipId && (() => {
          const gClip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === geometryEditClipId);
          if (!gClip || !gClip.geometry) return null;
          const tf = clipTransform(gClip, playhead, false, playing);
          return (
            <GeometryEditor
              key={gClip.id}
              clip={gClip}
              frameW={frameSize.w}
              frameH={frameSize.h}
              transform={tf}
              onGeometryChange={(g) => onGeometryChange?.(gClip.id, g)}
              onCommit={onGeometryCommit}
              onExit={onExitGeometryEdit}
              onStyleModalChange={setGeometryStyleModalOpen}
              onGeometryContextMenu={onGeometryContextMenu}
            />
          );
        })()}

        {selectedClip?.type === "text" &&
        selectedClip.text &&
        selectedTextRect &&
        editable &&
        !playing ? (
          <TextStyleBar
            clip={selectedClip}
            rect={selectedTextRect}
            onOpenModal={setTextStyleModal}
          />
        ) : null}

        {selectedClip?.type === "text" && selectedClip.text && textStyleModal ? (
          <TextPickerModals
            open={textStyleModal}
            text={selectedClip.text}
            onClose={() => setTextStyleModal(null)}
            onChange={(patch) => onTextChange?.(selectedClip.id, patch)}
          />
        ) : null}

        {audioTracks.map((track) => {
          const clip = activeClipAt(track, playhead);
          if (!clip || clip.type !== "audio" || !clip.srcRelPath) return null;
          return (
            <audio
              key={clip.id}
              preload="auto"
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
