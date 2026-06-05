"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiTimelineCreate,
  apiTimelineHubDelete,
  apiTimelineHubItems,
  apiTimelineHubRename,
  assetUrlFromRelPath,
  HubTimeline,
} from "../../lib/api";
import {
  DesktopContextMenu,
  ContextMenuItem,
} from "../../components/DesktopContextMenu";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import { CharacterNameTag } from "../../components/CharacterNameTag";
import { SquareButton } from "../../components/SquareButton";
import { useAppError } from "../../components/ErrorProvider";

export default function TimelineHubPage() {
  const router = useRouter();
  const { showError, askText, confirmAction } = useAppError();
  const [items, setItems] = useState<HubTimeline[]>([]);
  const [loading, setLoading] = useState(false);
  const [coversVersion, setCoversVersion] = useState<number>(0);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuX, setMenuX] = useState(0);
  const [menuY, setMenuY] = useState(0);
  const [menuKey, setMenuKey] = useState<string>("");

  function encodeCoverImage(relPath: string) {
    return assetUrlFromRelPath(relPath) + "?v=" + coversVersion;
  }

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await apiTimelineHubItems();
      setItems(data);
      setCoversVersion((v) => v + 1);
    } catch (e) {
      showError({
        title: "Video timelines",
        message:
          "Could not load timelines. Start the API server (e.g. uvicorn on port 8000) and ensure the Next dev proxy can reach it.",
        error: e,
      });
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  async function createTimeline() {
    try {
      const { timelineKey } = await apiTimelineCreate("Timeline");
      router.push(`/timeline/${encodeURIComponent(timelineKey)}`);
    } catch (e) {
      showError({ message: "Could not create timeline.", error: e });
    }
  }

  function beginInlineRename(timelineKey: string) {
    setEditingKey(timelineKey);
    setDraftName(timelineKey);
  }

  async function commitInlineRename(timelineKey: string) {
    const next = (draftName || "").trim();
    if (!next || next === timelineKey) {
      setEditingKey(null);
      setDraftName("");
      return;
    }
    try {
      await apiTimelineHubRename(timelineKey, next);
      await refresh();
    } catch (e) {
      showError({ message: "Rename failed.", error: e });
      return;
    }
    setEditingKey(null);
    setDraftName("");
  }

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!menuKey) return [];
    return [
      {
        key: "open",
        label: "Open Timeline",
        onSelect: () => router.push(`/timeline/${encodeURIComponent(menuKey)}`),
      },
      {
        key: "rename",
        label: "Rename Timeline",
        onSelect: async () => {
          const nn = await askText({
            title: "Rename Timeline",
            message: "New name:",
            defaultValue: menuKey,
            confirmText: "Rename",
          });
          if (!nn?.trim()) return;
          apiTimelineHubRename(menuKey, nn.trim())
            .then(() => refresh())
            .catch((e) => showError({ message: "Rename failed.", error: e }));
        },
      },
      {
        key: "delete",
        label: "Delete Timeline",
        onSelect: async () => {
          const ok = await confirmAction({
            title: "Delete Timeline",
            message: `Delete timeline "${menuKey}" and all its files?`,
            confirmText: "Delete",
          });
          if (!ok) return;
          apiTimelineHubDelete(menuKey)
            .then(() => refresh())
            .catch((e) => showError({ message: "Delete failed.", error: e }));
        },
      },
    ];
  }, [askText, confirmAction, menuKey, showError, router]);

  const N_COLS = 5;
  const TILE = 140;
  const GAP = 8;

  return (
    <div style={{ padding: 0, minHeight: "100vh" }}>
      <div
        style={{
          display: "flex",
          gap: 4,
          alignItems: "center",
          paddingLeft: 20,
          marginBottom: 10,
        }}
      >
        <HfTokenSettingsButton />
        <SquareIconButton
          onClick={() => router.push("/home")}
          aria-label="Home"
          icon={<HomeIcon />}
        />
        <SquareIconButton
          onClick={() => router.push("/home")}
          aria-label="Back"
          icon={<TriangleIcon direction="left" />}
        />
      </div>

      <div style={{ paddingLeft: 20 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${N_COLS}, ${TILE}px)`,
            gap: GAP,
            alignItems: "start",
          }}
        >
          {/* New Timeline tile at [0,0] */}
          <div style={{ width: TILE }}>
            <div style={{ visibility: "hidden" }}>
              <CharacterNameTag variant="hub" text="." />
            </div>
            <SquareButton
              size={TILE}
              variant="tile"
              tone="dark"
              style={{ fontWeight: 400 }}
              onClick={() => void createTimeline()}
            >
              New Timeline
            </SquareButton>
          </div>

          {items.map((x) => (
            <div
              key={x.timelineKey}
              style={{
                width: TILE,
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
              }}
            >
              <CharacterNameTag
                variant="hub"
                text={x.timelineKey}
                title="Double-click to rename"
                onRequestEdit={() => beginInlineRename(x.timelineKey)}
                editing={editingKey === x.timelineKey}
                value={editingKey === x.timelineKey ? draftName : x.timelineKey}
                onChange={(v) => setDraftName(v)}
                onBlur={() => void commitInlineRename(x.timelineKey)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.currentTarget as HTMLInputElement).blur();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditingKey(null);
                    setDraftName("");
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
              />
              <SquareButton
                size={TILE}
                variant="tile"
                tone="dark"
                className="hub-cover-btn"
                style={{
                  background: "transparent",
                  padding: 0,
                  overflow: "hidden",
                }}
                onClick={() => router.push(`/timeline/${encodeURIComponent(x.timelineKey)}`)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuKey(x.timelineKey);
                  setMenuX(e.clientX);
                  setMenuY(e.clientY);
                  setMenuOpen(true);
                }}
              >
                {x.coverRelPath ? (
                  <img
                    src={encodeCoverImage(x.coverRelPath)}
                    alt=""
                    className="hub-cover-img"
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      display: "block",
                    }}
                  />
                ) : (
                  <span style={{ fontWeight: 400 }}>Open</span>
                )}
              </SquareButton>
            </div>
          ))}
        </div>
      </div>

      <DesktopContextMenu
        open={menuOpen}
        x={menuX}
        y={menuY}
        items={menuItems}
        onClose={() => setMenuOpen(false)}
      />

      {loading ? null : null}
    </div>
  );
}
