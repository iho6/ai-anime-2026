"use client";

import React from "react";
import { CloseIcon, SquareIconButton } from "./IconPrimitives";
import { JobQuadSpinner } from "./JobQuadSpinner";
import type { JobRunSessionOutcome } from "../hooks/useJobRunSession";

function statusLine(
  running: boolean,
  sessionOutcome: JobRunSessionOutcome,
  runningStatus: string
): string {
  if (running) return runningStatus;
  if (sessionOutcome === "error") return "Error.";
  if (sessionOutcome === "success") return "Done.";
  return "Finished.";
}

export function JobRunModal(props: {
  open: boolean;
  title: string;
  running: boolean;
  runningStatus: string;
  sessionOutcome: JobRunSessionOutcome;
  onRequestClose: () => void;
  children: React.ReactNode;
}) {
  const { open, title, running, runningStatus, onRequestClose, children, sessionOutcome } = props;
  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        zIndex: 10050,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        // Not closable while running (Option A). Backdrop does nothing.
        e.preventDefault();
      }}
    >
      <div
        data-native-clipboard-shortcuts
        style={{
          width: 760,
          maxWidth: "100%",
          maxHeight: "88vh",
          overflow: "auto",
          background: "#0b0b0b",
          color: "#eee",
          borderRadius: 0,
          padding: 14,
          border: "1px solid rgba(255,255,255,0.22)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontWeight: 400 }}>{title}</div>
          <SquareIconButton
            disabled={running}
            onClick={() => {
              if (running) return;
              onRequestClose();
            }}
            title={running ? "Running…" : "Close"}
            aria-label="Close"
            icon={<CloseIcon />}
            tone="light"
            style={{
              color: "#eee",
              borderColor: "rgba(238,238,238,0.9)",
              background: "rgba(238,238,238,0.15)",
              cursor: running ? "not-allowed" : "pointer",
              opacity: running ? 0.6 : 1,
            }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, marginBottom: 10 }}>
          <JobQuadSpinner running={running} />
          <div style={{ fontSize: 14, opacity: 0.95 }}>
            {statusLine(running, sessionOutcome, runningStatus)}
          </div>
        </div>

        {children}
      </div>
    </div>
  );
}
