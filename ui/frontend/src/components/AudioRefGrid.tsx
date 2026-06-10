"use client";

import React, { useCallback, useMemo } from "react";
import {
  apiReferenceAudioReorderFolder,
  apiReferenceAudioReorderRoot,
  type AudioLayout,
  type AudioReference,
} from "../lib/api";
import { SortableGrid, SortableItem } from "./dnd/SortableGrid";
import { reorderInsertBeforeOrAfter } from "./dnd/reorder";
import { KeypointFolderTile } from "./KeypointRefTile";

const FOLDER_PREFIX = "folder:";

export function parseAudioFolderToken(token: string): string | null {
  const s = String(token).trim();
  if (s.startsWith(FOLDER_PREFIX)) return s.slice(FOLDER_PREFIX.length);
  return null;
}

function AudioRefTile(props: {
  tile: number;
  item: AudioReference;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  onPrimary: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { tile, item, checked, disabled, onToggle, onPrimary, onContextMenu } = props;
  const label = item.label || item.tags || item.mode || "audio";
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
          style={{
            width: tile,
            height: tile,
            padding: 8,
            border: "1px solid rgba(0,0,0,0.5)",
            background: "rgba(40,60,90,0.5)",
            color: "#eee",
            cursor: disabled ? "not-allowed" : "pointer",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            fontSize: 11,
            lineHeight: 1.2,
            textAlign: "center",
            wordBreak: "break-word",
          }}
          title={label}
        >
          <span style={{ fontSize: 20 }}>♪</span>
          <span>{item.mode === "music" ? "music" : "audio"}</span>
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
      <span
        style={{
          fontSize: 10,
          maxWidth: tile,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          opacity: 0.75,
        }}
      >
        {label}
      </span>
    </div>
  );
}

export function AudioRefGrid(props: {
  tile?: number;
  busy: boolean;
  layout: AudioLayout;
  onLayoutChange: (layout: AudioLayout) => void;
  selectedIds: Set<string>;
  onSelectedIdsChange: (next: Set<string>) => void;
  anchorId: string | null;
  onAnchorIdChange: (id: string | null) => void;
  viewFolderId: string | null;
  onViewFolderIdChange: (id: string | null) => void;
  onContextMenu: (e: React.MouseEvent, item: AudioReference) => void;
  onPreview: (item: AudioReference) => void;
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
    onPreview,
  } = props;

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

  const itemOrderInView = useMemo(
    () => gridIds.filter((id) => !parseAudioFolderToken(id) && itemById.has(id)),
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
      if (!anchor || !itemOrderInView.includes(itemId) || !itemOrderInView.includes(anchor)) {
        const n = new Set(selectedIds);
        if (targetChecked) n.add(itemId);
        else n.delete(itemId);
        onSelectedIdsChange(n);
        onAnchorIdChange(itemId);
        return;
      }
      const a = itemOrderInView.indexOf(anchor);
      const b = itemOrderInView.indexOf(itemId);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const range = itemOrderInView.slice(lo, hi + 1);
      const n = new Set(selectedIds);
      for (const k of range) {
        if (targetChecked) n.add(k);
        else n.delete(k);
      }
      onSelectedIdsChange(n);
    },
    [anchorId, itemOrderInView, onAnchorIdChange, onSelectedIdsChange, selectedIds]
  );

  const persistRootOrder = useCallback(
    (next: string[]) => {
      onLayoutChange({ ...layout, rootOrder: next });
      void apiReferenceAudioReorderRoot(next).catch(() => {});
    },
    [layout, onLayoutChange]
  );

  const persistFolderOrder = useCallback(
    (folderId: string, next: string[]) => {
      onLayoutChange({
        ...layout,
        folderOrder: { ...layout.folderOrder, [folderId]: next },
      });
      void apiReferenceAudioReorderFolder(folderId, next).catch(() => {});
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

  if (layout.items.length === 0 && layout.folders.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "24px 0",
          opacity: 0.5,
          fontSize: 14,
        }}
      >
        No saved audio yet
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
          <span style={{ fontWeight: 400 }}>{viewFolder.name}</span>
        </div>
      ) : null}

      <SortableGrid
        ids={gridIds}
        disabled={busy}
        style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
        renderItem={(id) => {
          const fid = parseAudioFolderToken(id);
          if (fid) {
            const folder = folderById.get(fid);
            if (!folder) return null;
            const count = (layout.folderOrder[fid] ?? []).length;
            return (
              <SortableItem id={id} style={{ width: tile }}>
                <KeypointFolderTile
                  tile={tile}
                  name={folder.name}
                  count={count}
                  disabled={busy}
                  onOpen={() => onViewFolderIdChange(fid)}
                />
              </SortableItem>
            );
          }
          const item = itemById.get(id);
          if (!item) return null;
          return (
            <SortableItem id={id} style={{ width: tile }}>
              <AudioRefTile
                tile={tile}
                item={item}
                checked={selectedIds.has(id)}
                disabled={busy}
                onToggle={(on, e) => onCheckboxChange(id, on, e)}
                onPrimary={() => onPreview(item)}
                onContextMenu={(e) => onContextMenu(e, item)}
              />
            </SortableItem>
          );
        }}
        onDragEnd={onDragEnd}
      />
    </div>
  );
}
