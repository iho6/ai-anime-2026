"use client";

import React from "react";
import type { MotionRefSegment } from "../../lib/api";
import { MOTION_REF_MAX_SEGMENT_DURATION_SEC } from "../../lib/api";
import { MotionRefSettingsFlyout } from "./MotionRefSettingsFlyout";
import { MOTION_REF_HINT_COLOR } from "./theme";

/**
 * Multi-segment motion timeline editor.
 * Each row = one text-prompt. With more than one row, KiMoD generates
 * the segments **sequentially**: each segment continues from the end of the
 * previous one, with a short blended overlap for a smooth transition (KiMoD
 * multi_prompt path). Rows are not independent clips played back-to-back.
 *
 * Duration / prompt adherence / transition frames live in the hover settings flyout.
 */
export function MotionTimeline(props: {
  segments: MotionRefSegment[];
  onChange: (segments: MotionRefSegment[]) => void;
  disabled?: boolean;
  promptAdherence: number;
  onPromptAdherenceChange: (value: number) => void;
  numTransitionFrames: number;
  onNumTransitionFramesChange: (value: number) => void;
}) {
  const {
    segments,
    onChange,
    disabled = false,
    promptAdherence,
    onPromptAdherenceChange,
    numTransitionFrames,
    onNumTransitionFramesChange,
  } = props;

  const sharedDuration = segments[0]?.duration ?? 3.0;

  function update(i: number, patch: Partial<MotionRefSegment>) {
    const next = segments.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    onChange(next);
  }

  function setAllDurations(duration: number) {
    onChange(segments.map((s) => ({ ...s, duration })));
  }

  function add() {
    onChange([...segments, { text: "", duration: sharedDuration }]);
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
              minWidth: 0,
              padding: "6px 8px",
              background: "#111",
              color: "#eee",
              border: "1px solid rgba(255,255,255,0.2)",
              resize: "vertical",
              font: "inherit",
              fontSize: 12,
              boxSizing: "border-box",
            }}
          />
          {i === 0 ? (
            <MotionRefSettingsFlyout
              disabled={disabled}
              promptAdherence={promptAdherence}
              onPromptAdherenceChange={onPromptAdherenceChange}
              numTransitionFrames={numTransitionFrames}
              onNumTransitionFramesChange={onNumTransitionFramesChange}
              durationSec={sharedDuration}
              onDurationSecChange={setAllDurations}
            />
          ) : null}
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
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <span style={{ minWidth: 18, flexShrink: 0 }} aria-hidden />
        <button
          type="button"
          onClick={add}
          disabled={disabled}
          style={{ ...addBtn, flex: 1, minWidth: 0, opacity: disabled ? 0.5 : 1 }}
        >
          + Add Motion (Animates a Sequence)
        </button>
        <span style={{ width: 22, flexShrink: 0 }} aria-hidden />
      </div>
      {segments.length > 1 ? (
        <div style={hintBox}>
          Segments generate in order, each continuing from the previous one.
          For best results:
          <ul style={hintList}>
            <li>Start each prompt with “A person…”.</li>
            <li>
              Make every prompt self-contained (e.g. “A person lands and lies on
              the ground”), not relative (“then they stop”).
            </li>
            <li>
              Each segment is at most {MOTION_REF_MAX_SEGMENT_DURATION_SEC} seconds (Kimodo limit).
            </li>
            <li>
              Transition length is set in the settings flyout (›) —
              give big action changes a little extra segment duration.
            </li>
          </ul>
        </div>
      ) : null}
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
  width: "100%",
  boxSizing: "border-box",
  alignSelf: "stretch",
};

const hintBox: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  color: MOTION_REF_HINT_COLOR,
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4,
  padding: "8px 10px",
  background: "rgba(255,255,255,0.03)",
};

const hintList: React.CSSProperties = {
  margin: "4px 0 0",
  paddingLeft: 16,
};
