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
    stroke: { color: "#000000", width: 0 },
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
    case "custom":
      return {
        template: "custom",
        closed: true,
        points: [],
        fill: "#ffffff",
        stroke: { color: "#000000", width: 0 },
      };
  }
}

const CUSTOM_EPS = 1e-4;

/** True when geometry has been modified beyond the builtin template defaults. */
export function geometryIsCustomized(geometry: TimelineGeometry): boolean {
  if (geometry.template === "custom") return true;
  const base = createGeometryData(geometry.template);
  if (geometry.points.length !== base.points.length) return true;
  if (geometry.closed !== base.closed) return true;

  for (let i = 0; i < geometry.points.length; i++) {
    const a = geometry.points[i];
    const b = base.points[i];
    if (Math.abs(a.x - b.x) > CUSTOM_EPS || Math.abs(a.y - b.y) > CUSTOM_EPS) return true;
    if (geometry.template !== "ellipse" && (a.handleIn || a.handleOut)) return true;
  }
  return false;
}

/** Deep-clone geometry for placing a saved shape on the timeline. */
export function cloneTimelineGeometry(geometry: TimelineGeometry): TimelineGeometry {
  return {
    ...geometry,
    stroke: geometry.stroke ? { ...geometry.stroke } : undefined,
    points: geometry.points.map((p) => ({
      ...p,
      handleIn: p.handleIn ? { ...p.handleIn } : undefined,
      handleOut: p.handleOut ? { ...p.handleOut } : undefined,
    })),
  };
}
