"use client";

import React from "react";

export function ClipSpeedFlyout(props: {
  speed: number;
  reversed: boolean;
  onSpeedChange: (speed: number) => void;
  onSpeedCommit: () => void;
  onInvertChange: (reversed: boolean) => void;
}) {
  const { speed, reversed, onSpeedChange, onSpeedCommit, onInvertChange } = props;

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        padding: "8px 10px",
        minWidth: 168,
      }}
    >
      <label
        style={{
          display: "block",
          marginBottom: 8,
          fontSize: 11,
          color: "#aaa",
        }}
      >
        <div style={{ marginBottom: 4 }}>Speed</div>
        <input
          type="range"
          className="ui-square-range"
          min={0.1}
          max={4}
          step={0.05}
          value={speed}
          onChange={(e) => onSpeedChange(Number(e.target.value))}
          onPointerUp={onSpeedCommit}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          style={{ borderTop: "none" }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 2,
            fontSize: 10,
            color: "#888",
            fontFamily: "monospace",
          }}
        >
          <span>0.1</span>
          <span style={{ color: "#bbb" }}>{speed.toFixed(2)}×</span>
          <span>4</span>
        </div>
      </label>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color: "#aaa",
          cursor: "pointer",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={reversed}
          onChange={(e) => onInvertChange(e.target.checked)}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        Invert
      </label>
    </div>
  );
}
