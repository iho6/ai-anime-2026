"use client";

import React, { useEffect, useRef, useState } from "react";

export function TrackLabelTag(props: {
  name: string;
  kind: "video" | "audio";
  width: number;
  hidden: boolean;
  onToggleHidden: () => void;
  onRename: (next: string) => void;
  onContextMenu?: (clientX: number, clientY: number) => void;
  onDragHandlePointerDown?: (e: React.PointerEvent) => void;
}) {
  const { name, kind, width, hidden, onToggleHidden, onRename, onContextMenu, onDragHandlePointerDown } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(name);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, name]);

  function commit() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== name) onRename(next);
  }

  return (
    <div
      style={{
        position: "sticky",
        left: 0,
        zIndex: 3,
        width,
        minWidth: width,
        boxSizing: "border-box",
        background: "#1b1b1b",
        borderRight: "1px solid rgba(255,255,255,0.15)",
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        color: "#eee",
        fontSize: 12,
        userSelect: "none",
      }}
      title="Double-click to rename"
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      {/* Drag handle */}
      <div
        onPointerDown={(e) => {
          e.stopPropagation();
          onDragHandlePointerDown?.(e);
        }}
        title="Drag to reorder track"
        style={{
          marginRight: 4,
          flex: "0 0 auto",
          cursor: "grab",
          color: "rgba(255,255,255,0.35)",
          fontSize: 12,
          lineHeight: 1,
          userSelect: "none",
          padding: "0 2px",
        }}
      >
        ⠿
      </div>

      <label
        title={
          kind === "audio"
            ? hidden ? "Unmute track" : "Mute track"
            : hidden ? "Show track" : "Hide track"
        }
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={{ marginRight: 6, flex: "0 0 auto", cursor: "pointer", display: "flex", alignItems: "center" }}
      >
        <input
          type="checkbox"
          checked={!hidden}
          onChange={(e) => { e.stopPropagation(); onToggleHidden(); }}
          style={{ margin: 0, cursor: "pointer" }}
        />
      </label>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: "#111",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.3)",
            font: "inherit",
            padding: "2px 4px",
          }}
        />
      ) : (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
      )}
    </div>
  );
}
