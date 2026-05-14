"use client";

import React, { forwardRef, useImperativeHandle, useMemo, useState } from "react";

export type SharedLogStreamHandle = {
  pushLine: (line: string) => void;
  clear: () => void;
};

export function replacePrefixToken(): string {
  return String.fromCharCode(127) + "LOG_R" + String.fromCharCode(127);
}

export const SharedLogStream = forwardRef<
  SharedLogStreamHandle,
  { rows?: number; minHeight?: number; prefix?: string }
>(function SharedLogStreamImpl(props, ref) {
  const { rows = 12, minHeight = 210, prefix } = props;
  const replacePrefix = useMemo(
    () => prefix ?? replacePrefixToken(),
    [prefix]
  );
  const [lines, setLines] = useState<string[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      pushLine: (line: string) => {
        const raw = (line || "").replace(/\r?\n/g, "");
        if (!raw) return;
        setLines((prev) => {
          if (raw.startsWith(replacePrefix)) {
            const payload = raw.slice(replacePrefix.length).trimEnd();
            if (prev.length === 0) return [payload];
            const next = prev.slice();
            next[next.length - 1] = payload;
            return next;
          }
          return [...prev, raw.trim()];
        });
      },
      clear: () => setLines([]),
    }),
    [replacePrefix]
  );

  return (
    <textarea
      value={lines.join("\n")}
      readOnly
      rows={rows}
      style={{
        width: "100%",
        background: "transparent",
        color: "inherit",
        border: "1px solid rgba(0,0,0,0.25)",
        borderRadius: 0,
        padding: 10,
        resize: "none",
        minHeight,
      }}
    />
  );
});

