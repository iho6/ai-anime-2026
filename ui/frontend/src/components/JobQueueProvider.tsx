"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

export type JobQueueStatus = "queued" | "running" | "done" | "error";

export type JobQueueItem = {
  id: string;
  title: string;
  status: JobQueueStatus;
  logLines: string[];
  createdAt: number;
  errorMessage?: string;
};

type EnqueueResult = {
  jobId: string;
};

type JobQueueContextValue = {
  jobs: JobQueueItem[];
  hasActive: boolean;
  enqueueAndWait: (title: string) => Promise<EnqueueResult>;
  appendLog: (jobId: string, line: string) => void;
  clearJobLog: (jobId: string) => void;
  complete: (jobId: string, outcome: "success" | "error", errorMessage?: string) => void;
  dismiss: (jobId: string) => void;
  clearFinished: () => void;
};

const JobQueueContext = createContext<JobQueueContextValue | null>(null);

const REPLACE_PREFIX = String.fromCharCode(127) + "LOG_R" + String.fromCharCode(127);

function applyLogLine(prev: string[], line: string): string[] {
  const raw = (line || "").replace(/\r?\n/g, "");
  if (!raw) return prev;
  if (raw.startsWith(REPLACE_PREFIX)) {
    const payload = raw.slice(REPLACE_PREFIX.length).trimEnd();
    if (prev.length === 0) return [payload];
    const next = prev.slice();
    next[next.length - 1] = payload;
    return next;
  }
  return [...prev, raw.trim()];
}

export function JobQueueProvider(props: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<JobQueueItem[]>([]);
  const jobsRef = useRef<JobQueueItem[]>([]);
  jobsRef.current = jobs;

  /** Resolvers waiting for their job to become the running head. */
  const waitersRef = useRef<Map<string, () => void>>(new Map());
  /** FIFO of job ids that have not yet completed. */
  const pendingIdsRef = useRef<string[]>([]);
  const runningIdRef = useRef<string | null>(null);
  const idSeqRef = useRef(0);

  const tryStartNext = useCallback(() => {
    if (runningIdRef.current) return;
    const nextId = pendingIdsRef.current[0];
    if (!nextId) return;
    runningIdRef.current = nextId;
    setJobs((prev) =>
      prev.map((j) => (j.id === nextId ? { ...j, status: "running" as const } : j))
    );
    const resolve = waitersRef.current.get(nextId);
    waitersRef.current.delete(nextId);
    resolve?.();
  }, []);

  const enqueueAndWait = useCallback(
    (title: string): Promise<EnqueueResult> => {
      idSeqRef.current += 1;
      const jobId = `job_${Date.now()}_${idSeqRef.current}`;
      const item: JobQueueItem = {
        id: jobId,
        title: title.trim() || "Working…",
        status: "queued",
        logLines: [],
        createdAt: Date.now(),
      };
      pendingIdsRef.current = [...pendingIdsRef.current, jobId];
      setJobs((prev) => [item, ...prev]);

      return new Promise<EnqueueResult>((resolve) => {
        waitersRef.current.set(jobId, () => resolve({ jobId }));
        tryStartNext();
      });
    },
    [tryStartNext]
  );

  const appendLog = useCallback((jobId: string, line: string) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId ? { ...j, logLines: applyLogLine(j.logLines, line) } : j
      )
    );
  }, []);

  const clearJobLog = useCallback((jobId: string) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, logLines: [] } : j))
    );
  }, []);

  const complete = useCallback(
    (jobId: string, outcome: "success" | "error", errorMessage?: string) => {
      pendingIdsRef.current = pendingIdsRef.current.filter((id) => id !== jobId);
      if (runningIdRef.current === jobId) {
        runningIdRef.current = null;
      }
      // If still waiting (cancelled before start), resolve waiter so callers don't hang.
      const waiter = waitersRef.current.get(jobId);
      if (waiter) {
        waitersRef.current.delete(jobId);
        waiter();
      }
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId
            ? {
                ...j,
                status: outcome === "success" ? ("done" as const) : ("error" as const),
                errorMessage: outcome === "error" ? errorMessage : undefined,
              }
            : j
        )
      );
      tryStartNext();
    },
    [tryStartNext]
  );

  const dismiss = useCallback((jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, []);

  const clearFinished = useCallback(() => {
    setJobs((prev) => prev.filter((j) => j.status === "queued" || j.status === "running"));
  }, []);

  const hasActive = useMemo(
    () => jobs.some((j) => j.status === "queued" || j.status === "running"),
    [jobs]
  );

  const value = useMemo<JobQueueContextValue>(
    () => ({
      jobs,
      hasActive,
      enqueueAndWait,
      appendLog,
      clearJobLog,
      complete,
      dismiss,
      clearFinished,
    }),
    [
      jobs,
      hasActive,
      enqueueAndWait,
      appendLog,
      clearJobLog,
      complete,
      dismiss,
      clearFinished,
    ]
  );

  return <JobQueueContext.Provider value={value}>{props.children}</JobQueueContext.Provider>;
}

export function useJobQueue(): JobQueueContextValue {
  const ctx = useContext(JobQueueContext);
  if (!ctx) {
    throw new Error("useJobQueue must be used within JobQueueProvider");
  }
  return ctx;
}

/** Optional access when a component may render outside the provider (tests). */
export function useJobQueueOptional(): JobQueueContextValue | null {
  return useContext(JobQueueContext);
}
