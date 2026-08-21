"use client";

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  apiPoseAnglesDelete,
  apiPoseEnsureBase,
  apiPoseGalleryHidden,
  apiPoseGallerySplit,
  apiPoseGalleryUiState,
  apiPoseImportStarting,
  apiPoseImportStartingFromRel,
  apiExpressionAnglesDelete,
  apiExpressionGalleryHidden,
  apiExpressionGallerySplit,
  apiExpressionGalleryUiState,
  apiExpressionImportStarting,
  apiExpressionImportStartingFromRel,
  apiGalleryDownloadZip,
  apiHubCover,
  assetDownloadUrlFromRelPath,
  assetUrlFromRelPath,
  apiUploadStaging,
  CoverCandidate,
  GallerySplit,
  GallerySplitItem,
  PoseReference,
  type KeypointVideoReference,
  runDetailWsJob,
  runReferenceMakeKeypointWsJob,
  runReferenceMakeKeypointVideoWsJob,
  runShotRemoveBgWsJob,
  type RemoveBgImageRunOptions,
  runShotMakeAngleWsJob,
  apiSequenceFolderOrder,
  apiSequenceCreate,
  apiSequenceGet,
  apiSequencePut,
  apiSequenceFolderDelete,
  apiSequenceFolderDuplicate,
  apiSequenceFolderRename,
  type SequenceManifest,
  API_BASE_URL,
} from "../../../../lib/api";
import {
  keypointRefToGenRef,
  runCharacterGeneration,
} from "../../../../lib/characterGeneration";
import { fetchVideoExport, runVideoExportJob, sanitizeDownloadBaseName } from "../../../../lib/downloadVideo";
import { SequenceEditor } from "../dataset/SequenceEditor";
import { SequencePreviewLightbox } from "../dataset/SequencePreviewLightbox";
import { SequenceWorkspaceShell } from "../../../../components/sequenceWorkspace/SequenceWorkspaceShell";
import { addImageToSequenceGallery } from "../dataset/datasetSequenceDrop";
import {
  SortableMultiGrid,
  SortableItemInContainer,
  UseDragOverlayCloneContext,
} from "../../../../components/dnd/SortableMultiGrid";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { reorderInsertBeforeOrAfter } from "../../../../components/dnd/reorder";

type GenType = "pose" | "expression";
import { buildFlatGalleryLightboxPaths } from "../../../../lib/galleryLightboxOrder";
import { batchRefPreviewFramePaths } from "../../../../lib/batchRefPreview";
import {
  type KeypointRefEntry,
  keypointRefHasFrames,
  keypointRefPreviewFps,
} from "../../../../lib/keypointRefGeneration";
import { CameraAngleModal } from "../../../../components/CameraAngleModal";
import { DesktopContextMenu, ContextMenuItem } from "../../../../components/DesktopContextMenu";
import { DetailSubpageChrome } from "../../../../components/DetailSubpageChrome";
import {
  ImagePickerModal,
  type ImagePickerSection,
} from "../../../../components/ImagePickerModal";
import { AiEditModal } from "../../../../components/AiEditModal";
import type { SharedLogStreamHandle } from "../../../../components/SharedLogStream";
import { ConnectedJobRunModal } from "../../../../components/ConnectedJobRunModal";
import { RemoveBgImageModal } from "../../../../components/removeBg/RemoveBgImageModal";
import { useJobRunSession } from "../../../../hooks/useJobRunSession";
import { useCharacterGalleryAiEdit } from "../../../../hooks/useCharacterGalleryAiEdit";
import { useCharacterSections } from "../../../../hooks/useCharacterSections";
import {
  ReferencePicker,
  type ReferencePickerSelection,
} from "../../../../components/ReferencePicker";
import { StartingImagePreview } from "../../../../components/StartingImagePreview";
import { buildKeypointRefQueueFromSelection } from "../../../../lib/referencePickerSelection";
import { KeypointReferenceSlot } from "../../../../components/KeypointReferenceSlot";
import { PoseRefFramePreview } from "../../../../components/PoseRefFramePreview";
import { GalleryImageLightbox } from "../../../../components/GalleryImageLightbox";
import { SquareButton } from "../../../../components/SquareButton";
import { useAppError } from "../../../../components/ErrorProvider";
import { ResizableScrollGallery } from "../../../../components/ResizableScrollGallery";
import { truncateJobModalStatusLine } from "../../../../lib/jobModalStatus";
/** Server bucket key for the flat pose gallery (see ``POSE_FLAT_BUCKET`` in logic). */
const POSE_FLAT_FOLDER_KEY = "flat";

type StartingImageState = { stack: string[]; index: number };

type BatchRefEntry = KeypointRefEntry;

type ActiveReference = KeypointRefEntry;

function mergeStackAfterGeneration(prev: StartingImageState, lastRel: string): StartingImageState {
  const idx = Math.min(Math.max(0, prev.index), Math.max(0, prev.stack.length - 1));
  const trimmed = prev.stack.slice(0, idx + 1);
  const tail = trimmed[trimmed.length - 1];
  const nextStack = tail === lastRel ? trimmed : [...trimmed, lastRel];
  return { stack: nextStack, index: Math.max(0, nextStack.length - 1) };
}

function removeStackAtIndex(prev: StartingImageState, at: number): StartingImageState {
  const next = prev.stack.filter((_, j) => j !== at);
  let newIdx = prev.index;
  if (at < prev.index) newIdx = prev.index - 1;
  else if (at === prev.index) newIdx = Math.min(prev.index, Math.max(0, next.length - 1));
  else newIdx = Math.min(prev.index, next.length - 1);
  newIdx = Math.max(0, Math.min(newIdx, Math.max(0, next.length - 1)));
  return { stack: next, index: newIdx };
}

function pruneRelFromStack(prev: StartingImageState, rel: string): StartingImageState {
  const at = prev.stack.indexOf(rel);
  if (at === -1) return prev;
  return removeStackAtIndex(prev, at);
}

function appendStartingFromLibrary(prev: StartingImageState, relPath: string): StartingImageState {
  const existing = prev.stack.indexOf(relPath);
  if (existing >= 0) {
    return { ...prev, index: existing };
  }
  const next = [...prev.stack, relPath];
  return { stack: next, index: next.length - 1 };
}

/** When ``pose_000`` is in the picker list, drop redundant ``starting_image`` and root ``base`` / ``base_img`` copies. */
function dedupeStartingCandidatesForPose000(candidates: CoverCandidate[]): CoverCandidate[] {
  const hasPose000 = candidates.some((c) => /(^|[\\/])pose_000\./i.test(c.relPath));
  if (!hasPose000) return candidates;
  return candidates.filter((c) => {
    const r = c.relPath;
    if (/(^|[\\/])starting_image\./i.test(r)) return false;
    const inPoseOrExprGallery = /[\\/]poses[\\/]/i.test(r) || /[\\/]expressions[\\/]/i.test(r);
    if (inPoseOrExprGallery) return true;
    if (/(^|[\\/])(base_img|base)\.(png|jpg|jpeg|webp|bmp)$/i.test(r)) return false;
    return true;
  });
}

/** Best-effort image preload so an id/URL swap doesn't flash blank. Resolves on load/error/timeout. */
function preloadImage(url: string, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    const done = () => resolve();
    img.onload = done;
    img.onerror = done;
    img.src = url;
    setTimeout(done, timeoutMs);
  });
}

/** Infer whether a storage path belongs to the Pose or Expression gallery. */
function detectGenTypeFromRel(rel: string): GenType | null {
  if (/[\\/]expressions[\\/]/i.test(rel)) return "expression";
  if (/[\\/]poses[\\/]/i.test(rel)) return "pose";
  return null;
}

