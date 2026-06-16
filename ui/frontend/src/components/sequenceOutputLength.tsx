"use client";

import React from "react";

/** Wan FLF: 4k+1 step 4 from 25 through 121 (see flf2video_ai_service README). */
export const SEQUENCE_FLF_OUTPUT_LENGTHS: readonly number[] = Object.freeze(
  Array.from({ length: Math.floor((121 - 25) / 4) + 1 }, (_, i) => 25 + i * 4)
);

/** Hunyuan I2V: discrete latent lengths (approx. duration at 24fps). */
export const SEQUENCE_I2V_OUTPUT_LENGTHS: readonly number[] = Object.freeze([
  25, 49, 73, 97, 121, 129,
]);

export function sequenceVideoLengthIndex(value: number, lengths: readonly number[]): number {
  if (!lengths.length) return 0;
  let idx = lengths.indexOf(value);
  if (idx >= 0) return idx;
  idx = lengths.findIndex((n) => n >= value);
  if (idx <= 0) return 0;
  if (idx < 0) return lengths.length - 1;
  const prev = lengths[idx - 1]!;
  const cur = lengths[idx]!;
  return value - prev <= cur - value ? idx - 1 : idx;
}

export function SequenceOutputLengthStepper(props: {
  lengths: readonly number[];
  value: number;
  onChange: (next: number) => void;
}) {
  const { lengths } = props;
  const i = sequenceVideoLengthIndex(props.value, lengths);
  const shown = lengths[i]!;
  const atMin = i <= 0;
  const atMax = i >= lengths.length - 1;
  const border = "1px solid rgba(255,255,255,0.25)";
  const btn: React.CSSProperties = {
    flex: 1,
    minHeight: 22,
    padding: 0,
    border: "none",
    borderRadius: 0,
    background: "rgba(255,255,255,0.08)",
    color: "inherit",
    cursor: "pointer",
    fontSize: 11,
    lineHeight: 1,
  };
  return (
    <div
      style={{
        display: "flex",
        marginTop: 4,
        border,
        background: "rgba(0,0,0,0.35)",
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "6px 8px",
          fontVariantNumeric: "tabular-nums",
          fontSize: 15,
        }}
        aria-live="polite"
      >
        {shown}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: 28,
          borderLeft: border,
        }}
      >
        <button
          type="button"
          aria-label="Increase output length"
          disabled={atMax}
          onClick={() =>
            props.onChange(lengths[Math.min(lengths.length - 1, i + 1)]!)
          }
          style={{
            ...btn,
            borderBottom: border,
            opacity: atMax ? 0.35 : 1,
            cursor: atMax ? "default" : "pointer",
          }}
        >
          ▲
        </button>
        <button
          type="button"
          aria-label="Decrease output length"
          disabled={atMin}
          onClick={() => props.onChange(lengths[Math.max(0, i - 1)]!)}
          style={{
            ...btn,
            opacity: atMin ? 0.35 : 1,
            cursor: atMin ? "default" : "pointer",
          }}
        >
          ▼
        </button>
      </div>
    </div>
  );
}
