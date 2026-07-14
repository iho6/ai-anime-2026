"use client";

import React, { forwardRef, useEffect, useRef, useState } from "react";
import {
  normalizeBlendEase,
  normalizeHoldSec,
  PAUSE_HOLD_SEC_STEP,
  pauseHoldSecSliderMax,
} from "./trajectoryWaypoint";

const BRIDGE_WIDTH_PX = 12;

type KnobRowProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  formatValue?: (v: number) => string;
  onChange: (value: number) => void;
  onCommit: () => void;
};

function KnobRow(props: KnobRowProps) {
  const {
    label,
    value,
    min,
    max,
    step = PAUSE_HOLD_SEC_STEP,
    suffix = "",
    formatValue,
    onChange,
    onCommit,
  } = props;
  const display = formatValue ? formatValue(value) : `${value}${suffix}`;
  return (
    <div
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid rgba(255,255,255,0.25)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          fontSize: 15,
          color: "white",
        }}
      >
        <span>{label}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 14 }}>{display}</span>
      </div>
      <input
        type="range"
        className="ui-square-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={(e) => {
          if (e.key === "Enter") onCommit();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          accentColor: "rgba(255,255,255,0.85)",
          cursor: "pointer",
        }}
      />
    </div>
  );
}

export type TrajectoryWaypointPatchValues = {
  holdSec: number;
  blendEase: number;
};

export type TrajectoryWaypointFlyoutBridgeSide = "left" | "right";

type Props = {
  x: number;
  y: number;
  bridgeSide?: TrajectoryWaypointFlyoutBridgeSide;
  holdSec: number;
  maxHoldSec: number;
  blendEase: number;
  /** When false (final waypoint), only Glide ease is shown. */
  showPause?: boolean;
  onPatchChange: (patch: TrajectoryWaypointPatchValues) => void;
  onPatchCommit: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

export const TrajectoryWaypointFlyout = forwardRef<HTMLDivElement, Props>(
  function TrajectoryWaypointFlyout(props, ref) {
    const {
      x,
      y,
      bridgeSide = "left",
      holdSec,
      maxHoldSec,
      blendEase,
      showPause = true,
      onPatchChange,
      onPatchCommit,
      onMouseEnter,
      onMouseLeave,
    } = props;
    const [localHold, setLocalHold] = useState(holdSec);
    const [localEase, setLocalEase] = useState(blendEase);
    const savedRef = useRef({ holdSec, blendEase });

    useEffect(() => {
      setLocalHold(holdSec);
      setLocalEase(blendEase);
      savedRef.current = { holdSec, blendEase };
    }, [holdSec, blendEase]);

    function commitIfChanged() {
      const saved = savedRef.current;
      const nextHold = normalizeHoldSec(localHold, maxHoldSec);
      const nextEase = normalizeBlendEase(localEase);
      if (nextHold === saved.holdSec && nextEase === saved.blendEase) return;
      savedRef.current = { holdSec: nextHold, blendEase: nextEase };
      onPatchCommit();
    }

    function emitLive(hold: number, ease: number) {
      onPatchChange({
        holdSec: normalizeHoldSec(hold, maxHoldSec),
        blendEase: normalizeBlendEase(ease),
      });
    }

    const holdMax = pauseHoldSecSliderMax(maxHoldSec);

    return (
      <div
        ref={ref}
        data-trajectory-waypoint-flyout
        style={{
          position: "fixed",
          top: y,
          left: x,
          zIndex: 10300,
          pointerEvents: "none",
        }}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: BRIDGE_WIDTH_PX,
            pointerEvents: "auto",
            ...(bridgeSide === "left"
              ? { right: "100%" }
              : { left: "100%" }),
          }}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        />
        <div
          style={{
            background: "rgba(0,0,0,0.85)",
            border: "1px solid rgba(255,255,255,0.35)",
            minWidth: 280,
            borderRadius: 0,
            overflow: "hidden",
            pointerEvents: "auto",
            color: "white",
          }}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          {showPause ? (
            <KnobRow
              label="Pause"
              value={localHold}
              min={0}
              max={holdMax}
              step={PAUSE_HOLD_SEC_STEP}
              formatValue={(v) => `${v.toFixed(2)}s`}
              onChange={(v) => {
                setLocalHold(v);
                emitLive(v, localEase);
              }}
              onCommit={commitIfChanged}
            />
          ) : null}
          <KnobRow
            label="Glide ease"
            value={localEase}
            min={0}
            max={100}
            step={1}
            onChange={(v) => {
              setLocalEase(v);
              emitLive(localHold, v);
            }}
            onCommit={commitIfChanged}
          />
          <div
            style={{
              padding: "10px 16px 12px",
              fontSize: 12,
              color: "rgba(255,255,255,0.55)",
            }}
          >
            {showPause
              ? "0 = linear speed · 100 = smooth decel into pause"
              : "0 = linear speed · 100 = smooth decel into final point"}
          </div>
        </div>
      </div>
    );
  }
);
