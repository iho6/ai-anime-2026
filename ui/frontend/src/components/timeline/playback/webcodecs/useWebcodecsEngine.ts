"use client";

/**
 * WebCodecs preview engine hook (experimental / opt-in).
 *
 * DOM-first revamp: presentation ownership is forced off. The worker may still
 * warm-decode in a later phase when explicitly enabled via localStorage, but it
 * must never hide the DOM stack. Scrub assist lives in scrubService.ts
 * independently of this hook.
 */

import { useMemo } from "react";

/** Opt-in flag: localStorage webcodecsEngine=1 enables experimental warm-decode. */
export function webcodecsEngineEnabled(): boolean {
  try {
    const store =
      (typeof window !== "undefined" ? window.localStorage : null) ??
      (typeof globalThis !== "undefined" &&
      "localStorage" in globalThis &&
      globalThis.localStorage
        ? globalThis.localStorage
        : null);
    if (!store) return false;
    return store.getItem("webcodecsEngine") === "1";
  } catch {
    return false;
  }
}

export function useWebcodecsEngine(_options: {
  manifest: unknown;
  playing: boolean;
  playhead: number;
  frameSize: { w: number; h: number };
  bakeActive: boolean;
}): {
  canvasRef: (el: HTMLCanvasElement | null) => void;
  engineOwnsPresentation: boolean;
} {
  // Reserved for a future opt-in warm-decode loop; ownership stays off.
  void useMemo(() => webcodecsEngineEnabled(), []);

  return {
    canvasRef: (_el) => {
      /* canvas kept for future opt-in; control not transferred while ownership is off */
    },
    // Always false this revamp phase — DOM stack is presentation truth.
    engineOwnsPresentation: false,
  };
}
