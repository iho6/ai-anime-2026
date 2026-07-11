"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  apiLocationAiEdit,
  apiLocationAngleGroups,
  apiLocationDeleteItems,
  apiLocationGallerySplit,
  apiLocationGalleryReorder,
  apiLocationGenerateAnglesStream,
  apiLocationHide,
  apiLocationOutpaintStream,
  apiLocationSaveViewCopy,
  apiLocationUnhide,
  assetDownloadUrlFromRelPath,
  assetUrlFromRelPath,
  type AngleGroup,
  type LocationGalleryItem,
} from "../../../../lib/api";
import { SortableMultiGrid, SortableItemInContainer } from "../../../../components/dnd/SortableMultiGrid";
import { reorderInsertBeforeOrAfter } from "../../../../components/dnd/reorder";
import { AiEditModal } from "../../../../components/AiEditModal";
import { CameraAngleModal } from "../../../../components/CameraAngleModal";
import { DesktopContextMenu, type ContextMenuItem } from "../../../../components/DesktopContextMenu";
import { DetailSubpageChrome } from "../../../../components/DetailSubpageChrome";
import { ResizableScrollGallery } from "../../../../components/ResizableScrollGallery";
import { StartingImagePreview } from "../../../../components/StartingImagePreview";
import { useAppError } from "../../../../components/ErrorProvider";
import { GalleryImageLightbox } from "../../../../components/GalleryImageLightbox";
import type { SharedLogStreamHandle } from "../../../../components/SharedLogStream";
import { ConnectedJobRunModal } from "../../../../components/ConnectedJobRunModal";
import { useJobRunSession } from "../../../../hooks/useJobRunSession";
import { truncateJobModalStatusLine } from "../../../../lib/jobModalStatus";
import {
  clampMaxOutpaintPerPass,
  DEFAULT_MAX_OUTPAINT_PER_PASS,
  hasOutpaintPadding,
  initialOutpaintBox,
  MAX_MAX_OUTPAINT_PER_PASS,
  MAX_OUTPAINT_PER_PASS_STEP,
  MIN_MAX_OUTPAINT_PER_PASS,
  paddingFromOutpaintBox,
  splitOutpaintIntoStages,
  type OutpaintBoxPx,
  type OutpaintStage,
} from "../../../../lib/outpaintPadding";

const PREVIEW_MAX_W = "100%";
const PREVIEW_MAX_H = "min(360px, 50vh)";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function imageContainRect(containerW: number, containerH: number, natW: number, natH: number) {
  const scale = Math.min(containerW / natW, containerH / natH);
  const dw = natW * scale;
  const dh = natH * scale;
  const ox = (containerW - dw) / 2;
  const oy = (containerH - dh) / 2;
  return { ox, oy, dw, dh };
}

type CropPx = { tx: number; ty: number; side: number };

