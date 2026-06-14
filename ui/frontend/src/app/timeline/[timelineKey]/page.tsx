"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  apiTimelineGet,
  apiTimelineImportAudio,
  apiTimelineImportImage,
  apiTimelinePut,
  AudioReference,
  runReferenceAudioGenerateWsJob,
  assetUrlFromRelPath,
  runTimelineAiEditWsJob,
  runTimelineExportMp4WsJob,
  runTimelineFlfWsJob,
  runTimelineI2vWsJob,
  runTimelineImportSequenceWsJob,
  runTimelineVideoRemoveBgWsJob,
  runTimelineSegmentPreviewWsJob,
  runTimelineSegmentWsJob,
  type Sam3Point,
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
  ShotLayerMeta,
  TrajectoryMotionId,
} from "../../../lib/api";
import { AiEditModal } from "../../../components/AiEditModal";
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
import { TimelineTracks, TIMELINE_LABEL_W, TIMELINE_ROW_H } from "../../../components/timeline/TimelineTracks";
import {
  SequenceVideoPicker,
  SequenceVideoChoice,
} from "../../../components/timeline/SequenceVideoPicker";
import { TimelineCharacterPicker } from "../../../components/TimelineCharacterPicker";
import { TimelineLocationPicker } from "../../../components/TimelineLocationPicker";
import { TimelineAudioPicker } from "../../../components/TimelineAudioPicker";
import type { TrajectoryWaypoint } from "../../../components/timeline/TrajectoryEditor";
import {
  appendClipToTrack,
  buildAudioClip,
  buildGeometryClip,
  buildImageClip,
  buildTextClip,
  buildTimelineCompositePngBase64,
  clipEnd,
  formatTime,
  genId,
  newAudioTrack,
  newNeutralTrack,
  newVideoTrack,
  promoteTrackKind,
  defaultTrackNameForKind,
  overlayShotLayerPlacement,
  pruneBrokenTransitions,
  resolveImportDimensions,
  timelineDuration,
} from "../../../components/timeline/timelineUtil";

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
  const [previewHeight, setPreviewHeight] = useState(260);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [trajectoryClipId, setTrajectoryClipId] = useState<string | null>(null);
  const [geometryEditClipId, setGeometryEditClipId] = useState<string | null>(null);
  const [textEditClipId, setTextEditClipId] = useState<string | null>(null);
  const [geomPickerOpen, setGeomPickerOpen] = useState(false);
  const [selectedGeomTemplate, setSelectedGeomTemplate] = useState<GeometryTemplate | null>(null);
  const geomBtnRef = useRef<HTMLButtonElement | null>(null);

  // AI Edit modal (image clips).
  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditImageSrc, setAiEditImageSrc] = useState("");
  const aiEditTargetRef = useRef<{ srcRelPath: string; start: number } | null>(null);
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
  } | null>(null);
  const previewResizeRef = useRef<{ startY: number; orig: number } | null>(null);

  // Pickers + which track a newly-imported clip should land on.
  const targetTrackRef = useRef<string | null>(null);
  const [seqPickerOpen, setSeqPickerOpen] = useState(false);
  const [charPickerOpen, setCharPickerOpen] = useState(false);
  const [charPickerInitialKey, setCharPickerInitialKey] = useState<string | null>(null);
  const [changePoseClipId, setChangePoseClipId] = useState<string | null>(null);
  const [locPickerOpen, setLocPickerOpen] = useState(false);
  const [audioPickerOpen, setAudioPickerOpen] = useState(false);

  // New Angle modal (for character clips).
  const [cameraAngleOpen, setCameraAngleOpen] = useState(false);
  const [cameraAngleImageUrl, setCameraAngleImageUrl] = useState<string | null>(null);
  const cameraAngleClipIdRef = useRef<string | null>(null);

  // Context menus.
  const [clipMenu, setClipMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    trackId: string;
    clipId: string;
  }>({ open: false, x: 0, y: 0, trackId: "", clipId: "" });
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

  // ---- Load + debounced autosave ------------------------------------------
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!timelineKey) return;
    apiTimelineGet(timelineKey)
      .then((m) => {
        setManifest(m);
        loadedRef.current = true;
      })
      .catch((e) => showError({ message: "Could not load timeline.", error: e }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      return {
        ...m2,
        tracks: m2.tracks.map((t) =>
          t.id === trackId ? appendClipToTrack(t, clip) : t
        ),
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
        tracks: m2.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: [...t.clips, placed] } : t
        ),
      };
    });
    targetTrackRef.current = null;
    setTrajectoryClipId(null);
    setGeometryEditClipId(null);
    selectClip(clip.id, false);
  }

  function addGeometryClip(template: GeometryTemplate) {
    const clip = buildGeometryClip({ template });
    addVectorClipAtPlayhead(clip);
    setGeomPickerOpen(false);
    setSelectedGeomTemplate(null);
  }

  function addTextClip() {
    const clip = buildTextClip({});
    addVectorClipAtPlayhead(clip);
    setTextEditClipId(clip.id);
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
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId && c.text ? { ...c, text: { ...c.text, ...patch } } : c
        ),
      })),
    }));
  }

  function updateClipTextContent(clipId: string, content: string) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === clipId && c.text ? { ...c, text: { ...c.text, content } } : c
        ),
      })),
    }));
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
    targetTrackRef.current = targetTrackId ?? null;
    setAudioPickerOpen(true);
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

  async function importImageClip(sourceRelPath: string, source: TimelineClip["source"]) {
    beginSession({ title: "Importing image", clearLog: true });
    await Promise.resolve();
    pushLog("Importing image…");
    try {
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
      endSession();
    } catch (e) {
      failSession(e, "Could not import image.");
    }
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

  function onPickCharImage(charKey: string, relPath: string) {
    setCharPickerOpen(false);
    const sourceClipId = changePoseClipId;
    setChangePoseClipId(null);
    setCharPickerInitialKey(null);
    if (sourceClipId) {
      void addPoseClipFromSource(sourceClipId, relPath, charKey);
    } else {
      void importImageClip(relPath, { charKey });
    }
  }

  function onPickCharSequence(charKey: string, sequenceName: string) {
    setCharPickerOpen(false);
    setChangePoseClipId(null);
    setCharPickerInitialKey(null);
    void onPickSequence({ charKey, sequenceName, label: sequenceName });
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
    const overlay = [a, b].find((c) => c.source?.charKey);
    const backdrop = [a, b].find((c) => !c.source?.charKey);
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
      const charKey = overlay.source?.charKey ?? "";
      const layers: ShotLayerMeta[] = [{
        charKey,
        imageRelPath: overlay.srcRelPath,
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

  function onPickLocationImage(locationKey: string, relPath: string) {
    setLocPickerOpen(false);
    if (!relPath) {
      showError({ message: "That location has no image to import." });
      return;
    }
    void importImageClip(relPath, { locationKey });
  }

  // ---- Clip operations -----------------------------------------------------
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

  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      const t = target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    }

    function modalBlocksDelete(): boolean {
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
        if (!e.ctrlKey && !e.metaKey && !modalBlocksDelete() && selectedClipIds.length > 0) {
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
        }
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
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
    selectedClipIds,
    trajectoryClipId,
    geometryEditClipId,
    textEditClipId,
    aiEditOpen,
    segmentOpen,
    cameraAngleOpen,
    charPickerOpen,
    locPickerOpen,
    audioPickerOpen,
    seqPickerOpen,
    jobModalProps.open,
  ]);

  function updateClipTrajectory(clipId: string, trajectory: TimelineClip["trajectory"]) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, trajectory } : c)),
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

  async function removeClipBg(clipId: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "image") return;
    beginSession({ title: "Removing background", clearLog: true });
    await Promise.resolve();
    pushLog("Removing background…");
    try {
      const done = await runShotRemoveBgWsJob({
        imageRelPath: found.clip.srcRelPath,
        onLogLine: (line) => pushLog(line),
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

  async function removeVideoClipBg(clipId: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "video") return;
    beginSession({ title: "Removing video background (RVM)", clearLog: true });
    await Promise.resolve();
    pushLog("Starting RobustVideoMatting (model loads on first run ~15 s)…");
    try {
      const done = await runTimelineVideoRemoveBgWsJob({
        timelineKey,
        videoRelPath: found.clip.srcRelPath,
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.srcRelPath) {
        throw new Error(done.error || "Video BG removal returned no output.");
      }
      const r = done.result;
      const dur = r.durationSec || found.clip.duration || 5;
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
          naturalW: r.width || found.clip.naturalW,
          naturalH: r.height || found.clip.naturalH,
          source: found.clip.source,
        },
        found.clip.start,
        "Remove Background"
      );
      endSession();
    } catch (e) {
      failSession(e, "Video background removal failed.");
    }
  }

  async function commitRename() {
    setRenaming(false);
    const next = renameValue.trim();
    if (!next || next === timelineKey) return;
    try {
      const { newTimelineKey } = await apiTimelineHubRename(timelineKey, next);
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
          const cutPoint = hasSrc ? c.inPoint + leftDur * c.speed : c.inPoint;
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
        return { ...t, clips };
      }),
    }));
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
  function selectClip(clipId: string | null, additive: boolean) {
    if (clipId == null) {
      if (!additive) setSelectedClipIds([]);
      return;
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

  /** Selected image clips, ordered by timeline start. */
  function selectedImageClips(): TimelineClip[] {
    if (!manifest) return [];
    const all = manifest.tracks.flatMap((t) => t.clips);
    return selectedClipIds
      .map((id) => all.find((c) => c.id === id))
      .filter((c): c is TimelineClip => !!c && c.type === "image")
      .sort((a, b) => a.start - b.start);
  }

  function setClipTransform(clipId: string, transform: { x: number; y: number; scale: number }) {
    updateManifest((m) => ({
      ...m,
      tracks: m.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => (c.id === clipId ? { ...c, transform } : c)),
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

  function openAiEdit(clipId: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "image") return;
    aiEditTargetRef.current = {
      srcRelPath: found.clip.srcRelPath,
      start: found.clip.start,
    };
    setAiEditImageSrc(assetUrlFromRelPath(found.clip.srcRelPath));
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
      textPrompt?: string
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
    textPrompt?: string
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
    beginSession({ title: "AI editing", clearLog: true });
    await Promise.resolve();
    pushLog("AI editing image…");
    try {
      const done = await runTimelineAiEditWsJob({
        timelineKey,
        imageRelPath: tgt.srcRelPath,
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

  async function runI2v(clipId: string) {
    const found = findClip(clipId);
    if (!found || found.clip.type !== "image") return;
    const prompt = await askText({
      title: "Image → Video (I2V)",
      message: "Describe the motion / prompt:",
      confirmText: "Generate",
    });
    if (!prompt?.trim()) return;
    const src = found.clip.srcRelPath;
    const start = found.clip.start;
    beginSession({ title: "Generating video (I2V)", clearLog: true });
    await Promise.resolve();
    pushLog("Generating image-to-video…");
    try {
      const done = await runTimelineI2vWsJob({
        timelineKey,
        imageRelPath: src,
        prompt: prompt.trim(),
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

  async function runFlf() {
    const sel = selectedImageClips();
    if (sel.length !== 2) {
      showError({ message: "Select exactly two image clips first (Shift/Ctrl-click)." });
      return;
    }
    const [a, b] = sel;
    beginSession({ title: "Generating video (FLF)", clearLog: true });
    await Promise.resolve();
    pushLog("Generating first-last-frame video…");
    try {
      const done = await runTimelineFlfWsJob({
        timelineKey,
        imageRelPathA: a.srcRelPath,
        imageRelPathB: b.srcRelPath,
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
        a.start,
        "FLF"
      );
      endSession();
    } catch (e) {
      failSession(e, "FLF failed.");
    }
  }

  // ---- Context menu item builders -----------------------------------------
  const clipMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!clipMenu.open) return [];
    const rc = findClip(clipMenu.clipId);
    const isImage = rc?.clip.type === "image";
    const isCharImage = isImage && Boolean(rc?.clip.source?.charKey);
    const twoImagesSelected = selectedImageClips().length === 2;
    const pair = getOverlappingCharBgPair();
    const isVideo = rc?.clip.type === "video";
    const isGeometry = rc?.clip.type === "geometry";
    const isText = rc?.clip.type === "text";

    const items: ContextMenuItem[] = [
      {
        key: "split",
        label: "Split at playhead",
        onSelect: () => splitClipAtPlayhead(clipMenu.trackId, clipMenu.clipId),
      },
      {
        key: "speed",
        label: "Speed",
        onSelect: () => void changeClipSpeed(clipMenu.trackId, clipMenu.clipId),
      },
    ];

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
        label: geometryEditClipId === clipMenu.clipId ? "Exit Shape Edit" : "Edit Shape",
        onSelect: () => {
          if (geometryEditClipId === clipMenu.clipId) {
            setGeometryEditClipId(null);
          } else {
            setTrajectoryClipId(null);
            setGeometryEditClipId(clipMenu.clipId);
          }
          setClipMenu((s) => ({ ...s, open: false }));
        },
      });
    }

    if (isImage || isVideo) {
      items.push({
        key: "segment",
        label: "Segment",
        disabled: busy,
        onSelect: () => openSegment(clipMenu.clipId),
      });
    }

    if (isImage && !pair) {
      items.push({
        key: "removeBg",
        label: "Remove Background",
        disabled: busy,
        onSelect: () => void removeClipBg(clipMenu.clipId),
      });
    } else if (isVideo) {
      items.push({
        key: "removeVideoBg",
        label: "Remove Background (video)",
        disabled: busy,
        onSelect: () => void removeVideoClipBg(clipMenu.clipId),
      });
    }

    if (isImage && !pair) {
      items.push({
        key: "aiedit",
        label: "AI Edit",
        disabled: busy,
        onSelect: () => openAiEdit(clipMenu.clipId),
      });
    }

    if (isImage || isVideo || isGeometry || isText) {
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
          setGeometryEditClipId(null);
          setTrajectoryClipId(clip.id);
        },
      });
    }

    if (isImage && !pair) {
      items.push(
        {
          key: "i2v",
          label: "I2V (image to video)",
          disabled: busy,
          onSelect: () => void runI2v(clipMenu.clipId),
        },
        {
          key: "flf",
          label: twoImagesSelected
            ? "FLF (selected 2 images to video)"
            : "FLF (select 2 image clips first)",
          disabled: busy || !twoImagesSelected,
          onSelect: () => void runFlf(),
        }
      );
    }

    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipMenu, playhead, manifest, busy]);

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
        { key: "addLoc", label: "Add Location", onSelect: open(() => setLocPickerOpen(true)) }
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

  if (!manifest) {
    return (
      <div style={{ minHeight: "100vh", padding: 20, color: "#888" }}>Loading timeline…</div>
    );
  }

  return (
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
        <SquareIconButton onClick={() => router.push("/home")} aria-label="Home" icon={<HomeIcon />} />
        <SquareIconButton
          onClick={() => router.push("/timeline_hub")}
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
      <div style={{ padding: "12px 20px" }}>
        {/* Aspect ratio switch */}
        <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#aaa", marginRight: 4 }}>Aspect</span>
          {(["16:9", "9:16", "1:1", "4:3"] as const).map((a) => (
            <button
              key={a}
              onClick={() =>
                historyUpdate((m) => ({ ...m, previewAspect: a }))
              }
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
          playing={playing}
          playhead={playhead}
          selectedClipId={selectedClipIds[selectedClipIds.length - 1] ?? null}
          editable={!playing}
          onPlayheadChange={setPlayhead}
          onEnded={() => setPlaying(false)}
          onSelectClip={(id, additive) => selectClip(id, additive ?? false)}
          onClipTransformChange={setClipTransform}
          onTransformStart={commit}
          onClipContextMenu={(clipId, x, y) => {
            const rc = findClip(clipId);
            setClipMenu({ open: true, x, y, trackId: rc?.trackId ?? "", clipId });
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
          onTextChange={updateClipText}
          onTextContentChange={updateClipTextContent}
          onTextEditEnd={() => setTextEditClipId(null)}
          onRequestTextEdit={(clipId) => {
            selectClip(clipId, false);
            setTextEditClipId(clipId);
          }}
          height={previewHeight}
        />

        {/* Drag handle to resize the preview height */}
        <div
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
        <button
          ref={geomBtnRef}
          onClick={() => setGeomPickerOpen((o) => !o)}
          style={toolBtn}
          disabled={busy}
        >
          Geometry
        </button>
        <button onClick={() => addTextClip()} style={toolBtn} disabled={busy}>
          Text
        </button>
        <button onClick={() => void runExportMp4()} style={toolBtn} disabled={busy} title="Compile all clips into a single MP4">
          Export MP4
        </button>
        {trajectoryClipId && (
          <button
            onClick={() => setTrajectoryClipId(null)}
            style={{ ...toolBtn, borderColor: "#ffd166", color: "#ffd166" }}
            title="Exit path edit mode"
          >
            Exit Path Mode
          </button>
        )}
        {geometryEditClipId && (
          <button
            onClick={() => setGeometryEditClipId(null)}
            style={{ ...toolBtn, borderColor: "#ffd166", color: "#ffd166" }}
            title="Exit shape edit mode"
          >
            Exit Shape Edit
          </button>
        )}
      </div>

      <GeometryShapePicker
        open={geomPickerOpen}
        anchorRef={geomBtnRef}
        selected={selectedGeomTemplate}
        onSelect={setSelectedGeomTemplate}
        onAdd={() => {
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
            <button
              type="button"
              onClick={addNeutralTrack}
              disabled={busy}
              style={{
                display: "flex",
                width: "100%",
                height: TIMELINE_ROW_H,
                alignItems: "center",
                background: "#1a1a1a",
                border: "none",
                color: "#aaa",
                cursor: busy ? "not-allowed" : "pointer",
                font: "inherit",
                fontSize: 13,
                padding: 0,
              }}
            >
              <span style={{ width: TIMELINE_LABEL_W, flexShrink: 0, paddingLeft: 8 }}>
                + Track
              </span>
              <span style={{ flex: 1, textAlign: "left", opacity: 0.6 }}>
                Click to add your first track
              </span>
            </button>
          </div>
        ) : (
          <TimelineTracks
            manifest={manifest}
            pxPerSec={pxPerSec}
            playhead={playhead}
            selectedClipIds={selectedClipIds}
            onSeek={(t) => {
              setPlaying(false);
              setPlayhead(t);
            }}
            onSelectClip={selectClip}
            onChange={(next) => setManifest(next)}
            onCommit={commit}
            setPxPerSec={setPxPerSec}
            onAddTrack={addNeutralTrack}
            onClipContextMenu={(trackId, clipId, x, y) =>
              setClipMenu({ open: true, x, y, trackId, clipId })
            }
            onTrackContextMenu={(trackId, x, y) =>
              setTrackMenu({ open: true, x, y, trackId })
            }
            onSurfaceContextMenu={openSurfaceContextMenu}
            onTransitionChange={updateClipTransition}
            onTransitionCommit={commit}
            onPruneTransitions={pruneTransitionsAfterEdit}
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
        onPickImage={onPickCharImage}
        onPickSequence={onPickCharSequence}
        onCancel={() => { setCharPickerOpen(false); setChangePoseClipId(null); setCharPickerInitialKey(null); }}
      />
      <TimelineLocationPicker
        open={locPickerOpen}
        onCancel={() => setLocPickerOpen(false)}
        onPickImage={onPickLocationImage}
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
        onSave={(positive, negative, textPrompt) =>
          void runSegmentSave(positive, negative, textPrompt)
        }
      />

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />
    </div>
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
