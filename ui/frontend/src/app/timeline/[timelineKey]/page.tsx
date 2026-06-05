"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  apiLocationHubItems,
  apiShotHubItems,
  apiTimelineGet,
  apiTimelineImportImage,
  apiTimelinePut,
  assetUrlFromRelPath,
  runTimelineAiEditWsJob,
  runTimelineFlfWsJob,
  runTimelineI2vWsJob,
  runTimelineImportSequenceWsJob,
  TimelineClip,
  TimelineManifest,
} from "../../../lib/api";
import { AiEditModal } from "../../../components/AiEditModal";
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
import { TimelineTracks } from "../../../components/timeline/TimelineTracks";
import {
  SequenceVideoPicker,
  SequenceVideoChoice,
} from "../../../components/timeline/SequenceVideoPicker";
import {
  ImageSourcePickerModal,
  PickerItem,
} from "../../../components/timeline/ImageSourcePickerModal";
import {
  appendClipToTrack,
  clipEnd,
  formatTime,
  genId,
  newAudioTrack,
  newVideoTrack,
  timelineDuration,
} from "../../../components/timeline/timelineUtil";

const IMAGE_CLIP_DEFAULT_SEC = 3;
const MUSIC_CLIP_DEFAULT_SEC = 5;

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

  // AI Edit modal (image clips).
  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditImageSrc, setAiEditImageSrc] = useState("");
  const aiEditTargetRef = useRef<{ srcRelPath: string; start: number } | null>(null);
  const previewResizeRef = useRef<{ startY: number; orig: number } | null>(null);

  // Pickers + which track a newly-imported clip should land on.
  const targetTrackRef = useRef<string | null>(null);
  const [seqPickerOpen, setSeqPickerOpen] = useState(false);
  const [locPickerOpen, setLocPickerOpen] = useState(false);
  const [shotPickerOpen, setShotPickerOpen] = useState(false);

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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
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
  }, [undo, redo]);

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
    // Last matching track, else create one.
    const existing = [...m.tracks].reverse().find((t) => t.kind === kind);
    if (existing) return { m, trackId: existing.id };
    const track =
      kind === "video"
        ? newVideoTrack(`Video ${m.tracks.filter((t) => t.kind === "video").length + 1}`)
        : newAudioTrack(`Music ${m.tracks.filter((t) => t.kind === "audio").length + 1}`);
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

  // ---- Toolbar actions -----------------------------------------------------
  function addVideoTrack() {
    historyUpdate((m) => ({
      ...m,
      tracks: [
        ...m.tracks,
        newVideoTrack(`Video ${m.tracks.filter((t) => t.kind === "video").length + 1}`),
      ],
    }));
  }

  function addMusic(targetTrackId?: string) {
    targetTrackRef.current = targetTrackId ?? null;
    const clip: TimelineClip = {
      id: genId("clip"),
      type: "audio",
      srcRelPath: "",
      start: 0,
      inPoint: 0,
      outPoint: MUSIC_CLIP_DEFAULT_SEC,
      speed: 1,
      duration: MUSIC_CLIP_DEFAULT_SEC,
    };
    addClip("audio", clip);
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
      addClip("video", {
        id: genId("clip"),
        type: "image",
        srcRelPath: r.srcRelPath,
        start: 0,
        inPoint: 0,
        outPoint: IMAGE_CLIP_DEFAULT_SEC,
        speed: 1,
        duration: IMAGE_CLIP_DEFAULT_SEC,
        naturalW: r.width || undefined,
        naturalH: r.height || undefined,
        source,
      });
      endSession();
    } catch (e) {
      failSession(e, "Could not import image.");
    }
  }

  function onPickLocation(item: PickerItem) {
    setLocPickerOpen(false);
    if (!item.coverRelPath) {
      showError({ message: "That location has no image to import." });
      return;
    }
    void importImageClip(item.coverRelPath, { locationKey: item.key });
  }

  function onPickShot(item: PickerItem) {
    setShotPickerOpen(false);
    if (!item.coverRelPath) {
      showError({ message: "That shot has no image to import." });
      return;
    }
    void importImageClip(item.coverRelPath, { shotKey: item.key });
  }

  // ---- Clip operations -----------------------------------------------------
  function deleteClip(trackId: string, clipId: string) {
    historyUpdate((m) => ({
      ...m,
      tracks: m.tracks.map((t) =>
        t.id === trackId ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
      ),
    }));
    setSelectedClipIds((prev) => prev.filter((x) => x !== clipId));
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
      insertClipOnNewTrack(
        {
          id: genId("clip"),
          type: "image",
          srcRelPath: r.srcRelPath,
          start: 0,
          inPoint: 0,
          outPoint: IMAGE_CLIP_DEFAULT_SEC,
          speed: 1,
          duration: IMAGE_CLIP_DEFAULT_SEC,
          naturalW: r.width || undefined,
          naturalH: r.height || undefined,
        },
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
    const twoImagesSelected = selectedImageClips().length === 2;
    const items: ContextMenuItem[] = [
      {
        key: "split",
        label: "Split at playhead",
        onSelect: () => splitClipAtPlayhead(clipMenu.trackId, clipMenu.clipId),
      },
      {
        key: "speed",
        label: "Speed…",
        onSelect: () => void changeClipSpeed(clipMenu.trackId, clipMenu.clipId),
      },
    ];
    if (isImage) {
      items.push(
        {
          key: "aiedit",
          label: "AI Edit…",
          disabled: busy,
          onSelect: () => openAiEdit(clipMenu.clipId),
        },
        {
          key: "i2v",
          label: "I2V (image → video)…",
          disabled: busy,
          onSelect: () => void runI2v(clipMenu.clipId),
        }
      );
    }
    items.push({
      key: "flf",
      label: twoImagesSelected
        ? "FLF (selected 2 images → video)"
        : "FLF (select 2 image clips first)",
      disabled: busy || !twoImagesSelected,
      onSelect: () => void runFlf(),
    });
    items.push({
      key: "delete",
      label: "Delete clip",
      onSelect: () => deleteClip(clipMenu.trackId, clipMenu.clipId),
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipMenu, playhead, manifest, selectedClipIds, busy]);

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
        { key: "addChar", label: "Add Character video", onSelect: open(() => setSeqPickerOpen(true)) },
        { key: "addLoc", label: "Add Location", onSelect: open(() => setLocPickerOpen(true)) },
        { key: "addShot", label: "Add Shot", onSelect: open(() => setShotPickerOpen(true)) }
      );
    }
    items.push({ key: "addMusic", label: "Add Music (placeholder)", onSelect: open(() => addMusic(tid)) });
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
        <span style={{ marginLeft: 10, fontSize: 14 }}>{timelineKey}</span>
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
          onSelectClip={(id) => selectClip(id, false)}
          onClipTransformChange={setClipTransform}
          onTransformStart={commit}
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
        <button onClick={addVideoTrack} style={toolBtn} disabled={busy}>
          + Track
        </button>
        <button
          onClick={() => {
            targetTrackRef.current = null;
            setSeqPickerOpen(true);
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
        <button
          onClick={() => {
            targetTrackRef.current = null;
            setShotPickerOpen(true);
          }}
          style={toolBtn}
          disabled={busy}
        >
          Add Shot
        </button>
        <button onClick={() => addMusic()} style={toolBtn} disabled={busy}>
          Add Music
        </button>
      </div>

      {/* Tracks */}
      <div style={{ padding: "0 20px 24px" }}>
        {manifest.tracks.length === 0 ? (
          <div style={{ color: "#888", padding: 20, border: "1px dashed rgba(255,255,255,0.2)" }}>
            No tracks yet. Use “+ Track”, then add a character video, location, shot, or music.
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
            onClipContextMenu={(trackId, clipId, x, y) =>
              setClipMenu({ open: true, x, y, trackId, clipId })
            }
            onTrackContextMenu={(trackId, x, y) =>
              setTrackMenu({ open: true, x, y, trackId })
            }
          />
        )}
      </div>

      {/* Pickers */}
      <SequenceVideoPicker
        open={seqPickerOpen}
        onCancel={() => setSeqPickerOpen(false)}
        onPick={(choice) => void onPickSequence(choice)}
      />
      <ImageSourcePickerModal
        open={locPickerOpen}
        title="Add Location"
        load={async () =>
          (await apiLocationHubItems()).map((l) => ({
            key: l.locationKey,
            coverRelPath: l.coverRelPath,
          }))
        }
        onCancel={() => setLocPickerOpen(false)}
        onPick={onPickLocation}
      />
      <ImageSourcePickerModal
        open={shotPickerOpen}
        title="Add Shot"
        load={async () =>
          (await apiShotHubItems()).map((s) => ({
            key: s.shotKey,
            coverRelPath: s.coverRelPath,
          }))
        }
        onCancel={() => setShotPickerOpen(false)}
        onPick={onPickShot}
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
