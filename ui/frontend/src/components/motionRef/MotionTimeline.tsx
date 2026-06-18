"use client";

import React, { useState } from "react";
import type { MotionRefSegment } from "../../lib/api";

/**
 * Multi-segment motion timeline editor.
 * Each row = one text-prompt + duration that maps directly to KiMoD's
 * multi_prompt texts[] / durations[] API.
 */
export function MotionTimeline(props: {
  segments: MotionRefSegment[];
  onChange: (segments: MotionRefSegment[]) => void;
  disabled?: boolean;
}) {
  const { segments, onChange, disabled = false } = props;

  // Transient text for the duration field being edited, so it can be fully cleared
  // (an empty <input type=number> otherwise snaps back to a default and blocks backspace).
  const [durEdit, setDurEdit] = useState<{ i: number; val: string } | null>(null);

  function update(i: number, patch: Partial<MotionRefSegment>) {
    const next = segments.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    onChange(next);
  }

  function add() {
    onChange([...segments, { text: "", duration: 3.0 }]);
  }

  function remove(i: number) {
    onChange(segments.filter((_, idx) => idx !== i));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {segments.map((seg, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <span style={{ fontSize: 11, color: "#666", minWidth: 18, paddingTop: 8 }}>
            {i + 1}.
          </span>
          <textarea
            value={seg.text}
            onChange={(e) => update(i, { text: e.target.value })}
            disabled={disabled}
            placeholder="A person is walking forward at a steady pace"
            rows={2}
            style={{
              flex: 1,
              padding: "6px 8px",
              background: "#111",
              color: "#eee",
              border: "1px solid rgba(255,255,255,0.2)",
              resize: "vertical",
              font: "inherit",
              fontSize: 12,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 70 }}>
            <label style={{ fontSize: 10, color: "#888" }}>Duration (s)</label>
            <input
              type="number"
              min={0.5}
              max={30}
              step={0.5}
              value={durEdit?.i === i ? durEdit.val : String(seg.duration)}
              onChange={(e) => {
                const raw = e.target.value;
                setDurEdit({ i, val: raw });
                const n = parseFloat(raw);
                if (raw !== "" && !Number.isNaN(n)) update(i, { duration: n });
              }}
              onBlur={() => {
                if (durEdit?.i !== i) return;
                let n = parseFloat(durEdit.val);
                if (Number.isNaN(n)) n = 3;
                n = Math.max(0.5, Math.min(30, n));
                update(i, { duration: n });
                setDurEdit(null);
              }}
              disabled={disabled}
              style={{
                width: "100%",
                padding: "4px 6px",
                background: "#111",
                color: "#eee",
                border: "1px solid rgba(255,255,255,0.2)",
                font: "inherit",
                fontSize: 12,
              }}
            />
          </div>
          {segments.length > 1 ? (
            <button
              type="button"
              onClick={() => remove(i)}
              disabled={disabled}
              style={iconBtn}
              title="Remove segment"
            >
              ✕
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        disabled={disabled}
        style={{ ...addBtn, opacity: disabled ? 0.5 : 1 }}
      >
        + Add Motion (Animates a Sequence)
      </button>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: "transparent",
  color: "#888",
  border: "1px solid rgba(255,255,255,0.2)",
  cursor: "pointer",
  padding: "4px 8px",
  alignSelf: "center",
  font: "inherit",
  fontSize: 12,
};

const addBtn: React.CSSProperties = {
  background: "transparent",
  color: "#aaa",
  border: "1px dashed rgba(255,255,255,0.3)",
  cursor: "pointer",
  padding: "6px 12px",
  font: "inherit",
  fontSize: 12,
  textAlign: "left",
};
