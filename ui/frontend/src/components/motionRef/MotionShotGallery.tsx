"use client";

import React, { useCallback, useMemo, useState } from "react";
import {
  apiMotionRefShotsReorderFolder,
  apiMotionRefShotsReorderRoot,
  assetUrlFromRelPath,
  type MotionRefShot,
  type MotionShotsLayout,
} from "../../lib/api";
import { DesktopContextMenu, type ContextMenuItem } from "../DesktopContextMenu";
import { SortableGrid, SortableItem } from "../dnd/SortableGrid";
import { reorderInsertBeforeOrAfter } from "../dnd/reorder";
import { parseFolderToken } from "../KeypointRefGrid";
import { KeypointFolderTile, KeypointRefTile } from "../KeypointRefTile";
import {
  collectFolderLeafIds,
  folderSelectionState,
  isShotGridLeaf,
  toggleFolderSelection,
} from "../../lib/folderSelection";
import { apiExportFramesVideo, runVideoExportJob, sanitizeDownloadBaseName, type VideoExportJob } from "../../lib/downloadVideo";
import { ExportFpsDialog } from "../ExportFpsDialog";
import { useAppError } from "../ErrorProvider";
import { MOTION_REF_ACCENT_BTN_BG } from "./theme";

export function MotionShotGallery(props: {
  busy?: boolean;
  layout: MotionShotsLayout;
  onLayoutChange: (layout: MotionShotsLayout) => void;
  selectedIds: Set<string>;
  onSelectedIdsChange: (next: Set<string>) => void;
  onRestoreShot: (shot: MotionRefShot) => void;
  onAddToPose: (shots: MotionRefShot[]) => void;
  onDeleteShot: (shotId: string) => void;
  onCreateFolder: (parentFolderId: string | null, shotIds: string[]) => void;
  onRenameFolder: (folderId: string, currentName: string) => void;
  onDeleteFolder: (folderId: string) => void;
  jobModal?: VideoExportJob;
}) {
  const {
    busy = false,
    layout,
    onLayoutChange,
    selectedIds,
    onSelectedIdsChange,
    onRestoreShot,
    onAddToPose,
    onDeleteShot,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    jobModal,
  } = props;

  const { showError } = useAppError();
  const tile = 88;
  const [viewFolderId, setViewFolderId] = useState<string | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [videoExportBusy, setVideoExportBusy] = useState(false);
  const [fpsExportPending, setFpsExportPending] = useState<{
    relPaths: string[];
    filenameBase: string;
  } | null>(null);
  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    items: ContextMenuItem[];
  }>({ open: false, x: 0, y: 0, items: [] });

  const itemById = useMemo(
    () => new Map(layout.items.map((x) => [x.id, x])),
    [layout.items]
  );
  const folderById = useMemo(
    () => new Map(layout.folders.map((f) => [f.id, f])),
    [layout.folders]
  );

  const viewFolder = viewFolderId ? folderById.get(viewFolderId) : null;
  const gridIds = viewFolderId
    ? [...(layout.folderOrder[viewFolderId] ?? [])]
    : [...layout.rootOrder];

  const shotOrderInView = useMemo(
    () => gridIds.filter((id) => !parseFolderToken(id) && itemById.has(id)),
    [gridIds, itemById]
  );

  const shotIdSet = useMemo(() => new Set(layout.items.map((x) => x.id)), [layout.items]);
  const isLeaf = useCallback(
    (token: string) => isShotGridLeaf(token, shotIdSet),
    [shotIdSet]
  );

  const onFolderCheckboxChange = useCallback(
    (folderId: string, targetChecked: boolean) => {
      onSelectedIdsChange(
        toggleFolderSelection(folderId, layout, selectedIds, targetChecked, isLeaf)
      );
    },
    [layout, onSelectedIdsChange, selectedIds, isLeaf]
  );

  const selectedShots = useMemo(
    () => layout.items.filter((s) => selectedIds.has(s.id)),
    [layout.items, selectedIds]
  );

  const addableShots = selectedShots.filter((s) => !s.keypointId);

  const onCheckboxChange = useCallback(
    (itemId: string, targetChecked: boolean, ev: React.ChangeEvent<HTMLInputElement>) => {
      const isShift = (ev.nativeEvent as MouseEvent).shiftKey;
      if (isShift && !targetChecked) {
        onSelectedIdsChange(new Set());
        return;
      }
      if (!isShift) {
        const n = new Set(selectedIds);
        if (targetChecked) n.add(itemId);
        else n.delete(itemId);
        onSelectedIdsChange(n);
        setAnchorId(itemId);
        return;
      }
      const anchor = anchorId;
      if (!anchor || !shotOrderInView.includes(itemId) || !shotOrderInView.includes(anchor)) {
        const n = new Set(selectedIds);
        if (targetChecked) n.add(itemId);
        else n.delete(itemId);
        onSelectedIdsChange(n);
        setAnchorId(itemId);
        return;
      }
      const a = shotOrderInView.indexOf(anchor);
      const b = shotOrderInView.indexOf(itemId);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const range = shotOrderInView.slice(lo, hi + 1);
      const n = new Set(selectedIds);
      for (const k of range) {
        if (targetChecked) n.add(k);
        else n.delete(k);
      }
      onSelectedIdsChange(n);
    },
    [anchorId, onSelectedIdsChange, selectedIds, shotOrderInView]
  );

  const persistRootOrder = useCallback(
    (next: string[]) => {
      onLayoutChange({ ...layout, rootOrder: next });
      void apiMotionRefShotsReorderRoot(next).catch(() => {});
    },
    [layout, onLayoutChange]
  );

  const persistFolderOrder = useCallback(
    (folderId: string, next: string[]) => {
      onLayoutChange({
        ...layout,
        folderOrder: { ...layout.folderOrder, [folderId]: next },
      });
      void apiMotionRefShotsReorderFolder(folderId, next).catch(() => {});
    },
    [layout, onLayoutChange]
  );

  const onDragEnd = useCallback(
    (args: { activeId: string; overId: string | null; insertAfter: boolean }) => {
      const { activeId, overId, insertAfter } = args;
      const containerId = viewFolderId ?? "root";
      const r = reorderInsertBeforeOrAfter({
        activeId,
        overId,
        insertAfter,
        sourceContainerId: containerId,
        targetContainerId: containerId,
        containers: { [containerId]: gridIds },
        selectedIds: new Set(),
      });
      const next = r.containers[containerId] ?? [];
      if (viewFolderId) persistFolderOrder(viewFolderId, next);
      else persistRootOrder(next);
    },
    [gridIds, persistFolderOrder, persistRootOrder, viewFolderId]
  );

  const collectFolderShotRelPaths = useCallback(
    (folderId: string): string[] => {
      const order = layout.folderOrder[folderId] ?? [];
      const relPaths: string[] = [];
      for (const id of order) {
        const shot = itemById.get(id);
        const rel = (shot?.relPath ?? "").trim();
        if (rel) relPaths.push(rel);
      }
      return relPaths;
    },
    [layout.folderOrder, itemById]
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
    (relPaths: string[], filenameBase: string) => {
      if (!relPaths.length) {
        showError({ message: "No frames to export." });
        return;
      }
      setFpsExportPending({ relPaths, filenameBase });
    },
    [showError]
  );

  const openShotMenu = useCallback(
    (e: React.MouseEvent, shot: MotionRefShot) => {
      e.preventDefault();
      const visibleShotIdSet = new Set(shotOrderInView);
      const groupIds = [...selectedIds].filter((id) => visibleShotIdSet.has(id));
      const groupRelPaths =
        groupIds.length >= 2
          ? groupIds
              .map((id) => itemById.get(id)?.relPath?.trim())
              .filter((r): r is string => Boolean(r))
          : [];
      const items: ContextMenuItem[] = [
        {
          key: "add",
          label: "Add to Pose",
          disabled: busy || Boolean(shot.keypointId),
          onSelect: () => onAddToPose([shot]),
        },
        {
          key: "delete",
          label: "Delete",
          onSelect: () => onDeleteShot(shot.id),
        },
      ];
      if (groupIds.length >= 1) {
        items.splice(1, 0, {
          key: "group",
          label: "Group into folder",
          onSelect: () => onCreateFolder(viewFolderId, groupIds),
        });
      }
      if (groupRelPaths.length >= 2) {
        items.splice(1, 0, {
          key: "downloadVideo",
          label: videoExportBusy ? "Exporting…" : "Download as Video",
          disabled: videoExportBusy,
          onSelect: () => requestFramesVideoExport(groupRelPaths, "motion_shots"),
        });
      }
      setMenu({ open: true, x: e.clientX, y: e.clientY, items });
    },
    [
      busy,
      onAddToPose,
      onCreateFolder,
      onDeleteShot,
      selectedIds,
      shotOrderInView,
      viewFolderId,
      itemById,
      requestFramesVideoExport,
      videoExportBusy,
    ]
  );

  const openFolderMenu = useCallback(
    (e: React.MouseEvent, folderId: string, folderName: string) => {
      e.preventDefault();
      const order = layout.folderOrder[folderId] ?? [];
      const folderShots = order
        .map((id) => layout.items.find((s) => s.id === id))
        .filter((s): s is MotionRefShot => Boolean(s));
      const addable = folderShots.filter((s) => !s.keypointId);
      const exportRelPaths = collectFolderShotRelPaths(folderId);
      const items: ContextMenuItem[] = [
        {
          key: "downloadVideo",
          label: videoExportBusy ? "Exporting…" : "Download as Video",
          disabled: videoExportBusy || exportRelPaths.length === 0,
          onSelect: () =>
            requestFramesVideoExport(
              exportRelPaths,
              sanitizeDownloadBaseName(folderName) || "motion_folder"
            ),
        },
        {
          key: "add",
          label: "Add to Pose",
          disabled: busy || addable.length === 0,
          onSelect: () => onAddToPose(addable),
        },
        {
          key: "rename",
          label: "Rename",
          onSelect: () => onRenameFolder(folderId, folderName),
        },
        {
          key: "ungroup",
          label: "Ungroup",
          onSelect: () => onDeleteFolder(folderId),
        },
      ];
      setMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        items,
      });
    },
    [busy, layout.folderOrder, layout.items, onAddToPose, onDeleteFolder, onRenameFolder, collectFolderShotRelPaths, requestFramesVideoExport, videoExportBusy]
  );

  if (layout.items.length === 0 && layout.folders.length === 0) {
    return (
      <div style={{ color: "#666", fontSize: 12, padding: "10px 0", textAlign: "center" }}>
        No shots saved yet. Load an animation, scrub to a frame, orbit the camera, then click
        &quot;Save Shot&quot;.
      </div>
    );
  }

  return (
    <div>
      {viewFolder ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            fontSize: 13,
          }}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setViewFolderId(null);
              onSelectedIdsChange(new Set());
              setAnchorId(null);
            }}
            style={navBtn}
          >
            Back
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRenameFolder(viewFolder.id, viewFolder.name)}
            style={{
              fontWeight: 400,
              border: "none",
              background: "transparent",
              color: "#eee",
              padding: 0,
              cursor: busy ? "default" : "pointer",
              textDecoration: "underline",
            }}
          >
            {viewFolder.name}
          </button>
        </div>
      ) : null}

      <SortableGrid
        ids={gridIds}
        disabled={busy}
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}
        onDragEnd={onDragEnd}
        renderItem={(id) => {
          const fid = parseFolderToken(id);
          if (fid) {
            const folder = folderById.get(fid);
            if (!folder) return null;
            const leafCount = collectFolderLeafIds(fid, layout, isLeaf).length;
            const folderSel = folderSelectionState(fid, layout, selectedIds, isLeaf);
            return (
              <SortableItem id={id} style={{ width: tile }}>
                <div
                  onContextMenu={(e) => openFolderMenu(e, fid, folder.name)}
                >
                  <KeypointFolderTile
                    tile={tile}
                    name={folder.name}
                    count={leafCount}
                    disabled={busy}
                    checked={folderSel.checked}
                    indeterminate={folderSel.indeterminate}
                    onToggle={(_on, e) => {
                      e.stopPropagation();
                      onFolderCheckboxChange(fid, _on);
                    }}
                    onOpen={() => {
                      setViewFolderId(fid);
                      onSelectedIdsChange(new Set());
                      setAnchorId(null);
                    }}
                  />
                </div>
              </SortableItem>
            );
          }

          const shot = itemById.get(id);
          if (!shot) return null;
          return (
            <SortableItem id={id} style={{ width: tile }}>
              <div style={{ position: "relative" }}>
                <KeypointRefTile
                  tile={tile}
                  src={assetUrlFromRelPath(shot.relPath)}
                  checked={selectedIds.has(shot.id)}
                  disabled={busy}
                  onToggle={(on, e) => onCheckboxChange(shot.id, on, e)}
                  onPrimary={() => onRestoreShot(shot)}
                  onContextMenu={(e) => openShotMenu(e, shot)}
                />
                {shot.keypointId ? (
                  <span
                    style={{
                      position: "absolute",
                      bottom: 2,
                      right: 2,
                      fontSize: 8,
                      padding: "1px 3px",
                      background: "rgba(80,200,120,0.85)",
                      color: "#111",
                      pointerEvents: "none",
                    }}
                    title="Added to pose ref"
                  >
                    Pose
                  </span>
                ) : null}
                <div
                  style={{
                    fontSize: 9,
                    color: "#888",
                    textAlign: "center",
                    marginTop: 2,
                  }}
                >
                  f{shot.frameIndex}
                </div>
              </div>
            </SortableItem>
          );
        }}
      />

      {selectedIds.size > 0 ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#aaa" }}>
            {selectedIds.size} selected
            {addableShots.length < selectedShots.length
              ? ` (${addableShots.length} can add to pose)`
              : ""}
          </span>
          <button
            type="button"
            disabled={busy || addableShots.length === 0}
            onClick={() => onAddToPose(addableShots)}
            style={actionBtn}
          >
            Add to Pose
          </button>
          <button
            type="button"
            onClick={() => onSelectedIdsChange(new Set())}
            style={{ ...actionBtn, color: "#888" }}
          >
            Clear
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "#555", marginBottom: 8 }}>
          Click a shot to restore frame and camera · Checkbox to select · Right-click for options
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          disabled={busy || addableShots.length === 0}
          onClick={() => onAddToPose(addableShots)}
          style={{ ...actionBtn, background: MOTION_REF_ACCENT_BTN_BG }}
        >
          Add to Pose
        </button>
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
        zIndex={10450}
        onCancel={() => setFpsExportPending(null)}
        onConfirm={(fps) => {
          const pending = fpsExportPending;
          setFpsExportPending(null);
          if (!pending) return;
          runFramesVideoExport(pending.relPaths, fps, pending.filenameBase);
        }}
      />
    </div>
  );
}

const navBtn: React.CSSProperties = {
  borderRadius: 0,
  border: "1px solid rgba(255,255,255,0.3)",
  background: "transparent",
  color: "#eee",
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
};

const actionBtn: React.CSSProperties = {
  background: "transparent",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.35)",
  padding: "5px 12px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
};
