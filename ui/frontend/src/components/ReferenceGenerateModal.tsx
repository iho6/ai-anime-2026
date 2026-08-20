"use client";

import React, { useRef, useState } from "react";
import {
  assetUrlFromRelPath,
  type GeneratedReferencePreview,
  type ReferenceMediaKind,
} from "../lib/api";
import { ZoomableImage } from "./ZoomableImage";
import {
  SequenceOutputLengthStepper,
  WAN_VIDEO_FPS,
  WAN_VIDEO_OUTPUT_LENGTHS,
  formatWanVideoLengthHint,
} from "./sequenceOutputLength";

const REF_VIDEO_DEFAULT_LENGTH = 49;

/**
 * Generate-and-save modal for the global Reference library. Mirrors the AI-Edit
 * modal look: a preview area, a prompt box (+ optional width/height), and
 * Generate / Save / Cancel buttons. The page owns the job session; this modal
 * delegates the actual work via ``onGenerate`` / ``onCommit``.
 */
type ReferenceGenerateModalProps = {
  open: boolean;
  busy?: boolean;
  saveLabel?: string | ((preview: GeneratedReferencePreview) => string);
  zIndex?: number;
  onCancel: () => void;
  /** Run Flux2 t2i or Wan T2V; resolve with the preview (or null on failure). */
  onGenerate: (args: {
    kind: ReferenceMediaKind;
    promptText: string;
    width: number;
    height: number;
    length?: number;
  }) => Promise<GeneratedReferencePreview | null>;
  /** Persist or convert the current generated preview. */
  onCommit: (preview: GeneratedReferencePreview) => Promise<void>;
};

export function ReferenceGenerateModal(props: ReferenceGenerateModalProps) {
  if (!props.open) return null;
  return <ReferenceGenerateModalOpen {...props} />;
}

