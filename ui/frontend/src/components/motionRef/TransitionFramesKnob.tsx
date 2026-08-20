"use client";

import React from "react";
import {
  MOTION_REF_DEFAULT_TRANSITION_FRAMES,
  MOTION_REF_MAX_TRANSITION_FRAMES,
  MOTION_REF_MIN_TRANSITION_FRAMES,
  MOTION_REF_TRANSITION_FRAMES_STEP,
} from "../../lib/api";
import {
  MOTION_REF_HINT_COLOR,
  MOTION_REF_LABEL_COLOR,
  MOTION_REF_VALUE_COLOR,
} from "./theme";

export function TransitionFramesKnob(props: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const { value, onChange, disabled = false } = props;

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
          fontSize: 11,
          color: MOTION_REF_LABEL_COLOR,
        }}
      >
        <span>Transition frames</span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: MOTION_REF_VALUE_COLOR }}>
          {Math.round(value)}
        </span>
      </div>
      <input
        type="range"
        className="ui-square-range"
        min={MOTION_REF_MIN_TRANSITION_FRAMES}
        max={MOTION_REF_MAX_TRANSITION_FRAMES}
        step={MOTION_REF_TRANSITION_FRAMES_STEP}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Math.round(Number(e.target.value)))}
        title="Overlap frames blended between consecutive multi-segment prompts"
        style={{
          width: "100%",
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      />
      <div style={{ fontSize: 10, color: MOTION_REF_HINT_COLOR, marginTop: 4 }}>
        Between multi-segment prompts — higher = longer blend (default{" "}
        {MOTION_REF_DEFAULT_TRANSITION_FRAMES} ≈ 0.2s @ 30fps)
      </div>
    </div>
  );
}
