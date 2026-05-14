"use client";

import React, { useState } from "react";
import { apiSettingsGetHfToken, apiSettingsUpdateHfToken } from "../lib/api";
import { CloseIcon, GearIcon, SquareIconButton } from "./IconPrimitives";
import { useAppError } from "./ErrorProvider";

export function HfTokenSettingsButton() {
  const { showError } = useAppError();
  const [open, setOpen] = useState(false);
  const [hfToken, setHfToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function onOpen() {
    setOpen(true);
    try {
      const t = await apiSettingsGetHfToken();
      setHfToken(t);
    } catch (e) {
      showError({ message: "Failed to load HuggingFace token.", error: e });
    }
  }

  async function onUpdate() {
    const t = hfToken.trim();
    if (!t) {
      showError({ message: "Please enter hf_token." });
      return;
    }
    setBusy(true);
    try {
      await apiSettingsUpdateHfToken(t);
      showError({ title: "Settings", message: "HuggingFace token updated." });
      setOpen(false);
    } catch (e) {
      showError({ message: "Failed to update HuggingFace token.", error: e });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SquareIconButton
        onClick={() => void onOpen()}
        aria-label="Settings"
        title="Settings"
        icon={<GearIcon />}
      />
      {open ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 10020,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onMouseDown={() => setOpen(false)}
        >
          <div
            style={{
              width: 520,
              maxWidth: "100%",
              background: "#0b0b0b",
              color: "#eee",
              border: "1px solid rgba(255,255,255,0.25)",
              borderRadius: 0,
              padding: 14,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>Settings</div>
              <SquareIconButton
                aria-label="Close settings"
                title="Close"
                icon={<CloseIcon />}
                tone="light"
                onClick={() => setOpen(false)}
                style={{ color: "#eee", borderColor: "rgba(238,238,238,0.9)", background: "rgba(238,238,238,0.15)" }}
              />
            </div>
            <input
              type="text"
              value={hfToken}
              onChange={(e) => setHfToken(e.target.value)}
              placeholder="Enter hf_token from huggingFace"
              style={{
                width: "100%",
                border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: 0,
                background: "transparent",
                color: "inherit",
                padding: "10px 12px",
                marginBottom: 10,
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => void onUpdate()}
              className="ui-btn-black"
              style={{ cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.7 : 1 }}
            >
              Update huggingFace Token
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

