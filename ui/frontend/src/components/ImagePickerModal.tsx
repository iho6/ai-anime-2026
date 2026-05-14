"use client";

import React, { useMemo, useState } from "react";
import { assetUrlFromRelPath, CoverCandidate } from "../lib/api";

export function ImagePickerModal(props: {
  open: boolean;
  title: string;
  images: CoverCandidate[];
  okText: string;
  cancelText: string;
  onPick: (relPath: string) => void;
  onCancel: () => void;
}) {
  const { open, title, images, okText, cancelText, onPick, onCancel } = props;
  const [selected, setSelected] = useState<string>("");

  React.useEffect(() => {
    if (!open) setSelected("");
  }, [open]);

  const thumbs = useMemo(() => {
    return images.map((img) => ({
      relPath: img.relPath,
      caption: img.caption,
      url: assetUrlFromRelPath(img.relPath),
    }));
  }, [images]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9998,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div
        style={{
          width: 720,
          maxWidth: "100%",
          height: "min(92vh, 880px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "#0b0b0b",
          borderRadius: 0,
          border: "1px solid rgba(255,255,255,0.25)",
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
      >
        <div
          style={{
            flexShrink: 0,
            color: "white",
            fontWeight: 400,
            padding: "12px 12px 10px",
          }}
        >
          {title}
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: "0 12px",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
              gap: 10,
              paddingBottom: 8,
            }}
          >
            {thumbs.map((t) => {
              const isOn = selected === t.relPath;
              return (
                <button
                  key={t.relPath}
                  onClick={(e) => {
                    e.preventDefault();
                    setSelected(t.relPath);
                  }}
                  className={`image-picker-tile${isOn ? " image-picker-tile--selected" : ""}`}
                  style={{
                    borderRadius: 0,
                    border: "1px solid transparent",
                    background: "transparent",
                    padding: 6,
                    cursor: "pointer",
                  }}
                >
                  <img
                    src={t.url}
                    alt=""
                    style={{
                      width: "100%",
                      aspectRatio: "1/1",
                      objectFit: "contain",
                      display: "block",
                    }}
                  />
                </button>
              );
            })}
          </div>
        </div>

        <div
          style={{
            flexShrink: 0,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            padding: "12px",
            borderTop: "1px solid rgba(255,255,255,0.15)",
            background: "#0b0b0b",
          }}
        >
          <button
            onClick={(e) => {
              e.preventDefault();
              onCancel();
            }}
            className="ui-btn-black"
          >
            {cancelText}
          </button>
          <button
            onClick={(e) => {
              e.preventDefault();
              if (!selected) return;
              onPick(selected);
            }}
            className="ui-btn-black"
            style={{ cursor: selected ? "pointer" : "not-allowed", opacity: selected ? 1 : 0.6 }}
            disabled={!selected}
          >
            {okText}
          </button>
        </div>
      </div>
    </div>
  );
}

