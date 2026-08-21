"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { HomeIcon, SquareIconButton, TriangleIcon } from "../../components/IconPrimitives";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import { JobLogButton } from "../../components/JobLogButton";
import { NewLocationCreatePanel } from "../../components/create/NewLocationCreatePanel";

export default function NewLocationPage() {
  const router = useRouter();

  return (
    <div style={{ minHeight: "100vh" }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center", paddingLeft: 20, marginBottom: 10 }}>
        <HfTokenSettingsButton />
        <JobLogButton />
        <SquareIconButton
          onClick={() => router.push("/home")}
          aria-label="Home"
          icon={<HomeIcon />}
        />
        <SquareIconButton
          onClick={() => router.push("/location_hub")}
          aria-label="Back"
          icon={<TriangleIcon direction="left" />}
        />
      </div>

      <div style={{ paddingLeft: 20, paddingRight: 20, maxWidth: 980 }}>
        <NewLocationCreatePanel
          variant="page"
          cancelConfirmMessage="Clear all draft images in the workspace and return to the location hub?"
          onFinalized={() => router.push("/location_hub")}
          onCancelled={() => router.push("/location_hub")}
        />
      </div>
    </div>
  );
}
