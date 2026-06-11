"use client";

import React, { useEffect, useRef } from "react";
import type {
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

export function ClipTransitionMenu(props: {
  open: boolean;
  x: number;
  y: number;
  transition: TimelineTransitionOut | undefined;
  onChange: (transition: TimelineTransitionOut | undefined) => void;
  onCommit: () => void;
  onClose: () => void;
}) {
  const { open, x, y, transition, onChange, onCommit, onClose } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const activeType = transition?.type;
  const duration = transition?.duration ?? DEFAULT_TRANSITION_DURATION;
  const direction =
    transition?.direction ??
    (activeType ? defaultDirection(activeType) : "left");
  const showDirection = activeType === "wipe" || activeType === "slide";

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

  const btnBase: React.CSSProperties = {
    display: "block",
    width: "100%",
    padding: "8px 10px",
    marginBottom: 6,
    textAlign: "left",
    color: "#eee",
    cursor: "pointer",
    fontSize: 13,
    border: "1px solid rgba(255,255,255,0.15)",
  };

  return (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 20000,
        background: "#1a1a1a",
        border: "1px solid rgba(255,255,255,0.25)",
        borderRadius: 4,
        padding: 10,
        minWidth: 200,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {TYPES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => pickType(t.id)}
          style={{
            ...btnBase,
            background:
              activeType === t.id ? "rgba(255,209,102,0.2)" : "rgba(255,255,255,0.06)",
            borderColor:
              activeType === t.id ? "#ffd166" : "rgba(255,255,255,0.15)",
          }}
        >
          {t.label}
        </button>
      ))}

      {showDirection ? (
        <>
          <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>Direction</div>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {DIRECTIONS.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => pickDirection(d.id)}
                style={{
                  flex: 1,
                  padding: "6px 0",
                  background:
                    direction === d.id
                      ? "rgba(255,209,102,0.2)"
                      : "rgba(255,255,255,0.06)",
                  border:
                    direction === d.id
                      ? "1px solid #ffd166"
                      : "1px solid rgba(255,255,255,0.15)",
                  color: "#eee",
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>Duration</div>
      <input
        type="range"
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
        style={{ width: "100%" }}
      />
      <div style={{ fontSize: 11, color: "#ccc", marginTop: 4, marginBottom: 8 }}>
        {duration.toFixed(2)}s
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
            width: "100%",
            padding: "6px 10px",
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.2)",
            color: "#e99",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Remove transition
        </button>
      ) : null}
    </div>
  );
}
