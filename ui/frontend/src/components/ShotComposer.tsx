"use client";

import React, { useEffect, useRef, useState } from "react";
import { assetUrlFromRelPath } from "../lib/api";

export type ShotBackdrop = {
  relPath: string;
  naturalW: number;
  naturalH: number;
};

export type ShotCharacter = {
  id: string;
  charKey: string;
  imageRelPath: string;
  naturalW: number;
  naturalH: number;
  /** Top-left position in backdrop-pixel coordinates. */
  x: number;
  y: number;
  /** Drawn width = naturalW * scale (also in backdrop pixels). */
  scale: number;
  /**
   * When the layer's background has been removed, the pre-cutout image rel path
   * (editor-only state) so it can be restored. Undefined when not cut out.
   */
  originalImageRelPath?: string;
};

/** Load an image's natural dimensions from its storage rel path. */
export function loadImageMeta(
  relPath: string
): Promise<{ naturalW: number; naturalH: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ naturalW: img.naturalWidth, naturalH: img.naturalHeight });
    img.onerror = () => reject(new Error("Failed to load image: " + relPath));
    img.src = assetUrlFromRelPath(relPath);
  });
}

/** Initial placement for a freshly added character (centered, ~60% height). */
export function defaultCharacterPlacement(
  backdrop: ShotBackdrop,
  naturalW: number,
  naturalH: number
): { x: number; y: number; scale: number } {
  const targetH = backdrop.naturalH * 0.6;
  const scale = naturalH > 0 ? targetH / naturalH : 1;
  const drawnW = naturalW * scale;
  const drawnH = naturalH * scale;
  return {
    x: (backdrop.naturalW - drawnW) / 2,
    y: backdrop.naturalH - drawnH, // feet near the bottom edge
    scale,
  };
}

/**
 * Render the backdrop + characters to a PNG at backdrop-native resolution and
 * return base64 (no data-URL prefix). This is "image 2" for the Qwen edit.
 */
export async function buildCompositePngBase64(
  backdrop: ShotBackdrop,
  characters: ShotCharacter[]
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(backdrop.naturalW));
  canvas.height = Math.max(1, Math.round(backdrop.naturalH));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context.");

  const loadImg = (relPath: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to load image: " + relPath));
      img.src = assetUrlFromRelPath(relPath);
    });

  const bgImg = await loadImg(backdrop.relPath);
  ctx.drawImage(bgImg, 0, 0, canvas.width, canvas.height);

  for (const ch of characters) {
    const img = await loadImg(ch.imageRelPath);
    ctx.drawImage(
      img,
      ch.x,
      ch.y,
      ch.naturalW * ch.scale,
      ch.naturalH * ch.scale
    );
  }

  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.split(",", 2)[1] ?? "";
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;

type DragState =
  | {
      mode: "move" | "scale";
      id: string;
      startClientX: number;
      startClientY: number;
      origX: number;
      origY: number;
      origScale: number;
    }
  | {
      mode: "pan";
      startClientX: number;
      startClientY: number;
      origPanX: number;
      origPanY: number;
      moved: boolean;
    };

/**
 * Interactive preview: backdrop with overlaid character layers. The whole scene
 * zooms/pans together (wheel + empty-area drag) while each character can be
 * selected and moved/scaled independently. Right-clicking a character fires
 * ``onRequestChangeView`` so the page can open the gallery to swap its image.
 */
