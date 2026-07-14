/**
 * Live playhead store shared between the preview player, the track ruler, and
 * the time readout.
 *
 * During playback the preview player's rAF updates this store ~60x/sec. Only
 * components that subscribe (via {@link usePlayheadValue}) re-render on those
 * ticks, so the large timeline page tree does not reconcile every frame. The
 * page mirrors the value into React state on a throttled cadence for effects /
 * memos that depend on the playhead, and reads the always-current value from
 * the store for event handlers (split, paste, nudge, drop).
 */

import { useSyncExternalStore } from "react";

export type PlayheadStore = {
  get: () => number;
  set: (value: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createPlayheadStore(initial = 0): PlayheadStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: number) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Subscribe a component to live playhead updates. */
export function usePlayheadValue(store: PlayheadStore): number {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
