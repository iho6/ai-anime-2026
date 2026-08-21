"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  assetUrlFromRelPath,
  type GeneratedReferencePreview,
  type ReferenceMediaKind,
} from "../lib/api";
import { ZoomableImage } from "./ZoomableImage";
import {
  WAN_VIDEO_DURATION_STEP_SEC,
  WAN_VIDEO_FPS,
  WAN_VIDEO_MAX_DURATION_SEC,
  WAN_VIDEO_MIN_DURATION_SEC,
  WAN_VIDEO_OUTPUT_LENGTHS,
  sequenceVideoLengthIndex,
  wanVideoDurationSec,
} from "./sequenceOutputLength";

const REF_VIDEO_DEFAULT_LENGTH = 49;

type AspectId = "16:9" | "9:16" | "1:1";

/** Image gen sizes (long edge ~1280). */
const IMAGE_ASPECT_SIZES: Record<AspectId, { width: number; height: number }> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1024, height: 1024 },
};

/** Wan T2V sizes (long edge 640, multiples of 16). */
const VIDEO_ASPECT_SIZES: Record<AspectId, { width: number; height: number }> = {
  "16:9": { width: 640, height: 368 },
  "9:16": { width: 368, height: 640 },
  "1:1": { width: 640, height: 640 },
};

type GridCell =
  | { kind: "media"; id: ReferenceMediaKind; label: string }
  | { kind: "aspect"; id: AspectId; label: string };

function snapFramesFromDurationSec(sec: number): number {
  const targetFrames = sec * WAN_VIDEO_FPS;
  const idx = sequenceVideoLengthIndex(targetFrames, WAN_VIDEO_OUTPUT_LENGTHS);
  return WAN_VIDEO_OUTPUT_LENGTHS[idx]!;
}

/** Exact Wan duration string so ``type=number`` step (0.25s) stays on-grid. */
function formatDurationInput(frames: number): string {
  const sec = wanVideoDurationSec(frames, WAN_VIDEO_FPS);
  return String(Number(sec.toFixed(4)));
}

function gridCellStyle(opts: {
  selected: boolean;
  first: boolean;
  interactive: boolean;
}): React.CSSProperties {
  const { selected, first, interactive } = opts;
  return {
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: selected ? "rgba(255, 255, 255, 0.85)" : "rgba(255, 255, 255, 0.35)",
    borderLeftWidth: first ? 1 : 0,
    background: selected ? "rgba(255, 255, 255, 0.2)" : "transparent",
    boxShadow: selected ? "inset 0 0 0 1px rgba(255, 255, 255, 0.35)" : "none",
    color: selected ? "#eee" : "#bbb",
    padding: "3px 8px",
    font: "inherit",
    fontSize: 11,
    lineHeight: 1.2,
    cursor: interactive ? "pointer" : "default",
    margin: 0,
  };
}

export type ReferenceGeneratePanelProps = {
  busy?: boolean;
  saveLabel?: string | ((preview: GeneratedReferencePreview) => string);
  /** Hide Cancel when embedded in a tabbed host that already has Cancel. */
  hideCancel?: boolean;
  /** Hide Save when host auto-commits on generate (2D Ref Gen tab). */
  hideSave?: boolean;
  onCancel?: () => void;
  /** Controlled preview (persists across tab switches when owned by parent). */
  preview?: GeneratedReferencePreview | null;
  onPreviewChange?: (preview: GeneratedReferencePreview | null) => void;
  onGenerate: (args: {
    kind: ReferenceMediaKind;
    promptText: string;
    width: number;
    height: number;
    length?: number;
  }) => Promise<GeneratedReferencePreview | null>;
  onCommit?: (preview: GeneratedReferencePreview) => Promise<void>;
};

