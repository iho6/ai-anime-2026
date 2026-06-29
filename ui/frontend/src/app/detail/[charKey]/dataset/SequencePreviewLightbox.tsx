"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GalleryImagePager } from "../../../../components/GalleryImagePager";
import { LightboxModalChrome } from "../../../../components/LightboxModalChrome";
import { ZoomableImage } from "../../../../components/ZoomableImage";
import {
  CheckIcon,
  CloseIcon,
  PauseBarsIcon,
  SquareIconButton,
  TimelinePlayIcon,
} from "../../../../components/IconPrimitives";
import { assetUrlFromRelPath, type SequenceCrop, type SequenceManifest } from "../../../../lib/api";
import { TransparentCanvasOverlay, squareSrcFromPlacedFigure } from "../../../../components/TransparentCanvasOverlay";
import {
  aspectDimensionsForId,
  fitAspectBox,
  normalizeSequencePreviewAspect,
} from "../../../../lib/sequenceAspect";
import {
  cloneCrop,
  defaultSequenceCrop,
  normalizeCrop,
  SEQUENCE_CROP_OUTER_CLIP_FLEX,
  sequenceCropTransformWrapperStyle,
} from "../../../../lib/sequenceCrop";
import { computeSequenceTimelineSpan } from "./sequenceGalleryUtils";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Fraction-of-viewport nudge steps (consistent across monitor sizes).
const NUDGE_FRAC = 0.002;
const NUDGE_SHIFT_FRAC = 0.02;
const MIN_SCALE = 1;
const MAX_SCALE = 10;

type Props = {
  manifest: SequenceManifest;
  scope: "gallery" | "timeline";
  initialIndex: number;
  title: string;
  onClose: () => void;
  onCommitManifest: (next: SequenceManifest) => void;
  /**
   * When scope is timeline, limit preview to these logical column indices (editor grid).
   * Omit or empty to use all non-hidden frames.
   */
  timelinePreviewColumnIndices?: number[] | null;
};

