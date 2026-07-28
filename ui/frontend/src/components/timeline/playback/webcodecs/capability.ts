/**
 * WebCodecs capability probe. The engine only activates when H.264 decode is
 * actually supported; otherwise the DOM stack remains the presentation path.
 */

let cached: Promise<boolean> | null = null;

/** Representative config for our proxies (H.264 baseline-ish, 480p). */
const PROBE_CONFIG: VideoDecoderConfig = {
  codec: "avc1.42E01F",
  codedWidth: 854,
  codedHeight: 480,
};

export function webcodecsSupported(): Promise<boolean> {
  if (cached) return cached;
  cached = (async () => {
    if (
      typeof VideoDecoder === "undefined" ||
      typeof EncodedVideoChunk === "undefined" ||
      typeof OffscreenCanvas === "undefined"
    ) {
      return false;
    }
    try {
      const support = await VideoDecoder.isConfigSupported(PROBE_CONFIG);
      return Boolean(support.supported);
    } catch {
      return false;
    }
  })();
  return cached;
}

/** Support check for a concrete demuxed clip config. */
export async function decoderConfigSupported(
  config: VideoDecoderConfig
): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") return false;
  try {
    const support = await VideoDecoder.isConfigSupported(config);
    return Boolean(support.supported);
  } catch {
    return false;
  }
}
