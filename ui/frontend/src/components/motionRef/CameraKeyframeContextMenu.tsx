"use client";

import React, { useEffect, useRef, useState } from "react";

const KNOB_ACCENT = "#6eb5ff";

type KnobRowProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: () => void;
};

function KnobRow(props: KnobRowProps) {
  const { label, value, min, max, onChange, onCommit } = props;
  return (
    <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
          fontSize: 12,
          color: "#ccc",
        }}
      >
        <span>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: "#eee" }}>{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={(e) => {
          if (e.key === "Enter") onCommit();
        }}
        style={{
          width: "100%",
          accentColor: KNOB_ACCENT,
          cursor: "pointer",
        }}
      />
    </div>
  );
}

export type CameraKeyframePatchValues = {
  holdFrames: number;
  blendEase: number;
};

type Props = {
  x: number;
  y: number;
  holdFrames: number;
  blendEase: number;
  maxHold: number;
  onPatchSave: (patch: CameraKeyframePatchValues) => void | Promise<void>;
  onDelete: () => void;
  onClose: () => void;
};

export function CameraKeyframeContextMenu(props: Props) {
  const { x, y, holdFrames, blendEase, maxHold, onPatchSave, onDelete, onClose } = props;
  const [localHold, setLocalHold] = useState(holdFrames);
  const [localEase, setLocalEase] = useState(blendEase);
  const savedRef = useRef({ holdFrames, blendEase });

  useEffect(() => {
    setLocalHold(holdFrames);
    setLocalEase(blendEase);
    savedRef.current = { holdFrames, blendEase };
  }, [holdFrames, blendEase]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-camera-keyframe-menu]")) return;
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  function commitIfChanged() {
    const saved = savedRef.current;
    if (localHold === saved.holdFrames && localEase === saved.blendEase) return;
    savedRef.current = { holdFrames: localHold, blendEase: localEase };
    void onPatchSave({ holdFrames: localHold, blendEase: localEase });
  }

  const holdMax = Math.max(0, maxHold);

  return (
    <div
      data-camera-keyframe-menu
      style={{
        position: "fixed",
        top: y,
        left: x,
        background: "#1e1e1e",
        border: "1px solid rgba(255,255,255,0.2)",
        zIndex: 10300,
        minWidth: 200,
        borderRadius: 4,
        overflow: "hidden",
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <KnobRow
        label="Hold frames"
        value={localHold}
        min={0}
        max={holdMax}
        onChange={setLocalHold}
        onCommit={commitIfChanged}
      />
      <KnobRow
        label="Glide ease"
        value={localEase}
        min={0}
        max={100}
        onChange={setLocalEase}
        onCommit={commitIfChanged}
      />
      <div
        style={{
          padding: "0 14px 8px",
          fontSize: 10,
          color: "rgba(255,255,255,0.45)",
          borderBottom: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        0 = straight path · 100 = smooth curve (speed follows frame spacing)
      </div>
      <button
        type="button"
        onClick={() => onDelete()}
        style={{
          display: "block",
          width: "100%",
          padding: "8px 14px",
          background: "transparent",
          color: "#eee",
          border: "none",
          textAlign: "left",
          cursor: "pointer",
          font: "inherit",
          fontSize: 13,
        }}
      >
        Delete camera pose
      </button>
    </div>
  );
}
