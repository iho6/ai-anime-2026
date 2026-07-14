"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  assetUrlFromRelPath,
  type FrameSequencePayload,
  type SequenceManifest,
  type SequencePreviewAspect,
} from "../../lib/api";
import {
  normalizeSequencePreviewAspect,
  SEQUENCE_PREVIEW_ASPECT_OPTIONS,
} from "../../lib/sequenceAspect";
import { SequencePreviewLightbox } from "../../app/detail/[charKey]/dataset/SequencePreviewLightbox";
import { DesktopContextMenu, type ContextMenuItem } from "../DesktopContextMenu";
import { SequenceGalleryPanel } from "../sequenceWorkspace/SequenceGalleryPanel";
import {
  FrameTimelineViewport,
  sequenceTimelineCellWidth,
} from "../sequenceWorkspace/FrameTimelineViewport";
import { SequenceWorkspaceShell } from "../sequenceWorkspace/SequenceWorkspaceShell";
import {
  cloneFrameSequencePayload,
  moveTimelineFrames,
  mutateTimelineFrameSlots,
  placeGallerySequence,
} from "./frameWorkspaceOps";

const MIN_FRAMES = 48;
const TAIL_FRAMES = 24;
const HISTORY_LIMIT = 50;

export type TimelineClipFrameWorkspaceItem = {
  clipId: string;
  label: string;
  thumbRelPath: string;
  frameSequence: FrameSequencePayload;
};

type FocusScope = "gallery" | "timeline";
type MenuState = { x: number; y: number; index: number } | null;

function payloadFingerprint(payload: FrameSequencePayload): string {
  return JSON.stringify(payload);
}

