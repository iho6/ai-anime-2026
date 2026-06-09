"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  apiHubCharacters,
  apiPoseGallerySplit,
  apiExpressionGallerySplit,
  apiSequenceFolderNames,
  apiSequenceGet,
  assetUrlFromRelPath,
  runDetailWsJob,
  type PoseReference,
  type SequenceManifest,
} from "../lib/api";
import { CollapsibleGallerySection } from "./CollapsibleGallerySection";
import { SquareButton } from "./SquareButton";
import { SquareIconButton, TriangleIcon } from "./IconPrimitives";
import { ReferencePicker } from "./ReferencePicker";
import { MotionRefGenModal } from "./MotionRefGenModal";
import type { SharedLogStreamHandle } from "./SharedLogStream";
import { ConnectedJobRunModal } from "./ConnectedJobRunModal";
import { useJobRunSession } from "../hooks/useJobRunSession";

type CharIcon = { key: string; label: string; coverRelPath: string };
type SectionData = {
  poseImages: { relPath: string }[];
  exprImages: { relPath: string }[];
  sequences: { name: string; coverRelPath: string }[];
};

export function TimelineCharacterPicker(props: {
  open: boolean;
  /** Pre-select a character key — skips stage 1, opens directly to galleries. */
  initialKey?: string | null;
  charKey?: string;  // alias for initialKey
  onPickImage: (charKey: string, relPath: string) => void;
  onPickSequence: (charKey: string, sequenceName: string) => void;
  onCancel: () => void;
}) {
  const { open, onPickImage, onPickSequence, onCancel } = props;
  const initialKey = props.initialKey ?? props.charKey ?? null;

  const [icons, setIcons] = useState<CharIcon[]>([]);
  const [iconsError, setIconsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sectionData, setSectionData] = useState<SectionData | null>(null);
  const [sectionsError, setSectionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [seqOpen, setSeqOpen] = useState(true);

  // Image right-click context menu (shows "New Pose" option)
  const [imgCtxMenu, setImgCtxMenu] = useState<{
    relPath: string;
    x: number;
    y: number;
  } | null>(null);

  // New Pose panel state
  const [newPosePanel, setNewPosePanel] = useState<{ charKey: string; baseRelPath: string } | null>(null);
  const [newPosePrompt, setNewPosePrompt] = useState("");
  const [newPoseRef, setNewPoseRef] = useState<PoseReference | null>(null);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [motionRefOpen, setMotionRefOpen] = useState(false);

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: poseBusy,
    beginSession,
    endSession,
    failSession,
    pushLog,
    modalProps: poseJobModalProps,
  } = useJobRunSession(logRef);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setSectionData(null);
    setSectionsError(null);
    setNewPosePanel(null);
    setNewPosePrompt("");
    setNewPoseRef(null);
    setImgCtxMenu(null);
    setSelectedKey(initialKey ?? null);

    if (!initialKey) {
      setLoading(true);
      setIcons([]);
      setIconsError(null);
      apiHubCharacters()
        .then((items) =>
          setIcons(items.map((it) => ({ key: it.charKey, label: it.charKey, coverRelPath: it.coverRelPath })))
        )
        .catch((e) => setIconsError(String(e?.message ?? e)))
        .finally(() => setLoading(false));
    }
  }, [open, initialKey]);

  const loadSections = useCallback(async (charKey: string) => {
    setLoading(true);
    setSectionData(null);
    setSectionsError(null);
    try {
      const [poses, exprs, seqNames] = await Promise.all([
        apiPoseGallerySplit(charKey),
        apiExpressionGallerySplit(charKey),
        apiSequenceFolderNames(charKey),
      ]);

      let sequences: { name: string; coverRelPath: string }[] = [];
      if (seqNames.length > 0) {
        const manifests = await Promise.all(
          seqNames.map((name) =>
            apiSequenceGet(charKey, name).catch((): SequenceManifest => ({ version: 1, fps: 24, gallery: [], frames: [] }))
          )
        );
        sequences = seqNames
          .map((name, i) => ({
            name,
            coverRelPath:
              manifests[i]?.frames?.[0]?.relPath ??
              manifests[i]?.gallery?.[0]?.relPath ?? "",
          }))
          .filter((s) => s.coverRelPath);
      }

      setSectionData({
        poseImages: (poses.visible ?? []).map((x) => ({ relPath: x.relPath })),
        exprImages: (exprs.visible ?? []).map((x) => ({ relPath: x.relPath })),
        sequences,
      });
    } catch (e) {
      setSectionsError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !selectedKey) return;
    void loadSections(selectedKey);
  }, [open, selectedKey, loadSections]);

  async function runNewPose() {
    if (!newPosePanel || !newPosePrompt.trim()) return;
    const { charKey, baseRelPath } = newPosePanel;
    beginSession({ title: "Generating pose", clearLog: true });
    await Promise.resolve();
    pushLog("Starting pose generation…");
    try {
      const done = await runDetailWsJob<{ firstPoseKey: string | null; lastInputRelPath: string }>({
        charKey,
        pathSuffix: "/pose/ws",
        payload: {
          job: "generate_prompts",
          baseRelPath,
          prompts: [`Edit the subject to ${newPosePrompt.trim()}, keep identity and clothing coherent unless impossible.`],
          ...(newPoseRef?.keypointRelPath ? { keypointRelPath: newPoseRef.keypointRelPath } : {}),
        },
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok) throw new Error(done.error ?? "Pose generation failed.");
      pushLog("Done. Refreshing gallery…");
      endSession();
      setNewPosePanel(null);
      setNewPosePrompt("");
      void loadSections(charKey);
    } catch (e) {
      failSession(e, "Pose generation failed.");
    }
  }

  if (!open) return null;

  const showBackButton = Boolean(selectedKey) && !initialKey;

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          zIndex: 9998,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
        }}
        onMouseDown={(e) => { e.preventDefault(); onCancel(); }}
        // Close image context menu on click outside
        onClick={() => setImgCtxMenu(null)}
      >
        <div
          style={{
            width: 720,
            maxWidth: "100%",
            height: "min(92vh, 880px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "#0b0b0b",
            color: "white",
            border: "1px solid rgba(255,255,255,0.25)",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setImgCtxMenu(null); }}
        >
          {/* Title bar */}
          <div style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontWeight: 400,
            padding: "10px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.15)",
          }}>
            {showBackButton && (
              <SquareIconButton aria-label="Back" title="Back" icon={<TriangleIcon direction="left" />} onClick={() => setSelectedKey(null)} />
            )}
            <span>Add Character</span>
          </div>

          {/* Body */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12, position: "relative" }}>
            {/* Stage 1: character icons */}
            {!selectedKey && (
              <>
                {iconsError && <div style={{ color: "#ff8080", fontSize: 13 }}>{iconsError}</div>}
                {loading && icons.length === 0 && <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
                  {icons.map((ic) => (
                    <button key={ic.key} type="button" onClick={() => setSelectedKey(ic.key)}
                      style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "inherit", cursor: "pointer" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={assetUrlFromRelPath(ic.coverRelPath)} alt="" style={{ width: "100%", aspectRatio: "1/1", objectFit: "contain", display: "block" }} />
                      <span style={{ fontSize: 12, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ic.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Stage 2: pose / expression / sequence sections */}
            {selectedKey && (
              <>
                {sectionsError && <div style={{ color: "#ff8080", fontSize: 13 }}>{sectionsError}</div>}
                {loading && !sectionData && <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>}
                {sectionData && (
                  <>
                    <CollapsibleGallerySection
                      title="Pose"
                      images={sectionData.poseImages}
                      onPick={(relPath) => onPickImage(selectedKey, relPath)}
                      onRightClick={(relPath, x, y) => {
                        setImgCtxMenu({ relPath, x, y });
                      }}
                    />
                    <CollapsibleGallerySection
                      title="Expression"
                      images={sectionData.exprImages}
                      onPick={(relPath) => onPickImage(selectedKey, relPath)}
                      onRightClick={(relPath, x, y) => {
                        setImgCtxMenu({ relPath, x, y });
                      }}
                    />
                    {/* Sequence section — collapsible */}
                    {sectionData.sequences.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <button
                          type="button"
                          onClick={() => setSeqOpen((o) => !o)}
                          style={{ display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: "4px 0", width: "100%", textAlign: "left", fontSize: 14 }}
                        >
                          <span style={{ display: "inline-flex", transform: seqOpen ? "none" : "rotate(-90deg)", transition: "transform 120ms ease" }}>
                            <TriangleIcon direction="down" />
                          </span>
                          <span>Sequence</span>
                          <span style={{ opacity: 0.55, fontSize: 12 }}>({sectionData.sequences.length})</span>
                        </button>
                        {seqOpen && (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, paddingTop: 6 }}>
                            {sectionData.sequences.map((seq) => (
                              <button key={seq.name} type="button" onClick={() => onPickSequence(selectedKey, seq.name)}
                                title={seq.name}
                                style={{ width: "100%", aspectRatio: "1/1", padding: 4, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", cursor: "pointer" }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={assetUrlFromRelPath(seq.coverRelPath)} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
                                <div style={{ fontSize: 10, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>{seq.name}</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* New Pose inline panel */}
                {newPosePanel && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(10,10,10,0.97)",
                      zIndex: 10,
                      display: "flex",
                      flexDirection: "column",
                      padding: 16,
                      gap: 12,
                      overflowY: "auto",
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <button type="button" onClick={() => setNewPosePanel(null)}
                        style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.25)", color: "#aaa", padding: "4px 10px", cursor: "pointer", font: "inherit", fontSize: 12 }}>
                        ← Back
                      </button>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>New Pose</span>
                    </div>

                    {/* Starting image + reference row */}
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      {/* Starting image thumbnail */}
                      <div style={{ flexShrink: 0 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={assetUrlFromRelPath(newPosePanel.baseRelPath)}
                          alt="Starting image"
                          style={{ width: 100, height: 100, objectFit: "contain", border: "1px solid rgba(255,255,255,0.2)" }}
                        />
                        <div style={{ fontSize: 10, color: "#666", marginTop: 4, textAlign: "center" }}>Starting image</div>
                      </div>

                      {/* Reference square button */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <SquareButton
                          variant="import"
                          tone="light"
                          size={100}
                          disabled={poseBusy}
                          onClick={() => setRefPickerOpen(true)}
                          style={{ color: "inherit" }}
                          title="Add a pose reference (optional)"
                        >
                          {newPoseRef ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={assetUrlFromRelPath(newPoseRef.keypointRelPath)}
                              alt=""
                              style={{ width: "100%", height: "100%", objectFit: "contain" }}
                            />
                          ) : (
                            <>
                              Add
                              <br />
                              Reference
                              <br />
                              (optional)
                            </>
                          )}
                        </SquareButton>
                        {newPoseRef && (
                          <button
                            type="button"
                            onClick={() => setNewPoseRef(null)}
                            style={{ background: "transparent", border: "none", color: "#888", cursor: "pointer", fontSize: 11, textAlign: "center" }}
                          >
                            Clear ref
                          </button>
                        )}
                      </div>
                    </div>

                    <textarea
                      value={newPosePrompt}
                      disabled={poseBusy}
                      onChange={(e) => setNewPosePrompt(e.target.value)}
                      placeholder="Describe the new pose (e.g. 'arms raised', 'sitting cross-legged')"
                      rows={3}
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        background: "transparent",
                        border: "1px solid rgba(255,255,255,0.25)",
                        color: "#eee",
                        padding: 8,
                        font: "inherit",
                        fontSize: 13,
                        resize: "vertical",
                      }}
                    />

                    <button
                      type="button"
                      onClick={() => void runNewPose()}
                      disabled={poseBusy || !newPosePrompt.trim()}
                      style={{
                        border: "1px solid rgba(255,255,255,0.4)",
                        background: poseBusy || !newPosePrompt.trim() ? "rgba(255,255,255,0.05)" : "rgba(100,200,100,0.12)",
                        color: "#eee",
                        padding: "8px 16px",
                        cursor: poseBusy || !newPosePrompt.trim() ? "not-allowed" : "pointer",
                        font: "inherit",
                        fontWeight: 600,
                      }}
                    >
                      Generate Pose
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", padding: 12, borderTop: "1px solid rgba(255,255,255,0.15)" }}>
            <button type="button" onClick={onCancel} className="ui-btn-black">Cancel</button>
          </div>
        </div>
      </div>

      {/* Image right-click context menu */}
      {imgCtxMenu && (
        <div
          style={{
            position: "fixed",
            top: imgCtxMenu.y,
            left: imgCtxMenu.x,
            background: "#1e1e1e",
            border: "1px solid rgba(255,255,255,0.2)",
            zIndex: 10100,
            minWidth: 130,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              const { relPath } = imgCtxMenu;
              setImgCtxMenu(null);
              setNewPosePanel({ charKey: selectedKey!, baseRelPath: relPath });
              setNewPosePrompt("");
              setNewPoseRef(null);
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 14px",
              background: "transparent",
              color: "#eee",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            New Pose
          </button>
        </div>
      )}

      {/* Reference picker — includes Motion Ref Gen (KiMoD) option */}
      <ReferencePicker
        open={refPickerOpen}
        charKey={newPosePanel?.charKey ?? ""}
        busy={poseBusy}
        onCancel={() => setRefPickerOpen(false)}
        onUseSelected={(sel) => {
          if (sel.singles[0]) setNewPoseRef(sel.singles[0]);
          setRefPickerOpen(false);
        }}
        onPickNew={() => setRefPickerOpen(false)}
        onGenerateBase={() => setRefPickerOpen(false)}
        onOpenMotionRef={() => {
          setRefPickerOpen(false);
          setMotionRefOpen(true);
        }}
      />

      {/* Motion Ref Gen modal (KiMoD) */}
      <MotionRefGenModal
        open={motionRefOpen}
        charKey={newPosePanel?.charKey ?? ""}
        onBack={() => { setMotionRefOpen(false); setRefPickerOpen(true); }}
        onClose={() => setMotionRefOpen(false)}
        onKeypointsMade={(ref) => {
          setNewPoseRef(ref);
          setMotionRefOpen(false);
        }}
      />

      <ConnectedJobRunModal modal={poseJobModalProps} logRef={logRef} />
    </>
  );
}
