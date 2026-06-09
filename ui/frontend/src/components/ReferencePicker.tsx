"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  apiReferenceKeypointDelete,
  apiReferenceKeypointFolderCreate,
  apiReferenceKeypointVideoDelete,
  apiReferenceKeypointVideoUpdateStrip,
  apiReferenceKeypointsLayout,
  assetDownloadUrlFromRelPath,
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
import { KeypointRefGrid } from "./KeypointRefGrid";
import { KeypointVideoSequenceModal } from "./KeypointVideoSequenceModal";
import { SquareButton } from "./SquareButton";

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
}) {
  const { busy, onCancel, onUseSelected, onPickNew, onGenerateBase, onOpenMotionRef } = props;
  const { confirmAction, askText } = useAppError();

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

  const openKeypointMenu = useCallback(
    (e: React.MouseEvent, item: PoseReference) => {
      e.preventDefault();
      setMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        items: [
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
        ],
      });
    },
    [confirmAction, loadLayout]
  );

  const openVideoMenu = useCallback(
    (e: React.MouseEvent, item: KeypointVideoReference) => {
      e.preventDefault();
      setMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        items: [
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
    [confirmAction, loadLayout]
  );

  const handleUseSelected = () => {
    const sel = orderedSelection();
    if (!sel.singles.length && !sel.videos.length) return;
    onUseSelected(sel);
  };

  const handleCreateFolder = useCallback(async () => {
    const ids = [...selectedIds].filter(
      (id) => !id.startsWith("video:") && !id.startsWith("folder:")
    );
    if (!ids.length) return;
    const name = await askText({
      title: "New folder",
      message: "Name for this keypoint folder:",
      defaultValue: "Folder",
      confirmText: "Create",
    });
    if (!name?.trim()) return;
    try {
      await apiReferenceKeypointFolderCreate(name.trim(), ids);
      setSelectedIds(new Set());
      setAnchorId(null);
      await loadLayout();
    } catch {
      /* ignore */
    }
  }, [askText, loadLayout, selectedIds]);

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
            gap: 8,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            disabled={busy || selectedIds.size === 0}
            onClick={handleUseSelected}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "6px 12px",
              cursor: busy || selectedIds.size === 0 ? "not-allowed" : "pointer",
              opacity: busy || selectedIds.size === 0 ? 0.5 : 1,
            }}
          >
            Use Selected
          </button>
          <button
            type="button"
            disabled={busy || selectedIds.size === 0}
            onClick={() => void handleCreateFolder()}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "6px 12px",
              cursor: busy || selectedIds.size === 0 ? "not-allowed" : "pointer",
              opacity: busy || selectedIds.size === 0 ? 0.5 : 1,
            }}
          >
            Folder
          </button>
          {selectedIds.size > 0 ? (
            <span style={{ fontSize: 13, opacity: 0.7 }}>
              {selectedIds.size} selected
            </span>
          ) : null}
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
            onOpenVideo={setVideoModalItem}
            onVideoContextMenu={openVideoMenu}
          />
        </div>

        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
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

      <DesktopContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menu.items}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
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
    </div>
  );
}
