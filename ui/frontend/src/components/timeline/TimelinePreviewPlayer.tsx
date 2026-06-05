"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { assetUrlFromRelPath, TimelineManifest, TimelineClip } from "../../lib/api";
import {
  activeClipAt,
  aspectRatio,
  clamp,
  sourceTimeAt,
  timelineDuration,
} from "./timelineUtil";

type Transform = { x: number; y: number; scale: number };
type Rect = { left: number; top: number; width: number; height: number };

function clipTransform(clip: TimelineClip): Transform {
  return clip.transform ?? { x: 0, y: 0, scale: 1 };
}

/**
 * On-screen rectangle (in frame px) of a clip's displayed image, given the
 * frame size + the clip's natural aspect + its transform. Matches an
 * ``object-fit: contain`` base box, then applies scale (about center) and the
 * fractional translate.
 */
function imageRectFor(
  clip: TimelineClip,
  tf: Transform,
  frameW: number,
  frameH: number
): Rect {
  let baseW = frameW;
  let baseH = frameH;
  const nW = clip.naturalW;
  const nH = clip.naturalH;
  if (nW && nH && frameW > 0 && frameH > 0) {
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
  const w = baseW * tf.scale;
  const h = baseH * tf.scale;
  const cx = frameW / 2 + tf.x * frameW;
  const cy = frameH / 2 + tf.y * frameH;
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
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
  onSelectClip: (clipId: string | null) => void;
  onClipTransformChange: (clipId: string, transform: Transform) => void;
  onTransformStart?: () => void;
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
    height = 260,
  } = props;

  const total = timelineDuration(manifest);
  const ratio = aspectRatio(manifest.previewAspect);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const mediaRefs = useRef<Map<string, HTMLVideoElement | HTMLAudioElement>>(new Map());
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });

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
        orig: Transform;
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
    onSelectClip(clip.id);
    if (!editable) return; // selection only while playing
    onTransformStart?.();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      mode,
      clipId: clip.id,
      startX: e.clientX,
      startY: e.clientY,
      orig: clipTransform(clip),
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
      onClipTransformChange(d.clipId, {
        ...d.orig,
        x: clamp(x, -1.5, 1.5),
        y: clamp(y, -1.5, 1.5),
      });
    } else {
      const scale = clamp(d.orig.scale + ((e.clientX - d.startX) / d.w) * 2, 0.1, 6);
      onClipTransformChange(d.clipId, { ...d.orig, scale });
    }
  }

  function endDrag(e: React.PointerEvent) {
    if (dragRef.current) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  }

  const noVisibleLayer = videoTracks.every((t) => !activeClipAt(t, playhead));

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div
        ref={frameRef}
        onPointerDown={(e) => {
          // Click on empty frame background → deselect.
          if (e.target === e.currentTarget) onSelectClip(null);
        }}
        style={{
          position: "relative",
          height,
          aspectRatio: String(ratio),
          background: "#000",
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.15)",
        }}
      >
        {/* Top track is the topmost visual layer → highest z-index. */}
        {videoTracks.map((track, i) => {
          const clip = activeClipAt(track, playhead);
          if (!clip) return null;
          const z = videoTracks.length - i;
          const tf = clipTransform(clip);
          const rect = imageRectFor(clip, tf, frameSize.w, frameSize.h);
          const selected = clip.id === selectedClipId;
          const src = assetUrlFromRelPath(clip.srcRelPath);
          const mediaStyle: React.CSSProperties = {
            width: "100%",
            height: "100%",
            objectFit: "fill",
            display: "block",
            pointerEvents: "none",
          };
          return (
            <div
              key={clip.id}
              onPointerDown={(e) => beginDrag(e, clip, "move")}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              style={{
                position: "absolute",
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                zIndex: z,
                cursor: editable ? "move" : "pointer",
                outline: selected
                  ? editable
                    ? "1.5px dashed #ffd166"
                    : "1.5px solid #5ad7ff"
                  : "none",
                outlineOffset: -1,
              }}
            >
              {clip.type === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src} alt="" draggable={false} style={mediaStyle} />
              ) : (
                <video
                  ref={(el) => {
                    if (el) mediaRefs.current.set(clip.id, el);
                    else mediaRefs.current.delete(clip.id);
                  }}
                  src={src}
                  muted
                  playsInline
                  style={mediaStyle}
                />
              )}
              {/* Scale handle on the image's own corner (paused + selected). */}
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