export function ShotComposer(props: {
  backdrop: ShotBackdrop | null;
  characters: ShotCharacter[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMoveCharacter: (id: string, x: number, y: number) => void;
  onScaleCharacter: (id: string, scale: number) => void;
  onRequestChangeView: (id: string, clientX: number, clientY: number) => void;
  onRequestBackdropMenu?: (clientX: number, clientY: number) => void;
  height?: number;
}) {
  const {
    backdrop,
    characters,
    selectedId,
    onSelect,
    onMoveCharacter,
    onScaleCharacter,
    onRequestChangeView,
    onRequestBackdropMenu,
    height = 420,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<DragState | null>(null);

  // Keep view transform fresh for pointer handlers without stale closures.
  const viewRef = useRef({ baseScale: 1, viewScale: 1, panX: 0, panY: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cr = e.contentRect;
        setContainerSize({ w: cr.width, h: cr.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset view whenever a new backdrop is set.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [backdrop?.relPath]);

  const baseScale =
    backdrop && containerSize.w > 0 && containerSize.h > 0
      ? Math.min(
          containerSize.w / backdrop.naturalW,
          containerSize.h / backdrop.naturalH
        )
      : 1;
  const viewScale = baseScale * zoom;

  // Center the backdrop within the container at base fit.
  const fittedW = backdrop ? backdrop.naturalW * viewScale : 0;
  const fittedH = backdrop ? backdrop.naturalH * viewScale : 0;
  const offsetX = (containerSize.w - fittedW) / 2 + pan.x;
  const offsetY = (containerSize.h - fittedH) / 2 + pan.y;

  viewRef.current = {
    baseScale,
    viewScale,
    panX: offsetX,
    panY: offsetY,
  };

  // Wheel zoom via a native, non-passive listener so ``preventDefault`` works.
  // React's synthetic ``onWheel`` is passive, so it cannot stop the page from
  // scrolling while zooming the preview.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      if (!backdrop) return;
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      setZoom((z) => {
        const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor));
        // Keep the point under the cursor stable.
        const v = viewRef.current;
        const newViewScale = v.baseScale * nz;
        const sx = (cx - v.panX) / v.viewScale;
        const sy = (cy - v.panY) / v.viewScale;
        const newOffsetX = cx - sx * newViewScale;
        const newOffsetY = cy - sy * newViewScale;
        const baseCenterX = (containerSize.w - backdrop.naturalW * newViewScale) / 2;
        const baseCenterY = (containerSize.h - backdrop.naturalH * newViewScale) / 2;
        setPan({ x: newOffsetX - baseCenterX, y: newOffsetY - baseCenterY });
        return nz;
      });
    }
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [backdrop, containerSize.w, containerSize.h]);

  // Global pointer handlers active during a drag.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const v = viewRef.current;
      if (d.mode === "pan") {
        const dx = e.clientX - d.startClientX;
        const dy = e.clientY - d.startClientY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
        setPan({ x: d.origPanX + dx, y: d.origPanY + dy });
        return;
      }
      const dxBackdrop = (e.clientX - d.startClientX) / v.viewScale;
      const dyBackdrop = (e.clientY - d.startClientY) / v.viewScale;
      if (d.mode === "move") {
        onMoveCharacter(d.id, d.origX + dxBackdrop, d.origY + dyBackdrop);
      } else if (d.mode === "scale") {
        const ch = characters.find((c) => c.id === d.id);
        const naturalW = ch?.naturalW || 1;
        const next = Math.max(0.02, d.origScale + dxBackdrop / naturalW);
        onScaleCharacter(d.id, next);
      }
    }
    function onUp() {
      const d = dragRef.current;
      if (d && d.mode === "pan" && !d.moved) {
        onSelect(null);
      }
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [characters, onMoveCharacter, onScaleCharacter, onSelect]);

  function startCharDrag(e: React.PointerEvent, ch: ShotCharacter) {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(ch.id);
    dragRef.current = {
      mode: "move",
      id: ch.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: ch.x,
      origY: ch.y,
      origScale: ch.scale,
    };
  }

  function startScaleDrag(e: React.PointerEvent, ch: ShotCharacter) {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect(ch.id);
    dragRef.current = {
      mode: "scale",
      id: ch.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: ch.x,
      origY: ch.y,
      origScale: ch.scale,
    };
  }

  function startPan(e: React.PointerEvent) {
    if (e.button !== 0) return;
    dragRef.current = {
      mode: "pan",
      startClientX: e.clientX,
      startClientY: e.clientY,
      origPanX: pan.x,
      origPanY: pan.y,
      moved: false,
    };
  }

  return (
    <div
      ref={containerRef}
      onPointerDown={startPan}
      style={{
        position: "relative",
        width: "100%",
        height,
        overflow: "hidden",
        border: "1px solid rgba(0,0,0,0.35)",
        background: "rgba(0,0,0,0.04)",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {!backdrop ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: 0.5,
            fontSize: 14,
            pointerEvents: "none",
          }}
        >
          Add a backdrop to begin
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            left: offsetX,
            top: offsetY,
            width: fittedW,
            height: fittedH,
          }}
        >
          {/* Backdrop image */}
          <img
            src={assetUrlFromRelPath(backdrop.relPath)}
            alt=""
            draggable={false}
            onContextMenu={
              onRequestBackdropMenu
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onRequestBackdropMenu(e.clientX, e.clientY);
                  }
                : undefined
            }
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
              display: "block",
              pointerEvents: onRequestBackdropMenu ? "auto" : "none",
            }}
          />

          {/* Character layers (positioned in backdrop px, scaled by viewScale) */}
          {characters.map((ch) => {
            const isSel = ch.id === selectedId;
            return (
              <div
                key={ch.id}
                onPointerDown={(e) => startCharDrag(e, ch)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect(ch.id);
                  onRequestChangeView(ch.id, e.clientX, e.clientY);
                }}
                style={{
                  position: "absolute",
                  left: ch.x * viewScale,
                  top: ch.y * viewScale,
                  width: ch.naturalW * ch.scale * viewScale,
                  height: ch.naturalH * ch.scale * viewScale,
                  outline: isSel ? "2px solid #2b8cff" : "none",
                  cursor: "move",
                }}
              >
                <img
                  src={assetUrlFromRelPath(ch.imageRelPath)}
                  alt=""
                  draggable={false}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "fill",
                    display: "block",
                    pointerEvents: "none",
                  }}
                />
                {isSel ? (
                  <div
                    onPointerDown={(e) => startScaleDrag(e, ch)}
                    title="Drag to scale"
                    style={{
                      position: "absolute",
                      right: -6,
                      bottom: -6,
                      width: 12,
                      height: 12,
                      background: "#2b8cff",
                      border: "1px solid #fff",
                      cursor: "nwse-resize",
                    }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
