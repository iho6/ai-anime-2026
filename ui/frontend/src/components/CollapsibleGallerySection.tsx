"use client";

import React, { useState } from "react";
import { setSequenceBuilderDragData } from "../app/detail/[charKey]/dataset/datasetSequenceDrop";
import { assetUrlFromRelPath } from "../lib/api";
import { GalleryPickTile } from "./GalleryPickTile";
import { TriangleIcon } from "./IconPrimitives";

export type GallerySectionImage = { relPath: string; caption?: string };

type BaseProps = {
  title: string;
  images: GallerySectionImage[];
  defaultOpen?: boolean;
  emptyText?: string;
  onRightClick?: (relPath: string, x: number, y: number) => void;
  maxGridHeight?: number;
};

type ImmediateProps = BaseProps & {
  mode?: "immediate";
  onPick: (relPath: string) => void;
};

type SelectProps = BaseProps & {
  mode: "select";
  selectedRelPaths: Set<string>;
  onToggleSelect: (relPath: string, e: React.ChangeEvent<HTMLInputElement>) => void;
  onPreview: (relPath: string) => void;
  disabled?: boolean;
  enableSequenceDragSource?: boolean;
  onSequenceDragStateChange?: (active: boolean) => void;
};

/**
 * A truncatable gallery section: a title row with a downward triangle that
 * collapses/expands a grid of square thumbnails. Used inside the
 * shot backdrop/character pickers (Angles/Lighting, Pose/Expression).
 */
export function CollapsibleGallerySection(props: ImmediateProps | SelectProps) {
  const {
    title,
    images,
    defaultOpen = true,
    emptyText = "No images",
    onRightClick,
    maxGridHeight,
  } = props;
  const mode = props.mode ?? "immediate";
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
            style={maxGridHeight ? { maxHeight: maxGridHeight, overflowY: "auto" } : undefined}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
                gap: 8,
                paddingTop: 6,
              }}
            >
              {images.map((img) => {
                if (mode === "select") {
                  const selectProps = props as SelectProps;
                  const dragSource =
                    selectProps.enableSequenceDragSource && !selectProps.disabled;
                  return (
                    <GalleryPickTile
                      key={img.relPath}
                      src={assetUrlFromRelPath(img.relPath)}
                      caption={img.caption}
                      checked={selectProps.selectedRelPaths.has(img.relPath)}
                      disabled={selectProps.disabled}
                      draggable={dragSource}
                      onDragStart={
                        dragSource
                          ? (e) => {
                              setSequenceBuilderDragData(e, img.relPath);
                              selectProps.onSequenceDragStateChange?.(true);
                            }
                          : undefined
                      }
                      onDragEnd={
                        dragSource
                          ? () => {
                              selectProps.onSequenceDragStateChange?.(false);
                            }
                          : undefined
                      }
                      onToggle={(on, e) => selectProps.onToggleSelect(img.relPath, e)}
                      onPrimaryClick={() => selectProps.onPreview(img.relPath)}
                      onContextMenu={
                        onRightClick
                          ? (e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onRightClick(img.relPath, e.clientX, e.clientY);
                            }
                          : undefined
                      }
                    />
                  );
                }
                const immediateProps = props as ImmediateProps;
                return (
                  <button
                    key={img.relPath}
                    type="button"
                    onClick={() => immediateProps.onPick(img.relPath)}
                    onContextMenu={
                      onRightClick
                        ? (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onRightClick(img.relPath, e.clientX, e.clientY);
                          }
                        : undefined
                    }
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
                );
              })}
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
