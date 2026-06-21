"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  apiReferenceKeypointCopy,
  apiReferenceKeypointDelete,
  apiReferenceKeypointFolderCreate,
  apiReferenceKeypointFolderDelete,
  apiReferenceKeypointFolderRename,
  apiReferenceKeypointVideoCopy,
  apiReferenceKeypointVideoDelete,
  apiReferenceKeypointVideoUpdateStrip,
  apiReferenceKeypointsLayout,
  assetDownloadUrlFromRelPath,
  assetUrlFromRelPath,
  type FrameSequencePayload,
  type KeypointsLayout,
  type KeypointVideoReference,
  type PoseReference,
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
import { apiExportFramesVideo, runVideoExportJob, sanitizeDownloadBaseName, type VideoExportJob } from "../lib/downloadVideo";
import {
  collectFolderIdsPostOrder,
  collectFolderLeafIds,
  folderContainsFolderId,
  isKeypointGridLeaf,
} from "../lib/folderSelection";

export type ReferencePickerSelection = {
  singles: PoseReference[];
  videos: KeypointVideoReference[];
};

export function ReferencePicker(props: {
  open: boolean;
  charKey: string;
  busy: boolean;
  onCancel: () => void;
  onUseSelected: (sel: ReferencePickerSelection) => void;
  onPickNew: (file: File) => void;
  onGenerateBase: (promptText: string) => void;
  onOpenMotionRef?: () => void;
  jobModal?: VideoExportJob;
}) {
  if (!props.open) return null;
  return (
    <ReferencePickerOpen
      charKey={props.charKey}
      busy={props.busy}
      onCancel={props.onCancel}
      onUseSelected={props.onUseSelected}
      onPickNew={props.onPickNew}
      onGenerateBase={props.onGenerateBase}
      onOpenMotionRef={props.onOpenMotionRef}
      jobModal={props.jobModal}
    />
  );
}

function ReferencePickerOpen(props: {
  charKey: string;
  busy: boolean;
  onCancel: () => void;
  onUseSelected: (sel: ReferencePickerSelection) => void;
  onPickNew: (file: File) => void;
  onGenerateBase: (promptText: string) => void;
  onOpenMotionRef?: () => void;
  jobModal?: VideoExportJob;
}) {
  const { busy, onCancel, onUseSelected, onPickNew, onGenerateBase, onOpenMotionRef, jobModal } = props;
  const { confirmAction, askText, showError } = useAppError();

  const [layout, setLayout] = useState<KeypointsLayout>({
    folders: [],
    rootOrder: [],
    folderOrder: {},
    items: [],
    videoItems: [],
  });
  const [videoModalItem, setVideoModalItem] = useState<KeypointVideoReference | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [viewFolderId, setViewFolderId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [genPrompt, setGenPrompt] = useState("");
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
  const [videoExportBusy, setVideoExportBusy] = useState(false);
  const [fpsExportPending, setFpsExportPending] = useState<{
    relPaths: string[];
    filenameBase: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canGenerate = !busy && genPrompt.trim().length > 0;

  const loadLayout = useCallback(async () => {
    try {
      setLayout(await apiReferenceKeypointsLayout());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadLayout();
  }, [loadLayout]);

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
    const order = viewFolderId
      ? layout.folderOrder[viewFolderId] ?? []
      : layout.rootOrder;
    const singles: PoseReference[] = [];
    const videos: KeypointVideoReference[] = [];
    for (const tok of order) {
      if (!selectedIds.has(tok)) continue;
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
    return { singles, videos };
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
    (item: PoseReference) => {
      const itemsInView = gridIdsInView
        .filter((id) => !parseFolderToken(id) && !id.startsWith("video:"))
        .map((id) => itemById.get(id))
        .filter((x): x is PoseReference => Boolean(x));
      const idx = itemsInView.findIndex((x) => x.id === item.id);
      if (idx < 0) return;
      setLightbox({
        paths: itemsInView.map((x) => assetUrlFromRelPath(x.keypointRelPath)),
        index: idx,
        title: "Keypoint preview",
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
    if (!sel.singles.length && !sel.videos.length) return;
    onUseSelected(sel);
  };

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
      <div
        style={{
          width: 600,
          maxWidth: "100%",
          maxHeight: "88vh",
          overflow: "hidden",
          background: "#111",
          color: "#eee",
          border: "1px solid rgba(255,255,255,0.2)",
          padding: 14,
          display: "flex",
          flexDirection: "column",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 400, marginBottom: 10 }}>
          Add Reference Image
        </div>

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
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            variant="import"
            tone="light"
            size={120}
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
          {onOpenMotionRef && (
            <SquareButton
              disabled={busy}
              onClick={onOpenMotionRef}
              variant="import"
              tone="light"
              size={120}
              style={{ color: "inherit" }}
              title="Open Motion Ref Gen to pose a 3D skeleton and generate motion sequences"
            >
              Motion
              <br />
              Ref Gen
            </SquareButton>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <textarea
            value={genPrompt}
            disabled={busy}
            onChange={(e) => setGenPrompt(e.target.value)}
            placeholder="Describe a base reference image to generate"
            rows={2}
            style={{
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "transparent",
              color: "#eee",
              caretColor: "#eee",
              fontSize: 13,
              padding: 8,
              marginBottom: 8,
            }}
          />
          <button
            type="button"
            disabled={!canGenerate}
            onClick={() => {
              const p = genPrompt.trim();
              if (p) onGenerateBase(p);
            }}
            style={{
              width: "100%",
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "8px 12px",
              cursor: canGenerate ? "pointer" : "not-allowed",
              opacity: canGenerate ? 1 : 0.5,
            }}
            title="Generate a base reference image with AI, then convert it to a keypoint pose"
          >
            AI Generate Base Reference
          </button>
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
          <KeypointRefGrid
            busy={busy}
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
            disabled={busy || selectedIds.size === 0}
            onClick={handleUseSelected}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "6px 16px",
              cursor: busy || selectedIds.size === 0 ? "not-allowed" : "pointer",
              opacity: busy || selectedIds.size === 0 ? 0.5 : 1,
            }}
          >
            Use Selected
          </button>
        </div>
      </div>

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
        />
      ) : null}
    </div>
  );
}
