"use client";

import React from "react";

const HUB_BORDER = "1px solid rgba(0, 0, 0, 0.5)";
const PREVIEW_BORDER = "1px dashed rgba(0, 0, 0, 0.35)";

/** Name label above a cover/preview: top + left + right border only; bottom edge is shared with the square below. */
export function CharacterNameTag(props: {
  text: string;
  variant: "hub" | "preview";
  title?: string;
  onRequestEdit?: () => void;
  editing?: boolean;
  value?: string;
  onChange?: (v: string) => void;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const {
    text,
    variant,
    title,
    onRequestEdit,
    editing = false,
    value,
    onChange,
    onBlur,
    onKeyDown,
  } = props;
  const edge = variant === "hub" ? HUB_BORDER : PREVIEW_BORDER;

  const baseStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    borderTop: edge,
    borderLeft: edge,
    borderRight: edge,
    borderBottom: "none",
    padding: "4px 8px",
    fontSize: 12,
    lineHeight: 1.3,
    wordBreak: "break-word",
    background: "#f2f2f2",
    textAlign: variant === "preview" ? "center" : "left",
    opacity: 0.98,
  };

  if (editing) {
    return (
      <input
        type="text"
        value={value ?? text}
        onChange={(e) => onChange?.(e.target.value)}
        onBlur={() => onBlur?.()}
        onKeyDown={onKeyDown}
        title={title}
        autoFocus
        onFocus={(e) => {
          // Select-all so renaming is quick.
          e.currentTarget.select();
        }}
        style={{
          ...baseStyle,
          // Match tag look but behave like an input.
          outline: "none",
          background: "#f2f2f2",
          borderRadius: 0,
          // Ensure the input doesn't shrink oddly.
          display: "block",
        }}
      />
    );
  }

  return (
    <div
      onDoubleClick={() => onRequestEdit?.()}
      title={title}
      style={{
        ...baseStyle,
        pointerEvents: onRequestEdit ? "auto" : "none",
        cursor: onRequestEdit ? "text" : "default",
      }}
    >
      {text}
    </div>
  );
}
