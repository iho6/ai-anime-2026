"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiHubDelete,
  apiNewCharacterAppendUpload,
  apiNewCharacterArchiveBase,
  apiNewCharacterArchiveList,
  apiNewCharacterDiscard,
  apiNewCharacterDraftBases,
  apiNewCharacterFinalize,
  apiNewCharacterGenerateStream,
  apiNewCharacterImportFromArchive,
  apiNewCharacterRemoveDraft,
  CoverCandidate,
} from "../../lib/api";
import { DesktopContextMenu, ContextMenuItem } from "../../components/DesktopContextMenu";
import { ImagePickerModal } from "../../components/ImagePickerModal";
import { assetUrlFromRelPath } from "../../lib/api";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import { GalleryImagePager } from "../../components/GalleryImagePager";
import type { SharedLogStreamHandle } from "../../components/SharedLogStream";
import { ConnectedJobRunModal } from "../../components/ConnectedJobRunModal";
import { useJobRunSession } from "../../hooks/useJobRunSession";
import { SquareButton } from "../../components/SquareButton";
import { ZoomableImage } from "../../components/ZoomableImage";
import { useAppError } from "../../components/ErrorProvider";
import { BaseCloseupWizardModal } from "../../components/BaseCloseupWizardModal";

/** Text area height matches adjacent square import / archive buttons. */
const PROMPT_ROW_PX = 100;

