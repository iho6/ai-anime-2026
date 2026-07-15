"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  apiReferenceImages,
  apiReferenceKeypointsLayout,
  apiReferenceImageCommit,
  apiReferenceImagesReorder,
  apiReferenceKeypointsReorder,
  apiReferenceImageDelete,
  apiReferenceKeypointDelete,
  apiReferenceKeypointVideoDelete,
  assetUrlFromRelPath,
  assetDownloadUrlFromRelPath,
  runReferenceGenerateWsJob,
  runReferenceMakeKeypointWsJob,
  runReferenceMakeKeypointVideoWsJob,
  type GeneratedReferencePreview,
  type KeypointVideoReference,
  type ReferenceMediaKind,
  runReferenceMakeAngleWsJob,
  type ReferenceImageItem,
  type PoseReference,
} from "../../lib/api";
import {
  DesktopContextMenu,
  ContextMenuItem,
} from "../../components/DesktopContextMenu";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import { SquareButton } from "../../components/SquareButton";
import { ReferenceGenerateModal } from "../../components/ReferenceGenerateModal";
import { SortableGrid, SortableItem } from "../../components/dnd/SortableGrid";
import { reorderInsertBeforeOrAfter } from "../../components/dnd/reorder";
import { useJobRunSession } from "../../hooks/useJobRunSession";
import { ConnectedJobRunModal } from "../../components/ConnectedJobRunModal";
import type { SharedLogStreamHandle } from "../../components/SharedLogStream";
import { GalleryImageLightbox } from "../../components/GalleryImageLightbox";
import { CameraAngleModal } from "../../components/CameraAngleModal";
import { useAppError } from "../../components/ErrorProvider";

const TILE = 120;

