import { describe, expect, it } from "vitest";
import { audioSinkMode, shouldUseWebAudioSink } from "./previewAudioGraph";

describe("audioSinkMode", () => {
  it("reports webaudio when the context is running", () => {
    expect(audioSinkMode("running")).toBe("webaudio");
  });

  it("reports element when suspended or unavailable", () => {
    expect(audioSinkMode("suspended")).toBe("element");
    expect(audioSinkMode("closed")).toBe("element");
    expect(audioSinkMode("interrupted")).toBe("element");
    expect(audioSinkMode(null)).toBe("element");
    expect(audioSinkMode(undefined)).toBe("element");
  });
});

describe("shouldUseWebAudioSink", () => {
  it("always prefers element sink for preview (no MediaElementSource)", () => {
    expect(shouldUseWebAudioSink(1, "running")).toBe(false);
    expect(shouldUseWebAudioSink(0.5, "running")).toBe(false);
    expect(shouldUseWebAudioSink(1.5, "running")).toBe(false);
    expect(shouldUseWebAudioSink(2, "running")).toBe(false);
    expect(shouldUseWebAudioSink(1.5, "suspended")).toBe(false);
    expect(shouldUseWebAudioSink(1.5, null)).toBe(false);
  });
});
