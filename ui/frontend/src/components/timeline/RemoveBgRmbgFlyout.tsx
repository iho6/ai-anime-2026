"use client";

import React, { useState } from "react";
import type { RmbgBgOptions } from "../../lib/api";
import {
  DEFAULT_RMBG_OPTIONS,
  RmbgFields,
} from "../removeBg/RemoveBgFields";

export type RemoveBgRmbgFlyoutRunOptions = {
  rmbg: RmbgBgOptions;
  /** Video only: true = every source frame; false = ~12 fps keyframe recycle. */
  everyFrame?: boolean;
};

export function RemoveBgRmbgFlyout(props: {
  mediaKind: "image" | "video";
  busy?: boolean;
  onRun: (options: RemoveBgRmbgFlyoutRunOptions) => void;
}) {
  const { mediaKind, busy = false, onRun } = props;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rmbg, setRmbg] = useState<RmbgBgOptions>(() => ({ ...DEFAULT_RMBG_OPTIONS }));
  /** false = 12 fps keyframe path (default); true = process every frame. */
  const [everyFrame, setEveryFrame] = useState(false);

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        padding: "8px 10px",
        minWidth: 220,
        maxWidth: 280,
      }}
    >
      {mediaKind === "video" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "#aaa",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            <input
              type="radio"
              name="rmbg-fps"
              checked={!everyFrame}
              disabled={busy}
              onChange={() => setEveryFrame(false)}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            />
            12 fps
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              color: "#aaa",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            <input
              type="radio"
              name="rmbg-fps"
              checked={everyFrame}
              disabled={busy}
              onChange={() => setEveryFrame(true)}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            />
            Every frame
          </label>
        </div>
      ) : null}

      <div
        role="button"
        tabIndex={0}
        aria-expanded={advancedOpen}
        onClick={() => {
          if (busy) return;
          setAdvancedOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (busy) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setAdvancedOpen((v) => !v);
          }
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          boxSizing: "border-box",
          cursor: busy ? "not-allowed" : "pointer",
          userSelect: "none",
          fontSize: 11,
          color: "#aaa",
          padding: "2px 0",
          opacity: busy ? 0.5 : 1,
        }}
      >
        <span
          style={{
            display: "inline-block",
            transform: advancedOpen ? "none" : "rotate(-90deg)",
            transition: "transform 0.12s",
          }}
        >
          ▾
        </span>
        <span>Advanced</span>
      </div>

      {advancedOpen ? (
        <div
          style={{
            marginTop: 8,
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: 8,
          }}
        >
          <RmbgFields value={rmbg} disabled={busy} onChange={setRmbg} />
        </div>
      ) : null}

      <button
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRun({
            rmbg,
            ...(mediaKind === "video" ? { everyFrame } : {}),
          });
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          appearance: "none",
          display: "block",
          width: "100%",
          marginTop: 10,
          padding: "6px 8px",
          borderRadius: 0,
          border: "1px solid rgba(255,255,255,0.35)",
          background: "rgba(110,181,255,0.15)",
          color: "white",
          fontSize: 11,
          cursor: busy ? "not-allowed" : "pointer",
          textAlign: "left",
          font: "inherit",
          opacity: busy ? 0.5 : 1,
        }}
      >
        Run RMBG
      </button>
    </div>
  );
}
