"use client";

import React from "react";
import { CloseIcon, SquareIconButton } from "./IconPrimitives";

export type AppErrorPayload = {
  title: string;
  message: string;
  details?: string;
};

export function AppErrorModal(props: {
  error: AppErrorPayload | null;
  onClose: () => void;
}) {
  const { error, onClose } = props;
  if (!error) return null;

  return (
    <div
      className="app-error-modal-backdrop"
      onMouseDown={onClose}
    >
      <div
        className="app-error-modal-card"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontWeight: 400 }}>{error.title}</div>
          <SquareIconButton
            aria-label="Close error"
            title="Close"
            icon={<CloseIcon />}
            tone="light"
            onClick={onClose}
            style={{
              color: "#eee",
              borderColor: "rgba(238,238,238,0.9)",
              background: "rgba(238,238,238,0.15)",
            }}
          />
        </div>

        <div style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{error.message}</div>

        {error.details ? (
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", opacity: 0.9 }}>Details</summary>
            <pre
              className="app-error-modal-details"
            >
              {error.details}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

