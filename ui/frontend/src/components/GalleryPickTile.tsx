"use client";

import React from "react";

export type GalleryPickTileProps = {
  src: string;
  caption?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (checked: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  onPrimaryClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  footer?: React.ReactNode;
};

export function GalleryPickTile(props: GalleryPickTileProps) {
  const {
    src,
    caption,
    checked,
    disabled = false,
    onToggle,
    onPrimaryClick,
    onContextMenu,
    footer,
  } = props;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: footer ? 2 : 0 }}>
      <div style={{ position: "relative", width: "100%", aspectRatio: "1 / 1" }}>
        <button
          type="button"
          disabled={disabled}
          onClick={onPrimaryClick}
          onContextMenu={onContextMenu}
          title={caption}
          style={{
            width: "100%",
            height: "100%",
            padding: 4,
            borderRadius: 0,
            border: checked
              ? "2px solid #fff"
              : "1px solid rgba(255,255,255,0.2)",
            background: "transparent",
            cursor: disabled ? "not-allowed" : "pointer",
            overflow: "hidden",
            boxSizing: "border-box",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: "block",
            }}
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
      {footer}
    </div>
  );
}
