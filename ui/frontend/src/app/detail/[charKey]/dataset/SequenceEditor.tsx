"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  apiSequenceDuplicateAsset,
  apiSequenceExportGalleryFrameSetMp4Blob,
  apiSequenceExportTimelineMp4Blob,
  apiSequenceGenerateFlf,
  apiSequenceGenerateI2v,
  apiSequenceStripGenerateFlf,
  apiSequenceStripGenerateI2v,
  apiSequenceGet,
  apiSequencePut,
  assetUrlFromRelPath,
  runDetailWsJob,
  runShotRemoveBgWsJob,
  type FrameSequencePayload,
  type FrameSequenceStripSlot,
  type SequenceFrameItem,
  type SequenceGalleryItem,
  type SequenceManifest,
  type SequencePreviewAspect,
} from "../../../../lib/api";
import {
  FrameSequenceModal,
  type FrameSequenceStripActions,
} from "./FrameSequenceModal";
import { outputDirFromRelPath } from "../../../../components/frameSequenceStripUtils";
import { AiEditModal } from "../../../../components/AiEditModal";
import {
  SEQUENCE_FLF_OUTPUT_LENGTHS,
  SEQUENCE_I2V_OUTPUT_LENGTHS,
  SequenceOutputLengthStepper,
  sequenceVideoLengthIndex,
} from "../../../../components/sequenceOutputLength";
import {
  normalizeSequencePreviewAspect,
  SEQUENCE_PREVIEW_ASPECT_OPTIONS,
} from "../../../../lib/sequenceAspect";
import {
  cloneCrop,
  SEQUENCE_CROP_OUTER_CLIP_FLEX,
  sequenceCropTransformWrapperStyle,
} from "../../../../lib/sequenceCrop";
import {
  isEditableTarget,
  shouldDeferSequenceEditorClipboard,
  shouldDeferSequenceEditorUndoRedo,
} from "../../../../lib/nativeClipboardShortcuts";
import { ResizableScrollGallery } from "../../../../components/ResizableScrollGallery";
import { SequencePreviewLightbox } from "./SequencePreviewLightbox";
import { DesktopContextMenu, type ContextMenuItem } from "../../../../components/DesktopContextMenu";
import {
  computeSequenceTimelineSpan,
  FS_MODAL_GALLERY_BACKDROP_DROP_ID,
  newGalleryId,
  frameSequenceStripSlotHasTimelineImage,
  shiftTimelineMapForFrameSequenceDrop,
  visibleTimelineColumnIndices,
} from "./sequenceGalleryUtils";
import type { BeginSessionOpts } from "../../../../hooks/useJobRunSession";

const TILE = 120;
const UNDO_CAP = 50;

type UndoEntry = {
  manifest: SequenceManifest;
  selectedFrameIndices: number[];
  selectedGalleryId: string | null;
  focusScope: "gallery" | "timeline";
};

/** Shared dataset job modal (ConnectedJobRunModal / useJobRunSession) for long HTTP work e.g. FLF. */
export type SequenceJobModal = {
  begin: (opts: BeginSessionOpts) => void;
  end: () => void;
  fail: (err: unknown, userMessage: string) => void;
  log: (line: string) => void;
};
const MIN_FRAMES = 48;
const BASE_FRAME_CELL = 72;
const BASE_RULER_H = 22;
const BASE_FOOTER_H = 18;
const TIMELINE_ZOOM_MIN = 0.55;
const TIMELINE_ZOOM_MAX = 3.2;

type FrameMapValue = Pick<
  SequenceFrameItem,
  "cellId" | "relPath" | "crop" | "sequenceGroupId" | "hidden"
>;

/** Single gallery image (copy from sequence gallery strip). */
type GalleryClipboard = {
  kind: "gallery";
  relPath: string;
  galleryId?: string;
  crop?: SequenceFrameItem["crop"];
};

/** Full sequence set for gallery copy/paste (assets duplicated on paste). */
type GalleryFrameSequenceClipboard = {
  kind: "galleryFs";
  galleryId: string;
  crop?: SequenceFrameItem["crop"];
  fallbackThumbRelPath: string;
  frameSequence: FrameSequencePayload;
};

type TimelineClipboardItem = {
  relPath: string;
  crop: SequenceFrameItem["crop"];
  index: number;
};

/** One or more timeline cells; relative `index` spacing is preserved on paste. */
type TimelineClipboard = {
  kind: "timeline";
  items: TimelineClipboardItem[];
};

type SequenceClipboard = GalleryClipboard | GalleryFrameSequenceClipboard | TimelineClipboard;

function newCellId(): string {
  return `cell_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function newSequenceGroupId(): string {
  return `sg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function cloneFrameSequencePayload(fs: FrameSequencePayload): FrameSequencePayload {
  try {
    return structuredClone(fs) as FrameSequencePayload;
  } catch {
    return JSON.parse(JSON.stringify(fs)) as FrameSequencePayload;
  }
}

async function duplicateFrameSequenceToGalleryRow(params: {
  charKey: string;
  sequenceName: string;
  sourceFs: FrameSequencePayload;
  fallbackThumbRelPath: string;
  sourceCrop?: SequenceFrameItem["crop"];
}): Promise<Pick<SequenceGalleryItem, "relPath" | "crop" | "frameSequence">> {
  const { charKey, sequenceName, sourceFs, fallbackThumbRelPath, sourceCrop } = params;
  const dupGal = async (sourceRelPath: string) => {
    const { relPath } = await apiSequenceDuplicateAsset({
      charKey,
      sequenceName,
      sourceRelPath: sourceRelPath.trim(),
      subfolder: "gallery",
    });
    return relPath;
  };
  const gid = newSequenceGroupId();
  const nextStrip: FrameSequenceStripSlot[] = [];
  for (const slot of sourceFs.strip) {
    if (slot.kind === "empty") {
      nextStrip.push(slot.hidden ? { kind: "empty", hidden: true } : { kind: "empty" });
      continue;
    }
    if (slot.kind === "image" && slot.relPath?.trim()) {
      const relPath = await dupGal(slot.relPath);
      nextStrip.push({
        kind: "image",
        relPath,
        crop: cloneCrop(slot.crop),
        ...(slot.hidden ? { hidden: true as const } : {}),
      });
      continue;
    }
    nextStrip.push({ kind: "empty" });
  }
  const hidden = sourceFs.hidden ?? [];
  const nextHidden = [];
  for (const h of hidden) {
    const relPath = await dupGal(h.relPath);
    nextHidden.push({
      relPath,
      afterIndex: h.afterIndex,
      crop: cloneCrop(h.crop),
    });
  }
  const nextFs: FrameSequencePayload = {
    sequenceGroupId: gid,
    strip: nextStrip,
    hidden: nextHidden,
  };
  let thumbRel = firstStripImageRelPath(nextFs);
  if (!thumbRel) {
    const fb = fallbackThumbRelPath.trim();
    if (!fb) throw new Error("Sequence set has no image path for gallery thumbnail.");
    thumbRel = await dupGal(fb);
  }
  return {
    relPath: thumbRel,
    crop: cloneCrop(sourceCrop),
    frameSequence: nextFs,
  };
}

type PlaceFrameSequenceOnTimelineResult = {
  manifest: SequenceManifest;
  placedIndices: number[];
};

async function placeFrameSequenceStripOnTimeline(params: {
  charKey: string;
  sequenceName: string;
  manifest: SequenceManifest;
  anchor: number;
  fs: FrameSequencePayload;
  sequenceGroupId: string;
  jobModal?: SequenceJobModal | null;
  onError: (msg: string, e?: unknown) => void;
}): Promise<PlaceFrameSequenceOnTimelineResult | null> {
  const { charKey, sequenceName, manifest: prev, anchor, fs, sequenceGroupId, jobModal, onError } =
    params;
  const strip = fs.strip;
  const n = strip.length;
  if (n === 0) return null;
  let imageCount = 0;
  for (const slot of strip) {
    if (frameSequenceStripSlotHasTimelineImage(slot)) imageCount += 1;
  }
  if (imageCount === 0) return null;
  const map = shiftTimelineMapForFrameSequenceDrop(framesByIndex(prev), anchor, n);
  const jm = jobModal;
  const placedIndices: number[] = [];
  try {
    if (jm) {
      jm.begin({ title: "Loading sequence set into timeline...", clearLog: true });
      jm.log("Loading sequence set into timeline...");
      jm.log(`Sequence: ${sequenceName}`);
      jm.log(`Strip columns: ${n}, images to copy: ${imageCount}`);
    }
    let dupIx = 0;
    for (let k = 0; k < n; k++) {
      const slot = strip[k]!;
      if (!frameSequenceStripSlotHasTimelineImage(slot)) continue;
      dupIx += 1;
      if (jm) jm.log(`Duplicating image ${dupIx}/${imageCount} (strip index ${k})…`);
      const { relPath } = await apiSequenceDuplicateAsset({
        charKey,
        sequenceName,
        sourceRelPath: slot.relPath!,
        subfolder: "cells",
      });
      map.set(anchor + k, {
        cellId: newCellId(),
        relPath,
        crop: cloneCrop(slot.crop),
        sequenceGroupId,
      });
      placedIndices.push(anchor + k);
    }
    const manifest: SequenceManifest = { ...prev, frames: toFramesArray(map) };
    if (jm) {
      jm.log("Done. Sequence set placed on timeline.");
      jm.end();
    }
    return { manifest, placedIndices };
  } catch (e) {
    if (jm) jm.fail(e, "Drop frame sequence failed (see log).");
    else onError("Drop frame sequence failed.", e);
    return null;
  }
}

function framesByIndex(manif: SequenceManifest): Map<number, FrameMapValue> {
  const m = new Map<number, FrameMapValue>();
  for (const fr of manif.frames) {
    m.set(fr.index, {
      cellId: fr.cellId,
      relPath: fr.relPath,
      crop: fr.crop,
      sequenceGroupId: fr.sequenceGroupId,
      hidden: fr.hidden,
    });
  }
  return m;
}

function toFramesArray(map: Map<number, FrameMapValue>): SequenceManifest["frames"] {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, v]) => {
      const row: SequenceFrameItem = {
        index,
        cellId: v.cellId,
        relPath: v.relPath,
        crop: v.crop,
      };
      if (v.sequenceGroupId) row.sequenceGroupId = v.sequenceGroupId;
      if (v.hidden) row.hidden = true;
      return row;
    });
}

