"use client";

import React from "react";

/** Matches SequenceEditor timeline shell: resize viewport; inner tiles stay fixed size. */
export function ResizableScrollGallery(props: {
  children: React.ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      className={props.className}
      aria-label={props["aria-label"]}
      title="Drag the corner to resize the gallery panel"
      style={{
        resize: "both",
        overflow: "auto",
        minHeight: 160,
        minWidth: 280,
        height: 280,
        width: "min(100%, 960px)",
        maxWidth: "100%",
        maxHeight: "min(78vh, 880px)",
        boxSizing: "border-box",
        border: "1px solid rgba(0,0,0,0.25)",
      }}
    >
      {props.children}
    </div>
  );
}
