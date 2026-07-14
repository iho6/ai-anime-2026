"use client";

import React from "react";
import type { SequenceWorkspaceShellProps } from "./types";

export function SequenceWorkspaceShell({
  open = true,
  title,
  children,
  onClose,
  zIndex = 10030,
  closeLabel = "Close",
}: SequenceWorkspaceShellProps) {
  if (!open) return null;

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
      onMouseDown={onClose}
    >
      <div
        style={{
          background: "#fff",
          border: "1px solid rgba(0,0,0,0.4)",
          borderRadius: 0,
          padding: 14,
          maxWidth: "min(1100px, 96vw)",
          maxHeight: "92vh",
          overflow: "auto",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <div>{title}</div>
          <button
            type="button"
            onClick={onClose}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(0,0,0,0.5)",
              background: "transparent",
              padding: "4px 12px",
              cursor: "pointer",
            }}
          >
            {closeLabel}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
