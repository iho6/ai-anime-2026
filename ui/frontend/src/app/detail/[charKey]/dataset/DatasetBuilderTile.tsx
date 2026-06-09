"use client";

import React from "react";
import {
  apiDatasetPreviewAddNoise,
  assetUrlFromRelPath,
  runDetailWsJob,
} from "../../../../lib/api";
import type { ContextMenuItem, DesktopContextMenuState } from "../../../../components/DesktopContextMenu";
import type { SharedLogStreamHandle } from "../../../../components/SharedLogStream";
import { SortableItemInContainer } from "../../../../components/dnd/SortableMultiGrid";
import type { BuilderEntry } from "./builderTypes";
import { buildBuilderEntriesPreserve, displayRelPath } from "./datasetBuilderStripUtils";

const TILE = 120;

function isLikelyFolderBaseTile(e: BuilderEntry): boolean {
  const rel = displayRelPath(e) || e.sourceRelPath;
  if (!rel) return false;
  const fn = (rel.split("/").pop() ?? "").toLowerCase();
  return (
    fn.startsWith("starting_image") ||
    fn.startsWith("pose_000") ||
    fn.startsWith("expr_000") ||
    fn.startsWith("angle_000")
  );
}

export type DatasetBuilderTileProps = {
  id: string;
  containerId: "builderPose" | "builderExpr";
  entry: BuilderEntry;
  entries: BuilderEntry[];
  busy: boolean;
  charKey: string;
  sectionTitle: string;
  previewPaths: string[];
  /** Index in previewPaths for lightbox; -1 if hidden (excluded from preview). */
  previewStripIndex: number;
  selected: boolean;
  onBuilderCheckboxChange: (
    id: string,
    on: boolean,
    ev: React.ChangeEvent<HTMLInputElement>
  ) => void;
  setMenu: React.Dispatch<React.SetStateAction<DesktopContextMenuState>>;
  downloadRel: (rel: string) => void;
  mergeBuilderFromApi: (p: Map<string, Partial<BuilderEntry>>) => Promise<void>;
  refreshStrip: () => Promise<void>;
  logRef: React.RefObject<SharedLogStreamHandle | null>;
  onError: (input: { title?: string; message: string; error?: unknown; details?: string }) => void;
  onPrompt: (input: {
    title: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<string | null>;
  onAiEditTile: (entry: BuilderEntry) => void;
  /** Base / canonical pose or expression tiles only (starting_image, pose_000, expr_000). */
  onRequestAddAngles?: (ctx: {
    kind: "pose" | "expr";
    folderKey: string;
    /** Gallery-relative path for the tile (base image used as Comfy input when set). */
    inputRelPath?: string;
  }) => void;
  /** Open Batch Generate for the selection (ensuring this tile is included). */
  onRequestBatchGenerate?: (tileId: string) => void;
  onOpenPreview: (paths: string[], index: number, title: string) => void;
  setEntries: React.Dispatch<React.SetStateAction<BuilderEntry[]>>;
  setDirty: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedBuilder: React.Dispatch<React.SetStateAction<Set<string>>>;
  beginRemoveBackgroundModal: () => void;
  endRemoveBackgroundModal: () => void;
  failRmbgJob: (err: unknown) => void;
};

function DatasetBuilderTileInner(props: DatasetBuilderTileProps) {
  const {
    id,
    containerId,
    entry: e,
    entries,
    busy,
    charKey,
    sectionTitle,
    previewPaths,
    previewStripIndex,
    selected,
    onBuilderCheckboxChange,
    setMenu,
    downloadRel,
    mergeBuilderFromApi,
    refreshStrip,
    logRef,
    onError,
    onPrompt,
    onAiEditTile,
    onRequestAddAngles,
    onRequestBatchGenerate,
    onOpenPreview,
    setEntries,
    setDirty,
    setSelectedBuilder,
    beginRemoveBackgroundModal,
    endRemoveBackgroundModal,
    failRmbgJob,
  } = props;

  const rel = displayRelPath(e);

  return (
    <SortableItemInContainer
      id={id}
      containerId={containerId}
      disabled={busy}
      style={{ width: TILE, display: "flex", flexDirection: "column", gap: 4 }}
    >
      <button
        type="button"
        onClick={() => {
          if (!rel || e.builderHidden || previewStripIndex < 0) return;
          onOpenPreview(previewPaths, previewStripIndex, sectionTitle);
        }}
        onContextMenu={(ev) => {
          ev.preventDefault();
          if (!rel) return;
          const items: ContextMenuItem[] = [
            { key: "aiEdit", label: "AI Edit", onSelect: () => onAiEditTile(e) },
            ...(onRequestBatchGenerate
              ? [
                  {
                    key: "batchGen",
                    label: "Batch Generate",
                    onSelect: () => onRequestBatchGenerate(e.tileId),
                  } as ContextMenuItem,
                ]
              : []),
            ...(onRequestAddAngles &&
            (e.sourceKind === "pose" || e.sourceKind === "expr") &&
            isLikelyFolderBaseTile(e)
              ? [
                  {
                    key: "addAngle",
                    label: "New Angle",
                    onSelect: () =>
                      onRequestAddAngles({
                        kind: e.sourceKind === "pose" ? "pose" : "expr",
                        folderKey: e.folderKey,
                        inputRelPath: rel,
                      }),
                  } as ContextMenuItem,
                ]
              : []),
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
                    setEntries((list) =>
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
                    setDirty(true);
                    endRemoveBackgroundModal();
                  } catch (err) {
                    failRmbgJob(err);
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
                    setEntries((list) =>
                      list.map((x) =>
                        x.tileId === e.tileId
                          ? { ...x, beforeNoiseRelPath: rel, previewRelPath }
                          : x
                      )
                    );
                    setDirty(true);
                  })
                  .catch((err) => onError({ message: "Action failed.", error: err }));
              },
            },
            {
              key: "restore",
              label: "Restore background",
              onSelect: () => {
                setEntries((list) =>
                  list.map((x) =>
                    x.tileId === e.tileId
                      ? { ...x, previewRelPath: null, beforeNoiseRelPath: null }
                      : x
                  )
                );
                setDirty(true);
              },
            },
            {
              key: "rmnoise",
              label: "Remove noise",
              onSelect: () => {
                setEntries((list) =>
                  list.map((x) => {
                    if (x.tileId !== e.tileId) return x;
                    const p = x.beforeNoiseRelPath;
                    if (!p) return x;
                    return { ...x, previewRelPath: p, beforeNoiseRelPath: null };
                  })
                );
                setDirty(true);
              },
            },
            { key: "download", label: "Download", onSelect: () => downloadRel(rel) },
            ...(e.builderHidden
              ? [
                  {
                    key: "unhide",
                    label: "Unhide",
                    onSelect: () => {
                      setEntries((list) =>
                        list.map((x) =>
                          x.tileId === e.tileId ? { ...x, builderHidden: false } : x
                        )
                      );
                      setDirty(true);
                    },
                  } as ContextMenuItem,
                ]
              : [
                  {
                    key: "hide",
                    label: "Hide",
                    onSelect: () => {
                      setEntries((list) =>
                        list.map((x) =>
                          x.tileId === e.tileId ? { ...x, builderHidden: true } : x
                        )
                      );
                      setDirty(true);
                      setSelectedBuilder((prev) => {
                        const n = new Set(prev);
                        n.delete(e.tileId);
                        return n;
                      });
                    },
                  } as ContextMenuItem,
                ]),
            {
              key: "delete",
              label: "Delete",
              onSelect: () => {
                setEntries((list) =>
                  list.map((x) => (x.tileId === e.tileId ? { ...x, removed: true } : x))
                );
                setDirty(true);
                setSelectedBuilder((prev) => {
                  const n = new Set(prev);
                  n.delete(e.tileId);
                  return n;
                });
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
          background: "transparent",
          cursor: "pointer",
          overflow: "hidden",
        }}
        className="gallery-cover-btn"
      >
        {rel ? (
          <img
            src={assetUrlFromRelPath(rel)}
            alt=""
            className="gallery-cover-img"
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : null}
        {e.builderHidden ? (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(0,0,0,0.5)",
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        ) : null}
        <label
          style={{ position: "absolute", top: 4, left: 6, zIndex: 2, cursor: "pointer" }}
          onMouseDown={(ev) => ev.stopPropagation()}
          onClick={(ev) => ev.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(ev) => onBuilderCheckboxChange(e.tileId, ev.target.checked, ev)}
            style={{ margin: 0 }}
          />
        </label>
      </button>
    </SortableItemInContainer>
  );
}

function tilePropsEqual(prev: DatasetBuilderTileProps, next: DatasetBuilderTileProps): boolean {
  if (prev.id !== next.id || prev.containerId !== next.containerId || prev.busy !== next.busy) {
    return false;
  }
  if (prev.selected !== next.selected || prev.previewStripIndex !== next.previewStripIndex) {
    return false;
  }
  if (prev.charKey !== next.charKey || prev.sectionTitle !== next.sectionTitle) return false;
  if (prev.entry !== next.entry) return false;
  if (prev.entries !== next.entries) return false;
  if (prev.previewPaths !== next.previewPaths) return false;
  return (
    prev.onBuilderCheckboxChange === next.onBuilderCheckboxChange &&
    prev.setMenu === next.setMenu &&
    prev.downloadRel === next.downloadRel &&
    prev.mergeBuilderFromApi === next.mergeBuilderFromApi &&
    prev.refreshStrip === next.refreshStrip &&
    prev.logRef === next.logRef &&
    prev.onError === next.onError &&
    prev.onPrompt === next.onPrompt &&
    prev.onAiEditTile === next.onAiEditTile &&
    prev.onRequestAddAngles === next.onRequestAddAngles &&
    prev.onRequestBatchGenerate === next.onRequestBatchGenerate &&
    prev.onOpenPreview === next.onOpenPreview &&
    prev.setEntries === next.setEntries &&
    prev.setDirty === next.setDirty &&
    prev.setSelectedBuilder === next.setSelectedBuilder &&
    prev.beginRemoveBackgroundModal === next.beginRemoveBackgroundModal &&
    prev.endRemoveBackgroundModal === next.endRemoveBackgroundModal &&
    prev.failRmbgJob === next.failRmbgJob
  );
}

export const DatasetBuilderTile = React.memo(DatasetBuilderTileInner, tilePropsEqual);
