"use client";

import type { SequencePreviewAspect } from "../../lib/api";
import { aspectIconBoxSize } from "./captureViewportLayout";

type Props = {
  w: number;
  h: number;
  label: string;
  selected: boolean;
  onSelect: () => void;
};

export function CaptureAspectButton({ w, h, label, selected, onSelect }: Props) {
  const icon = aspectIconBoxSize(w, h, 14);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        width: 28,
        height: 28,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        borderRadius: 0,
        background: "transparent",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          width: icon.width,
          height: icon.height,
          boxSizing: "border-box",
          borderRadius: 0,
          border: "1px solid",
          borderColor: selected ? "#fff" : "rgba(255,255,255,0.35)",
          background: selected ? "rgba(255,255,255,0.12)" : "transparent",
        }}
      />
    </button>
  );
}
