"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiTimelineAssetsLayout,
  assetUrlFromRelPath,
  type TimelineAsset,
  type TimelineAssetLayout,
} from "../lib/api";
import { ZoomableImage } from "./ZoomableImage";

export type T2iModelMode = "anime" | "general";

export function TimelineOtherAssetPicker(props: {
  open: boolean;
  timelineKey: string;
  busy: boolean;
  onCancel: () => void;
  onGenerate: (prompt: string, modelMode: T2iModelMode) => Promise<TimelineAsset | null>;
  onUseSelected: (items: TimelineAsset[]) => void;
}) {
  if (!props.open) return null;
  return <TimelineOtherAssetPickerOpen {...props} />;
}

function TimelineOtherAssetPickerOpen(props: {
  timelineKey: string;
  busy: boolean;
  onCancel: () => void;
  onGenerate: (prompt: string, modelMode: T2iModelMode) => Promise<TimelineAsset | null>;
  onUseSelected: (items: TimelineAsset[]) => void;
}) {
  const { timelineKey, busy, onCancel, onGenerate, onUseSelected } = props;

  const [modelMode, setModelMode] = useState<T2iModelMode>("general");
  const [prompt, setPrompt] = useState("");
  const [layout, setLayout] = useState<TimelineAssetLayout>({ order: [], items: [] });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);

  const loadLayout = useCallback(async () => {
    try {
      const data = await apiTimelineAssetsLayout(timelineKey);
      setLayout(data);
    } catch {
      /* ignore */
    }
  }, [timelineKey]);

  useEffect(() => {
    void loadLayout();
  }, [loadLayout]);

  const itemById = useMemo(() => new Map(layout.items.map((x) => [x.id, x])), [layout.items]);

  const previewItem = previewId ? itemById.get(previewId) ?? null : null;

  const orderedSelection = (): TimelineAsset[] => {
    const out: TimelineAsset[] = [];
    for (const id of layout.order) {
      if (!selectedIds.has(id)) continue;
      const it = itemById.get(id);
      if (it) out.push(it);
    }
    for (const id of selectedIds) {
      if (!out.some((x) => x.id === id)) {
        const it = itemById.get(id);
        if (it) out.push(it);
      }
    }
    return out;
  };

  function selectGalleryItem(id: string, additive: boolean) {
    setSelectedIds((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPreviewId(id);
  }

  async function handleGenerate() {
    const p = prompt.trim();
    if (!p || busy) return;
    const item = await onGenerate(p, modelMode);
    if (!item) return;
    setLayout((prev) => ({
      order: [item.id, ...prev.order.filter((x) => x !== item.id)],
      items: [item, ...prev.items.filter((x) => x.id !== item.id)],
    }));
    setSelectedIds(new Set([item.id]));
    setPreviewId(item.id);
  }

  const canGenerate = !busy && prompt.trim().length > 0;
  const canUse = !busy && selectedIds.size > 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div
        style={{
          width: 640,
          maxWidth: "100%",
          maxHeight: "88vh",
          overflow: "hidden",
          background: "#111",
          color: "#eee",
          border: "1px solid rgba(255,255,255,0.2)",
          padding: 14,
          display: "flex",
          flexDirection: "column",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 400, marginBottom: 10 }}>Add Other Asset</div>

        <div style={{ display: "flex", gap: 16, marginBottom: 10, fontSize: 13 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: busy ? "not-allowed" : "pointer" }}>
            <input
              type="checkbox"
              checked={modelMode === "anime"}
              disabled={busy}
              onChange={() => setModelMode("anime")}
            />
            Anime
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: busy ? "not-allowed" : "pointer" }}>
            <input
              type="checkbox"
              checked={modelMode === "general"}
              disabled={busy}
              onChange={() => setModelMode("general")}
            />
            General
          </label>
        </div>

        <div
          style={{
            height: 220,
            minHeight: 160,
            marginBottom: 10,
            border: "1px solid rgba(255,255,255,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            background: "#0a0a0a",
          }}
        >
          {previewItem ? (
            <ZoomableImage
              src={assetUrlFromRelPath(previewItem.relPath)}
              fitMaxWidth="100%"
              fitMaxHeight="100%"
            />
          ) : (
            <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>
              Generate or select a thumbnail to preview.
            </span>
          )}
        </div>

        <textarea
          value={prompt}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the image to generate…"
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            border: "1px solid rgba(255,255,255,0.2)",
            background: "transparent",
            color: "#eee",
            fontSize: 13,
            padding: 8,
            marginBottom: 8,
          }}
        />

        <button
          type="button"
          className="ui-btn-black"
          disabled={!canGenerate}
          onClick={() => void handleGenerate()}
          style={{
            width: "100%",
            marginBottom: 10,
            cursor: canGenerate ? "pointer" : "not-allowed",
            opacity: canGenerate ? 1 : 0.5,
          }}
        >
          Generate
        </button>

        <div
          style={{
            flex: 1,
            minHeight: 100,
            overflow: "auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignContent: "flex-start",
            padding: 4,
            border: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          {layout.items.map((item) => {
            const sel = selectedIds.has(item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={(e) => selectGalleryItem(item.id, e.shiftKey)}
                style={{
                  width: 72,
                  height: 72,
                  padding: 0,
                  border: sel ? "2px solid #fff" : "1px solid rgba(255,255,255,0.25)",
                  background: "#000",
                  cursor: busy ? "not-allowed" : "pointer",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
                title={item.prompt || item.id}
              >
                <img
                  src={assetUrlFromRelPath(item.relPath)}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              </button>
            );
          })}
          {layout.items.length === 0 ? (
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", padding: 8 }}>
              No generated assets yet.
            </span>
          ) : null}
        </div>

        <div
          style={{
            marginTop: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              className="ui-btn-black"
              disabled={!canUse}
              onClick={() => onUseSelected(orderedSelection())}
              style={{
                cursor: canUse ? "pointer" : "not-allowed",
                opacity: canUse ? 1 : 0.5,
              }}
            >
              Use Selected
            </button>
            {selectedIds.size > 0 ? (
              <span style={{ fontSize: 12, opacity: 0.7 }}>{selectedIds.size} selected</span>
            ) : null}
          </div>
          <button type="button" className="ui-btn-black" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
