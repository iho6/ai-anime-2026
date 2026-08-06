"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragMoveEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useParams, useRouter } from "next/navigation";
import {
  apiTimelineEnsureProxies,
  apiTimelineGet,
  apiTimelineImportAudio,
  apiTimelineImportFiles,
  apiTimelineNormalizeAudio,
  apiTimelineImportImage,
  apiTimelineDuplicateFrameAsset,
  apiTimelinePut,
  apiTimelineSavedShapes,
  apiSaveTimelineShape,
  apiSequenceGet,
  AudioReference,
  runReferenceAudioGenerateWsJob,
  assetUrlFromRelPath,
  previewSrcRelPath,
  runTimelineAiEditWsJob,
  runTimelineExportMp4WsJob,
  runTimelineFlfWsJob,
  runTimelineI2vWsJob,
  runTimelineVideoFramesExtractWsJob,
  runTimelineVideoFramesEncodeWsJob,
  runTimelineStripI2vWsJob,
  runTimelineStripFlfWsJob,
  runTimelineImportSequenceWsJob,
  runTimelineVideoRemoveBgWsJob,
  runTimelineVideoRemoveBgRmbgWsJob,
  runTimelineVideoRemoveBgAnimeSegWsJob,
  runTimelineSegmentPreviewWsJob,
  runTimelineSegmentWsJob,
  runTimelineT2iWsJob,
  type TimelineAsset,
  type SavedGeometryShape,
  type Sam3Point,
  type Sam3SegmentOptions,
  type RvmBgOptions,
  type RmbgBgOptions,
  type AnimeSegBgOptions,
  type RemoveBgImageRunOptions,
  runShotCreateWsJob,
  runShotMakeAngleWsJob,
  runShotRemoveBgWsJob,
  apiTimelineHubRename,
  assetDownloadUrlFromRelPath,
  GeometryTemplate,
  TimelineClip,
  TimelineGeometry,
  TimelineManifest,
  TimelineText,
  TimelineTransitionOut,
  FrameSequencePayload,
  SequenceGalleryItem,
  TimelineFrameEdit,
  ShotLayerMeta,
  TrajectoryMotionId,
} from "../../../lib/api";
import { AiEditModal } from "../../../components/AiEditModal";
import { RemoveBgVideoModal } from "../../../components/RemoveBgVideoModal";
import { RemoveBgImageModal } from "../../../components/removeBg/RemoveBgImageModal";
import { SegmentModal } from "../../../components/SegmentModal";
import { CameraAngleModal } from "../../../components/CameraAngleModal";
import {
  DesktopContextMenu,
  ContextMenuItem,
} from "../../../components/DesktopContextMenu";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../../components/HfTokenSettingsButton";
import type { SharedLogStreamHandle } from "../../../components/SharedLogStream";
import { ConnectedJobRunModal } from "../../../components/ConnectedJobRunModal";
import { useJobRunSession } from "../../../hooks/useJobRunSession";
import { useAppError } from "../../../components/ErrorProvider";
import { TimelinePreviewPlayer } from "../../../components/timeline/TimelinePreviewPlayer";
import { getPreviewAudioGraph } from "../../../components/timeline/playback/previewAudioGraph";
import { GeometryShapePicker } from "../../../components/timeline/GeometryShapePicker";
import {
  cloneTimelineGeometry,
  createGeometryData,
  geometryIsCustomized,
} from "../../../components/timeline/geometryTemplates";
import { TimelineTracks, AddTrackStrip, type TimelineTracksHandle } from "../../../components/timeline/TimelineTracks";
import {
  SequenceVideoPicker,
  SequenceVideoChoice,
} from "../../../components/timeline/SequenceVideoPicker";
import { TimelineCharacterPicker } from "../../../components/TimelineCharacterPicker";
import { TimelineLocationPicker } from "../../../components/TimelineLocationPicker";
import { TimelineAudioPicker } from "../../../components/TimelineAudioPicker";
import {
  TimelineOtherAssetPicker,
  type T2iModelMode,
} from "../../../components/TimelineOtherAssetPicker";
import type { TrajectoryWaypoint } from "../../../components/timeline/TrajectoryEditor";
import {
  defaultVolumeAutomationPoints,
  type VolumeAutomationPoint,
} from "../../../components/timeline/volumeAutomation";
import {
  applyPreviewDragToTrajectory,
  buildAudioClip,
  buildGeometryClip,
  buildImageClip,
  buildVideoClip,
  buildTextClip,
  buildTimelineClipClipboard,
  buildTimelineCompositePngBase64,
  clipActsAsImage,
  clipEnd,
  clipHasEditableTrajectory,
  clamp,
  clampClipRectToFrame,
  clipImageRect,
  clipTransformAtPlayhead,
  clipTransformFromRectCenter,
  defaultImageClipTransform,
  formatTime,
  genId,
  mergePreviewFrameExtension,
  nudgeClipTransform,
  previewFrameExtensionForRects,
  PREVIEW_FRAME_EXTENSION_NONE,
  PREVIEW_MIN_VISIBLE_PX,
  newAudioTrack,
  newNeutralTrack,
  newVideoTrack,
  pasteTimelineClipClipboard,
  placeExternalMediaBatch,
  PREVIEW_NUDGE_PX,
  PREVIEW_NUDGE_SHIFT_PX,
  promoteTrackKind,
  aspectRatio,
  dedupeTimelineManifestClips,
  defaultTrackNameForKind,
  overlayShotLayerPlacement,
  pruneBrokenTransitions,
  resolveClipImageRelPath,
  resolveImportDimensions,
  resolveVideoBgReplaceTiming,
  timelineDuration,
  type ClipTransform,
  type PreviewFrameExtension,
  type TimelineClipClipboard,
} from "../../../components/timeline/timelineUtil";
import {
  createPlayheadStore,
  type PlayheadStore,
} from "../../../components/timeline/timelinePlayback";
import {
  syncMotionPair,
} from "../../../components/timeline/trajectorySync";
import {
  flfEndpointLabel,
  resolveFlfEndpoint,
  selectedFlfClips,
} from "../../../components/timeline/timelineFlfUtils";
import {
  frameSequencePayloadEqual,
  frameSequenceHasExportableFrames,
  planLinkedSequenceClipClose,
  planTimelineFrameSequenceGroupFinish,
  syncTrimHiddenToFrameSequence,
} from "../../../components/frameSequenceStripUtils";
import {
  applyEncodedFrameSequenceReplacements,
  applyFrameSequencePayloads,
} from "../../../components/timeline/frameSequenceManifestOps";
import { measureTextClipNaturalSize } from "../../../components/timeline/textMeasure";
import {
  SEQUENCE_FLF_OUTPUT_LENGTHS,
  SEQUENCE_I2V_OUTPUT_LENGTHS,
  SequenceOutputLengthStepper,
  WAN_VIDEO_DEFAULT_LENGTH,
  WAN_VIDEO_LENGTH_HINT,
} from "../../../components/sequenceOutputLength";
import {
  FrameSequenceModal,
  type FrameSequenceStripActions,
} from "../../detail/[charKey]/dataset/FrameSequenceModal";
import { SequenceEditor } from "../../detail/[charKey]/dataset/SequenceEditor";
import { TIMELINE_STRIP_FRAME_DROP_PREFIX } from "../../detail/[charKey]/dataset/sequenceGalleryUtils";
import { sanitizeDownloadBaseName } from "../../../lib/downloadVideo";
import { sanitizeClipColoringForSave } from "../../../lib/clipColoring";
import { ClipColoringFlyout } from "../../../components/timeline/ClipColoringFlyout";
import { ClipSpeedFlyout } from "../../../components/timeline/ClipSpeedFlyout";
import { ClipAudioTransitionFlyout } from "../../../components/timeline/ClipAudioTransitionFlyout";
import { RemoveBgRmbgFlyout } from "../../../components/timeline/RemoveBgRmbgFlyout";
import { TimelineClipFrameWorkspace } from "../../../components/timeline/TimelineClipFrameWorkspace";
import { cloneFrameSequencePayload, seedSequenceGalleryFromStrip } from "../../../components/timeline/frameWorkspaceOps";
import { rasterizeGeometryToPngBase64 } from "../../../components/timeline/geometryRasterize";
import { usePlayheadValue } from "../../../components/timeline/timelinePlayback";

/** Time readout that subscribes to the live playhead store (no page re-render). */
function PlayheadTimeLabel({ store }: { store: PlayheadStore }) {
  const playhead = usePlayheadValue(store);
  return <>{formatTime(playhead)}</>;
}

