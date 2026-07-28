/// <reference lib="webworker" />

/**
 * WebCodecs compositor worker.
 *
 * Owns per-clip demuxers + decoders (color and, for alpha clips, a second
 * luma-matte decoder) and an OffscreenCanvas transferred from the presenter.
 * Renders full scenes on demand and answers one-off scrub frame requests.
 */

import { createClipDecoder, type ClipDecoder } from "./clipDecoder";
import { demuxMp4Clip } from "./mp4Demuxer";
import { applyLumaMatteToImageData, readMatteImageData } from "../lumaMatte";
import {
  applyColoringToImageData,
  isDefaultClipColoring,
} from "../../../../lib/clipColoring";
import type { ClipColoring } from "../../../../lib/api";
import type {
  EngineHostMsg,
  EngineLayerSpec,
  EngineRenderedReply,
  EngineWorkerMsg,
} from "./engineProtocol";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

/** Frames to keep decoded ahead of the playhead (promotion needs 12). */
const PREFETCH_AHEAD_FRAMES = 14;
/** Runway value reported when the ring is decoded through end of file. */
const RUNWAY_AT_EOF = 10_000;

type ClipEntry = {
  clipId: string;
  kind: "video" | "image";
  color: ClipDecoder | null;
  alpha: ClipDecoder | null;
  alphaKind: "luma" | "alphaChannel";
  /** Composited (or plain) frame cache for image clips / last video frame. */
  imageBitmap: ImageBitmap | null;
  /** Scratch canvas for alpha compositing at coded size. */
  scratch: OffscreenCanvas | null;
};

const clips = new Map<string, ClipEntry>();
let presentCanvas: OffscreenCanvas | null = null;

function post(msg: EngineWorkerMsg, transfer: Transferable[] = []) {
  scope.postMessage(msg, transfer);
}

