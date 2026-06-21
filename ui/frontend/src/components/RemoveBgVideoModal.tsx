"use client";

import React, { useEffect, useState } from "react";
import type { AnimeSegBgOptions, RmbgBgOptions, RvmBgOptions } from "../lib/api";
import {
  AnimeSegFields,
  DEFAULT_ANIME_SEG_OPTIONS,
  DEFAULT_RMBG_OPTIONS,
  RemoveBgNumberField,
  RmbgFields,
  removeBgInputStyle,
  removeBgLabelStyle,
} from "./removeBg/RemoveBgFields";

type Tab = "rvm" | "rmbg" | "anime_seg";

function FpsOptions(props: {
  busy?: boolean;
  outputFps24: boolean;
  recycleMask: boolean;
  onOutputFps24Change: (v: boolean) => void;
  onRecycleMaskChange: (v: boolean) => void;
  hint: string;
}) {
  const {
    busy,
    outputFps24,
    recycleMask,
    onOutputFps24Change,
    onRecycleMaskChange,
    hint,
  } = props;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          cursor: busy ? "not-allowed" : "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={outputFps24}
          disabled={busy}
          onChange={(e) => onOutputFps24Change(e.target.checked)}
        />
        24 fps output (process every frame)
      </label>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          opacity: outputFps24 ? 1 : 0.45,
          cursor: busy || !outputFps24 ? "not-allowed" : "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={recycleMask}
          disabled={busy || !outputFps24}
          onChange={(e) => onRecycleMaskChange(e.target.checked)}
        />
        Recycle mask (keyframes at 12 fps, hold alpha between)
      </label>
      <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", margin: 0 }}>{hint}</p>
    </div>
  );
}

