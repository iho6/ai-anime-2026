"use client";

import React, { useEffect, useRef } from "react";
import type {
  TimelineClip,
  TimelineTransitionOut,
  TimelineTransitionType,
  TransitionDirection,
} from "../../lib/api";
import { defaultDirection } from "./transitionEffects";
import {
  DEFAULT_TRANSITION_DURATION,
  TRANSITION_DURATION_MAX,
  TRANSITION_DURATION_MIN,
} from "./timelineUtil";
import { clipSupportsTrajectorySync } from "./trajectorySync";

const TYPES: { id: TimelineTransitionType; label: string }[] = [
  { id: "fade", label: "Fade" },
  { id: "dissolve", label: "Dissolve" },
  { id: "wipe", label: "Wipe" },
  { id: "slide", label: "Slide" },
];

const DIRECTIONS: { id: TransitionDirection; label: string }[] = [
  { id: "left", label: "←" },
  { id: "right", label: "→" },
  { id: "up", label: "↑" },
  { id: "down", label: "↓" },
];

const MENU_BORDER = "1px solid rgba(255,255,255,0.35)";

const menuButtonStyle: React.CSSProperties = {
  appearance: "none",
  display: "block",
  width: "100%",
  border: MENU_BORDER,
  background: "transparent",
  color: "white",
  textAlign: "left",
  padding: "6px 8px",
  borderRadius: 0,
  cursor: "pointer",
  fontSize: 13,
  font: "inherit",
};

function canSyncPair(
  outgoing: TimelineClip | null | undefined,
  incoming: TimelineClip | null | undefined
): boolean {
  if (!outgoing || !incoming) return false;
  return (
    clipSupportsTrajectorySync(outgoing) && clipSupportsTrajectorySync(incoming)
  );
}

