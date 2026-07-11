import { describe, expect, it } from "vitest";
import {
  frameIdxFromSourceTime,
  planAlphaFrameFetch,
  planAlphaFrameFetchAfterComplete,
  planAlphaFrameFetchAfterError,
  resetAlphaFrameFetchState,
} from "./alphaFrameFetch";

describe("frameIdxFromSourceTime", () => {
  it("rounds source time to frame index", () => {
    expect(frameIdxFromSourceTime(0, 24)).toBe(0);
    expect(frameIdxFromSourceTime(0.5 / 24, 24)).toBe(1);
    expect(frameIdxFromSourceTime(1, 24)).toBe(24);
  });
});

describe("planAlphaFrameFetch", () => {
  it("starts fetch when frame not yet painted", () => {
    const state = resetAlphaFrameFetchState();
    const { state: next, plan } = planAlphaFrameFetch(state, 5);
    expect(plan).toEqual({ action: "fetch", frameIdx: 5 });
    expect(next.inFlight).toBe(true);
    expect(next.inFlightFrame).toBe(5);
    expect(next.pendingFrame).toBe(5);
  });

  it("skips fetch when frame already painted", () => {
    const state = {
      ...resetAlphaFrameFetchState(),
      lastPaintedFrame: 5,
      pendingFrame: 5,
    };
    const { plan } = planAlphaFrameFetch(state, 5);
    expect(plan).toEqual({ action: "none" });
  });

  it("force-fetches a frame even when it was previously painted", () => {
    const state = {
      ...resetAlphaFrameFetchState(),
      lastPaintedFrame: 5,
      pendingFrame: 5,
    };
    const { plan } = planAlphaFrameFetch(state, 5, { force: true });
    expect(plan).toEqual({ action: "fetch", frameIdx: 5 });
  });

  it("coalesces while in-flight (updates pending, no second start)", () => {
    const state = {
      ...resetAlphaFrameFetchState(),
      inFlight: true,
      inFlightFrame: 3,
      pendingFrame: 3,
    };
    const { state: next, plan } = planAlphaFrameFetch(state, 7);
    expect(plan).toEqual({ action: "none" });
    expect(next.inFlight).toBe(true);
    expect(next.pendingFrame).toBe(7);
  });

  it("requests lower frame index on backward scrub", () => {
    const state = {
      ...resetAlphaFrameFetchState(),
      lastPaintedFrame: 10,
      pendingFrame: 10,
    };
    const { plan } = planAlphaFrameFetch(state, 2);
    expect(plan).toEqual({ action: "fetch", frameIdx: 2 });
  });
});

describe("planAlphaFrameFetchAfterComplete", () => {
  it("catch-up fetch when pending advanced during in-flight", () => {
    const state = {
      lastPaintedFrame: null,
      pendingFrame: 8,
      inFlight: true,
      inFlightFrame: 5,
    };
    const { state: next, plan } = planAlphaFrameFetchAfterComplete(state, 5);
    expect(next.lastPaintedFrame).toBe(5);
    expect(next.inFlight).toBe(true);
    expect(plan).toEqual({ action: "fetch", frameIdx: 8 });
  });

  it("no catch-up when pending matches completed frame", () => {
    const state = {
      lastPaintedFrame: null,
      pendingFrame: 5,
      inFlight: true,
      inFlightFrame: 5,
    };
    const { state: next, plan } = planAlphaFrameFetchAfterComplete(state, 5);
    expect(next.lastPaintedFrame).toBe(5);
    expect(next.inFlight).toBe(false);
    expect(plan).toEqual({ action: "none" });
  });
});

describe("planAlphaFrameFetchAfterError", () => {
  it("clears in-flight without changing last painted", () => {
    const state = {
      lastPaintedFrame: 4,
      pendingFrame: 9,
      inFlight: true,
      inFlightFrame: 9,
    };
    const next = planAlphaFrameFetchAfterError(state);
    expect(next.inFlight).toBe(false);
    expect(next.inFlightFrame).toBe(null);
    expect(next.lastPaintedFrame).toBe(4);
  });
});
