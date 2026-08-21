"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiHubChangeCover,
  apiHubCharacters,
  apiHubCoverCandidates,
  apiHubDelete,
  apiHubRename,
  assetUrlFromRelPath,
  CoverCandidate,
  HubCharacter,
} from "../../lib/api";
import {
  DesktopContextMenu,
  ContextMenuItem,
} from "../../components/DesktopContextMenu";
import { ImagePickerModal } from "../../components/ImagePickerModal";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import { JobLogButton } from "../../components/JobLogButton";
import { CharacterNameTag } from "../../components/CharacterNameTag";
import { SquareButton } from "../../components/SquareButton";
import { useAppError } from "../../components/ErrorProvider";

export default function HubPage() {
  const router = useRouter();
  const { showError, askText, confirmAction } = useAppError();
  const [chars, setChars] = useState<HubCharacter[]>([]);
  const [loading, setLoading] = useState(false);
  const [coversVersion, setCoversVersion] = useState<number>(0);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuX, setMenuX] = useState(0);
  const [menuY, setMenuY] = useState(0);
  const [menuCharKey, setMenuCharKey] = useState<string>("");

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTitle, setPickerTitle] = useState("Choose cover image");
  const [pickerOkText, setPickerOkText] = useState("Set as Cover");
  const [pickerCancelText, setPickerCancelText] = useState("Cancel");
  const [pickerImages, setPickerImages] = useState<CoverCandidate[]>([]);
  const [pickerCharKey, setPickerCharKey] = useState<string>("");

  function encodeCoverImage(relPath: string) {
    return assetUrlFromRelPath(relPath) + "?v=" + coversVersion;
  }

  const fetchChars = async () => {
    setLoading(true);
    try {
      const data = await apiHubCharacters();
      setChars(data);
      setCoversVersion((v) => v + 1);
    } catch (e) {
      showError({
        title: "Character hub",
        message:
          "Could not load characters. Start the API server (e.g. uvicorn on port 8000) and ensure the Next dev proxy can reach it.",
        error: e,
      });
      setChars([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchChars();
  }, []);

  function beginInlineRename(charKey: string) {
    setEditingKey(charKey);
    setDraftName(charKey);
  }

  async function commitInlineRename(charKey: string) {
    const next = (draftName || "").trim();
    if (!next) {
      setEditingKey(null);
      setDraftName("");
      return;
    }
    if (next === charKey) {
      setEditingKey(null);
      setDraftName("");
      return;
    }
    try {
      await apiHubRename(charKey, next);
      await fetchChars();
    } catch (e) {
      showError({ message: "Rename failed.", error: e });
      return;
    }
    setEditingKey(null);
    setDraftName("");
  }

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!menuCharKey) return [];
    return [
      {
        key: "rename",
        label: "Rename Character",
        onSelect: async () => {
          // Keep existing modal rename flow for context menu.
          const nn = await askText({
            title: "Rename Character",
            message: "New name:",
            defaultValue: menuCharKey,
            confirmText: "Rename",
          });
          if (!nn?.trim()) return;
          apiHubRename(menuCharKey, nn)
            .then(() => fetchChars())
            .catch((e) => showError({ message: "Rename failed.", error: e }));
        },
      },
      {
        key: "delete",
        label: "Delete Character",
        onSelect: async () => {
          const msg = `Delete character “${menuCharKey}” and all of its files? This cannot be undone.`;
          const ok = await confirmAction({
            title: "Delete Character",
            message: msg,
            confirmText: "Delete",
          });
          if (!ok) return;
          apiHubDelete(menuCharKey)
            .then(() => fetchChars())
            .catch((e) => showError({ message: "Delete failed.", error: e }));
        },
      },
      {
        key: "cover",
        label: "Change Cover",
        onSelect: async () => {
          const candidates = await apiHubCoverCandidates(menuCharKey);
          setPickerImages(candidates);
          setPickerCharKey(menuCharKey);
          setPickerOpen(true);
        },
      },
    ];
  }, [askText, confirmAction, menuCharKey, showError]);

  const N_COLS = 5;
  const TILE = 140;
  const GAP = 8;

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
        <JobLogButton />
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
          {/* New Character tile at [0,0] */}
          <div style={{ width: TILE }}>
            <div style={{ visibility: "hidden" }}>
              <CharacterNameTag variant="hub" text="." />
            </div>
            <SquareButton
              size={TILE}
              variant="tile"
              tone="dark"
              style={{ fontWeight: 400 }}
              onClick={() => router.push("/new_character")}
            >
              New Character
            </SquareButton>
          </div>

          {chars.map((c) => {
            return (
              <div
                key={c.charKey}
                style={{
                  width: TILE,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                }}
              >
                <CharacterNameTag
                  variant="hub"
                  text={c.charKey}
                  title="Double-click to rename"
                  onRequestEdit={() => beginInlineRename(c.charKey)}
                  editing={editingKey === c.charKey}
                  value={editingKey === c.charKey ? draftName : c.charKey}
                  onChange={(v) => setDraftName(v)}
                  onBlur={() => void commitInlineRename(c.charKey)}
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
                  onClick={() => router.push(`/detail/${encodeURIComponent(c.charKey)}`)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenuCharKey(c.charKey);
                    setMenuX(e.clientX);
                    setMenuY(e.clientY);
                    setMenuOpen(true);
                  }}
                >
                  <img
                    src={encodeCoverImage(c.coverRelPath)}
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
            );
          })}
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
          await apiHubChangeCover(pickerCharKey, relPath);
          await fetchChars();
        }}
      />

      {loading ? null : null}
    </div>
  );
}

