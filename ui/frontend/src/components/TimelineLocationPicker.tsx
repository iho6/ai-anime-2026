"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiLocationAiEdit,
  apiLocationDeleteItems,
  apiLocationGallerySplit,
  apiLocationGenerateAnglesStream,
  apiLocationHide,
  apiLocationHubItems,
  apiLocationUnhide,
  assetUrlFromRelPath,
  type LocationGalleryItem,
} from "../lib/api";
import { AiEditModal } from "./AiEditModal";
import { CameraAngleModal } from "./CameraAngleModal";
import { CollapsibleGallerySection } from "./CollapsibleGallerySection";
import {
  DesktopContextMenu,
  type ContextMenuItem,
} from "./DesktopContextMenu";
import { SquareIconButton, TriangleIcon } from "./IconPrimitives";
import type { SharedLogStreamHandle } from "./SharedLogStream";
import { ConnectedJobRunModal } from "./ConnectedJobRunModal";
import { useJobRunSession } from "../hooks/useJobRunSession";

type LocIcon = { key: string; label: string; coverRelPath: string };

type GallerySplit = {
  view: LocationGalleryItem[];
  lighting: LocationGalleryItem[];
  hidden: LocationGalleryItem[];
  baseRelPath: string | null;
};

function truncateJobModalStatusLine(raw: string, maxLen = 120): string {
  const s = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}

