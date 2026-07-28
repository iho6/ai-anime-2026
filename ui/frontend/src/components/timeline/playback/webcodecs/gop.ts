/**
 * Pure GOP / sample-index math for the WebCodecs decode core.
 * Kept free of WebCodecs / mp4box so it is unit-testable in node.
 */

export type DemuxedSampleMeta = {
  /** Sample index in decode order. */
  index: number;
  /** True when the sample is a random-access point (keyframe). */
  isSync: boolean;
  /** Composition timestamp in seconds. */
  ctsSec: number;
  /** Sample duration in seconds. */
  durationSec: number;
};

/** Index of the sync sample that starts the GOP containing `sampleIndex`. */
export function gopStartIndex(
  samples: ReadonlyArray<Pick<DemuxedSampleMeta, "isSync">>,
  sampleIndex: number
): number {
  const clamped = Math.max(0, Math.min(samples.length - 1, sampleIndex));
  for (let i = clamped; i >= 0; i--) {
    if (samples[i]!.isSync) return i;
  }
  return 0;
}

/** Exclusive end of the GOP containing `sampleIndex` (next sync or length). */
export function gopEndIndex(
  samples: ReadonlyArray<Pick<DemuxedSampleMeta, "isSync">>,
  sampleIndex: number
): number {
  const start = gopStartIndex(samples, sampleIndex);
  for (let i = start + 1; i < samples.length; i++) {
    if (samples[i]!.isSync) return i;
  }
  return samples.length;
}

/**
 * Sample whose presentation interval contains `timeSec` (samples assumed
 * sorted by cts, as produced by our constant-frame-rate proxies).
 */
export function sampleIndexForTime(
  samples: ReadonlyArray<Pick<DemuxedSampleMeta, "ctsSec" | "durationSec">>,
  timeSec: number
): number {
  if (samples.length === 0) return 0;
  if (timeSec <= samples[0]!.ctsSec) return 0;
  const last = samples[samples.length - 1]!;
  if (timeSec >= last.ctsSec) return samples.length - 1;

  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid]!.ctsSec <= timeSec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Frames to retain around the playhead in the decoder ring buffer.
 * Ahead-biased: playback consumes forward.
 */
export function ringRetainRange(
  centerIndex: number,
  capacity: number,
  totalSamples: number
): { from: number; to: number } {
  const behind = Math.max(1, Math.floor(capacity / 4));
  const from = Math.max(0, centerIndex - behind);
  const to = Math.min(totalSamples - 1, from + capacity - 1);
  return { from: Math.max(0, Math.min(from, to)), to };
}
