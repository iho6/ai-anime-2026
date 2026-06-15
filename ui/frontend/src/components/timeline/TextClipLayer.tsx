"use client";

import React, { useEffect, useRef, useState } from "react";
import type { TimelineClip } from "../../lib/api";
import { ensureTimelineFontLoaded, timelineFontCssFamily } from "../../lib/timelineFonts";
import { TEXT_CLIP_PADDING_ARTBOARD } from "./textMeasure";

export function TextClipLayer(props: {
  clip: TimelineClip;
  opacity?: number;
  editing?: boolean;
  selected?: boolean;
  showResizeHandle?: boolean;
  onContentChange?: (content: string) => void;
  onEditEnd?: () => void;
  onResizePointerDown?: (e: React.PointerEvent) => void;
}) {
  const {
    clip,
    opacity = 1,
    editing,
    selected,
    showResizeHandle,
    onContentChange,
    onEditEnd,
    onResizePointerDown,
  } = props;
  const text = clip.text;
  const [cssFamily, setCssFamily] = useState("sans-serif");
  const wrapRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLDivElement>(null);
  const [fontPx, setFontPx] = useState(16);
  const [paddingPx, setPaddingPx] = useState(8);

  const naturalH = Math.max(clip.naturalH ?? 48, 48);

  useEffect(() => {
    if (!text) return;
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      const scale = h / naturalH;
      setFontPx(text.fontSize * scale);
      setPaddingPx(TEXT_CLIP_PADDING_ARTBOARD * scale);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, naturalH]);

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

  useEffect(() => {
    if (!editing || !text) return;
    const el = editRef.current;
    if (!el) return;
    if (el.innerText !== text.content) {
      el.innerText = text.content;
    }
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing, text]);

  if (!text) return null;

  const showChrome = selected || editing;

  return (
    <div
      ref={wrapRef}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "block",
        opacity,
        padding: paddingPx,
        boxSizing: "border-box",
        outline: showChrome ? "2px dashed rgba(255,255,255,0.85)" : "none",
        outlineOffset: 0,
      }}
    >
      <div
        ref={editRef}
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
        onPointerDown={(e) => {
          if (editing) e.stopPropagation();
        }}
        style={{
          fontFamily: cssFamily || timelineFontCssFamily(text.fontFamilyId),
          fontWeight: text.fontWeight,
          fontSize: fontPx,
          color: text.color,
          textAlign: text.align,
          width: "100%",
          outline: "none",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: 1.2,
          cursor: editing ? "text" : "inherit",
        }}
      >
        {editing ? null : text.content}
      </div>
      {selected && !editing && (showResizeHandle || onResizePointerDown) ? (
        <div
          onPointerDown={
            onResizePointerDown
              ? (e) => {
                  e.stopPropagation();
                  onResizePointerDown(e);
                }
              : undefined
          }
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 14,
            height: 14,
            transform: "translate(50%, 50%)",
            background: "#0b0b0b",
            border: "1px solid rgba(255,255,255,0.9)",
            cursor: onResizePointerDown ? "nwse-resize" : "default",
            zIndex: 2,
            pointerEvents: onResizePointerDown ? "auto" : "none",
          }}
        />
      ) : null}
    </div>
  );
}
