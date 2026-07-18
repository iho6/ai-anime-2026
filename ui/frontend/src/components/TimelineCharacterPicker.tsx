"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiHubCharacters,
  apiHubDelete,
  apiNewCharacterDiscard,
  apiPoseGallerySplit,
  apiPoseAnglesDelete,
  apiExpressionGallerySplit,
  apiExpressionAnglesDelete,
  apiSequenceFolderDuplicate,
  apiSequenceFolderDelete,
  apiSequenceFolderRename,
  apiSequenceGet,
  apiSequencePut,
  assetUrlFromRelPath,
  runDetailWsJob,
  runReferenceGenerateWsJob,
  runReferenceMakeKeypointWsJob,
  runReferenceMakeKeypointVideoWsJob,
  type GeneratedReferencePreview,
  type GallerySplit,
  type ReferenceMediaKind,
  type SequenceFrameItem,
  type SequenceManifest,
} from "../lib/api";
import { SequenceEditor } from "../app/detail/[charKey]/dataset/SequenceEditor";
import {
  addImageToSequenceGallery,
  parseSequenceBuilderDrop,
} from "../app/detail/[charKey]/dataset/datasetSequenceDrop";
import {
  keypointRefHasFrames,
  type KeypointRefEntry,
} from "../lib/keypointRefGeneration";
import {
  keypointRefToGenRef,
  runCharacterGeneration,
} from "../lib/characterGeneration";
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
import { ReferenceGenerateModal } from "./ReferenceGenerateModal";
import { MotionRefGenModal } from "./MotionRefGenModal";
import { CameraAngleModal } from "./CameraAngleModal";
import { AiEditModal } from "./AiEditModal";
import type { SharedLogStreamHandle } from "./SharedLogStream";
import { ConnectedJobRunModal } from "./ConnectedJobRunModal";
import { useJobRunSession } from "../hooks/useJobRunSession";
import { useCharacterGalleryAiEdit } from "../hooks/useCharacterGalleryAiEdit";
import { useAppError } from "./ErrorProvider";
import { useCharacterSections } from "../hooks/useCharacterSections";
import { truncateJobModalStatusLine } from "../lib/jobModalStatus";
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

/** Server bucket key for the flat pose gallery (see ``POSE_FLAT_BUCKET`` in logic). */
const POSE_FLAT_FOLDER_KEY = "flat";

function splitRelPaths(split: GallerySplit): Set<string> {
  return new Set([
    ...split.visible.map((x) => x.relPath),
    ...split.hidden.map((x) => x.relPath),
  ]);
}

