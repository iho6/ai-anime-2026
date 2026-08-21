"use client";

import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import type { SharedLogStreamHandle } from "../components/SharedLogStream";
import { useJobQueue } from "../components/JobQueueProvider";
import { normalizeAppError } from "../lib/api";
import { truncateJobModalStatusLine } from "../lib/jobModalStatus";

export type JobRunSessionOutcome = "success" | "error" | null;

export type BeginSessionOpts = {
  title: string;
  /** When true, clears the shared log before the session starts. Default false. */
  clearLog?: boolean;
  /** One-line status next to the spinner while ``running``; default ``"Running…"``. */
  runningStatus?: string;
};

export type JobRunModalSessionProps = {
  /** True while this hook has a queued or running job (no longer opens a blocking modal). */
  open: boolean;
  title: string;
  running: boolean;
  /** Shown next to the spinner while ``running`` (e.g. upload phase or latest log line). */
  runningStatus: string;
  sessionOutcome: JobRunSessionOutcome;
  onRequestClose: () => void;
};

export function useJobRunSession(logRef?: RefObject<SharedLogStreamHandle | null>) {
  const { enqueueAndWait, appendLog, clearJobLog, complete } = useJobQueue();
  const activeJobIdRef = useRef<string | null>(null);

  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [title, setTitle] = useState("Working…");
  const [runningStatus, setRunningStatus] = useState("Running…");
  const [sessionOutcome, setSessionOutcome] = useState<JobRunSessionOutcome>(null);

  const beginSession = useCallback(
    async ({
      title: nextTitle,
      clearLog = false,
      runningStatus: nextStatus,
    }: BeginSessionOpts) => {
      setTitle(nextTitle);
      setRunningStatus(nextStatus ?? "Running…");
      setSessionOutcome(null);
      setOpen(true);
      setRunning(false);
      setDone(false);
      if (clearLog) logRef?.current?.clear();

      const { jobId } = await enqueueAndWait(nextTitle);
      activeJobIdRef.current = jobId;
      if (clearLog) clearJobLog(jobId);
      setRunning(true);
      setDone(false);
    },
    [clearJobLog, enqueueAndWait, logRef]
  );

  const endSession = useCallback(() => {
    const id = activeJobIdRef.current;
    if (id) {
      complete(id, "success");
      activeJobIdRef.current = null;
    }
    setRunning(false);
    setDone(true);
    setSessionOutcome("success");
    setOpen(false);
  }, [complete]);

  const pushLog = useCallback(
    (line: string) => {
      const id = activeJobIdRef.current;
      if (id) appendLog(id, line);
      logRef?.current?.pushLine(line);
    },
    [appendLog, logRef]
  );

  const onJobLogLine = useCallback(
    (line: string) => {
      pushLog(line);
      const status = truncateJobModalStatusLine(line);
      if (status) setRunningStatus(status);
    },
    [pushLog]
  );

  const failSession = useCallback(
    (err: unknown, userMessage: string) => {
      const norm = normalizeAppError(err, userMessage, "Error");
      const messageLines = norm.message
        .split(/\r?\n/)
        .map((s) => s.trimEnd())
        .filter((s) => s.length > 0);
      if (messageLines.length === 0) {
        pushLog(`[ERROR] ${userMessage}`);
      } else {
        pushLog(`[ERROR] ${messageLines[0]}`);
        for (let i = 1; i < messageLines.length; i++) {
          pushLog(messageLines[i]!);
        }
      }
      if (norm.details) {
        for (const segment of norm.details.split(/\r?\n/)) {
          const t = segment.trimEnd();
          if (t) pushLog(t);
        }
      }

      const id = activeJobIdRef.current;
      if (id) {
        complete(id, "error", userMessage);
        activeJobIdRef.current = null;
      }
      setSessionOutcome("error");
      setRunning(false);
      setDone(true);
      setOpen(false);
    },
    [complete, pushLog]
  );

  const requestClose = useCallback(() => {
    if (!done) return;
    setOpen(false);
    setSessionOutcome(null);
  }, [done]);

  /**
   * Hard reset of all session state, regardless of ``done``. Call this when the
   * owning modal unmounts/closes so a stale session does not linger.
   * Does not cancel an in-flight queue job (out of scope).
   */
  const resetSession = useCallback(() => {
    setOpen(false);
    setRunning(false);
    setDone(false);
    setSessionOutcome(null);
  }, []);

  const modalProps: JobRunModalSessionProps = useMemo(
    () => ({
      open,
      title,
      running,
      runningStatus,
      sessionOutcome,
      onRequestClose: requestClose,
    }),
    [open, title, running, runningStatus, sessionOutcome, requestClose]
  );

  return {
    open,
    running,
    done,
    title,
    setTitle,
    runningStatus,
    setRunningStatus,
    sessionOutcome,
    beginSession,
    endSession,
    pushLog,
    onJobLogLine,
    failSession,
    requestClose,
    resetSession,
    modalProps,
  };
}
