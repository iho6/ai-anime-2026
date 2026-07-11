"use client";

import React from "react";
import type { ClipColoring } from "../../lib/api";
import { normalizeClipColoring } from "../../lib/clipColoring";

type SliderRowProps = {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  onCommit: () => void;
};

function SliderRow(props: SliderRowProps) {
  const { label, min, max, step = 1, value, onChange, onCommit } = props;
  return (
    <label
      style={{
        display: "block",
        marginBottom: 8,
        fontSize: 11,
        color: "#aaa",
      }}
    >
      <div style={{ marginBottom: 4 }}>{label}</div>
      <input
        type="range"
        className="ui-square-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <div style={{ marginTop: 2, fontSize: 10, color: "#888", fontFamily: "monospace" }}>
        {value}
      </div>
    </label>
  );
}

export function ClipColoringFlyout(props: {
  coloring: ClipColoring | undefined;
  onChange: (coloring: ClipColoring) => void;
  onCommit: () => void;
}) {
  const { coloring, onChange, onCommit } = props;
  const c = normalizeClipColoring(coloring);

  function patch(partial: Partial<ClipColoring>) {
    onChange({ ...c, ...partial });
  }

  return (
    <div
      className="clip-coloring-flyout"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        padding: "8px 10px",
        minWidth: 168,
      }}
    >
      <SliderRow
        label="R"
        min={0}
        max={200}
        value={c.r}
        onChange={(r) => patch({ r })}
        onCommit={onCommit}
      />
      <SliderRow
        label="G"
        min={0}
        max={200}
        value={c.g}
        onChange={(g) => patch({ g })}
        onCommit={onCommit}
      />
      <SliderRow
        label="B"
        min={0}
        max={200}
        value={c.b}
        onChange={(b) => patch({ b })}
        onCommit={onCommit}
      />
      <SliderRow
        label="Opacity"
        min={0}
        max={100}
        value={c.opacity}
        onChange={(opacity) => patch({ opacity })}
        onCommit={onCommit}
      />
      <SliderRow
        label="Lightness"
        min={-100}
        max={100}
        value={c.lightness}
        onChange={(lightness) => patch({ lightness })}
        onCommit={onCommit}
      />
    </div>
  );
}
