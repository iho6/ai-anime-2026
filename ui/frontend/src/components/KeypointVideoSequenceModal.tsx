"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  assetUrlFromRelPath,
  type FrameSequencePayload,
  type KeypointVideoReference,
  type KeypointVideoStripSlot,
} from "../lib/api";
import { PauseBarsIcon, TimelinePlayIcon } from "./IconPrimitives";
import { PoseRefFramePreview } from "./PoseRefFramePreview";

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

  const [strip, setStrip] = useState<KeypointVideoStripSlot[]>([]);
  const [focusIx, setFocusIx] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(() => new Set([0]));
  const [play, setPlay] = useState(false);
  const [playIx, setPlayIx] = useState(0);
  const stripScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !initial) return;
    setStrip(cloneStrip(initial.strip || []));
    setFocusIx(0);
    setSelected(new Set([0]));
    setPlay(false);
    setPlayIx(0);
  }, [open, initial, item?.id]);

  const vis = useMemo(() => visibleStripIndices(strip), [strip]);
  const previewPaths = useMemo(
    () =>
      vis
        .map((i) => strip[i]?.relPath ?? "")
        .filter((p): p is string => Boolean(p)),
    [strip, vis]
  );
  const displayIx = play ? playIx : focusIx;
  const previewFrameIndex = Math.max(0, vis.indexOf(displayIx));

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

  useEffect(() => {
    const container = stripScrollRef.current;
    if (!container) return;
    const cell = container.children[focusIx] as HTMLElement | undefined;
    if (!cell) return;
    const cRect = container.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    if (cellRect.left < cRect.left) {
      container.scrollLeft -= cRect.left - cellRect.left + 6;
    } else if (cellRect.right > cRect.right) {
      container.scrollLeft += cellRect.right - cRect.right + 6;
    }
  }, [focusIx]);

  if (!open || !item || !initial) return null;

  const toggleHideSelected = (hidden: boolean) => {
    setStrip((prev) =>
      prev.map((s, i) =>
        selected.has(i) && s.kind === "image" ? { ...s, hidden } : s
      )
    );
  };

  const removeSelected = () => {
    const indices = selected;
    setStrip((prev) => prev.filter((_, i) => !indices.has(i)));
    const remaining = strip.length - indices.size;
    const newFocus = Math.min(focusIx, Math.max(0, remaining - 1));
    setFocusIx(newFocus);
    setSelected(new Set(remaining > 0 ? [newFocus] : []));
  };

  const addEmpty = () => {
    const insertAfter = selected.size > 0 ? Math.max(...selected) : strip.length - 1;
    const newIx = insertAfter + 1;
    setStrip((prev) => {
      const t = [...prev];
      t.splice(newIx, 0, { kind: "empty" });
      return t;
    });
    setFocusIx(newIx);
    setSelected(new Set([newIx]));
  };

  const handleStripKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = Math.max(0, Math.min(strip.length - 1, focusIx + dir));
    setFocusIx(next);
    setSelected(new Set([next]));
    setPlay(false);
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

        <div
          style={{
            resize: "both",
            overflow: "hidden",
            width: 420,
            height: 300,
            minWidth: 160,
            minHeight: 120,
            maxWidth: "100%",
            boxSizing: "border-box",
            marginBottom: 4,
          }}
        >
          <PoseRefFramePreview
            frameRelPaths={previewPaths}
            fps={fps}
            maxWidth="100%"
            maxHeight="100%"
            frameIndex={previewFrameIndex}
            playing={play}
            onPlayingChange={setPlay}
            showPlayOverlay={false}
          />
        </div>
        <div style={{ fontSize: 10, color: "#555", marginBottom: 8, userSelect: "none" }}>
          Drag corner to resize preview
        </div>

        <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            disabled={busy || !vis.length}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPlay((p) => !p)}
            style={{
              outline: "none",
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
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={addEmpty}
            style={{
              outline: "none",
              border: "1px solid rgba(255,255,255,0.35)",
              background: "transparent",
              color: "#eee",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Add empty
          </button>
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onMouseDown={(e) => e.preventDefault()}
            onClick={removeSelected}
            style={{
              outline: "none",
              border: "1px solid rgba(255,255,255,0.35)",
              background: "transparent",
              color: "#eee",
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Remove
          </button>
          <button
            type="button"
            disabled={busy || selected.size === 0}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleHideSelected(true)}
            style={{
              outline: "none",
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
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleHideSelected(false)}
            style={{
              outline: "none",
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
          ref={stripScrollRef}
          tabIndex={0}
          onKeyDown={handleStripKeyDown}
          style={{
            display: "flex",
            gap: 6,
            overflowX: "auto",
            paddingBottom: 8,
            marginBottom: 8,
            outline: "none",
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
                  outline: "none",
                  border: isSel
                    ? "2px solid #4af"
                    : "1px solid rgba(255,255,255,0.18)",
                  background: slot.hidden ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.2)",
                  opacity: slot.hidden ? 0.45 : 1,
                  cursor: "pointer",
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                {/* Frame number — always top-left */}
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    left: 2,
                    fontSize: 9,
                    background: "rgba(0,0,0,0.55)",
                    color: "#bbb",
                    padding: "1px 3px",
                    lineHeight: 1,
                    pointerEvents: "none",
                  }}
                >
                  {i + 1}
                </span>
                {/* Hidden badge — top-right */}
                {slot.hidden ? (
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      right: 2,
                      fontSize: 9,
                      background: "rgba(0,0,0,0.7)",
                      color: "#fff",
                      padding: "1px 3px",
                      lineHeight: 1,
                      pointerEvents: "none",
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
