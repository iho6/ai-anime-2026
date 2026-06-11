"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  apiHubCover,
  apiHubDelete,
  apiHubEnsureCover,
  apiHubRename,
  assetUrlFromRelPath,
} from "../../../lib/api";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../../components/HfTokenSettingsButton";
import { CharacterNameTag } from "../../../components/CharacterNameTag";
import { SquareButton } from "../../../components/SquareButton";
import { StartingImagePreview } from "../../../components/StartingImagePreview";
import { useAppError } from "../../../components/ErrorProvider";
import { BaseCloseupWizardModal } from "../../../components/BaseCloseupWizardModal";

const TILE = 140;
const RAIL_GAP = 12;
const BUTTON_ROW_MARGIN_TOP = 10;
const BUTTON_H = 34;
// The rail now starts at the same top edge as the name tag (grid row 1),
// so the preview height must exclude the (single-line) name-tag height too.
// If the name wraps to multiple lines, perfect bottom-alignment is not guaranteed.
const NAME_TAG_H = 26;
const PREVIEW_H =
  3 * TILE + 2 * RAIL_GAP - NAME_TAG_H - BUTTON_ROW_MARGIN_TOP - BUTTON_H;

export default function DetailGatePage() {
  const router = useRouter();
  const { showError, askText, confirmAction } = useAppError();
  const params = useParams<{ charKey: string }>();
  const charKey = params?.charKey ?? "";

  const [detailPreviewRelPath, setDetailPreviewRelPath] = useState<string>("");
  const [coverVersion, setCoverVersion] = useState<number>(0);
  const [closeupWizardOpen, setCloseupWizardOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");

  useEffect(() => {
    if (!charKey) return;
    apiHubCover(charKey)
      .then((c) => {
        setDetailPreviewRelPath(c.detailPreviewRelPath);
        setCoverVersion((v) => v + 1);
      })
      .catch(async () => {
        try {
          await apiHubEnsureCover(charKey);
          const c = await apiHubCover(charKey);
          setDetailPreviewRelPath(c.detailPreviewRelPath);
          setCoverVersion((v) => v + 1);
        } catch {
          setDetailPreviewRelPath("");
        }
      });
  }, [charKey]);

  const refreshDetailPreview = useCallback(async () => {
    if (!charKey) return;
    const c = await apiHubCover(charKey);
    setDetailPreviewRelPath(c.detailPreviewRelPath);
    setCoverVersion((v) => v + 1);
  }, [charKey]);

  const tiles = useMemo(() => {
    return [
      {
        key: "create",
        label: (
          <span style={{ lineHeight: 1.35 }}>
            Pose
            <br />
            Expression
            <br />
            Animation
          </span>
        ),
        href: `/detail/${encodeURIComponent(charKey)}/create`,
      },
      {
        key: "dataset",
        label: "Build Dataset and Sequence",
        href: `/detail/${encodeURIComponent(charKey)}/dataset`,
      },
    ];
  }, [charKey]);

  const btnBase: React.CSSProperties = {
    flex: "1 1 auto",
    minWidth: 0,
    borderRadius: 0,
    border: "1px solid rgba(0,0,0,0.5)",
    background: "transparent",
    padding: "6px 10px",
    cursor: "pointer",
    fontSize: 13,
    height: BUTTON_H,
  };

  async function commitInlineRename() {
    const next = (draftName || "").trim();
    if (!next) {
      setEditingName(false);
      setDraftName("");
      return;
    }
    if (next === charKey) {
      setEditingName(false);
      setDraftName("");
      return;
    }
    try {
      const r = await apiHubRename(charKey, next);
      setEditingName(false);
      setDraftName("");
      router.push(`/detail/${encodeURIComponent(r.newCharKey)}`);
    } catch (e) {
      showError({ message: "Rename failed.", error: e });
      // Keep editing so user can adjust.
    }
  }

  async function renameCharacter() {
    const nn = await askText({
      title: "Rename Character",
      message: "New name:",
      defaultValue: charKey,
      confirmText: "Rename",
    });
    if (!nn?.trim()) return;
    apiHubRename(charKey, nn)
      .then((r) => router.push(`/detail/${encodeURIComponent(r.newCharKey)}`))
      .catch((e) => showError({ message: "Rename failed.", error: e }));
  }

  return (
    <div style={{ paddingBottom: 96, minHeight: "100vh" }}>
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
          onClick={() => router.push("/hub")}
          aria-label="Back"
          icon={<TriangleIcon direction="left" />}
        />
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          paddingLeft: 20,
          paddingRight: 20,
          boxSizing: "border-box",
          width: "100%",
          maxWidth: "100%",
          transform: "translateX(-6px)",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `minmax(0, min(840px, calc(100vw - 230px))) ${TILE}px`,
            gridTemplateRows: `auto ${PREVIEW_H}px auto`,
            columnGap: 18,
            rowGap: 0,
            alignItems: "start",
            maxWidth: "100%",
          }}
        >
          <div style={{ gridColumn: 1, gridRow: 1, minWidth: 0, width: "100%" }}>
            <CharacterNameTag
              variant="preview"
              text={charKey}
              title="Double-click to rename"
              onRequestEdit={() => {
                setEditingName(true);
                setDraftName(charKey);
              }}
              editing={editingName}
              value={editingName ? draftName : charKey}
              onChange={(v) => setDraftName(v)}
              onBlur={() => void commitInlineRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.currentTarget as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingName(false);
                  setDraftName("");
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
            />
          </div>

          <div
            style={{
              gridColumn: 1,
              gridRow: 2,
              width: "100%",
              height: PREVIEW_H,
              minHeight: 0,
              border: "1px dashed rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "stretch",
              justifyContent: "center",
              position: "relative",
              overflow: "hidden",
              boxSizing: "border-box",
            }}
          >
            {detailPreviewRelPath ? (
              <StartingImagePreview
                key={detailPreviewRelPath}
                hideControls
                storageRelPath={detailPreviewRelPath}
                imageSrc={`${assetUrlFromRelPath(detailPreviewRelPath)}?v=${coverVersion}`}
                stackLength={1}
                stackIndex={0}
                onPrev={() => {}}
                onNext={() => {}}
                onDeleteCacheEntry={() => {}}
                onImageError={() => {}}
              />
            ) : (
              <div
                style={{
                  opacity: 0.75,
                  fontSize: 14,
                  alignSelf: "center",
                }}
              >
                No preview
              </div>
            )}
          </div>

          <div
            style={{
              gridColumn: 1,
              gridRow: 3,
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "stretch",
              marginTop: 10,
            }}
          >
            <button
              type="button"
              onClick={() => void renameCharacter()}
              style={{ ...btnBase, whiteSpace: "nowrap" }}
            >
              Rename Character
            </button>
            <button
              type="button"
              onClick={() => setCloseupWizardOpen(true)}
              style={{ ...btnBase, whiteSpace: "nowrap" }}
            >
              Regenerate Closeup
            </button>
            <button
              type="button"
              onClick={async () => {
                const msg = `Delete character “${charKey}” and all of its files? This cannot be undone.`;
                const ok = await confirmAction({
                  title: "Delete Character",
                  message: msg,
                  confirmText: "Delete",
                });
                if (!ok) return;
                apiHubDelete(charKey)
                  .then(() => router.push("/hub"))
                  .catch((e) => showError({ message: "Delete failed.", error: e }));
              }}
              className="ui-btn-black"
              style={{ whiteSpace: "nowrap", height: BUTTON_H }}
            >
              Delete Character
            </button>
          </div>

          <div
            style={{
              gridColumn: 2,
              gridRow: "1 / span 3",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              alignSelf: "start",
            }}
          >
            {tiles.map((t) => (
              <SquareButton
                key={t.key}
                onClick={() => router.push(t.href)}
                variant="tile"
                tone="dark"
                style={{
                  width: TILE,
                  height: TILE,
                  textAlign: "center",
                  color: "inherit",
                  flexShrink: 0,
                }}
              >
                {t.label}
              </SquareButton>
            ))}
          </div>
        </div>
      </div>

      <BaseCloseupWizardModal
        open={closeupWizardOpen}
        charKey={charKey}
        title="Regenerate Closeup Angles"
        onClose={async () => {
          setCloseupWizardOpen(false);
          try {
            await refreshDetailPreview();
          } catch {
            /* preview may still be full-body if nothing was generated */
          }
        }}
        onDone={async () => {
          setCloseupWizardOpen(false);
          await refreshDetailPreview();
        }}
      />
    </div>
  );
}
