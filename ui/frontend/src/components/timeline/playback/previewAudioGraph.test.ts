import { describe, expect, it } from "vitest";
import { audioSinkMode } from "./previewAudioGraph";

describe("audioSinkMode", () => {
  it("uses webaudio only when the context is running", () => {
    expect(audioSinkMode("running")).toBe("webaudio");
  });

  it("falls back to element volume when suspended or unavailable", () => {
    expect(audioSinkMode("suspended")).toBe("element");
    expect(audioSinkMode("closed")).toBe("element");
    expect(audioSinkMode("interrupted")).toBe("element");
    expect(audioSinkMode(null)).toBe("element");
    expect(audioSinkMode(undefined)).toBe("element");
  });
});
