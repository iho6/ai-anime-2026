"use client";

import React from "react";
import { SquareButton } from "./SquareButton";

type IconDirection = "left" | "right" | "up" | "down";

export function TriangleIcon(props: { direction: IconDirection; size?: number }) {
  const size = props.size ?? 14;
  const rotation =
    props.direction === "left"
      ? 270
      : props.direction === "right"
        ? 90
        : props.direction === "down"
          ? 180
          : 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      style={{ transform: `rotate(${rotation}deg)`, display: "block" }}
    >
      <polygon points="12,4 20,18 4,18" fill="currentColor" />
    </svg>
  );
}

export function HomeIcon(props: { size?: number }) {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ display: "block" }}>
      <path
        fill="currentColor"
        d="M12 3 3 10.5v10.5h6.5v-6h5v6H21V10.5L12 3z"
      />
    </svg>
  );
}

export function CloseIcon(props: { size?: number }) {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ display: "block" }}>
      <path
        fill="currentColor"
        d="M6.5 5.1 12 10.6l5.5-5.5 1.4 1.4-5.5 5.5 5.5 5.5-1.4 1.4L12 13.4l-5.5 5.5-1.4-1.4 5.5-5.5-5.5-5.5 1.4-1.4z"
      />
    </svg>
  );
}

export function CheckIcon(props: { size?: number }) {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ display: "block" }}>
      <path
        fill="currentColor"
        d="M9.2 16.6 4.8 12.2 6.2 10.8l3 3 8.6-8.6 1.4 1.4-10 10-1-1z"
      />
    </svg>
  );
}

/** Circle + right triangle (timeline play; outer square is SquareButton chrome). */
export function TimelinePlayIcon(props: { size?: number }) {
  const size = props.size ?? 20;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ display: "block" }}>
      <circle cx="12" cy="12" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.15" />
      <polygon points="9,7.75 9,16.25 18,12" fill="currentColor" />
    </svg>
  );
}

export function PauseBarsIcon(props: { size?: number }) {
  const size = props.size ?? 20;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ display: "block" }}>
      <rect x="8" y="8" width="2.8" height="8" rx="0.5" fill="currentColor" />
      <rect x="13.2" y="8" width="2.8" height="8" rx="0.5" fill="currentColor" />
    </svg>
  );
}

export function GearIcon(props: { size?: number }) {
  const size = props.size ?? 14;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ display: "block" }}>
      <path
        fill="currentColor"
        d="M19.14 12.94a7.48 7.48 0 0 0 .05-.94 7.48 7.48 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.63l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.28 7.28 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.57.23-1.11.54-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.85a.5.5 0 0 0 .12.63l2.03 1.58a7.48 7.48 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.63l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.4 1.05.72 1.62.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.57-.23 1.11-.54 1.62-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.63l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
      />
    </svg>
  );
}

export function SquareIconButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    size?: number;
    icon: React.ReactNode;
    tone?: "dark" | "light";
  }
) {
  const { size = 32, icon, tone = "dark", style, ...rest } = props;
  return (
    <SquareButton
      style={{
        ...style,
      }}
      {...rest}
      size={size}
      variant="icon"
      tone={tone}
    >
      {icon}
    </SquareButton>
  );
}
