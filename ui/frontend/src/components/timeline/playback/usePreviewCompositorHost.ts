"use client";

/**
 * Host for the OffscreenCanvas compositor worker + FINAL frame cache.
 * Available for progressive migration off stacked DOM <video> layers.
 */

import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { createFrameStageCache, type FrameStageCache } from "./frameStageCache";
import {
  createCompositorWorker,
  presentComposedFrame,
  type CompositorRequest,
  type CompositorWorkerHandle,
} from "./compositorPresenter";

export type PreviewCompositorHostHandle = {
  cache: FrameStageCache;
  present: (req: CompositorRequest) => Promise<ImageBitmap | null>;
};

export function usePreviewCompositorHost(): {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  hostRef: MutableRefObject<PreviewCompositorHostHandle | null>;
} {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<CompositorWorkerHandle | null>(null);
  const hostRef = useRef<PreviewCompositorHostHandle | null>(null);

  useEffect(() => {
    const cache = createFrameStageCache(96);
    workerRef.current = createCompositorWorker();
    hostRef.current = {
      cache,
      present: async (req) => {
        const worker = workerRef.current;
        if (worker) {
          const bmp = await worker.compose(req);
          if (bmp) return bmp;
        }
        const canvas = canvasRef.current;
        if (canvas) {
          presentComposedFrame(canvas, req);
          if (typeof createImageBitmap === "function") {
            return createImageBitmap(canvas);
          }
        }
        return null;
      },
    };
    return () => {
      workerRef.current?.dispose();
      workerRef.current = null;
      cache.clear();
      hostRef.current = null;
    };
  }, []);

  return { canvasRef, hostRef };
}
