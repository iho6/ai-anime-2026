"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assetUrlFromRelPath,
  previewSrcRelPath,
  TimelineManifest,
  TimelineClip,
  TimelineGeometry,
  TimelineText,
} from "../../lib/api";
import {
  activeLayersAt,
  type ActiveLayer,
  aspectRatio,
  clamp,
  clipImageRect,
  clipPathOutsideInnerFrame,
  clipRectInExtendedLayer,
  clipTransformAtPlayhead,
  computeTrajectoryEditFrameExtension,
  mergePreviewFrameExtension,
  playbackEndPlayhead,
  previewMoveTransformFromPointerDelta,
  previewFrameExtensionForRects,
  pointerClientDeltaInFrameSpace,
  snapClipScaleToFrame,
  type ClipRect,
  type PreviewFrameExtension,
  PREVIEW_FRAME_EXTENSION_NONE,
  PREVIEW_OUTSIDE_FRAME_OPACITY,
  sourceTimeAtWithTransition,
  timelineDuration,
  previewClipHitZIndex,
  PREVIEW_EDIT_Z,
  PREVIEW_HANDLE_Z,
  PREVIEW_HIT_Z,
  PREVIEW_SELECTION_CHROME_Z,
  type AlignGuide,
  type ClipTransform,
} from "./timelineUtil";
import type { TimelineTrack } from "../../lib/api";
import { usePlayheadValue, type PlayheadStore } from "./timelinePlayback";
import { TrajectoryEditor, TrajectoryWaypoint } from "./TrajectoryEditor";
import {
  previewAudioOutputsAt,
  type PreviewAudioOutput,
} from "./timelinePreviewAudio";
import type { TrajectoryMotionId } from "../../lib/api";
import { GeometryClipLayer } from "./GeometryClipLayer";
import { GeometryEditor } from "./GeometryEditor";
import { GEOMETRY_STYLE_BAR_OFFSET } from "./GeometryStyleBar";
import { TextClipLayer } from "./TextClipLayer";
import { TextStyleBar, type TextStyleModal } from "./TextStyleBar";
import { TextPickerModals } from "./TextPickerModals";
import { ClipColoringCanvas } from "./ClipColoringCanvas";
import { clipNeedsColoringCanvas } from "../../lib/clipColoring";
import { clipPreviewHoldStep, heldSourceTimeSec } from "./previewHoldFrame";
import {
  createPlaybackClock,
  getTimelinePreviewBake,
  bakeCoversPlayhead,
  previewQualityPolicy,
  resolveScene,
  timelineHasMissingProxies,
} from "./playback";
import { useWebcodecsEngine } from "./playback/webcodecs/useWebcodecsEngine";
import {
  assignPlaySlots,
  MAX_ACTIVE_VIDEO_DECODES,
  playBudgetRotationEpoch,
} from "./playback/decodeBudget";
import {
  clipPaintAgeMs,
  engineTelemetry,
  previewDebugEnabled,
  type ClipLayerDiagnostic,
} from "./playback/previewDiagnostics";
import { audioSinkMode, getPreviewAudioGraph } from "./playback/previewAudioGraph";

type DragPreviewState = {
  clipId: string;
  mode: "move" | "scale";
  to: ClipTransform;
  extend: PreviewFrameExtension;
};

