"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  apiReferenceAudioDelete,
  apiReferenceAudioFolderCreate,
  apiReferenceAudioLayout,
  assetUrlFromRelPath,
  type AudioLayout,
  type AudioReference,
} from "../lib/api";
import {
  DesktopContextMenu,
  type ContextMenuItem,
} from "./DesktopContextMenu";
import { useAppError } from "./ErrorProvider";
import { AudioRefGrid } from "./AudioRefGrid";
import { StylizedAudioPlayer } from "./StylizedAudioPlayer";

const MUSIC_STYLE_PLACEHOLDER =
  "Describe music style, instruments, mood, tempo, etc.\n\ne.g. Rock: high-energy modern rock with distorted guitars, punchy drums, and a strong bassline.";

const MUSIC_LYRICS_PLACEHOLDER = `___ (sample lyric)
[Verse 1]
Static in the air, I feel it in my bones
Every step I take, I'm carving out my own

[Chorus]
Shout it out, I'm alive tonight
Burning bright in the dead of night`;

const AUDIO_DURATION_DEFAULT = 30;
const AUDIO_DURATION_MIN = 1;
const AUDIO_DURATION_MAX = 47.6;
const MUSIC_DURATION_DEFAULT = 120;
const MUSIC_DURATION_MIN = 1;
const MUSIC_DURATION_MAX = 300;

