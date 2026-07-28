/**
 * Per-clip WebCodecs decoder with a small VideoFrame ring buffer.
 *
 * Random access decodes only the GOP containing the target sample (proxy GOP
 * is 12, so at most ~12 frames per seek). Sequential playback hits the ring
 * for frames inside the current GOP and decodes the next GOP on crossing.
 *
 * Note: WebCodecs requires a key chunk after every flush(), so each decode
 * pass always starts at a sync sample (GOP start).
 */

import {
  gopEndIndex,
  gopStartIndex,
  ringRetainRange,
  sampleIndexForTime,
  type DemuxedSampleMeta,
} from "./gop";
import type { DemuxedClip } from "./mp4Demuxer";

// Sized so the ring can hold the current GOP plus a decoded runway ahead
// (promotion requires 12 future frames; GOP is 12). ~480p frames are cheap.
export const DEFAULT_RING_CAPACITY = 24;

export type ClipDecoder = {
  /**
   * Decoded frame for the sample covering `timeSec`, or null on failure.
   * The frame is BORROWED from the ring: draw it synchronously and do not
   * close it; it stays valid until the next getFrame* call.
   */
  getFrameAtTime: (timeSec: number) => Promise<VideoFrame | null>;
  /**
   * Decoded frame for an explicit sample index (same borrow contract).
   * Pass isPlayhead=true when the index is the current playback position so
   * the ring's eviction window follows it (false = prefetch, no re-anchor).
   */
  getFrameAtSample: (
    sampleIndex: number,
    isPlayhead?: boolean
  ) => Promise<VideoFrame | null>;
  sampleIndexForTime: (timeSec: number) => number;
  /** True when the sample is already decoded (used for runway checks). */
  hasSample: (sampleIndex: number) => boolean;
  samples: ReadonlyArray<DemuxedSampleMeta>;
  close: () => void;
};

export function createClipDecoder(
  demuxed: DemuxedClip,
  capacity: number = DEFAULT_RING_CAPACITY
): ClipDecoder {
  const ring = new Map<number, VideoFrame>();
  let decoder: VideoDecoder | null = null;
  /** Sample index expected from the next decoder output (decode order). */
  let nextOutputIndex = -1;
  /** Last playhead sample (eviction anchor; prefetch must not evict it). */
  let centerIndex = 0;
  let pending: Promise<unknown> = Promise.resolve();
  let closed = false;

  const evictOutside = () => {
    const { from, to } = ringRetainRange(
      centerIndex,
      capacity,
      demuxed.samples.length
    );
    for (const [idx, frame] of ring) {
      if (idx < from || idx > to) {
        frame.close();
        ring.delete(idx);
      }
    }
  };

  const store = (index: number, frame: VideoFrame) => {
    const prev = ring.get(index);
    if (prev) prev.close();
    ring.set(index, frame);
  };

  const ensureDecoder = (): VideoDecoder => {
    if (decoder && decoder.state === "configured") return decoder;
    if (decoder && decoder.state !== "closed") {
      try {
        decoder.close();
      } catch {
        /* ignore */
      }
    }
    decoder = new VideoDecoder({
      output: (frame) => {
        if (closed || nextOutputIndex < 0) {
          frame.close();
          return;
        }
        store(nextOutputIndex, frame);
        nextOutputIndex += 1;
      },
      error: () => {
        nextOutputIndex = -1;
      },
    });
    decoder.configure(demuxed.decoderConfig());
    return decoder;
  };

  const decodeGopRange = async (from: number, toInclusive: number) => {
    const dec = ensureDecoder();
    nextOutputIndex = from;
    for (let i = from; i <= toInclusive; i++) {
      dec.decode(new EncodedVideoChunk(demuxed.chunkAt(i)));
    }
    await dec.flush();
    nextOutputIndex = -1;
  };

  const ensureSample = async (
    sampleIndex: number,
    isPlayheadRequest: boolean
  ): Promise<VideoFrame | null> => {
    if (closed || demuxed.samples.length === 0) return null;
    const idx = Math.max(0, Math.min(demuxed.samples.length - 1, sampleIndex));
    if (isPlayheadRequest) centerIndex = idx;
    const hit = ring.get(idx);
    if (hit) return hit;

    const gopFrom = gopStartIndex(demuxed.samples, idx);
    const gopTo = gopEndIndex(demuxed.samples, idx) - 1;
    try {
      await decodeGopRange(gopFrom, Math.min(gopTo, gopFrom + capacity - 1));
    } catch {
      // Decoder threw (corrupt chunk / hardware reset): rebuild next call.
      if (decoder && decoder.state !== "closed") {
        try {
          decoder.close();
        } catch {
          /* ignore */
        }
      }
      decoder = null;
      return null;
    }
    evictOutside();
    return ring.get(idx) ?? null;
  };

  const serialized = (work: () => Promise<VideoFrame | null>) => {
    const next = pending.then(work, work);
    pending = next.catch(() => undefined);
    return next;
  };

  return {
    getFrameAtTime: (timeSec) =>
      serialized(() =>
        ensureSample(sampleIndexForTime(demuxed.samples, timeSec), true)
      ),
    getFrameAtSample: (sampleIndex, isPlayhead = false) =>
      serialized(() => ensureSample(sampleIndex, isPlayhead)),
    sampleIndexForTime: (timeSec) => sampleIndexForTime(demuxed.samples, timeSec),
    hasSample: (sampleIndex) => ring.has(sampleIndex),
    samples: demuxed.samples,
    close: () => {
      closed = true;
      for (const frame of ring.values()) frame.close();
      ring.clear();
      if (decoder && decoder.state !== "closed") {
        try {
          decoder.close();
        } catch {
          /* ignore */
        }
      }
      decoder = null;
    },
  };
}