function LocationOutpaintPreview(props: {
  imageSrc: string;
  box: OutpaintBoxPx | null;
  onBoxChange: (b: OutpaintBoxPx) => void;
  onNatChange?: (nat: { w: number; h: number }) => void;
}) {
  const { imageSrc, box, onBoxChange, onNatChange } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [layout, setLayout] = useState({ cw: 200, ch: 200 });
  const dragRef = useRef<
    | null
    | {
        edge: "left" | "right" | "top" | "bottom";
        orig: OutpaintBoxPx;
        startIx: number;
        startIy: number;
      }
  >(null);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const onLoad = () => {
      if (img.naturalWidth > 0) {
        const next = { w: img.naturalWidth, h: img.naturalHeight };
        setNat(next);
        onNatChange?.(next);
      }
    };
    onLoad();
    img.addEventListener("load", onLoad);
    return () => img.removeEventListener("load", onLoad);
  }, [imageSrc, onNatChange]);

  useEffect(() => {
    if (!nat || box != null) return;
    onBoxChange(initialOutpaintBox(nat));
  }, [nat, box, onBoxChange]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setLayout({ cw: Math.max(1, el.clientWidth), ch: Math.max(1, el.clientHeight) });
    });
    ro.observe(el);
    setLayout({ cw: Math.max(1, el.clientWidth), ch: Math.max(1, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  const clientToImage = useCallback(
    (clientX: number, clientY: number): { ix: number; iy: number } | null => {
      const wrap = wrapRef.current;
      const n = nat;
      if (!wrap || !n) return null;
      const rect = wrap.getBoundingClientRect();
      const { ox, oy, dw, dh } = imageContainRect(rect.width, rect.height, n.w, n.h);
      const lx = clientX - rect.left - ox;
      const ly = clientY - rect.top - oy;
      return { ix: (lx / dw) * n.w, iy: (ly / dh) * n.h };
    },
    [nat]
  );

  const edgeHitPx = () => 14 * Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

  const pickEdge = (ix: number, iy: number, b: OutpaintBoxPx): "left" | "right" | "top" | "bottom" | null => {
    const t = edgeHitPx();
    const onVert = iy >= b.by0 - t && iy <= b.by1 + t;
    const onHorz = ix >= b.bx0 - t && ix <= b.bx1 + t;
    const dL = Math.abs(ix - b.bx0);
    const dR = Math.abs(ix - b.bx1);
    const dT = Math.abs(iy - b.by0);
    const dB = Math.abs(iy - b.by1);
    const candidates: Array<{ edge: "left" | "right" | "top" | "bottom"; d: number }> = [];
    if (onVert) {
      candidates.push({ edge: "left", d: dL });
      candidates.push({ edge: "right", d: dR });
    }
    if (onHorz) {
      candidates.push({ edge: "top", d: dT });
      candidates.push({ edge: "bottom", d: dB });
    }
    candidates.sort((a, b2) => a.d - b2.d);
    const best = candidates[0];
    if (!best || best.d > t) return null;
    return best.edge;
  };

  const onOverlayPointerDown = (e: React.PointerEvent) => {
    if (!nat || !box) return;
    const p = clientToImage(e.clientX, e.clientY);
    if (!p) return;
    const edge = pickEdge(p.ix, p.iy, box);
    if (!edge) return;
    dragRef.current = { edge, orig: { ...box }, startIx: p.ix, startIy: p.iy };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const n = nat;
    if (!d || !n) return;
    const cur = clientToImage(e.clientX, e.clientY);
    if (!cur) return;
    const dx = cur.ix - d.startIx;
    const dy = cur.iy - d.startIy;
    const o = d.orig;
    let bx0 = o.bx0;
    let by0 = o.by0;
    let bx1 = o.bx1;
    let by1 = o.by1;
    if (d.edge === "left") bx0 = Math.min(0, o.bx0 + dx);
    if (d.edge === "right") bx1 = Math.max(n.w, o.bx1 + dx);
    if (d.edge === "top") by0 = Math.min(0, o.by0 + dy);
    if (d.edge === "bottom") by1 = Math.max(n.h, o.by1 + dy);
    onBoxChange({ bx0, by0, bx1, by1 });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      dragRef.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const overlayGeom = useMemo(() => {
    if (!nat || !box) return null;
    const { cw, ch } = layout;
    const { ox, oy, dw, dh } = imageContainRect(cw, ch, nat.w, nat.h);
    const left = ox + (box.bx0 / nat.w) * dw;
    const top = oy + (box.by0 / nat.h) * dh;
    const width = ((box.bx1 - box.bx0) / nat.w) * dw;
    const height = ((box.by1 - box.by0) / nat.h) * dh;
    const imgLeft = ox;
    const imgTop = oy;
    const imgW = dw;
    const imgH = dh;
    return { ox, oy, dw, dh, left, top, width, height, imgLeft, imgTop, imgW, imgH, cw, ch };
  }, [nat, box, layout]);

  const outerStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.35)",
    background: "rgba(0,0,0,0.02)",
    maxWidth: "100%",
    width: "100%",
    boxSizing: "border-box",
    position: "relative",
    height: PREVIEW_MAX_H,
    minHeight: 120,
  };

  return (
    <div ref={wrapRef} style={outerStyle}>
      <img
        ref={imgRef}
        src={imageSrc}
        alt=""
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
          pointerEvents: "none",
          userSelect: "none",
        }}
      />
      {overlayGeom && box ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "auto",
            touchAction: "none",
            cursor: "crosshair",
          }}
          onPointerDown={onOverlayPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: overlayGeom.cw,
              height: overlayGeom.top,
              background: "rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              top: overlayGeom.top,
              width: overlayGeom.left,
              height: overlayGeom.height,
              background: "rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: overlayGeom.left + overlayGeom.width,
              top: overlayGeom.top,
              width: overlayGeom.cw - overlayGeom.left - overlayGeom.width,
              height: overlayGeom.height,
              background: "rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              top: overlayGeom.top + overlayGeom.height,
              width: overlayGeom.cw,
              height: overlayGeom.ch - overlayGeom.top - overlayGeom.height,
              background: "rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: overlayGeom.left,
              top: overlayGeom.top,
              width: overlayGeom.width,
              height: overlayGeom.height,
              boxSizing: "border-box",
              border: "2px dashed rgba(255,255,255,0.9)",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: overlayGeom.imgLeft,
              top: overlayGeom.imgTop,
              width: overlayGeom.imgW,
              height: overlayGeom.imgH,
              boxSizing: "border-box",
              border: "1px solid rgba(255,255,255,0.35)",
              pointerEvents: "none",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function LocationBaseCropPreview(props: {
  imageSrc: string;
  crop: CropPx | null;
  onCropChange: (c: CropPx) => void;
}) {
  const { imageSrc, crop, onCropChange } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [layout, setLayout] = useState({ cw: 200, ch: 200 });
  const dragRef = useRef<
    | null
    | {
        kind: "move" | "resize";
        orig: CropPx;
        startIx: number;
        startIy: number;
      }
  >(null);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const onLoad = () => {
      if (img.naturalWidth > 0) setNat({ w: img.naturalWidth, h: img.naturalHeight });
    };
    onLoad();
    img.addEventListener("load", onLoad);
    return () => img.removeEventListener("load", onLoad);
  }, [imageSrc]);

  useEffect(() => {
    if (!nat || crop != null) return;
    const side = Math.min(nat.w, nat.h) * 0.5;
    onCropChange({
      tx: (nat.w - side) / 2,
      ty: (nat.h - side) / 2,
      side,
    });
  }, [nat, crop, onCropChange]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setLayout({ cw: Math.max(1, el.clientWidth), ch: Math.max(1, el.clientHeight) });
    });
    ro.observe(el);
    setLayout({ cw: Math.max(1, el.clientWidth), ch: Math.max(1, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  const clientToImage = useCallback(
    (clientX: number, clientY: number): { ix: number; iy: number } | null => {
      const wrap = wrapRef.current;
      const n = nat;
      if (!wrap || !n) return null;
      const rect = wrap.getBoundingClientRect();
      const { ox, oy, dw, dh } = imageContainRect(rect.width, rect.height, n.w, n.h);
      const lx = clientX - rect.left - ox;
      const ly = clientY - rect.top - oy;
      const ix = (lx / dw) * n.w;
      const iy = (ly / dh) * n.h;
      return { ix: clamp(ix, 0, n.w), iy: clamp(iy, 0, n.h) };
    },
    [nat]
  );

  const imageCornerToClient = useCallback(
    (ix: number, iy: number): { x: number; y: number } | null => {
      const wrap = wrapRef.current;
      const n = nat;
      if (!wrap || !n) return null;
      const rect = wrap.getBoundingClientRect();
      const { ox, oy, dw, dh } = imageContainRect(rect.width, rect.height, n.w, n.h);
      return {
        x: rect.left + ox + (ix / n.w) * dw,
        y: rect.top + oy + (iy / n.h) * dh,
      };
    },
    [nat]
  );

  /** Client px: distance to bottom-right corner in screen space; threshold scales slightly with DPR. */
  const cornerHitPx = () => 26 * Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

  const onBrHandlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (!nat || !crop) return;
    const p = clientToImage(e.clientX, e.clientY);
    if (!p) return;
    dragRef.current = { kind: "resize", orig: { ...crop }, startIx: p.ix, startIy: p.iy };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onOverlayPointerDown = (e: React.PointerEvent) => {
    if (!nat || !crop) return;
    const p = clientToImage(e.clientX, e.clientY);
    if (!p) return;
    const brC = imageCornerToClient(crop.tx + crop.side, crop.ty + crop.side);
    if (!brC) return;
    const distBr = Math.hypot(e.clientX - brC.x, e.clientY - brC.y);
    const inside =
      p.ix >= crop.tx &&
      p.ix <= crop.tx + crop.side &&
      p.iy >= crop.ty &&
      p.iy <= crop.ty + crop.side;
    const inBrQuadrant = p.ix >= crop.tx && p.iy >= crop.ty;
    if (inBrQuadrant && distBr < cornerHitPx()) {
      dragRef.current = { kind: "resize", orig: { ...crop }, startIx: p.ix, startIy: p.iy };
    } else if (inside) {
      dragRef.current = { kind: "move", orig: { ...crop }, startIx: p.ix, startIy: p.iy };
    } else {
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const n = nat;
    if (!d || !n) return;
    const cur = clientToImage(e.clientX, e.clientY);
    if (!cur) return;
    if (d.kind === "move") {
      const dx = cur.ix - d.startIx;
      const dy = cur.iy - d.startIy;
      const tx = clamp(d.orig.tx + dx, 0, n.w - d.orig.side);
      const ty = clamp(d.orig.ty + dy, 0, n.h - d.orig.side);
      onCropChange({ tx, ty, side: d.orig.side });
    } else {
      const raw = Math.min(cur.ix - d.orig.tx, cur.iy - d.orig.ty);
      const maxSide = Math.min(n.w - d.orig.tx, n.h - d.orig.ty);
      const minSide = Math.min(n.w, n.h) * 0.05;
      const side = clamp(raw, minSide, maxSide);
      onCropChange({ tx: d.orig.tx, ty: d.orig.ty, side });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      dragRef.current = null;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  const overlayGeom = useMemo(() => {
    if (!nat || !crop) return null;
    const { cw, ch } = layout;
    const { ox, oy, dw, dh } = imageContainRect(cw, ch, nat.w, nat.h);
    const left = ox + (crop.tx / nat.w) * dw;
    const top = oy + (crop.ty / nat.h) * dh;
    const size = (crop.side / nat.w) * dw;
    return { ox, oy, dw, dh, left, top, size, cw, ch };
  }, [nat, crop, layout]);

  const outerStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.35)",
    background: "rgba(0,0,0,0.02)",
    maxWidth: "100%",
    width: "100%",
    boxSizing: "border-box",
    position: "relative",
    height: PREVIEW_MAX_H,
    minHeight: 120,
  };

  return (
    <div ref={wrapRef} style={outerStyle}>
      <img
        ref={imgRef}
        src={imageSrc}
        alt=""
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
          pointerEvents: "none",
          userSelect: "none",
        }}
      />
      {overlayGeom && crop ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "auto",
            touchAction: "none",
            cursor: "crosshair",
          }}
          onPointerDown={onOverlayPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: overlayGeom.cw,
              height: overlayGeom.top,
              background: "rgba(0,0,0,0.45)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              top: overlayGeom.top,
              width: overlayGeom.left,
              height: overlayGeom.size,
              background: "rgba(0,0,0,0.45)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: overlayGeom.left + overlayGeom.size,
              top: overlayGeom.top,
              width: overlayGeom.cw - overlayGeom.left - overlayGeom.size,
              height: overlayGeom.size,
              background: "rgba(0,0,0,0.45)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              top: overlayGeom.top + overlayGeom.size,
              width: overlayGeom.cw,
              height: overlayGeom.ch - overlayGeom.top - overlayGeom.size,
              background: "rgba(0,0,0,0.45)",
              pointerEvents: "none",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: overlayGeom.left,
              top: overlayGeom.top,
              width: overlayGeom.size,
              height: overlayGeom.size,
              boxSizing: "border-box",
              border: "2px solid rgba(255,255,255,0.95)",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}
          />
          <div
            role="presentation"
            style={{
              position: "absolute",
              left: overlayGeom.left + overlayGeom.size - 14,
              top: overlayGeom.top + overlayGeom.size - 14,
              width: 28,
              height: 28,
              border: "1px solid rgba(255,255,255,0.9)",
              background: "rgba(255,255,255,0.25)",
              boxSizing: "border-box",
              pointerEvents: "auto",
              touchAction: "none",
              cursor: "nwse-resize",
              zIndex: 2,
            }}
            onPointerDown={onBrHandlePointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function LocationDetailPage() {
  const router = useRouter();
  const { showError } = useAppError();
  const params = useParams<{ charKey: string }>();
  const locationKey = params?.charKey ?? "";

  const [split, setSplit] = useState<{
    view: LocationGalleryItem[];
    lighting: LocationGalleryItem[];
    hidden: LocationGalleryItem[];
    baseRelPath: string | null;
  } | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const [dragContainers, setDragContainers] = useState<{ view: string[]; lighting: string[] }>({
    view: [],
    lighting: [],
  });

  const [busy, setBusy] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [cropPx, setCropPx] = useState<CropPx | null>(null);
  const [outpaintMode, setOutpaintMode] = useState(false);
  const [outpaintBox, setOutpaintBox] = useState<OutpaintBoxPx | null>(null);
  const [outpaintNat, setOutpaintNat] = useState<{ w: number; h: number } | null>(null);
  const [maxOutpaintPerPass, setMaxOutpaintPerPass] = useState(DEFAULT_MAX_OUTPAINT_PER_PASS);
  const [outpaintStages, setOutpaintStages] = useState<OutpaintStage[] | null>(null);
  const [outpaintStageIndex, setOutpaintStageIndex] = useState(0);
  const [outpaintStageResult, setOutpaintStageResult] = useState<string | null>(null);
  const [outpaintStageInputRel, setOutpaintStageInputRel] = useState<string | null>(null);
  const [angleGroups, setAngleGroups] = useState<AngleGroup[]>([]);
  const [angleDialogOpen, setAngleDialogOpen] = useState(false);

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: jobRunning,
    beginSession,
    endSession,
    failSession,
    pushLog,
    setRunningStatus,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);
  const uiBusy = busy || jobRunning;

  const [menu, setMenu] = useState<{ open: boolean; x: number; y: number; item: LocationGalleryItem | null }>({
    open: false,
    x: 0,
    y: 0,
    item: null,
  });
  const [aiOpen, setAiOpen] = useState(false);
  const [aiCtx, setAiCtx] = useState<LocationGalleryItem | null>(null);
  const [lightbox, setLightbox] = useState<{ paths: string[]; index: number; title: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!locationKey) return;
    const data = await apiLocationGallerySplit(locationKey);
    setSplit(data);
    setPreviewVersion((v) => v + 1);
  }, [locationKey]);

  useEffect(() => {
    refresh().catch((e) => showError({ message: "Could not load location gallery.", error: e }));
  }, [refresh, showError]);

  useEffect(() => {
    if (!locationKey) return;
    apiLocationAngleGroups(locationKey)
      .then(setAngleGroups)
      .catch((e) => showError({ message: "Could not load angle groups.", error: e }));
  }, [locationKey, showError]);

  const clearOutpaintStageState = useCallback(() => {
    setOutpaintStages(null);
    setOutpaintStageIndex(0);
    setOutpaintStageResult(null);
    setOutpaintStageInputRel(null);
  }, []);

  const toggleCropMode = () => {
    setCropMode((m) => {
      if (!m) {
        setOutpaintMode(false);
        setOutpaintBox(null);
        setOutpaintNat(null);
        clearOutpaintStageState();
      } else {
        setCropPx(null);
      }
      return !m;
    });
  };

  const exitCropMode = useCallback(() => {
    setCropMode(false);
    setCropPx(null);
  }, []);

  const toggleOutpaintMode = () => {
    setOutpaintMode((m) => {
      if (!m) {
        exitCropMode();
      } else {
        clearOutpaintStageState();
        setOutpaintBox(null);
        setOutpaintNat(null);
      }
      return !m;
    });
  };

  const exitOutpaintMode = useCallback(() => {
    setOutpaintMode(false);
    setOutpaintBox(null);
    setOutpaintNat(null);
    clearOutpaintStageState();
  }, [clearOutpaintStageState]);

  const saveEditCopy = async () => {
    const baseRel = split?.baseRelPath ?? null;
    if (!locationKey || !baseRel || !cropPx) {
      showError({ message: "Define a crop area first." });
      return;
    }
    setBusy(true);
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = `${assetUrlFromRelPath(baseRel)}?v=${previewVersion}`;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Could not load base image."));
      });
      const s = Math.max(1, Math.round(cropPx.side));
      const c = document.createElement("canvas");
      c.width = s;
      c.height = s;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("Canvas unsupported.");
      ctx.drawImage(img, cropPx.tx, cropPx.ty, cropPx.side, cropPx.side, 0, 0, s, s);
      const blob = await new Promise<Blob>((resolve, reject) => {
        c.toBlob((b) => (b ? resolve(b) : reject(new Error("Export failed."))), "image/png");
      });
      await apiLocationSaveViewCopy({ locationKey, blob, filename: "crop.png" });
      await refresh();
      setCropMode(false);
      setCropPx(null);
    } catch (e) {
      showError({ message: "Could not save cropped copy.", error: e });
    } finally {
      setBusy(false);
    }
  };

  async function confirmAngles(selectedAngleIds: number[], manualFiles: File[]) {
    setAngleDialogOpen(false);
    if (!locationKey) return;
    if (!selectedAngleIds.length) {
      showError({ message: "Select at least one angle." });
      return;
    }
    if (manualFiles.length === 0 && !split?.baseRelPath) {
      showError({ message: "No base image. Set a cover or upload files in the modal." });
      return;
    }
    beginSession({ title: "Generating location angles", clearLog: true });
    let sessionOk = false;
    try {
      await apiLocationGenerateAnglesStream({
        locationKey,
        angleIds: selectedAngleIds,
        inputRelPath: manualFiles.length ? undefined : split?.baseRelPath ?? undefined,
        files: manualFiles.length ? manualFiles : undefined,
        onLogLine: (line) => {
          logRef.current?.pushLine(line);
          setRunningStatus(truncateJobModalStatusLine(line));
        },
      });
      await refresh();
      sessionOk = true;
    } catch (e) {
      failSession(e, "Angle generation failed");
    } finally {
      if (sessionOk) endSession();
    }
  }

  async function runOutpaintStage(params: {
    sourceRelPath: string;
    stage: OutpaintStage;
    stageIndex: number;
    totalStages: number;
    finishOnDone: boolean;
  }) {
    const { sourceRelPath, stage, stageIndex, totalStages, finishOnDone } = params;
    beginSession({
      title:
        totalStages > 1
          ? `Outpainting (${stageIndex + 1}/${totalStages})`
          : "Outpainting location",
      clearLog: true,
    });
    let sessionOk = false;
    try {
      const result = await apiLocationOutpaintStream({
        locationKey,
        sourceRelPath,
        left: stage.left,
        top: stage.top,
        right: stage.right,
        bottom: stage.bottom,
        onLogLine: (line) => {
          logRef.current?.pushLine(line);
          setRunningStatus(truncateJobModalStatusLine(line));
        },
      });
      await refresh();
      if (finishOnDone) {
        exitOutpaintMode();
      } else {
        setOutpaintStageResult(result.relPath);
      }
      sessionOk = true;
    } catch (e) {
      failSession(e, "Outpaint failed");
    } finally {
      if (sessionOk) endSession();
    }
  }

  async function confirmOutpaint() {
    const baseRelPath = split?.baseRelPath ?? null;
    if (!locationKey || !baseRelPath || !outpaintBox || !outpaintNat) {
      showError({ message: "Define an outpaint area first." });
      return;
    }
    const pad = paddingFromOutpaintBox(outpaintBox, outpaintNat);
    if (!hasOutpaintPadding(pad)) {
      showError({ message: "Drag a box edge outward to extend the canvas." });
      return;
    }
    const stages = splitOutpaintIntoStages(pad, maxOutpaintPerPass);
    setOutpaintStages(stages);
    setOutpaintStageIndex(0);
    setOutpaintStageInputRel(baseRelPath);
    setOutpaintStageResult(null);
    await runOutpaintStage({
      sourceRelPath: baseRelPath,
      stage: stages[0],
      stageIndex: 0,
      totalStages: stages.length,
      finishOnDone: stages.length === 1,
    });
  }

  async function regenOutpaintStage() {
    if (!locationKey || !outpaintStages || outpaintStageInputRel == null) return;
    const stage = outpaintStages[outpaintStageIndex];
    if (!stage || !hasOutpaintPadding(stage)) return;
    setOutpaintStageResult(null);
    await runOutpaintStage({
      sourceRelPath: outpaintStageInputRel,
      stage,
      stageIndex: outpaintStageIndex,
      totalStages: outpaintStages.length,
      finishOnDone: false,
    });
  }

  async function continueOutpaintStage() {
    if (!locationKey || !outpaintStages || !outpaintStageResult) return;
    const nextIndex = outpaintStageIndex + 1;
    if (nextIndex >= outpaintStages.length) {
      await refresh();
      exitOutpaintMode();
      return;
    }
    const nextStage = outpaintStages[nextIndex];
    const inputRel = outpaintStageResult;
    setOutpaintStageInputRel(inputRel);
    setOutpaintStageIndex(nextIndex);
    setOutpaintStageResult(null);
    await runOutpaintStage({
      sourceRelPath: inputRel,
      stage: nextStage,
      stageIndex: nextIndex,
      totalStages: outpaintStages.length,
      finishOnDone: false,
    });
  }

  async function finishOutpaintStages() {
    await refresh();
    exitOutpaintMode();
  }

  const menuItems: ContextMenuItem[] = useMemo(() => {
    const it = menu.item;
    if (!it) return [];
    const inHidden = Boolean(split?.hidden.some((x) => x.itemId === it.itemId));
    return [
      {
        key: "preview",
        label: "Preview",
        onSelect: () => {
          const list = [...(split?.view ?? []), ...(split?.lighting ?? []), ...(split?.hidden ?? [])];
          const paths = list.map((x) => assetUrlFromRelPath(x.relPath));
          const ix = list.findIndex((x) => x.itemId === it.itemId);
          if (ix >= 0) setLightbox({ paths, index: ix, title: "Location Preview" });
        },
      },
      {
        key: "download",
        label: "Download",
        onSelect: () => window.open(assetDownloadUrlFromRelPath(it.relPath), "_blank"),
      },
      {
        key: "aiEdit",
        label: "AI Edit",
        onSelect: () => {
          setAiCtx(it);
          setAiOpen(true);
        },
      },
      inHidden
        ? {
            key: "unhide",
            label: "Unhide",
            onSelect: async () => {
              await apiLocationUnhide({ locationKey, itemIds: [it.itemId] });
              await refresh();
            },
          }
        : {
            key: "hide",
            label: "Hide",
            onSelect: async () => {
              await apiLocationHide({ locationKey, itemIds: [it.itemId] });
              await refresh();
            },
          },
      {
        key: "delete",
        label: "Delete",
        onSelect: async () => {
          await apiLocationDeleteItems({ locationKey, itemIds: [it.itemId] });
          await refresh();
        },
      },
    ];
  }, [menu.item, split, locationKey, refresh]);

  const renderSection = (
    title: string,
    items: LocationGalleryItem[],
    opts?: { selectable?: boolean },
  ) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ marginBottom: 6 }}>{title}</div>
      <ResizableScrollGallery aria-label={title}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {items.map((it) => {
            const isSelected = opts?.selectable && it.itemId === selectedPreviewId;
            return (
              <button
                key={it.itemId}
                type="button"
                onClick={opts?.selectable ? () => setSelectedPreviewId(it.itemId) : undefined}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ open: true, x: e.clientX, y: e.clientY, item: it });
                }}
                style={{
                  width: 120,
                  height: 120,
                  border: isSelected ? "2px solid #000" : "1px solid rgba(0,0,0,0.35)",
                  background: "transparent",
                  padding: 0,
                  overflow: "hidden",
                  cursor: opts?.selectable ? "pointer" : undefined,
                  boxSizing: "border-box",
                }}
              >
                <img
                  src={assetUrlFromRelPath(it.relPath)}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                />
              </button>
            );
          })}
        </div>
      </ResizableScrollGallery>
    </div>
  );

  const baseRel = split?.baseRelPath ?? null;
  const previewSrc = baseRel ? `${assetUrlFromRelPath(baseRel)}?v=${previewVersion}` : "";
  const canSaveCrop = Boolean(cropMode && cropPx && baseRel);
  const outpaintPad = useMemo(() => {
    if (!outpaintBox || !outpaintNat) return null;
    return paddingFromOutpaintBox(outpaintBox, outpaintNat);
  }, [outpaintBox, outpaintNat]);
  const plannedOutpaintStages = useMemo(() => {
    if (!outpaintPad || !hasOutpaintPadding(outpaintPad)) return null;
    return splitOutpaintIntoStages(outpaintPad, maxOutpaintPerPass);
  }, [outpaintPad, maxOutpaintPerPass]);
  const outpaintInStageReview = Boolean(outpaintMode && outpaintStageResult && outpaintStages);
  const outpaintIsLastStageDone =
    outpaintInStageReview &&
    outpaintStages != null &&
    outpaintStageIndex >= outpaintStages.length - 1;
  const canRunOutpaint = Boolean(
    outpaintMode &&
      baseRel &&
      outpaintPad &&
      hasOutpaintPadding(outpaintPad) &&
      !outpaintStageResult &&
      !jobRunning
  );

  const previewList = useMemo(
    () => [...(split?.view ?? []), ...(split?.lighting ?? [])],
    [split],
  );
  const selectedPreviewIndex = selectedPreviewId
    ? previewList.findIndex((x) => x.itemId === selectedPreviewId)
    : -1;
  const effectivePreviewIndex = selectedPreviewId ? selectedPreviewIndex : 0;
  const effectivePreviewItem = previewList[effectivePreviewIndex] ?? null;
  const effectiveRelPath = effectivePreviewItem?.relPath ?? baseRel ?? "";
  const effectivePreviewSrc = effectiveRelPath
    ? `${assetUrlFromRelPath(effectiveRelPath)}?v=${previewVersion}`
    : "";
  const previewStackLength = previewList.length || 1;
  const previewStackIndex = Math.max(0, effectivePreviewIndex);

  useEffect(() => {
    if (selectedPreviewId && split) {
      const allItems = [...split.view, ...split.lighting];
      if (!allItems.some((x) => x.itemId === selectedPreviewId)) {
        setSelectedPreviewId(null);
      }
    }
  }, [split, selectedPreviewId]);

  useEffect(() => {
    setDragContainers({
      view: (split?.view ?? []).filter((x) => !x.itemId.startsWith("root:")).map((x) => x.itemId),
      lighting: (split?.lighting ?? []).map((x) => x.itemId),
    });
  }, [split]);

  const toolBtnStyle = (active?: boolean): React.CSSProperties => ({
    flex: 1,
    minWidth: 0,
    borderRadius: 0,
    border: "1px solid rgba(0,0,0,0.45)",
    background: active ? "rgba(0,0,0,0.08)" : "transparent",
    padding: "10px 8px",
    cursor: uiBusy ? "not-allowed" : "pointer",
    fontSize: 14,
    opacity: uiBusy ? 0.55 : 1,
  });

  return (
    <DetailSubpageChrome onHome={() => router.push("/home")} onBack={() => router.push("/location_hub")}>
      <div style={{ paddingLeft: 20, paddingRight: 20, maxWidth: 980 }}>
        <div style={{ marginBottom: 8 }}>Location: {locationKey}</div>

        <div style={{ marginBottom: 12, width: "100%" }}>
          {baseRel ? (
            cropMode ? (
              <LocationBaseCropPreview imageSrc={previewSrc} crop={cropPx} onCropChange={setCropPx} />
            ) : outpaintMode && outpaintStageResult ? (
              <div
                style={{
                  border: "1px solid rgba(0,0,0,0.35)",
                  background: "rgba(0,0,0,0.02)",
                  maxWidth: "100%",
                  width: "100%",
                  boxSizing: "border-box",
                  position: "relative",
                  height: PREVIEW_MAX_H,
                  minHeight: 120,
                }}
              >
                <img
                  src={`${assetUrlFromRelPath(outpaintStageResult)}?v=${previewVersion}`}
                  alt=""
                  draggable={false}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    display: "block",
                    userSelect: "none",
                  }}
                />
              </div>
            ) : outpaintMode ? (
              <LocationOutpaintPreview
                imageSrc={previewSrc}
                box={outpaintBox}
                onBoxChange={setOutpaintBox}
                onNatChange={setOutpaintNat}
              />
            ) : (
              <StartingImagePreview
                storageRelPath={effectiveRelPath}
                stackLength={previewStackLength}
                stackIndex={previewStackIndex}
                onPrev={() => {
                  if (effectivePreviewIndex > 0)
                    setSelectedPreviewId(previewList[effectivePreviewIndex - 1].itemId);
                }}
                onNext={() => {
                  if (effectivePreviewIndex < previewList.length - 1)
                    setSelectedPreviewId(previewList[effectivePreviewIndex + 1].itemId);
                }}
                onDeleteCacheEntry={() => {}}
                onImageError={() => {}}
                fitMaxWidth={PREVIEW_MAX_W}
                fitMaxHeight={PREVIEW_MAX_H}
                imageSrc={effectivePreviewSrc || previewSrc}
              />
            )
          ) : (
            <div
              style={{
                width: "100%",
                height: 140,
                flexShrink: 0,
                border: "1px solid rgba(0,0,0,0.35)",
                background: "rgba(0,0,0,0.02)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                lineHeight: 1.25,
                opacity: 0.75,
                padding: 8,
                boxSizing: "border-box",
                textAlign: "center",
              }}
            >
              No base image
            </div>
          )}
        </div>

        {outpaintMode && !outpaintStageResult ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 10,
              flexWrap: "wrap",
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              <span style={{ whiteSpace: "nowrap" }}>Max per pass</span>
              <input
                type="range"
                min={MIN_MAX_OUTPAINT_PER_PASS}
                max={MAX_MAX_OUTPAINT_PER_PASS}
                step={MAX_OUTPAINT_PER_PASS_STEP}
                value={maxOutpaintPerPass}
                disabled={uiBusy}
                onChange={(e) => setMaxOutpaintPerPass(clampMaxOutpaintPerPass(Number(e.target.value)))}
              />
              <span style={{ minWidth: 44 }}>{maxOutpaintPerPass}px</span>
            </label>
            {plannedOutpaintStages && plannedOutpaintStages.length > 1 ? (
              <span style={{ fontSize: 13, opacity: 0.75 }}>
                Will run in {plannedOutpaintStages.length} stages
              </span>
            ) : null}
          </div>
        ) : null}

        {outpaintInStageReview && outpaintStages ? (
          <div style={{ marginBottom: 10, fontSize: 14, opacity: 0.85 }}>
            Stage {outpaintStageIndex + 1}/{outpaintStages.length} complete
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button
            type="button"
            disabled={uiBusy || !baseRel}
            style={toolBtnStyle(cropMode)}
            onClick={() => {
              if (!baseRel) return;
              toggleCropMode();
            }}
          >
            Crop
          </button>
          <button
            type="button"
            disabled={uiBusy || !baseRel}
            style={toolBtnStyle(outpaintMode)}
            onClick={() => {
              if (!baseRel) return;
              toggleOutpaintMode();
            }}
          >
            Outpaint
          </button>
          <button
            type="button"
            disabled={uiBusy}
            style={toolBtnStyle()}
            onClick={() => {
              exitOutpaintMode();
              setAngleDialogOpen(true);
            }}
          >
            New Angle
          </button>
          <button
            type="button"
            disabled={uiBusy}
            style={toolBtnStyle()}
            onClick={() => {
              exitCropMode();
              exitOutpaintMode();
              showError({ message: "Coming soon" });
            }}
          >
            Lighting
          </button>
        </div>

        <button
          type="button"
          disabled={uiBusy || !canSaveCrop}
          onClick={() => void saveEditCopy()}
          style={{
            width: "100%",
            borderRadius: 0,
            border: "1px solid rgba(0,0,0,0.55)",
            background: "rgba(0,0,0,0.06)",
            padding: "12px 14px",
            cursor: uiBusy || !canSaveCrop ? "not-allowed" : "pointer",
            fontSize: 15,
            marginBottom: outpaintMode ? 8 : 16,
            opacity: uiBusy || !canSaveCrop ? 0.5 : 1,
            display: cropMode ? "block" : "none",
          }}
        >
          Save Edit as Copy
        </button>

        <button
          type="button"
          disabled={uiBusy || !canRunOutpaint}
          onClick={() => void confirmOutpaint()}
          style={{
            width: "100%",
            borderRadius: 0,
            border: "1px solid rgba(0,0,0,0.55)",
            background: "rgba(0,0,0,0.06)",
            padding: "12px 14px",
            cursor: uiBusy || !canRunOutpaint ? "not-allowed" : "pointer",
            fontSize: 15,
            marginBottom: outpaintInStageReview ? 8 : 16,
            opacity: uiBusy || !canRunOutpaint ? 0.5 : 1,
            display: outpaintMode && !outpaintStageResult ? "block" : "none",
          }}
        >
          Run Outpaint
        </button>

        {outpaintInStageReview ? (
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <button
              type="button"
              disabled={uiBusy}
              onClick={() => void regenOutpaintStage()}
              style={{
                flex: 1,
                borderRadius: 0,
                border: "1px solid rgba(0,0,0,0.55)",
                background: "rgba(0,0,0,0.06)",
                padding: "12px 14px",
                cursor: uiBusy ? "not-allowed" : "pointer",
                fontSize: 15,
                opacity: uiBusy ? 0.5 : 1,
              }}
            >
              Regen
            </button>
            <button
              type="button"
              disabled={uiBusy}
              onClick={() =>
                void (outpaintIsLastStageDone ? finishOutpaintStages() : continueOutpaintStage())
              }
              style={{
                flex: 1,
                borderRadius: 0,
                border: "1px solid rgba(0,0,0,0.55)",
                background: "rgba(0,0,0,0.06)",
                padding: "12px 14px",
                cursor: uiBusy ? "not-allowed" : "pointer",
                fontSize: 15,
                opacity: uiBusy ? 0.5 : 1,
              }}
            >
              {outpaintIsLastStageDone ? "Finish" : "Continue"}
            </button>
          </div>
        ) : null}

        <SortableMultiGrid
          disabled={uiBusy}
          crossContainerPreview
          containers={[
            { id: "view", ids: dragContainers.view },
            { id: "lighting", ids: dragContainers.lighting },
          ]}
          renderContainer={({ containerId, children, setContainerRef }) => {
            const rootItems =
              containerId === "view"
                ? (split?.view ?? []).filter((x) => x.itemId.startsWith("root:"))
                : [];
            return (
              <div style={{ marginBottom: 14 }}>
                <div style={{ marginBottom: 6 }}>
                  {containerId === "view" ? "View" : "Lighting"}
                </div>
                <ResizableScrollGallery
                  aria-label={containerId === "view" ? "View gallery" : "Lighting gallery"}
                >
                  <div
                    ref={setContainerRef as React.Ref<HTMLDivElement>}
                    style={{ display: "flex", flexWrap: "wrap", gap: 8, minHeight: 30 }}
                  >
                    {rootItems.map((it) => {
                      const isSelected = it.itemId === selectedPreviewId;
                      return (
                        <button
                          key={it.itemId}
                          type="button"
                          onClick={() => setSelectedPreviewId(it.itemId)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setMenu({ open: true, x: e.clientX, y: e.clientY, item: it });
                          }}
                          style={{
                            width: 120,
                            height: 120,
                            border: isSelected ? "2px solid #000" : "1px solid rgba(0,0,0,0.35)",
                            background: "transparent",
                            padding: 0,
                            overflow: "hidden",
                            cursor: "pointer",
                            boxSizing: "border-box",
                          }}
                        >
                          <img
                            src={assetUrlFromRelPath(it.relPath)}
                            alt=""
                            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                          />
                        </button>
                      );
                    })}
                    {children}
                  </div>
                </ResizableScrollGallery>
              </div>
            );
          }}
          renderItem={({ id, containerId }) => {
            const allItems = [...(split?.view ?? []), ...(split?.lighting ?? [])];
            let it = allItems.find((x) => x.itemId === id);
            if (!it && id.includes(":")) {
              const fn = id.slice(id.indexOf(":") + 1);
              it = allItems.find((x) => x.itemId.endsWith(`:${fn}`));
            }
            if (!it) return null;
            const isSelected = it.itemId === selectedPreviewId;
            return (
              <SortableItemInContainer id={id} containerId={containerId} disabled={uiBusy}>
                <button
                  type="button"
                  onClick={() => setSelectedPreviewId(it!.itemId)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ open: true, x: e.clientX, y: e.clientY, item: it! });
                  }}
                  style={{
                    width: 120,
                    height: 120,
                    border: isSelected ? "2px solid #000" : "1px solid rgba(0,0,0,0.35)",
                    background: "transparent",
                    padding: 0,
                    overflow: "hidden",
                    cursor: uiBusy ? "not-allowed" : "grab",
                    boxSizing: "border-box",
                    touchAction: "none",
                  }}
                >
                  <img
                    src={assetUrlFromRelPath(it!.relPath)}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", pointerEvents: "none" }}
                  />
                </button>
              </SortableItemInContainer>
            );
          }}
          renderDragOverlay={({ id }) => {
            const allItems = [...(split?.view ?? []), ...(split?.lighting ?? [])];
            let it = allItems.find((x) => x.itemId === id);
            if (!it && id.includes(":")) {
              const fn = id.slice(id.indexOf(":") + 1);
              it = allItems.find((x) => x.itemId.endsWith(`:${fn}`));
            }
            if (!it) return null;
            return (
              <div
                style={{
                  width: 120,
                  height: 120,
                  border: "1px solid rgba(0,0,0,0.35)",
                  overflow: "hidden",
                  cursor: "grabbing",
                  opacity: 0.85,
                }}
              >
                <img
                  src={assetUrlFromRelPath(it.relPath)}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                />
              </div>
            );
          }}
          onDragEnd={({ activeId, overId, insertAfter, sourceContainerId, targetContainerId }) => {
            const r = reorderInsertBeforeOrAfter({
              activeId,
              overId,
              insertAfter,
              sourceContainerId,
              targetContainerId,
              containers: { view: dragContainers.view, lighting: dragContainers.lighting },
              selectedIds: new Set(),
            });
            const nextView = r.containers.view ?? [];
            const nextLighting = r.containers.lighting ?? [];
            setDragContainers({ view: nextView, lighting: nextLighting });
            void apiLocationGalleryReorder({ locationKey, view: nextView, lighting: nextLighting })
              .then(() => refresh());
          }}
        />
        {renderSection("Hidden", split?.hidden ?? [])}
      </div>
      <DesktopContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        items={menuItems}
        onClose={() => setMenu((m) => ({ ...m, open: false }))}
      />
      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />
      <CameraAngleModal
        open={angleDialogOpen}
        title="New Angle"
        imageUrl={baseRel ? assetUrlFromRelPath(baseRel) : null}
        onCancel={() => setAngleDialogOpen(false)}
        onConfirm={(angleId) => void confirmAngles([angleId], [])}
      />
      <AiEditModal
        open={aiOpen}
        title="AI Edit"
        imageSrc={aiCtx ? assetUrlFromRelPath(aiCtx.relPath) : ""}
        busy={uiBusy}
        placeholder="Describe the edit (e.g. 'empty forest background' or 'add a bench')"
        onCancel={() => setAiOpen(false)}
        onGenerate={async (promptText, maskPngBase64) => {
          const ctx = aiCtx;
          if (!ctx) return;
          const section = ctx.folderKey === "lighting" ? "lighting" : "view";
          setAiOpen(false);
          beginSession({ title: "AI Editing", clearLog: true, runningStatus: "AI editing…" });
          await Promise.resolve();
          pushLog("AI editing…");
          try {
            await apiLocationAiEdit({
              locationKey,
              section,
              sourceRelPath: ctx.relPath,
              promptText,
              maskPngBase64,
            });
            await refresh();
            endSession();
          } catch (e) {
            failSession(e, "AI Edit failed.");
          }
        }}
      />
      {lightbox ? (
        <GalleryImageLightbox
          key={`${lightbox.paths.join("|")}-${lightbox.index}-${lightbox.title}`}
          {...lightbox}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </DetailSubpageChrome>
  );
}