function newRelPathsFromSplits(
  before: { pose: Set<string>; expr: Set<string> },
  after: { pose: Set<string>; expr: Set<string> }
): string[] {
  const added: string[] = [];
  for (const p of after.pose) {
    if (!before.pose.has(p)) added.push(p);
  }
  for (const p of after.expr) {
    if (!before.expr.has(p)) added.push(p);
  }
  return added;
}

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
  /** Timeline host: drop SequenceEditor gallery / frames onto main tracks. */
  onDropImageToTimeline?: (relPath: string, clientX: number, clientY: number) => void;
  onTimelineExternalDragActiveChange?: (active: boolean) => void;
  timelineExternalDragActive?: boolean;
}) {
  const {
    open,
    poseChangeMode = false,
    onPickImages,
    onPickSequences,
    onCancel,
    onDropImageToTimeline,
    onTimelineExternalDragActiveChange,
    timelineExternalDragActive = false,
  } = props;
  const initialKey = props.initialKey ?? props.charKey ?? null;

  const [stage, setStage] = useState<PickerStage>("pick");
  const [icons, setIcons] = useState<CharIcon[]>([]);
  const [iconsError, setIconsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const createPanelRef = useRef<NewCharacterCreatePanelHandle | null>(null);
  const [closeupWizardOpen, setCloseupWizardOpen] = useState(false);
  const [closeupWizardCharKey, setCloseupWizardCharKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [seqOpen, setSeqOpen] = useState(true);
  const [editingSeqName, setEditingSeqName] = useState<string | null>(null);
  const [editingSeqDraft, setEditingSeqDraft] = useState("");
  const [galleryDragActive, setGalleryDragActive] = useState(false);
  const [seqDropHover, setSeqDropHover] = useState<string | null>(null);
  const [seqDropBusy, setSeqDropBusy] = useState(false);

  const {
    data: charSectionsRaw,
    loading: sectionsLoading,
    error: sectionsError,
    refresh: refreshSections,
  } = useCharacterSections(stage === "gallery" && open ? selectedKey : null);
  const sectionData = useMemo<SectionData | null>(() => {
    if (!charSectionsRaw) return null;
    return {
      poseImages: charSectionsRaw.poseSplit.visible.map((x) => ({ relPath: x.relPath })),
      exprImages: charSectionsRaw.exprSplit.visible.map((x) => ({ relPath: x.relPath })),
      sequences: charSectionsRaw.sequences,
    };
  }, [charSectionsRaw]);
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

  const [pickerSeqEditor, setPickerSeqEditor] = useState<{
    charKey: string;
    sequenceName: string;
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
  const [referenceGenerateOpen, setReferenceGenerateOpen] = useState(false);
  const [referencePickerRefreshToken, setReferencePickerRefreshToken] = useState(0);
  const [motionRefOpen, setMotionRefOpen] = useState(false);

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: poseBusy,
    beginSession,
    endSession,
    failSession,
    pushLog,
    onJobLogLine,
    modalProps: poseJobModalProps,
  } = useJobRunSession(logRef);
  const { askText, showError, confirmAction } = useAppError();

  const {
    openAiEditForGallery,
    openAiEditSequenceGallery,
    aiEditModalProps,
  } = useCharacterGalleryAiEdit({
    charKey: selectedKey,
    refreshSections,
    beginSession,
    endSession,
    failSession,
    onJobLogLine,
    showError,
    busy: poseBusy,
  });

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
    setNewPoseBaseRelPath(null);
    setNewPosePrompt("");
    setNewPoseRef(null);
    setPoseBatchQueue([]);
    setSkipCloseup(false);
    setCropPadding(0.0);
    setQwenCfg(1.0);
    setImgCtxMenu(null);
    setSeqCtxMenu(null);
    setEditingSeqName(null);
    setAngleModalOpen(false);
    setAngleSourceRelPath("");
    setCloseupWizardOpen(false);
    setCloseupWizardCharKey("");
    setRefPickerOpen(false);
    setReferenceGenerateOpen(false);
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
          void refreshSections();
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
      void refreshSections();
    } catch (e) {
      failSession(e, "Pose generation failed.");
    }
  }

  async function _runPoseJobForRef(
    ref: KeypointRefEntry | null,
    baseRelPath: string,
    charKey: string,
  ) {
    const rawPrompts = newPosePrompt.trim() ? [newPosePrompt.trim()] : [];
    const done = await runCharacterGeneration<{
      sequenceName?: string;
      galleryItemId?: string;
    }>({
      charKey,
      kind: "pose",
      baseRelPath,
      rawPrompts,
      keypointRef: keypointRefToGenRef(ref),
      options: { skipCloseup, cropPadding, qwenCfg },
      onLogLine: (line) => pushLog(line),
    });
    if (!done.ok) throw new Error(done.error ?? "Pose generation failed.");
    if (done.result?.sequenceName) pushLog(`Sequence: ${done.result.sequenceName}`);
  }

  async function renameSequence(oldName: string, newName: string) {
    const trimmed = newName.trim();
    setEditingSeqName(null);
    if (!selectedKey || !trimmed || trimmed === oldName) return;
    try {
      const { newName } = await apiSequenceFolderRename(selectedKey, oldName, trimmed);
      setSelectedSequences((prev) => {
        if (!prev.has(oldName)) return prev;
        const next = new Set(prev);
        next.delete(oldName);
        next.add(newName);
        return next;
      });
      await refreshSections();
    } catch (e) {
      showError({ message: "Rename failed.", error: e });
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
      await refreshSections();
    } catch (e) {
      showError({ message: "Duplicate sequence failed.", error: e });
    }
  }

  async function deleteSequence(name: string) {
    if (!selectedKey) return;
    const confirmed = await confirmAction({
      title: "Delete sequence",
      message: `Delete "${name}"? This cannot be undone.`,
      confirmText: "Delete",
    });
    if (!confirmed) return;
    try {
      await apiSequenceFolderDelete(selectedKey, name);
      await refreshSections();
    } catch (e) {
      showError({ message: "Delete sequence failed.", error: e });
    }
  }

  async function deleteGalleryImages(targetRelPaths: string[]) {
    if (!selectedKey || !targetRelPaths.length) return;

    const posePaths: string[] = [];
    const exprPaths: string[] = [];
    for (const relPath of targetRelPaths) {
      const inPose =
        charSectionsRaw?.poseSplit.visible.some((x) => x.relPath === relPath) ||
        charSectionsRaw?.poseSplit.hidden.some((x) => x.relPath === relPath);
      const inExpr =
        charSectionsRaw?.exprSplit.visible.some((x) => x.relPath === relPath) ||
        charSectionsRaw?.exprSplit.hidden.some((x) => x.relPath === relPath);
      if (inPose) posePaths.push(relPath);
      else if (inExpr) exprPaths.push(relPath);
    }

    if (!posePaths.length && !exprPaths.length) {
      showError({ message: "Image is not in this character gallery." });
      return;
    }

    const count = posePaths.length + exprPaths.length;
    const confirmed = await confirmAction({
      title: count > 1 ? "Delete images" : "Delete image",
      message:
        count > 1
          ? `Delete ${count} selected images?`
          : "Delete this gallery image?",
      confirmText: count > 1 ? "Delete all" : "Delete",
    });
    if (!confirmed) return;

    try {
      if (posePaths.length) {
        await apiPoseAnglesDelete(selectedKey, POSE_FLAT_FOLDER_KEY, posePaths);
      }
      if (exprPaths.length) {
        await apiExpressionAnglesDelete(selectedKey, POSE_FLAT_FOLDER_KEY, exprPaths);
      }
      setSelectedRelPaths((prev) => {
        const next = new Set(prev);
        for (const relPath of targetRelPaths) next.delete(relPath);
        return next.size === prev.size ? prev : next;
      });
      if (newPoseBaseRelPath && targetRelPaths.includes(newPoseBaseRelPath)) {
        setNewPoseBaseRelPath(null);
      }
      await refreshSections();
    } catch (e) {
      showError({ message: "Delete image failed.", error: e });
    }
  }

  async function deleteGalleryImageFromMenu(relPath: string) {
    const targetRelPaths =
      selectedRelPaths.size > 1 ? Array.from(selectedRelPaths) : [relPath];
    await deleteGalleryImages(targetRelPaths);
  }

  function openAiEditFromMenu(relPath: string) {
    const inPose =
      charSectionsRaw?.poseSplit.visible.some((x) => x.relPath === relPath) ||
      charSectionsRaw?.poseSplit.hidden.some((x) => x.relPath === relPath);
    const inExpr =
      charSectionsRaw?.exprSplit.visible.some((x) => x.relPath === relPath) ||
      charSectionsRaw?.exprSplit.hidden.some((x) => x.relPath === relPath);
    if (!inPose && !inExpr) {
      showError({ message: "Image is not in this character gallery." });
      return;
    }
    openAiEditForGallery({
      sourceRelPath: relPath,
      type: inPose ? "pose" : "expression",
      poseFolderKey: POSE_FLAT_FOLDER_KEY,
    });
  }

  async function applyNewAngle(angleId: number) {
    setAngleModalOpen(false);
    const relPath = angleSourceRelPath;
    setAngleSourceRelPath("");
    if (!selectedKey || !relPath) return;

    const inPose =
      charSectionsRaw?.poseSplit.visible.some((x) => x.relPath === relPath) ||
      charSectionsRaw?.poseSplit.hidden.some((x) => x.relPath === relPath);
    const inExpr =
      charSectionsRaw?.exprSplit.visible.some((x) => x.relPath === relPath) ||
      charSectionsRaw?.exprSplit.hidden.some((x) => x.relPath === relPath);
    if (!inPose && !inExpr) {
      showError({ message: "Source image is not in this character gallery." });
      return;
    }
    const angType = inPose ? "pose" : "expr";

    beginSession({ title: "Generating new angle", clearLog: true });
    await Promise.resolve();
    pushLog("Generating a new camera angle…");
    try {
      const [posesBefore, exprsBefore] = await Promise.all([
        apiPoseGallerySplit(selectedKey),
        apiExpressionGallerySplit(selectedKey),
      ]);
      const before = {
        pose: splitRelPaths(posesBefore),
        expr: splitRelPaths(exprsBefore),
      };

      const payload: Record<string, unknown> = {
        job: "angles",
        angleIds: [angleId],
        inputRelPath: relPath,
      };
      if (angType === "pose") {
        payload.poseKeys = [POSE_FLAT_FOLDER_KEY];
      } else {
        payload.exprKeys = [POSE_FLAT_FOLDER_KEY];
      }

      const done = await runDetailWsJob({
        charKey: selectedKey,
        pathSuffix: angType === "pose" ? "/pose/ws" : "/expression/ws",
        payload,
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok) throw new Error(done.error || "Angle generation failed.");

      pushLog("Done.");
      await refreshSections();

      const [posesAfter, exprsAfter] = await Promise.all([
        apiPoseGallerySplit(selectedKey),
        apiExpressionGallerySplit(selectedKey),
      ]);
      const after = {
        pose: splitRelPaths(posesAfter),
        expr: splitRelPaths(exprsAfter),
      };
      const newPaths = newRelPathsFromSplits(before, after);
      if (newPaths.length) {
        setSelectedRelPaths((prev) => new Set([...prev, ...newPaths]));
      }
      endSession();
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
                    ...(slot.placedFigure ? { placedFigure: slot.placedFigure } : {}),
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

  const openFrameEditor = useCallback(
    (seqName: string) => {
      if (!selectedKey) return;
      setPickerSeqEditor({ charKey: selectedKey, sequenceName: seqName });
    },
    [selectedKey]
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

  const generateReferencePreview = useCallback(
    async (args: {
      kind: ReferenceMediaKind;
      promptText: string;
      width: number;
      height: number;
      length?: number;
    }) => {
      try {
        beginSession({
          title: "Generating base reference…",
          clearLog: true,
          runningStatus: "Generating base reference…",
        });
        const done = await runReferenceGenerateWsJob({
          ...args,
          onLogLine: (line) => {
            onJobLogLine(line);
          },
        });
        if (!done.ok || !done.result) {
          throw new Error(done.error ?? "Reference generation failed");
        }
        endSession();
        return done.result;
      } catch (error) {
        failSession(error, "Failed to generate base reference.");
        return null;
      }
    },
    [beginSession, endSession, failSession, onJobLogLine]
  );

  const saveGeneratedReferenceAsKeypoint = useCallback(
    async (preview: GeneratedReferencePreview) => {
      try {
        beginSession({
          title: "Saving reference as keypoint…",
          clearLog: true,
          runningStatus: "Starting keypoint conversion…",
        });
        if (preview.kind === "video") {
          const done = await runReferenceMakeKeypointVideoWsJob({
            videoRelPath: preview.previewRelPath,
            fps: preview.fps,
            onLogLine: onJobLogLine,
          });
          if (!done.ok || !done.result) {
            throw new Error(done.error ?? "Video keypoint generation failed");
          }
          setNewPoseRef({ kind: "video", ref: done.result.item });
        } else {
          const done = await runReferenceMakeKeypointWsJob({
            imageRelPath: preview.previewRelPath,
            onLogLine: onJobLogLine,
          });
          if (!done.ok || !done.result) {
            throw new Error(done.error ?? "Keypoint generation failed");
          }
          setNewPoseRef({
            kind: "single",
            ref: {
              id: done.result.item.id,
              referenceRelPath: done.result.item.referenceRelPath,
              keypointRelPath: done.result.item.keypointRelPath,
            },
          });
        }
        setPoseBatchQueue([]);
        setReferencePickerRefreshToken((value) => value + 1);
        setReferenceGenerateOpen(false);
        endSession();
      } catch (error) {
        failSession(error, "Failed to save the generated reference as keypoints.");
      }
    },
    [beginSession, endSession, failSession, onJobLogLine]
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
          pointerEvents: timelineExternalDragActive ? "none" : "auto",
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
            pointerEvents: "auto",
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
                {sectionsLoading && !sectionData && <div style={{ opacity: 0.6, fontSize: 13, padding: 12 }}>Loading…</div>}
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
                      enableSequenceDragSource={!poseChangeMode}
                      onSequenceDragStateChange={setGalleryDragActive}
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
                      enableSequenceDragSource={!poseChangeMode}
                      onSequenceDragStateChange={setGalleryDragActive}
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
                                disabled={poseBusy || seqDropBusy}
                                dropHighlight={galleryDragActive && seqDropHover === seq.name}
                                onDragOver={(e) => {
                                  if (!galleryDragActive || poseBusy) return;
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = "copy";
                                  setSeqDropHover(seq.name);
                                }}
                                onDragLeave={() => {
                                  setSeqDropHover((h) => (h === seq.name ? null : h));
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  setSeqDropHover(null);
                                  setGalleryDragActive(false);
                                  if (!selectedKey || poseBusy) return;
                                  const relPath = parseSequenceBuilderDrop(e);
                                  if (!relPath) return;
                                  setSeqDropBusy(true);
                                  void (async () => {
                                    try {
                                      await addImageToSequenceGallery(selectedKey, seq.name, relPath);
                                      await refreshSections();
                                    } catch (err) {
                                      showError({ message: "Could not add image to sequence.", error: err });
                                    } finally {
                                      setSeqDropBusy(false);
                                    }
                                  })();
                                }}
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
                                  editingSeqName === seq.name ? (
                                    <input
                                      autoFocus
                                      value={editingSeqDraft}
                                      onChange={(e) => setEditingSeqDraft(e.target.value)}
                                      onBlur={() => void renameSequence(seq.name, editingSeqDraft)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") { e.currentTarget.blur(); }
                                        if (e.key === "Escape") { e.preventDefault(); setEditingSeqName(null); }
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                      onDoubleClick={(e) => e.stopPropagation()}
                                      style={{
                                        width: "100%",
                                        fontSize: 10,
                                        textAlign: "center",
                                        background: "rgba(255,255,255,0.1)",
                                        border: "1px solid rgba(255,255,255,0.35)",
                                        color: "#eee",
                                        padding: "1px 4px",
                                        boxSizing: "border-box",
                                        outline: "none",
                                      }}
                                    />
                                  ) : (
                                    <div
                                      style={{
                                        fontSize: 10,
                                        color: "#aaa",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                        textAlign: "center",
                                        cursor: "text",
                                      }}
                                      onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        setEditingSeqName(seq.name);
                                        setEditingSeqDraft(seq.name);
                                      }}
                                    >
                                      {seq.name}
                                    </div>
                                  )
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
              openAiEditFromMenu(relPath);
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
            AI Edit
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
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const { relPath } = imgCtxMenu;
              setImgCtxMenu(null);
              void deleteGalleryImageFromMenu(relPath);
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 14px",
              background: "transparent",
              color: "#f87171",
              border: "none",
              borderTop: "1px solid rgba(255,255,255,0.1)",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            {selectedRelPaths.size > 1 ? "Delete all" : "Delete"}
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
              setEditingSeqName(name);
              setEditingSeqDraft(name);
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
            Rename
          </button>
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
              void openFrameEditor(name);
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
            Edit Frames
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
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const { name } = seqCtxMenu;
              setSeqCtxMenu(null);
              void deleteSequence(name);
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 14px",
              background: "transparent",
              color: "#f87171",
              border: "none",
              borderTop: "1px solid rgba(255,255,255,0.1)",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            Delete
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

      <AiEditModal {...aiEditModalProps} />

      {/* Reference picker — includes Motion Ref Gen (KiMoD) option */}
      <ReferencePicker
        open={refPickerOpen}
        charKey={selectedKey ?? ""}
        busy={poseBusy}
        onCancel={() => {
          setReferenceGenerateOpen(false);
          setRefPickerOpen(false);
        }}
        onUseSelected={(sel) => {
          setRefPickerOpen(false);
          const queue = buildKeypointRefQueueFromSelection(sel);
          if (!queue.length) return;
          setNewPoseRef(queue[0]);
          setPoseBatchQueue(queue.length > 1 ? queue : []);
        }}
        onPickNew={() => setRefPickerOpen(false)}
        onOpenGenerateBase={() => setReferenceGenerateOpen(true)}
        refreshToken={referencePickerRefreshToken}
        onOpenMotionRef={() => {
          setRefPickerOpen(false);
          setMotionRefOpen(true);
        }}
        jobModal={{ begin: beginSession, end: endSession, fail: failSession, log: pushLog }}
      />

      <ReferenceGenerateModal
        open={referenceGenerateOpen}
        busy={poseBusy}
        saveLabel={(preview) =>
          preview.kind === "video" ? "Save as Video Keypoint" : "Save as Keypoint"
        }
        zIndex={10100}
        onCancel={() => setReferenceGenerateOpen(false)}
        onGenerate={generateReferencePreview}
        onCommit={saveGeneratedReferenceAsKeypoint}
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

      {pickerSeqEditor ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 10040,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            pointerEvents: timelineExternalDragActive ? "none" : "auto",
          }}
          onMouseDown={() => setPickerSeqEditor(null)}
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
              <div>Sequence: {pickerSeqEditor.sequenceName}</div>
              <button
                type="button"
                onClick={() => setPickerSeqEditor(null)}
                style={{ borderRadius: 0, border: "1px solid rgba(0,0,0,0.5)", background: "transparent", padding: "4px 12px", cursor: "pointer" }}
              >
                Close
              </button>
            </div>
            <SequenceEditor
              charKey={pickerSeqEditor.charKey}
              sequenceName={pickerSeqEditor.sequenceName}
              onError={(msg, err) => showError({ message: msg, error: err })}
              onAiEditSequenceGallery={(ctx) =>
                openAiEditSequenceGallery({
                  sourceRelPath: ctx.relPath,
                  galleryItemId: ctx.galleryItemId,
                  sequenceName: pickerSeqEditor.sequenceName,
                })
              }
              jobModal={{ begin: beginSession, end: endSession, fail: failSession, log: pushLog }}
              onDropImageToTimeline={onDropImageToTimeline}
              onTimelineExternalDragActiveChange={onTimelineExternalDragActiveChange}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
