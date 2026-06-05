"use client";

import React, { useEffect, useState } from "react";
import { assetUrlFromRelPath } from "../lib/api";
import { ZoomableImage } from "./ZoomableImage";

/**
 * Generate-and-save modal for the global Reference library. Mirrors the AI-Edit
 * modal look: a preview area, a prompt box (+ optional width/height), and
 * Generate / Save / Cancel buttons. The page owns the job session; this modal
 * delegates the actual work via ``onGenerate`` / ``onCommit``.
 */
export function ReferenceGenerateModal(props: {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  /** Run Flux2 t2i; resolve with the preview rel path (or null on failure). */
  onGenerate: (args: {
    promptText: string;
    width: number;
    height: number;
  }) => Promise<string | null>;
  /** Persist the current preview into the Image gallery. */
  onCommit: (previewRelPath: string) => Promise<void>;
}) {
  const { open, busy = false, onCancel, onGenerate, onCommit } = props;

  const [prompt, setPrompt] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [previewRel, setPreviewRel] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setWidth(1024);
    setHeight(1024);
    setPreviewRel("");
  }, [open]);

  if (!open) return null;

  const canGenerate = !busy && prompt.trim().length > 0;
  const canSave = !busy && previewRel.length > 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9997,
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
              {previewRel ? (
                <ZoomableImage
                  src={assetUrlFromRelPath(previewRel)}
                  fitMaxWidth="100%"
                  fitMaxHeight="100%"
                />
              ) : (
                <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14 }}>
                  Generate a reference image to preview it here.
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
            <textarea
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the reference image to generate"
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
                    const rel = await onGenerate({
                      promptText: prompt.trim(),
                      width: Math.max(64, Math.round(width)),
                      height: Math.max(64, Math.round(height)),
                    });
                    if (rel) setPreviewRel(rel);
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
                    await onCommit(previewRel);
                    setPreviewRel("");
                  })();
                }}
              >
                Save
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
