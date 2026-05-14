"use client";

import React from "react";

type SquareVariant = "icon" | "tile" | "import";
type SquareTone = "dark" | "light";

export function SquareButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    size?: number | string;
    variant?: SquareVariant;
    tone?: SquareTone;
    dragOver?: boolean;
  }
) {
  const {
    size = 32,
    variant = "icon",
    tone = "dark",
    dragOver = false,
    className,
    style,
    children,
    ...rest
  } = props;
  const classes = [
    "ui-square-btn",
    `ui-square-btn--${variant}`,
    `ui-square-btn--${tone}`,
    dragOver ? "ui-square-btn--dragover" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      {...rest}
      className={classes}
      style={{
        width: size,
        height: size,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
