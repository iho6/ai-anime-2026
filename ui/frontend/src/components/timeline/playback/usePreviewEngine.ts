"use client";

/**
 * React host: hybrid PreviewEngine — DOM owns play until layout FINAL is ready.
 */

import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { TimelineManifest } from "../../../lib/api";
import type { PlayheadStore } from "../timelinePlayback";
import {
  blitImageBitmapToCanvas,
  createPreviewEngine,
  type PreviewEngine,
} from "./previewEngine";
import { createFrameStageCache } from "./frameStageCache";
import { createFrameProducer, type FrameSize } from "./frameProducer";
import { previewQualityPolicy } from "./previewQuality";
import { resolveScene } from "./resolveScene";

export type UsePreviewEngineResult = {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  /**
   * Always false for now: premature FINAL promote hid the DOM stack and paused
   * free-running videos (near-static seeked canvas). DOM remains presentation
   * truth; engine only warms cache in the background.
   */
  engineOwnsPresentation: boolean;
  engineRef: MutableRefObject<PreviewEngine | null>;
};

export function usePreviewEngine(options: {
  timelineKey: string;
  manifest: TimelineManifest;
  playheadStore: PlayheadStore;
  playing: boolean;
  bakeActive: boolean;
  playhead: number;
  frameSize: FrameSize;
  /** Optional DOM layer capture for FINAL produce. */
  captureDomLayer?: (
    clipId: string
  ) => CanvasImageSource | HTMLVideoElement | null | undefined;
}): UsePreviewEngineResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const captureRef = useRef(options.captureDomLayer);
  captureRef.current = options.captureDomLayer;
  const [engineOwnsPresentation, setOwns] = useState(false);

  const {
    timelineKey,
    manifest,
    playheadStore,
    playing,
    bakeActive,
    playhead,
    frameSize,
  } = options;

  useEffect(() => {
    const cache = createFrameStageCache(96);
    const scene0 = resolveScene(manifest, 0);
    const scale = previewQualityPolicy(true, scene0).resolveScale;
    const producer = createFrameProducer({
      timelineKey,
      cache,
      resolveScale: scale,
      concurrency: 2,
      frameSize,
      captureDomLayer: (id) => captureRef.current?.(id) ?? null,
    });

    const engine = createPreviewEngine({
      timelineKey,
      manifest,
      playheadStore,
      cache,
      producer,
      frameSize,
      presenter: {
        blitFinal: (bitmap) => {
          const el = canvasRef.current;
          if (el) blitImageBitmapToCanvas(el, bitmap);
        },
      },
    });
    engineRef.current = engine;

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recreate on identity only
  }, [timelineKey, manifest.fps, playheadStore]);

  const manifestEpoch = JSON.stringify(
    manifest.tracks.map((t) =>
      t.clips.map((c) => [
        c.id,
        c.srcRelPath,
        c.proxyRelPath,
        c.alphaRelPath,
        c.proxyAlphaRelPath,
        c.start,
        c.duration,
        c.inPoint,
        c.outPoint,
        c.speed,
        c.coloring,
        c.frameSequence?.sequenceGroupId ?? "",
        c.naturalW,
        c.naturalH,
        c.transform,
      ])
    )
  );

  useEffect(() => {
    engineRef.current?.setManifest(manifest);
  }, [manifest, manifestEpoch]);

  useEffect(() => {
    engineRef.current?.invalidate();
    setOwns(false);
  }, [manifestEpoch]);

  useEffect(() => {
    engineRef.current?.setFrameSize(frameSize);
  }, [frameSize.w, frameSize.h]);

  // Background FINAL produce while playing — do NOT take presentation ownership.
  // Premature promote hid/paused the DOM stack and left a near-static canvas
  // (seeked FINALs), which looked like "videos not playing". DOM stays truth
  // until promote-when-ready has a verified multi-frame runway (future).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (playing && !bakeActive) {
      engine.start();
      engine.tick();
    } else {
      engine.stop();
    }
    setOwns(false);
  }, [playing, bakeActive]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (!playing || bakeActive) {
      setOwns(false);
      return;
    }
    if (!engine.isActive()) engine.start();
    engine.tick();
    // Keep DOM presentation; never promote from a single FINAL hit.
    setOwns(false);
  }, [playhead, playing, bakeActive, frameSize.w, frameSize.h]);

  return { canvasRef, engineOwnsPresentation, engineRef };
}
