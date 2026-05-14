"use client";

import React, { useState } from "react";
import { assetUrlFromRelPath } from "../lib/api";
import { DesktopContextMenu, ContextMenuItem } from "./DesktopContextMenu";
import { SquareIconButton, TriangleIcon } from "./IconPrimitives";
import { ZoomableImage } from "./ZoomableImage";

export function StartingImagePreview(props: {
  storageRelPath: string;
  stackLength: number;
  stackIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onDeleteCacheEntry: () => void;
  onImageError: () => void;
  fitMaxWidth?: string;
  fitMaxHeight?: string;
  /** When true, only the bordered zoom viewport (no pager or context menu). */
  hideControls?: boolean;
  /** Full image URL (e.g. with cache-bust query); default ``assetUrlFromRelPath(storageRelPath)``. */
  imageSrc?: string;
}) {
  const {
    storageRelPath,
    stackLength,
    stackIndex,
    onPrev,
    onNext,
    onDeleteCacheEntry,
    onImageError,
    fitMaxWidth = "520px",
    fitMaxHeight = "360px",
    hideControls = false,
    imageSrc: imageSrcProp,
  } = props;

  const zoomSrc = imageSrcProp ?? assetUrlFromRelPath(storageRelPath);

  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    items: ContextMenuItem[];
  }>({ open: false, x: 0, y: 0, items: [] });

  const canPrev = stackIndex > 0;
  const canNext = stackIndex < stackLength - 1;
  const label = stackLength > 0 ? `${stackIndex + 1}/${stackLength}` : "";

  function openContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      {
        key: "del",
        label: "Delete Starting Image Cache",
        onSelect: () => onDeleteCacheEntry(),
      },
    ];
    setMenu({ open: true, x: e.clientX, y: e.clientY, items });
  }

  const outerStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.35)",
    background: "rgba(0,0,0,0.02)",
    maxWidth: hideControls ? undefined : fitMaxWidth,
    width: hideControls ? "100%" : undefined,
    height: hideControls ? "100%" : undefined,
    minHeight: hideControls ? 0 : undefined,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
  };

  const zoomBlock = (
    <ZoomableImage
      src={zoomSrc}
      fitMaxWidth={fitMaxWidth}
      fitMaxHeight={fitMaxHeight}
      onImageError={onImageError}
    />
  );

  return (
    <>
      <div style={outerStyle} onContextMenu={hideControls ? undefined : openContextMenu}>
        {hideControls ? (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            {zoomBlock}
          </div>
        ) : (
          zoomBlock
        )}
        {hideControls ? null : (
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              justifyContent: "center",
              padding: "8px 0",
              flexWrap: "wrap",
            }}
          >
            <SquareIconButton
              className="ui-square-btn--startingNav"
              aria-label="Previous starting image"
              title="Previous"
              icon={<TriangleIcon direction="left" />}
              tone="dark"
              disabled={!canPrev}
              onClick={() => {
                if (canPrev) onPrev();
              }}
            />
            {label ? (
              <span style={{ fontSize: 13, opacity: 0.85, minWidth: 100, textAlign: "center" }}>
                {label}
              </span>
            ) : (
              <span style={{ minWidth: 100 }} />
            )}
            <SquareIconButton
              className="ui-square-btn--startingNav"
              aria-label="Next starting image"
              title="Next"
              icon={<TriangleIcon direction="right" />}
              tone="dark"
              disabled={!canNext}
              onClick={() => {
                if (canNext) onNext();
              }}
            />
          </div>
        )}
      </div>

      {hideControls ? null : (
        <DesktopContextMenu
          open={menu.open}
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu((m) => ({ ...m, open: false }))}
        />
      )}
    </>
  );
}
