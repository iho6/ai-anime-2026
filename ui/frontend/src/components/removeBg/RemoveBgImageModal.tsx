"use client";

import React, { useEffect, useState } from "react";
import type { RemoveBgEngine, RemoveBgImageRunOptions } from "../../lib/api";
import {
  AnimeSegFields,
  DEFAULT_ANIME_SEG_OPTIONS,
  DEFAULT_RMBG_OPTIONS,
  RmbgFields,
} from "./RemoveBgFields";

export function RemoveBgImageModal(props: {
  open: boolean;
  busy?: boolean;
  title?: string;
  onCancel: () => void;
  onRun: (options: RemoveBgImageRunOptions) => void | Promise<void>;
}) {
  const { open, busy = false, title = "Remove Background", onCancel, onRun } = props;

  const [engine, setEngine] = useState<RemoveBgEngine>("rmbg");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rmbg, setRmbg] = useState(DEFAULT_RMBG_OPTIONS);
  const [animeSeg, setAnimeSeg] = useState(DEFAULT_ANIME_SEG_OPTIONS);

  useEffect(() => {
    if (!open) return;
    setEngine("rmbg");
    setAdvancedOpen(false);
    setRmbg({ ...DEFAULT_RMBG_OPTIONS });
    setAnimeSeg({ ...DEFAULT_ANIME_SEG_OPTIONS });
  }, [open]);

  if (!open) return null;

  const tabBtn = (id: RemoveBgEngine, label: string, hint: string) => (
    <button
      key={id}
      type="button"
      className="ui-btn-black"
      disabled={busy}
      style={{
        flex: 1,
        cursor: busy ? "not-allowed" : "pointer",
        opacity: engine === id ? 1 : 0.65,
        border:
          engine === id
            ? "1px solid rgba(110,181,255,0.7)"
            : "1px solid rgba(255,255,255,0.15)",
        background: engine === id ? "rgba(110,181,255,0.12)" : undefined,
      }}
      onClick={(e) => {
        e.preventDefault();
        setEngine(id);
      }}
    >
      <div style={{ fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>{hint}</div>
    </button>
  );

  const run = () => {
    void onRun({
      engine,
      rmbg: engine === "rmbg" ? rmbg : undefined,
      animeSeg: engine === "anime_seg" ? animeSeg : undefined,
    });
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
      onMouseDown={onCancel}
    >
      <div
        data-native-clipboard-shortcuts
        style={{
          background: "#141414",
          color: "#eee",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 0,
          width: "100%",
          maxWidth: 480,
          maxHeight: "90vh",
          overflow: "auto",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{title}</div>
        </div>

        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {tabBtn("rmbg", "RMBG", "General-purpose matting")}
            {tabBtn("anime_seg", "Anime Seg", "Anime character segmentation")}
          </div>

          <button
            type="button"
            className="ui-btn-black"
            disabled={busy}
            style={{
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
              {engine === "rmbg" ? (
                <RmbgFields value={rmbg} disabled={busy} onChange={setRmbg} />
              ) : (
                <AnimeSegFields value={animeSeg} disabled={busy} onChange={setAnimeSeg} />
              )}
            </div>
          ) : null}
        </div>

        <div
          style={{
            padding: 12,
            borderTop: "1px solid rgba(255,255,255,0.12)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button type="button" className="ui-btn-black" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="ui-btn-black"
            disabled={busy}
            style={{ background: "rgba(110,181,255,0.2)" }}
            onClick={(e) => {
              e.preventDefault();
              run();
            }}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
