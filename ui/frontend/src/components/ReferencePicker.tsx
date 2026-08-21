"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  apiReferenceImageCommit,
  apiReferenceImageDelete,
  apiReferenceImages,
  apiReferenceKeypointCopy,
  apiReferenceKeypointDelete,
  apiReferenceKeypointFolderCreate,
  apiReferenceKeypointFolderDelete,
  apiReferenceKeypointFolderRename,
  apiReferenceKeypointVideoCopy,
  apiReferenceKeypointVideoDelete,
  apiReferenceKeypointVideoUpdateStrip,
  apiReferenceKeypointsLayout,
  apiReferenceVideoCommit,
  apiReferenceVideoDelete,
  apiReferenceVideos,
  assetDownloadUrlFromRelPath,
  assetUrlFromRelPath,
  runReferenceGenerateWsJob,
  runReferenceMakeKeypointVideoWsJob,
  runReferenceMakeKeypointWsJob,
  type FrameSequencePayload,
  type GeneratedReferencePreview,
  type KeypointFolder,
  type KeypointsLayout,
  type KeypointVideoReference,
  type PlacedFigureMeta,
  type PoseReference,
  type ReferenceImageItem,
  type ReferenceMediaKind,
  type ReferenceVideoItem,
} from "../lib/api";
import {
  DesktopContextMenu,
  type ContextMenuItem,
} from "./DesktopContextMenu";
import { useAppError } from "./ErrorProvider";
import { GalleryImageLightbox } from "./GalleryImageLightbox";
import { KeypointRefGrid, parseFolderToken, parseVideoToken } from "./KeypointRefGrid";
import { KeypointVideoSequenceModal } from "./KeypointVideoSequenceModal";
import { SquareButton } from "./SquareButton";
import { ExportFpsDialog } from "./ExportFpsDialog";
import { MotionRefGenModal } from "./MotionRefGenModal";
import { Reference2DGenTab, type RefGalleryItem } from "./Reference2DGenTab";
import { apiExportFramesVideo, runVideoExportJob, sanitizeDownloadBaseName, type VideoExportJob } from "../lib/downloadVideo";
import {
  collectFolderIdsPostOrder,
  collectFolderLeafIds,
  folderContainsFolderId,
  folderSelectionState,
  isKeypointGridLeaf,
} from "../lib/folderSelection";

type RefTab = "keypoint" | "2d" | "3d";

export type ReferencePickerFolderSelection = {
  folder: KeypointFolder;
  keypoints: PoseReference[];
};

export type ReferencePickerSelection = {
  singles: PoseReference[];
  videos: KeypointVideoReference[];
  folders: ReferencePickerFolderSelection[];
};

export function ReferencePicker(props: {
  open: boolean;
  charKey: string;
  busy: boolean;
  onCancel: () => void;
  onUseSelected: (sel: ReferencePickerSelection) => void;
  onPickNew: (file: File) => void;
  refreshToken?: number;
  jobModal?: VideoExportJob;
  /** ``modal`` = full-screen overlay (default). ``side`` = adjacent panel, no dimming overlay. */
  variant?: "modal" | "side";
  onKeypointsMade?: (ref: PoseReference) => void;
  onKeypointVideoMade?: (ref: KeypointVideoReference) => void;
}) {
  if (!props.open) return null;
  return (
    <ReferencePickerOpen
      charKey={props.charKey}
      busy={props.busy}
      onCancel={props.onCancel}
      onUseSelected={props.onUseSelected}
      onPickNew={props.onPickNew}
      refreshToken={props.refreshToken}
      jobModal={props.jobModal}
      variant={props.variant ?? "modal"}
      onKeypointsMade={props.onKeypointsMade}
      onKeypointVideoMade={props.onKeypointVideoMade}
    />
  );
}

