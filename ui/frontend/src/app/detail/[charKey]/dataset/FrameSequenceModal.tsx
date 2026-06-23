"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useDraggable, useDroppable, useDndContext } from "@dnd-kit/core";
import {
  apiSequenceDuplicateAsset,
  assetUrlFromRelPath,
  type FrameSequencePayload,
  type FrameSequenceStripSlot,
  type SequenceCrop,
} from "../../../../lib/api";
import { isEditableTarget } from "../../../../lib/nativeClipboardShortcuts";
import { GalleryImagePager } from "../../../../components/GalleryImagePager";
import {
  PauseBarsIcon,
  SquareIconButton,
  TimelinePlayIcon,
  TriangleIcon,
} from "../../../../components/IconPrimitives";
import { cloneCrop } from "../../../../lib/sequenceCrop";
import {
  frameSequenceStripSlotHasTimelineImage,
  FS_MODAL_GALLERY_BACKDROP_DROP_ID,
} from "./sequenceGalleryUtils";
import {
  SEQUENCE_CROP_OUTER_CLIP_FLEX,
  sequenceCropTransformWrapperStyle,
} from "../../../../lib/sequenceCrop";
import {
  DesktopContextMenu,
  type ContextMenuItem,
} from "../../../../components/DesktopContextMenu";
import {
  SEQUENCE_FLF_OUTPUT_LENGTHS,
  SEQUENCE_I2V_OUTPUT_LENGTHS,
  SequenceOutputLengthStepper,
} from "../../../../components/sequenceOutputLength";
import {
  alignFrameStripsToLength,
  canGenerateFlfFromStripSelection,
  canGenerateI2vFromStripSelection,
  frameSequenceStripSlotHasImage,
  occupiedStripSelectionCount,
  payloadFromAlignedStrips,
  relPathsFromStripSelection,
  reverseStripSelection,
  spliceStripFrames,
} from "../../../../components/frameSequenceStripUtils";

export type FrameSequenceEditorMode = "sequence" | "timeline";

export type FrameSequenceStripActions = {
  busy?: boolean;
  onRemoveBackground?: (relPaths: string[]) => Promise<string[] | void>;
  onAiEdit?: (relPath: string) => Promise<string | void>;
  onGenerateI2v?: (
    relPath: string,
    prompt: string,
    length: number
  ) => Promise<string[] | void>;
  onGenerateFlf?: (
    relPathA: string,
    relPathB: string,
    length: number
  ) => Promise<string[] | void>;
};

const CELL = 72;

/** Match [AngleSubsetModal] Cancel / Generate chrome */
const modalBtnSecondary: CSSProperties = {
  borderRadius: 0,
  border: "1px solid rgba(255,255,255,0.35)",
  background: "transparent",
  color: "#eee",
  padding: "6px 14px",
  cursor: "pointer",
};

const modalBtnSecondaryDisabled: CSSProperties = {
  ...modalBtnSecondary,
  opacity: 0.45,
  cursor: "not-allowed",
};

const modalBtnPrimary: CSSProperties = {
  borderRadius: 0,
  border: "1px solid rgba(255,255,255,0.35)",
  background: "rgba(80,120,200,0.35)",
  color: "#eee",
  padding: "6px 14px",
  cursor: "pointer",
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.85,
  marginBottom: 6,
};

/** Match [`GalleryImagePager`] `MODAL_BTN` for preview transport. */
const previewTransportBtnStyle: CSSProperties = {
  color: "#eee",
  borderColor: "rgba(238,238,238,0.9)",
  background: "rgba(238,238,238,0.15)",
};

function cloneStripSlot(s: FrameSequenceStripSlot): FrameSequenceStripSlot {
  if (s.kind === "image") {
    return {
      kind: "image",
      relPath: s.relPath || "",
      crop: cloneCrop(s.crop),
      ...(s.hidden ? { hidden: true } : {}),
    };
  }
  return s.hidden ? { kind: "empty", hidden: true } : { kind: "empty" };
}

/** Legacy `hidden[]` → splice hidden image slots into strip; callers use returned strip only. */
function migrateLegacyFrameSequence(fs: FrameSequencePayload): FrameSequenceStripSlot[] {
  const base = fs.strip.map(cloneStripSlot);
  if (!fs.hidden?.length) return base;
  let strip = [...base];
  const sorted = [...fs.hidden].sort((a, b) => a.afterIndex - b.afterIndex);
  for (const h of sorted) {
    const at = Math.min(Math.max(0, h.afterIndex + 1), strip.length);
    strip.splice(at, 0, {
      kind: "image",
      relPath: h.relPath,
      crop: cloneCrop(h.crop),
      hidden: true,
    });
  }
  return strip;
}

function visibleStripIndices(strip: FrameSequenceStripSlot[]): number[] {
  return strip
    .map((slot, i) => (slot.kind === "image" && slot.hidden ? -1 : i))
    .filter((i): i is number => i >= 0);
}

/** Next strip index when moving forward, only among non-hidden cells (skips hidden images; wraps). */
function nextVisibleStripIndexAfter(
  strip: FrameSequenceStripSlot[],
  currentStripIndex: number
): number {
  const vis = visibleStripIndices(strip);
  if (vis.length === 0) {
    return Math.max(0, Math.min(currentStripIndex, Math.max(0, strip.length - 1)));
  }
  for (const vi of vis) {
    if (vi > currentStripIndex) return vi;
  }
  return vis[0]!;
}

/** First visible strip index at or after focus; wraps to first if none after (for play start). */
function firstVisibleStripIndexAtOrAfterFocus(
  strip: FrameSequenceStripSlot[],
  focusIdx: number
): number {
  const vis = visibleStripIndices(strip);
  if (vis.length === 0) return 0;
  for (const vi of vis) {
    if (vi >= focusIdx) return vi;
  }
  return vis[0]!;
}

/** Index into `visibleStripIndices(strip)` for `stripIndex`, or nearest visible at or before. */
function positionInVisibleOrNearest(strip: FrameSequenceStripSlot[], stripIndex: number): number {
  const vis = visibleStripIndices(strip);
  if (!vis.length) return 0;
  const direct = vis.indexOf(stripIndex);
  if (direct >= 0) return direct;
  for (let j = vis.length - 1; j >= 0; j--) {
    if (vis[j]! <= stripIndex) return j;
  }
  return 0;
}

/** Slot to show in large preview at strip index (hold previous visible image for empty / strip-hidden). */
function previewDisplaySlot(
  strip: FrameSequenceStripSlot[],
  index: number
): FrameSequenceStripSlot | null {
  if (!strip.length) return null;
  const ix = Math.min(Math.max(0, index), strip.length - 1);
  const at = strip[ix]!;
  if (frameSequenceStripSlotHasTimelineImage(at)) return at;
  for (let j = ix; j >= 0; j--) {
    const s = strip[j]!;
    if (frameSequenceStripSlotHasTimelineImage(s)) return s;
  }
  return null;
}