/**
 * FLF (first–last frame video): timeline indices from min..max must all be
 * selected; only the endpoints need images — gaps between them are allowed (the
 * model interpolates). No keyframe rows strictly between start and end (matches
 * backend `_validate_flf_timeline_selection`).
 */
function canGenerateFlfSelection(
  selected: Set<number>,
  manifest: SequenceManifest
): { ok: true; start: number; end: number } | { ok: false } {
  if (!selected.size) return { ok: false };
  const lo = Math.min(...selected);
  const hi = Math.max(...selected);
  if (hi <= lo) return { ok: false };
  for (let i = lo; i <= hi; i++) {
    if (!selected.has(i)) return { ok: false };
  }
  const fm = framesByIndex(manifest);
  const a = fm.get(lo);
  const b = fm.get(hi);
  if (!a?.relPath || !b?.relPath) return { ok: false };
  for (let k = lo + 1; k < hi; k++) {
    if (fm.has(k)) return { ok: false };
  }
  return { ok: true, start: lo, end: hi };
}

/** Single timeline cell with an image — image-to-video (Hunyuan I2V). */
function canGenerateI2vSelection(
  selected: Set<number>,
  manifest: SequenceManifest
): { ok: true; frameIndex: number } | { ok: false } {
  if (selected.size !== 1) return { ok: false };
  const frameIndex = selected.values().next().value as number;
  const fm = framesByIndex(manifest);
  const row = fm.get(frameIndex);
  if (!row?.relPath) return { ok: false };
  return { ok: true, frameIndex };
}

function firstStripImageRelPath(fs: FrameSequencePayload): string | null {
  for (const s of fs.strip) {
    if (s.kind === "image" && s.relPath && !s.hidden) return s.relPath;
  }
  return null;
}

function shiftRangeIndices(anchor: number, b: number): Set<number> {
  const lo = Math.min(anchor, b);
  const hi = Math.max(anchor, b);
  const s = new Set<number>();
  for (let i = lo; i <= hi; i++) s.add(i);
  return s;
}

/** True if shifting every index in sourceIndices by delta stays in-bounds and does not overwrite frames outside the selection. */
function canPlaceTimelineShift(
  map: Map<number, FrameMapValue>,
  sourceIndices: Set<number>,
  delta: number,
  frameCount: number
): boolean {
  for (const i of sourceIndices) {
    const t = i + delta;
    if (t < 0 || t >= frameCount) return false;
    if (map.has(t) && !sourceIndices.has(t)) return false;
  }
  return true;
}

function GalleryThumb(props: {
  id: string;
  relPath: string;
  crop: SequenceFrameItem["crop"];
  frameSequence?: SequenceGalleryItem["frameSequence"];
  selected: boolean;
  onSelect: () => void;
  setFocusGallery: () => void;
  onGalleryContextMenu: (e: React.MouseEvent, galleryIndex: number) => void;
  galleryIndex: number;
  onDoubleClickPreview?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props.id,
    data: {
      kind: "gallery" as const,
      galleryId: props.id,
      relPath: props.relPath,
      frameSequence: props.frameSequence,
    },
  });

  return (
    <button
      type="button"
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        e.stopPropagation();
        props.setFocusGallery();
        props.onSelect();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        props.onDoubleClickPreview?.();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.setFocusGallery();
        props.onGalleryContextMenu(e, props.galleryIndex);
      }}
      style={{
        position: "relative",
        width: TILE,
        height: TILE,
        padding: 0,
        border: props.selected ? "2px solid #06c" : "1px solid rgba(0,0,0,0.35)",
        opacity: isDragging ? 0.5 : 1,
        cursor: "grab",
        background: "transparent",
        touchAction: "none",
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      {props.frameSequence ? (
        <span
          style={{
            position: "absolute",
            top: 2,
            left: 2,
            fontSize: 10,
            lineHeight: 1,
            padding: "1px 4px",
            background: "rgba(0,0,0,0.65)",
            color: "#fff",
            zIndex: 1,
            pointerEvents: "none",
          }}
        >
          Folder
        </span>
      ) : null}
      <div style={{ ...SEQUENCE_CROP_OUTER_CLIP_FLEX, pointerEvents: "none" }}>
        <div style={sequenceCropTransformWrapperStyle(props.crop)}>
          <img
            src={assetUrlFromRelPath(props.relPath)}
            alt=""
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              width: "auto",
              height: "auto",
              objectFit: "contain",
              display: "block",
            }}
          />
        </div>
      </div>
    </button>
  );
}

function FrameDropCell(props: {
  cellW: number;
  frameIndex: number;
  relPath: string | null;
  cellId: string | undefined;
  crop: SequenceFrameItem["crop"];
  sequenceGroupId?: string;
  hidden?: boolean;
  selected: boolean;
  onCellClick: (e: React.MouseEvent) => void;
  onCellDoubleClick?: (frameIndex: number) => void;
  setFocusTimeline: () => void;
  onFrameContextMenu: (e: React.MouseEvent, frameIndex: number) => void;
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `frame:${props.frameIndex}`,
    data: { frameIndex: props.frameIndex },
  });

  const canDrag = Boolean(props.relPath && props.cellId) && !props.hidden;
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `tl-drag:${props.frameIndex}`,
    data: {
      kind: "timeline" as const,
      fromIndex: props.frameIndex,
      cellId: props.cellId,
      relPath: props.relPath,
      crop: props.crop,
      sequenceGroupId: props.sequenceGroupId,
    },
    disabled: !canDrag,
  });

  const setRefs = useCallback(
    (node: HTMLButtonElement | null) => {
      setDropRef(node);
      setDragRef(node);
    },
    [setDropRef, setDragRef]
  );

  const frameBtnClass =
    "sequenceTimelineFrameBtn" + (props.selected ? " sequenceTimelineFrameBtn--selected" : "");

  return (
    <button
      type="button"
      ref={setRefs}
      {...(canDrag ? listeners : {})}
      {...(canDrag ? attributes : {})}
      className={frameBtnClass}
      onClick={(e) => {
        e.stopPropagation();
        props.setFocusTimeline();
        props.onCellClick(e);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!props.relPath) return;
        props.onCellDoubleClick?.(props.frameIndex);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onFrameContextMenu(e, props.frameIndex);
      }}
      style={{
        width: props.cellW,
        height: props.cellW,
        padding: 2,
        boxSizing: "border-box",
        position: "relative",
        border: props.selected
          ? "2px solid #06c"
          : `1px solid ${isOver ? "rgba(0,100,200,0.7)" : "rgba(0,0,0,0.25)"}`,
        background: isOver ? "rgba(0,100,200,0.08)" : "rgba(0,0,0,0.03)",
        cursor: canDrag ? "grab" : "pointer",
        opacity: isDragging ? 0.45 : 1,
        flexShrink: 0,
      }}
    >
      {props.relPath ? (
        <div style={{ ...SEQUENCE_CROP_OUTER_CLIP_FLEX, pointerEvents: "none" }}>
          <div style={sequenceCropTransformWrapperStyle(props.crop)}>
            <img
              src={assetUrlFromRelPath(props.relPath)}
              alt=""
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                width: "auto",
                height: "auto",
                objectFit: "contain",
                display: "block",
              }}
            />
          </div>
        </div>
      ) : null}
      {props.hidden && props.relPath ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 10,
            color: "#ccc",
            pointerEvents: "none",
          }}
        >
          Hidden
        </div>
      ) : null}
    </button>
  );
}

