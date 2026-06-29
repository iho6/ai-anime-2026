/** Logical-pixel bbox used for capture crop placement and view-offset zoom. */
export type CaptureLogicalBbox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Physical-pixel bbox from ``renderer.domElement`` (buffer coordinates). */
export type CapturePhysicalBbox = CaptureLogicalBbox & {
  imageWidth: number;
  imageHeight: number;
};

/** Parameters for PerspectiveCamera.setViewOffset (full frame + sub-rect). */
export type CaptureViewOffset = {
  fullWidth: number;
  fullHeight: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

/**
 * Convert a physical-pixel screen bbox (from renderer.domElement) to logical
 * capture coordinates and derive setViewOffset args for phase-2 zoom render.
 */
export function computeViewOffsetFromBbox(
  captureW: number,
  captureH: number,
  physicalBbox: CapturePhysicalBbox,
  pixelRatio: number,
): { logicalBbox: CapturePhysicalBbox; viewOffset: CaptureViewOffset } {
  const pr = pixelRatio > 0 ? pixelRatio : 1;
  const logicalBbox = {
    x: Math.round(physicalBbox.x / pr),
    y: Math.round(physicalBbox.y / pr),
    width: Math.round(physicalBbox.width / pr),
    height: Math.round(physicalBbox.height / pr),
    imageWidth: captureW,
    imageHeight: captureH,
  };
  const viewOffset: CaptureViewOffset = {
    fullWidth: captureW,
    fullHeight: captureH,
    offsetX: logicalBbox.x,
    offsetY: logicalBbox.y,
    width: logicalBbox.width,
    height: logicalBbox.height,
  };
  return { logicalBbox, viewOffset };
}

/** Source crop rect in physical framebuffer pixels. */
export function physicalCropRect(physicalBbox: CapturePhysicalBbox): {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
} {
  return {
    sx: physicalBbox.x,
    sy: physicalBbox.y,
    sw: physicalBbox.width,
    sh: physicalBbox.height,
  };
}

/**
 * Map a point from the source framebuffer through a uniform square crop+scale
 * into ``targetSize``×``targetSize`` output space.
 */
export function mapPointThroughCropScale(
  px: number,
  py: number,
  cropX: number,
  cropY: number,
  cropSize: number,
  targetSize: number,
): { x: number; y: number } {
  const scale = targetSize / cropSize;
  return {
    x: (px - cropX) * scale,
    y: (py - cropY) * scale,
  };
}

/**
 * When the crop square is centered on a centroid, that centroid maps to the
 * center of the zoom output (targetSize / 2).
 */
export function centroidInOutputAfterCropScale(
  cropX: number,
  cropY: number,
  cropSize: number,
  centroidX: number,
  centroidY: number,
  targetSize: number,
): { x: number; y: number } {
  return mapPointThroughCropScale(
    centroidX,
    centroidY,
    cropX,
    cropY,
    cropSize,
    targetSize,
  );
}

/**
 * Crop a square region from a rendered framebuffer and upscale to ``targetSize``².
 * Browser-only — uses an offscreen 2D canvas.
 */
export function cropCanvasToSquare(
  source: CanvasImageSource,
  physicalBbox: CapturePhysicalBbox,
  targetSize: number,
): string {
  const { sx, sy, sw, sh } = physicalCropRect(physicalBbox);
  const canvas = document.createElement("canvas");
  canvas.width = targetSize;
  canvas.height = targetSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas not available");
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, targetSize, targetSize);
  return canvas.toDataURL("image/png");
}
