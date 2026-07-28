/**
 * Small paused <video> pool for seeking decode during PreviewEngine produce.
 * Never free-runs — clock is the integer playhead.
 * One in-flight seek per URL (mutex) to avoid thrashing.
 */

function waitSeeked(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.max(0, timeSec);
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    try {
      video.currentTime = target;
    } catch {
      video.removeEventListener("seeked", done);
      resolve();
    }
  });
}

function waitHaveData(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("canplay", done);
      resolve();
    };
    video.addEventListener("loadeddata", done);
    video.addEventListener("canplay", done);
  });
}

export type VideoDecodePool = {
  capture: (url: string, timeSec: number) => Promise<ImageBitmap | null>;
  dispose: () => void;
};

export function createVideoDecodePool(maxElements = 6): VideoDecodePool {
  if (typeof document === "undefined") {
    return {
      capture: async () => null,
      dispose: () => {},
    };
  }

  const limit = Math.max(1, maxElements);
  const byUrl = new Map<string, HTMLVideoElement>();
  const lru: string[] = [];
  /** Serialize seeks per URL. */
  const seekTail = new Map<string, Promise<unknown>>();

  const touch = (url: string) => {
    const ix = lru.indexOf(url);
    if (ix >= 0) lru.splice(ix, 1);
    lru.push(url);
  };

  const evict = () => {
    while (lru.length > limit) {
      const oldest = lru.shift();
      if (!oldest) break;
      const el = byUrl.get(oldest);
      byUrl.delete(oldest);
      seekTail.delete(oldest);
      if (el) {
        el.removeAttribute("src");
        el.load();
        el.remove();
      }
    }
  };

  const getVideo = (url: string): HTMLVideoElement => {
    let el = byUrl.get(url);
    if (el) {
      touch(url);
      return el;
    }
    el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.src = url;
    byUrl.set(url, el);
    touch(url);
    evict();
    return el;
  };

  return {
    capture: async (url, timeSec) => {
      if (!url || typeof createImageBitmap !== "function") return null;
      const prev = seekTail.get(url) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      seekTail.set(
        url,
        prev.then(() => gate).catch(() => gate)
      );
      await prev.catch(() => {});
      try {
        const video = getVideo(url);
        await waitHaveData(video);
        await waitSeeked(video, timeSec);
        if (video.readyState < 2 || video.videoWidth < 1) return null;
        try {
          return await createImageBitmap(video);
        } catch {
          return null;
        }
      } finally {
        release();
      }
    },
    dispose: () => {
      for (const el of byUrl.values()) {
        el.removeAttribute("src");
        el.load();
        el.remove();
      }
      byUrl.clear();
      lru.length = 0;
      seekTail.clear();
    },
  };
}
