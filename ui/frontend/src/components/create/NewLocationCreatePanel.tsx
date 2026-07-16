"use client";

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  apiNewLocationAppendUpload,
  apiNewLocationArchiveBase,
  apiNewLocationArchiveList,
  apiNewLocationDiscard,
  apiNewLocationDraftBases,
  apiNewLocationFinalize,
  apiNewLocationGenerateStream,
  apiNewLocationImportFromArchive,
  apiNewLocationRemoveDraft,
  assetUrlFromRelPath,
  CoverCandidate,
} from "../../lib/api";
import { DesktopContextMenu, ContextMenuItem } from "../DesktopContextMenu";
import { ImagePickerModal } from "../ImagePickerModal";
import { GalleryImagePager } from "../GalleryImagePager";
import type { SharedLogStreamHandle } from "../SharedLogStream";
import { ConnectedJobRunModal } from "../ConnectedJobRunModal";
import { useJobRunSession } from "../../hooks/useJobRunSession";
import { SquareButton } from "../SquareButton";
import { ZoomableImage } from "../ZoomableImage";
import { useAppError } from "../ErrorProvider";

const PROMPT_ROW_PX = 100;
const PREVIEW_H_PAGE = 360;
const PREVIEW_H_EMBEDDED = 200;

export type NewLocationCreatePanelHandle = {
  hasDrafts: () => boolean;
  cancelWithConfirm: () => Promise<boolean>;
  discardDraftsWithConfirm: () => Promise<boolean>;
};

export type NewLocationCreatePanelProps = {
  variant: "page" | "embedded";
  onFinalized: (locationKey: string) => void;
  onCancelled: () => void;
  cancelConfirmMessage?: string;
};

export const NewLocationCreatePanel = forwardRef<
  NewLocationCreatePanelHandle,
  NewLocationCreatePanelProps
