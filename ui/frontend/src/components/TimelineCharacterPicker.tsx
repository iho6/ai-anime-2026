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
  type PoseReference,
  type SequenceManifest,
} from "../lib/api";
import { CollapsibleGallerySection } from "./CollapsibleGallerySection";
import { GalleryImageLightbox } from "./GalleryImageLightbox";
import { GalleryPickTile } from "./GalleryPickTile";
import {
  lightboxForRelPath,
  orderedGalleryRelPaths,
  relPathsToPreviewUrls,
  toggleSetMember,
} from "./timeline/pickerGalleryUtils";
import { SquareButton } from "./SquareButton";
import { SquareIconButton, TriangleIcon } from "./IconPrimitives";
import { ReferencePicker } from "./ReferencePicker";
import { MotionRefGenModal } from "./MotionRefGenModal";
import { CameraAngleModal } from "./CameraAngleModal";
import type { SharedLogStreamHandle } from "./SharedLogStream";
import { ConnectedJobRunModal } from "./ConnectedJobRunModal";
import { useJobRunSession } from "../hooks/useJobRunSession";
import { useAppError } from "./ErrorProvider";
import { BaseCloseupWizardModal } from "./BaseCloseupWizardModal";
import { SequencePreviewLightbox } from "../app/detail/[charKey]/dataset/SequencePreviewLightbox";
import {
  NewCharacterCreatePanel,
  type NewCharacterCreatePanelHandle,
} from "./create/NewCharacterCreatePanel";

type PickerStage = "pick" | "create" | "gallery";
type CharIcon = { key: string; label: string; coverRelPath: string };
type SectionData = {
  poseImages: { relPath: string }[];
  exprImages: { relPath: string }[];
  sequences: { name: string; coverRelPath: string }[];
};

