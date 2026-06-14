"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Sam3Point } from "../lib/api";
import { JobQuadSpinner } from "./JobQuadSpinner";

const MASK_LUM_THRESHOLD = 64;
const POINT_HIT_RADIUS = 12;
const INSIDE_RGBA = [72, 210, 120, 140] as const;
const OUTSIDE_RGBA = [28, 32, 48, 178] as const;

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

function buildMaskTintOverlay(maskB64: string, w: number, h: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("canvas unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const src = ctx.getImageData(0, 0, w, h);
      const out = ctx.createImageData(w, h);
      for (let i = 0; i < src.data.length; i += 4) {
        const lum = src.data[i];
        const rgba = lum > MASK_LUM_THRESHOLD ? INSIDE_RGBA : OUTSIDE_RGBA;
        out.data[i] = rgba[0];
        out.data[i + 1] = rgba[1];
        out.data[i + 2] = rgba[2];
        out.data[i + 3] = rgba[3];
      }
      ctx.putImageData(out, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("mask decode failed"));
    img.src = `data:image/png;base64,${maskB64}`;
  });
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
    negative: Sam3Point[],
    textPrompt?: string
  ) => Promise<string | null>;
  onSave: (
    positive: Sam3Point[],
    negative: Sam3Point[],
    textPrompt?: string
  ) => void | Promise<void>;
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
  const [textDraft, setTextDraft] = useState("");
  const [appliedTextPrompt, setAppliedTextPrompt] = useState("");
  const [maskB64, setMaskB64] = useState<string | null>(null);
  const [overlayDataUrl, setOverlayDataUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const mediaWrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewGenRef = useRef(0);

  const invalidateMask = useCallback(() => {
    setMaskB64(null);
    setOverlayDataUrl(null);
  }, []);

  const resetState = useCallback(() => {
    setPositive([]);
    setNegative([]);
    setTextDraft("");
    setAppliedTextPrompt("");
    setMaskB64(null);
    setOverlayDataUrl(null);
    setNaturalSize(null);
  }, []);

  const hasPrompt =
    positive.length > 0 || appliedTextPrompt.trim().length > 0;

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
    async (pos: Sam3Point[], neg: Sam3Point[], text: string) => {
      if (!pos.length && !text.trim()) {
        setMaskB64(null);
        setOverlayDataUrl(null);
        return;
      }
      const gen = ++previewGenRef.current;
      setPreviewBusy(true);
      try {
        const b64 = await onPreview(pos, neg, text.trim() || undefined);
        if (gen === previewGenRef.current) {
          setMaskB64(b64);
        }
      } catch {
        if (gen === previewGenRef.current) {
          setMaskB64(null);
          setOverlayDataUrl(null);
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
    if (!maskB64 || !naturalSize) {
      setOverlayDataUrl(null);
      return;
    }
    let cancelled = false;
    void buildMaskTintOverlay(maskB64, naturalSize.w, naturalSize.h)
      .then((url) => {
        if (!cancelled) setOverlayDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setOverlayDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [maskB64, naturalSize]);

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

  function findPointHit(
    clientX: number,
    clientY: number
  ): { kind: "pos" | "neg"; index: number } | null {
    const wrap = mediaWrapRef.current;
    if (!wrap || !naturalSize) return null;
    const target = clipType === "image" ? imgRef.current : videoRef.current;
    if (!target) return null;
    const wrapRect = wrap.getBoundingClientRect();
    const sx = clientX - wrapRect.left;
    const sy = clientY - wrapRect.top;
    const rect = target.getBoundingClientRect();

    const hitInList = (pts: Sam3Point[], kind: "pos" | "neg") => {
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        const left =
          rect.left - wrapRect.left + (pt.x / naturalSize.w) * rect.width;
        const top =
          rect.top - wrapRect.top + (pt.y / naturalSize.h) * rect.height;
        if (Math.hypot(sx - left, sy - top) <= POINT_HIT_RADIUS) {
          return { kind, index: i };
        }
      }
      return null;
    };

    return hitInList(negative, "neg") ?? hitInList(positive, "pos");
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || busy || previewBusy) return;
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
    invalidateMask();
    if (e.shiftKey) {
      setNegative((prev) => [...prev, pt]);
    } else {
      setPositive((prev) => [...prev, pt]);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy || previewBusy) return;
    const hit = findPointHit(e.clientX, e.clientY);
    if (!hit) return;
    invalidateMask();
    if (hit.kind === "neg") {
      setNegative((prev) => prev.filter((_, i) => i !== hit.index));
    } else {
      setPositive((prev) => prev.filter((_, i) => i !== hit.index));
    }
  };

  const addPrompt = () => {
    const trimmed = textDraft.trim();
    if (!trimmed || previewBusy) return;
    setAppliedTextPrompt(trimmed);
    invalidateMask();
  };

  const runSegment = () => {
    if (previewBusy || busy) return;
    if (!positive.length && !appliedTextPrompt.trim()) return;
    void refreshPreview(positive, negative, appliedTextPrompt);
  };

  const clearPrompt = () => {
    setPositive([]);
    setNegative([]);
    setTextDraft("");
    setAppliedTextPrompt("");
    setMaskB64(null);
    setOverlayDataUrl(null);
  };

  if (!open) return null;

  const canSave = !busy && !previewBusy && hasPrompt && Boolean(maskB64);
  const canAddPrompt = Boolean(textDraft.trim()) && !busy && !previewBusy;
  const canSegment =
    (positive.length > 0 || Boolean(appliedTextPrompt.trim())) &&
    !busy &&
    !previewBusy;

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

  const mediaOverlayStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    margin: "auto",
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    pointerEvents: "none",
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
            Click to include, Shift+click to exclude, right-click a point to
            remove. Add Prompt then click Segment to preview. Text and points
            are combined.{" "}
            {clipType === "video"
              ? "Preview uses the frame at the playhead."
              : null}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={textDraft}
              disabled={busy || previewBusy}
              placeholder="Text prompt (optional), e.g. person or cat:2, dog"
              onChange={(e) => setTextDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPrompt();
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "8px 10px",
                fontSize: 13,
                background: "#1a1a1a",
                border: "1px solid rgba(255,255,255,0.2)",
                color: "#eee",
                borderRadius: 4,
              }}
            />
            <button
              type="button"
              className="ui-btn-black"
              disabled={!canAddPrompt}
              style={{
                flexShrink: 0,
                cursor: canAddPrompt ? "pointer" : "not-allowed",
                opacity: canAddPrompt ? 1 : 0.6,
              }}
              onClick={(e) => {
                e.preventDefault();
                addPrompt();
              }}
            >
              Add Prompt
            </button>
          </div>
          {appliedTextPrompt ? (
            <div
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,0.75)",
                padding: "4px 8px",
                background: "rgba(72, 210, 120, 0.12)",
                border: "1px solid rgba(72, 210, 120, 0.35)",
                borderRadius: 4,
              }}
            >
              Prompt: {appliedTextPrompt}
            </div>
          ) : null}
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
            onContextMenu={handleContextMenu}
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
            {overlayDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={overlayDataUrl}
                alt=""
                draggable={false}
                style={{ ...mediaOverlayStyle, zIndex: 2 }}
              />
            ) : null}
            {positive.map((pt, i) => renderPoint(pt, "pos", `p-${i}`))}
            {negative.map((pt, i) => renderPoint(pt, "neg", `n-${i}`))}
            {previewBusy ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 10,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  background: "rgba(0,0,0,0.55)",
                  pointerEvents: "all",
                }}
              >
                <JobQuadSpinner size={28} />
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.9)" }}>
                  Running SAM 3.1 segmentation…
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div
          style={{
            flexShrink: 0,
            padding: 12,
            borderTop: "1px solid rgba(255,255,255,0.12)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <button
            type="button"
            className="ui-btn-black"
            disabled={!canSegment}
            style={{
              cursor: canSegment ? "pointer" : "not-allowed",
              opacity: canSegment ? 1 : 0.6,
            }}
            onClick={(e) => {
              e.preventDefault();
              runSegment();
            }}
          >
            Segment
          </button>
          <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="ui-btn-black"
            disabled={
              busy ||
              (!positive.length &&
                !negative.length &&
                !textDraft.trim() &&
                !appliedTextPrompt.trim())
            }
            onClick={(e) => {
              e.preventDefault();
              clearPrompt();
            }}
          >
            Clear
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
              void onSave(
                positive,
                negative,
                appliedTextPrompt.trim() || undefined
              );
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
    </div>
  );
}