export default function NewCharacterPage() {
  const router = useRouter();
  // showError: validation only; API failures use the job modal (failSession).
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
  const [closeupWizardOpen, setCloseupWizardOpen] = useState(false);
  const [closeupWizardCharKey, setCloseupWizardCharKey] = useState("");

  const previewRelPath =
    draftRelPaths.length > 0 ? draftRelPaths[Math.min(draftIndex, draftRelPaths.length - 1)] : "";

  const refreshDrafts = useCallback(async (selectLast: boolean) => {
    const { relPaths } = await apiNewCharacterDraftBases();
    setDraftRelPaths(relPaths);
    if (selectLast) {
      setDraftIndex(Math.max(0, relPaths.length - 1));
    } else {
      setDraftIndex((i) => Math.min(i, Math.max(0, relPaths.length - 1)));
    }
  }, []);

  useEffect(() => {
    refreshDrafts(false).catch(() => {
      /* ignore: API down or network */
    });
  }, [refreshDrafts]);

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
            await apiNewCharacterRemoveDraft({ relPath: rel });
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
        label: "Archive Character Base",
        disabled: !rel,
        onSelect: async () => {
          if (!rel) return;
          beginSession({ title: "Archive Character Base", clearLog: true });
          pushLog("Archiving image…");
          try {
            await apiNewCharacterArchiveBase({ relPath: rel });
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

    beginSession({
      title: "Generating character",
      clearLog: true,
    });
    await Promise.resolve();
    pushLog("Starting generation (live logs from image service)…");
    try {
      await apiNewCharacterGenerateStream({
        prompt: user,
        onLogLine: (line) => pushLog(line),
      });
    } catch (err) {
      failSession(err, "Character generation failed.");
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
      await apiNewCharacterAppendUpload({ file });
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
      const { relPaths } = await apiNewCharacterArchiveList();
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
      showError({ message: "Please enter a character name." });
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
        title: "Save character",
        message:
          "Saving will delete all other character designs not currently on preview.",
        confirmText: "Save",
      });
      if (!ok) return;
    }

    const rel = paths[Math.min(index, paths.length - 1)];
    beginSession({ title: "Saving character", clearLog: true });
    pushLog(`Saving as ${nn}…`);
    try {
      await apiNewCharacterFinalize({ characterName: nn, relPath: rel });
      endSession();
      setCloseupWizardCharKey(nn);
      setCloseupWizardOpen(true);
    } catch (e) {
      failSession(e, "Save failed.");
    }
  }

  async function onCancel() {
    if (draftRelPaths.length > 0) {
      const ok = await confirmAction({
        title: "Leave new character",
        message: "Clear all draft images in the workspace and return to the hub?",
        confirmText: "Leave",
      });
      if (!ok) return;
    }
    beginSession({ title: "Leave new character", clearLog: true });
    pushLog("Clearing draft workspace…");
    try {
      await apiNewCharacterDiscard();
      endSession();
      router.push("/hub");
    } catch (e) {
      failSession(e, "Could not clear draft workspace.");
    }
  }

  const previewUrl = previewRelPath
    ? `${assetUrlFromRelPath(previewRelPath)}?v=${imgBust}`
    : "";

  return (
    <div style={{ minHeight: "100vh" }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center", paddingLeft: 20, marginBottom: 10 }}>
        <HfTokenSettingsButton />
        <SquareIconButton
          onClick={() => router.push("/home")}
          aria-label="Home"
          icon={<HomeIcon />}
        />
        <SquareIconButton
          onClick={() => router.push("/hub")}
          aria-label="Back"
          icon={<TriangleIcon direction="left" />}
        />
      </div>

      <div style={{ paddingLeft: 20, paddingRight: 20, maxWidth: 980 }}>
        <div
          style={{
            width: "100%",
            height: 360,
            border: "1px dashed rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "stretch",
            justifyContent: "center",
            marginBottom: draftRelPaths.length >= 1 ? 0 : 16,
            overflow: "hidden",
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
            <ZoomableImage src={previewUrl} fitMaxWidth="100%" fitMaxHeight="360px" />
          ) : (
            <div
              style={{
                opacity: 0.75,
                fontSize: 14,
                alignSelf: "center",
              }}
            >
              No preview
            </div>
          )}
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
            style={{ marginBottom: 16 }}
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
              await apiNewCharacterImportFromArchive({ relPath });
              await refreshDrafts(true);
              setImgBust((b) => b + 1);
            } catch (e) {
              showError({ message: "Could not import from archive.", error: e });
            }
          }}
        />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
          <div style={{ gridColumn: "1 / span 2" }}>
            <div style={{ marginBottom: 6, fontSize: 14, opacity: 0.95 }}>Character name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. MyCharacter (required to save)"
              style={{
                width: "100%",
                padding: "10px 12px",
                border: "1px solid rgba(0,0,0,0.35)",
                background: "transparent",
                color: "inherit",
              }}
            />
          </div>

          <div style={{ gridColumn: "1 / span 2" }}>
            <div style={{ marginBottom: 6, fontSize: 14, opacity: 0.95 }}>
              Generate character via prompt or manually add starting character image
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
                  placeholder="Describe the subject/scene for the base image"
                  rows={3}
                  style={{
                    width: "100%",
                    height: PROMPT_ROW_PX,
                    minHeight: PROMPT_ROW_PX,
                    maxHeight: PROMPT_ROW_PX,
                    padding: "10px 12px",
                    border: "1px solid rgba(0,0,0,0.35)",
                    background: "transparent",
                    color: "inherit",
                    resize: "none",
                    boxSizing: "border-box",
                    font: "inherit",
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
                    border: "1px solid rgba(0,0,0,0.5)",
                    background: "transparent",
                    padding: "8px 12px",
                    cursor: busy ? "not-allowed" : "pointer",
                    marginTop: 8,
                    width: "100%",
                    opacity: busy ? 0.7 : 1,
                  }}
                >
                  {"Generate Character"}
                </button>
              </div>

              <SquareButton
                disabled={busy}
                onClick={() => stagedInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files?.[0] ?? null;
                  void appendImageFile(f);
                }}
                variant="import"
                tone="dark"
                size={PROMPT_ROW_PX}
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-start",
                  padding: 8,
                  fontSize: 11,
                  lineHeight: 1.2,
                  background: "rgba(0,0,0,0.02)",
                }}
                title="Manually add starting character image"
              >
                Add Image from Local
              </SquareButton>

              <SquareButton
                disabled={busy}
                type="button"
                onClick={() => {
                  void openArchivePicker();
                }}
                variant="tile"
                tone="dark"
                size={PROMPT_ROW_PX}
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-start",
                  padding: 8,
                  fontSize: 11,
                  lineHeight: 1.2,
                  background: "rgba(0,0,0,0.02)",
                }}
                title="Browse archived character bases"
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
                {draftRelPaths.length} draft image{draftRelPaths.length === 1 ? "" : "s"} in
                workspace
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
                  border: "1px solid rgba(0,0,0,0.5)",
                  background: "transparent",
                  padding: "8px 12px",
                  cursor: "pointer",
                }}
              >
                Save
              </button>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  void onCancel();
                }}
                style={{
                  borderRadius: 0,
                  border: "1px solid rgba(0,0,0,0.5)",
                  background: "transparent",
                  padding: "8px 12px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />
      <BaseCloseupWizardModal
        open={closeupWizardOpen}
        charKey={closeupWizardCharKey}
        title="Generate Closeup Angles"
        onClose={async () => {
          const ck = closeupWizardCharKey.trim();
          if (ck) {
            try {
              await apiHubDelete(ck);
            } catch (e) {
              showError({
                message: "Could not remove the character after closing the wizard.",
                error: e,
              });
            }
          }
          setCloseupWizardOpen(false);
          await refreshDrafts(false);
        }}
        onDone={async () => {
          setCloseupWizardOpen(false);
          try {
            await apiNewCharacterDiscard();
          } catch {
            /* still go to hub; drafts can be cleared manually */
          }
          router.push("/hub");
        }}
      />
    </div>
  );
}