export default function CreatePage() {
  const router = useRouter();
  const { showError, askText, confirmAction } = useAppError();
  const params = useParams<{ charKey: string }>();
  const charKey = params?.charKey ?? "";

  // Active generation type. Drives every pose-vs-expression API + endpoint below,
  // and acts as the "marker" so a starting image can't be used for the wrong type.
  const [genType, setGenType] = useState<GenType>("pose");
  const isPose = genType === "pose";
  const wsSuffix = isPose ? "/pose/ws" : "/expression/ws";

  // Import helpers differ only by their folder-name param across the two services.
  function importStartingFileForType(file: File, folderName: string, type: GenType = genType) {
    return type === "pose"
      ? apiPoseImportStarting({ charKey, file, poseFolderName: folderName })
      : apiExpressionImportStarting({ charKey, file, expressionFolderName: folderName });
  }
  function importFromRelForType(sourceRelPath: string, folderName: string, type: GenType = genType) {
    return type === "pose"
      ? apiPoseImportStartingFromRel({ charKey, sourceRelPath, poseFolderName: folderName })
      : apiExpressionImportStartingFromRel({ charKey, sourceRelPath, expressionFolderName: folderName });
  }

  const { data: charSections, refresh: refreshCharSections } = useCharacterSections(charKey);
  const poseSplit = charSections?.poseSplit ?? null;
  const exprSplit = charSections?.exprSplit ?? null;
  const [sequences, setSequences] = useState<{ name: string; thumb: string | null }[]>([]);
  useEffect(() => {
    setSequences(charSections?.sequences.map((s) => ({ name: s.name, thumb: s.coverRelPath || null })) ?? []);
  }, [charSections]);

  // Per-item type for context actions invoked from any section (incl. shared Hidden).
  const [angleItem, setAngleItem] = useState<{ item: GallerySplitItem; type: GenType } | null>(null);
  const [selectedExpr, setSelectedExpr] = useState<Set<string>>(new Set());
  // Sequence section state.
  const [activeSequence, setActiveSequence] = useState<string | null>(null);
  const [seqPreview, setSeqPreview] = useState<{ name: string; manifest: SequenceManifest } | null>(null);
  const sequenceFlushRef = useRef<(() => Promise<void>) | null>(null);

  const [starting, setStarting] = useState<StartingImageState>({ stack: [], index: 0 });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSections, setPickerSections] = useState<ImagePickerSection[]>([]);


  // Single-prompt generate (the batch prompt/catalog checklist moved to the dataset Batch Generate).
  const [singlePrompt, setSinglePrompt] = useState<string>("");

  const [selectedPose, setSelectedPose] = useState<Set<string>>(new Set());
  const [poseGalleryAnchorItemId, setPoseGalleryAnchorItemId] = useState<string | null>(null);
  const [exprGalleryAnchorItemId, setExprGalleryAnchorItemId] = useState<string | null>(null);

  const [angleDialogOpen, setAngleDialogOpen] = useState(false);
  const [angleDialogImageUrl, setAngleDialogImageUrl] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const logRef = useRef<SharedLogStreamHandle>(null);
  const {
    running: jobRunning,
    beginSession,
    endSession,
    failSession,
    setTitle,
    pushLog,
    onJobLogLine,
    setRunningStatus,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);
  const uiBusy = busy || jobRunning;

  const {
    openAiEditForGallery,
    openAiEditSequenceGallery: openAiEditSequenceGalleryBase,
    aiEditModalProps,
  } = useCharacterGalleryAiEdit({
    charKey,
    refreshSections: refreshCharSections,
    beginSession,
    endSession,
    failSession,
    onJobLogLine,
    showError,
    busy: uiBusy,
  });

  // Sequence gallery-frame "New Angle" (right-click a frame in the editor).
  const [seqAngleOpen, setSeqAngleOpen] = useState(false);
  const [seqAngleImageUrl, setSeqAngleImageUrl] = useState<string | null>(null);
  const seqAngleCtxRef = useRef<{ seqName: string; galleryItemId: string; relPath: string } | null>(null);

  const [removeBgImageOpen, setRemoveBgImageOpen] = useState(false);
  const removeBgPendingRef = useRef<{ item: GallerySplitItem; type: GenType } | null>(null);

  const [activeReference, setActiveReference] = useState<ActiveReference | null>(null);
  const [batchRefQueue, setBatchRefQueue] = useState<BatchRefEntry[]>([]);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [referencePickerRefreshToken, setReferencePickerRefreshToken] = useState(0);
  // Single shared file-import input (routes into genType gallery).
  const sharedImportInputRef = useRef<HTMLInputElement | null>(null);
  const [sharedImportDragOver, setSharedImportDragOver] = useState(false);

  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    items: ContextMenuItem[];
  }>({ open: false, x: 0, y: 0, items: [] });
  const [sequenceVideoExportBusy, setSequenceVideoExportBusy] = useState<string | null>(null);

  const [lightbox, setLightbox] = useState<{
    paths: string[];
    index: number;
    title: string;
  } | null>(null);

  const [dragContainers, setDragContainers] = useState<{
    poseVisible: string[];
    poseHidden: string[];
    exprVisible: string[];
    exprHidden: string[];
  }>({ poseVisible: [], poseHidden: [], exprVisible: [], exprHidden: [] });
  // Which gallery container the pointer is currently over during a drag (for the drop highlight).
  const [overContainerId, setOverContainerId] = useState<string | null>(null);
  // The container a gallery drag started in (so we only highlight cross-gallery targets).
  const [dragSourceContainer, setDragSourceContainer] = useState<string | null>(null);
  const [poseOpen, setPoseOpen] = useState(true);
  const [exprOpen, setExprOpen] = useState(true);
  const [seqOpen, setSeqOpen] = useState(true);
  const [hiddenOpen, setHiddenOpen] = useState(true);

  // Combined item pool across both galleries — lets renderItem/renderDragOverlay resolve a tile by
  // id even right after an optimistic cross-section move (before refreshGallery swaps the id).
  const allGalleryItems = useMemo(
    () => [
      ...(poseSplit?.visible ?? []),
      ...(poseSplit?.hidden ?? []),
      ...(exprSplit?.visible ?? []),
      ...(exprSplit?.hidden ?? []),
    ],
    [poseSplit, exprSplit]
  );

  useEffect(() => {
    if (busy) return;
    setDragContainers({
      poseVisible: (poseSplit?.visible ?? []).map((x) => x.itemId),
      poseHidden:  (poseSplit?.hidden  ?? []).map((x) => x.itemId),
      exprVisible: (exprSplit?.visible ?? []).map((x) => x.itemId),
      exprHidden:  (exprSplit?.hidden  ?? []).map((x) => x.itemId),
    });
  }, [poseSplit, exprSplit, busy]);

  const openAiEditForPose = useCallback(
    (poseFolderKey: string, sourceRelPath: string, type: GenType = genType) => {
      openAiEditForGallery({ sourceRelPath, type, poseFolderKey });
    },
    [openAiEditForGallery, genType]
  );

  const openAiEditSequenceGallery = useCallback(
    (ctx: { relPath: string; galleryItemId: string }) => {
      if (!activeSequence) {
        showError({ message: "AI Edit: sequence name missing." });
        return;
      }
      openAiEditSequenceGalleryBase({
        sourceRelPath: ctx.relPath,
        galleryItemId: ctx.galleryItemId,
        sequenceName: activeSequence,
      });
    },
    [activeSequence, openAiEditSequenceGalleryBase, showError]
  );

  // New Angle on a Sequence gallery frame.
  const openNewAngleSequenceGallery = useCallback(
    (ctx: { relPath: string; galleryItemId: string }) => {
      if (!activeSequence) {
        showError({ message: "New Angle: sequence name missing." });
        return;
      }
      const rel = (ctx.relPath || "").trim();
      if (!rel) {
        showError({ message: "New Angle: source image not found." });
        return;
      }
      seqAngleCtxRef.current = { seqName: activeSequence, galleryItemId: ctx.galleryItemId, relPath: rel };
      setSeqAngleImageUrl(assetUrlFromRelPath(rel));
      setSeqAngleOpen(true);
    },
    [activeSequence, showError]
  );

  async function applyNewAngleSequenceGallery(angleId: number) {
    setSeqAngleOpen(false);
    const ctx = seqAngleCtxRef.current;
    seqAngleCtxRef.current = null;
    if (!charKey || !ctx) return;
    await beginSession({ title: "Generating new angle", clearLog: true });
    try {
      const done = await runShotMakeAngleWsJob({
        imageRelPath: ctx.relPath,
        angleId,
        onLogLine: (line) => logRef.current?.pushLine(line),
      });
      const newRel = done.result?.relPath;
      if (!done.ok || !newRel) {
        throw new Error(done.error ?? "Angle generation returned no image.");
      }
      const manifest = await apiSequenceGet(charKey, ctx.seqName);
      const gi = manifest.gallery.findIndex((g) => g.id === ctx.galleryItemId);
      if (gi < 0) throw new Error("New Angle: sequence gallery item no longer exists");
      const nextGallery = manifest.gallery.map((g, i) =>
        i === gi ? { ...g, relPath: newRel } : g
      );
      await apiSequencePut(charKey, ctx.seqName, { ...manifest, gallery: nextGallery });
      await refreshCharSections();
      endSession();
    } catch (err) {
      failSession(err, "New Angle failed.");
    }
  }

  const activeStartingRel = useMemo(() => {
    const { stack, index } = starting;
    if (!stack.length) return null;
    const i = Math.min(Math.max(0, index), stack.length - 1);
    return stack[i] ?? null;
  }, [starting]);

  const reseedStartingFromHub = useCallback(async () => {
    if (!charKey) return;
    try {
      const { relPath } =
        genType === "pose" ? await apiPoseEnsureBase(charKey) : await apiHubCover(charKey);
      if (relPath) setStarting({ stack: [relPath], index: 0 });
    } catch {
      /* no base in gallery */
    }
  }, [charKey, genType]);

  const onStartingPreviewError = useCallback(() => {
    showError({
      title: "Starting image",
      message:
        "Starting image is missing (it may have been moved, renamed, or hidden). Removed from preview.",
    });
    setStarting((prev) => {
      const rel = prev.stack[prev.index];
      if (!rel) return prev;
      const next = pruneRelFromStack(prev, rel);
      if (next.stack.length === 0) {
        void reseedStartingFromHub();
      }
      return next;
    });
  }, [showError, reseedStartingFromHub]);

  const deleteStartingCacheEntry = useCallback(() => {
    setStarting((prev) => {
      if (prev.stack.length === 0) return prev;
      return removeStackAtIndex(prev, prev.index);
    });
  }, []);

  const clearPosePromptUiForKeypointReference = useCallback(() => {
    setSinglePrompt("");
  }, []);

  const onReferencePickNew = useCallback(
    async (file: File) => {
      if (!charKey) return;
      setReferencePickerOpen(false);
      const isVideo = file.type.startsWith("video/");
      let uploadComplete = false;
      try {
        await beginSession({
          title: isVideo ? "Uploading reference video…" : "Uploading reference image…",
          clearLog: true,
          runningStatus: isVideo
            ? "Uploading reference video…"
            : "Uploading reference image…",
        });
        const { relPath } = await apiUploadStaging({ charKey, file });
        uploadComplete = true;
        setTitle(
          isVideo
            ? "Converting video to keypoint sequence"
            : "Converting image to pose keypoints"
        );
        setRunningStatus("Starting keypoint conversion…");
        pushLog("Upload complete. Starting keypoint job…");
        if (isVideo) {
          const done = await runReferenceMakeKeypointVideoWsJob({
            videoRelPath: relPath,
            onLogLine: (line) => {
              logRef.current?.pushLine(line);
              setRunningStatus(truncateJobModalStatusLine(line));
            },
          });
          if (!done.ok) throw new Error(done.error ?? "Video keypoint generation failed");
          if (done.result) {
            setActiveReference({ kind: "video", ref: done.result.item });
            clearPosePromptUiForKeypointReference();
          }
        } else {
          const done = await runReferenceMakeKeypointWsJob({
            imageRelPath: relPath,
            onLogLine: (line) => {
              logRef.current?.pushLine(line);
              setRunningStatus(truncateJobModalStatusLine(line));
            },
          });
          if (!done.ok) throw new Error(done.error ?? "Keypoint generation failed");
          if (done.result) {
            setActiveReference({
              kind: "single",
              ref: {
                id: done.result.item.id,
                referenceRelPath: done.result.item.referenceRelPath,
                keypointRelPath: done.result.item.keypointRelPath,
              },
            });
            clearPosePromptUiForKeypointReference();
          }
        }
        endSession();
      } catch (err) {
        failSession(
          err,
          uploadComplete
            ? "Failed to generate keypoints."
            : isVideo
            ? "Failed to upload reference video."
            : "Failed to upload reference image."
        );
      }
    },
    [
      beginSession,
      charKey,
      clearPosePromptUiForKeypointReference,
      endSession,
      failSession,
      pushLog,
      setRunningStatus,
      setTitle,
    ]
  );

  const onReferencePickSaved = useCallback((ref: PoseReference) => {
    setActiveReference({ kind: "single", ref });
    setBatchRefQueue([]);
    if ((ref.keypointRelPath || "").trim()) {
      clearPosePromptUiForKeypointReference();
    }
  }, [clearPosePromptUiForKeypointReference]);

  async function onReferenceUseSelected(sel: ReferencePickerSelection) {
    const { singles, videos, folders } = sel;
    if (!singles.length && !videos.length && !folders.length) return;
    setReferencePickerOpen(false);
    const total = singles.length + videos.length + folders.length;
    if (total === 1) {
      setBatchRefQueue([]);
      if (folders.length === 1) {
        const f = folders[0];
        setActiveReference({
          kind: "folder",
          folderId: f.folder.id,
          folderName: f.folder.name,
          keypoints: f.keypoints,
        });
        clearPosePromptUiForKeypointReference();
        return;
      }
      if (videos.length === 1) {
        setActiveReference({ kind: "video", ref: videos[0] });
        clearPosePromptUiForKeypointReference();
        return;
      }
      onReferencePickSaved(singles[0]);
      return;
    }
    const queue = buildKeypointRefQueueFromSelection(sel);
    setBatchRefQueue(queue);
    setActiveReference(queue[0]);
    clearPosePromptUiForKeypointReference();
  }

  // Initial load (per character): galleries, sequences, and a default Pose starting image.
  useEffect(() => {
    if (!charKey) return;
    setStarting({ stack: [], index: 0 });
    setSelectedPose(new Set());
    setSelectedExpr(new Set());
    setActiveReference(null);
    clearPosePromptUiForKeypointReference();
    (async () => {
      const ensured = await apiPoseEnsureBase(charKey);
      await refreshCharSections();
      if (ensured.relPath) {
        setStarting({ stack: [ensured.relPath], index: 0 });
      }
    })().catch(() => {});
  }, [charKey, refreshCharSections, clearPosePromptUiForKeypointReference]);

  async function loadStartingImageCandidates(): Promise<{
    pose: CoverCandidate[];
    expression: CoverCandidate[];
  }> {
    if (!charKey) return { pose: [], expression: [] };
    const [pose, expr] = await Promise.all([
      apiPoseGallerySplit(charKey),
      apiExpressionGallerySplit(charKey),
    ]);
    const all = [
      ...pose.visible.map((x) => ({ kind: "pose" as const, folderKey: x.folderKey, relPath: x.relPath })),
      ...pose.hidden.map((x) => ({ kind: "pose" as const, folderKey: x.folderKey, relPath: x.relPath })),
      ...expr.visible.map((x) => ({ kind: "expr" as const, folderKey: x.folderKey, relPath: x.relPath })),
      ...expr.hidden.map((x) => ({ kind: "expr" as const, folderKey: x.folderKey, relPath: x.relPath })),
    ].filter((x) => Boolean(x.relPath));

    const seen = new Set<string>();
    const out: CoverCandidate[] = [];
    for (const it of all) {
      if (!it.relPath || seen.has(it.relPath)) continue;
      seen.add(it.relPath);
      out.push({ relPath: it.relPath, caption: `${it.kind}:${it.folderKey}` });
    }
    const combined = dedupeStartingCandidatesForPose000(out);
    const poseList: CoverCandidate[] = [];
    const expressionList: CoverCandidate[] = [];
    for (const c of combined) {
      if (/[\\/]expressions[\\/]/i.test(c.relPath)) expressionList.push(c);
      else poseList.push(c);
    }
    return { pose: poseList, expression: expressionList };
  }

  async function chooseInputFromLibrary() {
    if (!charKey) return;
    try {
      setBusy(true);
      const { pose, expression } = await loadStartingImageCandidates();
      setPickerSections([
        { title: "Pose", images: pose, defaultOpen: true },
        { title: "Expression", images: expression, defaultOpen: true },
      ]);
      setPickerOpen(true);
    } catch (err) {
      showError({ message: "Failed to load starting image candidates.", error: err });
    } finally {
      setBusy(false);
    }
  }

  async function importRelPathIntoCurrentPoseGallery(relPath: string, type: GenType = genType) {
    if (!charKey) return;
    try {
      setBusy(true);
      const parts = relPath.split("/").filter(Boolean);
      const fileName = parts.length ? parts[parts.length - 1] : "image.png";
      const labelStem = fileName.replace(/\.[^.]+$/, "") || "import";

      await importFromRelForType(relPath, labelStem, type);
      await refreshCharSections();
    } catch (err) {
      showError({ message: "Adding image to gallery failed.", error: err });
    } finally {
      setBusy(false);
    }
  }

  function openRemoveBgForPoseItem(item: GallerySplitItem, type: GenType = genType) {
    if (!charKey || !item.relPath) return;
    removeBgPendingRef.current = { item, type };
    setRemoveBgImageOpen(true);
  }

  async function runRemoveBgImage(options: RemoveBgImageRunOptions) {
    const pending = removeBgPendingRef.current;
    setRemoveBgImageOpen(false);
    removeBgPendingRef.current = null;
    if (!pending?.item.relPath || !charKey) return;
    const { item, type } = pending;
    await beginSession({ title: "Removing background", clearLog: true });
    try {
      const done = await runShotRemoveBgWsJob({
        imageRelPath: item.relPath,
        engine: options.engine,
        rmbg: options.rmbg,
        animeSeg: options.animeSeg,
        onLogLine: (line) => logRef.current?.pushLine(line),
      });
      const newRel = done.result?.relPath;
      if (!done.ok || !newRel) throw new Error(done.error ?? "Remove background failed");
      const stem =
        ((item.relPath.split("/").pop() ?? "image").replace(/\.[^.]+$/, "") || "image") + "_nobg";
      await importFromRelForType(newRel, stem, type);
      await refreshCharSections();
      endSession();
    } catch (e) {
      failSession(e, "Remove background failed.");
    }
  }

  async function removeBgForPoseItem(item: GallerySplitItem, type: GenType = genType) {
    openRemoveBgForPoseItem(item, type);
  }

  function filterImageFiles(fileList: Iterable<File> | null | undefined): File[] {
    return Array.from(fileList ?? []).filter(
      (f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name)
    );
  }

  // Open the lightbox over an explicit list of gallery items.
  function openLightboxFor(items: GallerySplitItem[], itemId: string, title: string) {
    const withRel = items.filter((x) => Boolean(x.relPath));
    const idx = withRel.findIndex((x) => x.itemId === itemId);
    if (idx < 0) return;
    setLightbox({ paths: withRel.map((x) => assetUrlFromRelPath(x.relPath)), index: idx, title });
  }

  function openLightboxForType(type: GenType, itemId: string) {
    const dc = type === "pose"
      ? { visible: dragContainers.poseVisible, hidden: dragContainers.poseHidden }
      : { visible: dragContainers.exprVisible, hidden: dragContainers.exprHidden };
    const sp = type === "pose" ? poseSplit : exprSplit;
    const built = buildFlatGalleryLightboxPaths(sp, dc, itemId, {
      visible: type === "pose" ? "Pose gallery" : "Expression gallery",
      hidden: type === "pose" ? "Pose gallery (hidden)" : "Expression gallery (hidden)",
    });
    if (built) setLightbox(built);
  }

  function openPoseMenu(
    e: React.MouseEvent,
    item: GallerySplitItem,
    isHidden: boolean,
    menuType: GenType = genType
  ) {
    e.preventDefault();
    e.stopPropagation();
    const x = e.clientX;
    const y = e.clientY;
    const hiddenFn = menuType === "pose" ? apiPoseGalleryHidden : apiExpressionGalleryHidden;
    const deleteFn = menuType === "pose" ? apiPoseAnglesDelete : apiExpressionAnglesDelete;
    const dropFromSel = (id: string) => {
      if (menuType !== genType) return;
      setSelectedPose((prev) => {
        const n = new Set(prev);
        n.delete(id);
        return n;
      });
    };
    void (async () => {
      const items: ContextMenuItem[] = [];
      items.push({
        key: "aiEdit",
        label: "AI Edit",
        onSelect: () => openAiEditForPose(item.folderKey, item.relPath, menuType),
      });
      if (isHidden) {
        items.push({
          key: "unhide",
          label: "Unhide",
          onSelect: () => {
            void hiddenFn(charKey, [item.itemId], false).then(() => {
              void refreshCharSections();
              dropFromSel(item.itemId);
            });
          },
        });
        items.push({
          key: "removeBg",
          label: "Remove Background…",
          onSelect: () => openRemoveBgForPoseItem(item, menuType),
        });
      } else {
        items.push({
          key: "addAngle",
          label: "New Angle",
          onSelect: () => {
            setAngleItem({ item, type: menuType });
            setAngleDialogImageUrl(
              item.relPath ? assetUrlFromRelPath(item.relPath, charKey) : null
            );
            setAngleDialogOpen(true);
          },
        });
        items.push({
          key: "removeBg",
          label: "Remove Background…",
          onSelect: () => openRemoveBgForPoseItem(item, menuType),
        });
        items.push({
          key: "hide",
          label: "Hide",
          onSelect: () => {
            void hiddenFn(charKey, [item.itemId], true).then(() => {
              void refreshCharSections();
              dropFromSel(item.itemId);
            });
          },
        });
      }
      items.push({
        key: "download",
        label: "Download",
        onSelect: () => {
          const relPaths = collectSelectedGalleryRelPaths();
          if (relPaths.length > 1) {
            void downloadSelectedGallery();
          } else {
            downloadRelPath(item.relPath);
          }
        },
      });
      items.push({
        key: "deleteImage",
        label: "Delete image",
        onSelect: () =>
          void (async () => {
            const ok = await confirmAction({
              title: "Delete image",
              message: "Delete this gallery image?",
              confirmText: "Delete",
            });
            if (!ok) return;
            try {
              await deleteFn(charKey, POSE_FLAT_FOLDER_KEY, [item.relPath]);
              await refreshCharSections();
            } catch (err) {
              showError({ message: "Delete image failed.", error: err });
            }
          })(),
      });
      if (selectedPose.size + selectedExpr.size > 1) {
        items.push({
          key: "createSeq",
          label: "Create Sequence from selection",
          onSelect: () => void createSequenceFromSelection(),
        });
      }
      setMenu({ open: true, x, y, items });
    })();
  }

  function downloadRelPath(relPath: string | undefined) {
    if (!relPath) return;
    const a = document.createElement("a");
    a.href = assetDownloadUrlFromRelPath(relPath);
    a.download = relPath.split("/").pop() ?? "image.png";
    a.click();
  }

  function downloadBlobAsFile(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function runOneGenerateStep(
    entry?: BatchRefEntry,
    batchCtx?: { index: number; total: number }
  ): Promise<boolean> {
    if (!charKey) return false;
    if (!activeStartingRel) {
      showError({ message: "Please choose an input image first." });
      return false;
    }
    const onLog =
      batchCtx && batchCtx.total > 1
        ? (line: string) =>
            onJobLogLine(`[${batchCtx.index}/${batchCtx.total}] ${line}`)
        : onJobLogLine;
    const keypointRef = keypointRefToGenRef(entry ?? activeReference ?? null);
    const rawPrompts = singlePrompt.trim() ? [singlePrompt.trim()] : [];
    if (!rawPrompts.length && !keypointRef) {
      showError({ message: "Enter a prompt (or load a reference keypoint) first." });
      return false;
    }
    const done = await runCharacterGeneration<{
      sequenceName?: string;
      galleryItemId?: string;
      firstPoseKey?: string | null;
      lastInputRelPath?: string;
    }>({
      charKey,
      kind: genType,
      baseRelPath: activeStartingRel,
      rawPrompts,
      keypointRef,
      onLogLine: onLog,
    });
    if (!done.ok) {
      failSession(new Error(done.error ?? "Generation failed"), "Generation failed");
      return false;
    }
    const r = done.result!;
    if (r.lastInputRelPath) {
      setStarting((prev) => mergeStackAfterGeneration(prev, r.lastInputRelPath!));
    }
    await refreshCharSections();
    if (r.sequenceName) setActiveSequence(r.sequenceName);
    return true;
  }

  async function runGenerate() {
    if (batchRefQueue.length > 1) {
      await runBatchRefGeneration();
      return;
    }
    await beginSession({ title: "Generating", clearLog: true, runningStatus: "Starting…" });
    let poseSessionEndOk = false;
    try {
      poseSessionEndOk = await runOneGenerateStep();
    } catch (e) {
      failSession(e, "Generation failed");
    } finally {
      if (poseSessionEndOk) endSession();
      setSelectedPose(new Set());
    }
  }

  async function runBatchRefGeneration() {
    if (!batchRefQueue.length) {
      await runGenerate();
      return;
    }
    const total = batchRefQueue.length;
    await beginSession({
      title: "Batch ref generation",
      clearLog: true,
      runningStatus: `Starting 1/${total}…`,
    });
    let ok = true;
    try {
      for (let i = 0; i < total; i++) {
        const entry = batchRefQueue[i];
        const index = i + 1;
        onJobLogLine(`[${index}/${total}] Starting reference…`);
        setActiveReference(entry);
        ok = await runOneGenerateStep(entry, { index, total });
        if (!ok) break;
        onJobLogLine(`[${index}/${total}] Reference complete`);
      }
      if (ok) {
        onJobLogLine(`Batch complete: ${total}/${total} references`);
        setBatchRefQueue([]);
      }
    } catch (e) {
      failSession(e, "Batch ref generation failed.");
      ok = false;
    } finally {
      if (ok) endSession();
      setSelectedPose(new Set());
    }
  }

  async function confirmAngles(selectedAngleIds: number[], manualFiles: File[]) {
    setAngleDialogOpen(false);
    if (!charKey) return;
    const target = angleItem;
    setAngleItem(null);
    if (!target || !target.item.relPath) {
      showError({ message: "No image selected for angles." });
      return;
    }
    const angType = target.type;
    const inputRels =
      manualFiles.length > 0
        ? await Promise.all(
            manualFiles.map((file) =>
              apiUploadStaging({ charKey, file }).then((r) => r.relPath)
            )
          )
        : [];
    if (!inputRels.length && !selectedAngleIds.length) return;
    await beginSession({ title: "Generating angles", clearLog: true });
    let poseAnglesSessionOk = false;
    try {
      // Server resolves inputRelPath(s) to absolute files, then imports each and
      // runs multi-angle generation with that gallery copy as Comfy base.
      const payload: Record<string, unknown> = {
        job: "angles",
        [angType === "pose" ? "poseKeys" : "exprKeys"]: [POSE_FLAT_FOLDER_KEY],
        angleIds: selectedAngleIds,
      };
      if (inputRels.length) {
        payload.inputRelPaths = inputRels;
      } else {
        payload.inputRelPath = target.item.relPath;
      }
      const done = await runDetailWsJob({
        charKey,
        pathSuffix: angType === "pose" ? "/pose/ws" : "/expression/ws",
        payload,
        onLogLine: (line) => logRef.current?.pushLine(line),
      });
      if (!done.ok) {
        failSession(
          new Error(done.error ?? "Angle generation failed"),
          "Angle generation failed"
        );
      } else {
        await refreshCharSections();
        poseAnglesSessionOk = true;
      }
    } catch (e) {
      failSession(e, "Angle generation failed");
    } finally {
      if (poseAnglesSessionOk) endSession();
    }
  }

  // ── Sequence section ───────────────────────────────────────────────────────
  function selectedEntriesForSequence(): { sourceKind: string; folderKey: string; fileRelPath: string }[] {
    const out: { sourceKind: string; folderKey: string; fileRelPath: string }[] = [];
    const poseItems = [...(poseSplit?.visible ?? []), ...(poseSplit?.hidden ?? [])];
    const exprItems = [...(exprSplit?.visible ?? []), ...(exprSplit?.hidden ?? [])];
    for (const id of selectedPose) {
      const it = poseItems.find((x) => x.itemId === id);
      if (it?.relPath) out.push({ sourceKind: "pose", folderKey: it.folderKey, fileRelPath: it.relPath });
    }
    for (const id of selectedExpr) {
      const it = exprItems.find((x) => x.itemId === id);
      if (it?.relPath) out.push({ sourceKind: "expr", folderKey: it.folderKey, fileRelPath: it.relPath });
    }
    return out;
  }

  async function createSequenceFromSelection() {
    const entries = selectedEntriesForSequence();
    if (!entries.length) {
      showError({ message: "Select at least one Pose/Expression image to create a sequence." });
      return;
    }
    const name = await askText({
      title: "Create Sequence",
      message: "Name for the new sequence (required):",
      defaultValue: "",
      confirmText: "Create",
    });
    if (!name?.trim()) return;
    await beginSession({ title: "Creating sequence", clearLog: true });
    try {
      const r = await apiSequenceCreate({ charKey, name: name.trim(), entries });
      pushLog(r.message);
      setSelectedPose(new Set());
      setSelectedExpr(new Set());
      await refreshCharSections();
      endSession();
      setActiveSequence(r.folderName);
    } catch (e) {
      failSession(e, "Create sequence failed.");
    }
  }

  async function createEmptySequence() {
    const existing = new Set(sequences.map((s) => s.name));
    let n = 1;
    while (existing.has(`Sequence ${n}`)) n++;
    try {
      await apiSequenceCreate({ charKey, name: `Sequence ${n}`, entries: [] });
      await refreshCharSections();
    } catch (e) {
      showError({ message: "Create sequence failed.", error: e });
    }
  }

  function reorderSequences(activeId: string, overId: string | null, insertAfter: boolean) {
    if (!overId || overId === activeId) return;
    const names = sequences.map((s) => s.name);
    const from = names.indexOf(activeId);
    if (from < 0 || names.indexOf(overId) < 0) return;
    const without = names.filter((nm) => nm !== activeId);
    let at = without.indexOf(overId);
    if (at < 0) return;
    if (insertAfter) at += 1;
    without.splice(at, 0, activeId);
    setSequences(without.map((nm) => sequences.find((s) => s.name === nm)!).filter(Boolean));
    void apiSequenceFolderOrder(charKey, without).catch((e) =>
      showError({ message: "Failed to save sequence order.", error: e })
    );
  }

  async function deleteSequence(name: string) {
    const ok = await confirmAction({
      title: "Delete sequence",
      message: `Delete sequence "${name}"?`,
      confirmText: "Delete",
    });
    if (!ok) return;
    try {
      await apiSequenceFolderDelete(charKey, name);
      await refreshCharSections();
    } catch (e) {
      showError({ message: "Delete sequence failed.", error: e });
    }
  }

  async function renameSequence(name: string) {
    const next = await askText({
      title: "Rename sequence",
      message: "New name:",
      defaultValue: name,
      confirmText: "Rename",
    });
    if (!next?.trim() || next.trim() === name) return;
    try {
      await apiSequenceFolderRename(charKey, name, next.trim());
      await refreshCharSections();
    } catch (e) {
      showError({ message: "Rename failed.", error: e });
    }
  }

  async function duplicateSequence(name: string) {
    const label = await askText({
      title: "Duplicate sequence",
      message: `Name for the copy of "${name}":`,
      defaultValue: `${name}_copy`,
      confirmText: "Duplicate",
    });
    if (!label?.trim()) return;
    try {
      await apiSequenceFolderDuplicate(charKey, name, label.trim());
      await refreshCharSections();
    } catch (e) {
      showError({ message: "Duplicate sequence failed.", error: e });
    }
  }

  async function downloadSequenceVideo(name: string) {
    setSequenceVideoExportBusy(name);
    const safe = sanitizeDownloadBaseName(name) || "sequence";
    await runVideoExportJob(
      { begin: beginSession, end: endSession, fail: failSession, log: pushLog },
      {
        runningStatus: "Encoding video…",
        run: async () => {
          await fetchVideoExport(
            `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/sequence/${encodeURIComponent(name)}/export_timeline_mp4`,
            `${safe}_timeline`
          );
        },
        failMessage: "Download as Video failed.",
        onError: (e) => showError({ message: "Download as Video failed.", error: e }),
      }
    );
    setSequenceVideoExportBusy(null);
  }

  async function openSequencePreview(name: string) {
    try {
      const m = await apiSequenceGet(charKey, name);
      setSeqPreview({ name, manifest: m });
    } catch (e) {
      showError({ message: "Could not load sequence.", error: e });
    }
  }

  async function closeSequenceEditor() {
    try {
      await sequenceFlushRef.current?.();
    } catch {
      /* ignore */
    }
    setActiveSequence(null);
    await refreshCharSections();
  }

  // ── Per-type gallery section helpers (symmetric Pose / Expression) ──────────
  function selSetFor(type: GenType): Set<string> {
    return type === "pose" ? selectedPose : selectedExpr;
  }
  function setSelFor(type: GenType): React.Dispatch<React.SetStateAction<Set<string>>> {
    return type === "pose" ? setSelectedPose : setSelectedExpr;
  }
  function splitFor(type: GenType): GallerySplit | null {
    return type === "pose" ? poseSplit : exprSplit;
  }
  function toggleSelFor(type: GenType, itemId: string, on: boolean) {
    setSelFor(type)((prev) => {
      const n = new Set(prev);
      if (on) n.add(itemId);
      else n.delete(itemId);
      return n;
    });
  }
  function galleryAnchorFor(type: GenType): string | null {
    return type === "pose" ? poseGalleryAnchorItemId : exprGalleryAnchorItemId;
  }
  function setGalleryAnchorFor(type: GenType, itemId: string) {
    if (type === "pose") setPoseGalleryAnchorItemId(itemId);
    else setExprGalleryAnchorItemId(itemId);
  }
  function onGalleryCheckboxChange(
    type: GenType,
    itemId: string,
    targetChecked: boolean,
    ev: React.ChangeEvent<HTMLInputElement>
  ) {
    const isShift = (ev.nativeEvent as MouseEvent).shiftKey;
    if (isShift && !targetChecked) {
      setSelFor(type)(new Set());
      return;
    }

    if (!isShift) {
      toggleSelFor(type, itemId, targetChecked);
      setGalleryAnchorFor(type, itemId);
      return;
    }

    const anchor = galleryAnchorFor(type);
    if (!anchor) {
      toggleSelFor(type, itemId, targetChecked);
      setGalleryAnchorFor(type, itemId);
      return;
    }

    const visIds =
      type === "pose" ? dragContainers.poseVisible : dragContainers.exprVisible;
    const hidIds =
      type === "pose" ? dragContainers.poseHidden : dragContainers.exprHidden;
    const ids = visIds.includes(itemId) ? visIds : hidIds;
    if (!ids.includes(itemId) || !ids.includes(anchor)) {
      toggleSelFor(type, itemId, targetChecked);
      setGalleryAnchorFor(type, itemId);
      return;
    }

    const a = ids.indexOf(anchor);
    const b = ids.indexOf(itemId);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const range = ids.slice(lo, hi + 1);
    setSelFor(type)((prev) => {
      const n = new Set(prev);
      for (const k of range) {
        if (targetChecked) n.add(k);
        else n.delete(k);
      }
      return n;
    });
  }
  async function hideSelFor(type: GenType, hide: boolean) {
    const sp = splitFor(type);
    const pool = hide ? sp?.visible ?? [] : sp?.hidden ?? [];
    const poolSet = new Set(pool.map((v) => v.itemId));
    const keys = Array.from(selSetFor(type)).filter((id) => poolSet.has(id));
    if (!keys.length) return;
    const fn = type === "pose" ? apiPoseGalleryHidden : apiExpressionGalleryHidden;
    try {
      await fn(charKey, keys, hide);
      await refreshCharSections();
      setSelFor(type)((prev) => {
        const n = new Set(prev);
        for (const k of keys) n.delete(k);
        return n;
      });
    } catch (e) {
      showError({ message: hide ? "Hide failed." : "Unhide failed.", error: e });
    }
  }
  function collectSelectedGalleryRelPaths(): string[] {
    const relPaths: string[] = [];
    const seen = new Set<string>();
    for (const type of ["pose", "expression"] as const) {
      const sp = splitFor(type);
      const idToItem = new Map(
        [...(sp?.visible ?? []), ...(sp?.hidden ?? [])].map((x) => [x.itemId, x])
      );
      for (const id of selSetFor(type)) {
        const rel = idToItem.get(id)?.relPath;
        if (rel && !seen.has(rel)) {
          seen.add(rel);
          relPaths.push(rel);
        }
      }
    }
    return relPaths;
  }
  async function downloadSelectedGallery() {
    const relPaths = collectSelectedGalleryRelPaths();
    if (!relPaths.length) return;
    if (relPaths.length === 1) {
      downloadRelPath(relPaths[0]);
      return;
    }
    try {
      const blob = await apiGalleryDownloadZip(charKey, relPaths);
      const safe = charKey.replace(/[^\w.-]+/g, "_") || "gallery";
      downloadBlobAsFile(blob, `${safe}_gallery.zip`);
    } catch (err) {
      showError({ message: "Gallery zip download failed.", error: err });
    }
  }
  async function deleteSelForType(type: GenType) {
    const sp = splitFor(type);
    const idToItem = new Map(
      [...(sp?.visible ?? []), ...(sp?.hidden ?? [])].map((x) => [x.itemId, x])
    );
    const items = Array.from(selSetFor(type))
      .map((id) => idToItem.get(id))
      .filter(Boolean) as GallerySplitItem[];
    if (!items.length) return;
    const ok = await confirmAction({
      title: "Delete image(s)",
      message: `Delete ${items.length} selected image(s)?`,
      confirmText: "Delete",
    });
    if (!ok) return;
    const deleteFn = type === "pose" ? apiPoseAnglesDelete : apiExpressionAnglesDelete;
    try {
      await deleteFn(charKey, POSE_FLAT_FOLDER_KEY, items.map((it) => it.relPath));
      await refreshCharSections();
      setSelFor(type)(new Set());
    } catch (e) {
      showError({ message: "Delete failed.", error: e });
    }
  }
  async function onImportFilesInto(type: GenType, files: File[]) {
    if (!charKey) return;
    const list = filterImageFiles(files);
    if (!list.length) return;
    try {
      if (list.length === 1) {
        const f = list[0]!;
        const name = await askText({
          title: type === "pose" ? "Import Pose" : "Import Expression",
          message: "Label for the new image (used in the generated filename):",
          defaultValue: f.name.replace(/\.[^.]+$/, "") || "imported",
          confirmText: "Import",
        });
        if (!name?.trim()) return;
        await importStartingFileForType(f, name.trim(), type);
      } else {
        for (const f of list) {
          const stem = f.name.replace(/\.[^.]+$/, "") || "imported";
          await importStartingFileForType(f, stem, type);
        }
      }
      await refreshCharSections();
    } catch (err) {
      showError({ message: "Import image(s) failed.", error: err });
    }
  }

  async function onGalleryDragEnd(args: {
    activeId: string;
    overId: string | null;
    insertAfter: boolean;
    sourceContainerId: string;
    targetContainerId: string;
  }) {
    const { activeId, overId, insertAfter, sourceContainerId, targetContainerId } = args;

    // ── Unified dnd dispatch: sequence container interactions ──────────────────
    const isGallerySource =
      sourceContainerId === "poseVisible" || sourceContainerId === "exprVisible";
    if (sourceContainerId === "sequences") {
      // Sequence reorder; dragging a sequence into a gallery is a no-op.
      if (targetContainerId === "sequences") {
        reorderSequences(activeId, overId, insertAfter);
      }
      return;
    }
    if (targetContainerId === "sequences") {
      // Gallery tile dropped onto a sequence icon → add image to that sequence's gallery.
      // The tile is NOT removed from the gallery.
      if (!isGallerySource) return;
      const seqName = sequences.find((s) => s.name === overId)?.name;
      if (!seqName) return;
      const dropSourceType: GenType =
        sourceContainerId === "poseVisible" ? "pose" : "expression";
      const dropSplit = splitFor(dropSourceType);
      const dropItem = [...(dropSplit?.visible ?? []), ...(dropSplit?.hidden ?? [])].find(
        (x) => x.itemId === activeId
      );
      if (!dropItem) return;
      setBusy(true);
      try {
        await addImageToSequenceGallery(charKey, seqName, dropItem.relPath);
        await refreshCharSections();
      } catch (err) {
        showError({ message: "Could not add image to sequence.", error: err });
      } finally {
        setBusy(false);
      }
      return;
    }

    const sourceType: GenType = sourceContainerId === "poseVisible" ? "pose" : "expression";
    const targetType: GenType = targetContainerId === "poseVisible" ? "pose" : "expression";

    const r = reorderInsertBeforeOrAfter({
      activeId,
      overId,
      insertAfter,
      sourceContainerId,
      targetContainerId,
      containers: {
        poseVisible: dragContainers.poseVisible,
        exprVisible: dragContainers.exprVisible,
      },
      selectedIds: sourceType === "pose" ? selectedPose : selectedExpr,
    });

    if (sourceContainerId === targetContainerId) {
      // ── Within-section reorder ────────────────────────────────────────────────
      // Lock dnd until the optimistic state is reconciled (prevents acting on stale ids).
      setBusy(true);
      // Optimistic UI — animate immediately (prevents drop snap-back); the
      // refreshGallery() below reconciles dragContainers to the persisted order.
      setDragContainers((prev) => ({
        ...prev,
        poseVisible: r.containers.poseVisible ?? prev.poseVisible,
        exprVisible: r.containers.exprVisible ?? prev.exprVisible,
      }));

      const uiStateFn =
        sourceType === "pose" ? apiPoseGalleryUiState : apiExpressionGalleryUiState;
      const nextVisible = r.containers[sourceContainerId] ?? [];
      const hidden =
        sourceType === "pose" ? dragContainers.poseHidden : dragContainers.exprHidden;
      try {
        await uiStateFn(charKey, {
          order: [...nextVisible, ...hidden],
          hiddenKeys: hidden,
        });
        await refreshCharSections();
      } catch (e) {
        showError({ message: "Failed to save order.", error: e });
        await refreshCharSections();
      } finally {
        setBusy(false);
      }
    } else {
      // ── Cross-section move (drag the active item to the other gallery) ────────
      // Physically moves the file: import into target + delete from source, then append the new
      // item to the end of the target gallery order (avoids fragile drop-slot / overId placement).
      const sp = splitFor(sourceType);
      const allItems = [...(sp?.visible ?? []), ...(sp?.hidden ?? [])];
      const it = allItems.find((x) => x.itemId === activeId);
      if (!it) return;

      const srcKey = sourceContainerId as "poseVisible" | "exprVisible";
      const tgtKey = targetContainerId as "poseVisible" | "exprVisible";

      // Lock dnd for the whole multi-step move (import + delete + refresh) so a second drag can't
      // act on the optimistic/stale ids while the move is in flight.
      setBusy(true);
      // Optimistic append at end (renderItem resolves the active id from the combined pool until
      // refreshGallery() reconciles to the new target-gallery id).
      setDragContainers((prev) => ({
        ...prev,
        [srcKey]: prev[srcKey].filter((x) => x !== activeId),
        [tgtKey]: [...prev[tgtKey].filter((x) => x !== activeId), activeId],
      }));

      const stem =
        ((it.relPath.split("/").pop() ?? "image").replace(/\.[^.]+$/, "") || "imported");
      const deleteFn =
        sourceType === "pose" ? apiPoseAnglesDelete : apiExpressionAnglesDelete;
      const uiStateFn =
        targetType === "pose" ? apiPoseGalleryUiState : apiExpressionGalleryUiState;
      try {
        const imp = await importFromRelForType(it.relPath, stem, targetType);
        await deleteFn(charKey, POSE_FLAT_FOLDER_KEY, [it.relPath]);

        // Fresh server truth for the target gallery (deduped, already includes the new file).
        const targetSplit =
          targetType === "pose"
            ? await apiPoseGallerySplit(charKey)
            : await apiExpressionGallerySplit(charKey);
        const allTarget = [...targetSplit.visible, ...targetSplit.hidden];

        // Deterministic new id (matches the backend id builder); relPath fallback for safety.
        const normRel = imp.relPath.replace(/\\/g, "/").replace(/^\/+/, "");
        const prefix = targetType === "pose" ? "pimg:flat:" : "eimg:flat:";
        let newId = prefix + normRel;
        if (!allTarget.some((x) => x.itemId === newId)) {
          newId = allTarget.find((x) => x.relPath === imp.relPath)?.itemId ?? newId;
        }

        // Rebuild target visible order from fresh server truth; always append the moved item at end.
        const visibleIds = targetSplit.visible.map((x) => x.itemId);
        const hiddenIds = targetSplit.hidden.map((x) => x.itemId);
        const withoutNew = visibleIds.filter((id) => id !== newId);
        const finalVisible = [...withoutNew, newId];

        await uiStateFn(charKey, {
          order: [...finalVisible, ...hiddenIds],
          hiddenKeys: hiddenIds,
        });
        // Preload the new copy's image so the id/URL swap on reconcile doesn't flash blank.
        await preloadImage(assetUrlFromRelPath(imp.relPath));
        await refreshCharSections();
      } catch (err) {
        showError({ message: "Move between galleries failed.", error: err });
        await refreshCharSections();
      } finally {
        setBusy(false);
      }
    }
  }

  function handleBack() {
    router.push(`/detail/${encodeURIComponent(charKey)}`);
  }

  const tile = 120;
  /** Match `StartingImagePreview` / keypoint skeleton viewport so the two columns align visually. */
  const STARTING_PREVIEW_MAX_W = "520px";
  const STARTING_PREVIEW_MAX_H = "360px";
  const sectionStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "flex-end",
  };
  const galleryDroppableStyle: React.CSSProperties = {
    ...sectionStyle,
    minHeight: "100%",
    boxSizing: "border-box",
    alignContent: "flex-start",
  };

  return (
    <DetailSubpageChrome onHome={() => router.push("/home")} onBack={handleBack}>
      <div style={{ paddingLeft: 20, paddingRight: 20, maxWidth: 980 }}>
        {/* Generation type is derived from the starting image (no toggle). */}
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 16 }}>
          {/* Column A: Starting image */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              type="button"
              disabled={uiBusy}
              onClick={() => chooseInputFromLibrary()}
              style={{
                width: 140,
                height: 140,
                borderRadius: 0,
                border: "1px solid rgba(0,0,0,0.5)",
                background: "transparent",
                cursor: uiBusy ? "not-allowed" : "pointer",
              }}
            >
              Add Starting Image for Generation
            </button>
            <div
              style={{
                fontSize: 12,
                padding: "3px 8px",
                alignSelf: "flex-start",
                border: "1px solid rgba(0,0,0,0.4)",
                background: isPose ? "rgba(80,120,200,0.12)" : "rgba(200,120,80,0.12)",
              }}
              title="Generation type is set by the starting image's gallery (Pose or Expression)"
            >
              Generating: {isPose ? "Pose" : "Expression"}
            </div>
            {activeStartingRel ? (
              <StartingImagePreview
                storageRelPath={activeStartingRel}
                stackLength={starting.stack.length}
                stackIndex={starting.index}
                fitMaxWidth={STARTING_PREVIEW_MAX_W}
                fitMaxHeight={STARTING_PREVIEW_MAX_H}
                onPrev={() =>
                  setStarting((s) => ({
                    ...s,
                    index: Math.max(0, s.index - 1),
                  }))
                }
                onNext={() =>
                  setStarting((s) => ({
                    ...s,
                    index: Math.min(Math.max(0, s.stack.length - 1), s.index + 1),
                  }))
                }
                onDeleteCacheEntry={deleteStartingCacheEntry}
                onImageError={onStartingPreviewError}
              />
            ) : (
              <div
                style={{
                  width: 140,
                  height: 140,
                  flexShrink: 0,
                  border: "1px solid rgba(0,0,0,0.35)",
                  background: "rgba(0,0,0,0.02)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  lineHeight: 1.25,
                  opacity: 0.75,
                  padding: 8,
                  boxSizing: "border-box",
                  textAlign: "center",
                }}
              >
                No starting image
              </div>
            )}
          </div>

          {/* Column B: Reference + keypoint (pose only) */}
          {isPose && (
          <div
            style={{ display: "flex", flexDirection: "column", gap: 8 }}
            onContextMenu={
              activeReference
                ? (e) => {
                    e.preventDefault();
                    setMenu({
                      open: true,
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        {
                          key: "clear-ref",
                          label: "Clear reference",
                          onSelect: () => {
                            setActiveReference(null);
                            setBatchRefQueue([]);
                          },
                        },
                      ],
                    });
                  }
                : undefined
            }
          >
            <KeypointReferenceSlot
              keypointRef={activeReference}
              size={140}
              tone="dark"
              disabled={uiBusy}
              onOpenPicker={() => setReferencePickerOpen(true)}
              onClear={() => {
                setActiveReference(null);
                setBatchRefQueue([]);
              }}
              emptyLabel="Add Reference"
              title="Add reference image"
            />
            {batchRefQueue.length > 1 ? (
              <>
                <PoseRefFramePreview
                  frameRelPaths={batchRefPreviewFramePaths(batchRefQueue)}
                  fps={keypointRefPreviewFps(activeReference)}
                  maxWidth={STARTING_PREVIEW_MAX_W}
                  maxHeight={STARTING_PREVIEW_MAX_H}
                />
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {batchRefQueue.length} references queued
                </div>
              </>
            ) : null}
          </div>
          )}
        </div>

        <div style={{ marginBottom: 10, opacity: 0.95 }}>
          {keypointRefHasFrames(activeReference)
            ? activeReference?.kind === "video" || activeReference?.kind === "folder"
              ? `Describe the pose to generate. With a ${
                  activeReference?.kind === "folder" ? "keypoint folder" : "video keypoint sequence"
                } loaded, generation creates a new Sequence folder (not flat gallery images). Prompt is optional.`
              : `Describe the ${isPose ? "pose" : "expression"} to generate. With a reference keypoint loaded, the prompt is optional and defaults to matching the reference pose.`
            : `Describe the ${isPose ? "pose" : "expression"} to generate.`}
        </div>

        <div style={{ position: "relative", marginBottom: 16 }}>
          <textarea
            value={singlePrompt}
            disabled={uiBusy}
            onChange={(e) => setSinglePrompt(e.target.value)}
            placeholder={
              keypointRefHasFrames(activeReference)
                ? "Provide description of reference pose (optional)"
                : isPose
                ? "Input new pose description"
                : "Input new expression description"
            }
            rows={3}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 10px",
              paddingBottom: 40,
              paddingRight: 96,
              border: "1px solid rgba(0,0,0,0.35)",
              background: "transparent",
              color: "inherit",
              fontSize: 14,
              resize: "vertical",
              display: "block",
            }}
          />
          <button
            type="button"
            disabled={uiBusy}
            onClick={() => void runGenerate()}
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              borderRadius: 0,
              border: "1px solid rgba(0,0,0,0.5)",
              background: "transparent",
              padding: "8px 12px",
              cursor: uiBusy ? "not-allowed" : "pointer",
              opacity: uiBusy ? 0.5 : 1,
            }}
          >
            {batchRefQueue.length > 1
              ? `Batch Ref Generation (${batchRefQueue.length})`
              : "Generate"}
          </button>
        </div>

        {/* ── Shared gallery toolbar (always visible, above all section dropdowns) ── */}
        {(() => {
          const totalSel = selectedPose.size + selectedExpr.size;
          const noSel = totalSel === 0;
          const btnStyle: React.CSSProperties = {
            borderRadius: 0,
            border: "1px solid rgba(0,0,0,0.5)",
            background: "transparent",
            padding: "6px 10px",
            cursor: noSel || uiBusy ? "not-allowed" : "pointer",
            opacity: noSel || uiBusy ? 0.4 : 1,
          };
          return (
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Row 1: Import */}
              <div>
                <button
                  type="button"
                  disabled={uiBusy}
                  onClick={() => sharedImportInputRef.current?.click()}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes("Files")) {
                      e.preventDefault();
                      if (!sharedImportDragOver) setSharedImportDragOver(true);
                    }
                  }}
                  onDragLeave={() => setSharedImportDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setSharedImportDragOver(false);
                    if (uiBusy) return;
                    void onImportFilesInto(genType, Array.from(e.dataTransfer.files ?? []));
                  }}
                  style={{
                    width: tile,
                    height: tile,
                    borderRadius: 0,
                    border: sharedImportDragOver ? "2px solid #4a78c8" : "1px solid rgba(0,0,0,0.5)",
                    background: sharedImportDragOver ? "rgba(74,120,200,0.08)" : "transparent",
                    padding: 8,
                    textAlign: "center",
                    whiteSpace: "pre-wrap",
                    cursor: uiBusy ? "not-allowed" : "pointer",
                    transition: "border-color 0.1s, background 0.1s",
                  }}
                  title={`Click or drop image file(s) to import into the active gallery (${genType})`}
                >
                  Click or Drop{"\n"}From File
                </button>
              </div>
              {/* Row 2: Bulk actions */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                  type="button"
                  disabled={noSel || uiBusy}
                  onClick={() => { void hideSelFor("pose", true); void hideSelFor("expression", true); }}
                  style={btnStyle}
                >
                  Hide
                </button>
                <button
                  type="button"
                  disabled={noSel || uiBusy}
                  onClick={() => {
                    if (selectedPose.size > 0) void deleteSelForType("pose");
                    if (selectedExpr.size > 0) void deleteSelForType("expression");
                  }}
                  style={btnStyle}
                >
                  Delete
                </button>
                <button
                  type="button"
                  disabled={noSel || uiBusy}
                  onClick={() => void downloadSelectedGallery()}
                  style={btnStyle}
                >
                  Download
                </button>
              </div>
              {/* Row 3: Create Sequence */}
              <div>
                <button
                  type="button"
                  disabled={noSel || uiBusy}
                  onClick={() => void createSequenceFromSelection()}
                  style={{ ...btnStyle, cursor: noSel || uiBusy ? "not-allowed" : "pointer" }}
                  title="Create a sequence from all selected Pose + Expression images"
                >
                  Create Sequence From Selection
                </button>
              </div>
            </div>
          );
        })()}

        {/* Galleries, in order: Pose, Expression, Sequence, Hidden. */}
        {/* SortableMultiGrid handles drag-to-reorder within each section AND cross-section drag. */}
        <SortableMultiGrid
          disabled={uiBusy}
          containers={[
            { id: "poseVisible", ids: dragContainers.poseVisible },
            { id: "exprVisible", ids: dragContainers.exprVisible },
            { id: "sequences", ids: sequences.map((s) => s.name) },
          ]}
          crossContainerPreview={false}
          forgivingCollision
          onOverContainerChange={setOverContainerId}
          onActiveContainerChange={setDragSourceContainer}
          onDragEnd={(args) => void onGalleryDragEnd(args)}
          renderContainer={({ containerId, children, setContainerRef }) => {
            if (containerId === "sequences") {
              return (
                <div style={{ marginTop: 18 }}>
                  <div
                    onClick={() => setSeqOpen((o) => !o)}
                    style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8, userSelect: "none" }}
                  >
                    <span style={{ display: "inline-block", transform: seqOpen ? "none" : "rotate(-90deg)", transition: "transform 0.12s" }}>▾</span>
                    <span>Sequence</span>
                    <span style={{ fontSize: 11, opacity: 0.6 }}>({sequences.length})</span>
                  </div>
                  {/* Always mount the container ref so dnd-kit can target sequence icons. */}
                  {seqOpen ? (
                    <div
                      ref={(el) => setContainerRef(el)}
                      style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}
                    >
                      {/* New Sequence — creates an empty sequence to drag images into. */}
                      <button
                        type="button"
                        disabled={uiBusy}
                        onClick={() => void createEmptySequence()}
                        title="Create an empty sequence"
                        style={{
                          width: tile,
                          height: tile,
                          borderRadius: 0,
                          border: "1px dashed rgba(0,0,0,0.5)",
                          background: "transparent",
                          cursor: uiBusy ? "not-allowed" : "pointer",
                          textAlign: "center",
                          whiteSpace: "pre-wrap",
                          fontSize: 13,
                        }}
                      >
                        + New{"\n"}Sequence
                      </button>
                      {children}
                    </div>
                  ) : (
                    <div ref={(el) => setContainerRef(el)} style={{ display: "none" }}>{children}</div>
                  )}
                </div>
              );
            }
            const type: GenType = containerId === "poseVisible" ? "pose" : "expression";
            const open = type === "pose" ? poseOpen : exprOpen;
            const setOpen = type === "pose" ? setPoseOpen : setExprOpen;
            const sp = splitFor(type);
            const title = type === "pose" ? "Pose gallery" : "Expression gallery";
            // Highlight only when dragging from a DIFFERENT gallery (cross-section), not within,
            // and only for gallery-sourced drags (not a sequence icon being reordered).
            const isDropTarget =
              overContainerId === containerId &&
              (dragSourceContainer === "poseVisible" || dragSourceContainer === "exprVisible") &&
              dragSourceContainer !== containerId;
            const droppableStyle: React.CSSProperties = {
              ...galleryDroppableStyle,
              transition: "background 0.12s, outline-color 0.12s",
              ...(isDropTarget
                ? { background: "rgba(74,120,200,0.08)", outline: "2px dashed #4a78c8", outlineOffset: -2 }
                : {}),
            };
            return (
              <div style={{ marginTop: 18 }}>
                <div
                  onClick={() => setOpen((o) => !o)}
                  style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8, userSelect: "none" }}
                >
                  <span style={{ display: "inline-block", transform: open ? "none" : "rotate(-90deg)", transition: "transform 0.12s" }}>▾</span>
                  <span>{title}</span>
                  <span style={{ fontSize: 11, opacity: 0.6 }}>({sp?.visible.length ?? 0})</span>
                </div>
                {/* Always mount the container ref so dnd-kit tracks it, even when collapsed.
                    The droppable ref goes on the scroll *viewport* (not the tall inner content)
                    so stacked galleries' droppable rects don't overlap. */}
                {open ? (
                  <ResizableScrollGallery aria-label={`${title} visible`} ref={(el) => setContainerRef(el)}>
                    <div style={droppableStyle}>
                      {(sp?.visible.length ?? 0) === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.6, padding: 8 }}>No images — drag from the other section or use Click or Drop From File above.</div>
                      ) : null}
                      {children}
                    </div>
                  </ResizableScrollGallery>
                ) : (
                  <div ref={(el) => setContainerRef(el)} style={{ display: "none" }}>{children}</div>
                )}
              </div>
            );
          }}
          renderItem={({ id, containerId }) => {
            if (containerId === "sequences") {
              const seq = sequences.find((s) => s.name === id);
              if (!seq) return null;
              return (
                <SequenceDropTile
                  key={id}
                  id={id}
                  thumb={seq.thumb}
                  name={seq.name}
                  tile={tile}
                  disabled={uiBusy}
                  onOpen={() => setActiveSequence(seq.name)}
                  onPlay={() => void openSequencePreview(seq.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      open: true,
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        {
                          key: "downloadVideo",
                          label:
                            sequenceVideoExportBusy === seq.name
                              ? "Exporting…"
                              : "Download as Video",
                          disabled: sequenceVideoExportBusy != null,
                          onSelect: () => void downloadSequenceVideo(seq.name),
                        },
                        { key: "rename", label: "Rename", onSelect: () => void renameSequence(seq.name) },
                        { key: "duplicate", label: "Duplicate Sequence", onSelect: () => void duplicateSequence(seq.name) },
                        { key: "delete", label: "Delete", onSelect: () => void deleteSequence(seq.name) },
                      ],
                    });
                  }}
                />
              );
            }
            const type: GenType = containerId === "poseVisible" ? "pose" : "expression";
            // Resolve from the combined pool so an optimistically-moved tile (whose data still
            // lives in the source split) keeps rendering until refreshGallery swaps in the new id.
            const it = allGalleryItems.find((x) => x.itemId === id);
            if (!it) return null;
            return (
              <SortableItemInContainer key={id} id={id} containerId={containerId} disabled={uiBusy}>
                <GalleryPoseTile
                  tile={tile}
                  item={it}
                  checked={selSetFor(type).has(it.itemId)}
                  disabled={uiBusy}
                  onToggle={(on, e) => onGalleryCheckboxChange(type, it.itemId, on, e)}
                  onPrimary={() => openLightboxForType(type, it.itemId)}
                  onContextMenu={(e) => openPoseMenu(e, it, false, type)}
                />
              </SortableItemInContainer>
            );
          }}
          renderDragOverlay={({ id, containerId }) => {
            if (containerId === "sequences") {
              const seq = sequences.find((s) => s.name === id);
              return (
                <div style={{ width: tile, height: tile, border: "1px solid rgba(0,0,0,0.5)", background: "#f3f3f3", overflow: "hidden", cursor: "grabbing" }}>
                  {seq?.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assetUrlFromRelPath(seq.thumb)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : null}
                </div>
              );
            }
            const it = allGalleryItems.find((x) => x.itemId === id);
            if (!it) return null;
            return (
              <div style={{ width: tile, cursor: "grabbing", touchAction: "none", opacity: 0.85 }}>
                <GalleryPoseTile
                  tile={tile}
                  item={it}
                  checked={false}
                  disabled={true}
                  onToggle={() => {}}
                  onPrimary={() => {}}
                  onContextMenu={(e) => e.preventDefault()}
                />
              </div>
            );
          }}
        />

        {/* Hidden section: both Pose and Expression hidden items, routed by type. */}
        {(() => {
          const poseHidden = poseSplit?.hidden ?? [];
          const exprHidden = exprSplit?.hidden ?? [];
          const total = poseHidden.length + exprHidden.length;
          return (
            <div style={{ marginTop: 18 }}>
              <div
                onClick={() => setHiddenOpen((o) => !o)}
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8, userSelect: "none" }}
              >
                <span style={{ display: "inline-block", transform: hiddenOpen ? "none" : "rotate(-90deg)", transition: "transform 0.12s" }}>▾</span>
                <span>Hidden</span>
                <span style={{ fontSize: 11, opacity: 0.6 }}>({total})</span>
              </div>
              {hiddenOpen && (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                    {([
                      ["Unhide", () => { void hideSelFor("pose", false); void hideSelFor("expression", false); }],
                      ["Delete", () => { void deleteSelForType("pose"); void deleteSelForType("expression"); }],
                    ] as [string, () => void][]).map(([label, fn]) => (
                      <button
                        key={label}
                        type="button"
                        disabled={uiBusy}
                        onClick={fn}
                        style={{ borderRadius: 0, border: "1px solid rgba(0,0,0,0.5)", background: "transparent", padding: "6px 10px", cursor: "pointer" }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <ResizableScrollGallery aria-label="Hidden gallery">
                    <div style={galleryDroppableStyle}>
                      {total === 0 ? (
                        <div style={{ fontSize: 12, opacity: 0.6, padding: 8 }}>No hidden images.</div>
                      ) : null}
                      {([["pose", poseHidden] as const, ["expression", exprHidden] as const]).flatMap(
                        ([type, items]) =>
                          items.map((it) => (
                            <GalleryPoseTile
                              key={it.itemId}
                              tile={tile}
                              item={it}
                              checked={selSetFor(type).has(it.itemId)}
                              disabled={uiBusy}
                              onToggle={(on, e) => onGalleryCheckboxChange(type, it.itemId, on, e)}
                              onPrimary={() =>
                                openLightboxFor(items, it.itemId, type === "pose" ? "Pose preview" : "Expression preview")
                              }
                              onContextMenu={(e) => openPoseMenu(e, it, true, type)}
                            />
                          ))
                      )}
                    </div>
                  </ResizableScrollGallery>
                </>
              )}
            </div>
          );
        })()}
      </div>

      <input
        ref={sharedImportInputRef}
        type="file"
        accept="image/*"
        multiple
        disabled={uiBusy}
        style={{ display: "none" }}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.currentTarget.value = "";
          void onImportFilesInto(genType, list);
        }}
      />

      <ImagePickerModal
        open={pickerOpen}
        title="Choose input image"
        okText="Use"
        cancelText="Cancel"
        sections={pickerSections}
        onCancel={() => setPickerOpen(false)}
        onPick={(relPath) => {
          setPickerOpen(false);
          // Picker is only used for the starting-image stack.
          // Marker: a starting image from the Expression gallery flips generation to
          // Expression (and vice-versa), so you can't generate the wrong type from it.
          const detected = detectGenTypeFromRel(relPath);
          if (detected && detected !== genType) setGenType(detected);
          setStarting((prev) => appendStartingFromLibrary(prev, relPath));
        }}
      />

      <CameraAngleModal
        open={angleDialogOpen}
        title="New Angle"
        imageUrl={angleDialogImageUrl}
        onCancel={() => setAngleDialogOpen(false)}
        onConfirm={(angleId) => void confirmAngles([angleId], [])}
      />

      <CameraAngleModal
        open={seqAngleOpen}
        title="New Angle"
        imageUrl={seqAngleImageUrl}
        onCancel={() => {
          setSeqAngleOpen(false);
          seqAngleCtxRef.current = null;
        }}
        onConfirm={(angleId) => void applyNewAngleSequenceGallery(angleId)}
      />

      <AiEditModal {...aiEditModalProps} />

      {isPose && (
        <ReferencePicker
          open={referencePickerOpen}
          charKey={charKey}
          busy={uiBusy}
          onCancel={() => setReferencePickerOpen(false)}
          onUseSelected={(refs) => void onReferenceUseSelected(refs)}
          onPickNew={onReferencePickNew}
          refreshToken={referencePickerRefreshToken}
          onKeypointsMade={(ref) => {
            onReferencePickSaved(ref);
            setReferencePickerRefreshToken((value) => value + 1);
          }}
          onKeypointVideoMade={(ref) => {
            setActiveReference({ kind: "video", ref });
            setBatchRefQueue([]);
            clearPosePromptUiForKeypointReference();
            setReferencePickerRefreshToken((value) => value + 1);
          }}
          jobModal={{ begin: beginSession, end: endSession, fail: failSession, log: pushLog }}
        />
      )}

      <DesktopContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menu.items}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />

      {lightbox ? (
        <GalleryImageLightbox
          key={`${lightbox.paths.join("|")}-${lightbox.index}-${lightbox.title}`}
          {...lightbox}
          onClose={() => setLightbox(null)}
        />
      ) : null}

      {activeSequence ? (
        <SequenceWorkspaceShell
          title={`Sequence: ${activeSequence}`}
          onClose={() => void closeSequenceEditor()}
        >
          <SequenceEditor
            charKey={charKey}
            sequenceName={activeSequence}
            onError={(msg, err) => showError({ message: msg, error: err })}
            onAiEditSequenceGallery={openAiEditSequenceGallery}
            onNewAngleSequenceGallery={openNewAngleSequenceGallery}
            jobModal={{ begin: beginSession, end: endSession, fail: failSession, log: pushLog }}
            registerFlushSave={(fn) => {
              sequenceFlushRef.current = fn;
            }}
          />
        </SequenceWorkspaceShell>
      ) : null}

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />

      <RemoveBgImageModal
        open={removeBgImageOpen}
        busy={uiBusy}
        onCancel={() => {
          setRemoveBgImageOpen(false);
          removeBgPendingRef.current = null;
        }}
        onRun={(options) => void runRemoveBgImage(options)}
      />

      {seqPreview ? (
        <SequencePreviewLightbox
          manifest={seqPreview.manifest}
          scope="timeline"
          initialIndex={0}
          title={seqPreview.name}
          onClose={() => setSeqPreview(null)}
          onCommitManifest={(next) => {
            setSeqPreview((cur) => (cur ? { ...cur, manifest: next } : cur));
            void apiSequencePut(charKey, seqPreview.name, next).catch((e) =>
              showError({ message: "Could not save sequence.", error: e })
            );
          }}
        />
      ) : null}
    </DetailSubpageChrome>
  );
}

