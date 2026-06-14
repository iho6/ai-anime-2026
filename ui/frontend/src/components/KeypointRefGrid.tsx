"use client";

import React, { useCallback, useMemo } from "react";
import {
  apiReferenceKeypointsReorderFolder,
  apiReferenceKeypointsReorderRoot,
  assetUrlFromRelPath,
  type KeypointVideoReference,
  type KeypointsLayout,
  type PoseReference,
} from "../lib/api";
import { SortableGrid, SortableItem } from "./dnd/SortableGrid";
import { reorderInsertBeforeOrAfter } from "./dnd/reorder";
import { KeypointFolderTile, KeypointRefTile, KeypointVideoTile } from "./KeypointRefTile";

const FOLDER_PREFIX = "folder:";
const VIDEO_PREFIX = "video:";

export function parseFolderToken(token: string): string | null {
  const s = String(token).trim();
  if (s.startsWith(FOLDER_PREFIX)) return s.slice(FOLDER_PREFIX.length);
  return null;
}

export function folderToken(folderId: string): string {
  return `${FOLDER_PREFIX}${folderId}`;
}

export function parseVideoToken(token: string): string | null {
  const s = String(token).trim();
  if (s.startsWith(VIDEO_PREFIX)) return s.slice(VIDEO_PREFIX.length);
  return null;
}

