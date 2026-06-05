"use client";

import React, { useEffect, useState } from "react";
import { assetUrlFromRelPath } from "../lib/api";
import {
  CollapsibleGallerySection,
  GallerySectionImage,
} from "./CollapsibleGallerySection";
import { SquareIconButton, TriangleIcon } from "./IconPrimitives";

export type ShotPickerIcon = {
  key: string;
  label: string;
  coverRelPath: string;
};

export type ShotPickerSection = {
  title: string;
  images: GallerySectionImage[];
};

/**
 * Two-stage selection modal shared by the shot backdrop and character pickers.
 *
 * Stage 1 shows a grid of square icons (locations or characters). Picking one
 * loads its gallery, shown in stage 2 as collapsible sections (Angles/Lighting
 * or Pose/Expression). Picking an image calls ``onPick(iconKey, relPath)``.
 *
 * When ``initialKey`` is provided the modal opens straight into stage 2 for that
 * key (used by the composer's right-click "Change View").
 */
export function ShotTwoStagePicker(props: {
  open: boolean;
  title: string;
  loadIcons: () => Promise<ShotPickerIcon[]>;
  loadSections: (key: string) => Promise<ShotPickerSection[]>;
  initialKey?: string | null;
  onPick: (key: string, relPath: string) => void;
  onCancel: () => void;
}) {
  const { open, title, loadIcons, loadSections, initialKey, onPick, onCancel } =
    props;

  const [icons, setIcons] = useState<ShotPickerIcon[]>([]);
  const [iconsError, setIconsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sections, setSections] = useState<ShotPickerSection[] | null>(null);
  const [sectionsError, setSectionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset / initialize whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setIcons([]);
    setIconsError(null);
    setSections(null);
    setSectionsError(null);
    setSelectedKey(initialKey ?? null);
    let cancelled = false;
    if (!initialKey) {
      setBusy(true);
      loadIcons()
        .then((data) => {
          if (!cancelled) setIcons(data);
        })
        .catch((e) => {
          if (!cancelled) setIconsError(String(e?.message || e));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, initialKey, loadIcons]);

  // Load gallery sections when a key is selected (stage 2).
  useEffect(() => {
    if (!open || !selectedKey) return;
    let cancelled = false;
    setBusy(true);
    setSections(null);
    setSectionsError(null);
    loadSections(selectedKey)
      .then((data) => {
        if (!cancelled) setSections(data);
      })
      .catch((e) => {
        if (!cancelled) setSectionsError(String(e?.message || e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedKey, loadSections]);

  if (!open) return null;

  const showBackButton = Boolean(selectedKey) && !initialKey;

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
          color: "white",
          borderRadius: 0,
          border: "1px solid rgba(255,255,255,0.25)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontWeight: 400,
            padding: "10px 12px",
            borderBottom: "1px solid rgba(255,255,255,0.15)",
          }}
        >
          {showBackButton ? (
            <SquareIconButton
              aria-label="Back"
              title="Back"
              icon={<TriangleIcon direction="left" />}
              onClick={() => setSelectedKey(null)}
            />
          ) : null}
          <span>{title}</span>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            padding: 12,
          }}
        >
          {!selectedKey ? (
            <>
              {iconsError ? (
                <div style={{ color: "#ff8080", fontSize: 13 }}>{iconsError}</div>
              ) : null}
              {busy && icons.length === 0 ? (
                <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>
              ) : null}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                  gap: 10,
                }}
              >
                {icons.map((ic) => (
                  <button
                    key={ic.key}
                    type="button"
                    onClick={() => setSelectedKey(ic.key)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      padding: 6,
                      borderRadius: 0,
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    <img
                      src={assetUrlFromRelPath(ic.coverRelPath)}
                      alt=""
                      style={{
                        width: "100%",
                        aspectRatio: "1 / 1",
                        objectFit: "contain",
                        display: "block",
                      }}
                    />
                    <span
                      style={{
                        fontSize: 12,
                        textAlign: "center",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {ic.label}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              {sectionsError ? (
                <div style={{ color: "#ff8080", fontSize: 13 }}>
                  {sectionsError}
                </div>
              ) : null}
              {busy && !sections ? (
                <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>
              ) : null}
              {(sections ?? []).map((sec) => (
                <CollapsibleGallerySection
                  key={sec.title}
                  title={sec.title}
                  images={sec.images}
                  onPick={(relPath) => onPick(selectedKey, relPath)}
                />
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            justifyContent: "flex-end",
            padding: 12,
            borderTop: "1px solid rgba(255,255,255,0.15)",
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="ui-btn-black"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
