"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  MOTION_REF_MAX_SEGMENT_DURATION_SEC,
  MOTION_REF_MIN_SEGMENT_DURATION_SEC,
} from "../../lib/api";
import { PromptAdherenceKnob } from "./PromptAdherenceKnob";
import { TransitionFramesKnob } from "./TransitionFramesKnob";
import {
  MOTION_REF_HINT_COLOR,
  MOTION_REF_LABEL_COLOR,
  MOTION_REF_VALUE_COLOR,
} from "./theme";

const CLOSE_DELAY_MS = 220;
/** Above Add Character (9998) and ReferencePicker modal (10000). */
const FLYOUT_Z = 10500;
const PANEL_WIDTH = 260;
const GAP_PX = 6;
const BRIDGE_WIDTH_PX = 10;

type PanelPos = { left: number; top: number; openLeft: boolean };

export function MotionRefSettingsFlyout(props: {
  disabled?: boolean;
  promptAdherence: number;
  onPromptAdherenceChange: (value: number) => void;
  numTransitionFrames: number;
  onNumTransitionFramesChange: (value: number) => void;
  durationSec: number;
  onDurationSecChange: (value: number) => void;
}) {
  const {
    disabled = false,
    promptAdherence,
    onPromptAdherenceChange,
    numTransitionFrames,
    onNumTransitionFramesChange,
    durationSec,
    onDurationSecChange,
  } = props;

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearCloseTimer() {
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function scheduleClose() {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }

  function openNow() {
    if (disabled) return;
    clearCloseTimer();
    setOpen(true);
  }

  const updatePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceRight = window.innerWidth - r.right - GAP_PX;
    const openLeft = spaceRight < PANEL_WIDTH + 8 && r.left > PANEL_WIDTH + GAP_PX;
    const left = openLeft ? r.left - GAP_PX - PANEL_WIDTH : r.right + GAP_PX;
    const top = Math.max(8, Math.min(r.top, window.innerHeight - 320));
    setPos({ left, top, openLeft });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onReposition = () => updatePos();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, updatePos]);

  useEffect(() => () => clearCloseTimer(), []);

  const panel =
    open && pos && typeof document !== "undefined"
      ? createPortal(
          <div
            role="dialog"
            aria-label="Motion settings"
            data-motion-ref-settings-flyout
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              zIndex: FLYOUT_Z,
              width: PANEL_WIDTH,
              pointerEvents: "none",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Bridge so the pointer can travel from › to the panel without closing */}
            <div
              aria-hidden
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                width: BRIDGE_WIDTH_PX,
                pointerEvents: "auto",
                ...(pos.openLeft
                  ? { left: "100%" }
                  : { right: "100%" }),
              }}
              onMouseEnter={openNow}
              onMouseLeave={scheduleClose}
            />
            <div
              style={{
                padding: 12,
                background: "#161616",
                border: "1px solid rgba(255,255,255,0.25)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
                display: "flex",
                flexDirection: "column",
                gap: 14,
                pointerEvents: "auto",
                color: "#eee",
              }}
              onMouseEnter={openNow}
              onMouseLeave={scheduleClose}
            >
              <PromptAdherenceKnob
                value={promptAdherence}
                onChange={onPromptAdherenceChange}
                disabled={disabled}
              />
              <TransitionFramesKnob
                value={numTransitionFrames}
                onChange={onNumTransitionFramesChange}
                disabled={disabled}
              />
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                    fontSize: 11,
                    color: MOTION_REF_LABEL_COLOR,
                  }}
                >
                  <span>Duration (s)</span>
                  <span
                    style={{ fontVariantNumeric: "tabular-nums", color: MOTION_REF_VALUE_COLOR }}
                  >
                    {durationSec.toFixed(1)}
                  </span>
                </div>
                <input
                  type="range"
                  className="ui-square-range"
                  min={MOTION_REF_MIN_SEGMENT_DURATION_SEC}
                  max={MOTION_REF_MAX_SEGMENT_DURATION_SEC}
                  step={0.5}
                  value={durationSec}
                  disabled={disabled}
                  onChange={(e) => onDurationSecChange(Number(e.target.value))}
                  title={`Segment duration (max ${MOTION_REF_MAX_SEGMENT_DURATION_SEC}s)`}
                  style={{
                    width: "100%",
                    opacity: disabled ? 0.5 : 1,
                    cursor: disabled ? "not-allowed" : "pointer",
                  }}
                />
                <div style={{ fontSize: 10, color: MOTION_REF_HINT_COLOR, marginTop: 4 }}>
                  Applies to all motion segments
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <div
        style={{ position: "relative", flexShrink: 0, alignSelf: "flex-start", marginTop: 6 }}
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
      >
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-label="Motion settings"
          aria-expanded={open}
          title="Prompt adherence, transition frames, duration"
          onClick={() => (open ? setOpen(false) : openNow())}
          style={{
            width: 22,
            height: 28,
            padding: 0,
            border: "1px solid rgba(255,255,255,0.25)",
            background: open ? "rgba(255,255,255,0.12)" : "transparent",
            color: "#bbb",
            cursor: disabled ? "default" : "pointer",
            fontSize: 14,
            lineHeight: 1,
            opacity: disabled ? 0.45 : 1,
          }}
        >
          ›
        </button>
      </div>
      {panel}
    </>
  );
}
