/**
 * Shared decode-only worker for sample-index-locked RGB bitmaps (opt-in engine).
 *
 * DOM-first: this never owns presentation for alpha preview. v4 RMBG uses a
 * unified ``.proxy.webm`` drawn by ClipColoringCanvas; alpha clips are not
 * decodable here (no H.264 color+matte pair play).
 */

import type { TimelineClip } from "../../../../lib/api";
import { resolvePreviewMedia } from "../mediaProvider";
import { webcodecsSupported } from "./capability";
import { createWebcodecsEngineHost, type WebcodecsEngineHost } from "./engineHost";

let host: WebcodecsEngineHost | null | undefined;
let supported: boolean | null = null;
const registering = new Map<string, Promise<boolean>>();
const registerFailed = new Set<string>();

function getHost(): WebcodecsEngineHost | null {
  if (host === undefined) {
    host = createWebcodecsEngineHost(null);
  }
  return host;
}

/** True when the clip's preview media is a WebCodecs-demuxable H.264 MP4 (no alpha). */
export function clipScrubDecodable(clip: TimelineClip): boolean {
  if (clip.type !== "video") return false;
  // Alpha / RMBG preview is unified WebM or HTTP RGBA — not an MP4 pair.
  if (clip.alphaRelPath?.trim()) return false;
  const proxy = clip.proxyRelPath?.trim() ?? "";
  return proxy.toLowerCase().endsWith(".mp4");
}

async function ensureRegistered(clip: TimelineClip): Promise<boolean> {
  const h = getHost();
  if (!h) return false;
  if (h.registeredClipIds().includes(clip.id)) return true;
  if (registerFailed.has(clip.id)) return false;
  let inFlight = registering.get(clip.id);
  if (!inFlight) {
    const media = resolvePreviewMedia(clip);
    inFlight = h
      .registerClip({
        clipId: clip.id,
        kind: "video",
        rgbUrl: media.rgbUrl,
        alphaUrl: media.alphaUrl,
        alphaKind: media.alphaKind,
      })
      .then((ok) => {
        if (!ok) registerFailed.add(clip.id);
        return ok;
      })
      .finally(() => {
        registering.delete(clip.id);
      });
    registering.set(clip.id, inFlight);
  }
  return inFlight;
}

/**
 * Decode a frame bitmap for `sourceTimeSec` (non-alpha MP4 proxies only).
 * Returns null on underrun / unsupported — caller must hold lastGood.
 */
export async function requestPairedRgbaBitmap(
  clip: TimelineClip,
  sourceTimeSec: number
): Promise<ImageBitmap | null> {
  if (!clipScrubDecodable(clip)) return null;
  if (supported == null) supported = await webcodecsSupported();
  if (!supported) return null;
  const h = getHost();
  if (!h) return null;
  const ok = await ensureRegistered(clip);
  if (!ok) return null;
  return h.scrubFrame(clip.id, sourceTimeSec, clip.coloring);
}

/** Alias for scrub/pause callers. */
export async function scrubRgbaBitmap(
  clip: TimelineClip,
  sourceTimeSec: number
): Promise<ImageBitmap | null> {
  return requestPairedRgbaBitmap(clip, sourceTimeSec);
}

/** Free worker resources for a removed clip (e.g. on unmount). */
export function releaseScrubClip(clipId: string): void {
  host?.releaseClip(clipId);
  registerFailed.delete(clipId);
}
