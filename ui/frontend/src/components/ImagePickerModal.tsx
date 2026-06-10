"use client";

import React, { useMemo, useState } from "react";
import { assetUrlFromRelPath, CoverCandidate } from "../lib/api";
import { TriangleIcon } from "./IconPrimitives";

export type ImagePickerSection = {
  title: string;
  images: CoverCandidate[];
  defaultOpen?: boolean;
};

type PickerThumb = { relPath: string; caption: string; url: string };

function ImagePickerTileGrid(props: {
  thumbs: PickerThumb[];
  selected: string;
  onSelect: (relPath: string) => void;
}) {
  const { thumbs, selected, onSelect } = props;
  return (
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
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onSelect(t.relPath);
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
  );
}

function CollapsiblePickerSection(props: {
  section: ImagePickerSection;
  selected: string;
  onSelect: (relPath: string) => void;
  emptyText: string;
}) {
  const { section, selected, onSelect, emptyText } = props;
  const [open, setOpen] = useState(section.defaultOpen ?? true);

  const thumbs = useMemo(
    () =>
      section.images.map((img) => ({
        relPath: img.relPath,
        caption: img.caption,
        url: assetUrlFromRelPath(img.relPath),
      })),
    [section.images]
  );

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "transparent",
          border: "none",
          color: "white",
          cursor: "pointer",
          padding: "4px 0",
          width: "100%",
          textAlign: "left",
          fontSize: 14,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            transform: open ? "none" : "rotate(-90deg)",
            transition: "transform 120ms ease",
          }}
        >
          <TriangleIcon direction="down" />
        </span>
        <span>{section.title}</span>
        <span style={{ opacity: 0.55, fontSize: 12 }}>({section.images.length})</span>
      </button>

      {open ? (
        thumbs.length === 0 ? (
          <div style={{ opacity: 0.55, fontSize: 13, padding: "4px 0 8px 22px" }}>{emptyText}</div>
        ) : (
          <div style={{ paddingTop: 4 }}>
            <ImagePickerTileGrid thumbs={thumbs} selected={selected} onSelect={onSelect} />
          </div>
        )
      ) : null}
    </div>
  );
}

export function ImagePickerModal(props: {
  open: boolean;
  title: string;
  images?: CoverCandidate[];
  sections?: ImagePickerSection[];
  okText: string;
  cancelText: string;
  onPick: (relPath: string) => void;
  onCancel: () => void;
}) {
  const { open, title, images = [], sections, okText, cancelText, onPick, onCancel } = props;
  const [selected, setSelected] = useState<string>("");

  React.useEffect(() => {
    if (!open) setSelected("");
  }, [open]);

  const useSections = Boolean(sections?.length);

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
          {useSections ? (
            sections!.map((section) => (
              <CollapsiblePickerSection
                key={section.title}
                section={section}
                selected={selected}
                onSelect={setSelected}
                emptyText={`No ${section.title.toLowerCase()} images`}
              />
            ))
          ) : (
            <ImagePickerTileGrid thumbs={thumbs} selected={selected} onSelect={setSelected} />
          )}
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
