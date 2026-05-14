"use client";

import React, { type RefObject } from "react";
import { JobRunModal } from "./JobRunModal";
import { SharedLogStream, type SharedLogStreamHandle } from "./SharedLogStream";
import type { JobRunModalSessionProps } from "../hooks/useJobRunSession";

export function ConnectedJobRunModal(props: {
  modal: JobRunModalSessionProps;
  logRef: RefObject<SharedLogStreamHandle | null>;
  children?: React.ReactNode;
}) {
  const { modal, logRef, children } = props;
  return (
    <JobRunModal {...modal}>
      {children ?? <SharedLogStream ref={logRef} rows={10} minHeight={200} />}
    </JobRunModal>
  );
}