type FrameSeqStripClip = {
  kind: "frameSeqStrip";
  items: { relPath: string; crop?: SequenceCrop; hidden?: boolean }[];
};

function payloadFromState(sequenceGroupId: string, strip: FrameSequenceStripSlot[]): FrameSequencePayload {
  return {
    sequenceGroupId,
    strip: strip.map((s) =>
      s.kind === "image"
        ? {
            kind: "image",
            relPath: s.relPath || "",
            crop: cloneCrop(s.crop),
            ...(s.hidden ? { hidden: true } : {}),
          }
        : s.hidden
          ? { kind: "empty", hidden: true }
          : { kind: "empty" }
    ),
    hidden: [],
  };
}

function StripDraggableCell(props: {
  stripIndex: number;
  sourceGalleryIndex: number;
  slot: FrameSequenceStripSlot;
  selected: boolean;
  isFocus: boolean;
  /** Index in visible strip (play/export); null for hidden image cells. */
  visibleFooterLabel: number | null;
  onStripSlotClick: (i: number, ev: React.MouseEvent) => void;
  onStripSlotContextMenu?: (i: number, ev: React.MouseEvent) => void;
  disableDrag?: boolean;
}) {
  const {
    stripIndex,
    sourceGalleryIndex,
    slot,
    selected,
    isFocus,
    visibleFooterLabel,
    onStripSlotClick,
    onStripSlotContextMenu,
    disableDrag = false,
  } = props;
  const canDrag =
    !disableDrag && slot.kind === "image" && !!slot.relPath?.trim() && !slot.hidden;
  const id = `fs-strip:${sourceGalleryIndex}:${stripIndex}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id,
    disabled: !canDrag,
    data:
      canDrag && slot.kind === "image"
        ? {
            kind: "frameSeqStripSlot" as const,
            sourceGalleryIndex,
            stripIndex,
            relPath: slot.relPath,
            crop: cloneCrop(slot.crop),
          }
        : undefined,
  });

  const titleHint =
    visibleFooterLabel != null
      ? `Strip #${stripIndex} · timeline ${visibleFooterLabel}`
      : `Strip #${stripIndex} (hidden from timeline)`;

  return (
    <button
      ref={setNodeRef}
      type="button"
      title={titleHint}
      {...(canDrag ? listeners : {})}
      {...(canDrag ? attributes : {})}
      onClick={(ev) => onStripSlotClick(stripIndex, ev)}
      onContextMenu={
        onStripSlotContextMenu
          ? (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              onStripSlotContextMenu(stripIndex, ev);
            }
          : undefined
      }
      style={{
        width: CELL,
        minHeight: CELL + 14,
        padding: 2,
        boxSizing: "border-box",
        border: selected ? "2px solid #4af" : "1px solid rgba(255,255,255,0.18)",
        background: "transparent",
        flexShrink: 0,
        cursor: canDrag ? "grab" : "pointer",
        opacity: isDragging ? 0.45 : 1,
        touchAction: canDrag ? "none" : undefined,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div style={{ width: "100%", height: CELL, position: "relative", flexShrink: 0 }}>
        {slot.kind === "image" && slot.relPath ? (
          <>
            <div style={{ ...SEQUENCE_CROP_OUTER_CLIP_FLEX, height: "100%" }}>
              <div style={sequenceCropTransformWrapperStyle(slot.crop)}>
                <img
                  src={assetUrlFromRelPath(slot.relPath)}
                  alt=""
                  style={{ maxWidth: "100%", maxHeight: CELL, objectFit: "contain", display: "block" }}
                />
              </div>
            </div>
            {slot.hidden ? (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(0,0,0,0.45)",
                  pointerEvents: "none",
                }}
              />
            ) : null}
          </>
        ) : (
          <div style={{ width: "100%", height: CELL }} />
        )}
      </div>
      <div style={{ fontSize: 10, color: slot.hidden ? "#666" : "#888", lineHeight: 1, paddingTop: 2 }}>
        {stripIndex + 1}
      </div>
    </button>
  );
}

