"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * Sticky track label pinned to the left edge of the horizontally-scrolling
 * timeline so it stays visible while scrolling right. Double-click to rename.
 */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
      {off ? <line x1="3" y1="3" x2="21" y2="21" /> : null}
    </svg>
  );
}

function EarIcon({ off }: { off: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8.5a6 6 0 0 1 12 0c0 3-2.2 4.2-3.5 5.2S11.5 15.5 11 18a3 3 0 0 1-5.7 1" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 .2c0 1.6-1.7 2.1-2 3.3" />
      {off ? <line x1="3" y1="3" x2="21" y2="21" /> : null}
    </svg>
  );
}

export function TrackLabelTag(props: {
  name: string;
  kind: "video" | "audio";
  width: number;
  hidden: boolean;
  onToggleHidden: () => void;
  onRename: (next: string) => void;
  onContextMenu?: (clientX: number, clientY: number) => void;
}) {
  const { name, kind, width, hidden, onToggleHidden, onRename, onContextMenu } = props;
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
      <button
        type="button"
        title={
          kind === "audio"
            ? hidden
              ? "Unmute track in playback"
              : "Mute track in playback"
            : hidden
            ? "Show track in playback"
            : "Hide track from playback"
        }
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggleHidden();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginRight: 6,
          flex: "0 0 auto",
          padding: 0,
          width: 18,
          height: 18,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          color: hidden ? "#888" : kind === "audio" ? "#7bd88f" : "#5aa9ff",
        }}
      >
        {kind === "audio" ? <EarIcon off={hidden} /> : <EyeIcon off={hidden} />}
      </button>
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
