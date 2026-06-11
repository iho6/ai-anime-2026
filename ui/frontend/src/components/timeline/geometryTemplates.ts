import type { GeometryTemplate, TimelineGeometry } from "../../lib/api";

export const VECTOR_ARTBOARD_SIZE = 1000;

const KAPPA = 0.5522847498;

/** Cubic-bezier control points approximating a unit circle quadrant. */
function ellipseQuadrant(cx: number, cy: number, rx: number, ry: number) {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return [
    { x: cx, y: cy - ry, handleOut: { x: cx + ox, y: cy - ry } },
    { x: cx + rx, y: cy, handleIn: { x: cx + rx, y: cy - oy }, handleOut: { x: cx + rx, y: cy + oy } },
    { x: cx, y: cy + ry, handleIn: { x: cx + ox, y: cy + ry }, handleOut: { x: cx - ox, y: cy + ry } },
    { x: cx - rx, y: cy, handleIn: { x: cx - rx, y: cy + oy }, handleOut: { x: cx - rx, y: cy - oy } },
  ];
}

export function defaultGeometryStyle(template: GeometryTemplate): Pick<TimelineGeometry, "fill" | "stroke"> {
  if (template === "line") {
    return { stroke: { color: "#000000", width: 4 } };
  }
  return {
    fill: "#ffffff",
    stroke: { color: "#000000", width: 4 },
  };
}

export function createGeometryData(template: GeometryTemplate): TimelineGeometry {
  const style = defaultGeometryStyle(template);
  switch (template) {
    case "rect":
      return {
        template,
        closed: true,
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.8, y: 0.2 },
          { x: 0.8, y: 0.8 },
          { x: 0.2, y: 0.8 },
        ],
        cornerRadius: 0,
        ...style,
      };
    case "ellipse":
      return {
        template,
        closed: true,
        points: ellipseQuadrant(0.5, 0.5, 0.3, 0.3),
        ...style,
      };
    case "line":
      return {
        template,
        closed: false,
        points: [
          { x: 0.2, y: 0.5 },
          { x: 0.8, y: 0.5 },
        ],
        ...style,
      };
    case "polygon":
      return {
        template,
        closed: true,
        points: [
          { x: 0.5, y: 0.15 },
          { x: 0.85, y: 0.8 },
          { x: 0.15, y: 0.8 },
        ],
        ...style,
      };
  }
}
