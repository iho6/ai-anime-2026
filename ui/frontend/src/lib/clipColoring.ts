import type { ClipColoring } from "./api";

export const DEFAULT_CLIP_COLORING: Required<ClipColoring> = {
  r: 100,
  g: 100,
  b: 100,
  opacity: 100,
  lightness: 0,
};

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
    n.lightness === d.lightness
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
}

export function clipNeedsColoringCanvas(
  clip: { coloring?: ClipColoring; alphaRelPath?: string; type?: string }
): boolean {
  if (clip.type !== "image" && clip.type !== "video") return false;
  if (Boolean(clip.alphaRelPath?.trim())) return true;
  return !isDefaultClipColoring(clip.coloring);
}
