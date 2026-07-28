/// <reference lib="webworker" />

/**
 * OffscreenCanvas compositor worker — draws layered ImageBitmaps to a FINAL frame.
 */

type CompositorLayerDraw = {
  bitmap: ImageBitmap;
  opacity: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
};

type CompositorRequest = {
  width: number;
  height: number;
  layers: CompositorLayerDraw[];
};

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent) => {
  const data = ev.data as {
    id: number;
    type: string;
    request?: CompositorRequest;
  };
  if (data.type !== "compose" || !data.request) return;
  const req = data.request;
  try {
    const canvas = new OffscreenCanvas(req.width, req.height);
    const c2d = canvas.getContext("2d");
    if (!c2d) {
      ctx.postMessage({ id: data.id, error: "no-2d" });
      return;
    }
    c2d.clearRect(0, 0, req.width, req.height);
    for (const layer of req.layers) {
      c2d.save();
      c2d.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      c2d.drawImage(layer.bitmap, layer.dx, layer.dy, layer.dw, layer.dh);
      c2d.restore();
      try {
        layer.bitmap.close();
      } catch {
        /* ignore */
      }
    }
    const bitmap = canvas.transferToImageBitmap();
    ctx.postMessage({ id: data.id, bitmap }, [bitmap]);
  } catch (e) {
    ctx.postMessage({
      id: data.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
