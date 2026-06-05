"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  apiPoseAngleGroups,
  apiPoseAnglesDelete,
  apiPoseCatalog,
  apiPoseEnsureBase,
  apiPoseGalleryHidden,
  apiPoseGalleryUiState,
  apiPoseGallerySplit,
  apiPoseImportStarting,
  apiPoseImportStartingFromRel,
  assetDownloadUrlFromRelPath,
  assetUrlFromRelPath,
  apiExpressionGallerySplit,
  apiUploadStaging,
  CoverCandidate,
  GallerySplit,
  GallerySplitItem,
  PoseCatalogItem,
  PoseReference,
  runDetailWsJob,
  runReferenceMakeKeypointWsJob,
  runReferenceGenerateWsJob,
} from "../../../../lib/api";
import { buildFlatGalleryLightboxPaths } from "../../../../lib/galleryLightboxOrder";
import { CameraAngleModal } from "../../../../components/CameraAngleModal";
import { DesktopContextMenu, ContextMenuItem } from "../../../../components/DesktopContextMenu";
import { DetailSubpageChrome } from "../../../../components/DetailSubpageChrome";
import { ImagePickerModal } from "../../../../components/ImagePickerModal";
import { AiEditModal } from "../../../../components/AiEditModal";
import type { SharedLogStreamHandle } from "../../../../components/SharedLogStream";
import { ConnectedJobRunModal } from "../../../../components/ConnectedJobRunModal";
import { useJobRunSession } from "../../../../hooks/useJobRunSession";
import { ReferencePicker } from "../../../../components/ReferencePicker";
import { StartingImagePreview } from "../../../../components/StartingImagePreview";
import { ZoomableImage } from "../../../../components/ZoomableImage";
import { GalleryImageLightbox } from "../../../../components/GalleryImageLightbox";
import { SquareButton } from "../../../../components/SquareButton";
import { useAppError } from "../../../../components/ErrorProvider";
import { ResizableScrollGallery } from "../../../../components/ResizableScrollGallery";
import { SortableMultiGrid, SortableItemInContainer } from "../../../../components/dnd/SortableMultiGrid";
import { reorderInsertBeforeOrAfter } from "../../../../components/dnd/reorder";
/** Server bucket key for the flat pose gallery (see ``POSE_FLAT_BUCKET`` in logic). */
const POSE_FLAT_FOLDER_KEY = "flat";

type StartingImageState = { stack: string[]; index: number };
type PickerMode = "startingStack" | "importIntoGallery";

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

function buildPosePromptFromLabel(shortDesc: string): string {
  const desc = shortDesc.trim();
  if (!desc) return "";
  return `Edit the subject to ${desc}, keep identity and clothing coherent unless impossible.`;
}

