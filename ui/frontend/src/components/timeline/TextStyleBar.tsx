"use client";

import React from "react";
import type { TimelineClip } from "../../lib/api";
import { findTimelineFont } from "../../lib/timelineFonts";

export type TextStyleModal = "font" | "size" | "color" | null;

export function TextStyleBar(props: {
  clip: TimelineClip;
  rect: { left: number; top: number; width: number; height: number };
  onOpenModal: (modal: TextStyleModal) => void;
}) {
  const { clip, rect, onOpenModal } = props;
  const text = clip.text;
  if (!text) return null;

  const fam = findTimelineFont(text.fontFamilyId);
  const barTop = Math.max(0, rect.top - 32);

  return (
    <div
      style={{
        position: "absolute",
        left: rect.left,
        top: barTop,
        width: rect.width,
        zIndex: 10002,
        display: "flex",
        gap: 4,
        justifyContent: "center",
        pointerEvents: "auto",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => onOpenModal("font")}
        style={barBtn}
        title="Font"
      >
        {fam?.label ?? text.fontFamilyId}
      </button>
      <button type="button" onClick={() => onOpenModal("size")} style={barBtn} title="Size">
        {Math.round(text.fontSize)}
      </button>
      <button
        type="button"
        onClick={() => onOpenModal("color")}
        style={{ ...barBtn, display: "flex", alignItems: "center", gap: 4 }}
        title="Color"
      >
        <span
          style={{
            width: 12,
            height: 12,
            background: text.color,
            border: "1px solid #000",
            display: "inline-block",
          }}
        />
        Color
      </button>
    </div>
  );
}

const barBtn: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  background: "#1a1a1a",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.3)",
  cursor: "pointer",
  borderRadius: 3,
  whiteSpace: "nowrap",
};
