"use client";

import React from "react";
import {
  assetUrlFromRelPath,
  type GeneratedReferencePreview,
  type ReferenceImageItem,
  type ReferenceMediaKind,
  type ReferenceVideoItem,
} from "../lib/api";
import { ReferenceGeneratePanel } from "./ReferenceGeneratePanel";

export type RefGalleryItem =
  | { kind: "image"; item: ReferenceImageItem }
  | { kind: "video"; item: ReferenceVideoItem };

export function Reference2DGenTab(props: {
  busy: boolean;
  gallery: RefGalleryItem[];
  selectedIds: Set<string>;
  onSelectedIdsChange: (ids: Set<string>) => void;
  preview: GeneratedReferencePreview | null;
  onPreviewChange: (preview: GeneratedReferencePreview | null) => void;
  onGenerate: (args: {
    kind: ReferenceMediaKind;
    promptText: string;
    width: number;
    height: number;
    length?: number;
  }) => Promise<GeneratedReferencePreview | null>;
  onConvertToKeypoint: () => void;
  onDeleteSelected?: () => void;
}) {
  const {
    busy,
    gallery,
    selectedIds,
    onSelectedIdsChange,
    preview,
    onPreviewChange,
    onGenerate,
    onConvertToKeypoint,
    onDeleteSelected,
  } = props;

  const toggle = (id: string, multi: boolean) => {
    const next = new Set(multi ? selectedIds : []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedIdsChange(next);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <div style={{ flexShrink: 0, maxHeight: "55%", overflow: "auto", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
        <ReferenceGeneratePanel
          busy={busy}
          hideCancel
          hideSave
          preview={preview}
          onPreviewChange={onPreviewChange}
          onGenerate={onGenerate}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
        <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>Gallery</div>
        {gallery.length === 0 ? (
          <div style={{ fontSize: 12, color: "#555", padding: "16px 0" }}>
            No saved refs yet — generate to add them.
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {gallery.map((g) => {
              const id = `${g.kind}:${g.item.itemId}`;
              const selected = selectedIds.has(id);
              return (
                <button
                  key={id}
                  type="button"
                  disabled={busy}
                  onClick={(e) => toggle(id, e.shiftKey || e.metaKey || e.ctrlKey)}
                  style={{
                    width: 88,
                    padding: 0,
                    border: selected
                      ? "2px solid rgba(130,190,255,0.95)"
                      : "1px solid rgba(255,255,255,0.2)",
                    background: "transparent",
                    cursor: "pointer",
                    color: "inherit",
                  }}
                  title={g.kind === "video" ? "Video ref" : "Image ref"}
                >
                  {g.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={assetUrlFromRelPath(g.item.relPath)}
                      alt=""
                      style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }}
                    />
                  ) : (
                    <video
                      src={assetUrlFromRelPath(g.item.relPath)}
                      muted
                      playsInline
                      style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }}
                    />
                  )}
                  <div style={{ fontSize: 9, color: "#888", padding: "2px 4px" }}>
                    {g.kind === "video" ? "video" : "image"}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div
        style={{
          flexShrink: 0,
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          padding: "10px 0 0",
          borderTop: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        {onDeleteSelected && selectedIds.size > 0 ? (
          <button
            type="button"
            disabled={busy}
            className="ui-btn-black"
            onClick={onDeleteSelected}
            style={{ opacity: busy ? 0.5 : 1 }}
          >
            Delete
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || selectedIds.size === 0}
          className="ui-btn-black"
          onClick={onConvertToKeypoint}
          style={{
            cursor: busy || selectedIds.size === 0 ? "not-allowed" : "pointer",
            opacity: busy || selectedIds.size === 0 ? 0.5 : 1,
          }}
        >
          Convert to Keypoint
        </button>
      </div>
    </div>
  );
}
