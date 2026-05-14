"use client";

import React, { useMemo, useRef, useState } from "react";
import type { AngleGroup } from "../lib/api";
import { SquareButton } from "./SquareButton";

/**
 * Checkbox picker for multi-angle generation (parity with PyQt AngleSubsetDialog).
 */
export function AngleSubsetModal(props: {
  open: boolean;
  title?: string;
  groups: AngleGroup[];
  onCancel: () => void;
  onConfirm: (angleIds: number[], manualFiles: File[]) => void;
}) {
  if (!props.open) return null;
  return (
    <AngleSubsetModalOpen
      title={props.title}
      groups={props.groups}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}

function AngleSubsetModalOpen(props: {
  title?: string;
  groups: AngleGroup[];
  onCancel: () => void;
  onConfirm: (angleIds: number[], manualFiles: File[]) => void;
}) {
  const { groups, onCancel, onConfirm } = props;
  const title =
    props.title ?? "Generate New Angle or Manually Add Angle Images From File.";

  const allIds = useMemo(
    () => Array.from(new Set(groups.flatMap((g) => g.angleIds))).sort((a, b) => a - b),
    [groups]
  );

  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [anchorAngleId, setAnchorAngleId] = useState<number | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function onAngleCheckboxChange(
    id: number,
    targetChecked: boolean,
    ev: React.ChangeEvent<HTMLInputElement>
  ) {
    const isShift = (ev.nativeEvent as MouseEvent).shiftKey;
    if (isShift && !targetChecked) {
      setPicked(new Set());
      return;
    }

    const anchor = anchorAngleId;
    if (isShift && anchor != null) {
      const a = allIds.indexOf(anchor);
      const b = allIds.indexOf(id);
      if (a !== -1 && b !== -1) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const range = allIds.slice(lo, hi + 1);
        setPicked((prev) => {
          const n = new Set(prev);
          for (const rid of range) {
            if (targetChecked) n.add(rid);
            else n.delete(rid);
          }
          return n;
        });
        setAnchorAngleId(id);
        return;
      }
    }
    setPicked((prev) => {
      const n = new Set(prev);
      if (targetChecked) n.add(id);
      else n.delete(id);
      return n;
    });
    setAnchorAngleId(id);
  }

  function toggleGroup(ids: number[], on: boolean) {
    setPicked((prev) => {
      const n = new Set(prev);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  }

  function normalizeToken(s: string): string {
    return s.trim().toLowerCase();
  }

  function compactAngleLabel(fullLabel: string, groupTitle: string, fallbackId: number): string {
    const fullParts = fullLabel
      .split("·")
      .map((p) => p.trim())
      .filter(Boolean);
    const groupParts = new Set(
      groupTitle
        .split("·")
        .map((p) => normalizeToken(p))
        .filter(Boolean)
    );
    const filtered = fullParts.filter((p) => !groupParts.has(normalizeToken(p)));
    if (filtered.length > 0) return filtered.join(" · ");
    if (fullParts.length > 0) return fullParts.join(" · ");
    return `Angle ${fallbackId}`;
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
        <div style={{ fontWeight: 400, marginBottom: 10 }}>{title}</div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
          <SquareButton
            onClick={() => inputRef.current?.click()}
            variant="import"
            tone="light"
            size={120}
            style={{
              color: "inherit",
            }}
            title="Manually add one or more angle images from files"
          >
            Add angle(s)
            <br />
            from file(s)
          </SquareButton>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          {files.length ? (
            <span style={{ fontSize: 14 }}>
              {files.length} file{files.length === 1 ? "" : "s"}:{" "}
              {files.map((f) => f.name).join(", ")}
            </span>
          ) : null}
        </div>

        <div style={{ marginTop: 8, marginBottom: 8, maxHeight: "50vh", overflow: "auto" }}>
          {groups.map((g) => {
            const ids = g.angleIds;
            const labelById = new Map((g.angles ?? []).map((a) => [a.id, a.label]));
            const allOn = ids.length > 0 && ids.every((id) => picked.has(id));
            return (
              <div key={g.title} style={{ marginBottom: 12 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, marginLeft: 4 }}>
                  <input
                    type="checkbox"
                    checked={allOn}
                    onChange={() => toggleGroup(ids, !allOn)}
                  />
                  <span style={{ fontSize: 14, opacity: 0.95 }}>{g.title}</span>
                </label>
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.15)",
                    padding: 8,
                  }}
                >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  {ids.map((id) => (
                    <label
                      key={id}
                      style={{
                        display: "flex",
                        gap: 4,
                        alignItems: "center",
                        fontSize: 14,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={picked.has(id)}
                        onChange={(ev) =>
                          onAngleCheckboxChange(id, ev.target.checked, ev)
                        }
                      />
                      {compactAngleLabel(labelById.get(id) ?? `Angle ${id}`, g.title, id)}
                    </label>
                  ))}
                </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            type="button"
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.35)",
              background: "transparent",
              color: "#eee",
              padding: "6px 14px",
              cursor: "pointer",
            }}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.35)",
              background: "rgba(80,120,200,0.35)",
              color: "#eee",
              padding: "6px 14px",
              cursor: "pointer",
            }}
            onClick={() => {
              const ids = allIds.filter((id) => picked.has(id));
              onConfirm(ids, files);
            }}
          >
            {files.length ? `Add ${files.length} image(s)` : "Generate"}
          </button>
        </div>
      </div>
    </div>
  );
}
