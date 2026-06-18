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
  apiPoseCatalog,
  apiExpressionCatalog,
  type PoseCatalogItem,
  type ExpressionCatalogItem,
  apiUploadStaging,
  assetUrlFromRelPath,
  BuilderSourceItem,
  runDetailWsJob,
  type RemoveBgImageRunOptions,
  type AngleGroup,
} from "../../../../lib/api";
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
import { RemoveBgImageModal } from "../../../../components/removeBg/RemoveBgImageModal";
import { BatchGenerateModal, type BatchGenerateSelection } from "../../../../components/BatchGenerateModal";
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

  const [view, setView] = useState<"builder" | "saved">("builder");
  const [dirty, setDirty] = useState(false);
  const [folderNames, setFolderNames] = useState<string[]>([]);
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
    setRunningStatus,
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
  const [datasetPoseCatalog, setDatasetPoseCatalog] = useState<PoseCatalogItem[]>([]);
  const [datasetExprCatalog, setDatasetExprCatalog] = useState<ExpressionCatalogItem[]>([]);
  // Per-tile single-angle camera gizmo (right-click "Add angle").
  const [datasetCameraAngleOpen, setDatasetCameraAngleOpen] = useState(false);
  const [datasetCameraImageUrl, setDatasetCameraImageUrl] = useState<string | null>(null);
  // Batch Generate (angles / expression / pose) over selected builder tiles (toolbar button).
  const [datasetBatchGenOpen, setDatasetBatchGenOpen] = useState(false);

  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditMode, setAiEditMode] = useState<"builder" | "saved">("builder");
  const [aiEditSourceRelPath, setAiEditSourceRelPath] = useState<string>("");
  const [aiEditBuilderCtx, setAiEditBuilderCtx] = useState<BuilderEntry | null>(null);
  const [aiEditSavedCtx, setAiEditSavedCtx] = useState<SavedEntry | null>(null);

  const [removeBgImageOpen, setRemoveBgImageOpen] = useState(false);
  const removeBgPendingRef = useRef<
    | { kind: "builder_tile"; tileId: string; sourceRel: string }
    | { kind: "builder_batch"; tileIds: string[] }
    | { kind: "saved_tile"; tileId: string; sourceRel: string }
    | null
  >(null);

  const refreshStrip = useCallback(async () => {
    if (!charKey) return;
    const names = await apiDatasetFolderNames(charKey);
    setFolderNames(names);
  }, [charKey]);

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

      const onWsLogLine = (line: string) => {
        pushLog(line);
        const s = line.replace(/\s+/g, " ").trim();
        setRunningStatus(s.length > 120 ? `${s.slice(0, 119)}…` : s);
      };

      setAiEditOpen(false);
      beginSession({ title: "AI Editing", clearLog: true, runningStatus: "AI editing…" });
      await Promise.resolve();
      pushLog("AI editing…");

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
            onLogLine: onWsLogLine,
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
            onLogLine: onWsLogLine,
          });
          if (!done.ok) {
            throw new Error(done.error ?? "AI Edit saved image failed");
          }

          // Show the new file immediately in saved strip.
          await openSavedDataset(savedName);
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
      charKey,
      entries,
      beginSession,
      endSession,
      failSession,
      mergeBuilderFromApi,
      openSavedDataset,
      pushLog,
      savedName,
      setRunningStatus,
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

  // Toolbar "Batch Generate" -> angles / expression / pose for the selected builder tiles.
  async function openDatasetBatchGenerate(ensureTileId?: string) {
    if (!charKey) return;
    if (ensureTileId) {
      setSelectedBuilder((prev) => (prev.has(ensureTileId) ? prev : new Set(prev).add(ensureTileId)));
    }
    const selected = entries.filter(
      (e) => (selectedBuilder.has(e.tileId) || e.tileId === ensureTileId) && !e.removed
    );
    if (!selected.length) {
      showError({ message: "Select one or more tiles first (checkboxes)." });
      return;
    }
    try {
      // Angle groups are identical across pose/expr; catalogs drive the Expression/Pose sections.
      const [ag, pc, ec] = await Promise.all([
        apiPoseAngleGroups(charKey),
        apiPoseCatalog(charKey),
        apiExpressionCatalog(charKey),
      ]);
      setDatasetAngleGroups(ag);
      setDatasetPoseCatalog(pc);
      setDatasetExprCatalog(ec);
      setDatasetBatchGenOpen(true);
    } catch (e) {
      showError({ message: "Failed to load Batch Generate options.", error: e });
    }
  }

  async function confirmDatasetBatchGenerate(sel: BatchGenerateSelection) {
    setDatasetBatchGenOpen(false);
    if (!charKey) return;
    const selected = entries.filter(
      (e) => selectedBuilder.has(e.tileId) && !e.removed
    );
    if (!selected.length) return;

    const hasAngles = sel.angleIds.length > 0;
    const hasPose = sel.poseItems.length > 0 || sel.posePrompts.length > 0;
    const hasExpr = sel.exprItems.length > 0 || sel.exprPrompts.length > 0;
    if (!hasAngles && !hasPose && !hasExpr) return;

    // Wrap short prompt descriptions the same way the /create checklist does.
    const wrapPose = (s: string) =>
      `Edit the subject to ${s.trim()}, keep identity and clothing coherent unless impossible.`;
    const wrapExpr = (s: string) => `Edit the face to show ${s.trim()}, keep identity coherent.`;

    beginSession({ title: "Batch generating", clearLog: true });
    let sessionOk = false;
    try {
      // ── Angles: grouped by kind + folder (reuse the original grouping) ──────
      if (hasAngles) {
        const groups: { kind: "pose" | "expr"; folderKey: string; rels: string[] }[] = [];
        for (const kind of ["pose", "expr"] as const) {
          const byFolder = new Map<string, string[]>();
          for (const e of selected.filter((x) => x.sourceKind === kind)) {
            const arr = byFolder.get(e.folderKey) ?? [];
            if (e.sourceRelPath) arr.push(e.sourceRelPath);
            byFolder.set(e.folderKey, arr);
          }
          for (const [folderKey, rels] of byFolder) groups.push({ kind, folderKey, rels });
        }
        for (const g of groups) {
          const payload: Record<string, unknown> = { job: "angles", angleIds: sel.angleIds };
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
            failSession(new Error(done.error ?? "Angle generation failed."), "Angle generation failed.");
            return;
          }
        }
      }

      // ── Catalog + custom prompts: per selected tile, base = its source image ──
      const tilesWithRel = selected.filter((e) => e.sourceRelPath);
      const runCatalogAndPrompts = async (
        suffix: "/pose/ws" | "/expression/ws",
        items: { catalogId: number; label: string }[],
        prompts: string[]
      ) => {
        for (const e of tilesWithRel) {
          if (items.length) {
            const done = await runDetailWsJob({
              charKey,
              pathSuffix: suffix,
              payload: { job: "generate_catalog", baseRelPath: e.sourceRelPath, items },
              onLogLine: (line) => logRef.current?.pushLine(line),
            });
            if (!done.ok) {
              failSession(new Error(done.error ?? "Generation failed."), "Batch generate failed.");
              return false;
            }
          }
          if (prompts.length) {
            const done = await runDetailWsJob({
              charKey,
              pathSuffix: suffix,
              payload: { job: "generate_prompts", baseRelPath: e.sourceRelPath, prompts },
              onLogLine: (line) => logRef.current?.pushLine(line),
            });
            if (!done.ok) {
              failSession(new Error(done.error ?? "Generation failed."), "Batch generate failed.");
              return false;
            }
          }
        }
        return true;
      };

      if (hasExpr) {
        const ok = await runCatalogAndPrompts(
          "/expression/ws",
          sel.exprItems,
          sel.exprPrompts.map(wrapExpr)
        );
        if (!ok) return;
      }
      if (hasPose) {
        const ok = await runCatalogAndPrompts(
          "/pose/ws",
          sel.poseItems,
          sel.posePrompts.map(wrapPose)
        );
        if (!ok) return;
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
      sessionOk = true;
    } catch (e) {
      failSession(e, "Batch generate failed.");
    } finally {
      if (sessionOk) endSession();
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
  }, [charKey, mergeBuilderFromApi, refreshStrip]);

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

  async function runRembgOnRel(
    sourceRel: string,
    options: RemoveBgImageRunOptions
  ): Promise<string> {
    const done = await runDetailWsJob<{ previewRelPath: string }>({
      charKey,
      pathSuffix: "/dataset/ws",
      payload: {
        job: "remove_background",
        sourceRelPath: sourceRel,
        engine: options.engine,
        rmbg: options.rmbg,
        animeSeg: options.animeSeg,
      },
      onLogLine: (line) => logRef.current?.pushLine(line),
    });
    if (!done.ok || !done.result?.previewRelPath) {
      throw new Error(done.error ?? "Remove background failed");
    }
    return done.result.previewRelPath;
  }

  function openRemoveBgForBuilderTile(tileId: string, sourceRel: string) {
    removeBgPendingRef.current = { kind: "builder_tile", tileId, sourceRel };
    setRemoveBgImageOpen(true);
  }

  function openRemoveBgForSavedTile(tileId: string, sourceRel: string) {
    removeBgPendingRef.current = { kind: "saved_tile", tileId, sourceRel };
    setRemoveBgImageOpen(true);
  }

  async function runRemoveBgImage(options: RemoveBgImageRunOptions) {
    const pending = removeBgPendingRef.current;
    setRemoveBgImageOpen(false);
    removeBgPendingRef.current = null;
    if (!pending) return;

    if (pending.kind === "builder_batch") {
      beginRemoveBackgroundModal();
      let rembgBatchOk = true;
      try {
        for (const tid of pending.tileIds) {
          const e = entries.find((x) => x.tileId === tid);
          if (!e || e.removed || e.builderHidden) continue;
          const src = displayRelPath(e);
          if (!src) continue;
          const prev = await runRembgOnRel(src, options);
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
      return;
    }

    if (pending.kind === "builder_tile") {
      beginRemoveBackgroundModal();
      try {
        const prev = await runRembgOnRel(pending.sourceRel, options);
        setEntries((list) =>
          list.map((x) =>
            x.tileId === pending.tileId
              ? { ...x, previewRelPath: prev, beforeNoiseRelPath: null }
              : x
          )
        );
        setDirty(true);
        endRemoveBackgroundModal();
      } catch (err) {
        failRmbgJob(err);
      }
      return;
    }

    if (pending.kind === "saved_tile") {
      beginRemoveBackgroundModal();
      try {
        const prev = await runRembgOnRel(pending.sourceRel, options);
        setSavedEntries((list) =>
          list.map((x) =>
            x.tileId === pending.tileId
              ? { ...x, previewRelPath: prev, beforeNoiseRelPath: null }
              : x
          )
        );
        endRemoveBackgroundModal();
      } catch (err) {
        failRmbgJob(err);
      }
    }
  }

  function batchRemoveBackground(ids: string[]) {
    if (ids.length === 0) return;
    removeBgPendingRef.current = { kind: "builder_batch", tileIds: ids };
    setRemoveBgImageOpen(true);
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
            refreshStrip={refreshStrip}
            setMenu={setMenu}
            showError={showError}
            askText={askText}
            confirmAction={confirmAction}
            downloadRel={downloadRel}
            mergeBuilderFromApi={mergeBuilderFromApi}
            logRef={logRef}
            onAiEditTile={openAiEditBuilder}
            onRequestAddAngles={openDatasetBuilderAddAngles}
            onRequestBatchGenerate={(tileId) => void openDatasetBatchGenerate(tileId)}
            onOpenPreview={(paths, index, title) => setLightbox({ paths, index, title })}
            builderPoseStripIds={builderPoseStripIds}
            builderExprStripIds={builderExprStripIds}
            setBuilderPoseStripIds={setBuilderPoseStripIds}
            setBuilderExprStripIds={setBuilderExprStripIds}
            onSaveDatasetFolder={saveDatasetFolder}
            onOpenSavedDataset={openSavedDataset}
            onBatchRemoveBackground={() => void batchRemoveBackground(Array.from(selectedBuilder))}
            onBatchAddNoise={() => void batchAddNoise(Array.from(selectedBuilder))}
            onBatchRestoreBackground={() => batchRestoreBackground(Array.from(selectedBuilder))}
            onBatchRemoveNoise={() => batchRemoveNoise(Array.from(selectedBuilder))}
            onBatchGenerate={() => void openDatasetBatchGenerate()}
            beginRemoveBackgroundModal={beginRemoveBackgroundModal}
            endRemoveBackgroundModal={endRemoveBackgroundModal}
            failRmbgJob={failRmbgJob}
            onRemoveBackgroundRequest={openRemoveBgForBuilderTile}
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
            onRemoveBackgroundRequest={openRemoveBgForSavedTile}
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

      <BatchGenerateModal
        open={datasetBatchGenOpen}
        title="Batch Generate: angles / expression / pose for the selected tiles."
        angleGroups={datasetAngleGroups}
        poseCatalog={datasetPoseCatalog}
        exprCatalog={datasetExprCatalog}
        onCancel={() => setDatasetBatchGenOpen(false)}
        onConfirm={(s) => void confirmDatasetBatchGenerate(s)}
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

      <RemoveBgImageModal
        open={removeBgImageOpen}
        busy={busy}
        onCancel={() => {
          setRemoveBgImageOpen(false);
          removeBgPendingRef.current = null;
        }}
        onRun={(options) => void runRemoveBgImage(options)}
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
  onRemoveBackgroundRequest?: (tileId: string, sourceRel: string) => void;
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
    onRemoveBackgroundRequest,
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
                        label: "Remove Background…",
                        onSelect: () => onRemoveBackgroundRequest?.(e.tileId, rel),
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

