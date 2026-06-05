"use client";

import React, { useState } from "react";
import {
  apiDatasetFolderDelete,
  apiDatasetFolderDownloadZip,
  apiDatasetFolderDuplicate,
  apiDatasetFolderRename,
  apiSequenceFolderDelete,
  apiSequenceFolderDuplicate,
  apiSequenceFolderRename,
  apiSequenceRepairPaths,
} from "../../../../lib/api";
import type { ContextMenuItem, DesktopContextMenuState } from "../../../../components/DesktopContextMenu";
import type { SharedLogStreamHandle } from "../../../../components/SharedLogStream";
import type { BuilderEntry } from "./builderTypes";
import { parseSequenceBuilderDrop } from "./datasetSequenceDrop";
import { displayRelPath } from "./datasetBuilderStripUtils";
import { DatasetBuilderSourcesPanel } from "./DatasetBuilderSourcesPanel";
import { SEQUENCE_BUILDER_DRAG_MIME } from "./sequenceGalleryUtils";

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

export type DatasetBuilderTabProps = {
  charKey: string;
  busy: boolean;
  entries: BuilderEntry[];
  setEntries: React.Dispatch<React.SetStateAction<BuilderEntry[]>>;
  setDirty: React.Dispatch<React.SetStateAction<boolean>>;
  selectedBuilder: Set<string>;
  setSelectedBuilder: React.Dispatch<React.SetStateAction<Set<string>>>;
  setBuilderAnchorTileId: React.Dispatch<React.SetStateAction<string | null>>;
  onBuilderTileCheckboxChange: (
    tileId: string,
    targetChecked: boolean,
    ev: React.ChangeEvent<HTMLInputElement>
  ) => void;
  folderNames: string[];
  sequenceNames: string[];
  refreshStrip: () => Promise<void>;
  refreshSequenceStrip: () => Promise<void>;
  setMenu: React.Dispatch<React.SetStateAction<DesktopContextMenuState>>;
  /** In-app clipboard for copy/paste dataset folder (same character). */
  folderClip: { kind: "dataset"; name: string; charKey: string } | null;
  setFolderClip: React.Dispatch<
    React.SetStateAction<{ kind: "dataset"; name: string; charKey: string } | null>
  >;
  showError: (input: { title?: string; message: string; error?: unknown; details?: string }) => void;
  askText: (input: {
    title: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<string | null>;
  confirmAction: (input: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
  downloadRel: (rel: string) => void;
  mergeBuilderFromApi: (p: Map<string, Partial<BuilderEntry>>) => Promise<void>;
  logRef: React.RefObject<SharedLogStreamHandle | null>;
  onAiEditTile: (entry: BuilderEntry) => void;
  onRequestAddAngles?: (ctx: {
    kind: "pose" | "expr";
    folderKey: string;
    inputRelPath?: string;
  }) => void;
  onOpenPreview: (paths: string[], index: number, title: string) => void;
  builderPoseStripIds: string[];
  builderExprStripIds: string[];
  setBuilderPoseStripIds: React.Dispatch<React.SetStateAction<string[]>>;
  setBuilderExprStripIds: React.Dispatch<React.SetStateAction<string[]>>;
  setView: React.Dispatch<React.SetStateAction<"builder" | "saved" | "sequence">>;
  setSequenceFolderKey: React.Dispatch<React.SetStateAction<string | null>>;
  onSaveDatasetFolder: () => void | Promise<void>;
  onOpenSavedDataset: (name: string) => void | Promise<void>;
  onCreateSequenceFromSelection: () => void | Promise<void>;
  onBatchRemoveBackground: () => void;
  onBatchAddNoise: () => void;
  onBatchRestoreBackground: () => void;
  onBatchRemoveNoise: () => void;
  onBatchAngle: () => void;
  onDropBuilderImageOnSequence: (
    sequenceName: string,
    sourceRelPath: string
  ) => void | Promise<void>;
  beginRemoveBackgroundModal: () => void;
  endRemoveBackgroundModal: () => void;
  failRmbgJob: (err: unknown) => void;
};

export function DatasetBuilderTab(props: DatasetBuilderTabProps) {
  const {
    charKey,
    busy,
    entries,
    setEntries,
    setDirty,
    selectedBuilder,
    setSelectedBuilder,
    setBuilderAnchorTileId,
    onBuilderTileCheckboxChange,
    folderNames,
    sequenceNames,
    refreshStrip,
    refreshSequenceStrip,
    setMenu,
    folderClip,
    setFolderClip,
    showError,
    askText,
    confirmAction,
    downloadRel,
    mergeBuilderFromApi,
    logRef,
    onAiEditTile,
    onRequestAddAngles,
    onOpenPreview,
    builderPoseStripIds,
    builderExprStripIds,
    setBuilderPoseStripIds,
    setBuilderExprStripIds,
    setView,
    setSequenceFolderKey,
    onSaveDatasetFolder,
    onOpenSavedDataset,
    onCreateSequenceFromSelection,
    onBatchRemoveBackground,
    onBatchAddNoise,
    onBatchRestoreBackground,
    onBatchRemoveNoise,
    onBatchAngle,
    onDropBuilderImageOnSequence,
    beginRemoveBackgroundModal,
    endRemoveBackgroundModal,
    failRmbgJob,
  } = props;

  const [seqDropOver, setSeqDropOver] = useState<string | null>(null);

  function seqDropTypesOk(e: React.DragEvent) {
    return Array.from(e.dataTransfer.types ?? []).includes(SEQUENCE_BUILDER_DRAG_MIME);
  }

  return (
    <>
      <div style={{ marginBottom: 8 }}>Create Dataset / Sequence</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onSaveDatasetFolder()}
          style={{
            width: TILE,
            height: TILE,
            border: "1px solid rgba(0,0,0,0.35)",
            background: "transparent",
            cursor: "pointer",
            whiteSpace: "pre-wrap",
            textAlign: "center",
          }}
        >
          Turn Below{"\n"}Images Into{"\n"}Dataset
        </button>
        {folderNames.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => void onOpenSavedDataset(n)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                open: true,
                x: e.clientX,
                y: e.clientY,
                items: [
                  {
                    key: "rename",
                    label: "Rename Dataset",
                    onSelect: async () => {
                      const nn = await askText({
                        title: "Rename Dataset",
                        message: "New dataset folder name:",
                        defaultValue: n,
                        confirmText: "Rename",
                      });
                      if (!nn?.trim()) return;
                      void apiDatasetFolderRename(charKey, n, nn.trim())
                        .then(refreshStrip)
                        .catch((err) => showError({ message: "Action failed.", error: err }));
                    },
                  },
                  {
                    key: "download",
                    label: "Download Dataset",
                    onSelect: () => {
                      void (async () => {
                        if (busy) return;
                        try {
                          const blob = await apiDatasetFolderDownloadZip(charKey, n);
                          const safe = n.replace(/[/\\?%*:|"<>]/g, "_").trim() || "dataset";
                          downloadBlobAsFile(blob, `${safe}.zip`);
                        } catch (err) {
                          showError({ message: "Dataset zip download failed.", error: err });
                        }
                      })();
                    },
                  },
                  {
                    key: "delete",
                    label: "Delete Dataset",
                    onSelect: async () => {
                      const ok = await confirmAction({
                        title: "Delete Dataset",
                        message: `Delete dataset "${n}"?`,
                        confirmText: "Delete",
                      });
                      if (!ok) return;
                      void apiDatasetFolderDelete(charKey, n)
                        .then(refreshStrip)
                        .catch((err) => showError({ message: "Action failed.", error: err }));
                    },
                  },
                ],
                footerItems: [
                  {
                    key: "ds-copy",
                    label: "Copy dataset",
                    disabled: busy,
                    onSelect: () => setFolderClip({ kind: "dataset", name: n, charKey }),
                  },
                  {
                    key: "ds-paste",
                    label: "Paste dataset",
                    disabled: busy || !folderClip || folderClip.charKey !== charKey,
                    onSelect: () => {
                      void (async () => {
                        if (!folderClip || folderClip.charKey !== charKey) return;
                        const src = folderClip.name;
                        const nn = await askText({
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
                          showError({ message: "Could not paste dataset.", error: err });
                        }
                      })();
                    },
                  },
                ],
              });
            }}
            style={{
              width: TILE,
              height: TILE,
              border: "1px solid rgba(0,0,0,0.35)",
              background: "transparent",
              cursor: "pointer",
              whiteSpace: "pre-wrap",
              textAlign: "center",
            }}
          >
            {n.replace(/ /g, "\n")}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 12, marginBottom: 6 }}>Sequences</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onCreateSequenceFromSelection()}
          style={{
            width: TILE,
            height: TILE,
            border: "1px solid rgba(0,0,0,0.35)",
            background: "transparent",
            cursor: "pointer",
            whiteSpace: "pre-wrap",
            textAlign: "center",
          }}
        >
          Group Selected{"\n"}Images Into{"\n"}Sequence
        </button>
        {sequenceNames.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => {
              setSequenceFolderKey(n);
              setView("sequence");
            }}
            onDragOver={(e) => {
              if (!seqDropTypesOk(e) || busy) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDragEnter={(e) => {
              if (!seqDropTypesOk(e) || busy) return;
              e.preventDefault();
              setSeqDropOver(n);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setSeqDropOver((cur) => (cur === n ? null : cur));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setSeqDropOver(null);
              if (busy) return;
              const relPath = parseSequenceBuilderDrop(e);
              if (!relPath) return;
              void onDropBuilderImageOnSequence(n, relPath);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                open: true,
                x: e.clientX,
                y: e.clientY,
                items: [
                  {
                    key: "rename",
                    label: "Rename Sequence",
                    onSelect: async () => {
                      const nn = await askText({
                        title: "Rename Sequence",
                        message: "New sequence folder name:",
                        defaultValue: n,
                        confirmText: "Rename",
                      });
                      if (!nn?.trim()) return;
                      try {
                        const r = await apiSequenceFolderRename(charKey, n, nn.trim());
                        await refreshSequenceStrip();
                        setSequenceFolderKey((cur) => (cur === n ? r.newName : cur));
                      } catch (err) {
                        showError({ message: "Action failed.", error: err });
                      }
                    },
                  },
                  {
                    key: "repairPaths",
                    label: "Repair Sequence Paths",
                    onSelect: async () => {
                      const ok = await confirmAction({
                        title: "Repair Sequence Paths",
                        message: `Repair stale relPath values in sequence "${n}"?`,
                        confirmText: "Repair",
                      });
                      if (!ok) return;
                      try {
                        await apiSequenceRepairPaths(charKey, n);
                        await refreshSequenceStrip();
                        setSequenceFolderKey((cur) => (cur === n ? n : cur));
                      } catch (err) {
                        showError({ message: "Could not repair sequence paths.", error: err });
                      }
                    },
                  },
                  {
                    key: "delete",
                    label: "Delete Sequence",
                    onSelect: async () => {
                      const ok = await confirmAction({
                        title: "Delete Sequence",
                        message: `Delete sequence "${n}"?`,
                        confirmText: "Delete",
                      });
                      if (!ok) return;
                      try {
                        await apiSequenceFolderDelete(charKey, n);
                        await refreshSequenceStrip();
                        setSequenceFolderKey((cur) => (cur === n ? null : cur));
                        setView((v) => (v === "sequence" ? "builder" : v));
                      } catch (err) {
                        showError({ message: "Action failed.", error: err });
                      }
                    },
                  },
                ],
                footerItems: [
                  {
                    key: "seq-make-copy",
                    label: "Make Copy",
                    disabled: busy,
                    onSelect: () => {
                      void (async () => {
                        const src = n;
                        const nn = await askText({
                          title: "Make Copy",
                          message: `Name for the copy of sequence "${src}":`,
                          defaultValue: `${src}_copy`,
                          confirmText: "Create",
                        });
                        if (!nn?.trim()) return;
                        try {
                          const r = await apiSequenceFolderDuplicate(charKey, src, nn.trim());
                          await refreshSequenceStrip();
                          setSequenceFolderKey((cur) => (cur === src ? r.newName : cur));
                        } catch (err) {
                          showError({ message: "Could not copy sequence.", error: err });
                        }
                      })();
                    },
                  },
                ],
              });
            }}
            style={{
              width: TILE,
              height: TILE,
              border:
                seqDropOver === n
                  ? "2px solid #06c"
                  : "1px solid rgba(0,0,0,0.35)",
              background: "transparent",
              cursor: "pointer",
              whiteSpace: "pre-wrap",
              textAlign: "center",
            }}
          >
            {n.replace(/ /g, "\n")}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        {(
          [
            ["Remove Background", onBatchRemoveBackground],
            ["Add Noise", onBatchAddNoise],
            ["Restore background", onBatchRestoreBackground],
            ["Remove noise", onBatchRemoveNoise],
            ["Batch Angle", onBatchAngle],
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
            [
              "Hide",
              () => {
                for (const id of Array.from(selectedBuilder)) {
                  setEntries((list) =>
                    list.map((x) => (x.tileId === id ? { ...x, builderHidden: true } : x))
                  );
                }
                setDirty(true);
                setSelectedBuilder(new Set());
              },
            ],
            [
              "Unhide",
              () => {
                for (const id of Array.from(selectedBuilder)) {
                  setEntries((list) =>
                    list.map((x) => (x.tileId === id ? { ...x, builderHidden: false } : x))
                  );
                }
                setDirty(true);
                setSelectedBuilder(new Set());
              },
            ],
            [
              "Delete",
              () => {
                for (const id of Array.from(selectedBuilder)) {
                  setEntries((list) =>
                    list.map((x) => (x.tileId === id ? { ...x, removed: true } : x))
                  );
                }
                setDirty(true);
              },
            ],
            [
              "Download",
              () => {
                for (const id of Array.from(selectedBuilder)) {
                  const e = entries.find((x) => x.tileId === id);
                  if (!e) continue;
                  downloadRel(displayRelPath(e));
                }
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

      <DatasetBuilderSourcesPanel
        charKey={charKey}
        busy={busy}
        entries={entries}
        setEntries={setEntries}
        setDirty={setDirty}
        selectedBuilder={selectedBuilder}
        setSelectedBuilder={setSelectedBuilder}
        setBuilderAnchorTileId={setBuilderAnchorTileId}
        onBuilderCheckboxChange={onBuilderTileCheckboxChange}
        setMenu={setMenu}
        downloadRel={downloadRel}
        mergeBuilderFromApi={mergeBuilderFromApi}
        refreshStrip={refreshStrip}
        logRef={logRef}
        onError={showError}
        onPrompt={askText}
        onAiEditTile={onAiEditTile}
        onRequestAddAngles={onRequestAddAngles}
        onOpenPreview={onOpenPreview}
        poseStripIds={builderPoseStripIds}
        exprStripIds={builderExprStripIds}
        setPoseStripIds={setBuilderPoseStripIds}
        setExprStripIds={setBuilderExprStripIds}
        beginRemoveBackgroundModal={beginRemoveBackgroundModal}
        endRemoveBackgroundModal={endRemoveBackgroundModal}
        failRmbgJob={failRmbgJob}
      />
    </>
  );
}
