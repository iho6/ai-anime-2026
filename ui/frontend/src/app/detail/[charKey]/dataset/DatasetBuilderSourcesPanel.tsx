"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { ResizableScrollGallery } from "../../../../components/ResizableScrollGallery";
import { apiDatasetBuilderOrder, assetUrlFromRelPath } from "../../../../lib/api";
import type { ContextMenuItem, DesktopContextMenuState } from "../../../../components/DesktopContextMenu";
import type { SharedLogStreamHandle } from "../../../../components/SharedLogStream";
import { DatasetBuilderDndShell } from "./DatasetBuilderDndShell";
import { DatasetBuilderTile } from "./DatasetBuilderTile";
import {
  computeMovingIds,
  reorderInsertBeforeOrAfter,
} from "../../../../components/dnd/reorder";
import type { BuilderEntry } from "./builderTypes";
import { buildBuilderEntriesPreserve, displayRelPath } from "./datasetBuilderStripUtils";

const TILE = 120;

type DatasetBuilderSourcesPanelProps = {
  charKey: string;
  busy: boolean;
  entries: BuilderEntry[];
  setEntries: React.Dispatch<React.SetStateAction<BuilderEntry[]>>;
  setDirty: React.Dispatch<React.SetStateAction<boolean>>;
  selectedBuilder: Set<string>;
  setSelectedBuilder: React.Dispatch<React.SetStateAction<Set<string>>>;
  setBuilderAnchorTileId: React.Dispatch<React.SetStateAction<string | null>>;
  onBuilderCheckboxChange: (id: string, on: boolean, ev: React.ChangeEvent<HTMLInputElement>) => void;
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
  onRequestAddAngles?: (ctx: {
    kind: "pose" | "expr";
    folderKey: string;
    inputRelPath?: string;
  }) => void;
  onRequestBatchGenerate?: (tileId: string) => void;
  onOpenPreview: (paths: string[], index: number, title: string) => void;
  poseStripIds: string[];
  exprStripIds: string[];
  setPoseStripIds: React.Dispatch<React.SetStateAction<string[]>>;
  setExprStripIds: React.Dispatch<React.SetStateAction<string[]>>;
  beginRemoveBackgroundModal: () => void | Promise<void>;
  endRemoveBackgroundModal: () => void;
  failRmbgJob: (err: unknown) => void;
  onRemoveBackgroundRequest?: (tileId: string, sourceRel: string) => void;
};

