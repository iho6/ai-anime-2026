/**
 * WebAudio graph for preview playback.
 *
 * Each active audio output element is routed through its own GainNode so
 * per-clip gain is applied in [0, 2] (HTMLMediaElement.volume clamps at 1,
 * which silently flattened crescendo boosts and normalization gains > 1).
 * AudioContext.currentTime doubles as the master playback clock.
 *
 * MediaElementSource disconnects the element's default speaker path, so we
 * only attach once the context is running; otherwise callers use el.volume.
 */

export type AudioSinkMode = "webaudio" | "element";

/** Pure helper: WebAudio sink only when the context is running. */
export function audioSinkMode(
  contextState: AudioContextState | null | undefined
): AudioSinkMode {
  return contextState === "running" ? "webaudio" : "element";
}

export type PreviewAudioGraph = {
  /** Route the element through a per-key GainNode (idempotent). */
  attach: (key: string, el: HTMLMediaElement) => boolean;
  /**
   * Linear gain, 0..2 (values > 1 are the whole point of this graph).
   * Returns false when no route exists (caller falls back to el.volume).
   */
  setGain: (key: string, gain: number) => boolean;
  detach: (key: string) => void;
  /** Hardware audio clock in seconds (master clock while playing). */
  now: () => number;
  /** Resume the context (call from a user-gesture when possible). */
  resume: () => Promise<void>;
  isRunning: () => boolean;
  state: () => AudioContextState;
};

const MAX_PREVIEW_GAIN = 2;

type Route = {
  source: MediaElementAudioSourceNode;
  gain: GainNode;
};

let graph: PreviewAudioGraph | null | undefined;

function createGraph(): PreviewAudioGraph | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") {
    return null;
  }
  let context: AudioContext;
  try {
    context = new AudioContext({ latencyHint: "interactive" });
  } catch {
    return null;
  }
  // A media element can be attached to a context only once, ever.
  const routes = new Map<string, Route>();
  const attachedEls = new WeakSet<HTMLMediaElement>();

  return {
    attach: (key, el) => {
      if (routes.has(key)) return true;
      if (attachedEls.has(el)) return false;
      try {
        const source = context.createMediaElementSource(el);
        const gain = context.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(context.destination);
        routes.set(key, { source, gain });
        attachedEls.add(el);
        return true;
      } catch {
        // Element already attached elsewhere or CORS-tainted: element keeps
        // its default output path and el.volume fallback applies.
        attachedEls.add(el);
        return false;
      }
    },
    setGain: (key, value) => {
      const route = routes.get(key);
      if (!route) return false;
      const clamped = Math.max(0, Math.min(MAX_PREVIEW_GAIN, value));
      // Short ramp avoids zipper noise from per-tick gain writes.
      const t = context.currentTime;
      route.gain.gain.cancelScheduledValues(t);
      route.gain.gain.setTargetAtTime(clamped, t, 0.015);
      return true;
    },
    detach: (key) => {
      const route = routes.get(key);
      if (!route) return;
      try {
        route.source.disconnect();
        route.gain.disconnect();
      } catch {
        /* ignore */
      }
      routes.delete(key);
    },
    now: () => context.currentTime,
    resume: async () => {
      if (context.state === "suspended") {
        try {
          await context.resume();
        } catch {
          /* ignore — caller falls back to el.volume */
        }
      }
    },
    isRunning: () => context.state === "running",
    state: () => context.state,
  };
}

/** Lazy singleton; null when WebAudio is unavailable. */
export function getPreviewAudioGraph(): PreviewAudioGraph | null {
  if (graph === undefined) graph = createGraph();
  return graph;
}

/** True when a graph route exists (used to decide el.volume fallback). */
export function previewAudioGraphAvailable(): boolean {
  return getPreviewAudioGraph() != null;
}