export function TimelineClipFrameWorkspace(props: {
  open: boolean;
  title?: string;
  items: readonly TimelineClipFrameWorkspaceItem[];
  primaryClipId: string;
  fps: number;
  busy?: boolean;
  onClose: () => void;
  onFrameSequenceChange: (clipId: string, frameSequence: FrameSequencePayload) => void;
  duplicateFrameAsset: (targetClipId: string, sourceRelPath: string) => Promise<string>;
  onError: (message: string, error?: unknown) => void;
  onEditFrameSequence: (clipId: string) => void;
  onDownloadVideo?: (clipId: string) => void;
}) {
  const {
    open,
    title = "Edit Video Frames",
    items,
    primaryClipId,
    fps,
    busy = false,
    onClose,
    onFrameSequenceChange,
    duplicateFrameAsset,
    onError,
    onEditFrameSequence,
    onDownloadVideo,
  } = props;
  const [selectedClipId, setSelectedClipId] = useState(primaryClipId);
  const [focusScope, setFocusScope] = useState<FocusScope>("gallery");
  const [selectedFrames, setSelectedFrames] = useState<Set<number>>(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<number | null>(null);
  const [timelineScale, setTimelineScale] = useState(1);
  const [viewStep, setViewStep] = useState<1 | 2>(1);
  const [previewAspect, setPreviewAspect] = useState<SequencePreviewAspect>("16:9");
  const [preview, setPreview] = useState<
    { scope: "gallery" | "timeline"; index: number } | null
  >(null);
  const [galleryMenu, setGalleryMenu] = useState<MenuState>(null);
  const [frameMenu, setFrameMenu] = useState<MenuState>(null);
  const [dragPreviewPath, setDragPreviewPath] = useState<string | null>(null);
  const [duplicatingDrop, setDuplicatingDrop] = useState(false);
  const [localPayload, setLocalPayload] = useState<FrameSequencePayload | null>(null);
  const undoRef = useRef<FrameSequencePayload[]>([]);
  const redoRef = useRef<FrameSequencePayload[]>([]);
  const clipboardRef = useRef<FrameSequencePayload["strip"] | null>(null);
  const pendingFingerprintRef = useRef<string | null>(null);
  const dropInProgressRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const selectedItem = useMemo(
    () => items.find((item) => item.clipId === selectedClipId) ?? items[0] ?? null,
    [items, selectedClipId]
  );

  useEffect(() => {
    if (!items.some((item) => item.clipId === selectedClipId)) {
      setSelectedClipId(items[0]?.clipId ?? primaryClipId);
    }
  }, [items, primaryClipId, selectedClipId]);

  useEffect(() => {
    if (!selectedItem) {
      setLocalPayload(null);
      return;
    }
    setLocalPayload(cloneFrameSequencePayload(selectedItem.frameSequence));
    setSelectedFrames(new Set());
    setSelectionAnchor(null);
    undoRef.current = [];
    redoRef.current = [];
    pendingFingerprintRef.current = null;
    // Selection changes intentionally reset this overview's local history.
    // Parent-controlled payload updates are synchronized separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem?.clipId]);

  useEffect(() => {
    if (!selectedItem || !localPayload) return;
    const controlledFingerprint = payloadFingerprint(selectedItem.frameSequence);
    if (controlledFingerprint === pendingFingerprintRef.current) {
      pendingFingerprintRef.current = null;
      return;
    }
    if (pendingFingerprintRef.current) return;
    if (controlledFingerprint !== payloadFingerprint(localPayload)) {
      setLocalPayload(cloneFrameSequencePayload(selectedItem.frameSequence));
    }
  }, [localPayload, selectedItem]);

  const commitPayload = useCallback(
    (next: FrameSequencePayload, recordHistory = true) => {
      if (!selectedItem || !localPayload || busy) return;
      if (payloadFingerprint(next) === payloadFingerprint(localPayload)) return;
      if (recordHistory) {
        undoRef.current.push(cloneFrameSequencePayload(localPayload));
        if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
        redoRef.current = [];
      }
      const cloned = cloneFrameSequencePayload(next);
      pendingFingerprintRef.current = payloadFingerprint(cloned);
      setLocalPayload(cloned);
      onFrameSequenceChange(selectedItem.clipId, cloned);
    },
    [busy, localPayload, onFrameSequenceChange, selectedItem]
  );

  const mutateSelectedSlots = useCallback(
    (mutation: "delete" | "hide" | "unhide") => {
      if (!localPayload || !selectedFrames.size) return;
      commitPayload(mutateTimelineFrameSlots(localPayload, selectedFrames, mutation));
    },
    [commitPayload, localPayload, selectedFrames]
  );

  const undo = useCallback(() => {
    if (!selectedItem || !localPayload || !undoRef.current.length || busy) return;
    const previous = undoRef.current.pop()!;
    redoRef.current.push(cloneFrameSequencePayload(localPayload));
    pendingFingerprintRef.current = payloadFingerprint(previous);
    setLocalPayload(cloneFrameSequencePayload(previous));
    onFrameSequenceChange(selectedItem.clipId, cloneFrameSequencePayload(previous));
  }, [busy, localPayload, onFrameSequenceChange, selectedItem]);

  const redo = useCallback(() => {
    if (!selectedItem || !localPayload || !redoRef.current.length || busy) return;
    const next = redoRef.current.pop()!;
    undoRef.current.push(cloneFrameSequencePayload(localPayload));
    pendingFingerprintRef.current = payloadFingerprint(next);
    setLocalPayload(cloneFrameSequencePayload(next));
    onFrameSequenceChange(selectedItem.clipId, cloneFrameSequencePayload(next));
  }, [busy, localPayload, onFrameSequenceChange, selectedItem]);

  const copySelection = useCallback(() => {
    if (!localPayload) return;
    if (focusScope === "gallery") {
      clipboardRef.current = cloneFrameSequencePayload(localPayload).strip;
      return;
    }
    const indices = [...selectedFrames].sort((a, b) => a - b);
    if (!indices.length) return;
    const first = indices[0]!;
    const last = indices[indices.length - 1]!;
    clipboardRef.current = localPayload.strip
      .slice(first, last + 1)
      .map((slot) => ({ ...slot, crop: slot.crop ? { ...slot.crop } : undefined }));
  }, [focusScope, localPayload, selectedFrames]);

  const pasteSelection = useCallback(() => {
    if (!localPayload || !clipboardRef.current?.length) return;
    const anchor = selectedFrames.size ? Math.min(...selectedFrames) : localPayload.strip.length;
    const strip = [...localPayload.strip];
    while (strip.length < anchor) strip.push({ kind: "empty" });
    strip.splice(
      anchor,
      clipboardRef.current.length,
      ...clipboardRef.current.map((slot) => ({
        ...slot,
        crop: slot.crop ? { ...slot.crop } : undefined,
      }))
    );
    commitPayload({ ...localPayload, strip });
    setSelectedFrames(new Set(clipboardRef.current.map((_, index) => anchor + index)));
  }, [commitPayload, localPayload, selectedFrames]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) {
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && focusScope === "timeline") {
        event.preventDefault();
        mutateSelectedSlots("delete");
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        copySelection();
      } else if (key === "v") {
        event.preventDefault();
        pasteSelection();
      } else if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelection, focusScope, mutateSelectedSlots, open, pasteSelection, redo, undo]);

  const frameCount = Math.max(MIN_FRAMES, (localPayload?.strip.length ?? 0) + TAIL_FRAMES);
  const visibleFrameIndices = useMemo(() => {
    const out: number[] = [];
    for (let index = 0; index < frameCount; index += viewStep) out.push(index);
    return out;
  }, [frameCount, viewStep]);
  const cells = useMemo(() => {
    const map = new Map<
      number,
      {
        cellId: string;
        relPath: string;
        crop?: FrameSequencePayload["strip"][number]["crop"];
        sequenceGroupId?: string;
        hidden?: boolean;
      }
    >();
    localPayload?.strip.forEach((slot, index) => {
      if (slot.kind !== "image" || !slot.relPath) return;
      map.set(index, {
        cellId: `${selectedItem?.clipId ?? "clip"}:${index}`,
        relPath: slot.relPath,
        crop: slot.crop,
        sequenceGroupId: localPayload.sequenceGroupId,
        hidden: slot.hidden,
      });
    });
    return map;
  }, [localPayload, selectedItem?.clipId]);
  const visibleOrdinals = useMemo(() => {
    let ordinal = 0;
    return visibleFrameIndices.map((index) => {
      if (cells.get(index)?.hidden) return null;
      ordinal += 1;
      return ordinal;
    });
  }, [cells, visibleFrameIndices]);
  const groupOutlines = useMemo(() => {
    if (!localPayload?.strip.length) return [];
    const occupied = localPayload.strip
      .map((slot, index) => (slot.kind === "image" && slot.relPath ? index : -1))
      .filter((index) => index >= 0);
    if (!occupied.length) return [];
    return [{
      groupId: localPayload.sequenceGroupId,
      min: Math.min(...occupied),
      max: Math.max(...occupied),
    }];
  }, [localPayload]);

  const previewManifest = useMemo<SequenceManifest>(() => ({
    version: 1,
    fps: Math.max(1, Math.round(fps)),
    previewAspect,
    timelineViewStep: viewStep,
    gallery: items.map((item) => ({
      id: item.clipId,
      relPath: item.thumbRelPath,
      frameSequence: item.frameSequence,
    })),
    frames: (localPayload?.strip ?? []).flatMap((slot, index) =>
      slot.kind === "image" && slot.relPath
        ? [{
            index,
            cellId: `${selectedItem?.clipId ?? "clip"}:${index}`,
            relPath: slot.relPath,
            crop: slot.crop,
            sequenceGroupId: localPayload?.sequenceGroupId,
            hidden: slot.hidden,
            placedFigure: slot.placedFigure,
          }]
        : []
    ),
  }), [fps, items, localPayload, previewAspect, selectedItem?.clipId, viewStep]);

  const openTimelinePreview = useCallback((frameIndex: number) => {
    const visible = previewManifest.frames.filter((frame) => !frame.hidden);
    const index = visible.findIndex((frame) => frame.index === frameIndex);
    if (index >= 0) setPreview({ scope: "timeline", index });
  }, [previewManifest.frames]);

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDragPreviewPath(null);
      if (!localPayload || !selectedItem || dropInProgressRef.current) return;
      const overId = String(event.over?.id ?? "");
      if (!overId.startsWith("frame:")) return;
      const toIndex = Number.parseInt(overId.slice("frame:".length), 10);
      if (!Number.isFinite(toIndex)) return;
      const active = event.active.data.current as
        | {
            kind?: string;
            fromIndex?: number;
            galleryId?: string;
            frameSequence?: FrameSequencePayload;
          }
        | undefined;
      if (active?.kind === "timeline" && active.fromIndex != null) {
        const fromIndex = active.fromIndex;
        const moved = moveTimelineFrames(localPayload, fromIndex, toIndex, selectedFrames);
        if (!moved) return;
        commitPayload(moved.payload);
        setSelectedFrames(moved.selectedIndices);
        setSelectionAnchor(toIndex);
        return;
      }
      if (active?.kind === "gallery" && active.frameSequence) {
        dropInProgressRef.current = true;
        setDuplicatingDrop(true);
        try {
          const placed = await placeGallerySequence(
            localPayload,
            active.frameSequence,
            toIndex,
            active.galleryId === selectedItem.clipId
              ? undefined
              : (relPath) => duplicateFrameAsset(selectedItem.clipId, relPath)
          );
          commitPayload(placed.payload);
          setSelectedFrames(placed.selectedIndices);
          setSelectionAnchor(toIndex);
        } catch (error) {
          onError("Could not copy gallery frames into the selected clip.", error);
        } finally {
          dropInProgressRef.current = false;
          setDuplicatingDrop(false);
        }
      }
    },
    [commitPayload, duplicateFrameAsset, localPayload, onError, selectedFrames, selectedItem]
  );

  const galleryMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!galleryMenu) return [];
    const item = items[galleryMenu.index];
    if (!item) return [];
    return [
      {
        key: "preview",
        label: "Preview",
        onSelect: () => setPreview({ scope: "gallery", index: galleryMenu.index }),
      },
      {
        key: "edit",
        label: "Edit Frame Sequence",
        disabled: busy,
        onSelect: () => onEditFrameSequence(item.clipId),
      },
    ];
  }, [busy, galleryMenu, items, onEditFrameSequence]);

  const frameMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!frameMenu || !localPayload || !selectedItem) return [];
    const occupied = [...selectedFrames].filter(
      (index) => localPayload.strip[index]?.kind === "image"
    );
    const anyVisible = occupied.some((index) => !localPayload.strip[index]?.hidden);
    const anyHidden = occupied.some((index) => localPayload.strip[index]?.hidden);
    const result: ContextMenuItem[] = [
      {
        key: "preview",
        label: "Preview",
        disabled: !cells.has(frameMenu.index),
        onSelect: () => openTimelinePreview(frameMenu.index),
      },
      {
        key: "edit",
        label: "Edit Frame Sequence",
        disabled: busy,
        onSelect: () => onEditFrameSequence(selectedItem.clipId),
      },
    ];
    if (anyVisible) {
      result.push({
        key: "hide",
        label: occupied.length > 1 ? `Hide ${occupied.length} frames` : "Hide frame",
        onSelect: () => mutateSelectedSlots("hide"),
      });
    }
    if (anyHidden) {
      result.push({
        key: "unhide",
        label: occupied.length > 1 ? `Unhide ${occupied.length} frames` : "Unhide frame",
        onSelect: () => mutateSelectedSlots("unhide"),
      });
    }
    result.push({
      key: "delete",
      label: occupied.length > 1 ? `Remove ${occupied.length} frames` : "Remove frame",
      disabled: !occupied.length,
      onSelect: () => mutateSelectedSlots("delete"),
    });
    return result;
  }, [
    busy,
    cells,
    frameMenu,
    localPayload,
    mutateSelectedSlots,
    onEditFrameSequence,
    openTimelinePreview,
    selectedFrames,
    selectedItem,
  ]);

  if (!open || !selectedItem || !localPayload) return null;

  return (
    <SequenceWorkspaceShell open title={title} onClose={onClose}>
      <div ref={rootRef}>
        <DesktopContextMenu
          open={galleryMenu != null}
          x={galleryMenu?.x ?? 0}
          y={galleryMenu?.y ?? 0}
          items={galleryMenuItems}
          onClose={() => setGalleryMenu(null)}
        />
        <DesktopContextMenu
          open={frameMenu != null}
          x={frameMenu?.x ?? 0}
          y={frameMenu?.y ?? 0}
          items={frameMenuItems}
          onClose={() => setFrameMenu(null)}
        />
        <DndContext
          sensors={sensors}
          onDragEnd={(event) => void onDragEnd(event)}
          onDragCancel={() => setDragPreviewPath(null)}
          onDragStart={(event) => {
            const data = event.active.data.current as
              | { relPath?: string; frameSequence?: FrameSequencePayload; fromIndex?: number }
              | undefined;
            const stripPath = data?.frameSequence?.strip.find(
              (slot) => slot.kind === "image" && slot.relPath && !slot.hidden
            )?.relPath;
            setDragPreviewPath(stripPath ?? data?.relPath ?? null);
          }}
        >
          <SequenceGalleryPanel
            items={items.map((item) => ({
              id: item.clipId,
              relPath: item.thumbRelPath,
              frameSequence: item.frameSequence,
            }))}
            selectedId={selectedItem.clipId}
            onFocus={() => setFocusScope("gallery")}
            onSelect={(clipId) => setSelectedClipId(clipId)}
            onItemContextMenu={(event, index) => {
              setFrameMenu(null);
              setFocusScope("gallery");
              setSelectedClipId(items[index]?.clipId ?? selectedItem.clipId);
              setGalleryMenu({ x: event.clientX, y: event.clientY, index });
            }}
            onItemDoubleClick={(index) => {
              if (items[index]) setPreview({ scope: "gallery", index });
            }}
          />
          <div
            style={{
              marginTop: 16,
              marginBottom: 4,
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span>Timeline</span>
            <span style={{ color: "#666" }}>—</span>
            <select
              aria-label="Timeline grid density"
              value={viewStep === 2 ? "12" : "24"}
              onChange={(event) => setViewStep(event.target.value === "12" ? 2 : 1)}
              onMouseDown={(event) => event.stopPropagation()}
              style={{ fontSize: 13, padding: "2px 6px" }}
            >
              <option value="24">24 fps</option>
              <option value="12">12 fps</option>
            </select>
            <button
              type="button"
              disabled={!onDownloadVideo || busy}
              title="Encode the selected frame sequence and download it as video."
              onClick={() => onDownloadVideo?.(selectedItem.clipId)}
              onMouseDown={(event) => event.stopPropagation()}
              style={{
                fontSize: 13,
                padding: "2px 8px",
                border: "0.5px solid rgba(0, 0, 0, 0.22)",
                borderRadius: 0,
                background: "#f2f2f2",
                cursor: !onDownloadVideo || busy ? "not-allowed" : "pointer",
                opacity: !onDownloadVideo || busy ? 0.45 : 1,
              }}
            >
              Download as Video
            </button>
            <strong style={{ fontSize: 13 }}>{selectedItem.label}</strong>
          </div>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
            {duplicatingDrop
              ? "Copying frames into selected clip…"
              : "Drag the panel corner to resize · Ctrl+scroll (⌘ scroll) to zoom frames · Double-click a frame to preview · Ctrl+C / Ctrl+V / Delete when timeline is focused"}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 13 }}>Preview aspect</span>
            <select
              aria-label="Preview aspect ratio for sequence crop"
              value={normalizeSequencePreviewAspect(previewAspect)}
              onChange={(event) => setPreviewAspect(event.target.value as SequencePreviewAspect)}
              onMouseDown={(event) => event.stopPropagation()}
              style={{ fontSize: 13, padding: "4px 8px", maxWidth: 200 }}
            >
              {SEQUENCE_PREVIEW_ASPECT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <FrameTimelineViewport
            visibleFrameIndices={visibleFrameIndices}
            visibleOrdinals={visibleOrdinals}
            cells={cells}
            selectedFrameIndices={selectedFrames}
            groupOutlines={groupOutlines}
            logicalFps={Math.max(1, Math.round(fps))}
            ticksPerSecond={Math.max(1, Math.round(fps / viewStep))}
            scale={timelineScale}
            onScaleChange={setTimelineScale}
            onFocus={() => setFocusScope("timeline")}
            onCellClick={(event, frameIndex) => {
              setFocusScope("timeline");
              setFrameMenu(null);
              if (event.shiftKey && selectionAnchor != null) {
                const lo = Math.min(selectionAnchor, frameIndex);
                const hi = Math.max(selectionAnchor, frameIndex);
                setSelectedFrames(new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)));
              } else if (event.ctrlKey || event.metaKey) {
                setSelectedFrames((previous) => {
                  const next = new Set(previous);
                  if (next.has(frameIndex)) next.delete(frameIndex);
                  else next.add(frameIndex);
                  return next;
                });
                setSelectionAnchor(frameIndex);
              } else {
                setSelectedFrames(new Set([frameIndex]));
                setSelectionAnchor(frameIndex);
              }
            }}
            onCellDoubleClick={openTimelinePreview}
            onCellContextMenu={(event, frameIndex) => {
              setGalleryMenu(null);
              setFocusScope("timeline");
              if (!selectedFrames.has(frameIndex)) {
                setSelectedFrames(new Set([frameIndex]));
                setSelectionAnchor(frameIndex);
              }
              setFrameMenu({ x: event.clientX, y: event.clientY, index: frameIndex });
            }}
          />
          <DragOverlay>
            {dragPreviewPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={assetUrlFromRelPath(dragPreviewPath)}
                alt=""
                style={{
                  width: sequenceTimelineCellWidth(timelineScale),
                  height: sequenceTimelineCellWidth(timelineScale),
                  objectFit: "contain",
                }}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
        {preview ? (
          <SequencePreviewLightbox
            manifest={previewManifest}
            scope={preview.scope}
            initialIndex={preview.index}
            title={`${selectedItem.label} — ${preview.scope === "gallery" ? "Gallery" : "Timeline"}`}
            timelinePreviewColumnIndices={visibleFrameIndices}
            onClose={() => setPreview(null)}
            onCommitManifest={(next) => {
              if (preview.scope !== "timeline") return;
              const cropByIndex = new Map(next.frames.map((frame) => [frame.index, frame.crop]));
              commitPayload({
                ...localPayload,
                strip: localPayload.strip.map((slot, index) => {
                  if (slot.kind !== "image") return slot;
                  const crop = cropByIndex.get(index);
                  return { ...slot, crop: crop ? { ...crop } : undefined };
                }),
              });
            }}
          />
        ) : null}
      </div>
    </SequenceWorkspaceShell>
  );
}
