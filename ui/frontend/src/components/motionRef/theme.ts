import type { CSSProperties } from "react";

/** Motion Ref modal accent colors (blue) — trajectory / checkboxes only. */
export const MOTION_REF_ACCENT = "#6eb5ff";
export const MOTION_REF_ACCENT_BORDER = "rgba(110,181,255,0.7)";
export const MOTION_REF_ACCENT_BG = "rgba(110,181,255,0.08)";
export const MOTION_REF_ACCENT_BTN_BG = "rgba(110,181,255,0.15)";

/** Grayscale form tokens (timeline, duration, prompt adherence). */
export const MOTION_REF_FIELD_BG = "#111";
export const MOTION_REF_FIELD_BORDER = "1px solid rgba(255,255,255,0.2)";
export const MOTION_REF_LABEL_COLOR = "#888";
export const MOTION_REF_VALUE_COLOR = "#eee";
export const MOTION_REF_HINT_COLOR = "#9a9a9a";
export const MOTION_REF_KNOB_ACCENT = "#ddd";

export const motionRefNumberInputStyle: CSSProperties = {
  width: "100%",
  padding: "4px 6px",
  background: MOTION_REF_FIELD_BG,
  color: MOTION_REF_VALUE_COLOR,
  border: MOTION_REF_FIELD_BORDER,
  font: "inherit",
  fontSize: 12,
};

export const motionRefKnobTrackStyle: CSSProperties = {
  width: "100%",
  accentColor: MOTION_REF_KNOB_ACCENT,
  cursor: "pointer",
};
