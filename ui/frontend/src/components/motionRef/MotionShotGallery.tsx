"use client";

import React, { useState } from "react";
import { assetUrlFromRelPath, MotionRefShot } from "../../lib/api";
import { DesktopContextMenu, ContextMenuItem } from "../DesktopContextMenu";

/**
 * Grid of rendered motion shots.  Each thumbnail shows the skeleton frame
 * from the camera angle it was saved at.  Users can select shots for batch
 * "Make Keypoints" (feeds into the existing pose-keypoint pipeline).
 */
export function MotionShotGallery(props: {
  shots: MotionRefShot[];
  onDelete: (shotIndex: number) => void;
  onMakeKeypoints: (shots: MotionRefShot[]) => void;
  busy?: boolean;
}) {
  const { shots, onDelete, onMakeKeypoints, busy = false } = props;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    shotIndex: number;
  }>({ open: false, x: 0, y: 0, shotIndex: -1 });

  function toggleSelect(idx: number, additive: boolean) {
    setSelected((prev) => {
      const next = new Set(additive ? prev : new Set<number>());
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  const menuItems: ContextMenuItem[] = [
    {
      key: "keypoints",
      label: "Make Keypoints",
      disabled: busy,
      onSelect: () => {
        const shot = shots.find((s) => s.shotIndex === menu.shotIndex);
        if (shot) onMakeKeypoints([shot]);
      },
    },
    {
      key: "delete",
      label: "Delete",
      onSelect: () => onDelete(menu.shotIndex),
    },
  ];

  const selectedShots = shots.filter((s) => selected.has(s.shotIndex));

  if (shots.length === 0) {
    return (
      <div
        style={{
          color: "#666",
          fontSize: 12,
          padding: "10px 0",
          textAlign: "center",
        }}
      >
        No shots saved yet. Scrub to a frame, orbit the camera, then click "Save Shot".
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        {shots.map((shot) => {
          const isSel = selected.has(shot.shotIndex);
          return (
            <div
              key={shot.shotIndex}
              onClick={(e) => toggleSelect(shot.shotIndex, e.shiftKey || e.ctrlKey || e.metaKey)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ open: true, x: e.clientX, y: e.clientY, shotIndex: shot.shotIndex });
              }}
              title={`Frame ${shot.frameIndex} · Az ${shot.azimuth.toFixed(0)}° El ${shot.elevation.toFixed(0)}°`}
              style={{
                width: 88,
                cursor: "pointer",
                border: isSel ? "2px solid #ffd166" : "1px solid rgba(255,255,255,0.2)",
                padding: 2,
                background: "#111",
                userSelect: "none",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={assetUrlFromRelPath(shot.relPath)}
                alt={`Shot ${shot.shotIndex}`}
                style={{ width: "100%", height: 80, objectFit: "contain", display: "block" }}
              />
              <div
                style={{ fontSize: 9, color: "#888", textAlign: "center", paddingTop: 2 }}
              >
                f{shot.frameIndex}
              </div>
            </div>
          );
        })}
      </div>

      {selectedShots.length > 0 ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "#aaa" }}>
            {selectedShots.length} shot{selectedShots.length > 1 ? "s" : ""} selected
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onMakeKeypoints(selectedShots)}
            style={actionBtn}
          >
            Make Keypoints
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            style={{ ...actionBtn, color: "#888" }}
          >
            Clear
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "#555" }}>
          Click a shot to select · Shift/Ctrl-click for multiple · Right-click for options
        </div>
      )}

      <DesktopContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menuItems}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />
    </div>
  );
}

const actionBtn: React.CSSProperties = {
  background: "transparent",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.35)",
  padding: "5px 12px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 12,
};
