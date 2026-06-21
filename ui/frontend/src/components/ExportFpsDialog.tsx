"use client";

import React, { useEffect, useState } from "react";

const modalBtnSecondary: React.CSSProperties = {
  borderRadius: 0,
  border: "1px solid rgba(255,255,255,0.35)",
  background: "transparent",
  color: "#eee",
  padding: "6px 14px",
  cursor: "pointer",
};

const modalBtnPrimary: React.CSSProperties = {
  ...modalBtnSecondary,
  background: "rgba(80,120,200,0.35)",
};

export function ExportFpsDialog(props: {
  open: boolean;
  title?: string;
  defaultFps?: number;
  zIndex?: number;
  onCancel: () => void;
  onConfirm: (fps: number) => void;
}) {
  const {
    open,
    title = "Export frame rate",
    defaultFps = 24,
    zIndex = 6000,
    onCancel,
    onConfirm,
  } = props;
  const [fpsText, setFpsText] = useState(String(defaultFps));

  useEffect(() => {
    if (open) setFpsText(String(defaultFps));
  }, [open, defaultFps]);

  if (!open) return null;

  const parsed = Number(fpsText);
  const valid = Number.isFinite(parsed) && parsed >= 1 && parsed <= 120;

  function stopClick(e: React.MouseEvent) {
    e.stopPropagation();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
        e.stopPropagation();
      }}
    >
      <div
        style={{
          background: "#0b0b0b",
          color: "#eee",
          padding: 14,
          maxWidth: 360,
          width: "100%",
          border: "1px solid rgba(255,255,255,0.22)",
        }}
        onClick={stopClick}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <label style={{ display: "block", fontSize: 12, marginBottom: 6, opacity: 0.85 }}>
          Frames per second (1–120)
        </label>
        <input
          type="number"
          min={1}
          max={120}
          step={1}
          value={fpsText}
          onChange={(e) => setFpsText(e.target.value)}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "rgba(0,0,0,0.35)",
            color: "inherit",
            border: "1px solid rgba(255,255,255,0.25)",
            padding: 8,
          }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button
            type="button"
            style={modalBtnSecondary}
            onClick={(e) => {
              stopClick(e);
              onCancel();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            style={valid ? modalBtnPrimary : { ...modalBtnPrimary, opacity: 0.45, cursor: "not-allowed" }}
            disabled={!valid}
            onClick={(e) => {
              stopClick(e);
              onConfirm(parsed);
            }}
          >
            Download
          </button>
        </div>
      </div>
    </div>
  );
}
