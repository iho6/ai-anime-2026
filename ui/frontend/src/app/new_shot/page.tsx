"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  runShotCreateWsJob,
  runShotRemoveBgWsJob,
  runShotMakeAngleWsJob,
  assetUrlFromRelPath,
  ShotLayerMeta,
} from "../../lib/api";
import { CameraAngleModal } from "../../components/CameraAngleModal";
import {
  DesktopContextMenu,
  ContextMenuItem,
} from "../../components/DesktopContextMenu";
import {
  HomeIcon,
  SquareIconButton,
  TriangleIcon,
} from "../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import type { SharedLogStreamHandle } from "../../components/SharedLogStream";
import { ConnectedJobRunModal } from "../../components/ConnectedJobRunModal";
import { useJobRunSession } from "../../hooks/useJobRunSession";
import { useAppError } from "../../components/ErrorProvider";
import {
  ShotComposer,
  ShotBackdrop,
  ShotCharacter,
  buildCompositePngBase64,
  defaultCharacterPlacement,
  loadImageMeta,
} from "../../components/ShotComposer";
import { ShotBackdropPicker } from "../../components/ShotBackdropPicker";
import { ShotCharacterPicker } from "../../components/ShotCharacterPicker";

let charIdSeq = 0;
function nextCharId(): string {
  charIdSeq += 1;
  return `char_${Date.now()}_${charIdSeq}`;
}

const actionButtonStyle: React.CSSProperties = {
  borderRadius: 0,
  border: "1px solid rgba(0,0,0,0.5)",
  background: "transparent",
  padding: "8px 12px",
  cursor: "pointer",
  font: "inherit",
};