export default function TimelineEditorPage() {
  const router = useRouter();
  const params = useParams<{ timelineKey: string }>();
  const timelineKey = params?.timelineKey ?? "";
  const { showError } = useAppError();

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: busy,
    beginSession,
    endSession,
    failSession,
    pushLog,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);

  const [manifest, setManifest] = useState<TimelineManifest | null>(null);
  const [playing, setPlaying] = useState(false);
  const [externalImporting, setExternalImporting] = useState(false);
  const [emptyFileDropOver, setEmptyFileDropOver] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  // Live playhead store (smooth 60fps for preview/ruler/time) + a ref that is
  // always current for event handlers. React `playhead` state is a throttled
  // mirror so the large page tree does not reconcile on every rAF tick.
  const playheadStoreRef = useRef<PlayheadStore | null>(null);
  if (!playheadStoreRef.current) playheadStoreRef.current = createPlayheadStore(0);
  const playheadStore = playheadStoreRef.current;
  const playheadRef = useRef(0);
  const playheadThrottleRef = useRef(0);

  const commitLivePlayhead = useCallback(
    (t: number) => {
      playheadRef.current = t;
      playheadStore.set(t);
      const now = performance.now();
      if (now - playheadThrottleRef.current >= 120) {
        playheadThrottleRef.current = now;
        setPlayhead(t);
      }
    },
    [playheadStore]
  );

  const seekPlayhead = useCallback(
    (t: number) => {
      playheadRef.current = t;
      playheadStore.set(t);
      playheadThrottleRef.current = performance.now();
      setPlayhead(t);
    },
    [playheadStore]
  );

  // When playback stops, make sure React state matches the final live value
  // (the last throttled tick may have been skipped).
  useEffect(() => {
    if (!playing) {
      setPlayhead(playheadRef.current);
    }
  }, [playing]);

  const [pxPerSec, setPxPerSec] = useState(80);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const clipClipboardRef = useRef<TimelineClipClipboard | null>(null);
  const [hasClipClipboard, setHasClipClipboard] = useState(false);
  const [previewHeight, setPreviewHeight] = useState(260);
  const [previewFrameExtension, setPreviewFrameExtension] =
    useState<PreviewFrameExtension>(PREVIEW_FRAME_EXTENSION_NONE);
  const previewFrameExtensionRef = useRef(previewFrameExtension);
  previewFrameExtensionRef.current = previewFrameExtension;
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [trajectoryClipId, setTrajectoryClipId] = useState<string | null>(null);
  const [volumeEditClipId, setVolumeEditClipId] = useState<string | null>(null);
  const [geometryEditClipId, setGeometryEditClipId] = useState<string | null>(null);
  const [textEditClipId, setTextEditClipId] = useState<string | null>(null);
  const [geomPickerOpen, setGeomPickerOpen] = useState(false);
  const [selectedGeomTemplate, setSelectedGeomTemplate] = useState<GeometryTemplate | null>(null);
  const [selectedSavedShapeId, setSelectedSavedShapeId] = useState<string | null>(null);
  const [savedShapes, setSavedShapes] = useState<SavedGeometryShape[]>([]);
  const geomBtnRef = useRef<HTMLButtonElement | null>(null);
  const tracksRef = useRef<TimelineTracksHandle>(null);

  // AI Edit modal (image clips).
  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditImageSrc, setAiEditImageSrc] = useState("");
  const aiEditTargetRef = useRef<{ clipId: string; start: number } | null>(null);
  const [segmentOpen, setSegmentOpen] = useState(false);
  const [segmentMediaSrc, setSegmentMediaSrc] = useState("");
  const [segmentVideoSeekSec, setSegmentVideoSeekSec] = useState(0);
  const [segmentClipType, setSegmentClipType] = useState<"image" | "video">("image");
  const segmentTargetRef = useRef<{
    clipId: string;
    srcRelPath: string;
    type: "image" | "video";
    start: number;
    inPoint: number;
    speed: number;
    localTimeSec: number;
    naturalW?: number;
    naturalH?: number;
    duration?: number;
    source?: TimelineClip["source"];
  } | null>(null);
  const [removeBgVideoOpen, setRemoveBgVideoOpen] = useState(false);
  const removeBgVideoTargetRef = useRef<{
    clipId: string;
    srcRelPath: string;
    start: number;
    inPoint: number;
    outPoint: number;
    speed: number;
    reversed?: boolean;
    srcDuration?: number;
    naturalW?: number;
    naturalH?: number;
    duration?: number;
    source?: TimelineClip["source"];
  } | null>(null);
  const [removeBgImageOpen, setRemoveBgImageOpen] = useState(false);
  const removeBgImagePendingRef = useRef<{
    clipId?: string;
    relPaths: string[];
    inPlace?: boolean;
    stripResolve?: (paths: string[]) => void;
    stripReject?: (e: unknown) => void;
  } | null>(null);
  const previewResizeRef = useRef<{ startY: number; orig: number } | null>(null);

  useEffect(() => {
    const prevBodyBg = document.body.style.background;
    const prevHtmlBg = document.documentElement.style.background;
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.background = "#0e0e0e";
    document.documentElement.style.background = "#0e0e0e";
    // Global overflow-x:hidden makes overflow-y compute to auto, which clips
    // absolute preview spill above/beside the white frame. Downward spill works.
    // Set both axes explicitly so stylesheet overflow-x is fully overridden.
    document.body.style.overflowX = "visible";
    document.body.style.overflowY = "visible";
    document.documentElement.style.overflowX = "visible";
    document.documentElement.style.overflowY = "visible";
    return () => {
      document.body.style.background = prevBodyBg;
      document.documentElement.style.background = prevHtmlBg;
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflowX = "";
      document.body.style.overflowY = "";
      document.documentElement.style.overflowX = "";
      document.documentElement.style.overflowY = "";
    };
  }, []);

  useEffect(() => {
    setPreviewFrameExtension(PREVIEW_FRAME_EXTENSION_NONE);
  }, [timelineKey]);

  // Drag-start waypoint snapshot so trajectory preview-drag stays absolute (no accumulation).
  const trajDragOriginRef = useRef<{
    clipId: string;
    waypoints: NonNullable<TimelineClip["trajectory"]>["waypoints"];
  } | null>(null);

  // Pickers + which track a newly-imported clip should land on.
  const targetTrackRef = useRef<string | null>(null);
  const [seqPickerOpen, setSeqPickerOpen] = useState(false);
  const [charPickerOpen, setCharPickerOpen] = useState(false);
  const [charPickerInitialKey, setCharPickerInitialKey] = useState<string | null>(null);
  const [changePoseClipId, setChangePoseClipId] = useState<string | null>(null);
  const [locPickerOpen, setLocPickerOpen] = useState(false);
  const [audioPickerOpen, setAudioPickerOpen] = useState(false);
  const [otherAssetPickerOpen, setOtherAssetPickerOpen] = useState(false);

  // New Angle modal (for character clips).
  const [cameraAngleOpen, setCameraAngleOpen] = useState(false);
  const [cameraAngleImageUrl, setCameraAngleImageUrl] = useState<string | null>(null);
  const cameraAngleClipIdRef = useRef<string | null>(null);

  const [i2vDialog, setI2vDialog] = useState<{
    open: boolean;
    clipId: string;
    length: number;
    prompt: string;
  } | null>(null);
  const [flfDialog, setFlfDialog] = useState<{
    open: boolean;
    clipIdA: string;
    clipIdB: string;
    length: number;
  } | null>(null);

  const [videoFrameEditor, setVideoFrameEditor] = useState<{
    clipIds: string[];
    primaryClipId: string;
    primaryTrackId: string;
  } | null>(null);
  const [timelineFrameWorkspace, setTimelineFrameWorkspace] = useState<{
    clipIds: string[];
    primaryClipId: string;
    primaryTrackId: string;
  } | null>(null);
  /** Edit a staging gallery sequence set. Done applies strip + re-encodes the clip when changed. */
  const [gallerySequenceEditor, setGallerySequenceEditor] = useState<{
    clipId: string;
    galleryItemId: string;
  } | null>(null);
  const [seqEditorSource, setSeqEditorSource] = useState<{
    charKey: string;
    sequenceName: string;
    /** Timeline clip to rematerialize when SequenceEditor closes. */
    linkedClipId?: string;
    galleryItemId?: string;
    /** Gallery frameSequence snapshot at open — skip rematerialize if unchanged. */
    gallerySnapshot?: FrameSequencePayload;
  } | null>(null);
  const [seqExternalDrag, setSeqExternalDrag] = useState(false);
  const videoFrameApplyStripRef = useRef<FrameSequencePayload | null>(null);
  const videoFrameApplyGroupRef = useRef<Record<string, FrameSequencePayload> | null>(null);
  const videoFrameApplyEditorRef = useRef<{ clipIds: string[]; primaryClipId: string; primaryTrackId: string } | null>(null);
  /** Strip snapshots when Edit Video Frames workspace opened — encode on close if changed. */
  const workspaceStripSnapshotRef = useRef<Record<string, FrameSequencePayload> | null>(null);
  const [stripAiEditOpen, setStripAiEditOpen] = useState(false);
  const [stripAiEditImageSrc, setStripAiEditImageSrc] = useState("");
  const stripAiEditResolveRef = useRef<((rel: string) => void) | null>(null);
  const stripAiEditRelRef = useRef<string | null>(null);
  const [stripDragPreviewPath, setStripDragPreviewPath] = useState<string | null>(null);
  const stripDragPointerRef = useRef<{ x: number; y: number } | null>(null);
  const stripDropSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  // Context menus.
  const [clipMenu, setClipMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    trackId: string;
    clipId: string;
    fromTrack: boolean;
  }>({ open: false, x: 0, y: 0, trackId: "", clipId: "", fromTrack: false });
  const [trackMenu, setTrackMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    trackId: string;
  }>({ open: false, x: 0, y: 0, trackId: "" });
  const [surfaceMenu, setSurfaceMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    trackId: string | null;
  }>({ open: false, x: 0, y: 0, trackId: null });
  const [syncMotionTailSec, setSyncMotionTailSec] = useState(0.5);

  // ---- Load + debounced autosave ------------------------------------------
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!timelineKey) return;
    apiTimelineGet(timelineKey)
      .then((m) => {
        const { manifest: cleaned } = dedupeTimelineManifestClips(m);
        setManifest(cleaned);
        loadedRef.current = true;
        // Lazily generate ~480p preview proxies in the background; merge just
        // the proxy fields back so preview decodes the smaller media.
        void apiTimelineEnsureProxies(timelineKey)
          .then((res) => {
            if (!res.updated || !res.manifest) return;
            const proxies = new Map(
              res.manifest.tracks
                .flatMap((t) => t.clips)
                .map((c) => [
                  c.id,
                  { proxyRelPath: c.proxyRelPath, proxyAlphaRelPath: c.proxyAlphaRelPath },
                ])
            );
            setManifest((prev) =>
              prev
                ? {
                    ...prev,
                    tracks: prev.tracks.map((t) => ({
                      ...t,
                      clips: t.clips.map((c) => {
                        const p = proxies.get(c.id);
                        return p && p.proxyRelPath && p.proxyRelPath !== c.proxyRelPath
                          ? { ...c, ...p }
                          : c;
                      }),
                    })),
                  }
                : prev
            );
          })
          .catch(() => {});
      })
      .catch((e) => showError({ message: "Could not load timeline.", error: e }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineKey]);

  useEffect(() => {
    if (!timelineKey) return;
    apiTimelineSavedShapes(timelineKey)
      .then((layout) => setSavedShapes(layout.items ?? []))
      .catch(() => setSavedShapes([]));
  }, [timelineKey]);

  useEffect(() => {
    if (!manifest || !loadedRef.current) return;
    const id = setTimeout(() => {
      apiTimelinePut(timelineKey, manifest).catch(() => {});
    }, 600);
    return () => clearTimeout(id);
  }, [manifest, timelineKey]);

  const total = useMemo(() => (manifest ? timelineDuration(manifest) : 0), [manifest]);

  // ---- Undo / redo history -------------------------------------------------
  const manifestRef = useRef<TimelineManifest | null>(manifest);
  manifestRef.current = manifest;
  const undoRef = useRef<TimelineManifest[]>([]);
  const redoRef = useRef<TimelineManifest[]>([]);
  const HISTORY_LIMIT = 100;
  // Bump to force re-render so the Undo/Redo buttons reflect stack depth.
  const [, setHistoryTick] = useState(0);

  /** Save the current manifest as a restore point before the next change. */
  const commit = useCallback(() => {
    if (!manifestRef.current) return;
    undoRef.current.push(manifestRef.current);
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
    redoRef.current = [];
    setHistoryTick((t) => t + 1);
  }, []);

  const undo = useCallback(() => {
    const snap = undoRef.current.pop();
    if (!snap) return;
    if (manifestRef.current) redoRef.current.push(manifestRef.current);
    setManifest(snap);
    setHistoryTick((t) => t + 1);
  }, []);

  const redo = useCallback(() => {
    const snap = redoRef.current.pop();
    if (!snap) return;
    if (manifestRef.current) undoRef.current.push(manifestRef.current);
    setManifest(snap);
    setHistoryTick((t) => t + 1);
  }, []);

  // ---- Track targeting -----------------------------------------------------
  const updateManifest = useCallback(
    (fn: (m: TimelineManifest) => TimelineManifest) => {
      setManifest((prev) => (prev ? fn(prev) : prev));
    },
    []
  );

  /** Discrete, undoable mutation: checkpoint then apply. */
  const historyUpdate = useCallback(
    (fn: (m: TimelineManifest) => TimelineManifest) => {
      commit();
      setManifest((prev) => (prev ? fn(prev) : prev));
    },
    [commit]
  );

  const importExternalFiles = useCallback(
    async (targetTrackId: string | null, clientX: number | null, files: File[]) => {
      if (!files.length || externalImporting || busy) return;
      const dropTime =
        targetTrackId && clientX != null
          ? Math.max(0, tracksRef.current?.timeAtClientX(clientX) ?? playheadRef.current)
          : 0;
      setPlaying(false);
      setExternalImporting(true);
      try {
        const result = await apiTimelineImportFiles({ timelineKey, files });
        const clips = result.items.map((item) => {
          if (item.type === "audio") {
            return buildAudioClip({
              srcRelPath: item.srcRelPath,
              durationSec: item.durationSec ?? 0,
              normalizationGain: item.normalizationGain,
            });
          }
          if (item.type === "video") {
            return buildVideoClip({
              srcRelPath: item.srcRelPath,
              durationSec: item.durationSec ?? 0,
              width: item.width ?? 0,
              height: item.height ?? 0,
            });
          }
          return buildImageClip({
            srcRelPath: item.srcRelPath,
            width: item.width ?? 0,
            height: item.height ?? 0,
          });
        });
        historyUpdate((current) => {
          const next = placeExternalMediaBatch({
            manifest: current,
            targetTrackId,
            startSec: dropTime,
            clips,
          });
          return next.manifest;
        });
        if (clips[0]) setSelectedClipIds([clips[0].id]);
        seekPlayhead(dropTime);
      } catch (error) {
        showError({ message: "Could not import dropped media.", error });
      } finally {
        setExternalImporting(false);
      }
    },
    [busy, externalImporting, historyUpdate, seekPlayhead, showError, timelineKey]
  );

  /** Ensure a target track of the given kind exists; return {manifest, trackId}. */
  function resolveTarget(
    m: TimelineManifest,
    kind: "video" | "audio"
  ): { m: TimelineManifest; trackId: string } {
    const wantId = targetTrackRef.current;
    const want = wantId ? m.tracks.find((t) => t.id === wantId) : null;
    if (want && want.kind === kind) return { m, trackId: want.id };
    if (want && want.kind === "neutral" && want.clips.length === 0) {
      const promoted = promoteTrackKind(want, kind, m.tracks);
      return {
        m: {
          ...m,
          tracks: m.tracks.map((t) => (t.id === want.id ? promoted : t)),
        },
        trackId: want.id,
      };
    }
    // Last matching track, else create one.
    const existing = [...m.tracks].reverse().find((t) => t.kind === kind);
    if (existing) return { m, trackId: existing.id };
    const track =
      kind === "video"
        ? newVideoTrack(defaultTrackNameForKind("video", m.tracks))
        : newAudioTrack(defaultTrackNameForKind("audio", m.tracks));
    return { m: { ...m, tracks: [...m.tracks, track] }, trackId: track.id };
  }

  function addClip(kind: "video" | "audio", clip: TimelineClip) {
    historyUpdate((m) => {
      const { m: m2, trackId } = resolveTarget(m, kind);
      const placed = { ...clip, start: playheadRef.current };
      return {
        ...m2,
        tracks: m2.tracks.map((t) => {
          if (t.id !== trackId) return t;
          const shifted = t.clips.map((c) =>
            c.start >= playheadRef.current ? { ...c, start: c.start + placed.duration } : c
          );
          return { ...t, clips: [...shifted, placed] };
        }),
      };
    });
    targetTrackRef.current = null;
  }

  function addVectorClipAtPlayhead(clip: TimelineClip) {
    historyUpdate((m) => {
      const { m: m2, trackId } = resolveTarget(m, "video");
      const placed = { ...clip, start: playheadRef.current };
      return {
        ...m2,
        tracks: m2.tracks.map((t) => {
          if (t.id !== trackId) return t;
          const shifted = t.clips.map((c) =>
            c.start >= playheadRef.current ? { ...c, start: c.start + placed.duration } : c
          );
          return { ...t, clips: [...shifted, placed] };
        }),
      };
    });
    targetTrackRef.current = null;
    setTrajectoryClipId(null);
    setGeometryEditClipId(null);
    selectClip(clip.id, false);
  }

  function addGeometryClip(template?: GeometryTemplate, geometry?: TimelineGeometry) {
    const geom =
      geometry ??
      (template ? createGeometryData(template) : undefined);
    if (!geom) return;
    const clip = buildGeometryClip({ template: geom.template, geometry: geom });
    addVectorClipAtPlayhead(clip);
    setGeomPickerOpen(false);
    setSelectedGeomTemplate(null);
    setSelectedSavedShapeId(null);
  }

  async function refreshSavedShapes() {
    try {
      const layout = await apiTimelineSavedShapes(timelineKey);
      setSavedShapes(layout.items ?? []);
    } catch {
      setSavedShapes([]);
    }
  }

  async function saveShapeFromClip(clipId: string) {
    const rc = findClip(clipId);
    if (!rc?.clip.geometry || !geometryIsCustomized(rc.clip.geometry)) return;
    const name = window.prompt("Shape name", "My Shape");
    if (!name?.trim()) return;
    try {
      await apiSaveTimelineShape(timelineKey, {
        name: name.trim(),
        geometry: rc.clip.geometry,
      });
      await refreshSavedShapes();
    } catch (e) {
      showError({ message: "Could not save shape.", error: e });
    }
  }

  function addTextClip() {
    const clip = buildTextClip({});
    addVectorClipAtPlayhead(clip);
    setTextEditClipId(clip.id);
    if (clip.text) applyTextClipNaturalSize(clip.id, clip.text);
  }

  function applyTextClipNaturalSize(clipId: string, text: TimelineText) {
    void measureTextClipNaturalSize(text).then(({ width, height }) => {
      historyUpdate((m) => ({
        ...m,
        tracks: m.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId ? { ...c, naturalW: width, naturalH: height } : c
          ),
        })),
      }));
    });
  }

  function updateClipGeometry(clipId: string, geometry: TimelineGeometry) {
    updateManifest((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, geometry } : c)),
      })),
    }));
  }

  function updateClipText(clipId: string, patch: Partial<TimelineText>) {
    const found = findClip(clipId);
    if (!found?.clip.text) return;
    const nextText = { ...found.clip.text, ...patch };
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId && c.text ? { ...c, text: nextText } : c
        ),
      })),
    }));
    applyTextClipNaturalSize(clipId, nextText);
  }

  function updateClipTextContent(clipId: string, content: string) {
    const found = findClip(clipId);
    if (!found?.clip.text) return;
    const nextText = { ...found.clip.text, content };
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId && c.text ? { ...c, text: nextText } : c
        ),
      })),
    }));
    applyTextClipNaturalSize(clipId, nextText);
  }

  function updateClipTransition(
    trackId: string,
    outgoingClipId: string,
    transition: TimelineTransitionOut | undefined
  ) {
    updateManifest((m) =>
      pruneBrokenTransitions({
        ...m,
        tracks: m.tracks.map((t) =>
          t.id !== trackId
            ? t
            : {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === outgoingClipId ? { ...c, transitionOut: transition } : c
                ),
              }
        ),
      })
    );
  }

  function pruneTransitionsAfterEdit() {
    setManifest((prev) => (prev ? pruneBrokenTransitions(prev) : prev));
  }

  // ---- Toolbar actions -----------------------------------------------------
  function addNeutralTrack() {
    historyUpdate((m) => ({
      ...m,
      tracks: [
        ...m.tracks,
        newNeutralTrack(`Track ${m.tracks.length + 1}`),
      ],
    }));
  }

  function openAudioPicker(targetTrackId?: string) {
    exitClipEditModes();
    targetTrackRef.current = targetTrackId ?? null;
    setAudioPickerOpen(true);
  }

  function openOtherAssetPicker(targetTrackId?: string) {
    exitClipEditModes();
    targetTrackRef.current = targetTrackId ?? null;
    setOtherAssetPickerOpen(true);
  }

  async function onOtherAssetGenerate(
    prompt: string,
    modelMode: T2iModelMode
  ): Promise<TimelineAsset | null> {
    beginSession({ title: "Generating image (T2I)", clearLog: true });
    await Promise.resolve();
    pushLog(`T2I (${modelMode})…`);
    try {
      const done = await runTimelineT2iWsJob({
        timelineKey,
        promptText: prompt,
        modelMode,
        previewAspect: manifest?.previewAspect ?? "16:9",
        onLogLine: pushLog,
      });
      if (!done.ok || !done.result?.item) {
        throw new Error(done.error || "T2I generation failed.");
      }
      endSession();
      return done.result.item;
    } catch (e) {
      failSession(e, "T2I generation failed.");
      return null;
    }
  }

  async function onOtherAssetUseSelected(items: TimelineAsset[]) {
    if (!items.length) return;
    setOtherAssetPickerOpen(false);
    const tid = targetTrackRef.current;
    beginSession({ title: "Adding assets", clearLog: true });
    await Promise.resolve();
    try {
      for (const item of items) {
        pushLog(`Importing ${item.prompt?.slice(0, 40) || item.id}…`);
        const imported = await apiTimelineImportImage({
          timelineKey,
          sourceRelPath: item.relPath,
        });
        const { width, height } = await resolveImportDimensions(
          imported.srcRelPath,
          imported.width || item.width,
          imported.height || item.height
        );
        const clip = buildImageClip({
          srcRelPath: imported.srcRelPath,
          width,
          height,
        });
        if (tid) {
          insertClipOnSameTrack(clip, tid, playhead);
        } else {
          insertClipOnNewTrack(clip, playhead, "T2I");
        }
      }
      endSession();
    } catch (e) {
      failSession(e, "Could not add assets to timeline.");
    }
  }

  async function importAudioClipToTimeline(sourceRelPath: string, durationSec: number) {
    const imported = await apiTimelineImportAudio({
      timelineKey,
      sourceRelPath,
    });
    const dur = imported.durationSec || durationSec;
    addClip(
      "audio",
      buildAudioClip({
        srcRelPath: imported.srcRelPath,
        durationSec: dur,
        normalizationGain: imported.normalizationGain,
      })
    );
  }

  async function onGenerateAudio(prompt: string, durationSec: number) {
    setAudioPickerOpen(false);
    beginSession({ title: "Generating audio", clearLog: true });
    await Promise.resolve();
    pushLog("Running ACE-Step audio generation…");
    try {
      const done = await runReferenceAudioGenerateWsJob({
        mode: "audio",
        prompt,
        duration: durationSec,
        onLogLine: pushLog,
      });
      if (!done.ok || !done.result?.item?.relPath) {
        throw new Error(done.error ?? "Audio generation failed.");
      }
      pushLog("Importing audio to timeline…");
      await importAudioClipToTimeline(done.result.item.relPath, done.result.durationSec);
      endSession();
    } catch (e) {
      failSession(e, "Audio generation failed.");
    }
  }

  async function onGenerateMusic(style: string, lyrics: string, durationSec: number) {
    setAudioPickerOpen(false);
    beginSession({ title: "Generating music", clearLog: true });
    await Promise.resolve();
    pushLog("Running ACE-Step music generation…");
    try {
      const done = await runReferenceAudioGenerateWsJob({
        mode: "music",
        style,
        lyrics,
        duration: durationSec,
        onLogLine: pushLog,
      });
      if (!done.ok || !done.result?.item?.relPath) {
        throw new Error(done.error ?? "Music generation failed.");
      }
      pushLog("Importing music to timeline…");
      await importAudioClipToTimeline(done.result.item.relPath, done.result.durationSec);
      endSession();
    } catch (e) {
      failSession(e, "Music generation failed.");
    }
  }

  async function onAudioGalleryUseSelected(items: AudioReference[]) {
    if (!items.length) return;
    setAudioPickerOpen(false);
    beginSession({ title: "Importing audio", clearLog: true });
    await Promise.resolve();
    try {
      for (const item of items) {
        pushLog(`Importing ${item.label || item.id}…`);
        await importAudioClipToTimeline(item.relPath, 120);
      }
      endSession();
    } catch (e) {
      failSession(e, "Could not import audio.");
    }
  }

  async function onPickSequence(choice: SequenceVideoChoice) {
    setSeqPickerOpen(false);
    beginSession({ title: "Importing video", clearLog: true });
    await Promise.resolve();
    pushLog(`Materializing ${choice.label}…`);
    try {
      const done = await runTimelineImportSequenceWsJob({
        timelineKey,
        charKey: choice.charKey,
        sequenceName: choice.sequenceName,
        galleryItemId: choice.galleryItemId,
        onLogLine: (line) => pushLog(line),
      });
      const r = done.result;
      if (!done.ok || !r?.srcRelPath) {
        throw new Error(done.error || "Import returned no clip.");
      }
      const dur = r.durationSec || 5;
      addClip("video", {
        id: genId("clip"),
        type: "video",
        srcRelPath: r.srcRelPath,
        start: 0,
        inPoint: 0,
        outPoint: dur,
        speed: 1,
        duration: dur,
        srcDuration: dur,
        naturalW: r.width || undefined,
        naturalH: r.height || undefined,
        source: {
          charKey: choice.charKey,
          sequenceName: choice.sequenceName,
          galleryItemId: choice.galleryItemId,
        },
      });
      endSession();
    } catch (e) {
      failSession(e, "Could not import video.");
    }
  }

  async function importImageClipsBatch(
    relPaths: string[],
    source: TimelineClip["source"],
    sessionTitle = "Importing images"
  ) {
    if (!relPaths.length) return;
    beginSession({ title: sessionTitle, clearLog: true });
    await Promise.resolve();
    try {
      for (const sourceRelPath of relPaths) {
        pushLog(`Importing ${sourceRelPath.split("/").pop() ?? "image"}…`);
        const r = await apiTimelineImportImage({ timelineKey, sourceRelPath });
        const { width, height } = await resolveImportDimensions(
          r.srcRelPath,
          r.width || 0,
          r.height || 0
        );
        addClip(
          "video",
          buildImageClip({
            srcRelPath: r.srcRelPath,
            width,
            height,
            source,
          })
        );
      }
      endSession();
    } catch (e) {
      failSession(e, "Could not import images.");
    }
  }

  async function importImageClip(sourceRelPath: string, source: TimelineClip["source"]) {
    await importImageClipsBatch([sourceRelPath], source, "Importing image");
  }

  // ---- Character picker (pose / expression / sequence) ---------------------

  /** Change Pose: import a timeline copy and add a new clip (source clip unchanged). */
  async function addPoseClipFromSource(sourceClipId: string, relPath: string, charKey: string) {
    const found = findClip(sourceClipId);
    if (!found) return;
    beginSession({ title: "Adding pose clip", clearLog: true });
    await Promise.resolve();
    pushLog("Importing new pose…");
    try {
      const r = await apiTimelineImportImage({ timelineKey, sourceRelPath: relPath });
      const { width, height } = await resolveImportDimensions(
        r.srcRelPath,
        r.width || 0,
        r.height || 0
      );
      insertClipOnSameTrack(
        buildImageClip({
          srcRelPath: r.srcRelPath,
          width,
          height,
          source: { ...found.clip.source, charKey },
          durationSec: found.clip.duration,
        }),
        found.trackId,
        found.clip.start
      );
      endSession();
    } catch (e) {
      failSession(e, "Could not add pose clip.");
    }
  }

  function onPickCharImages(charKey: string, relPaths: string[]) {
    if (!relPaths.length) return;
    setCharPickerOpen(false);
    const sourceClipId = changePoseClipId;
    setChangePoseClipId(null);
    setCharPickerInitialKey(null);
    if (sourceClipId) {
      void addPoseClipFromSource(sourceClipId, relPaths[0], charKey);
    } else {
      void importImageClipsBatch(relPaths, { charKey });
    }
  }

  async function onPickCharSequences(
    charKey: string,
    picks: { sequenceName: string; galleryItemId?: string }[]
  ) {
    if (!picks.length) return;
    setCharPickerOpen(false);
    setChangePoseClipId(null);
    setCharPickerInitialKey(null);
    beginSession({ title: "Importing sequences", clearLog: true });
    await Promise.resolve();
    try {
      for (const pick of picks) {
        const { sequenceName, galleryItemId } = pick;
        pushLog(`Materializing ${sequenceName}…`);
        const done = await runTimelineImportSequenceWsJob({
          timelineKey,
          charKey,
          sequenceName,
          galleryItemId,
          onLogLine: (line) => pushLog(line),
        });
        const r = done.result;
        if (!done.ok || !r?.srcRelPath) {
          throw new Error(done.error || "Import returned no clip.");
        }
        const dur = r.durationSec || 5;
        addClip("video", {
          id: genId("clip"),
          type: "video",
          srcRelPath: r.srcRelPath,
          start: 0,
          inPoint: 0,
          outPoint: dur,
          speed: 1,
          duration: dur,
          srcDuration: dur,
          naturalW: r.width || undefined,
          naturalH: r.height || undefined,
          source: {
            charKey,
            sequenceName,
            ...(galleryItemId ? { galleryItemId } : {}),
          },
        });
      }
      endSession();
    } catch (e) {
      failSession(e, "Could not import sequences.");
    }
  }

  function onPickLocationImages(locationKey: string, relPaths: string[]) {
    if (!relPaths.length) return;
    setLocPickerOpen(false);
    void importImageClipsBatch(relPaths, { locationKey });
  }

  // ---- New Angle ------------------------------------------------------------
  function openClipAngle(clipId: string) {
    const found = findClip(clipId);
    if (!found) return;
    cameraAngleClipIdRef.current = clipId;
    setCameraAngleImageUrl(assetUrlFromRelPath(found.clip.srcRelPath));
    setCameraAngleOpen(true);
  }

  async function applyClipAngle(angleId: number) {
    setCameraAngleOpen(false);
    const clipId = cameraAngleClipIdRef.current;
    cameraAngleClipIdRef.current = null;
    if (!clipId) return;
    const found = findClip(clipId);
    if (!found) return;
    beginSession({ title: "Generating new angle", clearLog: true });
    await Promise.resolve();
    pushLog("Generating a new camera angle…");
    try {
      const done = await runShotMakeAngleWsJob({
        imageRelPath: found.clip.srcRelPath,
        angleId,
        onLogLine: (line) => pushLog(line),
      });
      const newRel = done.result?.relPath;
      if (!done.ok || !newRel) throw new Error(done.error || "Angle generation returned no image.");
      const r = await apiTimelineImportImage({ timelineKey, sourceRelPath: newRel });
      const { width, height } = await resolveImportDimensions(
        r.srcRelPath,
        r.width || 0,
        r.height || 0
      );
      insertClipOnSameTrack(
        buildImageClip({
          srcRelPath: r.srcRelPath,
          width,
          height,
          source: found.clip.source,
          durationSec: found.clip.duration,
        }),
        found.trackId,
        found.clip.start
      );
      endSession();
    } catch (e) {
      failSession(e, "Could not generate a new angle.");
    }
  }

  // ---- Joint Generate (character + background overlap) ----------------------
  function getOverlappingCharBgPair(): [backdrop: TimelineClip, overlay: TimelineClip] | null {
    const sel = selectedImageClips();
    if (sel.length !== 2) return null;
    const [a, b] = sel;
    const aEnd = a.start + a.duration;
    const bEnd = b.start + b.duration;
    if (a.start >= bEnd || b.start >= aEnd) return null;
    const overlay = [a, b].find((c) => c.source?.charKey || c.type === "geometry");
    const backdrop = [a, b].find((c) => c !== overlay && c.type === "image");
    if (!overlay || !backdrop) return null;
    return [backdrop, overlay];
  }

  async function runJointGenerate(mode: "i2i" | "as_is") {
    const pair = getOverlappingCharBgPair();
    if (!pair || !manifest) return;
    const [backdrop, overlay] = pair;
    beginSession({ title: mode === "i2i" ? "Generating scene" : "Combining images", clearLog: true });
    await Promise.resolve();
    pushLog("Building composite…");
    try {
      const compositeResult = await buildTimelineCompositePngBase64({
        backdrop,
        overlay,
        previewAspect: manifest.previewAspect,
        playhead: playheadRef.current,
      });
      const placement = overlayShotLayerPlacement({
        ovRect: compositeResult.ovRect,
        bgRect: compositeResult.bgRect,
        overlayNaturalW: compositeResult.overlayNaturalW,
        overlayNaturalH: compositeResult.overlayNaturalH,
        backdropNaturalW: compositeResult.backdropNaturalW,
        backdropNaturalH: compositeResult.backdropNaturalH,
      });
      const overlayRel = await resolveClipImageRelPath(timelineKey, overlay);
      const charKey = overlay.source?.charKey ?? "";
      const layers: ShotLayerMeta[] = [{
        charKey,
        imageRelPath: overlayRel,
        ...placement,
      }];
      pushLog("Sending to generation…");
      const done = await runShotCreateWsJob({
        shotName: `timeline_shot_${Date.now()}`,
        locationKey: backdrop.source?.locationKey ?? null,
        locationImageRelPath: backdrop.srcRelPath,
        characters: layers,
        compositePngBase64: compositeResult.base64,
        promptText: "",
        mode,
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.outputRelPath) {
        throw new Error(done.error ?? "Shot generation failed.");
      }
      await importImageClip(done.result.outputRelPath, {
        shotKey: done.result.shotKey,
        combined: true,
      });
      endSession();
    } catch (e) {
      failSession(e, "Joint generation failed.");
    }
  }

  /** Delete clip(s) by ID in one undo-able operation (works across all tracks). */
  function deleteClips(clipIds: string[]) {
    const idSet = new Set(clipIds);
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => !idSet.has(c.id)),
      })),
    }));
    setSelectedClipIds((prev) => prev.filter((x) => !idSet.has(x)));
  }

  function updateClipTrajectory(clipId: string, trajectory: TimelineClip["trajectory"]) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, trajectory } : c)),
      })),
    }));
  }

  /**
   * Bring a clip's position back to the frame center so an off-border clip is
   * reachable again. Trajectory clips are shifted by their waypoint centroid so
   * the motion shape is preserved; other clips reset x/y to 0 (scale kept).
   */
  function resetClipPosition(clipId: string) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clipId) return c;
          if (clipHasEditableTrajectory(c) && c.trajectory) {
            const wps = c.trajectory.waypoints;
            const n = wps.length || 1;
            const cx = wps.reduce((s, w) => s + w.x, 0) / n;
            const cy = wps.reduce((s, w) => s + w.y, 0) / n;
            return {
              ...c,
              trajectory: {
                ...c.trajectory,
                waypoints: wps.map((w) => ({ ...w, x: w.x - cx, y: w.y - cy })),
              },
            };
          }
          return {
            ...c,
            transform: {
              ...(c.transform ?? defaultImageClipTransform()),
              x: 0,
              y: 0,
            },
          };
        }),
      })),
    }));
  }

  function updateClipVolumeAutomation(
    clipId: string,
    volumeAutomation: TimelineClip["volumeAutomation"]
  ) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId ? { ...c, volumeAutomation } : c
        ),
      })),
    }));
  }

  function updateClipColoringLive(clipId: string, coloring: TimelineClip["coloring"]) {
    updateManifest((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clipId) return c;
          const sanitized = sanitizeClipColoringForSave(coloring);
          if (sanitized) return { ...c, coloring: sanitized };
          const { coloring: _drop, ...rest } = c;
          return rest as TimelineClip;
        }),
      })),
    }));
  }

  function updateClipColoringCommit(clipId: string) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clipId) return c;
          const sanitized = sanitizeClipColoringForSave(c.coloring);
          if (sanitized) return { ...c, coloring: sanitized };
          const { coloring: _drop, ...rest } = c;
          return rest as TimelineClip;
        }),
      })),
    }));
  }

  function updateClipSpeedLive(clipId: string, speed: number) {
    const sp = Math.max(0.1, speed);
    updateManifest((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id !== clipId
            ? c
            : { ...c, speed: sp, duration: (c.outPoint - c.inPoint) / sp }
        ),
      })),
    }));
  }

  function updateClipSpeedCommit(clipId: string) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c } : c)),
      })),
    }));
  }

  function updateClipReverseLive(clipId: string, reversed: boolean) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id !== clipId ? c : { ...c, reversed })),
      })),
    }));
  }

  function onVolumePointsChange(clipId: string, points: VolumeAutomationPoint[]) {
    updateManifest((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId
            ? { ...c, volumeAutomation: { points } }
            : c
        ),
      })),
    }));
  }

  function onWaypointChange(clipId: string, waypoints: TrajectoryWaypoint[]) {
    updateManifest((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId && c.trajectory
            ? { ...c, trajectory: { ...c.trajectory, waypoints } }
            : c
        ),
      })),
    }));
  }

  function onWaypointPatchCommit() {
    commit();
  }

  function onMotionChange(clipId: string, motion: TrajectoryMotionId, motionAmount: number) {
    updateManifest((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId && c.trajectory
            ? { ...c, trajectory: { ...c.trajectory, motion, motionAmount } }
            : c
        ),
      })),
    }));
  }

  async function runRemoveBgImage(options: RemoveBgImageRunOptions) {
    const pending = removeBgImagePendingRef.current;
    setRemoveBgImageOpen(false);
    removeBgImagePendingRef.current = null;
    if (!pending || pending.relPaths.length === 0) return;

    const wsPayload = {
      engine: options.engine,
      rmbg: options.rmbg,
      animeSeg: options.animeSeg,
      onLogLine: (line: string) => pushLog(line),
    };

    if (pending.stripResolve) {
      beginSession({ title: "Removing background", clearLog: true });
      await Promise.resolve();
      try {
        const out: string[] = [];
        for (const rel of pending.relPaths) {
          pushLog(`Removing background: ${rel.split("/").pop() ?? "frame"}…`);
          const done = await runShotRemoveBgWsJob({
            imageRelPath: rel,
            inPlace: pending.inPlace,
            ...wsPayload,
          });
          const nextRel = done.result?.relPath;
          if (!done.ok || !nextRel) throw new Error(done.error || "Remove background failed.");
          out.push(nextRel);
        }
        endSession();
        pending.stripResolve(out);
      } catch (e) {
        failSession(e, "Remove background failed.");
        pending.stripReject?.(e);
      }
      return;
    }

    if (!pending.clipId) return;
    const found = findClip(pending.clipId);
    if (!found || found.clip.type !== "image") return;
    beginSession({ title: "Removing background", clearLog: true });
    await Promise.resolve();
    pushLog("Removing background…");
    try {
      const done = await runShotRemoveBgWsJob({
        imageRelPath: found.clip.srcRelPath,
        ...wsPayload,
      });
      const newRel = done.result?.relPath;
      if (!done.ok || !newRel) throw new Error(done.error || "Background removal failed.");
      const r = await apiTimelineImportImage({ timelineKey, sourceRelPath: newRel });
      const { width, height } = await resolveImportDimensions(
        r.srcRelPath,
        r.width || 0,
        r.height || 0
      );
      insertClipOnNewTrack(
        buildImageClip({
          srcRelPath: r.srcRelPath,
          width,
          height,
          source: found.clip.source,
          durationSec: found.clip.duration,
        }),
        found.clip.start,
        "Remove Background"
      );
      endSession();
    } catch (e) {
      failSession(e, "Background removal failed.");
    }
  }

  function insertVideoBgClip(
    r: {
      srcRelPath: string;
      alphaRelPath?: string;
      width: number;
      height: number;
      durationSec?: number;
      fps?: number;
      frames?: number;
    },
    start: number,
    fallback: {
      inPoint?: number;
      outPoint?: number;
      speed?: number;
      reversed?: boolean;
      srcDuration?: number;
      naturalW?: number;
      naturalH?: number;
      duration?: number;
      source?: TimelineClip["source"];
    },
    label: string
  ) {
    const timing = resolveVideoBgReplaceTiming(
      {
        durationSec: r.durationSec,
        fps: r.fps,
        frames: r.frames,
      },
      fallback
    );
    insertClipOnNewTrack(
      {
        id: genId("clip"),
        type: "video",
        srcRelPath: r.srcRelPath,
        ...(r.alphaRelPath ? { alphaRelPath: r.alphaRelPath } : {}),
        start: 0,
        inPoint: timing.inPoint,
        outPoint: timing.outPoint,
        speed: timing.speed,
        ...(fallback.reversed ? { reversed: true } : {}),
        duration: timing.duration,
        srcDuration: timing.srcDuration,
        naturalW: r.width || fallback.naturalW,
        naturalH: r.height || fallback.naturalH,
        source: fallback.source,
      },
      start,
      label
    );
  }

  async function runRemoveBgRvm(options: RvmBgOptions) {
    const tgt = removeBgVideoTargetRef.current;
    setRemoveBgVideoOpen(false);
    removeBgVideoTargetRef.current = null;
    if (!tgt || !timelineKey) return;
    beginSession({ title: "Removing video background (RVM)", clearLog: true });
    await Promise.resolve();
    pushLog("Starting RobustVideoMatting (model loads on first run ~15 s)…");
    try {
      const done = await runTimelineVideoRemoveBgWsJob({
        timelineKey,
        videoRelPath: tgt.srcRelPath,
        preset: options.preset,
        downsampleRatio: options.downsampleRatio,
        backbone: options.backbone,
        alphaDilatePx: options.alphaDilatePx,
        useSourceRgb: options.useSourceRgb,
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.srcRelPath) {
        throw new Error(done.error || "Video BG removal returned no output.");
      }
      insertVideoBgClip(done.result, tgt.start, tgt, "Remove Background (RVM)");
      endSession();
    } catch (e) {
      failSession(e, "Video background removal failed.");
    }
  }

  async function runRemoveBgRmbg(options: {
    processEveryFrame: boolean;
    rmbg: RmbgBgOptions;
  }) {
    const tgt = removeBgVideoTargetRef.current;
    setRemoveBgVideoOpen(false);
    removeBgVideoTargetRef.current = null;
    if (!tgt || !timelineKey) return;
    beginSession({ title: "Removing video background (RMBG)", clearLog: true });
    await Promise.resolve();
    pushLog("Starting per-frame RMBG-2.0…");
    try {
      const done = await runTimelineVideoRemoveBgRmbgWsJob({
        timelineKey,
        videoRelPath: tgt.srcRelPath,
        processEveryFrame: options.processEveryFrame,
        rmbg: options.rmbg,
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.srcRelPath) {
        throw new Error(done.error || "RMBG video BG removal returned no output.");
      }
      insertVideoBgClip(done.result, tgt.start, tgt, "Remove Background (RMBG)");
      endSession();
    } catch (e) {
      failSession(e, "RMBG video background removal failed.");
    }
  }

  async function runRemoveBgAnimeSeg(options: {
    processEveryFrame: boolean;
    animeSeg: AnimeSegBgOptions;
  }) {
    const tgt = removeBgVideoTargetRef.current;
    setRemoveBgVideoOpen(false);
    removeBgVideoTargetRef.current = null;
    if (!tgt || !timelineKey) return;
    beginSession({ title: "Removing video background (Anime Seg)", clearLog: true });
    await Promise.resolve();
    pushLog("Starting per-frame anime segmentation…");
    try {
      const done = await runTimelineVideoRemoveBgAnimeSegWsJob({
        timelineKey,
        videoRelPath: tgt.srcRelPath,
        processEveryFrame: options.processEveryFrame,
        animeSeg: options.animeSeg,
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.srcRelPath) {
        throw new Error(done.error || "Anime Seg video BG removal returned no output.");
      }
      insertVideoBgClip(done.result, tgt.start, tgt, "Remove Background (Anime Seg)");
      endSession();
    } catch (e) {
      failSession(e, "Anime Seg video background removal failed.");
    }
  }

  async function commitRename() {
    setRenaming(false);
    const next = renameValue.trim();
    if (!next || next === timelineKey) return;
    try {
      const { newTimelineKey } = await apiTimelineHubRename(timelineKey, next);
      exitClipEditModes();
      router.replace(`/timeline/${encodeURIComponent(newTimelineKey)}`);
    } catch (e) {
      showError({ message: "Could not rename timeline.", error: e });
    }
  }

  async function runExportMp4() {
    beginSession({ title: "Exporting MP4", clearLog: true });
    await Promise.resolve();
    pushLog("Starting export…");
    try {
      if (manifest) {
        pushLog("Saving timeline…");
        await apiTimelinePut(timelineKey, manifest);
      }
      const done = await runTimelineExportMp4WsJob({
        timelineKey,
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.relPath) throw new Error(done.error || "Export returned no file.");
      pushLog("Export complete. Starting download…");
      endSession();
      const a = document.createElement("a");
      a.href = assetDownloadUrlFromRelPath(done.result.relPath);
      a.download = `${timelineKey}.mp4`;
      a.click();
    } catch (e) {
      failSession(e, "Export failed.");
    }
  }

  function splitClipAtPlayhead(trackId: string, clipId: string) {
    const head = playheadRef.current;
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const clips: TimelineClip[] = [];
        for (const c of t.clips) {
          if (c.id !== clipId || head <= c.start || head >= clipEnd(c)) {
            clips.push(c);
            continue;
          }
          const leftDur = head - c.start;
          const hasSrc = c.type === "video" || c.type === "audio";
          const cutPoint = hasSrc
            ? c.reversed
              ? c.outPoint - leftDur * c.speed
              : c.inPoint + leftDur * c.speed
            : c.inPoint;
          if (c.reversed && hasSrc) {
            clips.push({
              ...c,
              duration: leftDur,
              inPoint: cutPoint,
            });
            clips.push({
              ...c,
              id: genId("clip"),
              start: head,
              outPoint: cutPoint,
              duration: clipEnd(c) - head,
            });
          } else {
            clips.push({
              ...c,
              duration: leftDur,
              outPoint: hasSrc ? cutPoint : c.outPoint,
            });
            clips.push({
              ...c,
              id: genId("clip"),
              start: head,
              inPoint: hasSrc ? cutPoint : c.inPoint,
              duration: clipEnd(c) - head,
            });
          }
        }
        return { ...t, clips };
      }),
    }));
  }

  // ---- Selection / transform / generation ---------------------------------
  function exitClipEditModes() {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    setTrajectoryClipId(null);
    setGeometryEditClipId(null);
    setTextEditClipId(null);
  }

  const exitTrajectoryEdit = useCallback(() => {
    commit();
    setTrajectoryClipId(null);
  }, [commit]);

  function selectClip(clipId: string | null, additive: boolean) {
    if (clipId == null) {
      if (!additive) {
        setSelectedClipIds([]);
        exitClipEditModes();
      }
      return;
    }
    if (
      clipId !== textEditClipId &&
      clipId !== geometryEditClipId &&
      clipId !== trajectoryClipId
    ) {
      exitClipEditModes();
    }
    setSelectedClipIds((prev) => {
      if (additive) {
        return prev.includes(clipId)
          ? prev.filter((x) => x !== clipId)
          : [...prev, clipId];
      }
      return [clipId];
    });
  }

  function selectClips(clipIds: string[], additive: boolean) {
    exitClipEditModes();
    setSelectedClipIds((prev) => {
      if (additive) {
        const next = new Set(prev);
        for (const id of clipIds) next.add(id);
        return [...next];
      }
      return [...clipIds];
    });
  }

  function findClip(clipId: string): { trackId: string; clip: TimelineClip } | null {
    if (!manifest) return null;
    for (const t of manifest.tracks) {
      const clip = t.clips.find((c) => c.id === clipId);
      if (clip) return { trackId: t.id, clip };
    }
    return null;
  }

  const copySelectedClips = useCallback(() => {
    if (!manifest || selectedClipIds.length === 0) return;
    const cb = buildTimelineClipClipboard(manifest, selectedClipIds);
    if (cb) {
      clipClipboardRef.current = cb;
      setHasClipClipboard(true);
    }
  }, [manifest, selectedClipIds]);

  const pasteClips = useCallback(() => {
    const cb = clipClipboardRef.current;
    if (!cb) return;
    let newClipIds: string[] = [];
    historyUpdate((m) => {
      const result = pasteTimelineClipClipboard(m, cb, playheadRef.current);
      newClipIds = result.newClipIds;
      return result.manifest;
    });
    if (newClipIds.length === 0) return;
    setSelectedClipIds(newClipIds);
    setPlaying(false);
    exitClipEditModes();
  }, [historyUpdate]);

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      const t = target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    }

    function modalBlocksShortcuts(): boolean {
      return (
        aiEditOpen ||
        segmentOpen ||
        cameraAngleOpen ||
        charPickerOpen ||
        locPickerOpen ||
        audioPickerOpen ||
        seqPickerOpen ||
        jobModalProps.open
      );
    }

    function editorBlocksTimelineShortcuts(): boolean {
      return Boolean(
        videoFrameEditor ||
          gallerySequenceEditor ||
          seqEditorSource ||
          timelineFrameWorkspace
      );
    }

    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;

      if (trajectoryClipId && !modalBlocksShortcuts()) {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          exitTrajectoryEdit();
          return;
        }
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          !modalBlocksShortcuts() &&
          !editorBlocksTimelineShortcuts() &&
          selectedClipIds.length > 0
        ) {
          e.preventDefault();
          const ids = [...selectedClipIds];
          deleteClips(ids);
          if (trajectoryClipId && ids.includes(trajectoryClipId)) {
            setTrajectoryClipId(null);
          }
          if (geometryEditClipId && ids.includes(geometryEditClipId)) {
            setGeometryEditClipId(null);
          }
          if (textEditClipId && ids.includes(textEditClipId)) {
            setTextEditClipId(null);
          }
          if (volumeEditClipId && ids.includes(volumeEditClipId)) {
            setVolumeEditClipId(null);
          }
        }
        return;
      }

      const arrowKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;
      if (arrowKeys.includes(e.key as (typeof arrowKeys)[number])) {
        if (modalBlocksShortcuts() || editorBlocksTimelineShortcuts() || !manifest) return;

        const inClipEdit =
          !!textEditClipId ||
          !!geometryEditClipId ||
          !!trajectoryClipId ||
          !!volumeEditClipId;

        const canNudgeClip =
          selectedClipIds.length > 0 &&
          !playing &&
          !inClipEdit;

        if (canNudgeClip) {
          e.preventDefault();
          const stepPx = e.shiftKey ? PREVIEW_NUDGE_SHIFT_PX : PREVIEW_NUDGE_PX;
          let dx = 0;
          let dy = 0;
          if (e.key === "ArrowLeft") dx = -1;
          else if (e.key === "ArrowRight") dx = 1;
          else if (e.key === "ArrowUp") dy = -1;
          else if (e.key === "ArrowDown") dy = 1;

          const ratio = aspectRatio(manifest.previewAspect);
          const frameH = previewHeight;
          const frameW = previewHeight * ratio;

          let mergedExtend: PreviewFrameExtension = PREVIEW_FRAME_EXTENSION_NONE;
          historyUpdate((m) => {
            let next = m;
            for (const clipId of selectedClipIds) {
              const found = next.tracks
                .flatMap((t) => t.clips.map((c) => ({ clip: c })))
                .find(({ clip }) => clip.id === clipId);
              const clip = found?.clip;
              if (
                !clip ||
                (clip.type !== "image" &&
                  clip.type !== "video" &&
                  clip.type !== "geometry" &&
                  clip.type !== "text")
              ) {
                continue;
              }
              const from = clipTransformAtPlayhead(clip, playheadRef.current);
              const nudged = nudgeClipTransform(from, dx * stepPx, dy * stepPx, frameW, frameH);
              const rect = clipImageRect(clip, nudged, frameW, frameH);
              const activeExtend = mergePreviewFrameExtension(
                previewFrameExtensionRef.current,
                previewFrameExtensionForRects([rect], frameW, frameH)
              );
              const clamped = clampClipRectToFrame(
                rect,
                frameW,
                frameH,
                PREVIEW_MIN_VISIBLE_PX,
                activeExtend
              );
              const { x, y } = clipTransformFromRectCenter(clamped, frameW, frameH);
              const to = { ...from, x, y };
              next = applyClipPreviewTransform(next, clipId, from, to, "move", null);
              mergedExtend = mergePreviewFrameExtension(
                mergedExtend,
                previewFrameExtensionForRects([clamped], frameW, frameH)
              );
            }
            return next;
          });
          previewFrameExtensionRef.current = mergedExtend;
          setPreviewFrameExtension(mergedExtend);
          return;
        }

        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const fps = Math.max(1, manifest.fps || 24);
        const step = e.shiftKey ? 1 : e.altKey ? 0.1 : 1 / fps;
        setPlaying(false);
        {
          const next = clamp(playheadRef.current + dir * step, 0, total);
          tracksRef.current?.ensurePlayheadVisible(next);
          seekPlayhead(next);
        }
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "c") {
        if (modalBlocksShortcuts() || seqEditorSource || videoFrameEditor || gallerySequenceEditor || timelineFrameWorkspace) return;
        if (selectedClipIds.length === 0) return;
        e.preventDefault();
        copySelectedClips();
        return;
      }
      if (k === "v") {
        if (modalBlocksShortcuts() || seqEditorSource || videoFrameEditor || gallerySequenceEditor || timelineFrameWorkspace) return;
        if (!clipClipboardRef.current) return;
        e.preventDefault();
        pasteClips();
        return;
      }
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    undo,
    redo,
    copySelectedClips,
    pasteClips,
    selectedClipIds,
    trajectoryClipId,
    geometryEditClipId,
    textEditClipId,
    volumeEditClipId,
    aiEditOpen,
    segmentOpen,
    cameraAngleOpen,
    charPickerOpen,
    locPickerOpen,
    audioPickerOpen,
    seqPickerOpen,
    seqEditorSource,
    videoFrameEditor,
    gallerySequenceEditor,
    timelineFrameWorkspace,
    jobModalProps.open,
    manifest,
    total,
    playing,
    previewHeight,
    historyUpdate,
    seekPlayhead,
    commit,
    exitTrajectoryEdit,
  ]);

  /** Selected FLF endpoint clips (image, video, geometry), ordered by timeline start. */
  function getSelectedFlfClips(): TimelineClip[] {
    if (!manifest) return [];
    const all = manifest.tracks.flatMap((t) => t.clips);
    return selectedFlfClips(all, selectedClipIds);
  }

  function syncJunctionClipMotion(
    trackId: string,
    outgoingClipId: string,
    incomingClipId: string,
    tailSec: number = syncMotionTailSec
  ) {
    if (!manifest) return;
    const track = manifest.tracks.find((t) => t.id === trackId);
    const outgoing = track?.clips.find((c) => c.id === outgoingClipId);
    const incoming = track?.clips.find((c) => c.id === incomingClipId);
    if (!outgoing || !incoming) return;
    const fps = Math.max(1, manifest.fps || 24);
    const synced = syncMotionPair(outgoing, incoming, fps, tailSec);
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) =>
        t.id !== trackId
          ? t
          : {
              ...t,
              clips: t.clips.map((c) => {
                if (c.id === outgoing.id) return synced.outgoing;
                if (c.id === incoming.id) return synced.incoming;
                return c;
              }),
            }
      ),
    }));
  }

  function syncJunctionClipColor(
    trackId: string,
    outgoingClipId: string,
    incomingClipId: string
  ) {
    if (!manifest) return;
    const track = manifest.tracks.find((t) => t.id === trackId);
    const outgoing = track?.clips.find((c) => c.id === outgoingClipId);
    const incoming = track?.clips.find((c) => c.id === incomingClipId);
    if (!outgoing || !incoming) return;
    const sanitized = sanitizeClipColoringForSave(outgoing.coloring);
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) =>
        t.id !== trackId
          ? t
          : {
              ...t,
              clips: t.clips.map((c) => {
                if (c.id !== incoming.id) return c;
                if (sanitized) return { ...c, coloring: sanitized };
                const { coloring: _drop, ...rest } = c;
                return rest;
              }),
            }
      ),
    }));
  }

  /** Selected image-like clips (images + geometries), ordered by timeline start. */
  function selectedImageClips(): TimelineClip[] {
    if (!manifest) return [];
    const all = manifest.tracks.flatMap((t) => t.clips);
    return selectedClipIds
      .map((id) => all.find((c) => c.id === id))
      .filter((c): c is TimelineClip => !!c && clipActsAsImage(c))
      .sort((a, b) => a.start - b.start);
  }

  /** Selected video clips, ordered by timeline start. */
  function selectedVideoClips(): TimelineClip[] {
    if (!manifest) return [];
    const all = manifest.tracks.flatMap((t) => t.clips);
    return selectedClipIds
      .map((id) => all.find((c) => c.id === id))
      .filter((c): c is TimelineClip => !!c && c.type === "video")
      .sort((a, b) => a.start - b.start);
  }

  function clipVideoLabel(clip: TimelineClip): string {
    const base = clip.srcRelPath.split("/").pop();
    return base || clip.id.slice(0, 8);
  }

  function applyClipPreviewTransform(
    m: TimelineManifest,
    clipId: string,
    from: ClipTransform,
    to: ClipTransform,
    mode: "move" | "scale",
    trajOrigin: { clipId: string; waypoints: TrajectoryWaypoint[] } | null
  ): TimelineManifest {
    return {
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clipId) return c;
          if (clipHasEditableTrajectory(c)) {
            const baseClip =
              trajOrigin && trajOrigin.clipId === clipId && c.trajectory
                ? { ...c, trajectory: { ...c.trajectory, waypoints: trajOrigin.waypoints } }
                : c;
            const trajectory = applyPreviewDragToTrajectory(baseClip, from, to, mode);
            if (trajectory) return { ...c, trajectory };
          }
          return {
            ...c,
            transform: {
              ...(c.transform ?? defaultImageClipTransform()),
              x: to.x,
              y: to.y,
              scale: to.scale,
            },
          };
        }),
      })),
    };
  }

  function setClipTransformFromPreview(
    clipId: string,
    from: ClipTransform,
    to: ClipTransform,
    mode: "move" | "scale"
  ) {
    // Snapshot the drag-start waypoints once per gesture so the shift stays
    // absolute (relative to the origin), not accumulated onto already-moved ones.
    if (
      !trajDragOriginRef.current ||
      trajDragOriginRef.current.clipId !== clipId
    ) {
      const found = findClip(clipId);
      if (found?.clip.trajectory && clipHasEditableTrajectory(found.clip)) {
        trajDragOriginRef.current = {
          clipId,
          waypoints: found.clip.trajectory.waypoints,
        };
      }
    }
    updateManifest((m) =>
      applyClipPreviewTransform(m, clipId, from, to, mode, trajDragOriginRef.current)
    );
  }

  /** Insert a generated clip on a NEW video track placed above existing tracks. */
  function insertClipOnNewTrack(clip: TimelineClip, startSec: number, name: string) {
    historyUpdate((m) => {
      const track = { ...newVideoTrack(name), clips: [{ ...clip, start: startSec }] };
      return { ...m, tracks: [track, ...m.tracks] };
    });
  }

  /** Append a generated clip on an existing track at the given timeline start. */
  function insertClipOnSameTrack(clip: TimelineClip, trackId: string, startSec: number) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) =>
        t.id === trackId ? { ...t, clips: [...t.clips, { ...clip, start: startSec }] } : t
      ),
    }));
  }

  async function insertFrameFromEditorDrop(
    relPath: string,
    trackId: string,
    startSec: number
  ) {
    const imported = await apiTimelineImportImage({
      timelineKey,
      sourceRelPath: relPath,
    });
    const { width, height } = await resolveImportDimensions(
      imported.srcRelPath,
      imported.width || 0,
      imported.height || 0
    );
    const clip = buildImageClip({
      srcRelPath: imported.srcRelPath,
      width,
      height,
      start: startSec,
    });
    commit();
    insertClipOnSameTrack(clip, trackId, startSec);
    setPlaying(false);
    seekPlayhead(startSec);
    selectClip(clip.id, false);
  }

  const insertFrameFromEditorDropRef = useRef(insertFrameFromEditorDrop);
  insertFrameFromEditorDropRef.current = insertFrameFromEditorDrop;

  function handleSequenceEditorDropToTimeline(
    relPath: string,
    clientX: number,
    clientY: number
  ) {
    const hit = tracksRef.current?.dropTargetAtClientPoint(clientX, clientY);
    if (!hit) return;
    void insertFrameFromEditorDropRef
      .current(relPath, hit.trackId, hit.startSec)
      .catch((e) => showError({ message: "Could not add frame to timeline.", error: e }));
  }

  const onStripFrameDragMove = useCallback((ev: DragMoveEvent) => {
    const activeData = ev.active.data.current as { kind?: string } | undefined;
    if (activeData?.kind !== "frameSeqStripSlot") return;
    const start = ev.activatorEvent;
    if (!(start instanceof PointerEvent)) return;
    stripDragPointerRef.current = {
      x: start.clientX + ev.delta.x,
      y: start.clientY + ev.delta.y,
    };
  }, []);

  const onStripFrameDragEnd = useCallback((ev: DragEndEvent) => {
    setStripDragPreviewPath(null);
    const activeData = ev.active.data.current as
      | { kind?: string; relPath?: string }
      | undefined;
    if (activeData?.kind !== "frameSeqStripSlot" || !activeData.relPath?.trim()) {
      stripDragPointerRef.current = null;
      return;
    }
    const overId = ev.over?.id != null ? String(ev.over.id) : "";
    if (!overId.startsWith(TIMELINE_STRIP_FRAME_DROP_PREFIX)) {
      stripDragPointerRef.current = null;
      if (overId) {
        showError({
          message: "Drop the frame on a timeline track.",
          error: new Error(`Unexpected drop target: ${overId}`),
        });
      }
      return;
    }
    const fromData = (ev.over?.data.current as { trackId?: string } | undefined)?.trackId;
    const trackId = (fromData?.trim() || overId.slice(TIMELINE_STRIP_FRAME_DROP_PREFIX.length)).trim();
    if (!trackId) {
      stripDragPointerRef.current = null;
      showError({
        message: "Could not resolve timeline track for drop.",
        error: new Error(`Missing trackId for over.id=${overId}`),
      });
      return;
    }
    const ptr = stripDragPointerRef.current;
    stripDragPointerRef.current = null;
    const startSec = ptr
      ? clamp(tracksRef.current?.timeAtClientX(ptr.x) ?? playheadRef.current, 0, Infinity)
      : playheadRef.current;
    void insertFrameFromEditorDropRef
      .current(activeData.relPath.trim(), trackId, startSec)
      .catch((e) => showError({ message: "Could not add frame to timeline.", error: e }));
  }, [showError]);

  async function openAiEdit(clipId: string) {
    const found = findClip(clipId);
    if (!found || !clipActsAsImage(found.clip)) return;
    aiEditTargetRef.current = {
      clipId,
      start: found.clip.start,
    };
    if (found.clip.type === "image") {
      setAiEditImageSrc(assetUrlFromRelPath(found.clip.srcRelPath));
    } else if (found.clip.geometry) {
      const b64 = await rasterizeGeometryToPngBase64(found.clip.geometry);
      setAiEditImageSrc(`data:image/png;base64,${b64}`);
    }
    setAiEditOpen(true);
  }

  function openSegment(clipId: string) {
    const found = findClip(clipId);
    if (!found) return;
    const c = found.clip;
    if (c.type !== "image" && c.type !== "video") return;
    const localTimeSec = Math.max(0, playheadRef.current - c.start);
    const inPoint = c.inPoint ?? 0;
    const speed = c.speed && c.speed > 0 ? c.speed : 1;
    const sourceSeekSec = inPoint + localTimeSec * speed;
    segmentTargetRef.current = {
      clipId,
      srcRelPath: c.srcRelPath,
      type: c.type,
      start: c.start,
      inPoint,
      speed,
      localTimeSec,
    };
    setSegmentClipType(c.type);
    setSegmentMediaSrc(assetUrlFromRelPath(c.srcRelPath));
    setSegmentVideoSeekSec(sourceSeekSec);
    setSegmentOpen(true);
    setClipMenu((s) => ({ ...s, open: false }));
  }

  const onSegmentPreview = useCallback(
    async (
      positive: Sam3Point[],
      negative: Sam3Point[],
      textPrompt?: string,
      sam3Options?: Sam3SegmentOptions
    ): Promise<string | null> => {
      const tgt = segmentTargetRef.current;
      if (!tgt || !timelineKey) return null;
      const done = await runTimelineSegmentPreviewWsJob({
        timelineKey,
        clipRelPath: tgt.srcRelPath,
        clipType: tgt.type,
        positiveCoords: positive,
        negativeCoords: negative,
        textPrompt,
        sam3Options,
        inPointSec: tgt.inPoint,
        localTimeSec: tgt.localTimeSec,
        speed: tgt.speed,
        onLogLine: () => {},
      });
      if (!done.ok) throw new Error(done.error || "Segment preview failed.");
      return done.result?.maskPngBase64 ?? null;
    },
    [timelineKey]
  );

  async function runSegmentSave(
    positive: Sam3Point[],
    negative: Sam3Point[],
    textPrompt?: string,
    sam3Options?: Sam3SegmentOptions
  ) {
    const tgt = segmentTargetRef.current;
    setSegmentOpen(false);
    segmentTargetRef.current = null;
    if (!tgt || !timelineKey) return;
    beginSession({ title: "Segmenting", clearLog: true });
    await Promise.resolve();
    pushLog("Running SAM 3.1 segmentation…");
    try {
      const done = await runTimelineSegmentWsJob({
        timelineKey,
        clipRelPath: tgt.srcRelPath,
        clipType: tgt.type,
        positiveCoords: positive,
        negativeCoords: negative,
        textPrompt,
        sam3Options,
        inPointSec: tgt.inPoint,
        localTimeSec: tgt.localTimeSec,
        speed: tgt.speed,
        onLogLine: (line) => pushLog(line),
      });
      const r = done.result;
      if (!done.ok || !r?.srcRelPath) {
        throw new Error(done.error || "Segment returned no clip.");
      }
      if (r.type === "video") {
        const dur = r.durationSec || 5;
        insertClipOnNewTrack(
          {
            id: genId("clip"),
            type: "video",
            srcRelPath: r.srcRelPath,
            start: 0,
            inPoint: 0,
            outPoint: dur,
            speed: 1,
            duration: dur,
            srcDuration: dur,
            naturalW: r.width || undefined,
            naturalH: r.height || undefined,
          },
          tgt.start,
          "Segment"
        );
      } else {
        const { width, height } = await resolveImportDimensions(
          r.srcRelPath,
          r.width || 0,
          r.height || 0
        );
        insertClipOnNewTrack(
          buildImageClip({
            srcRelPath: r.srcRelPath,
            width,
            height,
          }),
          tgt.start,
          "Segment"
        );
      }
      endSession();
    } catch (e) {
      failSession(e, "Segment failed.");
    }
  }

  async function runAiEdit(prompt: string, maskPngBase64?: string) {
    setAiEditOpen(false);
    const tgt = aiEditTargetRef.current;
    aiEditTargetRef.current = null;
    if (!tgt) return;
    const found = findClip(tgt.clipId);
    if (!found) return;
    beginSession({ title: "AI editing", clearLog: true });
    await Promise.resolve();
    pushLog("AI editing image…");
    try {
      const imageRelPath = await resolveClipImageRelPath(timelineKey, found.clip);
      const done = await runTimelineAiEditWsJob({
        timelineKey,
        imageRelPath,
        prompt,
        maskPngBase64,
        onLogLine: (line) => pushLog(line),
      });
      const r = done.result;
      if (!done.ok || !r?.srcRelPath) throw new Error(done.error || "AI edit returned no image.");
      const { width, height } = await resolveImportDimensions(
        r.srcRelPath,
        r.width || 0,
        r.height || 0
      );
      insertClipOnNewTrack(
        buildImageClip({
          srcRelPath: r.srcRelPath,
          width,
          height,
        }),
        tgt.start,
        "AI Edit"
      );
      endSession();
    } catch (e) {
      failSession(e, "AI edit failed.");
    }
  }

  async function runI2v(clipId: string, prompt: string, length: number) {
    const found = findClip(clipId);
    if (!found || !clipActsAsImage(found.clip)) return;
    if (!prompt.trim()) return;
    const start = found.clip.start;
    beginSession({ title: "Generating video (I2V)", clearLog: true });
    await Promise.resolve();
    pushLog("Rasterizing source…");
    try {
      const src = await resolveClipImageRelPath(timelineKey, found.clip);
      pushLog("Generating image-to-video…");
      const done = await runTimelineI2vWsJob({
        timelineKey,
        imageRelPath: src,
        prompt: prompt.trim(),
        length,
        onLogLine: (line) => pushLog(line),
      });
      const r = done.result;
      if (!done.ok || !r?.srcRelPath) throw new Error(done.error || "I2V returned no clip.");
      const dur = r.durationSec || 5;
      insertClipOnNewTrack(
        {
          id: genId("clip"),
          type: "video",
          srcRelPath: r.srcRelPath,
          start: 0,
          inPoint: 0,
          outPoint: dur,
          speed: 1,
          duration: dur,
          srcDuration: dur,
          naturalW: r.width || undefined,
          naturalH: r.height || undefined,
        },
        start,
        "I2V"
      );
      endSession();
    } catch (e) {
      failSession(e, "I2V failed.");
    }
  }

  async function runFlf(clipIdA: string, clipIdB: string, length: number) {
    const a = findClip(clipIdA);
    const b = findClip(clipIdB);
    if (!a || !b) return;
    const ordered = [a.clip, b.clip].sort((x, y) => x.start - y.start);
    const [earlier, later] = ordered;
    beginSession({ title: "Generating video (FLF)", clearLog: true });
    await Promise.resolve();
    pushLog(
      `Resolving FLF endpoints: ${flfEndpointLabel(earlier, "start")} → ${flfEndpointLabel(later, "end")}…`
    );
    try {
      const [relA, relB] = await Promise.all([
        resolveFlfEndpoint(timelineKey, earlier, "start", pushLog),
        resolveFlfEndpoint(timelineKey, later, "end", pushLog),
      ]);
      pushLog("Generating first-last-frame video…");
      const done = await runTimelineFlfWsJob({
        timelineKey,
        imageRelPathA: relA,
        imageRelPathB: relB,
        length,
        onLogLine: (line) => pushLog(line),
      });
      const r = done.result;
      if (!done.ok || !r?.srcRelPath) throw new Error(done.error || "FLF returned no clip.");
      const dur = r.durationSec || 5;
      insertClipOnNewTrack(
        {
          id: genId("clip"),
          type: "video",
          srcRelPath: r.srcRelPath,
          start: 0,
          inPoint: 0,
          outPoint: dur,
          speed: 1,
          duration: dur,
          srcDuration: dur,
          naturalW: r.width || undefined,
          naturalH: r.height || undefined,
        },
        earlier.start,
        "FLF"
      );
      endSession();
    } catch (e) {
      failSession(e, "FLF failed.");
    }
  }

  function syncVideoFrameTrimHiddenInManifest(
    m: TimelineManifest,
    clipIds: string[]
  ): TimelineManifest {
    const fps = Math.max(1, m.fps ?? 24);
    const idSet = new Set(clipIds);
    return {
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (!idSet.has(c.id) || !c.frameSequence?.strip?.length) return c;
          const synced = syncTrimHiddenToFrameSequence(
            c.frameSequence,
            { inPoint: c.inPoint ?? 0, outPoint: c.outPoint ?? 0 },
            c.frameEdit,
            fps
          );
          if (frameSequencePayloadEqual(synced, c.frameSequence)) return c;
          return { ...c, frameSequence: synced };
        }),
      })),
    };
  }

  function updateClipFrameSequence(
    clipId: string,
    patch: {
      frameSequence?: FrameSequencePayload;
      sequenceGallery?: SequenceGalleryItem[];
      frameEdit?: TimelineFrameEdit;
    }
  ) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId
            ? {
                ...c,
                ...(patch.frameSequence !== undefined
                  ? { frameSequence: patch.frameSequence }
                  : {}),
                ...(patch.sequenceGallery !== undefined
                  ? { sequenceGallery: patch.sequenceGallery }
                  : {}),
                ...(patch.frameEdit ? { frameEdit: patch.frameEdit } : {}),
              }
            : c
        ),
      })),
    }));
  }

  async function duplicateClipFrameAsset(clipId: string, sourceRelPath: string) {
    const r = await apiTimelineDuplicateFrameAsset({
      timelineKey,
      clipId,
      sourceRelPath,
    });
    return r.relPath;
  }

  /** Seed staging gallery from strip when missing (extract / migrate). */
  async function ensureSequenceGalleriesSeeded(clipIds: string[]) {
    const needs: Array<{ clipId: string; strip: FrameSequencePayload }> = [];
    for (const clipId of clipIds) {
      const found = findClip(clipId);
      const strip = found?.clip.frameSequence;
      if (!strip?.strip?.length) continue;
      if (found!.clip.sequenceGallery?.length) continue;
      needs.push({ clipId, strip });
    }
    if (!needs.length) return;
    const seeded = await Promise.all(
      needs.map(async ({ clipId, strip }) => ({
        clipId,
        gallery: await seedSequenceGalleryFromStrip(strip, (sourceRelPath) =>
          duplicateClipFrameAsset(clipId, sourceRelPath)
        ),
      }))
    );
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          const row = seeded.find((s) => s.clipId === c.id);
          if (!row?.gallery.length) return c;
          return { ...c, sequenceGallery: row.gallery };
        }),
      })),
    }));
  }

  async function extractVideoFramesForClip(clipId: string, trackId?: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "video") return false;
    const clip = found.clip;
    pushLog(`Decoding video frames: ${clipVideoLabel(clip)}…`);
    const done = await runTimelineVideoFramesExtractWsJob({
      timelineKey,
      clipId,
      videoRelPath: clip.srcRelPath,
      inPoint: clip.inPoint,
      outPoint: clip.outPoint,
      ...(clip.alphaRelPath ? { alphaRelPath: clip.alphaRelPath } : {}),
      onLogLine: (line) => pushLog(line),
    });
    if (!done.ok || !done.result?.frameSequence) {
      throw new Error(done.error || "Frame extraction returned no strip.");
    }
    const fps = Math.max(1, manifest?.fps ?? 24);
    const frameEdit = done.result.frameEdit;
    const synced = syncTrimHiddenToFrameSequence(
      done.result.frameSequence,
      { inPoint: clip.inPoint ?? 0, outPoint: clip.outPoint ?? 0 },
      frameEdit,
      fps
    );
    const gallery = await seedSequenceGalleryFromStrip(synced, (sourceRelPath) =>
      duplicateClipFrameAsset(clipId, sourceRelPath)
    );
    updateClipFrameSequence(clipId, {
      frameSequence: synced,
      ...(gallery.length ? { sequenceGallery: gallery } : {}),
      frameEdit: {
        ...frameEdit,
        ...(clip.frameEdit?.timelineViewStep === 2 ? { timelineViewStep: 2 as const } : {}),
      },
    });
    if (trackId) {
      setVideoFrameEditor({
        clipIds: [clipId],
        primaryClipId: clipId,
        primaryTrackId: trackId,
      });
    }
    return true;
  }

  async function ensureVideoFramesExtracted(clipIds: string[]): Promise<boolean> {
    const missing = clipIds.filter((id) => {
      const found = findClip(id);
      return !found?.clip.frameSequence?.strip?.length;
    });
    if (!missing.length) return true;
    beginSession({ title: "Extracting video frames", clearLog: true });
    await Promise.resolve();
    try {
      await Promise.all(missing.map((clipId) => extractVideoFramesForClip(clipId)));
      endSession();
      return true;
    } catch (e) {
      failSession(e, "Could not extract video frames.");
      return false;
    }
  }

  async function openVideoFrameEditor(clipId: string, trackId: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "video") return;

    // If the clip originated from a character sequence, open the full SequenceEditor.
    // Also check frameSequence strip paths as a fallback for clips created by the old
    // "New track" apply path that didn't copy source metadata.
    const src = found.clip.source;
    const charInfoFromStrip = (): { charKey: string; sequenceName: string } | null => {
      const relPath = found.clip.frameSequence?.strip.find(
        (s) => s.kind === "image" && s.relPath
      )?.relPath;
      if (!relPath) return null;
      const m = relPath.match(/^characters\/([^/]+)\/sequence\/([^/]+)\//);
      if (!m) return null;
      return { charKey: m[1]!, sequenceName: m[2]! };
    };
    const charInfo =
      src?.charKey && src?.sequenceName
        ? { charKey: src.charKey, sequenceName: src.sequenceName }
        : charInfoFromStrip();
    // Alpha clips: extract RGBA cutouts from the RMBG video instead of the
    // opaque character gallery strip (SequenceEditor).
    const hasAlpha = Boolean(found.clip.alphaRelPath?.trim());
    if (charInfo && !hasAlpha) {
      const galleryItemId = src?.galleryItemId?.trim() || undefined;
      let gallerySnapshot: FrameSequencePayload | undefined;
      if (galleryItemId) {
        try {
          const seqManifest = await apiSequenceGet(charInfo.charKey, charInfo.sequenceName);
          const item = seqManifest.gallery?.find((g) => g.id === galleryItemId);
          if (item?.frameSequence) {
            gallerySnapshot = cloneFrameSequencePayload(item.frameSequence);
          }
        } catch {
          /* snapshot optional — close will rematerialize */
        }
      }
      setSeqEditorSource({
        ...charInfo,
        linkedClipId: clipId,
        ...(galleryItemId ? { galleryItemId } : {}),
        ...(gallerySnapshot ? { gallerySnapshot } : {}),
      });
      return;
    }

    const selected = selectedVideoClips();
    const clipIds =
      selected.length >= 2 && selected.some((c) => c.id === clipId)
        ? selected.map((c) => c.id)
        : [clipId];
    const ok = await ensureVideoFramesExtracted(clipIds);
    if (!ok) return;
    historyUpdate((m) => syncVideoFrameTrimHiddenInManifest(m, clipIds));
    await ensureSequenceGalleriesSeeded(clipIds);
    const snapshots: Record<string, FrameSequencePayload> = {};
    for (const id of clipIds) {
      const fs = findClip(id)?.clip.frameSequence;
      if (fs?.strip?.length) {
        snapshots[id] = cloneFrameSequencePayload(fs);
      }
    }
    workspaceStripSnapshotRef.current = snapshots;
    setTimelineFrameWorkspace({
      clipIds,
      primaryClipId: clipId,
      primaryTrackId: trackId,
    });
  }

  /** Rematerialize a timeline clip from its linked character sequence gallery set. */
  async function rematerializeClipFromSequenceSource(clipId: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "video") return;
    const src = found.clip.source;
    const charKey = src?.charKey?.trim();
    const sequenceName = src?.sequenceName?.trim();
    const galleryItemId = src?.galleryItemId?.trim();
    if (!charKey || !sequenceName) return;

    const hadAlpha = Boolean(found.clip.alphaRelPath?.trim());
    beginSession({ title: "Updating clip from sequence set", clearLog: true });
    await Promise.resolve();
    try {
      pushLog(`Materializing ${sequenceName}${galleryItemId ? ` / ${galleryItemId}` : ""}…`);
      const done = await runTimelineImportSequenceWsJob({
        timelineKey,
        charKey,
        sequenceName,
        galleryItemId,
        onLogLine: (line) => pushLog(line),
      });
      const r = done.result;
      if (!done.ok || !r?.srcRelPath) {
        throw new Error(done.error || "Import returned no clip.");
      }

      let srcRelPath = r.srcRelPath;
      let alphaRelPath = r.alphaRelPath;
      let durationSec = r.durationSec || 0;
      let width = r.width || 0;
      let height = r.height || 0;

      if (hadAlpha && !alphaRelPath) {
        pushLog("Re-applying background removal…");
        const rmbg = await runTimelineVideoRemoveBgRmbgWsJob({
          timelineKey,
          videoRelPath: srcRelPath,
          onLogLine: (line) => pushLog(line),
        });
        if (rmbg.ok && rmbg.result?.srcRelPath) {
          srcRelPath = rmbg.result.srcRelPath;
          alphaRelPath = rmbg.result.alphaRelPath;
          durationSec = rmbg.result.durationSec || durationSec;
          width = rmbg.result.width || width;
          height = rmbg.result.height || height;
        } else {
          pushLog(
            rmbg.error ||
              "Background removal failed — applying opaque sequence video."
          );
        }
      }

      const dur = durationSec > 0 ? durationSec : found.clip.srcDuration || found.clip.duration;
      let nextManifest: TimelineManifest | null = null;
      historyUpdate((m) => {
        nextManifest = {
          ...m,
          tracks: m.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => {
              if (c.id !== clipId) return c;
              const speed = Math.max(0.01, c.speed || 1);
              const {
                alphaRelPath: _a,
                proxyRelPath: _p,
                proxyAlphaRelPath: _pa,
                ...rest
              } = c;
              return {
                ...rest,
                srcRelPath,
                ...(alphaRelPath ? { alphaRelPath } : {}),
                inPoint: 0,
                outPoint: dur,
                srcDuration: dur,
                duration: dur / speed,
                ...(width ? { naturalW: width } : {}),
                ...(height ? { naturalH: height } : {}),
              };
            }),
          })),
        };
        return nextManifest;
      });
      if (nextManifest) {
        try {
          await apiTimelinePut(timelineKey, nextManifest);
        } catch {
          /* autosave will retry */
        }
      }
      try {
        const proxyRes = await apiTimelineEnsureProxies(timelineKey);
        if (proxyRes.manifest) {
          const proxies = new Map(
            proxyRes.manifest.tracks
              .flatMap((t) => t.clips)
              .map((c) => [
                c.id,
                {
                  proxyRelPath: c.proxyRelPath,
                  proxyAlphaRelPath: c.proxyAlphaRelPath,
                },
              ])
          );
          historyUpdate((m) => ({
            ...m,
            tracks: m.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => {
                const p = proxies.get(c.id);
                if (!p?.proxyRelPath) return c;
                return {
                  ...c,
                  proxyRelPath: p.proxyRelPath,
                  ...(p.proxyAlphaRelPath
                    ? { proxyAlphaRelPath: p.proxyAlphaRelPath }
                    : { proxyAlphaRelPath: undefined }),
                };
              }),
            })),
          }));
        }
      } catch {
        /* proxy ensure best-effort */
      }
      endSession();
    } catch (e) {
      failSession(e, "Could not update clip from sequence set.");
    }
  }

  async function closeSeqEditorFromTimeline() {
    const src = seqEditorSource;
    setSeqExternalDrag(false);
    setSeqEditorSource(null);
    if (!src?.linkedClipId) return;

    const galleryItemId = src.galleryItemId;
    if (src.gallerySnapshot && galleryItemId) {
      try {
        const seqManifest = await apiSequenceGet(src.charKey, src.sequenceName);
        const item = seqManifest.gallery?.find((g) => g.id === galleryItemId);
        if (
          planLinkedSequenceClipClose(item?.frameSequence, src.gallerySnapshot).kind ===
          "noop"
        ) {
          return;
        }
      } catch {
        /* fall through to rematerialize */
      }
    }
    await rematerializeClipFromSequenceSource(src.linkedClipId);
  }

  /** Close workspace; re-encode any clip whose strip changed while editing. */
  function closeTimelineFrameWorkspace() {
    const workspace = timelineFrameWorkspace;
    const snapshots = workspaceStripSnapshotRef.current;
    workspaceStripSnapshotRef.current = null;
    setTimelineFrameWorkspace(null);
    setVideoFrameEditor(null);
    setGallerySequenceEditor(null);
    if (!workspace || !snapshots) return;

    const payloads: Record<string, FrameSequencePayload> = {};
    for (const clipId of workspace.clipIds) {
      const current = findClip(clipId)?.clip.frameSequence;
      if (current?.strip?.length) payloads[clipId] = current;
    }
    const plan = planTimelineFrameSequenceGroupFinish(payloads, snapshots);
    if (plan.kind === "noop" || Object.keys(plan.applyPayloads).length === 0) return;

    videoFrameApplyGroupRef.current = plan.applyPayloads;
    videoFrameApplyStripRef.current = null;
    videoFrameApplyEditorRef.current = {
      clipIds: workspace.clipIds,
      primaryClipId: workspace.primaryClipId,
      primaryTrackId: workspace.primaryTrackId,
    };
    void applyVideoFrameStrip("replace");
  }

  function openTimelineFrameStripFromWorkspace(clipId: string) {
    const workspace = timelineFrameWorkspace;
    if (!workspace) return;
    const clipIds = workspace.clipIds.includes(clipId) ? workspace.clipIds : [clipId];
    setGallerySequenceEditor(null);
    setVideoFrameEditor({
      clipIds,
      primaryClipId: clipId,
      primaryTrackId: workspace.primaryTrackId,
    });
  }

  function openGallerySequenceFromWorkspace(clipId: string, galleryItemId: string) {
    setVideoFrameEditor(null);
    setGallerySequenceEditor({ clipId, galleryItemId });
  }

  function saveGallerySequenceStrip(next: FrameSequencePayload) {
    if (!gallerySequenceEditor) return;
    const { clipId, galleryItemId } = gallerySequenceEditor;
    const found = findClip(clipId);
    const gallery = found?.clip.sequenceGallery;
    if (!gallery?.length) return;
    const current = gallery.find((item) => item.id === galleryItemId)?.frameSequence;
    if (current && frameSequencePayloadEqual(next, current)) return;
    const thumb =
      next.strip.find((s) => s.kind === "image" && s.relPath?.trim())?.relPath?.trim() ?? null;
    updateClipFrameSequence(clipId, {
      sequenceGallery: gallery.map((item) =>
        item.id === galleryItemId
          ? {
              ...item,
              ...(thumb ? { relPath: thumb } : {}),
              frameSequence: next,
            }
          : item
      ),
      frameSequence: next,
    });
  }

  /** Encode/replace clip video from a finished gallery sequence. */
  function applyGallerySequenceToClipVideo(next: FrameSequencePayload) {
    if (!gallerySequenceEditor) return;
    if (!frameSequenceHasExportableFrames(next)) return;
    const { clipId } = gallerySequenceEditor;
    const found = findClip(clipId);
    if (!found || found.clip.type !== "video") return;
    videoFrameApplyStripRef.current = next;
    videoFrameApplyGroupRef.current = null;
    videoFrameApplyEditorRef.current = {
      clipIds: [clipId],
      primaryClipId: clipId,
      primaryTrackId: found.trackId,
    };
    void applyVideoFrameStrip("replace");
  }

  async function downloadVideoClip(clipId: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "video" || !found.clip.srcRelPath) return;
    const clip = found.clip;
    const baseName = sanitizeDownloadBaseName(clipVideoLabel(clip)) || "clip";

    if (clip.frameSequence) {
      beginSession({ title: "Downloading clip", clearLog: true });
      await Promise.resolve();
      try {
        pushLog("Encoding edited frames…");
        const done = await runTimelineVideoFramesEncodeWsJob({
          timelineKey,
          frameSequence: clip.frameSequence,
          fps: manifest?.fps,
          outputBasename: baseName,
          onLogLine: (line) => pushLog(line),
        });
        if (!done.ok || !done.result?.srcRelPath) throw new Error(done.error || "Encoding failed.");
        pushLog("Download starting…");
        endSession();
        const a = document.createElement("a");
        a.href = assetDownloadUrlFromRelPath(done.result.srcRelPath);
        a.download = `${baseName}.mp4`;
        a.click();
      } catch (e) {
        failSession(e, "Clip download failed.");
      }
    } else {
      const a = document.createElement("a");
      a.href = assetDownloadUrlFromRelPath(clip.srcRelPath);
      a.download = baseName;
      a.click();
    }
  }

  async function reExtractVideoFrames() {
    if (!videoFrameEditor) return;
    const { clipIds } = videoFrameEditor;
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          clipIds.includes(c.id)
            ? {
                ...c,
                frameSequence: undefined,
                frameEdit: undefined,
                sequenceGallery: undefined,
              }
            : c
        ),
      })),
    }));
    beginSession({ title: "Re-extracting video frames", clearLog: true });
    await Promise.resolve();
    try {
      for (const clipId of clipIds) {
        const ok = await extractVideoFramesForClip(clipId);
        if (!ok) throw new Error("Frame extraction failed.");
      }
      endSession();
    } catch (e) {
      failSession(e, "Could not re-extract video frames.");
    }
  }

  function saveVideoFrameStrip(next: FrameSequencePayload) {
    if (!videoFrameEditor) return;
    updateClipFrameSequence(videoFrameEditor.primaryClipId, { frameSequence: next });
  }

  function saveVideoFrameGroup(payloads: Record<string, FrameSequencePayload>) {
    if (!videoFrameEditor) return;
    historyUpdate((m) => applyFrameSequencePayloads(m, payloads));
  }

  function promptVideoFrameApply(strip: FrameSequencePayload) {
    if (!frameSequenceHasExportableFrames(strip)) return;
    videoFrameApplyStripRef.current = strip;
    videoFrameApplyGroupRef.current = null;
    videoFrameApplyEditorRef.current = videoFrameEditor;
    void applyVideoFrameStrip("replace");
  }

  function promptVideoFrameApplyGroup(payloads: Record<string, FrameSequencePayload>) {
    const exportable = Object.fromEntries(
      Object.entries(payloads).filter(([, strip]) => frameSequenceHasExportableFrames(strip))
    );
    if (Object.keys(exportable).length === 0) return;
    videoFrameApplyGroupRef.current = exportable;
    videoFrameApplyStripRef.current = null;
    videoFrameApplyEditorRef.current = videoFrameEditor;
    void applyVideoFrameStrip("replace");
  }

  async function applyVideoFrameStrip(mode: "replace" | "new_track") {
    const editor = videoFrameEditor ?? videoFrameApplyEditorRef.current;
    if (!editor || !manifest) return;
    const strip = videoFrameApplyStripRef.current;
    const groupPayloads = videoFrameApplyGroupRef.current;
    videoFrameApplyStripRef.current = null;
    videoFrameApplyGroupRef.current = null;
    videoFrameApplyEditorRef.current = null;

    const encodeJobs: Array<{ clipId: string; strip: FrameSequencePayload }> = [];
    if (groupPayloads) {
      for (const clipId of Object.keys(groupPayloads)) {
        const s = groupPayloads[clipId];
        if (s && frameSequenceHasExportableFrames(s)) encodeJobs.push({ clipId, strip: s });
      }
    } else if (strip && frameSequenceHasExportableFrames(strip)) {
      encodeJobs.push({ clipId: editor.primaryClipId, strip });
    }
    if (!encodeJobs.length) return;

    beginSession({ title: "Encoding video from frames", clearLog: true });
    await Promise.resolve();
    try {
      const encoded: Array<{
        clipId: string;
        strip: FrameSequencePayload;
        sourceClip: TimelineClip;
        srcRelPath: string;
        alphaRelPath?: string;
        durationSec: number;
        width?: number;
        height?: number;
      }> = [];
      for (const { clipId, strip: jobStrip } of encodeJobs) {
        const found = findClip(clipId);
        if (!found || found.clip.type !== "video") continue;
        pushLog(`Encoding frame sequence: ${clipVideoLabel(found.clip)}…`);
        const done = await runTimelineVideoFramesEncodeWsJob({
          timelineKey,
          frameSequence: jobStrip,
          fps: manifest.fps,
          onLogLine: (line) => pushLog(line),
        });
        const r = done.result;
        if (!done.ok || !r?.srcRelPath) {
          throw new Error(done.error || "Encode returned no clip.");
        }
        encoded.push({
          clipId,
          strip: jobStrip,
          sourceClip: found.clip,
          srcRelPath: r.srcRelPath,
          ...(r.alphaRelPath ? { alphaRelPath: r.alphaRelPath } : {}),
          durationSec: r.durationSec || found.clip.duration,
          width: r.width || undefined,
          height: r.height || undefined,
        });
      }

      if (mode === "replace") {
        historyUpdate((m) => applyEncodedFrameSequenceReplacements(m, encoded));
      } else {
        const newTracks = encoded.map((item) => ({
          ...newVideoTrack("Edited frames"),
          clips: [
            {
              id: genId("clip"),
              type: "video" as const,
              srcRelPath: item.srcRelPath,
              ...(item.alphaRelPath ? { alphaRelPath: item.alphaRelPath } : {}),
              start: item.sourceClip.start,
              inPoint: 0,
              outPoint: item.durationSec,
              speed: 1,
              duration: item.durationSec,
              srcDuration: item.durationSec,
              naturalW: item.width,
              naturalH: item.height,
              frameSequence: item.strip,
              frameEdit: {
                framesDirRel: item.sourceClip.frameEdit?.framesDirRel ?? "",
                extractInPointSec: 0,
                extractFps: manifest.fps,
                mp4Aligned: true,
              },
            },
          ],
        }));
        historyUpdate((m) => ({ ...m, tracks: [...newTracks.reverse(), ...m.tracks] }));
      }
      endSession();
      setVideoFrameEditor(null);
      setTimelineFrameWorkspace(null);
    } catch (e) {
      failSession(e, "Could not encode video from frames.");
    }
  }

  function getVideoFrameStripActions(clipId: string): FrameSequenceStripActions | undefined {
    if (!videoFrameEditor) return undefined;
    const found = findClip(clipId);
    const framesDirRel = found?.clip.frameEdit?.framesDirRel ?? "";
    return {
      busy,
      onRemoveBackground: async (relPaths) => {
        return new Promise<string[]>((resolve, reject) => {
          removeBgImagePendingRef.current = {
            relPaths,
            inPlace: true,
            stripResolve: resolve,
            stripReject: reject,
          };
          setRemoveBgImageOpen(true);
        });
      },
      onAiEdit: (relPath) =>
        new Promise<string>((resolve) => {
          stripAiEditResolveRef.current = resolve;
          stripAiEditRelRef.current = relPath;
          setStripAiEditImageSrc(assetUrlFromRelPath(relPath));
          setStripAiEditOpen(true);
        }),
      onGenerateI2v: async (relPath, prompt, length) => {
        if (!framesDirRel) throw new Error("Missing frames directory.");
        beginSession({ title: "Generating strip I2V", clearLog: true });
        await Promise.resolve();
        try {
          const done = await runTimelineStripI2vWsJob({
            timelineKey,
            imageRelPath: relPath,
            outputDirRel: framesDirRel,
            prompt,
            length,
            onLogLine: (line) => pushLog(line),
          });
          if (!done.ok || !done.result?.relPaths?.length) {
            throw new Error(done.error || "Strip I2V failed.");
          }
          endSession();
          return done.result.relPaths;
        } catch (e) {
          failSession(e, "Strip I2V failed.");
          throw e;
        }
      },
      onGenerateFlf: async (relPathA, relPathB, length) => {
        if (!framesDirRel) throw new Error("Missing frames directory.");
        beginSession({ title: "Generating strip FLF", clearLog: true });
        await Promise.resolve();
        try {
          const done = await runTimelineStripFlfWsJob({
            timelineKey,
            imageRelPathA: relPathA,
            imageRelPathB: relPathB,
            outputDirRel: framesDirRel,
            length,
            onLogLine: (line) => pushLog(line),
          });
          if (!done.ok || !done.result?.relPaths?.length) {
            throw new Error(done.error || "Strip FLF failed.");
          }
          endSession();
          return done.result.relPaths;
        } catch (e) {
          failSession(e, "Strip FLF failed.");
          throw e;
        }
      },
    };
  }

  const videoFrameStripActions = useMemo(
    (): FrameSequenceStripActions | undefined =>
      videoFrameEditor ? getVideoFrameStripActions(videoFrameEditor.primaryClipId) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoFrameEditor, busy, manifest, timelineKey]
  );

  async function runStripAiEdit(promptText: string, maskPngBase64?: string) {
    const resolve = stripAiEditResolveRef.current;
    const imageRelPath = stripAiEditRelRef.current;
    stripAiEditResolveRef.current = null;
    stripAiEditRelRef.current = null;
    setStripAiEditOpen(false);
    if (!resolve || !imageRelPath) return;
    beginSession({ title: "AI Editing frame", clearLog: true });
    await Promise.resolve();
    try {
      const done = await runTimelineAiEditWsJob({
        timelineKey,
        imageRelPath,
        prompt: promptText,
        maskPngBase64,
        inPlace: true,
        onLogLine: (line) => pushLog(line),
      });
      const nextRel = done.result?.srcRelPath;
      if (!done.ok || !nextRel) throw new Error(done.error || "AI edit failed.");
      endSession();
      resolve(nextRel);
    } catch (e) {
      failSession(e, "AI edit failed.");
      throw e;
    }
  }

  // ---- Context menu item builders -----------------------------------------
  const clipMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!clipMenu.open) return [];
    const rc = findClip(clipMenu.clipId);
    const isImage = rc?.clip.type === "image";
    const isRaster = rc?.clip ? clipActsAsImage(rc.clip) : false;
    const isCharImage = isImage && Boolean(rc?.clip.source?.charKey);
    const twoFlfSelected = getSelectedFlfClips().length === 2;
    const pair = getOverlappingCharBgPair();
    const isVideo = rc?.clip.type === "video";
    const isGeometry = rc?.clip.type === "geometry";
    const isText = rc?.clip.type === "text";
    const isAudio = rc?.clip.type === "audio";

    const items: ContextMenuItem[] = [];

    // 1. Split at playhead (always)
    items.push({
      key: "split",
      label: "Split at playhead",
      onSelect: () => splitClipAtPlayhead(clipMenu.trackId, clipMenu.clipId),
    });

    if (pair) {
      items.push(
        {
          key: "combineAI",
          label: "Combine Images (AI I2I)",
          disabled: busy,
          onSelect: () => void runJointGenerate("i2i"),
        },
        {
          key: "combineManual",
          label: "Combine Images (Manual)",
          disabled: busy,
          onSelect: () => void runJointGenerate("as_is"),
        }
      );
    }

    // 2. Speed (video or audio)
    if (isVideo || isAudio) {
      items.push({
        key: "speed",
        label: "Speed",
        keepOpenOnSelect: true,
        submenu: (
          <ClipSpeedFlyout
            speed={rc?.clip.speed ?? 1}
            reversed={rc?.clip.reversed ?? false}
            onSpeedChange={(speed) => updateClipSpeedLive(clipMenu.clipId, speed)}
            onSpeedCommit={() => updateClipSpeedCommit(clipMenu.clipId)}
            onInvertChange={(reversed) =>
              updateClipReverseLive(clipMenu.clipId, reversed)
            }
          />
        ),
      });
    }

    // Audio: Adjust Volume + Transition (after Speed)
    if (isAudio) {
      items.push({
        key: "adjustVolume",
        label: volumeEditClipId === clipMenu.clipId ? "Exit Volume Edit" : "Adjust Volume",
        onSelect: () => {
          const clip = rc!.clip;
          if (!clip.volumeAutomation) {
            updateClipVolumeAutomation(clip.id, {
              points: defaultVolumeAutomationPoints(),
            });
          }
          setTrajectoryClipId(null);
          setGeometryEditClipId(null);
          setVolumeEditClipId(volumeEditClipId === clip.id ? null : clip.id);
          setClipMenu((s) => ({ ...s, open: false }));
        },
      });
      items.push({
        key: "audioTransition",
        label: "Transition",
        keepOpenOnSelect: true,
        submenu: (
          <ClipAudioTransitionFlyout
            durationSec={rc!.clip.duration}
            points={rc!.clip.volumeAutomation?.points}
            onChange={(points) => onVolumePointsChange(clipMenu.clipId, points)}
            onCommit={() => {
              historyUpdate((m) => ({
                ...m,
                tracks: m.tracks.map((t) => ({
                  ...t,
                  clips: t.clips.map((c) =>
                    c.id === clipMenu.clipId ? { ...c } : c
                  ),
                })),
              }));
            }}
          />
        ),
      });
      items.push({
        key: "normalizeLoudness",
        label: "Normalize Loudness",
        onSelect: () => {
          setClipMenu((s) => ({ ...s, open: false }));
          const audioClips = (manifest?.tracks ?? [])
            .flatMap((t) => t.clips)
            .filter((c) => c.type === "audio" && c.srcRelPath?.trim())
            .map((c) => ({ clipId: c.id, srcRelPath: c.srcRelPath }));
          if (audioClips.length === 0) return;
          void apiTimelineNormalizeAudio({ timelineKey, clips: audioClips })
            .then(({ gains }) => {
              historyUpdate((m) => ({
                ...m,
                tracks: m.tracks.map((t) => ({
                  ...t,
                  clips: t.clips.map((c) =>
                    gains[c.id] != null
                      ? { ...c, normalizationGain: gains[c.id] }
                      : c
                  ),
                })),
              }));
            })
            .catch((err) => {
              console.warn("Loudness normalization failed.", err);
            });
        },
      });
    }

    // 3. Coloring/Effect (image or video)
    if (isImage || isVideo) {
      items.push({
        key: "coloring",
        label: "Coloring/Effect",
        keepOpenOnSelect: true,
        submenu: (
          <ClipColoringFlyout
            clipId={clipMenu.clipId}
            coloring={rc?.clip.coloring}
            onChange={(coloring) => updateClipColoringLive(clipMenu.clipId, coloring)}
            onCommit={() => updateClipColoringCommit(clipMenu.clipId)}
          />
        ),
      });
    }

    // 4. Segment (image or video)
    if (isImage || isVideo) {
      items.push({
        key: "segment",
        label: "Segment",
        disabled: busy,
        onSelect: () => openSegment(clipMenu.clipId),
      });
    }

    // Image-only: New Angle, Change Pose (after Segment)
    if (isImage && !pair) {
      items.push({
        key: "newAngle",
        label: "New Angle",
        disabled: busy,
        onSelect: () => openClipAngle(clipMenu.clipId),
      });
      if (isCharImage) {
        items.push({
          key: "changePose",
          label: "Change Pose",
          onSelect: () => {
            setClipMenu((s) => ({ ...s, open: false }));
            setChangePoseClipId(clipMenu.clipId);
            setCharPickerInitialKey(rc!.clip.source!.charKey ?? null);
            setCharPickerOpen(true);
          },
        });
      }
    }

    // 5. Remove Background (image non-pair, or video) — RMBG flyout
    if (isImage && !pair) {
      items.push({
        key: "removeBg",
        label: "Remove Background",
        disabled: busy,
        keepOpenOnSelect: true,
        submenu: (
          <RemoveBgRmbgFlyout
            mediaKind="image"
            busy={busy}
            onRun={(opts) => {
              const found = findClip(clipMenu.clipId);
              if (!found || found.clip.type !== "image") return;
              removeBgImagePendingRef.current = {
                clipId: found.clip.id,
                relPaths: [found.clip.srcRelPath],
              };
              setClipMenu((s) => ({ ...s, open: false }));
              void runRemoveBgImage({ engine: "rmbg", rmbg: opts.rmbg });
            }}
          />
        ),
      });
    } else if (isVideo) {
      items.push({
        key: "removeVideoBg",
        label: "Remove Background",
        disabled: busy,
        keepOpenOnSelect: true,
        submenu: (
          <RemoveBgRmbgFlyout
            mediaKind="video"
            busy={busy}
            onRun={(opts) => {
              const found = findClip(clipMenu.clipId);
              if (!found || found.clip.type !== "video") return;
              const c = found.clip;
              removeBgVideoTargetRef.current = {
                clipId: c.id,
                srcRelPath: c.srcRelPath,
                start: c.start,
                inPoint: c.inPoint,
                outPoint: c.outPoint,
                speed: c.speed,
                reversed: c.reversed,
                srcDuration: c.srcDuration,
                naturalW: c.naturalW,
                naturalH: c.naturalH,
                duration: c.duration,
                source: c.source,
              };
              setClipMenu((s) => ({ ...s, open: false }));
              void runRemoveBgRmbg({
                processEveryFrame: Boolean(opts.processEveryFrame),
                rmbg: opts.rmbg,
              });
            }}
          />
        ),
      });
    }

    // 6. Edit Video Frames / Group (video)
    if (isVideo) {
      items.push({
        key: "editVideoFrames",
        label: selectedVideoClips().length >= 2 ? "Edit Video Group" : "Edit Video Frames",
        disabled: busy,
        onSelect: () => void openVideoFrameEditor(clipMenu.clipId, clipMenu.trackId),
      });
    }

    // 7. I2V (raster, non-pair)
    if (isRaster && !pair) {
      items.push({
        key: "i2v",
        label: "I2V (image to video)",
        disabled: busy,
        onSelect: () =>
          setI2vDialog({ open: true, clipId: clipMenu.clipId, length: WAN_VIDEO_DEFAULT_LENGTH, prompt: "" }),
      });
    }

    // 8. FLF (raster/video/geometry, non-pair)
    if ((isRaster || isVideo || isGeometry) && !pair) {
      items.push({
        key: "flf",
        label: twoFlfSelected
          ? "FLF (selected 2 clips to video)"
          : "FLF (select 2 image/video clips first)",
        disabled: busy || !twoFlfSelected,
        onSelect: () => {
          const sel = getSelectedFlfClips();
          if (sel.length !== 2) return;
          setFlfDialog({
            open: true,
            clipIdA: sel[0]!.id,
            clipIdB: sel[1]!.id,
            length: WAN_VIDEO_DEFAULT_LENGTH,
          });
        },
      });
    }

    // Raster: AI Edit (after FLF)
    if (isRaster && !pair) {
      items.push({
        key: "aiedit",
        label: "AI Edit",
        disabled: busy,
        onSelect: () => void openAiEdit(clipMenu.clipId),
      });
    }

    // Geometry: Edit Shape / Save Shape
    if (isGeometry) {
      items.push({
        key: "editShape",
        label: "Edit Shape",
        onSelect: () => {
          setTrajectoryClipId(null);
          setVolumeEditClipId(null);
          setTextEditClipId(null);
          setGeometryEditClipId(clipMenu.clipId);
          setClipMenu((s) => ({ ...s, open: false }));
        },
      });
      if (rc?.clip.geometry && geometryIsCustomized(rc.clip.geometry)) {
        items.push({
          key: "saveShape",
          label: "Save Shape",
          onSelect: () => {
            setClipMenu((s) => ({ ...s, open: false }));
            void saveShapeFromClip(clipMenu.clipId);
          },
        });
      }
    }

    if (isImage || isVideo || isGeometry || isText) {
      // 9. Edit Trajectory / Add Trajectory
      items.push({
        key: "trajectory",
        label: rc?.clip.trajectory ? "Edit Trajectory" : "Add Trajectory",
        onSelect: () => {
          const clip = rc!.clip;
          if (!clip.trajectory) {
            const tf = clip.transform ?? { x: 0, y: 0, scale: 1 };
            // Seed a short visible span so start/end are not stacked (zero-length path).
            const endX = tf.x + 0.22;
            updateClipTrajectory(clip.id, {
              motion: "none",
              motionAmount: 50,
              waypoints: [
                { t: 0, x: tf.x, y: tf.y, scale: tf.scale },
                { t: 1, x: endX, y: tf.y, scale: tf.scale },
              ],
            });
          }
          setVolumeEditClipId(null);
          setGeometryEditClipId(null);
          setTrajectoryClipId(clip.id);
        },
      });
      // 10. Reset position
      items.push({
        key: "resetPosition",
        label: "Reset position",
        onSelect: () => resetClipPosition(clipMenu.clipId),
      });
    }

    // 12. Download (video, last)
    if (isVideo) {
      items.push({
        key: "downloadClip",
        label: "Download",
        disabled: busy,
        onSelect: () => void downloadVideoClip(clipMenu.clipId),
      });
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipMenu, playhead, manifest, busy, selectedClipIds]);

  const trackMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!trackMenu.open) return [];
    const tid = trackMenu.trackId;
    const track = manifest?.tracks.find((t) => t.id === tid);
    const isAudio = track?.kind === "audio";
    const open = (fn: () => void) => () => {
      targetTrackRef.current = tid;
      setTrackMenu((s) => ({ ...s, open: false }));
      fn();
    };
    const items: ContextMenuItem[] = [];
    if (!isAudio) {
      items.push(
        { key: "addChar", label: "Add Character", onSelect: open(() => { setCharPickerInitialKey(null); setChangePoseClipId(null); setCharPickerOpen(true); }) },
        { key: "addLoc", label: "Add Location", onSelect: open(() => setLocPickerOpen(true)) },
        {
          key: "t2i",
          label: "T2I",
          disabled: busy,
          onSelect: open(() => openOtherAssetPicker(tid)),
        }
      );
    }
    items.push({ key: "addAudio", label: "Add Audio", onSelect: open(() => openAudioPicker(tid)) });
    items.push({
      key: "delTrack",
      label: "Delete track",
      onSelect: () => {
        historyUpdate((m) => ({ ...m, tracks: m.tracks.filter((t) => t.id !== tid) }));
        setTrackMenu((s) => ({ ...s, open: false }));
      },
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackMenu, manifest]);

  const surfaceMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!surfaceMenu.open) return [];
    const tid = surfaceMenu.trackId;
    const close = () => setSurfaceMenu((s) => ({ ...s, open: false }));
    const open = (fn: () => void) => () => {
      targetTrackRef.current = tid;
      close();
      fn();
    };
    return [
      {
        key: "addTrack",
        label: "+ Track",
        onSelect: () => {
          close();
          addNeutralTrack();
        },
      },
      {
        key: "addChar",
        label: "Add Character",
        disabled: busy,
        onSelect: open(() => {
          setCharPickerInitialKey(null);
          setChangePoseClipId(null);
          setCharPickerOpen(true);
        }),
      },
      {
        key: "addLoc",
        label: "Add Location",
        disabled: busy,
        onSelect: open(() => setLocPickerOpen(true)),
      },
      {
        key: "t2i",
        label: "T2I",
        disabled: busy,
        onSelect: open(() => openOtherAssetPicker(tid ?? undefined)),
      },
      {
        key: "addAudio",
        label: "Add Audio",
        disabled: busy,
        onSelect: open(() => openAudioPicker(tid ?? undefined)),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceMenu, busy]);

  function openSurfaceContextMenu(trackId: string | null, x: number, y: number) {
    setClipMenu((s) => ({ ...s, open: false }));
    setTrackMenu((s) => ({ ...s, open: false }));
    setSurfaceMenu({ open: true, x, y, trackId });
  }

  function togglePlay() {
    if (total <= 0) return;
    if (!playing) {
      // Kick AudioContext resume on the click gesture so MediaElementSource
      // routing is audible (useEffect resume often loses the gesture token).
      void getPreviewAudioGraph()?.resume();
      if (playheadRef.current >= total) seekPlayhead(0);
      setPlaying(true);
      return;
    }
    setPlaying(false);
  }

  function leaveTimeline(path: string) {
    exitClipEditModes();
    router.push(path);
  }

  const nonTrajectoryUiActive =
    charPickerOpen ||
    locPickerOpen ||
    audioPickerOpen ||
    seqPickerOpen ||
    otherAssetPickerOpen ||
    geomPickerOpen ||
    removeBgVideoOpen ||
    removeBgImageOpen ||
    aiEditOpen ||
    segmentOpen ||
    cameraAngleOpen ||
    stripAiEditOpen ||
    Boolean(videoFrameEditor) ||
    Boolean(gallerySequenceEditor) ||
    Boolean(timelineFrameWorkspace) ||
    Boolean(seqEditorSource) ||
    Boolean(i2vDialog?.open) ||
    Boolean(flfDialog?.open) ||
    jobModalProps.open ||
    volumeEditClipId != null;

  useEffect(() => {
    if (trajectoryClipId && nonTrajectoryUiActive) {
      setTrajectoryClipId(null);
    }
  }, [trajectoryClipId, nonTrajectoryUiActive]);

  useEffect(() => {
    if (nonTrajectoryUiActive) {
      setClipMenu((s) => (s.open ? { ...s, open: false } : s));
    }
  }, [nonTrajectoryUiActive]);

  if (!manifest) {
    return (
      <div style={{ minHeight: "100vh", padding: 20, color: "#888" }}>Loading timeline…</div>
    );
  }

  return (
    <DndContext
      sensors={stripDropSensors}
      onDragStart={(ev) => {
        const d = ev.active.data.current as { kind?: string; relPath?: string } | undefined;
        if (d?.kind === "frameSeqStripSlot" && d.relPath) {
          setStripDragPreviewPath(d.relPath);
        }
      }}
      onDragMove={onStripFrameDragMove}
      onDragEnd={onStripFrameDragEnd}
      onDragCancel={() => {
        setStripDragPreviewPath(null);
        stripDragPointerRef.current = null;
      }}
    >
    <div style={{ minHeight: "100vh", background: "#0e0e0e", color: "#eee" }}>
      {/* Header nav */}
      <div
        style={{
          display: "flex",
          gap: 4,
          alignItems: "center",
          paddingLeft: 20,
          paddingTop: 10,
        }}
      >
        <HfTokenSettingsButton />
        <SquareIconButton onClick={() => leaveTimeline("/home")} aria-label="Home" icon={<HomeIcon />} />
        <SquareIconButton
          onClick={() => leaveTimeline("/timeline_hub")}
          aria-label="Back"
          icon={<TriangleIcon direction="left" />}
        />
        {renaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            style={{ marginLeft: 10, fontSize: 14, background: "transparent", border: "1px solid rgba(255,255,255,0.3)", color: "#eee", padding: "2px 6px" }}
          />
        ) : (
          <span
            onDoubleClick={() => { setRenameValue(timelineKey); setRenaming(true); }}
            title="Double-click to rename"
            style={{ marginLeft: 10, fontSize: 14, cursor: "default" }}
          >
            {timelineKey}
          </span>
        )}
      </div>

      {/* Preview */}
      <div
        style={{ position: "relative", zIndex: 10, overflow: "visible", padding: "12px 20px", background: "#0e0e0e" }}
        onPointerDown={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest("[data-timeline-preview-frame]")) return;
          if (t.closest("button")) return;
          if (t.closest("[data-preview-resize-handle]")) return;
          selectClip(null, false);
        }}
      >
        {/* Aspect ratio switch */}
        <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#aaa", marginRight: 4 }}>Aspect</span>
          {(["16:9", "9:16", "1:1", "4:3"] as const).map((a) => (
            <button
              key={a}
              onClick={() => {
                exitClipEditModes();
                historyUpdate((m) => ({ ...m, previewAspect: a }));
              }}
              style={{
                ...toolBtn,
                padding: "3px 8px",
                fontSize: 11,
                borderColor:
                  manifest.previewAspect === a
                    ? "#ffd166"
                    : "rgba(255,255,255,0.35)",
                color: manifest.previewAspect === a ? "#ffd166" : "#eee",
              }}
            >
              {a}
            </button>
          ))}
        </div>

        <TimelinePreviewPlayer
          manifest={manifest}
          timelineKey={timelineKey}
          playing={playing}
          playheadStore={playheadStore}
          selectedClipId={selectedClipIds[selectedClipIds.length - 1] ?? null}
          suppressSelectionChrome={nonTrajectoryUiActive || clipMenu.open}
          editable={!playing}
          onPlayheadChange={commitLivePlayhead}
          onEnded={() => setPlaying(false)}
          onSelectClip={(id, additive) => selectClip(id, additive ?? false)}
          onClipTransformChange={setClipTransformFromPreview}
          onTransformStart={() => {
            trajDragOriginRef.current = null;
            commit();
          }}
          onClipContextMenu={(clipId, x, y) => {
            if (!selectedClipIds.includes(clipId)) selectClip(clipId, false);
            const rc = findClip(clipId);
            setClipMenu({ open: true, x, y, trackId: rc?.trackId ?? "", clipId, fromTrack: false });
          }}
          trajectoryClipId={trajectoryClipId}
          geometryEditClipId={geometryEditClipId}
          textEditClipId={textEditClipId}
          onWaypointChange={onWaypointChange}
          onWaypointPatchCommit={onWaypointPatchCommit}
          onMotionChange={onMotionChange}
          onDeleteTrajectory={(clipId) => { updateClipTrajectory(clipId, undefined); setTrajectoryClipId(null); }}
          onExitTrajectoryEdit={exitTrajectoryEdit}
          onGeometryChange={updateClipGeometry}
          onGeometryCommit={commit}
          onExitGeometryEdit={() => setGeometryEditClipId(null)}
          onExitClipEditModes={exitClipEditModes}
          onTextChange={updateClipText}
          onTextContentChange={updateClipTextContent}
          onTextEditEnd={() => setTextEditClipId(null)}
          onRequestTextEdit={(clipId) => {
            selectClip(clipId, false);
            setTextEditClipId(clipId);
          }}
          onRequestGeometryEdit={(clipId) => {
            selectClip(clipId, false);
            setTrajectoryClipId(null);
            setVolumeEditClipId(null);
            setTextEditClipId(null);
            setGeometryEditClipId(clipId);
          }}
          onGeometryContextMenu={(clipId, x, y) => {
            const rc = findClip(clipId);
            if (!rc?.clip.geometry) return;
            setClipMenu({ open: true, x, y, trackId: rc.trackId, clipId, fromTrack: false });
          }}
          height={previewHeight}
          frameExtension={previewFrameExtension}
          onFrameExtensionChange={(ext) => setPreviewFrameExtension(ext)}
        />

        {/* Drag handle to resize the preview height */}
        <div
          data-preview-resize-handle
          onPointerDown={(e) => {
            e.preventDefault();
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            previewResizeRef.current = { startY: e.clientY, orig: previewHeight };
          }}
          onPointerMove={(e) => {
            const d = previewResizeRef.current;
            if (!d) return;
            setPreviewHeight(
              Math.max(140, Math.min(680, d.orig + (e.clientY - d.startY)))
            );
          }}
          onPointerUp={(e) => {
            (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
            previewResizeRef.current = null;
          }}
          title="Drag to resize preview"
          style={{
            position: "relative",
            zIndex: 5,
            height: 10,
            margin: "4px auto 0",
            width: 80,
            cursor: "ns-resize",
            borderBottom: "3px double rgba(255,255,255,0.4)",
          }}
        />
        {/* Transport */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
          <button onClick={togglePlay} style={toolBtn}>
            {playing ? "⏸ Pause" : "▶ Play"}
          </button>
          <button
            onClick={() => {
              setPlaying(false);
              seekPlayhead(0);
            }}
            style={toolBtn}
          >
            ⏮ Start
          </button>
          <span style={{ fontSize: 12, color: "#aaa", fontVariantNumeric: "tabular-nums" }}>
            <PlayheadTimeLabel store={playheadStore} /> / {formatTime(total)}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => setPxPerSec((z) => Math.max(20, z - 20))} style={toolBtn}>
            −
          </button>
          <span style={{ fontSize: 11, color: "#aaa" }}>zoom</span>
          <button onClick={() => setPxPerSec((z) => Math.min(240, z + 20))} style={toolBtn}>
            +
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 8, padding: "0 20px 10px", flexWrap: "wrap" }}>
        <button
          onClick={undo}
          style={toolBtn}
          disabled={undoRef.current.length === 0}
          title="Undo (Ctrl+Z)"
        >
          ↶ Undo
        </button>
        <button
          onClick={redo}
          style={toolBtn}
          disabled={redoRef.current.length === 0}
          title="Redo (Ctrl+Shift+Z)"
        >
          ↷ Redo
        </button>
        <button onClick={addNeutralTrack} style={toolBtn} disabled={busy}>
          + Track
        </button>
        <button
          onClick={() => {
            exitClipEditModes();
            targetTrackRef.current = null;
            setCharPickerInitialKey(null);
            setChangePoseClipId(null);
            setCharPickerOpen(true);
          }}
          style={toolBtn}
          disabled={busy}
        >
          Add Character
        </button>
        <button
          onClick={() => {
            exitClipEditModes();
            targetTrackRef.current = null;
            setLocPickerOpen(true);
          }}
          style={toolBtn}
          disabled={busy}
        >
          Add Location
        </button>
        <button onClick={() => openAudioPicker()} style={toolBtn} disabled={busy}>
          Add Audio
        </button>
        <button onClick={() => openOtherAssetPicker()} style={toolBtn} disabled={busy}>
          Add Other Asset
        </button>
        <button
          ref={geomBtnRef}
          onClick={() => {
            exitClipEditModes();
            setGeomPickerOpen((o) => !o);
          }}
          style={toolBtn}
          disabled={busy}
        >
          Geometry
        </button>
        <button
          onClick={() => {
            exitClipEditModes();
            addTextClip();
          }}
          style={toolBtn}
          disabled={busy}
        >
          Text
        </button>
        <button
          onClick={() => {
            exitClipEditModes();
            void runExportMp4();
          }}
          style={toolBtn}
          disabled={busy}
          title="Compile all clips into a single MP4"
        >
          Export MP4
        </button>
        {volumeEditClipId && (
          <button
            onClick={() => setVolumeEditClipId(null)}
            style={{ ...toolBtn, borderColor: "#ffd166", color: "#ffd166" }}
            title="Exit volume edit mode"
          >
            Exit Volume Mode
          </button>
        )}
      </div>

      <GeometryShapePicker
        open={geomPickerOpen}
        anchorRef={geomBtnRef}
        selected={selectedGeomTemplate}
        selectedSavedId={selectedSavedShapeId}
        savedShapes={savedShapes}
        onSelect={(template) => {
          setSelectedGeomTemplate(template);
          setSelectedSavedShapeId(null);
        }}
        onSelectSaved={(shapeId) => {
          setSelectedSavedShapeId(shapeId);
          setSelectedGeomTemplate(null);
        }}
        onAdd={() => {
          if (selectedSavedShapeId) {
            const sh = savedShapes.find((s) => s.id === selectedSavedShapeId);
            if (sh) {
              addGeometryClip(
                undefined,
                cloneTimelineGeometry({ ...sh.geometry, template: "custom" })
              );
            }
            return;
          }
          if (selectedGeomTemplate) addGeometryClip(selectedGeomTemplate);
        }}
        onClose={() => setGeomPickerOpen(false)}
      />

      {/* Tracks */}
      <div style={{ padding: "0 20px 24px" }}>
        {externalImporting && (
          <div style={{ color: "#9cc9ff", fontSize: 12, marginBottom: 6 }}>
            Importing dropped media…
          </div>
        )}
        {manifest.tracks.length === 0 ? (
          <div
            style={{
              border: emptyFileDropOver
                ? "2px solid rgba(110,181,255,0.85)"
                : "1px dashed rgba(255,255,255,0.2)",
              overflow: "hidden",
            }}
            onDragEnter={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setEmptyFileDropOver(true);
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setEmptyFileDropOver(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setEmptyFileDropOver(false);
            }}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer.files ?? []);
              setEmptyFileDropOver(false);
              if (!files.length) return;
              e.preventDefault();
              void importExternalFiles(null, null, files);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openSurfaceContextMenu(null, e.clientX, e.clientY);
            }}
          >
            <AddTrackStrip onClick={addNeutralTrack} disabled={busy || externalImporting} />
          </div>
        ) : (
          <TimelineTracks
            ref={tracksRef}
            manifest={manifest}
            pxPerSec={pxPerSec}
            playhead={playhead}
            playheadStore={playheadStore}
            selectedClipIds={selectedClipIds}
            externalStripDropActive={Boolean(
              videoFrameEditor ||
                gallerySequenceEditor ||
                timelineFrameWorkspace ||
                seqEditorSource ||
                seqExternalDrag
            )}
            onExternalFilesDrop={(trackId, clientX, files) =>
              void importExternalFiles(trackId, clientX, files)
            }
            onSeek={(t) => {
              setPlaying(false);
              seekPlayhead(t);
            }}
            onSelectClip={selectClip}
            onSelectClips={selectClips}
            onChange={(updater) => setManifest((prev) => (prev ? updater(prev) : prev))}
            onCommit={commit}
            setPxPerSec={setPxPerSec}
            onAddTrack={addNeutralTrack}
            onClipContextMenu={(trackId, clipId, x, y) =>
              setClipMenu({ open: true, x, y, trackId, clipId, fromTrack: true })
            }
            onTrackContextMenu={(trackId, x, y) =>
              setTrackMenu({ open: true, x, y, trackId })
            }
            onSurfaceContextMenu={openSurfaceContextMenu}
            onTransitionChange={updateClipTransition}
            onTransitionCommit={commit}
            onPruneTransitions={pruneTransitionsAfterEdit}
            syncMotionTailSec={syncMotionTailSec}
            onSyncMotionTailSecChange={setSyncMotionTailSec}
            onSyncMotionApply={(trackId, outgoingId, incomingId) =>
              syncJunctionClipMotion(trackId, outgoingId, incomingId, syncMotionTailSec)
            }
            onSyncColorApply={(trackId, outgoingId, incomingId) =>
              syncJunctionClipColor(trackId, outgoingId, incomingId)
            }
            syncBusy={busy}
            volumeEditClipId={volumeEditClipId}
            onVolumePointsChange={onVolumePointsChange}
            onVolumeSeek={(t) => {
              setPlaying(false);
              seekPlayhead(t);
            }}
            onVolumeClear={(clipId) => {
              updateClipVolumeAutomation(clipId, {
                points: defaultVolumeAutomationPoints(),
              });
            }}
          />
        )}
      </div>

      {/* Pickers */}
      <SequenceVideoPicker
        open={seqPickerOpen}
        onCancel={() => setSeqPickerOpen(false)}
        onPick={(choice) => void onPickSequence(choice)}
      />
      <TimelineCharacterPicker
        open={charPickerOpen}
        initialKey={charPickerInitialKey}
        poseChangeMode={changePoseClipId != null}
        onPickImages={onPickCharImages}
        onPickSequences={onPickCharSequences}
        onCancel={() => { setCharPickerOpen(false); setChangePoseClipId(null); setCharPickerInitialKey(null); }}
        onDropImageToTimeline={handleSequenceEditorDropToTimeline}
        onTimelineExternalDragActiveChange={setSeqExternalDrag}
        timelineExternalDragActive={seqExternalDrag}
      />
      <TimelineLocationPicker
        open={locPickerOpen}
        onCancel={() => setLocPickerOpen(false)}
        onPickImages={onPickLocationImages}
      />
      <TimelineAudioPicker
        open={audioPickerOpen}
        busy={busy}
        onCancel={() => setAudioPickerOpen(false)}
        onGenerateAudio={(prompt, durationSec) => void onGenerateAudio(prompt, durationSec)}
        onGenerateMusic={(style, lyrics, durationSec) =>
          void onGenerateMusic(style, lyrics, durationSec)
        }
        onUseSelected={(items) => void onAudioGalleryUseSelected(items)}
      />
      <TimelineOtherAssetPicker
        open={otherAssetPickerOpen}
        timelineKey={timelineKey}
        busy={busy}
        onCancel={() => setOtherAssetPickerOpen(false)}
        onGenerate={onOtherAssetGenerate}
        onUseSelected={(items) => void onOtherAssetUseSelected(items)}
      />

      {/* Context menus */}
      <DesktopContextMenu
        open={clipMenu.open}
        x={clipMenu.x}
        y={clipMenu.y}
        items={clipMenuItems}
        onClose={() => setClipMenu((s) => ({ ...s, open: false }))}
      />
      <DesktopContextMenu
        open={trackMenu.open}
        x={trackMenu.x}
        y={trackMenu.y}
        items={trackMenuItems}
        onClose={() => setTrackMenu((s) => ({ ...s, open: false }))}
      />
      <DesktopContextMenu
        open={surfaceMenu.open}
        x={surfaceMenu.x}
        y={surfaceMenu.y}
        items={surfaceMenuItems}
        onClose={() => setSurfaceMenu((s) => ({ ...s, open: false }))}
      />

      <CameraAngleModal
        open={cameraAngleOpen}
        title="New Angle"
        imageUrl={cameraAngleImageUrl}
        onCancel={() => { setCameraAngleOpen(false); cameraAngleClipIdRef.current = null; }}
        onConfirm={(angleId) => void applyClipAngle(angleId)}
      />

      <AiEditModal
        open={aiEditOpen}
        title="AI Edit"
        imageSrc={aiEditImageSrc}
        busy={busy}
        onCancel={() => {
          setAiEditOpen(false);
          aiEditTargetRef.current = null;
        }}
        onGenerate={(promptText, maskPngBase64) =>
          void runAiEdit(promptText, maskPngBase64)
        }
      />

      <SegmentModal
        open={segmentOpen}
        clipType={segmentClipType}
        mediaSrc={segmentMediaSrc}
        videoSeekSec={segmentVideoSeekSec}
        busy={busy}
        onCancel={() => {
          setSegmentOpen(false);
          segmentTargetRef.current = null;
        }}
        onPreview={onSegmentPreview}
        onSave={(positive, negative, textPrompt, sam3Options) =>
          void runSegmentSave(positive, negative, textPrompt, sam3Options)
        }
      />

      <RemoveBgVideoModal
        open={removeBgVideoOpen}
        busy={busy}
        onCancel={() => {
          setRemoveBgVideoOpen(false);
          removeBgVideoTargetRef.current = null;
        }}
        onRunRvm={(options) => void runRemoveBgRvm(options)}
        onRunRmbg={(options) => void runRemoveBgRmbg(options)}
        onRunAnimeSeg={(options) => void runRemoveBgAnimeSeg(options)}
      />

      <RemoveBgImageModal
        open={removeBgImageOpen}
        busy={busy}
        onCancel={() => {
          setRemoveBgImageOpen(false);
          removeBgImagePendingRef.current = null;
        }}
        onRun={(options) => void runRemoveBgImage(options)}
      />

      {i2vDialog?.open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image to video"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 10040,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onMouseDown={() => setI2vDialog(null)}
        >
          <div
            data-native-clipboard-shortcuts
            style={{
              background: "#0b0b0b",
              color: "#eee",
              padding: 14,
              borderRadius: 0,
              maxWidth: 400,
              width: "100%",
              border: "1px solid rgba(255,255,255,0.22)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Image → Video (I2V)</div>
            <div style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
              <span style={{ display: "block", marginBottom: 2 }}>{WAN_VIDEO_LENGTH_HINT}</span>
              <SequenceOutputLengthStepper
                lengths={SEQUENCE_I2V_OUTPUT_LENGTHS}
                value={i2vDialog.length}
                onChange={(next) => setI2vDialog((d) => (d ? { ...d, length: next } : null))}
              />
            </div>
            <label style={{ display: "block", fontSize: 13, marginBottom: 12 }}>
              <span style={{ display: "block", marginBottom: 4 }}>Motion prompt</span>
              <textarea
                value={i2vDialog.prompt}
                onChange={(e) =>
                  setI2vDialog((d) => (d ? { ...d, prompt: e.target.value } : null))
                }
                rows={3}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  background: "rgba(0,0,0,0.35)",
                  color: "inherit",
                  border: "1px solid rgba(255,255,255,0.25)",
                  borderRadius: 0,
                  padding: 8,
                  resize: "vertical",
                }}
              />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setI2vDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="ui-btn-black"
                disabled={!i2vDialog.prompt.trim() || busy}
                onClick={() => {
                  const dlg = i2vDialog;
                  setI2vDialog(null);
                  if (dlg) void runI2v(dlg.clipId, dlg.prompt, dlg.length);
                }}
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {timelineFrameWorkspace && !videoFrameEditor && !gallerySequenceEditor && manifest ? (
        <TimelineClipFrameWorkspace
          open
          title={
            timelineFrameWorkspace.clipIds.length >= 2
              ? `Edit Video Group (${timelineFrameWorkspace.clipIds.length} videos)`
              : "Edit Video Frames"
          }
          primaryClipId={timelineFrameWorkspace.primaryClipId}
          fps={Math.max(1, manifest.fps)}
          busy={busy}
          items={timelineFrameWorkspace.clipIds
            .map((id) => {
              const found = findClip(id);
              if (
                !found ||
                found.clip.type !== "video" ||
                !found.clip.frameSequence
              ) return null;
              const stripThumb = found.clip.frameSequence?.strip.find(
                (s) => s.kind === "image" && s.relPath && !s.hidden
              )?.relPath;
              return {
                clipId: id,
                label: clipVideoLabel(found.clip),
                thumbRelPath: stripThumb || previewSrcRelPath(found.clip),
                frameSequence: found.clip.frameSequence,
                ...(found.clip.sequenceGallery
                  ? { sequenceGallery: found.clip.sequenceGallery }
                  : {}),
                timelineViewStep: found.clip.frameEdit?.timelineViewStep === 2 ? (2 as const) : (1 as const),
              };
            })
            .filter((x): x is NonNullable<typeof x> => x != null)}
          onClose={() => {
            closeTimelineFrameWorkspace();
          }}
          onFrameSequenceChange={(clipId, frameSequence) =>
            updateClipFrameSequence(clipId, { frameSequence })
          }
          onSequenceGalleryChange={(clipId, gallery) =>
            updateClipFrameSequence(clipId, { sequenceGallery: gallery })
          }
          onTimelineViewStepChange={(clipId, step) => {
            historyUpdate((m) => ({
              ...m,
              tracks: m.tracks.map((t) => ({
                ...t,
                clips: t.clips.map((c) =>
                  c.id !== clipId
                    ? c
                    : {
                        ...c,
                        frameEdit: {
                          framesDirRel: c.frameEdit?.framesDirRel ?? "",
                          ...(c.frameEdit?.extractInPointSec != null
                            ? { extractInPointSec: c.frameEdit.extractInPointSec }
                            : {}),
                          ...(c.frameEdit?.extractFps != null
                            ? { extractFps: c.frameEdit.extractFps }
                            : {}),
                          ...(c.frameEdit?.mp4Aligned ? { mp4Aligned: true } : {}),
                          timelineViewStep: step,
                        },
                      }
                ),
              })),
            }));
          }}
          duplicateFrameAsset={(targetClipId, sourceRelPath) =>
            duplicateClipFrameAsset(targetClipId, sourceRelPath)
          }
          onError={(message, error) => showError({ message, error })}
          onEditFrameSequence={openTimelineFrameStripFromWorkspace}
          onEditGallerySequence={openGallerySequenceFromWorkspace}
          onDownloadVideo={(clipId) => void downloadVideoClip(clipId)}
          onDropImageToTimeline={handleSequenceEditorDropToTimeline}
          onTimelineExternalDragActiveChange={setSeqExternalDrag}
        />
      ) : null}

      {gallerySequenceEditor && manifest ? (() => {
        const { clipId, galleryItemId } = gallerySequenceEditor;
        const found = findClip(clipId);
        const item = found?.clip.sequenceGallery?.find((g) => g.id === galleryItemId);
        const fs = item?.frameSequence;
        if (!found || !fs) return null;
        return (
          <FrameSequenceModal
            key={`gallery-${clipId}-${galleryItemId}`}
            open
            editorMode="timeline"
            title="Edit Frame Sequence (Gallery)"
            initial={fs}
            sourceGalleryIndex={0}
            charKey=""
            sequenceName=""
            previewFps={Math.max(1, manifest.fps)}
            onError={(message, error) => showError({ message, error })}
            onClose={() => setGallerySequenceEditor(null)}
            onSave={saveGallerySequenceStrip}
            onApplyVideo={applyGallerySequenceToClipVideo}
            onNotify={(message) => pushLog(message)}
            duplicateStripAsset={(_targetClipId, sourceRelPath) =>
              duplicateClipFrameAsset(clipId, sourceRelPath)
            }
          />
        );
      })() : null}

      {videoFrameEditor && manifest ? (() => {
        const { clipIds, primaryClipId } = videoFrameEditor;
        const isGroup = clipIds.length > 1;
        const vf = findClip(primaryClipId);
        const fs = vf?.clip.frameSequence;
        if (!vf || !fs) return null;
        const groupLayers = isGroup
          ? clipIds
              .map((id) => {
                const found = findClip(id);
                if (!found?.clip.frameSequence) return null;
                return {
                  clipId: id,
                  label: clipVideoLabel(found.clip),
                  initial: found.clip.frameSequence,
                };
              })
              .filter((g): g is NonNullable<typeof g> => g != null)
          : undefined;
        if (isGroup && (!groupLayers || groupLayers.length < 2)) return null;
        return (
          <FrameSequenceModal
            key={clipIds.join("-")}
            open
            editorMode="timeline"
            title={isGroup ? `Edit Video Group (${clipIds.length} videos)` : "Edit Video Frames"}
            initial={fs}
            sourceGalleryIndex={0}
            charKey=""
            sequenceName=""
            previewFps={Math.max(1, manifest.fps)}
            stripActions={videoFrameStripActions}
            groupLayers={groupLayers}
            getStripActionsForClip={getVideoFrameStripActions}
            onError={(message, error) => showError({ message, error })}
            onClose={() => setVideoFrameEditor(null)}
            onSave={saveVideoFrameStrip}
            onSaveGroup={saveVideoFrameGroup}
            onApplyVideo={(strip) => promptVideoFrameApply(strip)}
            onApplyVideoGroup={(payloads) => promptVideoFrameApplyGroup(payloads)}
            onNotify={(message) => pushLog(message)}
            duplicateStripAsset={(targetClipId, sourceRelPath) =>
              apiTimelineDuplicateFrameAsset({
                timelineKey,
                clipId: targetClipId || primaryClipId,
                sourceRelPath,
              }).then((r) => r.relPath)
            }
            onReExtract={() => void reExtractVideoFrames()}
          />
        );
      })() : null}

      {seqEditorSource ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 10030,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            pointerEvents: seqExternalDrag ? "none" : "auto",
          }}
          onMouseDown={() => {
            void closeSeqEditorFromTimeline();
          }}
        >
          <div
            style={{
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.4)",
              padding: 14,
              maxWidth: "min(1100px, 96vw)",
              maxHeight: "92vh",
              overflow: "auto",
              pointerEvents: "auto",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>Sequence: {seqEditorSource.sequenceName}</div>
              <button
                type="button"
                onClick={() => {
                  void closeSeqEditorFromTimeline();
                }}
                style={{ borderRadius: 0, border: "1px solid rgba(0,0,0,0.5)", background: "transparent", padding: "4px 12px", cursor: "pointer" }}
              >
                Close
              </button>
            </div>
            <SequenceEditor
              charKey={seqEditorSource.charKey}
              sequenceName={seqEditorSource.sequenceName}
              onError={(msg, err) => showError({ message: msg, error: err })}
              jobModal={{ begin: beginSession, end: endSession, fail: failSession, log: pushLog }}
              onDropImageToTimeline={handleSequenceEditorDropToTimeline}
              onTimelineExternalDragActiveChange={setSeqExternalDrag}
            />
          </div>
        </div>
      ) : null}

      <AiEditModal
        open={stripAiEditOpen}
        title="AI Edit frame"
        imageSrc={stripAiEditImageSrc}
        busy={busy}
        onCancel={() => {
          setStripAiEditOpen(false);
          stripAiEditResolveRef.current = null;
          stripAiEditRelRef.current = null;
        }}
        onGenerate={(promptText, maskPngBase64) =>
          void runStripAiEdit(promptText, maskPngBase64)
        }
      />

      {flfDialog?.open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="First-last-frame video"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 10040,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onMouseDown={() => setFlfDialog(null)}
        >
          <div
            data-native-clipboard-shortcuts
            style={{
              background: "#0b0b0b",
              color: "#eee",
              padding: 14,
              borderRadius: 0,
              maxWidth: 400,
              width: "100%",
              border: "1px solid rgba(255,255,255,0.22)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>First–Last Frame (FLF)</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 12 }}>
              The two selected clips (ordered by timeline position) supply start and end frames.
              Videos use the first/last trimmed frame automatically.
            </div>
            <div style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
              <span style={{ display: "block", marginBottom: 2 }}>{WAN_VIDEO_LENGTH_HINT}</span>
              <SequenceOutputLengthStepper
                lengths={SEQUENCE_FLF_OUTPUT_LENGTHS}
                value={flfDialog.length}
                onChange={(next) => setFlfDialog((d) => (d ? { ...d, length: next } : null))}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" onClick={() => setFlfDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const dlg = flfDialog;
                  setFlfDialog(null);
                  if (dlg) void runFlf(dlg.clipIdA, dlg.clipIdB, dlg.length);
                }}
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />
    </div>
    <DragOverlay dropAnimation={null}>
      {stripDragPreviewPath ? (
        <img
          src={assetUrlFromRelPath(stripDragPreviewPath)}
          alt=""
          style={{
            width: 72,
            height: 72,
            objectFit: "contain",
            opacity: 0.85,
            pointerEvents: "none",
            border: "1px solid rgba(255,255,255,0.35)",
            background: "#111",
          }}
        />
      ) : null}
    </DragOverlay>
    </DndContext>
  );
}

const toolBtn: React.CSSProperties = {
  background: "transparent",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.35)",
  padding: "6px 12px",
  cursor: "pointer",
  font: "inherit",
};