/**
 * Sequence icon as a dnd-kit sortable in the unified builder context. It reorders sequences
 * (sequence-to-sequence drag) AND acts as a drop target for gallery tiles dragged from the
 * Pose/Expression galleries — showing the blue highlight while a gallery tile hovers it.
 */
function SequenceDropTile(props: {
  id: string;
  thumb: string | null;
  name: string;
  tile: number;
  disabled?: boolean;
  onOpen: () => void;
  onPlay: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { id, thumb, name, tile, disabled, onOpen, onPlay, onContextMenu } = props;
  const useOverlayClone = useContext(UseDragOverlayCloneContext);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, active } =
    useSortable({ id, disabled, data: { containerId: "sequences" } });

  // Only show the "add image" highlight when the active drag is a gallery tile (not a sequence reorder).
  const activeContainer = (active?.data?.current as { containerId?: string } | null)?.containerId;
  const galleryDragging = activeContainer === "poseVisible" || activeContainer === "exprVisible";
  const showDropHighlight = isOver && galleryDragging;

  const wrapStyle: React.CSSProperties = {
    width: tile,
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? "none" : transition,
    opacity: isDragging ? (useOverlayClone ? 0 : 0.7) : undefined,
    position: isDragging && !useOverlayClone ? "relative" : undefined,
    zIndex: isDragging && !useOverlayClone ? 9999 : undefined,
  };

  return (
    <div ref={setNodeRef} style={wrapStyle} {...attributes} {...listeners}>
      <div
        onContextMenu={onContextMenu}
        style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, width: tile }}
      >
        <div
          role="button"
          aria-label="Open sequence editor"
          onClick={() => { if (!disabled) onOpen(); }}
          title="Open sequence editor (drag to reorder)"
          style={{
            position: "relative",
            width: tile,
            height: tile,
            borderRadius: 0,
            border: showDropHighlight ? "2px solid #4a78c8" : "1px solid rgba(0,0,0,0.5)",
            background: "#f3f3f3",
            cursor: "pointer",
            overflow: "hidden",
          }}
        >
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={assetUrlFromRelPath(thumb)}
              alt={name}
              style={{ width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }}
            />
          ) : (
            <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 11, opacity: 0.6 }}>empty</span>
          )}
          {/* Play overlay — top-right arrow over the thumbnail. */}
          <button
            type="button"
            disabled={disabled}
            aria-label="Play sequence"
            title="Play sequence"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onPlay(); }}
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              zIndex: 2,
              width: 20,
              height: 20,
              display: "grid",
              placeItems: "center",
              padding: 0,
              border: "1px solid rgba(0,0,0,0.45)",
              borderRadius: 0,
              background: "rgba(255,255,255,0.85)",
              cursor: disabled ? "not-allowed" : "pointer",
              fontSize: 11,
              lineHeight: 1,
            }}
          >
            ▶
          </button>
        </div>
        <div
          style={{ fontSize: 11, maxWidth: tile, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={name}
        >
          {name}
        </div>
      </div>
    </div>
  );
}

