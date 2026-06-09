"use client";

import React from "react";

/** Matches SequenceEditor timeline shell: resize viewport; inner tiles stay fixed size.
 *
 * Forwards a ref to the outer `overflow:auto` viewport `<div>` so callers can attach a dnd-kit
 * droppable to the *clipped* viewport (not the tall inner content), keeping stacked scroll
 * galleries' droppable rects from overlapping. */
export const ResizableScrollGallery = React.forwardRef<
  HTMLDivElement,
  {
    children: React.ReactNode;
    className?: string;
    "aria-label"?: string;
  }
>(function ResizableScrollGallery(props, ref) {
  return (
    <div
      ref={ref}
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
});
