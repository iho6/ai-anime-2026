"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

const VIEWPORT_MARGIN = 8;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(v, hi));
}

export type ContextMenuItem = {
  key: string;
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Hover flyout content anchored to this row. */
  submenu?: React.ReactNode;
  /** When true, selecting/hovering does not close the menu. */
  keepOpenOnSelect?: boolean;
};

export type DesktopContextMenuState = {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  footerItems?: ContextMenuItem[];
};

type MenuLayout = {
  left: number;
  top: number;
  maxInnerHeight?: number;
};

type FlyoutLayout = {
  left: number;
  top: number;
};

const menuButtonStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid rgba(255,255,255,0.35)",
  background: "transparent",
  color: "white",
  textAlign: "left",
  padding: "6px 8px",
  borderRadius: 0,
  cursor: "pointer",
};

export function DesktopContextMenu(props: {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Pinned below main items (e.g. copy/paste). Optional separator when non-empty. */
  footerItems?: ContextMenuItem[];
  onClose: () => void;
}) {
  const { open, x, y, items, footerItems = [], onClose } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const innerColRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const submenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [layout, setLayout] = useState<MenuLayout | null>(null);
  const [activeSubmenuKey, setActiveSubmenuKey] = useState<string | null>(null);
  const [flyoutLayout, setFlyoutLayout] = useState<FlyoutLayout | null>(null);

  const activeItem = items.find((it) => it.key === activeSubmenuKey && it.submenu);

  const cancelSubmenuClose = React.useCallback(() => {
    if (submenuCloseTimerRef.current) {
      clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  }, []);

  const scheduleSubmenuClose = React.useCallback(() => {
    cancelSubmenuClose();
    submenuCloseTimerRef.current = setTimeout(() => {
      setActiveSubmenuKey(null);
    }, 120);
  }, [cancelSubmenuClose]);

  useEffect(() => () => cancelSubmenuClose(), [cancelSubmenuClose]);

  const applyViewportFit = React.useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = VIEWPORT_MARGIN;
    const availH = window.innerHeight - 2 * margin;
    const inner = innerColRef.current;
    const contentH = inner ? inner.scrollHeight : rect.height;
    const needsScroll = contentH > availH;
    const effectiveH = needsScroll ? availH : Math.min(rect.height, availH);
    const left = clamp(
      x,
      margin,
      Math.max(margin, window.innerWidth - rect.width - margin)
    );
    const top = clamp(
      y,
      margin,
      Math.max(margin, window.innerHeight - effectiveH - margin)
    );
    const next: MenuLayout = {
      left,
      top,
      maxInnerHeight: needsScroll ? availH : undefined,
    };
    setLayout((prev) =>
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.maxInnerHeight === next.maxInnerHeight
        ? prev
        : next
    );
  }, [x, y]);

  const applyFlyoutFit = React.useCallback(() => {
    if (!activeSubmenuKey) {
      setFlyoutLayout(null);
      return;
    }
    const row = rowRefs.current.get(activeSubmenuKey);
    if (!row) return;
    const rowRect = row.getBoundingClientRect();
    const margin = VIEWPORT_MARGIN;
    const flyoutEl = flyoutRef.current;
    const measured = flyoutEl?.getBoundingClientRect();
    const flyoutW = measured && measured.width > 0 ? measured.width : 188;
    const flyoutH = measured && measured.height > 0 ? measured.height : 220;
    let left = rowRect.right;
    let top = rowRect.top + rowRect.height / 2 - flyoutH / 2;
    if (left + flyoutW > window.innerWidth - margin) {
      left = rowRect.left - flyoutW;
    }
    left = clamp(left, margin, Math.max(margin, window.innerWidth - flyoutW - margin));
    top = clamp(top, margin, Math.max(margin, window.innerHeight - flyoutH - margin));
    setFlyoutLayout((prev) =>
      prev && prev.left === left && prev.top === top ? prev : { left, top }
    );
  }, [activeSubmenuKey]);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      setActiveSubmenuKey(null);
      setFlyoutLayout(null);
      return;
    }
    applyViewportFit();
  }, [open, x, y, items, footerItems, applyViewportFit]);

  useLayoutEffect(() => {
    if (!open) return;
    applyFlyoutFit();
  }, [open, activeSubmenuKey, layout, applyFlyoutFit]);

  useEffect(() => {
    if (!open || !activeSubmenuKey) return;
    const el = flyoutRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => applyFlyoutFit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, activeSubmenuKey, flyoutLayout, applyFlyoutFit]);

  useEffect(() => {
    if (!open) return;
    function onResize() {
      applyViewportFit();
      applyFlyoutFit();
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, applyViewportFit, applyFlyoutFit]);

  useEffect(() => {
    if (!open) return;

    function onDocMouseDown(e: MouseEvent) {
      const el = rootRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    document.addEventListener("pointerdown", onDocMouseDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocMouseDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const left = layout?.left ?? x;
  const top = layout?.top ?? y;
  const maxInnerHeight = layout?.maxInnerHeight;

  return (
    <div ref={rootRef} style={{ width: "fit-content" }}>
      <div
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseEnter={cancelSubmenuClose}
        onMouseLeave={scheduleSubmenuClose}
        style={{
          position: "fixed",
          left,
          top,
          zIndex: 20000,
          background: "rgba(0,0,0,0.85)",
          border: "1px solid rgba(255,255,255,0.35)",
          borderRadius: 0,
          padding: 0,
          minWidth: 200,
        }}
      >
        <div
          ref={innerColRef}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 0,
            maxHeight: maxInnerHeight,
            overflowY: maxInnerHeight != null ? "auto" : undefined,
          }}
        >
          {items.map((it, idx) => (
            <button
              key={it.key}
              ref={(el) => {
                if (el) rowRefs.current.set(it.key, el);
                else rowRefs.current.delete(it.key);
              }}
              disabled={it.disabled}
              onMouseEnter={() => {
                cancelSubmenuClose();
                setActiveSubmenuKey(it.submenu ? it.key : null);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (it.submenu) {
                  setActiveSubmenuKey(it.key);
                  return;
                }
                it.onSelect?.();
                onClose();
              }}
              style={{
                ...menuButtonStyle,
                marginTop: idx === 0 ? 0 : -1,
                cursor: it.disabled ? "not-allowed" : "pointer",
                opacity: it.disabled ? 0.5 : 1,
                background:
                  activeSubmenuKey === it.key
                    ? "rgba(255,255,255,0.08)"
                    : "transparent",
              }}
            >
              {it.submenu ? `${it.label} ›` : it.label}
            </button>
          ))}
          {footerItems.length > 0 ? (
            <div
              style={{
                borderTop: "1px solid rgba(255,255,255,0.25)",
                background: "rgba(0,0,0,0.45)",
              }}
            >
              {footerItems.map((it, idx) => (
                <button
                  key={it.key}
                  disabled={it.disabled}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    it.onSelect?.();
                    onClose();
                  }}
                  style={{
                    ...menuButtonStyle,
                    marginTop: idx === 0 ? 0 : -1,
                    cursor: it.disabled ? "not-allowed" : "pointer",
                    opacity: it.disabled ? 0.5 : 1,
                    width: "100%",
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {activeItem?.submenu && flyoutLayout ? (
        <div
          ref={flyoutRef}
          className="clip-coloring-flyout-enter"
          onMouseEnter={() => {
            cancelSubmenuClose();
            setActiveSubmenuKey(activeItem.key);
          }}
          onMouseLeave={scheduleSubmenuClose}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: flyoutLayout.left,
            top: flyoutLayout.top,
            zIndex: 20001,
            background: "rgba(0,0,0,0.85)",
            border: "1px solid rgba(255,255,255,0.35)",
            borderRadius: 0,
            overflow: "hidden",
          }}
        >
          {activeItem.submenu}
        </div>
      ) : null}
    </div>
  );
}
