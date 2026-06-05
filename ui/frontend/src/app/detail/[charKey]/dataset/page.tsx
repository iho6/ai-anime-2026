"use client";

import React, { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useParams, useRouter } from "next/navigation";
import { ResizableScrollGallery } from "../../../../components/ResizableScrollGallery";
import {
  apiDatasetBuilderSources,
  apiDatasetExport,
  apiDatasetFolderDelete,
  apiDatasetFolderDownloadZip,
  apiDatasetFolderDuplicate,
  apiDatasetFolderNames,
  apiDatasetFolderRename,
  apiDatasetImageRename,
  apiDatasetImages,
  apiDatasetPreviewAddNoise,
  apiDatasetSavedCommit,
  apiDatasetSavedOrder,
  apiPoseAngleGroups,
  apiSequenceCreate,
  apiSequenceGet,
  apiSequenceFolderDelete,
  apiSequenceFolderDuplicate,
  apiSequenceFolderNames,
  apiSequenceFolderRename,
  apiSequencePut,
  apiUploadStaging,
  assetUrlFromRelPath,
  BuilderSourceItem,
  runDetailWsJob,
  runShotMakeAngleWsJob,
  type AngleGroup,
} from "../../../../lib/api";
import { SequenceEditor } from "./SequenceEditor";
import {
  DesktopContextMenu,
  ContextMenuItem,
  type DesktopContextMenuState,
} from "../../../../components/DesktopContextMenu";
import { DetailSubpageChrome } from "../../../../components/DetailSubpageChrome";
import type { SharedLogStreamHandle } from "../../../../components/SharedLogStream";
import { GalleryImageLightbox } from "../../../../components/GalleryImageLightbox";
import { ConnectedJobRunModal } from "../../../../components/ConnectedJobRunModal";
import { useJobRunSession, type BeginSessionOpts } from "../../../../hooks/useJobRunSession";
import { AiEditModal } from "../../../../components/AiEditModal";
import { AngleSubsetModal } from "../../../../components/AngleSubsetModal";
import { CameraAngleModal } from "../../../../components/CameraAngleModal";
import { useAppError } from "../../../../components/ErrorProvider";
import { SortableGrid, SortableItem } from "../../../../components/dnd/SortableGrid";
import { reorderInsertBeforeOrAfter } from "../../../../components/dnd/reorder";
import type { BuilderEntry } from "./builderTypes";
import {
  buildBuilderEntriesPreserve,
  builderSectionForTileId,
  builderSectionSelectableIds,
  builderStripOrderedTileIds,
  displayRelPath,
  syncBuilderStripsFromApi,
} from "./datasetBuilderStripUtils";
import { DatasetBuilderTab } from "./DatasetBuilderTab";
import { addImageToSequenceGallery } from "./datasetSequenceDrop";

const TILE = 120;

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

type SavedEntry = {
  tileId: string;
  basename: string;
  fileRelPath: string;
  previewRelPath: string | null;
  beforeNoiseRelPath: string | null;
  hidden: boolean;
  removed: boolean;
};

