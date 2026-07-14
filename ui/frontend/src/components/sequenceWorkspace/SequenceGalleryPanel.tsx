"use client";

import React from "react";
import { rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { assetUrlFromRelPath, type SequenceFrameItem, type SequenceGalleryItem } from "../../lib/api";
import { ResizableScrollGallery } from "../ResizableScrollGallery";
import { TriangleIcon } from "../IconPrimitives";
import {
  SEQUENCE_CROP_OUTER_CLIP_FLEX,
  sequenceCropTransformWrapperStyle,
} from "../../lib/sequenceCrop";
import type { SequenceGalleryPanelProps } from "./types";

const TILE = 120;

export function SequenceGalleryThumb(props: {
  id: string;
  relPath: string;
  crop: SequenceFrameItem["crop"];
  frameSequence?: SequenceGalleryItem["frameSequence"];
  selected: boolean;
  onSelect: () => void;
  setFocusGallery: () => void;
  onGalleryContextMenu: (event: React.MouseEvent, galleryIndex: number) => void;
  galleryIndex: number;
  onDoubleClickPreview?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.id,
    data: {
      kind: "gallery" as const,
      galleryId: props.id,
      relPath: props.relPath,
      frameSequence: props.frameSequence,
    },
  });

  return (
    <button
      type="button"
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={(event) => {
        event.stopPropagation();
        props.setFocusGallery();
        props.onSelect();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        props.onDoubleClickPreview?.();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.setFocusGallery();
        props.onGalleryContextMenu(event, props.galleryIndex);
      }}
      style={{
        position: "relative",
        width: TILE,
        height: TILE,
        padding: 0,
        border: props.selected ? "2px solid #06c" : "1px solid rgba(0,0,0,0.35)",
        opacity: isDragging ? 0.5 : 1,
        cursor: "grab",
        background: "transparent",
        touchAction: "none",
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      {props.frameSequence ? (
        <>
          <span
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              fontSize: 9,
              lineHeight: 1,
              padding: "1px 4px",
              background: "rgba(140,140,140,0.65)",
              color: "#eee",
              zIndex: 1,
              pointerEvents: "none",
            }}
          >
            Vid
          </span>
          <span
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              color: "rgba(255,255,255,0.7)",
              pointerEvents: "none",
              display: "flex",
              zIndex: 1,
            }}
          >
            <TriangleIcon direction="right" size={18} />
          </span>
        </>
      ) : null}
      <div style={{ ...SEQUENCE_CROP_OUTER_CLIP_FLEX, pointerEvents: "none" }}>
        <div style={sequenceCropTransformWrapperStyle(props.crop)}>
          <img
            src={assetUrlFromRelPath(props.relPath)}
            alt=""
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              width: "auto",
              height: "auto",
              objectFit: "contain",
              display: "block",
            }}
          />
        </div>
      </div>
    </button>
  );
}

export function SequenceGalleryPanel(props: SequenceGalleryPanelProps) {
  return (
    <div
      style={{ marginBottom: 8 }}
      onMouseDown={props.onFocus}
      role="presentation"
    >
      <div style={{ marginBottom: 6 }}>Sequence gallery</div>
      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
        Drag the panel corner to resize · Double-click an image to preview · Ctrl+C / Ctrl+V
        duplicate full sequence sets (strip + assets) · Delete when gallery is focused
      </div>
      <ResizableScrollGallery aria-label="Sequence gallery images">
        <SortableContext items={props.items.map((item) => item.id)} strategy={rectSortingStrategy}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 4 }}>
            {props.items.map((item, index) => (
              <SequenceGalleryThumb
                key={item.id}
                id={item.id}
                relPath={item.relPath}
                crop={item.crop}
                frameSequence={item.frameSequence}
                galleryIndex={index}
                selected={props.selectedId === item.id}
                setFocusGallery={props.onFocus}
                onSelect={() => props.onSelect(item.id)}
                onGalleryContextMenu={props.onItemContextMenu}
                onDoubleClickPreview={() => props.onItemDoubleClick?.(index)}
              />
            ))}
          </div>
        </SortableContext>
      </ResizableScrollGallery>
    </div>
  );
}
