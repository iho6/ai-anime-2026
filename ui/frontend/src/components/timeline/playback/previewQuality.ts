/**
 * Premiere-style playback vs paused preview quality policy.
 *
 * Playback resolves at reduced scale for the unified PreviewEngine.
 * Hold-step stays per-clip (frameEdit.timelineViewStep) — no scene-wide override.
 */

import { countActiveAlphaLayers, type ResolvedScene } from "./resolveScene";

export type PreviewQualityMode = "playback" | "paused";

export type PreviewQualityPolicy = {
  mode: PreviewQualityMode;
  /** When true, skip getImageData coloring (draw source directly). Always false today. */
  skipPixelColoring: boolean;
  /** Scale factor for PreviewEngine producer downscale (1 = full proxy). */
  resolveScale: number;
};

export function previewQualityPolicy(
  playing: boolean,
  scene: ResolvedScene | null
): PreviewQualityPolicy {
  const mode: PreviewQualityMode = playing ? "playback" : "paused";
  // Touch scene so callers can pass resolvedScene for future policy inputs.
  void (scene ? countActiveAlphaLayers(scene) : 0);

  return {
    mode,
    // Coloring runs at ~480p proxy resolution on the DOM path (ClipColoringCanvas).
    // Keep it on during play for correctness; WebCodecs does not own presentation.
    skipPixelColoring: false,
    resolveScale: playing ? 0.5 : 1,
  };
}
