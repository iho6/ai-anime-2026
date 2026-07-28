/**
 * Composite a luma matte (opaque video whose luminance encodes alpha) onto an
 * already-drawn RGB canvas. Works on both main-thread canvases and worker
 * OffscreenCanvas contexts (no DOM/SVG filter dependency).
 */

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let scratch: OffscreenCanvas | HTMLCanvasElement | null = null;

function scratchContext(w: number, h: number): Ctx2D | null {
  if (!scratch || scratch.width < w || scratch.height < h) {
    if (typeof OffscreenCanvas !== "undefined") {
      scratch = new OffscreenCanvas(w, h);
    } else if (typeof document !== "undefined") {
      scratch = document.createElement("canvas");
      scratch.width = w;
      scratch.height = h;
    } else {
      return null;
    }
  }
  return scratch.getContext("2d", {
    willReadFrequently: true,
  }) as Ctx2D | null;
}

/** Rasterize a matte source to ImageData (gray matte: R = alpha value). */
export function readMatteImageData(
  matte: CanvasImageSource,
  w: number,
  h: number
): ImageData | null {
  if (w < 1 || h < 1) return null;
  const sctx = scratchContext(w, h);
  if (!sctx) return null;
  sctx.clearRect(0, 0, w, h);
  try {
    sctx.drawImage(matte, 0, 0, w, h);
    return sctx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }
}

/** Overwrite `frame`'s alpha channel with the matte's red channel, in place. */
export function applyLumaMatteToImageData(
  frame: ImageData,
  matte: ImageData
): void {
  const m = matte.data;
  const f = frame.data;
  const n = Math.min(f.length, m.length);
  for (let i = 0; i < n; i += 4) {
    f[i + 3] = m[i]!;
  }
}

/**
 * Replace the alpha channel of `ctx`'s current w×h content with the matte's
 * red channel (gray matte: R = G = B = alpha value).
 */
export function applyLumaMatteToContext(
  ctx: Ctx2D,
  matte: CanvasImageSource,
  w: number,
  h: number
): boolean {
  const matteData = readMatteImageData(matte, w, h);
  if (!matteData) return false;
  let frameData: ImageData;
  try {
    frameData = ctx.getImageData(0, 0, w, h);
  } catch {
    return false;
  }
  applyLumaMatteToImageData(frameData, matteData);
  ctx.putImageData(frameData, 0, 0);
  return true;
}
