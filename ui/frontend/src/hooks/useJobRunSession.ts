"use client";

import { useCallback, useMemo, useState, type RefObject } from "react";
import type { SharedLogStreamHandle } from "../components/SharedLogStream";
import { appendNormalizedErrorToLog } from "../lib/jobLogError";
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
  open: boolean;
  title: string;
  running: boolean;
  /** Shown next to the spinner while ``running`` (e.g. upload phase or latest log line). */
  runningStatus: string;
  sessionOutcome: JobRunSessionOutcome;
  onRequestClose: () => void;
};

export function useJobRunSession(logRef?: RefObject<SharedLogStreamHandle | null>) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [title, setTitle] = useState("Working…");
  const [runningStatus, setRunningStatus] = useState("Running…");
  const [sessionOutcome, setSessionOutcome] = useState<JobRunSessionOutcome>(null);

  const beginSession = useCallback(
    ({
      title: nextTitle,
      clearLog = false,
      runningStatus: nextStatus,
    }: BeginSessionOpts) => {
      if (clearLog) logRef?.current?.clear();
      setTitle(nextTitle);
      setRunningStatus(nextStatus ?? "Running…");
      setSessionOutcome(null);
      setOpen(true);
      setRunning(true);
      setDone(false);
    },
    [logRef]
  );

  const endSession = useCallback(() => {
    setRunning(false);
    setDone(true);
    setSessionOutcome("success");
  }, []);

  const pushLog = useCallback(
    (line: string) => {
      logRef?.current?.pushLine(line);
    },
    [logRef]
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
      appendNormalizedErrorToLog(logRef, err, userMessage);
      setOpen(true);
      setSessionOutcome("error");
      setRunning(false);
      setDone(true);
    },
    [logRef]
  );

  const requestClose = useCallback(() => {
    if (!done) return;
    setOpen(false);
    setSessionOutcome(null);
  }, [done]);

  /**
   * Hard reset of all session state, regardless of ``done``. Call this when the
   * owning modal unmounts/closes so a stale "finished" job modal does not
   * reappear the next time the modal is reopened (the hook instance persists).
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