export default function NewShotPage() {
  const router = useRouter();
  const { showError } = useAppError();

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: busy,
    beginSession,
    endSession,
    failSession,
    pushLog,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);

  const [backdrop, setBackdrop] = useState<ShotBackdrop | null>(null);
  const [locationKey, setLocationKey] = useState<string | null>(null);
  const [characters, setCharacters] = useState<ShotCharacter[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [shotName, setShotName] = useState("");

  const [backdropPickerOpen, setBackdropPickerOpen] = useState(false);
  const [characterPickerOpen, setCharacterPickerOpen] = useState(false);

  // Change-View flow: when set, the character picker is scoped to one layer.
  const [changeViewId, setChangeViewId] = useState<string | null>(null);
  const changeViewChar = useMemo(
    () => characters.find((c) => c.id === changeViewId) ?? null,
    [characters, changeViewId]
  );

  // Right-click context menu over a character layer.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuX, setMenuX] = useState(0);
  const [menuY, setMenuY] = useState(0);
  const [menuCharId, setMenuCharId] = useState<string | null>(null);

  // Right-click context menu over the backdrop.
  const [backdropMenuOpen, setBackdropMenuOpen] = useState(false);
  const [backdropMenuX, setBackdropMenuX] = useState(0);
  const [backdropMenuY, setBackdropMenuY] = useState(0);

  // Camera "New Angle" modal — targets a single layer (character or backdrop).
  const [cameraAngleOpen, setCameraAngleOpen] = useState(false);
  const [cameraAngleImageUrl, setCameraAngleImageUrl] = useState<string | null>(
    null
  );
  // ``char:<id>`` for a character layer, or ``backdrop`` for the backdrop.
  const cameraAngleTargetRef = useRef<string | null>(null);

  const onRequestBackdropMenu = useCallback(
    (clientX: number, clientY: number) => {
      setBackdropMenuX(clientX);
      setBackdropMenuY(clientY);
      setBackdropMenuOpen(true);
    },
    []
  );

  const onMoveCharacter = useCallback((id: string, x: number, y: number) => {
    setCharacters((prev) =>
      prev.map((c) => (c.id === id ? { ...c, x, y } : c))
    );
  }, []);

  const onScaleCharacter = useCallback((id: string, scale: number) => {
    setCharacters((prev) =>
      prev.map((c) => (c.id === id ? { ...c, scale } : c))
    );
  }, []);

  const onRequestChangeView = useCallback(
    (id: string, clientX: number, clientY: number) => {
      setMenuCharId(id);
      setMenuX(clientX);
      setMenuY(clientY);
      setMenuOpen(true);
    },
    []
  );

  const menuChar = useMemo(
    () => characters.find((c) => c.id === menuCharId) ?? null,
    [characters, menuCharId]
  );

  const menuItems: ContextMenuItem[] = useMemo(() => {
    const id = menuCharId;
    return [
      {
        key: "change_view",
        label: "Change View",
        disabled: !id,
        onSelect: () => {
          if (!id) return;
          setChangeViewId(id);
          setCharacterPickerOpen(true);
        },
      },
      {
        key: "new_angle",
        label: "New Angle",
        disabled: !id || busy,
        onSelect: () => {
          if (!id) return;
          openCharacterAngle(id);
        },
      },
      {
        key: "remove_bg",
        label: "Remove Background",
        disabled: !id || busy,
        onSelect: () => {
          if (!id) return;
          void removeBackgroundForChar(id);
        },
      },
      {
        key: "restore_bg",
        label: "Restore Background",
        disabled: !id || !menuChar?.originalImageRelPath || busy,
        onSelect: () => {
          if (!id) return;
          void restoreBackgroundForChar(id);
        },
      },
      {
        key: "remove",
        label: "Remove Character",
        disabled: !id,
        onSelect: () => {
          if (!id) return;
          setCharacters((prev) => prev.filter((c) => c.id !== id));
          setSelectedId((s) => (s === id ? null : s));
        },
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuCharId, menuChar, busy]);

  async function onPickBackdrop(locKey: string, relPath: string) {
    setBackdropPickerOpen(false);
    try {
      const { naturalW, naturalH } = await loadImageMeta(relPath);
      setBackdrop({ relPath, naturalW, naturalH });
      setLocationKey(locKey);
    } catch (e) {
      showError({ message: "Could not load backdrop image.", error: e });
    }
  }

  async function onPickCharacter(charKey: string, relPath: string) {
    setCharacterPickerOpen(false);
    const swapId = changeViewId;
    setChangeViewId(null);
    if (!backdrop) {
      showError({ message: "Add a backdrop first." });
      return;
    }
    try {
      const { naturalW, naturalH } = await loadImageMeta(relPath);
      if (swapId) {
        // Change View: swap image in place, keep x/y/scale, re-measure size.
        // A fresh image drops any prior background-removal history.
        setCharacters((prev) =>
          prev.map((c) =>
            c.id === swapId
              ? {
                  ...c,
                  charKey,
                  imageRelPath: relPath,
                  naturalW,
                  naturalH,
                  originalImageRelPath: undefined,
                }
              : c
          )
        );
      } else {
        const placement = defaultCharacterPlacement(backdrop, naturalW, naturalH);
        const id = nextCharId();
        setCharacters((prev) => [
          ...prev,
          {
            id,
            charKey,
            imageRelPath: relPath,
            naturalW,
            naturalH,
            ...placement,
          },
        ]);
        setSelectedId(id);
      }
    } catch (e) {
      showError({ message: "Could not load character image.", error: e });
    }
  }

  async function removeBackgroundForChar(id: string) {
    const layer = characters.find((c) => c.id === id);
    if (!layer) return;
    beginSession({ title: "Removing background", clearLog: true });
    await Promise.resolve();
    pushLog("Removing character background…");
    try {
      const done = await runShotRemoveBgWsJob({
        imageRelPath: layer.imageRelPath,
        onLogLine: (line) => pushLog(line),
      });
      const newRel = done.result?.relPath;
      if (!done.ok || !newRel) {
        throw new Error(done.error || "Background removal returned no image.");
      }
      const { naturalW, naturalH } = await loadImageMeta(newRel);
      setCharacters((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                imageRelPath: newRel,
                naturalW,
                naturalH,
                originalImageRelPath: c.originalImageRelPath ?? c.imageRelPath,
              }
            : c
        )
      );
      endSession();
    } catch (e) {
      failSession(e, "Could not remove background.");
    }
  }

  async function restoreBackgroundForChar(id: string) {
    const layer = characters.find((c) => c.id === id);
    if (!layer || !layer.originalImageRelPath) return;
    const original = layer.originalImageRelPath;
    try {
      const { naturalW, naturalH } = await loadImageMeta(original);
      setCharacters((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                imageRelPath: original,
                naturalW,
                naturalH,
                originalImageRelPath: undefined,
              }
            : c
        )
      );
    } catch (e) {
      showError({ message: "Could not restore background.", error: e });
    }
  }

  function openCharacterAngle(id: string) {
    const layer = characters.find((c) => c.id === id);
    if (!layer) return;
    cameraAngleTargetRef.current = `char:${id}`;
    setCameraAngleImageUrl(assetUrlFromRelPath(layer.imageRelPath));
    setCameraAngleOpen(true);
  }

  function openBackdropAngle() {
    if (!backdrop) return;
    cameraAngleTargetRef.current = "backdrop";
    setCameraAngleImageUrl(assetUrlFromRelPath(backdrop.relPath));
    setCameraAngleOpen(true);
  }

  async function applyAngle(angleId: number) {
    const target = cameraAngleTargetRef.current;
    setCameraAngleOpen(false);
    if (!target) return;

    if (target === "backdrop") {
      if (!backdrop) return;
      beginSession({ title: "Generating new angle", clearLog: true });
      await Promise.resolve();
      pushLog("Generating a new camera angle for the backdrop…");
      try {
        const done = await runShotMakeAngleWsJob({
          imageRelPath: backdrop.relPath,
          angleId,
          onLogLine: (line) => pushLog(line),
        });
        const newRel = done.result?.relPath;
        if (!done.ok || !newRel) {
          throw new Error(done.error || "Angle generation returned no image.");
        }
        const { naturalW, naturalH } = await loadImageMeta(newRel);
        setBackdrop({ relPath: newRel, naturalW, naturalH });
        endSession();
      } catch (e) {
        failSession(e, "Could not generate a new angle.");
      }
      return;
    }

    const id = target.startsWith("char:") ? target.slice(5) : null;
    if (!id) return;
    const layer = characters.find((c) => c.id === id);
    if (!layer) return;
    beginSession({ title: "Generating new angle", clearLog: true });
    await Promise.resolve();
    pushLog("Generating a new camera angle for the character…");
    try {
      const done = await runShotMakeAngleWsJob({
        imageRelPath: layer.imageRelPath,
        angleId,
        onLogLine: (line) => pushLog(line),
      });
      const newRel = done.result?.relPath;
      if (!done.ok || !newRel) {
        throw new Error(done.error || "Angle generation returned no image.");
      }
      const { naturalW, naturalH } = await loadImageMeta(newRel);
      setCharacters((prev) =>
        prev.map((c) =>
          c.id === id
            ? { ...c, imageRelPath: newRel, naturalW, naturalH }
            : c
        )
      );
      endSession();
    } catch (e) {
      failSession(e, "Could not generate a new angle.");
    }
  }

  async function runShot(mode: "i2i" | "as_is") {
    if (!backdrop) {
      showError({ message: "Add a backdrop first." });
      return;
    }
    beginSession({
      title: mode === "as_is" ? "Saving scene" : "Editing scene",
      clearLog: true,
    });
    await Promise.resolve();
    pushLog("Flattening composite…");

    let compositePngBase64: string;
    try {
      compositePngBase64 = await buildCompositePngBase64(backdrop, characters);
    } catch (e) {
      failSession(e, "Could not build the composite image.");
      return;
    }

    const layers: ShotLayerMeta[] = characters.map((c) => ({
      charKey: c.charKey,
      imageRelPath: c.imageRelPath,
      x: c.x,
      y: c.y,
      scale: c.scale,
    }));

    pushLog(
      mode === "as_is"
        ? "Saving the overlay as the shot…"
        : "Starting generation (live logs from image service)…"
    );
    try {
      const done = await runShotCreateWsJob({
        shotName: shotName.trim(),
        locationKey,
        locationImageRelPath: backdrop.relPath,
        characters: layers,
        compositePngBase64,
        promptText: mode === "as_is" ? "" : prompt.trim(),
        mode,
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.shotKey) {
        throw new Error(done.error || "Shot was not created.");
      }
    } catch (e) {
      failSession(e, mode === "as_is" ? "Saving scene failed." : "Scene edit failed.");
      return;
    }
    endSession();
    router.push("/shot_hub");
  }

  return (
    <div style={{ minHeight: "100vh" }}>
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
          onClick={() => router.push("/shot_hub")}
          aria-label="Back"
          icon={<TriangleIcon direction="left" />}
        />
      </div>

      <div style={{ paddingLeft: 20, paddingRight: 20, maxWidth: 980 }}>
        <ShotComposer
          backdrop={backdrop}
          characters={characters}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMoveCharacter={onMoveCharacter}
          onScaleCharacter={onScaleCharacter}
          onRequestChangeView={onRequestChangeView}
          onRequestBackdropMenu={onRequestBackdropMenu}
          height={420}
        />

        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => setBackdropPickerOpen(true)}
            style={{ ...actionButtonStyle, opacity: busy ? 0.7 : 1 }}
          >
            Add Backdrop
          </button>
          <button
            type="button"
            disabled={busy || !backdrop}
            onClick={() => {
              setChangeViewId(null);
              setCharacterPickerOpen(true);
            }}
            title={!backdrop ? "Add a backdrop first" : undefined}
            style={{
              ...actionButtonStyle,
              cursor: busy || !backdrop ? "not-allowed" : "pointer",
              opacity: busy || !backdrop ? 0.5 : 1,
            }}
          >
            Add Character
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <input
            value={shotName}
            onChange={(e) => setShotName(e.target.value)}
            placeholder="Shot name (optional)"
            style={{
              width: "100%",
              padding: "10px 12px",
              border: "1px solid rgba(0,0,0,0.35)",
              background: "transparent",
              color: "inherit",
              marginBottom: 10,
            }}
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe details of the scene"
            rows={4}
            style={{
              width: "100%",
              minHeight: 100,
              padding: "10px 12px",
              border: "1px solid rgba(0,0,0,0.35)",
              background: "transparent",
              color: "inherit",
              resize: "vertical",
              boxSizing: "border-box",
              font: "inherit",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: 14 }}>
          <button
            type="button"
            disabled={busy || !backdrop}
            onClick={(e) => {
              e.preventDefault();
              void runShot("i2i");
            }}
            title={!backdrop ? "Add a backdrop first" : undefined}
            style={{
              ...actionButtonStyle,
              cursor: busy || !backdrop ? "not-allowed" : "pointer",
              opacity: busy || !backdrop ? 0.5 : 1,
            }}
          >
            I2I Edit Scene
          </button>
          <button
            type="button"
            disabled={busy || !backdrop}
            onClick={(e) => {
              e.preventDefault();
              void runShot("as_is");
            }}
            title={!backdrop ? "Add a backdrop first" : undefined}
            style={{
              ...actionButtonStyle,
              cursor: busy || !backdrop ? "not-allowed" : "pointer",
              opacity: busy || !backdrop ? 0.5 : 1,
            }}
          >
            Save Scene As Is
          </button>
        </div>
      </div>

      <ShotBackdropPicker
        open={backdropPickerOpen}
        onPick={onPickBackdrop}
        onCancel={() => setBackdropPickerOpen(false)}
      />

      <ShotCharacterPicker
        open={characterPickerOpen}
        initialKey={changeViewChar?.charKey ?? null}
        onPick={onPickCharacter}
        onCancel={() => {
          setCharacterPickerOpen(false);
          setChangeViewId(null);
        }}
      />

      <DesktopContextMenu
        open={menuOpen}
        x={menuX}
        y={menuY}
        items={menuItems}
        onClose={() => setMenuOpen(false)}
      />

      <DesktopContextMenu
        open={backdropMenuOpen}
        x={backdropMenuX}
        y={backdropMenuY}
        items={[
          {
            key: "backdrop_new_angle",
            label: "New Angle",
            disabled: !backdrop || busy,
            onSelect: () => openBackdropAngle(),
          },
        ]}
        onClose={() => setBackdropMenuOpen(false)}
      />

      <CameraAngleModal
        open={cameraAngleOpen}
        title="New Angle"
        imageUrl={cameraAngleImageUrl}
        onCancel={() => setCameraAngleOpen(false)}
        onConfirm={(angleId) => void applyAngle(angleId)}
      />

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />
    </div>
  );
}