export function TimelineLocationPicker(props: {
  open: boolean;
  initialKey?: string | null;
  onPickImage: (locationKey: string, relPath: string) => void;
  onCancel: () => void;
}) {
  const { open, onPickImage, onCancel } = props;
  const initialKey = props.initialKey ?? null;

  const [icons, setIcons] = useState<LocIcon[]>([]);
  const [iconsError, setIconsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [split, setSplit] = useState<GallerySplit | null>(null);
  const [sectionsError, setSectionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    item: LocationGalleryItem | null;
    relPath: string;
  }>({ open: false, x: 0, y: 0, item: null, relPath: "" });

  const [angleDialogOpen, setAngleDialogOpen] = useState(false);
  const angleInputRelPathRef = useRef<string | null>(null);

  const [aiOpen, setAiOpen] = useState(false);
  const [aiCtx, setAiCtx] = useState<LocationGalleryItem | null>(null);

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: jobBusy,
    beginSession,
    endSession,
    failSession,
    pushLog,
    setRunningStatus,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);

  const itemsByRelPath = useMemo(() => {
    const map = new Map<string, LocationGalleryItem>();
    if (!split) return map;
    for (const it of [...split.view, ...split.lighting, ...split.hidden]) {
      if (it.relPath) map.set(it.relPath, it);
    }
    return map;
  }, [split]);

  const hiddenIds = useMemo(
    () => new Set((split?.hidden ?? []).map((x) => x.itemId)),
    [split]
  );

  useEffect(() => {
    if (!open) return;
    setSplit(null);
    setSectionsError(null);
    setMenu((m) => ({ ...m, open: false }));
    setAngleDialogOpen(false);
    angleInputRelPathRef.current = null;
    setAiOpen(false);
    setAiCtx(null);
    setSelectedKey(initialKey ?? null);

    if (!initialKey) {
      setLoading(true);
      setIcons([]);
      setIconsError(null);
      apiLocationHubItems()
        .then((items) =>
          setIcons(
            items.map((it) => ({
              key: it.locationKey,
              label: it.locationKey,
              coverRelPath: it.coverRelPath,
            }))
          )
        )
        .catch((e) => setIconsError(String(e?.message ?? e)))
        .finally(() => setLoading(false));
    }
  }, [open, initialKey]);

  const loadSections = useCallback(async (locationKey: string) => {
    setLoading(true);
    setSplit(null);
    setSectionsError(null);
    try {
      const data = await apiLocationGallerySplit(locationKey);
      setSplit(data);
    } catch (e) {
      setSectionsError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !selectedKey) return;
    void loadSections(selectedKey);
  }, [open, selectedKey, loadSections]);

  const openContextMenu = useCallback(
    (relPath: string, x: number, y: number) => {
      const item = itemsByRelPath.get(relPath) ?? null;
      setMenu({ open: true, x, y, item, relPath });
    },
    [itemsByRelPath]
  );

  async function confirmAngles(angleId: number) {
    setAngleDialogOpen(false);
    const locationKey = selectedKey;
    const inputRelPath = angleInputRelPathRef.current;
    angleInputRelPathRef.current = null;
    if (!locationKey || !inputRelPath) return;

    beginSession({ title: "Generating location angles", clearLog: true });
    let sessionOk = false;
    try {
      await apiLocationGenerateAnglesStream({
        locationKey,
        angleIds: [angleId],
        inputRelPath,
        onLogLine: (line) => {
          pushLog(line);
          setRunningStatus(truncateJobModalStatusLine(line));
        },
      });
      await loadSections(locationKey);
      sessionOk = true;
    } catch (e) {
      failSession(e, "Angle generation failed");
    } finally {
      if (sessionOk) endSession();
    }
  }

  const menuItems: ContextMenuItem[] = useMemo(() => {
    const it = menu.item;
    const relPath = menu.relPath;
    const locationKey = selectedKey;
    if (!locationKey || !relPath) return [];

    const inHidden = it ? hiddenIds.has(it.itemId) : false;
    const hasGalleryItem = Boolean(it?.itemId);

    const items: ContextMenuItem[] = [
      {
        key: "newAngle",
        label: "New Angle",
        onSelect: () => {
          angleInputRelPathRef.current = relPath;
          setAngleDialogOpen(true);
        },
      },
      {
        key: "aiEdit",
        label: "AI Edit",
        onSelect: () => {
          setAiCtx(
            it ?? {
              itemId: "",
              folderKey: "view",
              relPath,
            }
          );
          setAiOpen(true);
        },
      },
    ];

    if (hasGalleryItem && it) {
      items.push(
        inHidden
          ? {
              key: "unhide",
              label: "Unhide",
              onSelect: () => {
                void apiLocationUnhide({ locationKey, itemIds: [it.itemId] }).then(() =>
                  loadSections(locationKey)
                );
              },
            }
          : {
              key: "hide",
              label: "Hide",
              onSelect: () => {
                void apiLocationHide({ locationKey, itemIds: [it.itemId] }).then(() =>
                  loadSections(locationKey)
                );
              },
            },
        {
          key: "delete",
          label: "Delete",
          onSelect: () => {
            void apiLocationDeleteItems({ locationKey, itemIds: [it.itemId] }).then(() =>
              loadSections(locationKey)
            );
          },
        }
      );
    }

    return items;
  }, [menu.item, menu.relPath, selectedKey, hiddenIds, loadSections]);

  if (!open) return null;

  const showBackButton = Boolean(selectedKey) && !initialKey;
  const locationKey = selectedKey ?? "";

  const baseImages = split?.baseRelPath
    ? [{ relPath: split.baseRelPath, caption: "Base" }]
    : [];
  const viewImages = (split?.view ?? []).map((x) => ({ relPath: x.relPath }));
  const lightingImages = (split?.lighting ?? []).map((x) => ({ relPath: x.relPath }));
  const hiddenImages = (split?.hidden ?? []).map((x) => ({ relPath: x.relPath }));

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          zIndex: 9998,
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
          style={{
            width: 720,
            maxWidth: "100%",
            height: "min(92vh, 880px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "#0b0b0b",
            color: "white",
            border: "1px solid rgba(255,255,255,0.25)",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontWeight: 400,
              padding: "10px 12px",
              borderBottom: "1px solid rgba(255,255,255,0.15)",
            }}
          >
            {showBackButton ? (
              <SquareIconButton
                aria-label="Back"
                title="Back"
                icon={<TriangleIcon direction="left" />}
                onClick={() => setSelectedKey(null)}
              />
            ) : null}
            <span>Add Location</span>
            {selectedKey ? (
              <span style={{ opacity: 0.55, fontSize: 13 }}>{selectedKey}</span>
            ) : null}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 12 }}>
            {!selectedKey ? (
              <>
                {iconsError ? (
                  <div style={{ color: "#ff8080", fontSize: 13 }}>{iconsError}</div>
                ) : null}
                {loading && icons.length === 0 ? (
                  <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>
                ) : null}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                    gap: 10,
                  }}
                >
                  {icons.map((ic) => (
                    <button
                      key={ic.key}
                      type="button"
                      onClick={() => setSelectedKey(ic.key)}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                        padding: 6,
                        border: "1px solid rgba(255,255,255,0.2)",
                        background: "transparent",
                        color: "inherit",
                        cursor: "pointer",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={assetUrlFromRelPath(ic.coverRelPath)}
                        alt=""
                        style={{
                          width: "100%",
                          aspectRatio: "1/1",
                          objectFit: "contain",
                          display: "block",
                        }}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          textAlign: "center",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {ic.label}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                {sectionsError ? (
                  <div style={{ color: "#ff8080", fontSize: 13 }}>{sectionsError}</div>
                ) : null}
                {loading && !split ? (
                  <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>
                ) : null}
                {split ? (
                  <>
                    {baseImages.length > 0 ? (
                      <CollapsibleGallerySection
                        title="Base"
                        images={baseImages}
                        defaultOpen
                        onPick={(relPath) => onPickImage(locationKey, relPath)}
                        onRightClick={openContextMenu}
                      />
                    ) : null}
                    <CollapsibleGallerySection
                      title="View"
                      images={viewImages}
                      defaultOpen
                      onPick={(relPath) => onPickImage(locationKey, relPath)}
                      onRightClick={openContextMenu}
                      emptyText="No view images"
                    />
                    <CollapsibleGallerySection
                      title="Lighting"
                      images={lightingImages}
                      defaultOpen
                      onPick={(relPath) => onPickImage(locationKey, relPath)}
                      onRightClick={openContextMenu}
                      emptyText="No lighting images"
                    />
                    <CollapsibleGallerySection
                      title="Hidden"
                      images={hiddenImages}
                      defaultOpen={false}
                      onPick={(relPath) => onPickImage(locationKey, relPath)}
                      onRightClick={openContextMenu}
                      emptyText="No hidden images"
                    />
                  </>
                ) : null}
              </>
            )}
          </div>

          <div
            style={{
              flexShrink: 0,
              display: "flex",
              justifyContent: "flex-end",
              padding: 12,
              borderTop: "1px solid rgba(255,255,255,0.15)",
            }}
          >
            <button type="button" onClick={onCancel} className="ui-btn-black">
              Cancel
            </button>
          </div>
        </div>
      </div>

      <DesktopContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menuItems}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />

      <CameraAngleModal
        open={angleDialogOpen}
        title="New Angle"
        imageUrl={
          angleInputRelPathRef.current
            ? assetUrlFromRelPath(angleInputRelPathRef.current)
            : null
        }
        onCancel={() => {
          setAngleDialogOpen(false);
          angleInputRelPathRef.current = null;
        }}
        onConfirm={(angleId) => void confirmAngles(angleId)}
      />

      <AiEditModal
        open={aiOpen}
        title="AI Edit"
        imageSrc={aiCtx ? assetUrlFromRelPath(aiCtx.relPath) : ""}
        busy={jobBusy}
        placeholder="Describe the edit (e.g. 'empty forest background' or 'add a bench')"
        onCancel={() => {
          setAiOpen(false);
          setAiCtx(null);
        }}
        onGenerate={async (promptText, maskPngBase64) => {
          const ctx = aiCtx;
          const locKey = selectedKey;
          if (!ctx || !locKey) return;
          const section = ctx.folderKey === "lighting" ? "lighting" : "view";
          setAiOpen(false);
          beginSession({ title: "AI Editing", clearLog: true, runningStatus: "AI editing…" });
          await Promise.resolve();
          pushLog("AI editing…");
          try {
            await apiLocationAiEdit({
              locationKey: locKey,
              section,
              sourceRelPath: ctx.relPath,
              promptText,
              maskPngBase64,
            });
            await loadSections(locKey);
            endSession();
          } catch (e) {
            failSession(e, "AI Edit failed.");
          } finally {
            setAiCtx(null);
          }
        }}
      />

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />
    </>
  );
}