/** Single-line status for ``JobRunModal`` next to the spinner (WS log lines can be long). */
function truncateJobModalStatusLine(raw: string, maxLen = 120): string {
  const s = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

export default function PosePage() {
  const router = useRouter();
  const { showError, askText, confirmAction } = useAppError();
  const params = useParams<{ charKey: string }>();
  const charKey = params?.charKey ?? "";

  const [split, setSplit] = useState<GallerySplit | null>(null);
  const [catalog, setCatalog] = useState<PoseCatalogItem[]>([]);
  const [angleGroups, setAngleGroups] = useState<
    { title: string; angleIds: number[]; angles: { id: number; label: string }[] }[]
  >([]);

  const [starting, setStarting] = useState<StartingImageState>({ stack: [], index: 0 });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerImages, setPickerImages] = useState<CoverCandidate[]>([]);
  const [pickerMode, setPickerMode] = useState<PickerMode>("startingStack");

  const [draftRows, setDraftRows] = useState<string[]>([""]);
  const [savedPrompts, setSavedPrompts] = useState<
    { id: string; text: string; checked: boolean }[]
  >([]);
  const [sampleSel, setSampleSel] = useState<Record<number, boolean>>({});
  const [selectAllSamples, setSelectAllSamples] = useState(false);
  const [catalogLabelOverrides, setCatalogLabelOverrides] = useState<Record<number, string>>(
    {}
  );
  const [hiddenCatalogIds, setHiddenCatalogIds] = useState<Set<number>>(() => new Set());
  const [sampleAnchorId, setSampleAnchorId] = useState<string | null>(null);

  const [selectedPoseItemIds, setSelectedPoseItemIds] = useState<Set<string>>(new Set());
  const [galleryAnchorItemId, setGalleryAnchorItemId] = useState<string | null>(null);
  const [importDragOver, setImportDragOver] = useState(false);
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
    setRunningStatus,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);
  const uiBusy = busy || jobRunning;

  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditPoseKey, setAiEditPoseKey] = useState<string>("");
  const [aiEditSourceRelPath, setAiEditSourceRelPath] = useState<string>("");

  const [referenceRef, setReferenceRef] = useState<PoseReference | null>(null);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    items: ContextMenuItem[];
  }>({ open: false, x: 0, y: 0, items: [] });

  const [lightbox, setLightbox] = useState<{
    paths: string[];
    index: number;
    title: string;
  } | null>(null);

  const [dragContainers, setDragContainers] = useState<{
    visible: string[];
    hidden: string[];
  }>({ visible: [], hidden: [] });
  const skipSplitSyncRef = useRef(0);

  const refreshGallery = useCallback(async () => {
    if (!charKey) return;
    const s = await apiPoseGallerySplit(charKey);
    setSplit(s);
  }, [charKey]);

  useEffect(() => {
    if (skipSplitSyncRef.current > 0) {
      skipSplitSyncRef.current--;
      return;
    }
    const vis = (split?.visible ?? []).map((x) => x.itemId);
    const hid = (split?.hidden ?? []).map((x) => x.itemId);
    setDragContainers({ visible: vis, hidden: hid });
  }, [split]);

  const openAiEditForPose = useCallback(
    (poseFolderKey: string, sourceRelPath: string) => {
      if (!sourceRelPath) {
        showError({ message: "AI Edit: source image not found." });
        return;
      }
      setAiEditPoseKey(poseFolderKey);
      setAiEditSourceRelPath(sourceRelPath);
      setAiEditOpen(true);
    },
    [showError]
  );

  const onAiEditGeneratePose = useCallback(
    async (promptText: string, maskPngBase64?: string) => {
      if (!charKey) return;
      if (!aiEditPoseKey || !aiEditSourceRelPath) return;

      setAiEditOpen(false);
      beginSession({ title: "AI Editing pose", clearLog: false });
      try {
        const done = await runDetailWsJob<{ newRelPath: string }>({
          charKey,
          pathSuffix: "/pose/ws",
          payload: {
            job: "ai_edit_pose",
            poseKey: aiEditPoseKey,
            sourceRelPath: aiEditSourceRelPath,
            promptText,
            ...(maskPngBase64 ? { maskPngBase64 } : {}),
          },
          onLogLine: (line) => logRef.current?.pushLine(line),
        });
        if (!done.ok) {
          throw new Error(done.error ?? "AI Edit pose failed");
        }
        await refreshGallery();
      } catch (err) {
        failSession(err, "AI Edit pose failed.");
        return;
      }
      endSession();
    },
    [aiEditPoseKey, aiEditSourceRelPath, beginSession, charKey, endSession, failSession, refreshGallery]
  );

  const activeStartingRel = useMemo(() => {
    const { stack, index } = starting;
    if (!stack.length) return null;
    const i = Math.min(Math.max(0, index), stack.length - 1);
    return stack[i] ?? null;
  }, [starting]);

  const reseedStartingFromHub = useCallback(async () => {
    if (!charKey) return;
    try {
      const { relPath } = await apiPoseEnsureBase(charKey);
      if (relPath) setStarting({ stack: [relPath], index: 0 });
    } catch {
      /* no base in gallery */
    }
  }, [charKey]);

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
    setSelectAllSamples(false);
    setSampleSel({});
    setSavedPrompts((prev) => prev.map((s) => ({ ...s, checked: false })));
    setDraftRows([""]);
    setSampleAnchorId(null);
  }, []);

  const onReferencePickNew = useCallback(
    async (file: File) => {
      if (!charKey) return;
      setReferencePickerOpen(false);
      let uploadComplete = false;
      try {
        beginSession({
          title: "Uploading reference image…",
          clearLog: true,
          runningStatus: "Uploading reference image…",
        });
        const { relPath } = await apiUploadStaging({ charKey, file });
        uploadComplete = true;
        setTitle("Converting image to pose keypoints");
        setRunningStatus("Starting keypoint conversion…");
        pushLog("Upload complete. Starting keypoint job…");
        const done = await runReferenceMakeKeypointWsJob({
          imageRelPath: relPath,
          onLogLine: (line) => {
            logRef.current?.pushLine(line);
            setRunningStatus(truncateJobModalStatusLine(line));
          },
        });
        if (!done.ok) throw new Error(done.error ?? "Keypoint generation failed");
        if (done.result) {
          setReferenceRef({
            id: done.result.item.id,
            referenceRelPath: done.result.item.referenceRelPath,
            keypointRelPath: done.result.item.keypointRelPath,
          });
          clearPosePromptUiForKeypointReference();
        }
        endSession();
      } catch (err) {
        failSession(
          err,
          uploadComplete
            ? "Failed to generate keypoints."
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
    setReferencePickerOpen(false);
    setReferenceRef(ref);
    if ((ref.keypointRelPath || "").trim()) {
      clearPosePromptUiForKeypointReference();
    }
  }, [clearPosePromptUiForKeypointReference]);

  const onReferenceGenerateBase = useCallback(
    async (promptText: string) => {
      setReferencePickerOpen(false);
      try {
        beginSession({
          title: "Generating base reference…",
          clearLog: true,
          runningStatus: "Generating base reference…",
        });
        const gen = await runReferenceGenerateWsJob({
          promptText,
          onLogLine: (line) => {
            logRef.current?.pushLine(line);
            setRunningStatus(truncateJobModalStatusLine(line));
          },
        });
        if (!gen.ok || !gen.result) {
          throw new Error(gen.error ?? "Reference generation failed");
        }
        setTitle("Converting image to pose keypoints");
        setRunningStatus("Starting keypoint conversion…");
        pushLog("Base reference generated. Starting keypoint job…");
        const done = await runReferenceMakeKeypointWsJob({
          imageRelPath: gen.result.previewRelPath,
          onLogLine: (line) => {
            logRef.current?.pushLine(line);
            setRunningStatus(truncateJobModalStatusLine(line));
          },
        });
        if (!done.ok) throw new Error(done.error ?? "Keypoint generation failed");
        if (done.result) {
          setReferenceRef({
            id: done.result.item.id,
            referenceRelPath: done.result.item.referenceRelPath,
            keypointRelPath: done.result.item.keypointRelPath,
          });
          clearPosePromptUiForKeypointReference();
        }
        endSession();
      } catch (err) {
        failSession(err, "Failed to generate base reference.");
      }
    },
    [
      beginSession,
      clearPosePromptUiForKeypointReference,
      endSession,
      failSession,
      pushLog,
      setRunningStatus,
      setTitle,
    ]
  );

  useEffect(() => {
    if (!charKey) return;
    setStarting({ stack: [], index: 0 });
    (async () => {
      const ensured = await apiPoseEnsureBase(charKey);
      await refreshGallery();
      if (ensured.relPath) {
        setStarting({ stack: [ensured.relPath], index: 0 });
      }
      const [cat, ag] = await Promise.all([
        apiPoseCatalog(charKey),
        apiPoseAngleGroups(charKey),
      ]);
      setCatalog(cat);
      setAngleGroups(ag);
    })().catch(() => {});
  }, [charKey, refreshGallery]);

  useEffect(() => {
    if (selectAllSamples) {
      const m: Record<number, boolean> = {};
      for (const row of catalog) {
        if (!hiddenCatalogIds.has(row.id)) m[row.id] = true;
      }
      setSampleSel(m);
      setSavedPrompts((prev) => prev.map((s) => ({ ...s, checked: true })));
    } else {
      setSampleSel({});
      setSavedPrompts((prev) => prev.map((s) => ({ ...s, checked: false })));
    }
  }, [selectAllSamples, catalog, hiddenCatalogIds]);

  const orderedSampleIds = useMemo(() => {
    const custom = savedPrompts.map((sp) => `custom:${sp.id}`);
    const cat = catalog
      .filter((c) => !hiddenCatalogIds.has(c.id))
      .map((c) => `cat:${c.id}`);
    return [...custom, ...cat];
  }, [savedPrompts, catalog, hiddenCatalogIds]);

  function onSampleCheckboxChange(
    clickedId: string,
    targetChecked: boolean,
    ev: React.ChangeEvent<HTMLInputElement>
  ) {
    const isShift = (ev.nativeEvent as MouseEvent).shiftKey;
    if (isShift && !targetChecked) {
      setSavedPrompts((prev) => prev.map((sp) => ({ ...sp, checked: false })));
      setSampleSel({});
      return;
    }

    const anchor = sampleAnchorId;
    if (isShift && anchor) {
      const a = orderedSampleIds.indexOf(anchor);
      const b = orderedSampleIds.indexOf(clickedId);
      if (a !== -1 && b !== -1) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const range = orderedSampleIds.slice(lo, hi + 1);
        const customIds = new Set(
          range
            .filter((x) => x.startsWith("custom:"))
            .map((x) => x.slice("custom:".length))
        );
        const catIds = range
          .filter((x) => x.startsWith("cat:"))
          .map((x) => Number(x.slice("cat:".length)))
          .filter((n) => Number.isFinite(n));

        if (customIds.size) {
          setSavedPrompts((prev) =>
            prev.map((sp) =>
              customIds.has(sp.id) ? { ...sp, checked: targetChecked } : sp
            )
          );
        }
        if (catIds.length) {
          setSampleSel((prev) => {
            const n = { ...prev };
            for (const id of catIds) n[id] = targetChecked;
            return n;
          });
        }

        setSampleAnchorId(clickedId);
        return;
      }
    }

    // Non-range toggle (or missing anchor)
    if (clickedId.startsWith("custom:")) {
      const spid = clickedId.slice("custom:".length);
      setSavedPrompts((prev) =>
        prev.map((sp) => (sp.id === spid ? { ...sp, checked: targetChecked } : sp))
      );
    } else if (clickedId.startsWith("cat:")) {
      const cid = Number(clickedId.slice("cat:".length));
      if (Number.isFinite(cid)) {
        setSampleSel((prev) => ({ ...prev, [cid]: targetChecked }));
      }
    }
    setSampleAnchorId(clickedId);
  }

  const promptTextsForGeneration = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of savedPrompts) {
      if (!s.checked) continue;
      const f = buildPosePromptFromLabel(s.text);
      if (f && !seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
    for (const d of draftRows) {
      const raw = d.trim();
      if (!raw) continue;
      const f = buildPosePromptFromLabel(raw);
      if (f && !seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
    return out;
  }, [savedPrompts, draftRows]);

  const selectedCatalogIds = useMemo(
    () => catalog.filter((c) => sampleSel[c.id]).map((c) => c.id),
    [catalog, sampleSel]
  );

  const generateLabel = (() => {
    const p = promptTextsForGeneration.length;
    const c = selectedCatalogIds.length;
    const keypointCatalogCombo =
      p === 0 && !!referenceRef?.keypointRelPath && c >= 1;
    if (p + c > 1 || keypointCatalogCombo) return "Batch Generate";
    return "Generate";
  })();

  async function loadStartingImageCandidates(): Promise<CoverCandidate[]> {
    if (!charKey) return [];
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
    return dedupeStartingCandidatesForPose000(out);
  }

  async function chooseInputFromLibrary() {
    if (!charKey) return;
    try {
      setBusy(true);
      setPickerMode("startingStack");
      const imgs = await loadStartingImageCandidates();
      setPickerImages(imgs);
      setPickerOpen(true);
    } catch (err) {
      showError({ message: "Failed to load starting image candidates.", error: err });
    } finally {
      setBusy(false);
    }
  }

  async function importRelPathIntoCurrentPoseGallery(relPath: string) {
    if (!charKey) return;
    try {
      setBusy(true);
      const parts = relPath.split("/").filter(Boolean);
      const fileName = parts.length ? parts[parts.length - 1] : "image.png";
      const labelStem = fileName.replace(/\.[^.]+$/, "") || "import";

      await apiPoseImportStartingFromRel({
        charKey,
        sourceRelPath: relPath,
        poseFolderName: labelStem,
      });
      await refreshGallery();
    } catch (err) {
      showError({ message: "Adding image to gallery failed.", error: err });
    } finally {
      setBusy(false);
    }
  }

  async function chooseImageFromOppositeGalleryVisible() {
    if (!charKey) return;
    try {
      setBusy(true);
      setPickerMode("importIntoGallery");
      const split = await apiExpressionGallerySplit(charKey);
      const imgs = (split.visible ?? [])
        .filter((x) => Boolean(x.relPath))
        .map((x) => ({ relPath: x.relPath as string, caption: x.folderKey }));
      setPickerImages(imgs);
      setPickerOpen(true);
    } catch (err) {
      showError({ message: "Failed to load gallery images.", error: err });
    } finally {
      setBusy(false);
    }
  }

  function filterImageFiles(fileList: Iterable<File> | null | undefined): File[] {
    return Array.from(fileList ?? []).filter(
      (f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(f.name)
    );
  }

  async function onImportFiles(files: File[]) {
    if (!charKey) return;
    const list = filterImageFiles(files);
    if (!list.length) return;
    try {
      if (list.length === 1) {
        const f = list[0]!;
        const name = await askText({
          title: "Import Pose",
          message: "Label for the new pose image (used in the generated filename):",
          defaultValue: f.name.replace(/\.[^.]+$/, "") || "imported",
          confirmText: "Import",
        });
        if (!name?.trim()) return;
        await apiPoseImportStarting({
          charKey,
          file: f,
          poseFolderName: name.trim(),
        });
      } else {
        for (const f of list) {
          const stem = f.name.replace(/\.[^.]+$/, "") || "imported";
          await apiPoseImportStarting({
            charKey,
            file: f,
            poseFolderName: stem,
          });
        }
      }
      await refreshGallery();
    } catch (err) {
      showError({ message: "Import pose image(s) failed.", error: err });
    }
  }

  function onPoseTilePrimaryClick(itemId: string) {
    if (!charKey) return;
    const built = buildFlatGalleryLightboxPaths(split, dragContainers, itemId, {
      visible: "Pose preview",
      hidden: "Pose preview (hidden)",
    });
    if (built) setLightbox(built);
  }

  function togglePoseItemId(itemId: string, checked: boolean) {
    setSelectedPoseItemIds((prev) => {
      const n = new Set(prev);
      if (checked) n.add(itemId);
      else n.delete(itemId);
      return n;
    });
  }

  function onGalleryCheckboxChange(
    itemId: string,
    targetChecked: boolean,
    ev: React.ChangeEvent<HTMLInputElement>
  ) {
    const isShift = (ev.nativeEvent as MouseEvent).shiftKey;
    if (isShift && !targetChecked) {
      setSelectedPoseItemIds(new Set());
      return;
    }

    if (!isShift) {
      togglePoseItemId(itemId, targetChecked);
      setGalleryAnchorItemId(itemId);
      return;
    }

    const anchor = galleryAnchorItemId;
    if (!anchor) {
      togglePoseItemId(itemId, targetChecked);
      setGalleryAnchorItemId(itemId);
      return;
    }

    const vis = split?.visible ?? [];
    const hid = split?.hidden ?? [];
    const visIds = vis.map((x) => x.itemId);
    const hidIds = hid.map((x) => x.itemId);
    const inVis = visIds.includes(itemId);
    const ids = inVis ? visIds : hidIds;
    if (!ids.includes(itemId) || !ids.includes(anchor)) {
      togglePoseItemId(itemId, targetChecked);
      setGalleryAnchorItemId(itemId);
      return;
    }

    const a = ids.indexOf(anchor);
    const b = ids.indexOf(itemId);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const range = ids.slice(lo, hi + 1);
    setSelectedPoseItemIds((prev) => {
      const n = new Set(prev);
      for (const k of range) {
        if (targetChecked) n.add(k);
        else n.delete(k);
      }
      return n;
    });
  }

  function openPoseMenu(e: React.MouseEvent, item: GallerySplitItem, isHidden: boolean) {
    e.preventDefault();
    e.stopPropagation();
    const x = e.clientX;
    const y = e.clientY;
    void (async () => {
      const items: ContextMenuItem[] = [];
      if (isHidden) {
        items.push({
          key: "aiEdit",
          label: "AI Edit",
          onSelect: () => openAiEditForPose(item.folderKey, item.relPath),
        });
        items.push({
          key: "unhide",
          label: "Unhide",
          onSelect: () => {
            void apiPoseGalleryHidden(charKey, [item.itemId], false).then(() => {
              void refreshGallery();
              setSelectedPoseItemIds((prev) => {
                const n = new Set(prev);
                n.delete(item.itemId);
                return n;
              });
            });
          },
        });
        items.push({
          key: "download",
          label: "Download",
          onSelect: () => downloadRelPath(item.relPath),
        });

        items.push({
          key: "deleteImage",
          label: "Delete image",
          onSelect: () =>
            void (async () => {
              const ok = await confirmAction({
                title: "Delete image",
                message: "Delete this pose gallery image?",
                confirmText: "Delete",
              });
              if (!ok) return;
              try {
                await apiPoseAnglesDelete(charKey, POSE_FLAT_FOLDER_KEY, [item.relPath]);
                await refreshGallery();
              } catch (err) {
                showError({ message: "Delete image failed.", error: err });
              }
            })(),
        });
      } else {
        items.push({
          key: "aiEdit",
          label: "AI Edit",
          onSelect: () => openAiEditForPose(item.folderKey, item.relPath),
        });
        items.push({
          key: "addAngle",
          label: "Add angle",
          onSelect: () => {
            setSelectedPoseItemIds(new Set([item.itemId]));
            setAngleDialogImageUrl(
              item.relPath ? assetUrlFromRelPath(item.relPath, charKey) : null
            );
            setAngleDialogOpen(true);
          },
        });

        items.push({
          key: "hide",
          label: "Hide",
          onSelect: () => {
            void apiPoseGalleryHidden(charKey, [item.itemId], true).then(() => {
              void refreshGallery();
              setSelectedPoseItemIds((prev) => {
                const n = new Set(prev);
                n.delete(item.itemId);
                return n;
              });
            });
          },
        });
        items.push({
          key: "download",
          label: "Download",
          onSelect: () => downloadRelPath(item.relPath),
        });

        items.push({
          key: "deleteImage",
          label: "Delete image",
          onSelect: () =>
            void (async () => {
              const ok = await confirmAction({
                title: "Delete image",
                message: "Delete this pose gallery image?",
                confirmText: "Delete",
              });
              if (!ok) return;
              try {
                await apiPoseAnglesDelete(charKey, POSE_FLAT_FOLDER_KEY, [item.relPath]);
                await refreshGallery();
              } catch (err) {
                showError({ message: "Delete image failed.", error: err });
              }
            })(),
        });
      }
      setMenu({ open: true, x, y, items });
    })();
  }

  async function deleteSelectedPoseImages() {
    const idToItem = new Map(
      [...(split?.visible ?? []), ...(split?.hidden ?? [])].map((x) => [x.itemId, x])
    );
    const sel = Array.from(selectedPoseItemIds);
    const items = sel.map((id) => idToItem.get(id)).filter(Boolean) as GallerySplitItem[];
    if (!items.length) return;
    const ok = await confirmAction({
      title: "Delete image(s)",
      message: `Delete ${items.length} selected image(s)?`,
      confirmText: "Delete",
    });
    if (!ok) return;
    const rels = items.map((it) => it.relPath);
    try {
      await apiPoseAnglesDelete(charKey, POSE_FLAT_FOLDER_KEY, rels);
      await refreshGallery();
      setSelectedPoseItemIds(new Set());
    } catch (e) {
      showError({ message: "Delete failed.", error: e });
    }
  }

  function downloadRelPath(relPath: string | undefined) {
    if (!relPath) return;
    const a = document.createElement("a");
    a.href = assetDownloadUrlFromRelPath(relPath);
    a.download = relPath.split("/").pop() ?? "image.png";
    a.click();
  }

  async function runGenerate() {
    if (!charKey) return;
    if (!activeStartingRel) {
      showError({ message: "Please choose an input image first." });
      return;
    }
    if (
      !promptTextsForGeneration.length &&
      !selectedCatalogIds.length &&
      !referenceRef?.keypointRelPath
    ) {
      showError({ message: "Select at least one pose prompt or sample option." });
      return;
    }
    beginSession({ title: "Generating poses", clearLog: true });
    let poseSessionEndOk = false;
    try {
      const runPromptsJob =
        promptTextsForGeneration.length > 0 || !!referenceRef?.keypointRelPath;

      if (runPromptsJob) {
        // Custom/draft prompts (and optional keypoint-only default) use generate_prompts;
        // catalog uses generate_catalog in a separate WS job so backends stay distinct.
        const done = await runDetailWsJob<{
          firstPoseKey: string | null;
          lastInputRelPath: string;
        }>({
          charKey,
          pathSuffix: "/pose/ws",
          payload: {
            job: "generate_prompts",
            baseRelPath: activeStartingRel,
            prompts: promptTextsForGeneration,
            ...(referenceRef?.keypointRelPath
              ? { keypointRelPath: referenceRef.keypointRelPath }
              : {}),
          },
          onLogLine: (line) => logRef.current?.pushLine(line),
        });
        if (!done.ok) {
          failSession(
            new Error(done.error ?? "Pose generation failed"),
            "Pose generation failed"
          );
          return;
        }
        const r = done.result!;
        if (r.lastInputRelPath) {
          setStarting((prev) => mergeStackAfterGeneration(prev, r.lastInputRelPath));
        }
        await refreshGallery();
      }

      if (selectedCatalogIds.length) {
        const done = await runDetailWsJob<{
          firstPoseKey: string | null;
          lastInputRelPath: string;
        }>({
          charKey,
          pathSuffix: "/pose/ws",
          payload: {
            job: "generate_catalog",
            baseRelPath: activeStartingRel,
            items: selectedCatalogIds.map((pid) => ({
              catalogId: pid,
              label:
                catalogLabelOverrides[pid] ?? catalog.find((c) => c.id === pid)?.label ?? "",
            })),
            ...(referenceRef?.keypointRelPath
              ? { keypointRelPath: referenceRef.keypointRelPath }
              : {}),
          },
          onLogLine: (line) => logRef.current?.pushLine(line),
        });
        if (!done.ok) {
          failSession(
            new Error(done.error ?? "Pose generation failed"),
            "Pose generation failed"
          );
          return;
        }
        const r = done.result!;
        if (r.lastInputRelPath) {
          setStarting((prev) => mergeStackAfterGeneration(prev, r.lastInputRelPath));
        }
        await refreshGallery();
      } else if (!runPromptsJob) {
        showError({ message: "Select at least one sample pose option." });
        poseSessionEndOk = true;
        return;
      }

      poseSessionEndOk = true;
    } catch (e) {
      failSession(e, "Pose generation failed");
    } finally {
      if (poseSessionEndOk) endSession();
      setSelectedPoseItemIds(new Set());
    }
  }

  async function confirmAngles(selectedAngleIds: number[], manualFiles: File[]) {
    setAngleDialogOpen(false);
    if (!charKey) return;
    const inputRels =
      manualFiles.length > 0
        ? await Promise.all(
            manualFiles.map((file) =>
              apiUploadStaging({ charKey, file }).then((r) => r.relPath)
            )
          )
        : [];
    const vis = split?.visible ?? [];
    const visIdSet = new Set(vis.map((v) => v.itemId));
    const selectedIds = Array.from(selectedPoseItemIds).filter((id) => visIdSet.has(id));
    if (!selectedIds.length) {
      showError({ message: "Select at least one visible pose (checkboxes)." });
      return;
    }
    const firstSel = selectedIds
      .map((id) => vis.find((v) => v.itemId === id))
      .find(Boolean);
    if (!firstSel) {
      showError({ message: "Select at least one visible pose (checkboxes)." });
      return;
    }
    if (!inputRels.length && !selectedAngleIds.length) return;
    beginSession({ title: "Generating angles", clearLog: true });
    let poseAnglesSessionOk = false;
    try {
      // Server resolves inputRelPath(s) to absolute files, then imports each and
      // runs multi-angle generation with that gallery copy as Comfy base (see logic.run_pose_multi_angle_ws_job).
      const payload: Record<string, unknown> = {
        job: "angles",
        poseKeys: [POSE_FLAT_FOLDER_KEY],
        angleIds: selectedAngleIds,
      };
      if (inputRels.length) {
        payload.inputRelPaths = inputRels;
      } else if (firstSel.relPath) {
        payload.inputRelPath = firstSel.relPath;
      }
      const done = await runDetailWsJob({
        charKey,
        pathSuffix: "/pose/ws",
        payload,
        onLogLine: (line) => logRef.current?.pushLine(line),
      });
      if (!done.ok) {
        failSession(
          new Error(done.error ?? "Angle generation failed"),
          "Angle generation failed"
        );
      } else {
        await refreshGallery();
        poseAnglesSessionOk = true;
      }
    } catch (e) {
      failSession(e, "Angle generation failed");
    } finally {
      if (poseAnglesSessionOk) endSession();
      setSelectedPoseItemIds(new Set());
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

          {/* Column B: Reference + keypoint */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <button
                type="button"
                disabled={uiBusy}
                onClick={() => setReferencePickerOpen(true)}
                style={{
                  width: 140,
                  height: 140,
                  borderRadius: 0,
                  border: "1px solid rgba(0,0,0,0.5)",
                  background: "transparent",
                  cursor: uiBusy ? "not-allowed" : "pointer",
                }}
              >
                Add Reference
              </button>
              {referenceRef && (
                <div
                  style={{
                    width: 140,
                    height: 140,
                    flexShrink: 0,
                    border: "1px solid rgba(0,0,0,0.35)",
                    overflow: "hidden",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={assetUrlFromRelPath(referenceRef.referenceRelPath)}
                    alt="Reference"
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    draggable={false}
                  />
                </div>
              )}
            </div>
            {referenceRef ? (
              <div
                style={{ position: "relative" }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    open: true,
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      {
                        key: "clear-ref",
                        label: "Clear reference",
                        onSelect: () => setReferenceRef(null),
                      },
                    ],
                  });
                }}
              >
                <ZoomableImage
                  src={assetUrlFromRelPath(referenceRef.keypointRelPath)}
                  alt="Keypoint preview"
                  fitMaxWidth={STARTING_PREVIEW_MAX_W}
                  fitMaxHeight={STARTING_PREVIEW_MAX_H}
                />
              </div>
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
                No reference
              </div>
            )}
          </div>
        </div>

        <div style={{ marginBottom: 10, opacity: 0.95 }}>
          {referenceRef?.keypointRelPath
            ? "Describe new poses to generate or select ones from below. With a reference keypoint loaded, the prompt is optional and defaults to matching the reference pose."
            : "Describe new poses to generate or select ones from below."}
        </div>

        {draftRows.map((row, idx) => {
          const showDraftClose = idx > 0;
          return (
          <div key={idx} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "flex-start" }}>
            <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
              {showDraftClose ? (
                <button
                  type="button"
                  aria-label="Close draft prompt"
                  title="Close"
                  disabled={uiBusy}
                  onClick={() =>
                    setDraftRows((prev) =>
                      prev.length > 1 ? prev.filter((_, i) => i !== idx) : [""]
                    )
                  }
                  style={{
                    position: "absolute",
                    top: 5,
                    left: 5,
                    zIndex: 1,
                    width: 22,
                    height: 22,
                    padding: 0,
                    fontSize: 14,
                    lineHeight: 1,
                    border: "1px solid rgba(0,0,0,0.35)",
                    borderRadius: 0,
                    background: "rgba(255,255,255,0.75)",
                    color: "inherit",
                    cursor: uiBusy ? "not-allowed" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  ×
                </button>
              ) : null}
              <textarea
                value={row}
                disabled={uiBusy}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraftRows((prev) => {
                    const n = [...prev];
                    n[idx] = v;
                    return n;
                  });
                }}
                placeholder={
                  referenceRef?.keypointRelPath
                    ? "Provide description of reference pose"
                    : "Input new pose description"
                }
                rows={2}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: showDraftClose ? "10px 10px 8px 32px" : "8px 10px",
                  border: "1px solid rgba(0,0,0,0.35)",
                  background: "transparent",
                  color: "inherit",
                  fontSize: 14,
                  resize: "vertical",
                }}
              />
            </div>
            <button
              type="button"
              disabled={uiBusy}
              onClick={() => {
                const raw = row.trim();
                if (!raw) return;
                const id = `p_${Date.now()}_${idx}`;
                setSavedPrompts((s) => [
                  { id, text: raw, checked: true },
                  ...s.filter((x) => x.text !== raw),
                ]);
                setDraftRows((prev) => {
                  const n = [...prev];
                  n[idx] = "";
                  return n;
                });
              }}
              style={{
                borderRadius: 0,
                border: "1px solid rgba(0,0,0,0.5)",
                background: "transparent",
                padding: "8px 12px",
                cursor: "pointer",
              }}
            >
              Add Prompt to List
            </button>
          </div>
          );
        })}

        <button
          type="button"
          disabled={uiBusy}
          onClick={() => setDraftRows((r) => [...r, ""])}
          style={{
            borderRadius: 0,
            border: "1px solid rgba(0,0,0,0.5)",
            background: "transparent",
            padding: "8px 12px",
            cursor: "pointer",
            marginBottom: 12,
          }}
        >
          New Prompt
        </button>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 10 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, opacity: 0.95 }}>
            <input
              type="checkbox"
              checked={selectAllSamples}
              disabled={uiBusy}
              onChange={(e) => setSelectAllSamples(e.target.checked)}
            />
            Select all sample pose options
          </label>
        </div>

        <div
          style={{
            border: "1px solid rgba(0,0,0,0.25)",
            height: 140,
            minHeight: 80,
            maxHeight: "min(70vh, 720px)",
            overflow: "auto",
            resize: "vertical",
            padding: 8,
            marginBottom: 16,
            boxSizing: "border-box",
          }}
        >
          {savedPrompts.map((sp) => (
            <div
              key={sp.id}
              style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({
                  open: true,
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    {
                      key: "edit",
                      label: "Edit",
                      onSelect: async () => {
                        const t = await askText({
                          title: "Edit Prompt",
                          message: "Prompt text:",
                          defaultValue: sp.text,
                          confirmText: "Save",
                        });
                        if (!t?.trim()) {
                          showError({ message: "Prompt cannot be empty." });
                          return;
                        }
                        setSavedPrompts((s) =>
                          s.map((x) => (x.id === sp.id ? { ...x, text: t.trim() } : x))
                        );
                      },
                    },
                    {
                      key: "remove",
                      label: "Remove",
                      onSelect: () =>
                        setSavedPrompts((s) => s.filter((x) => x.id !== sp.id)),
                    },
                  ],
                });
              }}
            >
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={sp.checked}
                  disabled={uiBusy}
                  onChange={(e) =>
                    onSampleCheckboxChange(`custom:${sp.id}`, e.target.checked, e)
                  }
                />
                <span>{sp.text}</span>
              </label>
            </div>
          ))}
          {catalog
            .filter((c) => !hiddenCatalogIds.has(c.id))
            .map((c) => {
              const effectiveLabel = catalogLabelOverrides[c.id] ?? c.label;
              return (
                <div
                  key={c.id}
                  style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                      open: true,
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        {
                          key: "edit",
                          label: "Edit",
                          onSelect: async () => {
                            const t = await askText({
                              title: "Edit Prompt",
                              message: "Prompt text:",
                              defaultValue: effectiveLabel,
                              confirmText: "Save",
                            });
                            if (!t?.trim()) {
                              showError({ message: "Prompt cannot be empty." });
                              return;
                            }
                            setCatalogLabelOverrides((o) => ({
                              ...o,
                              [c.id]: t.trim(),
                            }));
                          },
                        },
                        {
                          key: "remove",
                          label: "Remove",
                          onSelect: () => {
                            setHiddenCatalogIds((prev) => new Set(prev).add(c.id));
                            setSampleSel((s) => {
                              const n = { ...s };
                              delete n[c.id];
                              return n;
                            });
                            setCatalogLabelOverrides((o) => {
                              const next = { ...o };
                              delete next[c.id];
                              return next;
                            });
                          },
                        },
                      ],
                    });
                  }}
                >
                  <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <input
                      type="checkbox"
                      disabled={uiBusy}
                      checked={!!sampleSel[c.id]}
                      onChange={(e) =>
                        onSampleCheckboxChange(`cat:${c.id}`, e.target.checked, e)
                      }
                    />
                    <span>{effectiveLabel}</span>
                  </label>
                </div>
              );
            })}
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12, marginBottom: 16 }}>
          <button
            type="button"
            disabled={uiBusy}
            onClick={() => void runGenerate()}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(0,0,0,0.5)",
              background: "transparent",
              padding: "8px 12px",
              cursor: "pointer",
            }}
          >
            {generateLabel}
          </button>
        </div>

        <div style={{ marginTop: 16, marginBottom: 8 }}>Pose Gallery</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          {(
            [
            ["Hide", () => {
              const vis = split?.visible ?? [];
              const visSet = new Set(vis.map((v) => v.itemId));
              const keys = Array.from(selectedPoseItemIds).filter((id) => visSet.has(id));
              if (!keys.length) return;
              void apiPoseGalleryHidden(charKey, keys, true).then(() => {
                void refreshGallery();
                setSelectedPoseItemIds((prev) => {
                  const n = new Set(prev);
                  for (const k of keys) n.delete(k);
                  return n;
                });
              });
            }],
            [
              "Delete",
              () => {
                void deleteSelectedPoseImages();
              },
            ],
            ["Unhide", () => {
              const hid = split?.hidden ?? [];
              const hidSet = new Set(hid.map((h) => h.itemId));
              const keys = Array.from(selectedPoseItemIds).filter((id) => hidSet.has(id));
              if (!keys.length) return;
              void apiPoseGalleryHidden(charKey, keys, false).then(() => {
                void refreshGallery();
                setSelectedPoseItemIds((prev) => {
                  const n = new Set(prev);
                  for (const k of keys) n.delete(k);
                  return n;
                });
              });
            }],
            [
              "Download",
              () => {
                const idToItem = new Map(
                  [...(split?.visible ?? []), ...(split?.hidden ?? [])].map((x) => [x.itemId, x])
                );
                for (const id of selectedPoseItemIds) {
                  downloadRelPath(idToItem.get(id)?.relPath);
                }
              },
            ],
          ] as [string, () => void][]
          ).map(([label, fn]) => (
            <button
              key={label}
              type="button"
              disabled={uiBusy}
              onClick={() => {
                fn();
              }}
              style={{
                borderRadius: 0,
                border: "1px solid rgba(0,0,0,0.5)",
                background: "transparent",
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <SortableMultiGrid
          disabled={uiBusy}
          crossContainerPreview={false}
          containers={[
            { id: "poseVisible", ids: dragContainers.visible },
            { id: "poseHidden", ids: dragContainers.hidden },
          ]}
          renderContainer={({ containerId, children, setContainerRef }) => {
            if (containerId === "poseVisible") {
              return (
                <>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                      alignItems: "flex-end",
                      marginBottom: 8,
                    }}
                  >
                    <AddFromGalleryTile
                      tile={tile}
                      disabled={uiBusy}
                      onPick={() => void chooseImageFromOppositeGalleryVisible()}
                    />
                    <ImportGalleryTile
                      tile={tile}
                      disabled={uiBusy}
                      dragOver={importDragOver}
                      onPick={() => importInputRef.current?.click()}
                      onDragOver={(ev) => {
                        ev.preventDefault();
                        if (!uiBusy) setImportDragOver(true);
                      }}
                      onDragLeave={() => setImportDragOver(false)}
                      onDrop={(ev) => {
                        ev.preventDefault();
                        setImportDragOver(false);
                        if (uiBusy) return;
                        void onImportFiles(Array.from(ev.dataTransfer.files ?? []));
                      }}
                    />
                  </div>
                  <ResizableScrollGallery aria-label="Pose gallery visible">
                    <div ref={setContainerRef as any} style={galleryDroppableStyle}>
                      {children}
                    </div>
                  </ResizableScrollGallery>
                </>
              );
            }
            return (
              <>
                <div style={{ marginTop: 16, marginBottom: 8 }}>Hidden</div>
                <ResizableScrollGallery aria-label="Pose gallery hidden">
                  <div ref={setContainerRef as any} style={galleryDroppableStyle}>
                    {children}
                  </div>
                </ResizableScrollGallery>
              </>
            );
          }}
          renderItem={({ id, containerId }) => {
            const isHidden = containerId === "poseHidden";
            const it =
              (split?.visible ?? []).find((x) => x.itemId === id) ??
              (split?.hidden ?? []).find((x) => x.itemId === id);
            if (!it) return null;
            return (
              <SortableItemInContainer id={id} containerId={containerId} disabled={uiBusy}>
                <GalleryPoseTile
                  tile={tile}
                  item={it}
                  checked={selectedPoseItemIds.has(it.itemId)}
                  disabled={uiBusy}
                  onToggle={(on, e) => onGalleryCheckboxChange(it.itemId, on, e)}
                  onPrimary={() => void onPoseTilePrimaryClick(it.itemId)}
                  onContextMenu={(e) => openPoseMenu(e, it, isHidden)}
                />
              </SortableItemInContainer>
            );
          }}
          renderDragOverlay={({ id }) => {
            const it =
              (split?.visible ?? []).find((x) => x.itemId === id) ??
              (split?.hidden ?? []).find((x) => x.itemId === id);
            if (!it) return null;
            return (
              <div style={{ width: tile, cursor: "grabbing", touchAction: "none" }}>
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
          onDragEnd={({ activeId, overId, insertAfter, sourceContainerId, targetContainerId }) => {
            const containers = {
              poseVisible: dragContainers.visible,
              poseHidden: dragContainers.hidden,
            };
            const r = reorderInsertBeforeOrAfter({
              activeId,
              overId,
              insertAfter,
              sourceContainerId,
              targetContainerId,
              containers,
              selectedIds: selectedPoseItemIds,
            });
            const nextVisible = r.containers.poseVisible ?? [];
            const nextHidden = r.containers.poseHidden ?? [];
            setDragContainers({ visible: nextVisible, hidden: nextHidden });
            skipSplitSyncRef.current++;
            void apiPoseGalleryUiState(charKey, {
              order: [...nextVisible, ...nextHidden],
              hiddenKeys: nextHidden,
            }).then(() => refreshGallery());
          }}
        />
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept="image/*"
        multiple
        disabled={uiBusy}
        style={{ display: "none" }}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.currentTarget.value = "";
          void onImportFiles(list);
        }}
      />

      <ImagePickerModal
        open={pickerOpen}
        title="Choose input image"
        okText="Use"
        cancelText="Cancel"
        images={pickerImages}
        onCancel={() => setPickerOpen(false)}
        onPick={(relPath) => {
          setPickerOpen(false);
          if (pickerMode === "startingStack") {
            setStarting((prev) => appendStartingFromLibrary(prev, relPath));
          } else {
            void importRelPathIntoCurrentPoseGallery(relPath);
          }
        }}
      />

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />

      <CameraAngleModal
        open={angleDialogOpen}
        title="New Angle"
        imageUrl={angleDialogImageUrl}
        onCancel={() => setAngleDialogOpen(false)}
        onConfirm={(angleId) => void confirmAngles([angleId], [])}
      />

      <AiEditModal
        open={aiEditOpen}
        title="AI Edit"
        imageSrc={aiEditSourceRelPath ? assetUrlFromRelPath(aiEditSourceRelPath) : ""}
        busy={uiBusy}
        onCancel={() => setAiEditOpen(false)}
        onGenerate={(promptText, maskPngBase64) =>
          void onAiEditGeneratePose(promptText, maskPngBase64)
        }
      />

      <ReferencePicker
        open={referencePickerOpen}
        charKey={charKey}
        busy={uiBusy}
        onCancel={() => setReferencePickerOpen(false)}
        onPickSaved={onReferencePickSaved}
        onPickNew={onReferencePickNew}
        onGenerateBase={onReferenceGenerateBase}
      />

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
    </DetailSubpageChrome>
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

function AddFromGalleryTile(props: {
  tile: number;
  disabled: boolean;
  onPick: () => void;
}) {
  const { tile, disabled, onPick } = props;
  return (
    <SquareButton
      disabled={disabled}
      onClick={onPick}
      variant="import"
      tone="dark"
      size={tile}
      style={{
        color: "inherit",
      }}
      title="Add image from gallery"
    >
      Add Image
      <br />
      From Gallery
    </SquareButton>
  );
}