function ReferenceGenerateModalOpen(props: ReferenceGenerateModalProps) {
  const {
    busy = false,
    saveLabel = "Save",
    zIndex = 9997,
    onCancel,
    onGenerate,
    onCommit,
  } = props;

  const [prompt, setPrompt] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [videoLength, setVideoLength] = useState(REF_VIDEO_DEFAULT_LENGTH);
  const [mediaKind, setMediaKind] = useState<ReferenceMediaKind>("image");
  const [preview, setPreview] = useState<GeneratedReferencePreview | null>(null);
  const requestIdRef = useRef(0);

  const canGenerate = !busy && prompt.trim().length > 0;
  const canSave = !busy && preview !== null;
  const resolvedSaveLabel = preview
    ? typeof saveLabel === "function"
      ? saveLabel(preview)
      : saveLabel
    : typeof saveLabel === "string"
      ? saveLabel
      : "Save";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
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
          borderRadius: 0,
          border: "1px solid rgba(255,255,255,0.25)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          style={{
            flexShrink: 0,
            color: "white",
            fontWeight: 400,
            padding: "12px 12px 10px",
            borderBottom: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          New Reference
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              flex: 1,
              minHeight: 0,
              width: "100%",
              overflow: "hidden",
              padding: 12,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                flex: 1,
                minHeight: 0,
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {preview?.kind === "image" ? (
                <ZoomableImage
                  src={assetUrlFromRelPath(preview.previewRelPath)}
                  fitMaxWidth="100%"
                  fitMaxHeight="100%"
                />
              ) : preview?.kind === "video" ? (
                <video
                  src={assetUrlFromRelPath(preview.previewRelPath)}
                  controls
                  loop
                  muted
                  playsInline
                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                />
              ) : (
                <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>
                  Generate a reference {mediaKind} to preview it here.
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              flexShrink: 0,
              padding: 12,
              borderTop: "1px solid rgba(255,255,255,0.12)",
              background: "#0b0b0b",
            }}
          >
            <div
              role="radiogroup"
              aria-label="Reference media type"
              style={{ display: "flex", gap: 8, marginBottom: 10 }}
            >
              {(["image", "video"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={mediaKind === kind}
                  disabled={busy}
                  onClick={() => {
                    requestIdRef.current += 1;
                    setMediaKind(kind);
                    setPreview(null);
                  }}
                  className="ui-btn-black"
                  style={{
                    flex: 1,
                    borderColor:
                      mediaKind === kind ? "rgba(130,190,255,0.95)" : undefined,
                    background:
                      mediaKind === kind ? "rgba(80,145,210,0.3)" : undefined,
                    textTransform: "capitalize",
                  }}
                >
                  {kind}
                </button>
              ))}
            </div>
            <textarea
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={`Describe the reference ${mediaKind} to generate`}
              rows={3}
              style={{
                width: "100%",
                boxSizing: "border-box",
                resize: "vertical",
                border: "1px solid rgba(255,255,255,0.2)",
                background: "transparent",
                color: "#ffffff",
                caretColor: "#ffffff",
                fontSize: 14,
                padding: 8,
              }}
            />

            {mediaKind === "image" ? (
              <div
              style={{
                display: "flex",
                gap: 12,
                alignItems: "center",
                marginTop: 8,
                color: "#ddd",
                fontSize: 13,
              }}
              >
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                W
                <input
                  type="number"
                  min={256}
                  max={2048}
                  step={64}
                  value={width}
                  disabled={busy}
                  onChange={(e) => setWidth(Number(e.target.value) || 1024)}
                  style={{
                    width: 72,
                    background: "transparent",
                    color: "#fff",
                    border: "1px solid rgba(255,255,255,0.2)",
                    padding: "4px 6px",
                  }}
                />
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                H
                <input
                  type="number"
                  min={256}
                  max={2048}
                  step={64}
                  value={height}
                  disabled={busy}
                  onChange={(e) => setHeight(Number(e.target.value) || 1024)}
                  style={{
                    width: 72,
                    background: "transparent",
                    color: "#fff",
                    border: "1px solid rgba(255,255,255,0.2)",
                    padding: "4px 6px",
                  }}
                />
              </label>
              </div>
            ) : (
              <div style={{ marginTop: 8, color: "#bbb", fontSize: 13 }}>
                <div style={{ marginBottom: 4 }}>
                  1280×1280 · {WAN_VIDEO_FPS} FPS · {formatWanVideoLengthHint(videoLength)}
                </div>
                <div style={{ color: "#aaa", fontSize: 12, marginBottom: 2 }}>
                  Output length (frames, 4n+1: 25–121)
                </div>
                <SequenceOutputLengthStepper
                  lengths={WAN_VIDEO_OUTPUT_LENGTHS}
                  value={videoLength}
                  onChange={setVideoLength}
                />
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 10,
              }}
            >
              <button
                type="button"
                disabled={!canGenerate}
                className="ui-btn-black"
                style={{
                  cursor: canGenerate ? "pointer" : "not-allowed",
                  opacity: canGenerate ? 1 : 0.6,
                }}
                onClick={(e) => {
                  e.preventDefault();
                  void (async () => {
                    const requestId = ++requestIdRef.current;
                    const kind = mediaKind;
                    const result = await onGenerate({
                      kind,
                      promptText: prompt.trim(),
                      width: kind === "video" ? 1280 : Math.max(64, Math.round(width)),
                      height: kind === "video" ? 1280 : Math.max(64, Math.round(height)),
                      ...(kind === "video" ? { length: videoLength } : {}),
                    });
                    if (
                      result &&
                      result.kind === kind &&
                      requestIdRef.current === requestId
                    ) {
                      setPreview(result);
                    }
                  })();
                }}
              >
                Generate
              </button>
              <button
                type="button"
                disabled={!canSave}
                className="ui-btn-black"
                style={{
                  cursor: canSave ? "pointer" : "not-allowed",
                  opacity: canSave ? 1 : 0.6,
                }}
                onClick={(e) => {
                  e.preventDefault();
                  void (async () => {
                    if (!preview) return;
                    await onCommit(preview);
                  })();
                }}
              >
                {resolvedSaveLabel}
              </button>
              <button
                type="button"
                className="ui-btn-black"
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  onCancel();
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
