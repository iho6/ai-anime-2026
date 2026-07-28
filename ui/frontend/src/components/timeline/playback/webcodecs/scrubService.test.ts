import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../../lib/api";
import { clipScrubDecodable } from "./scrubService";
import { webcodecsEngineEnabled } from "./useWebcodecsEngine";

function videoClip(partial: Partial<TimelineClip> & { id: string }): TimelineClip {
  return {
    type: "video",
    srcRelPath: `clips/${partial.id}.mp4`,
    start: 0,
    inPoint: 0,
    outPoint: 2,
    speed: 1,
    duration: 2,
    naturalW: 1920,
    naturalH: 1080,
    ...partial,
  };
}

describe("clipScrubDecodable", () => {
  it("requires an MP4 color proxy", () => {
    expect(
      clipScrubDecodable(
        videoClip({
          id: "a",
          proxyRelPath: "clips/a.proxy.webm",
        })
      )
    ).toBe(false);
    expect(
      clipScrubDecodable(
        videoClip({
          id: "b",
          proxyRelPath: "clips/b.proxy.mp4",
        })
      )
    ).toBe(true);
  });

  it("rejects alpha / RMBG clips (unified WebM or HTTP, not MP4 pair)", () => {
    expect(
      clipScrubDecodable(
        videoClip({
          id: "c",
          proxyRelPath: "clips/c.proxy.webm",
          alphaRelPath: "clips/c_rmbg.mkv",
        })
      )
    ).toBe(false);
    expect(
      clipScrubDecodable(
        videoClip({
          id: "d",
          proxyRelPath: "clips/d.proxy.mp4",
          alphaRelPath: "clips/d_rmbg.mkv",
          proxyAlphaRelPath: "clips/d.proxy.alpha.mp4",
        })
      )
    ).toBe(false);
  });
});

describe("webcodecsEngineEnabled", () => {
  it("is opt-in (off unless localStorage is exactly 1)", () => {
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });
    try {
      expect(webcodecsEngineEnabled()).toBe(false);
      store.set("webcodecsEngine", "0");
      expect(webcodecsEngineEnabled()).toBe(false);
      store.set("webcodecsEngine", "1");
      expect(webcodecsEngineEnabled()).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });
});
