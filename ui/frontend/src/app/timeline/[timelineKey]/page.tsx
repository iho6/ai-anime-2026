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
  apiTimelineGet,
  apiTimelineImportAudio,
  apiTimelineImportImage,
  apiTimelinePut,
  apiTimelineSavedShapes,
  apiSaveTimelineShape,
  AudioReference,
  runReferenceAudioGenerateWsJob,
  assetUrlFromRelPath,
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
  buildTextClip,
  buildTimelineClipClipboard,
  buildTimelineCompositePngBase64,
  clipActsAsImage,
  clipEnd,
  clipHasEditableTrajectory,
  clamp,
  defaultImageClipTransform,
  formatTime,
  genId,
  newAudioTrack,
  newNeutralTrack,
  newVideoTrack,
  pasteTimelineClipClipboard,
  promoteTrackKind,
  dedupeTimelineManifestClips,
  defaultTrackNameForKind,
  overlayShotLayerPlacement,
  pruneBrokenTransitions,
  resolveClipImageRelPath,
  resolveImportDimensions,
  timelineDuration,
  type ClipTransform,
  type TimelineClipClipboard,
} from "../../../components/timeline/timelineUtil";
import {
  findTrajectorySyncPair,
  syncMotionPair,
} from "../../../components/timeline/trajectorySync";
import { SyncMotionFlyout } from "../../../components/timeline/SyncMotionFlyout";
import {
  flfEndpointLabel,
  resolveFlfEndpoint,
  selectedFlfClips,
} from "../../../components/timeline/timelineFlfUtils";
import {
  frameSequencePayloadEqual,
  syncTrimHiddenToFrameSequence,
} from "../../../components/frameSequenceStripUtils";
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

