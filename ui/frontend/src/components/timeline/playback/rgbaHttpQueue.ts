/**
 * Shared fair HTTP queue for scrub-time clip-rgba-frame fetches.
 * Keeps stacked alpha scrubs from permanently starving one clipId.
 */

import { createFairPrefetchQueue, type FairPrefetchQueue } from "./fairPrefetchQueue";

let shared: FairPrefetchQueue | null = null;

export function getRgbaHttpQueue(): FairPrefetchQueue {
  if (!shared) shared = createFairPrefetchQueue(2);
  return shared;
}

/** Test helper — reset singleton between tests. */
export function resetRgbaHttpQueueForTests(): void {
  shared?.clear();
  shared = null;
}
