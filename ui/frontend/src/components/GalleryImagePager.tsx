"use client";

import React from "react";
import { CloseIcon, SquareIconButton, TriangleIcon } from "./IconPrimitives";

const MODAL_BTN: React.CSSProperties = {
  color: "#eee",
  borderColor: "rgba(238,238,238,0.9)",
  background: "rgba(238,238,238,0.15)",
};

export function GalleryImagePager(props: {
  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
  onClose?: () => void;
  /** Rendered after Next and before Close (e.g. timeline play). */
  extraAfterNext?: React.ReactNode;
  variant: "modalLight" | "pageDark";
  style?: React.CSSProperties;
}) {
  const { index, count, onPrev, onNext, onClose, extraAfterNext, variant, style } = props;
  if (count <= 0) return null;

  const canPrev = index > 0;
  const canNext = index < count - 1;
  const isModal = variant === "modalLight";
  const labelStyle: React.CSSProperties = isModal
    ? {
        fontSize: 13,
        opacity: 0.85,
        minWidth: 56,
        textAlign: "center",
        color: "#eee",
      }
    : {
        fontSize: 13,
        opacity: 0.85,
        minWidth: 100,
        textAlign: "center",
      };

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        justifyContent: "center",
        ...(isModal ? { marginTop: 12 } : { padding: "8px 0" }),
        ...style,
      }}
    >
      <SquareIconButton
        aria-label="Previous image"
        title="Previous"
        icon={<TriangleIcon direction="left" />}
        tone={isModal ? "light" : "dark"}
        disabled={!canPrev}
        style={isModal ? MODAL_BTN : undefined}
        className={!isModal ? "ui-square-btn--startingNav" : undefined}
        onClick={() => {
          if (canPrev) onPrev();
        }}
      />
      <span style={labelStyle}>
        {index + 1} / {count}
      </span>
      <SquareIconButton
        aria-label="Next image"
        title="Next"
        icon={<TriangleIcon direction="right" />}
        tone={isModal ? "light" : "dark"}
        disabled={!canNext}
        style={isModal ? MODAL_BTN : undefined}
        className={!isModal ? "ui-square-btn--startingNav" : undefined}
        onClick={() => {
          if (canNext) onNext();
        }}
      />
      {extraAfterNext}
      {onClose ? (
        <SquareIconButton
          aria-label="Close preview"
          title="Close"
          icon={<CloseIcon />}
          tone="light"
          style={MODAL_BTN}
          onClick={onClose}
        />
      ) : null}
    </div>
  );
}
