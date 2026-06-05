"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiShotHubDelete,
  apiShotHubItems,
  apiShotHubRename,
  apiShotHubSetGenerated,
  assetUrlFromRelPath,
  runShotMakeAngleWsJob,
  HubShot,
} from "../../lib/api";
import { CameraAngleModal } from "../../components/CameraAngleModal";
import {
  DesktopContextMenu,
  ContextMenuItem,
} from "../../components/DesktopContextMenu";
import { GalleryImageLightbox } from "../../components/GalleryImageLightbox";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import { CharacterNameTag } from "../../components/CharacterNameTag";
import { SquareButton } from "../../components/SquareButton";
import { useAppError } from "../../components/ErrorProvider";

export default function ShotHubPage() {
  const router = useRouter();
  const { showError, askText, confirmAction } = useAppError();
  const [items, setItems] = useState<HubShot[]>([]);
  const [loading, setLoading] = useState(false);
  const [coversVersion, setCoversVersion] = useState<number>(0);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuX, setMenuX] = useState(0);
  const [menuY, setMenuY] = useState(0);
  const [menuKey, setMenuKey] = useState<string>("");

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // Camera "New Angle" on a generated shot cover.
  const [angleOpen, setAngleOpen] = useState(false);
  const [angleImageUrl, setAngleImageUrl] = useState<string | null>(null);
  const [angleBusy, setAngleBusy] = useState(false);
  const angleShotKeyRef = useRef<string | null>(null);
  const angleCoverRelRef = useRef<string | null>(null);

  function openNewAngle(shotKey: string, coverRelPath: string) {
    angleShotKeyRef.current = shotKey;
    angleCoverRelRef.current = coverRelPath;
    setAngleImageUrl(assetUrlFromRelPath(coverRelPath));
    setAngleOpen(true);
  }

  async function applyNewAngle(angleId: number) {
    setAngleOpen(false);
    const shotKey = angleShotKeyRef.current;
    const coverRelPath = angleCoverRelRef.current;
    angleShotKeyRef.current = null;
    angleCoverRelRef.current = null;
    if (!shotKey || !coverRelPath) return;
    setAngleBusy(true);
    try {
      const done = await runShotMakeAngleWsJob({
        imageRelPath: coverRelPath,
        angleId,
        onLogLine: () => {},
      });
      const newRel = done.result?.relPath;
      if (!done.ok || !newRel) {
        throw new Error(done.error || "Angle generation returned no image.");
      }
      await apiShotHubSetGenerated(shotKey, newRel);
      await refresh();
    } catch (e) {
      showError({ message: "Could not generate a new angle.", error: e });
    } finally {
      setAngleBusy(false);
    }
  }

  function encodeCoverImage(relPath: string) {
    return assetUrlFromRelPath(relPath) + "?v=" + coversVersion;
  }

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await apiShotHubItems();
      setItems(data);
      setCoversVersion((v) => v + 1);
    } catch (e) {
      showError({
        title: "Shot hub",
        message:
          "Could not load shots. Start the API server (e.g. uvicorn on port 8000) and ensure the Next dev proxy can reach it.",
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

  function beginInlineRename(shotKey: string) {
    setEditingKey(shotKey);
    setDraftName(shotKey);
  }

  async function commitInlineRename(shotKey: string) {
    const next = (draftName || "").trim();
    if (!next || next === shotKey) {
      setEditingKey(null);
      setDraftName("");
      return;
    }
    try {
      await apiShotHubRename(shotKey, next);
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
    const cover = items.find((x) => x.shotKey === menuKey)?.coverRelPath;
    return [
      {
        key: "new_angle",
        label: "New Angle",
        disabled: !cover || angleBusy,
        onSelect: () => {
          if (cover) openNewAngle(menuKey, cover);
        },
      },
      {
        key: "rename",
        label: "Rename Shot",
        onSelect: async () => {
          const nn = await askText({
            title: "Rename Shot",
            message: "New name:",
            defaultValue: menuKey,
            confirmText: "Rename",
          });
          if (!nn?.trim()) return;
          apiShotHubRename(menuKey, nn.trim())
            .then(() => refresh())
            .catch((e) => showError({ message: "Rename failed.", error: e }));
        },
      },
      {
        key: "delete",
        label: "Delete Shot",
        onSelect: async () => {
          const ok = await confirmAction({
            title: "Delete Shot",
            message: `Delete shot "${menuKey}" and all its files?`,
            confirmText: "Delete",
          });
          if (!ok) return;
          apiShotHubDelete(menuKey)
            .then(() => refresh())
            .catch((e) => showError({ message: "Delete failed.", error: e }));
        },
      },
    ];
  }, [askText, confirmAction, menuKey, showError, items, angleBusy]);

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
          {/* New Shot tile at [0,0] */}
          <div style={{ width: TILE }}>
            <div style={{ visibility: "hidden" }}>
              <CharacterNameTag variant="hub" text="." />
            </div>
            <SquareButton
              size={TILE}
              variant="tile"
              tone="dark"
              style={{ fontWeight: 400 }}
              onClick={() => router.push("/new_shot")}
            >
              New Shot
            </SquareButton>
          </div>

          {items.map((x) => (
            <div
              key={x.shotKey}
              style={{
                width: TILE,
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
              }}
            >
              <CharacterNameTag
                variant="hub"
                text={x.shotKey}
                title="Double-click to rename"
                onRequestEdit={() => beginInlineRename(x.shotKey)}
                editing={editingKey === x.shotKey}
                value={editingKey === x.shotKey ? draftName : x.shotKey}
                onChange={(v) => setDraftName(v)}
                onBlur={() => void commitInlineRename(x.shotKey)}
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
                onClick={() => setLightboxSrc(encodeCoverImage(x.coverRelPath))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuKey(x.shotKey);
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

      <CameraAngleModal
        open={angleOpen}
        title="New Angle"
        imageUrl={angleImageUrl}
        onCancel={() => {
          setAngleOpen(false);
          angleShotKeyRef.current = null;
          angleCoverRelRef.current = null;
        }}
        onConfirm={(angleId) => void applyNewAngle(angleId)}
      />

      {angleBusy ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            zIndex: 1000,
            font: "inherit",
          }}
        >
          Generating new angle…
        </div>
      ) : null}

      {lightboxSrc ? (
        <GalleryImageLightbox
          paths={[lightboxSrc]}
          index={0}
          title="Shot"
          onClose={() => setLightboxSrc(null)}
        />
      ) : null}

      {loading ? null : null}
    </div>
  );
}
