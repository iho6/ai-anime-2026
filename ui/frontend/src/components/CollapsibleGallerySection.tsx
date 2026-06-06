"use client";

import React, { useState } from "react";
import { assetUrlFromRelPath } from "../lib/api";
import { TriangleIcon } from "./IconPrimitives";

export type GallerySectionImage = { relPath: string; caption?: string };

/**
 * A truncatable gallery section: a title row with a downward triangle that
 * collapses/expands a grid of square, clickable thumbnails. Used inside the
 * shot backdrop/character pickers (Angles/Lighting, Pose/Expression).
 */
export function CollapsibleGallerySection(props: {
  title: string;
  images: GallerySectionImage[];
  onPick: (relPath: string) => void;
  onRightClick?: (relPath: string, x: number, y: number) => void;
  defaultOpen?: boolean;
  emptyText?: string;
}) {
  const {
    title,
    images,
    onPick,
    onRightClick,
    defaultOpen = true,
    emptyText = "No images",
  } = props;
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          padding: "4px 0",
          width: "100%",
          textAlign: "left",
          fontSize: 14,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            transform: open ? "none" : "rotate(-90deg)",
            transition: "transform 120ms ease",
          }}
        >
          <TriangleIcon direction="down" />
        </span>
        <span>{title}</span>
        <span style={{ opacity: 0.55, fontSize: 12 }}>({images.length})</span>
      </button>

      {open ? (
        images.length === 0 ? (
          <div
            style={{
              opacity: 0.55,
              fontSize: 13,
              padding: "4px 0 8px 22px",
            }}
          >
            {emptyText}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
              gap: 8,
              paddingTop: 6,
            }}
          >
            {images.map((img) => (
              <button
                key={img.relPath}
                type="button"
                onClick={() => onPick(img.relPath)}
                onContextMenu={onRightClick ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onRightClick(img.relPath, e.clientX, e.clientY);
                } : undefined}
                title={img.caption}
                style={{
                  width: "100%",
                  aspectRatio: "1 / 1",
                  padding: 4,
                  borderRadius: 0,
                  border: "1px solid rgba(255,255,255,0.2)",
                  background: "transparent",
                  cursor: "pointer",
                }}
              >
                <img
                  src={assetUrlFromRelPath(img.relPath)}
                  alt=""
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    display: "block",
                  }}
                />
              </button>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