async function registerClip(
  id: number,
  clipId: string,
  kind: "video" | "image",
  rgbUrl: string,
  alphaUrl: string | null,
  alphaKind: "luma" | "alphaChannel"
) {
  try {
    releaseClip(clipId);
    if (kind === "image") {
      const res = await fetch(rgbUrl, { mode: "cors" });
      if (!res.ok) throw new Error(`image fetch ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      clips.set(clipId, {
        clipId,
        kind,
        color: null,
        alpha: null,
        alphaKind,
        imageBitmap: bmp,
        scratch: null,
      });
      post({ type: "registered", id, clipId, ok: true });
      return;
    }

    const colorDemux = await demuxMp4Clip(rgbUrl);
    const color = createClipDecoder(colorDemux);
    let alpha: ClipDecoder | null = null;
    if (alphaUrl) {
      try {
        const alphaDemux = await demuxMp4Clip(alphaUrl);
        alpha = createClipDecoder(alphaDemux);
      } catch {
        alpha = null; // color-only fallback; DOM/HTTP path still available
      }
    }
    clips.set(clipId, {
      clipId,
      kind,
      color,
      alpha,
      alphaKind,
      imageBitmap: null,
      scratch: null,
    });
    post({ type: "registered", id, clipId, ok: true });
  } catch (e) {
    post({
      type: "registered",
      id,
      clipId,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function releaseClip(clipId: string) {
  const entry = clips.get(clipId);
  if (!entry) return;
  entry.color?.close();
  entry.alpha?.close();
  entry.imageBitmap?.close();
  clips.delete(clipId);
}

/**
 * Produce the drawable source for a video layer: decoded color frame with the
 * luma matte applied on the entry's scratch canvas when present.
 */
/** Fire-and-forget decode of the GOP holding `sampleIndex` (builds runway). */
function prefetchAhead(decoder: ClipDecoder, fromTimeSec: number) {
  const total = decoder.samples.length;
  if (total === 0) return;
  const target = Math.min(
    total - 1,
    decoder.sampleIndexForTime(fromTimeSec) + PREFETCH_AHEAD_FRAMES
  );
  if (decoder.hasSample(target)) return;
  void decoder.getFrameAtSample(target).catch(() => {});
}

function entryScratchContext(
  entry: ClipEntry,
  w: number,
  h: number
): OffscreenCanvasRenderingContext2D | null {
  if (!entry.scratch || entry.scratch.width !== w || entry.scratch.height !== h) {
    entry.scratch = new OffscreenCanvas(w, h);
  }
  return entry.scratch.getContext("2d", { willReadFrequently: true });
}

async function produceVideoLayerSource(
  entry: ClipEntry,
  sourceTimeSec: number,
  coloring?: ClipColoring
): Promise<CanvasImageSource | null> {
  if (!entry.color) return null;
  // Matte and subject must come from the SAME frame number: resolve the
  // sample index once on the color track and reuse it for the alpha track
  // (both proxies are encoded frame-by-frame in lockstep).
  const sampleIdx = entry.color.sampleIndexForTime(sourceTimeSec);
  const colorFrame = await entry.color.getFrameAtSample(sampleIdx, true);
  // Build forward runway in the background (decoder calls are serialized).
  prefetchAhead(entry.color, sourceTimeSec);
  if (entry.alpha) prefetchAhead(entry.alpha, sourceTimeSec);
  if (!colorFrame) return null;

  const needsColoring = !isDefaultClipColoring(coloring);
  const alphaFrame = entry.alpha
    ? await entry.alpha.getFrameAtSample(sampleIdx, true)
    : null;
  // Paired clips: never return color-only when the matte plane underruns —
  // callers must hold lastGood instead of presenting an unmatched frame.
  if (entry.alpha && !alphaFrame) return null;
  if (!entry.alpha && !needsColoring) return colorFrame;

  const w = colorFrame.displayWidth;
  const h = colorFrame.displayHeight;
  const ctx = entryScratchContext(entry, w, h);
  if (!ctx || !entry.scratch) return colorFrame;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(colorFrame, 0, 0, w, h);

  if (alphaFrame && entry.alphaKind === "alphaChannel") {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(alphaFrame, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }

  const lumaMatte =
    alphaFrame && entry.alphaKind === "luma"
      ? readMatteImageData(alphaFrame, w, h)
      : null;
  if (lumaMatte || needsColoring) {
    // Matte + coloring in a single getImageData/putImageData round trip.
    let frameData: ImageData;
    try {
      frameData = ctx.getImageData(0, 0, w, h);
    } catch {
      return entry.scratch;
    }
    if (lumaMatte) applyLumaMatteToImageData(frameData, lumaMatte);
    if (needsColoring) applyColoringToImageData(frameData, coloring);
    ctx.putImageData(frameData, 0, 0);
  }
  return entry.scratch;
}

/** Image layer source; colored images route through the scratch canvas. */
function produceImageLayerSource(
  entry: ClipEntry,
  coloring?: ClipColoring
): CanvasImageSource | null {
  const bmp = entry.imageBitmap;
  if (!bmp) return null;
  if (isDefaultClipColoring(coloring)) return bmp;
  const w = bmp.width;
  const h = bmp.height;
  const ctx = entryScratchContext(entry, w, h);
  if (!ctx || !entry.scratch) return bmp;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  try {
    const data = ctx.getImageData(0, 0, w, h);
    applyColoringToImageData(data, coloring);
    ctx.putImageData(data, 0, 0);
  } catch {
    return bmp;
  }
  return entry.scratch;
}

/** Consecutive decoded frames ahead of `timeSec` in the color ring. */
function runwayAt(entry: ClipEntry, timeSec: number): number {
  if (!entry.color) return 0;
  const total = entry.color.samples.length;
  const start = entry.color.sampleIndexForTime(timeSec);
  let n = 0;
  while (start + n < total && entry.color.hasSample(start + n)) n += 1;
  // Decoded through EOF: the clip cannot underrun anymore.
  if (start + n >= total) return RUNWAY_AT_EOF;
  return n;
}

async function renderScene(
  id: number,
  width: number,
  height: number,
  layers: EngineLayerSpec[]
) {
  const reply: EngineRenderedReply = {
    type: "rendered",
    id,
    ok: false,
    missingClipIds: [],
    runwayFrames: {},
  };
  if (!presentCanvas) {
    post(reply);
    return;
  }
  if (presentCanvas.width !== width) presentCanvas.width = width;
  if (presentCanvas.height !== height) presentCanvas.height = height;
  const ctx = presentCanvas.getContext("2d");
  if (!ctx) {
    post(reply);
    return;
  }

  // Produce all layer sources first so the canvas swap is atomic.
  const produced: Array<{
    layer: EngineLayerSpec;
    source: CanvasImageSource | null;
  }> = [];
  for (const layer of layers) {
    const entry = clips.get(layer.clipId);
    if (!entry) {
      produced.push({ layer, source: null });
      reply.missingClipIds.push(layer.clipId);
      continue;
    }
    if (entry.kind === "image") {
      const imageSource = produceImageLayerSource(entry, layer.coloring);
      produced.push({ layer, source: imageSource });
      if (!imageSource) reply.missingClipIds.push(layer.clipId);
      continue;
    }
    const source = await produceVideoLayerSource(
      entry,
      layer.sourceTimeSec,
      layer.coloring
    );
    produced.push({ layer, source });
    if (!source) reply.missingClipIds.push(layer.clipId);
    reply.runwayFrames[layer.clipId] = runwayAt(entry, layer.sourceTimeSec);
  }

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  for (const { layer, source } of produced) {
    if (!source) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
    if (layer.rotationDeg !== 0) {
      const cx = layer.dx + layer.dw / 2;
      const cy = layer.dy + layer.dh / 2;
      ctx.translate(cx, cy);
      ctx.rotate((layer.rotationDeg * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    ctx.drawImage(source, layer.dx, layer.dy, layer.dw, layer.dh);
    ctx.restore();
  }

  reply.ok = reply.missingClipIds.length === 0;
  post(reply);
}

async function scrubFrame(
  id: number,
  clipId: string,
  sourceTimeSec: number,
  coloring?: ClipColoring
) {
  const entry = clips.get(clipId);
  if (!entry || entry.kind !== "video") {
    post({ type: "scrubFrame", id, clipId, bitmap: null });
    return;
  }
  const source = await produceVideoLayerSource(entry, sourceTimeSec, coloring);
  if (!source) {
    post({ type: "scrubFrame", id, clipId, bitmap: null });
    return;
  }
  try {
    const bitmap = await createImageBitmap(source as ImageBitmapSource);
    post({ type: "scrubFrame", id, clipId, bitmap }, [bitmap]);
  } catch {
    post({ type: "scrubFrame", id, clipId, bitmap: null });
  }
}

scope.onmessage = (ev: MessageEvent<EngineHostMsg>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      presentCanvas = msg.canvas;
      break;
    case "registerClip":
      void registerClip(
        msg.id,
        msg.clipId,
        msg.kind,
        msg.rgbUrl,
        msg.alphaUrl,
        msg.alphaKind
      );
      break;
    case "releaseClip":
      releaseClip(msg.clipId);
      break;
    case "render":
      void renderScene(msg.id, msg.width, msg.height, msg.layers);
      break;
    case "scrub":
      void scrubFrame(msg.id, msg.clipId, msg.sourceTimeSec, msg.coloring);
      break;
    case "dispose":
      for (const clipId of [...clips.keys()]) releaseClip(clipId);
      presentCanvas = null;
      break;
  }
};
