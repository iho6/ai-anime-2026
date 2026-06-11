"use client";

import React, { useEffect, useRef, useState } from "react";
import type { TimelineClip } from "../../lib/api";
import { ensureTimelineFontLoaded, timelineFontCssFamily } from "../../lib/timelineFonts";
import { VECTOR_ARTBOARD_SIZE } from "./geometryTemplates";

export function TextClipLayer(props: {
  clip: TimelineClip;
  opacity?: number;
  editing?: boolean;
  onContentChange?: (content: string) => void;
  onEditEnd?: () => void;
}) {
  const { clip, opacity = 1, editing, onContentChange, onEditEnd } = props;
  const text = clip.text;
  const [cssFamily, setCssFamily] = useState("sans-serif");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [fontPx, setFontPx] = useState(16);

  useEffect(() => {
    if (!text) return;
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      setFontPx((text.fontSize / VECTOR_ARTBOARD_SIZE) * h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  useEffect(() => {
    if (!text) return;
    let cancelled = false;
    void ensureTimelineFontLoaded(text.fontFamilyId, text.fontWeight).then((fam) => {
      if (!cancelled) setCssFamily(fam);
    });
    return () => {
      cancelled = true;
    };
  }, [text?.fontFamilyId, text?.fontWeight]);

  if (!text) return null;

  return (
    <div
      ref={wrapRef}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent:
          text.align === "left"
            ? "flex-start"
            : text.align === "right"
            ? "flex-end"
            : "center",
        opacity,
        padding: "4%",
        boxSizing: "border-box",
      }}
    >
      <div
        contentEditable={editing}
        suppressContentEditableWarning
        onBlur={(e) => {
          onContentChange?.(e.currentTarget.innerText);
          onEditEnd?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            (e.target as HTMLElement).blur();
          }
        }}
        style={{
          fontFamily: cssFamily || timelineFontCssFamily(text.fontFamilyId),
          fontWeight: text.fontWeight,
          fontSize: fontPx,
          color: text.color,
          textAlign: text.align,
          width: "100%",
          outline: editing ? "1px dashed #ffd166" : "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: 1.2,
          cursor: editing ? "text" : "inherit",
        }}
      >
        {text.content}
      </div>
    </div>
  );
}