export function SequenceEditor(props: {
  charKey: string;
  sequenceName: string;
  onError: (msg: string, err?: unknown) => void;
  registerFlushSave?: (fn: (() => Promise<void>) | null) => void;
  jobModal?: SequenceJobModal;
  onAiEditSequenceGallery?: (ctx: { relPath: string; galleryItemId: string }) => void;
  onNewAngleSequenceGallery?: (ctx: { relPath: string; galleryItemId: string }) => void;
}) {
  const {
    charKey,
    sequenceName,
    onError,
    registerFlushSave,
    jobModal,
    onAiEditSequenceGallery,
    onNewAngleSequenceGallery,
  } = props;
  /** Parent often passes an inline onError; keep ref so load/save callbacks stay stable (avoids reload wiping state). */
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [manifest, setManifest] = useState<SequenceManifest | null>(null);
  const [focusScope, setFocusScope] = useState<"gallery" | "timeline">("gallery");
  const [selectedGalleryId, setSelectedGalleryId] = useState<string | null>(null);
  const [selectedFrameIndices, setSelectedFrameIndices] = useState<Set<number>>(() => new Set());
  const [dragPreviewPath, setDragPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ scope: "gallery" | "timeline"; index: number } | null>(
    null
  );
  const [frameMenu, setFrameMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    frameIndex: number;
  } | null>(null);
  const [galleryMenu, setGalleryMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    galleryIndex: number;
  } | null>(null);
  const [flfDialog, setFlfDialog] = useState<{
    open: boolean;
    start: number;
    end: number;
    length: number;
  } | null>(null);
  const [i2vDialog, setI2vDialog] = useState<{
    open: boolean;
    frameIndex: number;
    length: number;
    prompt: string;
  } | null>(null);
  const [frameSeqModal, setFrameSeqModal] = useState<{ galleryIndex: number } | null>(null);
  const [stripAiEditOpen, setStripAiEditOpen] = useState(false);
  const [stripAiEditImageSrc, setStripAiEditImageSrc] = useState("");
  const stripAiEditResolveRef = useRef<((rel: string) => void) | null>(null);
  const stripAiEditRelRef = useRef<string | null>(null);
  const [timelineScale, setTimelineScale] = useState(1);
  const [timelineExportBusy, setTimelineExportBusy] = useState(false);
  /** When set, a gallery sequence-set MP4 export is in progress for that gallery item id. */
  const [gallerySetDownloadId, setGallerySetDownloadId] = useState<string | null>(null);
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const timelineShellRef = useRef<HTMLDivElement | null>(null);
  const timelineAnchorRef = useRef<number | null>(null);
  const selectedFrameIndicesRef = useRef<Set<number>>(new Set());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manifestRef = useRef<SequenceManifest | null>(null);
  const clipRef = useRef<SequenceClipboard | null>(null);
  const undoStackRef = useRef<UndoEntry[]>([]);
  const redoStackRef = useRef<UndoEntry[]>([]);
  const focusScopeRef = useRef<"gallery" | "timeline">("gallery");
  const selectedGalleryIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedFrameIndicesRef.current = selectedFrameIndices;
  }, [selectedFrameIndices]);

  useEffect(() => {
    focusScopeRef.current = focusScope;
  }, [focusScope]);

  useEffect(() => {
    selectedGalleryIdRef.current = selectedGalleryId;
  }, [selectedGalleryId]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const load = useCallback(async () => {
    try {
      const m = await apiSequenceGet(charKey, sequenceName);
      undoStackRef.current.length = 0;
      redoStackRef.current.length = 0;
      setManifest(m);
      manifestRef.current = m;
    } catch (e) {
      onErrorRef.current("Failed to load sequence.", e);
    }
  }, [charKey, sequenceName]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    manifestRef.current = manifest;
  }, [manifest]);

  useEffect(() => {
    const el = timelineShellRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY;
      setTimelineScale((prev) => {
        const step = delta > 0 ? -0.1 : 0.1;
        return Math.max(TIMELINE_ZOOM_MIN, Math.min(TIMELINE_ZOOM_MAX, prev + step));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [manifest]);

  const scheduleSave = useCallback(
    (m: SequenceManifest) => {
      manifestRef.current = m;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        void apiSequencePut(charKey, sequenceName, m).catch((e) =>
          onErrorRef.current("Save sequence failed.", e)
        );
      }, 320);
    },
    [charKey, sequenceName]
  );

  const snapshotBefore = useCallback((): UndoEntry | null => {
    const m = manifestRef.current;
    if (!m) return null;
    return {
      manifest: m,
      selectedFrameIndices: [...selectedFrameIndicesRef.current],
      selectedGalleryId: selectedGalleryIdRef.current,
      focusScope: focusScopeRef.current,
    };
  }, []);

  const applyUndoRedoEntry = useCallback(
    (e: UndoEntry) => {
      setManifest(e.manifest);
      scheduleSave(e.manifest);
      setSelectedFrameIndices(new Set(e.selectedFrameIndices));
      setSelectedGalleryId(e.selectedGalleryId);
      setFocusScope(e.focusScope);
      setFrameMenu(null);
      setGalleryMenu(null);
    },
    [scheduleSave]
  );

  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (!stack.length) return;
    const cur = snapshotBefore();
    if (cur) {
      redoStackRef.current.push(cur);
      if (redoStackRef.current.length > UNDO_CAP) redoStackRef.current.shift();
    }
    const entry = stack.pop()!;
    applyUndoRedoEntry(entry);
  }, [snapshotBefore, applyUndoRedoEntry]);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (!stack.length) return;
    const cur = snapshotBefore();
    if (cur) {
      undoStackRef.current.push(cur);
      if (undoStackRef.current.length > UNDO_CAP) undoStackRef.current.shift();
    }
    const entry = stack.pop()!;
    applyUndoRedoEntry(entry);
  }, [snapshotBefore, applyUndoRedoEntry]);

  const commitManifest = useCallback(
    (next: SequenceManifest, opts?: { recordHistory?: boolean }) => {
      const record = opts?.recordHistory !== false;
      if (record) {
        const snap = snapshotBefore();
        if (snap && manifestRef.current) {
          undoStackRef.current.push(snap);
          if (undoStackRef.current.length > UNDO_CAP) undoStackRef.current.shift();
          redoStackRef.current.length = 0;
        }
      }
      setManifest(next);
      scheduleSave(next);
    },
    [scheduleSave, snapshotBefore]
  );

  const appendDuplicateToGallery = useCallback(
    async (sourceRelPath: string, crop?: SequenceFrameItem["crop"]) => {
      const src = sourceRelPath.trim();
      if (!src) return;
      try {
        const { relPath } = await apiSequenceDuplicateAsset({
          charKey,
          sequenceName,
          sourceRelPath: src,
          subfolder: "gallery",
        });
        const prev = manifestRef.current;
        if (!prev) return;
        const m: SequenceManifest = {
          ...prev,
          gallery: [...prev.gallery, { id: newGalleryId(), relPath, crop: cloneCrop(crop) }],
        };
        commitManifest(m);
      } catch (e) {
        onErrorRef.current("Add to gallery failed.", e);
      }
    },
    [charKey, sequenceName, commitManifest]
  );

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const m = manifestRef.current;
    if (m) {
      await apiSequencePut(charKey, sequenceName, m).catch((e) =>
        onErrorRef.current("Save sequence failed.", e)
      );
    }
  }, [charKey, sequenceName]);

  useEffect(() => {
    return () => {
      void flushSave();
    };
  }, [flushSave]);

  useEffect(() => {
    registerFlushSave?.(flushSave);
    return () => registerFlushSave?.(null);
  }, [flushSave, registerFlushSave]);

  const timelineExportableCount = useMemo(() => {
    if (!manifest?.frames?.length) return 0;
    let n = 0;
    for (const fr of manifest.frames) {
      if (fr.hidden) continue;
      if ((fr.relPath || "").trim()) n += 1;
    }
    return n;
  }, [manifest]);

  const downloadTimelineMp4 = useCallback(() => {
    void (async () => {
      if (!manifest) return;
      setTimelineExportBusy(true);
      try {
        const blob = await apiSequenceExportTimelineMp4Blob({ charKey, sequenceName });
        const safe =
          sequenceName.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "sequence";
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safe}_timeline.mp4`;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (e) {
        onErrorRef.current("Download timeline MP4 failed.", e);
      } finally {
        setTimelineExportBusy(false);
      }
    })();
  }, [charKey, sequenceName, manifest]);

  const downloadGalleryFrameSetMp4 = useCallback(
    (galleryId: string) => {
      void (async () => {
        try {
          await flushSave();
        } catch {
          /* best-effort before export */
        }
        setGallerySetDownloadId(galleryId);
        try {
          const blob = await apiSequenceExportGalleryFrameSetMp4Blob({
            charKey,
            sequenceName,
            galleryId,
          });
          const safe =
            sequenceName.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "sequence";
          const safeGid = galleryId.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "set";
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${safe}_${safeGid}_set.mp4`;
          a.rel = "noopener";
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (e) {
          onErrorRef.current("Download sequence set MP4 failed.", e);
        } finally {
          setGallerySetDownloadId(null);
        }
      })();
    },
    [charKey, sequenceName, flushSave]
  );

  const setFramesHidden = useCallback(
    (indices: number[], hidden: boolean) => {
      const prev = manifestRef.current;
      if (!prev) return;
      const map = framesByIndex(prev);
      let changed = false;
      for (const i of indices) {
        const v = map.get(i);
        if (!v) continue;
        const cur = Boolean(v.hidden);
        if (cur === hidden) continue;
        map.set(i, { ...v, hidden: hidden || undefined });
        changed = true;
      }
      if (!changed) return;
      const m: SequenceManifest = { ...prev, frames: toFramesArray(map) };
      commitManifest(m);
    },
    [commitManifest]
  );

  const removeFramesBatch = useCallback(
    (indices: number[]) => {
      const prev = manifestRef.current;
      if (!prev) return;
      const map = framesByIndex(prev);
      const toRemove = indices.filter((i) => map.has(i));
      if (!toRemove.length) return;
      for (const i of toRemove) map.delete(i);
      const m: SequenceManifest = { ...prev, frames: toFramesArray(map) };
      commitManifest(m);
      setSelectedFrameIndices((prevSel) => {
        const next = new Set(prevSel);
        for (const i of toRemove) next.delete(i);
        return next;
      });
      setFrameMenu(null);
    },
    [commitManifest]
  );

  const removeGalleryItemsByIds = useCallback(
    (ids: string[]) => {
      const prev = manifestRef.current;
      if (!prev || !ids.length) return;
      const idSet = new Set(ids);
      const removedItems = prev.gallery.filter((g) => idSet.has(g.id));
      const groupIds = new Set(
        removedItems
          .map((g) => g.frameSequence?.sequenceGroupId)
          .filter((x): x is string => typeof x === "string" && x.length > 0)
      );
      let frames = prev.frames;
      if (groupIds.size) {
        frames = prev.frames.map((fr) => {
          if (fr.sequenceGroupId && groupIds.has(fr.sequenceGroupId)) {
            const next: SequenceFrameItem = { ...fr };
            delete next.sequenceGroupId;
            return next;
          }
          return fr;
        });
      }
      const gallery = prev.gallery.filter((g) => !idSet.has(g.id));
      const m: SequenceManifest = { ...prev, gallery, frames };
      commitManifest(m);
      setGalleryMenu(null);
      setSelectedGalleryId((sel) => (sel && idSet.has(sel) ? null : sel));
    },
    [commitManifest]
  );

  const copyForScope = useCallback(
    (scope: "gallery" | "timeline") => {
      const man = manifestRef.current;
      if (!man) return;
      if (scope === "gallery") {
        if (!selectedGalleryId) return;
        const g = man.gallery.find((x) => x.id === selectedGalleryId);
        if (!g) return;
        if (g.frameSequence) {
          clipRef.current = {
            kind: "galleryFs",
            galleryId: g.id,
            crop: cloneCrop(g.crop),
            fallbackThumbRelPath: g.relPath,
            frameSequence: cloneFrameSequencePayload(g.frameSequence),
          };
        } else {
          clipRef.current = {
            kind: "gallery",
            relPath: g.relPath,
            galleryId: g.id,
            crop: cloneCrop(g.crop),
          };
        }
      } else {
        const withFrame = [...selectedFrameIndices]
          .filter((i) => man.frames.some((f) => f.index === i))
          .sort((a, b) => a - b);
        const items: TimelineClipboardItem[] = [];
        for (const i of withFrame) {
          const row = man.frames.find((f) => f.index === i);
          if (row)
            items.push({
              relPath: row.relPath,
              crop: cloneCrop(row.crop),
              index: row.index,
            });
        }
        if (items.length) clipRef.current = { kind: "timeline", items };
      }
    },
    [selectedGalleryId, selectedFrameIndices]
  );

  const insertGalleryFrameSequenceDuplicate = useCallback(
    async (
      insertAt: number,
      args: {
        frameSequence: FrameSequencePayload;
        fallbackThumbRelPath: string;
        crop?: SequenceFrameItem["crop"];
      }
    ) => {
      const man = manifestRef.current;
      if (!man) return;
      const row = await duplicateFrameSequenceToGalleryRow({
        charKey,
        sequenceName,
        sourceFs: args.frameSequence,
        fallbackThumbRelPath: args.fallbackThumbRelPath,
        sourceCrop: args.crop,
      });
      const newId = newGalleryId();
      const gal = [...man.gallery];
      gal.splice(insertAt, 0, { id: newId, ...row });
      commitManifest({ ...man, gallery: gal });
      setSelectedGalleryId(newId);
    },
    [charKey, sequenceName, commitManifest]
  );

  const pasteForScope = useCallback(
    (scope: "gallery" | "timeline") => {
      void (async () => {
        try {
          const man = manifestRef.current;
          const clip = clipRef.current;
          if (!man || !clip) return;
          if (scope === "gallery") {
            const addOne = async (sourceRelPath: string) => {
              const { relPath } = await apiSequenceDuplicateAsset({
                charKey,
                sequenceName,
                sourceRelPath,
                subfolder: "gallery",
              });
              return relPath;
            };
            const anchorId =
              clip.kind === "gallery" || clip.kind === "galleryFs"
                ? clip.galleryId
                : selectedGalleryId;
            let insertAt = man.gallery.length;
            if (anchorId) {
              const ix = man.gallery.findIndex((g) => g.id === anchorId);
              if (ix >= 0) insertAt = ix + 1;
            }
            if (clip.kind === "galleryFs") {
              await insertGalleryFrameSequenceDuplicate(insertAt, {
                frameSequence: clip.frameSequence,
                fallbackThumbRelPath: clip.fallbackThumbRelPath,
                crop: clip.crop,
              });
            } else if (clip.kind === "gallery") {
              const relPath = await addOne(clip.relPath);
              const newId = newGalleryId();
              const gal = [...man.gallery];
              gal.splice(insertAt, 0, { id: newId, relPath });
              const m: SequenceManifest = { ...man, gallery: gal };
              commitManifest(m);
              setSelectedGalleryId(newId);
            } else {
              const newItems: SequenceGalleryItem[] = [];
              for (const it of clip.items) {
                const relPath = await addOne(it.relPath);
                newItems.push({ id: newGalleryId(), relPath });
              }
              const gal = [...man.gallery];
              gal.splice(insertAt, 0, ...newItems);
              const m: SequenceManifest = { ...man, gallery: gal };
              commitManifest(m);
              if (newItems.length)
                setSelectedGalleryId(newItems[newItems.length - 1]!.id);
            }
          } else {
            const fc = computeSequenceTimelineSpan(man);
            const fm = framesByIndex(man);
            let pasteStart = 0;
            if (selectedFrameIndices.size) {
              pasteStart = Math.min(...selectedFrameIndices);
            } else {
              let found = false;
              for (let i = 0; i < fc; i++) {
                if (!fm.get(i)) {
                  pasteStart = i;
                  found = true;
                  break;
                }
              }
              if (!found) pasteStart = fc - 1;
            }

            if (clip.kind === "galleryFs") {
              const r = await placeFrameSequenceStripOnTimeline({
                charKey,
                sequenceName,
                manifest: man,
                anchor: pasteStart,
                fs: clip.frameSequence,
                sequenceGroupId: newSequenceGroupId(),
                jobModal,
                onError: (msg, e) => onErrorRef.current(msg, e),
              });
              if (r) {
                commitManifest(r.manifest);
                setSelectedFrameIndices(new Set(r.placedIndices));
              }
            } else if (clip.kind === "gallery") {
              const { relPath } = await apiSequenceDuplicateAsset({
                charKey,
                sequenceName,
                sourceRelPath: clip.relPath,
                subfolder: "cells",
              });
              const map = framesByIndex(man);
              map.set(pasteStart, {
                cellId: newCellId(),
                relPath,
                crop: cloneCrop(clip.crop),
              });
              const m: SequenceManifest = { ...man, frames: toFramesArray(map) };
              commitManifest(m);
              setSelectedFrameIndices(new Set([pasteStart]));
            } else {
              const items = clip.items;
              const minI = items[0]!.index;
              const offset = pasteStart - minI;
              const targets = items.map((it) => it.index + offset);
              if (targets.some((t) => t < 0 || t >= fc)) {
                onErrorRef.current("Paste: clips would go outside the timeline.");
                return;
              }
              const map = framesByIndex(man);
              const nextSel = new Set<number>();
              for (const it of items) {
                const { relPath } = await apiSequenceDuplicateAsset({
                  charKey,
                  sequenceName,
                  sourceRelPath: it.relPath,
                  subfolder: "cells",
                });
                const t = it.index + offset;
                map.set(t, {
                  cellId: newCellId(),
                  relPath,
                  crop: cloneCrop(it.crop),
                });
                nextSel.add(t);
              }
              const m: SequenceManifest = { ...man, frames: toFramesArray(map) };
              commitManifest(m);
              setSelectedFrameIndices(nextSel);
            }
          }
        } catch (e) {
          onErrorRef.current("Paste failed.", e);
        }
      })();
    },
    [
      charKey,
      sequenceName,
      commitManifest,
      selectedFrameIndices,
      selectedGalleryId,
      insertGalleryFrameSequenceDuplicate,
      jobModal,
    ]
  );

  const frameCount = manifest ? computeSequenceTimelineSpan(manifest) : MIN_FRAMES;
  const frameMap = manifest ? framesByIndex(manifest) : new Map<number, FrameMapValue>();

  const visibleFrameIndices = useMemo(() => {
    if (!manifest) return [];
    return visibleTimelineColumnIndices(manifest, frameCount);
  }, [frameCount, manifest]);

  const { logicalFps, viewStep, ticksPerSecond } = useMemo(() => {
    if (!manifest) {
      return { logicalFps: 24, viewStep: 1 as const, ticksPerSecond: 24 };
    }
    const lf = Math.max(1, Math.round(manifest.fps));
    const vs = manifest.timelineViewStep === 2 ? 2 : 1;
    const tps = Math.max(1, Math.round(lf / vs));
    return { logicalFps: lf, viewStep: vs, ticksPerSecond: tps };
  }, [manifest]);

  const sortedFrames = useMemo(
    () => (manifest ? [...manifest.frames].sort((a, b) => a.index - b.index) : []),
    [manifest]
  );

  /**
   * Per-visible-column visible ordinal: null for hidden columns; otherwise a
   * 1-based running count. Labels use this so hidden columns are blank; second
   * ticks use `ticksPerSecond` (manifest.fps / editor view step).
   */
  const visOrd = useMemo<(number | null)[]>(() => {
    if (!manifest) return visibleFrameIndices.map(() => null);
    const fm = framesByIndex(manifest);
    const out: (number | null)[] = [];
    let count = 0;
    for (const i of visibleFrameIndices) {
      if (fm.get(i)?.hidden) {
        out.push(null);
      } else {
        count += 1;
        out.push(count);
      }
    }
    return out;
  }, [manifest, visibleFrameIndices]);

  const sequenceGroupOutlines = useMemo(() => {
    if (!manifest?.frames.length) return [];
    const byGid = new Map<string, number[]>();
    for (const fr of manifest.frames) {
      const gid = fr.sequenceGroupId;
      if (!gid) continue;
      const arr = byGid.get(gid) ?? [];
      arr.push(fr.index);
      byGid.set(gid, arr);
    }
    const out: { groupId: string; min: number; max: number }[] = [];
    for (const [groupId, indices] of byGid) {
      out.push({ groupId, min: Math.min(...indices), max: Math.max(...indices) });
    }
    return out;
  }, [manifest]);

  const cellW = Math.max(40, Math.round(BASE_FRAME_CELL * timelineScale));
  const rulerH = Math.max(16, Math.round(BASE_RULER_H * timelineScale));
  const footerH = Math.max(14, Math.round(BASE_FOOTER_H * timelineScale));
  const rulerFont = Math.max(9, Math.round(11 * timelineScale));
  const footerFont = Math.max(8, Math.round(10 * timelineScale));

  const onDragEnd = useCallback(
    async (ev: DragEndEvent) => {
      setDragPreviewPath(null);
      const overId = ev.over?.id;
      if (!overId) return;
      const os = String(overId);

      if (os === FS_MODAL_GALLERY_BACKDROP_DROP_ID) {
        const d = ev.active.data.current as
          | { kind?: string; relPath?: string; crop?: SequenceFrameItem["crop"] }
          | undefined;
        if (d?.kind !== "frameSeqStripSlot" || !d.relPath?.trim()) return;
        await appendDuplicateToGallery(d.relPath, d.crop);
        return;
      }

      if (!os.startsWith("frame:")) {
        const prev = manifestRef.current;
        if (!prev) return;
        const activeData = ev.active.data.current as { kind?: string } | undefined;
        if (activeData?.kind === "timeline") return;
        const activeId = String(ev.active.id);
        if (activeId === os) return;
        const galleryIds = new Set(prev.gallery.map((g) => g.id));
        if (!galleryIds.has(activeId) || !galleryIds.has(os)) return;
        const oldIndex = prev.gallery.findIndex((g) => g.id === activeId);
        const newIndex = prev.gallery.findIndex((g) => g.id === os);
        if (oldIndex < 0 || newIndex < 0) return;
        const nextGallery = arrayMove(prev.gallery, oldIndex, newIndex);
        const m: SequenceManifest = { ...prev, gallery: nextGallery };
        commitManifest(m);
        return;
      }

      const toIndex = parseInt(os.slice("frame:".length), 10);
      if (Number.isNaN(toIndex)) return;

      const active = ev.active.data.current as
        | {
            kind?: string;
            fromIndex?: number;
            cellId?: string;
            relPath?: string;
            galleryId?: string;
            crop?: SequenceFrameItem["crop"];
            frameSequence?: FrameSequencePayload;
          }
        | undefined;

      if (active?.kind === "frameSeqStripSlot") return;

      if (active?.kind === "timeline") {
        const fromIndex = active.fromIndex;
        if (fromIndex === undefined || fromIndex === toIndex) return;
        const prev = manifestRef.current;
        if (!prev) return;
        const map = framesByIndex(prev);
        const moving = map.get(fromIndex);
        if (!moving) return;

        const sel = selectedFrameIndicesRef.current;
        const occupied = [...sel]
          .filter((i) => map.has(i))
          .sort((a, b) => a - b);
        const nBlock = occupied.length;
        if (nBlock > 1 && occupied.includes(fromIndex)) {
          const delta = toIndex - fromIndex;
          const sourceSet = new Set(occupied);
          const fc = computeSequenceTimelineSpan(prev);
          if (!canPlaceTimelineShift(map, sourceSet, delta, fc)) return;
          const vals = occupied.map((i) => map.get(i)!);
          for (const i of occupied) map.delete(i);
          for (let k = 0; k < nBlock; k++) map.set(occupied[k]! + delta, vals[k]!);
          const m: SequenceManifest = { ...prev, frames: toFramesArray(map) };
          commitManifest(m);
          setSelectedFrameIndices(new Set(occupied.map((i) => i + delta)));
          return;
        }

        const target = map.get(toIndex);
        map.delete(fromIndex);
        if (target) {
          map.set(toIndex, moving);
          map.set(fromIndex, target);
        } else {
          map.set(toIndex, moving);
        }
        const m: SequenceManifest = { ...prev, frames: toFramesArray(map) };
        commitManifest(m);
        setSelectedFrameIndices(new Set([toIndex]));
        return;
      }

      if (active?.kind === "gallery" && active.frameSequence) {
        const fs = active.frameSequence;
        const anchor = toIndex;
        if (anchor < 0) return;
        const prev = manifestRef.current;
        if (!prev) return;
        const r = await placeFrameSequenceStripOnTimeline({
          charKey,
          sequenceName,
          manifest: prev,
          anchor,
          fs,
          sequenceGroupId: fs.sequenceGroupId,
          jobModal,
          onError: (msg, e) => onErrorRef.current(msg, e),
        });
        if (r) {
          commitManifest(r.manifest);
          setSelectedFrameIndices(new Set(r.placedIndices));
        }
        return;
      }

      const src = active?.relPath;
      const galleryId = active?.galleryId;
      if (!src) return;
      try {
        const { relPath } = await apiSequenceDuplicateAsset({
          charKey,
          sequenceName,
          sourceRelPath: src,
          subfolder: "cells",
        });
        const prev = manifestRef.current;
        if (!prev) return;
        const map = framesByIndex(prev);
        let inherited = cloneCrop(undefined);
        if (galleryId) {
          const g = prev.gallery.find((x) => x.id === galleryId);
          if (g) inherited = cloneCrop(g.crop);
        }
        map.set(toIndex, { cellId: newCellId(), relPath, crop: inherited });
        const m: SequenceManifest = {
          ...prev,
          frames: toFramesArray(map),
        };
        commitManifest(m);
      } catch (e) {
        onErrorRef.current("Drop to frame failed.", e);
      }
    },
    [charKey, sequenceName, commitManifest, appendDuplicateToGallery, jobModal]
  );

  const onFrameContextMenu = useCallback((e: React.MouseEvent, frameIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    setGalleryMenu(null);
    setFocusScope("timeline");
    setSelectedFrameIndices((prev) => {
      if (prev.has(frameIndex)) return prev;
      timelineAnchorRef.current = frameIndex;
      return new Set([frameIndex]);
    });
    setFrameMenu({ open: true, x: e.clientX, y: e.clientY, frameIndex });
  }, []);

  const onGalleryContextMenu = useCallback((e: React.MouseEvent, galleryIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    setFrameMenu(null);
    setFocusScope("gallery");
    const id = manifest?.gallery[galleryIndex]?.id;
    if (!id) return;
    setSelectedGalleryId((prev) => (prev === id ? prev : id));
    setGalleryMenu({ open: true, x: e.clientX, y: e.clientY, galleryIndex });
  }, [manifest]);

  const frameMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!frameMenu?.open || !manifest) return [];
    const fm = framesByIndex(manifest);
    const occupied = [...selectedFrameIndices].filter((i) => fm.has(i));
    const n = occupied.length;
    const label = n > 1 ? `Remove ${n} frames` : "Remove frame";
    const previewFrameIndex = frameMenu.frameIndex;
    const flf = canGenerateFlfSelection(selectedFrameIndices, manifest);
    const i2v = canGenerateI2vSelection(selectedFrameIndices, manifest);
    const cellGid = fm.get(frameMenu.frameIndex)?.sequenceGroupId;
    const editGalleryIx =
      cellGid == null
        ? -1
        : manifest.gallery.findIndex((g) => g.frameSequence?.sequenceGroupId === cellGid);
    const items: ContextMenuItem[] = [];
    if (flf.ok) {
      items.push({
        key: "flf",
        label: "Generate FLF video",
        onSelect: () =>
          setFlfDialog({ open: true, start: flf.start, end: flf.end, length: 33 }),
      });
    }
    if (i2v.ok) {
      items.push({
        key: "i2v",
        label: "Generate I2V video",
        onSelect: () =>
          setI2vDialog({ open: true, frameIndex: i2v.frameIndex, length: 129, prompt: "" }),
      });
    }
    if (editGalleryIx >= 0) {
      items.push({
        key: "editFs",
        label: "Edit Frame Sequence",
        onSelect: () => setFrameSeqModal({ galleryIndex: editGalleryIx }),
      });
    }
    const anyVisible = occupied.some((i) => !fm.get(i)?.hidden);
    const anyHidden = occupied.some((i) => fm.get(i)?.hidden);
    if (anyVisible) {
      const hideLabel = occupied.length > 1 ? `Hide ${occupied.length} frames` : "Hide frame";
      items.push({
        key: "hide",
        label: hideLabel,
        onSelect: () => setFramesHidden(occupied, true),
      });
    }
    if (anyHidden) {
      const unhideLabel = occupied.length > 1 ? `Unhide ${occupied.length} frames` : "Unhide frame";
      items.push({
        key: "unhide",
        label: unhideLabel,
        onSelect: () => setFramesHidden(occupied, false),
      });
    }
    items.push(
      {
        key: "remove",
        label,
        onSelect: () => removeFramesBatch(occupied),
      },
      {
        key: "preview",
        label: "Preview",
        onSelect: () => {
          const colSet = new Set(visibleFrameIndices);
          const visible = sortedFrames.filter((f) => !f.hidden);
          const sparse = visible.filter((f) => colSet.has(f.index));
          const ix = sparse.findIndex((f) => f.index === previewFrameIndex);
          if (ix >= 0) setPreview({ scope: "timeline", index: ix });
        },
      }
    );
    const cellForGallery = fm.get(frameMenu.frameIndex);
    const gallerySrc = cellForGallery?.relPath?.trim();
    if (gallerySrc) {
      items.push({
        key: "addGallery",
        label: "Add frame to gallery",
        onSelect: () => void appendDuplicateToGallery(gallerySrc, cellForGallery?.crop),
      });
    }
    return items;
  }, [
    frameMenu,
    manifest,
    selectedFrameIndices,
    removeFramesBatch,
    setFramesHidden,
    sortedFrames,
    appendDuplicateToGallery,
    visibleFrameIndices,
  ]);

  const galleryMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!galleryMenu?.open || !manifest) return [];
    const gi = galleryMenu.galleryIndex;
    const g = manifest.gallery[gi];
    const items: ContextMenuItem[] = [];
    if (g?.frameSequence) {
      items.push({
        key: "editFs",
        label: "Edit Frame Sequence",
        onSelect: () => setFrameSeqModal({ galleryIndex: gi }),
      });
    }
    items.push({
      key: "preview",
      label: "Preview",
      onSelect: () => setPreview({ scope: "gallery", index: gi }),
    });
    if (g?.relPath?.trim() && g.id && onAiEditSequenceGallery) {
      items.push({
        key: "aiEdit",
        label: "AI Edit",
        onSelect: () =>
          onAiEditSequenceGallery({ relPath: g.relPath.trim(), galleryItemId: g.id }),
      });
    }
    if (g?.relPath?.trim() && g.id && onNewAngleSequenceGallery) {
      items.push({
        key: "newAngle",
        label: "New Angle",
        onSelect: () =>
          onNewAngleSequenceGallery({ relPath: g.relPath.trim(), galleryItemId: g.id }),
      });
    }
    items.push({
      key: "delGal",
      label: "Delete",
      onSelect: () => {
        const id = manifest.gallery[gi]?.id;
        if (!id) return;
        removeGalleryItemsByIds([id]);
      },
    });
    if (g?.frameSequence) {
      items.push({
        key: "makeCopyFs",
        label: "Make Copy",
        onSelect: () =>
          void insertGalleryFrameSequenceDuplicate(gi + 1, {
            frameSequence: g.frameSequence!,
            fallbackThumbRelPath: g.relPath,
            crop: g.crop,
          }),
      });
    }
    if (g?.frameSequence && g.id) {
      items.push({
        key: "downloadSetMp4",
        label: gallerySetDownloadId === g.id ? "Exporting…" : "Download set",
        disabled: gallerySetDownloadId != null,
        onSelect: () => downloadGalleryFrameSetMp4(g.id),
      });
    }
    return items;
  }, [
    galleryMenu,
    manifest,
    removeGalleryItemsByIds,
    insertGalleryFrameSequenceDuplicate,
    gallerySetDownloadId,
    downloadGalleryFrameSetMp4,
    onAiEditSequenceGallery,
    onNewAngleSequenceGallery,
  ]);

  const sequenceStripActions = useMemo((): FrameSequenceStripActions | undefined => {
    if (frameSeqModal == null || !manifest) return undefined;
    const gi = frameSeqModal.galleryIndex;
    const g = manifest.gallery[gi];
    const firstRel = g?.frameSequence?.strip?.find(
      (s) => s.kind === "image" && s.relPath?.trim()
    );
    const outputDirRel = firstRel?.kind === "image" && firstRel.relPath
      ? outputDirFromRelPath(firstRel.relPath)
      : "";
    if (!outputDirRel) return undefined;
    const jm = jobModal;
    return {
      busy: false,
      onRemoveBackground: async (relPaths) => {
        jm?.begin({ title: "Removing background", clearLog: true });
        await Promise.resolve();
        const out: string[] = [];
        try {
          for (const rel of relPaths) {
            jm?.log(`Removing background: ${rel.split("/").pop() ?? "frame"}…`);
            const done = await runShotRemoveBgWsJob({
              imageRelPath: rel,
              inPlace: true,
              onLogLine: (line) => jm?.log(line),
            });
            const nextRel = done.result?.relPath;
            if (!done.ok || !nextRel) throw new Error(done.error || "Remove background failed.");
            out.push(nextRel);
          }
          jm?.end();
          return out;
        } catch (e) {
          jm?.fail(e, "Remove background failed.");
          throw e;
        }
      },
      onAiEdit: (relPath) =>
        new Promise<string>((resolve) => {
          stripAiEditResolveRef.current = resolve;
          stripAiEditRelRef.current = relPath;
          setStripAiEditImageSrc(assetUrlFromRelPath(relPath));
          setStripAiEditOpen(true);
        }),
      onGenerateI2v: async (relPath, prompt, length) => {
        jm?.begin({ title: "Generating strip I2V", clearLog: true });
        await Promise.resolve();
        try {
          const r = await apiSequenceStripGenerateI2v({
            charKey,
            sequenceName,
            sourceRelPath: relPath,
            outputDirRel,
            length,
            positivePrompt: prompt,
          });
          jm?.end();
          return r.relPaths;
        } catch (e) {
          jm?.fail(e, "Strip I2V failed.");
          throw e;
        }
      },
      onGenerateFlf: async (relPathA, relPathB, length) => {
        jm?.begin({ title: "Generating strip FLF", clearLog: true });
        await Promise.resolve();
        try {
          const r = await apiSequenceStripGenerateFlf({
            charKey,
            sequenceName,
            imageRelPathA: relPathA,
            imageRelPathB: relPathB,
            outputDirRel,
            length,
          });
          jm?.end();
          return r.relPaths;
        } catch (e) {
          jm?.fail(e, "Strip FLF failed.");
          throw e;
        }
      },
    };
  }, [frameSeqModal, manifest, charKey, sequenceName, jobModal]);

  const runStripAiEdit = useCallback(
    async (promptText: string, maskPngBase64?: string) => {
      const resolve = stripAiEditResolveRef.current;
      const sourceRelPath = stripAiEditRelRef.current;
      stripAiEditResolveRef.current = null;
      stripAiEditRelRef.current = null;
      setStripAiEditOpen(false);
      if (!resolve || !sourceRelPath) return;
      const jm = jobModal;
      jm?.begin({ title: "AI Editing frame", clearLog: true });
      await Promise.resolve();
      try {
        const done = await runDetailWsJob<{ fileRelPath: string }>({
          charKey,
          pathSuffix: "/dataset/ws",
          payload: {
            job: "ai_edit_sequence_gallery_image",
            sequenceName,
            sourceRelPath,
            promptText,
            ...(maskPngBase64 ? { maskPngBase64 } : {}),
          },
          onLogLine: (line) => jm?.log(line),
        });
        if (!done.ok || !done.result?.fileRelPath) {
          throw new Error(done.error ?? "AI Edit failed");
        }
        jm?.end();
        resolve(done.result.fileRelPath);
      } catch (e) {
        jm?.fail(e, "AI Edit failed.");
        throw e;
      }
    },
    [charKey, sequenceName, jobModal]
  );

  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Delete" || ev.key === "Backspace") {
        if (!ev.ctrlKey && !ev.metaKey && !isEditableTarget(ev.target)) {
          if (frameSeqModal != null) return;
          const m = manifestRef.current;
          if (focusScope === "timeline" && selectedFrameIndices.size && m) {
            const fm = framesByIndex(m);
            const toDel = [...selectedFrameIndices].filter((i) => fm.has(i));
            if (toDel.length) {
              ev.preventDefault();
              removeFramesBatch(toDel);
              return;
            }
          }
          if (focusScope === "gallery" && selectedGalleryId && m) {
            ev.preventDefault();
            removeGalleryItemsByIds([selectedGalleryId]);
            return;
          }
        }
      }

      if (!(ev.ctrlKey || ev.metaKey)) return;
      if (!manifestRef.current) return;

      const k = ev.key.toLowerCase();
      if ((k === "z" || k === "y") && !shouldDeferSequenceEditorUndoRedo(ev)) {
        if (frameSeqModal != null) return;
        if (k === "z" && !ev.shiftKey) {
          ev.preventDefault();
          undo();
          return;
        }
        if ((k === "z" && ev.shiftKey) || k === "y") {
          ev.preventDefault();
          redo();
          return;
        }
      }

      if (k !== "c" && k !== "v") return;
      if (frameSeqModal != null) return;
      if (shouldDeferSequenceEditorClipboard(ev, editorRootRef.current)) return;
      if (k === "c") {
        ev.preventDefault();
        copyForScope(focusScope);
        return;
      }
      if (k === "v") {
        ev.preventDefault();
        pasteForScope(focusScope);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    focusScope,
    selectedGalleryId,
    selectedFrameIndices,
    charKey,
    sequenceName,
    scheduleSave,
    removeFramesBatch,
    removeGalleryItemsByIds,
    copyForScope,
    pasteForScope,
    undo,
    redo,
    frameSeqModal,
  ]);

  const gallerySortableIds = useMemo(
    () => (manifest?.gallery ?? []).map((g) => g.id),
    [manifest]
  );

  if (!manifest) {
    return <div style={{ padding: 16 }}>Loading sequence…</div>;
  }

  return (
    <div ref={editorRootRef} style={{ marginTop: 12 }}>
      <DesktopContextMenu
        open={frameMenu?.open ?? false}
        x={frameMenu?.x ?? 0}
        y={frameMenu?.y ?? 0}
        items={frameMenuItems}
        onClose={() => setFrameMenu(null)}
      />
      <DesktopContextMenu
        open={galleryMenu?.open ?? false}
        x={galleryMenu?.x ?? 0}
        y={galleryMenu?.y ?? 0}
        items={galleryMenuItems}
        onClose={() => setGalleryMenu(null)}
      />
      {flfDialog?.open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Generate FLF video"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 10040,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onMouseDown={() => setFlfDialog(null)}
        >
          <div
            data-native-clipboard-shortcuts
            style={{
              background: "#0b0b0b",
              color: "#eee",
              padding: 14,
              borderRadius: 0,
              maxWidth: 400,
              width: "100%",
              border: "1px solid rgba(255,255,255,0.22)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Generate FLF video</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 12 }}>
              Timeline {flfDialog.start} → {flfDialog.end} (endpoints only; gap must be empty).
            </div>
            <div style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
              <span style={{ display: "block", marginBottom: 2 }}>
                Output length (frames, 4k+1 step 4: 25–121)
              </span>
              <SequenceOutputLengthStepper
                lengths={SEQUENCE_FLF_OUTPUT_LENGTHS}
                value={flfDialog.length}
                onChange={(next) => setFlfDialog((d) => (d ? { ...d, length: next } : null))}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setFlfDialog(null)}
                style={{
                  borderRadius: 0,
                  border: "1px solid rgba(255,255,255,0.35)",
                  background: "transparent",
                  color: "inherit",
                  padding: "6px 12px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const dlg = flfDialog;
                    if (!dlg) return;
                    const len =
                      SEQUENCE_FLF_OUTPUT_LENGTHS[
                        sequenceVideoLengthIndex(dlg.length, SEQUENCE_FLF_OUTPUT_LENGTHS)
                      ]!;
                    const jm = jobModal;
                    setFlfDialog(null);
                    try {
                      if (jm) {
                        jm.begin({ title: "Generating first–last frame video", clearLog: false });
                        jm.log(`Sequence: ${sequenceName}`);
                        jm.log(`Timeline endpoints: ${dlg.start} → ${dlg.end}`);
                        jm.log(`Output length: ${len} frames`);
                        jm.log("Saving manifest to server…");
                      }
                      await flushSave();
                      if (jm) jm.log("Calling generate_flf API…");
                      const { galleryItem } = await apiSequenceGenerateFlf({
                        charKey,
                        sequenceName,
                        startIndex: dlg.start,
                        endIndex: dlg.end,
                        length: len,
                      });
                      const prev = manifestRef.current;
                      if (!prev) {
                        if (jm) jm.end();
                        return;
                      }
                      const m: SequenceManifest = {
                        ...prev,
                        gallery: [...prev.gallery, galleryItem],
                      };
                      commitManifest(m);
                      if (jm) jm.log("Saving manifest with new FLF strip…");
                      await flushSave();
                      if (jm) {
                        jm.log("Done. Added new gallery item.");
                        jm.end();
                      }
                    } catch (e) {
                      if (jm) jm.fail(e, "Generate FLF failed (see log lines above).");
                      else onError("Generate FLF failed.", e);
                    }
                  })();
                }}
                style={{
                  borderRadius: 0,
                  border: "1px solid rgba(255,255,255,0.35)",
                  background: "rgba(255,255,255,0.12)",
                  color: "inherit",
                  padding: "6px 12px",
                  cursor: "pointer",
                }}
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {i2vDialog?.open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Generate I2V video"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 10040,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onMouseDown={() => setI2vDialog(null)}
        >
          <div
            data-native-clipboard-shortcuts
            style={{
              background: "#0b0b0b",
              color: "#eee",
              padding: 14,
              borderRadius: 0,
              maxWidth: 460,
              width: "100%",
              border: "1px solid rgba(255,255,255,0.22)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Generate I2V video</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 12 }}>
              Timeline frame {i2vDialog.frameIndex} (single start image).
            </div>
            <div style={{ display: "block", fontSize: 13, marginBottom: 6 }}>
              <span style={{ display: "block", marginBottom: 2 }}>
                Output length (latent frames): 25 (~1s), 49 (~2s), 73 (~3s), 97 (~4s), 121 (~5s),
                129 (~5.4s, default)
              </span>
              <SequenceOutputLengthStepper
                lengths={SEQUENCE_I2V_OUTPUT_LENGTHS}
                value={i2vDialog.length}
                onChange={(next) => setI2vDialog((d) => (d ? { ...d, length: next } : null))}
              />
            </div>
            <div style={{ display: "block", fontSize: 13, marginBottom: 6, marginTop: 10 }}>
              <label htmlFor="i2v-prompt" style={{ display: "block", marginBottom: 4 }}>
                Prompt
              </label>
              <textarea
                id="i2v-prompt"
                value={i2vDialog.prompt}
                onChange={(e) =>
                  setI2vDialog((d) => (d ? { ...d, prompt: e.target.value } : null))
                }
                rows={4}
                placeholder="Describe motion or scene change…"
                style={{
                  width: "100%",
                  minHeight: 72,
                  maxHeight: 160,
                  overflowY: "auto",
                  resize: "none",
                  boxSizing: "border-box",
                  padding: 8,
                  fontSize: 13,
                  lineHeight: 1.35,
                  borderRadius: 0,
                  border: "1px solid rgba(255,255,255,0.25)",
                  background: "rgba(0,0,0,0.35)",
                  color: "#eee",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setI2vDialog(null)}
                style={{
                  borderRadius: 0,
                  border: "1px solid rgba(255,255,255,0.35)",
                  background: "transparent",
                  color: "inherit",
                  padding: "6px 12px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const dlg = i2vDialog;
                    if (!dlg) return;
                    const positivePrompt = dlg.prompt.trim();
                    if (!positivePrompt) {
                      onErrorRef.current("Enter a prompt before generating I2V.");
                      return;
                    }
                    const len =
                      SEQUENCE_I2V_OUTPUT_LENGTHS[
                        sequenceVideoLengthIndex(dlg.length, SEQUENCE_I2V_OUTPUT_LENGTHS)
                      ]!;
                    const jm = jobModal;
                    setI2vDialog(null);
                    try {
                      const promptOneLine = positivePrompt.replace(/\s+/g, " ").trim();
                      const promptLog =
                        promptOneLine.length > 120
                          ? `${promptOneLine.slice(0, 120)}…`
                          : promptOneLine;
                      if (jm) {
                        jm.begin({ title: "Generating image-to-video", clearLog: false });
                        jm.log(`Sequence: ${sequenceName}`);
                        jm.log(`Timeline frame: ${dlg.frameIndex}`);
                        jm.log(`Output length: ${len}`);
                        jm.log(`Prompt: ${promptLog}`);
                        jm.log("Saving manifest to server…");
                      }
                      await flushSave();
                      if (jm) jm.log("Calling generate_i2v API…");
                      const { galleryItem } = await apiSequenceGenerateI2v({
                        charKey,
                        sequenceName,
                        frameIndex: dlg.frameIndex,
                        length: len,
                        positivePrompt,
                      });
                      const prev = manifestRef.current;
                      if (!prev) {
                        if (jm) jm.end();
                        return;
                      }
                      const m: SequenceManifest = {
                        ...prev,
                        gallery: [...prev.gallery, galleryItem],
                      };
                      commitManifest(m);
                      if (jm) jm.log("Saving manifest with new I2V strip…");
                      await flushSave();
                      if (jm) {
                        jm.log("Done. Added new gallery item.");
                        jm.end();
                      }
                    } catch (e) {
                      if (jm) jm.fail(e, "Generate I2V failed (see log lines above).");
                      else onError("Generate I2V failed.", e);
                    }
                  })();
                }}
                disabled={!i2vDialog.prompt.trim()}
                style={{
                  borderRadius: 0,
                  border: "1px solid rgba(255,255,255,0.35)",
                  background: "rgba(255,255,255,0.12)",
                  color: "inherit",
                  padding: "6px 12px",
                  cursor: i2vDialog.prompt.trim() ? "pointer" : "not-allowed",
                  opacity: i2vDialog.prompt.trim() ? 1 : 0.45,
                }}
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {preview ? (
        <SequencePreviewLightbox
          key={`seq-preview-${preview.scope}-${sequenceName}`}
          manifest={manifest}
          scope={preview.scope}
          initialIndex={preview.index}
          timelinePreviewColumnIndices={visibleFrameIndices}
          title={
            preview.scope === "gallery"
              ? `Sequence gallery: ${sequenceName}`
              : `Sequence timeline: ${sequenceName}`
          }
          onClose={() => setPreview(null)}
          onCommitManifest={commitManifest}
        />
      ) : null}
      <DndContext
        sensors={sensors}
        onDragEnd={(e) => void onDragEnd(e)}
        onDragStart={(e) => {
          const d = e.active.data.current as
            | {
                kind?: string;
                relPath?: string;
                frameSequence?: FrameSequencePayload;
              }
            | undefined;
          if (d?.kind === "frameSeqStripSlot" && d.relPath) {
            setDragPreviewPath(d.relPath);
            return;
          }
          let path = d?.relPath ?? null;
          if (d?.frameSequence?.strip?.length) {
            path = firstStripImageRelPath(d.frameSequence) ?? path;
          }
          setDragPreviewPath(path);
        }}
        onDragCancel={() => setDragPreviewPath(null)}
      >
        <div
          style={{ marginBottom: 8 }}
          onMouseDown={() => setFocusScope("gallery")}
          role="presentation"
        >
          <div style={{ marginBottom: 6 }}>Sequence gallery</div>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
            Drag the panel corner to resize · Double-click an image to preview · Ctrl+C / Ctrl+V
            duplicate full sequence sets (strip + assets) · Delete when gallery is focused
          </div>
          <ResizableScrollGallery aria-label="Sequence gallery images">
            <SortableContext items={gallerySortableIds} strategy={rectSortingStrategy}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 4 }}>
                {manifest.gallery.map((g, idx) => (
                  <GalleryThumb
                    key={g.id}
                    id={g.id}
                    relPath={g.relPath}
                    crop={g.crop}
                    frameSequence={g.frameSequence}
                    galleryIndex={idx}
                    selected={selectedGalleryId === g.id}
                    setFocusGallery={() => setFocusScope("gallery")}
                    onSelect={() => setSelectedGalleryId(g.id)}
                    onGalleryContextMenu={onGalleryContextMenu}
                    onDoubleClickPreview={() => setPreview({ scope: "gallery", index: idx })}
                  />
                ))}
              </div>
            </SortableContext>
          </ResizableScrollGallery>
        </div>

        <div
          style={{ marginTop: 16, marginBottom: 56, paddingBottom: 8 }}
          onMouseDown={() => setFocusScope("timeline")}
          role="presentation"
        >
          <div
            style={{
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
              aria-label="Timeline grid density: 24 shows every logical column per second of manifest fps; 12 shows every other column (12 visible ordinals per second when fps is 24). Does not change manifest fps."
              value={manifest.timelineViewStep === 2 ? "12" : "24"}
              onChange={(e) => {
                const v = e.target.value === "12" ? 2 : 1;
                commitManifest({ ...manifest, timelineViewStep: v }, { recordHistory: false });
              }}
              onMouseDown={(ev) => ev.stopPropagation()}
              style={{ fontSize: 13, padding: "2px 6px" }}
            >
              <option value="24">24 fps</option>
              <option value="12">12 fps</option>
            </select>
            <button
              type="button"
              onClick={() => downloadTimelineMp4()}
              disabled={timelineExportBusy || timelineExportableCount === 0}
              title={`Slideshow MP4: one frame per timeline image at ${manifest.fps} fps (sequence manifest).`}
              onMouseDown={(ev) => ev.stopPropagation()}
              style={{
                fontSize: 13,
                padding: "2px 8px",
                border: "0.5px solid rgba(0, 0, 0, 0.22)",
                borderRadius: 0,
                background: "#f2f2f2",
                cursor:
                  timelineExportBusy || timelineExportableCount === 0 ? "not-allowed" : "pointer",
                opacity: timelineExportBusy || timelineExportableCount === 0 ? 0.45 : 1,
              }}
            >
              {timelineExportBusy ? "Exporting…" : "Download timeline MP4"}
            </button>
          </div>
          <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
            Drag the panel corner to resize · Ctrl+scroll (⌘ scroll) to zoom frames · Double-click a
            frame to preview · Ctrl+C / Ctrl+V / Delete when timeline is focused
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
              value={normalizeSequencePreviewAspect(manifest.previewAspect)}
              onChange={(e) => {
                const v = e.target.value as SequencePreviewAspect;
                commitManifest({ ...manifest, previewAspect: v }, { recordHistory: false });
              }}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ fontSize: 13, padding: "4px 8px", maxWidth: 200 }}
            >
              {SEQUENCE_PREVIEW_ASPECT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div
            ref={timelineShellRef}
            style={{
              width: "min(100%, 960px)",
              maxWidth: "100%",
              overflow: "auto",
              resize: "both",
              minHeight: 160,
              minWidth: 280,
              height: 280,
              maxHeight: "min(78vh, 880px)",
              boxSizing: "border-box",
            }}
          >
            <div style={{ width: visibleFrameIndices.length * cellW }}>
              <div style={{ display: "flex", height: rulerH }}>
                {visibleFrameIndices.map((i, k) => {
                  const vo = visOrd[k];
                  const isSecondStart =
                    vo != null && (vo - 1) % ticksPerSecond === 0;
                  return (
                    <div
                      key={`s-${i}`}
                      style={{
                        width: cellW,
                        flexShrink: 0,
                        borderLeft: isSecondStart
                          ? "2px solid rgba(0,0,0,0.45)"
                          : "1px solid rgba(0,0,0,0.12)",
                        fontSize: rulerFont,
                        paddingLeft: 2,
                        boxSizing: "border-box",
                        display: "flex",
                        alignItems: "center",
                      }}
                    >
                      {isSecondStart
                        ? String(Math.floor((vo! - 1) / ticksPerSecond))
                        : ""}
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", height: footerH, marginBottom: 4 }}>
                {visibleFrameIndices.map((i, k) => {
                  const vo = visOrd[k];
                  const isSecondStart =
                    vo != null && (vo - 1) % ticksPerSecond === 0;
                  return (
                    <div
                      key={`f-${i}`}
                      style={{
                        width: cellW,
                        flexShrink: 0,
                        borderLeft: isSecondStart
                          ? "2px solid rgba(0,0,0,0.45)"
                          : "1px solid rgba(0,0,0,0.12)",
                        fontSize: footerFont,
                        textAlign: "center",
                        color: "#444",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxSizing: "border-box",
                      }}
                    >
                      {vo != null ? ((vo - 1) % ticksPerSecond) + 1 : ""}
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  border: "1px solid rgba(0,0,0,0.25)",
                  boxSizing: "border-box",
                  overflow: "visible",
                }}
              >
                <div style={{ width: visibleFrameIndices.length * cellW }}>
                  <div style={{ position: "relative", minHeight: cellW + 4 }}>
                    {sequenceGroupOutlines.map((o) => {
                      const colStart = visibleFrameIndices.findIndex((ix) => ix >= o.min);
                      let colEnd = -1;
                      for (let c = visibleFrameIndices.length - 1; c >= 0; c--) {
                        if (visibleFrameIndices[c]! <= o.max) {
                          colEnd = c;
                          break;
                        }
                      }
                      if (colStart < 0 || colEnd < colStart) return null;
                      return (
                        <div
                          key={`fs-outline-${o.groupId}`}
                          style={{
                            position: "absolute",
                            left: colStart * cellW + 3,
                            width: (colEnd - colStart + 1) * cellW - 6,
                            top: 0,
                            height: cellW,
                            boxSizing: "border-box",
                            border: "1px solid rgba(66, 153, 225, 0.75)",
                            borderRadius: 0,
                            pointerEvents: "none",
                            zIndex: 2,
                            boxShadow: "0 0 0 1px rgba(0,40,80,0.12)",
                          }}
                        >
                          <span
                            style={{
                              position: "absolute",
                              top: -13,
                              left: 4,
                              fontSize: 10,
                              lineHeight: 1,
                              letterSpacing: "0.02em",
                              color: "rgba(37, 99, 140, 0.95)",
                              background: "rgba(255,255,255,0.92)",
                              padding: "1px 4px",
                              borderRadius: 0,
                            }}
                          >
                            Frame Sequence
                          </span>
                        </div>
                      );
                    })}
                    <div style={{ display: "flex", position: "relative", zIndex: 1 }}>
                      {visibleFrameIndices.map((i) => {
                        const cell = frameMap.get(i);
                        return (
                          <FrameDropCell
                            key={`c-${i}`}
                            cellW={cellW}
                            frameIndex={i}
                            relPath={cell?.relPath ?? null}
                            cellId={cell?.cellId}
                            crop={cell?.crop}
                            sequenceGroupId={cell?.sequenceGroupId}
                            hidden={cell?.hidden}
                            selected={selectedFrameIndices.has(i)}
                            setFocusTimeline={() => setFocusScope("timeline")}
                            onCellClick={(e) => {
                              if (e.shiftKey) {
                                const anchor = timelineAnchorRef.current ?? i;
                                setSelectedFrameIndices(shiftRangeIndices(anchor, i));
                              } else {
                                timelineAnchorRef.current = i;
                                setSelectedFrameIndices(new Set([i]));
                              }
                            }}
                            onCellDoubleClick={(frameIndex) => {
                              if (!frameMap.get(frameIndex)?.relPath) return;
                              const colSet = new Set(visibleFrameIndices);
                              const visible = sortedFrames.filter((f) => !f.hidden);
                              const sparse = visible.filter((f) => colSet.has(f.index));
                              const ix = sparse.findIndex((f) => f.index === frameIndex);
                              if (ix >= 0) setPreview({ scope: "timeline", index: ix });
                            }}
                            onFrameContextMenu={onFrameContextMenu}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <div style={{ display: "flex", height: footerH }}>
                    {visibleFrameIndices.map((i) => (
                      <div
                        key={`fi-${i}`}
                        style={{
                          width: cellW,
                          flexShrink: 0,
                          borderLeft:
                            i % logicalFps === 0
                              ? "2px solid rgba(0,0,0,0.45)"
                              : "1px solid rgba(0,0,0,0.12)",
                          fontSize: Math.max(7, footerFont - 1),
                          textAlign: "center",
                          color: "#222",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={`Frame ${i}`}
                      >
                        {i}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {frameSeqModal != null &&
        manifest.gallery[frameSeqModal.galleryIndex]?.frameSequence ? (
          <FrameSequenceModal
            open
            title={`Frame sequence — ${sequenceName}`}
            initial={manifest.gallery[frameSeqModal.galleryIndex]!.frameSequence!}
            sourceGalleryIndex={frameSeqModal.galleryIndex}
            charKey={charKey}
            sequenceName={sequenceName}
            onError={onError}
            previewFps={Math.max(1, manifest.fps)}
            stripActions={sequenceStripActions}
            onClose={() => setFrameSeqModal(null)}
            onSave={(next) => {
              const gi = frameSeqModal.galleryIndex;
              const prev = manifestRef.current;
              if (!prev) return;
              const gallery = [...prev.gallery];
              const row = gallery[gi];
              if (!row) return;
              const thumb = firstStripImageRelPath(next);
              const updated: SequenceGalleryItem = {
                ...row,
                frameSequence: next,
                relPath: thumb ?? row.relPath,
              };
              gallery[gi] = updated;
              commitManifest({ ...prev, gallery });
              setFrameSeqModal(null);
            }}
          />
        ) : null}
        <DragOverlay dropAnimation={null} style={{ zIndex: 5000 }}>
          {dragPreviewPath ? (
            <img
              src={assetUrlFromRelPath(dragPreviewPath)}
              alt=""
              style={{ width: Math.max(48, cellW), height: Math.max(48, cellW), objectFit: "contain" }}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      <AiEditModal
        open={stripAiEditOpen}
        title="AI Edit frame"
        imageSrc={stripAiEditImageSrc}
        busy={false}
        onCancel={() => {
          setStripAiEditOpen(false);
          stripAiEditResolveRef.current = null;
          stripAiEditRelRef.current = null;
        }}
        onGenerate={(promptText, maskPngBase64) =>
          void runStripAiEdit(promptText, maskPngBase64)
        }
      />
    </div>
  );
}
