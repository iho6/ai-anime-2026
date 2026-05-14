"use client";

import React, { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { API_BASE_URL, wsUrlForPath } from "../lib/api";
import {
  SharedLogStream,
  SharedLogStreamHandle,
} from "../components/SharedLogStream";

export default function StartupInstallPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [githubPat, setGithubPat] = useState("");
  const [running, setRunning] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [formFading, setFormFading] = useState(false);
  const [startupAttempted, setStartupAttempted] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [logHasContent, setLogHasContent] = useState(false);
  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const startTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  // WebSocket callbacks can observe stale React state; keep refs for close/error logic.
  const sawLogRef = useRef(false);
  const sawDoneOrErrorRef = useRef(false);
  const errorTextRef = useRef("");

  function setNotRunning() {
    setRunning(false);
    setFormFading(false);
  }

  async function runStartup(t: string) {
    setRunning(true);
    setExiting(false);
    setErrorText("");
    setLogHasContent(false);
    logRef.current?.clear();
    sawLogRef.current = false;
    sawDoneOrErrorRef.current = false;
    errorTextRef.current = "";

    // Preflight: verify the API is reachable through the Next.js proxy.
    const healthUrl = `${API_BASE_URL}/health`;
    try {
      const r = await fetch(healthUrl, { method: "GET" });
      if (!r.ok) {
        setNotRunning();
        setErrorText(
          `API health check failed: GET ${healthUrl} -> ${r.status} ${r.statusText}`
        );
        return;
      }
    } catch (e) {
      setNotRunning();
      const msg = e instanceof Error ? e.message : String(e);
      setErrorText(
        `Cannot reach API at ${healthUrl}. The FastAPI backend may not be running on the server.\n` +
          `Health check error: ${msg}`
      );
      return;
    }

    const wsUrl = wsUrlForPath("/startup/ws");
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "start", hf_token: t, github_pat: githubPat }));
    };

    ws.onmessage = (ev) => {
      let msg: any = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg) return;

      if (msg.type === "log") {
        sawLogRef.current = true;
        setLogHasContent(true);
        logRef.current?.pushLine(String(msg.line ?? ""));
      } else if (msg.type === "done") {
        sawDoneOrErrorRef.current = true;
        setNotRunning();
        if (msg.ok) {
          const FADE_MS = 600;
          setExiting(true);
          if (exitTimerRef.current) window.clearTimeout(exitTimerRef.current);
          exitTimerRef.current = window.setTimeout(() => {
            router.push("/home");
          }, FADE_MS);
        } else if (msg.error) {
          const et = String(msg.error);
          errorTextRef.current = et;
          setErrorText(et);
        }
        ws.close();
      } else if (msg.type === "error") {
        sawDoneOrErrorRef.current = true;
        setNotRunning();
        const et = String(
          msg.error || "Setup failed (server sent error without message)."
        );
        errorTextRef.current = et;
        setErrorText(et);
        ws.close();
      }
    };

    ws.onclose = (ev) => {
      // If the socket closes before we ever got any logs, make it actionable.
      // Use refs to avoid stale state in this callback.
      if (!sawLogRef.current && !sawDoneOrErrorRef.current && !errorTextRef.current) {
        setNotRunning();
        const et =
          `WebSocket closed before startup logs were received.\n` +
            `URL: ${wsUrl}\n` +
            `code=${ev.code} clean=${ev.wasClean} reason=${ev.reason || "(no reason)"}`
        ;
        errorTextRef.current = et;
        setErrorText(et);
      }
    };

    ws.onerror = () => {
      setNotRunning();
      const et =
        `WebSocket connection failed.\n` +
          `URL: ${wsUrl}\n` +
          `The FastAPI backend may not be running or the Next.js proxy cannot reach it.`
      ;
      errorTextRef.current = et;
      setErrorText(et);
    };
  }

  async function onStart() {
    const t = (token || "").trim();
    if (!t) {
      setErrorText(
        "please enter hf token for downloading model from huggingFace"
      );
      return;
    }
    const ghPat = (githubPat || "").trim();
    if (!ghPat) {
      setErrorText(
        "Please enter GitHub Personal Access Token (PAT) for downloading Git LFS assets."
      );
      return;
    }

    if (t === "skip") {
      router.push("/home");
      return;
    }

    if (!t.startsWith("hf_")) {
      setErrorText("Invalid token format. HuggingFace tokens should start with hf_.");
      return;
    }

    setErrorText("");
    setLogHasContent(false);
    logRef.current?.clear();
    setStartupAttempted(true);
    setFormFading(true);
    if (startTimerRef.current) {
      window.clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }
    startTimerRef.current = window.setTimeout(() => {
      runStartup(t);
    }, 260);
  }

  async function onCopyError() {
    if (!errorText) return;
    try {
      await navigator.clipboard.writeText(errorText);
    } catch {
      // ignore clipboard failures
    }
  }

  React.useEffect(() => {
    return () => {
      if (startTimerRef.current) {
        window.clearTimeout(startTimerRef.current);
        startTimerRef.current = null;
      }
      if (exitTimerRef.current) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, []);

  const showFormBlock = !startupAttempted || formFading;
  const formOpacity = showFormBlock ? (formFading ? 0 : 1) : 0;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f2f2f2",
        color: "#111",
        padding: 20,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        alignItems: "center",
        justifyContent: showFormBlock ? "center" : "flex-start",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 680,
          display: showFormBlock || formFading ? "flex" : "none",
          flexDirection: "column",
          gap: 8,
          opacity: formOpacity,
          transition: "opacity 260ms ease",
          pointerEvents: showFormBlock ? "auto" : "none",
        }}
      >
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void onStart();
          }}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            width: "100%",
          }}
        >
          <input
            id="startup-hf-token"
            name="startup_hf_token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={running || formFading}
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            data-1p-ignore="true"
            data-lpignore="true"
            placeholder="Enter hf_token from huggingFace"
            style={{
              width: "100%",
              padding: "10px 12px",
              border: "1px solid rgba(0,0,0,0.5)",
              background: "transparent",
              color: "inherit",
            }}
          />

          <input
            id="startup-github-pat"
            name="startup_github_pat"
            value={githubPat}
            onChange={(e) => setGithubPat(e.target.value)}
            disabled={running || formFading}
            autoComplete="new-password"
            spellCheck={false}
            autoCorrect="off"
            data-1p-ignore="true"
            data-lpignore="true"
            placeholder="Enter GitHub Personal Access Token (PAT)"
            style={{
              width: "100%",
              padding: "10px 12px",
              border: "1px solid rgba(0,0,0,0.5)",
              background: "transparent",
              color: "inherit",
            }}
          />

          <button
            type="submit"
            disabled={running || formFading}
            style={{
              borderRadius: 0,
              border: "1px solid rgba(0,0,0,0.5)",
              background: "transparent",
              padding: "10px 12px",
              font: "inherit",
              boxSizing: "border-box",
              cursor: running || formFading ? "not-allowed" : "pointer",
              opacity: running || formFading ? 0.7 : 1,
              color: "inherit",
            }}
          >
            Install Dependencies and Launch AI Anime Tool
          </button>
        </form>

      </div>

      <div
        style={{
          width: 380,
          maxWidth: "100%",
          height: 250,
          position: "relative",
          display: running || exiting ? "block" : "none",
          opacity: exiting ? 0 : 1,
          transition: "opacity 600ms ease",
          pointerEvents: exiting ? "none" : "auto",
        }}
      >
        <style>{`
          @keyframes webuiCrossfadeReact { 
            0% { opacity: 0; }
            10% { opacity: 1; }
            40% { opacity: 1; }
            55% { opacity: 0; }
            100% { opacity: 0; }
          }
        `}</style>
        <img
          src="/logos/ai_anime_logo_en.svg"
          alt="Logo EN"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            opacity: 0,
            animation: "webuiCrossfadeReact 5s infinite",
          }}
        />
        <img
          src="/logos/ai_anime_logo_jp.svg"
          alt="Logo JP"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            opacity: 0,
            animation: "webuiCrossfadeReact 5s infinite",
            animationDelay: "2.5s",
          }}
        />
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: 1120,
          display: running || exiting || logHasContent || Boolean(errorText) ? "block" : "none",
          opacity: exiting ? 0 : 1,
          transition: "opacity 600ms ease",
          pointerEvents: exiting ? "none" : "auto",
        }}
      >
        {errorText ? (
          <div style={{ color: "#aa0000", fontSize: 14, marginBottom: 8 }}>
            {errorText}
          </div>
        ) : null}
        <SharedLogStream ref={logRef} rows={8} minHeight={150} />
        {errorText ? (
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                void onCopyError();
              }}
              style={{
                borderRadius: 0,
                border: "1px solid rgba(0,0,0,0.5)",
                background: "transparent",
                padding: "6px 12px",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              Copy Error
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
