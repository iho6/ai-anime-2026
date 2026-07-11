"use client";

import React from "react";

export function SyncMotionFlyout(props: {
  motionTailSec: number;
  disabled?: boolean;
  onMotionTailSecChange: (sec: number) => void;
  onApply: () => void;
}) {
  const { motionTailSec, disabled, onMotionTailSecChange, onApply } = props;

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
        <div style={{ marginBottom: 4 }}>Slowdown</div>
        <input
          type="range"
          className="ui-square-range"
          min={0}
          max={2}
          step={0.05}
          value={motionTailSec}
          disabled={disabled}
          onChange={(e) => onMotionTailSecChange(Number(e.target.value))}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <div style={{ marginTop: 2, fontSize: 10, color: "#888", fontFamily: "monospace" }}>
          {motionTailSec.toFixed(2)}s
        </div>
      </label>
      <div style={{ fontSize: 10, color: "#777", marginBottom: 10, lineHeight: 1.35 }}>
        Fade outgoing motion before the cut
      </div>
      <button
        type="button"
        className="ui-btn-black"
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onApply();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          fontSize: 11,
          padding: "6px 8px",
          borderRadius: 0,
        }}
      >
        Apply Sync
      </button>
    </div>
  );
}
