import type { ClipColoring } from "./api";

export const DEFAULT_CLIP_COLORING: Required<ClipColoring> = {
  r: 100,
  g: 100,
  b: 100,
  opacity: 100,
  lightness: 0,
  borderBlur: 0,
  imageBlur: 0,
};

/** Max Gaussian radius (px) at slider value 100. */
const MAX_BLUR_RADIUS_PX = 8;

export function normalizeClipColoring(
  coloring: ClipColoring | undefined
): Required<ClipColoring> {
  const d = DEFAULT_CLIP_COLORING;
  return {
    r: coloring?.r ?? d.r,
    g: coloring?.g ?? d.g,
    b: coloring?.b ?? d.b,
    opacity: coloring?.opacity ?? d.opacity,
    lightness: coloring?.lightness ?? d.lightness,
    borderBlur: coloring?.borderBlur ?? d.borderBlur,
    imageBlur: coloring?.imageBlur ?? d.imageBlur,
  };
}

export function isDefaultClipColoring(coloring: ClipColoring | undefined): boolean {
  if (!coloring) return true;
  const n = normalizeClipColoring(coloring);
  const d = DEFAULT_CLIP_COLORING;
  return (
    n.r === d.r &&
    n.g === d.g &&
    n.b === d.b &&
    n.opacity === d.opacity &&
    n.lightness === d.lightness &&
    n.borderBlur === d.borderBlur &&
    n.imageBlur === d.imageBlur
  );
}

export function sanitizeClipColoringForSave(
  coloring: ClipColoring | undefined
): ClipColoring | undefined {
  if (!coloring || isDefaultClipColoring(coloring)) return undefined;
  const n = normalizeClipColoring(coloring);
  return {
    r: clampInt(n.r, 0, 200),
    g: clampInt(n.g, 0, 200),
    b: clampInt(n.b, 0, 200),
    opacity: clampInt(n.opacity, 0, 100),
    lightness: clampInt(n.lightness, -100, 100),
    borderBlur: clampInt(n.borderBlur, 0, 100),
    imageBlur: clampInt(n.imageBlur, 0, 100),
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Alpha-aware per-pixel coloring on RGBA ImageData (in place). */
export function applyColoringToImageData(
  data: ImageData,
  coloring: ClipColoring | undefined
): void {
  if (isDefaultClipColoring(coloring)) return;
  const c = normalizeClipColoring(coloring);
  const rGain = c.r / 100;
  const gGain = c.g / 100;
  const bGain = c.b / 100;
  const opacityFactor = c.opacity / 100;
  const lightness = c.lightness;
  const lightUp = lightness > 0 ? lightness / 100 : 0;
  const lightDown = lightness < 0 ? -lightness / 100 : 0;
  const px = data.data;

  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0) continue;

    let r = clampByte(px[i] * rGain);
    let g = clampByte(px[i + 1] * gGain);
    let b = clampByte(px[i + 2] * bGain);

    if (lightUp > 0) {
      r = clampByte(lerp(r, 255, lightUp));
      g = clampByte(lerp(g, 255, lightUp));
      b = clampByte(lerp(b, 255, lightUp));
    } else if (lightDown > 0) {
      r = clampByte(lerp(r, 0, lightDown));
      g = clampByte(lerp(g, 0, lightDown));
      b = clampByte(lerp(b, 0, lightDown));
    }

    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = clampByte(a * opacityFactor);
  }

  const imageBlurRadius = blurRadiusFromSlider(c.imageBlur);
  if (imageBlurRadius > 0) {
    gaussianBlurImageData(data, imageBlurRadius, [0, 1, 2, 3]);
  }
  const borderBlurRadius = blurRadiusFromSlider(c.borderBlur);
  if (borderBlurRadius > 0) {
    gaussianBlurImageData(data, borderBlurRadius, [3]);
  }
}

function blurRadiusFromSlider(v: number): number {
  return (Math.max(0, Math.min(100, v)) / 100) * MAX_BLUR_RADIUS_PX;
}

function buildGaussianKernel(radius: number): number[] {
  const sigma = radius / 2 || 1;
  const r = Math.max(1, Math.ceil(radius));
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

/** Separable Gaussian blur, writing back only the requested channels (0=R,1=G,2=B,3=A). */
function gaussianBlurImageData(
  data: ImageData,
  radius: number,
  channels: number[]
): void {
  if (radius <= 0 || channels.length === 0) return;
  const kernel = buildGaussianKernel(radius);
  const half = (kernel.length - 1) / 2;
  const { width, height } = data;
  const src = data.data;
  const n = width * height;
  const orig = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) orig[i] = src[i];
  const horiz = new Float32Array(n * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let k = -half; k <= half; k++) {
        let sx = x + k;
        if (sx < 0) sx = 0;
        else if (sx >= width) sx = width - 1;
        const w = kernel[k + half];
        const idx = (y * width + sx) * 4;
        a0 += orig[idx] * w;
        a1 += orig[idx + 1] * w;
        a2 += orig[idx + 2] * w;
        a3 += orig[idx + 3] * w;
      }
      const out = (y * width + x) * 4;
      horiz[out] = a0;
      horiz[out + 1] = a1;
      horiz[out + 2] = a2;
      horiz[out + 3] = a3;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
      for (let k = -half; k <= half; k++) {
        let sy = y + k;
        if (sy < 0) sy = 0;
        else if (sy >= height) sy = height - 1;
        const w = kernel[k + half];
        const idx = (sy * width + x) * 4;
        a0 += horiz[idx] * w;
        a1 += horiz[idx + 1] * w;
        a2 += horiz[idx + 2] * w;
        a3 += horiz[idx + 3] * w;
      }
      const out = (y * width + x) * 4;
      const acc = [a0, a1, a2, a3];
      for (const ch of channels) src[out + ch] = clampByte(acc[ch]);
    }
  }
}

export function clipNeedsColoringCanvas(
  clip: { coloring?: ClipColoring; alphaRelPath?: string; type?: string }
): boolean {
  if (clip.type !== "image" && clip.type !== "video") return false;
  if (Boolean(clip.alphaRelPath?.trim())) return true;
  return !isDefaultClipColoring(clip.coloring);
}