export function RemoveBgVideoModal(props: {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onRunRvm: (options: RvmBgOptions) => void | Promise<void>;
  onRunRmbg: (options: {
    outputFps24: boolean;
    recycleMask: boolean;
    rmbg: RmbgBgOptions;
  }) => void | Promise<void>;
  onRunAnimeSeg: (options: {
    outputFps24: boolean;
    recycleMask: boolean;
    animeSeg: AnimeSegBgOptions;
  }) => void | Promise<void>;
}) {
  const { open, busy = false, onCancel, onRunRvm, onRunRmbg, onRunAnimeSeg } = props;

  const [tab, setTab] = useState<Tab>("rvm");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [rvmPreset, setRvmPreset] = useState<"fast" | "quality">("fast");
  const [rvmDownsample, setRvmDownsample] = useState(0.25);
  const [rvmBackbone, setRvmBackbone] = useState<"mobilenetv3" | "resnet50">(
    "mobilenetv3"
  );
  const [rvmAlphaGrow, setRvmAlphaGrow] = useState(0);
  const [rvmUseSourceRgb, setRvmUseSourceRgb] = useState(true);

  const [outputFps24, setOutputFps24] = useState(false);
  const [recycleMask, setRecycleMask] = useState(false);
  const [rmbg, setRmbg] = useState<RmbgBgOptions>(DEFAULT_RMBG_OPTIONS);
  const [animeSeg, setAnimeSeg] = useState<AnimeSegBgOptions>(DEFAULT_ANIME_SEG_OPTIONS);

  useEffect(() => {
    if (!open) return;
    setTab("rvm");
    setAdvancedOpen(false);
    setRvmPreset("fast");
    setRvmDownsample(0.25);
    setRvmBackbone("mobilenetv3");
    setRvmAlphaGrow(0);
    setRvmUseSourceRgb(true);
    setOutputFps24(false);
    setRecycleMask(false);
    setRmbg({ ...DEFAULT_RMBG_OPTIONS });
    setAnimeSeg({ ...DEFAULT_ANIME_SEG_OPTIONS });
  }, [open]);

  useEffect(() => {
    if (rvmPreset === "quality") {
      setRvmBackbone("resnet50");
      setRvmDownsample(0.375);
    } else {
      setRvmBackbone("mobilenetv3");
      setRvmDownsample(0.25);
    }
  }, [rvmPreset]);

  useEffect(() => {
    if (!outputFps24) setRecycleMask(false);
  }, [outputFps24]);

  if (!open) return null;

  const run = () => {
    if (tab === "rvm") {
      void onRunRvm({
        preset: rvmPreset,
        downsampleRatio: rvmDownsample,
        backbone: rvmBackbone,
        alphaDilatePx: rvmAlphaGrow,
        useSourceRgb: rvmUseSourceRgb,
      });
    } else if (tab === "rmbg") {
      void onRunRmbg({
        outputFps24,
        recycleMask,
        rmbg,
      });
    } else {
      void onRunAnimeSeg({
        outputFps24,
        recycleMask,
        animeSeg,
      });
    }
  };

  const tabBtn = (id: Tab, label: string, hint: string) => (
    <button
      key={id}
      type="button"
      className="ui-btn-black"
      disabled={busy}
      style={{
        flex: 1,
        cursor: busy ? "not-allowed" : "pointer",
        opacity: tab === id ? 1 : 0.65,
        border:
          tab === id
            ? "1px solid rgba(72, 210, 120, 0.6)"
            : "1px solid rgba(255,255,255,0.15)",
        background: tab === id ? "rgba(72, 210, 120, 0.12)" : undefined,
      }}
      onClick={(e) => {
        e.preventDefault();
        setTab(id);
      }}
    >
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>{hint}</div>
    </button>
  );

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
        if (!busy) onCancel();
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: "100%",
          maxHeight: "min(92vh, 720px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "#141414",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 8,
          boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: "14px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.12)",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          Remove Background
        </div>

        <div style={{ padding: 16, overflow: "auto", flex: 1 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
            {tabBtn("rvm", "RVM", "Fast temporal")}
            {tabBtn("rmbg", "RMBG", "Per-frame matte")}
            {tabBtn("anime_seg", "Anime Seg", "Anime characters")}
          </div>

          {tab === "rvm" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "block" }}>
                <div style={removeBgLabelStyle}>Quality preset</div>
                <select
                  value={rvmPreset}
                  disabled={busy}
                  style={removeBgInputStyle}
                  onChange={(e) =>
                    setRvmPreset(e.target.value as "fast" | "quality")
                  }
                >
                  <option value="fast">Fast (mobilenetv3)</option>
                  <option value="quality">Quality (resnet50)</option>
                </select>
              </label>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", margin: 0 }}>
                Robust Video Matting processes every frame with temporal consistency.
                First run loads the model (~15 s).
              </p>
            </div>
          ) : tab === "rmbg" ? (
            <FpsOptions
              busy={busy}
              outputFps24={outputFps24}
              recycleMask={recycleMask}
              onOutputFps24Change={setOutputFps24}
              onRecycleMaskChange={setRecycleMask}
              hint="Default: RMBG at ~12 fps keyframes, recycle alpha between frames, output at source fps (preserves duration)."
            />
          ) : (
            <FpsOptions
              busy={busy}
              outputFps24={outputFps24}
              recycleMask={recycleMask}
              onOutputFps24Change={setOutputFps24}
              onRecycleMaskChange={setRecycleMask}
              hint="Default: segment at ~12 fps keyframes, recycle alpha between frames, output at source fps (preserves duration). Best for illustrated characters."
            />
          )}

          <button
            type="button"
            className="ui-btn-black"
            disabled={busy}
            style={{
              marginTop: 16,
              width: "100%",
              textAlign: "left",
              cursor: busy ? "not-allowed" : "pointer",
            }}
            onClick={(e) => {
              e.preventDefault();
              setAdvancedOpen((v) => !v);
            }}
          >
            Advanced {advancedOpen ? "▾" : "▸"}
          </button>

          {advancedOpen ? (
            <div
              style={{
                marginTop: 12,
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              {tab === "rvm" ? (
                <>
                  <label style={{ display: "block", gridColumn: "1 / -1" }}>
                    <div style={removeBgLabelStyle}>Backbone</div>
                    <select
                      value={rvmBackbone}
                      disabled={busy}
                      style={removeBgInputStyle}
                      onChange={(e) =>
                        setRvmBackbone(
                          e.target.value as "mobilenetv3" | "resnet50"
                        )
                      }
                    >
                      <option value="mobilenetv3">mobilenetv3</option>
                      <option value="resnet50">resnet50</option>
                    </select>
                  </label>
                  <RemoveBgNumberField
                    label="Downsample ratio"
                    value={rvmDownsample}
                    min={0.1}
                    max={1}
                    step={0.025}
                    disabled={busy}
                    onChange={setRvmDownsample}
                  />
                  <RemoveBgNumberField
                    label="Alpha grow (px)"
                    value={rvmAlphaGrow}
                    min={0}
                    max={20}
                    disabled={busy}
                    onChange={setRvmAlphaGrow}
                  />
                  <label
                    style={{
                      gridColumn: "1 / -1",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={rvmUseSourceRgb}
                      disabled={busy}
                      onChange={(e) => setRvmUseSourceRgb(e.target.checked)}
                    />
                    Use original colors (source RGB + RVM alpha)
                  </label>
                </>
              ) : tab === "rmbg" ? (
                <RmbgFields value={rmbg} disabled={busy} onChange={setRmbg} />
              ) : (
                <AnimeSegFields value={animeSeg} disabled={busy} onChange={setAnimeSeg} />
              )}
            </div>
          ) : null}
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
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              onCancel();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ui-btn-black"
            disabled={busy}
            style={{
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
            onClick={(e) => {
              e.preventDefault();
              run();
            }}
          >
            {busy ? "Running…" : "Remove Background"}
          </button>
        </div>
      </div>
    </div>
  );
}
