"use client";

import React from "react";
import type { TimelineClip } from "../../lib/api";
import { geometryToSvgPath } from "./geometryPath";
import { VECTOR_ARTBOARD_SIZE } from "./geometryTemplates";

export function GeometryClipLayer(props: {
  clip: TimelineClip;
  opacity?: number;
  editing?: boolean;
}) {
  const { clip, opacity = 1, editing = false } = props;
  const geom = clip.geometry;
  if (!geom) return null;

  const fill = geom.fill ?? "none";
  const strokeColor = geom.stroke?.color ?? "#000000";
  const strokeWidth = geom.stroke?.width ?? 0;
  const showStroke = !editing && strokeWidth > 0;

  return (
    <svg
      viewBox={`0 0 ${VECTOR_ARTBOARD_SIZE} ${VECTOR_ARTBOARD_SIZE}`}
      width="100%"
      height="100%"
      style={{ display: "block", opacity }}
      preserveAspectRatio="none"
    >
      <path
        d={geometryToSvgPath(geom)}
        fill={geom.closed ? fill : "none"}
        stroke={showStroke ? strokeColor : "none"}
        strokeWidth={showStroke ? strokeWidth : 0}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