export function TimelinePreviewPlayer(props: {
  manifest: TimelineManifest;
  timelineKey: string;
  playing: boolean;
  playheadStore: PlayheadStore;
  selectedClipId: string | null;
  editable: boolean;
  onPlayheadChange: (t: number) => void;
  onEnded: () => void;
  onSelectClip: (clipId: string | null, additive?: boolean) => void;
  onClipTransformChange: (
    clipId: string,
    from: ClipTransform,
    to: ClipTransform,
    mode: "move" | "scale"
  ) => void;
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
  onExitTrajectoryEdit?: () => void;
  onWaypointPatchCommit?: () => void;
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
  /** Hide selection outline/handles (e.g. while a modal covers the page). */
  suppressSelectionChrome?: boolean;
  height?: number;
  frameExtension?: PreviewFrameExtension;
  onFrameExtensionChange?: (ext: PreviewFrameExtension) => void;
}) {
  const {
    manifest,
    timelineKey,
    playing,
    playheadStore,
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
    onExitTrajectoryEdit,
    onWaypointPatchCommit,
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
    suppressSelectionChrome = false,
    height = 260,
    frameExtension = PREVIEW_FRAME_EXTENSION_NONE,
    onFrameExtensionChange,
  } = props;

  // Live playhead from the shared store: only this preview subtree (plus the
  // ruler line and time readout) re-renders on rAF ticks, not the whole page.
  const playhead = usePlayheadValue(playheadStore);

  const playbackClock = useMemo(
    () => createPlaybackClock(manifest.fps, playheadStore),
    [manifest.fps, playheadStore]
  );
  const resolvedScene = useMemo(
    () => resolveScene(manifest, playbackClock.frameAtSec(playhead)),
    [manifest, playbackClock, playhead]
  );
  const qualityPolicy = useMemo(
    () => previewQualityPolicy(playing, resolvedScene),
    [playing, resolvedScene]
  );
  const missingProxies = useMemo(() => {
    const clips = manifest.tracks.flatMap((t) => t.clips);
    return timelineHasMissingProxies(clips);
  }, [manifest.tracks]);
  const previewBake = useMemo(() => getTimelinePreviewBake(manifest), [manifest]);
  const useBake =
    Boolean(previewBake && bakeCoversPlayhead(previewBake, playhead));

  const frameRef = useRef<HTMLDivElement | null>(null);
  const debugEnabled = previewDebugEnabled();
  const [layerDiagnostics, setLayerDiagnostics] = useState<ClipLayerDiagnostic[]>([]);
  const mediaRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const audioOutputRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const audioPlayPendingRef = useRef<Set<string>>(new Set());
  const audioFailureReportedRef = useRef<Set<string>>(new Set());
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });

  // Presentation contract (DOM-first revamp):
  // - Presentation truth = DOM stack (videos + ClipColoringCanvas).
  // - WebCodecs = scrub assist / experimental opt-in only; ownership is forced off.
  // - Bake overlay is the only other surface that may hide the DOM stack.
  const {
    canvasRef: engineCanvasRef,
    engineOwnsPresentation,
  } = useWebcodecsEngine({
    manifest,
    playing,
    playhead,
    frameSize,
    bakeActive: useBake,
  });
  // Ownership is always false this phase; keep the binding for debug overlay.

  const total = timelineDuration(manifest);
  const ratio = aspectRatio(manifest.previewAspect);
  const [alignGuides, setAlignGuides] = useState<AlignGuide[]>([]);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const dragExtendRef = useRef<PreviewFrameExtension>(PREVIEW_FRAME_EXTENSION_NONE);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const dragPreviewLatestRef = useRef<DragPreviewState | null>(null);
  const dragGuidesLatestRef = useRef<AlignGuide[]>([]);
  const dragRafRef = useRef<number | null>(null);
  const dragCaptureElRef = useRef<HTMLElement | null>(null);
  const bodyCursorPrevRef = useRef<string>("");
  const bodyUserSelectPrevRef = useRef<string>("");
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
  const audioOutputs = useMemo(
    () => previewAudioOutputsAt(manifest.tracks, playhead),
    [manifest.tracks, playhead]
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
    // Audio-master clock: when WebAudio is available, elapsed time comes from
    // the hardware audio clock so video stays locked to what's audible.
    const audioGraph = getPreviewAudioGraph();
    void audioGraph?.resume();
    const nowSec = () =>
      audioGraph?.isRunning() ? audioGraph.now() : performance.now() / 1000;
    anchorRef.current = { wall: nowSec(), head: playheadStore.get() };
    const tick = () => {
      const a = anchorRef.current;
      if (!a) return;
      const t = a.head + (nowSec() - a.wall);
      if (total > 0 && t >= total) {
        const endT = playbackEndPlayhead(total, manifest.fps);
        playheadStore.set(endT);
        onPlayheadChange(endT);
        onEnded();
        return;
      }
      // Drive the live store (smooth 60fps for subscribers) and notify the
      // page on a throttled cadence for its playhead-dependent state.
      playheadStore.set(t);
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

  const reportAudioFailure = useCallback((output: PreviewAudioOutput, error: unknown) => {
    const key = `${output.sourceKind}:${output.clip.id}`;
    if (audioFailureReportedRef.current.has(key)) return;
    audioFailureReportedRef.current.add(key);
    console.warn(
      `Timeline preview audio failed (${output.sourceKind}, clip ${output.clip.id}, ${output.clip.srcRelPath}).`,
      error
    );
  }, []);

  const attemptAudioPlay = useCallback((
    el: HTMLAudioElement,
    output: PreviewAudioOutput
  ) => {
    const key = `${output.sourceKind}:${output.clip.id}`;
    if (audioPlayPendingRef.current.has(key)) return;
    audioPlayPendingRef.current.add(key);
    void (async () => {
      try {
        await getPreviewAudioGraph()?.resume();
        const graph = getPreviewAudioGraph();
        if (graph?.isRunning()) {
          graph.attach(output.clip.id, el);
          graph.setGain(output.clip.id, clamp(output.gain, 0, 2));
          el.volume = 1;
        } else {
          el.volume = clamp(output.gain, 0, 1);
        }
        await el.play();
        audioPlayPendingRef.current.delete(key);
        audioFailureReportedRef.current.delete(key);
      } catch (error) {
        audioPlayPendingRef.current.delete(key);
        reportAudioFailure(output, error);
      }
    })();
  }, [reportAudioFailure]);

  const syncAudioOutput = useCallback((
    el: HTMLAudioElement,
    output: PreviewAudioOutput
  ) => {
    const { clip, sourceTime, gain } = output;
    const reversed = !!clip.reversed;
    el.playbackRate = Math.min(16, Math.max(0.1, clip.speed || 1));
    // WebAudio GainNode supports gain > 1; only attach once the context is
    // running so a suspended MediaElementSource cannot mute the element.
    const graph = getPreviewAudioGraph();
    if (graph && audioSinkMode(graph.state()) === "webaudio") {
      graph.attach(clip.id, el);
      graph.setGain(clip.id, clamp(gain, 0, 2));
      el.volume = 1;
    } else {
      void graph?.resume();
      el.volume = clamp(gain, 0, 1);
    }
    const seekThreshold = reversed ? 0.05 : playing ? 0.35 : 0.05;
    if (Math.abs(el.currentTime - sourceTime) > seekThreshold) {
      try {
        el.currentTime = sourceTime;
      } catch {
        /* metadata/seek range not ready; canplay will retry */
      }
    }
    if (!playing || reversed) {
      if (!el.paused) el.pause();
    } else if (el.paused) {
      attemptAudioPlay(el, output);
    }
  }, [attemptAudioPlay, playing]);

  useEffect(() => {
    const seenVisual = new Set<string>();
    const seenAudio = new Set<string>();

    const syncVisualClip = (
      clip: TimelineClip,
      track: TimelineTrack,
      allowPlay: boolean
    ) => {
      seenVisual.add(clip.id);
      const el = mediaRefs.current.get(clip.id);
      if (!el) return;
      const wantRaw = sourceTimeAtWithTransition(clip, playhead, track);
      const holdStep = clipPreviewHoldStep(clip);
      // While playing, free-run at wall clock — do not park on holdStep seeks
      // (hold is for scrub / canvas sample only).
      const want =
        !playing && holdStep > 1
          ? heldSourceTimeSec(clip, wantRaw, Math.max(1, manifest.fps), holdStep)
          : wantRaw;
      const reversed = !!clip.reversed;
      el.playbackRate = Math.min(16, Math.max(0.1, clip.speed || 1));
      const seekThreshold =
        !playing && holdStep > 1
          ? 0.001
          : reversed
            ? 0.05
            : playing
              ? 0.35
              : 0.05;
      // Hold-step must not pause free-run during play.
      if (!playing || reversed || !allowPlay) {
        if (!el.paused) el.pause();
      }
      if (Math.abs(el.currentTime - want) > seekThreshold) {
        try {
          el.currentTime = want;
        } catch {
          /* not seekable yet */
        }
      }
      if (playing && !reversed && allowPlay && el.paused) {
        void el.play().catch(() => {});
      }
    };

    // Unique active videos (skip preload-only dups for budget accounting).
    const activeVideoEntries: Array<{ clip: TimelineClip; track: TimelineTrack }> =
      [];
    const seenClipIds = new Set<string>();
    for (const track of videoTracks) {
      for (const layer of activeLayersAt(track, playhead)) {
        if (layer.clip.type !== "video") continue;
        if (!(layer.opacity > 0.01 || layer.preload)) continue;
        if (seenClipIds.has(layer.clip.id)) continue;
        seenClipIds.add(layer.clip.id);
        activeVideoEntries.push({ clip: layer.clip, track });
      }
    }
    const frameIdx = playbackClock.frameAtSec(playhead);
    const playSlots = assignPlaySlots(
      activeVideoEntries.map((e) => e.clip.id),
      MAX_ACTIVE_VIDEO_DECODES,
      playBudgetRotationEpoch(frameIdx)
    );
    for (const { clip, track } of activeVideoEntries) {
      syncVisualClip(clip, track, playSlots.has(clip.id));
    }

    if (debugEnabled) {
      setLayerDiagnostics(
        activeVideoEntries.map(({ clip, track }) => {
          const el = mediaRefs.current.get(clip.id);
          return {
            clipId: clip.id,
            playSlot: playSlots.has(clip.id),
            readyState: el?.readyState ?? -1,
            paused: el?.paused ?? true,
            currentTime: el?.currentTime ?? -1,
            wantTime: sourceTimeAtWithTransition(clip, playhead, track),
          };
        })
      );
    }

    for (const output of audioOutputs) {
      seenAudio.add(output.clip.id);
      const el = audioOutputRefs.current.get(output.clip.id);
      if (el) syncAudioOutput(el, output);
    }

    for (const [id, el] of mediaRefs.current) {
      if (!seenVisual.has(id) && !el.paused) el.pause();
    }
    for (const [id, el] of audioOutputRefs.current) {
      if (!seenAudio.has(id) && !el.paused) el.pause();
    }
  }, [
    playhead,
    playing,
    videoTracks,
    audioOutputs,
    syncAudioOutput,
    manifest.fps,
    playbackClock,
    debugEnabled,
  ]);

  useEffect(() => {
    setTextStyleModal(null);
  }, [selectedClipId]);

  const dragRef = useRef<
    | {
        mode: "move" | "scale";
        clipId: string;
        startX: number;
        startY: number;
        startFrameLeft: number;
        startFrameTop: number;
        startExtend: PreviewFrameExtension;
        orig: ClipTransform;
        w: number;
        h: number;
        pointerId: number;
        startRect?: ClipRect;
      }
    | null
  >(null);

  const pendingDragRef = useRef<{
    clip: TimelineClip;
    mode: "move" | "scale";
    startX: number;
    startY: number;
    startFrameLeft: number;
    startFrameTop: number;
    pointerId: number;
    target: HTMLElement;
    wasSelected: boolean;
  } | null>(null);

  const DRAG_THRESHOLD_PX = 8;

  function clipTransform(clip: TimelineClip, head: number): ClipTransform {
    if (dragPreview && dragPreview.clipId === clip.id) return dragPreview.to;
    return clipTransformAtPlayhead(clip, head);
  }

  function beginGestureChrome(target: HTMLElement | null, pointerId: number) {
    dragCaptureElRef.current = target;
    try {
      target?.setPointerCapture?.(pointerId);
    } catch {
      /* capture optional */
    }
    bodyCursorPrevRef.current = document.body.style.cursor;
    bodyUserSelectPrevRef.current = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }

  function endGestureChrome() {
    const el = dragCaptureElRef.current;
    const d = dragRef.current;
    if (el && d) {
      try {
        el.releasePointerCapture?.(d.pointerId);
      } catch {
        /* already released */
      }
    }
    dragCaptureElRef.current = null;
    document.body.style.cursor = bodyCursorPrevRef.current;
    document.body.style.userSelect = bodyUserSelectPrevRef.current;
  }

  function scheduleDragPaint() {
    if (dragRafRef.current != null) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null;
      const latest = dragPreviewLatestRef.current;
      if (latest) setDragPreview(latest);
      setAlignGuides(dragGuidesLatestRef.current);
    });
  }

  function beginMoveDragExtension(startRect: ClipRect | undefined, frameW: number, frameH: number) {
    const startExtend =
      startRect && frameW > 0 && frameH > 0
        ? previewFrameExtensionForRects([startRect], frameW, frameH)
        : PREVIEW_FRAME_EXTENSION_NONE;
    dragExtendRef.current = PREVIEW_FRAME_EXTENSION_NONE;
    return startExtend;
  }

  function clearDragPreview() {
    dragPreviewLatestRef.current = null;
    dragGuidesLatestRef.current = [];
    if (dragRafRef.current != null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    setDragPreview(null);
    setAlignGuides([]);
    dragExtendRef.current = PREVIEW_FRAME_EXTENSION_NONE;
  }

  function liveFrameSize(): { w: number; h: number } {
    const el = frameRef.current;
    return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 };
  }

  function liveFrameOrigin(): { left: number; top: number } {
    const rect = frameRef.current?.getBoundingClientRect();
    return { left: rect?.left ?? 0, top: rect?.top ?? 0 };
  }

  function startDragFromPending(
    p: NonNullable<typeof pendingDragRef.current>,
    clientX: number,
    clientY: number,
    pointerId: number
  ) {
    if (!editable) return;
    const { w: frameW, h: frameH } = liveFrameSize();
    if (frameW < 1 || frameH < 1) return;
    onTransformStart?.();
    const orig = clipTransformAtPlayhead(p.clip, playhead);
    const startRect =
      p.mode === "move" ? clipImageRect(p.clip, orig, frameW, frameH) : undefined;
    const startExtend = beginMoveDragExtension(startRect, frameW, frameH);
    dragRef.current = {
      mode: p.mode,
      clipId: p.clip.id,
      startX: p.startX,
      startY: p.startY,
      startFrameLeft: p.startFrameLeft,
      startFrameTop: p.startFrameTop,
      startExtend,
      orig,
      w: frameW,
      h: frameH,
      pointerId,
      startRect,
    };
    beginGestureChrome(p.target, pointerId);
    setDraggingClipId(p.clip.id);
    pendingDragRef.current = null;
    applyDragMove(clientX, clientY);
  }

  function beginDrag(
    e: React.PointerEvent,
    clip: TimelineClip,
    mode: "move" | "scale"
  ) {
    if (e.button !== 0) return;
    if (geometryEditClipId === clip.id) return;
    if (textEditClipId === clip.id) return;
    e.preventDefault();
    e.stopPropagation();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    onSelectClip(clip.id, additive);
    if (!editable) return;
    const { w: frameW, h: frameH } = liveFrameSize();
    if (frameW < 1 || frameH < 1) return;
    onTransformStart?.();
    const orig = clipTransformAtPlayhead(clip, playhead);
    const frameOrigin = liveFrameOrigin();
    const startRect =
      mode === "move" ? clipImageRect(clip, orig, frameW, frameH) : undefined;
    const startExtend = beginMoveDragExtension(startRect, frameW, frameH);
    dragRef.current = {
      mode,
      clipId: clip.id,
      startX: e.clientX,
      startY: e.clientY,
      startFrameLeft: frameOrigin.left,
      startFrameTop: frameOrigin.top,
      startExtend,
      orig,
      w: frameW,
      h: frameH,
      pointerId: e.pointerId,
      startRect,
    };
    beginGestureChrome(e.currentTarget as HTMLElement, e.pointerId);
    setDraggingClipId(clip.id);
    attachDragListeners();
  }

  function beginMovePointerDown(
    e: React.PointerEvent,
    clip: TimelineClip,
    mode: "move" | "scale"
  ) {
    if (e.button !== 0) return;
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
    const frameOrigin = liveFrameOrigin();
    pendingDragRef.current = {
      clip,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startFrameLeft: frameOrigin.left,
      startFrameTop: frameOrigin.top,
      pointerId: e.pointerId,
      target: e.currentTarget as HTMLElement,
      wasSelected: clip.id === selectedClipId,
    };
    attachDragListeners();
  }

  function applyDragMove(clientX: number, clientY: number) {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === "move") {
      if (!d.startRect || d.w < 1 || d.h < 1) return;
      const frameOrigin = liveFrameOrigin();
      const { dx, dy } = pointerClientDeltaInFrameSpace({
        clientX,
        clientY,
        startClientX: d.startX,
        startClientY: d.startY,
        frameLeft: frameOrigin.left,
        frameTop: frameOrigin.top,
        startFrameLeft: d.startFrameLeft,
        startFrameTop: d.startFrameTop,
      });
      const { to, guides, extend } = previewMoveTransformFromPointerDelta({
        orig: d.orig,
        startRect: d.startRect,
        startClientX: d.startX,
        startClientY: d.startY,
        clientX: d.startX + dx,
        clientY: d.startY + dy,
        frameW: d.w,
        frameH: d.h,
        extend: dragExtendRef.current,
      });
      dragExtendRef.current = extend;
      dragPreviewLatestRef.current = {
        clipId: d.clipId,
        mode: "move",
        to,
        extend,
      };
      dragGuidesLatestRef.current = guides;
      scheduleDragPaint();
    } else {
      if (d.w < 1 || d.h < 1) return;
      const clip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === d.clipId);
      const tentative = clamp(d.orig.scale + ((clientX - d.startX) / d.w) * 2, 0.1, 6);
      let next: ClipTransform = { ...d.orig, scale: tentative };
      let guides: AlignGuide[] = [];
      if (clip) {
        const snapped = snapClipScaleToFrame(clip, next, d.w, d.h);
        next = { ...d.orig, scale: snapped.scale };
        guides = snapped.guides;
      }
      dragPreviewLatestRef.current = {
        clipId: d.clipId,
        mode: "scale",
        to: next,
        extend: PREVIEW_FRAME_EXTENSION_NONE,
      };
      dragGuidesLatestRef.current = guides;
      scheduleDragPaint();
    }
  }

  function endActiveDrag() {
    const d = dragRef.current;
    const hadDrag = !!d;
    const preview = dragPreviewLatestRef.current;
    endGestureChrome();
    if (hadDrag && preview && preview.clipId === d!.clipId) {
      onClipTransformChange(d!.clipId, d!.orig, preview.to, d!.mode);
      if (d!.mode === "move" && d!.w > 0 && d!.h > 0) {
        const clip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === d!.clipId);
        if (clip) {
          const rect = clipImageRect(clip, preview.to, d!.w, d!.h);
          const spills =
            rect.top < 0 ||
            rect.left < 0 ||
            rect.left + rect.width > d!.w ||
            rect.top + rect.height > d!.h;
          onFrameExtensionChange?.(
            spills
              ? previewFrameExtensionForRects([rect], d!.w, d!.h)
              : PREVIEW_FRAME_EXTENSION_NONE
          );
        } else {
          onFrameExtensionChange?.(PREVIEW_FRAME_EXTENSION_NONE);
        }
      } else {
        onFrameExtensionChange?.(PREVIEW_FRAME_EXTENSION_NONE);
      }
    }
    dragRef.current = null;
    clearDragPreview();
    setDraggingClipId(null);
  }

  const dragMoveHandlerRef = useRef<(e: PointerEvent) => void>(() => {});
  const dragEndHandlerRef = useRef<(e: PointerEvent) => void>(() => {});

  dragMoveHandlerRef.current = (e: PointerEvent) => {
    const p = pendingDragRef.current;
    if (p && !dragRef.current) {
      const dx = e.clientX - p.startX;
      const dy = e.clientY - p.startY;
      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        startDragFromPending(p, e.clientX, e.clientY, e.pointerId);
      }
    }
    if (dragRef.current) {
      if (e.cancelable) e.preventDefault();
      applyDragMove(e.clientX, e.clientY);
    }
  };

  dragEndHandlerRef.current = (e: PointerEvent) => {
    void e;
    const p = pendingDragRef.current;
    if (
      p &&
      !dragRef.current &&
      p.mode === "move" &&
      p.clip.type === "text" &&
      p.wasSelected
    ) {
      onRequestTextEdit?.(p.clip.id);
    }
    pendingDragRef.current = null;
    endActiveDrag();
    detachDragListeners();
  };

  const windowMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const windowEndRef = useRef<((e: PointerEvent) => void) | null>(null);

  function attachDragListeners() {
    detachDragListeners();
    const onMove = (e: PointerEvent) => dragMoveHandlerRef.current(e);
    const onEnd = (e: PointerEvent) => dragEndHandlerRef.current(e);
    windowMoveRef.current = onMove;
    windowEndRef.current = onEnd;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  function detachDragListeners() {
    if (windowMoveRef.current) {
      window.removeEventListener("pointermove", windowMoveRef.current);
      windowMoveRef.current = null;
    }
    if (windowEndRef.current) {
      window.removeEventListener("pointerup", windowEndRef.current);
      window.removeEventListener("pointercancel", windowEndRef.current);
      windowEndRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      detachDragListeners();
      if (dragRafRef.current != null) cancelAnimationFrame(dragRafRef.current);
      document.body.style.cursor = bodyCursorPrevRef.current;
      document.body.style.userSelect = bodyUserSelectPrevRef.current;
    };
  }, []);

  function layerVisible(layer: ActiveLayer): boolean {
    if (layer.preload) return true;
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
      const layers = activeLayersAt(track, playhead).filter(
        (l) => layerVisible(l) && !l.preload
      );
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

  const previewEditActive = !!(trajectoryClipId || geometryEditClipId || textEditClipId);

  const trajectoryExtension = useMemo(() => {
    if (!trajectoryClipId || frameSize.w < 1 || frameSize.h < 1) {
      return PREVIEW_FRAME_EXTENSION_NONE;
    }
    const trajClip = videoTracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === trajectoryClipId);
    if (!trajClip?.trajectory) return PREVIEW_FRAME_EXTENSION_NONE;
    const tf =
      dragPreview && dragPreview.clipId === trajClip.id
        ? dragPreview.to
        : clipTransformAtPlayhead(trajClip, playhead);
    const clipBounds = clipImageRect(trajClip, tf, frameSize.w, frameSize.h);
    return computeTrajectoryEditFrameExtension(
      trajClip.trajectory.waypoints,
      frameSize.w,
      frameSize.h,
      undefined,
      clipBounds
    );
  }, [
    trajectoryClipId,
    videoTracks,
    frameSize.w,
    frameSize.h,
    playhead,
    dragPreview,
  ]);

  const isMoveDragging = !!dragPreview && dragPreview.mode === "move";

  // Full spill during drag from live preview (overlays never reflow the frame).
  const dragFullExtension = isMoveDragging
    ? dragPreview.extend
    : PREVIEW_FRAME_EXTENSION_NONE;

  const baseFrameExtension = isMoveDragging
    ? dragFullExtension
    : frameExtension;

  // Traj edit pad follows this clip's waypoints/bounds only — never merge leftover
  // sticky frameExtension from earlier drag/nudge of other (or larger) clips.
  const displayExtension = trajectoryClipId
    ? mergePreviewFrameExtension(
        isMoveDragging ? dragFullExtension : PREVIEW_FRAME_EXTENSION_NONE,
        trajectoryExtension
      )
    : baseFrameExtension;

  const effectiveFrameExtension = baseFrameExtension;

  const hasExtension =
    effectiveFrameExtension.top > 0 ||
    effectiveFrameExtension.right > 0 ||
    effectiveFrameExtension.bottom > 0 ||
    effectiveFrameExtension.left > 0;
  const showDragOverflow = isMoveDragging && hasExtension;

  const trajectoryLayerExtend = trajectoryClipId
    ? displayExtension
    : PREVIEW_FRAME_EXTENSION_NONE;

  const trajectoryExtendedLayerInset = {
    top: -trajectoryLayerExtend.top,
    left: -trajectoryLayerExtend.left,
    right: -trajectoryLayerExtend.right,
    bottom: -trajectoryLayerExtend.bottom,
  };

  // Traj edit: keep image spill visible with its center waypoints (same expand).
  const showTrajOverflow = !!trajectoryClipId && !showDragOverflow;
  const hasStoredExtension =
    frameExtension.top > 0 ||
    frameExtension.right > 0 ||
    frameExtension.bottom > 0 ||
    frameExtension.left > 0;
  const showStoredOverflow =
    !showDragOverflow && !showTrajOverflow && hasStoredExtension && !!selectedClipId;

  const overflowClipId = showDragOverflow
    ? draggingClipId
    : showTrajOverflow
      ? trajectoryClipId
      : showStoredOverflow
        ? selectedClipId
        : null;
  const overflowExtend = showDragOverflow
    ? effectiveFrameExtension
    : showTrajOverflow
      ? trajectoryLayerExtend
      : frameExtension;

  function renderPositionedMediaLayer(
    clip: TimelineClip,
    layer: ActiveLayer,
    trackZ: number,
    track: TimelineTrack,
    rect: ClipRect,
    opacityMultiplier: number,
    keyPrefix: string,
    layerClipPath?: string
  ) {
    const tf = clipTransform(clip, playhead);
    const rot = tf.rotation ?? 0;
    const op = (tf.opacity ?? 1) * layer.opacity * opacityMultiplier;
    const slideX = layer.slideOffsetX ?? 0;
    const slideY = layer.slideOffsetY ?? 0;
    const transforms = [
      rot !== 0 ? `rotate(${rot}deg)` : "",
      slideX !== 0 || slideY !== 0
        ? `translate(${slideX * rect.width}px, ${slideY * rect.height}px)`
        : "",
    ].filter(Boolean);
    const clipPath = layerClipPath ?? layer.clipPath;
    return (
      <div
        key={`${keyPrefix}-${clip.id}`}
        style={{
          position: "absolute",
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          zIndex: trackZ,
          opacity: op,
          // Opacity 0 is enough for warm-up; visibility:hidden can defer video decode.
          pointerEvents: layer.preload ? "none" : undefined,
          clipPath,
          overflow: clipPath ? "hidden" : undefined,
          transform: transforms.length > 0 ? transforms.join(" ") : undefined,
          transformOrigin: "center center",
        }}
      >
        {renderClipContent(
          clip,
          1,
          (() => {
            const raw = sourceTimeAtWithTransition(clip, playhead, track);
            if (clip.type !== "video") return raw;
            const hold = clipPreviewHoldStep(clip);
            return hold > 1
              ? heldSourceTimeSec(clip, raw, Math.max(1, manifest.fps), hold)
              : raw;
          })(),
          track
        )}
      </div>
    );
  }

  function renderClipHitTarget(
    clip: TimelineClip,
    trackZ: number,
    rect: ClipRect,
    keyPrefix: string
  ) {
    const selected = clip.id === selectedClipId;
    const isText = clip.type === "text";
    const isGeometry = clip.type === "geometry";
    const isDragging = draggingClipId === clip.id;
    const hitHandlers = isGeometry
      ? {
          onClick: (e: React.MouseEvent) => {
            if (!editable) return;
            e.stopPropagation();
            onRequestGeometryEdit?.(clip.id);
          },
        }
      : {
          onPointerDown: (e: React.PointerEvent) => beginMovePointerDown(e, clip, "move"),
        };
    return (
      <div
        key={`${keyPrefix}-${clip.id}`}
        data-preview-clip-hit
        {...hitHandlers}
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
          zIndex: previewClipHitZIndex({ trackZ, selected }),
          cursor:
            editable
              ? isText
                ? "default"
                : isGeometry
                  ? "pointer"
                  : isDragging
                    ? "grabbing"
                    : "grab"
              : "default",
          pointerEvents: "auto",
          touchAction: "none",
        }}
      />
    );
  }

  function clipHasHitDimensions(clip: TimelineClip): boolean {
    if (clip.type === "geometry" || clip.type === "text") return true;
    return (clip.naturalW ?? 0) > 0 && (clip.naturalH ?? 0) > 0;
  }

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
            skipPixelColoring={qualityPolicy.skipPixelColoring}
            engineOwnsPresentation={engineOwnsPresentation}
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
      const src = assetUrlFromRelPath(previewSrcRelPath(clip));
      if (clipNeedsColoringCanvas(clip)) {
        return (
          <ClipColoringCanvas
            clip={clip}
            timelineKey={timelineKey}
            sourceTimeSec={sourceTimeSec}
            playing={playing}
            previewFps={manifest.fps}
            skipPixelColoring={qualityPolicy.skipPixelColoring}
            engineOwnsPresentation={engineOwnsPresentation}
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
          clipTransform(selectedClip, playhead),
          frameSize.w,
          frameSize.h
        )
      : null;

  const geometryEditRect = useMemo(() => {
    if (!geometryEditClipId || frameSize.w < 1) return null;
    const gClip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === geometryEditClipId);
    if (!gClip?.geometry) return null;
    const tf = clipTransform(gClip, playhead);
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
    const tf = clipTransform(tClip, playhead);
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
    if (!textEditClipId && !geometryEditClipId && !trajectoryClipId) return;

    const target = e.target as HTMLElement;
    if (target.closest("[data-text-style-bar]")) return;
    if (target.closest("[data-geometry-style-bar]")) return;
    if (target.closest("[data-geometry-picker-modal]")) return;
    if (target.closest("[data-geometry-editor]")) return;
    if (target.closest("[data-trajectory-editor]")) return;
    if (target.closest("[data-trajectory-toolbar]")) return;
    if (target.closest("[data-preview-clip-hit]")) return;
    if (target.closest("[data-preview-scale-handle]")) return;
    if (target.closest("[data-preview-selection-chrome]")) return;
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
    if (trajectoryClipId) {
      const trajLayer = interactionLayers.find((l) => l.clip.id === trajectoryClipId);
      if (trajLayer) {
        const tf = clipTransform(trajLayer.clip, playhead);
        const rect = clipImageRect(trajLayer.clip, tf, frameSize.w, frameSize.h);
        if (!pointInRect(x, y, rect)) shouldExit = true;
      } else {
        shouldExit = true;
      }
    }

    if (shouldExit) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      if (trajectoryClipId) onExitTrajectoryEdit?.();
      else onExitClipEditModes();
    }
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        width: "100%",
        // Traj edit: grow layout so the off-frame image + its center waypoints stay in page flow.
        paddingTop: trajectoryClipId ? trajectoryLayerExtend.top : 0,
        paddingLeft: trajectoryClipId ? trajectoryLayerExtend.left : 0,
        paddingRight: trajectoryClipId ? trajectoryLayerExtend.right : 0,
        paddingBottom: trajectoryClipId ? trajectoryLayerExtend.bottom : 0,
        boxSizing: "border-box",
      }}
    >
      <div
        ref={frameRef}
        data-timeline-preview-frame
        onPointerDownCapture={handleFramePointerDownCapture}
        onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("[data-preview-clip-hit]")) return;
          if (t.closest("[data-preview-scale-handle]")) return;
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
        {missingProxies ? (
          <div
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              zIndex: PREVIEW_SELECTION_CHROME_Z + 2,
              fontSize: 11,
              padding: "3px 8px",
              background: "rgba(0,0,0,0.65)",
              color: "#fc6",
              pointerEvents: "none",
            }}
          >
            Building preview proxies…
          </div>
        ) : null}
        {debugEnabled ? (
          <div
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              zIndex: PREVIEW_SELECTION_CHROME_Z + 3,
              fontSize: 10,
              lineHeight: 1.5,
              fontFamily: "monospace",
              padding: "4px 8px",
              background: "rgba(0,0,0,0.75)",
              color: "#9f9",
              pointerEvents: "none",
              maxWidth: 340,
            }}
          >
            <div style={{ color: "#fff" }}>
              engine {engineOwnsPresentation ? "OWNS" : "off"} · promo{" "}
              {engineTelemetry.promotions} · demo {engineTelemetry.demotions} ·
              miss {engineTelemetry.missedFrames}
            </div>
            {layerDiagnostics.map((d) => {
              const age = clipPaintAgeMs(d.clipId);
              const drift = Math.abs(d.currentTime - d.wantTime);
              const stale = age != null && age > 500;
              return (
                <div
                  key={d.clipId}
                  style={{ color: stale ? "#f96" : undefined }}
                >
                  {d.clipId.slice(0, 8)} {d.playSlot ? "PLAY" : "hold"} rs
                  {d.readyState} {d.paused ? "pause" : "run"} drift
                  {drift.toFixed(2)}
                  {age != null ? ` paint ${(age / 1000).toFixed(1)}s` : ""}
                </div>
              );
            })}
          </div>
        ) : null}
        {useBake && previewBake ? (
          <video
            key={previewBake.srcRelPath}
            src={assetUrlFromRelPath(previewBake.srcRelPath)}
            muted
            playsInline
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              zIndex: PREVIEW_SELECTION_CHROME_Z + 1,
              pointerEvents: "none",
            }}
            ref={(el) => {
              if (!el) return;
              const local = Math.max(0, playhead - previewBake.inPointSec);
              if (Math.abs(el.currentTime - local) > 0.08) {
                try {
                  el.currentTime = local;
                } catch {
                  /* ignore */
                }
              }
              if (playing && el.paused) void el.play().catch(() => {});
              if (!playing && !el.paused) el.pause();
            }}
          />
        ) : null}
        <canvas
          ref={engineCanvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            zIndex: PREVIEW_SELECTION_CHROME_Z + 1,
            pointerEvents: "none",
            background: "#000",
            // DOM-first: engine canvas stays hidden; never owns presentation.
            visibility: "hidden",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            pointerEvents: "none",
            // Bake is the only surface that may hide the DOM stack.
            visibility: useBake ? "hidden" : "visible",
          }}
        >
          {videoRenderLayers.map(({ clip, layer, trackZ, track }) => {
            const tf = clipTransform(clip, playhead);
            const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
            return renderPositionedMediaLayer(
              clip,
              layer,
              trackZ,
              track,
              rect,
              1,
              "base"
            );
          })}
        </div>

        {overflowClipId
          ? (() => {
              const overflowEntry = videoRenderLayers.find(
                ({ clip }) => clip.id === overflowClipId
              );
              if (!overflowEntry) return null;
              const { clip, layer, trackZ, track } = overflowEntry;
              const tf = clipTransform(clip, playhead);
              const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
              const layerRect = clipRectInExtendedLayer(rect, overflowExtend);
              const overflowInset = {
                top: -overflowExtend.top,
                left: -overflowExtend.left,
                right: -overflowExtend.right,
                bottom: -overflowExtend.bottom,
              };
              return (
                <div
                  style={{
                    position: "absolute",
                    ...overflowInset,
                    overflow: "hidden",
                    pointerEvents: "none",
                    clipPath: clipPathOutsideInnerFrame(
                      frameSize.w,
                      frameSize.h,
                      overflowExtend
                    ),
                  }}
                >
                  {renderPositionedMediaLayer(
                    clip,
                    layer,
                    trackZ,
                    track,
                    layerRect,
                    PREVIEW_OUTSIDE_FRAME_OPACITY,
                    "overflow"
                  )}
                </div>
              );
            })()
          : null}

        {!previewEditActive ? (
          <>
            <div
              style={{
                position: "absolute",
                inset: 0,
                overflow: "hidden",
                zIndex: PREVIEW_HIT_Z,
                pointerEvents: "none",
              }}
            >
              {interactionLayers.map(({ clip, trackZ }) => {
                if (!clipHasHitDimensions(clip)) return null;
                if (draggingClipId && clip.id === draggingClipId) return null;
                if (showStoredOverflow && clip.id === selectedClipId) return null;
                const tf = clipTransform(clip, playhead);
                const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
                return renderClipHitTarget(clip, trackZ, rect, "hit");
              })}
            </div>
            {draggingClipId || (showStoredOverflow && selectedClipId) ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  overflow: "visible",
                  zIndex: PREVIEW_HIT_Z,
                  pointerEvents: "none",
                }}
              >
                {interactionLayers.map(({ clip, trackZ }) => {
                  if (!clipHasHitDimensions(clip)) return null;
                  const stableId = draggingClipId ?? selectedClipId;
                  if (clip.id !== stableId) return null;
                  const tf = clipTransform(clip, playhead);
                  const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
                  return renderClipHitTarget(clip, trackZ, rect, "hit-out");
                })}
              </div>
            ) : null}
            {editable ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  overflow: "visible",
                  zIndex: PREVIEW_HANDLE_Z,
                  pointerEvents: "none",
                }}
              >
                {interactionLayers.map(({ clip, trackZ }) => {
                  if (clip.id !== selectedClipId) return null;
                  if (!clipHasHitDimensions(clip)) return null;
                  const isText = clip.type === "text";
                  if (clip.type === "geometry") return null;
                  const tf = clipTransform(clip, playhead);
                  const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
                  return (
                    <div
                      key={`scale-${clip.id}`}
                      data-preview-scale-handle
                      onPointerDown={(e) =>
                        isText
                          ? beginMovePointerDown(e, clip, "scale")
                          : beginDrag(e, clip, "scale")
                      }
                      style={{
                        position: "absolute",
                        left: rect.left + rect.width - 7,
                        top: rect.top + rect.height - 7,
                        width: 14,
                        height: 14,
                        zIndex: trackZ,
                        background: "#0b0b0b",
                        border: "1px solid rgba(255,255,255,0.9)",
                        cursor: "nwse-resize",
                        pointerEvents: "auto",
                      }}
                    />
                  );
                })}
              </div>
            ) : null}
          </>
        ) : null}

        {selectedClipId &&
          editable &&
          !suppressSelectionChrome &&
          geometryEditClipId !== selectedClipId &&
          trajectoryClipId !== selectedClipId &&
          textEditClipId !== selectedClipId &&
          (() => {
            const layer = interactionLayers.find((l) => l.clip.id === selectedClipId);
            if (!layer) return null;
            const { clip } = layer;
            const isText = clip.type === "text";
            const tf = clipTransform(clip, playhead);
            const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
            return (
              <div
                key={`selection-chrome-${clip.id}`}
                data-preview-selection-chrome
                style={{
                  position: "absolute",
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  zIndex: PREVIEW_SELECTION_CHROME_Z,
                  pointerEvents: "none",
                  outline: isText
                    ? "none"
                    : editable
                      ? "2px dashed rgba(255,255,255,0.85)"
                      : "2px solid rgba(255,255,255,0.55)",
                  outlineOffset: 2,
                }}
              />
            );
          })()}

        {textEditClipId &&
          editable &&
          (() => {
            const editClip = videoTracks
              .flatMap((t) => t.clips)
              .find((c) => c.id === textEditClipId && c.type === "text");
            if (!editClip) return null;
            const layer = interactionLayers.find((l) => l.clip.id === editClip.id);
            const trackZ = layer?.trackZ ?? 1;
            const tf = clipTransform(editClip, playhead);
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
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 40 }}>
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

        {trajectoryClipId && editable && !playing
          ? (() => {
              const layer = interactionLayers.find((l) => l.clip.id === trajectoryClipId);
              if (!layer || !clipHasHitDimensions(layer.clip)) return null;
              const { clip } = layer;
              if (draggingClipId && clip.id === draggingClipId) return null;
              const tf = clipTransform(clip, playhead);
              const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
              return (
                <div
                  key={`traj-clip-hit-${clip.id}`}
                  data-preview-clip-hit
                  onPointerDown={(e) => beginMovePointerDown(e, clip, "move")}
                  style={{
                    position: "absolute",
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    zIndex: PREVIEW_HIT_Z,
                    pointerEvents: "auto",
                    touchAction: "none",
                    cursor: "move",
                  }}
                />
              );
            })()
          : null}

        {trajectoryClipId &&
        editable &&
        !playing &&
        draggingClipId === trajectoryClipId
          ? (() => {
              const layer = interactionLayers.find((l) => l.clip.id === draggingClipId);
              if (!layer || !clipHasHitDimensions(layer.clip)) return null;
              const { clip, trackZ } = layer;
              const tf = clipTransform(clip, playhead);
              const rect = clipImageRect(clip, tf, frameSize.w, frameSize.h);
              return (
                <div
                  key={`traj-clip-hit-drag-${clip.id}`}
                  style={{
                    position: "absolute",
                    inset: 0,
                    overflow: "visible",
                    zIndex: PREVIEW_HIT_Z,
                    pointerEvents: "none",
                  }}
                >
                  {renderClipHitTarget(clip, trackZ, rect, "traj-hit-drag")}
                </div>
              );
            })()
          : null}

        {trajectoryClipId && (() => {
          const trajClip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === trajectoryClipId);
          if (!trajClip || !trajClip.trajectory) return null;
          const tf = clipTransform(trajClip, playhead);
          const clipBoundsAtPlayhead =
            frameSize.w > 0 && frameSize.h > 0
              ? clipImageRect(trajClip, tf, frameSize.w, frameSize.h)
              : null;
          const ext = trajectoryLayerExtend;
          return (
            <div
              style={{
                position: "absolute",
                ...trajectoryExtendedLayerInset,
                overflow: "visible",
                zIndex: PREVIEW_EDIT_Z,
                pointerEvents: "none",
              }}
            >
              <TrajectoryEditor
                key={trajClip.id}
                clip={trajClip}
                frameW={frameSize.w}
                frameH={frameSize.h}
                extend={ext}
                clipBoundsAtPlayhead={clipBoundsAtPlayhead}
                playing={playing}
                onWaypointsChange={(wps) => onWaypointChange?.(trajClip.id, wps)}
                onMotionChange={(motion, motionAmount) =>
                  onMotionChange?.(trajClip.id, motion, motionAmount)
                }
                onPlayheadSync={onPlayheadChange}
                onExit={onExitTrajectoryEdit}
                onWaypointPatchCommit={onWaypointPatchCommit}
                onDeleteTrajectory={() => onDeleteTrajectory?.(trajClip.id)}
              />
            </div>
          );
        })()}

        {geometryEditClipId && (() => {
          const gClip = videoTracks.flatMap((t) => t.clips).find((c) => c.id === geometryEditClipId);
          if (!gClip || !gClip.geometry) return null;
          const tf = clipTransform(gClip, playhead);
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

        {audioOutputs.map((output) => {
          const { clip } = output;
          return (
            <audio
              key={`audio-output-${clip.id}`}
              preload="auto"
              crossOrigin="anonymous"
              ref={(el) => {
                if (el) {
                  audioOutputRefs.current.set(clip.id, el);
                  // Attach only once AudioContext is running (see syncAudioOutput).
                } else {
                  audioOutputRefs.current.delete(clip.id);
                  getPreviewAudioGraph()?.detach(clip.id);
                }
              }}
              src={assetUrlFromRelPath(clip.srcRelPath)}
              onLoadedMetadata={(e) => syncAudioOutput(e.currentTarget, output)}
              onCanPlay={(e) => syncAudioOutput(e.currentTarget, output)}
              onError={(e) =>
                reportAudioFailure(
                  output,
                  e.currentTarget.error ?? new Error("Unknown media error")
                )
              }
              style={{ display: "none" }}
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