export function SequencePreviewLightbox(props: Props) {
  const {
    manifest,
    scope,
    initialIndex,
    title,
    onClose,
    onCommitManifest,
    timelinePreviewColumnIndices,
  } = props;

  const sortedFrames = useMemo(
    () => [...manifest.frames].sort((a, b) => a.index - b.index),
    [manifest.frames]
  );

  /** Timeline: non-hidden frames sorted by index. */
  const nonHiddenSortedTimeline = useMemo(
    () => sortedFrames.filter((f) => !f.hidden),
    [sortedFrames]
  );

  /** Pager order for timeline scope; respects sparse editor columns when provided. */
  const timelineFramesForPager = useMemo(() => {
    if (scope !== "timeline") return nonHiddenSortedTimeline;
    const cols = timelinePreviewColumnIndices;
    if (cols == null || cols.length === 0) return nonHiddenSortedTimeline;
    const set = new Set(cols);
    return nonHiddenSortedTimeline.filter((f) => set.has(f.index));
  }, [scope, nonHiddenSortedTimeline, timelinePreviewColumnIndices]);

  const paths = useMemo(() => {
    if (scope === "gallery") {
      return manifest.gallery.map((g) => assetUrlFromRelPath(g.relPath));
    }
    return timelineFramesForPager.map((f) => assetUrlFromRelPath(f.relPath));
  }, [manifest.gallery, scope, timelineFramesForPager]);

  const aspectId = normalizeSequencePreviewAspect(manifest.previewAspect);
  const { w: arW, h: arH } = aspectDimensionsForId(aspectId);

  const [idx, setIdx] = useState(initialIndex);
  const [playing, setPlaying] = useState(false);
  const [noBackdrop, setNoBackdrop] = useState(false);
  const [mode, setMode] = useState<"view" | "crop">("view");
  const [cropDraft, setCropDraft] = useState<SequenceCrop>(() => defaultSequenceCrop());
  const [boxPx, setBoxPx] = useState({ w: 800, h: 450 });
  const [loadedCount, setLoadedCount] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const preloadImgsRef = useRef<HTMLImageElement[]>([]);

  useEffect(() => {
    function measure() {
      const maxW = window.innerWidth * 0.9;
      const maxH = window.innerHeight * 0.7;
      setBoxPx(fitAspectBox(maxW, maxH, arW, arH));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [arW, arH]);

  useEffect(() => {
    setIdx(initialIndex);
  }, [initialIndex]);

  useEffect(() => {
    setIdx((prev) => Math.max(0, Math.min(prev, Math.max(0, paths.length - 1))));
  }, [paths.length]);

  useEffect(() => {
    setLoadedCount(0);
    let n = 0;
    const imgs = paths.map((url) => {
      const img = new Image();
      const done = () => setLoadedCount(++n);
      img.onload = done;
      img.onerror = done;
      img.src = url;
      return img;
    });
    preloadImgsRef.current = imgs;
    return () => {
      for (const img of preloadImgsRef.current) {
        img.onload = null;
        img.onerror = null;
      }
      preloadImgsRef.current = [];
    };
  }, [paths]);

  useEffect(() => {
    setMode("view");
  }, [idx, scope]);

  useEffect(() => {
    if (mode === "crop") setPlaying(false);
  }, [mode]);

  useEffect(() => {
    if (scope !== "timeline" || paths.length < 2) setPlaying(false);
  }, [scope, paths.length]);

  const handleClose = useCallback(() => {
    setPlaying(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!playing || scope !== "timeline" || paths.length < 2) return;
    const frames = timelineFramesForPager;
    const n = frames.length;
    if (n < 2) return;
    const logicalFps = Math.max(1, Math.round(manifest.fps));
    const msPerLogicalCol = 1000 / logicalFps;
    const cur = Math.max(0, Math.min(idx, n - 1));
    const nextIdx = (cur + 1) % n;
    const curFr = frames[cur]!;
    const nextFr = frames[nextIdx]!;
    let delta: number;
    if (nextIdx > cur) {
      delta = Math.max(1, nextFr.index - curFr.index);
    } else {
      const span = computeSequenceTimelineSpan(manifest);
      delta = Math.max(1, span - 1 - curFr.index + nextFr.index);
    }
    const ms = Math.max(1, Math.round(delta * msPerLogicalCol));
    const t = window.setTimeout(() => {
      setIdx(nextIdx);
    }, ms);
    return () => window.clearTimeout(t);
  }, [playing, scope, paths.length, idx, timelineFramesForPager, manifest]);

  const savedCrop = useMemo(() => {
    if (scope === "gallery") {
      const g = manifest.gallery[idx];
      return normalizeCrop(g?.crop);
    }
    const f = timelineFramesForPager[idx];
    return normalizeCrop(f?.crop);
  }, [manifest.gallery, idx, scope, timelineFramesForPager]);

  const displayCrop = mode === "crop" ? cropDraft : savedCrop;

  const enterCrop = useCallback(() => {
    setCropDraft(cloneCrop(savedCrop));
    setMode("crop");
  }, [savedCrop]);

  const cancelCrop = useCallback(() => {
    setCropDraft(cloneCrop(savedCrop));
    setMode("view");
  }, [savedCrop]);

  const saveCrop = useCallback(() => {
    const c = normalizeCrop(cropDraft);
    if (scope === "gallery") {
      const gal = [...manifest.gallery];
      const item = gal[idx];
      if (!item) return;
      gal[idx] = { ...item, crop: cloneCrop(c) };
      onCommitManifest({ ...manifest, gallery: gal });
    } else {
      const fr = timelineFramesForPager[idx];
      if (!fr) return;
      onCommitManifest({
        ...manifest,
        frames: manifest.frames.map((row) =>
          row.cellId === fr.cellId ? { ...row, crop: cloneCrop(c) } : row
        ),
      });
    }
    setMode("view");
  }, [cropDraft, idx, manifest, onCommitManifest, scope, timelineFramesForPager]);

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (mode === "crop") {
        if (ev.key === "Escape") {
          ev.preventDefault();
          cancelCrop();
          return;
        }
        const step = ev.shiftKey ? NUDGE_SHIFT_FRAC : NUDGE_FRAC;
        if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          setCropDraft((d) => ({ ...d, translateXFrac: d.translateXFrac - step }));
          return;
        }
        if (ev.key === "ArrowRight") {
          ev.preventDefault();
          setCropDraft((d) => ({ ...d, translateXFrac: d.translateXFrac + step }));
          return;
        }
        if (ev.key === "ArrowUp") {
          ev.preventDefault();
          setCropDraft((d) => ({ ...d, translateYFrac: d.translateYFrac - step }));
          return;
        }
        if (ev.key === "ArrowDown") {
          ev.preventDefault();
          setCropDraft((d) => ({ ...d, translateYFrac: d.translateYFrac + step }));
          return;
        }
        return;
      }

      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        setPlaying(false);
        setIdx((i) => Math.max(0, i - 1));
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        setPlaying(false);
        setIdx((i) => Math.min(paths.length - 1, i + 1));
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        handleClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelCrop, handleClose, mode, paths.length]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || mode !== "crop") return;
    const fn = (ev: WheelEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const factor = Math.exp(-ev.deltaY * 0.0015);
      setCropDraft((d) => ({
        ...d,
        scale: clamp(d.scale * factor, MIN_SCALE, MAX_SCALE),
      }));
    };
    el.addEventListener("wheel", fn, { passive: false });
    return () => el.removeEventListener("wheel", fn);
  }, [mode]);

  if (!paths.length) return null;
  const cur = Math.max(0, Math.min(idx, paths.length - 1));
  const src = paths[cur];
  const imagesReady = loadedCount >= paths.length;
  const currentFrame = scope === "timeline" ? timelineFramesForPager[cur] : null;
  const currentPlacedFigure = currentFrame?.placedFigure ?? null;
  const noBackdropSrc = noBackdrop && currentPlacedFigure
    ? squareSrcFromPlacedFigure(currentPlacedFigure)
    : null;
  const anyFrameSupportsNoBackdrop = scope === "timeline" &&
    timelineFramesForPager.some((f) => f.placedFigure && squareSrcFromPlacedFigure(f.placedFigure));

  const btnStyle: React.CSSProperties = {
    color: "#eee",
    borderColor: "rgba(238,238,238,0.9)",
    background: "rgba(238,238,238,0.15)",
  };

  const saveBtnStyle: React.CSSProperties = {
    ...btnStyle,
    background: "rgba(80,160,255,0.35)",
  };

  return (
    <LightboxModalChrome title={title} onBackdropMouseDown={handleClose}>
      <div
        ref={viewportRef}
        style={{
          width: boxPx.w,
          height: boxPx.h,
          maxWidth: "90vw",
          maxHeight: "70vh",
          overflow: "hidden",
          position: "relative",
          contain: "paint",
          background: "rgba(255,255,255,1)",
          boxSizing: "border-box",
          border: mode === "crop" ? "2px solid rgba(255,255,255,0.85)" : "2px solid transparent",
        }}
      >
        <div style={SEQUENCE_CROP_OUTER_CLIP_FLEX}>
          <div style={sequenceCropTransformWrapperStyle(displayCrop)}>
            {mode === "view" ? (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  minWidth: 0,
                  minHeight: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  enterCrop();
                }}
              >
                {noBackdropSrc && currentPlacedFigure ? (
                  <TransparentCanvasOverlay
                    squareSrc={noBackdropSrc}
                    placedFigure={currentPlacedFigure}
                    style={{ width: "100%", height: "100%", maxWidth: "100%", maxHeight: "100%" }}
                  />
                ) : playing ? (
                  // While playing, render a fixed contained image (no per-frame re-fit / zoom) so
                  // frames of differing dimensions don't jump in size.
                  <img
                    src={src}
                    alt=""
                    draggable={false}
                    style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                  />
                ) : (
                  <ZoomableImage
                    src={src}
                    fitMaxWidth="100%"
                    fitMaxHeight="100%"
                    suppressDoubleClickReset
                  />
                )}
              </div>
            ) : (
              <img
                src={src}
                alt=""
                draggable={false}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  width: "auto",
                  height: "auto",
                  objectFit: "contain",
                  display: "block",
                  pointerEvents: "auto",
                }}
              />
            )}
          </div>
        </div>
      </div>

      {mode === "view" ? (
        <GalleryImagePager
          variant="modalLight"
          index={cur}
          count={paths.length}
          onPrev={() => {
            setPlaying(false);
            setIdx((i) => Math.max(0, i - 1));
          }}
          onNext={() => {
            setPlaying(false);
            setIdx((i) => Math.min(paths.length - 1, i + 1));
          }}
          onClose={handleClose}
          extraAfterNext={
            scope === "timeline" ? (
              <>
                <SquareIconButton
                  size={36}
                  aria-label={playing ? "Pause" : "Play"}
                  title={!imagesReady ? `Loading ${loadedCount}/${paths.length}…` : (playing ? "Pause" : "Play")}
                  icon={playing ? <PauseBarsIcon /> : <TimelinePlayIcon />}
                  tone="light"
                  style={btnStyle}
                  disabled={paths.length < 2 || !imagesReady}
                  onClick={() => setPlaying((p) => !p)}
                />
                {anyFrameSupportsNoBackdrop ? (
                  <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", color: noBackdrop ? "#7dd3fc" : "#ccc", fontSize: 12, userSelect: "none", whiteSpace: "nowrap" }}>
                    <input
                      type="checkbox"
                      checked={noBackdrop}
                      onChange={(e) => setNoBackdrop(e.target.checked)}
                      style={{ margin: 0 }}
                    />
                    No Backdrop
                  </label>
                ) : null}
              </>
            ) : undefined
          }
        />
      ) : (
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
          <SquareIconButton
            aria-label="Save crop"
            title="Save"
            icon={<CheckIcon />}
            tone="light"
            style={saveBtnStyle}
            onClick={() => saveCrop()}
          />
          <SquareIconButton
            aria-label="Cancel crop"
            title="Cancel"
            icon={<CloseIcon />}
            tone="light"
            style={btnStyle}
            onClick={cancelCrop}
          />
        </div>
      )}
      {mode === "view" ? (
        <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 12, textAlign: "center", marginTop: 8 }}>
          {scope === "timeline" && !imagesReady
            ? `Loading ${loadedCount}/${paths.length} frames…`
            : "Wheel to zoom; double-click image to adjust crop (arrows / wheel in crop mode)"}
        </div>
      ) : null}
    </LightboxModalChrome>
  );
}
