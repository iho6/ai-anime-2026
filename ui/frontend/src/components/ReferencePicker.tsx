"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  apiReferenceKeypoints,
  apiReferenceKeypointDelete,
  assetUrlFromRelPath,
  type PoseReference,
} from "../lib/api";
import { SquareButton } from "./SquareButton";

export function ReferencePicker(props: {
  open: boolean;
  charKey: string;
  busy: boolean;
  onCancel: () => void;
  onPickSaved: (ref: PoseReference) => void;
  onPickNew: (file: File) => void;
  onGenerateBase: (promptText: string) => void;
}) {
  if (!props.open) return null;
  return (
    <ReferencePickerOpen
      charKey={props.charKey}
      busy={props.busy}
      onCancel={props.onCancel}
      onPickSaved={props.onPickSaved}
      onPickNew={props.onPickNew}
      onGenerateBase={props.onGenerateBase}
    />
  );
}

function ReferencePickerOpen(props: {
  charKey: string;
  busy: boolean;
  onCancel: () => void;
  onPickSaved: (ref: PoseReference) => void;
  onPickNew: (file: File) => void;
  onGenerateBase: (promptText: string) => void;
}) {
  const { busy, onCancel, onPickSaved, onPickNew, onGenerateBase } = props;

  const [refs, setRefs] = useState<PoseReference[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [genPrompt, setGenPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const canGenerate = !busy && genPrompt.trim().length > 0;

  const loadRefs = useCallback(async () => {
    try {
      setRefs(await apiReferenceKeypoints());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadRefs();
  }, [loadRefs]);

  const handleDrop = useCallback(
    (ev: React.DragEvent) => {
      ev.preventDefault();
      setDragOver(false);
      const file = ev.dataTransfer?.files?.[0];
      if (file) onPickNew(file);
    },
    [onPickNew]
  );

  const handleFileInput = useCallback(
    (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (file) onPickNew(file);
    },
    [onPickNew]
  );

  const handleDeleteRef = useCallback(
    async (refId: string, ev: React.MouseEvent) => {
      ev.stopPropagation();
      try {
        await apiReferenceKeypointDelete(refId);
        setRefs((prev) => prev.filter((r) => r.id !== refId));
      } catch {
        /* ignore */
      }
    },
    []
  );

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
        style={{
          width: 480,
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
        <div style={{ fontWeight: 400, marginBottom: 10 }}>
          Add Reference Image
        </div>

        {/* Drag-drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <SquareButton
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            variant="import"
            tone="light"
            size={120}
            dragOver={dragOver}
            style={{ color: "inherit" }}
            title="Drop an image here or click to pick a file"
          >
            Drop image
            <br />
            or click
            <br />
            to pick
          </SquareButton>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,video/*"
            style={{ display: "none" }}
            onChange={handleFileInput}
          />
        </div>

        {/* AI generate a base reference (Flux2 text-to-image) */}
        <div style={{ marginBottom: 12 }}>
          <textarea
            value={genPrompt}
            disabled={busy}
            onChange={(e) => setGenPrompt(e.target.value)}
            placeholder="Describe a base reference image to generate"
            rows={2}
            style={{
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
              border: "1px solid rgba(255,255,255,0.2)",
              background: "transparent",
              color: "#eee",
              caretColor: "#eee",
              fontSize: 13,
              padding: 8,
              marginBottom: 8,
            }}
          />
          <button
            type="button"
            disabled={!canGenerate}
            onClick={() => {
              const p = genPrompt.trim();
              if (p) onGenerateBase(p);
            }}
            style={{
              width: "100%",
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "8px 12px",
              cursor: canGenerate ? "pointer" : "not-allowed",
              opacity: canGenerate ? 1 : 0.5,
            }}
            title="Generate a base reference image with AI, then convert it to a keypoint pose"
          >
            AI Generate Base Reference
          </button>
        </div>

        {/* Saved poses list */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            minHeight: 0,
          }}
        >
          {refs.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "24px 0",
                opacity: 0.5,
                fontSize: 14,
              }}
            >
              No Saved Poses
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
              }}
            >
              {refs.map((r) => (
                <div
                  key={r.id}
                  style={{
                    position: "relative",
                    width: 80,
                    height: 80,
                    cursor: "pointer",
                    border: "1px solid rgba(255,255,255,0.15)",
                    overflow: "hidden",
                  }}
                  onClick={() => onPickSaved(r)}
                  title="Click to use this saved reference"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={assetUrlFromRelPath(r.keypointRelPath)}
                    alt=""
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                    draggable={false}
                  />
                  <button
                    type="button"
                    onClick={(e) => handleDeleteRef(r.id, e)}
                    style={{
                      position: "absolute",
                      top: 2,
                      right: 2,
                      width: 18,
                      height: 18,
                      fontSize: 12,
                      lineHeight: 1,
                      padding: 0,
                      border: "1px solid rgba(255,255,255,0.3)",
                      borderRadius: 0,
                      background: "rgba(0,0,0,0.6)",
                      color: "#eee",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    title="Delete saved reference"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cancel */}
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "6px 16px",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
