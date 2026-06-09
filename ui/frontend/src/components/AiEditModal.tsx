"use client";

import React, { useEffect, useRef, useState } from "react";
import { ZoomableImage, type MaskController } from "./ZoomableImage";

export function AiEditModal(props: {
  open: boolean;
  title?: string;
  imageSrc: string;
  busy?: boolean;
  placeholder?: string;
  actionLabel?: string;
  onCancel: () => void;
  onGenerate: (
    promptText: string,
    maskPngBase64?: string
  ) => void | Promise<void>;
}) {
  const {
    open,
    title = "AI Edit",
    imageSrc,
    busy = false,
    placeholder = "Enter prompt to edit the image",
    actionLabel = "Generate",
    onCancel,
    onGenerate,
  } = props;

  const [prompt, setPrompt] = useState("");
  const [maskOn, setMaskOn] = useState(false);
  const [brushSize, setBrushSize] = useState(40);
  const [hasPaint, setHasPaint] = useState(false);

  const maskControllerRef = useRef<MaskController | null>(null);

  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setMaskOn(false);
    setHasPaint(false);
  }, [open]);

  if (!open) return null;

  const canGenerate = !busy && prompt.trim().length > 0;

  const handleGenerate = () => {
    let maskB64: string | undefined;
    if (maskOn) {
      maskB64 = maskControllerRef.current?.exportBase64() ?? undefined;
    }
    void onGenerate(prompt.trim(), maskB64);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 10040,
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
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{title}</span>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
              color: "rgba(255,255,255,0.85)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={maskOn}
              disabled={busy}
              onChange={(e) => {
                setMaskOn(e.target.checked);
                if (!e.target.checked) setHasPaint(false);
              }}
            />
            Mask edit (Flux.1)
          </label>
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
            <div style={{ flex: 1, minHeight: 0, width: "100%" }}>
              <ZoomableImage
                src={imageSrc}
                fitMaxWidth="100%"
                fitMaxHeight="100%"
                maskMode={maskOn}
                maskBrushSize={brushSize}
                maskDisplayColor="rgba(0,0,0,0.55)"
                maskController={maskControllerRef}
                onMaskPaintedChange={setHasPaint}
              />
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
            {maskOn && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 10,
                  fontSize: 13,
                  color: "rgba(255,255,255,0.85)",
                }}
              >
                <span>Paint the area to edit.</span>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  Brush
                  <input
                    type="range"
                    min={8}
                    max={120}
                    step={1}
                    value={brushSize}
                    disabled={busy}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                  />
                </label>
                <button
                  type="button"
                  className="ui-btn-black"
                  disabled={busy || !hasPaint}
                  style={{
                    cursor: busy || !hasPaint ? "not-allowed" : "pointer",
                    opacity: busy || !hasPaint ? 0.6 : 1,
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    maskControllerRef.current?.clear();
                  }}
                >
                  Clear mask
                </button>
              </div>
            )}

            <textarea
              className="ai-edit-modal__prompt"
              value={prompt}
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={placeholder}
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
                  handleGenerate();
                }}
              >
                {actionLabel}
              </button>
              <button
                type="button"
                className="ui-btn-black"
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
