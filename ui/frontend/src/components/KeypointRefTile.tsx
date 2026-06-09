"use client";

import React from "react";
import { assetUrlFromRelPath } from "../lib/api";

export function KeypointRefTile(props: {
  tile: number;
  src: string;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  onPrimary: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { tile, src, checked, disabled, onToggle, onPrimary, onContextMenu } = props;
  return (
    <div
      style={{
        width: tile,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      <div style={{ width: tile, height: tile, position: "relative" }}>
        <button
          type="button"
          disabled={disabled}
          onClick={onPrimary}
          onContextMenu={onContextMenu}
          className="gallery-cover-btn"
          style={{
            width: tile,
            height: tile,
            padding: 0,
            border: "1px solid rgba(0,0,0,0.5)",
            background: "rgba(0,0,0,0.2)",
            cursor: disabled ? "not-allowed" : "pointer",
            overflow: "hidden",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            className="gallery-cover-img"
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
            draggable={false}
          />
        </button>

        <label
          style={{
            position: "absolute",
            top: 4,
            left: 6,
            zIndex: 2,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            disabled={disabled}
            checked={checked}
            onChange={(e) => onToggle(e.target.checked, e)}
            style={{ margin: 0 }}
          />
        </label>
      </div>
    </div>
  );
}

export function KeypointVideoTile(props: {
  tile: number;
  count: number;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean, e: React.ChangeEvent<HTMLInputElement>) => void;
  onOpen: () => void;
}) {
  const { tile, count, checked, disabled, onToggle, onOpen } = props;
  return (
    <div style={{ width: tile, height: tile, position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        style={{
          width: tile,
          height: tile,
          padding: 8,
          border: "1px solid rgba(255,255,255,0.25)",
          background: "rgba(80,120,200,0.12)",
          color: "#eee",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          textAlign: "center",
          fontSize: 12,
          lineHeight: 1.2,
        }}
        title="Open video keypoint sequence editor"
      >
        <span
          style={{
            fontSize: 10,
            padding: "1px 4px",
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
          }}
        >
          Video
        </span>
        <span style={{ opacity: 0.85 }}>{count} frames</span>
      </button>
      <label
        style={{
          position: "absolute",
          top: 4,
          left: 6,
          zIndex: 2,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          disabled={disabled}
          checked={checked}
          onChange={(e) => onToggle(e.target.checked, e)}
          style={{ margin: 0 }}
        />
      </label>
    </div>
  );
}

export function KeypointFolderTile(props: {
  tile: number;
  name: string;
  count: number;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { tile, name, count, disabled, onOpen } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onOpen}
      style={{
        width: tile,
        height: tile,
        padding: 8,
        border: "1px solid rgba(255,255,255,0.25)",
        background: "rgba(255,255,255,0.06)",
        color: "#eee",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        textAlign: "center",
        fontSize: 12,
        lineHeight: 1.2,
      }}
      title={`Open folder: ${name}`}
    >
      <span
        style={{
          fontSize: 10,
          padding: "1px 4px",
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
        }}
      >
        Folder
      </span>
      <span style={{ fontWeight: 400, wordBreak: "break-word" }}>{name}</span>
      <span style={{ opacity: 0.65 }}>{count}</span>
    </button>
  );
}
