"use client";

import React from "react";
import { TimelinePlayIcon } from "./IconPrimitives";

export type GalleryPickTileProps = {
  src: string;
  caption?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (checked: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  onPrimaryClick: () => void;
  onPlayClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  footer?: React.ReactNode;
  topRightBadge?: string;
};

export function GalleryPickTile(props: GalleryPickTileProps) {
  const {
    src,
    caption,
    checked,
    disabled = false,
    onToggle,
    onPrimaryClick,
    onPlayClick,
    onContextMenu,
    footer,
    topRightBadge,
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

        {onPlayClick ? (
          <button
            type="button"
            disabled={disabled}
            aria-label="Play preview"
            title="Play preview"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onPlayClick();
            }}
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              zIndex: 2,
              width: 22,
              height: 22,
              display: "grid",
              placeItems: "center",
              padding: 0,
              border: "1px solid rgba(0,0,0,0.35)",
              borderRadius: 0,
              background: "rgba(140,140,140,0.35)",
              color: "rgba(255,255,255,0.9)",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            <TimelinePlayIcon size={12} />
          </button>
        ) : topRightBadge ? (
          <span style={{ position: "absolute", top: 4, right: 4, fontSize: 9, padding: "1px 4px", background: "rgba(140,140,140,0.65)", color: "#eee", pointerEvents: "none", zIndex: 2 }}>
            {topRightBadge}
          </span>
        ) : null}

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
