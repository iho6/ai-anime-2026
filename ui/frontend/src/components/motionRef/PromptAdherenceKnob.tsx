"use client";

import React from "react";
import {
  MOTION_REF_MAX_PROMPT_ADHERENCE,
  MOTION_REF_MIN_PROMPT_ADHERENCE,
  MOTION_REF_PROMPT_ADHERENCE_STEP,
} from "../../lib/api";
import {
  MOTION_REF_HINT_COLOR,
  MOTION_REF_KNOB_ACCENT,
  MOTION_REF_LABEL_COLOR,
  MOTION_REF_VALUE_COLOR,
  motionRefKnobTrackStyle,
} from "./theme";

export function PromptAdherenceKnob(props: {
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
        <span>Prompt adherence</span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: MOTION_REF_VALUE_COLOR }}>
          {value.toFixed(1)}
        </span>
      </div>
      <input
        type="range"
        min={MOTION_REF_MIN_PROMPT_ADHERENCE}
        max={MOTION_REF_MAX_PROMPT_ADHERENCE}
        step={MOTION_REF_PROMPT_ADHERENCE_STEP}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        title="Kimodo CFG text weight — higher follows the prompt more strongly"
        style={{
          ...motionRefKnobTrackStyle,
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
          accentColor: MOTION_REF_KNOB_ACCENT,
        }}
      />
      <div style={{ fontSize: 10, color: MOTION_REF_HINT_COLOR, marginTop: 4 }}>
        Higher = stronger text following
      </div>
    </div>
  );
}
