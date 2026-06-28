"use client";

import React, { useCallback, useEffect, useState } from "react";
import { GalleryImagePager } from "./GalleryImagePager";
import { LightboxModalChrome } from "./LightboxModalChrome";
import { ZoomableImage } from "./ZoomableImage";
import { TransparentCanvasOverlay } from "./TransparentCanvasOverlay";
import { type PlacedFigureMeta } from "../lib/api";

export type GalleryNoBackdropItem = { squareSrc: string; placedFigure: PlacedFigureMeta };

export type GalleryImageLightboxProps = {
  paths: string[];
  index: number;
  title: string;
  onClose: () => void;
  noBackdropItems?: (GalleryNoBackdropItem | null)[];
};

function clampIndex(i: number, pathCount: number): number {
  const max = Math.max(0, pathCount - 1);
  return Math.max(0, Math.min(i, max));
}

/**
 * Paths-based image preview: same zoom/pager/keyboard behavior as the former per-page lightboxes.
 */
export function GalleryImageLightbox(props: GalleryImageLightboxProps) {
  const { paths, title, onClose, noBackdropItems } = props;
  const [idx, setIdx] = useState(() => clampIndex(props.index, props.paths.length));

  const bump = useCallback(
    (delta: number) => {
      setIdx((prev) => {
        const at = clampIndex(prev, paths.length);
        return clampIndex(at + delta, paths.length);
      });
    },
    [paths.length]
  );

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        bump(-1);
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        bump(1);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bump, onClose]);

  if (!paths.length) return null;
  const cur = clampIndex(idx, paths.length);
  const nbItem = noBackdropItems?.[cur] ?? null;

  return (
    <LightboxModalChrome title={title} onBackdropMouseDown={onClose}>
      {nbItem ? (
        <TransparentCanvasOverlay squareSrc={nbItem.squareSrc} placedFigure={nbItem.placedFigure} style={{ width: "min(90vw, 80vh)" }} />
      ) : (
        <ZoomableImage src={paths[cur]} />
      )}
      <GalleryImagePager
        variant="modalLight"
        index={cur}
        count={paths.length}
        onPrev={() => bump(-1)}
        onNext={() => bump(1)}
        onClose={onClose}
      />
    </LightboxModalChrome>
  );
}