>(function NewLocationCreatePanel(props, ref) {
  const {
    variant,
    onFinalized,
    onCancelled,
    cancelConfirmMessage = "Clear all draft images in the workspace and leave?",
  } = props;
  const embedded = variant === "embedded";
  const previewH = embedded ? PREVIEW_H_EMBEDDED : PREVIEW_H_PAGE;

  const { showError, confirmAction } = useAppError();

  const [draftRelPaths, setDraftRelPaths] = useState<string[]>([]);
  const [draftIndex, setDraftIndex] = useState(0);
  const [imgBust, setImgBust] = useState(0);

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: busy,
    beginSession,
    endSession,
    failSession,
    pushLog,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const stagedInputRef = useRef<HTMLInputElement | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuX, setMenuX] = useState(0);
  const [menuY, setMenuY] = useState(0);

  const [archivePickerOpen, setArchivePickerOpen] = useState(false);
  const [archiveImages, setArchiveImages] = useState<CoverCandidate[]>([]);

  const previewRelPath =
    draftRelPaths.length > 0 ? draftRelPaths[Math.min(draftIndex, draftRelPaths.length - 1)] : "";

  const refreshDrafts = useCallback(async (selectNewest: boolean) => {
    const { relPaths } = await apiNewLocationDraftBases();
    setDraftRelPaths(relPaths);
    if (selectNewest) {
      // Backend returns newest-first; show as 1/N.
      setDraftIndex(0);
    } else {
      setDraftIndex((i) => Math.min(i, Math.max(0, relPaths.length - 1)));
    }
  }, []);

  useEffect(() => {
    refreshDrafts(false).catch(() => {
      /* ignore */
    });
  }, [refreshDrafts]);

  const borderColor = embedded ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.35)";
  const fieldStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    border: `1px solid ${borderColor}`,
    background: "transparent",
    color: "inherit",
    boxSizing: "border-box",
    font: "inherit",
  };

  const menuItems: ContextMenuItem[] = useMemo(() => {
    const rel = previewRelPath;
    return [
      {
        key: "discard_one",
        label: "Discard draft",
        disabled: !rel,
        onSelect: async () => {
          if (!rel) return;
          const ok = await confirmAction({
            title: "Discard draft",
            message: "Remove only the preview image from the workspace?",
            confirmText: "Remove",
          });
          if (!ok) return;
          beginSession({ title: "Discard draft", clearLog: true });
          pushLog("Removing draft…");
          try {
            await apiNewLocationRemoveDraft({ relPath: rel });
            await refreshDrafts(false);
            setImgBust((b) => b + 1);
            endSession();
          } catch (e) {
            failSession(e, "Could not remove draft.");
          }
        },
      },
      {
        key: "archive_base",
        label: "Archive Location Base",
        disabled: !rel,
        onSelect: async () => {
          if (!rel) return;
          beginSession({ title: "Archive Location Base", clearLog: true });
          pushLog("Archiving image…");
          try {
            await apiNewLocationArchiveBase({ relPath: rel });
            await refreshDrafts(false);
            setImgBust((b) => b + 1);
            endSession();
          } catch (e) {
            failSession(e, "Could not archive image.");
          }
        },
      },
    ];
  }, [
    beginSession,
    confirmAction,
    endSession,
    failSession,
    previewRelPath,
    pushLog,
    refreshDrafts,
  ]);

  async function onGenerate() {
    const user = prompt.trim();
    if (!user) {
      showError({ message: "Please enter a prompt." });
      return;
    }

    beginSession({ title: "Generating location", clearLog: true });
    await Promise.resolve();
    pushLog("Starting generation (live logs from image service)…");
    try {
      await apiNewLocationGenerateStream({
        prompt: user,
        onLogLine: (line) => pushLog(line),
      });
    } catch (err) {
      failSession(err, "Location generation failed.");
      return;
    }
    try {
      await refreshDrafts(true);
      setImgBust((b) => b + 1);
    } catch (err) {
      failSession(err, "Generated image but failed to refresh draft list.");
      return;
    }
    endSession();
  }

  async function appendImageFile(file: File | null) {
    if (!file) return;
    beginSession({ title: "Adding image", clearLog: true });
    await Promise.resolve();
    pushLog("Uploading image…");
    try {
      await apiNewLocationAppendUpload({ file });
      await refreshDrafts(true);
      setImgBust((b) => b + 1);
    } catch (err) {
      failSession(err, "Could not add image.");
      return;
    }
    endSession();
  }

  async function openArchivePicker() {
    try {
      const { relPaths } = await apiNewLocationArchiveList();
      setArchiveImages(
        relPaths.map((p) => ({
          relPath: p,
          caption: p.includes("/") ? p.split("/").pop() || p : p,
        }))
      );
      setArchivePickerOpen(true);
    } catch (e) {
      showError({ message: "Could not load archive.", error: e });
    }
  }

  async function onSave() {
    const nn = name.trim();
    if (!nn) {
      showError({ message: "Please enter a location name." });
      return;
    }

    const paths = draftRelPaths;
    const index = Math.min(draftIndex, Math.max(0, draftRelPaths.length - 1));

    if (paths.length === 0) {
      showError({ message: "Generate or add an image first." });
      return;
    }

    if (paths.length > 1) {
      const ok = await confirmAction({
        title: "Save location",
        message:
          "Only the image currently on preview will be used as this location's cover. Other drafts remain in the workspace until you remove them.",
        confirmText: "Save",
      });
      if (!ok) return;
    }

    const rel = paths[Math.min(index, paths.length - 1)];
    beginSession({ title: "Saving location", clearLog: true });
    pushLog(`Saving as ${nn}…`);
    try {
      await apiNewLocationFinalize({ locationName: nn, relPath: rel });
      endSession();
      onFinalized(nn);
    } catch (e) {
      failSession(e, "Save failed.");
    }
  }

  const cancelWithConfirm = useCallback(async (): Promise<boolean> => {
    if (draftRelPaths.length > 0) {
      const ok = await confirmAction({
        title: "Leave new location",
        message: cancelConfirmMessage,
        confirmText: "Leave",
      });
      if (!ok) return false;
    }
    if (draftRelPaths.length > 0) {
      beginSession({ title: "Leave new location", clearLog: true });
      pushLog("Clearing draft workspace…");
      try {
        await apiNewLocationDiscard();
        endSession();
      } catch (e) {
        failSession(e, "Could not clear draft workspace.");
        return false;
      }
    }
    onCancelled();
    return true;
  }, [
    beginSession,
    cancelConfirmMessage,
    confirmAction,
    draftRelPaths.length,
    endSession,
    failSession,
    onCancelled,
    pushLog,
  ]);

  const discardDraftsWithConfirm = useCallback(async (): Promise<boolean> => {
    if (draftRelPaths.length === 0) return true;
    const ok = await confirmAction({
      title: "Leave new location",
      message: cancelConfirmMessage,
      confirmText: "Leave",
    });
    if (!ok) return false;
    beginSession({ title: "Leave new location", clearLog: true });
    pushLog("Clearing draft workspace…");
    try {
      await apiNewLocationDiscard();
      endSession();
      return true;
    } catch (e) {
      failSession(e, "Could not clear draft workspace.");
      return false;
    }
  }, [
    beginSession,
    cancelConfirmMessage,
    confirmAction,
    draftRelPaths.length,
    endSession,
    failSession,
    pushLog,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      hasDrafts: () => draftRelPaths.length > 0,
      cancelWithConfirm,
      discardDraftsWithConfirm,
    }),
    [cancelWithConfirm, discardDraftsWithConfirm, draftRelPaths.length]
  );

  const previewUrl = previewRelPath
    ? `${assetUrlFromRelPath(previewRelPath)}?v=${imgBust}`
    : "";

  return (
    <>
      <div
        title="Drag corner to resize preview"
        style={{
          resize: "both",
          overflow: "hidden",
          width: "100%",
          height: previewH,
          minWidth: 160,
          minHeight: 120,
          maxWidth: "100%",
          maxHeight: "min(70vh, 720px)",
          border: embedded ? `1px dashed ${borderColor}` : `1px dashed rgba(0,0,0,0.35)`,
          display: "flex",
          alignItems: "stretch",
          justifyContent: "center",
          marginBottom: 0,
          boxSizing: "border-box",
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuX(e.clientX);
          setMenuY(e.clientY);
          setMenuOpen(true);
        }}
      >
        {previewUrl ? (
          <div
            style={{
              width: "100%",
              height: "100%",
              minHeight: 0,
              display: "flex",
              alignItems: "stretch",
              justifyContent: "center",
            }}
          >
            <ZoomableImage
              src={previewUrl}
              fitMaxWidth="100%"
              fitMaxHeight="100%"
            />
          </div>
        ) : (
          <div style={{ opacity: 0.75, fontSize: 14, alignSelf: "center" }}>
            No preview
          </div>
        )}
      </div>
      <div
        style={{
          fontSize: 10,
          color: embedded ? "#555" : "rgba(0,0,0,0.45)",
          marginBottom: draftRelPaths.length >= 1 ? 0 : embedded ? 12 : 16,
          userSelect: "none",
        }}
      >
        Drag corner to resize preview
      </div>

      {draftRelPaths.length >= 1 ? (
        <GalleryImagePager
          variant="pageDark"
          index={draftIndex}
          count={draftRelPaths.length}
          onPrev={() => setDraftIndex((i) => Math.max(0, i - 1))}
          onNext={() =>
            setDraftIndex((i) => Math.min(draftRelPaths.length - 1, i + 1))
          }
          style={{ marginBottom: embedded ? 12 : 16 }}
        />
      ) : null}

      <DesktopContextMenu
        open={menuOpen}
        x={menuX}
        y={menuY}
        items={menuItems}
        onClose={() => setMenuOpen(false)}
      />

      <ImagePickerModal
        open={archivePickerOpen}
        title="Browse archive"
        okText="Add to workspace"
        cancelText="Cancel"
        images={archiveImages}
        onCancel={() => setArchivePickerOpen(false)}
        onPick={async (relPath) => {
          setArchivePickerOpen(false);
          try {
            await apiNewLocationImportFromArchive({ relPath });
            await refreshDrafts(true);
            setImgBust((b) => b + 1);
          } catch (e) {
            showError({ message: "Could not import from archive.", error: e });
          }
        }}
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: embedded ? 12 : 18 }}>
        <div style={{ gridColumn: "1 / span 2" }}>
          <div style={{ marginBottom: 6, fontSize: 14, opacity: 0.95 }}>Location name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. RooftopSunset (required to save)"
            style={fieldStyle}
          />
        </div>

        <div style={{ gridColumn: "1 / span 2" }}>
          <div style={{ marginBottom: 6, fontSize: 14, opacity: 0.95 }}>
            Generate location via prompt or manually add a starting background image
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "stretch", flexWrap: "wrap" }}>
            <div
              style={{
                flex: "1 1 220px",
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. sunlit anime city street at dusk"
                rows={3}
                style={{
                  ...fieldStyle,
                  height: PROMPT_ROW_PX,
                  minHeight: PROMPT_ROW_PX,
                  maxHeight: PROMPT_ROW_PX,
                  resize: "none",
                }}
              />
              <button
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  void onGenerate();
                }}
                style={{
                  borderRadius: 0,
                  border: `1px solid ${embedded ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.5)"}`,
                  background: "transparent",
                  padding: "8px 12px",
                  cursor: busy ? "not-allowed" : "pointer",
                  marginTop: 8,
                  width: "100%",
                  opacity: busy ? 0.7 : 1,
                  color: "inherit",
                  font: "inherit",
                }}
              >
                Generate Location
              </button>
            </div>

            <SquareButton
              disabled={busy}
              onClick={() => stagedInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0] ?? null;
                void appendImageFile(f);
              }}
              variant="import"
              tone={embedded ? "light" : "dark"}
              size={PROMPT_ROW_PX}
              style={{
                flexShrink: 0,
                alignSelf: "flex-start",
                padding: 8,
                fontSize: 11,
                lineHeight: 1.2,
                background: embedded ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.02)",
              }}
              title="Manually add starting background image"
            >
              Add Image from Local
            </SquareButton>

            <SquareButton
              disabled={busy}
              type="button"
              onClick={() => void openArchivePicker()}
              variant="tile"
              tone={embedded ? "light" : "dark"}
              size={PROMPT_ROW_PX}
              style={{
                flexShrink: 0,
                alignSelf: "flex-start",
                padding: 8,
                fontSize: 11,
                lineHeight: 1.2,
                background: embedded ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.02)",
              }}
              title="Browse archived location bases"
            >
              Browse
              <br />
              Archive
            </SquareButton>

            <input
              ref={stagedInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                e.currentTarget.value = "";
                void appendImageFile(f);
              }}
              style={{ display: "none" }}
            />
          </div>

          {draftRelPaths.length > 0 ? (
            <div style={{ marginTop: 8, fontSize: 14, opacity: 0.95 }}>
              {draftRelPaths.length} draft image{draftRelPaths.length === 1 ? "" : "s"} in workspace
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
            <button
              onClick={(e) => {
                e.preventDefault();
                void onSave();
              }}
              style={{
                borderRadius: 0,
                border: `1px solid ${embedded ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.5)"}`,
                background: "transparent",
                padding: "8px 12px",
                cursor: "pointer",
                color: "inherit",
                font: "inherit",
              }}
            >
              Save
            </button>
            <button
              onClick={(e) => {
                e.preventDefault();
                void cancelWithConfirm();
              }}
              style={{
                borderRadius: 0,
                border: `1px solid ${embedded ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.5)"}`,
                background: "transparent",
                padding: "8px 12px",
                cursor: "pointer",
                color: "inherit",
                font: "inherit",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />
    </>
  );
});
