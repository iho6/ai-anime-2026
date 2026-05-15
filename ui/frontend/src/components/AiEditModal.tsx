"use client";

import React, { useEffect, useState } from "react";
import { ZoomableImage } from "./ZoomableImage";

export function AiEditModal(props: {
  open: boolean;
  title?: string;
  imageSrc: string;
  busy?: boolean;
  placeholder?: string;
  actionLabel?: string;
  onCancel: () => void;
  onGenerate: (promptText: string) => void | Promise<void>;
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

  useEffect(() => {
    if (!open) return;
    setPrompt("");
  }, [open]);

  if (!open) return null;

  const canGenerate = !busy && prompt.trim().length > 0;

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
          }}
        >
          {title}
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
                  void onGenerate(prompt.trim());
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

