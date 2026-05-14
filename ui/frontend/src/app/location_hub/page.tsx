"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiLocationHubChangeCover,
  apiLocationHubCoverCandidates,
  apiLocationHubDelete,
  apiLocationHubItems,
  apiLocationHubRename,
  assetUrlFromRelPath,
  CoverCandidate,
  HubLocation,
} from "../../lib/api";
import {
  DesktopContextMenu,
  ContextMenuItem,
} from "../../components/DesktopContextMenu";
import { ImagePickerModal } from "../../components/ImagePickerModal";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import { CharacterNameTag } from "../../components/CharacterNameTag";
import { SquareButton } from "../../components/SquareButton";
import { useAppError } from "../../components/ErrorProvider";

export default function LocationHubPage() {
  const router = useRouter();
  const { showError, askText, confirmAction } = useAppError();
  const [items, setItems] = useState<HubLocation[]>([]);
  const [loading, setLoading] = useState(false);
  const [coversVersion, setCoversVersion] = useState<number>(0);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuX, setMenuX] = useState(0);
  const [menuY, setMenuY] = useState(0);
  const [menuKey, setMenuKey] = useState<string>("");

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerImages, setPickerImages] = useState<CoverCandidate[]>([]);
  const [pickerKey, setPickerKey] = useState<string>("");

  function encodeCoverImage(relPath: string) {
    return assetUrlFromRelPath(relPath) + "?v=" + coversVersion;
  }

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await apiLocationHubItems();
      setItems(data);
      setCoversVersion((v) => v + 1);
    } catch (e) {
      showError({
        title: "Location hub",
        message:
          "Could not load locations. Start the API server (e.g. uvicorn on port 8000) and ensure the Next dev proxy can reach it.",
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

  function beginInlineRename(locationKey: string) {
    setEditingKey(locationKey);
    setDraftName(locationKey);
  }

  async function commitInlineRename(locationKey: string) {
    const next = (draftName || "").trim();
    if (!next) {
      setEditingKey(null);
      setDraftName("");
      return;
    }
    if (next === locationKey) {
      setEditingKey(null);
      setDraftName("");
      return;
    }
    try {
      await apiLocationHubRename(locationKey, next);
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
        key: "rename",
        label: "Rename Location",
        onSelect: async () => {
          const nn = await askText({
            title: "Rename Location",
            message: "New name:",
            defaultValue: menuKey,
            confirmText: "Rename",
          });
          if (!nn?.trim()) return;
          apiLocationHubRename(menuKey, nn.trim())
            .then(() => refresh())
            .catch((e) => showError({ message: "Rename failed.", error: e }));
        },
      },
      {
        key: "delete",
        label: "Delete Location",
        onSelect: async () => {
          const ok = await confirmAction({
            title: "Delete Location",
            message: `Delete location "${menuKey}" and all its files?`,
            confirmText: "Delete",
          });
          if (!ok) return;
          apiLocationHubDelete(menuKey)
            .then(() => refresh())
            .catch((e) => showError({ message: "Delete failed.", error: e }));
        },
      },
      {
        key: "cover",
        label: "Change Cover",
        onSelect: async () => {
          const candidates = await apiLocationHubCoverCandidates(menuKey);
          setPickerImages(candidates);
          setPickerKey(menuKey);
          setPickerOpen(true);
        },
      },
    ];
  }, [askText, confirmAction, menuKey, showError]);

  const N_COLS = 5;
  const TILE = 140;
  const GAP = 8;
  const pickerTitle = "Choose cover image";
  const pickerOkText = "Set as Cover";
  const pickerCancelText = "Cancel";

  return (
    <div style={{ padding: 0, minHeight: "100vh" }}>
      {/* Header nav row */}
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

      {/* Grid */}
      <div style={{ paddingLeft: 20 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${N_COLS}, ${TILE}px)`,
            gap: GAP,
            alignItems: "start",
          }}
        >
          {/* New Location tile at [0,0] */}
          <div style={{ width: TILE }}>
            <div style={{ visibility: "hidden" }}>
              <CharacterNameTag variant="hub" text="." />
            </div>
            <SquareButton
              size={TILE}
              variant="tile"
              tone="dark"
              style={{ fontWeight: 400 }}
              onClick={() => router.push("/new_location")}
            >
              New Location
            </SquareButton>
          </div>

          {items.map((x) => (
            <div
              key={x.locationKey}
              style={{
                width: TILE,
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
              }}
            >
              <CharacterNameTag
                variant="hub"
                text={x.locationKey}
                title="Double-click to rename"
                onRequestEdit={() => beginInlineRename(x.locationKey)}
                editing={editingKey === x.locationKey}
                value={editingKey === x.locationKey ? draftName : x.locationKey}
                onChange={(v) => setDraftName(v)}
                onBlur={() => void commitInlineRename(x.locationKey)}
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
                onClick={() =>
                  router.push(`/detail/${encodeURIComponent(x.locationKey)}/location`)
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuKey(x.locationKey);
                  setMenuX(e.clientX);
                  setMenuY(e.clientY);
                  setMenuOpen(true);
                }}
              >
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

      <ImagePickerModal
        open={pickerOpen}
        title={pickerTitle}
        okText={pickerOkText}
        cancelText={pickerCancelText}
        images={pickerImages}
        onCancel={() => setPickerOpen(false)}
        onPick={async (relPath) => {
          setPickerOpen(false);
          try {
            await apiLocationHubChangeCover(pickerKey, relPath);
            await refresh();
          } catch (e) {
            showError({ message: "Change cover failed.", error: e });
          }
        }}
      />

      {loading ? null : null}
    </div>
  );
}
