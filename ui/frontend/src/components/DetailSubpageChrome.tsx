"use client";

import React from "react";
import { HomeIcon, SquareIconButton, TriangleIcon } from "./IconPrimitives";
import { HfTokenSettingsButton } from "./HfTokenSettingsButton";
import { JobLogButton } from "./JobLogButton";

/** Shared top bar: settings + log + home + back (back handler owned by the page). */
export function DetailSubpageChrome(props: {
  onHome: () => void;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ minHeight: "100vh", paddingBottom: 96 }}>
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
        <JobLogButton />
        <SquareIconButton
          onClick={props.onHome}
          aria-label="Home"
          icon={<HomeIcon />}
        />
        <SquareIconButton
          onClick={props.onBack}
          aria-label="Back"
          icon={<TriangleIcon direction="left" />}
        />
      </div>
      {props.children}
    </div>
  );
}
