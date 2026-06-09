"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  assetUrlFromRelPath,
  type FrameSequencePayload,
  type KeypointVideoReference,
  type KeypointVideoStripSlot,
} from "../lib/api";
import { PauseBarsIcon, TimelinePlayIcon } from "./IconPrimitives";

const CELL = 72;

function visibleStripIndices(strip: KeypointVideoStripSlot[]): number[] {
  return strip
    .map((slot, i) =>
      slot.kind === "image" && !slot.hidden && slot.relPath ? i : -1
    )
    .filter((i): i is number => i >= 0);
}

function cloneStrip(strip: KeypointVideoStripSlot[]): KeypointVideoStripSlot[] {
  return strip.map((s) => ({
    ...s,
    ...(s.kind === "image" ? { relPath: s.relPath || "" } : {}),
  }));
}

export function KeypointVideoSequenceModal(props: {
  open: boolean;
  item: KeypointVideoReference | null;
  busy: boolean;
  onClose: () => void;
  onSave: (frameSequence: FrameSequencePayload) => void | Promise<void>;
}) {
  const { open, item, busy, onClose, onSave } = props;
  const initial = item?.frameSequence;
  const fps = item?.fps ?? 24;
  const videoSrc = item?.videoRelPath ? assetUrlFromRelPath(item.videoRelPath) : "";

  const [strip, setStrip] = useState<KeypointVideoStripSlot[]>([]);
  const [focusIx, setFocusIx] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set([0]));
  const [play, setPlay] = useState(false);
  const [playIx, setPlayIx] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!open || !initial) return;
    setStrip(cloneStrip(initial.strip || []));
    setFocusIx(0);
    setSelected(new Set([0]));
    setPlay(false);
    setPlayIx(0);
  }, [open, initial, item?.id]);

  const vis = useMemo(() => visibleStripIndices(strip), [strip]);
  const displayIx = play ? playIx : focusIx;
  const displaySlot = strip[displayIx];

  const syncVideoTime = useCallback(
    (stripIndex: number) => {
      const v = videoRef.current;
      if (!v || !videoSrc) return;
      const t = stripIndex / Math.max(1, fps);
      try {
        if (Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
      } catch {
        /* ignore seek errors */
      }
    },
    [fps, videoSrc]
  );

  useEffect(() => {
    if (!open) return;
    syncVideoTime(displayIx);
  }, [open, displayIx, syncVideoTime]);

  useEffect(() => {
    if (!play || !open) return;
    const ms = Math.max(50, Math.round(1000 / Math.max(1, fps)));
    const id = window.setInterval(() => {
      setPlayIx((prev) => {
        if (!vis.length) return prev;
        const pos = vis.indexOf(prev);
        const nextPos = pos < 0 ? 0 : (pos + 1) % vis.length;
        return vis[nextPos] ?? prev;
      });
    }, ms);
    return () => window.clearInterval(id);
  }, [play, open, fps, vis]);

  if (!open || !item || !initial) return null;

  const toggleHideSelected = (hidden: boolean) => {
    setStrip((prev) =>
      prev.map((s, i) =>
        selected.has(i) && s.kind === "image" ? { ...s, hidden } : s
      )
    );
  };

  const handleSave = () => {
    void onSave({
      sequenceGroupId: initial.sequenceGroupId,
      strip,
      hidden: [],
    });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        zIndex: 11000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={onClose}
    >
      <div
        style={{
          width: 720,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          background: "#111",
          color: "#eee",
          border: "1px solid rgba(255,255,255,0.2)",
          padding: 14,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 400, marginBottom: 10 }}>Video Keypoint Sequence</div>

        {videoSrc ? (
          <div style={{ marginBottom: 10 }}>
            <video
              ref={videoRef}
              src={videoSrc}
              controls
              style={{ width: "100%", maxHeight: 240, background: "#000" }}
            />
          </div>
        ) : null}

        <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            disabled={busy || !vis.length}
            onClick={() => setPlay((p) => !p)}
            style={{
              border: "1px solid rgba(255,255,255,0.35)",
              background: "transparent",
              color: "#eee",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            {play ? <PauseBarsIcon /> : <TimelinePlayIcon />}
          </button>
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() => toggleHideSelected(true)}
            style={{
              border: "1px solid rgba(255,255,255,0.35)",
              background: "transparent",
              color: "#eee",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Hide
          </button>
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() => toggleHideSelected(false)}
            style={{
              border: "1px solid rgba(255,255,255,0.35)",
              background: "transparent",
              color: "#eee",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Unhide
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: 6,
            overflowX: "auto",
            paddingBottom: 8,
            marginBottom: 8,
          }}
        >
          {strip.map((slot, i) => {
            const isSel = selected.has(i);
            const src =
              slot.kind === "image" && slot.relPath
                ? assetUrlFromRelPath(slot.relPath)
                : "";
            return (
              <button
                key={i}
                type="button"
                disabled={busy}
                onClick={(e) => {
                  if (e.shiftKey) {
                    setSelected((prev) => {
                      const n = new Set(prev);
                      if (n.has(i)) n.delete(i);
                      else n.add(i);
                      return n;
                    });
                  } else {
                    setSelected(new Set([i]));
                  }
                  setFocusIx(i);
                  setPlay(false);
                }}
                style={{
                  width: CELL,
                  height: CELL,
                  flex: "0 0 auto",
                  padding: 0,
                  border: isSel
                    ? "2px solid #06c"
                    : "1px solid rgba(255,255,255,0.25)",
                  background: slot.hidden ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.2)",
                  opacity: slot.hidden ? 0.45 : 1,
                  cursor: "pointer",
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                {slot.hidden ? (
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      left: 2,
                      fontSize: 9,
                      background: "rgba(0,0,0,0.7)",
                      color: "#fff",
                      padding: "1px 3px",
                    }}
                  >
                    Hidden
                  </span>
                ) : null}
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        {displaySlot?.kind === "image" && displaySlot.relPath ? (
          <div style={{ marginBottom: 10 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={assetUrlFromRelPath(displaySlot.relPath)}
              alt=""
              style={{
                width: "100%",
                maxHeight: 280,
                objectFit: "contain",
                background: "rgba(0,0,0,0.3)",
              }}
            />
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            style={{
              border: "1px solid rgba(255,255,255,0.35)",
              background: "transparent",
              color: "#eee",
              padding: "6px 14px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleSave}
            style={{
              border: "1px solid rgba(255,255,255,0.35)",
              background: "rgba(80,120,200,0.35)",
              color: "#eee",
              padding: "6px 14px",
              cursor: "pointer",
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
