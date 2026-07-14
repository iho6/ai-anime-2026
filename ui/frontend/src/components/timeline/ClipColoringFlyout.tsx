"use client";

import React, { useState } from "react";
import type { ClipColoring } from "../../lib/api";
import { normalizeClipColoring } from "../../lib/clipColoring";

type ColoringClipboard = {
  fromClipId: string;
  coloring: Required<ClipColoring>;
};

/** Session clipboard for Coloring/Effect — survives flyout close/reopen across clips. */
let coloringClipboard: ColoringClipboard | null = null;

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
  clipId: string;
  coloring: ClipColoring | undefined;
  onChange: (coloring: ClipColoring) => void;
  onCommit: () => void;
}) {
  const { clipId, coloring, onChange, onCommit } = props;
  const c = normalizeClipColoring(coloring);
  // Epoch bumps after Copy so this flyout can stay on Copy until another clip opens.
  const [, setClipboardEpoch] = useState(0);
  const showPaste =
    coloringClipboard != null && coloringClipboard.fromClipId !== clipId;

  function patch(partial: Partial<ClipColoring>) {
    onChange({ ...c, ...partial });
  }

  function onCopy() {
    coloringClipboard = {
      fromClipId: clipId,
      coloring: { ...normalizeClipColoring(coloring) },
    };
    setClipboardEpoch((n) => n + 1);
  }

  function onPaste() {
    if (!coloringClipboard) return;
    onChange({ ...coloringClipboard.coloring });
    onCommit();
  }

  return (
    <div
      className="clip-coloring-flyout"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        padding: 0,
        minWidth: 168,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "8px 10px" }}>
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
        <div
          style={{
            borderTop: "1px solid rgba(255,255,255,0.25)",
            marginTop: 4,
            paddingTop: 8,
          }}
        >
          <SliderRow
            label="Border blur"
            min={0}
            max={100}
            value={c.borderBlur}
            onChange={(borderBlur) => patch({ borderBlur })}
            onCommit={onCommit}
          />
          <SliderRow
            label="Whole image blur"
            min={0}
            max={100}
            value={c.imageBlur}
            onChange={(imageBlur) => patch({ imageBlur })}
            onCommit={onCommit}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={showPaste ? onPaste : onCopy}
        style={{
          appearance: "none",
          display: "block",
          width: "100%",
          marginTop: -1,
          padding: "6px 8px",
          borderRadius: 0,
          border: "1px solid rgba(255,255,255,0.35)",
          background: "transparent",
          color: "white",
          fontSize: 11,
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
        }}
      >
        {showPaste ? "Paste" : "Copy"}
      </button>
      {showPaste ? (
        <button
          type="button"
          onClick={onCopy}
          style={{
            appearance: "none",
            display: "block",
            width: "100%",
            marginTop: -1,
            padding: "4px 8px",
            borderRadius: 0,
            border: "1px solid rgba(255,255,255,0.35)",
            background: "transparent",
            color: "#888",
            fontSize: 10,
            cursor: "pointer",
            textAlign: "left",
            font: "inherit",
          }}
        >
          Copy this clip instead
        </button>
      ) : null}
    </div>
  );
}
