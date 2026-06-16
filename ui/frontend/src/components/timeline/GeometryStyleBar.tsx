"use client";

import React from "react";
import type { TimelineGeometry } from "../../lib/api";

export type GeometryStyleModal = "fill" | "stroke" | "strokeWidth" | null;

/** Vertical offset of style bar above shape bounds (px). */
export const GEOMETRY_STYLE_BAR_OFFSET = 32;

export function GeometryStyleBar(props: {
  geometry: TimelineGeometry;
  rect: { left: number; top: number; width: number; height: number };
  onOpenModal: (modal: GeometryStyleModal) => void;
}) {
  const { geometry, rect, onOpenModal } = props;
  const barTop = Math.max(0, rect.top - GEOMETRY_STYLE_BAR_OFFSET);
  const centerX = rect.left + rect.width / 2;
  const fill = geometry.fill ?? "#ffffff";
  const strokeColor = geometry.stroke?.color ?? "#000000";
  const strokeWidth = geometry.stroke?.width ?? 4;
  const showFill = geometry.template !== "line";

  return (
    <div
      style={{
        position: "absolute",
        left: centerX,
        top: barTop,
        transform: "translateX(-50%)",
        width: "max-content",
        zIndex: 10002,
        display: "flex",
        gap: 4,
        justifyContent: "center",
        flexWrap: "nowrap",
        whiteSpace: "nowrap",
        pointerEvents: "auto",
      }}
      data-geometry-style-bar
      onPointerDown={(e) => e.stopPropagation()}
    >
      {showFill ? (
        <button
          type="button"
          className="ui-btn-black"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onOpenModal("fill")}
          style={{ fontSize: 11, padding: "4px 10px", display: "flex", alignItems: "center", gap: 4 }}
          title="Fill color"
        >
          <span
            style={{
              width: 12,
              height: 12,
              background: fill,
              border: "1px solid rgba(255,255,255,0.5)",
              display: "inline-block",
            }}
          />
          Fill
        </button>
      ) : null}
      <button
        type="button"
        className="ui-btn-black"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onOpenModal("stroke")}
        style={{ fontSize: 11, padding: "4px 10px", display: "flex", alignItems: "center", gap: 4 }}
        title="Stroke color"
      >
        <span
          style={{
            width: 12,
            height: 12,
            background: strokeColor,
            border: "1px solid rgba(255,255,255,0.5)",
            display: "inline-block",
          }}
        />
        Stroke
      </button>
      <button
        type="button"
        className="ui-btn-black"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onOpenModal("strokeWidth")}
        style={{ fontSize: 11, padding: "4px 10px", minWidth: 36 }}
        title="Stroke width"
      >
        {Math.round(strokeWidth)}
      </button>
    </div>
  );
}