function GroupStripStackedColumn(props: {
  stripIndex: number;
  layers: Array<{ clipId: string; label: string; slot: FrameSequenceStripSlot }>;
  selected: boolean;
  isFocus: boolean;
  visibleFooterLabel: number | null;
  onStripSlotClick: (i: number, ev: React.MouseEvent) => void;
  onLayerContextMenu: (clipId: string, stripIndex: number, ev: React.MouseEvent) => void;
}) {
  const {
    stripIndex,
    layers,
    selected,
    isFocus,
    visibleFooterLabel,
    onStripSlotClick,
    onLayerContextMenu,
  } = props;
  const layerCount = Math.max(1, layers.length);
  const thumbH = Math.max(16, Math.floor(CELL / layerCount));

  return (
    <button
      type="button"
      title={`Strip #${stripIndex}`}
      onClick={(ev) => onStripSlotClick(stripIndex, ev)}
      style={{
        width: CELL,
        minHeight: CELL + 14,
        padding: 2,
        boxSizing: "border-box",
        border: selected ? "2px solid #4af" : "1px solid rgba(255,255,255,0.18)",
        background: "transparent",
        flexShrink: 0,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div style={{ width: "100%", flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
        {layers.map((layer) => (
          <div
            key={layer.clipId}
            title={layer.label}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              onLayerContextMenu(layer.clipId, stripIndex, ev);
            }}
            style={{
              width: "100%",
              height: thumbH,
              position: "relative",
              flexShrink: 0,
              borderBottom: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            {layer.slot.kind === "image" && layer.slot.relPath ? (
              <>
                <div style={{ ...SEQUENCE_CROP_OUTER_CLIP_FLEX, height: "100%" }}>
                  <div style={sequenceCropTransformWrapperStyle(layer.slot.crop)}>
                    <img
                      src={assetUrlFromRelPath(layer.slot.relPath)}
                      alt=""
                      style={{
                        maxWidth: "100%",
                        maxHeight: thumbH,
                        objectFit: "contain",
                        display: "block",
                      }}
                    />
                  </div>
                </div>
                {layer.slot.hidden ? (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: "rgba(0,0,0,0.45)",
                      pointerEvents: "none",
                    }}
                  />
                ) : null}
              </>
            ) : (
              <div style={{ width: "100%", height: thumbH }} />
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "#888", lineHeight: 1, paddingTop: 2 }}>
        {stripIndex + 1}
      </div>
    </button>
  );
}

export function FrameSequenceModal(props: {
  open: boolean;
  title: string;
  initial: FrameSequencePayload;
  sourceGalleryIndex: number;
  charKey: string;
  sequenceName: string;
  onError: (msg: string, err?: unknown) => void;
  /** Sequence manifest FPS: one visible strip step per `1/fps` seconds. */
  previewFps: number;
  onClose: () => void;
  onSave: (next: FrameSequencePayload) => void;
  editorMode?: FrameSequenceEditorMode;
  stripActions?: FrameSequenceStripActions;
  onApplyVideo?: (strip: FrameSequencePayload) => void;
  onReExtract?: () => void;
  disableStripDrag?: boolean;
  groupLayers?: Array<{
    clipId: string;
    label: string;
    initial: FrameSequencePayload;
  }>;
  getStripActionsForClip?: (clipId: string) => FrameSequenceStripActions | undefined;
  onSaveGroup?: (payloads: Record<string, FrameSequencePayload>) => void;
  onApplyVideoGroup?: (payloads: Record<string, FrameSequencePayload>) => void;
}) {
  const {
    open,
    title,
    initial,
    sourceGalleryIndex,
    charKey,
    sequenceName,
    onError,
    previewFps,
    onClose,
    onSave,
    editorMode = "sequence",
    stripActions,
    onApplyVideo,
    onReExtract,
    disableStripDrag = false,
    groupLayers,
    getStripActionsForClip,
    onSaveGroup,
    onApplyVideoGroup,
  } = props;
  const isGroupMode = Boolean(groupLayers && groupLayers.length > 1);
  const [strip, setStrip] = useState<FrameSequenceStripSlot[]>(() =>
    migrateLegacyFrameSequence(initial)
  );
  const [layerStrips, setLayerStrips] = useState<FrameSequenceStripSlot[][]>([]);
  const [layerVisible, setLayerVisible] = useState<Record<string, boolean>>({});
  const [contextLayerId, setContextLayerId] = useState("");
  const layerStripsRef = useRef(layerStrips);
  layerStripsRef.current = layerStrips;
  const displayStrip = isGroupMode ? (layerStrips[0] ?? []) : strip;
  const contextLayerIndex = isGroupMode
    ? Math.max(0, groupLayers?.findIndex((g) => g.clipId === contextLayerId) ?? 0)
    : 0;
  const contextStrip = isGroupMode ? (layerStrips[contextLayerIndex] ?? []) : strip;
  const activeStripActions =
    isGroupMode && contextLayerId
      ? getStripActionsForClip?.(contextLayerId)
      : stripActions;
  /** Multi-select strip indices; preview / arrows use focusIx when not playing. */
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(() => new Set([0]));
  const [focusIx, setFocusIx] = useState(0);
  const [play, setPlay] = useState(false);
  const [playIx, setPlayIx] = useState(0);
  const undoStack = useRef<FrameSequencePayload[]>([]);
  const redoStack = useRef<FrameSequencePayload[]>([]);
  const groupUndoStack = useRef<FrameSequenceStripSlot[][][]>([]);
  const groupRedoStack = useRef<FrameSequenceStripSlot[][][]>([]);
  /** Anchor for Shift+click range selection (strip index). */
  const rangeAnchorRef = useRef(0);
  /** Latest indices for keyboard nav (preview uses playIx while playing, else focusIx). */
  const navRef = useRef({ play: false, playIx: 0, focusIx: 0 });
  navRef.current = { play, playIx, focusIx };
  const stripRef = useRef(displayStrip);
  stripRef.current = displayStrip;
  const selectedIndicesRef = useRef(selectedIndices);
  selectedIndicesRef.current = selectedIndices;
  const focusIxRef = useRef(focusIx);
  focusIxRef.current = focusIx;
  const stripClipRef = useRef<FrameSeqStripClip | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const stripScrollRef = useRef<HTMLDivElement>(null);
  const stripInnerRef = useRef<HTMLDivElement>(null);

  const stepPreviewFrame = useCallback((delta: number) => {
    const { play: playing, playIx: ix, focusIx: fx } = navRef.current;
    const s = stripRef.current;
    if (!s.length) return;
    const vis = visibleStripIndices(s);
    if (vis.length === 0) return;
    const cur = playing ? ix : fx;
    const direct = vis.indexOf(cur);
    const vPos = direct >= 0 ? direct : positionInVisibleOrNearest(s, cur);
    const newVPos = ((vPos + delta) % vis.length + vis.length) % vis.length;
    const next = vis[newVPos]!;
    setPlay(false);
    setFocusIx(next);
    setPlayIx(next);
    setSelectedIndices(new Set([next]));
    rangeAnchorRef.current = next;
  }, []);

  const togglePlay = useCallback(() => {
    if (play) {
      setPlay(false);
      return;
    }
    const s = isGroupMode ? layerStripsRef.current[0] ?? [] : strip;
    if (!s.length) return;
    if (!s.some((slot) => frameSequenceStripSlotHasTimelineImage(slot))) return;
    setPlayIx(firstVisibleStripIndexAtOrAfterFocus(s, focusIx));
    setPlay(true);
  }, [play, focusIx, strip, isGroupMode]);

  const [stripMenu, setStripMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
  }>({ open: false, x: 0, y: 0 });
  const [stripI2vDialog, setStripI2vDialog] = useState<{
    relPath: string;
    index: number;
    length: number;
    prompt: string;
  } | null>(null);
  const [stripFlfDialog, setStripFlfDialog] = useState<{
    relPathA: string;
    relPathB: string;
    start: number;
    end: number;
    length: number;
  } | null>(null);

  const updateStripSlots = useCallback(
    (updater: (prev: FrameSequenceStripSlot[]) => FrameSequenceStripSlot[]) => {
      if (isGroupMode) {
        groupUndoStack.current.push(layerStripsRef.current.map((s) => s.map(cloneStripSlot)));
        groupRedoStack.current = [];
        setLayerStrips((prev) =>
          prev.map((layerStrip, i) => (i === contextLayerIndex ? updater(layerStrip) : layerStrip))
        );
        return;
      }
      undoStack.current.push(payloadFromState(initial.sequenceGroupId, stripRef.current));
      redoStack.current = [];
      setStrip((prev) => updater(prev));
    },
    [initial.sequenceGroupId, isGroupMode, contextLayerIndex]
  );

  const updateAllLayerStrips = useCallback(
    (updater: (prev: FrameSequenceStripSlot[]) => FrameSequenceStripSlot[]) => {
      if (!isGroupMode) {
        undoStack.current.push(payloadFromState(initial.sequenceGroupId, stripRef.current));
        redoStack.current = [];
        setStrip((prev) => updater(prev));
        return;
      }
      groupUndoStack.current.push(layerStripsRef.current.map((s) => s.map(cloneStripSlot)));
      groupRedoStack.current = [];
      setLayerStrips((prev) => prev.map((layerStrip) => updater(layerStrip)));
    },
    [initial.sequenceGroupId, isGroupMode]
  );

  const applyRelPathUpdates = useCallback(
    (updates: Map<number, string>) => {
      if (!updates.size) return;
      updateStripSlots((prev) =>
        prev.map((slot, i) => {
          const nextRel = updates.get(i);
          if (!nextRel || slot.kind !== "image") return slot;
          return { ...slot, relPath: nextRel };
        })
      );
    },
    [updateStripSlots]
  );

  const stripMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!stripMenu.open) return [];
    const items: ContextMenuItem[] = [];
    const menuStrip = isGroupMode ? contextStrip : strip;
    const relPaths = relPathsFromStripSelection(menuStrip, selectedIndices);
    const occupiedCount = occupiedStripSelectionCount(menuStrip, selectedIndices);
    const i2v = canGenerateI2vFromStripSelection(menuStrip, selectedIndices);
    const flf = canGenerateFlfFromStripSelection(menuStrip, selectedIndices);
    const busy = activeStripActions?.busy ?? false;

    if (occupiedCount >= 2) {
      items.push({
        key: "invert",
        label: "Invert",
        onSelect: () => {
          updateStripSlots((prev) => reverseStripSelection(prev, selectedIndices));
        },
      });
    }

    if (relPaths.length && activeStripActions?.onRemoveBackground) {
      items.push({
        key: "rembg",
        label: "Remove Background…",
        disabled: busy,
        onSelect: () => {
          void (async () => {
            try {
              const out = await activeStripActions.onRemoveBackground!(relPaths);
              if (!out?.length) return;
              const updates = new Map<number, string>();
              let j = 0;
              for (const i of [...selectedIndices].sort((a, b) => a - b)) {
                const slot = menuStrip[i];
                if (!frameSequenceStripSlotHasImage(slot)) continue;
                const nextRel = out[j];
                if (nextRel) updates.set(i, nextRel);
                j += 1;
              }
              applyRelPathUpdates(updates);
            } catch (e) {
              onErrorRef.current("Remove background failed.", e);
            }
          })();
        },
      });
    }
    if (relPaths.length === 1 && activeStripActions?.onAiEdit) {
      items.push({
        key: "aiEdit",
        label: "AI Edit",
        disabled: busy,
        onSelect: () => {
          void (async () => {
            try {
              const rel = relPaths[0]!;
              const nextRel = await activeStripActions.onAiEdit!(rel);
              if (!nextRel) return;
              const ix = [...selectedIndices].find((i) =>
                frameSequenceStripSlotHasImage(menuStrip[i])
              );
              if (ix == null) return;
              applyRelPathUpdates(new Map([[ix, nextRel]]));
            } catch (e) {
              onErrorRef.current("AI edit failed.", e);
            }
          })();
        },
      });
    }
    if (i2v.ok && activeStripActions?.onGenerateI2v) {
      items.push({
        key: "i2v",
        label: "Generate I2V",
        disabled: busy,
        onSelect: () =>
          setStripI2vDialog({
            relPath: i2v.relPath,
            index: i2v.index,
            length: 129,
            prompt: "",
          }),
      });
    }
    if (flf.ok && activeStripActions?.onGenerateFlf) {
      const a = menuStrip[flf.start]!;
      const b = menuStrip[flf.end]!;
      const relA = a.kind === "image" ? a.relPath?.trim() : "";
      const relB = b.kind === "image" ? b.relPath?.trim() : "";
      if (relA && relB) {
        items.push({
          key: "flf",
          label: "Generate FLF",
          disabled: busy,
          onSelect: () =>
            setStripFlfDialog({
              relPathA: relA,
              relPathB: relB,
              start: flf.start,
              end: flf.end,
              length: 33,
            }),
        });
      }
    }
    return items;
  }, [
    stripMenu.open,
    activeStripActions,
    strip,
    contextStrip,
    isGroupMode,
    selectedIndices,
    applyRelPathUpdates,
    updateStripSlots,
  ]);

  const snapshot = useCallback((): FrameSequencePayload => {
    return payloadFromState(initial.sequenceGroupId, isGroupMode ? displayStrip : strip);
  }, [initial.sequenceGroupId, strip, displayStrip, isGroupMode]);

  const groupPayloadsFromState = useCallback((): Record<string, FrameSequencePayload> => {
    if (!groupLayers) return {};
    return payloadFromAlignedStrips(
      groupLayers.map((layer, i) => ({
        clipId: layer.clipId,
        sequenceGroupId: layer.initial.sequenceGroupId,
        strip: layerStrips[i] ?? [],
      }))
    );
  }, [groupLayers, layerStrips]);

  const pushUndo = useCallback(() => {
    if (isGroupMode) {
      groupUndoStack.current.push(layerStripsRef.current.map((s) => s.map(cloneStripSlot)));
      groupRedoStack.current = [];
      return;
    }
    undoStack.current.push(snapshot());
    redoStack.current = [];
  }, [snapshot, isGroupMode]);

  useEffect(() => {
    if (!open) return;
    if (isGroupMode && groupLayers) {
      const aligned = alignFrameStripsToLength(
        groupLayers.map((g) => migrateLegacyFrameSequence(g.initial))
      );
      setLayerStrips(aligned);
      setLayerVisible(Object.fromEntries(groupLayers.map((g) => [g.clipId, true])));
      setContextLayerId(groupLayers[0]!.clipId);
      const len = aligned[0]?.length ?? 0;
      setSelectedIndices(len ? new Set([0]) : new Set());
      rangeAnchorRef.current = 0;
      setFocusIx(0);
      setPlay(false);
      setPlayIx(0);
      groupUndoStack.current = [];
      groupRedoStack.current = [];
      return;
    }
    const nextStrip = migrateLegacyFrameSequence(initial);
    setStrip(nextStrip);
    setSelectedIndices(nextStrip.length ? new Set([0]) : new Set());
    rangeAnchorRef.current = 0;
    setFocusIx(0);
    setPlay(false);
    setPlayIx(0);
    undoStack.current = [];
    redoStack.current = [];
    stripClipRef.current = null;
  }, [open, initial, isGroupMode, groupLayers]);

  useEffect(() => {
    if (!open || !play) return;
    const fps = Math.max(1, previewFps);
    const intervalMs = Math.max(1, Math.round(1000 / fps));
    const id = window.setInterval(() => {
      setPlayIx((i) => {
        const s = stripRef.current;
        if (!s.length) return 0;
        return nextVisibleStripIndexAfter(s, i);
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [open, play, previewFps]);

  const addEmpty = () => {
    pushUndo();
    const currentStrip = isGroupMode ? displayStrip : strip;
    if (currentStrip.length === 0) {
      if (isGroupMode) {
        setLayerStrips((prev) => prev.map(() => [{ kind: "empty" }]));
      } else {
        setStrip([{ kind: "empty" }]);
      }
      setSelectedIndices(new Set([0]));
      rangeAnchorRef.current = 0;
      setFocusIx(0);
      setPlayIx(0);
      setPlay(false);
      return;
    }
    const insertAfter = Math.min(Math.max(0, focusIx), currentStrip.length - 1);
    const newIx = insertAfter + 1;
    updateAllLayerStrips((s) => {
      const t = [...s];
      t.splice(newIx, 0, { kind: "empty" });
      return t;
    });
    setSelectedIndices(new Set([newIx]));
    rangeAnchorRef.current = newIx;
    setFocusIx(newIx);
    setPlayIx(newIx);
    setPlay(false);
  };

  const removeSelectedSlots = useCallback(() => {
    if (selectedIndices.size === 0) return;
    const currentStrip = isGroupMode ? displayStrip : strip;
    const toRemove = new Set(
      [...selectedIndices].filter((i) => i >= 0 && i < currentStrip.length)
    );
    if (toRemove.size === 0) return;
    pushUndo();
    if (isGroupMode) {
      setLayerStrips((prev) =>
        prev.map((layerStrip) => layerStrip.filter((_, j) => !toRemove.has(j)))
      );
    } else {
      setStrip((prev) => prev.filter((_, j) => !toRemove.has(j)));
    }
    const nextLen = currentStrip.length - toRemove.size;
    if (nextLen === 0) {
      setSelectedIndices(new Set());
      setFocusIx(0);
      setPlayIx(0);
      setPlay(false);
      return;
    }
    const nf = Math.min(Math.max(0, focusIx), nextLen - 1);
    setSelectedIndices(new Set([nf]));
    rangeAnchorRef.current = nf;
    setFocusIx(nf);
    setPlayIx(nf);
  }, [selectedIndices, strip, displayStrip, isGroupMode, focusIx, pushUndo]);

  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent) {
      if (isEditableTarget(ev.target)) return;

      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        stepPreviewFrame(-1);
        return;
      }
      if (ev.key === "ArrowRight") {
        ev.preventDefault();
        stepPreviewFrame(1);
        return;
      }

      if (ev.key === "Delete" || ev.key === "Backspace") {
        if (!ev.ctrlKey && !ev.metaKey) {
          if (selectedIndicesRef.current.size > 0) {
            ev.preventDefault();
            removeSelectedSlots();
          }
          return;
        }
      }

      if (!(ev.ctrlKey || ev.metaKey)) return;

      const k = ev.key.toLowerCase();
      if (k === "z" && !ev.shiftKey) {
        ev.preventDefault();
        const u = undoStack.current.pop();
        if (!u) return;
        redoStack.current.push(snapshot());
        const nextStrip = u.strip.map((s) =>
          s.kind === "image"
            ? {
                kind: "image" as const,
                relPath: s.relPath || "",
                crop: cloneCrop(s.crop),
                ...(s.hidden ? { hidden: true } : {}),
              }
            : s.hidden
              ? ({ kind: "empty" as const, hidden: true } as FrameSequenceStripSlot)
              : { kind: "empty" as const }
        );
        setStrip(nextStrip);
        const L = nextStrip.length;
        setSelectedIndices((prev) => {
          const kept = new Set([...prev].filter((ix) => ix >= 0 && ix < L));
          if (kept.size > 0) return kept;
          return L > 0 ? new Set([0]) : new Set();
        });
        setFocusIx((f) => (L > 0 ? Math.min(Math.max(0, f), L - 1) : 0));
        setPlayIx((p) => (L > 0 ? Math.min(Math.max(0, p), L - 1) : 0));
        return;
      }

      if (k === "c") {
        ev.preventDefault();
        const s = stripRef.current;
        const sel = [...selectedIndicesRef.current].sort((a, b) => a - b);
        const items: FrameSeqStripClip["items"] = [];
        for (const i of sel) {
          const slot = s[i];
          if (slot?.kind === "image" && slot.relPath?.trim()) {
            items.push({
              relPath: slot.relPath,
              crop: cloneCrop(slot.crop),
              ...(slot.hidden ? { hidden: true } : {}),
            });
          }
        }
        if (items.length) stripClipRef.current = { kind: "frameSeqStrip", items };
        return;
      }

      if (k === "v") {
        ev.preventDefault();
        void (async () => {
          const clip = stripClipRef.current;
          if (!clip?.items.length) return;
          try {
            pushUndo();
            const base = [...stripRef.current];
            const sel = selectedIndicesRef.current;
            // Insert after right edge of selection; if nothing selected, after focus index.
            const insertAt =
              sel.size > 0
                ? Math.max(...sel) + 1
                : Math.min(focusIxRef.current + 1, base.length);
            const newSlots: FrameSequenceStripSlot[] = [];
            for (const it of clip.items) {
              const { relPath } = await apiSequenceDuplicateAsset({
                charKey,
                sequenceName,
                sourceRelPath: it.relPath,
                subfolder: "gallery",
              });
              newSlots.push({
                kind: "image",
                relPath,
                crop: cloneCrop(it.crop),
                ...(it.hidden ? { hidden: true as const } : {}),
              });
            }
            base.splice(insertAt, 0, ...newSlots);
            setStrip(base);
            setPlay(false);
            const endIx = insertAt + newSlots.length - 1;
            setSelectedIndices(new Set(newSlots.map((_, j) => insertAt + j)));
            rangeAnchorRef.current = insertAt;
            setFocusIx(endIx);
            setPlayIx(endIx);
          } catch (e) {
            onErrorRef.current("Frame sequence paste failed.", e);
          }
        })();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, charKey, sequenceName, stepPreviewFrame, snapshot, pushUndo, removeSelectedSlots]);

  useEffect(() => {
    const outer = stripScrollRef.current;
    const inner = stripInnerRef.current;
    if (!outer || !inner) return;
    const cell = inner.children[focusIx] as HTMLElement | undefined;
    if (!cell) return;
    const cRect = outer.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    if (cellRect.left < cRect.left) {
      outer.scrollLeft -= cRect.left - cellRect.left + 6;
    } else if (cellRect.right > cRect.right) {
      outer.scrollLeft += cellRect.right - cRect.right + 6;
    }
  }, [focusIx]);

  const hideSelectedSlots = () => {
    const editStrip = isGroupMode ? contextStrip : strip;
    const targets = [...selectedIndices].filter((i) => {
      if (i < 0 || i >= editStrip.length) return false;
      const sl = editStrip[i]!;
      return sl.kind === "image" && !!sl.relPath?.trim() && !sl.hidden;
    });
    if (!targets.length) return;
    pushUndo();
    if (isGroupMode) {
      setLayerStrips((prev) =>
        prev.map((layerStrip, i) =>
          i === contextLayerIndex
            ? layerStrip.map((slot, j) =>
                targets.includes(j) && slot.kind === "image" && slot.relPath
                  ? { ...slot, hidden: true }
                  : slot
              )
            : layerStrip
        )
      );
      return;
    }
    setStrip((s) =>
      s.map((slot, j) =>
        targets.includes(j) && slot.kind === "image" && slot.relPath
          ? { ...slot, hidden: true }
          : slot
      )
    );
  };

  const unhideSelectedSlots = () => {
    const editStrip = isGroupMode ? contextStrip : strip;
    const targets = [...selectedIndices].filter((i) => {
      if (i < 0 || i >= editStrip.length) return false;
      const sl = editStrip[i]!;
      return sl.kind === "image" && !!sl.hidden;
    });
    if (!targets.length) return;
    pushUndo();
    const unhideMap = (s: FrameSequenceStripSlot[]) =>
      s.map((slot, j) => {
        if (!targets.includes(j) || slot.kind !== "image" || !slot.hidden) return slot;
        const { hidden: _h, ...rest } = slot;
        return {
          kind: "image" as const,
          relPath: rest.relPath || "",
          crop: cloneCrop(rest.crop),
        };
      });
    if (isGroupMode) {
      setLayerStrips((prev) =>
        prev.map((layerStrip, i) => (i === contextLayerIndex ? unhideMap(layerStrip) : layerStrip))
      );
      return;
    }
    setStrip(unhideMap);
  };

  const hasSelectedImageToHide = useMemo(
    () =>
      [...selectedIndices].some((i) => {
        const editStrip = isGroupMode ? contextStrip : strip;
        if (i < 0 || i >= editStrip.length) return false;
        const sl = editStrip[i]!;
        return sl.kind === "image" && !!sl.relPath?.trim() && !sl.hidden;
      }),
    [selectedIndices, strip, contextStrip, isGroupMode]
  );

  const hasSelectedHiddenImage = useMemo(
    () =>
      [...selectedIndices].some((i) => {
        const editStrip = isGroupMode ? contextStrip : strip;
        if (i < 0 || i >= editStrip.length) return false;
        const sl = editStrip[i]!;
        return sl.kind === "image" && !!sl.hidden;
      }),
    [selectedIndices, strip, contextStrip, isGroupMode]
  );

  const previewSlot = useMemo(() => {
    if (!displayStrip.length) return null;
    const ix = play ? playIx : focusIx;
    return previewDisplaySlot(displayStrip, ix);
  }, [displayStrip, play, playIx, focusIx]);

  const groupPreviewLayers = useMemo(() => {
    if (!isGroupMode || !groupLayers?.length) return [];
    const ix = play ? playIx : focusIx;
    return groupLayers
      .map((layer, li) => {
        if (!layerVisible[layer.clipId]) return null;
        const layerStrip = layerStrips[li] ?? [];
        const slot = previewDisplaySlot(layerStrip, ix);
        if (!slot || slot.kind !== "image" || !slot.relPath) return null;
        return { clipId: layer.clipId, label: layer.label, slot };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
  }, [isGroupMode, groupLayers, layerStrips, layerVisible, play, playIx, focusIx]);

  const onStripSlotClick = (i: number, ev: React.MouseEvent) => {
    setPlay(false);
    if (ev.shiftKey) {
      const anchor = rangeAnchorRef.current;
      const lo = Math.min(anchor, i);
      const hi = Math.max(anchor, i);
      const next = new Set<number>();
      for (let k = lo; k <= hi; k++) next.add(k);
      setSelectedIndices(next);
      setFocusIx(i);
      setPlayIx(i);
      return;
    }
    if (ev.metaKey || ev.ctrlKey) {
      setSelectedIndices((prev) => {
        const n = new Set(prev);
        if (n.has(i)) n.delete(i);
        else n.add(i);
        if (n.size === 0 && displayStrip.length > 0) {
          const fallback = Math.min(Math.max(0, i), displayStrip.length - 1);
          return new Set([fallback]);
        }
        return n;
      });
      rangeAnchorRef.current = i;
      setFocusIx(i);
      setPlayIx(i);
      return;
    }
    rangeAnchorRef.current = i;
    setSelectedIndices(new Set([i]));
    setFocusIx(i);
    setPlayIx(i);
  };

  const visibleIx = useMemo(() => visibleStripIndices(displayStrip), [displayStrip]);
  const stripIndexToVisiblePos = useMemo(() => {
    const m = new Map<number, number>();
    visibleIx.forEach((stripIdx, visPos) => {
      m.set(stripIdx, visPos);
    });
    return m;
  }, [visibleIx]);
  const hasVisibleFrames = visibleIx.length > 0;
  const previewStripIx = play ? playIx : focusIx;
  const previewVisiblePos = useMemo(
    () => (visibleIx.length ? positionInVisibleOrNearest(displayStrip, previewStripIx) : 0),
    [displayStrip, visibleIx.length, previewStripIx]
  );
  const columnCount = isGroupMode ? displayStrip.length : strip.length;

  const { setNodeRef: setBackdropDropRef, isOver: isOverBackdrop } = useDroppable({
    id: FS_MODAL_GALLERY_BACKDROP_DROP_ID,
    disabled: !open || disableStripDrag,
  });
  const { active } = useDndContext();
  const stripSlotDragActive = active?.data.current?.kind === "frameSeqStripSlot";
  const showAddToGalleryHint = Boolean(
    !disableStripDrag && stripSlotDragActive && isOverBackdrop
  );

  if (!open) return null;

  return (
    <div
      ref={setBackdropDropRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 4000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (active != null) return;
        onClose();
      }}
    >
      {showAddToGalleryHint ? (
        <div
          aria-live="polite"
          style={{
            position: "fixed",
            left: "50%",
            bottom: 28,
            transform: "translateX(-50%)",
            zIndex: 4500,
            pointerEvents: "none",
            padding: "8px 14px",
            background: "rgba(20,60,120,0.92)",
            color: "#fff",
            fontSize: 13,
            border: "1px solid rgba(255,255,255,0.35)",
            borderRadius: 0,
            boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
          }}
        >
          Add Frame to Gallery
        </div>
      ) : null}
      <div
        style={{
          background: "#111",
          color: "#eee",
          pointerEvents: stripSlotDragActive ? "none" : "auto",
          maxWidth: "min(96vw, 920px)",
          width: "100%",
          maxHeight: "90vh",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 0,
          padding: 14,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 400, marginBottom: 10, flexShrink: 0 }}>{title}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10, flexShrink: 0 }}>
          <button type="button" style={modalBtnSecondary} onClick={addEmpty}>
            Add empty
          </button>
          {editorMode === "timeline" && onReExtract ? (
            <button type="button" style={modalBtnSecondary} onClick={onReExtract}>
              Re-extract from video
            </button>
          ) : null}
          <button
            type="button"
            style={selectedIndices.size === 0 ? modalBtnSecondaryDisabled : modalBtnSecondary}
            onClick={removeSelectedSlots}
            disabled={selectedIndices.size === 0}
          >
            Remove selected
          </button>
          <button
            type="button"
            style={!hasSelectedImageToHide ? modalBtnSecondaryDisabled : modalBtnSecondary}
            onClick={hideSelectedSlots}
            disabled={!hasSelectedImageToHide}
          >
            Hide selected
          </button>
          <button
            type="button"
            style={!hasSelectedHiddenImage ? modalBtnSecondaryDisabled : modalBtnSecondary}
            onClick={unhideSelectedSlots}
            disabled={!hasSelectedHiddenImage}
          >
            Unhide selected
          </button>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          <div style={{ ...sectionLabelStyle, flexShrink: 0 }}>Strip (main)</div>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 6, flexShrink: 0 }}>
            Click to select · Shift+click range · Ctrl/Cmd+click toggle · Ctrl/Cmd+C copy · Ctrl/Cmd+V paste
            after selection (shifts later indices) · Delete removes selected · Hidden image frames show a grey mask; use
            Unhide selected to restore. Play and preview Prev/Next (and ← →) advance one step per **non-hidden** cell
            (skips hidden images; empty cells still add a hold in preview and in export). Set MP4: each empty cell adds
            one hold frame; hidden image cells are skipped in the file, like a hidden cell on the main timeline.
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              marginBottom: 8,
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={() => stripScrollRef.current?.scrollBy({ left: -(CELL + 4) * 3, behavior: "smooth" })}
              style={{
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "#999",
                padding: "4px 6px",
                cursor: "pointer",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                borderRadius: 0,
              }}
            >
              <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                <polyline points="8,2 2,7 8,12" stroke="#999" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" />
              </svg>
            </button>
            <div
              ref={stripScrollRef}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.preventDefault();
              }}
              style={{
                flex: 1,
                overflowX: "auto",
                overflowY: "hidden",
                outline: "none",
              }}
            >
            <div ref={stripInnerRef} style={{ display: "flex", flexWrap: "nowrap", gap: 4, alignItems: "flex-start", paddingBottom: 4 }}>
              {isGroupMode && groupLayers
                ? Array.from({ length: columnCount }, (_, i) => (
                    <GroupStripStackedColumn
                      key={`g-${i}`}
                      stripIndex={i}
                      layers={groupLayers.map((layer, li) => ({
                        clipId: layer.clipId,
                        label: layer.label,
                        slot: layerStrips[li]?.[i] ?? { kind: "empty" },
                      }))}
                      selected={selectedIndices.has(i)}
                      isFocus={focusIx === i}
                      visibleFooterLabel={stripIndexToVisiblePos.get(i) ?? null}
                      onStripSlotClick={onStripSlotClick}
                      onLayerContextMenu={(clipId, stripIndex, ev) => {
                        setContextLayerId(clipId);
                        setSelectedIndices(new Set([stripIndex]));
                        setFocusIx(stripIndex);
                        setPlayIx(stripIndex);
                        setStripMenu({ open: true, x: ev.clientX, y: ev.clientY });
                      }}
                    />
                  ))
                : strip.map((slot, i) => (
                    <StripDraggableCell
                      key={`s-${i}`}
                      stripIndex={i}
                      sourceGalleryIndex={sourceGalleryIndex}
                      slot={slot}
                      selected={selectedIndices.has(i)}
                      isFocus={focusIx === i}
                      visibleFooterLabel={stripIndexToVisiblePos.get(i) ?? null}
                      onStripSlotClick={onStripSlotClick}
                      disableDrag={disableStripDrag}
                      onStripSlotContextMenu={(_i, ev) =>
                        setStripMenu({ open: true, x: ev.clientX, y: ev.clientY })
                      }
                    />
                  ))}
            </div>
            </div>
            <button
              type="button"
              onClick={() => stripScrollRef.current?.scrollBy({ left: (CELL + 4) * 3, behavior: "smooth" })}
              style={{
                background: "transparent",
                border: "1px solid rgba(255,255,255,0.18)",
                color: "#999",
                padding: "4px 6px",
                cursor: "pointer",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                borderRadius: 0,
              }}
            >
              <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                <polyline points="2,2 8,7 2,12" stroke="#999" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" />
              </svg>
            </button>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              width: "100%",
              flexShrink: 0,
            }}
          >
            <div style={{ ...sectionLabelStyle, textAlign: "center", width: "100%" }}>Preview</div>
            {isGroupMode && groupLayers ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  justifyContent: "center",
                  marginBottom: 8,
                  width: "100%",
                }}
              >
                {groupLayers.map((layer) => (
                  <label
                    key={layer.clipId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={layerVisible[layer.clipId] ?? true}
                      onChange={() =>
                        setLayerVisible((prev) => ({
                          ...prev,
                          [layer.clipId]: !(prev[layer.clipId] ?? true),
                        }))
                      }
                    />
                    <span>{layer.label}</span>
                  </label>
                ))}
              </div>
            ) : null}
            <div
              title="Drag the corner to resize the preview"
              style={{
                resize: "both",
                overflow: "hidden",
                minWidth: 160,
                minHeight: 160,
                width: 320,
                height: 320,
                maxWidth: "100%",
                maxHeight: "min(70vh, 720px)",
                boxSizing: "border-box",
                border: "1px solid rgba(255,255,255,0.25)",
                background: "#000",
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  minHeight: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 6,
                  boxSizing: "border-box",
                }}
              >
                {isGroupMode ? (
                  groupPreviewLayers.length ? (
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      {groupPreviewLayers.map((layer) => (
                        <div
                          key={layer.clipId}
                          style={{
                            flex: 1,
                            minHeight: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <div
                            style={{
                              ...SEQUENCE_CROP_OUTER_CLIP_FLEX,
                              maxWidth: "100%",
                              maxHeight: "100%",
                              width: "100%",
                              height: "100%",
                            }}
                          >
                            <div style={sequenceCropTransformWrapperStyle(layer.slot.crop)}>
                              <img
                                src={assetUrlFromRelPath(layer.slot.relPath!)}
                                alt=""
                                style={{
                                  maxWidth: "100%",
                                  maxHeight: "100%",
                                  width: "auto",
                                  height: "auto",
                                  objectFit: "contain",
                                  display: "block",
                                  margin: "0 auto",
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ width: "100%", height: "100%", minHeight: 80, background: "#222" }} />
                  )
                ) : previewSlot?.kind === "image" && previewSlot.relPath ? (
                  <div
                    style={{
                      ...SEQUENCE_CROP_OUTER_CLIP_FLEX,
                      maxWidth: "100%",
                      maxHeight: "100%",
                      width: "100%",
                      height: "100%",
                    }}
                  >
                    <div style={sequenceCropTransformWrapperStyle(previewSlot.crop)}>
                      <img
                        src={assetUrlFromRelPath(previewSlot.relPath)}
                        alt=""
                        style={{
                          maxWidth: "100%",
                          maxHeight: "100%",
                          width: "auto",
                          height: "auto",
                          objectFit: "contain",
                          display: "block",
                          margin: "0 auto",
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{ width: "100%", height: "100%", minHeight: 80, background: "#222" }} />
                )}
              </div>
            </div>
            {hasVisibleFrames ? (
              <GalleryImagePager
                variant="modalLight"
                index={previewVisiblePos}
                count={visibleIx.length}
                onPrev={() => stepPreviewFrame(-1)}
                onNext={() => stepPreviewFrame(1)}
                extraAfterNext={
                  <SquareIconButton
                    size={36}
                    aria-label={play ? "Pause" : "Play"}
                    title={play ? "Pause" : "Play"}
                    icon={play ? <PauseBarsIcon /> : <TimelinePlayIcon />}
                    tone="light"
                    style={previewTransportBtnStyle}
                    disabled={visibleIx.length < 2}
                    onClick={() => togglePlay()}
                  />
                }
              />
            ) : (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: 12,
                  marginBottom: 8,
                }}
              >
                <SquareIconButton
                  aria-label="Previous image"
                  title="Previous"
                  icon={<TriangleIcon direction="left" />}
                  tone="light"
                  disabled
                  style={previewTransportBtnStyle}
                />
                <span style={{ fontSize: 13, opacity: 0.45, minWidth: 56, textAlign: "center", color: "#eee" }}>
                  0 / 0
                </span>
                <SquareIconButton
                  aria-label="Next image"
                  title="Next"
                  icon={<TriangleIcon direction="right" />}
                  tone="light"
                  disabled
                  style={previewTransportBtnStyle}
                />
                <SquareIconButton
                  size={36}
                  aria-label="Play"
                  title="Play"
                  icon={<TimelinePlayIcon />}
                  tone="light"
                  disabled
                  style={previewTransportBtnStyle}
                />
              </div>
            )}
            <div style={{ fontSize: 11, color: "#888", marginBottom: 12, textAlign: "center", width: "100%" }}>
              Drag the corner to resize · ← → step visible strip cells (skip hidden images; collapses to one selected)
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexShrink: 0 }}>
          <button type="button" style={modalBtnSecondary} onClick={onClose}>
            Cancel
          </button>
          {editorMode === "timeline" && (onApplyVideo || onApplyVideoGroup) ? (
            <button
              type="button"
              style={modalBtnPrimary}
              onClick={() => {
                if (isGroupMode && onSaveGroup && onApplyVideoGroup) {
                  const payloads = groupPayloadsFromState();
                  onSaveGroup(payloads);
                  onApplyVideoGroup(payloads);
                  return;
                }
                const payload = payloadFromState(initial.sequenceGroupId, strip);
                onSave(payload);
                onApplyVideo?.(payload);
              }}
            >
              Apply video…
            </button>
          ) : null}
          <button
            type="button"
            style={modalBtnPrimary}
            onClick={() => {
              if (isGroupMode && onSaveGroup) {
                onSaveGroup(groupPayloadsFromState());
              } else {
                onSave(payloadFromState(initial.sequenceGroupId, strip));
              }
              if (editorMode !== "timeline") onClose();
            }}
          >
            {editorMode === "timeline" ? "Save strip" : "Save"}
          </button>
        </div>
      </div>

      <DesktopContextMenu
        open={stripMenu.open}
        x={stripMenu.x}
        y={stripMenu.y}
        items={stripMenuItems}
        onClose={() => setStripMenu((s) => ({ ...s, open: false }))}
      />

      {stripI2vDialog ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 5000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onMouseDown={() => setStripI2vDialog(null)}
        >
          <div
            style={{
              background: "#0b0b0b",
              color: "#eee",
              padding: 14,
              maxWidth: 400,
              width: "100%",
              border: "1px solid rgba(255,255,255,0.22)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Generate I2V (strip)</div>
            <SequenceOutputLengthStepper
              lengths={SEQUENCE_I2V_OUTPUT_LENGTHS}
              value={stripI2vDialog.length}
              onChange={(next) =>
                setStripI2vDialog((d) => (d ? { ...d, length: next } : null))
              }
            />
            <textarea
              value={stripI2vDialog.prompt}
              onChange={(e) =>
                setStripI2vDialog((d) => (d ? { ...d, prompt: e.target.value } : null))
              }
              rows={3}
              placeholder="Motion prompt"
              style={{
                width: "100%",
                boxSizing: "border-box",
                marginTop: 8,
                background: "rgba(0,0,0,0.35)",
                color: "inherit",
                border: "1px solid rgba(255,255,255,0.25)",
                padding: 8,
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={() => setStripI2vDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={!stripI2vDialog.prompt.trim() || !activeStripActions?.onGenerateI2v}
                onClick={() => {
                  const dlg = stripI2vDialog;
                  setStripI2vDialog(null);
                  if (!dlg || !activeStripActions?.onGenerateI2v) return;
                  void (async () => {
                    try {
                      const rels = await activeStripActions.onGenerateI2v!(
                        dlg.relPath,
                        dlg.prompt.trim(),
                        dlg.length
                      );
                      if (!rels?.length) return;
                      const insert: FrameSequenceStripSlot[] = rels.map((relPath) => ({
                        kind: "image",
                        relPath,
                      }));
                      updateStripSlots((prev) =>
                        spliceStripFrames(prev, dlg.index, 1, insert)
                      );
                      setFocusIx(dlg.index);
                      setSelectedIndices(new Set([dlg.index]));
                    } catch (e) {
                      onErrorRef.current("Strip I2V failed.", e);
                    }
                  })();
                }}
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {stripFlfDialog ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 5000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onMouseDown={() => setStripFlfDialog(null)}
        >
          <div
            style={{
              background: "#0b0b0b",
              color: "#eee",
              padding: 14,
              maxWidth: 400,
              width: "100%",
              border: "1px solid rgba(255,255,255,0.22)",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Generate FLF (strip)</div>
            <SequenceOutputLengthStepper
              lengths={SEQUENCE_FLF_OUTPUT_LENGTHS}
              value={stripFlfDialog.length}
              onChange={(next) =>
                setStripFlfDialog((d) => (d ? { ...d, length: next } : null))
              }
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" onClick={() => setStripFlfDialog(null)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={!activeStripActions?.onGenerateFlf}
                onClick={() => {
                  const dlg = stripFlfDialog;
                  setStripFlfDialog(null);
                  if (!dlg || !activeStripActions?.onGenerateFlf) return;
                  void (async () => {
                    try {
                      const rels = await activeStripActions.onGenerateFlf!(
                        dlg.relPathA,
                        dlg.relPathB,
                        dlg.length
                      );
                      if (!rels?.length) return;
                      const insert: FrameSequenceStripSlot[] = rels.map((relPath) => ({
                        kind: "image",
                        relPath,
                      }));
                      const removeCount = Math.max(0, dlg.end - dlg.start - 1);
                      updateStripSlots((prev) =>
                        spliceStripFrames(prev, dlg.start + 1, removeCount, insert)
                      );
                      setFocusIx(dlg.start + 1);
                      setSelectedIndices(new Set([dlg.start + 1]));
                    } catch (e) {
                      onErrorRef.current("Strip FLF failed.", e);
                    }
                  })();
                }}
              >
                Generate
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
