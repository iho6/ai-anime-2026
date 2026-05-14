"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

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
}) {
  const {
    src,
    alt = "",
    fitMaxWidth = "90vw",
    fitMaxHeight = "70vh",
    onImageError,
    onImageLoad,
    suppressDoubleClickReset = false,
  } = props;

  const minZoom = 1;
  const maxZoom = 10;
  const wheelSpeed = 0.0015;

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

  function stopDrag() {
    dragActiveRef.current = false;
    setDragging(false);
  }

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const THRESH = 2;
    const updateSize = () => {
      const w = Math.max(1, Math.round(el.clientWidth));
      const h = Math.max(1, Math.round(el.clientHeight));
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
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(updateSize);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    setNaturalSize(null);
    setZoom(1);
    zoomRef.current = 1;
    stopDrag();
    const el = viewportRef.current;
    if (el) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  }, [src]);

  const viewportStyle = useMemo<React.CSSProperties>(
    () => ({
      width: fitMaxWidth,
      height: fitMaxHeight,
      overflow: "auto",
      scrollbarGutter: "stable",
      position: "relative",
      background: "rgba(0,0,0,0.02)",
      userSelect: dragging ? "none" : "auto",
      cursor: dragging ? "grabbing" : zoom > 1 ? "grab" : "default",
      touchAction: "none",
    }),
    [fitMaxWidth, fitMaxHeight, dragging, zoom]
  );

  const baseScale = useMemo(() => {
    if (!naturalSize || !viewportSize) return 1;
    const sx = viewportSize.w / naturalSize.w;
    const sy = viewportSize.h / naturalSize.h;
    const fit = Math.min(sx, sy);
    if (!Number.isFinite(fit) || fit <= 0) return 1;
    return fit;
  }, [naturalSize, viewportSize]);

  const renderScale = baseScale * zoom;
  const zoomedW =
    naturalSize != null ? Math.max(1, Math.round(naturalSize.w * renderScale)) : undefined;
  const zoomedH =
    naturalSize != null ? Math.max(1, Math.round(naturalSize.h * renderScale)) : undefined;
  const canApplyPixelSizing = Boolean(naturalSize && viewportSize && zoomedW && zoomedH);

  const innerBoxStyle = useMemo<React.CSSProperties>(() => {
    const base: React.CSSProperties = {
      minWidth: "100%",
      minHeight: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
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
    // When the scaled image fits in the viewport, keep inner exactly viewport-sized so no
    // spurious scrollbars / ResizeObserver feedback loop at min zoom.
    const fits = zoomedW <= vw && zoomedH <= vh;
    const innerW = fits ? vw : Math.max(vw, zoomedW);
    const innerH = fits ? vh : Math.max(vh, zoomedH);
    return {
      ...base,
      width: innerW,
      height: innerH,
    };
  }, [canApplyPixelSizing, viewportSize, zoomedW, zoomedH]);

  const imgStyle = useMemo<React.CSSProperties>(() => {
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

  useEffect(() => {
    if (zoom !== 1) return;
    const el = viewportRef.current;
    if (!el) return;
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }, [zoom]);

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
        const targetLeft = contentX * ratio - viewportX;
        const targetTop = contentY * ratio - viewportY;
        const maxLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        viewport.scrollLeft = clamp(targetLeft, 0, maxLeft);
        viewport.scrollTop = clamp(targetTop, 0, maxTop);
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [src]);

  return (
    <div
      ref={viewportRef}
      style={viewportStyle}
      onDoubleClick={() => {
        if (suppressDoubleClickReset) return;
        setZoom(1);
        const el = viewportRef.current;
        if (el) {
          el.scrollTop = 0;
          el.scrollLeft = 0;
        }
      }}
      onMouseDown={(ev) => {
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
        if (zoom <= 1) return;
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
      <div style={innerBoxStyle}>
        <img
          src={src}
          alt={alt}
          draggable={false}
          onError={() => {
            onImageError?.();
          }}
          onLoad={(ev) => {
            const w = ev.currentTarget.naturalWidth || 1;
            const h = ev.currentTarget.naturalHeight || 1;
            setNaturalSize({ w, h });
            onImageLoad?.();
          }}
          style={imgStyle}
        />
      </div>
    </div>
  );
}
