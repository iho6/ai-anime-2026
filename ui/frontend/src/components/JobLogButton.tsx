"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon, LogIcon, SquareIconButton } from "./IconPrimitives";
import { JobQuadSpinner } from "./JobQuadSpinner";
import {
  useJobQueue,
  type JobQueueItem,
  type JobQueueStatus,
} from "./JobQueueProvider";

function statusLabel(status: JobQueueStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "error":
      return "Error";
  }
}

/** Neutral white/grey chip — no status colors. */
function statusChipStyle(status: JobQueueStatus): React.CSSProperties {
  const emphasis = status === "running" ? 0.95 : 0.55;
  return {
    flexShrink: 0,
    fontSize: 10,
    color: `rgba(238,238,238,${emphasis})`,
    border: `1px solid rgba(238,238,238,${emphasis})`,
    padding: "1px 6px",
    minWidth: 52,
    textAlign: "center",
  };
}

function JobDetailModal(props: {
  job: JobQueueItem;
  onClose: () => void;
}) {
  const { job, onClose } = props;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const text = job.logLines.join("\n");
  const running = job.status === "running";
  const queued = job.status === "queued";

  const statusLine = useMemo(() => {
    if (running) {
      const last = job.logLines[job.logLines.length - 1];
      return (last && last.trim()) || "Running…";
    }
    if (queued) return "Queued…";
    if (job.status === "error") return job.errorMessage || "Error.";
    if (job.status === "done") return "Done.";
    return "Finished.";
  }, [job.errorMessage, job.logLines, job.status, queued, running]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [text, job.status]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.65)",
        zIndex: 10040,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        data-native-clipboard-shortcuts
        style={{
          width: 760,
          maxWidth: "100%",
          maxHeight: "88vh",
          overflow: "auto",
          background: "#0b0b0b",
          color: "#eee",
          borderRadius: 0,
          padding: 14,
          border: "1px solid rgba(255,255,255,0.22)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontWeight: 400 }}>{job.title}</div>
          <SquareIconButton
            onClick={onClose}
            title="Close"
            aria-label="Close"
            icon={<CloseIcon />}
            tone="light"
            style={{
              color: "#eee",
              borderColor: "rgba(238,238,238,0.9)",
              background: "rgba(238,238,238,0.15)",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 10,
            marginBottom: 10,
          }}
        >
          <JobQuadSpinner running={running} />
          <div style={{ fontSize: 14, opacity: 0.95 }}>{statusLine}</div>
        </div>

        <textarea
          ref={taRef}
          value={
            text ||
            (queued ? "(waiting in queue…)" : running ? "(no log yet)" : "(no log)")
          }
          readOnly
          rows={12}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "transparent",
            color: "inherit",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 0,
            padding: 10,
            resize: "none",
            minHeight: 210,
            font: "inherit",
            fontSize: 13,
            lineHeight: 1.4,
          }}
        />
      </div>
    </div>
  );
}

function JobRow(props: {
  job: JobQueueItem;
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { job, onOpen, onDismiss } = props;
  const finished = job.status === "done" || job.status === "error";

  return (
    <button
      type="button"
      onClick={() => onOpen(job.id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "8px 10px",
        border: "none",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        textAlign: "left",
        font: "inherit",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.08)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={statusChipStyle(job.status)}>{statusLabel(job.status)}</span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={job.title}
      >
        {job.title}
      </span>
      {finished ? (
        <span
          role="button"
          title="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(job.id);
          }}
          style={{
            color: "#888",
            cursor: "pointer",
            padding: 2,
            lineHeight: 0,
            display: "inline-flex",
          }}
        >
          <CloseIcon size={12} />
        </span>
      ) : null}
    </button>
  );
}

export function JobLogButton() {
  const { jobs, hasActive, dismiss, clearFinished } = useJobQueue();
  const [open, setOpen] = useState(false);
  const [detailJobId, setDetailJobId] = useState<string | null>(null);
  const activeCount = jobs.filter(
    (j) => j.status === "queued" || j.status === "running"
  ).length;

  const detailJob = detailJobId
    ? jobs.find((j) => j.id === detailJobId) ?? null
    : null;

  return (
    <>
      <div style={{ position: "relative", display: "inline-flex" }}>
        <SquareIconButton
          onClick={() => setOpen(true)}
          aria-label="Log"
          title="Job log"
          icon={<LogIcon />}
        />
        {hasActive ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: -2,
              right: -2,
              minWidth: 14,
              height: 14,
              padding: "0 3px",
              borderRadius: 0,
              background: "rgba(238,238,238,0.85)",
              color: "#111",
              fontSize: 9,
              lineHeight: "14px",
              textAlign: "center",
              pointerEvents: "none",
            }}
          >
            {activeCount > 9 ? "9+" : activeCount}
          </span>
        ) : null}
      </div>

      {open ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            zIndex: 10020,
          }}
          onMouseDown={() => {
            if (!detailJobId) setOpen(false);
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 52,
              left: 20,
              width: 360,
              maxWidth: "min(360px, 90vw)",
              maxHeight: "min(70vh, 520px)",
              background: "#0b0b0b",
              border: "1px solid rgba(255,255,255,0.25)",
              color: "#eee",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "10px 12px",
                borderBottom: "1px solid rgba(255,255,255,0.12)",
                flexShrink: 0,
              }}
            >
              <span style={{ fontSize: 14 }}>Jobs</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  type="button"
                  className="ui-btn-black"
                  onClick={() => clearFinished()}
                  style={{ fontSize: 11, padding: "4px 8px" }}
                >
                  Clear finished
                </button>
                <SquareIconButton
                  size={28}
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  icon={<CloseIcon />}
                  tone="light"
                />
              </div>
            </div>
            <div style={{ overflow: "auto", flex: 1, minHeight: 120 }}>
              {jobs.length === 0 ? (
                <div style={{ padding: 16, fontSize: 13, color: "#777" }}>
                  No jobs yet.
                </div>
              ) : (
                jobs.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    onOpen={setDetailJobId}
                    onDismiss={dismiss}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      {detailJob ? (
        <JobDetailModal job={detailJob} onClose={() => setDetailJobId(null)} />
      ) : null}
    </>
  );
}
