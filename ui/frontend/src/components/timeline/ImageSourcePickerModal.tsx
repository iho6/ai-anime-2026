"use client";

import React, { useEffect, useState } from "react";
import { assetUrlFromRelPath } from "../../lib/api";

export type PickerItem = { key: string; coverRelPath: string };

/**
 * Generic cover-grid picker. Loads items lazily when opened and returns the
 * chosen item's ``coverRelPath`` (the image to import as a clip).
 */
export function ImageSourcePickerModal(props: {
  open: boolean;
  title: string;
  load: () => Promise<PickerItem[]>;
  onCancel: () => void;
  onPick: (item: PickerItem) => void;
}) {
  const { open, title, load, onCancel, onPick } = props;
  const [items, setItems] = useState<PickerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setErr(null);
    load()
      .then((r) => setItems(r))
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>{title}</div>
        {loading ? (
          <div style={{ color: "#aaa" }}>Loading…</div>
        ) : err ? (
          <div style={{ color: "#ff8080" }}>{err}</div>
        ) : items.length === 0 ? (
          <div style={{ color: "#aaa" }}>Nothing available yet.</div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, 110px)",
              gap: 8,
              maxHeight: 360,
              overflowY: "auto",
            }}
          >
            {items.map((it) => (
              <button
                key={it.key}
                onClick={() => onPick(it)}
                title={it.key}
                style={tileBtn}
              >
                {it.coverRelPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={assetUrlFromRelPath(it.coverRelPath)}
                    alt=""
                    style={{ width: "100%", height: 80, objectFit: "contain" }}
                  />
                ) : (
                  <div style={{ height: 80 }} />
                )}
                <div style={tileLabel}>{it.key}</div>
              </button>
            ))}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={onCancel} style={btn}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const panel: React.CSSProperties = {
  width: 560,
  maxWidth: "92vw",
  background: "#111",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.2)",
  padding: 16,
  font: "inherit",
};
const tileBtn: React.CSSProperties = {
  width: 110,
  background: "#1b1b1b",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#ddd",
  cursor: "pointer",
  padding: 4,
};
const tileLabel: React.CSSProperties = {
  fontSize: 10,
  marginTop: 4,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const btn: React.CSSProperties = {
  background: "transparent",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.35)",
  padding: "6px 14px",
  cursor: "pointer",
  font: "inherit",
};