function ReferencePickerOpen(props: {
  charKey: string;
  busy: boolean;
  onCancel: () => void;
  onUseSelected: (sel: ReferencePickerSelection) => void;
  onPickNew: (file: File) => void;
  refreshToken?: number;
  jobModal?: VideoExportJob;
  variant: "modal" | "side";
  onKeypointsMade?: (ref: PoseReference) => void;
  onKeypointVideoMade?: (ref: KeypointVideoReference) => void;
}) {
  const {
    busy,
    onCancel,
    onUseSelected,
    onPickNew,
    refreshToken,
    jobModal,
    variant,
    charKey,
    onKeypointsMade,
    onKeypointVideoMade,
  } = props;
  const { confirmAction, askText, showError } = useAppError();

  const [layout, setLayout] = useState<KeypointsLayout>({
    folders: [],
    rootOrder: [],
    folderOrder: {},
    items: [],
    videoItems: [],
  });
  const [loadingLayout, setLoadingLayout] = useState(true);
  const [videoModalItem, setVideoModalItem] = useState<KeypointVideoReference | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [viewFolderId, setViewFolderId] = useState<string | null>(null);
  const [tab, setTab] = useState<RefTab>("keypoint");
  const [refGallery, setRefGallery] = useState<RefGalleryItem[]>([]);
  const [gallerySelectedIds, setGallerySelectedIds] = useState<Set<string>>(new Set());
  const [twoDBusy, setTwoDBusy] = useState(false);
  const [twoDPreview, setTwoDPreview] = useState<GeneratedReferencePreview | null>(null);
  const [dragOver, setDragOver] = useState(false);
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
    noBackdropItems?: ({ squareSrc: string; placedFigure: PlacedFigureMeta } | null)[];
  } | null>(null);
  const [videoExportBusy, setVideoExportBusy] = useState(false);
  const [fpsExportPending, setFpsExportPending] = useState<{
    relPaths: string[];
    filenameBase: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadLayout = useCallback(async () => {
    setLoadingLayout(true);
    try {
      setLayout(await apiReferenceKeypointsLayout());
    } catch {
      /* ignore */
    } finally {
      setLoadingLayout(false);
    }
  }, []);

  const loadGallery = useCallback(async () => {
    try {
      const [images, videos] = await Promise.all([
        apiReferenceImages(),
        apiReferenceVideos(),
      ]);
      const items: RefGalleryItem[] = [
        ...images.map((item) => ({ kind: "image" as const, item })),
        ...videos.map((item) => ({ kind: "video" as const, item })),
      ];
      setRefGallery(items);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadGallery();
  }, [loadGallery, refreshToken]);

  const handleGenerate2D = useCallback(
    async (args: {
      kind: ReferenceMediaKind;
      promptText: string;
      width: number;
      height: number;
      length?: number;
    }): Promise<GeneratedReferencePreview | null> => {
      if (!jobModal) {
        showError({ message: "Job session is not available." });
        return null;
      }
      setTwoDBusy(true);
      await jobModal.begin({
        title: args.kind === "video" ? "Generating reference video…" : "Generating reference image…",
        clearLog: true,
        runningStatus: "Generating…",
      });
      try {
        const done = await runReferenceGenerateWsJob({
          ...args,
          onLogLine: (line) => jobModal.log?.(line),
        });
        if (!done.ok || !done.result) {
          throw new Error(done.error ?? "Generation failed");
        }
        const result = done.result as GeneratedReferencePreview;
        try {
          if (result.kind === "video") {
            await apiReferenceVideoCommit(result.previewRelPath, result.fps);
          } else {
            await apiReferenceImageCommit(result.previewRelPath);
          }
          await loadGallery();
        } catch (commitErr) {
          showError({ message: "Generated, but could not save to gallery.", error: commitErr });
        }
        jobModal.end();
        setTwoDPreview(result);
        return result;
      } catch (e) {
        jobModal.fail(e, "Reference generation failed.");
        return null;
      } finally {
        setTwoDBusy(false);
      }
    },
    [jobModal, loadGallery, showError]
  );

  const handleConvertGalleryToKeypoint = useCallback(async () => {
    if (!jobModal || gallerySelectedIds.size === 0) return;
    const selected = refGallery.filter((g) =>
      gallerySelectedIds.has(`${g.kind}:${g.item.itemId}`)
    );
    if (!selected.length) return;
    setTwoDBusy(true);
    await jobModal.begin({
      title: "Convert to Keypoint",
      clearLog: false,
      runningStatus: `0/${selected.length} complete`,
    });
    try {
      let doneCount = 0;
      for (const g of selected) {
        doneCount += 1;
        jobModal.log?.(`Convert to Keypoint ${doneCount}/${selected.length}…`);
        if (g.kind === "image") {
          const done = await runReferenceMakeKeypointWsJob({
            imageRelPath: g.item.relPath,
            onLogLine: (line) => jobModal.log?.(line),
          });
          if (!done.ok || !done.result) {
            throw new Error(done.error ?? "Keypoint generation failed");
          }
          onKeypointsMade?.({
            id: done.result.item.id,
            referenceRelPath: done.result.item.referenceRelPath,
            keypointRelPath: done.result.item.keypointRelPath,
          });
        } else {
          const done = await runReferenceMakeKeypointVideoWsJob({
            videoRelPath: g.item.relPath,
            fps: g.item.fps,
            onLogLine: (line) => jobModal.log?.(line),
          });
          if (!done.ok || !done.result) {
            throw new Error(done.error ?? "Video keypoint generation failed");
          }
          onKeypointVideoMade?.(done.result.item);
        }
      }
      jobModal.end();
      setGallerySelectedIds(new Set());
      await loadLayout();
      setTab("keypoint");
    } catch (e) {
      jobModal.fail(e, "Convert to Keypoint failed.");
    } finally {
      setTwoDBusy(false);
    }
  }, [
    gallerySelectedIds,
    jobModal,
    loadLayout,
    onKeypointVideoMade,
    onKeypointsMade,
    refGallery,
  ]);

  const handleDeleteGallerySelected = useCallback(async () => {
    const selected = refGallery.filter((g) =>
      gallerySelectedIds.has(`${g.kind}:${g.item.itemId}`)
    );
    for (const g of selected) {
      try {
        if (g.kind === "image") await apiReferenceImageDelete(g.item.itemId);
        else await apiReferenceVideoDelete(g.item.itemId);
      } catch {
        /* ignore */
      }
    }
    setGallerySelectedIds(new Set());
    await loadGallery();
  }, [gallerySelectedIds, loadGallery, refGallery]);

  useEffect(() => {
    void loadLayout();
  }, [loadLayout, refreshToken]);

  const itemById = new Map(layout.items.map((x) => [x.id, x]));
  const videoById = new Map((layout.videoItems ?? []).map((x) => [x.id, x]));

  const visibleStripRelPaths = useCallback(
    (strip: KeypointVideoReference["frameSequence"]["strip"] | undefined): string[] => {
      const out: string[] = [];
      for (const slot of strip ?? []) {
        if (slot.kind !== "image" || slot.hidden) continue;
        const rel = (slot.relPath ?? "").trim();
        if (rel) out.push(rel);
      }
      return out;
    },
    []
  );

  const collectFolderExportRelPaths = useCallback(
    (folderId: string): string[] => {
      const itemIds = new Set(layout.items.map((x) => x.id));
      const videoIds = new Set((layout.videoItems ?? []).map((x) => x.id));
      const isLeaf = (tok: string) => isKeypointGridLeaf(tok, itemIds, videoIds);
      const leaves = collectFolderLeafIds(folderId, layout, isLeaf);
      const relPaths: string[] = [];
      for (const tok of leaves) {
        const vid = parseVideoToken(tok);
        if (vid) {
          const v = videoById.get(vid);
          if (v) relPaths.push(...visibleStripRelPaths(v.frameSequence?.strip));
          continue;
        }
        const it = itemById.get(tok);
        const rel = (it?.keypointRelPath ?? "").trim();
        if (rel) relPaths.push(rel);
      }
      return relPaths;
    },
    [layout, itemById, videoById, visibleStripRelPaths]
  );

  const runFramesVideoExport = useCallback(
    (relPaths: string[], fps: number, filenameBase: string) => {
      if (!relPaths.length) {
        showError({ message: "No frames to export." });
        return;
      }
      void (async () => {
        setVideoExportBusy(true);
        await runVideoExportJob(jobModal, {
          runningStatus: "Encoding video…",
          run: async () => {
            await apiExportFramesVideo({
              relPaths,
              fps,
              filenameBase: sanitizeDownloadBaseName(filenameBase),
            });
          },
          failMessage: "Download as Video failed.",
          onError: (e) => showError({ message: "Download as Video failed.", error: e }),
        });
        setVideoExportBusy(false);
      })();
    },
    [showError, jobModal]
  );

  const requestFramesVideoExport = useCallback(
    (relPaths: string[], filenameBase: string, fps?: number) => {
      if (!relPaths.length) {
        showError({ message: "No frames to export." });
        return;
      }
      if (fps != null && Number.isFinite(fps) && fps >= 1 && fps <= 120) {
        runFramesVideoExport(relPaths, fps, filenameBase);
        return;
      }
      setFpsExportPending({ relPaths, filenameBase });
    },
    [runFramesVideoExport, showError]
  );

  const gridIdsInView = viewFolderId
    ? layout.folderOrder[viewFolderId] ?? []
    : layout.rootOrder;

  const selectedKeypointImageIds = (): string[] =>
    [...selectedIds].filter(
      (id) => !id.startsWith("video:") && !id.startsWith("folder:")
    );

  const canMakeCopy =
    !busy &&
    [...selectedIds].some(
      (id) =>
        id.startsWith("video:") ||
        (!id.startsWith("folder:") && itemById.has(id))
    );

  const orderedSelection = (): ReferencePickerSelection => {
    const itemIds = new Set(layout.items.map((x) => x.id));
    const videoIds = new Set((layout.videoItems ?? []).map((x) => x.id));
    const isLeaf = (tok: string) => isKeypointGridLeaf(tok, itemIds, videoIds);

    const folders: ReferencePickerFolderSelection[] = [];
    const leafIdsInFolders = new Set<string>();
    for (const f of layout.folders) {
      const fid = f.id;
      const folderSel = folderSelectionState(fid, layout, selectedIds, isLeaf);
      if (!folderSel.checked) continue;
      const leaves = collectFolderLeafIds(fid, layout, isLeaf);
      const keypoints: PoseReference[] = [];
      for (const tok of leaves) {
        const it = itemById.get(tok);
        if (it) {
          keypoints.push(it);
          leafIdsInFolders.add(tok);
        }
      }
      if (keypoints.length) folders.push({ folder: f, keypoints });
    }

    const order = viewFolderId
      ? layout.folderOrder[viewFolderId] ?? []
      : layout.rootOrder;
    const singles: PoseReference[] = [];
    const videos: KeypointVideoReference[] = [];
    for (const tok of order) {
      if (!selectedIds.has(tok)) continue;
      if (leafIdsInFolders.has(tok)) continue;
      if (tok.startsWith("video:")) {
        const vid = tok.slice("video:".length);
        const it = videoById.get(vid);
        if (it) videos.push(it);
        continue;
      }
      if (tok.startsWith("folder:")) continue;
      const it = itemById.get(tok);
      if (it) singles.push(it);
    }
    for (const tok of selectedIds) {
      if (leafIdsInFolders.has(tok)) continue;
      if (tok.startsWith("video:")) {
        const vid = tok.slice("video:".length);
        if (!videos.some((x) => x.id === vid)) {
          const it = videoById.get(vid);
          if (it) videos.push(it);
        }
      } else if (!tok.startsWith("folder:") && !singles.some((x) => x.id === tok)) {
        const it = itemById.get(tok);
        if (it) singles.push(it);
      }
    }
    return { singles, videos, folders };
  };

  const handleDrop = useCallback(
    (ev: React.DragEvent) => {
      ev.preventDefault();
      setDragOver(false);
      const file = ev.dataTransfer?.files?.[0];
      if (file) onPickNew(file);
    },
    [onPickNew]
  );

  const handleFileInput = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (file) onPickNew(file);
    },
    [onPickNew]
  );

  const openKeypointLightbox = useCallback(
    (item: PoseReference, noBackdrop?: boolean) => {
      const itemsInView = gridIdsInView
        .filter((id) => !parseFolderToken(id) && !id.startsWith("video:"))
        .map((id) => itemById.get(id))
        .filter((x): x is PoseReference => Boolean(x));
      const idx = itemsInView.findIndex((x) => x.id === item.id);
      if (idx < 0) return;
      const noBackdropItems = noBackdrop
        ? itemsInView.map((x) => {
            const rel = x.placedFigure?.squareKeypointCropRelPath ?? null;
            return rel && x.placedFigure
              ? { squareSrc: assetUrlFromRelPath(rel), placedFigure: x.placedFigure }
              : null;
          })
        : undefined;
      setLightbox({
        paths: itemsInView.map((x) => assetUrlFromRelPath(x.keypointRelPath)),
        index: idx,
        title: "Keypoint preview",
        noBackdropItems,
      });
    },
    [gridIdsInView, itemById]
  );

  const renameFolder = useCallback(
    async (folderId: string, currentName: string) => {
      const name = await askText({
        title: "Rename folder",
        message: "Folder name:",
        defaultValue: currentName,
        confirmText: "Rename",
      });
      if (!name?.trim()) return;
      try {
        await apiReferenceKeypointFolderRename(folderId, name.trim());
        await loadLayout();
      } catch {
        /* ignore */
      }
    },
    [askText, loadLayout]
  );

  const handleCreateFolder = useCallback(
    async (parentFolderId: string | null) => {
      const ids = selectedKeypointImageIds();
      if (!ids.length) return;
      const name = await askText({
        title: "New folder",
        message: "Name for this keypoint folder:",
        defaultValue: "Folder",
        confirmText: "Create",
      });
      if (!name?.trim()) return;
      try {
        await apiReferenceKeypointFolderCreate(
          name.trim(),
          ids,
          parentFolderId
        );
        setSelectedIds(new Set());
        setAnchorId(null);
        await loadLayout();
      } catch {
        /* ignore */
      }
    },
    [askText, loadLayout, selectedIds]
  );

  const handleMakeCopy = useCallback(async () => {
    const tokens = [...selectedIds];
    if (!tokens.length) return;
    try {
      for (const tok of tokens) {
        if (tok.startsWith("video:")) {
          await apiReferenceKeypointVideoCopy(tok.slice("video:".length));
        } else if (!tok.startsWith("folder:") && itemById.has(tok)) {
          await apiReferenceKeypointCopy(tok);
        }
      }
      await loadLayout();
    } catch {
      /* ignore */
    }
  }, [itemById, loadLayout, selectedIds]);

  const openKeypointMenu = useCallback(
    (e: React.MouseEvent, item: PoseReference) => {
      e.preventDefault();
      const groupIds = selectedKeypointImageIds();
      const items: ContextMenuItem[] = [
        {
          key: "download",
          label: "Download",
          onSelect: () => {
            const a = document.createElement("a");
            a.href = assetDownloadUrlFromRelPath(item.keypointRelPath);
            a.download = item.keypointRelPath.split("/").pop() ?? "keypoint.png";
            a.click();
          },
        },
        {
          key: "makeCopy",
          label: "Make Copy",
          onSelect: () =>
            void (async () => {
              try {
                await apiReferenceKeypointCopy(item.id);
                await loadLayout();
              } catch {
                /* ignore */
              }
            })(),
        },
        {
          key: "delete",
          label: "Delete",
          onSelect: () =>
            void (async () => {
              const ok = await confirmAction({
                title: "Delete keypoint pose",
                message: "Delete this keypoint pose pair?",
                confirmText: "Delete",
              });
              if (!ok) return;
              try {
                await apiReferenceKeypointDelete(item.id);
                setSelectedIds((prev) => {
                  const n = new Set(prev);
                  n.delete(item.id);
                  return n;
                });
                await loadLayout();
              } catch {
                /* ignore */
              }
            })(),
        },
      ];
      if (groupIds.length >= 1) {
        items.splice(2, 0, {
          key: "group",
          label: "Group into folder",
          onSelect: () => void handleCreateFolder(viewFolderId),
        });
      }
      setMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        items,
      });
    },
    [
      confirmAction,
      handleCreateFolder,
      loadLayout,
      selectedIds,
      viewFolderId,
    ]
  );

  const openFolderMenu = useCallback(
    (e: React.MouseEvent, folderId: string, folderName: string) => {
      e.preventDefault();
      const itemIds = new Set(layout.items.map((x) => x.id));
      const videoIds = new Set((layout.videoItems ?? []).map((x) => x.id));
      const isLeaf = (tok: string) => isKeypointGridLeaf(tok, itemIds, videoIds);
      const leaves = collectFolderLeafIds(folderId, layout, isLeaf);
      const exportRelPaths = collectFolderExportRelPaths(folderId);
      setMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            key: "downloadVideo",
            label: videoExportBusy ? "Exporting…" : "Download as Video",
            disabled: videoExportBusy || exportRelPaths.length === 0,
            onSelect: () =>
              requestFramesVideoExport(
                exportRelPaths,
                sanitizeDownloadBaseName(folderName) || "folder"
              ),
          },
          {
            key: "rename",
            label: "Rename",
            onSelect: () => void renameFolder(folderId, folderName),
          },
          {
            key: "ungroup",
            label: "Ungroup",
            onSelect: () =>
              void (async () => {
                const ok = await confirmAction({
                  title: "Ungroup folder",
                  message:
                    "Dissolve this folder and move its contents to the parent level?",
                  confirmText: "Ungroup",
                });
                if (!ok) return;
                try {
                  await apiReferenceKeypointFolderDelete(folderId);
                  if (viewFolderId === folderId) {
                    setViewFolderId(null);
                  }
                  await loadLayout();
                } catch {
                  /* ignore */
                }
              })(),
          },
          {
            key: "delete",
            label: "Delete",
            onSelect: () =>
              void (async () => {
                const n = leaves.length;
                const ok = await confirmAction({
                  title: "Delete folder",
                  message: `Delete folder "${folderName}" and all ${n} item${n === 1 ? "" : "s"} inside? This cannot be undone.`,
                  confirmText: "Delete",
                });
                if (!ok) return;
                try {
                  for (const tok of leaves) {
                    if (tok.startsWith("video:")) {
                      await apiReferenceKeypointVideoDelete(tok.slice("video:".length));
                    } else {
                      await apiReferenceKeypointDelete(tok);
                    }
                  }
                  for (const fid of collectFolderIdsPostOrder(folderId, layout)) {
                    await apiReferenceKeypointFolderDelete(fid);
                  }
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    for (const tok of leaves) next.delete(tok);
                    return next;
                  });
                  if (folderContainsFolderId(folderId, viewFolderId, layout)) {
                    setViewFolderId(null);
                  }
                  await loadLayout();
                } catch {
                  /* ignore */
                }
              })(),
          },
        ],
      });
    },
    [confirmAction, layout, loadLayout, renameFolder, viewFolderId, collectFolderExportRelPaths, requestFramesVideoExport, videoExportBusy]
  );

  const openVideoMenu = useCallback(
    (e: React.MouseEvent, item: KeypointVideoReference) => {
      e.preventDefault();
      const exportRelPaths = visibleStripRelPaths(item.frameSequence?.strip);
      setMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            key: "downloadVideo",
            label: videoExportBusy ? "Exporting…" : "Download as Video",
            disabled: videoExportBusy || exportRelPaths.length === 0,
            onSelect: () =>
              requestFramesVideoExport(
                exportRelPaths,
                sanitizeDownloadBaseName(item.id) || "video",
                item.fps
              ),
          },
          {
            key: "makeCopy",
            label: "Make Copy",
            onSelect: () =>
              void (async () => {
                try {
                  await apiReferenceKeypointVideoCopy(item.id);
                  await loadLayout();
                } catch {
                  /* ignore */
                }
              })(),
          },
          {
            key: "delete",
            label: "Delete",
            onSelect: () =>
              void (async () => {
                const ok = await confirmAction({
                  title: "Delete video reference",
                  message: "Delete this video keypoint sequence?",
                  confirmText: "Delete",
                });
                if (!ok) return;
                try {
                  await apiReferenceKeypointVideoDelete(item.id);
                  setSelectedIds((prev) => {
                    const n = new Set(prev);
                    n.delete(`video:${item.id}`);
                    return n;
                  });
                  await loadLayout();
                } catch {
                  /* ignore */
                }
              })(),
          },
        ],
      });
    },
    [confirmAction, loadLayout, visibleStripRelPaths, requestFramesVideoExport, videoExportBusy]
  );

  const handleUseSelected = () => {
    const sel = orderedSelection();
    if (!sel.singles.length && !sel.videos.length && !sel.folders.length) return;
    onUseSelected(sel);
  };

  const combinedBusy = busy || twoDBusy;

  const tabBtn = (id: RefTab): React.CSSProperties => {
    const selected = tab === id;
    return {
      flex: "0 0 auto",
      border: "1px solid rgba(255,255,255,0.25)",
      borderRadius: 0,
      background: selected ? "rgba(255, 255, 255, 0.2)" : "transparent",
      boxShadow: selected ? "inset 0 0 0 1px rgba(255, 255, 255, 0.35)" : "none",
      color: selected ? "#eee" : "#aaa",
      padding: "6px 12px",
      cursor: "pointer",
      font: "inherit",
      fontSize: 12,
      lineHeight: 1.2,
      whiteSpace: "nowrap",
    };
  };

  const panel = (
      <div
        style={
          variant === "side"
            ? {
                width: tab === "3d" ? 900 : 720,
                maxWidth: tab === "3d" ? "min(900px, 58vw)" : "min(720px, 52vw)",
                height: "100%",
                overflow: "hidden",
                background: "#111",
                color: "#eee",
                border: "1px solid rgba(255,255,255,0.25)",
                borderLeft: "1px solid rgba(255,255,255,0.35)",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                boxSizing: "border-box",
              }
            : {
                width: tab === "3d" ? 900 : 720,
                maxWidth: "100%",
                maxHeight: "88vh",
                height: "min(92vh, 880px)",
                overflow: "hidden",
                background: "#111",
                color: "#eee",
                border: "1px solid rgba(255,255,255,0.2)",
                padding: 0,
                display: "flex",
                flexDirection: "column",
              }
        }
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          role="tablist"
          aria-label="Reference modes"
          style={{
            display: "flex",
            gap: 0,
            flexShrink: 0,
            width: "100%",
            justifyContent: "center",
            padding: "0 14px",
            boxSizing: "border-box",
          }}
        >
          <button type="button" role="tab" aria-selected={tab === "keypoint"} style={tabBtn("keypoint")} onClick={() => setTab("keypoint")}>
            Keypoint
          </button>
          <button type="button" role="tab" aria-selected={tab === "2d"} style={{ ...tabBtn("2d"), borderLeft: "none" }} onClick={() => setTab("2d")}>
            2D Ref Gen
          </button>
          <button type="button" role="tab" aria-selected={tab === "3d"} style={{ ...tabBtn("3d"), borderLeft: "none" }} onClick={() => setTab("3d")}>
            3D Ref Gen
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            padding: 14,
            boxSizing: "border-box",
          }}
        >
        {tab === "keypoint" ? (
          <>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <SquareButton
            disabled={combinedBusy}
            onClick={() => inputRef.current?.click()}
            variant="import"
            tone="light"
            size={100}
            dragOver={dragOver}
            style={{ color: "inherit" }}
            title="Drop an image here or click to pick a file"
          >
            Drop image
            <br />
            or click
            <br />
            to pick
          </SquareButton>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,video/*"
            style={{ display: "none" }}
            onChange={handleFileInput}
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          {selectedIds.size > 0 ? (
            <span style={{ fontSize: 13, opacity: 0.7 }}>
              {selectedIds.size} selected
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            disabled={!canMakeCopy}
            onClick={() => void handleMakeCopy()}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "6px 12px",
              cursor: canMakeCopy ? "pointer" : "not-allowed",
              opacity: canMakeCopy ? 1 : 0.5,
            }}
          >
            Make Copy
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflow: "auto",
            minHeight: 0,
          }}
        >
          {loadingLayout ? (
            <div style={{ textAlign: "center", padding: "32px 0", opacity: 0.55, fontSize: 13 }}>
              Loading poses…
            </div>
          ) : (
          <KeypointRefGrid
            busy={combinedBusy}
            layout={layout}
            onLayoutChange={setLayout}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            anchorId={anchorId}
            onAnchorIdChange={setAnchorId}
            viewFolderId={viewFolderId}
            onViewFolderIdChange={setViewFolderId}
            onContextMenu={openKeypointMenu}
            onKeypointPreview={openKeypointLightbox}
            onOpenVideo={setVideoModalItem}
            onVideoContextMenu={openVideoMenu}
            onFolderContextMenu={openFolderMenu}
            onFolderNameClick={renameFolder}
          />
          )}
        </div>

        <div
          style={{
            marginTop: 12,
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "6px 16px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={combinedBusy || selectedIds.size === 0}
            onClick={handleUseSelected}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "6px 16px",
              cursor: combinedBusy || selectedIds.size === 0 ? "not-allowed" : "pointer",
              opacity: combinedBusy || selectedIds.size === 0 ? 0.5 : 1,
            }}
          >
            Use Selected
          </button>
        </div>
          </>
        ) : null}

        {tab === "2d" ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <Reference2DGenTab
              busy={combinedBusy}
              gallery={refGallery}
              selectedIds={gallerySelectedIds}
              onSelectedIdsChange={setGallerySelectedIds}
              preview={twoDPreview}
              onPreviewChange={setTwoDPreview}
              onGenerate={handleGenerate2D}
              onConvertToKeypoint={() => void handleConvertGalleryToKeypoint()}
              onDeleteSelected={() => void handleDeleteGallerySelected()}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button
                type="button"
                onClick={onCancel}
                style={{
                  borderRadius: 0,
                  border: "1px solid rgba(255,255,255,0.3)",
                  background: "transparent",
                  color: "#eee",
                  padding: "6px 16px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {tab === "3d" ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              <MotionRefGenModal
                open
                embedded
                charKey={charKey}
                onClose={onCancel}
                onKeypointsMade={(ref) => {
                  onKeypointsMade?.(ref);
                  void loadLayout();
                }}
                onKeypointVideoMade={(ref) => {
                  onKeypointVideoMade?.(ref);
                  void loadLayout();
                }}
              />
            </div>
          </div>
        ) : null}
        </div>
      </div>
  );

  const overlays = (
    <>
      <DesktopContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menu.items}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />

      <ExportFpsDialog
        open={fpsExportPending != null}
        title="Download as Video"
        onCancel={() => setFpsExportPending(null)}
        onConfirm={(fps) => {
          const pending = fpsExportPending;
          setFpsExportPending(null);
          if (!pending) return;
          runFramesVideoExport(pending.relPaths, fps, pending.filenameBase);
        }}
      />

      <KeypointVideoSequenceModal
        open={!!videoModalItem}
        item={videoModalItem}
        busy={busy}
        onClose={() => setVideoModalItem(null)}
        onSave={async (frameSequence: FrameSequencePayload) => {
          if (!videoModalItem) return;
          try {
            const updated = await apiReferenceKeypointVideoUpdateStrip(
              videoModalItem.id,
              frameSequence
            );
            setVideoModalItem(updated);
            await loadLayout();
          } catch {
            /* ignore */
          }
        }}
      />

      {lightbox ? (
        <GalleryImageLightbox
          key={`${lightbox.paths.join("|")}-${lightbox.index}-${lightbox.title}`}
          paths={lightbox.paths}
          index={lightbox.index}
          title={lightbox.title}
          onClose={() => setLightbox(null)}
          noBackdropItems={lightbox.noBackdropItems}
        />
      ) : null}
    </>
  );

  if (variant === "side") {
    return (
      <>
        {panel}
        {overlays}
      </>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onCancel();
      }}
    >
      {panel}
      {overlays}
    </div>
  );
}
