"use client";

import React, { useEffect, useState } from "react";
import {
  apiHubCharacters,
  apiSequenceFolderNames,
  apiSequenceGet,
  assetUrlFromRelPath,
  HubCharacter,
  SequenceGalleryItem,
} from "../../lib/api";

export type SequenceVideoChoice = {
  charKey: string;
  sequenceName: string;
  /** When omitted, the whole sequence timeline is materialized. */
  galleryItemId?: string;
  label: string;
};

/**
 * Three-step picker: character → sequence → (whole sequence | a generated video
 * gallery item). Resolves the choice the timeline editor materializes to mp4.
 */
export function SequenceVideoPicker(props: {
  open: boolean;
  onCancel: () => void;
  onPick: (choice: SequenceVideoChoice) => void;
}) {
  const { open, onCancel, onPick } = props;

  const [chars, setChars] = useState<HubCharacter[]>([]);
  const [charKey, setCharKey] = useState<string | null>(null);
  const [seqNames, setSeqNames] = useState<string[]>([]);
  const [seqName, setSeqName] = useState<string | null>(null);
  const [gallery, setGallery] = useState<SequenceGalleryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCharKey(null);
    setSeqName(null);
    setSeqNames([]);
    setGallery([]);
    setErr(null);
    setBusy(true);
    apiHubCharacters()
      .then((r) => setChars(r))
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setBusy(false));
  }, [open]);

  async function pickCharacter(key: string) {
    setCharKey(key);
    setSeqName(null);
    setGallery([]);
    setBusy(true);
    setErr(null);
    try {
      setSeqNames(await apiSequenceFolderNames(key));
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function pickSequence(name: string) {
    if (!charKey) return;
    setSeqName(name);
    setBusy(true);
    setErr(null);
    try {
      const manifest = await apiSequenceGet(charKey, name);
      setGallery((manifest.gallery || []).filter((g) => g.frameSequence));
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 600, marginBottom: 10 }}>Import character video</div>
        {err ? <div style={{ color: "#ff8080", marginBottom: 8 }}>{err}</div> : null}

        {!charKey ? (
          <Section title={busy ? "Loading characters…" : "Pick a character"}>
            {chars.map((c) => (
              <button key={c.charKey} style={rowBtn} onClick={() => void pickCharacter(c.charKey)}>
                {c.coverRelPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetUrlFromRelPath(c.coverRelPath)} alt="" style={thumb} />
                ) : null}
                {c.charKey}
              </button>
            ))}
          </Section>
        ) : !seqName ? (
          <Section
            title={busy ? "Loading sequences…" : `Pick a sequence (${charKey})`}
            onBack={() => setCharKey(null)}
          >
            {seqNames.length === 0 && !busy ? (
              <div style={{ color: "#aaa" }}>No sequences for this character.</div>
            ) : null}
            {seqNames.map((n) => (
              <button key={n} style={rowBtn} onClick={() => void pickSequence(n)}>
                {n}
              </button>
            ))}
          </Section>
        ) : (
          <Section
            title={busy ? "Loading…" : `Pick what to import (${seqName})`}
            onBack={() => setSeqName(null)}
          >
            <button
              style={rowBtn}
              onClick={() =>
                onPick({
                  charKey: charKey,
                  sequenceName: seqName,
                  label: `${seqName} (whole sequence)`,
                })
              }
            >
              ▶ Whole sequence timeline
            </button>
            {gallery.map((g, i) => (
              <button
                key={g.id}
                style={rowBtn}
                onClick={() =>
                  onPick({
                    charKey: charKey,
                    sequenceName: seqName,
                    galleryItemId: g.id,
                    label: `${seqName} · clip ${i + 1}`,
                  })
                }
              >
                {g.relPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetUrlFromRelPath(g.relPath)} alt="" style={thumb} />
                ) : null}
                Generated clip {i + 1}
              </button>
            ))}
            {gallery.length === 0 && !busy ? (
              <div style={{ color: "#aaa", marginTop: 6 }}>
                No generated clips — only the whole sequence is available.
              </div>
            ) : null}
          </Section>
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

function Section(props: {
  title: string;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        {props.onBack ? (
          <button onClick={props.onBack} style={backBtn}>
            ←
          </button>
        ) : null}
        <span style={{ color: "#bbb", fontSize: 13 }}>{props.title}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
        {props.children}
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
  width: 520,
  maxWidth: "92vw",
  background: "#111",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.2)",
  padding: 16,
  font: "inherit",
};
const rowBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  textAlign: "left",
  background: "#1b1b1b",
  border: "1px solid rgba(255,255,255,0.2)",
  color: "#ddd",
  padding: "6px 10px",
  cursor: "pointer",
  font: "inherit",
};
const thumb: React.CSSProperties = { width: 48, height: 32, objectFit: "contain" };
const btn: React.CSSProperties = {
  background: "transparent",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.35)",
  padding: "6px 14px",
  cursor: "pointer",
  font: "inherit",
};
const backBtn: React.CSSProperties = {
  background: "transparent",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.3)",
  padding: "2px 8px",
  cursor: "pointer",
  font: "inherit",
};
