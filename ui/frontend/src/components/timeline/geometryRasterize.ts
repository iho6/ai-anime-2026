import type { TimelineGeometry } from "../../lib/api";
import { geometryToSvgPath } from "./geometryPath";
import { VECTOR_ARTBOARD_SIZE } from "./geometryTemplates";

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** Rasterize vector geometry to a transparent PNG (base64, no data-URL prefix). */
export async function rasterizeGeometryToPngBase64(
  geometry: TimelineGeometry
): Promise<string> {
  const fill = geometry.fill ?? "none";
  const strokeColor = geometry.stroke?.color ?? "#000000";
  const strokeWidth = geometry.stroke?.width ?? 0;
  const showStroke = strokeWidth > 0;
  const path = geometryToSvgPath(geometry);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VECTOR_ARTBOARD_SIZE} ${VECTOR_ARTBOARD_SIZE}" width="${VECTOR_ARTBOARD_SIZE}" height="${VECTOR_ARTBOARD_SIZE}">
  <path
    d="${path}"
    fill="${geometry.closed ? escapeXmlAttr(fill) : "none"}"
    stroke="${showStroke ? escapeXmlAttr(strokeColor) : "none"}"
    stroke-width="${showStroke ? strokeWidth : 0}"
    vector-effect="non-scaling-stroke"
  />
</svg>`;

  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to rasterize geometry."));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = VECTOR_ARTBOARD_SIZE;
    canvas.height = VECTOR_ARTBOARD_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D canvas context.");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png").split(",", 2)[1] ?? "";
  } finally {
    URL.revokeObjectURL(url);
  }
}