export function ClipTransitionMenu(props: {
  open: boolean;
  x: number;
  y: number;
  transition: TimelineTransitionOut | undefined;
  outgoingClip?: TimelineClip | null;
  incomingClip?: TimelineClip | null;
  syncMotionTailSec?: number;
  syncBusy?: boolean;
  onSyncMotionTailSecChange?: (sec: number) => void;
  onSyncMotionApply?: () => void;
  onSyncColorApply?: () => void;
  onChange: (transition: TimelineTransitionOut | undefined) => void;
  onCommit: () => void;
  onClose: () => void;
}) {
  const {
    open,
    x,
    y,
    transition,
    outgoingClip,
    incomingClip,
    syncMotionTailSec = 0.5,
    syncBusy = false,
    onSyncMotionTailSecChange,
    onSyncMotionApply,
    onSyncColorApply,
    onChange,
    onCommit,
    onClose,
  } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const activeType = transition?.type;
  const duration = transition?.duration ?? DEFAULT_TRANSITION_DURATION;
  const direction =
    transition?.direction ??
    (activeType ? defaultDirection(activeType) : "left");
  const showDirection = activeType === "wipe" || activeType === "slide";
  const syncEnabled = canSyncPair(outgoingClip, incomingClip) && !syncBusy;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

  if (!open) return null;

  function pickType(type: TimelineTransitionType) {
    onChange({
      type,
      duration,
      ...((type === "wipe" || type === "slide") ? { direction } : {}),
    });
    onCommit();
  }

  function pickDirection(dir: TransitionDirection) {
    if (!activeType) return;
    onChange({ type: activeType, duration, direction: dir });
    onCommit();
  }

  let rowIdx = 0;
  const nextMargin = () => {
    const m = rowIdx === 0 ? 0 : -1;
    rowIdx += 1;
    return m;
  };

  return (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 20000,
        background: "rgba(0,0,0,0.85)",
        border: MENU_BORDER,
        borderRadius: 0,
        padding: 0,
        minWidth: 200,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        display: "flex",
        flexDirection: "column",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {TYPES.map((t) => {
        const marginTop = nextMargin();
        const active = activeType === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => pickType(t.id)}
            style={{
              ...menuButtonStyle,
              marginTop,
              background: active ? "rgba(255,209,102,0.2)" : "transparent",
              borderColor: active ? "#ffd166" : "rgba(255,255,255,0.35)",
            }}
          >
            {t.label}
          </button>
        );
      })}

      {showDirection ? (
        <div
          style={{
            display: "flex",
            marginTop: nextMargin(),
            border: MENU_BORDER,
          }}
        >
          {DIRECTIONS.map((d, i) => {
            const active = direction === d.id;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => pickDirection(d.id)}
                style={{
                  appearance: "none",
                  flex: 1,
                  padding: "6px 0",
                  marginLeft: i === 0 ? 0 : -1,
                  background: active ? "rgba(255,209,102,0.2)" : "transparent",
                  border: active ? "1px solid #ffd166" : MENU_BORDER,
                  borderRadius: 0,
                  color: "white",
                  cursor: "pointer",
                  fontSize: 14,
                  font: "inherit",
                }}
              >
                {d.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        style={{
          marginTop: nextMargin(),
          border: MENU_BORDER,
          padding: "6px 8px",
        }}
      >
        <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>Duration</div>
        <input
          type="range"
          className="ui-square-range"
          min={TRANSITION_DURATION_MIN}
          max={TRANSITION_DURATION_MAX}
          step={0.05}
          value={duration}
          disabled={!activeType}
          onChange={(e) => {
            if (!activeType) return;
            const v = Math.max(
              TRANSITION_DURATION_MIN,
              Math.min(TRANSITION_DURATION_MAX, Number(e.target.value))
            );
            onChange({
              type: activeType,
              duration: v,
              ...(showDirection ? { direction } : {}),
            });
          }}
          onPointerUp={onCommit}
          style={{ width: "100%", borderTop: "none" }}
        />
        <div style={{ fontSize: 11, color: "#ccc", marginTop: 4 }}>
          {duration.toFixed(2)}s
        </div>
      </div>

      {activeType ? (
        <button
          type="button"
          onClick={() => {
            onChange(undefined);
            onCommit();
            onClose();
          }}
          style={{
            ...menuButtonStyle,
            marginTop: nextMargin(),
            color: "#e99",
          }}
        >
          Remove transition
        </button>
      ) : null}

      <button
        type="button"
        disabled={!syncEnabled}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSyncMotionApply?.();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          ...menuButtonStyle,
          marginTop: nextMargin(),
          cursor: syncEnabled ? "pointer" : "not-allowed",
          opacity: syncEnabled ? 1 : 0.55,
        }}
      >
        Sync Motion
      </button>
      <button
        type="button"
        disabled={!syncEnabled}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSyncColorApply?.();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          ...menuButtonStyle,
          marginTop: nextMargin(),
          cursor: syncEnabled ? "pointer" : "not-allowed",
          opacity: syncEnabled ? 1 : 0.55,
        }}
      >
        Sync Color
      </button>
      <div
        style={{
          marginTop: nextMargin(),
          border: MENU_BORDER,
          padding: "6px 8px",
          opacity: syncEnabled ? 1 : 0.55,
        }}
      >
        <label
          style={{
            display: "block",
            marginBottom: 6,
            fontSize: 11,
            color: "#aaa",
          }}
        >
          <div style={{ marginBottom: 4 }}>Slowdown</div>
          <input
            type="range"
            className="ui-square-range"
            min={0}
            max={2}
            step={0.05}
            value={syncMotionTailSec}
            disabled={!syncEnabled}
            onChange={(e) => onSyncMotionTailSecChange?.(Number(e.target.value))}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ width: "100%", borderTop: "none" }}
          />
          <div style={{ marginTop: 2, fontSize: 10, color: "#888", fontFamily: "monospace" }}>
            {syncMotionTailSec.toFixed(2)}s
          </div>
        </label>
        <div style={{ fontSize: 10, color: "#777", lineHeight: 1.35 }}>
          {syncEnabled
            ? "Match start pose to outgoing end (video ↔ image ok)"
            : "Needs a connected video/image pair"}
        </div>
      </div>
    </div>
  );
}
