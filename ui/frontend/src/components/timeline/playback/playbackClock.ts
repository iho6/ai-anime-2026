/**
 * Integer-frame playback clock (NLE-style timebase).
 * Wall/playhead seconds still live in PlayheadStore; resolve/compose go through frames.
 */

import type { PlayheadStore } from "../timelinePlayback";

export type PlaybackClock = {
  fps: number;
  /** Timeline frame index at (or just before) the given seconds. */
  frameAtSec: (sec: number) => number;
  /** Start time (seconds) of a timeline frame. */
  secAtFrame: (frame: number) => number;
  /** Current frame from an underlying seconds store. */
  currentFrame: () => number;
  /** Seek the seconds store to the start of a frame. */
  seekFrame: (frame: number) => void;
};

export function createPlaybackClock(
  fps: number,
  playheadStore: PlayheadStore
): PlaybackClock {
  const rate = Math.max(1, Math.round(fps) || 24);
  return {
    fps: rate,
    frameAtSec: (sec: number) => Math.max(0, Math.floor(sec * rate + 1e-9)),
    secAtFrame: (frame: number) => Math.max(0, frame) / rate,
    currentFrame: () => Math.max(0, Math.floor(playheadStore.get() * rate + 1e-9)),
    seekFrame: (frame: number) => {
      playheadStore.set(Math.max(0, frame) / rate);
    },
  };
}

export function timelineFrameCount(durationSec: number, fps: number): number {
  const rate = Math.max(1, Math.round(fps) || 24);
  return Math.max(0, Math.ceil(Math.max(0, durationSec) * rate));
}
