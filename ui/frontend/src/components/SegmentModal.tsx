"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Sam3Point } from "../lib/api";

function clientToNatural(
  clientX: number,
  clientY: number,
  el: HTMLElement,
  naturalW: number,
  naturalH: number
): Sam3Point | null {
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1 || naturalW < 1 || naturalH < 1) return null;
  const x = ((clientX - rect.left) / rect.width) * naturalW;
  const y = ((clientY - rect.top) / rect.height) * naturalH;
  return {
    x: Math.max(0, Math.min(naturalW - 1, Math.round(x))),
    y: Math.max(0, Math.min(naturalH - 1, Math.round(y))),
  };
}

export function SegmentModal(props: {
  open: boolean;
  clipType: "image" | "video";
  mediaSrc: string;
  /** For video: seconds into the clip source to preview. */
  videoSeekSec?: number;
  busy?: boolean;
  onCancel: () => void;
  onPreview: (
    positive: Sam3Point[],
    negative: Sam3Point[]
  ) => Promise<string | null>;
  onSave: (positive: Sam3Point[], negative: Sam3Point[]) => void | Promise<void>;
}) {
  const {
    open,
    clipType,
    mediaSrc,
    videoSeekSec = 0,
    busy = false,
    onCancel,
    onPreview,
    onSave,
  } = props;

  const [positive, setPositive] = useState<Sam3Point[]>([]);
  const [negative, setNegative] = useState<Sam3Point[]>([]);
  const [maskB64, setMaskB64] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const mediaWrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewGenRef = useRef(0);

  const resetState = useCallback(() => {
    setPositive([]);
    setNegative([]);
    setMaskB64(null);
    setNaturalSize(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    resetState();
  }, [open, mediaSrc, resetState]);

  useEffect(() => {
    if (!open) return;
    const v = videoRef.current;
    if (clipType !== "video" || !v) return;
    const seek = () => {
      try {
        v.currentTime = Math.max(0, videoSeekSec);
      } catch {
        /* ignore */
      }
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
  }, [open, clipType, mediaSrc, videoSeekSec]);

  const refreshPreview = useCallback(
    async (pos: Sam3Point[], neg: Sam3Point[]) => {
      if (!pos.length) {
        setMaskB64(null);
        return;
      }
      const gen = ++previewGenRef.current;
      setPreviewBusy(true);
      try {
        const b64 = await onPreview(pos, neg);
        if (gen === previewGenRef.current) {
          setMaskB64(b64);
        }
      } catch {
        if (gen === previewGenRef.current) {
          setMaskB64(null);
        }
      } finally {
        if (gen === previewGenRef.current) {
          setPreviewBusy(false);
        }
      }
    },
    [onPreview]
  );

  useEffect(() => {
    if (!open || !positive.length) {
      setMaskB64(null);
      return;
    }
    const t = window.setTimeout(() => {
      void refreshPreview(positive, negative);
    }, 400);
    return () => window.clearTimeout(t);
  }, [open, positive, negative, refreshPreview]);

  const onMediaLoad = useCallback(() => {
    if (clipType === "image" && imgRef.current) {
      setNaturalSize({
        w: imgRef.current.naturalWidth,
        h: imgRef.current.naturalHeight,
      });
    } else if (clipType === "video" && videoRef.current) {
      setNaturalSize({
        w: videoRef.current.videoWidth,
        h: videoRef.current.videoHeight,
      });
    }
  }, [clipType]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (busy || previewBusy) return;
    const wrap = mediaWrapRef.current;
    if (!wrap || !naturalSize) return;
    const target = clipType === "image" ? imgRef.current : videoRef.current;
    if (!target) return;
    e.preventDefault();
    const pt = clientToNatural(
      e.clientX,
      e.clientY,
      target,
      naturalSize.w,
      naturalSize.h
    );
    if (!pt) return;
    if (e.shiftKey) {
      setNegative((prev) => [...prev, pt]);
    } else {
      setPositive((prev) => [...prev, pt]);
    }
  };

  const clearPoints = () => {
    setPositive([]);
    setNegative([]);
    setMaskB64(null);
  };

  if (!open) return null;

  const canSave = !busy && !previewBusy && positive.length > 0 && Boolean(maskB64);

  const pointStyle = (kind: "pos" | "neg"): React.CSSProperties => ({
    position: "absolute",
    width: 10,
    height: 10,
    marginLeft: -5,
    marginTop: -5,
    borderRadius: "50%",
    border: "2px solid #fff",
    background: kind === "pos" ? "#3ecf6e" : "#e85d5d",
    pointerEvents: "none",
    zIndex: 4,
  });

  const renderPoint = (pt: Sam3Point, kind: "pos" | "neg", key: string) => {
    if (!naturalSize) return null;
    const target = clipType === "image" ? imgRef.current : videoRef.current;
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    const wrap = mediaWrapRef.current?.getBoundingClientRect();
    if (!wrap) return null;
    const left =
      rect.left - wrap.left + (pt.x / naturalSize.w) * rect.width;
    const top =
      rect.top - wrap.top + (pt.y / naturalSize.h) * rect.height;
    return (
      <span
        key={key}
        style={{ ...pointStyle(kind), left, top }}
      />
    );
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 10040,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div
        style={{
          width: 720,
          maxWidth: "100%",
          height: "min(92vh, 880px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "#0b0b0b",
          border: "1px solid rgba(255,255,255,0.25)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          style={{
            flexShrink: 0,
            color: "white",
            padding: "12px 12px 10px",
            borderBottom: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          Segment (SAM 3.1)
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              fontSize: 13,
              color: "rgba(255,255,255,0.85)",
            }}
          >
            Click to include a region. Shift+click to exclude.{" "}
            {clipType === "video"
              ? "Preview uses the frame at the playhead."
              : null}
          </div>
          <div
            ref={mediaWrapRef}
            style={{
              flex: 1,
              minHeight: 0,
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              cursor: busy || previewBusy ? "wait" : "crosshair",
              background: "#111",
            }}
            onPointerDown={handlePointerDown}
          >
            {clipType === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={imgRef}
                src={mediaSrc}
                alt=""
                draggable={false}
                onLoad={onMediaLoad}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                  display: "block",
                  userSelect: "none",
                }}
              />
            ) : (
              <video
                ref={videoRef}
                src={mediaSrc}
                muted
                playsInline
                preload="metadata"
                onLoadedMetadata={onMediaLoad}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                  display: "block",
                  userSelect: "none",
                }}
              />
            )}
            {maskB64 && naturalSize ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`data:image/png;base64,${maskB64}`}
                alt=""
                draggable={false}
                style={{
                  position: "absolute",
                  inset: 0,
                  margin: "auto",
                  maxWidth: "100%",
                  maxHeight: "100%",
                  objectFit: "contain",
                  opacity: 0.45,
                  mixBlendMode: "screen",
                  pointerEvents: "none",
                }}
              />
            ) : null}
            {positive.map((pt, i) => renderPoint(pt, "pos", `p-${i}`))}
            {negative.map((pt, i) => renderPoint(pt, "neg", `n-${i}`))}
          </div>
        </div>

        <div
          style={{
            flexShrink: 0,
            padding: 12,
            borderTop: "1px solid rgba(255,255,255,0.12)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            className="ui-btn-black"
            disabled={busy || (!positive.length && !negative.length)}
            onClick={(e) => {
              e.preventDefault();
              clearPoints();
            }}
          >
            Clear points
          </button>
          <button
            type="button"
            className="ui-btn-black"
            disabled={!canSave}
            style={{
              cursor: canSave ? "pointer" : "not-allowed",
              opacity: canSave ? 1 : 0.6,
            }}
            onClick={(e) => {
              e.preventDefault();
              void onSave(positive, negative);
            }}
          >
            Save segment
          </button>
          <button
            type="button"
            className="ui-btn-black"
            onClick={(e) => {
              e.preventDefault();
              onCancel();
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
