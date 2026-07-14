"use client";

import React, { useCallback, useEffect, useRef } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { assetUrlFromRelPath, type SequenceFrameItem } from "../../lib/api";
import {
  SEQUENCE_CROP_OUTER_CLIP_FLEX,
  sequenceCropTransformWrapperStyle,
} from "../../lib/sequenceCrop";
import type { FrameTimelineViewportProps } from "./types";

const BASE_FRAME_CELL = 72;
const BASE_RULER_H = 22;
const BASE_FOOTER_H = 18;
const TIMELINE_ZOOM_MIN = 0.55;
const TIMELINE_ZOOM_MAX = 3.2;

export function sequenceTimelineCellWidth(scale: number): number {
  return Math.max(40, Math.round(BASE_FRAME_CELL * scale));
}

export function FrameDropCell(props: {
  cellW: number;
  frameIndex: number;
  relPath: string | null;
  cellId: string | undefined;
  crop: SequenceFrameItem["crop"];
  sequenceGroupId?: string;
  hidden?: boolean;
  selected: boolean;
  onCellClick: (event: React.MouseEvent) => void;
  onCellDoubleClick?: (frameIndex: number) => void;
  setFocusTimeline: () => void;
  onFrameContextMenu: (event: React.MouseEvent, frameIndex: number) => void;
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `frame:${props.frameIndex}`,
    data: { frameIndex: props.frameIndex },
  });

  const canDrag = Boolean(props.relPath && props.cellId) && !props.hidden;
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `tl-drag:${props.frameIndex}`,
    data: {
      kind: "timeline" as const,
      fromIndex: props.frameIndex,
      cellId: props.cellId,
      relPath: props.relPath,
      crop: props.crop,
      sequenceGroupId: props.sequenceGroupId,
    },
    disabled: !canDrag,
  });

  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      setDropRef(node);
      setDragRef(node);
    },
    [setDropRef, setDragRef]
  );

  const frameBtnClass =
    "sequenceTimelineFrameBtn" + (props.selected ? " sequenceTimelineFrameBtn--selected" : "");

  return (
    <button
      type="button"
      ref={setRefs}
      {...(canDrag ? listeners : {})}
      {...(canDrag ? attributes : {})}
      className={frameBtnClass}
      onClick={(event) => {
        event.stopPropagation();
        props.setFocusTimeline();
        props.onCellClick(event);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!props.relPath) return;
        props.onCellDoubleClick?.(props.frameIndex);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onFrameContextMenu(event, props.frameIndex);
      }}
      style={{
        width: props.cellW,
        height: props.cellW,
        padding: 2,
        boxSizing: "border-box",
        position: "relative",
        border: props.selected
          ? "2px solid #06c"
          : `1px solid ${isOver ? "rgba(0,100,200,0.7)" : "rgba(0,0,0,0.25)"}`,
        background: isOver ? "rgba(0,100,200,0.08)" : "rgba(0,0,0,0.03)",
        cursor: canDrag ? "grab" : "pointer",
        opacity: isDragging ? 0.45 : 1,
        flexShrink: 0,
      }}
    >
      {props.relPath ? (
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
      ) : null}
      {props.hidden && props.relPath ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: "#ccc",
            pointerEvents: "none",
          }}
        >
          Hidden
        </div>
      ) : null}
    </button>
  );
}

