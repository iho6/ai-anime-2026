"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Imperative handle for the optional mask-painting overlay. */
export type MaskController = {
  /** Erase all painted strokes. */
  clear: () => void;
  /**
   * Export the painted mask as a base64 PNG (no ``data:`` prefix) at the image's
   * natural resolution. Painted pixels are white; returns ``null`` if nothing was
   * painted.
   */
  exportBase64: () => string | null;
  hasPaint: () => boolean;
};

export function ZoomableImage(props: {
  src: string;
  alt?: string;
  fitMaxWidth?: string;
  fitMaxHeight?: string;
  onImageError?: () => void;
  /** Fires after the image has loaded and intrinsic size is known (naturalWidth/Height). */
  onImageLoad?: () => void;
  /** When true, double-click does not reset zoom/pan (e.g. parent handles dblclick). */
  suppressDoubleClickReset?: boolean;
  /** When true, left-drag paints a mask instead of panning (panning still via scrollbars / wheel-zoom). */
  maskMode?: boolean;
  /** Brush diameter in screen pixels (constant on screen regardless of zoom). */
  maskBrushSize?: number;
  /** CSS color used to render the painted mask on screen (export is always white). */
  maskDisplayColor?: string;
  /** Parent-owned ref that receives the imperative mask controller. */
  maskController?: React.MutableRefObject<MaskController | null>;
  /** Notifies the parent whenever the painted/empty state changes. */
  onMaskPaintedChange?: (hasPaint: boolean) => void;
}) {
  const {
    src,
    alt = "",
    fitMaxWidth = "90vw",
    fitMaxHeight = "70vh",
    onImageError,
    onImageLoad,
    suppressDoubleClickReset = false,
    maskMode = false,
    maskBrushSize = 40,
    maskDisplayColor = "rgba(0,0,0,0.55)",
    maskController,
    onMaskPaintedChange,
  } = props;

  const minZoom = 0.25;
  const maxZoom = 10;
  const wheelSpeed = 0.0015;
  const fillsContainer = fitMaxWidth === "100%" && fitMaxHeight === "100%";

  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(zoom);
  const dragActiveRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartYRef = useRef(0);
  const dragStartLeftRef = useRef(0);
  const dragStartTopRef = useRef(0);
  /** Last committed viewport size — ignore sub-pixel ResizeObserver churn (scrollbar/layout feedback). */
  const viewportSizeCommitRef = useRef<{ w: number; h: number } | null>(null);

  // --- Mask painting state ---------------------------------------------------
  /** Offscreen canvas at natural resolution; white strokes on transparent (export source). */
  const offscreenMaskRef = useRef<HTMLCanvasElement | null>(null);
  /** On-screen overlay canvas, sized to the displayed image. */
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintingRef = useRef(false);
  const lastNatRef = useRef<{ x: number; y: number } | null>(null);
  const hasPaintRef = useRef(false);

  /** Mode A: CSS contain (no scroll). Mode B: pixel sizing + scroll/pan (zoomed or mask). */
  const usePixelLayout = maskMode || zoom > 1;

  function stopDrag() {
    dragActiveRef.current = false;
    setDragging(false);
  }

  function resetViewportScroll() {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }

  const measureViewport = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const THRESH = 2;
    const w = Math.max(1, Math.round(el.clientWidth));
    const h = Math.max(1, Math.round(el.clientHeight));
    if (fillsContainer && (w < 8 || h < 8)) return;
    const prev = viewportSizeCommitRef.current;
    if (
      prev &&
      Math.abs(w - prev.w) < THRESH &&
      Math.abs(h - prev.h) < THRESH
    ) {
      return;
    }
    viewportSizeCommitRef.current = { w, h };
    setViewportSize({ w, h });
  }, [fillsContainer]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    measureViewport();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(measureViewport);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureViewport]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    setNaturalSize(null);
    setZoom(1);
    zoomRef.current = 1;
    stopDrag();
    offscreenMaskRef.current = null;
    lastNatRef.current = null;
    paintingRef.current = false;
    hasPaintRef.current = false;
    resetViewportScroll();
  }, [src]);

  const viewportStyle = useMemo<React.CSSProperties>(
    () => ({
      width: fitMaxWidth,
      height: fitMaxHeight,
      maxWidth: "100%",
      maxHeight: "100%",
      boxSizing: "border-box",
      ...(fillsContainer
        ? { flex: 1, minWidth: 0, minHeight: 0 }
        : {}),
      overflow: usePixelLayout ? "auto" : "hidden",
      scrollbarGutter: usePixelLayout ? "stable" : undefined,
      position: "relative",
      background: "rgba(0,0,0,0.02)",
      userSelect: dragging ? "none" : "auto",
      cursor: dragging ? "grabbing" : maskMode ? "crosshair" : zoom > 1 ? "grab" : "default",
      touchAction: "none",
    }),
    [fitMaxWidth, fitMaxHeight, fillsContainer, usePixelLayout, dragging, zoom, maskMode]
  );

  const baseScale = useMemo(() => {
    if (!naturalSize || !viewportSize) return 1;
    const sx = viewportSize.w / naturalSize.w;
    const sy = viewportSize.h / naturalSize.h;
    const fit = Math.min(sx, sy);
    if (!Number.isFinite(fit) || fit <= 0) return 1;
    return fit * 0.999;
  }, [naturalSize, viewportSize]);

  const renderScale = baseScale * zoom;
  const zoomedW =
    naturalSize != null
      ? Math.max(1, Math.floor(naturalSize.w * renderScale))
      : undefined;
  const zoomedH =
    naturalSize != null
      ? Math.max(1, Math.floor(naturalSize.h * renderScale))
      : undefined;
  const canApplyPixelSizing = Boolean(
    usePixelLayout && naturalSize && viewportSize && zoomedW && zoomedH
  );

  const innerBoxStyle = useMemo<React.CSSProperties>(() => {
    const base: React.CSSProperties = {
      minWidth: "100%",
      minHeight: "100%",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "flex-start",
      boxSizing: "border-box",
    };
    if (!canApplyPixelSizing || !viewportSize || zoomedW === undefined || zoomedH === undefined) {
      return {
        ...base,
        width: "100%",
        height: "100%",
      };
    }
    const vw = viewportSize.w;
    const vh = viewportSize.h;
    const innerW = Math.max(vw, zoomedW);
    const innerH = Math.max(vh, zoomedH);
    return {
      ...base,
      width: innerW,
      height: innerH,
    };
  }, [canApplyPixelSizing, viewportSize, zoomedW, zoomedH]);

  const pixelImgStyle = useMemo<React.CSSProperties>(() => {
    if (!canApplyPixelSizing) {
      return {
        maxWidth: "100%",
        maxHeight: "100%",
        width: "auto",
        height: "auto",
        objectFit: "contain",
        display: "block",
      };
    }
    return {
      width: zoomedW,
      height: zoomedH,
      maxWidth: "none",
      maxHeight: "none",
      objectFit: "contain",
      display: "block",
    };
  }, [canApplyPixelSizing, zoomedW, zoomedH]);

  const containImgStyle = useMemo<React.CSSProperties>(
    () => ({
      width: "100%",
      height: "100%",
      objectFit: "contain",
      display: "block",
      transform: zoom !== 1 ? `scale(${zoom})` : undefined,
      transformOrigin: "center center",
    }),
    [zoom]
  );

  // --- Mask rendering / painting --------------------------------------------
  const renderMaskDisplay = useCallback(() => {
    const disp = displayCanvasRef.current;
    if (!disp) return;
    const w = Math.max(1, Math.round(disp.clientWidth));
    const h = Math.max(1, Math.round(disp.clientHeight));
    if (disp.width !== w) disp.width = w;
    if (disp.height !== h) disp.height = h;
    const ctx = disp.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const off = offscreenMaskRef.current;
    if (off) {
      ctx.drawImage(off, 0, 0, w, h);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = maskDisplayColor;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
    }
  }, [maskDisplayColor]);

  useEffect(() => {
    if (!maskMode || !naturalSize) return;
    const cur = offscreenMaskRef.current;
    if (!cur || cur.width !== naturalSize.w || cur.height !== naturalSize.h) {
      const c = document.createElement("canvas");
      c.width = naturalSize.w;
      c.height = naturalSize.h;
      offscreenMaskRef.current = c;
      hasPaintRef.current = false;
      onMaskPaintedChange?.(false);
    }
    const id = requestAnimationFrame(renderMaskDisplay);
    return () => cancelAnimationFrame(id);
  }, [maskMode, naturalSize, renderMaskDisplay, onMaskPaintedChange]);

  useEffect(() => {
    if (!maskMode) return;
    const id = requestAnimationFrame(renderMaskDisplay);
    return () => cancelAnimationFrame(id);
  }, [maskMode, zoom, naturalSize, viewportSize, zoomedW, zoomedH, renderMaskDisplay]);

  const paintAt = useCallback(
    (clientX: number, clientY: number) => {
      const off = offscreenMaskRef.current;
      const disp = displayCanvasRef.current;
      if (!off || !disp) return;
      const rect = disp.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const sx = off.width / rect.width;
      const sy = off.height / rect.height;
      const nx = (clientX - rect.left) * sx;
      const ny = (clientY - rect.top) * sy;
      const ctx = off.getContext("2d");
      if (!ctx) return;
      ctx.strokeStyle = "#ffffff";
      ctx.fillStyle = "#ffffff";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const natBrush = Math.max(1, maskBrushSize * sx);
      ctx.lineWidth = natBrush;
      const last = lastNatRef.current;
      if (last) {
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(nx, ny);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(nx, ny, natBrush / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      lastNatRef.current = { x: nx, y: ny };
      if (!hasPaintRef.current) {
        hasPaintRef.current = true;
        onMaskPaintedChange?.(true);
      }
      renderMaskDisplay();
    },
    [maskBrushSize, onMaskPaintedChange, renderMaskDisplay]
  );

  const onMaskPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!maskMode || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      displayCanvasRef.current?.setPointerCapture(e.pointerId);
      paintingRef.current = true;
      lastNatRef.current = null;
      paintAt(e.clientX, e.clientY);
    },
    [maskMode, paintAt]
  );

  const onMaskPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!paintingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      paintAt(e.clientX, e.clientY);
    },
    [paintAt]
  );

  const onMaskPointerUp = useCallback(() => {
    paintingRef.current = false;
    lastNatRef.current = null;
  }, []);

  useEffect(() => {
    if (!maskController) return;
    maskController.current = {
      clear: () => {
        const off = offscreenMaskRef.current;
        off?.getContext("2d")?.clearRect(0, 0, off.width, off.height);
        lastNatRef.current = null;
        hasPaintRef.current = false;
        onMaskPaintedChange?.(false);
        renderMaskDisplay();
      },
      exportBase64: () => {
        const off = offscreenMaskRef.current;
        if (!off || !hasPaintRef.current) return null;
        const url = off.toDataURL("image/png");
        return url.includes(",") ? url.split(",")[1] : url;
      },
      hasPaint: () => hasPaintRef.current,
    };
    return () => {
      if (maskController) maskController.current = null;
    };
  }, [maskController, onMaskPaintedChange, renderMaskDisplay]);

  /** Non-passive so ``preventDefault`` stops native scroll; React ``onWheel`` is often passive. */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const oldZoom = zoomRef.current;
      const factor = Math.exp(-ev.deltaY * wheelSpeed);
      const nextZoom = clamp(oldZoom * factor, minZoom, maxZoom);
      if (nextZoom === oldZoom) return;

      const viewportRect = viewport.getBoundingClientRect();
      const viewportX = ev.clientX - viewportRect.left;
      const viewportY = ev.clientY - viewportRect.top;
      const contentX = viewport.scrollLeft + viewportX;
      const contentY = viewport.scrollTop + viewportY;
      const ratio = nextZoom / oldZoom;

      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      requestAnimationFrame(() => {
        if (nextZoom > 1) {
          const targetLeft = contentX * ratio - viewportX;
          const targetTop = contentY * ratio - viewportY;
          const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
          const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
          viewport.scrollLeft = clamp(targetLeft, 0, maxLeft);
          viewport.scrollTop = clamp(targetTop, 0, maxTop);
        } else {
          resetViewportScroll();
        }
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [src]);

  const onImageLoadHandler = useCallback(
    (ev: React.SyntheticEvent<HTMLImageElement>) => {
      const w = ev.currentTarget.naturalWidth || 1;
      const h = ev.currentTarget.naturalHeight || 1;
      setNaturalSize({ w, h });
      onImageLoad?.();
    },
    [onImageLoad]
  );

  return (
    <div
      ref={viewportRef}
      style={viewportStyle}
      onDoubleClick={() => {
        if (suppressDoubleClickReset) return;
        setZoom(1);
        resetViewportScroll();
      }}
      onMouseDown={(ev) => {
        if (maskMode) return;
        if (ev.button !== 0 || zoom <= 1) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        dragActiveRef.current = true;
        setDragging(true);
        dragStartXRef.current = ev.clientX;
        dragStartYRef.current = ev.clientY;
        dragStartLeftRef.current = viewport.scrollLeft;
        dragStartTopRef.current = viewport.scrollTop;
      }}
      onMouseMove={(ev) => {
        if (!dragActiveRef.current) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        ev.preventDefault();
        const dx = ev.clientX - dragStartXRef.current;
        const dy = ev.clientY - dragStartYRef.current;
        const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        viewport.scrollLeft = clamp(dragStartLeftRef.current - dx, 0, maxLeft);
        viewport.scrollTop = clamp(dragStartTopRef.current - dy, 0, maxTop);
      }}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
      onTouchStart={(ev) => {
        if (maskMode || zoom <= 1) return;
        const touch = ev.touches[0];
        if (!touch) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        dragActiveRef.current = true;
        setDragging(true);
        dragStartXRef.current = touch.clientX;
        dragStartYRef.current = touch.clientY;
        dragStartLeftRef.current = viewport.scrollLeft;
        dragStartTopRef.current = viewport.scrollTop;
      }}
      onTouchMove={(ev) => {
        if (!dragActiveRef.current) return;
        const touch = ev.touches[0];
        const viewport = viewportRef.current;
        if (!touch || !viewport) return;
        ev.preventDefault();
        const dx = touch.clientX - dragStartXRef.current;
        const dy = touch.clientY - dragStartYRef.current;
        const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        viewport.scrollLeft = clamp(dragStartLeftRef.current - dx, 0, maxLeft);
        viewport.scrollTop = clamp(dragStartTopRef.current - dy, 0, maxTop);
      }}
      onTouchEnd={stopDrag}
      onTouchCancel={stopDrag}
    >
      {usePixelLayout ? (
        <div style={innerBoxStyle}>
          <div style={{ position: "relative", lineHeight: 0, fontSize: 0 }}>
            <img
              src={src}
              alt={alt}
              draggable={false}
              onError={() => {
                onImageError?.();
              }}
              onLoad={onImageLoadHandler}
              style={pixelImgStyle}
            />
            {maskMode && naturalSize ? (
              <canvas
                ref={displayCanvasRef}
                onPointerDown={onMaskPointerDown}
                onPointerMove={onMaskPointerMove}
                onPointerUp={onMaskPointerUp}
                onPointerLeave={onMaskPointerUp}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: "100%",
                  height: "100%",
                  cursor: "crosshair",
                  touchAction: "none",
                }}
              />
            ) : null}
          </div>
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          draggable={false}
          onError={() => {
            onImageError?.();
          }}
          onLoad={onImageLoadHandler}
          style={containImgStyle}
        />
      )}
    </div>
  );
}