export default function TimelineEditorPage() {
  const router = useRouter();
  const params = useParams<{ timelineKey: string }>();
  const timelineKey = params?.timelineKey ?? "";
  const { showError, askText } = useAppError();

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
  const [playhead, setPlayhead] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(80);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const clipClipboardRef = useRef<TimelineClipClipboard | null>(null);
  const [hasClipClipboard, setHasClipClipboard] = useState(false);
  const [previewHeight, setPreviewHeight] = useState(260);
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
  const [seqEditorSource, setSeqEditorSource] = useState<{
    charKey: string;
    sequenceName: string;
  } | null>(null);
  const [videoFrameApplyPickIds, setVideoFrameApplyPickIds] = useState<string[]>([]);
  const [videoFrameApplyIsGroup, setVideoFrameApplyIsGroup] = useState(false);
  const videoFrameApplyStripRef = useRef<FrameSequencePayload | null>(null);
  const videoFrameApplyGroupRef = useRef<Record<string, FrameSequencePayload> | null>(null);
  const videoFrameApplyEditorRef = useRef<{ clipIds: string[]; primaryClipId: string; primaryTrackId: string } | null>(null);
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
      const placed = { ...clip, start: playhead };
      return {
        ...m2,
        tracks: m2.tracks.map((t) => {
          if (t.id !== trackId) return t;
          const shifted = t.clips.map((c) =>
            c.start >= playhead ? { ...c, start: c.start + placed.duration } : c
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
      const placed = { ...clip, start: playhead };
      return {
        ...m2,
        tracks: m2.tracks.map((t) => {
          if (t.id !== trackId) return t;
          const shifted = t.clips.map((c) =>
            c.start >= playhead ? { ...c, start: c.start + placed.duration } : c
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
        playhead,
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

  function openRemoveBgImageForClip(clipId: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "image") return;
    removeBgImagePendingRef.current = {
      clipId,
      relPaths: [found.clip.srcRelPath],
    };
    setRemoveBgImageOpen(true);
    setClipMenu((s) => ({ ...s, open: false }));
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

  async function removeClipBg(clipId: string) {
    openRemoveBgImageForClip(clipId);
  }

  function openRemoveBgVideo(clipId: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "video") return;
    const c = found.clip;
    removeBgVideoTargetRef.current = {
      clipId,
      srcRelPath: c.srcRelPath,
      start: found.clip.start,
      naturalW: c.naturalW,
      naturalH: c.naturalH,
      duration: c.duration,
      source: c.source,
    };
    setRemoveBgVideoOpen(true);
    setClipMenu((s) => ({ ...s, open: false }));
  }

  function insertVideoBgClip(
    r: { srcRelPath: string; alphaRelPath?: string; width: number; height: number; durationSec?: number },
    start: number,
    fallback: { naturalW?: number; naturalH?: number; duration?: number; source?: TimelineClip["source"] },
    label: string
  ) {
    const dur = r.durationSec || fallback.duration || 5;
    insertClipOnNewTrack(
      {
        id: genId("clip"),
        type: "video",
        srcRelPath: r.srcRelPath,
        ...(r.alphaRelPath ? { alphaRelPath: r.alphaRelPath } : {}),
        start: 0,
        inPoint: 0,
        outPoint: dur,
        speed: 1,
        duration: dur,
        srcDuration: dur,
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
    outputFps24: boolean;
    recycleMask: boolean;
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
        outputFps24: options.outputFps24,
        recycleMask: options.recycleMask,
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
    outputFps24: boolean;
    recycleMask: boolean;
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
        outputFps24: options.outputFps24,
        recycleMask: options.recycleMask,
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
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const clips: TimelineClip[] = [];
        for (const c of t.clips) {
          if (c.id !== clipId || playhead <= c.start || playhead >= clipEnd(c)) {
            clips.push(c);
            continue;
          }
          const leftDur = playhead - c.start;
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
              start: playhead,
              outPoint: cutPoint,
              duration: clipEnd(c) - playhead,
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
              start: playhead,
              inPoint: hasSrc ? cutPoint : c.inPoint,
              duration: clipEnd(c) - playhead,
            });
          }
        }
        return { ...t, clips };
      }),
    }));
  }

  function toggleClipReverse(trackId: string, clipId: string) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) =>
        t.id !== trackId
          ? t
          : {
              ...t,
              clips: t.clips.map((c) =>
                c.id !== clipId ? c : { ...c, reversed: !c.reversed }
              ),
            }
      ),
    }));
    setClipMenu((s) => ({ ...s, open: false }));
  }

  async function changeClipSpeed(trackId: string, clipId: string) {
    const track = manifest?.tracks.find((t) => t.id === trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const ans = await askText({
      title: "Clip speed",
      message: "Speed multiplier (e.g. 0.5 = slower, 2 = faster):",
      defaultValue: String(clip.speed),
      confirmText: "Apply",
    });
    const sp = Number(ans);
    if (!ans || !isFinite(sp) || sp <= 0) return;
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) =>
        t.id !== trackId
          ? t
          : {
              ...t,
              clips: t.clips.map((c) =>
                c.id !== clipId
                  ? c
                  : {
                      ...c,
                      speed: sp,
                      duration: (c.outPoint - c.inPoint) / sp,
                    }
              ),
            }
      ),
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
      const result = pasteTimelineClipClipboard(m, cb, playhead);
      newClipIds = result.newClipIds;
      return result.manifest;
    });
    if (newClipIds.length === 0) return;
    setSelectedClipIds(newClipIds);
    setPlaying(false);
    exitClipEditModes();
  }, [playhead, historyUpdate]);

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

    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (!e.ctrlKey && !e.metaKey && !modalBlocksShortcuts() && selectedClipIds.length > 0) {
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

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (modalBlocksShortcuts() || !manifest) return;
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const fps = Math.max(1, manifest.fps || 24);
        const step = e.shiftKey ? 1 : e.altKey ? 0.1 : 1 / fps;
        setPlaying(false);
        setPlayhead((p) => {
          const next = clamp(p + dir * step, 0, total);
          tracksRef.current?.ensurePlayheadVisible(next);
          return next;
        });
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "c") {
        if (modalBlocksShortcuts() || seqEditorSource || videoFrameEditor) return;
        if (selectedClipIds.length === 0) return;
        e.preventDefault();
        copySelectedClips();
        return;
      }
      if (k === "v") {
        if (modalBlocksShortcuts() || seqEditorSource || videoFrameEditor) return;
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
    jobModalProps.open,
    manifest,
    total,
  ]);

  /** Selected FLF endpoint clips (image, video, geometry), ordered by timeline start. */
  function getSelectedFlfClips(): TimelineClip[] {
    if (!manifest) return [];
    const all = manifest.tracks.flatMap((t) => t.clips);
    return selectedFlfClips(all, selectedClipIds);
  }

  function getTrajectorySyncPair() {
    if (!manifest) return null;
    return findTrajectorySyncPair(manifest, selectedClipIds);
  }

  function syncSelectedClipMotion(tailSec: number = syncMotionTailSec) {
    const pair = getTrajectorySyncPair();
    if (!pair || !manifest) return;
    const fps = Math.max(1, manifest.fps || 24);
    const synced = syncMotionPair(pair.outgoing, pair.incoming, fps, tailSec);
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) =>
        t.id !== pair.trackId
          ? t
          : {
              ...t,
              clips: t.clips.map((c) => {
                if (c.id === pair.outgoing.id) return synced.outgoing;
                if (c.id === pair.incoming.id) return synced.incoming;
                return c;
              }),
            }
      ),
    }));
    setClipMenu((s) => ({ ...s, open: false }));
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
    updateManifest((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id !== clipId) return c;
          if (clipHasEditableTrajectory(c)) {
            const origin = trajDragOriginRef.current;
            const baseClip =
              origin && origin.clipId === clipId && c.trajectory
                ? { ...c, trajectory: { ...c.trajectory, waypoints: origin.waypoints } }
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
    }));
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
    setPlayhead(startSec);
    selectClip(clip.id, false);
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

  const onStripFrameDragEnd = useCallback(
    (ev: DragEndEvent) => {
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
        return;
      }
      const trackId = (ev.over?.data.current as { trackId?: string } | undefined)?.trackId;
      if (!trackId) {
        stripDragPointerRef.current = null;
        return;
      }
      const ptr = stripDragPointerRef.current;
      stripDragPointerRef.current = null;
      const startSec = ptr
        ? clamp(tracksRef.current?.timeAtClientX(ptr.x) ?? playhead, 0, Infinity)
        : playhead;
      void insertFrameFromEditorDrop(activeData.relPath.trim(), trackId, startSec).catch((e) =>
        showError({ message: "Could not add frame to timeline.", error: e })
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelineKey, playhead]
  );

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
    const localTimeSec = Math.max(0, playhead - c.start);
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
    patch: { frameSequence: FrameSequencePayload; frameEdit?: TimelineFrameEdit }
  ) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId
            ? {
                ...c,
                frameSequence: patch.frameSequence,
                ...(patch.frameEdit ? { frameEdit: patch.frameEdit } : {}),
              }
            : c
        ),
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
    updateClipFrameSequence(clipId, {
      frameSequence: synced,
      frameEdit,
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
      return { charKey: m[1], sequenceName: m[2] };
    };
    const charInfo =
      src?.charKey && src?.sequenceName
        ? { charKey: src.charKey, sequenceName: src.sequenceName }
        : charInfoFromStrip();
    if (charInfo) {
      setSeqEditorSource(charInfo);
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
    setVideoFrameEditor({
      clipIds,
      primaryClipId: clipId,
      primaryTrackId: trackId,
    });
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
            ? { ...c, frameSequence: undefined, frameEdit: undefined }
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
    for (const [clipId, frameSequence] of Object.entries(payloads)) {
      updateClipFrameSequence(clipId, { frameSequence });
    }
  }

  function promptVideoFrameApply(strip: FrameSequencePayload) {
    videoFrameApplyStripRef.current = strip;
    videoFrameApplyGroupRef.current = null;
    videoFrameApplyEditorRef.current = videoFrameEditor;
    setVideoFrameApplyIsGroup(false);
    setVideoFrameApplyPickIds(videoFrameEditor ? [videoFrameEditor.primaryClipId] : []);
    void applyVideoFrameStrip("replace");
  }

  function promptVideoFrameApplyGroup(payloads: Record<string, FrameSequencePayload>) {
    videoFrameApplyGroupRef.current = payloads;
    videoFrameApplyStripRef.current = null;
    videoFrameApplyEditorRef.current = videoFrameEditor;
    setVideoFrameApplyIsGroup(true);
    setVideoFrameApplyPickIds(Object.keys(payloads));
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
      for (const clipId of videoFrameApplyPickIds) {
        const s = groupPayloads[clipId];
        if (s) encodeJobs.push({ clipId, strip: s });
      }
    } else if (strip) {
      encodeJobs.push({ clipId: editor.primaryClipId, strip });
    }
    if (!encodeJobs.length) return;

    beginSession({ title: "Encoding video from frames", clearLog: true });
    await Promise.resolve();
    try {
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
        const dur = r.durationSec || found.clip.duration;
        const framePatch = {
          frameSequence: jobStrip,
          frameEdit: {
            framesDirRel: found.clip.frameEdit?.framesDirRel ?? "",
            extractInPointSec: 0,
            extractFps: manifest.fps,
            mp4Aligned: true,
          },
        };
        if (mode === "replace") {
          historyUpdate((m) => ({
            ...m,
            tracks: m.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) =>
                c.id === clipId
                  ? {
                      ...c,
                      srcRelPath: r.srcRelPath,
                      inPoint: 0,
                      outPoint: dur,
                      duration: dur / Math.max(0.01, c.speed),
                      srcDuration: dur,
                      naturalW: r.width || c.naturalW,
                      naturalH: r.height || c.naturalH,
                      ...framePatch,
                    }
                  : c
              ),
            })),
          }));
        } else {
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
              ...framePatch,
            },
            found.clip.start,
            "Edited frames"
          );
        }
      }
      endSession();
      setVideoFrameEditor(null);
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
    const trajectorySyncPair = getTrajectorySyncPair();
    const isVideo = rc?.clip.type === "video";
    const isGeometry = rc?.clip.type === "geometry";
    const isText = rc?.clip.type === "text";
    const isAudio = rc?.clip.type === "audio";

    const items: ContextMenuItem[] = [];

    items.push(
      {
        key: "copy",
        label: "Copy",
        disabled: selectedClipIds.length === 0,
        onSelect: () => {
          copySelectedClips();
          setClipMenu((s) => ({ ...s, open: false }));
        },
      },
      {
        key: "paste",
        label: "Paste",
        disabled: !hasClipClipboard,
        onSelect: () => {
          pasteClips();
          setClipMenu((s) => ({ ...s, open: false }));
        },
      }
    );

    if (clipMenu.fromTrack) {
      items.push(
        {
          key: "split",
          label: "Split at playhead",
          onSelect: () => splitClipAtPlayhead(clipMenu.trackId, clipMenu.clipId),
        },
        {
          key: "speed",
          label: "Speed",
          onSelect: () => void changeClipSpeed(clipMenu.trackId, clipMenu.clipId),
        }
      );
      if (isVideo || isAudio) {
        items.push({
          key: "invert",
          label: rc?.clip.reversed ? "Un-invert" : "Invert",
          onSelect: () => toggleClipReverse(clipMenu.trackId, clipMenu.clipId),
        });
      }
    }

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

    if (isImage || isVideo) {
      items.push({
        key: "segment",
        label: "Segment",
        disabled: busy,
        onSelect: () => openSegment(clipMenu.clipId),
      });
      items.push({
        key: "coloring",
        label: "Coloring",
        keepOpenOnSelect: true,
        submenu: (
          <ClipColoringFlyout
            coloring={rc?.clip.coloring}
            onChange={(coloring) => updateClipColoringLive(clipMenu.clipId, coloring)}
            onCommit={() => updateClipColoringCommit(clipMenu.clipId)}
          />
        ),
      });
    }

    if (isImage && !pair) {
      items.push({
        key: "removeBg",
        label: "Remove Background…",
        disabled: busy,
        onSelect: () => openRemoveBgImageForClip(clipMenu.clipId),
      });
    } else if (isVideo) {
      items.push({
        key: "removeVideoBg",
        label: "Remove Background…",
        disabled: busy,
        onSelect: () => openRemoveBgVideo(clipMenu.clipId),
      });
      items.push({
        key: "editVideoFrames",
        label: selectedVideoClips().length >= 2 ? "Edit Video Group" : "Edit Video Frames",
        disabled: busy,
        onSelect: () => void openVideoFrameEditor(clipMenu.clipId, clipMenu.trackId),
      });
      items.push({
        key: "downloadClip",
        label: "Download",
        disabled: busy,
        onSelect: () => void downloadVideoClip(clipMenu.clipId),
      });
    }

    if (isRaster && !pair) {
      items.push({
        key: "aiedit",
        label: "AI Edit",
        disabled: busy,
        onSelect: () => void openAiEdit(clipMenu.clipId),
      });
      items.push({
        key: "i2v",
        label: "I2V (image to video)",
        disabled: busy,
        onSelect: () =>
          setI2vDialog({ open: true, clipId: clipMenu.clipId, length: WAN_VIDEO_DEFAULT_LENGTH, prompt: "" }),
      });
    }

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

    if (isImage || isVideo || isGeometry || isText) {
      items.push({
        key: "syncMotion",
        label: trajectorySyncPair
          ? "Sync Motion"
          : "Sync Motion (2 connected clips, one with trajectory)",
        disabled: busy || !trajectorySyncPair,
        keepOpenOnSelect: true,
        submenu: (
          <SyncMotionFlyout
            motionTailSec={syncMotionTailSec}
            disabled={busy || !trajectorySyncPair}
            onMotionTailSecChange={setSyncMotionTailSec}
            onApply={() => syncSelectedClipMotion(syncMotionTailSec)}
          />
        ),
      });
      items.push({
        key: "resetPosition",
        label: "Reset position",
        onSelect: () => resetClipPosition(clipMenu.clipId),
      });
      items.push({
        key: "trajectory",
        label: rc?.clip.trajectory ? "Edit Trajectory" : "Add Trajectory",
        onSelect: () => {
          const clip = rc!.clip;
          if (!clip.trajectory) {
            const tf = clip.transform ?? { x: 0, y: 0, scale: 1 };
            updateClipTrajectory(clip.id, {
              motion: "none",
              motionAmount: 50,
              waypoints: [
                { t: 0, x: tf.x, y: tf.y, scale: tf.scale },
                { t: 1, x: tf.x, y: tf.y, scale: tf.scale },
              ],
            });
          }
          setVolumeEditClipId(null);
          setGeometryEditClipId(null);
          setTrajectoryClipId(clip.id);
        },
      });
    }

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
          setVolumeEditClipId(
            volumeEditClipId === clip.id ? null : clip.id
          );
          setClipMenu((s) => ({ ...s, open: false }));
        },
      });
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipMenu, playhead, manifest, busy, selectedClipIds, hasClipClipboard, syncMotionTailSec]);

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
    setPlaying((p) => {
      const next = !p;
      if (next && playhead >= total) setPlayhead(0);
      return next;
    });
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
        style={{ position: "relative", zIndex: 10, overflow: "visible", padding: "12px 20px" }}
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
          playhead={playhead}
          selectedClipId={selectedClipIds[selectedClipIds.length - 1] ?? null}
          suppressSelectionChrome={nonTrajectoryUiActive || clipMenu.open}
          editable={!playing}
          onPlayheadChange={setPlayhead}
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
          onMotionChange={onMotionChange}
          onDeleteTrajectory={(clipId) => { updateClipTrajectory(clipId, undefined); setTrajectoryClipId(null); }}
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
              setPlayhead(0);
            }}
            style={toolBtn}
          >
            ⏮ Start
          </button>
          <span style={{ fontSize: 12, color: "#aaa", fontVariantNumeric: "tabular-nums" }}>
            {formatTime(playhead)} / {formatTime(total)}
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
        {manifest.tracks.length === 0 ? (
          <div
            style={{ border: "1px dashed rgba(255,255,255,0.2)", overflow: "hidden" }}
            onContextMenu={(e) => {
              e.preventDefault();
              openSurfaceContextMenu(null, e.clientX, e.clientY);
            }}
          >
            <AddTrackStrip onClick={addNeutralTrack} disabled={busy} />
          </div>
        ) : (
          <TimelineTracks
            ref={tracksRef}
            manifest={manifest}
            pxPerSec={pxPerSec}
            playhead={playhead}
            selectedClipIds={selectedClipIds}
            externalStripDropActive={Boolean(videoFrameEditor)}
            onSeek={(t) => {
              setPlaying(false);
              setPlayhead(t);
            }}
            onSelectClip={selectClip}
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
            volumeEditClipId={volumeEditClipId}
            onVolumePointsChange={onVolumePointsChange}
            onVolumeSeek={(t) => {
              setPlaying(false);
              setPlayhead(t);
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
          }}
          onMouseDown={() => setSeqEditorSource(null)}
        >
          <div
            style={{
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.4)",
              padding: 14,
              maxWidth: "min(1100px, 96vw)",
              maxHeight: "92vh",
              overflow: "auto",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>Sequence: {seqEditorSource.sequenceName}</div>
              <button
                type="button"
                onClick={() => setSeqEditorSource(null)}
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