export function KeypointRefGrid(props: {
  tile?: number;
  busy: boolean;
  layout: KeypointsLayout;
  onLayoutChange: (layout: KeypointsLayout) => void;
  selectedIds: Set<string>;
  onSelectedIdsChange: (next: Set<string>) => void;
  anchorId: string | null;
  onAnchorIdChange: (id: string | null) => void;
  viewFolderId: string | null;
  onViewFolderIdChange: (id: string | null) => void;
  onContextMenu: (e: React.MouseEvent, item: PoseReference) => void;
  onKeypointPreview: (item: PoseReference) => void;
  onOpenVideo: (item: KeypointVideoReference) => void;
  onVideoContextMenu?: (e: React.MouseEvent, item: KeypointVideoReference) => void;
  onFolderContextMenu?: (
    e: React.MouseEvent,
    folderId: string,
    folderName: string
  ) => void;
  onFolderNameClick?: (folderId: string, folderName: string) => void;
}) {
  const {
    tile = 80,
    busy,
    layout,
    onLayoutChange,
    selectedIds,
    onSelectedIdsChange,
    anchorId,
    onAnchorIdChange,
    viewFolderId,
    onViewFolderIdChange,
    onContextMenu,
    onKeypointPreview,
    onOpenVideo,
    onVideoContextMenu,
    onFolderContextMenu,
    onFolderNameClick,
  } = props;

  const itemById = useMemo(
    () => new Map(layout.items.map((x) => [x.id, x])),
    [layout.items]
  );
  const videoById = useMemo(
    () => new Map((layout.videoItems ?? []).map((x) => [x.id, x])),
    [layout.videoItems]
  );
  const folderById = useMemo(
    () => new Map(layout.folders.map((f) => [f.id, f])),
    [layout.folders]
  );

  const viewFolder = viewFolderId ? folderById.get(viewFolderId) : null;
  const gridIds = viewFolderId
    ? [...(layout.folderOrder[viewFolderId] ?? [])]
    : [...layout.rootOrder];

  const keypointOrderInView = useMemo(
    () => gridIds.filter((id) => !parseFolderToken(id) && itemById.has(id)),
    [gridIds, itemById]
  );

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
        onAnchorIdChange(itemId);
        return;
      }
      const anchor = anchorId;
      if (!anchor || !keypointOrderInView.includes(itemId) || !keypointOrderInView.includes(anchor)) {
        const n = new Set(selectedIds);
        if (targetChecked) n.add(itemId);
        else n.delete(itemId);
        onSelectedIdsChange(n);
        onAnchorIdChange(itemId);
        return;
      }
      const a = keypointOrderInView.indexOf(anchor);
      const b = keypointOrderInView.indexOf(itemId);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const range = keypointOrderInView.slice(lo, hi + 1);
      const n = new Set(selectedIds);
      for (const k of range) {
        if (targetChecked) n.add(k);
        else n.delete(k);
      }
      onSelectedIdsChange(n);
    },
    [
      anchorId,
      keypointOrderInView,
      onAnchorIdChange,
      onSelectedIdsChange,
      selectedIds,
    ]
  );

  const persistRootOrder = useCallback(
    (next: string[]) => {
      onLayoutChange({ ...layout, rootOrder: next });
      void apiReferenceKeypointsReorderRoot(next).catch(() => {});
    },
    [layout, onLayoutChange]
  );

  const persistFolderOrder = useCallback(
    (folderId: string, next: string[]) => {
      onLayoutChange({
        ...layout,
        folderOrder: { ...layout.folderOrder, [folderId]: next },
      });
      void apiReferenceKeypointsReorderFolder(folderId, next).catch(() => {});
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

  if (
    layout.items.length === 0 &&
    (layout.videoItems ?? []).length === 0 &&
    layout.folders.length === 0
  ) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "24px 0",
          opacity: 0.5,
          fontSize: 14,
        }}
      >
        No Saved Poses
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
            onClick={() => onViewFolderIdChange(null)}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "4px 10px",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            Back
          </button>
          <button
            type="button"
            disabled={busy || !onFolderNameClick}
            onClick={() => onFolderNameClick?.(viewFolder.id, viewFolder.name)}
            style={{
              fontWeight: 400,
              border: "none",
              background: "transparent",
              color: "#eee",
              padding: 0,
              cursor: busy || !onFolderNameClick ? "default" : "pointer",
              textDecoration: onFolderNameClick ? "underline" : "none",
            }}
            title={onFolderNameClick ? "Rename folder" : undefined}
          >
            {viewFolder.name}
          </button>
        </div>
      ) : null}

      <SortableGrid
        ids={gridIds}
        disabled={busy}
        style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
        renderItem={(id) => {
          const vid = parseVideoToken(id);
          if (vid) {
            const video = videoById.get(vid);
            if (!video) return null;
            const count = (video.frameSequence?.strip ?? []).filter(
              (s) => s.kind === "image"
            ).length;
            return (
              <SortableItem id={id} style={{ width: tile }}>
                <div
                  onContextMenu={
                    onVideoContextMenu
                      ? (e) => onVideoContextMenu(e, video)
                      : undefined
                  }
                >
                  <KeypointVideoTile
                    tile={tile}
                    count={count}
                    checked={selectedIds.has(id)}
                    disabled={busy}
                    onToggle={(on, e) => onCheckboxChange(id, on, e)}
                    onOpen={() => onOpenVideo(video)}
                  />
                </div>
              </SortableItem>
            );
          }
          const fid = parseFolderToken(id);
          if (fid) {
            const folder = folderById.get(fid);
            if (!folder) return null;
            const count = (layout.folderOrder[fid] ?? []).length;
            return (
              <SortableItem id={id} style={{ width: tile }}>
                <div
                  onContextMenu={
                    onFolderContextMenu
                      ? (e) => onFolderContextMenu(e, fid, folder.name)
                      : undefined
                  }
                >
                  <KeypointFolderTile
                    tile={tile}
                    name={folder.name}
                    count={count}
                    disabled={busy}
                    onOpen={() => onViewFolderIdChange(fid)}
                  />
                </div>
              </SortableItem>
            );
          }
          const it = itemById.get(id);
          if (!it) return null;
          return (
            <SortableItem id={id} style={{ width: tile }}>
              <KeypointRefTile
                tile={tile}
                src={assetUrlFromRelPath(it.keypointRelPath)}
                checked={selectedIds.has(id)}
                disabled={busy}
                onToggle={(on, e) => onCheckboxChange(id, on, e)}
                onPrimary={() => onKeypointPreview(it)}
                onContextMenu={(e) => onContextMenu(e, it)}
              />
            </SortableItem>
          );
        }}
        overlay={(id) => {
          const vid = parseVideoToken(id);
          if (vid) {
            const video = videoById.get(vid);
            if (!video) return null;
            const count = (video.frameSequence?.strip ?? []).filter(
              (s) => s.kind === "image"
            ).length;
            return (
              <div style={{ width: tile, cursor: "grabbing" }}>
                <KeypointVideoTile
                  tile={tile}
                  count={count}
                  checked={false}
                  disabled
                  onToggle={() => {}}
                  onOpen={() => {}}
                />
              </div>
            );
          }
          const fid = parseFolderToken(id);
          if (fid) {
            const folder = folderById.get(fid);
            if (!folder) return null;
            return (
              <div style={{ width: tile, cursor: "grabbing" }}>
                <KeypointFolderTile
                  tile={tile}
                  name={folder.name}
                  count={(layout.folderOrder[fid] ?? []).length}
                  disabled
                  onOpen={() => {}}
                />
              </div>
            );
          }
          const it = itemById.get(id);
          if (!it) return null;
          return (
            <div style={{ width: tile, cursor: "grabbing" }}>
              <KeypointRefTile
                tile={tile}
                src={assetUrlFromRelPath(it.keypointRelPath)}
                checked={false}
                disabled
                onToggle={() => {}}
                onPrimary={() => {}}
                onContextMenu={() => {}}
              />
            </div>
          );
        }}
        onDragEnd={onDragEnd}
      />
    </div>
  );
}
