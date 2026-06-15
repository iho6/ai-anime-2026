"use client";

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TimelineText } from "../../lib/api";
import { TIMELINE_FONTS, ensureTimelineFontLoaded, timelineFontCssFamily } from "../../lib/timelineFonts";
import type { TextStyleModal } from "./TextStyleBar";

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

export function TextPickerModals(props: {
  open: TextStyleModal;
  text: TimelineText;
  onClose: () => void;
  onChange: (patch: Partial<TimelineText>) => void;
}) {
  const { open, text, onChange, onClose } = props;
  const [query, setQuery] = useState("");
  const [sizeVal, setSizeVal] = useState(text.fontSize);
  const [hex, setHex] = useState(text.color);

  useEffect(() => {
    if (open === "size") setSizeVal(text.fontSize);
    if (open === "color") setHex(text.color);
  }, [open, text.fontSize, text.color]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const filtered = TIMELINE_FONTS.filter(
    (f) =>
      !query ||
      f.label.toLowerCase().includes(query.toLowerCase()) ||
      f.category.toLowerCase().includes(query.toLowerCase())
  );

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 20000,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
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
          maxHeight: "70vh",
          overflow: "auto",
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {open === "font" ? (
          <>
            <div style={{ fontSize: 14, marginBottom: 10, color: "#eee" }}>Font</div>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              style={{ width: "100%", marginBottom: 10, padding: "6px 8px", fontSize: 13 }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {filtered.map((f) => (
                <FontRow
                  key={f.id}
                  familyId={f.id}
                  label={f.label}
                  selected={text.fontFamilyId === f.id}
                  onPick={() => {
                    onChange({ fontFamilyId: f.id });
                    onClose();
                  }}
                />
              ))}
            </div>
          </>
        ) : null}

        {open === "size" ? (
          <>
            <div style={{ fontSize: 14, marginBottom: 10, color: "#eee" }}>Size</div>
            <input
              type="range"
              min={12}
              max={200}
              value={sizeVal}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSizeVal(v);
                onChange({ fontSize: v });
              }}
              style={{ width: "100%" }}
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              {[24, 36, 48, 64, 96, 120].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    setSizeVal(n);
                    onChange({ fontSize: n });
                  }}
                  style={presetBtn(sizeVal === n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={8}
              max={300}
              value={sizeVal}
              onChange={(e) => {
                const v = Math.max(8, Math.min(300, Number(e.target.value) || 48));
                setSizeVal(v);
                onChange({ fontSize: v });
              }}
              style={{ marginTop: 10, width: "100%", padding: "6px 8px" }}
            />
            <button type="button" onClick={onClose} style={{ ...presetBtn(true), marginTop: 12, width: "100%" }}>
              Done
            </button>
          </>
        ) : null}

        {open === "color" ? (
          <>
            <div style={{ fontSize: 14, marginBottom: 10, color: "#eee" }}>Color</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setHex(c);
                    onChange({ color: c });
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
              onBlur={() => onChange({ color: hex })}
              placeholder="#ffffff"
              style={{ width: "100%", padding: "6px 8px", marginBottom: 10 }}
            />
            <button type="button" onClick={onClose} style={{ ...presetBtn(true), width: "100%" }}>
              Done
            </button>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

function FontRow(props: {
  familyId: string;
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  const [fam, setFam] = useState("sans-serif");
  useEffect(() => {
    void ensureTimelineFontLoaded(props.familyId, 400).then(setFam);
  }, [props.familyId]);

  return (
    <button
      type="button"
      onClick={props.onPick}
      style={{
        padding: "8px 10px",
        textAlign: "left",
        background: props.selected ? "rgba(255,255,255,0.12)" : "transparent",
        border: props.selected ? "1px solid rgba(255,255,255,0.9)" : "1px solid rgba(255,255,255,0.1)",
        color: "#eee",
        cursor: "pointer",
        fontFamily: fam || timelineFontCssFamily(props.familyId),
        fontSize: 16,
      }}
    >
      {props.label}
    </button>
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
