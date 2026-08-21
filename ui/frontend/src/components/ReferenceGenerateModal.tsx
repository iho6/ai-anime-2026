"use client";

import React from "react";
import type { GeneratedReferencePreview, ReferenceMediaKind } from "../lib/api";
import { ReferenceGeneratePanel } from "./ReferenceGeneratePanel";

type ReferenceGenerateModalProps = {
  open: boolean;
  busy?: boolean;
  saveLabel?: string | ((preview: GeneratedReferencePreview) => string);
  zIndex?: number;
  onCancel: () => void;
  onGenerate: (args: {
    kind: ReferenceMediaKind;
    promptText: string;
    width: number;
    height: number;
    length?: number;
  }) => Promise<GeneratedReferencePreview | null>;
  onCommit: (preview: GeneratedReferencePreview) => Promise<void>;
};

/** Overlay wrapper around ReferenceGeneratePanel (global /references page). */
export function ReferenceGenerateModal(props: ReferenceGenerateModalProps) {
  if (!props.open) return null;
  const {
    busy = false,
    saveLabel = "Save",
    zIndex = 9997,
    onCancel,
    onGenerate,
    onCommit,
  } = props;

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
        <ReferenceGeneratePanel
          busy={busy}
          saveLabel={saveLabel}
          onCancel={onCancel}
          onGenerate={onGenerate}
          onCommit={onCommit}
        />
      </div>
    </div>
  );
}
