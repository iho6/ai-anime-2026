"use client";

import React, { useEffect, useRef } from "react";
import type { GeometryTemplate } from "../../lib/api";

const SHAPES: { id: GeometryTemplate; label: string; icon: string }[] = [
  { id: "rect", label: "Rect", icon: "▢" },
  { id: "ellipse", label: "Ellipse", icon: "○" },
  { id: "line", label: "Line", icon: "─" },
  { id: "polygon", label: "Polygon", icon: "△" },
];

export function GeometryShapePicker(props: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  selected: GeometryTemplate | null;
  onSelect: (template: GeometryTemplate) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const { open, anchorRef, selected, onSelect, onAdd, onClose } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const rect = anchorRef.current?.getBoundingClientRect();
  const top = rect ? rect.bottom + 6 : 0;
  const left = rect ? rect.left : 0;

  return (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        top,
        left,
        zIndex: 10000,
        background: "#1a1a1a",
        border: "1px solid rgba(255,255,255,0.25)",
        borderRadius: 4,
        padding: 10,
        minWidth: 200,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ fontSize: 11, color: "#aaa", marginBottom: 8 }}>Basic shapes</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            style={{
              padding: "8px 10px",
              background: selected === s.id ? "rgba(255,209,102,0.2)" : "rgba(255,255,255,0.06)",
              border:
                selected === s.id
                  ? "1px solid #ffd166"
                  : "1px solid rgba(255,255,255,0.15)",
              color: "#eee",
              cursor: "pointer",
              fontSize: 13,
              textAlign: "left",
            }}
          >
            <span style={{ marginRight: 6 }}>{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled={!selected}
        onClick={onAdd}
        style={{
          marginTop: 10,
          width: "100%",
          padding: "8px 12px",
          background: selected ? "#ffd166" : "rgba(255,255,255,0.08)",
          color: selected ? "#111" : "#666",
          border: "none",
          cursor: selected ? "pointer" : "not-allowed",
          fontWeight: 600,
          fontSize: 13,
        }}
      >
        Add
      </button>
    </div>
  );
}
