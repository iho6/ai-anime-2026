"use client";

import React from "react";
import { TriangleIcon } from "./IconPrimitives";
import { type PlacedFigureMeta } from "../lib/api";

export function KeypointRefTile(props: {
  tile: number;
  src: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  onPrimary: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  noBackdrop?: boolean;
  noBackdropSrc?: string;
  placedFigure?: PlacedFigureMeta;
}) {
  const { tile, src, checked, disabled, onToggle, onPrimary, onContextMenu, noBackdrop, noBackdropSrc, placedFigure } = props;
  const showTransparent = noBackdrop && noBackdropSrc && placedFigure;
  return (
    <div
      style={{
        width: tile,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      <div style={{ width: tile, height: tile, position: "relative" }}>
        <button
          type="button"
          disabled={disabled}
          onClick={onPrimary}
          onContextMenu={onContextMenu}
          className="gallery-cover-btn"
          style={{
            width: tile,
            height: tile,
            padding: 0,
            border: "1px solid rgba(0,0,0,0.5)",
            background: "rgba(0,0,0,0.2)",
            cursor: disabled ? "not-allowed" : "pointer",
            overflow: "hidden",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={showTransparent ? noBackdropSrc : src}
            alt=""
            className="gallery-cover-img"
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
            draggable={false}
          />
        </button>

        <label
          style={{
            position: "absolute",
            top: 4,
            left: 6,
            zIndex: 2,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            disabled={disabled}
            checked={checked}
            onChange={(e) => onToggle(e.target.checked, e)}
            style={{ margin: 0 }}
          />
        </label>
      </div>
    </div>
  );
}

export function KeypointVideoTile(props: {
  tile: number;
  count: number;
  thumbSrc?: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  onOpen: () => void;
}) {
  const { tile, count, thumbSrc, checked, disabled, onToggle, onOpen } = props;
  return (
    <div style={{ width: tile, height: tile, position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        style={{
          width: tile,
          height: tile,
          padding: thumbSrc ? 0 : 8,
          border: "1px solid rgba(255,255,255,0.25)",
          background: thumbSrc ? "rgba(0,0,0,0.2)" : "rgba(80,120,200,0.12)",
          color: "#eee",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          textAlign: "center",
          fontSize: 12,
          lineHeight: 1.2,
          overflow: "hidden",
          position: "relative",
        }}
        title="Open video keypoint sequence editor"
      >
        {thumbSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbSrc}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }}
            draggable={false}
          />
        ) : (
          <>
            <span
              style={{
                fontSize: 10,
                padding: "1px 4px",
                background: "rgba(140,140,140,0.55)",
                color: "#eee",
              }}
            >
              Vid
            </span>
            <span style={{ opacity: 0.85 }}>{count} frames</span>
          </>
        )}

        {/* Triangle play indicator — centered non-interactive overlay */}
        <span
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            color: "rgba(255,255,255,0.85)",
            pointerEvents: "none",
            display: "flex",
          }}
        >
          <TriangleIcon direction="right" size={18} />
        </span>

        {/* "Vid" badge — top-right */}
        {thumbSrc ? (
          <span
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              fontSize: 9,
              padding: "1px 4px",
              background: "rgba(140,140,140,0.65)",
              color: "#eee",
              pointerEvents: "none",
            }}
          >
            Vid
          </span>
        ) : null}
      </button>

      {/* Checkbox — top-left, outside the main button */}
      <label
        style={{
          position: "absolute",
          top: 4,
          left: 6,
          zIndex: 2,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          disabled={disabled}
          checked={checked}
          onChange={(e) => onToggle(e.target.checked, e)}
          style={{ margin: 0 }}
        />
      </label>
    </div>
  );
}

export function KeypointFolderTile(props: {
  tile: number;
  name: string;
  count: number;
  disabled: boolean;
  onOpen: () => void;
  checked?: boolean;
  indeterminate?: boolean;
  onToggle?: (on: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const { tile, name, count: _count, disabled, onOpen, checked, indeterminate, onToggle } = props;
  const showCheckbox = typeof onToggle === "function";
  return (
    <div style={{ width: tile, height: tile, position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        style={{
          width: tile,
          height: tile,
          padding: 0,
          paddingTop: 22,
          paddingBottom: 8,
          paddingLeft: 6,
          paddingRight: 6,
          border: "1px solid rgba(255,255,255,0.25)",
          background: "rgba(255,255,255,0.06)",
          color: "#eee",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          overflow: "hidden",
          boxSizing: "border-box",
        }}
        title={`Open: ${name}`}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 400,
            width: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "center",
          }}
        >
          {name}
        </span>
      </button>

      {/* "Folder" tag — top-right, within tile boundary */}
      <span
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          fontSize: 9,
          padding: "1px 4px",
          background: "rgba(140,140,140,0.65)",
          color: "#eee",
          pointerEvents: "none",
          zIndex: 1,
        }}
      >
        Folder
      </span>

      {showCheckbox ? (
        <label
          style={{
            position: "absolute",
            top: 4,
            left: 6,
            zIndex: 2,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            disabled={disabled}
            checked={Boolean(checked)}
            ref={(el) => {
              if (el) el.indeterminate = Boolean(indeterminate);
            }}
            onChange={(e) => onToggle!(e.target.checked, e)}
            style={{ margin: 0 }}
          />
        </label>
      ) : null}
    </div>
  );
}
