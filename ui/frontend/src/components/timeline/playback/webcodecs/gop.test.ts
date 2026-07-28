import { describe, expect, it } from "vitest";
import {
  gopEndIndex,
  gopStartIndex,
  ringRetainRange,
  sampleIndexForTime,
  type DemuxedSampleMeta,
} from "./gop";

function makeSamples(count: number, gop: number, fps = 24): DemuxedSampleMeta[] {
  return Array.from({ length: count }, (_v, i) => ({
    index: i,
    isSync: i % gop === 0,
    ctsSec: i / fps,
    durationSec: 1 / fps,
  }));
}

describe("gopStartIndex / gopEndIndex", () => {
  const samples = makeSamples(36, 12);

  it("keyframe maps to itself", () => {
    expect(gopStartIndex(samples, 12)).toBe(12);
    expect(gopStartIndex(samples, 0)).toBe(0);
  });

  it("delta frame maps back to its sync sample", () => {
    expect(gopStartIndex(samples, 13)).toBe(12);
    expect(gopStartIndex(samples, 23)).toBe(12);
    expect(gopStartIndex(samples, 11)).toBe(0);
  });

  it("end is the next sync (exclusive) or total length", () => {
    expect(gopEndIndex(samples, 13)).toBe(24);
    expect(gopEndIndex(samples, 25)).toBe(36);
  });

  it("clamps out-of-range indices", () => {
    expect(gopStartIndex(samples, -5)).toBe(0);
    expect(gopStartIndex(samples, 999)).toBe(24);
  });
});

describe("sampleIndexForTime", () => {
  const samples = makeSamples(48, 12, 24);

  it("start / end clamp", () => {
    expect(sampleIndexForTime(samples, -1)).toBe(0);
    expect(sampleIndexForTime(samples, 100)).toBe(47);
  });

  it("exact frame times map to the frame", () => {
    expect(sampleIndexForTime(samples, 0)).toBe(0);
    expect(sampleIndexForTime(samples, 12 / 24)).toBe(12);
  });

  it("mid-interval times map to the covering frame", () => {
    expect(sampleIndexForTime(samples, 12.5 / 24)).toBe(12);
    expect(sampleIndexForTime(samples, 12.99 / 24)).toBe(12);
  });

  it("empty samples fall back to 0", () => {
    expect(sampleIndexForTime([], 1)).toBe(0);
  });
});

describe("sample-index lock (color + alpha)", () => {
  it("lockstep proxies share one sample index for a given time", () => {
    // Color and alpha H.264 pairs are encoded frame-by-frame in lockstep;
    // both tracks must be fetched with the same index, not independent
    // time lookups that can round differently under tiny CTS drift.
    const color = makeSamples(48, 12, 24);
    const alpha = makeSamples(48, 12, 24);
    for (const t of [0, 0.1, 0.42, 1.0, 1.999]) {
      const idx = sampleIndexForTime(color, t);
      expect(sampleIndexForTime(alpha, t)).toBe(idx);
    }
  });
});

describe("ringRetainRange", () => {
  it("is ahead-biased around the playhead", () => {
    const { from, to } = ringRetainRange(20, 16, 1000);
    expect(from).toBe(16); // 4 behind
    expect(to).toBe(31); // 12 ahead
  });

  it("clamps at file boundaries", () => {
    expect(ringRetainRange(0, 16, 1000)).toEqual({ from: 0, to: 15 });
    const tail = ringRetainRange(999, 16, 1000);
    expect(tail.to).toBe(999);
    expect(tail.from).toBeGreaterThanOrEqual(0);
  });

  it("handles tiny files", () => {
    expect(ringRetainRange(0, 16, 3)).toEqual({ from: 0, to: 2 });
  });
});
