/** Pure helpers for coalesced alpha-frame RGBA fetches during timeline preview. */

export type AlphaFrameFetchState = {
  lastPaintedFrame: number | null;
  pendingFrame: number | null;
  inFlight: boolean;
  inFlightFrame: number | null;
};

export type AlphaFrameFetchPlan =
  | { action: "none" }
  | { action: "fetch"; frameIdx: number };

export function frameIdxFromSourceTime(sourceTimeSec: number, fps: number): number {
  return Math.max(0, Math.round(sourceTimeSec * Math.max(1, fps)));
}

export function resetAlphaFrameFetchState(): AlphaFrameFetchState {
  return {
    lastPaintedFrame: null,
    pendingFrame: null,
    inFlight: false,
    inFlightFrame: null,
  };
}

/** Decide whether to start a fetch for the latest desired frame index. */
export function planAlphaFrameFetch(
  state: AlphaFrameFetchState,
  frameIdx: number,
  options?: { force?: boolean }
): { state: AlphaFrameFetchState; plan: AlphaFrameFetchPlan } {
  const nextPending = frameIdx;

  if (state.inFlight) {
    return {
      state: { ...state, pendingFrame: nextPending },
      plan: { action: "none" },
    };
  }

  if (!options?.force && state.lastPaintedFrame === frameIdx) {
    return {
      state: { ...state, pendingFrame: nextPending },
      plan: { action: "none" },
    };
  }

  return {
    state: {
      ...state,
      pendingFrame: nextPending,
      inFlight: true,
      inFlightFrame: frameIdx,
    },
    plan: { action: "fetch", frameIdx },
  };
}

/** After a successful paint, catch up to any newer pending frame. */
export function planAlphaFrameFetchAfterComplete(
  state: AlphaFrameFetchState,
  completedFrameIdx: number
): { state: AlphaFrameFetchState; plan: AlphaFrameFetchPlan } {
  const cleared: AlphaFrameFetchState = {
    ...state,
    lastPaintedFrame: completedFrameIdx,
    inFlight: false,
    inFlightFrame: null,
  };
  const pending = cleared.pendingFrame;
  if (pending != null && pending !== completedFrameIdx) {
    return planAlphaFrameFetch(cleared, pending);
  }
  return { state: cleared, plan: { action: "none" } };
}

/** Clear in-flight flag after a failed fetch (keep last painted frame). */
export function planAlphaFrameFetchAfterError(
  state: AlphaFrameFetchState
): AlphaFrameFetchState {
  return { ...state, inFlight: false, inFlightFrame: null };
}
