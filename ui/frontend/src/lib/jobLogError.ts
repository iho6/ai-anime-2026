import type { RefObject } from "react";
import type { SharedLogStreamHandle } from "../components/SharedLogStream";
import { normalizeAppError } from "./api";

/** Push normalized error (same shape as AppErrorModal) into the job log, one line per segment so newlines are preserved. */
export function appendNormalizedErrorToLog(
  logRef: RefObject<SharedLogStreamHandle | null> | undefined,
  err: unknown,
  fallbackMessage: string,
  fallbackTitle = "Error"
): ReturnType<typeof normalizeAppError> {
  const norm = normalizeAppError(err, fallbackMessage, fallbackTitle);
  const messageLines = norm.message
    .split(/\r?\n/)
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0);
  if (messageLines.length === 0) {
    logRef?.current?.pushLine(`[ERROR] ${fallbackMessage}`);
  } else {
    logRef?.current?.pushLine(`[ERROR] ${messageLines[0]}`);
    for (let i = 1; i < messageLines.length; i++) {
      logRef?.current?.pushLine(messageLines[i]!);
    }
  }
  if (norm.details) {
    for (const segment of norm.details.split(/\r?\n/)) {
      const t = segment.trimEnd();
      if (t) logRef?.current?.pushLine(t);
    }
  }
  return norm;
}

/** WS `done.error` string only — still run through normalizer for consistent block. */
export function appendWsDoneErrorToLog(
  logRef: RefObject<SharedLogStreamHandle | null> | undefined,
  doneError: string | undefined,
  headline: string
): ReturnType<typeof normalizeAppError> {
  const err = doneError ? new Error(doneError) : new Error(headline);
  return appendNormalizedErrorToLog(logRef, err, headline);
}