export default function ReferencesPage() {
  const router = useRouter();
  const { showError, confirmAction } = useAppError();

  const [images, setImages] = useState<ReferenceImageItem[]>([]);
  const [keypoints, setKeypoints] = useState<PoseReference[]>([]);
  const [videoKeypoints, setVideoKeypoints] = useState<KeypointVideoReference[]>([]);
  const [imageOrder, setImageOrder] = useState<string[]>([]);
  const [keypointOrder, setKeypointOrder] = useState<string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [lightbox, setLightbox] = useState<{ paths: string[]; index: number } | null>(null);
  const [angleModalOpen, setAngleModalOpen] = useState(false);
  const [angleSourceRel, setAngleSourceRel] = useState<string | null>(null);

  const [menu, setMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    items: ContextMenuItem[];
  }>({ open: false, x: 0, y: 0, items: [] });

  const logRef = useRef<SharedLogStreamHandle>(null);
  const {
    running: jobRunning,
    beginSession,
    endSession,
    failSession,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);

  const refreshImages = useCallback(async () => {
    try {
      const items = await apiReferenceImages();
      setImages(items);
      setImageOrder(items.map((x) => x.itemId));
    } catch (e) {
      showError({ title: "References", message: "Could not load reference images.", error: e });
    }
  }, [showError]);

  const refreshKeypoints = useCallback(async () => {
    try {
      const layout = await apiReferenceKeypointsLayout();
      setKeypoints(layout.items);
      setVideoKeypoints(layout.videoItems ?? []);
      setKeypointOrder(layout.items.map((x) => x.id));
    } catch (e) {
      showError({ title: "References", message: "Could not load keypoint poses.", error: e });
    }
  }, [showError]);

  useEffect(() => {
    void refreshImages();
    void refreshKeypoints();
  }, [refreshImages, refreshKeypoints]);

  function downloadRelPath(relPath: string | undefined) {
    if (!relPath) return;
    const a = document.createElement("a");
    a.href = assetDownloadUrlFromRelPath(relPath);
    a.download = relPath.split("/").pop() ?? "image.png";
    a.click();
  }

  const onGenerate = useCallback(
    async (args: {
      kind: ReferenceMediaKind;
      promptText: string;
      width: number;
      height: number;
    }) => {
      beginSession({ title: "Generating reference", clearLog: true });
      try {
        const done = await runReferenceGenerateWsJob({
          ...args,
          onLogLine: (line) => logRef.current?.pushLine(line),
        });
        if (!done.ok || !done.result) {
          throw new Error(done.error ?? "Generation failed");
        }
        endSession();
        return done.result;
      } catch (e) {
        failSession(e, "Reference generation failed.");
        return null;
      }
    },
    [beginSession, endSession, failSession]
  );

  const onCommit = useCallback(
    async (preview: GeneratedReferencePreview) => {
      try {
        if (preview.kind === "video") {
          beginSession({ title: "Making video keypoint reference", clearLog: true });
          const done = await runReferenceMakeKeypointVideoWsJob({
            videoRelPath: preview.previewRelPath,
            fps: preview.fps,
            onLogLine: (line) => logRef.current?.pushLine(line),
          });
          if (!done.ok || !done.result) {
            throw new Error(done.error ?? "Video keypoint generation failed");
          }
          endSession();
          await refreshKeypoints();
        } else {
          await apiReferenceImageCommit(preview.previewRelPath);
          await refreshImages();
        }
        setModalOpen(false);
      } catch (e) {
        if (preview.kind === "video") {
          failSession(e, "Could not save video keypoint reference.");
        } else {
          showError({ title: "References", message: "Could not save reference image.", error: e });
        }
      }
    },
    [beginSession, endSession, failSession, refreshImages, refreshKeypoints, showError]
  );

  const makeKeypoint = useCallback(
    async (relPath: string) => {
      beginSession({ title: "Making keypoint pose", clearLog: true });
      try {
        const done = await runReferenceMakeKeypointWsJob({
          imageRelPath: relPath,
          onLogLine: (line) => logRef.current?.pushLine(line),
        });
        if (!done.ok) throw new Error(done.error ?? "Keypoint generation failed");
        endSession();
        await refreshKeypoints();
      } catch (e) {
        failSession(e, "Keypoint generation failed.");
      }
    },
    [beginSession, endSession, failSession, refreshKeypoints]
  );

  const runAngles = useCallback(
    async (relPath: string, angleIds: number[]) => {
      if (angleIds.length === 0) return;
      beginSession({ title: "Generating new angle", clearLog: true });
      try {
        for (const angleId of angleIds) {
          const done = await runReferenceMakeAngleWsJob({
            imageRelPath: relPath,
            angleId,
            onLogLine: (line) => logRef.current?.pushLine(line),
          });
          if (!done.ok) throw new Error(done.error ?? "Angle generation failed");
        }
        endSession();
        await refreshImages();
      } catch (e) {
        failSession(e, "Angle generation failed.");
      }
    },
    [beginSession, endSession, failSession, refreshImages]
  );

  const openAngleModal = useCallback((relPath: string) => {
    setAngleSourceRel(relPath);
    setAngleModalOpen(true);
  }, []);

  function openImageMenu(e: React.MouseEvent, item: ReferenceImageItem) {
    e.preventDefault();
    setMenu({
      open: true,
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: "make_keypoint",
          label: "Make Keypoint Pose",
          onSelect: () => void makeKeypoint(item.relPath),
        },
        {
          key: "new_angle",
          label: "New Angle",
          onSelect: () => void openAngleModal(item.relPath),
        },
        {
          key: "download",
          label: "Download",
          onSelect: () => downloadRelPath(item.relPath),
        },
        {
          key: "delete",
          label: "Delete",
          onSelect: () =>
            void (async () => {
              const ok = await confirmAction({
                title: "Delete image",
                message: "Delete this reference image?",
                confirmText: "Delete",
              });
              if (!ok) return;
              await apiReferenceImageDelete(item.itemId);
              await refreshImages();
            })(),
        },
      ],
    });
  }

  function openKeypointMenu(e: React.MouseEvent, item: PoseReference) {
    e.preventDefault();
    setMenu({
      open: true,
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: "download",
          label: "Download",
          onSelect: () => downloadRelPath(item.keypointRelPath),
        },
        {
          key: "delete",
          label: "Delete",
          onSelect: () =>
            void (async () => {
              const ok = await confirmAction({
                title: "Delete keypoint pose",
                message: "Delete this keypoint pose pair?",
                confirmText: "Delete",
              });
              if (!ok) return;
              await apiReferenceKeypointDelete(item.id);
              await refreshKeypoints();
            })(),
        },
      ],
    });
  }

  function openVideoKeypointMenu(e: React.MouseEvent, item: KeypointVideoReference) {
    e.preventDefault();
    setMenu({
      open: true,
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          key: "download",
          label: "Download",
          onSelect: () => downloadRelPath(item.videoRelPath),
        },
        {
          key: "delete",
          label: "Delete",
          onSelect: () =>
            void (async () => {
              const ok = await confirmAction({
                title: "Delete video keypoint reference",
                message: "Delete this video and its generated keypoint frames?",
                confirmText: "Delete",
              });
              if (!ok) return;
              await apiReferenceKeypointVideoDelete(item.id);
              await refreshKeypoints();
            })(),
        },
      ],
    });
  }

  const imageById = new Map(images.map((x) => [x.itemId, x]));
  const keypointById = new Map(keypoints.map((x) => [x.id, x]));

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

      <div style={{ paddingLeft: 20, paddingRight: 20, maxWidth: 980 }}>
        <div style={{ marginBottom: 16 }}>
          <SquareButton
            variant="tile"
            tone="dark"
            size={TILE}
            onClick={() => setModalOpen(true)}
          >
            New Reference
          </SquareButton>
        </div>

        {/* Image section */}
        <div style={{ marginTop: 8, marginBottom: 8, fontWeight: 400 }}>Image</div>
        <SortableGrid
          ids={imageOrder}
          renderItem={(id) => {
            const it = imageById.get(id);
            if (!it) return null;
            return (
              <SortableItem id={id} style={{ width: TILE }}>
                <ReferenceTile
                  src={assetUrlFromRelPath(it.relPath)}
                  onPrimary={() => {
                    const paths = imageOrder
                      .map((iid) => imageById.get(iid))
                      .filter((x): x is ReferenceImageItem => !!x)
                      .map((x) => assetUrlFromRelPath(x.relPath));
                    const idx = imageOrder.indexOf(id);
                    setLightbox({ paths, index: idx < 0 ? 0 : idx });
                  }}
                  onContextMenu={(e) => openImageMenu(e, it)}
                />
              </SortableItem>
            );
          }}
          overlay={(id) => {
            const it = imageById.get(id);
            if (!it) return null;
            return (
              <div style={{ width: TILE, cursor: "grabbing" }}>
                <ReferenceTile src={assetUrlFromRelPath(it.relPath)} />
              </div>
            );
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}
          onDragEnd={({ activeId, overId, insertAfter }) => {
            const r = reorderInsertBeforeOrAfter({
              activeId,
              overId,
              insertAfter,
              sourceContainerId: "c",
              targetContainerId: "c",
              containers: { c: imageOrder },
              selectedIds: new Set(),
            });
            const next = r.containers.c ?? [];
            setImageOrder(next);
            void apiReferenceImagesReorder(next).catch(() => {});
          }}
        />

        {videoKeypoints.length > 0 && (
          <>
            <div style={{ marginTop: 8, marginBottom: 8, fontWeight: 400 }}>
              Video Keypoint
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {videoKeypoints.map((item) => (
                <video
                  key={item.id}
                  src={assetUrlFromRelPath(item.videoRelPath)}
                  controls
                  muted
                  loop
                  playsInline
                  onContextMenu={(e) => openVideoKeypointMenu(e, item)}
                  style={{
                    width: TILE,
                    height: TILE,
                    objectFit: "cover",
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "#000",
                  }}
                />
              ))}
            </div>
          </>
        )}

        {/* Keypoint Pose section */}
        <div style={{ marginTop: 8, marginBottom: 8, fontWeight: 400 }}>Keypoint Pose</div>
        <SortableGrid
          ids={keypointOrder}
          renderItem={(id) => {
            const it = keypointById.get(id);
            if (!it) return null;
            return (
              <SortableItem id={id} style={{ width: TILE }}>
                <ReferenceTile
                  src={assetUrlFromRelPath(it.keypointRelPath)}
                  onPrimary={() => {
                    const paths = keypointOrder
                      .map((kid) => keypointById.get(kid))
                      .filter((x): x is PoseReference => !!x)
                      .map((x) => assetUrlFromRelPath(x.keypointRelPath));
                    const idx = keypointOrder.indexOf(id);
                    setLightbox({ paths, index: idx < 0 ? 0 : idx });
                  }}
                  onContextMenu={(e) => openKeypointMenu(e, it)}
                />
              </SortableItem>
            );
          }}
          overlay={(id) => {
            const it = keypointById.get(id);
            if (!it) return null;
            return (
              <div style={{ width: TILE, cursor: "grabbing" }}>
                <ReferenceTile src={assetUrlFromRelPath(it.keypointRelPath)} />
              </div>
            );
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}
          onDragEnd={({ activeId, overId, insertAfter }) => {
            const r = reorderInsertBeforeOrAfter({
              activeId,
              overId,
              insertAfter,
              sourceContainerId: "c",
              targetContainerId: "c",
              containers: { c: keypointOrder },
              selectedIds: new Set(),
            });
            const next = r.containers.c ?? [];
            setKeypointOrder(next);
            void apiReferenceKeypointsReorder(next).catch(() => {});
          }}
        />
      </div>

      <ReferenceGenerateModal
        open={modalOpen}
        busy={jobRunning}
        saveLabel={(preview) =>
          preview.kind === "video" ? "Save as Video Keypoint" : "Save"
        }
        onCancel={() => setModalOpen(false)}
        onGenerate={onGenerate}
        onCommit={onCommit}
      />

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />

      <DesktopContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menu.items}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />

      <CameraAngleModal
        open={angleModalOpen}
        title="New Angle"
        imageUrl={angleSourceRel ? assetUrlFromRelPath(angleSourceRel) : null}
        onCancel={() => setAngleModalOpen(false)}
        onConfirm={(angleId) => {
          setAngleModalOpen(false);
          const rel = angleSourceRel;
          if (rel) void runAngles(rel, [angleId]);
        }}
      />

      {lightbox ? (
        <GalleryImageLightbox
          paths={lightbox.paths}
          index={lightbox.index}
          title="Reference preview"
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}

function ReferenceTile(props: {
  src: string;
  onPrimary?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { src, onPrimary, onContextMenu } = props;
  return (
    <div style={{ width: TILE, height: TILE, position: "relative" }}>
      <button
        type="button"
        onClick={onPrimary}
        onContextMenu={onContextMenu}
        className="gallery-cover-btn"
        style={{
          width: TILE,
          height: TILE,
          padding: 0,
          border: "1px solid rgba(0,0,0,0.5)",
          background: "rgba(0,0,0,0.2)",
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          className="gallery-cover-img"
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      </button>
    </div>
  );
}
