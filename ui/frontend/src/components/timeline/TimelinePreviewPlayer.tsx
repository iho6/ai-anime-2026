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
  sourceTimeAt,
  sourceTimeAtWithTransition,
  timelineDuration,
  type AlignGuide,
  type ClipTransform,
} from "./timelineUtil";
import type { TimelineTrack } from "../../lib/api";
import { TrajectoryEditor, TrajectoryWaypoint } from "./TrajectoryEditor";
import { resolveTrajectoryTransformAt } from "./trajectoryMotion";
import type { TrajectoryMotionId } from "../../lib/api";
import { GeometryClipLayer } from "./GeometryClipLayer";
import { GeometryEditor } from "./GeometryEditor";
import { TextClipLayer } from "./TextClipLayer";
import { TextStyleBar, type TextStyleModal } from "./TextStyleBar";
import { TextPickerModals } from "./TextPickerModals";
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
    height = 260,
  } = props;

  const total = timelineDuration(manifest);
  const ratio = aspectRatio(manifest.previewAspect);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const mediaRefs = useRef<Map<string, HTMLVideoElement | HTMLAudioElement>>(new Map());
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const [alignGuides, setAlignGuides] = useState<AlignGuide[]>([]);
  const [textStyleModal, setTextStyleModal] = useState<TextStyleModal>(null);

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
              return c?.type === "video" ? [c] : [];
            })();
      for (const clip of clipsToSync) {
      seen.add(clip.id);
      const el = mediaRefs.current.get(clip.id);
      if (!el) continue;
      const want =
        track.kind === "video"
          ? sourceTimeAtWithTransition(clip, playhead, track)
          : sourceTimeAt(clip, playhead);
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
    }
    for (const [id, el] of mediaRefs.current) {
      if (!seen.has(id) && !el.paused) el.pause();
    }
  }, [playhead, playing, videoTracks, audioTracks]);

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

  function renderClipContent(clip: TimelineClip, op: number) {
    if (clip.type === "geometry") {
      return <GeometryClipLayer clip={clip} opacity={op} />;
    }
    if (clip.type === "text") {
      const editing = textEditClipId === clip.id && editable;
      return (
        <TextClipLayer
          clip={clip}
          opacity={op}
          editing={editing}
          onContentChange={(content) => onTextContentChange?.(clip.id, content)}
          onEditEnd={onTextEditEnd}
        />
      );
    }
    if (clip.type === "image") {
      const src = assetUrlFromRelPath(clip.srcRelPath);
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

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div
        ref={frameRef}
        onPointerDown={(e) => {
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
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
          {videoRenderLayers.map(({ clip, layer, trackZ }) => {
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
                key={`${clip.id}-${layer.role}-${layer.progress}`}
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
                {renderClipContent(clip, 1)}
              </div>
            );
          })}
        </div>

        {interactionLayers.map(({ clip, trackZ }) => {
          const tf = clipTransform(clip, playhead, clip.id === trajectoryClipId, playing);
          const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
          const selected = clip.id === selectedClipId;
          const inShapeEdit = geometryEditClipId === clip.id;
          return (
            <div
              key={`hit-${clip.id}`}
              onPointerDown={(e) => beginDrag(e, clip, "move")}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onDoubleClick={(e) => {
                if (clip.type === "text" && editable) {
                  e.stopPropagation();
                  onRequestTextEdit?.(clip.id);
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
                cursor: editable && !inShapeEdit ? "move" : "pointer",
                outline:
                  selected && !inShapeEdit
                    ? editable
                      ? "2px dashed #ffd166"
                      : "2px solid #5ad7ff"
                    : "none",
                outlineOffset: 2,
                pointerEvents: inShapeEdit ? "none" : "auto",
              }}
            >
              {selected && editable && !inShapeEdit && textEditClipId !== clip.id ? (
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
            />
          );
        })()}

        {selectedClip?.type === "text" &&
        selectedClip.text &&
        selectedTextRect &&
        editable &&
        !playing &&
        textEditClipId !== selectedClip.id ? (
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