export function TimelineCharacterPicker(props: {
  open: boolean;
  /** Pre-select a character key — skips stage 1, opens directly to galleries. */
  initialKey?: string | null;
  charKey?: string;  // alias for initialKey
  /** When true (Change Pose on clip), only one image; sequences hidden. */
  poseChangeMode?: boolean;
  onPickImages: (charKey: string, relPaths: string[]) => void;
  onPickSequences: (charKey: string, sequenceNames: string[]) => void;
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
  const [newPosePanel, setNewPosePanel] = useState<{ charKey: string; baseRelPath: string } | null>(null);
  const [newPosePrompt, setNewPosePrompt] = useState("");
  const [newPoseRef, setNewPoseRef] = useState<PoseReference | null>(null);
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
    setNewPosePanel(null);
    setNewPosePrompt("");
    setNewPoseRef(null);
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

      let sequences: { name: string; coverRelPath: string }[] = [];
      if (seqNames.length > 0) {
        const manifests = await Promise.all(
          seqNames.map((name) =>
            apiSequenceGet(charKey, name).catch((): SequenceManifest => ({ version: 1, fps: 24, gallery: [], frames: [] }))
          )
        );
        sequences = seqNames
          .map((name, i) => ({
            name,
            coverRelPath:
              manifests[i]?.frames?.[0]?.relPath ??
              manifests[i]?.gallery?.[0]?.relPath ?? "",
          }))
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
    if (!newPosePanel || !newPosePrompt.trim()) return;
    const { charKey, baseRelPath } = newPosePanel;
    beginSession({ title: "Generating pose", clearLog: true });
    await Promise.resolve();
    pushLog("Starting pose generation…");
    try {
      const done = await runDetailWsJob<{ firstPoseKey: string | null; lastInputRelPath: string }>({
        charKey,
        pathSuffix: "/pose/ws",
        payload: {
          job: "generate_prompts",
          baseRelPath,
          prompts: [`Edit the subject to ${newPosePrompt.trim()}, keep identity and clothing coherent unless impossible.`],
          ...(newPoseRef?.keypointRelPath ? { keypointRelPath: newPoseRef.keypointRelPath } : {}),
        },
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok) throw new Error(done.error ?? "Pose generation failed.");
      pushLog("Done. Refreshing gallery…");
      endSession();
      setNewPosePanel(null);
      setNewPosePrompt("");
      void loadSections(charKey);
    } catch (e) {
      failSession(e, "Pose generation failed.");
    }
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
      onPickSequences(selectedKey, [...selectedSequences]);
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
        setSeqPreview({ name: seqName, manifest: m });
      } catch (e) {
        showError({ message: "Could not load sequence.", error: e });
      }
    },
    [selectedKey, showError]
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
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, position: "relative" }}>
            {/* Stage 1: character icons */}
            {stage === "pick" && (
              <>
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
              </>
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
                {sectionsError && <div style={{ color: "#ff8080", fontSize: 13 }}>{sectionsError}</div>}
                {loading && !sectionData && <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>}
                {sectionData && (
                  <>
                    <CollapsibleGallerySection
                      title="Pose"
                      images={sectionData.poseImages}
                      mode="select"
                      selectedRelPaths={selectedRelPaths}
                      disabled={poseBusy}
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
                                onPlayClick={() => void openSequencePlayPreview(seq.name)}
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
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* New Pose inline panel */}
                {newPosePanel && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(10,10,10,0.97)",
                      zIndex: 10,
                      display: "flex",
                      flexDirection: "column",
                      padding: 16,
                      gap: 12,
                      overflowY: "auto",
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button type="button" onClick={() => setNewPosePanel(null)}
                        style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.25)", color: "#aaa", padding: "4px 10px", cursor: "pointer", font: "inherit", fontSize: 12 }}>
                        ← Back
                      </button>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>New Pose</span>
                    </div>

                    {/* Starting image + reference row */}
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      {/* Starting image thumbnail */}
                      <div style={{ flexShrink: 0 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={assetUrlFromRelPath(newPosePanel.baseRelPath)}
                          alt="Starting image"
                          style={{ width: 100, height: 100, objectFit: "contain", border: "1px solid rgba(255,255,255,0.2)" }}
                        />
                        <div style={{ fontSize: 10, color: "#666", marginTop: 4, textAlign: "center" }}>Starting image</div>
                      </div>

                      {/* Reference square button */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <SquareButton
                          variant="import"
                          tone="light"
                          size={100}
                          disabled={poseBusy}
                          onClick={() => setRefPickerOpen(true)}
                          style={{ color: "inherit" }}
                          title="Add a pose reference (optional)"
                        >
                          {newPoseRef ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={assetUrlFromRelPath(newPoseRef.keypointRelPath)}
                              alt=""
                              style={{ width: "100%", height: "100%", objectFit: "contain" }}
                            />
                          ) : (
                            <>
                              Add
                              <br />
                              Reference
                              <br />
                              (optional)
                            </>
                          )}
                        </SquareButton>
                        {newPoseRef && (
                          <button
                            type="button"
                            onClick={() => setNewPoseRef(null)}
                            style={{ background: "transparent", border: "none", color: "#888", cursor: "pointer", fontSize: 11, textAlign: "center" }}
                          >
                            Clear ref
                          </button>
                        )}
                      </div>
                    </div>

                    <textarea
                      value={newPosePrompt}
                      disabled={poseBusy}
                      onChange={(e) => setNewPosePrompt(e.target.value)}
                      placeholder="Describe the new pose (e.g. 'arms raised', 'sitting cross-legged')"
                      rows={3}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        background: "transparent",
                        border: "1px solid rgba(255,255,255,0.25)",
                        color: "#eee",
                        padding: 8,
                        font: "inherit",
                        fontSize: 13,
                        resize: "vertical",
                      }}
                    />

                    <button
                      type="button"
                      onClick={() => void runNewPose()}
                      disabled={poseBusy || !newPosePrompt.trim()}
                      style={{
                        border: "1px solid rgba(255,255,255,0.4)",
                        background: poseBusy || !newPosePrompt.trim() ? "rgba(255,255,255,0.05)" : "rgba(100,200,100,0.12)",
                        color: "#eee",
                        padding: "8px 16px",
                        cursor: poseBusy || !newPosePrompt.trim() ? "not-allowed" : "pointer",
                        font: "inherit",
                        fontWeight: 600,
                      }}
                    >
                      Generate Pose
                    </button>
                  </div>
                )}
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
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const { relPath } = imgCtxMenu;
              setImgCtxMenu(null);
              setNewPosePanel({ charKey: selectedKey!, baseRelPath: relPath });
              setNewPosePrompt("");
              setNewPoseRef(null);
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
            New Pose
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
        charKey={newPosePanel?.charKey ?? ""}
        busy={poseBusy}
        onCancel={() => setRefPickerOpen(false)}
        onUseSelected={(sel) => {
          if (sel.singles[0]) setNewPoseRef(sel.singles[0]);
          setRefPickerOpen(false);
        }}
        onPickNew={() => setRefPickerOpen(false)}
        onGenerateBase={() => setRefPickerOpen(false)}
        onOpenMotionRef={() => {
          setRefPickerOpen(false);
          setMotionRefOpen(true);
        }}
      />

      {/* Motion Ref Gen modal (KiMoD) */}
      <MotionRefGenModal
        open={motionRefOpen}
        charKey={newPosePanel?.charKey ?? ""}
        onBack={() => { setMotionRefOpen(false); setRefPickerOpen(true); }}
        onClose={() => setMotionRefOpen(false)}
        onKeypointsMade={(ref) => {
          setNewPoseRef(ref);
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