export function DatasetBuilderSourcesPanel(props: DatasetBuilderSourcesPanelProps) {
  const {
    charKey,
    busy,
    entries,
    setEntries,
    setDirty,
    selectedBuilder,
    setSelectedBuilder,
    setBuilderAnchorTileId,
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
    poseStripIds,
    exprStripIds,
    setPoseStripIds,
    setExprStripIds,
    beginRemoveBackgroundModal,
    endRemoveBackgroundModal,
    failRmbgJob,
    onRemoveBackgroundRequest,
  } = props;

  const poseDragIds = useMemo(
    () =>
      poseStripIds.filter((id) => {
        const e = entries.find((x) => x.tileId === id);
        return e && !e.removed;
      }),
    [entries, poseStripIds]
  );
  const exprDragIds = useMemo(
    () =>
      exprStripIds.filter((id) => {
        const e = entries.find((x) => x.tileId === id);
        return e && !e.removed;
      }),
    [entries, exprStripIds]
  );

  /** Non-hidden tiles only: section "select all" and selection counts. */
  const poseSelectableIds = useMemo(
    () =>
      poseDragIds.filter((id) => {
        const e = entries.find((x) => x.tileId === id);
        return e && !e.builderHidden;
      }),
    [entries, poseDragIds]
  );
  const exprSelectableIds = useMemo(
    () =>
      exprDragIds.filter((id) => {
        const e = entries.find((x) => x.tileId === id);
        return e && !e.builderHidden;
      }),
    [entries, exprDragIds]
  );

  /** Lightbox lists skip hidden (and entries without a display path). */
  const posePreviewMeta = useMemo(() => {
    const paths: string[] = [];
    const indexByTileId = new Map<string, number>();
    let idx = 0;
    for (const id of poseDragIds) {
      const x = entries.find((e) => e.tileId === id);
      if (!x || x.builderHidden || x.removed) continue;
      const p = displayRelPath(x);
      if (!p) continue;
      indexByTileId.set(id, idx);
      paths.push(assetUrlFromRelPath(p));
      idx++;
    }
    return { paths: paths, indexByTileId };
  }, [entries, poseDragIds]);

  const exprPreviewMeta = useMemo(() => {
    const paths: string[] = [];
    const indexByTileId = new Map<string, number>();
    let idx = 0;
    for (const id of exprDragIds) {
      const x = entries.find((e) => e.tileId === id);
      if (!x || x.builderHidden || x.removed) continue;
      const p = displayRelPath(x);
      if (!p) continue;
      indexByTileId.set(id, idx);
      paths.push(assetUrlFromRelPath(p));
      idx++;
    }
    return { paths: paths, indexByTileId };
  }, [entries, exprDragIds]);

  const poseSelectAllRef = useRef<HTMLInputElement>(null);
  const exprSelectAllRef = useRef<HTMLInputElement>(null);

  const poseSelected = poseSelectableIds.filter((id) => selectedBuilder.has(id)).length;
  const poseAll =
    poseSelectableIds.length > 0 && poseSelected === poseSelectableIds.length;
  const posePartial = poseSelected > 0 && poseSelected < poseSelectableIds.length;

  const exprSelected = exprSelectableIds.filter((id) => selectedBuilder.has(id)).length;
  const exprAll =
    exprSelectableIds.length > 0 && exprSelected === exprSelectableIds.length;
  const exprPartial = exprSelected > 0 && exprSelected < exprSelectableIds.length;

  useEffect(() => {
    const el = poseSelectAllRef.current;
    if (el) el.indeterminate = posePartial;
  }, [posePartial]);
  useEffect(() => {
    const el = exprSelectAllRef.current;
    if (el) el.indeterminate = exprPartial;
  }, [exprPartial]);

  function renderTile(id: string, containerId: "builderPose" | "builderExpr") {
    const e = entries.find((x) => x.tileId === id);
    if (!e) return null;
    const sectionTitle = containerId === "builderPose" ? "All Poses" : "All Expressions";
    const previewMeta =
      containerId === "builderPose" ? posePreviewMeta : exprPreviewMeta;
    const previewPaths = previewMeta.paths;
    const previewStripIndex = previewMeta.indexByTileId.get(e.tileId) ?? -1;

    return (
      <DatasetBuilderTile
        id={id}
        containerId={containerId}
        entry={e}
        entries={entries}
        busy={busy}
        charKey={charKey}
        sectionTitle={sectionTitle}
        previewPaths={previewPaths}
        previewStripIndex={previewStripIndex}
        selected={selectedBuilder.has(e.tileId)}
        onBuilderCheckboxChange={onBuilderCheckboxChange}
        setMenu={setMenu}
        downloadRel={downloadRel}
        mergeBuilderFromApi={mergeBuilderFromApi}
        refreshStrip={refreshStrip}
        logRef={logRef}
        onError={onError}
        onPrompt={onPrompt}
        onAiEditTile={onAiEditTile}
        onRequestAddAngles={onRequestAddAngles}
        onRequestBatchGenerate={onRequestBatchGenerate}
        onOpenPreview={onOpenPreview}
        setEntries={setEntries}
        setDirty={setDirty}
        setSelectedBuilder={setSelectedBuilder}
        beginRemoveBackgroundModal={beginRemoveBackgroundModal}
        endRemoveBackgroundModal={endRemoveBackgroundModal}
        failRmbgJob={failRmbgJob}
        onRemoveBackgroundRequest={onRemoveBackgroundRequest}
      />
    );
  }

  return (
    <DatasetBuilderDndShell
      disabled={busy}
      containers={[
        { id: "builderPose", ids: poseDragIds },
        { id: "builderExpr", ids: exprDragIds },
      ]}
      renderContainer={({ containerId, children, setContainerRef }) => {
        const title = containerId === "builderPose" ? "All Poses" : "All Expressions";
        const layoutIds = containerId === "builderPose" ? poseDragIds : exprDragIds;
        const selectableIds =
          containerId === "builderPose" ? poseSelectableIds : exprSelectableIds;
        const ref = containerId === "builderPose" ? poseSelectAllRef : exprSelectAllRef;
        const all = containerId === "builderPose" ? poseAll : exprAll;
        const partial = containerId === "builderPose" ? posePartial : exprPartial;
        const firstSelectableId = selectableIds[0];
        const firstEntry = firstSelectableId
          ? entries.find((x) => x.tileId === firstSelectableId)
          : undefined;

        return (
          <>
            <div
              style={{
                marginTop: 12,
                marginBottom: 6,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <input
                ref={ref}
                type="checkbox"
                checked={all}
                disabled={selectableIds.length === 0}
                aria-label={`Select all in ${title}`}
                onChange={(ev) => {
                  const checked = ev.target.checked;
                  setSelectedBuilder((prev) => {
                    const n = new Set(prev);
                    if (checked) {
                      for (const id of selectableIds) n.add(id);
                    } else {
                      for (const id of layoutIds) n.delete(id);
                    }
                    return n;
                  });
                  if (checked && firstEntry) {
                    setBuilderAnchorTileId(firstEntry.tileId);
                  }
                }}
                style={{ margin: 0 }}
              />
              <span>{title}</span>
            </div>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
              Drag the panel corner to resize
            </div>
            <ResizableScrollGallery aria-label={title}>
              <div
                ref={setContainerRef as React.RefCallback<HTMLDivElement>}
                style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 4 }}
              >
                {children}
              </div>
            </ResizableScrollGallery>
          </>
        );
      }}
      renderItem={({ id, containerId }) =>
        renderTile(id, containerId as "builderPose" | "builderExpr")
      }
      renderDragOverlay={({ id }) => {
        const e = entries.find((x) => x.tileId === id);
        if (!e) return null;
        const rel = displayRelPath(e);
        return (
          <div style={{ width: TILE, height: TILE, cursor: "grabbing", touchAction: "none" }}>
            {rel ? (
              <img
                src={assetUrlFromRelPath(rel)}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            ) : null}
          </div>
        );
      }}
      onDragEnd={({
        activeId,
        overId,
        insertAfter,
        sourceContainerId,
        targetContainerId,
      }) => {
        if (!overId || activeId === overId) return;
        const prev = entries;
        const poseIds = poseDragIds;
        const exprIds = exprDragIds;
        const sourceIds = sourceContainerId === "builderPose" ? poseIds : exprIds;
        const movingIds = computeMovingIds({
          activeId,
          selectedIds: selectedBuilder,
          sourceIds,
        });
        const movingSet = new Set(movingIds);
        const withoutMoving = prev.filter((e) => !movingSet.has(e.tileId));
        const overIdx = withoutMoving.findIndex((e) => e.tileId === overId);
        if (overIdx < 0) return;
        const insertAt = overIdx + (insertAfter ? 1 : 0);
        const movingEntries: BuilderEntry[] = [];
        for (const id of movingIds) {
          const e = prev.find((x) => x.tileId === id);
          if (e) movingEntries.push(e);
        }
        if (movingEntries.length !== movingIds.length) return;
        const next = [
          ...withoutMoving.slice(0, insertAt),
          ...movingEntries,
          ...withoutMoving.slice(insertAt),
        ];
        const r = reorderInsertBeforeOrAfter({
          activeId,
          overId,
          insertAfter,
          sourceContainerId,
          targetContainerId,
          containers: { builderPose: poseIds, builderExpr: exprIds },
          selectedIds: selectedBuilder,
        });
        const P2 = r.containers.builderPose ?? [];
        const E2 = r.containers.builderExpr ?? [];
        setEntries(next);
        setPoseStripIds(P2);
        setExprStripIds(E2);
        const preserve = buildBuilderEntriesPreserve(next);
        void apiDatasetBuilderOrder(charKey, {
          tileIds: next.map((e) => e.tileId),
          poseStripIds: P2,
          exprStripIds: E2,
        }).then(() => mergeBuilderFromApi(preserve));
      }}
    />
  );
}