export function FrameTimelineViewport(props: FrameTimelineViewportProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const { onScaleChange } = props;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY;
      onScaleChange((previous) => {
        const step = delta > 0 ? -0.1 : 0.1;
        return Math.max(TIMELINE_ZOOM_MIN, Math.min(TIMELINE_ZOOM_MAX, previous + step));
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [onScaleChange]);

  const cellW = sequenceTimelineCellWidth(props.scale);
  const rulerH = Math.max(16, Math.round(BASE_RULER_H * props.scale));
  const footerH = Math.max(14, Math.round(BASE_FOOTER_H * props.scale));
  const rulerFont = Math.max(9, Math.round(11 * props.scale));
  const footerFont = Math.max(8, Math.round(10 * props.scale));
  const contentWidth = props.visibleFrameIndices.length * cellW;

  return (
    <div
      ref={viewportRef}
      style={{
        width: "min(100%, 960px)",
        maxWidth: "100%",
        overflow: "auto",
        resize: "both",
        minHeight: 160,
        minWidth: 280,
        height: 280,
        maxHeight: "min(78vh, 880px)",
        boxSizing: "border-box",
      }}
    >
      <div style={{ width: contentWidth }}>
        <div style={{ display: "flex", height: rulerH }}>
          {props.visibleFrameIndices.map((frameIndex, columnIndex) => {
            const ordinal = props.visibleOrdinals[columnIndex];
            const isSecondStart =
              ordinal != null && (ordinal - 1) % props.ticksPerSecond === 0;
            return (
              <div
                key={`s-${frameIndex}`}
                style={{
                  width: cellW,
                  flexShrink: 0,
                  borderLeft: isSecondStart
                    ? "2px solid rgba(0,0,0,0.45)"
                    : "1px solid rgba(0,0,0,0.12)",
                  fontSize: rulerFont,
                  paddingLeft: 2,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                {isSecondStart
                  ? String(Math.floor((ordinal - 1) / props.ticksPerSecond))
                  : ""}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", height: footerH, marginBottom: 4 }}>
          {props.visibleFrameIndices.map((frameIndex, columnIndex) => {
            const ordinal = props.visibleOrdinals[columnIndex];
            const isSecondStart =
              ordinal != null && (ordinal - 1) % props.ticksPerSecond === 0;
            return (
              <div
                key={`f-${frameIndex}`}
                style={{
                  width: cellW,
                  flexShrink: 0,
                  borderLeft: isSecondStart
                    ? "2px solid rgba(0,0,0,0.45)"
                    : "1px solid rgba(0,0,0,0.12)",
                  fontSize: footerFont,
                  textAlign: "center",
                  color: "#444",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxSizing: "border-box",
                }}
              >
                {ordinal != null ? ((ordinal - 1) % props.ticksPerSecond) + 1 : ""}
              </div>
            );
          })}
        </div>
        <div
          style={{
            border: "1px solid rgba(0,0,0,0.25)",
            boxSizing: "border-box",
            overflow: "visible",
          }}
        >
          <div style={{ width: contentWidth }}>
            <div style={{ position: "relative", minHeight: cellW + 4 }}>
              {props.groupOutlines.map((outline) => {
                const colStart = props.visibleFrameIndices.findIndex(
                  (frameIndex) => frameIndex >= outline.min
                );
                let colEnd = -1;
                for (let column = props.visibleFrameIndices.length - 1; column >= 0; column--) {
                  if (props.visibleFrameIndices[column]! <= outline.max) {
                    colEnd = column;
                    break;
                  }
                }
                if (colStart < 0 || colEnd < colStart) return null;
                return (
                  <div
                    key={`fs-outline-${outline.groupId}`}
                    style={{
                      position: "absolute",
                      left: colStart * cellW + 3,
                      width: (colEnd - colStart + 1) * cellW - 6,
                      top: 0,
                      height: cellW,
                      boxSizing: "border-box",
                      border: "1px solid rgba(66, 153, 225, 0.75)",
                      borderRadius: 0,
                      pointerEvents: "none",
                      zIndex: 2,
                      boxShadow: "0 0 0 1px rgba(0,40,80,0.12)",
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        top: -13,
                        left: 4,
                        fontSize: 10,
                        lineHeight: 1,
                        letterSpacing: "0.02em",
                        color: "rgba(37, 99, 140, 0.95)",
                        background: "rgba(255,255,255,0.92)",
                        padding: "1px 4px",
                        borderRadius: 0,
                      }}
                    >
                      Frame Sequence
                    </span>
                  </div>
                );
              })}
              <div style={{ display: "flex", position: "relative", zIndex: 1 }}>
                {props.visibleFrameIndices.map((frameIndex) => {
                  const cell = props.cells.get(frameIndex);
                  return (
                    <FrameDropCell
                      key={`c-${frameIndex}`}
                      cellW={cellW}
                      frameIndex={frameIndex}
                      relPath={cell?.relPath ?? null}
                      cellId={cell?.cellId}
                      crop={cell?.crop}
                      sequenceGroupId={cell?.sequenceGroupId}
                      hidden={cell?.hidden}
                      selected={props.selectedFrameIndices.has(frameIndex)}
                      setFocusTimeline={props.onFocus}
                      onCellClick={(event) => props.onCellClick(event, frameIndex)}
                      onCellDoubleClick={props.onCellDoubleClick}
                      onFrameContextMenu={props.onCellContextMenu}
                    />
                  );
                })}
              </div>
            </div>
            <div style={{ display: "flex", height: footerH }}>
              {props.visibleFrameIndices.map((frameIndex) => (
                <div
                  key={`fi-${frameIndex}`}
                  style={{
                    width: cellW,
                    flexShrink: 0,
                    borderLeft:
                      frameIndex % props.logicalFps === 0
                        ? "2px solid rgba(0,0,0,0.45)"
                        : "1px solid rgba(0,0,0,0.12)",
                    fontSize: Math.max(7, footerFont - 1),
                    textAlign: "center",
                    color: "#222",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={`Frame ${frameIndex}`}
                >
                  {frameIndex}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