/** Inline generate + preview controls (no overlay). Used by modal wrapper and 2D Ref Gen tab. */
export function ReferenceGeneratePanel(props: ReferenceGeneratePanelProps) {
  const {
    busy = false,
    saveLabel = "Save to Gallery",
    hideCancel = false,
    hideSave = false,
    onCancel,
    preview: previewProp,
    onPreviewChange,
    onGenerate,
    onCommit,
  } = props;

  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState<AspectId>("1:1");
  const [videoLength, setVideoLength] = useState(REF_VIDEO_DEFAULT_LENGTH);
  const [durationDraft, setDurationDraft] = useState(() =>
    formatDurationInput(REF_VIDEO_DEFAULT_LENGTH)
  );
  const [mediaKind, setMediaKind] = useState<ReferenceMediaKind>("image");
  const [previewLocal, setPreviewLocal] = useState<GeneratedReferencePreview | null>(null);
  const [previewHeight, setPreviewHeight] = useState(220);
  const previewBoxRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const durationInputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);
  const videoLengthRef = useRef(videoLength);
  videoLengthRef.current = videoLength;

  const controlled = onPreviewChange != null;
  const preview = controlled ? (previewProp ?? null) : previewLocal;
  const setPreview = (next: GeneratedReferencePreview | null) => {
    if (controlled) onPreviewChange?.(next);
    else setPreviewLocal(next);
  };

  useEffect(() => {
    const el = previewBoxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (!h) return;
      const next = Math.round(Math.min(480, Math.max(120, h)));
      setPreviewHeight((prev) => (Math.abs(prev - next) > 2 ? next : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    const maxH = 180;
    el.style.height = "auto";
    const next = Math.min(maxH, Math.max(72, el.scrollHeight));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, [prompt]);

  useEffect(() => {
    const el = durationInputRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      if (el.disabled) return;
      if (document.activeElement !== el) return;
      ev.preventDefault();
      const i = sequenceVideoLengthIndex(videoLengthRef.current, WAN_VIDEO_OUTPUT_LENGTHS);
      const delta = ev.deltaY < 0 ? 1 : -1;
      const next = WAN_VIDEO_OUTPUT_LENGTHS[
        Math.max(0, Math.min(WAN_VIDEO_OUTPUT_LENGTHS.length - 1, i + delta))
      ]!;
      setVideoLength(next);
      setDurationDraft(formatDurationInput(next));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mediaKind]);

  const canGenerate = !busy && prompt.trim().length > 0;
  const canSave = !busy && preview !== null && !!onCommit;
  const resolvedSaveLabel = preview
    ? typeof saveLabel === "function"
      ? saveLabel(preview)
      : saveLabel
    : typeof saveLabel === "string"
      ? saveLabel
      : "Save to Gallery";

  const size =
    mediaKind === "video" ? VIDEO_ASPECT_SIZES[aspect] : IMAGE_ASPECT_SIZES[aspect];

  const gridCells: GridCell[] = [
    { kind: "media", id: "image", label: "Image" },
    { kind: "media", id: "video", label: "Video" },
    { kind: "aspect", id: "16:9", label: "16:9" },
    { kind: "aspect", id: "9:16", label: "9:16" },
    { kind: "aspect", id: "1:1", label: "1:1" },
  ];

  const commitDurationDraft = () => {
    const parsed = Number.parseFloat(durationDraft.replace(/,/g, "").replace(/s$/i, "").trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDurationDraft(formatDurationInput(videoLength));
      return;
    }
    const frames = snapFramesFromDurationSec(parsed);
    setVideoLength(frames);
    setDurationDraft(formatDurationInput(frames));
  };

  /** Live-apply only when the value is already on a Wan duration step (spinner / wheel). */
  const onDurationInputChange = (raw: string) => {
    setDurationDraft(raw);
    if (raw === "" || raw.endsWith(".") || raw.endsWith("-")) return;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return;
    const frames = snapFramesFromDurationSec(n);
    const snapped = wanVideoDurationSec(frames, WAN_VIDEO_FPS);
    if (Math.abs(snapped - n) > 1e-4) return;
    setVideoLength(frames);
    setDurationDraft(formatDurationInput(frames));
  };

  const stepDurationByIndex = (delta: number) => {
    const i = sequenceVideoLengthIndex(videoLength, WAN_VIDEO_OUTPUT_LENGTHS);
    const next = WAN_VIDEO_OUTPUT_LENGTHS[
      Math.max(0, Math.min(WAN_VIDEO_OUTPUT_LENGTHS.length - 1, i + delta))
    ]!;
    setVideoLength(next);
    setDurationDraft(formatDurationInput(next));
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        flex: 1,
        overflow: "hidden",
      }}
    >
      <div
        ref={previewBoxRef}
        style={{
          height: previewHeight,
          minHeight: 120,
          maxHeight: 480,
          width: "100%",
          overflow: "auto",
          resize: "vertical",
          padding: 8,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {preview?.kind === "image" ? (
          <ZoomableImage
            src={assetUrlFromRelPath(preview.previewRelPath)}
            fitMaxWidth="100%"
            fitMaxHeight="100%"
          />
        ) : preview?.kind === "video" ? (
          <video
            src={assetUrlFromRelPath(preview.previewRelPath)}
            controls
            loop
            muted
            playsInline
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        ) : (
          <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>
            Generate a reference {mediaKind} to preview it here.
          </div>
        )}
      </div>

      <div
        role="toolbar"
        aria-label="Reference generate options"
        style={{
          flexShrink: 0,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "stretch",
          gap: 0,
          padding: 0,
          margin: 0,
        }}
      >
        {gridCells.map((cell, index) => {
          const first = index === 0;
          const selected =
            cell.kind === "media" ? mediaKind === cell.id : aspect === cell.id;
          return (
            <button
              key={`${cell.kind}-${cell.id}`}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy}
              onClick={() => {
                if (cell.kind === "media") {
                  requestIdRef.current += 1;
                  setMediaKind(cell.id);
                } else {
                  setAspect(cell.id);
                }
              }}
              style={gridCellStyle({ selected, first, interactive: true })}
            >
              {cell.label}
            </button>
          );
        })}
        {mediaKind === "video" ? (
          <label
            title={`Duration in seconds — scroll or arrow keys step by ${WAN_VIDEO_DURATION_STEP_SEC}s (Wan 4-frame @ ${WAN_VIDEO_FPS} FPS)`}
            style={{
              ...gridCellStyle({ selected: false, first: false, interactive: false }),
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 6px",
            }}
          >
            <input
              ref={durationInputRef}
              type="number"
              min={WAN_VIDEO_MIN_DURATION_SEC}
              max={WAN_VIDEO_MAX_DURATION_SEC}
              step={WAN_VIDEO_DURATION_STEP_SEC}
              disabled={busy}
              value={durationDraft}
              aria-label="Video duration seconds"
              onChange={(e) => onDurationInputChange(e.target.value)}
              onBlur={commitDurationDraft}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  stepDurationByIndex(1);
                  return;
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  stepDurationByIndex(-1);
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDurationDraft();
                  (e.target as HTMLInputElement).blur();
                }
              }}
              style={{
                width: 52,
                border: "none",
                outline: "none",
                background: "transparent",
                color: "#eee",
                font: "inherit",
                fontSize: 11,
                padding: 0,
                textAlign: "right",
                /* Hide spinners in the compact chip; wheel / arrow keys still step. */
                MozAppearance: "textfield",
              }}
            />
            <span style={{ color: "#888", fontSize: 11 }}>s</span>
          </label>
        ) : null}
      </div>

      <div style={{ flexShrink: 0, padding: 0 }}>
        <div style={{ position: "relative" }}>
          <textarea
            ref={promptRef}
            value={prompt}
            disabled={busy}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={`Describe the reference ${mediaKind} to generate`}
            rows={3}
            style={{
              width: "100%",
              boxSizing: "border-box",
              resize: "none",
              overflowY: "hidden",
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "rgba(255,255,255,0.2)",
              background: "transparent",
              color: "#ffffff",
              caretColor: "#ffffff",
              fontSize: 13,
              padding: "8px 72px 28px 8px",
              minHeight: 72,
              maxHeight: 180,
              margin: 0,
              display: "block",
            }}
          />
          <button
            type="button"
            disabled={!canGenerate}
            title="Generate"
            onClick={(e) => {
              e.preventDefault();
              void (async () => {
                const requestId = ++requestIdRef.current;
                const kind = mediaKind;
                const result = await onGenerate({
                  kind,
                  promptText: prompt.trim(),
                  width: size.width,
                  height: size.height,
                  ...(kind === "video" ? { length: videoLength } : {}),
                });
                if (result && result.kind === kind && requestIdRef.current === requestId) {
                  setPreview(result);
                }
              })();
            }}
            style={{
              position: "absolute",
              right: 0,
              bottom: 0,
              zIndex: 1,
              borderRadius: 0,
              borderWidth: 1,
              borderStyle: "solid",
              borderColor: "rgba(255,255,255,0.85)",
              background: canGenerate ? "rgba(255, 255, 255, 0.22)" : "rgba(255,255,255,0.08)",
              boxShadow: canGenerate ? "inset 0 0 0 1px rgba(255,255,255,0.35)" : "none",
              color: "#fff",
              padding: "5px 12px",
              font: "inherit",
              fontSize: 12,
              cursor: canGenerate ? "pointer" : "not-allowed",
              opacity: canGenerate ? 1 : 0.55,
            }}
          >
            Generate
          </button>
        </div>

        {(!hideSave && onCommit) || (!hideCancel && onCancel) ? (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "8px 10px",
            }}
          >
            {!hideSave && onCommit ? (
              <button
                type="button"
                disabled={!canSave}
                className="ui-btn-black"
                style={{
                  cursor: canSave ? "pointer" : "not-allowed",
                  opacity: canSave ? 1 : 0.6,
                }}
                onClick={(e) => {
                  e.preventDefault();
                  void (async () => {
                    if (!preview || !onCommit) return;
                    await onCommit(preview);
                    setPreview(null);
                  })();
                }}
              >
                {resolvedSaveLabel}
              </button>
            ) : null}
            {!hideCancel && onCancel ? (
              <button
                type="button"
                className="ui-btn-black"
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  onCancel();
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
