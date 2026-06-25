"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiHubCharacters,
  apiHubDelete,
  apiNewCharacterDiscard,
  apiPoseGallerySplit,
  apiExpressionGallerySplit,
  apiSequenceFolderNames,
  apiSequenceFolderDuplicate,
  apiSequenceGet,
  assetUrlFromRelPath,
  runDetailWsJob,
  runShotMakeAngleWsJob,
  type SequenceFrameItem,
  type SequenceManifest,
} from "../lib/api";
import {
  type KeypointRefEntry,
  keypointRefHasFrames,
} from "../lib/keypointRefGeneration";
import { buildKeypointRefQueueFromSelection } from "../lib/referencePickerSelection";
import { KeypointReferenceSlot } from "./KeypointReferenceSlot";
import { CollapsibleGallerySection } from "./CollapsibleGallerySection";
import { GalleryImageLightbox } from "./GalleryImageLightbox";
import { GalleryPickTile } from "./GalleryPickTile";
import {
  lightboxForRelPath,
  orderedGalleryRelPaths,
  relPathsToPreviewUrls,
  toggleSetMember,
} from "./timeline/pickerGalleryUtils";
import { SquareIconButton, TriangleIcon } from "./IconPrimitives";
import { ReferencePicker } from "./ReferencePicker";
import { MotionRefGenModal } from "./MotionRefGenModal";
import { CameraAngleModal } from "./CameraAngleModal";
import type { SharedLogStreamHandle } from "./SharedLogStream";
import { ConnectedJobRunModal } from "./ConnectedJobRunModal";
import { useJobRunSession } from "../hooks/useJobRunSession";
import { useAppError } from "./ErrorProvider";
import { resolveSequenceImportGalleryItemId } from "../lib/sequenceImport";
import { BaseCloseupWizardModal } from "./BaseCloseupWizardModal";
import { SequencePreviewLightbox } from "../app/detail/[charKey]/dataset/SequencePreviewLightbox";
import {
  apiExportFramesVideo,
  sanitizeDownloadBaseName,
} from "../lib/downloadVideo";
import {
  NewCharacterCreatePanel,
  type NewCharacterCreatePanelHandle,
} from "./create/NewCharacterCreatePanel";

type PickerStage = "pick" | "create" | "gallery";
type CharIcon = { key: string; label: string; coverRelPath: string };
type SectionData = {
  poseImages: { relPath: string }[];
  exprImages: { relPath: string }[];
  sequences: { name: string; coverRelPath: string; galleryItemId?: string }[];
};

