"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AppErrorModal, AppErrorPayload } from "./AppErrorModal";
import { CloseIcon, SquareIconButton } from "./IconPrimitives";
import { normalizeAppError } from "../lib/api";

type ShowErrorInput = Partial<AppErrorPayload> & {
  message: string;
  error?: unknown;
};

type ErrorContextValue = {
  showError: (input: ShowErrorInput) => void;
  clearError: () => void;
  askText: (input: {
    title: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<string | null>;
  confirmAction: (input: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
};

const ErrorContext = createContext<ErrorContextValue | null>(null);

type PromptState = {
  title: string;
  message: string;
  value: string;
  placeholder: string;
  confirmText: string;
  cancelText: string;
  resolve: (value: string | null) => void;
} | null;

type ConfirmState = {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  resolve: (ok: boolean) => void;
} | null;

export function ErrorProvider(props: { children: React.ReactNode }) {
  const [error, setError] = useState<AppErrorPayload | null>(null);
  const [promptState, setPromptState] = useState<PromptState>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const showError = useCallback((input: ShowErrorInput) => {
    const norm = input.error
      ? normalizeAppError(input.error, input.message, input.title ?? "Error")
      : null;
    setError({
      title: input.title ?? norm?.title ?? "Error",
      message: norm?.message ?? input.message,
      details: input.details ?? norm?.details,
    });
  }, []);

  const askText = useCallback<ErrorContextValue["askText"]>((input) => {
    return new Promise<string | null>((resolve) => {
      setPromptState({
        title: input.title,
        message: input.message,
        value: input.defaultValue ?? "",
        placeholder: input.placeholder ?? "",
        confirmText: input.confirmText ?? "OK",
        cancelText: input.cancelText ?? "Cancel",
        resolve,
      });
    });
  }, []);

  const confirmAction = useCallback<ErrorContextValue["confirmAction"]>((input) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({
        title: input.title,
        message: input.message,
        confirmText: input.confirmText ?? "Confirm",
        cancelText: input.cancelText ?? "Cancel",
        resolve,
      });
    });
  }, []);

  const closePrompt = useCallback(() => {
    setPromptState((prev) => {
      if (prev) prev.resolve(null);
      return null;
    });
  }, []);

  const submitPrompt = useCallback(() => {
    setPromptState((prev) => {
      if (prev) prev.resolve(prev.value);
      return null;
    });
  }, []);

  const closeConfirm = useCallback(() => {
    setConfirmState((prev) => {
      if (prev) prev.resolve(false);
      return null;
    });
  }, []);

  const submitConfirm = useCallback(() => {
    setConfirmState((prev) => {
      if (prev) prev.resolve(true);
      return null;
    });
  }, []);

  useEffect(() => {
    let lastSig = "";
    let lastAt = 0;
    const dedupeMs = 1500;

    function allow(sig: string): boolean {
      const now = Date.now();
      if (sig === lastSig && now - lastAt < dedupeMs) return false;
      lastSig = sig;
      lastAt = now;
      return true;
    }

    function onErr(ev: ErrorEvent) {
      const msg = ev.message || "Unhandled runtime error";
      const details = ev.error ? normalizeAppError(ev.error, msg, "Runtime Error").details : undefined;
      const sig = `err:${msg}:${details ?? ""}`;
      if (!allow(sig)) return;
      showError({ title: "Runtime Error", message: msg, details });
    }

    function onRej(ev: PromiseRejectionEvent) {
      const details = normalizeAppError(
        ev.reason,
        "An async operation failed.",
        "Unhandled Promise Rejection"
      ).details;
      const sig = `rej:${details}`;
      if (!allow(sig)) return;
      showError({
        title: "Unhandled Promise Rejection",
        message: "An async operation failed.",
        details,
      });
    }

    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, [showError]);

  const value = useMemo<ErrorContextValue>(
    () => ({ showError, clearError, askText, confirmAction }),
    [showError, clearError, askText, confirmAction]
  );

  return (
    <ErrorContext.Provider value={value}>
      {props.children}
      <AppErrorModal error={error} onClose={clearError} />
      {promptState ? (
        <div className="app-error-modal-backdrop" onMouseDown={closePrompt}>
          <div className="app-error-modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontWeight: 400 }}>{promptState.title}</div>
              <SquareIconButton
                aria-label="Close input dialog"
                title="Close"
                icon={<CloseIcon />}
                tone="light"
                onClick={closePrompt}
                style={{
                  color: "#eee",
                  borderColor: "rgba(238,238,238,0.9)",
                  background: "rgba(238,238,238,0.15)",
                }}
              />
            </div>
            <div style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{promptState.message}</div>
            <input
              type="text"
              autoFocus
              value={promptState.value}
              placeholder={promptState.placeholder}
              onChange={(e) =>
                setPromptState((prev) => (prev ? { ...prev, value: e.target.value } : prev))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitPrompt();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  closePrompt();
                }
              }}
              style={{
                width: "100%",
                border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: 0,
                background: "transparent",
                color: "inherit",
                padding: "10px 12px",
                marginTop: 10,
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button type="button" onClick={closePrompt} className="ui-btn-black">
                {promptState.cancelText}
              </button>
              <button type="button" onClick={submitPrompt} className="ui-btn-black">
                {promptState.confirmText}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmState ? (
        <div className="app-error-modal-backdrop" onMouseDown={closeConfirm}>
          <div className="app-error-modal-card" onMouseDown={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ fontWeight: 400 }}>{confirmState.title}</div>
              <SquareIconButton
                aria-label="Close confirm dialog"
                title="Close"
                icon={<CloseIcon />}
                tone="light"
                onClick={closeConfirm}
                style={{
                  color: "#eee",
                  borderColor: "rgba(238,238,238,0.9)",
                  background: "rgba(238,238,238,0.15)",
                }}
              />
            </div>
            <div style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{confirmState.message}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button type="button" onClick={closeConfirm} className="ui-btn-black">
                {confirmState.cancelText}
              </button>
              <button type="button" onClick={submitConfirm} className="ui-btn-black">
                {confirmState.confirmText}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ErrorContext.Provider>
  );
}

export function useAppError() {
  const ctx = useContext(ErrorContext);
  if (!ctx) {
    throw new Error("useAppError must be used within ErrorProvider");
  }
  return ctx;
}

