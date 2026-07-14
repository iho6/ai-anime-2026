import { describe, expect, it } from "vitest";
import {
  applyColoringToImageData,
  isDefaultClipColoring,
  normalizeClipColoring,
  sanitizeClipColoringForSave,
} from "./clipColoring";

function makeImageData(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

function checkerboardWithTransparentCorner(size = 16): ImageData {
  const img = makeImageData(size, size);
  const px = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      px[i] = 200;
      px[i + 1] = 200;
      px[i + 2] = 200;
      px[i + 3] = x < size / 2 && y < size / 2 ? 0 : 255;
    }
  }
  return img;
}

describe("clipColoring blur defaults", () => {
  it("defaults blur fields to 0", () => {
    const n = normalizeClipColoring(undefined);
    expect(n.borderBlur).toBe(0);
    expect(n.imageBlur).toBe(0);
  });

  it("treats zero blur as default", () => {
    expect(isDefaultClipColoring({ borderBlur: 0, imageBlur: 0 })).toBe(true);
    expect(isDefaultClipColoring({ imageBlur: 20 })).toBe(false);
  });

  it("sanitizes and clamps blur for save", () => {
    expect(sanitizeClipColoringForSave({ imageBlur: 0, borderBlur: 0 })).toBeUndefined();
    const saved = sanitizeClipColoringForSave({ imageBlur: 999, borderBlur: -5 });
    expect(saved?.imageBlur).toBe(100);
    expect(saved?.borderBlur).toBe(0);
  });
});

describe("applyColoringToImageData blur", () => {
  it("is a no-op for default coloring", () => {
    const img = checkerboardWithTransparentCorner();
    const before = Uint8ClampedArray.from(img.data);
    applyColoringToImageData(img, undefined);
    expect(Array.from(img.data)).toEqual(Array.from(before));
  });

  it("whole image blur changes pixels", () => {
    const img = checkerboardWithTransparentCorner();
    const before = Uint8ClampedArray.from(img.data);
    applyColoringToImageData(img, { imageBlur: 100 });
    expect(Array.from(img.data)).not.toEqual(Array.from(before));
  });

  it("border blur feathers the alpha edge", () => {
    const img = checkerboardWithTransparentCorner();
    applyColoringToImageData(img, { borderBlur: 100 });
    let hasIntermediateAlpha = false;
    for (let i = 3; i < img.data.length; i += 4) {
      const a = img.data[i];
      if (a > 0 && a < 255) {
        hasIntermediateAlpha = true;
        break;
      }
    }
    expect(hasIntermediateAlpha).toBe(true);
  });
});
