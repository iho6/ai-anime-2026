"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { HfTokenSettingsButton } from "../../components/HfTokenSettingsButton";
import { JobLogButton } from "../../components/JobLogButton";

export default function HomePage() {
  const router = useRouter();
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", gap: 4, alignItems: "center", paddingLeft: 20, marginBottom: 10 }}>
        <HfTokenSettingsButton />
        <JobLogButton />
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", gap: 12 }}>
          <button
            style={{
              width: 140,
              height: 140,
              borderRadius: 0,
              border: "1px solid rgba(0,0,0,0.5)",
              background: "transparent",
              color: "inherit",
              fontWeight: 400,
              cursor: "pointer",
              textAlign: "center",
            }}
            onClick={() => router.push("/location_hub")}
          >
            Create Location
          </button>
          <button
            style={{
              width: 140,
              height: 140,
              borderRadius: 0,
              border: "1px solid rgba(0,0,0,0.5)",
              background: "transparent",
              color: "inherit",
              fontWeight: 400,
              cursor: "pointer",
              textAlign: "center",
            }}
            onClick={() => router.push("/hub")}
          >
            Create Character
          </button>
          <button
            style={{
              width: 140,
              height: 140,
              borderRadius: 0,
              border: "1px solid rgba(0,0,0,0.5)",
              background: "transparent",
              color: "inherit",
              fontWeight: 400,
              cursor: "pointer",
              textAlign: "center",
            }}
            onClick={() => router.push("/timeline_hub")}
          >
            Create Video Timeline
          </button>
        </div>
      </div>
    </div>
  );
}

