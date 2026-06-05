"use client";

import React, { useEffect, useRef, useState } from "react";
import { cameraStateLabel, cameraStateToAngleId } from "../lib/cameraAngle";
import type { CameraState, CameraWidget } from "./cameraWidget/CameraWidget";

/**
 * Single-angle picker using the Three.js camera gizmo (replaces the AngleSubsetModal
 * checkbox grid on all single-angle surfaces). Drag the azimuth ring / elevation arc /
 * distance handle to orbit a virtual camera; Generate emits the bucketed angle id (0-95).
 *
 * The heavy `three` bundle is loaded lazily (dynamic import) only when the modal opens.
 */
export function CameraAngleModal(props: {
  open: boolean;
  title?: string;
  imageUrl?: string | null;
  onCancel: () => void;
  onConfirm: (angleId: number) => void;
}) {
  if (!props.open) return null;
  return (
    <CameraAngleModalOpen
      title={props.title}
      imageUrl={props.imageUrl ?? null}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}

function CameraAngleModalOpen(props: {
  title?: string;
  imageUrl: string | null;
  onCancel: () => void;
  onConfirm: (angleId: number) => void;
}) {
  const { imageUrl, onCancel, onConfirm } = props;
  const title = props.title ?? "Choose a camera angle";

  const mountRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<CameraWidget | null>(null);
  const [state, setState] = useState<CameraState>({
    azimuth: 0,
    elevation: 0,
    distance: 5,
    imageUrl,
  });
  const [cameraView, setCameraView] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    let widget: CameraWidget | null = null;

    (async () => {
      const mod = await import("./cameraWidget/CameraWidget");
      if (disposed || !mountRef.current) return;
      widget = new mod.CameraWidget({
        container: mountRef.current,
        initialState: { azimuth: 0, elevation: 0, distance: 5, imageUrl },
        onStateChange: (s) => setState(s),
      });
      widgetRef.current = widget;
      setState(widget.getState());
      setLoading(false);
    })();

    return () => {
      disposed = true;
      try {
        widget?.dispose();
      } catch {
        /* noop */
      }
      widgetRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleCameraView() {
    const next = !cameraView;
    setCameraView(next);
    widgetRef.current?.setCameraView(next);
  }

  function reset() {
    widgetRef.current?.resetToDefaults();
  }

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
        e.preventDefault();
        onCancel();
      }}
    >
      <div
        className="angle-modal"
        style={{
          width: 560,
          maxWidth: "100%",
          maxHeight: "92vh",
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
        <div style={{ fontWeight: 400, marginBottom: 10 }}>{title}</div>

        <div
          ref={mountRef}
          style={{
            position: "relative",
            width: "100%",
            height: 380,
            background: "#0a0a0f",
            border: "1px solid rgba(255,255,255,0.15)",
            overflow: "hidden",
            cursor: "default",
            userSelect: "none",
            touchAction: "none",
          }}
        >
          {loading ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                opacity: 0.7,
              }}
            >
              Loading camera…
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 10,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 13, opacity: 0.9 }}>
            {cameraStateLabel(state)}{" "}
            <span style={{ opacity: 0.5 }}>(angle #{cameraStateToAngleId(state)})</span>
          </span>
          <span style={{ flex: 1 }} />
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={cameraView} onChange={toggleCameraView} />
            Camera view
          </label>
          <button
            type="button"
            style={ghostBtn}
            onClick={reset}
          >
            Reset
          </button>
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" style={ghostBtn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            style={{
              ...ghostBtn,
              background: "rgba(80,120,200,0.35)",
            }}
            onClick={() => onConfirm(cameraStateToAngleId(state))}
          >
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  borderRadius: 0,
  border: "1px solid rgba(255,255,255,0.35)",
  background: "transparent",
  color: "#eee",
  padding: "6px 14px",
  cursor: "pointer",
};