export function TimelineCharacterPicker(props: {
  open: boolean;
  /** Pre-select a character key — skips stage 1, opens directly to galleries. */
  initialKey?: string | null;
  charKey?: string;  // alias for initialKey
  /** When true (Change Pose on clip), only one image; sequences hidden. */
  poseChangeMode?: boolean;
  onPickImages: (charKey: string, relPaths: string[]) => void;
  onPickSequences: (
    charKey: string,
    picks: { sequenceName: string; galleryItemId?: string }[]
  ) => void;
  onCancel: () => void;
}) {
  const { open, poseChangeMode = false, onPickImages, onPickSequences, onCancel } = props;
  const initialKey = props.initialKey ?? props.charKey ?? null;

  const [stage, setStage] = useState<PickerStage>("pick");
  const [icons, setIcons] = useState<CharIcon[]>([]);
  const [iconsError, setIconsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const createPanelRef = useRef<NewCharacterCreatePanelHandle | null>(null);
  const [closeupWizardOpen, setCloseupWizardOpen] = useState(false);
  const [closeupWizardCharKey, setCloseupWizardCharKey] = useState("");
  const [sectionData, setSectionData] = useState<SectionData | null>(null);
  const [sectionsError, setSectionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [seqOpen, setSeqOpen] = useState(true);
  const [selectedRelPaths, setSelectedRelPaths] = useState<Set<string>>(new Set());
  const [selectedSequences, setSelectedSequences] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<{
    paths: string[];
    index: number;
    title: string;
  } | null>(null);
  const [seqPreview, setSeqPreview] = useState<{
    name: string;
    manifest: SequenceManifest;
  } | null>(null);

  // Image right-click context menu (New Angle / New Pose)
  const [imgCtxMenu, setImgCtxMenu] = useState<{
    relPath: string;
    x: number;
    y: number;
  } | null>(null);

  // Sequence folder right-click context menu
  const [seqCtxMenu, setSeqCtxMenu] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);

  const [angleModalOpen, setAngleModalOpen] = useState(false);
  const [angleSourceRelPath, setAngleSourceRelPath] = useState("");

  // New Pose panel state
  const [newPoseBaseRelPath, setNewPoseBaseRelPath] = useState<string | null>(null);
  const [newPosePrompt, setNewPosePrompt] = useState("");
  const [newPoseRef, setNewPoseRef] = useState<KeypointRefEntry | null>(null);
  const [poseBatchQueue, setPoseBatchQueue] = useState<KeypointRefEntry[]>([]);
  const [skipCloseup, setSkipCloseup] = useState(false);
  const [cropPadding, setCropPadding] = useState(0.0);
  const [qwenCfg, setQwenCfg] = useState(1.0);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [motionRefOpen, setMotionRefOpen] = useState(false);

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: poseBusy,
    beginSession,
    endSession,
    failSession,
    pushLog,
    modalProps: poseJobModalProps,
  } = useJobRunSession(logRef);
  const { askText, showError } = useAppError();

  const loadIcons = useCallback(async () => {
    setLoading(true);
    setIconsError(null);
    try {
      const items = await apiHubCharacters();
      setIcons(
        items.map((it) => ({
          key: it.charKey,
          label: it.charKey,
          coverRelPath: it.coverRelPath,
        }))
      );
    } catch (e) {
      setIconsError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setStage(initialKey ? "gallery" : "pick");
    setSectionData(null);
    setSectionsError(null);
    setNewPoseBaseRelPath(null);
    setNewPosePrompt("");
    setNewPoseRef(null);
    setPoseBatchQueue([]);
    setSkipCloseup(false);
    setCropPadding(0.0);
    setQwenCfg(1.0);
    setImgCtxMenu(null);
    setSeqCtxMenu(null);
    setAngleModalOpen(false);
    setAngleSourceRelPath("");
    setCloseupWizardOpen(false);
    setCloseupWizardCharKey("");
    setRefPickerOpen(false);
    setMotionRefOpen(false);
    setSelectedKey(initialKey ?? null);
    setSelectedRelPaths(new Set());
    setSelectedSequences(new Set());
    setLightbox(null);

    if (!initialKey) {
      setIcons([]);
      void loadIcons();
    }
  }, [open, initialKey, loadIcons]);

  const loadSections = useCallback(async (charKey: string) => {
    setLoading(true);
    setSectionData(null);
    setSectionsError(null);
    try {
      const [poses, exprs, seqNames] = await Promise.all([
        apiPoseGallerySplit(charKey),
        apiExpressionGallerySplit(charKey),
        apiSequenceFolderNames(charKey),
      ]);

      let sequences: { name: string; coverRelPath: string; galleryItemId?: string }[] = [];
      if (seqNames.length > 0) {
        const manifests = await Promise.all(
          seqNames.map((name) =>
            apiSequenceGet(charKey, name).catch((): SequenceManifest => ({ version: 1, fps: 24, gallery: [], frames: [] }))
          )
        );
        sequences = seqNames
          .map((name, i) => {
            const manifest = manifests[i]!;
            return {
              name,
              coverRelPath:
                manifest.frames?.[0]?.relPath ??
                manifest.gallery?.[0]?.relPath ?? "",
              galleryItemId: resolveSequenceImportGalleryItemId(manifest),
            };
          })
          .filter((s) => s.coverRelPath);
      }

      setSectionData({
        poseImages: (poses.visible ?? []).map((x) => ({ relPath: x.relPath })),
        exprImages: (exprs.visible ?? []).map((x) => ({ relPath: x.relPath })),
        sequences,
      });
    } catch (e) {
      setSectionsError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !selectedKey || stage !== "gallery") return;
    void loadSections(selectedKey);
  }, [open, selectedKey, stage, loadSections]);

  useEffect(() => {
    if (!sectionData) return;
    setNewPoseBaseRelPath((prev) => prev ?? sectionData.poseImages[0]?.relPath ?? null);
  }, [sectionData]);

  async function handlePickerCancel() {
    if (stage === "create") {
      const ok = await createPanelRef.current?.discardDraftsWithConfirm();
      if (ok === false) return;
      onCancel();
      return;
    }
    onCancel();
  }

  async function handleBack() {
    if (stage === "create") {
      await createPanelRef.current?.cancelWithConfirm();
      return;
    }
    if (stage === "gallery" && !initialKey) {
      setSelectedKey(null);
      setStage("pick");
      setSectionData(null);
      setSelectedRelPaths(new Set());
      setSelectedSequences(new Set());
      setLightbox(null);
    }
  }

  async function onCharacterFinalized(charKey: string) {
    setCloseupWizardCharKey(charKey);
    setCloseupWizardOpen(true);
    setStage("pick");
  }

  async function onWizardDone(charKey: string) {
    setCloseupWizardOpen(false);
    try {
      await apiNewCharacterDiscard();
    } catch {
      /* drafts may already be empty */
    }
    setSelectedKey(charKey);
    setStage("gallery");
    void loadIcons();
  }

  async function runNewPose() {
    const hasRef = keypointRefHasFrames(newPoseRef);
    const promptTrim = newPosePrompt.trim();
    if (!promptTrim && !hasRef) return;
    const baseRelPath = newPoseBaseRelPath;
    const charKey = selectedKey;
    if (!baseRelPath || !charKey) return;

    // Batch: run all queued refs in sequence under one session
    if (poseBatchQueue.length > 1) {
      const queue = poseBatchQueue;
      const total = queue.length;
      beginSession({ title: `Batch pose gen (${total})`, clearLog: true });
      await Promise.resolve();
      try {
        for (let i = 0; i < total; i++) {
          const ref = queue[i];
          setNewPoseRef(ref);
          pushLog(`[${i + 1}/${total}] Starting…`);
          await _runPoseJobForRef(ref, baseRelPath, charKey);
          pushLog(`[${i + 1}/${total}] Done.`);
          void loadSections(charKey);
        }
        setPoseBatchQueue([]);
        setNewPoseRef(null);
        setNewPosePrompt("");
        endSession();
      } catch (e) {
        failSession(e, "Batch pose generation failed.");
      }
      return;
    }

    // Single
    beginSession({ title: "Generating pose", clearLog: true });
    await Promise.resolve();
    pushLog("Starting pose generation…");
    try {
      await _runPoseJobForRef(newPoseRef, baseRelPath, charKey);
      pushLog("Done. Refreshing gallery…");
      endSession();
      setNewPosePrompt("");
      setNewPoseRef(null);
      setPoseBatchQueue([]);
      void loadSections(charKey);
    } catch (e) {
      failSession(e, "Pose generation failed.");
    }
  }

  async function _runPoseJobForRef(
    ref: KeypointRefEntry | null,
    baseRelPath: string,
    charKey: string,
  ) {
    const prompts = newPosePrompt.trim() ? [newPosePrompt.trim()] : [];
    if (ref?.kind === "folder") {
      const done = await runDetailWsJob<{ sequenceName: string; galleryItemId: string }>({
        charKey,
        pathSuffix: "/pose/ws",
        payload: { job: "generate_folder_ref_sequence", folderId: ref.folderId, baseRelPath, prompts, skipCloseup, cropPadding, qwenCfg },
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.sequenceName) throw new Error(done.error ?? "Pose sequence generation failed.");
      pushLog(`Sequence: ${done.result.sequenceName}`);
      return;
    }
    if (ref?.kind === "video") {
      const done = await runDetailWsJob<{ sequenceName: string; galleryItemId: string }>({
        charKey,
        pathSuffix: "/pose/ws",
        payload: { job: "generate_video_ref_sequence", videoRefId: ref.ref.id, baseRelPath, prompts, skipCloseup, cropPadding, qwenCfg },
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.sequenceName) throw new Error(done.error ?? "Pose sequence generation failed.");
      pushLog(`Sequence: ${done.result.sequenceName}`);
      return;
    }
    const done = await runDetailWsJob<{ firstPoseKey: string | null; lastInputRelPath: string }>({
      charKey,
      pathSuffix: "/pose/ws",
      payload: {
        job: "generate_prompts",
        baseRelPath,
        prompts,
        ...(ref?.kind === "single" && ref.ref.keypointRelPath
          ? { keypointRelPath: ref.ref.keypointRelPath }
          : {}),
        skipCloseup,
        cropPadding,
        qwenCfg,
      },
      onLogLine: (line) => pushLog(line),
    });
    if (!done.ok) throw new Error(done.error ?? "Pose generation failed.");
  }

  async function duplicateSequence(name: string) {
    if (!selectedKey) return;
    const label = await askText({
      title: "Duplicate sequence",
      message: `Name for the copy of "${name}":`,
      defaultValue: `${name}_copy`,
      confirmText: "Duplicate",
    });
    if (!label?.trim()) return;
    try {
      await apiSequenceFolderDuplicate(selectedKey, name, label.trim());
      await loadSections(selectedKey);
    } catch (e) {
      showError({ message: "Duplicate sequence failed.", error: e });
    }
  }

  async function applyNewAngle(angleId: number) {
    setAngleModalOpen(false);
    const relPath = angleSourceRelPath;
    setAngleSourceRelPath("");
    if (!selectedKey || !relPath) return;
    beginSession({ title: "Generating new angle", clearLog: true });
    await Promise.resolve();
    pushLog("Generating a new camera angle…");
    try {
      const done = await runShotMakeAngleWsJob({
        imageRelPath: relPath,
        angleId,
        onLogLine: (line) => pushLog(line),
      });
      const newRel = done.result?.relPath;
      if (!done.ok || !newRel) throw new Error(done.error || "Angle generation returned no image.");
      pushLog("Done.");
      endSession();
      await loadSections(selectedKey);
      setSelectedRelPaths((prev) => new Set([...prev, newRel]));
    } catch (e) {
      failSession(e, "Angle generation failed.");
    }
  }

  const poseImages = sectionData?.poseImages ?? [];
  const exprImages = sectionData?.exprImages ?? [];
  const sequences = sectionData?.sequences ?? [];

  const allImageRelPaths = useMemo(
    () =>
      orderedGalleryRelPaths([
        { images: poseImages },
        { images: exprImages },
      ]),
    [poseImages, exprImages]
  );

  const selectionCount = selectedRelPaths.size + selectedSequences.size;
  const canUse = poseChangeMode
    ? selectedRelPaths.size === 1 && selectedSequences.size === 0
    : selectionCount > 0;

  const handleUse = useCallback(() => {
    if (!selectedKey || !canUse) return;
    const paths = allImageRelPaths.filter((p) => selectedRelPaths.has(p));
    if (paths.length) onPickImages(selectedKey, paths);
    if (!poseChangeMode && selectedSequences.size) {
      const seqPicks = sequences
        .filter((s) => selectedSequences.has(s.name))
        .map((s) => ({
          sequenceName: s.name,
          ...(s.galleryItemId ? { galleryItemId: s.galleryItemId } : {}),
        }));
      if (seqPicks.length) onPickSequences(selectedKey, seqPicks);
    }
  }, [
    allImageRelPaths,
    canUse,
    onPickImages,
    onPickSequences,
    poseChangeMode,
    selectedKey,
    selectedRelPaths,
    selectedSequences,
    sequences,
  ]);

  const openImagePreview = useCallback(
    (relPath: string) => {
      const key = selectedKey ?? "";
      setLightbox(lightboxForRelPath(allImageRelPaths, relPath, `${key} — preview`));
    },
    [allImageRelPaths, selectedKey]
  );

  const openSequencePreview = useCallback(
    (seq: { name: string; coverRelPath: string }) => {
      const covers = sequences.map((s) => s.coverRelPath).filter(Boolean);
      const urls = relPathsToPreviewUrls(covers);
      const idx = covers.indexOf(seq.coverRelPath);
      setLightbox({
        paths: urls,
        index: Math.max(0, idx),
        title: `${selectedKey ?? ""} — ${seq.name}`,
      });
    },
    [sequences, selectedKey]
  );

  const openSequencePlayPreview = useCallback(
    async (seqName: string) => {
      if (!selectedKey) return;
      try {
        const m = await apiSequenceGet(selectedKey, seqName);
        // Pose-generated sequences store frames in gallery[*].frameSequence.strip,
        // leaving manifest.frames empty. Synthesize timeline frames so the lightbox renders.
        let manifest: SequenceManifest = m;
        if (!m.frames.length) {
          const syntheticFrames: SequenceFrameItem[] = [];
          let fi = 0;
          for (const g of m.gallery) {
            if (g.frameSequence?.strip) {
              for (const slot of g.frameSequence.strip) {
                if (slot.kind === "image" && !slot.hidden && slot.relPath) {
                  syntheticFrames.push({
                    index: fi,
                    cellId: `preview-${g.id}-${fi}`,
                    relPath: slot.relPath,
                    ...(slot.crop ? { crop: slot.crop } : {}),
                  });
                  fi++;
                }
              }
            } else if (g.relPath) {
              syntheticFrames.push({
                index: fi,
                cellId: `preview-${g.id}-${fi}`,
                relPath: g.relPath,
                ...(g.crop ? { crop: g.crop } : {}),
              });
              fi++;
            }
          }
          manifest = { ...m, frames: syntheticFrames };
        }
        setSeqPreview({ name: seqName, manifest });
      } catch (e) {
        showError({ message: "Could not load sequence.", error: e });
      }
    },
    [selectedKey, showError]
  );

  const downloadSequenceVideo = useCallback(
    async (seqName: string) => {
      if (!selectedKey) return;
      beginSession({ title: "Downloading sequence…", clearLog: true });
      await Promise.resolve();
      try {
        pushLog("Loading sequence manifest…");
        const m = await apiSequenceGet(selectedKey, seqName);
        const relPaths: string[] = [];
        if (m.frames.length) {
          for (const f of [...m.frames].sort((a, b) => a.index - b.index)) {
            if (!f.hidden && f.relPath) relPaths.push(f.relPath);
          }
        } else {
          for (const g of m.gallery) {
            if (g.frameSequence?.strip) {
              for (const slot of g.frameSequence.strip) {
                if (slot.kind === "image" && !slot.hidden && slot.relPath)
                  relPaths.push(slot.relPath);
              }
            } else if (g.relPath) {
              relPaths.push(g.relPath);
            }
          }
        }
        if (!relPaths.length) {
          failSession(new Error("Sequence has no frames to export."), "No frames");
          return;
        }
        pushLog(`Encoding ${relPaths.length} frame(s) at ${Math.max(1, m.fps || 24)} fps…`);
        await apiExportFramesVideo({
          relPaths,
          fps: Math.max(1, m.fps || 24),
          filenameBase: sanitizeDownloadBaseName(seqName) || "sequence",
        });
        pushLog("Download started.");
        endSession();
      } catch (e) {
        failSession(e, "Could not download sequence.");
      }
    },
    [selectedKey, beginSession, pushLog, endSession, failSession]
  );

  if (!open) return null;

  const showBackButton =
    (stage === "gallery" && Boolean(selectedKey) && !initialKey) || stage === "create";

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          zIndex: 9998,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
        }}
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          void handlePickerCancel();
        }}
        // Close context menus on click outside
        onClick={() => { setImgCtxMenu(null); setSeqCtxMenu(null); }}
      >
        <div
          style={{
            width: 720,
            maxWidth: "100%",
            height: "min(92vh, 880px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "#0b0b0b",
            color: "white",
            border: "1px solid rgba(255,255,255,0.25)",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setImgCtxMenu(null); setSeqCtxMenu(null); }}
        >
          {/* Title bar */}
          <div style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontWeight: 400,
            padding: "10px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.15)",
          }}>
            {showBackButton ? (
              <SquareIconButton
                aria-label="Back"
                title="Back"
                icon={<TriangleIcon direction="left" />}
                onClick={() => void handleBack()}
              />
            ) : null}
            <span>Add Character</span>
            {stage === "gallery" && selectedKey ? (
              <span style={{ opacity: 0.55, fontSize: 13 }}>{selectedKey}</span>
            ) : null}
          </div>

          {/* Body */}
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
            {/* Stage 1: character icons */}
            {stage === "pick" && (
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
                {iconsError && <div style={{ color: "#ff8080", fontSize: 13 }}>{iconsError}</div>}
                {loading && icons.length === 0 && <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => setStage("create")}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      padding: 6,
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        width: "100%",
                        aspectRatio: "1/1",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 28,
                        fontWeight: 300,
                        lineHeight: 1,
                      }}
                    >
                      +
                    </div>
                    <span
                      style={{
                        fontSize: 12,
                        textAlign: "center",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      New Character
                    </span>
                  </button>
                  {icons.map((ic) => (
                    <button
                      key={ic.key}
                      type="button"
                      onClick={() => {
                        setSelectedKey(ic.key);
                        setStage("gallery");
                      }}
                      style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "inherit", cursor: "pointer" }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={assetUrlFromRelPath(ic.coverRelPath)} alt="" style={{ width: "100%", aspectRatio: "1/1", objectFit: "contain", display: "block" }} />
                      <span style={{ fontSize: 12, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ic.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {stage === "create" && (
              <NewCharacterCreatePanel
                ref={createPanelRef}
                variant="embedded"
                cancelConfirmMessage="Clear all draft images and return to the character list?"
                onFinalized={(charKey) => void onCharacterFinalized(charKey)}
                onCancelled={() => {
                  setStage("pick");
                  void loadIcons();
                }}
              />
            )}

            {/* Stage 2: pose / expression / sequence sections */}
            {stage === "gallery" && selectedKey && (
              <>
                {sectionsError && <div style={{ color: "#ff8080", fontSize: 13, padding: 12 }}>{sectionsError}</div>}
                {loading && !sectionData && <div style={{ opacity: 0.6, fontSize: 13, padding: 12 }}>Loading…</div>}
                {sectionData && (
                  <>
                    {/* New Pose top section — fixed, does not scroll */}
                    <div style={{ flexShrink: 0, padding: "10px 12px 0", display: "flex", gap: 8, alignItems: "flex-start", paddingBottom: 10, borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                      {/* Starting image */}
                      <div style={{ flexShrink: 0 }}>
                        {newPoseBaseRelPath ? (
                          <button
                            type="button"
                            onClick={() => openImagePreview(newPoseBaseRelPath)}
                            style={{ padding: 0, border: "none", background: "none", cursor: "pointer", display: "block" }}
                            title="Preview starting image"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={assetUrlFromRelPath(newPoseBaseRelPath)}
                              alt="Starting image"
                              style={{ width: 80, height: 80, objectFit: "contain", border: "1px solid rgba(255,255,255,0.2)", display: "block" }}
                            />
                          </button>
                        ) : (
                          <div style={{ width: 80, height: 80, border: "1px dashed rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#555", textAlign: "center", padding: 4, boxSizing: "border-box" }}>
                            Right-click image below
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: "#555", marginTop: 2, textAlign: "center" }}>Starting image</div>
                      </div>
                      {/* Ref slot */}
                      <KeypointReferenceSlot
                        keypointRef={newPoseRef}
                        size={80}
                        tone="light"
                        disabled={poseBusy}
                        onOpenPicker={() => setRefPickerOpen(true)}
                        onClear={() => setNewPoseRef(null)}
                      />
                      {/* Prompt + generate */}
                      <div style={{ flex: 1, minWidth: 0, position: "relative", alignSelf: "flex-start", height: 80 }}>
                        <textarea
                          value={newPosePrompt}
                          disabled={poseBusy}
                          onChange={(e) => setNewPosePrompt(e.target.value)}
                          placeholder="Describe the new pose…"
                          style={{
                            width: "100%",
                            height: 80,
                            maxHeight: 80,
                            boxSizing: "border-box",
                            background: "transparent",
                            border: "1px solid rgba(255,255,255,0.25)",
                            color: "#eee",
                            padding: "6px 8px",
                            paddingBottom: 24,
                            font: "inherit",
                            fontSize: 12,
                            resize: "none",
                            overflowY: "auto",
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => void runNewPose()}
                          disabled={poseBusy || !newPoseBaseRelPath || (!newPosePrompt.trim() && !keypointRefHasFrames(newPoseRef))}
                          style={{
                            position: "absolute",
                            bottom: 1,
                            right: 1,
                            border: "1px solid rgba(255,255,255,0.35)",
                            borderRight: "none",
                            borderBottom: "none",
                            background: "rgba(255,255,255,0.05)",
                            color: "#eee",
                            padding: "2px 8px",
                            cursor:
                              poseBusy || !newPoseBaseRelPath || (!newPosePrompt.trim() && !keypointRefHasFrames(newPoseRef))
                                ? "not-allowed"
                                : "pointer",
                            font: "inherit",
                            fontSize: 11,
                            fontWeight: 400,
                          }}
                        >
                          {poseBatchQueue.length > 1 ? `Generate Pose (${poseBatchQueue.length})` : "Generate Pose"}
                        </button>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
                        <label style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", display: "flex", alignItems: "center", gap: 4, userSelect: "none" }}>
                          <input type="checkbox" checked={skipCloseup} onChange={(e) => setSkipCloseup(e.target.checked)} disabled={poseBusy} />
                          Skip closeup
                        </label>
                        <label style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", display: "flex", alignItems: "center", gap: 4, userSelect: "none" }}>
                          Pad:
                          <input
                            type="number" min={0} max={0.5} step={0.05}
                            value={cropPadding}
                            onChange={(e) => setCropPadding(Math.max(0, Math.min(0.5, parseFloat(e.target.value) || 0)))}
                            disabled={poseBusy}
                            style={{ width: 52, fontSize: 11, background: "transparent", color: "#ccc", border: "1px solid rgba(255,255,255,0.2)", padding: "1px 3px" }}
                          />
                        </label>
                        <label style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", display: "flex", alignItems: "center", gap: 4, userSelect: "none" }}>
                          CFG:
                          <input
                            type="number" min={1} max={4} step={0.5}
                            value={qwenCfg}
                            onChange={(e) => setQwenCfg(Math.max(1, Math.min(4, parseFloat(e.target.value) || 1)))}
                            disabled={poseBusy}
                            style={{ width: 44, fontSize: 11, background: "transparent", color: "#ccc", border: "1px solid rgba(255,255,255,0.2)", padding: "1px 3px" }}
                          />
                        </label>
                      </div>
                    </div>

                    {/* Gallery dropdowns — outer scroll handles section headers, each section has internal image scroll */}
                    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 12px 12px" }}>
                    <CollapsibleGallerySection
                      title="Pose"
                      images={sectionData.poseImages}
                      mode="select"
                      selectedRelPaths={selectedRelPaths}
                      disabled={poseBusy}
                      maxGridHeight={200}
                      onToggleSelect={(relPath, e) => {
                        setSelectedRelPaths((prev) =>
                          toggleSetMember(prev, relPath, e.target.checked)
                        );
                      }}
                      onPreview={openImagePreview}
                      onRightClick={(relPath, x, y) => {
                        setImgCtxMenu({ relPath, x, y });
                      }}
                    />
                    <CollapsibleGallerySection
                      title="Expression"
                      images={sectionData.exprImages}
                      mode="select"
                      selectedRelPaths={selectedRelPaths}
                      disabled={poseBusy}
                      maxGridHeight={200}
                      onToggleSelect={(relPath, e) => {
                        setSelectedRelPaths((prev) =>
                          toggleSetMember(prev, relPath, e.target.checked)
                        );
                      }}
                      onPreview={openImagePreview}
                      onRightClick={(relPath, x, y) => {
                        setImgCtxMenu({ relPath, x, y });
                      }}
                    />
                    {/* Sequence section — collapsible */}
                    {!poseChangeMode && sectionData.sequences.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <button
                          type="button"
                          onClick={() => setSeqOpen((o) => !o)}
                          style={{ display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "4px 0", width: "100%", textAlign: "left", fontSize: 14 }}
                        >
                          <span style={{ display: "inline-flex", transform: seqOpen ? "none" : "rotate(-90deg)", transition: "transform 120ms ease" }}>
                            <TriangleIcon direction="down" />
                          </span>
                          <span>Sequence</span>
                          <span style={{ opacity: 0.55, fontSize: 12 }}>({sectionData.sequences.length})</span>
                        </button>
                        {seqOpen && (
                          <div style={{ maxHeight: 200, overflowY: "auto" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, paddingTop: 6 }}>
                            {sectionData.sequences.map((seq) => (
                              <GalleryPickTile
                                key={seq.name}
                                src={assetUrlFromRelPath(seq.coverRelPath)}
                                caption={seq.name}
                                checked={selectedSequences.has(seq.name)}
                                disabled={poseBusy}
                                onToggle={(on, e) => {
                                  setSelectedSequences((prev) =>
                                    toggleSetMember(prev, seq.name, on)
                                  );
                                }}
                                onPrimaryClick={() => openSequencePreview(seq)}
                                topRightBadge="Vid"
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setImgCtxMenu(null);
                                  setSeqCtxMenu({ name: seq.name, x: e.clientX, y: e.clientY });
                                }}
                                footer={
                                  <div
                                    style={{
                                      fontSize: 10,
                                      color: "#aaa",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                      textAlign: "center",
                                    }}
                                  >
                                    {seq.name}
                                  </div>
                                }
                              />
                            ))}
                          </div>
                          </div>
                        )}
                      </div>
                    )}
                    </div>{/* end scrollable gallery */}
                  </>
                )}

                {/* New Pose inline panel */}
              </>
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: 12,
              borderTop: "1px solid rgba(255,255,255,0.15)",
            }}
          >
            <button type="button" onClick={() => void handlePickerCancel()} className="ui-btn-black">
              Cancel
            </button>
            {stage === "gallery" && selectedKey ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {selectionCount > 0 ? (
                  <span style={{ fontSize: 12, opacity: 0.7 }}>{selectionCount} selected</span>
                ) : null}
                <button
                  type="button"
                  className="ui-btn-black"
                  disabled={poseBusy || !canUse}
                  onClick={handleUse}
                  style={{
                    cursor: poseBusy || !canUse ? "not-allowed" : "pointer",
                    opacity: poseBusy || !canUse ? 0.5 : 1,
                  }}
                >
                  Use
                </button>
              </div>
            ) : (
              <span />
            )}
          </div>
        </div>
      </div>

      {/* Image right-click context menu */}
      {imgCtxMenu && (
        <div
          style={{
            position: "fixed",
            top: imgCtxMenu.y,
            left: imgCtxMenu.x,
            background: "#1e1e1e",
            border: "1px solid rgba(255,255,255,0.2)",
            zIndex: 10100,
            minWidth: 130,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const { relPath } = imgCtxMenu;
              setImgCtxMenu(null);
              setNewPoseBaseRelPath(relPath);
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 14px",
              background: "transparent",
              color: "#eee",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            Add As Starting Img
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const { relPath } = imgCtxMenu;
              setImgCtxMenu(null);
              setAngleSourceRelPath(relPath);
              setAngleModalOpen(true);
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 14px",
              background: "transparent",
              color: "#eee",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            New Angle
          </button>
        </div>
      )}

      {/* Sequence folder right-click context menu */}
      {seqCtxMenu && (
        <div
          style={{
            position: "fixed",
            top: seqCtxMenu.y,
            left: seqCtxMenu.x,
            background: "#1e1e1e",
            border: "1px solid rgba(255,255,255,0.2)",
            zIndex: 10100,
            minWidth: 160,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const { name } = seqCtxMenu;
              setSeqCtxMenu(null);
              void openSequencePlayPreview(name);
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 14px",
              background: "transparent",
              color: "#eee",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            Preview
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const { name } = seqCtxMenu;
              setSeqCtxMenu(null);
              void downloadSequenceVideo(name);
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 14px",
              background: "transparent",
              color: "#eee",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            Download as Video
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const { name } = seqCtxMenu;
              setSeqCtxMenu(null);
              void duplicateSequence(name);
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 14px",
              background: "transparent",
              color: "#eee",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            Duplicate Sequence
          </button>
        </div>
      )}

      <CameraAngleModal
        open={angleModalOpen}
        title="New Angle"
        imageUrl={angleSourceRelPath ? assetUrlFromRelPath(angleSourceRelPath) : null}
        onCancel={() => {
          setAngleModalOpen(false);
          setAngleSourceRelPath("");
        }}
        onConfirm={(angleId) => void applyNewAngle(angleId)}
      />

      {/* Reference picker — includes Motion Ref Gen (KiMoD) option */}
      <ReferencePicker
        open={refPickerOpen}
        charKey={selectedKey ?? ""}
        busy={poseBusy}
        onCancel={() => setRefPickerOpen(false)}
        onUseSelected={(sel) => {
          setRefPickerOpen(false);
          const queue = buildKeypointRefQueueFromSelection(sel);
          if (!queue.length) return;
          setNewPoseRef(queue[0]);
          setPoseBatchQueue(queue.length > 1 ? queue : []);
        }}
        onPickNew={() => setRefPickerOpen(false)}
        onGenerateBase={() => setRefPickerOpen(false)}
        onOpenMotionRef={() => {
          setRefPickerOpen(false);
          setMotionRefOpen(true);
        }}
        jobModal={{ begin: beginSession, end: endSession, fail: failSession, log: pushLog }}
      />

      {/* Motion Ref Gen modal (KiMoD) */}
      <MotionRefGenModal
        open={motionRefOpen}
        charKey={selectedKey ?? ""}
        onBack={() => { setMotionRefOpen(false); setRefPickerOpen(true); }}
        onClose={() => setMotionRefOpen(false)}
        onKeypointsMade={(ref) => {
          setNewPoseRef({ kind: "single", ref });
        }}
        onKeypointVideoMade={() => {
          pushLog("Video keypoint sequence saved to reference library.");
        }}
      />

      <ConnectedJobRunModal modal={poseJobModalProps} logRef={logRef} />

      <BaseCloseupWizardModal
        open={closeupWizardOpen}
        charKey={closeupWizardCharKey}
        title="Generate Closeup Angles"
        onClose={async () => {
          const ck = closeupWizardCharKey.trim();
          if (ck) {
            try {
              await apiHubDelete(ck);
            } catch (e) {
              showError({
                message: "Could not remove the character after closing the wizard.",
                error: e,
              });
            }
          }
          setCloseupWizardOpen(false);
          setCloseupWizardCharKey("");
        }}
        onDone={async () => {
          const ck = closeupWizardCharKey.trim();
          if (ck) await onWizardDone(ck);
        }}
      />

      {lightbox ? (
        <GalleryImageLightbox
          paths={lightbox.paths}
          index={lightbox.index}
          title={lightbox.title}
          onClose={() => setLightbox(null)}
        />
      ) : null}

      {seqPreview ? (
        <SequencePreviewLightbox
          manifest={seqPreview.manifest}
          scope="timeline"
          initialIndex={0}
          title={`${selectedKey ?? ""} — ${seqPreview.name}`}
          onClose={() => setSeqPreview(null)}
          onCommitManifest={(next) => {
            setSeqPreview((cur) => (cur ? { ...cur, manifest: next } : cur));
          }}
        />
      ) : null}
    </>
  );
}
