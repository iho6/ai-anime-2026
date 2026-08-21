"use client";

import React, { type RefObject } from "react";
import type { SharedLogStreamHandle } from "./SharedLogStream";
import type { JobRunModalSessionProps } from "../hooks/useJobRunSession";

/**
 * Formerly showed a blocking JobRunModal. Jobs now run via the global queue + Log panel.
 * Kept as a no-op so call sites can be removed gradually without breaking imports.
 */
export function ConnectedJobRunModal(_props: {
  modal: JobRunModalSessionProps;
  logRef: RefObject<SharedLogStreamHandle | null>;
  children?: React.ReactNode;
}) {
  return null;
}
