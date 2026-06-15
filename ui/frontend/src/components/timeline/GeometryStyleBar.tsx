"use client";

import React from "react";
import type { TimelineGeometry } from "../../lib/api";

export type GeometryStyleModal = "fill" | "stroke" | "strokeWidth" | null;

export function GeometryStyleBar(props: {
  geometry: TimelineGeometry;
  rect: { left: number; top: number; width: number; height: number };
  onOpenModal: (modal: GeometryStyleModal) => void;
  onCornerRadiusChange?: (value: number) => void;
  onCornerRadiusCommit?: () => void;
}) {
  const { geometry, rect, onOpenModal, onCornerRadiusChange, onCornerRadiusCommit } = props;
  const barTop = Math.max(0, rect.top - 32);
  const fill = geometry.fill ?? "#ffffff";
  const strokeColor = geometry.stroke?.color ?? "#000000";
  const strokeWidth = geometry.stroke?.width ?? 4;
  const showFill = geometry.template !== "line";

  return (
    <div
      style={{
        position: "absolute",
        left: rect.left,
        top: barTop,
        width: rect.width,
        zIndex: 10002,
        display: "flex",
        gap: 4,
        justifyContent: "center",
        flexWrap: "wrap",
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
      {geometry.template === "rect" && onCornerRadiusChange ? (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            color: "#eee",
            padding: "4px 8px",
            background: "#000",
            border: "1px solid rgba(255,255,255,0.35)",
          }}
        >
          Corner
          <input
            type="number"
            min={0}
            max={200}
            step={1}
            value={Math.round((geometry.cornerRadius ?? 0) * 100)}
            onChange={(e) => {
              const v = Math.max(0, Math.min(200, Number(e.target.value) || 0)) / 100;
              onCornerRadiusChange(v);
            }}
            onBlur={() => onCornerRadiusCommit?.()}
            style={{ width: 44, fontSize: 11, padding: "2px 4px" }}
          />
        </label>
      ) : null}
    </div>
  );
}
