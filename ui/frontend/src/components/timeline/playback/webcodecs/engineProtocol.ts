/**
 * Message protocol between the preview engine host (main thread) and the
 * WebCodecs compositor worker.
 */

import type { ClipColoring } from "../../../../lib/api";

export type EngineAlphaKind = "luma" | "alphaChannel";

export type EngineLayerSpec = {
  clipId: string;
  kind: "video" | "image";
  /** Source media time in seconds (video only). */
  sourceTimeSec: number;
  /** 0..1 layer opacity (clip transform x transition). */
  opacity: number;
  /** Destination rect in presenter canvas pixels. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  rotationDeg: number;
  /** Per-frame pixel coloring (stateless — sent with every request). */
  coloring?: ClipColoring;
};

export type EngineInitMsg = {
  type: "init";
  canvas: OffscreenCanvas;
};

export type EngineRegisterClipMsg = {
  type: "registerClip";
  id: number;
  clipId: string;
  kind: "video" | "image";
  rgbUrl: string;
  alphaUrl: string | null;
  alphaKind: EngineAlphaKind;
};

export type EngineReleaseClipMsg = {
  type: "releaseClip";
  clipId: string;
};

export type EngineRenderMsg = {
  type: "render";
  id: number;
  width: number;
  height: number;
  layers: EngineLayerSpec[];
};

export type EngineScrubMsg = {
  type: "scrub";
  id: number;
  clipId: string;
  sourceTimeSec: number;
  coloring?: ClipColoring;
};

export type EngineDisposeMsg = { type: "dispose" };

export type EngineHostMsg =
  | EngineInitMsg
  | EngineRegisterClipMsg
  | EngineReleaseClipMsg
  | EngineRenderMsg
  | EngineScrubMsg
  | EngineDisposeMsg;

export type EngineRegisteredReply = {
  type: "registered";
  id: number;
  clipId: string;
  ok: boolean;
  error?: string;
};

export type EngineRenderedReply = {
  type: "rendered";
  id: number;
  ok: boolean;
  /** Clips whose frame could not be produced this render. */
  missingClipIds: string[];
  /** Consecutive decoded frames available ahead, per video clip. */
  runwayFrames: Record<string, number>;
};

export type EngineScrubReply = {
  type: "scrubFrame";
  id: number;
  clipId: string;
  bitmap: ImageBitmap | null;
};

export type EngineWorkerMsg =
  | EngineRegisteredReply
  | EngineRenderedReply
  | EngineScrubReply;
