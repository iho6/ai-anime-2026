"use client";

import React from "react";

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.8)",
  zIndex: 10001,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
};

type Props = {
  title: string;
  onBackdropMouseDown: () => void;
  children: React.ReactNode;
};

/**
 * Shared modal shell: dim backdrop (click to dismiss), title, inner area that stops propagation.
 */
export function LightboxModalChrome(props: Props) {
  const { title, onBackdropMouseDown, children } = props;
  return (
    <div style={backdropStyle} onMouseDown={onBackdropMouseDown}>
      <div style={{ color: "white", marginBottom: 8 }}>{title}</div>
      <div onMouseDown={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
