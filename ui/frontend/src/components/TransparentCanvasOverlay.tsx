"use client";

import React from "react";
import { assetUrlFromRelPath, type PlacedFigureMeta } from "../lib/api";

export const CHECKERBOARD: React.CSSProperties = {
  backgroundImage: `
    linear-gradient(45deg, #555 25%, transparent 25%),
    linear-gradient(-45deg, #555 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #555 75%),
    linear-gradient(-45deg, transparent 75%, #555 75%)
  `,
  backgroundSize: "12px 12px",
  backgroundPosition: "0 0, 0 6px, 6px -6px, -6px 0px",
  backgroundColor: "#333",
};

/**
 * Renders a square crop at its placement position on a transparent (checkerboard)
 * canvas sized to the full capture canvas aspect ratio.
 *
 * squareSrc: URL of the square crop image
 * placedFigure: canvas + placement from the captured frame metadata
 */
export function TransparentCanvasOverlay({
  squareSrc,
  placedFigure,
  style,
}: {
  squareSrc: string;
  placedFigure: PlacedFigureMeta;
  style?: React.CSSProperties;
}) {
  const { canvas, placement } = placedFigure;
  const cw = canvas.width;
  const ch = canvas.height;
  const leftPct = (placement.x / cw) * 100;
  const topPct = (placement.y / ch) * 100;
  const widthPct = (placement.width / cw) * 100;
  const heightPct = (placement.height / ch) * 100;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        paddingBottom: `${(ch / cw) * 100}%`,
        ...CHECKERBOARD,
        ...style,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={squareSrc}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          left: `${leftPct}%`,
          top: `${topPct}%`,
          width: `${widthPct}%`,
          height: `${heightPct}%`,
          objectFit: "fill",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

/** Pick the right square crop URL from a placedFigure. */
export function squareSrcFromPlacedFigure(pf: PlacedFigureMeta): string | null {
  const rel = pf.figureSquareCropRelPath ?? pf.squareKeypointCropRelPath ?? null;
  return rel ? assetUrlFromRelPath(rel) : null;
}
