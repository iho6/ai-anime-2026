/**
 * Fair round-robin prefetch queue: work tagged by clipId so no clip starves
 * under limited concurrency (fixes permanent laggy-subset under MAX_ACTIVE lottery).
 */

export type FairQueueJob<T = void> = {
  /** Fairness key — typically clipId; empty string for scene-level compose. */
  key: string;
  /** Lower = sooner (e.g. distance from playhead). */
  priority: number;
  run: () => Promise<T>;
};

export type FairPrefetchQueue = {
  enqueue: <T>(job: FairQueueJob<T>) => Promise<T>;
  /** Drop pending jobs (in-flight continues until settle). */
  clear: () => void;
  pendingCount: () => number;
  inFlightCount: () => number;
};

type InternalJob = {
  key: string;
  priority: number;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

/**
 * Round-robin across keys: among ready keys, pick the one least recently served,
 * then take its highest-priority (lowest number) job.
 */
export function createFairPrefetchQueue(concurrency = 2): FairPrefetchQueue {
  const limit = Math.max(1, Math.floor(concurrency));
  const buckets = new Map<string, InternalJob[]>();
  const keyOrder: string[] = [];
  let rrCursor = 0;
  let inFlight = 0;

  const ensureKey = (key: string) => {
    if (!buckets.has(key)) {
      buckets.set(key, []);
      keyOrder.push(key);
    }
  };

  const popNext = (): InternalJob | null => {
    if (keyOrder.length === 0) return null;
    for (let attempt = 0; attempt < keyOrder.length; attempt++) {
      const idx = (rrCursor + attempt) % keyOrder.length;
      const key = keyOrder[idx]!;
      const bucket = buckets.get(key);
      if (!bucket || bucket.length === 0) continue;
      bucket.sort((a, b) => a.priority - b.priority);
      const job = bucket.shift()!;
      rrCursor = (idx + 1) % keyOrder.length;
      if (bucket.length === 0) {
        buckets.delete(key);
        keyOrder.splice(idx, 1);
        if (keyOrder.length > 0) rrCursor = rrCursor % keyOrder.length;
      }
      return job;
    }
    return null;
  };

  const pump = () => {
    while (inFlight < limit) {
      const job = popNext();
      if (!job) return;
      inFlight += 1;
      void job
        .run()
        .then((v) => job.resolve(v))
        .catch((e) => job.reject(e))
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
  };

  return {
    enqueue: <T>(job: FairQueueJob<T>) =>
      new Promise<T>((resolve, reject) => {
        ensureKey(job.key);
        buckets.get(job.key)!.push({
          key: job.key,
          priority: job.priority,
          run: job.run,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        pump();
      }),
    clear: () => {
      for (const [, bucket] of buckets) {
        for (const job of bucket) {
          job.reject(new Error("fair-queue-cleared"));
        }
      }
      buckets.clear();
      keyOrder.length = 0;
      rrCursor = 0;
    },
    pendingCount: () => {
      let n = 0;
      for (const bucket of buckets.values()) n += bucket.length;
      return n;
    },
    inFlightCount: () => inFlight,
  };
}

/**
 * Given ordered clip keys that need work, return the round-robin consume order
 * for the first `count` slots (pure helper for tests).
 */
export function fairRoundRobinKeys(keys: string[], count: number): string[] {
  if (keys.length === 0 || count < 1) return [];
  const unique: string[] = [];
  for (const k of keys) {
    if (!unique.includes(k)) unique.push(k);
  }
  const out: string[] = [];
  let i = 0;
  while (out.length < count) {
    out.push(unique[i % unique.length]!);
    i += 1;
  }
  return out;
}
