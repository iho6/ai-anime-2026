"use client";

import React from "react";
import { assetUrlFromRelPath } from "../lib/api";
import {
  keypointRefFramePaths,
  keypointRefPreviewFps,
  keypointRefThumbPreview,
  type KeypointRefEntry,
} from "../lib/keypointRefGeneration";
import { PoseRefFramePreview } from "./PoseRefFramePreview";
import { SquareButton } from "./SquareButton";

type Props = {
  keypointRef: KeypointRefEntry | null;
  size?: number | string;
  tone?: "light" | "dark";
  disabled?: boolean;
  onOpenPicker: () => void;
  onClear?: () => void;
  emptyLabel?: React.ReactNode;
  title?: string;
};

export function KeypointReferenceSlot(props: Props) {
  const {
    keypointRef,
    size = 100,
    tone = "light",
    disabled = false,
    onOpenPicker,
    onClear,
    emptyLabel,
    title = "Add a pose reference (optional)",
  } = props;

  if (!keypointRef) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SquareButton
          variant="import"
          tone={tone}
          size={size}
          disabled={disabled}
          onClick={onOpenPicker}
          style={{ color: "inherit" }}
          title={title}
        >
          {emptyLabel ?? (
            <>
              Add
              <br />
              Reference
              <br />
              (optional)
            </>
          )}
        </SquareButton>
      </div>
    );
  }

  const framePaths = keypointRefFramePaths(keypointRef);
  const isMultiFrame = keypointRef.kind === "video" || keypointRef.kind === "folder";
  const thumb = keypointRefThumbPreview(keypointRef);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        title={title}
        onClick={disabled ? undefined : onOpenPicker}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenPicker();
          }
        }}
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          border: "1px solid rgba(0,0,0,0.35)",
          overflow: "hidden",
          position: "relative",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          background: tone === "light" ? "#f3f3f3" : "rgba(255,255,255,0.06)",
        }}
      >
        {keypointRef.kind === "video" ? (
          <span
            style={{
              position: "absolute",
              top: 4,
              left: 4,
              zIndex: 3,
              fontSize: 10,
              padding: "1px 4px",
              background: "rgba(0,0,0,0.65)",
              color: "#fff",
              pointerEvents: "none",
            }}
          >
            Video
          </span>
        ) : keypointRef.kind === "folder" ? (
          <span
            style={{
              position: "absolute",
              top: 4,
              left: 4,
              zIndex: 3,
              fontSize: 10,
              padding: "1px 4px",
              background: "rgba(0,0,0,0.65)",
              color: "#fff",
              pointerEvents: "none",
            }}
          >
            Folder
          </span>
        ) : null}
        {isMultiFrame && framePaths.length > 0 ? (
          <PoseRefFramePreview
            frameRelPaths={framePaths}
            fps={keypointRefPreviewFps(keypointRef)}
            maxWidth="100%"
            maxHeight="100%"
          />
        ) : keypointRef.kind === "single" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={assetUrlFromRelPath(
              keypointRef.ref.keypointRelPath || keypointRef.ref.referenceRelPath
            )}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
            draggable={false}
          />
        ) : thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={assetUrlFromRelPath(thumb)}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
            draggable={false}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              opacity: 0.6,
            }}
          >
            No preview
          </div>
        )}
      </div>
      {onClear ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onClear}
          style={{
            background: "transparent",
            border: "none",
            color: "#888",
            cursor: disabled ? "not-allowed" : "pointer",
            fontSize: 11,
            textAlign: "center",
          }}
        >
          Clear ref
        </button>
      ) : null}
    </div>
  );
}
