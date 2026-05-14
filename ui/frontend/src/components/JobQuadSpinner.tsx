"use client";

import React from "react";

const KEYS = ["tl", "tr", "bl", "br"] as const;

/** Clockwise: tl → tr → br → bl (matches CSS grid cell order for 2×2). */
const QUAD_ANIM_DELAY_S: Record<(typeof KEYS)[number], number> = {
  tl: 0,
  tr: 0.25,
  br: 0.5,
  bl: 0.75,
};

export function JobQuadSpinner(props: {
  running?: boolean;
  /** Outer width/height in px (default 20, matches JobRunModal). */
  size?: number;
}) {
  const { running = true, size = 20 } = props;
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        display: "grid",
        gridTemplateColumns: "repeat(2, 1fr)",
        gridTemplateRows: "repeat(2, 1fr)",
        gap: 2,
      }}
    >
      {KEYS.map((k) => (
        <div
          key={k}
          style={{
            border: "1px solid rgba(238,238,238,0.9)",
            background: running ? "transparent" : "rgba(238,238,238,0.15)",
            animation: running
              ? `jobQuadFill 1s steps(1, end) ${QUAD_ANIM_DELAY_S[k]}s infinite`
              : "none",
          }}
        />
      ))}
    </div>
  );
}