function clampDuration(n: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export type TimelineAudioPickerTab = "audio" | "music";

export function TimelineAudioPicker(props: {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onGenerateAudio: (prompt: string, durationSec: number) => void;
  onGenerateMusic: (style: string, lyrics: string, durationSec: number) => void;
  onUseSelected: (items: AudioReference[]) => void;
}) {
  if (!props.open) return null;
  return <TimelineAudioPickerOpen {...props} />;
}

function TimelineAudioPickerOpen(props: {
  busy: boolean;
  onCancel: () => void;
  onGenerateAudio: (prompt: string, durationSec: number) => void;
  onGenerateMusic: (style: string, lyrics: string, durationSec: number) => void;
  onUseSelected: (items: AudioReference[]) => void;
}) {
  const { busy, onCancel, onGenerateAudio, onGenerateMusic, onUseSelected } = props;
  const { confirmAction, askText, showError } = useAppError();

  const [tab, setTab] = useState<TimelineAudioPickerTab>("audio");
  const [audioPrompt, setAudioPrompt] = useState("");
  const [audioDurationSec, setAudioDurationSec] = useState(AUDIO_DURATION_DEFAULT);
  const [musicStyle, setMusicStyle] = useState("");
  const [musicLyrics, setMusicLyrics] = useState("");
  const [musicDurationSec, setMusicDurationSec] = useState(MUSIC_DURATION_DEFAULT);
  const [layout, setLayout] = useState<AudioLayout>({
    folders: [],
    rootOrder: [],
    folderOrder: {},
    items: [],
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [viewFolderId, setViewFolderId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    items: ContextMenuItem[];
  }>({ open: false, x: 0, y: 0, items: [] });
  const [previewItem, setPreviewItem] = useState<AudioReference | null>(null);

  const canGenerateAudio = !busy && audioPrompt.trim().length > 0;
  const canGenerateMusic =
    !busy && musicStyle.trim().length > 0 && musicLyrics.trim().length > 0;

  const loadLayout = useCallback(async () => {
    try {
      setLayout(await apiReferenceAudioLayout());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadLayout();
  }, [loadLayout]);

  const itemById = new Map(layout.items.map((x) => [x.id, x]));

  const orderedSelection = (): AudioReference[] => {
    const order = viewFolderId
      ? layout.folderOrder[viewFolderId] ?? []
      : layout.rootOrder;
    const out: AudioReference[] = [];
    for (const tok of order) {
      if (!selectedIds.has(tok)) continue;
      const it = itemById.get(tok);
      if (it) out.push(it);
    }
    for (const tok of selectedIds) {
      if (!out.some((x) => x.id === tok)) {
        const it = itemById.get(tok);
        if (it) out.push(it);
      }
    }
    return out;
  };

  const handleUseSelected = () => {
    const sel = orderedSelection();
    if (!sel.length) return;
    onUseSelected(sel);
  };

  const handleCreateFolder = useCallback(async () => {
    const ids = [...selectedIds].filter((id) => !id.startsWith("folder:"));
    if (!ids.length) return;
    const name = await askText({
      title: "New folder",
      message: "Name for this audio folder:",
      defaultValue: "Folder",
      confirmText: "Create",
    });
    if (!name?.trim()) return;
    try {
      await apiReferenceAudioFolderCreate(name.trim(), ids);
      setSelectedIds(new Set());
      setAnchorId(null);
      await loadLayout();
    } catch {
      /* ignore */
    }
  }, [askText, loadLayout, selectedIds]);

  const openAudioMenu = useCallback(
    (e: React.MouseEvent, item: AudioReference) => {
      e.preventDefault();
      setMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            key: "preview",
            label: "Preview",
            onSelect: () => setPreviewItem(item),
          },
          {
            key: "delete",
            label: "Delete",
            onSelect: () =>
              void (async () => {
                const ok = await confirmAction({
                  title: "Delete audio",
                  message: "Delete this audio from the gallery?",
                  confirmText: "Delete",
                });
                if (!ok) return;
                try {
                  await apiReferenceAudioDelete(item.id);
                  setSelectedIds((prev) => {
                    const n = new Set(prev);
                    n.delete(item.id);
                    return n;
                  });
                  await loadLayout();
                } catch (e) {
                  showError({ message: "Delete audio failed.", error: e });
                }
              })(),
          },
        ],
      });
    },
    [confirmAction, loadLayout, showError]
  );

  const tabBtn = (id: TimelineAudioPickerTab, label: string) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => setTab(id)}
      style={{
        flex: 1,
        borderRadius: 0,
        border: "1px solid rgba(255,255,255,0.3)",
        borderBottom: tab === id ? "2px solid #eee" : "1px solid rgba(255,255,255,0.3)",
        background: tab === id ? "rgba(255,255,255,0.08)" : "transparent",
        color: "#eee",
        padding: "6px 12px",
        cursor: busy ? "not-allowed" : "pointer",
        fontWeight: tab === id ? 500 : 400,
      }}
    >
      {label}
    </button>
  );

  return (
    <>
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
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          onCancel();
        }}
      >
        <div
          style={{
            width: 600,
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
        <div style={{ fontWeight: 400, marginBottom: 10 }}>Add Audio</div>

        <div style={{ display: "flex", gap: 0, marginBottom: 10 }}>
          {tabBtn("audio", "Audio")}
          {tabBtn("music", "Music")}
        </div>

        {tab === "audio" ? (
          <div style={{ marginBottom: 12 }}>
            <textarea
              value={audioPrompt}
              disabled={busy}
              onChange={(e) => setAudioPrompt(e.target.value)}
              placeholder="Describe ambient sound, dialogue, or instrumental audio…"
              rows={3}
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
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <label style={{ fontSize: 11, color: "#aaa", whiteSpace: "nowrap" }}>
                Duration (s)
              </label>
              <input
                type="number"
                min={AUDIO_DURATION_MIN}
                max={AUDIO_DURATION_MAX}
                step={0.1}
                value={audioDurationSec}
                disabled={busy}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (!Number.isNaN(n)) setAudioDurationSec(n);
                }}
                onBlur={() =>
                  setAudioDurationSec((d) =>
                    clampDuration(d, AUDIO_DURATION_MIN, AUDIO_DURATION_MAX, AUDIO_DURATION_DEFAULT)
                  )
                }
                style={{
                  width: 80,
                  padding: "4px 6px",
                  background: "transparent",
                  color: "#eee",
                  border: "1px solid rgba(255,255,255,0.2)",
                  font: "inherit",
                  fontSize: 12,
                }}
              />
            </div>
            <button
              type="button"
              disabled={!canGenerateAudio}
              onClick={() => {
                const p = audioPrompt.trim();
                if (!p) return;
                const dur = clampDuration(
                  audioDurationSec,
                  AUDIO_DURATION_MIN,
                  AUDIO_DURATION_MAX,
                  AUDIO_DURATION_DEFAULT
                );
                setAudioDurationSec(dur);
                onGenerateAudio(p, dur);
              }}
              style={{
                width: "100%",
                borderRadius: 0,
                border: "1px solid rgba(255,255,255,0.3)",
                background: "transparent",
                color: "#eee",
                padding: "8px 12px",
                cursor: canGenerateAudio ? "pointer" : "not-allowed",
                opacity: canGenerateAudio ? 1 : 0.5,
              }}
            >
              Generate
            </button>
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <textarea
              value={musicStyle}
              disabled={busy}
              onChange={(e) => setMusicStyle(e.target.value)}
              placeholder={MUSIC_STYLE_PLACEHOLDER}
              rows={3}
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
            <textarea
              value={musicLyrics}
              disabled={busy}
              onChange={(e) => setMusicLyrics(e.target.value)}
              placeholder={MUSIC_LYRICS_PLACEHOLDER}
              rows={5}
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
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <label style={{ fontSize: 11, color: "#aaa", whiteSpace: "nowrap" }}>
                Duration (s)
              </label>
              <input
                type="number"
                min={MUSIC_DURATION_MIN}
                max={MUSIC_DURATION_MAX}
                step={1}
                value={musicDurationSec}
                disabled={busy}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  if (!Number.isNaN(n)) setMusicDurationSec(n);
                }}
                onBlur={() =>
                  setMusicDurationSec((d) =>
                    clampDuration(d, MUSIC_DURATION_MIN, MUSIC_DURATION_MAX, MUSIC_DURATION_DEFAULT)
                  )
                }
                style={{
                  width: 80,
                  padding: "4px 6px",
                  background: "transparent",
                  color: "#eee",
                  border: "1px solid rgba(255,255,255,0.2)",
                  font: "inherit",
                  fontSize: 12,
                }}
              />
            </div>
            <button
              type="button"
              disabled={!canGenerateMusic}
              onClick={() => {
                const s = musicStyle.trim();
                const l = musicLyrics.trim();
                if (!s || !l) return;
                const dur = clampDuration(
                  musicDurationSec,
                  MUSIC_DURATION_MIN,
                  MUSIC_DURATION_MAX,
                  MUSIC_DURATION_DEFAULT
                );
                setMusicDurationSec(dur);
                onGenerateMusic(s, l, dur);
              }}
              style={{
                width: "100%",
                borderRadius: 0,
                border: "1px solid rgba(255,255,255,0.3)",
                background: "transparent",
                color: "#eee",
                padding: "8px 12px",
                cursor: canGenerateMusic ? "pointer" : "not-allowed",
                opacity: canGenerateMusic ? 1 : 0.5,
              }}
            >
              Generate
            </button>
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            disabled={busy || selectedIds.size === 0}
            onClick={handleUseSelected}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "6px 12px",
              cursor: busy || selectedIds.size === 0 ? "not-allowed" : "pointer",
              opacity: busy || selectedIds.size === 0 ? 0.5 : 1,
            }}
          >
            Use Selected
          </button>
          <button
            type="button"
            disabled={busy || selectedIds.size === 0}
            onClick={() => void handleCreateFolder()}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "transparent",
              color: "#eee",
              padding: "6px 12px",
              cursor: busy || selectedIds.size === 0 ? "not-allowed" : "pointer",
              opacity: busy || selectedIds.size === 0 ? 0.5 : 1,
            }}
          >
            Folder
          </button>
          {selectedIds.size > 0 ? (
            <span style={{ fontSize: 13, opacity: 0.7 }}>
              {selectedIds.size} selected
            </span>
          ) : null}
        </div>

        <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
          <AudioRefGrid
            busy={busy}
            layout={layout}
            onLayoutChange={setLayout}
            selectedIds={selectedIds}
            onSelectedIdsChange={setSelectedIds}
            anchorId={anchorId}
            onAnchorIdChange={setAnchorId}
            viewFolderId={viewFolderId}
            onViewFolderIdChange={setViewFolderId}
            onContextMenu={openAudioMenu}
            onPreview={setPreviewItem}
          />
        </div>

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

      <DesktopContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menu.items}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />

      {previewItem ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10001,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            setPreviewItem(null);
          }}
        >
          <div onMouseDown={(e) => e.stopPropagation()}>
            <StylizedAudioPlayer
              src={assetUrlFromRelPath(previewItem.relPath)}
              autoPlay
              label={previewItem.label || previewItem.tags || previewItem.id}
              tone="light"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
