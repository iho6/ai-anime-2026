"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiHubCloseupWizardClose,
  apiHubCloseupWizardGenerateCurrent,
  apiHubCloseupWizardGoLast,
  apiHubCloseupWizardGoNext,
  apiHubCloseupWizardRegenerateCurrent,
  apiHubCloseupWizardSaveAll,
  apiHubCloseupWizardStart,
  assetUrlFromRelPath,
  CloseupWizardStep,
} from "../lib/api";
import { ZoomableImage } from "./ZoomableImage";

type Props = {
  open: boolean;
  charKey: string;
  title?: string;
  onClose: () => void | Promise<void>;
  onDone?: () => void | Promise<void>;
};

type StepKey = "front" | "left" | "right" | "back";

const STEP_LABEL: Record<StepKey, string> = {
  front: "Front Angle",
  left: "Left Angle",
  right: "Right Angle",
  back: "Back Angle",
};

export function BaseCloseupWizardModal(props: Props) {
  const { open, charKey, title = "Closeup Wizard", onClose, onDone } = props;
  const [sessionId, setSessionId] = useState("");
  const [steps, setSteps] = useState<CloseupWizardStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [candidateRelPath, setCandidateRelPath] = useState("");
  const [previewRelPath, setPreviewRelPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [bust, setBust] = useState(0);
  const [previewLoadFinished, setPreviewLoadFinished] = useState(false);
  /** Full `previewUrl` string that last completed `<img>` onLoad (cache-bust included). */
  const [lastLoadedPreviewUrl, setLastLoadedPreviewUrl] = useState("");

  const logLine = useCallback((line: string) => {
    setLogs((prev) => [...prev, line]);
  }, []);

  const pushErrorLine = useCallback((message: string) => {
    const msg = (message || "").trim();
    if (!msg) return;
    setErr(msg);
    setLogs((prev) => [...prev, `[ERROR] ${msg}`]);
  }, []);

  const applyState = useCallback(
    (r: any) => {
      if (typeof r.currentStepIndex === "number") setStepIndex(r.currentStepIndex);
      else if (typeof r.stepIndex === "number") setStepIndex(r.stepIndex);
      if (Array.isArray(r.steps)) setSteps(r.steps as CloseupWizardStep[]);
      if (r.saved && typeof r.saved === "object") setSaved(r.saved as Record<string, string>);
      if (r.failed && typeof r.failed === "object") setFailed(r.failed as Record<string, string>);
      if ("candidateRelPath" in r) {
        const c = r.candidateRelPath;
        setCandidateRelPath(typeof c === "string" ? c : "");
      }
      if (typeof r.compositePreviewRelPath === "string") {
        setPreviewRelPath(r.compositePreviewRelPath);
      }
      if (typeof r.error === "string" && r.error) pushErrorLine(r.error);
      setBust((x) => x + 1);
    },
    [pushErrorLine]
  );

  useEffect(() => {
    if (!open || !charKey) return;
    let cancelled = false;
    setBusy(true);
    setErr("");
    setLogs([]);
    setSaved({});
    setFailed({});
    setCandidateRelPath("");
    setPreviewRelPath("");
    setSteps([]);
    setStepIndex(0);
    setSessionId("");
    setPreviewLoadFinished(false);
    setLastLoadedPreviewUrl("");
    (async () => {
      try {
        const started = await apiHubCloseupWizardStart(charKey, logLine);
        if (cancelled) return;
        if (started.sessionId) setSessionId(started.sessionId);
        applyState(started);
        const generated = await apiHubCloseupWizardGenerateCurrent(
          charKey,
          String(started.sessionId || ""),
          logLine
        );
        if (cancelled) return;
        applyState(generated);
      } catch (e) {
        if (!cancelled) {
          pushErrorLine(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          setBusy(false);
          setPreviewLoadFinished(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, charKey, logLine, applyState, pushErrorLine]);

  async function closeWizard() {
    if (busy) return;
    try {
      if (sessionId) await apiHubCloseupWizardClose(charKey, sessionId);
    } catch {
      // ignore
    }
    await Promise.resolve(onClose());
  }

  async function closeWizardSessionOnly() {
    if (!sessionId) return;
    try {
      await apiHubCloseupWizardClose(charKey, sessionId);
    } catch {
      // ignore
    }
  }

  async function withBusy(fn: () => Promise<void>) {
    if (!sessionId || busy) return;
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      pushErrorLine(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const currentStepKey = (steps[stepIndex]?.stepKey || "front") as StepKey;
  const currentLabel = STEP_LABEL[currentStepKey] || "Angle";
  const isLast = stepIndex >= 3;
  const canLast = stepIndex > 0;
  const canNext = stepIndex < 3;
  const previewUrl = previewRelPath ? `${assetUrlFromRelPath(previewRelPath)}?v=${bust}` : "";
  const allSaved = (["front", "left", "right", "back"] as StepKey[]).every((k) => Boolean(saved[k]));

  const previewImageReady = Boolean(previewUrl && lastLoadedPreviewUrl === previewUrl);

  const closeupStatusDetail = useMemo(() => {
    if (busy) {
      return `Working: generating ${currentLabel} (multi-angle service), then composing the quadrant preview. This may take a while — see the log on the right for progress.`;
    }
    if (failed[currentStepKey]) {
      return `${currentLabel}: generation failed for this angle. Check the log or use Regenerate.`;
    }
    if (err) {
      return `${currentLabel}: ${err}`;
    }
    if (!previewRelPath) {
      if (previewLoadFinished) {
        return `${currentLabel}: no composite preview yet. Try Regenerate if this persists.`;
      }
      return `${currentLabel}: waiting for the first composite preview…`;
    }
    if (!previewImageReady) {
      return `${currentLabel}: preview file received — loading image in the browser…`;
    }
    if (candidateRelPath) {
      return `${currentLabel}: preview is on screen and the candidate image is ready — review it, then save or regenerate.`;
    }
    return `${currentLabel}: composite preview is on screen.`;
  }, [
    busy,
    candidateRelPath,
    currentLabel,
    currentStepKey,
    err,
    failed,
    previewImageReady,
    previewLoadFinished,
    previewRelPath,
  ]);

  const statusText = useMemo(() => {
    const ordered: StepKey[] = ["front", "left", "right", "back"];
    return ordered
      .map((k, idx) => {
        const st = saved[k]
          ? "Saved"
          : failed[k]
            ? "Failed"
            : idx === stepIndex
              ? "Current"
              : "Pending";
        return `${STEP_LABEL[k]}: ${st}`;
      })
      .join("  |  ");
  }, [saved, failed, stepIndex]);

  const disabledBtnStyle: React.CSSProperties = busy
    ? {
        opacity: 0.45,
        cursor: "not-allowed",
        filter: "grayscale(1)",
        pointerEvents: "none",
      }
    : {};

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10100,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={() => {
        if (busy) return;
        void closeWizard();
      }}
    >
      <div
        style={{
          width: "min(1200px, 96vw)",
          height: "min(90vh, 920px)",
          background: "#111",
          color: "#eee",
          border: "1px solid rgba(255,255,255,0.2)",
          display: "grid",
          gridTemplateRows: "auto 1fr auto auto",
          gap: 10,
          padding: 12,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16 }}>{title}</div>
          <button
            className="ui-btn-black"
            onClick={() => void closeWizard()}
            disabled={busy}
            style={disabledBtnStyle}
          >
            Close
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 12, minHeight: 0 }}>
          <div
            style={{
              border: "1px solid rgba(255,255,255,0.2)",
              overflow: "hidden",
              minHeight: 0,
              display: "flex",
            }}
          >
            {previewUrl ? (
              <ZoomableImage
                src={previewUrl}
                fitMaxWidth="100%"
                fitMaxHeight="70vh"
                onImageLoad={() => setLastLoadedPreviewUrl(previewUrl)}
              />
            ) : busy ? (
              <div style={{ padding: 20, opacity: 0.8 }}>Generating preview...</div>
            ) : err || (previewLoadFinished && !previewRelPath) ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 24,
                  textAlign: "center",
                  gap: 12,
                  background: "#1a1a1a",
                  color: "#ddd",
                }}
              >
                <div style={{ fontSize: 15, fontWeight: 600, color: "#e99" }}>
                  Generation failed
                </div>
                <div style={{ fontSize: 13, opacity: 0.9, maxWidth: 440, whiteSpace: "pre-wrap" }}>
                  {err ||
                    "No composite preview was returned. See the log on the right or try Regenerate."}
                </div>
                <div style={{ fontSize: 12, opacity: 0.65 }}>
                  Fix the issue if you can, then use Regenerate.
                </div>
              </div>
            ) : (
              <div style={{ padding: 20, opacity: 0.8 }}>Generating preview...</div>
            )}
          </div>
          <div
            style={{
              border: "1px solid rgba(255,255,255,0.2)",
              padding: 8,
              overflow: "auto",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              background: "rgba(0,0,0,0.2)",
            }}
          >
            {logs.length ? logs.join("\n") : "Waiting for logs..."}
          </div>
        </div>

        <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.45 }}>{closeupStatusDetail}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.9 }}>{statusText}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="ui-btn-black"
              disabled={busy || !canLast}
              style={disabledBtnStyle}
              onClick={() =>
                withBusy(async () => {
                  const r = await apiHubCloseupWizardGoLast(charKey, sessionId);
                  applyState(r);
                })
              }
            >
              Last Angle
            </button>
            <button
              className="ui-btn-black"
              disabled={busy || !canNext}
              style={disabledBtnStyle}
              onClick={() =>
                withBusy(async () => {
                  const r = await apiHubCloseupWizardGoNext(charKey, sessionId);
                  applyState(r);
                  const nextStep = (r.stepKey || "front") as StepKey;
                  const nextSaved = (r.saved && typeof r.saved === "object" ? r.saved : saved) as Record<string, string>;
                  const nextFailed = (r.failed && typeof r.failed === "object" ? r.failed : failed) as Record<string, string>;
                  const hasAttempt = Boolean(nextSaved[nextStep]) || Boolean(nextFailed[nextStep]);
                  if (!hasAttempt) {
                    const nextLabel = STEP_LABEL[nextStep] ?? "next angle";
                    logLine(`Generating ${nextLabel}...`);
                    const generated = await apiHubCloseupWizardGenerateCurrent(
                      charKey,
                      sessionId,
                      logLine
                    );
                    applyState(generated);
                  }
                })
              }
            >
              Next Angle
            </button>
            <button
              className="ui-btn-black"
              disabled={busy}
              style={disabledBtnStyle}
              onClick={() =>
                withBusy(async () => {
                  const r = await apiHubCloseupWizardRegenerateCurrent(
                    charKey,
                    sessionId,
                    logLine
                  );
                  applyState(r);
                })
              }
            >
              Regenerate
            </button>
            {isLast ? (
              <button
                className="ui-btn-black"
                disabled={busy || !allSaved}
                style={disabledBtnStyle}
                onClick={() =>
                  withBusy(async () => {
                    logLine("Finalizing all angles...");
                    await apiHubCloseupWizardSaveAll(charKey, sessionId);
                    await closeWizardSessionOnly();
                    if (onDone) await Promise.resolve(onDone());
                  })
                }
              >
                Save All Angles
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

