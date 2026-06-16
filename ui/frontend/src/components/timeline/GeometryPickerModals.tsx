"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TimelineGeometry } from "../../lib/api";
import type { GeometryStyleModal } from "./GeometryStyleBar";

const SWATCHES = [
  "#ffffff",
  "#000000",
  "#ff4444",
  "#44ff44",
  "#4488ff",
  "#ffd166",
  "#ff88cc",
  "#88ffff",
];

export function GeometryPickerModals(props: {
  open: GeometryStyleModal;
  geometry: TimelineGeometry;
  onClose: () => void;
  onChange: (patch: Partial<TimelineGeometry>) => void;
}) {
  const { open, geometry, onChange, onClose } = props;
  const fill = geometry.fill ?? "#ffffff";
  const strokeColor = geometry.stroke?.color ?? "#000000";
  const strokeWidth = geometry.stroke?.width ?? 4;
  const [hex, setHex] = useState(open === "fill" ? fill : strokeColor);
  const [widthVal, setWidthVal] = useState(strokeWidth);
  const openedAtRef = useRef(0);

  useEffect(() => {
    if (open) openedAtRef.current = Date.now();
  }, [open]);

  useEffect(() => {
    if (open === "fill") setHex(fill);
    if (open === "stroke") setHex(strokeColor);
    if (open === "strokeWidth") setWidthVal(strokeWidth);
  }, [open, fill, strokeColor, strokeWidth]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      data-geometry-picker-modal
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 20000,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (Date.now() - openedAtRef.current < 100) return;
        onClose();
      }}
    >
      <div
        style={{
          background: "#1a1a1a",
          border: "1px solid rgba(255,255,255,0.25)",
          borderRadius: 0,
          padding: 16,
          minWidth: 280,
          maxWidth: 420,
        }}
      >
        {open === "fill" || open === "stroke" ? (
          <>
            <div style={{ fontSize: 14, marginBottom: 10, color: "#eee" }}>
              {open === "fill" ? "Fill color" : "Stroke color"}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setHex(c);
                    if (open === "fill") {
                      onChange({ fill: c });
                    } else {
                      onChange({ stroke: { color: c, width: strokeWidth } });
                    }
                  }}
                  style={{
                    width: 32,
                    height: 32,
                    background: c,
                    border: hex === c ? "2px solid rgba(255,255,255,0.9)" : "1px solid #444",
                    cursor: "pointer",
                  }}
                />
              ))}
            </div>
            <input
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              onBlur={() => {
                if (open === "fill") {
                  onChange({ fill: hex });
                } else {
                  onChange({ stroke: { color: hex, width: strokeWidth } });
                }
              }}
              placeholder="#ffffff"
              style={{ width: "100%", padding: "6px 8px", marginBottom: 10 }}
            />
            <button type="button" onClick={onClose} style={{ ...presetBtn(true), width: "100%" }}>
              Done
            </button>
          </>
        ) : null}

        {open === "strokeWidth" ? (
          <>
            <div style={{ fontSize: 14, marginBottom: 10, color: "#eee" }}>Stroke width</div>
            <input
              type="range"
              min={1}
              max={40}
              value={widthVal}
              onChange={(e) => {
                const v = Number(e.target.value);
                setWidthVal(v);
                onChange({ stroke: { color: strokeColor, width: v } });
              }}
              style={{ width: "100%" }}
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              {[2, 4, 8, 12, 16, 24].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    setWidthVal(n);
                    onChange({ stroke: { color: strokeColor, width: n } });
                  }}
                  style={presetBtn(widthVal === n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={1}
              max={80}
              value={widthVal}
              onChange={(e) => {
                const v = Math.max(1, Math.min(80, Number(e.target.value) || 4));
                setWidthVal(v);
                onChange({ stroke: { color: strokeColor, width: v } });
              }}
              style={{ marginTop: 10, width: "100%", padding: "6px 8px" }}
            />
            <button type="button" onClick={onClose} style={{ ...presetBtn(true), marginTop: 12, width: "100%" }}>
              Done
            </button>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

function presetBtn(active: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: active ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.08)",
    color: active ? "#fff" : "#eee",
    border: active ? "1px solid rgba(255,255,255,0.9)" : "1px solid rgba(255,255,255,0.2)",
    cursor: "pointer",
    fontSize: 12,
    borderRadius: 0,
  };
}
