/**
 * Main-thread compositor presenter: blits FINAL ImageBitmaps; optionally
 * forwards work to an OffscreenCanvas worker when available.
 */

export type CompositorLayerDraw = {
  bitmap: ImageBitmap;
  opacity: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
};

export type CompositorRequest = {
  width: number;
  height: number;
  layers: CompositorLayerDraw[];
};

function composeOnCanvas2D(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  req: CompositorRequest
): void {
  const ctx = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) return;
  if ("width" in canvas) {
    if (canvas.width !== req.width) canvas.width = req.width;
    if (canvas.height !== req.height) canvas.height = req.height;
  }
  ctx.clearRect(0, 0, req.width, req.height);
  for (const layer of req.layers) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
    ctx.drawImage(layer.bitmap, layer.dx, layer.dy, layer.dw, layer.dh);
    ctx.restore();
  }
}

/** Synchronous main-thread compose into an HTMLCanvasElement. */
export function presentComposedFrame(
  canvas: HTMLCanvasElement,
  req: CompositorRequest
): void {
  composeOnCanvas2D(canvas, req);
}

export type CompositorWorkerHandle = {
  compose: (req: CompositorRequest) => Promise<ImageBitmap | null>;
  dispose: () => void;
};

/**
 * Spawn compositor worker if the environment supports module workers.
 * Falls back to null — callers use presentComposedFrame on the main thread.
 */
export function createCompositorWorker(): CompositorWorkerHandle | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return null;
  }
  try {
    const worker = new Worker(new URL("./compositor.worker.ts", import.meta.url), {
      type: "module",
    });
    let seq = 0;
    const pending = new Map<
      number,
      { resolve: (v: ImageBitmap | null) => void; reject: (e: unknown) => void }
    >();

    worker.onmessage = (ev: MessageEvent) => {
      const data = ev.data as {
        id?: number;
        bitmap?: ImageBitmap;
        error?: string;
      };
      if (data.id == null) return;
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) {
        p.resolve(null);
        return;
      }
      p.resolve(data.bitmap ?? null);
    };

    worker.onerror = () => {
      for (const [, p] of pending) p.resolve(null);
      pending.clear();
    };

    return {
      compose: (req) =>
        new Promise((resolve, reject) => {
          const id = ++seq;
          pending.set(id, { resolve, reject });
          const transfer: Transferable[] = req.layers.map((l) => l.bitmap);
          worker.postMessage({ id, type: "compose", request: req }, transfer);
        }),
      dispose: () => {
        worker.terminate();
        pending.clear();
      },
    };
  } catch {
    return null;
  }
}
