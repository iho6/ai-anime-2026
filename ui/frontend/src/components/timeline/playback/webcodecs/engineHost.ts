/**
 * Main-thread handle for the WebCodecs compositor worker.
 *
 * The presenter canvas is transferred to the worker once; after that the main
 * thread only sends scene descriptions (playhead-resolved layer rects) and
 * receives render acks with runway telemetry.
 */

import type {
  EngineLayerSpec,
  EngineRenderedReply,
  EngineWorkerMsg,
} from "./engineProtocol";
import type { ClipColoring } from "../../../../lib/api";
import type { PreviewAlphaKind } from "../mediaProvider";

export type EngineRenderResult = Pick<
  EngineRenderedReply,
  "ok" | "missingClipIds" | "runwayFrames"
>;

export type WebcodecsEngineHost = {
  registerClip: (spec: {
    clipId: string;
    kind: "video" | "image";
    rgbUrl: string;
    alphaUrl: string | null;
    alphaKind: PreviewAlphaKind;
  }) => Promise<boolean>;
  releaseClip: (clipId: string) => void;
  registeredClipIds: () => string[];
  render: (
    width: number,
    height: number,
    layers: EngineLayerSpec[]
  ) => Promise<EngineRenderResult>;
  scrubFrame: (
    clipId: string,
    sourceTimeSec: number,
    coloring?: ClipColoring
  ) => Promise<ImageBitmap | null>;
  dispose: () => void;
};

/**
 * Create the engine host. When `canvas` is provided its control is
 * transferred to the worker for rendering; without a canvas the host still
 * supports registerClip/scrubFrame (decode-only mode for scrubbing).
 * Returns null when workers / OffscreenCanvas are unavailable (caller keeps
 * the DOM fallback).
 */
export function createWebcodecsEngineHost(
  canvas: HTMLCanvasElement | null
): WebcodecsEngineHost | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return null;
  }
  let offscreen: OffscreenCanvas | null = null;
  if (canvas) {
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch {
      return null;
    }
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    return null;
  }

  let seq = 0;
  const registered = new Set<string>();
  const pendingRegister = new Map<number, (ok: boolean) => void>();
  const pendingRender = new Map<number, (r: EngineRenderResult) => void>();
  const pendingScrub = new Map<number, (b: ImageBitmap | null) => void>();

  worker.onmessage = (ev: MessageEvent<EngineWorkerMsg>) => {
    const msg = ev.data;
    if (msg.type === "registered") {
      if (msg.ok) registered.add(msg.clipId);
      pendingRegister.get(msg.id)?.(msg.ok);
      pendingRegister.delete(msg.id);
    } else if (msg.type === "rendered") {
      pendingRender.get(msg.id)?.({
        ok: msg.ok,
        missingClipIds: msg.missingClipIds,
        runwayFrames: msg.runwayFrames,
      });
      pendingRender.delete(msg.id);
    } else if (msg.type === "scrubFrame") {
      pendingScrub.get(msg.id)?.(msg.bitmap);
      pendingScrub.delete(msg.id);
    }
  };

  worker.onerror = () => {
    for (const [, r] of pendingRegister) r(false);
    pendingRegister.clear();
    for (const [, r] of pendingRender) {
      r({ ok: false, missingClipIds: [], runwayFrames: {} });
    }
    pendingRender.clear();
    for (const [, r] of pendingScrub) r(null);
    pendingScrub.clear();
  };

  if (offscreen) {
    worker.postMessage({ type: "init", canvas: offscreen }, [offscreen]);
  }

  return {
    registerClip: (spec) =>
      new Promise((resolve) => {
        const id = ++seq;
        pendingRegister.set(id, resolve);
        worker.postMessage({
          type: "registerClip",
          id,
          clipId: spec.clipId,
          kind: spec.kind,
          rgbUrl: spec.rgbUrl,
          alphaUrl: spec.alphaUrl,
          alphaKind: spec.alphaKind,
        });
      }),
    releaseClip: (clipId) => {
      registered.delete(clipId);
      worker.postMessage({ type: "releaseClip", clipId });
    },
    registeredClipIds: () => [...registered],
    render: (width, height, layers) =>
      new Promise((resolve) => {
        const id = ++seq;
        pendingRender.set(id, resolve);
        worker.postMessage({ type: "render", id, width, height, layers });
      }),
    scrubFrame: (clipId, sourceTimeSec, coloring) =>
      new Promise((resolve) => {
        const id = ++seq;
        pendingScrub.set(id, resolve);
        worker.postMessage({
          type: "scrub",
          id,
          clipId,
          sourceTimeSec,
          coloring,
        });
      }),
    dispose: () => {
      worker.postMessage({ type: "dispose" });
      worker.terminate();
      registered.clear();
    },
  };
}
