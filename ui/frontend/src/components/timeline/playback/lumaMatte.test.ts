import { describe, expect, it } from "vitest";
import { applyLumaMatteToImageData } from "./lumaMatte";

function makeRgba(width: number, height: number, pixels: number[]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(pixels);
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

describe("applyLumaMatteToImageData", () => {
  it("overwrites frame alpha with matte red channel", () => {
    const frame = makeRgba(2, 1, [10, 20, 30, 255, 40, 50, 60, 255]);
    const matte = makeRgba(2, 1, [0, 0, 0, 255, 200, 200, 200, 255]);
    applyLumaMatteToImageData(frame, matte);
    expect(frame.data[3]).toBe(0);
    expect(frame.data[7]).toBe(200);
    // RGB unchanged
    expect(frame.data[0]).toBe(10);
    expect(frame.data[4]).toBe(40);
  });
});