function GalleryPoseTile(props: {
  tile: number;
  item: GallerySplitItem;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  onPrimary: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { tile, item, checked, disabled, onToggle, onPrimary, onContextMenu } = props;
  return (
    <div
      style={{
        width: tile,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      <div style={{ width: tile, height: tile, position: "relative" }}>
        <button
          type="button"
          disabled={disabled}
          onClick={onPrimary}
          onContextMenu={onContextMenu}
          className="gallery-cover-btn"
          style={{
            width: tile,
            height: tile,
            padding: 0,
            border: "1px solid rgba(0,0,0,0.5)",
            background: "rgba(0,0,0,0.2)",
            cursor: "pointer",
            overflow: "hidden",
          }}
        >
          <img
            src={assetUrlFromRelPath(item.relPath)}
            alt=""
            className="gallery-cover-img"
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </button>

        <label
          style={{
            position: "absolute",
            top: 4,
            left: 6,
            zIndex: 2,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            disabled={disabled}
            checked={checked}
            onChange={(e) => onToggle(e.target.checked, e)}
            style={{ margin: 0 }}
          />
        </label>
      </div>
    </div>
  );
}

function ImportGalleryTile(props: {
  tile: number;
  disabled: boolean;
  dragOver: boolean;
  onPick: () => void;
  onDragOver: (ev: React.DragEvent<HTMLButtonElement>) => void;
  onDragLeave: () => void;
  onDrop: (ev: React.DragEvent<HTMLButtonElement>) => void;
}) {
  const { tile, disabled, dragOver, onPick, onDragOver, onDragLeave, onDrop } = props;
  return (
    <SquareButton
      disabled={disabled}
      onClick={onPick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      variant="import"
      tone="dark"
      dragOver={dragOver}
      size={tile}
      style={{
        color: "inherit",
      }}
      title="Import pose image(s): click or drag-drop; multi-select in file dialog supported"
    >
      Import pose
      <br />
      click or drop
      <br />
      From File
    </SquareButton>
  );
}