export default function DatasetPage() {
  const router = useRouter();
  const { showError, askText, confirmAction } = useAppError();
  const params = useParams<{ charKey: string }>();
  const charKey = params?.charKey ?? "";

  const [view, setView] = useState<"builder" | "saved" | "sequence">("builder");
  const [dirty, setDirty] = useState(false);
  const [folderNames, setFolderNames] = useState<string[]>([]);
  const [sequenceNames, setSequenceNames] = useState<string[]>([]);
  const [sequenceFolderKey, setSequenceFolderKey] = useState<string | null>(null);
  const sequenceFlushRef = useRef<null | (() => Promise<void>)>(null);
  const [entries, setEntries] = useState<BuilderEntry[]>([]);
  const [builderPoseStripIds, setBuilderPoseStripIds] = useState<string[]>([]);
  const [builderExprStripIds, setBuilderExprStripIds] = useState<string[]>([]);
  const [selectedBuilder, setSelectedBuilder] = useState<Set<string>>(new Set());
  const [builderAnchorTileId, setBuilderAnchorTileId] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [savedEntries, setSavedEntries] = useState<SavedEntry[]>([]);
  const [selectedSaved, setSelectedSaved] = useState<Set<string>>(new Set());
  const logRef = useRef<SharedLogStreamHandle>(null);
  const {
    running: busy,
    beginSession,
    endSession,
    pushLog,
    failSession,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);

  const failRmbgJob = useCallback(
    (err: unknown) => failSession(err, "Remove background failed."),
    [failSession]
  );
  const [folderClip, setFolderClip] = useState<{
    kind: "dataset";
    name: string;
    charKey: string;
  } | null>(null);
  const [menu, setMenu] = useState<DesktopContextMenuState>({
    open: false,
    x: 0,
    y: 0,
    items: [],
    footerItems: [],
  });
  const [lightbox, setLightbox] = useState<{
    paths: string[];
    index: number;
    title: string;
  } | null>(null);
  const datasetAnglesCtxRef = useRef<{
    kind: "pose" | "expr";
    folderKey: string;
    inputRelPath?: string;
  } | null>(null);
  const [datasetAngleGroups, setDatasetAngleGroups] = useState<AngleGroup[]>([]);
  // Per-tile single-angle camera gizmo (right-click "Add angle").
  const [datasetCameraAngleOpen, setDatasetCameraAngleOpen] = useState(false);
  const [datasetCameraImageUrl, setDatasetCameraImageUrl] = useState<string | null>(null);
  // Batch Angle (checkbox grid) over selected builder tiles (toolbar button).
  const [datasetBatchAngleOpen, setDatasetBatchAngleOpen] = useState(false);

  // Sequence gallery-frame single-angle camera gizmo (right-click "New Angle").
  const [seqAngleOpen, setSeqAngleOpen] = useState(false);
  const [seqAngleImageUrl, setSeqAngleImageUrl] = useState<string | null>(null);
  const seqAngleCtxRef = useRef<{
    seqName: string;
    galleryItemId: string;
    relPath: string;
  } | null>(null);

  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditMode, setAiEditMode] = useState<"builder" | "saved" | "sequence">("builder");
  const [aiEditSourceRelPath, setAiEditSourceRelPath] = useState<string>("");
  const [aiEditBuilderCtx, setAiEditBuilderCtx] = useState<BuilderEntry | null>(null);
  const [aiEditSavedCtx, setAiEditSavedCtx] = useState<SavedEntry | null>(null);
  const [aiEditSequenceName, setAiEditSequenceName] = useState<string>("");
  const [aiEditSequenceGalleryItemId, setAiEditSequenceGalleryItemId] = useState<string>("");

  const refreshStrip = useCallback(async () => {
    if (!charKey) return;
    const names = await apiDatasetFolderNames(charKey);
    setFolderNames(names);
  }, [charKey]);

  const refreshSequenceStrip = useCallback(async () => {
    if (!charKey) return;
    const names = await apiSequenceFolderNames(charKey);
    setSequenceNames(names);
  }, [charKey]);

  const onSequenceEditorError = useCallback(
    (msg: string, err?: unknown) => {
      showError({ message: msg, error: err });
    },
    [showError]
  );

  const onDropBuilderImageOnSequence = useCallback(
    async (sequenceName: string, sourceRelPath: string) => {
      try {
        await addImageToSequenceGallery(charKey, sequenceName, sourceRelPath);
        await refreshSequenceStrip();
      } catch (e) {
        showError({ message: "Could not add image to sequence gallery.", error: e });
      }
    },
    [charKey, refreshSequenceStrip, showError]
  );

  const openAiEditBuilder = useCallback(
    (entry: BuilderEntry) => {
      const rel = displayRelPath(entry);
      if (!rel) {
        showError({ message: "AI Edit: source image not found." });
        return;
      }
      setAiEditMode("builder");
      setAiEditBuilderCtx(entry);
      setAiEditSavedCtx(null);
      setAiEditSourceRelPath(rel);
      setAiEditOpen(true);
    },
    [showError]
  );

  const openAiEditSaved = useCallback(
    (entry: SavedEntry) => {
      if (!savedName) {
        showError({ message: "AI Edit: saved dataset name missing." });
        return;
      }
      const rel = displayRelPath(entry);
      if (!rel) {
        showError({ message: "AI Edit: source image not found." });
        return;
      }
      setAiEditMode("saved");
      setAiEditSavedCtx(entry);
      setAiEditBuilderCtx(null);
      setAiEditSourceRelPath(rel);
      setAiEditOpen(true);
    },
    [savedName, showError]
  );

  const openAiEditSequenceGallery = useCallback(
    (ctx: { relPath: string; galleryItemId: string }) => {
      if (!sequenceFolderKey) {
        showError({ message: "AI Edit: sequence name missing." });
        return;
      }
      const rel = (ctx.relPath || "").trim();
      if (!rel) {
        showError({ message: "AI Edit: source image not found." });
        return;
      }
      setAiEditMode("sequence");
      setAiEditBuilderCtx(null);
      setAiEditSavedCtx(null);
      setAiEditSequenceName(sequenceFolderKey);
      setAiEditSequenceGalleryItemId(ctx.galleryItemId);
      setAiEditSourceRelPath(rel);
      setAiEditOpen(true);
    },
    [sequenceFolderKey, showError]
  );

  const openNewAngleSequenceGallery = useCallback(
    (ctx: { relPath: string; galleryItemId: string }) => {
      if (!sequenceFolderKey) {
        showError({ message: "New Angle: sequence name missing." });
        return;
      }
      const rel = (ctx.relPath || "").trim();
      if (!rel) {
        showError({ message: "New Angle: source image not found." });
        return;
      }
      seqAngleCtxRef.current = {
        seqName: sequenceFolderKey,
        galleryItemId: ctx.galleryItemId,
        relPath: rel,
      };
      setSeqAngleImageUrl(assetUrlFromRelPath(rel));
      setSeqAngleOpen(true);
    },
    [sequenceFolderKey, showError]
  );

  const applyNewAngleSequenceGallery = useCallback(
    async (angleId: number) => {
      setSeqAngleOpen(false);
      const ctx = seqAngleCtxRef.current;
      seqAngleCtxRef.current = null;
      if (!charKey || !ctx) return;

      beginSession({ title: "Generating new angle", clearLog: true });
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
        endSession();
      } catch (err) {
        failSession(err, "New Angle failed.");
      }
    },
    [charKey, beginSession, endSession, failSession, apiSequenceGet, apiSequencePut]
  );

  const mergeBuilderFromApi = useCallback(
    async (preserve: Map<string, Partial<BuilderEntry>>) => {
      if (!charKey) return;
      const src = await apiDatasetBuilderSources(charKey);
      const next: BuilderEntry[] = [];
      const push = (b: BuilderSourceItem, kind: "pose" | "expr") => {
        const prev = preserve.get(b.tileId);
        next.push({
          tileId: b.tileId,
          sourceKind: kind,
          folderKey: b.folderKey,
          sourceRelPath: b.relPath,
          previewRelPath: prev?.previewRelPath ?? null,
          beforeNoiseRelPath: prev?.beforeNoiseRelPath ?? null,
          builderHidden: prev?.builderHidden ?? false,
          removed: prev?.removed ?? false,
        });
      };
      const ordered: BuilderSourceItem[] =
        src.items && src.items.length > 0
          ? src.items
          : [...src.poses, ...src.expressions];
      for (const b of ordered) {
        if (b.hidden) continue;
        const kind: "pose" | "expr" = b.sourceKind === "expr" ? "expr" : "pose";
        push(b, kind);
      }
      setEntries(next);
      const strips = syncBuilderStripsFromApi(next, src);
      setBuilderPoseStripIds(strips.pose);
      setBuilderExprStripIds(strips.expr);
    },
    [charKey]
  );

  const onAiEditGenerate = useCallback(
    async (promptText: string, maskPngBase64?: string) => {
      if (!charKey) return;
      if (!aiEditSourceRelPath) return;

      const mode = aiEditMode;
      const builderCtx = aiEditBuilderCtx;
      const savedCtx = aiEditSavedCtx;
      const seqName = aiEditSequenceName;
      const seqGalleryItemId = aiEditSequenceGalleryItemId;

      setAiEditOpen(false);
      beginSession({ title: "AI Editing", clearLog: false });

      try {
        if (mode === "builder") {
          if (!builderCtx) throw new Error("AI Edit: missing builder context");
          const done = await runDetailWsJob<{ previewRelPath: string }>({
            charKey,
            pathSuffix: "/dataset/ws",
            payload: {
              job: "ai_edit_builder_preview",
              sourceRelPath: aiEditSourceRelPath,
              sourceKind: builderCtx.sourceKind,
              promptText,
              ...(maskPngBase64 ? { maskPngBase64 } : {}),
            },
            onLogLine: (line) => logRef.current?.pushLine(line),
          });
          if (!done.ok || !done.result?.previewRelPath) {
            throw new Error(done.error ?? "AI Edit builder preview failed");
          }

          await mergeBuilderFromApi(buildBuilderEntriesPreserve(entries));
          setDirty(true);
        } else if (mode === "saved") {
          if (!savedName) throw new Error("AI Edit: saved dataset name missing");
          if (!savedCtx) throw new Error("AI Edit: missing saved context");
          const done = await runDetailWsJob<{ fileRelPath: string }>({
            charKey,
            pathSuffix: "/dataset/ws",
            payload: {
              job: "ai_edit_saved_dataset_image",
              datasetName: savedName,
              sourceRelPath: aiEditSourceRelPath,
              promptText,
              ...(maskPngBase64 ? { maskPngBase64 } : {}),
            },
            onLogLine: (line) => logRef.current?.pushLine(line),
          });
          if (!done.ok) {
            throw new Error(done.error ?? "AI Edit saved image failed");
          }

          // Show the new file immediately in saved strip.
          await openSavedDataset(savedName);
        } else {
          if (!seqName) throw new Error("AI Edit: sequence name missing");
          if (!seqGalleryItemId) throw new Error("AI Edit: sequence gallery item missing");
          const done = await runDetailWsJob<{ fileRelPath: string }>({
            charKey,
            pathSuffix: "/dataset/ws",
            payload: {
              job: "ai_edit_sequence_gallery_image",
              sequenceName: seqName,
              sourceRelPath: aiEditSourceRelPath,
              promptText,
              ...(maskPngBase64 ? { maskPngBase64 } : {}),
            },
            onLogLine: (line) => logRef.current?.pushLine(line),
          });
          if (!done.ok || !done.result?.fileRelPath) {
            throw new Error(done.error ?? "AI Edit sequence gallery image failed");
          }
          const manifest = await apiSequenceGet(charKey, seqName);
          const gi = manifest.gallery.findIndex((g) => g.id === seqGalleryItemId);
          if (gi < 0) throw new Error("AI Edit: sequence gallery item no longer exists");
          const nextGallery = manifest.gallery.map((g, i) =>
            i === gi ? { ...g, relPath: done.result!.fileRelPath } : g
          );
          await apiSequencePut(charKey, seqName, { ...manifest, gallery: nextGallery });
        }
      } catch (err) {
        failSession(err, "AI Edit failed.");
        return;
      }
      endSession();
    },
    [
      aiEditMode,
      aiEditSourceRelPath,
      aiEditBuilderCtx,
      aiEditSavedCtx,
      aiEditSequenceName,
      aiEditSequenceGalleryItemId,
      charKey,
      entries,
      beginSession,
      endSession,
      failSession,
      mergeBuilderFromApi,
      openSavedDataset,
      apiSequenceGet,
      apiSequencePut,
      savedName,
    ]
  );

  // Per-tile right-click "Add angle" -> single camera gizmo for that tile.
  function openDatasetBuilderAddAngles(ctx: {
    kind: "pose" | "expr";
    folderKey: string;
    inputRelPath?: string;
  }) {
    if (!charKey) return;
    datasetAnglesCtxRef.current = ctx;
    setDatasetCameraImageUrl(
      ctx.inputRelPath ? assetUrlFromRelPath(ctx.inputRelPath, charKey) : null
    );
    setDatasetCameraAngleOpen(true);
  }

  // Toolbar "Batch Angle" -> checkbox grid applied to selected builder tiles.
  async function openDatasetBatchAngles() {
    if (!charKey) return;
    const selected = entries.filter(
      (e) => selectedBuilder.has(e.tileId) && !e.removed
    );
    if (!selected.length) {
      showError({ message: "Select one or more tiles first (checkboxes)." });
      return;
    }
    try {
      // The 96 angle groups are identical across pose/expr; load once for display.
      const ag = await apiPoseAngleGroups(charKey);
      setDatasetAngleGroups(ag);
      setDatasetBatchAngleOpen(true);
    } catch (e) {
      showError({ message: "Failed to load angle groups.", error: e });
    }
  }

  async function confirmDatasetBatchAngles(selectedAngleIds: number[]) {
    setDatasetBatchAngleOpen(false);
    if (!charKey || !selectedAngleIds.length) return;
    const selected = entries.filter(
      (e) => selectedBuilder.has(e.tileId) && !e.removed
    );
    if (!selected.length) return;

    // Group selected tiles by kind, then by folderKey, collecting source paths.
    const groups: { kind: "pose" | "expr"; folderKey: string; rels: string[] }[] = [];
    for (const kind of ["pose", "expr"] as const) {
      const byFolder = new Map<string, string[]>();
      for (const e of selected.filter((x) => x.sourceKind === kind)) {
        const arr = byFolder.get(e.folderKey) ?? [];
        if (e.sourceRelPath) arr.push(e.sourceRelPath);
        byFolder.set(e.folderKey, arr);
      }
      for (const [folderKey, rels] of byFolder) {
        groups.push({ kind, folderKey, rels });
      }
    }
    if (!groups.length) return;

    beginSession({ title: "Generating angles", clearLog: true });
    let anglesSessionOk = false;
    try {
      for (const g of groups) {
        const payload: Record<string, unknown> = {
          job: "angles",
          angleIds: selectedAngleIds,
        };
        if (g.kind === "pose") payload.poseKeys = [g.folderKey];
        else payload.exprKeys = [g.folderKey];
        if (g.rels.length) payload.inputRelPaths = g.rels;

        const done = await runDetailWsJob({
          charKey,
          pathSuffix: g.kind === "pose" ? "/pose/ws" : "/expression/ws",
          payload,
          onLogLine: (line) => logRef.current?.pushLine(line),
        });
        if (!done.ok) {
          failSession(
            new Error(done.error ?? "Angle generation failed."),
            "Angle generation failed."
          );
          return;
        }
      }
      const preserve = new Map(
        entries.map((e) => [
          e.tileId,
          {
            previewRelPath: e.previewRelPath,
            beforeNoiseRelPath: e.beforeNoiseRelPath,
            builderHidden: e.builderHidden,
            removed: e.removed,
          },
        ])
      );
      await mergeBuilderFromApi(preserve);
      anglesSessionOk = true;
    } catch (e) {
      failSession(e, "Angle generation failed.");
    } finally {
      if (anglesSessionOk) endSession();
    }
  }

  async function confirmDatasetBuilderAngles(
    selectedAngleIds: number[],
    manualFiles: File[]
  ) {
    setDatasetCameraAngleOpen(false);
    const ctx = datasetAnglesCtxRef.current;
    datasetAnglesCtxRef.current = null;
    if (!charKey || !ctx) return;

    const inputRels =
      manualFiles.length > 0
        ? await Promise.all(
            manualFiles.map((file) =>
              apiUploadStaging({ charKey, file }).then((r) => r.relPath)
            )
          )
        : [];
    if (!inputRels.length && !selectedAngleIds.length) return;

    beginSession({ title: "Generating angles", clearLog: true });
    let anglesSessionOk = false;
    try {
      const payload: Record<string, unknown> = {
        job: "angles",
        angleIds: selectedAngleIds,
      };
      if (ctx.kind === "pose") {
        payload.poseKeys = [ctx.folderKey];
      } else {
        payload.exprKeys = [ctx.folderKey];
      }
      if (inputRels.length) {
        payload.inputRelPaths = inputRels;
      } else if (ctx.inputRelPath) {
        payload.inputRelPath = ctx.inputRelPath;
      }

      const done = await runDetailWsJob({
        charKey,
        pathSuffix: ctx.kind === "pose" ? "/pose/ws" : "/expression/ws",
        payload,
        onLogLine: (line) => logRef.current?.pushLine(line),
      });
      if (!done.ok) {
        failSession(new Error(done.error ?? "Angle generation failed."), "Angle generation failed.");
      } else {
        const preserve = new Map(
          entries.map((e) => [
            e.tileId,
            {
              previewRelPath: e.previewRelPath,
              beforeNoiseRelPath: e.beforeNoiseRelPath,
              builderHidden: e.builderHidden,
              removed: e.removed,
            },
          ])
        );
        await mergeBuilderFromApi(preserve);
        anglesSessionOk = true;
      }
    } catch (e) {
      failSession(e, "Angle generation failed.");
    } finally {
      if (anglesSessionOk) endSession();
    }
  }

  useEffect(() => {
    if (!charKey) return;
    void mergeBuilderFromApi(new Map());
    void refreshStrip();
    void refreshSequenceStrip();
  }, [charKey, mergeBuilderFromApi, refreshStrip, refreshSequenceStrip]);

  useEffect(() => {
    if (view === "sequence" && !sequenceFolderKey) {
      setView("builder");
    }
  }, [view, sequenceFolderKey]);

  function toggleSel(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string, on: boolean) {
    setter((prev) => {
      const n = new Set(prev);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  const beginRemoveBackgroundModal = useCallback(() => {
    beginSession({ title: "Removing background", clearLog: true });
  }, [beginSession]);

  const endRemoveBackgroundModal = useCallback(() => {
    endSession();
  }, [endSession]);

  async function runRembgOnRel(sourceRel: string): Promise<string> {
    const done = await runDetailWsJob<{ previewRelPath: string }>({
      charKey,
      pathSuffix: "/dataset/ws",
      payload: { job: "remove_background", sourceRelPath: sourceRel },
      onLogLine: (line) => logRef.current?.pushLine(line),
    });
    if (!done.ok || !done.result?.previewRelPath) {
      throw new Error(done.error ?? "Remove background failed");
    }
    return done.result.previewRelPath;
  }

  async function batchRemoveBackground(ids: string[]) {
    beginRemoveBackgroundModal();
    let rembgBatchOk = true;
    try {
      for (const tid of ids) {
        const e = entries.find((x) => x.tileId === tid);
        if (!e || e.removed || e.builderHidden) continue;
        const src = displayRelPath(e);
        if (!src) continue;
        const prev = await runRembgOnRel(src);
        setEntries((list) =>
          list.map((x) =>
            x.tileId === tid
              ? { ...x, previewRelPath: prev, beforeNoiseRelPath: null }
              : x
          )
        );
        setDirty(true);
      }
    } catch (err) {
      rembgBatchOk = false;
      failSession(err, "Remove background failed.");
    } finally {
      if (rembgBatchOk) endRemoveBackgroundModal();
      setSelectedBuilder(new Set());
    }
  }

  async function batchAddNoise(ids: string[]) {
    beginSession({ title: "Adding noise", clearLog: true });
    pushLog(`Adding noise to ${ids.length} selected tile(s) (API previews, no Comfy log).`);
    let noiseSessionOk = false;
    try {
      let doneTiles = 0;
      for (const tid of ids) {
        const e = entries.find((x) => x.tileId === tid);
        if (!e || e.removed || e.builderHidden) continue;
        const src = displayRelPath(e);
        if (!src) continue;
        const before = src;
        const { previewRelPath } = await apiDatasetPreviewAddNoise(charKey, src);
        setEntries((list) =>
          list.map((x) =>
            x.tileId === tid
              ? {
                  ...x,
                  beforeNoiseRelPath: before,
                  previewRelPath,
                }
              : x
          )
        );
        setDirty(true);
        doneTiles++;
        pushLog(`Tile ${doneTiles}: updated preview.`);
      }
      pushLog(`Finished: ${doneTiles} tile(s) updated.`);
      noiseSessionOk = true;
    } catch (err) {
      failSession(err, "Add noise failed.");
    } finally {
      if (noiseSessionOk) endSession();
      setSelectedBuilder(new Set());
    }
  }

  function batchRestoreBackground(ids: string[]) {
    for (const tid of ids) {
      setEntries((list) =>
        list.map((x) =>
          x.tileId === tid ? { ...x, previewRelPath: null, beforeNoiseRelPath: null } : x
        )
      );
    }
    setDirty(true);
    setSelectedBuilder(new Set());
  }

  function batchRemoveNoise(ids: string[]) {
    for (const tid of ids) {
      setEntries((list) =>
        list.map((x) => {
          if (x.tileId !== tid) return x;
          const prev = x.beforeNoiseRelPath;
          if (!prev) return x;
          return { ...x, previewRelPath: prev, beforeNoiseRelPath: null };
        })
      );
    }
    setDirty(true);
    setSelectedBuilder(new Set());
  }

  async function saveDatasetFolder() {
    const name = await askText({
      title: "Create Dataset Folder",
      message: "Name for folder under dataset/ (required):",
      defaultValue: "",
      confirmText: "Create",
    });
    if (!name?.trim()) {
      showError({ message: "A folder name is required." });
      return;
    }
    const orderedIds = builderStripOrderedTileIds(
      entries,
      builderPoseStripIds,
      builderExprStripIds,
      { requireSelectable: true }
    );
    const exportEntries = orderedIds
      .map((id) => entries.find((e) => e.tileId === id))
      .filter((e): e is BuilderEntry => Boolean(e))
      .map((e) => {
        const rel = displayRelPath(e);
        if (!rel) return null;
        return {
          sourceKind: e.sourceKind,
          folderKey: e.folderKey,
          fileRelPath: rel,
        };
      })
      .filter(Boolean) as { sourceKind: string; folderKey: string; fileRelPath: string }[];
    if (!exportEntries.length) {
      showError({
        message: "No images to export (all removed, hidden on this page, or missing files).",
      });
      return;
    }
    beginSession({ title: "Exporting dataset", clearLog: true });
    pushLog(`Export folder name: ${name.trim()}`);
    pushLog(`Entries: ${exportEntries.length}`);
    pushLog("Calling export API…");
    try {
      const r = await apiDatasetExport({ charKey, name: name.trim(), entries: exportEntries });
      pushLog(r.message);
      setEntries((list) =>
        list.map((e) => ({ ...e, previewRelPath: null, beforeNoiseRelPath: null }))
      );
      setDirty(false);
      await refreshStrip();
    } catch (e) {
      failSession(e, "Save dataset folder failed.");
      return;
    }
    endSession();
  }

  async function createSequenceFromSelection() {
    if (!selectedBuilder.size) {
      showError({ message: "Select at least one image to create a sequence." });
      return;
    }
    const name = await askText({
      title: "Create Sequence",
      message: "Name for folder under sequence/ (required):",
      defaultValue: "",
      confirmText: "Create",
    });
    if (!name?.trim()) {
      showError({ message: "A sequence name is required." });
      return;
    }
    const orderedIds = builderStripOrderedTileIds(
      entries,
      builderPoseStripIds,
      builderExprStripIds,
      { requireSelectable: true }
    );
    const exportEntries = orderedIds
      .filter((id) => selectedBuilder.has(id))
      .map((id) => entries.find((e) => e.tileId === id))
      .filter((e): e is BuilderEntry => Boolean(e))
      .map((e) => {
        const rel = displayRelPath(e);
        if (!rel) return null;
        return {
          sourceKind: e.sourceKind,
          folderKey: e.folderKey,
          fileRelPath: rel,
        };
      })
      .filter(Boolean) as { sourceKind: string; folderKey: string; fileRelPath: string }[];
    if (!exportEntries.length) {
      showError({
        message:
          "No images in selection (check removed, hidden on this page, or missing files).",
      });
      return;
    }
    beginSession({ title: "Creating sequence", clearLog: true });
    pushLog(`Sequence name: ${name.trim()}`);
    pushLog(`Source entries: ${exportEntries.length}`);
    pushLog("Calling create sequence API…");
    try {
      const r = await apiSequenceCreate({
        charKey,
        name: name.trim(),
        entries: exportEntries,
      });
      pushLog(r.message);
      await refreshSequenceStrip();
      setSequenceFolderKey(r.folderName);
      setView("sequence");
      setSelectedBuilder(new Set());
      endSession();
    } catch (e) {
      failSession(e, "Create sequence failed.");
    }
  }

  async function openSavedDataset(name: string) {
    const imgs = await apiDatasetImages(charKey, name);
    setSavedName(name);
    setSavedEntries(
      imgs.map((im, i) => ({
        tileId: `file:${im.relPath.split("/").pop() ?? `f${i}`}`,
        basename: im.relPath.split("/").pop() ?? `image_${i}.png`,
        fileRelPath: im.relPath,
        previewRelPath: null,
        beforeNoiseRelPath: null,
        hidden: false,
        removed: false,
      }))
    );
    setView("saved");
  }

  function handleBack() {
    if (view === "sequence") {
      void (async () => {
        try {
          await (sequenceFlushRef.current?.() ?? Promise.resolve());
        } catch {
          /* best-effort flush */
        }
        setSequenceFolderKey(null);
        setView("builder");
      })();
      return;
    }
    if (view === "saved") {
      setView("builder");
      return;
    }
    if (!dirty) {
      router.push(`/detail/${encodeURIComponent(charKey)}`);
      return;
    }
    void (async () => {
      const ok = await confirmAction({
        title: "Unsaved Previews",
        message:
          "You have preview edits that are not saved to a dataset folder. Leave anyway?",
        confirmText: "Leave",
      });
      if (!ok) return;
      setDirty(false);
      router.push(`/detail/${encodeURIComponent(charKey)}`);
    })();
  }

  async function renameDatasetAndStay(oldName: string, newName: string) {
    const nn = newName.trim();
    if (!nn) return;
    await apiDatasetFolderRename(charKey, oldName, nn);
    await refreshStrip();
    await openSavedDataset(nn);
  }

  function downloadRel(rel: string) {
    const a = document.createElement("a");
    a.href = assetUrlFromRelPath(rel);
    a.download = rel.split("/").pop() ?? "img.png";
    a.click();
  }

  function onBuilderTileCheckboxChange(
    tileId: string,
    targetChecked: boolean,
    ev: React.ChangeEvent<HTMLInputElement>
  ) {
    const isShift = (ev.nativeEvent as MouseEvent).shiftKey;
    if (isShift && !targetChecked) {
      setSelectedBuilder(new Set());
      return;
    }

    if (!isShift) {
      toggleSel(setSelectedBuilder, tileId, targetChecked);
      setBuilderAnchorTileId(tileId);
      return;
    }

    const anchor = builderAnchorTileId;
    if (!anchor) {
      toggleSel(setSelectedBuilder, tileId, targetChecked);
      setBuilderAnchorTileId(tileId);
      return;
    }

    const anchorSection = builderSectionForTileId(
      anchor,
      builderPoseStripIds,
      builderExprStripIds
    );
    const targetSection = builderSectionForTileId(
      tileId,
      builderPoseStripIds,
      builderExprStripIds
    );

    if (
      anchorSection === null ||
      targetSection === null ||
      anchorSection !== targetSection
    ) {
      toggleSel(setSelectedBuilder, tileId, targetChecked);
      setBuilderAnchorTileId(tileId);
      return;
    }

    const stripIds =
      anchorSection === "pose" ? builderPoseStripIds : builderExprStripIds;
    const ordered = builderSectionSelectableIds(entries, stripIds);
    const a = ordered.indexOf(anchor);
    const b = ordered.indexOf(tileId);
    if (a === -1 || b === -1) {
      toggleSel(setSelectedBuilder, tileId, targetChecked);
      setBuilderAnchorTileId(tileId);
      return;
    }

    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const range = ordered.slice(lo, hi + 1);
    setSelectedBuilder((prev) => {
      const n = new Set(prev);
      for (const id of range) {
        if (targetChecked) n.add(id);
        else n.delete(id);
      }
      return n;
    });
    setBuilderAnchorTileId(tileId);
  }

  return (
    <DetailSubpageChrome onHome={() => router.push("/home")} onBack={handleBack}>
      <div style={{ paddingLeft: 20, paddingRight: 20, maxWidth: 1100 }}>
        {view === "builder" ? (
          <DatasetBuilderTab
            charKey={charKey}
            busy={busy}
            entries={entries}
            setEntries={setEntries}
            setDirty={setDirty}
            selectedBuilder={selectedBuilder}
            setSelectedBuilder={setSelectedBuilder}
            setBuilderAnchorTileId={setBuilderAnchorTileId}
            onBuilderTileCheckboxChange={onBuilderTileCheckboxChange}
            folderNames={folderNames}
            sequenceNames={sequenceNames}
            refreshStrip={refreshStrip}
            refreshSequenceStrip={refreshSequenceStrip}
            setMenu={setMenu}
            showError={showError}
            askText={askText}
            confirmAction={confirmAction}
            downloadRel={downloadRel}
            mergeBuilderFromApi={mergeBuilderFromApi}
            logRef={logRef}
            onAiEditTile={openAiEditBuilder}
            onRequestAddAngles={openDatasetBuilderAddAngles}
            onOpenPreview={(paths, index, title) => setLightbox({ paths, index, title })}
            builderPoseStripIds={builderPoseStripIds}
            builderExprStripIds={builderExprStripIds}
            setBuilderPoseStripIds={setBuilderPoseStripIds}
            setBuilderExprStripIds={setBuilderExprStripIds}
            setView={setView}
            setSequenceFolderKey={setSequenceFolderKey}
            onSaveDatasetFolder={saveDatasetFolder}
            onOpenSavedDataset={openSavedDataset}
            onCreateSequenceFromSelection={createSequenceFromSelection}
            onBatchRemoveBackground={() => void batchRemoveBackground(Array.from(selectedBuilder))}
            onBatchAddNoise={() => void batchAddNoise(Array.from(selectedBuilder))}
            onBatchRestoreBackground={() => batchRestoreBackground(Array.from(selectedBuilder))}
            onBatchRemoveNoise={() => batchRemoveNoise(Array.from(selectedBuilder))}
            onBatchAngle={() => void openDatasetBatchAngles()}
            onDropBuilderImageOnSequence={onDropBuilderImageOnSequence}
            beginRemoveBackgroundModal={beginRemoveBackgroundModal}
            endRemoveBackgroundModal={endRemoveBackgroundModal}
            failRmbgJob={failRmbgJob}
            folderClip={folderClip}
            setFolderClip={setFolderClip}
          />
        ) : view === "saved" ? (
          <SavedDatasetView
            charKey={charKey}
            savedName={savedName}
            savedEntries={savedEntries}
            setSavedEntries={setSavedEntries}
            selectedSaved={selectedSaved}
            setSelectedSaved={setSelectedSaved}
            toggleSaved={(id, on) => toggleSel(setSelectedSaved, id, on)}
            busy={busy}
            beginDatasetJob={beginSession}
            endDatasetJob={endSession}
            logRef={logRef}
            beginRemoveBackgroundModal={beginRemoveBackgroundModal}
            endRemoveBackgroundModal={endRemoveBackgroundModal}
            failRmbgJob={failRmbgJob}
            downloadRel={downloadRel}
            refreshStrip={refreshStrip}
            setMenu={setMenu}
            folderClip={folderClip}
            setFolderClip={setFolderClip}
            onClose={() => setView("builder")}
            onOpenPreview={(paths, index, title) => setLightbox({ paths, index, title })}
            onError={showError}
            onPrompt={askText}
            onRenameDataset={renameDatasetAndStay}
            onAiEditTile={openAiEditSaved}
          />
        ) : view === "sequence" && sequenceFolderKey ? (
          <div>
            <div style={{ marginBottom: 8 }}>Sequence: {sequenceFolderKey}</div>
            <SequenceEditor
              charKey={charKey}
              sequenceName={sequenceFolderKey}
              onError={onSequenceEditorError}
              onAiEditSequenceGallery={openAiEditSequenceGallery}
              onNewAngleSequenceGallery={openNewAngleSequenceGallery}
              jobModal={{
                begin: beginSession,
                end: endSession,
                fail: failSession,
                log: pushLog,
              }}
              registerFlushSave={(fn) => {
                sequenceFlushRef.current = fn;
              }}
            />
          </div>
        ) : null}
      </div>

      <DesktopContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menu.items}
        footerItems={menu.footerItems}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />

      <CameraAngleModal
        open={datasetCameraAngleOpen}
        title="New Angle"
        imageUrl={datasetCameraImageUrl}
        onCancel={() => {
          setDatasetCameraAngleOpen(false);
          datasetAnglesCtxRef.current = null;
        }}
        onConfirm={(angleId) => {
          setDatasetCameraAngleOpen(false);
          void confirmDatasetBuilderAngles([angleId], []);
        }}
      />

      <AngleSubsetModal
        open={datasetBatchAngleOpen}
        title="Batch Angle: generate angles for the selected tiles."
        groups={datasetAngleGroups}
        onCancel={() => setDatasetBatchAngleOpen(false)}
        onConfirm={(ids) => void confirmDatasetBatchAngles(ids)}
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

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />

      <AiEditModal
        open={aiEditOpen}
        title="AI Edit"
        imageSrc={aiEditSourceRelPath ? assetUrlFromRelPath(aiEditSourceRelPath) : ""}
        busy={busy}
        onCancel={() => setAiEditOpen(false)}
        onGenerate={(promptText, maskPngBase64) =>
          void onAiEditGenerate(promptText, maskPngBase64)
        }
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


function SavedDatasetView(props: {
  charKey: string;
  savedName: string | null;
  savedEntries: SavedEntry[];
  setSavedEntries: React.Dispatch<React.SetStateAction<SavedEntry[]>>;
  selectedSaved: Set<string>;
  setSelectedSaved: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleSaved: (id: string, on: boolean) => void;
  busy: boolean;
  beginDatasetJob: (opts: BeginSessionOpts) => void;
  endDatasetJob: () => void;
  logRef: RefObject<SharedLogStreamHandle | null>;
  beginRemoveBackgroundModal: () => void;
  endRemoveBackgroundModal: () => void;
  failRmbgJob: (err: unknown) => void;
  downloadRel: (rel: string) => void;
  refreshStrip: () => Promise<void>;
  setMenu: React.Dispatch<React.SetStateAction<DesktopContextMenuState>>;
  folderClip: { kind: "dataset"; name: string; charKey: string } | null;
  setFolderClip: React.Dispatch<
    React.SetStateAction<{ kind: "dataset"; name: string; charKey: string } | null>
  >;
  onClose: () => void;
  onOpenPreview: (paths: string[], index: number, title: string) => void;
  onError: (input: { title?: string; message: string; error?: unknown; details?: string }) => void;
  onPrompt: (input: {
    title: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<string | null>;
  onRenameDataset: (oldName: string, newName: string) => Promise<void>;
  onAiEditTile: (entry: SavedEntry) => void;
}) {
  const {
    charKey,
    savedName,
    savedEntries,
    setSavedEntries,
    selectedSaved,
    setSelectedSaved,
    toggleSaved,
    busy,
    beginDatasetJob,
    endDatasetJob,
    logRef,
    beginRemoveBackgroundModal,
    endRemoveBackgroundModal,
    failRmbgJob,
    downloadRel,
    refreshStrip,
    setMenu,
    folderClip,
    setFolderClip,
    onClose,
    onOpenPreview,
    onError,
    onPrompt,
    onRenameDataset,
    onAiEditTile,
  } = props;
  const visibleSaved = savedEntries.filter((e) => !e.hidden && !e.removed);
  const hiddenSaved = savedEntries.filter((e) => e.hidden && !e.removed);
  const savedPreviewPaths = visibleSaved
    .map((x) => displayRelPath(x))
    .filter((p) => Boolean(p))
    .map((p) => assetUrlFromRelPath(p));
  const savedPreviewPathsHidden = hiddenSaved
    .map((x) => displayRelPath(x))
    .filter((p) => Boolean(p))
    .map((p) => assetUrlFromRelPath(p));

  if (!savedName) return null;

  async function downloadDatasetFolderZip() {
    if (!savedName || busy) return;
    try {
      const blob = await apiDatasetFolderDownloadZip(charKey, savedName);
      const safe = savedName.replace(/[/\\?%*:|"<>]/g, "_").trim() || "dataset";
      downloadBlobAsFile(blob, `${safe}.zip`);
    } catch (err) {
      onError({ message: "Dataset zip download failed.", error: err });
    }
  }

  async function commitSave() {
    if (!savedName) return;
    beginDatasetJob({ title: "Saving dataset", clearLog: false });
    try {
      await apiDatasetSavedCommit({
        charKey,
        datasetName: savedName,
        entries: savedEntries.map((e) => ({
          basename: e.basename,
          removed: e.removed,
          displayRelPath: e.removed ? null : displayRelPath(e),
        })),
      });
      onError({ title: "Dataset", message: "Dataset folder updated." });
      const imgs = await apiDatasetImages(charKey, savedName);
      setSavedEntries(
        imgs.map((im, i) => ({
          tileId: `file:${im.relPath.split("/").pop() ?? `f${i}`}`,
          basename: im.relPath.split("/").pop() ?? `image_${i}.png`,
          fileRelPath: im.relPath,
          previewRelPath: null,
          beforeNoiseRelPath: null,
          hidden: false,
          removed: false,
        }))
      );
    } catch (e) {
      onError({ message: "Commit dataset failed.", error: e });
    } finally {
      endDatasetJob();
    }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "flex-start" }}>
        <div
          style={{
            width: TILE,
            height: TILE,
            border: "1px solid rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            whiteSpace: "pre-wrap",
            fontSize: 14,
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({
              open: true,
              x: e.clientX,
              y: e.clientY,
              items: [
                {
                  key: "rn",
                  label: "Rename Dataset",
                  onSelect: async () => {
                    const nn = await onPrompt({
                      title: "Rename Dataset",
                      message: "New dataset folder name:",
                      defaultValue: savedName,
                      confirmText: "Rename",
                    });
                    if (!nn?.trim()) return;
                    void onRenameDataset(savedName, nn.trim())
                      .catch((err) => onError({ message: "Action failed.", error: err }));
                  },
                },
                {
                  key: "dl",
                  label: "Download Dataset",
                  onSelect: () => {
                    void downloadDatasetFolderZip();
                  },
                },
                {
                  key: "del",
                  label: "Delete Dataset",
                  onSelect: () => {
                    void apiDatasetFolderDelete(charKey, savedName)
                      .then(() => {
                        onClose();
                        void refreshStrip();
                      })
                      .catch((err) => onError({ message: "Action failed.", error: err }));
                  },
                },
              ],
              footerItems: savedName
                ? [
                    {
                      key: "ds-copy",
                      label: "Copy dataset",
                      disabled: busy,
                      onSelect: () => setFolderClip({ kind: "dataset", name: savedName, charKey }),
                    },
                    {
                      key: "ds-paste",
                      label: "Paste dataset",
                      disabled: busy || !folderClip || folderClip.charKey !== charKey,
                      onSelect: () => {
                        void (async () => {
                          if (!folderClip || folderClip.charKey !== charKey) return;
                          const src = folderClip.name;
                          const nn = await onPrompt({
                            title: "Paste dataset",
                            message: `Name for the copy of dataset "${src}":`,
                            defaultValue: `${src}_copy`,
                            confirmText: "Create",
                          });
                          if (!nn?.trim()) return;
                          try {
                            await apiDatasetFolderDuplicate(charKey, src, nn.trim());
                            await refreshStrip();
                          } catch (err) {
                            onError({ message: "Could not paste dataset.", error: err });
                          }
                        })();
                      },
                    },
                  ]
                : [],
            });
          }}
        >
          {savedName.replace(/ /g, "\n")}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {(
          [
            ["Rename Dataset", async () => {
              const nn = await onPrompt({
                title: "Rename Dataset",
                message: "New dataset folder name:",
                defaultValue: savedName,
                confirmText: "Rename",
              });
              if (!nn?.trim()) return;
              void onRenameDataset(savedName, nn.trim())
                .catch((err) => onError({ message: "Action failed.", error: err }));
            }],
            ["Download Dataset", () => {
              void downloadDatasetFolderZip();
            }],
            ["Delete Dataset", () => {
              void apiDatasetFolderDelete(charKey, savedName)
                .then(() => {
                  onClose();
                  void refreshStrip();
                })
                .catch((err) => onError({ message: "Action failed.", error: err }));
            }],
          ] as [string, () => void][]
        ).map(([label, fn]) => (
          <button
            key={label}
            type="button"
            disabled={busy}
            onClick={() => fn()}
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

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {(
          [
            ["Hide", () => {
              for (const id of Array.from(selectedSaved)) {
                setSavedEntries((list) =>
                  list.map((x) => (x.tileId === id ? { ...x, hidden: true } : x))
                );
              }
              setSelectedSaved(new Set());
            }],
            ["Unhide", () => {
              for (const id of Array.from(selectedSaved)) {
                setSavedEntries((list) =>
                  list.map((x) => (x.tileId === id ? { ...x, hidden: false } : x))
                );
              }
              setSelectedSaved(new Set());
            }],
            ["Delete", () => {
              for (const id of Array.from(selectedSaved)) {
                setSavedEntries((list) =>
                  list.map((x) => (x.tileId === id ? { ...x, removed: true } : x))
                );
              }
            }],
            [
              "Download",
              () => {
                for (const id of Array.from(selectedSaved)) {
                  const se = savedEntries.find((x) => x.tileId === id);
                  if (se) downloadRel(displayRelPath(se));
                }
              },
            ],
            [
              "Save",
              () => {
                void commitSave();
              },
            ],
          ] as [string, () => void][]
        ).map(([label, fn]) => (
          <button
            key={label}
            type="button"
            disabled={busy}
            onClick={() => fn()}
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

      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
        Drag the panel corner to resize the image grid
      </div>
      <ResizableScrollGallery
        aria-label={savedName ? `Dataset ${savedName} images` : "Saved dataset images"}
      >
        <SortableGrid
        ids={savedEntries.filter((e) => !e.removed).map((e) => e.tileId)}
        disabled={busy}
        style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 4 }}
        onDragEnd={({ activeId, overId, insertAfter }) => {
          if (!savedName) return;
          if (!overId || activeId === overId) return;
          const ids = savedEntries.filter((e) => !e.removed).map((e) => e.tileId);
          const containers = { saved: ids };
          const r = reorderInsertBeforeOrAfter({
            activeId,
            overId,
            insertAfter,
            sourceContainerId: "saved",
            targetContainerId: "saved",
            containers,
            selectedIds: selectedSaved,
          });
          const nextIds = r.containers.saved ?? [];
          setSavedEntries((list) => {
            const byId = new Map(list.map((x) => [x.tileId, x]));
            const moved: SavedEntry[] = [];
            const seen = new Set<string>();
            for (const tid of nextIds) {
              const e = byId.get(tid);
              if (e) {
                moved.push(e);
                seen.add(tid);
              }
            }
            const rest = list.filter((x) => !seen.has(x.tileId));
            return [...moved, ...rest];
          });
          const basenames = nextIds
            .map((tid) => tid.startsWith("file:") ? tid.slice("file:".length) : tid)
            .filter(Boolean);
          void apiDatasetSavedOrder(charKey, savedName, { basenames });
        }}
        renderItem={(tileId) => {
          const e = savedEntries.find((x) => x.tileId === tileId);
          if (!e) return null;
          const rel = displayRelPath(e);
          return (
            <SortableItem
              id={e.tileId}
              disabled={busy}
              style={{ width: TILE, display: "flex", flexDirection: "column", gap: 4 }}
            >
              <button
                  type="button"
                  onClick={() => {
                    if (e.hidden) {
                      const idx = Math.max(
                        0,
                        hiddenSaved.findIndex((x) => x.tileId === e.tileId)
                      );
                      onOpenPreview(
                        savedPreviewPathsHidden,
                        idx,
                        `Dataset: ${savedName} (hidden)`
                      );
                    } else {
                      const idx = Math.max(
                        0,
                        visibleSaved.findIndex((x) => x.tileId === e.tileId)
                      );
                      onOpenPreview(savedPreviewPaths, idx, `Dataset: ${savedName}`);
                    }
                  }}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    const items: ContextMenuItem[] = [
                      {
                        key: "aiEdit",
                        label: "AI Edit",
                        onSelect: () => onAiEditTile(e),
                      },
                      {
                        key: "rembg",
                        label: "Remove Background",
                        onSelect: () => {
                          void (async () => {
                            beginRemoveBackgroundModal();
                            try {
                              const done = await runDetailWsJob<{ previewRelPath: string }>({
                                charKey,
                                pathSuffix: "/dataset/ws",
                                payload: { job: "remove_background", sourceRelPath: rel },
                                onLogLine: (line) => logRef.current?.pushLine(line),
                              });
                              if (!done.ok || !done.result?.previewRelPath) throw new Error(done.error);
                              setSavedEntries((list) =>
                                list.map((x) =>
                                  x.tileId === e.tileId
                                    ? {
                                        ...x,
                                        previewRelPath: done.result!.previewRelPath,
                                        beforeNoiseRelPath: null,
                                      }
                                    : x
                                )
                              );
                              endRemoveBackgroundModal();
                            } catch (er) {
                              failRmbgJob(er);
                            }
                          })();
                        },
                      },
                      {
                        key: "noise",
                        label: "Add Noise",
                        onSelect: () => {
                          void apiDatasetPreviewAddNoise(charKey, rel)
                            .then(({ previewRelPath }) => {
                              setSavedEntries((list) =>
                                list.map((x) =>
                                  x.tileId === e.tileId
                                    ? {
                                        ...x,
                                        beforeNoiseRelPath: rel,
                                        previewRelPath,
                                      }
                                    : x
                                )
                              );
                            })
                            .catch((er) => onError({ message: "Action failed.", error: er }));
                        },
                      },
                      {
                        key: "restore",
                        label: "Restore background",
                        onSelect: () => {
                          setSavedEntries((list) =>
                            list.map((x) =>
                              x.tileId === e.tileId
                                ? { ...x, previewRelPath: null, beforeNoiseRelPath: null }
                                : x
                            )
                          );
                        },
                      },
                      {
                        key: "rmnoise",
                        label: "Remove noise",
                        onSelect: () => {
                          setSavedEntries((list) =>
                            list.map((x) => {
                              if (x.tileId !== e.tileId) return x;
                              const p = x.beforeNoiseRelPath;
                              if (!p) return x;
                              return { ...x, previewRelPath: p, beforeNoiseRelPath: null };
                            })
                          );
                        },
                      },
                      {
                        key: "hide",
                        label: "Hide",
                        onSelect: () => {
                          setSavedEntries((list) =>
                            list.map((x) => (x.tileId === e.tileId ? { ...x, hidden: true } : x))
                          );
                          setSelectedSaved((prev) => {
                            const n = new Set(prev);
                            n.delete(e.tileId);
                            return n;
                          });
                        },
                      },
                      {
                        key: "unhide",
                        label: "Unhide",
                        onSelect: () => {
                          setSavedEntries((list) =>
                            list.map((x) => (x.tileId === e.tileId ? { ...x, hidden: false } : x))
                          );
                          setSelectedSaved((prev) => {
                            const n = new Set(prev);
                            n.delete(e.tileId);
                            return n;
                          });
                        },
                      },
                      {
                        key: "dl1",
                        label: "Download",
                        onSelect: () => downloadRel(rel),
                      },
                      {
                        key: "rnf",
                        label: "Rename",
                        onSelect: async () => {
                          const stem = e.basename.replace(/\.[^.]+$/, "");
                          const nn = await onPrompt({
                            title: "Rename File",
                            message: "New file name (extension is kept):",
                            defaultValue: stem,
                            confirmText: "Rename",
                          });
                          if (!nn?.trim()) return;
                          void apiDatasetImageRename(charKey, savedName, e.basename, nn.trim())
                            .then(({ newBasename }) => {
                              setSavedEntries((list) =>
                                list.map((x) =>
                                  x.tileId === e.tileId
                                    ? {
                                        ...x,
                                        basename: newBasename,
                                        tileId: `file:${newBasename}`,
                                        fileRelPath: x.fileRelPath.replace(
                                          /[^/]+$/,
                                          newBasename
                                        ),
                                      }
                                    : x
                                )
                              );
                            })
                            .catch((er) => onError({ message: "Action failed.", error: er }));
                        },
                      },
                    ];
                    setMenu({ open: true, x: ev.clientX, y: ev.clientY, items, footerItems: [] });
                  }}
                  style={{
                    width: TILE,
                    height: TILE,
                    padding: 0,
                    border: "1px solid rgba(0,0,0,0.35)",
                    position: "relative",
                    opacity: e.hidden ? 0.4 : 1,
                    cursor: "pointer",
                    overflow: "hidden",
                  }}
                  className="gallery-cover-btn"
                >
                  <img
                    src={assetUrlFromRelPath(rel)}
                    alt=""
                    className="gallery-cover-img"
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />

                  <label
                    style={{
                      position: "absolute",
                      top: 4,
                      left: 6,
                      zIndex: 2,
                      cursor: busy ? "not-allowed" : "pointer",
                      opacity: busy ? 0.7 : 1,
                    }}
                    onMouseDown={(ev) => ev.stopPropagation()}
                    onClick={(ev) => ev.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selectedSaved.has(e.tileId)}
                      onChange={(ev) => toggleSaved(e.tileId, ev.target.checked)}
                      disabled={busy}
                      style={{ margin: 0 }}
                    />
                  </label>
                </button>
            </SortableItem>
          );
        }}
        />
      </ResizableScrollGallery>
    </>
  );
}

